import fs from 'fs';
import * as sp from '../src/crypto/sp-core.mjs';
const { fromHex, toHex, util } = sp;
const V = JSON.parse(fs.readFileSync(new URL('./vectors.json', import.meta.url)));
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };

for (const tc of V) {
  for (const s of tc.sending) {
    const vin = s.given.vin;
    const outpoints = vin.map((v) => ({ txid: v.txid, vout: v.vout }));
    const elig = [];
    for (const v of vin) {
      const r = sp.inputPubKey({ scriptSig: v.scriptSig, witness: sp.parseWitness(v.txinwitness), prevoutScript: v.prevout.scriptPubKey.hex });
      if (r) elig.push({ txid: v.txid, vout: v.vout, privKey: v.private_key, taproot: r.taproot });
    }
    const exp = s.expected.outputs;
    let got;
    try { got = sp.createOutputs(elig, outpoints, s.given.recipients.flatMap((r) => Array(r.count ?? 1).fill(r.address))).map((o) => o.output); }
    catch (e) { got = []; }
    const expFlat = exp.length ? exp : [[]];
    const match = expFlat.some((set) => set.length === got.length && [...set].sort().join() === [...got].sort().join());
    ok(match, `send: ${tc.comment} got=${got.length} exp=${JSON.stringify(exp).slice(0, 80)}`);
  }
  for (const r of tc.receiving) {
    const g = r.given, e = r.expected;
    const bScan = util.b2n(fromHex(g.key_material.scan_priv_key));
    const bSpend = util.b2n(fromHex(g.key_material.spend_priv_key));
    const Bscan = util.mulG(bScan), Bspend = util.mulG(bSpend);
    const addrs = [sp.encodeAddress(Bscan, Bspend), ...g.labels.map((m) => sp.encodeAddress(Bscan, sp.labeledSpend(Bspend, bScan, m)))];
    ok([...addrs].sort().join() === [...e.addresses].sort().join(), `addr: ${tc.comment}`);
    const pubs = [];
    for (const v of g.vin) {
      const x = sp.inputPubKey({ scriptSig: v.scriptSig, witness: sp.parseWitness(v.txinwitness), prevoutScript: v.prevout.scriptPubKey.hex });
      if (x) pubs.push(x.pub);
    }
    const tw = sp.txTweak(pubs, g.vin.map((v) => ({ txid: v.txid, vout: v.vout })));
    if (e.tweak) ok(tw && tw.toHex(true) === e.tweak, `tweak: ${tc.comment}`);
    const labels = sp.buildLabels(bScan, g.labels);
    const found = tw ? sp.scanOutputs(tw, g.outputs, bScan, Bspend, labels) : [];
    if (e.outputs) {
      const want = e.outputs.map((o) => o.pub_key + ':' + o.priv_key_tweak).sort().join();
      const have = found.map((o) => o.output + ':' + o.tweak).sort().join();
      ok(want === have, `recv: ${tc.comment} found=${found.length} exp=${e.outputs.length}`);
    }
    for (const o of found) {
      const d = util.b2n(fromHex(sp.outputPrivKey(bSpend, o.tweak)));
      ok(toHex(util.xOnly(util.mulG(d))) === o.output, `privkey: ${tc.comment}`);
    }
    if (e.n_outputs !== undefined) ok(found.length === e.n_outputs, `n_outputs ${tc.comment}`);
  }
}
console.log(`pass ${pass} fail ${fail}`);
