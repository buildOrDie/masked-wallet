// window.masked.rgb: a site asks for an RGB invoice or asks MASKED to pay one; both are approved in the wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { walletApp, Keyring } from './helpers/wallet-app.mjs';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ASSET = 'rgb:2dkSTbr-jFhznbPmo-TQ3Kdm9-SWcFsJA-bFZa5Ef-Q8Fy8oo';
const PROXY = 'rpcs://proxy.iriswallet.com/0.2/json-rpc';

function fakeRgb(over = {}) {
  const sent = [], made = [];
  const asset = { assetId: ASSET, ticker: 'MUSD', precision: 2 };
  const r = {
    available: true, exists: true, ready: true, offerable: false, busy: false, phase: '', isMain: false, cloudOn: true, canShareInvoice: true,
    profile: { id: 'public', label: 'Public Signet', invoiceNets: ['signet'], sdk: { transportEndpoint: 'https://proxy.iriswallet.com/0.2/json-rpc' } },
    data: { transfers: { [ASSET]: [] } }, logged: [],
    find: (id) => (id === ASSET ? asset : null),
    amount: (_a, n) => (n / 100).toLocaleString('en-US'),
    bal: () => ({ spendable: 500000 }),
    fee: () => '2', recvType: () => 'blind',
    missingOrigins: async () => [],
    ensure() {}, refresh: async () => {}, cloudSave: async () => true,
    withOutputs: (fn) => fn(),
    logInvoice(x) { r.logged.push(x); },
    service: {
      everBackedUp: true, backupRequired: false,
      decode: async (inv) => ({ recipientId: 'sb:utxob:abc', network: 'signet', assetId: inv.includes('fixed') ? ASSET : undefined, amount: inv.includes('fixed') ? 12345 : 0, transportEndpoints: [PROXY], expirationTimestamp: Math.floor(Date.now() / 1000) + 3600 }),
      checkProxy: async () => {},
      receive: async (o) => { made.push(o); return { invoice: 'rgb:~/~/~/sb:utxob:new', recipientId: 'sb:utxob:new', expirationTimestamp: 1 }; },
      send: async (o) => { sent.push(o); r.data.transfers[ASSET] = [{ batchTransferIdx: 7, status: 'WaitingConfirmations' }]; return { txid: 'ab'.repeat(32), batchTransferIdx: 7 }; },
    },
    sent, made,
    ...over,
  };
  return r;
}

async function prepared(app, method, params) {
  app.approvals.active = { id: 'x', origin: 'https://market.example', method, params, loading: false };
  app.approvals.prepare();
  for (let i = 0; i < 50 && (app.approvals.active.prepBusy || (!app.approvals.active.prep && !app.approvals.active.prepErr)); i++) await new Promise((r) => setTimeout(r, 5));
  return app.approvals.active;
}

function app() {
  const a = walletApp(Keyring.fromMnemonic(WORDS, '', 'signet'));
  // no real waiting for the other side in tests
  a.approvals.rgbWaitBroadcast = async () => 'broadcast';
  return a;
}

test('requestInvoice: shows the amount in tokens and returns a fresh invoice', async () => {
  const a = app(); a.rgb = fakeRgb();
  const req = await prepared(a, 'rgbInvoice', { assetId: ASSET, baseUnits: '150000', expiry: 86400, kind: '' });
  assert.equal(req.prepErr, null);
  assert.equal(req.prep.shown, '1,500 MUSD');
  assert.match(a.ui.views.approve.render(), /1,500 MUSD/);
  const out = await a.approvals.run(req);
  assert.equal(out.invoice, 'rgb:~/~/~/sb:utxob:new');
  assert.deepEqual(a.rgb.made[0], { assetId: ASSET, amount: 150000, durationSeconds: 86400, witness: false });
  assert.equal(a.rgb.logged[0].site, 'market.example');
});

test('requestInvoice: on mainnet the invoice is withheld until it is backed up', async () => {
  const a = app(); a.rgb = fakeRgb({ isMain: true, canShareInvoice: false });
  const req = await prepared(a, 'rgbInvoice', { assetId: '', baseUnits: '', expiry: 86400, kind: 'witness' });
  await assert.rejects(a.approvals.run(req), /backup/i);
});

test('payInvoice: an open-amount invoice uses the amount the site gave, in tokens', async () => {
  const a = app(); a.rgb = fakeRgb();
  const req = await prepared(a, 'rgbPay', { invoice: 'rgb:~/~/~/sb:utxob:abc', assetId: ASSET, amount: '25.5', feeRate: 0 });
  assert.equal(req.prepErr, null);
  assert.equal(req.prep.amount, 2550);
  const out = await a.approvals.run(req);
  assert.equal(out.status, 'broadcast');
  assert.deepEqual(a.rgb.sent[0], { invoice: 'rgb:~/~/~/sb:utxob:abc', assetId: ASSET, amount: '2550', fee: '2', endpoint: PROXY });
});

test('payInvoice: refuses a mismatched amount, an unknown token, more than you have, and a blocked server', async () => {
  let a = app(); a.rgb = fakeRgb();
  assert.match((await prepared(a, 'rgbPay', { invoice: 'rgb:fixed', amount: '1', feeRate: 0 })).prepErr, /does not match/);
  a = app(); a.rgb = fakeRgb();
  assert.match((await prepared(a, 'rgbPay', { invoice: 'rgb:x', assetId: 'rgb:someOtherAssetId000', amount: '1', feeRate: 0 })).prepErr, /don't hold/);
  a = app(); a.rgb = fakeRgb();
  assert.match((await prepared(a, 'rgbPay', { invoice: 'rgb:x', assetId: ASSET, amount: '999999', feeRate: 0 })).prepErr, /up to 5,000/);
  a = app(); a.rgb = fakeRgb({ missingOrigins: async () => ['https://evil.example/json-rpc'] });
  assert.match((await prepared(a, 'rgbPay', { invoice: 'rgb:x', assetId: ASSET, amount: '1', feeRate: 0 })).prepErr, /isn't allowed to reach the transfer server evil\.example/);
});

test('payInvoice: no amount anywhere asks for one on the approval screen', async () => {
  const a = app(); a.rgb = fakeRgb();
  const req = await prepared(a, 'rgbPay', { invoice: 'rgb:x', assetId: ASSET, amount: '', feeRate: 0 });
  assert.equal(req.prep.needAmount, true);
  assert.match(a.ui.views.approve.render(), /data-bind="apRgbAmt"/);
  await assert.rejects(a.approvals.run(req), /amount/i);
  a.state.f.apRgbAmt = '3';
  const out = await a.approvals.run(req);
  assert.equal(out.amount, '300');
});

test('RGB off or not set up: a clear message instead of an approve button', async () => {
  const a = app(); a.rgb = fakeRgb({ available: false, offerable: true });
  const req = await prepared(a, 'rgbInvoice', { assetId: '', baseUnits: '', expiry: 86400, kind: '' });
  assert.match(req.prepErr, /turn on RGB/i);
  assert.match(a.ui.views.approve.render(), /data-approve disabled/);
});
