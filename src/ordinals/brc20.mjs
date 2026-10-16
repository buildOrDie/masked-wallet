// BRC-20 and BRC2.0 rules, following Best in Slot's OPI indexer:
//  * 4-byte tickers are BRC-20; 6-byte tickers ([a-z0-9-]) are BRC2.0.
//  * BRC2.0 deploys take two steps. "predeploy" {"p":"brc-20","op":"predeploy","hash":H}, with
//    H = sha256(sha256(tick || salt || pkscript)) and pkscript the output that receives the predeploy;
//    then, at least 3 blocks later, "deploy" {"op":"deploy","tick","max","lim","salt"} inscribed as a
//    CHILD of the predeploy inscription (the parent is spent in the same reveal).
import { sha256 } from '@noble/hashes/sha256';
import * as sp from '../crypto/sp-core.mjs';
import { concat, enc, fromHex, rev, toHex, u32le } from '../core/bytes.mjs';

export const PREDEPLOY_DELAY = 3;

export const tickLen = (t) => enc.encode(t).length;
export const isV2 = (t) => tickLen(String(t || '')) === 6;
export const normTick = (t) => String(t || '').trim().toLowerCase();

export function checkTick(t, { deploy = false } = {}) {
  const n = tickLen(t);
  if (n === 6) { if (!/^[a-z0-9-]{6}$/.test(t)) throw new Error('BRC2.0 tickers use letters, numbers or dashes only.'); return; }
  if (deploy) throw new Error('BRC2.0 tickers are exactly 6 characters.');
  if (n === 4) return;
  if (n === 5) throw new Error('5-character tickers are self-mint only and are not supported here.');
  throw new Error('Ticker must be 4 characters (BRC-20) or 6 characters (BRC2.0).');
}

export function checkAmount(v, label) {
  v = String(v || '').trim();
  if (!/^\d+(\.\d+)?$/.test(v) || /^0+(\.0+)?$/.test(v)) throw new Error(`${label} must be a number above 0.`);
  return v;
}

export const jsonBody = (o) => enc.encode(JSON.stringify(o));
export const mintBody = (tick, amt) => jsonBody({ p: 'brc-20', op: 'mint', tick, amt });
export const transferBody = (tick, amt) => jsonBody({ p: 'brc-20', op: 'transfer', tick, amt });

/** The salt comes from the scan key + ticker + attempt, so a lost record can be rebuilt from the recovery phrase. */
export function deriveSalt(bScan, tick, attempt = 0) {
  return toHex(sp.taggedHash('MASKED/predeploy-salt', sp.util.n2b(bScan), enc.encode(tick), u32le(attempt)).slice(0, 16));
}

export function predeployHash(tick, saltHex, pkscriptHex) {
  return toHex(sha256(sha256(concat(enc.encode(tick), fromHex(saltHex), fromHex(pkscriptHex)))));
}

/** Parent tag value for an inscription id "<txid>i<index>" (txid reversed, index little-endian without trailing zeros). */
export function parentIdBytes(id) {
  const m = /^([0-9a-f]{64})i(\d+)$/.exec(id);
  if (!m) throw new Error('Bad parent inscription id.');
  const idx = u32le(+m[2]);
  let end = 4; while (end > 0 && idx[end - 1] === 0) end--;
  return concat(rev(fromHex(m[1])), idx.slice(0, end));
}

export const outpointBytes = (txid, vout) => concat(rev(fromHex(txid)), u32le(vout));
