import { RgbReceive } from './RgbViews.mjs';
import { esc } from '../../core/format.mjs';
import { View } from '../View.mjs';
import { I, addrChunks, btcLogo, head, qrSvg, seg, shieldLogo } from '../html.mjs';

/** Receive: the Public or Shielded address as text and QR code. */
export class ReceiveView extends View {
  /** A ready post with the Shielded address, opened in X. */
  static shareUrl(addr) {
    const text = `Pay me privately 🎭\n\n${addr}\n\nSilent payments on Bitcoin, via @masked_wallet\nmaskedwallet.com`;
    return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  }

  render() {
    const { account } = this;
    const rgb = this.app.rgb.available;
    const kind = this.f.recvKind === 'rgb' && !rgb ? 'public' : this.f.recvKind;
    const tabs = seg('recvKind', kind, [['public', 'Public'], ['shielded', `${I.shieldPlain} Shielded`], ...(rgb ? [['rgb', 'RGB']] : [])]);
    if (kind === 'rgb') return `${head('Receive')}${tabs}${RgbReceive.render(this.app)}`;
    const a = kind === 'shielded' ? account.shieldAddr() : account.pubAddr();
    if (!a) return `${head('Receive')}<section class="card"><p class="muted">This wallet has no ${kind} address.</p></section>`;
    const info = kind === 'shielded'
      ? 'For wallets that support <b>silent payments</b>. Each payment lands somewhere new, so nobody can link them to you.'
      : 'For exchanges, faucets and any Bitcoin wallet. Payments here are <b>public</b>.';
    return `
    ${head('Receive')}
    ${tabs}
    <section class="card receive ${kind}">
      <div class="recv-badge">${kind === 'shielded' ? `${shieldLogo}<b>Shielded address</b>` : `${btcLogo}<b>Public address</b>`}</div>
      <div class="qr-wrap">${qrSvg(a)}</div>
      <p class="addr mono">${addrChunks(a)}</p>
      <button class="btn primary wide" data-copy="${esc(a)}">${I.copy}<span>Copy address</span></button>
      ${kind === 'shielded' && !account.isTest ? `<a class="btn ghost wide" href="${ReceiveView.shareUrl(a)}" target="_blank" rel="noopener">${I.x}<span>Share on X</span></a>` : ''}
      <p class="info">${info}</p>
      ${account.isTest ? `<p class="info warn">${account.params.name} only. Never send real bitcoin here.</p>` : ''}
    </section>
    <button class="link-row" data-go="relay">${I.lock}<span><b>Got a signed payment?</b> Send it to the network</span><span class="chev">›</span></button>`;
  }
}
