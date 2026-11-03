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
test('map cells distinguish no data, missing MM and worst confirmed gap',()=>{
 assert.equal(mapCell([{marketConfirmed:false,mm:null}]).tone,'nodata');
 assert.equal(mapCell([{marketConfirmed:true,mm:null},{marketConfirmed:true,mm:60,gap:-40}]).tone,'missing');
 assert.equal(mapCell([{marketConfirmed:true,mm:60,gap:-7},{marketConfirmed:true,mm:60,gap:20}]).value,7);
 assert.equal(mapCell([{marketConfirmed:false,mm:60,gap:-90},{marketConfirmed:true,mm:60,gap:10}]).value,-10);
 assert.equal(mapCell([{marketConfirmed:true,mm:60,gap:-10}]).problem,false);
 assert.equal(mapCell([{marketConfirmed:true,mm:60,gap:-10.01}]).problem,true);
 const map=buildAttentionMap([{location:'B',date:'2026-11-03',marketConfirmed:true,mm:20,gap:-15},{location:'A',date:'2026-11-03',marketConfirmed:true,mm:20,gap:0}],['2026-11-03','2026-11-04']);
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
