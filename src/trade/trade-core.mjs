// MASKED private trading: trade addresses derived from the Shielded spend key, and the transactions
// that move coins between Shielded and a trade address. Pure functions (no wallet state), shared by the
// wallet and its tests.
//
//   t_n  = H_tag("MASKED/trade", b_spend || n)        (n = 0, 1, 2 …)
//   key  = b_spend + t_n,   P_n = key·G
// P_n is the taproot output key itself (no extra taproot tweak, like a silent-payment output), so the
// address is a plain bc1p… that is not linked to the Public address or to the Shielded (sp1…) address.
// Only the spend key can derive it: a scan key alone (or a scan server) never sees trade addresses.
import * as btc from '@scure/btc-signer';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import * as sp from '../crypto/sp-core.mjs';

const { toHex, fromHex, util } = sp;
const { b2n, n2b, mulG } = util;
export const TRADE_TAG = 'MASKED/trade';
export const TRADE_PADDING = 600;  // the small coin a purchase lands in (like "Make a small coin" on Public)
export const TRADE_DUST = 330;
export const INSCRIPTION_MAX = 1000; // coins this small are treated as inscription carriers and never merged
const RBF_SEQ = 0xfffffffd;
const NETS = { main: btc.NETWORK, signet: btc.TEST_NETWORK };
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const vsizeOf = (inputs, outputs) => Math.ceil(10.5 + 57.5 * inputs + 43 * outputs);

/** Trade address n for a wallet's spend key (bigint). */
export function tradeKey(bSpend, n, net = 'main') {
  if (typeof bSpend !== 'bigint' || bSpend <= 0n) throw new Error('Trading needs the spend key (not available in watch-only wallets).');
  if (!Number.isInteger(n) || n < 0) throw new Error('Bad trade address index.');
  const t = util.mod(b2n(sp.taggedHash(TRADE_TAG, n2b(bSpend), u32le(n))));
  const d = util.mod(bSpend + t);
  const x = util.xOnly(mulG(d));
  return { index: n, outputX: toHex(x), spk: toHex(btc.OutScript.encode({ type: 'tr', pubkey: x })), address: btc.Address(NETS[net]).encode({ type: 'tr', pubkey: x }), priv: toHex(n2b(d)) };
}

/** Private key → even-Y form for BIP-340 signing. */
function evenPriv(privHex) {
  let d = b2n(fromHex(privHex));
  if (mulG(d).toRawBytes(true)[0] === 3) d = secp256k1.CURVE.n - d;
  return n2b(d);
}

/**
 * Sign taproot key-path inputs whose output key IS the key (trade addresses, silent-payment coins).
 * tx: a @scure/btc-signer Transaction with witnessUtxo on every input.
 * list: [{ i, priv: hex, sighash?: number }]   (sighash 0 / undefined = SIGHASH_DEFAULT)
 */
export function signKeyPathInputs(tx, list, { finalize = true } = {}) {
  const scripts = [], amounts = [];
  for (let j = 0; j < tx.inputsLength; j++) {
    const w = tx.getInput(j).witnessUtxo;
    if (!w) throw new Error(`Input ${j} has no amount information.`);
    scripts.push(w.script); amounts.push(w.amount);
  }
  for (const { i, priv, sighash } of list) {
    const sh = sighash || 0;
    const w = tx.getInput(i).witnessUtxo;
    const d = evenPriv(priv);
    if (toHex(w.script.slice(2)) !== toHex(schnorr.getPublicKey(d))) throw new Error(`Input ${i} is not paid to this key.`);
    const msg = tx.preimageWitnessV1(i, scripts, sh, amounts);
    const sig = schnorr.sign(msg, d);
    const full = sh === 0 ? sig : Uint8Array.from([...sig, sh]);
    tx.updateInput(i, finalize ? { finalScriptWitness: [full] } : { tapKeySig: full }, true);
  }
  return tx;
}

/**
 * Pay from Shielded coins (silent-payment outputs we hold) to plain outputs, change back to Shielded.
 * coins: [{ txid, vout, value, priv }] spendable Shielded coins
 * outputs: [{ script: Uint8Array, value }]
 * changeAddress: our own sp1… address (silent payment change)
 */
export function buildShieldedPay({ coins, outputs, changeAddress, feeRate }) {
  if (!(feeRate > 0)) throw new Error('Fee rate must be above 0.');
  const need = outputs.reduce((a, o) => a + o.value, 0);
  if (outputs.some((o) => o.value < TRADE_DUST)) throw new Error(`Each amount must be at least ${TRADE_DUST} sats.`);
  const pool = [...coins].sort((a, b) => b.value - a.value);
  const pick = [];
  let have = 0, fee = 0, change = 0, done = false;
  for (const c of pool) {
    pick.push(c); have += c.value;
    const feeWith = Math.ceil(vsizeOf(pick.length, outputs.length + 1) * feeRate), feeWithout = Math.ceil(vsizeOf(pick.length, outputs.length) * feeRate);
    if (have - need - feeWith >= TRADE_DUST) { fee = feeWith; change = have - need - feeWith; done = true; break; }
    if (have - need - feeWithout >= 0) { fee = have - need; change = 0; done = true; break; }
  }
  if (!done) {
    const est = Math.ceil(vsizeOf(Math.max(1, pool.length), outputs.length + 1) * feeRate);
    throw Object.assign(new Error(`Not enough Shielded bitcoin. This needs about ${need + est} sats.`), { short: need + est - have });
  }
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const c of pick) tx.addInput({ txid: c.txid, index: c.vout, sequence: RBF_SEQ, witnessUtxo: { script: btc.OutScript.encode({ type: 'tr', pubkey: util.xOnly(mulG(b2n(fromHex(c.priv)))) }), amount: BigInt(c.value) } });
  for (const o of outputs) tx.addOutput({ script: o.script, amount: BigInt(o.value) });
  if (change) {
    const out = sp.createOutputs(pick.map((c) => ({ txid: c.txid, vout: c.vout, privKey: c.priv, taproot: true })), pick.map((c) => ({ txid: c.txid, vout: c.vout })), [changeAddress])[0];
    tx.addOutput({ script: btc.OutScript.encode({ type: 'tr', pubkey: fromHex(out.output) }), amount: BigInt(change) });
  }
  signKeyPathInputs(tx, pick.map((c, i) => ({ i, priv: c.priv })));
  return { hex: tx.hex, txid: tx.id, fee, change, spent: pick, outputs: outputs.map((o, vout) => ({ txid: tx.id, vout, value: o.value })) };
}

/**
 * Move everything on a trade address back into Shielded, as silent payments to our own sp1… address.
 * coins: [{ txid, vout, value, priv, keep }]  keep = carries (or may carry) an inscription: it gets its own
 *        output of exactly the same value, in the same order, so every inscription stays on its own coin.
 * Plain coins are merged into one output. extra: Shielded coins that can top up the fee when needed.
 */
export function buildReturnToShielded({ coins, extra = [], shieldAddress, feeRate }) {
  if (!(feeRate > 0)) throw new Error('Fee rate must be above 0.');
  if (!coins.length) throw new Error('Your trade address is empty.');
  const keep = coins.filter((c) => c.keep), plain = coins.filter((c) => !c.keep);
  const ins = [...keep, ...plain];
  let plainSum = plain.reduce((a, c) => a + c.value, 0);
  const feeFor = (nIn, nOut) => Math.ceil(vsizeOf(nIn, nOut) * feeRate);
  let fee = feeFor(ins.length, keep.length + 1);
  if (plainSum - fee < TRADE_DUST) {
    // not enough plain bitcoin on the trade address for the fee: add one Shielded coin
    const top = [...extra].sort((a, b) => a.value - b.value).find((c) => plainSum + c.value - feeFor(ins.length + 1, keep.length + 1) >= TRADE_DUST);
    if (!top) throw new Error('Not enough bitcoin for the network fee. Add a little BTC to Shielded first.');
    ins.push(top); plainSum += top.value; fee = feeFor(ins.length, keep.length + 1);
  }
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const c of ins) tx.addInput({ txid: c.txid, index: c.vout, sequence: RBF_SEQ, witnessUtxo: { script: btc.OutScript.encode({ type: 'tr', pubkey: util.xOnly(mulG(b2n(fromHex(c.priv)))) }), amount: BigInt(c.value) } });
  const outs = sp.createOutputs(ins.map((c) => ({ txid: c.txid, vout: c.vout, privKey: c.priv, taproot: true })), ins.map((c) => ({ txid: c.txid, vout: c.vout })), Array(keep.length + 1).fill(shieldAddress));
  const values = [...keep.map((c) => c.value), plainSum - fee];
  values.forEach((v, k) => tx.addOutput({ script: btc.OutScript.encode({ type: 'tr', pubkey: fromHex(outs[k].output) }), amount: BigInt(v) }));
  signKeyPathInputs(tx, ins.map((c, i) => ({ i, priv: c.priv })));
  return { hex: tx.hex, txid: tx.id, fee, spent: ins, kept: keep.length, value: plainSum - fee };
}
