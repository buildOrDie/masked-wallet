// What this browser remembers about tokens, per wallet and network: deploys, mints, transfers and
// transfers the token server may not count yet. Each is a JSON list in localStorage.
import { PREDEPLOY_DELAY } from '../ordinals/brc20.mjs';

class WalletList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app, name, limit = Infinity) {
    this.app = app;
    this.name = name;
    this.limit = limit;
  }
  get key() { return `wren.${this.name}.${this.app.account.id}`; }
  list() { return this.app.store.getJson(this.key, []) || []; }
  save(list) { this.app.store.setJson(this.key, Number.isFinite(this.limit) ? list.slice(0, this.limit) : list); }
  /** Newest first. */
  prepend(item) { this.save([item, ...this.list()]); }

  /** Fill in `height` of records whose transaction has confirmed. */
  async confirm(txidOf, max = Infinity) {
    const list = this.list();
    for (const r of list.filter((x) => !x.height).slice(0, max)) {
      try {
        const res = await fetch(`${this.app.servers.base()}tx/${txidOf(r)}/status`);
        const st = res.ok ? await res.json() : null;
        if (st?.confirmed) r.height = st.block_height;
      } catch {}
    }
    this.save(list);
  }
}

/** BRC2.0 tokens this wallet reserved or deployed: { tick, max, lim, selfMint, salt, hash, pkscript, predeployTxid, predeployId, height, status, deployTxid?, deployId?, loc? } */
export class DeployRegistry extends WalletList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { super(app, 'deploys'); }

  find(tick) { return this.list().find((d) => d.tick === tick); }

  update(tick, patch) { this.save(this.list().map((d) => (d.tick === tick ? { ...d, ...patch } : d))); }

  /** Where a deploy is: { key: wait | ready | deployed, text }. */
  stage(d, tip) {
    if (d.status === 'deployed') return { key: 'deployed', text: 'Deployed' };
    if (!d.height) return { key: 'wait', text: 'Waiting for the reservation to confirm…' };
    const left = d.height + PREDEPLOY_DELAY - (tip || 0);
    if (left > 0) return { key: 'wait', text: `Reserved in block ${d.height.toLocaleString()} · ${left} more block${left === 1 ? '' : 's'} to wait` };
    return { key: 'ready', text: 'Ready to deploy' };
  }

  /** Reservation coins in the wallet with no record in this browser (lost storage, other device). */
  orphans() {
    const list = this.list();
    return this.app.coins.shieldedThenPublic().filter((c) => {
      const i = this.app.inscriptions.of(c);
      if (!i?.brc20 || i.op !== 'predeploy') return false;
      return !list.some((d) => d.predeployTxid === c.txid || d.deployTxid === c.txid || d.loc?.txid === c.txid);
    });
  }

  refresh() { return this.confirm((d) => d.predeployTxid); }
}

/** Mints made here: { tick, amt, revealTxid, revealOut, pkscript, inscriptionId, to, recipient, at, height } */
export class MintLog extends WalletList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { super(app, 'mints', 200); }
  refresh() { return this.confirm((m) => m.revealTxid, 20); }
}

/** Token sends, moves and Shielded listings: { tick, amt, to, toKind, toSpk, toOwn, fromSpk, commitTxid, revealTxid, sendTxid, listing?, at } */
export class TransferLog extends WalletList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { super(app, 'transfers', 300); }
  /** Record a delivered token send (three transactions: commit, inscribe, deliver). */
  addSend(b) {
    this.prepend({ tick: b.tick, amt: b.amt, to: b.to, toKind: b.toKind, toSpk: b.toSpk, toOwn: b.toOwn, fromSpk: b.fromSpk, commitTxid: b.commitTxid, revealTxid: b.revealTxid, sendTxid: b.sendTxid, at: Date.now() });
  }
}

/**
 * Transfers made from the Public address that the token server may not count yet (it only sees them once
 * they confirm). They are taken off "available" until the server catches up.
 */
export class PendingTransfers extends WalletList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { super(app, 'pendtr'); }

  add(kind, tick, amt, txid) {
    const it = this.app.tokens.publicToken(tick);
    this.save([...this.list(), { kind, tick, amt: Number(amt), txid, at: Date.now(), baseAvail: it ? Number(it.available) : null }]);
  }

  /** Drop entries the token server already reflects (its available balance went down), or that are old. */
  prune() {
    const tokens = this.app.tokens;
    const keep = this.list().filter((p) => {
      if (Date.now() - p.at > 3 * 864e5) return false;
      const it = tokens.publicToken(p.tick), w = tokens.publicTokens();
      if (it && p.baseAvail != null && Number(it.available) <= p.baseAvail - p.amt + 1e-9) return false;
      // confirmed a while before the server's last answer: the server has it by now
      if (p.confirmedAt && w && w.at > p.confirmedAt + 120000) return false;
      return true;
    });
    this.save(keep);
    return keep;
  }

  async check() {
    const list = this.list(); let changed = false;
    for (const p of list) {
      if (p.confirmedAt) continue;
      try {
        const r = await fetch(`${this.app.servers.base()}tx/${p.txid}/status`);
        const j = r.ok ? await r.json() : null;
        if (j?.confirmed) { p.confirmedAt = Date.now(); changed = true; }
      } catch {}
    }
    if (changed) this.save(list);
    this.prune();
  }
}
