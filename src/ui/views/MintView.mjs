import { ago, esc, fmtBtc, short } from '../../core/format.mjs';
import { PREDEPLOY_DELAY, isV2, tickLen } from '../../ordinals/brc20.mjs';
import { TRANSFER_POSTAGE } from '../../ordinals/envelope.mjs';
import { View } from '../View.mjs';
import { I, btcLogo, head, headWith, rowKV, seg, shieldLogo, sideLogo, tokBadge, copyBtn } from '../html.mjs';
import { TokenSendView, TransferView } from './TokenSendView.mjs';

const OP_TITLE = { mint: 'Mint', predeploy: 'Reserve ticker', deploy: 'Deploy BRC2.0', tsend: 'Send', transfer: 'Inscribe transfer' };
const T = (tick) => esc(String(tick || '').toUpperCase());

/** The Mint tab (Mint | Deploy BRC2.0), and the token pages' Send and Inscribe flows, which share its review and done screens. */
export class MintView extends View {
  /** @param {import('../../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    super(app);
    this.tokenSend = new TokenSendView(app);
    this.transfer = new TransferView(app);
  }

  get book() { return this.app.tokens; }
  get deploys() { return this.app.deploys; }

  render() {
    const m = this.state.mint;
    if (m.stage === 'done' && m.built) return this.doneScreen(m.built);
    if (m.stage === 'review' && m.built) return m.built.op === 'tsend' ? this.tokenSendReview(m.built) : this.review(m.built);
    const mode = this.f.mintMode;
    if (mode === 'send') return `${headWith(`data-tok="${esc(this.f.tsTick || '')}"`, `Send ${T(this.f.tsTick)}`)}${this.tokenSend.render()}`;
    if (mode === 'transfer') return `${headWith(`data-tok="${esc(this.f.trTick || '')}"`, `Inscribe ${T(this.f.trTick)}`)}${this.transfer.render()}`;
    const top = `${head('Mint & deploy')}${seg('mintMode', mode, [['mint', 'Mint'], ['deploy', 'Deploy BRC2.0']])}`;
    return mode === 'deploy' ? top + this.deployTab() : top + this.mintTab();
  }

  doneScreen(b) {
    if (b.op === 'predeploy') return this.done('Ticker reserved', `${T(b.tick)} is reserved. Come back after ${PREDEPLOY_DELAY} blocks to deploy it.`, b.revealTxid, 'Progress shows on the Deploy tab.');
    if (b.op === 'transfer') return this.done('Transfer inscribed', `${esc(Number(b.amt).toLocaleString())} ${T(b.tick)} is ready to list on a marketplace or send.`, b.revealTxid, 'Marketplaces show it once it confirms.');
    if (b.op === 'tsend') return this.done('Tokens sent', `${esc(Number(b.amt).toLocaleString())} ${T(b.tick)} is on its way${b.toKind === 'shielded' ? ' to a shielded address' : ''}.`, b.sendTxid, 'Indexers update the balance once it confirms.');
    if (b.op === 'deploy') return this.done(`${T(b.tick)} deployed`, 'Your BRC2.0 token exists. You can mint it now.', b.revealTxid, 'Indexers can take a few blocks to list it.');
    return this.done('Mint submitted', `${esc(b.amt)} ${T(b.tick)}${b.toSelf ? ' will land in your Shielded balance.' : ' is on its way.'}`, b.revealTxid, 'Indexers can take a few blocks to show balances.');
  }

  // ---- Mint ----
  mintTab() {
    const f = this.f, book = this.book, codec = this.account.codec;
    const cur = f.mintTick.trim().toLowerCase();
    const v2 = isV2(cur);
    const toks = book.known();
    const pend = this.deploys.list().filter((d) => d.status !== 'deployed');
    const orphans = this.deploys.orphans().length;
    const unfinished = pend.length || orphans
      ? `<button class="hint hint-cta" data-set="mintMode" data-val="deploy"><span class="hint-ic">${I.mint}</span><span><b>${pend.length ? pend.map((d) => T(d.tick)).join(', ') + ' is not deployed yet' : 'You have an unfinished reservation'}</b><span>Finish it on the Deploy BRC2.0 tab, then mint here.</span></span><span class="chev">›</span></button>`
      : '';
    const blocked = book.mintBlock(cur);
    const other = codec.kind(f.mintOther);
    const tickBadge = v2 ? '<span class="badge v2">BRC2.0</span>' : tickLen(f.mintTick.trim()) === 4 ? '<span class="badge">BRC-20</span>' : '';
    return `
    ${v2 ? this.brc2NetNote() : this.netBanner()}
    ${unfinished}
    ${toks.length ? `<div class="chips">${toks.map((t) => `<button class="chip ${t.tick === cur ? 'on' : ''}" data-pick="${esc(t.tick)}"><b>${T(t.tick)}</b><span>${t.mints ? `${t.minted.toLocaleString()} minted` : t.deployed ? 'deployed' : 'in wallet'}</span></button>`).join('')}</div>` : ''}
    <section class="card form">
      <div class="row2">
        <label class="field"><span class="lbl">Ticker <span class="lbl-r">${tickBadge}</span></span><input data-bind="mintTick" value="${esc(f.mintTick)}" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ticker"></label>
        <label class="field"><span class="lbl">Amount</span><input data-bind="mintAmt" inputmode="decimal" value="${esc(f.mintAmt)}" autocomplete="off"></label>
      </div>
      ${this.supplyLine(cur)}
      ${blocked ? `<p class="info warn">${esc(blocked)}</p>` : ''}
      <div class="field"><span class="lbl">Receive to</span>${seg('mintTo', f.mintTo, [['self', `${I.shieldPlain} My Shielded`], ['other', 'Other address']])}
        ${f.mintTo === 'other' ? `<input data-bind="mintOther" class="mono" spellcheck="false" autocomplete="off" value="${esc(f.mintOther)}" placeholder="Bitcoin or shielded address"><span class="addr-kind k-${other.kind}" id="mintKind">${esc(other.text || '')}</span>` : '<span class="addr-kind k-shielded">Private — nobody can link the mint to you</span>'}
      </div>
      <div class="field"><span class="lbl">Pay from</span>${this.fromSeg('mintFrom')}</div>
      <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
      ${this.statusLine('mint')}
      <button class="btn primary wide" id="btnReviewMint" ${blocked ? 'disabled' : ''}>${blocked && book.tickerInfo(cur)?.data?.soldOut ? 'Sold out' : 'Review mint'}</button>
    </section>
    ${this.mintHistory()}`;
  }

  supplyLine(tick) {
    tick = String(tick || '').trim().toLowerCase();
    const own = this.deploys.list().find((d) => d.tick === tick && d.status === 'deployed');
    const e = this.book.tickerInfo(tick), d = e?.data;
    if (own?.selfMint) { const m = this.book.mintedSoFar(tick), max = Number(own.max) || 0; return MintView.supplyBar(m, max, max && m >= max); }
    if (!d) return e?.busy ? '<p class="supply muted small">Checking supply…</p>' : '';
    if (d.unknown) return ''; // the warning below says it
    return MintView.supplyBar(Number(d.minted), Number(d.max), d.soldOut, d.holders);
  }

  static supplyBar(minted, max, soldOut, holders) {
    const pct = max ? Math.min(100, (minted / max) * 100) : 0;
    const label = soldOut ? 'Sold out' : `${pct < 0.01 && pct > 0 ? '<0.01' : pct.toFixed(pct < 10 ? 2 : 1)}% minted`;
    return `<div class="supply ${soldOut ? 'out' : ''}"><div class="supply-bar"><i style="width:${pct.toFixed(2)}%"></i></div>
    <p class="small"><b>${label}</b><span class="muted"> · ${minted.toLocaleString()} / ${max.toLocaleString()}${holders ? ` · ${Number(holders).toLocaleString()} holders` : ''}</span></p></div>`;
  }

  mintHistory() {
    const list = this.app.mints.list();
    if (!list.length) return '';
    const all = this.app.coins.shieldedThenPublic(), explorer = this.account.explorer;
    return `<section class="card list">
    <div class="list-h"><b>Minted</b><span class="muted small">${list.length} mint${list.length === 1 ? '' : 's'}</span></div>
    ${list.map((m) => {
      const held = all.find((c) => c.txid === m.revealTxid && c.vout === m.revealOut);
      const where = m.to === 'shielded' ? shieldLogo : m.to === 'public' ? btcLogo : `<span class="coin ext">${I.send}</span>`;
      const status = m.height ? `Confirmed · block ${m.height.toLocaleString()}` : 'Pending';
      return `<div class="coin-row">${where}
        <span class="bal-txt"><b>${T(m.tick)} ${tokBadge(m.tick)}</b><span>${status} · ${ago(m.at)}${held ? ` · <span class="good">${I.lock} safe</span>` : m.to === 'other' ? ' · sent out' : ''}</span></span>
        <span class="bal-amt"><b>${esc(Number(m.amt).toLocaleString())}</b><span class="row-links"><a href="${explorer.inscription(m.inscriptionId)}" target="_blank" rel="noopener">Inscription</a><a href="${explorer.tx(m.revealTxid)}" target="_blank" rel="noopener">Tx</a></span></span>
      </div>`;
    }).join('')}
  </section>`;
  }

  // ---- Deploy BRC2.0 ----
  /** Who can mint + max supply (+ per mint), shared by the new-token and recover forms. */
  supplyFields() {
    const f = this.f, self = f.depWho === 'self';
    return `<div class="${self ? '' : 'row2'}">
          <label class="field"><span class="lbl">Max supply</span><input data-bind="depMax" inputmode="decimal" value="${esc(f.depMax)}" autocomplete="off"></label>
          ${self ? '' : `<label class="field"><span class="lbl">Per mint</span><input data-bind="depLim" inputmode="decimal" value="${esc(f.depLim)}" autocomplete="off"></label>`}
        </div>`;
  }

  deployTab() {
    const f = this.f;
    const list = this.deploys.list();
    const tickOk = /^[a-z0-9-]{0,6}$/i.test(f.depTick);
    const whoSeg = seg('depWho', f.depWho, [['self', `${I.lock} Only me`], ['open', 'Anyone']]);
    const orphans = this.deploys.orphans().map((c) => `<section class="card form orphan">
        <p class="card-title">Finish this reservation</p>
        <p class="info">Found a ticker reservation (<span class="mono">${short(c.txid, 6)}:${c.vout}</span>) with no saved details in this browser. Enter its ticker and supply to continue.</p>
        <label class="field"><span class="lbl">Ticker</span><input data-bind="recTick" value="${esc(f.recTick)}" maxlength="6" autocomplete="off" spellcheck="false" placeholder="the 6-letter ticker you reserved"></label>
        <div class="field"><span class="lbl">Who can mint</span>${whoSeg}</div>
        ${this.supplyFields()}
        <details class="adv"><summary>I have the salt</summary><input data-bind="recSalt" class="mono" value="${esc(f.recSalt)}" placeholder="32 hex characters" spellcheck="false"></details>
        ${this.statusLine('recover')}
        <button class="btn primary wide" data-recover="${c.txid}:${c.vout}">Recover reservation</button>
      </section>`).join('');
    return `
      ${this.brc2NetNote()}
      ${orphans}
      ${list.length ? `<section class="deps">${list.map((d) => this.deployCard(d)).join('')}</section>` : ''}
      <section class="card form">
        <p class="card-title">New BRC2.0 token</p>
        <label class="field"><span class="lbl">Ticker <span class="lbl-r">${tickLen(f.depTick || '')}/6</span></span><input data-bind="depTick" value="${esc(f.depTick)}" maxlength="6" autocomplete="off" spellcheck="false" placeholder="e.g. masked" class="${tickOk ? '' : 'bad'}"></label>
        <div class="field"><span class="lbl">Who can mint</span>${whoSeg}
          <span class="addr-kind ${f.depWho === 'self' ? 'k-shielded' : 'k-public'}">${f.depWho === 'self' ? 'Self-mint · you mint the whole supply and hand it out yourself' : 'Open mint · anyone can mint up to the per-mint limit'}</span></div>
        ${this.supplyFields()}
        <div class="field"><span class="lbl">Reservation goes to</span>${seg('depResTo', f.depResTo, [['shielded', `${I.shieldPlain} Shielded`], ['public', 'Public']])}
          <span class="addr-kind ${f.depResTo === 'shielded' ? 'k-shielded' : 'k-public'}">${f.depResTo === 'shielded' ? 'Fully private · needs 2 coins (one pays, one anchors)' : 'Simplest · reservation is visible on your Public address'}</span></div>
        <div class="field"><span class="lbl">Pay from</span>${this.fromSeg('depFrom')}</div>
        <div class="field"><span class="lbl">Network fee</span>${this.feeChips()}</div>
        <p class="info">Two steps: <b>reserve</b> the ticker (kept secret), wait ${PREDEPLOY_DELAY} blocks, then <b>deploy</b>. Your token's deploy lands in your Shielded address.</p>
        ${this.statusLine('mint')}
        <button class="btn primary wide" id="btnReviewPredeploy">Step 1 · Reserve ticker</button>
      </section>`;
  }

  deployCard(d) {
    const st = this.deploys.stage(d, this.app.sync.tip);
    const explorer = this.account.explorer;
    const left = Number(d.max) - this.book.mintedSoFar(d.tick);
    const deployed = st.key === 'deployed';
    const full = d.selfMint && deployed && left <= 0;
    const selfMintAction = deployed && d.selfMint
      ? (left > 0 ? `<button class="btn primary wide" data-mintall="${esc(d.tick)}">Mint all ${left.toLocaleString()} ${T(d.tick)}</button>` : `<p class="good small">${I.check} Full supply minted — ${Number(d.max).toLocaleString()} ${T(d.tick)} in your wallet</p>`)
      : '';
    return `<div class="dep ${st.key}">
    <div class="dep-h"><span class="tok">${T(d.tick)}</span><span class="badge v2">BRC2.0</span><span class="head-sp"></span>
      ${deployed ? `<span class="good small">${I.check}</span>` : ''}</div>
    <div class="steps2">
      <span class="s2 done">1 · Reserved</span><span class="s2 ${deployed ? 'done' : st.key === 'ready' ? 'on' : ''}">2 · Deploy</span><span class="s2 ${full ? 'done' : deployed ? 'on' : ''}">3 · Mint</span>
    </div>
    <p class="small muted">${st.text} · max ${esc(Number(d.max).toLocaleString())}${d.selfMint ? ` · <span class="good">${I.lock} only you can mint</span>` : ` · ${esc(d.lim)} per mint`}</p>
    ${st.key === 'ready' ? `<button class="btn primary wide" data-deploy="${esc(d.tick)}">Deploy ${T(d.tick)}</button>` : ''}
    ${selfMintAction}
    ${deployed ? `<div class="row">${full ? '' : `<button class="btn ${d.selfMint ? 'ghost' : 'primary'} sm" data-mintof="${esc(d.tick)}">Mint ${T(d.tick)}</button>`}<a class="btn ghost sm" href="${explorer.tx(d.deployTxid)}" target="_blank" rel="noopener">View ${I.ext}</a></div>` : ''}
    ${st.key === 'wait' ? `<a class="small link" href="${explorer.tx(d.predeployTxid)}" target="_blank" rel="noopener">View reservation</a>` : ''}
  </div>`;
  }

  // ---- reviews ----
  review(b) {
    const { unit } = this;
    const busy = this.state.busy;
    const top = b.op === 'transfer'
      ? `<p class="hero-label">Inscribe transfer</p><p class="hero-bal">${esc(Number(b.amt).toLocaleString())} <small>${T(b.tick)}</small></p>`
      : b.op === 'mint'
        ? `<p class="hero-label">Minting ${isV2(b.tick) ? 'BRC2.0' : 'BRC-20'}</p><p class="hero-bal">${esc(Number(b.amt).toLocaleString())} <small>${T(b.tick)}</small></p>`
        : `<p class="hero-label">${b.op === 'predeploy' ? 'Step 1 · Reserve ticker' : 'Step 2 · Deploy'}</p><p class="hero-bal">${T(b.tick)}</p>`;
    const selfMint = b.selfMint || this.deploys.find(b.tick)?.selfMint;
    const supplyRows = b.op !== 'mint' && b.op !== 'transfer' ? rowKV('Max supply', esc(Number(b.max).toLocaleString())) + (selfMint ? rowKV('Who can mint', `${I.lock} Only you`) : rowKV('Per mint', esc(b.lim))) : '';
    const to = b.toSelf ? `${shieldLogo}<b>My Shielded</b>` : b.recipient === this.account.pubAddr() ? `${btcLogo}<b>My Public</b>` : `<span class="mono">${esc(short(b.recipient, 10))}</span>`;
    return `
    ${headWith('data-mintback', 'Confirm')}
    <section class="card review">
      ${top}
      <div class="kv">
        ${supplyRows}
        ${b.op === 'mint' && b.selfMint ? rowKV('Authorised by', `${I.lock} your deploy inscription`) : ''}
        ${rowKV('Pay from', sideLogo(b.from))}
        ${rowKV(b.op === 'predeploy' ? 'Reservation to' : 'Receive to', to)}
        ${rowKV('Network fee', `${fmtBtc(b.estimate.totalFee)} ${unit}`)}
        ${rowKV('Inscription', `${fmtBtc(b.estimate.revealValue)} ${unit}`)}
        ${rowKV('Total', `<b>${fmtBtc(b.estimate.totalFee + b.estimate.revealValue)} ${unit}</b>`)}
      </div>
      ${b.op === 'predeploy' ? `<p class="info">Your ticker stays secret until step 2. After this confirms, wait ${PREDEPLOY_DELAY} blocks, then deploy.</p>` : ''}
      ${this.statusLine('mint')}
      <button class="btn primary wide" id="btnConfirmMint" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : `Confirm · ${OP_TITLE[b.op]}`}</button>
      <details class="adv"><summary>Transaction details</summary>
        <p class="mono small wrapall">${esc(b.body)}</p>
        <div class="kv small">${rowKV('Commit', `<span class="mono">${short(b.commitTxid, 8)}</span>`)}${rowKV('Reveal', `<span class="mono">${short(b.revealTxid, 8)}</span>`)}</div>
        <div class="row">${copyBtn(b.commitHex, 'Commit hex')}${copyBtn(b.revealHex, 'Reveal hex')}</div>
      </details>
    </section>`;
  }

  tokenSendReview(b) {
    const { unit } = this;
    const busy = this.state.busy;
    return `
    ${headWith('data-mintback', 'Confirm')}
    <section class="card review">
      <p class="hero-label">Sending ${isV2(b.tick) ? 'BRC2.0' : 'BRC-20'}</p>
      <p class="hero-bal">${esc(Number(b.amt).toLocaleString())} <small>${T(b.tick)}</small></p>
      <div class="kv">
        ${rowKV('To', b.toOwn ? `${shieldLogo}<b>My wallet</b>` : `<span class="mono">${esc(short(b.to, 10))}</span>`)}
        ${rowKV('Privacy', b.toKind === 'shielded' ? '<span class="good">Shielded: lands on a one-time address</span>' : '<span class="meh">Public address</span>')}
        ${rowKV('Tokens from', sideLogo(b.fromKind))}
        ${rowKV('Fees paid from', sideLogo(b.from))}
        ${rowKV('Network fee', `${fmtBtc(b.sendTotalFee)} ${unit}`)}
        ${rowKV('Delivered with', `${fmtBtc(TRANSFER_POSTAGE)} ${unit}`)}
        ${rowKV('Total', `<b>${fmtBtc(b.sendTotalFee + TRANSFER_POSTAGE)} ${unit}</b>`)}
      </div>
      <p class="info">3 transactions: inscribe the transfer on the address holding your ${T(b.tick)}, then deliver it. Your mint coin is not touched.</p>
      ${this.statusLine('mint')}
      <button class="btn primary wide" id="btnConfirmMint" ${busy ? 'disabled' : ''}>${busy ? 'Sending…' : 'Confirm · Send'}</button>
      <details class="adv"><summary>Transaction details</summary>
        <p class="mono small wrapall">${esc(b.body)}</p>
        <div class="kv small">${rowKV('Commit', `<span class="mono">${short(b.commitTxid, 8)}</span>`)}${rowKV('Inscribe', `<span class="mono">${short(b.revealTxid, 8)}</span>`)}${rowKV('Deliver', `<span class="mono">${short(b.sendTxid, 8)}</span>`)}</div>
      </details>
    </section>`;
  }
}
