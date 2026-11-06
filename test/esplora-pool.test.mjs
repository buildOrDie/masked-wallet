// The server pool keeps the method and body of Request objects (the RGB engine broadcasts with them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EsploraPool } from '../src/net/EsploraPool.mjs';

test('a POST sent as a Request object stays a POST with its body', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { sent.push({ url: String(url), method: init.method || 'GET', body: init.body ? Buffer.from(init.body).toString() : null }); return new Response('txid123'); };
  try {
    // timedFetch uses the fetch captured at load; route through a pool whose request() we observe instead
    const pool = new EsploraPool({ net: () => 'signet', store: { get: () => '' } });
    const seen = [];
    pool.request = async (path, init) => { seen.push({ path, method: init.method || 'GET', body: init.body ? Buffer.from(init.body).toString() : null }); return new Response('txid123'); };
    const target = {};
    pool.install(target);
    const r = await target.fetch(new Request('https://mempool.space/signet/api/tx', { method: 'POST', body: '0200beef' }));
    assert.equal(await r.text(), 'txid123');
    assert.deepEqual(seen, [{ path: 'tx', method: 'POST', body: '0200beef' }]);
    // the usual (url, init) form is unchanged
    await target.fetch('https://mempool.space/signet/api/tx', { method: 'POST', body: 'abcd' });
    assert.deepEqual(seen[1], { path: 'tx', method: 'POST', body: 'abcd' });
    await target.fetch(new Request('https://mempool.space/signet/api/blocks/tip/height'));
    assert.deepEqual(seen[2], { path: 'blocks/tip/height', method: 'GET', body: null });
  } finally { globalThis.fetch = realFetch; }
});
