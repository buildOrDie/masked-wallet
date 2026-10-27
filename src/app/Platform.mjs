// Where the wallet runs: the Chrome extension (chrome.* APIs), the phone app (Capacitor) or a plain page.
// Everything that touches chrome.* goes through here.

export class Platform {
  constructor() {
    this.requestId = new URLSearchParams(location.search).get('req');
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

  /** Ask once to read public posts on X (publish.twitter.com), so the wallet checks @handles itself. Call it first in a click. */
  async allowX() {
    if (!this.hasExt || !chrome.permissions?.request) return;
    const ok = await chrome.permissions.request({ origins: ['https://publish.twitter.com/*'] });
    if (!ok) throw new Error('MASKED needs to read the post on X to check the @handle. Allow it and try again.');
  }

  /** Ask for permission to reach a server the user typed in Settings. */
  async requestOrigin(url) {
    if (!this.hasExt || !chrome.permissions?.request) return;
    const ok = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
    if (!ok) throw new Error('Permission to reach that server was declined.');
  }
}
