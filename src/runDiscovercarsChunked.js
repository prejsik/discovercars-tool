const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { isChunkPayloadComplete, resolveGlobalConcurrency } = require("./executionPolicy");
const { mergePayloads } = require("./mergeDiscovercarsResults");
const { WARSAW_TIME_ZONE, addDaysToDateParts, getZonedDateParts } = require("./dateUtils");
const { getDailyLocations } = require("./locationRegistry");

const DEFAULT_LOCATIONS = getDailyLocations();

const DEFAULT_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const DEFAULT_CHUNK_STALL_TIMEOUT_MS = 10 * 60 * 1000;

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumberList(value, fallback) {
  const values = parseList(value)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isFinite(item));
  return values.length ? values : fallback;
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function buildRollingStartDates(rollingDays, timeZone = WARSAW_TIME_ZONE) {
  const nowParts = getZonedDateParts(new Date(), timeZone);
  const tomorrow = addDaysToDateParts(nowParts, 1);
  const dates = [];

  for (let offset = 0; offset < rollingDays; offset += 1) {
    dates.push(formatDateParts(addDaysToDateParts(tomorrow, offset)));
  }

  return dates;
}

function parseIsoDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date: ${value}`);
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (dateToIso(date) !== text) {
    throw new Error(`Invalid date: ${value}`);
  }
  return date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function expandDateRange(startDate, endDate) {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  if (start > end) {
    throw new Error(`Start date must be on or before end date: ${startDate} > ${endDate}`);
  }

  const dates = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(dateToIso(cursor));
  }
  return dates;
}

function monthToDateRange(month) {
  const match = String(month || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid month: ${month}. Use YYYY-MM.`);
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  return { startDate: dateToIso(start), endDate: dateToIso(end) };
}

function chunkDates(dates, chunkDays) {
  const chunks = [];
  for (let index = 0; index < dates.length; index += chunkDays) {
    chunks.push(dates.slice(index, index + chunkDays));
  }
  return chunks;
}

function parseArgs(argv) {
  const options = {
    outputDir: path.resolve("output", `discovercars-chunked-${timestampForPath()}`),
    locations: DEFAULT_LOCATIONS,
    durations: DEFAULT_DURATIONS,
    chunkDays: 7,
    chunkConcurrency: 2,
    speedMode: "fast",
    strategy: "legacy-batch",
    retries: 0,
    chunkRetries: 1,
    chunkStallTimeoutMs: DEFAULT_CHUNK_STALL_TIMEOUT_MS,
    scenarioConcurrency: 2,
    locationConcurrency: 3,
    maxActivePages: 8,
    timeout: "auto",
    directCandidateLimit: 2,
    directOffersWait: 1000,
    apiFirst: true,
    apiDomSanityRate: 0.05,
    resetState: false,
    continueOnError: false,
    skipPostprocess: false,
    dryRun: false,
    pricingConfig: "pricing-rules.config.example.json",
    excelConfig: "excel-rate-update.config.example.json",
    python: process.env.PYTHON || "python"
  };

  for (const arg of argv) {
    if (arg === "--reset-state") {
      options.resetState = true;
      continue;
    }
    if (arg === "--continue-on-error") {
      options.continueOnError = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--skip-postprocess") {
      options.skipPostprocess = true;
      continue;
    }
    if (arg.startsWith("--month=")) {
      const range = monthToDateRange(arg.slice("--month=".length));
      options.startDate = range.startDate;
      options.endDate = range.endDate;
      continue;
    }
    if (arg.startsWith("--start-date=") || arg.startsWith("--start=")) {
      options.startDate = arg.slice(arg.indexOf("=") + 1);
      continue;
    }
    if (arg.startsWith("--end-date=") || arg.startsWith("--end=")) {
      options.endDate = arg.slice(arg.indexOf("=") + 1);
      continue;
    }
    if (arg.startsWith("--start-dates=")) {
      options.startDates = parseList(arg.slice("--start-dates=".length));
      continue;
    }
    if (arg.startsWith("--rolling-days=") || arg.startsWith("--start-range-days=")) {
      options.rollingDays = parseInteger(arg.slice(arg.indexOf("=") + 1), undefined, 1, 365);
      continue;
    }
    if (arg.startsWith("--locations=")) {
      options.locations = parseList(arg.slice("--locations=".length));
      continue;
    }
    if (arg.startsWith("--durations=")) {
      options.durations = parseNumberList(arg.slice("--durations=".length), DEFAULT_DURATIONS);
      continue;
    }
    if (arg.startsWith("--output-dir=")) {
      options.outputDir = path.resolve(arg.slice("--output-dir=".length));
      continue;
    }
    if (arg.startsWith("--chunk-days=")) {
      options.chunkDays = parseInteger(arg.slice("--chunk-days=".length), options.chunkDays, 1, 31);
      continue;
    }
    if (arg.startsWith("--chunk-concurrency=")) {
      options.chunkConcurrency = parseInteger(arg.slice("--chunk-concurrency=".length), options.chunkConcurrency, 1, 8);
      continue;
    }
    if (arg.startsWith("--speed-mode=")) {
      options.speedMode = arg.slice("--speed-mode=".length);
      continue;
    }
    if (arg.startsWith("--strategy=")) {
      options.strategy = arg.slice("--strategy=".length);
      continue;
    }
    if (arg.startsWith("--retries=")) {
      options.retries = parseInteger(arg.slice("--retries=".length), options.retries, 0, 5);
      continue;
    }
    if (arg.startsWith("--chunk-retries=")) {
      options.chunkRetries = parseInteger(arg.slice("--chunk-retries=".length), options.chunkRetries, 0, 3);
      continue;
    }
    if (arg.startsWith("--chunk-stall-timeout=")) {
      options.chunkStallTimeoutMs = parseInteger(
        arg.slice("--chunk-stall-timeout=".length),
        options.chunkStallTimeoutMs,
        30_000,
        2 * 60 * 60 * 1000
      );
      continue;
    }
    if (arg.startsWith("--scenario-concurrency=")) {
      options.scenarioConcurrency = parseInteger(arg.slice("--scenario-concurrency=".length), options.scenarioConcurrency, 1, 16);
      continue;
    }
    if (arg.startsWith("--location-concurrency=")) {
      options.locationConcurrency = parseInteger(arg.slice("--location-concurrency=".length), options.locationConcurrency, 1, 6);
      continue;
    }
    if (arg.startsWith("--max-active-pages=")) {
      options.maxActivePages = parseInteger(arg.slice("--max-active-pages=".length), options.maxActivePages, 1, 24);
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      options.timeout = arg.slice("--timeout=".length);
      continue;
    }
    if (arg.startsWith("--direct-candidate-limit=")) {
      options.directCandidateLimit = parseInteger(arg.slice("--direct-candidate-limit=".length), options.directCandidateLimit, 1, 8);
      continue;
    }
    if (arg.startsWith("--direct-offers-wait=")) {
      options.directOffersWait = parseInteger(arg.slice("--direct-offers-wait=".length), options.directOffersWait, 1000, 20000);
      continue;
    }
    if (arg === "--api-first") {
      options.apiFirst = true;
      continue;
    }
    if (arg === "--no-api-first") {
      options.apiFirst = false;
      continue;
    }
    if (arg.startsWith("--api-dom-sanity-rate=")) {
      const rate = Number.parseFloat(arg.slice("--api-dom-sanity-rate=".length));
      if (Number.isFinite(rate) && rate >= 0 && rate <= 1) {
        options.apiDomSanityRate = rate;
      }
      continue;
    }
    if (arg.startsWith("--workbook=")) {
      options.workbook = path.resolve(arg.slice("--workbook=".length));
      continue;
    }
    if (arg.startsWith("--calibration=")) {
      options.calibration = path.resolve(arg.slice("--calibration=".length));
      continue;
    }
    if (arg.startsWith("--pricing-config=")) {
      options.pricingConfig = arg.slice("--pricing-config=".length);
      continue;
    }
    if (arg.startsWith("--excel-config=")) {
      options.excelConfig = arg.slice("--excel-config=".length);
      continue;
    }
    if (arg.startsWith("--python=")) {
      options.python = arg.slice("--python=".length);
    }
  }

  if (!options.startDates?.length) {
    if (options.rollingDays) {
      options.startDates = buildRollingStartDates(options.rollingDays, WARSAW_TIME_ZONE);
    } else if (options.startDate && options.endDate) {
      options.startDates = expandDateRange(options.startDate, options.endDate);
    } else {
      throw new Error(
        "Pass --month=YYYY-MM, --start-date=YYYY-MM-DD --end-date=YYYY-MM-DD, --rolling-days=N, or --start-dates=..."
      );
    }
  }

  return options;
}

function getModifiedTimeMs(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return 0;
  }
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function terminateProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill("SIGKILL"));
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }

  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  forceTimer.unref();
}

function runCommand(command, args, {
  cwd,
  logPath,
  label,
  progressPath,
  stallTimeoutMs = 0,
  progressCheckIntervalMs = 30_000
}) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n[${new Date().toISOString()}] ${label}: ${command} ${args.join(" ")}\n`);

    let finished = false;
    let forcedError = null;
    let lastProgressAt = Date.now();
    let lastProgressMtime = getModifiedTimeMs(progressPath);

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: Boolean(stallTimeoutMs) && process.platform !== "win32"
    });

    const recordOutput = (chunk) => {
      lastProgressAt = Date.now();
      logStream.write(chunk);
    };
    child.stdout.on("data", recordOutput);
    child.stderr.on("data", recordOutput);

    const watchdog = stallTimeoutMs > 0
      ? setInterval(() => {
          const currentMtime = getModifiedTimeMs(progressPath);
          if (currentMtime > lastProgressMtime) {
            lastProgressMtime = currentMtime;
            lastProgressAt = Date.now();
          }
          if (forcedError || Date.now() - lastProgressAt < stallTimeoutMs) {
            return;
          }

          forcedError = new Error(`${label} made no progress for ${Math.round(stallTimeoutMs / 1000)} seconds`);
          logStream.write(`[${new Date().toISOString()}] ${forcedError.message}; terminating process tree\n`);
          terminateProcessTree(child);
        }, Math.max(25, progressCheckIntervalMs))
      : null;
    watchdog?.unref();

    const finish = (error) => {
      if (finished) {
        return;
      }
      finished = true;
      if (watchdog) {
        clearInterval(watchdog);
      }
      logStream.end();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }
      logStream.write(`[${new Date().toISOString()}] ${label} exited with code ${code}\n`);
      if (code === 0) {
        finish();
      } else {
        finish(forcedError || new Error(`${label} failed with exit code ${code}`));
      }
    });
  });
}

function buildChunk(index, dates, outputDir) {
  const label = `chunk-${String(index + 1).padStart(2, "0")}-${dates[0]}-${dates[dates.length - 1]}`;
  const dir = path.join(outputDir, label);
  return {
    label,
    dir,
    dates,
    resultsPath: path.join(dir, "results-latest.json"),
    checkpointPath: path.join(dir, "state.json"),
    logPath: path.join(dir, "run-log.txt")
  };
}

function buildScraperArgs(chunk, options, attempt = 0) {
  const args = [
    path.join("src", "index.js"),
    `--save=${chunk.resultsPath}`,
    `--locations=${options.locations.join(",")}`,
    `--start-dates=${chunk.dates.join(",")}`,
    `--durations=${options.durations.join(",")}`,
    `--strategy=${options.strategy}`,
    `--speed-mode=${options.speedMode}`,
    `--scenario-concurrency=${options.scenarioConcurrency}`,
    `--location-concurrency=${options.locationConcurrency}`,
    `--timeout=${options.timeout}`,
    `--retries=${options.retries}`,
    `--checkpoint=${chunk.checkpointPath}`,
    `--direct-candidate-limit=${options.directCandidateLimit}`,
    `--direct-offers-wait=${options.directOffersWait}`,
    `--api-dom-sanity-rate=${options.apiDomSanityRate}`
  ];

  args.push(options.apiFirst ? "--api-first" : "--no-api-first");

  if (options.resetState && attempt === 0) {
    args.push("--reset-state");
  }

  return args;
}

async function runChunk(chunk, options) {
  fs.mkdirSync(chunk.dir, { recursive: true });
  for (let attempt = 0; attempt <= options.chunkRetries; attempt += 1) {
    try {
      await runCommand(process.execPath, buildScraperArgs(chunk, options, attempt), {
        cwd: process.cwd(),
        logPath: chunk.logPath,
        label: attempt === 0 ? chunk.label : `${chunk.label}-resume-${attempt}`,
        progressPath: chunk.checkpointPath,
        stallTimeoutMs: options.chunkStallTimeoutMs
      });
      break;
    } catch (error) {
      if (attempt >= options.chunkRetries) {
        throw error;
      }
      console.warn(`Retrying ${chunk.label} from checkpoint after: ${error.message}`);
    }
  }
  return chunk.resultsPath;
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

function readExistingChunkResults(chunks) {
  return chunks
    .map((chunk) => chunk.resultsPath)
    .filter((resultPath) => fs.existsSync(resultPath));
}

function hasCompleteChunkResults(resultsPath, chunk, options) {
  if (!fs.existsSync(resultsPath)) {
    return false;
  }
  try {
    return isChunkPayloadComplete(JSON.parse(fs.readFileSync(resultsPath, "utf8")), {
      startDates: chunk.dates,
      durations: options.durations,
      locations: options.locations
    });
  } catch {
    return false;
  }
}

async function runOptionalPipeline(options, mergedPath) {
  const reportPath = path.join(options.outputDir, "report.html");
  const pricingPath = path.join(options.outputDir, "pricing-recommendations.json");
  const finalPricingPath = path.join(options.outputDir, "final-pricing-recommendations.json");
  const excelPath = path.join(options.outputDir, "rates-updated.xlsx");
  const importPath = path.join(options.outputDir, "rates-import-ready.xlsx");

  await runCommand(process.execPath, [path.join("src", "reportHtml.js"), mergedPath, reportPath], {
    cwd: process.cwd(),
    logPath: path.join(options.outputDir, "postprocess-log.txt"),
    label: "report"
  });

  const pricingArgs = [
    path.join("src", "pricingRecommendations.js"),
    mergedPath,
    pricingPath,
    `--config=${options.pricingConfig}`
  ];
  if (options.calibration) {
    pricingArgs.push(`--calibration=${options.calibration}`);
  }
  await runCommand(process.execPath, pricingArgs, {
    cwd: process.cwd(),
    logPath: path.join(options.outputDir, "postprocess-log.txt"),
    label: "pricing-recommendations"
  });
  fs.copyFileSync(pricingPath, finalPricingPath);

  if (options.workbook) {
    await runCommand(
      options.python,
      [
        path.join("tools", "update_excel_rates.py"),
        "--workbook",
        options.workbook,
        "--recommendations",
        finalPricingPath,
        "--config",
        options.excelConfig,
        "--output",
        excelPath,
        "--import-output",
        importPath
      ],
      {
        cwd: process.cwd(),
        logPath: path.join(options.outputDir, "postprocess-log.txt"),
        label: "excel"
      }
    );
  }

  return {
    reportPath,
    pricingPath,
    finalPricingPath,
    excelPath: options.workbook ? excelPath : null,
    importPath: options.workbook ? importPath : null
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const concurrencyProfile = resolveGlobalConcurrency(options);
  const runOptions = {
    ...options,
    chunkConcurrency: concurrencyProfile.chunkConcurrency,
    scenarioConcurrency: concurrencyProfile.scenarioConcurrency,
    locationConcurrency: concurrencyProfile.locationConcurrency
  };
  const dateChunks = chunkDates(options.startDates, options.chunkDays);
  const chunks = dateChunks.map((dates, index) => buildChunk(index, dates, options.outputDir));

  if (options.dryRun) {
    console.log(JSON.stringify({ outputDir: options.outputDir, chunks, concurrencyProfile }, null, 2));
    return;
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  console.log(
    `Running ${chunks.length} chunks with concurrency `
    + `${concurrencyProfile.chunkConcurrency} chunks x ${concurrencyProfile.scenarioConcurrency} scenarios x `
    + `${concurrencyProfile.locationConcurrency} locations = ${concurrencyProfile.activePageLimit}/${concurrencyProfile.maxActivePages} active pages.`
  );
  for (const chunk of chunks) {
    console.log(`- ${chunk.label}: ${chunk.dates.join(",")}`);
  }

  const failed = [];
  await runPool(chunks, concurrencyProfile.chunkConcurrency, async (chunk) => {
    if (hasCompleteChunkResults(chunk.resultsPath, chunk, options) && !options.resetState) {
      console.log(`Skipping completed ${chunk.label}`);
      return chunk.resultsPath;
    }
    try {
      console.log(`Starting ${chunk.label}`);
      await runChunk(chunk, runOptions);
      console.log(`Completed ${chunk.label}`);
      return chunk.resultsPath;
    } catch (error) {
      failed.push({ chunk: chunk.label, error: error instanceof Error ? error.message : String(error) });
      console.error(`Failed ${chunk.label}: ${failed[failed.length - 1].error}`);
      if (!options.continueOnError) {
        throw error;
      }
      return null;
    }
  });

  const resultFiles = readExistingChunkResults(chunks);
  if (!resultFiles.length) {
    throw new Error("No chunk result files were produced.");
  }

  const payloads = resultFiles.map((resultPath) => JSON.parse(fs.readFileSync(resultPath, "utf8")));
  const merged = mergePayloads(payloads, resultFiles);
  merged.chunk_failures = failed;
  if (failed.length) {
    merged.run_status = "degraded";
  }
  const mergedPath = path.join(options.outputDir, "results-latest.json");
  fs.writeFileSync(mergedPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  const postprocess = options.skipPostprocess
    ? {}
    : await runOptionalPipeline(options, mergedPath);
  console.log(
    JSON.stringify(
      {
        output_dir: options.outputDir,
        merged_results: mergedPath,
        scenario_count: merged.scenarios.length,
        failed,
        ...postprocess
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildRollingStartDates,
  chunkDates,
  expandDateRange,
  parseArgs,
  runCommand,
  resolveGlobalConcurrency
};
