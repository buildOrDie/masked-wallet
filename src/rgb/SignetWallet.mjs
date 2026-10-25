import { RGB_PROFILES, dirtyKey, baseUnits, testFee, newAsset } from './config.mjs';
import { decryptRgb, encryptRgb } from './backup.mjs';
import { b64, unb64 } from './bytes.mjs';

/** One dedicated test wallet per RGB network. No MASKED mnemonic, coin store or mainnet state enters this service. */
export class SignetWallet {
  /** @param {{ loadSdk: () => Promise<any>, storage: Storage, profile?: any }} options */
  constructor({ loadSdk, storage, profile = RGB_PROFILES.utexo }) {
    this.loadSdk = loadSdk; this.storage = storage; this.profile = profile;
    /** @type {any} */ this.wallet = null;
    this.mnemonic = ''; this.password = ''; this.busy = false;
  }
  get vaultKey() { return this.profile.vaultKey; }
  get dirtyKey() { return dirtyKey(this.profile); }
  get exists() { return !!this.storage.getItem(this.vaultKey); }
  get backupRequired() { return this.storage.getItem(this.dirtyKey) === '1'; }
  async exclusive(fn) {
    if (this.busy) throw new Error('Wait for the current RGB operation.');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  async open(password, generateMnemonic, backup = null) {
    const net = this.profile.id;
    return this.exclusive(async () => {
      if (this.wallet) throw new Error('Lock and reload before opening a wallet again.');
      if (backup && this.exists) throw new Error('Restore in a clean browser profile; do not overwrite an existing RGB wallet.');
      const saved = backup || (this.exists ? JSON.parse(this.storage.getItem(this.vaultKey)) : null);
      const payload = saved ? await decryptRgb(saved, password, net) : { mnemonic: generateMnemonic() };
      // Persist encrypted keys before the SDK creates state. An init failure must never lose the seed.
      if (!saved) {
        this.storage.setItem(this.vaultKey, JSON.stringify(await encryptRgb(payload, password, net)));
        this.storage.setItem(this.dirtyKey, '1');
      }
      const sdk = await this.loadSdk();
      const wallet = new sdk.UTEXOWallet({ ...this.profile.sdk, mnemonic: payload.mnemonic, password });
      this.wallet = wallet;
      try {
        await wallet.init();
        if (backup) {
          if (typeof payload.rgbBackup !== 'string') throw new Error('Backup does not contain RGB state.');
          await wallet.restoreFromBackupBytes(unb64(payload.rgbBackup), password);
        }
        await wallet.unlock();
        // unlock can return offline. Explicit sync must fail visibly instead of showing a zero balance.
        if (!wallet.isOnline()) await wallet.goOnline(this.profile.sdk.indexerUrl);
        if (backup) this.storage.setItem(this.vaultKey, JSON.stringify(await encryptRgb({ mnemonic: payload.mnemonic }, password, net)));
        this.mnemonic = payload.mnemonic; this.password = password;
      } catch (e) { await this.close(); throw e; }
    });
  }
  requireWallet() { if (!this.wallet || !this.mnemonic) throw new Error('Unlock the RGB test wallet first.'); return this.wallet; }
  /** @param {{ full?: boolean }} [o] full: also scan addresses ahead (finds coins sent to older addresses) */
  async snapshot({ full = false } = {}) {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      await wallet.syncWallet({ full }); await wallet.refreshWallet();
      // Sequential: the WASM wallet has a shared RefCell and does not support overlapping calls.
      const address = await wallet.getAddress();
      const btc = await wallet.getBtcBalance();
      const groups = await wallet.listAssets();
      // history per asset (rgb-lib lists transfers by asset)
      const transfers = {};
      for (const a of Object.values(groups || {}).flat()) if (a?.assetId) transfers[a.assetId] = await wallet.listTransfers(a.assetId);
      const snapshot = { address, btc, groups, transfers };
      const encoded = new TextEncoder().encode(JSON.stringify(snapshot, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      const revision = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
      const key = `${this.vaultKey}.sync-revision`;
      if (this.storage.getItem(key) !== revision) this.storage.setItem(this.dirtyKey, '1');
      this.storage.setItem(key, revision);
      return snapshot;
    });
  }
  // A fresh backup is reminded about (Settings shows it), not forced: these are test networks and test assets.
  async mutate(fn) {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      // Mark before execution: even an interrupted operation may have changed RGB state.
      this.storage.setItem(this.dirtyKey, '1');
      return fn(wallet);
    });
  }
  createUtxos(fee) { return this.mutate(wallet => wallet.createUtxos({ upTo: true, num: 4, size: 1000, feeRate: testFee(fee) })); }
  /** Issue a new test asset (NIA) to this wallet. Needs prepared RGB outputs. */
  issue(fields) {
    const params = newAsset(fields);
    return this.mutate(wallet => wallet.issueAssetNia(params));
  }
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
      if (!this.profile.invoiceNets.includes(String(decoded.network).toLowerCase())) throw new Error(`The invoice is not for ${this.profile.label}.`);
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
      return encryptRgb({ mnemonic: this.mnemonic, rgbBackup: b64(bytes) }, this.password, this.profile.id);
    });
  }
  backupSaved() { this.storage.setItem(this.dirtyKey, '0'); }
  async close() {
    const wallet = this.wallet;
    this.wallet = null; this.mnemonic = ''; this.password = '';
    if (wallet) await wallet.dispose();
  }
}
