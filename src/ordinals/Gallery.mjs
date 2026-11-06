// The inscriptions this wallet holds, on both sides (Public and Shielded), read from ord (ordinals.com).
// Which coin holds which inscription is asked per refresh; what an inscription is (type, number) never
// changes and is cached per network.
import { ORD } from '../bitcoin/networks.mjs';

/** fetch with a deadline (the page's fetch, looked up at call time). */
async function fetchWithin(ms, url, init, read) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await read(await globalThis.fetch(url, { ...init, signal: ctl.signal })); } finally { clearTimeout(t); }
}

/** Content types shown as a picture (an <img> never runs scripts, SVG included). */
export const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)\b/i;
/** Content types read as text. */
export const TEXT_TYPE = /^(text\/plain|application\/json|text\/markdown)\b/i;

export class OrdinalGallery {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) {
    this.app = app;
    /** @type {{ id: string, side: 'public'|'shielded', coinKey: string, outpoint: string, sats: number, together: number, runes: number, pending: boolean }[]} */
    this.items = [];
    this.loadedFor = '';
    this.busy = false;
    this.error = '';
    this.texts = new Map(); // id -> text preview
    this.memo = null;
    this.outMemo = null;
  }

  get net() { return this.app.state.net; }
  get base() { return ORD[this.net]; }
  get infoKey() { return `wren.galinfo.${this.net}`; }

  info() {
    if (!this.memo || this.memo.net !== this.net) this.memo = { net: this.net, map: this.app.store.getJson(this.infoKey, {}) || {} };
    return this.memo.map;
  }

  /** { type, number } for an inscription, once known. */
  of(id) { return this.info()[id] || null; }

  contentUrl(id) { return `${this.base}/content/${id}`; }
  previewUrl(id) { return `${this.base}/preview/${id}`; }
  pageUrl(id) { return `${this.base}/inscription/${id}`; }

  /** The account and network the list belongs to. */
  get scope() { return `${this.app.account.id}:${this.net}`; }

  reset() { this.items = []; this.loadedFor = ''; this.error = ''; this.outMemo = null; }

  find(id) { return this.items.find((x) => x.id === id) || null; }

  /** What ord said each coin holds: outpoint -> { ids, runes }. A coin's contents never change, so this is kept for good. */
  outs() {
    const key = `wren.galout.${this.net}`;
    if (!this.outMemo || this.outMemo.key !== key) this.outMemo = { key, map: this.app.store.getJson(key, {}) || {} };
    return this.outMemo.map;
  }

  saveOuts() { this.app.store.setJson(this.outMemo.key, this.outMemo.map); }

  /** The gallery from what is already known, without asking anyone. */
  build() {
    const outs = this.outs();
    /** @type {typeof this.items} */
    const found = [];
    for (const c of this.app.coins.publicThenShielded()) {
      const op = `${c.txid}:${c.vout}`, o = outs[op];
      if (!o || c.example) continue;
      for (const id of o.ids) found.push({ id, side: /** @type {'public'|'shielded'} */ (this.app.coins.shielded.includes(c) ? 'shielded' : 'public'), coinKey: c.key, outpoint: op, sats: c.sats, together: o.ids.length, runes: o.runes, pending: !!c.pending });
    }
    return found;
  }

  /**
   * Ask ord about coins it hasn't answered for yet (each coin is asked once, ever), then what each new
   * inscription is. Refreshing again costs nothing unless new coins arrived.
   */
  async refresh() {
    if (this.busy) return;
    this.busy = true; this.error = '';
    const scope = this.scope;
    try {
      const outs = this.outs();
      const todo = this.app.coins.publicThenShielded().filter((c) => !c.example && c.sats != null && !outs[`${c.txid}:${c.vout}`]);
      const save = (op, j) => {
        const ids = Array.isArray(j?.inscriptions) ? j.inscriptions : [];
        const runes = Array.isArray(j?.runes) ? j.runes.length : j?.runes ? Object.keys(j.runes).length : 0;
        if (!j || j.indexed === false) return; // ord hasn't reached that block yet: ask again later
        outs[op] = { ids, runes };
        this.app.ord.put(op, { ins: ids.length, runes, at: Date.now() });
      };
      let failed = 0;
      for (let i = 0; i < todo.length; i += 100) {
        const ops = todo.slice(i, i + 100).map((c) => `${c.txid}:${c.vout}`);
        let arr = null;
        try { arr = await fetchWithin(12000, `${this.base}/outputs`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(ops) }, (r) => (r.ok ? r.json() : null)); } catch {}
        if (Array.isArray(arr) && arr.length === ops.length) { arr.forEach((j, k) => save(ops[k], j)); continue; }
        // the batch request failed (busy or rate-limited): one coin at a time, gently
        for (let k = 0; k < ops.length; k += 4) {
          await Promise.all(ops.slice(k, k + 4).map(async (op) => {
            try { save(op, await fetchWithin(8000, `${this.base}/output/${op}`, { headers: { Accept: 'application/json' } }, (r) => (r.ok ? r.json() : null))); } catch { failed++; }
          }));
        }
      }
      if (todo.length) this.saveOuts();
      if (scope !== this.scope) return;
      this.items = this.build();
      this.loadedFor = scope;
      const unknown = todo.filter((c) => !outs[`${c.txid}:${c.vout}`]).length;
      if (unknown && failed) this.error = `ordinals.com is busy: ${unknown} coin${unknown === 1 ? '' : 's'} not checked yet. Your other inscriptions are shown; refresh in a minute for the rest.`;
      await this.details(this.items.map((x) => x.id));
    } catch (e) {
      this.error = e.message || 'Could not load your inscriptions.';
    } finally { this.busy = false; }
  }

  /** Type and number of inscriptions not seen before (a few at a time). */
  async details(ids) {
    const todo = [...new Set(ids)].filter((id) => !this.of(id)).slice(0, 120);
    const one = async (id) => {
      try {
        const j = await fetchWithin(8000, `${this.base}/inscription/${id}`, { headers: { Accept: 'application/json' } }, (r) => (r.ok ? r.json() : null));
        if (j) this.info()[id] = { type: String(j.content_type || ''), number: Number.isFinite(j.number) ? j.number : null };
      } catch {}
    };
    for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one));
    if (todo.length) this.app.store.setJson(this.infoKey, this.info());
  }

  /** The first few hundred characters of a text inscription. */
  async text(id) {
    if (this.texts.has(id)) return this.texts.get(id);
    let t = '';
    try { t = await fetchWithin(8000, this.contentUrl(id), {}, (r) => (r.ok ? r.text() : '')); } catch {}
    t = String(t || '').slice(0, 400);
    this.texts.set(id, t);
    return t;
  }

  /** A BRC-20 inscription's short label ("transfer 1,000 ORDI"), or ''. */
  static brc20Label(text) {
    try {
      const j = JSON.parse(text);
      if (j?.p !== 'brc-20' || !j.tick) return '';
      return `${j.op || ''} ${j.amt ? Number(j.amt).toLocaleString('en-US') : ''} ${String(j.tick).toUpperCase()}`.replace(/\s+/g, ' ').trim();
    } catch { return ''; }
  }
}
