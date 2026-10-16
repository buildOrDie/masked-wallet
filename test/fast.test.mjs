// The WebAssembly scanner must give exactly the same results as sp-core on the official BIP 352 vectors.
import fs from 'fs';
import * as sp from '../src/crypto/sp-core.mjs';
import { initFast, fastScanOutputs } from '../src/crypto/sp-fast.mjs';
const { fromHex, toHex, util } = sp;
const wasm = fs.readFileSync(new URL('../node_modules/tiny-secp256k1/lib/secp256k1.wasm', import.meta.url));
if (!(await initFast(wasm))) { console.log('FAIL WebAssembly init'); process.exit(1); }
const V = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url)));
let pass = 0, fail = 0, n = 0;
for (const tc of V) for (const r of tc.receiving) {
  const g = r.given;
  const bScan = util.b2n(fromHex(g.key_material.scan_priv_key)), bSpend = util.b2n(fromHex(g.key_material.spend_priv_key));
  const Bspend = util.mulG(bSpend);
  const pubs = g.vin.map((v) => sp.inputPubKey({ scriptSig: v.scriptSig, witness: sp.parseWitness(v.txinwitness), prevoutScript: v.prevout.scriptPubKey.hex })).filter(Boolean).map((x) => x.pub);
  const tw = sp.txTweak(pubs, g.vin.map((v) => ({ txid: v.txid, vout: v.vout })));
  if (!tw) continue;
  const labels = sp.buildLabels(bScan, g.labels);
  const slow = sp.scanOutputs(tw, g.outputs, bScan, Bspend, labels).map((o) => `${o.output}:${o.tweak}:${o.label}`).sort().join();
  const fast = fastScanOutputs(tw.toRawBytes(true), g.outputs, util.n2b(bScan), Bspend.toRawBytes(true), labels).map((o) => `${o.output}:${o.tweak}:${o.label}`).sort().join();
  n++; if (slow === fast) pass++; else { fail++; console.log('FAIL', tc.comment, '\n slow', slow, '\n fast', fast); }
}
// speed
const rnd = () => util.mod(util.b2n(crypto.getRandomValues(new Uint8Array(32))));
const bScan = rnd(), Bspend = util.mulG(rnd()), labels = sp.buildLabels(bScan, [0]);
const tws = Array.from({ length: 2000 }, () => util.mulG(rnd()).toRawBytes(true));
const outs = Array.from({ length: 2 }, () => toHex(util.xOnly(util.mulG(rnd()))));
const t = performance.now(); for (const x of tws) fastScanOutputs(x, outs, util.n2b(bScan), Bspend.toRawBytes(true), labels);
const ms = performance.now() - t;
console.log(`fast scanner: ${n} vector cases, pass ${pass} fail ${fail} · ${(2000 / ms * 1000).toFixed(0)} tx/s (pure JS here: ~190 tx/s)`);
process.exit(fail ? 1 : 0);
