const assert = require('node:assert/strict');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { pricing } = require('../pricing-rules.config.example.json');
for (const date of ['2026-09-23', '2026-09-24', '2026-10-25', '2026-10-26']) {
  for (const location of ['Krakow Airport (KRK)', 'Krakow Train Station']) {
    for (const days of [1, 2, 3, 4, 5, 8]) {
      const offer = (provider_name, rate) => ({provider_name, total_price: rate * days, rental_days: days, currency: 'PLN'});
      const automatic = {top_3: [offer('Competitor', 40), offer('MM Cars Rental', 80)], mm_cars_rental: offer('MM Cars Rental', 80)};
      const scenario = {start_date: date, rental_days: days, top_3_plus_mm_by_location: {[location]: automatic}, offer_views_by_location: {[location]: {automatic}}};
      const options = {...pricing, brokerMarkupCalibration: {enabled: false}};
      const result = buildPricingRecommendations({locations: [location], scenarios: [scenario]}, options).decisions[0];
      const active = date >= '2026-09-24' && date <= '2026-10-25' && location === 'Krakow Airport (KRK)' && days >= 2 && days <= 4;
      assert.equal(result.action, active ? 'decrease' : 'hold');
      if (active) {
        assert.equal(result.suggested_rate_pln_day, 39);
        assert.equal(result.target_rank, 1);
        scenario.top_3_plus_mm_by_location[location] = {top_3: [offer('Manual competitor', 1)]};
        assert.equal(buildPricingRecommendations({scenarios: [scenario]}, options).decisions[0].suggested_rate_pln_day, 39);
        delete scenario.offer_views_by_location;
        assert.equal(buildPricingRecommendations({scenarios: [scenario]}, options).decisions[0].action, 'hold');
      }
    }
  }
}
console.log('Priority Top1 scope, automatic-only source, boundaries and missing data tests passed.');
