/**
 * IA en 7 Días - Almacenamiento persistente en la nube (Supabase + Vercel Blob + Local)
 *
 * Orden de prioridad automático:
 *   1. SUPABASE (si están definidas SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY,
 *      o si está definido POSTGRES_URL / SUPABASE_DB_URL / DATABASE_URL):
 *      - Crea y verifica automáticamente las tablas (`ia7d_state`, `ia7d_students`, `ia7d_uploads`)
 *        y el bucket privado `ia7d-uploads`.
 *      - Guarda alumnos, pagos, aprobaciones, progreso de lecciones y comprobantes/evidencias en Supabase.
 *   2. VERCEL BLOB (si está definido BLOB_READ_WRITE_TOKEN):
 *      - Respaldo automático en la nube de Vercel (con ETag normalizado sin prefijo débil `W/`).
 *   3. ARCHIVOS LOCALES (`./data/database.json`):
 *      - Respaldo automático en desarrollo local.
 */
const fs = require('fs');
const path = require('path');

function getSupabaseConfig() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '';
  const dbUrl =
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    '';
  return {
    url: url.trim(),
    key: key.trim(),
    dbUrl: dbUrl.trim(),
    hasRest: Boolean(url.trim() && key.trim()),
    hasPg: Boolean(dbUrl.trim()),
    enabled: Boolean((url.trim() && key.trim()) || dbUrl.trim())
  };
}

const SUPABASE_BUCKET = 'ia7d-uploads';
const DB_PATHNAME = 'db/database.json';

function isCloudConfigured() {
  const sb = getSupabaseConfig();
  return sb.enabled || Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function getActiveProvider() {
  const sb = getSupabaseConfig();
  if (sb.enabled) return 'supabase';
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'vercel-blob';
  return 'local';
}

// ==========================================
// 1. SUPABASE (PostgreSQL + Supabase REST / Storage)
// ==========================================
let supabaseClient = null;
let pgPool = null;
let schemaReady = false;
let bucketReady = false;

function getSupabase() {
  const cfg = getSupabaseConfig();
  if (!cfg.hasRest) return null;
  if (!supabaseClient) {
    const { createClient } = require('@supabase/supabase-js');
    supabaseClient = createClient(cfg.url, cfg.key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabaseClient;
}

function getPgPool() {
  const cfg = getSupabaseConfig();
  if (!cfg.hasPg) return null;
  if (!pgPool) {
    const { Pool } = require('pg');
    // Quitar sslmode de la URL para que pg respete ssl: { rejectUnauthorized: false } con el certificado de Supabase
    const cleanConnStr = cfg.dbUrl
      .replace(/([?&])sslmode=[^&]*(&?)/gi, (_, p1, p2) => (p2 ? p1 : ''))
      .replace(/[?&]$/, '');
    pgPool = new Pool({
      connectionString: cleanConnStr,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 8000
    });
  }
  return pgPool;
}

/** Crea/verifica las tablas en Supabase automáticamente si hay conexión Postgres directa. */
async function ensureSupabaseSchema() {
  if (schemaReady) return;
  const pool = getPgPool();
  if (pool) {
    const sqlPath = path.join(__dirname, 'supabase-schema.sql');
    const sql = fs.existsSync(sqlPath)
      ? fs.readFileSync(sqlPath, 'utf-8')
      : `
        CREATE TABLE IF NOT EXISTS public.ia7d_state (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS public.ia7d_students (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          doc_type TEXT,
          doc_number TEXT,
          whatsapp TEXT,
          payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
          access_code TEXT,
          progress_percentage INTEGER NOT NULL DEFAULT 0,
          completed_lessons JSONB NOT NULL DEFAULT '[]'::jsonb,
          certificate_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
          certificate_code TEXT,
          raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS public.ia7d_uploads (
          pathname TEXT PRIMARY KEY,
          mime TEXT NOT NULL DEFAULT 'image/jpeg',
          content_base64 TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `;
    await pool.query(sql);
    schemaReady = true;
    return;
  }
  schemaReady = true;
}

async function ensureSupabaseBucket() {
  if (bucketReady) return true;
  const sb = getSupabase();
  if (!sb) return false;
  try {
    const { data: buckets, error } = await sb.storage.listBuckets();
    if (!error && Array.isArray(buckets)) {
      if (!buckets.some(b => b.name === SUPABASE_BUCKET || b.id === SUPABASE_BUCKET)) {
        await sb.storage.createBucket(SUPABASE_BUCKET, { public: false });
      }
      bucketReady = true;
      return true;
    }
  } catch (e) {
    // Si es anon_key sin permiso de crear buckets, se usará la tabla ia7d_uploads
  }
  return false;
}

async function supabaseLoadDb() {
  await ensureSupabaseSchema();
  const pool = getPgPool();
  if (pool) {
    const { rows } = await pool.query('SELECT data, updated_at FROM public.ia7d_state WHERE id = $1 LIMIT 1', ['main']);
    if (!rows.length) return { data: null, etag: null };
    return { data: rows[0].data, etag: String(new Date(rows[0].updated_at).getTime()) };
  }

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('ia7d_state')
      .select('data, updated_at')
      .eq('id', 'main')
      .maybeSingle();

    if (error) {
      if (/relation .* does not exist|PGRST205|42P01/i.test(error.message || '') || error.code === '42P01' || error.code === 'PGRST205') {
        throw new Error(
          'Las tablas de Supabase aún no existen. Ejecuta el archivo supabase-schema.sql en el SQL Editor de tu proyecto Supabase (o agrega la variable POSTGRES_URL / SUPABASE_DB_URL en Vercel para que se creen solas).'
        );
      }
      throw new Error(`Error leyendo Supabase: ${error.message}`);
    }
    if (!data) return { data: null, etag: null };
    return { data: data.data, etag: String(new Date(data.updated_at).getTime()) };
  }
  return { data: null, etag: null };
}

async function supabaseSaveDb(data) {
  await ensureSupabaseSchema();
  const nowIso = new Date().toISOString();
  const students = Array.isArray(data.students) ? data.students : [];
  const pool = getPgPool();

  if (pool) {
    await pool.query(
      `INSERT INTO public.ia7d_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      ['main', JSON.stringify(data), nowIso]
    );
    // Sincronizar tabla estructurada de alumnos
    const ids = students.map(s => s.id);
    if (ids.length === 0) {
      await pool.query('DELETE FROM public.ia7d_students');
    } else {
      await pool.query('DELETE FROM public.ia7d_students WHERE NOT (id = ANY($1::text[]))', [ids]);
    }
    for (const s of students) {
      await pool.query(
        `INSERT INTO public.ia7d_students
          (id, name, email, doc_type, doc_number, whatsapp, payment_status, access_code,
           progress_percentage, completed_lessons, certificate_unlocked, certificate_code, raw_data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           doc_type = EXCLUDED.doc_type,
           doc_number = EXCLUDED.doc_number,
           whatsapp = EXCLUDED.whatsapp,
           payment_status = EXCLUDED.payment_status,
           access_code = EXCLUDED.access_code,
           progress_percentage = EXCLUDED.progress_percentage,
           completed_lessons = EXCLUDED.completed_lessons,
           certificate_unlocked = EXCLUDED.certificate_unlocked,
           certificate_code = EXCLUDED.certificate_code,
           raw_data = EXCLUDED.raw_data,
           updated_at = EXCLUDED.updated_at`,
        [
          s.id,
          s.name || '',
          s.email || '',
          s.docType || null,
          s.docNumber || null,
          s.whatsapp || null,
          s.paymentStatus || 'awaiting_payment',
          s.accessCode || null,
          Number(s.progressPercentage) || 0,
          JSON.stringify(s.completedLessons || []),
          Boolean(s.certificateUnlocked),
          s.certificateCode || null,
          JSON.stringify(s),
          s.createdAt || nowIso,
          nowIso
        ]
      );
    }
    return { ok: true, etag: String(Date.now()) };
  }

  const sb = getSupabase();
  if (sb) {
    const { error } = await sb
      .from('ia7d_state')
      .upsert({ id: 'main', data, updated_at: nowIso }, { onConflict: 'id' });
    if (error) {
      throw new Error(`Error guardando en Supabase: ${error.message}`);
    }
    // Sincronizar también la tabla estructurada ia7d_students (sin bloquear si no existe)
    try {
      const rows = students.map(s => ({
        id: s.id,
        name: s.name || '',
        email: s.email || '',
        doc_type: s.docType || null,
        doc_number: s.docNumber || null,
        whatsapp: s.whatsapp || null,
        payment_status: s.paymentStatus || 'awaiting_payment',
        access_code: s.accessCode || null,
        progress_percentage: Number(s.progressPercentage) || 0,
        completed_lessons: s.completedLessons || [],
        certificate_unlocked: Boolean(s.certificateUnlocked),
        certificate_code: s.certificateCode || null,
        raw_data: s,
        created_at: s.createdAt || nowIso,
        updated_at: nowIso
      }));
      if (rows.length) {
        await sb.from('ia7d_students').upsert(rows, { onConflict: 'id' });
      }
    } catch (e) {}
    return { ok: true, etag: String(Date.now()) };
  }

  throw new Error('Supabase no está configurado.');
}

async function supabasePutImage(pathname, buffer, mime) {
  await ensureSupabaseSchema();
  const sb = getSupabase();
  let savedAny = false;

  // 1) Intentar guardar en Supabase Storage Bucket
  if (sb && (await ensureSupabaseBucket())) {
    try {
      const { error } = await sb.storage
        .from(SUPABASE_BUCKET)
        .upload(pathname, buffer, { contentType: mime, upsert: true });
      if (!error) savedAny = true;
    } catch (e) {
      console.warn('[storage] Error subiendo a bucket Supabase:', e.message);
    }
  }

  // 2) Guardar también en la tabla public.ia7d_uploads como respaldo directo en PostgreSQL
  const b64 = buffer.toString('base64');
  const pool = getPgPool();
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO public.ia7d_uploads (pathname, mime, content_base64)
         VALUES ($1, $2, $3)
         ON CONFLICT (pathname) DO UPDATE SET mime = EXCLUDED.mime, content_base64 = EXCLUDED.content_base64`,
        [pathname, mime, b64]
      );
      savedAny = true;
    } catch (e) {
      console.warn('[storage] Error guardando imagen en ia7d_uploads (pg):', e.message);
    }
  } else if (sb) {
    const { error } = await sb
      .from('ia7d_uploads')
      .upsert({ pathname, mime, content_base64: b64 }, { onConflict: 'pathname' });
    if (!error) {
      savedAny = true;
    } else if (!savedAny) {
      throw new Error(`Error subiendo imagen a Supabase: ${error.message}`);
    }
  }

  if (savedAny) return pathname;
  throw new Error('No se pudo guardar la imagen en Supabase.');
}

async function supabaseGetImage(pathname) {
  await ensureSupabaseSchema();
  const cleanPath = String(pathname || '').replace(/^blob:/, '').trim();
  if (!cleanPath) return null;

  const candidatePaths = Array.from(new Set([
    cleanPath,
    cleanPath.startsWith('uploads/') ? cleanPath.slice(8) : `uploads/${cleanPath}`
  ]));

  // 1) Buscar primero en la tabla public.ia7d_uploads (PostgreSQL directo o REST)
  const pool = getPgPool();
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT mime, content_base64 FROM public.ia7d_uploads WHERE pathname = ANY($1::text[]) LIMIT 1',
        [candidatePaths]
      );
      if (rows.length && rows[0].content_base64) {
        return { buffer: Buffer.from(rows[0].content_base64, 'base64'), mime: rows[0].mime || 'image/jpeg' };
      }
    } catch (e) {
      console.warn('[storage] Error consultando ia7d_uploads (pg):', e.message);
    }
  }

  const sb = getSupabase();
  if (sb) {
    try {
      for (const p of candidatePaths) {
        const { data } = await sb
          .from('ia7d_uploads')
          .select('mime, content_base64')
          .eq('pathname', p)
          .maybeSingle();
        if (data && data.content_base64) {
          return { buffer: Buffer.from(data.content_base64, 'base64'), mime: data.mime || 'image/jpeg' };
        }
      }
    } catch (e) {}

    // 2) Buscar en Supabase Storage Bucket (sin depender de bucketReady en frío)
    for (const p of candidatePaths) {
      try {
        const { data, error } = await sb.storage.from(SUPABASE_BUCKET).download(p);
        if (!error && data) {
          const ab = await data.arrayBuffer();
          return { buffer: Buffer.from(ab), mime: data.type || 'image/jpeg' };
        }
      } catch (e) {}
    }
  }

  return null;
}

// ==========================================
// 2. VERCEL BLOB (Respaldo automático en la nube)
// ==========================================
let blobSdk = null;
function sdk() {
  if (!blobSdk) blobSdk = require('@vercel/blob');
  return blobSdk;
}

function normalizeEtag(etag) {
  if (!etag || typeof etag !== 'string') return null;
  return etag.replace(/^W\//i, '').trim() || null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

let cached = { etag: null, rawEtag: null, text: null };

async function blobLoadDb() {
  const { get } = sdk();
  const opts = { access: 'private', useCache: false };
  if (cached.rawEtag) opts.ifNoneMatch = cached.rawEtag;
  const res = await get(DB_PATHNAME, opts);
  if (!res) {
    cached = { etag: null, rawEtag: null, text: null };
    return { data: null, etag: null };
  }
  if (res.statusCode === 304 && cached.text) {
    return { data: JSON.parse(cached.text), etag: cached.etag };
  }
  const text = (await streamToBuffer(res.stream)).toString('utf-8');
  const rawEtag = res.blob && res.blob.etag;
  const etag = normalizeEtag(rawEtag);
  cached = { etag, rawEtag, text };
  return { data: JSON.parse(text), etag };
}

async function blobSaveDb(data, etag, forceOverwrite = false) {
  const { put, BlobPreconditionFailedError } = sdk();
  const text = JSON.stringify(data);
  const cleanEtag = normalizeEtag(etag);
  const opts = {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60
  };
  if (cleanEtag && !forceOverwrite) {
    opts.ifMatch = cleanEtag;
  }
  try {
    const result = await put(DB_PATHNAME, text, opts);
    const newEtag = normalizeEtag(result && result.etag);
    cached = { etag: newEtag, rawEtag: (result && result.etag) || newEtag, text: newEtag ? text : null };
    return { ok: true, etag: newEtag };
  } catch (err) {
    const msg = String((err && err.message) || '');
    if ((BlobPreconditionFailedError && err instanceof BlobPreconditionFailedError) ||
        /precondition|already exists|etag/i.test(msg)) {
      cached = { etag: null, rawEtag: null, text: null };
      return { ok: false, conflict: true, reason: msg };
    }
    throw err;
  }
}

async function blobPutImage(pathname, buffer, mime) {
  const { put } = sdk();
  const result = await put(pathname, buffer, {
    access: 'private',
    contentType: mime,
    addRandomSuffix: true
  });
  return result.pathname;
}

async function blobGetImage(pathname) {
  const { get } = sdk();
  const res = await get(pathname, { access: 'private' });
  if (!res || res.statusCode !== 200) return null;
  return { buffer: await streamToBuffer(res.stream), mime: res.blob.contentType || 'image/jpeg' };
}

// ==========================================
// FACHADA UNIFICADA (Supabase -> Blob)
// ==========================================
async function loadRemoteDb() {
  if (getSupabaseConfig().enabled) {
    const sbRes = await supabaseLoadDb();
    // Si Supabase está recién creado (vacío) y existe respaldo en Vercel Blob, migrar automáticamente los datos existentes
    if (!sbRes.data && process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const blobRes = await blobLoadDb();
        if (blobRes && blobRes.data) {
          await supabaseSaveDb(blobRes.data);
          return { data: blobRes.data, etag: String(Date.now()) };
        }
      } catch (e) {}
    }
    return sbRes;
  }
  return blobLoadDb();
}

async function saveRemoteDb(data, etag, forceOverwrite = false) {
  if (getSupabaseConfig().enabled) {
    return supabaseSaveDb(data);
  }
  return blobSaveDb(data, etag, forceOverwrite);
}

async function putImage(pathname, buffer, mime) {
  if (getSupabaseConfig().enabled) {
    return supabasePutImage(pathname, buffer, mime);
  }
  return blobPutImage(pathname, buffer, mime);
}

async function getImage(pathname) {
  if (getSupabaseConfig().enabled) {
    const img = await supabaseGetImage(pathname);
    if (img) return img;
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try { return await blobGetImage(pathname); } catch (e) {}
    }
    return null;
  }
  return blobGetImage(pathname);
}

module.exports = {
  get USE_BLOB() {
    return isCloudConfigured();
  },
  getActiveProvider,
  getSupabaseConfig,
  loadRemoteDb,
  saveRemoteDb,
  putImage,
  getImage
};
