import test from 'node:test';
import assert from 'node:assert/strict';
import {PriceEvidenceReader} from '../server/price-evidence-reader.mjs';
import {PanelError} from '../server/workspace-service.mjs';

async function fixture(){
 const baseline=new TextEncoder().encode('original baseline bytes');
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',baseline)).toString('hex');
 const manifest={run_id:'123',generated_at:'2026-11-04T13:00:00Z',source_started_at:'2026-11-04T08:37:00Z',git_sha:'a'.repeat(40),status:'success',start_dates:['2026-11-05'],durations:[2,3,4,10],baseline:{workbook_sha256:hash},excel_files:{'rates-updated.xlsx':'b'.repeat(64)},quality:{details:'x'.repeat(630000)}};
 const state={manifest,configs:[],reads:[],failConfig:false,badBaseline:false};
 const repository={json:async(path,revision)=>{state.configs.push([path,revision]);if(state.failConfig)throw new PanelError(502,'Temporary config failure');return {locations:[{scraper_label:`Airport ${revision[0]}`,zones:['KRLO'],kind:'airport'}]};},baselineBytes:async()=>state.badBaseline?new Uint8Array([9]):baseline};
 const fetcher=async url=>{state.reads.push(url);if(url.endsWith('/run-manifest.json'))return Response.json(state.manifest);throw new Error('Unexpected source');};
 return {state,baseline,reader:new PriceEvidenceReader(()=>repository,fetcher),input:{zone:'KRLO',group:'CDMV',duration:3,transmission:'automatic',reportRunId:'123',excelRunId:'123'}};
}

test('large manifests stay inside the reader; immutable config is reused across class and duration reads',async()=>{
 const {state,reader,input}=await fixture();
 for(const patch of [{},{group:'EDMV'},{duration:10}]){
  const response=await reader.read({...input,...patch},false);
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await response.json()).location,'Airport a');
  assert.equal(response.headers.get('cache-control'),'private, no-store');
 }
 assert.equal(state.configs.length,1);
 assert.equal(state.reads.length,6,'Both current manifests are revalidated for every read, not cached as current');
});
test('a new run or commit cannot reuse stale context even after warming the cache',async()=>{
 const {state,reader,input}=await fixture();await reader.read(input,false);
 state.manifest={...state.manifest,run_id:'124',git_sha:'c'.repeat(40)};
 assert.equal((await reader.read(input,false)).status,409);
 const current=await reader.read({...input,reportRunId:'124',excelRunId:'124'},false);
 assert.equal((await current.json()).location,'Airport c');
 assert.equal(state.configs.length,2);
});
test('replacement file digests are visible even when the run and commit are unchanged',async()=>{
 const {state,reader,input}=await fixture();await reader.read(input,false);
 state.manifest={...state.manifest,generated_at:'2026-11-04T14:00:00Z',excel_files:{'rates-updated.xlsx':'d'.repeat(64)}};
 const updated=await(await reader.read(input,false)).json();
 assert.equal(updated.excel.files['rates-updated.xlsx'],'d'.repeat(64));
 assert.equal(updated.excel.generatedAt,'2026-11-04T14:00:00Z');
 assert.equal(state.configs.length,1);
});
test('binary sources retain digest validation and are not JSON encoded',async()=>{
 const {state,reader,input,baseline}=await fixture();
 const response=await reader.read({...input,kind:'baseline'},true);
 assert.equal(response.headers.get('content-type'),'application/octet-stream');
 assert.deepEqual(new Uint8Array(await response.arrayBuffer()),baseline);
 state.badBaseline=true;
 assert.equal((await reader.read({...input,kind:'baseline'},true)).status,502);
 assert.equal((await reader.read({...input,mode:'market',kind:'baseline'},true)).status,422);
});
test('failed configuration reads are never retained as successful cache entries',async()=>{
 const {state,reader,input}=await fixture();state.failConfig=true;
 assert.equal((await reader.read(input,false)).status,502);
 state.failConfig=false;assert.equal((await reader.read(input,false)).status,200);
 assert.equal(state.configs.length,2);
});
test('the config cache is bounded and concurrent reads share a pinned revision',async()=>{
 const {state,reader,input}=await fixture();
 await Promise.all([reader.read(input,false),reader.read({...input,group:'EDMV'},false)]);
 assert.equal(state.configs.length,1);
 for(let i=0;i<9;i++){state.manifest.git_sha=String(i).repeat(40);await reader.read(input,false);}
 state.manifest.git_sha='a'.repeat(40);await reader.read(input,false);
 assert.equal(state.configs.length,11,'An old evicted revision must be read again');
});
