// The open wallet on the current network: its keys, addresses and links. Everything here follows
// state.net and state.wallet, so a network switch or a new wallet needs no extra bookkeeping.
import { AddressCodec } from '../bitcoin/AddressCodec.mjs';
import { Explorer, NETWORKS } from '../bitcoin/networks.mjs';

export class Account {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this._codecs = new Map();
  }

  get state() { return this.app.state; }
  get net() { return this.state.net; }
  /** @returns {import('./Keyring.mjs').Keyring|null} */
  get keys() { return this.state.wallet; }
  get params() { return NETWORKS[this.net]; }
  get isTest() { return this.net !== 'main'; }
  get unit() { return this.net === 'main' ? 'BTC' : 'tBTC'; }

  /** Addresses and scripts on the current network. */
  get codec() {
    if (!this._codecs.has(this.net)) this._codecs.set(this.net, new AddressCodec(this.net));
    return this._codecs.get(this.net);
  }
  get explorer() { return new Explorer(this.net); }

  /** Storage id for per-wallet records. */
  get id() { return this.keys ? this.keys.id(this.net) : `${this.net}:none`; }

  get canSign() { return !!this.keys && this.keys.bSpend !== null; }
  /** Private trading needs the spend key and a real wallet (not the demo). */
  get canTrade() { return this.canSign && this.keys.source !== 'example'; }

  /** The Public output ({ internalX, outputX, outputPriv, address }) or null. */
  funding() { return this.keys ? this.keys.funding(this.net) : null; }
  pubAddr() { return this.funding()?.address || ''; }
  /** Output script (hex) of the Public address, '' without one. */
  pubSpk() { const f = this.funding(); return f ? '5120' + f.outputX : ''; }
  /** The Shielded (sp1…) address; with m, a labelled one (0 = change). */
  address(m = null) { return this.keys.silentAddress(this.net, m); }
  shieldAddr() { return this.keys ? this.address() : ''; }
  changeAddr() { return this.address(0); }
}
