// Load the packaged on-chain RGB engine (rgb-lib-wasm). Nothing is fetched from outside the extension.
import init, * as lib from '@utexo/rgb-lib-wasm';
import { LiteWallet } from './LiteWallet.mjs';

let loaded;
/** The engine, loaded once. Returns the same shape SignetWallet expects from an SDK: { UTEXOWallet }. */
export function loadRgbSdk() {
  if (!loaded) loaded = (async () => {
    await init({ module_or_path: new URL('./rgb-lib.wasm', import.meta.url) });
    // `new sdk.UTEXOWallet(params)` gives an on-chain LiteWallet
    function UTEXOWallet(params) { return new LiteWallet(lib, params); }
    return { UTEXOWallet };
  })().catch((error) => { loaded = null; throw error; });
  return loaded;
}
