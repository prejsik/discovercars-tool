const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {resolveBrokerMarkupCalibration: resolve, mergeBrokerMarkupCalibration: merge,
  siteToImportRate, importToSiteRate, fixedMarkupFields} = require('../src/brokerMarkupCalibration');
const {buildPricingRecommendations} = require('../src/pricingRecommendations');
const {verifyCurrentMarkup} = require('../src/verifyCurrentMarkup');
const {buildCalibrationUpdate} = require('../src/updateBrokerMarkupCalibration');
const {mergePricingRecommendations} = require('../src/mergePricingRecommendations');
const fixed = require('../input/broker-markup-frozen.json').brokerMarkupCalibration;
const registry = require('../locations.config.json');
const {pricing} = require('../pricing-rules.config.example.json');
const expected = {
  BYLO:[38,28,15,13,11,11], GD1:[41,31,15,11,13,13], GDLO:[41,31,15,10,13,13],
  KA1:[70,60,44,41,44,44], KALO:[39,29,14,8,12,12], KRDW:[36,26,10,6,9,9],
  KRGA:[40,30,14,11,14,14], KRLO:[46,36,20,15,18,18], KRTI:[46,36,20,15,18,18],
  LO1:[41,31,16,19,15,15], LOLO:[37,27,10,8,11,11], LU1:[43,33,18,17,16,16],
  OL1:[36,26,11,9,9,9], OP1:[36,26,11,9,9,9], PO1:[37,27,11,8,10,10],
  POLO:[36,26,10,5,8,8], TO1:[36,26,12,10,10,10], WA1:[39,29,14,10,12,12],
  WA2:[39,29,14,10,12,12], WALO:[39,29,14,8,12,12], WR1:[36,26,10,6,9,9], WR2:[36,26,10,6,9,9], WRLO:[41,31,15,10,13,13]
};
const options = {...pricing, brokerMarkupCalibration:merge(pricing.brokerMarkupCalibration,{brokerMarkupCalibration:fixed})};
for (const entry of registry.locations) {
  for (const zone of entry.zones) for (let day=1; day<=35; day++) {
    const band = day===1?0:day===2?1:day<=4?2:day<=7?3:day<=20?4:5;
    for (const group of [...fixed.baseGroups,...Object.keys(fixed.groupSupplementsPlnDay)]) {
      const item = {location:entry.scraper_label, rental_days:day, group,
        markup_evidence:{status:'supported', observed_multiplier:1.19}};
      const result = resolve(item,fixed);
      assert.equal(result.amountPlnDay,expected[zone][band]+(fixed.groupSupplementsPlnDay[group]||0));
      assert.equal(resolve({...item,location:zone},fixed).amountPlnDay,result.amountPlnDay);
      assert.equal(result.percent,null);
      assert.equal(importToSiteRate(siteToImportRate(100,result),result),100);
    }
  }
}
assert.throws(()=>resolve({location:'Warsaw',rental_days:2},fixed),/Missing fixed/);
assert.throws(()=>resolve({location:'WALO',rental_days:36},fixed),/Missing fixed/);
assert.throws(()=>resolve({location:'WALO',rental_days:2,group:'UNKNOWN'},fixed),/Missing fixed/);
assert.deepEqual(merge(fixed,{model:'percentage',manualOnly:false,locationDurationAmounts:{}}).locationDurationAmounts,fixed.locationDurationAmounts);
assert.equal(merge(fixed,{manualOnly:false}).manualOnly,true);
const update = buildCalibrationUpdate({baseConfig:options, previousCalibration:{defaultMultiplier:4},
  excelSummary:{get broker_markup_observations(){throw new Error('Unexpected automatic evidence read');}}});
assert.equal(update.learning.enabled,false);

function scenario(rates, days=2) {
  const location = 'Warsaw Chopin Airport (WAW)';
  const offer=(provider,rate)=>({provider_name:provider,total_price:rate*days,rental_days:days,currency:'PLN'});
  const automatic={top_3:rates.map((rate,i)=>offer(`Competitor ${i}`,rate)),mm_cars_rental:offer('MM Cars Rental',150)};
  return {locations:[location],scenarios:[{start_date:'2026-10-01',rental_days:days,
    top_3_plus_mm_by_location:{[location]:automatic},offer_views_by_location:{[location]:{automatic}}}]};
}
for (const [rates,rank,importRate] of [ [[70,90,100],1,40], [[50,70,100],2,40], [[40,50,70],3,40], [[30,40,50],null,null] ]) {
  const item=buildPricingRecommendations(scenario(rates),options).decisions[0];
  assert.equal(item.target_rank || null,rank);
  assert.equal(item.suggested_rate_pln_day,importRate);
  assert.equal(item.broker_markup_amount_pln_day,29);
  assert.equal(item.markup_evidence,undefined);
  if(rank) assert.equal(item.predicted_site_rate_pln_day,69);
}
for (const days of [8,14,20]) {
  const item=buildPricingRecommendations(scenario([100,120,140],days),{...options,forceTop1:true}).decisions[0];
  assert.equal(item.data_quality_status,'ok');
  assert.equal(item.suggested_rate_pln_day,87);
  assert.equal(item.broker_markup_amount_pln_day,12);
}
assert.equal(buildPricingRecommendations(scenario([100,120,140],21),options).decisions[0].data_quality_status,'duration_excluded');
const old={location:'WALO',start_date:'2026-10-01',rental_days:2,action:'decrease',broker_markup_multiplier:1,
  ...fixedMarkupFields(resolve({location:'WALO',rental_days:2},fixed))};
for(const changes of [{broker_markup_amount_pln_day:28},{broker_markup_model:'percentage'},
  {broker_markup_group_supplements_pln_day:{FVMD:20}}]) {
  const merged=mergePricingRecommendations({decisions:[{...old,...changes}]},{decisions:[],options});
  assert.equal(merged.decisions[0].action,'hold');
  assert.equal(merged.decisions[0].maximum_import_rate_pln_day,null);
}
const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/discovercars-daily.yml'),'utf8');
for(const command of ['node src/verifyCurrentMarkup.js','node src/updateBrokerMarkupCalibration.js',
  'node src/mmRateSanityCheck.js','--require-sanity','--baseline-index=']) assert.ok(!workflow.includes(command),command);
assert.ok(workflow.includes('node src/pricingRecommendations.js'));
assert.ok(workflow.includes('verifyActiveRecommendationsDom'));
assert.equal(require('../excel-rate-update.config.example.json').broker_markup_learning.enabled,false);
verifyCurrentMarkup(scenario([70,90,100]),options,{probe:()=>{throw new Error('Unexpected live markup probe');}})
  .then(output=>{
    assert.equal(output.markup_verification.status,'disabled_manual_only');
    assert.equal(output.markup_verification.checked_count,0);
    assert.equal(output.recommendations[0].suggested_rate_pln_day,40);
    console.log('PASS fixed markup: all zones, 1-35 days, all groups, floor/ranking, frozen merge and no automatic probes');
  }).catch(error=>{console.error(error);process.exitCode=1;});
