// Peer-to-peer RGB swaps: the four steps between two wallets, with a stand-in engine (the PSBT building and
// checking itself is Rust, tested in engine/masked-swap.patch).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';
import { SEAL_SATS, buyerView, canonicalOutpoint, finishRefusal, offerOf, pickBuyerInput, pickSellerInput, sellable, sellerPayout } from '../src/rgb/swap.mjs';

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
const T = (c) => c.repeat(64);
const addr = (b) => btc.p2tr(new Uint8Array(32).fill(b), undefined, btc.TEST_NETWORK).address;
const offer = { offerId: 'of1', assetId: ASSET, amount: '500', priceSats: '20000', state: 'OPEN' };

test('helpers: picking outputs, what can be sold, payouts, offers', () => {
  const coins = [
    { outpoint: `${T('a')}:0`, txout: { value: 30000 }, is_spent: false },
    { outpoint: `${T('b')}:1`, txout: { value: 21000 }, is_spent: false },
    { outpoint: `${T('c')}:0`, txout: { value: 90000 }, is_spent: true },
  ];
  assert.deepEqual(pickBuyerInput(coins, 21000), { outpoint: `${T('a')}:0`, sats: '30000' }, 'more than needed, smallest first, never spent');
  assert.equal(pickBuyerInput(coins, 40000), null);
  const rgb = [
    { utxo: { colorable: true, outpoint: { txid: T('d'), vout: 2 }, btcAmount: 1000 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: 800 } }] },
    { utxo: { colorable: true, outpoint: { txid: T('e'), vout: 0 }, btcAmount: 1000 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: 600 } }, { assetId: ASSET, settled: false, assignment: { Fungible: 999 } }] },
  ];
  assert.deepEqual(pickSellerInput(rgb, ASSET, 500), { outpoint: `${T('e')}:0`, sats: '1000' }, 'the least that still covers it; unsettled does not count');
  assert.equal(pickSellerInput(rgb, ASSET, 900), null, 'one swap uses one output');
  assert.deepEqual(sellable(rgb, ASSET), { total: '1400', max: '800' });
  assert.equal(sellerPayout(20000, 1000), 20000n);
  assert.equal(sellerPayout(20000, 1500), 20500n);
  assert.throws(() => sellerPayout(20000, 600), /seal needs/);
  assert.equal(canonicalOutpoint(`${T('A')}:3`), `${T('a')}:3`);
  assert.equal(canonicalOutpoint('nope'), null);
  assert.throws(() => offerOf({ ...offer, amount: '-1' }, 'of1'), /whole number/);
  assert.throws(() => offerOf(offer, 'other'), /another id/);
  const view = buyerView({ priceSats: '20000', feeSats: '640', buyerInputSats: '30000', buyerSeal: 'seal', buyerChangeScript: 'chg' }, 1000);
  assert.deepEqual(view, [{ script: 'seal', sats: SEAL_SATS }, { script: null, sats: 20000 }, { script: 'chg', sats: 9360 }]);
  const X = `${T('f')}:1`, Y = `${T('0')}:0`;
  assert.equal(finishRefusal({ sale: { ...offer, txid: 't', sellerOutpoint: X }, offer, txid: 't', ownSpent: [X] }), null);
  assert.match(finishRefusal({ sale: { ...offer, txid: 't', sellerOutpoint: X }, offer, txid: 't', ownSpent: [X, Y] }), /other outputs/);
  assert.match(finishRefusal({ sale: { ...offer, txid: 't', sellerOutpoint: X }, offer, txid: 'u', ownSpent: [X] }), /not the transaction/);
  assert.match(finishRefusal({ sale: null, offer, txid: 't', ownSpent: [] }), /did not prepare/);
});

// ---- a stand-in engine: just enough to carry a swap between two wallets ----
function fakeLib(chainOut, built) {
  class WasmInvoice { constructor(s) { this.s = s; } invoiceData() { return { network: 'Signet', recipientId: `sb:wvout:${this.s.slice(-6)}`, assignment: { Fungible: 500 }, transportEndpoints: ['rpcs://proxy.iriswallet.com/0.2/json-rpc'] }; } free() {} }
  const WasmWallet = {
    buildSwapPsbt: (ins, outs) => { built.push({ ins, outs }); return JSON.stringify({ ins: ins.map((i) => i.outpoint), outs }); },
    swapPsbtInputs: (p) => JSON.parse(p).ins,
    swapPsbtTxid: () => T('9'),
    invoiceSealScript: (inv) => `5120seal${inv.slice(-6)}`,
    checkSwapPsbt: (p, ins, outs, fee) => { built.push({ checked: { ins, outs, fee } }); const j = JSON.parse(p); if (JSON.stringify(j.ins) !== JSON.stringify(ins)) throw new Error('inputs differ'); for (let k = 0; k < outs.length; k++) { if (j.outs[k].sats !== outs[k].sats || (outs[k].script && j.outs[k].script !== outs[k].script)) throw new Error(`output ${k + 1} differs`); } },
  };
  return { WasmWallet, WasmInvoice, validateConsignmentOffchain: (bytes) => JSON.parse(new TextDecoder().decode(bytes)), chainOut };
}
function wallet({ name, rgb = [], coins = [], lib }) {
  const w = new LiteWallet(lib, { network: 'signet', indexerUrl: 'https://esplora.test', transportEndpoint: 'https://proxy.iriswallet.com/0.2/json-rpc', mnemonic: 'x', dataDir: name });
  let n = 0;
  w.w = {
    swapBegin: async (online, psbt, assetId, amount, rid, vout, sealSats) => { w.colored = { assetId, amount, rid, vout, sealSats }; return psbt; },
    transferConsignment: () => new TextEncoder().encode(JSON.stringify(w.consignment || { valid: true, contractId: ASSET, sealAmount: 500 })),
    listUnspents: () => rgb, listUnspentsVanilla: async () => coins, sync: async () => {}, flush: async () => {}, getAddress: async () => addr(name === 'seller' ? 7 : 9),
    witnessReceive: () => ({ invoice: `rgb:~/~/~/sb:wvout:${name}${++n}abc123`, recipientId: `rid${n}`, expirationTimestamp: 1, batchTransferIdx: n }),
    listAssets: () => ({}), listTransfers: () => [], rotateAddress: () => {},
    signPsbt: (p) => { const j = JSON.parse(p); j.signed = [...(j.signed || []), name]; return JSON.stringify(j); },
    sendEnd: async (online, p) => { w.sent = JSON.parse(p); return { txid: T('9'), batchTransferIdx: 7 }; },
  };
  w.online = { id: 1 };
  w.outpointInfo = async (op) => lib.chainOut[op];
  const mem = {};
  const store = { get: (k) => mem[k] || null, set: (k, v) => { mem[k] = v; }, del: (k) => { delete mem[k]; } };
  return { w, store, mem };
}

test('a full swap: prepare, colour, sign, finish, with the right outputs and checks', async () => {
  const SELL_IN = `${T('e')}:0`, BUY_IN = `${T('a')}:0`;
  const built = [];
  const lib = fakeLib({ [SELL_IN]: { sats: 1000, script: '5120sell', tx: 'aa' }, [BUY_IN]: { sats: 30000, script: '5120buy', tx: 'bb' } }, built);
  const seller = wallet({ name: 'seller', lib, rgb: [{ utxo: { colorable: true, outpoint: { txid: T('e'), vout: 0 }, btcAmount: 1000 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: 600 } }] }] });
  const buyer = wallet({ name: 'buyer', lib, coins: [{ outpoint: BUY_IN, txout: { value: 30000 }, is_spent: false }] });

  const session = await buyer.w.swapPrepare({ offerId: 'of1', network: 'Signet', offer, feeRate: 2 }, buyer.store);
  assert.equal(session.feeSats, '640');
  assert.equal(session.buyerOutpoint, BUY_IN);
  assert.match(session.buyerSeal, /^5120seal/);
  assert.ok(buyer.mem.of1, 'the buyer remembers the purchase across windows');

  const colored = await seller.w.swapColor({ offerId: 'of1', network: 'Signet', session, offer: { ...offer, state: 'MATCHED' } }, seller.store);
  const [{ ins, outs }] = built;
  assert.deepEqual(ins.map((i) => i.outpoint), [SELL_IN, BUY_IN], 'seller input first, buyer second');
  assert.equal(outs[0].sats, SEAL_SATS); assert.equal(outs[0].script, session.buyerSeal);
  assert.equal(outs[1].sats, 20000, 'price + the RGB output sats − the seal');
  assert.equal(outs[2].sats, 30000 - 20000 - 640, 'the buyer change pays the fee');
  assert.deepEqual({ vout: seller.w.colored.vout, sealSats: seller.w.colored.sealSats, amount: seller.w.colored.amount }, { vout: 1, sealSats: 1000n, amount: 500n });
  assert.equal(colored.sellerOutpoint, SELL_IN);

  const signed = await buyer.w.swapSign({ offerId: 'of1', psbt: colored.psbt, consignment: colored.consignment, offer }, buyer.store);
  assert.deepEqual(JSON.parse(signed.psbt).signed, ['buyer']);
  assert.equal(buyer.mem.of1, undefined, 'signed once only');
  const check = built.find((x) => x.checked).checked;
  assert.equal(check.fee, 640n); assert.equal(check.outs[1].script, null, 'the seller output is checked by amount only');

  const done = await seller.w.swapFinish({ offerId: 'of1', psbt: signed.psbt, offer }, seller.store);
  assert.equal(done.txid, T('9'));
  assert.deepEqual(seller.w.sent.signed, ['buyer', 'seller']);
});

test('the buyer refuses a transfer for another token, a smaller amount, or a changed offer', async () => {
  const SELL_IN = `${T('e')}:0`, BUY_IN = `${T('a')}:0`;
  for (const [bad, msg] of [[{ valid: true, contractId: 'rgb:otherTokenAsset0000', sealAmount: 500 }, /another token/], [{ valid: true, contractId: ASSET, sealAmount: 499 }, /gives you 499/], [{ valid: false, details: 'bad proof' }, /bad proof/]]) {
    const built = [];
    const lib = fakeLib({ [SELL_IN]: { sats: 1000, script: '5120sell' }, [BUY_IN]: { sats: 30000, script: '5120buy' } }, built);
    const seller = wallet({ name: 'seller', lib, rgb: [{ utxo: { colorable: true, outpoint: { txid: T('e'), vout: 0 }, btcAmount: 1000 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: 600 } }] }] });
    const buyer = wallet({ name: 'buyer', lib, coins: [{ outpoint: BUY_IN, txout: { value: 30000 }, is_spent: false }] });
    const session = await buyer.w.swapPrepare({ offerId: 'of1', offer, feeRate: 2 }, buyer.store);
    seller.w.consignment = bad;
    const c = await seller.w.swapColor({ offerId: 'of1', session, offer: { ...offer, state: 'MATCHED' } }, seller.store);
    await assert.rejects(buyer.w.swapSign({ offerId: 'of1', psbt: c.psbt, consignment: c.consignment, offer }, buyer.store), msg);
    assert.ok(buyer.mem.of1, 'nothing signed: the purchase can still be retried or dropped');
  }
  // the price went up after the buyer prepared
  const lib = fakeLib({}, []);
  const buyer = wallet({ name: 'buyer', lib, coins: [{ outpoint: BUY_IN, txout: { value: 30000 }, is_spent: false }] });
  await buyer.w.swapPrepare({ offerId: 'of1', offer, feeRate: 2 }, buyer.store);
  await assert.rejects(buyer.w.swapSign({ offerId: 'of1', psbt: '{"ins":[]}', consignment: '', offer: { ...offer, priceSats: '25000' } }, buyer.store), /offer changed/);
});

test('without the swap engine, every step says MASKED needs an update', async () => {
  const w = new LiteWallet({ WasmWallet: {} }, { network: 'signet', indexerUrl: 'x', transportEndpoint: 'https://p', mnemonic: 'x', dataDir: 'd' });
  w.w = {}; w.online = {};
  await assert.rejects(w.swapPrepare({ offerId: 'a', offer }, {}), /no swap engine/);
});
