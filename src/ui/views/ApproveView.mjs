import { esc, fmtBtc, short, sumSats } from '../../core/format.mjs';
import { NETWORKS } from '../../bitcoin/networks.mjs';
import { TRADE_PADDING } from '../../trade/trade-core.mjs';
import { NEEDS_PREP } from '../../dapp/ApprovalController.mjs';
import { View } from '../View.mjs';
import { I, btcLogo, rowKV } from '../html.mjs';

const TITLES = { requestAccounts: 'Connect to MASKED', signMessage: 'Sign message', signPsbt: 'Sign transaction', signPsbts: 'Sign transactions', sendBitcoin: 'Send bitcoin', switchNetwork: 'Switch network', inscribeTransfer: 'Inscribe transfer', shareTrade: 'Trade from Shielded', fundTrade: 'Move BTC to trading', moveToTrade: 'Move tokens to trading', returnToShielded: 'Move back to Shielded', cancelShielded: 'Cancel listing', cashuPay: 'Pay with ecash', cashuPayRequest: 'Pay with ecash', cashuReceive: 'Receive ecash', rgbInvoice: 'Receive RGB tokens', rgbPay: 'Send RGB tokens', rgbSwapAvailable: 'Share what you can sell', rgbListAssets: 'Share your RGB tokens', rgbBuyPrepare: 'Buy RGB tokens', rgbSalePrepare: 'Sell RGB tokens', rgbBuySign: 'Confirm your purchase', rgbSaleComplete: 'Complete the sale', rgbInstantList: 'Make an Instant listing', rgbInstantListLots: 'List in lots', rgbInstantBuy: 'Buy RGB tokens', rgbInstantBuyMany: 'Buy several listings', rgbInstantCancel: 'Cancel Instant listing' };
const VERBS = { requestAccounts: 'Connect', sendBitcoin: 'Send', inscribeTransfer: 'Inscribe', switchNetwork: 'Switch', shareTrade: 'Allow', fundTrade: 'Move', moveToTrade: 'Move', returnToShielded: 'Move back', cancelShielded: 'Cancel listing', cashuPay: 'Pay', cashuPayRequest: 'Pay', cashuReceive: 'Claim', rgbInvoice: 'Make invoice', rgbPay: 'Send', rgbSwapAvailable: 'Share', rgbListAssets: 'Share', rgbBuyPrepare: 'Buy', rgbSalePrepare: 'Sell', rgbBuySign: 'Sign and pay', rgbSaleComplete: 'Complete sale', rgbInstantList: 'Sign listing', rgbInstantListLots: 'Split and list', rgbInstantBuy: 'Buy now', rgbInstantBuyMany: 'Buy all', rgbInstantCancel: 'Cancel listing' };
const SHIELDED = `${I.shieldPlain} Shielded`;

/** The approval window for a dApp request: what it asks, what it costs, Reject / Approve. */
export class ApproveView extends View {
  render() {
    const a = this.app.approvals.active;
    if (!a || a.loading) return `<section class="card center"><p class="muted">Loading request…</p></section>`;
    if (a.gone) return `<section class="card center"><p>This request has expired.</p>${this.app.platform.local ? '<button class="btn ghost" data-go="market">Back to the market</button>' : '<button class="btn ghost" onclick="window.close()">Close</button>'}</section>`;
    if (a.done) return `<section class="done"><div class="done-ic">${I.check}</div><h1>Done</h1><p class="muted">You can close this window.</p></section>`;
    let host = a.origin; try { host = new URL(a.origin).host; } catch {}
    const blocked = (NEEDS_PREP.includes(a.method) && !a.prep) || ((a.method === 'signPsbt' || a.method === 'signPsbts') && !!a.prepErr);
    const busy = this.state.busy;
    return `
    <div class="ap-site"><span class="ap-ic">${esc(host.slice(0, 1).toUpperCase())}</span><span><b>${esc(host)}</b><small>${esc(a.origin)}</small></span></div>
    <h1 class="ap-title">${TITLES[a.method] || a.method}</h1>
    ${this.account.isTest ? this.netBanner() : ''}
    <section class="card">${this.body(a)}${this.statusLine('approve')}</section>
    <div class="ap-actions"><button class="btn ghost" data-reject>Reject</button><button class="btn primary" data-approve ${blocked || busy ? 'disabled' : ''}>${busy ? 'Working…' : VERBS[a.method] || 'Sign'}</button></div>`;
  }

  /** "Network fee" and "Total" once prepared, "calculating…" before, "—" after an error. */
  feeRows(a, fee, total) {
    const { unit } = this;
    if (a.prep) return rowKV('Network fee', `${fmtBtc(fee)} ${unit}`) + (total != null ? rowKV('Total', `<b>${fmtBtc(total)} ${unit}</b>`) : '');
    return rowKV('Network fee', a.prepErr ? '—' : 'calculating…');
  }

  error(a) { return a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''; }

  tokenAmount(P) { return `<p class="hero-bal center">${esc(Number(P.amount).toLocaleString())} <small>${esc(String(P.ticker).toUpperCase())}</small></p>`; }

  body(a) {
    const { account, unit } = this;
    const P = a.params || {}, b = a.prep;
    switch (a.method) {
      case 'requestAccounts':
        return `<div class="kv">${rowKV('Address it will see', `${btcLogo}<span class="mono">${esc(short(account.pubAddr(), 8))}</span>`)}${rowKV('Network', esc(account.params.name))}</div>
        <ul class="perm"><li>${I.check} See your Public address and balance</li><li>${I.check} Ask you to approve signatures and payments</li><li class="no">${I.lock} It cannot see your Shielded coins or move funds without asking</li></ul>`;
      case 'signMessage':
        return `<p class="lbl">Message</p><pre class="msgbox">${esc(P.message)}</pre><div class="kv">${rowKV('Signature type', P.type === 'bip322-simple' ? 'BIP-322 (address)' : 'ECDSA (public key)')}${rowKV('Signing with', `<span class="mono">${esc(short(account.pubAddr(), 8))}</span>`)}</div><p class="info">Signing a message is free and does not move funds.</p>`;
      case 'sendBitcoin': {
        const k = account.codec.kind(P.toAddress);
        const like = this.app.lookAlike(P.toAddress);
        return `<p class="hero-bal center">${fmtBtc(Number(P.satoshis))} <small>${unit}</small></p>
        ${like ? `<label class="risk"><input type="checkbox" data-risk ${this.f.apRisk ? 'checked' : ''}><span><b>Look-alike address.</b> It starts and ends like <span class="mono">${esc(short(like, 6))}</span>, which you used before, but it's a different address. Scammers do this. Only continue if you checked every character.</span></label>` : ''}
        <div class="kv">${rowKV('To', `<span class="mono">${esc(short(P.toAddress || '', 10))}</span>`)}${rowKV('Address type', `<span class="addr-kind k-${k.kind}">${esc(k.text || '')}</span>`)}${rowKV('From', `${btcLogo}Public`)}
        ${this.feeRows(a, b?.fee, b && b.amount + b.fee)}</div>
        ${this.error(a)}`;
      }
      case 'signPsbt': case 'signPsbts': {
        if (a.prepErr) return `<p class="msg err">${esc(a.prepErr)}</p>`;
        const risky = (b || []).some((p) => p.protectedCount);
        const unusual = (b || []).some((p) => p.unusual);
        const partial = (b || []).some((p) => p.partial);
        return (b || []).map((p, k) => this.psbtCard(p, k, b.length)).join('')
          + (risky ? `<label class="risk"><input type="checkbox" data-risk ${this.f.apRisk ? 'checked' : ''}><span>${partial ? '<b>Your signature covers only some outputs.</b> Outputs marked "can be changed" are not protected by it: the site can redirect them or add new ones after you sign, so they are not counted in your balance change. ' : ''}${unusual ? '<b>This uses an unusual signature type (SIGHASH_SINGLE).</b> It only covers one output. ' : ''}${(b || []).some((p) => p.toSign.some((x) => x.prot)) ? '<b>It spends an inscription coin.</b> ' : ''}Only continue if you trust this site and mean to do this (e.g. a marketplace listing).</span></label>` : '');
      }
      case 'shareTrade':
        return `<div class="kv">${rowKV('Trade address it will see', b ? `<span class="mono">${esc(short(b.address, 8))}</span>` : a.prepErr ? '—' : 'finding it…')}${b ? rowKV('Shielded totals it will see', `${fmtBtc(b.shielded.sats)} ${unit}${b.shielded.tokens.length ? ` · ${b.shielded.tokens.length} token${b.shielded.tokens.length > 1 ? 's' : ''}` : ''}`) : ''}</div>
        <ul class="perm"><li>${I.check} Buy, sell and swap from a private trade address</li><li>${I.check} Ask you to move bitcoin or tokens between Shielded and that address</li><li class="no">${I.lock} It never sees your Shielded address or its payments, and nothing moves without asking</li></ul>
        <p class="info">The trade address is made from your recovery phrase and is not linked to your Public address. Move everything back to Shielded when you are done and the next trades get a fresh one.</p>
        ${this.error(a)}`;
      case 'fundTrade':
        return `<p class="hero-bal center">${fmtBtc(b ? b.amount : (Number(P.satoshis) || 0) + (P.padding ? TRADE_PADDING : 0))} <small>${unit}</small></p>
        <div class="kv">${rowKV('From', SHIELDED)}${rowKV('To', b ? `Your trade address <span class="mono">${esc(short(b.address, 6))}</span>` : 'Your trade address')}${P.padding ? rowKV('Includes', `a ${TRADE_PADDING}-sat coin to hold what you buy`) : ''}
        ${this.feeRows(a, b?.fee, b && b.amount + b.fee)}</div>
        <p class="info">Change goes back to Shielded. The site can use these coins right away, before they confirm.</p>
        ${this.error(a)}`;
      case 'cancelShielded':
        return `<p class="hero-bal center">${b?.tick ? `${esc(Number(b.amt).toLocaleString())} <small>${esc(String(b.tick).toUpperCase())}</small>` : 'Listing'}</p>
        <div class="kv">${rowKV('Back to', SHIELDED)}${this.feeRows(a, b?.fee, null)}</div>
        <p class="info">The listed coin moves to a new Shielded coin, so the signed listing stops working everywhere. The tokens stay yours.</p>
        ${this.error(a)}`;
      case 'moveToTrade': case 'returnToShielded': {
        const back = a.method === 'returnToShielded';
        const fees = b ? (b.op === 'tsend' ? rowKV('Network fees', `${fmtBtc(b.sendTotalFee)} ${unit} (3 small transactions)`) : rowKV('Network fee', `${fmtBtc(b.fee)} ${unit}`)) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…');
        const top = P.ticker ? this.tokenAmount(P) : `<p class="hero-bal center">${b ? (b.empty ? 'Nothing left' : `${fmtBtc(b.value)} <small>${unit}</small>`) : '…'}</p>`;
        const info = P.ticker ? 'Tokens move with a transfer inscription. They count once it confirms (about 10 minutes).' : b?.empty ? 'Your trade address is empty. Approve to start using a fresh one.' : 'Everything arrives as private Shielded payments. Open orders using these coins end. Tokens on the trade address stay there: move them separately.';
        return `${top}<div class="kv">${rowKV('From', back ? 'Your trade address' : SHIELDED)}${rowKV('To', back ? SHIELDED : 'Your trade address')}
        ${!P.ticker && b?.items ? rowKV('Items', `${b.items} coin${b.items > 1 ? 's' : ''} with inscriptions, each kept on its own coin`) : ''}${b?.empty ? '' : fees}</div>
        <p class="info">${info}</p>
        ${this.error(a)}`;
      }
      case 'inscribeTransfer': return this.inscribeBody(a, P, b);
      case 'cashuPay': case 'cashuPayRequest': {
        const e = this.app.ecash, amount = b?.amount ?? Number(P.amount) ?? 0;
        let to = 'This site';
        if (b?.post) { try { to = `Sent to <span class="mono">${esc(new URL(b.post).host)}</span>`; } catch {} }
        return `<p class="hero-bal center">${amount ? Number(amount).toLocaleString('en-US') : '…'} <small>sats</small></p>
        ${b?.memo ? `<p class="lbl">For</p><pre class="msgbox">${esc(b.memo)}</pre>` : ''}
        <div class="kv">${rowKV('From', b ? `Ecash · ${esc(e.mintName(b.url))}` : a.prepErr ? '—' : 'finding ecash…')}
        ${b ? rowKV('You have there', `${e.balance(b.url).toLocaleString('en-US')} sats`) : ''}
        ${rowKV('To', a.method === 'cashuPayRequest' ? to : 'This site gets a token')}
        ${b?.lockTo ? rowKV('Locked to', `${I.lock} <span class="mono">${esc(short(b.lockTo, 8))}</span>`) : b?.p2pk ? rowKV('Locked to', `${I.lock} the payee's key`) : ''}
        ${rowKV('Mint fee', 'a few sats at most, paid by you')}</div>
        <p class="info">Ecash moves instantly and can't be reversed once the site claims it.${a.method === 'cashuPay' ? (b?.lockTo ? ' If nobody claims it within 7 days, you can take it back in Ecash.' : ' If the site never claims it, you can take it back in Ecash.') : ''}</p>
        ${this.error(a)}`;
      }
      case 'cashuReceive': {
        return `<p class="hero-bal center">${b ? b.amount.toLocaleString('en-US') : '…'} <small>sats</small></p>
        <div class="kv">${rowKV('Mint', b ? `<span class="mono">${esc(b.mint.replace(/^https?:\/\//, ''))}</span>${b.known ? '' : ' <span class="badge">new</span>'}` : '…')}
        ${b?.locks.length ? rowKV('Locked to', `${I.lock} you`) : ''}</div>
        ${b && !b.known ? '<p class="info warn">You don\'t use this mint yet. Claiming adds it: the ecash is an IOU from this mint, so only claim from mints you\'re fine holding a little with.</p>' : '<p class="info">The token is swapped at its mint for fresh ecash only you know.</p>'}
        ${this.error(a)}`;
      }
      case 'rgbInvoice': return this.rgbInvoiceBody(a, P, b);
      case 'rgbPay': return this.rgbPayBody(a, P, b);
      case 'rgbSwapAvailable': case 'rgbListAssets': case 'rgbBuyPrepare': case 'rgbSalePrepare': case 'rgbBuySign': case 'rgbSaleComplete': case 'rgbInstantList': case 'rgbInstantListLots': case 'rgbInstantBuy': case 'rgbInstantBuyMany': case 'rgbInstantCancel': return this.swapBody(a, P, b);
      case 'switchNetwork':
        return `<div class="kv">${rowKV('From', esc(account.params.name))}${rowKV('To', `<b>${esc(NETWORKS[P.target]?.name || P.target)}</b>`)}</div>`;
      default: return '';
    }
  }

  /** "Opening RGB…" while the RGB account loads in this window. */
  rgbWait(a) { return a.rgbWait && !a.prepErr ? `<p class="info">${esc(a.rgbWait)}</p>` : ''; }

  rgbInvoiceBody(a, P, b) {
    const r = this.app.rgb;
    return `<p class="hero-bal center">${b ? esc(b.shown) : '…'}</p>
    <div class="kv">${rowKV('Token', b?.nft ? 'An NFT (RGB21): which one is picked by the site' : b?.asset ? `${esc(b.asset.ticker)} <span class="mono">${esc(short(b.assetId, 8))}</span>` : P.assetId ? `<span class="mono">${esc(short(P.assetId, 8))}</span>` : 'Any token')}
    ${rowKV('Network', esc(r.profile.label))}
    ${b ? rowKV('Invoice type', b.witness ? 'No BTC needed (the sender adds a small output)' : 'Private (uses one of your RGB outputs)') : ''}
    ${rowKV('Works for', `${Math.round((b?.expiry || P.expiry || 86400) / 3600)} hours`)}</div>
    ${b?.nft ? `<p class="info">The NFT is described by ${esc(new URL(a.origin).host)}. It shows under RGB → NFTs once it arrives, with its picture checked against the NFT itself.</p>` : b?.siteDescribed ? `<p class="info">You don't hold this token yet, so the amount is shown as ${esc(new URL(a.origin).host)} describes it (${P.precision} decimals: ${esc(Number(P.baseUnits).toLocaleString('en-US'))} smallest units). It shows in RGB once it arrives.</p>` : b?.newToken ? '<p class="info">You don\'t hold this token yet. It shows in RGB once it arrives.</p>' : ''}
    <p class="info">The site gets an invoice to send you tokens. It can't take anything from your wallet. Tokens arrive after one confirmation.</p>
    ${this.rgbWait(a)}${this.error(a)}`;
  }

  rgbPayBody(a, P, b) {
    const r = this.app.rgb;
    const amount = b && !b.needAmount ? `${esc(b.shown)} <small>${esc(b.ticker)}</small>` : b ? `<small>${esc(b.ticker)}</small>` : '…';
    return `<p class="hero-bal center">${amount}</p>
    ${b?.needAmount ? `<label class="field"><span class="lbl">How many ${esc(b.ticker)}</span><input data-bind="apRgbAmt" inputmode="decimal" value="${esc(this.f.apRgbAmt || '')}" placeholder="You have ${esc(b.spendable)}"></label>` : ''}
    <div class="kv">${rowKV('Token', b ? `${esc(b.ticker)} <span class="mono">${esc(short(b.assetId, 8))}</span>` : '…')}
    ${b ? rowKV('You have', `${esc(b.spendable)} ${esc(b.ticker)}`) : ''}
    ${rowKV('To', `<span class="mono">${esc(short(P.invoice || '', 12))}</span>`)}
    ${b ? rowKV('Transfer server', `<span class="mono">${esc(b.proxy)}</span>`) : ''}
    ${rowKV('Network', esc(r.profile.label))}
    ${rowKV('Network fee', b ? `${esc(b.fee)} sat/vB, from your RGB BTC` : a.prepErr ? '—' : 'calculating…')}</div>
    <p class="info">Tokens sent to an invoice can't be taken back. The other side accepts first, then the transaction goes out: keep this window open for up to a minute.</p>
    ${this.rgbWait(a)}${this.error(a)}`;
  }

  /** The swap steps: what you give, what you get, and what happens next. */
  swapBody(a, P, b) {
    const sats = (n) => `${Number(n).toLocaleString('en-US')} sats`;
    const unitTxt = (n) => Number(Number(n).toPrecision(4)).toLocaleString('en-US');
    const tok = b ? (b.asset ? `${esc(b.asset.ticker)} <span class="mono">${esc(short(b.assetId, 8))}</span>` : `<span class="mono">${esc(short(b.assetId || P.assetId || '', 8))}</span>`) : '…';
    if (a.method === 'rgbListAssets') {
      const list = b?.list || [];
      return `<div class="kv">${rowKV('Tokens', b ? (list.length ? list.map((x) => esc(x.ticker || short(x.assetId, 6))).join(', ') : 'none yet') : '…')}${rowKV('Network', esc(this.app.rgb.profile.label))}</div>
      <p class="info">The site sees which RGB tokens you hold, their asset IDs and how much of each. Nothing moves.</p>${this.rgbWait(a)}${this.error(a)}`;
    }
    if (a.method === 'rgbSwapAvailable') {
      return `<div class="kv">${rowKV('Token', tok)}</div><p class="info">The site sees how much of this token you can offer. Nothing moves.</p>${this.rgbWait(a)}${this.error(a)}`;
    }
    const m = a.method, buying = m === 'rgbBuyPrepare' || m === 'rgbBuySign' || m === 'rgbInstantBuy' || m === 'rgbInstantBuyMany';
    if (m === 'rgbInstantList') {
      return `<p class="hero-bal center">${b ? esc(b.shown) : '…'}</p><div class="kv">${rowKV('Token', tok)}${b ? rowKV('You get', `<b>${sats(b.price)}</b>`) : ''}${b ? rowKV('Market', `<span class="mono">${esc(b.market)}</span>`) : ''}${rowKV('Network', esc(this.app.rgb.profile.label))}</div>
      <p class="info">MASKED signs this sale once. Anyone can then buy it at this exact price, even while your computer is off: the signature is only valid if the transaction pays you ${b ? sats(b.price) : 'the price'}.</p>
      ${b?.finishing ? '<p class="info">Your tokens were already moved to an output of their own for this listing. MASKED checks they arrived and signs it: no new transaction.</p>' : ''}
      <p class="info">If these tokens share an output with others, MASKED first moves them to an output of their own: one transaction (network fee about ${b ? `${sats(b.fee)}, ${esc(String(b.rate))} sat/vB × ~${b.vb} vB` : '…'}), and the listing goes live after it confirms, about 10 minutes, the next time MASKED is open.</p>
      <p class="info">Cancelling later also takes one transaction: MASKED moves the tokens so the signature can't be used.</p>
      ${this.rgbWait(a)}${this.error(a)}`;
    }
    if (m === 'rgbInstantListLots') {
      const lotsTxt = !b ? '…' : b.same ? `${b.n} × ${esc(b.each[0].shown)} ${esc(b.asset.ticker)} <span class="muted small">${sats(b.each[0].price)} each</span>` : `${b.n} <span class="muted small">${b.each.map((x) => `${esc(x.shown)} for ${sats(x.price)}`).join(', ')}</span>`;
      return `<p class="hero-bal center">${b ? esc(b.shown) : '…'}</p><div class="kv">${rowKV('Token', tok)}${rowKV('Lots', lotsTxt)}${b ? rowKV('You get', `<b>${sats(b.price)}</b> <span class="muted small">if every lot sells</span>`) : ''}${b ? rowKV('Network fee', `${sats(b.fee)} <span class="muted small">about, ${esc(String(b.rate))} sat/vB, ${b.n} transactions</span>`) : ''}${b ? rowKV('On the lots\' outputs', `${sats(b.seal)} <span class="muted small">stays yours, comes back if you cancel</span>`) : ''}${b ? rowKV('Market', `<span class="mono">${esc(b.market)}</span>`) : ''}${rowKV('Network', esc(this.app.rgb.profile.label))}</div>
      ${b?.atOnce === false ? '<p class="info">MASKED puts each lot on an output of its own: the first right away, then one per block (a lot whose tokens are already alone on an output needs no move). After each confirms (about 10 minutes), MASKED signs that lot as its own Instant listing while it\'s open. Buyers then take as many lots as they want, even while your computer is off, and the rest stays listed.</p>' : `<p class="info">MASKED moves each lot to an output of its own (${b ? `${b.n} small transactions` : 'one small transaction each'}) and signs every lot now: all of them are on sale as soon as you approve, even if you close MASKED right after. Buyers take as many lots as they want; the rest stay on sale.</p>`}
      <p class="info">Each signature is only valid if the transaction pays you that lot's price. Cancelling a lot later takes one transaction.</p>
      ${this.rgbWait(a)}${this.error(a)}`;
    }
    if (m === 'rgbInstantCancel') {
      return `<p class="hero-bal center">${b ? esc(b.shown) : '…'}</p><div class="kv">${rowKV('Token', tok)}${b && b.fee ? rowKV('Network fee', `${sats(b.fee)} <span class="muted small">${esc(String(b.rate))} sat/vB × ~${b.vb} vB</span>`) : ''}</div>
      <p class="info">${b && b.stage === 'ready' ? 'MASKED moves your tokens to a new output of your own, so the signed listing can no longer be used. Until that transaction confirms, a buyer may still get there first: then the sale goes through at your price.' : 'The listing was not signed yet: nothing to move.'}</p>
      ${this.rgbWait(a)}${this.error(a)}`;
    }
    const hero = b ? `<p class="hero-bal center">${esc(b.shown)}</p>` : '<p class="hero-bal center">…</p>';
    const rows = !b ? '' : buying
      ? (b.n ? rowKV('Listings', `${b.n} <span class="muted small">${b.lo === b.hi ? `${unitTxt(b.lo)} sats each` : `${unitTxt(b.lo)} to ${unitTxt(b.hi)} sats each`}</span>`) : '')
        + rowKV('You pay', `<b>${sats(b.price + (b.fee || 0))}</b>`) + rowKV('Price', sats(b.price)) + (b.fee != null ? rowKV('Network fee', b.vb ? `${sats(b.fee)} <span class="muted small">${esc(String(b.rate))} sat/vB × ~${b.vb} vB</span>` : sats(b.fee)) : '')
        + (b.seal ? rowKV('Comes back with the tokens', `${sats(b.seal)} <span class="muted small">on your token output</span>`) : '')
      : rowKV('You get', `<b>${sats(b.price)}</b>`) + rowKV('Network fee', 'paid by the buyer');
    const next = {
      rgbBuyPrepare: 'MASKED holds one of your bitcoin outputs for this purchase and makes an invoice for the tokens. Nothing is paid yet: you sign once the seller has prepared the swap.',
      rgbSalePrepare: 'MASKED prepares one transaction: your tokens to the buyer, the buyer\'s bitcoin to you. Nothing is sent until both of you have signed.',
      rgbBuySign: 'MASKED checked the seller\'s tokens and every output of the transaction. Your bitcoin and the tokens move together in one transaction, or not at all.',
      rgbSaleComplete: 'This signs and broadcasts the swap the buyer already signed. Your tokens go to the buyer and the bitcoin comes to your Bitcoin balance.',
      rgbInstantBuyMany: `MASKED buys these ${b?.n || ''} Instant listings one after another, cheapest first: one transaction each, the network fee is for all of them. Each is checked like a single purchase. If someone else buys one first, it's skipped and nothing is paid for it. The tokens show after one confirmation.`,
      rgbInstantBuy: 'An Instant listing: the seller signed it in advance. MASKED checks the seller\'s signature, the tokens and every output, then pays and broadcasts in one transaction. The tokens show after one confirmation. If someone else buys it first, nothing is paid.',
    }[m];
    const top = buying && b?.topUp ? `<div class="info warn"><b>Your RGB balance is too low for this.</b> Buying RGB tokens is paid from your RGB balance (${sats(b.topUp.have || 0)} free now). Add ${sats(b.topUp.sats)} from your Bitcoin balance: one transaction, ready after one block (about 10 minutes). Then come back and buy.</div>
      <button class="btn ghost wide" data-ap-topup ${b.topUp.sent || this.state.busy ? 'disabled' : ''}>${b.topUp.sent ? 'Added. Ready after one block' : `Add ${sats(b.topUp.sats)} to RGB balance`}</button>` : '';
    return `${hero}<div class="kv">${rowKV('Token', tok)}${rows}${rowKV('Network', esc(this.app.rgb.profile.label))}</div>${top}
    ${b?.newToken && buying ? '<p class="info">You don\'t hold this token yet. Check its asset ID with the issuer: anyone can give a token any name.</p>' : ''}
    <p class="info">${next}</p>${this.rgbWait(a)}${this.error(a)}`;
  }

  inscribeBody(a, P, b) {
    const fees = this.feeRows(a, b?.estimate.totalFee, b && b.estimate.totalFee + b.estimate.revealValue);
    if (P.options?.account === 'shielded') {
      return `${this.tokenAmount(P)}
          <div class="kv">${rowKV('Inscribed on', `${I.shieldPlain} Your Shielded coin`)}${b ? rowKV('That coin holds', `${b.avail.toLocaleString()} ${esc(String(P.ticker).toUpperCase())}`) : ''}${rowKV('Fee paid from', SHIELDED)}
          ${fees}</div>
          <p class="info">The tokens stay in Shielded and are listed from their own one-time address. Nothing links the listing to your Public or Shielded address. The bitcoin from the sale comes back to Shielded.</p>
          ${this.error(a)}`;
    }
    if (P.options?.account === 'trade') {
      return `${this.tokenAmount(P)}
          <div class="kv">${rowKV('Inscribed to', 'Your trade address')}${b ? rowKV('Available there', b.avail.toLocaleString()) : ''}${b ? rowKV('Fee paid from', b.from === 'shielded' ? SHIELDED : 'Trade address') : ''}
          ${fees}</div>
          <p class="info">This creates one transfer inscription the site can list or swap. The tokens stay yours until it sells.</p>
          ${this.error(a)}`;
    }
    return `${this.tokenAmount(P)}
        <div class="kv">${rowKV('Inscribed to', `${btcLogo}Your Public address`)}${rowKV('Available now', `${this.app.tokens.transferAvail(String(P.ticker).toLowerCase()).toLocaleString()}`)}
        ${fees}</div>
        <p class="info">This creates one transfer inscription the site can then list or send. Your tokens stay in your wallet until it is sold or sent.</p>
        ${this.error(a)}`;
  }

  psbtCard(p, k, total) {
    const row = (x, kind) => `<div class="pz-row ${x.ours ? 'mine' : ''} ${x.prot && x.sign ? 'danger' : ''}">
      <span class="pz-i">${kind}${x.i}</span>
      <span class="pz-a"><span class="mono">${esc(x.address ? short(x.address, 8) : x.txid ? short(x.txid, 6) + ':' + x.vout : '?')}</span>
        ${x.ours ? `<span class="badge v2">${x.keyed === 'trade' ? 'Your trade address' : x.keyed === 'shielded' ? 'Your Shielded listing' : 'You'}</span>` : ''}${x.sign ? '<span class="badge">sign</span>' : ''}${x.prot && x.sign ? `<span class="badge red">${I.lock} inscription</span>` : ''}${x.sighash ? `<span class="badge">sighash ${esc(x.sighash.map((t) => '0x' + Number(t).toString(16).padStart(2, '0')).join(', '))}</span>` : ''}${x.locked === false ? '<span class="badge red">not covered: can be changed</span>' : ''}</span>
      <span class="pz-v">${x.value != null ? fmtBtc(x.value) : '?'}</span></div>`;
    return `<div class="pz">
    ${total > 1 ? `<p class="card-title">PSBT ${k + 1} of ${total}</p>` : ''}
    <p class="lbl">Inputs</p>${p.inputs.map((x) => row(x, 'in ')).join('')}
    <p class="lbl">Outputs</p>${p.outputs.map((x) => row(x, 'out ')).join('')}
    <div class="kv">${rowKV('Your balance change', `<b class="${p.net < 0 ? 'neg' : 'good'}">${p.net > 0 ? '+' : ''}${fmtBtc(p.net)} ${this.unit}</b>`)}${rowKV('Inputs you sign', `${p.toSign.length}`)}</div>
    ${p.changeableOurs ? `<p class="info warn">${fmtBtc(p.changeableOurs)} ${this.unit} shown going back to you is in outputs your signature doesn't cover. The site can change them, so they are left out of the balance change.</p>` : ''}
    ${p.net < 0 && -p.net >= 100000 && -p.net >= 0.5 * sumSats(this.app.coins.public) ? `<p class="info warn">This takes <b>${Math.round((-p.net / Math.max(1, sumSats(this.app.coins.public))) * 100)}%</b> of your Public balance. Make sure you know this site.</p>` : ''}
  </div>`;
  }
}
