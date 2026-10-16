// The wallet's keys: BIP 352 scan and spend keys (the Shielded side) and a BIP 86 key (the Public side).
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import * as sp from '../crypto/sp-core.mjs';
import { fromHex, toHex } from '../core/bytes.mjs';
import { NETWORKS } from '../bitcoin/networks.mjs';
import { keySpendTaproot, normalizeSchnorrPriv } from '../bitcoin/taproot.mjs';

const { b2n, n2b, mulG, Point, mod } = sp.util;
const b58c = createBase58check(sha256);

export class Keyring {
  /**
   * @param {object} k
   * @param {'mnemonic'|'keys'|'example'} k.source
   * @param {bigint} k.bScan
   * @param {bigint|null} k.bSpend   null for a watch-only wallet
   * @param {any} k.Bspend           the spend public key (a curve point)
   * @param {string} [k.mnemonic]
   * @param {string} [k.passphrase]
   * @param {string} [k.fundingPriv] the Public (BIP 86) private key, hex
   */
  constructor({ source, bScan, bSpend, Bspend, mnemonic, passphrase, fundingPriv }) {
    this.source = source;
    this.bScan = bScan;
    this.bSpend = bSpend;
    this.Bscan = mulG(bScan);
    this.Bspend = Bspend;
    if (mnemonic !== undefined) { this.mnemonic = mnemonic; this.passphrase = passphrase; }
    this.fundingPriv = fundingPriv || (bSpend !== null ? toHex(n2b(bSpend)) : undefined);
    // set by the vault: how far back the history scan goes
    this.fresh = false;
    this.birthday = null;
    this.restored = false;
    this._funding = new Map();
  }

  /** Raw keys: the scan key, and the spend key as 32-byte private or 33-byte public (watch-only). */
  static fromKeys(bScan, spendKeyBytes, source, extra = {}) {
    let bSpend = null, Bspend;
    if (spendKeyBytes.length === 32) { bSpend = mod(b2n(spendKeyBytes)); Bspend = mulG(bSpend); }
    else Bspend = Point.fromHex(spendKeyBytes);
    bScan = mod(bScan);
    if (bScan === 0n || (bSpend !== null && bSpend === 0n)) throw new Error('Key is zero');
    return new Keyring({ source, bScan, bSpend, Bspend, ...extra });
  }

  /** BIP 352 keys at m/352'/coin'/0'/{1',0'}/0 and the Public key at m/86'/coin'/0'/0/0. */
  static fromMnemonic(words, passphrase = '', net = 'main') {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(words, passphrase));
    const c = NETWORKS[net].coin;
    const scan = root.derive(`m/352'/${c}'/0'/1'/0`).privateKey;
    const spend = root.derive(`m/352'/${c}'/0'/0'/0`).privateKey;
    const funding = root.derive(`m/86'/${c}'/0'/0/0`).privateKey;
    return Keyring.fromKeys(b2n(scan), spend, 'mnemonic', { mnemonic: words, passphrase, fundingPriv: toHex(funding) });
  }

  static fromExample(example) {
    return Keyring.fromKeys(b2n(fromHex(example.keys.scan_priv_key)), fromHex(example.keys.spend_priv_key), 'example');
  }

  get watchOnly() { return this.bSpend === null; }

  /** Storage id of this wallet on a network (the key every per-wallet record is filed under). */
  id(net) { return `${net}:${this.Bscan.toHex(true)}:${this.Bspend.toHex(true)}`; }

  /** sp1… address; with a label m, the labelled address (m = 0 is the change address). */
  silentAddress(net, m = null) {
    const B = m === null ? this.Bspend : sp.labeledSpend(this.Bspend, this.bScan, m);
    return sp.encodeAddress(this.Bscan, B, net === 'main' ? 'main' : 'test');
  }

  /** The Public (BIP 86) output: { internalX, outputX, outputPriv, address }, or null without a key. */
  funding(net) {
    if (!this.fundingPriv) return null;
    if (!this._funding.has(net)) this._funding.set(net, keySpendTaproot(this.fundingPriv, NETWORKS[net].tr));
    return this._funding.get(net);
  }

  /** The Public internal key (even Y): message signatures and PSBT key-path signing. */
  accountPriv() { return normalizeSchnorrPriv(this.fundingPriv); }

  /** Private key of a Shielded output with this tweak. */
  outputPriv(tweakHex) { return sp.outputPrivKey(this.bSpend, tweakHex); }

  static toWif(hex, net) { return b58c.encode(Uint8Array.from([NETWORKS[net].wif, ...fromHex(hex), 1])); }

  /** 64 hex characters or a WIF key → hex. */
  static parsePriv(s) {
    s = s.trim();
    if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
    try {
      const b = b58c.decode(s);
      if ((b.length === 34 && b[33] === 1) || b.length === 33) return toHex(b.slice(1, 33));
    } catch {}
    throw new Error('Private key must be 64 hex characters or a WIF key');
  }
}
