// Reads docs/i18n/zh-CN.csv back into src/i18n/zh-CN.mjs after review (English keys must not change).
import { readFileSync, writeFileSync } from 'node:fs';
import { ZH_CN } from '../src/i18n/zh-CN.mjs';

const rows = readFileSync('docs/i18n/zh-CN.csv', 'utf8').trim().split('\n').slice(1);
const cell = /"((?:[^"]|"")*)"/g;
let changed = 0;
const src = readFileSync('src/i18n/zh-CN.mjs', 'utf8');
let out = src;
for (const row of rows) {
  const [en, zh] = [...row.matchAll(cell)].map((m) => m[1].replace(/""/g, '"'));
  if (!(en in ZH_CN) || !zh || zh === ZH_CN[en]) continue;
  const lit = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const before = `${lit(en)}: ${lit(ZH_CN[en])},`;
  if (!out.includes(before)) { console.error('could not place:', en); continue; }
  out = out.replace(before, `${lit(en)}: ${lit(zh)},`); changed++;
}
writeFileSync('src/i18n/zh-CN.mjs', out);
console.log(`${changed} translations updated`);
