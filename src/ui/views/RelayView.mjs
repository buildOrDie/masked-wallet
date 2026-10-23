import { esc, fmtBtc, short } from '../../core/format.mjs';
import { OfflinePayments } from '../../wallet/OfflinePayments.mjs';
import { View } from '../View.mjs';
import { I, head } from '../html.mjs';

const STATE = { waiting: 'Waiting', sent: 'Sent', failed: 'Failed' };

/** Signed payments: add one someone handed you, and see the ones waiting for a connection. */
export class RelayView extends View {
  render() {
    const off = this.app.offline;
    const list = off.list();
    const online = OfflinePayments.online();
    return `
    ${head('Signed payments')}
    ${online ? '' : '<div class="testnet-note"><span class="dot-warn"></span>Offline · payments go out when you reconnect</div>'}
    <section class="card form">
      <p class="muted small">Someone signed a Bitcoin payment offline and gave it to you as a QR code or text? Paste it here. MASKED sends it to the network as soon as you're online, and what's yours shows up in your balance.</p>
      <textarea class="relay-in mono" data-bind="relayText" spellcheck="false" placeholder="Paste the signed payment (the long text, or what your camera read from the QR)">${esc(this.f.relayText || '')}</textarea>
      ${this.statusLine('relay')}
      <button class="btn primary wide" id="btnRelay">${I.send}<span>${online ? 'Send to the network' : 'Keep and send when online'}</span></button>
      <p class="info">A signed payment is a promise until it confirms: the sender could still spend the same coins first.</p>
    </section>
    ${list.length ? `<section class="card"><p class="card-title">Your signed payments</p><div>${list.map((p) => `
      <div class="pay-row">
        <span><b>${fmtBtc(p.amount)} ${this.unit}</b> <small>${p.mine ? `you → ${esc(short(p.recipient || '', 6))}` : 'handed to you'}</small></span>
        <span class="st ${p.state}">${STATE[p.state]}</span>
        <small>${p.state === 'sent' ? `<a class="link" href="${this.account.explorer.tx(p.txid)}" target="_blank" rel="noopener">${short(p.txid, 8)} ${I.ext}</a>` : esc(p.error || (online ? 'Sending…' : 'Waiting for a connection'))}</small>
        <span>${p.state === 'waiting' ? `<button class="btn ghost sm" data-copy="${esc(OfflinePayments.shareText(p, this.unit))}">${I.copy}<span>Copy</span></button>` : p.state === 'failed' || !p.mine ? `<button class="btn ghost sm" data-offrm="${esc(p.txid)}">Remove</button>` : ''}</span>
      </div>`).join('')}</div></section>` : ''}`;
  }
}
