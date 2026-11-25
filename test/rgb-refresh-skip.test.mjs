// 2.32.6: receives waiting for their transfer data for over a day are asked about hourly, not on every refresh, and a
// send of more than is free says where the rest is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';

const NOW = Date.UTC(2026, 10, 25, 12);
const wallet = () => {
  const w = Object.create(LiteWallet.prototype);
  Object.defineProperty(w, 'engineV1', { value: true });
  const calls = { skip: [], refresh: 0 };
  const T = (idx, kind, status, hoursAgo) => ({ batchTransferIdx: idx, kind, status, createdAt: Math.floor((NOW - hoursAgo * 3600_000) / 1000) });
  w.w = {
    listAssets: () => ({ nia: [{ assetId: 'rgb:tok', ticker: 'MASKED', precision: 1 }], uda: [{ assetId: 'rgb:nft' }] }),
    listTransfers: (f) => (f === 'noAsset' ? [T(1, 'ReceiveWitness', 'WaitingCounterparty', 200), T(2, 'ReceiveWitness', 'WaitingCounterparty', 2)]
      : f?.id === 'rgb:tok' ? [T(3, 'ReceiveBlind', 'WaitingCounterparty', 30), T(4, 'Send', 'WaitingCounterparty', 300), T(5, 'ReceiveWitness', 'Settled', 300)]
        : [T(6, 'ReceiveWitness', 'WaitingConfirmations', 100)]),
    setRefreshSkip: (l) => calls.skip.push([...l].sort()),
    refresh: async () => { calls.refresh++; return {}; },
    listUnspents: () => [
      { utxo: { outpoint: { txid: 'a'.repeat(64), vout: 1 }, colorable: true }, rgbAllocations: [{ assetId: 'rgb:tok', assignment: { Fungible: 1977 }, settled: true }] },
      { utxo: { outpoint: { txid: 'b'.repeat(64), vout: 1 }, colorable: true }, rgbAllocations: [{ assetId: 'rgb:tok', assignment: { Fungible: 1977 }, settled: false }] },
      { utxo: { outpoint: { txid: 'c'.repeat(64), vout: 1 }, colorable: true }, rgbAllocations: [{ assetId: 'rgb:tok', assignment: { Fungible: 1023 }, settled: true }] },
    ],
  };
  w.requireOnline = () => ({});
  w.save = async () => {};
  w._reserved = new Set([`${'c'.repeat(64)}:1`]);
  return { w, calls };
};

test('refresh: receives waiting over a day are skipped, others and sends are not', async () => {
  const { w, calls } = wallet();
  assert.deepEqual(w.staleReceives(NOW).sort(), [1, 3]);
  // refreshWallet reads the real clock: skips what's over a day old by then
  await w.refreshWallet({ all: false });
  assert.deepEqual(calls.skip.at(-1), w.staleReceives().sort());
  assert.ok(calls.skip.at(-1).includes(1) && calls.skip.at(-1).includes(3) && !calls.skip.at(-1).includes(4));
  await w.refreshWallet({ all: true });
  assert.deepEqual(calls.skip.at(-1), [], 'an hourly refresh asks about every one');
  assert.equal(calls.refresh, 2);
});

test('refresh: an engine without the skip list refreshes as before', async () => {
  const { w, calls } = wallet();
  delete w.w.setRefreshSkip;
  await w.refreshWallet({ all: false });
  assert.equal(calls.refresh, 1);
});

test('send: more than is free says where the rest is', () => {
  const { w } = wallet();
  assert.equal(w.sendBlocker('rgb:tok', 1977), '');
  const m = w.sendBlocker('rgb:tok', 2000);
  assert.match(m, /^Only 197\.7 MASKED can be sent right now\. 197\.7 is waiting for its block .*, and 102\.3 is in your listings\. Send 197\.7 or less/);
  assert.match(m, /Nothing was sent\.$/);
});

test('listed tokens: counted per token, so the wallet never offers them for sending', () => {
  const { w } = wallet();
  assert.deepEqual(w.listedByAsset(), { 'rgb:tok': '1023' });
  w._reserved = new Set();
  assert.deepEqual(w.listedByAsset(), {});
});

test('NFT pictures: the engine copy is not read while a refresh holds the engine', async () => {
  const w = Object.create(LiteWallet.prototype);
  let reads = 0;
  const bytes = new Uint8Array([1, 2, 3]);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  w.w = { mediaFile: () => { reads++; return bytes; } };
  w.engineBusy = true;
  setTimeout(() => { w.engineBusy = false; }, 250);
  const src = await w.nftImage({ digest, mime: 'image/png' }, async () => { throw new Error('no network'); });
  assert.equal(reads, 1, 'read once the engine was free');
  assert.match(String(src), /^data:image\/png;base64,/);
});
