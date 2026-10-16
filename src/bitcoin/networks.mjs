// The networks MASKED runs on, and the public servers it uses for each.

export const NETWORKS = {
  main: { name: 'Mainnet', sp: 'sp', tr: 'bc', coin: 0, wif: 0x80, mempool: 'https://mempool.space/api/tx/' },
  signet: { name: 'Signet', sp: 'tsp', tr: 'tb', coin: 1, wif: 0xef, mempool: 'https://mempool.space/signet/api/tx/' },
};

/** Blockchain servers (Esplora API), in order of preference. */
export const ESPLORA = {
  main: ['https://mempool.space/api/', 'https://blockstream.info/api/'],
  signet: ['https://mempool.space/signet/api/'],
};

export const BROADCAST = {
  main: 'https://mempool.space/api/tx',
  signet: 'https://mempool.space/signet/api/tx',
};

/** ord explorers: inscription contents and the "is this coin plain bitcoin" check. */
export const ORD = {
  main: 'https://ordinals.com',
  signet: 'https://signet.ordinals.com',
};

/** MASKED's own servers, on by default for Mainnet (Settings can turn them off). */
export const DEFAULT_SCAN = { main: 'https://scan.maskedwallet.com' };
export const DEFAULT_TOKENS = { main: 'https://tokens.maskedwallet.com' };

/** The names UniSat-style dApps use. */
export const UNISAT_NET = { main: 'livenet', signet: 'testnet' };

export const isNetwork = (key) => Object.prototype.hasOwnProperty.call(NETWORKS, key);

/** Links to mempool.space for one network. */
export class Explorer {
  constructor(net) { this.net = net; }
  get base() { return NETWORKS[this.net].mempool.replace(/\/api\/tx\/?$/, ''); }
  tx(txid) { return `${this.base}/tx/${txid}`; }
  address(address) { return `${this.base}/address/${address}`; }
  ordAddress(address) { return `${ORD[this.net]}/address/${address}`; }
  inscription(id) { return `${ORD[this.net]}/inscription/${id}`; }
}
