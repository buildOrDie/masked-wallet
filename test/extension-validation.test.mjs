import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../src/app.mjs',import.meta.url),'utf8');
const idxGetSource=source.slice(source.indexOf('async function idxGet(path)'),source.indexOf('async function refreshIndexer()'));
const refreshSource=source.slice(source.indexOf('async function refreshIndexerInner()'),source.indexOf('async function saveIndexer(url)'));
const lineSource=source.slice(source.indexOf('function idxLine(tick)'),source.indexOf('/** Everything that moved a ticker'));
test('extension preserves gateway validation metadata on object and list responses',async()=>{
 let result={result:{overall_balance:'1500'},validation:{status:'balance_match',balanceStatus:'matched'}};
 const c=vm.createContext({indexerUrl:()=> 'https://tokens.maskedwallet.com',AbortController,setTimeout,clearTimeout,fetch:async()=>({ok:true,status:200,text:async()=>JSON.stringify(result)})});
 vm.runInContext(idxGetSource,c);
 assert.equal((await c.idxGet('/balance')).validation.balanceStatus,'matched');
 result={result:[{ticker:'worldx'}],validation:{status:'not_checked'}};
 assert.equal((await c.idxGet('/list'))[0].validation.status,'not_checked');
});
test('unverified discovery balances cannot bypass a per-token OPI comparison',async()=>{
 const calls=[],state={};
 const c=vm.createContext({state,Date,fundingInfo:()=>({outputX:'x'}),p2trScript:()=> 's',toHex:()=> 'script',refreshIdxWallet:async()=>{},knownTokens:()=>[{tick:'worldx'}],isV2:()=>true,tickLen:()=>6,tokenScripts:()=>['script'],idxTok:()=>({overall:'999',decimals:18,validation:{balanceStatus:'not_checked'}}),deploys:()=>[],decToRaw:(n,d)=>BigInt(n)*10n**BigInt(d),idxGet:async path=>{calls.push(path);return path.endsWith('/block_height')?971198:{units:'decimal',overall_balance:'1500',decimals:18,validation:{balanceStatus:'matched'}};}});
 vm.runInContext(refreshSource,c);await c.refreshIndexerInner();
 assert.ok(calls.some(p=>p.includes('get_current_balance_of_wallet')));assert.equal(state.idx.tokens.worldx,'1500000000000000000000');assert.equal(state.idx.validation.worldx,'matched');
});
test('balance labels distinguish matched, disputed and unverified results',()=>{
 const state={idx:{height:971198,tokens:{worldx:'1500'},decimals:{worldx:0},validation:{worldx:'conflict'}}};
 const c=vm.createContext({state,indexerUrl:()=> 'https://tokens.maskedwallet.com',deploys:()=>[],esc:s=>s,I:{check:'check'},formatRaw:String});
 vm.runInContext(lineSource,c);assert.match(c.idxLine('worldx'),/Sources disagree/);
 state.idx.validation.worldx='not_checked';assert.match(c.idxLine('worldx'),/Indexer-reported balance/);
 state.idx.validation.worldx='matched';assert.match(c.idxLine('worldx'),/OPI \+ UniSat balance match/);
});
