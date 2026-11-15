// The phone app isn't on Google Play, so nothing tells people a new version is out. The app asks MASKED's site which
// version is current (android.json, made when the site is built) every few hours, and Home shows a row when a newer
// one is out. Tapping it opens the site's install page in the browser, which downloads it and shows what Android will
// ask. Installing over the old version keeps the wallet. The extension gets its updates from the Chrome Web Store.

/** Where the current version is published. */
export const UPDATE_INFO = 'https://signet.maskedwallet.com/android.json';
const KEY = 'masked.app.update';
const EVERY = 6 * 3600_000;
const LATER = 3 * 86400_000;

/** This build's version (set by the build; empty when unknown, as in tests). */
// eslint-disable-next-line no-undef
export const APP_VERSION = typeof __MASKED_VERSION__ !== 'undefined' ? __MASKED_VERSION__ : '';

/** 1 if a is newer than b, -1 if older, 0 if the same (x.y.z). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

export class AppUpdate {
  /** @param {{ platform: { isApp: boolean }, store: any, render?: () => void }} app */
  constructor(app, { fetchFn = (...a) => globalThis.fetch(...a), now = () => Date.now(), version = APP_VERSION, url = UPDATE_INFO } = {}) {
    this.app = app; this.fetchFn = fetchFn; this.now = now; this.version = version; this.url = url;
  }
  get on() { return !!this.version && !!this.app.platform.isApp; } // version first: no window in tests
  saved() { return this.app.store.getJson(KEY, {}) || {}; }

  /** Ask the site, at most every few hours (or now, when asked from Settings). */
  async check(force = false) {
    if (!this.on) return null;
    const s = this.saved();
    if (!force && s.checkedAt && this.now() - s.checkedAt < EVERY) return this.available();
    try {
      const r = await this.fetchFn(this.url, { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (j && /^\d+\.\d+\.\d+$/.test(String(j.version))) {
        const sha = /^[0-9a-f]{64}$/.test(String(j.sha256 || '')) ? String(j.sha256) : '';
        this.app.store.setJson(KEY, { ...s, checkedAt: this.now(), latest: String(j.version), page: new URL(j.page || '/install', this.url).href, apk: j.apk ? new URL(j.apk, this.url).href : '', sha256: sha });
      } else this.app.store.setJson(KEY, { ...s, checkedAt: this.now() });
    } catch { /* offline or the site is down: ask again later */ }
    this.app.render?.();
    return this.available();
  }

  /** { version, page } when a newer version is out (and not put off with Later), else null. */
  available({ ignoreLater = false } = {}) {
    if (!this.on) return null;
    const s = this.saved();
    if (!s.latest || compareVersions(s.latest, this.version) <= 0) return null;
    if (!ignoreLater && s.laterFor === s.latest && this.now() - (s.laterAt || 0) < LATER) return null;
    return { version: s.latest, page: s.page || new URL('/install', this.url).href, apk: s.apk || '', sha256: s.sha256 || '', inApp: this.canInApp(s) };
  }

  /** The app's own updater (UpdaterPlugin, Android): download, check the SHA-256, open "update this app?". */
  plugin() { return globalThis.Capacitor?.Plugins?.MaskedUpdater || null; }
  canInApp(s = this.saved()) { return !!(this.plugin() && s.apk && /^[0-9a-f]{64}$/.test(s.sha256 || '')); }

  /**
   * Update from inside the app. state: 'allow' (Android must let MASKED install apps first), 'downloading' (with
   * progress 0..1), 'installing' (Android's screen is open), or an error (then the install page still works).
   */
  async install() {
    const up = this.available({ ignoreLater: true });
    const p = this.plugin();
    if (!up || !p || !up.inApp || this.state === 'downloading') return;
    this.error = '';
    try {
      const { allowed } = await p.canInstall();
      if (!allowed) { this.state = 'allow'; this.app.render?.(); return; }
      this.state = 'downloading'; this.progress = 0; this.app.render?.();
      const sub = await p.addListener?.('progress', (e) => {
        const pct = e?.total > 0 ? Math.min(1, e.loaded / e.total) : 0;
        if (pct - (this.progress || 0) >= 0.05 || pct === 1) { this.progress = pct; this.app.render?.(); }
      });
      try { await p.install({ url: up.apk, sha256: up.sha256 }); } finally { sub?.remove?.(); }
      this.state = 'installing';
    } catch (e) {
      const m = String(e?.message || e);
      this.state = 'error';
      this.error = m === 'old-android' ? 'This Android version updates from the install page.' : m;
    }
    this.app.render?.();
  }

  /** Android's "Install unknown apps" switch for MASKED (asked once). */
  async allowInstalls() {
    try { await this.plugin()?.openInstallSettings(); } catch { /* the install page still works */ }
    this.state = '';
    this.app.render?.();
  }

  /** The Home card's buttons and status, for the version on offer. */
  card(up) {
    const pct = Math.round((this.progress || 0) * 100);
    if (this.state === 'downloading') return { note: `Downloading the update… ${pct}%`, busy: true };
    if (this.state === 'installing') return { note: 'Android is asking to update MASKED: tap Update there. Your wallet stays.' };
    if (this.state === 'allow') return { note: 'Android asks once to let MASKED install its updates. Turn on “Allow from this source”, come back, then tap Update again.', allow: true };
    if (this.state === 'error') return { note: `${this.error} You can also update from the install page.`, page: true, retry: up.inApp };
    return { note: 'Install it over this one: your wallet stays.', update: true };
  }

  later() {
    const s = this.saved();
    this.app.store.setJson(KEY, { ...s, laterFor: s.latest, laterAt: this.now() });
    this.app.render?.();
  }
}
