// Packaged ESM boundary: the existing wallet loads the WASM SDK only when RGB is enabled.
export { SignetWallet } from './SignetWallet.mjs';
export { loadRgbSdk } from './load-sdk.mjs';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
export const newTestMnemonic = () => generateMnemonic(wordlist, 128);
