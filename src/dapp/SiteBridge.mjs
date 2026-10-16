// What connected sites may see, shared through chrome.storage so the background can answer read-only
// calls (getAccounts, getBalance, …) without opening the wallet. Only the Public account is shared.

export class SiteBridge {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.published = null;
    this.sites = {}; // origin → { connectedAt, … }
  }

  get platform() { return this.app.platform; }

  publishPublic() {
    const { account } = this.app;
    if (!this.platform.hasExt || !account.keys || account.keys.source === 'example') return;
    const f = account.funding();
    if (!f) return;
    const pub = { net: account.net, address: f.address, publicKey: '02' + f.internalX, xonly: f.internalX, shieldedAddress: account.shieldAddr() };
    const key = JSON.stringify(pub);
    if (key === this.published) return;
    this.published = key;
    this.platform.storageSet({ 'masked.public': { ...pub, updatedAt: Date.now() } });
  }

  async loadSites() {
    if (!this.platform.hasExt) return;
    try { this.sites = (await this.platform.storageGet('masked.sites')) || {}; } catch { this.sites = {}; }
  }

  async disconnect(origin) {
    const s = (await this.platform.storageGet('masked.sites')) || {};
    delete s[origin];
    await chrome.storage.local.set({ 'masked.sites': s });
    await this.loadSites();
  }
}
