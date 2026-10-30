/**
 * IA EN 7 DÍAS - Lógica de Aplicación del Microcurso
 * 
 * Flujo:
 * 1. Registro con datos completos y Habeas Data (Ley 1581 de 2012).
 * 2. Pago exclusivo por Nequi al 3158422894 con subida de comprobante.
 * 3. Aprobación manual del administrador -> Código de acceso único.
 * 4. Ingreso al aula únicamente con pago aprobado.
 * 5. 7 lecciones prácticas en orden obligatorio (1→2→3→4→5→6→7) con subida de evidencia.
 * 6. Emisión y descarga de Certificado oficial en PDF solo al completar el 100%.
 */

const App = {
  state: {
    currentView: 'landing',
    token: null,
    activeStudent: null,
    currentLessonId: null,
    currentEvidenceImage: null,
    currentReceiptImage: null,
    surveyStep: 1,
    surveyAnswers: {},
    lessons: [],
    config: {
      nequiNumber: '3158422894',
      coursePriceCOP: 24900,
      supportWhatsApp: '3158422894'
    }
  },

  init: async function () {
    this.bindEvents();
    await this.fetchConfig();
    await this.fetchLessons();
    await this.checkUrlParamsForAccess();
    await this.restoreSession();
    this.handleInitialRouting();
  },

  // ==========================================
  // CONFIGURACIÓN Y SERVICIOS
  // ==========================================
  fetchConfig: async function () {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data = await res.json();
        this.state.config = { ...this.state.config, ...data };
        const nequiDisplay = document.getElementById('nequi-display-number');
        if (nequiDisplay) nequiDisplay.textContent = this.state.config.nequiNumber;
      }
    } catch (e) {
      console.warn("Usando configuración local por defecto:", e);
    }
  },

  fetchLessons: async function () {
    try {
      const res = await fetch('/api/lessons');
      if (res.ok) {
        this.state.lessons = await res.json();
        this.renderCurriculumOnLanding();
      }
    } catch (e) {
      console.error("Error al cargar temario:", e);
    }
  },

  /** Si el alumno llega desde el enlace de WhatsApp: /?code=ABCD-1234&email=juan@test.com */
  checkUrlParamsForAccess: async function () {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const email = params.get('email');

    if (code && email) {
      try {
        const res = await fetch('/api/student/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), code: code.trim() })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          this.state.token = data.token;
          this.state.activeStudent = data.student;
          localStorage.setItem('ia7d_token', data.token);
          localStorage.setItem('ia7d_last_view', 'dashboard');
          this.updateNavForStudent();
          this.showToast(`✓ ¡Bienvenido a tu aula, ${data.student.name}!`);
          // Limpiar URL sin recargar
          window.history.replaceState({}, document.title, window.location.pathname + '#dashboard');
          this.showView('dashboard');
        }
      } catch (err) {
        console.warn("No se pudo iniciar sesión con parámetros de URL:", err);
      }
    }
  },

  restoreSession: async function () {
    const savedToken = localStorage.getItem('ia7d_token');
    if (!savedToken) {
      this.updateNavForStudent();
      return;
    }

    try {
      const res = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${savedToken}` }
      });
      if (res.ok) {
        const student = await res.json();
        this.state.token = savedToken;
        this.state.activeStudent = student;
        this.updateNavForStudent();
      } else {
        localStorage.removeItem('ia7d_token');
        localStorage.removeItem('ia7d_last_view');
        localStorage.removeItem('ia7d_last_lesson');
        this.state.token = null;
        this.state.activeStudent = null;
        this.updateNavForStudent();
      }
    } catch (e) {
      console.warn("No se pudo restaurar la sesión:", e);
      this.updateNavForStudent();
    }
  },

  handleInitialRouting: function () {
    const student = this.state.activeStudent;
    const hash = window.location.hash.replace('#', '');

    if (student && student.paymentStatus === 'approved') {
      if (hash.startsWith('lesson-')) {
        const id = parseInt(hash.replace('lesson-', ''), 10);
        this.openLesson(id);
        return;
      }
      if (hash === 'dashboard') {
        this.showView('dashboard');
        return;
      }
      // Si el alumno aprobado entra a la raíz, recordar la última pantalla que estaba usando
      const lastView = localStorage.getItem('ia7d_last_view');
      const lastLesson = parseInt(localStorage.getItem('ia7d_last_lesson') || '0', 10);
      if (lastView === 'lesson' && lastLesson >= 1 && lastLesson <= 7) {
        this.openLesson(lastLesson);
        return;
      }
      this.showView('dashboard');
      return;
    }

    this.showView('landing');

    // Si el alumno ya está inscrito pero AÚN NO ha sido aprobado, mostrar su estado al entrar
    if (student && student.paymentStatus === 'in_review') {
      this.showReviewConfirmation(student);
    } else if (student && (student.paymentStatus === 'awaiting_payment' || student.paymentStatus === 'rejected')) {
      this.showNequiPaymentStep(student);
    }
  },

  // ==========================================
  // NAVEGACIÓN Y VISTAS
  // ==========================================
  showView: function (viewName) {
    // Si intenta ingresar al aula o a una lección sin pago aprobado, bloquear
    if ((viewName === 'dashboard' || viewName === 'lesson') && (!this.state.activeStudent || this.state.activeStudent.paymentStatus !== 'approved')) {
      if (this.state.activeStudent && this.state.activeStudent.paymentStatus === 'in_review') {
        this.showToast("⏳ Tu suscripción está esperando ser aprobada.");
        this.showReviewConfirmation(this.state.activeStudent);
      } else if (this.state.activeStudent && (this.state.activeStudent.paymentStatus === 'awaiting_payment' || this.state.activeStudent.paymentStatus === 'rejected')) {
        this.showNequiPaymentStep(this.state.activeStudent);
      } else {
        this.showToast("🔒 Acceso exclusivo para alumnos con pago aprobado.");
        this.showStudentAccessModal();
      }
      return;
    }

    this.state.currentView = viewName;
    if (viewName === 'dashboard' || viewName === 'lesson') {
      localStorage.setItem('ia7d_last_view', viewName);
    }
    window.location.hash = viewName === 'landing' ? '' : viewName;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    document.querySelectorAll('.app-view').forEach(el => el.style.display = 'none');
    const target = document.getElementById(`view-${viewName}`);
    if (target) {
      target.style.display = 'block';
    }

    if (viewName === 'dashboard') {
      this.renderDashboard();
    }
  },

  updateNavForStudent: function () {
    const student = this.state.activeStudent;
    const navActions = document.getElementById('nav-actions-container');
    const ctas = document.querySelectorAll('.btn-trigger-cta');
    const accessLinks = document.querySelectorAll('.btn-access-link');
    const stickyCta = document.querySelector('.sticky-mobile-cta');
    const priceTags = document.querySelectorAll('.hero-price-tag');

    if (student && student.paymentStatus === 'approved') {
      if (navActions) {
        navActions.innerHTML = `
          <button class="btn btn-primary btn-sm" onclick="App.showView('dashboard')">
            👤 Entrar a mi Aula (${student.progressPercentage || 0}%)
          </button>
          <button class="btn btn-secondary btn-sm" onclick="App.logoutStudent()">
            Salir
          </button>
        `;
      }
      ctas.forEach(btn => {
        btn.textContent = '🔑 ¿Ya tienes código de acceso aprobado? Ingresa aquí ➔';
      });
      accessLinks.forEach(el => {
        el.style.display = 'inline-flex';
        el.textContent = '🔑 ¿Ya tienes código de acceso aprobado? Ingresa aquí';
      });
      priceTags.forEach(el => { el.style.display = 'none'; });
      if (stickyCta) stickyCta.style.display = 'none';
      return;
    }

    if (student && student.paymentStatus === 'in_review') {
      if (navActions) {
        navActions.innerHTML = `
          <button class="btn btn-secondary btn-sm" onclick="App.showReviewConfirmation(App.state.activeStudent)">
            ⏳ Esperando aprobación
          </button>
          <button class="btn btn-secondary btn-sm" onclick="App.logoutStudent()" title="Cambiar de cuenta">
            Salir
          </button>
        `;
      }
      ctas.forEach(btn => {
        btn.textContent = '⏳ Tu suscripción está esperando ser aprobada';
      });
      accessLinks.forEach(el => { el.style.display = 'none'; });
      priceTags.forEach(el => { el.style.display = 'none'; });
      if (stickyCta) stickyCta.style.display = 'none';
      return;
    }

    if (student && (student.paymentStatus === 'awaiting_payment' || student.paymentStatus === 'rejected')) {
      if (navActions) {
        navActions.innerHTML = `
          <button class="btn btn-primary btn-sm" onclick="App.showNequiPaymentStep(App.state.activeStudent)">
            📤 Subir comprobante Nequi ➔
          </button>
          <button class="btn btn-secondary btn-sm" onclick="App.logoutStudent()" title="Cambiar de cuenta">
            Salir
          </button>
        `;
      }
      ctas.forEach(btn => {
        btn.textContent = '📤 Subir comprobante Nequi ($24.900 COP) ➔';
      });
      accessLinks.forEach(el => { el.style.display = 'none'; });
      priceTags.forEach(el => { el.style.display = ''; });
      if (stickyCta) stickyCta.style.display = '';
      return;
    }

    // Visitante nuevo (sin inscripción en este navegador)
    if (navActions) {
      navActions.innerHTML = `
        <button class="btn btn-secondary btn-sm btn-access-link" onclick="App.showStudentAccessModal()">
          🔑 Ingresar con código
        </button>
        <button class="btn btn-primary btn-sm btn-trigger-cta nav-cta-desktop" onclick="App.openSurveyModal()">
          Quiero mi certificado ➔
        </button>
      `;
    }
    ctas.forEach(btn => {
      if (!btn.dataset.origText) btn.dataset.origText = btn.textContent.trim();
      btn.textContent = btn.dataset.origText;
    });
    accessLinks.forEach(el => {
      el.style.display = 'inline-flex';
      el.textContent = '🔑 ¿Ya tienes código de acceso aprobado? Ingresa aquí';
    });
    priceTags.forEach(el => { el.style.display = ''; });
    if (stickyCta) stickyCta.style.display = '';
  },

  logoutStudent: function () {
    if (this.state.token) {
      fetch('/api/me/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      }).catch(() => { });
    }
    localStorage.removeItem('ia7d_token');
    localStorage.removeItem('ia7d_last_view');
    localStorage.removeItem('ia7d_last_lesson');
    this.state.token = null;
    this.state.activeStudent = null;
    this.updateNavForStudent();
    this.showView('landing');
    this.showToast("Sesión cerrada.");
  },

  bindEvents: function () {
    document.querySelectorAll('.btn-trigger-cta').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.openSurveyModal();
      });
    });

    // Acordeón de FAQ
    document.querySelectorAll('.faq-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = btn.parentElement;
        item.classList.toggle('open');
      });
    });
  },

  // ==========================================
  // TEMARIO EN LANDING
  // ==========================================
  dayMeta: {
    1: { icon: '🎯', chips: ['Método R-C-T-F', 'Prompt maestro', 'Evidencia obligatoria'] },
    2: { icon: '💬', chips: ['Clonación de estilo', 'Few-Shot Prompting', 'Iteración en 2 pasos'] },
    3: { icon: '✍️', chips: ['Fórmula PAS', 'Mensajes de cobro & venta', 'Cierre persuasivo'] },
    4: { icon: '📑', chips: ['Auditoría de PDFs', 'Fórmulas Excel en español', 'Habeas Data'] },
    5: { icon: '🎨', chips: ['Dirección de arte', 'Iluminación & planos', 'Imágenes sin defectos'] },
    6: { icon: '⚖️', chips: ['Abogado del diablo', 'Auditoría de riesgos', 'Detección de alucinaciones'] },
    7: { icon: '🏆', chips: ['Instrucciones personalizadas', 'Rutina de 3 tareas', '🎓 Certificado Oficial PDF'] }
  },

  renderCurriculumOnLanding: function () {
    const container = document.getElementById('landing-curriculum-list');
    if (!container || !this.state.lessons.length) return;

    container.innerHTML = this.state.lessons.map(l => {
      const meta = this.dayMeta[l.day] || { icon: '⚡', chips: ['Práctica guiada', 'Mini-quiz'] };
      return `
        <div class="curriculum-row">
          <div class="curriculum-row-left">
            <div class="curriculum-icon-badge">${meta.icon}</div>
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
                <span class="curriculum-day-tag">Día ${l.day}</span>
                <span style="font-size: 0.8rem; color: var(--text-dim);">⏱ ${l.duration || '15 min'}</span>
              </div>
              <div class="curriculum-text">
                <h4>${l.title}</h4>
                <p>${l.subtitle}</p>
                <div class="curriculum-chips-row">
                  ${meta.chips.map(c => `<span class="cur-chip">${c}</span>`).join('')}
                </div>
              </div>
            </div>
          </div>
          <div>
            <span class="pill pill-subtle" style="font-size: 0.75rem;">15 min</span>
          </div>
        </div>
      `;
    }).join('');
  },

  // ==========================================
  // CUESTIONARIO DIAGNÓSTICO (PRE-CHECKOUT)
  // ==========================================
  openSurveyModal: function () {
    if (this.state.activeStudent) {
      if (this.state.activeStudent.paymentStatus === 'approved') {
        this.showToast("✓ Ya tienes acceso activo a tu aula. No necesitas volver a pagar.");
        this.showView('dashboard');
        return;
      }
      if (this.state.activeStudent.paymentStatus === 'in_review') {
        this.showToast("⏳ Tu suscripción está esperando ser aprobada.");
        this.showReviewConfirmation(this.state.activeStudent);
        return;
      }
      if (this.state.activeStudent.paymentStatus === 'awaiting_payment' || this.state.activeStudent.paymentStatus === 'rejected') {
        this.showNequiPaymentStep(this.state.activeStudent);
        return;
      }
    }
    this.state.surveyStep = 1;
    this.state.surveyAnswers = {};
    document.getElementById('modal-survey').classList.add('active');
    this.renderSurveyStep();
  },

  surveyQuestions: [
    {
      id: "experience",
      step: 1,
      title: "¿Cuál es tu nivel actual con Inteligencia Artificial?",
      sub: "Orientaremos los ejemplos de las 7 lecciones a tu punto de partida:",
      options: [
        { label: "Principiante absoluto (nunca he usado ChatGPT ni herramientas de IA)", badge: "Cero experiencia" },
        { label: "He usado ChatGPT un poco para consultas básicas y curiosidad", badge: "Nivel inicial" },
        { label: "Uso IA en mi trabajo pero quiero métodos concretos y productividad real", badge: "Intermedio" }
      ]
    },
    {
      id: "goal",
      step: 2,
      title: "¿En qué área deseas ahorrar más tiempo esta misma semana?",
      sub: "Selecciona tu prioridad de aprendizaje:",
      options: [
        { label: "Redactar correos, mensajes comerciales de WhatsApp y cotizaciones", badge: "Comunicación" },
        { label: "Analizar documentos largos, contratos y fórmulas de Excel", badge: "Análisis & Datos" },
        { label: "Crear imágenes profesionales para redes, catálogo o presentaciones", badge: "Creatividad visual" },
        { label: "Automatizar mis tareas fijas de la semana con un asistente propio", badge: "Productividad" }
      ]
    },
    {
      id: "role",
      step: 3,
      title: "¿Cuál describe mejor tu actividad principal?",
      sub: "Para adaptar los casos de negocio colombianos:",
      options: [
        { label: "Independiente / Profesional de servicios (abogado, contador, diseñador, consultor)", badge: "Servicios" },
        { label: "Emprendedor / Comerciante con tienda física o digital", badge: "Comercio" },
        { label: "Empleado de oficina o administrativo en empresa", badge: "Corporativo" },
        { label: "Estudiante o docente universitario", badge: "Académico" }
      ]
    },
    {
      id: "time",
      step: 4,
      title: "¿Cuánto tiempo puedes dedicar al día durante 7 días?",
      sub: "El microcurso fue diseñado con lecciones directas:",
      options: [
        { label: "15 minutos exactos al día (desde computador o celular)", badge: "Ideal para el curso" },
        { label: "30 minutos (quiero hacer la práctica y probar varios ejercicios)", badge: "Ritmo intensivo" },
        { label: "Fin de semana (hacer varias lecciones juntas a mi ritmo)", badge: "Fin de semana" }
      ]
    }
  ],

  renderSurveyStep: function () {
    const current = this.surveyQuestions[this.state.surveyStep - 1];
    const body = document.getElementById('survey-body');
    if (!current || !body) return;

    body.innerHTML = `
      <div style="margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.78rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em;">
          Pregunta ${current.step} de 4
        </span>
        <span class="pill pill-subtle" style="font-size: 0.72rem;">Diagnóstico Rápido</span>
      </div>
      <h3 style="font-size: 1.25rem; margin-bottom: 0.4rem; color: #fff;">${current.title}</h3>
      <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1.25rem;">${current.sub}</p>

      <div style="display: flex; flex-direction: column; gap: 0.65rem;">
        ${current.options.map((opt, idx) => `
          <button class="quiz-option-item" onclick="App.selectSurveyAnswer('${current.id}', '${opt.label.replace(/'/g, "\\'")}')">
            <span style="color: var(--accent-cyan); font-weight: 700;">${idx + 1}.</span>
            <span style="flex: 1; text-align: left;">${opt.label}</span>
            <span class="pill pill-subtle" style="font-size: 0.75rem;">${opt.badge}</span>
          </button>
        `).join('')}
      </div>
    `;
  },

  selectSurveyAnswer: function (questionId, answer) {
    this.state.surveyAnswers[questionId] = answer;
    this.state.surveyStep++;
    if (this.state.surveyStep <= this.surveyQuestions.length) {
      this.renderSurveyStep();
    } else {
      this.showSurveyResult();
    }
  },

  showSurveyResult: function () {
    const body = document.getElementById('survey-body');
    const role = this.state.surveyAnswers.role || 'Profesional';
    const goal = this.state.surveyAnswers.goal || 'Productividad con IA';

    body.innerHTML = `
      <div style="text-align: center; padding: 1rem 0;">
        <span class="pill pill-green" style="margin-bottom: 0.85rem;">✓ Diagnóstico completado</span>
        <h3 style="font-size: 1.35rem; margin-bottom: 0.5rem; color: #fff;">
          Ruta Práctica para ${role}
        </h3>
        <p style="color: var(--text-muted); font-size: 0.92rem; line-height: 1.6; margin-bottom: 1.5rem;">
          Con las 7 lecciones de 15 minutos dominarás la aplicación de IA en <strong>${goal}</strong>, subiendo capturas de tus prácticas reales y emitiendo tu Certificado Oficial en PDF de 15 horas.
        </p>

        <div style="background: var(--bg-card); border: 1px solid var(--border-hairline); border-radius: var(--radius-sm); padding: 1.25rem; margin-bottom: 1.75rem; text-align: left;">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <span style="color: var(--text-muted); font-size: 0.9rem;">Inversión única (Pago Nequi):</span>
            <strong style="font-size: 1.5rem; color: #ff007f;">$24.900 COP</strong>
          </div>
          <div style="font-size: 0.8rem; color: var(--accent-green); margin-top: 0.35rem;">
            Pago único por Nequi • Acceso de por vida • Certificado incluido
          </div>
        </div>

        <button class="btn btn-primary btn-lg btn-block" onclick="App.proceedToCheckoutFromSurvey()">
          Continuar a la Inscripción ($24.900 COP) ➔
        </button>
      </div>
    `;
  },

  proceedToCheckoutFromSurvey: function () {
    this.closeAllModals();
    this.openCheckoutModal();
  },

  // ==========================================
  // CHECKOUT Y PAGO SOLO NEQUI (REQUISITOS 1 Y 6)
  // ==========================================
  openCheckoutModal: function () {
    if (this.state.activeStudent) {
      if (this.state.activeStudent.paymentStatus === 'approved') {
        this.showToast("✓ Ya tienes acceso activo a tu aula. No necesitas volver a pagar.");
        this.showView('dashboard');
        return;
      }
      if (this.state.activeStudent.paymentStatus === 'in_review') {
        this.showToast("⏳ Tu suscripción está esperando ser aprobada.");
        this.showReviewConfirmation(this.state.activeStudent);
        return;
      }
      if (this.state.activeStudent.paymentStatus === 'awaiting_payment' || this.state.activeStudent.paymentStatus === 'rejected') {
        this.showNequiPaymentStep(this.state.activeStudent);
        return;
      }
    }

    this.closeAllModals();
    this.state.currentReceiptImage = null;

    // Resetear a Paso 1
    document.getElementById('checkout-step-form').style.display = 'block';
    document.getElementById('checkout-step-nequi').style.display = 'none';
    document.getElementById('checkout-step-review').style.display = 'none';

    document.getElementById('checkout-modal-title').textContent = "Inscripción y Pago Nequi";
    document.getElementById('checkout-modal-sub').textContent = "Paso 1 de 2: Datos de registro y certificado";

    document.getElementById('modal-checkout').classList.add('active');
  },

  handleRegistrationSubmit: async function (e) {
    e.preventDefault();

    const name = document.getElementById('checkout-name').value.trim();
    const docType = document.getElementById('checkout-doctype').value;
    const docNumber = document.getElementById('checkout-docnumber').value.trim();
    const email = document.getElementById('checkout-email').value.trim().toLowerCase();
    const whatsapp = document.getElementById('checkout-whatsapp').value.trim();
    const consent = document.getElementById('checkout-consent').checked;

    if (!consent) {
      alert("Debes autorizar el tratamiento de datos personales conforme a la Ley 1581 de 2012 para inscribirte.");
      return;
    }

    const btn = document.getElementById('btn-submit-registration');
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Validando registro...";

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          docType,
          docNumber,
          email,
          whatsapp,
          consent: true,
          surveyAnswers: this.state.surveyAnswers
        })
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        if (data.alreadyApproved) {
          alert(data.error || "Este correo ya cuenta con acceso aprobado. Ingresa con tu código de acceso.");
          this.closeAllModals();
          this.showStudentAccessModal();
          const emailInput = document.getElementById('access-email');
          if (emailInput) emailInput.value = email;
          return;
        }
        if (data.inReview) {
          alert(data.error || "Tu suscripción está esperando ser aprobada. No necesitas realizar otro pago.");
          this.closeAllModals();
          return;
        }
        if (data.fields) {
          const firstErr = Object.values(data.fields)[0];
          alert(firstErr);
        } else {
          alert(data.error || "No se pudo procesar la inscripción.");
        }
        btn.disabled = false;
        btn.innerHTML = originalText;
        return;
      }

      // Guardar token emitido
      this.state.token = data.token;
      this.state.activeStudent = data.student;
      localStorage.setItem('ia7d_token', data.token);
      this.updateNavForStudent();

      // Si ya estaba en revisión o aprobado
      if (data.student.paymentStatus === 'approved') {
        this.closeAllModals();
        this.showToast("✓ Tu pago ya está aprobado. ¡Bienvenido a tu aula!");
        this.showView('dashboard');
        return;
      }

      if (data.student.paymentStatus === 'in_review') {
        this.showReviewConfirmation(data.student);
        return;
      }

      // Transición al Paso 2: Pago por Nequi (sin redirección automática)
      this.showNequiPaymentStep(data.student);

    } catch (err) {
      console.error("Registration error:", err);
      alert("Error de conexión. Inténtalo de nuevo.");
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  },

  showNequiPaymentStep: function (student) {
    this.closeAllModals();
    document.getElementById('modal-checkout').classList.add('active');
    document.getElementById('checkout-step-form').style.display = 'none';
    document.getElementById('checkout-step-nequi').style.display = 'block';
    document.getElementById('checkout-step-review').style.display = 'none';

    document.getElementById('checkout-modal-title').textContent = "Paso 2: Paga $24.900 COP por Nequi";
    document.getElementById('checkout-modal-sub').textContent = "Transfiere al 3158422894 y sube tu comprobante en esta misma pantalla";

    const rejectNotice = document.getElementById('checkout-rejection-notice');
    if (rejectNotice) {
      if (student && student.paymentStatus === 'rejected' && student.rejectionReason) {
        rejectNotice.style.display = 'block';
        rejectNotice.innerHTML = `<strong>Comprobante anterior rechazado:</strong> ${this.escapeHtml(student.rejectionReason)}. Por favor adjunta una captura clara de tu transferencia Nequi.`;
      } else {
        rejectNotice.style.display = 'none';
      }
    }

    // Copiar el número al portapapeles como ayuda, SIN abrir ni redirigir a Nequi automáticamente
    this.copyNequiNumber(true);
  },

  copyToClipboard: function (text) {
    if (!text) return Promise.reject(new Error("Texto vacío"));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return Promise.resolve();
    } catch (err) {
      document.body.removeChild(textarea);
      return Promise.reject(err);
    }
  },

  handleNequiSingleClick: async function () {
    const num = this.state.config.nequiNumber || '3158422894';
    try {
      await this.copyToClipboard(num);
      this.showToast(`📱 Número Nequi ${num} copiado. Abriendo Nequi...`);
    } catch (e) {
      this.showToast(`📱 Transfiere al Nequi: ${num}`);
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      window.location.href = 'nequi://';
      setTimeout(() => {
        window.open('https://recarga.nequi.com.co', '_blank');
      }, 1200);
    } else {
      window.open('https://recarga.nequi.com.co', '_blank');
    }
  },

  copyNequiNumber: function (isAuto = false) {
    const num = this.state.config.nequiNumber || '3158422894';
    this.copyToClipboard(num).then(() => {
      this.showToast(isAuto ? `📱 Número Nequi ${num} copiado automáticamente` : `✓ Número Nequi ${num} copiado al portapapeles`);
    }).catch(() => { });
  },

  openNequiApp: function () {
    this.handleNequiSingleClick();
  },

  attemptAutoOpenNequi: function () {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobile) {
      setTimeout(() => {
        window.location.href = 'nequi://';
      }, 800);
    }
  },

  handleReceiptFileSelected: function (e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert("Por favor selecciona una captura de pantalla en formato imagen (PNG, JPG o WebP).");
      return;
    }

    if (file.size > 6 * 1024 * 1024) {
      alert("La imagen no debe pesar más de 6 MB.");
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      this.state.currentReceiptImage = ev.target.result;
      const previewWrap = document.getElementById('receipt-preview-wrap');
      const previewImg = document.getElementById('receipt-preview-img');
      const filenameEl = document.getElementById('receipt-filename');

      if (previewWrap && previewImg) {
        previewImg.src = ev.target.result;
        filenameEl.textContent = file.name;
        previewWrap.style.display = 'flex';
      }
      this.showToast("✓ Comprobante seleccionado. Ya puedes enviarlo.");
    };
    reader.readAsDataURL(file);
  },

  handleReceiptSubmit: async function (e) {
    e.preventDefault();

    if (!this.state.currentReceiptImage) {
      alert("Debes seleccionar la captura de pantalla de tu comprobante de Nequi.");
      return;
    }

    if (!this.state.token) {
      alert("Sesión no válida. Por favor completa tus datos de registro primero.");
      this.openCheckoutModal();
      return;
    }

    const reference = document.getElementById('receipt-reference').value.trim();
    const btn = document.getElementById('btn-submit-receipt');
    btn.disabled = true;
    btn.innerHTML = "Subiendo comprobante de Nequi...";

    try {
      const res = await fetch('/api/me/receipt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.state.token}`
        },
        body: JSON.stringify({
          image: this.state.currentReceiptImage,
          reference
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "No se pudo subir el comprobante.");
        btn.disabled = false;
        btn.innerHTML = "📤 Subir Comprobante y Enviar a Revisión ➔";
        return;
      }

      this.state.activeStudent = data.student;
      this.updateNavForStudent();
      this.showReviewConfirmation(data.student);

    } catch (err) {
      console.error("Receipt upload error:", err);
      alert("Error al enviar comprobante. Verifica tu conexión.");
    } finally {
      btn.disabled = false;
      btn.innerHTML = "📤 Enviar Inscripción con Comprobante ➔";
    }
  },

  showReviewConfirmation: function (student) {
    this.closeAllModals();
    document.getElementById('modal-checkout').classList.add('active');
    document.getElementById('checkout-step-form').style.display = 'none';
    document.getElementById('checkout-step-nequi').style.display = 'none';
    document.getElementById('checkout-step-review').style.display = 'block';

    document.getElementById('checkout-modal-title').textContent = "Tu suscripción está esperando ser aprobada";
    document.getElementById('checkout-modal-sub').textContent = "Verificación manual en proceso";

    document.getElementById('review-student-name').textContent = student.name || '-';
    document.getElementById('review-student-whatsapp').textContent = student.whatsapp || student.email || '-';

    const waText = encodeURIComponent(`Hola, acabo de subir mi comprobante de Nequi de $24.900 COP para el curso IA en 7 Días. Mi nombre es ${student.name} (${student.email}). Quedo atento a mi código de acceso.`);
    document.getElementById('review-wa-support-btn').href = `https://wa.me/573158422894?text=${waText}`;
  },

  checkApprovalStatus: async function () {
    if (!this.state.token) return;
    try {
      const res = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      if (!res.ok) return;
      const student = await res.json();
      this.state.activeStudent = student;
      this.updateNavForStudent();
      if (student.paymentStatus === 'approved') {
        this.closeAllModals();
        this.showToast("🎉 ¡Tu suscripción ya fue aprobada! Bienvenido al aula.");
        this.showView('dashboard');
      } else if (student.paymentStatus === 'rejected') {
        this.showToast("⚠️ Tu comprobante requiere revisión. Por favor sube uno nuevo.");
        this.showNequiPaymentStep(student);
      } else {
        this.showToast("⏳ Tu suscripción sigue esperando ser aprobada por el administrador.");
      }
    } catch (e) {
      this.showToast("No se pudo verificar el estado en este momento.");
    }
  },

  // ==========================================
  // INGRESO SEGURO DE ALUMNOS (REQUISITO 3)
  // ==========================================
  showStudentAccessModal: function () {
    if (this.state.activeStudent && this.state.activeStudent.paymentStatus === 'approved') {
      this.closeAllModals();
      this.showView('dashboard');
      return;
    }
    this.closeAllModals();
    document.getElementById('access-error').style.display = 'none';
    const emailInput = document.getElementById('access-email');
    if (emailInput && this.state.activeStudent && this.state.activeStudent.email) {
      emailInput.value = this.state.activeStudent.email;
    }
    document.getElementById('modal-student-access').classList.add('active');
  },

  handleStudentAccessWithCode: async function (e) {
    e.preventDefault();
    const email = document.getElementById('access-email').value.trim();
    const code = document.getElementById('access-code').value.trim();
    const errEl = document.getElementById('access-error');
    const btn = document.getElementById('btn-submit-access');

    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Verificando acceso...';

    try {
      const res = await fetch('/api/student/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        errEl.textContent = data.error || 'Correo o código de acceso no válidos.';
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Ingresar a mi Aula ➔';
        return;
      }

      this.state.token = data.token;
      this.state.activeStudent = data.student;
      localStorage.setItem('ia7d_token', data.token);
      localStorage.setItem('ia7d_last_view', 'dashboard');

      this.updateNavForStudent();
      this.closeAllModals();
      this.showToast(`✓ ¡Bienvenido de nuevo, ${data.student.name}!`);
      this.showView('dashboard');

    } catch (err) {
      console.error("Login error:", err);
      errEl.textContent = 'Error de conexión. Inténtalo de nuevo.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Ingresar a mi Aula ➔';
    }
  },

  // ==========================================
  // AULA VIRTUAL (ORDEN OBLIGATORIO Y REGLAS)
  // ==========================================
  renderDashboard: async function () {
    const student = this.state.activeStudent;
    if (!student || student.paymentStatus !== 'approved') {
      this.showStudentAccessModal();
      return;
    }

    // Sincronizar estado actualizado desde backend
    try {
      const res = await fetch('/api/me', {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      if (res.ok) {
        this.state.activeStudent = await res.json();
      } else if (res.status === 401 || res.status === 403) {
        this.logoutStudent();
        return;
      }
    } catch (e) {
      console.warn("No se pudo sincronizar avance:", e);
    }

    const current = this.state.activeStudent;
    const completed = current.completedLessons || [];
    const completedCount = completed.length;
    const totalCount = this.state.lessons.length || 7;
    const progressPct = current.progressPercentage || Math.round((completedCount / totalCount) * 100);
    const isCertUnlocked = completedCount >= totalCount && current.certificateUnlocked;

    // Encabezado
    const nameEl = document.getElementById('dash-student-name');
    const emailEl = document.getElementById('dash-student-email');
    if (nameEl) nameEl.textContent = current.name;
    if (emailEl) emailEl.textContent = current.email;

    // Barra de Progreso
    const pctEl = document.getElementById('dash-progress-pct');
    const countEl = document.getElementById('dash-progress-count');
    const fillEl = document.getElementById('dash-progress-fill');
    if (pctEl) pctEl.textContent = `${progressPct}%`;
    if (countEl) countEl.textContent = `${completedCount} de ${totalCount} lecciones completadas en orden`;
    if (fillEl) fillEl.style.width = `${progressPct}%`;

    // Banner del Certificado (REQUISITO 2: Solo si cumplió el progreso real del 100%)
    const certBanner = document.getElementById('dash-cert-banner');
    if (certBanner) {
      if (isCertUnlocked) {
        certBanner.className = 'cert-card-banner unlocked';
        certBanner.innerHTML = `
          <div style="display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;">
            <img src="images/logo-crop.png" alt="IA en 7 Días" class="official-logo-img logo-lg">
            <div>
              <span class="pill pill-gold" style="margin-bottom: 0.35rem;">Certificado Oficial Desbloqueado</span>
              <h3 style="font-size: 1.25rem; color: #fff;">¡Felicitaciones! Tu Certificado en PDF está Listo</h3>
              <p style="color: var(--text-muted); font-size: 0.88rem;">
                Completaste las 7 lecciones con sus evidencias aprobadas. Código de verificación: <strong>${current.certificateCode}</strong>
              </p>
            </div>
          </div>
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button class="btn btn-gold btn-md" onclick="App.downloadCertificate()">
              📥 Descargar Certificado Oficial (PDF 300 DPI)
            </button>
          </div>
        `;
      } else {
        const needed = totalCount - completedCount;
        certBanner.className = 'cert-card-banner locked';
        certBanner.innerHTML = `
          <div style="display: flex; align-items: center; gap: 1.25rem; flex-wrap: wrap;">
            <img src="images/logo-crop.png" alt="IA en 7 Días" class="official-logo-img logo-lg" style="opacity: 0.85;">
            <div>
              <span class="pill pill-subtle" style="margin-bottom: 0.35rem;">Certificado Protegido</span>
              <h3 style="font-size: 1.15rem; color: #fff;">Desbloqueo exclusivo al completar el 100% (7 lecciones)</h3>
              <p style="color: var(--text-dim); font-size: 0.85rem;">
                Te faltan <strong>${needed} lección${needed === 1 ? '' : 'es'}</strong> con evidencia de práctica para emitir tu certificado oficial.
              </p>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="App.continueNextLesson()">
            Continuar Lección Siguiente ➔
          </button>
        `;
      }
    }

    // Grid de 7 Lecciones con Bloqueo Estricto Secuencial 1->2->3->4->5->6->7
    const grid = document.getElementById('dash-lessons-grid');
    if (grid) {
      grid.innerHTML = this.state.lessons.map(l => {
        const lessonNum = Number(l.id);
        const isCompleted = completed.includes(lessonNum);
        const meta = this.dayMeta[l.day] || { icon: '⚡' };

        // Orden obligatorio estricto
        const isUnlocked = lessonNum === 1 || completed.includes(lessonNum - 1);
        const isNext = isUnlocked && !isCompleted;

        let cardClass = 'lesson-item-card';
        let statusBadge = '';
        let actionBtn = '';

        if (isCompleted) {
          cardClass += ' completed';
          statusBadge = `<span class="pill pill-green">✓ Completada</span>`;
          actionBtn = `<button class="btn btn-secondary btn-sm btn-block" onclick="App.openLesson(${l.id})">Repasar Lección</button>`;
        } else if (isNext) {
          cardClass += ' in-progress';
          statusBadge = `<span class="pill pill-blue">En curso</span>`;
          actionBtn = `<button class="btn btn-primary btn-sm btn-block" onclick="App.openLesson(${l.id})">Comenzar Lección ➔</button>`;
        } else {
          cardClass += ' locked';
          statusBadge = `<span class="pill pill-subtle">🔒 Bloqueada</span>`;
          actionBtn = `<button class="btn btn-secondary btn-sm btn-block" disabled title="Completa el Día ${lessonNum - 1} primero">Bloqueada</button>`;
        }

        return `
          <div class="${cardClass}">
            <div>
              <div class="lesson-card-header">
                <div style="display: flex; align-items: center; gap: 0.6rem;">
                  <span class="curriculum-icon-badge" style="width: 32px; height: 32px; font-size: 1rem;">${meta.icon}</span>
                  <span class="curriculum-day-tag">Día ${l.day}</span>
                </div>
                ${statusBadge}
              </div>
              <h4>${l.title}</h4>
              <p>${l.subtitle}</p>
            </div>
            <div>
              <div style="font-size: 0.8rem; color: var(--text-dim); margin-bottom: 0.75rem;">
                ⏱ ${l.duration || '15 min'} • Requiere captura de práctica
              </div>
              ${actionBtn}
            </div>
          </div>
        `;
      }).join('');
    }
  },

  continueNextLesson: function () {
    const student = this.state.activeStudent;
    if (!student) return;
    const completed = student.completedLessons || [];
    const next = this.state.lessons.find(l => !completed.includes(Number(l.id)));
    if (next) {
      this.openLesson(next.id);
    } else {
      this.openLesson(1);
    }
  },

  // ==========================================
  // PANTALLA DE LECCIÓN (REQUISITOS 4 Y 5)
  // ==========================================
  openLesson: async function (lessonId) {
    const student = this.state.activeStudent;
    if (!student || student.paymentStatus !== 'approved') {
      this.showStudentAccessModal();
      return;
    }

    const numLessonId = Number(lessonId);
    const completed = student.completedLessons || [];

    // Validar orden obligatorio
    if (numLessonId > 1 && !completed.includes(numLessonId - 1)) {
      alert(`🔒 Esta lección está bloqueada. Debes completar primero el Día ${numLessonId - 1} con su evidencia de práctica.`);
      this.showView('dashboard');
      return;
    }

    this.state.currentLessonId = numLessonId;
    this.state.currentEvidenceImage = null;
    localStorage.setItem('ia7d_last_view', 'lesson');
    localStorage.setItem('ia7d_last_lesson', String(numLessonId));
    window.location.hash = `lesson-${lessonId}`;

    try {
      const res = await fetch(`/api/me/lessons/${lessonId}`, {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });

      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "No se pudo cargar la lección.");
        this.showView('dashboard');
        return;
      }

      const lesson = await res.json();
      this.renderLessonView(lesson);
      this.showView('lesson');

    } catch (err) {
      console.error("Error opening lesson:", err);
      alert("Error al cargar la lección. Revisa tu conexión.");
    }
  },

  renderLessonView: function (lesson) {
    this.state.currentLesson = lesson;
    const container = document.getElementById('lesson-content-area');
    const student = this.state.activeStudent;
    const isCompleted = student && student.completedLessons && student.completedLessons.includes(Number(lesson.id));
    const existingEvidence = student && student.evidence && student.evidence[lesson.id];

    // Requisito 5: Manejo de Video limpio sin botones rotos
    let videoMarkup = '';
    if (lesson.video && lesson.video.provider) {
      const embedUrl = lesson.video.provider === 'youtube'
        ? `https://www.youtube-nocookie.com/embed/${lesson.video.id}`
        : `https://player.vimeo.com/video/${lesson.video.id}`;
      videoMarkup = `
        <div style="aspect-ratio: 16/9; background: #000; border-radius: var(--radius-md); overflow: hidden; margin-bottom: 2rem; border: 1px solid var(--border-hairline);">
          <iframe src="${embedUrl}" style="width: 100%; height: 100%; border: none;" allowfullscreen></iframe>
        </div>
      `;
    } else {
      videoMarkup = `
        <div class="video-module-box">
          <div class="icon-box">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
          </div>
          <div>
            <h4>Modalidad: Guía de Lectura Rápida y Práctica Interactiva (15 min)</h4>
            <p>
              Esta lección está diseñada para lectura y ejecución directa en tu cuenta de IA. Espacio preparado para la cápsula audiovisual oficial sin botones rotos ni material externo no verificado.
            </p>
          </div>
        </div>
      `;
    }

    const completedList = (student && student.completedLessons) || [];
    const stepNodes = [1, 2, 3, 4, 5, 6, 7].map(d => {
      const isDone = completedList.includes(d);
      const isCur = d === Number(lesson.day);
      let cls = 'progress-pill-node';
      let icon = d;
      if (isDone) {
        cls += ' completed';
        icon = '✓';
      } else if (isCur) {
        cls += ' current';
      }
      return `<div class="${cls}"><span>Día ${d}</span> <strong>${icon}</strong></div>`;
    }).join('');

    // Requisito 4: Estructura clara y humana:
    // 1) Objetivo (1 línea)
    // 2) Explicación corta y clara
    // 3) Ejemplo real (con botón de copiar el prompt ejemplo)
    // 4) Paso a paso de qué hacer
    // 5) Práctica (con botón de copiar la plantilla)
    // 6) Subida de captura
    // 7) Mini-quiz (opciones de selección múltiple 100% funcionales)
    // 8) Mini cierre / tip

    container.innerHTML = `
      <div class="lesson-page-wrap">
        <div class="lesson-top-nav">
          <button class="btn btn-secondary btn-sm" onclick="App.showView('dashboard')">
            ← Volver al Aula
          </button>
          <div style="display: flex; align-items: center; gap: 0.75rem;">
            <span class="curriculum-day-tag">Día ${lesson.day} de 7</span>
            <span style="font-size: 0.85rem; color: var(--text-dim);">⏱ ${lesson.duration || '15 min'}</span>
            ${isCompleted ? `<span class="pill pill-green">✓ Completada</span>` : ''}
          </div>
        </div>

        <div class="lesson-progress-pills">
          ${stepNodes}
        </div>

        <div style="margin-bottom: 2rem;">
          <h1 style="font-size: clamp(1.45rem, 5vw, 2.1rem); margin-bottom: 0.4rem;">${lesson.title}</h1>
          <p style="font-size: 1rem; color: var(--text-muted);">${lesson.subtitle}</p>
        </div>

        ${videoMarkup}

        <div class="lesson-article">
          <!-- 1. OBJETIVO DE LA LECCIÓN (1 línea destacada) -->
          <div style="background: rgba(14, 165, 233, 0.08); border-left: 4px solid var(--accent-cyan); border-radius: var(--radius-sm); padding: 1rem 1.25rem; margin-bottom: 2rem;">
            <div style="font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: var(--accent-cyan); letter-spacing: 0.08em; margin-bottom: 0.25rem;">Objetivo de la sesión</div>
            <p style="color: #fff; font-size: 1rem; font-weight: 600; margin: 0;">${lesson.objective}</p>
          </div>

          <!-- 2. EXPLICACIÓN CORTA Y CLARA -->
          <div style="font-size: 1.02rem; line-height: 1.7; margin-bottom: 2rem;">
            ${lesson.explanation}
          </div>

          <!-- 3. EJEMPLO REAL (CONTEXTO, ANTES, DESPUÉS CON BOTÓN COPIAR, POR QUÉ) -->
          ${lesson.example ? `
            <div class="lesson-example-card">
              <span class="pill pill-gold" style="font-size: 0.75rem;">Caso Práctico Real</span>
              <p style="font-size: 0.92rem; color: #fff; margin: 0.65rem 0 0.85rem;"><strong>Situación:</strong> ${lesson.example.context}</p>

              <div class="example-diff-grid">
                <div class="diff-box before">
                  <div style="font-size: 0.72rem; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; color: #f87171; margin-bottom: 0.35rem;">✕ Pedido Débil / Genérico</div>
                  <p style="margin: 0; font-style: italic;">"${lesson.example.before}"</p>
                </div>
                <div class="diff-box after">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
                    <span style="font-size: 0.72rem; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; color: #34d399;">✓ Pedido con Método Concreto</span>
                    <button type="button" class="btn btn-secondary btn-sm" style="font-size: 0.72rem; padding: 0.2rem 0.55rem;" onclick="App.copyPrompt('example', this)">
                      📋 Copiar Prompt
                    </button>
                  </div>
                  <p id="example-prompt-text" style="margin: 0;">"${this.escapeHtml(lesson.example.after)}"</p>
                </div>
              </div>

              <div style="font-size: 0.85rem; color: var(--text-dim); margin-top: 0.75rem;">
                💡 <strong>Por qué funciona:</strong> ${lesson.example.why}
              </div>
            </div>
          ` : ''}

          <!-- 4. PASO A PASO DE QUÉ HACER -->
          ${lesson.steps && lesson.steps.length ? `
            <div style="margin: 2rem 0;">
              <h3 style="font-size: 1.25rem; margin-bottom: 0.85rem;">Paso a paso de lo que debes hacer:</h3>
              <ol class="steps-ordered-list">
                ${lesson.steps.map(s => `<li>${s}</li>`).join('')}
              </ol>
            </div>
          ` : ''}

          <!-- 5. PRÁCTICA CON PROMPT PARA COPIAR -->
          ${lesson.practice ? `
            <div style="margin-top: 2.5rem; border-top: 1px solid var(--border-hairline); padding-top: 2rem;">
              <h3 style="font-size: 1.25rem;">🛠️ ${lesson.practice.title}</h3>
              <p style="font-size: 0.95rem; color: var(--text-muted); margin-bottom: 1rem;">${lesson.practice.instruction}</p>

              <div class="prompt-container">
                <div class="prompt-top">
                  <span>PLANTILLA DE PROMPT PARA COPIAR</span>
                  <button type="button" class="btn btn-secondary btn-sm" onclick="App.copyPrompt('practice', this)">
                    📋 Copiar Prompt
                  </button>
                </div>
                <pre id="practice-prompt-pre">${this.escapeHtml(lesson.practice.promptTemplate)}</pre>
              </div>
            </div>
          ` : ''}

          <!-- 6. SUBIDA OBLIGATORIA DE CAPTURA DE PRÁCTICA -->
          <div class="evidence-section" style="margin-top: 2.5rem;">
            <div class="evidence-header">
              <span style="font-size: 1.4rem;">📸</span>
              <div>
                <h4 style="margin: 0;">Captura de Evidencia de tu Práctica (Obligatoria)</h4>
                <p style="font-size: 0.82rem; color: var(--text-dim); margin: 0.2rem 0 0;">
                  ${lesson.practice && lesson.practice.evidenceHint ? lesson.practice.evidenceHint : 'Adjunta una captura donde se aprecie tu práctica con la IA.'}
                </p>
              </div>
            </div>

            <div class="evidence-upload-zone" onclick="document.getElementById('evidence-file-input').click()">
              <input type="file" id="evidence-file-input" accept="image/png,image/jpeg,image/webp" style="display: none;" onchange="App.handleEvidenceFileSelected(event)">
              <div style="font-size: 1.8rem; margin-bottom: 0.5rem;">📁</div>
              <strong style="color: #fff; font-size: 0.95rem;">Toca aquí para adjuntar la captura de pantalla</strong>
              <p style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.25rem;">Formatos admitidos: PNG, JPG o WebP</p>
            </div>

            <!-- Vista previa de evidencia con token autenticado -->
            <div id="evidence-preview-container" style="${existingEvidence ? 'display: flex;' : 'display: none;'}" class="evidence-preview-box">
              <img id="evidence-preview-img" class="evidence-thumbnail" src="${existingEvidence ? `/api/me/evidence/${lesson.id}?token=${encodeURIComponent(this.state.token)}` : ''}" alt="Evidencia">
              <div style="flex: 1;">
                <span class="pill pill-green" style="font-size: 0.75rem;">✓ Evidencia lista</span>
                <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.25rem;">Captura registrada para validar el avance.</div>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="document.getElementById('evidence-file-input').click()">
                Cambiar foto
              </button>
            </div>
          </div>

          <!-- 7. MINI QUIZ INTERACTIVO FORMATIVO (Opción múltiple sin errores de sintaxis) -->
          ${lesson.quiz && lesson.quiz.length ? `
            <div class="quiz-wrapper" style="margin-top: 2.5rem;">
              <span class="pill pill-gold" style="margin-bottom: 0.75rem;">Mini Quiz de Consolidación</span>
              <div id="quiz-container">
                ${lesson.quiz.map((q, qIdx) => `
                  <div style="margin-bottom: 1.5rem;" id="quiz-q-${qIdx}">
                    <p style="font-weight: 600; font-size: 1rem; margin-bottom: 0.75rem;">${qIdx + 1}. ${this.escapeHtml(q.question)}</p>
                    <div>
                      ${q.options.map((opt, optIdx) => `
                        <div class="quiz-option-item" id="quiz-opt-${qIdx}-${optIdx}" onclick="App.handleQuizAnswer(${qIdx}, ${optIdx})">
                          <span style="font-weight: 700; width: 22px; color: var(--text-dim);">${String.fromCharCode(65 + optIdx)})</span>
                          <span>${this.escapeHtml(opt)}</span>
                        </div>
                      `).join('')}
                    </div>
                    <div id="quiz-feedback-${qIdx}" style="display: none; padding: 0.85rem; border-radius: var(--radius-sm); font-size: 0.88rem; margin-top: 0.75rem;"></div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <!-- 8. MINI CIERRE / TIP DE ORO -->
          ${lesson.closingTip ? `
            <div class="closing-tip-card">
              <span style="font-size: 1.8rem;">💡</span>
              <div>
                <strong style="color: var(--accent-gold-soft); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; display: block; margin-bottom: 0.25rem;">Tip de Oro para el día a día</strong>
                <p style="color: var(--text-main); font-size: 0.92rem; margin: 0; line-height: 1.5;">${lesson.closingTip}</p>
              </div>
            </div>
          ` : ''}

          <!-- Botón Marcar Completada -->
          <div style="margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border-hairline); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;">
            <div>
              <p style="font-size: 0.85rem; color: var(--text-dim); margin: 0;">
                Se guardará tu captura de pantalla y se desbloqueará el Día ${Number(lesson.day) + 1}.
              </p>
            </div>
            <button id="btn-complete-lesson" class="btn btn-primary btn-lg" onclick="App.markLessonCompleted(${lesson.id})">
              ${isCompleted ? '✓ Lección Completada (Avanzar)' : '✓ Marcar como Completada ➔'}
            </button>
          </div>
        </div>
      </div>
    `;
  },

  escapeHtml: function (str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  handleEvidenceFileSelected: function (e) {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert("Por favor selecciona un archivo de imagen (PNG, JPG o WebP).");
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      this.state.currentEvidenceImage = ev.target.result;
      const previewImg = document.getElementById('evidence-preview-img');
      const previewBox = document.getElementById('evidence-preview-container');
      if (previewImg && previewBox) {
        previewImg.src = ev.target.result;
        previewBox.style.display = 'flex';
      }
      this.showToast("✓ Captura cargada. Ahora puedes completar la lección.");
    };
    reader.readAsDataURL(file);
  },

  copyPrompt: async function (source, btn) {
    let text = '';
    if (source === 'practice') {
      text = (this.state.currentLesson && this.state.currentLesson.practice && this.state.currentLesson.practice.promptTemplate) || '';
      if (!text) {
        const pre = document.getElementById('practice-prompt-pre');
        if (pre) text = pre.textContent;
      }
    } else if (source === 'example') {
      text = (this.state.currentLesson && this.state.currentLesson.example && this.state.currentLesson.example.after) || '';
      if (!text) {
        const el = document.getElementById('example-prompt-text');
        if (el) text = el.textContent.replace(/^"|"$/g, '');
      }
    } else if (typeof source === 'string') {
      text = source;
    }

    if (!text) {
      this.showToast("No se encontró el texto del prompt");
      return;
    }

    try {
      await this.copyToClipboard(text);
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = "✓ ¡Copiado!";
        btn.classList.add('btn-prompt-copied');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('btn-prompt-copied');
        }, 2200);
      }
      this.showToast("✓ Prompt copiado al portapapeles. Listo para pegar en tu IA.");
    } catch (err) {
      console.warn("Clipboard error:", err);
      this.showToast("✓ Prompt listo");
    }
  },

  handleQuizAnswer: function (qIdx, selectedIdx) {
    const q = this.state.currentLesson && this.state.currentLesson.quiz && this.state.currentLesson.quiz[qIdx];
    if (!q) return;

    const correctIdx = q.correctIndex;
    const explanation = q.explanation;
    const feedbackEl = document.getElementById(`quiz-feedback-${qIdx}`);
    const selectedEl = document.getElementById(`quiz-opt-${qIdx}-${selectedIdx}`);
    const correctEl = document.getElementById(`quiz-opt-${qIdx}-${correctIdx}`);

    document.querySelectorAll(`[id^="quiz-opt-${qIdx}-"]`).forEach(el => {
      el.style.pointerEvents = 'none';
    });

    if (selectedIdx === correctIdx) {
      if (selectedEl) selectedEl.classList.add('correct');
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = 'rgba(16, 185, 129, 0.12)';
        feedbackEl.style.border = '1px solid rgba(16, 185, 129, 0.3)';
        feedbackEl.style.color = '#34d399';
        feedbackEl.innerHTML = `<strong>✓ Correcto:</strong> ${this.escapeHtml(explanation)}`;
      }
    } else {
      if (selectedEl) selectedEl.classList.add('incorrect');
      if (correctEl) correctEl.classList.add('correct');
      if (feedbackEl) {
        feedbackEl.style.display = 'block';
        feedbackEl.style.background = 'rgba(239, 68, 68, 0.12)';
        feedbackEl.style.border = '1px solid rgba(239, 68, 68, 0.3)';
        feedbackEl.style.color = '#f87171';
        feedbackEl.innerHTML = `<strong>Retroalimentación:</strong> ${this.escapeHtml(explanation)}`;
      }
    }
  },

  markLessonCompleted: async function (lessonId) {
    const student = this.state.activeStudent;
    if (!student || student.paymentStatus !== 'approved') {
      this.showStudentAccessModal();
      return;
    }

    const hasEvidence = this.state.currentEvidenceImage || (student.evidence && student.evidence[lessonId]);
    if (!hasEvidence) {
      alert("📸 Falta tu evidencia: Debes adjuntar la captura de pantalla de tu práctica con la IA para completar esta lección.");
      return;
    }

    const btn = document.getElementById('btn-complete-lesson');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = "Guardando progreso...";
    }

    try {
      const res = await fetch(`/api/me/lessons/${lessonId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.state.token}`
        },
        body: JSON.stringify({
          image: this.state.currentEvidenceImage || undefined,
          quizScore: 100
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "No se pudo completar la lección.");
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = "✓ Marcar como Completada ➔";
        }
        return;
      }

      this.state.activeStudent = data.student;
      this.updateNavForStudent();

      if (data.student.certificateUnlocked) {
        this.showToast("🎓 ¡Felicitaciones! Has completado las 7 lecciones y desbloqueaste tu Certificado Oficial en PDF.");
      } else {
        this.showToast("✓ Lección completada exitosamente.");
      }

      // Avanzar automáticamente a la siguiente lección
      const nextId = Number(lessonId) + 1;
      if (nextId <= 7) {
        setTimeout(() => {
          this.openLesson(nextId);
        }, 700);
      } else {
        this.showView('dashboard');
      }

    } catch (err) {
      console.error("Error completing lesson:", err);
      alert("Error de conexión al guardar la lección.");
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  // ==========================================
  // CERTIFICADO VECTORIAL PDF (REQUISITO 2)
  // ==========================================
  downloadCertificate: async function () {
    if (!this.state.token) {
      alert("Sesión no válida.");
      return;
    }

    try {
      const res = await fetch('/api/me/certificate', {
        headers: { 'Authorization': `Bearer ${this.state.token}` }
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "El certificado solo se emite al completar las 7 lecciones con pago aprobado.");
        return;
      }

      if (window.CertificateGenerator) {
        this.showToast("Generando Certificado Oficial en PDF de 300 DPI...");
        window.CertificateGenerator.downloadPDF(data);
      } else {
        alert("Librería de PDF no disponible.");
      }
    } catch (e) {
      console.error("Error downloading certificate:", e);
      alert("Error al obtener datos del certificado.");
    }
  },

  // ==========================================
  // UTILIDADES
  // ==========================================
  closeAllModals: function () {
    document.querySelectorAll('.modal-overlay').forEach(el => el.classList.remove('active'));
  },

  showToast: function (msg) {
    let toast = document.getElementById('global-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'global-toast';
      toast.style.cssText = `
        position: fixed;
        bottom: 2rem;
        right: 2rem;
        background: #111520;
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.2);
        padding: 0.85rem 1.25rem;
        border-radius: 8px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.6);
        z-index: 300;
        font-size: 0.88rem;
        transition: opacity 0.3s ease;
      `;
      document.body.appendChild(toast);
    }

    toast.textContent = msg;
    toast.style.opacity = '1';

    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.style.opacity = '0';
    }, 3500);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
