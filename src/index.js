#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const {
  addDaysToDateParts,
  computeNearestRentalWindow,
  getZonedDateParts,
  toIsoWithOffset,
  zonedLocalDateTimeToUtcDate
} = require("./dateUtils");
const { searchCheapestOffers } = require("./discoverCars");
const {
  buildOutputPayload,
  printCompactScenarioTable,
  savePayloadToFile
} = require("./formatters");

const DEFAULT_LOCATIONS = ["Warsaw", "Krakow", "Gdansk", "Katowice", "Wroclaw", "Poznan"];
const DEFAULT_START_DAYS = ["friday"];
const DEFAULT_RENTAL_DURATIONS = Array.from({ length: 9 }, (_, index) => index + 2);
const ALL_START_DAYS = ["thursday", "friday"];
const ALL_RENTAL_DURATIONS = [2, 3];
const DEFAULT_SCENARIO_MODE = "rolling";
const DEFAULT_ROLLING_DAYS = 30;
const DEFAULT_DIRECT_CANDIDATE_LIMIT = 2;
const DEFAULT_DIRECT_OFFERS_WAIT_MS = 6_000;
const DEFAULT_CHECKPOINT_PATH = path.resolve(process.cwd(), "output", "state.json");
const WARSAW_TIME_ZONE = "Europe/Warsaw";
const DEFAULT_SPEED_MODE = "safe";
const SPEED_MODES = ["safe", "fast", "turbo"];

function uniqueInOrder(values) {
  const seen = new Set();
  const output = [];

  for (const value of values || []) {
    const key = String(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }

  return output;
}

function normalizeStartDayToken(rawToken) {
  const token = String(rawToken || "").trim().toLowerCase();
  if (!token) {
    return "";
  }

  const aliasMap = {
    thursday: "thursday",
    thu: "thursday",
    czwartek: "thursday",
    czw: "thursday",
    friday: "friday",
    fri: "friday",
    piatek: "friday",
    pt: "friday"
  };

  return aliasMap[token] || "";
}

function normalizeLocationKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSpeedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SPEED_MODES.includes(normalized) ? normalized : DEFAULT_SPEED_MODE;
}

function parseStartDays(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return [...DEFAULT_START_DAYS];
  }

  if (/^(both|all)$/i.test(raw)) {
    return [...ALL_START_DAYS];
  }

  const parsed = uniqueInOrder(
    raw
      .split(",")
      .map((item) => normalizeStartDayToken(item))
      .filter(Boolean)
  );

  return parsed.length ? parsed : [...DEFAULT_START_DAYS];
}

function parseRentalDurations(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return [...DEFAULT_RENTAL_DURATIONS];
  }

  const parsed = uniqueInOrder(
    raw
      .split(/[,\s/;|]+/)
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((value) => Number.isFinite(value) && value >= 2 && value <= 20)
  ).sort((left, right) => left - right);

  return parsed.length ? parsed : [...DEFAULT_RENTAL_DURATIONS];
}

function parseAndValidateIsoDate(dateText) {
  const raw = String(dateText || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseStartDates(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return [];
  }

  const parsed = uniqueInOrder(
    raw
      .split(/[,\s;|]+/)
      .map((item) => parseAndValidateIsoDate(item))
      .filter(Boolean)
  ).sort((left, right) => left.localeCompare(right));

  return parsed;
}

function parseCliArgs(argv) {
  const options = {
    headful: false,
    jsonOnly: false,
    pickDurations: false,
    savePath: null,
    verbose: false,
    locations: [...DEFAULT_LOCATIONS],
    retries: 1,
    scenarioConcurrency: null,
    scenarioConcurrencyExplicit: false,
    locationConcurrency: null,
    locationConcurrencyExplicit: false,
    timeoutMs: null,
    timeoutExplicit: false,
    currency: "PLN",
    residenceCountry: "Poland",
    strategy: "legacy-batch",
    directCandidateLimit: DEFAULT_DIRECT_CANDIDATE_LIMIT,
    directOffersWaitMs: DEFAULT_DIRECT_OFFERS_WAIT_MS,
    speedMode: DEFAULT_SPEED_MODE,
    maxPages: null,
    maxPagesExplicit: false,
    scenarioMode: DEFAULT_SCENARIO_MODE,
    rollingDays: DEFAULT_ROLLING_DAYS,
    startDates: [],
    invalidStartDatesInput: "",
    startDays: [...DEFAULT_START_DAYS],
    rentalDurations: [...DEFAULT_RENTAL_DURATIONS],
    resume: true,
    resetState: false,
    checkpointPath: DEFAULT_CHECKPOINT_PATH
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--headful") {
      options.headful = true;
      continue;
    }

    if (arg === "--json") {
      options.jsonOnly = true;
      continue;
    }

    if (arg === "--pick-durations" || arg === "--durations-prompt") {
      options.pickDurations = true;
      continue;
    }

    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }

    if (arg === "--fast") {
      options.speedMode = "fast";
      continue;
    }

    if (arg === "--turbo") {
      options.speedMode = "turbo";
      continue;
    }

    if (arg === "--safe-speed" || arg === "--safe-mode") {
      options.speedMode = "safe";
      continue;
    }

    if (arg === "--save") {
      options.savePath = path.resolve(process.cwd(), "results.json");
      continue;
    }

    if (arg.startsWith("--save=")) {
      options.savePath = path.resolve(process.cwd(), arg.split("=")[1]);
      continue;
    }

    if (arg === "--no-resume") {
      options.resume = false;
      continue;
    }

    if (arg === "--resume") {
      options.resume = true;
      continue;
    }

    if (arg === "--reset-state") {
      options.resetState = true;
      continue;
    }

    if (arg.startsWith("--checkpoint=")) {
      options.checkpointPath = path.resolve(process.cwd(), arg.split("=")[1]);
      continue;
    }

    if (arg.startsWith("--locations=")) {
      const raw = arg.split("=")[1];
      const parsedLocations = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (parsedLocations.length) {
        options.locations = parsedLocations;
      }
      continue;
    }

    if (arg.startsWith("--retries=")) {
      const retries = Number.parseInt(arg.split("=")[1], 10);
      if (Number.isFinite(retries) && retries > 0) {
        options.retries = retries;
      }
      continue;
    }

    if (arg.startsWith("--scenario-concurrency=") || arg.startsWith("--concurrency=")) {
      const rawValue = String(arg.split("=")[1] || "").trim().toLowerCase();
      if (rawValue === "auto") {
        options.scenarioConcurrency = null;
        options.scenarioConcurrencyExplicit = false;
        continue;
      }

      const concurrency = Number.parseInt(rawValue, 10);
      if (Number.isFinite(concurrency) && concurrency > 0 && concurrency <= 16) {
        options.scenarioConcurrency = concurrency;
        options.scenarioConcurrencyExplicit = true;
      }
      continue;
    }

    if (arg.startsWith("--location-concurrency=")) {
      const rawValue = String(arg.split("=")[1] || "").trim().toLowerCase();
      if (rawValue === "auto") {
        options.locationConcurrency = null;
        options.locationConcurrencyExplicit = false;
        continue;
      }

      const locationConcurrency = Number.parseInt(rawValue, 10);
      if (Number.isFinite(locationConcurrency) && locationConcurrency >= 1 && locationConcurrency <= 6) {
        options.locationConcurrency = locationConcurrency;
        options.locationConcurrencyExplicit = true;
      }
      continue;
    }

    if (arg.startsWith("--timeout=")) {
      const rawValue = String(arg.split("=")[1] || "").trim().toLowerCase();
      if (rawValue === "auto") {
        options.timeoutMs = null;
        options.timeoutExplicit = false;
        continue;
      }

      const timeoutMs = Number.parseInt(rawValue, 10);
      if (Number.isFinite(timeoutMs) && timeoutMs >= 10_000) {
        options.timeoutMs = timeoutMs;
        options.timeoutExplicit = true;
      }
      continue;
    }

    if (arg.startsWith("--speed-mode=") || arg.startsWith("--speed-profile=")) {
      options.speedMode = normalizeSpeedMode(arg.split("=")[1]);
      continue;
    }

    if (arg.startsWith("--max-pages=")) {
      const rawValue = String(arg.split("=")[1] || "").trim().toLowerCase();
      if (rawValue === "auto") {
        options.maxPages = null;
        options.maxPagesExplicit = false;
        continue;
      }

      const maxPages = Number.parseInt(rawValue, 10);
      if (Number.isFinite(maxPages) && maxPages >= 1 && maxPages <= 24) {
        options.maxPages = maxPages;
        options.maxPagesExplicit = true;
      }
      continue;
    }

    if (arg.startsWith("--strategy=")) {
      const strategy = String(arg.split("=")[1] || "").trim().toLowerCase();
      if (["legacy-batch", "hybrid", "direct-only"].includes(strategy)) {
        options.strategy = strategy;
      }
      continue;
    }

    if (arg.startsWith("--direct-candidate-limit=")) {
      const directCandidateLimit = Number.parseInt(arg.split("=")[1], 10);
      if (Number.isFinite(directCandidateLimit) && directCandidateLimit >= 1 && directCandidateLimit <= 8) {
        options.directCandidateLimit = directCandidateLimit;
      }
      continue;
    }

    if (arg.startsWith("--direct-offers-wait=")) {
      const directOffersWaitMs = Number.parseInt(arg.split("=")[1], 10);
      if (Number.isFinite(directOffersWaitMs) && directOffersWaitMs >= 1000 && directOffersWaitMs <= 20_000) {
        options.directOffersWaitMs = directOffersWaitMs;
      }
      continue;
    }

    if (arg.startsWith("--scenario-mode=") || arg.startsWith("--start-mode=")) {
      const mode = String(arg.split("=")[1] || "").trim().toLowerCase();
      if (mode === "rolling" || mode === "weekday" || mode === "start-dates") {
        options.scenarioMode = mode;
      }
      continue;
    }

    if (arg.startsWith("--rolling-days=") || arg.startsWith("--start-range-days=")) {
      const rollingDays = Number.parseInt(arg.split("=")[1], 10);
      if (Number.isFinite(rollingDays) && rollingDays > 0 && rollingDays <= 365) {
        options.rollingDays = rollingDays;
      }
      continue;
    }

    if (arg.startsWith("--start-dates=")) {
      const rawStartDates = arg.split("=")[1];
      const parsedStartDates = parseStartDates(rawStartDates);
      options.startDates = parsedStartDates;
      if (String(rawStartDates || "").trim() && !parsedStartDates.length) {
        options.invalidStartDatesInput = rawStartDates;
      }
      continue;
    }

    if (arg.startsWith("--start-day=")) {
      options.scenarioMode = "weekday";
      options.startDays = parseStartDays(arg.split("=")[1]);
      continue;
    }

    if (arg.startsWith("--start=")) {
      options.scenarioMode = "weekday";
      options.startDays = parseStartDays(arg.split("=")[1]);
      continue;
    }

    if (arg.startsWith("--durations=")) {
      options.rentalDurations = parseRentalDurations(arg.split("=")[1]);
      continue;
    }

    if (arg.startsWith("--rental-days=")) {
      options.rentalDurations = parseRentalDurations(arg.split("=")[1]);
      continue;
    }

    if (arg === "--all-date-options") {
      options.scenarioMode = "weekday";
      options.startDays = [...ALL_START_DAYS];
      options.rentalDurations = [...ALL_RENTAL_DURATIONS];
      continue;
    }
  }

  return options;
}

function startDayToLabel(startDay) {
  return startDay === "thursday" ? "Thursday" : "Friday";
}

function scenarioIdFor(startDay, rentalDays) {
  const prefix = startDay === "thursday" ? "thu" : "fri";
  return `${prefix}-${rentalDays}d`;
}

function scenarioIdForDate(startDate, rentalDays) {
  return `date-${String(startDate).replace(/-/g, "")}-${rentalDays}d`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseIsoDate(isoDate) {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid ISO date format: ${isoDate}`);
  }

  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10)
  };
}

function formatDurationLabel(durationMs) {
  const safeMs = Math.max(0, Math.round(durationMs));
  const totalSeconds = Math.floor(safeMs / 1000);
  const milliseconds = safeMs % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m ${pad2(seconds)}s`;
  }
  return `${seconds}.${String(milliseconds).padStart(3, "0")}s`;
}

function weekdayLabelFromIsoDate(isoDate, timeZone = WARSAW_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function buildRollingStartDates(rollingDays, timeZone = WARSAW_TIME_ZONE) {
  const nowParts = getZonedDateParts(new Date(), timeZone);
  const tomorrow = addDaysToDateParts(nowParts, 1);
  const dates = [];

  for (let offset = 0; offset < rollingDays; offset += 1) {
    const dateParts = addDaysToDateParts(tomorrow, offset);
    dates.push(formatDateParts(dateParts));
  }

  return dates;
}

function computeRentalWindowFromStartDate(startDate, rentalDays, timeZone = WARSAW_TIME_ZONE) {
  const pickupDate = parseIsoDate(startDate);
  const dropoffDate = addDaysToDateParts(pickupDate, rentalDays);

  const pickupLocal = {
    year: pickupDate.year,
    month: pickupDate.month,
    day: pickupDate.day,
    hour: 10,
    minute: 0,
    second: 0
  };

  const dropoffLocal = {
    year: dropoffDate.year,
    month: dropoffDate.month,
    day: dropoffDate.day,
    hour: 10,
    minute: 0,
    second: 0
  };

  const pickupUtc = zonedLocalDateTimeToUtcDate(pickupLocal, timeZone);
  const dropoffUtc = zonedLocalDateTimeToUtcDate(dropoffLocal, timeZone);

  return {
    timeZone,
    startDate: formatDateParts(pickupDate),
    pickupLocal,
    dropoffLocal,
    pickupUtc,
    dropoffUtc,
    pickupIso: toIsoWithOffset(pickupUtc, timeZone),
    dropoffIso: toIsoWithOffset(dropoffUtc, timeZone),
    rentalDays
  };
}

function buildScenarioDefinitions(cli) {
  if (Array.isArray(cli.startDates) && cli.startDates.length) {
    const definitions = [];
    for (const startDate of cli.startDates) {
      const weekdayLabel = weekdayLabelFromIsoDate(startDate, WARSAW_TIME_ZONE);
      for (const rentalDays of cli.rentalDurations) {
        definitions.push({
          scenario_id: scenarioIdForDate(startDate, rentalDays),
          start_day: weekdayLabel.toLowerCase(),
          start_day_label: `${startDate} (${weekdayLabel})`,
          start_date: startDate,
          rental_days: rentalDays,
          weekend: computeRentalWindowFromStartDate(startDate, rentalDays, WARSAW_TIME_ZONE)
        });
      }
    }

    return definitions;
  }

  if (cli.scenarioMode === "rolling") {
    const definitions = [];
    const startDates = buildRollingStartDates(cli.rollingDays, WARSAW_TIME_ZONE);

    for (const startDate of startDates) {
      const weekdayLabel = weekdayLabelFromIsoDate(startDate, WARSAW_TIME_ZONE);
      for (const rentalDays of cli.rentalDurations) {
        definitions.push({
          scenario_id: scenarioIdForDate(startDate, rentalDays),
          start_day: weekdayLabel.toLowerCase(),
          start_day_label: `${startDate} (${weekdayLabel})`,
          start_date: startDate,
          rental_days: rentalDays,
          weekend: computeRentalWindowFromStartDate(startDate, rentalDays, WARSAW_TIME_ZONE)
        });
      }
    }

    return definitions;
  }

  const definitions = [];

  for (const startDay of cli.startDays) {
    for (const rentalDays of cli.rentalDurations) {
      const weekend = computeNearestRentalWindow({
        timeZone: WARSAW_TIME_ZONE,
        pickupHour: 10,
        dropoffHour: 10,
        startDay,
        rentalDays
      });

      definitions.push({
        scenario_id: scenarioIdFor(startDay, rentalDays),
        start_day: startDay,
        start_day_label: startDayToLabel(startDay),
        rental_days: rentalDays,
        weekend
      });
    }
  }

  return definitions;
}

function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveSafeExecutionProfile(cli, scenarioCount, cpuCount) {
  let scenarioConcurrency = 1;
  let locationConcurrency = 1;
  let timeoutMs = 60_000;

  if (cli.headful) {
    scenarioConcurrency = 1;
    locationConcurrency = 1;
    timeoutMs = 70_000;
  } else if (scenarioCount <= 12) {
    scenarioConcurrency = 1;
    locationConcurrency = 2;
    timeoutMs = 60_000;
  } else if (scenarioCount <= 60) {
    scenarioConcurrency = 2;
    locationConcurrency = 2;
    timeoutMs = 55_000;
  } else if (scenarioCount <= 140) {
    scenarioConcurrency = 3;
    locationConcurrency = 2;
    timeoutMs = 50_000;
  } else {
    scenarioConcurrency = cpuCount >= 12 ? 5 : 4;
    locationConcurrency = 3;
    timeoutMs = 45_000;
  }

  return { scenarioConcurrency, locationConcurrency, timeoutMs };
}

function resolveFastExecutionProfile(cli, scenarioCount, cpuCount) {
  if (cli.headful) {
    return {
      scenarioConcurrency: 1,
      locationConcurrency: 1,
      timeoutMs: 70_000
    };
  }

  if (scenarioCount <= 1) {
    return {
      scenarioConcurrency: 1,
      locationConcurrency: 3,
      timeoutMs: 45_000
    };
  }

  if (scenarioCount <= 12) {
    return {
      scenarioConcurrency: 2,
      locationConcurrency: 3,
      timeoutMs: 45_000
    };
  }

  if (scenarioCount <= 60) {
    return {
      scenarioConcurrency: 3,
      locationConcurrency: 2,
      timeoutMs: 45_000
    };
  }

  if (scenarioCount <= 140) {
    return {
      scenarioConcurrency: cpuCount >= 10 ? 4 : 3,
      locationConcurrency: 2,
      timeoutMs: 42_000
    };
  }

  return {
    scenarioConcurrency: cpuCount >= 12 ? 5 : 4,
    locationConcurrency: 2,
    timeoutMs: 40_000
  };
}

function resolveTurboExecutionProfile(cli, scenarioCount, cpuCount) {
  if (cli.headful) {
    return {
      scenarioConcurrency: 1,
      locationConcurrency: 1,
      timeoutMs: 70_000
    };
  }

  if (scenarioCount <= 1) {
    return {
      scenarioConcurrency: 1,
      locationConcurrency: 4,
      timeoutMs: 38_000
    };
  }

  if (scenarioCount <= 12) {
    return {
      scenarioConcurrency: 3,
      locationConcurrency: 3,
      timeoutMs: 38_000
    };
  }

  if (scenarioCount <= 60) {
    return {
      scenarioConcurrency: cpuCount >= 10 ? 4 : 3,
      locationConcurrency: 3,
      timeoutMs: 36_000
    };
  }

  if (scenarioCount <= 140) {
    return {
      scenarioConcurrency: cpuCount >= 12 ? 5 : 4,
      locationConcurrency: 2,
      timeoutMs: 35_000
    };
  }

  return {
    scenarioConcurrency: cpuCount >= 12 ? 6 : 5,
    locationConcurrency: 2,
    timeoutMs: 35_000
  };
}

function capActivePages(profile, maxActivePages) {
  const capped = { ...profile };
  if (!Number.isFinite(maxActivePages) || maxActivePages < 1) {
    return capped;
  }

  while (capped.scenarioConcurrency * capped.locationConcurrency > maxActivePages) {
    if (capped.locationConcurrency > 1) {
      capped.locationConcurrency -= 1;
      continue;
    }

    if (capped.scenarioConcurrency > 1) {
      capped.scenarioConcurrency -= 1;
      continue;
    }

    break;
  }

  return capped;
}

function resolveDefaultMaxPages(cli, speedMode, cpuCount) {
  if (cli.maxPagesExplicit) {
    return clampInteger(cli.maxPages || 1, 1, 24);
  }

  if (cli.headful || speedMode === "safe") {
    return null;
  }

  if (speedMode === "turbo") {
    return cpuCount >= 12 ? 12 : 9;
  }

  return cpuCount >= 8 ? 8 : 6;
}

function resolveExecutionProfile(cli, scenarioCount) {
  const cpuCount = Math.max(2, Array.isArray(os.cpus()) ? os.cpus().length : 4);
  const speedMode = normalizeSpeedMode(cli.speedMode);

  let autoProfile;
  if (speedMode === "turbo") {
    autoProfile = resolveTurboExecutionProfile(cli, scenarioCount, cpuCount);
  } else if (speedMode === "fast") {
    autoProfile = resolveFastExecutionProfile(cli, scenarioCount, cpuCount);
  } else {
    autoProfile = resolveSafeExecutionProfile(cli, scenarioCount, cpuCount);
  }

  autoProfile.scenarioConcurrency = clampInteger(
    autoProfile.scenarioConcurrency,
    1,
    Math.min(16, Math.max(1, cpuCount - 1))
  );
  autoProfile.locationConcurrency = clampInteger(autoProfile.locationConcurrency, 1, 6);
  if ((cli.locations || []).length <= 2) {
    autoProfile.locationConcurrency = Math.min(autoProfile.locationConcurrency, 2);
  }

  const maxActivePages = resolveDefaultMaxPages(cli, speedMode, cpuCount);
  if (!cli.scenarioConcurrencyExplicit && !cli.locationConcurrencyExplicit) {
    autoProfile = capActivePages(autoProfile, maxActivePages);
  }

  const scenarioConcurrency = cli.scenarioConcurrencyExplicit
    ? clampInteger(cli.scenarioConcurrency || 1, 1, 16)
    : autoProfile.scenarioConcurrency;
  const locationConcurrency = cli.locationConcurrencyExplicit
    ? clampInteger(cli.locationConcurrency || 1, 1, 6)
    : autoProfile.locationConcurrency;

  return {
    scenarioConcurrency,
    locationConcurrency,
    timeoutMs: cli.timeoutExplicit
      ? clampInteger(cli.timeoutMs || 60_000, 10_000, 180_000)
      : autoProfile.timeoutMs,
    speedMode,
    maxActivePages,
    auto_tuned: {
      speedMode,
      scenarioConcurrency: autoProfile.scenarioConcurrency,
      locationConcurrency: autoProfile.locationConcurrency,
      timeoutMs: autoProfile.timeoutMs,
      maxActivePages
    }
  };
}

function collectCheapestOverallAcrossScenarios(scenarios) {
  let cheapest = null;

  for (const scenario of scenarios) {
    for (const offer of scenario.results || []) {
      if (!cheapest || offer.total_price < cheapest.total_price) {
        cheapest = {
          scenario_id: scenario.scenario_id,
          start_day: scenario.start_day,
          rental_days: scenario.rental_days,
          ...offer
        };
      }
    }
  }

  return cheapest;
}

function buildFallbackSummary(scenarios) {
  const summary = {
    scenarios_with_fallback: 0,
    scenarios_without_fallback: 0,
    by_reason: {}
  };

  for (const scenario of scenarios || []) {
    const execution = scenario?.execution || {};
    if (execution.fallback_used) {
      summary.scenarios_with_fallback += 1;
      const reason = execution.fallback_reason || "unspecified";
      summary.by_reason[reason] = (summary.by_reason[reason] || 0) + 1;
    } else {
      summary.scenarios_without_fallback += 1;
    }
  }

  return summary;
}

function buildMultiScenarioPayload({ scenarios, cli, resolvedProfile }) {
  const flattenedErrors = [];

  for (const scenario of scenarios) {
    for (const error of scenario.errors || []) {
      flattenedErrors.push({
        scenario_id: scenario.scenario_id,
        start_day: scenario.start_day,
        rental_days: scenario.rental_days,
        ...error
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    time_zone: WARSAW_TIME_ZONE,
    locations: cli.locations,
    scenario_mode: cli.scenarioMode,
    start_days: cli.scenarioMode === "weekday" ? cli.startDays : [],
    start_dates: uniqueInOrder(scenarios.map((scenario) => scenario.start_date).filter(Boolean)),
    rolling_days:
      Array.isArray(cli.startDates) && cli.startDates.length
        ? null
        : cli.scenarioMode === "rolling"
          ? cli.rollingDays
          : null,
    rental_day_options: cli.rentalDurations,
    execution_profile: {
      speed_mode: resolvedProfile.speedMode,
      scenario_concurrency: resolvedProfile.scenarioConcurrency,
      location_concurrency: resolvedProfile.locationConcurrency,
      timeout_ms: resolvedProfile.timeoutMs,
      max_active_pages: resolvedProfile.maxActivePages,
      auto_tuned: resolvedProfile.auto_tuned
    },
    scenarios,
    errors: flattenedErrors,
    fallback_summary: buildFallbackSummary(scenarios),
    cheapest_overall: collectCheapestOverallAcrossScenarios(scenarios)
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw).trim()) {
      return null;
    }

    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function timestampForFile() {
  const now = new Date();
  return `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}-${pad2(
    now.getUTCHours()
  )}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}`;
}

function archiveCheckpointFile(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) {
    return;
  }

  const archivedPath = checkpointPath.replace(/\.json$/i, "") + `.stale-${timestampForFile()}.json`;
  ensureParentDir(archivedPath);
  fs.renameSync(checkpointPath, archivedPath);
}

function buildRunSignature(cli, scenarios, resolvedProfile) {
  const canonicalPayload = {
    time_zone: WARSAW_TIME_ZONE,
    scenario_mode: cli.scenarioMode,
    rolling_days: cli.rollingDays,
    start_dates: cli.startDates,
    start_days: cli.startDays,
    rental_durations: cli.rentalDurations,
    locations: (cli.locations || []).map((item) => normalizeLocationKey(item)),
    currency: cli.currency,
    residence_country: cli.residenceCountry,
    strategy: cli.strategy,
    speed_mode: resolvedProfile.speedMode,
    execution_profile: {
      scenario_concurrency: resolvedProfile.scenarioConcurrency,
      location_concurrency: resolvedProfile.locationConcurrency,
      timeout_ms: resolvedProfile.timeoutMs,
      max_active_pages: resolvedProfile.maxActivePages
    },
    direct_candidate_limit: cli.directCandidateLimit,
    direct_offers_wait_ms: cli.directOffersWaitMs,
    scenario_windows: (scenarios || []).map((scenario) => ({
      scenario_id: scenario.scenario_id,
      pickup: scenario.weekend?.pickupIso,
      dropoff: scenario.weekend?.dropoffIso,
      rental_days: scenario.rental_days
    }))
  };

  return crypto.createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex");
}

function createCheckpointController({ enabled, checkpointPath, runSignature, cli, scenarios }) {
  if (!enabled) {
    return {
      enabled: false,
      resumedPayloadsByScenarioId: new Map(),
      resumedCount: 0,
      checkpointPath,
      markScenarioCompleted: async () => {},
      flush: async () => {},
      clear: async () => {}
    };
  }

  if (cli.resetState && fs.existsSync(checkpointPath)) {
    fs.rmSync(checkpointPath, { force: true });
  }

  let state = readJsonSafe(checkpointPath);
  if (!state || state.run_signature !== runSignature) {
    if (state && state.run_signature !== runSignature) {
      archiveCheckpointFile(checkpointPath);
    }

    state = {
      version: 1,
      run_signature: runSignature,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      checkpoint_path: checkpointPath,
      scenario_total: scenarios.length,
      completed: {}
    };
  }

  const resumedPayloadsByScenarioId = new Map();
  for (const scenario of scenarios) {
    const payload = state.completed?.[scenario.scenario_id];
    if (payload && typeof payload === "object") {
      resumedPayloadsByScenarioId.set(scenario.scenario_id, payload);
    }
  }

  let writeQueue = Promise.resolve();

  async function markScenarioCompleted(payload) {
    state.completed[payload.scenario_id] = payload;
    state.updated_at = new Date().toISOString();
    state.completed_count = Object.keys(state.completed).length;

    writeQueue = writeQueue.then(() => writeJsonAtomic(checkpointPath, state));
    await writeQueue;
  }

  async function flush() {
    await writeQueue;
  }

  async function clear() {
    await writeQueue;
    if (fs.existsSync(checkpointPath)) {
      fs.rmSync(checkpointPath, { force: true });
    }
  }

  return {
    enabled: true,
    resumedPayloadsByScenarioId,
    resumedCount: resumedPayloadsByScenarioId.size,
    checkpointPath,
    markScenarioCompleted,
    flush,
    clear
  };
}

function sortResultsByPrice(results) {
  return [...(results || [])].sort((left, right) => Number(left.total_price) - Number(right.total_price));
}

function getSuccessfulLocationKeys(output) {
  const keys = new Set();
  for (const entry of output?.locationBreakdown || []) {
    if (!entry?.location || !entry?.cheapest_offer) {
      continue;
    }
    keys.add(normalizeLocationKey(entry.location));
  }
  return keys;
}

function getMissingLocations(requestedLocations, output) {
  const success = getSuccessfulLocationKeys(output);
  return (requestedLocations || []).filter((location) => !success.has(normalizeLocationKey(location)));
}

function mergeScenarioSearchOutputs({ requestedLocations, primary, fallback }) {
  const breakdownByLocation = new Map();

  for (const entry of primary?.locationBreakdown || []) {
    if (!entry?.location) {
      continue;
    }
    breakdownByLocation.set(normalizeLocationKey(entry.location), entry);
  }

  for (const entry of fallback?.locationBreakdown || []) {
    if (!entry?.location) {
      continue;
    }
    breakdownByLocation.set(normalizeLocationKey(entry.location), entry);
  }

  const primaryErrorsByLocation = new Map(
    (primary?.errors || []).map((item) => [normalizeLocationKey(item.location), item.error])
  );
  const fallbackErrorsByLocation = new Map(
    (fallback?.errors || []).map((item) => [normalizeLocationKey(item.location), item.error])
  );

  const locationBreakdown = [];
  const results = [];
  const errors = [];

  for (const location of requestedLocations || []) {
    const key = normalizeLocationKey(location);
    const breakdown = breakdownByLocation.get(key);

    if (breakdown?.cheapest_offer) {
      locationBreakdown.push(breakdown);
      results.push(breakdown.cheapest_offer);
      continue;
    }

    const errorMessage =
      fallbackErrorsByLocation.get(key) ||
      primaryErrorsByLocation.get(key) ||
      `No offers available for location "${location}".`;

    errors.push({
      location,
      error: errorMessage
    });
  }

  return {
    results: sortResultsByPrice(results),
    errors,
    locationBreakdown
  };
}

async function runScenarioWithFallback({ scenario, cli, logger, quietLegacyLogs }) {
  const baseSearchOptions = {
    weekend: scenario.weekend,
    headful: cli.headful,
    retries: cli.retries,
    timeoutMs: cli.timeoutMs,
    currency: cli.currency,
    residenceCountry: cli.residenceCountry,
    locationConcurrency: cli.locationConcurrency,
    directCandidateLimit: cli.directCandidateLimit,
    directOffersWaitMs: cli.directOffersWaitMs,
    speedMode: cli.speedMode,
    quietLegacyLogs,
    logger
  };

  const primaryStrategy = String(cli.strategy || "legacy-batch").toLowerCase();
  const fallbackStrategy = "legacy-batch";

  const fallbackMeta = {
    primary_strategy: primaryStrategy,
    fallback_strategy: fallbackStrategy,
    fallback_used: false,
    fallback_reason: null,
    fallback_locations: [],
    recovered_locations: [],
    failed_after_fallback: []
  };

  if (primaryStrategy === fallbackStrategy) {
    const output = await searchCheapestOffers({
      ...baseSearchOptions,
      locations: cli.locations,
      strategy: fallbackStrategy
    });

    return {
      ...output,
      fallbackMeta
    };
  }

  let primaryOutput;
  try {
    primaryOutput = await searchCheapestOffers({
      ...baseSearchOptions,
      locations: cli.locations,
      strategy: primaryStrategy
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fallbackMeta.fallback_used = true;
    fallbackMeta.fallback_reason = "primary_strategy_failed";
    fallbackMeta.fallback_locations = [...cli.locations];

    const fallbackOutput = await searchCheapestOffers({
      ...baseSearchOptions,
      locations: cli.locations,
      strategy: fallbackStrategy
    });

    const merged = mergeScenarioSearchOutputs({
      requestedLocations: cli.locations,
      primary: {
        results: [],
        errors: cli.locations.map((location) => ({
          location,
          error: `Primary strategy failed: ${reason}`
        })),
        locationBreakdown: []
      },
      fallback: fallbackOutput
    });

    const recoveredSet = getSuccessfulLocationKeys(merged);
    fallbackMeta.recovered_locations = cli.locations.filter((location) =>
      recoveredSet.has(normalizeLocationKey(location))
    );
    fallbackMeta.failed_after_fallback = cli.locations.filter(
      (location) => !recoveredSet.has(normalizeLocationKey(location))
    );

    return {
      ...merged,
      fallbackMeta
    };
  }

  const missingLocations = getMissingLocations(cli.locations, primaryOutput);
  if (!missingLocations.length) {
    return {
      ...primaryOutput,
      fallbackMeta
    };
  }

  fallbackMeta.fallback_used = true;
  fallbackMeta.fallback_reason = "missing_locations_after_primary";
  fallbackMeta.fallback_locations = [...missingLocations];

  let fallbackOutput;
  try {
    fallbackOutput = await searchCheapestOffers({
      ...baseSearchOptions,
      locations: missingLocations,
      strategy: fallbackStrategy
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fallbackOutput = {
      results: [],
      errors: missingLocations.map((location) => ({
        location,
        error: `Legacy fallback failed: ${reason}`
      })),
      locationBreakdown: []
    };
  }

  const merged = mergeScenarioSearchOutputs({
    requestedLocations: cli.locations,
    primary: primaryOutput,
    fallback: fallbackOutput
  });

  const mergedSuccess = getSuccessfulLocationKeys(merged);
  fallbackMeta.recovered_locations = missingLocations.filter((location) =>
    mergedSuccess.has(normalizeLocationKey(location))
  );
  fallbackMeta.failed_after_fallback = missingLocations.filter(
    (location) => !mergedSuccess.has(normalizeLocationKey(location))
  );

  return {
    ...merged,
    fallbackMeta
  };
}

function printHelp() {
  const help = `
DiscoverCars weekend CLI

Usage:
  node src/index.js
  node src/index.js --headful
  node src/index.js --json
  node src/index.js --save
  node src/index.js --save=output/results.json
  node src/index.js --locations=Warsaw,Krakow
  node src/index.js --pick-durations
  node src/index.js --scenario-mode=rolling --rolling-days=30 --durations=2,3,4,5,6,7,8,9,10
  node src/index.js --start-dates=2026-05-01,2026-05-03 --durations=2,3
  node src/index.js --start-day=thursday --durations=2
  node src/index.js --start-day=both --durations=2,3
  node src/index.js --speed-mode=fast
  node src/index.js --all-date-options

Flags:
  --headful             Run browser with UI.
  --json                Print only JSON payload (without human table/summary logs).
  --pick-durations      Interactive picker for durations (supports values 2..20).
  --durations-prompt    Alias for --pick-durations.
  --verbose             Print per-location attempt logs and fallback diagnostics.
  --save                Save JSON payload to ./results.json.
  --save=PATH           Save JSON payload to selected file path.
  --locations=A,B       Comma-separated list of locations.
  --scenario-mode=MODE  Scenario mode: rolling|weekday|start-dates (default: rolling).
  --start-mode=MODE     Alias for --scenario-mode.
  --rolling-days=N      Number of rolling start dates from tomorrow (default: 30).
  --start-range-days=N  Alias for --rolling-days.
  --start-dates=A,B     Explicit pickup start dates in YYYY-MM-DD format.
                        Example: --start-dates=2026-05-01,2026-05-03
  --start-day=VALUE     Start day for pickup: friday|thursday|both (default: friday).
  --start=VALUE         Alias for --start-day.
  --durations=A,B       Rental duration days list (default: 2..10, supports 2..20). Example: --durations=2,3
                        You can also use slash format: --durations=2/5/10
  --rental-days=A,B     Alias for --durations.
  --all-date-options    Shortcut for --start-day=both --durations=2,3.
  --strategy=VALUE      Extraction mode: legacy-batch|hybrid|direct-only (default: legacy-batch).
  --speed-mode=VALUE    Speed profile: safe|fast|turbo (default: safe).
                        safe keeps the previous stable timing profile.
                        fast uses higher concurrency and shorter waits.
                        turbo is more aggressive and can fail more often on slow network.
  --fast                Alias for --speed-mode=fast.
  --turbo               Alias for --speed-mode=turbo.
  --safe-speed          Alias for --speed-mode=safe.
  --max-pages=N|auto    Cap active browser pages in fast/turbo mode. Default: auto.
  --scenario-concurrency=N|auto
                        Parallel scenarios. Default: auto.
  --concurrency=N|auto  Alias for --scenario-concurrency.
  --location-concurrency=N|auto
                        Parallel location workers per scenario. Default: auto.
  --timeout=MS|auto     Per-page timeout. Default: auto.
  --direct-candidate-limit=N
                        Max direct-search location candidates in legacy flow (default: 2, max: 8).
  --direct-offers-wait=MS
                        Max wait for direct-flow offers in legacy flow (default: 6000, max: 20000).
  --retries=N           Retry count per location (default: 1).
  --resume              Enable resume from checkpoint (default).
  --no-resume           Disable checkpoint resume for this run.
  --checkpoint=PATH     Custom checkpoint file path (default: output/state.json).
  --reset-state         Remove previous checkpoint before run.
  --help, -h            Show this help.
`;

  process.stdout.write(help.trimStart());
}

function readLineQuestion(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function chooseDurationsInteractively(currentDurations) {
  const current =
    Array.isArray(currentDurations) && currentDurations.length
      ? [...currentDurations]
      : [...DEFAULT_RENTAL_DURATIONS];

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return current;
  }

  console.log("Wybierz durations (dni najmu) z zakresu 2-20.");
  console.log(`Aktualny zestaw: ${current.join("/")}`);
  console.log("Przyklady: 2  lub  2/5/10  lub  2,5,10");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rawAnswer = await readLineQuestion("Durations (Enter = bez zmian): ");
    const trimmed = String(rawAnswer || "").trim();
    if (!trimmed) {
      return current;
    }

    const parsed = parseRentalDurations(trimmed);
    if (parsed.length) {
      console.log(`Wybrane durations: ${parsed.join("/")}`);
      return parsed;
    }

    console.log("Niepoprawny format. Wpisz np. 2 lub 2/5/10.");
  }

  console.log("Uzywam aktualnego zestawu durations.");
  return current;
}

async function main() {
  const runStartedAtMs = Date.now();
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.invalidStartDatesInput) {
    throw new Error(
      `Invalid --start-dates value "${cli.invalidStartDatesInput}". Use YYYY-MM-DD list, e.g. --start-dates=2026-05-01,2026-05-03`
    );
  }

  if (cli.pickDurations) {
    cli.rentalDurations = await chooseDurationsInteractively(cli.rentalDurations);
  }

  if (Array.isArray(cli.startDates) && cli.startDates.length) {
    cli.scenarioMode = "start-dates";
  }
  if (cli.scenarioMode === "start-dates" && (!Array.isArray(cli.startDates) || !cli.startDates.length)) {
    throw new Error("Scenario mode 'start-dates' requires at least one date in --start-dates=YYYY-MM-DD,...");
  }

  const scenarios = buildScenarioDefinitions(cli);
  const resolvedProfile = resolveExecutionProfile(cli, scenarios.length);

  cli.scenarioConcurrency = resolvedProfile.scenarioConcurrency;
  cli.locationConcurrency = resolvedProfile.locationConcurrency;
  cli.timeoutMs = resolvedProfile.timeoutMs;
  cli.speedMode = resolvedProfile.speedMode;

  const runSignature = buildRunSignature(cli, scenarios, resolvedProfile);
  const checkpointController = createCheckpointController({
    enabled: cli.resume,
    checkpointPath: cli.checkpointPath,
    runSignature,
    cli,
    scenarios
  });

  const logger = cli.jsonOnly
    ? {
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    : cli.verbose
      ? console
      : {
          info: () => {},
          warn: () => {},
          error: () => {}
        };

  const scenarioPayloads = [];
  const payloadBuffer = new Array(scenarios.length).fill(null);
  const pendingScenarioIndices = [];

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const resumedPayload = checkpointController.resumedPayloadsByScenarioId.get(scenario.scenario_id);
    if (resumedPayload) {
      payloadBuffer[index] = resumedPayload;
      continue;
    }
    pendingScenarioIndices.push(index);
  }

  const boundedConcurrency = Math.max(
    1,
    Math.min(cli.scenarioConcurrency || 1, pendingScenarioIndices.length || 1, 16)
  );
  let nextPendingIndex = 0;

  const executeScenarioAtIndex = async (scenarioIndex) => {
    const scenario = scenarios[scenarioIndex];

    try {
      const executionOutput = await runScenarioWithFallback({
        scenario,
        cli,
        logger,
        quietLegacyLogs: cli.jsonOnly || !cli.verbose
      });

      const scenarioPayload = buildOutputPayload({
        results: executionOutput.results,
        errors: executionOutput.errors,
        locationBreakdown: executionOutput.locationBreakdown,
        locations: cli.locations,
        weekend: scenario.weekend
      });

      scenarioPayload.scenario_id = scenario.scenario_id;
      scenarioPayload.start_day = scenario.start_day;
      scenarioPayload.start_day_label = scenario.start_day_label;
      scenarioPayload.start_date = scenario.start_date || null;
      scenarioPayload.rental_days = scenario.rental_days;
      scenarioPayload.execution = executionOutput.fallbackMeta || null;
      payloadBuffer[scenarioIndex] = scenarioPayload;

      try {
        await checkpointController.markScenarioCompleted(scenarioPayload);
      } catch (stateError) {
        logger.warn(
          `[checkpoint] Unable to save scenario ${scenario.scenario_id}: ${
            stateError instanceof Error ? stateError.message : String(stateError)
          }`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const scenarioPayload = buildOutputPayload({
        results: [],
        errors: cli.locations.map((location) => ({
          location,
          error: `Scenario failed: ${message}`
        })),
        locationBreakdown: [],
        locations: cli.locations,
        weekend: scenario.weekend
      });

      scenarioPayload.scenario_id = scenario.scenario_id;
      scenarioPayload.start_day = scenario.start_day;
      scenarioPayload.start_day_label = scenario.start_day_label;
      scenarioPayload.start_date = scenario.start_date || null;
      scenarioPayload.rental_days = scenario.rental_days;
      scenarioPayload.execution = {
        primary_strategy: cli.strategy,
        fallback_used: false,
        fallback_reason: "fatal_scenario_error",
        fallback_locations: [],
        recovered_locations: [],
        failed_after_fallback: [...cli.locations]
      };
      payloadBuffer[scenarioIndex] = scenarioPayload;

      try {
        await checkpointController.markScenarioCompleted(scenarioPayload);
      } catch {
        // ignore checkpoint write error for failed scenario
      }
    }
  };

  const workers = Array.from({ length: boundedConcurrency }, async () => {
    while (true) {
      const queuePos = nextPendingIndex;
      nextPendingIndex += 1;
      if (queuePos >= pendingScenarioIndices.length) {
        return;
      }

      const scenarioIndex = pendingScenarioIndices[queuePos];
      await executeScenarioAtIndex(scenarioIndex);
    }
  });

  await Promise.all(workers);
  await checkpointController.flush();

  scenarioPayloads.push(...payloadBuffer.filter(Boolean));

  if (!cli.jsonOnly) {
    for (let index = 0; index < payloadBuffer.length; index += 1) {
      const scenarioPayload = payloadBuffer[index];
      if (!scenarioPayload) {
        continue;
      }

      console.log("=".repeat(96));
      console.log(
        `[Scenario ${index + 1}/${payloadBuffer.length}] ${scenarioPayload.start_day_label} + ${scenarioPayload.rental_days} day(s)`
      );
      console.log(
        `Period: ${scenarioPayload.pickup_date} -> ${scenarioPayload.dropoff_date} (rental_days=${scenarioPayload.rental_days})`
      );
      printCompactScenarioTable(scenarioPayload, cli.locations);
      if ((scenarioPayload.errors || []).length) {
        const errorText = scenarioPayload.errors
          .map((item) => `${item.location}: ${item.error}`)
          .join(" | ");
        console.log(`Errors: ${errorText}`);
      }
      console.log("");
    }
  }

  const resultsShownAtMs = Date.now();
  const executionDurationMs = resultsShownAtMs - runStartedAtMs;
  const executionDurationSeconds = Number((executionDurationMs / 1000).toFixed(3));
  const executionDurationLabel = formatDurationLabel(executionDurationMs);

  const payload =
    scenarioPayloads.length === 1
      ? scenarioPayloads[0]
      : buildMultiScenarioPayload({
          scenarios: scenarioPayloads,
          cli,
          resolvedProfile
        });

  if (!payload.execution_profile) {
    payload.execution_profile = {
      speed_mode: resolvedProfile.speedMode,
      scenario_concurrency: resolvedProfile.scenarioConcurrency,
      location_concurrency: resolvedProfile.locationConcurrency,
      timeout_ms: resolvedProfile.timeoutMs,
      max_active_pages: resolvedProfile.maxActivePages,
      auto_tuned: resolvedProfile.auto_tuned
    };
  }

  payload.execution_duration_ms = executionDurationMs;
  payload.execution_duration_seconds = executionDurationSeconds;

  if (cli.jsonOnly) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }

  if (cli.savePath) {
    const savedPath = savePayloadToFile(payload, cli.savePath);
    if (!cli.jsonOnly) {
      console.log(`Saved JSON to ${savedPath}`);
    }
  }

  const completedAllScenarios = payloadBuffer.every(Boolean);
  if (completedAllScenarios && checkpointController.enabled) {
    await checkpointController.clear();
  }

  if (!cli.jsonOnly) {
    console.log(`Total execution time (start -> results): ${executionDurationLabel} (${executionDurationMs} ms)`);
  }

  const hasAnyResults = scenarioPayloads.some((scenario) => (scenario.results || []).length > 0);
  if (!hasAnyResults) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal error: ${message}`);
  process.exitCode = 1;
});
