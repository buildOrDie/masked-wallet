import { esc } from '../../core/format.mjs';
import { isV2 } from '../../ordinals/brc20.mjs';
import { INSCRIPTION_MAX } from '../../ordinals/envelope.mjs';
import { View } from '../View.mjs';
import { I, backBtn, seg } from '../html.mjs';

/** Settings → Coins & inscriptions: every coin, with lock buttons and the manual payment check. */
export class ActivityView extends View {
  render() {
    const { app } = this;
    const sync = app.sync, ins = app.inscriptions, rows = app.ui.coins;
    const p = sync.progress;
    const filter = this.f.coinFilter;
    const all = [...app.coins.public.map((c) => ({ c, kind: 'public' })), ...app.coins.shielded.map((c) => ({ c, kind: 'shielded' }))];
    const isBrc2 = ({ c }) => { const i = ins.of(c); return !!i?.brc20 && (isV2(i.tick) || i.op === 'predeploy'); };
    const isBtc = ({ c }) => c.sats == null || c.sats > INSCRIPTION_MAX;
    const shown = all.filter(filter === 'btc' ? isBtc : filter === 'brc2' ? isBrc2 : () => true);
    const count = (fn) => all.filter(fn).length;
    const empty = filter === 'brc2' ? 'No BRC2.0 tokens yet. Deploy or mint one from the Mint tab.' : filter === 'btc' ? 'No bitcoin yet.' : 'No coins yet. Receive some, then they show up here.';
    const v2Tokens = filter === 'brc2' ? app.tokens.list().filter((t) => t.v2) : [];
    let list;
    if (filter === 'brc2' && shown.length) {
      const group = (k) => shown.filter(({ c, kind }) => rows.tag(c, kind).group === k);
      const tok = group('tokens'), dep = group('deploy');
      list = `${tok.length ? `<section class="card list"><div class="list-h"><b>Token coins</b><span class="muted small">hold your balance</span></div>${tok.map(({ c, kind }) => rows.row(c, kind)).join('')}</section>` : ''}
        ${dep.length ? `<section class="card list"><div class="list-h"><b>Deploy coins</b><span class="muted small">no tokens · never spent</span></div>${dep.map(({ c, kind }) => rows.row(c, kind)).join('')}</section>` : ''}`;
    } else {
      list = `<section class="card list">${shown.map(({ c, kind }) => rows.row(c, kind)).join('') || `<p class="muted center">${empty}</p>`}</section>`;
    }
    return `
    <div class="view-head">${backBtn('settings')}<h1>Coins &amp; inscriptions</h1><span class="head-sp"></span><button class="icon-btn ${sync.syncing ? 'spin' : ''}" id="btnSync" aria-label="Refresh">${I.refresh}</button></div>
    <p class="muted small" style="margin:-6px 2px 12px">Every coin in this wallet. Coins holding inscriptions are protected automatically. Lock any other coin to keep it from being spent.</p>
    ${seg('coinFilter', filter, [['all', `All · ${all.length}`], ['btc', `BTC · ${count(isBtc)}`], ['brc2', `BRC2.0 · ${count(isBrc2)}`]])}
    ${v2Tokens.length ? `<section class="tok-list">${app.ui.tokens.rows(v2Tokens)}</section>` : ''}
    ${list}
    <p class="muted small center">${sync.text()}${p && p.nextHeight >= 0 && !this.account.keys?.fresh ? ` · history checked back to block ${(p.nextHeight + 1).toLocaleString()}` : ''}</p>
    ${sync.error ? `<p class="msg err">${esc(sync.error)}</p>` : ''}
    <details class="card adv"><summary>Find a payment manually</summary>
      <p class="muted small">Paste a transaction's JSON from mempool.space (/api/tx/&lt;txid&gt;) to check it for shielded payments.</p>
      <textarea data-bind="scanText" rows="5" class="mono" spellcheck="false">${esc(this.f.scanText)}</textarea>
      <div class="row"><button class="btn primary sm" id="btnScan">Check</button><button class="btn ghost sm" id="btnResetScan">Reset coin list</button></div>
      ${this.statusLine('scan')}
    </details>`;
  }
}
