// Blockchain servers (Esplora API) with failover. When one rate-limits (429), errors or times out, the next
// one is used and the first rests for a while. A custom server from Settings is always tried first.
import { ESPLORA } from '../bitcoin/networks.mjs';
import { timedFetch } from './http.mjs';

/** How many block pages are fetched at once while scanning: halves on 429, grows back slowly. */
export class ScanLimiter {
  constructor() { this.conc = 8; this.ok = 0; this.busy = 0; }
  onRateLimit() { this.conc = Math.max(2, Math.floor(this.conc / 2)); this.ok = 0; }
  onPage() { if (++this.ok >= 30) { this.ok = 0; this.conc = Math.min(24, this.conc + 1); } }
  async slot() {
    while (this.busy >= this.conc) await new Promise((r) => setTimeout(r, 25));
    this.busy++;
  }
  release() { this.busy--; }
}

export class EsploraPool {
  /**
   * @param {object} o
   * @param {() => string} o.net    current network key
   * @param {import('../core/LocalStore.mjs').LocalStore} o.store
   */
  constructor({ net, store }) {
    this.netOf = net;
    this.store = store;
    this.resting = new Map(); // base → resting until (ms)
    this.strikes = new Map(); // base → failures in a row
    this.roundRobin = 0;
    this.active = null;       // the server that answered last
    this.limiter = new ScanLimiter();
  }

  static hostOf(base) { try { return new URL(base).host; } catch { return base; } }

  get customKey() { return `wren.esplora.${this.netOf()}`; }
  custom() { return this.store.get(this.customKey) || ''; }
  defaults() { return ESPLORA[this.netOf()]; }

  list() {
    const c = this.custom();
    return [...(c ? [c.replace(/\/*$/, '/')] : []), ...this.defaults()];
  }

  isResting(base) { return (this.resting.get(base) || 0) > Date.now(); }

  /** The base URL to build request URLs with (the first one that is not resting). */
  base() {
    const l = this.list();
    return l.find((b) => (this.resting.get(b) || 0) < Date.now()) || l[0];
  }

  /** Send `path` to the servers in turn until one answers. */
  async request(path, init) {
    const list = this.list();
    // every server is resting: wait for the first one to come back (max 15 s) instead of failing
    if (list.every((b) => this.isResting(b)) && list.some((b) => this.strikes.get(b))) {
      const back = Math.min(...list.map((b) => this.resting.get(b))) - Date.now();
      await new Promise((r) => setTimeout(r, Math.min(15000, Math.max(200, back))));
    }
    let order = [...list].sort((a, b) => Number(this.isResting(a)) - Number(this.isResting(b)));
    // block data is public and identical everywhere: spread it over all servers to double the speed
    if (/^block(-height)?\//.test(path)) {
      const up = order.filter((b) => !this.isResting(b));
      if (up.length > 1) { const k = this.roundRobin++ % up.length; order = [...up.slice(k), ...up.slice(0, k), ...order.filter((b) => this.isResting(b))]; }
    }
    let last = null, lastErr = null;
    for (const base of order) {
      const mempoolOnly = /^v1\//.test(path) && !/mempool\.space/.test(base) && !this.custom();
      try {
        if (mempoolOnly && path.startsWith('v1/fees/recommended')) {
          // Blockstream has /fee-estimates instead: map it to the same shape
          const r = await timedFetch(base + 'fee-estimates', init);
          if (r.ok) { const f = await r.json(); return new Response(JSON.stringify({ fastestFee: f['1'] || f['2'], halfHourFee: f['3'] || f['2'], hourFee: f['6'] || f['3'] }), { status: 200 }); }
          last = r; this.resting.set(base, Date.now() + 30000); continue;
        }
        if (mempoolOnly) { last = new Response('not supported', { status: 404 }); continue; }
        const r = await timedFetch(base + path, init);
        // 429 = rate limit; Blockstream also answers 403 once its hourly per-IP cap is hit
        if (r.status === 429 || r.status === 403 || r.status >= 500) {
          const k = (this.strikes.get(base) || 0) + 1; this.strikes.set(base, k);
          // 2 s, 4 s, 8 s … up to 30 s (10 min for an hourly cap)
          this.resting.set(base, Date.now() + (r.status === 403 ? 600000 : Math.min(30000, 1000 * 2 ** k)));
          last = r;
          if (r.status === 429) this.limiter.onRateLimit();
          continue;
        }
        this.strikes.delete(base);
        if (/^block\//.test(path)) this.limiter.onPage();
        this.active = base;
        return r;
      } catch (e) { this.resting.set(base, Date.now() + 10000); lastErr = e; }
    }
    if (last) return last;
    throw lastErr || new Error('No server reachable');
  }

  /** Route every fetch to one of our servers through the failover; everything else goes out as is. */
  install(target = globalThis) {
    target.fetch = (input, init = {}) => {
      const url = typeof input === 'string' ? input : /** @type {any} */ (input)?.url;
      if (typeof url === 'string') {
        const base = this.list().find((b) => url.startsWith(b));
        if (base) return this.request(url.slice(base.length), init);
      }
      return timedFetch(input, init);
    };
  }

  /**
   * Settings: use (or stop using) your own server. It must answer like an Esplora API.
   * @param {string} url
   * @param {{ requestPermission?: (url: string) => Promise<void> }} [opts]
   */
  async saveCustom(url, opts = {}) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error('Enter a URL like https://mempool.example.com/api');
    if (url) {
      await opts.requestPermission?.(url);
      const r = await timedFetch(url + '/blocks/tip/height').catch(() => null);
      if (!r || !r.ok || !/^\d+$/.test((await r.text()).trim())) throw new Error('That server did not answer like an Esplora API (/blocks/tip/height).');
    }
    if (url) this.store.set(this.customKey, url + '/'); else this.store.remove(this.customKey);
    this.active = null;
  }
}
