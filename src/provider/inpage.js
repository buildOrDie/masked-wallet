// MASKED in-page provider — runs in the page's own JS world and exposes window.masked.
// The API mirrors UniSat's (window.unisat) so existing Bitcoin dApps can integrate with a one-line change.
// It holds no keys: every call is relayed to the extension, and sensitive calls need user approval.
(() => {
  if (window.masked) return;
  const TARGET_OUT = 'masked-content';
  const TARGET_IN = 'masked-inpage';
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.target !== TARGET_IN) return;
    const { id, result, error, event, data } = e.data;
    if (event) {
      for (const fn of listeners.get(event) || []) { try { fn(data); } catch (err) { console.error(err); } }
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) {
      const err = new Error(error.message || 'MASKED request failed');
      err.code = error.code ?? 4000;
      p.reject(err);
    } else p.resolve(result);
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++seq}`;
    pending.set(id, { resolve, reject });
    window.postMessage({ target: TARGET_OUT, id, method, params }, window.location.origin);
  });

  const provider = Object.freeze({
    isMasked: true,
    version: '1.5.0',
    // accounts
    requestAccounts: () => request('requestAccounts'),
    getAccounts: () => request('getAccounts'),
    getPublicKey: () => request('getPublicKey'),
    getBalance: () => request('getBalance'),
    getShieldedAddress: () => request('getShieldedAddress'),
    disconnect: () => request('disconnect'),
    // network
    getNetwork: () => request('getNetwork'),
    switchNetwork: (network) => request('switchNetwork', { network }),
    getChain: () => request('getChain'),
    switchChain: (chain) => request('switchChain', { chain }),
    // signing
    signMessage: (message, type = 'ecdsa') => request('signMessage', { message, type }),
    signPsbt: (psbtHex, options = {}) => request('signPsbt', { psbtHex, options }),
    signPsbts: (psbtHexs, options = []) => request('signPsbts', { psbtHexs, options }),
    // sending
    sendBitcoin: (toAddress, satoshis, options = {}) => request('sendBitcoin', { toAddress, satoshis, options }),
    pushPsbt: (psbtHex) => request('pushPsbt', { psbtHex }),
    // inscriptions and BRC-20 (UniSat-compatible)
    getInscriptions: (cursor = 0, size = 20) => request('getInscriptions', { cursor, size }),
    inscribeTransfer: (ticker, amount, options = {}) => request('inscribeTransfer', { ticker, amount: String(amount), options }),
    // private trading (MASKED only): a private trade address funded from Shielded
    getTradeAccount: () => request('getTradeAccount'),
    fundTradeAccount: (satoshis, options = {}) => request('fundTradeAccount', { satoshis, padding: !!options.padding, feeRate: options.feeRate }),
    moveToTradeAccount: (ticker, amount) => request('moveToTradeAccount', { ticker, amount: String(amount) }),
    cancelShieldedListing: (outpoint) => request('cancelShieldedListing', { outpoint }),
    returnToShielded: (ticker, amount) => request('returnToShielded', ticker ? { ticker, amount: String(amount) } : {}),
    pushTx: (rawtx) => request('pushTx', { rawtx: typeof rawtx === 'object' ? rawtx.rawtx : rawtx }),
    // ecash (Cashu): every payment and claim is approved in MASKED
    cashu: Object.freeze({
      /** The key tokens are locked to for this wallet (its Public address key), hex "02…". */
      getLockKey: () => request('cashuGetLockKey'),
      /** Ask for an ecash token: { amount, mints?, lockTo?, memo? } → { token, mint, amount } */
      pay: (o = {}) => request('cashuPay', { amount: o.amount, mints: o.mints, lockTo: o.lockTo, memo: o.memo }),
      /** Pay a NUT-18 payment request (creqA… / creqB…) → { delivered, mint, amount } or { token, payload, … } */
      payRequest: (paymentRequest) => request('cashuPayRequest', { request: paymentRequest }),
      /** Give the wallet a token to claim (a refund, a reward) → { amount, mint } */
      receive: (token) => request('cashuReceive', { token }),
    }),
    // RGB tokens (the wallet's RGB account): every invoice and send is approved in MASKED
    rgb: Object.freeze({
      /** An invoice to receive tokens: { assetId?, baseUnits?, expirySeconds?, kind?: 'blind'|'witness' } → { invoice, recipientId, expirationTimestamp, witness } */
      requestInvoice: (o = {}) => request('rgbRequestInvoice', { assetId: o.assetId, baseUnits: o.baseUnits != null ? String(o.baseUnits) : undefined, expirySeconds: o.expirySeconds, kind: o.kind }),
      /** Pay an RGB invoice: { assetId?, amount? (tokens as wallets show them), feeRate? } → { txid, batchTransferIdx, status: 'broadcast'|'waiting' } */
      payInvoice: (invoice, o = {}) => request('rgbPayInvoice', { invoice, assetId: o.assetId, amount: o.amount != null ? String(o.amount) : undefined, feeRate: o.feeRate }),
      // peer-to-peer swaps, tokens for BTC in one transaction (same steps and messages as the Darkhorse wallet)
      /** { assetId } → { total, max } in base units */
      swapSellable: (o = {}) => request('rgbSwapSellable', o),
      /** buyer: { offerId, network, offer, feeRate? } → session for the seller */
      swapPrepare: (o = {}) => request('rgbSwapPrepare', o),
      /** seller: { offerId, network, session, offer } → { psbt, sellerOutpoint, consignment } */
      swapColor: (o = {}) => request('rgbSwapColor', o),
      /** buyer: { offerId, psbt, consignment, offer } → { offerId, psbt, … } */
      swapSign: (o = {}) => request('rgbSwapSign', o),
      /** seller: { offerId, psbt, offer } → { txid } */
      swapFinish: (o = {}) => request('rgbSwapFinish', o),
    }),
    // events: accountsChanged, networkChanged, chainChanged, tradeAccountChanged
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener: (event, fn) => { listeners.get(event)?.delete(fn); },
  });

  Object.defineProperty(window, 'masked', { value: provider, writable: false, configurable: false });
  window.dispatchEvent(new Event('masked#initialized'));
})();
