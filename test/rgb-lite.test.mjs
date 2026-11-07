// The on-chain RGB engine adapter (LiteWallet) against a fake rgb-lib-wasm: the exact calls and shapes it uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiteWallet, rgbNetwork, rpcEndpoint } from '../src/rgb/LiteWallet.mjs';
import { RGB_PROFILES } from '../src/rgb/config.mjs';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function fakeLib() {
  const calls = [];
  class WasmWallet {
    static async create(json) { calls.push(['create', JSON.parse(json)]); return new WasmWallet(); }
    async goOnline(skip, url) { calls.push(['goOnline', skip, url]); return { id: 1, indexerUrl: url }; }
    async sync(online) { calls.push(['sync', online.id]); }
    async fullScan(online) { calls.push(['fullScan', online.id]); }
    async refresh(online, a, f, skip) { calls.push(['refresh', a, f, skip]); return {}; }
    async flush() { calls.push(['flush']); }
    free() { calls.push(['free']); }
    getAddress() { return 'tb1qtest'; }
    getBtcBalance() { return { vanilla: { settled: 5000n, future: 7000n, spendable: 5000n }, colored: { settled: 2000n, future: 2000n, spendable: 2000n } }; }
    listAssets(f) { calls.push(['listAssets', f]); return { nia: [{ assetId: 'rgb:A', ticker: 'TUSDT', name: 'Test USD', precision: 2, issuedSupply: 100, balance: { settled: 100, future: 100, spendable: 100 } }], ifa: [], cfa: [] }; }
    listTransfers() { return [{ idx: 1n, createdAt: 1761400000n, updatedAt: 1761400100n, status: 'Settled', kind: 'Issuance', assignments: [{ Fungible: 100000n }] }]; }
    async createUtxosBegin(...a) { calls.push(['createUtxosBegin', ...a.slice(1)]); return 'psbt-u'; }
    async createUtxosEnd(o, signed, skip) { calls.push(['createUtxosEnd', signed, skip]); return 4; }
    signPsbt(p) { calls.push(['sign', p]); return 'signed-' + p; }
    issueAssetNia(...a) { calls.push(['issue', ...a]); return { assetId: 'rgb:NEW', ticker: a[0], name: a[1], precision: a[2], issuedSupply: a[3][0], balance: { settled: a[3][0] } }; }
    blindReceive(...a) { calls.push(['blindReceive', ...a]); return { invoice: 'rgb:~/~/utxob:xyz?endpoints=rpcs://p', recipientId: 'utxob:xyz', expirationTimestamp: 9 }; }
    witnessReceive(...a) { calls.push(['witnessReceive', ...a]); return { invoice: 'rgb:~/~/~/sb:wvout:xyz', recipientId: 'sb:wvout:xyz', expirationTimestamp: 9 }; }
    async sendBegin(o, map, donation, fee, minConf) { calls.push(['sendBegin', map, donation, fee, minConf]); return 'psbt-s'; }
    async sendEnd(o, signed, skip) { calls.push(['sendEnd', signed, skip]); return { txid: 'tx1', batchTransferIdx: 1 }; }
    backup(pw) { calls.push(['backup', pw]); return new Uint8Array([7, 8]); }
    restoreBackup(b, pw) { calls.push(['restore', [...b], pw]); }
  }
  class WasmInvoice {
    constructor(s) { this.s = s; }
    invoiceData() { if (this.s === 'rgb:w') return { recipientId: 'sb:wvout:w1', assignment: { Fungible: 300n }, network: 'Signet', transportEndpoints: [] }; return { recipientId: 'utxob:abc', assetId: null, network: 'Signet', expirationTimestamp: null, transportEndpoints: ['rpcs://proxy.iriswallet.com/0.2/json-rpc'] }; }
    free() {}
  }
  const restoreKeys = (net, m) => { calls.push(['restoreKeys', net, m]); return { accountXpubVanilla: 'xv', accountXpubColored: 'xc', masterFingerprint: 'ff' }; };
  return { lib: { WasmWallet, WasmInvoice, restoreKeys }, calls };
}

const open = async () => {
  const f = fakeLib();
  const w = new LiteWallet(f.lib, { ...RGB_PROFILES.public.sdk, mnemonic, password: 'unused here' });
  await w.init(); await w.unlock();
  return { w, calls: f.calls };
};

test('networks and transport endpoints in rgb-lib form', () => {
  assert.equal(rgbNetwork('signet'), 'Signet');
  assert.equal(rgbNetwork('utexo'), 'Signet');
  assert.equal(rgbNetwork('mainnet'), 'Mainnet');
  assert.throws(() => rgbNetwork('nope'));
  assert.equal(rpcEndpoint('https://proxy.iriswallet.com/0.2/json-rpc'), 'rpcs://proxy.iriswallet.com/0.2/json-rpc');
  assert.equal(rpcEndpoint('http://127.0.0.1:3000/json-rpc'), 'rpc://127.0.0.1:3000/json-rpc');
});

test('opens with camelCase wallet data (11 fields) and goes online on mempool.space', async () => {
  const { calls } = await open();
  assert.deepEqual(calls[0], ['restoreKeys', 'Signet', mnemonic]);
  const data = calls[1][1];
  assert.deepEqual(Object.keys(data).sort(), ['accountXpubColored', 'accountXpubVanilla', 'bitcoinNetwork', 'dataDir', 'databaseType', 'masterFingerprint', 'maxAllocationsPerUtxo', 'mnemonic', 'reuseAddresses', 'supportedSchemas', 'vanillaKeychain']);
  assert.equal(data.bitcoinNetwork, 'Signet');
  assert.equal(data.dataDir, 'masked_rgb_public_signet_v2');
  assert.deepEqual(calls[2], ['goOnline', false, 'https://mempool.space/signet/api']);
});

test('balances and assets in the shapes the screens read', async () => {
  const { w } = await open();
  const b = await w.getBtcBalance();
  assert.deepEqual(b.vanilla, { settled: 5000, future: 7000, spendable: 5000 });
  const a = await w.listAssets();
  assert.equal(a.nia[0].assetId, 'rgb:A');
  assert.equal(a.nia[0].balance.settled, 100);
  assert.deepEqual(a.ifa, []);
});

test('prepare outputs, issue, receive: signs with its own keys and saves to IndexedDB', async () => {
  const { w, calls } = await open();
  assert.equal(await w.createUtxos({ upTo: true, num: 4, size: 1000, feeRate: 2 }), 4);
  assert.deepEqual(calls.find((c) => c[0] === 'createUtxosBegin'), ['createUtxosBegin', true, 4, 1000, 2n, false]);
  assert.deepEqual(calls.find((c) => c[0] === 'createUtxosEnd'), ['createUtxosEnd', 'signed-psbt-u', false]);
  const a = await w.issueAssetNia({ ticker: 'MASKED', name: 'masket', precision: 2, amounts: [240000000] });
  assert.equal(a.assetId, 'rgb:NEW');
  assert.deepEqual(calls.find((c) => c[0] === 'issue'), ['issue', 'MASKED', 'masket', 2, [240000000]]);
  const r = await w.onchainReceive({ assetId: '' });
  assert.match(r.invoice, /^rgb:/);
  assert.deepEqual(calls.find((c) => c[0] === 'blindReceive'), ['blindReceive', null, 'Any', null, ['rpcs://proxy.iriswallet.com/0.2/json-rpc'], 1]);
  assert.ok(calls.filter((c) => c[0] === 'flush').length >= 3);
});

test('send: the invoice recipient, Fungible amount, its transport endpoints, signed then broadcast', async () => {
  const { w, calls } = await open();
  const d = await w.decodeRGBInvoice({ invoice: 'rgb:x' });
  assert.equal(d.network, 'signet');
  assert.equal(d.recipientId, 'utxob:abc');
  const r = await w.onchainSend({ invoice: 'rgb:x', assetId: 'rgb:A', amount: 150, feeRate: 2 });
  assert.equal(r.txid, 'tx1');
  const [, map, donation, fee, minConf] = calls.find((c) => c[0] === 'sendBegin');
  assert.deepEqual(map, { 'rgb:A': [{ recipientId: 'utxob:abc', witnessData: null, assignment: { Fungible: 150 }, transportEndpoints: ['rpcs://proxy.iriswallet.com/0.2/json-rpc'] }] });
  assert.equal(donation, false); assert.equal(fee, 2n); assert.equal(minConf, 1);
  assert.deepEqual(calls.find((c) => c[0] === 'sendEnd'), ['sendEnd', 'signed-psbt-s', false]);
});

test('backup bytes, restore, and closing frees the engine after saving', async () => {
  const { w, calls } = await open();
  await w.createBackup({ password: 'pw-123456789' });
  assert.deepEqual([...w.getLastBackupBytes()], [7, 8]);
  await w.restoreFromBackupBytes(new Uint8Array([1]), 'pw-123456789');
  assert.deepEqual(calls.find((c) => c[0] === 'restore'), ['restore', [1], 'pw-123456789']);
  await w.dispose();
  assert.deepEqual(calls.slice(-2), [['flush'], ['free']]);
  assert.equal(w.isOnline(), false);
  await assert.rejects(() => w.getAddress(), /not open/);
});

test('Refresh can scan addresses ahead, so coins sent to an older address are found', async () => {
  const { w, calls } = await open();
  await w.syncWallet();
  assert.equal(calls.some((c) => c[0] === 'fullScan'), false, 'the minute-by-minute sync stays light');
  await w.syncWallet({ full: true });
  const i = calls.findIndex((c) => c[0] === 'fullScan');
  assert.ok(i > 0 && calls[i + 1][0] === 'sync', 'full scan, then sync');
});

test('BigInt from the engine becomes plain numbers (the screens sort and date them)', async () => {
  const { plain } = await import('../src/rgb/LiteWallet.mjs');
  assert.deepEqual(plain({ a: 5n, b: [1n, { c: 2n }], d: 'x', e: null }), { a: 5, b: [1, { c: 2 }], d: 'x', e: null });
  assert.equal(plain(2n ** 60n), '1152921504606846976', 'too big for a number: kept exact as text');
  const { w } = await open();
  const [t] = await w.listTransfers('rgb:A');
  assert.equal(typeof t.createdAt, 'number');
  assert.equal(t.createdAt * 1000 - 0, 1761400000000);
  assert.equal(t.assignments[0].Fungible, 100000);
});

test('witness invoices: made with no RGB output of ours; paying one adds 330 sats (Taproot dust) for the new output', async () => {
  const { w, calls } = await open();
  await w.onchainReceive({ assetId: 'rgb:A', amount: 300, durationSeconds: 3600, witness: true });
  assert.deepEqual(calls.find((c) => c[0] === 'witnessReceive'), ['witnessReceive', 'rgb:A', { Fungible: 300 }, 3600, ['rpcs://proxy.iriswallet.com/0.2/json-rpc'], 1]);
  const d = await w.decodeRGBInvoice({ invoice: 'rgb:w' });
  assert.equal(d.witness, true); assert.equal(d.amount, 300);
  await w.onchainSend({ invoice: 'rgb:w', assetId: 'rgb:A', amount: 300, feeRate: 2 });
  const [, map] = calls.find((c) => c[0] === 'sendBegin');
  assert.deepEqual(map['rgb:A'][0].witnessData, { amountSat: '330', blinding: null }, 'a string: the real engine refuses a number here');
  assert.equal(typeof map['rgb:A'][0].assignment.Fungible, 'number', 'and refuses a string for the token amount');
  assert.equal(map['rgb:A'][0].transportEndpoints[0], 'rpcs://proxy.iriswallet.com/0.2/json-rpc', 'falls back to our proxy');
});

test('each witness invoice gets a fresh receive address; one an earlier transfer used is cancelled, never shown', async () => {
  const f = fakeLib();
  let pinned = 0; const rotated = [], failed = [];
  const W = f.lib.WasmWallet.prototype;
  W.rotateAddress = function (k) { rotated.push(k); pinned++; return 'bc1p' + pinned; };
  W.witnessReceive = function () { return { invoice: `rgb:~/~/~/bc:wvout:S${pinned}`, recipientId: `bc:wvout:S${pinned}`, batchTransferIdx: 10 + pinned, expirationTimestamp: 9 }; };
  W.failTransfers = async function (o, idx) { failed.push(idx); return true; };
  // S1 was already paid once (the old pinned address): the first try lands on it, the second is fresh
  W.listTransfers = function () { return [{ idx: 1, status: 'Settled', kind: 'ReceiveWitness', recipientId: 'bc:wvout:S1', txid: 't1', assignments: [{ Fungible: 1000 }] }]; };
  const w = new LiteWallet(f.lib, { ...RGB_PROFILES.public.sdk, mnemonic, password: 'x' });
  await w.init(); await w.unlock();
  const a = await w.onchainReceive({ witness: true });
  assert.equal(a.recipientId, 'bc:wvout:S2');
  assert.deepEqual(rotated, [0, 0], 'the receive keychain (0) rotates; the funding address (1) stays');
  assert.deepEqual(failed, [11], 'the reused one is cancelled so it can never match a payment');
  const b = await w.onchainReceive({ witness: true });
  assert.notEqual(b.recipientId, a.recipientId);
  await w.onchainReceive({ witness: false });
  assert.equal(rotated.length, 3, 'blind invoices don\'t rotate');
});

test('locked coins: a coin with an unsettled allocation or a pending private invoice', async () => {
  const f = fakeLib();
  f.lib.WasmWallet.prototype.listUnspents = () => [
    { utxo: { outpoint: { txid: 'a', vout: 0 } }, rgbAllocations: [{ settled: true }, { settled: false }], pendingBlinded: 0 },
    { utxo: { outpoint: { txid: 'b', vout: 1 } }, rgbAllocations: [{ settled: true }], pendingBlinded: 0 },
    { utxo: { outpoint: { txid: 'c', vout: 2 } }, rgbAllocations: [], pendingBlinded: 1 },
  ];
  const w = new LiteWallet(f.lib, { ...RGB_PROFILES.public.sdk, mnemonic, password: 'x' });
  await w.init(); await w.unlock();
  assert.deepEqual(await w.lockedCoins(), ['a:0', 'c:2']);
});
