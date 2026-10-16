// Private trading. Sites the user allows trade from a private trade address (see trade-core.mjs). Bitcoin
// and tokens move between Shielded and the trade address inside the wallet; the site only ever sees the
// trade address and the Shielded totals, never the Shielded address or its payments.
//
// Since 2.12.5 tokens can also be listed straight from Shielded: a BRC-20 balance in Shielded sits on a
// silent-payment output (a one-time address only this wallet knows); the transfer is inscribed onto that
// same output script and listed from there. Those "holder" scripts are remembered so the wallet can sign
// the listing and sees the bitcoin when it sells.
import * as trade from './trade-core.mjs';
import { fromHex, toHex } from '../core/bytes.mjs';
import { sumSats } from '../core/format.mjs';
import { readJson } from '../net/http.mjs';
import { UNISAT_NET } from '../bitcoin/networks.mjs';
import { p2trScript } from '../bitcoin/taproot.mjs';
import { DUST_CHANGE, INSCRIPTION_MAX, TRANSFER_POSTAGE } from '../ordinals/envelope.mjs';
import { checkAmount, checkTick, normTick, transferBody } from '../ordinals/brc20.mjs';

/** Only MASKED's own website may sign for the trade address or Shielded listings. */
export const TRADE_SITES = new Set(['https://maskedwallet.com', 'https://www.maskedwallet.com']);

const NOT_TRADING = 'This wallet cannot trade privately (watch-only or demo).';
const SERVER_DOWN = 'The token server is not answering. Try again in a minute.';

export class TradeAccount {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.memo = new Map();   // `${walletId}:${n}` → trade key
    this.cache = null;       // the stored state of the open wallet
    this.published = null;   // what was last shared with the background ('off' or JSON)
  }

  get account() { return this.app.account; }
  get coins() { return this.app.coins; }
  get store() { return this.app.store; }
  get storeKey() { return `wren.trade.${this.account.id}`; }

  // ---- stored state: { cur, on, checked, pend, holders } ----
  st() {
    const id = this.account.id;
    if (!this.cache || this.cache.id !== id) this.cache = { cur: 0, on: false, checked: false, pend: [], ...(this.store.getJson(this.storeKey, null) || {}), id };
    return this.cache;
  }
  save() { const { id, ...s } = this.st(); this.store.setJson(this.storeKey, s); }

  get on() { return this.account.canTrade && this.st().on; }

  // ---- keys ----
  keyAt(n) {
    const k = `${this.account.id}:${n}`;
    if (!this.memo.has(k)) this.memo.set(k, trade.tradeKey(this.account.keys.bSpend, n, this.account.net));
    return this.memo.get(k);
  }
  current() { return this.keyAt(this.st().cur); }

  /** The trade key for an output script (any address used so far, plus the next one). */
  keyBySpk(spkHex) {
    if (!this.account.canTrade || !spkHex) return null;
    for (let n = 0; n <= this.st().cur + 1; n++) { const k = this.keyAt(n); if (k.spk === spkHex) return k; }
    return null;
  }

  /** Listed Shielded holders: spk → { tweak, label, address, at }. */
  holders() { const s = this.st(); return (s.holders ||= {}); }

  /** Key for a taproot script this wallet controls without a taproot tweak: the trade address or a listed Shielded holder. */
  keyPathFor(spkHex) {
    if (!this.account.canTrade || !spkHex) return null;
    const t = this.keyBySpk(spkHex);
    if (t) return { priv: t.priv, kind: 'trade', index: t.index };
    const h = this.holders()[spkHex];
    return h ? { priv: this.account.keys.outputPriv(h.tweak), kind: 'shielded' } : null;
  }

  // ---- the chain ----
  async utxos(k = this.current()) {
    const list = await readJson(await fetch(`${this.app.servers.base()}address/${k.address}/utxo`), 'Trade address lookup');
    if (!Array.isArray(list)) throw new Error('Trade address lookup returned an unexpected reply.');
    return list.map((u) => ({ key: `trade:${u.txid}:${u.vout}`, kind: 'trade', txid: u.txid, vout: u.vout, sats: u.value, output: k.outputX, privKey: k.priv, address: k.address, pending: !u.status?.confirmed }));
  }

  /** Read the trade address's coins into the coin store (empty on failure). */
  async loadCoins(k = this.current()) {
    this.coins.trade = await this.utxos(k).catch(() => []);
    return this.coins.trade;
  }

  /** Tokens on a trade address, from the token server (null when it cannot answer). */
  tokens(address) { return this.app.tokenServer.walletTokens(address); }

  /** After a restore: find the trade address in use (addresses are only renewed once emptied). */
  async discover() {
    const s = this.st();
    if (s.checked || !this.account.canTrade) return;
    let last = -1;
    for (let n = 0; n < 50; n++) {
      const a = await readJson(await fetch(`${this.app.servers.base()}address/${this.keyAt(n).address}`), 'Trade address lookup');
      if ((a.chain_stats?.tx_count || 0) + (a.mempool_stats?.tx_count || 0) === 0) break;
      last = n;
    }
    if (last >= 0) {
      const k = this.keyAt(last);
      const coins = await this.utxos(k);
      const toks = coins.length ? [] : await this.tokens(k.address);
      s.cur = coins.length || toks == null || toks.some((t) => Number(t.overall) > 0) ? last : last + 1;
    }
    s.checked = true; this.save();
  }

  // ---- what the site sees ----
  /** Transfers inscribed in Shielded for selling whose coin is still unspent: the site lists them without inscribing again. */
  openShieldedTransfers() {
    const codec = this.account.codec;
    return this.app.transfers.list().filter((t) => t.listing).map((t) => ({ t, c: this.coins.shielded.find((c) => c.key === t.listing) })).filter((x) => x.c)
      .map(({ t, c }) => ({ ticker: t.tick, amount: String(t.amt), inscriptionId: `${t.revealTxid}i0`, outpoint: t.listing, value: c.sats, address: codec.fromScript(fromHex(t.fromSpk)), pending: !!c.pending, at: t.at }));
  }

  /** Shielded token balances by ticker. */
  shieldedTokenTotals() {
    const book = this.app.tokens;
    return book.known().map((t) => ({ tick: t.tick, amt: book.heldOn(t.tick, 'shielded') })).filter((x) => x.amt > 0);
  }

  info() {
    const k = this.current();
    // features: what this wallet can do for the site (2.12.5: list tokens straight from Shielded)
    return { net: UNISAT_NET[this.account.net], address: k.address, index: k.index, publicKey: k.outputX, features: ['shieldedListing'], shielded: { sats: sumSats(this.coins.shieldedSpendable()), tokens: this.shieldedTokenTotals(), transfers: this.openShieldedTransfers() } };
  }

  /** Share the trade view with the background (it answers getTradeAccount without opening the wallet). */
  publish() {
    const platform = this.app.platform;
    if (!platform.hasExt || !this.account.keys) return;
    if (!this.on) {
      if (this.published !== 'off') { this.published = 'off'; platform.storageRemove('masked.trade'); }
      return;
    }
    const v = this.info();
    const key = JSON.stringify(v);
    if (key === this.published) return;
    this.published = key;
    platform.storageSet({ 'masked.trade': { ...v, updatedAt: Date.now() } });
  }

  enable() { const s = this.st(); s.on = true; this.save(); this.published = null; this.publish(); }

  /** Transfer inscriptions made on the trade address that the token server may not count yet. */
  async pendingOf(tick) {
    const s = this.st();
    const keep = [];
    for (const p of s.pend || []) {
      if (Date.now() - p.at > 2 * 864e5) continue;
      if (!p.confirmedAt) {
        try { const r = await fetch(`${this.app.servers.base()}tx/${p.txid}/status`); const j = r.ok ? await r.json() : null; if (j?.confirmed) p.confirmedAt = Date.now(); } catch {}
      }
      if (p.confirmedAt && Date.now() - p.confirmedAt > 10 * 60000) continue; // the token server has it by now
      keep.push(p);
    }
    s.pend = keep; this.save();
    return keep.filter((p) => p.tick === tick && p.address === this.current().address).reduce((a, p) => a + p.amt, 0);
  }

  addPending(tick, amt, txid, address) {
    const s = this.st();
    s.pend = [...(s.pend || []), { tick, amt: Number(amt), txid, address, at: Date.now() }];
    this.save();
  }

  /** Shielded coins in the shape trade-core takes. */
  shieldedForTrade() {
    return this.coins.shieldedSpendable().map((c) => ({ txid: c.txid, vout: c.vout, value: c.sats, priv: c.privKey || this.account.keys.outputPriv(c.tweak), key: c.key }));
  }

  /** Available tokens of a ticker on the trade address (server balance minus pending inscriptions). */
  async available(tick) {
    const toks = await this.tokens(this.current().address);
    if (toks == null) throw new Error(SERVER_DOWN);
    const it = toks.find((t) => t.ticker === tick);
    return Math.max(0, (Number(it?.available) || 0) - (await this.pendingOf(tick)));
  }

  // ---- transactions ----
  /** Shielded → trade address (bitcoin), with an optional small coin a purchase lands in. */
  async buildFund({ sats, padding = false, rate }) {
    if (!this.account.canTrade) throw new Error(NOT_TRADING);
    await this.coins.ensureOrd('shielded');
    const k = this.current();
    sats = Number(sats) || 0;
    if (sats && sats < DUST_CHANGE) throw new Error(`The amount must be at least ${DUST_CHANGE} sats.`);
    const outputs = [...(padding ? [{ script: fromHex(k.spk), value: trade.TRADE_PADDING }] : []), ...(sats ? [{ script: fromHex(k.spk), value: sats }] : [])];
    if (!outputs.length) throw new Error('Nothing to move.');
    const coins = this.shieldedForTrade();
    if (!coins.length) throw new Error('Your Shielded balance is empty.');
    const b = trade.buildShieldedPay({ coins, outputs, changeAddress: this.account.changeAddr(), feeRate: rate });
    return { ...b, address: k.address, amount: outputs.reduce((a, o) => a + o.value, 0), padding, spentKeys: b.spent.map((c) => c.key) };
  }

  /** Everything on the trade address → Shielded (items keep their own coins). */
  async buildReturn({ rate }) {
    if (!this.account.canTrade) throw new Error(NOT_TRADING);
    const k = this.current();
    const coins = await this.utxos(k);
    this.coins.trade = coins;
    if (!coins.length) return { empty: true, address: k.address, items: 0, total: 0, fee: 0, spentKeys: [] };
    const ord = this.app.ord;
    await ord.check(coins);
    // anything small, unconfirmed or not checked by ord yet is kept on its own coin (it may hold an inscription)
    const keep = (c) => c.sats <= INSCRIPTION_MAX || c.pending || !ord.of(c) || !!(ord.of(c).ins || ord.of(c).runes);
    const list = coins.map((c) => ({ txid: c.txid, vout: c.vout, value: c.sats, priv: c.privKey, keep: keep(c), key: c.key }));
    const b = trade.buildReturnToShielded({ coins: list, extra: this.shieldedForTrade(), shieldAddress: this.account.shieldAddr(), feeRate: rate });
    return { ...b, address: k.address, items: list.filter((c) => c.keep).length, total: list.reduce((a, c) => a + c.value, 0), spentKeys: b.spent.map((c) => c.key).filter(Boolean) };
  }

  /** A transfer inscription on the trade address (2.12.4 flow). */
  async buildTransferInscribe({ tick, amt, rate }) {
    tick = normTick(tick); checkTick(tick);
    amt = checkAmount(amt, 'Amount');
    const k = this.current();
    const avail = await this.available(tick);
    const T = tick.toUpperCase();
    if (Number(amt) > avail) throw new Error(avail ? `Only ${avail.toLocaleString()} ${T} available on your trade address.` : `No ${T} on your trade address yet. Move some from Shielded first (it needs 1 confirmation).`);
    await this.loadCoins(k);
    // the fee comes from Shielded when it can (nothing links back), otherwise from the trade address itself
    const from = sumSats(this.coins.shieldedSpendable()) ? 'shielded' : 'trade';
    const ins = await this.app.builder.inscription({ from, rate, recipient: k.address, body: transferBody(tick, amt), meta: { op: 'transfer', tick, amt }, postage: TRANSFER_POSTAGE });
    return { ...ins, op: 'transfer', tick, amt, tradeAddress: k.address, avail };
  }

  /** Tokens Shielded → trade address, or back with `back`. */
  async buildTokenMove({ tick, amt, rate, back = false }) {
    if (!this.account.canTrade) throw new Error(NOT_TRADING);
    const k = this.current();
    const tokenTx = this.app.tokenTx;
    if (!back) return tokenTx.send({ tick, amt, to: k.address, from: 'shielded', rate, only: 'shielded' });
    tick = normTick(tick); checkTick(tick);
    const avail = await this.available(tick);
    await this.loadCoins(k);
    return tokenTx.send({ tick, amt, to: this.account.shieldAddr(), from: sumSats(this.coins.shieldedSpendable()) ? 'shielded' : 'trade', rate, holder: { pkscript: k.spk, amt: avail, key: { priv: k.priv, kind: 'trade' } } });
  }

  /** Renew the trade address once nothing is left on it, so the next trades use a fresh one. */
  async maybeRenew(spentAll) {
    const k = this.current();
    if (!spentAll) return false;
    const toks = await this.tokens(k.address);
    if (toks == null || toks.some((t) => Number(t.overall) > 0)) return false;
    const s = this.st(); s.cur += 1; this.save(); this.publish();
    return true;
  }

  // ---- listing straight from Shielded ----
  async buildShieldedTransferInscribe({ tick, amt, rate }) {
    if (!this.account.canTrade) throw new Error(NOT_TRADING);
    tick = normTick(tick); checkTick(tick);
    amt = checkAmount(amt, 'Amount');
    const T = tick.toUpperCase(), book = this.app.tokens;
    const all = book.holdings(tick).filter((h) => book.holderKey(h.pkscript)?.kind === 'shielded');
    const h = all.filter((x) => x.amt >= Number(amt)).sort((a, b) => a.amt - b.amt)[0];
    if (!h) {
      const max = all.reduce((a, x) => Math.max(a, x.amt), 0);
      throw new Error(max ? `You can list up to ${max.toLocaleString()} ${T} at once from Shielded (they sit on ${all.length} coins).` : `No ${T} in Shielded.`);
    }
    const coin = this.coins.shielded.find((c) => c.output === h.pkscript.slice(4) && c.tweak);
    if (!coin) throw new Error('The coin holding these tokens is not in the wallet yet. Open MASKED and let it sync.');
    await this.coins.ensureOrd('shielded');
    if (!sumSats(this.coins.shieldedSpendable())) throw new Error('Not enough Shielded bitcoin for the network fee. Add a little BTC to Shielded first.');
    const ins = await this.app.builder.inscription({ from: 'shielded', rate, recipient: '', rawRecipientScript: fromHex(h.pkscript), body: transferBody(tick, amt), meta: { op: 'transfer', tick, amt }, postage: TRANSFER_POSTAGE });
    return { ...ins, op: 'transfer', tick, amt, holderSpk: h.pkscript, holderAddress: this.account.codec.fromScript(fromHex(h.pkscript)), holderTweak: coin.tweak, holderLabel: coin.label ?? null, avail: h.amt, shieldedListing: true };
  }

  /** After broadcasting: remember the holder, add the new transfer coin, and take the amount off the Shielded balance. */
  recordShieldedListing(b) {
    this.holders()[b.holderSpk] = { tweak: b.holderTweak, label: b.holderLabel, address: b.holderAddress, at: Date.now() };
    this.save();
    const key = `${b.revealTxid}:${b.revealOut}`;
    if (!this.coins.shielded.some((c) => c.key === key)) this.coins.shielded.push({ key, txid: b.revealTxid, vout: b.revealOut, sats: b.estimate.revealValue, output: b.holderSpk.slice(4), tweak: b.holderTweak, label: b.holderLabel, pending: true, listed: true });
    this.app.inscriptions.set(key, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId, ready: true });
    this.app.transfers.prepend({ tick: b.tick, amt: b.amt, to: 'Listed for sale', toKind: 'listing', toSpk: '', toOwn: false, fromSpk: b.holderSpk, commitTxid: b.commitTxid, revealTxid: b.revealTxid, sendTxid: b.revealTxid, listing: key, at: Date.now() });
    this.coins.save();
  }

  /** Bitcoin (sales) and items (swaps) arriving at listed holders show up in Shielded. */
  async syncHolders() {
    if (!this.account.canTrade) return;
    // every Shielded coin that holds tokens is a holder: a transfer inscribed onto its script (by any MASKED, also
    // before a reinstall or in another browser) sits there as a new coin that silent-payment scanning cannot see
    const H = this.holders(), codec = this.account.codec, ins = this.app.inscriptions;
    let grew = false;
    const mintSpks = new Set(this.app.mints.list().map((m) => m.pkscript).filter(Boolean));
    for (const c of this.coins.shielded) {
      if (!c.tweak || c.example) continue;
      const spk = toHex(p2trScript(c.output)), i = ins.of(c);
      if (H[spk] || !(mintSpks.has(spk) || (i?.brc20 && (i.op === 'mint' || (i.op === 'transfer' && i.received))))) continue;
      H[spk] = { tweak: c.tweak, label: c.label ?? null, address: codec.fromScript(fromHex(spk)), at: Date.now() }; grew = true;
    }
    if (grew) this.save();
    const hs = Object.entries(H);
    if (!hs.length) return;
    let added = false;
    for (const [spk, h] of hs) {
      try {
        const list = await readJson(await fetch(`${this.app.servers.base()}address/${h.address}/utxo`), 'Balance lookup');
        for (const u of list || []) {
          const key = `${u.txid}:${u.vout}`;
          const have = this.coins.shielded.find((c) => c.key === key);
          if (have) { if (u.status?.confirmed) have.pending = false; continue; }
          this.coins.shielded.push({ key, txid: u.txid, vout: u.vout, sats: u.value, output: spk.slice(4), tweak: h.tweak, label: h.label ?? null, pending: !u.status?.confirmed });
          added = true;
        }
      } catch {}
    }
    if (added) this.coins.save();
  }

  /** A transfer inscription found on a Shielded holder with no record (inscribed elsewhere, or before a reinstall) is
   *  ready to sell: record it like one inscribed here (taken off the free balance, shown and reported to the site). */
  recoverShieldedTransfers() {
    if (!this.account.canTrade) return;
    const H = this.holders(), recs = this.app.transfers.list(), add = [];
    for (const c of this.coins.shielded) {
      const spk = toHex(p2trScript(c.output)), i = this.app.inscriptions.of(c);
      if (!H[spk] || !i?.brc20 || i.op !== 'transfer' || i.received || !i.tick) continue;
      if (recs.some((t) => t.listing === c.key || t.revealTxid === c.txid)) continue;
      add.push({ tick: i.tick, amt: i.amt, to: 'Listed for sale', toKind: 'listing', toSpk: '', toOwn: false, fromSpk: spk, commitTxid: '', revealTxid: c.txid, sendTxid: c.txid, listing: c.key, at: i.at || Date.now(), recovered: true });
      c.listed = true;
    }
    if (add.length) { this.app.transfers.save([...add, ...recs]); this.coins.save(); }
  }

  /** Cancel a listing made from Shielded: move the listed coin back into Shielded (the signed listing dies everywhere). */
  async buildShieldedCancel({ outpoint, rate }) {
    if (!this.account.canTrade) throw new Error(NOT_TRADING);
    const c = this.coins.shielded.find((x) => x.key === outpoint);
    const spk = c ? toHex(p2trScript(c.output)) : '';
    if (!c || !this.holders()[spk]) throw new Error('That listing is not one of this wallet\'s Shielded listings.');
    await this.coins.ensureOrd('shielded');
    const i = this.app.inscriptions.of(c) || {};
    const extra = this.shieldedForTrade().filter((x) => x.key !== c.key && !(x.txid === c.txid && x.vout === c.vout));
    const b = trade.buildReturnToShielded({ coins: [{ txid: c.txid, vout: c.vout, value: c.sats, priv: this.account.keys.outputPriv(c.tweak), keep: true, key: c.key }], extra, shieldAddress: this.account.shieldAddr(), feeRate: rate });
    return { ...b, coin: c, tick: i.tick, amt: i.amt, spentKeys: b.spent.map((x) => x.key).filter(Boolean) };
  }
}
