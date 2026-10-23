// Offline send: a payment signed without internet, carried as a QR code or text (a chat message, Bitchat,
// a note) and broadcast by whichever device gets online first. Two lists per wallet:
//   - mine: payments this wallet signed. Their coins are reserved, so they are never spent twice from here.
//   - relay: payments someone handed us to send. Once broadcast, our own Shielded outputs are read back.
// A payment is not final until it confirms: the sender could still spend the same coins elsewhere first.
import { toHex } from '../core/bytes.mjs';
import { short } from '../core/format.mjs';
import { findTxHex, parseTx } from '../bitcoin/parseTx.mjs';

/**
 * @typedef {object} OfflinePayment
 * @property {string} txid
 * @property {string} hex
 * @property {boolean} mine          signed by this wallet
 * @property {number} amount          sats to the recipient (mine), or all outputs (relay)
 * @property {string} [recipient]
 * @property {string[]} [spent]       coin keys reserved by it (mine)
 * @property {string[]} outpoints     inputs, `txid:vout`
 * @property {number} created
 * @property {'waiting'|'sent'|'failed'} state
 * @property {string} [error]
 * @property {number} [sentAt]
 * @property {boolean} [read]        our outputs were read back after sending
 */

/** Errors meaning the network already has this transaction. */
const KNOWN = /already in block|txn-already-known|txn-already-in-mempool|already known|transaction already exists/i;
/** Errors meaning its coins are gone (spent by another transaction). */
const SPENT = /missingorspent|missing inputs|bad-txns-inputs|txn-mempool-conflict|insufficient fee.*replace/i;

export class OfflinePayments {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.flushing = false;
  }

  get account() { return this.app.account; }
  get key() { return `wren.offline.${this.account.id}`; }

  /** @returns {OfflinePayment[]} newest first */
  list() { return this.app.store.getJson(this.key, []) || []; }
  save(list) { this.app.store.setJson(this.key, list.slice(0, 100)); }
  get(txid) { return this.list().find((p) => p.txid === txid) || null; }
  update(txid, patch) { this.save(this.list().map((p) => (p.txid === txid ? { ...p, ...patch } : p))); }
  waiting() { return this.list().filter((p) => p.state === 'waiting'); }

  /** Coins held back by this wallet's own unsent payments: never picked again. */
  reserved() { return new Set(this.list().filter((p) => p.mine && p.state === 'waiting').flatMap((p) => p.spent || [])); }

  static online() { return globalThis.navigator?.onLine !== false; }

  /** Keep a payment this wallet just signed (from TxBuilder.send) instead of broadcasting it now. */
  keepSigned(built) {
    const tx = parseTx(built.hex);
    if (tx.txid !== built.txid) throw new Error('Signed payment does not match.');
    /** @type {OfflinePayment} */
    const p = {
      txid: built.txid, hex: built.hex, mine: true, amount: built.amount, recipient: built.recipient,
      spent: [built.coin.key], outpoints: tx.inputs.map((x) => `${x.txid}:${x.vout}`), created: Date.now(), state: 'waiting',
    };
    this.save([p, ...this.list().filter((x) => x.txid !== p.txid)]);
    return p;
  }

  /**
   * A signed payment someone handed us (pasted text or a scanned QR). Checked, then queued to send.
   * @returns {{ payment: OfflinePayment, toPublic: number, isNew: boolean }}
   */
  addFromText(text) {
    const hex = findTxHex(text);
    if (!hex) throw new Error('No signed payment found. Paste the whole text you received.');
    const tx = parseTx(hex);
    const have = this.get(tx.txid);
    const pubSpk = this.account.pubSpk();
    const toPublic = tx.outputs.filter((o) => pubSpk && toHex(o.script) === pubSpk).reduce((s, o) => s + o.value, 0);
    if (have) return { payment: have, toPublic, isNew: false };
    /** @type {OfflinePayment} */
    const p = {
      txid: tx.txid, hex, mine: false, amount: tx.outputs.reduce((s, o) => s + o.value, 0),
      outpoints: tx.inputs.map((x) => `${x.txid}:${x.vout}`), created: Date.now(), state: 'waiting',
    };
    this.save([p, ...this.list()]);
    return { payment: p, toPublic, isNew: true };
  }

  remove(txid) { this.save(this.list().filter((p) => p.txid !== txid)); }

  /** Send every waiting payment if this device is online. Safe to call often. */
  async flush() {
    if (this.flushing || !OfflinePayments.online() || !this.account.keys) return 0;
    const todo = this.waiting();
    if (!todo.length) return 0;
    this.flushing = true;
    let sent = 0;
    try {
      for (const p of todo) {
        try {
          await this.app.broadcast(p.hex);
          this.markSent(p); sent++;
        } catch (e) {
          const m = String(e?.message || e);
          if (KNOWN.test(m)) { this.markSent(p); sent++; continue; }
          if (SPENT.test(m)) { this.update(p.txid, { state: 'failed', error: 'Its coins were already spent by another transaction. It will not arrive.' }); continue; }
          this.update(p.txid, { error: /fetch|network|timeout/i.test(m) ? 'Waiting for a connection…' : m.slice(0, 200) });
        }
      }
    } finally { this.flushing = false; }
    if (sent) this.app.toast(`${sent} offline payment${sent === 1 ? '' : 's'} sent to the network`);
    this.app.render();
    // then read back what is ours (change, or a Shielded payment to us)
    for (const p of this.list().filter((x) => x.state === 'sent' && !x.read)) {
      await this.app.scanner.ingestTx(p.txid).catch(() => {});
      this.update(p.txid, { read: true });
    }
    this.app.render();
    return sent;
  }

  markSent(p) {
    this.update(p.txid, { state: 'sent', error: '', sentAt: Date.now() });
    if (p.mine) this.app.coins.remove(p.spent || []);
  }

  /** The text to copy or paste into a chat (Bitchat, Signal, …): a line of context and the signed payment. */
  static shareText(p, unit = 'BTC') {
    const amt = (p.amount / 1e8).toFixed(8).replace(/\.?0+$/, '');
    return `MASKED signed payment · ${amt} ${unit}${p.recipient ? ` to ${short(p.recipient, 8)}` : ''}\nOpen MASKED → Receive → Send a signed payment, or broadcast at mempool.space/tx/push:\n${p.hex}`;
  }
}
