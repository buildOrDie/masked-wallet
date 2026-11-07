// Encrypted cloud backup for RGB on mainnet.
//
// What leaves the browser is the RGB backup MASKED already makes (encrypted with a key from the recovery phrase),
// encrypted a second time with a cloud key, padded to a fixed size and signed. The server stores opaque bytes under
// a random-looking ID; it never sees the phrase, the keys, the tokens or the addresses.
//
// Keys, all from the recovery phrase (and passphrase) on their own path, never MASKED's coin keys:
//   material = SHA-256("MASKED/rgb-cloud/v1\n" + words + "\n" + passphrase)
//   encKey   = HMAC-SHA256(material, "enc")    AES-256-GCM
//   signKey  = HMAC-SHA256(material, "sign")   BIP340 Schnorr (secp256k1)
//   id       = x-only public key of signKey    (the storage name; the server checks signatures against it)
// Every upload has a version that only goes up. The server refuses an older or equal version, so it can't be
// replaced by a replay; the browser refuses a version older than the last one it saved or restored, and the
// version is bound into the encryption (AAD), so the server can't relabel an old backup as new.
import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, concatBytes } from '@noble/hashes/utils';
import { b64, unb64 } from './bytes.mjs';

export const CLOUD_URL = 'https://scan.maskedwallet.com/rgb-vault/v1/backup/';
export const CLOUD_KEY = 'masked.rgb.cloud'; // '0' = switched off; anything else = on (the default)
const DOMAIN = 'MASKED rgb cloud v1';
const te = new TextEncoder(), td = new TextDecoder();
/** Padded sizes: the server learns only roughly how big a backup is. */
const BUCKETS = [64, 256, 1024, 2048, 4096, 8192, 16384].map((k) => k * 1024);
export const CLOUD_MAX = BUCKETS[BUCKETS.length - 1] - 4;

/** @param {{ words: string, passphrase?: string }} secret */
export async function cloudKeys(secret) {
  if (!secret?.words) throw new Error('Unlock your wallet first.');
  const material = sha256(te.encode(`MASKED/rgb-cloud/v1\n${secret.words}\n${secret.passphrase || ''}`));
  const signKey = hmac(sha256, material, te.encode('sign'));
  const id = bytesToHex(schnorr.getPublicKey(signKey));
  const encKey = await crypto.subtle.importKey('raw', hmac(sha256, material, te.encode('enc')), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, signKey, encKey };
}

const putMessage = (id, version, iv, data) => sha256(te.encode(`${DOMAIN}\nPUT\n${id}\n${version}\n${bytesToHex(sha256(concatBytes(iv, data)))}`));
const deleteMessage = (id, at) => sha256(te.encode(`${DOMAIN}\nDELETE\n${id}\n${at}`));
const aad = (id, version) => te.encode(`${DOMAIN}|${id}|${version}`);

export function pad(bytes) {
  const size = BUCKETS.find((b) => b >= bytes.length + 4);
  if (!size) throw new Error('This RGB backup is too large for the cloud. Save a backup file instead.');
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}
export function unpad(bytes) {
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (n > bytes.length - 4) throw new Error('Damaged cloud backup.');
  return bytes.slice(4, 4 + n);
}

/** Seal a backup envelope (the object SignetWallet.backup() returns) for upload. */
export async function seal(keys, envelope, version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Bad cloud backup version.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(keys.id, version) }, keys.encKey, pad(te.encode(JSON.stringify(envelope)))));
  const sig = schnorr.sign(putMessage(keys.id, version, iv, data), keys.signKey);
  return { v: 1, version, iv: b64(iv), data: b64(data), sig: bytesToHex(sig) };
}

/** Check and open what the server returned. Throws if it isn't ours, was changed, or is older than `minVersion`. */
export async function open(keys, body, minVersion = 0) {
  if (body?.v !== 1 || !Number.isSafeInteger(body.version) || body.version < 1) throw new Error('Not a MASKED RGB cloud backup.');
  if (body.version < minVersion) throw new Error('The cloud returned an older RGB backup than this browser last saved. Not restored.');
  const iv = unb64(body.iv), data = unb64(body.data);
  if (!schnorr.verify(body.sig, putMessage(keys.id, body.version, iv, data), keys.id)) throw new Error('The cloud backup signature does not match this wallet. Not restored.');
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(keys.id, body.version) }, keys.encKey, data); } catch { throw new Error('The cloud backup could not be decrypted with this wallet.'); }
  return JSON.parse(td.decode(unpad(new Uint8Array(plain))));
}

export class CloudError extends Error {
  constructor(message, status = 0, latest = 0) { super(message); this.status = status; this.latest = latest; }
}

/** The small HTTP client. `fetchFn` and `base` are swappable for tests. */
export class RgbCloud {
  constructor({ fetchFn = (url, init) => globalThis.fetch(url, init), base = CLOUD_URL, timeout = 20000 } = {}) {
    this.fetchFn = fetchFn; this.base = base; this.timeout = timeout;
  }
  async call(method, id, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeout);
    try {
      const res = await this.fetchFn(this.base + id, { method, signal: ctl.signal, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    } catch { throw new CloudError('Could not reach the MASKED backup server.'); }
    finally { clearTimeout(t); }
  }
  /** @returns {Promise<any|null>} the latest stored backup body, or null if there is none */
  async latest(id) {
    const { status, json } = await this.call('GET', id);
    if (status === 404) return null;
    if (status !== 200) throw new CloudError(json?.error || `Backup server error (${status}).`, status);
    return json;
  }
  async put(id, sealed) {
    const { status, json } = await this.call('PUT', id, sealed);
    if (status === 409) throw new CloudError('A newer RGB cloud backup was saved from another browser.', 409, Number(json?.latest) || 0);
    if (status !== 200 && status !== 201) throw new CloudError(json?.error || `Backup server error (${status}).`, status);
    return json;
  }
  /** Delete every stored version (signed, timestamped). */
  async remove(keys) {
    const at = Date.now();
    const sig = bytesToHex(schnorr.sign(deleteMessage(keys.id, at), keys.signKey));
    const { status, json } = await this.call('DELETE', keys.id, { at, sig });
    if (status !== 200 && status !== 404) throw new CloudError(json?.error || `Backup server error (${status}).`, status);
  }
}
export const _msg = { putMessage, deleteMessage };
