// MASKED on the RGB 0.11.2 engine (UTEXO rgb-lib-wasm 1.0.0-beta.4 + engine/masked-b4.patch): the calls whose shape
// changed, the upgrade of a wallet the previous engine saved, and Instant purchases posted to the buyer's own
// protocol 1.0 invoice. The engine itself is a stand-in; its Rust side is tested in the patch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiteWallet } from '../src/rgb/LiteWallet.mjs';
import { newSenderKey, sharedKeys, decryptBlob } from '../src/rgb/proxyV1.mjs';

const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
const T = (c) => c.repeat(64);
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OWN_PROXY = 'https://scan.maskedwallet.com/rgb-proxy-v1/json-rpc';

/** A beta.4-shaped engine: goOnline(options), receives take the Online object and an expiry, transfers a filter. */
function fakeV1({ migration = 'none' } = {}) {
  const calls = [];
  const recipient = newSenderKey(new Uint8Array(32).fill(5));
  class WasmWallet {
    static async create(json) { calls.push(['create', JSON.parse(json).dataDir]); return new WasmWallet(); }
    goOnline(options) { calls.push(['goOnline', options]); return Promise.resolve({ id: 1 }); }
    async sync() {}
    async flush() {}
    free() {}
    getAddress() { return 'tb1ptest'; }
    listTransfers(filter, txid) { calls.push(['listTransfers', filter, txid]); return []; }
    listAssets() { return { nia: [], ifa: [] }; }
    async witnessReceive(online, id, a, expires, endpoints, minConf, enc) {
      calls.push(['witnessReceive', online.id, id, a, typeof expires, endpoints, minConf, enc]);
      return { invoice: `rgb:~/~/~/sb:wvout:A8cJ7Ww3?expiry=${expires}&endpoints=rpcs://scan.maskedwallet.com/rgb-proxy-v1/json-rpc&pk=${recipient.pk}`, recipientId: 'sb:wvout:A8cJ7Ww3', expirationTimestamp: BigInt(expires), batchTransferIdx: 1 };
    }
    async blindReceive(online, id, a, expires, endpoints) { calls.push(['blindReceive', online.id, endpoints]); return { invoice: 'rgb:b', recipientId: 'utxob:b' }; }
    async sendBegin(...a) { calls.push(['sendBegin', ...a.slice(1)]); return { psbt: 'psbt-s', batchTransferIdx: 3 }; }
    async sendEnd(o, signed, skip) { calls.push(['sendEnd', signed, skip]); return { txid: T('7'), batchTransferIdx: 3 }; }
    signPsbt(p) { return `signed-${p}`; }
    setPresignedReceives(ids) { calls.push(['setPresignedReceives', ids]); }
    rotateAddress() {}
  }
  class WasmInvoice {
    constructor(s) { this.s = s; }
    invoiceData() {
      if (this.s.includes('old')) return { recipientId: 'utxob:o', network: 'Signet', transportEndpoints: ['rpcs://proxy.iriswallet.com/0.2/json-rpc'], publicKey: null, encryption: 'Required', assignment: 'Any' };
      return { recipientId: 'sb:wvout:A8cJ7Ww3', network: 'Signet', transportEndpoints: ['rpcs://wallet-api-signet.unisat.space/json-rpc'], publicKey: 'ab'.repeat(32), encryption: 'Required', expirationTimestamp: 1900000000n, assignment: 'Any' };
    }
    free() {}
  }
  const lib = {
    WasmWallet, WasmInvoice,
    restoreKeys: () => ({ accountXpubVanilla: 'xv', accountXpubColored: 'xc', masterFingerprint: 'ff' }),
    migrateLegacyWallet: async (json, url) => { calls.push(['migrate', JSON.parse(json).dataDir, url]); return migration; },
  };
  return { lib, calls, recipient };
}
async function open(f) {
  const w = new LiteWallet(f.lib, { network: 'signet', indexerUrl: 'https://mempool.space/signet/api', transportEndpoint: 'https://scan.maskedwallet.com/rgb-proxy/json-rpc', transportFallbacks: ['https://proxy.iriswallet.com/0.2/json-rpc'], transportEndpointV1: OWN_PROXY, mnemonic, dataDir: 'masked_rgb_public_signet_v2' });
  await w.init();
  await w.goOnline();
  return w;
}

test('the RGB 0.11.2 engine: upgrade first, go online with options, protocol 1.0 transfer servers only', async () => {
  const f = fakeV1({ migration: 'migrated' });
  const w = await open(f);
  assert.equal(w.engineV1, true);
  // the saved wallet is upgraded before it is opened, with the block server for old history
  assert.deepEqual(f.calls.slice(0, 2), [['migrate', 'masked_rgb_public_signet_v2', 'https://mempool.space/signet/api'], ['create', 'masked_rgb_public_signet_v2']]);
  assert.equal(w.migration, 'migrated');
  assert.deepEqual(f.calls.find((c) => c[0] === 'goOnline')[1], { indexerConfig: { Esplora: { url: 'https://mempool.space/signet/api' } }, skipConsistencyCheck: true, proxyAuthKeys: {} });
  // invoices list only the 1.0 server (the 0.2 ones can't be used by this engine)
  assert.deepEqual(w.transports, ['rpcs://scan.maskedwallet.com/rgb-proxy-v1/json-rpc']);
  const r = await w.onchainReceive({ amount: 5, durationSeconds: 3600, witness: true });
  const call = f.calls.find((c) => c[0] === 'witnessReceive');
  assert.deepEqual(call, ['witnessReceive', 1, null, { Fungible: 5 }, 'number', ['rpcs://scan.maskedwallet.com/rgb-proxy-v1/json-rpc'], 1, null]);
  assert.match(r.invoice, /pk=/);
  // transfers: by asset, or the ones tied to none yet
  await w.listTransfers(ASSET); await w.listTransfers(null);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'listTransfers').slice(-2).map((c) => c[1]), [{ id: ASSET }, 'noAsset']);
});

test('sending on the 0.11.2 engine: the invoice\'s key, encryption and expiry; ACKs on MASKED\'s own server', async () => {
  const f = fakeV1();
  const w = await open(f);
  const r = await w.onchainSend({ invoice: 'rgb:new', assetId: ASSET, amount: 20, feeRate: 1 });
  assert.equal(r.txid, T('7'));
  const [, map, donation, fee, minConf, expires, sender, lockTime, dryRun] = f.calls.find((c) => c[0] === 'sendBegin');
  assert.deepEqual(map[ASSET][0], { recipientId: 'sb:wvout:A8cJ7Ww3', witnessData: { amountSat: '330', blinding: null }, assignment: { Fungible: 20 }, transportEndpoints: ['rpcs://wallet-api-signet.unisat.space/json-rpc'], publicKey: 'ab'.repeat(32), encryption: 'Required', expirationTimestamp: 1900000000 });
  assert.deepEqual([donation, fee, minConf, expires, sender, lockTime, dryRun], [false, 1n, 1, 1900000000, 'rpcs://scan.maskedwallet.com/rgb-proxy-v1/json-rpc', null, false]);
  assert.deepEqual(f.calls.find((c) => c[0] === 'sendEnd'), ['sendEnd', 'signed-psbt-s', false]);
  // an invoice on the old protocol is refused before anything is built, with the reason
  await assert.rejects(w.onchainSend({ invoice: 'rgb:old', assetId: ASSET, amount: 1, feeRate: 1 }), /old transfer server protocol \(0\.2\)/);
});

test('an Instant purchase on protocol 1.0: posted to the buyer\'s own invoice, matched as a purchase', async () => {
  const f = fakeV1();
  const w = await open(f);
  const posts = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.body instanceof FormData) { const p = JSON.parse(init.body.get('params')); posts.push({ p, file: new Uint8Array(await init.body.get('file').arrayBuffer()) }); return Response.json({ id: 1, result: true }); }
    const body = JSON.parse(init.body);
    if (body.method === 'server.info') return Response.json({ id: body.id, result: { protocol_version: '1.0', current_time: String(Math.floor(Date.now() / 1000)) } });
    if (body.method === 'invoice.check') return Response.json({ id: body.id, result: { [body.params.invoice_ids[0]]: { status: 'available', pow_difficulty: '0' } } });
    return Response.json({ id: body.id, error: { code: -32601 } });
  };
  try {
    const r = await w.onchainReceive({ amount: 5, witness: true });
    const consignment = Uint8Array.from([9, 8, 7]);
    const store = new Map();
    const id = 'of1';
    store.set(id, { role: 'buyer', recipientId: r.recipientId, invoice: r.invoice, txid: T('8'), completed: Buffer.from(consignment).toString('base64'), posted: false });
    w.knowsTx = async () => true;
    const ok = await w.instantPost(id, { get: (k) => store.get(k), set: (k, v) => store.set(k, v) });
    assert.equal(ok, true);
    assert.equal(store.get(id).posted, true);
    // posted to the own server, for the own invoice; the wallet can decrypt it with its invoice key
    assert.equal(posts.length, 1);
    const { p, file } = posts[0];
    const mine = sharedKeys(f.recipient.seed, p.sender_pk);
    assert.deepEqual([...decryptBlob(mine.key, file, p.consignment_hash)], [9, 8, 7]);
    // the engine was told this invoice is a purchase (its seal blinding isn't derived)
    assert.deepEqual(f.calls.filter((c) => c[0] === 'setPresignedReceives').pop(), ['setPresignedReceives', [r.recipientId]]);
  } finally { globalThis.fetch = prevFetch; }
});

test('the new engine without its wallet upgrade never opens (it would start an empty wallet)', async () => {
  const f = fakeV1();
  delete f.lib.migrateLegacyWallet;
  await assert.rejects(open(f), /without its wallet upgrade/);
  assert.equal(f.calls.some((c) => c[0] === 'create'), false);
});
