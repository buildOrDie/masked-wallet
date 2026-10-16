// BIP 352 Silent Payments core — sender, receiver, address and input-key extraction.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { bytesToHex as toHex, hexToBytes as fromHex, concatBytes as concat } from '@noble/hashes/utils';
import { bech32m } from '@scure/base';

export { toHex, fromHex };
const Point = secp256k1.ProjectivePoint;
const N = secp256k1.CURVE.n;
export const K_MAX = 2323;
const NUMS_H = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

const mod = (a) => ((a % N) + N) % N;
const b2n = (b) => BigInt('0x' + (toHex(b) || '0'));
const n2b = (n) => fromHex(n.toString(16).padStart(64, '0'));
const ser32 = (k) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, k, false); return b; };
const ser32le = (k) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, k, true); return b; };
const hash160 = (b) => ripemd160(sha256(b));
const tagCache = {};
export function taggedHash(tag, ...msgs) {
  const t = tagCache[tag] || (tagCache[tag] = sha256(new TextEncoder().encode(tag)));
  return sha256(concat(t, t, ...msgs));
}
const liftX = (x) => Point.fromHex(concat(new Uint8Array([2]), x));
const xOnly = (P) => P.toRawBytes(true).slice(1);
const hasOddY = (P) => P.toRawBytes(true)[0] === 3;
const mulG = (n) => Point.BASE.multiply(mod(n));

// ---------- addresses ----------
export function encodeAddress(Bscan, Bspend, network = 'main') {
  const hrp = network === 'main' ? 'sp' : 'tsp';
  const data = concat(toBytes(Bscan), toBytes(Bspend));
  return bech32m.encode(hrp, [0, ...bech32m.toWords(data)], 1023);
}
export function decodeAddress(addr) {
  const { prefix, words } = bech32m.decode(addr.toLowerCase(), 1023);
  if (prefix !== 'sp' && prefix !== 'tsp') throw new Error('Not a silent payment address (expected sp1… or tsp1…)');
  const version = words[0];
  if (version === 31) throw new Error('Unsupported silent payment version 31');
  const data = Uint8Array.from(bech32m.fromWords(words.slice(1)));
  if (version === 0 && data.length !== 66) throw new Error('Bad v0 address payload length');
  if (data.length < 66) throw new Error('Address payload too short');
  const Bscan = Point.fromHex(data.slice(0, 33));
  const Bm = Point.fromHex(data.slice(33, 66));
  return { network: prefix === 'sp' ? 'main' : 'test', version, Bscan, Bm };
}
const toBytes = (P) => (P instanceof Uint8Array ? P : P.toRawBytes(true));

export function labelTweak(bScan, m) {
  return mod(b2n(taggedHash('BIP0352/Label', n2b(bScan), ser32(m))));
}
export function labeledSpend(Bspend, bScan, m) {
  return Bspend.add(mulG(labelTweak(bScan, m)));
}

// ---------- script / witness helpers ----------
export function parseWitness(hex) {
  if (!hex) return [];
  const b = fromHex(hex); let i = 0;
  const varint = () => { const f = b[i++]; if (f < 0xfd) return f; const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8; let v = 0; for (let j = 0; j < n; j++) v += b[i + j] * 2 ** (8 * j); i += n; return v; };
  const count = varint(); const items = [];
  for (let k = 0; k < count; k++) { const len = varint(); items.push(b.slice(i, i + len)); i += len; }
  return items;
}
const isP2PKH = (s) => s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac;
const isP2SH = (s) => s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;
const isP2WPKH = (s) => s.length === 22 && s[0] === 0x00 && s[1] === 0x14;
const isP2TR = (s) => s.length === 34 && s[0] === 0x51 && s[1] === 0x20;

/**
 * Extract the public key BIP 352 uses for an input, or null if the input is not eligible.
 * vin: { scriptSig: hex, witness: Uint8Array[], prevoutScript: hex }
 * Returns { pub: Point, taproot: bool } or null.
 */
export function inputPubKey({ scriptSig, witness, prevoutScript }) {
  const spk = fromHex(prevoutScript || '');
  const ss = fromHex(scriptSig || '');
  const wit = witness || [];
  try {
    if (isP2PKH(spk)) {
      const h = toHex(spk.slice(3, 23));
      for (let i = ss.length; i >= 33; i--) {
        const pk = ss.slice(i - 33, i);
        if (toHex(hash160(pk)) === h) return { pub: Point.fromHex(pk), taproot: false };
      }
      return null;
    }
    if (isP2SH(spk)) {
      const redeem = ss.slice(1);
      if (isP2WPKH(redeem) && wit.length && wit[wit.length - 1].length === 33)
        return { pub: Point.fromHex(wit[wit.length - 1]), taproot: false };
      return null;
    }
    if (isP2WPKH(spk)) {
      if (wit.length && wit[wit.length - 1].length === 33)
        return { pub: Point.fromHex(wit[wit.length - 1]), taproot: false };
      return null;
    }
    if (isP2TR(spk)) {
      let stack = wit.slice();
      if (stack.length > 1 && stack[stack.length - 1][0] === 0x50) stack = stack.slice(0, -1); // annex
      if (stack.length > 1) {
        const control = stack[stack.length - 1];
        if (toHex(control.slice(1, 33)) === NUMS_H) return null;
      }
      return { pub: liftX(spk.slice(2)), taproot: true };
    }
  } catch { return null; }
  return null;
}

function smallestOutpoint(outpoints) {
  const ser = outpoints.map(({ txid, vout }) => concat(fromHex(txid).reverse(), ser32le(vout)));
  ser.sort((a, b) => { for (let i = 0; i < 36; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; });
  return ser[0];
}
export function inputHash(outpoints, A) {
  return mod(b2n(taggedHash('BIP0352/Inputs', smallestOutpoint(outpoints), A.toRawBytes(true))));
}
const tk = (S, k) => mod(b2n(taggedHash('BIP0352/SharedSecret', S.toRawBytes(true), ser32(k))));

// ---------- sender ----------
/**
 * inputs: [{ txid, vout, privKey: hex, taproot: bool }]  (only eligible inputs)
 * allOutpoints: [{txid,vout}] — every input of the tx (for the smallest outpoint)
 * recipients: ['sp1…']
 * Returns [{ address, output: x-only hex }]
 */
export function createOutputs(inputs, allOutpoints, recipients) {
  if (!inputs.length) throw new Error('No eligible inputs');
  let a = 0n;
  for (const { privKey, taproot } of inputs) {
    let d = b2n(fromHex(privKey));
    if (taproot && hasOddY(mulG(d))) d = N - d;
    a = mod(a + d);
  }
  if (a === 0n) throw new Error('Input private keys sum to zero');
  const A = mulG(a);
  const ih = inputHash(allOutpoints, A);
  const groups = new Map();
  recipients.forEach((addr) => {
    const r = decodeAddress(addr);
    const key = r.Bscan.toHex(true);
    if (!groups.has(key)) groups.set(key, { Bscan: r.Bscan, list: [] });
    groups.get(key).list.push({ addr, Bm: r.Bm });
  });
  const out = [];
  for (const { Bscan, list } of groups.values()) {
    if (list.length > K_MAX) throw new Error('Too many recipients for one scan key');
    const S = Bscan.multiply(mod(ih * a));
    list.forEach(({ addr, Bm }, k) => out.push({ address: addr, output: toHex(xOnly(Bm.add(mulG(tk(S, k))))) }));
  }
  return out;
}

// ---------- receiver ----------
/** Compute the per-tx tweak (input_hash·A) from extracted input pubkeys; null if tx is skipped. */
export function txTweak(pubs, outpoints) {
  if (!pubs.length) return null;
  let A = Point.ZERO;
  for (const p of pubs) A = A.add(p);
  if (A.equals(Point.ZERO)) return null;
  return A.multiply(inputHash(outpoints, A));
}

/**
 * Scan outputs (x-only hex[]) given a tweak point.
 * labels: Map<compressedHex of label point, {m, tweak bigint}>
 * Returns [{ output, tweak: hex (priv key tweak), label: m|null }]
 */
export function scanOutputs(tweak, outputs, bScan, Bspend, labels = new Map()) {
  const S = tweak.multiply(mod(bScan));
  let remaining = outputs.map((o) => ({ hex: o.toLowerCase(), P: null }));
  const found = [];
  for (let k = 0; k < K_MAX; k++) {
    const t = tk(S, k);
    const Pk = Bspend.add(mulG(t));
    const pkx = toHex(xOnly(Pk));
    let hit = -1, hitTweak = t, hitLabel = null;
    for (let i = 0; i < remaining.length; i++) {
      const o = remaining[i];
      if (o.hex === pkx) { hit = i; break; }
      if (labels.size) {
        try { o.P = o.P || liftX(fromHex(o.hex)); } catch { continue; }
        for (const cand of [o.P.subtract(Pk), o.P.negate().subtract(Pk)]) {
          if (cand.equals(Point.ZERO)) continue;
          const l = labels.get(cand.toHex(true));
          if (l) { hit = i; hitTweak = mod(t + l.tweak); hitLabel = l.m; break; }
        }
        if (hit >= 0) break;
      }
    }
    if (hit < 0) break;
    found.push({ output: remaining[hit].hex, tweak: toHex(n2b(hitTweak)), label: hitLabel });
    remaining.splice(hit, 1);
  }
  return found;
}

export function buildLabels(bScan, ms) {
  const map = new Map();
  for (const m of ms) { const t = labelTweak(bScan, m); map.set(mulG(t).toHex(true), { m, tweak: t }); }
  return map;
}

/** Full spending key for a found output: b_spend + tweak, negated if needed is handled by the signer. */
export function outputPrivKey(bSpend, tweakHex) {
  return toHex(n2b(mod(bSpend + b2n(fromHex(tweakHex)))));
}

export const util = { b2n, n2b, mod, mulG, xOnly, liftX, Point, hash160 };
