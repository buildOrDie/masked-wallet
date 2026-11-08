// Instant (pre-signed) RGB listings: the seller signs once, a buyer completes it with the seller offline. Stand-in
// engine and block server; the signature and PSBT checks themselves are Rust (engine/masked-swap.patch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';
import { exactCoinFor, freeSellerCoinFor, b64 } from '../src/rgb/swap.mjs';

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
const T = (c) => c.repeat(64);
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const unspent = (c, vout, allocs, sats = 1000) => ({ utxo: { colorable: true, outpoint: { txid: T(c), vout }, btcAmount: sats }, rgbAllocations: allocs });
const tok = (n, assetId = ASSET, settled = true) => ({ assetId, settled, assignment: { Fungible: n } });

test('exactCoinFor: only an output holding exactly the amount of this one asset, settled', () => {
  const list = [
    unspent('a', 0, [tok(600)]),
    unspent('b', 0, [tok(500), tok(5, 'rgb:otherAsset000000000')]),
    unspent('c', 0, [tok(500, ASSET, false)]),
    unspent('d', 1, [tok(300), tok(200)]),
  ];
  assert.equal(exactCoinFor(list, ASSET, 500)?.outpoint, `${T('d')}:1`, 'two allocations of the same asset adding up count');
  assert.equal(exactCoinFor(list, ASSET, 500, new Set([`${T('d')}:1`])), null, 'a reserved output is skipped');
  assert.equal(exactCoinFor(list, ASSET, 600)?.outpoint, `${T('a')}:0`);
  assert.equal(freeSellerCoinFor(list, ASSET, 550, new Set([`${T('a')}:0`])), null, 'normal swaps never take an Instant output');
});

function fakeLib(net) {
  const WasmWallet = {
    newSwapPsbt: (ins, outs) => JSON.stringify({ ins: ins.map((i) => i.outpoint), outs }),
    psbtTxid: () => T('7'),
    witnessSealScript: (inv) => `5120seal${inv.slice(-4)}`,
    presignedListingInfo: (p) => { if (String(p).startsWith('signed:')) return {}; if (String(p).startsWith('old:')) throw new Error('old layout'); const j = JSON.parse(p); if (!j.sig) throw new Error('the seller\'s signature is not valid'); return j.info; },
    presignedBuyPsbt: (tpl, ins, seal, change) => JSON.stringify({ tpl: JSON.parse(tpl), ins, seal, change }),
    checkPresignedFinal: (tpl, hexTx, seal) => { const j = JSON.parse(hexTx); if (j.seal !== seal) throw new Error('the seal does not pay the buyer'); return T('f'); },
    completePresignedConsignment: (bytes, tt, hexTx) => enc({ ...JSON.parse(new TextDecoder().decode(bytes)), final: true }),
  };
  class WasmInvoice { constructor(i) { this.i = i; } invoiceData() { return { recipientId: 'rid', network: 'signet', transportEndpoints: [] }; } free() {} }
  return { WasmWallet, WasmInvoice, inspectSwapConsignment: (bytes, txid, network, vout) => ({ ...JSON.parse(new TextDecoder().decode(bytes)), vout, txid }), net };
}

function wallet({ name, rgb = [], coins = [], lib, chain }) {
  const w = new LiteWallet(lib, { network: 'signet', indexerUrl: 'https://esplora.test', transportEndpoint: 'https://proxy.iriswallet.com/0.2/json-rpc', mnemonic: 'x', dataDir: name });
  const log = [];
  let n = 0;
  w.w = {
    listUnspents: () => rgb, listUnspentsVanilla: async () => coins, sync: async () => {}, flush: async () => {}, getAddress: async () => 'tb1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxv7y8h',
    witnessReceive: () => ({ invoice: `rgb:inv-${name}-${++n}abcd`, recipientId: `rid${n}`, expirationTimestamp: 1, batchTransferIdx: n }),
    listAssets: () => ({}), listTransfers: () => [], rotateAddress: () => {},
    colorSwap: async (online, psbt, assetId, amount, rid, vout) => { log.push(['colorSwap', JSON.parse(psbt).ins, String(amount), vout]); return psbt; },
    signPsbt: (p) => p,
    sendEnd: async () => { log.push(['sendEnd']); return { txid: T('5') }; },
    presignSale: async (online, assetId, amount, outpoint, payout, price) => { log.push(['presign', outpoint, String(amount), String(price)]); return { psbt: `signed:${outpoint}`, consignment: [1, 2, 3], templateTxid: T('6'), sellerOutpoint: outpoint, sellerSats: 1000 }; },
    setReservedOutpoints: (l) => { log.push(['reserve', [...l].sort()]); },
    markOutpointSpent: (op) => { log.push(['spent', op]); return true; },
    postOwnConsignment: async (url, rid, bytes, txid, vout) => { log.push(['post', rid, txid, vout, JSON.parse(new TextDecoder().decode(bytes)).final]); },
  };
  w.online = { id: 1 };
  w.outpointInfo = async (op) => chain.outs[op] || (() => { throw new Error(`no ${op}`); })();
  w.ownScript = async () => '5120own';
  w.extractHex = (p) => JSON.stringify({ seal: JSON.parse(p).seal });
  const mem = {};
  const store = { get: (k) => mem[k] || null, set: (k, v) => { mem[k] = v; }, del: (k) => { delete mem[k]; }, all: () => mem };
  return { w, store, mem, log };
}
function fakeChain() {
  const chain = { outs: {}, spends: {}, posted: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url).replace('https://esplora.test', '');
    let q;
    if (init.method === 'POST' && u === '/tx') { chain.posted.push(init.body); return new Response(T('f')); }
    if ((q = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(u))) return Response.json(chain.spends[`${q[1]}:${q[2]}`] || { spent: false });
    return new Response('not found', { status: 404 });
  };
  return chain;
}

test('seller: an exact output is signed at once and reserved; a sale on chain is noticed', async () => {
  const chain = fakeChain();
  const coin = `${T('a')}:0`;
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('a', 0, [tok(500)])] });
  const v = await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2, market: 'https://maskedwallet.com', token: 'ab'.repeat(24) }, s.store);
  assert.equal(v.stage, 'ready');
  assert.equal(v.sellerOutpoint, coin);
  assert.equal(v.consignment, b64(Uint8Array.from([1, 2, 3])));
  assert.deepEqual(s.log.find((x) => x[0] === 'presign'), ['presign', coin, '500', '20000']);
  assert.deepEqual(s.log.findLast((x) => x[0] === 'reserve'), ['reserve', [coin]]);
  assert.equal(s.mem.sw0123456789ab.market, 'https://maskedwallet.com', 'kept to publish later');
  // listing again returns the same signed listing
  assert.equal((await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000' }, s.store)).psbt, v.psbt);
  assert.equal(s.log.filter((x) => x[0] === 'presign').length, 1);

  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), [], 'not bought yet');
  chain.spends[coin] = { spent: true, txid: T('f') };
  const ch = await s.w.instantProgress(s.store, s.store.all());
  assert.deepEqual(ch, [{ offerId: 'sw0123456789ab', stage: 'sold', txid: T('f') }]);
  assert.deepEqual(s.log.find((x) => x[0] === 'spent'), ['spent', coin], 'the sold output leaves the balance');
  assert.deepEqual(s.log.findLast((x) => x[0] === 'reserve'), ['reserve', []]);
  assert.equal(s.mem.sw0123456789ab.psbt, undefined, 'the signed listing is forgotten once sold');
});

test('seller: tokens sharing an output move first, then the listing is signed; cancel moves it again', async () => {
  const chain = fakeChain();
  const from = `${T('b')}:0`, fee = `${T('c')}:2`;
  chain.outs[from] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const rgb = [unspent('b', 0, [tok(800)])];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb, coins: [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }] });
  const v = await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 }, s.store);
  assert.equal(v.stage, 'moving'); assert.equal(v.txid, T('5'));
  const [, ins, amount, vout] = s.log.find((x) => x[0] === 'colorSwap');
  assert.deepEqual(ins, [from, fee]); assert.equal(amount, '500'); assert.equal(vout, 1);
  const moved = `${T('5')}:1`;
  assert.deepEqual(s.log.findLast((x) => x[0] === 'reserve'), ['reserve', [moved]], 'the new output is promised before it settles');
  // not settled yet: nothing to sign
  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), []);
  // settled: the moved output holds exactly 500, the rest went back elsewhere
  rgb.splice(0, 1, unspent('5', 1, [tok(500)]), unspent('9', 0, [tok(300)]));
  const ch = await s.w.instantProgress(s.store, s.store.all());
  assert.equal(ch[0].stage, 'ready'); assert.equal(ch[0].sellerOutpoint, moved);
  // cancel: moves the signed output to a fresh one (a transaction), then the cancel is noticed on chain
  chain.outs[moved] = { sats: 1000, script: '5120rgb', tx: 'cc' };
  const c = await s.w.instantCancel({ offerId: 'sw0123456789ab', feeRate: 2 }, s.store);
  assert.equal(c.stage, 'cancelling');
  assert.deepEqual(s.log.filter((x) => x[0] === 'colorSwap').at(-1)[1], [moved, fee]);
  assert.deepEqual(s.log.findLast((x) => x[0] === 'reserve'), ['reserve', []]);
  chain.spends[moved] = { spent: true, txid: T('5') };
  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), [{ offerId: 'sw0123456789ab', stage: 'cancelled', txid: T('5') }]);
});

test('buyer: checks price, signature, output, tokens; pays, broadcasts, hands the transfer to the wallet', async () => {
  const chain = fakeChain();
  const seller = `${T('a')}:0`, coin = `${T('d')}:1`;
  chain.outs[seller] = { sats: 1000, script: '5120sell' };
  chain.outs[coin] = { sats: 30000, script: '5120buy', tx: 'dd' };
  const info = { sellerOutpoint: seller, sellerSats: 1000, sellerScript: '5120sell', payoutSats: 21000, opretScript: '6a20', templateTxid: T('6') };
  const listing = { psbt: JSON.stringify({ sig: true, info }), consignment: b64(enc({ valid: true, contractId: ASSET, sealAmount: 500 })), templateTxid: T('6') };
  const offer = { offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };
  const mk = () => wallet({ name: 'buyer', lib: fakeLib(), chain, coins: [{ outpoint: coin, txout: { value: 30000 }, is_spent: false }] });

  const b = mk();
  const r = await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store);
  assert.equal(r.txid, T('f'));
  assert.equal(chain.posted.length, 1, 'broadcast once');
  assert.deepEqual(b.log.find((x) => x[0] === 'post'), ['post', 'rid1', T('f'), 2, true], 'the completed transfer, for its own invoice, seal output 2');
  assert.equal(b.mem[offer.offerId].posted, true);
  assert.equal((await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing }, b.store)).txid, T('f'));
  assert.equal(chain.posted.length, 1, 'a retry never pays twice');

  // refusals: nothing is paid
  const cases = [
    [{ ...listing, psbt: JSON.stringify({ sig: false, info }) }, offer, /signature is not valid/],
    [listing, { ...offer, priceSats: '19000' }, /signed price/],
    [{ ...listing, consignment: b64(enc({ valid: true, contractId: ASSET, sealAmount: 499 })) }, offer, /gives you 499/],
    [{ ...listing, consignment: b64(enc({ valid: true, contractId: 'rgb:otherAsset000000000', sealAmount: 500 })) }, offer, /another token/],
    [{ ...listing, templateTxid: T('0') }, offer, /does not match/],
  ];
  for (const [l, o, msg] of cases) {
    const x = mk(); const before = chain.posted.length;
    await assert.rejects(x.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer: o, listing: l, feeRate: 2 }, x.store), msg);
    assert.equal(chain.posted.length, before);
  }
  // bought or cancelled already
  chain.spends[seller] = { spent: true, txid: T('e') };
  const y = mk();
  await assert.rejects(y.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, y.store), /just bought/);
});

test('without the listing engine, Instant calls say MASKED needs an update', async () => {
  const w = new LiteWallet({ WasmWallet: {} }, { network: 'signet', indexerUrl: 'x', transportEndpoint: 'https://p', mnemonic: 'x', dataDir: 'd' });
  w.w = {}; w.online = {};
  await assert.rejects(w.instantList({ offerId: 'a', assetId: ASSET, amount: '1', priceSats: '1000' }, {}), /Instant listings/);
  await assert.rejects(w.instantBuy({ offerId: 'a', offer: {} }, {}), /Instant listings/);
});

test('extractHex: a finalized PSBT with an OP_RETURN and a SIGHASH_SINGLE|ANYONECANPAY input becomes the raw transaction', async () => {
  const btc = await import('@scure/btc-signer');
  const { base64, hex } = await import('@scure/base');
  const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
  const p2tr = new Uint8Array([0x51, 0x20, ...hex.decode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')]);
  tx.addInput({ txid: T('a'), index: 0, witnessUtxo: { script: p2tr, amount: 1000n } });
  tx.addInput({ txid: T('b'), index: 1, witnessUtxo: { script: p2tr, amount: 30000n } });
  tx.addOutput({ script: p2tr, amount: 21000n });
  tx.addOutput({ script: new Uint8Array([0x6a, 0x20, ...new Uint8Array(32).fill(9)]), amount: 0n });
  tx.addOutput({ script: p2tr, amount: 1000n });
  tx.updateInput(0, { finalScriptWitness: [new Uint8Array(65).fill(0x83)] }, true);
  tx.updateInput(1, { finalScriptWitness: [new Uint8Array(64).fill(1)] }, true);
  const w = new LiteWallet({ WasmWallet: {} }, { network: 'signet', indexerUrl: 'x', transportEndpoint: 'https://p', mnemonic: 'x', dataDir: 'd' });
  const out = w.extractHex(base64.encode(tx.toPSBT()));
  const back = btc.Transaction.fromRaw(hex.decode(out), { allowUnknownOutputs: true });
  assert.equal(back.inputsLength, 2); assert.equal(back.outputsLength, 3);
  assert.equal(hex.encode(back.getInput(0).finalScriptWitness[0]).slice(-2), '83');
});

test('Instant purchases and moves put 330 sats on the seal (taproot dust), the four-step swaps keep 1,000', async () => {
  const { INSTANT_SEAL_SATS, SEAL_SATS } = await import('../src/rgb/swap.mjs');
  assert.equal(INSTANT_SEAL_SATS, 330);
  assert.equal(SEAL_SATS, 1000);
});

test('assetList: every token held, with the most one offer can sell, leaving out outputs promised to Instant listings', async () => {
  const lib = fakeLib();
  const s = wallet({ name: 'seller', lib, chain: fakeChain(), rgb: [unspent('a', 0, [tok(500)]), unspent('b', 0, [tok(200)]), unspent('c', 0, [tok(9, 'rgb:otherAsset000000000')])] });
  s.w.listAssets = async () => ({ nia: [{ assetId: ASSET, ticker: 'PIZZA', name: 'Pizza', precision: 0, balance: { spendable: 700 } }, { assetId: 'rgb:otherAsset000000000', ticker: 'X', name: 'X', precision: 2, balance: { spendable: 9 } }, { assetId: 'rgb:emptyAsset000000000', ticker: 'E', name: 'E', precision: 0, balance: { spendable: 0 } }], ifa: [] });
  s.w.reserve([`${T('a')}:0`]);
  const list = await s.w.assetList();
  assert.deepEqual(list.map((x) => [x.ticker, x.spendable, x.max]), [['PIZZA', '700', '200'], ['X', '9', '9']]);
});

test('a listing signed in an older layout is flagged once, so the seller cancels and lists again', async () => {
  const s = wallet({ name: 'seller', lib: fakeLib(), chain: fakeChain() });
  s.store.set('sw0123456789ab', { role: 'seller', stage: 'ready', psbt: 'old:x', coin: `${T('a')}:0`, assetId: ASSET, amount: '1', priceSats: '1000' });
  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), [{ offerId: 'sw0123456789ab', stage: 'outdated' }]);
  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), [], 'said once');
});

test('payCoinsFor: a confirmed coin first, else unconfirmed change, else several coins with their extra fee', async () => {
  const { payCoinsFor } = await import('../src/rgb/swap.mjs');
  const c = (ch, sats) => ({ outpoint: `${T(ch)}:0`, txout: { value: sats }, is_spent: false });
  const confirmed = [c('1', 3000)], all = [c('1', 3000), c('2', 9000), c('3', 4000)];
  assert.deepEqual(payCoinsFor(confirmed, all, 2000n).coins.map((x) => x.outpoint), [`${T('1')}:0`], 'the confirmed one is enough');
  assert.deepEqual(payCoinsFor(confirmed, all, 5000n).coins.map((x) => x.outpoint), [`${T('2')}:0`], 'unconfirmed change, one coin');
  const two = payCoinsFor(confirmed, all, 11000n, 100n);
  assert.deepEqual(two.coins.map((x) => x.outpoint), [`${T('2')}:0`, `${T('3')}:0`]); assert.equal(two.total, 13000n);
  assert.equal(payCoinsFor(confirmed, all, 15700n, 100n).coins.length, 3, 'all three, counting two extra inputs');
  assert.equal(payCoinsFor(confirmed, all, 15800n, 100n), null, 'not enough once the extra inputs pay their fee');
});

test('buyer: pays with two coins when one is not enough', async () => {
  const chain = fakeChain();
  const seller = `${T('a')}:0`, c1 = `${T('d')}:1`, c2 = `${T('e')}:0`;
  chain.outs[seller] = { sats: 1000, script: '5120sell' };
  chain.outs[c1] = { sats: 15000, script: '5120buy', tx: 'dd' };
  chain.outs[c2] = { sats: 9000, script: '5120buy', tx: 'ee' };
  const info = { sellerOutpoint: seller, sellerSats: 1000, sellerScript: '5120sell', payoutSats: 21000, opretScript: '6a20', templateTxid: T('6') };
  const listing = { psbt: JSON.stringify({ sig: true, info }), consignment: b64(enc({ valid: true, contractId: ASSET, sealAmount: 500 })), templateTxid: T('6') };
  const offer = { offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };
  const b = wallet({ name: 'buyer', lib: fakeLib(), chain, coins: [{ outpoint: c1, txout: { value: 15000 }, is_spent: false }, { outpoint: c2, txout: { value: 9000 }, is_spent: false }] });
  let built;
  b.w.lib.WasmWallet.presignedBuyPsbt = (tpl, ins, seal, change) => { built = { ins, change }; return JSON.stringify({ seal }); };
  await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store);
  assert.deepEqual(built.ins.map((i) => i.outpoint), [c1, c2]);
  // 24000 in − 20000 price − 330 seal − 640 fee − 116 for the second input
  assert.equal(built.change.sats, 24000 - 20000 - 330 - 640 - 116);
});
