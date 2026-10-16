// Ordinal inscription envelopes: writing them into a taproot leaf, and reading them back from a witness.
import { concat, dec, enc, fromHex, push, u8, compactSizeLength } from '../core/bytes.mjs';
import { TAPROOT_ANNEX_PREFIX, TAP_LEAF_VERSION } from '../bitcoin/taproot.mjs';

export const OP = { FALSE: 0x00, IF: 0x63, ENDIF: 0x68, CHECKSIG: 0xac };
export const CT_TEXT = 'text/plain;charset=utf-8';
/** Every inscription (mint, deploy, reservation) carries 330 sats: the taproot dust limit. */
export const DEFAULT_REVEAL_VALUE = 330;
/** Transfer inscriptions carry 330 sats too (like UniSat). */
export const TRANSFER_POSTAGE = 330;
/** Smallest change output worth making. */
export const DUST_CHANGE = 330;
/** Coins at or below this size are treated as carrying an inscription and never picked for sends. */
export const INSCRIPTION_MAX = 1000;

/** <pubkey> CHECKSIG FALSE IF "ord" 1 <type> [3 <parent>] 0 <body…> ENDIF */
export function inscriptionScript(pubkeyX, contentType, body, parent = null) {
  const chunks = [];
  for (let i = 0; i < body.length; i += 520) chunks.push(push(body.slice(i, i + 520)));
  return concat(
    push(pubkeyX), u8(OP.CHECKSIG), u8(OP.FALSE), u8(OP.IF),
    push(enc.encode('ord')), push(u8(1)), push(enc.encode(contentType)),
    ...(parent ? [push(u8(3)), push(parent)] : []),
    push(new Uint8Array()), ...chunks, u8(OP.ENDIF),
  );
}

/** Commit + reveal sizes and fees for one inscription paid from one coin. */
export function estimateOrdinalMint({ inputValue, feeRate, bodyLength }) {
  const bodyChunks = Math.ceil(bodyLength / 520) || 1;
  const commitVbytes = 10.5 + 57.5 + 43 + 43;
  const revealWitnessWeight = 64 + compactSizeLength(bodyLength) + bodyLength + 65;
  const revealVbytes = 10.5 + 57.5 + 43 + revealWitnessWeight / 4 + bodyChunks;
  const commitFee = Math.ceil(commitVbytes * feeRate);
  const revealFee = Math.ceil(revealVbytes * feeRate);
  const revealValue = DEFAULT_REVEAL_VALUE;
  const change = inputValue - revealValue - commitFee - revealFee;
  return { commitVbytes, revealVbytes, commitFee, revealFee, revealValue, change, totalFee: commitFee + revealFee };
}
/** Fee of a one-input taproot transaction with `outputs` outputs. */
export const estimateSimpleSend = ({ outputs, feeRate }) => Math.ceil((10.5 + 57.5 + outputs * 43) * feeRate);

/** Script → pushes (Uint8Array) and opcodes ({ op }). */
export function parseScriptPushes(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const op = s[i++];
    if (op === 0) out.push(new Uint8Array());
    else if (op <= 75) { out.push(s.slice(i, i + op)); i += op; }
    else if (op === 76) { const n = s[i]; out.push(s.slice(i + 1, i + 1 + n)); i += 1 + n; }
    else if (op === 77) { const n = s[i] | (s[i + 1] << 8); out.push(s.slice(i + 2, i + 2 + n)); i += 2 + n; }
    else if (op === 78) { const n = new DataView(s.buffer, s.byteOffset + i, 4).getUint32(0, true); out.push(s.slice(i + 4, i + 4 + n)); i += 4 + n; }
    else if (op >= 0x51 && op <= 0x60) out.push(Uint8Array.from([op - 0x50]));
    else out.push({ op });
  }
  return out;
}

/** Every envelope in one input's witness (hex items), as { contentType, body }. */
export function envelopesIn(witnessHex) {
  let w = witnessHex.map((h) => fromHex(h));
  if (w.length >= 2 && w[w.length - 1][0] === TAPROOT_ANNEX_PREFIX) w = w.slice(0, -1);
  if (w.length < 2) return [];
  const cb = w[w.length - 1];
  if (cb.length < 33 || (cb.length - 33) % 32 !== 0 || (cb[0] & 0xfe) !== TAP_LEAF_VERSION) return [];
  const items = parseScriptPushes(w[w.length - 2]);
  const env = [];
  for (let i = 0; i + 2 < items.length; i++) {
    const a = items[i], b = items[i + 1], c = items[i + 2];
    if (a instanceof Uint8Array && a.length === 0 && b?.op === OP.IF && c instanceof Uint8Array && dec.decode(c) === 'ord') {
      let j = i + 3; const tags = {}; const body = [];
      for (; j < items.length && items[j]?.op !== OP.ENDIF; j += 2) {
        const tag = items[j];
        if (!(tag instanceof Uint8Array)) break;
        if (tag.length === 0) { j++; for (; j < items.length && items[j]?.op !== OP.ENDIF; j++) if (items[j] instanceof Uint8Array) body.push(items[j]); break; }
        tags[tag[0]] = items[j + 1];
      }
      env.push({ contentType: tags[1] ? dec.decode(tags[1]) : '', body: body.length ? concat(...body) : new Uint8Array() });
      i = j;
    }
  }
  return env;
}

/** BRC-20 fields of an envelope, or just its content type. */
export function describeEnvelope(e) {
  if (/^(text\/plain|application\/json)/.test(e.contentType)) {
    try {
      const j = JSON.parse(dec.decode(e.body));
      if (j && j.p === 'brc-20' && typeof j.op === 'string') return { brc20: true, op: j.op, tick: String(j.tick || '').toLowerCase(), amt: j.amt, max: j.max, hash: j.hash };
    } catch {}
  }
  return { brc20: false, contentType: e.contentType };
}
