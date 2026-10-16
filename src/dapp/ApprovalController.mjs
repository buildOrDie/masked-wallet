// The approval window: a dApp's request (window.masked) opens the wallet with ?req=<id>. The controller
// loads the request from the background, prepares what the screen shows (fees, PSBT breakdown, the
// transactions to sign), and on approval signs, broadcasts and answers the background.
import { friendly } from '../core/format.mjs';
import { UNISAT_NET } from '../bitcoin/networks.mjs';
import { signMessageBip322, signMessageEcdsa } from '../bitcoin/messages.mjs';
import { TRADE_SITES } from '../trade/TradeAccount.mjs';

/** Methods whose approve button waits for a prepared transaction. */
export const NEEDS_PREP = ['sendBitcoin', 'inscribeTransfer', 'shareTrade', 'fundTrade', 'moveToTrade', 'returnToShielded', 'cancelShielded'];

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
        await app.broadcast(b.hex);
        app.afterBroadcast([b.coin.key], [b.txid]);
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
      default: throw new Error('Unsupported request.');
    }
  }
}
