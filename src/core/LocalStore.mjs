// localStorage that never throws: private windows, full disks and blocked storage just read as empty.
// Every key the wallet writes keeps the "wren." prefix of earlier versions, so existing data still loads.

export class LocalStore {
  /** @param {() => Storage} backend */
  constructor(backend = () => globalThis.localStorage) {
    this.backend = backend;
  }

  get(key) {
    try { return this.backend().getItem(key); } catch { return null; }
  }

  set(key, value) {
    try { this.backend().setItem(key, value); } catch {}
  }

  remove(key) {
    try { this.backend().removeItem(key); } catch {}
  }

  /** Parsed JSON, or `fallback` when missing or unreadable. */
  getJson(key, fallback = null) {
    try {
      const raw = this.backend().getItem(key);
      return raw == null ? fallback : JSON.parse(raw) ?? fallback;
    } catch { return fallback; }
  }

  setJson(key, value) {
    this.set(key, JSON.stringify(value));
  }
}

export const localStore = new LocalStore();
