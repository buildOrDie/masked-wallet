// Addresses for one network: what kind an address is, and the output script it pays to.
import * as btc from '@scure/btc-signer';
import { bech32, bech32m } from '@scure/base';
import * as sp from '../crypto/sp-core.mjs';
import { concat, u8 } from '../core/bytes.mjs';
import { NETWORKS } from './networks.mjs';
import { trAddress } from './taproot.mjs';

const PUBLIC = { kind: 'public', text: 'Public address · visible on-chain' };

export class AddressCodec {
  constructor(net) {
    this.net = net;
    this.params = NETWORKS[net];
  }

  get isMain() { return this.net === 'main'; }

  /** @scure/btc-signer network object. */
  get btcNetwork() { return this.isMain ? btc.NETWORK : btc.TEST_NETWORK; }

  trAddress(xHex) { return trAddress(xHex, this.params.tr); }

  /** bc1… address of an output script, or null for scripts without one. */
  fromScript(script) {
    try { return btc.Address(this.btcNetwork).encode(btc.OutScript.decode(script)); } catch { return null; }
  }

  isSilent(address) {
    try { return (sp.decodeAddress(address).network === 'main') === this.isMain; } catch { return false; }
  }

  /** What kind of address this is on this network: { kind: empty|shielded|public|wrongnet|invalid, text }. */
  kind(a) {
    a = String(a || '').trim();
    if (!a) return { kind: 'empty' };
    if (/^t?sp1/i.test(a)) {
      try {
        const d = sp.decodeAddress(a);
        if ((d.network === 'main') !== this.isMain) return { kind: 'wrongnet', text: `This is a ${d.network === 'main' ? 'Mainnet' : 'Signet'} address` };
        return { kind: 'shielded', text: 'Shielded address · private' };
      } catch { return { kind: 'invalid', text: 'Not a valid address' }; }
    }
    const wrongNet = (prefix) => ({ kind: 'wrongnet', text: `This is a ${prefix === 'bc' ? 'Mainnet' : 'test network'} address` });
    try {
      const { prefix } = bech32m.decode(a.toLowerCase());
      if (prefix !== this.params.tr) return wrongNet(prefix);
      this.segwitScript(a);
      return { ...PUBLIC };
    } catch {}
    try {
      // bech32 (v0, bc1q / tb1q)
      const { prefix, words } = bech32.decode(a.toLowerCase());
      if (prefix !== this.params.tr) return wrongNet(prefix);
      if (words[0] === 0) return { ...PUBLIC };
    } catch {}
    return { kind: 'invalid', text: 'Not a valid address' };
  }

  /** Output script of a bech32m address (taproot, or v0 written in bech32m by some wallets). */
  segwitScript(address) {
    if (/^(sp|tsp)1/i.test(address)) throw new Error('Silent payment address needs a funding transaction before the output can be derived.');
    const { prefix, words } = bech32m.decode(address.toLowerCase());
    if (prefix !== this.params.tr) throw new Error(`Recipient address must use ${this.params.tr}… for ${this.params.name}.`);
    const version = words[0];
    const data = Uint8Array.from(bech32m.fromWords(words.slice(1)));
    if (version === 0 && data.length === 20) return concat(u8(0x00), u8(0x14), data);
    if (version === 0 && data.length === 32) return concat(u8(0x00), u8(0x20), data);
    if (version === 1 && data.length === 32) return concat(u8(0x51), u8(0x20), data);
    throw new Error('Unsupported recipient address type.');
  }

  /** Output script of any Public address (bech32m or bech32 v0). */
  outputScript(a) {
    try { return this.segwitScript(a); } catch {}
    const { prefix, words } = bech32.decode(a.toLowerCase());
    if (prefix !== this.params.tr || words[0] !== 0) throw new Error('Unsupported address.');
    const data = Uint8Array.from(bech32.fromWords(words.slice(1)));
    if (data.length === 20) return concat(u8(0x00), u8(0x14), data);
    if (data.length === 32) return concat(u8(0x00), u8(0x20), data);
    throw new Error('Unsupported address.');
  }
}
