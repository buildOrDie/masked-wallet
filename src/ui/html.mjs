// Small HTML building blocks shared by every screen. Views are template strings; anything that comes
// from outside (addresses, tickers, messages) goes through esc().
import qrcode from 'qrcode-generator';
import { esc } from '../core/format.mjs';
import { isV2 } from '../ordinals/brc20.mjs';

export const I = {
  send: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  recv: '<svg viewBox="0 0 24 24"><path d="M17 7 7 17M15 17H7V9"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  shieldPlain: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6l-7-3Z"/></svg>',
  mint: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="13" rx="3"/><path d="M16 12.5h2M3.5 9.5h17"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18 9 12l6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
};

export const btcLogo = '<span class="coin btc">₿</span>';
export const shieldLogo = `<span class="coin sh">${I.shieldPlain}</span>`;
export const sideLogo = (side) => (side === 'shielded' ? `${shieldLogo}Shielded` : `${btcLogo}Public`);

export const copyBtn = (val, label = 'Copy') => `<button class="btn ghost sm" data-copy="${esc(val)}">${I.copy}<span>${label}</span></button>`;
export const backBtn = (to = 'home') => `<button class="icon-btn" data-go="${to}" aria-label="Back">${I.back}</button>`;
export const head = (title, to = 'home') => `<div class="view-head">${backBtn(to)}<h1>${title}</h1><span class="head-sp"></span></div>`;
/** A view head whose back button carries its own data attribute (e.g. data-mintback). */
export const headWith = (attr, title) => `<div class="view-head"><button class="icon-btn" ${attr} aria-label="Back">${I.back}</button><h1>${title}</h1><span class="head-sp"></span></div>`;
export const rowKV = (k, v) => `<div class="kvrow"><span>${k}</span><span>${v}</span></div>`;

/** A segmented control bound to form field `name`. */
export const seg = (name, value, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, label]) => `<button role="radio" aria-checked="${value === v}" data-set="${name}" data-val="${v}">${label}</button>`).join('')}</div>`;

export const tokBadge = (tick) => (isV2(tick) ? '<span class="badge v2">BRC2.0</span>' : '<span class="badge">BRC-20</span>');
export const tokIcon = (tick, big = false) => `<span class="tok-ic ${big ? 'big' : ''}">${esc(tick.slice(0, 2).toUpperCase())}</span>`;

/** An address in groups of four, alternating shades. */
export const addrChunks = (a) => a.match(/.{1,4}/g).map((c, i) => `<span class="${i % 2 ? 'alt' : ''}">${c}</span>`).join('');

/** QR code as SVG (addresses in upper case: alphanumeric mode, a smaller code). */
export function qrSvg(text) {
  const q = qrcode(0, 'M');
  const addr = /^t?sp1|^(bc|tb)1/i.test(text) || /^[0-9a-f]+$/i.test(text); // addresses and raw transactions: alphanumeric mode
  q.addData(addr ? text.toUpperCase() : text, addr ? 'Alphanumeric' : 'Byte');
  q.make();
  const n = q.getModuleCount(), m = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" class="qr" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
