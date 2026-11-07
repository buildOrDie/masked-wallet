// Where the wallet runs: the Chrome extension (chrome.* APIs), the phone app (Capacitor) or a plain page.
// Everything that touches chrome.* goes through here.

/**
 * Where the RGB permission window goes: under the toolbar on the right of the browser window, inside it, and no
 * taller than it. Without usable bounds (minimised, unknown) only the size is given and Chrome places it.
 * @param {{ left?: number, top?: number, width?: number, height?: number, state?: string } | null} b
 */
/** The resume the background should reopen MASKED at once Chrome allows the servers. */
export const RGB_PENDING = 'masked.rgb.permission.pending';

export function rgbWindowBounds(b, width = 380, height = 660) {
  const ok = (n) => Number.isFinite(n);
  if (!b || b.state === 'minimized' || ![b.left, b.top, b.width, b.height].every(ok) || b.width < 200 || b.height < 300) return { width, height };
  const w = Math.min(width, b.width), h = Math.max(420, Math.min(height, b.height - 80));
  return { width: w, height: h, left: Math.round(b.left + Math.max(0, b.width - w - 12)), top: Math.round(b.top + Math.max(0, Math.min(72, b.height - h))) };
}

export class Platform {
  constructor() {
    const params = new URLSearchParams(location.search);
    this.requestId = params.get('req');
    this.isPopup = params.has('popup');
    this.rgbResumeId = params.get('rgbResume');
  }

  get hasExt() { return typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.storage?.local; }
  /** Running as the MASKED phone app (Capacitor), not the browser extension. */
  get isApp() { return !!window.Capacitor?.isNativePlatform?.(); }
  get hasSession() { return typeof chrome !== 'undefined' && !!chrome.storage?.session; }

  /** The side panel is offered in the popup (not in the panel itself, nor in an approval window). */
  get canOpenSidePanel() { return this.hasExt && !!chrome.sidePanel?.open && !new URLSearchParams(location.search).has('panel') && !this.requestId; }

  async openSidePanel() {
    const w = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: w.id });
    setTimeout(() => window.close(), 100);
  }

  // ---- messages to the background ----
  connect(name) { return chrome.runtime.connect({ name }); }
  message(m) { return chrome.runtime.sendMessage(m); }

  // ---- chrome.storage.local (shared with the background) ----
  async storageGet(key) { return (await chrome.storage.local.get(key))[key]; }
  storageSet(obj) { return chrome.storage.local.set(obj).catch(() => {}); }
  storageRemove(key) { return chrome.storage.local.remove(key).catch(() => {}); }

  // ---- chrome.storage.session (RAM only; keeps the wallet unlocked between popup opens) ----
  async sessionGet(key) {
    if (!this.hasSession) return null;
    try { return (await chrome.storage.session.get(key))[key] || null; } catch { return null; }
  }
  async sessionSet(obj) { if (!this.hasSession) return; try { await chrome.storage.session.set(obj); } catch {} }
  async sessionRemove(key) { if (!this.hasSession) return; try { await chrome.storage.session.remove(key); } catch {} }

  /**
   * Ask Chrome for RGB servers from the toolbar popup, in one step. Where the person was is saved first, then
   * Chrome asks. Its prompt usually closes the popup: once the servers are allowed, the background reopens
   * MASKED at the same step (masked.html?rgbResume=…). If the popup stays open, it simply carries on.
   * Throws if the person says no.
   */
  async requestFromPopup(urls, draft) {
    const id = crypto.randomUUID(), key = `masked.rgb.permission.${id}`;
    // not awaited before the request: Chrome only shows its prompt straight from the click
    const saved = chrome.storage.session.set({ [key]: { ...draft, expires: Date.now() + 5 * 60000 }, [RGB_PENDING]: id }).catch(() => {});
    try { await this.requestOrigins(urls); } finally {
      // still open: nothing to resume
      await saved; await this.sessionRemove(RGB_PENDING); await this.sessionRemove(key);
    }
  }

  async takeRgbPermissionDraft() {
    const id = this.rgbResumeId;
    if (!id) return null;
    const key = `masked.rgb.permission.${id}`;
    const draft = await this.sessionGet(key);
    await this.sessionRemove(key);
    this.rgbResumeId = null;
    try { history.replaceState(null, '', chrome.runtime.getURL(this.isPopup ? 'masked.html?popup=1' : 'masked.html')); } catch { /* the draft is already consumed */ }
    return draft?.expires > Date.now() ? draft : null;
  }


  /**
   * Ask once (one Chrome prompt) to reach several servers, e.g. the RGB transfer server named in an invoice.
   * Must be called straight from a click. Already-allowed servers do not prompt.
   * @param {string[]} urls
   */
  async requestOrigins(urls) {
    if (!urls.length || !this.hasExt || !chrome.permissions?.request) return;
    const origins = [...new Set(urls.map((u) => new URL(u).origin + '/*'))];
    const ok = await chrome.permissions.request({ origins });
    if (!ok) throw new Error('MASKED needs permission to reach the transfer server in this invoice.');
  }

  /** Whether MASKED may already reach these servers (no prompt). Outside the extension: always. */
  async hasOrigins(urls) {
    if (!urls.length || !this.hasExt || !chrome.permissions?.contains) return true;
    try { return await chrome.permissions.contains({ origins: [...new Set(urls.map((u) => new URL(u).origin + '/*'))] }); } catch { return false; }
  }

  /** Ask for permission to reach a server the user typed in Settings. */
  async requestOrigin(url) {
    if (!this.hasExt || !chrome.permissions?.request) return;
    const ok = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
    if (!ok) throw new Error('Permission to reach that server was declined.');
  }
}
