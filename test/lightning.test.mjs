// Lightning → Shielded (Boltz reverse swaps): our scripts, keys and signatures against Boltz's own library
// (boltz-core plays the Boltz side), the checks on Boltz's reply, and the silent-payment claim output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';
import { Musig, SwapTreeSerializer, TaprootUtils, reverseSwapTree } from 'boltz-core';
import * as sp from '../src/crypto/sp-core.mjs';
import { toHex, fromHex } from '../src/core/bytes.mjs';
import { RawTransaction } from '../src/bitcoin/RawTransaction.mjs';
import { p2trScript, trAddress } from '../src/bitcoin/taproot.mjs';
import { amountMsat, decodeInvoice } from '../src/lightning/bolt11.mjs';
import * as rs from '../src/lightning/reverse-swap.mjs';

const { b2n, mulG } = sp.util;
const hex = (b) => Buffer.from(b).toString('hex');

/** A BOLT 11 invoice with our payment hash (signature left blank: we never check it). */
function makeInvoice(sats, paymentHash, prefix = 'lnbc') {
  const amount = `${sats * 10}n`;
  const ts = []; let t = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 7; i++) { ts.unshift(t & 31); t = Math.floor(t / 32); }
  const field = (type, words) => [type, words.length >> 5, words.length & 31, ...words];
  const words = [...ts, ...field(1, bech32.toWords(paymentHash)), ...field(6, [0, 28, 8]), ...new Array(104).fill(0)];
  return bech32.encode(`${prefix}${amount}`, words, 10_000);
}

/** What Boltz would build and answer for a swap, using boltz-core. */
function boltzSide({ preimageHash, claimPub, sats, onchain, timeout }) {
  const boltzPriv = secp256k1.utils.randomPrivateKey();
  const boltzPub = secp256k1.getPublicKey(boltzPriv, true);
  const tree = reverseSwapTree(false, preimageHash, claimPub, boltzPub, timeout);
  const musig = TaprootUtils.tweakMusig(Musig.create(boltzPriv, [boltzPub, claimPub]), tree.tree);
  const res = {
    id: 'Swap1234', invoice: makeInvoice(sats, preimageHash), swapTree: SwapTreeSerializer.serializeSwapTree(tree),
    lockupAddress: trAddress(hex(musig.aggPubkey), 'bc'), refundPublicKey: hex(boltzPub), timeoutBlockHeight: timeout, onchainAmount: onchain,
  };
  return { res, boltzPriv, boltzPub, tree, musig };
}

const wallet = () => {
  const bScan = b2n(randomBytes(32)) % secp256k1.CURVE.n, bSpend = b2n(randomBytes(32)) % secp256k1.CURVE.n;
  return { bScan, bSpend, Bspend: mulG(bSpend) };
};

function setup(over = {}) {
  const w = wallet();
  const nonce = toHex(randomBytes(32));
  const s = rs.swapSecrets(w.bSpend, nonce);
  const sats = 50_000, onchain = 49_700, tip = 900_000, timeout = tip + 144;
  const boltz = boltzSide({ preimageHash: s.preimageHash, claimPub: s.claimPub, sats, onchain, timeout });
  const res = { ...boltz.res, ...over };
  const args = { res, claimPub: s.claimPub, preimageHash: s.preimageHash, sats, minOnchain: 49_500, hrp: 'bc', lnNet: 'main', tipHeight: tip };
  return { w, s, sats, onchain, boltz, res, args };
}

/** Boltz's lockup: a transaction paying the swap output. */
function lockupTx(spk, value) {
  const tx = new RawTransaction({ inputs: [{ txid: toHex(randomBytes(32)), vout: 1, value: value + 5000, scriptPubKey: p2trScript(toHex(randomBytes(32))) }], outputs: [{ value: 12345, script: p2trScript(toHex(randomBytes(32))) }, { value, script: spk }] });
  return tx.toHex([[new Uint8Array(64)]]);
}

test('BOLT 11: decodes the spec example', () => {
  const inv = decodeInvoice('lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh');
  assert.equal(inv.network, 'main');
  assert.equal(inv.sats, 250_000);
  assert.equal(inv.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102');
  assert.equal(inv.expiry, 60);
  assert.equal(amountMsat('10p'), 1n);
  assert.equal(amountMsat('1'), 100_000_000_000n);
  assert.throws(() => amountMsat('1p'));
});

test('swap secrets: deterministic from the spend key and nonce', () => {
  const w = wallet(), n = toHex(randomBytes(32));
  const a = rs.swapSecrets(w.bSpend, n), b = rs.swapSecrets(w.bSpend, n);
  assert.equal(toHex(a.preimage), toHex(b.preimage));
  assert.equal(toHex(a.claimPub), toHex(b.claimPub));
  assert.notEqual(toHex(rs.swapSecrets(w.bSpend + 1n, n).preimage), toHex(a.preimage));
});

test('scripts, key aggregation and address match boltz-core', () => {
  const { s, boltz, args } = setup();
  const out = rs.verifyCreated(args);
  assert.equal(toHex(out.claimScript), hex(boltz.tree.claimLeaf.output));
  assert.equal(toHex(out.refundScript), hex(boltz.tree.refundLeaf.output));
  assert.equal(out.outputX, hex(boltz.musig.aggPubkey));
  const cb = TaprootUtils.createControlBlock(TaprootUtils.taprootHashTree(boltz.tree.tree), boltz.tree.claimLeaf, out.internalX);
  assert.equal(toHex(out.controlBlock), hex(cb));
  assert.equal(toHex(rs.aggregateKey(boltz.boltzPub, s.claimPub)), hex(boltz.musig.internalKey));
  for (const n of [0, 1, 16, 17, 127, 128, 255, 256, 900_144, 8_388_608]) assert.ok(rs.scriptNum(n).length >= 1);
});

test('rejects a reply that does not match', () => {
  const { args, res } = setup();
  const bad = (patch, re) => assert.throws(() => rs.verifyCreated({ ...args, res: { ...res, ...patch } }), re);
  bad({ lockupAddress: trAddress(toHex(randomBytes(32)), 'bc') }, /Lockup address/);
  bad({ swapTree: { ...res.swapTree, refundLeaf: { ...res.swapTree.refundLeaf, output: res.swapTree.refundLeaf.output.replace(/.{2}$/, 'b2') } } }, /Refund script/);
  bad({ swapTree: { ...res.swapTree, claimLeaf: { ...res.swapTree.claimLeaf, output: res.swapTree.claimLeaf.output.slice(0, -4) + '00ac' } } }, /Claim script/);
  bad({ invoice: makeInvoice(50_000, randomBytes(32)) }, /preimage/);
  bad({ invoice: makeInvoice(40_000, fromHex(decodeInvoice(res.invoice).paymentHash)) }, /amount/);
  bad({ invoice: makeInvoice(50_000, fromHex(decodeInvoice(res.invoice).paymentHash), 'lntbs') }, /network/);
  bad({ onchainAmount: 40_000 }, /on-chain/);
  bad({ timeoutBlockHeight: 900_003 }, /time lock/);
  bad({ refundPublicKey: '04' + '11'.repeat(32) }, /malformed/);
});

test('claim output is a silent payment the wallet scanner finds', () => {
  const { w, s, onchain, args } = setup();
  const out = rs.verifyCreated(args);
  const lockup = rs.findLockup(lockupTx(out.spk, onchain), out.spk, onchain);
  assert.equal(lockup.vout, 1);
  const so = rs.selfSilentOutput({ bScan: w.bScan, Bspend: w.Bspend, outpoint: { txid: lockup.txid, vout: lockup.vout }, inputX: out.outputX });
  const tx = rs.claimTx({ lockup, spk: out.spk, outputX: so.outputX, fee: rs.CLAIM_VSIZE * 2 });
  assert.equal(tx.outputs[0].value, onchain - 304);

  for (const witness of [rs.scriptPathWitness(tx, out, s.claimPriv, s.preimage), [new Uint8Array(64)]]) {
    const vin = { scriptSig: '', witness, prevoutScript: toHex(out.spk) };
    const pub = sp.inputPubKey(vin);
    assert.ok(pub, 'lockup input counts for BIP 352');
    const tweak = sp.txTweak([pub.pub], [{ txid: lockup.txid, vout: lockup.vout }]);
    const found = sp.scanOutputs(tweak, [so.outputX], w.bScan, w.Bspend);
    assert.equal(found.length, 1);
    assert.equal(found[0].tweak, so.tweak);
  }
  // the coin is spendable with the wallet's key and the found tweak
  const priv = sp.outputPrivKey(w.bSpend, so.tweak);
  assert.equal(toHex(sp.util.xOnly(mulG(b2n(fromHex(priv))))), so.outputX);
});

test('script-path claim: preimage, claim script and a valid signature', () => {
  const { w, s, onchain, args } = setup();
  const out = rs.verifyCreated(args);
  const lockup = rs.findLockup(lockupTx(out.spk, onchain), out.spk, onchain);
  const so = rs.selfSilentOutput({ bScan: w.bScan, Bspend: w.Bspend, outpoint: lockup, inputX: out.outputX });
  const tx = rs.claimTx({ lockup, spk: out.spk, outputX: so.outputX, fee: 300 });
  const wit = rs.scriptPathWitness(tx, out, s.claimPriv, s.preimage);
  assert.equal(wit.length, 4);
  assert.equal(toHex(wit[1]), toHex(s.preimage));
  assert.ok(schnorr.verify(wit[0], tx.sighash(0, { leafHash: out.claimLeafHash }), s.claimPub.slice(1)));
  const raw = tx.toHex([wit]);
  const vsize = Math.ceil((raw.length / 2 + 3 * (tx.toHex().length / 2)) / 4);
  assert.ok(vsize <= rs.CLAIM_VSIZE, `claim is ${vsize} vB`);
});

test('cooperative claim with Boltz (MuSig2 key path)', () => {
  const { w, s, onchain, args, boltz } = setup();
  const out = rs.verifyCreated(args);
  const lockup = rs.findLockup(lockupTx(out.spk, onchain), out.spk, onchain);
  const so = rs.selfSilentOutput({ bScan: w.bScan, Bspend: w.Bspend, outpoint: lockup, inputX: out.outputX });
  const tx = rs.claimTx({ lockup, spk: out.spk, outputX: so.outputX, fee: 300 });
  const coop = rs.cooperativeClaim(tx, out, s.claimPriv, s.claimPub);

  // Boltz signs its part of the same transaction
  const msg = tx.sighash(0);
  const signed = boltz.musig.message(msg).generateNonce()
    .aggregateNonces([[s.claimPub, fromHex(coop.pubNonce)]]).initializeSession().signPartial();
  const reply = { pubNonce: hex(signed.publicNonce), partialSignature: hex(signed.ourPartialSignature) };
  const [sig] = coop.finish(reply);
  assert.ok(schnorr.verify(sig, msg, fromHex(out.outputX)));

  // a wrong partial signature is caught before anything is broadcast
  const coop2 = rs.cooperativeClaim(tx, out, s.claimPriv, s.claimPub);
  assert.throws(() => coop2.finish({ ...reply, partialSignature: '11'.repeat(32) }), /invalid|unreadable/i);
});

test('lockup checks', () => {
  const { onchain, args } = setup();
  const out = rs.verifyCreated(args);
  assert.throws(() => rs.findLockup(lockupTx(out.spk, onchain - 1), out.spk, onchain), /holds/);
  assert.throws(() => rs.findLockup(lockupTx(p2trScript('11'.repeat(32)), onchain), out.spk, onchain), /does not pay/);
  assert.throws(() => rs.claimTx({ lockup: { txid: '00'.repeat(32), vout: 0, value: 500 }, spk: out.spk, outputX: '11'.repeat(32), fee: 300 }), /Too small/);
  const q = rs.quote({ fees: { percentage: 0.25, minerFees: { lockup: 200, claim: 150 } } }, 100_000);
  assert.deepEqual(q, { boltzFee: 250, lockupFee: 200, onchain: 99_550 });
});
