// RGB test networks. Both are separate test environments, never MASKED's mainnet account.
// - public: public Bitcoin Signet (the same chain as MASKED's Signet), mempool.space as the indexer and
//   Iris Wallet's public RGB proxy for transfer files. No USDT here: issue your own test asset.
// - utexo: Utexo's own Signet (`signetcustom`), where Utexo's faucet gives test BTC and test assets.
export const RGB_PROFILES = Object.freeze({
  public: Object.freeze({
    id: 'public',
    label: 'Public Signet',
    sdk: Object.freeze({
      network: 'signet',
      indexerUrl: 'https://mempool.space/signet/api',
      transportEndpoint: 'https://proxy.iriswallet.com/0.2/json-rpc',
      dataDir: 'masked_rgb_public_signet_v2', // v2: the on-chain engine (v1 was the Lightning SDK)
    }),
    invoiceNets: Object.freeze(['signet']),
    vaultKey: 'masked.rgb.public-signet.v1',
    funding: 'Send Signet coins here, for example from your MASKED Signet Public balance.',
  }),
  utexo: Object.freeze({
    id: 'utexo',
    label: 'Utexo Signet',
    sdk: Object.freeze({
      network: 'utexo',
      indexerUrl: 'https://esplora-api.utexo.com',
      transportEndpoint: 'https://rgb-proxy.utexo.com/json-rpc',
      dataDir: 'masked_rgb_utexo_signet_v2',
    }),
    invoiceNets: Object.freeze(['signet', 'utexo']),
    vaultKey: 'masked.rgb.signet.v1',
    funding: 'Fund this address using /getbtc at Utexo’s faucet. Do not send public Signet coins.',
  }),
});
/**
 * RGB on Bitcoin mainnet (beta). Its own keys, derived from the MASKED recovery phrase with their own path, so
 * RGB's coins never mix with the Public or Shielded balance. Tokens can only come back from an RGB backup file:
 * the phrase alone restores the BTC part, not the token proofs.
 */
export const RGB_MAINNET = Object.freeze({
  id: 'mainnet',
  label: 'Bitcoin mainnet',
  sdk: Object.freeze({
    network: 'mainnet',
    indexerUrl: 'https://mempool.space/api',
    transportEndpoint: 'https://proxy.iriswallet.com/0.2/json-rpc',
    dataDir: 'masked_rgb_mainnet_v1',
  }),
  invoiceNets: Object.freeze(['mainnet', 'bitcoin', 'bc']),
  vaultKey: 'masked.rgb.mainnet.v1',
  funding: 'Send a little BTC here for RGB network fees, for example from your Public balance.',
  main: true,
});
/** The mainnet beta is switched on per browser. */
export const RGB_BETA_KEY = 'masked.rgb.mainnet-beta';
export const RGB_PROFILE_KEY = 'masked.rgb.profile';
export const DEFAULT_PROFILE = 'public';
/** @param {string|null} id */
export const profileOf = (id) => RGB_PROFILES[id] || RGB_PROFILES[DEFAULT_PROFILE];

// kept for older imports and tests
export const RGB_SIGNET = RGB_PROFILES.utexo.sdk;
export const RGB_VAULT_KEY = RGB_PROFILES.utexo.vaultKey;
export const RGB_DIRTY_KEY = 'masked.rgb.signet.backup-required';
/** Each network keeps its own "backup needed" flag. */
export const dirtyKey = (p) => (p.id === 'utexo' ? RGB_DIRTY_KEY : `${p.vaultKey}.backup-required`);

export function baseUnits(text) {
  if (!/^[1-9]\d*$/.test(String(text))) throw new Error('Enter a positive amount in asset base units.');
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error('Amount exceeds the supported exact integer range.');
  return value;
}
export function testFee(text) {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 1 || value > 100) throw new Error('Use a fee rate between 1 and 100 sat/vB.');
  return value;
}
/** A new test asset: ticker, name, decimals and whole-unit supply, checked before the SDK sees them. */
export function newAsset({ ticker, name, precision, supply }) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(t)) throw new Error('Ticker: 2 to 8 letters or digits, starting with a letter.');
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 40) throw new Error('Name: 2 to 40 characters.');
  const p = Number(precision);
  if (!Number.isInteger(p) || p < 0 || p > 8) throw new Error('Decimals: a whole number from 0 to 8.');
  const whole = baseUnits(supply);
  const amount = whole * 10 ** p;
  if (!Number.isSafeInteger(amount)) throw new Error('Supply is too large for these decimals.');
  return { ticker: t, name: n, precision: p, amounts: [amount] };
}

/** "12.5" with 2 decimals → 1250 base units. Exact (string math), no rounding: too many decimals is an error. */
export function toBase(text, precision) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  const m = t.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error('Enter an amount, like 10 or 2.5.');
  const frac = m[2] || '';
  if (frac.length > precision) throw new Error(precision ? `This token has ${precision} decimal${precision === 1 ? '' : 's'}.` : 'This token has no decimals.');
  const n = Number(m[1] + frac.padEnd(precision, '0'));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Enter an amount above zero.');
  return n;
}
/** 1250 base units with 2 decimals → "12.5" (grouped: "1,234.5"). */
export function fromBase(n, precision) {
  const v = Math.max(0, Math.trunc(Number(n) || 0));
  const s = String(v).padStart(precision + 1, '0');
  const whole = s.slice(0, s.length - precision) || '0', frac = precision ? s.slice(-precision).replace(/0+$/, '') : '';
  return Number(whole).toLocaleString('en-US') + (frac ? '.' + frac : '');
}
