#!/usr/bin/env node
// Fingerprint of a built extension folder, to check that what Chrome installed is what this source builds.
//   node scripts/hash-extension.mjs extension          (after npm ci && npm run build)
//   node scripts/hash-extension.mjs "<Chrome profile>/Extensions/pojmpfcbdmacabhckemelcbkmckhaoig/<version>_0"
// Every file's SHA-256, sorted by path, then one hash over that list. The manifest is hashed without
// the fields Chrome or the Store add or remove (key, update_url, differential_fingerprint), and _metadata/ is skipped.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.argv[2] || 'extension';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== '_metadata') walk(p); } else files.push(p);
  }
})(root);
const lines = files.map((p) => {
  const rel = relative(root, p).split(sep).join('/');
  let data = readFileSync(p);
  if (rel === 'manifest.json') {
    const m = JSON.parse(data.toString('utf8'));
    for (const k of ['key', 'update_url', 'differential_fingerprint']) delete m[k];
    data = Buffer.from(JSON.stringify(m));
  }
  return `${sha(data)}  ${rel}`;
}).sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
for (const l of lines) console.log(l);
console.log(`\nMASKED extension fingerprint: ${sha(lines.join('\n'))}`);
