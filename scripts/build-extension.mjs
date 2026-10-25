import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.argv[2] || resolve(root,'dist/extension'));
await mkdir(out,{recursive:true});
await cp(resolve(root,'extension-template'),out,{recursive:true});
const common={bundle:true,minify:true,platform:'browser',format:'iife',loader:{'.wasm':'binary'}};
await build({...common,entryPoints:[resolve(root,'src/main.mjs')],outfile:resolve(out,'app.bundle.js')});
await build({...common,entryPoints:[resolve(root,'src/scan/scan-worker.mjs')],outfile:resolve(out,'scan-worker.js')});
for(const [name,source] of [['background.js','background'],['content.js','content'],['inpage.js','inpage']])await build({...common,entryPoints:[resolve(root,`src/provider/${source}.js`)],outfile:resolve(out,name)});
await writeFile(resolve(out,'manifest.json'),await readFile(resolve(root,'src/manifest.json')));
console.log('Extension built at '+out);

// RGB: the wallet lazily imports this packaged ESM runtime when RGB is turned on. The engine is rgb-lib-wasm
// (on-chain RGB only), shrunk with binaryen's wasm-opt -Oz, limited to WebAssembly features Chrome supports. The optimized file is cached by the input's hash,
// so only the first build takes a couple of minutes.
// rgb-lib-wasm's fetch calls go through src/rgb/rgbFetch.mjs (a few requests at a time, polite retries)
const rgbFetchPath=resolve(root,'src/rgb/rgbFetch.mjs');
await build({
  bundle:true,minify:true,platform:'browser',format:'esm',target:'es2022',
  entryPoints:[resolve(root,'src/rgb/runtime.mjs')],outfile:resolve(out,'rgb-runtime.mjs'),
  plugins:[{name:'rgb-fetch',setup(b){
    b.onLoad({filter:/rgb_lib_wasm_bindings\.js$/},async({path})=>{
      let src=await readFile(path,'utf8'), n=0;
      src=src.replace(/const ret = fetch\(arg0\);/g,()=>{n++;return 'const ret = __rgbFetch(arg0);';});
      src=src.replace(/const ret = arg0\.fetch\(arg1\);/g,()=>{n++;return 'const ret = __rgbFetch(arg1);';});
      if(n!==4) throw new Error(`rgb-lib-wasm changed: expected 4 fetch calls to route, found ${n}`);
      return {contents:`import { rgbFetch as __rgbFetch } from ${JSON.stringify(rgbFetchPath)};\n`+src,loader:'js'};
    });
  }}],
});
const engine=resolve(root,'node_modules/@utexo/rgb-lib-wasm/rgb_lib_wasm_bindings_bg.wasm');
const raw=await readFile(engine);
const optimizer=resolve(root,'node_modules/binaryen/bin/wasm-opt');
const { version: binaryenVersion } = JSON.parse(await readFile(resolve(root,'node_modules/binaryen/package.json'),'utf8'));
const cacheDir=resolve(root,'node_modules/.cache/masked-rgb');
const cached=resolve(cacheDir,`${createHash('sha256').update(raw).digest('hex').slice(0,16)}-binaryen${binaryenVersion}-chrome.wasm`);
if(!existsSync(cached)){
  await mkdir(cacheDir,{recursive:true});
  console.log('Optimizing the RGB engine (first build only, ~2 min)…');
  execFileSync(process.execPath,[optimizer,'--enable-bulk-memory','--enable-nontrapping-float-to-int','--enable-sign-ext','--enable-mutable-globals','--enable-reference-types','--enable-multivalue','-Oz','--strip-debug','--strip-producers',engine,'-o',cached+'.tmp'],{stdio:'inherit'});
  new WebAssembly.Module(await readFile(cached+'.tmp')); // must still be a valid module
  await rename(cached+'.tmp',cached);
}
await cp(cached,resolve(out,'rgb-lib.wasm'));
// files from the earlier Lightning SDK build
for(const file of ['rgb-signet.html','rgb-signet.css','rgb-signet.mjs','bitcoindevkit_bg.wasm','rln-wasm-0.bin','rln-wasm-1.bin','rln-wasm-2.bin','rln-wasm-3.bin'])await rm(resolve(out,file),{force:true});
