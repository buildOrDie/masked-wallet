import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { SignetWallet } from './SignetWallet.mjs';
import { loadRgbSdk } from './load-sdk.mjs';
import { esc, fmtBtc } from '../core/format.mjs';
import { baseUnits, testFee } from './config.mjs';
const service = new SignetWallet({ loadSdk: loadRgbSdk, storage: localStorage });
const $ = id => /** @type {any} */ (document.getElementById(id));
let ready = false, pending = null, releaseLock = null, activity = Date.now();
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const note = text => { $('status').textContent = text; };
function controls() {
  document.querySelectorAll('[data-wallet]').forEach(el => { /** @type {HTMLButtonElement} */ (el).disabled = !ready; });
  $('open').textContent = service.exists ? 'Unlock test wallet' : 'Create test wallet';
  $('password').value = '';
  $('backup-state').textContent = service.backupRequired ? 'Required' : 'Saved';
  $('backup-note').textContent = service.backupRequired ? 'Export an encrypted backup before the next transaction.' : 'Keep your latest encrypted backup and password.';
}
async function refresh() {
  const data = await service.snapshot();
  $('address').textContent = data.address;
  $('assets').textContent = json(data.groups);
  $('balance').textContent = json(data.btc);
  const settled = Number(data.btc?.vanilla?.settled || 0) + Number(data.btc?.colored?.settled || 0);
  $('btc-amount').textContent = fmtBtc(settled);
  const assets = Object.values(data.groups || {}).flat().filter(asset => asset && typeof asset === 'object');
  $('asset-list').innerHTML = assets.length ? assets.map(asset => `<div class="asset-row"><span class="asset-icon">R</span><span><b>${esc(asset.ticker || asset.name || 'RGB asset')}</b><small>Test asset · ${esc(String(asset.assetId || '').slice(0, 16))}…</small></span><span class="asset-value">${esc(String(asset.balance?.settled ?? '—'))}</span></div>`).join('') : '<p class="muted small">No test assets received yet.</p>';
  $('history').textContent = json(data.transfers);
  controls();
}
async function task(fn) {
  if (service.busy) return;
  document.querySelectorAll('button').forEach(el => { el.disabled = true; });
  try { await fn(); note('Ready · Utexo Signet'); }
  catch (e) { note(e.message || 'RGB operation failed. Lock and reopen before retrying.'); }
  finally { document.querySelectorAll('button').forEach(el => { el.disabled = false; }); controls(); }
}
async function open(backup = null) {
  const password = $('password').value;
  $('password').value = '';
  if (!password) throw new Error('Enter the test-wallet password.');
  await service.open(password, () => generateMnemonic(wordlist, 128), backup);
  ready = true; $('gate').hidden = true; $('wallet').hidden = false;
  await refresh();
}
$('open').addEventListener('click', () => task(() => open()));
$('restore').addEventListener('click', () => task(async () => {
  const file = $('restore-file').files[0];
  if (!file || file.size > 40 * 1024 * 1024) throw new Error('Choose a MASKED RGB backup file under 40 MB.');
  await open(JSON.parse(await file.text()));
}));
$('refresh').addEventListener('click', () => task(refresh));
$('utxos').addEventListener('click', () => task(async () => { await service.createUtxos($('fee').value); await refresh(); }));
$('receive').addEventListener('click', () => task(async () => {
  const result = await service.receive($('asset-id').value.trim());
  $('invoice').textContent = result.invoice; controls();
}));
$('review').addEventListener('click', () => task(async () => {
  const params = { invoice: $('recipient').value.trim(), assetId: $('send-asset').value.trim(), amount: $('amount').value, fee: $('fee').value };
  baseUnits(params.amount); testFee(params.fee);
  if (!params.invoice.startsWith('rgb:') || !params.assetId) throw new Error('Enter the blinded invoice and exact asset ID.');
  pending = Object.freeze(params);
  $('review-text').textContent = `Send ${params.amount} base units of ${params.assetId}\nFee: ${params.fee} sat/vB\nTo: ${params.invoice}`;
  $('confirmation').hidden = false;
}));
$('confirm').addEventListener('click', () => task(async () => {
  if (!pending) throw new Error('Review the transfer first.');
  const params = pending; pending = null; $('confirmation').hidden = true;
  await service.send(params); await refresh();
}));
$('cancel').addEventListener('click', () => { pending = null; $('confirmation').hidden = true; });
$('backup').addEventListener('click', () => task(async () => {
  const backup = await service.backup();
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'masked-rgb-signet-backup.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('saved').hidden = false;
}));
$('saved').addEventListener('click', () => { service.backupSaved(); $('saved').hidden = true; controls(); });
$('lock').addEventListener('click', async () => { await service.close(); location.reload(); });
// Input values are never HTML. Clear review when any send field changes.
for (const id of ['recipient', 'send-asset', 'amount', 'fee']) $(id).addEventListener('input', () => { pending = null; $('confirmation').hidden = true; });
controls();
// One writer per extension origin. Holding the lock until the full tab closes also prevents
// concurrent restores and popup/side-panel instances from sharing the SDK database.
if (!navigator.locks) { $('open').disabled = true; $('restore').disabled = true; note('This browser lacks the required single-wallet lock.'); }
else navigator.locks.request('masked-rgb-signet-v1', { ifAvailable: true }, async lock => {
  if (!lock) { $('open').disabled = true; $('restore').disabled = true; note('RGB Signet is already open in another tab. Close it first.'); return; }
  $('open').disabled = false; $('restore').disabled = false; note('Ready · Utexo Signet');
  await new Promise(resolve => { releaseLock = resolve; });
});
window.addEventListener('pagehide', () => { ready = false; pending = null; service.close(); releaseLock?.(); });
for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, () => { activity = Date.now(); });
setInterval(() => { if (ready && Date.now() - activity > 5 * 60 * 1000 && !service.busy) { service.close().finally(() => location.reload()); } }, 10000);

for (const button of document.querySelectorAll('[data-section]')) button.addEventListener('click', () => {
  document.getElementById(/** @type {HTMLElement} */ (button).dataset.section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
new ResizeObserver(() => {
  if (window.parent !== window) window.parent.postMessage({ type: 'masked:rgb-height', height: Math.ceil(document.body.getBoundingClientRect().height) }, location.origin);
}).observe(document.body);
