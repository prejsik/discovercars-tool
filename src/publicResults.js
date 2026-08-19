const fs = require("fs");
const path = require("path");

function compactOffer(offer, fallbackRentalDays = null) {
  if (!offer || typeof offer !== "object") {
    return null;
  }

  const totalPrice = Number(offer.total_price);
  const providerRating = Number(offer.provider_rating);
  const rentalDays = Number(offer.rental_days ?? fallbackRentalDays);
  const compact = {
    provider_name: String(offer.provider_name || "").trim(),
    total_price: Number.isFinite(totalPrice) ? totalPrice : null,
    currency: String(offer.currency || "").trim(),
    rental_days: Number.isFinite(rentalDays) && rentalDays > 0 ? rentalDays : null
  };

  if (Number.isFinite(providerRating) && providerRating > 0) {
    compact.provider_rating = providerRating;
  }

  return compact;
}

function compactView(view, rentalDays) {
  const top3 = Array.isArray(view?.top_3)
    ? view.top_3
    : Array.isArray(view?.top_3_offers)
      ? view.top_3_offers
      : [];
  const mmOffer = view?.mm_cars_rental || view?.mm_cars_rental_offer || null;
  const rank = Number(view?.mm_provider_rank);
  const cheaperOfferCount = Number(view?.cheaper_offer_count);

  return {
    top_3: [0, 1, 2].map((index) => compactOffer(top3[index], rentalDays)),
    mm_cars_rental: compactOffer(mmOffer, rentalDays),
    mm_provider_rank: Number.isFinite(rank) && rank > 0 ? rank : null,
    cheaper_offer_count: Number.isFinite(cheaperOfferCount) && cheaperOfferCount >= 0
      ? cheaperOfferCount
      : null
  };
}

function scenarioLocations(rootLocations, scenario) {
  if (Array.isArray(rootLocations) && rootLocations.length) {
    return rootLocations;
  }

  return [...new Set([
    ...Object.keys(scenario?.offer_views_by_location || {}),
    ...Object.keys(scenario?.top_3_plus_mm_by_location || {})
  ])].sort((left, right) => left.localeCompare(right));
}

function compactScenario(scenario, rootLocations) {
  const rentalDays = Number(scenario?.rental_days);
  const locations = scenarioLocations(rootLocations, scenario);
  const offerViews = {};

  for (const location of locations) {
    const views = scenario?.offer_views_by_location?.[location] || null;
    const legacy = scenario?.top_3_plus_mm_by_location?.[location] || {};
    const automaticSource = views?.automatic || legacy;
    const allSource = views?.all || null;
    offerViews[location] = {
      automatic: compactView(automaticSource, rentalDays),
      all: allSource ? compactView(allSource, rentalDays) : null
    };
  }

  return {
    scenario_id: scenario?.scenario_id || null,
    start_date: scenario?.start_date || String(scenario?.pickup_date || "").slice(0, 10),
    pickup_date: scenario?.pickup_date || null,
    dropoff_date: scenario?.dropoff_date || null,
    rental_days: Number.isFinite(rentalDays) ? rentalDays : null,
    errors: Array.isArray(scenario?.errors)
      ? scenario.errors.map((error) => ({
        location: error?.location || null,
        error: error?.error || error?.message || String(error || "")
      }))
      : [],
    offer_views_by_location: offerViews
  };
}

function normalizeScenarios(payload) {
  return Array.isArray(payload?.scenarios) ? payload.scenarios : [payload || {}];
}

function buildPublicResultsPayload(payload) {
  const rootLocations = Array.isArray(payload?.locations) ? payload.locations : [];
  const scenarios = normalizeScenarios(payload);
  const locations = rootLocations.length
    ? [...rootLocations]
    : [...new Set(scenarios.flatMap((scenario) => scenarioLocations([], scenario)))].sort((left, right) => left.localeCompare(right));

  return {
    schema_version: 2,
    generated_at: payload?.generated_at || null,
    run_id: payload?.run_id || null,
    time_zone: payload?.time_zone || "Europe/Warsaw",
    locations,
    scenario_mode: payload?.scenario_mode || null,
    start_dates: Array.isArray(payload?.start_dates) ? payload.start_dates : [],
    rolling_days: Number.isFinite(Number(payload?.rolling_days)) ? Number(payload.rolling_days) : null,
    rental_day_options: Array.isArray(payload?.rental_day_options) ? payload.rental_day_options : [],
    scenarios: scenarios.map((scenario) => compactScenario(scenario, locations)),
    errors: Array.isArray(payload?.errors) ? payload.errors : []
  };
}

function writePublicResults(inputPath, outputPath) {
  const source = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(buildPublicResultsPayload(source)), "utf8");
  return targetPath;
}

if (require.main === module) {
  const inputPath = process.argv[2] || "output/results-latest.json";
  const outputPath = process.argv[3] || "output/results-public.json";
  try {
    console.log(writePublicResults(inputPath, outputPath));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildPublicResultsPayload,
  compactOffer,
  compactView,
  writePublicResults
};
