// Only explicit class codes and confirmed, unchanged baseline rows may calibrate prices.
function keyOf(location, date, days) {
  return `${location}|${String(date).slice(0, 10)}|${Number(days)}`;
}

function hasMarkupConflict(evidence) {
  return ['ratio_out_of_range','inconsistent_samples','ambiguous_baseline','baseline_unconfirmed','unverified_class_mapping'].includes(evidence?.status);
}

function buildCurrentMarkupEvidence(payload, baseline, now = new Date().toISOString()) {
  const evidence = new Map();
  if (!baseline) return evidence;
  const confirmation = baseline.baseline_confirmation || {};
  const confirmed = confirmation.confirmed && confirmation.calibration_eligible
    && confirmation.workbook_sha256 === baseline.workbook_sha256;
  const rowsByZoneGroup = new Map();
  for (const row of baseline.rows || []) {
    const key = `${row.zone}|${row.group}`;
    if (!rowsByZoneGroup.has(key)) rowsByZoneGroup.set(key, []);
    rowsByZoneGroup.get(key).push(row);
  }
  const cohorts = new Map();
  for (const scenario of payload.scenarios || [payload]) {
    for (const [location, data] of Object.entries(scenario.top_3_plus_mm_by_location || {})) {
      const view = scenario.offer_views_by_location?.[location]?.automatic || data;
      const offer = view?.mm_cars_rental;
      const start = String(scenario.start_date || '').slice(0, 10);
      const days = Number(scenario.rental_days);
      const code = String(offer?.vehicle_class_code || '').toUpperCase();
      const observedAt = scenario.source_generated_at_by_location?.[location] || scenario.generated_at || payload.generated_at;
      const item = { status: 'missing_class', location, start_date: start, rental_days: days,
        observed_at: observedAt, baseline_sha256: baseline.workbook_sha256, class_code: code || null };
      evidence.set(keyOf(location, start, days), item);
      if (!confirmed) { item.status = 'baseline_unconfirmed'; continue; }
      const age = Date.parse(now) - Date.parse(observedAt);
      if (!Number.isFinite(age) || age < -300000 || age > 86400000
          || !confirmation.confirmed_at || Date.parse(observedAt) < Date.parse(confirmation.confirmed_at)) {
        item.status = 'stale_observation'; continue;
      }
      if (!offer || !/^mm cars rental$/i.test(String(offer.provider_name || '').trim())
          || offer.currency !== 'PLN' || offer.transmission !== 'automatic') {
        item.status = 'offer_not_comparable'; continue;
      }
      if (!/^[A-Z]{4}$/.test(code) || !['api_sipp','api_acriss'].includes(offer.vehicle_class_source)) continue;
      const mappings = (baseline.class_mappings || []).filter(mapping => mapping.confirmed === true
        && mapping.source === 'user_confirmed' && mapping.baseline_sha256 === baseline.workbook_sha256
        && mapping.location === location && mapping.broker_code === code && /^[A-Z]{4}$/.test(mapping.group));
      const mappedGroups = [...new Set(mappings.map(mapping=>mapping.group))];
      if (mappedGroups.length > 1) {item.status='ambiguous_baseline';continue;}
      const group = mappedGroups[0] || code;
      item.baseline_match_verified = mappedGroups.length === 1;
      item.baseline_group = group;
      const pickup = String(scenario.pickup_date || '');
      const dropoff = String(scenario.dropoff_date || '');
      if (!Number.isInteger(days) || days <= 0 || Number(offer.rental_days) !== days
          || pickup.slice(0,10) !== start || pickup.slice(11,16) !== '11:00' || dropoff.slice(11,16) !== '11:00'
          || (Date.parse(dropoff.slice(0,10)) - Date.parse(pickup.slice(0,10))) / 86400000 !== days
          || (offer.pickup_date && offer.pickup_date !== scenario.pickup_date)
          || (offer.dropoff_date && offer.dropoff_date !== scenario.dropoff_date)) {
        item.status = 'duration_mismatch'; continue;
      }
      const zones = baseline.location_zones?.[location] || [];
      const rows = zones.flatMap(zone => rowsByZoneGroup.get(`${zone}|${group}`) || [])
        .filter(row => row.start_date <= start && row.end_date >= start);
      if (!zones.length || zones.some(zone => !rows.some(row => row.zone === zone))) {
        item.status = 'missing_baseline'; continue;
      }
      const rates = rows.map(row => Number(row.rates?.[days]));
      if (!rates.length || rates.some(rate => !Number.isFinite(rate) || rate <= 0)) {
        item.status = 'missing_baseline_rate'; continue;
      }
      if (new Set(rates).size !== 1) { item.status = 'ambiguous_baseline'; continue; }
      const liveRate = Number(offer.total_price) / days;
      if (!Number.isFinite(liveRate) || liveRate <= 0) { item.status = 'invalid_price'; continue; }
      item.baseline_rate_pln_day = rates[0];
      item.live_rate_pln_day = liveRate;
      item.observed_multiplier = Number((liveRate / rates[0]).toFixed(6));
      item.observed_markup_percent = Number(((liveRate / rates[0] - 1) * 100).toFixed(2));
      // A large discrepancy may be a different tariff, a promotion or a stale import.
      if (item.observed_multiplier < 1 || item.observed_multiplier > 1.2) {
        item.status = 'ratio_out_of_range'; continue;
      }
      if (!item.baseline_match_verified) {item.status='unverified_class_mapping';continue;}
      item.status = 'insufficient_samples';
      const cohortKey = `${location}|${days}|${code}`;
      if (!cohorts.has(cohortKey)) cohorts.set(cohortKey, new Map());
      cohorts.get(cohortKey).set(start, item);
    }
  }
  for (const dates of cohorts.values()) {
    for (const item of dates.values()) {
      const samples = [...dates.values()].filter(other => Math.abs(Date.parse(other.start_date) - Date.parse(item.start_date)) <= 14 * 86400000);
      item.sample_count = samples.length;
      if (samples.length < 3) continue;
      const ratios = samples.map(other => other.observed_multiplier).sort((a,b) => a-b);
      item.cohort_spread = Number((ratios.at(-1)-ratios[0]).toFixed(6));
      item.status = item.cohort_spread <= 0.03 ? 'supported' : 'inconsistent_samples';
    }
  }
  return evidence;
}

function currentLearningObservations(payload) {
  const unique = new Map();
  for (const decision of payload.decisions || []) {
    const item = decision.markup_evidence;
    if (item?.status !== 'supported'
        || (decision.dom_verification_status && !String(decision.dom_verification_status).startsWith('confirmed'))) continue;
    unique.set(keyOf(item.location,item.start_date,item.rental_days),item);
  }
  const items = [...unique.values()];
  const summarize = values => {
    const ratios = values.map(v=>v.observed_multiplier).sort((a,b)=>a-b);
    const count = ratios.length;
    const average = count ? ratios.reduce((a,b)=>a+b,0)/count : null;
    const median = count ? (ratios[Math.floor((count-1)/2)]+ratios[Math.floor(count/2)])/2 : null;
    return {count,average_multiplier:average,median_multiplier:median,
      average_markup_percent:average===null?null:(average-1)*100};
  };
  const byLocation = {}, byDuration = {}, byLocationDuration = {};
  for (const item of items) {
    (byLocation[item.location] ||= []).push(item);
    (byDuration[item.rental_days] ||= []).push(item);
    ((byLocationDuration[item.location] ||= {})[item.rental_days] ||= []).push(item);
  }
  const summarizeGroups = groups=>Object.fromEntries(Object.entries(groups).map(([key,values])=>[key,summarize(values)]));
  return {enabled:true,...summarize(items),source:'current-exact-scenario',
    by_location:summarizeGroups(byLocation),by_duration:summarizeGroups(byDuration),
    by_location_duration:Object.fromEntries(Object.entries(byLocationDuration).map(([key,value])=>[key,summarizeGroups(value)])),
    observations:items};
}

module.exports = { buildCurrentMarkupEvidence, currentLearningObservations, hasMarkupConflict, keyOf };
