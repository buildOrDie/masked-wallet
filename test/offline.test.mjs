// Offline send on the real wallet services: a wallet signs a payment without internet, the receiver (or the
// sender) sends it once online, and the receiver's Shielded scan finds the coin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { walletApp, testKeys, mockFetch } from './helpers/wallet-app.mjs';
import { toHex } from '../src/core/bytes.mjs';
import { RawTransaction } from '../src/bitcoin/RawTransaction.mjs';
import { findTxHex, parseTx } from '../src/bitcoin/parseTx.mjs';
import { OfflinePayments } from '../src/wallet/OfflinePayments.mjs';

const setOnline = (on) => Object.defineProperty(globalThis, 'navigator', { value: { onLine: on }, configurable: true, writable: true });

function senderApp() {
  globalThis.localStorage.clear();
  const app = walletApp(testKeys({ bSpend: 0x1111n * 7919n, fundingPriv: '22'.repeat(32) }), 'main');
  app.state.lockState = 'open';
  app.toast = () => {};
  const f = app.account.funding();
  const coin = { key: `fund:${'ab'.repeat(32)}:0`, kind: 'funding', txid: 'ab'.repeat(32), vout: 0, sats: 500_000, output: f.outputX, privKey: f.outputPriv, address: f.address, pending: false };
  app.coins.public = [coin];
  app.ord.put(`${coin.txid}:0`, { ins: 0, runes: 0, at: Date.now() }); // checked earlier, while online
  return { app, coin };
}

function receiverApp() {
  const app = walletApp(testKeys({ bSpend: 0x3333n * 104729n, fundingPriv: '44'.repeat(32) }), 'main');
  app.state.lockState = 'open';
  app.toast = () => {};
  return app;
}

/** Esplora's JSON for a transaction, with the prevout the scanner needs. */
function esploraJson(hex, prev) {
  const tx = parseTx(hex);
  return {
    txid: tx.txid, status: { confirmed: false },
    vin: tx.inputs.map((i) => ({ txid: i.txid, vout: i.vout, scriptsig: '', witness: i.witness.map(toHex), prevout: { scriptpubkey: '5120' + prev.output, value: prev.sats } })),
    vout: tx.outputs.map((o) => ({ scriptpubkey: toHex(o.script), value: o.value })),
  };
}

test('parseTx reads what RawTransaction writes, and refuses junk', () => {
  const tx = new RawTransaction({ inputs: [{ txid: 'cd'.repeat(32), vout: 3, value: 1000, scriptPubKey: new Uint8Array(34) }], outputs: [{ value: 600, script: Uint8Array.from([0x51, 0x20, ...new Array(32).fill(7)]) }] });
  const hex = tx.toHex([[new Uint8Array(64)]]);
  const p = parseTx(hex);
  assert.equal(p.txid, tx.txid);
  assert.deepEqual(p.inputs.map((i) => [i.txid, i.vout]), [['cd'.repeat(32), 3]]);
  assert.equal(p.outputs[0].value, 600);
  assert.equal(p.vsize, 111); // one taproot input (key path), one taproot output
  assert.equal(findTxHex(`MASKED signed payment · 0.001 BTC\nOpen MASKED…:\n${hex.toUpperCase()}\n`), hex);
  assert.throws(() => parseTx(hex + '00'), /extra bytes/);
  assert.throws(() => parseTx(hex.slice(0, -10)), /cut short/);
  assert.throws(() => parseTx('zz'), /hex/);
  assert.equal(findTxHex('hello'), '');
});

test('sign offline, the receiver sends it, and it lands in their Shielded balance', async () => {
  const { app: A, coin } = senderApp();
  const B = receiverApp();
  setOnline(false);
  let calls = mockFetch(() => { throw new Error('Failed to fetch'); });

  // A is offline: the send still builds (cached fee rates, ord already checked) and is kept, not broadcast
  const built = await A.builder.send({ from: 'public', to: B.account.shieldAddr(), amount: 100_000, rate: A.fees.rates.normal });
  const p = A.offline.keepSigned(built);
  assert.equal(p.state, 'waiting');
  assert.deepEqual([...A.offline.reserved()], [coin.key]);
  assert.equal(A.coins.spendable('public').length, 0, 'the coin is held back: no double spend from this wallet');
  assert.equal(await A.offline.flush(), 0);

  // the text goes over a chat; B adds it while still offline
  const text = OfflinePayments.shareText(p);
  assert.ok(text.includes(built.hex));
  globalThis.localStorage.clear(); // B is another device
  const added = B.offline.addFromText(text);
  assert.equal(added.isNew, true);
  assert.equal(B.offline.waiting().length, 1);
  assert.equal(B.offline.addFromText(built.hex).isNew, false, 'the same payment twice is one payment');

  // B gets online first and sends it
  setOnline(true);
  const seen = new Map();
  calls = mockFetch((url, init) => {
    if (init?.method === 'POST' && url.endsWith('/api/tx')) { const h = String(init.body); seen.set(parseTx(h).txid, h); return parseTx(h).txid; }
    const m = url.match(/tx\/([0-9a-f]{64})$/);
    if (m && seen.has(m[1])) return esploraJson(seen.get(m[1]), coin);
    return new Response('not found', { status: 404 });
  });
  assert.equal(await B.offline.flush(), 1);
  assert.ok(seen.has(built.txid), 'broadcast');
  assert.equal(B.offline.get(built.txid).state, 'sent');
  const got = B.coins.shielded.find((c) => c.txid === built.txid);
  assert.ok(got, 'found by the Shielded scan');
  assert.equal(got.sats, 100_000);
  assert.ok(calls.length >= 2);
});

test('the sender comes online later: already on the network is fine, coins freed', async () => {
  const { app: A, coin } = senderApp();
  setOnline(false);
  mockFetch(() => { throw new Error('Failed to fetch'); });
  const built = await A.builder.send({ from: 'public', to: A.account.shieldAddr(), amount: 50_000, rate: 2 });
  A.offline.keepSigned(built);
  setOnline(true);
  mockFetch((url, init) => (init?.method === 'POST' ? new Response('sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', { status: 400 }) : new Response('nf', { status: 404 })));
  await A.offline.flush();
  assert.equal(A.offline.get(built.txid).state, 'sent');
  assert.ok(!A.coins.public.some((c) => c.key === coin.key), 'spent coin dropped');
  assert.equal(A.offline.reserved().size, 0);
});

test('coins spent elsewhere first: the payment is marked failed', async () => {
  const { app: A } = senderApp();
  const built = await A.builder.send({ from: 'public', to: A.account.shieldAddr(), amount: 50_000, rate: 2 });
  A.offline.keepSigned(built);
  setOnline(true);
  mockFetch((url, init) => (init?.method === 'POST' ? new Response('sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}', { status: 400 }) : new Response('nf', { status: 404 })));
  await A.offline.flush();
  const p = A.offline.get(built.txid);
  assert.equal(p.state, 'failed');
  assert.match(p.error, /already spent/);
  assert.equal(A.offline.reserved().size, 0, 'a failed payment no longer holds the coin');
});

test('bad text is refused with a clear message', () => {
  const B = receiverApp();
  assert.throws(() => B.offline.addFromText('gm ser'), /No signed payment/);
  assert.throws(() => B.offline.addFromText('ab'.repeat(80)), /transaction|cut short|inputs/i);
});
