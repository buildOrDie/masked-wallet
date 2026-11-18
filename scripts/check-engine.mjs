// Is extension/rgb-lib.wasm MASKED's own RGB engine (engine/build.sh: wallet upgrade, Instant listings, swaps)?
// The npm engine would make RGB refuse to open for everyone who updates. Used by CI and npm run store-zip.
//   node scripts/check-engine.mjs [path/to/rgb-lib.wasm]
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE_NEEDS = [/migrate/i, /presign/i, /swap/i];

/** The RGB engine features a wasm file lacks ([] when it is MASKED's). */
export async function missingEngineFeatures(file = resolve(root, 'extension/rgb-lib.wasm')) {
  const names = WebAssembly.Module.exports(new WebAssembly.Module(await readFile(file))).map((e) => e.name);
  return ENGINE_NEEDS.filter((re) => !names.some((n) => re.test(n))).map((re) => re.source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const missing = await missingEngineFeatures(file);
  if (missing.length) { console.error(`Not MASKED's RGB engine: no ${missing.join(', ')} functions. Build it with engine/build.sh, then npm run build.`); process.exit(1); }
  console.log("RGB engine: MASKED's own (upgrade, Instant listings, swaps)");
}
