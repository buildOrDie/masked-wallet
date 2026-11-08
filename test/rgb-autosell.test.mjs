// Sell automatically: the background's offer list and the hidden page's one step, with stand-ins for Chrome
// storage, the market and the RGB engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_KEY, AUTO_ON, PASS_KEY, MAX_DAYS, autoEntry, createAutoSell } from '../src/provider/autosell.js';
import { runStep } from '../src/rgb/agent.mjs';

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
const ID = 'sw0123456789ab';
const TOKEN = 'ab'.repeat(24);
const MARKET = 'https://market.example';
const terms = { assetId: ASSET, amount: '500', priceSats: '20000' };
const input = { offerId: ID, market: MARKET, token: TOKEN, offer: terms, profile: 'public', origin: 'https://maskedwallet.com' };

const store = (init = {}) => {
  const m = { ...init };
  return { m, get: async (k) => ({ [k]: m[k] }), set: async (o) => { Object.assign(m, o); } };
};

/** A market that answers GET with `state()` and records POSTs. */
const market = (state) => {
  const posts = [];
  const fetchFn = async (url, init) => {
    assert.equal(init.headers['x-swap-token'], TOKEN, 'every call carries the seller token');
    assert.equal(init.credentials, 'omit');
    if (init.method === 'POST') { posts.push({ path: url.slice(`${MARKET}/api/swap/offers/${ID}`.length), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    const s = state();
    if (!s) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return { ok: true, status: 200, json: async () => s };
  };
  return { posts, fetchFn };
};

test('autoEntry: only a market offer, an https market, a token and full terms', () => {
  const e = autoEntry(input, 1000);
  assert.equal(e.offerId, ID);
  assert.deepEqual(e.terms, terms);
  assert.equal(e.expiresAt, 1000 + MAX_DAYS * 86400_000);
  assert.throws(() => autoEntry({ ...input, offerId: 'of1' }), /market offer/);
  assert.throws(() => autoEntry({ ...input, market: 'http://evil.example' }), /https/);
  assert.doesNotThrow(() => autoEntry({ ...input, market: 'http://localhost:8790' }));
  assert.throws(() => autoEntry({ ...input, token: '' }), /token/);
  assert.throws(() => autoEntry({ ...input, offer: { ...terms, priceSats: '1e5' } }), /priceSats/);
});

test('tick: a buyer arrives, the hidden page prepares the sale, then completes it once the buyer signs', async () => {
  const local = store({ [AUTO_ON]: true });
  const session = store({ [PASS_KEY]: { public: { profile: 'public', key: 'k' } } });
  let st = { id: ID, role: 'seller', state: 'OPEN', offer: terms };
  const { posts, fetchFn } = market(() => st);
  const jobs = [];
  const agent = async (job) => { jobs.push(job.step); return job.step === 'sale' ? { psbt: 'p', sellerOutpoint: 'o', consignment: 'c' } : { txid: 'f'.repeat(64) }; };
  const badges = [];
  const auto = createAutoSell({ local, session, fetchFn, agent, badge: (t) => badges.push(t) });
  await auto.add(input);

  assert.deepEqual(await auto.tick(), { ran: 0, problems: 0 }, 'no buyer yet');
  st = { ...st, state: 'MATCHED', session: { buyerOutpoint: 'x' } };
  assert.equal((await auto.tick()).ran, 1);
  assert.deepEqual(posts[0], { path: '/colored', body: { psbt: 'p', sellerOutpoint: 'o', consignment: 'c' } });
  st = { ...st, state: 'COLORED' };
  assert.equal((await auto.tick()).ran, 0, 'waiting for the buyer to sign');
  assert.equal((await auto.list())[0].status, 'buyer');
  st = { ...st, state: 'SIGNED', signedPsbt: 'signed' };
  assert.equal((await auto.tick()).ran, 1);
  assert.deepEqual(posts[1], { path: '/done', body: { txid: 'f'.repeat(64) } });
  assert.deepEqual(jobs, ['sale', 'complete']);
  assert.deepEqual(await auto.list(), [], 'a sold offer leaves the list');
  assert.equal(badges.at(-1), '');
});

test('tick: stops on changed terms, needs the session pass, leaves busy steps to the open window', async () => {
  const local = store({ [AUTO_ON]: true });
  const session = store({});
  let st = { id: ID, role: 'seller', state: 'MATCHED', session: {}, offer: terms };
  const { posts, fetchFn } = market(() => st);
  let calls = 0;
  let agent = async () => { calls++; throw new Error('BUSY'); };
  const badges = [];
  const auto = createAutoSell({ local, session, fetchFn, agent: (j) => agent(j), badge: (t) => badges.push(t) });
  await auto.add(input);

  await auto.tick();
  assert.equal((await auto.list())[0].status, 'locked', 'no key in Chrome memory: nothing runs');
  assert.equal(calls, 0);
  assert.equal(badges.at(-1), '!');

  await session.set({ [PASS_KEY]: { public: { profile: 'public', key: 'k' } } });
  await auto.tick();
  assert.equal((await auto.list())[0].status, 'window', 'RGB open in a window: the window does it');
  assert.equal((await auto.due()).length, 1);
  assert.equal(await auto.report(ID, 'sale', { psbt: 'p' }), true);
  assert.equal(posts[0].path, '/colored');

  st = { ...st, offer: { ...terms, priceSats: '1' } };
  agent = async () => { calls++; return {}; };
  const before = calls;
  await auto.tick();
  assert.equal((await auto.list())[0].status, 'stopped', 'a different price is never sold automatically');
  assert.equal(calls, before);

  await local.set({ [AUTO_ON]: false });
  assert.deepEqual(await auto.tick(), { ran: 0, off: true }, 'setting off: nothing runs');
});

test('tick: cancelled, missing and expired offers leave the list', async () => {
  const local = store({ [AUTO_ON]: true });
  const session = store({ [PASS_KEY]: {} });
  let st = { id: ID, role: 'seller', state: 'CANCELLED', offer: terms };
  const { fetchFn } = market(() => st);
  let t = 0;
  const auto = createAutoSell({ local, session, fetchFn, agent: async () => ({}), now: () => t });
  await auto.add(input); await auto.tick();
  assert.equal((await auto.list()).length, 0);
  st = null; await auto.add(input); await auto.tick();
  assert.equal((await auto.list()).length, 0);
  st = { id: ID, role: 'seller', state: 'OPEN', offer: terms }; await auto.add(input);
  t = MAX_DAYS * 86400_000 + 1; await auto.tick();
  assert.equal((await local.get(AUTO_KEY))[AUTO_KEY][ID], undefined);
});

test('runStep: checks the terms, takes the RGB lock, opens and closes the wallet', async () => {
  const log = [];
  class FakeWallet {
    constructor(o) { log.push(`new ${o.profile.id}`); }
    get exists() { return true; }
    async open(key) { log.push(`open ${key}`); }
    async prepareSale(p) { log.push(`sale ${p.offerId}`); return { psbt: 'p' }; }
    async completeSale(p) { log.push(`complete ${p.psbt}`); return { txid: 't' }; }
    async close() { log.push('close'); }
  }
  const runtime = { SignetWallet: FakeWallet, loadRgbSdk: () => null };
  const free = { request: async (name, opts, fn) => { log.push(`lock ${name}`); assert.equal(opts.ifAvailable, true); return fn({ name }); } };
  const taken = { request: async (name, opts, fn) => fn(null) };
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
  const entry = autoEntry(input);
  const pass = { profile: 'public', key: 'secret' };
  const offer = { id: ID, network: 'signet', state: 'MATCHED', session: { buyerOutpoint: 'x' }, offer: terms };

  assert.deepEqual(await runStep({ step: 'sale', entry, offer, pass }, { locks: free, runtime }), { psbt: 'p' });
  assert.deepEqual(log, ['lock masked-rgb-public-v1', 'new public', 'open secret', `sale ${ID}`, 'close']);
  assert.deepEqual(await runStep({ step: 'complete', entry, offer: { ...offer, state: 'SIGNED', signedPsbt: 's' }, pass }, { locks: free, runtime }), { txid: 't' });
  await assert.rejects(runStep({ step: 'sale', entry, offer, pass }, { locks: taken, runtime }), /BUSY/);
  await assert.rejects(runStep({ step: 'sale', entry, offer: { ...offer, offer: { ...terms, amount: '501' } }, pass }, { locks: free, runtime }), /changed/);
  await assert.rejects(runStep({ step: 'sale', entry, offer, pass: { profile: 'public' } }, { locks: free, runtime }), /LOCKED/);
  await assert.rejects(runStep({ step: 'complete', entry, offer, pass }, { locks: free, runtime }), /not signed/);
});
