// Network fee rates and the BTC price, from the blockchain servers.
import { r2 } from '../core/format.mjs';
import { readJson } from './http.mjs';

export const FEE_MIN = 0.1;
export const FEE_MAX = 2000;

export class FeeOracle {
  constructor({ net, servers, store = null }) {
    this.netOf = net;
    this.servers = servers;
    this.store = store;
    // the last rates seen, so a payment signed offline still gets a sensible fee
    this.rates = store?.getJson(this.ratesKey, null) || { slow: 1, normal: 2, fast: 4 };
    this.usd = null;
    this.usdAt = 0;
  }

  async refresh() {
    // mempool.space's precise endpoint has sub-1 sat/vB rates; other servers fall back to whole numbers
    let j = null;
    try { const r = await fetch(`${this.servers.base()}v1/fees/precise`); if (r.ok) { const x = await r.json(); if (x && x.fastestFee > 0) j = x; } } catch {}
    if (!j) j = await readJson(await fetch(`${this.servers.base()}v1/fees/recommended`), 'Fee lookup');
    const minimum = Math.max(0.1, Number(j.minimumFee) || 0.1);
    const half = Number(j.halfHourFee) || Number(j.hourFee) || 1, hour = Number(j.hourFee) || half;
    const slow = r2(Math.max(minimum, half < 1 ? half : hour));
    const normal = Math.max(slow, half >= 1 ? Math.round(half) : 1);
    const fast = Math.max(normal, Math.ceil(Number(j.fastestFee) || normal));
    this.rates = { slow, normal, fast };
    this.store?.setJson(this.ratesKey, this.rates);
  }

  get ratesKey() { return `wren.fees.${this.netOf()}`; }

  /** A custom rate typed in the form, or 0 when it is out of range. */
  static custom(text) {
    const v = Number(String(text || '').replace(',', '.'));
    return v >= FEE_MIN && v <= FEE_MAX ? r2(v) : 0;
  }

  /** The rate the form picked (slow / normal / fast / custom). */
  rate(form) {
    if (form.fee === 'custom') return FeeOracle.custom(form.feeCustom) || this.rates.normal;
    return this.rates[form.fee] || this.rates.normal;
  }

  async refreshPrice() {
    if (this.netOf() !== 'main') { this.usd = null; return; }
    if (this.usdAt && Date.now() - this.usdAt < 5 * 60000) return;
    try {
      const r = await fetch(`${this.servers.base()}v1/prices`);
      if (r.ok) { const j = await r.json(); if (j.USD > 0) { this.usd = j.USD; this.usdAt = Date.now(); } }
    } catch {}
  }

  /** "$12.34" on Mainnet once the price is known, '' otherwise. */
  usdOf(sats) {
    if (this.netOf() !== 'main' || !this.usd) return '';
    return `$${((sats / 1e8) * this.usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
