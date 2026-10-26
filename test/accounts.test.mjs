// Several accounts from one phrase: Account 1 keeps the keys of earlier versions, account N uses the next
// Public address (like UniSat) and its own BIP 352 account; each has its own coins and records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MaskedApp, Keyring } from './helpers/wallet-app.mjs';
import { AccountBook, MAX_ACCOUNTS } from '../src/wallet/AccountBook.mjs';
import { LocalStore } from '../src/core/LocalStore.mjs';
import { MemoryStorage } from './helpers/wallet-app.mjs';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('Account 1 is exactly the earlier wallet; account N is the next BIP 86 address (BIP 86 test vectors)', () => {
  const a0 = Keyring.fromMnemonic(WORDS, '', 'main');
  // the keys every earlier version derived, computed here independently
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(WORDS, ''));
  assert.equal(a0.bScan.toString(16).padStart(64, '0'), Buffer.from(root.derive("m/352'/0'/0'/1'/0").privateKey).toString('hex'));
  assert.equal(a0.funding('main').address, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', 'BIP 86: first receive address');
  const a1 = Keyring.fromMnemonic(WORDS, '', 'main', 1);
  assert.equal(a1.funding('main').address, 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh', 'BIP 86: second receive address = UniSat account 2');
  assert.notEqual(a1.silentAddress('main'), a0.silentAddress('main'), 'its own Shielded address');
  assert.equal(a1.bScan.toString(16).padStart(64, '0'), Buffer.from(root.derive("m/352'/0'/1'/1'/0").privateKey).toString('hex'));
  assert.notEqual(a1.id('main'), a0.id('main'), 'its own records');
  assert.equal(a0.rootFp, a1.rootFp, 'same phrase, same master fingerprint');
  assert.equal(a0.rootFp, root.fingerprint.toString(16).padStart(8, '0'));
  assert.equal(a1.index, 1);
  assert.deepEqual(Keyring.paths('signet', 2), { scan: "m/352'/1'/2'/1'/0", spend: "m/352'/1'/2'/0'/0", funding: "m/86'/1'/0'/0/2" });
  assert.throws(() => Keyring.fromMnemonic(WORDS, '', 'main', -1));
  // a BIP 39 passphrase is a different wallet
  assert.notEqual(Keyring.fromMnemonic(WORDS, 'x', 'main').rootFp, a0.rootFp);
});

test('account list: names, add, rename, hide, and the open one; per phrase', () => {
  const book = new AccountBook(new LocalStore(() => new MemoryStorage()));
  const store = new MemoryStorage();
  const b = new AccountBook(new LocalStore(() => store));
  assert.deepEqual(b.list('aa'), [{ i: 0, name: 'Account 1' }]);
  const e = b.add('aa', 'sats');
  assert.equal(e.i, 1); assert.equal(e.name, 'sats'); assert.equal(e.fresh, true); assert.ok(e.birthday > 0);
  assert.equal(b.add('aa').name, 'Account 3');
  b.rename('aa', 0, '  Main <b>  ');
  assert.equal(b.name('aa', 0), 'Main b', 'no markup in names');
  assert.throws(() => b.rename('aa', 0, '   '), /Enter a name/);
  b.setActive('aa', 1);
  assert.equal(b.active('aa'), 1);
  assert.throws(() => b.hide('aa', 1), /Switch to another/);
  b.hide('aa', 2);
  assert.deepEqual(b.visible('aa').map((a) => a.i), [0, 1]);
  b.setActive('aa', 2);
  assert.equal(b.entry('aa', 2).hidden, false, 'opening a hidden account shows it again');
  assert.deepEqual(b.list('bb'), [{ i: 0, name: 'Account 1' }], 'another phrase has its own list');
  assert.equal(book.active('zz'), 0);
  for (let i = b.list('aa').length; i < MAX_ACCOUNTS; i++) b.add('aa');
  assert.throws(() => b.add('aa'), /Up to/);
});

test('switching accounts: its own addresses and records; new accounts scan from when they were added', async () => {
  globalThis.localStorage.clear();
  const app = new MaskedApp();
  app.render = () => {};
  app.state.net = 'main';
  app.lock.secret = { words: WORDS, passphrase: '', fresh: false, restored: true, birthday: 1 };
  app.state.wallet = app.accountKeys(WORDS, '', 'main', 0);
  app.loadWalletData();
  app.sync.run = async () => {};
  const fp = app.state.wallet.rootFp;
  const id0 = app.account.id, pub0 = app.account.pubAddr();
  app.store.setJson(`wren.fund.${id0}`, { at: 1, coins: [] });
  const e = app.accounts.add(fp, 'sats');
  app.switchAccount(e.i);
  assert.equal(app.account.pubAddr(), 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh');
  assert.notEqual(app.account.id, id0);
  assert.equal(app.state.wallet.fresh, true, 'a new account has no history to look back for');
  assert.equal(app.state.wallet.restored, false);
  assert.equal(app.accounts.active(fp), 1);
  // the network switch keeps the account
  app.setNet('signet');
  assert.equal(app.state.wallet.index, 1);
  assert.match(app.account.pubAddr(), /^tb1p/);
  app.setNet('main');
  app.switchAccount(0);
  assert.equal(app.account.pubAddr(), pub0);
  assert.equal(app.state.wallet.restored, true, 'Account 1 keeps the phrase\'s restore settings');
  assert.equal(app.state.wallet.birthday, 1);
});
