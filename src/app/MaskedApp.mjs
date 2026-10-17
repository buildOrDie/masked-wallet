// The composition root: builds every service once, wires them to each other through `app`, and starts
// the wallet. Services reach their neighbours as `this.app.<name>`; nothing else is global.
import { WalletRgb } from '../rgb/WalletRgb.mjs';
import { BROADCAST } from '../bitcoin/networks.mjs';
import { TxPolicy, broadcastHex } from '../bitcoin/RawTransaction.mjs';
import { localStore } from '../core/LocalStore.mjs';
import { EsploraPool } from '../net/EsploraPool.mjs';
import { FeeOracle } from '../net/FeeOracle.mjs';
import { OrdChecker } from '../net/OrdChecker.mjs';
import { ScanServer } from '../net/ScanServer.mjs';
import { TokenServer } from '../net/TokenServer.mjs';
import { ChainSync } from '../scan/ChainSync.mjs';
import { ShieldedScanner } from '../scan/ShieldedScanner.mjs';
import { DeployRegistry, MintLog, PendingTransfers, TransferLog } from '../tokens/records.mjs';
import { TokenBook } from '../tokens/TokenBook.mjs';
import { TokenTx } from '../tokens/TokenTx.mjs';
import { TradeAccount } from '../trade/TradeAccount.mjs';
import { ApprovalController } from '../dapp/ApprovalController.mjs';
import { PsbtSigner } from '../dapp/PsbtSigner.mjs';
import { SiteBridge } from '../dapp/SiteBridge.mjs';
import { Account } from '../wallet/Account.mjs';
import { CoinStore } from '../wallet/CoinStore.mjs';
import { InscriptionIndex } from '../wallet/InscriptionIndex.mjs';
import { Keyring } from '../wallet/Keyring.mjs';
import { TxBuilder } from '../wallet/TxBuilder.mjs';
import { Vault } from '../wallet/Vault.mjs';
import { Controller } from '../ui/Controller.mjs';
import { NAV, Screen } from '../ui/Screen.mjs';
import { AppState, SidePicker } from './AppState.mjs';
import { LockController } from './LockController.mjs';
import { Platform } from './Platform.mjs';

export class MaskedApp {
  /** @param {{ example?: any }} [options]  example: the demo wallet's keys and transaction */
  constructor(options = {}) {
    this.example = options.example;
    this.state = new AppState();
    this.store = localStore;
    this.platform = new Platform();
    const net = () => this.state.net, store = this.store;

    // network
    this.servers = new EsploraPool({ net, store });
    this.ord = new OrdChecker({ net, store });
    this.tokenServer = new TokenServer({ net, store });
    this.scanServer = new ScanServer({ net, store });
    this.fees = new FeeOracle({ net, servers: this.servers });

    // the wallet
    this.account = new Account(this);
    this.coins = new CoinStore(this);
    this.inscriptions = new InscriptionIndex(this);
    this.scanner = new ShieldedScanner(this);
    this.sync = new ChainSync(this);
    this.builder = new TxBuilder(this);
    this.vault = new Vault(store);
    this.rgb = new WalletRgb(this);

    // tokens
    this.deploys = new DeployRegistry(this);
    this.mints = new MintLog(this);
    this.transfers = new TransferLog(this);
    this.pending = new PendingTransfers(this);
    this.tokens = new TokenBook(this);
    this.tokenTx = new TokenTx(this);

    // dApps and private trading
    this.trade = new TradeAccount(this);
    this.psbt = new PsbtSigner(this);
    this.approvals = new ApprovalController(this);
    this.sites = new SiteBridge(this);

    // screens
    this.lock = new LockController(this);
    this.side = new SidePicker(this);
    this.ui = new Screen(this);
    this.controller = new Controller(this);
  }

  render() { this.ui.render(); }
  toast(text) { this.ui.toast(text); }

  setStatus(key, text, cls = '') {
    this.state.status[key] = text ? [text, cls] : null;
    this.render();
  }

  /** The fee rate the open form picked. */
  feeRate() { return this.fees.rate(this.state.f); }

  broadcast(hex) { return broadcastHex(BROADCAST[this.state.net], hex); }

  /** Take the spent coins off at once, then read our own new outputs back from the chain. */
  async afterBroadcast(spentKeys, txids) {
    this.coins.remove(spentKeys);
    this.render();
    for (const id of txids) await this.scanner.ingestTx(id);
    await this.coins.syncPublic().catch(() => {});
    this.render();
  }

  /** After each sync with a fresh balance: the checks that never depend on the block scan. */
  afterSyncSteps() {
    return [
      () => this.trade.syncHolders(),
      () => this.coins.dropSpent(),
      () => this.ord.check(this.coins.publicThenShielded()),
      () => this.pending.check(),
      () => this.deploys.refresh(),
      () => this.mints.refresh(),
      () => this.inscriptions.readCoins(this.coins.publicThenShielded()),
      () => this.trade.recoverShieldedTransfers(),
      () => this.fees.refreshPrice(),
    ];
  }

  /** Read the open wallet's records for the current network. */
  loadWalletData() {
    this.sync.loadProgress();
    this.coins.load();
    this.tokens.resetCache();
  }

  /** A different wallet or network: drop what is on screen and load its records. */
  resetWallet() {
    const state = this.state;
    this.coins.clear();
    state.send = { stage: 'form' }; state.mint = { stage: 'form' }; state.reveal = false;
    this.loadWalletData();
  }

  /** The public demo wallet (Signet). */
  loadExample() {
    this.state.net = 'signet';
    this.state.wallet = Keyring.fromExample(this.example);
    this.coins.clear();
    this.sync.loadProgress();
  }

  setNet(n) {
    const state = this.state, keys = state.wallet;
    state.net = n;
    this.rgb.mode = ''; this.rgb.pending = null;
    this.inscriptions.reset();
    if (keys?.source === 'mnemonic') {
      const next = Keyring.fromMnemonic(keys.mnemonic, keys.passphrase, n);
      next.fresh = keys.fresh; next.birthday = keys.birthday; next.restored = keys.restored;
      state.wallet = next;
      this.store.set('wren.net', state.net);
    } else if (keys?.source === 'example') this.loadExample();
    this.resetWallet();
    this.render();
    this.sync.run(6);
  }

  /** Start: route fetches through the server pool, attach the UI, then open (or lock) the wallet. */
  /** @param {{ secpWasm: Uint8Array, initFast: (wasm: Uint8Array) => Promise<boolean> }} boot */
  start(boot) {
    const { secpWasm, initFast } = boot;
    const { platform, state } = this;
    this.servers.install(window);
    TxPolicy.load(this.store);
    initFast(secpWasm).then((ok) => { this.scanner.fast = ok; });
    this.controller.attach(document);
    setInterval(() => this.sync.watchdog(), 10000);
    if (platform.isApp || (!platform.hasExt && matchMedia('(max-width: 560px)').matches)) document.documentElement.classList.add('app');
    // Android back button: go back to the wallet home, and leave the app from there
    if (platform.isApp) window.Capacitor.Plugins?.App?.addListener?.('backButton', () => {
      if (state.view !== 'home' && !['locked', 'onboard', 'backup'].includes(state.lockState)) { state.view = 'home'; state.send = { stage: 'form' }; state.mint = { stage: 'form' }; this.render(); }
      else window.Capacitor.Plugins.App.minimizeApp?.();
    });
    this.lock.watch(document);
    this.side.set(this.side.get()); // Send, Receive and Mint start on the side picked on Home
    const v = this.store.get('wren.view');
    if (NAV.some(([k]) => k === v)) state.view = v;
    return this.lock.boot();
  }
}

