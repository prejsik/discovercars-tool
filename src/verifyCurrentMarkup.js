const fs = require('fs');
const path = require('path');
const { buildPricingRecommendations } = require('./pricingRecommendations');
const { mergeBrokerMarkupCalibration } = require('./brokerMarkupCalibration');
const { DiscoverCarsScraper } = require('./discovercars/scraper');
const { buildLocationBreakdown } = require('./discoverCars');
const { blockRecommendation } = require('./verifyActiveRecommendationsDom');
const { keyOf, hasMarkupConflict } = require('./currentBrokerMarkup');

function cohortKey(item) {
  return `${item.location}|${item.rental_days}|${item.markup_evidence?.class_code || ''}`;
}

function selectMarkupChecks(payload, maxChecks = 6) {
  const seen = new Set();
  return (payload.decisions || []).filter(item => {
    const evidence = item.markup_evidence;
    if (!evidence || evidence.status === 'baseline_unconfirmed' || item.data_quality_status === 'duration_excluded') return false;
    const difference = Math.abs(Number(evidence.observed_multiplier) - Number(evidence.historical_multiplier ?? item.broker_markup_multiplier));
    if (!['floor_blocks_top3','markup_needs_review'].includes(item.data_quality_status) && !(difference > 0.03)) return false;
    const key = cohortKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date))).slice(0,Math.max(0,maxChecks));
}

async function probeScenario(item, workDir) {
  const start = String(item.start_date);
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + item.rental_days);
  const scraper = new DiscoverCarsScraper({
    baseUrl:'https://www.discovercars.com', locations:[item.location],
    pickupDate:start,pickupTime:'11:00',dropoffDate:end.toISOString().slice(0,10),dropoffTime:'11:00',
    residenceCountry:'Poland',currency:'PLN',driverAge:30,headless:true,
    timeoutMs:30000,locationConcurrency:1,directCandidateLimit:1,directOffersWaitMs:1000,
    apiFirst:false,speedMode:'fast',transmissionFilter:'automatic',maxProvidersPerLocation:30,
    artifactsDir:workDir
  });
  const output = await scraper.run();
  const offers = output.offerViewsByLocation?.[item.location]?.automatic || output.results || [];
  return { checked_at:new Date().toISOString(), offers:offers.map(offer=>({
    provider_name:offer.provider, total_price:offer.totalPrice,currency:offer.currency,
    car_name:offer.carName,transmission:offer.transmission,source:offer.source,
    vehicle_class_code:offer.vehicle_class_code,vehicle_class_source:offer.vehicle_class_source
  })) };
}

async function verifyCurrentMarkup(payload, pricingOptions, options = {}) {
  const started = Date.now();
  const initial = buildPricingRecommendations(payload,pricingOptions);
  if (pricingOptions.brokerMarkupCalibration?.manualOnly === true) {
    return {...initial, markup_verification: {status:'disabled_manual_only', selected_count:0,
      checked_count:0, skipped_count:0, elapsed_ms:Date.now()-started, checks:[]}};
  }
  const selected = selectMarkupChecks(initial,options.maxChecks ?? 6);
  // Clone only the scenarios being refreshed; the original report remains an audit source.
  const refreshed = {...payload,scenarios:[...(payload.scenarios || [payload])]};
  const checks = [];
  const failedCohorts = new Map();
  for (const item of selected) {
    if (Date.now()-started >= (options.maxDurationMs ?? 120000)) break;
    try {
      const live = await (options.probe || probeScenario)(item,options.workDir || 'output/markup-verification');
      const offers = live.offers.filter(offer=>offer.currency==='PLN' && offer.transmission==='automatic'
        && Number.isFinite(Number(offer.total_price)) && Number(offer.total_price)>0)
        .map(offer=>({...offer,rental_days:item.rental_days}));
      const summary = buildLocationBreakdown(item.location,offers);
      const top = summary.top_3_offers;
      const mm = summary.mm_cars_rental_offer;
      if (!top.length || top[0].source !== 'dom' || !mm || mm.source !== 'dom') {
        throw new Error('Brak potwierdzonej w DOM ceny top1 lub MM Cars Rental.');
      }
      const index = refreshed.scenarios.findIndex(s=>s.start_date===item.start_date && s.rental_days===item.rental_days);
      if (index < 0) throw new Error('Brak scenariusza zrodlowego.');
      const scenario = refreshed.scenarios[index];
      const view = {top_3:top,mm_cars_rental:mm};
      const allDom = top.every(offer=>offer.source==='dom');
      refreshed.scenarios[index] = {...scenario,
        top_3_plus_mm_by_location:{...scenario.top_3_plus_mm_by_location,[item.location]:view},
        offer_views_by_location:{...scenario.offer_views_by_location,
          [item.location]:{...scenario.offer_views_by_location?.[item.location],automatic:view}},
        source_generated_at_by_location:{...scenario.source_generated_at_by_location,[item.location]:live.checked_at},
        source_validation_by_location:{...scenario.source_validation_by_location,
          [item.location]:{status:allDom?'dom_only':'api_unverified',reasons:[]}}
      };
      checks.push({location:item.location,start_date:item.start_date,rental_days:item.rental_days,
        status:'checked',checked_at:live.checked_at,mm_total: mm.total_price,
        top1_total:top[0].total_price,mm_class_code:mm.vehicle_class_code || null});
    } catch(error) {
      checks.push({location:item.location,start_date:item.start_date,rental_days:item.rental_days,status:'failed',reason:error.message});
      failedCohorts.set(cohortKey(item),error.message);
    }
  }
  for (const item of selected.slice(checks.length)) failedCohorts.set(cohortKey(item),'markup_check_budget_exhausted');
  const final = buildPricingRecommendations(refreshed,pricingOptions);
  const initialByKey = new Map(initial.decisions.map(item=>[keyOf(item.location,item.start_date,item.rental_days),item]));
  final.decisions = final.decisions.map(decision=>{
    const before = initialByKey.get(keyOf(decision.location,decision.start_date,decision.rental_days));
    if (hasMarkupConflict(before?.markup_evidence) && decision.markup_evidence?.status !== 'supported') {
      decision = {...decision, action:'hold',suggested_rate_pln_day:null,maximum_import_rate_pln_day:null,
        site_cap_rate_pln_day:null,change_pln_day:0,data_quality_status:'markup_needs_review',reason:before.reason,
        markup_evidence:{...before.markup_evidence,live_check_status:decision.markup_evidence?.status}};
    }
    const failed = failedCohorts.get(cohortKey(before || decision));
    if (!failed) return decision;
    const result = decision.action === 'hold' ? decision : blockRecommendation(decision,'markup_verification_failed',[failed]);
    return {...result,markup_evidence:{...decision.markup_evidence,status:'verification_failed'}};
  });
  final.recommendations = final.decisions.filter(decision=>decision.action!=='hold');
  final.recommendation_count = final.recommendations.length;
  final.skipped_count = final.decisions.length - final.recommendation_count;
  final.markup_verification = {selected_count:selected.length,checked_count:checks.filter(c=>c.status==='checked').length,
    skipped_count:selected.length-checks.length,elapsed_ms:Date.now()-started,checks};
  return final;
}

async function runCli() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...value]=arg.replace(/^--/,'').split('=');return [key,value.join('=')];}));
  const read = file=>JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
  const config = read(args.config); const pricing = config.pricing || config;
  const calibration = pricing.brokerMarkupCalibration?.manualOnly === true
    ? read(path.join(__dirname, '..', 'input', 'broker-markup-frozen.json'))
    : args.calibration ? read(args.calibration) : {};
  if (pricing.brokerMarkupCalibration?.manualOnly === true && calibration.brokerMarkupCalibration?.manualOnly !== true) {
    throw new Error('Frozen broker markup calibration must set manualOnly=true.');
  }
  const output = await verifyCurrentMarkup(read(args.input),{
    ...pricing,currentBaseline:pricing.brokerMarkupCalibration?.manualOnly === true ? null : read(args['baseline-index']),
    brokerMarkupCalibration:mergeBrokerMarkupCalibration(pricing.brokerMarkupCalibration,calibration)
  },{maxChecks:args['max-checks'] === undefined ? 6 : Number(args['max-checks']),workDir:args['work-dir']});
  fs.mkdirSync(path.dirname(path.resolve(args.output)),{recursive:true});
  fs.writeFileSync(args.output,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify(output.markup_verification));
}
if (require.main===module) runCli().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={selectMarkupChecks,verifyCurrentMarkup,probeScenario};
