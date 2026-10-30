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


async function sendImage(res, ref) {
  const img = await db.readImage(ref);
  if (!img) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(img.buffer);
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
    receipt: s.receipt ? { reference: s.receipt.reference, uploadedAt: s.receipt.uploadedAt } : null,
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

app.post('/api/me/receipt', requireStudent, (req, res) => {
  const { image, reference } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Adjunta la captura del comprobante de Nequi.' });
  const ref = String(reference || '').replace(/[^A-Za-z0-9 -]/g, '').slice(0, 40);
  try {
    const result = db.saveReceipt(req.student.id, { image, reference: ref });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, student: studentPublicView(result.student) });
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
  const { image, quizScore } = req.body || {};
  try {
    const result = db.completeLesson(req.student.id, req.params.id, { image, quizScore });
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, student: studentPublicView(result.student) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/me/evidence/:lessonId', requireStudent, requireApproved, (req, res) => {
  const ev = (req.student.evidence || {})[Number(req.params.lessonId)];
  sendImage(res, ev);
});

// Datos del certificado: solo si completó las 7 lecciones y el pago está aprobado
app.get('/api/me/certificate', requireStudent, requireApproved, (req, res) => {
  const s = req.student;
  if (!db.isCertificateEligible(s)) {
    return res.status(403).json({ error: 'El certificado se habilita al completar las 7 lecciones.' });
  }
  res.json({ name: s.name, certificateCode: s.certificateCode, certificateIssuedAt: s.certificateIssuedAt });
});

// ==========================================
// ADMIN (ruta privada + contraseña + sesión firmada sin estado)
// ==========================================
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function getAdminSecret() {
  if (process.env.ADMIN_PASSWORD) {
    return crypto.createHash('sha256').update('ia7d_admin_secret:' + process.env.ADMIN_PASSWORD).digest();
  }
  const s = db.getSettings();
  const base = (s.adminPasswordHash || 'default') + ':' + (s.adminPasswordSalt || 'salt');
  return crypto.createHash('sha256').update('ia7d_admin_secret:' + base).digest();
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
  return db.safeEqual(sig, expected);
}

/** Contraseña admin: variable ADMIN_PASSWORD o una aleatoria generada en el primer arranque. */
function ensureAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return;
  const settings = db.getSettings();
  if (settings.adminPasswordHash && settings.adminPasswordSalt) return;

  const password = process.env.ADMIN_PASSWORD || 'admin2026';
  const salt = crypto.randomBytes(16).toString('hex');
  db.updateSettings({ adminPasswordHash: hashPassword(password, salt), adminPasswordSalt: salt });
  if (!db.USE_BLOB) {
    const file = path.join(db.DATA_DIR || path.join(__dirname, 'data'), 'ADMIN-CLAVE-INICIAL.txt');
    try {
      fs.writeFileSync(file, `Contraseña inicial del panel admin: ${password}\nRuta privada: ${ADMIN_PATH}\n\nPara usar tu propia clave, define la variable de entorno ADMIN_PASSWORD.\n`, 'utf-8');
    } catch (e) {
      // ignorar si el sistema de archivos es de solo lectura
    }
  }
  console.log(`[admin] Contraseña inicial configurada: ${password} (Ruta: ${ADMIN_PATH})`);
}

function checkAdminPassword(password) {
  const clean = String(password || '').trim();
  if (!clean) return false;
  if (process.env.ADMIN_PASSWORD) return db.safeEqual(clean, String(process.env.ADMIN_PASSWORD).trim());
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
    approvedCount: approved.length,
    certificatesIssued: students.filter(s => db.isCertificateEligible(s)).length,
    totalRevenueCOP: approved.reduce((acc, s) => acc + (s.amount || 0), 0)
  });
});

app.get('/api/admin/students', requireAdmin, (req, res) => {
  res.json(db.getStudents().map(studentAdminView));
});

app.get('/api/admin/students/:id/receipt', requireAdmin, (req, res) => {
  const s = db.getStudentById(req.params.id);
  sendImage(res, s && s.receipt);
});

app.get('/api/admin/students/:id/evidence/:lessonId', requireAdmin, (req, res) => {
  const s = db.getStudentById(req.params.id);
  const ev = s && (s.evidence || {})[Number(req.params.lessonId)];
  sendImage(res, ev);
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
