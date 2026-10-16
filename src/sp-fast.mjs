// Fast BIP 352 receive check using libsecp256k1 compiled to WebAssembly (the build shipped by
// tiny-secp256k1, MIT). Same maths as sp-core's scanOutputs, 20–50× faster than pure JS.
// Everything stays local: the scan key never leaves this function.
//
//   await initFast(wasmBytes)            once; returns false if WebAssembly is unavailable
//   fastScanOutputs(tweak33, outputsXonlyHex, bScan32, Bspend33, labels)  -> [{ output, tweak, label }]
//   fastLabels(bScan, ms)                -> label table for fastScanOutputs
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex as toHex, hexToBytes as fromHex, concatBytes as concat } from '@noble/hashes/utils';
import * as sp from './sp-core.mjs';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
let W = null, M = null;
const view = (ptr, n) => { if (!M || M.byteLength === 0) M = new Uint8Array(W.memory.buffer); return M.subarray(ptr, ptr + n); };

export async function initFast(bytes) {
  if (W) return true;
  try {
    if (typeof WebAssembly === 'undefined') return false;
    const { instance } = await WebAssembly.instantiate(bytes, {
      './rand.js': { generateInt32: () => crypto.getRandomValues(new Int32Array(1))[0] },
      './validate_error.js': { throwError: (code) => { throw new Error(`secp256k1 error ${code}`); } },
    });
    W = instance.exports; M = null;
    W.initializeContext();
    // self-test against the pure-JS implementation before trusting it
    const k = fromHex('6e5f2a4d1c3b8a7f9e0d1c2b3a4f5e6d7c8b9a0f1e2d3c4b5a69788796a5b4c3');
    const P = sp.util.mulG(7n).toRawBytes(true);
    const want = sp.util.Point.fromHex(P).multiply(sp.util.b2n(k)).toHex(true);
    if (toHex(mul(P, k)) !== want) throw new Error('self-test failed');
    return true;
  } catch { W = null; return false; }
}
export const fastReady = () => !!W;

function mul(P, k) {
  const pub = view(W.PUBLIC_KEY_INPUT.value, 65), tw = view(W.TWEAK_INPUT.value, 32);
  try { pub.set(P); tw.set(k); return W.pointMultiply(33, 33) === 1 ? view(W.PUBLIC_KEY_INPUT.value, 33).slice() : null; }
  finally { view(W.PUBLIC_KEY_INPUT.value, 65).fill(0); view(W.TWEAK_INPUT.value, 32).fill(0); }
}
function addScalar(P, t) {
  const pub = view(W.PUBLIC_KEY_INPUT.value, 65), tw = view(W.TWEAK_INPUT.value, 32);
  try { pub.set(P); tw.set(t); return W.pointAddScalar(33, 33) === 1 ? view(W.PUBLIC_KEY_INPUT.value, 33).slice() : null; }
  finally { view(W.PUBLIC_KEY_INPUT.value, 65).fill(0); view(W.TWEAK_INPUT.value, 32).fill(0); }
}
function add(A, B) {
  const a = view(W.PUBLIC_KEY_INPUT.value, 65), b = view(W.PUBLIC_KEY_INPUT2.value, 65);
  try { a.set(A); b.set(B); return W.pointAdd(33, 33, 33) === 1 ? view(W.PUBLIC_KEY_INPUT.value, 33).slice() : null; }
  finally { view(W.PUBLIC_KEY_INPUT.value, 65).fill(0); view(W.PUBLIC_KEY_INPUT2.value, 65).fill(0); }
}
const n32 = (n) => fromHex(n.toString(16).padStart(64, '0'));
const ser32 = (k) => new Uint8Array([k >>> 24, (k >>> 16) & 255, (k >>> 8) & 255, k & 255]);
const SS_TAG = sha256(new TextEncoder().encode('BIP0352/SharedSecret'));
const tk = (S, k) => { const h = sha256(concat(SS_TAG, SS_TAG, S, ser32(k))); return BigInt('0x' + toHex(h)) % N; };

/** labels: Map<compressedHex, { m, tweak: bigint }> — the same table sp.buildLabels makes. */
export function fastScanOutputs(tweak33, outputs, bScan32, Bspend33, labels = new Map()) {
  const S = mul(tweak33, bScan32);
  if (!S) return [];
  let remaining = outputs.map((o) => o.toLowerCase());
  const found = [];
  for (let k = 0; k < sp.K_MAX && remaining.length; k++) {
    const t = tk(S, k);
    const Pk = addScalar(Bspend33, n32(t));
    const pkx = toHex(Pk.subarray(1));
    let hit = remaining.indexOf(pkx), hitTweak = t, hitLabel = null;
    if (hit < 0 && labels.size) {
      // labelled output: x(Pk + L_m) must be one of the outputs (one point addition per label)
      for (const [lhex, l] of labels) {
        const Q = add(Pk, l.bytes || (l.bytes = fromHex(lhex)));
        const i = Q ? remaining.indexOf(toHex(Q.subarray(1))) : -1;
        if (i >= 0) { hit = i; hitTweak = (t + l.tweak) % N; hitLabel = l.m; break; }
      }
    }
    if (hit < 0) break;
    found.push({ output: remaining[hit], tweak: toHex(n32(hitTweak)), label: hitLabel });
    remaining.splice(hit, 1);
  }
  return found;
}
