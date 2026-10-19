import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ShordMonitor, NAKAS_PARENT, shordCid, shordUrl, parseShordStatus, compareShordStatus } from '../src/net/ShordMonitor.mjs';
import { LocalStore } from '../src/core/LocalStore.mjs';
import { MemoryStorage, MaskedApp } from './helpers/wallet-app.mjs';
import { SettingsView } from '../src/ui/views/SettingsView.mjs';
import { Platform } from '../src/app/Platform.mjs';

const cid = 'a1e7879252940f5e', hash = 'a'.repeat(64), digest = 'b'.repeat(64);
const expected = { network: 'mainnet', parent: NAKAS_PARENT, cid };
const status = (overrides = {}) => ({ network: 'mainnet', rulesInscriptionId: NAKAS_PARENT, cid, lastHeight: 970880, blockHash: hash, digest, notes: 7091, ...overrides });
const config = { primary: 'https://primary.example', peer: 'https://peer.example', parent: NAKAS_PARENT };

function fixture(handler = () => status()) {
  const calls = [], chainCalls = [];
  const app = {
    state: { net: 'main' }, store: new LocalStore(() => storage), render() {},
    servers: { async request(path, init) { chainCalls.push({ path, init }); return new Response(hash); } },
  };
  const storage = new MemoryStorage();
  const monitor = new ShordMonitor(app, async (ms, url, init, read) => {
    calls.push({ ms, url, init });
    const body = await handler(url);
    return read(body instanceof Response ? body : Response.json(body));
  });
  return { app, monitor, calls, chainCalls, storage };
}

test('SHORD identity uses the upstream CID recipe and validates inscription IDs', () => {
  assert.equal(shordCid(NAKAS_PARENT), cid);
  assert.equal(shordCid(NAKAS_PARENT), createHash('sha256').update(NAKAS_PARENT).digest('hex').slice(0, 16));
  for (const bad of ['', 'x', NAKAS_PARENT + '/status', 'f'.repeat(64) + 'i01']) assert.throws(() => shordCid(bad));
});

test('indexer URLs reject credentials, insecure remote servers and URL suffixes', () => {
  assert.equal(shordUrl(' https://example.com/api/// '), 'https://example.com/api');
  assert.equal(shordUrl('http://127.0.0.1:5021'), 'http://127.0.0.1:5021');
  assert.equal(shordUrl('http://[::1]:5021'), 'http://[::1]:5021');
  for (const bad of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#secret', 'javascript:alert(1)', 'http://localhost.evil.test']) assert.throws(() => shordUrl(bad));
});

test('wrong collections, networks and malformed status cannot become accepted reports', () => {
  for (const overrides of [{ network: 'signet' }, { cid: 'deadbeefdeadbeef' }, { rulesInscriptionId: 'f'.repeat(64) + 'i0' }, { lastHeight: -1 }, { lastHeight: '970880' }, { notes: 1.5 }, { notes: -1 }, { blockHash: [hash] }, { digest: 'broken' }]) {
    assert.throws(() => parseShordStatus(status(overrides), expected));
  }
  assert.deepEqual(parseShordStatus(status(), expected), { height: 970880, blockHash: hash, digest, notes: 7091 });
});

test('comparison distinguishes lag from disagreement and checks the block as well as digest', () => {
  const a = parseShordStatus(status(), expected);
  assert.equal(compareShordStatus(a, { ...a }), 'agree');
  assert.equal(compareShordStatus(a, { ...a, height: a.height - 1 }), 'different-heights');
  for (const patch of [{ blockHash: 'c'.repeat(64) }, { digest: 'c'.repeat(64) }, { notes: a.notes + 1 }]) assert.equal(compareShordStatus(a, { ...a, ...patch }), 'disagree');
});

test('no requests until configured; permissions precede persistence and all requests', async () => {
  const { monitor, calls, chainCalls } = fixture();
  await monitor.refresh();
  assert.equal(calls.length, 0);
  let permissionCalls = 0;
  await monitor.save(config, async (urls) => {
    permissionCalls++;
    assert.deepEqual(urls, [config.primary, config.peer]);
    assert.equal(calls.length, 0);
    assert.equal(monitor.config(), null);
  });
  assert.equal(permissionCalls, 1);
  assert.equal(monitor.result.comparison, 'agree');
  assert.equal(monitor.result.chain, 'match');
  assert.equal(monitor.busy, false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).pathname, `/c/${cid}/status`);
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.equal(call.init.body, undefined);
    assert.equal(call.ms, 8000);
  }
  assert.equal(chainCalls[0].path, 'block-height/970880');
});

test('denied permissions and duplicate providers leave configuration untouched', async () => {
  const { monitor, calls } = fixture();
  await assert.rejects(monitor.save(config, async () => { throw new Error('Permission declined'); }), /declined/);
  await assert.rejects(monitor.save({ ...config, peer: config.primary + '/' }), /different/);
  assert.equal(monitor.config(), null);
  assert.equal(calls.length, 0);
});

test('indexer failures never retain an old successful report', async () => {
  let fail = false;
  const { monitor } = fixture(() => fail ? new Response('offline', { status: 503 }) : status());
  await monitor.save(config);
  assert.ok(monitor.result.primary);
  fail = true;
  await monitor.refresh();
  assert.equal(monitor.result.primary, null);
  assert.match(monitor.result.error, /503/);
});

test('turning off while permission is pending cannot re-enable the monitor', async () => {
  const { monitor, calls } = fixture();
  let allow;
  const permission = new Promise((resolve) => { allow = resolve; });
  const save = monitor.save(config, async () => permission);
  monitor.clear(); allow();
  await assert.rejects(save, /Settings changed/);
  assert.equal(monitor.config(), null);
  assert.equal(calls.length, 0);
});

test('peer failure and Bitcoin API mismatch are reported independently', async () => {
  const { monitor, app } = fixture((url) => url.startsWith(config.peer) ? new Response('', { status: 429 }) : status());
  app.servers.request = async () => new Response('c'.repeat(64));
  await monitor.save(config);
  assert.equal(monitor.result.comparison, 'unavailable');
  assert.equal(monitor.result.chain, 'mismatch');
  app.servers.request = async () => { throw new Error('offline'); };
  await monitor.refresh();
  assert.equal(monitor.result.chain, 'unavailable');
});

test('a single indexer has no implied peer agreement', async () => {
  const { monitor, calls } = fixture();
  await monitor.save({ ...config, peer: '' });
  assert.equal(calls.length, 1);
  assert.equal(monitor.result.comparison, 'none');
});

test('status body size and JSON parsing are bounded', async () => {
  for (const response of [new Response('not json'), new Response(' '.repeat(32769))]) {
    const { monitor } = fixture(() => response);
    await monitor.save({ ...config, peer: '' });
    assert.equal(monitor.result.primary, null);
    assert.match(monitor.result.error, /JSON|too large/);
  }
});

test('turning off during a check discards late replies and stops the Bitcoin lookup', async () => {
  let resolve;
  const wait = new Promise((r) => { resolve = r; });
  const { monitor, chainCalls } = fixture(async () => { await wait; return status(); });
  const check = monitor.save(config);
  await Promise.resolve();
  assert.equal(monitor.busy, true);
  monitor.clear(); resolve(); await check;
  assert.equal(monitor.result, null);
  assert.equal(monitor.config(), null);
  assert.equal(chainCalls.length, 0);
});

test('settings and reports are isolated by network, including in-flight requests', async () => {
  const { monitor, app } = fixture();
  await monitor.save(config);
  app.state.net = 'signet';
  assert.equal(monitor.config(), null);
  assert.equal(monitor.result, null);
  app.state.net = 'main';
  app.store.setJson(monitor.key, { ...config, peer: '' });
  let resolve;
  monitor.request = async () => new Promise((r) => { resolve = r; });
  const check = monitor.refresh();
  monitor.reset(); app.state.net = 'signet';
  resolve(status()); await check;
  assert.equal(monitor.result, null);
  assert.equal(monitor.busy, false);
});

test('the app wires SHORD separately and the settings UI does not claim verified ownership', async () => {
  const app = new MaskedApp();
  assert.ok(app.shord instanceof ShordMonitor);
  const view = new SettingsView(app);
  const html = view.shord();
  assert.match(html, /Read-only/);
  assert.match(html, /not independently verified ownership/);
  assert.match(html, /separate from your silent-payment/);
  app.shord.current = { key: app.shord.key, error: '<img src=x onerror=alert(1)>' };
  assert.ok(!view.shord().includes('<img'));
});

test('custom origins are requested together in a single Chrome permission request', async () => {
  const original = globalThis.chrome;
  const calls = [];
  globalThis.chrome = { runtime: { id: 'test' }, storage: { local: {} }, permissions: { async request(o) { calls.push(o); return true; } } };
  try {
    await new Platform().requestOrigins(['https://one.example/api', 'https://one.example/other', 'https://two.example']);
    assert.deepEqual(calls, [{ origins: ['https://one.example/*', 'https://two.example/*'] }]);
  } finally { globalThis.chrome = original; }
});
