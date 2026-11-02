// Ecash (Cashu): bearer tokens a mint issues against bitcoin. Instant, private between users, and held by the
// mint: ecash is an IOU of that mint, so MASKED keeps it small and says so.
// - Proofs are stored encrypted (AES-GCM, key derived from this account's keys), never in clear.
// - Outputs are deterministic (NUT-13) from a per-account seed, so ecash can be restored from the recovery phrase.
// - "Lock to an address" (NUT-11): a token locked to a bc1p… address can only be claimed by that address's key.
import { PaymentRequest, Wallet, getEncodedToken, getTokenMetadata, getP2PKExpectedWitnessPubkeys } from '@cashu/cashu-ts';
import { bech32m } from '@scure/base';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { secp256k1 } from '@noble/curves/secp256k1';
import { fromHex, toHex } from '../core/bytes.mjs';

const enc = new TextEncoder(), dec = new TextDecoder();
/** Above this, Ecash shows a reminder that a mint holds the bitcoin. */
export const ECASH_SOFT_LIMIT = 100_000;
/** A token locked to someone else comes back to the sender's key after this long if they never claim it (NUT-11 refund). */
export const REFUND_AFTER = 7 * 86400;
const n = (a) => Number(String(a ?? 0));
/** Proofs as plain JSON (cashu-ts amounts are objects). */
const plain = (ps) => ps.map((p) => ({ ...p, amount: n(p.amount) }));
export const sumAmt = (ps) => (ps || []).reduce((a, p) => a + n(p.amount), 0);

/** "mint.example.com/Bitcoin/" → "https://mint.example.com/Bitcoin". Plain http only for this computer. */
export function normalizeMint(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter a mint address.');
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That is not a mint address.'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('Mints must use https://.');
  if (u.username || u.password || u.search || u.hash) throw new Error('That is not a mint address.');
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/**
 * The 33-byte public key (hex) a token is locked to, from a bc1p…/tb1p… address or a hex public key.
 * A taproot address holds an x-only key; BIP 340 signatures only use x, so "02" + x is that key.
 */
export function lockKeyOf(to) {
  const t = String(to || '').trim();
  if (/^0[23][0-9a-f]{64}$/i.test(t)) return t.toLowerCase();
  let d;
  try { d = bech32m.decode(t.toLowerCase(), 120); } catch { throw new Error('Lock to a bc1p… address (or leave it empty).'); }
  if (!['bc', 'tb', 'bcrt'].includes(d.prefix) || d.words[0] !== 1) throw new Error('Only bc1p… addresses can hold a lock.');
  const x = bech32m.fromWords(d.words.slice(1));
  if (x.length !== 32) throw new Error('Only bc1p… addresses can hold a lock.');
  return '02' + toHex(x);
}

/** What a pasted token is, before receiving it: mint, amount, and who it is locked to. */
export function peekToken(text) {
  const t = String(text || '').trim().replace(/^cashu:/i, '');
  if (!/^cashu[AB]/.test(t)) throw new Error('Paste an ecash token (it starts with cashuA or cashuB).');
  let m;
  try { m = getTokenMetadata(t); } catch { throw new Error('That ecash token is damaged.'); }
  const locks = [...new Set(m.incompleteProofs.flatMap((p) => { try { return getP2PKExpectedWitnessPubkeys(p.secret); } catch { return []; } }))];
  return { token: t, mint: normalizeMint(m.mint), amount: n(m.amount), unit: m.unit || 'sat', locks };
}

export class EcashBook {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app @param {{ makeWallet?: (url: string, o: any) => any }} [o] */
  constructor(app, o = {}) {
    this.app = app;
    this.makeWallet = o.makeWallet || ((url, opts) => new Wallet(url, opts));
    this.reset();
  }

  reset() {
    this.data = null;      // decrypted state, in memory only while unlocked
    this.loading = null;
    this.wallets = new Map();
    this.loadedFor = '';
    this.busy = '';
    this.polls = new Set();
    this.resumedFor = '';
  }

  get account() { return this.app.account; }
  /** Ecash needs a private key: not for watch-only or the public demo wallet. */
  get on() { const k = this.account.keys; return !!k && k.source !== 'example' && !!this.account.funding()?.outputPriv; }
  get key() { return `wren.ecash.${this.account.id}`; }
  /** This account's secret, the root of the storage key, the restore seed and the lock key. */
  get secret() { return fromHex(this.account.funding().outputPriv); }
  get seed() { return hmac(sha512, enc.encode('MASKED ecash seed v1'), this.secret); }
  /** The key tokens are locked to when sent to this wallet: the Public address's key. */
  get myLock() { return '02' + this.account.funding().outputX; }
  get myLockAddr() { return this.account.pubAddr(); }
  /** The key on-chain deposit quotes are locked to (NUT-20): its own key, so it links to no address. */
  get quotePriv() {
    const d = BigInt('0x' + toHex(sha256(new Uint8Array([...enc.encode('MASKED ecash quote key v1'), ...this.secret])))) % secp256k1.CURVE.n;
    return d.toString(16).padStart(64, '0');
  }
  get quotePub() { return toHex(secp256k1.getPublicKey(this.quotePriv, true)); }

  async cryptoKey() {
    const raw = sha256(new Uint8Array([...enc.encode('MASKED ecash storage v1'), ...this.secret]));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  /** Decrypt this account's ecash (once per account). */
  async load() {
    if (!this.on) return null;
    if (this.loadedFor === this.key && this.data) return this.data;
    if (this.loading && this.loadedFor === this.key) return this.loading;
    this.loadedFor = this.key; this.wallets.clear();
    const key = this.key;
    this.loading = (async () => {
      const blank = { v: 1, mints: [], proofs: {}, counters: {}, sent: [], quotes: [] };
      const box = this.app.store.getJson(key);
      let d = blank;
      if (box?.ct) {
        const plainText = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(box.iv) }, await this.cryptoKey(), fromHex(box.ct));
        d = { ...blank, ...JSON.parse(dec.decode(plainText)) };
      }
      if (this.loadedFor === key) this.data = d;
      return d;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async save() {
    if (!this.data) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.cryptoKey(), enc.encode(JSON.stringify(this.data)));
    this.app.store.setJson(this.key, { v: 1, iv: toHex(iv), ct: toHex(new Uint8Array(ct)) });
  }

  // ---- reading ----
  get mints() { return this.data?.mints || []; }
  proofsAt(url) { return this.data?.proofs[url] || []; }
  balance(url) { return sumAmt(this.proofsAt(url)); }
  total() { return this.mints.reduce((a, m) => a + this.balance(m.url), 0); }
  /** Tokens sent but not yet claimed by anyone (they can still be taken back). */
  unclaimed() { return (this.data?.sent || []).filter((s) => !s.claimed); }
  mintName(url) { return this.mints.find((m) => m.url === url)?.name || url.replace(/^https?:\/\//, ''); }

  /** A cashu-ts wallet for one mint: deterministic outputs, counters kept (encrypted) with the proofs. */
  async wallet(url) {
    await this.load();
    if (this.wallets.has(url)) return this.wallets.get(url);
    const d = this.data, save = () => this.save();
    const counterSource = {
      async reserve(id, count) { const start = d.counters[id] || 0; if (count > 0) { d.counters[id] = start + count; await save(); } return { start, count }; },
      async reserveRange(id, start, count) { d.counters[id] = Math.max(d.counters[id] || 0, start + count); await save(); return { start, count }; },
      async advanceToAtLeast(id, next) { if ((d.counters[id] || 0) < next) { d.counters[id] = next; await save(); } },
      async setNext(id, next) { d.counters[id] = next; await save(); },
      async snapshot() { return { ...d.counters }; },
    };
    const w = this.makeWallet(url, { unit: 'sat', bip39seed: this.seed, counterSource });
    await w.loadMint();
    this.wallets.set(url, w);
    // what the mint offers: on-chain deposits (NUT-30) need its "onchain" mint method and NUT-20
    const rec = this.mints.find((m) => m.url === url);
    if (rec) {
      const oc = EcashBook.onchainOf(w);
      if (JSON.stringify(rec.onchain || null) !== JSON.stringify(oc)) { rec.onchain = oc; await this.save(); }
    }
    return w;
  }

  /** The mint's on-chain deposit terms ({ min, confirmations }), or null when it has none. */
  static onchainOf(w) {
    try {
      const info = w.getMintInfo(), m = info.isSupported(4), sig = info.isSupported(20);
      const p = !m.disabled && m.params?.find((x) => x.method === 'onchain' && x.unit === 'sat');
      if (!p || !sig?.supported) return null;
      return { min: n(p.min_amount) || 0, max: n(p.max_amount) || 0, confirmations: Number(p.options?.confirmations) || 0 };
    } catch { return null; }
  }
  onchain(url) { return this.mints.find((m) => m.url === url)?.onchain || null; }

  /**
   * Run a mint request. If the mint already knows the outputs, this device's counters are behind (a reinstall
   * without restore, or another device): restore from the mint first, which finds the right counter and any
   * ecash this device lost track of, then try again. The mint refuses the whole request, so nothing is lost.
   */
  async fresh(w, fn) {
    const url = [...this.wallets].find(([, x]) => x === w)?.[0];
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= 4 || !/outputs are pending|already (been )?signed|blinded message.*(signed|pending)/i.test(e.message) || !w.keysetId) throw e;
        if (i === 0 && url) await this.restoreMint(url).catch(() => {});
        else await w.counters.advanceToAtLeast(w.keysetId, (await w.counters.peekNext(w.keysetId)) + 50 * 2 ** i);
      }
    }
  }

  // ---- changing ----
  async addMint(input) {
    const url = normalizeMint(input);
    await this.load();
    const w = await this.wallet(url); // proves the mint answers and speaks sat ecash
    if (!this.mints.some((m) => m.url === url)) {
      let name = '';
      try { name = String((await w.mint.getInfo())?.name || '').slice(0, 40); } catch {}
      this.data.mints.push({ url, name, onchain: EcashBook.onchainOf(w) });
      this.data.proofs[url] ||= [];
      await this.save();
    }
    return url;
  }

  async removeMint(url) {
    await this.load();
    if (this.balance(url)) throw new Error('Move the ecash out of this mint first.');
    if (this.pendingDeposits().some((d) => d.url === url)) throw new Error('A deposit to this mint is still on its way.');
    this.data.mints = this.data.mints.filter((m) => m.url !== url);
    delete this.data.proofs[url];
    await this.save();
  }

  async setProofs(url, list) {
    this.data.proofs[url] = plain(list);
    await this.save();
  }

  /** Receive a pasted token: swapped at its mint for fresh ecash only this wallet knows. */
  async receive(text) {
    const t = peekToken(text);
    if (t.unit !== 'sat') throw new Error('Only sat ecash is supported.');
    if (t.locks.length && !t.locks.some((k) => k.slice(2) === this.myLock.slice(2))) throw new Error('This token is locked to someone else\'s address. Only they can claim it.');
    await this.load();
    if (!this.mints.some((m) => m.url === t.mint)) await this.addMint(t.mint);
    const w = await this.wallet(t.mint);
    let got;
    try {
      got = await this.fresh(w, () => w.receive(t.token, t.locks.length ? { privkey: toHex(this.secret) } : {}));
    } catch (e) {
      throw new Error(/already spent|spent/i.test(e.message) ? 'This token was already claimed.' : e.message);
    }
    await this.setProofs(t.mint, [...this.proofsAt(t.mint), ...got]);
    // a token we sent and took back
    for (const s of this.data.sent) if (s.token === t.token) s.claimed = 'reclaimed';
    await this.save();
    return { amount: sumAmt(got), fee: t.amount - sumAmt(got), mint: t.mint, locked: !!t.locks.length };
  }

  /**
   * Make a token of `amount` sats from one mint. With `lockTo`, only that bc1p… address can claim it.
   * The receiver gets exactly `amount`: the mint's fee for their claim is included.
   */
  async send({ url, amount, lockTo = '', p2pk = null, label = '', refundAfter = REFUND_AFTER }) {
    await this.load();
    const amt = Math.floor(Number(amount));
    if (!(amt > 0)) throw new Error('Enter an amount in sats.');
    const pubkey = lockTo ? lockKeyOf(lockTo) : '';
    const foreign = !!pubkey && pubkey.slice(2) !== this.myLock.slice(2);
    const refundAt = foreign ? Math.floor(Date.now() / 1000) + refundAfter : 0;
    // locked to someone else: if they never claim it, this wallet's key can after `refundAfter`
    const lock = p2pk || (pubkey ? (foreign ? { pubkey, locktime: refundAt, refundKeys: [this.myLock] } : { pubkey }) : null);
    if (amt > this.balance(url)) throw new Error(`Not enough ecash at ${this.mintName(url)}.`);
    const w = await this.wallet(url);
    let r;
    try {
      r = await this.fresh(w, () => w.send(amt, this.proofsAt(url), { includeFees: true }, lock ? { send: { type: 'p2pk', options: lock } } : undefined));
    } catch (e) { await this.repair(url); throw new Error(/fee|enough|insufficient/i.test(e.message) ? 'Not enough ecash to cover the mint fee.' : e.message); }
    if (!r.send?.length) throw new Error('Could not make that amount. Try a slightly different one.');
    const token = getEncodedToken({ mint: url, proofs: r.send, unit: 'sat' });
    await this.setProofs(url, r.keep);
    this.data.sent.unshift({ id: toHex(sha256(enc.encode(token))).slice(0, 16), url, token, amount: amt, lockTo: lockTo || (p2pk ? 'locked by request' : ''), refundAt, label, at: Date.now(), claimed: '' });
    this.data.sent = this.data.sent.slice(0, 50);
    await this.save();
    return { token, proofs: plain(r.send), amount: amt, fee: sumAmt(r.send) - amt };
  }

  /**
   * The mint to pay `amount` from: one of `allowed` (the payee's list, any when empty) where this wallet holds
   * enough, the fullest first. A little room is kept for the mint's input fee.
   */
  pickMint(amount, allowed = []) {
    const ok = (allowed || []).map((u) => { try { return normalizeMint(u); } catch { return ''; } }).filter(Boolean);
    const list = this.mints.filter((m) => !ok.length || ok.includes(m.url)).map((m) => m.url).sort((a, b) => this.balance(b) - this.balance(a));
    const url = list.find((u) => this.balance(u) >= amount + Math.ceil(this.proofsAt(u).length / 10) + 1) || list.find((u) => this.balance(u) >= amount);
    if (url) return url;
    if (ok.length && !this.mints.some((m) => ok.includes(m.url))) throw new Error(`This site only takes ecash from ${ok.map((u) => u.replace(/^https?:\/\//, '')).join(', ')}. You have none there.`);
    throw new Error(`Not enough ecash: ${amount.toLocaleString('en-US')} sats needed.`);
  }

  /**
   * A NUT-18 payment request (creqA… / creqB…): what it asks for and where the ecash goes.
   * Supported: sat amounts, an optional mint list, a P2PK lock, and delivery by HTTP POST or back to the page.
   */
  parseRequest(text) {
    const raw = String(text || '').trim().replace(/^cashu:/i, '');
    let pr;
    try { pr = PaymentRequest.fromEncodedRequest(raw); } catch { throw new Error('That is not a Cashu payment request.'); }
    const amount = n(pr.amount);
    if (!(amount > 0)) throw new Error('The payment request has no amount.');
    if (pr.unit && pr.unit !== 'sat') throw new Error(`The payment request asks for ${pr.unit}; MASKED pays in sats.`);
    let p2pk = null;
    if (pr.nut10) {
      if (pr.nut10.kind !== 'P2PK') throw new Error('This payment request uses a lock MASKED does not support yet.');
      p2pk = pr.toP2PKOptions();
    }
    const post = pr.transport?.find((t) => String(t.type) === 'post')?.target || '';
    if (!post && pr.transport?.length) throw new Error('This payment request is delivered over Nostr, which MASKED does not support yet.');
    if (post) { const u = new URL(post); if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('The payment request sends ecash to an insecure address.'); }
    return { request: raw, id: pr.id || '', amount, mints: pr.mints || [], memo: String(pr.description || '').slice(0, 200), p2pk, post };
  }

  /** Pay a parsed request from `url`: POST the ecash to the payee, or hand it back to the page. */
  async payRequest(r, url) {
    const s = await this.send({ url, amount: r.amount, p2pk: r.p2pk, label: r.memo });
    const payload = { ...(r.id ? { id: r.id } : {}), ...(r.memo ? { memo: r.memo } : {}), mint: url, unit: 'sat', proofs: s.proofs };
    if (!r.post) return { amount: s.amount, mint: url, token: s.token, payload };
    let res;
    try { res = await fetch(r.post, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); } catch { res = null; }
    if (!res?.ok) throw new Error(`The payee's server did not take the payment${res ? ` (${res.status})` : ''}. The ecash is still yours: take it back under "Not claimed yet".`);
    return { amount: s.amount, mint: url, delivered: true };
  }

  /** Take back a token nobody claimed yet (or learn that it was claimed). */
  async reclaim(id) {
    await this.load();
    const s = this.data.sent.find((x) => x.id === id);
    if (!s) throw new Error('That token is gone.');
    if (!this.canReclaim(s)) {
      throw new Error(s.refundAt ? `Locked to another address until ${new Date(s.refundAt * 1000).toLocaleString()}. If they haven't claimed it by then, you can take it back.` : 'Locked to another address: only its owner can claim it, so it can\'t be taken back.');
    }
    try { return await this.receive(s.token); } catch (e) {
      if (/already claimed/.test(e.message)) { s.claimed = 'yes'; await this.save(); }
      throw e;
    }
  }

  /** Can this wallet take a sent token back now? Unlocked, locked to itself, or past its refund time. */
  canReclaim(s, now = Date.now() / 1000) {
    if (!s.lockTo) return true;
    if (s.refundAt) return now >= s.refundAt;
    return /^(bc|tb|bcrt)1p|^0[23]/i.test(s.lockTo) && lockKeyOf(s.lockTo).slice(2) === this.myLock.slice(2);
  }

  /** Which sent tokens were claimed (asks the mint; it learns nothing it didn't already see). */
  async checkSent() {
    await this.load();
    const open = this.unclaimed();
    for (const url of new Set(open.map((s) => s.url))) {
      const w = await this.wallet(url).catch(() => null);
      if (!w) continue;
      for (const s of open.filter((x) => x.url === url)) {
        try {
          const st = await w.checkProofsStates(w.decodeToken(s.token).proofs);
          if (st.length && st.every((x) => x.state === 'SPENT')) s.claimed = 'yes';
        } catch {}
      }
    }
    await this.save();
  }

  /** Drop proofs the mint says are spent (after an interrupted request). */
  async repair(url) {
    try {
      const w = await this.wallet(url), mine = this.proofsAt(url);
      if (!mine.length) return;
      const st = await w.checkProofsStates(mine);
      await this.setProofs(url, mine.filter((_, i) => st[i]?.state !== 'SPENT'));
    } catch {}
  }

  // ---- Lightning in and out ----
  /** A Lightning invoice that adds `amount` sats of ecash at `url` once paid. */
  async topUp({ url, amount }) {
    await this.load();
    const amt = Math.floor(Number(amount));
    if (!(amt > 0)) throw new Error('Enter an amount in sats.');
    const w = await this.wallet(url);
    const q = await w.createMintQuoteBolt11(amt);
    const entry = { url, quote: q.quote, amount: amt, request: q.request, expiry: q.expiry || 0, at: Date.now() };
    this.data.quotes = [entry, ...this.data.quotes.filter((x) => Date.now() - x.at < 86400e3)].slice(0, 10);
    await this.save();
    return entry;
  }

  /**
   * A Bitcoin address at `url` that turns deposits into ecash (NUT-30). One per mint, reused: every confirmed
   * deposit to it adds ecash. The quote is locked to this wallet's quote key, so nobody else can mint from it.
   */
  async depositAddress(url) {
    await this.load();
    const w = await this.wallet(url);
    if (!this.onchain(url)) throw new Error(`${this.mintName(url)} doesn't take Bitcoin deposits. Top up with Lightning instead.`);
    const open = this.data.quotes.find((q) => q.url === url && q.method === 'onchain');
    if (open) return open;
    const q = await w.createMintQuoteOnchain(this.quotePub);
    if (!q.request || q.pubkey?.toLowerCase() !== this.quotePub) throw new Error('The mint answered with an unusable deposit address.');
    const entry = { url, method: 'onchain', quote: q.quote, request: q.request, expiry: q.expiry || 0, at: Date.now(), sent: [] };
    this.data.quotes = [entry, ...this.data.quotes].slice(0, 12);
    await this.save();
    return entry;
  }

  /** Note a deposit sent from this wallet, so Ecash shows it and keeps watching for its confirmation. */
  async noteDeposit(quoteId, { txid, amount }) {
    const q = this.data.quotes.find((x) => x.quote === quoteId);
    if (!q) return;
    q.sent = [...(q.sent || []), { txid, amount, at: Date.now() }].slice(-10);
    await this.save();
  }

  /** Deposits sent and not yet turned into ecash, per mint: [{ url, amount, txid, at }]. */
  pendingDeposits() {
    return (this.data?.quotes || []).filter((q) => q.method === 'onchain').flatMap((q) => (q.sent || []).filter((s) => !s.done).map((s) => ({ ...s, url: q.url, quote: q.quote })));
  }

  /** Has the invoice been paid? Then mint the ecash. Returns the sats added, or 0. */
  async claimQuote(quoteId) {
    await this.load();
    const q = this.data.quotes.find((x) => x.quote === quoteId);
    if (!q) return 0;
    const w = await this.wallet(q.url);
    if (q.method === 'onchain') return this.claimDeposit(q, w);
    const st = await w.checkMintQuoteBolt11(q.quote);
    if (st.state === 'ISSUED') { this.data.quotes = this.data.quotes.filter((x) => x !== q); await this.save(); return 0; }
    if (st.state !== 'PAID') return 0;
    const got = await this.fresh(w, () => w.mintProofsBolt11(q.amount, st));
    await this.setProofs(q.url, [...this.proofsAt(q.url), ...got]);
    this.data.quotes = this.data.quotes.filter((x) => x !== q);
    await this.save();
    return sumAmt(got);
  }

  /** On-chain quote: mint whatever was paid and not issued yet (confirmed deposits). */
  async claimDeposit(q, w) {
    const st = await w.checkMintQuoteOnchain(q.quote);
    const ready = n(st.amount_paid) - n(st.amount_issued);
    if (ready <= 0) return 0;
    const got = await this.fresh(w, () => w.mintProofs('onchain', ready, st, { privkey: this.quotePriv }));
    await this.setProofs(q.url, [...this.proofsAt(q.url), ...got]);
    // mark the oldest deposits that this covers as done
    let left = sumAmt(got);
    for (const s of q.sent || []) if (!s.done && s.amount <= left) { s.done = true; left -= s.amount; }
    await this.save();
    return sumAmt(got);
  }

  /** Watch every open invoice and unconfirmed deposit (after reopening the wallet too). */
  resumeWatching(onPaid) {
    for (const q of this.data?.quotes || []) {
      if (q.method === 'onchain') { if ((q.sent || []).some((s) => !s.done)) this.watchQuote(q.quote, onPaid, { every: 30e3, forMs: 12 * 3600e3 }); }
      else if (Date.now() - q.at < 86400e3) this.watchQuote(q.quote, onPaid);
    }
  }

  /** Check every open invoice every few seconds for a while; `onPaid(sats)` when one lands. */
  watchQuote(quoteId, onPaid, { every = 3000, forMs = 15 * 60e3 } = {}) {
    if (this.polls.has(quoteId)) return;
    this.polls.add(quoteId);
    const until = Date.now() + forMs, key = this.key;
    const tick = async () => {
      if (!this.polls.has(quoteId) || this.key !== key || Date.now() > until) { this.polls.delete(quoteId); return; }
      try { const s = await this.claimQuote(quoteId); if (s) { this.polls.delete(quoteId); onPaid(s); return; } } catch {}
      setTimeout(tick, every);
    };
    setTimeout(tick, every);
  }
  stopWatching() { this.polls.clear(); }

  /** What paying a Lightning invoice from `url` costs, before paying. */
  async quotePay({ url, invoice }) {
    await this.load();
    const inv = String(invoice || '').trim().replace(/^lightning:/i, '');
    if (!/^ln(bc|tb|bcrt)[0-9a-z]+$/i.test(inv)) throw new Error('Paste a Lightning invoice (lnbc…).');
    const w = await this.wallet(url);
    const q = await w.createMeltQuoteBolt11(inv);
    const amount = n(q.amount), reserve = n(q.fee_reserve);
    if (amount + reserve > this.balance(url)) throw new Error(`Not enough ecash at ${this.mintName(url)}: ${amount + reserve} sats needed with the Lightning fee reserve.`);
    return { url, invoice: inv, quote: q, amount, reserve };
  }

  /** Pay the quoted invoice. Unused fee reserve comes back as ecash. */
  async pay(p) {
    const w = await this.wallet(p.url);
    const { keep, send } = await this.fresh(w, () => w.send(p.amount + p.reserve, this.proofsAt(p.url), { includeFees: true }));
    await this.setProofs(p.url, keep);
    let r;
    try { r = await this.fresh(w, () => w.meltProofsBolt11(p.quote, send)); } catch (e) {
      // not paid: the proofs are still ours unless the mint says otherwise
      await this.setProofs(p.url, [...this.proofsAt(p.url), ...send]);
      await this.repair(p.url);
      throw e;
    }
    const state = r.quote?.state;
    if (state && state !== 'PAID') {
      await this.setProofs(p.url, [...this.proofsAt(p.url), ...send]);
      await this.repair(p.url);
      if (state === 'PENDING') throw new Error('The payment is still on its way. Check again in a minute.');
      throw new Error('The mint could not pay that invoice.');
    }
    await this.setProofs(p.url, [...this.proofsAt(p.url), ...(r.change || [])]);
    return { paid: p.amount, fee: sumAmt(send) - p.amount - sumAmt(r.change || []), preimage: r.quote?.payment_preimage || '' };
  }

  /** Find this wallet's ecash again from the recovery phrase (asks each mint for its signatures). */
  async restore() {
    await this.load();
    let found = 0;
    for (const { url } of this.mints) found += await this.restoreMint(url);
    return found;
  }

  /** One mint: the ecash made with this wallet's seed that is still unspent, and counters moved past it. */
  async restoreMint(url) {
    const w = await this.wallet(url);
    const { proofs, lastCounterWithSignature: last } = await w.batchRestore();
    if (last != null && w.keysetId) await w.counters.advanceToAtLeast(w.keysetId, last + 1);
    if (!proofs?.length) return 0;
    const st = await w.checkProofsStates(proofs);
    const have = new Set(this.proofsAt(url).map((p) => p.secret));
    const fresh = proofs.filter((p, i) => st[i]?.state === 'UNSPENT' && !have.has(p.secret));
    if (fresh.length && this.mints.some((m) => m.url === url)) await this.setProofs(url, [...this.proofsAt(url), ...fresh]);
    return sumAmt(fresh);
  }
}
