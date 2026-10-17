import { View } from '../View.mjs';
import { I } from '../html.mjs';

/** The native wallet shell hosts the isolated RGB runtime; BTC Public/Shielded stay on Home. */
export class RgbView extends View {
  render() {
    return `<div class="view-head"><button class="back" data-go="home" aria-label="Back to wallet">${I.back || '‹'}</button><h1>RGB Signet</h1><span class="head-sp"></span></div>
      <button class="btn ghost sm wide" id="btnRgbTab">Open full wallet tab</button>
      <iframe id="rgbFrame" title="RGB Signet test wallet" src="rgb-signet.html" style="width:100%;height:880px;border:0;display:block" loading="eager"></iframe>`;
  }
}
