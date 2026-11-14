// In the phone app, public block servers go through the WebView's own fetch (CapacitorWebFetch), not Android's HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';

test('the app sends mempool.space and blockstream.info through the WebView, the rest through CapacitorHttp', async () => {
  const calls = [];
  globalThis.fetch = async (input) => { calls.push(['native', String(input?.url || input)]); return new Response('ok'); };
  globalThis.CapacitorWebFetch = async (input) => { calls.push(['web', String(input?.url || input)]); return new Response('ok'); };
  const { rawFetch, timedFetch } = await import('../src/net/http.mjs?app');
  await rawFetch('https://mempool.space/signet/api/block-height/0');
  await timedFetch(new Request('https://blockstream.info/api/block-height/0'));
  await rawFetch('https://scan.maskedwallet.com/rgb-proxy-v1/json-rpc', { method: 'POST', body: '{}' });
  await rawFetch('https://mempool.space.evil.example/x');
  assert.deepEqual(calls.map((c) => c[0]), ['web', 'web', 'native', 'native']);
  delete globalThis.CapacitorWebFetch;
});
