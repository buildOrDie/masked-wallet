// Base class of every screen. A view turns the app's state into HTML (render) and has the shared pieces
// most screens need: status lines, the fee picker, network notes and the "done" screen.
import { esc, fmtRate } from '../core/format.mjs';
import { NETWORKS } from '../bitcoin/networks.mjs';
import { TxPolicy } from '../bitcoin/RawTransaction.mjs';
import { FEE_MAX, FEE_MIN, FeeOracle } from '../net/FeeOracle.mjs';
import { I, seg } from './html.mjs';

export class View {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  get state() { return this.app.state; }
  /** Form fields (inputs, segmented controls). */
  get f() { return this.app.state.f; }
  get account() { return this.app.account; }
  get unit() { return this.app.account.unit; }

  /** @returns {string} */
  render() { throw new Error(`${this.constructor.name} has no render()`); }

  statusLine(key) {
    const s = this.state.status[key];
    return s ? `<p class="msg ${s[1]}" role="status">${esc(s[0])}</p>` : '';
  }

  netBanner() {
    return this.account.isTest ? `<div class="testnet-note"><span class="dot-warn"></span>${this.account.params.name} · test coins with no real value</div>` : '';
  }

  brc2NetNote() {
    const net = this.state.net;
    if (net === 'signet' || net === 'main') return '';
    return `<div class="testnet-note warn-box"><span class="dot-warn"></span><span>BRC2.0 runs on <b>Signet</b>. ${NETWORKS[net].name} indexers won't see it.</span><button class="btn ghost sm" data-setnet="signet">Switch</button></div>`;
  }

  /** Public | Shielded picker for the side that pays, with what each side can spend. */
  fromSeg(name) {
    const coins = this.app.coins;
    return seg(name, this.f[name], [['public', `Public · ${coins.spendLabel('public')}`], ['shielded', `${I.shieldPlain} Shielded · ${coins.spendLabel('shielded')}`]]);
  }

  /** Slow / Avg / Fast / Custom, plus the RBF switch. */
  feeChips() {
    const f = this.app.fees.rates, k0 = this.f.fee;
    const custom = FeeOracle.custom(this.f.feeCustom);
    const card = (k, name, time, cls = '') => `<button class="fee ${cls} ${k0 === k ? 'on' : ''}" data-set="fee" data-val="${k}"><b>${name}</b><span class="r"><em>${fmtRate(f[k])}</em> sat/vB</span><span class="t">${time}</span></button>`;
    const v = this.f.feeCustom || '', bad = k0 === 'custom' && v !== '' && !custom;
    const high = k0 === 'custom' && custom > Math.max(50, f.fast * 5);
    return `<div class="fees">
      ${card('slow', f.slow < 1 ? 'Sub 1' : 'Slow', 'slower')}
      ${card('normal', 'Avg', '~30 min', 'avg')}
      ${card('fast', 'Fast', '~10 min', 'fast')}
      <button class="fee custom ${k0 === 'custom' ? 'on' : ''}" data-set="fee" data-val="custom"><b>Custom</b>${k0 === 'custom' && custom ? `<span class="r"><em>${fmtRate(custom)}</em> sat/vB</span>` : ''}</button>
    </div>
    ${k0 === 'custom' ? `<div class="amount fee-in"><input id="feeCustom" data-bind="feeCustom" type="number" inputmode="decimal" min="${FEE_MIN}" max="${FEE_MAX}" step="0.01" placeholder="e.g. ${fmtRate(f.slow)}" value="${esc(v)}" autocomplete="off"><span class="unit">sat/vB</span></div>
      <p class="fee-note ${bad ? 'bad' : high ? 'warn' : ''}" id="feeNote">${bad ? `Enter ${FEE_MIN} to ${FEE_MAX} sat/vB. Using Avg (${fmtRate(f.normal)}) until then.` : high ? 'That is much higher than needed right now.' : `Lowest ${FEE_MIN} sat/vB. Below 1 is cheapest but can wait longer if blocks fill up.`}</p>` : ''}
    <div class="rbf-row"><span>RBF <button class="q" data-rbfinfo aria-label="What is RBF?">?</button></span><label class="sw-tgl"><input type="checkbox" data-rbf ${TxPolicy.rbf ? 'checked' : ''}><span></span></label></div>
    ${this.f.rbfInfo ? '<p class="fee-note">Replace-by-fee: if the transaction gets stuck, it can be replaced with a higher fee. Some sellers ask for RBF off; most people leave it on.</p>' : ''}`;
  }

  /** The screen after a broadcast. */
  done(title, sub, txid, extra = '', more = '') {
    return `
    <section class="done">
      <div class="done-ic">${I.check}</div>
      <h1>${title}</h1>
      <p>${sub}</p>
      ${extra ? `<p class="muted small">${extra}</p>` : ''}
      <a class="btn ghost" href="${this.account.explorer.tx(txid)}" target="_blank" rel="noopener">View on mempool ${I.ext}</a>
      ${more}
      <button class="btn ${more ? 'ghost' : 'primary'} wide" data-go="home" data-reset>Done</button>
    </section>`;
  }
}
