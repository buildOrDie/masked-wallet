// RGB's requests: a few at a time, and polite retries when the block server is busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbFetch, rgbInFlight, RGB_MAX_REQUESTS, rgbSetTimeout, RGB_REQUEST_TIMEOUT_MS } from '../src/rgb/rgbFetch.mjs';

test('at most a few RGB requests at once', async () => {
  let peak = 0, now = 0;
  globalThis.fetch = async () => { now++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 10)); now--; return new Response('ok'); };
  await Promise.all(Array.from({ length: 20 }, () => rgbFetch('https://mempool.space/signet/api/x')));
  assert.equal(peak, RGB_MAX_REQUESTS);
  assert.equal(rgbInFlight(), 0);
});

test('a busy server (429) gets a pause and a retry', async () => {
  let n = 0;
  globalThis.fetch = async () => new Response('', { status: ++n < 2 ? 429 : 200 });
  const r = await rgbFetch('https://mempool.space/signet/api/y');
  assert.equal(r.status, 200);
  assert.equal(n, 2);
});

test('a 502 from the block server is retried too', async () => {
  let n = 0;
  globalThis.fetch = async () => new Response('', { status: ++n < 2 ? 502 : 200 });
  assert.equal((await rgbFetch('https://mempool.space/signet/api/z')).status, 200);
});

test('a Request from the engine is passed on as an address with its body already read (old Android WebViews)', async () => {
  const { rgbFetch } = await import('../src/rgb/rgbFetch.mjs');
  const seen = [];
  const keep = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { seen.push({ url, method: opts?.method, body: opts?.body instanceof FormData ? 'form:' + opts.body.get('file') : opts?.body ? new TextDecoder().decode(opts.body) : null, isBytes: opts?.body instanceof Uint8Array, type: opts?.headers?.get('content-type') }); return new Response('{}'); };
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'server.info', params: null });
    await rgbFetch(new Request('https://scan.example/rgb-proxy-v1/json-rpc', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
    await rgbFetch(new Request('https://mempool.space/signet/api/block-height/0'));
    assert.equal(typeof seen[0].url, 'string');
    assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].body, body); assert.equal(seen[0].type, 'application/json');
    assert.ok(seen[0].isBytes, 'a Uint8Array (CapacitorHttp sends an ArrayBuffer as "{}")');
    assert.equal(seen[1].method, 'GET'); assert.equal(seen[1].body, null);
    const fd = new FormData(); fd.append('file', 'consignment-bytes');
    await rgbFetch(new Request('https://scan.example/rgb-proxy/json-rpc', { method: 'POST', body: fd }));
    assert.equal(seen[2].body, 'form:consignment-bytes', 'a multipart upload stays a form');
  } finally { globalThis.fetch = keep; }
});

test('transaction lookups are answered from memory: a transaction once, a confirmed status for a while, concurrent asks once', async () => {
  const { rgbCacheClear } = await import('../src/rgb/rgbFetch.mjs');
  rgbCacheClear();
  const was = globalThis.fetch;
  const asked = [];
  const tx = 'ab'.repeat(32), tx2 = 'cd'.repeat(32);
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url).endsWith('/raw')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    if (String(url).includes(tx2)) return Response.json({ confirmed: false });
    return Response.json({ confirmed: true, block_height: 5 });
  };
  try {
    const base = 'https://esplora.example/api/tx/'; // not Signet: no second opinion here (tested below)
    for (let i = 0; i < 3; i++) {
      assert.deepEqual([...new Uint8Array(await (await rgbFetch(`${base}${tx}/raw`)).arrayBuffer())], [1, 2, 3]);
      assert.equal((await (await rgbFetch(`${base}${tx}/status`)).json()).confirmed, true);
    }
    await Promise.all(Array.from({ length: 5 }, () => rgbFetch(`${base}${tx2}/status`)));
    assert.equal(asked.filter((u) => u.endsWith(`${tx}/raw`)).length, 1);
    assert.equal(asked.filter((u) => u.endsWith(`${tx}/status`)).length, 1);
    assert.equal(asked.filter((u) => u.includes(tx2)).length, 1, 'five at once: asked once');
    // the same transaction from another block server: answered from memory too, with that server's address
    const other = await rgbFetch(`https://other-server.example/api/tx/${tx}/raw`);
    assert.deepEqual([...new Uint8Array(await other.arrayBuffer())], [1, 2, 3]);
    assert.equal(other.url, `https://other-server.example/api/tx/${tx}/raw`);
    assert.equal(asked.filter((u) => u.endsWith(`${tx}/raw`)).length, 1, 'one request whichever server');
    // anything else is not kept
    await rgbFetch('https://esplora.example/api/blocks/tip/height'); await rgbFetch('https://esplora.example/api/blocks/tip/height');
    assert.equal(asked.filter((u) => u.endsWith('/tip/height')).length, 2);
  } finally { globalThis.fetch = was; rgbCacheClear(); }
});

test('a request that never answers gives up (and frees its place) instead of holding RGB forever', async () => {
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = (url, opts) => { calls++; return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))); };
  rgbSetTimeout(30);
  const keep = setTimeout(() => {}, 2000); // AbortSignal.timeout doesn't keep Node's event loop alive
  try {
    await assert.rejects(rgbFetch('https://x.test/blocks/tip/height'), /did not answer in time/);
    assert.equal(calls, 2, 'tried once more');
    assert.equal(rgbInFlight(), 0);
  } finally { clearTimeout(keep); globalThis.fetch = real; rgbSetTimeout(RGB_REQUEST_TIMEOUT_MS); }
});

test('an answer from memory carries its address (the engine stops dead on an empty response.url)', async () => {
  const real = globalThis.fetch;
  const u = 'https://x.test/tx/' + 'ab'.repeat(32) + '/hex';
  globalThis.fetch = async () => new Response('00', { status: 200 });
  try {
    const a = await rgbFetch(u), b = await rgbFetch(u);
    assert.equal(a.url, u); assert.equal(b.url, u);
    assert.doesNotThrow(() => new URL(b.url));
  } finally { globalThis.fetch = real; }
});

test('Signet: a block server that says "not confirmed" or is behind the chain gets a second opinion from mempool.space', async () => {
  const { rgbCacheClear, referenceFor } = await import('../src/rgb/rgbFetch.mjs');
  rgbCacheClear();
  assert.equal(referenceFor('https://memproxy.inscribe.dev/signet/api/blocks/tip/height'), 'https://mempool.space/signet/api');
  assert.equal(referenceFor('https://mempool.space/signet/api/x'), '', 'mempool.space itself: no second opinion');
  assert.equal(referenceFor('https://my-node.example/api/x'), '', 'Mainnet: the person\'s own server is never second-guessed');
  assert.equal(referenceFor('https://esplora-api.utexo.com/x'), '', 'other test networks: none');
  const was = globalThis.fetch, asked = [];
  const tx = 'ef'.repeat(32), tx2 = '12'.repeat(32);
  globalThis.fetch = async (url) => {
    const u = String(url); asked.push(u);
    if (u.startsWith('https://mempool.space/signet/api/tx/' + tx)) return Response.json({ confirmed: true, block_height: 330553 });
    if (u.startsWith('https://mempool.space/signet/api/tx/' + tx2)) return Response.json({ confirmed: false });
    if (u === 'https://mempool.space/signet/api/blocks/tip/height') return new Response('331000');
    if (u.endsWith('/blocks/tip/height')) return new Response('330000');
    if (u.endsWith('/status')) return Response.json({ confirmed: false });
    return new Response('?', { status: 404 });
  };
  try {
    const lag = 'https://memproxy.inscribe.dev/signet/api';
    assert.equal((await (await rgbFetch(`${lag}/tx/${tx}/status`)).json()).confirmed, true, 'confirmed on mempool.space: believed');
    assert.equal((await (await rgbFetch(`${lag}/tx/${tx2}/status`)).json()).confirmed, false, 'not confirmed anywhere: still not');
    assert.equal((await (await rgbFetch(`${lag}/blocks/tip/height`)).text()).trim(), '331000', 'a tip behind the chain is replaced');
    assert.equal((await (await rgbFetch(`${lag}/blocks/tip/height`)).text()).trim(), '331000');
    assert.equal(asked.filter((u) => u === 'https://mempool.space/signet/api/blocks/tip/height').length, 1, 'mempool.space\'s tip asked at most every 30 s');
  } finally { globalThis.fetch = was; rgbCacheClear(); }
});
