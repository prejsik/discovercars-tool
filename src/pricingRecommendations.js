const fs = require("fs");
const path = require("path");
const {
  mergeBrokerMarkupCalibration,
  resolveBrokerMarkupCalibration
} = require("./brokerMarkupCalibration");

const DEFAULT_OPTIONS = {
  top1GapThresholdPlnDay: 5,
  top1RaiseBufferPlnDay: 1,
  top1UndercutThresholdPlnDay: 10,
  undercutBufferPlnDay: 1,
  top3SmallDecreaseThresholdPlnDay: 10,
  minChangePlnDay: 0.5,
  roundingIncrementPlnDay: 1,
  brokerMarkupCalibration: {
    enabled: false,
    defaultMultiplier: 1
  },
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

  return Number((Math.floor((value + Number.EPSILON * 100) / increment) * increment).toFixed(2));
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

function buildActiveRecommendation({ base, options, action, recommendationType, targetRank, reason, benchmarkOffer, siteTarget }) {
  const benchmarkRate = toDailyRate(benchmarkOffer);
  const calibration = resolveBrokerMarkupCalibration(base, options.brokerMarkupCalibration);
  const suggestedImportRate = roundRate(siteTarget / calibration.multiplier, options);
  const predictedSiteRate = Number((suggestedImportRate * calibration.multiplier).toFixed(2));
  const siteChange = siteTarget - Number(base.mm_rate_pln_day);

  return {
    ...base,
    action,
    recommendation_type: recommendationType,
    target_rank: targetRank,
    reason,
    benchmark_provider: formatProviderName(benchmarkOffer),
    benchmark_rate_pln_day: benchmarkRate == null ? null : Number(benchmarkRate.toFixed(2)),
    site_target_rate_pln_day: Number(siteTarget.toFixed(2)),
    suggested_rate_pln_day: suggestedImportRate,
    predicted_site_rate_pln_day: predictedSiteRate,
    broker_markup_multiplier: calibration.multiplier,
    broker_markup_percent: calibration.percent,
    broker_markup_source: calibration.source,
    change_pln_day: Number(siteChange.toFixed(2))
  };
}

function buildRecommendationForLocation({ rootPayload, scenario, location, options }) {
  const locationData = getScenarioLocationData(scenario, location);
  const topOffers = Array.isArray(locationData?.top_3) ? locationData.top_3.filter(Boolean) : [];
  const mmOffer = locationData?.mm_cars_rental || topOffers.find((offer) => isMmCarsProvider(offer?.provider_name)) || null;
  const top1 = topOffers[0] || null;
  const top2 = topOffers[1] || null;
  const top3 = topOffers[2] || null;
  const mmRankIndex = topOffers.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  const mmRank = mmRankIndex >= 0 ? mmRankIndex + 1 : mmOffer ? "outside_top3" : null;
  const mmRate = toDailyRate(mmOffer);
  const top1Rate = toDailyRate(top1);
  const top2Rate = toDailyRate(top2);
  const top3Rate = toDailyRate(top3);

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
    top3_provider: formatProviderName(top3),
    top3_rate_pln_day: top3Rate == null ? null : Number(top3Rate.toFixed(2)),
    source_generated_at: rootPayload.generated_at || null
  };

  if (!mmOffer || mmRate == null) {
    return buildNoopRecommendation(base, "Nie znaleziono MM Cars Rental dla tego scenariusza/lokalizacji.");
  }

  if (!top1 || top1Rate == null) {
    return buildNoopRecommendation(base, "Brak dostepnej oferty top1.");
  }

  if (mmRank === 1) {
    if (!top2 || top2Rate == null) {
      return buildNoopRecommendation(base, "MM Cars Rental jest top1, ale oferta top2 nie jest dostepna.");
    }

    const gap = top2Rate - mmRate;
    if (gap < options.top1GapThresholdPlnDay) {
      return buildNoopRecommendation(
        base,
        `MM Cars Rental jest top1, ale roznica do top2 jest mniejsza niz ${options.top1GapThresholdPlnDay} PLN/dzien.`
      );
    }

    const target = roundRate(top2Rate - options.top1RaiseBufferPlnDay, options);
    const change = target - mmRate;
    if (change < options.minChangePlnDay) {
      return buildNoopRecommendation(base, "Wyliczona podwyzka jest ponizej minimalnego progu zmiany.");
    }

    return buildActiveRecommendation({
      base,
      options,
      action: "increase",
      recommendationType: "top1_gap",
      targetRank: 1,
      reason: `MM Cars Rental jest top1, a top2 jest drozszy o co najmniej ${options.top1GapThresholdPlnDay} PLN/dzien; cel to 1 PLN ponizej top2.`,
      benchmarkOffer: top2,
      siteTarget: target
    });
  }

  if (mmRank === 2) {
    const top1Target = roundRate(top1Rate - options.undercutBufferPlnDay, options);
    const top1Change = top1Target - mmRate;
    if (
      top1Change < 0 &&
      Math.abs(top1Change) < options.top1UndercutThresholdPlnDay &&
      Math.abs(top1Change) >= options.minChangePlnDay
    ) {
      return buildActiveRecommendation({
        base,
        options,
        action: "decrease",
        recommendationType: "top1_undercut",
        targetRank: 1,
        reason: `MM Cars Rental jest top2 i brakuje mniej niz ${options.top1UndercutThresholdPlnDay} PLN/dzien, zeby zostac top1; cel to ${options.undercutBufferPlnDay} PLN ponizej top1.`,
        benchmarkOffer: top1,
        siteTarget: top1Target
      });
    }

    return buildNoopRecommendation(
      base,
      `MM Cars Rental jest top2, ale przebicie top1 wymaga obnizki co najmniej ${options.top1UndercutThresholdPlnDay} PLN/dzien.`
    );
  }

  const smallDecreaseCompetitor =
    mmRank === "outside_top3"
      ? top3
      : typeof mmRank === "number" && mmRank > 2 && mmRank <= 3
        ? topOffers[mmRank - 2]
        : null;
  const smallDecreaseTargetRank =
    mmRank === "outside_top3"
      ? 3
      : typeof mmRank === "number" && mmRank > 2 && mmRank <= 3
        ? mmRank - 1
        : null;
  const smallDecreaseCompetitorRate = toDailyRate(smallDecreaseCompetitor);
  if (smallDecreaseCompetitor && smallDecreaseCompetitorRate != null && smallDecreaseTargetRank != null) {
    const smallDecreaseTarget = roundRate(smallDecreaseCompetitorRate - options.undercutBufferPlnDay, options);
    const smallDecreaseChange = smallDecreaseTarget - mmRate;
    if (
      smallDecreaseChange < 0 &&
      Math.abs(smallDecreaseChange) < options.top3SmallDecreaseThresholdPlnDay &&
      Math.abs(smallDecreaseChange) >= options.minChangePlnDay
    ) {
      return buildActiveRecommendation({
        base,
        options,
        action: "decrease",
        recommendationType: "top3_small_decrease",
        targetRank: smallDecreaseTargetRank,
        reason: `Male obnizenie ponizej ${options.top3SmallDecreaseThresholdPlnDay} PLN/dzien pozwala przeskoczyc rywala z top${smallDecreaseTargetRank}; cel to 1 PLN ponizej tej oferty.`,
        benchmarkOffer: smallDecreaseCompetitor,
        siteTarget: smallDecreaseTarget
      });
    }
  }

  return buildNoopRecommendation(
    base,
    "MM Cars Rental nie spelnia warunkow aktywnej rekomendacji cenowej dla tego scenariusza."
  );
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
    calibrationPath: null,
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
    if (arg.startsWith("--calibration=")) {
      args.calibrationPath = arg.slice("--calibration=".length);
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
      "Usage: node src/pricingRecommendations.js output/results-latest.json output/pricing-recommendations.json [--config=pricing-rules.json] [--calibration=broker-markup-calibration.json] [--include-noop]\n"
    );
    process.exitCode = 1;
    return;
  }

  const payload = loadJson(args.inputPath);
  const config = args.configPath ? loadJson(args.configPath) : {};
  const configPricing = config.pricing || config;
  const learnedCalibration = args.calibrationPath && fs.existsSync(path.resolve(args.calibrationPath))
    ? loadJson(args.calibrationPath)
    : {};
  const output = buildPricingRecommendations(payload, {
    ...configPricing,
    brokerMarkupCalibration: mergeBrokerMarkupCalibration(configPricing.brokerMarkupCalibration, learnedCalibration),
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
