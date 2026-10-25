import { RGB_PROFILE_KEY, fromBase, newAsset, profileOf, toBase } from './config.mjs';
import { toHex, enc } from '../core/bytes.mjs';
import { encryptRgb } from './backup.mjs';

/** Fee rate for RGB's own transactions on the test networks (sat/vB). */
const RGB_FEE = '2';
/** Below this much test BTC (sats), Home suggests adding some: enough for a few RGB transactions. */
export const RGB_LOW_BTC = 3000;
/** What "Add test BTC" sends from the Public balance. */
export const RGB_FUND_BTC = '0.0003';

/**
 * A readable message for an RGB failure. The engine often throws plain strings, not Error objects.
 * @param {unknown} error
 * @param {{ id: string, label: string }} [profile]
 */
export function rgbError(error, profile = profileOf('utexo')) {
  const full = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error?.['message'] ?? ''));
  const text = brief(full);
  if (/did not answer in time|timed? ?out|\b429\b|too many requests|status: 50[234]\b|bad gateway|service unavailable|gateway time/i.test(full)) return `The ${profile.label} block server is busy or down right now.`;
  if (/invalid indexer|failed to fetch|network ?error|internet|ECONN|proxy/i.test(full)) return `Can't reach the ${profile.label} RGB servers right now. Check your connection and try again. (${text})`;
  if (/insufficient ?allocation|allocation ?slots|no (colorable|available) (utxo|output)s?/i.test(text)) {
    return `RGB is still setting up. Wait for one block (about 10 minutes), then try again. (${text})`;
  }
  if (/insufficient|not enough/i.test(text)) {
    return profile.id === 'utexo'
      ? `Not enough test BTC for this. Get some with /getbtc at the Utexo faucet, then Refresh. (${text})`
      : `Not enough confirmed test BTC for RGB. Tap Add test BTC on Home, wait for a block, then try again. (${text})`;
  }
  return text || 'RGB operation failed.';
}

/** The useful part of an engine error: the innermost message, one line, not too long. */
function brief(text) {
  const inner = String(text).match(/Error: ([^\n\\]+)/);
  const t = (inner ? inner[1] : String(text)).split('\n')[0].trim();
  return t.length > 140 ? t.slice(0, 137) + '…' : t;
}

/** Errors that mean "no RGB outputs to put the asset on yet". */
const NEEDS_OUTPUTS = /insufficient ?allocation|allocation ?slots|insufficient bitcoin|InsufficientBitcoins|no (colorable|available) (utxo|output)s?/i;

const EMPTY_FIELDS = () => ({ name: '', ticker: '', supply: '', precision: '2', sendTo: '', sendAmt: '', recvAsset: '', recvAmt: '', recvExpiry: '86400', recvType: '' });
/** How long an invoice works: 1 hour, 24 hours, 7 days. */
export const RGB_EXPIRY = [['3600', '1 hour'], ['86400', '24 hours'], ['604800', '7 days']];
/** Test BTC a blind invoice needs (one RGB output, set up on demand). Below it, Receive suggests a witness invoice. */
export const RGB_BLIND_MIN = 2000;

/**
 * RGB inside the wallet. It opens by itself while the wallet is open on Signet: its test keys are encrypted with a
 * key derived from the wallet's own recovery words, so there is no second password.
 */
export class WalletRgb {
  constructor(app) {
    this.app = app;
    this.service = null;
    this.data = null;
    this.ready = false;
    this.busy = false;
    /** '' | 'opening' | 'legacy' (an older test wallet with its own password) | 'error' */
    this.phase = '';
    this.message = '';
    this.tried = '';      // profile id already tried this session, so a failure doesn't retry on every render
    this.invoice = '';    // the last receive invoice
    /** @type {any} */ this.invoiceInfo = null;
    this.issued = null;   // { ticker, assetId } after Create
    this.pending = null;  // a reviewed send
    this.sent = null;     // { txid, amount, ticker } after Send
    this.asset = '';      // the token page / send screen asset
    this.saved = false;
    this.release = null;
    this.lockHeld = false;
    this.timer = null;
    /** @type {any} */ this.waiting = null;
    this.waitSince = 0;
    this.fields = EMPTY_FIELDS();
  }

  get available() { return this.app.state.net === 'signet' && this.app.state.lockState === 'open' && !!this.app.lock?.secret?.words; }
  /** The RGB test network in use: Public Signet unless Utexo Signet was picked. */
  get profile() {
    let id = null;
    try { id = localStorage.getItem(RGB_PROFILE_KEY); } catch { /* storage blocked: use the default */ }
    return profileOf(id);
  }
  /** Whether a test wallet already exists on the current network (without loading the engine). */
  get exists() { return !!this.vault(); }
  vault() { try { return JSON.parse(localStorage.getItem(this.profile.vaultKey) || 'null'); } catch { return null; } }

  /** The key RGB's test vault and backups are encrypted with: derived from the wallet's recovery words. */
  async walletKey() {
    const s = this.app.lock?.secret;
    if (!s?.words) throw new Error('Unlock your wallet first.');
    const d = await crypto.subtle.digest('SHA-256', enc.encode(`MASKED/rgb-vault/v1\n${s.words}\n${s.passphrase || ''}`));
    return toHex(new Uint8Array(d));
  }

  // ---- what the screens read ----
  assets() { return Object.values(this.data?.groups || {}).flat().filter((a) => a && typeof a === 'object' && a.assetId); }
  find(id) { return this.assets().find((a) => a.assetId === id) || null; }
  history(id) { return (this.data?.transfers?.[id] || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  /** Test BTC the RGB wallet holds: { settled, pending } in sats. */
  btc() {
    const b = this.data?.btc || {};
    const sum = (k) => Number(b.vanilla?.[k] || 0) + Number(b.colored?.[k] || 0);
    const settled = sum('settled');
    return { settled, pending: Math.max(0, sum('future') - settled) };
  }
  amount(a, n) { return fromBase(n, a?.precision || 0); }
  /** Blind unless chosen otherwise; witness by default when there is too little test BTC for a blind one. */
  recvType() { return this.fields.recvType || (this.data && this.btc().settled < RGB_BLIND_MIN ? 'witness' : 'blind'); }

  // ---- lifecycle ----
  async acquire() {
    if (this.lockHeld) return;
    if (!navigator.locks) throw new Error('This browser cannot lock the RGB database.');
    await new Promise((resolve, reject) => {
      navigator.locks.request(`masked-rgb-${this.profile.id}-v1`, { ifAvailable: true }, async (lock) => {
        if (!lock) { reject(new Error('RGB is open in another wallet window. Close it first.')); return; }
        this.lockHeld = true;
        resolve();
        await new Promise((done) => { this.release = done; });
        this.lockHeld = false;
      }).catch(reject);
    });
  }
  async runtime() { return import(new URL('rgb-runtime.mjs', location.href).href); }
  async serviceFor() {
    if (this.service && this.service.profile.id === this.profile.id) return this.service;
    const runtime = await this.runtime();
    this.service = new runtime.SignetWallet({ loadSdk: runtime.loadRgbSdk, storage: localStorage, profile: this.profile });
    return this.service;
  }
  /** @param {string} password @param {any} [backup] @param {{ keyed?: boolean }} [o] keyed: password is the wallet key */
  async open(password, backup = null, { keyed = true } = {}) {
    await this.acquire();
    try {
      const runtime = await this.runtime();
      const service = await this.serviceFor();
      await service.open(password, runtime.newTestMnemonic, backup);
      this.ready = true;
      if (keyed) this.markKeyed();
      this.startTimer();
    } catch (error) { await this.close(); throw error; }
    // Balances: a slow or busy server must not close RGB. Keep it open and retry with the minute timer.
    try {
      await this.refresh(!!backup || this.needsScan());
    } catch (error) {
      this.message = `${rgbError(error, this.profile)} RGB will try again in a minute.`;
    }
  }
  /** Vaults opened with the wallet key say so; older ones had a password of their own. */
  markKeyed() {
    const v = this.vault();
    if (v && v.keyed !== 'wallet') try { localStorage.setItem(this.profile.vaultKey, JSON.stringify({ ...v, keyed: 'wallet' })); } catch { /* next open marks it */ }
  }
  /** A full address scan has not completed yet for this test wallet on this engine. */
  needsScan() { try { return localStorage.getItem(`${this.profile.vaultKey}.scanned-v2`) !== '1'; } catch { return true; } }
  /** @param {boolean} [full] scan addresses ahead too: the first time, and when Refresh is tapped */
  async refresh(full = false) {
    full ||= this.needsScan();
    this.data = await this.service.snapshot({ full }); this.saved = false;
    if (full) try { localStorage.setItem(`${this.profile.vaultKey}.scanned-v2`, '1'); } catch { /* scans again next time */ }
  }
  async close() {
    clearInterval(this.timer); this.timer = null;
    this.ready = false; this.data = null; this.pending = null; this.invoice = ''; this.issued = null; this.sent = null; this.saved = false;
    this.fields = EMPTY_FIELDS();
    try { await this.service?.close(); } finally { this.release?.(); this.release = null; }
  }
  /** Keep balances and incoming transfers current while RGB is open (once a minute, when visible). */
  startTimer() {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.ready || this.busy || document.visibilityState !== 'visible') return;
      this.run(async () => { await this.refresh(); this.message = ''; }, { quiet: true });
    }, 60000);
  }

  /** Open RGB by itself when the wallet is open on Signet and a test wallet exists. Called from render. */
  ensure() {
    if (!this.available || this.ready || this.busy || !this.exists || this.tried === this.profile.id) return;
    // let the wallet's own sync finish first: both use the same block servers
    // (at most 30 s: a long history rescan should not keep RGB closed)
    if (this.app.sync?.syncing && (this.waitSince ||= Date.now()) > Date.now() - 30000) {
      if (!this.waiting) this.waiting = setTimeout(() => { this.waiting = null; this.ensure(); this.app.render(); }, 3000);
      return;
    }
    this.waitSince = 0;
    this.tried = this.profile.id;
    setTimeout(() => this.run(async () => {
      this.phase = 'opening'; this.app.render();
      try { await this.open(await this.walletKey()); } catch (e) {
        // a test wallet from an earlier build, encrypted with a password of its own: ask for it once
        if (this.vault()?.keyed !== 'wallet' && /incorrect password/i.test(e?.message || '')) { this.phase = 'legacy'; this.message = ''; return; }
        throw e;
      }
    }, { quiet: true }), 0);
  }
  /** Kept for the lock controller: reopening is automatic now. */
  async resume() { this.ensure(); }
  async forget() { /* nothing kept outside the vault any more */ }

  /** Run an RGB step: one at a time, errors shown as a message and a toast. */
  async run(fn, { quiet = false } = {}) {
    if (this.busy) return;
    this.busy = true;
    try {
      await fn();
      if (this.phase !== 'legacy') this.phase = '';
      if (!quiet) this.message = '';
    } catch (error) {
      this.message = rgbError(error, this.profile);
      if (!this.ready && this.phase === 'opening') this.phase = 'error';
      if (!quiet) this.app.toast(this.message, 6000);
    } finally { this.busy = false; this.app.render(); }
  }

  /**
   * Do something that needs free RGB outputs. If there are none, make them first (one Bitcoin transaction) and
   * try again; if they still need a block, say so plainly.
   */
  async withOutputs(fn) {
    try { return await fn(); } catch (e) {
      const text = typeof e === 'string' ? e : e?.message || '';
      if (!NEEDS_OUTPUTS.test(text)) throw e;
      if (this.btc().settled < 1500) throw new Error('Add test BTC first: tap Add test BTC on Home, then wait for a block.');
      this.message = 'Setting up RGB…'; this.app.render();
      await this.service.createUtxos(RGB_FEE);
      await this.refresh();
      try { return await fn(); } catch (e2) {
        if (NEEDS_OUTPUTS.test(typeof e2 === 'string' ? e2 : e2?.message || '')) throw new Error('RGB is set up. Wait for one block (about 10 minutes), then tap again.');
        throw e2;
      }
    }
  }

  // ---- actions (data-rgb="…") ----
  async action(name, arg = '') {
    const app = this.app, state = app.state, f = state.f;
    if (!this.available) throw new Error('Open your wallet on Signet first.');
    if (['fund', 'mint', 'token', 'receive', 'send'].includes(name)) this.message = ''; // a new screen starts clean
    switch (name) {
      case 'on': return this.run(async () => {
        this.phase = 'opening'; this.tried = this.profile.id; app.render();
        await this.open(await this.walletKey());
        app.toast('RGB is on');
      });
      case 'retry': this.tried = ''; this.phase = ''; this.ensure(); return app.render();
      case 'migrate': {
        const el = /** @type {HTMLInputElement} */ (document.getElementById('rgbOldPw'));
        const old = el?.value || ''; if (el) el.value = '';
        return this.run(async () => {
          this.phase = 'opening'; app.render();
          await this.open(old, null, { keyed: false });
          // re-encrypt the test keys with the wallet key, so this was the last time a password is asked
          const key = await this.walletKey();
          localStorage.setItem(this.profile.vaultKey, JSON.stringify({ ...(await encryptRgb({ mnemonic: this.service.mnemonic }, key, this.profile.id)), keyed: 'wallet' }));
          this.service.password = key; // backups from now on use the wallet key too
        });
      }
      case 'refresh': return this.run(() => this.refresh(true));
      case 'fund': {
        if (!this.data?.address) return;
        f.sendMode = 'send'; f.sendFrom = 'public'; f.sendTo = this.data.address; f.sendAmount = RGB_FUND_BTC;
        state.send = { stage: 'form' }; state.status.send = null; state.view = 'send';
        return app.render();
      }
      case 'mint': f.mintMode = 'rgb'; state.view = 'mint'; this.issued = null; return app.render();
      case 'token': this.asset = arg; state.view = 'rgbtok'; return app.render();
      case 'receive': f.recvKind = 'rgb'; this.fields.recvAsset = arg || ''; this.invoice = ''; state.view = 'receive'; return app.render();
      case 'send': this.asset = arg; this.pending = null; this.sent = null; this.fields.sendTo = ''; this.fields.sendAmt = ''; state.view = 'rgbsend'; return app.render();
      case 'issue': {
        const params = newAsset(this.fields);
        return this.run(async () => {
          this.message = 'Creating…'; app.render();
          const a = await this.withOutputs(() => this.service.issue(this.fields));
          this.issued = { ticker: a?.ticker || params.ticker, assetId: a?.assetId || '', supply: this.fields.supply };
          this.fields = { ...this.fields, name: '', ticker: '', supply: '' };
          await this.refresh();
        });
      }
      case 'issueAgain': this.issued = null; return app.render();
      case 'opt': { // a Receive option, "key:value"
        const [k, v] = String(arg).split(':');
        if (['recvType', 'recvExpiry'].includes(k)) { this.fields[k] = v; this.invoice = ''; this.message = ''; }
        return app.render();
      }
      case 'invoice': {
        const assetId = this.fields.recvAsset.trim(), a = assetId ? this.find(assetId) : null;
        const witness = this.recvType() === 'witness';
        let amount = 0;
        try {
          if (this.fields.recvAmt.trim()) {
            if (!a) throw new Error('Pick the token first to ask for a fixed amount.');
            amount = toBase(this.fields.recvAmt, a.precision);
          }
        } catch (e) { this.message = e.message; return app.render(); }
        const opts = { assetId, amount, durationSeconds: Number(this.fields.recvExpiry) || 86400, witness };
        return this.run(async () => {
          // a witness invoice needs no RGB output of ours; a blind one may need one set up first
          const r = witness ? await this.service.receive(opts) : await this.withOutputs(() => this.service.receive(opts));
          this.invoice = r.invoice;
          this.invoiceInfo = { witness, amount: amount ? this.amount(a, amount) : '', ticker: a?.ticker || '', expiry: Number(this.fields.recvExpiry) || 86400 };
        });
      }
      case 'review': {
        const a = this.find(this.asset);
        const invoice = this.fields.sendTo.trim();
        if (!a) { this.message = 'Pick a token first.'; return app.render(); }
        if (!/^rgb:/i.test(invoice)) { this.message = 'Paste the RGB invoice from the person you are paying. It starts with rgb:'; return app.render(); }
        return this.run(async () => {
          let d;
          try { d = await this.service.decode(invoice); } catch { throw new Error('That is not a valid RGB invoice. Ask them to make a new one.'); }
          if (d.assetId && d.assetId !== a.assetId) throw new Error(`This invoice asks for a different token, not ${a.ticker}.`);
          if (d.expirationTimestamp && d.expirationTimestamp <= Date.now() / 1000) throw new Error('This invoice has expired. Ask them to make a new one.');
          if (!this.profile.invoiceNets.includes(String(d.network).toLowerCase())) throw new Error(`This invoice is not for ${this.profile.label}.`);
          // an invoice with a fixed amount fills it in
          const amount = d.amount || toBase(this.fields.sendAmt, a.precision);
          if (d.amount) this.fields.sendAmt = this.amount(a, d.amount).replace(/,/g, '');
          if (amount > Number(a.balance?.spendable || 0)) throw new Error(`You can send up to ${this.amount(a, a.balance?.spendable)} ${a.ticker}.`);
          this.pending = Object.freeze({ assetId: a.assetId, ticker: a.ticker, invoice, amount, shown: this.amount(a, amount), witness: !!d.witness, fixed: !!d.amount });
        });
      }
      case 'cancel': this.pending = null; return app.render();
      case 'confirm': {
        const p = this.pending;
        if (!p) return;
        return this.run(async () => {
          this.message = 'Sending…'; app.render();
          const r = await this.service.send({ invoice: p.invoice, assetId: p.assetId, amount: String(p.amount), fee: RGB_FEE });
          this.sent = { txid: r?.txid || '', shown: p.shown, ticker: p.ticker };
          this.pending = null;
          await this.refresh();
        });
      }
      case 'backup': return this.run(async () => {
        const backup = await this.service.backup();
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `masked-rgb-${this.profile.id}-signet-backup.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.service.backupSaved();
        app.toast('RGB backup saved');
      });
      case 'restore': {
        const file = /** @type {HTMLInputElement} */ (document.getElementById('rgbRestore'))?.files?.[0];
        return this.run(async () => {
          if (!file || file.size > 40 * 1024 * 1024) throw new Error('Choose an RGB backup file (under 40 MB).');
          const backup = JSON.parse(await file.text());
          await this.close();
          this.phase = 'opening'; app.render();
          await this.open(await this.walletKey(), backup);
          app.toast('RGB restored');
        });
      }
      case 'profile': {
        if (this.busy) return;
        await this.close();
        try { localStorage.setItem(RGB_PROFILE_KEY, profileOf(arg).id); } catch { /* not remembered */ }
        this.service = null; this.phase = ''; this.tried = ''; this.message = '';
        this.ensure();
        return app.render();
      }
      case 'off': return this.run(async () => { await this.close(); this.tried = this.profile.id; app.toast('RGB is off until you reopen the wallet'); });
      default: return undefined;
    }
  }
}
