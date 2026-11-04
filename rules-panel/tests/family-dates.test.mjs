import test from 'node:test';
import assert from 'node:assert/strict';
import {updateFamilyDates} from '../src/family-dates.mjs';
import {buildRules} from '../src/policy.mjs';
const model={pricing:{pricing:{mandatoryGroupFloorsPlnDay:{FVMD:[[1,1,1000],[2,2,700],[3,4,600],[5,7,500],[8,20,500],[21,35,400]].map(([minDays,maxDays,minimumRatePlnDay])=>({minDays,maxDays,minimumRatePlnDay,start_date:'2026-12-15',end_date:'2027-01-05',override_protected_dates:true}))}}},excel:{},locations:{locations:[]}};
test('family date edit preserves every amount and scope and changes all six bands atomically',()=>{
 const before=structuredClone(model),ids=buildRules(model).map(r=>r.id);
 const next=updateFamilyDates(model,ids,{startDate:'2026-12-16',endDate:'2027-01-08'});
 assert.deepEqual(model,before);
 assert.deepEqual(next.pricing.pricing.mandatoryGroupFloorsPlnDay.FVMD,before.pricing.pricing.mandatoryGroupFloorsPlnDay.FVMD.map(r=>({...r,start_date:'2026-12-16',end_date:'2027-01-08'})));
 assert.throws(()=>updateFamilyDates(model,ids.slice(1),{startDate:'2026-12-16',endDate:'2027-01-08'}));
 assert.throws(()=>updateFamilyDates(model,ids,{startDate:'2027-02-30',endDate:'2027-03-08'}));
 assert.throws(()=>updateFamilyDates(model,ids,{startDate:'2027-03-08',endDate:'2027-01-08'}));
});
