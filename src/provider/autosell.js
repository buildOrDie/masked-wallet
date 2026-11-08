// Sell automatically (opt-in). The background keeps the list of RGB offers the person approved for automatic
// selling, checks them on the market once a minute, and when a buyer is waiting (or has signed) has the hidden RGB
// page do that one step. Nothing here holds keys: the RGB wallet's key stays in Chrome's session memory (gone when
// Chrome closes), put there by an unlocked MASKED window while the setting is on.

export const AUTO_KEY = 'masked.autosell';        // chrome.storage.local: { [offerId]: entry }
export const AUTO_ON = 'masked.autosell.on';      // chrome.storage.local: true when the setting is on
export const PASS_KEY = 'masked.rgb.agentPass';   // chrome.storage.session: { [profile]: pass }
export const MAX_DAYS = 30;

const okMarket = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };

/** The checked shape of an approved offer. */
export function autoEntry({ offerId, market, token, offer, profile, origin }, now = Date.now()) {
  const id = String(offerId || '');
  if (!/^sw[0-9a-f]{12}$/.test(id)) throw new Error('offerId is not a market offer.');
  if (!okMarket(market)) throw new Error('market must be an https address.');
  if (!/^[0-9a-f]{32,128}$/.test(String(token || ''))) throw new Error('token is missing.');
  const t = { assetId: String(offer?.assetId || ''), amount: String(offer?.amount || ''), priceSats: String(offer?.priceSats || '') };
  if (!/^rgb:/.test(t.assetId) || !/^\d+$/.test(t.amount) || !/^\d+$/.test(t.priceSats)) throw new Error('offer needs assetId, amount and priceSats.');
  return { offerId: id, market: String(market).replace(/\/+$/, ''), token: String(token), terms: t, profile: String(profile || ''), origin: String(origin || ''), at: now, expiresAt: now + MAX_DAYS * 86400_000, status: 'waiting', lastError: '' };
}

/**
 * @param {{ local: { get: (k: string) => Promise<any>, set: (o: object) => Promise<void> }, session: { get: (k: string) => Promise<any> }, fetchFn: typeof fetch, agent: (job: any) => Promise<any>, now?: () => number, badge?: (text: string) => void }} deps
 */
export function createAutoSell({ local, session, fetchFn, agent, now = () => Date.now(), badge = () => {} }) {
  const read = async () => (await local.get(AUTO_KEY))[AUTO_KEY] || {};
  const write = (m) => local.set({ [AUTO_KEY]: m });
  const isOn = async () => !!(await local.get(AUTO_ON))[AUTO_ON];
  const api = async (e, path, body) => {
    const r = await fetchFn(`${e.market}/api/swap/offers/${e.offerId}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-swap-token': e.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `market ${r.status}`), { status: r.status });
    return j;
  };
  let running = false;

  return {
    async add(input) { const e = autoEntry(input, now()); const m = await read(); m[e.offerId] = e; await write(m); return e; },
    async remove(offerId) { const m = await read(); delete m[String(offerId)]; await write(m); },
    async list() { return Object.values(await read()); },
    /**
     * Check every approved offer once. `popupBusy`: steps the hidden page couldn't take because RGB is open in a
     * MASKED window are left for that window (it asks with due()).
     */
    async tick() {
      if (running) return { ran: 0 };
      running = true;
      let ran = 0, problems = 0;
      try {
        if (!(await isOn())) return { ran, off: true };
        const m = await read();
        const passes = (await session.get(PASS_KEY))[PASS_KEY] || {};
        for (const e of Object.values(m)) {
          if (now() > e.expiresAt) { delete m[e.offerId]; continue; }
          let offer;
          try { offer = await api(e, ''); } catch (err) { if (err.status === 404) delete m[e.offerId]; else { e.lastError = err.message; problems++; } continue; }
          if (['DONE', 'CANCELLED'].includes(offer.state) || offer.role !== 'seller') { delete m[e.offerId]; continue; }
          const step = offer.state === 'MATCHED' && offer.session ? 'sale' : offer.state === 'SIGNED' && offer.signedPsbt ? 'complete' : null;
          e.status = offer.state === 'OPEN' ? 'waiting' : step ? 'working' : 'buyer';
          if (!step) { e.lastError = ''; continue; }
          if (this.changed(e, offer)) { e.status = 'stopped'; e.lastError = 'The offer changed after you set it to sell automatically. Finish it by hand.'; problems++; continue; }
          const pass = passes[e.profile];
          if (!pass) { e.status = 'locked'; e.lastError = 'Open MASKED once so it can sell while you are away.'; problems++; continue; }
          try {
            const result = await agent({ step, entry: e, offer, pass });
            if (step === 'sale') await api(e, '/colored', result);
            else { await api(e, '/done', { txid: result.txid }); e.status = 'sold'; e.txid = result.txid; delete m[e.offerId]; }
            e.lastError = ''; ran++;
          } catch (err) {
            const msg = String(err?.message || err);
            if (msg === 'BUSY') { e.status = 'window'; continue; }
            e.lastError = msg; problems++;
          }
        }
        await write(m);
        badge(problems ? '!' : '');
        return { ran, problems };
      } finally { running = false; }
    },
    /** The steps waiting for a MASKED window that has RGB open (the hidden page couldn't take the RGB lock). */
    async due() {
      const out = [];
      for (const e of Object.values(await read())) {
        if (e.status !== 'window') continue;
        try {
          const offer = await api(e, '');
          const step = offer.state === 'MATCHED' && offer.session ? 'sale' : offer.state === 'SIGNED' && offer.signedPsbt ? 'complete' : null;
          if (step && !this.changed(e, offer)) out.push({ step, entry: e, offer });
        } catch { /* next round */ }
      }
      return out;
    },
    changed(e, offer) { const o = offer.offer || {}; return String(o.assetId) !== e.terms.assetId || String(o.amount) !== e.terms.amount || String(o.priceSats) !== e.terms.priceSats; },
    /** A MASKED window did a step: tell the market. */
    async report(offerId, step, result) {
      const m = await read(); const e = m[String(offerId)];
      if (!e) return false;
      if (step === 'sale') await api(e, '/colored', result);
      else { await api(e, '/done', { txid: result.txid }); delete m[e.offerId]; }
      if (m[e.offerId]) { m[e.offerId].status = 'buyer'; m[e.offerId].lastError = ''; }
      await write(m);
      return true;
    },
  };
}
