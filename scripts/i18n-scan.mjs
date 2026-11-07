// Lists English text written in the code that has no translation yet: text between tags in the screens, and
// messages (toasts, errors, status lines). ${…} becomes {0}, {1}… so the line works as a pattern.
// node scripts/i18n-scan.mjs > missing.json   (review by hand: it also catches a few code fragments)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { _setLangForTest, tr } from '../src/i18n/translate.mjs';

_setLangForTest('zh-CN');
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (!/i18n|vendor/.test(e.name)) walk(p); } else if (/\.mjs$/.test(e.name)) files.push(p); } };
walk('src');
// ${ … } with nesting → {n}
function holes(s) {
  let out = '', n = 0, i = 0;
  while (i < s.length) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 0, j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (!depth) break; } }
      out += `{${n++}}`; i = j + 1; continue;
    }
    out += s[i++];
  }
  return out;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const junk = (s) => !/[A-Za-z]{3,}/.test(s) || /=>|\bthis\.|\bconst\b|\breturn\b|\.join\(|\.map\(|===|!==|\?\.|\bclass=|\bdata-|`|\$\{|^[a-z][\w.-]*$|^[\w-]+\(|^\W+$|^[{}\d\s·,]+$|^https?:|\.mjs\b|\bnew \w+\(/.test(s);
const found = new Map();
const add = (raw, file) => {
  const t = squash(holes(raw).replace(/\\(['"`])/g, '$1')).replace(/^[\s'"`:,]+|[\s'"`,]+$/g, '');
  if (!t || junk(t) || t.length > 400) return;
  if (tr(t) !== t) return; // already translated
  if (!found.has(t)) found.set(t, file.replace(/^src\//, ''));
};
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // screens: text between tags, and label attributes
  if (/\/ui\/|rgb\/RgbViews|views\//.test(f)) {
    for (const m of src.matchAll(/>([^<>]*?)</g)) add(m[1], f);
    for (const m of src.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)) add(m[1], f);
  }
  // messages anywhere: toast, Error, message/status strings, labels in result objects
  for (const m of src.matchAll(/(?:toast|Error|setStatus\([^,]+,|status\.\w+ = \[|message = |note: |label: |detail: |text: |why = |reason: )\s*\(?\s*(['`])((?:\\.|(?!\1)[^\\])*?)\1/g)) add(m[2], f);
}
const out = [...found.entries()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
console.log(JSON.stringify(out, null, 0).replace(/\],\[/g, '],\n['));
console.error(out.length, 'lines');
