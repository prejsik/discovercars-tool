import test from 'node:test';
import assert from 'node:assert/strict';
import {priceTone} from '../src/market-model.mjs';
import {signedPrice,weekdayDate,monthLabel} from '../src/visual-format.mjs';
test('price tone thresholds keep +/-5 neutral and do not treat missing as zero',()=>{
 for(const [n,t] of [[0,'neutral'],[5,'neutral'],[-5,'neutral'],[5.01,'over-1'],[10,'over-2'],[20,'over-3'],[40,'over-4'],[-5.01,'under-1'],[-20,'under-2'],[-30,'under-3'],[null,'nodata']])assert.equal(priceTone(n),t);
});
test('small differences retain direction and dates use Polish weekday',()=>{
 assert.equal(signedPrice(4.44),'+4,44');assert.equal(signedPrice(-4.44),'−4,44');
 assert.equal(weekdayDate('2026-11-04'),'śr 04.11.2026');
 assert.equal(monthLabel('2026-11'),'listopad 2026');
});
import {mapCell,buildAttentionMap} from '../src/attention-map.mjs';
test('map uses band median, majority missing and identical summary criteria',()=>{
 const row=(duration,gap,extra={})=>({duration,marketConfirmed:true,mm:60,gap,...extra});
 assert.equal(mapCell([row(3,-90,{marketConfirmed:false})]).tone,'nodata');
 assert.equal(mapCell([row(3,-40),row(4,20),row(5,-100)]).value,10);
 const partial=mapCell([row(3,null,{mm:null}),row(4,20)]);
 assert.equal(partial.value,-20);assert.equal(partial.missing,1);assert.equal(partial.total,2);assert.deepEqual(partial.missingDurations,[3]);assert.equal(partial.problem,false);
 assert.equal(mapCell([row(3,null,{mm:null}),row(4,null,{mm:null})]).tone,'missing');
 assert.equal(mapCell([row(3,null,{mm:null})]).tone,'nodata','Unknown lengths are not missing MM');
 assert.equal(mapCell([row(2,-10)],'2').problem,false);
 assert.equal(mapCell([row(2,-10.01)],'2').problem,true);
 assert.equal(mapCell([row(5,-90),row(6,-7),row(7,20)],'5-7').value,7);
 assert.equal(mapCell([8,9,10,11,12,13,14].map(d=>row(d,d-12)),'8-20').value,1);
 assert.equal(mapCell([8,9,10,11].map(d=>row(d,null,{mm:null})),'8-20').tone,'missing');
 const map=buildAttentionMap([{...row(3,-15),location:'B',date:'2026-11-03'},{...row(3,0),location:'A',date:'2026-11-03'}],['2026-11-03','2026-11-04']);
 assert.equal(map[0].location,'B');assert.equal(map[0].problems,1);assert.equal(map[0].cells[1].tone,'nodata');
});
import {mixedBand} from '../src/attention-map.mjs';
test('mixed band only compares confirmed differences strictly outside the neutral band',()=>{
 assert.equal(mixedBand([{marketConfirmed:true,gap:-6},{marketConfirmed:true,gap:7}]),true);
 assert.equal(mixedBand([{marketConfirmed:true,gap:-5},{marketConfirmed:true,gap:7}]),false);
 assert.equal(mixedBand([{marketConfirmed:false,gap:-6},{marketConfirmed:true,gap:7}]),false);
});
import {calendarSummary} from '../src/attention-map.mjs';
test('calendar summary excludes unconfirmed/missing prices from comparison denominator',()=>{
 assert.deepEqual(calendarSummary([{marketConfirmed:true,mm:10,competitor:20,gap:10,rank:1},{marketConfirmed:true,mm:30,competitor:20,gap:-10,rank:2},{marketConfirmed:false,mm:10,competitor:20,gap:10,rank:1},{marketConfirmed:true,mm:null,competitor:20,gap:null}]),{comparable:2,top1:1,average:-0});
 assert.equal(calendarSummary([]).average,null);
});
import {dashboardOverview,matchesReview} from '../src/dashboard-model.mjs';
test('dashboard counts use next 14 days, all cars and 2-14 days, with selected transmission',()=>{
 const row={location:'A',date:'2026-11-04',duration:3,transmission:'all',marketConfirmed:true,mm:80,competitor:60,gap:-20};
 const data={rows:[row,{...row,mm:null,gap:null},{...row,marketConfirmed:false},{...row,transmission:'automatic'},{...row,date:'2026-11-17'},{...row,duration:15}]};
 const result=dashboardOverview(data,'2026-11-03','all');
 assert.equal(result.rows.length,3);assert.deepEqual(result.metrics.map(m=>m.count),[1,1,0,1]);
 assert.equal(dashboardOverview(data,'2026-11-03').rows.length,1);assert.equal(result.metrics[0].days.length,14);
 assert.equal(matchesReview({...row,rank:1,gap:30},'reserve'),true);
 assert.equal(matchesReview({...row,marketConfirmed:false,rank:1,gap:30},'reserve'),false);
});
import {initialMarketWindow} from '../src/market-model.mjs';
test('initial window follows report start dates, including a first date without rows',()=>{
 assert.deepEqual(initialMarketWindow({report:{startDates:['2026-11-04','2026-11-02']},rows:[{date:'2026-11-04'}]}),{from:'2026-11-02',to:'2026-11-15'});
 assert.deepEqual(initialMarketWindow({rows:[{date:'2026-12-28'}]}),{from:'2026-12-28',to:'2027-01-10'});
 assert.deepEqual(initialMarketWindow(null),{from:'',to:''});
});
