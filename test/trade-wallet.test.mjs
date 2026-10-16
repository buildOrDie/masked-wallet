// The wallet's PSBT signing with the private trade address, run on the real wallet source (src/app.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import * as sp from '../src/sp-core.mjs';
import * as trade from '../src/trade-core.mjs';

const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const cut = (a, b) => { const i = source.indexOf(a), j = source.indexOf(b); assert.ok(i > 0 && j > i, `slice ${a}`); return source.slice(i, j); };
const tradeSrc = cut('// ---- private trading ----', 'function tradeSection()');
const psbtSrc = cut('function addrOfScript(script)', '// ---- approval window ----');

const bSpend = 0x1234567890abcdefn * 977n;
const fundPriv = sp.util.n2b(0xfeedbeefn * 31337n);
const fundEven = (() => { let d = sp.util.b2n(fundPriv); if (sp.util.mulG(d).toRawBytes(true)[0] === 3) d = secp256k1.CURVE.n - d; return sp.util.n2b(d); })();
const internalX = schnorr.getPublicKey(fundEven);
const pub = btc.p2tr(internalX);
const store = new Map();

function wallet() {
  const state = { net: 'main', wallet: { bSpend, source: 'mnemonic' }, fundingCoins: [], tradeCoins: [], coins: [] };
  const c = vm.createContext({
    state, btc, trade, sp, Date, JSON, Math, Number, String, Array, Set, Map, Error, BigInt,
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    walletId: () => 'main:test', canSign: () => true, INSCRIPTION_MAX: 1000,
    fromHex: (h) => hex.decode(h), toHex: (b) => hex.encode(b), p2trScript: (x) => hex.decode('5120' + x),
    fundingInfo: () => ({ internalX: hex.encode(internalX), outputX: hex.encode(pub.tweakedPubkey), address: pub.address }),
    accountPriv: () => fundEven, btcNet: () => btc.NETWORK, isProtected: () => false, unverified: () => false,
  });
  vm.runInContext(tradeSrc + psbtSrc + ';this.api={tradeKeyAt,tradeKeyBySpk,tradeSt,saveTradeSt,analysePsbt,signPsbtHex,tradeCur,keyPathFor,holderList};', c);
  return c.api;
}
function sigsValid(tx) {
  const scripts = [], amounts = [];
  for (let j = 0; j < tx.inputsLength; j++) { const w = tx.getInput(j).witnessUtxo; scripts.push(w.script); amounts.push(w.amount); }
  for (let j = 0; j < tx.inputsLength; j++) {
    const sig = tx.getInput(j).finalScriptWitness?.[0];
    if (!sig) return false;
    const sh = sig.length === 65 ? sig[64] : 0;
    if (!schnorr.verify(sig.slice(0, 64), tx.preimageWitnessV1(j, scripts, sh, amounts), scripts[j].slice(2))) return false;
  }
  return true;
}

test('the wallet derives the same trade addresses as trade-core', () => {
  const w = wallet();
  assert.equal(w.tradeKeyAt(0).address, trade.tradeKey(bSpend, 0).address);
  assert.equal(w.tradeCur().index, 0);
  assert.equal(w.tradeKeyBySpk(trade.tradeKey(bSpend, 1).spk).index, 1, 'the next address is recognised too');
  assert.equal(w.tradeKeyBySpk(trade.tradeKey(bSpend, 5).spk), null, 'addresses far ahead are not');
  const s = w.tradeSt(); s.cur = 4; w.saveTradeSt();
  assert.equal(wallet().tradeCur().index, 4, 'the current address survives a reload');
  s.cur = 0; w.saveTradeSt();
});

test('one PSBT with a trade input and a Public input: both signed, both valid', () => {
  const w = wallet();
  const T = w.tradeKeyAt(0);
  const tx = new btc.Transaction();
  tx.addInput({ txid: 'aa'.repeat(32), index: 0, witnessUtxo: { script: hex.decode(T.spk), amount: 40_000n } });
  tx.addInput({ txid: 'bb'.repeat(32), index: 1, witnessUtxo: { script: pub.script, amount: 30_000n } });
  tx.addOutput({ script: hex.decode(T.spk), amount: 60_000n });
  const psbt = hex.encode(tx.toPSBT());
  const a = w.analysePsbt(psbt, { toSignInputs: [{ index: 0, address: T.address }, { index: 1, address: pub.address }] });
  assert.equal(a.inputs[0].trade, 0); assert.equal(a.inputs[1].trade, null);
  assert.equal(a.outputs[0].ours, true); assert.equal(a.trade, true);
  assert.equal(a.net, 60_000 - 70_000);
  const signed = btc.Transaction.fromPSBT(hex.decode(w.signPsbtHex(psbt, { autoFinalized: true, toSignInputs: [{ index: 0 }, { index: 1 }] })));
  assert.ok(sigsValid(signed));
});

test('inputs of other addresses are refused', () => {
  const w = wallet();
  const other = btc.p2tr(schnorr.getPublicKey(sp.util.n2b(99n)));
  const tx = new btc.Transaction();
  tx.addInput({ txid: 'dd'.repeat(32), index: 0, witnessUtxo: { script: other.script, amount: 1000n } });
  tx.addOutput({ script: other.script, amount: 500n });
  assert.throws(() => w.analysePsbt(hex.encode(tx.toPSBT()), { toSignInputs: [{ index: 0 }] }), /does not belong/);
});

