// The RGB engine's network requests, kept polite: at most a few at a time, and a busy server (429/503) gets a
// pause and a retry instead of a burst. Without this, RGB's address scan can get the shared block server
// rate-limited, and the wallet's own balance check then waits behind it. 502/504 (a server having a bad
// moment) is retried the same way.
// The build points rgb-lib-wasm's fetch calls here (scripts/build-extension.mjs).

export const RGB_MAX_REQUESTS = 3;
const RETRIES = 4;
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
  await slot();
  try {
    for (let i = 0; ; i++) {
      const [url, opts] = await unpack(input, init);
      let r;
      try { r = await globalThis.fetch(url, opts); } catch (e) {
        console.warn('[RGB] request failed', /** @type {any} */ (input)?.url || String(input), e?.name, e?.message || e);
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
