// Ecash (Cashu). Unit checks always run; the end-to-end part runs against a local test mint when one is up
// (nutshell with the FakeWallet backend on 127.0.0.1:3338, which pays its own invoices).
import test from 'node:test';
import assert from 'node:assert/strict';
import { walletApp, Keyring } from './helpers/wallet-app.mjs';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { EcashBook, lockKeyOf, normalizeMint, peekToken } from '../src/ecash/EcashBook.mjs';

const A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MINT = 'http://127.0.0.1:3338';
const realFetch = globalThis.fetch;

test('mint addresses: https only (plain http just for this computer), tidy form', () => {
  assert.equal(normalizeMint('mint.example.com/Bitcoin/'), 'https://mint.example.com/Bitcoin');
  assert.equal(normalizeMint('http://127.0.0.1:3338'), MINT);
  assert.throws(() => normalizeMint('http://evil.example'), /https/);
  assert.throws(() => normalizeMint('https://u:p@mint.example'), /not a mint/);
  assert.throws(() => normalizeMint(''), /Enter/);
});

test('lock keys: a bc1p address gives its key; other addresses are refused', () => {
  const app = walletApp(Keyring.fromMnemonic(A, '', 'main'));
  const f = app.account.funding();
  assert.equal(lockKeyOf(app.account.pubAddr()), '02' + f.outputX);
  assert.equal(lockKeyOf('02' + f.outputX), '02' + f.outputX);
  assert.throws(() => lockKeyOf('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), /bc1p/);
  assert.throws(() => lockKeyOf('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), /bc1p/);
  assert.throws(() => peekToken('hello'), /cashuA or cashuB/);
});

test('watch-only and demo wallets have no ecash', () => {
  const app = walletApp(Keyring.fromMnemonic(A, '', 'main'));
  assert.equal(new EcashBook(app).on, true);
  app.state.wallet = Keyring.fromKeys(5n, Keyring.fromMnemonic(A).Bspend.toRawBytes(true), 'keys');
  assert.equal(new EcashBook(app).on, false);
});

const up = await realFetch(`${MINT}/v1/info`).then((r) => r.ok).catch(() => false);

test('end to end with a test mint: top up, locked send, claim, take back, pay, restore', { skip: !up && 'no local test mint' }, async () => {
  globalThis.fetch = realFetch;
  // fresh wallets each run: the test mint keeps its records between runs
  const wA = generateMnemonic(wordlist), wB = generateMnemonic(wordlist);
  const appA = walletApp(Keyring.fromMnemonic(wA, '', 'main'));
  const a = new EcashBook(appA);
  await a.addMint(MINT);
  assert.equal(a.total(), 0);

  // top up over Lightning (the test mint pays its own invoice)
  const q = await a.topUp({ url: MINT, amount: 2000 });
  assert.match(q.request, /^lnbc/);
  assert.equal(await a.claimQuote(q.quote), 2000);
  assert.equal(a.total(), 2000);

  // stored encrypted: no proof secret readable in storage
  const raw = appA.store.get(a.key);
  assert.ok(raw && !raw.includes('secret') && !raw.includes(MINT), 'ecash is stored encrypted');

  // send 300 locked to B's Public address
  const appB = walletApp(Keyring.fromMnemonic(wB, '', 'main'));
  const b = new EcashBook(appB);
  const s = await a.send({ url: MINT, amount: 300, lockTo: appB.account.pubAddr() });
  const peek = peekToken(s.token);
  assert.deepEqual(peek.locks, [b.myLock]);
  assert.ok(a.total() < 1700 && a.total() >= 1690, `A keeps the rest minus a small fee (${a.total()})`);
  await assert.rejects(a.receive(s.token), /someone else/, 'the sender cannot claim a token locked to B');
  await assert.rejects(a.reclaim(a.unclaimed()[0].id), /only its owner/);

  // B claims exactly 300 (the fee was included by the sender)
  const got = await b.receive(s.token);
  assert.equal(got.amount, 300);
  assert.equal(got.locked, true);
  await assert.rejects(b.receive(s.token), /already claimed/);
  await a.checkSent();
  assert.equal(a.unclaimed().length, 0);

  // an unlocked token nobody claims can be taken back
  const before = a.total();
  const s2 = await a.send({ url: MINT, amount: 100 });
  assert.ok(a.total() < before - 100);
  const back = await a.reclaim(a.unclaimed()[0].id);
  assert.equal(back.amount, 100);
  assert.ok(peekToken(s2.token).locks.length === 0);

  // pay a Lightning invoice: B asks for 150 sats, A pays it from ecash
  const inv = await b.topUp({ url: MINT, amount: 150 });
  const quote = await a.quotePay({ url: MINT, invoice: inv.request });
  assert.equal(quote.amount, 150);
  const aBefore = a.total();
  await a.pay(quote);
  assert.ok(a.total() <= aBefore - 150 && a.total() > aBefore - 160, `A paid 150 plus a small fee (${aBefore} → ${a.total()})`);
  assert.equal(await b.claimQuote(inv.quote), 150);
  assert.equal(b.total(), 450);

  // restore A on a fresh install from the recovery phrase
  const total = a.total();
  const appA2 = walletApp(Keyring.fromMnemonic(wA, '', 'main'));
  appA2.store.remove(a.key);
  const a2 = new EcashBook(appA2);
  await a2.addMint(MINT);
  assert.equal(a2.total(), 0);
  assert.equal(await a2.restore(), total);
  assert.equal(a2.total(), total);
  await a2.send({ url: MINT, amount: 10 }); // after a restore, new outputs don't collide

  // reinstalled without restoring: the first top-up collides, MASKED restores by itself and carries on
  appA2.store.remove(a2.key);
  const a3 = new EcashBook(appA2);
  await a3.addMint(MINT);
  const q3 = await a3.topUp({ url: MINT, amount: 100 });
  assert.equal(await a3.claimQuote(q3.quote), 100);
  assert.ok(a3.total() >= total - 15 + 100, `old ecash found again on the way (${a3.total()})`);
});
