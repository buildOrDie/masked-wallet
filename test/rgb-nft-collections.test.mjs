import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletRgb } from '../src/rgb/WalletRgb.mjs';

const P = WalletRgb.prototype;
const nft = (id, ticker, name, settled, future) => ({ assetId: id, ticker, name, balance: { settled, future, spendable: settled } });

test('NFTs are grouped by collection, each sorted by number, the biggest collection first', () => {
  const me = { data: { groups: { uda: [nft('a', 'RATS', 'RATS #10', 1, 1), nft('b', 'FROG', 'FROG #1', 1, 1), nft('c', 'RATS', 'RATS #2', 1, 1), nft('d', 'RATS', 'RATS #5', 0, 1), nft('e', 'RATS', 'RATS #7', 0, 0)] } } };
  me.nfts = P.nfts.bind(me);
  me.nftTrust = () => new Map();
  const cols = P.collections.call(me);
  assert.deepEqual(cols.map((c) => [c.key, c.verified, c.list.map((a) => a.name)]), [['u:RATS', false, ['RATS #2', 'RATS #5', 'RATS #10']], ['u:FROG', false, ['FROG #1']]]);
});

test('a whitelisted collection groups exactly its asset IDs, first; a copy with the same ticker stays apart, unverified', async () => {
  const { trustMap } = await import('../src/rgb/WalletRgb.mjs');
  const me = { data: { groups: { uda: [nft('a', 'RATS', 'RATS #10', 1, 1), nft('fake', 'RATS', 'RATS #1', 1, 1), nft('c', 'RATS', 'RATS #2', 1, 1)] } } };
  me.nfts = P.nfts.bind(me);
  me.nftTrust = () => trustMap([{ slug: 'rats2', name: 'RATS', ticker: 'RATS', assetIds: ['a', 'c'].map((x) => `rgb:${x}`) }, { slug: 'BAD SLUG', name: 'X', assetIds: ['rgb:fake'] }]);
  me.data.groups.uda = me.data.groups.uda.map((x) => ({ ...x, assetId: `rgb:${x.assetId}` }));
  const cols = P.collections.call(me);
  assert.deepEqual(cols.map((c) => [c.key, c.name, c.verified, c.list.map((a) => a.name)]), [['v:rats2', 'RATS', true, ['RATS #2', 'RATS #10']], ['u:RATS', 'RATS', false, ['RATS #1']]]);
});

test('an incoming NFT counts as incoming (its assignment is NonFungible, not an amount)', () => {
  const a = nft('d', 'RATS', 'RATS #5', 0, 1);
  const me = { data: { transfers: { d: [{ kind: 'ReceiveWitness', status: 'WaitingConfirmations', assignments: ['NonFungible'] }] } }, doubles: () => [], isDropped: () => false };
  const b = P.bal.call(me, a);
  assert.equal(b.settled, 0);
  assert.equal(b.future, 1);
  assert.equal(b.spendable, 0);
});

test('a listed NFT says so instead of failing to send', () => {
  const a = { assetId: 'd', ticker: 'RATS', name: 'RATS #5', nft: true };
  const me = { service: { instantListings: () => [{ assetId: 'd', stage: 'moving' }, { assetId: 'x', stage: 'ready' }] }, isNft: P.isNft };
  me.openListing = P.openListing.bind(me);
  assert.match(P.listedWhy.call(me, a), /RATS #5 is in Your listings \(going live\).*Cancel the listing first/);
  me.service.instantListings = () => [{ assetId: 'd', stage: 'cancelled' }];
  assert.equal(P.listedWhy.call(me, a), '');
});

test('a send whose finish fails drops the begun transfer, so the next try can use its outputs', async () => {
  const { LiteWallet } = await import('../src/rgb/LiteWallet.mjs');
  const calls = [];
  const me = {
    sign: (p) => `signed:${p}`, save: async () => calls.push('save'),
    lib: { WasmWallet: { psbtTxid: () => 'AB'.repeat(32) } },
    wallet: { sendEnd: async () => { throw new Error('proxy refused'); }, outputLocks: () => [], abandonColoring: (t) => calls.push(`abandon:${t}`) },
  };
  await assert.rejects(LiteWallet.prototype.endOrForget.call(me, {}, 'p'), /proxy refused/);
  assert.deepEqual(calls, [`abandon:${'AB'.repeat(32)}`, 'save']);
  // one the wallet recorded as a transfer is left alone
  calls.length = 0;
  me.wallet.outputLocks = () => [{ txid: 'ab'.repeat(32) }];
  await assert.rejects(LiteWallet.prototype.endOrForget.call(me, {}, 'p'), /proxy refused/);
  assert.deepEqual(calls, []);
});

test('an NFT on its way: its verified collection\'s picture from MASKED\'s server, shown and kept only if it matches', async () => {
  const { LiteWallet } = await import('../src/rgb/LiteWallet.mjs');
  const { memoryMediaStore } = await import('../src/rgb/mediaStore.mjs');
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const added = [];
  const me = Object.create(LiteWallet.prototype);
  Object.assign(me, { w: { mediaFile: () => null, addMediaFile: (b) => { added.push(b.length); return digest; } }, media: memoryMediaStore() });
  Object.defineProperty(me, 'engineV1', { value: true });
  const fetchOk = async () => new Response(bytes);
  const src = await me.nftImage({ digest, mime: 'image/png' }, fetchOk, { url: 'https://scan.maskedwallet.com/nft-media/signet/rats2/5' });
  assert.match(src, /^data:image\/png;base64,/);
  assert.deepEqual(added, [7]);
  assert.equal((await me.media.get(digest)).length, 7, 'kept: shown at once next time');
  // another file than the NFT's: not shown; and no slow asks to old transfer servers with this engine
  let asked = 0;
  const other = async () => { asked++; return new Response(new Uint8Array([9])); };
  assert.equal(await me.nftImage({ digest, mime: 'image/png' }, other, { url: 'https://x/1' }), null);
  assert.equal(asked, 1);
});
