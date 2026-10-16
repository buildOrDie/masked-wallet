// Message signatures for the Public address: classic "Bitcoin Signed Message" (ECDSA) and BIP-322 simple.
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import * as sp from '../crypto/sp-core.mjs';
import { b64, concat, enc, fromHex, rev, sha256d, toHex, u8, u32le, u64le, varint, ZERO32 } from '../core/bytes.mjs';
import { p2trScript } from './taproot.mjs';

/** ECDSA with the recovery header for a compressed key; base64. `priv` is the internal (even-Y) key. */
export function signMessageEcdsa(message, priv) {
  const m = enc.encode(message);
  const magic = enc.encode('\x18Bitcoin Signed Message:\n');
  const sig = secp256k1.sign(sha256d(concat(magic, varint(m.length), m)), priv, { lowS: true });
  return b64(concat(u8(27 + sig.recovery + 4), sig.toCompactRawBytes()));
}

/** BIP-322 "simple" signature (the witness of the to_sign transaction) for a BIP 86 address; base64. */
export function signMessageBip322(message, { internalX, outputX }, priv) {
  const spk = p2trScript(outputX);
  const msgHash = sp.taggedHash('BIP0322-signed-message', enc.encode(message));
  const toSpend = concat(u32le(0), u8(1), ZERO32, u32le(0xffffffff), u8(34), u8(0x00), u8(0x20), msgHash, u32le(0),
    u8(1), u64le(0), varint(spk.length), spk, u32le(0));
  const toSpendId = toHex(rev(sha256d(toSpend)));
  const tx = new btc.Transaction({ version: 0, allowUnknownOutputs: true });
  tx.addInput({ txid: toSpendId, index: 0, sequence: 0, witnessUtxo: { script: spk, amount: 0n }, tapInternalKey: fromHex(internalX) });
  tx.addOutput({ script: u8(0x6a), amount: 0n });
  tx.signIdx(priv, 0);
  tx.finalizeIdx(0);
  const w = tx.getInput(0).finalScriptWitness;
  return b64(concat(varint(w.length), ...w.map((x) => concat(varint(x.length), x))));
}
