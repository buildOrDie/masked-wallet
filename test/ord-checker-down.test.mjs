// ord unreachable (e.g. its name doesn't resolve): one failed request, then quiet for 10 minutes, not one per coin.
import test from 'node:test';
import assert from 'node:assert/strict';
// the wallet's fetch is bound when its module loads: put the stand-in in place first
let calls = 0;
globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch'); };
const { OrdChecker } = await import('../src/net/OrdChecker.mjs');

test('ord that does not answer at all is asked once, then left alone for 10 minutes', async () => {
  const store = { getJson: () => ({}), setJson() {} };
  const ord = new OrdChecker({ net: () => 'signet', store });
  const coins = ['a', 'b', 'c'].map((ch) => ({ txid: ch.repeat(64), vout: 1, sats: 50_000 }));
  {
    await ord.check(coins);
    assert.equal(calls, 1, 'no per-coin requests after the batch request could not connect');
    await ord.check(coins);
    assert.equal(calls, 1, 'not asked again within 10 minutes');
    // the coins stay spendable on test networks
    assert.equal(coins.some((c) => ord.unverified(c)), false);
  }
});
