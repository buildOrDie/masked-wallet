/**
 * Where MASKED keeps the files of the NFTs it holds (pictures, metadata.json): each one once, as raw bytes, in its
 * own IndexedDB entry keyed by its SHA-256 digest. The RGB engine's saved state (rewritten after every action)
 * doesn't carry them; the wallet gives them back to the engine when it opens (LiteWallet.loadMedia) and stores new
 * ones before each save (keepMedia). A file is the same for every wallet that holds it, so one store serves all.
 * Without IndexedDB (tests, Node) it keeps them in memory.
 */
const DB = 'masked_rgb_media', STORE = 'files';

/** @returns {{ keys(): Promise<string[]>, get(d: string): Promise<Uint8Array|null>, put(d: string, b: Uint8Array): Promise<void> }} */
export function memoryMediaStore() {
  const m = new Map();
  return {
    async keys() { return [...m.keys()]; },
    async get(d) { return m.get(d) || null; },
    async put(d, b) { m.set(d, new Uint8Array(b)); },
  };
}

export function mediaStore() {
  const idb = globalThis.indexedDB;
  if (!idb) return memoryMediaStore();
  let opening = null;
  const open = () => (opening ??= new Promise((ok, no) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => { opening = null; no(r.error); };
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((ok, no) => {
      const tx = db.transaction(STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      const req = fn(tx.objectStore(STORE));
      let out;
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => ok(out);
      tx.onerror = () => no(tx.error);
      tx.onabort = () => no(tx.error);
    });
  };
  return {
    async keys() { return ((await run('readonly', (s) => s.getAllKeys())) || []).map(String); },
    async get(d) { const v = await run('readonly', (s) => s.get(d)); return v ? new Uint8Array(v) : null; },
    async put(d, b) { await run('readwrite', (s) => { s.put(new Uint8Array(b), d); }); },
  };
}
