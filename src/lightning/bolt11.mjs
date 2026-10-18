// BOLT 11 invoices: just enough decoding to check one before showing it (network, amount, payment hash,
// expiry). The signature is not checked here: what protects the payer is the payment hash, which must be
// the hash of a preimage only this wallet knows.
import { bech32 } from '@scure/base';
import { toHex } from '../core/bytes.mjs';

/** Invoice prefix per network. */
export const LN_PREFIX = { main: 'lnbc', signet: 'lntbs', testnet: 'lntb', regtest: 'lnbcrt' };

const MSAT_PER_BTC = 100_000_000_000n;
/** The multiplier letter divides one bitcoin by this much. */
const DIVISOR = { '': 1n, m: 1_000n, u: 1_000_000n, n: 1_000_000_000n, p: 1_000_000_000_000n };

/** Amount part of the prefix ("2500u") → millisatoshi, or null for an invoice without an amount. */
export function amountMsat(amount) {
  if (!amount) return null;
  const m = amount.match(/^(\d+)([munp]?)$/);
  if (!m) throw new Error('Invoice amount is not readable');
  const total = BigInt(m[1]) * MSAT_PER_BTC, div = DIVISOR[m[2]];
  if (total % div) throw new Error('Invoice amount has sub-millisatoshi precision');
  return total / div;
}

const wordsToInt = (w) => w.reduce((a, x) => a * 32 + x, 0);

/**
 * Decode a BOLT 11 invoice.
 * @param {string} invoice
 * @returns {{ prefix: string, network: string|null, msat: bigint|null, sats: number|null, timestamp: number, expiry: number, paymentHash: string, description: string }}
 */
export function decodeInvoice(invoice) {
  const s = String(invoice || '').trim().toLowerCase().replace(/^lightning:/, '');
  const { prefix, words } = bech32.decode(/** @type {`${string}1${string}`} */ (s), 10_000);
  const m = prefix.match(/^(lnbcrt|lntbs|lntb|lnbc)(\d*[munp]?)$/);
  if (!m) throw new Error('Not a Lightning invoice');
  const network = Object.keys(LN_PREFIX).find((k) => LN_PREFIX[k] === m[1]) || null;
  const msat = amountMsat(m[2]);
  if (words.length < 35 + 104) throw new Error('Invoice is too short');
  const data = words.slice(0, words.length - 104); // the last 104 words are the signature
  const timestamp = wordsToInt(data.slice(0, 7));
  let i = 7, paymentHash = '', expiry = 3600, description = '';
  while (i + 3 <= data.length) {
    const type = data[i], len = data[i + 1] * 32 + data[i + 2];
    const field = data.slice(i + 3, i + 3 + len);
    i += 3 + len;
    if (field.length !== len) throw new Error('Invoice field is cut short');
    if (type === 1 && len === 52) paymentHash = toHex(Uint8Array.from(bech32.fromWords(field)));
    else if (type === 6) expiry = wordsToInt(field);
    else if (type === 13) { try { description = new TextDecoder().decode(Uint8Array.from(bech32.fromWordsUnsafe(field) || [])); } catch {} }
  }
  if (!paymentHash) throw new Error('Invoice has no payment hash');
  return { prefix: m[1], network, msat, sats: msat == null ? null : Number(msat / 1000n), timestamp, expiry, paymentHash, description };
}
