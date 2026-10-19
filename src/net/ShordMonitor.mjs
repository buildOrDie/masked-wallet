// Public SHORD collection status only. No wallet keys, note ownership or signing in this service.
import { sha256 } from '@noble/hashes/sha256';
import { toHex } from '../core/bytes.mjs';
import { fetchWithin } from './http.mjs';

export const NAKAS_PARENT = '896803ff66162b1956ccaa3a15723e9c3acd3cbfd81acadbc94812c3ad4fb3cci0';
const HASH = /^[0-9a-f]{64}$/;
const PARENT = /^[0-9a-f]{64}i(0|[1-9][0-9]*)$/;

export function shordCid(parent) {
  if (!PARENT.test(parent) || parent.length > 85) throw new Error('Enter a parent inscription ID (txidi0).');
  return toHex(sha256(new TextEncoder().encode(parent))).slice(0, 16);
}

/** A server base, never a credential-bearing URL. HTTP is only allowed on loopback. */
export function shordUrl(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { throw new Error('Enter an indexer URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('Use HTTPS, or HTTP on localhost.');
  if (u.username || u.password || u.search || u.hash) throw new Error('Indexer URLs cannot contain credentials, a query or a fragment.');
  return u.href.replace(/\/+$/, '');
}

export function parseShordStatus(j, { network, parent, cid }) {
  if (!j || j.network !== network || j.rulesInscriptionId !== parent || j.cid !== cid) throw new Error('Indexer returned a different network or collection.');
  if (!Number.isSafeInteger(j.lastHeight) || j.lastHeight < 0 || typeof j.blockHash !== 'string' || !HASH.test(j.blockHash) || typeof j.digest !== 'string' || !HASH.test(j.digest) || !Number.isSafeInteger(j.notes) || j.notes < 0) throw new Error('Indexer returned an invalid status.');
  // Copy only the fields we use. Never retain arbitrary server data in wallet state.
  return { height: j.lastHeight, blockHash: j.blockHash, digest: j.digest, notes: j.notes };
}

export function compareShordStatus(a, b) {
  if (a.height !== b.height) return 'different-heights';
  return a.blockHash === b.blockHash && a.digest === b.digest && a.notes === b.notes ? 'agree' : 'disagree';
}

async function readStatus(response) {
  if (!response.ok) throw new Error(`SHORD indexer returned HTTP ${response.status}.`);
  // Status is tiny; bound the body, including chunked replies from custom servers.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Indexer returned an empty status.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) throw new Error('Indexer status is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('Indexer returned invalid JSON.'); }
}

export class ShordMonitor {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app, request = fetchWithin) {
    this.app = app;
    this.request = request;
    this.revision = 0;
    this.current = null;
    this.pending = null;
  }

  get key() { return `wren.shord.monitor.${this.app.state.net}`; }
  config() { return this.app.store.getJson(this.key); }
  get result() { return this.current?.key === this.key ? this.current : null; }
  get busy() { return this.pending?.key === this.key; }

  reset() {
    this.revision++;
    this.current = null;
    this.pending = null;
  }

  clear() { this.reset(); this.app.store.remove(this.key); }

  /** Permission is requested by the click handler before any requests or persistence. */
  async save({ primary, peer = '', parent }, requestPermission = async (_urls) => {}) {
    const config = { primary: shordUrl(primary), peer: peer.trim() ? shordUrl(peer) : '', parent: parent.trim() };
    shordCid(config.parent);
    if (config.primary === config.peer) throw new Error('Choose a different comparison indexer.');
    const key = this.key, revision = ++this.revision;
    await requestPermission([config.primary, ...(config.peer ? [config.peer] : [])]);
    if (key !== this.key || revision !== this.revision) throw new Error('Settings changed. Save again on the current network.');
    this.current = null;
    this.app.store.setJson(key, config);
    return this.refresh();
  }

  /** Explicit, user-triggered check: never polls or sends addresses or keys to an indexer. */
  async refresh() {
    const config = this.config();
    if (!config) return;
    const key = this.key, revision = ++this.revision;
    const network = this.app.state.net === 'main' ? 'mainnet' : 'signet';
    const expected = { network, parent: config.parent, cid: shordCid(config.parent) };
    this.current = null;
    this.pending = { key, revision };
    this.app.render();
    try {
      const get = async (base) => parseShordStatus(await this.request(8000,
        `${shordUrl(base)}/c/${expected.cid}/status`,
        { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' }, readStatus), expected);
      const [primaryResult, peerResult] = await Promise.allSettled([
        get(config.primary), config.peer ? get(config.peer) : Promise.resolve(null),
      ]);
      if (primaryResult.status === 'rejected') throw primaryResult.reason;
      const primary = primaryResult.value;
      if (revision !== this.revision || key !== this.key) return;
      let comparison = 'none';
      if (config.peer) comparison = peerResult.status === 'rejected' ? 'unavailable' : compareShordStatus(primary, peerResult.value);
      // This corroborates a claimed block with the configured Bitcoin API, not Bitcoin consensus.
      let chain = 'unavailable';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const r = await this.app.servers.request(`block-height/${primary.height}`, { cache: 'no-store', signal: controller.signal });
        if (r.ok) {
          const hash = (await r.text()).trim();
          if (HASH.test(hash)) chain = hash === primary.blockHash ? 'match' : 'mismatch';
        }
      } catch { /* The status remains useful, but has no Bitcoin API corroboration. */ }
      finally { clearTimeout(timer); }
      if (revision === this.revision && key === this.key) this.current = { key, primary, comparison, chain, checkedAt: Date.now(), error: '' };
    } catch (err) {
      if (revision === this.revision && key === this.key) this.current = { key, primary: null, comparison: 'none', chain: 'unavailable', checkedAt: Date.now(), error: err.message };
    } finally {
      if (this.pending?.revision === revision) this.pending = null;
      this.app.render();
    }
  }
}
