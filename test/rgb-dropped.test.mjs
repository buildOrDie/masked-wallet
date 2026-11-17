import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletRgb } from '../src/rgb/WalletRgb.mjs';

const T = (c) => c.repeat(64);
const fake = (transfers) => ({
  dropped: () => ({ [T('4')]: Date.now() }),
  isDropped: WalletRgb.prototype.isDropped,
  data: { transfers },
});

test('tokens on a dropped receive are not "waiting for a block" on the page', () => {
  const A = 'rgb:a';
  const me = fake({ [A]: [{ kind: 'ReceiveWitness', status: 'WaitingConfirmations', txid: T('4'), assignments: [{ Fungible: 500 }] }] });
  const assets = WalletRgb.prototype.withoutDropped.call(me, [{ assetId: A, held: { free: '750', listed: '250', waiting: '500', other: '0' } }]);
  assert.deepEqual(assets[0].held, { free: '750', listed: '250', waiting: '0', other: '0', dropped: '500' });
  const rep = WalletRgb.prototype.withoutDropped.call(me, {
    rgb: [{ outpoint: `${T('4')}:2`, state: 'waiting', tokens: [{ assetId: A, amount: '500' }] }, { outpoint: `${T('5')}:1`, state: 'waiting', tokens: [{ assetId: A, amount: '7' }] }],
    tokens: [{ assetId: A, free: '750', listed: '250', waiting: '507', other: '0' }],
  });
  assert.deepEqual(rep.rgb.map((o) => o.state), ['dropped', 'waiting']);
  assert.equal(rep.tokens[0].waiting, '7'); assert.equal(rep.tokens[0].dropped, '500');
});

test('a refresh by another MASKED window is shared: the next window starts from it instead of syncing again', async () => {
  const { OPEN_FRESH_MS } = await import('../src/rgb/WalletRgb.mjs');
  const mem = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  try {
    const me = { profile: { vaultKey: 'v' }, refreshedAt: 0 };
    const at = WalletRgb.prototype.sharedRefreshAt;
    assert.equal(at.call(me), 0, 'never refreshed');
    const t = Date.now() - 20_000;
    mem.set('v.refreshed-at', String(t));
    assert.equal(at.call(me), t, 'another window\'s refresh');
    assert.ok(Date.now() - at.call(me) < OPEN_FRESH_MS);
    mem.set('v.refreshed-at', String(Date.now() + 3600_000));
    assert.equal(at.call(me), 0, 'a time in the future is ignored');
  } finally { globalThis.localStorage = prev; }
});
