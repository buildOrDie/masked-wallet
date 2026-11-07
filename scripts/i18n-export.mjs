// Writes docs/i18n/zh-CN.csv from src/i18n/zh-CN.mjs: one row per line (English, 中文, reviewed, note).
// Reviewers edit the 中文 column and set reviewed to "yes"; node scripts/i18n-import.mjs brings it back.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { ZH_CN } from '../src/i18n/zh-CN.mjs';

const file = 'docs/i18n/zh-CN.csv';
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
// keep reviewers' marks when the file is written again
const done = new Map();
if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
  const m = /^"((?:[^"]|"")*)","(?:[^"]|"")*","(yes|no)","((?:[^"]|"")*)"$/.exec(line);
  if (m) done.set(m[1].replace(/""/g, '"'), [m[2], m[3].replace(/""/g, '"')]);
}
mkdirSync('docs/i18n', { recursive: true });
const rows = Object.entries(ZH_CN).map(([en, zh]) => [en, zh, ...(done.get(en) || ['no', ''])].map(q).join(','));
writeFileSync(file, ['English,中文,reviewed,note', ...rows].join('\n') + '\n');
console.log(`${rows.length} lines → ${file}`);
