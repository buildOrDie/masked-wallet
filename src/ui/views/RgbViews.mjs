// RGB on the wallet's own screens: a Tokens section on Home, a token page, Send, the RGB tab of Receive,
// "RGB token" on the Mint tab, and the advanced bits in Settings. Same parts as BRC-20: tok-line rows, the token
// page layout, the review card and the done screen.
import { dayLabel, esc, fmtBtc, short } from '../../core/format.mjs';
import { RGB_PROFILES } from '../../rgb/config.mjs';
import { RGB_BLIND_MIN, RGB_EXPIRY, RGB_FUND_BTC, RGB_LOW_BTC } from '../../rgb/WalletRgb.mjs';
import { View } from '../View.mjs';
import { I, addrChunks, btcLogo, head, qrSvg, rowKV, tokIcon } from '../html.mjs';

export const rgbBadge = '<span class="badge rgb">RGB</span>';
const rgbIcon = (ticker, big = false) => tokIcon(ticker || 'RG', big).replace('class="tok-ic', 'class="tok-ic rgb');
const input = (r, key, label, extra = '', right = '') => `<label class="field"><span class="lbl">${label}${right ? ` <span class="lbl-r">${right}</span>` : ''}</span><input data-rgb-field="${key}" value="${esc(r.fields[key])}" autocomplete="off" spellcheck="false" ${extra}></label>`;
const msg = (r) => (r.message ? `<p class="msg" role="status">${esc(r.message)}</p>` : '');

/** Status words for a transfer, from the person's side. */
const STATUS = { WaitingCounterparty: 'Waiting for the other wallet', WaitingConfirmations: 'Waiting for a block', Settled: '', Failed: 'Failed' };
const fungible = (x) => Number(x?.Fungible ?? x?.amount ?? 0);
/** One transfer as { label, sign, amount, note, txid }; open invoices that never got paid are left out. */
export function historyRow(t, a, r) {
  const kind = String(t.kind || '');
  const got = (t.assignments || []).reduce((s, x) => s + fungible(x), 0);
  if (kind === 'Issuance') return { label: 'Created', sign: '+', amount: r.amount(a, got), note: STATUS[t.status] ?? '', txid: t.txid };
  if (kind.startsWith('Receive')) {
    if (t.status === 'WaitingCounterparty' && !got) return null; // an invoice nobody has paid yet
    return { label: 'Received', sign: '+', amount: got ? r.amount(a, got) : '…', note: STATUS[t.status] ?? '', txid: t.txid };
  }
  if (kind === 'Send') return { label: 'Sent', sign: '−', amount: r.amount(a, fungible(t.requestedAssignment)), note: STATUS[t.status] ?? '', txid: t.txid };
  return { label: kind || 'Transfer', sign: '', amount: got ? r.amount(a, got) : '', note: STATUS[t.status] ?? '', txid: t.txid };
}

export class RgbHome {
  /** The RGB section of Home (Signet only). */
  static render(app) {
    const r = app.rgb;
    if (r.offerable && r.betaAsk) {
      return `<section class="card rgb-ask">
        <h2>RGB tokens on mainnet (beta)</h2>
        <ul class="ask-list">
          <li>RGB tokens can only be restored from an <b>RGB backup file</b>, not from your recovery phrase alone.</li>
          <li>MASKED asks you to save a backup before every receive, send and new token.</li>
          <li>RGB has keys of its own: its coins never mix with your Public or Shielded BTC.</li>
          <li>It's a beta: keep amounts small.</li>
        </ul>
        <label class="risk"><input type="checkbox" data-rgb="betaTick" ${r.betaOk ? 'checked' : ''}><span>I understand I must keep my RGB backup safe.</span></label>
        <button class="btn primary wide" data-rgb="betaYes" ${r.betaOk && !r.busy ? '' : 'disabled'}>Turn on RGB beta</button>
        <button class="btn ghost wide" data-rgb="betaNo">Not now</button>
      </section>`;
    }
    if (r.offerable) return `<button class="hint hint-cta" data-rgb="beta"><span class="hint-ic">${I.mint}</span><span><b>RGB tokens (beta)</b><span>Hold and send RGB tokens on Bitcoin mainnet. Beta: keep amounts small.</span></span><span class="chev">›</span></button>`;
    if (!r.available) return '';
    r.ensure();
    if (r.phase === 'legacy') return `<section class="card form"><div class="list-h"><b>RGB tokens</b>${rgbBadge}</div>
      <p class="muted small">This RGB test wallet was made by an earlier test build with its own password. Enter it once; after that RGB opens with your wallet.</p>
      <label class="field"><span class="lbl">Earlier RGB password</span><input id="rgbOldPw" type="password" autocomplete="off"></label>
      <button class="btn primary wide" data-rgb="migrate" ${r.busy ? 'disabled' : ''}>Open RGB</button>${msg(r)}</section>`;
    if (!r.ready && !r.exists) return `<button class="hint hint-cta" data-rgb="on" ${r.busy ? 'disabled' : ''}><span class="hint-ic">${I.mint}</span><span><b>${r.busy ? 'Turning on RGB…' : r.isMain ? 'Turn on RGB (beta)' : 'Try RGB tokens'}</b><span>${r.isMain ? 'Hold and send RGB tokens on Bitcoin mainnet.' : 'Create and send private test tokens on Signet.'}</span></span><span class="chev">›</span></button>`;
    if (!r.ready) {
      return `<section class="home-toks"><div class="list-h"><b>RGB tokens</b><span class="muted small">${r.phase === 'error' ? '' : 'opening…'}</span></div>
      ${r.phase === 'error' ? `${msg(r)}<button class="btn ghost wide" data-rgb="retry">Try again</button>` : ''}</section>`;
    }
    if (!r.data) {
      return `<section class="home-toks"><div class="list-h"><b>RGB tokens</b><span class="muted small">${r.busy ? 'checking…' : ''}</span></div>
      ${r.busy ? '<p class="muted small center">Checking RGB balances… the first time takes up to a minute.</p>' : `${msg(r)}<button class="btn ghost wide" data-rgb="refresh">Try again</button>`}</section>`;
    }
    const list = r.assets();
    const { settled, pending } = r.btc();
    const t = r.isMain ? '' : 'test ';
    const backupDue = r.isMain && r.service?.backupRequired
      ? `<button class="hint hint-cta" data-rgb="backup" ${r.busy ? 'disabled' : ''}><span class="hint-ic">${I.check}</span><span><b>Save your RGB backup</b><span>Needed before your next receive or send. Your recovery phrase alone can't bring RGB tokens back.</span></span><span class="chev">›</span></button>`
      : '';
    const fund = settled + pending < RGB_LOW_BTC
      ? `<button class="hint hint-cta" data-rgb="fund"><span class="hint-ic">${I.recv}</span><span><b>Add ${t}BTC for RGB</b><span>RGB pays its own network fees. Send ${RGB_FUND_BTC} from your Public balance.</span></span><span class="chev">›</span></button>`
      : '';
    // RGB's own test BTC (it pays RGB's network fees), with its address: tap to copy
    const addr = r.data.address || '';
    const feeRow = `<button class="tok-line" data-copy="${esc(addr)}" title="Copy RGB address">${btcLogo}
        <span class="bal-txt"><b class="tk">${r.isMain ? 'BTC for RGB fees' : 'Test BTC for fees'}</b><span class="mono">${esc(short(addr, 6))} ${I.copy}</span></span>
        <span class="bal-amt"><b>${fmtBtc(settled)}</b><span>${pending ? `<span class="pend-t">+${fmtBtc(pending)} waiting for a block</span>` : r.isMain ? 'BTC' : 'tBTC'}</span></span></button>`;
    return `<section class="home-toks">
      <div class="list-h"><b>RGB tokens${r.isMain ? ' <span class="badge">beta</span>' : ''}</b><button class="link small" data-rgb="refresh" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Updating…' : 'Refresh'}</button></div>
      ${backupDue}${fund}
      <div class="tok-list">${feeRow}${list.map((a) => {
        const s = Number(a.balance?.settled || 0), fut = Number(a.balance?.future || 0);
        return `<button class="tok-line" data-rgb="token" data-rgb-arg="${esc(a.assetId)}">${rgbIcon(a.ticker)}
        <span class="bal-txt"><b class="tk">${esc(a.ticker)}</b><span>RGB${fut > s ? ' · <span class="pend-t">incoming</span>' : ''}</span></span>
        <span class="bal-amt"><b>${r.amount(a, s)}</b><span>${esc(a.name)}</span></span><span class="chev">›</span></button>`;
      }).join('') || (r.isMain ? `<p class="muted small center">No RGB tokens yet.</p><button class="btn ghost wide" data-rgb="receive">${I.recv}<span>Receive an RGB token</span></button>` : `<p class="muted small center">No RGB tokens yet.</p><button class="btn ghost wide" data-rgb="mint">${I.mint}<span>Create an RGB token</span></button>`)}</div>
    </section>`;
  }
}

/** A token page for one RGB asset, like the BRC-20 one. */
export class RgbTokenView extends View {
  render() {
    const r = this.app.rgb, a = r.find(r.asset);
    if (!r.ready || !a) { this.state.view = 'home'; return this.app.ui.view('home').render(); }
    const s = Number(a.balance?.settled || 0), fut = Number(a.balance?.future || 0), sp = Number(a.balance?.spendable || 0);
    const tab = this.f.rgbTab || 'history';
    return `
    <div class="tok-page">
      <div class="view-head"><button class="icon-btn" data-go="home" aria-label="Back">${I.back}</button><span class="head-sp"></span></div>
      <div class="tok-hero">${rgbIcon(a.ticker, true)}<p class="tok-name">${esc(a.ticker)} ${rgbBadge}</p><p class="tok-big">${r.amount(a, s)}</p>
        ${fut > s ? `<p class="pend-t small">+${r.amount(a, fut - s)} incoming · waiting for a block</p>` : ''}</div>
      <section class="card tok-box">
        <div class="d-row"><span>Available to send</span><b>${r.amount(a, sp)}</b></div>
        <div class="tok-acts">
          <button class="tact" data-rgb="send" data-rgb-arg="${esc(a.assetId)}" ${sp ? '' : 'disabled'}>${I.send}<span>Send</span></button>
          <button class="tact" data-rgb="receive" data-rgb-arg="${esc(a.assetId)}">${I.recv}<span>Receive</span></button>
        </div>
      </section>
      <div class="tabs">${[['history', 'History'], ['details', 'Details']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-set="rgbTab" data-val="${k}">${l}</button>`).join('')}</div>
      ${tab === 'history' ? `<section class="hist">${this.history(a)}</section>` : this.details(a)}
    </div>`;
  }

  history(a) {
    const r = this.app.rgb, explorer = this.account.explorer, onChain = r.profile.id === 'public' || r.isMain;
    const rows = r.history(a.assetId).map((t) => ({ t, h: historyRow(t, a, r) })).filter((x) => x.h);
    if (!rows.length) return '<p class="muted small center">No activity yet.</p>';
    let day = '';
    return rows.map(({ t, h }) => {
      const label = h.note ? 'Pending' : dayLabel((t.updatedAt || t.createdAt || 0) * 1000);
      const sep = label !== day ? `<p class="h-day">${esc(label)}</p>` : '';
      day = label;
      const cls = h.sign === '−' ? 'out' : 'in';
      const inner = `<span class="h-ic ${cls}">${h.sign === '−' ? I.send : h.label === 'Created' ? I.mint : I.recv}</span>
        <span class="bal-txt"><b>${h.label}</b><span>${esc(h.note || 'Confirmed')}</span></span><span class="h-amt ${cls}">${h.sign}${h.amount}</span>`;
      return sep + (h.txid && onChain ? `<a class="h-row" href="${explorer.tx(h.txid)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="h-row">${inner}</div>`);
    }).join('');
  }

  details(a) {
    const r = this.app.rgb;
    return `<section class="card"><div class="kv">
      ${rowKV('Name', esc(a.name))}
      ${rowKV('Ticker', esc(a.ticker))}
      ${rowKV('Supply', r.amount(a, a.issuedSupply))}
      ${rowKV('Decimals', String(a.precision))}
      ${rowKV('Network', r.isMain ? 'Bitcoin mainnet · beta' : `${esc(r.profile.label)} · test`)}
      ${rowKV('Asset ID', `<span class="mono small">${esc(short(a.assetId, 10))}</span>`)}
    </div><button class="btn ghost wide" data-copy="${esc(a.assetId)}">${I.copy}<span>Copy asset ID</span></button>
    <p class="info">RGB balances are not on the blockchain. Only you and the people you trade with see them.</p></section>`;
  }
}

/** Send an RGB token: to an invoice, an amount in token units, review, done. */
export class RgbSendView extends View {
  render() {
    const r = this.app.rgb, a = r.find(r.asset);
    if (!r.ready || !a) { this.state.view = 'home'; return this.app.ui.view('home').render(); }
    if (r.sent) {
      const onChain = (r.profile.id === 'public' || r.isMain) && r.sent.txid;
      return `<section class="done"><div class="done-ic">${I.check}</div><h1>Sent</h1>
        <p>${esc(r.sent.shown)} ${esc(r.sent.ticker)} is on its way.</p><p class="muted small">It arrives once the other wallet picks it up and a block confirms it.</p>
        ${onChain ? `<a class="btn ghost" href="${this.account.explorer.tx(r.sent.txid)}" target="_blank" rel="noopener">View on mempool ${I.ext}</a>` : ''}
        <button class="btn primary wide" data-rgb="token" data-rgb-arg="${esc(a.assetId)}">Done</button></section>`;
    }
    if (r.pending) {
      const p = r.pending;
      return `<div class="view-head"><button class="icon-btn" data-rgb="cancel" aria-label="Back">${I.back}</button><h1>Confirm</h1><span class="head-sp"></span></div>
      <section class="card review">
        <p class="hero-label">You are sending</p>
        <p class="hero-bal">${esc(p.shown)} <small>${esc(p.ticker)}</small></p>
        <div class="kv">
          ${rowKV('Token', `${esc(p.ticker)} ${rgbBadge}`)}
          ${rowKV('To', `<span class="mono">${esc(short(p.invoice, 12))}</span>`)}
          ${rowKV('Privacy', '<span class="good">Private — the amount and token are not on the blockchain</span>')}
          ${p.fixed ? rowKV('Amount', 'set by the invoice') : ''}
          ${rowKV('Transfer server', `${esc(p.proxies.join(', '))} ${p.ask.length ? '<span class="muted">· not allowed yet</span>' : p.check?.ok ? '<span class="good">· reachable</span>' : p.check ? '<span class="meh">· not usable</span>' : '<span class="muted">· checking…</span>'}`)}
          ${rowKV('Network fee', `${p.witness ? `a few hundred ${r.isMain ? '' : 'test '}sats + 330 sats for their new output` : `a few hundred ${r.isMain ? '' : 'test '}sats`}${r.isMain ? ` · ${esc(r.fee())} sat/vB` : ''}`)}
        </div>
        ${p.ask.length ? `<p class="info">This invoice uses its own transfer server (${esc(p.ask.map((u) => new URL(u).host).join(', '))}). The token's proof is dropped off there for them to collect. Allow MASKED to reach it:</p>
          <button class="btn primary wide" data-rgb="allowProxy" ${r.busy ? 'disabled' : ''}>Allow ${esc(new URL(p.ask[0]).host)}</button>` : ''}
        ${p.check && !p.check.ok ? `<p class="info warn">MASKED can't use this invoice's transfer server: ${esc(p.check.detail)}</p><button class="btn ghost wide" data-rgb="recheck" ${r.busy ? 'disabled' : ''}>Check again</button>` : ''}
        ${msg(r)}
        <button class="btn primary wide" data-rgb="confirm" ${r.busy || !p.check?.ok ? 'disabled' : ''}>${r.busy ? 'Working…' : 'Confirm & send'}</button>
      </section>`;
    }
    const sp = Number(a.balance?.spendable || 0);
    return `${head(`Send ${esc(a.ticker)}`)}
    ${this.netBanner()}
    <section class="card form">
      ${input(r, 'sendTo', 'To', 'class="mono" placeholder="Paste their RGB invoice (rgb:…)"')}
      <p class="info">Ask them for an invoice: Receive → RGB in MASKED, or any RGB wallet.</p>
      ${input(r, 'sendAmt', 'Amount', 'inputmode="decimal" placeholder="0"', `Available ${r.amount(a, sp)} ${esc(a.ticker)}`)}
      ${msg(r)}
      <button class="btn primary wide" data-rgb="review" ${r.busy ? 'disabled' : ''}>Review</button>
    </section>`;
  }
}

export class RgbReceive {
  /** The RGB tab of Receive: an invoice as QR and text. */
  static render(app) {
    const r = app.rgb;
    if (!r.ready) {
      return `<section class="card receive"><div class="recv-badge">${rgbBadge}<b>RGB invoice</b></div>
        ${r.exists ? `<p class="muted center">${r.phase === 'error' ? esc(r.message) : 'Opening RGB…'}</p>` : `<p class="info">RGB tokens move privately: only you and the sender see them.</p><button class="btn primary wide" data-rgb="on" ${r.busy ? 'disabled' : ''}>Turn on RGB</button>`}</section>`;
    }
    const assets = r.assets(), cur = r.fields.recvAsset, a = cur ? r.find(cur) : null;
    const type = r.recvType(), low = r.btc().settled < RGB_BLIND_MIN;
    const segOf = (key, val, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, l]) => `<button role="radio" aria-checked="${val === v}" data-rgb="opt" data-rgb-arg="${key}:${v}">${l}</button>`).join('')}</div>`;
    if (r.invoice) {
      const info = r.invoiceInfo || {};
      const exp = RGB_EXPIRY.find(([v]) => Number(v) === info.expiry)?.[1] || '';
      return `<section class="card receive">
        <div class="recv-badge">${rgbBadge}<b>${info.amount ? `${esc(info.amount)} ${esc(info.ticker)}` : info.ticker ? `Any amount of ${esc(info.ticker)}` : 'Any RGB token'}</b></div>
        <div class="qr-wrap">${qrSvg(r.invoice)}</div><p class="addr mono small">${esc(r.invoice)}</p>
        <button class="btn primary wide" data-copy="${esc(r.invoice)}">${I.copy}<span>Copy invoice</span></button>
        <div class="kv small">${rowKV('Type', info.witness ? 'No BTC needed (witness)' : 'Private (blind)')}${rowKV('Works for', exp || 'a while')}</div>
        <p class="info">Send this to the person paying you. It works once.</p>
        <button class="btn ghost wide" data-rgb="opt" data-rgb-arg="recvType:${type}">New invoice</button>
        <p class="info warn">${r.isMain ? 'RGB beta: keep amounts small. Once it arrives, save a new RGB backup.' : `${esc(r.profile.label)} test tokens only. They have no value.`}</p>
      </section>`;
    }
    return `<section class="card form">
      <div class="field"><span class="lbl">Token</span>
        <div class="chips">${[['', 'Any token'], ...assets.map((x) => [x.assetId, x.ticker])].map(([id, t]) => `<button class="chip ${cur === id ? 'on' : ''}" data-rgb-pick="${esc(id)}"><b>${esc(t)}</b></button>`).join('')}</div></div>
      ${a ? input(r, 'recvAmt', 'Amount', 'inputmode="decimal" placeholder="Any amount"', `${esc(a.ticker)} · optional`) : ''}
      <div class="field"><span class="lbl">Works for</span>${segOf('recvExpiry', r.fields.recvExpiry, RGB_EXPIRY)}</div>
      <div class="field"><span class="lbl">Invoice type</span>${segOf('recvType', type, [['blind', 'Private'], ['witness', 'No BTC needed']])}
        <span class="addr-kind">${type === 'witness' ? 'The sender adds 330 sats (the minimum) for your new output, so you need no BTC.' : `Receives onto one of your RGB outputs, fully hidden. Needs a little ${r.isMain ? '' : 'test '}BTC.`}</span></div>
      ${type === 'blind' && low ? `<p class="info warn">Your RGB ${r.isMain ? '' : 'test '}BTC is low. Pick "No BTC needed", or add ${r.isMain ? '' : 'test '}BTC on Home first.</p>` : ''}
      ${msg(r)}
      <button class="btn primary wide" data-rgb="invoice" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Making invoice…' : 'Make invoice'}</button>
    </section>`;
  }
}

export class RgbMint {
  /** The "RGB token" tab of Mint: create a token, then a done screen. */
  static render(app) {
    const r = app.rgb;
    if (!r.ready) {
      return `<section class="card form"><p class="info">RGB tokens live off the blockchain: only you and the people you send them to see balances.</p>
        ${r.exists ? `<p class="muted center">${r.phase === 'error' ? esc(r.message) : 'Opening RGB…'}</p>` : `<button class="btn primary wide" data-rgb="on" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Turning on…' : 'Turn on RGB'}</button>`}</section>`;
    }
    if (r.issued) {
      const a = r.find(r.issued.assetId);
      return `<section class="done"><div class="done-ic">${I.check}</div><h1>${esc(r.issued.ticker)} created</h1>
        <p>${a ? r.amount(a, a.balance?.settled ?? a.issuedSupply) : esc(r.issued.supply)} ${esc(r.issued.ticker)} are in your wallet.</p>
        <p class="muted small">${r.isMain ? 'Bitcoin mainnet · save a new RGB backup now' : `${esc(r.profile.label)} test token · no value`}</p>
        ${r.isMain ? `<button class="btn primary wide" data-rgb="backup" ${r.busy ? 'disabled' : ''}>Save RGB backup</button>` : ''}
        ${a ? `<button class="btn primary wide" data-rgb="token" data-rgb-arg="${esc(a.assetId)}">View ${esc(a.ticker)}</button>` : ''}
        <button class="btn ghost wide" data-rgb="issueAgain">Create another</button></section>`;
    }
    if (r.issueAsk) {
      const q = r.issueAsk;
      return `<section class="card review">
        <p class="hero-label">Create on Bitcoin mainnet</p>
        <p class="hero-bal" style="font-size:30px">${esc(q.ticker)}</p>
        <div class="kv">
          ${rowKV('Name', esc(q.name))}
          ${rowKV('Supply', `${esc(q.supply)} · fixed forever`)}
          ${rowKV('Decimals', esc(String(q.precision)))}
          ${rowKV('Goes to', 'This wallet (all of it)')}
          ${rowKV('Cost', `one Bitcoin transaction fee · ${esc(r.fee())} sat/vB`)}
        </div>
        <p class="info warn">After it is created, save a new RGB backup: the token exists only in your wallet and its backups.</p>
        ${msg(r)}
        <button class="btn primary wide" data-rgb="issue" data-rgb-arg="go" ${r.busy ? 'disabled' : ''}>${r.busy ? esc(r.message || 'Creating…') : `Create ${esc(q.ticker)}`}</button>
        <button class="btn ghost wide" data-rgb="issueEdit" ${r.busy ? 'disabled' : ''}>Edit</button>
      </section>`;
    }
    const { settled, pending } = r.btc();
    const low = r.data && settled + pending < RGB_LOW_BTC;
    const t = r.isMain ? '' : 'test ';
    return `${r.isMain ? '<div class="testnet-note"><span class="dot-warn"></span>Bitcoin mainnet · RGB beta · the supply is fixed forever</div>' : `<div class="testnet-note"><span class="dot-warn"></span>${esc(r.profile.label)} · test tokens with no value</div>`}
    ${low ? `<button class="hint hint-cta" data-rgb="fund"><span class="hint-ic">${I.recv}</span><span><b>Add ${t}BTC first</b><span>Creating a token needs a little ${t}BTC for the network fee.</span></span><span class="chev">›</span></button>` : ''}
    <section class="card form">
      <div class="row2">
        ${input(r, 'name', 'Name', 'maxlength="40" placeholder="Masked Dollar"')}
        ${input(r, 'ticker', 'Ticker', 'maxlength="8" placeholder="MUSD" style="text-transform:uppercase"')}
      </div>
      ${input(r, 'supply', 'Supply', 'inputmode="numeric" placeholder="1000000"', 'whole tokens')}
      <details class="adv"><summary>Decimals</summary>${input(r, 'precision', 'Decimals', 'type="number" min="0" max="8"', '0 to 8')}</details>
      ${msg(r)}
      <button class="btn primary wide" data-rgb="issue" ${r.busy ? 'disabled' : ''}>${r.busy ? esc(r.message || 'Creating…') : 'Create token'}</button>
      <p class="info">The whole supply goes to your wallet. The first token takes a minute to set up.${r.isMain ? ' Standard RGB token (NIA): other RGB wallets can receive it.' : ''}</p>
    </section>`;
  }
}

export class RgbSettings {
  /** Settings → RGB: network, funding address, backup and restore. Signet only. */
  static render(app) {
    const r = app.rgb;
    if (!r.available) return '';
    const cur = r.profile.id;
    const nets = r.isMain ? '' : `<div class="seg" role="radiogroup">${Object.values(RGB_PROFILES).map((p) => `<button role="radio" aria-checked="${p.id === cur}" data-rgb="profile" data-rgb-arg="${p.id}" ${r.busy ? 'disabled' : ''}>${p.label}</button>`).join('')}</div>`;
    const { settled, pending } = r.btc();
    return `<section class="card"><details class="menu-det" data-k="rgb"><summary class="menu-row"><span>${I.mint}<b>${r.isMain ? 'RGB (beta)' : 'RGB (test)'}</b></span><span class="small muted">${r.ready ? 'on' : r.exists ? 'opening' : 'off'} ›</span></summary>
      <div class="det-body">
        ${nets ? `<div class="field"><span class="lbl">Test network</span>${nets}</div>` : '<p class="info warn">Beta on Bitcoin mainnet. RGB tokens can only be restored from an RGB backup file, so save one after every change. Keep amounts small.</p>'}
        ${r.ready ? `
        ${rowKV(r.isMain ? 'BTC for RGB fees' : 'Test BTC for fees', `${fmtBtc(settled)} ${r.isMain ? 'BTC' : 'tBTC'}${pending ? ` <span class="muted">+${fmtBtc(pending)} pending</span>` : ''}`)}
        <p class="addr mono small">${addrChunks(r.data?.address || '')}</p>
        <button class="btn ghost sm" data-copy="${esc(r.data?.address || '')}">${I.copy}<span>Copy RGB address</span></button>
        <p class="muted small">${esc(r.profile.funding)}</p>
        <button class="btn ghost wide" data-rgb="backup" ${r.busy ? 'disabled' : ''}>Save RGB backup file</button>
        <p class="muted small">${r.service?.backupRequired ? 'Changed since your last RGB backup.' : 'Backup up to date.'} Restoring needs this same MASKED wallet.</p>
        <button class="btn ghost wide" data-rgb="off" ${r.busy ? 'disabled' : ''}>Turn off RGB for now</button>
        ${r.isMain ? `<button class="btn ghost wide" data-rgb="betaOff" ${r.busy ? 'disabled' : ''}>Switch off RGB beta</button>` : ''}` : `
        ${r.exists ? '' : `<button class="btn primary wide" data-rgb="on" ${r.busy ? 'disabled' : ''}>Turn on RGB</button>`}`}
        <details><summary>Restore an RGB backup</summary><input id="rgbRestore" type="file" accept=".json,application/json"><button class="btn ghost wide" data-rgb="restore" ${r.busy ? 'disabled' : ''}>Restore</button></details>
        ${msg(r)}
      </div></details></section>`;
  }
}
