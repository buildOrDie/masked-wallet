import { esc, fmtBtc } from '../core/format.mjs';
import { head } from './html.mjs';
import { RGB_PROFILES } from '../rgb/config.mjs';

/** Small native sections reused by Home, Settings, Receive and Send. */
export class RgbPanel {
  static status(r) { return r.message ? `<p class="msg" role="status">${esc(r.message)}</p>` : ''; }
  static button(r, action, label, primary = false) { return `<button class="btn ${primary ? 'primary' : 'ghost'} wide" data-rgb="${action}" ${r.busy ? 'disabled' : ''}>${label}</button>`; }
  static input(r, key, label, extra = '') { return `<label class="field"><span>${label}</span><input data-rgb-field="${key}" value="${esc(r.fields[key])}" autocomplete="off" ${extra}></label>`; }
  /** Public Signet | Utexo Signet, only while RGB is locked. */
  static networks(r) {
    const cur = r.profile.id;
    return `<label class="field"><span>RGB test network</span><div class="seg" role="radiogroup">${Object.values(RGB_PROFILES).map((p) => `<button role="radio" aria-checked="${p.id === cur}" data-rgb="profile" data-rgb-arg="${p.id}" ${r.busy ? 'disabled' : ''}>${p.label}</button>`).join('')}</div></label>`;
  }
  /** Confirmed test BTC, plus anything still waiting for a block (the SDK's "future" balance). */
  static feeBalance(r) {
    const b = r.data?.btc || {};
    const sum = (k) => Number(b.vanilla?.[k] || 0) + Number(b.colored?.[k] || 0);
    const settled = sum('settled'), pending = Math.max(0, sum('future') - settled);
    return `<p class="small">RGB fee balance · ${fmtBtc(settled)} tBTC${pending ? ` <span class="muted">· +${fmtBtc(pending)} waiting for a block</span>` : ''}</p>
      ${pending && !settled ? '<p class="muted small">Received. It becomes usable after one Signet block (about 10 minutes). Then tap Refresh on Wallet.</p>' : ''}`;
  }
  static home(app) {
    const r = app.rgb;
    if (!r.available) return '';
    return `<section class="card"><h2>RGB assets <small class="muted">${esc(r.profile.label)} · test</small></h2>${r.ready ? `
      ${r.assets().map(a => `<div class="menu-row"><span><b>${esc(a.ticker || a.name || 'RGB asset')}</b><small class="muted"> · RGB</small></span><span>${esc(String(a.balance?.settled ?? '—'))}</span></div><div class="actions"><button class="btn ghost sm" data-rgb-go="receive" data-asset="${esc(a.assetId || '')}">Receive</button><button class="btn ghost sm" data-rgb-go="send" data-asset="${esc(a.assetId || '')}">Send</button></div>`).join('') || '<p class="muted small">No RGB assets yet. Create a test asset in Settings, or receive one.</p>'}
      <div class="actions"><button class="btn ghost sm" data-rgb-go="receive">Receive RGB</button><button class="btn ghost sm" data-rgb="refresh" ${r.busy ? 'disabled' : ''}>Refresh</button><button class="btn ghost sm" data-go="settings">Manage RGB</button></div>` : '<p class="muted small">Enable RGB in Settings to try test assets.</p><button class="btn ghost wide" data-go="settings">Enable RGB</button>'}${this.status(r)}</section>`;
  }
  static settings(app) {
    const r = app.rgb;
    if (!r.available) return '';
    const p = r.profile;
    const intro = p.id === 'public'
      ? 'Runs on public Bitcoin Signet, the same test network as your MASKED Signet wallet, with its own separate test keys. No USDT here: create your own test asset. RGB does not use Shielded payments.'
      : 'Utexo’s own Signet uses a different chain from public Bitcoin Signet. Its fee address and RGB backup are separate. RGB does not use Shielded payments.';
    return `<section class="card"><h2>RGB</h2><p class="muted small">${intro}</p>${!r.ready ? `
      ${this.networks(r)}
      <label class="field"><span>RGB backup password</span><input id="rgbPassword" type="password" minlength="12" autocomplete="off" placeholder="At least 12 characters"></label>
      ${this.button(r, 'open', r.exists ? 'Unlock RGB' : 'Enable RGB test assets', true)}
      <details><summary>Restore RGB backup</summary><input id="rgbRestore" type="file" accept=".json,application/json">${this.button(r, 'restore', 'Restore RGB')}</details>` : `
      ${this.feeBalance(r)}
      <p class="mono small" style="overflow-wrap:anywhere">${esc(r.data?.address || '')}</p><button class="btn ghost sm" data-copy="${esc(r.data?.address || '')}">Copy RGB funding address</button>
      <p class="muted small">${esc(p.funding)}</p>
      ${this.input(r, 'fee', 'Fee · sat/vB', 'type="number" min="1" max="100"')}
      ${this.button(r, 'outputs', 'Prepare RGB outputs')}
      <details ${r.issued ? 'open' : ''}><summary>Create a test asset</summary>
        ${this.input(r, 'ticker', 'Ticker', 'maxlength="8" placeholder="TUSDT"')}
        ${this.input(r, 'name', 'Name', 'maxlength="40" placeholder="Test USD"')}
        ${this.input(r, 'precision', 'Decimals', 'type="number" min="0" max="8"')}
        ${this.input(r, 'supply', 'Supply (whole units)', 'inputmode="numeric" placeholder="1000000"')}
        ${this.button(r, 'issue', 'Create test asset', true)}
        ${r.issued ? `<p class="small">Created <b>${esc(r.issued.ticker)}</b>. Asset ID:</p><p class="mono small" style="overflow-wrap:anywhere">${esc(r.issued.assetId)}</p><button class="btn ghost sm" data-copy="${esc(r.issued.assetId)}">Copy asset ID</button>` : '<p class="muted small">Test only, no value. Prepare RGB outputs first.</p>'}
      </details>
      <p class="muted small">${r.service?.backupRequired ? 'Something changed since your last RGB backup. Export a new one when you are done.' : 'RGB backup saved.'}</p>
      ${this.button(r, 'backup', 'Export encrypted RGB backup')}${r.saved ? this.button(r, 'saved', 'I saved the file', true) : ''}
      ${this.button(r, 'close', 'Lock RGB')}`}${this.status(r)}</section>`;
  }
  static form(app, mode) {
    const r = app.rgb;
    return `${head(mode === 'receive' ? 'Receive' : 'Send')}<div class="testnet-note">RGB · ${esc(r.profile.label)} · test assets only</div><section class="card">${!r.ready ? '<p>Enable RGB in Settings first.</p><button class="btn primary wide" data-go="settings">Settings</button>' : mode === 'receive' ? `
      ${this.input(r, 'asset', 'RGB asset ID · optional for first receive')}${this.button(r, 'receive', 'Create blinded RGB invoice', true)}
      ${r.invoice ? `<p class="mono small" style="overflow-wrap:anywhere">${esc(r.invoice)}</p><button class="btn ghost wide" data-copy="${esc(r.invoice)}">Copy invoice</button>` : ''}` : r.pending ? `
      <h2>Review RGB transfer</h2><p class="mono small" style="overflow-wrap:anywhere">${esc(r.pending.amount)} base units<br>${esc(r.pending.assetId)}<br>${esc(r.pending.invoice)}</p><p>Fee: ${esc(r.pending.fee)} sat/vB</p>${this.button(r, 'confirm', 'Confirm RGB transfer', true)}${this.button(r, 'cancel', 'Back')}` : `
      ${this.input(r, 'asset', 'Exact RGB asset ID')}${this.input(r, 'amount', 'Amount · integer base units', 'inputmode="numeric"')}${this.input(r, 'recipient', 'Blinded RGB invoice')}${this.input(r, 'fee', 'Fee · sat/vB', 'type="number" min="1" max="100"')}${this.button(r, 'review', 'Review transfer', true)}`}
      <p class="muted small">RGB state needs an encrypted backup after changes. Manage backups in Settings.</p></section>${this.status(r)}<button class="btn ghost wide" data-rgb-go="btc">Back to BTC</button>`;
  }
}
