// Look-alike addresses (address poisoning) and signature types that hand over control of coins.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { walletApp, Keyring } from './helpers/wallet-app.mjs';
import { lookAlike, sighashRisk } from '../src/security/guard.mjs';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const REAL = 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh';
// same first 4 and last 4 after the prefix, different middle: what a poisoning dust payment looks like
const FAKE = 'bc1p4qhjxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9fqzwh';

test('look-alike: same start and end as a known address, but different', () => {
  assert.equal(lookAlike(FAKE, [REAL]), REAL);
  assert.equal(lookAlike(REAL, [REAL]), null, 'the same address is fine');
  assert.equal(lookAlike('bc1p0d0rhyynq0awa9m8cqrcr8f5nxqx3aw29w4ru5u9my3h0sfygnzs9khxz8', [REAL]), null, 'an unrelated address is fine');
  assert.equal(lookAlike(FAKE.toUpperCase(), [REAL]), REAL, 'case does not hide it');
});

test('the wallet remembers who it paid and flags look-alikes of them and of its own addresses', () => {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', 'main'));
  assert.equal(app.lookAlike(FAKE), null);
  app.rememberRecipient(REAL);
  assert.equal(app.lookAlike(FAKE), REAL);
  const own = app.account.pubAddr();
  const ownFake = own.slice(0, 8) + 'q'.repeat(own.length - 14) + own.slice(-6);
  assert.equal(app.lookAlike(ownFake), own, 'a fake of your own Public address');
});

test('signature types: NONE refused, SINGLE flagged, listings and ALL fine', () => {
  assert.equal(sighashRisk([0x02]), 'blank-cheque');
  assert.equal(sighashRisk([0x82]), 'blank-cheque');
  assert.equal(sighashRisk([0x03]), 'unusual');
  assert.equal(sighashRisk([0x83]), 'ok', 'SINGLE|ANYONECANPAY: marketplace listings');
  assert.equal(sighashRisk([0x01]), 'ok');
  assert.equal(sighashRisk(null), 'ok');
});

test('a dApp PSBT asking for SIGHASH_NONE on your coin is refused before you see a Sign button', () => {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', 'main'));
  const f = app.account.funding();
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: hex.decode('11'.repeat(32)), index: 0, witnessUtxo: { script: app.account.pubSpk ? hex.decode(app.account.pubSpk()) : btc.p2tr(hex.decode(f.outputX)).script, amount: 50000n }, sighashType: 0x82 });
  tx.addOutputAddress(REAL, 40000n, btc.NETWORK);
  const psbt = hex.encode(tx.toPSBT());
  assert.throws(() => app.psbt.analyse(psbt, { toSignInputs: [{ index: 0, address: f.address, sighashTypes: [0x82] }] }), /SIGHASH_NONE/);
});
