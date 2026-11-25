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

test('RGB operations queue: a buy asked for during a sync waits for it, instead of "Wait for the current RGB operation."', async () => {
  const { SignetWallet } = await import('../src/rgb/SignetWallet.mjs');
  const w = Object.create(SignetWallet.prototype);
  w.busy = false;
  const order = [];
  const sync = w.exclusive(async () => { order.push('sync start'); await new Promise((r) => setTimeout(r, 80)); order.push('sync end'); });
  const buy = w.exclusive(async () => { order.push('buy'); return 'bought'; });
  const send = w.exclusive(async () => { order.push('send'); throw new Error('send failed'); });
  const after = w.exclusive(async () => { order.push('after'); return 1; });
  assert.equal(await buy, 'bought');
  await assert.rejects(send, /send failed/);
  assert.equal(await after, 1, 'a failure frees the next one');
  await sync;
  assert.deepEqual(order, ['sync start', 'sync end', 'buy', 'send', 'after']);
  // one waiting too long gives up, and the ones after it still run
  const old = SignetWallet.EXCLUSIVE_WAIT_MS; SignetWallet.EXCLUSIVE_WAIT_MS = 30;
  const long = w.exclusive(() => new Promise((r) => setTimeout(r, 120)));
  await assert.rejects(w.exclusive(async () => 'never'), /Wait for the current RGB operation/);
  SignetWallet.EXCLUSIVE_WAIT_MS = 1000;
  assert.equal(await w.exclusive(async () => 'later'), 'later');
  await long; SignetWallet.EXCLUSIVE_WAIT_MS = old;
});

test('approvals: approved while still preparing (wallet syncing) waits for it, instead of "Still preparing."', async () => {
  const { ApprovalController } = await import('../src/dapp/ApprovalController.mjs');
  const c = Object.create(ApprovalController.prototype);
  const a = { method: 'rgbInstantListMany', prepBusy: true };
  const shown = [];
  c.app = { render: () => {}, rgb: null, state: { busy: false, status: {} } };
  c.active = a;
  c.prepare = () => {};
  let finished = null;
  c.finish = (x) => { finished = x; };
  c.run = async (x) => { shown.push(c.state.status.approve?.[0]); if (!x.prep) throw new Error('Still preparing.'); return 'listed'; };
  setTimeout(() => { a.prep = { ok: true }; a.prepBusy = false; }, 300);
  await c.approve();
  assert.deepEqual(finished, { result: 'listed' });
  assert.equal(c.state.status.approve?.[1] === 'err', false);
});
