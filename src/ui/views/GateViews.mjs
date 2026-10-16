// The screens in front of the wallet: unlock, create / restore, set a password (old unencrypted wallets)
// and the recovery-phrase backup after creating a wallet.
import { NETWORKS } from '../../bitcoin/networks.mjs';
import { BIRTHDAYS } from '../../scan/ChainSync.mjs';
import { View } from '../View.mjs';
import { copyBtn, seg } from '../html.mjs';
import { $ } from '../dom.mjs';

const logoBig = () => `<div class="lk-logo">${$('.logo')?.innerHTML || ''}</div>`;
const newPasswordFields = (placeholder2 = 'Confirm password') => `<input type="password" id="pwNew1" placeholder="New password (min 8 characters)" autocomplete="new-password">
    <input type="password" id="pwNew2" placeholder="${placeholder2}" autocomplete="new-password">`;

export class LockView extends View {
  render() {
    const busy = this.state.busy;
    return `<section class="lk">
    ${logoBig()}
    <h1>Welcome back</h1>
    <p class="muted">Enter your password to unlock MASKED.</p>
    <input type="password" id="pwUnlock" placeholder="Password" autocomplete="current-password" autofocus>
    ${this.statusLine('lock')}
    <button class="btn primary wide" id="btnUnlock" ${busy ? 'disabled' : ''}>${busy ? 'Unlocking…' : 'Unlock'}</button>
    <button class="link small" data-forgot>Forgot password? Restore with your recovery phrase</button>
  </section>`;
  }
}

export class OnboardView extends View {
  render() {
    const { app, state } = this;
    const mode = this.f.obMode, restore = mode === 'restore';
    const replacing = !!app.vault.read() || !!state.wallet;
    const pickNet = restore ? (app.lock.savedNet() || (app.vault.read() || state.wallet ? state.net : 'main')) : state.net;
    const busy = state.busy;
    return `<section class="lk">
    ${logoBig()}
    <h1>${restore ? 'Restore wallet' : replacing ? 'New wallet' : 'Welcome to MASKED'}</h1>
    <p class="muted">${restore ? 'Enter your 12 or 24 recovery words.' : 'A Bitcoin wallet with a Shielded balance.'}</p>
    ${replacing ? '<p class="warn small">This replaces the wallet on this device. Make sure its recovery phrase is written down.</p>' : ''}
    ${seg('obMode', mode, [['create', 'Create new'], ['restore', 'Restore']])}
    <label class="field"><span class="lbl">Network</span>
      <select id="obNet">${Object.entries(NETWORKS).map(([k, n]) => `<option value="${k}" ${pickNet === k ? 'selected' : ''}>${n.name}${k === 'main' ? '' : ' (test coins)'}</option>`).join('')}</select>
      ${restore ? '<span class="muted small">Pick Mainnet to see the same address as in UniSat or other wallets. Test networks use different addresses.</span>' : ''}</label>
    ${restore ? `<label class="field"><span class="lbl">When did you first use this wallet?</span>
      <select id="obBday">${BIRTHDAYS.map(([v, l]) => `<option value="${v}" ${v === '30' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="muted small">The wallet looks for Shielded payments back to then. Public coins and tokens show right away. Coming from UniSat, Xverse or another wallet without Shielded payments? Choose "Never used".</span></label>
      <textarea id="obWords" rows="3" spellcheck="false" autocomplete="off" placeholder="recovery words separated by spaces"></textarea>
      <input id="obPass" type="password" autocomplete="off" placeholder="BIP39 passphrase (optional, most people leave this empty)">` : ''}
    ${newPasswordFields()}
    <p class="info">The password encrypts your wallet on this device. It can't be recovered, but your recovery phrase can always restore the wallet.</p>
    ${this.statusLine('onboard')}
    <button class="btn primary wide" id="btnOnboard" ${busy ? 'disabled' : ''}>${busy ? 'Encrypting…' : restore ? 'Restore wallet' : 'Create wallet'}</button>
    ${state.lockState === 'onboard-cancel' ? '<button class="btn ghost wide" data-obcancel>Cancel</button>' : ''}
  </section>`;
  }
}

export class SetPasswordView extends View {
  render() {
    const busy = this.state.busy;
    return `<section class="lk">
    ${logoBig()}
    <h1>Protect your wallet</h1>
    <p class="muted">MASKED now encrypts your wallet with a password. Set one to continue. Your coins and address stay the same.</p>
    ${newPasswordFields()}
    ${this.statusLine('onboard')}
    <button class="btn primary wide" id="btnMigrate" ${busy ? 'disabled' : ''}>${busy ? 'Encrypting…' : 'Set password'}</button>
  </section>`;
  }
}

export class BackupView extends View {
  render() {
    const words = this.app.lock.secret?.words || '';
    return `<section class="lk">
    <h1>Write down your recovery phrase</h1>
    <p class="warn small">These words are the only way to recover your wallet. Anyone who sees them can take your coins. Write them on paper and keep them offline.</p>
    <ol class="words">${words.split(' ').map((x) => `<li>${x}</li>`).join('')}</ol>
    ${copyBtn(words, 'Copy phrase')}
    <label class="risk ok-box"><input type="checkbox" data-backed ${this.f.backed ? 'checked' : ''}><span>I have written down my recovery phrase.</span></label>
    <button class="btn primary wide" id="btnBackedUp" ${this.f.backed ? '' : 'disabled'}>Continue</button>
  </section>`;
  }
}
