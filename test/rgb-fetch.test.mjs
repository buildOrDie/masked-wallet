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
