const fs = require("fs");
const path = require("path");
const { WARSAW_TIME_ZONE, addDaysToDateParts, getZonedDateParts } = require("./dateUtils");

function list(value) {
  return (Array.isArray(value) ? value : String(value || "").split(","))
    .map((item) => String(item).trim()).filter(Boolean);
}

function formatDate(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function validDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value;
}

function buildScrapeScope(options = {}) {
  const now = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid scope anchor time.");
  const anchor = getZonedDateParts(now, WARSAW_TIME_ZONE);
  const locations = [...new Set(list(options.locations))];
  const durationInputs = list(options.durations);
  if (!locations.length) throw new Error("Scope requires locations.");
  if (!durationInputs.length || durationInputs.some((value) => !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20)) {
    throw new Error("Scope requires integer durations from 1 to 20.");
  }
  const durations = [...new Set(durationInputs.map(Number))].sort((left, right) => left - right);
  let startDates = [...new Set(list(options.startDates))].sort();
  let rollingDays = null;
  const mode = startDates.length ? "start-dates" : "rolling";
  if (mode === "start-dates") {
    if (startDates.some((date) => !validDate(date))) throw new Error("Scope requires valid YYYY-MM-DD start dates.");
  } else {
    rollingDays = Number(options.rollingDays);
    if (!Number.isInteger(rollingDays) || rollingDays < 1 || rollingDays > 365) {
      throw new Error("Scope requires rollingDays from 1 to 365 or explicit start dates.");
    }
    startDates = Array.from({ length: rollingDays }, (_, index) => formatDate(addDaysToDateParts(anchor, index + 1)));
  }
  const scenarioKeys = startDates.flatMap((date) => durations.map((duration) => `${date}|${duration}`));
  const locationKeys = scenarioKeys.flatMap((key) => locations.map((location) => `${key}|${location}`));
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    time_zone: WARSAW_TIME_ZONE,
    anchor_date: formatDate(anchor),
    mode,
    rolling_days: rollingDays,
    start_dates: startDates,
    durations,
    locations,
    expected_scenario_count: scenarioKeys.length,
    expected_location_check_count: locationKeys.length,
    scenario_keys: scenarioKeys,
    location_check_keys: locationKeys
  };
}

function validateScrapeScope(scope) {
  if (!scope || scope.schema_version !== 1 || scope.time_zone !== WARSAW_TIME_ZONE
    || !["rolling", "start-dates"].includes(scope.mode) || typeof scope.generated_at !== "string") {
    throw new Error("Invalid scrape scope schema (expected version 1, Europe/Warsaw).");
  }
  for (const field of ["start_dates", "durations", "locations", "scenario_keys", "location_check_keys"]) {
    if (!Array.isArray(scope[field]) || !scope[field].length) throw new Error(`Invalid scrape scope field: ${field}.`);
  }
  const canonical = buildScrapeScope({
    now: scope.generated_at,
    startDates: scope.mode === "start-dates" ? scope.start_dates : [],
    rollingDays: scope.rolling_days,
    durations: scope.durations,
    locations: scope.locations
  });
  for (const field of ["anchor_date", "mode", "rolling_days", "start_dates", "durations", "locations", "expected_scenario_count", "expected_location_check_count", "scenario_keys", "location_check_keys"]) {
    if (JSON.stringify(scope[field]) !== JSON.stringify(canonical[field])) {
      throw new Error(`Inconsistent scrape scope field: ${field}.`);
    }
  }
  return canonical;
}

function runCli(argv) {
  const args = Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => {
    const equals = arg.indexOf("=");
    return equals < 0 ? [arg.slice(2), ""] : [arg.slice(2, equals), arg.slice(equals + 1)];
  }));
  const scope = buildScrapeScope({
    locations: args.locations,
    rollingDays: args["rolling-days"],
    startDates: args["start-dates"],
    durations: args.durations
  });
  const serialized = `${JSON.stringify(scope, null, 2)}\n`;
  if (args.output) {
    const output = path.resolve(args.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildScrapeScope, validateScrapeScope, runCli };
