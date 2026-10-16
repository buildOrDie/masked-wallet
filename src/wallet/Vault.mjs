// The password-encrypted recovery phrase, and the session that keeps the wallet unlocked.
//   disk:    localStorage['wren.vault'] = { v, kdf, iter, salt, iv, ct }  (AES-256-GCM, PBKDF2-SHA256)
//   session: chrome.storage.session['masked.session'] (RAM only, cleared on browser exit) while unlocked
import { b64, dec, enc, unb64 } from '../core/bytes.mjs';

const VAULT_KEY = 'wren.vault';
const LEGACY_KEY = 'wren.localWallet';
const SESSION_KEY = 'masked.session';
const AUTOLOCK_KEY = 'wren.autolock';
export const PBKDF2_ITER = 600000;

export class Vault {
  constructor(store) { this.store = store; }

  /** The sealed vault, or null when this device has none. */
  read() { return this.store.getJson(VAULT_KEY, null); }

  /** A plaintext wallet from versions before the vault (migrated on first open). */
  readLegacy() { const s = this.store.getJson(LEGACY_KEY, null); return s?.words ? s : null; }

  static async deriveKey(password, salt, iter = PBKDF2_ITER) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** Encrypt the secret ({ words, passphrase, fresh, restored, birthday }) with a password. */
  async seal(secret, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await Vault.deriveKey(password, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secret))));
    localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
    localStorage.removeItem(LEGACY_KEY); // never keep a plaintext copy
  }

  async open(password) {
    const v = this.read();
    if (!v) throw new Error('No wallet found.');
    const key = await Vault.deriveKey(password, unb64(v.salt), v.iter);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct));
      return JSON.parse(dec.decode(pt));
    } catch { throw new Error('Wrong password.'); }
  }

  static checkNewPassword(p1, p2) {
    if (String(p1 || '').length < 8) throw new Error('Use at least 8 characters for your password.');
    if (p1 !== p2) throw new Error('The two passwords do not match.');
  }

  // ---- auto-lock ----
  autoLockMins() { const v = Number(localStorage.getItem(AUTOLOCK_KEY)); return Number.isFinite(v) && v > 0 ? v : 15; }
  setAutoLock(mins) { this.store.set(AUTOLOCK_KEY, mins); }
}

/** The unlocked secret in chrome.storage.session, until auto-lock. */
export class Session {
  constructor(platform, vault) { this.platform = platform; this.vault = vault; }
  get() { return this.platform.sessionGet(SESSION_KEY); }
  set(secret) { return this.platform.sessionSet({ [SESSION_KEY]: { ...secret, expires: Date.now() + this.vault.autoLockMins() * 60000 } }); }
  clear() { return this.platform.sessionRemove(SESSION_KEY); }
}
