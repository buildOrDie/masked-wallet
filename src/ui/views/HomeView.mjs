import { RgbHome } from './RgbViews.mjs';
import { LANG_KEY } from '../../i18n/translate.mjs';
import { esc, fmtBtc, sumSats } from '../../core/format.mjs';
import { INSCRIPTION_MAX } from '../../ordinals/envelope.mjs';
import { View } from '../View.mjs';
import { LeafView } from './LeafView.mjs';
import { EcashView } from './EcashView.mjs';
import { OrdinalsView } from './OrdinalsView.mjs';
import { I, btcLogo, shieldLogo } from '../html.mjs';

/** Home: the balance of the side on show (Public or Shielded), actions, both balances and the tokens. */
export class HomeView extends View {
  /** A Chinese browser, and no language chosen yet: offer Chinese once (it never switches by itself). */
  static langHint() {
    let asked = true;
    try { asked = !!localStorage.getItem(LANG_KEY) || localStorage.getItem('masked.lang-hint') === '1'; } catch { /* storage blocked */ }
    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '');
    if (asked || !zh) return '';
    return `<div class="hint lang-hint" translate="no"><b>切换到中文？</b><span>MASKED 有中文版（测试中）。也可以随时在设置里更改。</span>
      <span class="lang-btns"><button class="btn primary sm" data-lang="zh-CN">使用中文</button><button class="btn ghost sm" data-lang="en">Keep English</button></span></div>`;
  }
  /** The phone app: a newer version is out. Updates in the app when it can, else through the install page. */
  static updateCard(app, up) {
    const c = app.update.card(up);
    const page = `<a class="btn ${c.update && !up.inApp ? 'primary' : 'ghost'} sm" href="${esc(up.page)}" target="_blank" rel="noopener">${c.update && !up.inApp ? 'Update' : 'Install page'}</a>`;
    const btns = c.busy ? ''
      : c.allow ? `<button class="btn primary sm" data-update-allow>Allow</button><button class="btn ghost sm" data-update-later>Later</button>`
        : c.update ? `${up.inApp ? '<button class="btn primary sm" data-update-install>Update</button>' : page}<button class="btn ghost sm" data-update-later>Later</button>`
          : c.retry ? `<button class="btn primary sm" data-update-install>Try again</button>${page}` : c.page ? page : '';
    const bar = c.busy ? `<span class="update-bar" role="progressbar" aria-valuenow="${Math.round((app.update.progress || 0) * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.round((app.update.progress || 0) * 100)}%"></i></span>` : '';
    return `<div class="hint update-hint"><b>MASKED ${esc(up.version)} is out</b><span>${esc(c.note)}</span>${bar}${btns ? `<span class="lang-btns">${btns}</span>` : ''}</div>`;
  }

  render() {
    const { app, account, unit } = this;
    const w = account.keys;
    if (!w) return `<section class="card center"><p>No wallet yet.</p><button class="btn primary" data-go="settings">Set up wallet</button></section>`;
    const coins = app.coins, fees = app.fees, sync = app.sync;
    const pub = sumSats(coins.public), sh = sumSats(coins.shielded);
    const total = pub + sh;
    const side = app.side.get(), shd = side === 'shielded', mine = shd ? sh : pub;
    const hint = !total
      ? `<div class="hint"><b>Get started</b><span>Tap <b>Receive</b> and send ${unit} to your Public address.</span></div>`
      : pub > INSCRIPTION_MAX && !sh
        ? `<button class="hint hint-cta" data-go="shield"><span class="hint-ic">${I.shield}</span><span><b>Make it private</b><span>Move your Public balance into Shielded.</span></span><span class="chev">›</span></button>`
        : '';
    const protectedCount = coins.publicThenShielded().filter((c) => !c.example && coins.isProtected(c)).length;
    const protectedRow = protectedCount
      ? `<button class="protect-row" data-go="activity" data-filter="all">${I.lock}<span><b>${protectedCount} coin${protectedCount === 1 ? '' : 's'} protected</b> · inscriptions or small coins, never spent by Send, Shield or Mint. Tap to see or unlock</span><span class="chev">›</span></button>`
      : '';
    // coins still waiting for a block, on the side on show: right on Home, not only in Settings
    const waiting = (shd ? coins.shielded : coins.public).filter((c) => c.pending && !c.example);
    const pendingRow = waiting.length
      ? `<button class="protect-row pending-row" data-go="activity" data-filter="all"><span class="pend-dot" aria-hidden="true"></span><span><b>${fmtBtc(sumSats(waiting))} ${unit} pending</b> · ${waiting.length} coin${waiting.length === 1 ? '' : 's'} waiting for a block</span><span class="chev">›</span></button>`
      : '';
    const usd = (s) => fees.usdOf(s);
    const leafRow = LeafView.homeRow(app, side);
    // the phone app: a newer version is out (it isn't on Google Play, so this is how people hear of it)
    const up = app.update?.available();
    const updateRow = up ? HomeView.updateCard(app, up) : '';
    return `
    ${HomeView.langHint()}
    ${updateRow}
    ${w.source === 'example' ? '<div class="testnet-note warn">Demo wallet — keys are public. Create your own in Settings.</div>' : this.netBanner()}
    <section class="hero ${shd ? 'sh' : ''}">
      <p class="hero-label">${shd ? `${I.shieldPlain} Shielded balance` : 'Public balance'}</p>
      <p class="hero-bal">${fmtBtc(mine)} <small>${unit}</small></p>
      <p class="hero-usd">${usd(mine) ? `≈ ${usd(mine)} · ` : ''}Total ${fmtBtc(total)} ${unit}</p>
      <button class="sync ${sync.syncing ? 'spin' : ''} ${sync.error ? 'bad' : ''}" id="btnSync" title="${esc(sync.error || '')}">${I.refresh}<span>${sync.text()}</span></button>
      <div class="actions">
        <button class="act" data-go="receive" data-recv="${side}"><span class="act-ic ${shd ? 'sh' : ''}">${I.recv}</span><span>Receive</span></button>
        <button class="act" data-go="send"><span class="act-ic ${shd ? 'sh' : ''}">${I.send}</span><span>Send</span></button>
        ${shd ? `<a class="act" href="https://maskedwallet.com/swap?from=shielded" target="_blank" rel="noopener"><span class="act-ic sh">${I.list}</span><span>Trade</span></a>`
          : `<button class="act" data-go="shield"><span class="act-ic sh">${I.shield}</span><span>Shield</span></button>`}
        <button class="act" data-go="mint"><span class="act-ic">${I.mint}</span><span>Mint</span></button>
      </div>
    </section>
    ${hint}
    ${pendingRow}
    ${protectedRow}
    <section class="balances" role="radiogroup" aria-label="Show">
      <button class="bal-row ${shd ? '' : 'on'}" data-side="public" role="radio" aria-checked="${!shd}">
        ${btcLogo}
        <span class="bal-txt"><b>Public</b><span>Visible on the blockchain</span></span>
        <span class="bal-amt"><b>${fmtBtc(pub)}</b><span>${usd(pub) || unit}</span></span>
      </button>
      <button class="bal-row shielded ${shd ? 'on' : ''}" data-side="shielded" role="radio" aria-checked="${shd}">
        ${shieldLogo}
        <span class="bal-txt"><b>Shielded</b><span>Private · only you see it</span></span>
        <span class="bal-amt"><b>${fmtBtc(sh)}</b><span>${usd(sh) || unit}</span></span>
      </button>
    </section>
    ${account.isTest ? '' : `<section class="ec-home">${EcashView.homeRow(app)}</section>`}
    ${w.source === 'example' ? '' : `<section class="ec-home">${OrdinalsView.homeRow(app)}</section>`}
    ${app.ui.tokens.home(side, leafRow)}
    ${RgbHome.render(app)}`;
  }
}
