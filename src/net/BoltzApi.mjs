// Boltz's REST API (v2), only the calls a reverse swap (Lightning → on-chain) needs. Nothing here is trusted:
// every reply is checked in lightning/reverse-swap.mjs before it is used.
import { timedFetch } from './http.mjs';

export const BOLTZ_API = 'https://api.boltz.exchange/v2';

export class BoltzApi {
  constructor(base = BOLTZ_API) { this.base = base; }

  async call(path, body) {
    let res;
    try {
      res = await timedFetch(`${this.base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new Error(`Boltz did not answer (${e.message})`); }
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error(`Boltz: ${j?.error || text || `HTTP ${res.status}`}`.slice(0, 300));
    if (j === null) throw new Error('Boltz sent an unreadable reply');
    return j;
  }

  /** Limits and fees for BTC Lightning → BTC on-chain. */
  async reversePair() {
    const j = await this.call('/swap/reverse');
    const p = j?.BTC?.BTC;
    if (!p?.hash || !p?.limits || !p?.fees) throw new Error('Boltz has no Lightning → Bitcoin pair right now');
    return p;
  }

  createReverse({ invoiceAmount, preimageHash, claimPublicKey, pairHash }) {
    return this.call('/swap/reverse', { from: 'BTC', to: 'BTC', invoiceAmount, preimageHash, claimPublicKey, pairHash });
  }

  status(id) { return this.call(`/swap/${encodeURIComponent(id)}`); }

  lockupTransaction(id) { return this.call(`/swap/reverse/${encodeURIComponent(id)}/transaction`); }

  /** Boltz's half of the key-path claim; sending the preimage lets Boltz settle the invoice. */
  claimSignature(id, { transaction, preimage, pubNonce }) {
    return this.call(`/swap/reverse/${encodeURIComponent(id)}/claim`, { index: 0, transaction, preimage, pubNonce });
  }

  broadcast(hex) { return this.call('/chain/BTC/transaction', { hex }); }
}
