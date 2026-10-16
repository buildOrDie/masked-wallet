// Keeping the wallet in step with the chain: the Public balance first, then new blocks (so fresh payments
// show up), then history backwards to the wallet's birthday. Fresh wallets never need history.

export const BIRTHDAYS = [['0', 'Never used (new wallet)'], ['7', 'In the last week'], ['30', 'In the last month'], ['90', 'In the last 3 months'], ['365', 'In the last year'], ['-1', "Not sure: I'll rescan by hand"]];

/** Block height for a date, with a day of margin (about 144 blocks a day). */
export const birthdayHeight = (ms, tip) => Math.max(1, tip - Math.ceil((Date.now() - ms) / 600000) - 144);

const WATCHDOG_MS = 150000;

export class ChainSync {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.syncing = false;
    this.gen = 0;          // a newer sync (or the watchdog) bumps this and older loops stop
    this.started = 0;
    this.note = '';
    this.error = null;     // why the block scan paused
    this.fundError = null; // why the Public balance could not be read
    this.holdHistory = false;
    this.tip = null;
    /** { topHeight, nextHeight, floor, scannedBlocks, deepDone?, manual?, updatedAt } */
    this.progress = null;
  }

  get state() { return this.app.state; }
  get scanServer() { return this.app.scanServer; }
  get progressKey() { return `wren.scan.${this.app.account.id}`; }

  loadProgress() { this.progress = this.app.store.getJson(this.progressKey, null); }
  saveProgress(p) { this.progress = p; this.app.store.setJson(this.progressKey, p); }
  forgetProgress() { this.progress = null; this.app.store.remove(this.progressKey); }

  /** Blocks of history still to check (0 when done). */
  historyLeft() {
    const p = this.progress;
    return p && p.floor > 0 && p.nextHeight >= p.floor ? p.nextHeight - p.floor + 1 : 0;
  }

  /** The line under the balance. */
  text() {
    if (this.syncing) return this.note || 'Checking for payments…';
    if (this.historyLeft()) return `Restoring history · ${this.historyLeft().toLocaleString()} blocks left`;
    if (this.error) return 'Sync paused · tap to retry';
    if (this.fundError) return 'Balance not updated · servers busy, tap to retry';
    const p = this.progress;
    if (!p) return 'Not synced yet';
    return `Up to date · block ${(p.topHeight ?? p.tip ?? 0).toLocaleString()}`;
  }

  /** Stop whatever sync is running (its loop sees a newer generation and returns). */
  cancel() { this.gen++; this.syncing = false; this.note = ''; }

  /** Release a sync that has run far too long, so refresh works again. */
  watchdog() {
    if (this.syncing && Date.now() - (this.started || 0) > WATCHDOG_MS) {
      this.cancel();
      this.error = 'Sync took too long. Tap to retry.';
      this.app.render();
    }
  }

  stopHistory() {
    const p = { ...(this.progress || {}) };
    if (Number.isInteger(p.nextHeight)) { p.floor = p.nextHeight + 1; this.saveProgress(p); }
    this.cancel();
  }

  /** Settings → Rescan history: look back `days`. Returns a message for the toast. */
  rescan(days) {
    const p = { ...(this.progress || {}) };
    const tip = this.tip || p.topHeight;
    if (!tip) return 'Sync first, then rescan';
    p.floor = birthdayHeight(Date.now() - Number(days) * 864e5, tip);
    if (!Number.isInteger(p.nextHeight) || p.nextHeight < p.floor) p.nextHeight = Math.min(Number.isInteger(p.nextHeight) ? p.nextHeight : tip, tip);
    if (p.nextHeight < p.floor) return 'Already checked that far back';
    if (this.app.account.keys) this.app.account.keys.fresh = false;
    p.manual = true; // the person asked for this range, even before the scan server's first block
    this.saveProgress(p);
    this.run(12, { older: true });
    return 'Rescanning…';
  }

  async tipHeight() {
    const base = this.app.servers.base();
    const res = await fetch(`${base}blocks/tip/height`);
    if (!res.ok) throw new Error(`Could not reach ${new URL(base).host}.`);
    return Number(await res.text());
  }

  /**
   * One sync pass. `budget` limits the blocks scanned; `older` skips new blocks and the balance refresh
   * (used by the history loop while the balance is still fresh).
   */
  async run(budget = 6, { older = false } = {}) {
    const app = this.app, keys = app.account.keys;
    if (!keys || this.syncing) return;
    const gen = ++this.gen;
    const live = () => gen === this.gen;
    const fundDue = !older || Date.now() - (app.coins.publicAt || 0) > 60000; // history loops reuse a fresh balance
    this.syncing = true; this.error = null; this.started = Date.now(); this.note = fundDue ? 'Checking balance…' : 'Checking for payments…';
    app.render();
    try {
      if (fundDue) {
        app.fees.refresh().catch(() => {});
        // the Public balance never waits on (or fails with) the Shielded scan
        try { await app.coins.syncPublic(); this.fundError = null; } catch (e) { this.fundError = e.message; }
        if (!live()) return;
        this.note = 'Checking for payments…'; app.render(); // show the Public balance right away
      }
      await this.scanForward(budget, { older, live });
    } catch (err) {
      if (live()) this.error = /timeout/i.test(err.message) ? 'The blockchain servers are not responding. Will retry.' : /fetch|network/i.test(err.message) ? 'Could not reach the network.' : `Scan paused: ${err.message}. Will retry.`;
    } finally {
      if (live()) await this.finish(fundDue);
    }
  }

  async scanForward(budget, { older, live }) {
    const app = this.app, keys = app.account.keys, net = app.state.net, srv = this.scanServer;
    const tip = await this.tipHeight();
    this.tip = tip;
    const p = { ...(this.progress || {}) };
    if (!Number.isInteger(p.topHeight)) p.topHeight = Number.isInteger(p.tip) ? p.tip : tip;
    if (!Number.isInteger(p.nextHeight)) p.nextHeight = p.topHeight;
    if (!Number.isInteger(p.floor)) p.floor = keys.fresh ? Math.max(0, tip - 2) : keys.birthday ? birthdayHeight(keys.birthday, tip) : 0;
    p.scannedBlocks = p.scannedBlocks || 0;
    // Mainnet restore: the automatic history scan stops where the scan server starts. Older blocks
    // through public servers need 100+ requests each and get rate-limited; Settings → Rescan still does it.
    let holdHistory = this.holdHistory = false;
    // a restored phrase may have Shielded coins from before the date picked ("Never used" included):
    // with the scan server, look back to its first block once. It takes seconds.
    if (net === 'main' && keys.restored && !p.deepDone && srv.url()) {
      const info = await srv.status();
      if (info && info.network === 'main' && Number.isInteger(info.start)) {
        p.deepDone = true;
        if (p.floor > info.start) { p.floor = info.start; if (!Number.isInteger(p.nextHeight) || p.nextHeight < p.floor - 1) p.nextHeight = p.topHeight; }
      }
    }
    if (net === 'main' && !p.manual && p.floor > 0 && p.nextHeight >= p.floor) {
      const info = await srv.status();
      const start = info && info.network === 'main' ? info.start : srv.url() ? null : tip - 144;
      if (start == null) holdHistory = this.holdHistory = true; // scan server unreachable right now: try again next sync
      else if (p.floor < start) p.floor = Math.min(start, p.nextHeight + 1);
    }
    // The scan server is usually a block or two behind the tip for a minute after each block. Wait for it
    // (next sync picks those up) rather than scanning them through public servers: that took minutes.
    const sInfo = srv.url() ? await srv.status() : null;
    const top = srv.servesNet(sInfo) && sInfo.height < tip && tip - sInfo.height <= 12 ? sInfo.height : tip;
    if (top < tip && p.nextHeight > top && p.nextHeight >= p.floor) holdHistory = this.holdHistory = true;
    let scanned = 0;
    const save = () => { this.saveProgress({ ...p, updatedAt: Date.now() }); app.coins.save(); app.render(); };
    // scan server set but not answering: only a couple of blocks per sync through public servers, so the wallet stays responsive
    const fwdBudget = older ? 0 : srv.url() && !sInfo ? 2 : Math.max(budget, 24);
    const todo = Math.min(fwdBudget, Math.max(0, top - p.topHeight));
    while (!older && p.topHeight < top && scanned < fwdBudget && live()) {
      const n = Math.min(srv.url() ? 6 : 2, top - p.topHeight, fwdBudget - scanned);
      this.note = `Scanning block ${(p.topHeight + 1).toLocaleString()} · ${scanned + 1}/${todo}`; app.render();
      await app.scanner.scanBlocks(Array.from({ length: n }, (_, i) => p.topHeight + 1 + i));
      p.topHeight += n; p.scannedBlocks += n; scanned += n;
      save();
    }
    const history = p.floor > 0 && p.nextHeight >= p.floor;
    const oldBudget = history ? Math.max(budget, srv.url() ? 240 : 30) : budget;
    while (!holdHistory && p.nextHeight >= p.floor && scanned < oldBudget && live()) {
      this.note = history ? `Restoring history · ${(p.nextHeight - p.floor + 1).toLocaleString()} blocks left` : `Checking older block ${p.nextHeight.toLocaleString()}`; app.render();
      const n = Math.min(history ? (srv.url() ? 12 : 3) : 1, p.nextHeight - p.floor + 1, oldBudget - scanned);
      await app.scanner.scanBlocks(Array.from({ length: n }, (_, i) => p.nextHeight - i), { cut: history });
      p.nextHeight -= n; p.scannedBlocks += n; scanned += n;
      save();
    }
    this.saveProgress({ ...p, updatedAt: Date.now() });
  }

  /** The steps that never depend on the block scan succeeding, then the next history round. */
  async finish(fundDue) {
    const app = this.app;
    // (history loops skip them while the balance is fresh: fewer requests, less rate-limiting)
    if (fundDue) {
      for (const step of app.afterSyncSteps()) { try { await step(); } catch {} }
    } else { try { app.coins.save(); } catch {} }
    this.syncing = false; this.note = '';
    if (app.approvals.active) app.approvals.prepare();
    app.render();
    // the token server runs on its own, after the wallet sync has finished
    if (app.tokenServer.url()) app.tokens.refreshIndexer().then(() => app.render(), () => app.render());
    // restoring with a birthday: keep working back through history while the wallet is open
    const q = this.progress;
    if (!this.error && !this.holdHistory && q && q.floor > 0 && q.nextHeight >= q.floor && app.state.lockState === 'open') {
      setTimeout(() => { if (!this.syncing) this.run(12, { older: true }); }, 1500);
    }
  }
}
