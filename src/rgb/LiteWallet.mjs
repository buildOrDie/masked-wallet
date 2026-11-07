// On-chain RGB wallet over @utexo/rgb-lib-wasm: issue, receive, send and back up RGB assets.
// It replaces Utexo's web SDK, which also bundles a Lightning node and a second wallet engine (BDK):
// about 11 MB instead of about 27 MB. No Lightning. Same method names as the SDK's UTEXOWallet, so
// SignetWallet works with either.

/** rgb-lib names for our network ids. Utexo's custom Signet uses Signet rules too. */
const NETWORKS = { mainnet: 'Mainnet', signet: 'Signet', utexo: 'Signet', testnet: 'Testnet', testnet4: 'Testnet4', regtest: 'Regtest' };
export const rgbNetwork = (n) => NETWORKS[String(n).toLowerCase()] || (() => { throw new Error(`Unknown RGB network: ${n}`); })();

/** rgb-lib wants rpc(s):// transport endpoints; our config uses https:// like the SDK. */
export const rpcEndpoint = (url) => String(url).replace(/^https:\/\//i, 'rpcs://').replace(/^http:\/\//i, 'rpc://');

const num = (x) => Number(x ?? 0);

/**
 * The engine returns u64 values (amounts, timestamps, indexes) as BigInt. The screens do ordinary maths on them
 * (sorting, dates, sums), and BigInt does not mix with numbers. Turn them into numbers; a value beyond 2^53 (no
 * test amount gets there) becomes a string rather than a wrong number.
 */
export function plain(x) {
  if (typeof x === 'bigint') return x <= BigInt(Number.MAX_SAFE_INTEGER) && x >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(x) : x.toString();
  if (Array.isArray(x)) return x.map(plain);
  if (x && typeof x === 'object' && !(x instanceof Uint8Array)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, plain(v)]));
  return x;
}
const balance = (b) => ({ settled: num(b?.settled), future: num(b?.future), spendable: num(b?.spendable) });
const asset = (a) => ({
  assetId: String(a?.assetId ?? ''), ticker: String(a?.ticker ?? a?.name ?? '').slice(0, 12), name: String(a?.name ?? a?.ticker ?? ''),
  precision: num(a?.precision), issuedSupply: num(a?.issuedSupply), balance: balance(a?.balance),
});

export class LiteWallet {
  /**
   * @param {object} lib  the loaded rgb-lib-wasm module ({ WasmWallet, WasmInvoice, restoreKeys })
   * @param {{ network: string, indexerUrl: string, transportEndpoint: string, mnemonic: string, dataDir: string }} params
   */
  constructor(lib, params) {
    this.lib = lib;
    this.params = params;
    this.net = rgbNetwork(params.network);
    this.transport = rpcEndpoint(params.transportEndpoint);
    /** @type {any} */ this.w = null;
    this.online = null;
    this.lastBackupBytes = null;
  }

  /** Create the wallet, restoring its saved state from IndexedDB. */
  async init() {
    const { mnemonic, dataDir } = this.params;
    const k = this.lib.restoreKeys(this.net, mnemonic);
    const data = {
      dataDir, bitcoinNetwork: this.net, databaseType: 'Sqlite', maxAllocationsPerUtxo: 5,
      accountXpubVanilla: k.accountXpubVanilla, accountXpubColored: k.accountXpubColored,
      mnemonic, masterFingerprint: k.masterFingerprint, vanillaKeychain: null,
      // mainnet: NIA (standard RGB tokens) only; this engine has no CFA/UDA, and IFA/BFA are test-network only for now
      supportedSchemas: this.net === 'Mainnet' ? ['Nia'] : ['Nia', 'Ifa'], reuseAddresses: true, // one stable funding address
    };
    this.w = await this.lib.WasmWallet.create(JSON.stringify(data));
  }
  get wallet() { if (!this.w) throw new Error('RGB wallet is not open.'); return this.w; }
  requireOnline() { if (!this.online) throw new Error('RGB wallet is offline. Try Refresh.'); return this.online; }

  /** Connect to the indexer (the SDK's unlock does the same). */
  async unlock() { if (!this.online) await this.goOnline(this.params.indexerUrl); }
  isOnline() { return !!this.online; }
  async goOnline(url = this.params.indexerUrl) { this.online = await this.wallet.goOnline(false, url); }
  async save() { await this.wallet.flush(); }
  async dispose() {
    const w = this.w;
    this.w = null; this.online = null; this.lastBackupBytes = null;
    if (!w) return;
    try { await w.flush(); } finally { w.free(); }
  }

  /**
   * Bring the BTC side up to date. `full`: scan addresses ahead (BIP44 gap) too, which finds coins sent to an
   * address this wallet state has not handed out yet (a restore, or an address shown by an older build).
   */
  async syncWallet({ full = false } = {}) {
    const online = this.requireOnline();
    if (full) await this.wallet.fullScan(online);
    await this.wallet.sync(online);
    await this.save();
  }
  async refreshWallet() { const r = await this.wallet.refresh(this.requireOnline(), null, [], false); await this.save(); return plain(r); }
  async getAddress() { return this.wallet.getAddress(); }
  /** Coins that hold RGB tokens but can't be spent now: a pending send uses them, or an open invoice reserves them. */
  async lockedCoins() {
    const list = plain(typeof this.wallet.listUnspents === 'function' ? this.wallet.listUnspents(false) : []) || [];
    return list.filter((u) => Number(u?.pendingBlinded) > 0 || (u?.rgbAllocations || []).some((a) => a && a.settled === false))
      .map((u) => `${u?.utxo?.outpoint?.txid}:${u?.utxo?.outpoint?.vout}`);
  }
  async getBtcBalance() { const b = plain(this.wallet.getBtcBalance()); return { vanilla: balance(b?.vanilla), colored: balance(b?.colored) }; }
  async listAssets() {
    const r = plain(this.wallet.listAssets([]) || {});
    return { nia: (r.nia || []).map(asset), ifa: (r.ifa || []).map(asset) };
  }
  async listTransfers(assetId = null) { return plain(this.wallet.listTransfers(assetId) || []); }
  /** Give up on a transfer that is still waiting for the other side (frees the RGB output an invoice reserved). */
  async failTransfer(batchTransferIdx) {
    const r = await this.wallet.failTransfers(this.requireOnline(), batchTransferIdx, false, false);
    await this.save();
    return !!r;
  }

  /** Sign a PSBT with this wallet's own keys. */
  sign(psbt) { return this.wallet.signPsbt(psbt); }

  /** Make outputs that can hold RGB assets (one Bitcoin transaction). */
  async createUtxos({ upTo = true, num: n = 4, size = 1000, feeRate }) {
    const online = this.requireOnline();
    const psbt = await this.wallet.createUtxosBegin(online, upTo, n, size, BigInt(Math.round(feeRate)), false);
    const count = await this.wallet.createUtxosEnd(online, this.sign(psbt), false);
    await this.save();
    return count;
  }

  /** A new asset with a fixed supply, held by this wallet. */
  async issueAssetNia({ ticker, name, precision, amounts }) {
    const a = plain(this.wallet.issueAssetNia(ticker, name, precision, amounts));
    await this.save();
    return asset(a);
  }

  /** Sats the sender puts in the new output when paying a witness invoice (above dust, so it relays). */
  /** BTC on the receiver's new output for a "No BTC needed" invoice: the Taproot dust limit, the least Bitcoin allows. */
  static WITNESS_SATS = 330;

  /**
   * An invoice. Blind (default): receives onto one of our RGB outputs, blinded, so the sender learns no address;
   * needs a free RGB output. Witness: the sender creates the output (and pays its sats), so it works with no BTC.
   * @param {{ assetId?: string|null, amount?: number, durationSeconds?: number|null, witness?: boolean }} [o]
   */
  /** Every recipient ID this wallet has ever had a transfer for (all assets, and receives not tied to one). */
  usedRecipients() {
    const r = plain(this.wallet.listAssets([]) || {});
    const ids = [null, ...[...(r.nia || []), ...(r.ifa || [])].map((a) => a?.assetId).filter(Boolean)];
    const out = new Set();
    for (const id of ids) for (const t of plain(this.wallet.listTransfers(id)) || []) if (t?.recipientId) out.add(String(t.recipientId));
    return out;
  }
  async onchainReceive({ assetId = null, amount = 0, durationSeconds = null, witness = false } = {}) {
    const assignment = amount ? { Fungible: amount } : 'Any';
    const make = witness ? 'witnessReceive' : 'blindReceive';
    // The wallet keeps one pinned address (reuseAddresses), and a witness invoice pays to the pinned *receive*
    // address. Two invoices on one address both match one payment and count it twice, so each witness invoice gets
    // a fresh receive address, and one already used by any earlier transfer is never handed out.
    const used = witness ? this.usedRecipients() : null;
    let r = null;
    for (let i = 0; i < 4; i++) {
      if (witness && typeof this.wallet.rotateAddress === 'function') this.wallet.rotateAddress(0); // 0 = receive keychain; the funding address (1) stays
      r = plain(this.wallet[make](assetId || null, assignment, durationSeconds, [this.transport], 1));
      if (!witness || !used.has(String(r?.recipientId ?? ''))) break;
      // a reused one is cancelled at once, so it can never match a payment
      try { await this.wallet.failTransfers(this.requireOnline(), r.batchTransferIdx, false, true); } catch { /* offline: it stays open, but it is never shown */ }
      r = null;
    }
    await this.save();
    if (!r) throw new Error('Could not make a fresh RGB invoice. Try again.');
    return { invoice: String(r?.invoice ?? ''), recipientId: String(r?.recipientId ?? ''), expirationTimestamp: r?.expirationTimestamp ?? null };
  }

  async decodeRGBInvoice({ invoice }) {
    const inv = new this.lib.WasmInvoice(invoice);
    try {
      const d = plain(inv.invoiceData());
      return {
        invoice, recipientId: String(d?.recipientId ?? ''), assetId: d?.assetId ?? undefined,
        network: String(d?.network ?? '').toLowerCase(), expirationTimestamp: d?.expirationTimestamp ?? null,
        amount: Number(d?.assignment?.Fungible || 0), witness: String(d?.recipientId ?? '').includes('wvout:'),
        transportEndpoints: (d?.transportEndpoints || []).map(String),
      };
    } finally { inv.free(); }
  }

  /** Send to an invoice (blind or witness): build, sign and broadcast. */
  async onchainSend({ invoice, assetId, amount, feeRate, endpoint = '' }) {
    const online = this.requireOnline();
    const d = await this.decodeRGBInvoice({ invoice });
    const recipients = {
      [assetId]: [{
        recipientId: d.recipientId,
        // a witness invoice: we create the receiver's output, with a few sats in it
        // rgb-lib-wasm wants amountSat as a string here (a number is refused), while the token amount is a number
        witnessData: d.witness ? { amountSat: String(LiteWallet.WITNESS_SATS), blinding: null } : null,
        assignment: { Fungible: amount },
        transportEndpoints: endpoint ? [rpcEndpoint(endpoint)] : d.transportEndpoints.length ? d.transportEndpoints : [this.transport],
      }],
    };
    const psbt = await this.wallet.sendBegin(online, recipients, false, BigInt(Math.round(feeRate)), 1);
    const r = plain(await this.wallet.sendEnd(online, this.sign(psbt), false));
    await this.save();
    return r;
  }

  /** Check that an RGB transfer server answers and speaks a protocol this engine supports. Throws the reason. */
  async checkProxy(url) { await this.lib.checkProxyUrl(url); }

  async createBackup({ password }) { this.lastBackupBytes = this.wallet.backup(password); }
  getLastBackupBytes() { return this.lastBackupBytes; }
  async restoreFromBackupBytes(bytes, password) { this.wallet.restoreBackup(bytes, password); await this.save(); }
}
