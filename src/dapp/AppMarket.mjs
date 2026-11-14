// The phone app's Market tab: MASKED's website (RGB market and Launchpad) inside the app, connected to this wallet the
// way the Chrome extension connects it. The site runs in a frame and asks through postMessage (its app provider,
// web/lib/masked-app.mjs); only MASKED's own sites are answered, and only from that frame. Requests are checked by the
// same code as the extension's (requests.mjs), and anything that needs a key opens the usual approval screen.
import { makeHandler, err } from './requests.mjs';
import { tr } from '../i18n/translate.mjs';

/** Where the Market tab opens, by network. */
export const MARKET_SITES = { signet: 'https://signet.maskedwallet.com', main: 'https://maskedwallet.com' };
/** The sites the app answers (the extension answers any site the person connects; the app frame only shows these). */
export const APP_SITES = new Set(['https://maskedwallet.com', 'https://www.maskedwallet.com', 'https://signet.maskedwallet.com']);
export const MARKET_PAGES = [['rgb', 'Market'], ['launch', 'Launchpad']];
export const TO_APP = 'masked-app';
export const TO_SITE = 'masked-site';
const SITES_KEY = 'masked.app.sites';

export class AppMarket {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    /** @type {Map<string, { origin: string, method: string, params: any, resolve: (v: any) => void, reject: (e: any) => void }>} */
    this.pending = new Map();
    this.page = 'rgb';
    this.box = null; this.frame = null;
    this.loaded = '';      // the address the frame was opened at
    this.siteOrigin = '';  // the site that last asked (where events go)
    this.lastPub = '';
    this.handle = makeHandler({
      getPublic: async () => this.pub(),
      getTrade: async () => this.tradeInfo(),
      getSites: async () => this.sites(),
      setSites: async (s) => this.app.store.setJson(SITES_KEY, s),
      openApproval: (origin, method, params) => this.openApproval(origin, method, params),
      emitTo: (origin, event, data) => this.emit(origin, event, data),
    });
  }

  get on() { return this.app.platform.isApp; }

  /** What sites see of the open wallet: the Public account (as the extension shares it). null when locked or demo. */
  pub() {
    const { account, state } = this.app;
    if (state.lockState !== 'open' || !account.keys || account.keys.source === 'example') return null;
    const f = account.funding();
    if (!f) return null;
    return { net: account.net, address: f.address, publicKey: '02' + f.internalX, xonly: f.internalX, shieldedAddress: account.shieldAddr() };
  }

  tradeInfo() {
    const t = this.app.trade;
    try { return t.on && this.app.account.keys ? t.info() : null; } catch { return null; }
  }

  sites() { return this.app.store.getJson(SITES_KEY, {}) || {}; }

  /** Listen for the site's requests. */
  attach(win = window) {
    if (!this.on) return;
    win.addEventListener('message', (e) => { this.onMessage(e); });
    this.app.platform.local = (m) => this.local(m);
  }

  /** A request from the site in the frame. Anything else (other frames, other sites, other shapes) is ignored. */
  async onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow || !APP_SITES.has(e.origin)) return;
    const d = e.data;
    if (!d || d.target !== TO_APP || typeof d.id !== 'string' || d.id.length > 100 || typeof d.method !== 'string') return;
    this.siteOrigin = e.origin;
    const reply = (msg) => { try { e.source.postMessage({ target: TO_SITE, id: d.id, ...msg }, e.origin); } catch {} };
    try {
      const params = d.params && typeof d.params === 'object' ? d.params : {};
      reply({ result: await this.handle(e.origin, d.method, params) });
    } catch (x) {
      reply({ error: { code: x?.code ?? 4000, message: x?.message || String(x) } });
    }
  }

  /** Show the approval screen for one request; settles when the person approves or rejects it. */
  openApproval(origin, method, params) {
    if (this.pending.size) return Promise.reject(err(4001, 'Another request is open in MASKED. Finish it first.'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, { origin, method, params, resolve, reject });
      const { app } = this;
      app.platform.requestId = id;
      app.approvals.active = null; app.approvals.port = null;
      app.state.view = 'approve';
      app.state.status.approve = null;
      app.approvals.load();
    });
  }

  /** The approval screen's messages (the extension sends these to its background). */
  async local(m) {
    if (m?.type === 'getRequest') {
      const p = this.pending.get(m.id);
      return p ? { origin: p.origin, method: p.method, params: p.params } : null;
    }
    if (m?.type === 'resolveRequest') {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(err(m.error.code ?? 4001, m.error.message || 'User rejected the request.'));
        else p.resolve(m.result);
      }
      this.backToSite();
      return true;
    }
    return null;
  }

  /** After an approval: back to the site, where it carries on. */
  backToSite() {
    const { app } = this;
    app.platform.requestId = null;
    app.approvals.active = null;
    if (app.state.view === 'approve') app.state.view = 'market';
    app.render();
  }

  /** The person left the approval screen without answering (Back, another tab): that's a no. */
  rejectOpen(message = 'User rejected the request.') {
    for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(err(4001, message)); }
    this.app.platform.requestId = null;
    this.app.approvals.active = null;
  }

  emit(origin, event, data) {
    if (!this.frame?.contentWindow || origin !== this.siteOrigin) return;
    try { this.frame.contentWindow.postMessage({ target: TO_SITE, event, data }, origin); } catch {}
  }

  /** The address the frame opens for this network and page. */
  url(net = this.app.state.net, page = this.page) {
    return `${MARKET_SITES[net] || MARKET_SITES.signet}/${page}?app=masked`;
  }

  /** After every render: show the market on its tab, keep connected sites up to date, drop a request left behind. */
  sync() {
    if (!this.on) return;
    const { state } = this.app;
    const gate = ['locked', 'onboard', 'onboard-cancel', 'migrate', 'backup'].includes(state.lockState);
    if (this.pending.size && state.view !== 'approve' && !gate) this.rejectOpen();
    const show = state.view === 'market' && !gate;
    if (show) this.show(); else if (this.box) this.box.hidden = true;
    // account changes reach the site, as in the extension
    const p = this.pub(), key = p ? `${p.net}:${p.address}` : '';
    if (key !== this.lastPub) {
      const before = this.lastPub; this.lastPub = key;
      if (before && this.siteOrigin && this.sites()[this.siteOrigin]) this.emit(this.siteOrigin, 'accountsChanged', p ? [p.address] : []);
    }
  }

  show() {
    const doc = document;
    if (!this.box) {
      const box = doc.createElement('section');
      box.id = 'market';
      box.className = 'market';
      box.innerHTML = `<div class="market-bar"><div class="seg" role="radiogroup">${MARKET_PAGES.map(([k, l]) => `<button role="radio" data-market-page="${k}">${tr(l)}</button>`).join('')}</div>
        <button class="icon-btn" data-market-reload title="${tr('Reload')}" aria-label="${tr('Reload')}"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></svg></button></div>
        <p class="market-note" hidden></p>
        <iframe title="MASKED market" referrerpolicy="no-referrer" allow="clipboard-write"></iframe>`;
      box.addEventListener('click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target).closest('button');
        if (!t) return;
        if (t.dataset.marketPage) { this.page = t.dataset.marketPage; this.open(true); }
        if (t.hasAttribute('data-market-reload')) this.open(true);
      });
      doc.body.append(box);
      this.box = box;
      this.frame = box.querySelector('iframe');
    }
    this.box.hidden = false;
    // between the wallet's header (account, network) and the tab bar
    const nav = doc.getElementById('nav'), top = doc.querySelector('header.top');
    this.box.style.top = `${Math.round(top?.getBoundingClientRect().bottom || 0)}px`;
    this.box.style.bottom = `${nav?.offsetHeight || 64}px`;
    for (const b of this.box.querySelectorAll('[data-market-page]')) b.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (b).dataset.marketPage === this.page));
    const note = this.box.querySelector('.market-note');
    const demo = !this.pub();
    note.hidden = !demo;
    note.textContent = demo ? tr('Set up or open your own wallet to connect (the demo wallet can browse only).') : '';
    this.open(false);
  }

  /** Load the market page (again when asked, or when the network changed). */
  open(force) {
    const url = this.url();
    if (!force && this.loaded && new URL(this.loaded).origin === new URL(url).origin) return;
    if (this.pending.size) return;
    this.loaded = url;
    this.siteOrigin = '';
    this.frame.src = url;
  }
}
