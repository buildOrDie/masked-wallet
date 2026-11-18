// The Chrome Web Store / Edge package: npm run store-zip → ../masked-<version>-store.zip
// Builds extension/ first, then refuses unless the RGB engine is MASKED's own (vendor/rgb-lib-wasm from engine/build.sh,
// with the wallet upgrade and swaps). The npm engine would make RGB refuse to open for everyone who updates.
// The manifest `key` is left out: the Store gives the extension its own.
import { execFileSync } from 'node:child_process';
import { cp, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`\nNOT MADE: ${msg}\n`); process.exit(1); };

if (!existsSync(resolve(root, 'vendor/rgb-lib-wasm/rgb_lib_wasm_bindings_bg.wasm'))) fail('vendor/rgb-lib-wasm is missing. Run: bash engine/build.sh');
execFileSync(process.execPath, [resolve(root, 'scripts/build-extension.mjs'), 'extension'], { cwd: root, stdio: 'inherit' });

const ext = resolve(root, 'extension');
const names = WebAssembly.Module.exports(new WebAssembly.Module(await readFile(join(ext, 'rgb-lib.wasm')))).map((e) => e.name);
for (const need of [/migrate/i, /presign/i, /swap/i]) if (!names.some((n) => need.test(n))) fail(`the RGB engine in extension/ has no ${need.source} functions: it is not MASKED's engine. Run: bash engine/build.sh`);

const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (manifest.version !== version) fail(`manifest says ${manifest.version}, package.json says ${version}`);

const tmp = await mkdtemp(join(tmpdir(), 'masked-store-'));
await cp(ext, tmp, { recursive: true });
delete manifest.key;
await writeFile(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const zip = resolve(root, '..', `masked-${version}-store.zip`);
await rm(zip, { force: true });
execFileSync('zip', ['-qr', '-X', zip, '.', '-x', '.*', '-x', '*/.*'], { cwd: tmp, stdio: 'inherit' });
await rm(tmp, { recursive: true, force: true });
console.log(`\nStore zip: ${zip}\nversion ${version} · MASKED RGB engine (upgrade + swaps) · no manifest key`);
