const DEFAULT_TOP1_HIGH_RATE_THRESHOLD_PLN_DAY = 150;

function toDailyRate(offer) {
  const totalPrice = Number(offer?.total_price);
  if (!Number.isFinite(totalPrice)) {
    return null;
  }
  const rentalDays = Number(offer?.rental_days);
  return totalPrice / (Number.isFinite(rentalDays) && rentalDays > 0 ? rentalDays : 1);
}

function normalizeScenarios(payload) {
  return Array.isArray(payload?.scenarios) && payload.scenarios.length ? payload.scenarios : payload ? [payload] : [];
}

function listScenarioLocations(rootPayload, scenario) {
  const configured = Array.isArray(rootPayload?.locations) ? rootPayload.locations : [];
  return configured.length ? configured : Object.keys(scenario?.top_3_plus_mm_by_location || {});
}

function buildObservationKey(scenario, location) {
  return `${scenario?.scenario_id || scenario?.start_date || scenario?.pickup_date || ""}|${scenario?.rental_days || ""}|${location}`;
}

function buildTop1RateSignalIndex(payload, options = {}) {
  const threshold = Number(options.top1HighRateThresholdPlnDay)
    || DEFAULT_TOP1_HIGH_RATE_THRESHOLD_PLN_DAY;
  const index = new Map();

  for (const scenario of normalizeScenarios(payload)) {
    for (const location of listScenarioLocations(payload, scenario)) {
      const top1 = scenario?.top_3_plus_mm_by_location?.[location]?.top_3?.[0] || null;
      const rate = toDailyRate(top1);
      if (!Number.isFinite(rate)) {
        continue;
      }
      index.set(buildObservationKey(scenario, location), {
        is_high_rate: rate > threshold,
        rate_pln_day: Number(rate.toFixed(2))
      });
    }
  }

  return index;
}

module.exports = {
  DEFAULT_TOP1_HIGH_RATE_THRESHOLD_PLN_DAY,
  buildObservationKey,
  buildTop1RateSignalIndex,
  toDailyRate
};
