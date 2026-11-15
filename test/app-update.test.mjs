// The phone app hears about new versions from the site (it isn't on Google Play).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppUpdate, compareVersions } from '../src/app/AppUpdate.mjs';

function setup({ isApp = true, version = '2.29.17', latest = '2.29.18' } = {}) {
  const mem = new Map(); let clock = 1_000_000; let asked = 0;
  const app = { platform: { isApp }, store: { getJson: (k, f) => (mem.has(k) ? JSON.parse(mem.get(k)) : f), setJson: (k, v) => mem.set(k, JSON.stringify(v)) }, render() {} };
  const u = new AppUpdate(app, { version, now: () => clock, fetchFn: async () => { asked++; return Response.json({ version: latest }); } });
  return { u, tick: (ms) => { clock += ms; }, asked: () => asked };
}

test('versions compare by number', () => {
  assert.equal(compareVersions('2.29.18', '2.29.17'), 1);
  assert.equal(compareVersions('2.29.9', '2.29.17'), -1);
  assert.equal(compareVersions('2.30.0', '2.29.99'), 1);
  assert.equal(compareVersions('2.29.17', '2.29.17'), 0);
});

test('a newer version on the site shows, with the install page; Later hides it for a few days', async () => {
  const s = setup();
  const up = await s.u.check();
  assert.deepEqual(up, { version: '2.29.18', page: 'https://signet.maskedwallet.com/install' });
  await s.u.check();
  assert.equal(s.asked(), 1, 'asks the site at most every few hours');
  s.u.later();
  assert.equal(s.u.available(), null);
  assert.ok(s.u.available({ ignoreLater: true }), 'Settings still says so');
  s.tick(4 * 86400_000);
  assert.ok(s.u.available(), 'back after a few days');
});

test('nothing when up to date, outside the app, or the site is down', async () => {
  assert.equal(await setup({ latest: '2.29.17' }).u.check(), null);
  assert.equal(await setup({ latest: '2.29.10' }).u.check(), null);
  assert.equal(await setup({ isApp: false }).u.check(), null);
  const s = setup(); s.u.fetchFn = async () => { throw new Error('offline'); };
  assert.equal(await s.u.check(), null);
});
