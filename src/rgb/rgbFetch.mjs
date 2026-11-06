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
      // a Request body can be read once: send a copy each time
      const req = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
      const r = await globalThis.fetch(req, init);
      if ([429, 502, 503, 504].includes(r.status) && i < RETRIES) { await pause(1000 * 2 ** i); continue; }
      return r;
    }
  } finally { release(); }
}

/** For tests: how many requests are in flight. */
export const rgbInFlight = () => active;
