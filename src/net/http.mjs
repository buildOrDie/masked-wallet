// fetch with a deadline: a stalled request must never freeze the wallet.

export const NET_TIMEOUT_MS = 15000;

/** The browser's own fetch, captured before EsploraPool routes blockchain URLs through its failover. */
export const rawFetch = globalThis.fetch.bind(globalThis);

export function timedFetch(input, init = {}) {
  if (init.signal) return rawFetch(input, init);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  return rawFetch(input, { ...init, signal: ctl.signal })
    .catch((e) => { throw e?.name === 'AbortError' ? new Error('Network timeout: the server did not answer in time') : e; })
    .finally(() => clearTimeout(t));
}

/** rawFetch with its own (shorter) deadline, which also covers `read` (e.g. reading the body). */
export async function fetchWithin(ms, input, init = {}, read = (r) => r) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await read(await rawFetch(input, { ...init, signal: ctl.signal })); } finally { clearTimeout(t); }
}

export async function readJson(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (${res.status}).`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned an unexpected reply.`); }
}

/** GET with retries; busy servers (429) get more patience than ones that do not answer at all. */
export async function fetchRetry(url, label, tries = 2) {
  let last, busy = 0, dead = 0;
  while (dead < 2 && busy < tries) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      last = new Error(`${label} (${r.status})`);
      if (r.status === 429) busy++; else dead++;
    } catch (e) { last = e; dead++; }
    await new Promise((res) => setTimeout(res, 600 * (busy + dead)));
  }
  throw last;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
