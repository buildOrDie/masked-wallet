import { esc, fmtBtc, short } from '../../core/format.mjs';
import { fmtLeaf } from '../../tokens/leaf.mjs';
import { View } from '../View.mjs';
import { I, head, headWith, rowKV, seg, shieldLogo } from '../html.mjs';

export const leafIcon = (big = false) => `<span class="tok-ic leaf-ic ${big ? 'big' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z"/><path d="M5 19 13 11"/></svg></span>`;

/** LEAF (CRC-20): balances on both sides, and Send → review → done. */
export class LeafView extends View {
  /** The LEAF line in Home's token list, only when this side holds some (like BRC-20 tokens). */
  static homeRow(app, side) {
    const l = app.leaf;
    if (!l.on) return '';
    l.refresh();
    const t = l.total(side);
    if (!t) return '';
    return `<button class="tok-line" data-go="leaf" data-leafside="${side}">${leafIcon()}
      <span class="bal-txt"><b class="tk">LEAF</b><span>CRC-20</span></span>
      <span class="bal-amt"><b>${fmtLeaf(t)}</b><span>in wallet</span></span><span class="chev">›</span></button>`;
  }

  render() {
    const { app } = this, l = app.leaf, st = this.state.leafSend;
    if (!l.on) return `${head('LEAF')}<section class="card"><p class="muted">LEAF is a Mainnet token. Switch network in Settings.</p></section>`;
    if (st.stage === 'review' && st.built) return this.review(st.built);
    if (st.stage === 'done' && st.built) {
      const b = st.built;
      return this.done('Sent!', `${esc(fmtLeaf(b.atoms))} LEAF to ${esc(short(b.recipient, 8))}${b.kind === 'shielded' ? ', privately' : ''}.`, b.txid, 'LEAF moves once the transaction confirms. Balances update after the next block.');
    }
    return this.form();
  }

  form() {
    const { app, f } = this, l = app.leaf;
    const side = f.leafFrom;
    const avail = l.available(side);
    const max = side === 'shielded' ? l.maxShieldedOnce() : avail;
    const stuck = l.sh.filter((s) => !s.coinKey).reduce((a, s) => a + s.atoms, 0n);
    return `
    ${head('LEAF')}
    <section class="hero leaf-hero">
      ${leafIcon(true)}
      <p class="hero-label">LEAF · CRC-20 on Bitcoin</p>
      <div class="leaf-sides">
        <span><small>Public</small><b>${l.pub == null ? '…' : fmtLeaf(l.total('public'))}</b></span>
        <span class="sh"><small>${I.shieldPlain} Shielded</small><b>${fmtLeaf(l.total('shielded'))}</b></span>
      </div>
      <button class="sync ${l.busy ? 'spin' : ''} ${l.error ? 'bad' : ''}" data-leafrefresh title="${esc(l.error)}">${I.refresh}<span>${l.busy ? 'Checking crc20.org…' : l.error ? 'crc20.org did not answer' : l.behind ? 'crc20.org is catching up' : l.at ? 'Confirmed balances' : 'Check balances'}</span></button>
    </section>
    <section class="card form">
      <div class="field"><span class="lbl">From</span>${seg('leafFrom', side, [['public', `Public · ${fmtLeaf(l.available('public'))}`], ['shielded', `${I.shieldPlain} Shielded · ${fmtLeaf(l.available('shielded'))}`]])}</div>
      <label class="field"><span class="lbl">To</span><input id="leafTo" data-bind="leafTo" class="mono" spellcheck="false" autocomplete="off" value="${esc(f.leafTo)}" placeholder="bc1p…, bc1q… or a Shielded sp1…"></label>
      <label class="field"><span class="lbl">Amount <span class="lbl-r">${side === 'shielded' && max < avail ? `Up to ${fmtLeaf(max)} per send` : `Available ${fmtLeaf(avail)}`}</span></span>
        <div class="amount"><input id="leafAmt" data-bind="leafAmt" inputmode="decimal" autocomplete="off" value="${esc(f.leafAmt)}" placeholder="0"><span class="unit">LEAF</span><button class="max" data-leafmax>MAX</button></div>
      </label>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${this.statusLine('leaf')}
      <button class="btn primary wide" id="btnLeafReview">Review</button>
      <p class="info">${side === 'shielded'
        ? 'Shielded LEAF sits on one-time addresses. One send moves LEAF from one of them; the fee is paid from your Shielded balance.'
        : 'Send to a Shielded sp1… address and the receiver gets it privately. LEAF can only go to bc1p… or bc1q… addresses, never 1… or 3….'}</p>
      ${stuck ? `<p class="info warn">${esc(fmtLeaf(stuck))} Shielded LEAF sits on an address with no BTC left to move it. It's safe; sending a little BTC there makes it spendable again.</p>` : ''}
    </section>`;
  }

  review(b) {
    const busy = this.state.busy;
    const btcOut = b.fee + (b.kind === 'shielded' ? 330 : b.recipient.startsWith('bc1q') ? 294 : 330) + (b.partial ? 330 : 0);
    return `
    ${headWith('data-leafback', 'Confirm')}
    <section class="card review">
      <p class="hero-label">You are sending</p>
      <p class="hero-bal">${esc(fmtLeaf(b.atoms))} <small>LEAF</small></p>
      <div class="kv">
        ${rowKV('From', b.from === 'shielded' ? `${shieldLogo}<b>Shielded</b>` : '<b>Public</b>')}
        ${rowKV('To', `<span class="mono">${esc(short(b.recipient, 10))}</span>`)}
        ${rowKV('Privacy', b.kind === 'shielded' ? '<span class="good">Private: lands on a one-time address</span>' : '<span class="meh">Public address</span>')}
        ${rowKV('Network fee', `${fmtBtc(b.fee)} ${this.unit}`)}
        ${rowKV('BTC used', `${fmtBtc(btcOut)} ${this.unit}`)}
      </div>
      ${b.partial ? '<p class="info">330 sats go back to the same Shielded address, so the rest of its LEAF stays spendable.</p>' : ''}
      ${this.statusLine('leaf')}
      <button class="btn primary wide" id="btnLeafConfirm" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Confirm & send'}</button>
      <details class="adv"><summary>Transaction details</summary>
        <div class="kv small">${rowKV('Txid', `<span class="mono">${short(b.txid, 8)}</span>`)}${rowKV('Size', `${b.vsize} vB`)}</div>
        <p class="muted small">Output 0 is the LEAF message, output 1 the receiver, as the CRC-20 rules require.</p>
      </details>
    </section>`;
  }
}
