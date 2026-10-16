import { ago, esc, short, sumSats } from '../../core/format.mjs';
import { isV2 } from '../../ordinals/brc20.mjs';
import { View } from '../View.mjs';
import { I, rowKV, shieldLogo, tokBadge } from '../html.mjs';

const T = (tick) => esc(String(tick || '').toUpperCase());

/** A token page's Send: pick the token, the recipient and the amount. */
export class TokenSendView extends View {
  render() {
    const f = this.f, book = this.app.tokens;
    const toks = book.known().map((t) => ({ ...t, held: book.heldTotal(t.tick) })).filter((t) => t.held > 0);
    if (!toks.length) return `<section class="card center"><p class="muted">No tokens to send yet. Mint some first.</p></section>${this.history()}`;
    if (!toks.some((t) => t.tick === f.tsTick)) f.tsTick = toks[0].tick;
    const tick = f.tsTick;
    const maxOne = book.heldMaxSingle(tick);
    const holds = book.holdings(tick).length;
    const k = this.account.codec.kind(f.tsTo);
    return `
    <div class="chips">${toks.map((t) => `<button class="chip ${t.tick === tick ? 'on' : ''}" data-set="tsTick" data-val="${esc(t.tick)}"><b>${T(t.tick)}</b><span>${t.held.toLocaleString()} held</span></button>`).join('')}</div>
    ${isV2(tick) ? this.brc2NetNote() : ''}
    <section class="card form">
      <label class="field"><span class="lbl">To</span><input data-bind="tsTo" class="mono" spellcheck="false" autocomplete="off" value="${esc(f.tsTo)}" placeholder="Bitcoin or shielded address">
        <span class="addr-kind k-${k.kind}" id="tsKind">${TokenSendView.kindNote(k)}</span></label>
      <label class="field"><span class="lbl">Amount <span class="lbl-r">Available ${book.heldTotal(tick).toLocaleString()} ${T(tick)}</span></span>
        <div class="amount"><input data-bind="tsAmt" inputmode="decimal" autocomplete="off" value="${esc(f.tsAmt)}" placeholder="0"><span class="unit">${T(tick)}</span><button class="max" data-tsmax>MAX</button></div>
        ${holds > 1 ? `<span class="muted small">Your ${T(tick)} sits on ${holds} addresses. One transfer can move up to ${maxOne.toLocaleString()}.</span>` : ''}
      </label>
      <div class="field"><span class="lbl">Pay fees from</span>${this.fromSeg('tsFrom')}</div>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      <p class="info">Sending a BRC-20 token takes 3 small transactions (inscribe the transfer, then deliver it). You approve them once.</p>
      ${this.statusLine('mint')}
      <button class="btn primary wide" id="btnReviewTSend">Review send</button>
    </section>
    ${this.history()}`;
  }

  static kindNote(k) {
    return k.kind === 'empty' ? '<button class="link" data-tsself>Send to my own Shielded address</button>' : esc(k.text);
  }

  history() {
    const list = this.app.transfers.list();
    if (!list.length) return '';
    const explorer = this.account.explorer;
    return `<section class="card list">
    <div class="list-h"><b>Sent</b><span class="muted small">${list.length}</span></div>
    ${list.map((t) => `<div class="coin-row">${t.toKind === 'shielded' ? shieldLogo : `<span class="coin ext">${I.send}</span>`}
      <span class="bal-txt"><b>${T(t.tick)} ${tokBadge(t.tick)}</b><span class="mono">→ ${esc(short(t.to, 8))}</span><span class="small muted">${ago(t.at)}${t.toKind === 'shielded' ? ' · shielded' : ''}</span></span>
      <span class="bal-amt"><b>−${esc(Number(t.amt).toLocaleString())}</b><span class="row-links"><a href="${explorer.tx(t.sendTxid)}" target="_blank" rel="noopener">Tx</a></span></span>
    </div>`).join('')}
  </section>`;
  }
}

/** A token page's Inscribe: a transfer inscription on the Public address, to list on a marketplace or send. */
export class TransferView extends View {
  render() {
    const f = this.f, book = this.app.tokens, coins = this.app.coins;
    const tick = f.trTick;
    const avail = book.transferAvail(tick), inscribed = book.inscribedFor(tick);
    const noFee = !sumSats(coins.spendable(f.trFrom)) && coins.spendLabel(f.trFrom) !== '…';
    return `<section class="card form">
      <p class="info">A <b>transfer inscription</b> locks an amount of ${T(tick)} into one inscription on your Public address. List it on a marketplace (UniSat, OKX, Magic Eden) or send it. Each one can be used once.</p>
      <div class="kv">${rowKV('Available', `<b>${avail.toLocaleString()}</b> ${T(tick)}`)}${inscribed ? rowKV('Already inscribed', `${inscribed.toLocaleString()} ${T(tick)}${book.pendingFor(tick, 'transfer') ? ' <span class="muted small">(some confirming)</span>' : ''}`) : ''}</div>
      <label class="field"><span class="lbl">Amount <span class="lbl-r">${avail ? '<button class="link" data-trmax>Max</button>' : ''}</span></span><input data-bind="trAmt" inputmode="decimal" value="${esc(f.trAmt)}" autocomplete="off" placeholder="0"></label>
      <div class="field"><span class="lbl">Pay fee from</span>${this.fromSeg('trFrom')}</div>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${noFee ? `<p class="info warn">No free ${f.trFrom === 'shielded' ? 'Shielded' : 'Public'} bitcoin to pay the fee${f.trFrom === 'public' && sumSats(coins.public) ? ': every Public coin holds an inscription, and those are never spent for fees' : ''}. Send a little BTC (e.g. 0.0002) to your Public address.</p>` : ''}
      ${this.statusLine('mint')}
      <button class="btn primary wide" id="btnReviewTransfer" ${avail ? '' : 'disabled'}>Review</button>
    </section>`;
  }
}
