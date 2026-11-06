/**
 * IA en 7 Días — Servicio de notificaciones automáticas por correo al administrador
 *
 * Envía únicamente notificaciones por correo electrónico a samuelfranco1215@gmail.com
 * cuando un alumno completa su inscripción + sube su comprobante y pasa a estado
 * "pendiente de aprobación" (in_review).
 *
 * Soporta en producción (Vercel) sin dependencias externas:
 *  1) Gmail SMTP directo (tls nativo en smtp.gmail.com:465) usando GMAIL_APP_PASSWORD
 *  2) Resend API HTTP (https://api.resend.com/emails) usando RESEND_API_KEY
 *  3) Respaldo FormSubmit AJAX (https://formsubmit.co/ajax/samuelfranco1215@gmail.com)
 */

const tls = require('tls');

const DEFAULT_ADMIN_EMAIL = 'samuelfranco1215@gmail.com';
const DEFAULT_SITE_URL = 'https://iaen7dias.vercel.app';
const DEFAULT_ADMIN_PATH = '/gestion-ia7d-privado';
const EMAIL_SUBJECT = 'Nuevo pago por revisar - IA en 7 Días';

function formatColombiaDate(dateInput) {
  const d = dateInput ? new Date(dateInput) : new Date();
  try {
    return d.toLocaleString('es-CO', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  } catch (e) {
    return d.toISOString();
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function encodeMimeHeaderUtf8(text) {
  return `=?UTF-8?B?${Buffer.from(String(text || ''), 'utf8').toString('base64')}?=`;
}

function resolveEmailConfig(settings = {}) {
  const notifyConfig = (settings && settings.emailNotifications) || {};
  const toEmail = String(
    process.env.ADMIN_NOTIFY_EMAIL ||
    notifyConfig.toEmail ||
    DEFAULT_ADMIN_EMAIL
  ).trim() || DEFAULT_ADMIN_EMAIL;

  const gmailUser = String(
    process.env.GMAIL_USER ||
    process.env.SMTP_USER ||
    notifyConfig.gmailUser ||
    DEFAULT_ADMIN_EMAIL
  ).trim() || DEFAULT_ADMIN_EMAIL;

  const gmailAppPassword = String(
    process.env.GMAIL_APP_PASSWORD ||
    process.env.SMTP_PASS ||
    notifyConfig.gmailAppPassword ||
    ''
  ).replace(/\s+/g, '').trim();

  const resendApiKey = String(
    process.env.RESEND_API_KEY ||
    notifyConfig.resendApiKey ||
    ''
  ).trim();

  const resendFrom = String(
    process.env.RESEND_FROM_EMAIL ||
    notifyConfig.resendFrom ||
    'IA en 7 Días <onboarding@resend.dev>'
  ).trim();

  const smtpHost = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const smtpPort = Number(process.env.SMTP_PORT || 465);

  let activeProvider = 'none';
  if (gmailAppPassword) activeProvider = 'gmail_smtp';
  else if (resendApiKey) activeProvider = 'resend_api';
  else activeProvider = 'formsubmit_fallback';

  return {
    toEmail,
    gmailUser,
    gmailAppPassword,
    resendApiKey,
    resendFrom,
    smtpHost,
    smtpPort,
    activeProvider,
    hasDedicatedCredentials: Boolean(gmailAppPassword || resendApiKey)
  };
}

function getAdminPanelUrl(req) {
  const envUrl = String(process.env.PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');
  const adminPath = String(process.env.ADMIN_PATH || DEFAULT_ADMIN_PATH).trim();
  if (envUrl) return `${envUrl}${adminPath}`;
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'https');
    const host = String(req.headers.host).trim();
    if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
      return `${proto}://${host}${adminPath}`;
    }
  }
  return `${DEFAULT_SITE_URL}${adminPath}`;
}

function buildPendingPaymentEmailContent(student, req, isTest = false) {
  const name = (student && student.name) || 'Alumno de prueba';
  const docType = (student && student.docType) || 'CC';
  const docNumber = (student && student.docNumber) || 'S/N';
  const fullDocument = `${docType} ${docNumber}`.trim();
  const whatsapp = (student && student.whatsapp) || 'No registrado';
  const email = (student && student.email) || 'No registrado';
  const uploadedAt = (student && student.receipt && student.receipt.uploadedAt) || new Date().toISOString();
  const reference = (student && student.receipt && student.receipt.reference) || 'Sin referencia digitada';
  const formattedDate = formatColombiaDate(uploadedAt);
  const statusLabel = 'Pendiente de aprobación';
  const adminUrl = getAdminPanelUrl(req);
  const shortTime = new Date().toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const subject = isTest
    ? `${EMAIL_SUBJECT} — Prueba (${shortTime})`
    : `${EMAIL_SUBJECT} — ${name} (${shortTime})`;

  const text = [
    'Nuevo pago por revisar - IA en 7 Días',
    '========================================',
    `Nombre del alumno: ${name}`,
    `Cédula / Documento: ${fullDocument}`,
    `Teléfono / WhatsApp: ${whatsapp}`,
    `Correo del alumno: ${email}`,
    `Referencia Nequi: ${reference}`,
    `Fecha: ${formattedDate} (Hora Colombia)`,
    `Estado: ${statusLabel}`,
    '',
    `Revisar y aprobar en el panel admin:`,
    adminUrl
  ].join('\n');

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1C1917;max-width:540px;">
  <p style="margin:0 0 12px;">Hola Samuel,</p>
  <p style="margin:0 0 14px;">Se registró un <strong>nuevo pago por revisar</strong> en <strong>IA en 7 Días</strong>:</p>
  <ul style="margin:0 0 16px;padding-left:18px;">
    <li><strong>Nombre del alumno:</strong> ${escapeHtml(name)}</li>
    <li><strong>Cédula:</strong> ${escapeHtml(fullDocument)}</li>
    <li><strong>Teléfono / WhatsApp:</strong> ${escapeHtml(whatsapp)}</li>
    <li><strong>Correo del alumno:</strong> ${escapeHtml(email)}</li>
    <li><strong>Referencia Nequi:</strong> ${escapeHtml(reference)}</li>
    <li><strong>Fecha:</strong> ${escapeHtml(formattedDate)}</li>
    <li><strong>Estado:</strong> ${escapeHtml(statusLabel)}</li>
  </ul>
  <p style="margin:0 0 8px;"><strong>Link al panel admin:</strong><br>
    <a href="${escapeHtml(adminUrl)}" target="_blank" rel="noopener">${escapeHtml(adminUrl)}</a>
  </p>
</div>`;

  return { subject, text, html, adminUrl, formattedDate, fullDocument, statusLabel };
}

/**
 * Envía un correo mediante conexión SMTP sobre TLS directo (puerto 465, p. ej. smtp.gmail.com)
 * sin requerir paquetes externos en node_modules.
 */
function sendViaSmtpTls({ host, port, user, pass, to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) { }
      if (err) reject(err);
      else resolve(val);
    };

    const timer = setTimeout(() => {
      done(new Error('Tiempo de espera agotado conectando al servidor SMTP (8s).'));
    }, 8000);

    const boundary = `ia7d_bound_${Date.now().toString(16)}`;
    const textB64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const htmlB64 = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

    const mimeMessage = [
      `From: ${encodeMimeHeaderUtf8('IA en 7 Días')} <${user}>`,
      `To: <${to}>`,
      `Subject: ${encodeMimeHeaderUtf8(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      textB64,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      htmlB64,
      '',
      `--${boundary}--`,
      '.',
      ''
    ].join('\r\n');

    const steps = [
      { expect: '220', send: `EHLO iaen7dias.vercel.app` },
      { expect: '250', send: `AUTH LOGIN` },
      { expect: '334', send: Buffer.from(user, 'utf8').toString('base64') },
      { expect: '334', send: Buffer.from(pass, 'utf8').toString('base64') },
      { expect: '235', send: `MAIL FROM:<${user}>` },
      { expect: '250', send: `RCPT TO:<${to}>` },
      { expect: '250', send: `DATA` },
      { expect: '354', send: mimeMessage },
      { expect: '250', send: `QUIT`, final: true }
    ];

    let stepIndex = 0;
    let buffer = '';

    const socket = tls.connect({ host, port, servername: host }, () => { });

    socket.setEncoding('utf8');
    socket.on('error', (err) => done(err));

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line) continue;
        // Las líneas intermedias de respuesta multilínea tienen guión en la posición 4 (ej. "250-...")
        if (line.length >= 4 && line[3] === '-') continue;

        const currentStep = steps[stepIndex];
        if (!currentStep) continue;

        if (!line.startsWith(currentStep.expect)) {
          return done(new Error(`Respuesta SMTP inesperada en paso ${stepIndex + 1}: ${line}`));
        }

        stepIndex++;
        if (currentStep.final) {
          return done(null, { ok: true, provider: 'gmail_smtp' });
        }
        socket.write(currentStep.send + '\r\n');
      }
    });
  });
}

async function sendViaResend({ apiKey, from, to, subject, text, html }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7500);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html
      }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || `Resend HTTP ${res.status}`);
    }
    return { ok: true, provider: 'resend_api', id: data.id || null };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendViaFormSubmitFallback({ to, subject, student, formattedDate, fullDocument, statusLabel, adminUrl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': DEFAULT_SITE_URL,
        'Referer': `${DEFAULT_SITE_URL}/`
      },
      body: JSON.stringify({
        _subject: subject,
        _template: 'table',
        _captcha: 'false',
        'Nombre del alumno': (student && student.name) || '',
        'Cédula': fullDocument,
        'Teléfono / WhatsApp': (student && student.whatsapp) || '',
        'Correo del alumno': (student && student.email) || '',
        'Fecha': formattedDate,
        'Estado': statusLabel,
        'Panel Admin': adminUrl
      }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === 'false' || data.success === false) {
      throw new Error(data.message || `FormSubmit HTTP ${res.status}`);
    }
    return { ok: true, provider: 'formsubmit_fallback', message: data.message || null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Envía la notificación automática al correo del administrador cuando un pago
 * pasa a "pendiente de aprobación". Nunca lanza una excepción no controlada.
 */
async function sendPendingPaymentEmail(student, { req = null, settings = {}, isTest = false } = {}) {
  const cfg = resolveEmailConfig(settings);
  const content = buildPendingPaymentEmailContent(student, req, isTest);
  const errors = [];

  // 1) Intentar con Gmail SMTP si hay contraseña de aplicación configurada
  if (cfg.gmailAppPassword) {
    try {
      const res = await sendViaSmtpTls({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        user: cfg.gmailUser,
        pass: cfg.gmailAppPassword,
        to: cfg.toEmail,
        subject: content.subject,
        text: content.text,
        html: content.html
      });
      return { ...res, to: cfg.toEmail, subject: content.subject };
    } catch (err) {
      console.error('[mailer] Error en Gmail SMTP:', err.message);
      errors.push(`Gmail SMTP: ${err.message}`);
    }
  }

  // 2) Intentar con Resend API si hay RESEND_API_KEY configurada
  if (cfg.resendApiKey) {
    try {
      const res = await sendViaResend({
        apiKey: cfg.resendApiKey,
        from: cfg.resendFrom,
        to: cfg.toEmail,
        subject: content.subject,
        text: content.text,
        html: content.html
      });
      return { ...res, to: cfg.toEmail, subject: content.subject };
    } catch (err) {
      console.error('[mailer] Error en Resend API:', err.message);
      errors.push(`Resend API: ${err.message}`);
    }
  }

  // 3) Respaldo mediante FormSubmit AJAX
  try {
    const res = await sendViaFormSubmitFallback({
      to: cfg.toEmail,
      subject: content.subject,
      student,
      formattedDate: content.formattedDate,
      fullDocument: content.fullDocument,
      statusLabel: content.statusLabel,
      adminUrl: content.adminUrl
    });
    return { ...res, to: cfg.toEmail, subject: content.subject };
  } catch (err) {
    console.warn('[mailer] Respaldo FormSubmit no disponible:', err.message);
    errors.push(`FormSubmit: ${err.message}`);
  }

  return {
    ok: false,
    to: cfg.toEmail,
    subject: content.subject,
    error: errors.join(' | ') || 'No hay proveedor de correo configurado (define GMAIL_APP_PASSWORD o RESEND_API_KEY).'
  };
}

module.exports = {
  DEFAULT_ADMIN_EMAIL,
  EMAIL_SUBJECT,
  resolveEmailConfig,
  buildPendingPaymentEmailContent,
  sendPendingPaymentEmail
};

