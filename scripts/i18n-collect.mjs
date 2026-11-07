/* global localStorage */
// Lists every English sentence the main screens show that the Chinese dictionary doesn't cover yet.
// node scripts/i18n-collect.mjs > missing.json
import { walletApp, Keyring } from '../test/helpers/wallet-app.mjs';
import { _setLangForTest, collectMissing, missing, trHtml, tr } from '../src/i18n/translate.mjs';

globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [] };
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
_setLangForTest('zh-CN'); collectMissing(true);
const seen = (html) => { try { trHtml(html); } catch (e) { console.error('render', e.message); } };
const views = (app, names) => { for (const n of names) { try { seen(app.ui.views[n].render()); } catch (e) { console.error(n, e.message); } } };

for (const net of ['main', 'signet']) {
  const app = walletApp(Keyring.fromMnemonic(WORDS, '', net), net);
  const { state } = app;
  // gates
  for (const [ls, f] of [['locked', {}], ['onboard', { obMode: 'create' }], ['onboard', { obMode: 'restore' }], ['migrate', {}], ['backup', {}]]) {
    Object.assign(state.f, f);
    try { seen(app.ui.gates[ls].render()); } catch (e) { console.error(ls, e.message); }
  }
  // wallet screens in a few states
  views(app, ['home', 'receive', 'activity', 'accounts', 'settings']);
  for (const kind of ['send', 'shield']) {
    for (const from of ['public', 'shielded']) {
      Object.assign(state.f, { from, to: '', amt: '' });
      views(app, [kind]);
      for (const fee of ['slow', 'normal', 'fast', 'custom']) { state.f.fee = fee; state.f.feeCustom = fee === 'custom' ? '3' : ''; views(app, [kind]); }
    }
  }
  state.f.recvKind = 'shielded'; views(app, ['receive']);
  state.f.recvKind = 'public'; views(app, ['receive']);
  seen(app.ui.view('home').render());
  // more screens
  for (const mode of ['mint', 'deploy', 'rgb']) { state.f.mintMode = mode; views(app, ['mint']); }
  for (const who of ['me', 'anyone', 'self']) { state.f.deployWho = who; state.f.mintMode = 'deploy'; views(app, ['mint']); }
  for (const to of ['shielded', 'other', 'public']) { state.f.mintTo = to; state.f.mintMode = 'mint'; views(app, ['mint']); }
  for (const m of ['receive', 'send', 'pay', 'topup', 'mints']) { state.f.ecMode = m; views(app, ['ecash']); }
  views(app, ['ordinals', 'leaf', 'relay']);
  state.f.sendMode = 'airdrop'; views(app, ['send']); state.f.sendMode = '';
  try { localStorage.setItem('masked.rgb.mainnet-beta', '1'); } catch {}
  views(app, ['home', 'settings']);
  app.rgb.betaAsk = true; views(app, ['home']); app.rgb.betaAsk = false;
  try { localStorage.removeItem('masked.rgb.mainnet-beta'); } catch {}
  views(app, ['home']);
  // header and navigation
  try { seen(app.ui.views.settings.render()); } catch {}
}
// navigation labels
for (const n of ['Wallet', 'Mint', 'Settings']) tr(n);
const out = [...missing].filter((k) => !/^<(\w+)[^>]*>[^<]*<\/\1>$/.test(k)).sort();
console.log(JSON.stringify(out, null, 1));
console.error(out.length, 'lines');
