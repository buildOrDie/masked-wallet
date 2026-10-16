// Taproot keys and outputs (BIP 340 / 341): key-path outputs, script-path outputs and the NUMS point.
import { secp256k1 } from '@noble/curves/secp256k1';
import { bech32m } from '@scure/base';
import * as sp from '../crypto/sp-core.mjs';
import { concat, fromHex, toHex, u8, varint } from '../core/bytes.mjs';

const { b2n, n2b, mulG, Point, mod } = sp.util;

export const TAP_LEAF_VERSION = 0xc0;
export const TAPROOT_ANNEX_PREFIX = 0x50;
/** "Nothing up my sleeve" internal key: nobody knows its private key, so only the script path can spend. */
export const NUMS_X = fromHex('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

export const xonly = (P) => P.toRawBytes(true).slice(1);
export const lift = (x) => Point.fromHex(concat(u8(2), x));
export const hasOddY = (P) => P.toRawBytes(true)[0] === 3;
const tagged = (tag, ...msgs) => sp.taggedHash(tag, ...msgs);

/** The private key whose public key has even Y (what BIP 340 signs with). */
export function normalizeSchnorrPriv(hex) {
  let d = b2n(fromHex(hex));
  if (hasOddY(mulG(d))) d = secp256k1.CURVE.n - d;
  return n2b(d);
}

export const p2trScript = (xHex) => concat(u8(0x51), u8(0x20), fromHex(xHex));
export const leafHash = (script) => tagged('TapLeaf', u8(TAP_LEAF_VERSION), varint(script.length), script);
export const tapTweak = (internalX, merkleRoot = new Uint8Array()) => b2n(tagged('TapTweak', internalX, merkleRoot));

/** bc1p… / tb1p… for an x-only output key. */
export const trAddress = (xHex, hrp) => bech32m.encode(hrp, [1, ...bech32m.toWords(fromHex(xHex))]);

/** A BIP 86 key-path output: internal key, tweaked output key, its private key and the address. */
export function keySpendTaproot(privHex, hrp) {
  const internalPriv = normalizeSchnorrPriv(privHex);
  const internalPoint = mulG(b2n(internalPriv));
  const internalX = xonly(internalPoint);
  const tweak = tapTweak(internalX);
  const outputPoint = internalPoint.add(mulG(tweak));
  let outputPriv = mod(b2n(internalPriv) + tweak);
  if (hasOddY(outputPoint)) outputPriv = secp256k1.CURVE.n - outputPriv;
  const outputX = toHex(xonly(outputPoint));
  return { internalX: toHex(internalX), outputX, outputPriv: toHex(n2b(outputPriv)), address: trAddress(outputX, hrp) };
}

/** An output with one script leaf (an inscription envelope), spendable by key path or by that leaf. */
export function taprootScriptOutput(internalPrivHex, leafScript) {
  const internalPriv = normalizeSchnorrPriv(internalPrivHex);
  const internalPoint = mulG(b2n(internalPriv));
  const internalX = xonly(internalPoint);
  const lh = leafHash(leafScript);
  const tweak = tapTweak(internalX, lh);
  const outputPoint = internalPoint.add(mulG(tweak));
  const parity = hasOddY(outputPoint) ? 1 : 0;
  let outputPriv = mod(b2n(internalPriv) + tweak);
  if (parity) outputPriv = secp256k1.CURVE.n - outputPriv;
  return { internalPriv, internalX, leafHash: lh, outputPriv: toHex(n2b(outputPriv)), outputX: toHex(xonly(outputPoint)), controlBlock: concat(u8(TAP_LEAF_VERSION | parity), internalX) };
}

/** A one-leaf output on the NUMS internal key: spendable by the leaf only, and not a silent-payment input. */
export function numsScriptOutput(leafScript) {
  const lh = leafHash(leafScript);
  const P = lift(NUMS_X).add(mulG(tapTweak(NUMS_X, lh)));
  const parity = hasOddY(P) ? 1 : 0;
  return { leafHash: lh, outputX: toHex(xonly(P)), controlBlock: concat(u8(TAP_LEAF_VERSION | parity), NUMS_X) };
}
