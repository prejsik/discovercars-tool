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
  const usedLocations = new Set();
  for (const item of unique) {
    if (selected.length >= sampleSize) {
      break;
    }
    if (usedLocations.has(item.location) && usedLocations.size < 4) {
      continue;
    }
    selected.push(item);
    usedLocations.add(item.location);
  }
  for (const item of unique) {
    if (selected.length >= sampleSize) {
      break;
    }
    if (!selected.includes(item)) {
      selected.push(item);
    }
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
  const rankIndex = top3.findIndex((item) => item?.provider_name === "MM Cars Rental");
  return {
    dailyRate,
    rank: rankIndex >= 0 ? rankIndex + 1 : "outside_top3",
    generatedAt: payload?.generated_at || "",
    totalPrice: asNumber(mm?.total_price)
  };
}

function buildSanityComparison({ recommendation, livePayload, thresholdPlnDay }) {
  const location = recommendation.location;
  const live = extractLiveMmRate(livePayload, location);
  const recommendationRate = asNumber(recommendation.mm_rate_pln_day);
  const suggestedRate = asNumber(recommendation.suggested_rate_pln_day);
  const siteTargetRate = asNumber(recommendation.site_target_rate_pln_day);
  const predictedSiteRate = asNumber(recommendation.predicted_site_rate_pln_day);
  const brokerMarkupMultiplier = asNumber(recommendation.broker_markup_multiplier);
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
  const observedBrokerMarkupMultiplier = live.dailyRate === null || suggestedRate === null || suggestedRate <= 0
    ? null
    : Math.round((live.dailyRate / suggestedRate) * 10000) / 10000;
  const status = delta === null
    ? "WARNING"
    : Math.abs(delta) > thresholdPlnDay
      ? "WARNING"
      : "OK";

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
    live_minus_suggested_pln_day: suggestedDelta,
    live_minus_site_target_pln_day: siteTargetDelta,
    live_minus_predicted_site_pln_day: predictedSiteDelta,
    broker_markup_multiplier: brokerMarkupMultiplier,
    broker_markup_percent: asNumber(recommendation.broker_markup_percent),
    broker_markup_source: recommendation.broker_markup_source || "",
    observed_broker_markup_multiplier: observedBrokerMarkupMultiplier,
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
  const sample = selectSanitySample(recommendations, sampleSize);
  const checks = [];
  for (const recommendation of sample) {
    try {
      const live = runScrape({ recommendation, outputDir, speedMode });
      const check = buildSanityComparison({ recommendation, livePayload: live.payload, thresholdPlnDay });
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
        live_mm_rate_pln_day: null,
        delta_pln_day: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const warningCount = checks.filter((item) => item.status !== "OK").length;
  const output = {
    generated_at: new Date().toISOString(),
    threshold_pln_day: thresholdPlnDay,
    sample_size_requested: sampleSize,
    checked_count: checks.length,
    warning_count: warningCount,
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
  extractLiveMmRate,
  selectSanitySample
};
