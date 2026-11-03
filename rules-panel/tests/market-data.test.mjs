import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8 } from 'fflate';
import * as evidence from '../src/price-evidence.mjs';
import { loadPriceContext, loadPriceSource } from '../server/reports.mjs';
import { loadMarketEvidence } from '../src/price-loader.mjs';
import { scenarioLink } from '../src/market-model.mjs';

const view=(mm,price,rank='Top 1')=>['MM Cars Rental (8.5)','','80,00 PLN/d','','','Other (8)','','100,00 PLN/d','Third','','120,00 PLN/d',mm,'',rank,'0','top1',false].map((v,i)=>i===7?price:v);
const auto=view('80,00 PLN/d','100,00 PLN/d');
const all=view('80,00 PLN/d','70,00 PLN/d','Top 2');
const bytes=strToU8(`<script type="application/json" id="report-data">${JSON.stringify({scenarios:[{date:'2026-11-04',duration:'3',rows:[['Krakow Airport (KRK)','airport',auto,all]],errors:[]}]})}</script>`);

test('market comparison excludes MM, separates transmissions and keeps total gap consistent',()=>{
  assert.equal(typeof evidence.readMarketRows,'function');
  const rows=evidence.readMarketRows(bytes);
  assert.equal(rows.length,2);
  assert.equal(rows[0].competitor,100);assert.equal(rows[0].mm,80);
  assert.equal(rows[0].gap,20);assert.equal(rows[0].totalGap,60);
  assert.equal(rows[1].competitor,70);assert.equal(rows[1].gap,-10);
  assert.equal(rows[1].cheaperOffers,0);
});

test('unavailable or failed market data never becomes a zero price or confirmed missing MM',()=>{
  assert.equal(typeof evidence.readMarketRows,'function');
  const empty=view('Brak oferty','Brak oferty');empty[0]='';empty[2]='Brak oferty';empty[8]='';empty[10]='Brak oferty';empty[13]='Brak oferty';empty[14]='Brak danych';
  const b=strToU8(`<script type="application/json" id="report-data">${JSON.stringify({scenarios:[{date:'2026-11-04',duration:'3',rows:[['Krakow','airport',empty,empty]],errors:[{location:'Krakow',error:'timeout'}]}]})}</script>`);
  const row=evidence.readMarketRows(b)[0];
  assert.equal(row.mm,null);assert.equal(row.competitor,null);assert.equal(row.gap,null);
  assert.equal(row.cheaperOffers,null);assert.equal(row.marketConfirmed,false);assert.equal(row.error,true);
});

test('market-only reader works without any Excel and pins locations to the report revision',async()=>{
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const manifest={run_id:'123',git_sha:'a'.repeat(40),generated_at:'2026-11-03T12:00:00Z',source_started_at:'2026-11-03T09:00:00Z',status:'failure',start_dates:['2026-11-04'],durations:[3],report_html_sha256:digest};
  const calls=[];const fetcher=async url=>{calls.push(url);if(url.endsWith('/latest-full/run-manifest.json'))return Response.json(manifest);if(url.endsWith('/latest-full/report.html'))return new Response(bytes);throw new Error('Excel must not be requested');};
  const repository={json:async (path,revision)=>{assert.equal(revision,manifest.git_sha);return {locations:[{zones:['KRLO'],scraper_label:'Krakow Airport (KRK)'}]};}};
  const context=await loadPriceContext({mode:'market',reportRunId:'123'},repository,fetcher);
  assert.equal(context.report.runId,'123');assert.equal(context.excel,undefined);
  assert.equal(context.locations[0].zones[0],'KRLO');
  assert.deepEqual(await loadPriceSource({mode:'market',kind:'market',reportRunId:'123'},repository,fetcher),bytes);
  assert.equal(calls.some(url=>url.includes('latest-excel')),false);
  await assert.rejects(loadPriceSource({mode:'market',kind:'baseline',reportRunId:'123'},repository,fetcher),e=>e.status===422);
  await assert.rejects(loadPriceContext({mode:'market',reportRunId:'999'},repository,fetcher),e=>e.status===409);
});

test('a failed location never exposes cached prices as a confirmed market comparison',()=>{
  const data={scenarios:[{date:'2026-11-04',duration:'3',rows:[['Krakow','airport',auto,all]],errors:[{location:'Krakow',error:'timeout'}]}]};
  const rows=evidence.readMarketRows(strToU8(`<script type="application/json" id="report-data">${JSON.stringify(data)}</script>`));
  for(const row of rows) {
    assert.equal(row.marketConfirmed,false);
    for(const field of ['mm','competitor','provider','rank','cheaperOffers','gap','totalGap'])assert.equal(row[field],null,field);
  }
});

test('browser market loading needs no Excel and rejects a changed source signature',async()=>{
  const calls=[];let contextReads=0;let changed=false;
  const fetcher=async url=>{
    calls.push(url);
    if(url.includes('price-source'))return new Response(bytes);
    contextReads++;
    return Response.json({signature:changed&&contextReads>1?'new':'old',report:{runId:'123'},locations:[]});
  };
  assert.equal((await loadMarketEvidence({reportRunId:'123'},fetcher)).rows.length,2);
  assert.equal(calls.length,3);
  assert.ok(calls.every(url=>url.includes('mode=market')&&!url.includes('kind=workbook')));
  changed=true;contextReads=0;
  await assert.rejects(loadMarketEvidence({reportRunId:'123'},fetcher),e=>e.status===409);
});

test('scenario links select city branches as well as airports in the pinned report',()=>{
  const link=new URL(scenarioLink('123',{date:'2026-11-04',duration:3,location:'Warsaw Downtown',transmission:'all'}),'https://panel.test');
  assert.equal(link.searchParams.get('runId'),'123');
  assert.equal(link.searchParams.get('branches'),'all');
  assert.equal(link.searchParams.get('location'),'Warsaw Downtown');
});

test('display helpers distinguish price gaps, missing MM, missing market and stale sources',async()=>{
  const model=await import('../src/market-model.mjs').catch(()=>({}));
  assert.equal(typeof model.marketSignals,'function');
  const now=Date.parse('2026-11-04T12:00:00Z');const report={sourceStartedAt:'2026-11-04T10:00:00Z'};
  assert.deepEqual(model.marketSignals({mm:80,competitor:100,rank:1,gap:20,marketConfirmed:true},report,now),['gap20']);
  assert.deepEqual(model.marketSignals({mm:80,competitor:110,rank:1,gap:30,marketConfirmed:true},report,now),['gap30']);
  assert.deepEqual(model.marketSignals({mm:null,competitor:100,marketConfirmed:true},report,now),['missing']);
  assert.deepEqual(model.marketSignals({mm:null,competitor:null,marketConfirmed:false},report,now),['unavailable']);
  assert.deepEqual(model.marketSignals({mm:80,competitor:70,rank:2,gap:-10,marketConfirmed:true},{sourceStartedAt:'2026-11-01T10:00:00Z'},now),['outside']);
  assert.deepEqual(model.marketSignals({mm:80,competitor:90,rank:1,gap:10,marketConfirmed:true},{sourceStartedAt:'2026-11-02T10:00:00Z'},now),[],'Old reports do not flag every otherwise healthy row');
  assert.equal(Object.hasOwn(model.marketSignalLabels,'stale'),false);
});

test('chart geometry leaves gaps and calendar dates respect leap years and Monday alignment',async()=>{
  const model=await import('../src/market-model.mjs').catch(()=>({}));
  assert.equal(typeof model.lineSegments,'function');
  assert.deepEqual(model.lineSegments([{mm:10},{mm:null},{mm:20},{mm:30}],'mm',i=>i,v=>v),['0,10','2,20 3,30']);
  assert.equal(model.monthDates('2028-02').length,29);
  assert.deepEqual(model.monthDates('invalid'),[]);
});
