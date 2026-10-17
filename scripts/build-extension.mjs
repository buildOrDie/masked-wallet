import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
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

// The RGB lab is a separate ESM page: loading WASM never touches the normal wallet popup.
const wasmDir=resolve(root,'node_modules/@utexo/rln-wasm');
const bdkDir=resolve(root,'node_modules/@bitcoindevkit/bdk-wallet-web');
const bdkBytes=await readFile(resolve(bdkDir,'bitcoindevkit_bg.wasm'));
const bdkModule=new WebAssembly.Module(bdkBytes);
const bdkExports=WebAssembly.Module.exports(bdkModule).map(e=>e.name);
await build({
  bundle:true,minify:true,platform:'browser',format:'esm',target:'es2022',
  entryPoints:[resolve(root,'src/rgb/page.mjs')],outfile:resolve(out,'rgb-signet.mjs'),
  inject:[resolve(root,'src/rgb/buffer.mjs')],
  plugins:[{name:'bdk-wasm',setup(build){
    build.onLoad({filter:/bitcoindevkit_bg\.wasm$/},()=>({loader:'js',resolveDir:bdkDir,contents:
      `import * as imports from './bitcoindevkit_bg.js';
       const result=await WebAssembly.instantiate(await (await fetch(new URL('./bitcoindevkit_bg.wasm',import.meta.url))).arrayBuffer(),{'./bitcoindevkit_bg.js':imports});
       ${bdkExports.map((name,i)=>`const e${i}=result.instance.exports[${JSON.stringify(name)}];export {e${i} as ${name}};`).join('\n')}`
    }));
  }}],
});
const rlnBytes=await readFile(resolve(wasmDir,'rln_wasm_sdk_bg.wasm'));
const chunkSize=Math.ceil(rlnBytes.length/4);
for(let i=0;i<4;i++)await writeFile(resolve(out,`rln-wasm-${i}.bin`),rlnBytes.subarray(i*chunkSize,(i+1)*chunkSize));
await cp(resolve(bdkDir,'bitcoindevkit_bg.wasm'),resolve(out,'bitcoindevkit_bg.wasm'));
await cp(resolve(root,'src/rgb/signet.html'),resolve(out,'rgb-signet.html'));
const shell=await readFile(resolve(root,'src/shell.html'),'utf8');
const walletCss=shell.match(/<style>([\s\S]*?)<\/style>/)?.[1];
if(!walletCss)throw new Error('Wallet design stylesheet not found');
await writeFile(resolve(out,'rgb-signet.css'),walletCss+'\n'+await readFile(resolve(root,'src/rgb/signet.css'),'utf8'));
