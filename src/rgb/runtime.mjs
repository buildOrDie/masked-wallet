// Packaged ESM boundary: the existing wallet loads the WASM SDK only when RGB is enabled.
export { SignetWallet } from './SignetWallet.mjs';
export { loadRgbSdk } from './load-sdk.mjs';
import { entropyToMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
export const newTestMnemonic = () => generateMnemonic(wordlist, 128);
/** A 12-word phrase from 16 bytes of hex (mainnet RGB keys, derived from the MASKED phrase). */
export const mnemonicFrom = (hex) => entropyToMnemonic(Uint8Array.from(hex.slice(0, 32).match(/../g).map((b) => parseInt(b, 16))), wordlist);
