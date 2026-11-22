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
    version: '1.9.0',
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
      /**
       * An invoice to receive tokens: { assetId?, baseUnits?, expirySeconds?, kind?: 'blind'|'witness', ticker?, precision? }
       * → { invoice, recipientId, expirationTimestamp, witness }. ticker and precision describe a token the wallet doesn't
       * hold yet, so the approval can show "307 MASKED" instead of "30,700 units" (shown as the site's description).
       */
      requestInvoice: (o = {}) => request('rgbRequestInvoice', { assetId: o.assetId, baseUnits: o.baseUnits != null ? String(o.baseUnits) : undefined, expirySeconds: o.expirySeconds, kind: o.kind, ticker: o.ticker, precision: o.precision, nft: o.nft === true || undefined, name: o.name }),
      /** Pay an RGB invoice: { assetId?, amount? (tokens as wallets show them), feeRate? } → { txid, batchTransferIdx, status: 'broadcast'|'waiting' } */
      payInvoice: (invoice, o = {}) => request('rgbPayInvoice', { invoice, assetId: o.assetId, amount: o.amount != null ? String(o.amount) : undefined, feeRate: o.feeRate }),
      // peer-to-peer swaps: tokens for BTC in one transaction, wallet to wallet (docs/PROVIDER.md)
      /** The RGB tokens this wallet holds (asks the person first): [{ assetId, ticker, name, precision, spendable, max }] */
      getAssets: () => request('rgbListAssets'),
      /** What's in the RGB wallet (asks the person first): { coins, rgb, tokens, activity } (docs/PROVIDER.md) */
      getOutputs: () => request('rgbOutputs'),
      /** Free spare RGB outputs back to bitcoin (asks first): { feeRate? } → { txid, freed, sats } */
      freeSpare: (o = {}) => request('rgbFreeSpare', { feeRate: o.feeRate }),
      /** { assetId } → { total, max } in base units */
      offerableAmount: (o = {}) => request('rgbSwapAvailable', o),
      /** buyer: { offerId, network, offer, feeRate? } → session for the seller */
      prepareBuy: (o = {}) => request('rgbBuyPrepare', o),
      /** seller: { offerId, network, session, offer } → { psbt, sellerOutpoint, consignment } */
      prepareSale: (o = {}) => request('rgbSalePrepare', o),
      /** buyer: { offerId, psbt, consignment, offer } → { offerId, psbt, … } */
      signBuy: (o = {}) => request('rgbBuySign', o),
      /** seller: { offerId, psbt, offer } → { txid } */
      completeSale: (o = {}) => request('rgbSaleComplete', o),
      // Instant listings: signed once, bought with the seller offline (docs/PROVIDER.md)
      /** seller: { offerId, offer, market, token, feeRate? } → { stage: 'ready', psbt, consignment, templateTxid, sellerOutpoint } or { stage: 'moving', txid } */
      listInstant: (o = {}) => request('rgbInstantList', o),
      listInstantLots: (o = {}) => request('rgbInstantListLots', o),
      /** buyer: { offerId, network, offer, listing, feeRate? } → { txid } (broadcast) */
      buyInstant: (o = {}) => request('rgbInstantBuy', o),
      /** buyer, several at once: { items: [{ offerId, offer, listing }], network, feeRate? } → { results: [{ offerId, txid } | { offerId, error }] }. One approval, cheapest first; from 2.30 up to 10 in one transaction (they share its txid) */
      buyInstantMany: (o = {}) => request('rgbInstantBuyMany', o),
      /** seller: { offerId, offer, feeRate? } → { stage, txid } (moves the signed output: an on-chain transaction) */
      cancelInstant: (o = {}) => request('rgbInstantCancel', o),
      // wallet-to-wallet swaps in UniSat's P2P flow, with UniSat wallets too (2.31, docs/PROVIDER.md). Each call takes
      // { offerId (the trade id), offer: { assetId, amount, priceSats }, network } and:
      /** seller, listing: { partial? } → { sealTxid, sealVout, sealSatoshis, sealScriptPubKey, sealAmount, sellerAddress } */
      p2pListable: (o = {}) => request('rgbP2pList', o),
      /** buyer: { seller: { sealTxid, sealVout, sealSatoshis, sealScriptPubKey, address }, partial?, sealAmount?, feeRate? } → { invoice, recipientId, draftPsbtHex } */
      p2pBuyPrepare: (o = {}) => request('rgbP2pBuyPrepare', o),
      /** seller: { invoice, draftPsbtHex } → { transferId, makerSignedPsbtHex, coloredPsbtHex, txid } */
      p2pSaleSign: (o = {}) => request('rgbP2pSaleSign', o),
      /** buyer: { coloredPsbtHex, txid? } → { buyerSignedPsbt, txid } */
      p2pBuySign: (o = {}) => request('rgbP2pBuySign', o),
      /** seller (no approval screen): { buyerSignedPsbtHex } → { commitment, proxyTransferId, senderPublicKey, txid, buyerSignedPsbtHash } */
      p2pSaleCommit: (o = {}) => request('rgbP2pSaleCommit', o),
      /** buyer (no approval screen): { commitment } → { status, txid } */
      p2pBuyAccept: (o = {}) => request('rgbP2pBuyAccept', o),
      /** seller (no approval screen): {} → { txid } once the buyer accepted and the swap went out */
      p2pSaleFinish: (o = {}) => request('rgbP2pSaleFinish', o),
      /** either side, before the buyer accepts (no approval screen): {} → { cancelled } */
      p2pCancel: (o = {}) => request('rgbP2pCancel', o),
      /** any trade (the 5-step or the P2P flow), when it was left or expired on the market (no approval screen):
       *  { offerId, offer, network } → { released } — frees what this wallet held for it, if nothing went out (2.31.3) */
      releaseTrade: (o = {}) => request('rgbReleaseTrade', o),
    }),
    // events: accountsChanged, networkChanged, chainChanged, tradeAccountChanged
    on: (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener: (event, fn) => { listeners.get(event)?.delete(fn); },
  });

  Object.defineProperty(window, 'masked', { value: provider, writable: false, configurable: false });
  window.dispatchEvent(new Event('masked#initialized'));
})();
