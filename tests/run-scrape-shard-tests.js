const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildScrapeScope } = require("../src/scrapeScope");
const { mergePayloads } = require("../src/mergeDiscovercarsResults");

const root = path.resolve(__dirname, "..");
const modulePath = path.join(root, "src", "scrapeShards.js");
const tests = [];
const test = (name, run) => tests.push({ name, run });
const api = () => require(modulePath);
const NOW = "2026-10-01T10:00:00.000Z";
const FRESH = "2026-10-01T09:30:00.000Z";
const merge = (options) => api().mergeShards({ now: NOW, ...options });
const DATES = ["2026-10-02", "2026-10-03", "2026-10-04"];
const scope = (dates = DATES) => buildScrapeScope({ now: NOW, startDates: dates, durations: [2, 3], locations: ["Warsaw", "Gdansk"] });
const plan = (dates = DATES) => api().buildPlan({ scope: scope(dates), runId: "run-123", shardCount: 2, speedMode: "fast", now: NOW });
const clone = (value) => JSON.parse(JSON.stringify(value));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "scrape-shards-test-"));
const id = (date, duration) => `date-${date.replace(/-/g, "")}-${duration}d`;
function scenario(date = DATES[0], duration = 2, generatedAt = FRESH) {
  return {
    scenario_id: id(date, duration), start_date: date, rental_days: duration, generated_at: generatedAt,
    pickup_date: `${date}T11:00:00+02:00`, locations: ["Warsaw", "Gdansk"],
    results: ["Warsaw", "Gdansk"].map((location) => ({ location, currency: "PLN", total_price: 120, rental_days: duration })),
    errors: [], top_3_by_location: { Warsaw: [{ total_price: 120 }], Gdansk: [{ total_price: 120 }] }
  };
}
function chunkLabel(dates, index = 0) { return `chunk-${String(index + 1).padStart(2, "0")}-${dates[0]}-${dates.at(-1)}`; }
function checkpoint(scenarios) {
  return { version: 1, run_signature: "fixture-signature", created_at: FRESH, updated_at: FRESH,
    completed: Object.fromEntries(scenarios.map((item) => [item.scenario_id, item])) };
}
async function artifact(p, index, items, { exitCode = 0, stateOnly = false, duration = 0 } = {}) {
  const outputDir = path.join(temp(), `raw-shard-${index}`);
  const result = await api().runShard({ plan: p, shard: index, outputDir, now: () => new Date(NOW),
    executeRunner: async ({ outputDir: dataDir }) => {
      const dates = p.shards[index - 1].start_dates;
      const chunkDir = path.join(dataDir, chunkLabel(dates));
      if (stateOnly) write(path.join(chunkDir, "state.json"), checkpoint(items));
      else write(path.join(chunkDir, "results-latest.json"), { generated_at: FRESH, locations: p.scope.locations, scenarios: items });
      return { exitCode, durationSeconds: duration };
    }
  });
  return { outputDir, result, dataDir: path.join(outputDir, read(path.join(outputDir, "shard-descriptor.json")).data_dir) };
}
function inputs(...artifacts) {
  const dir = temp();
  for (const item of artifacts) fs.cpSync(item.outputDir, path.join(dir, path.basename(item.outputDir)), { recursive: true });
  return dir;
}

test("module exposes the bounded collection API", () => {
  assert(fs.existsSync(modulePath), "raw collection sharding module is not implemented");
  for (const name of ["buildPlan", "validatePlan", "computeCodeFingerprint", "buildCollectorArgs", "runShard", "mergeShards"]) assert.equal(typeof api()[name], "function");
});

test("plan partitions dates deterministically with exact scenario and location union", () => {
  const p = plan();
  assert.deepEqual(p.shards.map((shard) => shard.start_dates), [["2026-10-02", "2026-10-03"], ["2026-10-04"]]);
  assert.deepEqual(p.matrix, { shard: [1, 2] });
  assert.deepEqual(p.shards.flatMap((s) => s.scenario_keys).sort(), scope().scenario_keys.slice().sort());
  assert.deepEqual(p.shards.flatMap((s) => s.location_check_keys).sort(), scope().location_check_keys.slice().sort());
  for (const s of p.shards) { assert.deepEqual(s.locations, ["Warsaw", "Gdansk"]); assert.deepEqual(s.durations, [2, 3]); }
  assert.equal(plan([DATES[0]]).shards.length, 1);
  assert.deepEqual(p, plan());
});

test("two runners stay within eight global pages and immutable plan rejects tampering", () => {
  const p = plan();
  assert.equal(p.shards.length * p.options.chunkConcurrency * p.options.scenarioConcurrency * p.options.locationConcurrency, 8);
  assert.equal(p.options.maxActivePages, 4);
  for (const change of [(v) => { v.run_id = "other"; }, (v) => { v.scope.locations.push("Poznan"); },
    (v) => { v.options.maxActivePages = 20; }, (v) => { v.shards[1].start_dates = v.shards[0].start_dates; }]) {
    const bad = clone(p); change(bad); assert.throws(() => api().validatePlan(bad));
  }
  assert.throws(() => api().buildPlan({ scope: scope(), runId: "", shardCount: 2 }));
  assert.throws(() => api().buildPlan({ scope: scope(), runId: "x", shardCount: 3 }));
});

test("plan CLI is idempotent but will not overwrite a different frozen run", () => {
  const dir = temp(); write(path.join(dir, "scope.json"), scope());
  const args = [modulePath, "plan", `--scope=${path.join(dir, "scope.json")}`, "--run-id=run-123", "--shard-count=2", "--speed-mode=fast", `--output=${path.join(dir, "plan.json")}`];
  const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" }); assert.equal(first.status, 0, first.stderr);
  const before = fs.readFileSync(path.join(dir, "plan.json"), "utf8");
  assert.equal(spawnSync(process.execPath, args, { cwd: root }).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "plan.json"), "utf8"), before);
  args[3] = "--run-id=other";
  assert.notEqual(spawnSync(process.execPath, args, { cwd: root }).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "plan.json"), "utf8"), before);
});

test("code fingerprint covers scraper subtree, runner, registry, policy and fails closed on drift", () => {
  const p = plan(); const dir = temp();
  for (const file of p.code_fingerprint.files) {
    const target = path.join(dir, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file.path), target);
  }
  api().validatePlan(p, { repoRoot: dir });
  for (const file of ["src/index.js", "src/discovercars/scraper.js", "src/runDiscovercarsChunked.js", "src/executionPolicy.js", "src/locationRegistry.js", "locations.config.json"]) {
    const target = path.join(dir, file); const original = fs.readFileSync(target); fs.appendFileSync(target, "\n ");
    assert.throws(() => api().validatePlan(p, { repoRoot: dir }), /code|fingerprint/i); fs.writeFileSync(target, original);
  }
  write(path.join(dir, "src/discovercars/new-module.js"), {});
  assert.throws(() => api().validatePlan(p, { repoRoot: dir }), /code|fingerprint/i);
});

test("run persists descriptor before child, freezes runner flags and final metadata on error", async () => {
  const p = plan(); const outputDir = path.join(temp(), "raw-shard-1");
  const result = await api().runShard({ plan: p, shard: 1, outputDir, now: () => new Date(NOW), executeRunner: async ({ args, outputDir: dataDir }) => {
    assert.equal(read(path.join(outputDir, "shard-descriptor.json")).plan_id, p.plan_id);
    for (const flag of ["--strategy=legacy-batch", "--chunk-concurrency=1", "--scenario-concurrency=2", "--location-concurrency=2", "--max-active-pages=4", "--chunk-retries=2", "--chunk-days=7", "--chunk-stall-timeout=600000", "--speed-mode=fast", "--skip-postprocess", "--continue-on-error"]) assert(args.includes(flag), flag);
    assert(!args.includes("--reset-state"));
    assert(!args.some((arg) => arg.startsWith("--retries=")));
    write(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "state.json"), checkpoint([scenario()]));
    throw new Error("interrupted child");
  } });
  assert.equal(result.exitCode, 1);
  const meta = read(path.join(outputDir, "shard-metadata.json")); assert.equal(meta.status, "failed"); assert.match(meta.error, /interrupted child/);
  const dir = inputs({ outputDir }); const merged = merge({ plan: p, inputDir: dir, output: path.join(temp(), "results.json") });
  assert.equal(merged.results.scenarios.length, 1); assert.equal(merged.results.run_status, "degraded");
});

test("restart restores only fresh completed subsets without changing timestamps or old evidence", async () => {
  const p = plan(); const old = await artifact(p, 1, [scenario(), scenario(DATES[0], 3, "2026-10-01T07:00:00.000Z")], { exitCode: 1, stateOnly: true });
  const statePath = path.join(old.dataDir, chunkLabel(p.shards[0].start_dates), "state.json"); const before = fs.readFileSync(statePath, "utf8");
  const outputDir = path.join(temp(), "raw-shard-1");
  const result = await api().runShard({ plan: p, shard: 1, outputDir, restoreDir: old.outputDir, now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
    const restored = read(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "state.json"));
    assert.deepEqual(Object.keys(restored.completed), ["date-20261002-2d"]);
    assert.equal(restored.completed["date-20261002-2d"].generated_at, FRESH); assert.equal(restored.updated_at, FRESH);
    return { exitCode: 1 };
  } });
  assert.equal(result.metadata.error, "Collector exited with code 1");
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

for (const [name, timestamp] of [["missing", undefined], ["future", "2026-10-01T10:00:01.000Z"], ["expired", "2026-10-01T07:59:59.000Z"]]) {
  test(`${name} scenario timestamp never revives through a fresh state timestamp`, async () => {
    const p = plan(); const item = scenario(); item.generated_at = timestamp;
    const old = await artifact(p, 1, [item], { exitCode: 1, stateOnly: true });
    const result = await api().runShard({ plan: p, shard: 1, outputDir: path.join(temp(), "raw-shard-1"), restoreDir: old.outputDir, now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
      assert(!fs.existsSync(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "state.json"))); return { exitCode: 1 };
    } });
    assert.equal(result.metadata.error, "Collector exited with code 1");
  });
}

test("fresh aggregate timestamp cannot revive a stale chunk scenario", async () => {
  const p = plan(); const old = await artifact(p, 1, [scenario(DATES[0], 2, "2026-10-01T07:00:00.000Z")]);
  const result = await api().runShard({ plan: p, shard: 1, outputDir: path.join(temp(), "raw-shard-1"), restoreDir: old.outputDir, now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
    assert(!fs.existsSync(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "results-latest.json"))); return { exitCode: 1 };
  } });
  assert.equal(result.metadata.error, "Collector exited with code 1");
});

test("restore refuses run, scope, options and code context mismatches", async () => {
  const p = plan(); const old = await artifact(p, 1, [scenario()], { stateOnly: true });
  const file = path.join(old.outputDir, "shard-descriptor.json"); const original = read(file);
  for (const field of ["run_id", "scope_hash", "options_hash", "code_hash", "plan_id"]) {
    write(file, { ...original, [field]: "wrong" });
    const result = await api().runShard({ plan: p, shard: 1, outputDir: path.join(temp(), "raw-shard-1"), restoreDir: old.outputDir, now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
      assert.deepEqual(fs.readdirSync(dataDir), []); return { exitCode: 1 };
    } });
    assert.equal(result.metadata.error, "Collector exited with code 1");
    assert.equal(result.metadata.restore.reused_scenarios, 0);
    assert.match(result.metadata.restore.rejected_source, /context|descriptor|mismatch/i);
  }
});

test("interrupted descriptor without final metadata remains resumable in the same output directory", async () => {
  const p = plan(); const old = await artifact(p, 1, [scenario()], { stateOnly: true, exitCode: 1 });
  fs.renameSync(path.join(old.outputDir, "shard-metadata.json"), path.join(old.outputDir, "saved-metadata.json"));
  const previous = old.dataDir;
  const result = await api().runShard({ plan: p, shard: 1, outputDir: old.outputDir, now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
    assert.notEqual(dataDir, previous); assert(fs.existsSync(path.join(previous, chunkLabel(p.shards[0].start_dates), "state.json")));
    assert.equal(Object.keys(read(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "state.json")).completed).length, 1); return { exitCode: 1 };
  } });
  assert.equal(result.metadata.error, "Collector exited with code 1");
});

test("workflow artifact names merge successfully and wrong run names are rejected", async () => {
  const p = plan(); const a = await artifact(p, 1, [scenario()]); const dir = temp();
  fs.cpSync(a.outputDir, path.join(dir, "discovercars-raw-run-123-1"), { recursive: true });
  const result = merge({ plan: p, inputDir: dir, output: path.join(temp(), "results.json") });
  assert.equal(result.results.scenarios.length, 1);
  fs.renameSync(path.join(dir, "discovercars-raw-run-123-1"), path.join(dir, "discovercars-raw-other-run-1"));
  assert.throws(() => merge({ plan: p, inputDir: dir, output: path.join(temp(), "results.json") }), /artifact|run/i);
});

test("two-shard fixture matches unsharded offer views, rankings, prices, timestamps and coverage", async () => {
  const p = plan();
  const items = DATES.flatMap((date) => [2, 3].map((duration) => {
    const item = scenario(date, duration);
    item.results[0].transmission = "manual"; item.results[1].transmission = "automatic";
    item.cheapest_overall = item.results[0];
    item.cheapest_by_location = { Warsaw: item.results[0], Gdansk: item.results[1] };
    item.offer_views_by_location = Object.fromEntries(item.locations.map((location) => [location, {
      all: { top_3: [
        { provider_name: "First", total_price: 110 + duration, transmission: "manual", ranking: 1 },
        { provider_name: "Second", total_price: 130 + duration, transmission: "automatic", ranking: 2 }
      ], mm_cars_rental: { total_price: 150 + duration, ranking: 3 }, mm_provider_rank: 3, cheaper_offer_count: 2, offer_count: 9, provider_count: 4 },
      automatic: { top_3: [{ provider_name: "Second", total_price: 130 + duration, transmission: "automatic", ranking: 1 }],
        mm_cars_rental: { total_price: 170 + duration, ranking: 2 }, mm_provider_rank: 2, cheaper_offer_count: 1, offer_count: 5, provider_count: 3 }
    }]));
    item.source_generated_at_by_location = { Warsaw: FRESH, Gdansk: "2026-10-01T09:15:00.000Z" };
    item.source_run_id_by_location = { Warsaw: "source-a", Gdansk: "source-b" };
    return item;
  }));
  const unsharded = mergePayloads([{ generated_at: FRESH, run_id: "run-123", locations: p.scope.locations, scenarios: items }]);
  const a = await artifact(p, 1, items.slice(0, 4)); const b = await artifact(p, 2, items.slice(4));
  const merged = merge({ plan: p, inputDir: inputs(a, b), output: path.join(temp(), "results.json") });
  assert.equal(merged.results.run_status, "success"); assert.equal(merged.summary.missing_scenario_count, 0);
  assert.equal(merged.summary.missing_location_check_count, 0);
  assert.deepEqual(merged.results.cheapest_overall, unsharded.cheapest_overall);
  for (let index = 0; index < items.length; index += 1) {
    const actual = merged.results.scenarios[index]; const expected = items[index];
    for (const field of ["scenario_id", "start_date", "rental_days", "results", "top_3_by_location", "offer_views_by_location", "cheapest_overall", "cheapest_by_location", "generated_at", "source_generated_at_by_location", "source_run_id_by_location"]) assert.deepEqual(actual[field], expected[field], field);
  }
});

test("malformed duplicate date-duration cannot claim complete coverage even with different IDs", async () => {
  const p = plan([DATES[0]]); const a = await artifact(p, 1, [scenario(), scenario(DATES[0], 3)]);
  const file = path.join(a.dataDir, chunkLabel(p.shards[0].start_dates), "results-latest.json"); const payload = read(file);
  payload.scenarios[1].rental_days = 2; write(file, payload);
  assert.throws(() => merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") }));
});

test("SIGTERM saves interrupted metadata and retains partial state", async () => {
  const p = plan(); const outputDir = path.join(temp(), "raw-shard-1");
  const result = await api().runShard({ plan: p, shard: 1, outputDir, now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir, signal }) => {
    write(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "state.json"), checkpoint([scenario()]));
    process.emit("SIGTERM");
    assert(signal.aborted); assert.equal(read(path.join(outputDir, "shard-metadata.json")).status, "interrupted");
    return { exitCode: 1 };
  } });
  assert.equal(result.metadata.status, "interrupted"); assert.equal(result.metadata.error, "Collector interrupted");
  const merged = merge({ plan: p, inputDir: inputs({ outputDir }), output: path.join(temp(), "results.json") });
  assert.equal(merged.results.scenarios.length, 1);
});

test("restore checks final metadata as well as descriptor context", async () => {
  const p = plan(); const a = await artifact(p, 1, [scenario()], { stateOnly: true });
  const file = path.join(a.outputDir, "shard-metadata.json"); write(file, { ...read(file), run_id: "wrong-run" });
  const result = await api().runShard({ plan: p, shard: 1, outputDir: path.join(temp(), "raw-shard-1"), restoreDir: a.outputDir,
    now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
      assert.deepEqual(fs.readdirSync(dataDir), []); return { exitCode: 1 };
    } });
  assert.equal(result.metadata.error, "Collector exited with code 1"); assert.match(result.metadata.restore.rejected_source, /context|mismatch/i);
});

test("first-ever run with nonexistent restore directory starts clean", async () => {
  const p = plan(); const dir = temp();
  const result = await api().runShard({ plan: p, shard: 1, outputDir: path.join(dir, "raw-shard-1"), restoreDir: path.join(dir, "never-downloaded"),
    now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
      assert.deepEqual(fs.readdirSync(dataDir), []); return { exitCode: 1 };
    } });
  assert.equal(result.metadata.error, "Collector exited with code 1"); assert.equal(result.metadata.restore.reused_scenarios, 0);
});

test("same-run merge accepts three-hour evidence while restart restore rejects it", async () => {
  const p = plan(); const item = scenario(DATES[0], 2, "2026-10-01T07:00:00.000Z"); const a = await artifact(p, 1, [item]);
  const merged = merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") });
  assert.equal(merged.results.scenarios[0].generated_at, "2026-10-01T07:00:00.000Z");
  assert.equal(merged.results.scenarios[0].source_generated_at_by_location.Warsaw, "2026-10-01T07:00:00.000Z");
  const result = await api().runShard({ plan: p, shard: 1, outputDir: path.join(temp(), "raw-shard-1"), restoreDir: a.outputDir,
    now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => { assert.deepEqual(fs.readdirSync(dataDir), []); return { exitCode: 1 }; } });
  assert.equal(result.metadata.error, "Collector exited with code 1"); assert.equal(result.metadata.restore.reused_chunks, 0);
});

for (const [name, timestamp] of [["missing", undefined], ["future", "2026-10-01T10:00:01.000Z"], ["older than twelve hours", "2026-09-30T21:59:59.000Z"]]) {
  test(`merge rejects ${name} source time`, async () => {
    const p = plan(); const item = scenario(); item.generated_at = timestamp; const a = await artifact(p, 1, [item]);
    assert.throws(() => merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") }), /time|timestamp|expired/i);
  });
}

test("merge rejects conflicting scenario copies in chunk and aggregate", async () => {
  const p = plan(); const a = await artifact(p, 1, [scenario()]); const changed = scenario(); changed.results[0].total_price = 9999;
  write(path.join(a.dataDir, "results-latest.json"), { generated_at: FRESH, locations: p.scope.locations, scenarios: [changed] });
  assert.throws(() => merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") }), /conflict|duplicate/i);
});

test("merge retains failed shard rows, original scope, missing counts and max elapsed duration", async () => {
  const p = plan(); const a = await artifact(p, 1, [scenario()], { exitCode: 1, duration: 18 });
  const b = await artifact(p, 2, [scenario(DATES[2])], { duration: 11 });
  const output = path.join(temp(), "results-latest.json"); const merged = merge({ plan: p, inputDir: inputs(a, b), output });
  assert.equal(merged.results.scenarios.length, 2); assert.equal(merged.results.run_status, "degraded");
  assert.deepEqual(merged.results.collection_scope, p.scope); assert.equal(merged.summary.expected_scenario_count, 6);
  assert.equal(merged.summary.missing_scenario_count, 4); assert.equal(merged.summary.duration_seconds, 18);
  assert(merged.summary.error_count > 0); assert.equal(read(path.join(path.dirname(output), "collection-summary.json")).duration_seconds, 18);
  const only = merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") });
  assert.deepEqual(only.summary.missing_shards, [2]);
});

test("one failed location counts one missing check without weakening scenario resume", async () => {
  const p = plan([DATES[0]]); const partial = scenario(); partial.results = partial.results.filter((row) => row.location === "Warsaw");
  partial.errors = [{ location: "Gdansk", error: "collection failed" }]; partial.top_3_by_location.Gdansk = [];
  const a = await artifact(p, 1, [partial, scenario(DATES[0], 3)]);
  const merged = merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") });
  assert.equal(merged.summary.expected_location_check_count, 4); assert.equal(merged.summary.missing_location_check_count, 1);
  assert.equal(merged.results.run_status, "degraded"); assert.equal(merged.results.errors.length, 1);
  const statePath = path.join(a.dataDir, chunkLabel(p.shards[0].start_dates), "state.json"); write(statePath, checkpoint([partial]));
  const resumed = await api().runShard({ plan: p, shard: 1, outputDir: path.join(temp(), "raw-shard-1"), restoreDir: a.outputDir,
    now: () => new Date(NOW), executeRunner: async ({ outputDir: dataDir }) => {
      assert(!fs.existsSync(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "state.json"))); return { exitCode: 1 };
    } });
  assert.equal(resumed.metadata.error, "Collector exited with code 1"); assert.equal(resumed.metadata.restore.reused_scenarios, 0);
});

test("merge never re-dates source evidence, including per-location source maps", async () => {
  const p = plan(); const item = scenario(); item.source_generated_at_by_location = { Warsaw: "2026-10-01T09:00:00.000Z", Gdansk: FRESH };
  item.source_run_id_by_location = { Warsaw: "original-a", Gdansk: "original-b" };
  const a = await artifact(p, 1, [item]);
  const merged = merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") });
  const actual = merged.results.scenarios[0]; assert.equal(actual.generated_at, FRESH);
  assert.deepEqual(actual.source_generated_at_by_location, item.source_generated_at_by_location);
  assert.deepEqual(actual.source_run_id_by_location, item.source_run_id_by_location);
  assert.equal(merged.results.generated_at, FRESH); assert.equal(merged.results.run_id, "run-123");
});

for (const [name, mutate] of [
  ["out-of-scope date", (payload) => { payload.scenarios[0].start_date = "2026-11-02"; }],
  ["out-of-scope location", (payload) => { payload.scenarios[0].results[0].location = "Poznan"; }],
  ["out-of-scope map", (payload) => { payload.scenarios[0].top_3_by_location.Poznan = []; }],
  ["duplicate scenario", (payload) => { payload.scenarios.push(clone(payload.scenarios[0])); }],
  ["corrupt rows", (payload) => { payload.scenarios[0].results = {}; }],
  ["incorrect scenario id", (payload) => { payload.scenarios[0].scenario_id = "arbitrary"; }]
]) {
  test(`merge rejects ${name}`, async () => {
    const p = plan(); const a = await artifact(p, 1, [scenario()]); const file = path.join(a.dataDir, chunkLabel(p.shards[0].start_dates), "results-latest.json");
    const payload = read(file); mutate(payload); write(file, payload);
    assert.throws(() => merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") }));
  });
}

test("merge rejects foreign run metadata, unknown artifacts and empty input", async () => {
  const p = plan(); const a = await artifact(p, 1, [scenario()]); const meta = path.join(a.outputDir, "shard-metadata.json");
  write(meta, { ...read(meta), run_id: "other" });
  assert.throws(() => merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") }));
  assert.throws(() => merge({ plan: p, inputDir: temp(), output: path.join(temp(), "results.json") }), /no valid|no .*data/i);
});

test("canonical chunk merger metadata does not conflict with original source maps", async () => {
  const p = plan(); const original = scenario(); original.source_generated_at_by_location = { Warsaw: FRESH, Gdansk: "2026-10-01T09:00:00.000Z" };
  original.source_run_id_by_location = { Warsaw: "original-a", Gdansk: "original-b" };
  const a = await artifact(p, 1, [original]);
  const payload = read(path.join(a.dataDir, chunkLabel(p.shards[0].start_dates), "results-latest.json"));
  const rootPayload = mergePayloads([payload]); rootPayload.generated_at = NOW;
  write(path.join(a.dataDir, "results-latest.json"), rootPayload);
  const merged = merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") });
  assert.deepEqual(merged.results.scenarios[0].source_generated_at_by_location, original.source_generated_at_by_location);
  assert.deepEqual(merged.results.scenarios[0].source_run_id_by_location, original.source_run_id_by_location);
});

test("singleton index payload survives merge with canonical chunk aggregate", async () => {
  const p = api().buildPlan({ scope: buildScrapeScope({ now: NOW, startDates: [DATES[0]], durations: [2], locations: ["Warsaw", "Gdansk"] }), runId: "run-123", now: NOW });
  const item = scenario(); const a = await artifact(p, 1, [item]);
  write(path.join(a.dataDir, chunkLabel(p.shards[0].start_dates), "results-latest.json"), item);
  const aggregate = mergePayloads([item]); aggregate.generated_at = NOW; write(path.join(a.dataDir, "results-latest.json"), aggregate);
  const merged = merge({ plan: p, inputDir: inputs(a), output: path.join(temp(), "results.json") });
  assert.equal(merged.results.run_status, "success"); assert.equal(merged.results.scenarios.length, 1);
});

test("real child-process boundary writes singleton chunk and canonical aggregate without network", async () => {
  const dir = temp(); const initial = plan();
  for (const file of initial.code_fingerprint.files) {
    const target = path.join(dir, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file.path), target);
  }
  const fixture = scenario();
  fs.writeFileSync(path.join(dir, "src/runDiscovercarsChunked.js"), `
    const fs = require('fs'); const path = require('path'); const { mergePayloads } = require('./mergeDiscovercarsResults');
    const args = process.argv.slice(2); const options = Object.fromEntries(args.map(arg => { const i = arg.indexOf('='); return i < 0 ? [arg.slice(2), true] : [arg.slice(2, i), arg.slice(i + 1)]; }));
    if (!args.includes('--strategy=legacy-batch') || !args.includes('--chunk-retries=2') || args.some(arg => arg.startsWith('--retries='))) process.exit(99);
    const item = ${JSON.stringify(fixture)}; item.generated_at = new Date().toISOString();
    const chunkDir = path.join(options['output-dir'], 'chunk-01-2026-10-02-2026-10-02'); fs.mkdirSync(chunkDir, { recursive: true });
    fs.writeFileSync(path.join(chunkDir, 'results-latest.json'), JSON.stringify(item));
    fs.writeFileSync(path.join(options['output-dir'], 'results-latest.json'), JSON.stringify(mergePayloads([item])));
  `);
  const p = api().buildPlan({ scope: buildScrapeScope({ now: NOW, startDates: [DATES[0]], durations: [2], locations: ["Warsaw", "Gdansk"] }), runId: "run-123", repoRoot: dir });
  const outputDir = path.join(temp(), "raw-shard-1");
  const result = await api().runShard({ plan: p, shard: 1, outputDir, repoRoot: dir, restoreDir: path.join(dir, "missing-restore") });
  assert.equal(result.exitCode, 0, result.metadata.error); assert.equal(result.metadata.status, "success");
  const merged = api().mergeShards({ plan: p, inputDir: inputs({ outputDir }), output: path.join(temp(), "results.json"), repoRoot: dir });
  assert.equal(merged.results.scenarios.length, 1); assert.equal(merged.results.run_status, "success");
});

test("real chunk runner skips restored singleton bytes without starting index", async () => {
  const dir = temp(); const initial = plan(); const sentinel = path.join(dir, "index-started.txt");
  for (const file of initial.code_fingerprint.files) {
    const target = path.join(dir, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(root, file.path), target);
  }
  fs.writeFileSync(path.join(dir, "src/index.js"), `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'index started'); process.exit(99);`);
  const p = api().buildPlan({ scope: buildScrapeScope({ now: NOW, startDates: [DATES[0]], durations: [2], locations: ["Warsaw", "Gdansk"] }), runId: "run-123", repoRoot: dir });
  const restoreDir = path.join(temp(), "raw-shard-1"); const item = scenario(); item.generated_at = new Date().toISOString();
  const source = await api().runShard({ plan: p, shard: 1, outputDir: restoreDir, repoRoot: dir, executeRunner: async ({ outputDir: dataDir }) => {
    write(path.join(dataDir, chunkLabel(p.shards[0].start_dates), "results-latest.json"), item); return { exitCode: 0 };
  } });
  assert.equal(source.exitCode, 0, source.metadata.error);
  const sourceFile = path.join(restoreDir, source.metadata.data_dir, chunkLabel(p.shards[0].start_dates), "results-latest.json");
  const originalBytes = fs.readFileSync(sourceFile);
  const outputDir = path.join(temp(), "raw-shard-1");
  const resumed = await api().runShard({ plan: p, shard: 1, outputDir, restoreDir, repoRoot: dir });
  assert.equal(resumed.metadata.restore.reused_chunks, 1, JSON.stringify(resumed.metadata.restore));
  assert.equal(resumed.exitCode, 0, resumed.metadata.error); assert(!fs.existsSync(sentinel), "index must not start for a restored complete singleton");
  const restoredFile = path.join(outputDir, resumed.metadata.data_dir, chunkLabel(p.shards[0].start_dates), "results-latest.json");
  assert.deepEqual(fs.readFileSync(restoredFile), originalBytes); assert.deepEqual(fs.readFileSync(sourceFile), originalBytes);
  const merged = api().mergeShards({ plan: p, inputDir: inputs({ outputDir }), output: path.join(temp(), "results.json"), repoRoot: dir });
  assert.equal(merged.results.scenarios[0].generated_at, item.generated_at);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures += 1; console.error(`FAIL ${name}: ${error.stack}`); }
  }
  console.log(`Scrape shard tests: ${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
