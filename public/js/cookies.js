/**
 * IA en 7 Días - Gestión Real de Cookies y Consentimiento
 *
 * - No bloquea la navegación mientras el usuario decide.
 * - Permite Aceptar todas o Rechazar las no esenciales con el mismo nivel de visibilidad.
 * - Guarda la preferencia en localStorage y en cookie de primera parte (1 año).
 * - Solo activa cookies/scripts no esenciales cuando el estado es "accepted".
 */
const CookieConsent = {
  STORAGE_KEY: 'ia7d_cookie_consent',
  COOKIE_NAME: 'ia7d_cookie_consent',

  init: function () {
    this.injectBannerIfNeeded();
    const pref = this.getPreference();
    if (!pref) {
      this.showBanner();
    } else {
      this.applyPreference(pref);
    }
    this.updateStatusBadges();
  },

  getPreference: function () {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.status === 'accepted' || parsed.status === 'rejected')) {
          return parsed;
        }
      }
    } catch (e) {}

    // Fallback: leer cookie si existe
    const match = document.cookie.match(new RegExp('(?:^|; )' + this.COOKIE_NAME + '=([^;]*)'));
    if (match) {
      const val = decodeURIComponent(match[1]);
      if (val === 'accepted' || val === 'rejected') {
        return { status: val, nonEssential: val === 'accepted', updatedAt: null };
      }
    }
    return null;
  },

  savePreference: function (status) {
    const pref = {
      status: status === 'accepted' ? 'accepted' : 'rejected',
      nonEssential: status === 'accepted',
      updatedAt: new Date().toISOString()
    };
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(pref));
    } catch (e) {}

    const maxAge = 365 * 24 * 60 * 60; // 1 año
    document.cookie = `${this.COOKIE_NAME}=${pref.status}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;

    this.applyPreference(pref);
    this.hideBanner();
    this.updateStatusBadges();
    return pref;
  },

  accept: function () {
    this.savePreference('accepted');
  },

  reject: function () {
    this.savePreference('rejected');
  },

  resetPreference: function () {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
    } catch (e) {}
    document.cookie = `${this.COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
    this.clearNonEssentialCookies();
    this.updateStatusBadges();
    this.openBanner();
  },

  hasNonEssentialConsent: function () {
    const pref = this.getPreference();
    return Boolean(pref && pref.status === 'accepted');
  },

  applyPreference: function (pref) {
    if (pref && pref.status === 'accepted') {
      document.documentElement.setAttribute('data-cookies-non-essential', 'enabled');
      // Activar cookie analítica propia ligera solo bajo consentimiento
      const maxAge = 180 * 24 * 60 * 60;
      document.cookie = `ia7d_analytics_optin=1; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
    } else {
      document.documentElement.setAttribute('data-cookies-non-essential', 'disabled');
      this.clearNonEssentialCookies();
    }
  },

  clearNonEssentialCookies: function () {
    const nonEssentialNames = ['ia7d_analytics_optin', '_ga', '_gid', '_gat'];
    nonEssentialNames.forEach(name => {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    });
  },

  injectBannerIfNeeded: function () {
    if (document.getElementById('cookie-consent-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Aviso de privacidad y cookies');
    banner.style.display = 'none';

    banner.innerHTML = `
      <div class="cookie-banner-inner">
        <div class="cookie-banner-text">
          <strong>Uso de cookies en IA en 7 Días</strong>
          <p>
            Utilizamos almacenamiento técnico indispensable para mantener tu sesión y guardar tu progreso en el curso, y cookies analíticas opcionales para mejorar la plataforma. No bloqueamos tu navegación: puedes aceptar todas o rechazar las no esenciales.
            Consulta nuestra <a href="/politica-de-cookies.html">Política de cookies</a> y <a href="/politica-de-privacidad.html">Política de privacidad</a>.
          </p>
        </div>
        <div class="cookie-banner-actions">
          <button type="button" class="btn btn-secondary btn-sm cookie-btn-reject" onclick="CookieConsent.reject()">
            Rechazar no esenciales
          </button>
          <button type="button" class="btn btn-primary btn-sm cookie-btn-accept" onclick="CookieConsent.accept()">
            Aceptar cookies
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(banner);
  },

  showBanner: function () {
    this.injectBannerIfNeeded();
    const banner = document.getElementById('cookie-consent-banner');
    if (banner) banner.style.display = 'block';
  },

  openBanner: function () {
    this.showBanner();
  },

  hideBanner: function () {
    const banner = document.getElementById('cookie-consent-banner');
    if (banner) banner.style.display = 'none';
  },

  updateStatusBadges: function () {
    const statusEl = document.getElementById('cookie-current-status-text');
    if (!statusEl) return;
    const pref = this.getPreference();
    if (!pref) {
      statusEl.innerHTML = 'Estado actual: <strong>Sin decidir aún</strong> (solo cookies técnicas necesarias activas).';
    } else if (pref.status === 'accepted') {
      statusEl.innerHTML = 'Estado actual: <strong style="color: #0F766E;">Cookies aceptadas</strong> (técnicas + analíticas activas).';
    } else {
      statusEl.innerHTML = 'Estado actual: <strong style="color: #57534E;">Cookies no esenciales rechazadas</strong> (solo técnicas necesarias activas).';
    }
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => CookieConsent.init());
} else {
  CookieConsent.init();
}
