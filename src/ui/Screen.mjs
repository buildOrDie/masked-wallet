// Puts the current view on the page (#view), plus the header and the bottom navigation. A render keeps
// open <details>, the focused input and its caret, so re-rendering while typing is safe.
import { esc, short } from '../core/format.mjs';
import { I } from './html.mjs';
import { CoinList, TokenList } from './Lists.mjs';
import { HomeView } from './views/HomeView.mjs';
import { ReceiveView } from './views/ReceiveView.mjs';
import { RelayView } from './views/RelayView.mjs';
import { SendView } from './views/SendView.mjs';
import { MintView } from './views/MintView.mjs';
import { TokenView } from './views/TokenView.mjs';
import { ActivityView } from './views/ActivityView.mjs';
import { AccountsView } from './views/AccountsView.mjs';
import { LeafView } from './views/LeafView.mjs';
import { SettingsView } from './views/SettingsView.mjs';
import { ApproveView } from './views/ApproveView.mjs';
import { BackupView, LockView, OnboardView, SetPasswordView } from './views/GateViews.mjs';

export const NAV = [['home', 'Wallet', I.wallet], ['mint', 'Mint', I.mint], ['settings', 'Settings', I.gear]];
import { $, $$ } from './dom.mjs';

export class Screen {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.coins = new CoinList(app);
    this.tokens = new TokenList(app);
    this.views = {
      approve: new ApproveView(app), home: new HomeView(app), token: new TokenView(app), receive: new ReceiveView(app), relay: new RelayView(app),
      send: new SendView(app, 'send'), shield: new SendView(app, 'shield'), activity: new ActivityView(app), mint: new MintView(app), settings: new SettingsView(app), accounts: new AccountsView(app), leaf: new LeafView(app),
    };
    // screens in front of the wallet, by lock state
    this.gates = { locked: new LockView(app), onboard: new OnboardView(app), 'onboard-cancel': new OnboardView(app), migrate: new SetPasswordView(app), backup: new BackupView(app) };
    this.rendered = null;
    this.toastTimer = null;
  }

  view(name) { return this.views[name]; }

  /** Which nav tab a view belongs to. */
  navOf(v) {
    const { state } = this.app;
    const n = ['receive', 'send', 'shield', 'relay', 'accounts', 'leaf'].includes(v) ? 'home'
      : v === 'token' || (v === 'mint' && (state.f.mintMode === 'send' || state.f.mintMode === 'transfer')) ? (state.tokFrom || 'home') : v;
    return n === 'activity' ? 'settings' : n;
  }

  render() {
    const app = this.app, state = app.state, account = app.account;
    // the calculator's input rows are typed into directly: keep them across renders
    if ($('#sendInputs')) {
      state.sendInputs = $$('#sendInputs .inrow').map((r) => SettingsView.inputRow({ op: r.querySelector('[data-f=op]').value, type: r.querySelector('[data-f=type]').value, key: r.querySelector('[data-f=key]').value })).join('');
    }
    const dkey = (d) => d.dataset.k || d.querySelector('summary')?.textContent.trim() || '';
    const open = new Set($$('#view details').filter((d) => d.open).map(dkey));
    const active = /** @type {any} */ (document.activeElement);
    const focus = active?.dataset?.bind;
    const caret = focus ? active.selectionStart : null;
    const gate = this.gates[state.lockState];
    const prev = this.rendered;
    $('#view').innerHTML = gate ? gate.render() : this.views[state.view].render();
    if (prev === state.view) $$('#view details').forEach((d) => { if (open.has(dkey(d))) d.open = true; });
    else window.scrollTo(0, 0);
    this.rendered = state.view;
    if (focus) { const el = $(`[data-bind="${focus}"]`); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch {} } }
    $('#netChip').textContent = account.params.name;
    $('#netChip').className = `net-chip ${account.isTest ? 'test' : 'main'}`;
    this.header(gate);
    $('#nav').style.display = gate || state.view === 'approve' ? 'none' : '';
    $('#lockBtn').hidden = !!gate || !app.vault.read();
    const pb = $('#panelBtn'); if (pb) pb.hidden = !app.platform.canOpenSidePanel || state.view === 'approve';
    app.sites.publishPublic();
    app.trade.publish();
    $('#nav').innerHTML = NAV.map(([k, n, ic]) => `<button data-go="${k}" class="${this.navOf(state.view) === k ? 'on' : ''}">${ic}<span>${n}</span></button>`).join('');
    app.store.set('wren.view', this.navOf(state.view));
  }

  /** The address of the side on show (tap to copy); words when there is no open wallet. */
  header(gate) {
    const { state, account, side } = this.app;
    const addr = !gate && account.keys && state.view !== 'approve' ? side.address() : '';
    const sh = side.get() === 'shielded';
    const keys = account.keys, multi = keys?.source === 'mnemonic' && keys.rootFp;
    const name = multi ? this.app.accounts.name(keys.rootFp, keys.index) : '';
    $('#acctShort').innerHTML = addr
      ? `${multi ? `<button class="acct-name" data-go="accounts" title="Switch account"><span>${esc(name)}</span>${I.chev}</button>` : ''}<button class="acct-addr ${sh ? 'sh' : ''}" data-copy="${esc(addr)}" title="Copy your ${sh ? 'Shielded' : 'Public'} address">${sh ? I.shieldPlain : ''}<span>${esc(short(addr, 6))}</span>${I.copy}</button>`
      : esc(gate ? (state.lockState === 'locked' ? 'Locked' : 'Set up') : account.keys ? (account.keys.source === 'example' ? 'Demo wallet' : 'Account 1') : 'No wallet');
  }

  toast(text, ms = 1400) {
    const t = $('#toast');
    t.textContent = text; t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
}
