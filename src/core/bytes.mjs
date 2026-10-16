// Byte helpers shared by the transaction, inscription and signing code.
import { concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { toHex, fromHex } from '../crypto/sp-core.mjs';

export { toHex, fromHex };
export const concat = concatBytes;
export const enc = new TextEncoder();
export const dec = new TextDecoder();
export const ZERO32 = new Uint8Array(32);

export const u8 = (n) => Uint8Array.from([n]);
export const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
export const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
export const rev = (b) => Uint8Array.from(b).reverse();

/** Bitcoin CompactSize. */
export const varint = (n) => (n < 0xfd ? u8(n) : n <= 0xffff ? concat(u8(0xfd), u8(n & 255), u8(n >> 8)) : concat(u8(0xfe), u32le(n)));
export const compactSizeLength = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

/** Minimal script push of a byte string. */
export function push(b) {
  if (b.length === 0) return u8(0);
  if (b.length <= 75) return concat(u8(b.length), b);
  if (b.length <= 255) return concat(u8(76), u8(b.length), b);
  return concat(u8(77), u8(b.length & 255), u8(b.length >> 8), b);
}

export const sha256d = (b) => sha256(sha256(b));
export const b64 = (u) => btoa(String.fromCharCode(...u));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return toHex(b);
}

/** Lexicographic a < b for equal-length byte strings. */
export function lessThan(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
