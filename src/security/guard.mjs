// Checks that catch the common ways people get robbed without any bug in the wallet:
// look-alike addresses (address poisoning), and signature types that hand over control of the coins.

/** The part of an address people actually compare: after the bc1p / bc1q / sp1q prefix. */
const body = (a) => String(a || '').toLowerCase().replace(/^(bc1[pq]|tb1[pq]|t?sp1q?)/, '');

/**
 * A known address this one imitates: same first 4 and last 4 characters after the prefix, but not the same
 * address (scammers send dust from such look-alikes so they show up in your history and get copied).
 * @param {string} to the address about to be paid
 * @param {Iterable<string>} known addresses you have paid before, and your own
 * @returns {string|null} the address it imitates
 */
export function lookAlike(to, known) {
  const t = String(to || '').trim().toLowerCase(), b = body(t);
  if (b.length < 12) return null;
  for (const k of known) {
    const kk = String(k || '').toLowerCase();
    if (!kk || kk === t) continue;
    const kb = body(kk);
    if (kb.slice(0, 4) === b.slice(0, 4) && kb.slice(-4) === b.slice(-4)) return k;
  }
  return null;
}

/** Remember up to 60 addresses this account paid (for look-alike checks; stays on this device). */
export class RecipientBook {
  /** @param {any} store */
  constructor(store) { this.store = store; }
  key(accountId) { return `wren.recips.${accountId}`; }
  list(accountId) { return this.store.getJson(this.key(accountId), []) || []; }
  add(accountId, address) {
    const a = String(address || '').trim();
    if (!a) return;
    this.store.setJson(this.key(accountId), [a, ...this.list(accountId).filter((x) => x.toLowerCase() !== a.toLowerCase())].slice(0, 60));
  }
}

/**
 * How dangerous a signature hash type is for an input you sign.
 * NONE (0x02, 0x82) signs no outputs: whoever holds the signature can send those coins anywhere.
 * SINGLE without ANYONECANPAY (0x03) is unusual. ALL, DEFAULT and SINGLE|ANYONECANPAY (listings) are normal.
 * @returns {'ok'|'unusual'|'blank-cheque'}
 */
export function sighashRisk(types) {
  const list = Array.isArray(types) ? types : types == null ? [] : [types];
  if (list.some((t) => (t & 0x1f) === 0x02)) return 'blank-cheque';
  if (list.some((t) => t === 0x03)) return 'unusual';
  return 'ok';
}
