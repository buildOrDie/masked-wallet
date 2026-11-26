import { RGB_PROFILES, dirtyKey, baseUnits, testFee, newAsset, RGB_UTXO_SATS } from './config.mjs';
import { decryptRgb, encryptRgb } from './backup.mjs';
import { b64, unb64 } from './bytes.mjs';

/** How many of the RGB states replaced by loading a backup this browser keeps. */
export const BEFORE_LOADS = 5;
// The undo copies are whole RGB backups (hundreds of KB each). Five of them filled browser storage on Signet (3 MB),
// and the Instant listings store then dropped signed lots the market never got. Kept under this size, newest first.
export const BEFORE_LOADS_MAX_CHARS = 1_000_000;

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
  /** Something changed that the backup doesn't have yet. dirtyGen counts the changes, so a backup that was being
   *  saved while another change happened doesn't mark that change as backed up. */
  markDirty() { this.dirtyGen = (this.dirtyGen || 0) + 1; this.storage.setItem(this.dirtyKey, '1'); }
  /** A backup file has been saved at least once (it holds the RGB keys; later backups add the latest tokens). */
  get everBackedUp() { return this.storage.getItem(`${this.vaultKey}.backed-up`) === '1'; }
  /**
   * One RGB operation at a time (the engine keeps its state across awaits). An operation asked for while another runs
   * waits its turn, up to EXCLUSIVE_WAIT_MS, instead of failing at once: a buy approved while the wallet was syncing
   * said "Wait for the current RGB operation." and only worked after closing the wallet.
   */
  async exclusive(fn) {
    const before = this.tail || Promise.resolve();
    let release = () => {};
    const mine = new Promise((r) => { release = r; });
    this.tail = before.then(() => mine);
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('Wait for the current RGB operation.')), SignetWallet.EXCLUSIVE_WAIT_MS); });
    // gave up waiting: its turn is passed on once the one before it ends
    try { await Promise.race([before, late]); } catch (e) { before.then(release); throw e; } finally { clearTimeout(timer); }
    this.busy = true;
    // the engine is mid-call (it holds its state across awaits): an NFT picture read meanwhile waits (nftImage)
    if (this.wallet) this.wallet.engineBusy = true;
    try { return await fn(); } finally { this.busy = false; if (this.wallet) this.wallet.engineBusy = false; release(); }
  }
  /** How long an RGB operation waits for the one running (a refresh takes a few seconds, a full one longer). */
  static EXCLUSIVE_WAIT_MS = 120_000;
  /**
   * `replace`: load `backup` over this browser's RGB (the same keys: another copy of this wallet saved newer data).
   * This browser's own state is kept first (the last few, see `beforeLoads`), so a load can be undone.
   * @param {string} password @param {() => string} generateMnemonic @param {any} [backup] @param {{ replace?: boolean }} [opts]
   */
  async open(password, generateMnemonic, backup = null, opts = {}) {
    const replace = !!opts.replace;
    const net = this.profile.id;
    return this.exclusive(async () => {
      if (this.wallet) throw new Error('Lock and reload before opening a wallet again.');
      if (backup && this.exists && !replace) throw new Error('Restore in a clean browser profile; do not overwrite an existing RGB wallet.');
      const saved = backup || (this.exists ? JSON.parse(this.storage.getItem(this.vaultKey)) : null);
      // where opening RGB spends its time, in the console with the refresh and backup lines
      const t = [Date.now()], mark = () => t.push(Date.now());
      const payload = saved ? await decryptRgb(saved, password, net) : { mnemonic: generateMnemonic() };
      mark();
      // Persist encrypted keys before the SDK creates state. An init failure must never lose the seed.
      if (!saved) {
        this.storage.setItem(this.vaultKey, JSON.stringify(await encryptRgb(payload, password, net)));
        this.markDirty();
      }
      try { this.trimBeforeLoads(); } catch { /* storage unreadable: nothing to trim */ }
      const sdk = await this.loadSdk();
      mark();
      const wallet = new sdk.UTEXOWallet({ ...this.profile.sdk, mnemonic: payload.mnemonic, password });
      this.wallet = wallet;
      try {
        await wallet.init();
        mark();
        // outputs promised to Instant listings: before anything else can spend them
        wallet.reserve?.(this.instantReserved());
        // sales pay the Public address, when it's on this network
        wallet.setPayoutScript?.(this.payoutHex || null);
        // Instant purchases whose transfer is still to arrive (protocol 1.0: matched without the derived blinding)
        wallet.expectPurchases?.(Object.values(this.instantStore().all()).filter((e) => e?.role === 'buyer' && e.recipientId).map((e) => String(e.recipientId)));
        // P2P buys (UniSat's flow): their token transfer waits for the seller's commitment before it's accepted
        wallet.p2pHoldsFrom?.(this.swapStore('p2p'));
        if (backup) {
          if (typeof payload.rgbBackup !== 'string') throw new Error('Backup does not contain RGB state.');
          if (replace) {
            // the state being replaced, kept in case it was the right one after all
            try { await wallet.createBackup({ backupPath: '', password }); this.keepBeforeLoad(await encryptRgb({ mnemonic: payload.mnemonic, rgbBackup: b64(wallet.getLastBackupBytes()), instant: this.instantForBackup() }, password, net)); } catch { /* nothing to keep */ }
          }
          await wallet.restoreFromBackupBytes(unb64(payload.rgbBackup), password);
          // Instant listings and purchases this wallet made in another copy: kept with the backup
          this.mergeInstant(payload.instant);
        }
        mark();
        await wallet.unlock();
        mark();
        // unlock can return offline. Explicit sync must fail visibly instead of showing a zero balance.
        if (!wallet.isOnline()) await wallet.goOnline();
        mark();
        try {
          const d = (i) => t[i + 1] - t[i];
          console.info('[MASKED] RGB open', JSON.stringify({ keys: d(0), engineLoad: d(1), engineInit: d(2), restore: d(3), unlock: d(4), online: d(5), total: t[6] - t[0] }));
        } catch { /* no console */ }
        if (backup) this.storage.setItem(this.vaultKey, JSON.stringify(await encryptRgb({ mnemonic: payload.mnemonic }, password, net)));
        this.mnemonic = payload.mnemonic; this.password = password;
        // the first refresh after opening shows the wallet: the slow chores (receives waiting for data for over a day,
        // purchases refused before 2.32.5) wait for a refresh two minutes later instead of holding up the first one
        this.staleAt = Date.now() - 3600_000 + 120_000;
        this.reopenAt = Date.now() - 300_000 + 120_000;
        // transfers that never went out a day ago (a market trade left halfway): their outputs freed, after the open
        setTimeout(() => { this.autoReleaseLocks?.().catch(() => {}); }, 8000);
      } catch (e) { await this.close(); throw e; }
    });
  }
  // ---- the states replaced by loads (newest first, a few kept): a wrong load is undone by loading one back ----
  get beforeLoadsKey() { return `${this.vaultKey}.before-loads`; }
  readBeforeLoads() {
    let list = [];
    try { list = JSON.parse(this.storage.getItem(this.beforeLoadsKey) || '[]'); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    // the single slot older builds kept
    try {
      const old = this.storage.getItem(`${this.vaultKey}.before-load`);
      if (old) {
        list.push({ at: 0, backup: JSON.parse(old) });
        this.storage.setItem(this.beforeLoadsKey, JSON.stringify(list));
        this.storage.removeItem(`${this.vaultKey}.before-load`);
      }
    } catch { /* unreadable: dropped */ }
    return list.filter((x) => x && x.backup).sort((a, b) => b.at - a.at);
  }
  keepBeforeLoad(backup) {
    let list = [{ at: Date.now(), backup }, ...this.readBeforeLoads()].slice(0, BEFORE_LOADS);
    // browser storage is small: fewer if they don't fit, never the newest dropped for an older one
    while (list.length > 1 && JSON.stringify(list).length > BEFORE_LOADS_MAX_CHARS) list = list.slice(0, -1);
    while (list.length) {
      try { this.storage.setItem(this.beforeLoadsKey, JSON.stringify(list)); return; } catch { list = list.slice(0, -1); }
    }
  }
  /**
   * Make room in browser storage: the oldest undo copies go first (down to `keep`). Returns whether anything went.
   * Called when a listing doesn't fit, and on open for a list saved before the size limit.
   */
  trimBeforeLoads(keep = 1, maxChars = BEFORE_LOADS_MAX_CHARS) {
    const list = this.readBeforeLoads();
    let n = list.length;
    while (n > keep && JSON.stringify(list.slice(0, n)).length > maxChars) n--;
    if (n === list.length) return false;
    try { this.storage.setItem(this.beforeLoadsKey, JSON.stringify(list.slice(0, n))); } catch { this.storage.removeItem(this.beforeLoadsKey); }
    return true;
  }
  /** The kept states: [{ at }] newest first; `beforeLoad(i)` is one of them as a backup to load. */
  beforeLoads() { return this.readBeforeLoads().map((x) => ({ at: x.at })); }
  beforeLoad(i) { return this.readBeforeLoads()[Number(i)]?.backup || null; }
  /** Settings → Blockchain server changed: the open wallet switches on its next sync, no reload needed. */
  useServers(list) {
    if (!Array.isArray(list) || !list.length) return;
    this.profile = { ...this.profile, sdk: { ...this.profile.sdk, indexerUrls: list } };
    this.wallet?.setIndexers?.(list);
  }
  /** A sale's bitcoin goes to this script (the Public address, P2TR hex); null: to the RGB wallet. */
  setPayoutScript(hex) { this.payoutHex = hex || null; this.wallet?.setPayoutScript?.(this.payoutHex); }
  requireWallet() { if (!this.wallet || !this.mnemonic) throw new Error('Unlock the RGB test wallet first.'); return this.wallet; }
  /** @param {{ full?: boolean }} [o] full: also scan addresses ahead (finds coins sent to older addresses) */
  /**
   * `sync: false`: the transfer server only (waiting for the other side to accept a send), no block server sync.
   * @param {{ full?: boolean, sync?: boolean }} [o]
   */
  async snapshot({ full = false, sync = true } = {}) {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      const t0 = Date.now(), took = {};
      await wallet.preferFirst?.();
      // the block server in use is busy or gone: try the next one once before giving up
      if (sync) try { await wallet.syncWallet({ full }); } catch (e) {
        if (!/invalid indexer|esplora|failed to fetch|network|429|too many|timed? ?out|50[234]/i.test(String(e?.message || e)) || !(await wallet.switchIndexer?.())) throw e;
        await wallet.syncWallet({ full });
      }
      took.blocks = Date.now() - t0;
      if (sync && wallet.lastSyncTook) { took.blocksEngine = wallet.lastSyncTook.engine; took.blocksSave = wallet.lastSyncTook.save; }
      // A send signed before a restore can't be broadcast: the engine keeps the signed transaction in this
      // browser only, never in backups. Once the other wallet accepts, refresh reports it missing.
      // invoices no transaction pays, made over an hour ago (moves that never went out): every refresh asks the
      // transfer server about each one, so they go (at most once in 10 minutes; nothing pays them, nothing is lost)
      if (typeof wallet.cancelUnpaidReceives === 'function' && Date.now() - (this.unpaidAt || 0) > 600_000) {
        this.unpaidAt = Date.now();
        const tu = Date.now();
        try { took.unpaidCancelled = await wallet.cancelUnpaidReceives(); } catch { /* next time */ }
        took.unpaid = Date.now() - tu;
      }
      took.sync = Date.now() - t0;
      const t1 = Date.now();
      // NFTs bought before 2.32.5 that this wallet refused for a missing file: opened again (at most every 5 minutes)
      if (typeof wallet.recoverRefusedPurchases === 'function' && this.profile?.nftSold && Date.now() - (this.reopenAt || 0) > 300_000) {
        this.reopenAt = Date.now();
        try {
          const n = await wallet.recoverRefusedPurchases(this.instantStore(), this.profile.nftSold);
          if (n) console.info('[MASKED] Refused NFT purchases opened again', n);
        } catch (e) { console.warn('[MASKED] Refused NFT purchases', e); }
      }
      // receives waiting for data for over a day: asked about hourly (and on a full refresh), not every time
      const all = full || Date.now() - (this.staleAt || 0) > 3600_000;
      if (all) this.staleAt = Date.now();
      const refreshed = await wallet.refreshWallet({ all }) || {};
      took.transfers = Date.now() - t1;
      const stranded = Object.entries(refreshed).filter(([, r]) => /signed PSBT not found/i.test(JSON.stringify(r?.failure ?? ''))).map(([idx]) => Number(idx));
      // Sequential: the WASM wallet has a shared RefCell and does not support overlapping calls.
      const tl = Date.now();
      const address = await wallet.getAddress();
      const btc = await wallet.getBtcBalance();
      const groups = await wallet.listAssets();
      took.lists = Date.now() - tl;
      // history per asset (rgb-lib lists transfers by asset, and each call reads the whole RGB database: with many
      // NFTs that's most of a refresh). Listed again only for an asset whose balance changed, after a refresh that
      // changed a transfer, on a full refresh, or every 10 minutes; the others keep the last list.
      const t2 = Date.now();
      const transfers = {}, cache = this.transferCache ||= new Map();
      const every = full || Object.keys(refreshed).length > 0 || Date.now() - (this.transfersAt || 0) > 600_000;
      if (every) this.transfersAt = Date.now();
      let listedN = 0;
      for (const a of Object.values(groups || {}).flat()) {
        if (!a?.assetId) continue;
        const sig = JSON.stringify(a.balance ?? null);
        const hit = cache.get(a.assetId);
        if (!every && hit && hit.sig === sig) { transfers[a.assetId] = hit.list; continue; }
        transfers[a.assetId] = await wallet.listTransfers(a.assetId); listedN++;
        cache.set(a.assetId, { sig, list: transfers[a.assetId] });
      }
      took.history = Date.now() - t2; took.assets = Object.keys(transfers).length; took.listed = listedN;
      const tk = Date.now();
      const locked = typeof wallet.lockedCoins === 'function' ? await wallet.lockedCoins() : [];
      // tokens in this wallet's listings: they can't be sent (the engine counts them as spendable)
      const listed = typeof wallet.listedByAsset === 'function' ? wallet.listedByAsset() : {};
      took.locked = Date.now() - tk; took.allReceives = all;
      const snapshot = { address, btc, groups, transfers, stranded, locked, listed };
      took.total = Date.now() - t0;
      // where an RGB refresh spends its time (the block server, the transfer server, this browser): in the console
      this.lastTimings = { ...took, full, at: Date.now() };
      try { console.info('[MASKED] RGB refresh', JSON.stringify(this.lastTimings)); } catch { /* no console */ }
      const encoded = new TextEncoder().encode(JSON.stringify(snapshot, (_, value) => typeof value === 'bigint' ? value.toString() : value));
      const revision = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)));
      const key = `${this.vaultKey}.sync-revision`;
      if (this.storage.getItem(key) !== revision) this.markDirty();
      this.storage.setItem(key, revision);
      return snapshot;
    });
  }
  // A fresh backup is reminded about (Settings shows it), not forced: these are test networks and test assets.
  async mutate(fn) {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      // Mark before execution: even an interrupted operation may have changed RGB state.
      this.markDirty();
      this.transfersAt = 0; // the next refresh lists every token's history again
      return fn(wallet);
    });
  }
  /** Free spare RGB outputs back to bitcoin, keeping a few (see LiteWallet.freeSpare). */
  /** @param {{ keep?: number, parts?: number, fee?: any }} [o] */
  freeSpare({ keep = undefined, parts = undefined, fee = undefined } = {}) { return this.mutate((w) => w.freeSpare({ keep, parts, feeRate: testFee(fee) })); }
  /** Everything this RGB wallet holds, output by output (see LiteWallet.outputsReport). */
  outputsReport() { return this.exclusive(() => this.requireWallet().outputsReport(this.instantStore())); }
  /** Give up a transfer that never went out, freeing the outputs it held (see LiteWallet.releaseLock). */
  releaseLock(p) { return this.mutate((w) => w.releaseLock(p)); }
  releaseTrade(p) { return this.mutate((w) => w.releaseTrade(p, [this.swapStore('p2p'), this.swapStore('sold'), this.swapStore('bought')])); }
  autoReleaseLocks() { return this.mutate((w) => (w.autoReleaseLocks ? w.autoReleaseLocks() : 0)); }
  /** Outputs this wallet counts that the chain shows spent; `fix` marks them spent (see LiteWallet.repairFromChain). */
  repairFromChain(o = {}) { return this.mutate((w) => w.repairFromChain(o)); }
  /** Bitcoin from the RGB balance to an address; tokens stay (see LiteWallet.sendBtcOut). */
  sendBtcOut({ address, sats, all, fee }) { return this.mutate(wallet => wallet.sendBtcOut({ address, sats, all, feeRate: testFee(fee) })); }
  createUtxos(fee) { return this.mutate(wallet => wallet.createUtxos({ upTo: true, num: 4, size: RGB_UTXO_SATS, feeRate: testFee(fee) })); }
  /** Issue a new test asset (NIA) to this wallet. Needs prepared RGB outputs. */
  issue(fields) {
    const params = newAsset(fields);
    return this.mutate(wallet => wallet.issueAssetNia(params));
  }
  /** @param {{ assetId?: string, amount?: number, durationSeconds?: number, witness?: boolean } | string} [o] */
  receive(o = {}) {
    const opts = typeof o === 'string' ? { assetId: o } : o;
    return this.mutate(wallet => wallet.onchainReceive({ assetId: opts.assetId || null, amount: opts.amount || 0, durationSeconds: opts.durationSeconds ?? null, witness: !!opts.witness }));
  }
  /**
   * Cancel invoices of ours nobody has paid yet (their recipient IDs): the transfers waiting for the other wallet
   * are marked failed, which frees the RGB outputs they reserved. Paid or settled ones are left alone.
   */
  cancelInvoices(recipientIds = null) {
    const want = recipientIds ? new Set(recipientIds.map(String)) : null; // null: every open invoice, also ones made before the list existed
    return this.mutate(async (wallet) => {
      const assets = Object.values(await wallet.listAssets()).flat().map((a) => a.assetId);
      const all = [];
      for (const id of [null, ...assets]) all.push(...await wallet.listTransfers(id));
      const idx = [...new Set(all.filter((t) => (!want || want.has(String(t?.recipientId ?? ''))) && t?.status === 'WaitingCounterparty' && /^Receive/.test(String(t?.kind ?? ''))).map((t) => Number(t.batchTransferIdx)))];
      let n = 0;
      for (const i of idx) if (Number.isFinite(i) && await wallet.failTransfer(i)) n++;
      return n;
    });
  }
  /**
   * Cancel sends the other wallet hasn't accepted yet. Nothing has been broadcast for these (RGB broadcasts only
   * after the recipient accepts), so cancelling frees the tokens and BTC they hold. Sends already on chain stay.
   * @param {number[]|null} idx batch transfer indexes, or null for every unsent send
   */
  cancelSends(idx = null) {
    const want = idx ? new Set(idx.map(Number)) : null;
    return this.mutate(async (wallet) => {
      const assets = Object.values(await wallet.listAssets()).flat().map((a) => a.assetId);
      const all = [];
      for (const id of assets) all.push(...await wallet.listTransfers(id));
      const open = [...new Set(all.filter((t) => t?.kind === 'Send' && t?.status === 'WaitingCounterparty').map((t) => Number(t.batchTransferIdx)))];
      let n = 0; const errors = [];
      for (const i of open) {
        if (!Number.isFinite(i) || (want && !want.has(i))) continue;
        // the engine re-checks the transfer before cancelling; a refusal says why (accepted meanwhile, server
        // unreachable, or a send signed before a restore whose signed transaction is gone)
        try { if (await wallet.failTransfer(i)) n++; } catch (e) { errors.push({ idx: i, reason: String(e?.message || e) }); }
      }
      return errors.length ? { n, errors } : n;
    });
  }
  // ---- peer-to-peer swaps: each step's state is kept with this RGB wallet, across approval windows ----
  swapStore(kind) {
    const key = `${this.vaultKey}.swaps.${kind}`;
    const read = () => { try { return JSON.parse(this.storage.getItem(key) || '{}'); } catch { return {}; } };
    const write = (m) => this.storage.setItem(key, JSON.stringify(m));
    return {
      get: (id) => read()[String(id)] || null,
      set: (id, v) => { const m = read(); m[String(id)] = v; for (const [k, x] of Object.entries(m)) if (Date.now() - (x?.at || 0) > 7 * 86400_000) delete m[k]; write(m); },
      del: (id) => { const m = read(); delete m[String(id)]; write(m); },
      all: () => read(),
    };
  }
  /** Instant listings and purchases, kept until done (listings last up to 30 days). */
  /** The Instant entries worth carrying in a backup: finished ones only for a week; a published listing's proof stays with the market. */
  instantForBackup() {
    const out = {}, week = Date.now() - 7 * 86400_000;
    for (const [id, e] of Object.entries(this.instantStore().all())) {
      if (!e || (['sold', 'cancelled', 'purchase-failed'].includes(e.stage) && Number(e.at || 0) < week)) continue;
      out[id] = e.published && e.consignment ? { ...e, consignment: undefined } : e;
    }
    return out;
  }
  /** Instant entries from a backup: added, and an entry kept here replaced only by a newer one (`at`). */
  mergeInstant(map) {
    if (!map || typeof map !== 'object') return;
    const store = this.instantStore(), mine = store.all();
    for (const [id, e] of Object.entries(map)) {
      if (!e || typeof e !== 'object' || !['seller', 'buyer'].includes(e.role)) continue;
      const have = mine[id];
      if (!have || Number(e.at || 0) > Number(have.at || 0)) store.set(id, e);
    }
    this.wallet?.reserve?.(this.instantReserved());
  }
  instantStore() {
    const key = `${this.vaultKey}.swaps.instant`;
    const read = () => { try { return JSON.parse(this.storage.getItem(key) || '{}'); } catch { return {}; } };
    const finished = (x) => ['sold', 'cancelled'].includes(x?.stage) || (x?.role === 'buyer' && (x?.posted || x?.failed));
    // Browser storage holds a few MB. A signed listing's transfer data can be large, so only what's still needed is
    // kept: a sold, cancelled or settled entry loses its signed data at once; when storage is still full, finished
    // entries go (oldest first), then the transfer data of open listings (the market has a copy; MASKED signs again
    // if asked). Before, a full storage ("exceeded the quota") stopped every listing.
    const slim = (x) => {
      if (!x || typeof x !== 'object') return x;
      const y = { ...x };
      if (finished(y) || y.stage === 'cancelling') { delete y.psbt; delete y.consignment; delete y.completed; delete y.moveHex; if (y.role === 'buyer' && y.posted) delete y.txHex; }
      if (y.stage === 'ready') delete y.moveHex;
      return y;
    };
    const write = (m, saving = '') => {
      for (const k of Object.keys(m)) m[k] = slim(m[k]);
      const put = () => this.storage.setItem(key, JSON.stringify(m));
      try { return put(); } catch (e) { if (!/quota|exceeded/i.test(String(e?.message || e?.name || e))) throw e; }
      // still full: finished entries, oldest first
      for (const [k] of Object.entries(m).filter(([, x]) => finished(x)).sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))) {
        delete m[k];
        try { return put(); } catch { /* next */ }
      }
      // then the undo copies of earlier loads (all but the newest, then that too): a listing matters more
      for (const keep of [1, 0]) {
        if (this.trimBeforeLoads(keep, 0)) try { return put(); } catch { /* next */ }
      }
      // then the transfer data of open listings, oldest first, never the one being saved (signed again if asked)
      for (const [k, x] of Object.entries(m).filter(([k2, x]) => x?.consignment && k2 !== saving).sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))) {
        m[k] = { ...x, consignment: undefined, psbt: undefined, resign: true }; // still on sale: the market keeps the signed listing
        try { return put(); } catch { /* next */ }
      }
      return put();
    };
    return {
      all: read,
      get: (id) => read()[String(id)] || null,
      set: (id, v) => { const m = read(); m[String(id)] = v; for (const [k, x] of Object.entries(m)) if (finished(x) && Date.now() - (x?.at || 0) > 7 * 86400_000) delete m[k]; write(m, String(id)); },
      del: (id) => { const m = read(); delete m[String(id)]; write(m); },
    };
  }
  /** The outputs promised to this wallet's open Instant listings. */
  instantReserved() {
    return Object.values(this.instantStore().all()).filter((e) => e?.role === 'seller' && ['moving', 'ready'].includes(e.stage) && e.coin).map((e) => String(e.coin));
  }
  get canPresign() { return !!this.wallet?.canPresign; }
  instantList(p) { return this.mutate((w) => w.instantList(p, this.instantStore())); }
  instantListLots(p) { return this.mutate((w) => w.instantListLots(p, this.instantStore())); }
  instantBuy(p) { return this.mutate((w) => w.instantBuy(p, this.instantStore())); }
  /** Several Instant listings in one transaction (2.30): `{ txid, offerIds }`, or `{ notPaid }` to buy them one by one. */
  instantBuyCombined(p) { return this.mutate((w) => w.instantBuyCombined(p, this.instantStore())); }
  get canCombine() { return !!this.wallet?.canCombine; }
  instantCancel(p) { return this.mutate((w) => w.instantCancel(p, this.instantStore())); }
  /** After a refresh: sign settled listings, notice sales and cancels, hand bought transfers to the wallet. */
  instantProgress() {
    return this.mutate(async (w) => {
      if (!w.canPresign) return [];
      const store = this.instantStore(), all = store.all();
      for (const [id, e] of Object.entries(all)) if (e?.role === 'buyer' && !e.posted) await w.instantPost(id, store).catch(() => false);
      return w.instantProgress(store, all);
    });
  }
  /** This wallet's Instant listings: [{ offerId, stage, txid, … }]. */
  instantListings() { return Object.entries(this.instantStore().all()).filter(([, e]) => e?.role === 'seller').map(([id, e]) => ({ offerId: id, stage: e.outdated && e.stage === 'ready' ? 'outdated' : e.stage === 'queued' ? 'moving' : e.stage, assetId: e.assetId, amount: e.amount, priceSats: e.priceSats, txid: e.soldTxid || e.cancelTxid || e.moveTxid || null, at: e.at, waiting: ['moving', 'queued'].includes(e.stage) ? e.waiting || (e.stage === 'queued' ? 'Next in line: on sale about 10 minutes after the lot before it.' : '') : '', ...(e.lotOf ? { lotOf: e.lotOf, lots: e.lots || null } : {}) })); }
  get canSwap() { return !!this.wallet?.canSwap; }
  offerableAmount(p) { return this.exclusive(() => this.requireWallet().offerableAmount(p)); }
  assetList() { return this.exclusive(() => this.requireWallet().assetList()); }
  prepareBuy(p) { return this.mutate((w) => w.prepareBuy(p, this.swapStore('bought'))); }
  prepareSale(p) { return this.mutate((w) => w.prepareSale(p, this.swapStore('sold'))); }
  signBuy(p) { return this.mutate((w) => w.signBuy(p, this.swapStore('bought'))); }
  completeSale(p) { return this.mutate((w) => w.completeSale(p, this.swapStore('sold'))); }
  // wallet-to-wallet swaps in UniSat's P2P flow (2.31)
  get canP2p() { return !!this.wallet?.canP2p; }
  /** Tokens free to list or sell on settled outputs (see LiteWallet.freeToList). */
  freeToList(assetId) { return this.wallet?.freeToList ? this.wallet.freeToList(assetId) : 0; }
  p2pListable(p) { return this.exclusive(() => this.requireWallet().p2pListable(p)); }
  p2pBuyPrepare(p) { return this.mutate((w) => w.p2pBuyPrepare(p, this.swapStore('p2p'))); }
  p2pSaleSign(p) { return this.mutate((w) => w.p2pSaleSign(p, this.swapStore('p2p'))); }
  p2pBuySign(p) { return this.mutate((w) => w.p2pBuySign(p, this.swapStore('p2p'))); }
  p2pSaleCommit(p) { return this.mutate((w) => w.p2pSaleCommit(p, this.swapStore('p2p'))); }
  p2pBuyAccept(p) { return this.mutate((w) => w.p2pBuyAccept(p, this.swapStore('p2p'))); }
  p2pSaleFinish(p) { return this.mutate((w) => w.p2pSaleFinish(p, this.swapStore('p2p'))); }
  p2pCancel(p) { return this.mutate((w) => w.p2pCancel(p, this.swapStore('p2p'))); }
  /** @param {string} url an https:// transfer server URL */
  checkProxy(url) { return this.exclusive(() => this.requireWallet().checkProxy(url)); }
  /** An NFT's image (data: URL) from the transfer servers, checked against its digest. Doesn't touch the wallet state. */
  nftImage(media, o) { return this.wallet?.nftImage ? this.wallet.nftImage(media, fetch, o) : null; }
  /** An NFT's traits from its metadata.json (checked against the NFT). Doesn't touch the wallet state. */
  nftMeta(files) { return this.wallet?.nftMeta ? this.wallet.nftMeta(files) : null; }
  /** What an invoice asks for (no change to the wallet). */
  decode(invoice) { return this.exclusive(() => this.requireWallet().decodeRGBInvoice({ invoice })); }
  send({ invoice, assetId, amount, fee, endpoint = '', nft = false }) {
    if (!invoice.startsWith('rgb:') || !assetId) throw new Error('Enter an RGB invoice and the exact asset ID.');
    const params = { invoice, assetId, amount: baseUnits(amount), feeRate: testFee(fee), ...(nft ? { nft: true } : {}) };
    return this.mutate(async wallet => {
      const decoded = await wallet.decodeRGBInvoice({ invoice });
      // blind (utxob:) or witness (wvout:) invoices
      if (!decoded?.recipientId || !/utxob:|wvout:/.test(String(decoded.recipientId))) throw new Error('This is not an RGB invoice MASKED can pay.');
      if (decoded.amount && decoded.amount !== params.amount) throw new Error('The amount does not match the invoice.');
      if (!this.profile.invoiceNets.includes(String(decoded.network).toLowerCase())) throw new Error(`The invoice is not for ${this.profile.label}.`);
      if (decoded.assetId && decoded.assetId !== assetId) throw new Error('Invoice asset ID does not match.');
      if (decoded.expirationTimestamp && decoded.expirationTimestamp <= Date.now() / 1000) throw new Error('This RGB invoice has expired.');
      const endpoints = decoded.transportEndpoints?.length ? decoded.transportEndpoints : [this.profile.sdk.transportEndpoint];
      if (endpoint && !endpoints.includes(endpoint)) throw new Error('The reviewed transfer server is missing from the invoice.');
      return wallet.onchainSend(endpoint ? { ...params, endpoint } : params);
    });
  }
  async backup() {
    return this.exclusive(async () => {
      const wallet = this.requireWallet();
      this.backupGen = this.dirtyGen || 0;
      const t0 = Date.now();
      await wallet.createBackup({ backupPath: '', password: this.password });
      const bytes = wallet.getLastBackupBytes();
      if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('The SDK did not return backup data.');
      const t1 = Date.now();
      // Instant listings and purchases go with it, so another copy that loads it can finish, see and cancel them
      const out = await encryptRgb({ mnemonic: this.mnemonic, rgbBackup: b64(bytes), instant: this.instantForBackup() }, this.password, this.profile.id, this.encCache ||= {});
      this.lastBackupTimings = { engine: t1 - t0, encrypt: Date.now() - t1, mb: +(bytes.length / 1048576).toFixed(2) };
      return out;
    });
  }
  /** @param {number} [gen] the backup's dirtyGen: a change made after it keeps the wallet marked as not backed up */
  backupSaved(gen) {
    if (gen == null || gen === (this.dirtyGen || 0)) this.storage.setItem(this.dirtyKey, '0');
    this.storage.setItem(`${this.vaultKey}.backed-up`, '1');
  }
  async close() {
    const wallet = this.wallet;
    this.wallet = null; this.mnemonic = ''; this.password = ''; this.encCache = null; this.transferCache = null;
    if (wallet) await wallet.dispose();
  }
}
