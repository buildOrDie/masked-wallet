// The approval window: a dApp's request (window.masked) opens the wallet with ?req=<id>. The controller
// loads the request from the background, prepares what the screen shows (fees, PSBT breakdown, the
// transactions to sign), and on approval signs, broadcasts and answers the background.
import { friendly } from '../core/format.mjs';
import { instantBuyVbytes, instantMoveVbytes, INSTANT_SEAL_SATS } from '../rgb/swap.mjs';
import { UNISAT_NET } from '../bitcoin/networks.mjs';
import { signMessageBip322, signMessageEcdsa } from '../bitcoin/messages.mjs';
import { TRADE_SITES } from '../trade/TradeAccount.mjs';
import { lockKeyOf, peekToken } from '../ecash/EcashBook.mjs';
import { toBase } from '../rgb/config.mjs';
import { proxyUrl } from '../rgb/WalletRgb.mjs';

/** Methods whose approve button waits for a prepared transaction. */
export const NEEDS_PREP = ['sendBitcoin', 'inscribeTransfer', 'shareTrade', 'fundTrade', 'moveToTrade', 'returnToShielded', 'cancelShielded', 'cashuPay', 'cashuPayRequest', 'cashuReceive', 'rgbInvoice', 'rgbPay', 'rgbSwapAvailable', 'rgbListAssets', 'rgbBuyPrepare', 'rgbSalePrepare', 'rgbBuySign', 'rgbSaleComplete', 'rgbAutoSell', 'rgbInstantList', 'rgbInstantBuy', 'rgbInstantCancel'];
const SWAP_METHODS = ['rgbSwapAvailable', 'rgbListAssets', 'rgbBuyPrepare', 'rgbSalePrepare', 'rgbBuySign', 'rgbSaleComplete', 'rgbAutoSell', 'rgbInstantList', 'rgbInstantBuy', 'rgbInstantCancel'];
const RGB_METHODS = ['rgbInvoice', 'rgbPay', ...SWAP_METHODS];
const SWAP_SIZE_VB = 320;
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
          .catch((e) => { a.prepErr = friendly(e.message); app.render(); });
      }
      // private trading: built once (they read the network); rebuilt after a sync if they failed
      const once = (fn) => {
        if (a.prep || a.prepBusy || (a.prepErr && (sync.syncing || a.errGen === sync.gen))) return;
        a.prepBusy = true; a.prepErr = null;
        fn().then((b) => { a.prep = b; }).catch((e) => { a.prepErr = friendly(e.message); a.errGen = sync.gen; }).finally(() => { a.prepBusy = false; app.render(); });
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
          .then((b) => { a.prep = b; app.render(); }).catch((e) => { a.prepErr = friendly(e.message); app.render(); });
        if (!a.idxAsked && !app.tokens.publicToken(String(a.params.ticker).toLowerCase())) { a.idxAsked = true; app.tokens.refreshPublicTokens().then(go); } else go();
      }
      if (psbt && !a.ordChecked) { a.ordChecked = true; app.ord.check(app.coins.public).then(() => this.prepare()); }
      if (a.method === 'signPsbt') a.prep = [app.psbt.analyse(a.params.psbtHex, a.params.options || {})];
      if (a.method === 'signPsbts') a.prep = a.params.psbtHexs.map((h, k) => app.psbt.analyse(h, (a.params.options || [])[k] || {}));
      // the trade address and Shielded listings sign for MASKED's own website only
      if (psbt && a.prep.some((p) => p.trade) && !TRADE_SITES.has(a.origin)) { a.prep = null; throw new Error('Only maskedwallet.com can ask MASKED to sign for your trade address or Shielded listings.'); }
    } catch (e) { a.prepErr = friendly(e.message); }
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
      const asset = P.assetId ? r.find(P.assetId) : null;
      const base = P.baseUnits ? Number(P.baseUnits) : 0;
      if (base && !Number.isSafeInteger(base)) throw new Error('That amount is too large.');
      const witness = P.kind ? P.kind === 'witness' : r.recvType() === 'witness';
      return {
        assetId: P.assetId || '', asset, amount: base, witness, expiry: Number(P.expiry) || 86400,
        shown: base ? (asset ? `${r.amount(asset, base)} ${asset.ticker}` : `${base.toLocaleString('en-US')} units`) : 'Any amount',
        newToken: !!P.assetId && !asset,
      };
    });
    if (a.method === 'rgbPay') once(async () => {
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
    if (r.busy) throw new Error('RGB is busy. Try again in a moment.');
    r.busy = true;
    try { return await fn(); } finally { r.busy = false; }
  }

  /** What a swap step's screen shows: the token (if this wallet knows it), the amount and the price. */
  prepareSwap(a, once) {
    const r = this.app.rgb, P = a.params || {}, m = a.method;
    once(async () => {
      if (m === 'rgbListAssets') return { list: r.assets().map((x) => ({ ticker: x.ticker, assetId: x.assetId })) };
      if (!r.service?.canSwap) throw new Error('This MASKED version can\'t swap RGB tokens yet. Update MASKED.');
      if (m === 'rgbSwapAvailable') {
        const asset = r.find(P.assetId);
        return { asset, assetId: P.assetId };
      }
      const o = P.offer || {};
      const net = r.isMain ? 'mainnet' : 'signet';
      if (P.network && !String(P.network).toLowerCase().startsWith(net === 'mainnet' ? 'mainnet' : 'signet')) throw new Error(`The site is on ${P.network}, your RGB wallet is on ${r.profile.label}.`);
      const asset = r.find(o.assetId);
      const shown = asset ? `${r.amount(asset, Number(o.amount))} ${asset.ticker}` : `${Number(o.amount).toLocaleString('en-US')} units`;
      const base = { asset, assetId: o.assetId, shown, price: Number(o.priceSats), newToken: !asset };
      if (m === 'rgbBuyPrepare') {
        const rate = P.feeRate || Number(r.fee());
        return { ...base, fee: Math.ceil(rate * SWAP_SIZE_VB), rate };
      }
      if (m === 'rgbInstantList' || m === 'rgbInstantBuy' || m === 'rgbInstantCancel') {
        if (!r.service.canPresign) throw new Error('This MASKED version can\'t do Instant listings yet. Update MASKED.');
        const rate = P.feeRate || Number(r.fee());
        // usual sizes (one coin of yours, taproot); the wallet works out the exact fee from the real coins
        const vb = m === 'rgbInstantBuy' ? instantBuyVbytes(1, true) : instantMoveVbytes(1);
        const fee = Math.ceil(rate * vb);
        if (m === 'rgbInstantBuy') return { ...base, fee, rate, vb, seal: INSTANT_SEAL_SATS };
        if (m === 'rgbInstantList') {
          if (!asset) throw new Error('You don\'t hold this token in RGB.');
          if (Number(o.amount) > r.bal(asset).spendable) throw new Error(`You can sell up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
          let host = ''; try { host = new URL(P.market).host; } catch { throw new Error('The market address is not valid.'); }
          return { ...base, fee, rate, vb, market: host };
        }
        const e = r.service.instantStore().get(P.offerId);
        if (!e || e.role !== 'seller') throw new Error('This wallet has no Instant listing with that id.');
        return { ...base, fee: e.stage === 'ready' ? fee : 0, rate, vb, stage: e.stage };
      }
      if (m === 'rgbAutoSell') {
        if (!asset) throw new Error('You don\'t hold this token in RGB.');
        if (Number(o.amount) > r.bal(asset).spendable) throw new Error(`You can sell up to ${r.amount(asset, r.bal(asset).spendable)} ${asset.ticker}.`);
        let host = ''; try { host = new URL(P.market).host; } catch { throw new Error('The market address is not valid.'); }
        return { ...base, market: host, autoOn: r.autoOn };
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
      try { await r.refresh(); } catch { continue; }
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
    this.app.platform.message({ type: 'resolveRequest', id: a.id, ...payload }).finally(() => setTimeout(() => window.close(), 150));
  }

  reject() { this.finish({ error: { code: 4001, message: 'User rejected the request.' } }); }

  async approve() {
    const app = this.app, state = this.state, a = this.active;
    state.busy = true; app.render();
    try {
      this.finish({ result: await this.run(a) });
    } catch (e) {
      state.status.approve = [friendly(e.message), 'err'];
    } finally { state.busy = false; app.render(); }
  }

  /** Carry out an approved request; returns what the dApp gets back. */
  async run(a) {
    const app = this.app, { account, trade } = app;
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
      case 'rgbListAssets': return this.rgbBusy(async () => { prepared(''); return app.rgb.service.assetList(); });
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
      case 'rgbInstantList': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params, o = P.offer;
        await this.rgbBackedUp(r);
        const out = await r.service.instantList({ offerId: P.offerId, assetId: o.assetId, amount: o.amount, priceSats: o.priceSats, feeRate: P.feeRate || Number(r.fee()), market: P.market, token: P.token });
        await r.refresh().catch(() => {});
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      case 'rgbInstantBuy': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params;
        const out = await r.service.instantBuy({ ...P, feeRate: P.feeRate || Number(r.fee()) });
        await r.refresh().catch(() => {});
        return out;
      });
      case 'rgbInstantCancel': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb, P = a.params;
        const out = await r.service.instantCancel({ offerId: P.offerId, feeRate: P.feeRate || Number(r.fee()) });
        await r.refresh().catch(() => {});
        await this.rgbBackedUp(r).catch(() => {});
        return out;
      });
      case 'rgbAutoSell': return this.rgbBusy(async () => {
        prepared(''); const r = app.rgb;
        if (!r.autoOn && !app.state.f.apRisk) throw new Error('Tick the box to switch on Sell automatically.');
        if (!r.autoOn) await r.setAutoSell(true); else await r.publishPass();
        return { ok: true, profile: r.profile.id };
      });
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
