// Your own block server (Settings) gets every request while it answers; the public ones are only the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const hit = [];
let mineDown = false;
// stub before the pool loads: http.mjs captures fetch at import
globalThis.fetch = async (u) => {
  u = String(u); hit.push(u);
  if (mineDown && u.startsWith('https://mine.example.com/')) return new Response('bad gateway', { status: 502 });
  if (u.startsWith('https://mine.example.com/api/v1/')) return new Response('not found', { status: 404 });
  return new Response('ok');
};
const { EsploraPool } = await import('../src/net/EsploraPool.mjs');

test('block pages all go to your own server instead of being spread over the public ones', async () => {
  const pool = new EsploraPool({ net: () => 'signet', store: { get: () => 'https://mine.example.com/api/' } });
  hit.length = 0;
  for (let i = 0; i < 6; i++) await pool.request(`block/b${i}/txs/0`);
  assert.equal(hit.length, 6);
  assert.ok(hit.every((u) => u.startsWith('https://mine.example.com/api/')), hit.join('\n'));
});

test('your server down (502): the public servers take over, and block pages are spread again', async () => {
  const pool = new EsploraPool({ net: () => 'signet', store: { get: () => 'https://mine.example.com/api/' } });
  mineDown = true; hit.length = 0;
  const r = await pool.request('block/x/txs/0');
  assert.equal(await r.text(), 'ok');
  assert.ok(hit[0].startsWith('https://mine.example.com/'));
  assert.ok(!hit[1].startsWith('https://mine.example.com/'));
  mineDown = false;
});

test('without your own server, block pages are still spread over the public servers', async () => {
  const pool = new EsploraPool({ net: () => 'signet', store: { get: () => '' } });
  hit.length = 0;
  for (let i = 0; i < 6; i++) await pool.request(`block/b${i}/txs/0`);
  assert.ok(new Set(hit.map((u) => new URL(u).host)).size > 1);
});


test('fee rates: your own electrs (no v1 endpoints) passes the question on to mempool.space', async () => {
  const pool = new EsploraPool({ net: () => 'signet', store: { get: () => 'https://mine.example.com/api/' } });
  hit.length = 0;
  const r = await pool.request('v1/fees/precise');
  assert.equal(r.status, 200);
  assert.deepEqual(hit, ['https://mine.example.com/api/v1/fees/precise', 'https://mempool.space/signet/api/v1/fees/precise']);
});
