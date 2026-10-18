// The Lightning receive flow on the real wallet services: create an invoice, Boltz locks the bitcoin, the
// wallet waits for a confirmation, claims with Boltz (or alone), and the normal Shielded scan picks the coin up.
// Boltz is played by boltz-core; the blockchain servers by a fetch mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bech32 } from '@scure/base';
import { Musig, SwapTreeSerializer, TaprootUtils, reverseSwapTree } from 'boltz-core';
import { walletApp, testKeys, mockFetch } from './helpers/wallet-app.mjs';
import { toHex, fromHex } from '../src/core/bytes.mjs';
import { RawTransaction } from '../src/bitcoin/RawTransaction.mjs';
import { p2trScript, trAddress } from '../src/bitcoin/taproot.mjs';
import { decodeInvoice } from '../src/lightning/bolt11.mjs';
import { parseTx } from '../src/lightning/reverse-swap.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const TIP = 920_000;
const PAIR = { hash: 'pairhash', rate: 1, limits: { minimal: 25_000, maximal: 25_000_000 }, fees: { percentage: 0.25, minerFees: { lockup: 231, claim: 150 } } };

function makeInvoice(sats, paymentHash) {
  const ts = []; let t = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 7; i++) { ts.unshift(t & 31); t = Math.floor(t / 32); }
  const field = (type, words) => [type, words.length >> 5, words.length & 31, ...words];
  return bech32.encode(`lnbc${sats * 10}n`, [...ts, ...field(1, bech32.toWords(paymentHash)), ...field(6, [0, 28, 8]), ...new Array(104).fill(0)], 10_000);
}

/** Boltz, as far as one reverse swap goes. */
class FakeBoltz {
  constructor({ cooperate = true, cheat = null } = {}) { this.cooperate = cooperate; this.cheat = cheat; this.swaps = new Map(); this.claimCalls = 0; }
  async reversePair() { return PAIR; }
  async createReverse({ invoiceAmount, preimageHash, claimPublicKey, pairHash }) {
    assert.equal(pairHash, PAIR.hash);
    const priv = secp256k1.utils.randomPrivateKey(), pub = secp256k1.getPublicKey(priv, true);
    const claimPub = fromHex(claimPublicKey), timeout = TIP + 144;
    const tree = reverseSwapTree(false, fromHex(preimageHash), claimPub, pub, timeout);
    const musig = TaprootUtils.tweakMusig(Musig.create(priv, [pub, claimPub]), tree.tree);
    const onchain = invoiceAmount - Math.ceil(invoiceAmount * 0.0025) - 231;
    const id = `sw${this.swaps.size}`;
    const res = {
      id, invoice: makeInvoice(invoiceAmount, fromHex(preimageHash)), swapTree: SwapTreeSerializer.serializeSwapTree(tree),
      lockupAddress: trAddress(hex(musig.aggPubkey), 'bc'), refundPublicKey: hex(pub), timeoutBlockHeight: timeout, onchainAmount: onchain,
    };
    if (this.cheat === 'address') res.lockupAddress = trAddress(toHex(randomBytes(32)), 'bc');
    this.swaps.set(id, { res, musig, status: 'swap.created', spk: p2trScript(hex(musig.aggPubkey)), onchain, preimageHash, claimPublicKey });
    return res;
  }
  /** The payer pays; Boltz locks the bitcoin on-chain. */
  pay(id) {
    const s = this.swaps.get(id);
    const tx = new RawTransaction({ inputs: [{ txid: toHex(randomBytes(32)), vout: 0, value: s.onchain + 9000, scriptPubKey: p2trScript(toHex(randomBytes(32))) }], outputs: [{ value: 8000, script: p2trScript(toHex(randomBytes(32))) }, { value: s.onchain, script: s.spk }] });
    s.lockupHex = tx.toHex([[new Uint8Array(64)]]);
    s.lockupTxid = parseTx(s.lockupHex).txid;
    s.status = 'transaction.mempool';
    return s;
  }
  async status(id) { const s = this.swaps.get(id); return { status: s.status, transaction: s.lockupTxid ? { id: s.lockupTxid } : undefined }; }
  async lockupTransaction(id) { const s = this.swaps.get(id); return { id: s.lockupTxid, hex: s.lockupHex, timeoutBlockHeight: TIP + 144 }; }
  async claimSignature(id, { transaction, preimage, pubNonce }) {
    this.claimCalls++;
    const s = this.swaps.get(id);
    if (!this.cooperate) throw new Error('Boltz: not now');
    assert.equal(hex(await crypto.subtle.digest('SHA-256', fromHex(preimage))), s.preimageHash, 'preimage sent to Boltz matches');
    const tx = parseTx(transaction);
    assert.equal(tx.outputs.length, 1);
    // Boltz signs the claim's sighash (the wallet's RawTransaction computes it the same way)
    const msg = this.sighashOf(transaction, s);
    const signed = s.musig.message(msg).generateNonce().aggregateNonces([[fromHex(this.claimPubOf(s)), fromHex(pubNonce)]]).initializeSession().signPartial();
    s.status = 'invoice.settled';
    return { pubNonce: hex(signed.publicNonce), partialSignature: hex(signed.ourPartialSignature) };
  }
  claimPubOf(s) { return s.claimPublicKey; }
  sighashOf(txHex, s) {
    // rebuild from the unsigned claim: one input (the lockup), outputs as sent
    const b = fromHex(txHex);
    const prevTxid = toHex(b.slice(5, 37).reverse()), vout = new DataView(b.buffer, b.byteOffset + 37, 4).getUint32(0, true);
    const seq = new DataView(b.buffer, b.byteOffset + 42, 4).getUint32(0, true);
    const out = parseTx(txHex).outputs;
    const tx = new RawTransaction({ inputs: [{ txid: prevTxid, vout, value: s.onchain, scriptPubKey: s.spk, sequence: seq }], outputs: out });
    return tx.sighash(0);
  }
  async broadcast() { throw new Error('not used'); }
}

/** The blockchain servers: tip, fees, tx status, broadcast, and the claim read back for the scanner. */
function chain(boltz) {
  const seen = new Map(); // txid → hex
  const confirmed = new Set();
  const calls = mockFetch(async (url, init) => {
    if (url.endsWith('blocks/tip/height')) return String(TIP);
    if (url.includes('v1/fees')) return { fastestFee: 6, halfHourFee: 4, hourFee: 3, economyFee: 2, minimumFee: 1 };
    if (init?.method === 'POST' && url.endsWith('/api/tx')) { const h = String(init.body); const id = parseTx(h).txid; seen.set(id, h); return id; }
    let m = url.match(/tx\/([0-9a-f]{64})\/status$/);
    if (m) {
      const lock = [...boltz.swaps.values()].find((s) => s.lockupTxid === m[1]);
      if (lock) return { confirmed: confirmed.has(m[1]) };
      if (seen.has(m[1])) return { confirmed: confirmed.has(m[1]) };
      return new Response('Transaction not found', { status: 404 });
    }
    m = url.match(/tx\/([0-9a-f]{64})$/);
    if (m && seen.has(m[1])) return esploraJson(seen.get(m[1]), boltz);
    return new Response('not found', { status: 404 });
  });
  return { seen, confirmed, calls };
}

/** Esplora's JSON for a claim we broadcast (prevout and witness included, as the scanner needs them). */
function esploraJson(h, boltz) {
  const b = fromHex(h);
  const prevTxid = toHex(b.slice(7, 39).reverse()); // segwit marker + flag after the version
  const vout = new DataView(b.buffer, b.byteOffset + 39, 4).getUint32(0, true);
  const lock = [...boltz.swaps.values()].find((s) => s.lockupTxid === prevTxid);
  // witness: after outputs; parse simply by walking
  let i = 4 + 2 + 1 + 36 + 1 + 4;
  const nOut = b[i++]; const outs = [];
  for (let k = 0; k < nOut; k++) { const v = Number(new DataView(b.buffer, b.byteOffset + i, 8).getBigUint64(0, true)); i += 8; const l = b[i++]; outs.push({ value: v, scriptpubkey: toHex(b.slice(i, i + l)) }); i += l; }
  const items = b[i++], witness = [];
  for (let k = 0; k < items; k++) { const l = b[i++]; witness.push(toHex(b.slice(i, i + l))); i += l; }
  return { txid: parseTx(h).txid, vin: [{ txid: prevTxid, vout, scriptsig: '', witness, prevout: { scriptpubkey: toHex(lock.spk), value: lock.onchain } }], vout: outs, status: { confirmed: false } };
}

function setup(opts) {
  globalThis.localStorage.clear();
  const app = walletApp(testKeys({ bSpend: 0xabcdef0123n * 7919n, fundingPriv: '11'.repeat(32) }), 'main');
  app.state.lockState = 'open';
  const boltz = new FakeBoltz(opts);
  app.lightning.api = boltz;
  const net = chain(boltz);
  return { app, boltz, net };
}

for (const cooperate of [true, false]) {
  test(`Lightning → Shielded, ${cooperate ? 'claimed with Boltz (key path)' : 'Boltz silent (script path)'}`, async () => {
    const { app, boltz, net } = setup({ cooperate });
    const ln = app.lightning;
    const est = (await ln.loadPair(true), ln.estimate(100_000));
    assert.equal(est.boltzFee, 250);

    const rec = await ln.create(100_000);
    assert.equal(rec.state, 'created');
    assert.equal(decodeInvoice(rec.invoice).sats, 100_000);
    assert.ok(!JSON.stringify(ln.list()).includes(app.account.keys.bSpend.toString(16).padStart(64, '0')), 'no keys in the record');

    await ln.tick();
    assert.equal(ln.get(rec.id).state, 'created', 'nothing happens before the payment');

    const s = boltz.pay(rec.id);
    await ln.tick();
    assert.equal(ln.get(rec.id).state, 'paid');

    // Boltz says confirmed, our servers do not yet: still waiting
    s.status = 'transaction.confirmed';
    await ln.tick();
    assert.equal(ln.get(rec.id).state, 'paid');
    assert.equal(boltz.claimCalls, 0, 'preimage not revealed before our own servers see the confirmation');

    net.confirmed.add(s.lockupTxid);
    await ln.tick();
    const done = ln.get(rec.id);
    assert.equal(done.state, 'claimed');
    assert.equal(done.path, cooperate ? 'key' : 'script');
    assert.ok(net.seen.has(done.claimTxid), 'claim broadcast');
    assert.equal(done.received, s.onchain - ln.claimFee());

    // the ordinary Shielded scan found the coin, with a key that spends it
    const coin = app.coins.shielded.find((c) => c.txid === done.claimTxid);
    assert.ok(coin, 'coin in the Shielded balance');
    assert.equal(coin.sats, done.received);
    const priv = app.account.keys.outputPriv(coin.tweak);
    assert.equal(toHex(secp256k1.getPublicKey(fromHex(priv), true).slice(1)), coin.output);

    net.confirmed.add(done.claimTxid);
    await ln.tick();
    assert.equal(ln.get(rec.id).state, 'done');
    assert.equal(ln.get(rec.id).claimHex, undefined);
  });
}

test('a lockup address that does not match is refused before any invoice is shown', async () => {
  const { app } = setup({ cheat: 'address' });
  await assert.rejects(() => app.lightning.create(100_000), /Lockup address/);
  assert.equal(app.lightning.list().length, 0);
});

test('amount limits and network', async () => {
  const { app } = setup();
  await assert.rejects(() => app.lightning.create(10_000), /smallest/);
  await assert.rejects(() => app.lightning.create(30_000_000), /largest/);
  app.state.net = 'signet';
  assert.equal(app.lightning.available, false);
});

test('expired invoices close', async () => {
  const { app, boltz } = setup();
  const rec = await app.lightning.create(50_000);
  boltz.swaps.get(rec.id).status = 'swap.expired';
  await app.lightning.tick();
  assert.equal(app.lightning.get(rec.id).state, 'expired');
});
