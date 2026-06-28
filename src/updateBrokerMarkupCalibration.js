const fs = require("fs");
const path = require("path");
const { mergeBrokerMarkupCalibration } = require("./brokerMarkupCalibration");

function readJsonIfExists(filePath) {
  if (!filePath) {
    return {};
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundMultiplier(value) {
  return Number(value.toFixed(6));
}

function blendMultiplier(previous, observed, alpha, min, max) {
  const previousNumber = asNumber(previous);
  const observedNumber = asNumber(observed);
  if (observedNumber === null || observedNumber <= 0) {
    return previousNumber === null ? null : roundMultiplier(clamp(previousNumber, min, max));
  }
  if (previousNumber === null || previousNumber <= 0) {
    return roundMultiplier(clamp(observedNumber, min, max));
  }
  return roundMultiplier(clamp(previousNumber * (1 - alpha) + observedNumber * alpha, min, max));
}

function getExcelObservations(excelSummary) {
  const observations = excelSummary?.broker_markup_observations;
  if (!observations?.enabled || !observations.count) {
    return null;
  }
  return observations;
}

function summarizeSanityCheck(sanityCheck) {
  const checks = Array.isArray(sanityCheck?.checks) ? sanityCheck.checks : [];
  const observed = checks
    .map((item) => asNumber(item.observed_broker_markup_multiplier))
    .filter((item) => item !== null && item > 0);
  const average = observed.length
    ? observed.reduce((sum, item) => sum + item, 0) / observed.length
    : null;
  return {
    checked_count: Number(sanityCheck?.checked_count || checks.length || 0),
    warning_count: Number(sanityCheck?.warning_count || 0),
    observed_multiplier_count: observed.length,
    average_observed_multiplier: average === null ? null : roundMultiplier(average),
    average_observed_markup_percent: average === null ? null : Number(((average - 1) * 100).toFixed(2))
  };
}

function buildCalibrationUpdate({ baseConfig = {}, previousCalibration = {}, excelSummary = {}, sanityCheck = {}, alpha = 0.35 } = {}) {
  const basePricing = baseConfig.pricing || baseConfig;
  const current = mergeBrokerMarkupCalibration(basePricing.brokerMarkupCalibration, previousCalibration);
  const observations = getExcelObservations(excelSummary);
  const minMultiplier = current.minMultiplier || 1;
  const maxMultiplier = current.maxMultiplier || 1.25;
  const learningAlpha = clamp(asNumber(alpha) ?? 0.35, 0.01, 1);

  const next = {
    enabled: current.enabled,
    defaultMultiplier: current.defaultMultiplier,
    minMultiplier,
    maxMultiplier,
    locationMultipliers: { ...(current.locationMultipliers || {}) },
    durationMultipliers: { ...(current.durationMultipliers || {}) }
  };

  if (observations?.average_multiplier) {
    next.defaultMultiplier = blendMultiplier(
      next.defaultMultiplier,
      observations.average_multiplier,
      learningAlpha,
      minMultiplier,
      maxMultiplier
    );
  }

  for (const [location, summary] of Object.entries(observations?.by_location || {})) {
    if (!summary?.average_multiplier) {
      continue;
    }
    next.locationMultipliers[location] = blendMultiplier(
      next.locationMultipliers[location],
      summary.average_multiplier,
      learningAlpha,
      minMultiplier,
      maxMultiplier
    );
  }

  for (const [duration, summary] of Object.entries(observations?.by_duration || {})) {
    if (!summary?.average_multiplier) {
      continue;
    }
    next.durationMultipliers[duration] = blendMultiplier(
      next.durationMultipliers[duration],
      summary.average_multiplier,
      learningAlpha,
      minMultiplier,
      maxMultiplier
    );
  }

  return {
    generated_at: new Date().toISOString(),
    brokerMarkupCalibration: next,
    learning: {
      alpha: learningAlpha,
      source: observations ? "excel-rate-update-summary" : "previous-or-static",
      observation_count: observations?.count || 0,
      observed_average_multiplier: observations?.average_multiplier || null,
      observed_average_markup_percent: observations?.average_markup_percent || null,
      by_location: observations?.by_location || {},
      by_duration: observations?.by_duration || {},
      sanity_check: summarizeSanityCheck(sanityCheck)
    }
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

function runCli(argv) {
  const args = parseArgs(argv);
  const outputPath = args.output || path.join("output", "broker-markup-calibration.json");
  const update = buildCalibrationUpdate({
    baseConfig: readJsonIfExists(args.base),
    previousCalibration: readJsonIfExists(args.previous),
    excelSummary: readJsonIfExists(args["excel-summary"]),
    sanityCheck: readJsonIfExists(args["sanity-check"]),
    alpha: asNumber(args.alpha) ?? 0.35
  });
  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(update, null, 2)}\n`, "utf8");
  process.stdout.write(`Broker markup calibration saved to ${resolvedOutputPath}\n`);
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  buildCalibrationUpdate
};
