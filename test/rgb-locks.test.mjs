// Outputs held by transfers that never went out (2.31.3): listed with why, released only when no block server has
// their transaction, never a live Instant listing's output. The engine side is tested in engine/masked-b5.patch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';

const T = (c) => c.repeat(64), HOUR = 3600;
function wallet(locks, onChain = new Set()) {
  const w = new LiteWallet({ WasmWallet: {} }, { network: 'signet', indexerUrl: 'https://esplora.test/api', transportEndpoint: 'https://p.test/json-rpc', mnemonic: 'x', dataDir: 'locks' });
  const released = [];
  w.w = { outputLocks: () => locks.filter((l) => !released.includes(l.batchTransferIdx)), releaseUnbroadcast: (i) => { released.push(i); } };
  w.save = async () => {};
  w.txOnChain = async (txid) => onChain.has(txid);
  return { w, released };
}
const now = () => Math.floor(Date.now() / 1000);
const lock = (o) => ({ outpoint: `${T('a')}:1`, batchTransferIdx: 7, txid: T('e'), status: 'WaitingCounterparty', kind: 'spends', assetId: 'rgb:x', amount: 104, createdAt: now() - 2 * HOUR, expiration: null, ...o });

test('a sale that never went out: listed, released, and the output is free', async () => {
  const { w, released } = wallet([lock()]);
  const [l] = await w.lockedOutputs();
  assert.equal(l.releasable, true);
  assert.equal(l.amount, '104');
  const r = await w.releaseLock({ idx: 7 });
  assert.deepEqual(released, [7]);
  assert.deepEqual(r.outpoints, [`${T('a')}:1`]);
  await assert.rejects(w.releaseLock({ idx: 7 }), /doesn't hold anything/);
});

test('never released: a transaction on the network, a fresh transfer, a live Instant listing', async () => {
  const onChain = wallet([lock()], new Set([T('e')]));
  assert.equal((await onChain.w.lockedOutputs())[0].onChain, true);
  await assert.rejects(onChain.w.releaseLock({ idx: 7 }), /on the network/);
  const fresh = wallet([lock({ createdAt: now() - 60 })]);
  await assert.rejects(fresh.w.releaseLock({ idx: 7 }), /less than an hour/);
  const listed = wallet([lock()]);
  listed.w.reserve([`${T('a')}:1`]);
  assert.deepEqual(await listed.w.lockedOutputs(), [], 'a live listing holds its output on purpose');
});

test('an invoice nobody paid (no transaction) is releasable; a day-old one goes by itself on open', async () => {
  const { w, released } = wallet([lock({ kind: 'invoice', txid: null, createdAt: now() - 30 * HOUR }), lock({ batchTransferIdx: 8, outpoint: `${T('b')}:0`, createdAt: now() - 2 * HOUR })]);
  const ls = await w.lockedOutputs();
  assert.ok(ls.every((l) => l.releasable));
  assert.equal(await w.autoReleaseLocks(), 1, 'only the day-old one by itself');
  assert.deepEqual(released, [7]);
});

test('a market says a trade was left: its sale is released at once, if it never went out', async () => {
  const { w, released } = wallet([lock({ createdAt: now() - 60 })]);
  const sold = { get: (id) => (id === 'of1' ? { txid: T('e'), at: Date.now() } : null) };
  const none = { get: () => null };
  assert.deepEqual(await w.releaseTrade({ offerId: 'of1' }, [none, sold, none]), { released: 1 });
  assert.deepEqual(released, [7], 'no hour to wait when the market says it was left');
  assert.deepEqual(await w.releaseTrade({ offerId: 'other' }, [none, sold, none]), { released: 0 });
});
