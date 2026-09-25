const assert = require('node:assert/strict');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { pricing } = require('../pricing-rules.config.example.json');
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
