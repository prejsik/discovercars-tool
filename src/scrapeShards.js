const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { validateScrapeScope } = require("./scrapeScope");
const { mergePayloads } = require("./mergeDiscovercarsResults");
const { isScenarioCheckpointComplete } = require("./executionPolicy");

const REPO_ROOT = path.resolve(__dirname, "..");
const TTL_MS = 2 * 60 * 60 * 1000;
const MERGE_TTL_MS = 12 * 60 * 60 * 1000;
const DESCRIPTOR = "shard-descriptor.json";
const METADATA = "shard-metadata.json";
const CODE_FILES = [
  "src/index.js", "src/discoverCars.js", "src/extractors.js", "src/formatters.js", "src/pricingRules.js",
  "src/dateUtils.js", "src/scrapeScope.js", "src/scrapeShards.js", "src/runDiscovercarsChunked.js",
  "src/mergeDiscovercarsResults.js", "src/executionPolicy.js", "src/locationRegistry.js",
  "locations.config.json", "pricing-rules.config.example.json", "package-lock.json"
];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function writeJson(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) return fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
function assertNotLink(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Symbolic links are not collection inputs: ${file}`);
}
function computeCodeFingerprint(repoRoot = REPO_ROOT) {
  const files = [...CODE_FILES];
  function visit(dir) {
    const absolute = path.join(repoRoot, dir);
    assertNotLink(absolute);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in scraper code: ${relative}`);
      if (entry.isDirectory()) visit(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  visit("src/discovercars");
  const manifest = [...new Set(files)].sort().map((file) => {
    const absolute = path.join(repoRoot, file); assertNotLink(absolute);
    return { path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex") };
  });
  return { sha256: hash(manifest), files: manifest };
}
function collectorOptions(speedMode) {
  if (!["safe", "fast", "turbo"].includes(speedMode)) throw new Error("Invalid collector speed mode.");
  return {
    strategy: "legacy-batch", speedMode, chunkDays: 7, chunkConcurrency: 1,
    scenarioConcurrency: 2, locationConcurrency: 2, maxActivePages: 4,
    chunkRetries: 2, chunkStallTimeoutMs: 600000, timeout: "auto",
    directCandidateLimit: 2, directOffersWait: 1000, apiFirst: true, apiDomSanityRate: 0.05,
    continueOnError: true, skipPostprocess: true
  };
}
function buildPlan({ scope, runId, shardCount = 2, speedMode = "fast", now = new Date(), repoRoot = REPO_ROOT }) {
  validateScrapeScope(scope);
  if (typeof runId !== "string" || !runId.trim() || runId !== runId.trim()) throw new Error("Plan requires an exact nonempty runId.");
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 2) throw new Error("Collection supports one or two shards only.");
  const count = Math.min(shardCount, scope.start_dates.length);
  const shards = Array.from({ length: count }, (_, index) => {
    // Give the earlier shard the odd date; no date or location is split between runners.
    const startDates = scope.start_dates.slice(Math.ceil(index * scope.start_dates.length / count), Math.ceil((index + 1) * scope.start_dates.length / count));
    const scenarioKeys = startDates.flatMap((date) => scope.durations.map((duration) => `${date}|${duration}`));
    return {
      index: index + 1, start_dates: startDates, locations: [...scope.locations], durations: [...scope.durations],
      scenario_keys: scenarioKeys, location_check_keys: scenarioKeys.flatMap((key) => scope.locations.map((location) => `${key}|${location}`))
    };
  });
  const plan = {
    schema_version: 1, created_at: new Date(now).toISOString(), run_id: runId,
    scope: JSON.parse(JSON.stringify(scope)), scope_hash: hash(scope), code_fingerprint: computeCodeFingerprint(repoRoot),
    options: collectorOptions(speedMode), global_concurrency_budget: 8, checkpoint_ttl_ms: TTL_MS, merge_ttl_ms: MERGE_TTL_MS,
    shards, matrix: { shard: shards.map((shard) => shard.index) }
  };
  return { ...plan, plan_id: hash(plan) };
}
function validatePlan(plan, { repoRoot = REPO_ROOT, runId = process.env.GITHUB_RUN_ID } = {}) {
  if (!plan || plan.schema_version !== 1 || !Array.isArray(plan.shards) || !plan.shards.length) throw new Error("Invalid collection plan.");
  if (runId && String(runId) !== plan.run_id) throw new Error("Collection plan runId mismatch.");
  const expected = buildPlan({ scope: plan.scope, runId: plan.run_id, shardCount: plan.shards.length,
    speedMode: plan.options?.speedMode, now: plan.created_at, repoRoot });
  if (hash(plan.code_fingerprint) !== hash(expected.code_fingerprint)) throw new Error("Scraper code fingerprint changed since collection plan.");
  if (hash(plan) !== hash(expected)) throw new Error("Collection plan context or immutable plan mismatch.");
  return plan;
}
function getShard(plan, index) {
  const shard = plan.shards.find((item) => item.index === Number(index));
  if (!shard) throw new Error(`Unknown collection shard: ${index}`);
  return shard;
}
function buildCollectorArgs(plan, shardIndex, outputDir) {
  const shard = getShard(plan, shardIndex);
  const o = plan.options;
  return [
    "src/runDiscovercarsChunked.js", `--output-dir=${path.resolve(outputDir)}`,
    `--locations=${shard.locations.join(",")}`, `--start-dates=${shard.start_dates.join(",")}`, `--durations=${shard.durations.join(",")}`,
    "--strategy=legacy-batch", `--speed-mode=${o.speedMode}`, "--chunk-concurrency=1", "--scenario-concurrency=2",
    "--location-concurrency=2", "--max-active-pages=4", "--timeout=auto", "--chunk-retries=2",
    "--chunk-stall-timeout=600000", "--chunk-days=7", "--direct-candidate-limit=2", "--direct-offers-wait=1000",
    "--api-first", "--api-dom-sanity-rate=0.05", "--continue-on-error", "--skip-postprocess"
  ];
}
function contextFor(plan, shard) {
  return {
    schema_version: 1, plan_id: plan.plan_id, run_id: plan.run_id, scope_hash: plan.scope_hash,
    code_hash: plan.code_fingerprint.sha256, options_hash: hash(plan.options), shard_index: shard.index, shard_scope_hash: hash(shard)
  };
}
function validateDescriptor(descriptor, plan, shard) {
  const expected = contextFor(plan, shard);
  for (const [key, value] of Object.entries(expected)) {
    if (descriptor?.[key] !== value) throw new Error(`Shard descriptor context mismatch: ${key}`);
  }
  if (!/^data-\d{4,}$/.test(descriptor.data_dir || "") || !validTime(descriptor.started_at)) throw new Error("Invalid shard descriptor data directory or time.");
  return descriptor;
}
function dataDirectory(dir, descriptor) {
  assertNotLink(dir);
  const dataDir = path.join(dir, descriptor.data_dir);
  assertNotLink(dataDir);
  return dataDir;
}
function chunkSpecs(shard) {
  const chunks = [];
  for (let index = 0; index < shard.start_dates.length; index += 7) {
    const dates = shard.start_dates.slice(index, index + 7);
    chunks.push({ dates, label: `chunk-${String(chunks.length + 1).padStart(2, "0")}-${dates[0]}-${dates.at(-1)}` });
  }
  return chunks;
}
function validTime(value) { return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value)); }
function freshTime(value, now, ttl = TTL_MS) {
  const time = validTime(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) && now - time >= 0 && now - time <= ttl;
}
function sourceTimes(scenario) {
  return [scenario.generated_at, ...Object.values(scenario.source_generated_at_by_location || {})];
}
function freshScenario(scenario, now) { return sourceTimes(scenario).every((time) => freshTime(time, now)); }
function scenarioKey(scenario) { return `${scenario.start_date}|${scenario.rental_days}`; }
function validateScenario(scenario, shard, dates) {
  if (!scenario || typeof scenario !== "object" || !dates.includes(scenario.start_date)
    || !Number.isInteger(scenario.rental_days) || !shard.durations.includes(scenario.rental_days)
    || scenario.scenario_id !== `date-${scenario.start_date.replace(/-/g, "")}-${scenario.rental_days}d`
    || !Array.isArray(scenario.results) || !Array.isArray(scenario.errors)) throw new Error("Corrupt or out-of-scope collection scenario.");
  function locations(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(locations); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === "location" && !shard.locations.includes(item)) throw new Error(`Out-of-scope location: ${item}`);
      if (key === "locations" && (!Array.isArray(item) || item.some((location) => !shard.locations.includes(location)))) throw new Error("Out-of-scope locations.");
      if (key.endsWith("_by_location")) {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((location) => !shard.locations.includes(location))) throw new Error(`Out-of-scope location map: ${key}`);
      }
      locations(item);
    }
  }
  locations(scenario);
  for (const row of [...scenario.results, ...scenario.errors]) {
    if (!row || typeof row !== "object" || !shard.locations.includes(row.location)) throw new Error("Corrupt location row.");
  }
  return scenario;
}
function validatePayload(payload, shard, dates, { timestamps = true, now = Date.now() } = {}) {
  if (payload && payload.scenarios === undefined && Number.isInteger(payload.rental_days)) payload = { ...payload, scenarios: [payload] };
  if (!payload || !Array.isArray(payload.scenarios)) throw new Error("Corrupt collection payload: scenarios required.");
  if (timestamps && !freshTime(payload.generated_at, now, MERGE_TTL_MS)) throw new Error("Missing, future or expired payload source timestamp.");
  if (payload.locations && (!Array.isArray(payload.locations) || payload.locations.some((location) => !shard.locations.includes(location)))) throw new Error("Out-of-scope payload locations.");
  const seen = new Set();
  for (const scenario of payload.scenarios) {
    validateScenario(scenario, shard, dates);
    const key = scenarioKey(scenario);
    if (seen.has(key)) throw new Error(`Duplicate collection scenario: ${key}`);
    seen.add(key);
    if (timestamps && sourceTimes(scenario).some((time) => !freshTime(time, now, MERGE_TTL_MS))) throw new Error("Missing, future or expired scenario source timestamp.");
  }
  return payload;
}
function validateState(state, shard, dates) {
  if (!state || state.version !== 1 || typeof state.run_signature !== "string" || !state.run_signature
    || !state.completed || typeof state.completed !== "object" || Array.isArray(state.completed)) throw new Error("Corrupt collection checkpoint.");
  for (const [key, scenario] of Object.entries(state.completed)) {
    validateScenario(scenario, shard, dates);
    if (key !== scenario.scenario_id) throw new Error("Corrupt checkpoint scenario id.");
  }
  return state;
}
function readInput(file) { assertNotLink(file); return readJson(file); }
function restoreChunks(sourceDir, targetDir, shard, now) {
  const report = { reused_scenarios: 0, reused_chunks: 0, rejected_files: [] };
  for (const chunk of chunkSpecs(shard)) {
    const sourceChunk = path.join(sourceDir, chunk.label);
    if (!fs.existsSync(sourceChunk)) continue;
    assertNotLink(sourceChunk);
    for (const file of ["results-latest.json", "state.json"]) {
      const source = path.join(sourceChunk, file);
      if (!fs.existsSync(source)) continue;
      try {
        const value = readInput(source);
        if (file === "results-latest.json") {
          const payload = validatePayload(value, shard, chunk.dates, { timestamps: false });
          if (!freshTime(payload.generated_at, now) || !payload.scenarios.length || !payload.scenarios.every((scenario) => freshScenario(scenario, now))) throw new Error("Missing, future or expired chunk source time.");
          const target = path.join(targetDir, chunk.label, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
          report.reused_chunks += 1;
        } else {
          validateState(value, shard, chunk.dates);
          if (!freshTime(value.created_at, now) || !freshTime(value.updated_at, now)) throw new Error("Missing, future or expired checkpoint time.");
          const completed = Object.fromEntries(Object.entries(value.completed).filter(([, scenario]) => freshScenario(scenario, now) && isScenarioCheckpointComplete(scenario, shard.locations)));
          if (!Object.keys(completed).length) throw new Error("No fresh complete checkpoint scenarios.");
          writeJson(path.join(targetDir, chunk.label, file), { ...value, completed, completed_count: Object.keys(completed).length });
          report.reused_scenarios += Object.keys(completed).length;
        }
      } catch (error) { report.rejected_files.push({ chunk: chunk.label, file, reason: error.message }); }
    }
  }
  return report;
}
function assertMatchingCopy(existing, incoming) {
  const derivedFields = new Set(["source_generated_at_by_location", "source_run_id_by_location", "source_run_id"]);
  for (const [field, value] of Object.entries(existing)) {
    if (derivedFields.has(field)) continue;
    if (Object.hasOwn(incoming, field) && hash(value) !== hash(incoming[field])) throw new Error(`Conflicting duplicate scenario field: ${field}`);
  }
}
function readShardData(dir, descriptor, shard, now = Date.now()) {
  const dataDir = dataDirectory(dir, descriptor);
  const chunks = chunkSpecs(shard);
  const allowed = new Set(chunks.map((chunk) => chunk.label));
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Symbolic link in shard output.");
    if (entry.isDirectory() && !allowed.has(entry.name)) throw new Error(`Unexpected shard chunk: ${entry.name}`);
  }
  const scenarios = new Map(); const sourceFiles = []; const chunkFailures = [];
  function add(scenario, file) {
    const key = scenarioKey(scenario);
    if (scenarios.has(key)) throw new Error(`Duplicate collection scenario: ${key}`);
    scenarios.set(key, scenario); if (!sourceFiles.includes(file)) sourceFiles.push(file);
  }
  for (const chunk of chunks) {
    const chunkDir = path.join(dataDir, chunk.label);
    if (!fs.existsSync(chunkDir)) continue;
    assertNotLink(chunkDir);
    const resultFile = path.join(chunkDir, "results-latest.json");
    if (fs.existsSync(resultFile)) {
      const payload = validatePayload(readInput(resultFile), shard, chunk.dates, { now });
      for (const scenario of payload.scenarios) add(scenario, resultFile);
    }
    const stateFile = path.join(chunkDir, "state.json");
    if (fs.existsSync(stateFile)) {
      const state = validateState(readInput(stateFile), shard, chunk.dates);
      if (![state.created_at, state.updated_at].every((time) => freshTime(time, now, MERGE_TTL_MS))) throw new Error("Missing, future or expired checkpoint source time.");
      for (const scenario of Object.values(state.completed)) {
        if (sourceTimes(scenario).some((time) => !freshTime(time, now, MERGE_TTL_MS))) throw new Error("Missing, future or expired checkpoint scenario timestamp.");
        if (scenarios.has(scenarioKey(scenario))) assertMatchingCopy(scenarios.get(scenarioKey(scenario)), scenario);
        else if (isScenarioCheckpointComplete(scenario, shard.locations)) add(scenario, stateFile);
      }
    }
  }
  const rootFile = path.join(dataDir, "results-latest.json");
  if (fs.existsSync(rootFile)) {
    const payload = validatePayload(readInput(rootFile), shard, shard.start_dates, { now });
    for (const scenario of payload.scenarios) {
      if (scenarios.has(scenarioKey(scenario))) assertMatchingCopy(scenarios.get(scenarioKey(scenario)), scenario);
      else add(scenario, rootFile);
    }
    if (payload.chunk_failures !== undefined && !Array.isArray(payload.chunk_failures)) throw new Error("Corrupt chunk failures.");
    chunkFailures.push(...(payload.chunk_failures || []));
  }
  return { scenarios: [...scenarios.values()], sourceFiles, chunkFailures };
}
function executeCollector({ args, repoRoot, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: "inherit", shell: false, windowsHide: true });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code, childSignal) => {
      signal.removeEventListener("abort", abort);
      resolve({ exitCode: code === null ? 1 : code, signal: childSignal });
    });
  });
}
async function runShard({ plan, shard: shardIndex, outputDir, restoreDir, repoRoot = REPO_ROOT, now = () => new Date(), executeRunner = executeCollector }) {
  validatePlan(plan, { repoRoot }); const shard = getShard(plan, shardIndex);
  outputDir = path.resolve(outputDir);
  const startedAt = new Date(now()).toISOString(); const startedMs = Date.now();
  let previous = null;
  if (fs.existsSync(outputDir)) {
    assertNotLink(outputDir);
    if (fs.existsSync(path.join(outputDir, DESCRIPTOR))) previous = validateDescriptor(readInput(path.join(outputDir, DESCRIPTOR)), plan, shard);
    else if (fs.readdirSync(outputDir).length) throw new Error("Refusing to reuse non-owned output directory without a shard descriptor.");
  }
  const restoreSource = restoreDir ? path.resolve(restoreDir) : previous ? outputDir : null;
  let sourceData = null; let rejectedSource = null;
  if (restoreSource && fs.existsSync(restoreSource)) {
    try {
      assertNotLink(restoreSource);
      const descriptor = validateDescriptor(readInput(path.join(restoreSource, DESCRIPTOR)), plan, shard);
      if (Date.parse(descriptor.started_at) > new Date(now()).getTime()) throw new Error("Future restore descriptor time.");
      const metaFile = path.join(restoreSource, METADATA);
      if (fs.existsSync(metaFile)) validateMetadata(readInput(metaFile), descriptor, plan, shard);
      sourceData = dataDirectory(restoreSource, descriptor);
    } catch (failure) { rejectedSource = failure.message; }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  let dataName; let dataDir;
  for (let attempt = 1; ; attempt += 1) {
    dataName = `data-${String(attempt).padStart(4, "0")}`; dataDir = path.join(outputDir, dataName);
    try { fs.mkdirSync(dataDir); break; } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const descriptor = { ...contextFor(plan, shard), data_dir: dataName, started_at: startedAt };
  writeJson(path.join(outputDir, DESCRIPTOR), descriptor);
  writeJson(path.join(outputDir, METADATA), { ...descriptor, status: "running", exit_code: 1,
    finished_at: startedAt, duration_seconds: 0, error: "No final collector metadata yet" });
  let restore = { reused_scenarios: 0, reused_chunks: 0, rejected_files: [], rejected_source: rejectedSource };
  let error = null; let childResult = { exitCode: 1 }; let interrupted = false;
  const controller = new AbortController();
  const saveInterrupted = () => {
    interrupted = true;
    writeJson(path.join(outputDir, METADATA), { ...descriptor, status: "interrupted", exit_code: 1,
      finished_at: new Date(now()).toISOString(), duration_seconds: (Date.now() - startedMs) / 1000, error: "Collector interrupted", restore });
    controller.abort();
  };
  process.once("SIGTERM", saveInterrupted); process.once("SIGINT", saveInterrupted);
  let data = { scenarios: [], chunkFailures: [] };
  try {
    if (sourceData) restore = { ...restore, ...restoreChunks(sourceData, dataDir, shard, new Date(now()).getTime()) };
    // Recheck immediately before starting a process; the shared checkout may have changed during restore.
    validatePlan(plan, { repoRoot });
    childResult = await executeRunner({ args: buildCollectorArgs(plan, shard.index, dataDir), outputDir: dataDir, repoRoot, signal: controller.signal });
    if (!childResult || !Number.isInteger(childResult.exitCode)) throw new Error("Invalid collector child exit code.");
  } catch (failure) { error = failure.message; }
  finally {
    process.removeListener("SIGTERM", saveInterrupted); process.removeListener("SIGINT", saveInterrupted);
    try { data = readShardData(outputDir, descriptor, shard, new Date(now()).getTime()); } catch (failure) { error = error || failure.message; }
  }
  const missingCount = shard.scenario_keys.length - data.scenarios.length;
  const incomplete = data.scenarios.some((scenario) => !isScenarioCheckpointComplete(scenario, shard.locations));
  const failed = Boolean(error || interrupted || childResult.exitCode !== 0);
  const status = interrupted ? "interrupted" : failed ? "failed" : missingCount || incomplete || data.chunkFailures.length ? "degraded" : "success";
  const duration = childResult.durationSeconds === undefined ? (Date.now() - startedMs) / 1000 : childResult.durationSeconds;
  const metadata = {
    ...descriptor, status, exit_code: failed ? childResult.exitCode || 1 : 0,
    finished_at: new Date(now()).toISOString(), duration_seconds: Math.max(0, duration),
    error: error || (interrupted ? "Collector interrupted" : childResult.exitCode ? `Collector exited with code ${childResult.exitCode}` : null),
    missing_scenario_count: missingCount, scenario_count: data.scenarios.length, chunk_failures: data.chunkFailures, restore
  };
  writeJson(path.join(outputDir, METADATA), metadata);
  return { exitCode: failed ? metadata.exit_code : status === "success" ? 0 : 1, metadata };
}
function validateMetadata(meta, descriptor, plan, shard) {
  validateDescriptor(meta, plan, shard);
  if (meta.data_dir !== descriptor.data_dir || meta.started_at !== descriptor.started_at
    || !["running", "success", "degraded", "failed", "interrupted"].includes(meta.status)
    || !validTime(meta.finished_at) || Date.parse(meta.finished_at) < Date.parse(meta.started_at)
    || !Number.isFinite(meta.duration_seconds) || meta.duration_seconds < 0 || !Number.isInteger(meta.exit_code)) throw new Error("Corrupt shard final metadata context.");
  return meta;
}
function mergeShards({ plan, inputDir, output, repoRoot = REPO_ROOT, now = new Date() }) {
  validatePlan(plan, { repoRoot });
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid collection merge time.");
  const seen = new Set(); const items = []; const sourceFiles = []; const errors = [];
  if (fs.existsSync(inputDir)) {
    assertNotLink(inputDir);
    for (const entry of fs.readdirSync(inputDir, { withFileTypes: true })) {
      const shard = plan.shards.find((item) => entry.name === `raw-shard-${item.index}` || entry.name === `discovercars-raw-${plan.run_id}-${item.index}`);
      if (!entry.isDirectory() || !shard) throw new Error(`Unexpected collection artifact or run: ${entry.name}`);
      const index = shard.index;
      if (seen.has(index)) throw new Error(`Duplicate shard input: ${index}`); seen.add(index);
      const dir = path.join(inputDir, entry.name); assertNotLink(dir);
      const descriptor = validateDescriptor(readInput(path.join(dir, DESCRIPTOR)), plan, shard);
      if (Date.parse(descriptor.started_at) > nowMs) throw new Error("Future shard descriptor time.");
      const metaFile = path.join(dir, METADATA);
      let meta = { status: "interrupted", duration_seconds: 0 };
      if (fs.existsSync(metaFile)) {
        meta = validateMetadata(readInput(metaFile), descriptor, plan, shard);
        if (Date.parse(meta.finished_at) > nowMs) throw new Error("Future shard final metadata time.");
        if (meta.status === "running") meta = { ...meta, status: "interrupted" };
      }
      const data = readShardData(dir, descriptor, shard, nowMs);
      items.push({ shard, meta, data }); sourceFiles.push(...data.sourceFiles);
      if (meta.status !== "success" || meta.exit_code !== 0) errors.push({ shard: index, error: meta.error || `Shard ${meta.status}` });
      errors.push(...data.chunkFailures.map((failure) => ({ shard: index, ...failure })));
    }
  }
  const allScenarios = items.flatMap((item) => item.data.scenarios);
  if (!allScenarios.some((scenario) => scenario.results.length)) throw new Error("No valid raw collection data to merge.");
  const scenarioKeys = new Set();
  for (const scenario of allScenarios) {
    const key = scenarioKey(scenario); if (scenarioKeys.has(key)) throw new Error(`Duplicate shard scenario: ${key}`); scenarioKeys.add(key);
  }
  const results = mergePayloads(items.filter((item) => item.data.scenarios.length).map((item) => ({
    locations: item.shard.locations, time_zone: plan.scope.time_zone, scenarios: item.data.scenarios
  })), sourceFiles);
  // The existing merger stamps its envelope/maps. Restore source evidence, while keeping its merge timestamp separate.
  const originalById = new Map(allScenarios.map((scenario) => [scenario.scenario_id, scenario]));
  for (const scenario of results.scenarios) {
    const original = originalById.get(scenario.scenario_id);
    if (original.source_generated_at_by_location) scenario.source_generated_at_by_location = original.source_generated_at_by_location;
    if (original.source_run_id_by_location) scenario.source_run_id_by_location = original.source_run_id_by_location;
  }
  results.generated_at = allScenarios.map((scenario) => scenario.generated_at).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
  results.run_id = plan.run_id; results.collection_scope = plan.scope;
  results.collection_plan_id = plan.plan_id;
  const missingShards = plan.shards.filter((shard) => !seen.has(shard.index)).map((shard) => shard.index);
  const missingScenarios = plan.scope.scenario_keys.filter((key) => !scenarioKeys.has(key));
  const completeChecks = new Set();
  for (const scenario of allScenarios) {
    for (const location of plan.scope.locations) {
      const localEvidence = { ...scenario, errors: scenario.errors.filter((error) => error.location === location) };
      if (isScenarioCheckpointComplete(localEvidence, [location])) completeChecks.add(`${scenarioKey(scenario)}|${location}`);
    }
  }
  const missingChecks = plan.scope.location_check_keys.filter((key) => !completeChecks.has(key));
  const status = missingShards.length || missingScenarios.length || missingChecks.length || errors.length ? "degraded" : "success";
  results.run_status = status; results.collection_failures = errors; results.missing_shards = missingShards;
  const summary = {
    schema_version: 1, run_id: plan.run_id, plan_id: plan.plan_id, status, scope: plan.scope,
    duration_seconds: Math.max(0, ...items.map((item) => item.meta.duration_seconds)),
    expected_scenario_count: plan.scope.expected_scenario_count, scenario_count: allScenarios.length,
    missing_scenario_count: missingScenarios.length, missing_scenario_keys: missingScenarios,
    expected_location_check_count: plan.scope.expected_location_check_count, missing_location_check_count: missingChecks.length,
    missing_shards: missingShards, missing_shard_count: missingShards.length,
    error_count: errors.length + results.errors.length, errors,
    shards: items.map((item) => ({ index: item.shard.index, status: item.meta.status, duration_seconds: item.meta.duration_seconds }))
  };
  writeJson(output, results); writeJson(path.join(path.dirname(output), "collection-summary.json"), summary);
  return { results, summary };
}
function parseCli(argv) {
  const [command, ...flags] = argv;
  const allowed = { plan: ["scope", "run-id", "shard-count", "speed-mode", "output"], run: ["plan", "shard", "output-dir", "restore-dir"], merge: ["plan", "input-dir", "output"] };
  if (!allowed[command]) throw new Error("Use scrapeShards.js plan, run or merge.");
  const args = {};
  for (const flag of flags) {
    const match = flag.match(/^--([^=]+)=(.+)$/);
    if (!match || !allowed[command].includes(match[1]) || Object.hasOwn(args, match[1])) throw new Error(`Invalid or duplicate collection argument: ${flag}`);
    args[match[1]] = match[2];
  }
  for (const key of command === "plan" ? ["scope", "run-id", "output"] : command === "run" ? ["plan", "shard", "output-dir"] : ["plan", "input-dir", "output"]) {
    if (!args[key]) throw new Error(`Missing --${key}`);
  }
  return { command, args };
}
async function runCli(argv) {
  const { command, args } = parseCli(argv);
  if (command === "plan") {
    const options = { scope: readInput(path.resolve(args.scope)), runId: args["run-id"], shardCount: Number(args["shard-count"] || 2), speedMode: args["speed-mode"] || "fast" };
    const output = path.resolve(args.output);
    if (fs.existsSync(output)) {
      const existing = validatePlan(readInput(output));
      const requested = buildPlan({ ...options, now: existing.created_at });
      if (hash(existing) !== hash(requested)) throw new Error("Refusing to overwrite immutable collection plan.");
    } else writeJson(output, buildPlan(options), true);
    return 0;
  }
  const plan = readInput(path.resolve(args.plan));
  if (command === "run") return (await runShard({ plan, shard: Number(args.shard), outputDir: args["output-dir"], restoreDir: args["restore-dir"] })).exitCode;
  mergeShards({ plan, inputDir: path.resolve(args["input-dir"]), output: path.resolve(args.output) });
  return 0;
}
if (require.main === module) runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { buildPlan, validatePlan, computeCodeFingerprint, buildCollectorArgs, runShard, mergeShards, runCli };
