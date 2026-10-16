// The private BIP 352 check: which taproot outputs of a transaction belong to this wallet. It runs on
// this device only (WebAssembly libsecp256k1 when available, pure JS otherwise), fed either by the scan
// server's per-block data or by whole blocks from the public servers.
import * as sp from '../crypto/sp-core.mjs';
import { fastReady, fastScanOutputs } from '../crypto/sp-fast.mjs';
import { fromHex } from '../core/bytes.mjs';
import { short } from '../core/format.mjs';
import { fetchRetry } from '../net/http.mjs';
import { ScanWorkerPool } from './ScanWorkerPool.mjs';

const { n2b, Point } = sp.util;

/** An Esplora or Bitcoin Core transaction in one shape. */
export function normTx(t) {
  if (!t || !Array.isArray(t.vin) || !Array.isArray(t.vout)) throw new Error('Each transaction needs vin and vout arrays');
  const esplora = t.vout.some((o) => 'scriptpubkey' in o);
  const vin = t.vin.map((v) => ({
    txid: v.txid, vout: v.vout,
    coinbase: !!(v.is_coinbase || v.coinbase),
    scriptSig: v.scriptsig ?? v.scriptSig?.hex ?? '',
    witness: (v.witness ?? v.txinwitness ?? []).map((h) => fromHex(h)),
    prevoutScript: v.prevout?.scriptpubkey ?? v.prevout?.scriptPubKey?.hex,
  }));
  const vout = t.vout.map((o, i) => ({
    n: o.n ?? i,
    spk: (o.scriptpubkey ?? o.scriptPubKey?.hex ?? '').toLowerCase(),
    sats: esplora ? o.value : o.value != null ? Math.round(o.value * 1e8) : null,
  }));
  return { txid: t.txid ?? t.hash ?? '(no txid)', vin, vout };
}

/** Transactions out of pasted JSON: one tx, a list, a Core getblock … 3 reply or an RPC envelope. */
export function extractTxs(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.tx)) return json.tx;
  if (json && json.result) return extractTxs(json.result);
  return [json];
}

export class ShieldedScanner {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    this.labelMemo = null;
    this.workers = new ScanWorkerPool(() => app.platform.hasExt || app.platform.isApp);
    this.via = null;      // 'server' | 'public': how the last block was scanned
    this.fast = false;    // WebAssembly crypto is on
  }

  get keys() { return this.app.account.keys; }
  get coins() { return this.app.coins; }

  /** Label tweaks for change (0) and every extra label, cached per key set. */
  labelSet() {
    const w = this.keys, ms = [0, ...this.app.state.labels.map((l) => l.m)];
    const key = `${w.Bscan.toHex(true)}:${ms.join(',')}`;
    if (this.labelMemo?.key !== key) this.labelMemo = { key, map: sp.buildLabels(w.bScan, ms), bScan32: n2b(w.bScan), Bspend33: w.Bspend.toRawBytes(true) };
    return this.labelMemo;
  }

  /** BIP 352 check of one transaction's taproot outputs (x-only hex) against its input tweak. */
  scanFor(tweak33, outputs) {
    const L = this.labelSet(), w = this.keys;
    return fastReady() ? fastScanOutputs(tweak33, outputs, L.bScan32, L.Bspend33, L.map) : sp.scanOutputs(Point.fromHex(tweak33), outputs, w.bScan, w.Bspend, L.map);
  }

  /** items: [[tweakHex, [xonlyHex…]], …] → Map(index → found[]), on the workers for big batches. */
  async scanMany(items) {
    if (items.length >= 64 && this.workers.up()) {
      this.workers.setKeys(this.labelSet(), this.keys.bScan);
      try { return await this.workers.scan(items); } catch { /* fall through to this thread */ }
    }
    const res = new Map();
    items.forEach(([tw, outs], i) => { const f = this.scanFor(fromHex(tw), outs); if (f.length) res.set(i, f); });
    return res;
  }

  /** Check one full transaction and add what belongs to us. */
  scanTx(raw, { pending = false } = {}) {
    const tx = normTx(raw);
    if (tx.vin.some((v) => v.coinbase)) return { txid: tx.txid, status: 'skip', why: 'Coinbase transaction' };
    const trOuts = tx.vout.filter((o) => o.spk.length === 68 && o.spk.startsWith('5120'));
    if (!trOuts.length) return { txid: tx.txid, status: 'skip', why: 'No taproot outputs' };
    if (tx.vin.some((v) => v.prevoutScript == null))
      throw new Error(`Transaction ${short(tx.txid, 8)} has no prevout scripts. Use mempool.space API JSON or Bitcoin Core "getrawtransaction <txid> 2".`);
    const pubs = tx.vin.map((v) => sp.inputPubKey(v)).filter(Boolean).map((r) => r.pub);
    const tweak = sp.txTweak(pubs, tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })));
    if (!tweak) return { txid: tx.txid, status: 'skip', why: 'No eligible inputs' };
    const found = this.scanFor(tweak.toRawBytes(true), trOuts.map((o) => o.spk.slice(4)));
    const list = this.coins.shielded;
    for (const f of found) {
      const o = trOuts.find((x) => x.spk.slice(4) === f.output);
      const key = `${tx.txid}:${o.n}`;
      const have = list.find((c) => c.key === key);
      if (have) { if (!pending) have.pending = false; continue; }
      list.push({ key, txid: tx.txid, vout: o.n, sats: o.sats, output: f.output, tweak: f.tweak, label: f.label, example: this.keys.source === 'example', pending });
    }
    return { txid: tx.txid, status: found.length ? 'hit' : 'miss', n: found.length, why: found.length ? '' : 'Nothing for this wallet' };
  }

  /** One block from the scan server; null when it cannot help (the wallet then scans normally). */
  async scanBlockFromServer(height, opts) {
    const j = await this.app.scanServer.block(height, opts);
    if (!j) return null;
    let foundAll;
    try { foundAll = await this.scanMany(j.txs.map(([, tw, outs]) => [tw, outs.map((o) => o[1])])); } catch { return null; }
    let hits = 0;
    const list = this.coins.shielded;
    for (const [idx, found] of foundAll) {
      const [txid, , outs] = j.txs[idx];
      for (const f of found) {
        const o = outs.find((x) => x[1] === f.output);
        const key = `${txid}:${o[0]}`;
        if (list.some((c) => c.key === key)) continue;
        list.push({ key, txid, vout: o[0], sats: o[2], output: f.output, tweak: f.tweak, label: f.label, example: false, pending: false });
        hits++;
      }
    }
    this.via = 'server';
    return hits;
  }

  async scanBlock(height, opts = {}) {
    if (this.app.scanServer.url()) { const n = await this.scanBlockFromServer(height, opts); if (n != null) return n; }
    this.via = 'public';
    const servers = this.app.servers;
    const hash = (await (await fetchRetry(`${servers.base()}block-height/${height}`, `Block ${height}`)).text()).trim();
    // Read the tx count first: esplora pages by 25 and returns 404 past the last page
    // (a block with exactly 25·n txs used to break the scan).
    const info = await (await fetchRetry(`${servers.base()}block/${hash}`, `Block ${height}`)).json();
    const count = Number(info.tx_count) || 0;
    let hits = 0;
    // fetch the 25-tx pages several at a time (spread over the servers), then check each tx locally
    const starts = []; for (let st = 0; st < count; st += 25) starts.push(st);
    let next = 0;
    const worker = async () => {
      while (next < starts.length) {
        const st = starts[next++];
        await servers.limiter.slot();
        let txs;
        try { txs = await (await fetchRetry(`${servers.base()}block/${hash}/txs/${st}`, `Block ${height}`, 5)).json(); }
        finally { servers.limiter.release(); }
        for (const tx of txs) { try { hits += this.scanTx(tx).n || 0; } catch {} }
      }
    };
    await Promise.all(Array.from({ length: Math.min(starts.length, 16) }, worker));
    return hits;
  }

  /** Several blocks at once (pages from all of them share the servers). */
  async scanBlocks(heights, opts) { await Promise.all(heights.map((h) => this.scanBlock(h, opts))); }

  /** Look at a tx we just broadcast so our own Shielded outputs show up immediately. */
  async ingestTx(txid) {
    for (let i = 0; i < 4; i++) {
      try {
        const res = await fetch(`${this.app.servers.base()}tx/${txid}`);
        if (res.ok) { const j = await res.json(); this.scanTx(j, { pending: !j.status?.confirmed }); this.coins.save(); return true; }
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  /** Settings → Find a payment manually: check pasted transaction JSON. */
  scanPasted(text) {
    const txs = extractTxs(JSON.parse(text));
    let hits = 0, errs = 0;
    for (const t of txs) { try { hits += this.scanTx(t).n || 0; } catch { errs++; } }
    this.coins.save();
    return { count: txs.length, hits, errs };
  }
}
