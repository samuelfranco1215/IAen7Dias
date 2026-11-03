/**
 * IA en 7 Días - Capa de datos (JSON en disco)
 *
 * Estados de inscripción (paymentStatus):
 *   awaiting_payment -> se registró, aún no sube comprobante
 *   in_review        -> subió comprobante Nequi, espera aprobación manual
 *   approved         -> el admin aprobó el pago: acceso a lecciones
 *   rejected         -> el admin rechazó el comprobante (puede subir otro)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const isCloud = () => storage.USE_BLOB;
const BUNDLED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = BUNDLED_DATA_DIR;

const DB_PATH = path.join(DATA_DIR, 'database.json');
const LESSONS_PATH = path.join(BUNDLED_DATA_DIR, 'lessons.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const TOTAL_LESSONS = 7;
const SCHEMA_VERSION = 2;
const MAX_TOKENS_PER_STUDENT = 5;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function initStorage() {
  if (isCloud()) return; // En la nube (Supabase / Vercel Blob) el disco es efímero
  try {
    for (const dir of [DATA_DIR, UPLOADS_DIR, path.join(UPLOADS_DIR, 'receipts'), path.join(UPLOADS_DIR, 'evidence')]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error('[db] Error inicializando directorios de datos:', err);
  }
}
initStorage();

const defaultDatabase = {
  settings: {
    schemaVersion: SCHEMA_VERSION,
    courseName: 'IA en 7 Días',
    coursePriceCOP: 24900,
    nequiNumber: '3158422894',
    supportWhatsApp: '3158422894',
    adminPasswordHash: null,
    adminPasswordSalt: null
  },
  students: [],
  lessonOverrides: {}
};

let dbCache = null;

// Estado de la petición actual (solo modo Blob)
let remoteEtag = null;      // ETag de la versión cargada
let baseSnapshot = null;    // copia de la versión cargada (para fusionar en caso de conflicto)
let dirty = false;          // hubo cambios en esta petición
let pendingUploads = [];    // imágenes por subir antes de guardar la base

const clone = (v) => JSON.parse(JSON.stringify(v));

// ==========================================
// LECTURA / ESCRITURA
// ==========================================
function readDb() {
  if (dbCache) return dbCache;
  if (isCloud()) {
    throw new Error('Base de datos no cargada (falta db.begin()).');
  }
  try {
    if (!fs.existsSync(DB_PATH)) {
      dbCache = clone(defaultDatabase);
      try {
        writeDb(dbCache);
      } catch (e) {
        // Ignorar si no se puede escribir
      }
    } else {
      dbCache = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('Error leyendo la base de datos:', err);
    throw err; // No sobrescribir datos si el archivo está corrupto
  }
  migrate(dbCache);
  return dbCache;
}

function writeDb(data) {
  dbCache = data;
  if (isCloud()) {
    dirty = true; // se persiste en commit()
    return;
  }
  try {
    const tmp = `${DB_PATH}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, DB_PATH);
  } catch (err) {
    console.warn('[db] No se pudo persistir en disco:', err.message);
  }
}

/** Carga la versión más reciente de la base (al inicio de cada petición en modo nube). */
async function begin() {
  dirty = false;
  pendingUploads = [];
  if (!isCloud()) {
    readDb();
    return;
  }
  const { data, etag } = await storage.loadRemoteDb();
  dbCache = data || clone(defaultDatabase);
  dbCache.students = dbCache.students || [];
  dbCache.lessonOverrides = dbCache.lessonOverrides || {};
  remoteEtag = etag;
  baseSnapshot = clone(dbCache);
  const wasDirty = dirty;
  migrate(dbCache);
  dirty = wasDirty || dirty;
}

/** Fusión a 3 vías por alumno / clave para no perder cambios concurrentes. */
function merge3(base, mine, theirs) {
  const result = clone(theirs);
  for (const field of ['settings', 'lessonOverrides']) {
    const b = base[field] || {};
    const m = mine[field] || {};
    result[field] = result[field] || {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(m)])) {
      if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) {
        if (m[k] === undefined) delete result[field][k];
        else result[field][k] = m[k];
      }
    }
  }
  const byId = (list) => new Map((list || []).map(s => [s.id, s]));
  const bMap = byId(base.students);
  const mMap = byId(mine.students);
  let list = (result.students || []).slice();
  for (const id of new Set([...bMap.keys(), ...mMap.keys()])) {
    const b = bMap.get(id);
    const m = mMap.get(id);
    if (JSON.stringify(b) === JSON.stringify(m)) continue;
    if (!m) {
      list = list.filter(s => s.id !== id);
    } else {
      const idx = list.findIndex(s => s.id === id);
      if (idx >= 0) list[idx] = m;
      else list.unshift(m);
    }
  }
  result.students = list;
  return result;
}

/** Persiste los cambios de la petición actual (modo nube: Supabase o Vercel Blob). */
async function commit() {
  if (!isCloud() || !dirty) return;

  // 1) Subir imágenes pendientes y reemplazar sus referencias temporales
  for (const up of pendingUploads) {
    try {
      const pathname = await storage.putImage(up.pathname, up.buffer, up.mime);
      const finalRef = `blob:${pathname}`;
      replaceRef(dbCache, up.tempRef, finalRef);
    } catch (e) {
      console.warn('[db] Guardando imagen directamente en estado de Supabase como respaldo:', e.message);
      const inlineDataUrl = `data:${up.mime};base64,${up.buffer.toString('base64')}`;
      replaceRef(dbCache, up.tempRef, inlineDataUrl);
    }
  }
  pendingUploads = [];

  // 2) Guardar la base con control de concurrencia (y escritura directa como último recurso)
  let mine = dbCache;
  let base = baseSnapshot;
  let etag = remoteEtag;
  for (let attempt = 0; attempt < 4; attempt++) {
    const force = attempt === 3;
    const res = await storage.saveRemoteDb(mine, etag, force);
    if (res.ok) {
      dbCache = mine;
      remoteEtag = res.etag;
      baseSnapshot = clone(mine);
      dirty = false;
      return;
    }
    // Conflicto: otra petición guardó primero -> fusionar y reintentar
    const latest = await storage.loadRemoteDb();
    const theirs = latest.data || clone(defaultDatabase);
    mine = merge3(base, mine, theirs);
    base = clone(theirs);
    etag = latest.etag;
    await new Promise(r => setTimeout(r, 40 + Math.random() * 100));
  }
  throw new Error('No se pudo sincronizar la base de datos en Vercel Blob.');
}

function replaceRef(obj, from, to) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (obj[k] === from) obj[k] = to;
    else if (typeof obj[k] === 'object') replaceRef(obj[k], from, to);
  }
}

/**
 * Migra datos de la versión anterior (ePayco / modo demo).
 * Las aprobaciones anteriores se hicieron sin verificación real de pago
 * (simulación o llave demo de ePayco), así que se anulan: el admin debe
 * aprobarlas de nuevo. No se borra ningún alumno ni su progreso.
 */
function migrate(db) {
  db.settings = db.settings || {};
  if ((db.settings.schemaVersion || 1) >= SCHEMA_VERSION) return;

  if (fs.existsSync(DB_PATH)) {
    try {
      const backup = path.join(DATA_DIR, `database.backup-v1-${Date.now()}.json`);
      fs.copyFileSync(DB_PATH, backup);
      console.log(`[migración] Copia de seguridad creada: ${path.basename(backup)}`);
    } catch (e) { }
  }

  for (const s of db.students || []) {
    if (s.paymentStatus === 'approved') {
      s.legacyNote = `Aprobación anterior (${s.paymentMethod || 'desconocido'}) anulada: no hubo verificación real de pago.`;
    }
    s.paymentStatus = 'awaiting_payment';
    s.paymentMethod = 'nequi';
    s.tokens = [];
    s.accessCode = null;
    s.receipt = null;
    s.completedLessons = s.completedLessons || [];
    s.evidence = s.evidence || {};
    s.certificateUnlocked = s.completedLessons.length >= TOTAL_LESSONS;
    delete s.epaycoRef;
  }

  const keep = ['courseName', 'coursePriceCOP', 'adminPasswordHash', 'adminPasswordSalt'];
  const old = db.settings;
  db.settings = { ...defaultDatabase.settings };
  for (const k of keep) if (old[k] !== undefined) db.settings[k] = old[k];
  db.settings.schemaVersion = SCHEMA_VERSION;

  writeDb(db);
  console.log('[migración] Base de datos actualizada a flujo Nequi + aprobación manual.');
}

// ==========================================
// UTILIDADES
// ==========================================
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function generateAccessCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function generateCertificateCode(name) {
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  const initials = (name || 'IA')
    .split(' ').filter(Boolean).map(p => p[0].toUpperCase()).slice(0, 3).join('')
    .normalize('NFD').replace(/[^A-Z]/g, '');
  return `IA7D-${new Date().getFullYear()}-${initials}${random}`;
}

/** Guarda una imagen en base64 (data URL) en disco o la encola para Blob validando tipo y tamaño. */
function saveImage(dataUrl, subdir, baseName) {
  const match = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Formato de imagen no válido. Usa JPG, PNG o WebP.');
  const buffer = Buffer.from(match[3], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('La imagen es demasiado pesada (máximo 6 MB).');

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  const isWebp = buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) throw new Error('El archivo no es una imagen válida.');

  const ext = isPng ? 'png' : isWebp ? 'webp' : 'jpg';
  const mime = isPng ? 'image/png' : isWebp ? 'image/webp' : 'image/jpeg';
  const fileName = `${baseName}-${Date.now()}.${ext}`;

  if (isCloud()) {
    const tempRef = `pending:${subdir}/${fileName}`;
    pendingUploads.push({
      tempRef,
      pathname: `uploads/${subdir}/${fileName}`,
      buffer,
      mime
    });
    return tempRef;
  }

  fs.writeFileSync(path.join(UPLOADS_DIR, subdir, fileName), buffer);
  return `${subdir}/${fileName}`;
}

/** Devuelve { buffer, mime } de una imagen guardada (objeto receipt/evidence, data URL, Supabase/Blob o archivo local). */
async function readImage(ref) {
  if (!ref) return null;

  // Si se pasa el objeto completo s.receipt o s.evidence[n]
  if (typeof ref === 'object') {
    if (typeof ref.dataUrl === 'string' && ref.dataUrl.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(ref.dataUrl);
      if (m) return { buffer: Buffer.from(m[2], 'base64'), mime: m[1] };
    }
    const candidateRef = ref.file || ref.image || ref.dataUrl;
    if (!candidateRef || typeof candidateRef !== 'string') return null;
    return readImage(candidateRef);
  }

  if (typeof ref !== 'string') return null;

  if (ref.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(ref);
    return m ? { buffer: Buffer.from(m[2], 'base64'), mime: m[1] } : null;
  }

  if (ref.startsWith('blob:') || ref.startsWith('pending:') || isCloud()) {
    const cleanRef = ref.replace(/^(blob:|pending:)/, '');
    if (isCloud()) {
      try {
        const cloudImg = await storage.getImage(cleanRef);
        if (cloudImg) return cloudImg;
      } catch (e) {
        console.error('[db] Error leyendo imagen desde almacenamiento en la nube:', e);
      }
    }
    if (ref.startsWith('blob:') || ref.startsWith('pending:')) {
      ref = cleanRef.replace(/^uploads\//, '');
    }
  }

  let full = path.isAbsolute(ref) ? path.normalize(ref) : path.normalize(path.join(UPLOADS_DIR, ref));
  if (!fs.existsSync(full)) {
    const fallback = path.join(BUNDLED_DATA_DIR, 'uploads', ref);
    if (fs.existsSync(fallback)) {
      full = fallback;
    } else {
      return null;
    }
  }
  const ext = path.extname(full).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return { buffer: fs.readFileSync(full), mime };
}


// ==========================================
// LECCIONES
// ==========================================
function getLessons() {
  try {
    let list = [];
    if (fs.existsSync(LESSONS_PATH)) {
      list = JSON.parse(fs.readFileSync(LESSONS_PATH, 'utf-8'));
    } else {
      const bundled = path.join(BUNDLED_DATA_DIR, 'lessons.json');
      if (fs.existsSync(bundled)) {
        list = JSON.parse(fs.readFileSync(bundled, 'utf-8'));
      }
    }
    const db = dbCache || (!isCloud() ? readDb() : null);
    const overrides = (db && db.lessonOverrides) || {};
    return list.map(l => overrides[l.id] ? { ...l, ...overrides[l.id] } : l);
  } catch (err) {
    console.error('Error leyendo lecciones:', err);
    return [];
  }
}

function getLessonById(id) {
  return getLessons().find(l => Number(l.id) === Number(id)) || null;
}

function updateLesson(id, fields) {
  const lessons = getLessons();
  const idx = lessons.findIndex(l => Number(l.id) === Number(id));
  if (idx === -1) return null;
  lessons[idx] = { ...lessons[idx], ...fields };

  if (isCloud()) {
    const db = readDb();
    db.lessonOverrides = db.lessonOverrides || {};
    db.lessonOverrides[id] = { ...(db.lessonOverrides[id] || {}), ...fields };
    writeDb(db);
    return lessons[idx];
  }

  try {
    fs.writeFileSync(LESSONS_PATH, JSON.stringify(lessons, null, 2), 'utf-8');
  } catch (e) {
    console.warn('[db] No se pudo guardar cambios en lecciones en disco:', e.message);
  }
  return lessons[idx];
}

// ==========================================
// ALUMNOS
// ==========================================
function getStudents() {
  return readDb().students || [];
}

function getStudentById(id) {
  return getStudents().find(s => s.id === id) || null;
}

function getStudentByEmail(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return getStudents().find(s => (s.email || '').trim().toLowerCase() === normalized) || null;
}

function getStudentByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const hash = sha256(token);
  return getStudents().find(s => Array.isArray(s.tokens) && s.tokens.includes(hash)) || null;
}

/** Emite un nuevo token de sesión para el alumno (se guarda solo el hash). */
function issueToken(studentId) {
  const db = readDb();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return null;
  const token = randomToken();
  s.tokens = [...(s.tokens || []), sha256(token)].slice(-MAX_TOKENS_PER_STUDENT);
  writeDb(db);
  return token;
}

function revokeToken(token) {
  const db = readDb();
  const hash = sha256(token);
  for (const s of db.students) {
    if (s.tokens && s.tokens.includes(hash)) {
      s.tokens = s.tokens.filter(t => t !== hash);
      writeDb(db);
      return true;
    }
  }
  return false;
}

function createStudent({ name, email, docType, docNumber, whatsapp, surveyAnswers, consent }) {
  const db = readDb();
  const id = 'std_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const student = {
    id,
    name,
    email: email.toLowerCase(),
    docType,
    docNumber,
    whatsapp,
    createdAt: new Date().toISOString(),
    paymentStatus: 'awaiting_payment',
    paymentMethod: 'nequi',
    amount: db.settings.coursePriceCOP || 24900,
    currency: 'COP',
    receipt: null,
    receiptHistory: [],
    rejectionReason: null,
    approvedAt: null,
    accessCode: null,
    tokens: [],
    progressPercentage: 0,
    completedLessons: [],
    quizScores: {},
    evidence: {},
    surveyAnswers: surveyAnswers || null,
    consent,
    certificateUnlocked: false,
    certificateCode: null,
    certificateIssuedAt: null
  };
  db.students.unshift(student);
  writeDb(db);
  return student;
}

function updateStudent(id, fields) {
  const db = readDb();
  const idx = db.students.findIndex(s => s.id === id);
  if (idx === -1) return null;
  db.students[idx] = { ...db.students[idx], ...fields };
  writeDb(db);
  return db.students[idx];
}

function saveReceipt(studentId, { image, reference }) {
  const db = readDb();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return { error: 'Alumno no encontrado' };
  if (s.paymentStatus === 'approved') return { error: 'Tu pago ya fue aprobado.' };

  const file = saveImage(image, 'receipts', s.id);
  if (s.receipt) s.receiptHistory = [...(s.receiptHistory || []), s.receipt];
  s.receipt = {
    file,
    dataUrl: image,
    reference: reference || '',
    uploadedAt: new Date().toISOString()
  };
  s.paymentStatus = 'in_review';
  s.rejectionReason = null;
  writeDb(db);
  return { student: s };
}

/** Aprueba el pago UNA sola vez y genera el código de acceso. */
function approveStudent(studentId) {
  const db = readDb();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return { error: 'Alumno no encontrado' };
  if (s.paymentStatus === 'approved') return { error: 'Este alumno ya fue aprobado.', student: s };
  if (!s.receipt) return { error: 'El alumno aún no ha subido el comprobante de pago.' };

  s.paymentStatus = 'approved';
  s.approvedAt = new Date().toISOString();
  s.accessCode = generateAccessCode();
  s.rejectionReason = null;
  writeDb(db);
  return { student: s };
}

function rejectStudent(studentId, reason) {
  const db = readDb();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return { error: 'Alumno no encontrado' };
  if (s.paymentStatus === 'approved') return { error: 'No se puede rechazar un pago ya aprobado. Usa "Revocar acceso".' };
  s.paymentStatus = 'rejected';
  s.rejectionReason = reason || 'No pudimos verificar el comprobante.';
  writeDb(db);
  return { student: s };
}

function revokeStudent(studentId, reason) {
  const db = readDb();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return { error: 'Alumno no encontrado' };
  s.paymentStatus = 'rejected';
  s.rejectionReason = reason || 'Acceso revocado por el administrador.';
  s.accessCode = null;
  s.tokens = [];
  s.approvedAt = null;
  writeDb(db);
  return { student: s };
}

/**
 * Ingreso de alumno aprobado con código de acceso (y correo opcional).
 * Devuelve { student } si es válido, o { error, status, paymentStatus } si no lo es.
 */
function authenticateStudentWithCode(email, code) {
  const cleanCode = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (!cleanCode) {
    if (cleanEmail) {
      const byEmailOnly = getStudentByEmail(cleanEmail);
      if (byEmailOnly && byEmailOnly.paymentStatus === 'in_review') {
        return {
          error: 'Tu suscripción está esperando ser aprobada por el administrador. Cuando se valide tu pago recibirás tu código de acceso.',
          status: 403,
          paymentStatus: 'in_review'
        };
      }
    }
    return { error: 'Por favor escribe tu código de acceso de 8 caracteres (ej. ABCD-1234).', status: 400 };
  }

  const students = getStudents();

  // 1) Buscar alumno con pago aprobado cuyo código único coincida
  const matchedByCode = students.find(s => {
    if (s.paymentStatus !== 'approved' || !s.accessCode) return false;
    const expected = String(s.accessCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return expected.length > 0 && safeEqual(cleanCode, expected);
  });

  if (matchedByCode) {
    return { student: matchedByCode };
  }

  // 2) Si el código no coincide con ningún alumno aprobado, revisar si el correo está en revisión o pendiente
  if (cleanEmail) {
    const byEmail = getStudentByEmail(cleanEmail);
    if (byEmail) {
      if (byEmail.paymentStatus === 'in_review') {
        return {
          error: 'Tu suscripción aún está en revisión por el administrador. Apenas sea aprobada recibirás un código de acceso válido.',
          status: 403,
          paymentStatus: 'in_review'
        };
      }
      if (byEmail.paymentStatus === 'awaiting_payment') {
        return {
          error: 'Tu inscripción está registrada, pero aún falta subir el comprobante de pago Nequi para que el administrador la apruebe.',
          status: 403,
          paymentStatus: 'awaiting_payment'
        };
      }
      if (byEmail.paymentStatus === 'rejected') {
        return {
          error: 'Tu comprobante anterior fue rechazado. Por favor sube un comprobante válido para recibir tu código de acceso.',
          status: 403,
          paymentStatus: 'rejected'
        };
      }
      if (byEmail.paymentStatus === 'approved') {
        return {
          error: 'El código ingresado es incorrecto. Verifica los 8 caracteres exactos del código que recibiste por WhatsApp.',
          status: 401
        };
      }
    }
  }

  return {
    error: 'Código de acceso inválido o aún no aprobado. Verifica los caracteres (ej. ABCD-1234) o espera la aprobación del administrador.',
    status: 401
  };
}

/** Ingreso de alumno aprobado con correo + código de acceso. */
function loginWithAccessCode(email, code) {
  const res = authenticateStudentWithCode(email, code);
  return res.student || null;
}

function completeLesson(studentId, lessonId, { image, quizScore, answers }) {
  const db = readDb();
  const s = db.students.find(x => x.id === studentId);
  if (!s) return { error: 'Alumno no encontrado' };
  if (s.paymentStatus !== 'approved') return { error: 'Tu acceso aún no ha sido aprobado.' };

  const n = Number(lessonId);
  if (!Number.isInteger(n) || n < 1 || n > TOTAL_LESSONS) return { error: 'Lección no válida' };
  s.completedLessons = s.completedLessons || [];
  if (n > 1 && !s.completedLessons.includes(n - 1)) {
    return { error: `Primero debes aprobar y completar el Día ${n - 1}.` };
  }

  // 1) Validar que el alumno haya respondido correctamente el quiz de la lección
  const lesson = (db.lessons || []).find(l => Number(l.id) === n);
  if (lesson && Array.isArray(lesson.quiz) && lesson.quiz.length > 0) {
    if (!answers || typeof answers !== 'object') {
      return {
        error: 'No aprobaste esta lección. Vuelve a intentarlo para continuar.',
        failedEvaluation: true
      };
    }
    for (let qIdx = 0; qIdx < lesson.quiz.length; qIdx++) {
      const q = lesson.quiz[qIdx];
      const submitted = answers[qIdx];
      if (submitted === undefined || submitted === null || Number(submitted) !== Number(q.correctIndex)) {
        return {
          error: 'No aprobaste esta lección. Vuelve a intentarlo para continuar.',
          failedEvaluation: true
        };
      }
    }
  }

  if (quizScore !== undefined && Number(quizScore) < 100) {
    return {
      error: 'No aprobaste esta lección. Vuelve a intentarlo para continuar.',
      failedEvaluation: true
    };
  }

  // 2) Validar que haya subido la evidencia práctica requerida
  s.evidence = s.evidence || {};
  if (image) {
    s.evidence[n] = { image: saveImage(image, 'evidence', `${s.id}-d${n}`), dataUrl: image, submittedAt: new Date().toISOString() };
  }
  if (!s.evidence[n] || !s.evidence[n].image) {
    return {
      error: 'No aprobaste esta lección. Vuelve a intentarlo para continuar. (Falta subir la captura de tu práctica con IA).',
      failedEvaluation: true
    };
  }

  if (!s.completedLessons.includes(n)) s.completedLessons.push(n);
  s.completedLessons.sort((a, b) => a - b);
  s.quizScores = s.quizScores || {};
  s.quizScores[n] = 100;
  s.progressPercentage = Math.round((s.completedLessons.length / TOTAL_LESSONS) * 100);

  // Certificado: SOLO con las 7 lecciones completadas en orden, evidencias subidas y evaluaciones aprobadas al 100%
  const allApproved = Array.from({ length: TOTAL_LESSONS }, (_, i) => i + 1).every(d => {
    const hasLessonDone = s.completedLessons.includes(d);
    const hasEv = !!(s.evidence && s.evidence[d] && s.evidence[d].image);
    const score = Number((s.quizScores || {})[d] || 0);
    return hasLessonDone && hasEv && score >= 80;
  });

  if (allApproved) {
    s.certificateUnlocked = true;
    if (!s.certificateCode) {
      s.certificateCode = generateCertificateCode(s.name);
      s.certificateIssuedAt = new Date().toISOString();
    }
  } else {
    s.certificateUnlocked = false;
  }

  writeDb(db);
  return { student: s };
}

function isCertificateEligible(s) {
  if (!s || s.paymentStatus !== 'approved') return false;
  const done = s.completedLessons || [];
  const scores = s.quizScores || {};
  const evidence = s.evidence || {};
  for (let d = 1; d <= TOTAL_LESSONS; d++) {
    if (!done.includes(d)) return false;
    if (!evidence[d] || !evidence[d].image) return false;
    if (scores[d] !== undefined && Number(scores[d]) < 80) return false;
  }
  return !!s.certificateCode;
}

function getStudentByCertificateCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return getStudents().find(s => s.certificateCode && s.certificateCode.toUpperCase() === c) || null;
}

function deleteStudent(id) {
  const db = readDb();
  const prev = db.students.length;
  db.students = db.students.filter(s => s.id !== id);
  writeDb(db);
  return db.students.length < prev;
}

function getSettings() {
  return readDb().settings;
}

function updateSettings(fields) {
  const db = readDb();
  db.settings = { ...db.settings, ...fields };
  writeDb(db);
  return db.settings;
}

module.exports = {
  TOTAL_LESSONS,
  get USE_BLOB() {
    return isCloud();
  },
  getStorageProvider: storage.getActiveProvider,
  getSupabaseConfig: storage.getSupabaseConfig,
  begin,
  commit,
  getLessons,
  getLessonById,
  updateLesson,
  getStudents,
  getStudentById,
  getStudentByEmail,
  getStudentByToken,
  issueToken,
  revokeToken,
  createStudent,
  updateStudent,
  saveReceipt,
  approveStudent,
  rejectStudent,
  revokeStudent,
  loginWithAccessCode,
  authenticateStudentWithCode,
  completeLesson,
  isCertificateEligible,
  getStudentByCertificateCode,
  deleteStudent,
  readImage,
  getSettings,
  updateSettings,
  sha256,
  safeEqual,
  DATA_DIR,
  BUNDLED_DATA_DIR
};
