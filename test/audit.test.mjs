// Fixes from the 28 Oct 2026 review: locking reaches every wallet page, confirmed Shielded change becomes
// spendable, LEAF lookups don't expose Shielded addresses by default, and LEAF state never leaks across accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1';
import { MaskedApp, walletApp, Keyring } from './helpers/wallet-app.mjs';
import { EPOCH_KEY } from '../src/app/LockController.mjs';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
let reloads = 0;
globalThis.location.reload = () => { reloads++; };

test('locking in one page drops the keys in every other open page', async () => {
  const a = new MaskedApp(), b = new MaskedApp();
  for (const app of [a, b]) { app.render = () => {}; app.lock.useSecret({ words: WORDS }); app.state.lockState = 'open'; }
  let sessionWrites = 0;
  b.lock.session.set = async () => { sessionWrites++; };
  assert.ok(!b.lock.lockedElsewhere());
  reloads = 0;
  await a.lock.lockNow();
  assert.ok(globalThis.localStorage.getItem(EPOCH_KEY), 'a new lock epoch');
  assert.ok(b.lock.lockedElsewhere(), 'the other page sees it');
  b.lock.touch();
  assert.equal(b.lock.secret, null, 'keys gone from the other page');
  assert.equal(b.state.wallet, null);
  assert.equal(sessionWrites, 0, 'and it never writes the session back');
  assert.equal(reloads, 2, 'both pages reload');
  // a page unlocked after the lock is fine
  const c = new MaskedApp(); c.render = () => {}; c.lock.useSecret({ words: WORDS });
  assert.ok(!c.lock.lockedElsewhere());
});

test('a session written under an older lock epoch is refused at boot', async () => {
  const app = new MaskedApp(); app.render = () => {};
  app.vault.read = () => ({ v: 1 });
  let cleared = 0;
  app.lock.session.get = async () => ({ words: WORDS, expires: Date.now() + 60000, epoch: 'old' });
  app.lock.session.clear = async () => { cleared++; };
  globalThis.document ??= { querySelector: () => null };
  await app.lock.boot().catch(() => {});
  assert.equal(app.lock.secret, null);
  assert.equal(app.state.lockState, 'locked');
  assert.equal(cleared, 1);
});

test('a Shielded coin added unconfirmed becomes confirmed when the scan server finds it', async () => {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', 'main'));
  const output = 'ab'.repeat(32), txid = 'cd'.repeat(32);
  app.coins.shielded = [{ key: `${txid}:1`, txid, vout: 1, sats: 5000, output, tweak: '01'.repeat(32), label: null, pending: true }];
  app.scanServer.block = async () => ({ txs: [[txid, 'tw', [[1, output, 5000]]]] });
  app.scanner.scanMany = async () => [[0, [{ output, tweak: '01'.repeat(32), label: null }]]];
  await app.scanner.scanBlockFromServer(900000, {});
  assert.equal(app.coins.shielded.length, 1, 'not added twice');
  assert.equal(app.coins.shielded[0].pending, false);
});

test('LEAF: Shielded addresses are only looked up when known to hold LEAF, or when opted in', () => {
  const keys = Keyring.fromMnemonic(WORDS, '', 'main');
  const app = walletApp(keys);
  const coin = (k, sats, t) => ({ key: k, txid: k.repeat(32), vout: 0, sats, tweak: t.repeat(32), output: hex.encode(schnorr.getPublicKey(hex.decode(keys.outputPriv(t.repeat(32))))) });
  app.coins.shielded = [coin('a', 330, '01'), coin('b', 330, '02'), coin('c', 50_000, '03')];
  const leaf = app.leaf;
  leaf.setScanShielded(false);
  assert.deepEqual(leaf.lookupCoins().map((c) => c.key), [], 'default: no Shielded address leaves the wallet');
  leaf.remember(app.account.codec.trAddress(app.coins.shielded[1].output));
  assert.deepEqual(leaf.lookupCoins().map((c) => c.key), ['b'], 'only the one we sent LEAF to');
  leaf.setScanShielded(true);
  assert.deepEqual(leaf.lookupCoins().map((c) => c.key), ['a', 'b'], 'opted in: small coins, never big BTC coins');
  leaf.setScanShielded(false);
});

test('LEAF: switching account clears its balances, and a refresh started before is thrown away', async () => {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', 'main'));
  const leaf = app.leaf;
  let release;
  const gate = new Promise((r) => { release = r; });
  leaf.fetch = async (url) => {
    await gate;
    const body = String(url).endsWith('/status') ? { network: 'bitcoin', token: { tick: 'LEAF' }, indexer: { synced: true } } : { leaf: { balance: '999', decimals: 8 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  app.servers.base = () => 'https://x.invalid/';
  const p = leaf.refresh(true);
  app.state.wallet = Keyring.fromMnemonic(WORDS, '', 'main', 1); // Account 2
  app.loadWalletData();
  assert.equal(leaf.pub, null, 'nothing carried over');
  release(); await p;
  assert.equal(leaf.pub, null, 'the old refresh did not write Account 1’s balance into Account 2');
  await assert.rejects(leaf.build({ from: 'public', to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '1', rate: 2 }), /Checking your LEAF/);
});
