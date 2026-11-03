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
