import { dayLabel, esc, formatRaw, short } from '../../core/format.mjs';
import { isV2 } from '../../ordinals/brc20.mjs';
import { View } from '../View.mjs';
import { I, btcLogo, shieldLogo, tokBadge, tokIcon } from '../html.mjs';

/** How each kind of history event looks. */
const EV = {
  mint: { t: 'Mint', ic: 'mint', cls: 'in' },
  in: { t: 'Receive', ic: 'recv', cls: 'in' },
  out: { t: 'Send', ic: 'send', cls: 'out' },
  move: { t: 'Move', ic: 'send', cls: 'mv' },
  list: { t: 'Inscribed to sell', ic: 'list', cls: 'mv' },
  sold: { t: 'Sold', ic: 'send', cls: 'out' },
};

/** A token page: balance, where it sits, actions, History / Details. */
export class TokenView extends View {
  render() {
    const { app } = this;
    const tick = this.state.tokTick;
    if (!tick) { this.state.view = 'home'; return app.ui.view('home').render(); }
    const book = app.tokens, coins = app.coins;
    const T = esc(tick.toUpperCase());
    const L = book.ledger(tick);
    const pub = book.heldOn(tick, 'public'), shd = book.heldOn(tick, 'shielded');
    const tab = this.f.tokTab || 'history';
    const inscribed = book.inscribedFor(tick);
    const total = (L.held + L.listed).toLocaleString();
    return `
    <div class="tok-page">
      <div class="view-head"><button class="icon-btn" data-go="${this.state.tokFrom || 'home'}" aria-label="Back">${I.back}</button><span class="head-sp"></span></div>
      <div class="tok-hero">${tokIcon(tick, true)}<p class="tok-name">${T} ${tokBadge(tick)}</p><p class="tok-big">${total}</p>${L.pendingIn ? `<p class="pend-t small">+${L.pendingIn.toLocaleString()} incoming · waiting for a block</p>` : ''}</div>
      <section class="card tok-box">
        <div class="d-row"><span>In wallet</span><b>${total}</b></div>
        <div class="d-row"><span>${btcLogo} Public</span><b>${pub.toLocaleString()}</b></div>
        ${inscribed ? `<div class="d-row sub"><span>· inscribed, ready to list</span><span>${inscribed.toLocaleString()}</span></div>` : ''}
        <div class="d-row"><span>${shieldLogo} Shielded</span><b class="sh-t">${(shd + L.listed).toLocaleString()}</b></div>
        ${L.listed ? `<div class="d-row sub"><span>· inscribed to sell${L.events.some((e) => e.kind === 'list' && e.pending) ? ' (confirming)' : ''}</span><span>${L.listed.toLocaleString()}</span></div>` : ''}
        <div class="tok-acts">
          <button class="tact" data-tsend="${esc(tick)}" ${L.held ? '' : 'disabled'}>${I.send}<span>Send</span></button>
          <button class="tact" data-go="receive" data-recv="shielded">${I.recv}<span>Receive</span></button>
          <button class="tact" data-tinsc="${esc(tick)}" ${book.transferAvail(tick) ? '' : 'disabled'} title="Inscribe a transfer to list or send">${I.list}<span>Inscribe</span></button>
          <button class="tact" data-tmint="${esc(tick)}">${I.mint}<span>Mint</span></button>
        </div>
      </section>
      <div class="tabs">${[['history', 'History'], ['details', 'Details']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-set="tokTab" data-val="${k}">${l}</button>`).join('')}</div>
      ${tab === 'history' ? `<section class="hist">${this.history(L)}</section>` : this.details(tick, L, coins)}
    </div>`;
  }

  /** History grouped by day, pending first. */
  history(L) {
    const explorer = this.account.explorer;
    const groups = []; let cur = null;
    for (const e of [...L.events].sort((x, y) => (y.pending - x.pending) || ((y.at || 0) - (x.at || 0)))) {
      const label = e.pending ? 'Pending' : dayLabel(e.at);
      if (!cur || cur.label !== label) groups.push(cur = { label, list: [] });
      cur.list.push(e);
    }
    if (!groups.length) return '<p class="muted small center">No activity yet.</p>';
    const who = (e) => {
      if (e.kind === 'list') return e.pending ? 'Confirming · then it can sell' : 'Ready to sell, on a one-time address';
      if (e.kind === 'sold') return 'Bitcoin went to Shielded';
      if (e.kind === 'in') return e.from ? `From ${esc(short(e.from, 6))}` : 'From another wallet';
      if (e.kind === 'out' || e.kind === 'move') return `To ${esc(short(e.to || '', 6))}`;
      return `To your ${e.where || 'wallet'}`;
    };
    const sign = (e) => (e.kind === 'out' || e.kind === 'sold' ? '−' : e.kind === 'move' || e.kind === 'list' ? '' : '+');
    return groups.map((g) => `<p class="h-day">${esc(g.label)}</p>${g.list.map((e) => `<a class="h-row" href="${explorer.tx(e.txid)}" target="_blank" rel="noopener">
      <span class="h-ic ${EV[e.kind].cls}">${I[EV[e.kind].ic]}</span>
      <span class="bal-txt"><b>${EV[e.kind].t}${e.where && e.kind !== 'out' && e.kind !== 'sold' ? ` <span class="where ${e.where === 'Shielded' ? 'sh' : ''}">${e.where}</span>` : ''}</b><span>${who(e)}</span></span>
      <span class="h-amt ${EV[e.kind].cls}">${sign(e)}${e.amt.toLocaleString()}</span></a>`).join('')}`).join('');
  }

  details(tick, L, coins) {
    const app = this.app, ins = app.inscriptions;
    const holds = app.tokens.holdings(tick);
    const d = app.deploys.list().find((x) => x.tick === tick && x.status === 'deployed');
    const own = [...coins.public.map((c) => ({ c, kind: 'public' })), ...coins.shielded.map((c) => ({ c, kind: 'shielded' }))].filter(({ c }) => ins.describe(c)?.tick === tick);
    const depCoin = own.map(({ c }) => ins.describe(c)).find((i) => i?.op === 'deploy');
    const max = d?.max ?? depCoin?.max;
    const kv = (k, v) => `<div class="d-row"><span>${k}</span><span>${v}</span></div>`;
    return `<div class="d-list">
      ${kv('Ticker', esc(tick.toUpperCase()))}${kv('Standard', isV2(tick) ? 'BRC2.0 (6 letters)' : 'BRC-20')}
      ${max ? kv('Max supply', Number(max).toLocaleString()) : ''}
      ${d ? kv('Deployed by', 'You' + (d.selfMint ? ' · only you can mint' : '')) : ''}
      ${kv('Minted here', L.minted.toLocaleString())}${kv('Received', L.received.toLocaleString())}${kv('Sent', L.sent.toLocaleString())}
      ${kv('Sits on', `${holds.length} address${holds.length === 1 ? '' : 'es'}`)}
      ${app.tokenServer.url() ? `<div class="d-row">${this.indexerLine(tick)}</div>` : ''}
    </div>
    ${own.length ? `<section class="card list"><div class="list-h"><b>Coins</b><span class="muted small">never spent by Send or Shield</span></div>${own.map(({ c, kind }) => app.ui.coins.row(c, kind)).join('')}</section>` : ''}`;
  }

  /** What the token server says about this balance, and how well it was checked. */
  indexerLine(tick) {
    const app = this.app;
    if (!app.tokenServer.url()) return '';
    const i = app.tokens.idx;
    if (!i) return '<span class="idx-line muted">Indexer: checking…</span>';
    if (i.err) return `<span class="idx-line neg">Indexer: ${esc(i.err)}</span>`;
    const raw = i.tokens[tick];
    const dec = Number(i.decimals?.[tick] ?? app.deploys.find(tick)?.dec ?? 18);
    if (raw == null) return '<span class="idx-line muted">Indexer: not seen yet</span>';
    const validation = i.validation?.[tick];
    const label = validation === 'matched' ? 'OPI + UniSat balance match' : validation === 'conflict' ? 'Sources disagree — swaps paused' : validation === 'unavailable' ? 'Validation unavailable — swaps paused' : 'Indexer-reported balance';
    const cls = validation === 'conflict' || validation === 'unavailable' ? 'neg' : validation === 'matched' && raw !== '0' ? 'good' : 'muted';
    return `<span class="idx-line ${cls}">${esc(label)}: ${formatRaw(raw, dec)} · block ${i.height?.toLocaleString()}</span>`;
  }
}
