const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { verifyActiveRecommendations, isSourceVerified } = require('../src/verifyActiveRecommendationsDom');
const { DiscoverCarsScraper } = require('../src/discovercars/scraper');
const { splitActiveRecommendations, mergeVerifiedRecommendationShards } = require('../src/recommendationDomShards');
const production = require('../pricing-rules.config.example.json').pricing;
const { pricing, excelPolicy: excel } = require('./pricing_test_fixtures');
const registry = require('../locations.config.json');

const location = 'Gdansk Airport (GDN)';
const options = { ...pricing, bestAvailableRank: true, priorityTop1Rules: [],
  locationTypeFloorsPlnDay: { ...pricing.locationTypeFloorsPlnDay, minimumRatesByKind: { airport: 30, city: 70 } },
  mandatoryScopedFloorsPlnDay: [{ groups: excel.apply_groups, zones: ['KALO'], minDays: 3, maxDays: 4,
    startDate: '2026-10-23', endDate: '2027-12-23', minimumRatePlnDay: 80, overrideProtected: false }],
  recommendedFallbackToMinimum: true, excelPolicy: excel,
  locationRegistry: registry, brokerMarkupCalibration: { enabled: true, manualOnly: true,
    model: 'fixed_amount', locationDurationAmounts: { [location]: { '3-4': 15 } } } };
function popularity(provider = 'Budget', changes = {}) {
  return { status: 'confirmed', sort: 'Recommended', transmission: 'automatic',
    observed_at: new Date().toISOString(), top_offer: { provider_name: provider,
      total_price: 150, currency: 'PLN', transmission: 'automatic' }, ...changes };
}
function payload({ rates = [40, 80, 100], popular, date = '2026-11-03', group, zone = 'GDLO' } = {}) {
  const point = registry.locations.find(p => p.zones.includes(zone)).scraper_label;
  const offer = (provider_name, price) => ({ provider_name, total_price: price * 3, rental_days: 3,
    currency: 'PLN', transmission: 'automatic' });
  const view = { top_3: rates.map((r, i) => offer(['Budget', 'Avis', 'Hertz'][i], r)),
    mm_cars_rental: offer('MM Cars Rental', 150) };
  return { generated_at: new Date().toISOString(), locations: [point], scenarios: [{ start_date: date,
    rental_days: 3, group, top_3_plus_mm_by_location: { [point]: view },
    offer_views_by_location: { [point]: { automatic: view } },
    recommended_ranking_by_location: { [point]: popular },
    source_validation_by_location: { [point]: { status: 'dom_confirmed', reasons: [] } } }] };
}
function decision(input) { return buildPricingRecommendations(payload(input), input?.zone
  ? { ...options, brokerMarkupCalibration: { enabled: false } } : options).decisions[0]; }

test('price Top1 takes precedence over Recommended and minimum, using frozen markup', () => {
  const item = decision({ rates: [100, 110, 120], popular: popularity('MM Cars Rental') });
  assert.equal(item.target_rank, 1);
  assert.equal(item.suggested_rate_pln_day, 84);
});
test('Recommended Top1 keeps baseline when price Top1 is below the floor', () => {
  const item = decision({ popular: popularity('MM Cars Rental') });
  assert.equal(item.action, 'hold');
  assert.equal(item.data_quality_status, 'popular_top1_preserved');
});
test('neither view Top1 targets floor plus parity reserve, not Top2 or Top3', () => {
  const item = decision({ popular: popularity() });
  assert.equal(item.recommendation_type, 'minimum_fallback');
  assert.equal(item.target_rank, null);
  assert.equal(item.suggested_rate_pln_day, 31);
  assert.equal(item.predicted_site_rate_pln_day, 46);
  assert.equal(item.data_quality_status, 'ok');
});
test('missing popularity is pending verification; failed or invalid observations never authorize a floor change', () => {
  const pending = decision({});
  assert.equal(pending.requires_popularity_verification, true);
  assert.equal(pending.data_quality_status, 'popularity_pending');
  assert.equal(isSourceVerified(pending, new Date().toISOString(), Date.now(), options), false);
  for (const popular of [{ status: 'failed' }, popularity('Budget', { sort: 'Price' }),
    popularity('Budget', { observed_at: '2020-01-01T00:00:00Z' }),
    popularity('Budget', { top_offer: { provider_name: 123, total_price: 50, currency: 'PLN', transmission: 'automatic' } }),
    popularity('Budget', { top_offer: { provider_name: 'Budget', total_price: 50, currency: 'EUR' } })]) {
    const item = decision({ popular });
    assert.equal(item.action, 'hold');
    assert.notEqual(item.data_quality_status, 'ok');
  }
});
test('protection and explicit class exclusions take precedence over the new policy', () => {
  assert.equal(decision({ date: '2026-12-15', popular: popularity() }).action, 'hold');
  for (const group of excel.excluded_groups) assert.equal(decision({ group, popular: popularity() }).action, 'hold');
  assert.equal(decision({ zone: 'KALO', popular: popularity() }).suggested_rate_pln_day, 81);
  assert.equal(decision({ zone: 'GD1', popular: popularity() }).suggested_rate_pln_day, 71);
  assert.equal(decision({ zone: 'SZLO', popular: popularity() }).suggested_rate_pln_day, 131);
});
test('production settings activate the new sequence', () => {
  assert.equal(production.recommendedFallbackToMinimum, true);
});

test('DOM verification collects popularity, rebuilds pending floors, and rejects an unavailable Recommended view', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popular-policy-'));
  const original = DiscoverCarsScraper.prototype.run;
  try {
    for (const popular of [popularity(), popularity('MM Cars Rental'), { status: 'failed' }]) {
      DiscoverCarsScraper.prototype.run = async function () {
        assert.deepEqual(this.config.recommendedRankingLocations, [location]);
        const sample = [['Budget', 40], ['Avis', 80], ['MM Cars Rental', 150]]
          .map(([provider, rate]) => ({ provider, totalPrice: rate * 3, currency: 'PLN', transmission: 'automatic' }));
        assert.equal(this.config.recommendedRankingNeeded(location, sample), true);
        assert.equal(this.config.recommendedRankingNeeded(location, sample.map(o => ({ ...o, totalPrice: o.totalPrice + 300 }))), false);
        return { results: [['Budget', 40], ['Avis', 80], ['Hertz', 100], ['MM Cars Rental', 150]]
          .map(([provider, rate]) => ({ location, provider, totalPrice: rate * 3, currency: 'PLN',
            transmission: 'automatic', source: 'dom' })),
          domEvidenceByLocation: { [location]: { automatic_filter_confirmed: true,
            price_sort_confirmed: true, ranking_complete: true } },
          recommendedRankingByLocation: { [location]: popular } };
      };
      const input = buildPricingRecommendations(payload(), options);
      const shard = splitActiveRecommendations(input, 1)[0];
      const workDir = path.join(directory, String(Math.random()));
      const verified = await verifyActiveRecommendations(shard,
        { workDir, concurrency: 1 });
      const result = mergeVerifiedRecommendationShards(input, [verified], { shardCount: 1 });
      const item = result.decisions[0];
      if (popular.status === 'confirmed' && popular.top_offer.provider_name === 'Budget') {
        assert.equal(item.recommendation_type, 'minimum_fallback');
        assert.equal(item.suggested_rate_pln_day, 31);
        assert.equal(item.dom_verification_status, 'confirmed');
        assert.equal(isSourceVerified(item, result.source_generated_at, Date.now(), result.options), true);
        const tampered = structuredClone(item);
        tampered.dom_repricing.recommended_ranking.top_offer.provider_name = 'MM Cars Rental';
        assert.equal(isSourceVerified(tampered, result.source_generated_at, Date.now(), result.options), false);
        DiscoverCarsScraper.prototype.run = async () => { throw new Error('resume must not scrape again'); };
        const resumed = await verifyActiveRecommendations(shard, { workDir, concurrency: 1 });
        assert.equal(resumed.dom_verification.reused_checkpoint_count, 1);
        assert.equal(resumed.decisions[0].suggested_rate_pln_day, 31);
      } else {
        assert.equal(item.action, 'hold');
        if (popular.status === 'failed') assert.equal(item.dom_verification_status, 'dom_recommendation_failed');
      }
    }
  } finally {
    DiscoverCarsScraper.prototype.run = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('one higher floor in a shared verification group cannot skip Recommended evidence', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'popular-group-'));
  const original = DiscoverCarsScraper.prototype.run;
  let needed;
  try {
    const input = buildPricingRecommendations(payload(), options);
    input.decisions.push({ ...input.decisions[0], mandatory_minimum_rate_pln_day: 200 });
    DiscoverCarsScraper.prototype.run = async function () {
      const offers = [['Budget', 100], ['MM Cars Rental', 150]].map(([provider, rate]) => ({
        location, provider, totalPrice: rate * 3, currency: 'PLN', transmission: 'automatic', source: 'dom' }));
      needed = this.config.recommendedRankingNeeded(location, offers);
      return { results: offers };
    };
    await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    assert.equal(needed, true);
  } finally {
    DiscoverCarsScraper.prototype.run = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
