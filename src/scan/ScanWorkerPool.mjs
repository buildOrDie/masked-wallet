// Multi-core scanning: big blocks are split over background workers (one per CPU core, up to 8).

export class ScanWorkerPool {
  /** @param {() => boolean} allowed  workers run only inside the extension or the app */
  constructor(allowed, script = 'scan-worker.js') {
    this.allowed = allowed;
    this.script = script;
    this.workers = [];
    this.ok = null;     // null = not started, then true / false
    this.seq = 0;
    this.jobs = new Map();
    this.keyed = null;  // which keys the workers hold
  }

  get size() { return this.workers.length; }

  /** Start the workers once; false when they cannot run here. */
  up() {
    if (this.ok !== null) return this.ok;
    this.ok = false;
    if (!this.allowed() || typeof Worker === 'undefined') return false;
    try {
      const n = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker(this.script);
        w.onmessage = (e) => {
          const j = this.jobs.get(e.data.id);
          if (!j) return;
          this.jobs.delete(e.data.id);
          if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data.out);
        };
        w.onerror = () => {
          this.ok = false;
          for (const j of this.jobs.values()) j.reject(new Error('worker failed'));
          this.jobs.clear();
        };
        this.workers.push(w);
      }
      this.ok = true;
    } catch { this.ok = false; }
    return this.ok;
  }

  /** Hand the scan keys to every worker (only when they changed). */
  setKeys(labelSet, bScan) {
    if (this.keyed === labelSet.key) return;
    const msg = { type: 'keys', bScan32: labelSet.bScan32, Bspend33: labelSet.Bspend33, bScanHex: bScan.toString(16), labels: [...labelSet.map].map(([hex, l]) => [hex, l.m, l.tweak.toString(16)]) };
    for (const w of this.workers) w.postMessage(msg);
    this.keyed = labelSet.key;
  }

  /** items: [[tweakHex, [xonlyHex…]], …] → Map(index → found[]). Throws when a worker fails. */
  async scan(items) {
    const res = new Map();
    const per = Math.ceil(items.length / this.workers.length);
    await Promise.all(this.workers.map((w, k) => {
      const part = items.slice(k * per, (k + 1) * per);
      if (!part.length) return null;
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.jobs.delete(id); this.ok = false; reject(new Error('worker timeout')); }, 20000);
        this.jobs.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
        w.postMessage({ type: 'scan', id, items: part });
      }).then((out) => { for (const [i, f] of out) res.set(k * per + i, f); });
    }));
    return res;
  }
}
