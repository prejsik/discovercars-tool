import test from 'node:test';
import assert from 'node:assert/strict';
import {branchOverview,dayLabel,locationLabel,countLabel} from '../src/operations.mjs';

test('branch summary excludes missing/unconfirmed prices from comparable denominator',()=>{
 const row={location:'Krakow Airport (KRK)',date:'2026-11-04',marketConfirmed:true,mm:80,competitor:60,gap:-20};
 const result=branchOverview([row,{...row,duration:4,mm:null,gap:null},{...row,duration:5,mm:null,gap:null},{...row,date:'2026-11-05',marketConfirmed:false,mm:null,gap:null},{...row,gap:-10},{...row,competitor:null,gap:null}])[0];
 assert.equal(result.missingDates,1);
 assert.equal(result.unavailable,1);
 assert.equal(result.over,1);
 assert.equal(result.comparable,2);
 assert.equal(result.share,.5);
});
test('missing competitor does not become a zero gap or percentage',()=>{
 const result=branchOverview([{location:'A',marketConfirmed:true,mm:80,competitor:null,gap:null}])[0];
 assert.equal(result.share,null);assert.equal(result.missingDates,0);
});
test('display labels translate known pickup points without changing unknown labels or IDs',()=>{
 assert.equal(locationLabel('Warsaw West Train Station'),'Warszawa · Dworzec Zachodni');
 assert.equal(locationLabel('Krakow Airport (KRK)'),'Kraków · Lotnisko (KRK)');
 assert.equal(locationLabel('Lodz Lublinek Airport (LCJ)'),'Łódź · Lotnisko (LCJ)');
 assert.equal(locationLabel('Galeria Krakowska Shopping Mall'),'Kraków · Galeria Krakowska');
 assert.equal(locationLabel('WR2'),'WR2');
 assert.equal(locationLabel('New pickup point'),'New pickup point');
 assert.equal(dayLabel('2027-01-02'),'02.01.2027');
 assert.equal(dayLabel(null),'Brak danych');
});
test('Polish count labels handle 1, 2, teens and 22',()=>{
 for(const [n,expected] of [[1,'1 zmiana'],[2,'2 zmiany'],[12,'12 zmian'],[22,'22 zmiany'],[0,'0 zmian']])assert.equal(countLabel(n,'zmiana','zmiany','zmian'),expected);
});

