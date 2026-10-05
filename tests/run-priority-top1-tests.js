const assert = require('node:assert/strict');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { pricing } = require('../pricing-rules.config.example.json');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPricingRules } = require('../src/pricingRules');
const registry = require('../locations.config.json');
const frozenMarkup = require('../input/broker-markup-frozen.json').brokerMarkupCalibration;
for (const date of ['2026-09-23', '2026-09-24', '2026-10-25', '2026-10-26']) {
  for (const location of ['Krakow Airport (KRK)', 'Krakow Train Station', 'Warsaw Chopin Airport (WAW)', 'Torun Downtown', 'Gdansk Downtown']) {
    for (const days of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const offer = (provider_name, rate) => ({provider_name, total_price: rate * days, rental_days: days, currency: 'PLN'});
      const automatic = {top_3: [offer('Competitor', 60), offer('MM Cars Rental', 100)], mm_cars_rental: offer('MM Cars Rental', 100)};
      const scenario = {start_date: date, rental_days: days, top_3_plus_mm_by_location: {[location]: automatic}, offer_views_by_location: {[location]: {automatic}}};
      const options = {...pricing, brokerMarkupCalibration: {enabled: false}};
      const result = buildPricingRecommendations({locations: [location], scenarios: [scenario]}, options).decisions[0];
      const active = date >= '2026-09-24' && date <= '2026-10-25' && days >= 2 && days <= 7;
      assert.equal(result.action, active ? 'decrease' : 'hold');
      if (active) {
        assert.equal(result.suggested_rate_pln_day, 59);
        assert.equal(result.target_rank, 1);
        scenario.top_3_plus_mm_by_location[location] = {top_3: [offer('Manual competitor', 1)]};
        assert.equal(buildPricingRecommendations({scenarios: [scenario]}, options).decisions[0].suggested_rate_pln_day, 59);
        delete scenario.offer_views_by_location;
        assert.equal(buildPricingRecommendations({scenarios: [scenario]}, options).decisions[0].action, 'hold');
      }
    }
  }
}
console.log('Priority Top1 scope, automatic-only source, boundaries and missing data tests passed.');
for (const [rates, days, multiplier, rank] of [
  [[20, 50, 70], 2, 1, 2], [[20, 25, 70], 2, 1, 3],
  [[20, 25, 29], 2, 1, null], [[35, 50, 70], 2, 1.2, 2],
  [[35, 42, 70], 5, 1, 2], [[35, 40, 41], 7, 1, null],
  [[32, 50, 70], 2, 1, 1]
]) {
  const location = 'Torun Downtown';
  const offer = (provider_name, rate) => ({provider_name, total_price: rate * days, rental_days: days, currency: 'PLN'});
  const automatic = {top_3: rates.map((rate, i) => offer(`Competitor ${i}`, rate)), mm_cars_rental: offer('MM Cars Rental', 120)};
  const scenario = {start_date: '2026-10-01', rental_days: days, offer_views_by_location: {[location]: {automatic}}};
  const result = buildPricingRecommendations({locations: [location], scenarios: [scenario]}, {...pricing, brokerMarkupCalibration: {enabled: true, defaultMultiplier: multiplier}}).decisions[0];
  assert.equal(result.action, rank == null ? 'hold' : 'decrease');
  if (rank != null) {
    assert.equal(result.target_rank, rank);
    assert.ok(result.suggested_rate_pln_day >= (days <= 4 ? 31 : 41));
  } else assert.equal(result.data_quality_status, 'floor_blocks_top3');
}
console.log('Floor-aware Top2/Top3 fallback, markup and no-feasible-target tests passed.');

const mandatoryZoneFloorsPlnDay = {
  SZLO: [
    { minDays: 1, maxDays: 1, minimumRatePlnDay: 300 },
    { minDays: 2, maxDays: 2, minimumRatePlnDay: 150 },
    { minDays: 3, maxDays: 4, minimumRatePlnDay: 130 },
    { minDays: 5, maxDays: 7, minimumRatePlnDay: 110 },
    { minDays: 8, maxDays: 20, minimumRatePlnDay: 90 },
    { minDays: 21, maxDays: 35, minimumRatePlnDay: 90 }
  ]
};
const airport = registry.locations.find((entry) => entry.zones.includes('SZLO')).scraper_label;
const mandatoryOptions = {
  ...pricing, mandatoryZoneFloorsPlnDay,
  brokerMarkupCalibration: { enabled: false }
};

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack);
    process.exitCode = 1;
  }
}

function payloadFor({ location = airport, days = 2, date = '2026-10-01', rates = [60, 80, 100], mmRate = 250, mmRank, ...fields } = {}) {
  const offer = (provider, rate) => ({ provider_name: provider, total_price: rate * days, rental_days: days, currency: 'PLN' });
  const top3 = rates.map((rate, i) => offer(`Competitor ${i + 1}`, rate));
  const mm = offer('MM Cars Rental', mmRate);
  if (mmRank) top3.splice(mmRank - 1, 0, mm);
  const automatic = { top_3: top3.slice(0, 3), mm_cars_rental: mm };
  return { locations: [location], scenarios: [{
    ...fields, start_date: date, rental_days: days,
    top_3_plus_mm_by_location: { [location]: automatic },
    offer_views_by_location: { [location]: { automatic } }
  }] };
}

function decision(input, options = mandatoryOptions) {
  return buildPricingRecommendations(payloadFor(input), options).decisions[0];
}

runTest('mandatory bands block below-floor targets permanently without enabling long-duration ranking', () => {
  for (const [days, minimum] of [[1, 300], [2, 150], [3, 130], [4, 130], [5, 110], [7, 110], [8, 90], [20, 90], [21, 90], [35, 90]]) {
    for (const date of ['2026-08-01', '2026-10-01', '2026-12-25', '2027-12-31']) {
      for (const group of ['CFAV', 'PDAH', 'UNLISTED']) {
        const result = decision({ days, date, group, frozen: true, protected: true, rates: [minimum], mmRate: minimum - 10 },
          { ...mandatoryOptions, forceTop1: true });
        assert.equal(result.action, 'hold', `${date}/${days}/${group}`);
        assert.equal(result.mandatory_minimum_rate_pln_day, minimum);
        assert.equal(result.suggested_rate_pln_day, null);
        assert.equal(result.maximum_import_rate_pln_day, null);
        assert.equal(result.site_cap_rate_pln_day, null);
        assert.equal(result.target_rank, undefined);
        if (days > 20) assert.equal(result.data_quality_status, 'duration_excluded');
      }
    }
  }
});

runTest('mandatory generic targets at the floor remain feasible and existing higher rates are not normalized down', () => {
  for (const [days, minimum] of [[1, 300], [2, 150], [4, 130], [7, 110], [8, 90], [20, 90]]) {
    const options = { ...mandatoryOptions, priorityTop1Rules: [], forceTop1: true };
    const result = decision({ days, rates: [minimum + 1], mmRate: minimum + 50 }, options);
    assert.equal(result.target_rank, 1);
    assert.equal(result.suggested_rate_pln_day, minimum);
    assert.equal(result.predicted_site_rate_pln_day, minimum);
  }
  const result = decision({ date: '2027-01-01', rates: [300], mmRate: 250, mmRank: 1 });
  assert.equal(result.action, 'increase');
  assert.equal(result.suggested_rate_pln_day, 299);
});

runTest('mandatory floor resolves registry-renamed labels and aliases, not airport name guesses', () => {
  const renamed = structuredClone(registry);
  renamed.locations.find((entry) => entry.zones.includes('SZLO')).scraper_label = 'Renamed airport pickup';
  renamed.aliases['Airport alias'] = ['SZLO'];
  renamed.aliases['Mixed airport alias'] = ['SZO1', 'SZLO'];
  renamed.aliases['City-only alias'] = ['SZO1', 'SZ1'];
  const options = { ...mandatoryOptions, locationRegistry: renamed };
  for (const location of ['Renamed airport pickup', 'Airport alias', 'Mixed airport alias']) {
    assert.equal(decision({ location }, options).action, 'hold', location);
  }
  for (const location of [airport, 'City-only alias', 'Unregistered Szczecin Airport']) {
    assert.equal(decision({ location }, options).suggested_rate_pln_day, 59, location);
  }
});

runTest('mandatory priority fallback uses frozen broker amount and reserve before selecting rank', () => {
  const options = { ...mandatoryOptions, brokerMarkupCalibration: frozenMarkup };
  for (const [rates, days, rank, suggested, amount] of [
    [[212, 230, 250], 2, 1, 151, 60],
    [[211, 212, 250], 2, 2, 151, 60],
    [[180, 211, 212], 2, 3, 151, 60],
    [[180, 210, 211], 2, null, null, 60],
    [[175, 176, 200], 3, 2, 131, 44],
    [[152, 153, 200], 7, 2, 111, 41],
    [[211.999, 212, 250], 2, 2, 151, 60]
  ]) {
    const result = decision({ rates, days }, options);
    assert.equal(result.target_rank || null, rank, `${days}/${rates}`);
    assert.equal(result.suggested_rate_pln_day, suggested);
    assert.equal(result.broker_markup_amount_pln_day, amount);
    assert.equal(result.broker_markup_confidence, 'fixed_user_approved');
    assert.equal(result.markup_evidence, undefined);
    if (rank) {
      assert.equal(result.predicted_site_rate_pln_day, suggested + amount);
    } else {
      assert.equal(result.action, 'hold');
      assert.equal(result.data_quality_status, 'floor_blocks_top3');
      assert.equal(result.site_cap_rate_pln_day, null);
      assert.equal(result.maximum_import_rate_pln_day, null);
    }
  }
});

runTest('mandatory priority floor is converted with multiplier before rank selection', () => {
  const result = decision({ rates: [181, 182.2, 250] }, {
    ...mandatoryOptions, brokerMarkupCalibration: { enabled: true, manualOnly: true, defaultMultiplier: 1.2 }
  });
  assert.equal(result.target_rank, 2);
  assert.equal(result.suggested_rate_pln_day, 151);
  assert.equal(result.predicted_site_rate_pln_day, 181.2);
});

runTest('mandatory non-priority generic branches cannot advertise below-floor active targets or hold caps', () => {
  const options = { ...mandatoryOptions, priorityTop1Rules: [] };
  for (const input of [
    { rates: [110], mmRate: 90, mmRank: 1 },
    { rates: [149], mmRate: 155, mmRank: 2 },
    { rates: [100, 149], mmRate: 155, mmRank: 3 },
    { rates: [100, 120, 149], mmRate: 155 },
    { rates: [100], mmRate: 95, mmRank: 1 }
  ]) {
    const result = decision(input, options);
    assert.equal(result.action, 'hold');
    assert.equal(result.data_quality_status, 'mandatory_floor_blocks_target');
    assert.equal(result.suggested_rate_pln_day, null);
    assert.equal(result.site_cap_rate_pln_day, null);
    assert.equal(result.maximum_import_rate_pln_day, null);
    assert.equal(result.target_rank, undefined);
  }
  const converted = decision({ date: '2027-01-01', rates: [210], mmRate: 220 }, {
    ...options, forceTop1: true, brokerMarkupCalibration: frozenMarkup
  });
  assert.equal(converted.action, 'hold');
  assert.equal(converted.suggested_rate_pln_day, null);
  assert.equal(converted.maximum_import_rate_pln_day, null);
});

runTest('mandatory hold does not invent a feasible target when benchmark is missing', () => {
  const result = decision({ rates: [], mmRate: 80 }, { ...mandatoryOptions, priorityTop1Rules: [], forceTop1: true });
  assert.equal(result.action, 'hold');
  assert.equal(result.data_quality_status, 'missing_top1');
  assert.equal(result.site_cap_rate_pln_day, null);
  assert.equal(result.maximum_import_rate_pln_day, null);
});

runTest('mandatory floors do not change SZO1, SZ1 or other locations', () => {
  for (const location of registry.locations.filter((entry) => !entry.zones.includes('SZLO')).map((entry) => entry.scraper_label)) {
    for (const date of ['2026-10-01', '2027-01-01']) {
      const input = { location, date, rates: [150], mmRate: 155, mmRank: 2 };
      const without = { ...mandatoryOptions, mandatoryZoneFloorsPlnDay: {} };
      assert.deepEqual(decision(input), decision(input, without), location);
    }
  }
});

runTest('mandatory guard preserves existing generic conversion behavior outside configured zones', () => {
  for (const location of ['SZO1', 'SZ1', 'Warsaw Chopin Airport (WAW)']) {
    const result = decision({ location, date: '2027-01-01', rates: [10], mmRate: 100 }, {
      ...mandatoryOptions, forceTop1: true, brokerMarkupCalibration: frozenMarkup
    });
    assert.equal(result.action, 'decrease');
    assert.equal(result.target_rank, 1);
    assert.equal(result.suggested_rate_pln_day, location.startsWith('SZ') ? -51 : -20);
  }
});

runTest('mandatory floor configuration is read and validated at both file and recommendation boundaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandatory-floor-'));
  const configPath = path.join(dir, 'pricing.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify({ pricing: { mandatoryZoneFloorsPlnDay } }));
    assert.deepEqual(loadPricingRules(configPath).mandatoryZoneFloorsPlnDay, mandatoryZoneFloorsPlnDay);
    for (const invalid of [
      null, [], { SZLO: [] }, { SZLO: {} },
      { szlo: mandatoryZoneFloorsPlnDay.SZLO },
      { ' SZLO ': mandatoryZoneFloorsPlnDay.SZLO },
      { SZLO: [{ minDays: 0, maxDays: 2, minimumRatePlnDay: 150 }] },
      { SZLO: [{ minDays: 3, maxDays: 2, minimumRatePlnDay: 150 }] },
      { SZLO: [{ minDays: 1.5, maxDays: 2, minimumRatePlnDay: 150 }] },
      { SZLO: [{ minDays: 1, maxDays: 35, minimumRatePlnDay: '150' }] },
      { SZLO: [{ minDays: 1, maxDays: 35, minimumRatePlnDay: 0 }] },
      { SZLO: [{ minDays: 1, maxDays: 35, minimumRatePlnDay: -1 }] },
      { SZLO: [{ minDays: 1, maxDays: 35, minimumRatePlnDay: true }] },
      { SZLO: [{ minDays: 1, maxDays: 35, minimumRatePlnDay: null }] },
      { SZLO: [{ minDays: 1, maxDays: 35 }] },
      { SZLO: [{ minDays: 1, maxDays: 2, minimumRatePlnDay: 300 }, { minDays: 2, maxDays: 35, minimumRatePlnDay: 150 }] }
    ]) {
      fs.writeFileSync(configPath, JSON.stringify({ pricing: { mandatoryZoneFloorsPlnDay: invalid } }));
      assert.throws(() => loadPricingRules(configPath), /mandatoryZoneFloorsPlnDay/);
      assert.throws(() => decision({}, { ...mandatoryOptions, mandatoryZoneFloorsPlnDay: invalid }), /mandatoryZoneFloorsPlnDay/);
    }
  } finally {
    fs.unlinkSync(configPath);
    fs.rmdirSync(dir);
  }
});

for (const [name, bands] of [
  ['day 36', [{ minDays: 1, maxDays: 36, minimumRatePlnDay: 90 }]],
  ['missing day 35', [{ minDays: 1, maxDays: 34, minimumRatePlnDay: 90 }]],
  ['missing day 1', [{ minDays: 2, maxDays: 35, minimumRatePlnDay: 90 }]],
  ['missing day 4', [{ minDays: 1, maxDays: 3, minimumRatePlnDay: 130 }, { minDays: 5, maxDays: 35, minimumRatePlnDay: 90 }]],
  ['unsafe integer', [{ minDays: 1, maxDays: Number.MAX_SAFE_INTEGER + 1, minimumRatePlnDay: 90 }]]
]) {
  runTest(`mandatory permanent table rejects ${name} at file and recommendation boundaries`, () => {
    const floors = { SZLO: bands };
    assert.throws(() => decision({}, { ...mandatoryOptions, mandatoryZoneFloorsPlnDay: floors }), /mandatoryZoneFloorsPlnDay/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandatory-coverage-'));
    const configPath = path.join(dir, 'pricing.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify({ pricing: { mandatoryZoneFloorsPlnDay: floors } }));
      assert.throws(() => loadPricingRules(configPath), /mandatoryZoneFloorsPlnDay/);
    } finally {
      fs.unlinkSync(configPath);
      fs.rmdirSync(dir);
    }
  });
}

runTest('mandatory complete table is independent of band ordering', () => {
  assert.doesNotThrow(() => decision({}, {
    ...mandatoryOptions, mandatoryZoneFloorsPlnDay: { SZLO: [...mandatoryZoneFloorsPlnDay.SZLO].reverse() }
  }));
});

runTest('actual shared pricing config supplies the approved mandatory SZLO table', () => {
  const loaded = loadPricingRules(path.join(__dirname, '..', 'pricing-rules.config.example.json'));
  assert.deepEqual(loaded.mandatoryZoneFloorsPlnDay, mandatoryZoneFloorsPlnDay);
  const result = decision({ rates: [211, 212, 250] }, { ...loaded, brokerMarkupCalibration: frozenMarkup });
  assert.equal(result.target_rank, 2);
  assert.equal(result.suggested_rate_pln_day, 151);
});
