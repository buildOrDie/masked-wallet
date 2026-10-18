// Lightning → Shielded with a Boltz reverse swap, as pure functions (no state, no network).
//
//   1. The wallet derives a claim key and a preimage from its spend key and a random nonce, and asks Boltz
//      for a hold invoice locked to sha256(preimage).
//   2. Everything Boltz answers is checked here before the invoice is shown: the swap scripts are rebuilt
//      from our own keys and must match byte for byte, the lockup address must be the taproot output of
//      those scripts, and the invoice must carry our payment hash and the amount asked for.
//   3. Once Boltz has locked the bitcoin on-chain, the wallet claims it in a transaction whose only output is
//      a silent payment to this wallet. The wallet holds the scan key, so it can compute the BIP 352 output
//      for the lockup input itself; the normal Shielded scan finds the coin again on any device restored
//      from the recovery phrase.
//   4. The claim is signed together with Boltz (MuSig2 key path: looks like any taproot spend). If Boltz
//      does not cooperate, the claim leaf alone is enough (script path).
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { Session, keyAggExport, keyAggregate, nonceAggregate, nonceGen } from '@scure/btc-signer-musig/musig2.js';
import * as sp from '../crypto/sp-core.mjs';
import { concat, fromHex, rev, sha256d, toHex, u8 } from '../core/bytes.mjs';
import { RawTransaction } from '../bitcoin/RawTransaction.mjs';
import { TAP_LEAF_VERSION, hasOddY, leafHash, lift, p2trScript, tapTweak, trAddress, xonly } from '../bitcoin/taproot.mjs';
import { decodeInvoice } from './bolt11.mjs';

const { b2n, n2b, mod, mulG } = sp.util;

// opcodes used by the swap scripts
const OP = { SIZE: 0x82, EQUALVERIFY: 0x88, HASH160: 0xa9, CHECKSIG: 0xac, CHECKSIGVERIFY: 0xad, CLTV: 0xb1 };

/** Virtual size of the claim (one input, one taproot output) signed with Boltz: one signature, key path. */
export const KEY_VSIZE = 111;
/** The same claim spent alone through the claim script: signature, preimage, script and control block. */
export const SCRIPT_VSIZE = 152;
/** Below this the claim output would be dust. */
export const DUST = 330;
/** The claim signals RBF and has no lock time. */
const CLAIM_SEQUENCE = 0xfffffffd;

// ---------- keys ----------

/**
 * The claim key and preimage of one swap, from the spend key and the swap's random nonce. Only the nonce is
 * stored, so the swap record alone is useless without the recovery phrase.
 * @param {bigint} bSpend
 * @param {string} nonceHex 32 random bytes, hex
 */
export function swapSecrets(bSpend, nonceHex) {
  const seed = sp.taggedHash('MASKED/boltz-reverse', n2b(bSpend), fromHex(nonceHex));
  const k = mod(b2n(sp.taggedHash('MASKED/boltz-reverse/claim', seed)));
  if (k === 0n) throw new Error('Unusable swap key, start the swap again');
  const claimPriv = n2b(k);
  const preimage = sp.taggedHash('MASKED/boltz-reverse/preimage', seed);
  return { claimPriv, claimPub: secp256k1.getPublicKey(claimPriv, true), preimage, preimageHash: sha256(preimage) };
}

// ---------- scripts ----------

const pushData = (b) => concat(u8(b.length), b);

/** Minimal CScriptNum push (block heights for the refund lock). */
export function scriptNum(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('Bad script number');
  if (n === 0) return u8(0);
  if (n <= 16) return u8(0x50 + n);
  const out = [];
  let v = n;
  while (v > 0) { out.push(v & 0xff); v = Math.floor(v / 256); }
  if (out[out.length - 1] & 0x80) out.push(0);
  return concat(u8(out.length), Uint8Array.from(out));
}

/** OP_SIZE 32 OP_EQUALVERIFY OP_HASH160 <ripemd160(preimageHash)> OP_EQUALVERIFY <claim key> OP_CHECKSIG */
export const claimLeafScript = (preimageHash, claimX) => concat(
  u8(OP.SIZE), u8(1), u8(32), u8(OP.EQUALVERIFY), u8(OP.HASH160), pushData(ripemd160(preimageHash)), u8(OP.EQUALVERIFY),
  pushData(claimX), u8(OP.CHECKSIG),
);

/** <Boltz key> OP_CHECKSIGVERIFY <timeout> OP_CHECKLOCKTIMEVERIFY */
export const refundLeafScript = (refundX, timeout) => concat(pushData(refundX), u8(OP.CHECKSIGVERIFY), scriptNum(timeout), u8(OP.CLTV));

const tapBranch = (a, b) => {
  const [l, r] = toHex(a) < toHex(b) ? [a, b] : [b, a];
  return sp.taggedHash('TapBranch', l, r);
};

/** MuSig2 key of Boltz and us (Boltz's key first), x-only. */
export const aggregateKey = (boltzPub, ourPub) => keyAggExport(keyAggregate([boltzPub, ourPub]));

/**
 * The taproot output of a reverse swap.
 * @returns {{ claimScript: Uint8Array, refundScript: Uint8Array, claimLeafHash: Uint8Array, refundLeafHash: Uint8Array, merkleRoot: Uint8Array, internalX: Uint8Array, tweak: Uint8Array, outputX: string, parity: number, spk: Uint8Array, controlBlock: Uint8Array }}
 */
export function swapOutput({ preimageHash, claimPub, boltzPub, timeout }) {
  const claimScript = claimLeafScript(preimageHash, claimPub.slice(1));
  const refundScript = refundLeafScript(boltzPub.slice(1), timeout);
  const claimLeafHash = leafHash(claimScript), refundLeafHash = leafHash(refundScript);
  const merkleRoot = tapBranch(claimLeafHash, refundLeafHash);
  const internalX = aggregateKey(boltzPub, claimPub);
  const t = tapTweak(internalX, merkleRoot);
  const Q = lift(internalX).add(mulG(t));
  const parity = hasOddY(Q) ? 1 : 0;
  const outputX = toHex(xonly(Q));
  return {
    claimScript, refundScript, claimLeafHash, refundLeafHash, merkleRoot, internalX, tweak: n2b(t), outputX, parity,
    spk: p2trScript(outputX), controlBlock: concat(u8(TAP_LEAF_VERSION | parity), internalX, refundLeafHash),
  };
}

// ---------- checking what Boltz answers ----------

/** Fees from GET /v2/swap/reverse → what arrives for an invoice of `sats` (before our claim fee). */
export function quote(pair, sats) {
  const pct = Number(pair?.fees?.percentage), lockup = Number(pair?.fees?.minerFees?.lockup);
  if (!(pct >= 0) || !(lockup >= 0)) throw new Error('Lightning fees are not available right now');
  const boltzFee = Math.ceil((sats * pct) / 100);
  return { boltzFee, lockupFee: lockup, onchain: sats - boltzFee - lockup };
}

/**
 * Check a created reverse swap. Throws on anything that does not match; returns the swap output.
 * @param {object} p
 * @param {any} p.res            the reply of POST /v2/swap/reverse
 * @param {Uint8Array} p.claimPub
 * @param {Uint8Array} p.preimageHash
 * @param {number} p.sats         invoice amount asked for
 * @param {number} p.minOnchain   the least the lockup may hold (quote minus a small margin)
 * @param {string} p.hrp          'bc' on Mainnet
 * @param {string} p.lnNet        network name for the invoice prefix
 * @param {number} p.tipHeight    current block height
 */
export function verifyCreated({ res, claimPub, preimageHash, sats, minOnchain, hrp, lnNet, tipHeight }) {
  if (!res || typeof res !== 'object') throw new Error('Boltz sent an unreadable reply');
  for (const k of ['id', 'invoice', 'lockupAddress', 'refundPublicKey'])
    if (typeof res[k] !== 'string' || !res[k]) throw new Error(`Boltz reply is missing ${k}`);
  if (!/^[0-9a-zA-Z]{1,64}$/.test(res.id)) throw new Error('Boltz sent an unexpected swap id');
  const timeout = Number(res.timeoutBlockHeight);
  if (!Number.isInteger(timeout) || timeout <= tipHeight + 6 || timeout > tipHeight + 5000) throw new Error('Swap time lock is out of range');
  const onchain = Number(res.onchainAmount);
  if (!Number.isInteger(onchain) || onchain < minOnchain || onchain > sats) throw new Error(`Boltz offers ${onchain} sats on-chain, expected at least ${minOnchain}`);

  const inv = decodeInvoice(res.invoice);
  if (inv.network !== lnNet) throw new Error('Invoice is for another network');
  if (inv.sats !== sats || inv.msat !== BigInt(sats) * 1000n) throw new Error('Invoice amount does not match');
  if (inv.paymentHash !== toHex(preimageHash)) throw new Error('Invoice is not locked to this wallet\'s preimage');

  if (!/^0[23][0-9a-fA-F]{64}$/.test(res.refundPublicKey)) throw new Error('Boltz key is malformed');
  const boltzPub = fromHex(res.refundPublicKey);
  if (toHex(boltzPub) === toHex(claimPub)) throw new Error('Boltz key equals ours');
  const out = swapOutput({ preimageHash, claimPub, boltzPub, timeout });

  const tree = res.swapTree;
  if (!tree?.claimLeaf || !tree?.refundLeaf) throw new Error('Boltz reply is missing the swap scripts');
  if (tree.claimLeaf.version !== TAP_LEAF_VERSION || tree.refundLeaf.version !== TAP_LEAF_VERSION) throw new Error('Unexpected script version');
  if (String(tree.claimLeaf.output).toLowerCase() !== toHex(out.claimScript)) throw new Error('Claim script does not match this wallet\'s keys');
  if (String(tree.refundLeaf.output).toLowerCase() !== toHex(out.refundScript)) throw new Error('Refund script does not match the swap');
  if (tree.covenantClaimLeaf) throw new Error('Unexpected extra script in the swap');
  if (res.lockupAddress.toLowerCase() !== trAddress(out.outputX, hrp)) throw new Error('Lockup address does not match the swap scripts');
  return { ...out, boltzPub, timeout, onchain, invoice: inv };
}

// ---------- the lockup transaction ----------

/** Outputs and txid of a raw transaction (segwit or not). */
export function parseTx(hex) {
  const b = fromHex(hex);
  let i = 0;
  const rd = (n) => { if (i + n > b.length) throw new Error('Transaction is cut short'); const s = b.slice(i, i + n); i += n; return s; };
  const vi = () => { const f = rd(1)[0]; if (f < 0xfd) return f; const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8; let v = 0; const s = rd(n); for (let j = n - 1; j >= 0; j--) v = v * 256 + s[j]; return v; };
  const version = rd(4);
  let segwit = false;
  if (b[i] === 0 && b[i + 1] === 1) { segwit = true; i += 2; }
  const inStart = i;
  const nIn = vi();
  for (let k = 0; k < nIn; k++) { rd(36); rd(vi()); rd(4); }
  const outs = [];
  const nOut = vi();
  for (let k = 0; k < nOut; k++) {
    const v = rd(8); let value = 0; for (let j = 7; j >= 0; j--) value = value * 256 + v[j];
    outs.push({ value, script: rd(vi()) });
  }
  const ioEnd = i;
  if (segwit) for (let k = 0; k < nIn; k++) { const items = vi(); for (let m = 0; m < items; m++) rd(vi()); }
  const lock = rd(4);
  if (i !== b.length) throw new Error('Transaction has trailing bytes');
  const stripped = concat(version, b.slice(inStart, ioEnd), lock);
  return { txid: toHex(rev(sha256d(stripped))), outputs: outs };
}

/** The swap's output in Boltz's lockup transaction. */
export function findLockup(txHex, spk, minValue) {
  const tx = parseTx(txHex);
  const want = toHex(spk);
  const hits = tx.outputs.map((o, vout) => ({ ...o, vout })).filter((o) => toHex(o.script) === want);
  if (hits.length !== 1) throw new Error(hits.length ? 'Lockup pays the swap more than once' : 'Lockup transaction does not pay the swap');
  if (hits[0].value < minValue) throw new Error(`Lockup holds ${hits[0].value} sats, expected ${minValue}`);
  return { txid: tx.txid, vout: hits[0].vout, value: hits[0].value };
}

// ---------- the claim ----------

const ser32 = (k) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, k, false); return b; };

/**
 * The silent-payment output (k = 0) for a transaction whose only input is the lockup, paid to our own
 * spend key. Same result as a sender would get, computed from the receiver side with the scan key.
 */
export function selfSilentOutput({ bScan, Bspend, outpoint, inputX }) {
  const A = lift(fromHex(inputX)); // a taproot input counts with its even-Y output key
  const T = A.multiply(sp.inputHash([outpoint], A));
  const S = T.multiply(mod(bScan));
  const t = mod(b2n(sp.taggedHash('BIP0352/SharedSecret', S.toRawBytes(true), ser32(0))));
  const P = Bspend.add(mulG(t));
  return { outputX: toHex(xonly(P)), tweak: toHex(n2b(t)), tweakPoint: toHex(T.toRawBytes(true)) };
}

/** Unsigned claim: lockup → one Shielded output, the fee taken from the lockup. */
export function claimTx({ lockup, spk, outputX, fee }) {
  const value = lockup.value - fee;
  if (value < DUST) throw new Error('Too small to claim at the current fee rate');
  return new RawTransaction({
    inputs: [{ txid: lockup.txid, vout: lockup.vout, value: lockup.value, scriptPubKey: spk, sequence: CLAIM_SEQUENCE }],
    outputs: [{ value, script: p2trScript(outputX) }],
  });
}

/** Script-path witness: <signature> <preimage> <claim script> <control block>. Needs nobody else. */
export function scriptPathWitness(tx, out, claimPriv, preimage) {
  const sig = tx.signScriptPath(0, claimPriv, out.claimLeafHash);
  if (!schnorr.verify(sig, tx.sighash(0, { leafHash: out.claimLeafHash }), out.claimScript.slice(-33, -1))) throw new Error('Claim signature check failed');
  return [sig, preimage, out.claimScript, out.controlBlock];
}

/**
 * Key-path claim signed with Boltz (MuSig2). Returns our nonce for the request and a function that turns
 * Boltz's answer into the final signature (checked against the swap output before it is used).
 */
export function cooperativeClaim(tx, out, claimPriv, claimPub) {
  const msg = tx.sighash(0);
  const keys = [out.boltzPub, claimPub];
  const tweaked = keyAggExport(keyAggregate(keys, [out.tweak], [true]));
  if (toHex(tweaked) !== out.outputX) throw new Error('MuSig2 key does not match the swap output');
  const nonce = nonceGen(claimPub, claimPriv, tweaked, msg);
  const ourPubNonce = nonce.public;
  return {
    pubNonce: toHex(ourPubNonce),
    /** @param {{ pubNonce: string, partialSignature: string }} reply */
    finish(reply) {
      if (!/^[0-9a-fA-F]{132}$/.test(reply?.pubNonce || '') || !/^[0-9a-fA-F]{64}$/.test(reply?.partialSignature || '')) throw new Error('Boltz sent an unreadable signature');
      const nonces = [fromHex(reply.pubNonce), ourPubNonce];
      const session = new Session(nonceAggregate(nonces), keys, msg, [out.tweak], [true]);
      const theirs = fromHex(reply.partialSignature);
      if (!session.partialSigVerify(theirs, nonces, 0)) throw new Error('Boltz\'s partial signature is invalid');
      const ours = session.sign(nonce.secret, claimPriv);
      const sig = session.partialSigAgg([theirs, ours]);
      if (!schnorr.verify(sig, msg, fromHex(out.outputX))) throw new Error('Combined signature is invalid');
      return [sig];
    },
  };
}

/** How long the user still has to claim, in blocks. */
export const blocksLeft = (timeout, tip) => timeout - tip;

