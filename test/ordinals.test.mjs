// Ordinals: the gallery reads which coins hold inscriptions, and sending one keeps the inscription on its own
// output (first in, first out, same value) with the fee from other plain coins of the same side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1';
import * as sp from '../src/crypto/sp-core.mjs';
import { walletApp, mockFetch, Keyring } from './helpers/wallet-app.mjs';
import { OrdinalGallery } from '../src/ordinals/Gallery.mjs';

const A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const INS = 'ab'.repeat(32), PLAIN = 'cd'.repeat(32), SH_INS = 'ef'.repeat(32), SH_PLAIN = '12'.repeat(32);

function sigsValid(tx) {
  const scripts = [], amounts = [];
  for (let j = 0; j < tx.inputsLength; j++) { const w = tx.getInput(j).witnessUtxo; scripts.push(w.script); amounts.push(w.amount); }
  for (let j = 0; j < tx.inputsLength; j++) {
    const sig = tx.getInput(j).finalScriptWitness?.[0];
    if (!sig || !schnorr.verify(sig.slice(0, 64), tx.preimageWitnessV1(j, scripts, 0, amounts), scripts[j].slice(2))) return false;
  }
  return true;
}

/** A wallet on Signet with a 546-sat inscription coin and a plain coin on each side. */
function setup() {
  const app = walletApp(Keyring.fromMnemonic(A, '', 'signet'), 'signet');
  const f = app.account.funding(), keys = app.account.keys;
  const pubCoin = (txid, sats) => ({ key: `${txid}:0`, kind: 'funding', txid, vout: 0, sats, output: f.outputX, privKey: f.outputPriv, address: f.address, pending: false });
  const shCoin = (txid, sats, t) => ({ key: `${txid}:1`, txid, vout: 1, sats, tweak: t.repeat(32), output: hex.encode(schnorr.getPublicKey(hex.decode(keys.outputPriv(t.repeat(32))))), label: null, pending: false });
  app.coins.public = [pubCoin(INS, 546), pubCoin(PLAIN, 60_000)];
  app.coins.shielded = [shCoin(SH_INS, 10_000, '03'), shCoin(SH_PLAIN, 40_000, '04')];
  mockFetch((url, init) => {
    if (url.endsWith('/outputs')) {
      const ops = JSON.parse(init.body);
      return ops.map((o) => ({ outpoint: o, indexed: true, runes: {}, inscriptions: o.startsWith(INS) ? [`${INS}i0`] : o.startsWith(SH_INS) ? [`${SH_INS}i0`, `${SH_INS}i1`] : [] }));
    }
    if (url.includes('/inscription/')) return { content_type: url.includes(INS) ? 'image/png' : 'text/plain;charset=utf-8', number: url.endsWith('i1') ? 1001 : 1000 };
    if (url.includes('/content/')) return '{"p":"brc-20","op":"transfer","tick":"ordi","amt":"1000"}';
    return [];
  });
  return app;
}

test('gallery: finds the inscriptions on both sides and protects their coins', async () => {
  const app = setup();
  await app.gallery.refresh();
  assert.equal(app.gallery.error, '');
  assert.deepEqual(app.gallery.items.map((x) => [x.id, x.side, x.together]), [[`${INS}i0`, 'public', 1], [`${SH_INS}i0`, 'shielded', 2], [`${SH_INS}i1`, 'shielded', 2]]);
  assert.deepEqual(app.gallery.of(`${INS}i0`), { type: 'image/png', number: 1000 });
  // the 10,000-sat Shielded coin is now known to hold inscriptions: never spent by Send
  assert.deepEqual(app.coins.spendable('shielded').map((c) => c.txid), [SH_PLAIN]);
  assert.equal(OrdinalGallery.brc20Label(await app.gallery.text(`${SH_INS}i0`)), 'transfer 1,000 ORDI');
});

test('send to a Public address: the inscription coin goes first and keeps its exact value', async () => {
  const app = setup();
  await app.gallery.refresh();
  const bob = Keyring.fromMnemonic(B, '', 'signet');
  const to = walletApp(bob, 'signet').account.pubAddr();
  const b = await app.builder.sendInscription({ coinKey: `${INS}:0`, to, rate: 2 });
  const tx = btc.Transaction.fromRaw(hex.decode(b.hex), { allowUnknownOutputs: true });
  assert.equal(hex.encode(tx.getInput(0).txid), INS);
  assert.equal(tx.getOutput(0).amount, 546n);
  assert.equal(hex.encode(tx.getOutput(0).script), hex.encode(app.account.codec.outputScript(to)));
  assert.equal(tx.inputsLength, 2);
  assert.equal(hex.encode(tx.getInput(1).txid), PLAIN, 'the fee comes from the plain Public coin');
  const inSum = 546 + 60_000, outSum = Number(tx.getOutput(0).amount + (tx.outputsLength > 1 ? tx.getOutput(1).amount : 0n));
  assert.equal(inSum - outSum, b.fee);
  assert.ok(b.fee > 0 && b.fee < 2000);
  // signatures check out against the real prevouts
  const signed = new btc.Transaction({ allowUnknownOutputs: true });
  const spk = app.account.codec.outputScript(app.account.pubAddr());
  for (let i = 0; i < tx.inputsLength; i++) { const x = tx.getInput(i); signed.addInput({ txid: x.txid, index: x.index, sequence: x.sequence, witnessUtxo: { script: spk, amount: BigInt(i ? 60_000 : 546) } }); }
  for (let i = 0; i < tx.outputsLength; i++) signed.addOutput(tx.getOutput(i));
  for (let i = 0; i < tx.inputsLength; i++) signed.updateInput(i, { finalScriptWitness: tx.getInput(i).finalScriptWitness }, true);
  assert.ok(sigsValid(signed));
});

test('send to a Shielded address: the receiver finds it; fee only from Shielded coins', async () => {
  const app = setup();
  await app.gallery.refresh();
  const bob = Keyring.fromMnemonic(B, '', 'signet');
  const bobApp = walletApp(bob, 'signet');
  const b = await app.builder.sendInscription({ coinKey: `${SH_INS}:1`, to: bobApp.account.shieldAddr(), rate: 2 });
  assert.equal(b.kind, 'shielded');
  assert.equal(b.from, 'shielded');
  const tx = btc.Transaction.fromRaw(hex.decode(b.hex), { allowUnknownOutputs: true });
  assert.deepEqual([0, 1].map((i) => hex.encode(tx.getInput(i).txid)), [SH_INS, SH_PLAIN], 'no Public coin in a Shielded send');
  assert.equal(tx.getOutput(0).amount, 10_000n);
  // Bob scans the transaction like his wallet does
  const coins = b.coins;
  const pubs = coins.map((c) => sp.util.liftX(hex.decode(c.output)));
  const tweak = sp.txTweak(pubs, coins.map((c) => ({ txid: c.txid, vout: c.vout })));
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => hex.encode(tx.getOutput(i).script.slice(2)));
  const found = sp.scanOutputs(tweak, outs, bob.bScan, bob.Bspend);
  assert.equal(found.length, 1);
  assert.equal(found[0].output, outs[0], 'output 0, the inscription, is Bob\'s');
  // the change is the sender's own Shielded change address, found by the sender
  const mine = sp.scanOutputs(tweak, outs, app.account.keys.bScan, app.account.keys.Bspend, sp.buildLabels(app.account.keys.bScan, [0]));
  assert.ok(mine.some((m) => m.output === outs[1] && m.label === 0));
});

test('refusals: no fee coins, same address, coin gone', async () => {
  const app = setup();
  await app.gallery.refresh();
  await assert.rejects(() => app.builder.sendInscription({ coinKey: `${INS}:0`, to: app.account.pubAddr(), rate: 2 }), /already on/);
  await assert.rejects(() => app.builder.sendInscription({ coinKey: 'nope:0', to: 'self', rate: 2 }), /no longer/);
  app.coins.public = app.coins.public.filter((c) => c.txid === INS);
  await assert.rejects(() => app.builder.sendInscription({ coinKey: `${INS}:0`, to: 'self', rate: 2 }), /never used for the fee/);
});

test('refreshing again asks ord nothing new; a failed batch falls back to one coin at a time', async () => {
  const app = setup();
  await app.gallery.refresh();
  const calls = mockFetch(() => { throw new Error('should not be called'); });
  await app.gallery.refresh();
  assert.equal(calls.filter((u) => u.includes('/output')).length, 0, 'every coin was already answered for');
  assert.equal(app.gallery.items.length, 3);
  // a new wallet whose batch request is refused (rate limit): single lookups still find the inscription
  const app2 = setup();
  app2.store.remove('wren.galout.signet'); app2.gallery.reset(); // forget what the first wallet learned (same browser storage)
  const seen = mockFetch((url) => {
    if (url.endsWith('/outputs')) return new Response('slow down', { status: 429 });
    if (url.includes('/output/')) return { indexed: true, runes: {}, inscriptions: url.includes(INS) ? [`${INS}i0`] : [] };
    if (url.includes('/inscription/')) return { content_type: 'image/png', number: 1 };
    return [];
  });
  await app2.gallery.refresh();
  assert.equal(app2.gallery.error, '');
  assert.deepEqual(app2.gallery.items.map((x) => x.id), [`${INS}i0`]);
  assert.ok(seen.some((u) => u.includes('/output/')));
});
