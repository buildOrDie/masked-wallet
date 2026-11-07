// Writes docs/i18n/zh-CN.csv from src/i18n/zh-CN.mjs: one row per line (screen, English, 中文, reviewed, note).
// Reviewers edit the 中文 column and set reviewed to "yes"; node scripts/i18n-import.mjs brings it back.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { ZH_CN } from '../src/i18n/zh-CN.mjs';

const file = 'docs/i18n/zh-CN.csv';
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const cells = (line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
// the screen each line belongs to, from the section comments in the dictionary
const SCREEN = { 'navigation and common words': 'Common · 通用', 'unlock and setup': 'Setup & unlock · 创建与解锁', home: 'Home · 首页', 'send and shield': 'Send & Shield · 发送与转入隐私', receive: 'Receive · 接收', 'activity, coins, accounts': 'Coins & accounts · UTXO 与账户', settings: 'Settings · 设置', toasts: 'Messages · 提示', header: 'Header · 顶部栏', 'setup headings and address hints': 'Setup & addresses · 创建与地址' };
const screenOf = new Map();
let section = '';
for (const line of readFileSync('src/i18n/zh-CN.mjs', 'utf8').split('\n')) {
  const s = /\/\/ ---- (.+) ----/.exec(line);
  if (s) { section = SCREEN[s[1]] || s[1]; continue; }
  const k = /^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/.exec(line);
  if (k) screenOf.set(k[2].replace(/\\(['"\\])/g, '$1'), section);
}
// keep reviewers' marks and notes when the file is written again
const done = new Map();
if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
  const c = cells(line);
  if (c.length === 5) done.set(c[1], [c[3], c[4]]);
  else if (c.length === 4) done.set(c[0], [c[2], c[3]]); // older files without the screen column
}
mkdirSync('docs/i18n', { recursive: true });
const rows = Object.entries(ZH_CN).map(([en, zh]) => [screenOf.get(en) || '', en, zh, ...(done.get(en) || ['no', ''])].map(q).join(','));
writeFileSync(file, ['screen,English,中文,reviewed,note', ...rows].join('\n') + '\n');
const reviewed = rows.filter((r) => r.includes('"yes"')).length;
console.log(`${rows.length} lines (${reviewed} reviewed) → ${file}`);
