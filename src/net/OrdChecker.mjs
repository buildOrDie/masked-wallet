// Inscriptions and runes can sit on a coin of ANY size, so bigger coins are checked with ord (ordinals.com)
// before they can be spent. Results are cached for good: what a coin holds never changes.
import { ORD } from '../bitcoin/networks.mjs';
import { INSCRIPTION_MAX } from '../ordinals/envelope.mjs';
import { fetchWithin } from './http.mjs';

export class OrdChecker {
  constructor({ net, store }) {
    this.netOf = net;
    this.store = store;
    this.failed = new Map(); // `${net}:${outpoint}` → do not retry before (ms)
    this.memo = null;
  }

  get key() { return `wren.ord.${this.netOf()}`; }

  cache() {
    const net = this.netOf();
    if (!this.memo || this.memo.net !== net) this.memo = { net, map: this.store.getJson(this.key, {}) || {} };
    return this.memo.map;
  }

  put(outpoint, value) {
    const m = this.cache();
    m[outpoint] = value;
    this.store.setJson(this.key, m);
  }

  /** { ins, runes, at } for a checked coin, or null. */
  of(c) { return this.cache()[`${c.txid}:${c.vout}`] || null; }

  /** Big coins need the check (small ones are treated as inscriptions anyway). */
  needs(c) { return c.sats != null && c.sats > INSCRIPTION_MAX && !c.example; }

  /** On Mainnet an unchecked big coin is not spent until ord has confirmed it is plain bitcoin. */
  unverified(c) { return this.netOf() === 'main' && this.needs(c) && !this.of(c); }

  /** Ask ord about the coins it has not answered for yet; gives up waiting after `waitMs`. @param {any[]} list @param {number} [waitMs] @param {{ force?: boolean }} [o] */
  async check(list, waitMs = 9000, { force = false } = {}) {
    const net = this.netOf();
    // force: also small coins (asked for when someone unlocks one)
    let todo = list.filter((c) => (force ? c.sats != null && !c.example : this.needs(c)) && !this.of(c) && !c.pending && (force || (this.failed.get(`${net}:${c.txid}:${c.vout}`) || 0) < Date.now()));
    if (!todo.length) return;
    const save = (op, j) => {
      const runes = Array.isArray(j.runes) ? j.runes.length : j.runes ? Object.keys(j.runes).length : 0;
      this.put(op, { ins: (j.inscriptions || []).length, runes, at: Date.now() });
    };
    // ord answers many outputs in one request (POST /outputs); one request per coin is the fallback
    for (let i = 0; i < todo.length && i < 400; i += 100) {
      const ops = todo.slice(i, i + 100).map((c) => `${c.txid}:${c.vout}`);
      try {
        const arr = await fetchWithin(10000, `${ORD[net]}/outputs`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(ops) }, (r) => (r.ok ? r.json() : null));
        if (!Array.isArray(arr) || arr.length !== ops.length) break;
        arr.forEach((j, k) => { const op = j?.outpoint || ops[k]; if (j && j.indexed !== false && ops.includes(op)) save(op, j); });
      } catch { break; }
    }
    todo = todo.filter((c) => !this.of(c)).slice(0, 60);
    if (!todo.length) return;
    const one = async (c) => {
      const op = `${c.txid}:${c.vout}`;
      try {
        const j = await fetchWithin(8000, `${ORD[net]}/output/${op}`, { headers: { Accept: 'application/json' } }, (r) => (r.ok ? r.json() : null));
        if (!j) { this.failed.set(`${net}:${op}`, Date.now() + 60000); return; }
        if (j.indexed === false) return; // ord has not reached this block yet
        save(op, j);
      } catch { this.failed.set(`${net}:${op}`, Date.now() + 60000); }
    };
    const run = (async () => { for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one)); })();
    await Promise.race([run, new Promise((r) => setTimeout(r, waitMs))]);
  }
}
