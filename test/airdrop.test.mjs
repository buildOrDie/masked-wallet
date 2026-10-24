// Silent airdrop on the real wallet services: finding addresses in pasted text, one transaction to many
// Shielded addresses, and every recipient's own scan finding its coin (Mainnet and Signet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as sp from '../src/crypto/sp-core.mjs';
import { toHex } from '../src/core/bytes.mjs';
import { parseTx } from '../src/bitcoin/parseTx.mjs';
import { walletApp, testKeys } from './helpers/wallet-app.mjs';
import { MAX_RECIPIENTS, MIN_EACH, dropFee, extractRecipients } from '../src/wallet/Airdrop.mjs';

const { b2n, mulG, n2b } = sp.util;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const rnd = () => (b2n(randomBytes(32)) % (N - 1n)) + 1n;

/** A recipient wallet (its own keys and address). */
function recipient(net = 'main') {
  globalThis.localStorage.clear();
  const app = walletApp(testKeys({ bScan: rnd(), bSpend: rnd(), fundingPriv: toHex(randomBytes(32)) }), net);
  return app;
}

function sender(net = 'main') {
  globalThis.localStorage.clear();
  const app = walletApp(testKeys({ bSpend: 0x7777n * 104723n, fundingPriv: '55'.repeat(32) }), net);
  app.state.lockState = 'open';
  app.toast = () => {};
  return app;
}

/** Public coins on the sender's funding address, already checked by ord. */
function fundPublic(app, values) {
  const f = app.account.funding();
  app.coins.public = values.map((v, i) => {
    const txid = toHex(randomBytes(32));
    app.ord.put(`${txid}:0`, { ins: 0, runes: 0, at: Date.now() });
    return { key: `fund:${txid}:0`, kind: 'funding', txid, vout: 0, sats: v, output: f.outputX, privKey: f.outputPriv, address: f.address, pending: false, i };
  });
}

/** A Shielded coin the sender holds (an output Bspend + t·G with a known tweak). */
function fundShielded(app, value) {
  const t = rnd();
  const P = app.account.keys.Bspend.add(mulG(t));
  const txid = toHex(randomBytes(32));
  app.ord.put(`${txid}:1`, { ins: 0, runes: 0, at: Date.now() });
  app.coins.shielded = [{ key: `${txid}:1`, txid, vout: 1, sats: value, output: toHex(sp.util.xOnly(P)), tweak: toHex(n2b(t)), label: null, pending: false }];
}

/** Esplora-shaped JSON of a built transaction, for the scanner. */
function asEsplora(hex, prevouts) {
  const tx = parseTx(hex);
  return {
    txid: tx.txid, status: { confirmed: false },
    vin: tx.inputs.map((i, k) => ({ txid: i.txid, vout: i.vout, scriptsig: '', witness: i.witness.map(toHex), prevout: { scriptpubkey: '5120' + prevouts[k].output, value: prevouts[k].sats } })),
    vout: tx.outputs.map((o) => ({ scriptpubkey: toHex(o.script), value: o.value })),
  };
}

test('finds addresses in a pasted X thread: dedupes, skips other network, own and junk', () => {
  const r = Array.from({ length: 3 }, () => recipient());
  const own = sender();
  const testAddr = recipient('signet').account.shieldAddr();
  const text = `@alice: here ${r[0].account.shieldAddr()} 🎭
  @bob ${r[1].account.shieldAddr().toUpperCase()}
  @alice again ${r[0].account.shieldAddr()}
  @carol ${r[2].account.shieldAddr()}, thanks!
  @dave (signet) ${testAddr}
  @me ${own.account.shieldAddr()}
  @eve sp1qqnotarealaddress`;
  const x = extractRecipients(text, 'main', own.account.shieldAddr());
  assert.deepEqual(x.list, r.map((a) => a.account.shieldAddr()));
  assert.equal(x.dupes, 1);
  assert.equal(x.wrongNet, 1);
  assert.equal(x.own, true);
  const s = extractRecipients(text, 'signet');
  assert.deepEqual(s.list, [testAddr]);
});

test('Mainnet airdrop from Public: one transaction, every recipient finds its coin', async () => {
  const people = Array.from({ length: 40 }, () => recipient());
  const A = sender();
  fundPublic(A, [30_000, 25_000, 5_000]);
  const text = people.map((p) => p.account.shieldAddr()).join('\n');
  const b = await A.airdrop.build({ from: 'public', text, each: 1_000, rate: 2 });
  assert.equal(b.count, 40);
  assert.equal(b.total, 40_000);
  assert.equal(b.spent.length, 2, 'the two biggest coins cover it');
  const tx = parseTx(b.hex);
  assert.equal(tx.txid, b.txid);
  assert.equal(tx.outputs.length, 41, '40 people + change');
  assert.equal(b.fee, dropFee(2, 41, 2));
  assert.ok(tx.vsize <= Math.ceil(10.5 + 57.5 * 2 + 43 * 41) + 1, `vsize ${tx.vsize}`);
  const inSum = 55_000, outSum = tx.outputs.reduce((s, o) => s + o.value, 0);
  assert.equal(inSum - outSum, b.fee);
  // change goes back to the Public address
  assert.equal(toHex(tx.outputs[40].script), A.account.pubSpk());

  const prev = b.spent.map((k) => A.coins.public.find((c) => c.key === k));
  const json = asEsplora(b.hex, prev);
  for (const p of people) {
    p.scanner.scanTx(json);
    const got = p.coins.shielded.filter((c) => c.txid === b.txid);
    assert.equal(got.length, 1, 'exactly one output each');
    assert.equal(got[0].sats, 1_000);
    const priv = p.account.keys.outputPriv(got[0].tweak);
    assert.equal(toHex(sp.util.xOnly(mulG(b2n(Buffer.from(priv, 'hex'))))), got[0].output, 'spendable by its owner');
  }
});

test('from Shielded: change comes back Shielded and the sender finds it', async () => {
  const people = Array.from({ length: 5 }, () => recipient());
  const A = sender();
  fundShielded(A, 100_000);
  const b = await A.airdrop.build({ from: 'shielded', text: people.map((p) => p.account.shieldAddr()).join(' '), each: 2_000, rate: 1 });
  const json = asEsplora(b.hex, [A.coins.shielded[0]]);
  A.scanner.scanTx(json);
  const change = A.coins.shielded.filter((c) => c.txid === b.txid);
  assert.equal(change.length, 1);
  assert.equal(change[0].label, 0, 'the change address (label 0)');
  assert.equal(change[0].sats, 100_000 - 10_000 - b.fee);
  for (const p of people) { p.scanner.scanTx(json); assert.equal(p.coins.shielded.filter((c) => c.txid === b.txid).length, 1); }
});

test('Signet: tsp1 addresses', async () => {
  const people = Array.from({ length: 3 }, () => recipient('signet'));
  const A = sender('signet');
  fundPublic(A, [50_000]);
  const b = await A.airdrop.build({ from: 'public', text: people.map((p) => p.account.shieldAddr()).join('\n'), each: 1_500, rate: 1 });
  assert.equal(b.count, 3);
  const json = asEsplora(b.hex, [A.coins.public[0]]);
  for (const p of people) { p.scanner.scanTx(json); assert.equal(p.coins.shielded.filter((c) => c.txid === b.txid).length, 1); }
});

test('clear errors: nothing found, too little each, too many people, not enough balance', async () => {
  const A = sender();
  fundPublic(A, [10_000]);
  const one = recipient().account.shieldAddr();
  await assert.rejects(() => A.airdrop.build({ from: 'public', text: 'gm', each: 1000, rate: 1 }), /No Shielded addresses/);
  await assert.rejects(() => A.airdrop.build({ from: 'public', text: one, each: MIN_EACH - 1, rate: 1 }), /at least/);
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, () => sp.encodeAddress(mulG(rnd()), mulG(rnd()), 'main')).join('\n');
  await assert.rejects(() => A.airdrop.build({ from: 'public', text: many, each: 1000, rate: 1 }), /Up to 500/);
  const ten = Array.from({ length: 10 }, () => sp.encodeAddress(mulG(rnd()), mulG(rnd()), 'main')).join('\n');
  await assert.rejects(() => A.airdrop.build({ from: 'public', text: ten, each: 1000, rate: 1 }), /Not enough Public balance/);
});
