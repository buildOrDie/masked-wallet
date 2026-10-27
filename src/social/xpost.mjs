// Pay an X handle: a Shielded address posted publicly on X is checked through X's public embed endpoint
// (publish.twitter.com/oembed). The post's author is the handle, the post's text holds the address.
// No dependencies: the handle directory server uses this same file.

/** X handles: 1 to 15 letters, digits or _. Returns the lowercase handle, or null. */
export function asHandle(s) {
  const m = String(s ?? '').trim().match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1].toLowerCase() : null;
}

/** "@fred" in a To field (the @ is what makes it a handle and not a typo'd address). */
export const looksLikeHandle = (s) => /^@[A-Za-z0-9_]{1,15}$/.test(String(s ?? '').trim());

/** A post link (x.com or twitter.com) → { handle, id }, or null. */
export function parsePostUrl(url) {
  const m = String(url ?? '').trim().match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})(?:[/?#].*)?$/i);
  return m ? { handle: m[1].toLowerCase(), id: m[2] } : null;
}

export const canonicalPostUrl = ({ handle, id }) => `https://x.com/${handle}/status/${id}`;

/** The embed lookup for a post (any handle works in the path: X finds the post by its id). */
export const oembedUrl = (post) => `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(`https://twitter.com/${post.handle}/status/${post.id}`)}`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all; }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}
const plain = (html) => decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+\n/g, '\n').trim();

/** Silent payment addresses in a text (sp1… on Mainnet, tsp1… on test networks), lowercased, no repeats. */
export function spAddresses(text) {
  const found = String(text ?? '').match(/(?<![a-z0-9])t?sp1[02-9ac-hj-np-z]{100,}(?![a-z0-9])/gi) || [];
  return [...new Set(found.map((a) => a.toLowerCase()))];
}

/**
 * What an oEmbed reply says: { handle, id, text, date, name }. Throws when it is not a post embed.
 * handle comes from author_url (X keeps it current when someone renames), id from the post link.
 */
export function readOembed(j) {
  if (!j || typeof j !== 'object' || typeof j.html !== 'string') throw new Error('X did not return this post.');
  const author = String(j.author_url || '').match(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
  if (!author) throw new Error('X did not say who wrote this post.');
  const link = String(j.url || '').match(/\/status(?:es)?\/(\d{5,25})/);
  const p = j.html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  if (!link || !p) throw new Error('X did not return this post.');
  const after = j.html.slice(j.html.indexOf(p[0]) + p[0].length);
  const dates = [...after.matchAll(/<a\b[^>]*>([^<]*)<\/a>/gi)];
  return { handle: author[1].toLowerCase(), id: link[1], text: plain(p[1]), date: dates.length ? plain(dates[dates.length - 1][1]) : '', name: plain(String(j.author_name || '')) };
}

/**
 * Check a post: written by `handle` (when given), mentioning @masked_wallet, with exactly one silent payment address,
 * on the right network.
 * Returns { handle, id, address, text, date, name }.
 * @param {any} oembed the publish.twitter.com reply
 * @param {{ handle?: string|null, id?: string|null, network: 'main'|'test', address?: string|null }} want
 */
export function verifyPost(oembed, want) {
  const post = readOembed(oembed);
  if (want.id && post.id !== want.id) throw new Error('X returned a different post.');
  if (want.handle && post.handle !== want.handle) throw new Error(`This post is by @${post.handle}, not @${want.handle}.`);
  // opting in: the post mentions @masked_wallet (so an address someone posted for another reason is never "their @")
  if (!/(^|[^A-Za-z0-9_])@masked_wallet(?![A-Za-z0-9_])/i.test(post.text)) throw new Error('This post does not mention @masked_wallet. Use the post MASKED writes for you.');
  const list = spAddresses(post.text);
  if (!list.length) throw new Error('This post has no Shielded address (sp1…) in it.');
  if (list.length > 1) throw new Error('This post has more than one Shielded address. Post just one.');
  const address = list[0];
  if ((address.startsWith('sp1') ? 'main' : 'test') !== want.network) throw new Error(want.network === 'main' ? 'The address in this post is a test-network address.' : 'The address in this post is a Mainnet address.');
  if (want.address && address !== String(want.address).toLowerCase()) throw new Error('The address in this post is not this wallet’s Shielded address.');
  return { ...post, address };
}

/** The post a wallet makes to claim its handle. */
export function claimText(address) {
  return `My private Bitcoin address 🎭\n\n${address}\n\nSend me sats with @masked_wallet: just type my @. Nobody can see what I receive.\n\nmaskedwallet.com`;
}

/** Where people can pay a handle from any browser. */
export const payPageUrl = (handle) => `https://maskedwallet.com/pay/${handle}`;
