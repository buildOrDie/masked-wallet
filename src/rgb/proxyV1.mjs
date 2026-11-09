// RGB proxy protocol 1.0 (RGB Tools "RGB HTTP JSON-RPC" v1.0), the sender side MASKED needs to pay an invoice whose
// transfer server speaks 1.0 (UniSat's, for one). MASKED sends these as donations: the consignment carries the signed
// transaction, MASKED uploads it to the recipient's server and then broadcasts, so no sender server or ACK is needed.
//
// What 1.0 adds over 0.2: each invoice has an Ed25519 key (`pk` in the invoice); the sender makes a fresh key per
// transfer; both derive a shared key (X25519 of the converted keys, HKDF-SHA-256) that encrypts the consignment
// (XChaCha20-Poly1305 in 64 KiB chunks) and sets the blinding of the recipient's witness seal; uploads are signed
// and may need a small proof of work.
import { ed25519, edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { extract, expand } from '@noble/hashes/hkdf';
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from '@noble/hashes/utils';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export const PROXY_V1 = '1.0';
export const ENC_VERSION = 0x01;
export const CHUNK = 65536;
const INFO_ENC = 'rgb-proxy-server/enc/v1';
const INFO_BLINDING = 'rgb-proxy-server/enc/v1/seal-blinding';
/** The most proof of work MASKED computes (the spec recommends servers stay at or under 24 bits). */
export const MAX_POW_BITS = 24;

const sha256Hex = (data) => bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
export { sha256Hex };

/** invoice ID = SHA-256("rgb-proxy-server/invoice/v1" ‖ beneficiary string ‖ invoice pubkey), hex. */
export const invoiceIdOf = (beneficiary, invoicePk) => sha256Hex(`rgb-proxy-server/invoice/v1${beneficiary}${invoicePk}`);
/** transfer ID = SHA-256("rgb-proxy-server/transfer/v1" ‖ invoice ID ‖ sender pubkey), hex. */
export const transferIdOf = (invoiceId, senderPk) => sha256Hex(`rgb-proxy-server/transfer/v1${invoiceId}${senderPk}`);

/** A fresh Ed25519 key pair for one transfer: { seed (32 bytes, never sent), pk (hex) }. */
export function newSenderKey(seed = randomBytes(32)) {
  return { seed, pk: bytesToHex(ed25519.getPublicKey(seed)) };
}

/**
 * The keys both sides derive: the symmetric `key` (32 bytes) and the witness seal `blinding` (u64, BigInt).
 * @param {Uint8Array} mySeed my Ed25519 seed @param {string} theirPk their Ed25519 pubkey, hex
 */
export function sharedKeys(mySeed, theirPk) {
  if (!/^[0-9a-f]{64}$/.test(String(theirPk))) throw new Error('The invoice key is not valid.');
  const shared = x25519.getSharedSecret(edwardsToMontgomeryPriv(mySeed), edwardsToMontgomeryPub(hexToBytes(theirPk)));
  const prk = extract(sha256, shared, new Uint8Array(0));
  const key = expand(sha256, prk, utf8ToBytes(INFO_ENC), 32);
  const b = expand(sha256, prk, utf8ToBytes(INFO_BLINDING), 8);
  let blinding = 0n;
  for (let i = 7; i >= 0; i--) blinding = (blinding << 8n) | BigInt(b[i]); // u64 little-endian
  return { key, blinding };
}

/** The 24-byte nonce of chunk `counter`: last 19 bytes of the plaintext's SHA-256, u32 BE counter, final flag. */
export function chunkNonce(plainHashHex, counter, last) {
  const n = new Uint8Array(24);
  n.set(hexToBytes(plainHashHex).slice(13), 0);
  new DataView(n.buffer).setUint32(19, counter, false);
  n[23] = last ? 1 : 0;
  return n;
}

/** Encrypt a file for the counterpart: version byte 0x01, then each 64 KiB chunk sealed with its 16-byte tag. */
export function encryptBlob(key, plain, plainHashHex = sha256Hex(plain)) {
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  const parts = [Uint8Array.of(ENC_VERSION)];
  for (let i = 0; i < count; i++) {
    const chunk = plain.subarray(i * CHUNK, Math.min(plain.length, (i + 1) * CHUNK));
    parts.push(xchacha20poly1305(key, chunkNonce(plainHashHex, i, i === count - 1)).encrypt(chunk));
  }
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The reverse (used in tests, and to check a file before uploading it). */
export function decryptBlob(key, blob, plainHashHex) {
  if (blob[0] !== ENC_VERSION) throw new Error('Unknown encryption version.');
  const body = blob.subarray(1), size = CHUNK + 16;
  const count = Math.max(1, Math.ceil(body.length / size));
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(xchacha20poly1305(key, chunkNonce(plainHashHex, i, i === count - 1)).decrypt(body.subarray(i * size, (i + 1) * size)));
  const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  if (sha256Hex(out) !== plainHashHex) throw new Error('The file does not match its hash.');
  return out;
}

/** Leading zero bits of a digest, from the most significant bit of the first byte. */
export function leadingZeroBits(d) {
  let n = 0;
  for (const b of d) { if (b === 0) { n += 8; continue; } n += Math.clz32(b) - 24; break; }
  return n;
}

/** A proof of work: a nonce so that SHA-256(transfer ID ‖ timestamp ‖ nonce) starts with `bits` zero bits. */
export async function proofOfWork(transferId, timestamp, bits) {
  if (bits > MAX_POW_BITS) throw new Error('The transfer server asks for more proof of work than MASKED computes. Try again later.');
  if (bits <= 0) return '0';
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (leadingZeroBits(sha256(utf8ToBytes(`${transferId}${timestamp}${nonce}`))) >= bits) return nonce;
    if (i % 20000 === 19999) await new Promise((r) => setTimeout(r, 0)); // keep the window responsive
  }
}

/** An Ed25519 signature (hex) of SHA-256 of the concatenated fields. */
export const signFields = (seed, ...fields) => bytesToHex(ed25519.sign(sha256(utf8ToBytes(fields.join(''))), seed));

/**
 * The parts of a 1.0 invoice the sender needs, read from the invoice text: the beneficiary string exactly as written
 * (the recipient computed its invoice ID from it), `pk`, `enc`, the expiry and the transport endpoints.
 */
export function readInvoiceV1(invoice) {
  const s = String(invoice || '').trim();
  const [path, query = ''] = s.split('?');
  const beneficiary = path.split('/').pop() || '';
  const params = new URLSearchParams(query);
  const pk = params.get('pk') || '';
  const expiry = Number(params.get('expiry') ?? params.get('expirationTimestamp') ?? NaN);
  const enc = params.get('enc'); // missing: must encrypt; '0': must not; '1': may (MASKED encrypts)
  const endpoints = params.getAll('endpoints').flatMap((e) => e.split(',')).map((e) => e.trim()).filter(Boolean);
  return { beneficiary, pk, expiry: Number.isFinite(expiry) ? expiry : null, enc, endpoints };
}
/** A 1.0 invoice: it carries the recipient's key. */
export const isInvoiceV1 = (invoice) => /^[0-9a-f]{64}$/.test(readInvoiceV1(invoice).pk);

/** "rpcs://host/path" (RgbTransport form) → "https://host/path". */
export const endpointUrl = (e) => String(e).replace(/^rpcs:\/\//, 'https://').replace(/^rpc:\/\//, 'http://');

let rpcId = 0;
/** One JSON-RPC call (never batched). */
export async function rpc(url, method, params = {}, fetchFn = fetch) {
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), credentials: 'omit', cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Transfer server: no answer to ${method} (${r.status}).`);
  return j;
}

/** consignment.post: the JSON-RPC fields as form fields, `params` JSON-encoded, then the file. */
export async function postConsignment(url, params, file, fetchFn = fetch) {
  const form = new FormData();
  form.append('jsonrpc', '2.0');
  form.append('id', String(++rpcId));
  form.append('method', 'consignment.post');
  form.append('params', JSON.stringify(params));
  form.append('file', new Blob([file], { type: 'application/octet-stream' }), 'consignment.rgb');
  const r = await fetchFn(url, { method: 'POST', body: form, credentials: 'omit', cache: 'no-store' });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error(`Transfer server: no answer to consignment.post (${r.status}).`);
  return j;
}

/**
 * Find an endpoint of the invoice that speaks 1.0 and can take a transfer: { endpoint, url, info, difficulty }.
 * Throws the reason when none can.
 */
export async function pickEndpoint(endpoints, invoiceId, fetchFn = fetch) {
  let why = 'The invoice lists no transfer server.';
  for (const e of endpoints) {
    const url = endpointUrl(e);
    try {
      const info = await rpc(url, 'server.info', {}, fetchFn);
      if (info.result?.protocol_version !== PROXY_V1) { why = `${new URL(url).host} doesn't speak protocol 1.0.`; continue; }
      const c = await rpc(url, 'invoice.check', { invoice_ids: [invoiceId] }, fetchFn);
      const st = c.result?.[invoiceId];
      if (st?.status !== 'available') { why = st?.status === 'full' ? 'This invoice was already paid.' : 'The transfer server doesn\'t know this invoice (expired or never reserved). Ask for a new one.'; continue; }
      return { endpoint: e, url, info: info.result, difficulty: Number(st.pow_difficulty || 0) };
    } catch (err) { why = `Could not reach ${e}: ${err?.message || err}`; }
  }
  throw new Error(why);
}

/**
 * Upload a donation's consignment (which already contains the signed transaction) for the invoice.
 * @param {{ invoice: ReturnType<typeof readInvoiceV1>, picked: Awaited<ReturnType<typeof pickEndpoint>>, sender: ReturnType<typeof newSenderKey>, key: Uint8Array, consignment: Uint8Array }} p
 * @returns {Promise<{ transferId: string, consignmentHash: string, created: boolean }>}
 */
export async function deliverConsignment({ invoice, picked, sender, key, consignment }, fetchFn = fetch) {
  if (invoice.enc != null && !['0', '1'].includes(invoice.enc)) throw new Error('The invoice asks for an encryption mode MASKED doesn\'t know.');
  const invoiceId = invoiceIdOf(invoice.beneficiary, invoice.pk);
  const transferId = transferIdOf(invoiceId, sender.pk);
  const consignmentHash = sha256Hex(consignment);
  const file = invoice.enc === '0' ? consignment : encryptBlob(key, consignment, consignmentHash);
  const blobHash = sha256Hex(file);
  let difficulty = picked.difficulty;
  // The signed message: the current spec ends it with the literal "consignment"; servers built on the earlier
  // draft (UniSat's, for one) sign without it. Try the spec's, then the draft's if the signature is refused (-502).
  const forms = [[transferId, consignmentHash, blobHash, 'consignment'], [transferId, consignmentHash, blobHash]];
  let form = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const powTimestamp = String(Number(picked.info?.current_time) || Math.floor(Date.now() / 1000));
    const powNonce = await proofOfWork(transferId, powTimestamp, difficulty);
    const params = {
      invoice_id: invoiceId, transfer_id: transferId, sender_transport_endpoint: picked.endpoint, sender_pk: sender.pk,
      consignment_hash: consignmentHash, batch: false, file_size: String(file.length),
      signature: signFields(sender.seed, ...forms[form]),
      pow_timestamp: powTimestamp, pow_nonce: powNonce,
    };
    const r = await postConsignment(picked.url, params, file, fetchFn);
    if (!r.error) return { transferId, consignmentHash, created: r.result !== false };
    if (r.error.code === -502 && form === 0) { form = 1; continue; }
    // proof of work refused (difficulty rose, or the clock moved): retry with the difficulty it now asks for
    if (r.error.code === -114) { difficulty = Number(r.error.data?.difficulty ?? r.error.data?.pow_difficulty ?? difficulty + 1); picked = { ...picked, info: { ...picked.info, current_time: undefined } }; continue; }
    throw new Error(`Transfer server refused the transfer: ${r.error.message || r.error.code}`);
  }
  throw new Error('The transfer server kept refusing the proof of work. Try again later.');
}
