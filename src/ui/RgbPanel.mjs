import { esc, fmtBtc } from '../core/format.mjs';
import { head } from './html.mjs';

/** Small native sections reused by Home, Settings, Receive and Send. */
export class RgbPanel {
  static status(r) { return r.message ? `<p class="msg" role="status">${esc(r.message)}</p>` : ''; }
  static button(r, action, label, primary = false) { return `<button class="btn ${primary ? 'primary' : 'ghost'} wide" data-rgb="${action}" ${r.busy ? 'disabled' : ''}>${label}</button>`; }
  static input(r, key, label, extra = '') { return `<label class="field"><span>${label}</span><input data-rgb-field="${key}" value="${esc(r.fields[key])}" autocomplete="off" ${extra}></label>`; }
  static home(app) {
    const r = app.rgb;
    if (!r.available) return '';
    return `<section class="card"><h2>RGB assets <small class="muted">Utexo test network</small></h2>${r.ready ? `
      ${r.assets().map(a => `<div class="menu-row"><span><b>${esc(a.ticker || a.name || 'RGB asset')}</b><small class="muted"> · Public RGB</small></span><span>${esc(String(a.balance?.settled ?? '—'))}</span></div><div class="actions"><button class="btn ghost sm" data-rgb-go="receive" data-asset="${esc(a.assetId || '')}">Receive</button><button class="btn ghost sm" data-rgb-go="send" data-asset="${esc(a.assetId || '')}">Send</button></div>`).join('') || '<p class="muted small">No RGB assets yet.</p>'}
      <div class="actions"><button class="btn ghost sm" data-rgb-go="receive">Receive RGB</button><button class="btn ghost sm" data-rgb="refresh" ${r.busy ? 'disabled' : ''}>Refresh</button><button class="btn ghost sm" data-go="settings">Manage RGB</button></div>` : '<p class="muted small">Enable RGB in Settings to receive test assets.</p><button class="btn ghost wide" data-go="settings">Enable RGB</button>'}${this.status(r)}</section>`;
  }
  static settings(app) {
    const r = app.rgb;
    if (!r.available) return '';
    return `<section class="card"><h2>RGB</h2><p class="muted small">Utexo custom Signet uses a different chain from public Bitcoin Signet. Its fee address and RGB backup are separate. RGB does not use BIP352 Shielded payments.</p>${!r.ready ? `
      <label class="field"><span>RGB backup password</span><input id="rgbPassword" type="password" minlength="12" autocomplete="off" placeholder="At least 12 characters"></label>
      ${this.button(r, 'open', r.service?.exists ? 'Unlock RGB' : 'Enable RGB test assets', true)}
      <details><summary>Restore RGB backup</summary><input id="rgbRestore" type="file" accept=".json,application/json">${this.button(r, 'restore', 'Restore RGB')}</details>` : `
      <p class="small">RGB fee balance · ${fmtBtc(Number(r.data?.btc?.vanilla?.settled || 0) + Number(r.data?.btc?.colored?.settled || 0))} tBTC</p>
      <p class="mono small" style="overflow-wrap:anywhere">${esc(r.data?.address || '')}</p><button class="btn ghost sm" data-copy="${esc(r.data?.address || '')}">Copy Utexo funding address</button>
      <p class="muted small">Fund this address using /getbtc at Utexo’s faucet. Do not send public Signet coins.</p>
      ${this.input(r, 'fee', 'Fee · sat/vB', 'type="number" min="1" max="100"')}
      ${this.button(r, 'outputs', 'Prepare RGB outputs')}
      <p class="muted small">${r.service.backupRequired ? 'A fresh encrypted RGB backup is required before the next transaction.' : 'RGB backup saved.'}</p>
      ${this.button(r, 'backup', 'Export encrypted RGB backup')}${r.saved ? this.button(r, 'saved', 'I saved the file', true) : ''}
      ${this.button(r, 'close', 'Lock RGB')}`}${this.status(r)}</section>`;
  }
  static form(app, mode) {
    const r = app.rgb;
    return `${head(mode === 'receive' ? 'Receive' : 'Send')}<div class="testnet-note">RGB · Utexo custom Signet · test assets only</div><section class="card">${!r.ready ? '<p>Enable RGB in Settings first.</p><button class="btn primary wide" data-go="settings">Settings</button>' : mode === 'receive' ? `
      ${this.input(r, 'asset', 'RGB asset ID · optional for first receive')}${this.button(r, 'receive', 'Create blinded RGB invoice', true)}
      ${r.invoice ? `<p class="mono small" style="overflow-wrap:anywhere">${esc(r.invoice)}</p><button class="btn ghost wide" data-copy="${esc(r.invoice)}">Copy invoice</button>` : ''}` : r.pending ? `
      <h2>Review RGB transfer</h2><p class="mono small" style="overflow-wrap:anywhere">${esc(r.pending.amount)} base units<br>${esc(r.pending.assetId)}<br>${esc(r.pending.invoice)}</p><p>Fee: ${esc(r.pending.fee)} sat/vB</p>${this.button(r, 'confirm', 'Confirm RGB transfer', true)}${this.button(r, 'cancel', 'Back')}` : `
      ${this.input(r, 'asset', 'Exact RGB asset ID')}${this.input(r, 'amount', 'Amount · integer base units', 'inputmode="numeric"')}${this.input(r, 'recipient', 'Blinded RGB invoice')}${this.input(r, 'fee', 'Fee · sat/vB', 'type="number" min="1" max="100"')}${this.button(r, 'review', 'Review transfer', true)}`}
      <p class="muted small">RGB state needs an encrypted backup after changes. Manage backups in Settings.</p></section>${this.status(r)}<button class="btn ghost wide" data-rgb-go="btc">Back to BTC</button>`;
  }
}
