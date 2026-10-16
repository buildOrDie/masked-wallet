// Token balances. A BRC-20 balance lives on the exact script that received it (what BRC-20 calls the
// "wallet"), so this wallet's balance of a ticker is spread over its Public script and the Shielded
// outputs that received mints or transfers. The book adds up three sources: this browser's records,
// the inscriptions on the coins it holds (so a lost history still counts) and the token server.
import { decToRaw } from '../core/format.mjs';
import { isV2, tickLen } from '../ordinals/brc20.mjs';
import { p2trScript } from '../bitcoin/taproot.mjs';
import { toHex } from '../core/bytes.mjs';

const spkOf = (c) => toHex(p2trScript(c.output));

export class TokenBook {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.idx = null;          // last token-server snapshot: { height, tokens, validation, decimals, err, at }
    this.idxBusy = false;
    this._public = undefined; // token-server list for the Public address (lazy, cached in localStorage)
  }

  get coins() { return this.app.coins; }
  get account() { return this.app.account; }
  get mints() { return this.app.mints; }
  get transfers() { return this.app.transfers; }
  get pending() { return this.app.pending; }
  get ins() { return this.app.inscriptions; }

  // ---- the token server's view of the Public address ----
  get publicKey() { return `wren.idxw.${this.account.id}`; }
  resetCache() { this._public = undefined; }

  /** { address, at, list: [{ ticker, overall, available, transferable, decimals, validation }] } or null. */
  publicTokens() {
    if (this._public === undefined) this._public = this.app.store.getJson(this.publicKey, null);
    return this._public && this._public.address === this.account.pubAddr() ? this._public : null;
  }
  publicToken(tick) { return this.publicTokens()?.list.find((t) => String(t.ticker).toLowerCase() === tick) || null; }

  async refreshPublicTokens() {
    const pub = this.account.pubAddr();
    if (!this.app.tokenServer.url() || !pub) return;
    try {
      const list = await this.app.tokenServer.get(`/v1/brc20/wallet_tokens?address=${pub}`);
      if (!Array.isArray(list)) return;
      this._public = { address: pub, at: Date.now(), list: list.filter((t) => t.ticker).map((t) => ({ ...t, ticker: String(t.ticker).toLowerCase() })) };
      this.app.store.setJson(this.publicKey, this._public);
    } catch {} // older token servers / OPI: no wallet list, per-token lookups still work
  }

  // ---- what the wallet holds ----
  /** Total minted of a ticker by this wallet (records plus mint inscriptions on its coins). */
  mintedSoFar(tick) {
    const recorded = this.mints.list().filter((m) => m.tick === tick);
    const seen = new Set(recorded.map((m) => m.revealTxid));
    let total = recorded.reduce((a, m) => a + (Number(m.amt) || 0), 0);
    for (const c of this.coins.shieldedThenPublic()) {
      const i = this.ins.of(c);
      if (i?.brc20 && i.op === 'mint' && i.tick === tick && !seen.has(c.txid)) { seen.add(c.txid); total += Number(i.amt) || 0; }
    }
    return total;
  }

  /** Tickers this wallet knows: deployed by you, minted by you, or found in your coins. */
  known() {
    const t = new Map();
    const add = (tick, patch = {}) => {
      if (!tick) return undefined;
      const x = t.get(tick) || { tick, minted: 0, mints: 0, deployed: false, lim: null };
      Object.assign(x, patch); t.set(tick, x);
      return x;
    };
    const mints = this.mints.list();
    for (const d of this.app.deploys.list()) if (d.status === 'deployed') add(d.tick, { deployed: true, lim: d.lim });
    for (const m of mints) { const x = add(m.tick); x.minted += Number(m.amt) || 0; x.mints++; }
    const coins = this.coins.shieldedThenPublic();
    for (const c of coins) {
      const i = this.ins.of(c);
      if (i?.brc20 && i.op === 'mint' && !mints.some((m) => m.revealTxid === c.txid)) { const x = add(i.tick); x.minted += Number(i.amt) || 0; x.mints++; }
    }
    for (const c of coins) { const i = this.ins.of(c); if (i?.brc20 && i.op === 'transfer' && i.received && i.tick) add(i.tick); }
    for (const it of this.publicTokens()?.list || []) if (Number(it.overall) > 0) add(it.ticker);
    return [...t.values()];
  }

  /** The script a mint landed on. */
  mintSpk(r) {
    if (r.pkscript) return r.pkscript;
    const c = this.coins.shieldedThenPublic().find((x) => x.txid === r.revealTxid && x.vout === r.revealOut);
    return c ? spkOf(c) : null;
  }

  /** Where this wallet holds a ticker: [{ pkscript, amt }]. */
  holdings(tick) {
    const m = new Map();
    const add = (spk, v) => spk && m.set(spk, (m.get(spk) || 0) + v);
    const mints = this.mints.list(), transfers = this.transfers.list();
    for (const r of mints) if (r.tick === tick) add(this.mintSpk(r), Number(r.amt) || 0);
    // Also trust the chain: any coin we hold that carries a mint inscription counts, even if this
    // browser lost its mint history (reinstall, cleared storage, restored phrase).
    const recorded = new Set(mints.map((r) => r.revealTxid));
    for (const c of this.coins.shieldedThenPublic()) {
      const i = this.ins.of(c);
      if (i?.brc20 && i.op === 'mint' && i.tick === tick && !recorded.has(c.txid)) add(spkOf(c), Number(i.amt) || 0);
      // tokens someone sent us: the balance now sits on the script that received the transfer
      if (i?.brc20 && i.op === 'transfer' && i.received && i.tick === tick && !transfers.some((t) => t.sendTxid === c.txid)) add(spkOf(c), Number(i.amt) || 0);
    }
    for (const t of transfers) if (t.tick === tick) { add(t.fromSpk, -Number(t.amt)); if (t.toOwn) add(t.toSpk, Number(t.amt)); }
    const it = this.publicToken(tick), pubSpk = this.account.pubSpk();
    if (it && pubSpk) m.set(pubSpk, Math.max(m.get(pubSpk) || 0, Number(it.overall) || 0));
    return [...m].map(([pkscript, amt]) => ({ pkscript, amt })).filter((h) => h.amt > 0);
  }

  heldTotal(tick) { return this.holdings(tick).reduce((a, h) => a + h.amt, 0); }
  heldMaxSingle(tick) { return this.holdings(tick).reduce((a, h) => Math.max(a, h.amt), 0); }
  /** Held on one side ('public' | 'shielded'). */
  heldOn(tick, side) { return this.holdings(tick).filter((h) => this.holderKey(h.pkscript)?.kind === side).reduce((a, h) => a + h.amt, 0); }

  /** The key for a holder script: { priv, kind: 'public' | 'shielded' }, or null. */
  holderKey(spkHex) {
    const f = this.account.funding();
    if (f && spkHex === this.account.pubSpk()) return { priv: f.outputPriv, kind: 'public' };
    const x = spkHex.slice(4);
    const c = this.coins.shielded.find((k) => k.output === x && k.tweak);
    return c ? { priv: this.account.keys.outputPriv(c.tweak), kind: 'shielded' } : null;
  }

  // ---- transfer inscriptions on the Public address ----
  /** Pending sends and transfers of a ticker the token server may not count yet. */
  pendingFor(tick, kind) {
    const list = this.pending.prune().filter((p) => p.tick === tick && (!kind || p.kind === kind));
    let n = list.reduce((a, p) => a + p.amt, 0);
    // also transfer inscriptions on the Public address that are still unconfirmed but were made before this list existed
    if (!kind || kind === 'transfer') for (const c of this.coins.public) {
      const i = c.pending && this.ins.of(c);
      if (i?.op === 'transfer' && i.ready && i.tick === tick && !list.some((p) => p.txid === c.txid)) n += Number(i.amt) || 0;
    }
    return n;
  }

  /** Unused transfer inscriptions on the Public address (the tokens are locked in them). */
  heldTransfers(tick) {
    let amt = 0; const txids = new Set();
    for (const c of this.coins.public) {
      const i = this.ins.of(c);
      if (i?.brc20 && i.op === 'transfer' && i.tick === tick && !i.received) { amt += Number(i.amt) || 0; txids.add(c.txid); }
    }
    return { amt, txids };
  }

  /** Tokens on the Public address that can still go into a new transfer inscription. Never more than
   *  "everything minus what is already inscribed", even if the token server has not caught up. */
  transferAvail(tick) {
    if (!this.account.funding()) return 0;
    const it = this.publicToken(tick);
    const held = this.heldTransfers(tick);
    // pending sends, and inscriptions whose coin the wallet has not seen yet
    const extra = this.pending.prune().filter((p) => p.tick === tick && !held.txids.has(p.txid)).reduce((a, p) => a + p.amt, 0);
    if (it) {
      const overall = Number(it.overall) || 0, avail = Number(it.available) || 0;
      return Math.max(0, Math.min(avail, overall - held.amt) - extra);
    }
    const base = this.holdings(tick).find((h) => h.pkscript === this.account.pubSpk())?.amt || 0;
    return Math.max(0, base - held.amt - extra);
  }

  inscribedFor(tick) {
    const held = this.heldTransfers(tick);
    const extra = this.pending.prune().filter((p) => p.tick === tick && p.kind === 'transfer' && !held.txids.has(p.txid)).reduce((a, p) => a + p.amt, 0);
    return Math.max(Number(this.publicToken(tick)?.transferable) || 0, held.amt) + extra;
  }

  // ---- history ----
  /** Everything that moved a ticker in or out of this wallet, newest first, with totals. */
  ledger(tick) {
    const ev = [];
    const mints = this.mints.list(), transfers = this.transfers.list();
    const recorded = new Set(mints.map((m) => m.revealTxid));
    for (const m of mints) if (m.tick === tick) ev.push({ kind: 'mint', amt: Number(m.amt) || 0, at: m.at || 0, txid: m.revealTxid, pending: !m.height, where: m.to === 'other' ? 'to someone else' : '' });
    for (const c of this.coins.shieldedThenPublic()) {
      const i = this.ins.describe(c);
      if (!i?.brc20 || i.tick !== tick) continue;
      const where = c.kind === 'funding' ? 'Public' : 'Shielded';
      if (i.op === 'mint' && !recorded.has(c.txid)) ev.push({ kind: 'mint', amt: Number(i.amt) || 0, at: i.at || 0, txid: c.txid, pending: !!c.pending, where });
      if (i.op === 'transfer' && i.received && !transfers.some((t) => t.sendTxid === c.txid)) ev.push({ kind: 'in', amt: Number(i.amt) || 0, at: i.at || 0, txid: c.txid, pending: !!c.pending, from: i.from || '', where });
    }
    for (const t of transfers) {
      if (t.tick !== tick) continue;
      // listed straight from Shielded: still yours while the listed coin is unspent, sold once it is gone
      if (t.listing) {
        const c = this.coins.shielded.find((x) => x.key === t.listing);
        ev.push({ kind: c ? 'list' : 'sold', amt: Number(t.amt) || 0, at: t.at || 0, txid: t.revealTxid, pending: !!c?.pending, where: 'Shielded' });
        continue;
      }
      ev.push({ kind: t.toOwn ? 'move' : 'out', amt: Number(t.amt) || 0, at: t.at || 0, txid: t.sendTxid, to: t.to, pending: false, where: t.toKind === 'shielded' ? 'Shielded' : 'Public' });
    }
    ev.sort((x, y) => (y.at || Infinity) - (x.at || Infinity));
    const total = (k) => ev.filter((e) => e.kind === k).reduce((a, e) => a + e.amt, 0);
    return {
      events: ev, minted: total('mint'), received: total('in'), sent: total('out') + total('sold'), listed: total('list'), held: this.heldTotal(tick),
      pendingIn: ev.filter((e) => e.pending && (e.kind === 'in' || e.kind === 'mint')).reduce((a, e) => a + e.amt, 0),
    };
  }

  /** Tokens this wallet knows about: [{ tick, held, listed, v2 }], biggest first. */
  list() {
    const ticks = new Set(this.known().map((t) => t.tick));
    for (const t of this.transfers.list()) ticks.add(t.tick);
    return [...ticks].filter(Boolean)
      .map((tick) => { const listed = this.ledger(tick).listed; return { tick, held: this.heldTotal(tick) + listed, listed, v2: isV2(tick) }; })
      .sort((x, y) => y.held - x.held || x.tick.localeCompare(y.tick));
  }

  // ---- minting checks (from the token server's supply data) ----
  tickerInfo(tick) {
    return this.app.tokenServer.tickerInfo(tick, () => { if (this.app.state.view === 'mint') this.app.render(); });
  }

  /** Why a mint of this ticker cannot work right now, or ''. */
  mintBlock(tick) {
    tick = String(tick || '').trim().toLowerCase();
    if (this.app.deploys.find(tick)) return '';
    const d = this.tickerInfo(tick)?.data;
    if (!d) return '';
    const T = tick.toUpperCase();
    if (d.unknown) return `${T} is not deployed, so a mint would not count.`;
    if (d.soldOut) return `${T} is sold out: all ${Number(d.max).toLocaleString()} are minted. A mint now would not count.`;
    if (d.selfMint) return `Only the deployer can mint ${T}.`;
    return '';
  }

  // ---- the token server's balances, script by script ----
  /** Scripts that may hold a ticker: the Public script and every script a mint of it landed on. */
  scripts(tick) {
    const out = new Set();
    const pubSpk = this.account.pubSpk();
    if (pubSpk) out.add(pubSpk);
    for (const m of this.mints.list()) {
      if (m.tick !== tick) continue;
      if (m.pkscript) out.add(m.pkscript);
      else { const c = this.coins.shieldedThenPublic().find((x) => x.txid === m.revealTxid && x.vout === m.revealOut); if (c) out.add(spkOf(c)); }
    }
    return [...out];
  }

  async refreshIndexer() {
    if (!this.app.tokenServer.url() || !this.account.keys) { this.idx = null; return; }
    if (this.idxBusy) return;
    this.idxBusy = true;
    try { this.idx = await this.readIndexer(); } finally { this.idxBusy = false; }
  }

  async readIndexer() {
    const srv = this.app.tokenServer, net = this.app.state.net;
    const idx = { height: null, tokens: {}, validation: {}, decimals: {}, err: null, at: Date.now() };
    try {
      idx.height = Number(await srv.get('/v1/brc20/block_height'));
      await this.refreshPublicTokens();
      const pubSpk = this.account.pubSpk();
      for (const t of this.known()) {
        if (!isV2(t.tick) && tickLen(t.tick) !== 4) continue;
        let total = 0n;
        const checks = [];
        for (const spk of this.scripts(t.tick)) {
          const it = spk === pubSpk && this.publicToken(t.tick);
          if (it && it.validation?.balanceStatus === 'matched') { total += decToRaw(it.overall, Number(it.decimals ?? 18)); checks.push(it.validation); idx.decimals[t.tick] = Number(it.decimals ?? 18); continue; }
          const b = await srv.get(`/v1/brc20/get_current_balance_of_wallet?pkscript=${spk}&ticker=${encodeURIComponent(t.tick)}&network=${net === 'main' ? 'main' : 'test'}`);
          // OPI answers in raw units (×10^decimals); the UniSat cache answers in token units and says so
          if (b) {
            const dec = Number(b.decimals ?? this.app.deploys.find(t.tick)?.dec ?? 18);
            total += b.units === 'decimal' ? decToRaw(b.overall_balance, dec) : BigInt(String(b.overall_balance || '0').split('.')[0]);
            idx.decimals[t.tick] = dec; checks.push(b.validation || { balanceStatus: 'not_checked' });
          }
        }
        idx.tokens[t.tick] = total.toString();
        idx.validation[t.tick] = TokenBook.verdict(checks);
      }
    } catch (e) { idx.err = /fetch|network/i.test(e.message) ? 'Indexer unreachable' : e.message; }
    if (idx.height != null && !Number.isFinite(idx.height)) idx.err = 'Indexer still starting';
    return idx;
  }

  /** One word for a ticker's balance checks: matched | conflict | unavailable | not_checked. */
  static verdict(checks) {
    if (checks.length && checks.every((v) => v.balanceStatus === 'matched')) return 'matched';
    if (checks.some((v) => v.status === 'conflict')) return 'conflict';
    if (checks.some((v) => ['unavailable', 'syncing', 'stale', 'invalid_data'].includes(v.status))) return 'unavailable';
    return 'not_checked';
  }

  /** Settings: point the wallet at a token server ('' = off). */
  async saveIndexer(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error('Enter a URL like https://indexer.example.com');
    if (url) await this.app.platform.requestOrigin(url);
    this.app.tokenServer.setUrl(url);
    await this.refreshIndexer();
    if (url && this.idx?.err) throw new Error(this.idx.err);
  }
}
