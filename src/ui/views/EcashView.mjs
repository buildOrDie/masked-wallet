import { esc, fmtBtc, short } from '../../core/format.mjs';
import { ECASH_SOFT_LIMIT } from '../../ecash/EcashBook.mjs';
import { View } from '../View.mjs';
import { I, head, qrSvg, rowKV, seg } from '../html.mjs';

/** The most used and reviewed mint, offered as a one-tap start. Any other mint can be added by address. MASKED doesn't run or vouch for any mint. */
export const SUGGESTED_MINTS = [['mint.minibits.cash/Bitcoin', 'Minibits']];
const sats = (v) => Number(v || 0).toLocaleString('en-US');
export const ecashIcon = (big = false) => `<span class="tok-ic ec-ic ${big ? 'big' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/></svg></span>`;

/** Ecash (Cashu): receive, send (optionally locked to an address), Lightning in and out, mints. */
export class EcashView extends View {
  /** Home's line for ecash: the balance, or an invitation. */
  static homeRow(app) {
    const e = app.ecash;
    if (!e.on) return '';
    if (!e.data) e.load().then(() => app.state.view === 'home' && app.render()).catch(() => {});
    const t = e.total();
    return `<button class="tok-line ec-line" data-go="ecash">${ecashIcon()}
      <span class="bal-txt"><b class="tk">Ecash</b><span>Cashu · instant, private</span></span>
      <span class="bal-amt"><b>${e.data ? sats(t) : '…'}</b><span>${t ? 'sats' : 'Set up'}</span></span><span class="chev">›</span></button>`;
  }

  render() {
    const { app, f } = this, e = app.ecash;
    if (!e.on) return `${head('Ecash')}<section class="card"><p class="muted">Ecash needs a wallet with its own keys. Create or restore one in Settings.</p></section>`;
    if (!e.data) {
      e.load().then(() => app.render()).catch((err) => app.setStatus('ecash', `Could not open your ecash: ${err.message}`, 'err'));
      return `${head('Ecash')}<section class="card"><p class="muted">Opening your ecash…</p>${this.statusLine('ecash')}</section>`;
    }
    if (e.resumedFor !== e.key) { e.resumedFor = e.key; e.resumeWatching((s) => app.controller.ecashPaid(s)); }
    const mints = e.mints;
    if (!f.ecMint || !mints.some((m) => m.url === f.ecMint)) f.ecMint = mints[0]?.url || '';
    const mode = mints.length ? f.ecMode || 'receive' : 'receive';
    const t = e.total();
    return `
    ${head('Ecash')}
    <section class="hero ec-hero">
      ${ecashIcon(true)}
      <p class="hero-label">Ecash · Cashu</p>
      <p class="hero-bal">${sats(t)} <small>sats</small></p>
      <p class="hero-usd">${mints.length ? `${mints.length} mint${mints.length === 1 ? '' : 's'} · instant and private between people` : 'Bearer bitcoin you can send in any chat'}</p>
      ${mints.length ? `<div class="actions ec-actions">
        ${[['receive', 'Receive', I.recv], ['send', 'Send', I.send], ['topup', 'Top up', EcashView.bolt], ['pay', 'Pay', EcashView.bolt]].map(([k, n, ic]) => `<button class="act ${mode === k ? 'on' : ''}" data-set="ecMode" data-val="${k}"><span class="act-ic">${ic}</span><span>${n}</span></button>`).join('')}
      </div>` : ''}
    </section>
    ${t > ECASH_SOFT_LIMIT ? `<p class="info warn">You hold ${sats(t)} sats as ecash. A mint holds the bitcoin behind it: for larger amounts, Shielded is safer.</p>` : ''}
    ${mode === 'receive' ? this.receive() : mode === 'send' ? this.send() : mode === 'topup' ? this.topUp() : mode === 'pay' ? this.pay() : ''}
    ${this.onTheWay()}
    ${this.unclaimed()}
    ${this.mintsCard(!mints.length)}
    <p class="info">Ecash is an IOU from the mint you choose: fast and private, but the mint holds the bitcoin. Keep amounts small. MASKED doesn't run or vouch for any mint. Your ecash is stored encrypted and can be found again from your recovery phrase.</p>`;
  }

  /** The line under "Lock to an address" (updated while typing). */
  static lockNote(v) {
    return String(v || '').trim() ? 'Locked: only that address\'s MASKED wallet can claim it. A copied or intercepted token is useless. Not claimed in 7 days? It comes back to you.' : 'Unlocked: works in any Cashu wallet. Whoever has the token can claim it.';
  }

  static bolt = '<svg viewBox="0 0 24 24"><path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/></svg>';

  mintSeg() {
    const e = this.app.ecash;
    if (e.mints.length < 2) return '';
    return `<div class="field"><span class="lbl">Mint</span>${seg('ecMint', this.f.ecMint, e.mints.map((m) => [m.url, `${esc(e.mintName(m.url))} · ${sats(e.balance(m.url))}`]))}</div>`;
  }

  receive() {
    const { app, f } = this;
    return `
    <section class="card form">
      <label class="field"><span class="lbl">Ecash token</span>
        <textarea id="ecToken" data-bind="ecToken" class="mono" rows="3" spellcheck="false" placeholder="cashuB…">${esc(f.ecToken)}</textarea></label>
      ${this.statusLine('ecash')}
      <button class="btn primary wide" id="btnEcReceive" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Claiming…' : 'Claim'}</button>
      ${app.ecash.mints.length ? '' : '<p class="fee-note">Got a token? Paste it and tap Claim: MASKED adds its mint for you. To top up or send, pick a mint below.</p>'}
      <div class="ec-lock">
        <p class="small"><b>${I.lock} Get ecash only you can claim.</b> Ask the sender to lock it to your Public address. Anyone who copies the token gets nothing.</p>
        <button class="addr-chip mono" data-copy="${esc(app.ecash.myLockAddr)}">${esc(short(app.ecash.myLockAddr, 10))} ${I.copy}</button>
      </div>
    </section>`;
  }

  send() {
    const { app, f, state } = this, e = app.ecash;
    const out = state.ecash?.sent;
    if (out) {
      return `
      <section class="card form ec-token">
        <p class="hero-label">${sats(out.amount)} sats ${out.lockTo ? `locked to ${esc(short(out.lockTo, 8))}` : 'ready to send'}</p>
        ${out.token.length <= 1800 ? `<div class="qr-wrap">${qrSvg(out.token)}</div>` : ''}
        <textarea class="mono" rows="4" readonly>${esc(out.token)}</textarea>
        <button class="btn primary wide" data-copy="${esc(out.token)}">${I.copy} Copy token</button>
        <p class="info">${out.lockTo ? 'Only the owner of that address can claim it, in MASKED. If they haven\'t claimed it within 7 days, you can take it back.' : 'Whoever has this token can claim it, so share it only with the person you\'re paying. Until they claim it, you can take it back below.'}</p>
        <button class="btn ghost wide" data-ecnew>Send another</button>
      </section>`;
    }
    return `
    <section class="card form">
      ${this.mintSeg()}
      <label class="field"><span class="lbl">Amount <span class="lbl-r">Available ${sats(e.balance(f.ecMint))} sats</span></span>
        <div class="amount"><input id="ecAmt" data-bind="ecAmt" inputmode="numeric" autocomplete="off" value="${esc(f.ecAmt)}" placeholder="0"><span class="unit">sats</span></div></label>
      <label class="field"><span class="lbl">Lock to an address <span class="lbl-r">optional</span></span>
        <input id="ecLock" data-bind="ecLock" class="mono" spellcheck="false" autocomplete="off" value="${esc(f.ecLock)}" placeholder="bc1p… of the person you pay"></label>
      <p class="fee-note" id="ecLockNote">${EcashView.lockNote(f.ecLock)}</p>
      ${f.ecLock.trim() && this.app.lookAlike(f.ecLock.trim()) ? `<label class="risk"><input type="checkbox" data-eclockok ${f.ecLockOk ? 'checked' : ''}><span><b>Look-alike address.</b> It starts and ends like <span class="mono">${esc(short(this.app.lookAlike(f.ecLock.trim()), 6))}</span>, an address you used before, but it's different. Tick only if you checked every character.</span></label>` : ''}
      ${this.statusLine('ecash')}
      <button class="btn primary wide" id="btnEcSend" ${this.state.busy ? 'disabled' : ''}>${this.state.busy ? 'Making token…' : 'Make token'}</button>
    </section>`;
  }

  topUp() {
    const { app, f, state } = this, e = app.ecash;
    const q = state.ecash?.quote;
    if (q) {
      return `
      <section class="card form ec-token">
        <p class="hero-label">Pay ${sats(q.amount)} sats with any Lightning wallet</p>
        <div class="qr-wrap">${qrSvg(q.request.toUpperCase())}</div>
        <button class="btn primary wide" data-copy="${esc(q.request)}">${I.copy} Copy invoice</button>
        <p class="sync-wait"><span class="pend-dot" aria-hidden="true"></span>Waiting for payment… Your ecash appears here when it's paid.</p>
        ${this.statusLine('ecash')}
        <button class="btn ghost wide" data-eccheckq="${esc(q.quote)}">I've paid · check now</button>
        <button class="link" data-ecnew>Cancel</button>
      </section>`;
    }
    const oc = e.onchain(f.ecMint);
    const via = oc ? f.ecVia || 'btc' : 'ln';
    if (via === 'btc') return this.topUpBtc(oc);
    return `
    <section class="card form">
      ${this.mintSeg()}
      ${oc ? `<div class="field"><span class="lbl">With</span>${seg('ecVia', via, [['btc', 'Bitcoin'], ['ln', 'Lightning']])}</div>` : ''}
      <label class="field"><span class="lbl">Amount</span>
        <div class="amount"><input id="ecAmt" data-bind="ecAmt" inputmode="numeric" autocomplete="off" value="${esc(f.ecAmt)}" placeholder="0"><span class="unit">sats</span></div></label>
      ${this.statusLine('ecash')}
      <button class="btn primary wide" id="btnEcTopUp" ${this.state.busy ? 'disabled' : ''}>Get Lightning invoice</button>
      <p class="info">Pay the invoice from any Lightning wallet or exchange; ${esc(e.mintName(f.ecMint))} issues the same amount as ecash.${oc ? '' : ' This mint doesn\'t take Bitcoin deposits: pick a mint that does to top up straight from your balance.'}</p>
    </section>`;
  }

  /** Top up from this wallet's own BTC: a deposit to the mint's address (NUT-30), sent and watched here. */
  topUpBtc(oc) {
    const { app, f, state } = this, e = app.ecash, unit = this.unit;
    const b = state.ecash?.btc;
    if (b) {
      return `
      <section class="card review">
        <p class="hero-label">Top up with Bitcoin</p>
        <p class="hero-bal">${sats(b.built.amount)} <small>sats</small></p>
        <div class="kv">
          ${rowKV('From', b.from === 'shielded' ? `${I.shieldPlain} Shielded` : 'Public')}
          ${rowKV('To', `Ecash at ${esc(e.mintName(b.url))}`)}
          ${rowKV('Deposit address', `<span class="mono">${esc(short(b.address, 8))}</span>`)}
          ${rowKV('Network fee', `${fmtBtc(b.built.fee)} ${unit}`)}
          ${rowKV('Ecash after', oc.confirmations ? `${oc.confirmations} confirmation${oc.confirmations === 1 ? '' : 's'}` : 'the deposit confirms')}
        </div>
        <p class="info">The mint gave this address for your wallet only. Once the payment confirms, ${esc(e.mintName(b.url))} issues the same amount as ecash, and then you can pay any Lightning invoice with it. Until then you'll see it under "On its way".</p>
        ${this.statusLine('ecash')}
        <button class="btn primary wide" id="btnEcBtcSend" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Sending…' : 'Confirm & send'}</button>
        <button class="link" data-ecnew>Cancel</button>
      </section>`;
    }
    return `
    <section class="card form">
      ${this.mintSeg()}
      <div class="field"><span class="lbl">With</span>${seg('ecVia', 'btc', [['btc', 'Bitcoin'], ['ln', 'Lightning']])}</div>
      <div class="field"><span class="lbl">From</span>${this.fromSeg('ecFrom')}</div>
      <label class="field"><span class="lbl">Amount ${oc.min ? `<span class="lbl-r">at least ${sats(oc.min)} sats</span>` : ''}</span>
        <div class="amount"><input id="ecAmt" data-bind="ecAmt" inputmode="numeric" autocomplete="off" value="${esc(f.ecAmt)}" placeholder="0"><span class="unit">sats</span></div></label>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${this.statusLine('ecash')}
      <button class="btn primary wide" id="btnEcBtcReview" ${state.busy ? 'disabled' : ''}>Review</button>
      <p class="info">Turns bitcoin from your wallet into ecash at ${esc(e.mintName(f.ecMint))}, with nothing to copy. Then pay any Lightning invoice from Ecash → Pay. No swap service involved.</p>
    </section>`;
  }

  /** Deposits sent from this wallet that the mint hasn't turned into ecash yet. */
  onTheWay() {
    const e = this.app.ecash, list = e.pendingDeposits();
    if (!list.length) return '';
    return `
    <section class="card">
      <div class="card-head"><h2>On its way</h2><button class="link" data-eccheckdep>Check</button></div>
      ${list.map((d) => `<div class="ec-sent"><span><b>${sats(d.amount)} sats</b><span class="muted small"><span class="pend-dot" aria-hidden="true"></span> waiting for confirmation · ${esc(e.mintName(d.url))}</span></span>
        <a class="btn ghost sm" href="${this.account.explorer.tx(d.txid)}" target="_blank" rel="noopener">View</a></div>`).join('')}
    </section>`;
  }

  pay() {
    const { f, state } = this;
    const p = state.ecash?.pay;
    if (p) {
      return `
      <section class="card review">
        <p class="hero-label">You are paying</p>
        <p class="hero-bal">${sats(p.amount)} <small>sats</small></p>
        <div class="kv">
          ${rowKV('Invoice', `<span class="mono">${esc(short(p.invoice, 10))}</span>`)}
          ${rowKV('Lightning fee', `up to ${sats(p.reserve)} sats <span class="muted">(unused part comes back)</span>`)}
          ${rowKV('From', esc(this.app.ecash.mintName(p.url)))}
        </div>
        ${this.statusLine('ecash')}
        <button class="btn primary wide" id="btnEcPay" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Paying…' : 'Pay'}</button>
        <button class="link" data-ecnew>Cancel</button>
      </section>`;
    }
    return `
    <section class="card form">
      ${this.mintSeg()}
      <label class="field"><span class="lbl">Lightning invoice</span>
        <textarea id="ecInvoice" data-bind="ecInvoice" class="mono" rows="3" spellcheck="false" placeholder="lnbc…">${esc(f.ecInvoice)}</textarea></label>
      ${this.statusLine('ecash')}
      <button class="btn primary wide" id="btnEcQuote" ${state.busy ? 'disabled' : ''}>Review</button>
      <p class="info">Pay any Lightning invoice with your ecash, or cash out to an exchange that takes Lightning.</p>
    </section>`;
  }

  unclaimed() {
    const e = this.app.ecash, list = e.unclaimed();
    if (!list.length) return '';
    return `
    <section class="card">
      <div class="card-head"><h2>Not claimed yet</h2><button class="link" data-eccheck>Check</button></div>
      ${list.slice(0, 8).map((s) => `<div class="ec-sent">
        <span><b>${sats(s.amount)} sats</b><span class="muted small">${s.label ? `${esc(s.label.slice(0, 40))} · ` : ''}${s.lockTo ? `${I.lock} ${esc(/^(bc|tb)1p/.test(s.lockTo) ? short(s.lockTo, 6) : s.lockTo)}` : 'unlocked'} · ${new Date(s.at).toLocaleDateString()}</span></span>
        <span class="ec-sent-btns"><button class="btn ghost sm" data-copy="${esc(s.token)}">Copy</button>${e.canReclaim(s) ? `<button class="btn ghost sm" data-ecreclaim="${esc(s.id)}">Take back</button>` : s.refundAt ? `<span class="muted small">back after ${new Date(s.refundAt * 1000).toLocaleDateString()}</span>` : ''}</span>
      </div>`).join('')}
    </section>`;
  }

  mintsCard(open) {
    const { app, f } = this, e = app.ecash;
    return `
    <details class="card adv ec-mints" ${open ? 'open' : ''} data-k="ecmints"><summary>Mints${e.mints.length ? ` · ${e.mints.length}` : ''}</summary>
      ${e.mints.map((m) => `<div class="ec-mint"><span><b>${esc(e.mintName(m.url))}</b>${m.onchain ? ' <span class="badge">BTC deposits</span>' : ''}<span class="muted small mono">${esc(m.url.replace(/^https?:\/\//, ''))}</span></span><span><b>${sats(e.balance(m.url))}</b> ${e.balance(m.url) || e.pendingDeposits().some((d) => d.url === m.url) ? '' : `<button class="link" data-ecrmmint="${esc(m.url)}">Remove</button>`}</span></div>`).join('')}
      ${e.mints.length ? '' : '<p class="small">Pick a mint to start. A mint turns bitcoin into ecash and back. Minibits is the most used; you can add any other Cashu mint by its address. Choose one you trust with small amounts.</p>'}
      <label class="field"><span class="lbl">Add a mint</span>
        <div class="amount"><input id="ecNewMint" data-bind="ecNewMint" class="mono" spellcheck="false" autocomplete="off" value="${esc(f.ecNewMint)}" placeholder="mint.example.com"><button class="max" id="btnEcAddMint">Add</button></div></label>
      <div class="chips">${SUGGESTED_MINTS.filter(([u]) => !e.mints.some((m) => m.url.endsWith(u))).map(([u, n]) => `<button class="chip" data-ecaddmint="${esc(u)}">${esc(n)} · most used</button>`).join('')}</div>
      <p class="muted small">Other mints and their reviews: <a href="https://cashumints.space" target="_blank" rel="noopener">cashumints.space</a>. Spreading ecash over two mints lowers the risk if one fails.</p>
      ${this.statusLine('ecmint')}
      ${e.mints.length ? `<button class="btn ghost wide" id="btnEcRestore" ${this.state.busy ? 'disabled' : ''}>Find my ecash again</button><p class="muted small">Asks each mint for ecash made by this wallet (after reinstalling, or on a new device with the same recovery phrase).</p>` : ''}
    </details>`;
  }
}
