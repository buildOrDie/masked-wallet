import { baseUnits, testFee } from './config.mjs';

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
    this.saved = false;
    this.assetId = '';
    this.mode = '';
    this.release = null;
    this.lockHeld = false;
    this.fields = { asset: '', amount: '', recipient: '', fee: '2' };
  }
  get available() { return this.app.state.net === 'signet'; }
  async acquire() {
    if (this.lockHeld) return;
    if (!navigator.locks) throw new Error('This browser cannot lock the RGB database.');
    await new Promise((resolve, reject) => {
      navigator.locks.request('masked-rgb-signet-v1', { ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error('RGB is open in another wallet window. Close it first.')); return; }
        this.lockHeld = true;
        resolve();
        await new Promise(done => { this.release = done; });
        this.lockHeld = false;
      }).catch(reject);
    });
  }
  async open(password, backup = null) {
    await this.acquire();
    try {
      const url = new URL('rgb-runtime.mjs', location.href).href;
      const runtime = await import(url);
      this.service ||= new runtime.SignetWallet({ loadSdk: runtime.loadRgbSdk, storage: localStorage });
      await this.service.open(password, runtime.newTestMnemonic, backup);
      this.ready = true;
      await this.refresh();
    } catch (error) { await this.close(); throw error; }
  }
  async refresh() { this.data = await this.service.snapshot(); this.saved = false; }
  assets() { return Object.values(this.data?.groups || {}).flat().filter(a => a && typeof a === 'object'); }
  async close() {
    this.ready = false; this.data = null; this.pending = null; this.invoice = ''; this.mode = ''; this.saved = false;
    this.fields = { asset: '', amount: '', recipient: '', fee: '2' };
    try { await this.service?.close(); } finally { this.release?.(); this.release = null; }
  }
  async action(name) {
    if (this.busy) return;
    if (!this.available || this.app.state.lockState !== 'open') throw new Error('Open your wallet on Signet first.');
    this.busy = true;
    try {
      // Read secrets before rendering, never store them in app form state.
      const password = /** @type {HTMLInputElement} */ (document.getElementById('rgbPassword'));
      const value = password?.value || '';
      if (password) password.value = '';
      if (name === 'open' || name === 'restore') {
        let backup = null;
        if (name === 'restore') {
          const file = /** @type {HTMLInputElement} */ (document.getElementById('rgbRestore')).files[0];
          if (!file || file.size > 40 * 1024 * 1024) throw new Error('Choose an RGB backup under 40 MB.');
          backup = JSON.parse(await file.text());
        }
        this.message = 'Opening RGB…'; this.app.render();
        await this.open(value, backup);
      } else if (!this.ready) throw new Error('Enable RGB in Settings first.');
      else if (name === 'refresh') await this.refresh();
      else if (name === 'close') await this.close();
      else if (name === 'outputs') { await this.service.createUtxos(this.fields.fee); await this.refresh(); }
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
        const link = document.createElement('a'); link.href = url; link.download = 'masked-rgb-signet-backup.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000); this.saved = true;
      } else if (name === 'saved') { if (!this.saved) throw new Error('Export a backup first.'); this.service.backupSaved(); this.saved = false; }
      this.message = 'RGB · Utexo custom Signet';
    } catch (error) { this.message = error.message || 'RGB operation failed.'; }
    finally { this.busy = false; this.app.render(); }
  }
}
