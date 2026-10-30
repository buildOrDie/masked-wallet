import { esc, fmtBtc, short, sumSats } from '../../core/format.mjs';
import { View } from '../View.mjs';
import { AirdropView } from './AirdropView.mjs';
import { OfflinePayments } from '../../wallet/OfflinePayments.mjs';
import { I, btcLogo, copyBtn, head, headWith, qrSvg, rowKV, shieldLogo, sideLogo } from '../html.mjs';

/** Send bitcoin, or Shield (Public → Shielded): form → review → done. */
export class SendView extends View {
  /** @param {import('../../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app, mode) {
    super(app);
    this.mode = mode; // 'send' | 'shield'
    this.drop = new AirdropView(app);
  }

  render() {
    if (this.mode === 'send' && this.f.sendMode === 'airdrop') return this.drop.render();
    const st = this.state.send;
    if (st.stage === 'review' && st.built) return this.review(st.built);
    if (st.stage === 'offline' && st.built) return this.signed(st.built);
    if (st.stage === 'done' && st.built) {
      const b = st.built;
      return this.done(b.toSelf ? 'Shielded!' : 'Sent!', `${fmtBtc(b.amount)} ${this.unit}${b.toSelf ? ' moved to your Shielded balance.' : ' is on its way.'}`, b.txid, b.toSelf ? 'It shows up as pending until the next block.' : '');
    }
    return this.form();
  }

  form() {
    const { app, unit } = this;
    const shield = this.mode === 'shield';
    const from = shield ? 'public' : this.f.sendFrom;
    const bal = sumSats(app.coins.spendable(from));
    const k = this.account.codec.kind(this.f.sendTo);
    const to = shield
      ? `<div class="flow"><div class="flow-end">${btcLogo}<span><b>Public</b><small>${fmtBtc(bal)} ${unit}</small></span></div><span class="flow-arrow">→</span><div class="flow-end">${shieldLogo}<span><b>Shielded</b><small>${fmtBtc(sumSats(app.coins.shielded))} ${unit}</small></span></div></div>`
      : `<label class="field"><span class="lbl">To</span><input id="sendTo" data-bind="sendTo" class="mono" spellcheck="false" autocomplete="off" value="${esc(this.f.sendTo)}" placeholder="Paste a Bitcoin or shielded address">
          <span class="addr-kind k-${k.kind}" id="sendKind">${SendView.kindNote(k)}</span></label>`;
    return `
    ${head(shield ? 'Shield' : 'Send')}
    ${shield ? '' : AirdropView.tabs('send')}
    ${shield ? `<section class="explain">${shieldLogo}<p><b>Shielding</b> moves coins from your Public balance into your Shielded balance. After that, your coins can't be traced to your public address.</p></section>` : ''}
    <section class="card form">
      ${shield ? '' : `<div class="field"><span class="lbl">From</span>${this.fromSeg('sendFrom')}</div>`}
      ${to}
      <label class="field"><span class="lbl">Amount <span class="lbl-r">Available ${fmtBtc(bal)} ${unit}</span></span>
        <div class="amount"><input id="sendAmount" data-bind="sendAmount" inputmode="decimal" autocomplete="off" value="${esc(this.f.sendAmount)}" placeholder="0.00"><span class="unit">${unit}</span><button class="max" data-max="${from}">MAX</button></div>
      </label>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${this.statusLine('send')}
      <button class="btn primary wide" id="btnReviewSend">${shield ? 'Review shield' : 'Review'}</button>
    </section>`;
  }

  /** Under the To field: what kind of address it is, or a shortcut to your own Shielded address. */
  static kindNote(k) {
    return k.kind === 'empty' ? '<button class="link" data-fillself>Send to my own Shielded address</button>' : esc(k.text);
  }

  review(b) {
    const { unit } = this;
    const busy = this.state.busy;
    const offline = !OfflinePayments.online();
    const toTxt = b.toSelf ? `${shieldLogo}<b>My Shielded balance</b>` : `<span class="mono">${esc(short(b.recipient, 10))}</span>`;
    return `
    ${headWith('data-reviewback', 'Confirm')}
    <section class="card review">
      <p class="hero-label">${b.toSelf ? 'You are shielding' : 'You are sending'}</p>
      <p class="hero-bal">${fmtBtc(b.amount)} <small>${unit}</small></p>
      <div class="kv">
        ${rowKV('From', sideLogo(b.from))}
        ${rowKV('To', toTxt)}
        ${b.toSelf ? '' : rowKV('Privacy', b.kind === 'shielded' ? '<span class="good">Private — recipient address is hidden</span>' : '<span class="meh">Public address</span>')}
        ${rowKV('Network fee', `${fmtBtc(b.fee)} ${unit}`)}
        ${rowKV('Total', `<b>${fmtBtc(b.amount + b.fee)} ${unit}</b>`)}
      </div>
      ${b.toSelf ? '' : this.guardNotes(b)}
      ${this.statusLine('send')}
      ${offline ? `<p class="info warn">You're offline. Sign it now; MASKED sends it the moment this device or the receiver gets online.</p>` : ''}
      <button class="btn ${offline ? 'ghost' : 'primary'} wide" id="btnConfirmSend" ${busy || offline || this.blocked(b) ? 'disabled' : ''}>${busy ? 'Sending…' : b.toSelf ? 'Confirm & shield' : 'Confirm & send'}</button>
      ${b.toSelf ? '' : `<button class="btn ${offline ? 'primary' : 'ghost'} wide" id="btnSignOffline" ${busy || this.blocked(b) ? 'disabled' : ''}>${I.lock}<span>Sign now, send later</span></button>`}
      <details class="adv"><summary>Transaction details</summary>
        <div class="kv small">${rowKV('Txid', `<span class="mono">${short(b.txid, 8)}</span>`)}${rowKV(b.coins?.length > 1 ? 'Coins used' : 'Coin used', b.coins?.length > 1 ? `${b.coins.length} coins` : `<span class="mono">${short(b.coin.txid, 6)}:${b.coin.vout}</span>`)}</div>
        <textarea rows="3" class="mono" readonly>${b.hex}</textarea>${copyBtn(b.hex, 'Copy raw tx')}
      </details>
    </section>`;
  }

  /** A send to an address that imitates one you used waits for an explicit tick. */
  blocked(b) { return !b.toSelf && !!this.app.lookAlike(b.recipient) && !this.f.poisonOk; }

  /** Look-alike address (address poisoning) and "most of your balance" warnings on the review screen. */
  guardNotes(b) {
    const like = this.app.lookAlike(b.recipient);
    const side = sumSats(b.from === 'shielded' ? this.app.coins.shielded : this.app.coins.public);
    const big = b.amount >= 100000 && b.amount >= 0.5 * side;
    return `${like ? `<label class="risk"><input type="checkbox" data-poisonok ${this.f.poisonOk ? 'checked' : ''}><span><b>Look-alike address.</b> It starts and ends like <span class="mono">${esc(short(like, 6))}</span>, an address you used before, but it's different. Scammers send dust from look-alikes so you copy the wrong one. Tick only if you checked every character.</span></label>` : ''}
      ${big ? `<p class="info warn">You're sending <b>${Math.round((b.amount / Math.max(1, side)) * 100)}%</b> of your ${b.from === 'shielded' ? 'Shielded' : 'Public'} balance. Check the address on the receiving side before you confirm.</p>` : ''}`;
  }

  /** A payment signed without broadcasting: QR and text to hand over, sent automatically when online. */
  signed(b) {
    const p = this.app.offline.get(b.txid);
    const state = p?.state || 'waiting';
    const text = p ? OfflinePayments.shareText(p, this.unit) : b.hex;
    const line = state === 'sent' ? ['On the network. It lands when the next block confirms it.', 'ok']
      : state === 'failed' ? [p.error || 'This payment could not be sent.', 'err']
      : [OfflinePayments.online() ? 'Sending…' : 'Waiting for a connection. Whoever gets online first sends it: you or the receiver.', ''];
    return `
    ${head('Signed payment')}
    <section class="card receive ${b.kind === 'shielded' ? 'shielded' : ''}">
      <div class="recv-badge">${b.kind === 'shielded' ? shieldLogo : btcLogo}<b>${fmtBtc(b.amount)} ${this.unit}</b></div>
      <p class="muted small">to <span class="mono">${esc(short(b.recipient, 10))}</span>${b.kind === 'shielded' ? ' · lands silent' : ''}</p>
      ${state === 'waiting' ? `<div class="qr-wrap">${qrSvg(b.hex.toUpperCase())}</div>
      <p class="muted small">The receiver scans this with their phone camera, or you send the text below in any chat (Bitchat works offline).</p>` : ''}
      <p class="msg ${line[1]}" role="status">${esc(line[0])}</p>
      <button class="btn primary wide" data-copy="${esc(text)}">${I.copy}<span>Copy signed payment</span></button>
      <div class="kv small" style="width:100%;text-align:left">
        ${rowKV('Network fee', `${fmtBtc(b.fee)} ${this.unit}`)}
        ${rowKV('Transaction', state === 'sent' ? `<a class="link" href="${this.account.explorer.tx(b.txid)}" target="_blank" rel="noopener">${short(b.txid, 8)} ${I.ext}</a>` : `<span class="mono">${short(b.txid, 8)}</span>`)}
      </div>
      <p class="info">Not final until it confirms on Bitcoin. Until then, only hand it to someone who trusts you, and don't spend these coins elsewhere: MASKED holds them back for you.</p>
      <button class="btn ghost wide" data-go="relay">All signed payments</button>
    </section>`;
  }
}
