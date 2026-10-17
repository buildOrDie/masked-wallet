// User input: one listener per event type on the document, routed by data attributes (data-go, data-set,
// data-tok, …) and by button id. Each handler changes state through the app's services and re-renders.
import * as sp from '../crypto/sp-core.mjs';
import { fromHex } from '../core/bytes.mjs';
import { fmtBtc, fmtRate, friendly, parseBtc, short } from '../core/format.mjs';
import { TxPolicy } from '../bitcoin/RawTransaction.mjs';
import { FEE_MAX, FEE_MIN, FeeOracle } from '../net/FeeOracle.mjs';
import { EsploraPool } from '../net/EsploraPool.mjs';
import { Keyring } from '../wallet/Keyring.mjs';
import { SendView } from './views/SendView.mjs';
import { SettingsView } from './views/SettingsView.mjs';
import { TokenSendView } from './views/TokenSendView.mjs';

import { $, $$ } from './dom.mjs';
const { b2n } = sp.util;

/** Which status line an error goes to, by view. */
const ERROR_SLOT = { send: 'send', shield: 'send', mint: 'mint', settings: 'wallet', activity: 'scan' };

export class Controller {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
  }

  get state() { return this.app.state; }
  get f() { return this.app.state.f; }
  render() { this.app.render(); }
  toast(t) { this.app.toast(t); }

  attach(doc = document) {
    doc.addEventListener('input', (e) => this.onInput(e));
    doc.addEventListener('change', (e) => this.onChange(e));
    doc.addEventListener('click', (e) => this.onClick(e));
    doc.addEventListener('keydown', (e) => { if (e.key === 'Enter' && /** @type {any} */ (e.target).id === 'pwUnlock') this.app.lock.unlock(); });
  }

  // ---- typing: update the bound field and the hints next to it, without a full render ----
  onInput(e) {
    const rgbField = e.target.dataset?.rgbField;
    if (rgbField) { this.app.rgb.fields[rgbField] = e.target.value; this.app.rgb.pending = null; return; }
    const b = e.target.dataset?.bind;
    if (!b) return;
    const { state, f } = this, codec = this.app.account.codec;
    f[b] = e.target.value;
    const kindHint = (sel, note) => {
      const k = codec.kind(e.target.value), el = $(sel);
      if (el) { el.className = `addr-kind k-${k.kind}`; el.innerHTML = note(k); }
    };
    if (b === 'sendTo') kindHint('#sendKind', SendView.kindNote);
    if (b === 'tsTo') kindHint('#tsKind', TokenSendView.kindNote);
    if (b === 'mintTick') { clearTimeout(this.tickTimer); this.tickTimer = setTimeout(() => { if (state.view === 'mint') this.render(); }, 450); }
    if (b === 'mintOther') { const k = codec.kind(e.target.value), el = $('#mintKind'); if (el) { el.className = `addr-kind k-${k.kind}`; el.textContent = k.text || ''; } }
    if (b === 'feeCustom') this.customFeeHint(e.target.value);
    if (state.status.send) state.status.send = null;
  }

  customFeeHint(v) {
    const rates = this.app.fees.rates;
    const el = $('#feeNote'), c = FeeOracle.custom(this.f.feeCustom);
    if (el) {
      const bad = v !== '' && !c, high = c > Math.max(50, rates.fast * 5);
      el.className = `fee-note ${bad ? 'bad' : high ? 'warn' : ''}`;
      el.textContent = bad ? `Enter ${FEE_MIN} to ${FEE_MAX} sat/vB. Using Avg (${fmtRate(rates.normal)}) until then.` : high ? 'That is much higher than needed right now.' : `Using ${fmtRate(c || rates.normal)} sat/vB.`;
    }
    const cb = $('.fee.custom');
    if (cb) cb.innerHTML = `<b>Custom</b>${c ? `<span class="r"><em>${fmtRate(c)}</em> sat/vB</span>` : ''}`;
  }

  onChange(e) {
    const t = e.target, app = this.app;
    if (t.hasAttribute?.('data-rbf')) { TxPolicy.save(app.store, t.checked); this.toast(t.checked ? 'RBF on' : 'RBF off'); return; }
    if (t.hasAttribute?.('data-backed')) { this.f.backed = t.checked; this.render(); return; }
    if (t.id === 'autoLockSel') { app.vault.setAutoLock(t.value); app.lock.refreshSession(); this.toast(`Auto-lock: ${t.selectedOptions[0].text}`); return; }
    if (t.hasAttribute?.('data-risk')) { this.f.apRisk = t.checked; this.state.status.approve = null; this.render(); return; }
    if (t.id === 'netSel2') app.setNet(t.value);
  }

  async onClick(e) {
    const t = e.target.closest('button, a');
    if (!t) return;
    try {
      if (await this.onData(t, e)) return;
      await this.onButton(t);
    } catch (err) {
      const key = ERROR_SLOT[this.state.view];
      if (key) this.app.setStatus(key, friendly(err.message), 'err'); else this.toast(err.message);
    }
  }

  /** Clicks routed by data attributes. Returns true when handled. */
  async onData(t, e) {
    const { app, state, f } = this, d = t.dataset;
    const { account, tokens, deploys } = app;
    const tryMint = async (build) => {
      try { state.mint = { stage: 'review', built: await build() }; state.status.mint = null; } catch (err) { state.status.mint = [friendly(err.message), 'err']; }
      this.render();
    };
    if (d.rgb) { await app.rgb.action(d.rgb); return true; }
    if (d.rgbGo) {
      app.rgb.mode = d.rgbGo === 'btc' ? '' : d.rgbGo;
      app.rgb.pending = null;
      app.rgb.fields.asset = d.asset || '';
      state.view = d.rgbGo === 'btc' ? 'home' : d.rgbGo; this.render(); return true;
    }
    if (t.id === 'netChip') { state.view = 'settings'; this.render(); return true; }
    if (t.hasAttribute('data-rbfinfo')) { e.preventDefault(); f.rbfInfo = !f.rbfInfo; this.render(); return true; }
    if (d.side) { app.side.set(d.side); this.render(); return true; }
    if (d.copy != null) {
      try { await navigator.clipboard.writeText(d.copy); this.toast('Copied'); } catch { this.toast('Copy failed — select and copy manually'); }
      return true;
    }
    if (d.go) { this.go(t); return true; }
    if (d.set) {
      f[d.set] = d.val; state.status.send = null;
      if (d.set === 'mintMode') state.status.mint = null;
      this.render();
      if (d.set === 'fee' && d.val === 'custom') $('#feeCustom')?.focus();
      return true;
    }
    if (t.hasAttribute('data-fillself')) { f.sendTo = account.shieldAddr(); this.render(); return true; }
    if (d.max) { const m = app.coins.maxSendable(state.view === 'shield' ? 'public' : d.max, app.feeRate()); f.sendAmount = m ? fmtBtc(m) : ''; this.render(); return true; }
    if (t.hasAttribute('data-reviewback')) { state.send = { stage: 'form' }; this.render(); return true; }
    if (t.hasAttribute('data-mintback')) { state.mint = { stage: 'form' }; this.render(); return true; }
    if (t.hasAttribute('data-lock-now')) { app.lock.lockNow(); return true; }
    if (t.hasAttribute('data-forgot')) { state.obReturn = 'locked'; state.lockState = 'onboard-cancel'; f.obMode = 'restore'; this.render(); return true; }
    if (t.hasAttribute('data-obcancel')) { state.lockState = state.obReturn || 'open'; this.render(); return true; }
    if (d.replace) { state.obReturn = 'open'; state.lockState = 'onboard-cancel'; f.obMode = d.replace; state.status.onboard = null; this.render(); return true; }
    if (t.hasAttribute('data-approve')) { app.approvals.approve(); return true; }
    if (t.hasAttribute('data-reject')) { app.approvals.reject(); return true; }
    if (d.unsite) { await app.sites.disconnect(d.unsite); this.render(); return true; }
    if (d.mintall) {
      const dep = deploys.find(d.mintall);
      f.mintMode = 'mint'; f.mintTick = dep.tick; f.mintAmt = String(Number(dep.max) - tokens.mintedSoFar(dep.tick)); f.mintTo = 'self';
      await tryMint(() => app.tokenTx.mint({ from: f.mintFrom, tick: dep.tick, amt: f.mintAmt, recipient: account.shieldAddr(), rate: app.feeRate() }));
      return true;
    }
    if (d.recover) { await this.recoverReservation(d.recover); return true; }
    if (d.lock) { app.coins.toggleLock(d.lock); this.render(); return true; }
    if (d.rescan === 'stop') { app.sync.stopHistory(); this.toast('History scan stopped'); this.render(); return true; }
    if (d.rescan) {
      const msg = app.sync.rescan(d.rescan);
      this.toast(msg);
      if (msg === 'Rescanning…') this.render();
      return true;
    }
    if (d.tok) {
      if (state.view !== 'mint') state.tokFrom = state.view === 'activity' ? 'activity' : 'home';
      state.mint = { stage: 'form' }; state.tokTick = d.tok; f.tokTab = 'history'; state.view = 'token';
      this.render(); return true;
    }
    if (d.tinsc) { if (state.view !== 'mint') state.tokFrom = state.tokFrom || 'home'; this.openMint('transfer', () => { f.trTick = d.tinsc; f.trAmt = ''; }); return true; }
    if (t.hasAttribute?.('data-trmax')) { f.trAmt = String(tokens.transferAvail(f.trTick)); this.render(); return true; }
    if (d.tmint) { this.openMint('mint', () => { f.mintTick = d.tmint; }); return true; }
    if (d.tsend) { this.openMint('send', () => { f.tsTick = d.tsend; }); return true; }
    if (t.hasAttribute('data-tsmax')) { const m = tokens.heldMaxSingle(f.tsTick); f.tsAmt = m ? String(m) : ''; this.render(); return true; }
    if (t.hasAttribute('data-tsself')) { f.tsTo = account.shieldAddr(); this.render(); return true; }
    if (d.pick) {
      f.mintTick = d.pick;
      const dep = deploys.find(d.pick);
      if (dep) f.mintAmt = dep.selfMint ? String(Math.max(0, Number(dep.max) - tokens.mintedSoFar(dep.tick))) : dep.lim;
      state.status.mint = null; this.render(); return true;
    }
    if (d.setnet) { app.setNet(d.setnet); return true; }
    if (d.mintof) { f.mintMode = 'mint'; f.mintTick = d.mintof; const dep = deploys.find(d.mintof); if (dep) f.mintAmt = dep.lim; this.render(); return true; }
    if (d.deploy) {
      await tryMint(() => app.tokenTx.deploy(deploys.find(d.deploy), { from: f.depFrom, recipient: account.shieldAddr(), rate: app.feeRate() }));
      return true;
    }
    if (d.dellabel) { state.labels = state.labels.filter((l) => l.m !== +d.dellabel); this.render(); return true; }
    if (t.hasAttribute('data-rmin')) { t.closest('.inrow').remove(); return true; }
    return false;
  }

  /** data-go: open another view (with the extra data-* that come with it). */
  go(t) {
    const { app, state, f } = this, d = t.dataset;
    if (['send', 'receive', 'shield', 'home'].includes(d.go)) { app.rgb.mode = ''; app.rgb.pending = null; }
    if (d.recv) f.recvKind = d.recv;
    if (d.filter) f.coinFilter = d.filter;
    if (d.reset || ['send', 'shield'].includes(d.go)) { state.send = { stage: 'form' }; state.status.send = null; }
    if (d.reset || d.go === 'mint') { if (state.mint.stage === 'done') state.mint = { stage: 'form' }; state.status.mint = null; }
    // the Mint tab always opens Mint & deploy (Send / Inscribe are sub-pages of a token)
    if (t.closest('#nav') && d.go === 'mint' && ['send', 'transfer'].includes(f.mintMode)) { f.mintMode = 'mint'; state.mint = { stage: 'form' }; }
    if (d.go === 'shield') f.sendAmount = '';
    if (d.go === 'mint' && f.mintMode === 'send') f.mintMode = 'mint';
    state.view = d.go;
    if (d.go === 'settings') app.sites.loadSites().then(() => this.render());
    this.render();
  }

  /** The Mint view in one of its modes, from a token page. */
  openMint(mode, setup) {
    const { state, f } = this;
    state.view = 'mint'; f.mintMode = mode; setup();
    state.mint = { stage: 'form' }; state.status.mint = null;
    this.render();
  }

  async recoverReservation(outpoint) {
    const { app, state, f } = this;
    const [txid, vout] = outpoint.split(':');
    const coin = app.coins.shieldedThenPublic().find((c) => c.txid === txid && c.vout === +vout);
    state.status.recover = ['Checking…', ''];
    this.render();
    try {
      const tick = await app.tokenTx.recoverReservation(coin, { tick: f.recTick, max: f.depMax, lim: f.depLim, selfMint: f.depWho === 'self', salt: f.recSalt });
      state.status.recover = null; f.recTick = ''; f.recSalt = '';
      this.toast(`${tick.toUpperCase()} reservation recovered`);
      await app.deploys.refresh();
    } catch (err) { state.status.recover = [friendly(err.message), 'err']; }
    this.render();
  }

  /** Clicks on buttons with an id. */
  async onButton(t) {
    const { app, state, f } = this;
    const { account, sync } = app;
    const review = async (slot, build) => { state[slot] = { stage: 'review', built: await build() }; state.status[slot] = null; this.render(); };
    switch (t.id) {
      case 'btnSync': sync.run(8); break;
      case 'btnOlder': sync.run(24, { older: true }); break;
      case 'btnReviewSend': {
        const shield = state.view === 'shield';
        await review('send', () => app.builder.send({ from: shield ? 'public' : f.sendFrom, to: shield ? 'self' : f.sendTo, amount: parseBtc(f.sendAmount, account.unit), rate: app.feeRate() }));
        break;
      }
      case 'btnConfirmSend': await this.confirmSend(); break;
      case 'btnReviewMint': {
        const recipient = f.mintTo === 'self' ? account.shieldAddr() : f.mintOther.trim();
        await review('mint', () => app.tokenTx.mint({ from: f.mintFrom, tick: f.mintTick, amt: f.mintAmt, recipient, rate: app.feeRate() }));
        break;
      }
      case 'btnReviewTransfer': await review('mint', () => app.tokenTx.transferInscribe({ tick: f.trTick, amt: f.trAmt, from: f.trFrom, rate: app.feeRate() })); break;
      case 'btnReviewPredeploy': await review('mint', () => app.tokenTx.predeploy({ from: f.depFrom, tick: f.depTick, max: f.depMax, lim: f.depLim, rate: app.feeRate(), resTo: f.depResTo, selfMint: f.depWho === 'self' })); break;
      case 'btnReviewTSend': await review('mint', () => app.tokenTx.send({ tick: f.tsTick, amt: f.tsAmt, to: f.tsTo, from: f.tsFrom, rate: app.feeRate() })); break;
      case 'btnConfirmMint': await this.confirmMint(); break;
      case 'btnScan': this.scanPasted(); break;
      case 'btnResetScan':
        sync.forgetProgress(); app.coins.forgetShielded();
        app.setStatus('scan', 'Coin list cleared. Tap refresh to scan again.');
        break;
      case 'btnReveal': await app.lock.reveal(); break;
      case 'btnUnlock': await app.lock.unlock(); break;
      case 'btnIdxSave': {
        try { await app.tokens.saveIndexer($('#idxUrl').value); state.status.idx = [app.tokenServer.url() ? `Connected · block ${app.tokens.idx?.height?.toLocaleString()}` : 'Indexer turned off.', 'ok']; }
        catch (err) { state.status.idx = [err.message, 'err']; }
        this.render(); break;
      }
      case 'btnIdxOff': await app.tokens.saveIndexer(''); state.status.idx = ['Indexer turned off.', 'ok']; this.render(); break;
      case 'btnSrvSave':
        state.status.srv = ['Checking…', '']; this.render();
        await app.servers.saveCustom($('#srvUrl').value, { requestPermission: (u) => app.platform.requestOrigin(u) });
        state.status.srv = [app.servers.custom() ? 'Saved. Your server is used first.' : 'Using public servers.', 'ok']; this.render();
        sync.run(4); break;
      case 'btnSrvOff': await app.servers.saveCustom(''); state.status.srv = ['Using public servers.', 'ok']; this.render(); break;
      case 'btnScanSave':
        state.status.scansrv = ['Checking…', '']; this.render();
        await app.scanServer.save($('#scanUrl').value, { requestPermission: (u) => app.platform.requestOrigin(u) });
        state.status.scansrv = [app.scanServer.url() ? 'Saved. Shielded scanning now uses your scan server.' : 'Scan server off.', 'ok']; this.render();
        break;
      case 'btnScanDefault':
        app.scanServer.useDefault();
        state.status.scansrv = [`Using ${EsploraPool.hostOf(app.scanServer.defaultUrl)}.`, 'ok']; this.render();
        sync.run(4); break;
      case 'btnScanOff': await app.scanServer.save(''); state.status.scansrv = ['Scan server off.', 'ok']; this.render(); break;
      case 'btnPanel': await app.platform.openSidePanel(); break;
      case 'btnOnboard': await app.lock.onboard(); break;
      case 'btnMigrate': await app.lock.migrate(); break;
      case 'btnChangePw': await app.lock.changePassword(); break;
      case 'btnBackedUp': state.view = 'home'; app.lock.startWallet(); break;
      case 'btnRaw': this.loadRawKeys(); break;
      case 'btnExample': app.loadExample(); app.resetWallet(); this.f.scanText = JSON.stringify(app.example.tx); this.scanPasted(); state.view = 'home'; this.render(); break;
      case 'btnLabel': this.addLabel(); break;
      case 'btnAddIn': $('#sendInputs').insertAdjacentHTML('beforeend', SettingsView.inputRow()); break;
      case 'btnCalc': { try { state.calc = { out: this.computeOutputs() }; } catch (err) { state.calc = { err: err.message }; } this.render(); break; }
      default: break;
    }
  }

  async confirmSend() {
    const { app, state, f } = this;
    const b = state.send.built;
    state.busy = true; this.render();
    try {
      await app.broadcast(b.hex);
      state.send = { stage: 'done', built: b };
      f.sendAmount = ''; f.sendTo = '';
      app.afterBroadcast([b.coin.key], [b.txid]);
    } finally { state.busy = false; this.render(); }
  }

  /** Broadcast a reviewed mint, reservation, deploy, transfer or token send, and record it. */
  async confirmMint() {
    const { app, state, f } = this;
    const { inscriptions: ins, deploys } = app;
    const b = state.mint.built;
    state.busy = true; this.render();
    try {
      await app.broadcast(b.commitHex);
      await app.broadcast(b.revealHex);
      if (b.op === 'tsend') {
        await app.broadcast(b.sendHex);
        if (b.fromKind === 'public') app.pending.add('send', b.tick, b.amt, b.revealTxid);
        app.transfers.addSend(b);
        ins.set(`${b.sendTxid}:0`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId });
        f.tsAmt = ''; f.tsTo = '';
        state.mint = { stage: 'done', built: b };
        app.afterBroadcast(b.spent, [b.commitTxid, b.revealTxid, b.sendTxid]);
        return;
      }
      ins.set(`${b.revealTxid}:${b.revealOut}`, { brc20: true, op: b.op, tick: b.tick, amt: b.amt, max: b.max, id: b.inscriptionId });
      if (b.op === 'mint') app.mints.prepend({ tick: b.tick, amt: b.amt, revealTxid: b.revealTxid, revealOut: b.revealOut, pkscript: b.recipientSpk, inscriptionId: b.inscriptionId, to: b.toSelf ? 'shielded' : b.recipient === app.account.pubAddr() ? 'public' : 'other', recipient: b.recipient, at: Date.now(), height: null });
      if (b.op === 'predeploy') deploys.save([...deploys.list(), { tick: b.tick, max: b.max, lim: b.lim, selfMint: !!b.selfMint, salt: b.salt, hash: b.hash, pkscript: b.pkscript, predeployTxid: b.revealTxid, predeployId: b.inscriptionId, height: null, status: 'reserved', at: Date.now() }]);
      if (b.op === 'deploy') deploys.update(b.tick, { status: 'deployed', deployTxid: b.revealTxid, deployId: b.inscriptionId, loc: { txid: b.revealTxid, vout: b.revealOut } });
      if (b.op === 'mint' && b.selfMint) {
        // the deploy inscription came back to us in output 0
        const dep = deploys.find(b.tick);
        deploys.update(b.tick, { loc: { txid: b.revealTxid, vout: 0 } });
        ins.set(`${b.revealTxid}:0`, { brc20: true, op: 'deploy', tick: b.tick, id: dep?.deployId });
      }
      if (b.op === 'deploy') ins.set(`${b.revealTxid}:0`, { brc20: true, op: 'predeploy', tick: b.tick, id: (deploys.find(b.tick) || {}).predeployId });
      if (b.op === 'predeploy') f.depTick = '';
      if (b.op === 'transfer') {
        ins.set(`${b.revealTxid}:${b.revealOut}`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId, ready: true });
        app.pending.add('transfer', b.tick, b.amt, b.revealTxid);
        f.trAmt = '';
      }
      state.mint = { stage: 'done', built: b };
      app.afterBroadcast(b.spent, [b.commitTxid, b.revealTxid]);
    } finally { state.busy = false; this.render(); }
  }

  /** Settings → Coins → Find a payment manually. */
  scanPasted() {
    const { app } = this;
    const text = String(this.f.scanText || '').trim();
    if (!text) return app.setStatus('scan', 'Paste transaction JSON first.', 'err');
    if (!app.account.keys) return app.setStatus('scan', 'Set up a wallet first.', 'err');
    try { JSON.parse(text); } catch { return app.setStatus('scan', 'That is not valid JSON.', 'err'); }
    const { count, hits, errs } = app.scanner.scanPasted(text);
    app.setStatus('scan', `Checked ${count} transaction${count === 1 ? '' : 's'} · ${hits} shielded payment${hits === 1 ? '' : 's'} found${errs ? ` · ${errs} unreadable` : ''}.`, hits ? 'ok' : errs ? 'err' : '');
    return undefined;
  }

  loadRawKeys() {
    const { app } = this;
    const s = $('#rawScan').value.trim(), p = $('#rawSpend').value.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('Scan key must be 64 hex characters.');
    if (!/^([0-9a-fA-F]{64}|0[23][0-9a-fA-F]{64})$/.test(p)) throw new Error('Spend key must be 64-hex private or 66-hex public key.');
    this.state.wallet = Keyring.fromKeys(b2n(fromHex(s)), fromHex(p), 'keys');
    app.resetWallet();
    app.setStatus('wallet', this.state.wallet.bSpend === null ? 'Watch-only wallet loaded.' : 'Keys loaded.', 'ok');
    app.sync.run(6);
  }

  addLabel() {
    const { state } = this;
    const m = Number($('#labM').value);
    if (!Number.isInteger(m) || m < 1 || m > 0xffffffff) throw new Error('Label number must be 1 or higher.');
    if (state.labels.some((l) => l.m === m)) throw new Error(`Label ${m} already exists.`);
    state.labels.push({ m, note: $('#labNote').value.trim() });
    state.labels.sort((a, b) => a.m - b.m);
    this.render();
  }

  /** Advanced → Shielded output calculator: outputs for a transaction built in another wallet. */
  computeOutputs() {
    const codec = this.app.account.codec;
    const rows = $$('#sendInputs .inrow');
    const allOutpoints = [], eligible = [];
    rows.forEach((r, i) => {
      const op = $('[data-f=op]', r).value.trim();
      const m = op.match(/^([0-9a-fA-F]{64}):(\d+)$/);
      if (!m) throw new Error(`Input ${i + 1}: outpoint must look like <txid>:<vout>`);
      const type = $('[data-f=type]', r).value;
      allOutpoints.push({ txid: m[1].toLowerCase(), vout: +m[2] });
      if (type === 'other') return;
      const keyField = $('[data-f=key]', r).value;
      if (!keyField.trim()) throw new Error(`Input ${i + 1}: enter its private key, or set it to "Not eligible"`);
      eligible.push({ txid: m[1].toLowerCase(), vout: +m[2], privKey: Keyring.parsePriv(keyField), taproot: type === 'p2tr' });
    });
    if (!rows.length) throw new Error('Add at least one input');
    const recips = String(this.f.calcRecips || '').split(/[\s,]+/).filter(Boolean);
    if (!recips.length) throw new Error('Add at least one shielded address');
    for (const a of recips) if (codec.kind(a).kind !== 'shielded') throw new Error(`${short(a, 8)}: ${codec.kind(a).text || 'not a shielded address'}`);
    return sp.createOutputs(eligible, allOutpoints, recips);
  }
}

