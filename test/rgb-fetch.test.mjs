// RGB's requests: a few at a time, and polite retries when the block server is busy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbFetch, rgbInFlight, RGB_MAX_REQUESTS } from '../src/rgb/rgbFetch.mjs';

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
    const base = 'https://signet-api.example/api/tx/';
    for (let i = 0; i < 3; i++) {
      assert.deepEqual([...new Uint8Array(await (await rgbFetch(`${base}${tx}/raw`)).arrayBuffer())], [1, 2, 3]);
      assert.equal((await (await rgbFetch(`${base}${tx}/status`)).json()).confirmed, true);
    }
    await Promise.all(Array.from({ length: 5 }, () => rgbFetch(`${base}${tx2}/status`)));
    assert.equal(asked.filter((u) => u.endsWith(`${tx}/raw`)).length, 1);
    assert.equal(asked.filter((u) => u.endsWith(`${tx}/status`)).length, 1);
    assert.equal(asked.filter((u) => u.includes(tx2)).length, 1, 'five at once: asked once');
    // anything else is not kept
    await rgbFetch('https://signet-api.example/api/blocks/tip/height'); await rgbFetch('https://signet-api.example/api/blocks/tip/height');
    assert.equal(asked.filter((u) => u.endsWith('/tip/height')).length, 2);
  } finally { globalThis.fetch = was; rgbCacheClear(); }
});
