const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { verifyActiveRecommendations, isSourceVerified } = require('../src/verifyActiveRecommendationsDom');
const { splitActiveRecommendations, mergeVerifiedRecommendationShards } = require('../src/recommendationDomShards');
const { DiscoverCarsScraper } = require('../src/discovercars/scraper');
const { pricing, excelPolicy } = require('./pricing_test_fixtures');
const registry = require('../locations.config.json');

const location = 'Gdansk Airport (GDN)';
const options = { ...pricing, bestAvailableRank: true, priorityTop1Rules: [],
  recommendedFallbackToMinimum: true, excelPolicy, locationRegistry: registry,
  locationTypeFloorsPlnDay: { ...pricing.locationTypeFloorsPlnDay, minimumRatesByKind: { airport: 30, city: 70 } },
  brokerMarkupCalibration: { enabled: true, manualOnly: true, model: 'fixed_amount',
    locationDurationAmounts: { [location]: { '2-2': 15, '3-4': 15, '5-7': 15, '8-20': 15 } } } };
function scenario(date, days = 3, competitor = 40) {
  const offer = (provider_name, rate) => ({ provider_name, total_price: rate * days,
    rental_days: days, currency: 'PLN', transmission: 'automatic' });
  const view = { top_3: [offer('Budget', competitor), offer('Avis', 110), offer('Hertz', 120)],
    mm_cars_rental: offer('MM Cars Rental', 150) };
  return { scenario_id: `${date}/${days}`, start_date: date, pickup_date: date, rental_days: days,
    top_3_plus_mm_by_location: { [location]: view },
    source_validation_by_location: { [location]: { status: 'api_unverified', reasons: [] } } };
}
function build(scenarios, extra = {}) {
  return buildPricingRecommendations({ generated_at: new Date().toISOString(), locations: [location], scenarios },
    { ...options, ...extra });
}
function domOutput(days, rate, popular = 'Budget', goal = 'price_top1') {
  return { results: [['Budget', rate], ['MM Cars Rental', 150]].map(([provider, daily]) => ({
    provider, location, totalPrice: daily * days, currency: 'PLN', transmission: 'automatic', source: 'dom' })),
  domEvidenceByLocation: { [location]: { automatic_filter_confirmed: true, price_sort_confirmed: true,
    ranking_complete: true, ranking_goal: goal } },
  recommendedRankingByLocation: { [location]: { status: 'confirmed', sort: 'Recommended',
    transmission: 'automatic', observed_at: new Date().toISOString(), top_offer: {
      provider_name: popular, total_price: 100, currency: 'PLN', transmission: 'automatic' } } } };
}

test('Recommended covers first 20 calendar dates, not 20 scenarios or execution order', () => {
  const input = build([scenario('2026-11-22'), scenario('2026-11-21'), scenario('2026-11-02')]);
  const [far, boundary, first] = input.decisions;
  assert.equal(far.action, 'hold');
  assert.equal(far.data_quality_status, 'popularity_outside_window');
  assert.equal(far.requires_popularity_verification, undefined);
  assert.equal(boundary.requires_popularity_verification, true);
  assert.equal(first.requires_popularity_verification, true);
  assert.equal(input.options.recommendedWindowStartDate, '2026-11-02');
  assert.equal(build([scenario('2026-11-22')], input.options).decisions[0].action, 'hold');
});

test('requested dates anchor the window even when the earliest collection is missing', () => {
  const input = buildPricingRecommendations({ start_dates: ['2026-10-25', '2026-11-14'],
    scenarios: [scenario('2026-11-13'), scenario('2026-11-14')] }, options);
  assert.equal(input.options.recommendedWindowStartDate, '2026-10-25');
  assert.equal(input.decisions[0].requires_popularity_verification, true);
  assert.equal(input.decisions[1].data_quality_status, 'popularity_outside_window');
  const newYear = build([scenario('2027-01-08'), scenario('2027-01-09')],
    { recommendedWindowStartDate: '2026-12-20', excelPolicy: { ...excelPolicy, protected_rate_periods: [] } });
  assert.equal(newYear.decisions[0].requires_popularity_verification, true);
  assert.equal(newYear.decisions[1].data_quality_status, 'popularity_outside_window');
});

test('all durations 2-14 remain collected and eligible; far price Top1 and protections remain', () => {
  const scenarios = Array.from({ length: 13 }, (_, index) => scenario('2026-11-02', index + 2));
  const input = build([...scenarios, scenario('2026-11-22', 3, 100), scenario('2026-12-15', 3, 100)]);
  assert.deepEqual(input.decisions.slice(0, 13).map(item => item.rental_days), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.ok(input.decisions.slice(0, 13).every(item => item.requires_popularity_verification));
  assert.equal(input.decisions[13].target_rank, 1);
  assert.equal(input.decisions[13].suggested_rate_pln_day, 84);
  assert.equal(input.decisions[14].action, 'hold');
  assert.equal(input.decisions[14].data_quality_status, 'protected_date');
  for (const group of excelPolicy.excluded_groups) {
    assert.equal(build([{ ...scenario('2026-11-02', 3, 100), group }]).decisions[0].action, 'hold');
  }
});

test('a 45-day scope retains 13 durations but limits pending Popular checks to the first 20 days', () => {
  const scenarios = [];
  for (let offset = 0; offset < 45; offset++) {
    const date = new Date(Date.UTC(2027, 1, 1 + offset)).toISOString().slice(0, 10);
    for (let days = 2; days <= 14; days++) scenarios.push(scenario(date, days));
  }
  const input = build(scenarios.reverse());
  assert.equal(input.decisions.length, 585);
  assert.equal(input.decisions.filter(item => item.requires_popularity_verification).length, 260);
  assert.equal(input.decisions.filter(item => item.data_quality_status === 'popularity_outside_window').length, 325);
  assert.ok(input.decisions.filter(item => item.action === 'hold').every(item => item.suggested_rate_pln_day === null));
});

test('far live repricing cannot restart the Recommended window inside a shard', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recommended-window-'));
  const original = DiscoverCarsScraper.prototype.run;
  let calls = 0;
  try {
    const input = build([scenario('2026-11-02', 3, 100), scenario('2026-11-22', 3, 100)]);
    const shards = splitActiveRecommendations(input, 2);
    DiscoverCarsScraper.prototype.run = async function () {
      calls++;
      assert.equal(this.config.domRankingGoal, 'price_top1');
      assert.deepEqual(this.config.requiredDomProvidersByLocation[location], []);
      const output = domOutput(3, 40);
      assert.equal(this.config.recommendedRankingNeeded(location, output.results), this.config.pickupDate === '2026-11-02');
      return output;
    };
    const verified = [];
    for (const [index, shard] of shards.entries()) {
      verified.push(await verifyActiveRecommendations(shard, { concurrency: 1, workDir: path.join(directory, String(index)) }));
    }
    const merged = mergeVerifiedRecommendationShards(input, verified, { shardCount: 2 });
    assert.equal(calls, 2);
    assert.equal(merged.decisions[0].suggested_rate_pln_day, 31);
    assert.equal(merged.decisions[0].dom_verification_status, 'confirmed');
    assert.equal(merged.decisions[1].action, 'hold');
    assert.equal(merged.decisions[1].data_quality_status, 'popularity_outside_window');
  } finally {
    DiscoverCarsScraper.prototype.run = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('two providers authorize Top1 only with explicit complete price-Top1 evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'top1-verifier-'));
  const original = DiscoverCarsScraper.prototype.run;
  try {
    const input = build([scenario('2026-11-02', 3, 100)]);
    for (const goal of ['price_top1', undefined, 'top3']) {
      DiscoverCarsScraper.prototype.run = async () => {
        const output = domOutput(3, 100);
        output.domEvidenceByLocation[location].ranking_goal = goal;
        return output;
      };
      const result = await verifyActiveRecommendations(input, { concurrency: 1,
        workDir: path.join(directory, String(goal)) });
      const item = result.decisions[0];
      if (goal === 'price_top1') {
        assert.equal(item.suggested_rate_pln_day, 84);
        assert.equal(item.target_rank, 1);
        assert.equal(isSourceVerified(item, result.source_generated_at, Date.now(), result.options), true);
        const tampered = structuredClone(item);
        tampered.dom_repricing.evidence.price_sort_confirmed = false;
        assert.equal(isSourceVerified(tampered, result.source_generated_at, Date.now(), result.options), false);
      } else {
        assert.equal(item.action, 'hold');
        assert.equal(item.dom_verification_status, 'dom_recommendation_failed');
      }
    }
  } finally {
    DiscoverCarsScraper.prototype.run = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
