// MASKED wallet: the page script of the extension popup, side panel and approval window.
import SECP_WASM from '../node_modules/tiny-secp256k1/lib/secp256k1.wasm';
import { initFast } from './crypto/sp-fast.mjs';
import EXAMPLE from './wallet/example.json';
import { MaskedApp } from './app/MaskedApp.mjs';

const app = new MaskedApp({ example: EXAMPLE });
app.start({ secpWasm: SECP_WASM, initFast });
