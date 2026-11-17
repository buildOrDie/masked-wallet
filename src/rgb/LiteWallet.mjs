// On-chain RGB wallet over @utexo/rgb-lib-wasm: issue, receive, send and back up RGB assets.
// It replaces Utexo's web SDK, which also bundles a Lightning node and a second wallet engine (BDK):
// about 11 MB instead of about 27 MB. No Lightning. Same method names as the SDK's UTEXOWallet, so
// SignetWallet works with either.

import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { isInvoiceV1, readInvoiceV1, invoiceIdOf, pickEndpoint, newSenderKey, sharedKeys, deliverConsignment, endpointUrl, rpc, PROXY_V1 } from './proxyV1.mjs';
import { SEAL_SATS, SEAL_OUTPUT, SWAP_SIZE_VB, b64, buyerOutputs, outpointOf, completionBlocker, readOffer, buyerCoinFor, offerable, heldBreakdown, payoutFor, changedTerms, unb64, exactCoinFor, freeSellerCoinFor, sendCoinsFor, instantAmounts, INSTANT_SEAL_OUTPUT, INSTANT_SEAL_SATS, payCoinsFor, txVbytes, OPRET_SCRIPT, P2TR_SCRIPT } from './swap.mjs';
import { RGB_UTXO_SATS, RGB_KEEP_SPARE } from './config.mjs';

/** rgb-lib names for our network ids. Utexo's custom Signet uses Signet rules too. */
const NETWORKS = { mainnet: 'Mainnet', signet: 'Signet', utexo: 'Signet', testnet: 'Testnet', testnet4: 'Testnet4', regtest: 'Regtest' };
export const rgbNetwork = (n) => NETWORKS[String(n).toLowerCase()] || (() => { throw new Error(`Unknown RGB network: ${n}`); })();

/** rgb-lib wants rpc(s):// transport endpoints; our config uses https:// like the SDK. */
/** The moves an Instant store knows (listing and lot moves, cancels, sales): this wallet's own transactions. */
const storeMoveTxids = (store) => { try { return Object.values(store?.all?.() || {}).flatMap((e) => [e?.moveTxid, e?.cancelTxid, e?.lotOf]).filter(Boolean).map(String); } catch { return []; } };
export const rpcEndpoint = (url) => String(url).replace(/^https:\/\//i, 'rpcs://').replace(/^http:\/\//i, 'rpc://');

const num = (x) => Number(x ?? 0);
/** The token and amount from a consignment check (engines up to 2.26.3 named them contract_id / seal_amount). */
export const inspected = (v) => ({ contractId: String(v?.contractId ?? v?.contract_id ?? ''), sealAmount: v?.sealAmount ?? v?.seal_amount ?? null });
const short = (s) => (String(s).length > 20 ? `${String(s).slice(0, 10)}…${String(s).slice(-6)}` : String(s));

/**
 * The engine returns u64 values (amounts, timestamps, indexes) as BigInt. The screens do ordinary maths on them
 * (sorting, dates, sums), and BigInt does not mix with numbers. Turn them into numbers; a value beyond 2^53 (no
 * test amount gets there) becomes a string rather than a wrong number.
 */
export function plain(x) {
  if (typeof x === 'bigint') return x <= BigInt(Number.MAX_SAFE_INTEGER) && x >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x.toString();
  if (Array.isArray(x)) return x.map(plain);
  if (x && typeof x === 'object' && !(x instanceof Uint8Array)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}
const balance = (b) => ({ settled: num(b?.settled), future: num(b?.future), spendable: num(b?.spendable) });
const asset = (a) => ({
  assetId: String(a?.assetId ?? ''), ticker: String(a?.ticker ?? a?.name ?? '').slice(0, 12), name: String(a?.name ?? a?.ticker ?? ''),
  precision: num(a?.precision), issuedSupply: num(a?.issuedSupply), balance: balance(a?.balance),
});

/** An NFT (RGB21 / UDA): one token; its image is fetched from the transfer server by digest (see nftImage). */
const nft = (a) => ({
  assetId: String(a?.assetId ?? ''), ticker: String(a?.ticker ?? '').slice(0, 12), name: String(a?.name ?? a?.ticker ?? ''),
  details: a?.details ? String(a.details) : '', balance: balance(a?.balance),
  media: a?.media?.digest ? { digest: String(a.media.digest), mime: String(a.media.mime || '') } : null,
});
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;

const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return 'the block server'; } };

const OLD_CONSIGNMENT = /ConsignmentVe|unsupported value `0`/i;

/** How long a lot may wait in the queue for its tokens before it's given up (never moved later). */
export const LOT_QUEUE_MAX_MS = 6 * 3600_000;

/** How long "this listing hasn't sold" is trusted before the block server is asked again. */
export const LISTING_SPEND_CHECK_MS = 120_000;
// outspend answers, kept in browser storage so MASKED's popup and approval windows share them (small: a few hundred)
const SPENDS_KEY = 'masked.rgb.outspends';
let spendsMem = null, spendsReadAt = 0;
function readSpends() {
  // read again every few seconds: another MASKED window may have asked meanwhile
  if (spendsMem && Date.now() - spendsReadAt < 3000) return spendsMem;
  let saved = null;
  try { saved = JSON.parse(globalThis.localStorage?.getItem(SPENDS_KEY) || 'null'); } catch { saved = null; }
  spendsMem = saved && typeof saved === 'object' ? saved : spendsMem || {};
  spendsReadAt = Date.now();
  return spendsMem;
}
function keepSpend(key, v) {
  const m = readSpends(); m[key] = v;
  const keys = Object.keys(m);
  if (keys.length > 600) for (const k of keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - 500)) delete m[k];
  try { globalThis.localStorage?.setItem(SPENDS_KEY, JSON.stringify(m)); } catch { /* kept in memory only */ }
}
/** For tests: forget kept answers. */
export function outspendCacheClear() { spendsMem = {}; spendsReadAt = Date.now(); try { globalThis.localStorage?.removeItem(SPENDS_KEY); } catch { /* none */ } }

export class LiteWallet {
  /**
   * @param {object} lib  the loaded rgb-lib-wasm module ({ WasmWallet, WasmInvoice, restoreKeys })
   * @param {{ network: string, indexerUrl: string, indexerUrls?: string[], transportEndpoint: string, transportFallbacks?: string[], transportEndpointV1?: string, transportFallbacksV1?: string[], mnemonic: string, dataDir: string }} params  indexerUrls: block servers to try in order; transportFallbacks: more transfer servers listed in invoices after the main one
   */
  constructor(lib, params) {
    this.lib = lib;
    this.params = params;
    this.net = rgbNetwork(params.network);
    /** How long a broadcast check waits before asking the block servers again (ms). */
    this.recheckMs = 2000;
    // the RGB 0.11.2 engine speaks only transfer server protocol 1.0: its own servers (the 0.2 ones can't be used)
    const v1 = this.engineV1;
    this.transport = rpcEndpoint(v1 ? (params.transportEndpointV1 || params.transportEndpoint) : params.transportEndpoint);
    const more = v1 ? (params.transportFallbacksV1 || []) : (params.transportFallbacks || []);
    // invoices list every transfer server: a sender uses the first one that answers
    this.transports = [this.transport, ...more.map(rpcEndpoint).filter((e) => e !== this.transport)];
    /** @type {any} */ this.w = null;
    this.online = null;
    this.lastBackupBytes = null;
  }

  /**
   * The engine is UTEXO rgb-lib-wasm 1.0.0-beta.4 or later (RGB 0.11.2, transfer server protocol 1.0): its calls
   * take an Online object for receiving and options for going online. Older ones (beta.3, RGB 0.11.1) don't.
   */
  get engineV1() { return (this.lib.WasmWallet?.prototype?.goOnline?.length ?? 2) === 1; }
  /** Create the wallet, restoring its saved state from IndexedDB. */
  async init() {
    const { mnemonic, dataDir } = this.params;
    const k = this.lib.restoreKeys(this.net, mnemonic);
    const data = {
      dataDir, bitcoinNetwork: this.net, databaseType: 'Sqlite', maxAllocationsPerUtxo: 5,
      accountXpubVanilla: k.accountXpubVanilla, accountXpubColored: k.accountXpubColored,
      mnemonic, masterFingerprint: k.masterFingerprint, vanillaKeychain: null,
      // mainnet: NIA (standard RGB tokens) only; IFA is test-network only for now. NFTs (UDA) need MASKED's own engine
      // build (engine/masked-uda.patch): an engine without them refuses a wallet that names the schema
      supportedSchemas: this.net === 'Mainnet' ? ['Nia'] : ['Nia', 'Ifa', ...(this.canNft ? ['Uda'] : [])], reuseAddresses: true, // one stable funding address
    };
    // a wallet the previous engine (RGB 0.11.1) saved is upgraded in place first: same keys, tokens and history;
    // the old copy is kept. Old history that names a transaction only by its id gets it from the block server
    if (this.engineV1) {
      // never open the new engine without the upgrade: it would start an empty wallet next to the saved one
      if (typeof this.lib.migrateLegacyWallet !== 'function') throw new Error('This MASKED build has the new RGB engine without its wallet upgrade. Build it with engine/build.sh.');
      this.migration = String(await this.lib.migrateLegacyWallet(JSON.stringify(data), this.indexers()[0] || null));
    }
    this.w = await this.lib.WasmWallet.create(JSON.stringify(data));
  }
  get wallet() { if (!this.w) throw new Error('RGB wallet is not open.'); return this.w; }
  requireOnline() { if (!this.online) throw new Error('RGB wallet is offline. Try Refresh.'); return this.online; }

  /** Connect to the indexer (the SDK's unlock does the same). */
  /** Block servers to try, in order: the person's own server (if set), then the public ones. */
  indexers() {
    const list = [...(this.params.indexerUrls || []), this.params.indexerUrl].filter(Boolean).map((u) => String(u).replace(/\/+$/, ''));
    return [...new Set(list)];
  }
  async unlock() { if (!this.online) await this.goOnline(); }
  /**
   * Light syncs (engine: setLightSync): a sync asks the block server only about the last 20 addresses of each side,
   * the ones invoices wait on and the unconfirmed transactions, instead of every address ever used (hundreds of
   * requests, too many for mempool.space on mainnet). A full sync still runs at most every 30 minutes, and on a rescan.
   */
  lightSync() {
    let last;
    try { last = Number(globalThis.localStorage?.getItem(this.lastFullKey)) || undefined; } catch { last = undefined; }
    try { if (typeof this.wallet?.setLightSync === 'function') this.wallet.setLightSync(LiteWallet.LIGHT_SYNC_RECENT, last); } catch { /* full syncs as before */ }
  }
  static LIGHT_SYNC_RECENT = 20;
  isOnline() { return !!this.online; }
  /**
   * Connect to a block server. The engine accepts one only if it answers "block 0" right away, so a busy, blocked
   * or rate-limited server is skipped for the next one instead of leaving RGB unable to open.
   * @param {string} [url] one server only; otherwise each in turn, starting after `skip`
   */
  async goOnline(url, skip = '') {
    const list = url ? [url] : this.indexers();
    const start = skip ? (list.indexOf(skip) + 1) % list.length : 0;
    let last = null;
    for (let i = 0; i < list.length; i++) {
      const u = list[(start + i) % list.length];
      if (skip && u === skip && list.length > 1) continue;
      try { this.online = await this.connect(u); this.indexer = u; this.lightSync(); return u; } catch (e) {
        last = e;
        // the engine's own words for each server (the screen shows a short version)
        console.warn('[RGB] block server', u, 'refused:', e?.message || e);
      }
    }
    throw last || new Error('Invalid indexer: no block server answered');
  }
  /** The engine's go-online call for one block server. */
  connect(url) {
    return this.engineV1
      ? this.wallet.goOnline({ indexerConfig: { Esplora: { url } }, skipConsistencyCheck: true, proxyAuthKeys: {} })
      : this.wallet.goOnline(false, url);
  }
  /** Settings changed the block servers (the person's own server comes first): use the new list from the next sync. */
  setIndexers(list) { this.params = { ...this.params, indexerUrls: list }; this.retryFirstAt = 0; }
  /**
   * A failover isn't forever: go back to the first server (the person's own, when set) as soon as it answers again.
   * Tried at most every 2 minutes while it is down; the server in use stays connected if it fails.
   */
  async preferFirst() {
    const first = this.indexers()[0];
    if (!this.online || !first || this.indexer === first || Date.now() < (this.retryFirstAt || 0)) return;
    try { this.online = await this.connect(first); this.indexer = first; } catch { this.retryFirstAt = Date.now() + 120000; }
  }
  /** The block server in use failed: move to the next one (true if there was another to try). */
  async switchIndexer() {
    const list = this.indexers();
    if (list.length < 2) return false;
    const was = this.indexer;
    this.online = null;
    await this.goOnline(undefined, was);
    return this.indexer !== was;
  }
  async save() { await this.wallet.flush(); this.keepLastFull(); }
  /** Where this browser keeps when the engine last ran a full sync (each MASKED window opens the wallet anew). */
  get lastFullKey() { return `masked.rgb.last-full.${this.params?.dataDir || ''}`; }
  keepLastFull() {
    try { if (typeof this.wallet?.lastFullSync === 'function') { const t = Number(this.wallet.lastFullSync()); if (t > 0) globalThis.localStorage?.setItem(this.lastFullKey, String(t)); } } catch { /* a full sync next time */ }
  }
  async dispose() {
    const w = this.w;
    this.w = null; this.online = null; this.lastBackupBytes = null;
    if (!w) return;
    try { await w.flush(); } finally { w.free(); }
  }

  /**
   * Bring the BTC side up to date. `full`: scan addresses ahead (BIP44 gap) too, which finds coins sent to an
   * address this wallet state has not handed out yet (a restore, or an address shown by an older build).
   */
  async syncWallet({ full = false } = {}) {
    const online = this.requireOnline();
    if (full) await this.wallet.fullScan(online);
    await this.wallet.sync(online);
    await this.save();
  }
  async refreshWallet() { const r = await this.wallet.refresh(this.requireOnline(), null, [], false); await this.save(); return plain(r); }
  async getAddress() { return this.wallet.getAddress(); }
  /** Coins that hold RGB tokens but can't be spent now: a pending send uses them, or an open invoice reserves them. */
  async lockedCoins() {
    const list = plain(typeof this.wallet.listUnspents === 'function' ? this.wallet.listUnspents(false) : []) || [];
    return list.filter((u) => Number(u?.pendingBlinded) > 0 || (u?.rgbAllocations || []).some((a) => a && a.settled === false))
      .map((u) => `${u?.utxo?.outpoint?.txid}:${u?.utxo?.outpoint?.vout}`);
  }
  async getBtcBalance() { const b = plain(this.wallet.getBtcBalance()); return { vanilla: balance(b?.vanilla), colored: balance(b?.colored) }; }
  async listAssets() {
    const r = plain(this.wallet.listAssets([]) || {});
    return { nia: (r.nia || []).map(asset), ifa: (r.ifa || []).map(asset), uda: (r.uda || []).map(nft) };
  }
  /** This engine build holds NFTs (RGB21 / UDA), and this network has them on (test networks for now). */
  get canNft() { try { return this.net !== 'Mainnet' && typeof this.lib.engineFeatures === 'function' && [...this.lib.engineFeatures()].includes('uda'); } catch { return false; } }
  /** NFTs held (or arriving): asset ID, name, ticker, details, balance, image digest + mime. */
  async nfts() { return this.canNft ? (await this.listAssets()).uda.filter((a) => a.balance.future > 0 || a.balance.settled > 0) : []; }
  /**
   * An NFT's image: asked from the transfer servers by its digest, and kept only if its SHA-256 is that digest (the
   * contract commits to it, so a server can't swap the picture). A data: URL, or null when no server has it.
   */
  async nftImage(media, fetchFn = fetch) {
    if (!media?.digest || !/^[0-9a-f]{64}$/.test(media.digest) || !IMAGE_MIME.test(media.mime)) return null;
    for (const e of this.transports) {
      try {
        const j = await rpc(endpointUrl(e), 'media.get', { attachment_id: media.digest }, fetchFn);
        if (typeof j?.result !== 'string' || !j.result) continue;
        const bytes = base64.decode(j.result);
        const sum = hex.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
        if (sum !== media.digest) continue;
        return `data:${media.mime};base64,${j.result}`;
      } catch { /* next server */ }
    }
    return null;
  }
  /** Transfers of one asset, or (null) the ones tied to no asset yet. */
  async listTransfers(assetId = null) { return plain(this.engineTransfers(assetId) || []); }
  engineTransfers(assetId) {
    return this.engineV1 ? this.wallet.listTransfers(assetId ? { id: assetId } : 'noAsset', null) : this.wallet.listTransfers(assetId);
  }
  /** Give up on a transfer that is still waiting for the other side (frees the RGB output an invoice reserved). */
  async failTransfer(batchTransferIdx) {
    const r = await this.wallet.failTransfers(this.requireOnline(), batchTransferIdx, false, false);
    await this.save();
    return !!r;
  }

  /** Sign a PSBT with this wallet's own keys. */
  sign(psbt) { return this.wallet.signPsbt(psbt); }

  /** Make outputs that can hold RGB assets (one Bitcoin transaction). */
  async createUtxos({ upTo = true, num: n = 4, size = LiteWallet.UTXO_SATS, feeRate }) {
    const online = this.requireOnline();
    const begin = (u, k) => this.wallet.createUtxosBegin(online, u, k, size, BigInt(Math.round(feeRate)), false);
    let psbt;
    // upTo counts outputs that still have room for more tokens and makes only the difference, so it can make none
    // (AllocationsAlreadyAvailable) while a send still finds no output to take its change: then make 2 anyway
    try { psbt = await begin(upTo, n); } catch (e) {
      if (!upTo || !/AllocationsAlreadyAvailable|allocations already available/i.test(String(e?.message || e))) throw e;
      psbt = await begin(false, 2);
    }
    const count = await this.wallet.createUtxosEnd(online, this.sign(psbt), false);
    await this.save();
    return count;
  }

  /**
   * Plain bitcoin from this RGB wallet to an address (the person's Bitcoin balance). Outputs holding RGB tokens never
   * move. `all`: everything else, the small empty RGB outputs too (the engine drains them, tokens stay).
   * @returns {Promise<string>} txid
   */
  async sendBtcOut({ address, sats = 0, all = false, feeRate }) {
    const online = this.requireOnline();
    const rate = BigInt(Math.max(1, Math.round(Number(feeRate) || 1)));
    let txid;
    if (all) txid = await this.wallet.drainToEnd(online, this.sign(await this.wallet.drainToBegin(online, String(address), false, rate)));
    else txid = await this.wallet.sendBtcEnd(online, this.sign(await this.wallet.sendBtcBegin(online, String(address), BigInt(Math.floor(Number(sats))), rate, false)), false);
    await this.save();
    return String(txid);
  }

  /** The engine can free spare RGB outputs (engine: spareUtxos, freeSpareUtxosBegin). */
  get canFreeSpare() { return typeof this.wallet?.spareUtxos === 'function' && typeof this.wallet?.freeSpareUtxosBegin === 'function'; }
  /**
   * Outputs with no live token (a failed transfer's doesn't count) and why each isn't spare (engine: emptyUtxos):
   * Map outpoint -> '' (spare) | 'pending witness' | 'blinded receive' | 'transfer' | 'listing' | 'bitcoin operation' |
   * 'not broadcast' | 'unconfirmed'. null on an older engine.
   */
  emptyReasons() {
    if (typeof this.wallet?.emptyUtxos !== 'function') return null;
    try { return new Map((JSON.parse(String(this.wallet.emptyUtxos())) || []).map((x) => [String(x.outpoint).toLowerCase(), String(x.why || '')])); } catch { return null; }
  }
  /** Spare RGB outputs (nothing on them, nothing pending, not reserved, confirmed), as `txid:vout`; null on an older engine. */
  spareOutputs() {
    if (!this.canFreeSpare) return null;
    try { return new Set((plain(this.wallet.spareUtxos()) || []).map((x) => String(x).toLowerCase())); } catch { return null; }
  }
  /**
   * Free spare RGB outputs: keep `keep` for receiving tokens and turn the rest, with the plain bitcoin of this wallet,
   * into `parts` plain coins (several buys can go one after another). Outputs holding tokens never move.
   * @returns {Promise<{ txid: string, freed: number, sats: number }>}
   */
  /** @param {{ keep?: number, parts?: number, feeRate?: number }} [o] */
  async freeSpare({ keep = RGB_KEEP_SPARE, parts = 4, feeRate = 1 } = {}) {
    if (!this.canFreeSpare) throw new Error('This RGB engine can\'t free spare outputs yet. Update MASKED.');
    const online = this.requireOnline();
    // invoices of this wallet no transaction pays (moves that never went out): given up first, they hold nothing
    const cancelled = await this.cancelUnpaidReceives();
    const spare = [...(this.spareOutputs() || [])];
    if (spare.length <= keep && cancelled) return { txid: '', freed: 0, sats: 0, cancelled };
    if (spare.length <= keep) throw new Error(`Only ${spare.length} spare RGB output${spare.length === 1 ? '' : 's'}: MASKED keeps ${keep} for receiving tokens, so there's nothing to free.`);
    const sats = await this.spareSats(spare.slice(keep));
    const rate = BigInt(Math.max(1, Math.round(Number(feeRate) || 1)));
    const psbt = await this.wallet.freeSpareUtxosBegin(online, keep, Math.max(1, Math.min(8, Number(parts) || 4)), rate);
    const txid = String(await this.wallet.drainToEnd(online, this.sign(psbt)));
    await this.save();
    return { txid, freed: spare.length - keep, sats, cancelled };
  }
  /** Witness invoices of this wallet still waiting that no transaction pays (engine: unpaidWitnessReceives). */
  unpaidReceives() {
    if (typeof this.wallet?.unpaidWitnessReceives !== 'function') return [];
    try { return (plain(this.wallet.unpaidWitnessReceives()) || []).map(Number); } catch { return []; }
  }
  /** Give up those invoices: nothing pays them, so nothing is lost. @returns {Promise<number>} how many */
  async cancelUnpaidReceives({ olderThanMs = 3600_000 } = {}) {
    // only old ones: a move or purchase made a moment ago may not be in this wallet's view of the chain yet
    const made = new Map();
    try { for (const t of plain(this.engineTransfers(null)) || []) made.set(Number(t.batchTransferIdx), Number(t.createdAt || 0) * (Number(t.createdAt) < 1e12 ? 1000 : 1)); } catch { /* none known: none old */ }
    const idx = this.unpaidReceives().filter((i) => made.has(i) && made.get(i) > 0 && Date.now() - made.get(i) > olderThanMs);
    if (!idx.length) return 0;
    const online = this.requireOnline();
    let n = 0;
    for (const i of idx) { try { if (await this.wallet.failTransfers(online, i, false, true)) n++; } catch { /* next */ } }
    await this.save().catch(() => {});
    return n;
  }
  /** Sats on the given outputs (from the engine's list). */
  async spareSats(outpoints) {
    const want = new Set(outpoints);
    let n = 0;
    for (const u of plain(this.wallet.listUnspents(false)) || []) {
      const o = u.utxo?.outpoint; if (o && want.has(`${String(o.txid).toLowerCase()}:${o.vout}`)) n += Number(u.utxo?.btcAmount ?? 0);
    }
    return n;
  }

  /** A new asset with a fixed supply, held by this wallet. */
  async issueAssetNia({ ticker, name, precision, amounts }) {
    const a = plain(this.wallet.issueAssetNia(ticker, name, precision, amounts));
    await this.save();
    return asset(a);
  }

  /** Sats the sender puts in the new output when paying a witness invoice (above dust, so it relays). */
  /** BTC on the receiver's new output for a "No BTC needed" invoice: the Taproot dust limit, the least Bitcoin allows. */
  static WITNESS_SATS = 330;
  /** Sats on a move's RGB output for the rest of the tokens (the rest of the bitcoin goes back to the RGB balance). */
  static MOVE_KEEP_SATS = 1000;
  static UTXO_SATS = RGB_UTXO_SATS;
  /** The engine's margin between a send's expiry and its invoice's (rgb-lib INVOICE_EXPIRATION_MARGIN_SECS). */
  static INVOICE_MARGIN_SECS = 600;

  /**
   * An invoice. Blind (default): receives onto one of our RGB outputs, blinded, so the sender learns no address;
   * needs a free RGB output. Witness: the sender creates the output (and pays its sats), so it works with no BTC.
   * @param {{ assetId?: string|null, amount?: number, durationSeconds?: number|null, witness?: boolean }} [o]
   */
  /** Every recipient ID this wallet has ever had a transfer for (all assets, and receives not tied to one). */
  usedRecipients() {
    const r = plain(this.wallet.listAssets([]) || {});
    const ids = [null, ...[...(r.nia || []), ...(r.ifa || []), ...(r.uda || [])].map((a) => a?.assetId).filter(Boolean)];
    const out = new Set();
    for (const id of ids) for (const t of plain(this.engineTransfers(id)) || []) if (t?.recipientId) out.add(String(t.recipientId));
    return out;
  }
  /**
   * The engine's invoice call. The first time a token comes to this wallet the engine doesn't know it yet
   * (AssetNotFound): the invoice then names no token (the sender's tokens make it known), keeping the amount, or
   * any amount if the engine needs a token for that.
   */
  async receiveCall(make, assetId, assignment, durationSeconds) {
    // protocol 1.0: the invoice is reserved on the transfer servers (so the engine goes online) and has an expiry
    const expires = Math.floor(Date.now() / 1000) + (Number(durationSeconds) > 0 ? Number(durationSeconds) : 86400);
    const call = async (id, a) => plain(this.engineV1
      ? await this.wallet[make](this.requireOnline(), id, a, expires, this.transports, 1, null)
      : this.wallet[make](id, a, durationSeconds, this.transports, 1));
    try { return await call(assetId, assignment); } catch (e) {
      if (!assetId || !/AssetNotFound|not found/i.test(String(e?.message || e))) throw e;
      try { return await call(null, assignment); } catch (e2) { if (assignment === 'Any') throw e2; return call(null, 'Any'); }
    }
  }
  async onchainReceive({ assetId = null, amount = 0, durationSeconds = null, witness = false } = {}) {
    const assignment = amount ? { Fungible: amount } : 'Any';
    const make = witness ? 'witnessReceive' : 'blindReceive';
    // The wallet keeps one pinned address (reuseAddresses), and a witness invoice pays to the pinned *receive*
    // address. Two invoices on one address both match one payment and count it twice, so each witness invoice gets
    // a fresh receive address, and one already used by any earlier transfer is never handed out.
    const used = witness ? this.usedRecipients() : null;
    let r = null;
    for (let i = 0; i < 4; i++) {
      if (witness && typeof this.wallet.rotateAddress === 'function') this.wallet.rotateAddress(0); // 0 = receive keychain; the funding address (1) stays
      r = await this.receiveCall(make, assetId || null, assignment, durationSeconds);
      // A blind invoice puts the tokens on an output this wallet already has. If the chain shows that output spent
      // (sold through a listing whose record this copy lost, or moved by another copy) and the engine doesn't know,
      // tokens paid to it can never be moved again. Checked on the block server: such an output is marked spent and
      // the invoice made again on another one.
      if (!witness) {
        const stale = await this.blindSealSpent(r, assetId).catch(() => '');
        if (!stale) break;
        try { await this.wallet.failTransfers(this.requireOnline(), r.batchTransferIdx, false, true); } catch { /* it expires */ }
        try { this.wallet.markOutpointSpent?.(stale); } catch { /* the next invoice is checked the same way */ }
        r = null;
        continue;
      }
      if (!used.has(String(r?.recipientId ?? ''))) break;
      // a reused one is cancelled at once, so it can never match a payment
      try { await this.wallet.failTransfers(this.requireOnline(), r.batchTransferIdx, false, true); } catch { /* offline: it stays open, but it is never shown */ }
      r = null;
    }
    await this.save();
    if (!r) throw new Error('Could not make a fresh RGB invoice. Try again.');
    return { invoice: String(r?.invoice ?? ''), recipientId: String(r?.recipientId ?? ''), expirationTimestamp: r?.expirationTimestamp ?? null, batchTransferIdx: r?.batchTransferIdx ?? null };
  }

  /** A blind invoice's output (txid:vout) when the chain shows it already spent; '' when it's unspent or unknown. */
  async blindSealSpent(r, assetId = null) {
    if (r?.batchTransferIdx == null) return '';
    let t = null;
    for (const id of [...new Set([assetId || null, null])]) {
      t = (plain(this.engineTransfers(id)) || []).find((x) => Number(x?.batchTransferIdx) === Number(r.batchTransferIdx) && x?.receiveUtxo);
      if (t) break;
    }
    const u = t?.receiveUtxo;
    if (!u?.txid) return '';
    const sp = await (await this.esplora(`/tx/${u.txid}/outspend/${u.vout}`)).json();
    return sp?.spent ? `${String(u.txid).toLowerCase()}:${u.vout}` : '';
  }
  async decodeRGBInvoice({ invoice }) {
    const inv = new this.lib.WasmInvoice(invoice);
    try {
      const d = plain(inv.invoiceData());
      return {
        invoice, recipientId: String(d?.recipientId ?? ''), assetId: d?.assetId ?? undefined,
        network: String(d?.network ?? '').toLowerCase(), expirationTimestamp: d?.expirationTimestamp ?? null,
        amount: Number(d?.assignment?.Fungible || 0), witness: String(d?.recipientId ?? '').includes('wvout:'),
        transportEndpoints: (d?.transportEndpoints || []).map(String),
        // protocol 1.0 invoices: the recipient's key and encryption preference
        publicKey: d?.publicKey ? String(d.publicKey) : null, encryption: d?.encryption ?? null,
      };
    } finally { inv.free(); }
  }

  /** Send to an invoice (blind or witness): build, sign and broadcast. */
  async onchainSend({ invoice, assetId, amount, feeRate, endpoint = '', nft: isNft = false }) {
    if (isNft && !this.canNft) throw new Error('This MASKED build can\'t send NFTs. Update MASKED.');
    if (assetId) { try { await this.wallet.sync(this.requireOnline()); } catch { /* checked below with the last known state */ } await this.requireInSync(assetId); }
    if (this.engineV1) return this.onchainSendNative({ invoice, assetId, amount, feeRate, isNft });
    if (isInvoiceV1(invoice)) { if (isNft) throw new Error('MASKED can\'t send an NFT to this kind of invoice yet.'); return this.onchainSendV1({ invoice, assetId, amount, feeRate }); }
    const online = this.requireOnline();
    const d = await this.decodeRGBInvoice({ invoice });
    const recipients = {
      [assetId]: [{
        recipientId: d.recipientId,
        // a witness invoice: we create the receiver's output, with a few sats in it
        // rgb-lib-wasm wants amountSat as a string here (a number is refused), while the token amount is a number
        witnessData: d.witness ? { amountSat: String(LiteWallet.WITNESS_SATS), blinding: null } : null,
        assignment: isNft ? 'NonFungible' : { Fungible: amount },
        transportEndpoints: endpoint ? [rpcEndpoint(endpoint)] : d.transportEndpoints.length ? d.transportEndpoints : [this.transport],
      }],
    };
    if (isNft && d.assetId && d.assetId !== assetId) throw new Error('This invoice is for another asset.');
    const psbt = await this.wallet.sendBegin(online, recipients, false, BigInt(Math.round(feeRate)), 1);
    const r = plain(await this.wallet.sendEnd(online, this.sign(psbt), false));
    await this.save();
    return r;
  }

  /**
   * Send with the RGB 0.11.2 engine (protocol 1.0, built in): the recipient's key, encryption and expiry come from the
   * invoice; the recipient acknowledges on MASKED's own transfer server, and the engine broadcasts once it has.
   */
  async onchainSendNative({ invoice, assetId, amount, feeRate, isNft = false }) {
    const online = this.requireOnline();
    const d = await this.decodeRGBInvoice({ invoice });
    if (!d.transportEndpoints.length || !d.publicKey) {
      throw new Error('This invoice uses the old transfer server protocol (0.2). Ask the recipient for a new invoice from an up-to-date wallet (MASKED 2.29 or later, UniSat 1.8 or later).');
    }
    const now = Math.floor(Date.now() / 1000);
    // the send must lapse at least 10 minutes (the engine's margin for clock differences) before the invoice does,
    // so the recipient is still waiting whenever it goes out; 2 more minutes for this computer's clock
    const invoiceExp = Number(d.expirationTimestamp) || 0;
    const expires = invoiceExp ? invoiceExp - LiteWallet.INVOICE_MARGIN_SECS - 120 : now + 86400;
    if (expires < now + 300) throw new Error('This invoice expires too soon to pay safely. Ask the recipient for a new one.');
    const recipients = {
      [assetId]: [{
        recipientId: d.recipientId,
        witnessData: d.witness ? { amountSat: String(LiteWallet.WITNESS_SATS), blinding: null } : null,
        assignment: isNft ? 'NonFungible' : { Fungible: amount },
        transportEndpoints: d.transportEndpoints,
        publicKey: d.publicKey, encryption: d.encryption, expirationTimestamp: invoiceExp || null,
      }],
    };
    const begin = await this.wallet.sendBegin(online, recipients, false, BigInt(Math.round(feeRate)), 1, expires, this.transport, null, false);
    const psbt = typeof begin === 'string' ? begin : begin?.psbt;
    const r = plain(await this.wallet.sendEnd(online, this.sign(psbt), false));
    await this.save();
    return r;
  }

  /** This engine can pay invoices whose transfer server speaks RGB proxy protocol 1.0. */
  // colorSwap takes the seal blinding as its 10th argument only from the engine built with protocol 1.0 support; an
  // older one would ignore it and the recipient could never find its tokens, so it must be there
  get canProxyV1() { return !this.engineV1 && this.canSwap && (this.wallet.colorSwap?.length ?? 0) >= 10 && typeof this.wallet.pendingConsignment === 'function' && typeof this.lib.WasmWallet?.completePresignedConsignment === 'function'; }

  /**
   * Pay an invoice whose transfer server speaks RGB proxy protocol 1.0 (see proxyV1.mjs), as a donation: the
   * recipient's witness seal gets the blinding both sides derive from their keys, the consignment carries the signed
   * transaction and goes, encrypted, to the recipient's server, then MASKED broadcasts.
   */
  async onchainSendV1({ invoice, assetId, amount, feeRate }) {
    if (!this.canProxyV1) throw new Error('This MASKED build can\'t pay this invoice: its transfer server speaks protocol 1.0. Update MASKED.');
    const online = this.requireOnline();
    const d = await this.decodeRGBInvoice({ invoice });
    if (!d.witness) throw new Error('MASKED pays protocol 1.0 invoices that pay to an address (witness). Ask for that kind of invoice.');
    const q = readInvoiceV1(invoice);
    if (!q.expiry) throw new Error('This invoice has no expiry, which protocol 1.0 requires.');
    if (q.expiry <= Date.now() / 1000 + 120) throw new Error('This RGB invoice has expired.');
    const invoiceId = invoiceIdOf(q.beneficiary, q.pk);
    const picked = await pickEndpoint(q.endpoints.length ? q.endpoints : d.transportEndpoints, invoiceId);
    const sender = newSenderKey();
    const { key, blinding } = sharedKeys(sender.seed, q.pk);
    // the transaction: an RGB coin holding the tokens, bitcoin for the fee; outputs: commitment, the invoice's output,
    // change. The engine puts any token change back on another output of this wallet.
    await this.wallet.sync(online);
    // the tokens: one output if one holds enough, else several (the engine spends them all and keeps the change)
    const pick = sendCoinsFor(plain(this.wallet.listUnspents(false)) || [], assetId, amount, this.reserved);
    if (!pick.coins) throw new Error(pick.held > 0n
      ? `Only ${pick.held.toLocaleString('en-US')} of this token is settled and free in this wallet (base units). Wait for incoming transfers to settle, or send less.`
      : 'None of this token is settled and free in this wallet yet. Wait for incoming transfers to settle.');
    const froms = pick.coins;
    const rate = Math.max(1, Number(feeRate) || 1);
    const sealScript = this.lib.WasmWallet.witnessSealScript(invoice);
    const seal = BigInt(LiteWallet.WITNESS_SATS);
    const own = await this.ownScript();
    const feeFor = (n) => BigInt(Math.ceil(rate * txVbytes([...Array(froms.length).fill(P2TR_SCRIPT), ...Array(n).fill(P2TR_SCRIPT)], [OPRET_SCRIPT, sealScript, own])));
    const tokenSats = froms.reduce((t, c) => t + BigInt(c.sats), 0n);
    // the token outputs' own sats count towards the seal and the fee; bitcoin coins top up the rest
    const short = feeFor(1) + seal + 546n - tokenSats;
    const { all, confirmed } = await this.btcCoins();
    const pay = short > 0n ? payCoinsFor(confirmed, all, short, feeFor(2) - feeFor(1)) : { coins: [] };
    if (!pay) throw new Error(`Your RGB wallet needs about ${short.toLocaleString('en-US')} sats in bitcoin for this. Tap Add from Bitcoin under RGB balance on Home.`);
    const infos = await Promise.all([...froms, ...pay.coins].map((c) => this.outpointInfo(c.outpoint)));
    const sis = infos.slice(0, froms.length), fis = infos.slice(froms.length);
    const fee = BigInt(Math.ceil(rate * txVbytes(infos.map((f) => f.script), [OPRET_SCRIPT, sealScript, own])));
    const change = infos.reduce((t, f) => t + BigInt(f.sats), 0n) - seal - fee;
    if (change < 546n) throw new Error('Not enough bitcoin for the network fee.');
    const unsigned = this.lib.WasmWallet.newSwapPsbt(
      [...froms.map((c, k) => ({ outpoint: c.outpoint, sats: sis[k].sats, script: sis[k].script, tx: sis[k].tx })), ...pay.coins.map((c, k) => ({ outpoint: c.outpoint, sats: fis[k].sats, script: fis[k].script, tx: fis[k].tx }))],
      [{ script: sealScript, sats: Number(seal) }, { script: own, sats: Number(change) }],
    );
    // no 0.2 server, and the derived blinding: MASKED delivers the consignment itself
    const colored = await this.wallet.colorSwap(online, unsigned, assetId, BigInt(amount), d.recipientId, SEAL_OUTPUT, seal, [], 1, blinding);
    const signed = this.sign(colored);
    const txHex = this.extractHex(signed);
    const txid = String(this.lib.WasmWallet.psbtTxid(colored));
    // a donation's consignment carries the signed transaction (same txid: the signatures are witness data)
    try {
      const consignment = this.lib.WasmWallet.completePresignedConsignment(Uint8Array.from(this.wallet.pendingConsignment(txid, assetId)), txid, txHex);
      await deliverConsignment({ invoice: q, picked, sender, key, consignment });
    } catch (e) {
      // not delivered, so never broadcast: drop the colouring so the tokens stay spendable
      try { this.wallet.abandonColoring?.(txid); await this.save(); } catch { /* a reload drops it too */ }
      throw e;
    }
    // delivered: now broadcast (the spec: never before the upload succeeded)
    let r;
    try { r = plain(await this.wallet.sendEnd(online, signed, true)); } catch (e) {
      // refused by the network (e.g. a coin already spent by an unconfirmed transaction): it never happened, so the
      // tokens are freed; the recipient's server holds a transfer that never confirms, so that invoice is used up
      try { this.wallet.abandonColoring?.(txid); await this.save(); } catch { /* a reload drops it too */ }
      throw e;
    }
    await this.save();
    return { ...r, txid: String(r?.txid || txid), protocol: PROXY_V1 };
  }

  // ---- peer-to-peer swaps (see swap.mjs). `store` keeps each step's state across approval windows. ----
  get canSwap() { return typeof this.lib.WasmWallet?.newSwapPsbt === 'function' && typeof this.wallet.colorSwap === 'function'; }
  requireSwaps() { if (!this.canSwap) throw new Error('This MASKED build has no swap engine yet. Update MASKED.'); }
  /** The output script of this wallet's bitcoin address, hex. */
  /**
   * Where a sale's bitcoin goes: the person's Public address (a P2TR script, hex) when set; this RGB wallet otherwise.
   * The RGB wallet's own bitcoin is only for network fees.
   */
  setPayoutScript(hex) { this.payoutHex = /^5120[0-9a-f]{64}$/i.test(String(hex || '')) ? String(hex).toLowerCase() : null; }
  async payoutScript() { return this.payoutHex || this.ownScript(); }
  async ownScript() {
    const net = this.net === 'Mainnet' ? btc.NETWORK : btc.TEST_NETWORK;
    return hex.encode(btc.OutScript.encode(btc.Address(net).decode(await this.wallet.getAddress())));
  }
  /** An output from the block server: value, script and the whole transaction. */
  async outpointInfo(op) {
    const [txid, vout] = String(op).split(':');
    const base = this.indexer || this.indexers()[0];
    const [j, h] = await Promise.all([fetch(`${base}/tx/${txid}`), fetch(`${base}/tx/${txid}/hex`)]);
    if (!j.ok || !h.ok) throw new Error(`Can't read ${short(op)} from the block server (${j.ok ? h.status : j.status}).`);
    const out = (await j.json()).vout?.[Number(vout)];
    if (!Number.isSafeInteger(out?.value)) throw new Error(`${short(op)} does not exist.`);
    return { sats: out.value, script: String(out.scriptpubkey), tx: (await h.text()).trim() };
  }
  /** Every output of this wallet, RGB and plain, as "txid:vout". */
  async ownOutpoints() {
    const online = this.requireOnline();
    const rgb = plain(this.wallet.listUnspents(false)) || [];
    const plainCoins = (await this.wallet.listUnspentsVanilla(online, 0, true)) || [];
    return new Set([...rgb.map((u) => `${String(u.utxo.outpoint.txid).toLowerCase()}:${u.utxo.outpoint.vout}`), ...plainCoins.map((c) => outpointOf(c.outpoint))]);
  }
  checkNet(network) {
    if (typeof network === 'string' && network && network.toLowerCase() !== this.net.toLowerCase()) throw new Error(`This RGB wallet is on ${this.net} and the site is on ${network}.`);
  }

  /**
   * Every RGB token this wallet holds, for a site's "pick a token": [{ assetId, ticker, name, precision, spendable,
   * max, instant }] with `spendable` and `max` (the most one offer can sell) in base units, and `instant` the amounts
   * an Instant listing sells with no move (live at once). Outputs promised to Instant
   * listings don't count.
   */
  async assetList() {
    try { await this.wallet.sync(this.requireOnline()); } catch { /* last known figures */ }
    // (tokens left on this wallet's own unconfirmed moves count as free: listings can use them, see `listable`)
    const everything = this.listable(plain(this.wallet.listUnspents(false)) || []);
    const unspents = everything.filter((u) => { const o = u.utxo?.outpoint; return !o || !this.reserved.has(`${String(o.txid).toLowerCase()}:${o.vout}`); });
    const { nia, ifa } = await this.listAssets();
    // instant: amounts that sit alone on an output, so an Instant listing of exactly that is live at once (no move);
    // held: where the balance is (free, in listings, waiting for a block, unusable)
    return [...nia, ...ifa].map((a) => ({ assetId: a.assetId, ticker: a.ticker, name: a.name, precision: a.precision, spendable: String(a.balance.spendable), max: offerable(unspents, a.assetId).max, maxInstant: offerable(unspents, a.assetId).total, instant: instantAmounts(unspents, a.assetId), held: heldBreakdown(everything, a.assetId, this.reserved) }))
      .filter((a) => BigInt(a.spendable) > 0n || BigInt(a.max) > 0n);
  }

  /**
   * Everything this RGB wallet holds, output by output, with what each is doing (Settings → RGB → What's in this
   * wallet): plain bitcoin coins (amount, confirmed, just spent by this wallet), and RGB outputs (sats, the tokens on
   * them, and a state: free, on sale (an Instant listing), going live, being cancelled, waiting for a block, unusable,
   * or empty: a spare output that can take a token). `store`: the Instant listings, to name what an output is promised to.
   */
  async outputsReport(store = null) {
    const online = this.requireOnline();
    try { await this.wallet.sync(online); } catch { /* last known */ }
    if (store) this.syncOwnUnconfirmed(store);
    const all = this.listable(plain(this.wallet.listUnspents(false)) || []);
    const { nia, ifa } = await this.listAssets();
    const meta = new Map([...nia, ...ifa].map((a) => [a.assetId, { ticker: a.ticker, precision: a.precision }]));
    // what each promised output is for
    const promised = new Map();
    try { for (const [id, e] of Object.entries(store?.all?.() || {})) if (e?.role === 'seller' && e.coin && ['moving', 'queued', 'ready', 'cancelling'].includes(e.stage)) promised.set(String(e.coin).toLowerCase(), { offerId: id, stage: e.stage === 'moving' && e.resign && e.templateTxid ? 'ready' : e.stage, assetId: e.assetId, amount: String(e.amount || ''), priceSats: String(e.priceSats || ''), waiting: e.stage === 'moving' && e.waiting ? String(e.waiting).slice(0, 240) : '' }); } catch { /* none */ }
    const spareSet = this.spareOutputs();
    const reasons = this.emptyReasons();
    const rgb = all.map((u) => {
      const o = u.utxo?.outpoint || {};
      const op = `${String(o.txid).toLowerCase()}:${o.vout}`;
      const tokens = (u.rgbAllocations || []).filter((a) => a.assignment?.Fungible != null).map((a) => ({ assetId: a.assetId, ticker: meta.get(a.assetId)?.ticker || '', precision: meta.get(a.assetId)?.precision ?? 0, amount: String(a.assignment.Fungible), settled: !!a.settled }));
      const p = promised.get(op);
      const invoices = Number(u.pendingBlinded || 0);
      // a plain bitcoin coin the engine lists too: it's in `coins`
      if (!tokens.length && !invoices && u.utxo?.colorable === false) return null;
      const state = p ? (p.stage === 'ready' ? 'on sale' : p.stage === 'cancelling' ? 'cancelling' : 'going live')
        : this.reserved.has(op) ? 'promised'
          : !tokens.length && invoices ? 'invoice'
          : !tokens.length ? (spareSet && !spareSet.has(op) ? 'held' : 'empty')
            : u.utxo?.colorable === false ? 'unusable'
              : tokens.some((t) => !t.settled) || u.utxo?.exists === false ? 'waiting'
                : 'free';
      return { outpoint: op, sats: Number(u.utxo?.btcAmount ?? 0), tokens, state, listing: p || null, invoices, why: state === 'held' ? (reasons?.get(op) || '') : '' };
    }).filter(Boolean);
    // tokens waiting on a transaction no block server has (dropped from the mempool, or never sent): they never arrived
    const missing = new Map();
    for (const o of rgb.filter((x) => x.state === 'waiting').slice(0, 6)) {
      const txid = o.outpoint.split(':')[0];
      if (!missing.has(txid)) missing.set(txid, await this.txMissing(txid));
      if (missing.get(txid)) o.state = 'dropped';
    }
    let coins = [];
    try {
      const vanilla = (await this.wallet.listUnspentsVanilla(online, 0, true)) || [];
      const conf = new Set(((await this.wallet.listUnspentsVanilla(online, 1, true)) || []).map((c) => String(outpointOf(c.outpoint) || '')));
      const spent = this.justSpent();
      coins = vanilla.filter((c) => !c.is_spent).map((c) => { const op = String(outpointOf(c.outpoint) || ''); return { outpoint: op, sats: Number(c.txout?.value ?? 0), confirmed: conf.has(op), justSpent: spent.has(op.toLowerCase()) }; });
    } catch { coins = []; }
    const order = { 'on sale': 0, 'going live': 1, cancelling: 2, promised: 3, invoice: 4, free: 5, waiting: 6, dropped: 7, unusable: 8, held: 9, empty: 10 };
    rgb.sort((a, b) => order[a.state] - order[b.state] || b.tokens.length - a.tokens.length);
    coins.sort((a, b) => b.sats - a.sats);
    // per token: where its balance is
    const byToken = [...meta].map(([assetId, m]) => ({ assetId, ...m, ...heldBreakdown(all, assetId, this.reserved) })).filter((t) => [t.free, t.listed, t.waiting, t.other].some((v) => BigInt(v) > 0n));
    // recent activity: token transfers (sends, receives, moves) and Instant listings (sold, bought, cancelled)
    const activity = [];
    for (const [assetId, m] of meta) {
      let list = [];
      try { list = plain(this.engineTransfers(assetId)) || []; } catch { list = []; }
      for (const t of list) {
        const amount = (t.assignments || []).reduce((n, x) => n + BigInt(x?.Fungible ?? 0), 0n);
        activity.push({ type: 'transfer', assetId, ticker: m.ticker, precision: m.precision, kind: String(t.kind || ''), status: String(t.status || ''), amount: String(amount), txid: t.txid ? String(t.txid) : '', at: Number(t.createdAt || 0) * (Number(t.createdAt) < 1e12 ? 1000 : 1) });
      }
    }
    try {
      for (const [id, e] of Object.entries(store?.all?.() || {})) {
        if (!e || !['seller', 'buyer'].includes(e.role)) continue;
        const m = meta.get(e.assetId) || { ticker: '', precision: 0 };
        activity.push({ type: 'listing', offerId: id, role: e.role, stage: String(e.stage === 'moving' && e.resign && e.templateTxid ? 'ready' : e.stage || ''), assetId: e.assetId || '', ticker: m.ticker || '', precision: m.precision ?? 0, amount: String(e.amount || '0'), priceSats: String(e.priceSats || ''), coin: e.coin || '', txid: String(e.soldTxid || e.cancelTxid || e.txid || e.moveTxid || ''), at: Number(e.at || 0) });
      }
    } catch { /* none */ }
    activity.sort((a, b) => b.at - a.at);
    // receives still waiting for the other side (their transfer data): an output paying one stays "pending witness"
    const pendingReceives = [];
    for (const id of [null, ...meta.keys()]) {
      let list = [];
      try { list = plain(this.engineTransfers(id)) || []; } catch { list = []; }
      for (const t of list) {
        if (!/^Receive/.test(String(t.kind || '')) || String(t.status) !== 'WaitingCounterparty') continue;
        const m = id ? meta.get(id) : null;
        const sec = (v) => Number(v || 0) * (Number(v) < 1e12 ? 1000 : 1);
        pendingReceives.push({ batchTransferIdx: t.batchTransferIdx ?? null, assetId: id || '', ticker: m?.ticker || '', precision: m?.precision ?? 0, kind: String(t.kind), witness: String(t.kind) === 'ReceiveWitness', amount: String((t.requestedAssignment && (t.requestedAssignment.Fungible ?? '')) || ''), recipientId: String(t.recipientId || ''), txid: t.txid ? String(t.txid) : '', at: sec(t.createdAt), expires: sec(t.expiration), unpaid: false });
      }
    }
    const unpaid = new Set(this.unpaidReceives());
    for (const p of pendingReceives) p.unpaid = p.witness && unpaid.has(Number(p.batchTransferIdx));
    pendingReceives.sort((a, b) => b.at - a.at);
    return { at: Date.now(), coins, rgb, tokens: byToken, activity: activity.slice(0, 40), pendingReceives: pendingReceives.slice(0, 100), unpaidReceives: unpaid.size, canFreeSpare: this.canFreeSpare, keepSpare: RGB_KEEP_SPARE };
  }

  /** This wallet's plain bitcoin coins: confirmed, and all (with its own unconfirmed change). */
  async btcCoins() {
    const online = this.requireOnline();
    const all = (await this.wallet.listUnspentsVanilla(online, 0, false)) || [];
    const confirmed = (await this.wallet.listUnspentsVanilla(online, 1, true)) || [];
    // never a coin this wallet's own transaction spent a moment ago: the block server may not show it spent yet, and
    // a second transaction on it is refused ("insufficient fee", the second of two Instant buys in a row)
    const spent = this.justSpent();
    const ok = (c) => !spent.has(String(outpointOf(c.outpoint) || '').toLowerCase());
    return { all: all.filter(ok), confirmed: confirmed.filter(ok) };
  }
  /** Coins this wallet's own transactions spent in the last hour (`spentNow`). */
  justSpent() {
    const now = Date.now(), m = this._justSpent || (this._justSpent = new Map());
    for (const [k, at] of m) if (now - at > 3600_000) m.delete(k);
    return new Set(m.keys());
  }
  spentNow(outpoints) {
    const m = this._justSpent || (this._justSpent = new Map());
    for (const o of outpoints || []) if (o) m.set(String(o).toLowerCase(), Date.now());
  }

  /** How much of an asset this wallet can offer: { total, max } (one swap uses one RGB output). */
  async offerableAmount({ assetId }) {
    try { await this.wallet.sync(this.requireOnline()); } catch { /* last known figures */ }
    return offerable(plain(this.wallet.listUnspents(false)) || [], String(assetId || ''));
  }

  /** Buyer, step 1: pick a bitcoin output (confirmed first), make an invoice for the tokens. Returns the session for the seller. */
  async prepareBuy({ offerId, network, offer, feeRate }, store) {
    this.requireSwaps(); this.checkNet(network);
    const o = readOffer(offer, offerId);
    if (o.state && o.state !== 'OPEN') throw new Error(`The offer is ${o.state.toLowerCase()}.`);
    const fee = BigInt(Math.ceil(Math.max(1, Number(feeRate) || 1) * SWAP_SIZE_VB));
    const need = o.priceSats + fee + BigInt(SEAL_SATS);
    const { all, confirmed } = await this.btcCoins();
    // the four-step format takes one bitcoin input: a confirmed coin, or change from this wallet's last trade
    const coin = buyerCoinFor(confirmed, need) || buyerCoinFor(all, need);
    if (!coin) throw new Error(`Your RGB wallet needs one bitcoin output over ${need.toLocaleString('en-US')} sats. Tap Add from Bitcoin under RGB balance on Home.`);
    // an invoice for exactly this amount; no asset ID (the engine only takes known ones), the token is checked at signing
    const r = await this.onchainReceive({ assetId: null, amount: Number(o.amount), durationSeconds: 86400, witness: true });
    const session = {
      offerId: o.offerId, assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats),
      buyerInvoice: r.invoice, buyerSeal: this.lib.WasmWallet.witnessSealScript(r.invoice),
      buyerOutpoint: coin.outpoint, buyerInputSats: coin.sats, buyerChangeScript: await this.ownScript(), feeSats: String(fee),
    };
    store.set(o.offerId, { ...session, recipientId: r.recipientId, at: Date.now() });
    return session;
  }

  /** Seller, step 2: build the swap transaction with the RGB transfer. Returns { psbt, sellerOutpoint, consignment }. */
  async prepareSale({ offerId, network, session, offer }, store) {
    this.requireSwaps(); this.checkNet(network);
    const o = readOffer(offer, offerId);
    try { await this.wallet.sync(this.requireOnline()); } catch { /* checked with the last known state */ }
    await this.requireInSync(o.assetId);
    if (o.state && o.state !== 'MATCHED') throw new Error(`The offer is ${o.state.toLowerCase()}.`);
    const s = session || {};
    if (changedTerms(o, s)) throw new Error('The buyer prepared different terms.');
    const inv = new this.lib.WasmInvoice(String(s.buyerInvoice || ''));
    let d; try { d = plain(inv.invoiceData()); } finally { inv.free(); }
    if (String(d.network).toLowerCase() !== this.net.toLowerCase()) throw new Error('The buyer\'s invoice is for another network.');
    if (d.assignment?.Fungible != null && String(d.assignment.Fungible) !== String(o.amount)) throw new Error('The buyer\'s invoice asks for another amount.');
    const seal = this.lib.WasmWallet.witnessSealScript(s.buyerInvoice);
    if (seal !== s.buyerSeal) throw new Error('The buyer\'s seal does not match its invoice.');
    const buyerOutpoint = outpointOf(s.buyerOutpoint);
    if (!buyerOutpoint) throw new Error('The buyer\'s bitcoin input is not an output.');
    // asked again for the same buyer (a retry, a double click): the same transaction, never a second one
    const prev = store.get(o.offerId);
    if (prev?.psbt && prev.buyerOutpoint === buyerOutpoint && !changedTerms(prev, o)) return { psbt: prev.psbt, sellerOutpoint: prev.sellerOutpoint, consignment: prev.consignment };
    const online = this.requireOnline();
    await this.wallet.sync(online);
    if ((await this.ownOutpoints()).has(buyerOutpoint)) throw new Error('The buyer\'s input is one of this wallet\'s own.');
    const mine = freeSellerCoinFor(plain(this.wallet.listUnspents(false)) || [], o.assetId, o.amount, this.reserved);
    if (!mine) throw new Error('No settled RGB output of this wallet holds that much of the token. Wait for incoming transfers to settle.');
    const [si, bi] = await Promise.all([this.outpointInfo(mine.outpoint), this.outpointInfo(buyerOutpoint)]);
    const fee = BigInt(s.feeSats), change = BigInt(bi.sats) - o.priceSats - fee;
    if (change < 0n) throw new Error('The buyer\'s bitcoin does not cover the price and the fee.');
    if (BigInt(fee) > 2_000_000n) throw new Error('The network fee is unreasonably high.');
    const payout = payoutFor(o.priceSats, si.sats);
    const unsigned = this.lib.WasmWallet.newSwapPsbt(
      [{ outpoint: mine.outpoint, sats: si.sats, script: si.script, tx: si.tx }, { outpoint: buyerOutpoint, sats: bi.sats, script: bi.script, tx: bi.tx }],
      [{ script: seal, sats: SEAL_SATS }, { script: await this.payoutScript(), sats: Number(payout) }, { script: String(s.buyerChangeScript), sats: Number(change) }],
    );
    const endpoints = (d.transportEndpoints || []).length ? d.transportEndpoints : [this.transport];
    const psbt = this.engineV1
      ? await this.wallet.colorSwap(online, unsigned, o.assetId, BigInt(o.amount), String(s.buyerInvoice), SEAL_OUTPUT, BigInt(SEAL_SATS), 1, this.transport, null)
      : await this.wallet.colorSwap(online, unsigned, o.assetId, o.amount, String(d.recipientId), SEAL_OUTPUT, BigInt(SEAL_SATS), endpoints, 1);
    await this.save();
    const txid = this.lib.WasmWallet.psbtTxid(psbt);
    const consignment = b64(this.wallet.pendingConsignment(txid, o.assetId));
    store.set(o.offerId, { assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats), txid, sellerOutpoint: mine.outpoint, buyerOutpoint, psbt, consignment, at: Date.now() });
    return { psbt, sellerOutpoint: mine.outpoint, consignment };
  }

  /** Buyer, step 3: check the seller's transfer and every output, then sign this wallet's input. */
  async signBuy({ offerId, psbt, consignment, offer }, store) {
    this.requireSwaps();
    const s = store.get(String(offerId));
    if (!s) throw new Error('This wallet did not prepare that purchase.');
    const o = readOffer(offer, offerId);
    if (changedTerms(s, o)) throw new Error('The offer changed after you prepared it.');
    const inputs = this.lib.WasmWallet.psbtOutpoints(String(psbt)).map(outpointOf);
    if (inputs.length !== 2 || inputs[1] !== s.buyerOutpoint) throw new Error('The transaction does not spend the bitcoin you prepared.');
    const sellerOutpoint = inputs[0];
    await this.wallet.sync(this.requireOnline());
    if ((await this.ownOutpoints()).has(sellerOutpoint)) throw new Error('The seller\'s input is one of this wallet\'s own.');
    const txid = this.lib.WasmWallet.psbtTxid(String(psbt));
    let v;
    try { v = plain(this.lib.inspectSwapConsignment(unb64(consignment), txid, this.net, SEAL_OUTPUT)); } catch (e) { throw new Error(`The seller's token transfer does not check out: ${e?.message || e}`); }
    if (!v?.valid) throw new Error(`The seller's token transfer does not check out: ${v?.details || v?.error || 'invalid'}`);
    const { contractId, sealAmount } = inspected(v);
    if (contractId !== s.assetId) throw new Error('The transfer is for another token than the offer.');
    if (sealAmount == null || BigInt(String(sealAmount)) !== BigInt(s.amount)) throw new Error(`The transfer gives you ${sealAmount ?? 'nothing'}, the offer says ${s.amount}.`);
    const si = await this.outpointInfo(sellerOutpoint);
    this.lib.WasmWallet.verifySwapPsbt(String(psbt), [sellerOutpoint, s.buyerOutpoint], buyerOutputs(s, si.sats), BigInt(s.feeSats));
    const signed = this.sign(String(psbt));
    store.del(String(offerId));
    await this.save();
    return { offerId: String(offerId), psbt: signed, assetId: s.assetId, amount: s.amount, priceSats: s.priceSats };
  }

  /** Seller, step 4: sign this wallet's input, broadcast, post the transfer to the buyer. Returns { txid }. */
  async completeSale({ offerId, psbt, offer }, store) {
    this.requireSwaps();
    if (typeof psbt !== 'string' || !psbt) throw new Error('The signed transaction is missing.');
    const sale = store.get(String(offerId));
    if (sale?.sent) return { txid: sale.sent }; // already broadcast (a retry)
    const txid = this.lib.WasmWallet.psbtTxid(psbt);
    const own = await this.ownOutpoints();
    const ownSpent = this.lib.WasmWallet.psbtOutpoints(psbt).map(outpointOf).filter((x) => own.has(x));
    const why = completionBlocker({ sale, offer: readOffer(offer, offerId), txid, ownSpent });
    if (why) throw new Error(why);
    const r = plain(await this.wallet.sendEnd(this.requireOnline(), this.sign(psbt), true));
    store.set(String(offerId), { ...sale, psbt: undefined, consignment: undefined, sent: String(r?.txid || txid), at: Date.now() });
    await this.save();
    return { txid: String(r?.txid || txid) };
  }

  // ---- Instant listings: pre-signed once, bought with the seller offline (engine: presign_sale) ----
  // Seller: the tokens go to their own output first if needed (one transaction), then MASKED signs that output with
  // SIGHASH_SINGLE|ANYONECANPAY: valid only with output 0 paying the seller its price. The output stays reserved in
  // the engine (never used for anything else) until it's sold or the listing is cancelled (which moves it).
  get canPresign() { return typeof this.wallet.presignSale === 'function' && typeof this.lib.WasmWallet?.presignedBuyPsbt === 'function'; }
  requirePresign() { if (!this.canPresign) throw new Error('This MASKED build can\'t make Instant listings yet. Update MASKED.'); }
  /** The engine can spend and list outputs of this wallet's own unconfirmed moves (all lots signed at once). */
  get canChainLots() { return this.canPresign && typeof this.wallet.setOwnUnconfirmed === 'function' && typeof this.wallet.setSwapChangeVout === 'function' && /** @type {any} */ (this).lotsChain !== false; }
  /**
   * Tell the engine which unconfirmed transactions are this wallet's own moves (listing and lot moves in `store`, plus
   * `extra`): their outputs can be moved, listed or cancelled before they confirm. The engine checks each is a
   * transaction it has, funded by an output of its own.
   */
  syncOwnUnconfirmed(store, extra = []) {
    if (typeof this.wallet?.setOwnUnconfirmed !== 'function') return;
    let ids = [];
    try { ids = Object.values(store?.all?.() || {}).filter((e) => e?.role === 'seller' && e.moveTxid).map((e) => String(e.moveTxid).toLowerCase()); } catch { ids = []; }
    this.ownMoves = [...new Set([...ids, ...(this.ownMoves || []), ...extra.map((t) => String(t).toLowerCase())])].slice(-200);
    try { this.wallet.setOwnUnconfirmed(this.ownMoves); } catch { /* an older engine: moves wait for their block */ }
  }
  /**
   * The RGB outputs as the listing code picks from them: with an engine that moves and lists outputs of this wallet's
   * own unconfirmed moves, the tokens on those outputs count as free too (the rest of the tokens after a lot's move,
   * say). Before, they only counted after the move's block ("None of this token is settled and free").
   */
  listable(unspents) {
    const own = new Set(this.canChainLots ? this.ownMoves || [] : []);
    if (!own.size) return unspents;
    return (unspents || []).map((u) => (own.has(String(u.utxo?.outpoint?.txid).toLowerCase())
      ? { ...u, utxo: { ...u.utxo, exists: true }, rgbAllocations: (u.rgbAllocations || []).map((a) => ({ ...a, settled: true })) }
      : u));
  }
  /** @type {Set<string>} */
  get reserved() { return this._reserved || new Set(); }
  /** The outputs promised to Instant listings; the engine never spends, receives on or adds change to them. */
  reserve(list) {
    this._reserved = new Set((list || []).map(String));
    if (typeof this.wallet?.setReservedOutpoints === 'function') this.wallet.setReservedOutpoints([...this._reserved]);
  }
  async esplora(path, init) {
    const base = this.indexer || this.indexers()[0];
    const r = await fetch(`${base}${path}`, init);
    if (!r.ok) throw new Error(`Block server: ${(await r.text().catch(() => '')).slice(0, 160) || r.status}`);
    return r;
  }
  /**
   * Whether an output is spent ({ spent, txid }), from the block server. A spent output stays spent, so that answer is
   * kept (10 minutes, across MASKED's windows). "Not spent" is reused only when the caller allows it (`maxAgeMs`):
   * every refresh asked about each open listing, again in each approval window (hundreds of requests per tap).
   * @param {string} txid @param {number|string} vout @param {number} [maxAgeMs] how old a "not spent" may be
   */
  async outspend(txid, vout, maxAgeMs = 0) {
    const key = `${String(txid).toLowerCase()}:${vout}`, now = Date.now();
    const kept = readSpends()[key];
    if (kept && (kept.spent ? now - kept.at < 600_000 : maxAgeMs > 0 && now - kept.at < maxAgeMs)) return kept;
    const sp = await (await this.esplora(`/tx/${txid}/outspend/${vout}`)).json();
    keepSpend(key, { spent: !!sp?.spent, txid: sp?.txid ? String(sp.txid) : '', at: now });
    return sp;
  }
  /** Transactions this wallet made itself: its transfers (sends, receives, listing and lot moves), plus `extra`. */
  ownTxids(extra = []) {
    const own = new Set((extra || []).filter(Boolean).map((t) => String(t).toLowerCase()));
    try {
      const r = plain(this.wallet.listAssets([]) || {});
      for (const a of [...(r.nia || []), ...(r.ifa || []), ...(r.uda || [])]) for (const t of plain(this.engineTransfers(a.assetId)) || []) if (t?.txid) own.add(String(t.txid).toLowerCase());
    } catch { /* no list: every spend counts as another copy's */ }
    return own;
  }
  /**
   * Before tokens move (a listing, lots, a send): is this wallet up to date for them? Every output it counts as
   * holding the token is checked on the block server. One spent there by a transaction this wallet didn't make means
   * it is behind the chain (another copy of the wallet moved it): it refreshes once and checks again; still behind, it
   * stops with what it found, before anything is signed.
   * One spent by this wallet's own transaction (the previous lot's move, say) is only its own move waiting for its
   * block: the engine still counts the output until then. `allowOwn` (MASKED picks the outputs itself: listings and
   * lots) goes ahead without those outputs; otherwise (the engine picks) it waits for that block. Before, both were
   * "behind the chain", which stopped the second lot of a split after the first lot's move.
   * @param {string} assetId @param {(t: string) => void} [onStep] @param {{ allowOwn?: boolean, own?: string[] }} [o]
   * @returns {Promise<Set<string>>} the outputs this wallet's own unconfirmed moves spent (never to be used)
   */
  async requireInSync(assetId, onStep = (_t) => {}, { allowOwn = false, own: extra = [] } = {}) {
    if (typeof this.wallet?.listUnspents !== 'function') return new Set(); // an engine without the list (nothing to check)
    const opOf = (u) => `${String(u.utxo?.outpoint?.txid).toLowerCase()}:${u.utxo?.outpoint?.vout}`;
    const spentOnChain = async () => {
      const held = (plain(this.wallet.listUnspents(false)) || []).filter((u) => u.utxo?.exists !== false && (u.rgbAllocations || []).some((a) => a.assetId === assetId && a.settled));
      const own = this.ownTxids(extra), gone = [], mine = new Set();
      /** @type {Record<string, string>} */ const spentBy = {};
      for (const u of held.slice(0, 40)) {
        const [txid, vout] = opOf(u).split(':');
        try {
          const sp = await this.outspend(txid, vout);
          if (sp?.spent) { if (sp.txid && own.has(String(sp.txid).toLowerCase())) mine.add(opOf(u)); else { gone.push(opOf(u)); spentBy[opOf(u)] = String(sp.txid || ''); } }
        } catch { /* the block server didn't answer: not counted */ }
      }
      return { gone, mine, spentBy };
    };
    onStep('Checking this wallet is up to date with the chain…');
    let r = await spentOnChain();
    if (r.gone.length || r.mine.size) {
      onStep('Catching up with the chain…');
      try { await this.wallet.sync(this.requireOnline()); await this.wallet.refresh(this.requireOnline(), null, [], false); await this.save(); } catch { /* checked again below */ }
      r = await spentOnChain();
    }
    const { gone, mine, spentBy } = r;
    if (gone.length) throw new Error(`This RGB wallet is behind the chain for this token: it still counts ${gone.length === 1 ? 'an output' : `${gone.length} outputs`} the network shows as already spent (${gone.slice(0, 2).map((o) => `${o.slice(0, 10)}…:${o.split(':')[1]}${spentBy[o] ? ` by ${spentBy[o].slice(0, 10)}…` : ''}`).join(', ')}). Nothing was sent. Open MASKED → RGB, tap Refresh and wait a minute, then try again. Still there: Settings → RGB → Check RGB against the chain.`);
    if (mine.size && !allowOwn) throw Object.assign(new Error('Your last move of this token is still waiting for its block. Try again after it confirms (about 10 minutes). Nothing was sent.'), { code: 'OWN_MOVE_PENDING' });
    return mine;
  }
  /**
   * Repair from the chain: every output this wallet counts as holding tokens, checked on the block server. Returns
   * the ones already spent there ({ outpoint, assets: [{ assetId, amount }] }); with `fix`, marks them spent so the
   * balance only counts tokens this copy can really move (the ones moved by another copy of this wallet stay with it).
   */
  async repairFromChain({ fix = false } = {}) {
    if (typeof this.wallet?.listUnspents !== 'function') return [];
    await this.wallet.sync(this.requireOnline());
    try { await this.wallet.refresh(this.requireOnline(), null, [], false); } catch { /* checked below */ }
    const held = (plain(this.wallet.listUnspents(false)) || []).filter((u) => u.utxo?.exists !== false && (u.rgbAllocations || []).some((a) => a.settled));
    // transactions this wallet made itself (its transfers, its listing and lot moves): an output one of them spends is
    // this wallet's own doing, already in its records once the engine catches up, never "another copy"
    const own = this.ownTxids();
    const gone = [];
    for (const u of held.slice(0, 100)) {
      const op = `${String(u.utxo.outpoint.txid).toLowerCase()}:${u.utxo.outpoint.vout}`;
      let sp = null;
      try { sp = await this.outspend(u.utxo.outpoint.txid, u.utxo.outpoint.vout); } catch { continue; }
      if (!sp?.spent || (sp.txid && own.has(String(sp.txid).toLowerCase()))) continue;
      gone.push({ outpoint: op, assets: (u.rgbAllocations || []).filter((a) => a.settled).map((a) => ({ assetId: a.assetId, amount: String(a.assignment?.Fungible ?? a.amount ?? 0) })) });
    }
    if (fix && gone.length) {
      if (typeof this.wallet.markOutpointSpent !== 'function') throw new Error('This MASKED build can\'t repair RGB from the chain. Update MASKED.');
      for (const g of gone) this.wallet.markOutpointSpent(g.outpoint);
      this.reserve([...this.reserved].filter((x) => !gone.some((g) => g.outpoint === x)));
      await this.save();
    }
    return gone;
  }
  /** Move the tokens of a listing onto an output of their own (or a listed output back, when cancelling). */
  async instantMove(assetId, amount, from, feeRate, onStep = (_t) => {}, { feeFromInputs = true } = {}) {
    const online = this.requireOnline();
    const rate = Math.max(1, Number(feeRate) || 1);
    // `from`: one output holding the tokens, or several (tokens spread over outputs are joined in the same move)
    const froms = Array.isArray(from) ? from : [from];
    // An engine that keeps the rest of the tokens on this move's own output (setSwapChangeVout): that output is a small
    // RGB output (KEEP sats), and the rest of the bitcoin goes back to the RGB balance, where fees are paid from. All
    // the change on the RGB output instead (2.29.25 v3) left the RGB balance empty after a move ("needs about 1,131
    // sats in bitcoin for the network fee" with 50,000 on an RGB output).
    const split = typeof this.wallet.setSwapChangeVout === 'function';
    const KEEP = split ? BigInt(LiteWallet.MOVE_KEEP_SATS) : 0n;
    const outsFor = (back) => [OPRET_SCRIPT, P2TR_SCRIPT, P2TR_SCRIPT, ...(back ? [P2TR_SCRIPT] : [])];
    const feeFor = (n, back = split) => BigInt(Math.ceil(rate * txVbytes([...Array(froms.length).fill(P2TR_SCRIPT), ...Array(n).fill(P2TR_SCRIPT)], outsFor(back))));
    const perInput = feeFor(2) - feeFor(1);
    const sis = await Promise.all(froms.map((c) => this.outpointInfo(c.outpoint)));
    const have = sis.reduce((t, f) => t + BigInt(f.sats), 0n);
    // the token outputs' own sats pay the fee when they're enough (a chained lot move; an RGB output holding the
    // bitcoin of an earlier move): no other coin needed
    let pay = null;
    if (feeFromInputs && have >= feeFor(0, false) + BigInt(INSTANT_SEAL_SATS) + KEEP + (split ? 0n : 546n)) pay = { coins: [] };
    const need = feeFor(1) + BigInt(INSTANT_SEAL_SATS) + KEEP + 546n;
    const { all, confirmed } = pay ? { all: [], confirmed: [] } : await this.btcCoins();
    pay = pay || payCoinsFor(confirmed, all, need > have ? need - have : 1n, perInput);
    if (!pay) throw new Error(`Your RGB wallet needs about ${need.toLocaleString('en-US')} sats in bitcoin for the network fee. Tap Add from Bitcoin under RGB balance on Home.`);
    const fis = await Promise.all(pay.coins.map((c) => this.outpointInfo(c.outpoint)));
    const infos = [...sis, ...fis];
    const r = await this.onchainReceive({ assetId, amount: Number(amount), durationSeconds: 86400, witness: true });
    // nothing went out: give the invoice up, so a retry doesn't leave one more waiting forever (96 of them on Signet)
    const dropInvoice = async () => {
      if (r?.batchTransferIdx == null) return;
      try { await this.wallet.failTransfers(this.requireOnline(), r.batchTransferIdx, false, true); } catch { /* it expires */ }
      await this.save().catch(() => {});
    };
    let stage = 'build'; // build → send (the engine has it, maybe out) → refused (the engine rolled back)
    try {
    const seal = this.lib.WasmWallet.witnessSealScript(r.invoice);
    // the real size, from the real scripts
    const own = await this.ownScript();
    const total = infos.reduce((t, f) => t + BigInt(f.sats), 0n);
    let outs;
    if (split) {
      // the RGB output for the rest of the tokens (KEEP sats), then the rest of the bitcoin back, if it's worth an output
      const back = total - BigInt(INSTANT_SEAL_SATS) - KEEP - BigInt(Math.ceil(rate * txVbytes(infos.map((f) => f.script), [OPRET_SCRIPT, seal, own, own])));
      const alone = total - BigInt(INSTANT_SEAL_SATS) - BigInt(Math.ceil(rate * txVbytes(infos.map((f) => f.script), [OPRET_SCRIPT, seal, own])));
      if (back >= 546n) outs = [{ script: seal, sats: INSTANT_SEAL_SATS }, { script: own, sats: Number(KEEP) }, { script: own, sats: Number(back) }];
      else if (alone >= KEEP) outs = [{ script: seal, sats: INSTANT_SEAL_SATS }, { script: own, sats: Number(alone) }];
      else throw new Error('Not enough bitcoin for the network fee.');
    } else {
      const change = total - BigInt(INSTANT_SEAL_SATS) - BigInt(Math.ceil(rate * txVbytes(infos.map((f) => f.script), [OPRET_SCRIPT, seal, own])));
      if (change < 546n) throw new Error('Not enough bitcoin for the network fee.');
      outs = [{ script: seal, sats: INSTANT_SEAL_SATS }, { script: own, sats: Number(change) }];
    }
    const unsigned = this.lib.WasmWallet.newSwapPsbt(
      [...froms.map((c, k) => ({ outpoint: c.outpoint, sats: sis[k].sats, script: sis[k].script, tx: sis[k].tx })), ...pay.coins.map((c, k) => ({ outpoint: c.outpoint, sats: fis[k].sats, script: fis[k].script, tx: fis[k].tx }))],
      outs,
    );
    // the rest of the tokens stay on this move's own change output (an engine that can): no free RGB output needed,
    // and the next lot of a chain moves from it at once
    if (typeof this.wallet.setSwapChangeVout === 'function') this.wallet.setSwapChangeVout(SEAL_OUTPUT + 1);
    const psbt = this.engineV1
      ? await this.wallet.colorSwap(online, unsigned, assetId, BigInt(amount), r.invoice, SEAL_OUTPUT, BigInt(INSTANT_SEAL_SATS), 1, this.transport, null)
      : await this.wallet.colorSwap(online, unsigned, assetId, BigInt(amount), r.recipientId, SEAL_OUTPUT, BigInt(INSTANT_SEAL_SATS), [this.transport], 1);
    const signed = this.sign(psbt);
    const txid = String(this.lib.WasmWallet.psbtTxid(psbt));
    let txHex = '';
    try { txHex = this.extractHex(signed); } catch { /* the engine broadcasts it; checked below when we have the hex */ }
    let sent = null, sendErr = null;
    stage = 'send';
    onStep(`Sending the transaction to ${hostOf(this.indexer)}…`);
    try { sent = plain(await this.wallet.sendEnd(online, signed, true)); } catch (e) { sendErr = e; }
    await this.save();
    const id = String(sent?.txid || txid);
    // The engine refused the transfer itself (not just the broadcast): it rolled its records back, so it would never
    // count tokens this transaction moves. Never broadcast it then: the tokens would land where the wallet can't see.
    if (sendErr && !/broadcast|esplora|fetch|network|timed? ?out|50[0-9]|429|too many|connection/i.test(String(sendErr?.message || sendErr))) { stage = 'refused'; throw sendErr; }
    // the engine's broadcast can fail quietly on a busy server: make sure a block server has it
    if (txHex) await this.ensureBroadcast(txHex, id);
    else if (sendErr) throw sendErr;
    this.spentNow([...froms.map((c) => c.outpoint), ...pay.coins.map((c) => c.outpoint)]);
    return { txid: id, txHex };
    } catch (err) {
      // given up before anything could go out: the invoice goes too (once sent, it stays: its transfer is on the way)
      if (stage !== 'send') await dropInvoice();
      throw err;
    }
  }
  /** Wait until the block server in use has `txid` (at most `ms`). */
  /**
   * Wait (at most `ms`) until the engine can move `outpoint`, the change of this wallet's own move: the block server
   * in use has the transaction, a sync took it in, and the move's transfer waits only for confirmations (this wallet,
   * its own receiver, took the transfer in and acknowledged it: a refresh does that). Until then the engine refuses
   * it as "none of its inputs is an RGB output of this wallet" (seen on Signet: 1 of 10, then 1 of 5 lots listed).
   * Says what it waits for. @returns {Promise<boolean>}
   */
  async waitOwnOutput(online, outpoint, onStep = (_t) => {}, txHex = '', assetId = null, ms = /** @type {any} */ (this).ownOutputWaitMs ?? 60_000) {
    const want = String(outpoint).toLowerCase(), txid = want.split(':')[0];
    const end = Date.now() + ms;
    const chains = typeof this.wallet?.ownMovesChain === 'function';
    // listed by the engine, and seen on the block server by its last sync (`exists`): the engine moves an own move's
    // output only once it has that move's transaction
    const listed = () => (plain(this.wallet.listUnspents(false)) || []).some((u) => `${String(u.utxo?.outpoint?.txid).toLowerCase()}:${u.utxo?.outpoint?.vout}` === want && (!chains || u.utxo?.exists !== false));
    // an engine that moves from an own move's change before taking the move in (ownMovesChain) needs only the output
    const ready = () => {
      if (!assetId || chains) return true;
      let list = [];
      try { list = plain(this.engineTransfers(assetId)) || []; } catch { return true; }
      const mine = list.filter((t) => String(t?.txid || '').toLowerCase() === txid && t?.kind === 'Send');
      return !mine.length || mine.every((t) => ['WaitingConfirmations', 'Settled'].includes(String(t.status)));
    };
    let told = false, refreshedAt = 0, syncedAt = 0;
    // an engine that learns its own broadcasts (learnOwnOutputs) needs no block server at all: the move's
    // transaction is already in its graph
    if (typeof this.wallet?.learnOwnOutputs === 'function') {
      try { await this.wallet.learnOwnOutputs(); } catch { /* a sync below */ }
      if (listed() && ready()) return true;
    }
    while (Date.now() < end) {
      // make sure the server the engine syncs with has it (the broadcast may have gone to another one)
      if (txHex && !(await this.knowsTx(txid))) await this.ensureBroadcast(txHex, txid).catch(() => {});
      // a refresh asks the transfer server about every transfer still waiting (dozens of requests): only an engine
      // that needs this wallet to take the move in first gets one, at most every 15 s. A chaining engine never does.
      if (!chains && Date.now() - refreshedAt > Math.min(15_000, ms / 4)) { refreshedAt = Date.now(); try { await this.wallet.refresh(online, null, [], true); } catch { /* again */ } }
      // a sync asks the block server about every address this wallet used (hundreds of requests): at most every 10 s
      if (Date.now() - syncedAt > Math.min(10_000, ms / 4)) { syncedAt = Date.now(); try { await this.wallet.sync(online); } catch { /* again */ } }
      if (typeof this.wallet?.learnOwnOutputs === 'function') { try { await this.wallet.learnOwnOutputs(); } catch { /* next */ } }
      if (listed() && ready()) return true;
      if (!told) { onStep('Waiting for the move to reach your wallet before the next lot…'); told = true; }
      await new Promise((r) => setTimeout(r, Math.min(2000, Math.max(10, ms / 20))));
    }
    return false;
  }
  async waitKnown(txid, ms = 15_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.knowsTx(txid)) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }
  /**
   * Does a block server know this transaction (in the mempool or in a block)? Asks for the transaction itself:
   * electrs answers /status with {"confirmed":false} even for a transaction it has never seen.
   */
  /** The block server in use answers that it doesn't have this transaction at all (404): not in a block, not in its mempool. */
  async txMissing(txid) {
    try {
      const r = await fetch(`${this.indexer || this.indexers()[0]}/tx/${txid}`);
      if (r.ok) return false;
      return r.status === 404 || (r.status === 400 && /not found/i.test(await r.text().catch(() => '')));
    } catch { return false; }
  }
  async knowsTx(txid) {
    try {
      const r = await fetch(`${this.indexer || this.indexers()[0]}/tx/${txid}/hex`);
      return r.ok && /^[0-9a-f]{20,}$/i.test((await r.text()).trim());
    } catch { return false; }
  }
  /**
   * Broadcast `txHex` until a block server has it: the one in use first, then the others. Already known counts as done.
   * Throws when none accepts it, with the server's reason.
   */
  async ensureBroadcast(txHex, txid) {
    if (txid && await this.knowsTx(txid)) return true;
    const list = [...new Set([this.indexer, ...this.indexers()].filter(Boolean))];
    let why = '';
    for (const base of list) {
      try {
        const r = await fetch(`${base}/tx`, { method: 'POST', body: txHex });
        const text = await r.text().catch(() => '');
        if (r.ok || /already (in|known)|txn-already|in block chain|already have/i.test(text)) return true;
        why = text.slice(0, 200) || String(r.status);
        // the transaction itself is invalid: another server won't change that
        if (r.status === 400 && !/already/i.test(text)) break;
      } catch (e) { why = String(e?.message || e); }
    }
    throw new Error(`The transaction is signed but no block server accepted it: ${why}`);
  }

  /**
   * Broadcast to every block server at once (a purchase must reach the network, not just one server), then check that
   * one of them really has it. Throws "no block server accepted it" with the reason when the network refuses it.
   */
  async broadcastAll(txHex, txid) {
    const list = [...new Set([this.indexer, ...this.indexers()].filter(Boolean))];
    const tries = await Promise.all(list.map(async (base) => {
      try {
        const r = await fetch(`${base}/tx`, { method: 'POST', body: txHex });
        const text = (await r.text().catch(() => '')).trim();
        // Esplora answers a txid when it took the transaction
        if ((r.ok && /^[0-9a-f]{64}$/i.test(text)) || /already (in|known)|txn-already|in block chain|already have/i.test(text)) return { ok: true };
        return { ok: false, why: text.slice(0, 200) || String(r.status), refused: r.status === 400 };
      } catch (e) { return { ok: false, why: String(e?.message || e) }; }
    }));
    if (!tries.some((t) => t.ok)) {
      const refused = tries.find((t) => t.refused) || tries[0] || { why: 'no block server' };
      throw new Error(`The transaction is signed but no block server accepted it: ${refused.why}`);
    }
    // taken: check it is really there (a server can drop it at once, for example when it conflicts with its mempool)
    for (let i = 0; i < 3; i++) {
      for (const base of list) {
        try { const r = await fetch(`${base}/tx/${txid}/hex`); if (r.ok && /^[0-9a-f]{20,}$/i.test((await r.text()).trim())) return true; } catch { /* the next one */ }
      }
      await new Promise((res) => setTimeout(res, this.recheckMs));
    }
    throw new Error('The transaction is signed but no block server accepted it: a server took it, then none kept it (it may conflict with another transaction of this wallet).');
  }

  /**
   * Seller: start an Instant listing. With an output holding exactly the amount, it's signed at once
   * ({ stage: 'ready', psbt, consignment, templateTxid, sellerOutpoint }); otherwise the tokens move first
   * ({ stage: 'moving', txid }) and `instantProgress` signs it once that transaction confirms.
   */
  async instantList({ offerId, assetId, amount, priceSats, feeRate, market = '', token = '', onStep = (_t) => {} }, store) {
    this.requirePresign();
    const o = readOffer({ assetId, amount, priceSats }, offerId);
    let prev = store.get(o.offerId);
    // signed, but its signature was dropped to free browser storage before the market had it: the market still shows it
    // "going live" and asks again (Check now / Finish listing). Its tokens are on their own output, so it's signed again
    // there. (Before: the empty listing went to the market, which answered "psbt is missing", and it never went on sale.)
    if (prev && prev.coin && !prev.psbt && (prev.stage === 'ready' || (prev.stage === 'moving' && prev.resign))) {
      prev = { ...prev, stage: 'moving', resign: undefined, published: undefined };
      store.set(o.offerId, prev);
      onStep('Signing the listing again…');
    }
    if (prev?.stage === 'moving' && (prev.coin || prev.lotOf)) {
      // asked again while the tokens move (the market's "Finish listing"): look now instead of waiting for a refresh
      onStep('Checking whether your tokens arrived on their own output…');
      await this.wallet.sync(this.requireOnline());
      try { await this.wallet.refresh(this.requireOnline(), null, [], false); } catch { /* signed below if it settled anyway */ }
      const v = await this.instantSign(o.offerId, prev, store);
      return v.stage === 'ready' ? v : { ...v, waiting: await this.moveStatus(prev) };
    }
    if (prev?.stage === 'queued' && prev.lotGroup) {
      onStep('Checking your lots…');
      await this.wallet.sync(this.requireOnline());
      try { await this.wallet.refresh(this.requireOnline(), null, [], false); } catch { /* moved below if the tokens are free anyway */ }
      await this.lotsAdvance(store, prev.lotGroup, feeRate || prev.feeRate || 1, onStep).catch(() => []);
      const now = store.get(o.offerId);
      if (now?.stage === 'moving' && now.coin && !now.moveTxid) return this.instantSign(o.offerId, now, store);
      return { ...this.instantView(o.offerId, now), waiting: await this.moveStatus(now) };
    }
    if (prev && !['cancelled'].includes(prev.stage)) return this.instantView(o.offerId, prev);
    onStep(`Checking your tokens on ${hostOf(this.indexer)}…`);
    await this.wallet.sync(this.requireOnline());
    const pendingSpent = await this.requireInSync(o.assetId, onStep, { allowOwn: true, own: storeMoveTxids(store) });
    this.syncOwnUnconfirmed(store);
    const unspents = this.listable(plain(this.wallet.listUnspents(false)) || []);
    // market and token: where this wallet sends the signed listing when it's signed later (after the move)
    const base = { role: 'seller', assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats), market: String(market), token: String(token), at: Date.now() };
    // never an output this wallet's own unconfirmed move already spent
    const avoid = new Set([...this.reserved, ...pendingSpent]);
    const exact = exactCoinFor(unspents, o.assetId, o.amount, avoid);
    if (exact) { onStep('Signing the listing…'); return this.instantSign(o.offerId, { ...base, stage: 'moving' }, store); }
    // one output holding enough, or else several joined in the move
    const from = freeSellerCoinFor(unspents, o.assetId, o.amount, avoid) || sendCoinsFor(unspents, o.assetId, o.amount, avoid).coins;
    if (!from) throw new Error('Not that much of this token is settled and free in this wallet. Wait for incoming transfers to settle, or list less.');
    onStep('Moving the tokens to an output of their own…');
    let moved;
    try { moved = await this.instantMove(o.assetId, o.amount, from, feeRate, onStep); } catch (err) {
      // the rest of the tokens (the change) needs a free RGB output of this wallet, and there is none:
      // make some now (one small transaction) so the listing works once it confirms
      const text = String(err?.message || err);
      if (!/insufficient ?allocation|allocation ?slots/i.test(text)) throw err;
      onStep('Making new RGB outputs for the rest of your tokens…');
      try { await this.createUtxos({ upTo: true, num: 4, size: LiteWallet.UTXO_SATS, feeRate }); } catch (e2) {
        throw new Error(`No free RGB output for the rest of your tokens: ${String(e2?.message || e2).slice(0, 80)}`);
      }
      throw new Error('MASKED made free RGB outputs for the rest of your tokens. List again in about 10 minutes, after one block.');
    }
    const { txid, txHex } = moved;
    // the new output is promised to this listing from now on: no change or receive lands on it before it's signed.
    // The signed move is kept until it confirms, so a refresh can broadcast it again if a server dropped it.
    const e = { ...base, stage: 'moving', moveTxid: txid, moveHex: txHex || undefined, coin: `${txid}:${SEAL_OUTPUT}` };
    store.set(o.offerId, e);
    this.reserve([...this.reserved, e.coin]);
    // an engine that lists outputs of this wallet's own unconfirmed moves: signed now, on sale at once
    if (this.canChainLots) {
      this.syncOwnUnconfirmed(store, [txid]);
      onStep('Signing the listing…');
      for (let pass = 0; pass < 3; pass++) {
        try { await this.wallet.sync(this.requireOnline()); await this.wallet.refresh(this.requireOnline(), null, [], true); await this.wallet.sync(this.requireOnline()); } catch { /* signed below if it can */ }
        try { return await this.presignLot(o.offerId, e, store); } catch { /* the engine hasn't taken the move in yet */ }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return this.instantView(o.offerId, e);
  }
  async instantSign(offerId, e, store) {
    const online = this.requireOnline();
    const unspents = plain(this.wallet.listUnspents(false)) || [];
    const opOf = (u) => `${String(u.utxo?.outpoint?.txid).toLowerCase()}:${u.utxo?.outpoint?.vout}`;
    // a lot: one of the outputs its split made, not one another lot of the split already took
    const mine = e.coin ? unspents.filter((u) => opOf(u) === e.coin)
      : e.lotOf ? unspents.filter((u) => String(u.utxo?.outpoint?.txid).toLowerCase() === e.lotOf) : unspents;
    const coin = exactCoinFor(mine, e.assetId, e.amount, e.coin ? new Set() : this.reserved);
    if (!coin) {
      // this wallet's own move, not confirmed yet: the engine signs its output anyway (when it has taken the move in)
      if (e.coin && e.moveTxid && this.canChainLots) {
        this.syncOwnUnconfirmed(store);
        try { return await this.presignLot(offerId, e, store); } catch { /* after its block, as before */ }
      }
      return this.instantView(offerId, e); // the move hasn't settled yet
    }
    const payout = await this.payoutScript();
    const r = plain(await this.wallet.presignSale(online, e.assetId, BigInt(e.amount), coin.outpoint, payout, BigInt(e.priceSats), 1));
    const next = { ...e, moveHex: undefined, stage: 'ready', payoutPublic: payout === this.payoutHex, coin: String(r.sellerOutpoint), psbt: String(r.psbt), consignment: b64(Uint8Array.from(r.consignment)), templateTxid: String(r.templateTxid), sellerSats: String(r.sellerSats), at: Date.now() };
    store.set(offerId, next);
    this.reserve([...new Set([...this.reserved, next.coin])]);
    await this.save();
    return this.instantView(offerId, next);
  }
  /**
   * Seller: list in lots. One transaction splits the tokens onto one output per lot (each sent to a fresh invoice of
   * this wallet); after it confirms, each lot is signed as its own Instant listing and handed to the market, so buyers
   * take as many lots as they want and the rest stays listed. `lots`: [{ offerId, token, amount, priceSats }].
   */
  async instantListLots({ assetId, lots, feeRate, market = '', onStep = (_t) => {} }, store) {
    this.requirePresign();
    const list = (lots || []).map((l) => ({ ...readOffer({ assetId, amount: l.amount, priceSats: l.priceSats }, l.offerId), token: String(l.token || '') }));
    if (list.length < 2) throw new Error('A listing in lots needs at least 2 lots.');
    // asked again (the market's "Finish listing"): the split already went out
    const prev = list.map((l) => store.get(l.offerId)).filter(Boolean);
    if (prev.length) {
      const split = prev.find((e) => e.lotOf)?.lotOf || '';
      const group = prev.find((e) => e.lotGroup)?.lotGroup || '';
      if (group) {
        onStep('Checking your lots…');
        await this.wallet.sync(this.requireOnline());
        try { await this.wallet.refresh(this.requireOnline(), null, [], false); } catch { /* moved below if the tokens are free anyway */ }
        await this.lotsAdvance(store, group, feeRate || prev[0].feeRate || 1, onStep).catch(() => []);
      }
      if (split) {
        onStep('Checking whether your lots arrived…');
        await this.wallet.sync(this.requireOnline());
        try { await this.wallet.refresh(this.requireOnline(), null, [], false); } catch { /* signed below if they settled anyway */ }
      }
      const views = [];
      for (const l of list) {
        const e = store.get(l.offerId);
        views.push(e?.stage === 'moving' ? await this.instantSign(l.offerId, e, store) : e ? this.instantView(l.offerId, e) : { offerId: l.offerId, stage: 'missing' });
      }
      return { stage: views.every((v) => v.stage === 'ready') ? 'ready' : 'moving', txid: split || null, lots: views };
    }
    const total = list.reduce((t, l) => t + BigInt(l.amount), 0n);
    onStep(`Checking your tokens on ${hostOf(this.indexer)}…`);
    await this.wallet.sync(this.requireOnline());
    const pendingSpent = await this.requireInSync(assetId, onStep, { allowOwn: true, own: storeMoveTxids(store) });
    this.syncOwnUnconfirmed(store);
    const pick = sendCoinsFor(this.listable(plain(this.wallet.listUnspents(false)) || []), assetId, total, new Set([...this.reserved, ...pendingSpent]));
    if (!pick.coins) throw new Error(pick.held > 0n ? 'Not that much of this token is settled and free in this wallet yet. Wait for incoming transfers to settle, or list less.' : 'None of this token is settled and free in this wallet yet.');
    const at = Date.now(), group = `g${at.toString(36)}`;
    if (this.canChainLots) return this.lotsAtOnce({ list, assetId, coins: pick.coins, feeRate, market, at, group, onStep }, store);
    const queue = async () => {
      // the engine's bitcoin side can't spend these outputs (they came from swaps): split step by step instead, the way a
      // single Instant listing moves its tokens; each lot moves to an output of its own as soon as tokens are free
      list.forEach((l, k) => store.set(l.offerId, { role: 'seller', assetId: l.assetId, amount: String(l.amount), priceSats: String(l.priceSats), market: String(market), token: l.token, at, stage: 'queued', lotGroup: group, lotNo: k, lots: list.length, feeRate: Number(feeRate) || 1 }));
      this.lotsFeeRate = Number(feeRate) || this.lotsFeeRate || 1;
      await this.save();
      const moved = await this.lotsAdvance(store, group, feeRate, onStep).catch(() => []);
      return { stage: 'moving', txid: moved[0] || null, stepByStep: true, lots: list.map((l) => ({ offerId: l.offerId, stage: 'moving' })) };
    };
    // One transaction paying several invoices of this same wallet: the RGB engine took in only one of the transfers and
    // kept counting the spent output (seen on Signet, 2.29.24 tests). So lots move step by step, the way a single
    // Instant listing moves its tokens: the first at once, then one per block; a lot already alone on an output (the
    // rest after the last move, often) needs no move. The one-transaction split stays for engines where it works.
    if (this.lotsStepByStep !== false) return queue();
    onStep(`Making ${list.length} invoices of your own for the lots…`);
    // a lot's invoice stays open a week: this wallet takes in its own lots the next time it's open
    const invs = [];
    for (const l of list) invs.push(await this.onchainReceive({ assetId, amount: Number(l.amount), durationSeconds: 7 * 86400, witness: true }));
    onStep(`Splitting your tokens into ${list.length} lots…`);
    let txid;
    try { txid = await this.sendToOwn(assetId, list.map((l, k) => ({ amount: l.amount, invoice: invs[k].invoice })), feeRate); } catch (err) {
      // nothing went out: cancel the invoices made for it, so they don't sit open
      for (const inv of invs) if (inv.batchTransferIdx != null) { try { await this.wallet.failTransfers(this.requireOnline(), inv.batchTransferIdx, false, true); } catch { /* they expire anyway */ } }
      await this.save().catch(() => {});
      const text = String(err?.message || err);
      if (err?.code === 'NOT_SPENDABLE_BY_ENGINE') { this.lotsStepByStep = true; return queue(); }
      if (/insufficient ?allocation|allocation ?slots|NoAvailableUtxos|InsufficientBitcoins/i.test(text)) {
        onStep('Making new RGB outputs for the lots…');
        try { await this.createUtxos({ upTo: true, num: 4, size: LiteWallet.UTXO_SATS, feeRate }); } catch (e2) {
          throw new Error(`Your RGB balance needs bitcoin for the lots' outputs: ${String(e2?.message || e2).slice(0, 80)}. Tap Add from Bitcoin under RGB balance on Home.`);
        }
        throw new Error('MASKED made free RGB outputs for this. List again in about 10 minutes, after one block.');
      }
      throw err;
    }
    for (const l of list) store.set(l.offerId, { role: 'seller', assetId: l.assetId, amount: String(l.amount), priceSats: String(l.priceSats), market: String(market), token: l.token, at, stage: 'moving', moveTxid: txid, lotOf: String(txid).toLowerCase(), lots: list.length });
    await this.save();
    return { stage: 'moving', txid, lots: list.map((l) => ({ offerId: l.offerId, stage: 'moving' })) };
  }
  /**
   * Lots, all at once: each lot moves to an output of its own in a chain of transactions (lot 1 from the chosen outputs,
   * each next one from the previous move's change), then every lot is signed as its own Instant listing, in the same
   * approval. Nothing waits for a block: the engine spends and lists outputs of this wallet's own unconfirmed moves
   * (`syncOwnUnconfirmed`). A buyer who buys before the moves confirm gets the tokens once they do; their wallet waits
   * for that by itself. A lot that can't be signed now (the engine hasn't taken in its move yet) is signed on the next
   * refresh, as before.
   */
  async lotsAtOnce({ list, assetId, coins, feeRate, market, at, group, onStep }, store) {
    const online = this.requireOnline();
    // unused invoices of earlier moves are asked about on every refresh: give the old ones up first
    try { await this.cancelUnpaidReceives(); } catch { /* still works, just slower */ }
    const rate = Math.max(1, Number(feeRate) || 1);
    this.syncOwnUnconfirmed(store);
    /** @type {Map<string, string>} lots not moved (the market takes them off) */
    const failed = new Map();
    let from = coins;
    for (const [k, l] of list.entries()) {
      onStep(`Moving lot ${k + 1} of ${list.length} to an output of its own…`);
      let moved;
      try { moved = await this.instantMove(assetId, l.amount, from, rate, onStep, { feeFromInputs: k > 0 }); } catch (err) {
        if (k === 0) throw err;
        const text = String(err?.message || err);
        // the previous move isn't usable yet (the engine needs its block): the rest wait their turn and move one per
        // block, signed as they go, instead of being taken off the market
        if (/none of its inputs is an RGB output|isn't a settled RGB output|insufficient ?allocation/i.test(text)) {
          for (const [j, r] of list.slice(k).entries()) store.set(r.offerId, { role: 'seller', assetId, amount: String(r.amount), priceSats: String(r.priceSats), market: String(market), token: r.token, at: Date.now(), stage: 'queued', lotGroup: group, lotNo: k + j, lots: list.length, feeRate: rate, waiting: 'Next in line: it moves after the block of the lot before it (about 10 minutes), then goes on sale.' });
          await this.save();
          break;
        }
        // what moved stays listed (signed below); the lots not moved yet are taken off by the market with the error
        for (const r of list.slice(k)) failed.set(r.offerId, `Not listed: ${text.slice(0, 160)}`);
        break;
      }
      this.syncOwnUnconfirmed(store, [moved.txid]);
      store.set(l.offerId, { role: 'seller', assetId, amount: String(l.amount), priceSats: String(l.priceSats), market: String(market), token: l.token, at, stage: 'moving', lotGroup: group, lotNo: k, lots: list.length, feeRate: rate, moveTxid: moved.txid, moveHex: moved.txHex || undefined, coin: `${moved.txid}:${SEAL_OUTPUT}` });
      this.reserve([...this.reserved, `${moved.txid}:${SEAL_OUTPUT}`]);
      await this.save();
      // the rest of the tokens: on this move's change, for the next lot
      from = [{ outpoint: `${moved.txid}:${SEAL_OUTPUT + 1}` }];
      // the engine learns its new outputs from the block server it syncs with: wait until that server has the move,
      // then until the engine lists the change. Moving the next lot before that fails with "none of its inputs is an
      // RGB output of this wallet" (seen on Signet: 1 of 10 lots listed when the server was slow)
      if (k < list.length - 1) await this.waitOwnOutput(online, `${moved.txid}:${SEAL_OUTPUT + 1}`, onStep, moved.txHex || '', assetId);
      else { try { await this.wallet.sync(online); } catch { /* the next move syncs again */ } }
    }
    // the engine takes in its own moves (from the transfer server), then signs every lot
    onStep('Signing every lot…');
    const views = [];
    for (let pass = 0; pass < 3; pass++) {
      try { await this.wallet.refresh(online, null, [], true); } catch { /* signed below if it can */ }
      // the outputs the moves made (the lots' own): learned from the engine's own graph if it can, else on a scan
      if (typeof this.wallet?.learnOwnOutputs === 'function') { try { await this.wallet.learnOwnOutputs(); } catch { /* signed below if it can */ } }
      else { try { await this.wallet.sync(online); } catch { /* signed below if it can */ } }
      for (const l of list) {
        const e = store.get(l.offerId);
        if (e?.stage !== 'moving') continue;
        try { await this.presignLot(l.offerId, e, store); } catch (err) {
          // not yet: next pass, or the next refresh; what the engine said is kept (shown in Settings and on the market)
          store.set(l.offerId, { ...e, waiting: `Not signed yet: ${String(err?.message || err).slice(0, 220)}`, waitingAt: Date.now() });
        }
      }
      if (list.every((l) => store.get(l.offerId)?.stage !== 'moving')) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (const l of list) {
      const e = store.get(l.offerId);
      views.push(failed.has(l.offerId) ? { offerId: l.offerId, stage: 'failed', waiting: failed.get(l.offerId) } : e ? this.instantView(l.offerId, e) : { offerId: l.offerId, stage: 'missing' });
    }
    await this.save();
    return { stage: views.every((v) => v.stage === 'ready') ? 'ready' : 'moving', txid: store.get(list[0].offerId)?.moveTxid || null, lots: views };
  }
  /** Sign a moved listing on its own output (`e.coin`), confirmed or not: the engine checks it holds exactly the lot. */
  async presignLot(offerId, e, store) {
    const online = this.requireOnline();
    const payout = await this.payoutScript();
    const r = plain(await this.wallet.presignSale(online, e.assetId, BigInt(e.amount), String(e.coin), payout, BigInt(e.priceSats), 1));
    const next = { ...e, moveHex: e.moveHex, stage: 'ready', waiting: '', payoutPublic: payout === this.payoutHex, coin: String(r.sellerOutpoint), psbt: String(r.psbt), consignment: b64(Uint8Array.from(r.consignment)), templateTxid: String(r.templateTxid), sellerSats: String(r.sellerSats), at: Date.now() };
    store.set(offerId, next);
    this.reserve([...new Set([...this.reserved, next.coin])]);
    await this.save();
    return this.instantView(offerId, next);
  }
  /**
   * Lots split step by step: move the next queued lot of `group` to an output of its own (one transaction, the same
   * as a single Instant listing's move), from a free settled output that holds enough. One move per call: the tokens'
   * change needs its block before the next move can use it. Returns the txids moved now.
   */
  async lotsAdvance(store, group, feeRate, onStep = (_t) => {}) {
    const queued = Object.entries(store.all()).filter(([, e]) => e?.role === 'seller' && e.lotGroup === group && e.stage === 'queued' && !(Date.now() - Number(e.at) > LOT_QUEUE_MAX_MS)).sort((a, b) => a[1].lotNo - b[1].lotNo);
    if (!queued.length) return [];
    const [id, e] = queued[0];
    // never move a lot while this wallet is behind the chain (another copy spent outputs it still counts)
    // (the previous lot's move, still waiting for its block, is this wallet's own: its spent output is just left out)
    let pendingSpent;
    try { pendingSpent = await this.requireInSync(e.assetId, undefined, { allowOwn: true, own: storeMoveTxids(store) }); } catch (err) {
      store.set(id, { ...e, waiting: String(err?.message || err).slice(0, 300), waitingAt: Date.now() });
      return [];
    }
    // promised outputs (signed or moving listings) are never taken, nor outputs this wallet's unconfirmed moves spent
    const busy = new Set([...this.reserved, ...pendingSpent, ...Object.values(store.all()).filter((x) => x?.role === 'seller' && ['moving', 'ready'].includes(x.stage) && x.coin).map((x) => String(x.coin))]);
    const unspents = plain(this.wallet.listUnspents(false)) || [];
    const exact = exactCoinFor(unspents, e.assetId, e.amount, busy);
    if (exact) {
      // already alone on an output: no move, it's signed on the next pass
      store.set(id, { ...e, stage: 'moving', coin: exact.outpoint, waiting: '' });
      this.reserve([...this.reserved, exact.outpoint]);
      await this.save();
      return [];
    }
    const from = freeSellerCoinFor(unspents, e.assetId, e.amount, busy) || sendCoinsFor(unspents, e.assetId, e.amount, busy).coins;
    if (!from) {
      const why = 'Waiting for the previous lot\'s move to confirm: the rest of the tokens are free again after one block.';
      if (e.waiting !== why) store.set(id, { ...e, waiting: why, waitingAt: Date.now() });
      return [];
    }
    onStep(`Moving lot ${e.lotNo + 1} of ${e.lots} to an output of its own…`);
    let moved;
    try { moved = await this.instantMove(e.assetId, e.amount, from, feeRate, onStep); } catch (err) {
      const text = String(err?.message || err);
      if (/insufficient ?allocation|allocation ?slots/i.test(text) && Date.now() - (this.lotsUtxosAt || 0) > 20 * 60_000) {
        this.lotsUtxosAt = Date.now();
        try { await this.createUtxos({ upTo: true, num: 4, size: LiteWallet.UTXO_SATS, feeRate }); } catch { /* said below */ }
        store.set(id, { ...e, waiting: 'MASKED made free RGB outputs for the rest of your tokens; this lot moves after their block.', waitingAt: Date.now() });
        return [];
      }
      store.set(id, { ...e, waiting: `MASKED couldn't move this lot yet: ${text.slice(0, 160)}`, waitingAt: Date.now() });
      return [];
    }
    const next = { ...e, stage: 'moving', moveTxid: moved.txid, moveHex: moved.txHex || undefined, coin: `${moved.txid}:${SEAL_OUTPUT}`, waiting: '' };
    store.set(id, next);
    this.reserve([...this.reserved, next.coin]);
    await this.save();
    return [moved.txid];
  }
  /**
   * Send tokens to invoices of this wallet in one transaction (the split into lots): its txid. The engine builds it
   * with its bitcoin wallet, which must know the token output; one made by a swap or an Instant listing can be
   * missing there until a full scan finds it ("UTXO not found in the internal database"): scan once and try again.
   */
  async sendToOwn(assetId, parts, feeRate) {
    try { return await this.sendToOwnOnce(assetId, parts, feeRate); } catch (e) {
      if (!/UTXO not found|adding UTXOs|UnknownUtxo/i.test(String(e?.message || e))) throw e;
      await this.syncWallet({ full: true });
      try { return await this.sendToOwnOnce(assetId, parts, feeRate); } catch (e2) {
        if (!/UTXO not found|adding UTXOs|UnknownUtxo/i.test(String(e2?.message || e2))) throw e2;
        throw Object.assign(new Error('The engine\'s bitcoin side can\'t spend the outputs holding these tokens.'), { code: 'NOT_SPENDABLE_BY_ENGINE' });
      }
    }
  }
  async sendToOwnOnce(assetId, parts, feeRate) {
    const online = this.requireOnline();
    const fee = BigInt(Math.max(1, Math.round(Number(feeRate) || 1)));
    const ds = await Promise.all(parts.map((p) => this.decodeRGBInvoice({ invoice: p.invoice })));
    let psbt;
    if (this.engineV1) {
      const now = Math.floor(Date.now() / 1000);
      const soonest = Math.min(...ds.map((d) => Number(d.expirationTimestamp) || now + 86400));
      const recips = ds.map((d, k) => ({ recipientId: d.recipientId, witnessData: { amountSat: String(LiteWallet.WITNESS_SATS), blinding: null }, assignment: { Fungible: Number(parts[k].amount) }, transportEndpoints: d.transportEndpoints, publicKey: d.publicKey, encryption: d.encryption, expirationTimestamp: Number(d.expirationTimestamp) || null }));
      const begin = await this.wallet.sendBegin(online, { [assetId]: recips }, true, fee, 1, soonest - LiteWallet.INVOICE_MARGIN_SECS - 120, this.transport, null, false);
      psbt = typeof begin === 'string' ? begin : begin?.psbt;
    } else {
      const recips = ds.map((d, k) => ({ recipientId: d.recipientId, witnessData: { amountSat: String(LiteWallet.WITNESS_SATS), blinding: null }, assignment: { Fungible: Number(parts[k].amount) }, transportEndpoints: d.transportEndpoints.length ? d.transportEndpoints : [this.transport] }));
      psbt = await this.wallet.sendBegin(online, { [assetId]: recips }, true, fee, 1);
    }
    const r = plain(await this.wallet.sendEnd(online, this.sign(psbt), false));
    await this.save();
    const txid = String(r?.txid || this.lib.WasmWallet.psbtTxid(psbt));
    return txid;
  }
  /**
   * Why a listing's tokens aren't on their own output yet, in words: the move not in a block yet, the token proof not
   * taken in yet, or the output holding something else than the listing.
   */
  async moveStatus(e) {
    try {
      if (e.stage === 'queued') return e.waiting || 'This lot moves to an output of its own once the tokens before it are free (one block per step).';
      if (e.lotOf && !e.coin) {
        let confirmed = null;
        try { confirmed = !!(await (await this.esplora(`/tx/${e.lotOf}`)).json())?.status?.confirmed; } catch { confirmed = null; }
        if (confirmed === null) return 'The split transaction isn\'t on the block server yet.';
        if (!confirmed) return 'The split into lots is waiting for its first block (about 10 minutes on Signet).';
        // what this wallet sees on the split's outputs, so a lot that doesn't sign says why
        const outs = (plain(this.wallet.listUnspents(false)) || []).filter((u) => String(u.utxo?.outpoint?.txid).toLowerCase() === e.lotOf);
        const mine = outs.map((u) => {
          const al = (u.rgbAllocations || []).filter((a) => a.assetId === e.assetId);
          const amt = al.map((a) => String(a.assignment?.Fungible ?? a.amount ?? '?')).join('+') || 'nothing';
          const taken = this.reserved.has(`${String(u.utxo.outpoint.txid).toLowerCase()}:${u.utxo.outpoint.vout}`);
          return `output ${u.utxo.outpoint.vout}: ${amt}${al.some((a) => !a.settled) ? ' (not settled yet)' : ''}${taken ? ' (another lot)' : ''}`;
        });
        if (!outs.length) return 'The split is in a block, but this wallet doesn\'t see its outputs yet. Tap Refresh in MASKED → RGB, then Finish listing.';
        return `The split is in a block. This wallet sees ${mine.join('; ')}. A lot is signed once an output holds exactly ${e.amount}, settled: keep MASKED open a minute, or tap Refresh in MASKED → RGB.`;
      }
      const [txid, vout] = String(e.coin).split(':');
      let confirmed = null;
      try { confirmed = !!(await (await this.esplora(`/tx/${txid}`)).json())?.status?.confirmed; } catch { confirmed = null; }
      if (confirmed === null) return 'The move transaction isn\'t on the block server yet. MASKED sends it again on its next refresh.';
      if (!confirmed) return 'The move transaction is waiting for its first block (about 10 minutes on Signet).';
      const u = (plain(this.wallet.listUnspents(false)) || []).find((x) => `${String(x.utxo?.outpoint?.txid).toLowerCase()}:${x.utxo?.outpoint?.vout}` === `${txid}:${vout}`);
      if (!u) return 'The move is in a block, but this wallet doesn\'t see the new output yet. Tap Refresh in MASKED → RGB, then Finish listing.';
      const all = u.rgbAllocations || [];
      if (!all.length) return 'The move is in a block, but the token proof for it hasn\'t been taken in yet. Keep MASKED open a minute, then Finish listing.';
      if (all.some((a) => !a.settled)) return 'The tokens are on their new output and settle on the next refresh. Try Finish listing again in a minute.';
      return `The new output holds ${all.map((a) => a.assignment?.Fungible ?? '?').join(' + ')} instead of exactly ${e.amount}: cancel this listing and list again.`;
    } catch (err) { return `MASKED couldn't check the move: ${String(err?.message || err).slice(0, 120)}`; }
  }
  /** A listing this engine would accept as a buyer (the current layout). */
  validListing(psbt, consignment = null, templateTxid = '') {
    try { this.lib.WasmWallet.presignedListingInfo(String(psbt)); } catch { return false; }
    return !(consignment && this.oldConsignment(unb64(String(consignment)), templateTxid));
  }
  /** A transfer in the RGB 0.11.1 format (signed by MASKED before 2.29): the 0.11.2 engine can't check it before it's on chain. */
  oldConsignment(bytes, txid) {
    try { this.lib.inspectSwapConsignment(bytes, String(txid), this.net, INSTANT_SEAL_OUTPUT); return false; } catch (e) { return OLD_CONSIGNMENT.test(String(e?.message || e)); }
  }
  instantView(offerId, e) {
    return { offerId: String(offerId), stage: e.stage === 'queued' ? 'moving' : e.stage, txid: e.soldTxid || e.cancelTxid || e.moveTxid || null, ...(e.stage === 'ready' ? { psbt: e.psbt, consignment: e.consignment, templateTxid: e.templateTxid, sellerOutpoint: e.coin } : e.waiting ? { waiting: String(e.waiting) } : {}) };
  }
  /**
   * Seller, after a refresh: sign listings whose tokens have settled on their own output, and notice listings that
   * sold (their output spent by someone else's transaction) or whose cancel went through. Returns the changes.
   */
  async instantProgress(store, all) {
    const changes = [];
    this.syncOwnUnconfirmed(store);
    // lots split step by step: move the next lot of each group whose tokens are free
    // A lot still queued hours after it was made is given up, never moved later: it would take whatever tokens arrive
    // next (a claim, a purchase) and put them on sale without asking. Seen on Signet: a 250 MASKED lot queued two days
    // went on sale from a claim that had just arrived.
    for (const [id, e] of Object.entries(all)) {
      if (e?.role === 'seller' && e.stage === 'queued' && Number(e.at) > 0 && Date.now() - Number(e.at) > LOT_QUEUE_MAX_MS) {
        store.set(id, { ...e, stage: 'cancelled', expired: true, waiting: 'Not listed: it waited too long for its tokens. List again if you still want to sell.', at: Date.now() });
        changes.push({ offerId: id, stage: 'cancelled', expired: true });
      }
    }
    all = store.all();
    const groups = new Set(Object.values(all).filter((e) => e?.role === 'seller' && e.stage === 'queued' && e.lotGroup).map((e) => e.lotGroup));
    for (const g of groups) {
      const rate = Object.values(all).find((e) => e?.lotGroup === g)?.feeRate || this.lotsFeeRate || 1;
      try { await this.lotsAdvance(store, g, rate); } catch { /* next refresh */ }
    }
    if (groups.size) all = store.all();
    for (let [id, e] of Object.entries(all)) {
      // a signed listing whose data was dropped to free storage was marked "moving" by 2.29.25 builds before v13: it
      // is still on sale (the market keeps it), so it's watched for its sale again
      if (e?.role === 'seller' && e.stage === 'moving' && e.resign && e.templateTxid && e.coin) { e = { ...e, stage: 'ready', waiting: '' }; store.set(id, e); }
      if (e?.role === 'buyer') {
        try { const c = await this.purchaseProgress(id, e, store); if (c) changes.push(c); } catch { /* next refresh */ }
        continue;
      }
      if (e?.role !== 'seller') continue;
      try {
        // signed data dropped to free browser storage: the market keeps the listing; signed again only when asked
        if (e.stage === 'moving' && e.resign) continue;
        if (e.stage === 'moving') {
          let v;
          try { v = await this.instantSign(id, e, store); } catch (err) {
            // the engine refused to sign: say why where the listing is shown, instead of waiting in silence
            const why = `MASKED couldn't sign this listing: ${String(err?.message || err).slice(0, 200)}`;
            if (why !== e.waiting) store.set(id, { ...e, waiting: why, waitingAt: Date.now() });
            continue;
          }
          if (v.stage === 'ready') { changes.push(v); continue; }
          // still waiting: say on what (every 2 min), and if no block server has the move (dropped, or never sent), send it again
          if (Date.now() - (e.waitingAt || 0) > 120000) {
            const why = await this.moveStatus(e);
            store.set(id, { ...e, waiting: why, waitingAt: Date.now() });
          }
          if (e.moveHex && e.moveTxid && Date.now() - (e.rebroadcastAt || 0) > 120000) {
            store.set(id, { ...store.get(id), rebroadcastAt: Date.now() });
            await this.ensureBroadcast(e.moveHex, e.moveTxid).catch(() => {});
          }
        } else if (e.stage === 'ready' && e.psbt && !e.outdated && !this.validListing(e.psbt, e.consignment, e.templateTxid)) {
          // signed by an earlier MASKED in a layout buyers refuse: it can't sell; cancelling moves the tokens back
          store.set(id, { ...e, outdated: true });
          changes.push({ offerId: id, stage: 'outdated' });
        } else if ((e.stage === 'ready' || e.stage === 'cancelling') && e.coin) {
          const [txid, vout] = e.coin.split(':');
          // a sale is noticed within 2 minutes; every refresh and every approval window asking again flooded the server
          const sp = await this.outspend(txid, vout, /** @type {any} */ (this).spendCheckMs ?? LISTING_SPEND_CHECK_MS);
          if (!sp?.spent) continue;
          const by = String(sp.txid || '');
          if (by && by === e.cancelTxid) { store.set(id, { ...e, stage: 'cancelled', at: Date.now() }); changes.push({ offerId: id, stage: 'cancelled', txid: by }); continue; }
          // someone completed the pre-signed transaction: the seller's payout is in it (the signature covers it)
          this.wallet.markOutpointSpent(e.coin);
          const left = [...this.reserved].filter((x) => x !== e.coin);
          this.reserve(left);
          store.set(id, { ...e, stage: 'sold', soldTxid: by, psbt: undefined, consignment: undefined, at: Date.now() });
          await this.save();
          changes.push({ offerId: id, stage: 'sold', txid: by });
        }
      } catch { /* next refresh */ }
    }
    return changes;
  }
  /**
   * Buyer, after a refresh: a purchase sent but not in a block yet. Confirmed: done. Gone from the block servers: sent
   * again (every 2 minutes). Refused (its coins were spent by another transaction): failed, nothing paid.
   */
  async purchaseProgress(id, e, store) {
    if (!e.posted || !e.txHex || e.failed || e.confirmed || Date.now() - (e.checkedAt || 0) < 120000) return null;
    store.set(id, { ...e, checkedAt: Date.now() });
    let st = null;
    try { st = await (await this.esplora(`/tx/${e.txid}/status`)).json(); } catch { st = null; }
    if (st?.confirmed) { store.set(id, { ...store.get(id), confirmed: true, txHex: undefined }); return null; }
    if (await this.knowsTx(e.txid)) return null;
    try { await this.broadcastAll(e.txHex, e.txid); return null; } catch (err) {
      const why = String(err?.message || err);
      if (!/no block server accepted it/.test(why)) return null;
      store.set(id, { ...store.get(id), failed: why, txHex: undefined, at: Date.now() });
      return { offerId: id, stage: 'purchase-failed', why: why.split(': ').slice(1).join(': ').slice(0, 160) };
    }
  }
  /** Seller: cancel an Instant listing. A signed one is moved to a new output (an on-chain transaction). */
  async instantCancel({ offerId, feeRate, sellerOutpoint = '', offer = null }, store) {
    this.syncOwnUnconfirmed(store);
    let e = store.get(String(offerId));
    if ((!e || e.role !== 'seller') && sellerOutpoint) {
      // a listing made in another copy of this wallet: this one has no record of it, only the market's word for its
      // output. Cancel it only if this wallet holds exactly that output, with the listed amount of the token.
      const o = readOffer({ assetId: offer?.assetId, amount: offer?.amount, priceSats: offer?.priceSats }, offerId);
      await this.wallet.sync(this.requireOnline());
      const op = String(sellerOutpoint).toLowerCase();
      const mine = (plain(this.wallet.listUnspents(false)) || []).filter((u) => `${String(u.utxo?.outpoint?.txid).toLowerCase()}:${u.utxo?.outpoint?.vout}` === op);
      if (!exactCoinFor(mine, o.assetId, o.amount)) throw new Error('This wallet doesn\'t hold that listing\'s tokens: cancel it in the copy of MASKED that made it, or load the newer RGB backup first.');
      e = { role: 'seller', assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats), stage: 'ready', coin: op, at: Date.now() };
      store.set(String(offerId), e);
    }
    if (!e || e.role !== 'seller') throw new Error('This wallet has no Instant listing with that id.');
    if (['sold', 'cancelled', 'cancelling'].includes(e.stage)) return this.instantView(offerId, e);
    if (e.stage === 'queued' || e.stage === 'moving' || !e.coin) {
      if (e.coin) this.reserve([...this.reserved].filter((x) => x !== e.coin));
      const n = { ...e, stage: 'cancelled', at: Date.now() }; store.set(String(offerId), n); return this.instantView(offerId, n);
    }
    const [txid, vout] = e.coin.split(':');
    const sp = await (await this.esplora(`/tx/${txid}/outspend/${vout}`)).json();
    if (sp?.spent) throw new Error('This listing was just bought. Refresh to see the sale.');
    const { txid: cancelTxid } = await this.instantMove(e.assetId, e.amount, { outpoint: e.coin }, feeRate);
    this.reserve([...this.reserved].filter((x) => x !== e.coin));
    const n = { ...e, stage: 'cancelling', cancelTxid, psbt: undefined, consignment: undefined, at: Date.now() };
    store.set(String(offerId), n);
    await this.save();
    return this.instantView(offerId, n);
  }

  /** The signed transaction of a finalized PSBT, hex. */
  extractHex(psbt) {
    if (typeof this.lib.WasmWallet?.psbtExtractHex === 'function') return this.lib.WasmWallet.psbtExtractHex(String(psbt));
    const tx = btc.Transaction.fromPSBT(base64.decode(String(psbt)), { allowUnknownInputs: true, allowUnknownOutputs: true });
    return hex.encode(tx.extract());
  }
  /** Buyer: check an Instant listing and buy it in one go: sign, broadcast, and hand the transfer to this wallet. */
  async instantBuy({ offerId, network, offer, listing, feeRate, onStep = (_t) => {} }, store) {
    this.requirePresign(); this.checkNet(network);
    const o = readOffer(offer, offerId);
    if (o.state && o.state !== 'OPEN') throw new Error(`The offer is ${o.state.toLowerCase()}.`);
    // bought before from this wallet: the same purchase, if the network has it (or takes it again); otherwise it never
    // went through, and this is a new purchase
    const done = store.get(o.offerId);
    if (done?.txid && !done.failed) {
      if (await this.knowsTx(done.txid)) return { txid: done.txid };
      if (done.txHex) {
        try { await this.broadcastAll(done.txHex, done.txid); return { txid: done.txid }; } catch { /* refused now: buy anew */ }
      }
      store.del?.(o.offerId);
    }
    const l = listing || {};
    let info;
    try { info = plain(this.lib.WasmWallet.presignedListingInfo(String(l.psbt || ''))); } catch (e) { throw new Error(`The listing does not check out: ${e?.message || e}`); }
    if (String(info.templateTxid) !== String(l.templateTxid)) throw new Error('The listing does not match its transfer.');
    if (BigInt(String(info.payoutSats)) - BigInt(String(info.sellerSats)) !== o.priceSats) throw new Error('The signed price is not the offer\'s price.');
    if (this.oldConsignment(unb64(String(l.consignment || '')), info.templateTxid)) throw new Error('This listing was signed by a MASKED older than 2.29, in the old RGB format, and can\'t be bought any more. Nothing was paid. The seller cancels it on the market and lists it again.');
    const online = this.requireOnline();
    onStep(`Checking your bitcoin on ${hostOf(this.indexer)}…`);
    await this.wallet.sync(online);
    if ((await this.ownOutpoints()).has(String(info.sellerOutpoint))) throw new Error('This is your own listing.');
    // the seller's output is still there, and is what the signature says
    const si = await this.outpointInfo(info.sellerOutpoint);
    if (String(si.sats) !== String(info.sellerSats) || si.script !== info.sellerScript) throw new Error('The seller\'s output is not what the listing says.');
    const [st, sv] = String(info.sellerOutpoint).split(':');
    if ((await (await this.esplora(`/tx/${st}/outspend/${sv}`)).json())?.spent) throw new Error('Someone just bought this, or the seller cancelled it.');
    // the tokens: valid history, this token, this amount on the buyer's seal
    const check = (bytes, txid) => {
      let v;
      try { v = plain(this.lib.inspectSwapConsignment(bytes, txid, this.net, INSTANT_SEAL_OUTPUT)); } catch (e) { throw new Error(`The seller's token transfer does not check out: ${e?.message || e}`); }
      if (!v?.valid) throw new Error(`The seller's token transfer does not check out: ${v?.details || v?.error || 'invalid'}`);
      const { contractId, sealAmount } = inspected(v);
      if (contractId !== o.assetId) throw new Error('The transfer is for another token than the offer.');
      if (sealAmount == null || BigInt(String(sealAmount)) !== o.amount) throw new Error(`The transfer gives you ${sealAmount ?? 'nothing'}, the offer says ${o.amount}.`);
    };
    const consignment = unb64(String(l.consignment || ''));
    check(consignment, info.templateTxid);
    // pay: one confirmed coin covering the price, the seal and the fee
    const rate = Math.max(1, Number(feeRate) || 1);
    // the size from the real scripts: the seller's coin, the buyer's coins; commitment, payout, seal, change
    const feeFor = (ins, change = true) => BigInt(Math.ceil(rate * txVbytes([info.sellerScript || P2TR_SCRIPT, ...ins], [OPRET_SCRIPT, info.payoutScript || P2TR_SCRIPT, P2TR_SCRIPT, ...(change ? [P2TR_SCRIPT] : [])])));
    const perInput = feeFor([P2TR_SCRIPT, P2TR_SCRIPT]) - feeFor([P2TR_SCRIPT]);
    const base = o.priceSats + BigInt(INSTANT_SEAL_SATS);
    // confirmed coins first; change from this wallet's last trade too, and several coins if one isn't enough
    const { all, confirmed } = await this.btcCoins();
    const pay = payCoinsFor(confirmed, all, base + feeFor([P2TR_SCRIPT]), perInput);
    if (!pay) {
      // what the wallet saw, so a shortfall can be told from a coin it can't see yet
      const seen = all.filter((c) => !c.is_spent).map((c) => Number(c.txout?.value ?? 0)).sort((a, b) => b - a);
      const held = this.justSpent().size;
      throw new Error(`Your RGB wallet needs ${(base + feeFor([P2TR_SCRIPT])).toLocaleString('en-US')} sats in bitcoin for this. Tap Add from Bitcoin under RGB balance on Home. (It sees ${seen.length ? `${seen.length} coin${seen.length === 1 ? '' : 's'}: ${seen.slice(0, 5).map((v) => v.toLocaleString('en-US')).join(', ')} sats` : 'no coin'}, ${confirmed.length} confirmed${held ? `; ${held} just spent by this wallet` : ''}.)`);
    }
    const bis = await Promise.all(pay.coins.map((c) => this.outpointInfo(c.outpoint)));
    const r = await this.onchainReceive({ assetId: null, amount: Number(o.amount), durationSeconds: 86400, witness: true });
    const seal = this.lib.WasmWallet.witnessSealScript(r.invoice);
    const paid = bis.reduce((t, b) => t + BigInt(b.sats), 0n);
    let change = paid - base - feeFor(bis.map((b) => b.script));
    // change too small to keep: no change output (a smaller transaction); what's left goes to the fee
    if (change < 546n) change = 0n;
    if (paid - base - feeFor(bis.map((b) => b.script), change > 0n) < 0n) throw new Error('Not enough bitcoin for the price and the network fee.');
    const inputs = pay.coins.map((c, k) => ({ outpoint: c.outpoint, sats: bis[k].sats, script: bis[k].script, tx: bis[k].tx }));
    // the seller's transaction too: the engine signs only with the previous transaction of every input in hand
    const unsigned = this.lib.WasmWallet.presignedBuyPsbt(String(l.psbt), inputs, seal, change > 0n ? { script: await this.ownScript(), sats: Number(change) } : null, si.tx || null);
    const txHex = this.extractHex(this.sign(unsigned));
    const txid = this.lib.WasmWallet.checkPresignedFinal(String(l.psbt), txHex, seal);
    const completed = this.lib.WasmWallet.completePresignedConsignment(consignment, info.templateTxid, txHex);
    check(completed, txid);
    // kept with the purchase: if a server drops it, a refresh sends it again; the wallet only expects the tokens
    // once a block server has the transaction
    store.set(o.offerId, { role: 'buyer', assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats), recipientId: r.recipientId, invoice: r.invoice, txid, txHex, completed: b64(completed), posted: false, at: Date.now() });
    this.expectPurchases([...this.purchases, r.recipientId]);
    onStep('Sending the purchase to the Bitcoin network…');
    try { await this.broadcastAll(txHex, txid); this.spentNow(pay.coins.map((c) => c.outpoint)); } catch (err) {
      const why = String(err?.message || err);
      if (/no block server accepted it/.test(why)) {
        store.set(o.offerId, { ...store.get(o.offerId), failed: why, completed: undefined, txHex: undefined, at: Date.now() });
        throw new Error(`This listing can't be bought any more: the network refused the purchase (${why.split(': ').slice(1).join(': ').slice(0, 90)}). Nothing was paid.`);
      }
      throw err; // a network problem: kept, and sent again on the next refresh
    }
    // the wallet learns at once that its coins are spent, and the purchase's change: the next buy of a sweep can
    // spend that change (it waits for the block server to have this purchase first, a few seconds; before, the next
    // buy found no coin at all when the RGB balance had only one: "Bought 1 of 3")
    await this.waitKnown(txid, 15_000);
    try { await this.wallet.sync(online); } catch { /* the next refresh */ }
    await this.instantPost(o.offerId, store);
    await this.save();
    return { txid };
  }
  /** Buyer: give this wallet the transfer (through the transfer server, like any incoming one). Retried on refresh. */
  async instantPost(offerId, store) {
    const e = store.get(String(offerId));
    if (!e || e.role !== 'buyer' || e.posted || e.failed) return false;
    // the tokens are only expected once a block server has the purchase: send it (again) first
    if (e.txHex && !(await this.knowsTx(e.txid))) {
      try { await this.ensureBroadcast(e.txHex, e.txid); } catch (err) {
        const why = String(err?.message || err);
        if (/no block server accepted it/.test(why)) store.set(String(offerId), { ...e, failed: why, completed: undefined, txHex: undefined, at: Date.now() });
        return false;
      }
    }
    try {
      if (this.engineV1) await this.postOwnV1(e);
      else await this.wallet.postOwnConsignment(this.transport, e.recipientId, unb64(e.completed), e.txid, INSTANT_SEAL_OUTPUT);
    } catch (err) { if (!/already used|already paid|quota/i.test(String(err?.message || err))) return false; }
    // the signed purchase is kept until it confirms: a refresh sends it again if the network dropped it
    store.set(String(offerId), { ...e, posted: true, completed: undefined, at: Date.now() });
    return true;
  }

  /**
   * Protocol 1.0: post a bought listing's transfer to this wallet's own invoice, as its sender would (encrypted for
   * the invoice key, signed with a one-off key). The engine then takes it like any incoming transfer; the seal was
   * made by the seller before the buyer was known, so the wallet matches it without the derived blinding
   * (expectPurchases).
   */
  async postOwnV1(e) {
    if (!e.invoice) throw new Error('This purchase has no invoice to post to.');
    this.expectPurchases([...this.purchases, e.recipientId]);
    const q = readInvoiceV1(e.invoice);
    const d = await this.decodeRGBInvoice({ invoice: e.invoice });
    const invoiceId = invoiceIdOf(q.beneficiary, q.pk);
    const picked = await pickEndpoint(q.endpoints.length ? q.endpoints : d.transportEndpoints, invoiceId);
    const sender = newSenderKey();
    const { key } = sharedKeys(sender.seed, q.pk);
    await deliverConsignment({ invoice: q, picked, sender, key, consignment: unb64(e.completed) });
  }
  /** @type {Set<string>} */
  get purchases() { return this._purchases || new Set(); }
  /** The invoices of this wallet's Instant purchases (see postOwnV1). */
  expectPurchases(list) {
    this._purchases = new Set((list || []).map(String));
    if (typeof this.wallet?.setPresignedReceives === 'function') this.wallet.setPresignedReceives([...this._purchases]);
  }

  /** Check that an RGB transfer server answers and speaks a protocol this engine supports. Throws the reason. */
  async checkProxy(url) {
    try { await this.lib.checkProxyUrl(url); } catch (e) {
      // a protocol 1.0 server: fine when this engine can pay its invoices (onchainSendV1)
      if (!/protocol version: 1\.0/i.test(String(e?.message || e)) || !this.canProxyV1) throw e;
      const info = await rpc(endpointUrl(url), 'server.info');
      if (info.result?.protocol_version !== PROXY_V1) throw e;
    }
  }

  async createBackup({ password }) { this.lastBackupBytes = this.wallet.backup(password); }
  getLastBackupBytes() { return this.lastBackupBytes; }
  /**
   * Restore an RGB backup. The 0.11.2 engine also reads backups made before the upgrade (MASKED 2.28 and older); one
   * naming an old transaction only by its id is restored with a block server, trying each in turn.
   */
  async restoreFromBackupBytes(bytes, password) {
    if (typeof this.wallet.restoreBackupOnline !== 'function') { this.wallet.restoreBackup(bytes, password); await this.save(); return; }
    try { this.wallet.restoreBackup(bytes, password); } catch (e) {
      if (!/needs the block server/i.test(String(e?.message || e))) throw e;
      const servers = [...new Set([this.indexer, ...this.indexers()].filter(Boolean))];
      let last = e;
      for (const url of servers) {
        try { await this.wallet.restoreBackupOnline(bytes, password, url); last = null; break; } catch (err) { last = err; }
      }
      if (last) throw last;
    }
    await this.save();
  }
}
