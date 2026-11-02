/**
 * IA en 7 Días - Lógica del Panel de Administración Privado
 */
const AdminApp = {
  token: null,
  students: [],
  currentFilter: 'all',
  searchQuery: '',
  activeStudentForApproval: null,
  _initialized: false,

  init: async function () {
    if (this._initialized) return;
    this._initialized = true;

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        this.handleLogin(e);
        return false;
      });
    }

    const savedToken = localStorage.getItem('ia7d_admin_token') || sessionStorage.getItem('ia7d_admin_token');
    if (savedToken) {
      try {
        const res = await fetch('/api/admin/stats', {
          headers: { 'Authorization': `Bearer ${savedToken}` }
        });
        if (res.ok) {
          this.token = savedToken;
          this.showDashboard();
          return;
        }
      } catch (e) { }
      localStorage.removeItem('ia7d_admin_token');
      sessionStorage.removeItem('ia7d_admin_token');
    }
    this.showLogin();
  },

  togglePasswordVisibility: function () {
    const input = document.getElementById('admin-password-input');
    const toggleBtn = document.getElementById('btn-toggle-pwd');
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      if (toggleBtn) toggleBtn.textContent = 'Ocultar';
    } else {
      input.type = 'password';
      if (toggleBtn) toggleBtn.textContent = 'Mostrar';
    }
    input.focus();
  },

  showLogin: function () {
    document.getElementById('admin-login-view').style.display = 'block';
    document.getElementById('admin-dashboard-view').style.display = 'none';
    document.getElementById('header-actions').style.display = 'none';
    const input = document.getElementById('admin-password-input');
    if (input && document.activeElement !== input) {
      setTimeout(() => input.focus(), 50);
    }
  },

  showDashboard: function () {
    document.getElementById('admin-login-view').style.display = 'none';
    document.getElementById('admin-dashboard-view').style.display = 'block';
    document.getElementById('header-actions').style.display = 'flex';
    this.refresh();
  },

  handleLogin: async function (e) {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    const inputEl = document.getElementById('admin-password-input');
    const password = inputEl ? inputEl.value.trim() : '';
    const btn = document.getElementById('btn-login');
    const errEl = document.getElementById('login-error');

    if (!password) {
      if (errEl) {
        errEl.textContent = 'Por favor escribe la contraseña de administrador.';
        errEl.style.display = 'block';
      }
      if (inputEl) inputEl.focus();
      return false;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Verificando contraseña...';
    }
    if (errEl) errEl.style.display = 'none';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        if (errEl) {
          errEl.textContent = data.error || 'Contraseña incorrecta.';
          errEl.style.display = 'block';
        }
        if (inputEl) inputEl.focus();
        return false;
      }

      this.token = data.token;
      localStorage.setItem('ia7d_admin_token', this.token);
      sessionStorage.setItem('ia7d_admin_token', this.token);
      this.showDashboard();
      return false;
    } catch (err) {
      if (errEl) {
        errEl.textContent = 'Error de conexión con el servidor. Inténtalo de nuevo.';
        errEl.style.display = 'block';
      }
      return false;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Ingresar al Panel ➔';
      }
    }
  },

  logout: async function () {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
    } catch (e) { }
    this.token = null;
    localStorage.removeItem('ia7d_admin_token');
    sessionStorage.removeItem('ia7d_admin_token');
    this.showLogin();
  },

  api: async function (endpoint, options = {}) {
    if (!this.token) {
      this.token = localStorage.getItem('ia7d_admin_token') || sessionStorage.getItem('ia7d_admin_token');
    }
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
      const checkRes = await fetch('/api/admin/stats', {
        headers: { 'Authorization': `Bearer ${this.token}` }
      }).catch(() => null);
      if (!checkRes || checkRes.status === 401) {
        alert('Tu sesión administrativa expiró. Vuelve a ingresar tu contraseña.');
        this.logout();
        throw new Error('Unauthorized');
      }
    }
    return res;
  },

  refresh: async function () {
    await this.loadStats();
    await this.loadStudents();
    await this.loadLessons();
  },

  loadStats: async function () {
    try {
      const res = await this.api('/api/admin/stats');
      const data = await res.json();
      const pendingTotal = (data.inReviewCount || 0) + (data.awaitingCount || 0);
      document.getElementById('stat-total').textContent = data.totalStudents || 0;
      document.getElementById('stat-in-review').textContent = data.inReviewCount || 0;
      document.getElementById('tab-count-review').textContent = pendingTotal;
      const tabApproved = document.getElementById('tab-count-approved');
      if (tabApproved) tabApproved.textContent = data.approvedCount || 0;
      const tabRejected = document.getElementById('tab-count-rejected');
      if (tabRejected) tabRejected.textContent = data.rejectedCount || 0;
      document.getElementById('stat-approved').textContent = data.approvedCount || 0;
      document.getElementById('stat-awaiting').textContent = data.awaitingCount || 0;
      document.getElementById('stat-revenue').textContent = `$${(data.totalRevenueCOP || 0).toLocaleString('es-CO')} COP`;
      document.getElementById('stat-certs').textContent = data.certificatesIssued || 0;

      const alertCard = document.getElementById('stat-card-in-review');
      if (data.inReviewCount > 0) {
        alertCard.classList.add('alert');
      } else {
        alertCard.classList.remove('alert');
      }
    } catch (e) {
      console.error('Error stats:', e);
    }
  },

  loadStudents: async function () {
    try {
      const res = await this.api('/api/admin/students');
      this.students = await res.json();
      this.renderStudents();
    } catch (e) {
      console.error('Error students:', e);
    }
  },

  setFilter: function (status, btn) {
    this.currentFilter = status;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    this.renderStudents();
  },

  search: function (query) {
    this.searchQuery = (query || '').toLowerCase().trim();
    this.renderStudents();
  },

  renderStudents: function () {
    const tbody = document.getElementById('students-tbody');
    let list = [...this.students];

    if (this.currentFilter === 'pending') {
      list = list.filter(s => s.paymentStatus === 'in_review' || s.paymentStatus === 'awaiting_payment');
      list.sort((a, b) => (a.paymentStatus === 'in_review' ? -1 : 1) - (b.paymentStatus === 'in_review' ? -1 : 1));
    } else if (this.currentFilter !== 'all') {
      list = list.filter(s => s.paymentStatus === this.currentFilter);
    }

    if (this.searchQuery) {
      const qDigits = this.searchQuery.replace(/\D/g, '');
      list = list.filter(s => {
        const nameMatch = s.name && s.name.toLowerCase().includes(this.searchQuery);
        const emailMatch = s.email && s.email.toLowerCase().includes(this.searchQuery);
        const docMatch = s.docNumber && (s.docNumber.toLowerCase().includes(this.searchQuery) || (qDigits && s.docNumber.replace(/\D/g, '').includes(qDigits)));
        const phoneDigits = (s.whatsapp || '').replace(/\D/g, '');
        const phoneMatch = (s.whatsapp && s.whatsapp.toLowerCase().includes(this.searchQuery)) || (qDigits && phoneDigits.includes(qDigits));
        const codeMatch = s.accessCode && s.accessCode.toLowerCase().includes(this.searchQuery);
        return nameMatch || emailMatch || docMatch || phoneMatch || codeMatch;
      });
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 2.5rem; color: var(--text-dim);">No se encontraron alumnos con los criterios seleccionados.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(s => {
      const cleanPhone = (s.whatsapp || '').replace(/\D/g, '');
      const isApproved = s.paymentStatus === 'approved';
      const hasReceipt = !!s.receipt;
      const progress = s.progressPercentage || 0;
      const completedCount = (s.completedLessons || []).length;
      const evidenceCount = (s.evidenceLessons || []).length;

      let statusBadge = '';
      if (s.paymentStatus === 'in_review') {
        statusBadge = `<span class="badge badge-in_review">⏳ En Revisión</span>`;
      } else if (s.paymentStatus === 'approved') {
        statusBadge = `<span class="badge badge-approved">✓ Aprobado</span>`;
      } else if (s.paymentStatus === 'awaiting_payment') {
        statusBadge = `<span class="badge badge-awaiting_payment">Pendiente Nequi</span>`;
      } else if (s.paymentStatus === 'rejected') {
        statusBadge = `<span class="badge badge-rejected">✕ Rechazado</span>`;
      }

      const receiptImgUrl = `/api/admin/students/${s.id}/receipt?token=${encodeURIComponent(this.token)}`;
      const receiptBtn = hasReceipt
        ? `<div style="display: flex; align-items: center; gap: 0.55rem;">
             <div onclick="AdminApp.viewReceipt('${s.id}')" title="Clic para ampliar comprobante" style="width: 46px; height: 46px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--bg-card); overflow: hidden; cursor: zoom-in; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
               <img src="${receiptImgUrl}" alt="Comprobante ${s.name}" loading="lazy" style="width: 100%; height: 100%; object-fit: cover; display: block;" onerror="this.style.display='none'; this.parentElement.innerHTML='<span style=\\'font-size:1.15rem;\\'>🧾</span>';">
             </div>
             <button type="button" class="btn btn-secondary btn-sm" onclick="AdminApp.viewReceipt('${s.id}')">🔍 Ampliar</button>
           </div>`
        : `<span style="color: var(--text-dim); font-size: 0.78rem;">Sin comprobante</span>`;

      let accessColumn = '';
      if (isApproved) {
        accessColumn = `
          <div>
            <div style="font-family: monospace; font-weight: 800; color: var(--accent-primary); font-size: 0.95rem;">${s.accessCode || 'ACTIVO'}</div>
            <button class="btn btn-secondary btn-sm" style="margin-top: 0.25rem; font-size: 0.72rem; padding: 0.2rem 0.5rem;" onclick="AdminApp.showApprovedModal('${s.id}')">
              💬 Enviar por WhatsApp
            </button>
          </div>
        `;
      } else if (hasReceipt) {
        accessColumn = `
          <button class="btn btn-success btn-sm" onclick="AdminApp.approveStudent('${s.id}')">
            ✓ Aprobar Pago
          </button>
        `;
      } else {
        accessColumn = `
          <button class="btn btn-secondary btn-sm" title="Solo se recomienda tras verificar que el pago ingresó a Nequi" onclick="AdminApp.approveStudent('${s.id}')">
            Aprobar Manual
          </button>
        `;
      }

      const evidenceBtn = evidenceCount > 0
        ? `<button class="btn btn-secondary btn-sm" style="font-size: 0.75rem;" onclick="AdminApp.viewEvidences('${s.id}')">📸 Ver (${evidenceCount})</button>`
        : `<span style="color: var(--text-dim); font-size: 0.75rem;">0</span>`;

      return `
        <tr>
          <td>
            <strong style="color: var(--text-main); font-size: 0.92rem;">${s.name}</strong>
            <div style="color: var(--text-muted); font-size: 0.78rem;">${s.email}</div>
            <div style="color: var(--text-dim); font-size: 0.72rem;">Registrado: ${new Date(s.createdAt).toLocaleDateString('es-CO')}</div>
          </td>
          <td>
            <span style="font-size: 0.8rem; background: var(--bg-card); padding: 0.2rem 0.45rem; border-radius: 4px; border: 1px solid var(--border-hairline);">
              ${s.docType || 'CC'} ${s.docNumber || 'S/N'}
            </span>
          </td>
          <td>
            <a href="https://wa.me/${cleanPhone}" target="_blank" style="color: var(--accent-primary); font-weight: 600; text-decoration: none; font-size: 0.82rem;" title="Abrir chat en WhatsApp">
              💬 ${s.whatsapp}
            </a>
          </td>
          <td>${statusBadge}</td>
          <td>
            <div style="font-weight: 700; color: var(--text-main);">${progress}%</div>
            <div style="font-size: 0.75rem; color: var(--text-dim);">${completedCount}/7 lecciones</div>
            <div style="margin-top: 0.25rem;">${evidenceBtn}</div>
          </td>
          <td>${receiptBtn}</td>
          <td>${accessColumn}</td>
          <td>
            <div style="display: flex; gap: 0.35rem;">
              ${!isApproved && s.paymentStatus === 'in_review' ? `
                <button class="btn btn-danger btn-sm" onclick="AdminApp.rejectStudent('${s.id}')" title="Rechazar comprobante">
                  ✕
                </button>
              ` : ''}
              ${isApproved ? `
                <button class="btn btn-secondary btn-sm" style="color: var(--accent-red);" onclick="AdminApp.revokeStudent('${s.id}')" title="Revocar acceso">
                  Bloquear
                </button>
              ` : ''}
              <button class="btn btn-secondary btn-sm" style="color: var(--text-dim);" onclick="AdminApp.deleteStudent('${s.id}')" title="Eliminar inscripción">
                🗑
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  receiptZoomed: false,

  toggleReceiptZoom: function () {
    const imgEl = document.getElementById('receipt-img');
    const zoomBtn = document.getElementById('btn-zoom-receipt');
    if (!imgEl) return;
    this.receiptZoomed = !this.receiptZoomed;
    if (this.receiptZoomed) {
      imgEl.style.maxHeight = 'none';
      imgEl.style.width = '100%';
      imgEl.style.cursor = 'zoom-out';
      if (zoomBtn) zoomBtn.textContent = '🔎 Reducir zoom';
    } else {
      imgEl.style.maxHeight = '460px';
      imgEl.style.width = 'auto';
      imgEl.style.cursor = 'zoom-in';
      if (zoomBtn) zoomBtn.textContent = '🔍 Ampliar / Zoom';
    }
  },

  viewReceipt: function (studentId) {
    const student = this.students.find(s => s.id === studentId);
    if (!student || !student.receipt) return;

    this.activeStudentForApproval = student;
    this.receiptZoomed = false;
    document.getElementById('modal-receipt-title').textContent = `Comprobante Nequi: ${student.name}`;
    const fullUrl = `/api/admin/students/${student.id}/receipt?token=${encodeURIComponent(this.token)}&t=${Date.now()}`;
    const imgEl = document.getElementById('receipt-img');
    const errEl = document.getElementById('receipt-img-error');
    const openTabBtn = document.getElementById('btn-open-receipt-tab');
    const zoomBtn = document.getElementById('btn-zoom-receipt');

    if (errEl) errEl.style.display = 'none';
    if (imgEl) {
      imgEl.style.display = 'block';
      imgEl.style.maxHeight = '460px';
      imgEl.style.width = 'auto';
      imgEl.style.cursor = 'zoom-in';
      imgEl.src = fullUrl;
    }
    if (openTabBtn) openTabBtn.href = fullUrl;
    if (zoomBtn) zoomBtn.textContent = '🔍 Ampliar / Zoom';

    const metaEl = document.getElementById('receipt-meta');
    metaEl.innerHTML = `
      <div><strong>Alumno:</strong> ${student.name} (${student.email})</div>
      <div><strong>WhatsApp:</strong> ${student.whatsapp} | <strong>Doc:</strong> ${student.docType} ${student.docNumber}</div>
      <div><strong>Subido:</strong> ${new Date(student.receipt.uploadedAt).toLocaleString('es-CO')}</div>
      <div><strong>Referencia Nequi declarada:</strong> ${student.receipt.reference || 'Sin código digitado'}</div>
      <div><strong>Valor a verificar:</strong> $24.900 COP en cuenta Nequi 3158422894</div>
    `;

    const approveBtn = document.getElementById('btn-approve-from-receipt');
    if (student.paymentStatus === 'approved') {
      approveBtn.style.display = 'none';
    } else {
      approveBtn.style.display = 'inline-flex';
      approveBtn.onclick = () => {
        this.closeModal('modal-receipt');
        this.approveStudent(student.id);
      };
    }

    document.getElementById('modal-receipt').classList.add('active');
  },

  approveStudent: async function (studentId) {
    const student = this.students.find(s => s.id === studentId);
    const confirmName = student ? student.name : 'este alumno';
    if (!confirm(`¿Confirmas que verificaste el pago de $24.900 COP en Nequi para ${confirmName}? Se habilitará su acceso a las 7 lecciones.`)) {
      return;
    }

    try {
      const res = await this.api(`/api/admin/students/${studentId}/approve`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'No se pudo aprobar el alumno');
        return;
      }

      await this.refresh();
      this.showApprovedModal(studentId);
    } catch (err) {
      alert('Error aprobando al alumno');
    }
  },

  showApprovedModal: function (studentId) {
    const student = this.students.find(s => s.id === studentId);
    if (!student || !student.accessCode) return;

    document.getElementById('success-student-name').textContent = student.name;
    document.getElementById('success-access-code').textContent = student.accessCode;

    const origin = window.location.origin;
    const accessLink = `${origin}/?code=${encodeURIComponent(student.accessCode)}&email=${encodeURIComponent(student.email)}`;

    const waText = `¡Hola ${student.name}! 🎉 Confirmamos tu pago de $24.900 COP en Nequi para el curso *IA en 7 Días*.

Tu acceso ya está 100% activo:
🔑 Tu código de acceso: *${student.accessCode}*
🔗 Ingresa directamente aquí a tus clases:
${accessLink}

Recuerda: Son 7 lecciones prácticas de 15 minutos. Al completar cada día subes tu captura de pantalla y al finalizar se emite tu Certificado en PDF oficial. ¡Bienvenido!`;

    document.getElementById('success-whatsapp-message').textContent = waText;

    const cleanPhone = (student.whatsapp || '').replace(/\D/g, '');
    const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waText)}`;
    document.getElementById('btn-open-wa').href = waUrl;

    document.getElementById('modal-approved-success').classList.add('active');
  },

  copySuccessMessage: function () {
    const text = document.getElementById('success-whatsapp-message').textContent;
    navigator.clipboard.writeText(text).then(() => {
      alert('✓ Mensaje copiado al portapapeles. Listo para pegar en WhatsApp.');
    }).catch(() => {
      alert('No se pudo copiar automáticamente.');
    });
  },

  rejectStudent: async function (studentId) {
    const reason = prompt('Motivo del rechazo del comprobante (el alumno podrá ver este motivo para subir uno nuevo):', 'No se encontró la transferencia en Nequi por $24.900 COP o el comprobante está ilegible.');
    if (reason === null) return;

    try {
      const res = await this.api(`/api/admin/students/${studentId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || 'Error al rechazar');
        return;
      }
      this.refresh();
    } catch (err) {
      alert('Error al rechazar el comprobante');
    }
  },

  revokeStudent: async function (studentId) {
    if (!confirm('¿Seguro que deseas revocar el acceso a este alumno? Sus lecciones quedarán bloqueadas inmediatamente.')) return;
    try {
      await this.api(`/api/admin/students/${studentId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Acceso revocado por el administrador' })
      });
      this.refresh();
    } catch (e) {
      alert('Error revocando acceso');
    }
  },

  deleteStudent: async function (studentId) {
    if (!confirm('¿Seguro que deseas eliminar definitivamente este registro?')) return;
    try {
      await this.api(`/api/admin/students/${studentId}`, { method: 'DELETE' });
      this.refresh();
    } catch (e) {
      alert('Error eliminando alumno');
    }
  },

  viewEvidences: function (studentId) {
    const student = this.students.find(s => s.id === studentId);
    if (!student) return;

    document.getElementById('modal-evidences-title').textContent = `Evidencias de práctica: ${student.name}`;
    const container = document.getElementById('evidences-content');
    const lessons = student.evidenceLessons || [];

    if (!lessons.length) {
      container.innerHTML = `<p style="grid-column: span 2; color: var(--text-muted); text-align: center; padding: 2rem;">El alumno aún no ha subido capturas de práctica.</p>`;
    } else {
      container.innerHTML = lessons.map(num => `
        <div style="background: var(--bg-card); padding: 1rem; border-radius: 8px; border: 1px solid var(--border-hairline);">
          <strong style="color: var(--text-main); font-size: 0.9rem;">Día ${num}</strong>
          <div style="margin-top: 0.5rem; background: var(--bg-surface); border: 1px solid var(--border-hairline); border-radius: 4px; overflow: hidden;">
            <img src="/api/admin/students/${student.id}/evidence/${num}?token=${encodeURIComponent(AdminApp.token)}&t=${Date.now()}" alt="Evidencia Día ${num}" style="width: 100%; max-height: 220px; object-fit: contain; display: block;" onerror="this.parentElement.innerHTML='<p style=\'padding:1rem;color:var(--accent-red);font-size:0.8rem;text-align:center;\'>No se pudo cargar la imagen de evidencia</p>'">
          </div>
        </div>
      `).join('');
    }

    document.getElementById('modal-evidences').classList.add('active');
  },

  loadLessons: async function () {
    try {
      const res = await this.api('/api/admin/lessons');
      const lessons = await res.json();
      const container = document.getElementById('lessons-video-list');
      if (!container) return;

      container.innerHTML = lessons.map(l => {
        const currentUrl = l.video ? (l.video.provider === 'youtube' ? `https://youtube.com/watch?v=${l.video.id}` : `https://vimeo.com/${l.video.id}`) : '';
        return `
          <div style="background: var(--bg-card); padding: 0.85rem 1.25rem; border-radius: 6px; border: 1px solid var(--border-hairline); display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
            <div>
              <strong style="color: var(--text-main);">Día ${l.day}: ${l.title}</strong>
              <div style="font-size: 0.78rem; color: var(--text-dim);">${l.video ? `✓ Video configurado (${l.video.provider})` : 'Sin video (muestra guía de lectura y práctica)'}</div>
            </div>
            <div style="display: flex; gap: 0.5rem; flex: 1; max-width: 480px;">
              <input type="text" id="video-input-${l.id}" class="form-control" style="font-size: 0.8rem;" placeholder="https://youtube.com/watch?v=... (o dejar vacío)" value="${currentUrl}">
              <button class="btn btn-primary btn-sm" onclick="AdminApp.saveLessonVideo(${l.id})">Guardar</button>
            </div>
          </div>
        `;
      }).join('');
    } catch (e) {
      console.error('Error loading lessons for admin:', e);
    }
  },

  saveLessonVideo: async function (lessonId) {
    const input = document.getElementById(`video-input-${lessonId}`);
    const url = input.value.trim();

    try {
      const res = await this.api(`/api/admin/lessons/${lessonId}/video`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Enlace de video no válido');
        return;
      }
      alert('✓ Video actualizado para la lección.');
      this.loadLessons();
    } catch (e) {
      alert('Error guardando video');
    }
  },

  closeModal: function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => AdminApp.init());
} else {
  AdminApp.init();
}
