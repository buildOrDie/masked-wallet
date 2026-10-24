// Silent airdrop: one transaction that pays the same amount to many Shielded (sp1…) addresses. Every
// recipient gets an ordinary silent-payment output: on-chain nobody can tell who was paid. (The transaction
// itself does look like a batch payout: many outputs of the same size.)
import * as sp from '../crypto/sp-core.mjs';
import { fmtBtc } from '../core/format.mjs';
import { RawTransaction } from '../bitcoin/RawTransaction.mjs';
import { p2trScript } from '../bitcoin/taproot.mjs';
import { inputOf } from './TxBuilder.mjs';

/** Most recipients in one airdrop (a transaction stays far below the standard size limit). */
export const MAX_RECIPIENTS = 500;
/** Smallest amount per person: below this a taproot output is dust and would not relay. */
export const MIN_EACH = 330;
const CHANGE_MIN = 330;
// virtual sizes (vB): overhead, a key-path taproot input, a taproot output
const VB_BASE = 10.5, VB_IN = 57.5, VB_OUT = 43;

/** Fee of a transaction with these many inputs and outputs. */
export const dropFee = (inputs, outputs, rate) => Math.ceil((VB_BASE + VB_IN * inputs + VB_OUT * outputs) * rate);

/**
 * Every Shielded address in some pasted text (a whole X thread works), for one network.
 * @param {string} text
 * @param {string} net  'main' or 'signet'
 * @param {string} [own] the wallet's own Shielded address, left out
 * @returns {{ list: string[], dupes: number, wrongNet: number, invalid: number, own: boolean }}
 */
export function extractRecipients(text, net, own = '') {
  const found = String(text || '').match(/\bt?sp1[02-9ac-hj-np-z]{100,}/gi) || [];
  const seen = new Set(), list = [];
  let dupes = 0, wrongNet = 0, invalid = 0, self = false;
  const ownL = own.toLowerCase();
  for (const raw of found) {
    const a = raw.toLowerCase();
    let d;
    try { d = sp.decodeAddress(a); } catch { invalid++; continue; }
    if ((d.network === 'main') !== (net === 'main')) { wrongNet++; continue; }
    if (a === ownL) { self = true; continue; }
    if (seen.has(a)) { dupes++; continue; }
    seen.add(a);
    list.push(a);
  }
  return { list, dupes, wrongNet, invalid, own: self };
}

export class Airdrop {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  get account() { return this.app.account; }
  get coins() { return this.app.coins; }

  /** What the form shows while typing: recipients, total and an estimated fee (null when not ready). */
  preview({ text, each, from, rate }) {
    const r = extractRecipients(text, this.account.net, this.account.shieldAddr());
    const n = r.list.length;
    const total = n * (each || 0);
    const fee = n ? dropFee(1, n + 1, rate) : 0;
    return { ...r, n, total, fee, available: this.coins.spendable(from).reduce((s, c) => s + c.sats, 0) };
  }

  /**
   * Build and sign the airdrop (nothing is broadcast here).
   * @param {{ from: string, text: string, each: number, rate: number }} o  from: 'public' | 'shielded'
   */
  async build({ from, text, each, rate }) {
    this.app.builder.requireSigner('send');
    await this.coins.ensureOrd(from);
    const unit = this.account.unit;
    const { list } = extractRecipients(text, this.account.net, this.account.shieldAddr());
    if (!list.length) throw new Error('No Shielded addresses found. Paste addresses that start with ' + (this.account.net === 'main' ? 'sp1…' : 'tsp1…'));
    if (list.length > MAX_RECIPIENTS) throw new Error(`Up to ${MAX_RECIPIENTS} people per airdrop. You pasted ${list.length}; split the list.`);
    if (!Number.isSafeInteger(each) || each < MIN_EACH) throw new Error(`Each person needs at least ${MIN_EACH} sats.`);
    const total = list.length * each;

    // biggest coins first, until the airdrop, its fee and a change output are covered
    const pool = [...this.coins.spendable(from)].sort((a, b) => b.sats - a.sats);
    const picked = [];
    let sum = 0, fee = 0;
    for (const c of pool) {
      picked.push(c); sum += c.sats;
      fee = dropFee(picked.length, list.length + 1, rate);
      if (sum >= total + fee) break;
    }
    if (sum < total + dropFee(picked.length, list.length, rate)) {
      const label = from === 'shielded' ? 'Shielded' : 'Public';
      throw new Error(`Not enough ${label} balance: this airdrop needs ${fmtBtc(total + dropFee(Math.max(1, picked.length), list.length + 1, rate))} ${unit}.`);
    }
    let change = sum - total - fee;
    if (change < CHANGE_MIN) { fee = sum - total; change = 0; }

    // silent outputs: every input key takes part; Shielded change goes to our own change address
    const keys = picked.map((c) => ({ txid: c.txid, vout: c.vout, privKey: this.app.builder.privOf(c), taproot: true }));
    const outpoints = picked.map((c) => ({ txid: c.txid, vout: c.vout }));
    const changeAddr = this.account.changeAddr();
    const silentTo = [...list, ...(change && from === 'shielded' ? [changeAddr] : [])];
    const derived = sp.createOutputs(keys, outpoints, silentTo);
    const take = (addr) => p2trScript(derived.splice(derived.findIndex((d) => d.address === addr), 1)[0].output);
    const outputs = list.map((a) => ({ value: each, script: take(a) }));
    if (change) outputs.push({ value: change, script: from === 'shielded' ? take(changeAddr) : p2trScript(picked[0].output) });

    const tx = new RawTransaction({ inputs: picked.map(inputOf), outputs });
    const witnesses = keys.map((k, i) => [tx.signKeyPath(i, k.privKey)]);
    const hex = tx.toHex(witnesses);
    return { hex, txid: tx.txid, from, count: list.length, each, total, fee, change, spent: picked.map((c) => c.key), recipients: list };
  }

  /** A ready X post about the airdrop. */
  static shareUrl(count) {
    const text = `Just sent a silent airdrop to ${count} Shielded address${count === 1 ? '' : 'es'} with MASKED 🎭\n\nIf you replied with your sp1, check your Shielded balance 👀\n\nmaskedwallet.com`;
    return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  }
}
