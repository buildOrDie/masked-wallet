// RGB on the wallet's own screens: a Tokens section on Home, a token page, Send, the RGB tab of Receive,
// "RGB token" on the Mint tab, and the advanced bits in Settings. Same parts as BRC-20: tok-line rows, the token
// page layout, the review card and the done screen.
import { dayLabel, esc, fmtBtc, short } from '../../core/format.mjs';
import { RGB_PROFILES } from '../../rgb/config.mjs';
import { RGB_BLIND_MIN, RGB_EXPIRY, RGB_LOW_BTC } from '../../rgb/WalletRgb.mjs';
import { View } from '../View.mjs';
import { I, addrChunks, btcLogo, head, qrSvg, rowKV, tokIcon } from '../html.mjs';

/** Why the engine holds an empty RGB output, in words (engine: emptyUtxos). */
const HELD_WHY = {
  'pending witness': 'its transaction carries an RGB transfer whose data never arrived: it may hold tokens',
  'blinded receive': 'reserved by an invoice',
  transfer: 'named by a transfer MASKED began',
  listing: 'kept for a listing',
  'bitcoin operation': 'named by a bitcoin transaction MASKED began',
  'not broadcast': 'its transaction isn\'t on the network',
  unconfirmed: 'waiting for a block',
};
export const rgbBadge = '<span class="badge rgb">RGB</span>';
const rgbIcon = (ticker, big = false) => tokIcon(ticker || 'RG', big).replace('class="tok-ic', 'class="tok-ic rgb');
const input = (r, key, label, extra = '', right = '') => `<label class="field"><span class="lbl">${label}${right ? ` <span class="lbl-r">${right}</span>` : ''}</span><input data-rgb-field="${key}" value="${esc(r.fields[key])}" autocomplete="off" spellcheck="false" ${extra}></label>`;
const msg = (r) => (r.message ? `<p class="msg" role="status">${esc(r.message)}</p>` : '')
  + (r.needBackup && r.isMain ? `<button class="btn ghost wide" data-rgb="backup" ${r.busy ? 'disabled' : ''}>${I.check}<span>Save RGB backup</span></button>` : '');

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : dayLabel(t); };

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
    if (t.status === 'Failed' && !got) return null; // an invoice cancelled before anything came (a lots split that didn't go, say)
    // its transaction is gone from the network: it never arrives
    if (r.isDropped?.(t)) return { label: 'Not received', sign: '', amount: got ? r.amount(a, got) : '', note: 'Dropped: the transaction never confirmed and is no longer on the network, so these tokens didn\'t arrive', txid: t.txid, dropped: true };
    return { label: 'Received', sign: '+', amount: got ? r.amount(a, got) : '…', note: STATUS[t.status] ?? '', txid: t.txid };
  }
  if (kind === 'Send') {
    // not broadcast until the other wallet accepts it: no transaction on mempool yet, and it can be cancelled
    const unsent = t.status === 'WaitingCounterparty';
    const stuck = unsent && r.stranded(t);
    const note = stuck ? 'Can\'t be finished or cancelled in this version: the other wallet accepted it, but its signed transaction was lost when this wallet was restored. Nothing was broadcast, so the tokens never left; they stay locked here.'
      : unsent ? 'Waiting for the other wallet to accept. Not on mempool until then.' : STATUS[t.status] ?? '';
    return { label: stuck ? 'Not sent' : unsent ? 'Sending' : 'Sent', sign: '−', amount: r.amount(a, fungible(t.requestedAssignment)), note, txid: unsent ? '' : t.txid, cancel: unsent && !stuck ? Number(t.batchTransferIdx) : null };
  }
  return { label: kind || 'Transfer', sign: '', amount: got ? r.amount(a, got) : '', note: STATUS[t.status] ?? '', txid: t.txid };
}

/**
 * A token's history in the words of what happened: one row per transaction. A transaction of this wallet that sends
 * tokens to itself (a listing's move, a cancel, a lot) is one row, not a "Sent" and a "Received"; a sale of an
 * Instant listing is "Sold … for … sats", a purchase "Bought … for … sats". The Instant records name them.
 * @returns {{ label: string, sign: string, amount: string, note: string, txid: string, at: number, pending: boolean, icon?: string, cancel?: number|null, dropped?: boolean }[]}
 */
export function tradeHistory(r, a) {
  let store = {};
  try { store = r.service?.instantStore?.().all?.() || {}; } catch { store = {}; }
  const role = new Map(); // txid -> { what, e }
  for (const e of Object.values(store)) {
    if (!e || e.assetId !== a.assetId) continue;
    if (e.role === 'seller') {
      if (e.moveTxid) role.set(String(e.moveTxid).toLowerCase(), { what: 'listed', e });
      if (e.cancelTxid) role.set(String(e.cancelTxid).toLowerCase(), { what: 'cancelled', e });
      if (e.soldTxid) role.set(String(e.soldTxid).toLowerCase(), { what: 'sold', e });
    } else if (e.role === 'buyer' && e.txid) {
      // a combined purchase (2.30): every listing points to the same transaction; the first one holds the totals
      const k = String(e.txid).toLowerCase();
      if (e.combinedIn && role.get(k)?.e?.combined) continue;
      role.set(k, { what: 'bought', e });
    }
  }
  const sats = (n) => `${Number(n || 0).toLocaleString('en-US')} sats`;
  const waiting = (t) => ['WaitingCounterparty', 'WaitingConfirmations'].includes(String(t.status));
  const groups = new Map(), out = [];
  for (const t of r.history(a.assetId)) {
    const h = historyRow(t, a, r);
    if (!h) continue;
    const key = t.txid ? String(t.txid).toLowerCase() : `#${t.batchTransferIdx}-${t.idx ?? Math.random()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ t, h });
  }
  for (const [txid, list] of groups) {
    const at = Math.max(...list.map((x) => (x.t.updatedAt || x.t.createdAt || 0) * 1000));
    const pending = list.some((x) => waiting(x.t) && !x.h.dropped);
    const ctx = role.get(txid);
    const recv = list.filter((x) => x.h.sign === '+'), sent = list.filter((x) => x.h.sign === '−');
    const amtOf = (x) => x.h.amount;
    const note = pending ? 'Waiting for a block' : '';
    if (recv.length && sent.length) {
      // this wallet to itself
      const amount = amtOf(recv[recv.length - 1]);
      if (ctx?.what === 'listed') { out.push({ label: 'Listed', sign: '', amount, note: note || `On its own output for an Instant listing at ${sats(ctx.e.priceSats)}. Nothing left your wallet.`, txid, at, pending, icon: 'move' }); continue; }
      if (ctx?.what === 'cancelled') { out.push({ label: 'Listing cancelled', sign: '', amount, note: note || 'Moved back to a new output of yours: the old listing can\'t be used.', txid, at, pending, icon: 'move' }); continue; }
      out.push({ label: 'Moved in your wallet', sign: '', amount, note: note || 'To an output of your own (a listing or a lot). Nothing left your wallet.', txid, at, pending, icon: 'move' });
      continue;
    }
    for (const { t, h } of list) {
      if (ctx?.what === 'sold' && h.sign === '−') { out.push({ ...h, label: 'Sold', note: h.note || `For ${sats(ctx.e.priceSats)}, on the RGB market`, txid, at, pending, icon: 'sold' }); continue; }
      if (ctx?.what === 'bought' && h.sign === '+') { out.push({ ...h, label: 'Bought', note: h.note || `For ${sats(ctx.e.priceSats)}, on the RGB market`, txid, at, pending }); continue; }
      out.push({ ...h, txid: h.txid, at: (t.updatedAt || t.createdAt || 0) * 1000, pending: waiting(t) && !h.dropped });
    }
  }
  // sales the engine doesn't list as a transfer (the buyer's transaction spent the listing's output)
  for (const [txid, c] of role) {
    if (c.what !== 'sold' || groups.has(txid)) continue;
    const e = c.e;
    out.push({ label: 'Sold', sign: '−', amount: r.amount(a, e.amount), note: `For ${sats(e.priceSats)}, on the RGB market`, txid, at: Number(e.at || 0), pending: false, icon: 'sold' });
  }
  return out.sort((x, y) => (Number(y.pending) - Number(x.pending)) || (y.at - x.at));
}

export class RgbHome {
  /** The RGB section of Home (Signet only). */
  static render(app) {
    const r = app.rgb;
    if (r.offerable && r.betaAsk) {
      return `<section class="card rgb-ask">
        <h2>RGB tokens on mainnet (beta)</h2>
        <ul class="ask-list">
          <li>Your recovery phrase alone can't bring RGB tokens back: they need an RGB backup.</li>
          <li>MASKED saves an <b>encrypted cloud backup</b> after every change. It's locked with keys from your recovery phrase before it leaves this browser, so MASKED's server can't read it. You can switch it off in Settings and save backup files yourself.</li>
          <li>RGB has keys of its own: its coins never mix with your Public or Shielded BTC.</li>
          <li>It's a beta: keep amounts small.</li>
        </ul>
        <label class="risk"><input type="checkbox" data-rgbbeta ${r.betaOk ? 'checked' : ''}><span>I understand RGB is a beta and my recovery phrase is what unlocks my RGB backup.</span></label>
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
    if (!r.ready && r.phase === 'allow') {
      return `<section class="home-toks"><div class="list-h"><b>RGB tokens</b></div>
      <button class="hint hint-cta" data-rgb="retry" ${r.busy ? 'disabled' : ''}><span class="hint-ic">${I.mint}</span><span><b>Allow RGB to connect</b><span>RGB needs to reach its transfer server. Chrome asks once.</span></span><span class="chev">›</span></button>${msg(r)}</section>`;
    }
    if (!r.ready) {
      // the last saved balances, shown the moment Home opens while the RGB engine starts (a few seconds) and checks the
      // chain: read only, nothing to tap until RGB is open
      const last = r.phase === 'error' ? null : r.peek?.();
      if (last) {
        const rows = r.assets().map((a) => { const { settled: s } = r.bal(a); return `<div class="tok-line">${rgbIcon(a.ticker)}<span class="bal-txt"><b class="tk">${esc(a.ticker)}</b><span>RGB</span></span><span class="bal-amt"><b>${r.amount(a, s)}</b><span>${esc(a.name)}</span></span></div>`; }).join('');
        return `<section class="home-toks"><div class="list-h"><b>RGB tokens${r.isMain ? ' <span class="badge">beta</span>' : ''}</b><span class="muted small">Last saved · opening…</span></div>
        <div class="tok-list">${rows || '<p class="muted small center">No RGB tokens yet.</p>'}</div></section>`;
      }
      return `<section class="home-toks"><div class="list-h"><b>RGB tokens</b><span class="muted small">${r.phase === 'error' ? '' : 'opening…'}</span></div>
      ${r.phase === 'error' ? `${msg(r)}<button class="btn ghost wide" data-rgb="retry">Try again</button>` : ''}</section>`;
    }
    if (!r.data) {
      return `<section class="home-toks"><div class="list-h"><b>RGB tokens</b><span class="muted small">${r.busy ? 'checking…' : ''}</span></div>
      ${r.busy ? '<p class="muted small center">Checking RGB balances… the first time takes up to a minute.</p>' : `${msg(r)}<button class="btn ghost wide" data-rgb="refresh">Try again</button>`}</section>`;
    }
    const list = r.assets();
    const { settled, pending } = r.btc();
    // with cloud backup on, Home only speaks up when the cloud could not save
    const cloudFail = r.cloudOn && r.cloud.error && r.service?.backupRequired;
    const backupDue = cloudFail
      ? `<button class="hint hint-cta" data-go="settings"><span class="hint-ic">${I.check}</span><span><b>RGB cloud backup didn't save</b><span>${esc(r.cloud.error)} Open Settings → RGB.</span></span><span class="chev">›</span></button>`
      : r.isMain && !r.cloudOn && r.service?.backupRequired
        ? `<button class="hint hint-cta" data-rgb="backup" ${r.busy ? 'disabled' : ''}><span class="hint-ic">${I.check}</span><span><b>Save your RGB backup</b><span>${r.service?.everBackedUp ? 'Something changed since your last backup. Save a new one to keep it.' : 'Needed once before you use RGB. Your recovery phrase alone can\'t bring RGB tokens back.'}</span></span><span class="chev">›</span></button>`
        : '';
    const unit = r.isMain ? 'BTC' : 'tBTC';
    const fund = settled + pending < RGB_LOW_BTC
      ? `<button class="hint hint-cta" data-rgb="fund"><span class="hint-ic">${I.recv}</span><span><b>Add to your RGB balance</b><span>Buying RGB tokens and their network fees are paid from your RGB balance. Add some from your Bitcoin balance.</span></span><span class="chev">›</span></button>`
      : '';
    // the RGB balance: its own bitcoin (buying tokens, network fees). Moved to and from the Bitcoin balance in one tap;
    // its address stays in Settings → RGB, for support
    const free = r.freeBtc();
    const wd = r.withdraw ? `<div class="card rgb-wd">
        <p class="small">Moves bitcoin from your RGB balance to your Bitcoin balance. Bitcoin holding RGB tokens stays where it is.</p>
        <label class="field"><span class="lbl">Amount in sats · ${free.settled.toLocaleString('en-US')} free to move</span><input id="rgbWdAmt" inputmode="numeric" autocomplete="off" placeholder="20000"></label>
        <div class="row-btns"><button class="btn primary" data-rgb="withdrawGo" ${r.busy ? 'disabled' : ''}>Move</button><button class="btn ghost" data-rgb="withdrawGo" data-rgb-arg="all" ${r.busy ? 'disabled' : ''}>Move everything</button><button class="btn ghost" data-rgb="withdrawClose">Cancel</button></div>
        <p class="muted small">Move everything also empties the small RGB outputs no token uses. RGB makes new ones from its balance the next time it needs them.</p>${msg(r)}</div>` : '';
    const feeRow = `<div class="tok-line rgb-fee">${btcLogo}
        <span class="bal-txt"><b class="tk">RGB balance</b><span>For buying RGB tokens and network fees</span></span>
        <span class="bal-amt"><b>${fmtBtc(settled)}</b><span>${pending ? `<span class="pend-t" title="Waiting for a block">+${fmtBtc(pending)} pending</span>` : unit}</span></span></div>
      <div class="rgb-bal-act"><button class="btn ghost sm" data-rgb="fund">${I.plus}<span>Add from Bitcoin</span></button><button class="btn ghost sm" data-rgb="${r.withdraw ? 'withdrawClose' : 'withdraw'}" ${settled + pending ? '' : 'disabled'}>${I.send}<span>Move to Bitcoin</span></button></div>${wd}`;
    // one module, like a wallet card: the header, the RGB balance, then Tokens | NFTs
    const cols = r.collections?.() || [];
    const nftCount = cols.reduce((n, c) => n + c.list.length, 0);
    // the side you picked last stays picked (this browser); NFTs first only when there are no tokens and no pick yet
    const pick = app.state.f.rgbHome || r.homeTab;
    const tab = cols.length && (pick === 'nft' || (!list.length && pick !== 'tok')) ? 'nft' : 'tok';
    const tokRows = list.map((a) => {
      const { settled: s, future: fut } = r.bal(a);
      return `<button class="tok-line" data-rgb="token" data-rgb-arg="${esc(a.assetId)}">${rgbIcon(a.ticker)}
        <span class="bal-txt"><b class="tk">${esc(a.ticker)}</b><span>${esc(a.name)}${fut > s ? ' · <span class="pend-t">incoming</span>' : ''}</span></span>
        <span class="bal-amt"><b>${r.amount(a, s)}</b><span translate="no">${esc(a.ticker)}</span></span><span class="chev">›</span></button>`;
    }).join('') || `<div class="rgb-empty"><p class="muted small">No RGB tokens yet.</p>${r.isMain ? `<button class="btn ghost sm" data-rgb="receive">${I.recv}<span>Receive an RGB token</span></button>` : `<button class="btn ghost sm" data-rgb="mint">${I.mint}<span>Create an RGB token</span></button>`}</div>`;
    const tabs = cols.length ? `<div class="seg rgb-tabs" role="radiogroup">
        <button role="radio" aria-checked="${tab === 'tok'}" data-rgb="homeTab" data-rgb-arg="tok">Tokens <span class="muted">${list.length}</span></button>
        <button role="radio" aria-checked="${tab === 'nft'}" data-rgb="homeTab" data-rgb-arg="nft">NFTs <span class="muted">${nftCount}</span></button></div>` : '<div class="rgb-sub">Tokens</div>';
    return `${backupDue}${fund}<section class="rgb-mod">
      <div class="list-h"><b>RGB${r.isMain ? ' <span class="badge">beta</span>' : ''}</b><span class="rgb-h-act"><button class="link small" data-rgb="refresh" ${r.busy ? 'disabled' : ''}>${r.busy ? r.busyLabel : r.quietRun ? 'Updating…' : r.data.cached ? 'Last saved · Refresh' : 'Refresh'}</button><button class="link small rgb-manage" data-rgb="hub">Activity & tools ›</button></span></div>
      <div class="rgb-top">${feeRow}${listingsRow(r)}</div>
      ${tabs}
      <div class="rgb-rows">${tab === 'nft' ? nftRows(r, cols) : tokRows}</div>
    </section>`;
  }
}

/** Home → RGB tokens: "Your listings" (only when there are any open), opening the listings screen. */
export function listingsRow(r) {
  let list = [];
  try { list = r.service?.instantListings?.() || []; } catch { list = []; }
  const open = list.filter((e) => listingState(e).open);
  if (!open.length) return '';
  const live = open.filter((e) => listingState(e).key === 'ready').length;
  const stuck = open.filter((e) => listingState(e).key === 'stuck').length;
  return `<button class="tok-line lst-row" data-rgb="listings"><span class="tok-ic lst-ic" aria-hidden="true">${I.list || '☰'}</span>
    <span class="bal-txt"><b class="tk">Your listings</b><span><span>${live} on sale</span>${stuck ? ` <span class="warn">${stuck} stuck</span>` : ''}</span></span>
    <span class="bal-amt"><b>${open.length}</b><span>open</span></span><span class="chev">›</span></button>`;
}

/** An NFT's picture: the image once loaded from the transfer server (and checked), its number meanwhile. */
export function nftPic(r, a, big = false) {
  const url = r.nftImg(a);
  return url ? `<img class="nft-img${big ? ' big' : ''}" src="${esc(url)}" alt="${esc(a.name)}">`
    : `<span class="nft-img ph${big ? ' big' : ''}">${esc((a.name.match(/#\s*\d+/) || [a.ticker])[0])}</span>`;
}

/** An NFT's traits from its metadata.json (checked against the NFT): a card, or nothing. */
export function nftTraitsCard(m) {
  if (!m) return '';
  return `<section class="card nft-traits"><div class="list-h"><b>Traits</b>${m.rarity ? `<span class="muted small">${esc(m.rarity)}</span>` : ''}</div>
    ${m.description ? `<p class="small muted">${esc(m.description)}</p>` : ''}
    <div class="trait-grid">${m.traits.map(([k, v]) => `<div class="trait"><span class="muted small">${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div></section>`;
}

/** The NFTs (RGB21 / UDA) this wallet holds, on Home: one row per collection, opening its own page. */
export function nftGrid(r) {
  const cols = r.collections?.() || [];
  if (!cols.length) return '';
  return `<div class="list-h nft-h"><b>NFT collections</b><span class="muted small">${cols.length}</span></div>
    <div class="tok-list">${nftRows(r, cols)}</div>`;
}

/** One row per NFT collection: its first pictures, verified or not, how many this wallet holds. */
export function nftRows(r, cols) {
  return `${cols.map((c) => {
      const incoming = c.list.filter((a) => { const { settled: s, future: f } = r.bal(a); return f > s; }).length;
      return `<button class="tok-line coll-line" data-rgb="coll" data-rgb-arg="${esc(c.key)}">
        <span class="coll-pics" aria-hidden="true">${c.list.slice(0, 3).map((a) => nftPic(r, a)).join('')}</span>
        <span class="bal-txt"><b class="tk" translate="no">${esc(c.name)}</b><span>${c.verified ? '<span class="ok-t">Verified</span>' : '<span class="warn">Unverified</span>'}${incoming ? ` · <span class="pend-t">${incoming} incoming</span>` : ''}</span></span>
        <span class="bal-amt"><b>${c.list.length}</b><span>NFT${c.list.length === 1 ? '' : 's'}</span></span><span class="chev">›</span></button>`;
    }).join('')}`;
}

/** One NFT collection of this wallet: its NFTs as a grid. */
export class RgbCollectionView extends View {
  render() {
    const r = this.app.rgb, c = (r.ready && r.collections?.().find((x) => x.key === r.coll)) || null;
    if (!c) { this.state.view = 'home'; return this.app.ui.view('home').render(); }
    return `
    <div class="tok-page">
      <div class="view-head"><button class="icon-btn" data-go="home" aria-label="Back">${I.back}</button><span class="head-sp"></span></div>
      <div class="coll-hero"><p class="tok-name" translate="no">${esc(c.name)} ${rgbBadge}</p>
        <p class="small ${c.verified ? 'ok-t' : 'warn'}">${c.verified ? 'Verified collection: every NFT here is on MASKED\'s whitelist' : 'Unverified: not on MASKED\'s whitelist'}</p>
        <p class="muted small">${c.list.length} NFT${c.list.length === 1 ? '' : 's'} in this wallet</p></div>
      <div class="nft-grid">${c.list.map((a) => {
        const { settled: s, future: fut } = r.bal(a);
        return `<button class="nft-tile" data-rgb="token" data-rgb-arg="${esc(a.assetId)}">${nftPic(r, a)}
          <span class="nft-name">${esc(a.name)}</span>${fut > s ? '<span class="pend-t small">incoming</span>' : ''}</button>`;
      }).join('')}</div>
      ${c.verified ? '' : '<p class="info warn small">Anyone can make an NFT with any name. These NFTs only share a name: MASKED can\'t tell who made them. Check each asset ID before trusting one.</p>'}
    </div>`;
  }
}

/** A token page for one RGB asset, like the BRC-20 one. */
export class RgbTokenView extends View {
  render() {
    const r = this.app.rgb, a = r.find(r.asset);
    if (!r.ready || !a) { this.state.view = 'home'; return this.app.ui.view('home').render(); }
    if (r.isNft(a)) return this.nft(a);
    const { settled: s, future: fut, spendable: sp, doubled, listed = 0 } = r.bal(a);
    const tab = this.f.rgbTab || 'history';
    return `
    <div class="tok-page">
      <div class="view-head"><button class="icon-btn" data-go="home" aria-label="Back">${I.back}</button><span class="head-sp"></span></div>
      <div class="tok-hero">${rgbIcon(a.ticker, true)}<p class="tok-name">${esc(a.ticker)} ${rgbBadge}</p><p class="tok-big">${r.amount(a, s)}</p>
        ${fut > s ? `<p class="pend-t small">+${r.amount(a, fut - s)} incoming · waiting for a block</p>` : ''}</div>
      <section class="card tok-box">
        <div class="d-row"><span>Available to send</span><b>${r.amount(a, sp)}</b></div>
        ${doubled && !r.doubledSeen(a.assetId, doubled) ? `<p class="info warn small">An earlier beta counted one payment of ${r.amount(a, doubled)} ${esc(a.ticker)} twice (two invoices shared an address). The extra isn't real, so it's left out here and can't be sent. New invoices each get their own address.</p>
          <button class="btn ghost sm" data-rgb="doubledOk" data-rgb-arg="${esc(a.assetId)}">Got it</button>` : ''}
        ${s > sp ? (() => {
          const open = r.invoices().filter((x) => !x.witness && r.invoiceStatus(x).key === 'waiting').length;
          const unsent = r.unsent(a.assetId).length;
          const stuck = r.unsent(a.assetId).filter((t) => r.stranded(t)).length;
          // in listings: say so first (it's most of it, or all of it, when a token is on sale)
          if (listed > 0) {
            const rest = s - sp - listed;
            return `<p class="info warn small">${r.amount(a, listed)} ${esc(a.ticker)} ${listed === 1 ? 'is' : 'are'} in your listings, so ${listed === 1 ? 'it' : 'they'} can't be sent. To send ${listed === 1 ? 'it' : 'them'}, cancel the listing first (on the market, My trades).${rest > 0 ? ` ${r.amount(a, rest)} more ${rest === 1 ? 'is' : 'are'} waiting for a block.` : ''}</p>
              ${r.outputs ? RgbSettings.outputs(r, this.app) : `<button class="btn ghost wide" data-rgb="outputs" ${r.busy ? 'disabled' : ''}>See what holds them</button>`}`;
          }
          const why = stuck
            ? `are held by a transfer that can't be finished or cancelled: the other wallet accepted it, but its signed transaction was lost when this wallet was restored, so it was never broadcast. The tokens never left, but this version of the RGB engine keeps them locked. The other wallet's incoming transfer never arrives and expires.`
            : unsent
            ? `are held by ${unsent === 1 ? 'a transfer' : `${unsent} transfers`} the other wallet hasn't accepted yet. Nothing has been broadcast, so you can cancel ${unsent === 1 ? 'it' : 'them'}: the tokens come back straight away.`
            : open ? `are locked by ${open === 1 ? 'an open Private invoice' : `${open} open Private invoices`}: a Private invoice reserves the RGB output these tokens sit on until it's paid or expires.`
              : 'are held by a transfer waiting for a block. They are freed once it confirms.';
          return `<p class="info warn small">${r.amount(a, s - sp)} ${esc(a.ticker)} ${why}</p>
            ${r.outputs ? RgbSettings.outputs(r, this.app) : `<button class="btn ghost wide" data-rgb="outputs" ${r.busy ? 'disabled' : ''}>See what holds them</button>`}
            ${unsent > stuck ? `<button class="btn ghost wide" data-rgb="cancelSend" ${r.busy ? 'disabled' : ''}>Cancel unsent transfer${unsent === 1 ? '' : 's'}</button>` : ''}
            ${open ? `<button class="btn ghost wide" data-rgb="cancelInv" ${r.busy ? 'disabled' : ''}>Cancel open invoices</button>` : ''}`;
        })() : ''}
        <div class="tok-acts">
          <button class="tact" data-rgb="send" data-rgb-arg="${esc(a.assetId)}" ${sp ? '' : 'disabled'}>${I.send}<span>Send</span></button>
          <button class="tact" data-rgb="receive" data-rgb-arg="${esc(a.assetId)}">${I.recv}<span>Receive</span></button>
        </div>
      </section>
      <div class="tabs">${[['history', 'History'], ['details', 'Details']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-set="rgbTab" data-val="${k}">${l}</button>`).join('')}</div>
      ${tab === 'history' ? `<section class="hist">${this.history(a)}</section>` : this.details(a)}
    </div>`;
  }

  /** One NFT: its picture, what it is, Send. */
  nft(a) {
    const r = this.app.rgb, { settled: s, future: fut, spendable: sp } = r.bal(a);
    return `
    <div class="tok-page">
      <div class="view-head"><button class="icon-btn" data-rgb="coll" data-rgb-arg="${esc(r.collectionOf(a).key)}" aria-label="Back">${I.back}</button><span class="head-sp"></span></div>
      <div class="tok-hero nft-hero">${nftPic(r, a, true)}<p class="tok-name">${esc(a.name)} ${rgbBadge}</p>
        ${fut > s ? '<p class="pend-t small">On its way · waiting for a block</p>' : ''}</div>
      <section class="card tok-box">
        ${r.listedWhy?.(a) ? `<p class="info warn small">${esc(r.listedWhy(a))}</p><button class="btn ghost wide" data-rgb="listings">Your listings</button>` : s && !sp ? (() => {
          const unsent = r.unsent(a.assetId).length, stuck = r.unsent(a.assetId).filter((t) => r.stranded(t)).length;
          return unsent > stuck
            ? `<p class="info warn small">It's held by a send the other wallet hasn't accepted yet. Nothing has been broadcast, so you can cancel it: the NFT stays here.</p>
              <button class="btn ghost wide" data-rgb="cancelSend" ${r.busy ? 'disabled' : ''}>Cancel unsent transfer</button>`
            : '<p class="info small">It\'s held by a transfer waiting for a block, and can be sent once it confirms.</p>';
        })() : ''}
        <div class="tok-acts"><button class="tact" data-rgb="send" data-rgb-arg="${esc(a.assetId)}" ${sp && !r.listedWhy?.(a) ? '' : 'disabled'}>${I.send}<span>Send</span></button></div>
      </section>
      ${nftTraitsCard(r.nftMeta?.(a))}
      <section class="card"><div class="kv">
        ${rowKV('Collection', `<button class="link" data-rgb="coll" data-rgb-arg="${esc(r.collectionOf(a).key)}" translate="no">${esc(r.collectionOf(a).name)}</button> ${r.collectionOf(a).verified ? '<span class="ok-t small">Verified</span>' : '<span class="warn small">Unverified</span>'}`)}
        ${a.details ? rowKV('Details', esc(a.details)) : ''}
        ${rowKV('Kind', 'NFT (RGB21), one of one')}
        ${rowKV('Network', r.isMain ? 'Bitcoin mainnet · beta' : `${esc(r.profile.label)} · test`)}
        ${rowKV('Asset ID', `<span class="mono small">${esc(short(a.assetId, 10))}</span>`)}
      </div><button class="btn ghost wide" data-copy="${esc(a.assetId)}">${I.copy}<span>Copy asset ID</span></button>
      <p class="info">The picture's fingerprint is part of the NFT: MASKED shows it only if the file matches.</p></section>
      <section class="hist">${this.history(a)}</section>
    </div>`;
  }

  history(a) {
    const r = this.app.rgb, explorer = this.account.explorer, onChain = r.profile.id === 'public' || r.isMain;
    const rows = tradeHistory(r, a);
    if (!rows.length) return '<p class="muted small center">No activity yet.</p>';
    let day = '';
    return rows.map((h) => {
      const label = h.pending ? 'Pending' : dayLabel(h.at);
      const sep = label !== day ? `<p class="h-day">${esc(label)}</p>` : '';
      day = label;
      const cls = h.sign === '−' ? 'out' : h.sign === '+' ? 'in' : 'mv';
      const icon = h.icon === 'sold' ? I.send : h.icon === 'move' ? I.list : h.sign === '−' ? I.send : h.label === 'Created' ? I.mint : I.recv;
      const inner = `<span class="h-ic ${cls}">${icon}</span>
        <span class="bal-txt"><b>${h.label}</b><span>${esc(h.note || 'Confirmed')}</span></span><span class="h-amt ${cls}">${h.sign}${h.amount}</span>`;
      const cancel = Number.isFinite(h.cancel) ? `<button class="btn ghost sm h-cancel" data-rgb="cancelSend" data-rgb-arg="${h.cancel}" ${r.busy ? 'disabled' : ''}>Cancel transfer</button>` : '';
      return sep + (h.txid && onChain ? `<a class="h-row" href="${explorer.tx(h.txid)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="h-row">${inner}</div>`) + cancel;
    }).join('');
  }

  details(a) {
    const r = this.app.rgb;
    return `<section class="card"><div class="kv">
      ${rowKV('Name', esc(a.name))}
      ${rowKV('Ticker', esc(a.ticker))}
      ${a.bridged ? rowKV('Supply', 'Bridged: made when locked on the other chain') : rowKV('Supply', r.amount(a, a.issuedSupply))}
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
        <p>${esc(r.sent.shown)}${r.sent.nft ? '' : ` ${esc(r.sent.ticker)}`} is on its way.</p><p class="muted small">It arrives once the other wallet picks it up and a block confirms it.</p>
        ${onChain ? `<a class="btn ghost" href="${this.account.explorer.tx(r.sent.txid)}" target="_blank" rel="noopener">View on mempool ${I.ext}</a>` : ''}
        <button class="btn primary wide" data-rgb="token" data-rgb-arg="${esc(a.assetId)}">Done</button></section>`;
    }
    if (r.pending) {
      const p = r.pending;
      return `<div class="view-head"><button class="icon-btn" data-rgb="cancel" aria-label="Back">${I.back}</button><h1>Confirm</h1><span class="head-sp"></span></div>
      <section class="card review">
        <p class="hero-label">You are sending</p>
        <p class="hero-bal">${esc(p.shown)} <small>${p.nft ? 'NFT' : esc(p.ticker)}</small></p>
        <div class="kv">
          ${rowKV('Token', `${esc(p.ticker)} ${rgbBadge}`)}
          ${rowKV('To', `<span class="mono">${esc(short(p.invoice, 12))}</span>`)}
          ${rowKV('Privacy', '<span class="good">Private — the amount and token are not on the blockchain</span>')}
          ${p.fixed ? rowKV('Amount', 'set by the invoice') : ''}
          ${rowKV('Transfer server', `${esc(p.proxies.join(', '))} ${p.ask.length ? '<span class="muted">· not allowed yet</span>' : p.check?.ok ? '<span class="good">· reachable</span>' : p.check ? '<span class="meh">· not usable</span>' : '<span class="muted">· checking…</span>'}`)}
          ${rowKV('Network fee', `${p.witness ? `a few hundred ${r.isMain ? '' : 'test '}sats + 330 sats for their new output` : `a few hundred ${r.isMain ? '' : 'test '}sats`}${r.isMain ? ` · <b>${esc(r.fee())} sat/vB</b>` : ''}`)}
        </div>
        ${r.isMain ? `<p class="lbl">Fee rate</p>${this.feeChips({ rbf: false })}
          <p class="fee-note">RGB uses whole sat/vB, so a rate below 1 is sent as 1. The transaction goes out once the other wallet accepts; a low rate can then wait a long time for a block.</p>` : ''}
        ${p.ask.length ? `<p class="info">This invoice uses a transfer server that needs permission (${esc(p.ask.map((u) => new URL(u).host).join(', '))}). The token's proof is dropped off there for the recipient.${this.app.platform.isPopup ? ' Chrome asks once; MASKED reopens here when you allow it.' : ''}</p>
          <button class="btn primary wide" data-rgb="allowProxy" ${r.busy ? 'disabled' : ''}>${p.ask.length === 1 ? `Allow ${esc(new URL(p.ask[0]).host)}` : 'Allow transfer servers'}</button>` : ''}
        ${p.check && !p.check.ok ? `<p class="info warn">MASKED can't use this invoice's transfer server: ${esc(p.check.detail)}</p><button class="btn ghost wide" data-rgb="recheck" ${r.busy ? 'disabled' : ''}>Check again</button>` : ''}
        ${msg(r)}
        <button class="btn primary wide" data-rgb="confirm" ${r.busy || !p.check?.ok ? 'disabled' : ''}>${r.busy ? 'Working…' : 'Confirm & send'}</button>
      </section>`;
    }
    const sp = r.bal(a).spendable, isNft = r.isNft(a);
    return `${head(`Send ${esc(isNft ? a.name : a.ticker)}`)}
    ${this.netBanner()}
    <section class="card form">
      ${isNft ? `<div class="nft-send">${nftPic(r, a)}<b>${esc(a.name)}</b></div>` : ''}
      ${input(r, 'sendTo', 'To', 'class="mono" placeholder="Paste their RGB invoice (rgb:…)"')}
      <p class="info">Ask them for an invoice: Receive → RGB in MASKED, or any RGB wallet that holds NFTs.</p>
      ${isNft ? '' : input(r, 'sendAmt', 'Amount', 'inputmode="decimal" placeholder="0"', `Available ${r.amount(a, sp)} ${esc(a.ticker)}`)}
      ${r.isMain ? `<div><p class="lbl">Network fee <span class="lbl-r">${esc(r.fee())} sat/vB · mempool now</span></p>${this.feeChips({ rbf: false })}</div>` : ''}
      ${msg(r)}
      <button class="btn primary wide" data-rgb="review" ${r.busy ? 'disabled' : ''}>Review</button>
    </section>`;
  }
}

export class RgbReceive {
  static backupPrompt(r) {
    const cloud = r.cloudOn && !r.cloud.conflict;
    return `<p class="info warn">This invoice isn't in a backup yet${r.cloudOn && r.cloud.error ? `: ${esc(r.cloud.error)}` : ''}. Save a backup to share it.</p>
      <button class="btn ghost wide" data-rgb="${cloud ? 'cloudRetry' : 'backup'}" ${r.busy ? 'disabled' : ''}>${I.check}<span>${cloud ? 'Save cloud backup' : 'Save backup file'}</span></button>`;
  }

  /** The RGB tab of Receive: an invoice as QR and text. */
  static render(app) {
    const r = app.rgb;
    if (!r.ready) {
      return `<section class="card receive"><div class="recv-badge">${rgbBadge}<b>RGB invoice</b></div>
        ${r.exists ? (r.phase === 'allow' ? `<button class="btn primary wide" data-rgb="retry" ${r.busy ? 'disabled' : ''}>Allow RGB to connect</button>` : `<p class="muted center">${r.phase === 'error' ? esc(r.message) : 'Opening RGB…'}</p>`) : `<p class="info">RGB tokens move privately: only you and the sender see them.</p><button class="btn primary wide" data-rgb="on" ${r.busy ? 'disabled' : ''}>Turn on RGB</button>`}</section>`;
    }
    const assets = r.assets(), cur = r.fields.recvAsset, a = cur ? r.find(cur) : null;
    const type = r.recvType(), low = r.btc().settled < RGB_BLIND_MIN;
    const segOf = (key, val, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, l]) => `<button role="radio" aria-checked="${val === v}" data-rgb="opt" data-rgb-arg="${key}:${v}">${l}</button>`).join('')}</div>`;
    if (r.invoice) {
      const info = r.invoiceInfo || {};
      const exp = RGB_EXPIRY.find(([v]) => Number(v) === info.expiry)?.[1] || '';
      return `<section class="card receive">
        <div class="recv-badge">${rgbBadge}<b>${info.amount ? `${esc(info.amount)} ${esc(info.ticker)}` : info.ticker ? `Any amount of ${esc(info.ticker)}` : 'Any RGB token'}</b></div>
        ${r.canShareInvoice ? `<div class="qr-wrap">${qrSvg(r.invoice)}</div><p class="addr mono small">${esc(r.invoice)}</p>
        <button class="btn primary wide" data-copy="${esc(r.invoice)}">${I.copy}<span>Copy invoice</span></button>` : RgbReceive.backupPrompt(r)}
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
        <span class="addr-kind">${type === 'witness' ? 'The sender adds 330 sats (the minimum) for your new output, so you need no BTC.' : `Receives onto one of your RGB outputs, fully hidden. Needs a little ${r.isMain ? '' : 'test '}BTC, and reserves that output (and any tokens on it) until it's paid or expires.`}</span></div>
      ${type === 'blind' && low ? `<p class="info warn">Your RGB ${r.isMain ? '' : 'test '}BTC is low. Pick "No BTC needed", or add ${r.isMain ? '' : 'test '}BTC on Home first.</p>` : ''}
      ${msg(r)}
      <button class="btn primary wide" data-rgb="invoice" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Making invoice…' : 'Make invoice'}</button>
    </section>
    ${RgbReceive.history(r)}`;
  }

  /** The invoices made here, newest first, with where each one stands. */
  static history(r) {
    const list = r.invoices().slice(0, 10);
    if (!list.length) return '';
    const share = r.canShareInvoice;
    return `<section class="card"><div class="list-h"><b>Your invoices</b><button class="link small" data-rgb="refresh" ${r.busy ? 'disabled' : ''}>${r.busy ? r.busyLabel : 'Refresh'}</button></div>
      ${list.map((inv) => {
        const st = r.invoiceStatus(inv);
        const what = inv.amount ? `${inv.amount} ${inv.ticker}` : inv.ticker ? `Any amount of ${inv.ticker}` : 'Any RGB token';
        return `<div class="ec-sent rgb-inv">
          <span><b>${esc(what)}</b><span class="muted small">${esc(new Date(inv.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · ${inv.witness ? 'No BTC needed' : 'Private'}</span>
            <span class="small inv-${st.key}">${esc(st.text)}</span></span>
          <span class="ec-sent-btns">${st.key === 'waiting' ? `${share ? `<button class="btn ghost sm" data-rgb="showInv" data-rgb-arg="${esc(inv.recipientId)}">Show</button><button class="btn ghost sm" data-copy="${esc(inv.invoice)}">Copy</button>` : ''}<button class="btn ghost sm" data-rgb="cancelInv" data-rgb-arg="${esc(inv.recipientId)}" ${r.busy ? 'disabled' : ''}>Cancel</button>` : ''}</span>
        </div>`;
      }).join('')}
      ${!share && list.some((inv) => r.invoiceStatus(inv).key === 'waiting') ? RgbReceive.backupPrompt(r) : ''}
    </section>`;
  }
}

export class RgbMint {
  /** The "RGB token" tab of Mint: create a token, then a done screen. */
  static render(app) {
    const r = app.rgb;
    if (!r.ready) {
      return `<section class="card form"><p class="info">RGB tokens live off the blockchain: only you and the people you send them to see balances.</p>
        ${r.exists ? (r.phase === 'allow' ? `<button class="btn primary wide" data-rgb="retry" ${r.busy ? 'disabled' : ''}>Allow RGB to connect</button>` : `<p class="muted center">${r.phase === 'error' ? esc(r.message) : 'Opening RGB…'}</p>`) : `<button class="btn primary wide" data-rgb="on" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Turning on…' : 'Turn on RGB'}</button>`}</section>`;
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
        ${nets ? `<div class="field"><span class="lbl">Test network</span>${nets}</div>${RgbSettings.cloud(r)}` : `<p class="info warn">Beta on Bitcoin mainnet. RGB tokens can only be restored from an RGB backup, not from the recovery phrase alone. Keep amounts small.</p>${RgbSettings.cloud(r)}`}
        ${r.ready ? `
        <button class="link-row" data-rgb="hub"><span><b>RGB wallet</b><span class="muted small"> · activity, locked tokens, outputs, backup</span></span><span class="chev">›</span></button>
        ${rowKV('RGB balance', `${fmtBtc(settled)} ${r.isMain ? 'BTC' : 'tBTC'}${pending ? ` <span class="muted">+${fmtBtc(pending)} pending</span>` : ''}`)}
        <p class="muted small">Its own address, for support. To add to it, use Add from Bitcoin on Home.</p>
        <p class="addr mono small">${addrChunks(r.data?.address || '')}</p>
        <button class="btn ghost sm" data-copy="${esc(r.data?.address || '')}">${I.copy}<span>Copy RGB balance address</span></button>
        <p class="muted small">${esc(r.profile.funding)}</p>
        ${Object.keys(r.data?.transfers || {}).some((id) => r.unsent(id).length) ? '<p class="info warn small">A transfer is waiting for the other wallet to accept it. Let it finish, or cancel it, before you restore this wallet anywhere else: a restored wallet can\'t finish a transfer that was already signed.</p>' : ''}
        <button class="btn ghost wide" data-rgb="backup" ${r.busy ? 'disabled' : ''}>Save RGB backup file</button>
        <p class="muted small">${r.fileAt ? `Last file: ${ago(r.fileAt)}. ` : 'No backup file saved from this browser yet. '}${r.cloudOn ? (r.cloud.error || r.service?.backupRequired ? 'Changes since the last cloud backup are not saved anywhere yet.' : 'The cloud backup has every change.') : r.service?.backupRequired ? 'Changed since your last RGB backup.' : 'Backup up to date.'} Restoring needs this same MASKED wallet.</p>
        ${RgbSettings.outputs(r, app)}
        ${RgbSettings.repair(r)}
        ${RgbSettings.instant(r)}
        <button class="btn ghost wide" data-rgb="off" ${r.busy ? 'disabled' : ''}>Turn off RGB for now</button>
        ${r.isMain ? `<button class="btn ghost wide" data-rgb="betaOff" ${r.busy ? 'disabled' : ''}>Switch off RGB beta</button>` : ''}` : `
        ${r.exists ? '' : `<button class="btn primary wide" data-rgb="on" ${r.busy ? 'disabled' : ''}>Turn on RGB</button>`}`}
        <details><summary>Restore an RGB backup</summary><input id="rgbRestore" type="file" accept=".json,application/json"><button class="btn ghost wide" data-rgb="restore" ${r.busy ? 'disabled' : ''}>Restore</button></details>
        ${msg(r)}
      </div></details></section>`;
  }
  /**
   * Settings → RGB → What's in this wallet: each token's balance (free, in listings, waiting, unusable), every RGB
   * output with the tokens on it and what it's doing, and every plain bitcoin coin of the RGB balance.
   */
  static outputs(r, app) {
    const rep = r.outputs;
    if (!rep) return `<button class="btn ghost wide" data-rgb="outputs" ${r.busy ? 'disabled' : ''}>What's in this RGB wallet</button>`;
    const unit = r.isMain ? 'BTC' : 'tBTC';
    const amt = (t) => { const a = r.find?.(t.assetId); return a ? r.amount(a, t.amount) : (Number(t.amount) / 10 ** (t.precision || 0)).toLocaleString('en-US'); };
    const tick = (t) => esc(t.ticker || short(t.assetId, 6));
    const link = (op) => { const tx = String(op).split(':')[0]; const ex = app?.account?.explorer; return ex && (r.profile.id === 'public' || r.isMain) ? `<a class="mono" href="${ex.tx(tx)}" target="_blank" rel="noopener">${esc(short(op, 6))}</a>` : `<span class="mono">${esc(short(op, 6))}</span>`; };
    const N = (v) => Number(v);
    // per token: where the balance is
    const tokens = (rep.tokens || []).map((t) => {
      const parts = [['free', 'free to list or send', t.free], ['listed', 'in your listings', t.listed], ['waiting', 'waiting for a block', t.waiting], ['other', 'on outputs it can\'t use', t.other]].filter(([, , v]) => N(v) > 0);
      const total = parts.reduce((x, [, , v]) => x + N(v), 0);
      return `<div class="rgo-tok"><div class="rgo-tokh"><b translate="no">${tick(t)}</b><span>${amt({ ...t, amount: String(total) })}</span></div>
        <div class="rgo-bar">${parts.map(([k, , v]) => `<i class="${k}" style="flex-grow:${N(v)}"></i>`).join('')}</div>
        <ul class="rgo-parts">${parts.map(([k, label, v]) => `<li><i class="${k}"></i>${amt({ ...t, amount: v })} ${label}</li>`).join('')}</ul></div>`;
    }).join('');
    // RGB outputs, by what they're doing
    const STATE = { 'on sale': ['On sale', 'An Instant listing: anyone can buy it, even with MASKED closed.'], 'going live': ['Going live', 'Moved for a listing, waiting to be signed.'], cancelling: ['Cancelling', 'A cancel waiting for its block.'], promised: ['Promised', 'Held for a listing MASKED no longer has a record of.'], free: ['Free', 'Can be listed or sent.'], waiting: ['Waiting for a block', 'A receive or a move not confirmed yet.'], unusable: ['Unusable', 'An output MASKED can\'t use for tokens.'], invoice: ['Kept for an invoice', 'Empty, reserved by an RGB invoice nobody has paid.'], held: ['Kept: may hold tokens', 'No token shows here, but MASKED can\'t be sure none sits on it, so it never spends it.'], dropped: ['Never arrived', 'The transaction carrying these tokens is gone from the network (never confirmed). They are still with the sender, who has to send them again.'], empty: ['Empty', 'Spare RGB outputs: tokens can be received on them.'] };
    const groups = new Map();
    for (const o of rep.rgb || []) { if (!groups.has(o.state)) groups.set(o.state, []); groups.get(o.state).push(o); }
    const rgbList = [...groups].map(([st, list]) => {
      const [title, hint] = STATE[st] || [st, ''];
      const sats = list.reduce((x, o) => x + o.sats, 0);
      return `<details class="rgo-grp" ${['on sale', 'going live', 'free', 'promised', 'unusable'].includes(st) ? 'open' : ''}><summary><span class="rgo-dot ${esc(st.replace(' ', '-'))}"></span><b>${title}</b><span class="muted small">${list.length} output${list.length === 1 ? '' : 's'} · ${fmtBtc(sats)} ${unit}</span></summary>
        <p class="muted small">${hint}</p>
        <ul class="rgo-list">${list.map((o) => `<li><span>${o.why ? `<small class="muted">${esc(HELD_WHY[o.why] || o.why)}</small> ` : ''}${o.tokens.length ? o.tokens.map((t) => `<b translate="no">${amt(t)} ${tick(t)}</b>${t.settled ? '' : ' <small class="muted">(unconfirmed)</small>'}`).join(' · ') : '<span class="muted">no token</span>'}${o.listing?.priceSats ? ` <small class="muted">for ${N(o.listing.priceSats).toLocaleString('en-US')} sats</small>` : ''}</span><span class="rgo-op">${link(o.outpoint)}<small class="muted">${o.sats.toLocaleString('en-US')} sats</small></span></li>`).join('')}</ul></details>`;
    }).join('');
    const coins = rep.coins || [];
    const spares = (rep.rgb || []).filter((o) => o.state === 'empty'), spareN = spares.length, spareSats = spares.reduce((x, o) => x + o.sats, 0);
    const coinSats = coins.reduce((x, c) => x + c.sats, 0);
    const coinList = coins.length ? `<ul class="rgo-list">${coins.map((c) => `<li><span><b>${c.sats.toLocaleString('en-US')}</b> sats${c.confirmed ? '' : ' <small class="muted">(unconfirmed)</small>'}${c.justSpent ? ' <small class="warn">just spent</small>' : ''}</span><span class="rgo-op">${link(c.outpoint)}</span></li>`).join('')}</ul>` : '<p class="muted small">No bitcoin on the RGB balance. Buying and moving tokens needs some: use Add from Bitcoin on Home.</p>';
    return `<div class="cloud-box rgo">
      <div class="cloud-h"><b>What's in this RGB wallet</b><span><button class="btn ghost sm" data-rgb="outputs" ${r.busy ? 'disabled' : ''}>Refresh</button> <button class="btn ghost sm" data-rgb="outputsClose">Close</button></span></div>
      ${tokens ? `<div class="rgo-sec"><h4>Tokens</h4>${tokens}</div>` : ''}
      <div class="rgo-sec"><h4>RGB outputs <span class="muted small">${(rep.rgb || []).length}</span></h4>${rgbList || '<p class="muted small">None.</p>'}</div>
      ${(rep.locks || []).length ? `<div class="rgo-sec rgo-locks"><h4>Held by unfinished transfers <span class="muted small">${new Set(rep.locks.map((l) => l.idx)).size}</span></h4>
        <p class="muted small">These outputs can't be listed or sent until the transfer holding them finishes. One whose transaction never went out (a trade the other side left, an invoice nobody paid) never will: release it and the output is free again. Nothing is sent.</p>
        <ul class="rgo-list">${[...new Map(rep.locks.map((l) => [l.idx, l])).values()].map((l) => {
          const ops = rep.locks.filter((x) => x.idx === l.idx);
          const what = { spends: 'A sale or send of yours', receives: 'Tokens coming to you', invoice: 'An invoice of yours' }[l.kind] || 'A transfer';
          const state = l.onChain ? 'its transaction is on the network: it finishes after its block' : l.releasable ? (l.txid ? 'its transaction never went out' : 'nothing was ever paid or sent') : 'made less than an hour ago';
          return `<li><span><b>${what}</b>${N(l.amount) ? ` · ${amt(l)} ${tick(l)}` : ''}<br><small class="muted">${state}${l.txid ? ` · ${esc(short(l.txid, 6))}` : ''}</small></span><span class="rgo-op">${ops.map((x) => link(x.outpoint)).join(' ')}${l.releasable ? `<button class="btn ghost sm" data-rgb="releaseLock" data-rgb-arg="${l.idx}" ${r.busy ? 'disabled' : ''}>Release</button>` : ''}</span></li>`;
        }).join('')}</ul></div>` : ''}
      <div class="rgo-sec"><h4>Bitcoin for fees and buys <span class="muted small">${coins.length} coin${coins.length === 1 ? '' : 's'} · ${fmtBtc(coinSats)} ${unit}</span></h4>${coinList}
        <p class="muted small">Each buy or move spends a coin of its own: a few coins let several go one after another without waiting.</p></div>
      ${rep.canFreeSpare && (spareN > (rep.keepSpare ?? 6) || rep.unpaidReceives) ? `<div class="rgo-sec"><p class="muted small">${spareN} spare RGB outputs hold ${fmtBtc(spareSats)} ${unit}. Keep ${rep.keepSpare ?? 6} for receiving tokens and turn the rest, with your bitcoin here, into 4 coins for buys (one transaction, a small network fee; outputs holding tokens never move).</p>
        ${rep.unpaidReceives ? `<p class="muted small">${rep.unpaidReceives} invoices of yours no transaction pays (moves that never went out) are given up first.</p>` : ''}<button class="btn primary wide" data-rgb="freeSpare" ${r.busy ? 'disabled' : ''}>${spareN > (rep.keepSpare ?? 6) ? `Free ${spareN - (rep.keepSpare ?? 6)} spare outputs` : `Give up ${rep.unpaidReceives} unused invoices`}</button></div>` : ''}
    </div>`;
  }
  /** Settings → RGB → Instant listings: each one's state (signed listings are bought with MASKED closed). */
  /** Earlier versions of the cloud backup the server keeps: load one (replaces this browser's RGB, kept aside first). */
  static cloudVersions(r) {
    const list = r.cloudVersions;
    const when = (t) => (t ? new Date(t).toLocaleString() : 'before this update');
    let undo = [];
    try { undo = r.service?.beforeLoads?.() || []; } catch { undo = []; }
    const undoBox = undo.length ? `<div class="cloud-box"><b>Undo a load</b>
      <p class="muted small">What this browser's RGB was just before each of its last loads. Loading one back replaces the current state, which is kept here in turn.</p>
      ${undo.map((u, i) => `<button class="btn ghost wide" data-rgb="undoLoad" data-rgb-arg="${i}" ${r.busy ? 'disabled' : ''}>Before the load of ${esc(when(u.at))}</button>`).join('')}</div>` : '';
    if (!list) return `<button class="btn ghost wide" data-rgb="cloudList" ${r.busy ? 'disabled' : ''}>Earlier backups</button>`;
    if (!list.length) return undoBox;
    const pick = list.find((v) => Number(v.version) === Number(r.cloudPick));
    if (pick) {
      return `<div class="cloud-box rgb-ask"><b>Load backup #${Number(pick.version)} from ${esc(when(pick.at))}?</b>
      <p class="muted small">This browser's RGB becomes exactly what it was then. Tokens received, sent, listed or sold after that time aren't in it: a receive made after it can't be finished from it, and outputs sold since then are counted again until you check RGB against the chain.</p>
      <p class="muted small">What this browser has now is kept, and Undo a load brings it back. The loaded one becomes the newest cloud backup.</p>
      <button class="btn primary wide" data-rgb="cloudLoadVersionYes" ${r.busy ? 'disabled' : ''}>Load #${Number(pick.version)}</button>
      <button class="btn ghost wide" data-rgb="cloudPickCancel">Not now</button></div>`;
    }
    return `<div class="cloud-box rgb-ask"><b>Earlier RGB backups</b>
      <p class="muted small">Load one only if this browser's RGB is wrong, for example after another copy of this wallet saved over it. Newest first.</p>
      <div class="cloud-list">${list.map((v) => `<button class="btn ghost wide" data-rgb="cloudLoadVersion" data-rgb-arg="${Number(v.version)}" ${r.busy || Number(v.version) === r.cloudVersion ? 'disabled' : ''}>#${Number(v.version)} · ${esc(when(v.at))}${Number(v.version) === r.cloudVersion ? ' · this browser' : ''}</button>`).join('')}</div>
      <button class="btn ghost wide" data-rgb="cloudVersionsClose">Close</button></div>${undoBox}`;
  }
  /** Check against the chain: outputs this wallet counts that another copy of it already spent. */
  static repair(r) {
    const g = r.repair?.gone;
    if (!g || !g.length) return `<button class="btn ghost wide" data-rgb="repairCheck" ${r.busy ? 'disabled' : ''}>Check RGB against the chain</button>`;
    const sums = new Map();
    for (const x of g) for (const a of x.assets) sums.set(a.assetId, (sums.get(a.assetId) || 0) + Number(a.amount));
    const list = [...sums].map(([id, n]) => { const a = r.find(id); return a ? `${r.amount(a, n)} ${esc(a.ticker)}` : `${n.toLocaleString('en-US')} units`; }).join(', ');
    return `<div class="cloud-box rgb-ask"><b>${g.length} output${g.length > 1 ? 's' : ''} already spent on chain</b>
      <p class="muted small">This wallet still counts ${esc(list)} on them, but another copy of this wallet (same recovery phrase) already moved those tokens. Only that copy can use them. If it's gone, mark these outputs spent here so the balance shows what this wallet can really move. If that copy still exists, load its backup instead.</p>
      <button class="btn primary wide" data-rgb="repairFix" ${r.busy ? 'disabled' : ''}>Mark them spent</button>
      <button class="btn ghost wide" data-rgb="repairCancel">Not now</button></div>`;
  }
  static instant(r) {
    let list = [];
    try { list = r.service?.instantListings?.() || []; } catch { list = []; }
    if (!list.length) return '';
    const open = list.filter((e) => listingState(e).open).length, live = list.filter((e) => listingState(e).key === 'ready').length;
    return `<div class="cloud-box"><div class="cloud-h"><b>Instant listings</b><span class="muted small">${live} on sale · ${open} open</span></div>
      <p class="muted small">Signed once, bought any time, even with MASKED closed. See them all and cancel one in Your listings.</p>
      <button class="btn ghost wide" data-rgb="listings">Open Your listings</button></div>`;
  }
  /** Settings → RGB → cloud backup: status, and the switch. */
  static cloud(r) {
    if (!r.cloudOn) return `<div class="cloud-box"><div class="cloud-h"><b>Cloud backup</b><span class="muted small">off</span></div>
      <p class="muted small">Save a backup file after every RGB change, or switch the encrypted cloud backup back on.</p>
      <button class="btn ghost wide" data-rgb="cloudOn" ${r.busy ? 'disabled' : ''}>Switch on cloud backup</button></div>`;
    if (r.cloudAsk) return `<div class="cloud-box rgb-ask"><b>Switch off cloud backup?</b>
      <p class="muted small">Every copy on MASKED's server is deleted. Your RGB tokens then depend on backup files you save yourself, after every change.</p>
      <button class="btn primary wide" data-rgb="cloudOffYes" ${r.busy ? 'disabled' : ''}>Switch off and delete</button>
      <button class="btn ghost wide" data-rgb="cloudKeep">Keep cloud backup</button></div>`;
    const state = r.cloud.saving ? 'saving…' : r.cloud.error ? 'not saved' : r.cloudAt ? `saved ${ago(r.cloudAt)}` : r.ready ? 'waiting' : 'on';
    return `<div class="cloud-box"><div class="cloud-h"><b>Cloud backup (encrypted)</b><span class="small ${r.cloud.error ? 'warn' : 'muted'}">${state}</span></div>
      <p class="muted small">Saved after every RGB change. It's encrypted in this browser with keys from your recovery phrase, then signed, so MASKED's server only stores data it can't read or change. A new browser with the same phrase restores it when you turn on RGB.</p>
      ${r.cloud.error ? `<p class="msg warn" role="status">${esc(r.cloud.error)}</p>
        ${r.cloud.conflict ? `<p class="muted small">Another copy of MASKED with this recovery phrase (another browser or profile, a second MASKED extension, or the phone app) saved newer RGB data. Moving tokens is paused here until this is settled. Usually the other copy is the up-to-date one: load its backup here. Only if this copy has your latest RGB tokens, make it the backup instead.</p>
          <button class="btn primary wide" data-rgb="cloudLoad" ${r.busy ? 'disabled' : ''}>Load the newer backup</button>
          <button class="btn ghost wide" data-rgb="cloudReplace" ${r.busy ? 'disabled' : ''}>Use this browser's RGB as the backup</button>`
          : `<button class="btn ghost wide" data-rgb="cloudRetry" ${r.busy ? 'disabled' : ''}>Try again</button>`}` : ''}
      ${RgbSettings.cloudVersions(r)}
      <button class="btn ghost wide" data-rgb="cloudOff" ${r.busy ? 'disabled' : ''}>Switch off cloud backup</button></div>`;
  }
}

/** A listing's state in words, with its pill tone. Stuck: still "going live" hours later (its tokens never moved). */
export function listingState(e, now = Date.now()) {
  const stuck = e.stage === 'moving' && Number(e.at) > 0 && now - Number(e.at) > 6 * 3600_000;
  if (stuck) return { key: 'stuck', label: 'Stuck', tone: 'warn', open: true, line: 'It hasn\'t gone live in hours. Cancel it: nothing moves, its tokens never left.' };
  return ({
    ready: { key: 'ready', label: 'On sale', tone: 'live', open: true, line: 'Anyone can buy it, even with MASKED closed.' },
    moving: { key: 'moving', label: 'Going live', tone: 'wait', open: true, line: 'On sale after its next block (about 10 minutes).' },
    outdated: { key: 'outdated', label: 'Can\'t sell', tone: 'warn', open: true, line: 'Signed by an older MASKED. Cancel it and list again.' },
    cancelling: { key: 'cancelling', label: 'Cancelling', tone: 'wait', open: true, line: 'Your tokens are free again after one confirmation.' },
    sold: { key: 'sold', label: 'Sold', tone: 'done', open: false, line: '' },
    cancelled: { key: 'cancelled', label: 'Cancelled', tone: 'off', open: false, line: '' },
  })[e.stage] || { key: e.stage, label: e.stage, tone: 'off', open: false, line: '' };
}

/**
 * Your listings: every Instant listing of this wallet in one place, by token. Open ones first (on sale, going live,
 * stuck, cancelling), each with its price per token and a Cancel that asks once, in the card itself; finished ones
 * (sold, cancelled) on their own tab. Reached from Home (RGB tokens) and Settings → RGB.
 */
export class RgbListingsView extends View {
  render() {
    const r = this.app.rgb;
    if (!r.ready) { this.state.view = 'home'; return this.app.ui.view('home').render(); }
    let all = [];
    try { all = r.service?.instantListings?.() || []; } catch { all = []; }
    const tab = this.f.listTab === 'done' ? 'done' : 'open';
    const withState = all.map((e) => ({ ...e, st: listingState(e) })).sort((a, b) => (b.at || 0) - (a.at || 0));
    const open = withState.filter((e) => e.st.open), done = withState.filter((e) => !e.st.open).slice(0, 50);
    const shown = tab === 'open' ? open : done;
    const live = open.filter((e) => e.st.key === 'ready').length;
    const tokens = new Map();
    for (const e of shown) { if (!tokens.has(e.assetId)) tokens.set(e.assetId, []); tokens.get(e.assetId).push(e); }
    const name = (id) => { const a = r.find?.(id); return a ? a.ticker : short(id, 6); };
    const amt = (e) => { const a = r.find?.(e.assetId); return a ? r.amount(a, e.amount) : Number(e.amount).toLocaleString('en-US'); };
    const per = (e) => { const a = r.find?.(e.assetId); const whole = Number(e.amount) / 10 ** (a?.precision || 0); return whole > 0 ? Number((Number(e.priceSats) / whole).toPrecision(4)).toLocaleString('en-US') : '–'; };
    const explorer = this.account?.explorer, onChain = r.profile.id === 'public' || r.isMain;
    const card = (e) => {
      const asking = r.cancelAsk === e.offerId;
      const canCancel = ['ready', 'moving', 'outdated', 'stuck'].includes(e.st.key);
      return `<article class="lst-card t-${esc(e.st.tone)}">
        <div class="lst-top"><b class="lst-amt" translate="no">${esc(amt(e))} ${esc(name(e.assetId))}</b><span class="lst-pill ${esc(e.st.tone)}">${esc(e.st.label)}</span></div>
        <div class="lst-price"><span>${Number(e.priceSats).toLocaleString('en-US')} sats</span><span class="muted">${per(e)} sats each</span></div>
        ${e.st.line ? `<p class="lst-line">${e.st.line}</p>` : ''}
        ${e.waiting && e.st.key !== 'stuck' ? `<p class="lst-line ${/couldn't/.test(e.waiting) ? 'warn' : ''}">${esc(e.waiting)}</p>` : ''}
        <div class="lst-meta"><span class="muted small">${e.at ? ago(e.at) : ''}</span>${e.txid && onChain && explorer ? `<a class="small" href="${explorer.tx(e.txid)}" target="_blank" rel="noopener">View transaction ${I.ext}</a>` : ''}</div>
        ${canCancel ? (asking ? `<div class="lst-ask">
            <p class="small">${e.st.key === 'ready' || e.st.key === 'outdated' ? 'MASKED moves these tokens to a new output of yours, so the signed listing can\'t be used any more. A small network fee.' : 'Nothing moves: the listing is just dropped.'}</p>
            <button class="btn primary wide" data-rgb="instantCancel" data-rgb-arg="${esc(e.offerId)}" ${r.busy ? 'disabled' : ''}>${r.busy ? 'Cancelling…' : 'Cancel this listing'}</button>
            <button class="btn ghost wide" data-rgb="instantCancelNo">Keep it</button></div>`
          : `<button class="btn ghost wide lst-cancel" data-rgb="instantCancelAsk" data-rgb-arg="${esc(e.offerId)}" ${r.busy ? 'disabled' : ''}>Cancel listing</button>`) : ''}
      </article>`;
    };
    return `${head('Your listings')}
      <p class="muted small lst-intro">Instant listings sell even when MASKED is closed. Cancel one here to get its tokens back.</p>
      <div class="seg lst-tabs" role="tablist">
        <button role="tab" aria-selected="${tab === 'open'}" data-rgb="listTab" data-rgb-arg="open">Open · ${open.length}</button>
        <button role="tab" aria-selected="${tab === 'done'}" data-rgb="listTab" data-rgb-arg="done">Finished · ${done.length}</button>
      </div>
      ${tab === 'open' && open.length ? `<p class="lst-sum"><b>${live}</b> on sale${open.length > live ? ` · <b>${open.length - live}</b> other open` : ''}</p>` : ''}
      ${shown.length ? [...tokens].map(([id, list]) => `<section class="lst-tok"><h3 class="lst-tokh">${rgbIcon(name(id))}<span translate="no">${esc(name(id))}</span><span class="muted small">${list.length}</span></h3>${list.map(card).join('')}</section>`).join('')
        : `<div class="lst-empty"><p>${tab === 'open' ? 'No open listings.' : 'Nothing finished yet.'}</p>${tab === 'open' ? '<p class="muted small">List a token on the RGB market: it shows up here.</p>' : ''}</div>`}`;
  }
}

/**
 * Every RGB transaction of this wallet in one list, newest first, each named with its token: what happened, how much,
 * and its state. `kind` sorts them for the filters: trade (bought, sold, listed, cancelled), move (in your wallet),
 * sent, received, created.
 */
export function rgbActivity(r) {
  const out = [];
  const every = Object.values(r.data?.groups || {}).flatMap((v) => v || []).filter((a) => a && typeof a === 'object' && a.assetId);
  for (const a of every) {
    for (const h of tradeHistory(r, a)) {
      const kind = /^(Bought|Sold|Listed|Listing cancelled)$/.test(h.label) ? 'trade' : h.icon === 'move' ? 'move' : h.label === 'Created' ? 'created' : h.sign === '−' ? 'sent' : h.sign === '+' ? 'received' : 'other';
      out.push({ ...h, a, kind });
    }
  }
  return out.sort((x, y) => (Number(y.pending) - Number(x.pending)) || (y.at - x.at));
}

const ACT_FILTERS = [['all', 'All'], ['pending', 'Pending'], ['trade', 'Trades'], ['transfer', 'Sent & received'], ['move', 'Moves']];

/**
 * The RGB wallet: everything about RGB in one place, from Home (before: a long section in Settings → RGB).
 * Activity (every token, filterable), what's locked and how to free it, backups.
 */
export class RgbWalletView extends View {
  render() {
    const r = this.app.rgb;
    if (!r.ready || !r.data) { this.state.view = 'home'; return this.app.ui.view('home').render(); }
    const tab = ['activity', 'locked', 'backup'].includes(this.f.rgbHub) ? this.f.rgbHub : 'activity';
    const all = rgbActivity(r);
    const pending = all.filter((h) => h.pending).length;
    let open = 0;
    try { open = (r.service?.instantListings?.() || []).filter((e) => listingState(e).open).length; } catch { open = 0; }
    const { settled, pending: btcPend } = r.btc();
    const unit = r.isMain ? 'BTC' : 'tBTC';
    const toks = Object.values(r.data?.groups || {}).reduce((n, v) => n + (v || []).length, 0);
    const tabs = [['activity', `Activity${pending ? ` · ${pending}` : ''}`], ['locked', 'Locked & free'], ['backup', 'Backup']];
    return `${head('RGB wallet')}
      <section class="rgbw-sum">
        <div><span class="muted small">Balance</span><b>${fmtBtc(settled)} <small>${unit}</small></b>${btcPend ? `<span class="pend-t small">+${fmtBtc(btcPend)} pending</span>` : ''}</div>
        <div><span class="muted small">Assets</span><b>${toks}</b></div>
        <button class="rgbw-stat" data-rgb="listings"><span class="muted small">Listings</span><b>${open}</b><span class="small">open ›</span></button>
        <div class="rgbw-refresh"><button class="btn ghost sm" data-rgb="refresh" ${r.busy ? 'disabled' : ''}>${r.busy ? esc(r.busyLabel || 'Updating…') : 'Refresh'}</button></div>
      </section>
      <div class="seg rgbw-tabs" role="radiogroup">${tabs.map(([k, l]) => `<button role="radio" aria-checked="${tab === k}" data-rgb="hubTab" data-rgb-arg="${k}">${l}</button>`).join('')}</div>
      ${tab === 'activity' ? this.activity(all) : tab === 'locked' ? this.locked() : this.backup()}
      ${msg(r)}`;
  }

  activity(all) {
    const r = this.app.rgb, explorer = this.account.explorer, onChain = r.profile.id === 'public' || r.isMain;
    const f = ACT_FILTERS.some(([k]) => k === this.f.rgbAct) ? this.f.rgbAct : 'all';
    const pick = (h) => f === 'all' || (f === 'pending' ? h.pending : f === 'transfer' ? h.kind === 'sent' || h.kind === 'received' : h.kind === f);
    const rows = all.filter(pick);
    const count = (k) => all.filter((h) => k === 'all' || (k === 'pending' ? h.pending : k === 'transfer' ? h.kind === 'sent' || h.kind === 'received' : h.kind === k)).length;
    const chips = `<div class="chips rgbw-chips">${ACT_FILTERS.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-set="rgbAct" data-val="${k}">${l}<span class="muted">${count(k)}</span></button>`).join('')}</div>`;
    if (!rows.length) return `${chips}<p class="muted small center">${all.length ? 'Nothing here with this filter.' : 'No RGB activity yet.'}</p>`;
    let day = '';
    return chips + `<section class="hist rgbw-hist">${rows.slice(0, 200).map((h) => {
      const label = h.pending ? 'Pending' : dayLabel(h.at);
      const sep = label !== day ? `<p class="h-day">${esc(label)}</p>` : '';
      day = label;
      const cls = h.sign === '−' ? 'out' : h.sign === '+' ? 'in' : 'mv';
      const icon = h.icon === 'sold' ? I.send : h.icon === 'move' ? I.list : h.sign === '−' ? I.send : h.label === 'Created' ? I.mint : I.recv;
      const link = h.txid && onChain ? `<a class="h-tx small" href="${explorer.tx(h.txid)}" target="_blank" rel="noopener" title="View transaction">${I.ext}</a>` : '';
      const cancel = Number.isFinite(h.cancel) ? `<button class="btn ghost sm h-cancel" data-rgb="cancelSend" data-rgb-arg="${h.cancel}" ${r.busy ? 'disabled' : ''}>Cancel transfer</button>` : '';
      return `${sep}<div class="h-row rgbw-row"><button class="rgbw-open" data-rgb="token" data-rgb-arg="${esc(h.a.assetId)}"><span class="h-ic ${cls}">${icon}</span>
        <span class="bal-txt"><b>${esc(h.label)} <span class="rgbw-tk" translate="no">${esc(h.a.ticker)}</span></b><span>${esc(h.note || 'Confirmed')}</span></span>
        <span class="h-amt ${cls}">${h.sign}${h.amount}</span></button>${link}</div>${cancel}`;
    }).join('')}</section>${rows.length > 200 ? '<p class="muted small center">Showing the latest 200. Open a token for all of its history.</p>' : ''}`;
  }

  locked() {
    const r = this.app.rgb;
    return `<p class="muted small">What each token holds (free to send or list, in listings, arriving), every RGB output and what keeps it busy, and how to free it.</p>
      ${RgbSettings.outputs(r, this.app)}
      ${RgbSettings.repair(r)}
      ${RgbSettings.instant(r)}`;
  }

  backup() {
    const r = this.app.rgb;
    return `<section class="card form">
      ${RgbSettings.cloud(r)}
      <button class="btn ghost wide" data-rgb="backup" ${r.busy ? 'disabled' : ''}>${I.check}<span>Save RGB backup file</span></button>
      <p class="muted small">${r.fileAt ? `Last file: ${ago(r.fileAt)}. ` : 'No backup file saved from this browser yet. '}Restoring needs this same MASKED wallet.</p>
      <details><summary>Restore an RGB backup</summary><input id="rgbRestore" type="file" accept=".json,application/json"><button class="btn ghost wide" data-rgb="restore" ${r.busy ? 'disabled' : ''}>Restore</button></details>
    </section>
    <section class="card">
      <div class="list-h"><b>RGB balance address</b></div>
      <p class="muted small">Its own address, for support. To add to it, use Add from Bitcoin on Home.</p>
      <p class="addr mono small">${addrChunks(r.data?.address || '')}</p>
      <button class="btn ghost sm" data-copy="${esc(r.data?.address || '')}">${I.copy}<span>Copy</span></button>
    </section>`;
  }
}
