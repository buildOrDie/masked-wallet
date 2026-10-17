import { RgbPanel } from '../RgbPanel.mjs';
import { esc, fmtBtc, sumSats } from '../../core/format.mjs';
import { INSCRIPTION_MAX } from '../../ordinals/envelope.mjs';
import { View } from '../View.mjs';
import { I, btcLogo, shieldLogo } from '../html.mjs';

/** Home: the balance of the side on show (Public or Shielded), actions, both balances and the tokens. */
export class HomeView extends View {
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
      ? `<button class="protect-row" data-go="activity" data-filter="brc2">${I.lock}<span><b>${protectedCount} inscription coin${protectedCount === 1 ? '' : 's'} protected</b> · never spent by Send, Shield or Mint</span><span class="chev">›</span></button>`
      : '';
    const usd = (s) => fees.usdOf(s);
    return `
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
    ${RgbPanel.home(app)}
    ${app.ui.tokens.home(side)}`;
  }
}
