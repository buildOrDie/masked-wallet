import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletRgb } from '../src/rgb/WalletRgb.mjs';

const P = WalletRgb.prototype;
const nft = (id, ticker, name, settled, future) => ({ assetId: id, ticker, name, balance: { settled, future, spendable: settled } });

test('NFTs are grouped by collection, each sorted by number, the biggest collection first', () => {
  const me = { data: { groups: { uda: [nft('a', 'RATS', 'RATS #10', 1, 1), nft('b', 'FROG', 'FROG #1', 1, 1), nft('c', 'RATS', 'RATS #2', 1, 1), nft('d', 'RATS', 'RATS #5', 0, 1), nft('e', 'RATS', 'RATS #7', 0, 0)] } } };
  me.nfts = P.nfts.bind(me);
  const cols = P.collections.call(me);
  assert.deepEqual(cols.map((c) => [c.key, c.list.map((a) => a.name)]), [['RATS', ['RATS #2', 'RATS #5', 'RATS #10']], ['FROG', ['FROG #1']]]);
});

test('an incoming NFT counts as incoming (its assignment is NonFungible, not an amount)', () => {
  const a = nft('d', 'RATS', 'RATS #5', 0, 1);
  const me = { data: { transfers: { d: [{ kind: 'ReceiveWitness', status: 'WaitingConfirmations', assignments: ['NonFungible'] }] } }, doubles: () => [], isDropped: () => false };
  const b = P.bal.call(me, a);
  assert.equal(b.settled, 0);
  assert.equal(b.future, 1);
  assert.equal(b.spendable, 0);
});
