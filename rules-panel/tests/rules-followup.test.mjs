import test from 'node:test';import assert from 'node:assert/strict';
import {durationWarnings,sampleDates,bandLabel,compareDurationWarnings} from '../src/duration-warnings.mjs';
import {plNumber,displayBand,impactSampleStats,excelTimestamp} from '../src/impact-presentation.mjs';
import {presentWarnings} from '../src/warning-presentation.mjs';
import {countLabel} from '../src/operations.mjs';
const model={pricing:{pricing:{mandatoryScopedFloorsPlnDay:[{groups:['CDMV'],zones:['KRLO'],minDays:5,maxDays:7,minimumRatePlnDay:30,startDate:'2026-01-01',endDate:'2028-01-01',overrideProtected:false},{groups:['CDMV'],zones:['KRLO'],minDays:8,maxDays:20,minimumRatePlnDay:50,startDate:'2026-01-01',endDate:'2028-01-01',overrideProtected:false}]}},excel:{apply_groups:['CDMV'],excluded_groups:[]},locations:{locations:[{id:'krakow_airport',scraper_label:'Krakow Airport',city:'Krakow',kind:'airport',zones:['KRLO']}]}};
test('all six floors sampled on today and next twelve month starts; warning is presentation only',()=>{
 assert.equal(sampleDates('2026-11-04').length,13);assert.equal(sampleDates('2026-11-04')[1],'2026-12-01');assert.equal(sampleDates('2026-11-04').at(-1),'2027-11-01');
 const original=structuredClone(model);const rows=durationWarnings(model,'2026-11-04');assert.ok(rows.some(r=>r.message.includes('5–7 dni 30 PLN → 8–20 dni 50 PLN')));assert.deepEqual(model,original);assert.equal(rows[0].dates.length,13);
 assert.equal(bandLabel([1,1]),'1 dzień');assert.equal(bandLabel([2,2]),'2 dni');
 assert.equal(compareDurationWarnings(rows,rows).known.length,rows.length);assert.equal(compareDurationWarnings(rows,[]).added.length,rows.length);
});
test('impact presentation uses Polish numbers, dash, timestamp and samples not full-population estimates',()=>{
 assert.equal(plNumber(14411).replace(/\s/g,' '),'14 411');assert.equal(displayBand('3-4'),'3–4');assert.equal(excelTimestamp('2026-11-04T08:37:00Z'),'04.11.2026, 09:37');
 const stats=impactSampleStats({samples:[{position:{zone:'KRLO'},beforeRate:30,afterRate:50}]},model);assert.deepEqual(stats,{branches:1,mean:20,count:1});assert.equal(impactSampleStats({},model).mean,null);
});
test('rule plurals and overlap bands are readable and long zone lists are summarized',()=>{
 assert.deepEqual([1,2,5].map(n=>countLabel(n,'reguła','reguły','reguł')),['1 reguła','2 reguły','5 reguł']);
 const m=structuredClone(model);const zones=Array.from({length:35},(_,i)=>`X${String(i).padStart(3,'0')}`);m.locations.locations[0].zones=zones;
 m.pricing.pricing.mandatoryScopedFloorsPlnDay=[0,1].map(i=>({...model.pricing.pricing.mandatoryScopedFloorsPlnDay[0],zones,minDays:1,maxDays:1,minimumRatePlnDay:30+i}));
 const text=presentWarnings(m,[]).map(r=>r.message).join(' ');assert.match(text,/35 lokalizacji/);assert.match(text,/1 dzień/);assert.doesNotMatch(text,/1–1 dni|X000, X001/);
});
