// X handles → Shielded addresses. The directory (tokens.maskedwallet.com/v1/x) only says which post to read;
// the wallet reads that post on X itself and checks the author and the address, so the directory cannot
// point a handle at someone else's address.
import { DEFAULT_TOKENS } from '../bitcoin/networks.mjs';
import { asHandle, canonicalPostUrl, oembedUrl, parsePostUrl, verifyPost } from '../social/xpost.mjs';
import { fetchWithin } from './http.mjs';

export const X_ORIGIN = 'https://publish.twitter.com';

export class HandleDirectory {
  /** @param {{ net: () => string, store: any, fetch?: typeof fetch }} o */
  constructor({ net, store, fetch: f }) {
    this.netOf = net;
    this.store = store;
    this.fetch = f || ((input, init) => fetchWithin(12000, input, init));
  }

  /** The directory for this network ('' when there is none: X handles are a Mainnet feature). */
  base() { return (this.store.get(`wren.xdir.${this.netOf()}`) || DEFAULT_TOKENS[this.netOf()] || '').replace(/\/+$/, ''); }
  get network() { return this.netOf() === 'main' ? 'main' : 'test'; }

  async getJson(url, init, what) {
    let r;
    try { r = await this.fetch(url, init); }
    catch (e) { throw new Error(e?.name === 'AbortError' ? `${what} did not answer in time.` : `Can't reach ${what}. Check your connection.`); }
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, ok: r.ok, j };
  }

  /** Read one post on X and check it. */
  async readPost(post, want) {
    const { status, ok, j } = await this.getJson(oembedUrl(post), {}, 'X');
    if (status === 404) throw new Error('That post was deleted, or the link is wrong.');
    if (status === 403) throw new Error('That account is private. Posts must be public.');
    if (!ok) throw new Error(`X did not return the post (${status}). Try again in a minute.`);
    return verifyPost(j, { ...want, network: this.network });
  }

  /** @handle → { handle, address, url, text, date, name }, checked on X. */
  async resolve(input) {
    const handle = asHandle(input);
    if (!handle) throw new Error('Not an X handle.');
    if (!this.base()) throw new Error('Sending to an X handle works on Mainnet.');
    const { status, ok, j } = await this.getJson(`${this.base()}/v1/x/${handle}`, {}, 'the MASKED directory');
    if (status === 404) throw new Error(`@${handle} hasn't claimed a MASKED address yet.`);
    if (!ok || !j?.url) throw new Error(j?.error || `The MASKED directory failed (${status}).`);
    const post = parsePostUrl(j.url);
    if (!post) throw new Error('The directory returned a bad post link.');
    const v = await this.readPost(post, { handle, id: post.id });
    return { ...v, url: canonicalPostUrl(v) };
  }

  /** Claim: check the post is this wallet's (address), then register it. Returns the checked post. */
  async claim(link, address) {
    const post = parsePostUrl(link);
    if (!post) throw new Error('Paste the link to your post, like https://x.com/you/status/123…');
    if (!this.base()) throw new Error('X handles work on Mainnet.');
    const v = await this.readPost(post, { id: post.id, address });
    const url = canonicalPostUrl(v);
    const { ok, status, j } = await this.getJson(`${this.base()}/v1/x/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }, 'the MASKED directory');
    if (!ok) throw new Error(j?.error || `The MASKED directory failed (${status}).`);
    return { ...v, url };
  }

  // ---- the handle this account claimed (per account and network) ----
  mine(accountId) { try { return JSON.parse(this.store.get(`wren.xhandle.${accountId}`) || 'null'); } catch { return null; } }
  saveMine(accountId, v) { this.store.set(`wren.xhandle.${accountId}`, JSON.stringify({ handle: v.handle, url: v.url, address: v.address, at: Date.now() })); }
  forgetMine(accountId) { this.store.remove(`wren.xhandle.${accountId}`); }
}
