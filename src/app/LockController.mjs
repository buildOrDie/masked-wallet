// Opening and closing the wallet: first run (create / restore), unlock, auto-lock, password changes,
// showing the recovery phrase, and the move of old unencrypted wallets into the vault.
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { isNetwork } from '../bitcoin/networks.mjs';
import { Keyring } from '../wallet/Keyring.mjs';
import { Session, Vault } from '../wallet/Vault.mjs';

import { $ } from '../ui/dom.mjs';
const NET_KEY = 'wren.net';

export class LockController {
  /** @param {import('./MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.vault = app.vault;
    this.session = new Session(app.platform, app.vault);
    this.secret = null;     // { words, passphrase, fresh, restored, birthday } while unlocked
    this.started = false;
    this.lastActive = 0;
    this.lastTouch = 0;
  }

  get state() { return this.app.state; }

  savedNet() { const n = this.app.store.get(NET_KEY); return isNetwork(n) ? n : ''; }

  /** Load a decrypted secret into memory as the active wallet. */
  useSecret(secret) {
    const { state, store } = this.app;
    const saved = store.get(NET_KEY);
    if (isNetwork(saved)) state.net = saved;
    if (!store.get(NET_KEY) && secret.net && isNetwork(secret.net)) state.net = secret.net;
    if (!isNetwork(store.get(NET_KEY))) store.set(NET_KEY, state.net); // the lock screen and restore use it
    this.secret = { words: secret.words, passphrase: secret.passphrase || '', fresh: !!secret.fresh, restored: !!secret.restored, birthday: secret.birthday || null };
    // the account that was open last (Account 1 for a new or restored phrase)
    const fp = Keyring.root(secret.words, secret.passphrase || '').fingerprint.toString(16).padStart(8, '0');
    state.wallet = this.app.accountKeys(secret.words, secret.passphrase || '', state.net, this.app.accounts.active(fp));
    this.app.loadWalletData();
  }

  startWallet() {
    const app = this.app, state = this.state;
    state.lockState = 'open';
    this.lastActive = Date.now();
    if (this.started) { app.render(); app.sync.run(6); return; }
    this.started = true;
    if (app.platform.requestId && app.platform.hasExt) app.approvals.load();
    app.sites.loadSites().then(() => app.render());
    app.render();
    app.sync.run(6);
    setInterval(() => { if (state.lockState === 'open' && !app.sync.syncing && document.visibilityState === 'visible') app.sync.run(4); }, 60000);
  }

  async lockNow() {
    await this.session.clear();
    Keyring.forgetRoot();
    this.state.wallet = null; this.secret = null;
    location.reload(); // drops every key from memory
  }

  /** Keep the session alive while the wallet is used (at most every 30 s). */
  touch() {
    if (this.state.lockState !== 'open') return;
    this.lastActive = Date.now();
    if (Date.now() - this.lastTouch > 30000 && this.secret) { this.lastTouch = Date.now(); this.session.set(this.secret); }
  }

  refreshSession() { if (this.secret) this.session.set(this.secret); }

  /** Activity tracking and the auto-lock timer. */
  watch(doc = document) {
    ['click', 'keydown'].forEach((ev) => doc.addEventListener(ev, () => this.touch(), true));
    setInterval(() => {
      if (this.state.lockState === 'open' && this.vault.read() && Date.now() - (this.lastActive || 0) > this.vault.autoLockMins() * 60000) this.lockNow();
    }, 15000);
  }

  async boot() {
    const app = this.app, state = this.state;
    const vault = this.vault.read(), legacy = this.vault.readLegacy();
    if (vault) {
      const s = await this.session.get();
      if (s?.words && s.expires > Date.now()) { this.useSecret(s); await this.session.set(this.secret); this.startWallet(); return; }
      await this.session.clear();
      const n = app.store.get(NET_KEY); if (isNetwork(n)) state.net = n; // the lock screen shows the wallet's network
      state.lockState = 'locked';
    } else if (legacy) {
      this.useSecret(legacy);
      state.lockState = 'migrate';
    } else {
      state.lockState = 'onboard';
      state.f.obMode = 'create';
    }
    app.render();
    setTimeout(() => $('#pwUnlock')?.focus(), 50);
  }

  async unlock() {
    const app = this.app, state = this.state;
    const pw = $('#pwUnlock')?.value || '';
    state.busy = true; state.status.lock = null; app.render();
    try {
      const secret = await this.vault.open(pw);
      this.useSecret(secret);
      await this.session.set(this.secret);
      state.busy = false;
      this.startWallet();
    } catch (e) { state.busy = false; state.status.lock = [e.message, 'err']; app.render(); $('#pwUnlock')?.focus(); }
  }

  async onboard() {
    const app = this.app, state = this.state;
    const p1 = $('#pwNew1').value, p2 = $('#pwNew2').value;
    try {
      let secret;
      if (state.f.obMode === 'restore') {
        const words = ($('#obWords').value || '').trim().toLowerCase().split(/\s+/).join(' ');
        if (!validateMnemonic(words, wordlist)) throw new Error('That recovery phrase is not valid. Check spelling and word count.');
        Vault.checkNewPassword(p1, p2);
        const days = Number($('#obBday')?.value);
        secret = { words, passphrase: $('#obPass').value || '', fresh: days === 0, restored: true, birthday: days > 0 ? Date.now() - days * 864e5 : days === 0 ? Date.now() : null };
      } else {
        Vault.checkNewPassword(p1, p2);
        secret = { words: generateMnemonic(wordlist, 128), passphrase: '', fresh: true, birthday: Date.now() };
      }
      const pickNet = $('#obNet')?.value;
      if (isNetwork(pickNet)) { state.net = pickNet; app.store.set(NET_KEY, pickNet); }
      state.busy = true; state.status.onboard = null; app.render();
      await this.vault.seal(secret, p1);
      await this.session.clear();
      this.useSecret(secret);
      app.resetWallet();
      await this.session.set(this.secret);
      state.busy = false;
      if (secret.fresh && state.f.obMode !== 'restore') { state.lockState = 'backup'; state.f.backed = false; app.render(); }
      else { state.view = 'home'; this.startWallet(); }
    } catch (e) { state.busy = false; state.status.onboard = [e.message, 'err']; app.render(); }
  }

  /** Old unencrypted wallets: seal them with a new password. */
  async migrate() {
    const app = this.app, state = this.state;
    const p1 = $('#pwNew1').value, p2 = $('#pwNew2').value;
    try {
      Vault.checkNewPassword(p1, p2);
      state.busy = true; app.render();
      await this.vault.seal(this.secret, p1);
      await this.session.set(this.secret);
      state.busy = false;
      app.toast('Wallet encrypted');
      this.startWallet();
    } catch (e) { state.busy = false; state.status.onboard = [e.message, 'err']; app.render(); }
  }

  async changePassword() {
    const state = this.state;
    try {
      const secret = await this.vault.open($('#pwOld').value);
      Vault.checkNewPassword($('#pwNew1').value, $('#pwNew2').value);
      await this.vault.seal(secret, $('#pwNew1').value);
      state.status.pw = ['Password changed.', 'ok'];
    } catch (e) { state.status.pw = [e.message, 'err']; }
    this.app.render();
  }

  /** Settings → Show recovery phrase (asks for the password when there is a vault). */
  async reveal() {
    const state = this.state;
    if (state.reveal) { state.reveal = false; return this.app.render(); }
    try {
      if (this.vault.read()) await this.vault.open($('#pwReveal')?.value || '');
      state.reveal = true; state.status.reveal = null;
    } catch (e) { state.status.reveal = [e.message, 'err']; }
    return this.app.render();
  }
}
