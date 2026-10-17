// Utexo Signet is a separate test environment, not MASKED's mainnet account.
export const RGB_SIGNET = Object.freeze({
  network: 'utexo',
  indexerUrl: 'https://esplora-api.utexo.com',
  transportEndpoint: 'https://rgb-proxy.utexo.com/json-rpc',
  proxyUrl: '', // no Lightning node or channels in this on-chain prototype
  vssUrl: null, // opt out of remote state backup; export encrypted files instead
  nodeRuntimeId: 'masked-rgb-signet-v1',
  dataDir: '/masked_rgb_signet_v1',
});
export const RGB_VAULT_KEY = 'masked.rgb.signet.v1';
export const RGB_DIRTY_KEY = 'masked.rgb.signet.backup-required';
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
