import { esc, fmtBtc, short } from '../../core/format.mjs';
import { NETWORKS } from '../../bitcoin/networks.mjs';
import { TRADE_PADDING } from '../../trade/trade-core.mjs';
import { NEEDS_PREP } from '../../dapp/ApprovalController.mjs';
import { View } from '../View.mjs';
import { I, btcLogo, rowKV } from '../html.mjs';

const TITLES = { requestAccounts: 'Connect to MASKED', signMessage: 'Sign message', signPsbt: 'Sign transaction', signPsbts: 'Sign transactions', sendBitcoin: 'Send bitcoin', switchNetwork: 'Switch network', inscribeTransfer: 'Inscribe transfer', shareTrade: 'Trade from Shielded', fundTrade: 'Move BTC to trading', moveToTrade: 'Move tokens to trading', returnToShielded: 'Move back to Shielded', cancelShielded: 'Cancel listing' };
const VERBS = { requestAccounts: 'Connect', sendBitcoin: 'Send', inscribeTransfer: 'Inscribe', switchNetwork: 'Switch', shareTrade: 'Allow', fundTrade: 'Move', moveToTrade: 'Move', returnToShielded: 'Move back', cancelShielded: 'Cancel listing' };
const SHIELDED = `${I.shieldPlain} Shielded`;

/** The approval window for a dApp request: what it asks, what it costs, Reject / Approve. */
export class ApproveView extends View {
  render() {
    const a = this.app.approvals.active;
    if (!a || a.loading) return `<section class="card center"><p class="muted">Loading request…</p></section>`;
    if (a.gone) return `<section class="card center"><p>This request has expired.</p><button class="btn ghost" onclick="window.close()">Close</button></section>`;
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
        return `<p class="hero-bal center">${fmtBtc(Number(P.satoshis))} <small>${unit}</small></p>
        <div class="kv">${rowKV('To', `<span class="mono">${esc(short(P.toAddress || '', 10))}</span>`)}${rowKV('Address type', `<span class="addr-kind k-${k.kind}">${esc(k.text || '')}</span>`)}${rowKV('From', `${btcLogo}Public`)}
        ${this.feeRows(a, b?.fee, b && b.amount + b.fee)}</div>
        ${this.error(a)}`;
      }
      case 'signPsbt': case 'signPsbts': {
        if (a.prepErr) return `<p class="msg err">${esc(a.prepErr)}</p>`;
        const risky = (b || []).some((p) => p.protectedCount);
        return (b || []).map((p, k) => this.psbtCard(p, k, b.length)).join('')
          + (risky ? `<label class="risk"><input type="checkbox" data-risk ${this.f.apRisk ? 'checked' : ''}><span><b>This spends an inscription coin.</b> Only continue if you mean to sell or move that inscription (e.g. a marketplace listing).</span></label>` : '');
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
      case 'switchNetwork':
        return `<div class="kv">${rowKV('From', esc(account.params.name))}${rowKV('To', `<b>${esc(NETWORKS[P.target]?.name || P.target)}</b>`)}</div>`;
      default: return '';
    }
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
        ${x.ours ? `<span class="badge v2">${x.keyed === 'trade' ? 'Your trade address' : x.keyed === 'shielded' ? 'Your Shielded listing' : 'You'}</span>` : ''}${x.sign ? '<span class="badge">sign</span>' : ''}${x.prot && x.sign ? `<span class="badge red">${I.lock} inscription</span>` : ''}${x.sighash ? `<span class="badge">sighash ${x.sighash.join(',')}</span>` : ''}</span>
      <span class="pz-v">${x.value != null ? fmtBtc(x.value) : '?'}</span></div>`;
    return `<div class="pz">
    ${total > 1 ? `<p class="card-title">PSBT ${k + 1} of ${total}</p>` : ''}
    <p class="lbl">Inputs</p>${p.inputs.map((x) => row(x, 'in ')).join('')}
    <p class="lbl">Outputs</p>${p.outputs.map((x) => row(x, 'out ')).join('')}
    <div class="kv">${rowKV('Your balance change', `<b class="${p.net < 0 ? 'neg' : 'good'}">${p.net > 0 ? '+' : ''}${fmtBtc(p.net)} ${this.unit}</b>`)}${rowKV('Inputs you sign', `${p.toSign.length}`)}</div>
  </div>`;
  }
}
