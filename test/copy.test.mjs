// Copy falls back to the copy command when navigator.clipboard is refused (Android WebView).
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../src/ui/copy.mjs';

function fakeDoc() {
  const doc = { copied: null, body: { append(el) { doc.box = el; } }, activeElement: null,
    createElement: () => ({ value: '', style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { doc.removed = true; } }),
    execCommand(cmd) { if (cmd !== 'copy') return false; doc.copied = doc.box.value; return true; } };
  return doc;
}

test('copy uses the clipboard API, and the copy command when that is refused', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    let got = null;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t) => { got = t; } } } });
    assert.equal(await copyText('bc1p…', fakeDoc()), true);
    assert.equal(got, 'bc1p…');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } } });
    const doc = fakeDoc();
    assert.equal(await copyText('https://signet.maskedwallet.com/rgb', doc), true);
    assert.equal(doc.copied, 'https://signet.maskedwallet.com/rgb');
    assert.equal(doc.removed, true, 'the hidden box is removed');
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); }
});
