import assert from 'node:assert/strict';
import {unstable_dev} from 'wrangler';
const worker=await unstable_dev('tests/price-reader-runtime-worker.mjs',{config:'tests/price-reader-runtime-wrangler.jsonc',local:true,ip:'127.0.0.1',port:0,experimental:{disableExperimentalWarning:true}});
try{
 for(const group of ['CDMV','EDMV','CGAV']){
  const response=await worker.fetch('/?group='+group);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).location,'Airport a');
 }
 const binary=await worker.fetch('/binary');assert.equal(binary.status,200);assert.equal(binary.headers.get('content-type'),'application/octet-stream');assert.equal((await binary.arrayBuffer()).byteLength,1024*1024);
 assert.equal((await worker.fetch('/?actor=outsider@example.test')).status,403);
 assert.equal((await worker.fetch('/?actor=')).status,403);
 assert.deepEqual(await(await worker.fetch('/stats')).json(),{configReads:1,storageEntries:0});
 await worker.fetch('/change');assert.equal((await worker.fetch('/')).status,409);
 assert.equal((await(await worker.fetch('/?run=124')).json()).location,'Airport b');
 assert.deepEqual(await(await worker.fetch('/stats')).json(),{configReads:2,storageEntries:0});
 console.log('Price reader RPC runtime PASS: large manifests, binary Response, actor checks, revision cache, stale-run rejection, zero storage writes.');
}finally{await worker.stop();}
