const fs = require("fs");
const path = require("path");
const {
  makeTimestampForFile,
  normalizeWhitespace,
  parseDate,
  parseTime,
  uniqueStrings
} = require("./utils");

function parseCliArgs(argv) {
  const args = {
    locations: [],
    durationDays: [],
    pickupWeekdays: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);

    if (key === "headed") {
      args.headless = false;
      continue;
    }

    if (key === "headless") {
      args.headless = true;
      continue;
    }

    if (key === "help") {
      args.help = true;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue == null || nextValue.startsWith("--")) {
      throw new Error(`Missing value for argument: ${token}`);
    }

    index += 1;

    if (key === "location") {
      args.locations.push(nextValue);
      continue;
    }

    if (key === "locations") {
      args.locations.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    if (key === "duration-days") {
      args.durationDays.push(nextValue);
      continue;
    }

    if (key === "durations-days") {
      args.durationDays.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    if (key === "pickup-weekday") {
      args.pickupWeekdays.push(nextValue);
      continue;
    }

    if (key === "pickup-weekdays") {
      args.pickupWeekdays.push(
        ...nextValue.split(",").map((item) => item.trim()).filter(Boolean)
      );
      continue;
    }

    args[key] = nextValue;
  }

  return args;
}

function parseDurationDaysInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }

  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");

  const values = [];
  for (const part of parts) {
    const normalized = normalizeWhitespace(part);
    if (!normalized) {
      continue;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(`${fieldName} must contain positive integers. Received: ${part}`);
    }

    values.push(parsed);
  }

  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeDayToken(rawValue) {
  return String(rawValue ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parsePickupWeekdaysInput(rawValue, fieldName) {
  if (rawValue == null) {
    return [];
  }

  const parts = Array.isArray(rawValue)
    ? rawValue.flatMap((item) => String(item).split(","))
    : String(rawValue).split(",");

  const dayMapping = new Map([
    ["sunday", 0],
    ["sun", 0],
    ["niedziela", 0],
    ["monday", 1],
    ["mon", 1],
    ["poniedzialek", 1],
    ["pon", 1],
    ["tuesday", 2],
    ["tue", 2],
    ["wtorek", 2],
    ["wt", 2],
    ["wednesday", 3],
    ["wed", 3],
    ["sroda", 3],
    ["sr", 3],
    ["thursday", 4],
    ["thu", 4],
    ["thurs", 4],
    ["czwartek", 4],
    ["czw", 4],
    ["friday", 5],
    ["fri", 5],
    ["piatek", 5],
    ["pt", 5],
    ["saturday", 6],
    ["sat", 6],
    ["sobota", 6],
    ["sob", 6]
  ]);

  const weekdays = [];
  for (const part of parts) {
    const normalized = normalizeDayToken(part);
    if (!normalized) {
      continue;
    }

    if (/^[0-6]$/.test(normalized)) {
      weekdays.push(Number.parseInt(normalized, 10));
      continue;
    }

    const dayNumber = dayMapping.get(normalized);
    if (dayNumber == null) {
      throw new Error(`${fieldName} contains unsupported day: ${part}`);
    }
    weekdays.push(dayNumber);
  }

  return [...new Set(weekdays)];
}

function addDaysToDate(date, daysToAdd) {
  const clone = new Date(date.getTime());
  clone.setDate(clone.getDate() + daysToAdd);
  return clone;
}

function nearestWeekdayDateFromNow(targetWeekday) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (targetWeekday - today.getDay() + 7) % 7;
  return addDaysToDate(today, offset);
}

function toIsoLocalDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function loadConfig(argv) {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    return { help: true };
  }

  let fileConfig = {};
  if (cli.config) {
    const configPath = path.resolve(cli.config);
    fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fileConfig.__configPath = configPath;
  }

  const merged = {
    ...fileConfig,
    ...cli
  };

  const locations = uniqueStrings([
    ...(Array.isArray(fileConfig.locations) ? fileConfig.locations : []),
    ...(cli.locations || [])
  ]);

  const pickupDate = merged.pickupDate ?? merged["pickup-date"];
  const pickupTime = merged.pickupTime ?? merged["pickup-time"];
  const dropoffDate = merged.dropoffDate ?? merged["dropoff-date"];
  const dropoffTime = merged.dropoffTime ?? merged["dropoff-time"];

  if (!locations.length) {
    throw new Error("At least one location is required. Use --location or provide locations in the config file.");
  }
  if (!pickupDate || !pickupTime || !dropoffDate || !dropoffTime) {
    throw new Error("pickupDate, pickupTime, dropoffDate, and dropoffTime are required.");
  }

  const parsedPickupDate = parseDate(pickupDate, "pickupDate");
  const parsedDropoffDate = parseDate(dropoffDate, "dropoffDate");
  parseTime(pickupTime, "pickupTime");
  parseTime(dropoffTime, "dropoffTime");

  const pickupStamp = new Date(`${pickupDate}T${pickupTime}:00`);
  const dropoffStamp = new Date(`${dropoffDate}T${dropoffTime}:00`);
  if (!(pickupStamp < dropoffStamp)) {
    throw new Error("Drop-off date/time must be after pick-up date/time.");
  }

  const configuredDurations = parseDurationDaysInput([
    ...(parseDurationDaysInput(
      fileConfig.durationsDays
      ?? fileConfig["durations-days"]
      ?? fileConfig.durationDays
      ?? fileConfig["duration-days"],
      "durationsDays"
    )),
    ...(parseDurationDaysInput(cli.durationDays, "duration-days"))
  ], "durationsDays");

  const defaultDurationDays = Math.round((dropoffStamp.getTime() - pickupStamp.getTime()) / (24 * 60 * 60 * 1000));
  const durationDays = configuredDurations.length
    ? configuredDurations
    : [defaultDurationDays];

  const configuredPickupWeekdays = [...new Set([
    ...parsePickupWeekdaysInput(
      fileConfig.pickupWeekdays
      ?? fileConfig["pickup-weekdays"],
      "pickupWeekdays"
    ),
    ...parsePickupWeekdaysInput(cli.pickupWeekdays, "pickup-weekdays")
  ])];

  const pickupDateOptions = configuredPickupWeekdays.length
    ? configuredPickupWeekdays
      .map((weekday) => toIsoLocalDate(nearestWeekdayDateFromNow(weekday)))
      .sort()
    : [parsedPickupDate.raw];

  const defaultCsvName = `discovercars-results-${makeTimestampForFile()}.csv`;

  return {
    baseUrl: normalizeWhitespace(merged.baseUrl || "https://www.discovercars.com"),
    locations,
    pickupDate: parsedPickupDate.raw,
    pickupDateOptions,
    pickupTime: normalizeWhitespace(pickupTime),
    dropoffDate: parsedDropoffDate.raw,
    dropoffTime: normalizeWhitespace(dropoffTime),
    durationDays,
    residenceCountry: normalizeWhitespace(merged.residenceCountry || merged["residence-country"] || "Poland"),
    driverAge: Number.parseInt(merged.driverAge || merged["driver-age"] || "30", 10),
    maxProvidersPerLocation: Number.parseInt(
      merged.maxProvidersPerLocation || merged["max-providers-per-location"] || "25",
      10
    ),
    timeoutMs: Number.parseInt(merged.timeoutMs || merged["timeout-ms"] || "45000", 10),
    headless: merged.headless !== false,
    browserExecutablePath: normalizeWhitespace(
      merged.browserExecutablePath || merged["browser-executable-path"] || ""
    ) || null,
    outputCsv: path.resolve(merged.outputCsv || merged["output-csv"] || path.join("output", defaultCsvName)),
    artifactsDir: path.resolve(merged.artifactsDir || merged["artifacts-dir"] || path.join("artifacts", "discovercars")),
    configPath: fileConfig.__configPath || null
  };
}

function printHelp() {
  const message = `
DiscoverCars scraper

Usage:
  node .\\src\\discovercars\\cli.js --config .\\discovercars.config.example.json

  node .\\src\\discovercars\\cli.js ^
    --location "Warsaw" ^
    --location "Krakow" ^
    --pickup-date 2026-05-15 ^
    --pickup-time 10:00 ^
    --dropoff-date 2026-05-18 ^
    --dropoff-time 10:00

Options:
  --config PATH
  --location TEXT              Repeatable
  --locations "A,B,C"         Comma-separated shortcut
  --pickup-date YYYY-MM-DD
  --pickup-time HH:MM
  --dropoff-date YYYY-MM-DD
  --dropoff-time HH:MM
  --pickup-weekdays "thursday,friday"
  --pickup-weekday DAY        Repeatable shortcut
  --durations-days "2,3,4"    Multiple rental lengths in days
  --duration-days NUMBER       Repeatable shortcut
  --max-providers-per-location NUMBER
  --residence-country TEXT
  --driver-age NUMBER
  --output-csv PATH
  --artifacts-dir PATH
  --browser-executable-path PATH
  --timeout-ms NUMBER
  --headed
  --help
`;

  process.stdout.write(message.trimStart());
}

module.exports = {
  loadConfig,
  printHelp
};
