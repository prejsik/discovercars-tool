import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBandMatrix,bandEvidence} from '../src/band-matrix.mjs';
import {priceFixture} from './price-fixture.mjs';
import {loadPriceEvidence} from '../src/price-loader.mjs';

test('matrix keeps worst daily gap and every duration, not a misleading average',()=>{
 const rows=[{date:'2026-11-04',duration:3,marketConfirmed:true,mm:70,competitor:60,gap:-10},{date:'2026-11-04',duration:4,marketConfirmed:true,mm:60,competitor:100,gap:40}];
 const cell=buildBandMatrix(['2026-11-04'],rows,[2,3,4,5,6,7,8,9,10,11,12,13,14])[0].cells[1];
 assert.equal(cell.worstGap,-10);assert.equal(cell.rows.length,2);
 assert.equal(cell.unavailable,0);assert.equal(cell.missingMM,0);
});
test('missing scenarios and failed reads are not confirmed missing MM',()=>{
 const rows=[{date:'2026-11-04',duration:8,marketConfirmed:true,mm:null,competitor:60,gap:null},{date:'2026-11-04',duration:9,marketConfirmed:false,mm:null,gap:null}];
 const cell=buildBandMatrix(['2026-11-04'],rows,[8,9,10,11,12,13,14])[0].cells[3];
 assert.equal(cell.missingMM,1);assert.equal(cell.unavailable,6);
 assert.deepEqual(cell.expected,[8,9,10,11,12,13,14]);
 assert.equal(cell.worstGap,null);
});
test('band reader downloads one workbook for all four bands and preserves blank cells',async()=>{
 const source=await priceFixture({transportOnly:true});const reads=[];
 const result=await loadPriceEvidence({mode:'matrix',zone:'KRLO',group:'CDMV',duration:2,transmission:'all',reportRunId:'123',excelRunId:'123'},url=>{reads.push(url);return source(url);});
 assert.deepEqual(result.bands.map(b=>b.duration),[2,3,5,8]);
 assert.equal(bandEvidence(result,4).rows[0].importRate,63);
 assert.equal(bandEvidence(result,2).rows[0].importRate,null);
 assert.equal(bandEvidence(result,14).rows[0].importRate,null);
 assert.equal(reads.filter(url=>url.includes('kind=workbook')).length,1);
 assert.equal(reads.filter(url=>url.includes('kind=baseline')).length,1);
 assert.equal(reads.filter(url=>url.includes('kind=market')).length,0);
});
for(const option of ['wrongWorkbook','changeDuringRead']) {
 test('matrix rejects mismatched source: '+option,async()=>{
  const source=await priceFixture({transportOnly:true,[option]:true});
  await assert.rejects(loadPriceEvidence({mode:'matrix',zone:'KRLO',group:'CDMV',duration:2,transmission:'all',reportRunId:'123',excelRunId:'123'},source));
 });
}
test('matrix does not substitute a different baseline',async()=>{
 const source=await priceFixture({transportOnly:true,wrongBaseline:true});
 const result=await loadPriceEvidence({mode:'matrix',zone:'KRLO',group:'CDMV',duration:2,transmission:'all',reportRunId:'123',excelRunId:'123'},source);
 assert.ok(result.warnings.some(w=>w.includes('historycznej bazy')));
 assert.equal(bandEvidence(result,3).rows[0].baseline,null);
 assert.equal(bandEvidence(result,3).rows[0].importRate,63);
});


