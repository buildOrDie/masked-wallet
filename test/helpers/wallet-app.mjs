// Runs the real wallet services in Node: an in-memory localStorage and a page URL are all MaskedApp needs
// to be built. Network calls go to `fetch`, which each test replaces as it likes.
import * as sp from '../../src/crypto/sp-core.mjs';

export class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage ??= new MemoryStorage();
globalThis.location ??= new URL('http://localhost/masked.html');

const { MaskedApp } = await import('../../src/app/MaskedApp.mjs');
const { Keyring } = await import('../../src/wallet/Keyring.mjs');
export { MaskedApp, Keyring };

/** A wallet app on `net`, opened with the given keys (a Keyring), without starting the UI. */
export function walletApp(keys, net = 'main') {
  const app = new MaskedApp();
  app.state.net = net;
  app.state.wallet = keys;
  app.render = () => {};
  app.loadWalletData();
  return app;
}

/** A Keyring from raw numbers (source 'mnemonic', so it can trade). */
export function testKeys({ bScan = 0x5ca9n * 1009n, bSpend, fundingPriv }) {
  return new Keyring({ source: 'mnemonic', bScan, bSpend, Bspend: sp.util.mulG(bSpend), fundingPriv });
}

/** Replace fetch with a function of the URL; returns the calls made. */
export function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const r = await handler(String(url), init);
    if (r instanceof Response) return r;
    return new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
  };
  return calls;
}
