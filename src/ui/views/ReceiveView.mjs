import { esc } from '../../core/format.mjs';
import { View } from '../View.mjs';
import { I, addrChunks, btcLogo, head, qrSvg, seg, shieldLogo } from '../html.mjs';

/** Receive: the Public or Shielded address as text and QR code. */
export class ReceiveView extends View {
  /** Claim your @ (or the claimed @handle) on the Shielded side. */
  handleButton() {
    const mine = this.app.handles.mine(this.account.id);
    if (mine && mine.address === this.account.shieldAddr().toLowerCase()) return `<button class="xh-banner on" data-go="xclaim">${I.x}<span><b>@${esc(mine.handle)}</b><small>Anyone with MASKED can pay your @handle</small></span><span class="chev">›</span></button>`;
    return `<button class="xh-banner" data-go="xclaim">${I.x}<span><b>Get paid with your @handle</b><small>Post your address once. Still private.</small></span><span class="new">New</span><span class="chev">›</span></button>`;
  }

  render() {
    const { account } = this;
    const kind = this.f.recvKind;
    const a = kind === 'shielded' ? account.shieldAddr() : account.pubAddr();
    if (!a) return `${head('Receive')}<section class="card"><p class="muted">This wallet has no ${kind} address.</p></section>`;
    const info = kind === 'shielded'
      ? 'For wallets that support <b>silent payments</b>. Each payment lands somewhere new, so nobody can link them to you.'
      : 'For exchanges, faucets and any Bitcoin wallet. Payments here are <b>public</b>.';
    return `
    ${head('Receive')}
    ${seg('recvKind', kind, [['public', 'Public'], ['shielded', `${I.shieldPlain} Shielded`]])}
    ${kind === 'shielded' && !account.isTest ? this.handleButton() : ''}
    <section class="card receive ${kind}">
      <div class="recv-badge">${kind === 'shielded' ? `${shieldLogo}<b>Shielded address</b>` : `${btcLogo}<b>Public address</b>`}</div>
      <div class="qr-wrap">${qrSvg(a)}</div>
      <p class="addr mono">${addrChunks(a)}</p>
      <button class="btn primary wide" data-copy="${esc(a)}">${I.copy}<span>Copy address</span></button>
      <p class="info">${info}</p>
      ${account.isTest ? `<p class="info warn">${account.params.name} only. Never send real bitcoin here.</p>` : ''}
    </section>
    <button class="link-row" data-go="relay">${I.lock}<span><b>Got a signed payment?</b> Send it to the network</span><span class="chev">›</span></button>`;
  }
}
