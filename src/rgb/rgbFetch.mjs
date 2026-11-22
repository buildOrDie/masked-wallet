// The RGB engine's network requests, kept polite: at most a few at a time, and a busy server (429/503) gets a
// pause and a retry instead of a burst. Without this, RGB's address scan can get the shared block server
// rate-limited, and the wallet's own balance check then waits behind it. 502/504 (a server having a bad
// moment) is retried the same way.
// The build points rgb-lib-wasm's fetch calls here (scripts/build-extension.mjs).

export const RGB_MAX_REQUESTS = 3;
const RETRIES = 4;
// a request that never answers held one of the 3 places for good: after three of them every RGB step waited
// forever ("Updating…" that never ends). Each try gets this long, then counts as a busy server.
export const RGB_REQUEST_TIMEOUT_MS = 30_000;
let timeoutMs = RGB_REQUEST_TIMEOUT_MS;
/** For tests. */
export function rgbSetTimeout(ms) { timeoutMs = ms; }
let active = 0;
const queue = [];

async function slot() {
  if (active >= RGB_MAX_REQUESTS) await new Promise((r) => queue.push(r));
  active++;
}
function release() { active--; queue.shift()?.(); }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch for the RGB engine. Goes through the wallet's own fetch (so a custom block server from Settings is used).
 * @param {RequestInfo | URL} input @param {RequestInit} [init]
 */
export async function rgbFetch(input, init) {
  // a transaction never changes, and a confirmed one stays confirmed: checking a token's history asks about every
  // transaction in it, again for each transfer (thousands of requests while lots were signed). Answered from memory.
  const key = cacheKey(input, init);
  if (key) {
    const url = urlOf(input);
    const hit = txCache.get(key);
    if (hit && hit.until > Date.now()) { tally(false); return answer(hit, url); }
    if (inflight.has(key)) { tally(false); return answer(await inflight.get(key), url); }
    const p = fetchAndKeep(key, input, init);
    inflight.set(key, p);
    try { return answer(await p, url); } finally { inflight.delete(key); }
  }
  const u = urlOf(input);
  if (TIP_PATH.test(safePath(u))) return tipChecked(u, () => send(input, init));
  return send(input, init);
}
/**
 * The wallet's own lookup of one transaction (its bytes, or its JSON for an output's value and script): answered from
 * what the engine already fetched when it can, kept the same way, and never queued behind the engine's requests.
 * Anything else goes straight to the network. @param {string} url
 */
export async function keptFetch(url) {
  const key = cacheKey(url, undefined);
  if (!key) return fetch(url);
  const hit = txCache.get(key);
  if (hit && hit.until > Date.now()) { tally(false); return answer(hit, url); }
  if (inflight.has(key)) { tally(false); return answer(await inflight.get(key), url); }
  const p = fetchAndKeep(key, url, undefined, (u) => fetch(u));
  inflight.set(key, p);
  try { return answer(await p, url); } finally { inflight.delete(key); }
}
const urlOf = (input) => (typeof input === 'string' ? input : input instanceof URL ? input.href : /** @type {any} */ (input)?.url || '');
// how many transaction lookups went to the network and how many were answered here, logged now and then
const counts = { net: 0, kept: 0, at: 0 };
function tally(net) {
  counts[net ? 'net' : 'kept']++;
  if (Date.now() - counts.at > 30_000 && counts.net) { counts.at = Date.now(); try { console.info('[MASKED] RGB transaction lookups', { fromNetwork: counts.net, fromMemory: counts.kept }); } catch { /* no console */ } }
}

// ---- the transaction cache (block server GETs about one transaction) ----
const TX_PATH = /\/tx\/([0-9a-f]{64})(\/(raw|hex|status))?$/i;
const MAX_CACHED = 5000;
/** @type {Map<string, { status: number, type: string, body: ArrayBuffer, url: string, until: number }>} */
const txCache = new Map();
/** @type {Map<string, Promise<{ status: number, type: string, body: ArrayBuffer, url: string, until: number }>>} */
const inflight = new Map();
function cacheKey(input, init) {
  const method = String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET') return '';
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : /** @type {any} */ (input)?.url || '';
  try {
    const u = new URL(url), m = TX_PATH.exec(u.pathname);
    if (!m || u.search) return '';
    // a transaction's bytes and its confirmed status are the same on every block server: one key whichever server
    // asked (switching servers, or a fallback, asked again for every transaction); the JSON view stays per server
    return m[3] ? `https://tx.masked/${m[1].toLowerCase()}/${m[3].toLowerCase()}` : u.href;
  } catch { return ''; }
}
// Kept across MASKED's windows too (each approval is a new page that would ask about every transaction again): a
// transaction for good, a confirmed status for 10 minutes, in the browser's Cache Storage (not the small localStorage).
const SHARED = 'masked-rgb-tx-v1';
async function sharedGet(key) {
  try {
    if (!globalThis.caches) return null;
    const r = await (await caches.open(SHARED)).match(key);
    if (!r) return null;
    const until = Number(r.headers.get('x-kept-until') || 0);
    if (until < Date.now()) return null;
    return { status: r.status, type: r.headers.get('content-type') || '', body: await r.arrayBuffer(), url: key, until };
  } catch { return null; }
}
function sharedPut(key, e) {
  try {
    if (!globalThis.caches || e.status !== 200) return;
    caches.open(SHARED).then((c) => c.put(key, new Response(e.body.slice(0), { status: 200, headers: { 'content-type': e.type || 'application/octet-stream', 'x-kept-until': String(e.until) } }))).catch(() => {});
  } catch { /* this window only */ }
}
async function fetchAndKeep(key, input, init, sender = send) {
  const kept = await sharedGet(key);
  if (kept) {
    tally(false);
    if (txCache.size >= MAX_CACHED) txCache.delete(txCache.keys().next().value);
    txCache.set(key, kept);
    return kept;
  }
  tally(true);
  let r = await sender(input, init);
  // a block server that says "not confirmed" (or doesn't know the transaction) can be behind or wrong: the RGB
  // engine then waits for a block forever ("waiting for a block" on tokens confirmed days ago). Checked once more on
  // mempool.space before it's believed (2.31.3)
  if (/\/status$/i.test(key)) r = await statusChecked(urlOf(input), r);
  const body = await r.arrayBuffer();
  const type = r.headers.get('content-type') || '';
  let keepMs = 0;
  if (r.ok) {
    if (/\/status$/i.test(key)) {
      // confirmed: kept 10 minutes (a reorg on a test network is rare); not yet: 5 s, enough to answer a burst once
      let confirmed = false;
      try { confirmed = !!JSON.parse(new TextDecoder().decode(body))?.confirmed; } catch { /* not kept long */ }
      keepMs = confirmed ? 600_000 : 5_000;
    } else keepMs = 30 * 24 * 3600_000; // the transaction itself never changes: kept a month (it was a day)
  }
  const entry = { status: r.status, type, body, url: r.url || key, until: Date.now() + keepMs };
  if (keepMs) {
    if (txCache.size >= MAX_CACHED) txCache.delete(txCache.keys().next().value);
    txCache.set(key, entry);
    // only what lasts: a transaction, or a confirmed status (an unconfirmed one is good for 5 s, this window only)
    if (keepMs >= 600_000) sharedPut(key, entry);
  }
  return entry;
}
// The engine (reqwest) reads response.url and stops dead on an empty one ("url parse": an uncaught throw that left
// the step hanging forever). A Response built here has no url of its own, so it gets the address it answers.
const answer = (e, url = '') => {
  const r = new Response(e.body.slice(0), { status: e.status, headers: e.type ? { 'content-type': e.type } : {} });
  Object.defineProperty(r, 'url', { value: url || e.url, configurable: true });
  return r;
};
/** For tests: forget what was kept. */
export function rgbCacheClear() { txCache.clear(); inflight.clear(); try { globalThis.caches?.delete(SHARED).catch(() => {}); } catch { /* none */ } }


// ---- a second opinion for the answers that decide "confirmed": a transaction's status and the chain tip ----
const TIP_PATH = /\/blocks\/tip\/height$/i;
const safePath = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
/**
 * mempool.space's Signet API for a Signet block server other than mempool.space, else ''. Signet only: on Mainnet a
 * server the person set for privacy is never second-guessed (that would show mempool.space their transactions), and
 * other test networks (Utexo's) aren't mempool.space's.
 */
export function referenceFor(u) {
  let x; try { x = new URL(u); } catch { return ''; }
  if (x.hostname === 'mempool.space') return '';
  return /signet/i.test(x.hostname + x.pathname) ? 'https://mempool.space/signet/api' : '';
}
async function refGet(path, base) {
  const r = await globalThis.fetch(base + path, { signal: AbortSignal.timeout(8000) });
  return r.ok ? r : null;
}
/** An unconfirmed (or unknown) status from another server: mempool.space's answer instead, when it says confirmed. */
async function statusChecked(u, r) {
  const ref = referenceFor(u);
  if (!ref) return r;
  let confirmed = false;
  const own = r.clone();
  try { confirmed = r.ok && !!(await own.json())?.confirmed; } catch { confirmed = false; }
  if (confirmed) return r;
  const m = /\/tx\/([0-9a-f]{64})\/status$/i.exec(safePath(u));
  if (!m) return r;
  try {
    const x = await refGet(`/tx/${m[1]}/status`, ref);
    if (!x) return r;
    const body = await x.arrayBuffer();
    if (!JSON.parse(new TextDecoder().decode(body))?.confirmed) return r;
    console.info('[MASKED] confirmed on mempool.space, not on', new URL(u).host, m[1]);
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  } catch { return r; }
}
let refTip = { base: '', at: 0, height: 0 };
/** The chain tip: the higher of this server's and mempool.space's (asked at most every 30 s), so a server stuck behind
 * the chain can't make confirmed transfers look unconfirmed. */
async function tipChecked(u, own) {
  const ref = referenceFor(u);
  const r = await own();
  if (!ref || !r.ok) return r;
  const text = (await r.clone().text()).trim();
  const mine = Number(text);
  if (refTip.base !== ref || Date.now() - refTip.at > 30_000) {
    try { const x = await refGet('/blocks/tip/height', ref); const h = x ? Number((await x.text()).trim()) : 0; if (h > 0) refTip = { base: ref, at: Date.now(), height: h }; } catch { /* this server's own answer */ }
  }
  if (refTip.base === ref && refTip.height > mine + 1) {
    console.info('[MASKED] block server', new URL(u).host, 'is behind the chain:', mine, 'vs', refTip.height);
    const out = new Response(String(refTip.height), { status: 200, headers: { 'content-type': 'text/plain' } });
    Object.defineProperty(out, 'url', { value: u, configurable: true });
    return out;
  }
  return r;
}

async function send(input, init) {
  await slot();
  try {
    for (let i = 0; ; i++) {
      const [url, opts] = await unpack(input, init);
      let r;
      const limit = AbortSignal.timeout(timeoutMs);
      const signal = opts?.signal ? /** @type {any} */ (AbortSignal).any([opts.signal, limit]) : limit;
      try { r = await globalThis.fetch(url, { ...(opts || {}), signal }); } catch (e) {
        const timedOut = limit.aborted && !opts?.signal?.aborted;
        console.warn('[RGB] request failed', /** @type {any} */ (input)?.url || String(input), timedOut ? 'no answer in time' : e?.name, e?.message || e);
        if (timedOut && i < 1) continue; // once more: a server can drop one request
        if (timedOut) throw new Error('The block server did not answer in time.');
        throw e;
      }
      if ([429, 502, 503, 504].includes(r.status) && i < RETRIES) { await pause(1000 * 2 ** i); continue; }
      return r;
    }
  } finally { release(); }
}

/**
 * The engine hands fetch a Request object. Passed on as an address plus options with the body already read: the
 * phone app's native HTTP (CapacitorHttp) takes a Request's body from request.body, which old Android WebViews
 * don't have (Chrome < 105), so every POST went out empty there: the RGB transfer server's server.info check failed
 * and buying said "No valid transport endpoint found". Read fresh each time (a body can be read once), so a retry
 * sends it again.
 * @param {RequestInfo | URL} input @param {RequestInit} [init] @returns {Promise<[string | URL, RequestInit | undefined]>}
 */
export async function unpack(input, init) {
  if (typeof Request === 'undefined' || !(input instanceof Request)) return [/** @type {string | URL} */ (input), init];
  const req = input.clone();
  const method = (init?.method || req.method || 'GET').toUpperCase();
  // CapacitorHttp sends a Uint8Array as is (an ArrayBuffer would go out as "{}"), and a multipart upload only as FormData
  const multipart = /^multipart\/form-data/i.test(req.headers.get('content-type') || '');
  const body = init?.body ?? (method === 'GET' || method === 'HEAD' ? undefined : multipart ? await req.formData() : new Uint8Array(await req.arrayBuffer()));
  const headers = new Headers(req.headers);
  if (multipart && body instanceof FormData) headers.delete('content-type'); // the new body sets its own boundary
  if (init?.headers) for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
  return [req.url, { ...(init || {}), method, headers, body, signal: init?.signal ?? req.signal }];
}

/** For tests: how many requests are in flight. */
export const rgbInFlight = () => active;
