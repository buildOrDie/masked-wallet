// The wallet's coins: Shielded (silent-payment outputs found by scanning), Public (the BIP 86 address) and,
// while trading privately, the trade address. Coins that hold or may hold an inscription are protected:
// never picked for sends, fees, commits or anchors.
import { fmtBtc, sumSats } from '../core/format.mjs';
import { readJson } from '../net/http.mjs';
import { INSCRIPTION_MAX, estimateSimpleSend } from '../ordinals/envelope.mjs';

/** Smallest coin that covers `need`. */
export const pickCoin = (list, need) => [...list].sort((a, b) => a.sats - b.sats).find((c) => c.sats >= need) || null;

export class CoinStore {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    /** Shielded coins: { key, txid, vout, sats, output, tweak, label, pending, example?, listed? } */
    this.shielded = [];
    /** Public coins: { key, kind: 'funding', txid, vout, sats, output, privKey, address, pending } */
    this.public = [];
    /** Coins on the private trade address (read when a trading request needs them). */
    this.trade = [];
    this.publicAt = 0;
    this.ordBusy = false;
    this.ordAt = 0;
  }

  get account() { return this.app.account; }
  get ord() { return this.app.ord; }
  get store() { return this.app.store; }

  get shieldedKey() { return `wren.coins.${this.account.id}`; }
  get publicKey() { return `wren.fund.${this.account.id}`; }
  get locksKey() { return `wren.locks.${this.account.id}`; }
  get freeKey() { return `wren.free.${this.account.id}`; }

  /** Both sides; the order decides list and display order, so both orders exist. */
  publicThenShielded() { return [...this.public, ...this.shielded]; }
  shieldedThenPublic() { return [...this.shielded, ...this.public]; }

  // ---- persistence ----
  load() {
    this.shielded = this.store.getJson(this.shieldedKey, []) || [];
    this.loadPublic();
  }

  clear() { this.shielded = []; this.public = []; }

  save() { this.store.setJson(this.shieldedKey, this.shielded.filter((c) => !c.example)); }

  /** The last known Public coins, so the balance shows the moment the wallet opens (refreshed right after). */
  loadPublic() {
    this.publicAt = 0;
    const f = this.account.funding();
    const list = this.store.getJson(this.publicKey, []);
    try {
      this.public = f ? list.filter((c) => c.address === f.address).map((c) => ({ ...c, output: f.outputX, privKey: f.outputPriv })) : [];
    } catch { this.public = []; }
  }

  savePublic() { this.store.setJson(this.publicKey, this.public.map(({ privKey, ...c }) => c)); }

  forgetShielded() {
    this.shielded = [];
    this.store.remove(this.shieldedKey);
  }

  /** Take spent coins off the lists (right after a broadcast). */
  remove(keys) {
    this.shielded = this.shielded.filter((c) => !keys.includes(c.key));
    this.public = this.public.filter((c) => !keys.includes(c.key));
    this.save();
  }

  // ---- locks and protection ----
  locks() { return new Set(this.store.getJson(this.locksKey, [])); }

  toggleLock(op) {
    const l = this.locks();
    if (l.has(op)) l.delete(op); else l.add(op);
    this.store.setJson(this.locksKey, [...l]);
  }

  /** Small coins (unless unlocked after an ord check), coins ord found something on, coins with a known inscription. */
  autoProtected(c) {
    const o = this.ord.of(c);
    if (o && (o.ins || o.runes)) return true;
    const i = this.app.inscriptions.of(c);
    if (i && !i.unknown) return true;
    if (c.sats != null && c.sats <= INSCRIPTION_MAX) return !(this.freed().has(`${c.txid}:${c.vout}`) && o && this.safeToFree(c));
    return false;
  }

  // ---- unlocking a small coin (a 500-sat test payment, say) ----
  freed() { return new Set(this.store.getJson(this.freeKey, []) || []); }

  /** Never unlock a small Shielded coin that holds LEAF (its LEAF moves only with that coin). */
  safeToFree(c) {
    if (!c.tweak) return true;
    const leaf = this.app.leaf;
    if (!leaf) return true;
    const a = this.account.codec.trAddress(c.output);
    return !leaf.seen().has(a) && !leaf.sh.some((s) => s.address === a);
  }

  /**
   * Make a small coin spendable: only after ord has checked it holds no inscription or rune.
   * @returns {Promise<'freed'|'inscription'|'leaf'|'unchecked'>}
   */
  async unlockSmall(c) {
    if (!this.safeToFree(c)) return 'leaf';
    await this.ord.check([c], 12000, { force: true });
    const o = this.ord.of(c);
    if (!o) return 'unchecked';
    if (o.ins || o.runes) return 'inscription';
    const i = this.app.inscriptions.of(c);
    if (i && !i.unknown) return 'inscription';
    this.store.setJson(this.freeKey, [...new Set([...this.freed(), `${c.txid}:${c.vout}`])]);
    return 'freed';
  }
  relockSmall(op) { const f = this.freed(); f.delete(op); this.store.setJson(this.freeKey, [...f]); }

  isProtected(c) { return this.autoProtected(c) || this.locks().has(`${c.txid}:${c.vout}`); }

  /** Free to spend: not protected, and checked by ord on Mainnet. */
  spendableOf(list) {
    const held = this.app.offline?.reserved() || new Set(); // coins in a signed payment not sent yet
    return list.filter((c) => c.sats != null && !held.has(c.key) && !this.isProtected(c) && !this.ord.unverified(c));
  }

  publicSpendable() { return this.account.canSign ? this.spendableOf(this.public) : []; }
  shieldedSpendable() { return this.account.canSign ? this.spendableOf(this.shielded.filter((c) => !c.example)) : []; }
  tradeSpendable() { return this.trade.filter((c) => c.sats > INSCRIPTION_MAX && !this.isProtected(c) && !this.ord.unverified(c)); }

  /** Spendable coins of one side: 'public' | 'shielded' | 'trade'. */
  spendable(from) {
    if (from === 'shielded') return this.shieldedSpendable();
    if (from === 'trade') return this.tradeSpendable();
    return this.publicSpendable();
  }

  /** The pool ord has to look at before spending from a side. */
  pool(from) {
    if (from === 'shielded') return this.shielded;
    if (from === 'public') return this.public;
    if (from === 'trade') return this.trade;
    return this.publicThenShielded();
  }

  /** Called before building anything that spends coins. */
  async ensureOrd(from) {
    const pool = this.pool(from);
    if (this.account.net !== 'main') { this.ord.check(pool); return; } // test networks: check in the background, never block
    await this.ord.check(pool);
    if (!this.spendable(from || 'public').length && pool.some((c) => this.ord.unverified(c)))
      throw new Error('Checking your coins for inscriptions with ord… try again in a few seconds. (ordinals.com did not answer.)');
  }

  /** "0.0017" for the pay-from pickers; "…" while ord is still checking big coins (and it checks them). */
  spendLabel(from) {
    const n = sumSats(this.spendable(from));
    const pool = from === 'shielded' ? this.shielded : this.public;
    if (!n && pool.some((c) => this.ord.unverified(c))) {
      if (!this.ordBusy && Date.now() - this.ordAt > 15000) {
        this.ordBusy = true; this.ordAt = Date.now();
        this.ord.check(pool, 20000).finally(() => { this.ordBusy = false; this.app.render(); });
      }
      return '…';
    }
    if (!n && from === 'public' && sumSats(this.public)) return '0 free'; // every coin holds an inscription
    return fmtBtc(n);
  }

  /** Most that can be sent from one side: every free coin in one transaction, less its fee. */
  maxSendable(from, feeRate) {
    const list = this.spendable(from);
    if (!list.length) return 0;
    const all = sumSats(list) - estimateSimpleSend({ inputs: list.length, outputs: 1, feeRate });
    const big = Math.max(...list.map((c) => c.sats)) - estimateSimpleSend({ outputs: 1, feeRate });
    return Math.max(0, all, big);
  }

  /** A coin we hold, with its private key (Shielded ones marked `shielded`). */
  held(txid, vout) {
    const f = this.public.find((c) => c.txid === txid && c.vout === vout);
    if (f) return f;
    const c = this.shielded.find((x) => x.txid === txid && x.vout === vout);
    return c ? { ...c, privKey: this.account.keys.outputPriv(c.tweak), shielded: true } : null;
  }

  // ---- chain ----
  async syncPublic() {
    const f = this.account.funding();
    if (!f) return [];
    const utxos = await readJson(await fetch(`${this.app.servers.base()}address/${f.address}/utxo`), 'Balance lookup');
    if (!Array.isArray(utxos)) throw new Error('Balance lookup returned an unexpected reply.');
    this.public = utxos.map((u) => ({
      key: `fund:${u.txid}:${u.vout}`, kind: 'funding', txid: u.txid, vout: u.vout, sats: u.value,
      output: f.outputX, privKey: f.outputPriv, address: f.address, pending: !u.status?.confirmed,
    }));
    this.publicAt = Date.now();
    this.savePublic();
    return this.public;
  }

  /** Shielded coins spent elsewhere (another device, a sale) leave the list. */
  async dropSpent() {
    const keep = [];
    for (const c of this.shielded) {
      if (c.example) { keep.push(c); continue; }
      try {
        const res = await fetch(`${this.app.servers.base()}tx/${c.txid}/outspend/${c.vout}`);
        const j = res.ok ? await res.json() : null;
        if (j?.spent) continue;
      } catch {}
      keep.push(c);
    }
    this.shielded = keep;
    this.save();
  }
}
