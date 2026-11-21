// Wallet-to-wallet swaps in UniSat's P2P flow (2.31), with a stand-in engine: the colouring, the commitment and the
// hold are Rust (engine/masked-b5.patch tests); this checks what the wallet asks of them and refuses on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { createHash } from 'node:crypto';
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
import { schnorr } from '@noble/curves/secp256k1';
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
const T = (c) => c.repeat(64);
const NET = btc.TEST_NETWORK;
const key = (b) => schnorr.getPublicKey(new Uint8Array(32).fill(b));
const script = (b) => hex.encode(btc.p2tr(key(b), undefined, NET).script);
const addressOf = (b) => btc.p2tr(key(b), undefined, NET).address;

// a real PSBT from { outpoint, sats, script } inputs and { script, sats } outputs, OP_RETURN first (like the engine)
function psbtOf(ins, outs, opret = '6a') {
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
  for (const i of ins) { const [txid, vout] = i.outpoint.split(':'); tx.addInput({ txid, index: Number(vout), witnessUtxo: { script: hex.decode(i.script), amount: BigInt(i.sats) } }); }
  tx.addOutput({ script: hex.decode(opret), amount: 0n });
  for (const o of outs) tx.addOutput({ script: hex.decode(o.script), amount: BigInt(o.sats) });
  return base64.encode(tx.toPSBT());
}
const txOf = (b64) => btc.Transaction.fromPSBT(base64.decode(b64), { allowUnknownOutputs: true, allowUnknownInputs: true });
const txidOf = (b64) => hex.encode(sha256(sha256(txOf(b64).unsignedTx)).reverse());

function lib() {
  class WasmInvoice { constructor(s) { this.s = s; } invoiceData() { return { network: 'Signet', recipientId: this.s.includes('wvout') ? 'sb:wvout:x' : 'sb:utxob:x', assignment: { Fungible: 500 }, transportEndpoints: ['rpcs://proxy.test/json-rpc'] }; } free() {} }
  const WasmWallet = {
    newSwapPsbt: (ins, outs) => psbtOf(ins, outs),
    psbtOutpoints: (p) => { const t = txOf(p); return Array.from({ length: t.inputsLength }, (_, i) => { const x = t.getInput(i); return `${hex.encode(x.txid)}:${x.index}`; }); },
    psbtTxid: (p) => txidOf(p),
    verifySwapPsbt: (p, ins, outs, fee) => {
      const t = txOf(p);
      if (JSON.stringify(WasmWallet.psbtOutpoints(p)) !== JSON.stringify(ins)) throw new Error('inputs differ');
      if (t.outputsLength !== outs.length + 1) throw new Error('outputs differ');
      outs.forEach((o, k) => { const g = t.getOutput(k + 1); if (Number(g.amount) !== o.sats || (o.script && hex.encode(g.script) !== o.script)) throw new Error(`output ${k + 1} differs`); });
      let i = 0n; for (let k = 0; k < t.inputsLength; k++) i += t.getInput(k).witnessUtxo.amount;
      let o = 0n; for (let k = 0; k < t.outputsLength; k++) o += t.getOutput(k).amount;
      if (i - o !== BigInt(fee)) throw new Error(`fee ${i - o}, agreed ${fee}`);
    },
    p2pPsbtHash: (h) => hex.encode(sha256(hex.decode(h))),
    p2pCompletePsbt: (a, b) => `${a}|${b}`,
  };
  return { WasmWallet, WasmInvoice };
}

function party(name, { rgb = [], coins = [], chain = {} } = {}) {
  const L = lib();
  const w = new LiteWallet(L, { network: 'signet', indexerUrl: 'https://esplora.test', transportEndpoint: 'https://proxy.test/json-rpc', mnemonic: 'x', dataDir: name });
  const calls = [];
  const holds = { ids: [], released: [] };
  w.w = {
    colorSwap: async () => { throw new Error('not this flow'); },
    colorP2pSwap: async (online, psbt, assetId, amount, invoice, changeVout) => { calls.push({ color: { assetId, amount: String(amount), invoice, changeVout } }); return { psbt: psbtOf(txIns(psbt), txOuts(psbt), `6a20${'11'.repeat(32)}`), txid: txidOf(psbtOf(txIns(psbt), txOuts(psbt), `6a20${'11'.repeat(32)}`)), transferId: 'tr1', senderPubkey: 'ab'.repeat(32) }; },
    publishP2pSwap: async (online, txid) => { calls.push({ publish: txid }); },
    setSwapHolds: (ids) => { holds.ids = ids; },
    heldSwap: () => w.held || null,
    releaseSwapHold: (rid, sig, hash) => { if (sig !== 'cd'.repeat(64)) throw new Error('the seller\'s commitment is not valid'); holds.released.push({ rid, hash }); },
    p2pCommit: (txid, h) => ({ signature: 'cd'.repeat(64), transferId: 'tr1', senderPubkey: 'ab'.repeat(32), txid, psbtHash: hex.encode(sha256(hex.decode(h))) }),
    sendEnd: async (online, full) => { calls.push({ sendEnd: full }); return { txid: 'x', batchTransferIdx: 7 }; },
    signPsbt: (p) => { calls.push({ signed: name }); return p; },
    listUnspents: () => rgb, sync: async () => {}, refresh: async () => { calls.push({ refresh: true }); }, flush: async () => {},
    failTransfers: async (o, i) => { calls.push({ fail: i }); return true; }, abandonColoring: (t) => calls.push({ abandon: t }),
  };
  w.online = { id: 1 };
  w.save = async () => {};
  w.requireInSync = async () => {};
  w.outpointInfo = async (op) => chain[op] || (op === `${T('d')}:2` ? { sats: 600, script: script(6) } : { sats: 10_000, script: script(5) });
  w.ownScript = async () => script(name === 'seller' ? 7 : 9);
  w.payoutScript = async () => script(name === 'seller' ? 7 : 9);
  w.ownOutpoints = async () => new Set([...rgb.map((u) => `${u.utxo.outpoint.txid}:${u.utxo.outpoint.vout}`), ...coins.map((c) => c.outpoint)]);
  w.btcCoins = async () => ({ all: coins, confirmed: coins });
  w.onchainReceive = async (o) => { calls.push({ invoice: o }); return { invoice: 'rgb:~/~/~/sb:utxob:abc', recipientId: 'rid1', batchTransferIdx: 3 }; };
  const mem = {};
  const store = { get: (k) => mem[k] || null, set: (k, v) => { mem[k] = v; }, del: (k) => { delete mem[k]; }, all: () => mem };
  return { w, store, mem, calls, holds };
}
const txIns = (p) => { const t = txOf(p); return Array.from({ length: t.inputsLength }, (_, i) => { const x = t.getInput(i); return { outpoint: `${hex.encode(x.txid)}:${x.index}`, sats: Number(x.witnessUtxo.amount), script: hex.encode(x.witnessUtxo.script) }; }); };
const txOuts = (p) => { const t = txOf(p); return Array.from({ length: t.outputsLength - 1 }, (_, i) => { const o = t.getOutput(i + 1); return { script: hex.encode(o.script), sats: Number(o.amount) }; }); };
const seal = { outpoint: `${T('d')}:2`, sats: 600, script: script(6) };
const sellerRgb = (amount, extra = []) => [{ utxo: { colorable: true, outpoint: { txid: T('d'), vout: 2 }, btcAmount: 600 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: amount } }, ...extra] }];
const seller = { sealTxid: T('d'), sealVout: 2, sealSatoshis: 600, sealScriptPubKey: script(6), address: addressOf(7) };

test('P2P buy: a blinded invoice, held from the start, and UniSat\'s draft layout', async () => {
  const b = party('buyer', { coins: [{ outpoint: `${T('b')}:0`, txout: { value: 30_000 }, is_spent: false }], chain: { [`${T('b')}:0`]: { sats: 30_000, script: script(9) } } });
  const out = await b.w.p2pBuyPrepare({ tradeId: 't1', assetId: ASSET, amount: '500', priceSats: '20000', seller, feeRate: 1 }, b.store);
  assert.equal(b.calls[0].invoice.witness, false, 'a blinded invoice (what UniSat\'s sellers pay)');
  assert.deepEqual(b.holds.ids, ['rid1'], 'held: accepted only after the seller commits');
  const d = base64.encode(hex.decode(out.draftPsbtHex));
  assert.deepEqual(txIns(d).map((x) => x.outpoint), [`${T('d')}:2`, `${T('b')}:0`], 'the seller\'s output first, then the buyer\'s coins');
  const outs = txOuts(d);
  assert.deepEqual(outs[0], { script: script(7), sats: 20000 }, 'output 1 pays the seller the price');
  assert.equal(outs.length, 2, 'no change output for a whole lot');
  assert.equal(txOf(d).getOutput(0).script[0], 0x6a, 'output 0 the OP_RETURN placeholder');
  // asked again (a retry): the same draft
  assert.equal((await b.w.p2pBuyPrepare({ tradeId: 't1', assetId: ASSET, amount: '500', priceSats: '20000', seller }, b.store)).draftPsbtHex, out.draftPsbtHex);
  // a partial buy: 600 sats back to the seller's output script for the rest of its tokens
  const p = party('buyer', { coins: [{ outpoint: `${T('b')}:0`, txout: { value: 30_000 }, is_spent: false }] });
  const o2 = await p.w.p2pBuyPrepare({ tradeId: 't2', assetId: ASSET, amount: '500', priceSats: '20000', seller, partial: true, sealAmount: '800' }, p.store);
  assert.deepEqual(txOuts(base64.encode(hex.decode(o2.draftPsbtHex)))[1], { script: script(6), sats: 600 });
  // not enough bitcoin: the invoice is dropped, nothing held
  const poor = party('buyer', { coins: [{ outpoint: `${T('b')}:0`, txout: { value: 20_500 }, is_spent: false }] });
  await assert.rejects(poor.w.p2pBuyPrepare({ tradeId: 't3', assetId: ASSET, amount: '500', priceSats: '20000', seller }, poor.store), /needs about/);
  assert.deepEqual(poor.holds.ids, []);
  assert.ok(poor.calls.some((c) => c.fail === 3));
});

test('P2P sale: the seller colours, posts, signs only a draft that pays it', async () => {
  const s = party('seller', { rgb: sellerRgb(500) });
  const draft = (outs) => hex.encode(base64.decode(psbtOf([seal, { outpoint: `${T('b')}:0`, sats: 30000, script: script(9) }], outs)));
  const args = { tradeId: 't1', assetId: ASSET, amount: '500', priceSats: '20000', invoice: 'rgb:~/~/~/sb:utxob:abc' };
  await assert.rejects(s.w.p2pSaleSign({ ...args, draftPsbtHex: draft([{ script: script(7), sats: 19000 }, { script: script(9), sats: 10000 }]) }, s.store), /pay you the price/);
  await assert.rejects(s.w.p2pSaleSign({ ...args, draftPsbtHex: draft([{ script: script(8), sats: 20000 }, { script: script(9), sats: 9000 }]) }, s.store), /pay you the price/);
  await assert.rejects(s.w.p2pSaleSign({ ...args, invoice: 'rgb:~/~/~/sb:wvout:abc', draftPsbtHex: draft([{ script: script(7), sats: 20000 }]) }, s.store), /blinded/);
  const notMine = hex.encode(base64.decode(psbtOf([{ outpoint: `${T('e')}:0`, sats: 600, script: script(7) }], [{ script: script(7), sats: 20000 }])));
  await assert.rejects(s.w.p2pSaleSign({ ...args, draftPsbtHex: notMine }, s.store), /your RGB output first/);
  const out = await s.w.p2pSaleSign({ ...args, draftPsbtHex: draft([{ script: script(7), sats: 20000 }, { script: script(9), sats: 9000 }]) }, s.store);
  assert.deepEqual(s.calls.find((c) => c.color).color, { assetId: ASSET, amount: '500', invoice: args.invoice, changeVout: null });
  assert.ok(s.calls.findIndex((c) => c.publish) < s.calls.findIndex((c) => c.signed), 'posted to the buyer\'s server, then signed');
  assert.equal(out.transferId, 'tr1');
  assert.match(out.makerSignedPsbtHex, /^[0-9a-f]+$/); assert.match(out.coloredPsbtHex, /^[0-9a-f]+$/);
  // the rest of the tokens: only with an output for them
  const r = party('seller', { rgb: sellerRgb(800) });
  await assert.rejects(r.w.p2pSaleSign({ ...args, draftPsbtHex: draft([{ script: script(7), sats: 20000 }, { script: script(9), sats: 9000 }]) }, r.store), /rest of your tokens/);
  await r.w.p2pSaleSign({ ...args, draftPsbtHex: draft([{ script: script(7), sats: 20000 }, { script: script(6), sats: 600 }, { script: script(9), sats: 8400 }]) }, r.store);
  assert.equal(r.calls.find((c) => c.color).color.changeVout, 2);
  // another token on the same output: refused
  const m = party('seller', { rgb: sellerRgb(500, [{ assetId: 'rgb:other', settled: true, assignment: { Fungible: 1 } }]) });
  await assert.rejects(m.w.p2pSaleSign({ ...args, draftPsbtHex: draft([{ script: script(7), sats: 20000 }]) }, m.store), /other tokens/);
});

test('P2P buy sign: only the held transfer, for this transaction and amount, and the draft\'s outputs', async () => {
  const b = party('buyer', { coins: [{ outpoint: `${T('b')}:0`, txout: { value: 30_000 }, is_spent: false }], chain: { [`${T('b')}:0`]: { sats: 30_000, script: script(9) } } });
  const { draftPsbtHex } = await b.w.p2pBuyPrepare({ tradeId: 't1', assetId: ASSET, amount: '500', priceSats: '20000', seller }, b.store);
  const draft = base64.encode(hex.decode(draftPsbtHex));
  const colored = psbtOf(txIns(draft), txOuts(draft), `6a20${'11'.repeat(32)}`);
  const coloredHex = hex.encode(base64.decode(colored)), txid = txidOf(colored);
  b.w.held = null;
  await assert.rejects(b.w.p2pBuySign({ tradeId: 't1', coloredPsbtHex: coloredHex }, b.store), /hasn't arrived/);
  b.w.held = { txid: T('0'), assetId: ASSET, amount: '500' };
  await assert.rejects(b.w.p2pBuySign({ tradeId: 't1', coloredPsbtHex: coloredHex }, b.store), /another transaction/);
  b.w.held = { txid, assetId: ASSET, amount: '499' };
  await assert.rejects(b.w.p2pBuySign({ tradeId: 't1', coloredPsbtHex: coloredHex }, b.store), /gives you 499/);
  b.w.held = { txid, assetId: ASSET, amount: '500' };
  await assert.rejects(b.w.p2pBuySign({ tradeId: 't1', coloredPsbtHex: coloredHex, txid: T('1') }, b.store), /doesn't match/);
  const outs = txOuts(draft);
  const greedy = psbtOf(txIns(draft), [outs[0], { script: script(7), sats: outs[1].sats }], `6a20${'11'.repeat(32)}`);
  b.w.held = { txid: txidOf(greedy), assetId: ASSET, amount: '500' };
  await assert.rejects(b.w.p2pBuySign({ tradeId: 't1', coloredPsbtHex: hex.encode(base64.decode(greedy)) }, b.store), /differs/);
  b.w.held = { txid, assetId: ASSET, amount: '500' };
  const out = await b.w.p2pBuySign({ tradeId: 't1', coloredPsbtHex: coloredHex, txid }, b.store);
  assert.equal(out.txid, txid);
  assert.equal(b.mem.t1.psbtHash, hex.encode(sha256(hex.decode(out.buyerSignedPsbt))), 'the hash the seller commits to');
});

test('P2P commit and accept: the same transaction, then the hold is released by a valid commitment only', async () => {
  const s = party('seller', { rgb: sellerRgb(500) });
  const draft = hex.encode(base64.decode(psbtOf([seal, { outpoint: `${T('b')}:0`, sats: 30000, script: script(9) }], [{ script: script(7), sats: 20000 }, { script: script(9), sats: 9500 }])));
  const sale = await s.w.p2pSaleSign({ tradeId: 't1', assetId: ASSET, amount: '500', priceSats: '20000', invoice: 'rgb:~/~/~/sb:utxob:abc', draftPsbtHex: draft }, s.store);
  const other = hex.encode(base64.decode(psbtOf([seal], [{ script: script(7), sats: 1 }])));
  await assert.rejects(s.w.p2pSaleCommit({ tradeId: 't1', buyerSignedPsbtHex: other }, s.store), /different transaction/);
  const c = await s.w.p2pSaleCommit({ tradeId: 't1', buyerSignedPsbtHex: sale.coloredPsbtHex }, s.store);
  assert.ok(s.calls.some((x) => x.sendEnd), 'the complete transaction is registered before committing');
  assert.deepEqual(Object.keys(c).sort(), ['buyerSignedPsbtHash', 'commitment', 'proxyTransferId', 'senderPublicKey', 'txid']);
  assert.equal(c.proxyTransferId, 'tr1');
  assert.deepEqual(await s.w.p2pSaleCommit({ tradeId: 't1', buyerSignedPsbtHex: sale.coloredPsbtHex }, s.store), c, 'a retry gives the same commitment, no second send');
  assert.equal(s.calls.filter((x) => x.sendEnd).length, 1);

  const b = party('buyer');
  b.store.set('t1', { role: 'buyer', assetId: ASSET, amount: '500', recipientId: 'rid1', psbtHash: 'ee'.repeat(32), txid: sale.txid, at: Date.now() });
  b.w.held = { txid: sale.txid };
  await assert.rejects(b.w.p2pBuyAccept({ tradeId: 't1', commitment: '00'.repeat(64) }, b.store), /not valid/);
  assert.deepEqual(b.holds.ids, ['rid1'], 'still held');
  await b.w.p2pBuyAccept({ tradeId: 't1', commitment: c.commitment }, b.store);
  assert.deepEqual(b.holds.released, [{ rid: 'rid1', hash: 'ee'.repeat(32) }], 'checked against the PSBT this wallet signed');
  assert.deepEqual(b.holds.ids, [], 'released: the refresh accepts it');
  assert.ok(b.calls.some((x) => x.refresh));
});

test('P2P cancel: the seller drops its colouring, the buyer its invoice and hold', async () => {
  const s = party('seller');
  s.store.set('t1', { role: 'seller', txid: T('9'), at: Date.now() });
  await s.w.p2pCancel({ tradeId: 't1' }, s.store);
  assert.ok(s.calls.some((c) => c.abandon === T('9')));
  const b = party('buyer');
  b.store.set('t2', { role: 'buyer', recipientId: 'rid1', batchTransferIdx: 3, at: Date.now() });
  await b.w.p2pCancel({ tradeId: 't2' }, b.store);
  assert.ok(b.calls.some((c) => c.fail === 3));
  assert.deepEqual(b.holds.ids, []);
  b.store.set('t3', { role: 'buyer', recipientId: 'rid2', accepted: true, at: Date.now() });
  await assert.rejects(b.w.p2pCancel({ tradeId: 't3' }, b.store), /already accepted/);
});

test('P2P requests from a site: checked for shape, each opens the wallet', async () => {
  const { makeHandler } = await import('../src/dapp/requests.mjs');
  const SITE = 'https://rgbp2p.test';
  const opened = [];
  const handle = makeHandler({
    getPublic: async () => ({ net: 'signet', address: 'tb1pexample', publicKey: '02' + 'ab'.repeat(32) }),
    getTrade: async () => null,
    getSites: async () => ({ [SITE]: { connectedAt: 1 } }),
    setSites: async () => {},
    openApproval: async (origin, method, params) => { opened.push({ method, params }); return 'ok'; },
    emitTo: () => {},
  });
  const base = { offerId: 't1', offer: { assetId: ASSET, amount: '500', priceSats: '20000' }, network: 'signet' };
  await handle(SITE, 'rgbP2pList', { ...base, partial: true });
  assert.deepEqual([opened[0].method, opened[0].params.partial], ['rgbP2pList', true]);
  await handle(SITE, 'rgbP2pBuyPrepare', { ...base, seller, feeRate: 2 });
  assert.equal(opened[1].params.seller.sealScriptPubKey, script(6));
  await assert.rejects(handle(SITE, 'rgbP2pBuyPrepare', { ...base, seller: { ...seller, sealTxid: 'nope' } }), /sealTxid/);
  await assert.rejects(handle(SITE, 'rgbP2pBuyPrepare', { ...base }), /seller/);
  await assert.rejects(handle(SITE, 'rgbP2pSaleSign', { ...base, invoice: 'x', draftPsbtHex: 'ab' }), /invoice/);
  await assert.rejects(handle(SITE, 'rgbP2pSaleSign', { ...base, invoice: 'rgb:x', draftPsbtHex: 'xyz' }), /hex/);
  await handle(SITE, 'rgbP2pSaleSign', { ...base, invoice: 'rgb:x', draftPsbtHex: 'ABCD' });
  assert.equal(opened.at(-1).params.draftPsbtHex, 'abcd');
  await assert.rejects(handle(SITE, 'rgbP2pBuyAccept', { ...base, commitment: 'ab' }), /signature/);
  await handle(SITE, 'rgbP2pBuyAccept', { ...base, backendCommit: 'cd'.repeat(64) });
  assert.equal(opened.at(-1).params.commitment, 'cd'.repeat(64), 'UniSat\'s field name works too');
  for (const m of ['rgbP2pBuySign', 'rgbP2pSaleCommit']) await assert.rejects(handle(SITE, m, { ...base }), /missing/);
  await handle(SITE, 'rgbP2pSaleFinish', base); await handle(SITE, 'rgbP2pCancel', base);
  assert.deepEqual(opened.slice(-2).map((x) => x.method), ['rgbP2pSaleFinish', 'rgbP2pCancel']);
  // a site that isn't connected: refused before the wallet opens
  await assert.rejects(handle('https://other.test', 'rgbP2pList', base));
});
