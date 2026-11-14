// The MASKED phone app's web files (dist/mobile): the same wallet as the extension, as one page. What only the
// extension uses (the background, the provider for websites, the manifest) is left out; Capacitor serves the rest.
import { execFileSync } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/mobile');
await rm(out, { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, 'scripts/build-extension.mjs'), out], { stdio: 'inherit' });
for (const f of ['background.js', 'content.js', 'inpage.js', 'manifest.json', '_locales']) await rm(resolve(out, f), { recursive: true, force: true });
// the app opens index.html
await rename(resolve(out, 'masked.html'), resolve(out, 'index.html'));
const html = await readFile(resolve(out, 'index.html'), 'utf8');
if (!/app\.bundle\.js/.test(html)) throw new Error('index.html no longer loads app.bundle.js');
await writeFile(resolve(out, 'index.html'), html);
console.log('Phone app files at ' + out + '. Next: npx cap sync android');
