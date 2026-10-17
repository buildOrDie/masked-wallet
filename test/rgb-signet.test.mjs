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
test('configuration is fixed to Utexo Signet with cloud backup and Lightning disabled', () => {
  assert.equal(RGB_SIGNET.network, 'utexo'); assert.equal(RGB_SIGNET.proxyUrl, ''); assert.equal(RGB_SIGNET.vssUrl, null);
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
test('transactions require backup and reserve dirty state before SDK mutation', async () => {
  const f = fixture(); await open(f); await assert.rejects(() => f.service.createUtxos('2'));
  f.service.backupSaved(); await f.service.createUtxos('2');
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
