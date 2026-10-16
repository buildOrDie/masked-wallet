// A version-2 segwit transaction built by hand: serialization, txid and taproot (BIP 341) signatures.
// Inputs are { txid, vout, value, scriptPubKey, sequence? }, outputs are { value, script }.
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import * as sp from '../crypto/sp-core.mjs';
import { concat, fromHex, rev, sha256d, toHex, u8, u32le, u64le, varint } from '../core/bytes.mjs';
import { normalizeSchnorrPriv } from './taproot.mjs';

const SEQ_RBF = 0xfffffffd;
const SEQ_FINAL = 0xffffffff;

/** Replace-by-fee for new transactions (Settings → RBF). On by default. */
export class TxPolicy {
  static rbf = true;
  static KEY = 'wren.rbf';
  static load(store) { TxPolicy.rbf = store.get(TxPolicy.KEY) !== '0'; }
  static save(store, on) { TxPolicy.rbf = !!on; store.set(TxPolicy.KEY, on ? '1' : '0'); }
}

export class RawTransaction {
  constructor({ inputs = [], outputs = [] } = {}) {
    this.inputs = inputs;
    this.outputs = outputs;
  }

  static sequence(input) {
    return input.sequence ?? (TxPolicy.rbf ? SEQ_RBF : SEQ_FINAL);
  }

  /** Hex serialization; with witnesses it is the segwit form. */
  toHex(witnesses = []) {
    const hasWitness = witnesses.some((w) => w?.length);
    const vin = this.inputs.map((i) => concat(rev(fromHex(i.txid)), u32le(i.vout), varint(i.script?.length || 0), i.script || new Uint8Array(), u32le(RawTransaction.sequence(i))));
    const vout = this.outputs.map((o) => concat(u64le(o.value), varint(o.script.length), o.script));
    const marker = hasWitness ? concat(u8(0), u8(1)) : new Uint8Array();
    const base = concat(u32le(2), marker, varint(this.inputs.length), ...vin, varint(this.outputs.length), ...vout);
    const wit = hasWitness
      ? concat(...this.inputs.map((_, i) => {
        const stack = witnesses[i] || [];
        return concat(varint(stack.length), ...stack.map((x) => concat(varint(x.length), x)));
      }))
      : new Uint8Array();
    return toHex(concat(base, wit, u32le(0)));
  }

  /** The txid hashes the serialization without witnesses (the full segwit form gives the wtxid). */
  get txid() {
    return RawTransaction.txidOfHex(this.toHex());
  }

  static txidOfHex(rawHex) {
    return toHex(rev(sha256d(fromHex(rawHex))));
  }

  /** BIP 341 signature hash, SIGHASH_DEFAULT; `scriptPath` = { leafHash } for a script-path spend. */
  sighash(inputIndex, scriptPath = null) {
    const { inputs, outputs } = this;
    const prevouts = concat(...inputs.map((i) => concat(rev(fromHex(i.txid)), u32le(i.vout))));
    const amounts = concat(...inputs.map((i) => u64le(i.value)));
    const scriptPubKeys = concat(...inputs.map((i) => concat(varint(i.scriptPubKey.length), i.scriptPubKey)));
    const sequences = concat(...inputs.map((i) => u32le(RawTransaction.sequence(i))));
    const outs = concat(...outputs.map((o) => concat(u64le(o.value), varint(o.script.length), o.script)));
    const spendType = scriptPath ? 2 : 0;
    const common = concat(
      u8(0), u32le(2), u32le(0), sha256(prevouts), sha256(amounts),
      sha256(scriptPubKeys), sha256(sequences), sha256(outs), u8(spendType), u32le(inputIndex),
    );
    const ext = scriptPath ? concat(scriptPath.leafHash, u8(0), u32le(0xffffffff)) : new Uint8Array();
    return sp.taggedHash('TapSighash', u8(0), common, ext);
  }

  /** Key-path signature with an output private key (hex). */
  signKeyPath(inputIndex, privHex) {
    return schnorr.sign(this.sighash(inputIndex), normalizeSchnorrPriv(privHex));
  }

  /** Script-path signature for one leaf, with the (even-Y) internal private key bytes. */
  signScriptPath(inputIndex, priv, leafHash) {
    return schnorr.sign(this.sighash(inputIndex, { leafHash }), priv);
  }
}

/** Broadcast a raw transaction to an Esplora /tx endpoint; returns the txid it answers. */
export async function broadcastHex(url, hex) {
  const res = await fetch(url, { method: 'POST', body: hex });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Broadcast failed with HTTP ${res.status}`);
  return text.trim();
}
