// What inscription each small coin carries, read from the transaction that created it (and one hop back
// for inscriptions that moved onto it). Cached per network: a coin's contents never change.
import { INSCRIPTION_MAX, describeEnvelope, envelopesIn } from '../ordinals/envelope.mjs';

export class InscriptionIndex {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.memo = null;
  }

  get key() { return `wren.insc.${this.app.state.net}`; }

  /** Drop the in-memory copy (network switch). */
  reset() { this.memo = null; }

  cache() {
    if (!this.memo) this.memo = this.app.store.getJson(this.key, {}) || {};
    return this.memo;
  }

  set(outpoint, info) {
    const c = this.cache();
    c[outpoint] = info;
    this.app.store.setJson(this.key, c);
  }

  /** { brc20, op, tick, amt, id, received, ready, … } for a coin, or null when not read yet. */
  of(c) { return this.cache()[`${c.txid}:${c.vout}`] || null; }

  /** Like `of`, with the ticker filled in for reservations (the chain only carries their hash). */
  describe(c) {
    let ins = this.of(c);
    if (ins?.brc20 && !ins.tick) {
      const d = this.app.deploys.list().find((x) => x.predeployTxid === c.txid || x.deployTxid === c.txid || x.loc?.txid === c.txid);
      if (d) ins = { ...ins, tick: d.tick };
    }
    return ins;
  }

  /** For each small coin we hold, look at the tx that created it and see whether an inscription was born on it. */
  async readCoins(coins) {
    const cache = this.cache();
    const base = this.app.servers.base();
    const todo = coins.filter((c) => c.sats != null && c.sats <= INSCRIPTION_MAX && !(`${c.txid}:${c.vout}` in cache) && !c.example);
    const byTx = new Map();
    for (const c of todo) { if (!byTx.has(c.txid)) byTx.set(c.txid, []); byTx.get(c.txid).push(c); }
    for (const [txid, list] of byTx) {
      try {
        const r = await fetch(`${base}tx/${txid}`);
        if (!r.ok) continue;
        const tx = await r.json();
        const found = InscriptionIndex.bornIn(tx, txid);
        // One hop back: a coin can hold an inscription that was born in an earlier tx and moved here
        // (e.g. a BRC-20 transfer delivered to us). Follow the first sat of our output to its input.
        for (const c of list) {
          if (found[c.vout]) continue;
          const src = InscriptionIndex.firstSatSource(tx, c.vout);
          if (!src) continue;
          try {
            const pr = await fetch(`${base}tx/${src.txid}`);
            if (!pr.ok) continue;
            const hit = InscriptionIndex.movedFrom(await pr.json(), src);
            if (hit) found[c.vout] = { ...hit, from: src.prevout?.scriptpubkey_address || '', at: tx.status?.block_time ? tx.status.block_time * 1000 : undefined };
          } catch {}
        }
        if (!tx.status?.confirmed && !Object.keys(found).length) continue; // try again later
        for (const c of list) this.set(`${c.txid}:${c.vout}`, found[c.vout] || { brc20: false, unknown: true });
      } catch {}
    }
  }

  /** Inscriptions born in an Esplora tx, by the output their first sat lands on. */
  static bornIn(tx, txid = tx.txid) {
    const found = {};
    let offset = 0, idx = 0;
    for (const v of tx.vin) {
      for (const e of envelopesIn(v.witness || [])) {
        let acc = 0;
        const n = tx.vout.findIndex((o) => (acc += o.value) > offset);
        if (n >= 0 && found[n] == null) found[n] = { ...describeEnvelope(e), id: `${txid}i${idx}`, at: tx.status?.block_time ? tx.status.block_time * 1000 : undefined };
        idx++;
      }
      offset += v.prevout?.value || 0;
    }
    return found;
  }

  /** The input whose first sat becomes the first sat of output `vout`, or null. */
  static firstSatSource(tx, vout) {
    const outStart = tx.vout.slice(0, vout).reduce((a, o) => a + o.value, 0);
    let inStart = 0;
    for (const v of tx.vin) {
      const val = v.prevout?.value || 0;
      if (outStart >= inStart && outStart < inStart + val) return outStart === inStart ? v : null;
      inStart += val;
    }
    return null;
  }

  /** The inscription born on the output `src` spends, as a received one. */
  static movedFrom(ptx, src) {
    const pStart = ptx.vout.slice(0, src.vout).reduce((a, o) => a + o.value, 0);
    let off = 0, k = 0, hit = null;
    for (const v of ptx.vin) {
      for (const e of envelopesIn(v.witness || [])) { if (off === pStart) hit = { ...describeEnvelope(e), id: `${src.txid}i${k}`, received: true }; k++; }
      off += v.prevout?.value || 0;
    }
    return hit;
  }
}
