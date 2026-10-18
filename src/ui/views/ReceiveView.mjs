import { esc, short } from '../../core/format.mjs';
import { View } from '../View.mjs';
import { I, addrChunks, btcLogo, head, qrSvg, rowKV, seg, shieldLogo } from '../html.mjs';

const sats = (n) => `${Number(n || 0).toLocaleString()} sats`;

/** What a Lightning receive is doing, in words. */
const LN_STATE = {
  created: 'Waiting for payment…',
  paid: 'Paid. Waiting for 1 confirmation, then it moves to your Shielded balance (about 10 minutes).',
  claimed: 'Arriving in your Shielded balance…',
  done: 'Received in your Shielded balance.',
  expired: 'Expired. Nothing was paid, or the payer got the money back.',
  failed: 'Failed. The payer gets the money back automatically.',
};

/** Receive: the Public or Shielded address as text and QR code, or a Lightning invoice that lands in Shielded. */
export class ReceiveView extends View {
  render() {
    const { account } = this;
    const ln = this.app.lightning;
    let kind = this.f.recvKind;
    if (kind === 'lightning' && !ln.available) kind = 'shielded';
    const opts = [['public', 'Public'], ['shielded', `${I.shieldPlain} Shielded`]];
    if (ln.available) opts.push(['lightning', `${I.bolt} Lightning`]);
    if (kind === 'lightning') return `${head('Receive')}${seg('recvKind', kind, opts)}${this.lightning()}`;

    const a = kind === 'shielded' ? account.shieldAddr() : account.pubAddr();
    if (!a) return `${head('Receive')}<section class="card"><p class="muted">This wallet has no ${kind} address.</p></section>`;
    const info = kind === 'shielded'
      ? 'For wallets that support <b>silent payments</b>. Each payment lands somewhere new, so nobody can link them to you.'
      : 'For exchanges, faucets and any Bitcoin wallet. Payments here are <b>public</b>.';
    return `
    ${head('Receive')}
    ${seg('recvKind', kind, opts)}
    <section class="card receive ${kind}">
      <div class="recv-badge">${kind === 'shielded' ? `${shieldLogo}<b>Shielded address</b>` : `${btcLogo}<b>Public address</b>`}</div>
      <div class="qr-wrap">${qrSvg(a)}</div>
      <p class="addr mono">${addrChunks(a)}</p>
      <button class="btn primary wide" data-copy="${esc(a)}">${I.copy}<span>Copy address</span></button>
      <p class="info">${info}</p>
      ${account.isTest ? `<p class="info warn">${account.params.name} only. Never send real bitcoin here.</p>` : ''}
    </section>`;
  }

  /** Receive → Lightning: the open invoice, or the amount form, plus recent receives. */
  lightning() {
    const ln = this.app.lightning;
    const rec = this.state.lnId ? ln.get(this.state.lnId) : null;
    const body = rec ? this.lnInvoice(rec) : this.lnForm();
    const recent = ln.list().filter((r) => r.id !== rec?.id).slice(0, 5);
    return `${body}
    ${recent.length ? `<section class="card"><p class="card-title">Recent Lightning receives</p><div class="kv small">${recent.map((r) => rowKV(
      `<button class="link" data-lnopen="${esc(r.id)}">${sats(r.sats)}</button>`,
      esc(r.state === 'done' || r.state === 'claimed' ? `${sats(r.received)} in Shielded` : r.state === 'created' ? (Date.now() > r.expiresAt ? 'Not paid' : 'Waiting') : r.state === 'paid' ? 'Confirming' : r.state === 'expired' ? 'Expired' : 'Failed'),
    )).join('')}</div></section>` : ''}`;
  }

  lnForm() {
    const ln = this.app.lightning;
    if (!ln.pair && !ln.pairErr) ln.loadPair();
    const amt = Number(String(this.f.lnAmount || '').replace(/[^\d]/g, ''));
    const est = ln.estimate(amt);
    const limits = ln.pair ? `${ln.pair.limits.minimal.toLocaleString()} to ${ln.pair.limits.maximal.toLocaleString()} sats` : '';
    const outOfRange = est && (amt < est.min || amt > est.max);
    return `
    <section class="card receive lightning">
      <div class="recv-badge"><span class="coin sh">${I.bolt}</span><b>Lightning to Shielded</b></div>
      <p class="info">Get paid from any Lightning wallet. It arrives in your <b>Shielded</b> balance as a silent payment.</p>
      <label class="field wide"><span class="lbl">Amount</span>
        <div class="amount"><input data-bind="lnAmount" type="text" inputmode="numeric" placeholder="${ln.pair ? ln.pair.limits.minimal : '25000'}" value="${esc(this.f.lnAmount || '')}" autocomplete="off"><span class="unit">sats</span></div>
      </label>
      ${ln.pairErr ? `<p class="msg err">${esc(ln.pairErr)}</p>` : limits ? `<p class="muted small">From ${limits}.</p>` : '<p class="muted small">Loading fees…</p>'}
      ${est && !outOfRange ? `<div class="kv small wide">
        ${rowKV('Boltz fee', sats(est.boltzFee))}
        ${rowKV('Network fees', sats(est.lockupFee + est.claimFee))}
        ${rowKV('You receive about', `<b class="good">${sats(est.receive)}</b>`)}
      </div>` : ''}
      ${this.statusLine('ln')}
      <button class="btn primary wide" id="btnLnCreate" ${this.state.busy || !est || outOfRange || est.receive <= 0 ? 'disabled' : ''}>${I.bolt}<span>${this.state.busy ? 'Creating invoice…' : 'Create invoice'}</span></button>
      <p class="info">The swap runs through <b>Boltz</b> and never holds your money: if the payment doesn't complete, the payer is refunded by Lightning. Keep MASKED open (the side panel works) until it arrives.</p>
    </section>`;
  }

  /** @param {import('../../lightning/LightningReceive.mjs').LnReceive} r */
  lnInvoice(r) {
    const waiting = r.state === 'created';
    const late = waiting && Date.now() > r.expiresAt;
    const text = late ? 'This invoice has expired. Create a new one.' : LN_STATE[r.state] || r.state;
    return `
    <section class="card receive lightning">
      <div class="recv-badge"><span class="coin sh">${I.bolt}</span><b>${sats(r.sats)}</b></div>
      ${waiting && !late ? `<div class="qr-wrap">${qrSvg(`lightning:${r.invoice}`)}</div>
      <p class="addr mono">${esc(short(r.invoice, 14))}</p>
      <button class="btn primary wide" data-copy="${esc(r.invoice)}">${I.copy}<span>Copy invoice</span></button>` : ''}
      <p class="msg ${r.state === 'done' ? 'ok' : r.state === 'failed' || r.state === 'expired' || late ? 'err' : ''}" role="status">${esc(text)}</p>
      ${r.error && r.state !== 'done' ? `<p class="muted small">Last check: ${esc(r.error)}</p>` : ''}
      <div class="kv small wide">
        ${rowKV('Arrives as', `${I.shieldPlain} Shielded`)}
        ${r.received ? rowKV('Received', `<b class="good">${sats(r.received)}</b>`) : rowKV('Boltz locks', sats(r.onchain))}
        ${r.claimTxid ? rowKV('Transaction', `<a class="link" href="${this.account.explorer.tx(r.claimTxid)}" target="_blank" rel="noopener">${esc(short(r.claimTxid, 8))} ${I.ext}</a>`) : ''}
      </div>
      <button class="btn ghost wide" data-lnnew>${waiting && !late ? 'Back' : 'New invoice'}</button>
    </section>`;
  }
}
