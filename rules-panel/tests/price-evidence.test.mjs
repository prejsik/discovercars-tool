import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { workbookRows, selectRates, readMarket, combineEvidence } from '../server/price-evidence.mjs';
import { priceFixture } from './price-fixture.mjs';

test('price endpoint binds workbook, report, original baseline and summary hashes',async()=>{
  const result=await priceFixture();
  assert.equal(result.rows[0].baseline,65);assert.equal(result.rows[0].importRate,63);
  assert.equal(result.rows[0].competitor,74);assert.equal(result.rows[0].predicted,73);
  assert.deepEqual(result.warnings,[]);
  await assert.rejects(priceFixture({wrongWorkbook:true}),error=>error.status===409);
  await assert.rejects(priceFixture({changeDuringRead:true}),error=>error.status===409);
  const unverified=await priceFixture({wrongBaseline:true});
  assert.equal(unverified.rows[0].baseline,null);assert.equal(unverified.warnings.length,1);
});

const zip = sheet => zipSync(Object.fromEntries(Object.entries({
  'xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="Sheet1" r:id="r1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':sheet,
}).map(([key,value])=>[key,strToU8(value)])));
const cell=(ref,value)=>`<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const row={A:'CDMV',D:'KRLO',G:'2026-11-01',H:'2026-12-31',K:60};
const query={zone:'KRLO',group:'CDMV',duration:3};
test('read all workbook rows including hidden filtered rows, without changing bytes',()=>{
  const bytes=zip(`<worksheet><sheetData><row r="5" hidden="1">${Object.entries(row).map(([k,v])=>cell(k+'5',v)).join('')}</row></sheetData></worksheet>`);
  const before=bytes.slice();
  assert.equal(workbookRows(bytes,'Sheet1')[0].K,'60');
  assert.deepEqual(bytes,before);
});
test('select exact group, zone and duration column and preserve full source interval',()=>{
  assert.deepEqual(selectRates([row,{...row,A:'PDAH',K:250}],query),[{start:'2026-11-01',end:'2026-12-31',rate:60}]);
});
test('extract market as data only and keep automatic and all-car offers separate',()=>{
  const auto=['Flex','','74,00 PLN/d','','','MM Cars Rental','','80,00 PLN/d','','','Brak oferty','80,00 PLN/d','','Top 2'];
  const all=[...auto];all[2]='70,00 PLN/d';
  const html=`<script type="application/json" id="report-data">${JSON.stringify({scenarios:[{date:'2026-11-04',duration:'3',rows:[['Krakow Airport (KRK)','airport',auto,all]]}]})}</script>`;
  assert.equal(readMarket(strToU8(html),{location:'Krakow Airport (KRK)',duration:3,transmission:'automatic'})[0].competitor,74);
  assert.equal(readMarket(strToU8(html),{location:'Krakow Airport (KRK)',duration:3,transmission:'all'})[0].competitor,70);
});
test('ambiguous base intervals never become a made-up rate; different run market never proves a decision',()=>{
  const result=combineEvidence({dates:['2026-11-04'],base:[{start:'2026-11-01',end:'2026-12-31',rate:60},{start:'2026-11-04',end:'2026-11-04',rate:70}],final:[{start:'2026-11-01',end:'2026-12-31',rate:65}],market:[{date:'2026-11-04',mm:80,competitor:74}],reviews:[],changes:[],sameRun:false,query});
  assert.equal(result[0].baseline,null);
  assert.equal(result[0].importRate,65);
  assert.equal(result[0].predicted,null);
  assert.equal(result[0].decision,null);
});
test('group-specific saved explanation wins, null prices stay null, no recalibration',()=>{
  const changes=[{zone:'KRLO',group:'CDMV',pickup_date:'2026-11-04',duration_min_days:3,duration_max_days:4,old_rate:60,new_rate:63,predicted_site_rate:73,minimum_rate_pln_day:30,controlling_duration_days:4,reason:'Saved reason'}];
  const out=combineEvidence({dates:['2026-11-04'],base:[],final:[{start:'2026-11-04',end:'2026-11-04',rate:63}],market:[],reviews:[],changes,sameRun:true,query});
  assert.equal(out[0].predicted,73);assert.equal(out[0].decision.reason,'Saved reason');assert.equal(out[0].mm,null);
});
test('reject XML entity declarations and missing workbook metadata',()=>{
  assert.throws(()=>workbookRows(zip('<!DOCTYPE x><worksheet/>'),'Sheet1'));
  assert.throws(()=>workbookRows(zipSync({}),'Sheet1'));
});
