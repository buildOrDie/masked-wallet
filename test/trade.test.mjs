// Private trading: trade addresses, signing on them, and moves between Shielded and a trade address.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1';
import * as sp from '../src/crypto/sp-core.mjs';
import { tradeKey, buildShieldedPay, buildReturnToShielded, TRADE_PADDING } from '../src/trade/trade-core.mjs';

const { util, toHex, fromHex } = sp;
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL', msg); } };
const throws = (fn, re, msg) => { try { fn(); ok(false, `${msg} (did not throw)`); } catch (e) { ok(re.test(e.message), `${msg}: ${e.message}`); } };
const txid = (k) => k.toString(16).padStart(2, '0').repeat(32);

// a wallet
const bScan = util.mod(util.b2n(sp.taggedHash('test', new TextEncoder().encode('scan'))));
const bSpend = util.mod(util.b2n(sp.taggedHash('test', new TextEncoder().encode('spend'))));
const Bscan = util.mulG(bScan), Bspend = util.mulG(bSpend);
const shieldAddr = sp.encodeAddress(Bscan, Bspend);
const changeAddr = sp.encodeAddress(Bscan, sp.labeledSpend(Bspend, bScan, 0));
const labels = sp.buildLabels(bScan, [0]);

/** Check every finalized input's Schnorr signature against the transaction (what a node does). */
function sigsValid(tx) {
  const scripts = [], amounts = [];
  for (let j = 0; j < tx.inputsLength; j++) { const w = tx.getInput(j).witnessUtxo; scripts.push(w.script); amounts.push(w.amount); }
  for (let j = 0; j < tx.inputsLength; j++) {
    const w = tx.getInput(j).finalScriptWitness;
    if (!w) return `input ${j} unsigned`;
    const sig = w[0], sh = sig.length === 65 ? sig[64] : 0;
    if (!schnorr.verify(sig.slice(0, 64), tx.preimageWitnessV1(j, scripts, sh, amounts), scripts[j].slice(2))) return `input ${j} bad signature`;
  }
  return true;
}
/** Silent-payment outputs of a signed tx that belong to the wallet. */
function scanOwn(tx) {
  const vin = [];
  for (let j = 0; j < tx.inputsLength; j++) {
    const i = tx.getInput(j);
    vin.push({ txid: hex.encode(i.txid), vout: i.index, scriptSig: '', witness: i.finalScriptWitness, prevoutScript: hex.encode(i.witnessUtxo.script) });
  }
  const pubs = vin.map((v) => sp.inputPubKey(v)).filter(Boolean).map((r) => r.pub);
  const tw = sp.txTweak(pubs, vin.map((v) => ({ txid: v.txid, vout: v.vout })));
  const outs = [];
  for (let k = 0; k < tx.outputsLength; k++) outs.push(hex.encode(tx.getOutput(k).script.slice(2)));
  return sp.scanOutputs(tw, outs, bScan, Bspend, labels).map((f) => ({ ...f, vout: outs.indexOf(f.output), value: Number(tx.getOutput(outs.indexOf(f.output)).amount) }));
}

// ---------------------------------------------------------------- derivation
const T0 = tradeKey(bSpend, 0), T1 = tradeKey(bSpend, 1), T0b = tradeKey(bSpend, 0);
ok(T0.address === T0b.address && T0.priv === T0b.priv, 'derivation is deterministic');
ok(T0.address !== T1.address, 'each index has its own address');
ok(/^bc1p[02-9ac-hj-np-z]{58}$/.test(T0.address), `mainnet bc1p address ${T0.address}`);
ok(/^tb1p/.test(tradeKey(bSpend, 0, 'signet').address), 'signet tb1p address');
ok(toHex(util.xOnly(util.mulG(util.b2n(fromHex(T0.priv))))) === T0.outputX, 'priv key matches the output key');
ok(T0.spk === '5120' + T0.outputX, 'script is P2TR of the output key');
ok(T0.address !== btc.Address(btc.NETWORK).encode({ type: 'tr', pubkey: util.xOnly(Bspend) }), 'not the plain spend key address');
throws(() => tradeKey(null, 0), /spend key/, 'watch-only wallets cannot derive');
throws(() => tradeKey(bSpend, -1), /index/, 'bad index');
// the result must not depend on the scan key: a scan server cannot find trade addresses
const otherScan = tradeKey(bSpend, 3);
ok(otherScan.address === tradeKey(bSpend, 3).address, 'scan key not used');

// ---------------------------------------------------------------- Shielded → trade address
// a Shielded coin: someone pays the wallet's sp1 address
const senderPriv = toHex(util.n2b(12345678901234567890n));
const spOut = sp.createOutputs([{ txid: txid(9), vout: 0, privKey: senderPriv, taproot: true }], [{ txid: txid(9), vout: 0 }], [shieldAddr])[0];
const senderX = util.xOnly(util.mulG(util.b2n(fromHex(senderPriv))));
const found = sp.scanOutputs(sp.txTweak([util.liftX(senderX)], [{ txid: txid(9), vout: 0 }]), [spOut.output], bScan, Bspend, labels);
ok(found.length === 1, 'test Shielded coin found by the scanner');
const shCoin = { txid: txid(10), vout: 0, value: 100_000, priv: sp.outputPrivKey(bSpend, found[0].tweak) };
ok(toHex(util.xOnly(util.mulG(util.b2n(fromHex(shCoin.priv))))) === spOut.output, 'Shielded coin key matches');
const fund = buildShieldedPay({ coins: [shCoin], outputs: [{ script: fromHex(T1.spk), value: TRADE_PADDING }, { script: fromHex(T1.spk), value: 40_000 }], changeAddress: changeAddr, feeRate: 2 });
const Ftx = btc.Transaction.fromRaw(hex.decode(fund.hex), { allowUnknownOutputs: true });
ok(fund.txid === Ftx.id, 'fund txid matches');
ok(Ftx.outputsLength === 3 && toHex(Ftx.getOutput(0).script) === T1.spk && Number(Ftx.getOutput(0).amount) === TRADE_PADDING && Number(Ftx.getOutput(1).amount) === 40_000, 'fund: padding + amount on the trade address');
ok(fund.change === 100_000 - TRADE_PADDING - 40_000 - fund.fee && fund.fee > 0, 'fund: change and fee add up');
const Fpsbt = new btc.Transaction({ allowUnknownOutputs: true });
for (let k = 0; k < Ftx.outputsLength; k++) Fpsbt.addOutput(Ftx.getOutput(k));
Fpsbt.addInput({ txid: shCoin.txid, index: 0, witnessUtxo: { script: fromHex('5120' + spOut.output), amount: 100_000n }, sequence: Ftx.getInput(0).sequence });
Fpsbt.updateInput(0, { finalScriptWitness: Ftx.getInput(0).finalScriptWitness }, true);
ok(sigsValid(Fpsbt) === true, `fund: signature valid (${sigsValid(Fpsbt)})`);
const ch = scanOwn(Fpsbt);
ok(ch.length === 1 && ch[0].vout === 2 && ch[0].label === 0, 'fund: change comes back to Shielded (change label)');
ok(fund.outputs[1].vout === 1 && fund.outputs[1].txid === fund.txid, 'fund reports its outputs');
throws(() => buildShieldedPay({ coins: [shCoin], outputs: [{ script: fromHex(T1.spk), value: 200_000 }], changeAddress: changeAddr, feeRate: 2 }), /Not enough Shielded/, 'fund: not enough');
throws(() => buildShieldedPay({ coins: [shCoin], outputs: [{ script: fromHex(T1.spk), value: 100 }], changeAddress: changeAddr, feeRate: 2 }), /at least 330/, 'fund: dust');
// two coins
const two = buildShieldedPay({ coins: [{ ...shCoin, value: 30_000 }, { ...shCoin, txid: txid(11), value: 30_000 }], outputs: [{ script: fromHex(T1.spk), value: 45_000 }], changeAddress: changeAddr, feeRate: 2 });
ok(two.spent.length === 2, 'fund: combines Shielded coins when one is not enough');

// ---------------------------------------------------------------- trade address → Shielded
const back = buildReturnToShielded({
  coins: [{ txid: txid(12), vout: 0, value: 930, priv: T1.priv, keep: true }, { txid: txid(13), vout: 1, value: 25_000, priv: T1.priv, keep: false }, { txid: txid(14), vout: 0, value: 330, priv: T1.priv, keep: true }],
  shieldAddress: shieldAddr, feeRate: 2,
});
const Rtx = btc.Transaction.fromRaw(hex.decode(back.hex), { allowUnknownOutputs: true });
ok(Rtx.inputsLength === 3 && Rtx.outputsLength === 3, 'return: one output per inscription coin plus one for the bitcoin');
ok(Number(Rtx.getOutput(0).amount) === 930 && Number(Rtx.getOutput(1).amount) === 330, 'return: inscription coins keep their exact values, in order');
ok(hex.encode(Rtx.getInput(0).txid) === txid(12) && hex.encode(Rtx.getInput(1).txid) === txid(14), 'return: inscription coins go first so their sats map 1:1');
ok(Number(Rtx.getOutput(2).amount) === 25_000 - back.fee, 'return: plain bitcoin minus the fee');
const Rp = new btc.Transaction({ allowUnknownOutputs: true });
for (let k = 0; k < Rtx.outputsLength; k++) Rp.addOutput(Rtx.getOutput(k));
for (let j = 0; j < Rtx.inputsLength; j++) { const i = Rtx.getInput(j); const v = [930, 330, 25_000][j]; Rp.addInput({ txid: i.txid, index: i.index, sequence: i.sequence, witnessUtxo: { script: fromHex(T1.spk), amount: BigInt(v) } }); }
for (let j = 0; j < Rtx.inputsLength; j++) Rp.updateInput(j, { finalScriptWitness: Rtx.getInput(j).finalScriptWitness }, true);
ok(sigsValid(Rp) === true, `return: signatures valid (${sigsValid(Rp)})`);
const mine = scanOwn(Rp);
ok(mine.length === 3 && mine.every((f) => f.label == null), `return: the scanner finds all ${mine.length} outputs as Shielded payments`);
// only inscriptions on the address: a Shielded coin pays the fee
const onlyInsc = buildReturnToShielded({ coins: [{ txid: txid(15), vout: 0, value: 330, priv: T1.priv, keep: true }], extra: [shCoin], shieldAddress: shieldAddr, feeRate: 2 });
ok(onlyInsc.spent.length === 2 && onlyInsc.value === 100_000 - onlyInsc.fee, 'return: tops up the fee from Shielded');
throws(() => buildReturnToShielded({ coins: [{ txid: txid(15), vout: 0, value: 330, priv: T1.priv, keep: true }], shieldAddress: shieldAddr, feeRate: 2 }), /network fee/, 'return: no bitcoin for the fee');
throws(() => buildReturnToShielded({ coins: [], shieldAddress: shieldAddr, feeRate: 2 }), /empty/, 'return: empty');

console.log(`trade: pass ${pass} fail ${fail}`);
if (fail) process.exit(1);
