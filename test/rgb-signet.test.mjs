import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetWallet } from '../src/rgb/SignetWallet.mjs';
import { encryptRgb, decryptRgb } from '../src/rgb/backup.mjs';
import { RGB_SIGNET, RGB_VAULT_KEY, RGB_DIRTY_KEY, baseUnits, testFee } from '../src/rgb/config.mjs';
import { b64, unb64 } from '../src/rgb/bytes.mjs';
const password = 'test password for signet only';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
class MemoryStorage {
  map = new Map();
  getItem(k) { return this.map.get(k) ?? null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}
function fixture() {
  const calls = []; const storage = new MemoryStorage();
  class Wallet {
    constructor(params) { calls.push(['params', params]); }
    async init() { calls.push(['init']); }
    async unlock() { calls.push(['unlock']); }
    isOnline() { return true; }
    async goOnline() {}
    async dispose() { calls.push(['dispose']); }
    async syncWallet() { calls.push(['sync']); }
    async refreshWallet() { calls.push(['refresh']); }
    async getAddress() { return 'tb1test'; }
    async getBtcBalance() { return { vanilla: { spendable: 1000n } }; }
    async listAssets() { return { nia: [] }; }
    async listTransfers() { return []; }
    async createUtxos(params) { calls.push(['utxos', params]); return 4; }
    async onchainReceive(params) { calls.push(['receive', params]); return { invoice: 'rgb:test' }; }
    async decodeRGBInvoice() { return { recipientId: 'utxob:test', network: 'signet', assetId: 'asset' }; }
    async onchainSend(params) { calls.push(['send', params]); return { txid: 'test-txid' }; }
    async createBackup() { calls.push(['backup']); }
    getLastBackupBytes() { return new Uint8Array([1, 2, 3]); }
    restoreFromBackupBytes(bytes) { calls.push(['restore', [...bytes]]); }
  }
  const service = new SignetWallet({ loadSdk: async () => ({ UTEXOWallet: Wallet }), storage });
  return { service, storage, calls };
}
const open = f => f.service.open(password, () => mnemonic);
test('Utexo Signet configuration: no Lightning, no cloud backup settings', () => {
  assert.equal(RGB_SIGNET.network, 'utexo'); assert.equal('proxyUrl' in RGB_SIGNET, false); assert.equal('vssUrl' in RGB_SIGNET, false);
  assert.ok(Object.isFrozen(RGB_SIGNET));
});
test('exact base units reject fractions, scientific notation, zero and unsafe integers', () => {
  assert.equal(baseUnits('1000000'), 1000000);
  for (const v of ['0', '-1', '1.1', '1e6', '9007199254740993']) assert.throws(() => baseUnits(v));
  assert.equal(testFee('2'), 2); for (const v of ['0', '101', 'Infinity']) assert.throws(() => testFee(v));
});
test('encrypted vault does not contain plaintext keys and wrong password fails', async () => {
  const envelope = await encryptRgb({ mnemonic }, password);
  assert.ok(!JSON.stringify(envelope).includes(mnemonic));
  assert.equal((await decryptRgb(envelope, password)).mnemonic, mnemonic);
  await assert.rejects(() => decryptRgb(envelope, 'wrong password'));
  await assert.rejects(() => decryptRgb({ ...envelope, version: 2 }, password));
  await assert.rejects(() => encryptRgb({ mnemonic }, 'short'));
});
test('large RGB backups round trip without spread-argument overflow', () => {
  const bytes = new Uint8Array(400000).fill(217); assert.deepEqual(unb64(b64(bytes)), bytes);
});
test('new test seed is encrypted separately before SDK init and init precedes unlock', async () => {
  const f = fixture(); await open(f);
  assert.ok(f.storage.getItem(RGB_VAULT_KEY)); assert.equal(f.storage.getItem('wren.vault'), null);
  assert.deepEqual(f.calls.slice(1).map(c => c[0]), ['init', 'unlock']);
  assert.equal(f.calls[0][1].network, 'utexo'); assert.equal(f.service.backupRequired, true);
});
test('backup includes both keys and RGB state, then restore precedes unlock', async () => {
  const f = fixture(); await open(f); const envelope = await f.service.backup();
  const payload = await decryptRgb(envelope, password);
  assert.equal(payload.mnemonic, mnemonic); assert.deepEqual([...unb64(payload.rgbBackup)], [1, 2, 3]);
  const restored = fixture(); await restored.service.open(password, () => { throw new Error('must not generate'); }, envelope);
  assert.deepEqual(restored.calls.slice(1).map(c => c[0]), ['init', 'restore', 'unlock']);
  await assert.rejects(() => f.service.open(password, () => mnemonic, envelope));
});
test('transactions mark the backup as out of date before SDK mutation (a reminder, not a block)', async () => {
  const f = fixture(); await open(f); f.service.backupSaved(); await f.service.createUtxos('2');
  assert.equal(f.storage.getItem(RGB_DIRTY_KEY), '1');
  assert.deepEqual(f.calls.at(-1), ['utxos', { upTo: true, num: 4, size: 1000, feeRate: 2 }]);
});
test('snapshot is sequential, supports bigint and notices newly received state', async () => {
  const f = fixture(); await open(f); f.service.backupSaved(); await f.service.snapshot();
  assert.deepEqual(f.calls.slice(-2).map(c => c[0]), ['sync', 'refresh']); assert.equal(f.service.backupRequired, true);
  f.service.backupSaved(); await f.service.snapshot(); assert.equal(f.service.backupRequired, false);
});
test('valid test send uses the reviewed exact asset and amount', async () => {
  const f = fixture(); await open(f); f.service.backupSaved();
  await f.service.send({ invoice: 'rgb:test', assetId: 'asset', amount: '100', fee: '2' });
  assert.deepEqual(f.calls.at(-1), ['send', { invoice: 'rgb:test', assetId: 'asset', amount: 100, feeRate: 2 }]);
});
for (const [label, decoded] of [
  ['mainnet', { recipientId: 'utxob:test', network: 'mainnet' }],
  ['wrong asset', { recipientId: 'utxob:test', network: 'signet', assetId: 'other' }],
  ['witness', { recipientId: 'wvout:test', network: 'signet' }],
  ['expired', { recipientId: 'utxob:test', network: 'signet', expirationTimestamp: 1 }],
]) test(`${label} invoice never reaches send`, async () => {
  const f = fixture(); await open(f); f.service.backupSaved();
  f.service.wallet.decodeRGBInvoice = async () => decoded;
  await assert.rejects(() => f.service.send({ invoice: 'rgb:test', assetId: 'asset', amount: '100', fee: '2' }));
  assert.equal(f.calls.some(c => c[0] === 'send'), false);
});
test('overlapping WASM operations are rejected and closing clears in-memory secrets', async () => {
  const f = fixture(); await open(f); let release;
  const pending = f.service.exclusive(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(() => f.service.snapshot()); release(); await pending;
  await f.service.close(); assert.equal(f.service.mnemonic, ''); assert.equal(f.service.password, ''); assert.equal(f.service.wallet, null);
});
test('SDK string errors become readable messages', async () => {
  const { rgbError } = await import('../src/rgb/WalletRgb.mjs');
  assert.match(rgbError('Invalid indexer: not a valid esplora server'), /Can't reach the Utexo Signet RGB servers/);
  assert.match(rgbError(new TypeError('Failed to fetch')), /Can't reach the Utexo Signet RGB servers/);
  assert.match(rgbError('InsufficientBitcoins'), /Not enough test BTC/);
  assert.match(rgbError('InsufficientAllocationSlots'), /Prepare RGB outputs/);
  assert.equal(rgbError('Invalid invoice'), 'Invalid invoice');
  assert.equal(rgbError(undefined), 'RGB operation failed.');
});

test('Public Signet profile: mempool.space, Iris proxy, its own keys and backups', async () => {
  const { RGB_PROFILES, profileOf, dirtyKey } = await import('../src/rgb/config.mjs');
  const p = RGB_PROFILES.public;
  assert.equal(profileOf(null).id, 'public');
  assert.equal(profileOf('nope').id, 'public');
  assert.equal(p.sdk.network, 'signet');
  assert.equal(p.sdk.indexerUrl, 'https://mempool.space/signet/api');
  assert.equal(p.sdk.transportEndpoint, 'https://proxy.iriswallet.com/0.2/json-rpc');
  assert.equal('proxyUrl' in p.sdk, false, 'no Lightning');
  assert.notEqual(p.vaultKey, RGB_PROFILES.utexo.vaultKey);
  assert.notEqual(dirtyKey(p), dirtyKey(RGB_PROFILES.utexo));
  assert.notEqual(p.sdk.dataDir, RGB_PROFILES.utexo.sdk.dataDir);
  // a Public Signet backup does not open as a Utexo one
  const env = await encryptRgb({ mnemonic }, password, 'public');
  assert.equal((await decryptRgb(env, password, 'public')).mnemonic, mnemonic);
  await assert.rejects(() => decryptRgb(env, password, 'utexo'));
});

test('test asset form: checks ticker, name, decimals and supply', async () => {
  const { newAsset } = await import('../src/rgb/config.mjs');
  assert.deepEqual(newAsset({ ticker: 'tusdt', name: ' Test USD ', precision: '2', supply: '1000' }), { ticker: 'TUSDT', name: 'Test USD', precision: 2, amounts: [100000] });
  for (const bad of [{ ticker: '1AB' }, { ticker: 'A' }, { ticker: 'TOOLONGXX' }, { name: 'x' }, { precision: '9' }, { precision: '1.5' }, { supply: '0' }, { supply: '9007199254740991', precision: '8' }]) {
    assert.throws(() => newAsset({ ticker: 'TUSDT', name: 'Test USD', precision: '2', supply: '1000', ...bad }));
  }
});

test('Public Signet wallet: issues a test asset after a backup, rejects Utexo invoices', async () => {
  const { RGB_PROFILES } = await import('../src/rgb/config.mjs');
  const calls = []; const storage = new MemoryStorage();
  class Wallet {
    constructor(params) { calls.push(['params', params]); }
    async init() {} async unlock() {} isOnline() { return true; } async dispose() {}
    async issueAssetNia(params) { calls.push(['issue', params]); return { assetId: 'rgb:abc', ticker: params.ticker }; }
    async decodeRGBInvoice() { return { recipientId: 'utxob:test', network: 'utexo' }; }
    async onchainSend() { calls.push(['send']); }
  }
  const service = new SignetWallet({ loadSdk: async () => ({ UTEXOWallet: Wallet }), storage, profile: RGB_PROFILES.public });
  await service.open(password, () => mnemonic);
  assert.equal(calls[0][1].network, 'signet');
  assert.ok(storage.getItem(RGB_PROFILES.public.vaultKey));
  assert.equal(storage.getItem(RGB_VAULT_KEY), null, 'the Utexo wallet is untouched');
  const a = await service.issue({ ticker: 'TUSDT', name: 'Test USD', precision: '2', supply: '10' });
  assert.equal(a.assetId, 'rgb:abc');
  assert.deepEqual(calls.at(-1), ['issue', { ticker: 'TUSDT', name: 'Test USD', precision: 2, amounts: [1000] }]);
  service.backupSaved();
  await assert.rejects(() => service.send({ invoice: 'rgb:x', assetId: 'rgb:abc', amount: '1', fee: '1' }), /not for Public Signet/);
  assert.equal(calls.some((c) => c[0] === 'send'), false);
});
