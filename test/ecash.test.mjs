// Ecash (Cashu). Unit checks always run; the end-to-end part runs against a local test mint when one is up
// (nutshell with the FakeWallet backend on 127.0.0.1:3338, which pays its own invoices).
import test from 'node:test';
import assert from 'node:assert/strict';
import { walletApp, Keyring } from './helpers/wallet-app.mjs';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import http from 'node:http';
import { PaymentRequest, Wallet, signMintQuote } from '@cashu/cashu-ts';
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
  await assert.rejects(a.reclaim(a.unclaimed()[0].id), /until .*take it back/, 'locked to B: A waits for the refund time');

  // B claims exactly 300 (the fee was included by the sender)
  const got = await b.receive(s.token);
  assert.equal(got.amount, 300);
  assert.equal(got.locked, true);
  await assert.rejects(b.receive(s.token), /already claimed/);
  await a.checkSent();
  assert.equal(a.unclaimed().length, 0);

  // a locked token B never claims comes back to A after the refund time (NUT-11 locktime + refund key)
  const late = await a.send({ url: MINT, amount: 40, lockTo: appB.account.pubAddr(), refundAfter: -60 });
  assert.ok(peekToken(late.token).locks.includes(a.myLock), 'past its locktime, the refund key (A) can claim too');
  assert.equal((await a.reclaim(a.unclaimed()[0].id)).amount, 40);

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

const creq = ({ amount, mints, post, lock, memo = 'Article #42' }) => new PaymentRequest(
  post ? [{ type: 'post', target: post }] : undefined, 'req1', amount, 'sat', mints, memo, true,
  lock ? { kind: 'P2PK', data: lock, tags: [] } : undefined).toEncodedRequest();

test('payment requests (NUT-18): read, refuse what MASKED cannot do', () => {
  const app = walletApp(Keyring.fromMnemonic(A, '', 'main'));
  const e = new EcashBook(app);
  const r = e.parseRequest(creq({ amount: 21, mints: [MINT], post: 'https://shop.example/pay' }));
  assert.deepEqual([r.amount, r.mints, r.post, r.memo, r.id], [21, [MINT], 'https://shop.example/pay', 'Article #42', 'req1']);
  assert.throws(() => e.parseRequest(creq({ amount: 21, post: 'http://shop.example/pay' })), /insecure/);
  assert.throws(() => e.parseRequest(new PaymentRequest([{ type: 'nostr', target: 'nprofile1x' }], 'x', 5, 'sat').toEncodedRequest()), /Nostr/);
  assert.throws(() => e.parseRequest(new PaymentRequest(undefined, 'x', 5, 'usd').toEncodedRequest()), /usd/);
  assert.throws(() => e.parseRequest('creqAnope'), /not a Cashu payment request/);
});

test('dapp payments with a test mint: pick a mint, pay a request in-band, by POST, and locked', { skip: !up && 'no local test mint' }, async () => {
  globalThis.fetch = realFetch;
  const app = walletApp(Keyring.fromMnemonic(generateMnemonic(wordlist), '', 'main'));
  const e = new EcashBook(app);
  await e.addMint(MINT);
  const q = await e.topUp({ url: MINT, amount: 1000 });
  await e.claimQuote(q.quote);

  assert.equal(e.pickMint(100), MINT);
  assert.equal(e.pickMint(100, [MINT + '/']), MINT, 'mint lists compare in tidy form');
  assert.throws(() => e.pickMint(100, ['https://other.mint']), /only takes ecash from other\.mint/);
  assert.throws(() => e.pickMint(5000), /Not enough ecash/);

  // a shop that redeems what it is sent
  const shop = new Wallet(MINT, { unit: 'sat' }); await shop.loadMint();
  const shopPub = lockKeyOf(walletApp(Keyring.fromMnemonic(A, '', 'main')).account.pubAddr());
  const sum = (ps) => ps.reduce((x, p) => x + Number(String(p.amount)), 0);
  // in-band: the token comes back to the page, which redeems it
  const r1 = await e.payRequest(e.parseRequest(creq({ amount: 21, mints: [MINT] })), MINT);
  assert.equal(r1.payload.id, 'req1');
  assert.equal(sum(await shop.receive(r1.token)), 21);

  // POST: the payload is delivered to the payee's server
  let got = null;
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got = JSON.parse(b); res.writeHead(200).end('{}'); }); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const post = `http://127.0.0.1:${srv.address().port}/pay`;
  const r2 = await e.payRequest(e.parseRequest(creq({ amount: 34, post })), MINT);
  assert.equal(r2.delivered, true);
  assert.equal(got.mint, MINT); assert.equal(got.id, 'req1'); assert.equal(got.unit, 'sat');
  assert.equal(sum(await shop.receive(got.proofs)), 34);

  // a failed POST keeps the ecash takeable
  srv.close();
  await assert.rejects(e.payRequest(e.parseRequest(creq({ amount: 10, post })), MINT), /still yours/);
  assert.equal(e.unclaimed()[0].amount, 10);
  assert.equal((await e.reclaim(e.unclaimed()[0].id)).amount, 10);

  // a request locked to the payee's key: only that key can claim it
  const r3 = await e.payRequest(e.parseRequest(creq({ amount: 13, lock: shopPub })), MINT);
  assert.deepEqual(peekToken(r3.token).locks, [shopPub]);
  await assert.rejects(shop.receive(r3.token), /Witness|signature/i);
  await assert.rejects(e.reclaim(e.unclaimed()[0].id), /only its owner|can't be taken back/);
});

test('the Taproot-lock spec test vectors (docs/NUT-taproot-lock.md) hold', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1');
  const { sha256 } = await import('@noble/hashes/sha256');
  const { hexToBytes, bytesToHex } = await import('@noble/hashes/utils');
  const f = Keyring.fromMnemonic(A, '', 'main').funding('main');
  assert.equal(f.address, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  assert.equal(lockKeyOf(f.address), '02a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c');
  assert.equal(f.outputPriv, '1553fe90c9173e7cb804530fa5486997b1b2dffee10cae5f8d31c0bc6bd89109');
  const secret = '["P2PK",{"nonce":"859d4935c4907062a6297cf4e663e2835d90d97ecdd510745d32f6816323a41f","data":"02a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c","tags":[["locktime","1893456000"],["refund","0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]]}]';
  const msg = sha256(new TextEncoder().encode(secret));
  assert.equal(bytesToHex(msg), '4e05f4ac7cb6d0674bd10ee143416582e48ee4839380ce8221f498a1bdda93ac');
  const sig = schnorr.sign(msg, hexToBytes(f.outputPriv), new Uint8Array(32));
  assert.equal(bytesToHex(sig), 'c5ae78fc9288c8c72c0e0f41d8386437b0be0aafc5792cafa670c213b57487a65410986655679aafde7bcbc75ed2f36ad17245017b3aac2863f2e7591a23894d');
  assert.ok(schnorr.verify(sig, msg, hexToBytes(f.outputX)));
});

test('top up with BTC (NUT-30): deposit address, confirmed deposits become ecash, then pay Lightning', { skip: !up && 'no local test mint' }, async () => {
  globalThis.fetch = realFetch;
  const { startOnchainMint } = await import('./helpers/onchain-mint.mjs');
  const app = walletApp(Keyring.fromMnemonic(generateMnemonic(wordlist), '', 'main'));
  const e = new EcashBook(app);
  const om = await startOnchainMint({ upstream: MINT, address: (i) => app.account.pubAddr().slice(0, -6) + String(i).padStart(6, 'q') });
  try {
    // a Lightning-only mint has no deposit address
    await e.addMint(MINT);
    assert.equal(e.onchain(MINT), null);
    await assert.rejects(e.depositAddress(MINT), /doesn't take Bitcoin deposits/);

    await e.addMint(om.url);
    assert.deepEqual(e.onchain(om.url), { min: 1000, max: 0, confirmations: 1 });
    const d = await e.depositAddress(om.url);
    assert.ok(d.request && d.method === 'onchain');
    assert.equal((await e.depositAddress(om.url)).quote, d.quote, 'one address per mint, reused');
    assert.equal(om.quotes.get(d.quote).pubkey, e.quotePub, 'locked to the quote key');
    assert.notEqual(e.quotePub.slice(2), e.myLock.slice(2), 'not the Public address key');

    // sent, not confirmed yet: shown as pending, nothing to mint
    await e.noteDeposit(d.quote, { txid: 'a'.repeat(64), amount: 5000 });
    assert.equal(e.pendingDeposits().length, 1);
    assert.equal(await e.claimQuote(d.quote), 0);

    // confirmed: 5,000 sats of ecash, and the deposit is no longer pending
    await fetch(`${om.url}/test/pay`, { method: 'POST', body: JSON.stringify({ quote: d.quote, amount: 5000 }) });
    assert.equal(await e.claimQuote(d.quote), 5000);
    assert.equal(e.balance(om.url), 5000);
    assert.equal(e.pendingDeposits().length, 0);
    assert.equal(await e.claimQuote(d.quote), 0, 'nothing is minted twice');

    // a second deposit to the same address adds more
    await e.noteDeposit(d.quote, { txid: 'b'.repeat(64), amount: 2000 });
    await fetch(`${om.url}/test/pay`, { method: 'POST', body: JSON.stringify({ quote: d.quote, amount: 2000 }) });
    assert.equal(await e.claimQuote(d.quote), 2000);

    // someone else can't mint from our quote: the mint wants our quote key's signature
    const thief = new Wallet(om.url, { unit: 'sat' }); await thief.loadMint();
    await fetch(`${om.url}/test/pay`, { method: 'POST', body: JSON.stringify({ quote: d.quote, amount: 1000 }) });
    const st = await thief.checkMintQuoteOnchain(d.quote);
    await assert.rejects(thief.mintProofs('onchain', 1000, st, { privkey: '1'.repeat(64) }), /No private key matches/, 'cashu-ts refuses');
    const outputs = [{ amount: 1000, id: thief.keysetId, B_: e.myLock }];
    const forged = await fetch(`${om.url}/v1/mint/onchain`, { method: 'POST', body: JSON.stringify({ quote: d.quote, outputs, signature: signMintQuote('1'.repeat(64), d.quote, outputs) }) });
    assert.equal(forged.status, 400, 'and so does the mint');
    assert.equal(await e.claimQuote(d.quote), 1000, 'and the owner still gets it');

    // BTC → Lightning: pay an invoice from the ecash that came from BTC
    const other = new EcashBook(walletApp(Keyring.fromMnemonic(generateMnemonic(wordlist), '', 'main')));
    await other.addMint(om.url);
    const inv = await other.topUp({ url: om.url, amount: 3000 });
    await e.pay(await e.quotePay({ url: om.url, invoice: inv.request }));
    assert.equal(await other.claimQuote(inv.quote), 3000);
  } finally { om.close(); }
});
