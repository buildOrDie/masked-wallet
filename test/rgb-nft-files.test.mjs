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
