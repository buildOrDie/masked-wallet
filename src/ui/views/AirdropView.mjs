import { esc, short } from '../../core/format.mjs';
import { Airdrop, MIN_EACH } from '../../wallet/Airdrop.mjs';
import { View } from '../View.mjs';
import { I, head, headWith, rowKV, seg, shieldLogo, sideLogo } from '../html.mjs';

const sats = (n) => `${Number(n || 0).toLocaleString()} sats`;
const gift = '<svg viewBox="0 0 24 24"><rect x="4" y="9" width="16" height="11" rx="2"/><path d="M3 9h18M12 9v11M12 9c-1.5-3-5-4-5.5-2S9 9 12 9c3 0 6-.5 5.5-2S13.5 6 12 9"/></svg>';

/** Send → Airdrop: paste addresses, set an amount, send everyone a silent payment in one transaction. */
export class AirdropView extends View {
  static tabs(on) { return seg('sendMode', on, [['send', 'One address'], ['airdrop', `${gift} Airdrop`]]); }

  render() {
    const st = this.state.drop;
    if (st.stage === 'review' && st.built) return this.review(st.built);
    if (st.stage === 'done' && st.built) return this.done2(st.built);
    return this.form();
  }

  /** Live counts under the paste box (also updated while typing, without a full render). */
  static countNote(pv) {
    if (!pv.n && !pv.wrongNet && !pv.invalid) return 'Paste addresses, one per line, or copy a whole X reply thread.';
    const extra = [pv.dupes && `${pv.dupes} duplicate${pv.dupes === 1 ? '' : 's'} removed`, pv.wrongNet && `${pv.wrongNet} from the other network skipped`, pv.invalid && `${pv.invalid} invalid skipped`, pv.own && 'your own address skipped'].filter(Boolean);
    return `<b>${pv.n} ${pv.n === 1 ? 'person' : 'people'}</b> found${extra.length ? ` · ${extra.join(' · ')}` : ''}`;
  }

  preview() {
    const f = this.f;
    return this.app.airdrop.preview({ text: f.dropText, each: Number(String(f.dropEach || '').replace(/[^\d]/g, '')), from: f.dropFrom, rate: this.app.feeRate() });
  }

  form() {
    const f = this.f, pv = this.preview();
    const each = Number(String(f.dropEach || '').replace(/[^\d]/g, ''));
    const ready = pv.n > 0 && each >= MIN_EACH;
    return `
    ${head('Send')}
    ${AirdropView.tabs('airdrop')}
    <section class="card form">
      <div class="field"><span class="lbl">Pay from</span>${this.fromSeg('dropFrom')}</div>
      <label class="field"><span class="lbl">Who gets it</span>
        <textarea class="drop-in mono" data-bind="dropText" spellcheck="false" placeholder="sp1qq…&#10;sp1qq…&#10;or paste a whole X reply thread">${esc(f.dropText || '')}</textarea>
        <span class="addr-kind ${pv.n ? 'k-shielded' : ''}" id="dropCount">${AirdropView.countNote(pv)}</span>
      </label>
      <label class="field"><span class="lbl">Each person gets</span>
        <div class="amount"><input data-bind="dropEach" inputmode="numeric" autocomplete="off" value="${esc(f.dropEach || '')}" placeholder="1000"><span class="unit">sats</span></div>
      </label>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${ready ? `<div class="kv small">
        ${rowKV('Total to send', `<b>${sats(pv.total)}</b>`)}
        ${rowKV('Network fee', `~${sats(pv.fee)}`)}
      </div>` : ''}
      ${this.statusLine('drop')}
      <button class="btn primary wide" id="btnReviewDrop" ${ready ? '' : 'disabled'}>${gift}<span>Review airdrop</span></button>
      <p class="info">Everyone gets a <b>silent payment</b>. On-chain, nobody can see who was paid.</p>
    </section>`;
  }

  review(b) {
    const busy = this.state.busy;
    return `
    ${headWith('data-dropback', 'Confirm airdrop')}
    <section class="card review">
      <p class="hero-label">You are airdropping</p>
      <p class="hero-bal">${b.total.toLocaleString()} <small>sats</small></p>
      <p class="muted center-text">${sats(b.each)} each to <b>${b.count} ${b.count === 1 ? 'person' : 'people'}</b></p>
      <div class="kv">
        ${rowKV('From', sideLogo(b.from))}
        ${rowKV('To', `${shieldLogo}<span class="good">${b.count} Shielded addresses</span>`)}
        ${rowKV('Network fee', sats(b.fee))}
        ${rowKV('Total', `<b>${sats(b.total + b.fee)}</b>`)}
      </div>
      ${this.statusLine('drop')}
      <button class="btn primary wide" id="btnConfirmDrop" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : `Send to ${b.count} ${b.count === 1 ? 'person' : 'people'}`}</button>
      <details class="adv"><summary>See the list</summary>
        <div class="drop-list mono">${b.recipients.map((a) => `<span>${esc(short(a, 10))}</span>`).join('')}</div>
      </details>
    </section>`;
  }

  done2(b) {
    return `
    <section class="done">
      <div class="done-ic">${I.check}</div>
      <h1>Airdrop sent!</h1>
      <p>${b.count} ${b.count === 1 ? 'person' : 'people'} got ${sats(b.each)} each, privately.</p>
      <p class="muted small">It lands in their Shielded balance with the next block.</p>
      <a class="btn ghost" href="${Airdrop.shareUrl(b.count)}" target="_blank" rel="noopener">${I.x}<span>Tell them on X</span></a>
      <a class="btn ghost" href="${this.account.explorer.tx(b.txid)}" target="_blank" rel="noopener">View on mempool ${I.ext}</a>
      <button class="btn primary wide" data-go="home" data-reset>Done</button>
    </section>`;
  }
}

