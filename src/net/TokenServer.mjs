// The BRC-20 token server: MASKED's own (tokens.maskedwallet.com, a UniSat-checked OPI cache) by default on
// Mainnet, any OPI brc20_api in Settings, or off.
import { DEFAULT_TOKENS } from '../bitcoin/networks.mjs';
import { tickLen } from '../ordinals/brc20.mjs';

export class TokenServer {
  constructor({ net, store }) {
    this.netOf = net;
    this.store = store;
    this.tickers = new Map(); // `${net}:${tick}` → { at, data, busy }
  }

  get key() { return `wren.indexer.${this.netOf()}`; }

  url() {
    const v = this.store.get(this.key);
    return v === 'off' ? '' : v || DEFAULT_TOKENS[this.netOf()] || '';
  }

  /** Save a server URL ('' = off; on Mainnet "off" is stored so the default stays off). */
  setUrl(url) {
    if (url) this.store.set(this.key, url);
    else if (DEFAULT_TOKENS[this.netOf()]) this.store.set(this.key, 'off');
    else this.store.remove(this.key);
  }

  /** GET a path; `result` of the reply (with the gateway's `validation` copied onto it), null for "no balance". */
  async get(path) {
    // never let a slow or offline server hang the wallet
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    let r;
    try { r = await fetch(this.url().replace(/\/+$/, '') + path, { signal: ctl.signal }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'Indexer not responding' : 'Indexer unreachable'); }
    finally { clearTimeout(timer); }
    const text = await r.text();
    let j;
    try { j = text ? JSON.parse(text) : {}; } catch { j = text; }
    if (r.status === 400 && /no balance/i.test(j.error || '')) return null;
    if (!r.ok || j.error) throw new Error(j.error || `Indexer error ${r.status}`);
    const result = j?.result ?? j;
    if (result && typeof result === 'object' && j?.validation) {
      if (Array.isArray(result)) { for (const item of result) if (item && typeof item === 'object' && !item.validation) item.validation = j.validation; }
      else if (!result.validation) result.validation = j.validation;
    }
    return result;
  }

  /** Every token an address holds: the list, [] for none, null when the server cannot answer. */
  async walletTokens(address) {
    if (!this.url()) return null;
    try {
      const list = await this.get(`/v1/brc20/wallet_tokens?address=${address}`);
      return Array.isArray(list) ? list.filter((t) => t.ticker).map((t) => ({ ...t, ticker: String(t.ticker).toLowerCase() })) : list == null ? [] : null;
    } catch { return null; }
  }

  /**
   * Supply of a ticker ({ max, minted, soldOut, selfMint, holders } or { unknown: true }), cached for a minute.
   * Returns the cache entry at once and refreshes it in the background; `onUpdate` runs when it lands.
   */
  tickerInfo(tick, onUpdate) {
    tick = String(tick || '').trim().toLowerCase();
    if (!this.url() || ![4, 5, 6].includes(tickLen(tick))) return null;
    const k = `${this.netOf()}:${tick}`;
    let e = this.tickers.get(k);
    if (!e || (!e.busy && Date.now() - e.at > 60000)) {
      e = { at: Date.now(), data: e?.data, busy: true };
      this.tickers.set(k, e);
      const entry = e;
      this.get(`/v1/brc20/ticker_info?ticker=${encodeURIComponent(tick)}`)
        .then((d) => { entry.data = d && d.max != null ? d : d === null ? { unknown: true } : entry.data; })
        .catch((err) => { if (/unknown ticker/i.test(err.message)) entry.data = { unknown: true }; })
        .finally(() => { entry.busy = false; entry.at = Date.now(); onUpdate?.(); });
    }
    return e;
  }
}
