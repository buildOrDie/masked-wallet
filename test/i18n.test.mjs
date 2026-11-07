import test from 'node:test';
import assert from 'node:assert/strict';
import { trHtml, tr, _setLangForTest } from '../src/i18n/translate.mjs';
import { ZH_CN } from '../src/i18n/zh-CN.mjs';
import { walletApp, Keyring } from './helpers/wallet-app.mjs';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// the structure of a page: every tag except inline text styling, with the translatable labels blanked out
const tags = (html) => (html.match(/<[^>]*>/g) || []).filter((t) => !/^<\/?(b|strong|em|i|u|br)\b/i.test(t)).map((t) => t.replace(/\b(placeholder|title|aria-label|alt)="[^"]*"/g, '$1=""'));

test('English is the default and passes through untouched', () => {
  _setLangForTest('en');
  const html = '<p>Tap <b>Receive</b> and send BTC to your Public address.</p>';
  assert.equal(trHtml(html), html);
  assert.equal(tr('Copied'), 'Copied');
});

test('Chinese: text, sentences with inline tags, values, attributes; addresses and unknown text stay', () => {
  _setLangForTest('zh-CN');
  assert.equal(trHtml('<button data-go="home"><span>Wallet</span></button>'), '<button data-go="home"><span>钱包</span></button>');
  assert.equal(trHtml('<p>Tap <b>Receive</b> and send BTC to your Public address.</p>'), '<p>点击<b>接收</b>，把 BTC 发送到你的公开地址。</p>');
  assert.equal(trHtml('<span class="lbl-r">Available 0.0012 BTC</span>'), '<span class="lbl-r">可用 0.0012 BTC</span>');
  assert.equal(trHtml('<input placeholder="Paste a Bitcoin or shielded address" value="Send">'), '<input placeholder="粘贴比特币地址或隐私地址" value="Send">', 'only labels, never values');
  assert.equal(trHtml('<span class="mono">Send bc1qsend</span>'), '<span class="mono">Send bc1qsend</span>', 'addresses and keys are never touched');
  assert.equal(trHtml('<div translate="no"><b>Send</b></div>'), '<div translate="no"><b>Send</b></div>');
  assert.equal(trHtml('<p>Something brand new</p>'), '<p>Something brand new</p>', 'missing lines stay English');
  assert.equal(tr('Not enough Public balance. You can send up to 0.001 BTC.'), '公开余额不足。你最多可以发送 0.001 BTC。', 'a known word inside a value is translated too');
  assert.equal(trHtml('<p>It can&#39;t be recovered</p>'), '<p>It can&#39;t be recovered</p>');
  assert.equal(trHtml("<p>The password encrypts your wallet on this device. It can&#39;t be recovered, but your recovery phrase can always restore the wallet.</p>"), '<p>密码用于加密此设备上的钱包。密码无法找回，但助记词随时可以恢复钱包。</p>', 'escaped quotes in the page match the dictionary');
  _setLangForTest('en');
});

test('dictionary: every translation keeps its placeholders and inline tags, and is really translated', () => {
  for (const [k, v] of Object.entries(ZH_CN)) {
    const ph = (s) => (s.match(/\{\d\}/g) || []).sort().join();
    assert.equal(ph(v), ph(k), `placeholders differ: ${k}`);
    const inl = (s) => (s.match(/<\/?(b|strong|em|i|u|br)\b[^>]*>/g) || []).join();
    assert.equal(inl(v), inl(k), `inline tags differ: ${k}`);
    assert.ok(v.trim(), `empty: ${k}`);
  }
});

test('translating never changes a screen\'s structure (buttons, data attributes, links stay identical)', () => {
  globalThis.document ??= { querySelector: () => null, querySelectorAll: () => [] };
  _setLangForTest('zh-CN');
  for (const net of ['main', 'signet']) {
    const app = walletApp(Keyring.fromMnemonic(WORDS, '', net), net);
    const pages = [];
    for (const g of ['locked', 'onboard', 'migrate', 'backup']) pages.push(app.ui.gates[g].render());
    for (const v of ['home', 'receive', 'send', 'shield', 'activity', 'accounts', 'settings']) pages.push(app.ui.views[v].render());
    for (const html of pages) {
      const zh = trHtml(html);
      assert.deepEqual(tags(zh), tags(html));
    }
    // and Chinese really shows
    assert.match(trHtml(app.ui.views.home.render()), /公开余额/);
    assert.match(trHtml(app.ui.views.settings.render()), /显示助记词/);
  }
  _setLangForTest('en');
});

test('only whole class names mark text as untouchable (addr-kind is a label, addr is an address)', () => {
  _setLangForTest('zh-CN');
  assert.match(trHtml('<span class="addr-kind k-empty"><button class="link">Send to my own Shielded address</button></span>'), /发送到我自己的隐私地址|Shielded/);
  assert.doesNotMatch(trHtml('<span class="addr-kind k-empty"><button class="link">Send to my own Shielded address</button></span>'), /Send to my own/);
  assert.equal(trHtml('<span class="x mono y">Send</span>'), '<span class="x mono y">Send</span>');
  assert.equal(trHtml('<span class="addr">Send</span>'), '<span class="addr">Send</span>');
  _setLangForTest('en');
});
