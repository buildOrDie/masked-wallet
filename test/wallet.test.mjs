// The wallet's services, run in Node on the real classes (no browser): keys and addresses, transactions,
// coin protection, PSBT signing with the trade address and Shielded holders, and the token server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import * as sp from '../src/crypto/sp-core.mjs';
import * as trade from '../src/trade/trade-core.mjs';
import { walletApp, testKeys, mockFetch, Keyring } from './helpers/wallet-app.mjs';
import { RawTransaction, TxPolicy } from '../src/bitcoin/RawTransaction.mjs';
import { AddressCodec } from '../src/bitcoin/AddressCodec.mjs';
import { TokenServer } from '../src/net/TokenServer.mjs';
import { TokenBook } from '../src/tokens/TokenBook.mjs';
import { TokenView } from '../src/ui/views/TokenView.mjs';
import { pickCoin } from '../src/wallet/CoinStore.mjs';
import { parseBtc, fmtBtc, decToRaw, formatRaw } from '../src/core/format.mjs';
import { LocalStore } from '../src/core/LocalStore.mjs';

const bSpend = 0x1234567890abcdefn * 977n;
const fundPriv = sp.util.n2b(0xfeedbeefn * 31337n);
const fundEven = (() => { let d = sp.util.b2n(fundPriv); if (sp.util.mulG(d).toRawBytes(true)[0] === 3) d = secp256k1.CURVE.n - d; return sp.util.n2b(d); })();
const pub = btc.p2tr(schnorr.getPublicKey(fundEven));
const keys = () => testKeys({ bSpend, fundingPriv: hex.encode(fundPriv) });

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

// ---- keys and addresses ----
test('a recovery phrase gives the BIP 86 Public address other wallets show', () => {
  const k = Keyring.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  assert.equal(k.funding('main').address, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  assert.match(k.silentAddress('main'), /^sp1q/);
  assert.match(Keyring.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', '', 'signet').silentAddress('signet'), /^tsp1q/);
  assert.equal(k.id('main').split(':').length, 3, 'storage ids keep the net:Bscan:Bspend shape of earlier versions');
});

test('addresses are told apart per network', () => {
  const main = new AddressCodec('main'), signet = new AddressCodec('signet');
  assert.equal(main.kind(pub.address).kind, 'public');
  assert.equal(signet.kind(pub.address).kind, 'wrongnet');
  assert.equal(main.kind('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').kind, 'public');
  assert.equal(main.kind('').kind, 'empty');
  assert.equal(main.kind('nonsense').kind, 'invalid');
  assert.equal(main.kind(Keyring.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about').silentAddress('main')).kind, 'shielded');
  assert.equal(hex.encode(main.outputScript(pub.address)), hex.encode(pub.script));
  assert.equal(main.fromScript(pub.script), pub.address);
});

// ---- transactions ----
test('a hand-built transaction serializes, hashes and signs like @scure/btc-signer', () => {
  const k = keys();
  const f = k.funding('main');
  const spk = hex.decode('5120' + f.outputX);
  TxPolicy.rbf = true;
  const tx = new RawTransaction({ inputs: [{ txid: 'ab'.repeat(32), vout: 1, value: 50_000, scriptPubKey: spk }], outputs: [{ value: 40_000, script: pub.script }] });
  const raw = tx.toHex([[tx.signKeyPath(0, f.outputPriv)]]);
  const parsed = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
  assert.equal(parsed.id, tx.txid);
  assert.equal(parsed.getInput(0).sequence, 0xfffffffd, 'RBF on by default');
  const sig = parsed.getInput(0).finalScriptWitness[0];
  assert.ok(schnorr.verify(sig, parsed.preimageWitnessV1(0, [spk], 0, [50_000n]), hex.decode(f.outputX)), 'the key-path signature verifies');
  TxPolicy.rbf = false;
  assert.equal(btc.Transaction.fromRaw(hex.decode(tx.toHex()), { allowUnknownOutputs: true }).getInput(0).sequence, 0xffffffff);
  TxPolicy.rbf = true;
});

test('amounts parse and print without float errors', () => {
  assert.equal(parseBtc('0.00012345'), 12345);
  assert.equal(parseBtc('1,5'), 150000000);
  assert.throws(() => parseBtc('0.000000001'));
  assert.equal(fmtBtc(150000000), '1.5');
  assert.equal(formatRaw(decToRaw('1234.5', 18), 18), '1,234.5');
});

// ---- coins ----
test('coins that may hold an inscription are never spent', () => {
  const app = walletApp(keys());
  app.state.net = 'signet'; // no ord gate on test networks
  app.coins.public = [
    { key: 'a', txid: 'aa'.repeat(32), vout: 0, sats: 330 },
    { key: 'b', txid: 'bb'.repeat(32), vout: 0, sats: 90_000 },
    { key: 'c', txid: 'cc'.repeat(32), vout: 0, sats: 20_000 },
  ];
  assert.deepEqual(app.coins.publicSpendable().map((c) => c.key), ['b', 'c'], 'the 330-sat coin is protected');
  app.coins.toggleLock(`${'bb'.repeat(32)}:0`);
  assert.deepEqual(app.coins.publicSpendable().map((c) => c.key), ['c'], 'a locked coin is not spent either');
  assert.equal(pickCoin(app.coins.publicSpendable(), 15_000).key, 'c');
  app.state.net = 'main';
  assert.deepEqual(app.coins.publicSpendable().map((c) => c.key), [], 'on Mainnet big coins wait for ord');
});

// ---- private trading and PSBTs ----
test('the wallet derives the same trade addresses as trade-core, and remembers the current one', () => {
  const app = walletApp(keys());
  assert.equal(app.trade.keyAt(0).address, trade.tradeKey(bSpend, 0).address);
  assert.equal(app.trade.current().index, 0);
  assert.equal(app.trade.keyBySpk(trade.tradeKey(bSpend, 1).spk).index, 1, 'the next address is recognised too');
  assert.equal(app.trade.keyBySpk(trade.tradeKey(bSpend, 5).spk), null, 'addresses far ahead are not');
  app.trade.st().cur = 4; app.trade.save();
  assert.equal(walletApp(keys()).trade.current().index, 4, 'the current address survives a reload');
  app.trade.st().cur = 0; app.trade.save();
});

test('one PSBT with a trade input and a Public input: both signed, both valid', () => {
  const app = walletApp(keys());
  const T = app.trade.keyAt(0);
  const tx = new btc.Transaction();
  tx.addInput({ txid: 'aa'.repeat(32), index: 0, witnessUtxo: { script: hex.decode(T.spk), amount: 40_000n } });
  tx.addInput({ txid: 'bb'.repeat(32), index: 1, witnessUtxo: { script: pub.script, amount: 30_000n } });
  tx.addOutput({ script: hex.decode(T.spk), amount: 60_000n });
  const psbt = hex.encode(tx.toPSBT());
  const a = app.psbt.analyse(psbt, { toSignInputs: [{ index: 0, address: T.address }, { index: 1, address: pub.address }] });
  assert.equal(a.inputs[0].trade, 0); assert.equal(a.inputs[1].trade, null);
  assert.equal(a.outputs[0].ours, true); assert.equal(a.trade, true);
  assert.equal(a.net, 60_000 - 70_000);
  const signed = btc.Transaction.fromPSBT(hex.decode(app.psbt.sign(psbt, { autoFinalized: true, toSignInputs: [{ index: 0 }, { index: 1 }] })));
  assert.ok(sigsValid(signed));
});

test('inputs of other addresses are refused', () => {
  const app = walletApp(keys());
  const other = btc.p2tr(schnorr.getPublicKey(sp.util.n2b(99n)));
  const tx = new btc.Transaction();
  tx.addInput({ txid: 'dd'.repeat(32), index: 0, witnessUtxo: { script: other.script, amount: 1000n } });
  tx.addOutput({ script: other.script, amount: 500n });
  assert.throws(() => app.psbt.analyse(hex.encode(tx.toPSBT()), { toSignInputs: [{ index: 0 }] }), /does not belong/);
});

test('a listed Shielded holder signs with SIGHASH_SINGLE|ANYONECANPAY; unknown holders are refused', () => {
  const app = walletApp(keys());
  const tweak = '5a'.repeat(32);
  const x = hex.encode(sp.util.xOnly(sp.util.mulG(sp.util.b2n(hex.decode(sp.outputPrivKey(bSpend, tweak))))));
  const spk = '5120' + x;
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: 'ee'.repeat(32), index: 0, witnessUtxo: { script: hex.decode(spk), amount: 330n }, sighashType: 0x83 });
  tx.addOutput({ script: pub.script, amount: 5000n });
  const psbt = hex.encode(tx.toPSBT());
  assert.throws(() => app.psbt.sign(psbt, { toSignInputs: [{ index: 0, sighashTypes: [0x83] }] }), /does not belong/);
  app.trade.holders()[spk] = { tweak, address: app.account.codec.fromScript(hex.decode(spk)) };
  assert.equal(app.trade.keyPathFor(spk).kind, 'shielded');
  const signed = btc.Transaction.fromPSBT(hex.decode(app.psbt.sign(psbt, { autoFinalized: true, toSignInputs: [{ index: 0, sighashTypes: [0x83] }] })));
  const sig = signed.getInput(0).finalScriptWitness[0];
  assert.equal(sig.length, 65); assert.equal(sig[64], 0x83);
  assert.ok(schnorr.verify(sig.slice(0, 64), signed.preimageWitnessV1(0, [hex.decode(spk)], 0x83, [330n]), hex.decode(x)));
});

// ---- the token server ----
test('the token server keeps the gateway validation on object and list replies', async () => {
  const store = new LocalStore();
  const srv = new TokenServer({ net: () => 'main', store });
  let reply = { result: { overall_balance: '1500' }, validation: { status: 'balance_match', balanceStatus: 'matched' } };
  mockFetch(() => reply);
  assert.equal((await srv.get('/balance')).validation.balanceStatus, 'matched');
  reply = { result: [{ ticker: 'worldx' }], validation: { status: 'not_checked' } };
  assert.equal((await srv.get('/list'))[0].validation.status, 'not_checked');
  mockFetch(() => new Response(JSON.stringify({ error: 'no balance' }), { status: 400 }));
  assert.equal(await srv.get('/balance'), null);
});

test('an unverified Public balance never stands in for a per-script OPI check', async () => {
  const app = walletApp(keys());
  app.tokens.known = () => [{ tick: 'worldx' }];
  app.tokens.scripts = () => [app.account.pubSpk()];
  app.tokens.publicToken = () => ({ overall: '999', decimals: 18, validation: { balanceStatus: 'not_checked' } });
  app.tokens.refreshPublicTokens = async () => {};
  const calls = mockFetch((url) => (url.endsWith('/block_height') ? '971198' : { result: { units: 'decimal', overall_balance: '1500', decimals: 18 }, validation: { balanceStatus: 'matched' } }));
  const idx = await app.tokens.readIndexer();
  assert.ok(calls.some((p) => p.includes('get_current_balance_of_wallet')));
  assert.equal(idx.tokens.worldx, '1500000000000000000000');
  assert.equal(idx.validation.worldx, 'matched');
  assert.equal(TokenBook.verdict([{ status: 'conflict' }]), 'conflict');
});

test('token pages say how far a balance was checked', () => {
  const app = walletApp(keys());
  const view = new TokenView(app);
  app.tokens.idx = { height: 971198, tokens: { worldx: '1500' }, decimals: { worldx: 0 }, validation: { worldx: 'conflict' } };
  assert.match(view.indexerLine('worldx'), /Sources disagree/);
  app.tokens.idx.validation.worldx = 'not_checked';
  assert.match(view.indexerLine('worldx'), /Indexer-reported balance/);
  app.tokens.idx.validation.worldx = 'matched';
  assert.match(view.indexerLine('worldx'), /OPI \+ UniSat balance match/);
});
