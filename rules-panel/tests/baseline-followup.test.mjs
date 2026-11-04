import test from 'node:test';import assert from 'node:assert/strict';
import {baselineDelta,codesDelta,baselineWarnings,reportRunLabel} from '../src/baseline-presentation.mjs';
import {countLabel} from '../src/operations.mjs';
test('comparison uses true minus, unchanged text and explicit added/removed codes even with a zero net count',()=>{
 assert.equal(baselineDelta(100,99),'−1');assert.equal(baselineDelta(100,100),'bez zmian');assert.equal(baselineDelta(99,100),'+1');
 assert.equal(codesDelta(['LU1'],[]),'−1: LU1');assert.equal(codesDelta([],['RZLO','RZ1']),'+2: RZLO, RZ1');assert.equal(codesDelta(['LU1'],['RZ1']),'−1: LU1; +1: RZ1');assert.equal(codesDelta([],[]),'bez zmian');
 const model={locations:{locations:[{id:'lubin_city',city:'Lubin',kind:'city',zones:['LU1']}]}};
 assert.equal(baselineWarnings({zones:['LU1']},{zones:[]},model)[0],'Brakuje kodu LU1 · Lubin · Miasto');
});
test('single run label uses Warsaw start time rather than generated time; unknown starts stay neutral',()=>{
 assert.equal(reportRunLabel({sourceStartedAt:'2026-11-04T08:37:00Z',generatedAt:'2026-11-04T20:00:00Z'}),'Przebieg poranny · 04.11.2026, 09:37');
 assert.equal(reportRunLabel({sourceStartedAt:'2026-11-04T17:07:00Z'}),'Przebieg wieczorny · 04.11.2026, 18:07');assert.match(reportRunLabel({generatedAt:'2026-11-04T17:07:00Z'}),/^Przebieg ·/);assert.match(reportRunLabel({}),/brak potwierdzonej daty/);
});
test('extra zone counts use correct Polish declension',()=>{assert.deepEqual([1,2,9].map(n=>'+'+countLabel(n,'kod','kody','kodów')),['+1 kod','+2 kody','+9 kodów']);});
