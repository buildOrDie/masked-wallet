// The approval window: a dApp's request (window.masked) opens the wallet with ?req=<id>. The controller
// loads the request from the background, prepares what the screen shows (fees, PSBT breakdown, the
// transactions to sign), and on approval signs, broadcasts and answers the background.
import { friendly } from '../core/format.mjs';
import { instantBuyVbytes, combinedBuyVbytes, combinedChunks, instantMoveVbytes, INSTANT_SEAL_SATS, txVbytes, P2TR_SCRIPT, OPRET_SCRIPT } from '../rgb/swap.mjs';
import { UNISAT_NET } from '../bitcoin/networks.mjs';
import { signMessageBip322, signMessageEcdsa } from '../bitcoin/messages.mjs';
import { TRADE_SITES } from '../trade/TradeAccount.mjs';

/** MASKED's own sites: "Share without asking next time" starts ticked there. */
const isMaskedSite = (origin) => { try { const h = new URL(origin).hostname; return h === 'maskedwallet.com' || h.endsWith('.maskedwallet.com'); } catch { return false; } };
import { lockKeyOf, peekToken } from '../ecash/EcashBook.mjs';
import { toBase, fromBase } from '../rgb/config.mjs';
import { rgbFundParts, proxyUrl, rgbError, RGB_CONFLICT_MSG } from '../rgb/WalletRgb.mjs';

/** Methods whose approve button waits for a prepared transaction. */
export const NEEDS_PREP = ['sendBitcoin', 'inscribeTransfer', 'shareTrade', 'fundTrade', 'moveToTrade', 'returnToShielded', 'cancelShielded', 'cashuPay', 'cashuPayRequest', 'cashuReceive', 'rgbInvoice', 'rgbPay', 'rgbSwapAvailable', 'rgbListAssets', 'rgbOutputs', 'rgbFreeSpare', 'rgbBuyPrepare', 'rgbSalePrepare', 'rgbBuySign', 'rgbSaleComplete', 'rgbInstantList', 'rgbInstantListLots', 'rgbInstantBuy', 'rgbInstantBuyMany', 'rgbInstantCancel', 'rgbP2pList', 'rgbP2pBuyPrepare', 'rgbP2pSaleSign', 'rgbP2pBuySign', 'rgbP2pSaleCommit', 'rgbP2pBuyAccept', 'rgbP2pSaleFinish', 'rgbP2pCancel'];
const SWAP_METHODS = ['rgbSwapAvailable', 'rgbListAssets', 'rgbOutputs', 'rgbFreeSpare', 'rgbOutputs', 'rgbBuyPrepare', 'rgbSalePrepare', 'rgbBuySign', 'rgbSaleComplete', 'rgbInstantList', 'rgbInstantListLots', 'rgbInstantBuy', 'rgbInstantBuyMany', 'rgbInstantCancel', 'rgbP2pList', 'rgbP2pBuyPrepare', 'rgbP2pSaleSign', 'rgbP2pBuySign', 'rgbP2pSaleCommit', 'rgbP2pBuyAccept', 'rgbP2pSaleFinish', 'rgbP2pCancel'];
const RGB_METHODS = ['rgbInvoice', 'rgbPay', ...SWAP_METHODS];
const SWAP_SIZE_VB = 320;
/** Steps that move this wallet's tokens: stopped while another copy of this wallet saved newer RGB data. */
// (receiving and buying too: tokens taken in here would be missing from the newer copy, and this copy couldn't back them up)
const MOVES_TOKENS = ['rgbFreeSpare', 'rgbInvoice', 'rgbPay', 'rgbBuyPrepare', 'rgbBuySign', 'rgbSalePrepare', 'rgbSaleComplete', 'rgbInstantList', 'rgbInstantListLots', 'rgbInstantBuy', 'rgbInstantBuyMany', 'rgbInstantCancel', 'rgbP2pBuyPrepare', 'rgbP2pSaleSign', 'rgbP2pBuySign', 'rgbP2pSaleCommit', 'rgbP2pBuyAccept', 'rgbP2pSaleFinish', 'rgbP2pCancel'];
/** P2P swap steps that already follow from one you approved (UniSat's flow): they run as soon as they're ready, no button. */
export const AUTO_RUN = ['rgbP2pSaleCommit', 'rgbP2pBuyAccept', 'rgbP2pSaleFinish', 'rgbP2pCancel'];
/** Kept on top of a purchase's own cost when topping up the RGB balance (the exact fee depends on the coins). */
const TOP_UP_MARGIN = 1000;
const BUYS = ['rgbBuyPrepare', 'rgbInstantBuy', 'rgbInstantBuyMany', 'rgbP2pBuyPrepare'];
/** A purchase the RGB balance can't pay: how much to add from the Bitcoin balance (null when it can). */
export function topUpFor(r, cost) {
  // a purchase also pays from coins not confirmed yet (the change of this wallet's own moves and purchases, bitcoin
  // just added): counting only confirmed ones asked people to add bitcoin they already had
  const f = r.freeBtc ? r.freeBtc() : { settled: 0, pending: 0 };
  const have = Number(f.settled || 0) + Number(f.pending || 0);
  return have >= cost + TOP_UP_MARGIN ? null : { sats: cost + TOP_UP_MARGIN, have };
}
/** The engine's "needs N sats" for a purchase, as a number (0 when the text says something else). */
export function shortfallOf(text) {
  const m = /RGB wallet needs (?:about |one bitcoin output over |one confirmed bitcoin output over )?([\d,]+) sats/i.exec(String(text || ''));
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}
const hostOf = (u) => { try { return new URL(proxyUrl(u)).host; } catch { return String(u); } };

export class ApprovalController {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.active = null; // { id, origin, method, params, loading, gone, done, prep, prepErr, prepBusy, … }
    this.port = null;
  }

  get id() { return this.app.platform.requestId; }
  get state() { return this.app.state; }

  async load() {
    const platform = this.app.platform, id = this.id;
    this.state.view = 'approve';
    this.active = { id, loading: true };
    this.app.render();
    // closing this popup (clicking away) tells the background to reject the request
    try { if (!this.port) this.port = platform.connect(`approval:${id}`); } catch {}
    try {
      const r = await platform.message({ type: 'getRequest', id });
      if (!r) { this.active = { id, gone: true }; this.app.render(); return; }
      this.active = { id, ...r, loading: false };
    } catch { this.active = { id, gone: true }; }
    this.prepare();
  }

  /** Build whatever the screen needs (fees, PSBT breakdown). Re-run after each sync. */
  prepare() {
    const app = this.app, a = this.active;
    if (!a || a.loading || a.gone || a.done) return app.render();
    const { trade, tokenTx, sync } = app;
    const rate = () => app.feeRate();
    try {
      if (a.method === 'sendBitcoin') {
        if (!app.coins.public.length && sync.syncing) { a.prep = null; return app.render(); }
        a.prepErr = null;
        app.builder.send({ from: 'public', to: a.params.toAddress, amount: Number(a.params.satoshis), rate: Number(a.params.options?.feeRate) || rate() })
          .then((b) => { a.prep = b; app.render(); })
          .catch((e) => { a.prepErr = friendly(e?.message || e); app.render(); });
      }
      // private trading: built once (they read the network); rebuilt after a sync if they failed
      const once = (fn) => {
        if (a.prep || a.prepBusy || (a.prepErr && (sync.syncing || a.errGen === sync.gen))) return;
        a.prepBusy = true; a.prepErr = null;
        fn().then((b) => { a.prep = b; if (AUTO_RUN.includes(a.method) && !a.autoRan && !this.state.busy) { a.autoRan = true; setTimeout(() => this.approve(), 0); } }).catch((e) => { a.prepErr = friendly(e?.message || e); a.errGen = sync.gen; }).finally(() => { a.prepBusy = false; app.render(); });
      };
      const P = a.params || {};
      const trading = a.method === 'inscribeTransfer' && (P.options?.account === 'trade' || P.options?.account === 'shielded');
      if (a.method === 'shareTrade') once(async () => {
        if (!app.account.canTrade) throw new Error('Private trading needs a wallet with its recovery phrase or spend key (not watch-only or demo).');
        await trade.discover();
        return trade.info();
      });
      if (a.method === 'fundTrade') once(() => trade.buildFund({ sats: Number(P.satoshis) || 0, padding: !!P.padding, rate: Number(P.feeRate) || rate() }));
      if (a.method === 'moveToTrade') once(() => trade.buildTokenMove({ tick: P.ticker, amt: P.amount, rate: rate() }));
      if (a.method === 'returnToShielded') once(() => (P.ticker ? trade.buildTokenMove({ tick: P.ticker, amt: P.amount, rate: rate(), back: true }) : trade.buildReturn({ rate: rate() })));
      if (trading) once(() => (P.options.account === 'shielded' ? trade.buildShieldedTransferInscribe({ tick: P.ticker, amt: P.amount, rate: rate() }) : trade.buildTransferInscribe({ tick: P.ticker, amt: P.amount, rate: rate() })));
      // ecash: which mint pays, what the site asked for
      const ecash = app.ecash;
      const needEcash = async () => { if (!ecash.on) throw new Error('Ecash needs a wallet with its own keys (not watch-only or demo).'); await ecash.load(); };
      if (a.method === 'cashuPay') once(async () => {
        await needEcash();
        if (P.lockTo) lockKeyOf(P.lockTo);
        return { url: ecash.pickMint(Number(P.amount), P.mints), amount: Number(P.amount), lockTo: P.lockTo, memo: P.memo };
      });
      if (a.method === 'cashuPayRequest') once(async () => {
        await needEcash();
        const r = ecash.parseRequest(P.request);
        return { ...r, url: ecash.pickMint(r.amount, r.mints) };
      });
      if (a.method === 'cashuReceive') once(async () => {
        await needEcash();
        const t = peekToken(P.token);
        if (t.unit !== 'sat') throw new Error('Only sat ecash is supported.');
        if (t.locks.length && !t.locks.some((k) => k.slice(2) === ecash.myLock.slice(2))) throw new Error('This token is locked to someone else.');
        return { ...t, known: ecash.mints.some((m) => m.url === t.mint) };
      });
      if (RGB_METHODS.includes(a.method)) this.prepareRgb(a, once);
      if (a.method === 'cancelShielded') once(() => trade.buildShieldedCancel({ outpoint: String(P.outpoint || ''), rate: rate() }));
      const psbt = a.method === 'signPsbt' || a.method === 'signPsbts';
      if (psbt && !a.tradeLoaded && trade.on) {
        a.tradeLoaded = true;
        trade.utxos().then((c) => { app.coins.trade = c; return app.ord.check(c); }).catch(() => {}).finally(() => this.prepare());
      }
      if (a.method === 'inscribeTransfer' && !trading) {
        a.prepErr = null;
        const go = () => tokenTx.transferInscribe({ tick: a.params.ticker, amt: a.params.amount, from: 'public', rate: rate() })
          .then((b) => { a.prep = b; app.render(); }).catch((e) => { a.prepErr = friendly(e?.message || e); app.render(); });
        if (!a.idxAsked && !app.tokens.publicToken(String(a.params.ticker).toLowerCase())) { a.idxAsked = true; app.tokens.refreshPublicTokens().then(go); } else go();
      }
      if (psbt && !a.ordChecked) { a.ordChecked = true; app.ord.check(app.coins.public).then(() => this.prepare()); }
      if (a.method === 'signPsbt') a.prep = [app.psbt.analyse(a.params.psbtHex, a.params.options || {})];
      if (a.method === 'signPsbts') a.prep = a.params.psbtHexs.map((h, k) => app.psbt.analyse(h, (a.params.options || [])[k] || {}));
      // the trade address and Shielded listings sign for MASKED's own website only
      if (psbt && a.prep.some((p) => p.trade) && !TRADE_SITES.has(a.origin)) { a.prep = null; throw new Error('Only maskedwallet.com can ask MASKED to sign for your trade address or Shielded listings.'); }
    } catch (e) { a.prepErr = friendly(e?.message || e); }
    app.render();
  }

  /**
   * RGB requests use the wallet's own RGB account. It opens by itself (as on Home); until then the screen waits.
   * @param {any} a @param {(fn: () => Promise<any>) => void} once
   */
  prepareRgb(a, once) {
    const app = this.app, r = app.rgb, P = a.params || {};
    if (a.prep || a.prepBusy) return;
    if (!r.available || (!r.exists && !r.ready)) {
      a.prepErr = r.offerable ? 'RGB is off. Open MASKED, turn on RGB (beta) on Home, then try again.' : 'RGB is not set up in this wallet yet. Open MASKED and turn on RGB on Home, then try again.';
      return;
    }
    if (!r.ready) {
      if (r.phase === 'allow' || r.phase === 'legacy') { a.prepErr = 'Open MASKED and finish setting up RGB on Home, then try again.'; return; }
      if (r.phase === 'error') { a.prepErr = r.message || 'RGB could not open. Open MASKED and try again.'; return; }
      r.ensure();
      a.prepErr = null; a.rgbWait = 'Opening RGB…';
      clearTimeout(a.rgbTimer);
      a.rgbTimer = setTimeout(() => this.prepare(), 1500);
      return;
    }
    a.rgbWait = '';
    if (SWAP_METHODS.includes(a.method)) return this.prepareSwap(a, once);
    if (a.method === 'rgbInvoice') once(async () => {
      if (r.requireLatest) await r.requireLatest();
      const asset = P.assetId ? r.find(P.assetId) : null;
      const base = P.baseUnits ? Number(P.baseUnits) : 0;
      if (P.nft && !r.service?.wallet?.canNft) throw new Error('This MASKED build can\'t hold NFTs yet. Update MASKED, then try again.');
      if (base && !Number.isSafeInteger(base)) throw new Error('That amount is too large.');
      const witness = P.kind ? P.kind === 'witness' : r.recvType() === 'witness';
      return {
        assetId: P.assetId || '', asset, amount: base, witness, expiry: Number(P.expiry) || 86400,
        // a token this wallet doesn't hold yet: in the site's words (ticker, decimals) when it gave them
        siteDescribed: !asset && ((base > 0 && Number.isInteger(P.precision)) || !!P.nft),
        nft: !!P.nft,
        shown: P.nft ? `1 NFT${P.name ? ` from ${P.name}` : P.ticker ? ` (${P.ticker})` : ''}` : base ? (asset ? `${r.amount(asset, base)} ${asset.ticker}`
          : Number.isInteger(P.precision) ? `${fromBase(base, P.precision)} ${P.ticker || 'tokens'}` : `${base.toLocaleString('en-US')} units`) : 'Any amount',
        newToken: !!P.assetId && !asset,
      };
    });
    if (a.method === 'rgbPay') once(async () => {
      if (r.requireLatest) await r.requireLatest(); else if (r.cloud?.conflict) throw new Error(RGB_CONFLICT_MSG);
      let d;
      try { d = await r.service.decode(P.invoice); } catch { throw new Error('That is not a valid RGB invoice.'); }
      if (!/utxob:|wvout:/.test(String(d.recipientId || ''))) throw new Error('This is not an RGB invoice MASKED can pay.');
      if (!r.profile.invoiceNets.includes(String(d.network).toLowerCase())) throw new Error(`This invoice is not for ${r.profile.label}.`);
      if (d.expirationTimestamp && d.expirationTimestamp <= Date.now() / 1000) throw new Error('This invoice has expired. Ask the site for a new one.');
      if (d.assetId && P.assetId && d.assetId !== P.assetId) throw new Error('The invoice is for a different token than the site said.');
      const assetId = d.assetId || P.assetId;
      if (!assetId) throw new Error('The site did not say which token to send.');
      const asset = r.find(assetId);
      if (!asset) throw new Error('You don\'t hold this token in RGB.');
      let amount = d.amount || 0;
      if (P.amount) {
        const asked = toBase(P.amount, asset.precision);
        if (amount && asked !== amount) throw new Error('The amount the site asked for does not match the invoice.');
        amount = asked;
      }
      if (amount && amount > r.bal(asset).spendable) throw new Error(`You can send up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
      const endpoints = d.transportEndpoints?.length ? d.transportEndpoints : [r.profile.sdk.transportEndpoint];
      const ask = await r.missingOrigins(endpoints);
      if (ask.length) throw new Error(`MASKED isn't allowed to reach the transfer server ${ask.map(hostOf).join(', ')}. Send this once from MASKED (RGB → Send) to allow it, or use an invoice with proxy.iriswallet.com.`);
      let endpoint = '', why = '';
      for (const e of endpoints) {
        try { await r.service.checkProxy(proxyUrl(e)); endpoint = e; break; } catch (err) { why = String(err?.message || err); }
      }
      if (!endpoint) throw new Error(`The transfer server in this invoice is not answering. ${why}`.trim());
      const fee = P.feeRate ? String(Math.round(P.feeRate)) : r.fee();
      return { assetId, asset, ticker: asset.ticker, amount, shown: amount ? r.amount(asset, amount) : '', needAmount: !amount, witness: !!d.witness, endpoint, proxy: hostOf(endpoint), fee, spendable: r.amount(asset, r.bal(asset).spendable) };
    });
  }

  /** One RGB step at a time: Home's minute refresh waits while this runs. */
  async rgbBusy(fn) {
    const r = this.app.rgb;
    // a refresh is running (slow on a busy block server): wait for it instead of failing straight away
    for (const until = Date.now() + 90000; r.busy && Date.now() < until;) await new Promise((ok) => setTimeout(ok, 250));
    if (r.busy) throw new Error('RGB is busy. Try again in a moment.');
    r.busy = true;
    try { return await fn(); } finally { r.busy = false; }
  }

  /** What a swap step's screen shows: the token (if this wallet knows it), the amount and the price. */
  prepareSwap(a, once) {
    const r = this.app.rgb, P = a.params || {}, m = a.method;
    once(async () => {
      // the market works from what this wallet knows: catch up first (a claim, a purchase or a sale that arrived, a
      // move that confirmed), unless that was just done. Without it, a wallet that was closed a while trips on its
      // own stale records ("none of its inputs…", "not settled and free", wrong balances)
      // only reading (which tokens, what's where): what MASKED saw in the last 10 minutes is good enough, so the
      // screen is ready at once instead of after a catch-up with the chain
      // an Instant buy syncs the coins it pays with itself and checks the listing on the chain: no catch-up first
      // (it held the screen for a whole refresh, 2.31.1)
      const maxAge = m === 'rgbListAssets' || m === 'rgbOutputs' ? 600_000 : m === 'rgbInstantBuy' || m === 'rgbInstantBuyMany' ? Infinity : 60_000;
      if (r.ready && typeof r.refresh === 'function' && Date.now() - (r.sharedRefreshAt ? r.sharedRefreshAt() : r.refreshedAt || 0) > maxAge) {
        try { await this.rgbBusy(() => r.refresh()); } catch { /* the step itself says what's wrong */ }
      }
      if (m === 'rgbFreeSpare') {
        if (typeof r.service?.freeSpare !== 'function') throw new Error('This MASKED version can\'t free spare outputs yet. Update MASKED.');
        if (r.requireLatest) await r.requireLatest(); else if (r.cloud?.conflict) throw new Error(RGB_CONFLICT_MSG);
        const rep = await this.rgbBusy(() => r.service.outputsReport());
        if (!rep.canFreeSpare) throw new Error('This RGB engine can\'t free spare outputs yet. Update MASKED (engine/build.sh).');
        const spare = (rep.rgb || []).filter((o) => o.state === 'empty');
        const keep = rep.keepSpare ?? 6;
        if (spare.length <= keep && !rep.unpaidReceives) throw new Error(`Only ${spare.length} spare RGB outputs: MASKED keeps ${keep} for receiving tokens, so there's nothing to free.`);
        const freed = spare.slice(keep);
        const coins = (rep.coins || []).filter((c) => !c.justSpent);
        return { keep, freed: freed.length, sats: freed.reduce((n, o) => n + o.sats, 0), coinSats: coins.reduce((n, c) => n + c.sats, 0), unpaid: rep.unpaidReceives || 0, rate: P.feeRate || Number(r.fee()) };
      }
      if (m === 'rgbOutputs') return { list: r.assets().map((x) => ({ ticker: x.ticker, assetId: x.assetId })) };
      if (m === 'rgbListAssets') { if (a.remember == null) a.remember = isMaskedSite(a.origin); return { list: r.assets().map((x) => ({ ticker: x.ticker, assetId: x.assetId })) }; }
      if (!r.service?.canSwap) throw new Error('This MASKED version can\'t swap RGB tokens yet. Update MASKED.');
      if (MOVES_TOKENS.includes(m)) { if (r.requireLatest) await r.requireLatest(); else if (r.cloud?.conflict) throw new Error(RGB_CONFLICT_MSG); }
      if (m === 'rgbSwapAvailable') {
        const asset = r.find(P.assetId);
        return { asset, assetId: P.assetId };
      }
      if (m === 'rgbInstantListLots') {
        if (!r.service.canPresign || typeof r.service.instantListLots !== 'function') throw new Error('This MASKED version can\'t list in lots yet. Update MASKED.');
        const net = r.isMain ? 'mainnet' : 'signet';
        if (P.network && !String(P.network).toLowerCase().startsWith(net)) throw new Error(`The site is on ${P.network}, your RGB wallet is on ${r.profile.label}.`);
        const asset = r.find(P.assetId);
        if (!asset) throw new Error('You don\'t hold this token in RGB.');
        const lots = P.lots || [];
        const total = lots.reduce((t, x) => t + Number(x.amount), 0);
        const price = lots.reduce((t, x) => t + Number(x.priceSats), 0);
        if (total > r.bal(asset).spendable) throw new Error(`You can list up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
        let host = ''; try { host = new URL(P.market).host; } catch { throw new Error('The market address is not valid.'); }
        const rate = P.feeRate || Number(r.fee());
        // one move per lot: a token output and a bitcoin coin in; the commitment, the lot, the rest of the tokens and the
        // bitcoin back out (MASKED with the newer engine: all of them now, every lot signed at once)
        const atOnce = !!r.service.wallet?.canChainLots;
        // 2.30.2 engine: every lot in one transaction (one output each) instead of one move per lot
        const oneTx = !!r.service.wallet?.canSplitOnce && lots.length <= 20;
        const vb = oneTx
          ? Math.ceil(txVbytes([P2TR_SCRIPT, P2TR_SCRIPT], [OPRET_SCRIPT, ...lots.map(() => P2TR_SCRIPT), P2TR_SCRIPT, P2TR_SCRIPT]))
          : lots.length * Math.ceil(txVbytes([P2TR_SCRIPT, P2TR_SCRIPT], [OPRET_SCRIPT, P2TR_SCRIPT, P2TR_SCRIPT, P2TR_SCRIPT]));
        const each = lots.map((x) => ({ shown: r.amount(asset, Number(x.amount)), price: Number(x.priceSats) }));
        const same = each.every((x) => x.shown === each[0].shown && x.price === each[0].price);
        return { asset, assetId: P.assetId, shown: `${r.amount(asset, total)} ${asset.ticker}`, price, n: lots.length, each, same, market: host, rate, vb, fee: Math.ceil(rate * vb), seal: INSTANT_SEAL_SATS * lots.length, atOnce, oneTx };
      }
      if (m === 'rgbInstantBuyMany') {
        if (!r.service.canPresign) throw new Error('This MASKED version can\'t do Instant listings yet. Update MASKED.');
        const items = P.items || [], first = items[0]?.offer || {};
        const net = r.isMain ? 'mainnet' : 'signet';
        if (P.network && !String(P.network).toLowerCase().startsWith(net)) throw new Error(`The site is on ${P.network}, your RGB wallet is on ${r.profile.label}.`);
        const asset = r.find(first.assetId);
        const total = items.reduce((t, x) => t + Number(x.offer.amount), 0);
        const price = items.reduce((t, x) => t + Number(x.offer.priceSats), 0);
        const units = items.map((x) => Number(x.offer.priceSats) / (Number(x.offer.amount) / 10 ** (asset?.precision || 0))); // sats per whole token
        const rate = P.feeRate || Number(r.fee());
        // combined (2.30): one transaction per COMBINED_MAX listings, one seal each; else one purchase per listing
        const combined = !!r.service.canCombine && items.length >= 2;
        const sizes = combined ? combinedChunks(items.length) : Array(items.length).fill(1);
        const vb = sizes.reduce((t, k) => t + (k >= 2 ? combinedBuyVbytes(k) : instantBuyVbytes(1, true)), 0);
        const fee = sizes.reduce((t, k) => t + Math.ceil(rate * (k >= 2 ? combinedBuyVbytes(k) : instantBuyVbytes(1, true))), 0), seal = INSTANT_SEAL_SATS * sizes.length;
        const oneByOne = Math.ceil(rate * instantBuyVbytes(1, true)) * items.length;
        const shown = asset ? `${r.amount(asset, total)} ${asset.ticker}` : `${total.toLocaleString('en-US')} units`;
        return { asset, assetId: first.assetId, shown, price, newToken: !asset, fee, rate, vb, seal, n: items.length, txs: sizes.length, combined, saved: combined ? Math.max(0, oneByOne + INSTANT_SEAL_SATS * items.length - fee - seal) : 0, lo: Math.min(...units), hi: Math.max(...units), topUp: topUpFor(r, price + fee + seal) };
      }
      const o = P.offer || {};
      const net = r.isMain ? 'mainnet' : 'signet';
      if (P.network && !String(P.network).toLowerCase().startsWith(net === 'mainnet' ? 'mainnet' : 'signet')) throw new Error(`The site is on ${P.network}, your RGB wallet is on ${r.profile.label}.`);
      const asset = r.find(o.assetId);
      const shown = asset ? `${r.amount(asset, Number(o.amount))} ${asset.ticker}` : `${Number(o.amount).toLocaleString('en-US')} units`;
      const base = { asset, assetId: o.assetId, shown, price: Number(o.priceSats), newToken: !asset };
      if (m === 'rgbBuyPrepare') {
        const rate = P.feeRate || Number(r.fee());
        const fee = Math.ceil(rate * SWAP_SIZE_VB);
        return { ...base, fee, rate, topUp: topUpFor(r, base.price + fee) };
      }
      if (m === 'rgbInstantList' || m === 'rgbInstantBuy' || m === 'rgbInstantCancel') {
        if (!r.service.canPresign) throw new Error('This MASKED version can\'t do Instant listings yet. Update MASKED.');
        const rate = P.feeRate || Number(r.fee());
        // usual sizes (one coin of yours, taproot); the wallet works out the exact fee from the real coins
        const vb = m === 'rgbInstantBuy' ? instantBuyVbytes(1, true) : instantMoveVbytes(1);
        const fee = Math.ceil(rate * vb);
        if (m === 'rgbInstantBuy') return { ...base, fee, rate, vb, seal: INSTANT_SEAL_SATS, topUp: topUpFor(r, base.price + fee + INSTANT_SEAL_SATS) };
        if (m === 'rgbInstantList') {
          if (!asset) throw new Error('You don\'t hold this token in RGB.');
          // asked again for a listing whose tokens are moving (Finish listing): no new transaction, just the signing
          const was = r.service.instantStore().get(P.offerId);
          if (was?.role === 'seller' && was.stage === 'moving') {
            let host = ''; try { host = new URL(P.market).host; } catch { throw new Error('The market address is not valid.'); }
            return { ...base, fee: 0, rate, vb, market: host, finishing: true };
          }
          if (Number(o.amount) > r.bal(asset).spendable) throw new Error(`You can sell up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
          let host = ''; try { host = new URL(P.market).host; } catch { throw new Error('The market address is not valid.'); }
          return { ...base, fee, rate, vb, market: host };
        }
        const e = r.service.instantStore().get(P.offerId);
        // made in another copy of this wallet: cancelled from its output, if this wallet holds it
        if ((!e || e.role !== 'seller') && P.sellerOutpoint) return { ...base, fee, rate, vb, stage: 'ready', fromOutput: true };
        if (!e || e.role !== 'seller') throw new Error('This wallet has no Instant listing with that id.');
        return { ...base, fee: e.stage === 'ready' ? fee : 0, rate, vb, stage: e.stage };
      }
      if (m.startsWith('rgbP2p')) {
        if (!r.service.canP2p) throw new Error('This MASKED version can\'t trade with other wallets yet. Update MASKED.');
        if (m === 'rgbP2pList' || m === 'rgbP2pSaleSign') {
          if (!asset) throw new Error('You don\'t hold this token in RGB.');
          if (Number(o.amount) > r.bal(asset).spendable) throw new Error(`You can sell up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
          return { ...base, p2p: true };
        }
        if (m === 'rgbP2pBuyPrepare') {
          const rate = P.feeRate || Number(r.fee());
          const fee = Math.max(500, Math.ceil(rate * txVbytes([P2TR_SCRIPT, P2TR_SCRIPT], [OPRET_SCRIPT, P2TR_SCRIPT, P2TR_SCRIPT])));
          return { ...base, fee, rate, p2p: true, topUp: topUpFor(r, base.price + fee) };
        }
        const stored = r.service.swapStore('p2p').get(P.offerId);
        if (!stored && m !== 'rgbP2pCancel') throw new Error('This wallet has no part in that trade (or it already finished).');
        return { ...base, p2p: true, fee: stored?.feeSats ? Number(stored.feeSats) : null };
      }
      if (m === 'rgbSalePrepare') {
        if (!asset) throw new Error('You don\'t hold this token in RGB.');
        if (Number(o.amount) > r.bal(asset).spendable) throw new Error(`You can sell up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
        return base;
      }
      const stored = r.service.swapStore(m === 'rgbBuySign' ? 'bought' : 'sold').get(P.offerId);
      if (!stored) throw new Error(m === 'rgbBuySign' ? 'This wallet did not prepare that purchase (or it was already signed).' : 'This wallet did not prepare that sale (or it was already sent).');
      return { ...base, fee: stored.feeSats ? Number(stored.feeSats) : null };
    });
  }

  /** Mainnet: RGB changes must be in a backup before tokens can depend on them. */
  async rgbBackedUp(r) {
    if (!r.isMain) return;
    if (r.cloudOn && r.service?.backupRequired) await r.cloudSave();
    if (!r.service?.everBackedUp || (r.cloudOn && r.service?.backupRequired)) throw new Error('MASKED couldn\'t back up RGB just now. Open MASKED, check Settings → RGB backup, then try again.');
  }

  /** After a send to an invoice: the other side accepts, then the transaction goes out. Wait up to a minute. */
  async rgbWaitBroadcast(r, assetId, batch) {
    for (let i = 0; i < 12; i++) {
      await new Promise((ok) => setTimeout(ok, 5000));
      // the transfer server only: waiting for an answer needs no block server sync (12 syncs a minute before)
      try { await r.refresh(false, { sync: false }); } catch { continue; }
      const t = (r.data?.transfers?.[assetId] || []).find((x) => Number(x?.batchTransferIdx) === Number(batch));
      if (t && String(t.status) === 'Failed') return 'failed';
      if (t && !['WaitingCounterparty', 'Initiated'].includes(String(t.status))) return 'broadcast';
      this.active.rgbWait = 'Waiting for the other side to accept…'; this.app.render();
    }
    return 'waiting';
  }

  finish(payload) {
    const a = this.active;
    a.done = true;
    this.app.render();
    // the extension's approval window closes; the phone app goes back to the market (AppMarket)
    this.app.platform.message({ type: 'resolveRequest', id: a.id, ...payload }).finally(() => { if (!this.app.platform.local) setTimeout(() => window.close(), 150); });
  }

  /** The purchase screen's "Add to RGB balance": exactly what the purchase needs, from the Bitcoin balance. */
  async topUp() {
    const app = this.app, state = this.state, a = this.active, r = app.rgb, t = a?.prep?.topUp;
    if (!t || t.sent || !r?.data?.address) return;
    state.busy = true; app.render();
    try {
      // RGB approval windows don't scan the Public balance on open: its coins are read now (one request)
      try { await app.coins.syncPublic(); } catch { /* the last known coins */ }
      const b = await app.builder.send({ from: 'public', to: r.data.address, amount: t.sats, rate: app.feeRate(), parts: rgbFundParts(t.sats) });
      await app.broadcast(b.hex);
      await app.afterBroadcast?.(b.spent, [b.txid]);
      r.fundedAt = Date.now();
      a.prep = { ...a.prep, topUp: { ...t, sent: b.txid } };
      state.status.approve = [`Added ${t.sats.toLocaleString('en-US')} sats to your RGB balance. It's ready after one block (about 10 minutes). Then try again.`, 'ok'];
    } catch (e) {
      state.status.approve = [friendly(String(e?.message || e)) || 'Could not add to the RGB balance.', 'err'];
    } finally { state.busy = false; app.render(); }
  }

  reject() { this.finish({ error: { code: 4001, message: 'User rejected the request.' } }); }

  async approve() {
    const app = this.app, state = this.state, a = this.active;
    state.busy = true; app.render();
    try {
      this.finish({ result: await this.run(a) });
    } catch (e) {
      // the RGB engine throws plain strings, not Error objects: show them too, never an empty line
      let text = /^rgb/.test(a.method) ? rgbError(e, app.rgb?.profile) : String(e?.message || e || '');
      // a purchase the RGB balance can't pay: offer to add exactly what it needs (one tap, shown on this screen)
      const short = BUYS.includes(a.method) ? shortfallOf(text) : 0;
      if (short && a.prep) {
        a.prep = { ...a.prep, topUp: { sats: short + TOP_UP_MARGIN, have: app.rgb?.freeBtc?.().settled || 0 } };
        text = 'Your RGB balance is too low for this purchase. Add to it below, wait for one block, then try again.';
      } else if (/^rgb/.test(a.method) && /Tap Add (BTC for RGB|to RGB balance|from Bitcoin)/.test(text) && app.rgb && !app.rgb.isMain) {
        // short of bitcoin for RGB's fee on a test network: top up from Public now, so the next try works
        app.rgb.fundedAt = 0;
        if (await app.rgb.autoFund().catch(() => false)) text = 'MASKED added test BTC to RGB from your Public balance, for the network fee. Wait for one block (about 10 minutes), then try again.';
      }
      console.error('[MASKED] approval failed', a.method, e);
      state.status.approve = [friendly(text) || 'Something went wrong. Try again.', 'err'];
    } finally { state.busy = false; app.render(); }
  }

  /** Carry out an approved request; returns what the dApp gets back. */
  async run(a) {
    const app = this.app, { account, trade } = app;
    // what the slow steps are doing, shown under the request while "Working…"
    const step = (text) => { this.state.status.approve = [text, '']; app.render(); };
    // the main MASKED window refreshes its own balances: don't keep this window open for a second sync
    const later = (r) => setTimeout(() => r.run(() => r.refresh(), { quiet: true }), 0);
    const prepared = (what = 'the transaction') => { if (!a.prep) throw new Error(a.prepErr || `Still preparing${what ? ` ${what}` : ''}.`); return a.prep; };
    const risky = () => { throw new Error('Tick the box to confirm spending an inscription coin.'); };
    switch (a.method) {
      case 'requestAccounts': return [account.pubAddr()];
      case 'signMessage': {
        const priv = account.keys.accountPriv();
        return a.params.type === 'bip322-simple' ? signMessageBip322(a.params.message, account.funding(), priv) : signMessageEcdsa(a.params.message, priv);
      }
      case 'signPsbt':
        if (a.prep[0].protectedCount && !app.state.f.apRisk) risky();
        return app.psbt.sign(a.params.psbtHex, a.params.options || {});
      case 'signPsbts':
        if (a.prep.some((p) => p.protectedCount) && !app.state.f.apRisk) risky();
        return a.params.psbtHexs.map((h, k) => app.psbt.sign(h, (a.params.options || [])[k] || {}));
      case 'sendBitcoin': {
        const b = prepared();
        if (app.lookAlike(a.params.toAddress) && !app.state.f.apRisk) throw new Error('Tick the box to confirm this look-alike address.');
        await app.broadcast(b.hex);
        app.afterBroadcast(b.spent || [b.coin.key], [b.txid]);
        app.rememberRecipient(a.params.toAddress);
        return b.txid;
      }
      case 'shareTrade':
        prepared('');
        trade.enable();
        return trade.info();
      case 'fundTrade': {
        const b = prepared();
        await app.broadcast(b.hex);
        app.afterBroadcast(b.spentKeys, [b.txid]);
        return { txid: b.txid, address: b.address, outputs: b.outputs };
      }
      case 'moveToTrade': case 'returnToShielded': {
        const b = prepared();
        if (b.op === 'tsend') {
          await app.broadcast(b.commitHex); await app.broadcast(b.revealHex); await app.broadcast(b.sendHex);
          app.transfers.addSend(b);
          app.inscriptions.set(`${b.sendTxid}:0`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId });
          if (b.fromKind === 'trade') trade.addPending(b.tick, b.amt, b.revealTxid, trade.current().address);
          app.afterBroadcast(b.spent, [b.commitTxid, b.revealTxid, b.sendTxid]);
          return { txid: b.sendTxid, inscriptionId: b.inscriptionId, ticker: b.tick, amount: b.amt, address: trade.current().address };
        }
        if (!b.empty) { await app.broadcast(b.hex); app.afterBroadcast(b.spentKeys, [b.txid]); }
        const renewed = await trade.maybeRenew(true).catch(() => false);
        return { txid: b.txid || null, address: trade.current().address, renewed };
      }
      case 'inscribeTransfer': {
        const b = prepared('the inscription');
        await app.broadcast(b.commitHex);
        await app.broadcast(b.revealHex);
        app.inscriptions.set(`${b.revealTxid}:${b.revealOut}`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId, ready: true });
        if (b.shieldedListing) trade.recordShieldedListing(b);
        else if (b.tradeAddress) trade.addPending(b.tick, b.amt, b.revealTxid, b.tradeAddress);
        else app.pending.add('transfer', b.tick, b.amt, b.revealTxid);
        app.afterBroadcast(b.spent, [b.commitTxid, b.revealTxid]);
        return { inscriptionId: b.inscriptionId, txid: b.revealTxid, commitTxid: b.commitTxid, ticker: b.tick, amount: b.amt, ...(b.shieldedListing ? { address: b.holderAddress, outpoint: `${b.revealTxid}:${b.revealOut}`, value: b.estimate.revealValue } : {}) };
      }
      case 'cancelShielded': {
        const b = prepared();
        await app.broadcast(b.hex);
        // the transfer inscription comes back to a new Shielded coin, and the tokens with it
        app.transfers.save(app.transfers.list().filter((t) => t.listing !== b.coin.key));
        if (b.tick) app.inscriptions.set(`${b.txid}:0`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, received: true });
        app.afterBroadcast(b.spentKeys, [b.txid]);
        return { txid: b.txid };
      }
      case 'switchNetwork': app.setNet(a.params.target); return UNISAT_NET[a.params.target];
      case 'cashuPay': {
        const b = prepared('');
        const r = await app.ecash.send({ url: b.url, amount: b.amount, lockTo: b.lockTo, label: b.memo || `Paid to ${new URL(a.origin).host}` });
        return { token: r.token, mint: b.url, amount: r.amount };
      }
      case 'cashuPayRequest': {
        const b = prepared('');
        if (b.post) await app.platform.requestOrigin(b.post);
        return app.ecash.payRequest({ ...b, memo: b.memo || `Paid to ${new URL(a.origin).host}` }, b.url);
      }
      case 'cashuReceive': {
        const b = prepared('');
        if (!b.known) await app.platform.requestOrigin(b.mint);
        const r = await app.ecash.receive(b.token);
        return { amount: r.amount, mint: r.mint };
      }
      case 'rgbInvoice': return this.rgbBusy(async () => {
        const b = prepared(''), r = app.rgb;
        await this.rgbBackedUp(r);
        const opts = { assetId: b.assetId, amount: b.amount, durationSeconds: b.expiry, witness: b.witness };
        const res = b.witness ? await r.service.receive(opts) : await r.withOutputs(() => r.service.receive(opts));
        r.logInvoice({ invoice: res.invoice, recipientId: res.recipientId, at: Date.now(), expiresAt: Number(res.expirationTimestamp) || Math.floor(Date.now() / 1000) + b.expiry, witness: b.witness, amount: b.amount && b.asset ? r.amount(b.asset, b.amount) : '', ticker: b.asset?.ticker || '', expiry: b.expiry, site: new URL(a.origin).host });
        // the invoice is only safe to hand out once it is in a backup (mainnet)
        await this.rgbBackedUp(r);
        if (!r.canShareInvoice) throw new Error('Save your RGB backup first (Settings → RGB backup): the invoice is only safe to use once it is backed up.');
        return { invoice: res.invoice, recipientId: res.recipientId, expirationTimestamp: res.expirationTimestamp ?? null, witness: b.witness };
      });
      case 'rgbPay': return this.rgbBusy(async () => {
        const b = prepared(''), r = app.rgb;
        let amount = b.amount;
        if (b.needAmount) {
          amount = toBase(String(this.state.f.apRgbAmt || '').trim(), b.asset.precision);
          if (amount > r.bal(b.asset).spendable) throw new Error(`You can send up to ${b.spendable} ${b.ticker}.`);
        }
        await this.rgbBackedUp(r);
        const res = await r.service.send({ invoice: a.params.invoice, assetId: b.assetId, amount: String(amount), fee: b.fee, endpoint: b.endpoint });
        await r.refresh().catch(() => {});
        await this.rgbBackedUp(r).catch(() => {}); // the send is out either way; Home reminds about the backup
        const status = await this.rgbWaitBroadcast(r, b.assetId, res?.batchTransferIdx);
        if (status === 'failed') throw new Error('The other side refused the transfer. Nothing was sent.');
        return { txid: String(res?.txid || ''), batchTransferIdx: res?.batchTransferIdx ?? null, amount: String(amount), status };
      });
      case 'rgbFreeSpare': return this.rgbBusy(async () => {
        const b = prepared(''), r = app.rgb;
        await this.rgbBackedUp(r);
        const out = await r.service.freeSpare({ fee: a.params.feeRate || b.rate });
        await r.refresh().catch(() => {});
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      case 'rgbOutputs': return this.rgbBusy(async () => { prepared(''); return app.rgb.withoutDropped(await app.rgb.service.outputsReport()); });
      case 'rgbListAssets': return this.rgbBusy(async () => {
        prepared('');
        const list = app.rgb.withoutDropped(await app.rgb.service.assetList());
        await app.rgb.publishShare?.(list).catch(() => {});
        // "Share without asking next time": the site gets this list at once from now on (until you disconnect it)
        if (a.remember && app.platform?.hasExt) {
          try { const all = (await app.platform.storageGet('masked.sites')) || {}; if (all[a.origin]) { all[a.origin] = { ...all[a.origin], rgbShare: true }; await app.platform.storageSet({ 'masked.sites': all }); } } catch { /* asks again next time */ }
        }
        return list;
      });
      case 'rgbSwapAvailable': return this.rgbBusy(async () => { prepared(''); return app.rgb.service.offerableAmount({ assetId: a.params.assetId }); });
      case 'rgbBuyPrepare': return this.rgbBusy(async () => {
        const b = prepared(''), r = app.rgb;
        await this.rgbBackedUp(r);
        const session = await r.service.prepareBuy({ ...a.params, feeRate: b.rate });
        // the buyer's invoice is only safe to hand out once it's in a backup (mainnet)
        await this.rgbBackedUp(r);
        if (!r.canShareInvoice) throw new Error('Save your RGB backup first (Settings → RGB backup), then try again.');
        return session;
      });
      case 'rgbSalePrepare': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb;
        await this.rgbBackedUp(r);
        const out = await r.service.prepareSale(a.params);
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      case 'rgbBuySign': return this.rgbBusy(async () => { prepared(''); return app.rgb.service.signBuy(a.params); });
      case 'rgbInstantList': step('Waiting for RGB…'); return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params, o = P.offer;
        await this.rgbBackedUp(r);
        const out = await r.service.instantList({ offerId: P.offerId, assetId: o.assetId, amount: o.amount, priceSats: o.priceSats, feeRate: P.feeRate || Number(r.fee()), market: P.market, token: P.token, onStep: step });
        await this.rgbBackedUp(r).catch(() => {});
        later(r);
        return out;
      });
      case 'rgbInstantListLots': step('Waiting for RGB…'); return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params;
        await this.rgbBackedUp(r);
        const out = await r.service.instantListLots({ assetId: P.assetId, lots: P.lots, feeRate: P.feeRate || Number(r.fee()), market: P.market, onStep: step });
        await this.rgbBackedUp(r).catch(() => {});
        later(r);
        return out;
      });
      case 'rgbInstantBuy': step('Waiting for RGB…'); return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params;
        const out = await r.service.instantBuy({ ...P, feeRate: P.feeRate || Number(r.fee()), quick: true, onStep: step });
        later(r);
        return out;
      });
      case 'rgbInstantBuyMany': step('Waiting for RGB…'); return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params, n = P.items.length;
        const feeRate = P.feeRate || Number(r.fee());
        const results = [];
        // 2.30: up to COMBINED_MAX listings in one transaction (about 100 vB per extra listing instead of a whole
        // purchase each); when they can't be combined (one coin only, a listing gone…), one after another
        const sizes = r.service.canCombine && n >= 2 ? combinedChunks(n) : Array(n).fill(1);
        const ranOut = 'Not bought: the RGB balance ran out.';
        let from = 0, stop = false;
        for (const size of sizes) {
          const part = P.items.slice(from, from + size), first = from;
          from += size;
          if (stop) { for (const y of part) results.push({ offerId: y.offerId, error: ranOut }); continue; }
          if (size >= 2) {
            const label = `${first + 1}–${first + size} of ${n}`;
            try {
              const out = await r.service.instantBuyCombined({ items: part, network: P.network, feeRate, onStep: (t) => step(`${label}: ${t}`) });
              if (out?.txid) { for (const y of part) results.push({ offerId: y.offerId, txid: out.txid }); continue; }
            } catch (e) {
              // the combined purchase may have gone out: kept, and sent again on the next refresh
              const error = rgbError(e, r.profile);
              for (const y of part) results.push({ offerId: y.offerId, error });
              continue;
            }
          }
          for (let j = 0; j < part.length; j++) {
            const x = part[j], k = first + j;
            try {
              const out = await r.service.instantBuy({ ...x, network: P.network, feeRate, onStep: (t) => step(`${k + 1} of ${n}: ${t}`) });
              results.push({ offerId: x.offerId, txid: out.txid });
            } catch (e) {
              const error = rgbError(e, r.profile);
              results.push({ offerId: x.offerId, error });
              // out of bitcoin: the rest would fail the same way, so they're left (nothing paid for them)
              if (shortfallOf(error) || /Not enough bitcoin|RGB balance/i.test(error)) { for (const y of part.slice(j + 1)) results.push({ offerId: y.offerId, error: ranOut }); stop = true; break; }
            }
          }
        }
        later(r);
        if (!results.some((x) => x.txid)) throw new Error(results[0]?.error || 'Nothing was bought.');
        return { results };
      });
      case 'rgbInstantCancel': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params;
        const out = await r.service.instantCancel({ offerId: P.offerId, feeRate: P.feeRate || Number(r.fee()), sellerOutpoint: P.sellerOutpoint || '', offer: P.offer });
        await r.refresh().catch(() => {});
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      // wallet-to-wallet swaps in UniSat's P2P flow (2.31)
      case 'rgbP2pList': return this.rgbBusy(async () => { prepared(''); const o = a.params.offer; return app.rgb.service.p2pListable({ assetId: o.assetId, amount: o.amount, partial: !!a.params.partial }); });
      case 'rgbP2pBuyPrepare': return this.rgbBusy(async () => {
        const b = prepared(''), r = app.rgb, P = a.params, o = P.offer;
        await this.rgbBackedUp(r);
        const out = await r.service.p2pBuyPrepare({ tradeId: P.offerId, assetId: o.assetId, amount: o.amount, priceSats: o.priceSats, seller: P.seller, partial: !!P.partial, sealAmount: P.sealAmount ?? null, feeRate: b.rate });
        await this.rgbBackedUp(r);
        if (!r.canShareInvoice) throw new Error('Save your RGB backup first (Settings → RGB backup), then try again.');
        return out;
      });
      case 'rgbP2pSaleSign': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params, o = P.offer;
        await this.rgbBackedUp(r);
        const out = await r.service.p2pSaleSign({ tradeId: P.offerId, assetId: o.assetId, amount: o.amount, priceSats: o.priceSats, invoice: P.invoice, draftPsbtHex: P.draftPsbtHex });
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      case 'rgbP2pBuySign': return this.rgbBusy(async () => { prepared(''); const P = a.params; return app.rgb.service.p2pBuySign({ tradeId: P.offerId, coloredPsbtHex: P.coloredPsbtHex, txid: P.txid }); });
      case 'rgbP2pSaleCommit': return this.rgbBusy(async () => { prepared(''); const P = a.params; return app.rgb.service.p2pSaleCommit({ tradeId: P.offerId, buyerSignedPsbtHex: P.buyerSignedPsbtHex }); });
      case 'rgbP2pBuyAccept': return this.rgbBusy(async () => { prepared(''); const r = app.rgb, P = a.params; const out = await r.service.p2pBuyAccept({ tradeId: P.offerId, commitment: P.commitment }); later(r); return out; });
      case 'rgbP2pSaleFinish': return this.rgbBusy(async () => { prepared(''); const r = app.rgb; const out = await r.service.p2pSaleFinish({ tradeId: a.params.offerId }); await this.rgbBackedUp(r).catch(() => {}); later(r); return out; });
      case 'rgbP2pCancel': return this.rgbBusy(async () => { prepared(''); return app.rgb.service.p2pCancel({ tradeId: a.params.offerId }); });
      case 'rgbSaleComplete': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb;
        const out = await r.service.completeSale(a.params);
        await r.refresh().catch(() => {});
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      default: throw new Error('Unsupported request.');
    }
  }
}
