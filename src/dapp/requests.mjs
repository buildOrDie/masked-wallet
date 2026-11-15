// What a site may ask MASKED (window.masked), checked and answered the same way in the Chrome extension (its
// background) and in the phone app (the in-app market). Read-only calls are answered here; anything that needs a key
// goes to openApproval, which shows the wallet's approval screen. The caller supplies where things are stored.
import * as btc from '@scure/btc-signer';
import { bech32m, hex } from '@scure/base';

export const NETS = {
  main: { ord: 'https://ordinals.com', api: 'https://mempool.space/api/', unisat: 'livenet', chain: 'BITCOIN_MAINNET', name: 'Bitcoin Mainnet' },
  signet: { ord: 'https://signet.ordinals.com', api: 'https://mempool.space/signet/api/', unisat: 'testnet', chain: 'BITCOIN_SIGNET', name: 'Bitcoin Signet' },
};
// MASKED runs on Mainnet and Signet. UniSat reports Signet as "testnet", so that name maps to Signet.
const FROM_UNISAT = { livenet: 'main', mainnet: 'main', testnet: 'signet', signet: 'signet' };
const FROM_CHAIN = { BITCOIN_MAINNET: 'main', BITCOIN_SIGNET: 'signet' };

export const TRADE_SITES = new Set(['https://maskedwallet.com', 'https://www.maskedwallet.com']);
export const err = (code, message) => Object.assign(new Error(message), { code });
export const chainInfo = (net) => ({ enum: NETS[net].chain, name: NETS[net].name, network: NETS[net].unisat });

async function api(net, path, init) {
  const r = await fetch(NETS[net].api + path, init);
  const t = await r.text();
  if (!r.ok) throw err(4000, t || `Network error ${r.status}`);
  return t;
}

const checkTicker = (t) => {
  const ticker = String(t || '').trim();
  if (!ticker || new TextEncoder().encode(ticker).length > 6) throw err(4000, 'ticker must be a BRC-20 (4) or BRC2.0 (5-6) ticker.');
  return ticker;
};
/** An optional RGB asset ID: '' or rgb:… */
const optAssetId = (v) => {
  const s = v == null ? '' : String(v).trim();
  if (s && !/^rgb:[A-Za-z0-9~_\-!$.%]{10,120}$/.test(s)) throw err(4000, 'assetId must be an RGB asset ID (rgb:…).');
  return s;
};
/** A swap request's fields, checked for shape and size (the wallet checks the substance). */
function swapParams(method, p) {
  const id = String(p.offerId ?? '');
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(id)) throw err(4000, 'offerId must be a short id.');
  const o = p.offer;
  if (!o || typeof o !== 'object') throw err(4000, 'offer is required: { assetId, amount, priceSats, state }.');
  const offer = { offerId: o.offerId == null ? undefined : String(o.offerId), assetId: optAssetId(o.assetId), amount: String(o.amount ?? ''), priceSats: String(o.priceSats ?? ''), state: o.state == null ? undefined : String(o.state).slice(0, 20) };
  if (!offer.assetId || !/^\d{1,20}$/.test(offer.amount) || !/^\d{1,16}$/.test(offer.priceSats)) throw err(4000, 'offer needs assetId, amount and priceSats as whole numbers.');
  const out = { offerId: id, offer, network: p.network == null ? undefined : String(p.network).slice(0, 20) };
  const str = (v, max, what) => { if (typeof v !== 'string' || !v || v.length > max) throw err(4000, `${what} is missing or too large.`); return v; };
  if (method === 'rgbBuyPrepare' && p.feeRate != null) { const f = Number(p.feeRate); if (!(f >= 1 && f <= 500)) throw err(4000, 'feeRate must be between 1 and 500 sat/vB.'); out.feeRate = f; }
  if (method === 'rgbSalePrepare') {
    const s = p.session;
    if (!s || typeof s !== 'object') throw err(4000, 'session (from the buyer) is required.');
    out.session = Object.fromEntries(['offerId', 'assetId', 'amount', 'priceSats', 'buyerInvoice', 'buyerSeal', 'buyerOutpoint', 'buyerInputSats', 'buyerChangeScript', 'feeSats'].map((k) => [k, String(s[k] ?? '').slice(0, 3000)]));
  }
  if (method === 'rgbBuySign') { out.psbt = str(p.psbt, 200_000, 'psbt'); out.consignment = str(p.consignment, 4_000_000, 'consignment'); }
  if (method === 'rgbSaleComplete') out.psbt = str(p.psbt, 200_000, 'psbt');
  if (['rgbInstantList', 'rgbInstantBuy', 'rgbInstantCancel'].includes(method) && p.feeRate != null) { const f = Number(p.feeRate); if (!(f >= 1 && f <= 500)) throw err(4000, 'feeRate must be between 1 and 500 sat/vB.'); out.feeRate = f; }
  if (method === 'rgbInstantList') {
    // where the wallet sends the signed listing if it's signed later (after the tokens move): https only
    let u; try { u = new URL(String(p.market || '')); } catch { throw err(4000, 'market must be the market\'s address.'); }
    if (!(u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname))) throw err(4000, 'market must be an https address.');
    if (!/^[0-9a-f]{32,128}$/.test(String(p.token || ''))) throw err(4000, 'token (the seller token from listing) is required.');
    out.market = u.origin + u.pathname.replace(/\/+$/, ''); out.token = String(p.token);
  }
  if (method === 'rgbInstantBuy') {
    const l = p.listing;
    if (!l || typeof l !== 'object') throw err(4000, 'listing (the signed listing from the market) is required.');
    out.listing = { psbt: str(l.psbt, 20_000, 'listing.psbt'), consignment: str(l.consignment, 4_000_000, 'listing.consignment'), templateTxid: str(l.templateTxid, 64, 'listing.templateTxid') };
  }
  return out;
}
/** A sweep: 1 to MAX_SWEEP Instant listings of one token, each checked like a single Instant buy. */
export const MAX_SWEEP = 20;
function sweepParams(p) {
  const items = Array.isArray(p.items) ? p.items : null;
  if (!items || !items.length) throw err(4000, 'items (the Instant listings to buy) is required.');
  if (items.length > MAX_SWEEP) throw err(4000, `At most ${MAX_SWEEP} listings at once.`);
  const out = items.map((x) => swapParams('rgbInstantBuy', { ...(x || {}), network: p.network }));
  const ids = new Set(out.map((x) => x.offerId));
  if (ids.size !== out.length) throw err(4000, 'The same listing is in the list twice.');
  if (new Set(out.map((x) => x.offer.assetId)).size !== 1) throw err(4000, 'A sweep buys one token: every listing must be for the same asset.');
  const res = { items: out.map(({ network: _n, ...x }) => x), network: p.network == null ? undefined : String(p.network).slice(0, 20) };
  if (p.feeRate != null) { const f = Number(p.feeRate); if (!(f >= 1 && f <= 500)) throw err(4000, 'feeRate must be between 1 and 500 sat/vB.'); res.feeRate = f; }
  return res;
}
const checkAmount = (a) => { if (!/^\d+(\.\d+)?$/.test(String(a || '')) || /^0+(\.0+)?$/.test(String(a))) throw err(4000, 'amount must be a positive number.'); return String(a); };
/** What a site sees of private trading: the trade address and the Shielded totals. */
export const tradeView = (t) => ({ address: t.address, publicKey: t.publicKey, index: t.index, features: t.features || [], shielded: { sats: t.shielded?.sats || 0, tokens: (t.shielded?.tokens || []).map((x) => ({ ticker: x.tick, amount: String(x.amt) })), transfers: t.shielded?.transfers || [] } });

/**
 * @param {{ getPublic: () => Promise<any>, getTrade: () => Promise<any>, getSites: () => Promise<Record<string, any>>,
 *   setSites: (s: Record<string, any>) => Promise<void>, openApproval: (origin: string, method: string, params: any) => Promise<any>,
 *   emitTo: (origin: string, event: string, data: any) => void }} deps
 * @returns {(origin: string, method: string, params: any) => Promise<any>}
 */
export function makeHandler({ getPublic, getTrade, getSites, setSites, openApproval, emitTo }) {
  return async function handle(origin, method, params) {
    const pub = await getPublic();
    if (!pub?.address) throw err(4100, 'Open MASKED and set up a wallet first.');
    const net = pub.net;
    const sites = await getSites();
    const connected = !!sites[origin];
    const needConnected = () => { if (!connected) throw err(4100, 'This site is not connected. Call requestAccounts() first.'); };
    const needTrade = () => { tradeSite(); if (!sites[origin]?.trade) throw err(4100, 'Private trading is not allowed for this site. Call getTradeAccount() first.'); };
    // private trading is offered to MASKED's own website only, for now
    const tradeSite = () => { if (!TRADE_SITES.has(origin)) throw err(4200, 'Private trading is not available on this site.'); };

    switch (method) {
      case 'getNetwork': return NETS[net].unisat;
      case 'getChain': return chainInfo(net);
      case 'getAccounts': return connected ? [pub.address] : [];
      case 'requestAccounts': {
        if (connected) return [pub.address];
        const res = await openApproval(origin, 'requestAccounts', {});
        const s = await getSites();
        s[origin] = { connectedAt: Date.now() };
        await setSites(s);
        return res;
      }
      case 'disconnect': {
        const s = await getSites(); delete s[origin]; await setSites(s);
        emitTo(origin, 'accountsChanged', []);
        return true;
      }
      case 'getPublicKey': needConnected(); return pub.publicKey;
      case 'getShieldedAddress': needConnected(); return pub.shieldedAddress;
      case 'getBalance': {
        needConnected();
        const a = JSON.parse(await api(net, `address/${pub.address}`));
        const confirmed = a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum;
        const unconfirmed = a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum;
        return { confirmed, unconfirmed, total: confirmed + unconfirmed };
      }
      case 'switchNetwork': {
        needConnected();
        const target = FROM_UNISAT[String(params.network || '').toLowerCase()];
        if (!target) throw err(4000, `Unknown network "${params.network}". MASKED supports livenet (Mainnet) and signet.`);
        if (target === net) return NETS[net].unisat;
        await openApproval(origin, 'switchNetwork', { target });
        return NETS[target].unisat;
      }
      case 'switchChain': {
        needConnected();
        const target = FROM_CHAIN[params.chain];
        if (!target) throw err(4000, `Unsupported chain "${params.chain}". MASKED supports BITCOIN_MAINNET and BITCOIN_SIGNET.`);
        if (target === net) return chainInfo(net);
        await openApproval(origin, 'switchNetwork', { target });
        return chainInfo(target);
      }
      case 'signMessage':
        needConnected();
        if (typeof params.message !== 'string') throw err(4000, 'message must be a string.');
        if (!['ecdsa', 'bip322-simple'].includes(params.type)) throw err(4000, 'type must be "ecdsa" or "bip322-simple".');
        return openApproval(origin, 'signMessage', params);
      case 'signPsbt':
        needConnected();
        if (!/^[0-9a-fA-F]+$/.test(params.psbtHex || '')) throw err(4000, 'psbtHex must be a hex string.');
        return openApproval(origin, 'signPsbt', params);
      case 'signPsbts':
        needConnected();
        if (!Array.isArray(params.psbtHexs) || !params.psbtHexs.length) throw err(4000, 'psbtHexs must be a non-empty array.');
        return openApproval(origin, 'signPsbts', params);
      case 'sendBitcoin':
        needConnected();
        if (!Number.isSafeInteger(Number(params.satoshis)) || Number(params.satoshis) <= 0) throw err(4000, 'satoshis must be a positive integer.');
        return openApproval(origin, 'sendBitcoin', params);
      case 'getInscriptions': {
        needConnected();
        const cursor = Math.max(0, Number(params.cursor) || 0), size = Math.min(100, Math.max(1, Number(params.size) || 20));
        const ord = NETS[net].ord;
        const getJ = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (!r.ok) throw err(4000, `Inscription lookup failed (${r.status}).`); return r.json(); };
        const ids = (await getJ(`${ord}/address/${pub.address}`)).inscriptions || [];
        const list = await Promise.all(ids.slice(cursor, cursor + size).map(async (id) => {
          try {
            const i = await getJ(`${ord}/inscription/${id}`);
            const [txid, vout, offset] = String(i.satpoint || '').split(':');
            return { inscriptionId: id, inscriptionNumber: i.number ?? null, address: i.address || pub.address, outputValue: i.value ?? null, contentType: i.content_type || null, content: `${ord}/content/${id}`, preview: `${ord}/preview/${id}`, timestamp: i.timestamp ?? null, output: txid ? `${txid}:${vout}` : null, offset: offset != null ? Number(offset) : 0, genesisTransaction: String(id).slice(0, 64) };
          } catch { return { inscriptionId: id }; }
        }));
        return { total: ids.length, list };
      }
      case 'inscribeTransfer': {
        needConnected();
        const ticker = checkTicker(params.ticker), amount = checkAmount(params.amount);
        const account = ['trade', 'shielded'].includes(params.options?.account) ? params.options.account : 'public';
        if (account !== 'public') needTrade();
        return openApproval(origin, 'inscribeTransfer', { ticker, amount, options: { account } });
      }
      // ---- private trading: a private trade address made from the Shielded keys (see trade-core.mjs) ----
      case 'getTradeAccount': {
        needConnected(); tradeSite();
        const t = await getTrade();
        if (sites[origin]?.trade && t?.address && t.net === NETS[net].unisat) return tradeView(t);
        const res = await openApproval(origin, 'shareTrade', {});
        const s = await getSites();
        if (s[origin]) { s[origin].trade = true; await setSites(s); }
        return tradeView(res);
      }
      case 'fundTradeAccount': {
        needConnected(); needTrade();
        const satoshis = Number(params.satoshis) || 0;
        if (!Number.isSafeInteger(satoshis) || satoshis < 0 || (!satoshis && !params.padding)) throw err(4000, 'satoshis must be a positive integer.');
        return openApproval(origin, 'fundTrade', { satoshis, padding: !!params.padding, feeRate: Number(params.feeRate) || undefined });
      }
      case 'moveToTradeAccount':
        needConnected(); needTrade();
        return openApproval(origin, 'moveToTrade', { ticker: checkTicker(params.ticker), amount: checkAmount(params.amount) });
      case 'cancelShieldedListing':
        needConnected(); needTrade();
        if (!/^[0-9a-f]{64}:\d{1,6}$/i.test(String(params.outpoint || ''))) throw err(4000, 'outpoint must be "txid:vout".');
        return openApproval(origin, 'cancelShielded', { outpoint: String(params.outpoint).toLowerCase() });
      case 'returnToShielded':
        needConnected(); needTrade();
        return openApproval(origin, 'returnToShielded', params.ticker ? { ticker: checkTicker(params.ticker), amount: checkAmount(params.amount) } : {});
      case 'pushTx': {
        needConnected();
        if (!/^[0-9a-fA-F]+$/.test(params.rawtx || '')) throw err(4000, 'rawtx must be a hex string.');
        return (await api(net, 'tx', { method: 'POST', body: params.rawtx })).trim();
      }
      case 'pushPsbt': {
        needConnected();
        const tx = btc.Transaction.fromPSBT(hex.decode(params.psbtHex), { allowUnknownOutputs: true });
        try { tx.finalize(); } catch {}
        return (await api(net, 'tx', { method: 'POST', body: tx.hex })).trim();
      }
      // ---- RGB: the wallet's own RGB account (Home → RGB). Every invoice and every send is approved in MASKED ----
      case 'rgbRequestInvoice': {
        needConnected();
        const assetId = optAssetId(params.assetId);
        const baseUnits = params.baseUnits == null || params.baseUnits === '' ? '' : String(params.baseUnits);
        if (baseUnits && !/^[1-9]\d{0,17}$/.test(baseUnits)) throw err(4000, 'baseUnits must be a positive whole number (the token amount in its smallest unit).');
        if (baseUnits && !assetId) throw err(4000, 'Give assetId together with baseUnits.');
        const expiry = params.expirySeconds == null ? 86400 : Number(params.expirySeconds);
        if (!Number.isSafeInteger(expiry) || expiry < 600 || expiry > 7 * 86400) throw err(4000, 'expirySeconds must be between 600 and 604800.');
        const kind = params.kind == null || params.kind === '' ? '' : String(params.kind);
        if (kind && !['blind', 'witness'].includes(kind)) throw err(4000, 'kind must be "blind" or "witness".');
        // how the site describes a token the wallet may not hold yet (shown as the site's words, never trusted for amounts)
        const ticker = /^[A-Za-z0-9]{1,12}$/.test(String(params.ticker || '')) ? String(params.ticker) : '';
        const precision = Number.isInteger(params.precision) && params.precision >= 0 && params.precision <= 18 ? params.precision : null;
        // an NFT (RGB21): one unit of an asset the wallet doesn't hold yet, so the invoice names no asset or amount
        const nft = params.nft === true;
        if (nft && baseUnits) throw err(4000, 'An NFT invoice takes no baseUnits.');
        const name = nft ? String(params.name || '').replace(/[^\p{L}\p{N} #'.,:-]/gu, '').slice(0, 40) : '';
        return openApproval(origin, 'rgbInvoice', { assetId, baseUnits, expiry, kind, ticker, precision, ...(nft ? { nft, name } : {}) });
      }
      case 'rgbPayInvoice': {
        needConnected();
        const invoice = typeof params.invoice === 'string' ? params.invoice.trim() : '';
        if (!/^rgb:/i.test(invoice) || invoice.length > 2000) throw err(4000, 'invoice must be an RGB invoice (rgb:…).');
        const assetId = optAssetId(params.assetId);
        const amount = params.amount == null || params.amount === '' ? '' : String(params.amount).replace(/,/g, '');
        if (amount && (!/^\d+(\.\d+)?$/.test(amount) || /^0+(\.0+)?$/.test(amount))) throw err(4000, 'amount must be a positive number of tokens (as wallets show them).');
        const feeRate = params.feeRate == null ? 0 : Number(params.feeRate);
        if (feeRate && (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > 500)) throw err(4000, 'feeRate must be between 1 and 500 sat/vB.');
        return openApproval(origin, 'rgbPay', { invoice, assetId, amount, feeRate });
      }
      // ---- RGB peer-to-peer swaps: tokens for BTC in one transaction, wallet to wallet ----
      case 'rgbListAssets':
        needConnected();
        return openApproval(origin, 'rgbListAssets', {});
      case 'rgbSwapAvailable':
        needConnected();
        return openApproval(origin, 'rgbSwapAvailable', { assetId: optAssetId(params.assetId) || (() => { throw err(4000, 'assetId is required.'); })() });
      case 'rgbBuyPrepare': case 'rgbSalePrepare': case 'rgbBuySign': case 'rgbSaleComplete': {
        needConnected();
        return openApproval(origin, method, swapParams(method, params));
      }
      // ---- Instant listings (pre-signed): the seller signs once; anyone buys it with the seller offline ----
      case 'rgbInstantList': case 'rgbInstantBuy': case 'rgbInstantCancel': {
        needConnected();
        return openApproval(origin, method, swapParams(method, params));
      }
      // several Instant listings of one token, one approval (a sweep): bought one after another
      case 'rgbInstantBuyMany': {
        needConnected();
        return openApproval(origin, method, sweepParams(params));
      }
      // ---- ecash (Cashu) ----
      case 'cashuGetLockKey': {
        needConnected();
        const d = bech32m.decode(pub.address, 120);
        return '02' + hex.encode(bech32m.fromWords(d.words.slice(1)));
      }
      case 'cashuPay': {
        needConnected();
        const amount = Number(params.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) throw err(4000, 'amount must be a whole number of sats (up to 10,000,000).');
        const mints = params.mints == null ? [] : params.mints;
        if (!Array.isArray(mints) || mints.length > 20 || mints.some((m) => typeof m !== 'string' || m.length > 200)) throw err(4000, 'mints must be a list of mint URLs.');
        if (params.lockTo != null && (typeof params.lockTo !== 'string' || params.lockTo.length > 120)) throw err(4000, 'lockTo must be a bc1p… address or a public key.');
        if (params.memo != null && (typeof params.memo !== 'string' || params.memo.length > 200)) throw err(4000, 'memo must be a short string.');
        return openApproval(origin, 'cashuPay', { amount, mints, lockTo: params.lockTo || '', memo: params.memo || '' });
      }
      case 'cashuPayRequest':
        needConnected();
        if (typeof params.request !== 'string' || !/^(cashu:)?creq[ab]/i.test(params.request) || params.request.length > 5000) throw err(4000, 'paymentRequest must be a Cashu payment request (creqA… or creqB…).');
        return openApproval(origin, 'cashuPayRequest', { request: params.request });
      case 'cashuReceive':
        needConnected();
        if (typeof params.token !== 'string' || !/^(cashu:)?cashu[AB]/.test(params.token) || params.token.length > 50000) throw err(4000, 'token must be a Cashu token (cashuA… or cashuB…).');
        return openApproval(origin, 'cashuReceive', { token: params.token });
      default: throw err(4200, `Method ${method} is not supported by MASKED.`);
    }
  };
}
