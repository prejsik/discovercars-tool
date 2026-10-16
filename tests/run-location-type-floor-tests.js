const assert = require('node:assert/strict');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { pricing } = require('../pricing-rules.config.example.json');
const { loadPricingRules, resolveLocationTypeFloorPlnDay } = require('../src/pricingRules');
const registry = require('../locations.config.json');
const frozenMarkup = require('../input/broker-markup-frozen.json').brokerMarkupCalibration;

const floors = {
  groups: ['CDMV', 'CGAV', 'CWAV', 'CWMR', 'EDAV', 'EDMV'],
  minDays: 1,
  maxDays: 20,
  minimumRatesByKind: { city: 60, airport: 35 }
};
const options = { ...pricing, locationTypeFloorsPlnDay: floors, brokerMarkupCalibration: { enabled: false } };

function decision({ location, days = 4, date = '2026-10-16', rates = [45, 80, 100], mmRate = 32, ...extra } = {}, settings = options) {
  const offer = (provider, rate) => ({ provider_name: provider, total_price: rate * days, rental_days: days, currency: 'PLN' });
  const automatic = { top_3: rates.map((rate, i) => offer(`Competitor ${i + 1}`, rate)), mm_cars_rental: offer('MM Cars Rental', mmRate) };
  return buildPricingRecommendations({ locations: [location], scenarios: [{
    start_date: date, rental_days: days,
    top_3_plus_mm_by_location: { [location]: automatic },
    offer_views_by_location: { [location]: { automatic } }, ...extra
  }] }, settings).decisions[0];
}

function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; }
}

test('city minimum overrides legacy priority while the same market can be Top1 at an airport', () => {
  const city = decision({ location: 'Wroclaw Downtown' });
  assert.equal(city.mandatory_minimum_rate_pln_day, 60);
  assert.equal(city.target_rank, 2);
  assert.equal(city.suggested_rate_pln_day, 79);
  const airport = decision({ location: 'Wroclaw Airport (WRO)' });
  assert.equal(airport.mandatory_minimum_rate_pln_day, 35);
  assert.equal(airport.target_rank, 1);
  assert.equal(airport.suggested_rate_pln_day, 44);
});

test('new floors replace old 40 PLN priority minimum on airports for 5-7 days', () => {
  const result = decision({ location: 'Wroclaw Airport (WRO)', days: 7, rates: [37, 80, 100] });
  assert.equal(result.target_rank, 1);
  assert.equal(result.suggested_rate_pln_day, 36);
});

test('all registered locations use their actual kind throughout days 1-20 without expiry', () => {
  for (const entry of registry.locations) {
    for (const days of [1, 2, 3, 4, 5, 7, 8, 14, 20]) {
      for (const date of ['2026-10-16', '2026-10-26', '2027-06-01']) {
        const result = decision({ location: entry.scraper_label, days, date, rates: [35], mmRate: 20 }, { ...options, forceTop1: true });
        const expected = entry.zones.includes('SZLO')
          ? days === 1 ? 300 : days === 2 ? 150 : days <= 4 ? 130 : days <= 7 ? 110 : 90
          : entry.kind === 'airport' ? 35 : 60;
        assert.equal(result.mandatory_minimum_rate_pln_day, expected, `${entry.scraper_label}/${days}/${date}`);
        assert.equal(result.action, 'hold');
        assert.equal(result.suggested_rate_pln_day, null);
        assert.equal(result.maximum_import_rate_pln_day, null);
      }
    }
  }
});

test('rank fallback and frozen markup never authorize rates below the new minimum', () => {
  const settings = { ...options, brokerMarkupCalibration: frozenMarkup };
  const result = decision({ location: 'Wroclaw Downtown', rates: [44.35, 58.02, 65.12] }, settings);
  assert.equal(result.action, 'hold');
  assert.equal(result.data_quality_status, 'floor_blocks_top3');
  assert.equal(result.maximum_import_rate_pln_day, null);
  const fallback = decision({ location: 'Wroclaw Downtown', rates: [44.35, 80, 100] }, settings);
  assert.equal(fallback.target_rank, 2);
  assert.ok(fallback.suggested_rate_pln_day - 1 >= 60);
  assert.equal(fallback.broker_markup_amount_pln_day, 10);
});

test('registry kinds govern renamed locations and aliases, not words in the label', () => {
  const renamed = structuredClone(registry);
  renamed.locations.find(entry => entry.zones.includes('WR1')).scraper_label = 'Airport-looking city';
  renamed.locations.find(entry => entry.zones.includes('WRLO')).scraper_label = 'Downtown-looking airport';
  renamed.aliases['Airport mirror'] = ['KRTI'];
  renamed.aliases['Mixed alias'] = ['WR1', 'WRLO'];
  const settings = { ...options, locationRegistry: renamed };
  for (const [location, minimum] of [['Airport-looking city', 60], ['Downtown-looking airport', 35], ['Airport mirror', 35], ['Mixed alias', 60]]) {
    assert.equal(decision({ location }, settings).mandatory_minimum_rate_pln_day, minimum);
  }
});

test('new floors cover only the six approved classes and days 1-20', () => {
  assert.equal(typeof resolveLocationTypeFloorPlnDay, 'function');
  for (const kind of ['city', 'airport']) {
    for (const group of floors.groups) {
      for (const days of [1, 2, 4, 7, 8, 20]) {
        assert.equal(resolveLocationTypeFloorPlnDay(kind, days, options, group), kind === 'city' ? 60 : 35);
      }
      for (const days of [0, 21, 35]) assert.equal(resolveLocationTypeFloorPlnDay(kind, days, options, group), 0);
    }
    for (const group of ['CFAV', 'PDAH', 'PDAV', 'FVMD', 'SWAV', 'UNKNOWN']) {
      assert.equal(resolveLocationTypeFloorPlnDay(kind, 4, options, group), 0);
    }
  }
  assert.equal(resolveLocationTypeFloorPlnDay('unknown', 4, options), 0);
  assert.equal(decision({ location: 'Wroclaw Downtown', days: 21 }).data_quality_status, 'duration_excluded');
});

test('both production entrypoints load the shared permanent floor policy', () => {
  assert.deepEqual(loadPricingRules().locationTypeFloorsPlnDay, {
    ...floors, minimumRatesByKind: { city: 60, airport: 30 }
  });
});

test('retired permanent minima are absent while dated minima remain unchanged', () => {
  const excel = require('../excel-rate-update.config.example.json');
  assert.deepEqual(excel.minimum_rates.scoped_overrides, []);
  assert.deepEqual(excel.minimum_rates.zone_overrides_pln_day, {});
  assert.deepEqual(excel.minimum_rates.bands, [
    { start_date: '2026-07-01', end_date: '2026-08-30', min_days: 1, max_days: 7, min_pln_day: 70 },
    { start_date: '2026-07-01', end_date: '2026-08-30', min_days: 8, max_days: 20, min_pln_day: 115 },
    { start_date: '2026-07-01', end_date: '2026-08-30', min_days: 21, max_days: 35, min_pln_day: 100 },
    { start_date: '2026-09-01', end_date: '2027-01-31', min_days: 1, max_days: 35, min_pln_day: 50 }
  ]);
});

test('invalid minimum policy fails closed', () => {
  for (const bad of [
    {}, { ...floors, groups: [] }, { ...floors, groups: ['cdmv'] },
    { ...floors, minDays: 0 }, { ...floors, maxDays: 36 }, { ...floors, maxDays: 0 },
    { ...floors, minimumRatesByKind: { city: '60', airport: 35 } },
    { ...floors, minimumRatesByKind: { city: 60, airport: 35, other: 50 } },
    { ...floors, minimumRatesByKind: { city: 60, airport: -1 } },
    { ...floors, minimumRatesByKind: { city: 60 } }
  ]) {
    assert.throws(() => decision({ location: 'Wroclaw Downtown' }, { ...options, locationTypeFloorsPlnDay: bad }), /locationTypeFloorsPlnDay/);
  }
});

test('invalid registry kind cannot silently restore a legacy lower floor', () => {
  const invalid = structuredClone(registry);
  invalid.locations.find(entry => entry.zones.includes('WR1')).kind = 'airprot';
  assert.throws(() => decision({ location: 'Wroclaw Downtown' }, { ...options, locationRegistry: invalid }), /kind/);
});
