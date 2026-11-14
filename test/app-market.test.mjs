// The phone app's Market tab: the site in the frame asks through postMessage, the app answers like the extension.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppMarket, APP_SITES, TO_APP, TO_SITE } from '../src/dapp/AppMarket.mjs';

const SITE = 'https://signet.maskedwallet.com';

function fakeApp() {
  const mem = new Map();
  const app = {
    platform: { isApp: true, local: null, requestId: null },
    state: { lockState: 'open', view: 'market', net: 'signet', status: {} },
    account: { net: 'signet', keys: { source: 'mnemonic' }, funding: () => ({ address: 'tb1pexample', internalX: 'ab'.repeat(32) }), shieldAddr: () => 'tsp1example' },
    store: { getJson: (k, f) => (mem.has(k) ? JSON.parse(mem.get(k)) : f), setJson: (k, v) => mem.set(k, JSON.stringify(v)) },
    approvals: { loads: 0, active: null, port: null, load() { this.loads++; } },
    trade: { on: false },
    renders: 0,
    render() { this.renders++; },
  };
  return app;
}

function setup() {
  const app = fakeApp();
  const m = new AppMarket(app);
  m.attach({ addEventListener() {} });
  const sent = [];
  const win = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
  m.frame = { contentWindow: win };
  const ask = (method, params = {}, { origin = SITE, source = win, id = String(Math.random()) } = {}) =>
    m.onMessage({ source, origin, data: { target: TO_APP, id, method, params } }).then(() => sent.find((s) => s.msg.id === id));
  return { app, m, sent, win, ask };
}

test('only MASKED\'s own sites, from the market frame, are answered', async () => {
  const { ask, sent, m } = setup();
  assert.ok(APP_SITES.has(SITE));
  assert.equal(await ask('getNetwork', {}, { origin: 'https://evil.example' }), undefined, 'another site');
  assert.equal(await ask('getNetwork', {}, { source: { postMessage() {} } }), undefined, 'another frame');
  await m.onMessage({ source: m.frame.contentWindow, origin: SITE, data: { target: 'something-else', id: 'x', method: 'getNetwork' } });
  assert.equal(sent.length, 0);
  const r = await ask('getNetwork');
  assert.deepEqual(r.msg.result, 'testnet');
  assert.equal(r.msg.target, TO_SITE);
  assert.equal(r.origin, SITE, 'the answer goes to that site only');
});

test('connecting opens the approval screen; approving answers the site and returns to the market', async () => {
  const { app, m, ask } = setup();
  assert.deepEqual((await ask('getAccounts')).msg.result, [], 'not connected yet');
  const answer = ask('requestAccounts', {}, { id: 'connect' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(app.state.view, 'approve');
  assert.equal(app.approvals.loads, 1);
  const id = app.platform.requestId;
  assert.deepEqual(await app.platform.local({ type: 'getRequest', id }), { origin: SITE, method: 'requestAccounts', params: {} });
  await app.platform.local({ type: 'resolveRequest', id, result: ['tb1pexample'] });
  assert.deepEqual((await answer).msg.result, ['tb1pexample']);
  assert.equal(app.state.view, 'market');
  assert.equal(app.platform.requestId, null);
  assert.deepEqual((await ask('getAccounts')).msg.result, ['tb1pexample'], 'remembered as connected');
  assert.ok(m.sites()[SITE]);
});

test('rejecting, leaving the screen and a second request are all a no for the site', async () => {
  const { app, m, ask } = setup();
  const first = ask('requestAccounts', {}, { id: 'a' });
  await new Promise((r) => setTimeout(r, 0));
  const second = await ask('requestAccounts', {}, { id: 'b' });
  assert.equal(second.msg.error.code, 4001, 'one request at a time');
  // the person goes to another tab instead of answering
  app.state.view = 'home';
  m.sync();
  assert.equal((await first).msg.error.code, 4001);
  assert.equal(m.pending.size, 0);
  // and an explicit Reject
  app.state.view = 'market';
  const third = ask('requestAccounts', {}, { id: 'c' });
  await new Promise((r) => setTimeout(r, 0));
  await app.platform.local({ type: 'resolveRequest', id: app.platform.requestId, error: { code: 4001, message: 'User rejected the request.' } });
  assert.equal((await third).msg.error.code, 4001);
});

test('a locked or demo wallet is not shared', async () => {
  const { app, ask } = setup();
  app.state.lockState = 'locked';
  assert.equal((await ask('requestAccounts')).msg.error.code, 4100);
  app.state.lockState = 'open';
  app.account.keys = { source: 'example' };
  assert.equal((await ask('requestAccounts')).msg.error.code, 4100);
});

test('private trading stays limited to maskedwallet.com', async () => {
  const { app, m, ask } = setup();
  app.store.setJson('masked.app.sites', { [SITE]: { connectedAt: 1 } });
  assert.equal((await ask('getTradeAccount')).msg.error.code, 4200);
  assert.equal(m.pending.size, 0);
});
