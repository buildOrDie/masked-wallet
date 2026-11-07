/* global localStorage */
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

// RGB lives on the wallet's own screens (Signet only) and never changes BTC balances or addresses.
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
function rgbApp(net = 'signet') {
  const app = walletApp(keys(), net);
  app.state.lockState = 'open'; app.render = () => {}; app.toast = () => {};
  app.lock.secret = { words: WORDS, passphrase: '' };
  return app;
}
const TUSD = { assetId: 'rgb:tusd', ticker: 'TUSD', name: 'Test USD', precision: 2, issuedSupply: 100000, balance: { settled: 123450, future: 123450, spendable: 123450 } };
function rgbReady(app, extra = {}) {
  Object.assign(app.rgb, { ready: true, service: { backupRequired: false, profile: app.rgb.profile, decode: async () => ({ network: 'signet' }), checkProxy: async () => {} } });
  app.rgb.data = { address: 'tb1qrgbfunding', btc: { vanilla: { settled: 0, future: 0 }, colored: { settled: 0, future: 0 } }, groups: { nia: [TUSD] }, transfers: {}, ...extra };
}

test('Home on Signet: a "Try RGB tokens" card, then RGB tokens in the same rows as BRC-20', () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  const address = app.account.pubAddr();
  assert.match(app.ui.views.home.render(), /data-rgb="on"[^>]*>.*Try RGB tokens/s);
  Object.assign(app.rgb, { ready: true, busy: true, data: null });
  assert.match(app.ui.views.home.render(), /Checking RGB balances/);
  assert.doesNotMatch(app.ui.views.home.render(), /data-rgb="fund"/, 'no button that would do nothing yet');
  app.rgb.busy = false;
  rgbReady(app);
  const html = app.ui.views.home.render();
  assert.match(html, /RGB tokens/);
  assert.match(html, /class="tok-line" data-rgb="token" data-rgb-arg="rgb:tusd"/);
  assert.match(html, /1,234\.5/, 'amount in token units, not base units');
  assert.match(html, /Add test BTC for RGB/, 'low test BTC: one tap to fund from Public');
  assert.match(html, /Test BTC for fees/, 'RGB\'s own BTC and address are on Home');
  assert.match(html, /data-copy="tb1qrgbfunding"/);
  assert.doesNotMatch(html, /Prepare RGB outputs|password/i, 'no manual setup steps');
  assert.equal(app.account.pubAddr(), address);
  app.state.net = 'main';
  // mainnet: only an opt-in beta card, nothing opens until it is switched on
  const main = app.ui.views.home.render();
  assert.match(main, /data-rgb="beta"[^>]*>.*RGB tokens \(beta\)/s);
  assert.doesNotMatch(main, /Test BTC for fees|data-rgb="fund"/);
  assert.equal(app.rgb.available, false);
  assert.equal(app.rgb.profile.id, 'mainnet');
});

test('RGB mainnet beta: opt-in, keys of its own, backup before every receive and send', async () => {
  const { mnemonicFrom } = await import('../src/rgb/runtime.mjs');
  const { validateMnemonic } = await import('@scure/bip39');
  const { wordlist } = await import('@scure/bip39/wordlists/english');
  const app = rgbApp('main');
  localStorage.removeItem('masked.rgb.mainnet-beta');
  localStorage.setItem('masked.rgb.cloud', '0'); // this test is the backup-file path (cloud backup switched off)
  assert.equal(app.rgb.offerable, true);
  assert.equal(app.rgb.available, false);
  localStorage.setItem('masked.rgb.mainnet-beta', '1');
  assert.equal(app.rgb.available, true);
  assert.equal(app.rgb.isMain, true);
  assert.equal(app.rgb.profile.sdk.network, 'mainnet');
  const f = Number(app.rgb.fee());
  assert.ok(f >= 1 && f <= 100, 'mainnet fee comes from the wallet fee choice');
  // RGB keys: a phrase of their own, the same every time, never MASKED's phrase
  const seed = await app.rgb.mainSeed(), words = mnemonicFrom(seed);
  assert.equal(words, mnemonicFrom(await app.rgb.mainSeed()));
  assert.ok(validateMnemonic(words, wordlist));
  assert.notEqual(words, WORDS);
  // no backup saved yet: receive and create wait for the first one, with the button right there
  rgbReady(app);
  Object.assign(app.rgb.service, { backupRequired: true, everBackedUp: false });
  let called = false;
  app.rgb.service.receive = async () => { called = true; return { invoice: 'rgb:x' }; };
  await app.rgb.action('invoice');
  assert.equal(called, false);
  assert.match(app.rgb.message, /Save your RGB backup once/);
  assert.match(app.ui.views.receive.render?.() || '', /data-rgb="backup"|/);
  assert.match(app.ui.views.home.render(), /Save your RGB backup/);
  let issued = false;
  app.rgb.service.issue = async () => { issued = true; return {}; };
  await app.rgb.action('issue', 'go');
  assert.equal(issued, false);
  // after one backup: a later change only reminds on Home, it never blocks a receive
  app.rgb.service.everBackedUp = true;
  app.rgb.fields.recvType = 'witness';
  await app.rgb.action('invoice');
  assert.equal(called, true);
  assert.match(app.ui.views.home.render(), /Something changed since your last backup/);
  localStorage.removeItem('masked.rgb.mainnet-beta');
  localStorage.removeItem('masked.rgb.cloud');
});

test('RGB mainnet cloud backup: on by default, saved after changes, restored in a new browser, can be switched off', async () => {
  const cloud = await import('../src/rgb/cloud.mjs');
  const app = rgbApp('main');
  const r = app.rgb;
  localStorage.setItem('masked.rgb.mainnet-beta', '1');
  localStorage.removeItem('masked.rgb.cloud');
  for (const k of ['', '.cloud-version', '.cloud-at', '.backed-up']) localStorage.removeItem('masked.rgb.mainnet.v1' + k);
  assert.equal(r.cloudOn, true, 'on by default');
  // an in-memory server with the real version rule
  const store = new Map(); let reachable = true;
  r.cloudApi = {
    latest: async (id) => { if (!reachable) throw new Error('offline'); return store.get(id) || null; },
    put: async (id, body) => { const cur = store.get(id); if (cur && body.version <= cur.version) throw Object.assign(new Error('newer'), { status: 409, latest: cur.version }); store.set(id, body); },
    remove: async (k) => { store.delete(k.id); },
  };
  let dirty = true, opened = [];
  const ENV = { format: 'masked-rgb-signet', version: 1, ciphertext: 'state-1' };
  const service = {
    profile: r.profile, get backupRequired() { return dirty; }, get everBackedUp() { return localStorage.getItem('masked.rgb.mainnet.v1.backed-up') === '1'; },
    dirtyKey: 'masked.rgb.mainnet.v1.backup-required',
    open: async (_pw, _gen, backup) => { opened.push(backup); localStorage.setItem('masked.rgb.mainnet.v1', '{"format":"x"}'); },
    backup: async () => ENV,
    backupSaved: () => { dirty = false; localStorage.setItem('masked.rgb.mainnet.v1.backed-up', '1'); },
    close: async () => {},
  };
  Object.assign(r, { acquire: async () => {}, runtime: async () => ({ mnemonicFrom: () => 'w', newTestMnemonic: () => 'w' }), serviceFor: async () => (r.service = service), refresh: async () => { r.data = { address: 'bc1qrgbfees', btc: { vanilla: { settled: 9000, future: 9000 }, colored: { settled: 0, future: 0 } }, groups: {}, transfers: {} }; }, startTimer: () => {}, markKeyed: () => {} });
  // 1. first browser: nothing in the cloud, a new RGB wallet, backed up straight away
  await r.action('on');
  assert.deepEqual(opened, [null]);
  const { id } = await cloud.cloudKeys(app.lock.secret);
  assert.equal(store.get(id).version, 1);
  assert.equal(r.cloudVersion, 1);
  assert.equal(dirty, false, 'a cloud save counts as a backup');
  assert.equal(service.everBackedUp, true, 'no file needed before the first receive');
  assert.deepEqual(await cloud.open(await cloud.cloudKeys(app.lock.secret), store.get(id)), ENV, 'what is stored opens with this phrase');
  assert.doesNotMatch(app.ui.views.home.render(), /Save your RGB backup|didn't save/, 'Home stays quiet');
  assert.match(app.ui.views.settings.render(), /Cloud backup \(encrypted\)[\s\S]*saved just now/);
  // a change: saved again, version 2
  dirty = true;
  assert.equal(await r.cloudSave(), true);
  assert.equal(store.get(id).version, 2);
  // 2. a new browser with the same phrase: restores the cloud backup instead of starting empty
  await r.close();
  for (const k of ['', '.cloud-version', '.cloud-at', '.backed-up']) localStorage.removeItem('masked.rgb.mainnet.v1' + k);
  r.tried = ''; opened = [];
  await r.action('on');
  assert.deepEqual(opened, [ENV]);
  assert.equal(r.cloudVersion, 2);
  // the server can't be asked: never start a wallet over a backup that may exist
  await r.close();
  localStorage.removeItem('masked.rgb.mainnet.v1'); r.tried = ''; opened = []; reachable = false;
  await r.action('on');
  assert.deepEqual(opened, []);
  assert.match(r.message, /Could not check for your RGB cloud backup/);
  reachable = true;
  localStorage.setItem('masked.rgb.mainnet.v1', '{"format":"x"}');
  await r.open('k');
  // 3. another browser saved newer: say so, offer to replace, never overwrite silently
  localStorage.setItem('masked.rgb.mainnet.v1.cloud-version', '0'); dirty = true;
  assert.equal(await r.cloudSave(), false);
  assert.equal(r.cloud.conflict, 2);
  assert.match(app.ui.views.home.render(), /RGB cloud backup didn't save/);
  assert.match(app.ui.views.settings.render(), /data-rgb="cloudReplace"/);
  await r.action('cloudReplace');
  assert.equal(store.get(id).version, 3);
  assert.equal(r.cloud.error, '');
  // 4. switch off: asked inside MASKED, then every copy is deleted and the file reminder comes back
  await r.action('cloudOff');
  assert.match(app.ui.views.settings.render(), /Switch off cloud backup\?[\s\S]*data-rgb="cloudOffYes"/);
  await r.action('cloudOffYes');
  assert.equal(store.has(id), false);
  assert.equal(r.cloudOn, false);
  assert.match(app.ui.views.settings.render(), /data-rgb="cloudOn"/);
  dirty = true;
  assert.equal(await r.cloudSave(), false, 'off means no uploads');
  assert.equal(store.has(id), false);
  await r.close();
  for (const k of ['', '.cloud-version', '.cloud-at', '.backed-up']) localStorage.removeItem('masked.rgb.mainnet.v1' + k);
  localStorage.removeItem('masked.rgb.mainnet-beta'); localStorage.removeItem('masked.rgb.cloud');
});

test('RGB invoices made here are listed with where each one stands', async () => {
  const app = rgbApp();
  rgbReady(app);
  localStorage.removeItem(app.rgb.invoicesKey);
  const future = Math.floor(Date.now() / 1000) + 3600;
  app.rgb.service.receive = async () => ({ invoice: 'rgb:~/~/~/tb:wvout:AAA', recipientId: 'wvout:AAA', expirationTimestamp: future });
  app.rgb.fields.recvType = 'witness';
  await app.rgb.action('invoice');
  assert.equal(app.rgb.invoices().length, 1);
  assert.deepEqual(app.rgb.invoiceStatus(app.rgb.invoices()[0]), { key: 'waiting', text: 'Waiting for payment' });
  app.rgb.invoice = '';
  let html = app.ui.views.receive.render();
  if (!/Your invoices/.test(html)) { app.state.f.recvKind = 'rgb'; html = app.ui.views.receive.render(); }
  assert.match(html, /Your invoices[\s\S]*Any RGB token[\s\S]*Waiting for payment/);
  // the payment shows up in the token's transfers
  app.rgb.data.transfers = { 'rgb:tusd': [{ recipientId: 'wvout:AAA', status: 'WaitingConfirmations', assignments: [{ Fungible: 500 }] }] };
  assert.match(app.rgb.invoiceStatus(app.rgb.invoices()[0]).text, /Paid: 5(\.00)? TUSD, waiting for a block/);
  app.rgb.data.transfers['rgb:tusd'][0].status = 'Settled';
  assert.match(app.rgb.invoiceStatus(app.rgb.invoices()[0]).text, /Received 5(\.00)? TUSD/);
  // an old one nobody paid
  app.rgb.logInvoice({ invoice: 'rgb:old', recipientId: 'utxob:OLD', at: Date.now() - 9e6, expiresAt: 1, witness: false, amount: '', ticker: '' });
  assert.equal(app.rgb.invoiceStatus(app.rgb.invoices()[0]).key, 'expired');
  localStorage.removeItem(app.rgb.invoicesKey);
});

test('RGB tokens locked by an open Private invoice: explained, and the invoice can be cancelled', async () => {
  const app = rgbApp('main');
  localStorage.setItem('masked.rgb.mainnet-beta', '1');
  rgbReady(app);
  localStorage.removeItem(app.rgb.invoicesKey);
  assert.equal(app.rgb.recvType(), 'witness', 'mainnet starts on No BTC needed');
  app.rgb.data.groups.nia = [{ ...TUSD, balance: { settled: 123450, future: 123450, spendable: 0 } }];
  app.rgb.logInvoice({ invoice: 'rgb:blind', recipientId: 'utxob:LOCK', at: Date.now(), expiresAt: Math.floor(Date.now() / 1000) + 3600, witness: false, amount: '', ticker: '' });
  app.rgb.asset = 'rgb:tusd';
  const html = app.ui.views.rgbtok.render();
  assert.match(html, /locked by an open Private invoice/);
  assert.match(html, /data-rgb="cancelInv"/);
  let asked = null;
  app.rgb.service.cancelInvoices = async (ids) => { asked = ids; return 1; };
  app.rgb.refresh = async () => {};
  await app.rgb.action('cancelInv');
  assert.equal(asked, null, 'the token page cancels every open invoice, also ones not in the list');
  assert.equal(app.rgb.invoiceStatus(app.rgb.invoices()[0]).text, 'Cancelled');
  localStorage.removeItem(app.rgb.invoicesKey);
  localStorage.removeItem('masked.rgb.mainnet-beta');
});

test('Receive has an RGB tab on Signet only; Mint has "RGB token"', () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  rgbReady(app);
  app.state.f.recvKind = 'rgb';
  let html = app.ui.views.receive.render();
  assert.match(html, /data-set="recvKind" data-val="rgb"/);
  assert.match(html, /Make invoice/);
  assert.match(html, /No BTC needed/);
  app.rgb.invoice = 'rgb:~/~/utxob:abc';
  assert.match(app.ui.views.receive.render(), /class="qr"/);
  app.state.f.mintMode = 'rgb';
  html = app.ui.views.mint.render();
  assert.match(html, /data-val="rgb"[^>]*>RGB token/);
  assert.match(html, /Create token/);
  app.rgb.issued = { ticker: 'TUSD', assetId: 'rgb:tusd', supply: '1000' };
  assert.match(app.ui.views.mint.render(), /TUSD created/);
  app.state.net = 'main';
  assert.doesNotMatch(app.ui.views.receive.render(), /data-val="rgb"/);
  assert.match(app.ui.views.receive.render(), /Public address/, 'falls back to Public');
  assert.doesNotMatch(app.ui.views.mint.render(), /RGB token/);
});

test('token page and Send: token units, balance check, review', async () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  rgbReady(app);
  await app.rgb.action('token', 'rgb:tusd');
  assert.equal(app.state.view, 'rgbtok');
  assert.match(app.ui.views.rgbtok.render(), /TUSD.*badge rgb/s);
  await app.rgb.action('send', 'rgb:tusd');
  assert.equal(app.state.view, 'rgbsend');
  app.rgb.fields.sendTo = 'rgb:~/~/utxob:abc';
  app.rgb.fields.sendAmt = '2000';
  await app.rgb.action('review');
  assert.equal(app.rgb.pending, null);
  assert.match(app.rgb.message, /up to 1,234\.5 TUSD/);
  app.rgb.fields.sendAmt = '12.5';
  await app.rgb.action('review');
  assert.equal(app.rgb.pending.amount, 1250);
  assert.match(app.ui.views.rgbsend.render(), /You are sending.*12\.5/s);
  app.rgb.fields.sendTo = 'bc1qnotaninvoice';
  await app.rgb.action('review');
  assert.match(app.rgb.message, /starts with rgb:/);
});

test('"Add test BTC" opens Send from Public, filled in to the RGB address', async () => {
  const app = rgbApp();
  rgbReady(app);
  await app.rgb.action('fund');
  assert.equal(app.state.view, 'send');
  assert.equal(app.state.f.sendTo, 'tb1qrgbfunding');
  assert.equal(app.state.f.sendFrom, 'public');
  assert.equal(app.state.f.sendAmount, '0.0003');
});

test('no second password: the vault key comes from the wallet words, and older test wallets ask once', async () => {
  const app = rgbApp();
  const k1 = await app.rgb.walletKey();
  assert.match(k1, /^[0-9a-f]{64}$/);
  app.lock.secret = { words: WORDS, passphrase: 'x' };
  assert.notEqual(await app.rgb.walletKey(), k1, 'the BIP39 passphrase changes it');
  app.lock.secret = { words: WORDS, passphrase: '' };
  assert.equal(await app.rgb.walletKey(), k1);
  // an old vault (no keyed marker) that the wallet key can't open
  globalThis.localStorage.setItem(app.rgb.profile.vaultKey, JSON.stringify({ format: 'masked-rgb-signet' }));
  app.rgb.open = async () => { throw new Error('Incorrect password, wrong RGB network, or damaged RGB backup.'); };
  app.rgb.ensure();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.rgb.phase, 'legacy');
  assert.match(app.ui.views.home.render(), /Earlier RGB password/);
  globalThis.localStorage.removeItem(app.rgb.profile.vaultKey);
});

test('RGB outputs are made by themselves when a step needs them', async () => {
  const app = rgbApp();
  rgbReady(app, { btc: { vanilla: { settled: 20000, future: 20000 }, colored: { settled: 0, future: 0 } } });
  const calls = [];
  app.rgb.service = { createUtxos: async (fee) => { calls.push(['utxos', fee]); }, snapshot: async () => app.rgb.data, profile: app.rgb.profile };
  let n = 0;
  const out = await app.rgb.withOutputs(async () => { if (n++ === 0) throw 'Insufficient allocations'; return 'ok'; });
  assert.equal(out, 'ok');
  assert.deepEqual(calls, [['utxos', '2']]);
  await assert.rejects(app.rgb.withOutputs(async () => { throw 'InsufficientAllocationSlots'; }), /Wait for one block/);
  app.rgb.data.btc.vanilla.settled = 0;
  await assert.rejects(app.rgb.withOutputs(async () => { throw 'InsufficientAllocationSlots'; }), /Add test BTC first/);
});

test('RGB actions refuse Mainnet and a locked wallet', async () => {
  const app = rgbApp('main');
  await assert.rejects(app.rgb.action('confirm'), /Signet first/);
  app.state.net = 'signet'; app.state.lockState = 'locked';
  await assert.rejects(app.rgb.action('confirm'), /Signet first/);
  assert.equal(app.rgb.service, null);
});

test('token units: exact conversion both ways', async () => {
  const { toBase, fromBase } = await import('../src/rgb/config.mjs');
  assert.equal(toBase('12.5', 2), 1250);
  assert.equal(toBase('1,000', 0), 1000);
  assert.equal(toBase('0.00000001', 8), 1);
  for (const bad of ['', 'abc', '1.234', '0', '-1', '1e3']) assert.throws(() => toBase(bad, 2), bad);
  assert.equal(fromBase(123450, 2), '1,234.5');
  assert.equal(fromBase(5, 0), '5');
  assert.equal(fromBase(1, 8), '0.00000001');
});

test('history rows read like the BRC-20 ones; unpaid invoices are hidden', async () => {
  const { historyRow } = await import('../src/ui/views/RgbViews.mjs');
  const app = rgbApp(); const r = app.rgb;
  assert.deepEqual(historyRow({ kind: 'Issuance', status: 'Settled', assignments: [{ Fungible: 100000 }] }, TUSD, r), { label: 'Created', sign: '+', amount: '1,000', note: '', txid: undefined });
  assert.equal(historyRow({ kind: 'ReceiveBlind', status: 'WaitingCounterparty', assignments: [] }, TUSD, r), null);
  assert.equal(historyRow({ kind: 'ReceiveBlind', status: 'WaitingConfirmations', assignments: [{ Fungible: 250 }] }, TUSD, r).note, 'Waiting for a block');
  assert.equal(historyRow({ kind: 'Send', status: 'Settled', requestedAssignment: { Fungible: 1250 } }, TUSD, r).amount, '12.5');
});

test('a slow block server keeps RGB open with a retry note; RGB waits for the wallet sync first', async () => {
  const app = rgbApp();
  const calls = [];
  app.rgb.acquire = async () => {}; app.rgb.startTimer = () => calls.push('timer');
  app.rgb.runtime = async () => ({ newTestMnemonic: () => WORDS });
  app.rgb.serviceFor = async () => (app.rgb.service = { profile: app.rgb.profile, open: async () => calls.push('open'), snapshot: async ({ full }) => { calls.push(full ? 'full' : 'quick'); throw new Error('Network timeout: the server did not answer in time'); }, close: async () => {} });
  globalThis.localStorage.removeItem(`${app.rgb.profile.vaultKey}.scanned-v2`);
  await app.rgb.open(await app.rgb.walletKey());
  assert.equal(app.rgb.ready, true, 'still open');
  assert.deepEqual(calls, ['open', 'timer', 'full'], 'first open on this engine: full scan');
  assert.match(app.rgb.message, /busy or down.*try again in a minute/);
  // waits while the wallet syncs
  globalThis.localStorage.setItem(app.rgb.profile.vaultKey, '{"keyed":"wallet"}');
  const app2 = rgbApp(); let opened = 0;
  app2.rgb.open = async () => { opened++; };
  app2.sync.syncing = true;
  app2.rgb.ensure();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(opened, 0);
  clearTimeout(app2.rgb.waiting);
  globalThis.localStorage.removeItem(app.rgb.profile.vaultKey);
});

test('the token page renders history from the engine (timestamps and amounts)', async () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  rgbReady(app, { transfers: { 'rgb:tusd': [{ idx: 1, createdAt: 1761400000, updatedAt: 1761400100, status: 'Settled', kind: 'Issuance', assignments: [{ Fungible: 100000 }] }, { idx: 2, createdAt: 1761400200, status: 'WaitingConfirmations', kind: 'Send', requestedAssignment: { Fungible: 1250 }, assignments: [] }] } });
  await app.rgb.action('token', 'rgb:tusd');
  const html = app.ui.views.rgbtok.render();
  assert.match(html, /Created/);
  assert.match(html, /\+1,000/);
  assert.match(html, /Sent/);
  assert.match(html, /−12\.5/);
});

test('Receive options: token, fixed amount, expiry, and "No BTC needed" by default when test BTC is low', async () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  rgbReady(app);
  const got = [];
  app.rgb.service.receive = async (o) => { got.push(o); return { invoice: 'rgb:~/~/~/sb:wvout:abc' }; };
  app.rgb.service.decode = async () => ({});
  assert.equal(app.rgb.recvType(), 'witness', 'no test BTC: witness');
  app.rgb.fields.recvAsset = 'rgb:tusd'; app.rgb.fields.recvAmt = '12.5';
  await app.rgb.action('opt', 'recvExpiry:3600');
  await app.rgb.action('invoice');
  assert.deepEqual(got[0], { assetId: 'rgb:tusd', amount: 1250, durationSeconds: 3600, witness: true });
  app.state.f.recvKind = 'rgb';
  const html = app.ui.views.receive.render();
  assert.match(html, /12\.5 TUSD/);
  assert.match(html, /No BTC needed \(witness\)/);
  assert.match(html, /1 hour/);
  // with enough test BTC the default is Private (blind)
  app.rgb.data.btc.vanilla.settled = 50000;
  app.rgb.fields.recvType = '';
  assert.equal(app.rgb.recvType(), 'blind');
  // a fixed amount needs a token
  app.rgb.fields.recvAsset = ''; app.rgb.fields.recvAmt = '5';
  await app.rgb.action('invoice');
  assert.match(app.rgb.message, /Pick the token first/);
});

test('Send: an invoice with a fixed amount fills it in; a different token or an expired invoice is refused', async () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  rgbReady(app);
  let d = { assetId: 'rgb:tusd', amount: 2500, network: 'signet', witness: true };
  app.rgb.service.decode = async () => d;
  app.rgb.asset = 'rgb:tusd';
  app.rgb.fields.sendTo = 'rgb:fixed';
  await app.rgb.action('review');
  assert.equal(app.rgb.pending.amount, 2500);
  assert.equal(app.rgb.pending.witness, true);
  assert.equal(app.rgb.fields.sendAmt, '25');
  assert.match(app.ui.views.rgbsend.render(), /330 sats for their new output/);
  app.rgb.pending = null;
  d = { assetId: 'rgb:other', network: 'signet' };
  await app.rgb.action('review');
  assert.match(app.rgb.message, /different token/);
  d = { network: 'signet', expirationTimestamp: 1 };
  await app.rgb.action('review');
  assert.match(app.rgb.message, /expired/);
});

test('an invoice with its own transfer server: Allow asks Chrome once, then the server is checked before Confirm', async () => {
  const app = rgbApp();
  app.rgb.ensure = () => {};
  rgbReady(app);
  const { proxyUrl, rgbError } = await import('../src/rgb/WalletRgb.mjs');
  assert.equal(proxyUrl('rpcs://rgb.example.com/json-rpc'), 'https://rgb.example.com/json-rpc');
  const asked = [];
  let granted = false;
  app.platform.hasOrigins = async ([url]) => granted || new URL(url).host === 'proxy.iriswallet.com';
  app.platform.requestOrigins = async (urls) => { asked.push(urls); granted = true; };
  const checked = [];
  let fail = 'Invalid proxy protocol version: 0.1';
  app.rgb.service.checkProxy = async (u) => { checked.push(u); if (fail) throw fail; };
  app.rgb.service.decode = async () => ({ network: 'signet', transportEndpoints: ['rpcs://rgb.example.com/json-rpc'] });
  app.rgb.asset = 'rgb:tusd'; app.rgb.fields.sendTo = 'rgb:x'; app.rgb.fields.sendAmt = '1';
  await app.rgb.action('review');
  let html = app.ui.views.rgbsend.render();
  assert.match(html, /data-rgb="allowProxy"[^>]*>Allow rgb\.example\.com/);
  assert.match(html, /data-rgb="confirm"[^>]*disabled/, 'no sending before the server is allowed and checked');
  assert.deepEqual(checked, [], 'not checked before it is allowed');
  await app.rgb.action('allowProxy');
  assert.deepEqual(asked, [['https://rgb.example.com/json-rpc']]);
  assert.deepEqual(checked, ['https://rgb.example.com/json-rpc']);
  html = app.ui.views.rgbsend.render();
  assert.match(html, /can't use this invoice's transfer server: rgb\.example\.com: Invalid proxy protocol version: 0\.1/);
  fail = '';
  await app.rgb.action('recheck');
  assert.equal(app.rgb.pending.check.ok, true);
  assert.doesNotMatch(app.ui.views.rgbsend.render(), /data-rgb="confirm"[^>]*disabled/);
  await app.rgb.action('review');
  assert.equal(app.rgb.pending.ask.length, 0, 'a later invoice reuses the existing grant');
  assert.equal(app.rgb.pending.check.ok, true);
  assert.equal(asked.length, 1);
  app.platform.hasOrigins = async ([url]) => new URL(url).host === 'proxy.iriswallet.com';
  app.rgb.service.decode = async () => ({ network: 'signet', transportEndpoints: ['rpcs://rgb.example.com/json-rpc', 'rpcs://proxy.iriswallet.com/0.2/json-rpc'] });
  await app.rgb.action('review');
  assert.deepEqual(app.rgb.pending.ask, [], 'a reachable approved endpoint avoids a prompt for an alternate');
  app.rgb.service.send = async ({ endpoint }) => {
    assert.equal(endpoint, 'rpcs://proxy.iriswallet.com/0.2/json-rpc');
    return { txid: 'ab'.repeat(32) };
  };
  app.rgb.service.snapshot = async () => app.rgb.data;
  await app.rgb.action('confirm');
  assert.equal(app.rgb.sent.txid, 'ab'.repeat(32));
  assert.match(rgbError('Invalid transport endpoints: no valid transport endpoints'), /transfer server named in this invoice/);
});

test('RGB proxy permission resumes the same send review in a compact popup window', async () => {
  const popup = rgbApp();
  rgbReady(popup);
  popup.state.view = 'rgbsend';
  popup.rgb.asset = 'rgb:tusd';
  popup.rgb.fields.sendTo = 'rgb:example';
  popup.rgb.fields.sendAmt = '2';
  popup.rgb.service.decode = async () => ({ network: 'signet', transportEndpoints: ['rpcs://rgb.example.com/json-rpc'] });
  let draft;
  popup.platform.isPopup = true;
  popup.platform.hasOrigins = async () => false;
  const previousChrome = globalThis.chrome;
  const previousWindow = globalThis.window;
  let windowOptions;
  let closed = false;
  globalThis.window = { close: () => { assert.ok(windowOptions); closed = true; } };
  globalThis.chrome = {
    runtime: { getURL: (path) => `chrome-extension://masked/${path}` },
    storage: { session: { set: async (entry) => { [draft] = Object.values(entry); } } },
    windows: {
      getCurrent: async () => ({ left: 100, top: 20, width: 1500, height: 900, state: 'normal' }),
      create: async (options) => { windowOptions = options; },
    },
  };
  popup.platform.requestOrigins = async () => assert.fail('the popup must not request permission');
  try {
    await popup.rgb.action('review');
    await popup.rgb.action('allowProxy');
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.equal(closed, true, 'the toolbar popup closes after the replacement is open');
  assert.deepEqual({ ...windowOptions, url: undefined }, { url: undefined, type: 'popup', width: 380, height: 660, left: 1208, top: 92, focused: true });
  assert.match(windowOptions.url, /^chrome-extension:\/\/masked\/masked\.html\?rgbResume=/);
  assert.equal(draft.fields.sendTo, 'rgb:example');
  assert.equal(draft.fields.sendAmt, '2');

  const tab = rgbApp();
  tab.rgb.open = async () => { rgbReady(tab); tab.rgb.service.decode = popup.rgb.service.decode; };
  let allowed = false;
  tab.platform.hasOrigins = async () => allowed;
  tab.platform.requestOrigins = async () => { throw new Error('Permission declined'); };
  await tab.rgb.resumePermission(draft);
  assert.equal(tab.state.view, 'rgbsend');
  assert.equal(tab.rgb.pending.shown, '2');
  await tab.rgb.action('allowProxy');
  assert.equal(tab.state.view, 'rgbsend');
  assert.equal(tab.rgb.pending.ask.length, 1);
  tab.platform.requestOrigins = async () => { allowed = true; };
  await tab.rgb.action('allowProxy');
  assert.equal(tab.state.view, 'rgbsend');
  assert.equal(tab.rgb.pending.invoice, 'rgb:example');
  assert.equal(tab.rgb.pending.check.ok, true);
  assert.equal(tab.rgb.sent, null);
});

test('RGB beta setup restores the checked consent screen and reveals its button', async () => {
  const popup = rgbApp('main');
  let draft;
  popup.platform.isPopup = true;
  popup.platform.hasOrigins = async () => false;
  popup.platform.openRgbPermissionWindow = async (data) => { draft = structuredClone(data); };
  popup.rgb.betaAsk = popup.rgb.betaOk = true;
  await popup.rgb.action('betaYes');
  const replacement = rgbApp('main');
  let revealed;
  replacement.platform.revealRgbPermissionAction = (name) => { revealed = name; };
  await replacement.rgb.resumePermission(draft);
  assert.equal(replacement.rgb.betaAsk, true);
  assert.equal(replacement.rgb.betaOk, true);
  assert.equal(revealed, 'betaYes');
  assert.match(replacement.ui.views.home.render(), /data-rgbbeta checked[\s\S]*Turn on RGB beta/);
});

test('RGB: a payment an earlier beta counted twice is left out of the balance and explained', async () => {
  const app = rgbApp('main');
  localStorage.setItem('masked.rgb.mainnet-beta', '1');
  rgbReady(app);
  const MUSD = { assetId: 'rgb:musd', ticker: 'MUSD', name: 'Masked USD', precision: 0, issuedSupply: 100000000, balance: { settled: 100001000, future: 100001000, spendable: 100001000 } };
  app.rgb.data.groups = { nia: [MUSD] };
  app.rgb.data.transfers = { 'rgb:musd': [
    { idx: 1, status: 'Settled', kind: 'Issuance', assignments: [{ Fungible: 100000000 }] },
    { idx: 2, status: 'Settled', kind: 'Send', txid: 'out', assignments: [{ Fungible: 1000 }] },
    { idx: 3, status: 'Settled', kind: 'ReceiveWitness', recipientId: 'bc:wvout:S', txid: 'back', assignments: [{ Fungible: 1000 }] },
    { idx: 4, status: 'Settled', kind: 'ReceiveWitness', recipientId: 'bc:wvout:S', txid: 'back', assignments: [{ Fungible: 1000 }] },
  ] };
  assert.equal(app.rgb.doubled('rgb:musd'), 1000);
  assert.equal(app.rgb.bal(MUSD).settled, 100000000);
  assert.match(app.ui.views.home.render(), /100,000,000/);
  assert.doesNotMatch(app.ui.views.home.render(), /100,001,000/);
  app.rgb.asset = 'rgb:musd'; app.state.view = 'rgbtok';
  const page = app.ui.views.rgbtok.render();
  assert.match(page, /counted one payment of 1,000 MUSD twice/);
  assert.match(page, /Available to send<\/span><b>100,000,000/);
  await app.rgb.action('doubledOk', 'rgb:musd');
  const after = app.ui.views.rgbtok.render();
  assert.doesNotMatch(after, /counted one payment/, '"Got it" hides the note');
  assert.match(after, /100,000,000/, 'the corrected balance stays');
  localStorage.removeItem('masked.rgb.mainnet.v1.doubled-ok.rgb:musd');
  localStorage.removeItem('masked.rgb.mainnet-beta');
});

test('RGB servers are asked for when RGB is turned on, not at install; an update without them asks with one tap', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.host_permissions.some((h) => /iriswallet|utexo/.test(h)), false, 'no new install permission: existing users are not disabled by the update');
  const app = rgbApp('main');
  const r = app.rgb;
  localStorage.removeItem('masked.rgb.mainnet-beta');
  const asked = []; let allow = false, granted = false;
  app.platform.requestOrigins = async (urls) => { asked.push(...urls); if (!allow) throw new Error('declined'); granted = true; };
  app.platform.hasOrigins = async () => granted;
  r.betaOk = true;
  await r.action('betaYes');
  assert.deepEqual(asked, ['https://mempool.space/api', 'https://proxy.iriswallet.com/0.2/json-rpc']);
  assert.match(r.message, /needs permission/);
  assert.equal(localStorage.getItem('masked.rgb.mainnet-beta'), null, 'declined: the beta stays off');
  // already on, permission missing after the update: RGB doesn't try to open, Home offers one tap
  localStorage.setItem('masked.rgb.mainnet-beta', '1');
  localStorage.setItem('masked.rgb.mainnet.v1', '{"format":"x"}');
  r.tried = ''; r.ensure();
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.phase, 'allow');
  assert.match(app.ui.views.home.render(), /data-rgb="retry"[^>]*>.*Allow RGB to connect/s);
  allow = true; asked.length = 0;
  let opened = false; r.ensure = () => { opened = true; };
  await r.action('retry');
  assert.equal(granted, true); assert.equal(opened, true); assert.notEqual(r.phase, 'allow');
  localStorage.removeItem('masked.rgb.mainnet.v1'); localStorage.removeItem('masked.rgb.mainnet-beta');
});

test('RGB mainnet: an invoice is backed up before it is shown; a backup file counts only once written', async () => {
  const app = rgbApp('main');
  const r = app.rgb;
  localStorage.setItem('masked.rgb.mainnet-beta', '1');
  localStorage.removeItem('masked.rgb.cloud');
  for (const k of ['.cloud-version', '.file-at', '.confirmed-backup', '.invoices']) localStorage.removeItem('masked.rgb.mainnet.v1' + k);
  rgbReady(app);
  let dirty = false, puts = 0, online = true;
  Object.defineProperty(r.service, 'backupRequired', { get: () => dirty }); // (Object.assign would copy the value, not the getter)
  Object.assign(r.service, {
    everBackedUp: true,
    receive: async () => { dirty = true; return { invoice: 'rgb:~/~/~/bc:wvout:N', recipientId: 'bc:wvout:N', expirationTimestamp: Math.floor(Date.now() / 1000) + 3600 }; },
    backup: async () => ({ format: 'masked-rgb-signet', version: 1, ciphertext: 'x' }),
    backupSaved: () => { dirty = false; },
  });
  r.cloudApi = { put: async () => { if (!online) throw new Error('Could not reach the MASKED backup server.'); puts++; }, latest: async () => null, remove: async () => {} };
  r.fields.recvType = 'witness';
  app.state.f.recvKind = 'rgb';
  app.render = () => {
    if (dirty) assert.doesNotMatch(app.ui.views.receive.render(), /data-copy="rgb:|class="qr-wrap"/);
  };
  await r.action('invoice');
  assert.equal(r.invoice, 'rgb:~/~/~/bc:wvout:N');
  assert.equal(puts, 1, 'saved before the action finished');
  assert.equal(dirty, false);
  assert.doesNotMatch(app.ui.views.receive.render(), /isn't in a backup yet/);
  assert.match(app.ui.views.receive.render(), /data-copy="rgb:/);
  // The server is down: sharing stays blocked on both the invoice and its history.
  online = false; r.invoice = '';
  await r.action('invoice');
  assert.equal(dirty, true);
  assert.match(app.ui.views.receive.render(), /isn't in a backup yet[\s\S]*data-rgb="cloudRetry"/);
  assert.doesNotMatch(app.ui.views.receive.render(), /data-copy="rgb:|class="qr-wrap"/);
  const invoice = r.invoice;
  r.invoice = '';
  assert.doesNotMatch(app.ui.views.receive.render(), /data-copy="rgb:|data-rgb="showInv"/);
  r.invoice = invoice;
  // backup file through Chrome's save dialog: cancelled → not marked; written → marked
  const g = /** @type {any} */ (globalThis);
  g.showSaveFilePicker = async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
  await r.action('backup');
  assert.equal(dirty, true, 'cancelled: nothing is marked saved');
  let written = '';
  g.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async (t) => { written = t; }, close: async () => {} }) });
  await r.action('backup');
  assert.match(written, /masked-rgb-signet/);
  assert.equal(dirty, false);
  assert.ok(r.fileAt > 0);
  dirty = true;
  g.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async () => { throw new Error('disk full'); }, close: async () => {} }) });
  await r.action('backup');
  assert.equal(dirty, true, 'a failed write is not a backup');
  delete g.showSaveFilePicker;
  const previousDocument = g.document;
  const previousTimeout = g.setTimeout;
  const fileAt = r.fileAt;
  let clicked = false;
  g.document = { createElement: () => ({ click: () => { clicked = true; } }) };
  g.setTimeout = () => 0;
  try {
    await r.action('backup');
    assert.ok(clicked);
    assert.equal(dirty, true, 'an unconfirmed download is not a backup');
    assert.equal(r.fileAt, fileAt);
  } finally {
    g.document = previousDocument;
    g.setTimeout = previousTimeout;
  }
  localStorage.removeItem('masked.rgb.mainnet-beta');
  for (const k of ['.cloud-version', '.cloud-at', '.file-at', '.confirmed-backup', '.invoices']) localStorage.removeItem('masked.rgb.mainnet.v1' + k);
});
