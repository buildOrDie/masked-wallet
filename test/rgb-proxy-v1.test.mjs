// RGB proxy protocol 1.0: IDs from the spec's own examples, the encryption round trip and chunking, the proof of work,
// and a delivery against a stand-in server that checks what the spec requires.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';
import { invoiceIdOf, transferIdOf, newSenderKey, sharedKeys, encryptBlob, decryptBlob, sha256Hex, leadingZeroBits, proofOfWork, readInvoiceV1, isInvoiceV1, pickEndpoint, deliverConsignment, CHUNK, endpointUrl } from '../src/rgb/proxyV1.mjs';

// the example table of the RGB HTTP JSON-RPC spec (Identifiers)
const INVOICE_PK = '5c298bf4b0dcf967871778ca682b4de838eb7a201853845c49adc15b10681360';
const SENDER_PK = 'e11a179a775712d6763f01de1e10a6141c08f098816aa89a0da333974bf8bc2b';

test('invoice and transfer IDs match the spec examples', () => {
  assert.equal(invoiceIdOf('bc:utxob:4vm1CX2Z-K8hMo59-e7dgGBS-Jka7mYn-Xe~yP85-yUiHHxr-aVlYa', INVOICE_PK), '6ffae5a533bad53bb7ff50152f8a282564fb87429a53384f1b20e88895e7faad');
  assert.equal(transferIdOf('6ffae5a533bad53bb7ff50152f8a282564fb87429a53384f1b20e88895e7faad', SENDER_PK), '285530722532e2fc802c0ad10bd381d3cca23f01af7d89fb03ec55f734a2a3e7');
  assert.equal(invoiceIdOf('bc:wvout:A8cJ7Ww3-NIzADo3-Tzp_5aD-7CTBWmA-AAAAAAA-AAAAAAA-ALSQkcw', INVOICE_PK), '4b4ef334f725afa5b09959a62518a09da375b0708c14f760745c241339b8d54f');
  assert.equal(transferIdOf('4b4ef334f725afa5b09959a62518a09da375b0708c14f760745c241339b8d54f', SENDER_PK), '7ac01c41928a6a114e3320aa4bcbdedb9dd7dd6915fcf993ecd5544fdce1c00f');
});

test('both sides derive the same key and seal blinding; another pair gives another', () => {
  const a = newSenderKey(new Uint8Array(32).fill(1)), b = newSenderKey(new Uint8Array(32).fill(2)), c = newSenderKey(new Uint8Array(32).fill(3));
  const ab = sharedKeys(a.seed, b.pk), ba = sharedKeys(b.seed, a.pk), ac = sharedKeys(a.seed, c.pk);
  assert.equal(bytesToHex(ab.key), bytesToHex(ba.key));
  assert.equal(ab.blinding, ba.blinding);
  assert.ok(ab.blinding < 2n ** 64n);
  assert.notEqual(bytesToHex(ab.key), bytesToHex(ac.key));
  assert.notEqual(ab.blinding, ac.blinding);
  assert.throws(() => sharedKeys(a.seed, 'nope'), /not valid/);
});

test('encrypted files: version byte, 64 KiB chunks with tags, the last one flagged; round trip', () => {
  const key = new Uint8Array(32).fill(9);
  for (const n of [0, 1, CHUNK, CHUNK + 1, 204800]) {
    const plain = new Uint8Array(n).map((_, i) => (i * 31) & 255);
    const h = sha256Hex(plain);
    const blob = encryptBlob(key, plain, h);
    const chunks = Math.max(1, Math.ceil(n / CHUNK));
    assert.equal(blob[0], 1);
    assert.equal(blob.length, 1 + n + 16 * chunks, `size for ${n}`);
    assert.deepEqual(decryptBlob(key, blob, h), plain);
  }
  // the spec's A.7 example: 204800 bytes → 65552, 65552, 65552, 8208
  const blob = encryptBlob(key, new Uint8Array(204800));
  assert.equal(blob.length, 1 + 65552 * 3 + 8208);
  // a flipped byte, or the wrong key, fails
  const plain = utf8ToBytes('consignment'), h = sha256Hex(plain), good = encryptBlob(key, plain, h);
  const bad = good.slice(); bad[5] ^= 1;
  assert.throws(() => decryptBlob(key, bad, h));
  assert.throws(() => decryptBlob(new Uint8Array(32), good, h));
});

test('proof of work: the nonce gives the leading zero bits asked for', async () => {
  assert.equal(leadingZeroBits(Uint8Array.of(0, 0, 0x10)), 19);
  assert.equal(leadingZeroBits(Uint8Array.of(0x80)), 0);
  const tid = 'ab'.repeat(32), ts = '1791367210';
  const nonce = await proofOfWork(tid, ts, 12);
  assert.ok(leadingZeroBits(sha256(utf8ToBytes(tid + ts + nonce))) >= 12);
  assert.equal(await proofOfWork(tid, ts, 0), '0');
  await assert.rejects(proofOfWork(tid, ts, 30), /more proof of work/);
});

test('reading a 1.0 invoice: beneficiary as written, pk, enc, expiry, endpoints', () => {
  const inv = `rgb:~/~/3/sb:wvout:A8cJ7Ww3-NIzADo3-Tzp_5aD?expiry=1791400000&endpoints=rpcs://wallet-api-signet.unisat.space/json-rpc,rpcs://b.example/json-rpc&pk=${INVOICE_PK}&enc=1`;
  const r = readInvoiceV1(inv);
  assert.equal(r.beneficiary, 'sb:wvout:A8cJ7Ww3-NIzADo3-Tzp_5aD');
  assert.equal(r.pk, INVOICE_PK); assert.equal(r.enc, '1'); assert.equal(r.expiry, 1791400000);
  assert.deepEqual(r.endpoints, ['rpcs://wallet-api-signet.unisat.space/json-rpc', 'rpcs://b.example/json-rpc']);
  assert.equal(isInvoiceV1(inv), true);
  assert.equal(isInvoiceV1('rgb:~/~/3/sb:wvout:X?expiry=1&endpoints=rpcs://proxy.iriswallet.com/0.2/json-rpc'), false);
  assert.equal(endpointUrl('rpcs://a.b/json-rpc'), 'https://a.b/json-rpc');
});

/** A stand-in 1.0 recipient server that applies the spec's checks to consignment.post. */
function fakeServer({ difficulty = 0, version = '1.0', status = 'available', draftSignature = false } = {}) {
  const posts = [];
  const fetchFn = async (url, init) => {
    if (init.body instanceof FormData) {
      const f = init.body;
      const keys = [...f.keys()];
      assert.ok(keys.indexOf('params') < keys.indexOf('file'), 'params come before the file');
      const params = JSON.parse(f.get('params'));
      const file = new Uint8Array(await f.get('file').arrayBuffer());
      assert.equal(Number(params.file_size), file.length);
      assert.equal(params.transfer_id, transferIdOf(params.invoice_id, params.sender_pk), 'transfer ID derived from invoice ID and sender key');
      // the spec signs "… consignment"; the earlier draft (UniSat's server) without the literal
      const msg = sha256(utf8ToBytes(params.transfer_id + params.consignment_hash + sha256Hex(file) + (draftSignature ? '' : 'consignment')));
      if (!ed25519.verify(hexToBytes(params.signature), msg, hexToBytes(params.sender_pk))) return Response.json({ id: 1, error: { code: -502, message: 'Invalid endpoint auth signature' } });
      if (difficulty && leadingZeroBits(sha256(utf8ToBytes(params.transfer_id + params.pow_timestamp + params.pow_nonce))) < difficulty) return Response.json({ id: 1, error: { code: -114, message: 'invalid proof of work', data: { difficulty } } });
      posts.push({ params, file });
      return Response.json({ id: 1, result: true });
    }
    const body = JSON.parse(init.body);
    if (body.method === 'server.info') return Response.json({ id: body.id, result: { protocol_version: version, current_time: '1791367210', max_expiry_secs: '86400' } });
    if (body.method === 'invoice.check') return Response.json({ id: body.id, result: { [body.params.invoice_ids[0]]: { status, pow_difficulty: String(difficulty) } } });
    return Response.json({ id: body.id, error: { code: -32601 } });
  };
  return { posts, fetchFn };
}

test('delivering a donation: the recipient can decrypt it with its own key, and the IDs line up', async () => {
  const recipient = newSenderKey(new Uint8Array(32).fill(7));
  const inv = readInvoiceV1(`rgb:~/~/3/sb:wvout:A8cJ7Ww3?expiry=1791400000&endpoints=rpcs://r.example/json-rpc&pk=${recipient.pk}`);
  const s = fakeServer({ difficulty: 10 });
  const iid = invoiceIdOf(inv.beneficiary, inv.pk);
  const picked = await pickEndpoint(inv.endpoints, iid, s.fetchFn);
  assert.equal(picked.difficulty, 10);
  const sender = newSenderKey();
  const { key, blinding } = sharedKeys(sender.seed, inv.pk);
  const consignment = new Uint8Array(150000).map((_, i) => i & 255);
  const out = await deliverConsignment({ invoice: inv, picked, sender, key, consignment }, s.fetchFn);
  assert.equal(out.created, true);
  const [{ params, file }] = s.posts;
  assert.equal(params.sender_transport_endpoint, 'rpcs://r.example/json-rpc');
  assert.equal(params.batch, false);
  // the recipient's side: same key and blinding from its own seed and the sender's pubkey
  const r = sharedKeys(recipient.seed, params.sender_pk);
  assert.equal(r.blinding, blinding);
  assert.deepEqual(decryptBlob(r.key, file, params.consignment_hash), consignment);
  // enc=0: plaintext
  const s0 = fakeServer();
  const inv0 = { ...inv, enc: '0' };
  await deliverConsignment({ invoice: inv0, picked: await pickEndpoint(inv0.endpoints, iid, s0.fetchFn), sender, key, consignment }, s0.fetchFn);
  assert.deepEqual(s0.posts[0].file, consignment);
});

test('picking a server: refuses 0.2-only, full and unknown invoices with the reason', async () => {
  await assert.rejects(pickEndpoint(['rpcs://a/json-rpc'], 'x', fakeServer({ version: '0.2' }).fetchFn), /doesn't speak protocol 1.0/);
  await assert.rejects(pickEndpoint(['rpcs://a/json-rpc'], 'x', fakeServer({ status: 'full' }).fetchFn), /already paid/);
  await assert.rejects(pickEndpoint(['rpcs://a/json-rpc'], 'x', fakeServer({ status: 'unknown' }).fetchFn), /doesn't know this invoice/);
});

test('matches the Rust reference (dalek + RustCrypto, as in UTEXO rgb-lib-wasm encryption.rs) byte for byte', () => {
  // made by scratch Rust code mirroring UTEXO's derive_shared / encrypt_stream, seeds 0x01…01 and 0x02…02
  const ref = { pkA: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c', pkB: '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394', key: 'aca1c4fe115e44291c4b4a8246bbc662567b638b45bb432f570a611e63ca1393', blinding: 14951201901396494435n, blobSha: 'fc2f51e4828ea88fe893913cd92f9a96b2c885f390bd6c1f4959aacf2435c7c6', blobLen: 150049, sig: '549f9c5bf83739824f6cb864e2838f530407c1d3d7585d155ba815016f067c6cff7254c73372b7e8ab0653a0b732b7b378531ec912d8193a54b0676500179a03' };
  const a = newSenderKey(new Uint8Array(32).fill(1)), b = newSenderKey(new Uint8Array(32).fill(2));
  assert.equal(a.pk, ref.pkA); assert.equal(b.pk, ref.pkB);
  const { key, blinding } = sharedKeys(a.seed, b.pk);
  assert.equal(bytesToHex(key), ref.key);
  assert.equal(blinding, ref.blinding);
  const plain = new Uint8Array(150000).map((_, i) => (i * 31) % 256);
  const blob = encryptBlob(key, plain);
  assert.equal(blob.length, ref.blobLen);
  assert.equal(sha256Hex(blob), ref.blobSha);
  assert.equal(bytesToHex(ed25519.sign(sha256(utf8ToBytes('tid-hash-blob-consignment')), a.seed)), ref.sig);
});

test('wallet: pays a 1.0 invoice as a donation — blinding from the keys, no 0.2 server, upload before broadcast', async () => {
  const { LiteWallet } = await import('../src/rgb/LiteWallet.mjs');
  const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
  const T = (c) => c.repeat(64);
  const recipient = newSenderKey(new Uint8Array(32).fill(7));
  const invoice = `rgb:${ASSET}/~/500/sb:wvout:A8cJ7Ww3?expiry=${Math.floor(Date.now() / 1000) + 3600}&endpoints=rpcs://r.example/json-rpc&pk=${recipient.pk}`;
  const order = [];
  const server = fakeServer();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://r.example')) { if (init.body instanceof FormData) order.push('upload'); return server.fetchFn(url, init); }
    throw new Error(`unexpected ${u}`);
  };
  const lib = {
    WasmWallet: {
      newSwapPsbt: (ins, outs) => JSON.stringify({ ins: ins.map((i) => i.outpoint), outs }), psbtTxid: () => T('5'),
      witnessSealScript: () => '5120' + '33'.repeat(32), completePresignedConsignment: (bytes, txid, txHex) => Uint8Array.from([...bytes, 0xee]),
    },
    WasmInvoice: class { invoiceData() { return { recipientId: 'sb:wvout:A8cJ7Ww3', network: 'Signet', transportEndpoints: ['rpcs://r.example/json-rpc'], assignment: { Fungible: 500 } }; } free() {} },
  };
  const w = new LiteWallet(lib, { network: 'signet', indexerUrl: 'https://esplora.test', transportEndpoint: 'https://proxy.iriswallet.com/0.2/json-rpc', mnemonic: 'x', dataDir: 'd' });
  let colored;
  w.w = {
    sync: async () => {}, flush: async () => {},
    listUnspents: () => [{ utxo: { colorable: true, outpoint: { txid: T('a'), vout: 0 }, btcAmount: 1000 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: 800 } }] }],
    listUnspentsVanilla: async () => [{ outpoint: `${T('c')}:1`, txout: { value: 5000 }, is_spent: false }],
    // the protocol-1.0 engine: colorSwap takes the blinding as its 10th argument
    colorSwap: async function (online, psbt, assetId, amount, rid, vout, sealSats, endpoints, minConf, blinding) { colored = { rid, vout, sealSats, endpoints, blinding, amount: String(amount) }; return psbt; },
    signPsbt: (p) => p, pendingConsignment: () => [1, 2, 3],
    sendEnd: async (online, psbt, donation) => { order.push(`broadcast:${donation}`); return { txid: T('5') }; },
  };
  w.online = {}; w.ownScript = async () => '5120' + '44'.repeat(32); w.extractHex = () => '02000000';
  w.outpointInfo = async (op) => ({ sats: op.startsWith(T('a')) ? 1000 : 5000, script: '5120' + '55'.repeat(32), tx: 'aa' });
  assert.equal(w.canProxyV1, true);
  const r = await w.onchainSend({ invoice, assetId: ASSET, amount: 500, feeRate: 1 });
  assert.equal(r.protocol, '1.0');
  assert.deepEqual(order, ['upload', 'broadcast:true'], 'uploaded before broadcasting, as a donation');
  assert.deepEqual(colored.endpoints, [], 'no 0.2 server');
  assert.equal(colored.vout, 1); assert.equal(colored.amount, '500');
  // the recipient derives the same blinding from the sender key it gets with the upload
  const { params, file } = server.posts[0];
  const mine = sharedKeys(recipient.seed, params.sender_pk);
  assert.equal(colored.blinding, mine.blinding);
  assert.deepEqual([...decryptBlob(mine.key, file, params.consignment_hash)], [1, 2, 3, 0xee], 'the consignment with the signed transaction');
  // an engine without the blinding argument is refused before anything happens
  w.w.colorSwap = async (a, b, c, d, e, f, g, h, i) => i;
  assert.equal(w.canProxyV1, false);
  await assert.rejects(w.onchainSend({ invoice, assetId: ASSET, amount: 500, feeRate: 1 }), /Update MASKED/);
});

test('a server on the earlier draft (no "consignment" in the signed message) accepts the second form', async () => {
  const recipient = newSenderKey(new Uint8Array(32).fill(7));
  const inv = readInvoiceV1(`rgb:~/~/3/sb:wvout:A8cJ7Ww3?expiry=1791400000&endpoints=rpcs://r.example/json-rpc&pk=${recipient.pk}`);
  const s = fakeServer({ draftSignature: true });
  const picked = await pickEndpoint(inv.endpoints, invoiceIdOf(inv.beneficiary, inv.pk), s.fetchFn);
  const sender = newSenderKey();
  const out = await deliverConsignment({ invoice: inv, picked, sender, key: sharedKeys(sender.seed, inv.pk).key, consignment: utf8ToBytes('c') }, s.fetchFn);
  assert.equal(out.created, true);
  assert.equal(s.posts.length, 1);
});

test('wallet: a failed upload drops the colouring and never broadcasts', async () => {
  const { LiteWallet } = await import('../src/rgb/LiteWallet.mjs');
  const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
  const T = (c) => c.repeat(64);
  const recipient = newSenderKey(new Uint8Array(32).fill(7));
  const invoice = `rgb:${ASSET}/~/500/sb:wvout:A8cJ7Ww3?expiry=${Math.floor(Date.now() / 1000) + 3600}&endpoints=rpcs://r.example/json-rpc&pk=${recipient.pk}`;
  const server = fakeServer();
  globalThis.fetch = async (url, init = {}) => (init.body instanceof FormData ? Response.json({ id: 1, error: { code: -112, message: 'Invoice quota exceeded' } }) : server.fetchFn(url, init));
  const lib = { WasmWallet: { newSwapPsbt: () => '{}', psbtTxid: () => T('5'), witnessSealScript: () => '5120' + '33'.repeat(32), completePresignedConsignment: (b) => b }, WasmInvoice: class { invoiceData() { return { recipientId: 'sb:wvout:A8cJ7Ww3', network: 'Signet', transportEndpoints: [] }; } free() {} } };
  const w = new LiteWallet(lib, { network: 'signet', indexerUrl: 'https://esplora.test', transportEndpoint: 'https://p', mnemonic: 'x', dataDir: 'd' });
  const log = [];
  w.w = { sync: async () => {}, flush: async () => {}, listUnspents: () => [{ utxo: { colorable: true, outpoint: { txid: T('a'), vout: 0 }, btcAmount: 1000 }, rgbAllocations: [{ assetId: ASSET, settled: true, assignment: { Fungible: 800 } }] }],
    listUnspentsVanilla: async () => [{ outpoint: `${T('c')}:1`, txout: { value: 5000 }, is_spent: false }],
    colorSwap: async function (a, psbt, c, d, e, f, g, h, i, blinding) { return psbt; }, signPsbt: (p) => p, pendingConsignment: () => [1],
    abandonColoring: (txid) => log.push(['abandon', txid]), sendEnd: async () => { log.push(['broadcast']); return {}; } };
  w.online = {}; w.ownScript = async () => '5120' + '44'.repeat(32); w.extractHex = () => '02';
  w.outpointInfo = async () => ({ sats: 5000, script: '5120' + '55'.repeat(32), tx: 'aa' });
  await assert.rejects(w.onchainSend({ invoice, assetId: ASSET, amount: 500, feeRate: 1 }), /quota exceeded/);
  assert.deepEqual(log, [['abandon', T('5')]]);
});
