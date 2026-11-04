import test from 'node:test';
import assert from 'node:assert/strict';
import {familyTitles,groupRuleBands,locationOptions} from '../src/editor.mjs';
test('family labels distinguish matching names without mutating rules or splitting duration bands',()=>{
 const a={id:'a',title:'KALO: obowiązkowa stawka minimalna',groups:['CDMV'],zones:['KALO'],startDate:'2026-11-01',endDate:'2026-12-01',minDays:1,maxDays:1};
 const rows=[a,{...a,id:'b',minDays:2,maxDays:2},{...a,id:'c',endDate:'2027-01-01'}];const original=structuredClone(rows);
 const families=groupRuleBands(rows);assert.equal(families.length,2);const titles=familyTitles(families);assert.equal(new Set(titles).size,2);assert.deepEqual(rows,original);
});
test('secondary Excel zones explicitly identify their market source',()=>{
 const model={locations:{locations:[{id:'bydgoszcz_airport',city:'Bydgoszcz',kind:'airport',zones:['BZLO','GDT']}]}};
 assert.deepEqual(locationOptions(model).map(x=>x.label),['Bydgoszcz · Lotnisko (BZLO)','GDT · wg rynku Bydgoszcz · Lotnisko']);
});
