import test from 'node:test';
import assert from 'node:assert/strict';
import {missingOfferCount,reviewDayLabel,groupedLocations,reportFreshness} from '../src/panel-format.mjs';
import {dashboardOverview} from '../src/dashboard-model.mjs';

test('menu missing offer count uses precisely the Dashboard scope and transmission',()=>{
 const row={date:'2026-11-04',duration:3,transmission:'automatic',marketConfirmed:true,mm:null,location:'Krakow Airport (KRK)'};
 const data={rows:[row,{...row,transmission:'all'},{...row,date:'2026-11-18'},{...row,date:'2026-11-03'},{...row,duration:15},{...row,marketConfirmed:false}]};
 for(const transmission of ['automatic','all'])assert.equal(missingOfferCount(data,'2026-11-04',transmission),dashboardOverview(data,'2026-11-04',transmission).metrics[0].count);
 assert.equal(missingOfferCount(data,'2026-11-04','automatic'),1);
 assert.equal(missingOfferCount(null,'2026-11-04','automatic'),null);
});
test('review date uses accusative Polish weekdays',()=>{
 assert.equal(reviewDayLabel('2026-11-04'),'środę, 4 listopada');
 assert.match(reviewDayLabel('2026-11-01'),/^niedzielę/);
 assert.match(reviewDayLabel('2026-11-07'),/^sobotę/);
});
test('location options group by kind, sort Polish display labels, retain unmapped locations',()=>{
 const locations=[{scraper_label:'Lodz Downtown',zones:['LO1'],kind:'city'},{scraper_label:'Poznan Airport (POZ)',zones:['POLO'],kind:'airport'}];
 const groups=groupedLocations(['Lodz Downtown','Poznan Airport (POZ)','Warsaw Downtown','Krakow Downtown','Unmapped'],locations);
 assert.deepEqual(groups.map(g=>g.label),['Lotniska','Poza lotniskami']);
 assert.deepEqual(groups[1].items.map(i=>i.value),['Krakow Downtown','Lodz Downtown','Unmapped','Warsaw Downtown']);
 assert.equal(groupedLocations([{value:'POLO',label:'Poznań'}],locations)[0].label,'Lotniska');
 assert.equal(groupedLocations([{value:'existing:1',label:'Łódź',kind:'airport'}])[0].label,'Lotniska');
 assert.equal(groupedLocations([{value:'station',label:'Dworzec',kind:'train_station'}])[0].label,'Poza lotniskami');
});
test('compact source handles invalid/missing time and falls back to generation time',()=>{
 assert.equal(reportFreshness(null).stale,false);
 assert.equal(reportFreshness({sourceStartedAt:'bad'}).label,'Brak potwierdzonej daty danych.');
 assert.match(reportFreshness({generatedAt:'2026-11-03T08:37:00Z'}).label,/03.11.*09:37/);
});
