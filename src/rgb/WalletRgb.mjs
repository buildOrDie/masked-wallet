import { RGB_PROFILE_KEY, baseUnits, newAsset, profileOf, testFee } from './config.mjs';

/**
 * A readable message for an RGB failure. The SDK often throws plain strings, not Error objects.
 * @param {unknown} error
 * @param {{ id: string, label: string }} [profile]
 */
export function rgbError(error, profile = profileOf('utexo')) {
  const text = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error?.['message'] ?? ''));
  if (/invalid indexer|failed to fetch|network ?error|internet|timed? ?out|ECONN|proxy/i.test(text)) return `Can't reach the ${profile.label} RGB servers right now. Check your connection and try again. (${text})`;
  if (/allocation ?slots|InsufficientAllocationSlots|no (colorable|available) (utxo|output)s?/i.test(text)) {
    return `No free RGB outputs yet. Tap Prepare RGB outputs, wait for one block, then try again. (${text})`;
  }
  if (/insufficient|not enough/i.test(text)) {
    return profile.id === 'utexo'
      ? `Not enough test BTC for this. Get some with /getbtc at the Utexo faucet, then Refresh. (${text})`
      : `Not enough confirmed Signet BTC for this. Send some to the RGB funding address, wait for a block, then Refresh. (${text})`;
  }
  return text || 'RGB operation failed.';
}

/** chrome.storage.session key: RAM only, gone when the browser closes, removed on lock and auto-lock. */
const RGB_SESSION_KEY = 'masked.rgb.session';

const EMPTY_FIELDS = () => ({ asset: '', amount: '', recipient: '', fee: '2', ticker: '', name: '', precision: '2', supply: '' });

/** RGB account lifecycle belongs to the existing wallet, not a second page or iframe. */
export class WalletRgb {
  constructor(app) {
    this.app = app;
    this.service = null;
    this.data = null;
    this.ready = false;
    this.busy = false;
    this.message = '';
    this.pending = null;
    this.invoice = '';
    this.issued = null;
    this.saved = false;
    this.assetId = '';
    this.mode = '';
    this.release = null;
    this.lockHeld = false;
    this.fields = EMPTY_FIELDS();
  }
  get available() { return this.app.state.net === 'signet'; }
  /** The RGB test network in use: Public Signet unless Utexo Signet was picked. */
  get profile() {
    let id = null;
    try { id = localStorage.getItem(RGB_PROFILE_KEY); } catch { /* storage blocked: use the default */ }
    return profileOf(id);
  }
  setProfile(id) {
    if (this.ready) throw new Error('Lock RGB before switching networks.');
    try { localStorage.setItem(RGB_PROFILE_KEY, profileOf(id).id); } catch { /* not remembered */ }
    this.service = null;
    this.message = '';
  }
  async acquire() {
    if (this.lockHeld) return;
    if (!navigator.locks) throw new Error('This browser cannot lock the RGB database.');
    await new Promise((resolve, reject) => {
      navigator.locks.request(`masked-rgb-${this.profile.id}-v1`, { ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error('RGB is open in another wallet window. Close it first.')); return; }
        this.lockHeld = true;
        resolve();
        await new Promise(done => { this.release = done; });
        this.lockHeld = false;
      }).catch(reject);
    });
  }
  async runtime() {
    const url = new URL('rgb-runtime.mjs', location.href).href;
    return import(url);
  }
  /** The service for the current network, created on first use (also to know whether a wallet exists). */
  async serviceFor() {
    if (this.service && this.service.profile.id === this.profile.id) return this.service;
    const runtime = await this.runtime();
    this.service = new runtime.SignetWallet({ loadSdk: runtime.loadRgbSdk, storage: localStorage, profile: this.profile });
    return this.service;
  }
  /** Whether a test wallet already exists on the current network (without loading the SDK). */
  get exists() {
    try { return !!localStorage.getItem(this.profile.vaultKey); } catch { return false; }
  }
  async open(password, backup = null) {
    await this.acquire();
    try {
      const runtime = await this.runtime();
      const service = await this.serviceFor();
      await service.open(password, runtime.newTestMnemonic, backup);
      this.ready = true;
      await this.refresh();
    } catch (error) { await this.close(); throw error; }
  }
  /** Keep RGB unlocked between popup opens, like the wallet itself (until auto-lock). */
  async remember(password) {
    const mins = this.app.vault?.autoLockMins?.() || 15;
    await this.app.platform?.sessionSet?.({ [RGB_SESSION_KEY]: { profile: this.profile.id, password, expires: Date.now() + mins * 60000 } });
  }
  async forget() { await this.app.platform?.sessionRemove?.(RGB_SESSION_KEY); }
  /** Reopen RGB after the popup was closed, if the session still has it. Never asks for anything. */
  async resume() {
    if (!this.available || this.ready || this.busy) return;
    const s = await this.app.platform?.sessionGet?.(RGB_SESSION_KEY);
    if (!s?.password || !(s.expires > Date.now()) || s.profile !== this.profile.id || !this.exists) return;
    this.busy = true; this.message = 'Opening RGB…'; this.app.render();
    try { await this.open(s.password); await this.remember(s.password); this.message = `RGB · ${this.profile.label}`; }
    catch (error) { this.message = rgbError(error, this.profile); }
    finally { this.busy = false; this.app.render(); }
  }
  async refresh() { this.data = await this.service.snapshot(); this.saved = false; }
  assets() { return Object.values(this.data?.groups || {}).flat().filter(a => a && typeof a === 'object'); }
  async close() {
    this.ready = false; this.data = null; this.pending = null; this.invoice = ''; this.issued = null; this.mode = ''; this.saved = false;
    this.fields = EMPTY_FIELDS();
    try { await this.service?.close(); } finally { this.release?.(); this.release = null; }
  }
  async action(name, arg = '') {
    if (this.busy) return;
    if (!this.available || this.app.state.lockState !== 'open') throw new Error('Open your wallet on Signet first.');
    this.busy = true;
    try {
      // Read secrets before rendering, never store them in app form state.
      const password = /** @type {HTMLInputElement} */ (document.getElementById('rgbPassword'));
      const value = password?.value || '';
      if (password) password.value = '';
      if (name === 'profile') { this.setProfile(arg); return; }
      if (name === 'open' || name === 'restore') {
        let backup = null;
        if (name === 'restore') {
          const file = /** @type {HTMLInputElement} */ (document.getElementById('rgbRestore')).files[0];
          if (!file || file.size > 40 * 1024 * 1024) throw new Error('Choose an RGB backup under 40 MB.');
          backup = JSON.parse(await file.text());
        }
        this.message = 'Opening RGB…'; this.app.render();
        await this.open(value, backup);
        await this.remember(value);
      } else if (!this.ready) throw new Error('Enable RGB in Settings first.');
      else if (name === 'refresh') await this.refresh();
      else if (name === 'close') { await this.forget(); await this.close(); }
      else if (name === 'outputs') { await this.service.createUtxos(this.fields.fee); await this.refresh(); }
      else if (name === 'issue') {
        newAsset(this.fields);
        this.message = 'Creating the test asset…'; this.app.render();
        const a = await this.service.issue(this.fields);
        this.issued = { ticker: a?.ticker || this.fields.ticker.toUpperCase(), assetId: a?.assetId || '' };
        this.app.toast(`Created ${this.issued.ticker}`);
        this.fields = { ...this.fields, ticker: '', name: '', supply: '' };
        await this.refresh();
      }
      else if (name === 'receive') { this.saved = false; const result = await this.service.receive(this.fields.asset.trim()); this.invoice = result.invoice; }
      else if (name === 'review') {
        const params = { assetId: this.fields.asset.trim(), amount: this.fields.amount, invoice: this.fields.recipient.trim(), fee: this.fields.fee };
        baseUnits(params.amount); testFee(params.fee);
        if (!params.assetId || !params.invoice.startsWith('rgb:')) throw new Error('Enter the exact RGB asset ID and blinded invoice.');
        this.pending = Object.freeze(params);
      } else if (name === 'cancel') this.pending = null;
      else if (name === 'confirm') {
        if (!this.pending) throw new Error('Review the transfer first.');
        const params = this.pending; this.pending = null;
        await this.service.send(params); await this.refresh();
      } else if (name === 'backup') {
        const backup = await this.service.backup();
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `masked-rgb-${this.profile.id}-signet-backup.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000); this.saved = true;
      } else if (name === 'saved') { if (!this.saved) throw new Error('Export a backup first.'); this.service.backupSaved(); this.saved = false; }
      this.message = `RGB · ${this.profile.label}`;
    } catch (error) {
      this.message = rgbError(error, this.profile);
      this.app.toast(this.message, 6000); // the card's status line can be off-screen; say it where the person is looking
    }
    finally { this.busy = false; this.app.render(); }
  }
}
