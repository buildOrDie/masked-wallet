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
  removeItem(k) { this.map.delete(k); }
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
  assert.equal(testFee('2'), 2); for (const v of ['0', '501', 'Infinity']) assert.throws(() => testFee(v));
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
  assert.deepEqual(f.calls.at(-1), ['utxos', { upTo: true, num: 4, size: 330, feeRate: 2 }]);
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
  ['not an invoice recipient', { recipientId: 'tb1qsomething', network: 'signet' }],
  ['amount differs from a fixed-amount invoice', { recipientId: 'utxob:test', network: 'signet', amount: 99 }],
  ['expired', { recipientId: 'utxob:test', network: 'signet', expirationTimestamp: 1 }],
]) test(`${label} invoice never reaches send`, async () => {
  const f = fixture(); await open(f); f.service.backupSaved();
  f.service.wallet.decodeRGBInvoice = async () => decoded;
  await assert.rejects(() => f.service.send({ invoice: 'rgb:test', assetId: 'asset', amount: '100', fee: '2' }));
  assert.equal(f.calls.some(c => c[0] === 'send'), false);
});
test('overlapping WASM operations wait their turn (2.32.6) and closing clears in-memory secrets', async () => {
  const f = fixture(); await open(f); let release;
  const pending = f.service.exclusive(() => new Promise(resolve => { release = resolve; }));
  let ran = false;
  const snap = f.service.snapshot().then(() => { ran = true; }, () => { ran = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ran, false, 'waits for the operation running');
  release(); await pending; await snap;
  assert.equal(ran, true);
  await f.service.close(); assert.equal(f.service.mnemonic, ''); assert.equal(f.service.password, ''); assert.equal(f.service.wallet, null);
});
test('SDK string errors become readable messages', async () => {
  const { rgbError } = await import('../src/rgb/WalletRgb.mjs');
  assert.match(rgbError('Invalid indexer: not a valid esplora server'), /Can't reach the Utexo Signet RGB servers/);
  assert.match(rgbError(new TypeError('Failed to fetch')), /Can't reach the Utexo Signet RGB servers/);
  const node = (m) => `Failed broadcast: Esplora async error: HttpResponse { status: 400, message: "sendrawtransaction RPC error: {\\"code\\":-26,\\"message\\":\\"${m}\\"}" }`;
  assert.match(rgbError(node('insufficient fee, rejecting replacement abc; new feerate 0.00001 <= old feerate 0.00002')), /already spent by another of your transactions.*rejecting replacement/);
  assert.match(rgbError(node('min relay fee not met, 100 < 141')), /network fee was too low.*min relay fee not met/);
  assert.match(rgbError(node('dust')), /refused the transaction: dust$/);
  assert.match(rgbError('InsufficientBitcoins'), /Not enough test BTC/);
  assert.match(rgbError('InsufficientAllocationSlots'), /still setting up/);
  assert.match(rgbError('Insufficient allocations'), /still setting up/, 'the wording rgb-lib-wasm uses');
  const timeout = 'Indexer error: Esplora async error: Reqwest(reqwest::Error { kind: Request, source: "JsValue(Error: Network timeout: the server did not answer in time\\nError: Network timeout: the server did not answer in time\\n at chrome-extension://x/app.bundle.js:5:11572" })';
  assert.equal(rgbError(timeout, { id: 'public', label: 'Public Signet' }), 'The Public Signet block server is busy or down right now.');
  assert.match(rgbError('Indexer error: Esplora async error: HttpResponse { status: 502, message: "<html><head><title>502 Bad Gateway</title>" }'), /busy or down/);
  assert.doesNotMatch(rgbError('Indexer error: x (JsValue(Error: socket closed\\n at foo.js:1:2))'), /foo\.js/);
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
  assert.equal(p.sdk.transportEndpoint, 'https://scan.maskedwallet.com/rgb-proxy/json-rpc');
  assert.deepEqual([...p.sdk.transportFallbacks], ['https://proxy.iriswallet.com/0.2/json-rpc']);
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

test('cancelling invoices fails only our receives still waiting for the other wallet', async () => {
  const f = fixture(); await open(f);
  const failed = [];
  const w = f.service.requireWallet();
  w.listAssets = async () => ({ nia: [{ assetId: 'rgb:A' }] });
  w.listTransfers = async (id) => (id === null
    ? [{ recipientId: 'utxob:OPEN', status: 'WaitingCounterparty', kind: 'ReceiveBlind', batchTransferIdx: 7 }]
    : [{ recipientId: 'utxob:PAID', status: 'Settled', kind: 'ReceiveBlind', batchTransferIdx: 8 }, { recipientId: 'x', status: 'WaitingCounterparty', kind: 'Send', batchTransferIdx: 9 }]);
  w.failTransfer = async (i) => { failed.push(i); return true; };
  assert.equal(await f.service.cancelInvoices(['utxob:OPEN', 'utxob:PAID', 'x']), 1);
  assert.deepEqual(failed, [7], 'a settled receive and an outgoing send are never touched');
  assert.equal(f.service.backupRequired, true);
});

test('cancelling every open invoice (none named) also catches ones made before the list existed', async () => {
  const f = fixture(); await open(f);
  const failed = [];
  const w = f.service.requireWallet();
  w.listAssets = async () => ({ nia: [] });
  w.listTransfers = async () => [{ recipientId: 'utxob:OLD', status: 'WaitingCounterparty', kind: 'ReceiveBlind', batchTransferIdx: 3 }];
  w.failTransfer = async (i) => { failed.push(i); return true; };
  assert.equal(await f.service.cancelInvoices(), 1);
  assert.deepEqual(failed, [3]);
});

test('cancelling unsent transfers fails only our sends the other wallet hasn\'t accepted', async () => {
  const f = fixture(); await open(f);
  const failed = [];
  const w = f.service.requireWallet();
  w.listAssets = async () => ({ nia: [{ assetId: 'rgb:A' }] });
  w.listTransfers = async () => [
    { kind: 'Send', status: 'WaitingCounterparty', txid: 'abc', batchTransferIdx: 4 }, // signed, not broadcast
    { kind: 'Send', status: 'WaitingConfirmations', txid: 'def', batchTransferIdx: 5 }, // on chain
    { kind: 'ReceiveBlind', status: 'WaitingCounterparty', batchTransferIdx: 6 }, // an invoice
    { kind: 'Send', status: 'WaitingCounterparty', batchTransferIdx: 10 }, // accepted meanwhile: the engine refuses
  ];
  w.failTransfer = async (i) => { if (i === 10) throw new Error('CannotFailBatchTransfer'); failed.push(i); return true; };
  const res = await f.service.cancelSends();
  assert.equal(res.n, 1);
  assert.deepEqual(res.errors, [{ idx: 10, reason: 'CannotFailBatchTransfer' }], 'the refusal and its reason are reported');
  assert.deepEqual(failed, [4], 'broadcast sends and invoices are never touched; one refusal does not stop the rest');
  failed.length = 0;
  assert.equal(await f.service.cancelSends([5, 6]), 0, 'named, but not unsent sends');
  assert.deepEqual(failed, []);
});

test('snapshot names sends the engine can no longer broadcast (signed transaction missing after a restore)', async () => {
  const f = fixture(); await open(f);
  const w = f.service.requireWallet();
  w.refreshWallet = async () => ({ 12: { updatedStatus: null, failure: { Internal: { details: 'signed PSBT not found in transfer artifacts' } } }, 13: { updatedStatus: 'Settled', failure: null } });
  const snap = await f.service.snapshot();
  assert.deepEqual(snap.stranded, [12]);
});
test('test networks: RGB tops its fee bitcoin up from Public by itself; mainnet never does', async () => {
  const { WalletRgb, RGB_FUND_SATS } = await import('../src/rgb/WalletRgb.mjs');
  const sent = [], toasts = [];
  const app = {
    feeRate: () => 1, toast: (t) => toasts.push(t), afterBroadcast: async () => {},
    builder: { send: async (o) => { sent.push(o); return { hex: 'aa', txid: 't1', spent: ['c:0'] }; } },
    broadcast: async () => 't1',
  };
  const w = Object.create(WalletRgb.prototype);
  w.app = app;
  let id = 'signet';
  Object.defineProperty(w, 'profile', { get: () => ({ id }) });
  w.data = { address: 'tb1prgb', btc: { vanilla: { settled: 2000, future: 2000 }, colored: { settled: 0, future: 0 } } };
  assert.equal(await w.autoFund(), true);
  assert.deepEqual(sent, [{ from: 'public', to: 'tb1prgb', amount: RGB_FUND_SATS, rate: 1, parts: 4 }], 'in a few coins');
  assert.match(toasts[0], /from your Public balance/);
  assert.equal(await w.autoFund(), false, 'once in 20 minutes: the top-up needs its block');
  w.fundedAt = 0; w.data.btc.vanilla = { settled: 50_000, future: 50_000 };
  assert.equal(await w.autoFund(), false, 'enough already');
  w.data.btc.vanilla = { settled: 0, future: 0 }; id = 'mainnet';
  assert.equal(await w.autoFund(), false, 'mainnet asks instead');
  id = 'signet'; app.builder.send = async () => { throw new Error('Your Public balance is empty.'); };
  assert.equal(await w.autoFund(), false, 'nothing in Public: Home\'s button stays');
  assert.equal(sent.length, 1);
});

test('RGB loads: the states they replace are kept (the last few, newest first), the old single slot included', async () => {
  const { BEFORE_LOADS } = await import('../src/rgb/SignetWallet.mjs');
  const storage = new MemoryStorage();
  const service = new SignetWallet({ loadSdk: async () => ({}), storage });
  // what an older build kept: one slot
  storage.setItem(`${service.vaultKey}.before-load`, JSON.stringify({ format: 'x', ciphertext: 'oldest' }));
  assert.equal(service.beforeLoads().length, 1);
  assert.equal(storage.getItem(`${service.vaultKey}.before-load`), null, 'moved into the list, not lost');
  for (let k = 1; k <= BEFORE_LOADS + 2; k++) service.keepBeforeLoad({ format: 'x', ciphertext: `s${k}` });
  const list = service.beforeLoads();
  assert.equal(list.length, BEFORE_LOADS);
  assert.equal(service.beforeLoad(0).ciphertext, `s${BEFORE_LOADS + 2}`, 'newest first');
  assert.equal(service.beforeLoad(BEFORE_LOADS), null);
  // storage full: fewer kept, the newest never dropped
  const full = new MemoryStorage(); const set = full.setItem.bind(full);
  full.setItem = (k, v) => { if (k.endsWith('.before-loads') && JSON.parse(v).length > 2) throw new Error('QuotaExceededError'); set(k, v); };
  const s2 = new SignetWallet({ loadSdk: async () => ({}), storage: full });
  for (let k = 1; k <= 4; k++) s2.keepBeforeLoad({ format: 'x', ciphertext: `t${k}` });
  assert.deepEqual([0, 1].map((i) => s2.beforeLoad(i).ciphertext), ['t4', 't3']);
});

test('Instant records: a full browser storage never stops listings; finished entries lose their signed data, then go', async () => {
  const storage = new MemoryStorage();
  const service = new SignetWallet({ loadSdk: async () => ({}), storage });
  const key = `${service.vaultKey}.swaps.instant`;
  // a storage that holds 3,000 characters for this key
  const set = storage.setItem.bind(storage);
  storage.setItem = (k, v) => { if (k === key && String(v).length > 3000) throw new Error('QuotaExceededError: exceeded the quota'); set(k, v); };
  const store = service.instantStore();
  const big = 'x'.repeat(900);
  const now = Date.now();
  store.set('sold1', { role: 'seller', stage: 'sold', at: now - 3, psbt: big, consignment: big });
  assert.equal(store.get('sold1').consignment, undefined, 'a sold listing keeps no signed data');
  for (const k of ['o1', 'o2']) store.set(k, { role: 'seller', stage: 'ready', at: now, coin: `${k}:1`, psbt: 'p', consignment: big });
  store.set('c1', { role: 'seller', stage: 'cancelled', at: now - 2 });
  // one more open listing that doesn't fit: the finished ones go first, then the largest transfer data
  store.set('o3', { role: 'seller', stage: 'ready', at: now + 1, coin: 'o3:1', psbt: 'p', consignment: big });
  const all = store.all();
  assert.equal(all.o3.stage, 'ready', 'the newest listing is kept whole');
  assert.ok(!all.sold1 && !all.c1, 'finished entries went first');
  assert.ok(Object.values(all).filter((x) => x.resign).length >= 1, 'then an open listing\'s data (signed again if asked)');
  assert.ok(Object.values(all).filter((x) => x.resign).every((x) => x.stage === 'ready'), 'still on sale (the market keeps the signed listing), so its sale is still seen');
  assert.ok(JSON.stringify(all).length <= 3000);
});

test('undo copies of loads stay small, and give their room to listings before any signed listing is dropped', async () => {
  const { BEFORE_LOADS_MAX_CHARS } = await import('../src/rgb/SignetWallet.mjs');
  const big = (t) => ({ format: 'x', ciphertext: t + 'x'.repeat(400_000) });
  const storage = new MemoryStorage();
  const service = new SignetWallet({ loadSdk: async () => ({}), storage });
  for (let k = 1; k <= 5; k++) service.keepBeforeLoad(big(`s${k}`));
  assert.ok(storage.getItem(service.beforeLoadsKey).length <= BEFORE_LOADS_MAX_CHARS, 'kept under the limit');
  assert.equal(service.beforeLoad(0).ciphertext.slice(0, 2), 's5', 'the newest kept');
  // a whole storage of 1,000,000 characters: the undo copy fills most of it
  const quota = new MemoryStorage(); const set = quota.setItem.bind(quota);
  const used = () => { let n = 0; for (const [k, v] of quota.map) n += k.length + v.length; return n; };
  quota.setItem = (k, v) => { const before = quota.getItem(k); if (used() - (before ? k.length + before.length : 0) + k.length + String(v).length > 1_000_000) throw new Error('QuotaExceededError'); set(k, v); };
  const s2 = new SignetWallet({ loadSdk: async () => ({}), storage: quota });
  s2.keepBeforeLoad(big('u1'));
  const store = s2.instantStore();
  const listing = (n) => ({ role: 'seller', stage: 'ready', coin: `${'a'.repeat(64)}:${n}`, psbt: 'p'.repeat(150_000), consignment: 'c'.repeat(150_000), at: n });
  store.set('lot1', listing(1)); store.set('lot2', listing(2));
  assert.ok(store.get('lot1').psbt && store.get('lot2').psbt, 'both signed lots kept');
  assert.equal(s2.beforeLoads().length, 0, 'the undo copy made room');
});
