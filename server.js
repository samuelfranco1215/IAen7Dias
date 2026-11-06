/**
 * IA en 7 Días - Servidor
 *
 * Flujo de acceso:
 *   1. Registro (datos + Habeas Data)  -> estado "awaiting_payment" + token de sesión
 *   2. Pago por Nequi + comprobante    -> estado "in_review"
 *   3. Admin aprueba (una sola vez)    -> estado "approved" + código de acceso
 *   Solo "approved" puede leer lecciones, subir prácticas y descargar certificado.
 *
 * No hay pasarela ni webhooks: el pago es Nequi con verificación manual.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Ruta privada del panel admin (no se enlaza desde ninguna página pública)
const ADMIN_PATH = '/' + String(process.env.ADMIN_PATH || 'gestion-ia7d-privado').replace(/^\/+|\/+$/g, '');
const PRIVATE_DIR = path.join(__dirname, 'private');

const CONSENT_VERSION = '2026-10';
const CONSENT_TEXT = 'Autorizo el tratamiento de mis datos personales para gestionar mi inscripción, acceso al curso, soporte y emisión del certificado digital, conforme a la Ley 1581 de 2012 y la Política de Tratamiento de Datos de IA en 7 Días.';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// Cabeceras de seguridad básicas y sincronización de base de datos
app.use(async (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
    if (process.env.VERCEL && !db.USE_BLOB) {
      return res.status(500).json({
        error: 'Falta configurar el almacenamiento en la nube en Vercel. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (o POSTGRES_URL / BLOB_READ_WRITE_TOKEN) en las variables de entorno del proyecto.'
      });
    }
    try {
      await db.begin();
      ensureAdminPassword();
    } catch (err) {
      console.error('[server] Error cargando la base de datos:', err);
      const detail = err && err.message ? ` (${err.message})` : '';
      return res.status(500).json({ error: `Error conectando con el almacenamiento de datos${detail}.` });
    }
    const origJson = res.json.bind(res);
    res.json = function(body) {
      db.commit().then(() => {
        origJson(body);
      }).catch(err => {
        console.error('[server] Error guardando la base de datos:', err);
        const detail = err && err.message ? `: ${err.message}` : '';
        res.status(500);
        origJson({ error: `Error guardando los cambios${detail}` });
      });
      return res;
    };
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

// ==========================================
// UTILIDADES
// ==========================================
const attempts = new Map();
/** Limita intentos por IP (login de alumno / admin / registro). */
function rateLimit(key, max, windowMs) {
  return (req, res, next) => {
    const id = `${key}:${req.ip}`;
    const now = Date.now();
    const entry = attempts.get(id) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    attempts.set(id, entry);
    if (entry.count > max) {
      return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    }
    next();
  };
}

function bearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.query && req.query.token) return String(req.query.token).trim();
  return null;
}


function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildLegacyReceiptSvg(student) {
  const name = escapeXml(student.name || 'Alumno');
  const email = escapeXml(student.email || '');
  const ref = escapeXml((student.receipt && student.receipt.reference) || 'Sin código digitado');
  const dateStr = student.receipt && student.receipt.uploadedAt
    ? escapeXml(new Date(student.receipt.uploadedAt).toLocaleString('es-CO'))
    : '';
  const statusLabel = student.paymentStatus === 'approved' ? 'PAGO APROBADO' : 'COMPROBANTE REGISTRADO';
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="540" height="680" viewBox="0 0 540 680">
  <rect width="540" height="680" fill="#F7F5F2"/>
  <rect x="32" y="32" width="476" height="616" rx="16" fill="#FFFFFF" stroke="#D6D3D1" stroke-width="2"/>
  <rect x="32" y="32" width="476" height="92" rx="16" fill="#0F766E"/>
  <text x="270" y="72" font-family="system-ui, sans-serif" font-size="20" font-weight="800" fill="#FFFFFF" text-anchor="middle">COMPROBANTE NEQUI • IA EN 7 DÍAS</text>
  <text x="270" y="100" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#CCFBF1" text-anchor="middle">${statusLabel}</text>
  <rect x="64" y="156" width="412" height="96" rx="10" fill="#F0FDFA" stroke="#99F6E4" stroke-width="1.5"/>
  <text x="270" y="188" font-family="system-ui, sans-serif" font-size="13" font-weight="600" fill="#0F766E" text-anchor="middle">VALOR TRANSFERIDO (NEQUI 3158422894)</text>
  <text x="270" y="228" font-family="system-ui, sans-serif" font-size="32" font-weight="800" fill="#1C1917" text-anchor="middle">$24.900 COP</text>
  <g font-family="system-ui, sans-serif" font-size="14" fill="#57534E">
    <text x="64" y="300" font-weight="700" fill="#1C1917">Alumno:</text>
    <text x="64" y="324">${name}</text>
    <text x="64" y="346" font-size="12" fill="#78716C">${email}</text>
    <line x1="64" y1="368" x2="476" y2="368" stroke="#E7E5E4"/>
    <text x="64" y="400" font-weight="700" fill="#1C1917">Referencia Nequi:</text>
    <text x="64" y="424" font-family="monospace" font-size="16" font-weight="700" fill="#0F766E">${ref}</text>
    <line x1="64" y1="448" x2="476" y2="448" stroke="#E7E5E4"/>
    <text x="64" y="480" font-weight="700" fill="#1C1917">Fecha de subida:</text>
    <text x="64" y="504">${dateStr}</text>
  </g>
  <rect x="64" y="544" width="412" height="68" rx="8" fill="#FAF8F5" stroke="#E7E5E4"/>
  <text x="270" y="572" font-family="system-ui, sans-serif" font-size="11.5" fill="#78716C" text-anchor="middle">Registro migrado a Supabase antes de activar almacenamiento</text>
  <text x="270" y="592" font-family="system-ui, sans-serif" font-size="11.5" fill="#78716C" text-anchor="middle">binario directo. Los nuevos comprobantes muestran la captura real.</text>
</svg>`, 'utf-8');
}

async function sendImage(res, ref, fallbackStudent) {
  const img = await db.readImage(ref);
  if (img) {
    res.setHeader('Content-Type', img.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(img.buffer);
  }
  if (fallbackStudent && fallbackStudent.receipt) {
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buildLegacyReceiptSvg(fallbackStudent));
  }
  return res.status(404).json({ error: 'Archivo no encontrado' });
}

// ==========================================
// VALIDACIÓN (Colombia)
// ==========================================
const DOC_TYPES = {
  CC: { label: 'Cédula de ciudadanía', re: /^\d{6,10}$/ },
  CE: { label: 'Cédula de extranjería', re: /^[A-Z0-9]{5,15}$/ },
  TI: { label: 'Tarjeta de identidad', re: /^\d{6,11}$/ },
  PPT: { label: 'Permiso por Protección Temporal', re: /^[A-Z0-9]{5,15}$/ },
  PA: { label: 'Pasaporte', re: /^[A-Z0-9]{5,15}$/ }
};

function normalizeWhatsApp(raw) {
  const value = String(raw || '').trim();
  if (!/^[\d\s+()-]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('57')) digits = digits.slice(2);
  if (!/^3\d{9}$/.test(digits)) return null;
  return `+57${digits}`;
}

function validateRegistration(body) {
  const errors = {};
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{5,80}$/.test(name) || name.split(' ').length < 2) {
    errors.name = 'Escribe tu nombre y apellido (solo letras).';
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errors.email = 'Correo electrónico no válido.';
  }

  const docType = String(body.docType || '').toUpperCase();
  const docNumber = String(body.docNumber || '').toUpperCase().replace(/[\s.-]/g, '');
  if (!DOC_TYPES[docType]) {
    errors.docType = 'Selecciona el tipo de documento.';
  } else if (!DOC_TYPES[docType].re.test(docNumber)) {
    errors.docNumber = docType === 'CC' || docType === 'TI'
      ? 'Solo números, sin puntos ni espacios (6 a 10 dígitos).'
      : 'Solo letras y números, sin símbolos (5 a 15 caracteres).';
  }

  const whatsapp = normalizeWhatsApp(body.whatsapp);
  if (!whatsapp) errors.whatsapp = 'Número celular de Colombia: 10 dígitos (ej. 3001234567) o +57.';

  if (body.consent !== true) {
    errors.consent = 'Debes autorizar el tratamiento de datos para inscribirte.';
  }

  const surveyAnswers = {};
  if (body.surveyAnswers && typeof body.surveyAnswers === 'object') {
    for (const k of ['experience', 'goal', 'role', 'time']) {
      if (typeof body.surveyAnswers[k] === 'string') surveyAnswers[k] = body.surveyAnswers[k].slice(0, 200);
    }
  }

  return { errors, data: { name, email, docType, docNumber, whatsapp, surveyAnswers } };
}

// ==========================================
// VISTAS DE DATOS
// ==========================================
function studentPublicView(s) {
  const eligible = db.isCertificateEligible(s);
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    whatsapp: s.whatsapp || null,
    paymentStatus: s.paymentStatus,
    rejectionReason: s.rejectionReason || null,
    receiptUploadedAt: s.receipt ? s.receipt.uploadedAt : null,
    progressPercentage: s.paymentStatus === 'approved' ? (s.progressPercentage || 0) : 0,
    completedLessons: s.paymentStatus === 'approved' ? (s.completedLessons || []) : [],
    quizScores: s.paymentStatus === 'approved' ? (s.quizScores || {}) : {},
    evidenceLessons: s.paymentStatus === 'approved' ? Object.keys(s.evidence || {}).map(Number) : [],
    certificateUnlocked: eligible,
    certificateCode: eligible ? s.certificateCode : null,
    certificateIssuedAt: eligible ? s.certificateIssuedAt : null
  };
}

function studentAdminView(s) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    docType: s.docType || null,
    docNumber: s.docNumber || null,
    whatsapp: s.whatsapp,
    createdAt: s.createdAt,
    paymentStatus: s.paymentStatus,
    amount: s.amount,
    receipt: s.receipt ? {
      reference: s.receipt.reference,
      uploadedAt: s.receipt.uploadedAt,
      notifiedAt: s.receipt.notifiedAt || null,
      notificationProvider: s.receipt.notificationProvider || null
    } : null,
    receiptHistoryCount: (s.receiptHistory || []).length,
    rejectionReason: s.rejectionReason || null,
    approvedAt: s.approvedAt || null,
    accessCode: s.accessCode || null,
    progressPercentage: s.progressPercentage || 0,
    completedLessons: s.completedLessons || [],
    evidenceLessons: Object.keys(s.evidence || {}).map(Number).sort((a, b) => a - b),
    certificateUnlocked: db.isCertificateEligible(s),
    certificateCode: s.certificateCode || null,
    consent: s.consent || null,
    surveyAnswers: s.surveyAnswers || null,
    legacyNote: s.legacyNote || null
  };
}

// ==========================================
// RUTAS PÚBLICAS
// ==========================================
app.get('/api/config', (req, res) => {
  const s = db.getSettings();
  const sbCfg = db.getSupabaseConfig ? db.getSupabaseConfig() : { enabled: false };
  res.json({
    courseName: s.courseName,
    coursePriceCOP: s.coursePriceCOP,
    nequiNumber: s.nequiNumber,
    supportWhatsApp: s.supportWhatsApp,
    totalLessons: db.TOTAL_LESSONS,
    consentText: CONSENT_TEXT,
    docTypes: Object.entries(DOC_TYPES).map(([value, d]) => ({ value, label: d.label })),
    storageProvider: db.getStorageProvider ? db.getStorageProvider() : 'local',
    supabaseConnected: sbCfg.enabled
  });
});

// Temario público: solo títulos (el contenido real exige acceso aprobado)
app.get('/api/lessons', (req, res) => {
  res.json(db.getLessons().map(l => ({
    id: l.id, day: l.day, title: l.title, subtitle: l.subtitle, duration: l.duration, objective: l.objective
  })));
});

app.post('/api/register', rateLimit('register', 10, 15 * 60 * 1000), (req, res) => {
  const { errors, data } = validateRegistration(req.body || {});
  if (Object.keys(errors).length) {
    return res.status(400).json({ error: 'Revisa los datos del formulario.', fields: errors });
  }

  const existing = db.getStudentByEmail(data.email);
  if (existing) {
    if (existing.paymentStatus === 'approved') {
      return res.status(409).json({
        error: 'Este correo ya cuenta con acceso aprobado y activo. No debes volver a pagar. Ingresa con tu código de acceso.',
        alreadyApproved: true
      });
    }
    if (existing.paymentStatus === 'in_review') {
      return res.status(409).json({
        error: 'Ya recibimos tu comprobante de Nequi y está en revisión manual. No necesitas realizar otro pago.',
        inReview: true
      });
    }
    // Recuperar inscripción NO aprobada en otro dispositivo: correo + documento deben coincidir
    if (existing.docNumber && db.safeEqual(existing.docNumber, data.docNumber)) {
      const token = db.issueToken(existing.id);
      return res.json({ success: true, resumed: true, token, student: studentPublicView(existing) });
    }
    return res.status(409).json({ error: 'Este correo ya está inscrito con otro documento. Escríbenos por WhatsApp para ayudarte.' });
  }

  const student = db.createStudent({
    ...data,
    consent: {
      accepted: true,
      text: CONSENT_TEXT,
      version: CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
      ip: req.ip
    }
  });
  const token = db.issueToken(student.id);
  res.json({ success: true, token, student: studentPublicView(student) });
});

// Verificación pública de certificados por código
app.get('/api/verify/:code', rateLimit('verify', 30, 10 * 60 * 1000), (req, res) => {
  const s = db.getStudentByCertificateCode(req.params.code);
  if (!s || !db.isCertificateEligible(s)) return res.json({ valid: false });
  res.json({ valid: true, name: s.name, issuedAt: s.certificateIssuedAt, course: db.getSettings().courseName });
});

// ==========================================
// RUTAS DEL ALUMNO (requieren token)
// ==========================================
function requireStudent(req, res, next) {
  const student = db.getStudentByToken(bearer(req));
  if (!student) return res.status(401).json({ error: 'Sesión no válida. Vuelve a ingresar.' });
  req.student = student;
  next();
}

function requireApproved(req, res, next) {
  if (req.student.paymentStatus !== 'approved') {
    return res.status(403).json({ error: 'Tu acceso aún no ha sido aprobado.', paymentStatus: req.student.paymentStatus });
  }
  next();
}

// Ingreso de alumno aprobado con código de acceso (y correo opcional)
app.post('/api/student/login', rateLimit('student-login', 25, 10 * 60 * 1000), (req, res) => {
  const { email, code } = req.body || {};
  const result = db.authenticateStudentWithCode(email, code);
  if (result.error || !result.student) {
    return res.status(result.status || 401).json({
      error: result.error || 'Código de acceso inválido o aún no aprobado.',
      paymentStatus: result.paymentStatus || null
    });
  }
  attempts.delete(`student-login:${req.ip}`);
  const token = db.issueToken(result.student.id);
  res.json({ success: true, token, student: studentPublicView(result.student) });
});

app.get('/api/me', requireStudent, (req, res) => {
  res.json(studentPublicView(req.student));
});

app.post('/api/me/logout', requireStudent, (req, res) => {
  db.revokeToken(bearer(req));
  res.json({ success: true });
});

app.post('/api/me/receipt', requireStudent, async (req, res) => {
  const { image, reference } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Adjunta la captura del comprobante de Nequi.' });
  const ref = String(reference || '').replace(/[^A-Za-z0-9 -]/g, '').slice(0, 40);
  try {
    const result = db.saveReceipt(req.student.id, { image, reference: ref });
    if (result.error) return res.status(400).json({ error: result.error });

    let emailNotified = false;
    if (!result.duplicateReceipt) {
      try {
        const emailResult = await mailer.sendPendingPaymentEmail(result.student, {
          req,
          settings: db.getSettings()
        });
        if (emailResult && emailResult.ok) {
          emailNotified = true;
          db.markReceiptNotified(result.student.id, { provider: emailResult.provider });
        } else if (emailResult && emailResult.error) {
          console.warn('[receipt] No se pudo enviar notificación por correo:', emailResult.error);
        }
      } catch (mailErr) {
        console.warn('[receipt] Error inesperado enviando correo al admin:', mailErr.message);
      }
    }

    res.json({
      success: true,
      student: studentPublicView(result.student),
      duplicateReceipt: !!result.duplicateReceipt,
      emailNotified
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/me/lessons/:id', requireStudent, requireApproved, (req, res) => {
  const n = Number(req.params.id);
  const lesson = db.getLessonById(n);
  if (!lesson) return res.status(404).json({ error: 'Lección no encontrada' });
  const done = req.student.completedLessons || [];
  if (n > 1 && !done.includes(n - 1)) {
    return res.status(403).json({ error: `Esta lección se desbloquea al completar el Día ${n - 1}.` });
  }
  res.json(lesson);
});

app.post('/api/me/lessons/:id/complete', requireStudent, requireApproved, (req, res) => {
  const { image, quizScore, answers } = req.body || {};
  try {
    const result = db.completeLesson(req.student.id, req.params.id, { image, quizScore, answers });
    if (result.error) return res.status(400).json({ error: result.error, failedEvaluation: !!result.failedEvaluation });
    res.json({ success: true, student: studentPublicView(result.student) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/me/evidence/:lessonId', requireStudent, requireApproved, async (req, res) => {
  const ev = (req.student.evidence || {})[Number(req.params.lessonId)];
  await sendImage(res, ev);
});

// Datos del certificado: solo si completó las 7 lecciones y el pago está aprobado
app.get('/api/me/certificate', requireStudent, requireApproved, (req, res) => {
  const s = req.student;
  if (!db.isCertificateEligible(s)) {
    return res.status(403).json({ error: 'El certificado se habilita al completar las 7 lecciones.' });
  }
  res.json({
    name: s.name,
    docType: s.docType || 'CC',
    docNumber: s.docNumber || '',
    certificateCode: s.certificateCode,
    certificateIssuedAt: s.certificateIssuedAt
  });
});

// ==========================================
// ADMIN (ruta privada + contraseña + sesión firmada sin estado)
// ==========================================
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ADMIN_SALT = 'ia7d_deterministic_salt_2026';

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function getAdminSecret() {
  const pwd = String(process.env.ADMIN_PASSWORD || 'admin2026').trim();
  return crypto.createHash('sha256').update('ia7d_admin_secret_v2:' + pwd).digest();
}

function createAdminToken() {
  const exp = Date.now() + ADMIN_SESSION_MS;
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${exp}.${nonce}`;
  const sig = crypto.createHmac('sha256', getAdminSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = crypto.createHmac('sha256', getAdminSecret()).update(`${expStr}.${nonce}`).digest('hex');
  if (db.safeEqual(sig, expected)) return true;

  // Compatibilidad con tokens emitidos bajo el esquema anterior
  const s = db.getSettings();
  const legacyBase = (s.adminPasswordHash || 'default') + ':' + (s.adminPasswordSalt || 'salt');
  const legacySecret = crypto.createHash('sha256').update('ia7d_admin_secret:' + legacyBase).digest();
  const legacyExpected = crypto.createHmac('sha256', legacySecret).update(`${expStr}.${nonce}`).digest('hex');
  return db.safeEqual(sig, legacyExpected);
}

/** Contraseña admin: variable ADMIN_PASSWORD o determinística por defecto. */
function ensureAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return;
  const settings = db.getSettings();
  if (settings.adminPasswordHash && settings.adminPasswordSalt) return;

  const password = 'admin2026';
  const salt = DEFAULT_ADMIN_SALT;
  db.updateSettings({ adminPasswordHash: hashPassword(password, salt), adminPasswordSalt: salt });
  if (!db.USE_BLOB) {
    const file = path.join(db.DATA_DIR || path.join(__dirname, 'data'), 'ADMIN-CLAVE-INICIAL.txt');
    try {
      fs.writeFileSync(file, `Contraseña inicial del panel admin: ${password}\nRuta privada: ${ADMIN_PATH}\n\nPara usar tu propia clave, define la variable de entorno ADMIN_PASSWORD.\n`, 'utf-8');
    } catch (e) {
      // ignorar si el sistema de archivos es de solo lectura
    }
  }
}

function checkAdminPassword(password) {
  const clean = String(password || '').trim();
  if (!clean) return false;
  const expectedPwd = String(process.env.ADMIN_PASSWORD || 'admin2026').trim();
  if (db.safeEqual(clean, expectedPwd)) return true;
  const s = db.getSettings();
  if (!s.adminPasswordHash || !s.adminPasswordSalt) return false;
  return db.safeEqual(hashPassword(clean, s.adminPasswordSalt), s.adminPasswordHash);
}

function requireAdmin(req, res, next) {
  const token = bearer(req);
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Sesión de administrador no válida.' });
  }
  next();
}

// Página privada del panel (fuera de /public)
app.get([ADMIN_PATH, `${ADMIN_PATH}/`], (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(PRIVATE_DIR, 'admin.html'));
});
app.get(`${ADMIN_PATH}/admin.js`, (req, res) => {
  res.sendFile(path.join(PRIVATE_DIR, 'admin.js'));
});

app.post('/api/admin/login', rateLimit('admin-login', 25, 10 * 60 * 1000), (req, res) => {
  if (!checkAdminPassword((req.body || {}).password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta. Verifica mayúsculas y minúsculas.' });
  }
  attempts.delete(`admin-login:${req.ip}`);
  const token = createAdminToken();
  res.json({ success: true, token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.json({ success: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const students = db.getStudents();
  const approved = students.filter(s => s.paymentStatus === 'approved');
  res.json({
    totalStudents: students.length,
    inReviewCount: students.filter(s => s.paymentStatus === 'in_review').length,
    awaitingCount: students.filter(s => s.paymentStatus === 'awaiting_payment').length,
    rejectedCount: students.filter(s => s.paymentStatus === 'rejected').length,
    approvedCount: approved.length,
    certificatesIssued: students.filter(s => db.isCertificateEligible(s)).length,
    totalRevenueCOP: approved.reduce((acc, s) => acc + (s.amount || 0), 0)
  });
});

app.get('/api/admin/students', requireAdmin, (req, res) => {
  res.json(db.getStudents().map(studentAdminView));
});

app.get('/api/admin/students/:id/receipt', requireAdmin, async (req, res) => {
  const s = db.getStudentById(req.params.id);
  if (!s || !s.receipt) return res.status(404).json({ error: 'Comprobante no encontrado' });
  await sendImage(res, s.receipt, s);
});

app.get('/api/admin/students/:id/evidence/:lessonId', requireAdmin, async (req, res) => {
  const s = db.getStudentById(req.params.id);
  const ev = s && (s.evidence || {})[Number(req.params.lessonId)];
  await sendImage(res, ev);
});

app.post('/api/admin/students/:id/approve', requireAdmin, (req, res) => {
  const result = db.approveStudent(req.params.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, student: studentAdminView(result.student) });
});

app.post('/api/admin/students/:id/reject', requireAdmin, (req, res) => {
  const reason = String((req.body || {}).reason || '').slice(0, 300);
  const result = db.rejectStudent(req.params.id, reason);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, student: studentAdminView(result.student) });
});

app.post('/api/admin/students/:id/revoke', requireAdmin, (req, res) => {
  const reason = String((req.body || {}).reason || '').slice(0, 300);
  const result = db.revokeStudent(req.params.id, reason);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true, student: studentAdminView(result.student) });
});

app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  if (!db.deleteStudent(req.params.id)) return res.status(404).json({ error: 'Alumno no encontrado' });
  res.json({ success: true });
});

// Videos por lección (solo YouTube/Vimeo propios o material libre verificado)
function parseVideoUrl(url) {
  const u = String(url || '').trim();
  if (!u) return null;
  let m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(u);
  if (m) return { provider: 'youtube', id: m[1] };
  m = /vimeo\.com\/(?:video\/)?(\d{6,12})/.exec(u);
  if (m) return { provider: 'vimeo', id: m[1] };
  return undefined;
}

app.get('/api/admin/lessons', requireAdmin, (req, res) => {
  res.json(db.getLessons().map(l => ({ id: l.id, day: l.day, title: l.title, video: l.video || null })));
});

app.put('/api/admin/lessons/:id/video', requireAdmin, (req, res) => {
  const video = parseVideoUrl((req.body || {}).url);
  if (video === undefined) {
    return res.status(400).json({ error: 'Pega un enlace válido de YouTube o Vimeo (o deja vacío para quitarlo).' });
  }
  const updated = db.updateLesson(req.params.id, { video });
  if (!updated) return res.status(404).json({ error: 'Lección no encontrada' });
  res.json({ success: true, video: updated.video });
});

// Configuración y prueba de notificaciones automáticas por correo al admin
function maskSecretKey(cfg) {
  if (cfg.resendApiKey) {
    const k = cfg.resendApiKey;
    return k.length > 8 ? `${k.slice(0, 5)}••••••••••••${k.slice(-4)}` : 're_••••••••';
  }
  if (cfg.gmailAppPassword) {
    const p = cfg.gmailAppPassword;
    return p.length > 6 ? `${p.slice(0, 2)}••••••••••••${p.slice(-2)}` : '••••••••••••••••';
  }
  return '';
}

app.get('/api/admin/email-config', requireAdmin, (req, res) => {
  const settings = db.getSettings();
  const cfg = mailer.resolveEmailConfig(settings);
  res.json({
    toEmail: cfg.toEmail,
    gmailUser: cfg.gmailUser,
    hasGmailAppPassword: Boolean(cfg.gmailAppPassword),
    hasResendApiKey: Boolean(cfg.resendApiKey),
    activeProvider: cfg.activeProvider,
    hasDedicatedCredentials: cfg.hasDedicatedCredentials,
    maskedKey: maskSecretKey(cfg),
    envConfigured: Boolean(process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || process.env.RESEND_API_KEY)
  });
});

app.put('/api/admin/email-config', requireAdmin, (req, res) => {
  const body = req.body || {};
  const settings = db.getSettings();
  const prev = (settings && settings.emailNotifications) || {};
  const next = { ...prev };

  if (typeof body.gmailAppPassword === 'string') {
    const cleanPass = body.gmailAppPassword.replace(/\s+/g, '').trim();
    if (cleanPass) next.gmailAppPassword = cleanPass;
    else if (body.clearGmailAppPassword) delete next.gmailAppPassword;
  }
  if (typeof body.resendApiKey === 'string') {
    const cleanKey = body.resendApiKey.trim();
    if (cleanKey) next.resendApiKey = cleanKey;
    else if (body.clearResendApiKey) delete next.resendApiKey;
  }

  db.updateSettings({ emailNotifications: next });
  const cfg = mailer.resolveEmailConfig(db.getSettings());
  res.json({
    success: true,
    toEmail: cfg.toEmail,
    activeProvider: cfg.activeProvider,
    hasGmailAppPassword: Boolean(cfg.gmailAppPassword),
    hasResendApiKey: Boolean(cfg.resendApiKey),
    hasDedicatedCredentials: cfg.hasDedicatedCredentials,
    maskedKey: maskSecretKey(cfg)
  });
});

app.post('/api/admin/email-test', requireAdmin, async (req, res) => {
  const mockStudent = {
    name: 'Alumno de Prueba (Verificación)',
    docType: 'CC',
    docNumber: '1114830468',
    whatsapp: '+57 315 842 2894',
    email: 'samuelfranco1215@gmail.com',
    receipt: {
      reference: 'PRUEBA-NEQUI-001',
      uploadedAt: new Date().toISOString()
    }
  };
  const result = await mailer.sendPendingPaymentEmail(mockStudent, {
    req,
    settings: db.getSettings(),
    isTest: true
  });
  if (!result.ok) {
    return res.status(400).json({
      success: false,
      error: result.error || 'No se pudo enviar el correo de prueba.',
      to: result.to
    });
  }
  res.json({
    success: true,
    provider: result.provider,
    to: result.to,
    subject: result.subject
  });
});

// Cualquier /api desconocida -> 404 JSON
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// SPA pública
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (!db.USE_BLOB) ensureAdminPassword();

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log('=========================================');
    console.log('  IA en 7 Días - Plataforma activa');
    console.log(`  Sitio:        http://localhost:${PORT}`);
    console.log(`  Panel admin:  http://localhost:${PORT}${ADMIN_PATH}  (ruta privada)`);
    console.log('=========================================');
  });
}

module.exports = app;
