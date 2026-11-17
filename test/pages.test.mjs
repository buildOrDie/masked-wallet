import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The extension and the apps ship extension-template/masked.html; src/shell.html is its copy for the tests and the
// string collector. Styles added to one only never reach people (seen: the RGB screens shipped unstyled).
test('src/shell.html and the shipped page are the same', () => {
  const a = readFileSync(new URL('../src/shell.html', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../extension-template/masked.html', import.meta.url), 'utf8');
  assert.equal(a, b, 'copy src/shell.html to extension-template/masked.html (or the other way)');
});
