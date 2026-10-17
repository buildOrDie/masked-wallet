import { RGB_SIGNET, RGB_VAULT_KEY, RGB_DIRTY_KEY, baseUnits, testFee } from './config.mjs';
import { decryptRgb, encryptRgb } from './backup.mjs';
import { b64, unb64 } from './bytes.mjs';

/** One dedicated test wallet. No MASKED mnemonic, coin store or mainnet state enters this service. */
export class SignetWallet {
  /** @param {{ loadSdk: () => Promise<any>, storage: Storage }} options */
  constructor({ loadSdk, storage }) {
    this.loadSdk = loadSdk; this.storage = storage;
    /** @type {any} */ this.wallet = null;
    this.mnemonic = ''; this.password = ''; this.busy = false;
  }
  get exists() { return !!this.storage.getItem(RGB_VAULT_KEY); }
  get backupRequired() { return this.storage.getItem(RGB_DIRTY_KEY) === '1'; }
  async exclusive(fn) {
    if (this.busy) throw new Error('Wait for the current RGB operation.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async open(password, generateMnemonic, backup = null) {
    return this.exclusive(async () => {
      if (this.wallet) throw new Error('Lock and reload before opening a wallet again.');
      if (backup && this.exists) throw new Error('Restore in a clean browser profile; do not overwrite an existing RGB wallet.');
      const saved = backup || (this.exists ? JSON.parse(this.storage.getItem(RGB_VAULT_KEY)) : null);
      const payload = saved ? await decryptRgb(saved, password) : { mnemonic: generateMnemonic() };
      // Persist encrypted keys before the SDK creates state. An init failure must never lose the seed.
      if (!saved) {
        this.storage.setItem(RGB_VAULT_KEY, JSON.stringify(await encryptRgb(payload, password)));
        this.storage.setItem(RGB_DIRTY_KEY, '1');
      }
      const sdk = await this.loadSdk();
      const wallet = new sdk.UTEXOWallet({ ...RGB_SIGNET, mnemonic: payload.mnemonic, password });
      this.wallet = wallet;
      try {
        await wallet.init();
        if (backup) {
          if (typeof payload.rgbBackup !== 'string') throw new Error('Backup does not contain RGB state.');
          await wallet.restoreFromBackupBytes(unb64(payload.rgbBackup), password);
        }
        await wallet.unlock();
        // unlock can return offline. Explicit sync must fail visibly instead of showing a zero balance.
        if (!wallet.isOnline()) await wallet.goOnline(RGB_SIGNET.indexerUrl);
        if (backup) this.storage.setItem(RGB_VAULT_KEY, JSON.stringify(await encryptRgb({ mnemonic: payload.mnemonic }, password)));
        this.mnemonic = payload.mnemonic; this.password = password;
      } catch (e) { await this.close(); throw e; }
    });
  }
  requireWallet() { if (!this.wallet || !this.mnemonic) throw new Error('Unlock the RGB Signet wallet first.'); return this.wallet; }
  async snapshot() {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      await wallet.syncWallet(); await wallet.refreshWallet();
      // Sequential: the WASM wallet has a shared RefCell and does not support overlapping calls.
      const address = await wallet.getAddress();
      const btc = await wallet.getBtcBalance();
      const groups = await wallet.listAssets();
      const transfers = await wallet.listTransfers();
      const snapshot = { address, btc, groups, transfers };
      const encoded = new TextEncoder().encode(JSON.stringify(snapshot, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      const revision = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
      const key = 'masked.rgb.signet.sync-revision';
      if (this.storage.getItem(key) !== revision) this.storage.setItem(RGB_DIRTY_KEY, '1');
      this.storage.setItem(key, revision);
      return snapshot;
    });
  }
  async mutate(fn) {
    if (this.backupRequired) throw new Error('Export a fresh encrypted backup before another transaction.');
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      // Mark before execution: even an interrupted operation may have changed RGB state.
      this.storage.setItem(RGB_DIRTY_KEY, '1');
      return fn(wallet);
    });
  }
  createUtxos(fee) { return this.mutate(wallet => wallet.createUtxos({ upTo: true, num: 4, size: 1000, feeRate: testFee(fee) })); }
  receive(assetId) {
    return this.mutate(wallet => wallet.onchainReceive({ ...(assetId ? { assetId } : {}), witness: false }));
  }
  send({ invoice, assetId, amount, fee }) {
    if (!invoice.startsWith('rgb:') || !assetId) throw new Error('Enter an RGB invoice and the exact asset ID.');
    const params = { invoice, assetId, amount: baseUnits(amount), feeRate: testFee(fee) };
    return this.mutate(async wallet => {
      const decoded = await wallet.decodeRGBInvoice({ invoice });
      // Use blinded invoices only; witness invoices require additional satoshi outputs.
      if (!decoded?.recipientId || !String(decoded.recipientId).includes('utxob:')) throw new Error('Use a blinded RGB invoice for this prototype.');
      if (!['signet', 'utexo'].includes(String(decoded.network).toLowerCase())) throw new Error('The invoice is not for Signet.');
      if (decoded.assetId && decoded.assetId !== assetId) throw new Error('Invoice asset ID does not match.');
      if (decoded.expirationTimestamp && decoded.expirationTimestamp <= Date.now() / 1000) throw new Error('This RGB invoice has expired.');
      return wallet.onchainSend(params);
    });
  }
  async backup() {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      await wallet.createBackup({ backupPath: '', password: this.password });
      const bytes = wallet.getLastBackupBytes();
      if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('The SDK did not return backup data.');
      return encryptRgb({ mnemonic: this.mnemonic, rgbBackup: b64(bytes) }, this.password);
    });
  }
  backupSaved() { this.storage.setItem(RGB_DIRTY_KEY, '0'); }
  async close() {
    const wallet = this.wallet;
    this.wallet = null; this.mnemonic = ''; this.password = '';
    if (wallet) await wallet.dispose();
  }
}
