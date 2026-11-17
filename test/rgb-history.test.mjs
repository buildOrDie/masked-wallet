import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeHistory } from '../src/ui/views/RgbViews.mjs';

const T = (c) => c.repeat(64);
const a = { assetId: 'rgb:m', ticker: 'MASKED', precision: 0 };
const tr = (kind, txid, n, at, status = 'Settled') => (kind === 'Send'
  ? { kind, txid, status, requestedAssignment: { Fungible: n }, createdAt: at, updatedAt: at }
  : { kind, txid, status, assignments: [{ Fungible: n }], createdAt: at, updatedAt: at });
const r = (transfers, store) => ({
  history: () => transfers, amount: (_a, n) => Number(n).toLocaleString('en-US'), isDropped: () => false, stranded: () => false,
  service: { instantStore: () => ({ all: () => store }) },
});

test('history: own moves are one row, named by what they were; sales and purchases say so', () => {
  const list = [
    tr('Send', T('1'), 144, 300), tr('ReceiveWitness', T('1'), 144, 300), // a listing's move
    tr('Send', T('2'), 22, 200), tr('ReceiveWitness', T('2'), 22, 200), // a lot, no record
    tr('ReceiveWitness', T('3'), 10, 100), // a purchase
    tr('ReceiveWitness', T('4'), 1000, 50), // a plain receive
  ];
  const store = {
    l1: { role: 'seller', assetId: 'rgb:m', amount: '144', priceSats: '2000', moveTxid: T('1'), stage: 'ready' },
    s1: { role: 'seller', assetId: 'rgb:m', amount: '22', priceSats: '2000', soldTxid: T('9'), stage: 'sold', at: 400000 },
    b1: { role: 'buyer', assetId: 'rgb:m', amount: '10', priceSats: '2000', txid: T('3') },
  };
  const rows = tradeHistory(r(list, store), a);
  const by = Object.fromEntries(rows.map((x) => [x.label, x]));
  assert.equal(rows.length, 5, 'one row per transaction, plus the sale');
  assert.match(by.Listed.note, /Instant listing at 2,000 sats/); assert.equal(by.Listed.sign, '');
  assert.equal(by['Moved in your wallet'].amount, '22');
  assert.match(by.Bought.note, /For 2,000 sats/);
  assert.equal(by.Sold.sign, '−'); assert.equal(by.Sold.amount, '22');
  assert.equal(by.Received.sign, '+');
});
