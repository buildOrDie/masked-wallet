import { esc, short } from '../../core/format.mjs';
import { toHex } from '../../core/bytes.mjs';
import * as sp from '../../crypto/sp-core.mjs';
import { ESPLORA, NETWORKS } from '../../bitcoin/networks.mjs';
import { EsploraPool } from '../../net/EsploraPool.mjs';
import { Keyring } from '../../wallet/Keyring.mjs';
import { View } from '../View.mjs';
import { I, copyBtn, rowKV } from '../html.mjs';

const { n2b } = sp.util;
const VERSION_LABEL = '2.3.3';

export class SettingsView extends View {
  /** One input of the Shielded output calculator (Advanced). */
  static inputRow(v = {}) {
    return `<div class="inrow">
    <label class="field"><span>Outpoint (txid:vout)</span><input data-f="op" class="mono" value="${esc(v.op || '')}" spellcheck="false" placeholder="txid:0"></label>
    <label class="field"><span>Type</span><select data-f="type">${[['p2tr', 'Taproot'], ['p2wpkh', 'Native SegWit'], ['p2sh', 'Nested SegWit'], ['p2pkh', 'Legacy'], ['other', 'Not eligible']].map(([k, n]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>Private key (hex or WIF)</span><input data-f="key" type="password" class="mono" value="${esc(v.key || '')}" autocomplete="off" spellcheck="false"></label>
    <button class="btn ghost sm" data-rmin>Remove input</button>
  </div>`;
  }

  render() {
    const { app, state, account } = this;
    const w = account.keys;
    const hasVault = !!app.vault.read();
    const sync = app.sync;
    const left = sync.historyLeft();
    const coinCount = app.coins.public.length + app.coins.shielded.length;
    const checkedBack = sync.progress?.nextHeight >= 0 ? `checked back to ${(sync.progress.nextHeight + 1).toLocaleString()}` : 'look further back';
    return `
    <div class="view-head"><h1>Settings</h1><span class="head-sp"></span></div>
    <section class="card menu">
      <div class="menu-row"><span>${I.globe}<b>Network</b></span>
        <select id="netSel2">${Object.entries(NETWORKS).map(([k, n]) => `<option value="${k}" ${state.net === k ? 'selected' : ''}>${n.name}</option>`).join('')}</select></div>
      ${this.phraseRows(w, hasVault)}
    </section>
    <section class="card menu">
      <button class="menu-row" data-replace="create"><span>${I.wallet}<b>Create new wallet</b></span><span class="chev">›</span></button>
      <button class="menu-row" data-replace="restore"><span>${I.recv}<b>Restore from phrase</b></span><span class="chev">›</span></button>
    </section>
    ${app.platform.canOpenSidePanel ? `<section class="card menu"><button class="menu-row" id="btnPanel"><span>${I.wallet}<b>Open in side panel</b></span><span class="small muted">stays open while you browse ›</span></button></section>` : ''}
    <section class="card menu">
      <button class="menu-row" data-go="activity"><span>${I.list}<b>Coins &amp; inscriptions</b></span><span class="small muted">${coinCount} coin${coinCount === 1 ? '' : 's'} ›</span></button>
      <details class="menu-det" data-k="rescan"><summary class="menu-row"><span>${I.refresh}<b>Rescan history</b></span><span class="small muted">${left ? `${left.toLocaleString()} blocks left` : checkedBack} ›</span></summary>
        <div class="det-body">
          <p class="muted small">A Shielded payment missing after a restore? Choose how far back to look. It keeps going while the wallet is open.</p>
          <div class="chips">${[['7', '1 week'], ['30', '1 month'], ['90', '3 months'], ['365', '1 year']].map(([d, l]) => `<button class="chip" data-rescan="${d}">${l}</button>`).join('')}${left ? '<button class="chip" data-rescan="stop">Stop</button>' : ''}</div>
          ${state.net === 'main' ? '<p class="muted small">Mainnet blocks are large, so long ranges take a while on public servers. Your own server (below) is much faster.</p>' : ''}
        </div></details>
    </section>
    ${this.security(hasVault)}
    ${this.statusLine('wallet')}
    ${this.sites()}
    ${this.trading()}
    ${this.servers()}
    ${this.indexer()}
    ${this.advanced(w)}
    <p class="muted small center">MASKED ${VERSION_LABEL} · keys stay in this browser</p>`;
  }

  phraseRows(w, hasVault) {
    if (!w?.mnemonic) return '';
    const reveal = this.state.reveal;
    if (!reveal && hasVault) {
      return `<details class="menu-det"><summary class="menu-row"><span>${I.eye}<b>Show recovery phrase</b></span><span class="chev">›</span></summary>
        <div class="det-body"><input type="password" id="pwReveal" placeholder="Enter your password" autocomplete="current-password">${this.statusLine('reveal')}<button class="btn primary wide" id="btnReveal">Show phrase</button></div></details>`;
    }
    return `<button class="menu-row" id="btnReveal"><span>${I.eye}<b>${reveal ? 'Hide' : 'Show'} recovery phrase</b></span><span class="chev">›</span></button>
      ${reveal ? `<div class="secret"><p class="warn small">Anyone with these words can take your coins. Never share them.</p><ol class="words">${w.mnemonic.split(' ').map((x) => `<li>${x}</li>`).join('')}</ol>${copyBtn(w.mnemonic, 'Copy phrase')}</div>` : ''}`;
  }

  security(hasVault) {
    if (!hasVault) return '';
    const mins = this.app.vault.autoLockMins();
    return `<section class="card menu">
    <button class="menu-row" data-lock-now><span>${I.lock}<b>Lock now</b></span><span class="chev">›</span></button>
    <div class="menu-row"><span>${I.lock}<b>Auto-lock after</b></span>
      <select id="autoLockSel">${[5, 15, 30, 60, 240].map((m) => `<option value="${m}" ${mins === m ? 'selected' : ''}>${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join('')}</select></div>
    <details class="menu-det"><summary class="menu-row"><span>${I.gear}<b>Change password</b></span><span class="chev">›</span></summary>
      <div class="det-body">
        <input type="password" id="pwOld" placeholder="Current password" autocomplete="current-password">
        <input type="password" id="pwNew1" placeholder="New password (min 8 characters)" autocomplete="new-password">
        <input type="password" id="pwNew2" placeholder="Confirm new password" autocomplete="new-password">
        ${this.statusLine('pw')}
        <button class="btn primary wide" id="btnChangePw">Change password</button>
      </div>
    </details>
  </section>`;
  }

  sites() {
    if (!this.app.platform.hasExt) return '';
    const list = Object.entries(this.app.sites.sites || {});
    return `<section class="card menu">
    <div class="menu-row"><span>${I.globe}<b>Connected sites</b></span><span class="muted small">${list.length}</span></div>
    ${list.length ? list.map(([o]) => `<div class="site-row"><span class="mono small">${esc(o)}</span><button class="btn ghost sm" data-unsite="${esc(o)}">Disconnect</button></div>`).join('') : '<p class="muted small pad">No sites connected. dApps use <span class="mono">window.masked</span> to ask.</p>'}
  </section>`;
  }

  trading() {
    const trade = this.app.trade;
    if (!trade.on) return '';
    const k = trade.current();
    return `<section class="card menu">
    <div class="menu-row"><span>${I.shieldPlain}<b>Private trading</b></span><span class="muted small">On</span></div>
    <p class="muted small pad">Sites you allowed trade from this private address. It is made from your recovery phrase, not linked to your Public or Shielded address, and renewed each time you move everything back to Shielded.</p>
    <div class="kv small">${rowKV('Trade address', `<a class="mono" href="${esc(this.account.explorer.address(k.address))}" target="_blank" rel="noopener">${esc(short(k.address, 8))}</a>`)}${rowKV('Number', `#${k.index + 1}`)}</div>
  </section>`;
  }

  servers() {
    const { app, state } = this;
    const servers = app.servers, scan = app.scanServer;
    const c = servers.custom();
    const active = servers.active || servers.base();
    const scanUrl = scan.url(), def = scan.defaultUrl;
    return `<section class="card menu">
    <div class="menu-row"><span>${I.globe}<b>Blockchain server</b></span><span class="small muted">${esc(EsploraPool.hostOf(active))}</span></div>
    <div class="det-body">
      <input id="srvUrl" class="mono" value="${esc(c)}" placeholder="Your own server (Esplora API), optional" spellcheck="false" autocomplete="off">
      <div class="row"><button class="btn primary sm" id="btnSrvSave">Save</button>${c ? '<button class="btn ghost sm" id="btnSrvOff">Use public servers</button>' : ''}</div>
      ${this.statusLine('srv')}
      <p class="lbl" style="margin-top:12px">Scan server <span class="muted small">(fast Shielded scanning)${def && scanUrl === def ? ' · MASKED default' : ''}</span></p>
      <input id="scanUrl" class="mono" value="${esc(scanUrl)}" placeholder="https://scan.example.com (optional)" spellcheck="false" autocomplete="off">
      <div class="row"><button class="btn primary sm" id="btnScanSave">Save</button>${scanUrl ? '<button class="btn ghost sm" id="btnScanOff">Turn off</button>' : ''}${def && scanUrl !== def ? '<button class="btn ghost sm" id="btnScanDefault">Use MASKED default</button>' : ''}</div>
      ${this.statusLine('scansrv')}
      <p class="muted small">A scan server sends public data for each block, and your wallet does the private check itself. Your scan key never leaves this browser.${app.scanner.fast ? ' Fast crypto (WebAssembly) is on.' : ''}</p>
      <p class="muted small">MASKED uses ${ESPLORA[state.net].map(EsploraPool.hostOf).join(' and ')}, and switches automatically if one is busy. Add your own server (for example mempool or electrs, ending in <span class="mono">/api</span>) for speed and privacy. Saved per network.</p>
    </div>
  </section>`;
  }

  indexer() {
    const u = this.app.tokenServer.url();
    const i = this.app.tokens.idx;
    return `<section class="card menu">
    <div class="menu-row"><span>${I.list}<b>BRC-20 indexer</b></span><span class="small ${i?.err ? 'neg' : 'muted'}">${u ? (i?.err ? 'offline' : i?.height ? `block ${i.height.toLocaleString()}` : '…') : 'off'}</span></div>
    <div class="det-body">
      <input id="idxUrl" class="mono" value="${esc(u)}" placeholder="https://your-indexer" spellcheck="false" autocomplete="off">
      <div class="row"><button class="btn primary sm" id="btnIdxSave">Save</button>${u ? '<button class="btn ghost sm" id="btnIdxOff">Turn off</button>' : ''}</div>
      ${this.statusLine('idx')}
      <p class="muted small">Shows reported token balances. The MASKED server compares supported balances with local OPI; transfers require separate checks. Saved per network.</p>
    </div>
  </section>`;
  }

  advanced(w) {
    const { state, account } = this;
    const r = state.calc;
    const coin = account.params.coin;
    const keys = w ? `<div class="kv small">
        ${rowKV('Wallet type', { example: 'Demo', mnemonic: 'Recovery phrase', keys: w.bSpend === null ? 'Watch-only' : 'Raw keys' }[w.source])}
        ${rowKV('Public address', `<span class="mono">${esc(short(account.pubAddr(), 8))}</span>`)}
        ${rowKV('Shielded address', `<span class="mono">${esc(short(account.shieldAddr(), 8))}</span>`)}
        ${w.source === 'mnemonic' ? rowKV('Paths', `<span class="mono">m/86'/${coin}'/0'/0/0 · m/352'/${coin}'/0'</span>`) : ''}
      </div>
      <details class="sub"><summary>Private keys</summary>
        <p class="warn small">Anyone who sees these can spend your coins.</p>
        <p class="lbl">Scan key</p><p class="mono small wrapall">${toHex(n2b(w.bScan))}</p>
        <p class="lbl">Spend key</p><p class="mono small wrapall">${w.bSpend === null ? 'Watch-only' : toHex(n2b(w.bSpend))}</p>
        ${this.app.coins.shielded.filter((c) => !c.example && w.bSpend !== null).map((c) => `<p class="lbl">Coin ${short(c.txid, 4)}:${c.vout} (import as rawtr)</p>${copyBtn(`rawtr(${Keyring.toWif(w.outputPriv(c.tweak), state.net)})`, 'Copy descriptor')}`).join('')}
      </details>` : '';
    const codec = account.codec;
    return `<details class="card adv"><summary>Advanced</summary>
      ${keys}
      <details class="sub"><summary>Extra shielded addresses (labels)</summary>
        ${state.labels.map((l) => { const la = account.address(l.m); return `<div class="label-row"><b>#${l.m} ${esc(l.note)}</b><p class="mono small wrapall">${la}</p><div class="row">${copyBtn(la)}<button class="btn ghost sm" data-dellabel="${l.m}">Remove</button></div></div>`; }).join('')}
        <div class="row2"><input id="labM" type="number" min="1" value="${Math.max(0, ...state.labels.map((l) => l.m)) + 1}"><input id="labNote" placeholder="Note, e.g. Shop"></div>
        <button class="btn ghost sm" id="btnLabel">Add label</button>
      </details>
      <details class="sub"><summary>Import raw keys</summary>
        <input id="rawScan" class="mono" spellcheck="false" autocomplete="off" placeholder="Scan private key (64 hex)">
        <input id="rawSpend" class="mono" spellcheck="false" autocomplete="off" placeholder="Spend private key or public key">
        <div class="row"><button class="btn primary sm" id="btnRaw">Load keys</button><button class="btn ghost sm" id="btnExample">Load demo wallet</button></div>
      </details>
      <details class="sub"><summary>Shielded output calculator</summary>
        <p class="muted small">Only for building a transaction in another wallet.</p>
        <div id="sendInputs">${state.sendInputs ?? SettingsView.inputRow()}</div>
        <button class="btn ghost sm" id="btnAddIn">Add input</button>
        <textarea data-bind="calcRecips" rows="2" class="mono" spellcheck="false" placeholder="Shielded addresses, one per line">${esc(this.f.calcRecips)}</textarea>
        <button class="btn primary sm" id="btnCalc">Work out outputs</button>
        ${r?.err ? `<p class="msg err">${esc(r.err)}</p>` : ''}
        ${r?.out ? r.out.map((o) => `<p class="mono small wrapall">${codec.trAddress(o.output)}</p>${copyBtn(codec.trAddress(o.output))}`).join('') + '<p class="warn small">If any input changes, work the outputs out again.</p>' : ''}
      </details>
    </details>`;
  }
}
