// The MASKED phone app's web files (dist/mobile): the same wallet as the extension, as one page. What only the
// extension uses (the background, the provider for websites, the manifest) is left out; Capacitor serves the rest.
import { execFileSync } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist/mobile');
await rm(out, { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, 'scripts/build-extension.mjs'), out], { stdio: 'inherit' });
for (const f of ['background.js', 'content.js', 'inpage.js', 'manifest.json', '_locales', 'panel.html']) await rm(resolve(out, f), { recursive: true, force: true });
// the app opens index.html
await rename(resolve(out, 'masked.html'), resolve(out, 'index.html'));
const html = await readFile(resolve(out, 'index.html'), 'utf8');
if (!/app\.bundle\.js/.test(html)) throw new Error('index.html no longer loads app.bundle.js');
await writeFile(resolve(out, 'index.html'), html);
// the iPhone app's version is MASKED's too (Android reads package.json itself): 2.29.10 → 2.29.10 (build 22910)
const pbx = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj');
if (existsSync(pbx)) {
  const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const [a, b, c] = version.split('.').map((x) => parseInt(x, 10));
  const src = (await readFile(pbx, 'utf8'))
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${a * 10000 + b * 100 + c};`);
  await writeFile(pbx, src);
}
console.log('Phone app files at ' + out + '. Next: npx cap sync android (or ios)');
