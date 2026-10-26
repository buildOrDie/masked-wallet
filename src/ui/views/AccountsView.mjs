// Switch Account: every account of the phrase with its name, Public address and path; add, rename, hide.
import { esc, short } from '../../core/format.mjs';
import { Keyring } from '../../wallet/Keyring.mjs';
import { View } from '../View.mjs';
import { I } from '../html.mjs';

export class AccountsView extends View {
  render() {
    const { app } = this, keys = this.account.keys;
    const head = (extra = '') => `<div class="view-head"><button class="icon-btn" data-go="home" aria-label="Back">${I.back}</button><h1>Switch account</h1><span class="head-sp"></span>${extra}</div>`;
    if (!keys || keys.source !== 'mnemonic') {
      return `${head()}<section class="card"><p class="muted">Several accounts need a wallet made from a recovery phrase. This wallet uses raw keys or the demo.</p></section>`;
    }
    const fp = keys.rootFp, book = app.accounts, net = this.state.net;
    const all = book.list(fp), hidden = all.filter((a) => a.hidden), showHidden = !!this.f.acctHidden;
    const rows = all.filter((a) => showHidden || !a.hidden).map((a) => {
      const k = a.i === keys.index ? keys : Keyring.fromMnemonic(keys.mnemonic, keys.passphrase, net, a.i);
      const addr = k.funding(net)?.address || '';
      const on = a.i === keys.index, menu = String(this.f.acctMenu) === String(a.i);
      return `<div class="acct-row ${on ? 'on' : ''} ${a.hidden ? 'hid' : ''}">
        <button class="acct-pick" data-acct-switch="${a.i}" aria-current="${on}">
          <span class="acct-dot">${on ? I.check : ''}</span>
          <span class="bal-txt"><b>${esc(a.name)}${a.hidden ? ' <span class="badge">hidden</span>' : ''}</b><span class="mono small">${esc(short(addr, 6))} <span class="muted">(${Keyring.paths(net, a.i).funding})</span></span></span>
        </button>
        <button class="icon-btn sm" data-set="acctMenu" data-val="${menu ? '-1' : a.i}" aria-label="More for ${esc(a.name)}" aria-expanded="${menu}">${I.dots}</button>
        ${menu ? `<div class="acct-menu">
          <label class="field"><span class="lbl">Name</span><input id="acctName" value="${esc(a.name)}" maxlength="24" autocomplete="off"></label>
          <button class="btn primary wide" data-acct-rename="${a.i}">Save name</button>
          <button class="btn ghost wide" data-copy="${esc(addr)}">${I.copy}<span>Copy Public address</span></button>
          ${a.hidden ? `<button class="btn ghost wide" data-acct-unhide="${a.i}">Show in the list</button>` : on ? '' : `<button class="btn ghost wide" data-acct-hide="${a.i}">Hide</button>`}
        </div>` : ''}
      </div>`;
    }).join('');
    return `${head(`<button class="icon-btn" data-acct-add aria-label="Add account">${I.plus}</button>`)}
    <section class="acct-list">${rows}</section>
    ${hidden.length ? `<button class="link-row" data-set="acctHidden" data-val="${showHidden ? '' : '1'}"><span>${showHidden ? 'Hide hidden accounts' : `Show hidden accounts (${hidden.length})`}</span></button>` : ''}
    <p class="info">Every account comes from your recovery phrase: same words, its own Public and Shielded addresses. Names stay on this device.</p>`;
  }
}
