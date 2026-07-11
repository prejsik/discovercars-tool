const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listRecommendations(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.recommendations)) {
    return payload.recommendations;
  }
  return [];
}

function listBaselineObservations(payload) {
  const observations = payload?.broker_markup_observations?.observations;
  return Array.isArray(observations) ? observations : [];
}

function normalizeDate(value) {
  return String(value || "").slice(0, 10);
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recommendationKey(item) {
  return [
    item.location || "",
    normalizeDate(item.start_date || item.pickup_date),
    String(item.rental_days || "")
  ].join("|");
}

function enrichRecommendationsWithBaseline(recommendations, excelSummary) {
  const observations = new Map(
    listBaselineObservations(excelSummary).map((item) => [
      recommendationKey({
        location: item.location,
        pickup_date: item.pickup_date,
        rental_days: item.duration_days
      }),
      item
    ])
  );
  return listRecommendations(recommendations).map((item) => {
    const observation = observations.get(recommendationKey(item));
    if (!observation) {
      return item;
    }
    return {
      ...item,
      baseline_import_rate_pln_day: asNumber(observation.old_import_rate_pln_day),
      baseline_live_mm_rate_pln_day: asNumber(observation.live_mm_rate_pln_day)
    };
  });
}

function durationBand(value) {
  const duration = Number(value);
  if (duration <= 4) return "short";
  if (duration <= 7) return "medium";
  return "long";
}

function locationKind(value) {
  return /airport|lotnisko|\([a-z]{3}\)/i.test(String(value || "")) ? "airport" : "city";
}

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function selectSanitySample(recommendations, sampleSize = 6) {
  const candidates = listRecommendations(recommendations)
    .filter((item) => item && item.action !== "hold")
    .filter((item) => item.location && normalizeDate(item.start_date || item.pickup_date))
    .filter((item) => Number.isFinite(Number(item.rental_days)))
    .filter((item) => asNumber(item.mm_rate_pln_day) !== null);

  const byKey = new Map();
  for (const item of candidates) {
    const key = recommendationKey(item);
    if (!byKey.has(key)) {
      byKey.set(key, item);
    }
  }

  const unique = Array.from(byKey.values()).sort((a, b) => {
    const locationCompare = String(a.location).localeCompare(String(b.location));
    if (locationCompare) {
      return locationCompare;
    }
    const dateCompare = normalizeDate(a.start_date || a.pickup_date).localeCompare(
      normalizeDate(b.start_date || b.pickup_date)
    );
    if (dateCompare) {
      return dateCompare;
    }
    return Number(a.rental_days) - Number(b.rental_days);
  });

  const selected = [];
  while (selected.length < sampleSize && selected.length < unique.length) {
    const usedLocations = new Set(selected.map((item) => item.location));
    const usedKinds = new Set(selected.map((item) => locationKind(item.location)));
    const usedBands = new Set(selected.map((item) => durationBand(item.rental_days)));
    const usedTypes = new Set(selected.map((item) => item.recommendation_type || ""));
    const selectedDates = selected.map((item) => Date.parse(normalizeDate(item.start_date || item.pickup_date))).filter(Number.isFinite);
    let best = null;
    let bestScore = -Infinity;
    for (const item of unique) {
      if (selected.includes(item)) continue;
      const itemDate = Date.parse(normalizeDate(item.start_date || item.pickup_date));
      const dateDistance = selectedDates.length && Number.isFinite(itemDate)
        ? Math.min(...selectedDates.map((value) => Math.abs(value - itemDate))) / 86400000
        : 30;
      const score =
        (usedLocations.has(item.location) ? 0 : 1000)
        + (usedKinds.has(locationKind(item.location)) ? 0 : 100)
        + (usedBands.has(durationBand(item.rental_days)) ? 0 : 40)
        + (usedTypes.has(item.recommendation_type || "") ? 0 : 20)
        + Math.min(dateDistance, 30);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    selected.push(best);
  }
  return selected;
}

function getDailyRate(offer) {
  const totalPrice = asNumber(offer?.total_price);
  const rentalDays = asNumber(offer?.rental_days);
  if (totalPrice === null || rentalDays === null || rentalDays <= 0) {
    return null;
  }
  return Math.round((totalPrice / rentalDays) * 100) / 100;
}

function extractLiveMmRate(payload, location) {
  const mm = payload?.mm_cars_rental_by_location?.[location];
  const top3 = payload?.top_3_by_location?.[location] || [];
  const dailyRate = getDailyRate(mm);
  const rankIndex = top3.findIndex((item) => normalizeProvider(item?.provider_name).includes("mm cars rental"));
  return {
    dailyRate,
    rank: rankIndex >= 0 ? rankIndex + 1 : "outside_top3",
    generatedAt: payload?.generated_at || "",
    totalPrice: asNumber(mm?.total_price)
  };
}

function buildSanityComparison({
  recommendation,
  livePayload,
  thresholdPlnDay,
  requireBaseline = false,
  minMarkupMultiplier = 1,
  maxMarkupMultiplier = 1.2
}) {
  const location = recommendation.location;
  const live = extractLiveMmRate(livePayload, location);
  const recommendationRate = asNumber(recommendation.mm_rate_pln_day);
  const suggestedRate = asNumber(recommendation.suggested_rate_pln_day);
  const siteTargetRate = asNumber(recommendation.site_target_rate_pln_day);
  const predictedSiteRate = asNumber(recommendation.predicted_site_rate_pln_day);
  const brokerMarkupMultiplier = asNumber(recommendation.broker_markup_multiplier);
  const baselineImportRate = asNumber(recommendation.baseline_import_rate_pln_day);
  const delta = live.dailyRate === null || recommendationRate === null
    ? null
    : Math.round((live.dailyRate - recommendationRate) * 100) / 100;
  const suggestedDelta = live.dailyRate === null || suggestedRate === null
    ? null
    : Math.round((live.dailyRate - suggestedRate) * 100) / 100;
  const siteTargetDelta = live.dailyRate === null || siteTargetRate === null
    ? null
    : Math.round((live.dailyRate - siteTargetRate) * 100) / 100;
  const predictedSiteDelta = live.dailyRate === null || predictedSiteRate === null
    ? null
    : Math.round((live.dailyRate - predictedSiteRate) * 100) / 100;
  const observedBrokerMarkupMultiplier = live.dailyRate === null || baselineImportRate === null || baselineImportRate <= 0
    ? null
    : Math.round((live.dailyRate / baselineImportRate) * 10000) / 10000;
  const warningReasons = [];
  if (delta === null) {
    warningReasons.push("live_rate_unavailable");
  } else if (Math.abs(delta) > thresholdPlnDay) {
    warningReasons.push("live_rate_changed_since_full_scrape");
  }
  if (requireBaseline && baselineImportRate === null) {
    warningReasons.push("baseline_import_rate_missing");
  }
  if (
    observedBrokerMarkupMultiplier !== null
    && (observedBrokerMarkupMultiplier < minMarkupMultiplier || observedBrokerMarkupMultiplier > maxMarkupMultiplier)
  ) {
    warningReasons.push("baseline_markup_outside_allowed_range");
  }
  const status = warningReasons.length ? "WARNING" : "OK";

  return {
    status,
    location,
    start_date: normalizeDate(recommendation.start_date || recommendation.pickup_date),
    rental_days: Number(recommendation.rental_days),
    recommendation_type: recommendation.recommendation_type || "",
    recommendation_mm_rate_pln_day: recommendationRate,
    live_mm_rate_pln_day: live.dailyRate,
    delta_pln_day: delta,
    suggested_rate_pln_day: suggestedRate,
    site_target_rate_pln_day: siteTargetRate,
    predicted_site_rate_pln_day: predictedSiteRate,
    baseline_import_rate_pln_day: baselineImportRate,
    live_minus_suggested_pln_day: suggestedDelta,
    live_minus_site_target_pln_day: siteTargetDelta,
    live_minus_predicted_site_pln_day: predictedSiteDelta,
    broker_markup_multiplier: brokerMarkupMultiplier,
    broker_markup_percent: asNumber(recommendation.broker_markup_percent),
    broker_markup_source: recommendation.broker_markup_source || "",
    observed_broker_markup_multiplier: observedBrokerMarkupMultiplier,
    markup_multiplier_min: minMarkupMultiplier,
    markup_multiplier_max: maxMarkupMultiplier,
    warning_reasons: warningReasons,
    live_mm_rank: live.rank,
    source_generated_at: recommendation.source_generated_at || "",
    live_generated_at: live.generatedAt
  };
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const [key, value = ""] = arg.slice(2).split("=");
    args[key] = value;
  }
  return args;
}

function runScrape({ recommendation, outputDir, speedMode }) {
  const location = recommendation.location;
  const startDate = normalizeDate(recommendation.start_date || recommendation.pickup_date);
  const rentalDays = String(recommendation.rental_days);
  const id = `${location}-${startDate}-${rentalDays}d`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  const outputPath = path.join(outputDir, `${id}.json`);
  const logPath = path.join(outputDir, `${id}.log`);
  const args = [
    path.join("src", "index.js"),
    `--save=${outputPath}`,
    `--locations=${location}`,
    "--scenario-mode=start-dates",
    `--start-dates=${startDate}`,
    `--durations=${rentalDays}`,
    "--strategy=legacy-batch",
    `--speed-mode=${speedMode}`,
    "--scenario-concurrency=1",
    "--location-concurrency=1",
    "--timeout=auto",
    "--retries=1",
    "--reset-state"
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  fs.writeFileSync(logPath, `${result.stdout || ""}${result.stderr || ""}`, "utf8");
  if (result.status !== 0) {
    throw new Error(`Scraper failed for ${id} with exit code ${result.status}. See ${logPath}`);
  }
  return {
    outputPath,
    logPath,
    payload: readJson(outputPath)
  };
}

function runCli(argv) {
  const args = parseArgs(argv);
  const recommendationsPath = args.recommendations;
  if (!recommendationsPath) {
    throw new Error("Missing --recommendations=PATH");
  }
  const outputPath = args.output ? path.resolve(args.output) : null;
  const sampleSize = Number(args["sample-size"] || 6);
  const thresholdPlnDay = Number(args.threshold || 10);
  const speedMode = args["speed-mode"] || "fast";
  const outputDir = path.resolve(args["work-dir"] || path.join("output", "mm-rate-sanity-check"));
  fs.mkdirSync(outputDir, { recursive: true });

  const recommendations = readJson(recommendationsPath);
  const excelSummary = args["excel-summary"] ? readJson(args["excel-summary"]) : null;
  const requireBaseline = Boolean(excelSummary);
  const enrichedRecommendations = enrichRecommendationsWithBaseline(recommendations, excelSummary);
  const baselineCandidates = requireBaseline
    ? enrichedRecommendations.filter((item) => asNumber(item.baseline_import_rate_pln_day) !== null)
    : enrichedRecommendations;
  const sample = selectSanitySample({ recommendations: baselineCandidates }, sampleSize);
  const minMarkupMultiplier = Number(args["min-markup-multiplier"] || 1);
  const maxMarkupMultiplier = Number(args["max-markup-multiplier"] || 1.2);
  const checks = [];
  for (const recommendation of sample) {
    try {
      const live = runScrape({ recommendation, outputDir, speedMode });
      const check = buildSanityComparison({
        recommendation,
        livePayload: live.payload,
        thresholdPlnDay,
        requireBaseline,
        minMarkupMultiplier,
        maxMarkupMultiplier
      });
      checks.push({
        ...check,
        live_output_path: live.outputPath,
        live_log_path: live.logPath
      });
    } catch (error) {
      checks.push({
        status: "WARNING",
        location: recommendation.location,
        start_date: normalizeDate(recommendation.start_date || recommendation.pickup_date),
        rental_days: Number(recommendation.rental_days),
        recommendation_mm_rate_pln_day: asNumber(recommendation.mm_rate_pln_day),
        baseline_import_rate_pln_day: asNumber(recommendation.baseline_import_rate_pln_day),
        live_mm_rate_pln_day: null,
        delta_pln_day: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const warningCount = checks.filter((item) => item.status !== "OK").length;
  const baselineVerifiedCount = checks.filter(
    (item) => asNumber(item.baseline_import_rate_pln_day) !== null && asNumber(item.live_mm_rate_pln_day) !== null
  ).length;
  const output = {
    generated_at: new Date().toISOString(),
    threshold_pln_day: thresholdPlnDay,
    sample_size_requested: sampleSize,
    checked_count: checks.length,
    warning_count: warningCount,
    baseline_verification_required: requireBaseline,
    baseline_observation_count: listBaselineObservations(excelSummary).length,
    baseline_verified_count: baselineVerifiedCount,
    checks
  };

  const body = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body, "utf8");
  } else {
    process.stdout.write(body);
  }
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildSanityComparison,
  enrichRecommendationsWithBaseline,
  extractLiveMmRate,
  selectSanitySample
};
