// Formatting and parsing of amounts, times and messages. No wallet state in here.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** "abcdef…uvwxyz": the first and last n characters. */
export const short = (h, n = 10) => (h.length > n * 2 + 1 ? h.slice(0, n) + '…' + h.slice(-n) : h);

/** Sats as BTC without trailing zeros ("0.0001"). */
export function fmtBtc(s) {
  if (s == null) return '0';
  const v = (s / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return v === '' ? '0' : v;
}
export const fmtSats = (s) => (s == null ? '—' : (s / 1e8).toFixed(8).replace(/\B(?=(\d{3})+(?!\d)\.)/g, ' '));

/** Round to 2 decimals (fee rates). */
export const r2 = (x) => Math.round(x * 100) / 100;
export const fmtRate = (r) => (r < 10 ? String(r2(r)) : String(Math.round(r)));

/** A token amount with thousands separators, or the raw text escaped. */
export const fmtTok = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString() : esc(String(v ?? '')); };

/** Total sats of a list of coins. */
export const sumSats = (list) => list.reduce((a, c) => a + (c.sats || 0), 0);

export function ago(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export function dayLabel(ms) {
  if (!ms) return 'Earlier';
  const d = new Date(ms), today = new Date(), yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** "0.0001" (BTC, up to 8 decimals) → sats. */
export function parseBtc(s, unit = 'BTC') {
  const raw = String(s || '').trim().replace(',', '.');
  if (!raw) throw new Error('Enter an amount.');
  if (!/^\d*(\.\d{0,8})?$/.test(raw) || raw === '.') throw new Error(`Enter the amount in ${unit}, e.g. 0.0001`);
  const [whole = '0', frac = ''] = raw.split('.');
  return Number(BigInt(whole || '0') * 100000000n + BigInt(frac.padEnd(8, '0')));
}
/** Sats ("10000") or BTC ("0.0001") → sats. */
export function satsFromInput(s) {
  const raw = String(s || '').trim();
  if (!raw) throw new Error('Enter an amount.');
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!/^\d+(\.\d{1,8})?$/.test(raw)) throw new Error('Amount must be sats or BTC, for example 10000 or 0.0001.');
  const [whole, frac = ''] = raw.split('.');
  return Number(BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0')));
}

/** Decimal token amount → raw units (× 10^dec). */
export function decToRaw(v, dec = 18) {
  const [w, f = ''] = String(v || '0').trim().split('.');
  return BigInt((w || '0').replace(/\D/g, '') || '0') * 10n ** BigInt(dec) + BigInt((f.replace(/\D/g, '') + '0'.repeat(dec)).slice(0, dec) || '0');
}
/** Raw units → "1,234.5". */
export function formatRaw(raw, dec = 18) {
  const s = String(raw || '0').replace(/^0+(?=\d)/, '');
  if (!dec) return BigInt(s).toLocaleString();
  const whole = s.length > dec ? s.slice(0, -dec) : '0';
  const frac = (s.length > dec ? s.slice(-dec) : s.padStart(dec, '0')).replace(/0+$/, '');
  return BigInt(whole).toLocaleString() + (frac ? '.' + frac.slice(0, 8) : '');
}

/** Network and node errors in words people understand. */
export function friendly(m) {
  if (/timeout/i.test(m)) return 'The network did not answer in time. Try again.';
  if (/insufficient fee|min relay fee|mempool min fee/i.test(m)) return 'Fee too low for the network right now. Pick a faster fee.';
  if (/bad-txns-inputs-missingorspent|missing inputs/i.test(m)) return 'That coin was already spent. Tap refresh and try again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Could not reach the network. Check your connection.';
  return m;
}
