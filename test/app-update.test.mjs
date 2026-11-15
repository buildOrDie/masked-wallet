// The phone app hears about new versions from the site (it isn't on Google Play).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppUpdate, compareVersions } from '../src/app/AppUpdate.mjs';

function setup({ isApp = true, version = '2.29.17', latest = '2.29.18' } = {}) {
  const mem = new Map(); let clock = 1_000_000; let asked = 0;
  const app = { platform: { isApp }, store: { getJson: (k, f) => (mem.has(k) ? JSON.parse(mem.get(k)) : f), setJson: (k, v) => mem.set(k, JSON.stringify(v)) }, render() {} };
  const u = new AppUpdate(app, { version, now: () => clock, fetchFn: async () => { asked++; return Response.json({ version: latest, apk: `/masked-${latest}.apk`, sha256: 'ab'.repeat(32) }); } });
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
  assert.equal(up.version, '2.29.18'); assert.equal(up.page, 'https://signet.maskedwallet.com/install');
  assert.equal(up.apk, 'https://signet.maskedwallet.com/masked-2.29.18.apk'); assert.equal(up.sha256, 'ab'.repeat(32));
  assert.equal(up.inApp, false, 'no updater plugin here: the install page');
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

test('in the app: Update downloads with the checksum, asks once for install permission, and falls back to the page on errors', async () => {
  const s = setup();
  const calls = []; let allowed = false; let fail = null; let listener = null;
  globalThis.Capacitor = { Plugins: { MaskedUpdater: {
    canInstall: async () => ({ allowed }),
    openInstallSettings: async () => { calls.push('settings'); allowed = true; },
    addListener: async (ev, fn) => { listener = fn; return { remove() { listener = null; } }; },
    install: async (o) => { calls.push(o); listener?.({ loaded: 5, total: 10 }); if (fail) throw new Error(fail); return { started: true }; },
  } } };
  try {
    const up = await s.u.check();
    assert.equal(up.inApp, true);
    await s.u.install();
    assert.equal(s.u.state, 'allow', 'Android must allow MASKED to install first');
    assert.equal(calls.length, 0);
    await s.u.allowInstalls();
    assert.deepEqual(calls, ['settings']);
    await s.u.install();
    assert.deepEqual(calls[1], { url: 'https://signet.maskedwallet.com/masked-2.29.18.apk', sha256: 'ab'.repeat(32) });
    assert.equal(s.u.state, 'installing');
    assert.equal(s.u.progress, 0.5);
    fail = "The download doesn't match the published checksum, so it wasn't installed.";
    await s.u.install();
    assert.equal(s.u.state, 'error');
    const c = s.u.card(s.u.available({ ignoreLater: true }));
    assert.ok(c.page && c.retry && /checksum/.test(c.note));
    fail = 'old-android';
    await s.u.install();
    assert.match(s.u.card(s.u.available({ ignoreLater: true })).note, /install page/);
  } finally { delete globalThis.Capacitor; }
});
