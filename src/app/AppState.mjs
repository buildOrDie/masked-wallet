// What the screens show and the forms hold. Domain data (coins, keys, sync progress, records) lives in the
// services; this is the UI's state: the current view, form fields, flows in progress and status lines.

/** Form fields, bound to inputs with data-bind / data-set. */
export const FORM_DEFAULTS = {
  recvKind: 'public', sendFrom: 'public', sendTo: '', sendAmount: '', fee: 'normal', feeCustom: '',
  mintTick: '', mintAmt: '', mintTo: 'self', mintOther: '', mintFrom: 'public', mintMode: 'mint',
  depTick: '', depMax: '21000000', depLim: '1000', depFrom: 'public', depResTo: 'shielded', depWho: 'self', recTick: '', recSalt: '',
  tsTick: '', tsTo: '', tsAmt: '', tsFrom: 'public', trTick: '', trAmt: '', trFrom: 'public',
  coinFilter: 'all', scanText: '', calcRecips: '', relayText: '',
  // set by the screens that use them
  homeTok: 'all', tokTab: 'history', obMode: 'create', backed: false, apRisk: false, rbfInfo: false,
};

export class AppState {
  constructor() {
    this.net = 'main';               // MASKED supports Mainnet and Signet
    /** @type {import('../wallet/Keyring.mjs').Keyring|null} */
    this.wallet = null;
    this.labels = [{ m: 1, note: 'Donations' }]; // extra Shielded addresses (BIP 352 labels)
    this.lockState = null;           // locked | onboard | onboard-cancel | migrate | backup | open
    this.obReturn = null;            // where Cancel on the onboarding screen goes back to
    this.view = 'home';
    this.tokTick = null;             // the token page on show
    this.tokFrom = null;             // the view the token page was opened from
    this.side = null;                // Public | Shielded on Home (see SidePicker)
    this.f = { ...FORM_DEFAULTS };
    this.status = {};                // status line per area: [text, cls]
    this.send = { stage: 'form' };   // form | review | done, with the built transaction
    this.mint = { stage: 'form' };
    this.busy = false;
    this.reveal = false;             // recovery phrase on show in Settings
    this.calc = null;                // output calculator result
    this.sendInputs = undefined;     // calculator rows kept across renders
  }
}

/** Public | Shielded: the side Home shows. Send, Receive and Mint start on the same side. */
export class SidePicker {
  static KEY = 'wren.side';
  static FIELDS = ['recvKind', 'sendFrom', 'mintFrom', 'trFrom', 'tsFrom', 'depFrom'];

  /** @param {import('./MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  get() {
    const state = this.app.state;
    if (!state.side) state.side = this.app.store.get(SidePicker.KEY) === 'shielded' ? 'shielded' : 'public';
    return state.side;
  }

  set(side) {
    const state = this.app.state;
    state.side = side === 'shielded' ? 'shielded' : 'public';
    this.app.store.set(SidePicker.KEY, state.side);
    for (const f of SidePicker.FIELDS) state.f[f] = state.side;
  }

  /** The address of the side on show. */
  address() {
    const account = this.app.account;
    return this.get() === 'shielded' ? account.shieldAddr() : account.pubAddr();
  }
}
