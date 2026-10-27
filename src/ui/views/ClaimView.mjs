import { esc } from '../../core/format.mjs';
import { claimText, payPageUrl } from '../../social/xpost.mjs';
import { View } from '../View.mjs';
import { I, head, shieldLogo } from '../html.mjs';

/** Receive → Claim your handle: post the Shielded address on X, paste the link, and people can pay your @handle. */
export class ClaimView extends View {
  static postUrl(addr) { return `https://x.com/intent/post?text=${encodeURIComponent(claimText(addr))}`; }

  /** A ready post with the pay link. */
  static shareUrl(handle) {
    const text = `Send me bitcoin privately 🎭\n\nIn @masked_wallet just type @${handle}. Or open ${payPageUrl(handle)}\n\nNobody can see what I receive.`;
    return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  }

  render() {
    const { account } = this;
    if (account.isTest) return `${head('Claim your @', 'receive')}<section class="card"><p class="muted">X handles work on Mainnet. Switch network in Settings.</p></section>`;
    const st = this.state.xclaim;
    const mine = this.app.handles.mine(account.id);
    if (st.stage === 'done' && st.post) return this.claimed(st.post, true);
    if (mine && mine.address === account.shieldAddr().toLowerCase() && st.stage !== 'again') return this.claimed(mine, false);
    const addr = account.shieldAddr();
    return `
    ${head('Claim your @', 'receive')}
    <section class="explain">${shieldLogo}<p>Your <b>Shielded address</b> is safe to post publicly: each payment lands somewhere new, so nobody can see what you receive. Post it once, and anyone with MASKED can pay you by typing your <b>@handle</b>.</p></section>
    <section class="card form claim">
      <div class="step"><span class="step-n">1</span><div><b>Post your address on X</b><p class="muted small">MASKED writes the post. Keep your address and @masked_wallet in it; change the rest if you like.</p>
        <a class="btn primary wide" href="${ClaimView.postUrl(addr)}" target="_blank" rel="noopener">${I.x}<span>Post on X</span></a></div></div>
      <div class="step"><span class="step-n">2</span><div><b>Paste the link to your post</b><p class="muted small">On X, tap Share on your post, then Copy link.</p>
        <input id="xLink" data-bind="xLink" class="mono" spellcheck="false" autocomplete="off" inputmode="url" value="${esc(this.f.xLink)}" placeholder="https://x.com/you/status/…"></div></div>
      ${this.statusLine('xclaim')}
      <button class="btn primary wide" id="btnXClaim" ${this.f.xLink.trim() ? '' : 'disabled'}>Check & claim</button>
      <p class="info">MASKED reads your post on X to check it. Delete the post and your @ stops working.</p>
    </section>`;
  }

  claimed(p, fresh) {
    return `
    ${head(fresh ? 'Claimed!' : 'Your @', 'receive')}
    <section class="card receive shielded">
      <div class="done-ic">${I.check}</div>
      <p class="hero-bal xh-big">@${esc(p.handle)}</p>
      <p class="muted">${fresh ? 'is yours. ' : ''}Anyone with MASKED can send you bitcoin by typing <b>@${esc(p.handle)}</b>. It lands in your Shielded balance.</p>
      <a class="btn primary wide" href="${ClaimView.shareUrl(p.handle)}" target="_blank" rel="noopener">${I.x}<span>Tell your followers</span></a>
      <button class="btn ghost wide" data-copy="${esc(payPageUrl(p.handle))}">${I.copy}<span>Copy pay link</span></button>
      <a class="link small" href="${esc(p.url)}" target="_blank" rel="noopener">Your post ${I.ext}</a>
      <button class="link small" data-xagain>Use a different post</button>
    </section>`;
  }
}
