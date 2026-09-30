const assert = require('assert/strict');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const now = '2026-09-29T12:00:00Z';
const location = 'Warsaw Chopin Airport (WAW)';
const baseline = {
  workbook_sha256: 'confirmed-hash',
  baseline_confirmation: { confirmed: true, calibration_eligible: true, confirmed_at: '2026-09-25', workbook_sha256: 'confirmed-hash' },
  location_zones: { [location]: ['WALO'] },
  class_mappings: [{location,broker_code:'CWAV',group:'CWAV',confirmed:true,source:'user_confirmed',baseline_sha256:'confirmed-hash'}],
  rows: [{group:'CWAV', zone:'WALO',start_date:'2026-09-30',end_date:'2026-10-10',rates:{2:30}}]
};
function scenario(date, total = 66) {
  const offer = {provider_name:'MM Cars Rental',total_price:total,rental_days:2,currency:'PLN',car_name:'Known model',transmission:'automatic',vehicle_class_code:'CWAV',vehicle_class_source:'api_sipp'};
  const top = {provider_name:'Competitor',total_price:70,rental_days:2,currency:'PLN',transmission:'automatic'};
  const end = new Date(date+'T11:00:00Z'); end.setUTCDate(end.getUTCDate()+2);
  return {start_date:date,rental_days:2,pickup_date:date+'T11:00:00+02:00',dropoff_date:end.toISOString().slice(0,10)+'T11:00:00+02:00',generated_at:now,
    top_3_plus_mm_by_location:{[location]:{top_3:[offer,top],mm_cars_rental:offer}},
    offer_views_by_location:{[location]:{automatic:{top_3:[offer,top],mm_cars_rental:offer}}}};
}
const payload = {generated_at:now, locations:[location],scenarios:['2026-09-30','2026-10-01','2026-10-02'].map(d=>scenario(d))};
const options = {forceTop1:true,currentBaseline:baseline,calibrationNow:now,brokerMarkupCalibration:{enabled:true,defaultMultiplier:1.163105}};
const result = buildPricingRecommendations(payload, options);
assert.equal(result.decisions[0].broker_markup_multiplier,1.1,'Three exact fresh comparisons replace historical markup for this scenario');
assert.equal(result.decisions[0].broker_markup_source,'current-exact-scenario');
assert.equal(result.decisions[0].markup_evidence.baseline_rate_pln_day,30);
assert.equal(result.decisions[0].markup_evidence.sample_count,3);
const clone = value => JSON.parse(JSON.stringify(value));
for (const [name, change] of [
  ['unknown class',p=>{for(const s of p.scenarios) delete s.offer_views_by_location[location].automatic.mm_cars_rental.vehicle_class_code;}],
  ['stale data',p=>{for(const s of p.scenarios)s.generated_at='2026-09-27T00:00:00Z';}],
  ['inconsistent cohort',p=>{p.scenarios[2].offer_views_by_location[location].automatic.mm_cars_rental.total_price=71;}],
  ['single observation',p=>{p.scenarios=p.scenarios.slice(0,1);}],
]) {
  const p=clone(payload);change(p);
  const decision=buildPricingRecommendations(p,options).decisions[0];
  assert.equal(decision.broker_markup_multiplier,1.163105,name+' must not replace model');
  assert.notEqual(decision.markup_evidence.status,'supported',name);
}
const conflicting=clone(baseline);conflicting.rows.push({...conflicting.rows[0],rates:{2:40}});
assert.equal(buildPricingRecommendations(payload,{...options,currentBaseline:conflicting}).decisions[0].markup_evidence.status,'ambiguous_baseline');
const unconfirmed=clone(baseline);unconfirmed.baseline_confirmation.confirmed=false;
assert.equal(buildPricingRecommendations(payload,{...options,currentBaseline:unconfirmed}).decisions[0].markup_evidence.status,'baseline_unconfirmed');
assert.equal(baseline.rows[0].rates[2],30,'Baseline remains unchanged');
const { currentLearningObservations } = require('../src/currentBrokerMarkup');
assert.equal(currentLearningObservations(result).count,3,'Only exact supported comparisons feed ongoing learning');
assert.equal(currentLearningObservations({decisions:[{markup_evidence:{status:'missing_class',observed_multiplier:1.16}}]}).count,0);
const wrongTariff=clone(baseline);wrongTariff.rows[0].rates[2]=200;
assert.equal(buildPricingRecommendations(payload,{...options,currentBaseline:wrongTariff}).decisions[0].action,'hold','Contradictory live/base prices must block changes, not silently reuse history');
const unmapped=clone(baseline);unmapped.class_mappings=[];
const unmappedResult=buildPricingRecommendations(payload,{...options,currentBaseline:unmapped});
assert.equal(unmappedResult.decisions[0].markup_evidence.status,'unverified_class_mapping','Same code string does not prove broker to supplier tariff mapping');
assert.ok(unmappedResult.decisions.every(d=>d.action==='hold' && d.data_quality_status==='markup_needs_review' && d.maximum_import_rate_pln_day===null));
assert.equal(currentLearningObservations(unmappedResult).count,0);
console.log('Current markup tests passed');

const { selectMarkupChecks, verifyCurrentMarkup } = require('../src/verifyCurrentMarkup');
const checks = selectMarkupChecks({decisions:[
  {location,start_date:'2026-09-30',rental_days:2,action:'hold',data_quality_status:'floor_blocks_top3',markup_evidence:{status:'missing_class'}},
  {location,start_date:'2026-10-01',rental_days:2,action:'hold',data_quality_status:'floor_blocks_top3',markup_evidence:{status:'missing_class'}},
  {location:'Other',start_date:'2026-10-01',rental_days:2,action:'hold',data_quality_status:'duration_excluded'},
]}, 6);
assert.equal(checks.length,1,'Repeated cohort needs only one extra probe');
assert.equal(selectMarkupChecks({decisions:checks},0).length,0,'Smoke runs do not launch probes');
(async()=>{
  const priorityOptions={...options,priorityTop1Rules:[{id:'test',locations:['*'],startDate:'2026-09-01',endDate:'2026-10-25',durationBands:[[2,2]],transmission:'automatic',minimumRatePlnDay:30}]};
  const p=clone(payload);p.scenarios=p.scenarios.slice(0,1);
  const view=p.scenarios[0].offer_views_by_location[location].automatic;
  view.top_3[1].total_price=62;view.top_3.reverse();
  delete view.mm_cars_rental.vehicle_class_code;
  const result=await verifyCurrentMarkup(p,priorityOptions,{maxChecks:1,now,probe:async()=>({offers:[
    {provider_name:'Competitor',total_price:64.93,currency:'PLN',transmission:'automatic',source:'dom'},
    {provider_name:'MM Cars Rental',total_price:73.38,currency:'PLN',transmission:'automatic',source:'dom'}
  ],checked_at:now})});
  assert.equal(result.markup_verification.checked_count,1);
  assert.equal(result.decisions[0].top1_rate_pln_day,32.47,'Refresh cheapest offer from actual DOM');
  assert.equal(result.decisions[0].markup_evidence.status,'missing_class','Do not invent class from a model name');
  assert.equal(result.decisions[0].broker_markup_multiplier,1.163105);
  const failed=await verifyCurrentMarkup(p,priorityOptions,{maxChecks:1,now,probe:async()=>{throw new Error('network');}});
  assert.equal(failed.markup_verification.checks[0].status,'failed');
  assert.equal(failed.decisions[0].action,'hold');
  const activeFailed=await verifyCurrentMarkup(payload,options,{maxChecks:1,now,probe:async()=>{throw new Error('network');}});
  assert.equal(activeFailed.decisions[0].action,'hold','Failed discrepancy verification cannot authorize an active price change');
  assert.equal(activeFailed.decisions[0].markup_evidence.status,'verification_failed');
  assert.ok(activeFailed.decisions.every(d=>d.action==='hold'),'All dates in failed probe cohort must fail closed');
  assert.equal(currentLearningObservations(activeFailed).count,0,'Failed cohort cannot enter historical learning');
  const skipped=await verifyCurrentMarkup(payload,options,{maxChecks:1,maxDurationMs:0,now,probe:async()=>{throw new Error('Must not run');}});
  assert.ok(skipped.decisions.every(d=>d.action==='hold'),'Budget-skipped selected cohort cannot authorize unverified changes');
  assert.equal(p.scenarios[0].offer_views_by_location[location].automatic.top_3[0].total_price,62,'Never mutate original scraper payload');
  console.log('Selective markup verification tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
