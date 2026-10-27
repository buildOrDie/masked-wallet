// Pay an X handle: the wallet reads the post on X itself (oEmbed) and only pays the address in a post written
// by that handle, whatever the directory says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Keyring } from './helpers/wallet-app.mjs';
import { LocalStore } from '../src/core/LocalStore.mjs';
import { MemoryStorage } from './helpers/wallet-app.mjs';
import { asHandle, claimText, looksLikeHandle, parsePostUrl, readOembed, spAddresses, verifyPost } from '../src/social/xpost.mjs';
import { HandleDirectory } from '../src/net/HandleDirectory.mjs';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDR = Keyring.fromMnemonic(WORDS, '', 'main').silentAddress('main');
const OTHER = Keyring.fromMnemonic(WORDS, '', 'main', 1).silentAddress('main');
const TEST_ADDR = Keyring.fromMnemonic(WORDS, '', 'signet').silentAddress('signet');

/** What publish.twitter.com/oembed returns for a post (same shape, line breaks as <br>, links as <a>). */
function oembed({ handle = 'Fred', id = '1850000000000000001', text = claimText(ADDR), name = 'Fred 🎭' } = {}) {
  const body = text.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/@masked_wallet/g, '<a href="https://twitter.com/masked_wallet?ref_src=twsrc%5Etfw">@masked_wallet</a>').replace(/maskedwallet\.com$/, '<a href="https://t.co/abc">maskedwallet.com</a>')).join('<br>');
  return {
    url: `https://twitter.com/${handle}/status/${id}`, author_name: name, author_url: `https://twitter.com/${handle}`,
    html: `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${body}</p>&mdash; ${name} (@${handle}) <a href="https://twitter.com/${handle}/status/${id}?ref_src=twsrc%5Etfw">October 27, 2026</a></blockquote>\n`,
    width: 550, height: null, type: 'rich', provider_name: 'Twitter', version: '1.0',
  };
}

test('handles and post links', () => {
  assert.equal(asHandle('@Fred_01'), 'fred_01');
  assert.equal(asHandle('fred'), 'fred');
  assert.equal(asHandle('@this_is_too_long_x'), null);
  assert.equal(asHandle('@fr ed'), null);
  assert.ok(looksLikeHandle(' @fred '));
  assert.ok(!looksLikeHandle('fred'), 'a bare word is not a handle (could be a half-pasted address)');
  assert.ok(!looksLikeHandle(ADDR));
  assert.deepEqual(parsePostUrl('https://x.com/Fred/status/1850000000000000001?s=46&t=abc'), { handle: 'fred', id: '1850000000000000001' });
  assert.deepEqual(parsePostUrl('twitter.com/fred/status/1850000000000000001'), { handle: 'fred', id: '1850000000000000001' });
  assert.deepEqual(parsePostUrl('https://mobile.twitter.com/fred/statuses/1850000000000000001/photo/1'), { handle: 'fred', id: '1850000000000000001' });
  assert.equal(parsePostUrl('https://evil.com/x.com/fred/status/1850000000000000001'), null);
  assert.equal(parsePostUrl('https://x.com/fred'), null);
});

test('the claim post fits on X and holds exactly the address', () => {
  const t = claimText(ADDR);
  assert.ok([...t].length <= 280, `${[...t].length} characters`);
  assert.deepEqual(spAddresses(t), [ADDR]);
  assert.deepEqual(spAddresses(`a ${ADDR}, b ${ADDR.toUpperCase()}`), [ADDR], 'same address twice counts once');
  assert.deepEqual(spAddresses(`x${ADDR}`), [], 'not inside a longer word');
});

test('reading an embed: author, text with line breaks, date', () => {
  const p = readOembed(oembed());
  assert.equal(p.handle, 'fred');
  assert.equal(p.id, '1850000000000000001');
  assert.equal(p.date, 'October 27, 2026');
  assert.equal(p.text, claimText(ADDR));
  assert.throws(() => readOembed({ error: 'nope' }));
  assert.throws(() => readOembed({ ...oembed(), author_url: 'https://evil.com/fred' }), /who wrote/);
});

test('verifying: right author, one address, right network, our own address when claiming', () => {
  const v = verifyPost(oembed(), { handle: 'fred', network: 'main' });
  assert.equal(v.address, ADDR);
  assert.throws(() => verifyPost(oembed({ handle: 'mallory' }), { handle: 'fred', network: 'main' }), /by @mallory, not @fred/);
  assert.throws(() => verifyPost(oembed({ text: 'gm @masked_wallet' }), { handle: 'fred', network: 'main' }), /no Shielded address/);
  assert.throws(() => verifyPost(oembed({ text: `donate here ${ADDR}` }), { handle: 'fred', network: 'main' }), /mention @masked_wallet/, 'an address posted for another reason is not a claim');
  assert.throws(() => verifyPost(oembed({ text: `${ADDR} @masked_walletx` }), { handle: 'fred', network: 'main' }), /mention @masked_wallet/);
  assert.equal(verifyPost(oembed({ text: `${ADDR}\n@MASKED_WALLET` }), { handle: 'fred', network: 'main' }).address, ADDR);
  assert.throws(() => verifyPost(oembed({ text: `${ADDR}\n${OTHER} @masked_wallet` }), { handle: 'fred', network: 'main' }), /more than one/);
  assert.throws(() => verifyPost(oembed({ text: claimText(TEST_ADDR) }), { handle: 'fred', network: 'main' }), /test-network/);
  assert.throws(() => verifyPost(oembed(), { id: '1850000000000000002', network: 'main' }), /different post/);
  assert.equal(verifyPost(oembed(), { network: 'main', address: ADDR.toUpperCase() }).address, ADDR);
  assert.throws(() => verifyPost(oembed({ text: claimText(OTHER) }), { network: 'main', address: ADDR }), /not this wallet/);
});

/** A directory and X, faked: `posts` by id, `dir` handle → post link. */
function fakeNet({ posts, dir, onClaim = () => {} }) {
  const calls = [];
  const res = (status, j) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(j) });
  const fetch = async (url, init = {}) => {
    calls.push([init.method || 'GET', url]);
    const u = new URL(url);
    if (u.host === 'publish.twitter.com') {
      const id = (u.searchParams.get('url').match(/status\/(\d+)/) || [])[1];
      return posts[id] ? res(200, posts[id]) : res(404, {});
    }
    if (u.pathname === '/v1/x/claim') { onClaim(JSON.parse(init.body)); return res(200, { ok: true }); }
    const h = u.pathname.split('/').pop();
    return dir[h] ? res(200, { handle: h, url: dir[h] }) : res(404, { error: 'not found' });
  };
  return { fetch, calls };
}
const dirOf = (fetch, net = 'main') => new HandleDirectory({ net: () => net, store: (() => { const m = new MemoryStorage(); return new LocalStore(() => m); })(), fetch });

test('resolve @handle: reads the post on X and pays the address in it', async () => {
  const { fetch, calls } = fakeNet({ posts: { '1850000000000000001': oembed() }, dir: { fred: 'https://x.com/fred/status/1850000000000000001' } });
  const h = await dirOf(fetch).resolve('@Fred');
  assert.equal(h.address, ADDR);
  assert.equal(h.handle, 'fred');
  assert.equal(h.url, 'https://x.com/fred/status/1850000000000000001');
  assert.deepEqual(calls.map((c) => new URL(c[1]).host), ['tokens.maskedwallet.com', 'publish.twitter.com']);
});

test('a lying directory cannot redirect a handle', async () => {
  // the directory points @fred at a post by @mallory holding Mallory's address
  const { fetch } = fakeNet({ posts: { '1850000000000000009': oembed({ handle: 'mallory', id: '1850000000000000009', text: claimText(OTHER) }) }, dir: { fred: 'https://x.com/fred/status/1850000000000000009' } });
  await assert.rejects(dirOf(fetch).resolve('@fred'), /by @mallory, not @fred/);
});

test('deleted posts, unknown handles and test networks', async () => {
  const { fetch } = fakeNet({ posts: {}, dir: { fred: 'https://x.com/fred/status/1850000000000000001' } });
  await assert.rejects(dirOf(fetch).resolve('@fred'), /deleted/);
  await assert.rejects(dirOf(fetch).resolve('@nobody'), /hasn't claimed/);
  await assert.rejects(dirOf(fetch, 'signet').resolve('@fred'), /Mainnet/);
});

test('claim: only a post holding this wallet’s address is registered', async () => {
  let sent = null;
  const { fetch } = fakeNet({ posts: { '1850000000000000001': oembed(), '1850000000000000002': oembed({ id: '1850000000000000002', text: claimText(OTHER) }) }, dir: {}, onClaim: (b) => { sent = b; } });
  const d = dirOf(fetch);
  const v = await d.claim('https://x.com/Fred/status/1850000000000000001?s=20', ADDR);
  assert.equal(v.handle, 'fred');
  assert.deepEqual(sent, { url: 'https://x.com/fred/status/1850000000000000001' });
  sent = null;
  await assert.rejects(d.claim('https://x.com/fred/status/1850000000000000002', ADDR), /not this wallet/);
  assert.equal(sent, null, 'nothing registered');
  await assert.rejects(d.claim('not a link', ADDR), /Paste the link/);
  d.saveMine('main:abc', v);
  assert.equal(d.mine('main:abc').handle, 'fred');
  assert.equal(d.mine('main:other'), null);
});
