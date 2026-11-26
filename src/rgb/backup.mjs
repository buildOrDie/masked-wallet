import { Vault, PBKDF2_ITER } from '../wallet/Vault.mjs';
import { enc, dec } from '../core/bytes.mjs';
import { b64, unb64 } from './bytes.mjs';
const FORMAT = 'masked-rgb-signet';
/**
 * @param {object} payload @param {string} password @param {string} [network] RGB profile id
 * @param {{ salt?: Uint8Array, key?: CryptoKey }} [cache] the open wallet's: its first backup derives the key (600,000
 *   rounds, about a second), the next ones reuse it with a fresh IV each time
 */
export async function encryptRgb(payload, password, network = 'utexo', cache = undefined) {
  if (password.length < 12) throw new Error('Use at least 12 characters for the test-wallet password.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = cache?.key && cache.salt ? cache.salt : crypto.getRandomValues(new Uint8Array(16));
  const key = cache?.key && cache.salt ? cache.key : await Vault.deriveKey(password, salt);
  if (cache && !cache.key) Object.assign(cache, { salt, key });
  const data = enc.encode(JSON.stringify({ ...payload, network }));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { format: FORMAT, version: 1, iterations: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}
/** @param {any} envelope @param {string} password @param {string} [network] RGB profile id */
export async function decryptRgb(envelope, password, network = 'utexo') {
  if (envelope?.format !== FORMAT || envelope.version !== 1 || envelope.iterations !== PBKDF2_ITER) throw new Error('Not a supported MASKED RGB Signet backup.');
  try {
    const key = await Vault.deriveKey(password, unb64(envelope.salt), envelope.iterations);
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, key, unb64(envelope.ciphertext));
    const payload = JSON.parse(dec.decode(data));
    if (payload.network !== network || typeof payload.mnemonic !== 'string') throw new Error('Wrong network or missing test-wallet keys.');
    return payload;
  } catch { throw new Error('Incorrect password, wrong RGB network, or damaged RGB backup.'); }
}
