// LEAF (CRC-20, crc20.org): payload bytes from crc20.org's own example, and transfers in the one layout the
// protocol accepts (vin[0] = sender, vout[0] = OP_RETURN, vout[1] = receiver, then change), from Public and
// from a Shielded one-time address (partial sends keep the rest spendable).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1';
import { hex } from '@scure/base';
import * as sp from '../src/crypto/sp-core.mjs';
import { walletApp, Keyring } from './helpers/wallet-app.mjs';
import { balanceFromReply, fmtLeaf, indexerSynced, leafPayload, leafScript, leafTransferOf, parseLeaf, receiverKind } from '../src/tokens/leaf.mjs';
import { LeafBook } from '../src/tokens/LeafBook.mjs';
import { p2trScript } from '../src/bitcoin/taproot.mjs';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const LEAF = 100_000_000n;
const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const OTHER_TR = 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh';
const BOB_SP = Keyring.fromMnemonic(WORDS, '', 'main', 5).silentAddress('main');

test('payload: crc20.org example for 1500 LEAF, byte for byte', () => {
  assert.equal(hex.encode(leafScript(1500n * LEAF)), '6a417b2270223a226372632d3230222c226f70223a227472616e73666572222c227469636b223a224c454146222c22616d74223a22313530303030303030303030227d');
  assert.equal(leafPayload(1n), '{"p":"crc-20","op":"transfer","tick":"LEAF","amt":"1"}');
  assert.ok(leafScript(2n ** 64n - 1n).length <= 77, 'the largest amount is still one direct push');
  assert.throws(() => leafScript(0n)); assert.throws(() => leafScript(2n ** 64n)); assert.throws(() => leafScript(5));
});

test('amounts are exact, 8 decimals, never floats', () => {
  assert.equal(parseLeaf('1500'), 150_000_000_000n);
  assert.equal(parseLeaf('0.29'), 29_000_000n, '0.29 * 1e8 is not 29000000 in floats');
  assert.equal(parseLeaf('1,234.5'), 123_450_000_000n);
  assert.throws(() => parseLeaf('0.000000001'), /8 decimals/);
  assert.throws(() => parseLeaf('0'), /above zero/);
  assert.throws(() => parseLeaf('-1'));
  assert.equal(fmtLeaf(123_450_000_000n), '1,234.5');
  assert.equal(fmtLeaf(1n), '0.00000001');
});

test('receivers: single-key only (bc1p, bc1q P2WPKH); P2WSH and others refused', () => {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', 'main'));
  const codec = app.account.codec;
  assert.deepEqual(receiverKind(codec.outputScript(OTHER_TR)), { kind: 'p2tr', sats: 330 });
  assert.deepEqual(receiverKind(codec.outputScript(P2WPKH)), { kind: 'p2wpkh', sats: 294 });
  assert.throws(() => receiverKind(codec.outputScript(P2WSH)), /single-key/);
});

test('reading balances: decimal strings in the reply', () => {
  // a real reply from crc20.org (28 Oct 2026)
  const real = { address: 'bc1pnjm803d0erzgvvmx6ue99gunsht8vpl3kxa3k8d00pke32argr6syrvu6u', leaf: { balance: '2238672061904761', decimals: 8 }, btc: { balance: '108569', unconfirmed: '0', tx_count: 18 }, height: 973532, axbt: { balance: '1220', decimals: 8 } };
  assert.equal(balanceFromReply(real), 2_238_672_061_904_761n);
  assert.equal(fmtLeaf(balanceFromReply(real)), '22,386,720.61904761');
  assert.equal(balanceFromReply({ leaf: { balance: '0', decimals: 8 } }), 0n);
  assert.throws(() => balanceFromReply({ leaf: { balance: 12 } }), /unexpected/, 'never a JSON number');
  assert.throws(() => balanceFromReply({ axbt: { balance: '5' } }), /unexpected/, 'AXBT is not LEAF');
  const status = { network: 'bitcoin', token: { tick: 'LEAF', decimals: 8, max_supply: '100000000000000000', supply: '100000000000000000' }, indexer: { height: 973532, hash: '00'.repeat(32), synced: true } };
  assert.ok(indexerSynced(status));
  assert.ok(!indexerSynced({ ...status, indexer: { ...status.indexer, synced: false } }));
});

/** A mainnet wallet with ord switched off (coins count as checked) and LEAF balances set by hand. */
function setup() {
  const keys = Keyring.fromMnemonic(WORDS, '', 'main');
  const app = walletApp(keys);
  app.ord.unverified = () => false;
  app.coins.ensureOrd = async () => {};
  const f = app.account.funding();
  app.coins.public = [
    { key: 'p1', kind: 'funding', txid: '11'.repeat(32), vout: 0, sats: 20_000, output: f.outputX, privKey: f.outputPriv, address: f.address },
    { key: 'p2', kind: 'funding', txid: '12'.repeat(32), vout: 1, sats: 3_000, output: f.outputX, privKey: f.outputPriv, address: f.address },
  ];
  // Shielded coins: a 330-sat one-time output holding LEAF, and a free coin for fees
  const coin = (key, txid, sats, tweak) => ({ key, txid, vout: 0, sats, tweak, output: hex.encode(schnorr.getPublicKey(hex.decode(keys.outputPriv(tweak)))) });
  app.coins.shielded = [coin('s1', '21'.repeat(32), 330, '01'.repeat(32)), coin('s2', '22'.repeat(32), 40_000, '02'.repeat(32))];
  const leaf = new LeafBook(app, { fetch: async () => { throw new Error('no network in tests'); } });
  leaf.pub = 2000n * LEAF;
  const aAddr = app.account.codec.trAddress(app.coins.shielded[0].output);
  leaf.sh = [{ address: aAddr, atoms: 100n * LEAF, coinKey: 's1' }];
  leaf.at = Date.now();
  return { app, keys, leaf, f, aAddr };
}

/** Every input's Schnorr signature checks out against the BIP 341 sighash. */
function signed(tx, prevouts) {
  const scripts = prevouts.map((p) => p.script), amounts = prevouts.map((p) => BigInt(p.value));
  for (let i = 0; i < tx.inputsLength; i++) {
    const sig = tx.getInput(i).finalScriptWitness[0];
    if (!schnorr.verify(sig, tx.preimageWitnessV1(i, scripts, 0, amounts), scripts[i].slice(2))) return false;
  }
  return true;
}
const decode = (h) => btc.Transaction.fromRaw(hex.decode(h), { allowUnknownOutputs: true });

test('send from Public: payload first, receiver right after, change last; fee covers the real size', async () => {
  const { leaf, f } = setup();
  const b = await leaf.build({ from: 'public', to: P2WPKH, amount: '1500.5', rate: 3 });
  const tx = decode(b.hex);
  assert.equal(hex.encode(tx.getInput(0).txid), '11'.repeat(32), 'vin[0] is a coin of the Public address');
  assert.equal(hex.encode(tx.getOutput(0).script), hex.encode(leafScript(150_050_000_000n)));
  assert.equal(tx.getOutput(0).amount, 0n);
  assert.equal(btc.Address().encode(btc.OutScript.decode(tx.getOutput(1).script)), P2WPKH);
  assert.equal(tx.getOutput(1).amount, 294n, 'P2WPKH receiver dust');
  assert.equal(hex.encode(tx.getOutput(2).script), hex.encode(p2trScript(f.outputX)), 'BTC change back to Public');
  assert.equal(tx.outputsLength, 3);
  assert.ok(b.fee >= Math.ceil(b.vsize * 3) && b.fee < Math.ceil(b.vsize * 3) + 20, `fee ${b.fee} for ${b.vsize} vB`);
  assert.ok(signed(tx, [{ script: p2trScript(f.outputX), value: 20_000 }]));
  assert.equal(b.senderAddress, f.address);
  await assert.rejects(leaf.build({ from: 'public', to: P2WSH, amount: '1', rate: 3 }), /single-key/);
  await assert.rejects(leaf.build({ from: 'public', to: P2WPKH, amount: '2000.00000001', rate: 3 }), /Public LEAF is 2,000/);
});

test('send to a Shielded address: the receiver output is the silent payment derived from the inputs', async () => {
  const { leaf, f } = setup();
  const b = await leaf.build({ from: 'public', to: BOB_SP, amount: '10', rate: 2 });
  const tx = decode(b.hex);
  const ins = [{ txid: '11'.repeat(32), vout: 0, privKey: f.outputPriv, taproot: true }];
  const [want] = sp.createOutputs(ins, ins.map(({ txid, vout }) => ({ txid, vout })), [BOB_SP]);
  assert.equal(hex.encode(tx.getOutput(1).script), hex.encode(p2trScript(want.output)));
  assert.equal(tx.getOutput(1).amount, 330n);
  assert.equal(b.kind, 'shielded');
});

test('send from Shielded: vin[0] is the LEAF address; a partial send keeps 330 sats there', async () => {
  const { app, leaf, aAddr } = setup();
  const part = await leaf.build({ from: 'shielded', to: OTHER_TR, amount: '40', rate: 2 });
  let tx = decode(part.hex);
  const a = app.coins.shielded[0], fee = app.coins.shielded[1];
  assert.equal(hex.encode(tx.getInput(0).txid), a.txid, 'vin[0] = the coin of the address holding the LEAF');
  assert.equal(hex.encode(tx.getInput(1).txid), fee.txid, 'fee from a Shielded coin, not from Public');
  assert.equal(hex.encode(tx.getOutput(0).script), hex.encode(leafScript(40n * LEAF)));
  assert.equal(tx.getOutput(1).amount, 330n);
  assert.equal(hex.encode(tx.getOutput(2).script), hex.encode(p2trScript(a.output)), 'the rest of the LEAF stays spendable');
  assert.equal(tx.getOutput(2).amount, 330n);
  assert.equal(tx.outputsLength, 4, 'and Shielded change');
  assert.notEqual(hex.encode(tx.getOutput(3).script), hex.encode(p2trScript(app.account.funding().outputX)), 'change never goes Public');
  assert.ok(signed(tx, [{ script: p2trScript(a.output), value: 330 }, { script: p2trScript(fee.output), value: 40_000 }]));
  assert.equal(part.senderAddress, aAddr);

  const all = await leaf.build({ from: 'shielded', to: OTHER_TR, amount: '100', rate: 2 });
  tx = decode(all.hex);
  assert.equal(tx.outputsLength, 3, 'sending all of it: no 330 back');
  assert.ok(!all.partial);
});

test('Shielded LEAF in several places: one send moves at most one address', async () => {
  const { leaf } = setup();
  leaf.sh.push({ address: 'bc1pxxxx', atoms: 30n * LEAF, coinKey: null });
  await assert.rejects(leaf.build({ from: 'shielded', to: OTHER_TR, amount: '120', rate: 2 }), /up to 100/);
});

test('in-flight sends are subtracted until crc20.org applies them', () => {
  const { leaf, f } = setup();
  leaf.addPending({ txid: 'ab'.repeat(32), from: f.address, atoms: 300n * LEAF });
  assert.equal(leaf.available('public'), 1700n * LEAF);
});

test('unconfirmed transfers: read from the mempool, shown as incoming or sending until a block', () => {
  const { leaf, f } = setup();
  leaf.store.setJson(leaf.pendingKey, []); // the wallet's storage is shared between tests
  const tx = (from, to, atoms, op = hex.encode(leafScript(atoms))) => ({ txid: 'cd'.repeat(32), vin: [{ prevout: { scriptpubkey_address: from } }], vout: [{ scriptpubkey: op, value: 0 }, { scriptpubkey_address: to, value: 330 }], status: { confirmed: false } });
  assert.deepEqual(leafTransferOf(tx(OTHER_TR, f.address, 5n * LEAF)), { txid: 'cd'.repeat(32), from: OTHER_TR, to: f.address, atoms: 5n * LEAF });
  assert.equal(leafTransferOf(tx(OTHER_TR, f.address, 5n, '6a' + '04' + 'deadbeef')), null, 'not a LEAF payload');
  assert.equal(leafTransferOf({ vout: [{ scriptpubkey: '0014' + '00'.repeat(20) }] }), null);
  leaf.unconfirmed = [leafTransferOf(tx(OTHER_TR, f.address, 5n * LEAF))];
  assert.equal(leaf.incoming('public'), 5n * LEAF);
  assert.equal(leaf.available('public'), 2000n * LEAF, 'incoming LEAF is not spendable before it confirms');
  leaf.unconfirmed = [{ ...leafTransferOf(tx(f.address, OTHER_TR, 7n * LEAF)), txid: 'ef'.repeat(32) }];
  assert.equal(leaf.outgoing('public'), 7n * LEAF, 'a send made elsewhere (another wallet) is still subtracted');
  assert.equal(leaf.available('public'), 1993n * LEAF);
  leaf.addPending({ txid: 'ef'.repeat(32), from: f.address, atoms: 7n * LEAF });
  assert.equal(leaf.available('public'), 1993n * LEAF, 'the same send is never subtracted twice');
});
