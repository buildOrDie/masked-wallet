import test from 'node:test';
import assert from 'node:assert/strict';
import { plain, assetsWithFiles } from '../src/rgb/LiteWallet.mjs';

// The engine (serde_wasm_bindgen) hands an NFT's attachments (index → file) over as a JS Map, which plain() empties.
// Up to 2.32.4 every NFT listing went out with its picture only, and every buyer's wallet refused the NFT.
test('an NFT\'s attachments survive the engine\'s Map: its metadata.json goes out with its listing', () => {
  const json = { digest: 'b'.repeat(64), mime: 'application/json' };
  const raw = { nia: [], uda: [{ assetId: 'rgb:x', media: { digest: 'a'.repeat(64), mime: 'image/png' }, attachments: new Map([[0, json]]), balance: { settled: 1n } }] };
  assert.deepEqual(plain(raw).uda[0].attachments, {}, 'what went wrong: plain() alone empties the Map');
  const r = plain(assetsWithFiles(raw));
  assert.deepEqual(r.uda[0].attachments, { 0: json });
  assert.equal(r.uda[0].balance.settled, 1);
  assert.deepEqual(assetsWithFiles({ nia: [] }), { nia: [] });
  assert.deepEqual(plain(assetsWithFiles({ uda: [{ assetId: 'rgb:y', attachments: { 1: json } }] })).uda[0].attachments, { 1: json }, 'an object (tests, older builds) as before');
});

// A purchase this wallet refused (bought before 2.32.5) is rebuilt from the market's sold listing and opened again.
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';
import { createHash } from 'node:crypto';

test('a refused NFT purchase is opened again from the sold listing, its files checked first', async () => {
  const file = (t) => { const b = Buffer.from(t); return { digest: createHash('sha256').update(b).digest('hex'), data: b.toString('base64') }; };
  const pic = file('png'), meta = file('{"traits":{}}');
  const T = (c) => c.repeat(64);
  const calls = { media: [], reopened: [] };
  const w = Object.create(LiteWallet.prototype);
  Object.defineProperty(w, 'engineV1', { value: true }); w.indexer = 'https://block.test';
  w.lib = { WasmWallet: { completePresignedConsignment: (c, tt, hexTx) => new TextEncoder().encode(`${new TextDecoder().decode(c)}|${tt}|${hexTx}`) } };
  w.w = {
    listTransfers: () => [{ recipientId: 'rid-refused', status: 'Failed' }, { recipientId: 'rid-fine', status: 'Settled' }],
    addMediaFile: (b) => { calls.media.push(Buffer.from(b).toString()); return ''; },
    reopenPresignedReceive: (rid, c) => calls.reopened.push([rid, new TextDecoder().decode(c)]),
    setPresignedReceives: () => {},
  };
  w.save = async () => {}; w.keepMedia = async () => {};
  const entries = {
    swA: { role: 'buyer', recipientId: 'rid-refused', txid: T('a'), posted: true, media: [pic] },
    swB: { role: 'buyer', recipientId: 'rid-fine', txid: T('b'), posted: true, media: [pic] },
    swC: { role: 'buyer', recipientId: 'rid-refused2', txid: T('c'), posted: true, assetId: 'rgb:token' },
  };
  const store = { all: () => entries, get: (k) => entries[k], set: (k, v) => { entries[k] = v; } };
  const sold = { swA: { txid: T('a'), templateTxid: T('d'), consignment: Buffer.from('listing').toString('base64'), media: [pic, meta] } };
  const fetchFn = async (url) => {
    if (url.startsWith('https://block.test/tx/')) return { ok: true, text: async () => 'beef' };
    const id = url.split('/').pop();
    return sold[id] ? { ok: true, json: async () => sold[id] } : { ok: false, json: async () => ({}) };
  };
  const realFetch = globalThis.fetch; globalThis.fetch = fetchFn;
  try {
    assert.equal(await w.recoverRefusedPurchases(store, 'https://market.test/sold', fetchFn), 1);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(calls.media, ['png', '{"traits":{}}'], 'both files, the metadata.json the listing lacked too');
  assert.deepEqual(calls.reopened, [['rid-refused', `listing|${T('d')}|beef`]], 'the listing\'s transfer completed with the purchase TX');
  assert.ok(entries.swA.reopened, 'done once');
  assert.equal(await w.recoverRefusedPurchases(store, 'https://market.test/sold', fetchFn), 0, 'not again');
  // a sold listing with a file that doesn't match its digest is not used
  entries.swA = { ...entries.swA, reopened: undefined };
  sold.swA.media = [{ ...meta, data: Buffer.from('other').toString('base64') }];
  calls.reopened.length = 0;
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(await w.recoverRefusedPurchases(store, 'https://market.test/sold', fetchFn), 0); } finally { console.warn = warn; }
  assert.equal(calls.reopened.length, 0);
});
