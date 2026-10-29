// Rows shared by several screens: coins (Coins & inscriptions, token pages) and tokens (Home, Coins).
import { esc, fmtBtc, fmtTok, short } from '../core/format.mjs';
import { isV2 } from '../ordinals/brc20.mjs';
import { INSCRIPTION_MAX } from '../ordinals/envelope.mjs';
import { I, btcLogo, shieldLogo, tokIcon } from './html.mjs';

export class CoinList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  /** What a coin is, in plain words: { title, badge, amt (token amount line), group } */
  tag(c, kind) {
    const app = this.app;
    const ins = app.inscriptions.describe(c);
    const T = ins?.tick ? esc(ins.tick.toUpperCase()) : '';
    const badge = ins?.brc20 ? (ins.op === 'predeploy' || isV2(ins.tick) ? '<span class="badge v2">BRC2.0</span>' : '<span class="badge">BRC-20</span>') : '';
    if (ins?.brc20) {
      if (ins.op === 'mint') return { title: `Minted ${T}`, badge, amt: `<b class="pos">+${fmtTok(ins.amt)}</b><span>${T}</span>`, group: 'tokens' };
      if (ins.op === 'transfer' && app.transfers.list().some((x) => x.sendTxid === c.txid)) return { title: `Moved ${T}`, badge, amt: `<b>${fmtTok(ins.amt)}</b><span>to yourself</span>`, group: 'tokens' };
      if (ins.op === 'transfer' && ins.received) return { title: `Received ${T}`, badge, amt: `<b class="pos">+${fmtTok(ins.amt)}</b><span>${T}</span>`, group: 'tokens' };
      if (ins.op === 'transfer') return { title: `${T} transfer`, badge, amt: `<b>${fmtTok(ins.amt)}</b><span>${ins.ready ? 'ready to list or send' : 'not delivered'}</span>`, group: 'tokens' };
      if (ins.op === 'deploy') return { title: `${T} deploy`, badge, amt: `<b class="dim">No tokens</b><span>${ins.max ? `max ${fmtTok(ins.max)}` : 'kept for minting'}</span>`, group: 'deploy' };
      if (ins.op === 'predeploy') return { title: `${T ? T + ' ' : ''}ticker reservation`, badge, amt: '<b class="dim">No tokens</b><span>kept safe</span>', group: 'deploy' };
      return { title: `${T} ${esc(ins.op)}`, badge, amt: '', group: 'deploy' };
    }
    const o = app.ord.of(c);
    if (o && (o.ins || o.runes)) return { title: o.runes && !o.ins ? 'Runes' : 'Inscription', badge: '<span class="badge">ord</span>', amt: '', group: 'other' };
    if (c.sats != null && c.sats <= INSCRIPTION_MAX) return { title: ins && !ins.unknown && ins.contentType ? `Inscription · ${esc(ins.contentType.split(';')[0])}` : 'Small coin', badge: '', amt: '', group: 'other' };
    return { title: kind === 'public' ? 'Public' : 'Shielded', badge: '', amt: '', group: 'btc' };
  }

  row(c, kind) {
    const app = this.app, explorer = app.account.explorer, coins = app.coins;
    const outAddr = kind === 'public' ? c.address : app.account.codec.trAddress(c.output);
    const t = this.tag(c, kind);
    const op = `${c.txid}:${c.vout}`, auto = coins.autoProtected(c), locked = auto || coins.locks().has(op);
    const ins = app.inscriptions.of(c);
    const where = kind === 'public' ? 'Public' : 'Shielded';
    const logo = kind === 'public' ? btcLogo : shieldLogo;
    const lockBtn = `<button class="lock ${locked ? 'on' : ''}" data-lock="${op}" ${auto ? 'disabled' : ''} title="${auto ? 'Holds an inscription — always protected' : locked ? 'Unlock coin' : 'Lock coin so it is never spent'}" aria-label="Lock">${locked ? I.lock : I.unlock}</button>`;
    const links = `<span class="row-links">${ins?.id ? `<a href="${explorer.inscription(ins.id)}" target="_blank" rel="noopener">Inscription</a>` : `<a href="${explorer.ordAddress(outAddr)}" target="_blank" rel="noopener">Ordinals</a>`}<a href="${explorer.tx(c.txid)}" target="_blank" rel="noopener">Tx</a></span>`;
    const pend = c.pending ? '<em class="pend">pending</em>' : '';
    if (t.amt) {
      // inscription coin: token amount first, the sats it sits on second
      return `<div class="coin-row ins ${locked ? 'locked' : ''}">
      ${logo}
      <span class="bal-txt"><b>${t.title} ${t.badge}${pend}</b><span class="small muted">${where} · ${c.pending ? 'waiting for a block' : 'confirmed'}</span>
        <span class="safe">${I.lock} Protected · ${fmtTok(c.sats)} sats</span></span>
      <span class="bal-amt tok-amt">${t.amt}${links}</span>
    </div>`;
    }
    const ord = app.ord;
    // a small coin protected only for its size (no inscription known): it can be unlocked after an ord check
    const o = ord.of(c), small = c.sats != null && c.sats <= INSCRIPTION_MAX && !(o && (o.ins || o.runes)) && !(ins && !ins.unknown);
    const freed = small && coins.freed().has(op) && !auto;
    const smallNote = small && auto
      ? `<span class="safe">${I.lock} Protected (small coin)</span><button class="link small" data-unlock="${op}" title="MASKED asks ord first: only plain bitcoin is unlocked">Unlock</button>`
      : freed ? `<span class="small muted">plain bitcoin · checked by ord · unlocked</span><button class="link small" data-relock="${op}">Protect again</button>` : '';
    const note = smallNote || (locked ? `<span class="safe">${I.lock} ${auto ? 'Protected' : 'Locked'}</span>` : ord.unverified(c) ? '<span class="small pend-t">checking with ord…</span>' : ord.needs(c) && ord.of(c) ? '<span class="small muted">plain bitcoin · checked by ord</span>' : '');
    return `<div class="coin-row ${locked ? 'locked' : ''}">
    ${logo}
    <span class="bal-txt"><b>${t.title} ${t.badge}${pend}${c.example ? '<em class="pend">demo</em>' : ''}</b><span class="mono">${short(c.txid, 6)}:${c.vout}</span>
      ${note}</span>
    <span class="bal-amt"><span class="amt-row"><b>${fmtBtc(c.sats)}</b>${lockBtn}</span>${links}</span>
  </div>`;
  }
}

export class TokenList {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  rows(list) {
    const book = this.app.tokens;
    return list.map((t) => `<button class="tok-line" data-tok="${esc(t.tick)}">${tokIcon(t.tick)}
      <span class="bal-txt"><b class="tk">${esc(t.tick.toUpperCase())}</b><span>${t.v2 ? 'BRC2.0' : 'BRC-20'}${book.ledger(t.tick).pendingIn ? ' · <span class="pend-t">incoming</span>' : ''}</span></span>
      <span class="bal-amt"><b>${t.held.toLocaleString()}</b><span>${t.listed ? `${t.listed.toLocaleString()} listed` : t.held ? 'in wallet' : 'none left'}</span></span><span class="chev">›</span></button>`).join('');
  }

  /** Home: UniSat-style token list with All / BRC-20 / BRC2.0 (/ CRC-20 when held) tabs, for one side. */
  home(side = null, crc20 = '') {
    const book = this.app.tokens;
    const sideName = side === 'shielded' ? 'Shielded' : 'Public';
    const all = side
      ? book.list().map((t) => {
        const amt = book.heldOn(t.tick, side) + (side === 'shielded' ? t.listed : 0);
        return { ...t, held: amt, listed: side === 'shielded' ? t.listed : 0 };
      }).filter((t) => t.held > 0)
      : book.list();
    const crc = crc20 ? 1 : 0;
    if (side && !all.length && !crc) return `<section class="home-toks"><div class="list-h"><b>Tokens</b><span class="muted small">${sideName}</span></div><p class="muted small center">No tokens on this side yet.</p></section>`;
    if (!all.length && !crc) return '';
    let f = this.app.state.f.homeTok || 'all';
    if (f === 'crc20' && !crc) f = 'all';
    const v1 = all.filter((t) => !t.v2), v2 = all.filter((t) => t.v2);
    const rows = f === 'brc20' ? this.rows(v1) : f === 'brc2' ? this.rows(v2) : f === 'crc20' ? crc20 : this.rows(all) + crc20;
    // a kind you hold none of gets no tab (All always shows); four tabs still fit by scrolling sideways
    const pills = /** @type {[string, number][]} */ ([['all', all.length + crc], ['brc20', v1.length], ['brc2', v2.length], ['crc20', crc]])
      .filter(([k, n]) => k === 'all' || n > 0 || k === f)
      .map(([k, n]) => [k, `${{ all: 'All', brc20: 'BRC-20', brc2: 'BRC2.0', crc20: 'CRC-20' }[k]} (${n})`]);
    return `<section class="home-toks">
    <div class="list-h"><b>Tokens</b>${side ? `<span class="muted small">${sideName}</span>` : ''}</div>
    <div class="pills">${pills.map(([k, l]) => `<button class="pill ${f === k ? 'on' : ''}" data-set="homeTok" data-val="${k}">${l}</button>`).join('')}</div>
    <div class="tok-list">${rows || '<p class="muted small center">None yet.</p>'}</div>
  </section>`;
  }
}
