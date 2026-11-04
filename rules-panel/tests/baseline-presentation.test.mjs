import test from 'node:test';import assert from 'node:assert/strict';
import {baselineRange,baselineWarnings,locationCoverage} from '../src/baseline-presentation.mjs';
import {GitHubRepository} from '../worker/github.mjs';
import {readSnapshot} from '../server/snapshot.mjs';
test('coverage comparison reports removed codes and classes and shorter end without changing either source',()=>{
 const before={rowCount:100,groups:['CDMV','FVMD'],zones:['KRLO','LU1'],firstDate:'2026-11-05',lastDate:'2027-12-21'},after={rowCount:90,groups:['CDMV'],zones:['KRLO'],firstDate:'2026-11-05',lastDate:'2027-11-21'};
 const snapshot=structuredClone({before,after});const model={locations:{locations:[{id:'lubin_city',city:'Lubin',kind:'city',zones:['LU1']}]}};
 assert.equal(baselineRange(before),'05.11.2026 – 21.12.2027');assert.equal(baselineRange(null),'Brak danych');
 const warnings=baselineWarnings(before,after,model);assert.equal(warnings.length,3);assert.match(warnings[0],/LU1.*Lubin · Miasto/);assert.match(warnings[1],/FVMD/);assert.deepEqual({before,after},snapshot);
});
test('GitHub snapshot only exposes manifest coverage and supports confirmed_imported',async()=>{
 const source=await readSnapshot();const manifest={source_filename:'base.xlsx',approved_at:'2026-11-04',workbook_sha256:'a'.repeat(64),status:'confirmed_imported',coverage:{rowCount:12,groups:['CDMV'],zones:['LU1'],firstDate:'2026-11-05',lastDate:'2027-12-21',pairs:['private-large-array']}};
 const repository=new GitHubRepository({},{api:async()=>({object:{sha:'a'.repeat(40)}})});
 repository.json=async path=>path==='input/baseline-manifest.json'?manifest:path==='locations.config.json'?source.documents.locations:path==='excel-rate-update.config.example.json'?source.documents.excel:source.documents.pricing;
 const snapshot=await repository.snapshot();assert.equal(snapshot.baseline.importConfirmed,true);assert.equal(snapshot.baseline.coverage.rowCount,12);assert.equal(snapshot.baseline.coverage.pairs,undefined);assert.equal(snapshot.baseline.coverage.lastDate,'2027-12-21');
});
test('coverage counts incomplete dates across all expected durations, not missing MM offers',()=>{
 const point={scraper_label:'Krakow Airport'};const data={locations:[point],report:{startDates:['2026-11-05','2026-11-06'],durations:[2,3]},rows:[{location:point.scraper_label,date:'2026-11-05',duration:2,transmission:'all',marketConfirmed:true,mm:null},{location:point.scraper_label,date:'2026-11-05',duration:3,transmission:'all',marketConfirmed:true},{location:point.scraper_label,date:'2026-11-06',duration:2,transmission:'all',marketConfirmed:true}]};
 assert.deepEqual([locationCoverage(point,data).missing,locationCoverage(point,data).total],[1,2]);assert.equal(locationCoverage(point,null),null);assert.equal(locationCoverage({scraper_label:'New place'},data).missing,null);
 data.rows.push({location:point.scraper_label,date:'2026-11-06',duration:3,transmission:'all',marketConfirmed:true});assert.equal(locationCoverage(point,data).missing,0);
 assert.equal(locationCoverage(point,{...data,rows:[]}).missing,null);
});
