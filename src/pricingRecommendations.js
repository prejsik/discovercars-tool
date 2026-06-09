const fs = require("fs");
const path = require("path");

const DEFAULT_OPTIONS = {
  top1GapThresholdPlnDay: 10,
  top1RaiseBufferPlnDay: 2,
  undercutBufferPlnDay: 1,
  minChangePlnDay: 0.5,
  roundingIncrementPlnDay: 1,
  includeNoop: false
};

function normalizeProviderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function isMmCarsProvider(value) {
  return normalizeProviderName(value).includes("mm cars rental");
}

function normalizeScenarios(payload) {
  if (Array.isArray(payload?.scenarios) && payload.scenarios.length) {
    return payload.scenarios;
  }
  return payload ? [payload] : [];
}

function toDailyRate(offer) {
  const totalPrice = Number(offer?.total_price);
  if (!Number.isFinite(totalPrice)) {
    return null;
  }

  const rentalDays = Number(offer?.rental_days);
  const divisor = Number.isFinite(rentalDays) && rentalDays > 0 ? rentalDays : 1;
  return totalPrice / divisor;
}

function roundRate(value, options) {
  const increment = Number(options.roundingIncrementPlnDay);
  if (!Number.isFinite(increment) || increment <= 0) {
    return Number(value.toFixed(2));
  }

  return Number((Math.floor(value / increment) * increment).toFixed(2));
}

function formatProviderName(offer) {
  return String(offer?.provider_name || "").trim();
}

function getScenarioLocationData(scenario, location) {
  return scenario?.top_3_plus_mm_by_location?.[location] || null;
}

function listScenarioLocations(rootPayload, scenario) {
  const rootLocations = Array.isArray(rootPayload?.locations) ? rootPayload.locations : [];
  if (rootLocations.length) {
    return rootLocations;
  }

  return Object.keys(scenario?.top_3_plus_mm_by_location || {}).sort((a, b) => a.localeCompare(b));
}

function buildNoopRecommendation(base, reason) {
  return {
    ...base,
    action: "hold",
    reason,
    suggested_rate_pln_day: null,
    change_pln_day: 0
  };
}

function buildRecommendationForLocation({ rootPayload, scenario, location, options }) {
  const locationData = getScenarioLocationData(scenario, location);
  const topOffers = Array.isArray(locationData?.top_3) ? locationData.top_3.filter(Boolean) : [];
  const mmOffer = locationData?.mm_cars_rental || topOffers.find((offer) => isMmCarsProvider(offer?.provider_name)) || null;
  const top1 = topOffers[0] || null;
  const top2 = topOffers[1] || null;
  const mmRankIndex = topOffers.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  const mmRank = mmRankIndex >= 0 ? mmRankIndex + 1 : mmOffer ? "outside_top3" : null;
  const mmRate = toDailyRate(mmOffer);
  const top1Rate = toDailyRate(top1);
  const top2Rate = toDailyRate(top2);

  const base = {
    scenario_id: scenario.scenario_id || null,
    location,
    start_date: scenario.start_date || null,
    pickup_date: scenario.pickup_date || null,
    dropoff_date: scenario.dropoff_date || null,
    rental_days: Number(scenario.rental_days) || null,
    currency: mmOffer?.currency || top1?.currency || "PLN",
    mm_rank: mmRank,
    mm_provider: formatProviderName(mmOffer),
    mm_rate_pln_day: mmRate == null ? null : Number(mmRate.toFixed(2)),
    top1_provider: formatProviderName(top1),
    top1_rate_pln_day: top1Rate == null ? null : Number(top1Rate.toFixed(2)),
    top2_provider: formatProviderName(top2),
    top2_rate_pln_day: top2Rate == null ? null : Number(top2Rate.toFixed(2)),
    source_generated_at: rootPayload.generated_at || null
  };

  if (!mmOffer || mmRate == null) {
    return buildNoopRecommendation(base, "MM Cars Rental not found for this scenario/location.");
  }

  if (!top1 || top1Rate == null) {
    return buildNoopRecommendation(base, "Top1 competitor is not available.");
  }

  if (mmRank === 1) {
    if (!top2 || top2Rate == null) {
      return buildNoopRecommendation(base, "MM Cars Rental is top1, but top2 is not available.");
    }

    const gap = top2Rate - mmRate;
    if (gap < options.top1GapThresholdPlnDay) {
      return buildNoopRecommendation(
        base,
        `MM Cars Rental is top1, but the top2 gap is below ${options.top1GapThresholdPlnDay} PLN/day.`
      );
    }

    const target = roundRate(top2Rate - options.top1RaiseBufferPlnDay, options);
    const change = target - mmRate;
    if (change < options.minChangePlnDay) {
      return buildNoopRecommendation(base, "Calculated increase is below the minimum change threshold.");
    }

    return {
      ...base,
      action: "increase",
      reason: `MM Cars Rental is top1 and top2 is at least ${options.top1GapThresholdPlnDay} PLN/day higher.`,
      benchmark_provider: formatProviderName(top2),
      benchmark_rate_pln_day: Number(top2Rate.toFixed(2)),
      suggested_rate_pln_day: target,
      change_pln_day: Number(change.toFixed(2))
    };
  }

  const target = roundRate(top1Rate - options.undercutBufferPlnDay, options);
  const change = target - mmRate;
  if (Math.abs(change) < options.minChangePlnDay) {
    return buildNoopRecommendation(base, "MM Cars Rental is close enough to the target top1 undercut price.");
  }

  return {
    ...base,
    action: change < 0 ? "decrease" : "increase",
    reason: `MM Cars Rental is not top1; target is top1 minus ${options.undercutBufferPlnDay} PLN/day.`,
    benchmark_provider: formatProviderName(top1),
    benchmark_rate_pln_day: Number(top1Rate.toFixed(2)),
    suggested_rate_pln_day: target,
    change_pln_day: Number(change.toFixed(2))
  };
}

function buildPricingRecommendations(payload, rawOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...(rawOptions || {}) };
  const scenarios = normalizeScenarios(payload);
  const recommendations = [];
  const skipped = [];

  for (const scenario of scenarios) {
    for (const location of listScenarioLocations(payload, scenario)) {
      const recommendation = buildRecommendationForLocation({
        rootPayload: payload,
        scenario,
        location,
        options
      });

      if (recommendation.action === "hold") {
        skipped.push(recommendation);
        if (options.includeNoop) {
          recommendations.push(recommendation);
        }
        continue;
      }

      recommendations.push(recommendation);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    source_generated_at: payload?.generated_at || null,
    options,
    recommendation_count: recommendations.filter((item) => item.action !== "hold").length,
    skipped_count: skipped.length,
    recommendations
  };
}

function parseArgs(argv) {
  const args = {
    inputPath: null,
    outputPath: null,
    configPath: null,
    includeNoop: false
  };

  for (const arg of argv) {
    if (arg === "--include-noop") {
      args.includeNoop = true;
      continue;
    }
    if (arg.startsWith("--config=")) {
      args.configPath = arg.slice("--config=".length);
      continue;
    }
    if (!args.inputPath) {
      args.inputPath = arg;
      continue;
    }
    if (!args.outputPath) {
      args.outputPath = arg;
    }
  }

  return args;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (!args.inputPath || !args.outputPath) {
    process.stderr.write(
      "Usage: node src/pricingRecommendations.js output/results-latest.json output/pricing-recommendations.json [--config=pricing-rules.json] [--include-noop]\n"
    );
    process.exitCode = 1;
    return;
  }

  const payload = loadJson(args.inputPath);
  const config = args.configPath ? loadJson(args.configPath) : {};
  const output = buildPricingRecommendations(payload, {
    ...(config.pricing || config),
    includeNoop: args.includeNoop || Boolean(config.includeNoop)
  });
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`Pricing recommendations saved to ${outputPath}\n`);
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  buildPricingRecommendations,
  isMmCarsProvider,
  toDailyRate
};
