// On-chain RGB wallet over @utexo/rgb-lib-wasm: issue, receive, send and back up RGB assets.
// It replaces Utexo's web SDK, which also bundles a Lightning node and a second wallet engine (BDK):
// about 11 MB instead of about 27 MB. No Lightning. Same method names as the SDK's UTEXOWallet, so
// SignetWallet works with either.

import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { SEAL_SATS, SEAL_OUTPUT, SWAP_SIZE_VB, b64, buyerOutputs, outpointOf, completionBlocker, readOffer, buyerCoinFor, offerable, payoutFor, changedTerms, unb64, exactCoinFor, freeSellerCoinFor, INSTANT_SEAL_OUTPUT, INSTANT_SEAL_SATS } from './swap.mjs';

/** rgb-lib names for our network ids. Utexo's custom Signet uses Signet rules too. */
const NETWORKS = { mainnet: 'Mainnet', signet: 'Signet', utexo: 'Signet', testnet: 'Testnet', testnet4: 'Testnet4', regtest: 'Regtest' };
export const rgbNetwork = (n) => NETWORKS[String(n).toLowerCase()] || (() => { throw new Error(`Unknown RGB network: ${n}`); })();

/** rgb-lib wants rpc(s):// transport endpoints; our config uses https:// like the SDK. */
export const rpcEndpoint = (url) => String(url).replace(/^https:\/\//i, 'rpcs://').replace(/^http:\/\//i, 'rpc://');

const num = (x) => Number(x ?? 0);
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

export class LiteWallet {
  /**
   * @param {object} lib  the loaded rgb-lib-wasm module ({ WasmWallet, WasmInvoice, restoreKeys })
   * @param {{ network: string, indexerUrl: string, indexerUrls?: string[], transportEndpoint: string, mnemonic: string, dataDir: string }} params  indexerUrls: block servers to try in order
   */
  constructor(lib, params) {
    this.lib = lib;
    this.params = params;
    this.net = rgbNetwork(params.network);
    this.transport = rpcEndpoint(params.transportEndpoint);
    /** @type {any} */ this.w = null;
    this.online = null;
    this.lastBackupBytes = null;
  }

  /** Create the wallet, restoring its saved state from IndexedDB. */
  async init() {
    const { mnemonic, dataDir } = this.params;
    const k = this.lib.restoreKeys(this.net, mnemonic);
    const data = {
      dataDir, bitcoinNetwork: this.net, databaseType: 'Sqlite', maxAllocationsPerUtxo: 5,
      accountXpubVanilla: k.accountXpubVanilla, accountXpubColored: k.accountXpubColored,
      mnemonic, masterFingerprint: k.masterFingerprint, vanillaKeychain: null,
      // mainnet: NIA (standard RGB tokens) only; this engine has no CFA/UDA, and IFA/BFA are test-network only for now
      supportedSchemas: this.net === 'Mainnet' ? ['Nia'] : ['Nia', 'Ifa'], reuseAddresses: true, // one stable funding address
    };
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
      try { this.online = await this.wallet.goOnline(false, u); this.indexer = u; return u; } catch (e) { last = e; }
    }
    throw last || new Error('Invalid indexer: no block server answered');
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
  async save() { await this.wallet.flush(); }
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
    return { nia: (r.nia || []).map(asset), ifa: (r.ifa || []).map(asset) };
  }
  async listTransfers(assetId = null) { return plain(this.wallet.listTransfers(assetId) || []); }
  /** Give up on a transfer that is still waiting for the other side (frees the RGB output an invoice reserved). */
  async failTransfer(batchTransferIdx) {
    const r = await this.wallet.failTransfers(this.requireOnline(), batchTransferIdx, false, false);
    await this.save();
    return !!r;
  }

  /** Sign a PSBT with this wallet's own keys. */
  sign(psbt) { return this.wallet.signPsbt(psbt); }

  /** Make outputs that can hold RGB assets (one Bitcoin transaction). */
  async createUtxos({ upTo = true, num: n = 4, size = 1000, feeRate }) {
    const online = this.requireOnline();
    const psbt = await this.wallet.createUtxosBegin(online, upTo, n, size, BigInt(Math.round(feeRate)), false);
    const count = await this.wallet.createUtxosEnd(online, this.sign(psbt), false);
    await this.save();
    return count;
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

  /**
   * An invoice. Blind (default): receives onto one of our RGB outputs, blinded, so the sender learns no address;
   * needs a free RGB output. Witness: the sender creates the output (and pays its sats), so it works with no BTC.
   * @param {{ assetId?: string|null, amount?: number, durationSeconds?: number|null, witness?: boolean }} [o]
   */
  /** Every recipient ID this wallet has ever had a transfer for (all assets, and receives not tied to one). */
  usedRecipients() {
    const r = plain(this.wallet.listAssets([]) || {});
    const ids = [null, ...[...(r.nia || []), ...(r.ifa || [])].map((a) => a?.assetId).filter(Boolean)];
    const out = new Set();
    for (const id of ids) for (const t of plain(this.wallet.listTransfers(id)) || []) if (t?.recipientId) out.add(String(t.recipientId));
    return out;
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
      r = plain(this.wallet[make](assetId || null, assignment, durationSeconds, [this.transport], 1));
      if (!witness || !used.has(String(r?.recipientId ?? ''))) break;
      // a reused one is cancelled at once, so it can never match a payment
      try { await this.wallet.failTransfers(this.requireOnline(), r.batchTransferIdx, false, true); } catch { /* offline: it stays open, but it is never shown */ }
      r = null;
    }
    await this.save();
    if (!r) throw new Error('Could not make a fresh RGB invoice. Try again.');
    return { invoice: String(r?.invoice ?? ''), recipientId: String(r?.recipientId ?? ''), expirationTimestamp: r?.expirationTimestamp ?? null };
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
      };
    } finally { inv.free(); }
  }

  /** Send to an invoice (blind or witness): build, sign and broadcast. */
  async onchainSend({ invoice, assetId, amount, feeRate, endpoint = '' }) {
    const online = this.requireOnline();
    const d = await this.decodeRGBInvoice({ invoice });
    const recipients = {
      [assetId]: [{
        recipientId: d.recipientId,
        // a witness invoice: we create the receiver's output, with a few sats in it
        // rgb-lib-wasm wants amountSat as a string here (a number is refused), while the token amount is a number
        witnessData: d.witness ? { amountSat: String(LiteWallet.WITNESS_SATS), blinding: null } : null,
        assignment: { Fungible: amount },
        transportEndpoints: endpoint ? [rpcEndpoint(endpoint)] : d.transportEndpoints.length ? d.transportEndpoints : [this.transport],
      }],
    };
    const psbt = await this.wallet.sendBegin(online, recipients, false, BigInt(Math.round(feeRate)), 1);
    const r = plain(await this.wallet.sendEnd(online, this.sign(psbt), false));
    await this.save();
    return r;
  }

  // ---- peer-to-peer swaps (see swap.mjs). `store` keeps each step's state across approval windows. ----
  get canSwap() { return typeof this.lib.WasmWallet?.newSwapPsbt === 'function' && typeof this.wallet.colorSwap === 'function'; }
  requireSwaps() { if (!this.canSwap) throw new Error('This MASKED build has no swap engine yet. Update MASKED.'); }
  /** The output script of this wallet's bitcoin address, hex. */
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
   * max }] with `spendable` and `max` (the most one offer can sell) in base units. Outputs promised to Instant
   * listings don't count.
   */
  async assetList() {
    try { await this.wallet.sync(this.requireOnline()); } catch { /* last known figures */ }
    const unspents = (plain(this.wallet.listUnspents(false)) || []).filter((u) => { const o = u.utxo?.outpoint; return !o || !this.reserved.has(`${String(o.txid).toLowerCase()}:${o.vout}`); });
    const { nia, ifa } = await this.listAssets();
    return [...nia, ...ifa].map((a) => ({ assetId: a.assetId, ticker: a.ticker, name: a.name, precision: a.precision, spendable: String(a.balance.spendable), max: offerable(unspents, a.assetId).max }))
      .filter((a) => BigInt(a.spendable) > 0n || BigInt(a.max) > 0n);
  }

  /** How much of an asset this wallet can offer: { total, max } (one swap uses one RGB output). */
  async offerableAmount({ assetId }) {
    try { await this.wallet.sync(this.requireOnline()); } catch { /* last known figures */ }
    return offerable(plain(this.wallet.listUnspents(false)) || [], String(assetId || ''));
  }

  /** Buyer, step 1: pick a confirmed bitcoin output, make an invoice for the tokens. Returns the session for the seller. */
  async prepareBuy({ offerId, network, offer, feeRate }, store) {
    this.requireSwaps(); this.checkNet(network);
    const o = readOffer(offer, offerId);
    if (o.state && o.state !== 'OPEN') throw new Error(`The offer is ${o.state.toLowerCase()}.`);
    const online = this.requireOnline();
    const fee = BigInt(Math.ceil(Math.max(1, Number(feeRate) || 1) * SWAP_SIZE_VB));
    const need = o.priceSats + fee + BigInt(SEAL_SATS);
    const coins = await this.wallet.listUnspentsVanilla(online, 1, false);
    const coin = buyerCoinFor(coins, need);
    if (!coin) throw new Error(`Your RGB wallet needs one confirmed bitcoin output over ${need.toLocaleString('en-US')} sats. Tap Add BTC for RGB on Home, then wait a block.`);
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
      [{ script: seal, sats: SEAL_SATS }, { script: await this.ownScript(), sats: Number(payout) }, { script: String(s.buyerChangeScript), sats: Number(change) }],
    );
    const endpoints = (d.transportEndpoints || []).length ? d.transportEndpoints : [this.transport];
    const psbt = await this.wallet.colorSwap(online, unsigned, o.assetId, o.amount, String(d.recipientId), SEAL_OUTPUT, BigInt(SEAL_SATS), endpoints, 1);
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
    if (String(v.contractId || '') !== s.assetId) throw new Error('The transfer is for another token than the offer.');
    if (v.sealAmount == null || BigInt(String(v.sealAmount)) !== BigInt(s.amount)) throw new Error(`The transfer gives you ${v.sealAmount ?? 'nothing'}, the offer says ${s.amount}.`);
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
  /** Move the tokens of a listing onto an output of their own (or a listed output back, when cancelling). */
  async instantMove(assetId, amount, from, feeRate) {
    const online = this.requireOnline();
    const fee = BigInt(Math.ceil(Math.max(1, Number(feeRate) || 1) * SWAP_SIZE_VB));
    const coin = buyerCoinFor(await this.wallet.listUnspentsVanilla(online, 1, false), fee + BigInt(INSTANT_SEAL_SATS));
    if (!coin) throw new Error(`Your RGB wallet needs one confirmed bitcoin output over ${(fee + BigInt(INSTANT_SEAL_SATS)).toLocaleString('en-US')} sats for the network fee. Tap Add BTC for RGB on Home.`);
    const [si, fi] = await Promise.all([this.outpointInfo(from.outpoint), this.outpointInfo(coin.outpoint)]);
    const r = await this.onchainReceive({ assetId, amount: Number(amount), durationSeconds: 86400, witness: true });
    const seal = this.lib.WasmWallet.witnessSealScript(r.invoice);
    const change = BigInt(si.sats) + BigInt(fi.sats) - BigInt(INSTANT_SEAL_SATS) - fee;
    if (change < 546n) throw new Error('Not enough bitcoin for the network fee.');
    const unsigned = this.lib.WasmWallet.newSwapPsbt(
      [{ outpoint: from.outpoint, sats: si.sats, script: si.script, tx: si.tx }, { outpoint: coin.outpoint, sats: fi.sats, script: fi.script, tx: fi.tx }],
      [{ script: seal, sats: INSTANT_SEAL_SATS }, { script: await this.ownScript(), sats: Number(change) }],
    );
    const psbt = await this.wallet.colorSwap(online, unsigned, assetId, BigInt(amount), r.recipientId, SEAL_OUTPUT, BigInt(INSTANT_SEAL_SATS), [this.transport], 1);
    const sent = plain(await this.wallet.sendEnd(online, this.sign(psbt), true));
    await this.save();
    return String(sent?.txid || this.lib.WasmWallet.psbtTxid(psbt));
  }

  /**
   * Seller: start an Instant listing. With an output holding exactly the amount, it's signed at once
   * ({ stage: 'ready', psbt, consignment, templateTxid, sellerOutpoint }); otherwise the tokens move first
   * ({ stage: 'moving', txid }) and `instantProgress` signs it once that transaction confirms.
   */
  async instantList({ offerId, assetId, amount, priceSats, feeRate, market = '', token = '' }, store) {
    this.requirePresign();
    const o = readOffer({ assetId, amount, priceSats }, offerId);
    const prev = store.get(o.offerId);
    if (prev && !['cancelled'].includes(prev.stage)) return this.instantView(o.offerId, prev);
    await this.wallet.sync(this.requireOnline());
    const unspents = plain(this.wallet.listUnspents(false)) || [];
    // market and token: where this wallet sends the signed listing when it's signed later (after the move)
    const base = { role: 'seller', assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats), market: String(market), token: String(token), at: Date.now() };
    const exact = exactCoinFor(unspents, o.assetId, o.amount, this.reserved);
    if (exact) return this.instantSign(o.offerId, { ...base, stage: 'moving' }, store);
    const from = freeSellerCoinFor(unspents, o.assetId, o.amount, this.reserved);
    if (!from) throw new Error('No settled RGB output of this wallet holds that much of the token. Wait for incoming transfers to settle.');
    const txid = await this.instantMove(o.assetId, o.amount, from, feeRate);
    // the new output is promised to this listing from now on: no change or receive lands on it before it's signed
    const e = { ...base, stage: 'moving', moveTxid: txid, coin: `${txid}:${SEAL_OUTPUT}` };
    store.set(o.offerId, e);
    this.reserve([...this.reserved, e.coin]);
    return this.instantView(o.offerId, e);
  }
  async instantSign(offerId, e, store) {
    const online = this.requireOnline();
    const unspents = plain(this.wallet.listUnspents(false)) || [];
    const mine = e.coin ? unspents.filter((u) => `${String(u.utxo?.outpoint?.txid).toLowerCase()}:${u.utxo?.outpoint?.vout}` === e.coin) : unspents;
    const coin = exactCoinFor(mine, e.assetId, e.amount, e.coin ? new Set() : this.reserved);
    if (!coin) return this.instantView(offerId, e); // the move hasn't settled yet
    const r = plain(await this.wallet.presignSale(online, e.assetId, BigInt(e.amount), coin.outpoint, await this.ownScript(), BigInt(e.priceSats), 1));
    const next = { ...e, stage: 'ready', coin: String(r.sellerOutpoint), psbt: String(r.psbt), consignment: b64(Uint8Array.from(r.consignment)), templateTxid: String(r.templateTxid), sellerSats: String(r.sellerSats), at: Date.now() };
    store.set(offerId, next);
    this.reserve([...new Set([...this.reserved, next.coin])]);
    await this.save();
    return this.instantView(offerId, next);
  }
  /** A listing this engine would accept as a buyer (the current layout). */
  validListing(psbt) { try { this.lib.WasmWallet.presignedListingInfo(String(psbt)); return true; } catch { return false; } }
  instantView(offerId, e) {
    return { offerId: String(offerId), stage: e.stage, txid: e.soldTxid || e.cancelTxid || e.moveTxid || null, ...(e.stage === 'ready' ? { psbt: e.psbt, consignment: e.consignment, templateTxid: e.templateTxid, sellerOutpoint: e.coin } : {}) };
  }
  /**
   * Seller, after a refresh: sign listings whose tokens have settled on their own output, and notice listings that
   * sold (their output spent by someone else's transaction) or whose cancel went through. Returns the changes.
   */
  async instantProgress(store, all) {
    const changes = [];
    for (const [id, e] of Object.entries(all)) {
      if (e?.role !== 'seller') continue;
      try {
        if (e.stage === 'moving') {
          const v = await this.instantSign(id, e, store);
          if (v.stage === 'ready') changes.push(v);
        } else if (e.stage === 'ready' && e.psbt && !e.outdated && !this.validListing(e.psbt)) {
          // signed by an earlier MASKED in a layout buyers refuse: it can't sell; cancelling moves the tokens back
          store.set(id, { ...e, outdated: true });
          changes.push({ offerId: id, stage: 'outdated' });
        } else if ((e.stage === 'ready' || e.stage === 'cancelling') && e.coin) {
          const [txid, vout] = e.coin.split(':');
          const sp = await (await this.esplora(`/tx/${txid}/outspend/${vout}`)).json();
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
  /** Seller: cancel an Instant listing. A signed one is moved to a new output (an on-chain transaction). */
  async instantCancel({ offerId, feeRate }, store) {
    const e = store.get(String(offerId));
    if (!e || e.role !== 'seller') throw new Error('This wallet has no Instant listing with that id.');
    if (['sold', 'cancelled', 'cancelling'].includes(e.stage)) return this.instantView(offerId, e);
    if (e.stage === 'moving' || !e.coin) {
      if (e.coin) this.reserve([...this.reserved].filter((x) => x !== e.coin));
      const n = { ...e, stage: 'cancelled', at: Date.now() }; store.set(String(offerId), n); return this.instantView(offerId, n);
    }
    const [txid, vout] = e.coin.split(':');
    const sp = await (await this.esplora(`/tx/${txid}/outspend/${vout}`)).json();
    if (sp?.spent) throw new Error('This listing was just bought. Refresh to see the sale.');
    const cancelTxid = await this.instantMove(e.assetId, e.amount, { outpoint: e.coin }, feeRate);
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
  async instantBuy({ offerId, network, offer, listing, feeRate }, store) {
    this.requirePresign(); this.checkNet(network);
    const o = readOffer(offer, offerId);
    if (o.state && o.state !== 'OPEN') throw new Error(`The offer is ${o.state.toLowerCase()}.`);
    const done = store.get(o.offerId);
    if (done?.txid) return { txid: done.txid };
    const l = listing || {};
    let info;
    try { info = plain(this.lib.WasmWallet.presignedListingInfo(String(l.psbt || ''))); } catch (e) { throw new Error(`The listing does not check out: ${e?.message || e}`); }
    if (String(info.templateTxid) !== String(l.templateTxid)) throw new Error('The listing does not match its transfer.');
    if (BigInt(String(info.payoutSats)) - BigInt(String(info.sellerSats)) !== o.priceSats) throw new Error('The signed price is not the offer\'s price.');
    const online = this.requireOnline();
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
      if (String(v.contractId || '') !== o.assetId) throw new Error('The transfer is for another token than the offer.');
      if (v.sealAmount == null || BigInt(String(v.sealAmount)) !== o.amount) throw new Error(`The transfer gives you ${v.sealAmount ?? 'nothing'}, the offer says ${o.amount}.`);
    };
    const consignment = unb64(String(l.consignment || ''));
    check(consignment, info.templateTxid);
    // pay: one confirmed coin covering the price, the seal and the fee
    const fee = BigInt(Math.ceil(Math.max(1, Number(feeRate) || 1) * SWAP_SIZE_VB));
    const need = o.priceSats + BigInt(INSTANT_SEAL_SATS) + fee;
    const coin = buyerCoinFor(await this.wallet.listUnspentsVanilla(online, 1, false), need);
    if (!coin) throw new Error(`Your RGB wallet needs one confirmed bitcoin output over ${need.toLocaleString('en-US')} sats. Tap Add BTC for RGB on Home, then wait a block.`);
    const bi = await this.outpointInfo(coin.outpoint);
    const r = await this.onchainReceive({ assetId: null, amount: Number(o.amount), durationSeconds: 86400, witness: true });
    const seal = this.lib.WasmWallet.witnessSealScript(r.invoice);
    const change = BigInt(bi.sats) - need;
    const unsigned = this.lib.WasmWallet.presignedBuyPsbt(String(l.psbt), [{ outpoint: coin.outpoint, sats: bi.sats, script: bi.script, tx: bi.tx }], seal, change >= 546n ? { script: await this.ownScript(), sats: Number(change) } : null);
    const txHex = this.extractHex(this.sign(unsigned));
    const txid = this.lib.WasmWallet.checkPresignedFinal(String(l.psbt), txHex, seal);
    const completed = this.lib.WasmWallet.completePresignedConsignment(consignment, info.templateTxid, txHex);
    check(completed, txid);
    store.set(o.offerId, { role: 'buyer', assetId: o.assetId, amount: String(o.amount), priceSats: String(o.priceSats), recipientId: r.recipientId, txid, completed: b64(completed), posted: false, at: Date.now() });
    await this.esplora('/tx', { method: 'POST', body: txHex });
    await this.instantPost(o.offerId, store);
    await this.save();
    return { txid };
  }
  /** Buyer: give this wallet the transfer (through the transfer server, like any incoming one). Retried on refresh. */
  async instantPost(offerId, store) {
    const e = store.get(String(offerId));
    if (!e || e.role !== 'buyer' || e.posted) return false;
    try {
      await this.wallet.postOwnConsignment(this.transport, e.recipientId, unb64(e.completed), e.txid, INSTANT_SEAL_OUTPUT);
    } catch (err) { if (!/already used/i.test(String(err?.message || err))) return false; }
    store.set(String(offerId), { ...e, posted: true, completed: undefined, at: Date.now() });
    return true;
  }

  /** Check that an RGB transfer server answers and speaks a protocol this engine supports. Throws the reason. */
  async checkProxy(url) { await this.lib.checkProxyUrl(url); }

  async createBackup({ password }) { this.lastBackupBytes = this.wallet.backup(password); }
  getLastBackupBytes() { return this.lastBackupBytes; }
  async restoreFromBackupBytes(bytes, password) { this.wallet.restoreBackup(bytes, password); await this.save(); }
}
