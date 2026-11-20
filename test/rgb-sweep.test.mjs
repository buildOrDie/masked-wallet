// A sweep: several Instant listings of one token, one approval, bought one after another (one transaction each).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler, MAX_SWEEP } from '../src/dapp/requests.mjs';
import { instantBuyVbytes, combinedBuyVbytes, combinedChunks, payCoinsForCombined, COMBINED_MAX } from '../src/rgb/swap.mjs';
import { walletApp, testKeys } from './helpers/wallet-app.mjs';

const SITE = 'https://signet.maskedwallet.com';
const A = 'rgb:sweepTokenAssetId1234567890';
const listing = { psbt: 'cHNidP8=', consignment: 'Y29u', templateTxid: 'ab'.repeat(32) };
const item = (id, amount = '1000', priceSats = '100000', assetId = A) => ({ offerId: id, offer: { assetId, amount, priceSats, state: 'OPEN' }, listing });

function handler() {
  const opened = [];
  const handle = makeHandler({
    getPublic: async () => ({ net: 'signet', address: 'tb1pexample', publicKey: '02' + 'ab'.repeat(32) }),
    getTrade: async () => null,
    getSites: async () => ({ [SITE]: { connectedAt: 1 } }),
    setSites: async () => {},
    openApproval: async (origin, method, params) => { opened.push({ origin, method, params }); return 'ok'; },
    emitTo: () => {},
  });
  return { handle, opened };
}

test('a sweep request: checked like Instant buys, one token, no repeats, at most MAX_SWEEP', async () => {
  const { handle, opened } = handler();
  await handle(SITE, 'rgbInstantBuyMany', { items: [item('a'), item('b')], network: 'signet', feeRate: 2 });
  assert.equal(opened[0].method, 'rgbInstantBuyMany');
  assert.equal(opened[0].params.items.length, 2);
  assert.equal(opened[0].params.feeRate, 2);
  assert.deepEqual(opened[0].params.items[0].listing, listing);
  await assert.rejects(handle(SITE, 'rgbInstantBuyMany', { items: [] }), /items/);
  await assert.rejects(handle(SITE, 'rgbInstantBuyMany', { items: [item('a'), item('a')] }), /twice/);
  await assert.rejects(handle(SITE, 'rgbInstantBuyMany', { items: [item('a'), item('b', '1000', '100000', 'rgb:anotherTokenAssetId123456')] }), /same asset/);
  await assert.rejects(handle(SITE, 'rgbInstantBuyMany', { items: [{ offerId: 'x', offer: item('x').offer }] }), /listing/);
  await assert.rejects(handle(SITE, 'rgbInstantBuyMany', { items: Array.from({ length: MAX_SWEEP + 1 }, (_, k) => item(`i${k}`)) }), /At most/);
  // not connected: refused before any screen
  const other = makeHandler({ getPublic: async () => ({ net: 'signet', address: 'tb1p' }), getTrade: async () => null, getSites: async () => ({}), setSites: async () => {}, openApproval: async () => 'x', emitTo: () => {} });
  await assert.rejects(other('https://evil.example', 'rgbInstantBuyMany', { items: [item('a')] }), (e) => e.code === 4100);
});

function app() {
  const a = walletApp(testKeys({ bSpend: 0x1234567890abcdefn * 977n, fundingPriv: '22'.repeat(32) }), 'signet');
  a.state.lockState = 'open'; a.render = () => {}; a.toast = () => {};
  a.lock.secret = { words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', passphrase: '' };
  a.rgb.data = { address: 'tb1prgb', btc: { vanilla: { settled: 600000, future: 600000 }, colored: { settled: 0, future: 0 } }, groups: { nia: [] }, transfers: {} };
  return a;
}

test('the sweep screen: totals for every listing; buying goes one by one and skips one someone else got first', async () => {
  const a = app();
  const bought = [];
  Object.assign(a.rgb, { ready: true, service: { canSwap: true, canPresign: true, profile: a.rgb.profile, instantBuy: async (p) => { if (p.offerId === 'b') throw new Error('Someone just bought this, or the seller cancelled it.'); bought.push(p.offerId); return { txid: p.offerId.repeat(64).slice(0, 64) }; }, snapshot: async () => a.rgb.data } });
  a.rgb.refresh = async () => {};
  const P = { items: [item('a'), item('b'), item('c', '1000', '250000')], network: 'signet' };
  const act = { id: 'r1', origin: SITE, method: 'rgbInstantBuyMany', params: P };
  a.approvals.active = act;
  await new Promise((done) => a.approvals.prepareSwap(act, (fn) => fn().then((x) => { act.prep = x; done(); })));
  assert.equal(act.prep.n, 3);
  assert.equal(act.prep.price, 450000);
  assert.equal(act.prep.lo, 100); assert.equal(act.prep.hi, 250);
  assert.equal(act.prep.topUp, null, 'the RGB balance covers it');
  const html = a.ui.views.approve.render();
  assert.match(html, /Buy several listings/);
  assert.match(html, /Listings/); assert.match(html, /100 to 250 sats each/);
  const out = await a.approvals.run(act);
  assert.deepEqual(bought, ['a', 'c']);
  assert.equal(out.results.length, 3);
  assert.ok(out.results[0].txid); assert.match(out.results[1].error, /Someone just bought this/); assert.ok(out.results[2].txid);
});

test('the sweep stops when the RGB balance runs out, and says so for the ones left', async () => {
  const a = app();
  let n = 0;
  Object.assign(a.rgb, { ready: true, service: { canSwap: true, canPresign: true, profile: a.rgb.profile, instantBuy: async (p) => { if (n++ >= 1) throw new Error('Your RGB wallet needs 101,000 sats in bitcoin for this. Tap Add from Bitcoin under RGB balance on Home.'); return { txid: 'f'.repeat(64) }; } } });
  a.rgb.refresh = async () => {};
  const act = { id: 'r2', origin: SITE, method: 'rgbInstantBuyMany', params: { items: [item('a'), item('b'), item('c'), item('d')], network: 'signet' }, prep: {} };
  const out = await a.approvals.run(act);
  assert.equal(out.results.filter((x) => x.txid).length, 1);
  assert.equal(n, 2, 'tried once more, then stopped');
  assert.match(out.results[3].error, /ran out/);
  // nothing bought at all: the approval shows the error instead of a result
  n = 5;
  await assert.rejects(a.approvals.run({ ...act, id: 'r3' }), /101,000 sats/);
});

test('economy fee rates: Instant buys and sweeps take 0.1 sat/vB and up, listings and cancels still 1 and up', async () => {
  const { handle, opened } = handler();
  await handle(SITE, 'rgbInstantBuyMany', { items: [item('a')], network: 'signet', feeRate: 0.3 });
  assert.equal(opened.at(-1).params.feeRate, 0.3);
  await handle(SITE, 'rgbInstantBuy', { ...item('b'), network: 'signet', feeRate: 0.1 });
  assert.equal(opened.at(-1).params.feeRate, 0.1);
  await assert.rejects(handle(SITE, 'rgbInstantBuyMany', { items: [item('c')], network: 'signet', feeRate: 0.05 }), /between 0.1 and 500/);
  await assert.rejects(handle(SITE, 'rgbInstantCancel', { offerId: 'd', offer: { assetId: A, amount: '1', priceSats: '1' }, feeRate: 0.5 }), /between 1 and 500/);
});

test('combined buys (2.30): sizes, chunks and coins', () => {
  // one combined purchase is far smaller than one purchase per listing
  assert.equal(instantBuyVbytes(1, true) * 10 > 2 * combinedBuyVbytes(10), true);
  assert.ok(combinedBuyVbytes(3) - combinedBuyVbytes(2) < 110, 'about 100 vB per extra listing');
  assert.deepEqual(combinedChunks(1), [1]);
  assert.deepEqual(combinedChunks(7), [7]);
  assert.deepEqual(combinedChunks(10), [10]);
  assert.deepEqual(combinedChunks(11), [6, 5], 'no lone listing left at the end');
  assert.deepEqual(combinedChunks(20), [10, 10]);
  assert.equal(COMBINED_MAX, 10);
  const coin = (id, sats) => ({ outpoint: `${id.repeat(64)}:0`, txout: { value: sats }, is_spent: false });
  // two coins at least, even when one covers it
  const two = payCoinsForCombined([coin('a', 900000), coin('b', 2000)], [], 50000);
  assert.equal(two.coins.length, 2);
  assert.equal(two.coins[0].sats, '900000');
  // one coin only: can't combine
  assert.equal(payCoinsForCombined([coin('a', 900000)], [coin('a', 900000)], 50000), null);
  // confirmed first, then this wallet's unconfirmed change; each coin past two adds its fee
  const three = payCoinsForCombined([coin('a', 30000), coin('b', 20000)], [coin('a', 30000), coin('b', 20000), coin('c', 15000)], 55000, 100n);
  assert.deepEqual(three.coins.map((c) => c.sats), ['30000', '20000', '15000']);
  assert.equal(payCoinsForCombined([coin('a', 30000), coin('b', 20000)], [], 55000), null);
});

test('a sweep with a combining engine: one transaction for the lot, one by one when it can\'t combine', async () => {
  const a = app();
  const calls = [];
  let combine = true;
  Object.assign(a.rgb, { ready: true, service: { canSwap: true, canPresign: true, get canCombine() { return true; }, profile: a.rgb.profile,
    instantBuyCombined: async (p) => { calls.push(['combined', p.items.map((x) => x.offerId).join('')]); return combine ? { txid: '7'.repeat(64), offerIds: p.items.map((x) => x.offerId) } : { notPaid: 'Not enough bitcoin coins to combine the purchases.' }; },
    instantBuy: async (p) => { calls.push(['one', p.offerId]); return { txid: p.offerId.repeat(64).slice(0, 64) }; } } });
  a.rgb.refresh = async () => {};
  const P = { items: [item('a'), item('b'), item('c')], network: 'signet', feeRate: 2 };
  const act = { id: 'c1', origin: SITE, method: 'rgbInstantBuyMany', params: P };
  a.approvals.active = act;
  await new Promise((done) => a.approvals.prepareSwap(act, (fn) => fn().then((x) => { act.prep = x; done(); })));
  assert.equal(act.prep.combined, true);
  assert.equal(act.prep.txs, 1);
  assert.equal(act.prep.seal, 330, 'one seal for the lot');
  assert.equal(act.prep.fee, Math.ceil(2 * combinedBuyVbytes(3)));
  assert.ok(act.prep.saved > 0);
  assert.match(a.ui.views.approve.render(), /one transaction instead of 3/);
  let out = await a.approvals.run(act);
  assert.deepEqual(calls, [['combined', 'abc']]);
  assert.deepEqual(out.results.map((x) => x.txid), ['7'.repeat(64), '7'.repeat(64), '7'.repeat(64)]);
  // can't combine (one coin): bought one by one, nothing lost
  calls.length = 0; combine = false;
  out = await a.approvals.run({ ...act, id: 'c2' });
  assert.deepEqual(calls, [['combined', 'abc'], ['one', 'a'], ['one', 'b'], ['one', 'c']]);
  assert.equal(out.results.filter((x) => x.txid).length, 3);
  // the combined purchase failed after it may have gone out: no second purchase of the same listings
  calls.length = 0;
  a.rgb.service.instantBuyCombined = async (p) => { calls.push(['combined', p.items.length]); throw new Error('block server timeout'); };
  out = await a.approvals.run({ ...act, id: 'c3', params: { ...P, items: [item('a'), item('b'), item('c'), item('d'), item('e'), item('f'), item('g'), item('h'), item('i'), item('j'), item('k')] } }).catch((e) => ({ error: String(e.message) }));
  assert.deepEqual(calls, [['combined', 6], ['combined', 5]], 'two combined purchases of 6 and 5, never one by one');
});
