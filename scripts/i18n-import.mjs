// Reads docs/i18n/zh-CN.csv back into src/i18n/zh-CN.mjs after review (English keys must not change).
// A translation that drops a {0} placeholder or an inline tag is refused, with the row named.
import { readFileSync, writeFileSync } from 'node:fs';
import { ZH_CN } from '../src/i18n/zh-CN.mjs';

const rows = readFileSync('docs/i18n/zh-CN.csv', 'utf8').trim().split('\n').slice(1);
const cell = /"((?:[^"]|"")*)"/g;
let changed = 0;
const src = readFileSync('src/i18n/zh-CN.mjs', 'utf8');
let out = src;
for (const row of rows) {
  const c = [...row.matchAll(cell)].map((m) => m[1].replace(/""/g, '"'));
  const [en, zh] = c.length === 5 ? [c[1], c[2]] : [c[0], c[1]]; // screen, English, 中文, reviewed, note
  if (!(en in ZH_CN) || !zh || zh === ZH_CN[en]) continue;
  // every {n} the old translation used must stay (one may only be dropped where English adds a plural "s")
  const ph = (s) => new Set(s.match(/\{\d\}/g) || []), tags = (s) => (s.match(/<\/?(b|strong|em|i|u|br)\b[^>]*>/g) || []).join();
  const lost = [...ph(ZH_CN[en])].some((p) => !ph(zh).has(p)), invented = [...ph(zh)].some((p) => !ph(en).has(p));
  if (lost || invented || tags(zh) !== tags(en)) { console.error(`kept the old translation, {n} or <b> tags differ: ${en}`); continue; }
  const lit = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const before = `${lit(en)}: ${lit(ZH_CN[en])},`;
  if (!out.includes(before)) { console.error('could not place:', en); continue; }
  out = out.replace(before, `${lit(en)}: ${lit(zh)},`); changed++;
}
writeFileSync('src/i18n/zh-CN.mjs', out);
console.log(`${changed} translations updated`);
