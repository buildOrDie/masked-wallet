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
    presignedBuyPsbt: (tpl, ins, seal, change, sellerTx) => JSON.stringify({ tpl: JSON.parse(tpl), ins, seal, change, sellerTx }),
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
    presignSale: async (online, assetId, amount, outpoint, payout, price) => { log.push(['presign', outpoint, String(amount), String(price)]); log.push(['payout', payout]); return { psbt: `signed:${outpoint}`, consignment: [1, 2, 3], templateTxid: T('6'), sellerOutpoint: outpoint, sellerSats: 1000 }; },
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
    if (init.method === 'POST' && u === '/tx') {
      if (chain.reject) return new Response(chain.reject, { status: 400 });
      chain.posted.push(init.body); return new Response(T('f'));
    }
    // a transaction is known once something was broadcast (enough for these tests)
    // electrs: /status says {"confirmed":false} even for an unknown transaction; /hex is 404 until it has it
    if (/^\/tx\/[^/]+\/status$/.test(u)) return Response.json({ confirmed: false });
    if (/^\/tx\/[^/]+\/hex$/.test(u)) return chain.posted.length ? new Response('0200000001abcdef0123456789') : new Response('Transaction not found', { status: 404 });
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
  const coins = [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb, coins });
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
  // the move spent the first fee coin: the cancel pays from another one (never the one just spent)
  const fee2 = `${T('e')}:2`;
  chain.outs[fee2] = { sats: 5000, script: '5120btc', tx: 'ee' };
  coins.push({ outpoint: fee2, txout: { value: 5000 }, is_spent: false });
  const c = await s.w.instantCancel({ offerId: 'sw0123456789ab', feeRate: 2 }, s.store);
  assert.equal(c.stage, 'cancelling');
  assert.deepEqual(s.log.filter((x) => x[0] === 'colorSwap').at(-1)[1], [moved, fee2]);
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
  chain.outs[seller] = { sats: 1000, script: '5120sell', tx: 'a0' };
  chain.outs[c1] = { sats: 15000, script: '5120buy', tx: 'dd' };
  chain.outs[c2] = { sats: 9000, script: '5120buy', tx: 'ee' };
  const info = { sellerOutpoint: seller, sellerSats: 1000, sellerScript: '5120sell', payoutSats: 21000, opretScript: '6a20', templateTxid: T('6') };
  const listing = { psbt: JSON.stringify({ sig: true, info }), consignment: b64(enc({ valid: true, contractId: ASSET, sealAmount: 500 })), templateTxid: T('6') };
  const offer = { offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };
  const b = wallet({ name: 'buyer', lib: fakeLib(), chain, coins: [{ outpoint: c1, txout: { value: 15000 }, is_spent: false }, { outpoint: c2, txout: { value: 9000 }, is_spent: false }] });
  let built;
  b.w.lib.WasmWallet.presignedBuyPsbt = (tpl, ins, seal, change, sellerTx) => { built = { ins, change, sellerTx }; return JSON.stringify({ seal }); };
  await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store);
  assert.deepEqual(built.ins.map((i) => i.outpoint), [c1, c2]);
  assert.equal(built.sellerTx, 'a0', 'the seller\'s transaction goes with it: the engine signs only with it');
  // 24000 in − 20000 price − 330 seal − the fee for the real size (3 inputs, 4 outputs) at 2 sat/vB
  const { txVbytes, OPRET_SCRIPT, P2TR_SCRIPT } = await import('../src/rgb/swap.mjs');
  const vb = txVbytes(['5120sell', '5120buy', '5120buy'], [OPRET_SCRIPT, info.payoutScript || P2TR_SCRIPT, P2TR_SCRIPT, P2TR_SCRIPT]);
  assert.equal(built.change.sats, 24000 - 20000 - 330 - Math.ceil(2 * vb));
});

test('the consignment check is read whichever way the engine names its fields', async () => {
  const { inspected } = await import('../src/rgb/LiteWallet.mjs');
  assert.deepEqual(inspected({ valid: true, contract_id: ASSET, seal_amount: 500 }), { contractId: ASSET, sealAmount: 500 });
  assert.deepEqual(inspected({ valid: true, contractId: ASSET, sealAmount: 500 }), { contractId: ASSET, sealAmount: 500 });
  assert.deepEqual(inspected({ valid: true }), { contractId: '', sealAmount: null });
});

test('transaction sizes: an Instant purchase with one coin is about 298 vB, not the 320 vB budget', async () => {
  const { instantBuyVbytes, instantMoveVbytes, txVbytes, P2TR_SCRIPT, OPRET_SCRIPT } = await import('../src/rgb/swap.mjs');
  assert.equal(instantBuyVbytes(1, true), 298);   // 10.5 + 2 × 57.5 + 4 × 43
  assert.equal(instantBuyVbytes(1, false), 255);  // no change output
  assert.equal(instantBuyVbytes(2, true), 355);   // one more coin: + 57.5
  assert.equal(instantMoveVbytes(1), 255);
  assert.equal(txVbytes(['0014' + '00'.repeat(20)], [OPRET_SCRIPT, P2TR_SCRIPT]), Math.ceil(10.5 + 68 + 43 + 43), 'a P2WPKH input is bigger');
});

test('buyer: a purchase the network refuses is not paid and never shows as incoming tokens', async () => {
  const chain = fakeChain();
  chain.reject = 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}';
  const seller = `${T('a')}:0`, coin = `${T('d')}:1`;
  chain.outs[seller] = { sats: 1000, script: '5120sell' };
  chain.outs[coin] = { sats: 30000, script: '5120buy', tx: 'dd' };
  const info = { sellerOutpoint: seller, sellerSats: 1000, sellerScript: '5120sell', payoutSats: 21000, opretScript: '6a20', templateTxid: T('6') };
  const listing = { psbt: JSON.stringify({ sig: true, info }), consignment: b64(enc({ valid: true, contractId: ASSET, sealAmount: 500 })), templateTxid: T('6') };
  const offer = { offerId: 'sw0123456789cd', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };
  const b = wallet({ name: 'buyer', lib: fakeLib(), chain, coins: [{ outpoint: coin, txout: { value: 30000 }, is_spent: false }] });
  await assert.rejects(b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store), /can't be bought any more.*missingorspent.*Nothing was paid/);
  assert.ok(b.mem[offer.offerId].failed);
  // a refresh doesn't hand the wallet a transfer for it
  assert.equal(await b.w.instantPost(offer.offerId, b.store), false);
  assert.equal(b.log.filter((x) => x[0] === 'post').length, 0);
});

test('seller: "Finish listing" while the tokens move refreshes, signs if they arrived, else says why', async () => {
  const chain = fakeChain();
  const from = `${T('b')}:0`, fee = `${T('c')}:2`;
  chain.outs[from] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const rgb = [unspent('b', 0, [tok(800)])];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb, coins: [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }] });
  let refreshed = 0; s.w.w.refresh = async () => { refreshed++; return {}; };
  const args = { offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 };
  assert.equal((await s.w.instantList(args, s.store)).stage, 'moving');
  // asked again before a block: not ready, and it says the move waits for its block
  const prev = globalThis.fetch;
  let confirmed = false;
  globalThis.fetch = async (url, init) => /\/tx\/[0-9a-f]{64}$/.test(String(url)) ? Response.json({ status: { confirmed } }) : prev(url, init);
  let v = await s.w.instantList(args, s.store);
  assert.equal(v.stage, 'moving'); assert.match(v.waiting, /first block/); assert.equal(refreshed, 1);
  // in a block, proof taken in but not settled yet
  confirmed = true;
  rgb.splice(0, 1, unspent('5', 1, [{ ...tok(500), settled: false }]));
  v = await s.w.instantList(args, s.store);
  assert.match(v.waiting, /settle on the next refresh/);
  // settled: signed now, no second move
  rgb.splice(0, 1, unspent('5', 1, [tok(500)]));
  v = await s.w.instantList(args, s.store);
  assert.equal(v.stage, 'ready'); assert.equal(v.sellerOutpoint, `${T('5')}:1`);
  assert.equal(s.log.filter((x) => x[0] === 'colorSwap').length, 1);
  globalThis.fetch = prev;
});

test('instantAmounts: the amounts alone on a settled output of this asset, largest first; promised outputs left out', async () => {
  const { instantAmounts } = await import('../src/rgb/swap.mjs');
  const us = [unspent('a', 0, [tok(508)]), unspent('b', 0, [tok(191)]), unspent('c', 0, [tok(508)]), unspent('d', 0, [{ ...tok(40), settled: false }]), unspent('e', 0, [tok(70), { ...tok(5), assetId: 'rgb:other' }]), unspent('f', 1, [tok(900)])];
  assert.deepEqual(instantAmounts(us, ASSET, new Set([`${T('f')}:1`])), ['508', '191']);
});

test('seller: a listing the engine refuses to sign after the move says why, instead of waiting in silence', async () => {
  const chain = fakeChain();
  const from = `${T('b')}:0`, fee = `${T('c')}:2`;
  chain.outs[from] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const rgb = [unspent('b', 0, [tok(800)])];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb, coins: [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }] });
  await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 }, s.store);
  rgb.splice(0, 1, unspent('5', 1, [tok(500)]), unspent('9', 0, [tok(300)]));
  s.w.wallet.presignSale = async () => { throw new Error('that output can\'t be listed: it isn\'t a settled RGB output of this wallet'); };
  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), []);
  assert.match(s.store.get('sw0123456789ab').waiting, /couldn't sign this listing: that output can't be listed/);
  assert.equal(s.store.get('sw0123456789ab').stage, 'moving');
});

test('a listing whose transfer is in the old RGB format (signed before 2.29): the buyer is told, nothing paid; the seller is told to list again', async () => {
  const lib = fakeLib();
  lib.inspectSwapConsignment = () => { throw new Error('Internal error: Failed to load consignment: unsupported value `0` for enum `ConsignmentVersion`'); };
  const chain = fakeChain();
  const seller = `${T('a')}:0`;
  chain.outs[seller] = { sats: 1000, script: '5120sell', tx: 'a0' };
  const info = { sellerOutpoint: seller, sellerSats: 1000, sellerScript: '5120sell', payoutSats: 21000, opretScript: '6a20', templateTxid: T('6') };
  const listing = { psbt: JSON.stringify({ sig: true, info }), consignment: b64(new Uint8Array([0, 1, 2])), templateTxid: T('6') };
  const offer = { offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };
  const b = wallet({ name: 'buyer', lib, chain });
  await assert.rejects(b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store), /older than 2\.29.*Nothing was paid/);
  assert.equal(b.log.some((x) => x[0] === 'sendEnd' || x[0] === 'broadcast'), false);
  // the seller's own copy: flagged once, so the market says to cancel and list again
  const s = wallet({ name: 'seller', lib, chain });
  s.store.set('sw0123456789ab', { role: 'seller', stage: 'ready', psbt: listing.psbt, consignment: listing.consignment, templateTxid: T('6'), coin: seller, assetId: ASSET, amount: '500', priceSats: '20000' });
  assert.deepEqual(await s.w.instantProgress(s.store, s.store.all()), [{ offerId: 'sw0123456789ab', stage: 'outdated' }]);
});

test('a sale pays the Public address when it is set; without it, the RGB wallet (its bitcoin is for fees)', async () => {
  const pub = '5120' + 'ab'.repeat(32);
  const s = wallet({ name: 'seller', lib: fakeLib(), chain: fakeChain(), rgb: [unspent('a', 0, [tok(500)])] });
  s.w.setPayoutScript(pub);
  await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 }, s.store);
  assert.deepEqual(s.log.findLast((x) => x[0] === 'payout'), ['payout', pub]);
  assert.equal(s.store.get('sw0123456789ab').payoutPublic, true);
  // not a taproot script: ignored, the RGB wallet's own address is used
  const t = wallet({ name: 'seller', lib: fakeLib(), chain: fakeChain(), rgb: [unspent('a', 0, [tok(500)])] });
  t.w.setPayoutScript('0014' + 'cd'.repeat(20));
  await t.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 }, t.store);
  assert.notEqual(t.log.findLast((x) => x[0] === 'payout')[1], '0014' + 'cd'.repeat(20));
  assert.equal(t.store.get('sw0123456789ab').payoutPublic, false);
});

function buySetup() {
  const chain = fakeChain();
  const seller = `${T('a')}:0`, c1 = `${T('d')}:1`;
  chain.outs[seller] = { sats: 1000, script: '5120sell', tx: 'a0' };
  chain.outs[c1] = { sats: 30000, script: '5120buy', tx: 'dd' };
  const info = { sellerOutpoint: seller, sellerSats: 1000, sellerScript: '5120sell', payoutSats: 21000, opretScript: '6a20', templateTxid: T('6') };
  const listing = { psbt: JSON.stringify({ sig: true, info }), consignment: b64(enc({ valid: true, contractId: ASSET, sealAmount: 500 })), templateTxid: T('6') };
  const offer = { offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };
  const b = wallet({ name: 'buyer', lib: fakeLib(), chain, coins: [{ outpoint: c1, txout: { value: 30000 }, is_spent: false }] });
  b.w.recheckMs = 1;
  return { chain, b, offer, listing };
}

test('buyer: a purchase a server takes but none keeps is not reported as bought; nothing paid', async () => {
  const { chain, b, offer, listing } = buySetup();
  const prev = globalThis.fetch;
  // the server answers its txid, but the transaction is gone at once (for example it conflicts with its mempool)
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url).replace('https://esplora.test', '');
    if (init.method === 'POST' && u === '/tx') return new Response(T('f'));
    if (/\/hex$/.test(u)) return new Response('Transaction not found', { status: 404 });
    return prev(url, init);
  };
  await assert.rejects(b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store), /can't be bought any more.*Nothing was paid/);
  assert.match(b.store.get(offer.offerId).failed, /none kept it/);
  assert.ok(!b.store.get(offer.offerId).posted, 'the tokens are not expected');
  globalThis.fetch = prev; void chain;
});

test('buyer: a sent purchase is kept until it confirms; dropped, it is sent again; refused, it fails and says so', async () => {
  const { chain, b, offer, listing } = buySetup();
  b.w.postOwnV1 = async () => {}; // the transfer server
  const r = await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store);
  assert.ok(r.txid);
  const e = b.store.get(offer.offerId);
  assert.equal(e.posted, true); assert.ok(e.txHex, 'kept until it confirms');
  // the network dropped it: the next check sends it again
  chain.posted.length = 0;
  assert.equal(await b.w.purchaseProgress(offer.offerId, b.store.get(offer.offerId), b.store), null);
  assert.equal(chain.posted.length, 1, 'sent again');
  // dropped again, and now refused (its coin was spent by something else): failed, said once
  chain.posted.length = 0; chain.reject = 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}';
  b.store.set(offer.offerId, { ...b.store.get(offer.offerId), checkedAt: 0 });
  const c = await b.w.purchaseProgress(offer.offerId, b.store.get(offer.offerId), b.store);
  assert.equal(c.stage, 'purchase-failed'); assert.match(c.why, /missingorspent/);
  assert.equal(b.store.get(offer.offerId).txHex, undefined);
  assert.equal(await b.w.purchaseProgress(offer.offerId, b.store.get(offer.offerId), b.store), null, 'said once');
});

test('buyer: buying again after a purchase that never reached the network makes a new one (not the old txid)', async () => {
  const { chain, b, offer, listing } = buySetup();
  b.w.postOwnV1 = async () => {};
  // an earlier attempt: delivered to MASKED, its transaction gone and not kept (as MASKED before 2.29.9 left it)
  b.store.set(offer.offerId, { role: 'buyer', txid: 'e'.repeat(64), posted: true, at: 1 });
  const r = await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store);
  assert.notEqual(r.txid, 'e'.repeat(64), 'a new purchase');
  assert.equal(chain.posted.length, 1, 'and it was broadcast');
  // asked again while that one is on the network: the same purchase, nothing new
  const again = await b.w.instantBuy({ offerId: offer.offerId, network: 'Signet', offer, listing, feeRate: 2 }, b.store);
  assert.equal(again.txid, r.txid); assert.equal(chain.posted.length, 1);
});

test('seller: list in lots: one split to invoices of this wallet, then each lot signed on its own output', async () => {
  const chain = fakeChain();
  const rgb = [unspent('b', 0, [tok(1000)])];
  const lib = fakeLib();
  lib.WasmInvoice = class { constructor(i) { this.i = i; } invoiceData() { return { recipientId: `rid-${this.i}`, network: 'signet', transportEndpoints: [] }; } free() {} };
  const s = wallet({ name: 'seller', lib, chain, rgb });
  s.w.lotsStepByStep = false; // the one-transaction split, where an engine can do it
  const sent = [];
  s.w.w.sendBegin = async (online, map, donation, fee, minConf) => { sent.push({ map, donation, fee: String(fee), minConf }); return 'psbt-split'; };
  const failed = [];
  s.w.w.failTransfers = async (o, idx) => { failed.push(idx); };
  const lots = [0, 1, 2, 3].map((i) => ({ offerId: `swlot${i}0123456`, token: 'ab'.repeat(24), amount: '250', priceSats: '5000' }));
  const v = await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 3, market: 'https://maskedwallet.com' }, s.store);
  assert.equal(v.stage, 'moving'); assert.equal(v.lots.length, 4);
  assert.equal(sent.length, 1, 'one transaction for all the lots');
  const recips = sent[0].map[ASSET];
  assert.equal(recips.length, 4);
  assert.ok(recips.every((r) => r.assignment.Fungible === 250 && r.witnessData.amountSat === '330'));
  assert.equal(sent[0].donation, true, 'broadcast at once, no waiting for its own acceptance');
  assert.equal(new Set(recips.map((r) => r.recipientId)).size, 4, 'a fresh invoice per lot');
  for (const l of lots) { const e = s.mem[l.offerId]; assert.equal(e.stage, 'moving'); assert.equal(e.lotOf, T('5')); assert.equal(e.token, l.token); }
  // asked again (Finish listing) before the split settled: no second split
  s.w.w.refresh = async () => ({});
  assert.equal((await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 3, market: 'https://maskedwallet.com' }, s.store)).stage, 'moving');
  assert.equal(sent.length, 1);
  // the split settled: four outputs of 250 (and the change of nothing): each lot takes its own
  rgb.splice(0, rgb.length, unspent('5', 1, [tok(250)]), unspent('5', 2, [tok(250)]), unspent('5', 3, [tok(250)]), unspent('5', 4, [tok(250)]), unspent('9', 0, [tok(250)]));
  const changes = await s.w.instantProgress(s.store, s.store.all());
  assert.equal(changes.filter((c) => c.stage === 'ready').length, 4);
  const coins = lots.map((l) => s.mem[l.offerId].coin);
  assert.equal(new Set(coins).size, 4, 'four different outputs');
  assert.ok(coins.every((c) => c.startsWith(`${T('5')}:`)), 'only outputs of the split, never another output holding the same amount');
  assert.equal(failed.length, 0);
});

test('seller: a split into lots that fails cancels the invoices it made', async () => {
  const chain = fakeChain();
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('b', 0, [tok(1000)])] });
  s.w.lotsStepByStep = false; // the one-transaction split, where an engine can do it
  s.w.w.sendBegin = async () => { throw new Error('the block server is down'); };
  const failed = [];
  s.w.w.failTransfers = async (o, idx) => { failed.push(idx); };
  const lots = [0, 1].map((i) => ({ offerId: `swlot${i}0123456`, token: 'ab'.repeat(24), amount: '500', priceSats: '5000' }));
  await assert.rejects(s.w.instantListLots({ assetId: ASSET, lots, feeRate: 3, market: 'https://maskedwallet.com' }, s.store), /block server is down/);
  assert.deepEqual(failed, [1, 2]);
  assert.equal(Object.keys(s.mem).length, 0, 'nothing listed');
  await assert.rejects(s.w.instantListLots({ assetId: ASSET, lots: lots.map((l) => ({ ...l, amount: '600' })), feeRate: 3 }, s.store), /settled and free/);
});

test('requests: list in lots: 2 to 10 lots of one token, each with its market token', async () => {
  const { lotsParams, MAX_LOTS } = await import('../src/dapp/requests.mjs');
  const lot = (i) => ({ offerId: `swlot${i}`, token: 'ab'.repeat(24), amount: '100', priceSats: '1000' });
  const ok = lotsParams({ assetId: ASSET, lots: [lot(1), lot(2)], market: 'https://maskedwallet.com/', feeRate: 2 });
  assert.equal(ok.lots.length, 2); assert.equal(ok.market, 'https://maskedwallet.com'); assert.equal(ok.feeRate, 2);
  assert.throws(() => lotsParams({ assetId: ASSET, lots: [lot(1)], market: 'https://m.com' }), /2 to/);
  assert.throws(() => lotsParams({ assetId: ASSET, lots: Array.from({ length: MAX_LOTS + 1 }, (_, i) => lot(i)), market: 'https://m.com' }), /2 to/);
  assert.throws(() => lotsParams({ assetId: ASSET, lots: [lot(1), lot(1)], market: 'https://m.com' }), /twice/);
  assert.throws(() => lotsParams({ assetId: ASSET, lots: [lot(1), { ...lot(2), amount: '0' }], market: 'https://m.com' }), /above 0/);
  assert.throws(() => lotsParams({ assetId: ASSET, lots: [lot(1), lot(2)], market: 'http://evil.example' }), /https/);
});

test('seller: lots: a token output the bitcoin side doesn\'t know yet gets a full scan, then the split goes', async () => {
  const chain = fakeChain();
  const lib = fakeLib();
  lib.WasmInvoice = class { constructor(i) { this.i = i; } invoiceData() { return { recipientId: `rid-${this.i}`, network: 'signet', transportEndpoints: [] }; } free() {} };
  const s = wallet({ name: 'seller', lib, chain, rgb: [unspent('b', 0, [tok(1000)])] });
  s.w.lotsStepByStep = false; // the one-transaction split, where an engine can do it
  let tries = 0, scans = 0;
  s.w.w.fullScan = async () => { scans++; };
  s.w.w.sendBegin = async () => { if (++tries === 1) throw new Error('Internal error: Error from bdk adding UTXOs: UTXO not found in the internal database for txid: bf88'); return 'psbt-split'; };
  const lots = [0, 1].map((i) => ({ offerId: `swlot${i}0123456`, token: 'ab'.repeat(24), amount: '500', priceSats: '5000' }));
  const v = await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 2, market: 'https://maskedwallet.com' }, s.store);
  assert.equal(v.stage, 'moving'); assert.equal(scans, 1); assert.equal(tries, 2);
});

test('seller: a wallet behind the chain (an output it counts is spent) refreshes, then stops before signing', async () => {
  const chain = fakeChain();
  const rgb = [unspent('b', 0, [tok(1000)])];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb });
  chain.spends[`${T('b')}:0`] = { spent: true, txid: T('e') };
  let refreshed = 0; s.w.w.refresh = async () => { refreshed++; return {}; };
  const lots = [0, 1].map((i) => ({ offerId: `swlot${i}0123456`, token: 'ab'.repeat(24), amount: '500', priceSats: '5000' }));
  await assert.rejects(s.w.instantListLots({ assetId: ASSET, lots, feeRate: 2, market: 'https://maskedwallet.com' }, s.store), /behind the chain.*Nothing was sent/);
  assert.equal(refreshed, 1);
  assert.equal(Object.keys(s.mem).length, 0);
  await assert.rejects(s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 }, s.store), /behind the chain/);
  // the refresh caught up (the engine dropped the spent output): it goes on
  s.w.w.refresh = async () => { rgb.splice(0, 1, unspent('d', 1, [tok(1000)])); return {}; };
  s.w.w.sendBegin = async () => 'psbt';
  const lib2 = s.w.lib; lib2.WasmInvoice = class { constructor(i) { this.i = i; } invoiceData() { return { recipientId: `rid-${this.i}`, network: 'signet', transportEndpoints: [] }; } free() {} };
  assert.equal((await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 2, market: 'https://maskedwallet.com' }, s.store)).stage, 'moving');
});

test('seller: lots on outputs the engine\'s send can\'t spend: split step by step, one move per block, each lot then signed', async () => {
  const chain = fakeChain();
  const src = `${T('b')}:0`, fee = `${T('c')}:2`, fee2 = `${T('c')}:3`;
  chain.outs[src] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  chain.outs[fee2] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const rgb = [unspent('b', 0, [tok(1000)])];
  const coins = [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }, { outpoint: fee2, txout: { value: 5000 }, is_spent: false }];
  const lib = fakeLib();
  let txn = 0; lib.WasmWallet.psbtTxid = () => T(String(++txn % 10));
  const s = wallet({ name: 'seller', lib, chain, rgb, coins });
  s.w.w.fullScan = async () => {};
  s.w.w.refresh = async () => ({});
  s.w.w.failTransfers = async () => {};
  s.w.w.sendBegin = async () => { throw new Error('Internal error: Error from bdk adding UTXOs: UTXO not found in the internal database for txid: bf88'); };
  s.w.w.sendEnd = async () => ({ txid: '' });
  const lots = [0, 1].map((i) => ({ offerId: `swlot${i}0123456`, token: 'ab'.repeat(24), amount: '400', priceSats: '5000' }));
  const v = await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 2, market: 'https://maskedwallet.com' }, s.store);
  assert.equal(v.stage, 'moving'); assert.equal(v.stepByStep, true);
  const [a, b] = lots.map((l) => s.mem[l.offerId]);
  assert.equal(a.stage, 'moving'); assert.ok(a.coin, 'the first lot moved at once, to an output of its own');
  assert.equal(b.stage, 'queued', 'the second waits for the tokens\' change');
  assert.equal(s.log.filter((x) => x[0] === 'colorSwap').length, 1);
  // a refresh before the block: the source is spent, the change not settled: nothing moves
  rgb.splice(0, rgb.length, unspent(a.coin.split(':')[0].slice(0, 1), 1, [{ ...tok(400), settled: false }]));
  await s.w.instantProgress(s.store, s.store.all());
  assert.equal(s.mem[lots[1].offerId].stage, 'queued');
  assert.match(s.mem[lots[1].offerId].waiting, /previous lot/);
  // after the block: lot 1 settled on its output, the change (600) settled elsewhere: lot 2 moves, lot 1 is signed
  rgb.splice(0, rgb.length, { utxo: { colorable: true, outpoint: { txid: a.coin.split(':')[0], vout: 1 }, btcAmount: 330 }, rgbAllocations: [tok(400)] }, unspent('9', 0, [tok(600)]));
  chain.outs[`${T('9')}:0`] = { sats: 330, script: '5120rgb', tx: 'cc' };
  const changes = await s.w.instantProgress(s.store, s.store.all());
  assert.equal(s.mem[lots[0].offerId].stage, 'ready');
  assert.equal(s.mem[lots[1].offerId].stage, 'moving'); assert.ok(s.mem[lots[1].offerId].coin);
  assert.equal(s.log.filter((x) => x[0] === 'colorSwap').length, 2);
  assert.ok(changes.some((c) => c.offerId === lots[0].offerId && c.stage === 'ready'));
});

test('seller: an Instant listing bigger than any one output joins several outputs in its move', async () => {
  const chain = fakeChain();
  const fee = `${T('c')}:2`;
  for (const c of ['a', 'b', 'd']) chain.outs[`${T(c)}:0`] = { sats: 330, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const rgb = [unspent('a', 0, [tok(1000)]), unspent('b', 0, [tok(1000)]), unspent('d', 0, [tok(1000)])];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb, coins: [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }] });
  const v = await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '2500', priceSats: '20000', feeRate: 2 }, s.store);
  assert.equal(v.stage, 'moving');
  const cs = s.log.find((x) => x[0] === 'colorSwap');
  assert.equal(cs[1].filter((op) => op.endsWith(':0') && !op.startsWith(T('c'))).length, 3, 'all three token outputs go in, with the fee coin');
  assert.equal(cs[2], '2500');
  const { offerable } = await import('../src/rgb/swap.mjs');
  assert.deepEqual(offerable(rgb, ASSET), { total: '3000', max: '1000' }, 'Instant can list the total; a four-step swap one output');
});

test('seller: cancel a listing another copy of this wallet made, from its output, only if this wallet holds it', async () => {
  const chain = fakeChain();
  const coin = `${T('a')}:0`, fee = `${T('c')}:2`;
  chain.outs[coin] = { sats: 330, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('a', 0, [tok(500)])], coins: [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }] });
  const offer = { assetId: ASSET, amount: '500', priceSats: '20000' };
  await assert.rejects(s.w.instantCancel({ offerId: 'swother1234567', feeRate: 2 }, s.store), /no Instant listing/);
  await assert.rejects(s.w.instantCancel({ offerId: 'swother1234567', feeRate: 2, sellerOutpoint: `${T('d')}:0`, offer }, s.store), /doesn't hold that listing's tokens/);
  await assert.rejects(s.w.instantCancel({ offerId: 'swother1234567', feeRate: 2, sellerOutpoint: coin, offer: { ...offer, amount: '400' } }, s.store), /doesn't hold/);
  const v = await s.w.instantCancel({ offerId: 'swother1234567', feeRate: 2, sellerOutpoint: coin, offer }, s.store);
  assert.equal(v.stage, 'cancelling');
  assert.ok(s.log.some((x) => x[0] === 'colorSwap' && x[1].includes(coin)), 'the tokens moved off the listed output');
});

test('backup: Instant listings go with the RGB backup; loading it adds the other copy\'s, a newer entry wins', async () => {
  const { SignetWallet } = await import('../src/rgb/SignetWallet.mjs');
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const w = new SignetWallet({ storage, profile: { id: 'public-signet', vaultKey: 'v', sdk: {} }, loadSdk: async () => ({}) });
  const store = w.instantStore();
  store.set('mine', { role: 'seller', stage: 'ready', at: 100, coin: 'x:0' });
  store.set('old', { role: 'seller', stage: 'sold', at: 1 });
  store.set('pub', { role: 'seller', stage: 'ready', at: 50, published: true, consignment: 'BIG' });
  const b = w.instantForBackup();
  assert.ok(b.mine && !b.old, 'finished ones older than a week are left out');
  assert.equal(b.pub.consignment, undefined, "a published listing's proof stays with the market");
  w.mergeInstant({ mine: { role: 'seller', stage: 'ready', at: 50 }, theirs: { role: 'seller', stage: 'moving', at: 200 }, bad: { role: 'x' } });
  assert.equal(store.get('mine').at, 100, 'the newer entry here stays');
  assert.equal(store.get('theirs').stage, 'moving');
  assert.equal(store.get('bad'), null);
});

test('repair from the chain: outputs another copy spent are found, and marked spent only when asked', async () => {
  const chain = fakeChain();
  const rgb = [unspent('a', 0, [tok(1000)]), unspent('b', 1, [tok(500)])];
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb });
  s.w.w.refresh = async () => ({});
  chain.spends[`${T('b')}:1`] = { spent: true, txid: T('e') };
  const found = await s.w.repairFromChain();
  assert.deepEqual(found, [{ outpoint: `${T('b')}:1`, assets: [{ assetId: ASSET, amount: '500' }] }]);
  assert.equal(s.log.filter((x) => x[0] === 'spent').length, 0, 'only looked');
  await s.w.repairFromChain({ fix: true });
  assert.deepEqual(s.log.filter((x) => x[0] === 'spent'), [['spent', `${T('b')}:1`]]);
});

test('seller: the previous lot\'s own move (waiting for its block) isn\'t "behind the chain": the next lot goes ahead without its spent output', async () => {
  const chain = fakeChain();
  // the engine still counts the output lot 1's move spent (b:0, 500) next to the rest (c:2, 250, alone: lot 2)
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('b', 0, [tok(500)]), unspent('c', 2, [tok(250)])] });
  s.w.w.refresh = async () => ({});
  s.store.set('lot1', { role: 'seller', assetId: ASSET, amount: '250', priceSats: '5000', stage: 'moving', lotGroup: 'g1', lotNo: 0, lots: 2, at: 1, moveTxid: T('m'), coin: `${T('m')}:1` });
  s.store.set('lot2', { role: 'seller', assetId: ASSET, amount: '250', priceSats: '5000', stage: 'queued', lotGroup: 'g1', lotNo: 1, lots: 2, at: 1 });
  chain.spends[`${T('b')}:0`] = { spent: true, txid: T('m') }; // spent by this wallet's own lot move
  assert.deepEqual(await s.w.lotsAdvance(s.store, 'g1', 2), []);
  assert.equal(s.mem.lot2.stage, 'moving', 'not stopped as "behind the chain"');
  assert.equal(s.mem.lot2.coin, `${T('c')}:2`, 'the free output holding exactly the lot, never the spent one');
  assert.doesNotMatch(String(s.mem.lot2.waiting || ''), /behind the chain/);
  // a send (the engine picks the outputs): waits for that block instead of building on the spent output
  await assert.rejects(s.w.requireInSync(ASSET, undefined, { own: [T('m')] }), (e) => e.code === 'OWN_MOVE_PENDING');
});

test('seller: a lot never moves while the wallet is behind the chain; it waits and says why', async () => {
  const chain = fakeChain();
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('b', 0, [tok(1000)])] });
  s.w.w.refresh = async () => ({});
  s.store.set('lot1', { role: 'seller', assetId: ASSET, amount: '500', priceSats: '5000', stage: 'queued', lotGroup: 'g1', lotNo: 0, lots: 2, at: 1 });
  chain.spends[`${T('b')}:0`] = { spent: true, txid: T('e') };
  assert.deepEqual(await s.w.lotsAdvance(s.store, 'g1', 2), []);
  assert.equal(s.mem.lot1.stage, 'queued');
  assert.match(s.mem.lot1.waiting, /behind the chain/);
  assert.equal(s.log.filter((x) => x[0] === 'colorSwap').length, 0);
});

test('receive: a blind invoice is never made on an output the chain shows spent (a sale this copy missed): marked spent, made again on another', async () => {
  const chain = fakeChain();
  const s = wallet({ name: 'r', lib: fakeLib(), chain });
  let n = 0;
  const utxos = [`${T('4')}:0`, `${T('7')}:1`];
  const failed = [];
  s.w.w.blindReceive = () => ({ invoice: `rgb:blind-${++n}`, recipientId: `utxob:${n}`, expirationTimestamp: 1, batchTransferIdx: n });
  s.w.w.listTransfers = () => Array.from({ length: n }, (_, k) => ({ idx: k + 1, batchTransferIdx: k + 1, receiveUtxo: { txid: utxos[k].split(':')[0], vout: Number(utxos[k].split(':')[1]) } }));
  s.w.w.failTransfers = async (_o, idx) => { failed.push(idx); return true; };
  chain.spends[utxos[0]] = { spent: true, txid: T('2') }; // the first output the engine picks was sold already
  const r = await s.w.onchainReceive({ assetId: ASSET, amount: 1000 });
  assert.equal(r.invoice, 'rgb:blind-2');
  assert.deepEqual(failed, [1], 'the invoice on the spent output is cancelled');
  assert.deepEqual(s.log.filter((x) => x[0] === 'spent'), [['spent', utxos[0]]]);
});

test('lots all at once: each lot moves in a chain (the next from the previous change), then every lot is signed in the same approval', async () => {
  const chain = fakeChain();
  const from = `${T('b')}:0`, fee = `${T('c')}:2`;
  chain.outs[from] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 20000, script: '5120btc', tx: 'bb' };
  chain.outs[`${T('5')}:2`] = { sats: 18000, script: '5120own', tx: 'cc' }; // lot 1's move: the rest of the tokens and sats
  chain.outs[`${T('8')}:2`] = { sats: 16000, script: '5120own', tx: 'dd' };
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('b', 0, [tok(1500)])], coins: [{ outpoint: fee, txout: { value: 20000 }, is_spent: false }] });
  const moves = [T('5'), T('8'), T('9')];
  s.w.w.sendEnd = async () => { const txid = moves.shift(); s.log.push(['sendEnd', txid]); return { txid }; };
  let own = [];
  s.w.w.setOwnUnconfirmed = (l) => { own = [...l]; };
  s.w.w.setSwapChangeVout = (v) => { s.log.push(['changeVout', v]); };
  s.w.w.refresh = async () => { s.log.push(['refresh']); };
  const lots = ['a', 'b', 'c'].map((c) => ({ offerId: `sw${c.repeat(12)}`, token: 'ab'.repeat(24), amount: '500', priceSats: '5000' }));
  const r = await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 2, market: 'https://maskedwallet.com' }, s.store);

  const swaps = s.log.filter((x) => x[0] === 'colorSwap');
  assert.equal(swaps.length, 3, 'one move per lot, all now');
  assert.deepEqual(swaps[0][1], [from, fee], 'lot 1 from the tokens\' output, its fee from a bitcoin coin');
  assert.deepEqual(swaps[1][1], [`${T('5')}:2`], 'lot 2 from lot 1\'s change, which pays its own fee: no block to wait for');
  assert.deepEqual(swaps[2][1], [`${T('8')}:2`]);
  assert.deepEqual(own.sort(), [T('5'), T('8'), T('9')].sort(), 'the engine is told these unconfirmed moves are this wallet\'s own');
  assert.ok(s.log.some((x) => x[0] === 'refresh'), 'it takes in its own moves before signing');
  assert.deepEqual(s.log.filter((x) => x[0] === 'changeVout').map((x) => x[1]), [2, 2, 2], 'each move keeps the rest of the tokens on its own change output (where the next lot moves from)');
  assert.deepEqual(s.log.filter((x) => x[0] === 'presign').map((x) => x[1]), [`${T('5')}:1`, `${T('8')}:1`, `${T('9')}:1`], 'every lot signed on its own output');
  assert.equal(r.stage, 'ready');
  assert.deepEqual(r.lots.map((v) => v.stage), ['ready', 'ready', 'ready']);
  assert.deepEqual(r.lots.map((v) => v.sellerOutpoint), [`${T('5')}:1`, `${T('8')}:1`, `${T('9')}:1`]);
  assert.deepEqual(s.log.findLast((x) => x[0] === 'reserve')[1], [`${T('5')}:1`, `${T('8')}:1`, `${T('9')}:1`].sort(), 'every lot\'s output is promised');
});

test('lots all at once: a lot whose move fails is reported, the lots already moved stay listed', async () => {
  const chain = fakeChain();
  const from = `${T('b')}:0`, fee = `${T('c')}:2`;
  chain.outs[from] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 20000, script: '5120btc', tx: 'bb' };
  chain.outs[`${T('5')}:2`] = { sats: 18000, script: '5120own', tx: 'cc' };
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('b', 0, [tok(1000)])], coins: [{ outpoint: fee, txout: { value: 20000 }, is_spent: false }] });
  let n = 0;
  const color = s.w.w.colorSwap;
  s.w.w.colorSwap = async (...a) => { if (++n === 2) throw new Error('mempool chain too long'); return color(...a); };
  s.w.w.setOwnUnconfirmed = () => {};
  s.w.w.setSwapChangeVout = () => {};
  const lots = ['a', 'b'].map((c) => ({ offerId: `sw${c.repeat(12)}`, token: 'ab'.repeat(24), amount: '500', priceSats: '5000' }));
  const r = await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 2 }, s.store);
  assert.deepEqual(r.lots.map((v) => v.stage), ['ready', 'failed']);
  assert.match(r.lots[1].waiting, /Not listed: mempool chain too long/);
  assert.ok(!s.mem[lots[1].offerId], 'nothing kept for the lot that never moved');
});

test('a single listing that needs a move is signed right after it, when the engine lists its own unconfirmed moves', async () => {
  const chain = fakeChain();
  const from = `${T('b')}:0`, fee = `${T('c')}:2`;
  chain.outs[from] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 5000, script: '5120btc', tx: 'bb' };
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('b', 0, [tok(800)])], coins: [{ outpoint: fee, txout: { value: 5000 }, is_spent: false }] });
  let own = [];
  s.w.w.setOwnUnconfirmed = (l) => { own = [...l]; };
  s.w.w.setSwapChangeVout = () => {};
  s.w.w.refresh = async () => {};
  const v = await s.w.instantList({ offerId: 'sw0123456789ab', assetId: ASSET, amount: '500', priceSats: '20000', feeRate: 2 }, s.store);
  assert.equal(v.stage, 'ready', 'on sale at once, no block to wait for');
  assert.equal(v.sellerOutpoint, `${T('5')}:1`);
  assert.ok(own.includes(T('5')), 'the move is named as this wallet\'s own');
});

test('a move keeps a small RGB output for the rest of the tokens and sends the rest of the bitcoin back; an RGB output with enough sats pays its own fee', async () => {
  const chain = fakeChain();
  // 60 tokens on an RGB output that also holds 49,000 sats (an earlier move's change), and no other bitcoin at all
  const from = `${T('b')}:2`;
  chain.outs[from] = { sats: 49000, script: '5120rgb', tx: 'aa' };
  const lib = fakeLib();
  let outs;
  const make = lib.WasmWallet.newSwapPsbt;
  lib.WasmWallet.newSwapPsbt = (ins, o) => { outs = o; return make(ins, o); };
  const s = wallet({ name: 'seller', lib, chain, rgb: [unspent('b', 2, [tok(60)], 49000)], coins: [] });
  let vout;
  s.w.w.setSwapChangeVout = (v) => { vout = v; };
  const moved = await s.w.instantMove(ASSET, '25', [{ outpoint: from }], 1);
  assert.equal(moved.txid, T('5'));
  assert.deepEqual(s.log.find((x) => x[0] === 'colorSwap')[1], [from], 'no other coin: the token output pays the fee');
  assert.equal(outs.length, 3);
  assert.equal(outs[0].sats, 330, 'the lot');
  assert.equal(outs[1].sats, 1000, 'the rest of the tokens: a small RGB output (the engine puts them there)');
  assert.equal(vout, 2);
  assert.ok(outs[2].sats > 47000, 'the rest of the bitcoin back where fees are paid from');
});

test('lots: tokens on the rest-of-tokens output of this wallet\'s own unconfirmed move count as free (no "None of this token is settled")', async () => {
  const chain = fakeChain();
  const rest = `${T('5')}:2`, fee = `${T('c')}:2`;
  chain.outs[rest] = { sats: 1000, script: '5120rgb', tx: 'aa' };
  chain.outs[fee] = { sats: 20000, script: '5120btc', tx: 'bb' };
  chain.outs[`${T('8')}:2`] = { sats: 1000, script: '5120own', tx: 'cc' };
  // 10 left on the move's own output: not settled yet (its block hasn't come)
  const s = wallet({ name: 'seller', lib: fakeLib(), chain, rgb: [unspent('5', 2, [tok(10, ASSET, false)])], coins: [{ outpoint: fee, txout: { value: 20000 }, is_spent: false }] });
  s.mem.old = { role: 'seller', stage: 'moving', moveTxid: T('5'), coin: `${T('5')}:1`, assetId: ASSET, amount: '10', priceSats: '5000' };
  const moves = [T('8'), T('9')];
  s.w.w.sendEnd = async () => ({ txid: moves.shift() });
  s.w.w.setOwnUnconfirmed = () => {};
  s.w.w.setSwapChangeVout = () => {};
  s.w.w.refresh = async () => {};
  const lots = ['a', 'b'].map((c) => ({ offerId: `sw${c.repeat(12)}`, token: 'ab'.repeat(24), amount: '5', priceSats: '5000' }));
  const r = await s.w.instantListLots({ assetId: ASSET, lots, feeRate: 1 }, s.store);
  assert.deepEqual(s.log.find((x) => x[0] === 'colorSwap')[1].slice(0, 1), [rest], 'moved from the unconfirmed move\'s output');
  assert.equal(r.lots.length, 2);
});

test('two Instant buys in a row never spend the same coin, even before the block server shows it spent', async () => {
  const chain = fakeChain();
  const s = wallet({ name: 'buyer', lib: fakeLib(), chain, coins: [{ outpoint: `${T('c')}:0`, txout: { value: 50000 }, is_spent: false }, { outpoint: `${T('d')}:0`, txout: { value: 40000 }, is_spent: false }] });
  s.w.w.listUnspentsVanilla = async () => [{ outpoint: `${T('c')}:0`, txout: { value: 50000 }, is_spent: false }, { outpoint: `${T('d')}:0`, txout: { value: 40000 }, is_spent: false }];
  const first = await s.w.btcCoins();
  assert.equal(first.all.length, 2);
  s.w.spentNow([`${T('c')}:0`]);
  const next = await s.w.btcCoins();
  assert.deepEqual(next.all.map((c) => c.outpoint), [`${T('d')}:0`], 'the coin just spent is left out');
  assert.deepEqual(next.confirmed.map((c) => c.outpoint), [`${T('d')}:0`]);
});

test('where a token\'s balance is: free, in listings, waiting for a block, unusable', async () => {
  const { heldBreakdown } = await import('../src/rgb/swap.mjs');
  const u = (t, vout, v, { settled = true, colorable = true, exists = true } = {}) => ({ utxo: { outpoint: { txid: T(t), vout }, colorable, exists }, rgbAllocations: [{ assetId: ASSET, settled, assignment: { Fungible: v } }] });
  const list = [u('a', 0, 36), u('b', 1, 100), u('c', 1, 60), u('d', 2, 37, { settled: false }), u('e', 0, 40, { colorable: false })];
  assert.deepEqual(heldBreakdown(list, ASSET, new Set([`${T('b')}:1`, `${T('c')}:1`])), { free: '36', listed: '160', waiting: '37', other: '40' });
});
