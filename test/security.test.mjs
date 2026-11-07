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

// A dApp PSBT: 500,000 sats of ours in, 2,000 to the site's address at output 0, 498,000 "change" to us at output 1.
function partialFixture(sighashType) {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', 'main'));
  const ours = hex.decode(app.account.pubSpk());
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid: hex.decode('22'.repeat(32)), index: 0, witnessUtxo: { script: ours, amount: 500000n }, ...(sighashType != null ? { sighashType } : {}) });
  tx.addOutputAddress(REAL, 2000n, btc.NETWORK);
  tx.addOutput({ script: ours, amount: 498000n });
  return { app, psbt: hex.encode(tx.toPSBT()) };
}

test('SINGLE|ANYONECANPAY: change the signature doesn\'t cover is not counted, is marked, and must be confirmed', () => {
  const { app, psbt } = partialFixture(0x83);
  const a = app.psbt.analyse(psbt, { toSignInputs: [{ index: 0, sighashTypes: [0x83] }] });
  assert.equal(a.partial, true);
  assert.deepEqual(a.outputs.map((o) => o.locked), [true, false], 'SINGLE covers only output 0');
  assert.equal(a.net, -500000, 'the 498,000 the site could redirect is not shown as coming back');
  assert.equal(a.changeableOurs, 498000);
  assert.ok(a.protectedCount > 0, 'the approval needs the confirm box');
  const card = app.ui.views.approve.psbtCard(a, 0, 1);
  assert.match(card, /not covered: can be changed/);
  assert.match(card, /left out of the balance change/);
  assert.match(card, /-0\.005/);
  // the same transaction signed normally (DEFAULT): every output is covered, the change counts
  const ok = partialFixture(null);
  const b = ok.app.psbt.analyse(ok.psbt);
  assert.equal(b.partial, false);
  assert.equal(b.net, -2000);
  assert.equal(b.changeableOurs, 0);
});

test('signature types from a site must be standard integers: markup or odd values are refused, not rendered', () => {
  const { app, psbt } = partialFixture(null);
  for (const bad of [['<img src=x onerror=alert(1)>'], [1.5], ['1'], [0x84], [0x01, 0x81, 0x83, 0x03, 0x01], 'x']) {
    assert.throws(() => app.psbt.analyse(psbt, { toSignInputs: [{ index: 0, sighashTypes: bad }] }), /unsupported signature type/, JSON.stringify(bad));
  }
  const a = app.psbt.analyse(psbt, { toSignInputs: [{ index: 0, sighashTypes: [0x01] }] });
  assert.match(app.ui.views.approve.psbtCard(a, 0, 1), /sighash 0x01/);
});

test('an ALL signature cannot hide exposure on a separate SINGLE|ANYONECANPAY input', async () => {
  const { app, psbt } = partialFixture(0x83);
  const tx = btc.Transaction.fromPSBT(hex.decode(psbt));
  tx.addInput({ txid: '33'.repeat(32), index: 0, witnessUtxo: { script: hex.decode(app.account.pubSpk()), amount: 10000n } });
  tx.updateOutput(1, { amount: 508000n });
  const psbtHex = hex.encode(tx.toPSBT());
  const review = app.psbt.analyse(psbtHex);
  assert.deepEqual(review.outputs.map((o) => o.locked), [true, false]);
  assert.equal(review.net, -510000);
  await assert.rejects(app.approvals.run({ method: 'signPsbt', prep: [review], params: { psbtHex } }), /Tick the box/);
});

test('RGB permission window: placed inside the browser window, fitted to it, Chrome places it when bounds are unusable', async () => {
  const { rgbWindowBounds } = await import('../src/app/Platform.mjs');
  assert.deepEqual(rgbWindowBounds({ left: 0, top: 25, width: 1440, height: 875, state: 'normal' }), { width: 380, height: 660, left: 1048, top: 97 });
  // a second display to the left (negative coordinates)
  assert.deepEqual(rgbWindowBounds({ left: -1920, top: 0, width: 1920, height: 1080, state: 'maximized' }), { width: 380, height: 660, left: -392, top: 72 });
  // a short window: the popup fits inside it instead of hanging off the bottom
  const short = rgbWindowBounds({ left: 100, top: 100, width: 900, height: 560, state: 'normal' });
  assert.equal(short.height, 480); assert.ok(short.top + short.height <= 100 + 560);
  // a narrow window: never wider than it, never left of it
  const narrow = rgbWindowBounds({ left: 50, top: 0, width: 300, height: 800, state: 'normal' });
  assert.equal(narrow.width, 300); assert.equal(narrow.left, 50);
  for (const b of [null, { state: 'minimized', left: -32000, top: -32000, width: 160, height: 28 }, { left: 0, top: 0 }]) assert.deepEqual(rgbWindowBounds(b), { width: 380, height: 660 });
});

test('RGB permission window: a tab in full screen, and no position when Chrome refuses it', async () => {
  const { Platform } = await import('../src/app/Platform.mjs');
  const prev = { chrome: globalThis.chrome, window: globalThis.window };
  const made = [];
  globalThis.window = { close: () => made.push('closed') };
  const chromeWith = (win, refuse) => ({
    runtime: { getURL: (p) => `chrome-extension://masked/${p}` },
    storage: { session: { set: async () => {}, remove: async () => {} } },
    windows: { getCurrent: async () => win, create: async (o) => { if (refuse && 'left' in o) throw new Error('Bounds must be at least 50% within visible screen space.'); made.push(['window', o]); } },
    tabs: { create: async (o) => made.push(['tab', o]) },
  });
  try {
    const p = Object.create(Platform.prototype);
    globalThis.chrome = chromeWith({ id: 7, state: 'fullscreen', left: 0, top: 0, width: 1512, height: 982 });
    await p.openRgbPermissionWindow({});
    assert.equal(made[0][0], 'tab'); assert.equal(made[0][1].windowId, 7, 'stays in the full-screen window');
    made.length = 0;
    globalThis.chrome = chromeWith({ id: 8, state: 'normal', left: 3000, top: 0, width: 1500, height: 900 }, true);
    await p.openRgbPermissionWindow({});
    assert.equal(made[0][0], 'window'); assert.equal('left' in made[0][1], false, 'Chrome places it');
    assert.equal(made.at(-1), 'closed');
  } finally { globalThis.chrome = prev.chrome; globalThis.window = prev.window; }
});
