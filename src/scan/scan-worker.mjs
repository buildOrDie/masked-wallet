// Background worker for the private Shielded check. The wallet runs several of these (one per CPU core)
// and splits each block's transactions between them. Keys stay in this extension's memory only.
import SECP_WASM from '../../node_modules/tiny-secp256k1/lib/secp256k1.wasm';
import { hexToBytes } from '@noble/hashes/utils';
import { initFast, fastScanOutputs } from '../crypto/sp-fast.mjs';
import * as sp from '../crypto/sp-core.mjs';

const ready = initFast(SECP_WASM);
let K = null;
self.onmessage = async (e) => {
  const m = e.data;
  const fast = await ready;
  if (m.type === 'keys') {
    K = { bScan32: m.bScan32, Bspend33: m.Bspend33, bScan: BigInt('0x' + m.bScanHex), labels: new Map(m.labels.map(([hex, lm, tw]) => [hex, { m: lm, tweak: BigInt('0x' + tw) }])) };
    return;
  }
  if (m.type === 'scan') {
    const out = [];
    try {
      const Bspend = fast ? null : sp.util.Point.fromHex(m.Bspend33Hex || sp.toHex(K.Bspend33));
      for (let i = 0; i < m.items.length; i++) {
        const [tw, outs] = m.items[i];
        const f = fast ? fastScanOutputs(hexToBytes(tw), outs, K.bScan32, K.Bspend33, K.labels) : sp.scanOutputs(sp.util.Point.fromHex(tw), outs, K.bScan, Bspend, K.labels);
        if (f.length) out.push([i, f]);
      }
      self.postMessage({ id: m.id, out });
    } catch (err) { self.postMessage({ id: m.id, error: String(err?.message || err) }); }
  }
};
