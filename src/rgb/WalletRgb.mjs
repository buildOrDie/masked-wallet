import { RGB_BETA_KEY, RGB_MAINNET, RGB_PROFILE_KEY, fromBase, newAsset, profileOf, toBase } from './config.mjs';
import { toHex, enc } from '../core/bytes.mjs';
import { encryptRgb } from './backup.mjs';
import { CLOUD_KEY, RgbCloud, cloudKeys, seal, open as openCloud } from './cloud.mjs';

/** Shown when another copy of this wallet saved newer RGB data than this one has. */
export const RGB_CONFLICT_MSG = 'This wallet\'s RGB is also open in another copy of MASKED (another browser or profile, a second MASKED extension, or the phone app), and that copy saved newer RGB data. Moving tokens here could use outputs that copy already spent. Use RGB in that copy, or, if this one has your latest tokens, open Settings → RGB → cloud backup and make it the backup.';


/** Fee rate for RGB's own transactions on the test networks (sat/vB). */
// Signet: blocks are rarely full, 1 sat/vB confirms
const RGB_FEE = '1';
/** Below this much test BTC (sats), Home suggests adding some: enough for a few RGB transactions. */
export const RGB_LOW_BTC = 3000;
/** What "Add test BTC" sends from the Public balance. */
export const RGB_FUND_BTC = '0.0003';
/** Signet: below this much test BTC (sats) in RGB, MASKED tops it up from Public by itself (RGB_FUND_SATS). */
export const RGB_AUTO_FUND_BELOW = 10_000;
export const RGB_FUND_SATS = 30_000;
/**
 * Bitcoin added to the RGB balance goes in as a few coins, not one: every RGB buy or move spends a coin of its own,
 * so several buys in a row don't wait for the first one's change (or get refused for reusing its coin).
 */
export const rgbFundParts = (sats) => Math.max(1, Math.min(4, Math.floor(Number(sats) / 5000)));

/**
 * A readable message for an RGB failure. The engine often throws plain strings, not Error objects.
 * @param {unknown} error
 * @param {{ id: string, label: string }} [profile]
 */
export function rgbError(error, profile = profileOf('utexo')) {
  const full = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error?.['message'] ?? ''));
  const text = brief(full);
  if (full) console.warn('[RGB] error:', full);
  if (/did not answer in time|timed? ?out|\b429\b|too many requests|status: 50[234]\b|bad gateway|service unavailable|gateway time/i.test(full)) return `The ${profile.label} block server is busy or down right now.`;
  if (/invalid indexer/i.test(full) && (profile.id === 'mainnet' || profile.id === 'public')) return `RGB couldn't reach a block server (mempool.space or blockstream.info). If you use an ad blocker, VPN or firewall, allow these sites, or set your own server in Settings → Blockchain server. Then try again.`;
  if (/invalid indexer|failed to fetch|network ?error|internet|ECONN|proxy/i.test(full)) return `Can't reach the ${profile.label} RGB servers right now. Check your connection and try again. (${text})`;
  // something of this wallet is still waiting for its block (a move, a sale, a purchase): one clear answer instead of
  // the engine's words, which differ by step ("none of its inputs…", "isn't a settled RGB output", UnsafeHistory…)
  if (/none of its inputs is an RGB output|isn't a settled RGB output|that output can't be listed|OWN_MOVE_PENDING/i.test(full)) {
    return `Your tokens are still settling from your last move, sale or purchase. Wait for its block (about 10 minutes), then try again. Nothing was sent. (${text})`;
  }
  if (/unsafe ?history/i.test(full)) return `The tokens' last transfer isn't confirmed yet. Try again after its block (about 10 minutes). Nothing was sent.`;
  if (/no valid transport endpoints|invalid transport endpoint/i.test(full)) return 'Could not use the transfer server named in this invoice: it is unreachable, or it speaks the old protocol (0.2). Allow MASKED to reach it when asked, or ask for a new invoice from an up-to-date wallet.';
  // the Bitcoin node refused the transaction: say why, in full (the reason is at the end of a long message)
  if (/sendrawtransaction|failed ?broadcast/i.test(full)) {
    const reason = (full.replace(/\\"/g, '"').match(/"message"\s*:\s*"([^"]+)"/) || [])[1] || '';
    if (/rejecting replacement|mempool-conflict|missingorspent|missing-inputs|insufficient fee/i.test(reason)) {
      return `Not sent: a coin it used was already spent by another of your transactions that hasn't confirmed yet. Nothing left your wallet. Wait for one block, tap Refresh, then try again. (${reason})`;
    }
    if (/min relay fee|mempool min fee|fee not met/i.test(reason)) return `Not sent: the network fee was too low. Pick a higher fee and try again. (${reason})`;
    return `Not sent: the Bitcoin network refused the transaction${reason ? `: ${reason}` : ` (${text})`}`;
  }
  if (/insufficient total assignments|InsufficientAssignments/i.test(text)) {
    return `What you're sending isn't free to move yet: the output it sits on is still tied to something else (a transfer waiting for a block, a send the other wallet hasn't accepted, an open invoice or a listing). Tap Refresh, wait for the next block, then try again. Nothing was sent. (${text})`;
  }
  if (/insufficient ?allocation|allocation ?slots|no (colorable|available) (utxo|output)s?/i.test(text)) {
    return `RGB is still setting up. Wait for one block (about 10 minutes), then try again. (${text})`;
  }
  if (/insufficient|not enough/i.test(text)) {
    if (profile.id === 'mainnet') return `Not enough confirmed bitcoin in your RGB balance for the network fee. Tap Add from Bitcoin under RGB balance on Home, wait for a block, then try again. (${text})`;
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

/** rpcs://host/path → https://host/path (rpc:// → http://). */
export const proxyUrl = (e) => String(e).replace(/^rpcs:\/\//i, 'https://').replace(/^rpc:\/\//i, 'http://');
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
/** Send a signed Instant listing to its market (the seller token proves it's this seller's offer). */
/** Why the market refused the last listing sent to it (shown to the seller). */
let lastRefusal = '';
async function publishInstant(e, v) {
  if (!e?.market || !e?.token || !v?.psbt) return false;
  const r = await fetch(`${e.market}/api/swap/offers/${encodeURIComponent(v.offerId)}/presigned`, {
    method: 'POST', credentials: 'omit', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-swap-token': e.token },
    body: JSON.stringify({ psbt: v.psbt, consignment: v.consignment, templateTxid: v.templateTxid, sellerOutpoint: v.sellerOutpoint, ...(v.media?.length ? { media: v.media } : {}) }),
  });
  // a refusal (offer cancelled or closed on the market) is final too: don't send it again, but say so
  if (!r.ok && r.status >= 400 && r.status < 500) {
    const why = await r.json().then((j) => j?.error, () => '').catch(() => '');
    lastRefusal = String(why || `refused (${r.status})`);
    return 'refused';
  }
  return r.ok;
}

/** A refresh this recent, by any MASKED window, is used as is when RGB opens. */
export const OPEN_FRESH_MS = 60_000;
/** With nothing under way, the open popup refreshes RGB this often. */
export const IDLE_REFRESH_MS = 5 * 60_000;

/** The verified list (escrow /api/nft-verified) as Map asset ID → { slug, name }. */
export function trustMap(list) {
  const m = new Map();
  for (const c of Array.isArray(list) ? list : []) {
    const slug = String(c?.slug || ''), name = String(c?.name || c?.ticker || '').slice(0, 40);
    if (!/^[a-z0-9-]{2,31}$/.test(slug) || !name) continue;
    const ids = Array.isArray(c.assetIds) ? c.assetIds : [], ns = Array.isArray(c.ns) ? c.ns : [];
    ids.forEach((id, k) => {
      if (typeof id !== 'string' || !id.startsWith('rgb:')) return;
      const n = Number(ns[k]);
      m.set(id, { slug, name, ...(Number.isInteger(n) && n > 0 ? { n } : {}) });
    });
  }
  return m;
}

export class WalletRgb {
  constructor(app) {
    this.app = app;
    this.service = null;
    /** @type {Map<string, string>} NFT images by digest: data: URL, '' while loading */
    /** @type {Map<string, string | { loading?: boolean, failedAt?: number, data?: any }>} picture digest → data URL, or its state */
    this.imgs = new Map();
    /** @type {Map<string, any>} */ this.metas = new Map();
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
    this.cloudPick = 0; // Earlier backups: the version picked, waiting for the second tap
    this.outputs = null; // Settings → RGB → What's in this wallet (LiteWallet.outputsReport)
    /** when RGB last caught up with the chain (ms) */
    this.refreshedAt = 0;
    /** @type {string|null} the Instant listing whose Cancel was tapped (asks once) */
    this.cancelAsk = null;
    /** @type {any} */ this.cloudTimer = null;
    this.cloudApi = new RgbCloud();
    /** sell automatically: the setting (read from Chrome at start) and the offers set to it */
  }

  // ---- sell automatically ----

  // ---- encrypted cloud backup (mainnet and Signet: each network its own backup) ----
  /** On by default; switched off per browser in Settings. */
  get cloudOn() { try { return localStorage.getItem(CLOUD_KEY) !== '0'; } catch { return false; } }
  /**
   * Is the cloud backup newer than what this copy last saved or loaded? Then another copy of this wallet (same
   * recovery phrase) moved on: flag the conflict, so token moves pause and Settings offers to load it. Never throws.
   * @returns {Promise<boolean>} newer
   */
  async checkCloudNewer() {
    // nothing saved or loaded by this copy yet: nothing to compare with (the first save tells)
    if (!this.cloudOn || !this.ready || !this.cloudVersion) return false;
    let latest = 0;
    try { latest = await this.cloudApi.version((await this.cloudKeysNow()).id); } catch { return false; }
    if (latest > this.cloudVersion) {
      this.cloud = { ...this.cloud, conflict: latest, error: 'A newer RGB cloud backup was saved from another browser. Use RGB in one browser at a time.' };
      this.app.render?.();
      return true;
    }
    return false;
  }
  /** Before tokens move or new RGB state is made: stop if another copy of this wallet is newer. */
  async requireLatest() {
    if (this.cloud?.conflict || await this.checkCloudNewer()) throw new Error(RGB_CONFLICT_MSG);
  }
  get cloudVersion() { try { return Number(localStorage.getItem(`${this.profile.vaultKey}.cloud-version`)) || 0; } catch { return 0; } }
  /** When a backup file was last written from this browser (ms), 0 if never. */
  /** Home → RGB: Tokens or NFTs, as last picked in this browser. */
  get homeTab() { try { return localStorage.getItem('masked.rgb.homeTab') || ''; } catch { return ''; } }
  set homeTab(v) { try { localStorage.setItem('masked.rgb.homeTab', v); } catch { /* private window: this session only */ } }
  get fileAt() { try { return Number(localStorage.getItem(`${this.profile.vaultKey}.file-at`)) || 0; } catch { return 0; } }
  get canShareInvoice() {
    if (!this.isMain) return true;
    try {
      return !!this.service && !this.service.backupRequired && localStorage.getItem(`${this.profile.vaultKey}.confirmed-backup`) === '1';
    } catch { return false; }
  }
  confirmBackup(gen) {
    localStorage.setItem(`${this.profile.vaultKey}.confirmed-backup`, '1');
    this.service.backupSaved(gen);
  }
  /** When the last cloud backup was saved (ms), 0 if never from this browser. */
  get cloudAt() { try { return Number(localStorage.getItem(`${this.profile.vaultKey}.cloud-at`)) || 0; } catch { return 0; } }
  cloudMark(version) {
    try { localStorage.setItem(`${this.profile.vaultKey}.cloud-version`, String(version)); localStorage.setItem(`${this.profile.vaultKey}.cloud-at`, String(Date.now())); } catch { /* */ }
  }
  /** The latest version the backup server keeps (0 when it can't be asked). */
  async serverVersion(id) { try { return Number(await this.cloudApi.version(id)) || 0; } catch { return 0; } }
  /** The cloud keys of the RGB network in use. */
  cloudKeysNow() { return cloudKeys(this.app.lock?.secret, this.profile.id); }
  /** Save to the cloud a few seconds after RGB changes (one upload for several changes). */
  scheduleCloud(ms = 4000) {
    if (!this.cloudOn || !this.ready || this.cloud.conflict) return;
    if (this.cloud.error && Date.now() - this.cloud.last < 60000) return; // after a failure, wait a minute
    clearTimeout(this.cloudTimer);
    this.cloudTimer = setTimeout(() => {
      this.cloudTimer = null;
      if (!this.ready || !this.service?.backupRequired) return;
      // in the background: the wallet stays usable while it uploads (the RGB engine part waits its turn)
      this.cloudSave().then(() => this.app.render()).catch(() => {});
    }, ms);
  }
  /**
   * Upload the current RGB backup. Never throws: the result is in this.cloud and the manual file stays.
   * @param {{ replace?: boolean }} [o] replace: overwrite a newer backup another browser saved
   * @returns {Promise<boolean>} saved
   */
  cloudSave(o = {}) {
    // one upload at a time, in order: two at once would number the same version and look like another browser's
    const run = (this.cloudChain || Promise.resolve()).then(() => this.cloudSaveNow(o));
    this.cloudChain = run.catch(() => {});
    return run;
  }
  async cloudSaveNow({ replace = false } = {}) {
    if (!this.cloudOn || !this.service) return false;
    this.cloud.saving = true; this.cloud.last = Date.now();
    try {
      const t0 = Date.now();
      const keys = await this.cloudKeysNow();
      const envelope = await this.service.backup();
      const gen = this.service.backupGen, t1 = Date.now();
      // replace (this browser's RGB becomes the backup: after loading an earlier version, an undo, a repair, or the
      // person's choice): numbered above the server's latest, which is newer than the version just loaded. Numbered
      // from the loaded version, the server refused it as older, and the "newer backup" it then offered to load was
      // the very state the person was moving away from.
      let latest = replace ? Math.max(this.cloud.conflict, await this.serverVersion(keys.id)) : 0;
      let version = Math.max(this.cloudVersion, latest) + 1;
      const body = await seal(keys, envelope, version), t2 = Date.now();
      try { await this.cloudApi.put(keys.id, body); } catch (e) {
        // saved meanwhile by the other copy: once more above it, only when replacing on purpose
        if (!replace || /** @type {any} */ (e)?.status !== 409) throw e;
        latest = Math.max(latest, Number(/** @type {any} */ (e).latest) || 0, await this.serverVersion(keys.id));
        version = Math.max(version, latest) + 1;
        await this.cloudApi.put(keys.id, await seal(keys, envelope, version));
      }
      this.cloudMark(version);
      this.confirmBackup(gen);
      this.cloud.error = ''; this.cloud.conflict = 0;
      // where a backup spends its time, in the console (engine = the RGB engine making it)
      try { console.info('[MASKED] RGB cloud backup', JSON.stringify({ ...this.service.lastBackupTimings, total: Date.now() - t0, backup: t1 - t0, seal: t2 - t1, upload: Date.now() - t2, uploadMb: +(String(body.data).length / 1048576).toFixed(2) })); } catch { /* no console */ }
      return true;
    } catch (e) {
      if (e?.status === 409) { this.cloud.conflict = Math.max(1, e.latest || 0); this.cloud.error = 'A newer RGB cloud backup was saved from another browser. Use RGB in one browser at a time.'; }
      else this.cloud.error = e?.message || 'The cloud backup did not save.';
      return false;
    } finally { this.cloud.saving = false; }
  }
  /**
   * Before a new RGB wallet is made in this browser: the latest cloud backup of this network, if there is one.
   * Throws if the server can't be asked, so a wallet is never started over a backup that exists.
   */
  async cloudFind() {
    const keys = await this.cloudKeysNow();
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
  /** The fee picked on the send screen (Slow / Avg / Fast / Custom). RGB takes whole sat/vB, so it rounds up. */
  fee() { return this.isMain ? String(Math.min(500, Math.max(1, Math.ceil(this.app.feeRate())))) : RGB_FEE; }
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

  /**
   * RGB's own keys for a new wallet: from the MASKED phrase on a path of their own per network, never MASKED's own
   * addresses. The same phrase makes the same RGB wallet in any browser (a wallet made before this kept its keys).
   */
  async mainSeed() {
    const s = this.app.lock?.secret;
    const label = this.isMain ? 'MASKED/rgb-mainnet-keys/v1' : `MASKED/rgb-${this.profile.id}-keys/v1`;
    const d = await crypto.subtle.digest('SHA-256', enc.encode(`${label}\n${s.words}\n${s.passphrase || ''}`));
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
  /** Fungible tokens (NIA, IFA, BFA). NFTs are listed apart: nfts(). */
  assets() { return Object.entries(this.data?.groups || {}).filter(([k]) => k !== 'uda').flatMap(([, v]) => v || []).filter((a) => a && typeof a === 'object' && a.assetId); }
  /** NFTs (RGB21 / UDA) held or on their way in. */
  nfts() { return (this.data?.groups?.uda || []).filter((a) => a?.assetId && (Number(a.balance?.future) > 0 || Number(a.balance?.settled) > 0)).map((a) => ({ ...a, nft: true, precision: 0 })); }
  isNft(a) { return !!a?.nft; }
  /** This wallet's open Instant listing of an asset (on sale, going live, cancelling), or null. */
  openListing(assetId) {
    let list = [];
    try { list = this.service?.instantListings?.() || []; } catch { list = []; }
    return list.find((e) => e?.assetId === assetId && ['ready', 'moving', 'outdated', 'cancelling'].includes(String(e.stage))) || null;
  }
  /** Why an NFT can't be sent while it's listed, or ''. */
  listedWhy(a) {
    const e = this.isNft(a) ? this.openListing(a.assetId) : null;
    if (!e) return '';
    return e.stage === 'cancelling'
      ? `${a.name} is coming back from a cancelled listing. It can be sent after that cancel's block (about 10 minutes).`
      : `${a.name} is in Your listings (${e.stage === 'ready' ? 'on sale' : e.stage === 'moving' ? 'going live' : 'can\'t sell'}). Its output is promised to that listing, so it can't be sent. Cancel the listing first: Home → Your listings.`;
  }
  /**
   * NFTs by collection: [{ key, name, verified, list }]. A whitelisted collection (the verified list names each of its
   * asset IDs) comes first and groups exactly its NFTs; any other NFT is grouped by its ticker, as unverified, since
   * anyone can mint an NFT with any name.
   */
  collections() {
    const num = (a) => Number((String(a.name).match(/#\s*(\d+)/) || [])[1] ?? Infinity);
    const trust = this.nftTrust();
    const m = new Map();
    for (const a of this.nfts()) {
      const v = trust.get(a.assetId);
      const key = v ? `v:${v.slug}` : `u:${String(a.ticker || '?')}`;
      if (!m.has(key)) m.set(key, { key, name: v ? v.name : String(a.ticker || '?'), verified: !!v, list: [] });
      m.get(key).list.push(a);
    }
    return [...m.values()].map((c) => ({ ...c, list: c.list.sort((x, y) => num(x) - num(y) || String(x.name).localeCompare(String(y.name))) }))
      .sort((x, y) => Number(y.verified) - Number(x.verified) || y.list.length - x.list.length || x.key.localeCompare(y.key));
  }
  /** The collection an NFT is listed under (its key, for the collection page). */
  collectionOf(a) {
    const v = this.nftTrust().get(a?.assetId);
    return v ? { key: `v:${v.slug}`, name: v.name, verified: true } : { key: `u:${String(a?.ticker || '?')}`, name: String(a?.ticker || '?'), verified: false };
  }
  find(id) { return this.assets().find((a) => a.assetId === id) || this.nfts().find((a) => a.assetId === id) || null; }
  /**
   * An NFT's image as a data: URL once loaded (checked against the digest in the NFT), '' while loading or when no
   * transfer server has it. Loads in the background and re-renders.
   */
  nftImg(a) {
    const d = a?.media?.digest;
    if (!d) return '';
    const hit = this.imgs.get(d);
    if (typeof hit === 'string') return hit;
    // loading, or not found lately: no new try on every redraw. Tried again after a refresh (the NFT's own copy comes
    // with its transfer) or after 30 seconds
    if (hit && (hit.loading || (hit.data === this.data && Date.now() - Number(hit.failedAt || 0) < 30_000))) return '';
    this.imgs.set(d, { loading: true });
    const failed = () => this.imgs.set(d, { failedAt: Date.now(), data: this.data });
    // a verified collection's picture from MASKED's server when this wallet doesn't hold the NFT's copy yet (an NFT
    // on its way): the wallet shows it only if it matches the NFT's fingerprint
    const v = this.nftTrust().get(a.assetId), base = this.profile?.nftMedia;
    const url = v?.n && base ? `${base}/${v.slug}/${v.n}` : '';
    Promise.resolve(this.service?.nftImage?.(a.media, url ? { url } : undefined)).then((src) => { if (src) { this.imgs.set(d, src); this.redrawSoon(); } else failed(); }, failed);
    return '';
  }
  /** One redraw for pictures that arrive together, not one per picture. */
  redrawSoon() {
    if (this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => { this.redrawTimer = null; this.app.render?.(); }, 60);
  }
  /**
   * The whitelisted NFT collections (MASKED's launchpad's verified list): Map asset ID → { slug, name }. Loaded in the
   * background (kept 10 minutes, and the last list across openings); empty while loading or without one.
   */
  nftTrust() {
    const url = this.profile?.nftVerified;
    if (!url) return new Map();
    const KEY = 'masked.rgb.nftVerified';
    if (!this.trust) {
      this.trust = { map: new Map(), at: 0, loading: false };
      try { const c = JSON.parse(localStorage.getItem(KEY) || 'null'); if (c?.url === url && Array.isArray(c.list)) this.trust.map = trustMap(c.list); } catch { /* none */ }
    }
    const t = this.trust;
    if (!t.loading && Date.now() - t.at > 600_000) {
      t.loading = true;
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctl?.abort(), 8000);
      fetch(url, { signal: ctl?.signal, cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))).then((list) => {
        if (!Array.isArray(list)) return;
        t.map = trustMap(list); t.at = Date.now();
        try { localStorage.setItem(KEY, JSON.stringify({ url, list })); } catch { /* memory only */ }
        this.redrawSoon();
      }).catch(() => { t.at = Date.now() - 540_000; /* again in a minute */ }).finally(() => { clearTimeout(timer); t.loading = false; });
    }
    return t.map;
  }
  /** An NFT's traits once read from its metadata.json (nftTraits), null while loading or without one. */
  nftMeta(a) {
    const key = (a?.files || []).map((f) => f.digest).join(',');
    if (!key) return null;
    this.metas ??= new Map();
    if (this.metas.has(key)) return this.metas.get(key);
    this.metas.set(key, null);
    Promise.resolve(this.service?.nftMeta?.(a.files)).then((m) => { if (m) { this.metas.set(key, m); this.app.render?.(); } }, () => {});
    return null;
  }
  /**
   * Tokens an earlier beta counted twice: two of our witness invoices shared one address, so one payment settled
   * both. Same recipient, same transaction: only the first is real. Base units, 0 when nothing is doubled.
   */
  doubled(id) { return this.doubles(id).reduce((n, d) => n + d.amount, 0); }
  /** Each payment counted twice: its extra amount and the coin it sits on ("txid:vout", '' if unknown). */
  doubles(id) {
    const seen = new Set(); const out = [];
    for (const t of (this.data?.transfers?.[id] || []).slice().sort((x, y) => (Number(x.idx ?? x.batchTransferIdx) || 0) - (Number(y.idx ?? y.batchTransferIdx) || 0))) {
      if (t?.status !== 'Settled' || !/^Receive/.test(String(t?.kind ?? '')) || !t.recipientId || !t.txid) continue;
      const k = `${t.recipientId}|${t.txid}`;
      if (!seen.has(k)) { seen.add(k); continue; }
      const coin = t.receiveUtxo?.txid ? `${t.receiveUtxo.txid}:${t.receiveUtxo.vout}` : '';
      out.push({ amount: Number(t.assignments?.[0]?.Fungible ?? t.amount ?? 0) || 0, coin });
    }
    return out;
  }
  /**
   * The balance to show: what the engine reports, less anything counted twice. The total always drops by the
   * double count; "available" only when it sits on a coin the engine counts as spendable. On a locked coin the
   * engine has already left it out of "available", and taking it off again would count it twice the other way.
   */
  bal(a) {
    const all = this.doubles(a.assetId), b = a.balance || {};
    const locked = new Set(this.data?.locked || []);
    const d = all.reduce((n, x) => n + x.amount, 0);
    const free = all.filter((x) => !x.coin || !locked.has(x.coin)).reduce((n, x) => n + x.amount, 0);
    const cut = (n, by) => Math.max(0, Number(n || 0) - by);
    // incoming transfers the network dropped never arrive: not counted as incoming
    // (an NFT's assignment is 'NonFungible': its one token)
    const units = (x) => (x === 'NonFungible' || x?.NonFungible !== undefined ? 1 : Number(x?.Fungible ?? x?.amount ?? 0));
    const gone = (this.data?.transfers?.[a.assetId] || []).filter((t) => this.isDropped(t) && String(t.status) === 'WaitingConfirmations')
      .reduce((n, t) => n + (t.assignments || []).reduce((m, x) => m + units(x), 0), 0);
    // and never more incoming than the waiting receives listed: the engine can count one twice (a dropped one, say)
    const sum = (t) => (t.assignments || []).reduce((m, x) => m + units(x), 0);
    const visible = (this.data?.transfers?.[a.assetId] || []).filter((t) => String(t?.kind || '').startsWith('Receive') && ['WaitingCounterparty', 'WaitingConfirmations'].includes(String(t.status)) && !this.isDropped(t))
      .reduce((n, t) => n + sum(t), 0);
    const settled = cut(b.settled, d);
    // tokens promised to Instant listings: the engine counts them as spendable, but a send can't use them
    const listed = Math.min(Number(this.data?.listed?.[a.assetId] || 0), settled);
    return { settled, future: Math.min(cut(b.future, d + gone), settled + visible), spendable: cut(cut(b.spendable, free), listed), doubled: d, listed };
  }
  /** The note about a doubled payment was read (for this amount: a new doubling shows it again). */
  doubledSeen(id, amount) { try { return localStorage.getItem(`${this.profile.vaultKey}.doubled-ok.${id}`) === String(amount); } catch { return false; } }
  /** A send this browser can't broadcast any more (signed before a restore; the signature isn't in backups). */
  stranded(t) { return (this.data?.stranded || []).includes(Number(t?.batchTransferIdx)); }
  /** Sends of this token the other wallet hasn't accepted yet (not broadcast, so they can be cancelled). */
  unsent(id) { return (this.data?.transfers?.[id] || []).filter((t) => t?.kind === 'Send' && t?.status === 'WaitingCounterparty'); }
  /** Newest first, with transfers still waiting on top (an old one stuck waiting doesn't hide among the days). */
  history(id) {
    const waiting = (t) => ['WaitingCounterparty', 'WaitingConfirmations'].includes(String(t.status)) && !this.isDropped(t);
    return (this.data?.transfers?.[id] || []).slice().sort((a, b) => (Number(waiting(b)) - Number(waiting(a))) || (b.createdAt || 0) - (a.createdAt || 0));
  }
  /** Test BTC the RGB wallet holds: { settled, pending } in sats. */
  btc() {
    const b = this.data?.btc || {};
    const sum = (k) => Number(b.vanilla?.[k] || 0) + Number(b.colored?.[k] || 0);
    const settled = sum('settled');
    return { settled, pending: Math.max(0, sum('future') - settled) };
  }
  amount(a, n) { return fromBase(n, a?.precision || 0); }
  /** Bitcoin in the RGB balance that can pay for things (not holding tokens): settled and waiting, in sats. */
  freeBtc() { const v = this.data?.btc?.vanilla || {}; const settled = Number(v.settled || 0); return { settled, pending: Math.max(0, Number(v.future || 0) - settled) }; }
  /** What keeps "Move everything" from running: open invoices, sends not finished, Instant listings. '' when nothing. */
  moveAllBlocked() {
    if (this.invoices().some((x) => this.invoiceStatus(x).key === 'waiting')) return 'You have an open RGB invoice. Cancel it or let it be paid first (it holds one of the outputs).';
    if (Object.keys(this.data?.transfers || {}).some((id) => this.unsent(id).length)) return 'A token transfer is still waiting for the other wallet. Let it finish or cancel it first.';
    if (Object.values(this.service?.instantStore?.().all() || {}).some((e) => e?.role === 'seller' && ['moving', 'cancelling'].includes(e.stage))) return 'An Instant listing is moving its tokens. Wait for that transaction\'s block first.';
    return '';
  }
  /** Ask each transfer server in the pending send whether it answers and speaks our protocol. */
  async checkProxies() {
    const p = this.pending;
    if (!p) return;
    const ask = await this.missingOrigins(p.endpoints);
    const missing = new Set(ask.map((url) => new URL(url).origin));
    const errors = [];
    for (const e of p.endpoints) {
      const url = proxyUrl(e);
      if (missing.has(new URL(url).origin)) continue;
      try { await this.service.checkProxy(url); return void (this.pending = { ...p, ask: [], check: { ok: true, endpoint: e, detail: '' } }); } catch (err) {
        errors.push(`${hostOf(e)}: ${brief(typeof err === 'string' ? err : err?.message || String(err))}`);
      }
    }
    this.pending = { ...p, ask, check: errors.length ? { ok: false, detail: errors.join(' · ') } : null };
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
  /**
   * Mainnet and public Signet: the person's own block server (Settings → Blockchain server) first, then mempool.space
   * and blockstream.info, the same servers the rest of MASKED uses. Utexo Signet has only its own.
   */
  withIndexers(p) {
    if (p.id !== 'mainnet' && p.id !== 'public') return p;
    const servers = this.app.servers?.list?.() || [p.sdk.indexerUrl];
    return { ...p, sdk: { ...p.sdk, indexerUrls: servers.map((u) => String(u).replace(/\/+$/, '')) } };
  }
  /** Settings → Blockchain server changed: RGB uses the new order too (your own server first). */
  serversChanged() { this.service?.useServers?.(this.withIndexers(this.profile).sdk?.indexerUrls); }
  async serviceFor() {
    if (this.service && this.service.profile.id === this.profile.id) return this.service;
    const runtime = await this.runtime();
    this.service = new runtime.SignetWallet({ loadSdk: runtime.loadRgbSdk, storage: localStorage, profile: this.withIndexers(this.profile) });
    return this.service;
  }
  /** @param {string} password @param {any} [backup] @param {{ keyed?: boolean, replace?: boolean }} [o] keyed: password is the wallet key; replace: load the backup over this browser's RGB */
  async open(password, backup = null, { keyed = true, replace = false } = {}) {
    await this.acquire();
    try {
      const runtime = await this.runtime();
      const service = await this.serviceFor();
      const seed = await this.mainSeed();
      service.setPayoutScript?.(this.payoutScript());
      await service.open(password, () => runtime.mnemonicFrom(seed), backup, { replace });
      this.ready = true;
      // the last balances, shown at once while the refresh below checks the block server (it can take a minute)
      if (!this.data) { this.data = this.cachedSnapshot(); if (this.data) this.app.render?.(); }
      if (keyed) this.markKeyed();
      this.startTimer(); // its first tick also looks whether another copy saved newer RGB data
    } catch (error) { await this.close(); throw error; }
    // Balances: a slow or busy server must not close RGB. Keep it open and retry with the minute timer.
    // Another MASKED window (the popup, or the last approval) refreshed under a minute ago and saved: this one starts
    // from that. Before, every approval window synced and checked everything again on open (the "Checking…" wait and
    // hundreds of block server requests on each tap on the market).
    const shared = this.sharedRefreshAt();
    if (!backup && !this.needsScan() && this.data && Date.now() - shared < OPEN_FRESH_MS) { this.refreshedAt = shared; return; }
    try {
      await this.refresh(!!backup || this.needsScan());
    } catch (error) {
      this.message = `${rgbError(error, this.profile)} RGB will try again in a minute.`;
    }
  }
  /**
   * The Public address's script when it's on this RGB network's chain: sales pay it, so the RGB wallet's bitcoin
   * stays for network fees. UTEXO's test network is a chain of its own: there, sales stay in the RGB wallet.
   */
  payoutScript() {
    const a = this.app?.account, n = this.profile?.sdk?.network;
    if (!a?.pubSpk || !((n === 'signet' && a.net === 'signet') || (n === 'mainnet' && a.net === 'main'))) return null;
    return a.pubSpk() || null;
  }
  /** Vaults opened with the wallet key say so; older ones had a password of their own. */
  markKeyed() {
    const v = this.vault();
    if (v && v.keyed !== 'wallet') try { localStorage.setItem(this.profile.vaultKey, JSON.stringify({ ...v, keyed: 'wallet' })); } catch { /* next open marks it */ }
  }
  /** A full address scan has not completed yet for this test wallet on this engine. */
  // v3: once more after the move to the RGB 0.11.2 engine (an upgraded wallet may rebuild its bitcoin view)
  needsScan() { try { return localStorage.getItem(`${this.profile.vaultKey}.scanned-v3`) !== '1'; } catch { return true; } }
  get snapshotKey() { return `${this.profile.vaultKey}.snapshot`; }
  /**
   * Before RGB is open: the last saved balances (this browser's own copy, written after every refresh), so Home shows
   * them at once instead of "opening…". Returns them, or null when there are none. Read only.
   */
  peek() {
    if (this.ready) return this.data;
    if (!this.data && this.exists) this.data = this.cachedSnapshot();
    return this.data;
  }
  /** Something that changes on its own soon: a transfer not settled, a listing or lot not on sale yet, a purchase not confirmed. */
  underWay() {
    const open = ['WaitingCounterparty', 'WaitingConfirmations', 'Initiated'];
    for (const list of Object.values(this.data?.transfers || {})) for (const t of /** @type {any[]} */ (list) || []) if (open.includes(String(t?.status)) && !this.isDropped(t)) return true;
    try {
      for (const e of Object.values(this.service?.instantStore?.().all() || {})) {
        if (e?.role === 'seller' && ['moving', 'queued', 'cancelling'].includes(e.stage)) return true;
        if (e?.role === 'buyer' && e.posted && !e.confirmed && !e.failed) return true;
      }
    } catch { /* no store: transfers decide */ }
    return false;
  }
  /** When any MASKED window last refreshed RGB (and saved it): this window's own, or one kept in browser storage. */
  sharedRefreshAt() {
    let kept = 0;
    try { kept = Number(localStorage.getItem(`${this.profile.vaultKey}.refreshed-at`)) || 0; } catch { kept = 0; }
    return Math.max(this.refreshedAt || 0, kept > Date.now() ? 0 : kept);
  }
  /** The balances of the last refresh on this browser (tokens, BTC, history): null if there are none. */
  cachedSnapshot() {
    try { const d = JSON.parse(localStorage.getItem(this.snapshotKey) || 'null'); return d && typeof d === 'object' && d.groups ? { ...d, cached: true } : null; } catch { return null; }
  }
  /**
   * @param {boolean} [full] scan addresses ahead too: the first time, and when Refresh is tapped
   * @param {{ sync?: boolean }} [o] sync: false asks the transfer server only (no block server requests)
   */
  async refresh(full = false, { sync = true } = {}) {
    full ||= this.needsScan();
    this.data = await this.service.snapshot({ full, sync: sync || full }); this.saved = false;
    if (sync || full) {
      this.refreshedAt = Date.now();
      try { localStorage.setItem(`${this.profile.vaultKey}.refreshed-at`, String(this.refreshedAt)); } catch { /* this window only */ }
    }
    try { localStorage.setItem(this.snapshotKey, JSON.stringify(this.data, (_, v) => typeof v === 'bigint' ? v.toString() : v)); } catch { /* shown live only */ }
    if (full) try { localStorage.setItem(`${this.profile.vaultKey}.scanned-v3`, '1'); } catch { /* scans again next time */ }
    await this.instantCheck();
    this.autoFund().catch(() => {});
    this.checkDropped().catch(() => {});
    this.publishShare().catch(() => {});
  }
  /**
   * Keep the token list sites may see (what "Share your RGB tokens" gives) in the browser's memory, so a site you
   * let see it without asking gets an answer at once instead of a window and a catch-up with the chain. RAM only
   * (chrome.storage.session): gone when the browser closes. Never keys, outputs or history: tickers, IDs, amounts.
   * @param {any[]} [list] the list just shared (else read now)
   */
  async publishShare(list) {
    const p = this.app.platform;
    if (!p?.hasExt || !this.ready || typeof p.sessionSet !== 'function') return;
    const address = this.app.account?.funding?.()?.address, net = this.app.account?.net;
    if (!address || !net) return;
    const items = list || this.withoutDropped(await this.service.assetList());
    const clean = JSON.parse(JSON.stringify(items, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const all = (await p.sessionGet('masked.rgb.share')) || {};
    all[`${net}:${address}`] = { at: Date.now(), list: clean };
    await p.sessionSet({ 'masked.rgb.share': all });
  }
  /** Forget the token list sites may see (on lock, or when this wallet goes). */
  async forgetShare() { try { await this.app.platform?.sessionRemove?.('masked.rgb.share'); } catch { /* RAM only anyway */ } }
  // ---- incoming transfers whose transaction the network dropped (never confirmed, gone from the mempool) ----
  get droppedKey() { return `${this.profile.vaultKey}.dropped`; }
  dropped() { try { return JSON.parse(localStorage.getItem(this.droppedKey) || '{}') || {}; } catch { return {}; } }
  isDropped(t) { return !!(t?.txid && this.dropped()[String(t.txid)]); }
  /**
   * Tokens on a receive whose transaction the network dropped never arrived: take them out of "waiting for a block"
   * in what goes to the page (assetList's `held`, outputsReport's outputs and tokens), as Home already does.
   * @template T @param {T} x @returns {T}
   */
  withoutDropped(x) {
    const gone = new Set(Object.keys(this.dropped()).map((t) => t.toLowerCase()));
    if (!gone.size || !x) return x;
    const any = /** @type {any} */ (x);
    if (Array.isArray(any)) {
      // assetList: per token, the amount on dropped receives
      return /** @type {any} */ (any.map((a) => {
        const lost = (this.data?.transfers?.[a.assetId] || []).filter((t) => /^Receive/.test(String(t?.kind)) && String(t?.status) === 'WaitingConfirmations' && this.isDropped(t))
          .reduce((n, t) => n + BigInt((t.assignments || []).reduce((m, y) => m + Number(y?.Fungible ?? 0), 0) || Number(t.requestedAssignment?.Fungible ?? 0) || 0), 0n);
        if (!lost || !a.held) return a;
        const w = BigInt(a.held.waiting || 0) - lost;
        return { ...a, held: { ...a.held, waiting: String(w > 0n ? w : 0n), dropped: String(lost) } };
      }));
    }
    if (Array.isArray(any.rgb)) {
      for (const o of any.rgb) if (o.state === 'waiting' && gone.has(String(o.outpoint).split(':')[0])) o.state = 'dropped';
      for (const t of any.tokens || []) {
        const lost = any.rgb.filter((o) => o.state === 'dropped').flatMap((o) => o.tokens || []).filter((y) => y.assetId === t.assetId).reduce((n, y) => n + BigInt(y.amount || 0), 0n);
        if (lost) { const w = BigInt(t.waiting || 0) - lost; t.waiting = String(w > 0n ? w : 0n); t.dropped = String(lost); }
      }
    }
    return x;
  }
  /**
   * A receive still "waiting for a block" after hours: ask the block servers whether its transaction exists at all.
   * Waiting over a day and no server has it: dropped at once. Waiting a few hours: not found twice, an hour apart
   * (a server can lag). Dropped: shown as not received and left out of "incoming"; found again later (rebroadcast),
   * it counts again. At most every 30 minutes, a few transactions at a time.
   */
  async checkDropped() {
    if (Date.now() - (this.droppedAt || 0) < 30 * 60_000) return;
    this.droppedAt = Date.now();
    const bases = (this.withIndexers(this.profile).sdk?.indexerUrls || []).slice(0, 2);
    if (!bases.length) return;
    /** @type {Record<string, number>} */
    const seen = (/** @type {any} */ (this)).droppedSeen ||= {};
    const map = this.dropped();
    const old = Date.now() / 1000 - 3 * 3600;
    const waiting = Object.values(this.data?.transfers || {}).flat()
      .filter((t) => String(t?.kind || '').startsWith('Receive') && String(t.status) === 'WaitingConfirmations' && t.txid && Number(t.createdAt) > 0 && Number(t.createdAt) < old).slice(0, 10);
    if (!waiting.length) return;
    let changed = false;
    const day = Date.now() / 1000 - 86400;
    for (const t of waiting) {
      // every server that answers: true = it doesn't have the transaction, false = it does
      const answers = [];
      for (const base of bases) {
        try { const r = await fetch(`${base}/tx/${t.txid}/hex`); if (r.status === 404) answers.push(true); else if (r.ok) answers.push(false); } catch { /* no answer */ }
      }
      if (answers.includes(false)) { if (map[t.txid]) { delete map[t.txid]; changed = true; } continue; }
      if (!answers.length || map[t.txid]) continue;
      // waiting over a day: gone now. A few hours: twice, an hour apart (a server can lag behind)
      if (Number(t.createdAt || 0) < day || (seen[t.txid] && Date.now() - seen[t.txid] > 60 * 60_000)) { map[t.txid] = Date.now(); changed = true; } else seen[t.txid] ||= Date.now();
    }
    if (changed) { try { localStorage.setItem(this.droppedKey, JSON.stringify(map)); } catch { /* checked again */ } this.app.render?.(); }
  }
  /**
   * Test networks only: keep the RGB wallet's test BTC for network fees topped up from the Public balance, so sends,
   * listings and new RGB outputs don't stop on "needs bitcoin". At most once in 20 minutes (the top-up needs its
   * block), and only when Public can pay it. Mainnet never moves BTC by itself: Home's Add BTC for RGB asks.
   * @returns {Promise<boolean>} whether a top-up was sent
   */
  async autoFund() {
    if (this.isMain || !this.data?.address) return false;
    const { settled, pending } = this.btc();
    if (settled + pending >= RGB_AUTO_FUND_BELOW) return false;
    const now = Date.now();
    if (now - (this.fundedAt || 0) < 20 * 60_000) return false;
    const app = this.app;
    if (typeof app.builder?.send !== 'function' || typeof app.broadcast !== 'function') return false;
    this.fundedAt = now;
    try {
      // a Public wallet on another network refuses the RGB address here, so nothing is sent across networks
      const b = await app.builder.send({ from: 'public', to: this.data.address, amount: RGB_FUND_SATS, rate: app.feeRate(), parts: rgbFundParts(RGB_FUND_SATS) });
      await app.broadcast(b.hex);
      await app.afterBroadcast?.(b.spent, [b.txid]);
      app.toast?.(`Added ${RGB_FUND_SATS.toLocaleString('en-US')} test sats to RGB from your Public balance, for network fees. Ready after one block.`, 6000);
      return true;
    } catch { return false; } // locked, empty Public, other network: Home's Add test BTC is still there
  }
  /** A listing signed here but not yet on its market: send it (and say whether that worked). */
  async publishPending() {
    for (const [id, e] of Object.entries(this.service?.instantStore?.().all() || {})) {
      if (e?.role !== 'seller' || e.stage !== 'ready' || e.published) continue;
      if (await publishInstant(e, { offerId: id, psbt: e.psbt, consignment: e.consignment, templateTxid: e.templateTxid, sellerOutpoint: e.coin }).catch(() => false)) this.service.instantStore().set(id, { ...e, published: true });
    }
  }
  /** Instant listings: sign the ones whose tokens settled, notice sales and cancels; finish bought ones. */
  async instantCheck() {
    if (!this.service?.canPresign) return;
    // another copy of this wallet is newer: no automatic signing or moving of lots here until that's settled
    if (this.cloud?.conflict) return;
    let changes = [];
    try { changes = await this.service.instantProgress(); } catch { return; }
    // several listings signed at once (lots): one message for them all
    const readyN = changes.filter((c) => c.stage === 'ready').length;
    const expiredN = changes.filter((c) => c.expired).length;
    if (expiredN) this.app.toast(`${expiredN} lot${expiredN === 1 ? '' : 's'} that waited too long for ${expiredN === 1 ? 'its' : 'their'} tokens ${expiredN === 1 ? 'was' : 'were'} not listed. Nothing moved; list again if you still want to sell.`, 6000);
    let live = 0, refused = 0, unsent = 0;
    for (const c of changes) {
      if (c.stage === 'sold') this.app.toast(this.service.instantStore().get(c.offerId)?.payoutPublic ? 'Instant listing sold. The bitcoin is in your Public balance once the transaction confirms.' : 'Instant listing sold. The bitcoin is in your RGB wallet once the transaction confirms.');
      if (c.stage === 'ready') {
        // signed after the tokens moved: hand the listing to the market it was made on
        const e = this.service.instantStore().get(c.offerId);
        const ok = await publishInstant(e, c).catch(() => false);
        if (ok) this.service.instantStore().set(c.offerId, { ...e, published: true });
        if (ok === 'refused') refused++; else if (ok) live++; else unsent++;
        if (readyN === 1) {
          this.app.toast(ok === 'refused' ? `Instant listing signed, but the market refused it: ${lastRefusal}. Cancel it on the market and list again.`
            : ok ? 'Instant listing is live: buyers can buy it now, even with MASKED closed.' : 'Instant listing signed. Open the market and tap Finish listing on it.');
        }
      }
      if (c.stage === 'cancelled' && !c.expired) this.app.toast('Listing cancelled. Your tokens moved to a new output.');
      if (c.stage === 'purchase-failed') this.app.toast(`An Instant purchase didn't go through, and nothing was paid: ${c.why}`);
      if (c.stage === 'outdated') this.app.toast('An Instant listing was signed by an older MASKED and can\'t sell. Cancel it on the market, then list again.');
    }
    if (readyN > 1) {
      this.app.toast([live && `${live} Instant listings are live: buyers can buy them now, even with MASKED closed.`, unsent && `${unsent} signed: open the market and tap Finish listing on them.`, refused && `${refused} refused by the market (${lastRefusal}).`].filter(Boolean).join(' '));
    }
    await this.publishPending().catch(() => {});
    if (changes.length && this.isMain && this.cloudOn) this.cloudSave().catch(() => {});
    if (changes.length) this.app.render?.();
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
      if (!this.ready || this.busy || this.quietRun || document.visibilityState !== 'visible') return;
      // every minute only while something is under way (a transfer, a listing going live, a purchase); otherwise every
      // 5 minutes. A refresh by another MASKED window counts. (Mainnet block servers: no needless requests.)
      const since = Date.now() - this.sharedRefreshAt();
      if (since < 55_000 || (since < IDLE_REFRESH_MS && !this.underWay())) return;
      this.run(async () => { await this.refresh(); this.message = ''; }, { quiet: true });
      if (Date.now() - (this.cloudCheckedAt || 0) > 5 * 60_000) { this.cloudCheckedAt = Date.now(); this.checkCloudNewer().catch(() => {}); }
    }, 60000);
  }

  /** Open RGB by itself when the wallet is open on Signet and a test wallet exists. Called from render. */
  ensure() {
    if (this.app.platform.rgbResumeId || !this.available || this.ready || this.busy || this.quietRun || !this.exists || this.tried === this.profile.id) return;
    // let the wallet's own sync finish first: both use the same block servers
    // (at most 30 s: a long history rescan should not keep RGB closed)
    // (at most 30 s, or 5 s when the last balances are saved: they show at once and the refresh runs after)
    const wait = localStorage.getItem(this.snapshotKey) ? 5000 : 30000;
    if (this.app.sync?.syncing && (this.waitSince ||= Date.now()) > Date.now() - wait) {
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
  /**
   * Run an RGB step. A quiet one (opening, the minute refresh, a report) runs underneath: the wallet stays usable
   * and shows the last balances meanwhile. A step the person taps waits for it ("Waiting for the update…"), then
   * runs; the engine takes one operation at a time anyway. `wait`: a quiet step that waits for one already running
   * instead of being skipped (one the person asked for, like the outputs report).
   */
  async run(fn, { quiet = false, backupNow = false, wait = false } = {}) {
    if (quiet) {
      if (this.busy) return;
      if (this.quietRun) { if (!wait) return; await this.quietRun.catch(() => {}); if (this.busy || this.quietRun) return; }
      const p = this.steps(fn, { quiet, backupNow });
      this.quietRun = p;
      try { await p; } finally { this.quietRun = null; this.app.render(); }
      return;
    }
    // a tap while RGB is working on another tapped step: say so, instead of doing nothing
    if (this.busy) { this.app.toast('RGB is still updating. One moment…', 2500); return; }
    this.busy = true; this.busySince = Date.now();
    // show "Updating…" at once (the button is disabled until it's done), then how long it has been working
    this.app.render();
    const tick = setInterval(() => { if (Date.now() - this.busySince >= 10_000) this.app.render(); }, 5000);
    /** @type {any} */ (tick).unref?.(); // Node (tests): a step left waiting must not keep the process alive
    try {
      if (this.quietRun) {
        this.waitingForUpdate = true; this.app.render();
        try { await this.quietRun; } catch { /* its own message */ } finally { this.waitingForUpdate = false; }
        this.app.render();
      }
      await this.steps(fn, { quiet, backupNow });
    } finally { clearInterval(tick); this.busy = false; this.busySince = 0; this.app.render(); }
  }
  async steps(fn, { quiet, backupNow }) {
    try {
      await fn();
      // Saved straight after, in the background: the step is done for the person at once. A new invoice waits for
      // it (backupNow): an invoice must not be shared before the backup has what it needs to receive the tokens.
      if (this.service?.backupRequired && this.cloudOn && this.ready) {
        if (backupNow && !quiet) { this.message = 'Backing up…'; this.app.render(); await this.cloudSave(); this.message = ''; }
        else this.scheduleCloud(quiet ? 4000 : 500);
      }
      if (this.phase !== 'legacy' && this.phase !== 'allow') this.phase = '';
      if (!quiet) this.message = '';
    } catch (error) {
      this.message = rgbError(error, this.profile);
      if (!this.ready && this.phase === 'opening') this.phase = 'error';
      if (!quiet) this.app.toast(this.message, 6000);
    }
  }
  /** Something is running underneath (opening or a refresh): the wallet stays usable. */
  get updating() { return !!this.quietRun || this.busy; }
  /** The refresh link's words: "Updating… 0:45" once it has been working a while. */
  get busyLabel() {
    if (this.waitingForUpdate) return 'Waiting for the update…';
    const s = Math.floor((Date.now() - (this.busySince || Date.now())) / 1000);
    return s < 10 ? 'Updating…' : `Updating… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * Do something that needs free RGB outputs. If there are none, make them first (one Bitcoin transaction) and
   * try again; if they still need a block, say so plainly.
   */
  async withOutputs(fn, { retry = true } = {}) {
    try { return await fn(); } catch (e) {
      const text = typeof e === 'string' ? e : e?.message || '';
      // short of bitcoin for the fee (MASKED's own check): on a test network, top up from Public first
      if (/Tap Add (BTC for RGB|to RGB balance|from Bitcoin)/.test(text) && !this.isMain) {
        this.fundedAt = 0; // asked for now, not on the 20-minute timer
        if (await this.autoFund()) throw new Error('MASKED added test BTC to RGB from your Public balance, for the network fee. Wait for one block (about 10 minutes), then tap again.');
        throw e;
      }
      if (!NEEDS_OUTPUTS.test(text)) throw e;
      if (this.btc().settled < 1500) {
        if (!this.isMain && await this.autoFund()) throw new Error('MASKED added test BTC to RGB from your Public balance. Wait for one block (about 10 minutes), then tap again.');
        throw new Error('Your RGB balance is empty: tap Add from Bitcoin under RGB balance on Home, then wait for a block.');
      }
      this.message = 'Setting up RGB…'; this.app.render();
      await this.service.createUtxos(this.fee());
      await this.refresh();
      // a send doesn't go again straight away: its bitcoin could clash with the new outputs' unconfirmed transaction
      if (!retry) throw new Error('RGB is set up. Wait for one block (about 10 minutes), then tap again.');
      try { return await fn(); } catch (e2) {
        if (NEEDS_OUTPUTS.test(typeof e2 === 'string' ? e2 : e2?.message || '')) throw new Error('RGB is set up. Wait for one block (about 10 minutes), then tap again.');
        throw e2;
      }
    }
  }

  /** The servers an RGB network talks to: its block server and its transfer server. */
  hostsFor(p = this.profile) { return [p.sdk.indexerUrl, p.sdk.transportEndpoint, ...(p.sdk.transportFallbacks || [])]; }

  async missingOrigins(endpoints) {
    const urls = new Map();
    for (const endpoint of endpoints) {
      try {
        const url = new URL(proxyUrl(endpoint));
        if (['https:', 'http:'].includes(url.protocol)) urls.set(url.origin, url.href);
      } catch { /* unsupported endpoint */ }
    }
    const missing = await Promise.all([...urls.values()].map(async (url) => await this.app.platform.hasOrigins([url]) ? null : url));
    return missing.filter(Boolean);
  }

  /** Where the person is, so MASKED can reopen at the same step after Chrome's prompt closes the popup. */
  permissionDraft(name, arg = '') {
    const { app } = this;
    return { name, arg, view: app.state.view, account: app.account.id, profile: this.profile.id, recvKind: app.state.f.recvKind, mintMode: app.state.f.mintMode, asset: this.asset, fields: this.fields, betaOk: this.betaOk };
  }
  /** Ask for servers: in the toolbar popup with a saved draft (one approval), elsewhere straight away. */
  async allowHosts(hosts, name, arg = '') {
    const { platform } = this.app;
    if (await platform.hasOrigins(hosts)) return;
    return platform.isPopup ? platform.requestFromPopup(hosts, this.permissionDraft(name, arg)) : platform.requestOrigins(hosts);
  }

  /** Reopened after Chrome allowed the servers: go back to the same step and carry on, without asking again. */
  async resumePermission(draft) {
    const { app } = this;
    if (!draft || !this.unlocked || draft.account !== app.account.id || draft.profile !== this.profile.id) {
      this.ensure();
      return;
    }
    app.state.view = draft.view;
    app.state.f.recvKind = draft.recvKind;
    app.state.f.mintMode = draft.mintMode;
    this.fields = { ...EMPTY_FIELDS(), ...draft.fields };
    if (draft.name === 'allowProxy') {
      this.tried = this.profile.id;
      await this.run(async () => this.open(await this.walletKey()));
      if (!this.ready) return app.render();
      this.asset = draft.asset;
      this.fields = { ...EMPTY_FIELDS(), ...draft.fields };
      app.state.view = 'rgbsend';
      return this.action('review'); // the server is allowed now: the review checks it and shows Confirm
    }
    if (draft.name === 'betaYes') { this.betaAsk = true; this.betaOk = !!draft.betaOk; }
    this.tried = '';
    return this.action(draft.name, draft.arg || '');
  }

  // ---- actions (data-rgb="…") ----
  async action(name, arg = '') {
    const app = this.app, state = app.state, f = state.f;
    // Chrome only shows its "allow" prompt straight from a click, so ask before anything else is awaited.
    // The RGB servers aren't in the install permissions: people who never use RGB are never asked.
    const opening = { betaYes: RGB_MAINNET, on: this.profile, retry: this.profile, profile: profileOf(arg) }[name];
    if (opening && (name !== 'betaYes' || this.betaOk)) {
      try {
        await this.allowHosts(this.hostsFor(opening), name, arg);
      } catch {
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
      name = 'on';
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
        const found = !this.exists && this.cloudOn ? await this.cloudFind() : null;
        if (found) {
          await this.open(await this.walletKey(), found.backup);
          this.cloudMark(found.version); this.service.backupSaved();
          app.toast('RGB restored from your cloud backup');
        } else {
          await this.open(await this.walletKey());
          if (this.cloudOn) await this.cloudSave(); // the new keys are backed up straight away
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
      // a tap: a quick sync (a full rescan only when it's due), then say it's done
      case 'refresh': return this.run(async () => { await this.refresh(); app.toast('RGB balances updated', 2000); });
      case 'withdraw': this.withdraw = { open: true }; this.message = ''; return app.render();
      case 'withdrawClose': this.withdraw = null; this.message = ''; return app.render();
      case 'withdrawGo': {
        const to = app.account?.pubAddr?.();
        if (!to || !this.payoutScript()) { this.message = 'Your Bitcoin balance is on another network than RGB. Switch the wallet to the same network first.'; return app.render(); }
        const all = arg === 'all';
        let sats = 0;
        if (!all) {
          const el = /** @type {HTMLInputElement|null} */ (document.getElementById('rgbWdAmt'));
          sats = Math.floor(Number(String(el?.value || '').replace(/[,\s]/g, '')));
          if (!(sats >= 546)) { this.message = 'Enter at least 546 sats.'; return app.render(); }
          if (sats > this.freeBtc().settled) { this.message = `Your RGB balance has ${this.freeBtc().settled.toLocaleString('en-US')} sats free to move (confirmed, not holding tokens).`; return app.render(); }
        } else {
          const why = this.moveAllBlocked();
          if (why) { this.message = why; return app.render(); }
        }
        return this.run(async () => {
          this.message = 'Moving…'; app.render();
          const txid = await this.service.sendBtcOut({ address: to, sats, all, fee: this.fee() });
          this.withdraw = null;
          await this.refresh();
          app.toast(all ? `Moved your RGB balance to your Bitcoin balance (${String(txid).slice(0, 10)}…). It shows after one block.` : `Moved ${sats.toLocaleString('en-US')} sats to your Bitcoin balance (${String(txid).slice(0, 10)}…). It shows after one block.`, 6000);
        });
      }
      case 'fund': {
        if (!this.data?.address) return;
        f.sendMode = 'send'; f.sendFrom = 'public'; f.sendTo = this.data.address; f.sendAmount = RGB_FUND_BTC;
        state.send = { stage: 'form' }; state.status.send = null; state.view = 'send';
        return app.render();
      }
      case 'mint': f.mintMode = 'rgb'; state.view = 'mint'; this.issued = null; return app.render();
      case 'token': this.asset = arg; state.view = 'rgbtok'; return app.render();
      case 'coll': this.coll = arg; state.view = 'rgbcoll'; return app.render();
      case 'receive': f.recvKind = 'rgb'; this.fields.recvAsset = arg || ''; this.invoice = ''; state.view = 'receive'; return app.render();
      case 'send':
        this.asset = arg; this.pending = null; this.sent = null; this.fields.sendTo = ''; this.fields.sendAmt = ''; state.view = 'rgbsend';
        // current mempool rates for the fee picker on the form; it redraws when they arrive
        if (this.isMain) app.fees.refresh().then(() => { if (state.view === 'rgbsend') app.render(); }).catch(() => {});
        return app.render();
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
      case 'cancelSend': { // a send the other wallet hasn't accepted (arg = batch transfer index), or all of them
        return this.run(async () => {
          const res = await this.service.cancelSends(arg !== '' ? [Number(arg)] : null);
          const n = typeof res === 'number' ? res : res.n, errors = typeof res === 'number' ? [] : res.errors;
          const lost = errors.filter((e) => /signed PSBT not found/i.test(e.reason));
          if (lost.length && this.data) this.data.stranded = [...new Set([...(this.data.stranded || []), ...lost.map((e) => e.idx)])];
          await this.refresh();
          if (n) return app.toast(`${n === 1 ? 'Transfer' : `${n} transfers`} cancelled. Nothing was sent.`, 6000);
          if (lost.length) throw new Error('Can\'t cancel or finish this transfer: its signed transaction was lost in the restore. Nothing was sent.');
          if (errors.length) throw new Error(`The RGB engine didn't cancel this transfer: ${brief(errors[0].reason)}`);
          app.toast('Nothing to cancel: the transfer has moved on.', 6000);
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
          await this.requireLatest();
          const r = witness ? await this.service.receive(opts) : await this.withOutputs(() => this.service.receive(opts));
          this.invoice = r.invoice;
          this.invoiceInfo = { witness, amount: amount ? this.amount(a, amount) : '', ticker: a?.ticker || '', expiry: Number(this.fields.recvExpiry) || 86400 };
          this.logInvoice({ invoice: r.invoice, recipientId: r.recipientId, at: Date.now(), expiresAt: Number(r.expirationTimestamp) || Math.floor(Date.now() / 1000) + this.invoiceInfo.expiry, ...this.invoiceInfo });
        }, { backupNow: true });
      }
      case 'review': {
        const a = this.find(this.asset);
        const invoice = this.fields.sendTo.trim();
        if (!a) { this.message = 'Pick a token first.'; return app.render(); }
        if (!/^rgb:/i.test(invoice)) { this.message = 'Paste the RGB invoice from the person you are paying. It starts with rgb:'; return app.render(); }
        return this.run(async () => {
          // fresh fee rates for the picker on the review (at most a few seconds; the last rates otherwise)
          if (this.isMain) await Promise.race([app.fees.refresh().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
          let d;
          try { d = await this.service.decode(invoice); } catch { throw new Error('That is not a valid RGB invoice. Ask them to make a new one.'); }
          if (d.assetId && d.assetId !== a.assetId) throw new Error(`This invoice asks for a different token, not ${a.ticker}.`);
          if (d.expirationTimestamp && d.expirationTimestamp <= Date.now() / 1000) throw new Error('This invoice has expired. Ask them to make a new one.');
          if (!this.profile.invoiceNets.includes(String(d.network).toLowerCase())) throw new Error(`This invoice is not for ${this.profile.label}.`);
          // an invoice with a fixed amount fills it in; an NFT is always 1
          if (this.listedWhy(a)) throw new Error(this.listedWhy(a));
          if (this.isNft(a)) this.fields.sendAmt = '1';
          const amount = this.isNft(a) ? 1 : d.amount || toBase(this.fields.sendAmt, a.precision);
          if (d.amount) this.fields.sendAmt = this.amount(a, d.amount).replace(/,/g, '');
          if (amount > this.bal(a).spendable) {
            const { spendable: sp, listed } = this.bal(a);
            if (listed > 0) throw new Error(sp > 0
              ? `Only ${this.amount(a, sp)} ${a.ticker} can be sent: ${this.amount(a, listed)} is in your listings. Send less, or cancel a listing first (on the market, My trades).`
              : `All your ${a.ticker} is in your listings, so none can be sent. Cancel a listing first (on the market, My trades).`);
            throw new Error(`You can send up to ${this.amount(a, sp)} ${a.ticker}.`);
          }
          const endpoints = d.transportEndpoints?.length ? d.transportEndpoints : [this.profile.sdk.transportEndpoint];
          if (endpoints.some((e) => {
            try { return !['http:', 'https:'].includes(new URL(proxyUrl(e)).protocol); } catch { return true; }
          })) throw new Error('This invoice contains an unsupported transfer server.');
          this.pending = { assetId: a.assetId, ticker: a.ticker, invoice, amount, shown: this.isNft(a) ? a.name : this.amount(a, amount), nft: this.isNft(a), witness: !!d.witness, fixed: !!d.amount, endpoints, proxies: endpoints.map(hostOf), ask: [], check: null };
          await this.checkProxies();
        });
      }
      case 'allowProxy': {
        const p = this.pending;
        if (!p?.ask.length || !this.ready) return;
        return this.run(async () => {
          await this.allowHosts(p.ask, name); // first: still the click, so Chrome can show its prompt
          await this.checkProxies();
        });
      }
      case 'recheck': return this.run(() => this.checkProxies());
      case 'cancel': if (!this.busy) this.pending = null; return app.render();
      case 'confirm': {
        const p = this.pending;
        if (!p) return;
        return this.run(async () => {
          this.message = 'Sending…'; app.render();
          if (!p.check?.ok) throw new Error('Check the transfer server first.');
          await this.requireLatest();
          if (!await app.platform.hasOrigins([proxyUrl(p.check.endpoint)])) {
            await this.checkProxies();
            throw new Error('Transfer server permission changed. Review the server and try again.');
          }
          // the token change needs a free RGB output of this wallet: none (or all full), make some first
          const r = await this.withOutputs(() => this.service.send({ invoice: p.invoice, assetId: p.assetId, amount: String(p.amount), fee: this.fee(), endpoint: p.check.endpoint, nft: !!p.nft }), { retry: false })
            .catch((err) => {
              // the engine only says the asset isn't on an output it can spend: a listing holding it says why
              const a = this.find(p.assetId), why = a && /insufficient total assignments/i.test(String(err?.message || err)) && this.listedWhy(a);
              throw why ? new Error(why) : err;
            });
          this.sent = { txid: r?.txid || '', shown: p.shown, ticker: p.ticker, nft: !!p.nft };
          this.pending = null;
          await this.refresh();
        });
      }
      case 'backup': {
        // Chrome's save dialog has to open straight from the click: ask for the file first, write it after
        const name = `masked-rgb-${this.profile.id}-backup-${new Date().toISOString().slice(0, 10)}.json`;
        let handle = null;
        const picker = /** @type {any} */ (globalThis).showSaveFilePicker;
        if (typeof picker === 'function') {
          try { handle = await picker({ suggestedName: name, types: [{ description: 'RGB backup', accept: { 'application/json': ['.json'] } }] }); } catch (e) {
            if (e?.name === 'AbortError') return; // cancelled: nothing saved, nothing marked
            handle = null;
          }
        }
        return this.run(async () => {
          const text = JSON.stringify(await this.service.backup());
          if (!handle) {
            const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = name; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
            app.toast('Download started. To confirm a backup, use the save dialog or encrypted cloud backup.', 6000);
            return;
          }
          const writable = await handle.createWritable();
          try { await writable.write(text); await writable.close(); } catch (error) {
            try { await writable.abort(); } catch { /* the stream may already be closed */ }
            throw error;
          }
          this.confirmBackup();
          try { localStorage.setItem(`${this.profile.vaultKey}.file-at`, String(Date.now())); } catch { /* */ }
          this.needBackup = false;
          app.toast('RGB backup saved');
        });
      }
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
        try { await this.cloudApi.remove(await this.cloudKeysNow()); } catch (e) {
          throw new Error(`Cloud backup is still on: ${e?.message || 'the server did not answer'}. Try again.`);
        }
        try { localStorage.setItem(CLOUD_KEY, '0'); localStorage.removeItem(`${this.profile.vaultKey}.cloud-at`); } catch { /* */ }
        this.cloud = { error: '', conflict: 0, saving: false, last: 0 };
        if (this.ready) try { localStorage.setItem(this.service.dirtyKey, '1'); } catch { /* */ } // the file is the only backup now
        app.toast('Cloud backup is off and deleted from the server. Save backup files yourself.', 6000);
      });
      case 'cloudRetry': return this.run(async () => { this.cloud.last = 0; if (await this.cloudSave()) app.toast('Cloud backup saved'); });
      // the other copy's newer cloud backup, into this browser (this copy's RGB state is replaced by it)
      case 'cloudLoad': return this.run(async () => {
        const found = await this.cloudFind();
        if (!found) throw new Error('No RGB cloud backup was found.');
        await this.close();
        this.phase = 'opening'; app.render();
        await this.open(await this.walletKey(), found.backup, { replace: true });
        this.cloudMark(found.version); this.service.backupSaved();
        this.cloud = { ...this.cloud, error: '', conflict: 0 };
        app.toast('Loaded the newer RGB backup: this browser is up to date');
      });
      // Settings → RGB → Check against the chain: first look, then (a second tap) mark the spent outputs as spent
      // Settings → RGB → cloud backup → Earlier backups: the versions the server keeps, and loading one of them
      case 'cloudList': return this.run(async () => {
        const list = await this.cloudApi.list((await this.cloudKeysNow()).id);
        this.cloudVersions = list;
        if (!list.length) app.toast('The backup server keeps no earlier versions of this wallet\'s RGB backup');
      });
      case 'cloudVersionsClose': this.cloudVersions = null; this.cloudPick = 0; return app.render();
      // first tap: what loading an earlier backup does, and the version picked; the second tap loads it
      case 'cloudLoadVersion': this.cloudPick = Number(arg) || 0; return app.render();
      case 'cloudPickCancel': this.cloudPick = 0; return app.render();
      // a state this browser had before a load: back again (the state it replaces is kept in turn)
      case 'undoLoad': return this.run(async () => {
        const backup = this.service?.beforeLoad?.(arg);
        if (!backup) throw new Error('That earlier state of this browser isn\'t kept any more.');
        await this.close();
        this.phase = 'opening'; app.render();
        await this.open(await this.walletKey(), backup, { replace: true });
        this.service.backupSaved();
        this.cloud = { ...this.cloud, error: '', conflict: 0 };
        this.cloudVersions = null; this.cloudPick = 0;
        if (this.cloudOn) await this.cloudSave({ replace: true }).catch(() => false);
        app.toast('This browser\'s RGB is back to what it was before that load');
      });
      case 'cloudLoadVersionYes': return this.run(async () => {
        const pick = this.cloudPick; this.cloudPick = 0;
        if (!pick) return;
        const keys = await this.cloudKeysNow();
        const body = await this.cloudApi.get(keys.id, pick);
        if (!body) throw new Error('That backup version isn\'t kept any more.');
        // an earlier version on purpose: no "newer than this browser" rule
        const backup = await openCloud(keys, body, 0);
        await this.close();
        this.phase = 'opening'; app.render();
        await this.open(await this.walletKey(), backup, { replace: true });
        this.cloudMark(Number(body.version)); this.service.backupSaved();
        this.cloud = { ...this.cloud, error: '', conflict: 0 };
        this.cloudVersions = null;
        // and it becomes the latest, so other copies load it and this copy's next save isn't refused
        await this.cloudSave({ replace: true }).catch(() => false);
        app.toast(`Loaded the RGB backup from ${new Date(Number(body.at || 0) || Date.now()).toLocaleString()}`);
      });
      case 'repairCheck': return this.run(async () => {
        const gone = await this.service.repairFromChain({ fix: false });
        this.repair = { gone, at: Date.now() };
        if (!gone.length) app.toast('Every RGB output this wallet counts is unspent on chain: nothing to repair');
      });
      case 'repairFix': return this.run(async () => {
        const gone = await this.service.repairFromChain({ fix: true });
        this.repair = null;
        await this.refresh().catch(() => {});
        if (this.cloudOn) await this.cloudSave({ replace: true }).catch(() => false);
        app.toast(gone.length ? `Marked ${gone.length} spent output${gone.length > 1 ? 's' : ''}: balances now count only what this wallet can move` : 'Nothing to repair');
      });
      case 'repairCancel': this.repair = null; return app.render();
      // What's in this wallet: every output and coin, what it's doing
      case 'outputs': return this.run(async () => { this.outputs = this.withoutDropped(await this.service.outputsReport()); }, { quiet: true, wait: true });
      case 'outputsClose': this.outputs = null; return app.render();
      // a transfer that never went out (a market trade left halfway, an invoice nobody paid): give it up, freeing its outputs
      case 'releaseLock': return this.run(async () => {
        const res = await this.service.releaseLock({ idx: Number(arg) });
        await this.refresh().catch(() => {});
        this.outputs = this.withoutDropped(await this.service.outputsReport());
        if (this.cloudOn) await this.cloudSave().catch(() => false);
        app.toast(`Released: ${res.outpoints.length === 1 ? 'that output is' : `${res.outpoints.length} outputs are`} free again. Nothing was sent.`, 6000);
      });
      // Settings → RGB → Instant listings: cancel one here, also one the market doesn't show (asks once first)
      case 'listings': this.cancelAsk = null; state.view = 'rgblist'; return app.render();
      case 'hub': state.view = 'rgbwallet'; return app.render();
      case 'homeTab': state.f.rgbHome = arg === 'nft' ? 'nft' : 'tok'; this.homeTab = state.f.rgbHome; return app.render();
      case 'hubTab':
        state.f.rgbHub = ['activity', 'locked', 'backup'].includes(arg) ? arg : 'activity';
        if (state.f.rgbHub === 'locked' && !this.outputs && !this.busy) return this.run(async () => { this.outputs = this.withoutDropped(await this.service.outputsReport()); }, { quiet: true, wait: true });
        return app.render();
      case 'listTab': state.f.listTab = arg === 'done' ? 'done' : 'open'; this.cancelAsk = null; return app.render();
      case 'instantCancelAsk': this.cancelAsk = arg; return app.render();
      case 'instantCancelNo': this.cancelAsk = null; return app.render();
      case 'instantCancel': return this.run(async () => {
        this.cancelAsk = null;
        const e = this.service.instantStore().get(arg);
        const v = await this.service.instantCancel({ offerId: arg, fee: this.fee(), feeRate: Number(this.fee()) || 1 });
        // tell the market too, when this browser has the listing's market address and step token
        if (e?.market && e?.token) fetch(`${e.market}/api/swap/offers/${encodeURIComponent(arg)}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swap-token': String(e.token) }, body: '{}' }).catch(() => {});
        app.toast(v?.stage === 'cancelling' ? 'Cancelling: the tokens move to a new output and are free again after one confirmation.' : 'Listing cancelled. Nothing moved.');
        await this.refresh().catch(() => {});
      });
      case 'freeSpare': return this.run(async () => {
        const r = await this.service.freeSpare({ fee: this.fee() });
        app.toast([r.freed ? `${r.freed} spare RGB outputs freed: ${r.sats.toLocaleString('en-US')} sats back as bitcoin for buys after one confirmation.` : '', r.cancelled ? `${r.cancelled} unused invoices given up.` : ''].filter(Boolean).join(' '));
        await this.refresh().catch(() => {});
        this.outputs = this.withoutDropped(await this.service.outputsReport().catch(() => this.outputs));
      });
      case 'cloudReplace': return this.run(async () => { if (await this.cloudSave({ replace: true })) app.toast('This browser\'s RGB state is now the cloud backup'); });
      case 'betaOff': return this.run(async () => { await this.close(); try { localStorage.setItem(RGB_BETA_KEY, '0'); } catch { /* */ } app.toast('RGB beta is off. Your RGB wallet stays saved in this browser.'); });
      default: return undefined;
    }
  }
}
