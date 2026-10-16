// The optional scan server (scan.maskedwallet.com by default on Mainnet). It sends public data per block:
// for each transaction its BIP 352 input tweak and taproot outputs. The private check runs in the wallet,
// so the scan key never leaves this browser.
import { DEFAULT_SCAN, NETWORKS } from '../bitcoin/networks.mjs';
import { timedFetch } from './http.mjs';

const SCAN_NETS = { main: 'main', signet: 'signet' };

export class ScanServer {
  constructor({ net, store }) {
    this.netOf = net;
    this.store = store;
    this.info = { at: 0, data: null, url: '' };
  }

  get key() { return `wren.scansrv.${this.netOf()}`; }
  get defaultUrl() { return DEFAULT_SCAN[this.netOf()] || ''; }

  url() {
    const v = this.store.get(this.key);
    if (v === 'off') return '';
    return v || this.defaultUrl;
  }

  /** The server's /v1/info when it serves this network ({ network, start, height, cutThrough }), else null. */
  async status(force = false) {
    const u = this.url();
    if (!u) return null;
    if (!force && this.info.url === u && Date.now() - this.info.at < 60000) return this.info.data;
    try { const r = await timedFetch(`${u}/v1/info`); this.info.data = r.ok ? await r.json() : null; } catch { this.info.data = null; }
    this.info.at = Date.now(); this.info.url = u;
    return this.info.data;
  }

  /** Does this info belong to a server for the wallet's network? */
  servesNet(info) { return !!info && info.network === SCAN_NETS[this.netOf()]; }

  forget() { this.info.at = 0; }

  markDown() { this.info.data = null; this.info.at = Date.now(); this.info.url = this.url(); }

  /** One block: { h, txs: [[txid, tweakHex, [[vout, xonlyHex, sats]…]]…] }, null when it cannot help, 'down' on failure. */
  async block(height, { cut = false } = {}) {
    const info = await this.status();
    if (!this.servesNet(info) || height < info.start || height > info.height) return null;
    // restoring history: ask only for outputs nobody has spent yet (what the balance needs)
    const q = cut && info.cutThrough ? '?unspent=1' : '';
    let j;
    try {
      const r = await timedFetch(`${this.url()}/v1/block/${height}${q}`);
      if (!r.ok) { if (r.status === 404) return null; this.markDown(); return null; }
      j = await r.json();
    } catch { this.markDown(); return null; }
    if (j.h !== height || !Array.isArray(j.txs)) return null;
    return j;
  }

  /**
   * Settings: use another scan server, or turn it off ('').
   * @param {string} url
   * @param {{ requestPermission?: (url: string) => Promise<void> }} [opts]
   */
  async save(url, opts = {}) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error('Enter a URL like https://scan.example.com');
    if (url) {
      await opts.requestPermission?.(url);
      let info = null;
      try { const r = await timedFetch(`${url}/v1/info`); info = r.ok ? await r.json() : null; } catch {}
      if (!info || info.service !== 'masked-scan') throw new Error('That is not a MASKED scan server (no /v1/info).');
      if (info.network !== SCAN_NETS[this.netOf()]) throw new Error(`That scan server is for ${info.network}, but the wallet is on ${NETWORKS[this.netOf()].name}.`);
    }
    if (url) this.store.set(this.key, url);
    else if (this.defaultUrl) this.store.set(this.key, 'off');
    else this.store.remove(this.key);
    this.forget();
  }

  useDefault() { this.store.remove(this.key); this.forget(); }
}
