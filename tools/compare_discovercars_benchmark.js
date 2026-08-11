const fs = require("node:fs");
const path = require("node:path");

const { buildScrapeQualityReport } = require("../src/workflowQualityAlerts");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("=")) {
      continue;
    }
    const [key, ...valueParts] = arg.slice(2).split("=");
    options[key] = valueParts.join("=");
  }
  return options;
}

function scenarioIds(payload) {
  return new Set((payload?.scenarios || []).map((scenario) => String(scenario.scenario_id || "")).filter(Boolean));
}

function scenarioKeys(payload) {
  return new Set((payload?.scenarios || []).map((scenario) => {
    const startDate = String(scenario.start_date || scenario.pickup_date || "").slice(0, 10);
    return `${startDate}|${Number(scenario.rental_days)}`;
  }));
}

function expectedScenarioKeys(startDates, durations) {
  return new Set(splitCsv(startDates).flatMap((startDate) => (
    splitCsv(durations).map((duration) => `${startDate}|${Number(duration)}`)
  )));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function compareBenchmark({
  baselineResults,
  parallelResults,
  baselineTiming,
  parallelTimings,
  parallelShardResults,
  expectedLocations,
  expectedStartDates,
  expectedDurations,
  expectedScenarioCount,
  minimumSpeedupPercent = 20
}) {
  const baselineQuality = buildScrapeQualityReport({ results: baselineResults, expectedLocations });
  const parallelQuality = buildScrapeQualityReport({ results: parallelResults, expectedLocations });
  const baselineSeconds = Number(baselineTiming?.duration_seconds || 0);
  const parallelStarted = Math.min(...parallelTimings.map((item) => Number(item.started_epoch)));
  const parallelCompleted = Math.max(...parallelTimings.map((item) => Number(item.completed_epoch)));
  const parallelWallSeconds = parallelCompleted - parallelStarted;
  const speedupPercent = baselineSeconds > 0 && parallelWallSeconds > 0
    ? Number(((baselineSeconds - parallelWallSeconds) / baselineSeconds * 100).toFixed(2))
    : 0;
  const expectedChecks = expectedScenarioCount * splitCsv(expectedLocations).length;
  const scenarioParity = sameSet(scenarioIds(baselineResults), scenarioIds(parallelResults));
  const expectedKeys = expectedScenarioKeys(expectedStartDates, expectedDurations);
  const baselineScopeMatches = sameSet(scenarioKeys(baselineResults), expectedKeys);
  const parallelScopeMatches = sameSet(scenarioKeys(parallelResults), expectedKeys);
  const parallelSourceChunkFailureCount = parallelShardResults.reduce(
    (total, payload) => total + (Array.isArray(payload?.chunk_failures) ? payload.chunk_failures.length : 0),
    0
  );
  const parallelDuplicateScenarioCount = Number(parallelResults?.merge_meta?.duplicate_scenario_count || 0);
  const integrityPassed = Boolean(
    baselineSeconds > 0
    && parallelWallSeconds > 0
    && parallelTimings.length === 2
    && parallelShardResults.length === 2
    && baselineQuality.scenario_count === expectedScenarioCount
    && parallelQuality.scenario_count === expectedScenarioCount
    && baselineQuality.expected_location_check_count === expectedChecks
    && parallelQuality.expected_location_check_count === expectedChecks
    && scenarioParity
    && baselineScopeMatches
    && parallelScopeMatches
    && baselineQuality.invalid_currency_count === 0
    && parallelQuality.invalid_currency_count === 0
    && baselineQuality.failed_scenario_count === 0
    && parallelQuality.failed_scenario_count === 0
    && baselineQuality.chunk_failure_count === 0
    && parallelQuality.chunk_failure_count === 0
    && parallelSourceChunkFailureCount === 0
    && parallelDuplicateScenarioCount === 0
  );
  const qualityPreserved = Boolean(
    integrityPassed
    && parallelQuality.top3_coverage_percent >= baselineQuality.top3_coverage_percent
    && parallelQuality.missing_top3_count <= baselineQuality.missing_top3_count
  );

  return {
    generated_at: new Date().toISOString(),
    expected_scenario_count: expectedScenarioCount,
    expected_location_check_count: expectedChecks,
    baseline: {
      duration_seconds: baselineSeconds,
      quality: baselineQuality
    },
    parallel: {
      duration_seconds: parallelWallSeconds,
      shard_duration_seconds: parallelTimings.map((item) => Number(item.duration_seconds || 0)),
      source_chunk_failure_count: parallelSourceChunkFailureCount,
      duplicate_scenario_count: parallelDuplicateScenarioCount,
      quality: parallelQuality
    },
    comparison: {
      speedup_percent: speedupPercent,
      scenario_parity: scenarioParity,
      baseline_scope_matches: baselineScopeMatches,
      parallel_scope_matches: parallelScopeMatches,
      integrity_passed: integrityPassed,
      quality_preserved: qualityPreserved,
      minimum_speedup_percent: minimumSpeedupPercent,
      production_change_recommended: qualityPreserved && speedupPercent >= minimumSpeedupPercent
    }
  };
}

function findTimingFiles(rootPath) {
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name, "timing.json"))
    .filter((filePath) => fs.existsSync(filePath));
}

function findResultFiles(rootPath) {
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name, "results-latest.json"))
    .filter((filePath) => fs.existsSync(filePath));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = [
    "baseline-results",
    "parallel-results",
    "baseline-timing",
    "parallel-timings-dir",
    "locations",
    "start-dates",
    "durations",
    "scenario-count",
    "output"
  ];
  for (const key of required) {
    if (!options[key]) {
      throw new Error(`Missing required option --${key}=...`);
    }
  }

  const parallelTimingFiles = findTimingFiles(path.resolve(options["parallel-timings-dir"]));
  const parallelResultFiles = findResultFiles(path.resolve(options["parallel-timings-dir"]));
  const report = compareBenchmark({
    baselineResults: readJson(path.resolve(options["baseline-results"])),
    parallelResults: readJson(path.resolve(options["parallel-results"])),
    baselineTiming: readJson(path.resolve(options["baseline-timing"])),
    parallelTimings: parallelTimingFiles.map(readJson),
    parallelShardResults: parallelResultFiles.map(readJson),
    expectedLocations: options.locations,
    expectedStartDates: options["start-dates"],
    expectedDurations: options.durations,
    expectedScenarioCount: Number(options["scenario-count"]),
    minimumSpeedupPercent: Number(options["minimum-speedup-percent"] || 20)
  });
  writeJson(path.resolve(options.output), report);
  console.log(JSON.stringify(report, null, 2));

  if (!report.comparison.integrity_passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  compareBenchmark,
  expectedScenarioKeys,
  parseArgs,
  sameSet
};
