import { RGB_BETA_KEY, RGB_MAINNET, RGB_PROFILE_KEY, fromBase, newAsset, profileOf, toBase } from './config.mjs';
import { toHex, enc } from '../core/bytes.mjs';
import { encryptRgb } from './backup.mjs';
import { CLOUD_KEY, RgbCloud, cloudKeys, seal, open as openCloud } from './cloud.mjs';

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
  if (/no valid transport endpoints|invalid transport endpoint/i.test(full)) return 'Could not reach the transfer server named in this invoice. Allow MASKED to reach it when asked, or ask for an invoice from MASKED or another wallet using proxy.iriswallet.com.';
  if (/insufficient ?allocation|allocation ?slots|no (colorable|available) (utxo|output)s?/i.test(text)) {
    return `RGB is still setting up. Wait for one block (about 10 minutes), then try again. (${text})`;
  }
  if (/insufficient|not enough/i.test(text)) {
    if (profile.id === 'mainnet') return `Not enough confirmed BTC in RGB for the network fee. Tap Add BTC for RGB on Home, wait for a block, then try again. (${text})`;
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

/** Transfer servers MASKED can always reach (listed in the manifest). */
const KNOWN_PROXIES = ['proxy.iriswallet.com', 'rgb-proxy.utexo.com'];
/** rpcs://host/path → https://host/path (rpc:// → http://). */
export const proxyUrl = (e) => String(e).replace(/^rpcs:\/\//i, 'https://').replace(/^rpc:\/\//i, 'http://');
/** The invoice's transfer servers MASKED is not allowed to reach yet. */
export const newProxies = (endpoints) => (endpoints || []).map(proxyUrl).filter((u) => { try { return !KNOWN_PROXIES.includes(new URL(u).host); } catch { return false; } });
const hostOf = (u) => { try { return new URL(proxyUrl(u)).host; } catch { return String(u); } };

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
    /** @type {any} the token about to be created on mainnet, shown for review first */
    this.issueAsk = null;
    this.betaAsk = false; // the mainnet beta explanation is open on Home
    this.needBackup = false; // an action waited for the first backup: show the button where the message is
    this.betaOk = false;  // its "I understand" box is ticked
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
    /** mainnet encrypted cloud backup: last result in this session */
    this.cloud = { error: '', conflict: 0, saving: false, last: 0 };
    this.cloudAsk = false; // the "switch off cloud backup?" panel is open
    /** @type {any} */ this.cloudTimer = null;
    this.cloudApi = new RgbCloud();
  }

  // ---- encrypted cloud backup (mainnet) ----
  /** On by default; switched off per browser in Settings. */
  get cloudOn() { try { return localStorage.getItem(CLOUD_KEY) !== '0'; } catch { return false; } }
  get cloudVersion() { try { return Number(localStorage.getItem(`${RGB_MAINNET.vaultKey}.cloud-version`)) || 0; } catch { return 0; } }
  /** When the last cloud backup was saved (ms), 0 if never from this browser. */
  get cloudAt() { try { return Number(localStorage.getItem(`${RGB_MAINNET.vaultKey}.cloud-at`)) || 0; } catch { return 0; } }
  cloudMark(version) {
    try { localStorage.setItem(`${RGB_MAINNET.vaultKey}.cloud-version`, String(version)); localStorage.setItem(`${RGB_MAINNET.vaultKey}.cloud-at`, String(Date.now())); } catch { /* */ }
  }
  /** Save to the cloud a few seconds after RGB changes (one upload for several changes). */
  scheduleCloud(ms = 4000) {
    if (!this.isMain || !this.cloudOn || !this.ready || this.cloud.conflict) return;
    if (this.cloud.error && Date.now() - this.cloud.last < 60000) return; // after a failure, wait a minute
    clearTimeout(this.cloudTimer);
    this.cloudTimer = setTimeout(() => {
      this.cloudTimer = null;
      if (!this.ready || !this.service?.backupRequired) return;
      if (this.busy) return this.scheduleCloud(ms);
      this.run(() => this.cloudSave(), { quiet: true });
    }, ms);
  }
  /**
   * Upload the current RGB backup. Never throws: the result is in this.cloud and the manual file stays.
   * @param {{ replace?: boolean }} [o] replace: overwrite a newer backup another browser saved
   * @returns {Promise<boolean>} saved
   */
  async cloudSave({ replace = false } = {}) {
    if (!this.isMain || !this.cloudOn || !this.service) return false;
    this.cloud.saving = true; this.cloud.last = Date.now();
    try {
      const keys = await cloudKeys(this.app.lock?.secret);
      const envelope = await this.service.backup();
      const version = Math.max(this.cloudVersion, replace ? this.cloud.conflict : 0) + 1;
      await this.cloudApi.put(keys.id, await seal(keys, envelope, version));
      this.cloudMark(version);
      this.service.backupSaved();
      this.cloud.error = ''; this.cloud.conflict = 0;
      return true;
    } catch (e) {
      if (e?.status === 409) { this.cloud.conflict = Math.max(1, e.latest || 0); this.cloud.error = 'A newer RGB cloud backup was saved from another browser. Use RGB in one browser at a time.'; }
      else this.cloud.error = e?.message || 'The cloud backup did not save.';
      return false;
    } finally { this.cloud.saving = false; }
  }
  /**
   * Before a new mainnet RGB wallet is made in this browser: the latest cloud backup, if there is one.
   * Throws if the server can't be asked, so a wallet is never started over a backup that exists.
   */
  async cloudFind() {
    const keys = await cloudKeys(this.app.lock?.secret);
    let body;
    try { body = await this.cloudApi.latest(keys.id); } catch {
      throw new Error('Could not check for your RGB cloud backup. Try again, or switch off cloud backup in Settings → RGB to start without it.');
    }
    if (!body) return null;
    return { version: body.version, backup: await openCloud(keys, body, this.cloudVersion) };
  }

  get unlocked() { return this.app.state.lockState === 'open' && !!this.app.lock?.secret?.words; }
  get available() { return this.unlocked && (this.app.state.net === 'signet' || (this.app.state.net === 'main' && this.betaOn)); }
  /** Mainnet, beta not switched on yet: Home offers it. */
  get offerable() { return this.unlocked && this.app.state.net === 'main' && !this.betaOn; }
  get betaOn() { try { return localStorage.getItem(RGB_BETA_KEY) === '1'; } catch { return false; } }
  get isMain() { return this.profile.id === 'mainnet'; }
  /** sat/vB for RGB's own transactions: the wallet's fee choice on mainnet, 2 on the test networks. */
  fee() { return this.isMain ? String(Math.min(100, Math.max(1, Math.ceil(this.app.feeRate())))) : RGB_FEE; }
  /** The RGB network in use: mainnet on mainnet; on Signet, Public Signet unless Utexo Signet was picked. */
  get profile() {
    if (this.app.state.net === 'main') return RGB_MAINNET;
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

  /** Mainnet RGB's own keys: from the MASKED phrase on a path of their own, never MASKED's own addresses. */
  async mainSeed() {
    const s = this.app.lock?.secret;
    const d = await crypto.subtle.digest('SHA-256', enc.encode(`MASKED/rgb-mainnet-keys/v1\n${s.words}\n${s.passphrase || ''}`));
    return toHex(new Uint8Array(d));
  }

  // ---- invoices this wallet made (kept in this browser, per network) ----
  get invoicesKey() { return `${this.profile.vaultKey}.invoices`; }
  /** @returns {any[]} newest first */
  invoices() { try { return JSON.parse(localStorage.getItem(this.invoicesKey) || '[]'); } catch { return []; } }
  logInvoice(inv) {
    const list = [inv, ...this.invoices().filter((x) => x.invoice !== inv.invoice)].slice(0, 30);
    try { localStorage.setItem(this.invoicesKey, JSON.stringify(list)); } catch { /* the list is a convenience */ }
  }
  markCancelled(ids) {
    const set = new Set(ids);
    try { localStorage.setItem(this.invoicesKey, JSON.stringify(this.invoices().map((x) => (set.has(x.recipientId) ? { ...x, cancelled: true } : x)))); } catch { /* */ }
  }
  /** Where an invoice stands: its transfer once the payment shows up, else waiting or expired. */
  invoiceStatus(inv) {
    for (const [assetId, list] of Object.entries(this.data?.transfers || {})) {
      const t = (list || []).find((x) => String(x?.recipientId ?? '') === inv.recipientId);
      if (t) {
        const a = this.find(assetId), amt = Number(t.assignments?.[0]?.Fungible ?? 0);
        const what = a && amt ? `${this.amount(a, amt)} ${a.ticker}` : a?.ticker || '';
        if (t.status === 'Settled') return { key: 'done', text: `Received${what ? ` ${what}` : ''}` };
        if (t.status === 'Failed') return { key: 'failed', text: 'Failed' };
        if (t.status === 'WaitingConfirmations') return { key: 'confirming', text: `Paid${what ? `: ${what}` : ''}, waiting for a block` };
      }
    }
    if (inv.cancelled) return { key: 'expired', text: 'Cancelled' };
    if (inv.expiresAt && inv.expiresAt <= Date.now() / 1000) return { key: 'expired', text: 'Expired' };
    return { key: 'waiting', text: 'Waiting for payment' };
  }

  // ---- what the screens read ----
  assets() { return Object.values(this.data?.groups || {}).flat().filter((a) => a && typeof a === 'object' && a.assetId); }
  find(id) { return this.assets().find((a) => a.assetId === id) || null; }
  /**
   * Tokens an earlier beta counted twice: two of our witness invoices shared one address, so one payment settled
   * both. Same recipient, same transaction: only the first is real. Base units, 0 when nothing is doubled.
   */
  doubled(id) {
    const seen = new Set(); let extra = 0;
    for (const t of (this.data?.transfers?.[id] || []).slice().sort((x, y) => (Number(x.idx ?? x.batchTransferIdx) || 0) - (Number(y.idx ?? y.batchTransferIdx) || 0))) {
      if (t?.status !== 'Settled' || !/^Receive/.test(String(t?.kind ?? '')) || !t.recipientId || !t.txid) continue;
      const k = `${t.recipientId}|${t.txid}`;
      if (seen.has(k)) extra += Number(t.assignments?.[0]?.Fungible ?? t.amount ?? 0) || 0; else seen.add(k);
    }
    return extra;
  }
  /** The note about a doubled payment was read (for this amount: a new doubling shows it again). */
  doubledSeen(id, amount) { try { return localStorage.getItem(`${this.profile.vaultKey}.doubled-ok.${id}`) === String(amount); } catch { return false; } }
  /** The balance to show: what the engine reports, less anything counted twice. */
  bal(a) {
    const d = this.doubled(a.assetId), b = a.balance || {};
    const cut = (n) => Math.max(0, Number(n || 0) - d);
    return { settled: cut(b.settled), future: cut(b.future), spendable: cut(b.spendable), doubled: d };
  }
  history(id) { return (this.data?.transfers?.[id] || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); }
  /** Test BTC the RGB wallet holds: { settled, pending } in sats. */
  btc() {
    const b = this.data?.btc || {};
    const sum = (k) => Number(b.vanilla?.[k] || 0) + Number(b.colored?.[k] || 0);
    const settled = sum('settled');
    return { settled, pending: Math.max(0, sum('future') - settled) };
  }
  amount(a, n) { return fromBase(n, a?.precision || 0); }
  /** Ask each transfer server in the pending send whether it answers and speaks our protocol. */
  async checkProxies() {
    const p = this.pending;
    if (!p) return;
    const errors = [];
    for (const e of p.endpoints) {
      try { await this.service.checkProxy(proxyUrl(e)); return void (this.pending = { ...p, check: { ok: true, detail: '' } }); } catch (err) {
        errors.push(`${hostOf(e)}: ${brief(typeof err === 'string' ? err : err?.message || String(err))}`);
      }
    }
    this.pending = { ...p, check: { ok: false, detail: errors.join(' · ') } };
  }
  /** Blind unless chosen otherwise; witness by default when there is too little test BTC for a blind one. */
  /** Mainnet starts on "No BTC needed": a Private invoice reserves one of your RGB outputs (and the tokens on it) until it's paid or expires. */
  recvType() { return this.fields.recvType || (this.isMain || (this.data && this.btc().settled < RGB_BLIND_MIN) ? 'witness' : 'blind'); }

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
      const seed = this.isMain ? await this.mainSeed() : '';
      await service.open(password, this.isMain ? () => runtime.mnemonicFrom(seed) : runtime.newTestMnemonic, backup);
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
    clearInterval(this.timer); this.timer = null; clearTimeout(this.cloudTimer); this.cloudTimer = null; this.cloudAsk = false;
    this.ready = false; this.data = null; this.pending = null; this.invoice = ''; this.issued = null; this.issueAsk = null; this.sent = null; this.saved = false;
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
      // updated from a build that had the RGB servers in its install permissions: one tap to allow them again
      if (!await this.app.platform.hasOrigins(this.hostsFor())) { this.phase = 'allow'; this.message = ''; return; }
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
      if (this.isMain && this.service?.backupRequired) this.scheduleCloud();
      if (this.phase !== 'legacy' && this.phase !== 'allow') this.phase = '';
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
      if (this.btc().settled < 1500) throw new Error(this.isMain ? 'Add BTC for RGB first: tap Add BTC for RGB on Home, then wait for a block.' : 'Add test BTC first: tap Add test BTC on Home, then wait for a block.');
      this.message = 'Setting up RGB…'; this.app.render();
      await this.service.createUtxos(this.fee());
      await this.refresh();
      try { return await fn(); } catch (e2) {
        if (NEEDS_OUTPUTS.test(typeof e2 === 'string' ? e2 : e2?.message || '')) throw new Error('RGB is set up. Wait for one block (about 10 minutes), then tap again.');
        throw e2;
      }
    }
  }

  /** The servers an RGB network talks to: its block server and its transfer server. */
  hostsFor(p = this.profile) { return [p.sdk.indexerUrl, p.sdk.transportEndpoint]; }

  // ---- actions (data-rgb="…") ----
  async action(name, arg = '') {
    const app = this.app, state = app.state, f = state.f;
    // Chrome only shows its "allow" prompt straight from a click, so ask before anything else is awaited.
    // The RGB servers aren't in the install permissions: people who never use RGB are never asked.
    const opening = { betaYes: RGB_MAINNET, on: this.profile, retry: this.profile, profile: profileOf(arg) }[name];
    if (opening && (name !== 'betaYes' || this.betaOk)) {
      try { await app.platform.requestOrigins(this.hostsFor(opening)); } catch {
        this.phase = this.exists ? 'allow' : ''; this.message = 'RGB needs permission to reach its servers. Tap again and choose Allow.';
        return app.render();
      }
    }
    // mainnet beta: asked inside MASKED (the Home card opens a short explanation with a tick box)
    if (name === 'beta') { if (this.offerable) { this.betaAsk = true; this.betaOk = false; } return app.render(); }
    if (name === 'betaNo') { this.betaAsk = false; return app.render(); }
    if (name === 'betaYes') {
      if (!this.offerable || !this.betaOk) return app.render();
      try { localStorage.setItem(RGB_BETA_KEY, '1'); } catch { /* stays off */ }
      this.betaAsk = false; this.tried = ''; this.phase = '';
      return this.action('on');
    }
    if (!this.available) throw new Error('Open your wallet on Signet first.');
    // mainnet: one backup must exist before RGB is used (it holds the RGB keys); after that, Home reminds
    // whenever something changed, without blocking (a block on every change would block every receive)
    if (this.isMain && ['invoice', 'review', 'confirm', 'issue'].includes(name) && !this.service?.everBackedUp && this.cloudOn && !this.busy) {
      this.busy = true; app.render();
      try { await this.cloudSave(); } finally { this.busy = false; }
    }
    if (this.isMain && ['invoice', 'review', 'confirm', 'issue'].includes(name) && !this.service?.everBackedUp) {
      this.message = 'Save your RGB backup once before using RGB on mainnet. Your recovery phrase alone can\'t bring RGB tokens back.';
      this.needBackup = true;
      return app.render();
    }
    this.needBackup = false;
    if (['fund', 'mint', 'token', 'receive', 'send'].includes(name)) this.message = ''; // a new screen starts clean
    switch (name) {
      case 'on': return this.run(async () => {
        this.phase = 'opening'; this.tried = this.profile.id; app.render();
        const found = this.isMain && !this.exists && this.cloudOn ? await this.cloudFind() : null;
        if (found) {
          await this.open(await this.walletKey(), found.backup);
          this.cloudMark(found.version); this.service.backupSaved();
          app.toast('RGB restored from your cloud backup');
        } else {
          await this.open(await this.walletKey());
          if (this.isMain && this.cloudOn) await this.cloudSave(); // the new keys are backed up straight away
          app.toast('RGB is on');
        }
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
        // mainnet: a review step inside MASKED before anything is created
        if (this.isMain && arg !== 'go') { this.issueAsk = { ...params, supply: this.fields.supply }; this.message = ''; return app.render(); }
        this.issueAsk = null;
        return this.run(async () => {
          this.message = 'Creating…'; app.render();
          const a = await this.withOutputs(() => this.service.issue(this.fields));
          this.issued = { ticker: a?.ticker || params.ticker, assetId: a?.assetId || '', supply: this.fields.supply };
          this.fields = { ...this.fields, name: '', ticker: '', supply: '' };
          await this.refresh();
        });
      }
      case 'issueAgain': this.issued = null; return app.render();
      case 'issueEdit': this.issueAsk = null; return app.render();
      case 'cancelInv': { // one invoice (arg = recipient ID) or every open one (no arg)
        const ids = arg ? [arg] : this.invoices().filter((x) => this.invoiceStatus(x).key === 'waiting').map((x) => x.recipientId);
        return this.run(async () => {
          const n = await this.service.cancelInvoices(arg ? ids : null);
          this.markCancelled(ids);
          if (this.invoice && ids.some((id) => this.invoices().find((x) => x.recipientId === id)?.invoice === this.invoice)) this.invoice = '';
          await this.refresh();
          app.toast(n ? `${n} invoice${n === 1 ? '' : 's'} cancelled` : 'No open invoices: the tokens are held by a transfer in progress');
        });
      }
      case 'showInv': { // reopen an invoice from the list
        const inv = this.invoices().find((x) => x.recipientId === arg);
        if (inv) { this.invoice = inv.invoice; this.invoiceInfo = { witness: inv.witness, amount: inv.amount, ticker: inv.ticker, expiry: inv.expiry }; }
        return app.render();
      }
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
          this.logInvoice({ invoice: r.invoice, recipientId: r.recipientId, at: Date.now(), expiresAt: Number(r.expirationTimestamp) || Math.floor(Date.now() / 1000) + this.invoiceInfo.expiry, ...this.invoiceInfo });
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
          if (amount > this.bal(a).spendable) throw new Error(`You can send up to ${this.amount(a, this.bal(a).spendable)} ${a.ticker}.`);
          const endpoints = d.transportEndpoints?.length ? d.transportEndpoints : [this.profile.sdk.transportEndpoint];
          const ask = newProxies(endpoints);
          this.pending = { assetId: a.assetId, ticker: a.ticker, invoice, amount, shown: this.amount(a, amount), witness: !!d.witness, fixed: !!d.amount, endpoints, proxies: endpoints.map(hostOf), ask, check: null };
          // a server we can already reach is checked now; a new one waits for "Allow" (Chrome asks on that click)
          if (!ask.length) await this.checkProxies();
        });
      }
      case 'allowProxy': {
        const p = this.pending;
        if (!p) return;
        return this.run(async () => {
          await app.platform.requestOrigins(p.ask); // first: still the click, so Chrome can show its prompt
          this.pending = { ...p, ask: [] };
          await this.checkProxies();
        });
      }
      case 'recheck': return this.run(() => this.checkProxies());
      case 'cancel': this.pending = null; return app.render();
      case 'confirm': {
        const p = this.pending;
        if (!p) return;
        return this.run(async () => {
          this.message = 'Sending…'; app.render();
          if (!p.check?.ok) throw new Error('Check the transfer server first.');
          const r = await this.service.send({ invoice: p.invoice, assetId: p.assetId, amount: String(p.amount), fee: this.fee() });
          this.sent = { txid: r?.txid || '', shown: p.shown, ticker: p.ticker };
          this.pending = null;
          await this.refresh();
        });
      }
      case 'backup': return this.run(async () => {
        const backup = await this.service.backup();
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `masked-rgb-${this.profile.id}-backup.json`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.service.backupSaved();
        if (this.needBackup) { this.needBackup = false; this.message = 'Backup saved. You can continue.'; }
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
      case 'doubledOk': {
        try { localStorage.setItem(`${this.profile.vaultKey}.doubled-ok.${arg}`, String(this.doubled(arg))); } catch { /* shows again next time */ }
        return app.render();
      }
      case 'cloudOn': return this.run(async () => {
        try { localStorage.setItem(CLOUD_KEY, '1'); } catch { /* */ }
        this.cloud = { error: '', conflict: 0, saving: false, last: 0 };
        if (this.ready && await this.cloudSave()) app.toast('Cloud backup is on');
      });
      case 'cloudOff': this.cloudAsk = true; return app.render();
      case 'cloudKeep': this.cloudAsk = false; return app.render();
      case 'cloudOffYes': return this.run(async () => {
        this.cloudAsk = false; clearTimeout(this.cloudTimer);
        try { await this.cloudApi.remove(await cloudKeys(app.lock?.secret)); } catch (e) {
          throw new Error(`Cloud backup is still on: ${e?.message || 'the server did not answer'}. Try again.`);
        }
        try { localStorage.setItem(CLOUD_KEY, '0'); localStorage.removeItem(`${RGB_MAINNET.vaultKey}.cloud-at`); } catch { /* */ }
        this.cloud = { error: '', conflict: 0, saving: false, last: 0 };
        if (this.ready) try { localStorage.setItem(this.service.dirtyKey, '1'); } catch { /* */ } // the file is the only backup now
        app.toast('Cloud backup is off and deleted from the server. Save backup files yourself.', 6000);
      });
      case 'cloudRetry': return this.run(async () => { this.cloud.last = 0; if (await this.cloudSave()) app.toast('Cloud backup saved'); });
      case 'cloudReplace': return this.run(async () => { if (await this.cloudSave({ replace: true })) app.toast('This browser\'s RGB state is now the cloud backup'); });
      case 'betaOff': return this.run(async () => { await this.close(); try { localStorage.setItem(RGB_BETA_KEY, '0'); } catch { /* */ } app.toast('RGB beta is off. Your RGB wallet stays saved in this browser.'); });
      default: return undefined;
    }
  }
}
