import { esc, fmtBtc, short } from '../../core/format.mjs';
import { IMAGE_TYPE, OrdinalGallery, TEXT_TYPE } from '../../ordinals/Gallery.mjs';
import { View } from '../View.mjs';
import { I, head, headWith, rowKV, seg, shieldLogo } from '../html.mjs';

const sideTxt = (s) => (s === 'shielded' ? `${I.shieldPlain} Shielded` : 'Public');

/** Ordinals: the inscriptions on both sides, and sending one (also privately, to a Shielded address). */
export class OrdinalsView extends View {
  /** Home's line for ordinals. */
  static homeRow(app) {
    const g = app.gallery, n = g.loadedFor === g.scope ? g.items.length : null;
    return `<button class="tok-line ord-line" data-go="ordinals">${OrdinalsView.icon}
      <span class="bal-txt"><b class="tk">Ordinals</b><span>Your inscriptions · send privately</span></span>
      <span class="bal-amt"><b>${n == null ? '' : n}</b><span>${n == null ? 'Open' : n === 1 ? 'item' : 'items'}</span></span><span class="chev">›</span></button>`;
  }

  static icon = '<span class="tok-ic ord-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="m4 17 5-5 4 4 2.5-2.5L20 18"/></svg></span>';

  render() {
    const { app, state } = this, g = app.gallery;
    const o = state.ord || (state.ord = {});
    if (g.loadedFor !== g.scope && !g.busy) { g.items = g.build(); g.refresh().then(() => app.state.view === 'ordinals' && app.render()); }
    if (o.done) return this.done('Inscription sent', o.done.kind === 'shielded' ? 'It lands on a Shielded address: nobody on the blockchain can tell who received it.' : 'It lands at the new address once a block confirms it.', o.done.txid);
    const item = o.sel && g.find(o.sel);
    if (item && o.built) return this.review(item, o.built);
    if (item) return this.detail(item);
    return this.grid();
  }

  grid() {
    const { app, f } = this, g = app.gallery;
    const all = g.items, side = f.ordSide || 'all';
    const list = side === 'all' ? all : all.filter((x) => x.side === side);
    const count = (s) => all.filter((x) => x.side === s).length;
    const loading = g.busy && g.loadedFor !== g.scope && !all.length;
    return `
    ${head('Ordinals')}
    <section class="card ord-top">
      ${seg('ordSide', side, [['all', `All · ${all.length}`], ['public', `Public · ${count('public')}`], ['shielded', `${I.shieldPlain} Shielded · ${count('shielded')}`]])}
      <div class="ord-bar"><span class="muted small">${g.busy ? 'Looking for your inscriptions…' : g.error ? '' : `${all.length} inscription${all.length === 1 ? '' : 's'}`}</span><button class="link" data-ordrefresh ${g.busy ? 'disabled' : ''}>Refresh</button></div>
      ${g.error ? `<p class="msg warn" role="status">${esc(g.error)}</p>` : ''}
    </section>
    ${loading ? '<section class="card"><p class="muted">Asking ordinals.com which coins hold inscriptions…</p></section>' : !list.length ? `<section class="card"><p class="muted">${side === 'shielded' ? 'No inscriptions on your Shielded side yet. Send one there from Public to hold it privately.' : 'No inscriptions here yet. Receive one to your Public address, or to your Shielded address to keep it private.'}</p></section>` : `
    <section class="ord-grid">${list.slice(0, 240).map((x) => `<button class="ord-tile" data-ordsel="${esc(x.id)}" aria-label="Inscription ${esc(this.numberOf(x.id))}">${this.thumb(x.id, false)}<span class="ord-cap"><span>${esc(this.numberOf(x.id))}</span>${x.side === 'shielded' ? `<span class="ord-sh">${I.shieldPlain}</span>` : ''}</span></button>`).join('')}</section>`}
    <p class="info">Inscriptions are protected in MASKED: Send, Shield and Mint never spend them. Previews load from ordinals.com.</p>`;
  }

  numberOf(id) {
    const i = this.app.gallery.of(id);
    return i?.number != null ? `#${i.number.toLocaleString('en-US')}` : short(id, 5);
  }

  /** A picture, a text snippet or a sandboxed preview. `big` is the detail screen. */
  thumb(id, big) {
    const g = this.app.gallery, type = g.of(id)?.type || '';
    if (IMAGE_TYPE.test(type)) return `<img class="ord-img" src="${esc(g.contentUrl(id))}" loading="lazy" referrerpolicy="no-referrer" alt="">`;
    if (TEXT_TYPE.test(type)) {
      if (!g.texts.has(id)) g.text(id).then(() => this.app.render());
      const t = g.texts.get(id) || '';
      const brc = OrdinalGallery.brc20Label(t);
      return brc ? `<span class="ord-txt ord-brc"><b>BRC-20</b><span>${esc(brc)}</span></span>` : `<span class="ord-txt">${esc(t.slice(0, big ? 400 : 90)) || '…'}</span>`;
    }
    // HTML and other inscriptions: ord's preview in a sandboxed frame (no access to the wallet), kept across re-renders
    if (type && (big || /^text\/html|^model\//i.test(type))) return `<iframe class="ord-frame ${big ? '' : 'ord-frame-tile'}" data-keep="${big ? 'big' : 'tile'}:${esc(id)}" src="${esc(g.previewUrl(id))}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy" tabindex="-1" title="Inscription preview"></iframe>`;
    return `<span class="ord-txt ord-kind">${esc(type ? type.split(';')[0].split('/').pop().toUpperCase() : '…')}</span>`;
  }

  detail(x) {
    const { app, f, state } = this, g = app.gallery, info = g.of(x.id) || {};
    const k = this.account.codec.kind(String(f.ordTo || '').trim());
    const toSelf = String(f.ordTo || '').trim() === this.account.shieldAddr();
    return `
    ${headWith('data-ordback', esc(this.numberOf(x.id)))}
    <section class="card ord-detail">
      <div class="ord-big">${this.thumb(x.id, true)}</div>
      <div class="kv">
        ${rowKV('Held on', sideTxt(x.side))}
        ${rowKV('Type', esc(info.type || '…'))}
        ${rowKV('Value', `${fmtBtc(x.sats)} ${this.unit}`)}
        ${rowKV('Inscription', `<a class="link mono" href="${esc(g.pageUrl(x.id))}" target="_blank" rel="noopener">${esc(short(x.id, 8))} ${I.ext}</a>`)}
      </div>
      ${x.together > 1 ? `<p class="info warn">This coin holds <b>${x.together} inscriptions</b>. They always move together.</p>` : ''}
      ${x.runes ? `<p class="info warn">This coin also holds runes. They move with it.</p>` : ''}
      ${x.pending ? '<p class="info">Still waiting for a block. You can send it once it confirms.</p>' : ''}
    </section>
    <section class="card form">
      <h2>Send</h2>
      <label class="field"><span class="lbl">To</span>
        <input id="ordTo" data-bind="ordTo" class="mono" spellcheck="false" autocomplete="off" value="${esc(f.ordTo)}" placeholder="bc1p… or a Shielded sp1… address">
        <span class="addr-kind k-${k.kind}" id="ordKind">${k.kind === 'empty' ? '' : toSelf ? 'Your own Shielded address' : esc(k.text)}</span></label>
      ${x.side === 'public' ? `<button class="chip ord-self ${toSelf ? 'on' : ''}" data-ordself>${shieldLogo}<span>Move to my Shielded side (private)</span></button>` : ''}
      <p class="fee-note">${k.kind === 'shielded' ? 'Private: nobody on the blockchain can tell who receives it.' : 'Tip: send to a Shielded address (sp1…) and nobody can tell who received it.'}</p>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${this.statusLine('ord')}
      <button class="btn primary wide" id="btnOrdReview" ${state.busy || x.pending ? 'disabled' : ''}>${state.busy ? 'Building…' : 'Review'}</button>
      <p class="muted small">The inscription keeps its own output and value. The fee comes from your plain ${x.side === 'shielded' ? 'Shielded' : 'Public'} bitcoin, never from the inscription.</p>
    </section>`;
  }

  review(x, b) {
    const { state, f } = this;
    const like = b.toSelf ? '' : this.app.lookAlike(b.recipient);
    const blocked = !!like && !f.poisonOk;
    return `
    ${headWith('data-ordreviewback', 'Confirm')}
    <section class="card review">
      <p class="hero-label">${b.toSelf ? 'You are moving to Shielded' : 'You are sending'}</p>
      <div class="ord-mini">${this.thumb(x.id, false)}</div>
      <p class="hero-bal" style="font-size:28px">${esc(this.numberOf(x.id))}</p>
      <div class="kv">
        ${rowKV('From', sideTxt(b.from))}
        ${rowKV('To', b.toSelf ? `${shieldLogo}<b>My Shielded side</b>` : `<span class="mono">${esc(short(b.recipient, 10))}</span>`)}
        ${rowKV('Privacy', b.kind === 'shielded' ? '<span class="good">Private — the receiver is hidden</span>' : '<span class="meh">Public address</span>')}
        ${rowKV('Inscription output', `${fmtBtc(b.postage)} ${this.unit} (unchanged)`)}
        ${rowKV('Network fee', `${fmtBtc(b.fee)} ${this.unit}`)}
      </div>
      ${x.together > 1 ? `<p class="info warn">All ${x.together} inscriptions on this coin move together.</p>` : ''}
      ${like ? `<label class="risk"><input type="checkbox" data-poisonok ${f.poisonOk ? 'checked' : ''}><span><b>Look-alike address.</b> It starts and ends like <span class="mono">${esc(short(like, 6))}</span>, an address you used before, but it's different. Tick only if you checked every character.</span></label>` : ''}
      ${this.statusLine('ord')}
      <button class="btn primary wide" id="btnOrdSend" ${state.busy || blocked ? 'disabled' : ''}>${state.busy ? 'Sending…' : 'Confirm & send'}</button>
    </section>`;
  }
}
