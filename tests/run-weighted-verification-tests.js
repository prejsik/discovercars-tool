const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DiscoverCarsScraper } = require("../src/discovercars/scraper");
const { extractorCodeHash, inputFingerprint, keyOf, verifyActiveRecommendations } = require("../src/verifyActiveRecommendationsDom");
const { buildRecommendationWorkload } = require("../src/recommendationWorkload");
const { splitActiveRecommendations, mergeVerifiedRecommendationShards } = require("../src/recommendationDomShards");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-weighted-verification-"));
let sequence = 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
function base(counts) {
  return { decisions: counts.flatMap((count, index) => Array.from({ length: count }, (_, location) => ({
    action: "increase", location: `Location ${location}`, start_date: `2026-10-${String(index + 2).padStart(2, "0")}`,
    rental_days: 2, source_validation_status: "api_unverified", suggested_rate_pln_day: 110,
    maximum_import_rate_pln_day: 120, top1_provider: "Budget", top1_rate_pln_day: 100, currency: "PLN",
    top2_provider: "Avis", top2_rate_pln_day: 105, top3_provider: "Hertz", top3_rate_pln_day: 110,
    mm_provider: "MM Cars Rental", mm_rate_pln_day: 130
  }))) };
}
function history(entries) {
  const summary = { group_timing_version: 1, extractor_hash: extractorCodeHash(), group_timings: entries,
    processed_live_dom_group_count: entries.length, elapsed_ms: 1, shard_count: 1 };
  summary.group_timings_hash = inputFingerprint({ version: 1, extractor_hash: summary.extractor_hash, group_timings: entries });
  return summary;
}
function measurement(groupKey, locations, milliseconds) {
  return { group_key: groupKey, location_count: locations, elapsed_ms: milliseconds };
}
function rehashHistory(summary) {
  summary.group_timings_hash = inputFingerprint({ version: summary.group_timing_version,
    extractor_hash: summary.extractor_hash, group_timings: summary.group_timings });
}
function workload(current, previousDom) {
  return buildRecommendationWorkload({ current, previousDom, shardCount: 2 });
}
async function verify(shard, elapsed = 100) {
  const originalRun = DiscoverCarsScraper.prototype.run;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  DiscoverCarsScraper.prototype.run = async function () {
    now += elapsed;
    return { results: this.config.locations.flatMap((location) => [["Budget", 100], ["Avis", 105], ["Hertz", 110], ["MM Cars Rental", 130]]
      .map(([provider, rate]) => ({ location, provider, totalPrice: rate * 2,
        currency: "PLN", transmission: "automatic", source: "dom" }))) };
  };
  try {
    return await verifyActiveRecommendations(shard, { concurrency: 1, workDir: path.join(root, String(sequence++)) });
  } finally { DiscoverCarsScraper.prototype.run = originalRun; Date.now = realNow; }
}

async function withClock(now, run) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try { return await run(); } finally { global.Date = RealDate; }
}

test("skewed locations are weighted by distinct locations, not decision count", () => {
  const current = base([8, 1, 8, 1]);
  current.decisions.push({ ...current.decisions[0] });
  const report = workload(current);
  assert.ok(report.cost_plan, "workload must emit a frozen cost plan");
  assert.deepEqual(report.cost_plan.groups.map((group) => group.location_count), [8, 1, 8, 1]);
  assert.deepEqual(report.cost_plan.groups.map((group) => group.estimated_cost_ms), [240000, 30000, 240000, 30000]);
  assert.equal(report.estimated_worker_duration_seconds, 270);
});

test("deterministic weighted greedy lowers maximum predicted load compared with round robin", () => {
  const current = base([8, 1, 8, 1]);
  const report = workload(current);
  const shards = splitActiveRecommendations(current, 2, new Date().toISOString(), report);
  assert.deepEqual(shards.map((shard) => shard.dom_shard.group_keys),
    [["2026-10-02|2", "2026-10-03|2"], ["2026-10-04|2", "2026-10-05|2"]]);
  assert.deepEqual(report.cost_plan.shards.map((shard) => shard.estimated_cost_ms), [270000, 270000]);
  assert.ok(Math.max(...report.cost_plan.shards.map((shard) => shard.estimated_cost_ms)) < 480000);
  const repeated = splitActiveRecommendations(current, 2, shards[0].dom_shard.created_at, report);
  assert.deepEqual(repeated, shards);
  assert.equal(shards.flatMap((shard) => shard.decisions).length, 18);
  assert.equal(new Set(shards.flatMap((shard) => shard.decisions).map(keyOf)).size, 18);
});

test("valid measured group history scales changed locations and unseen groups conservatively", () => {
  const report = workload(base([4, 1]), history([measurement("2026-10-02|2", 2, 400000)]));
  assert.ok(report.cost_plan, "measured history must produce a cost plan");
  assert.deepEqual(report.cost_plan.groups.map((group) => group.estimated_cost_ms), [800000, 200000]);
  assert.equal(report.timing_source, "previous_group_timings");
  assert.equal(report.estimated_worker_duration_seconds, 800);
});

test("fast history cannot reduce the deterministic location-count floor", () => {
  const report = workload(base([4, 1]), history([measurement("2026-10-02|2", 4, 1000)]));
  assert.ok(report.cost_plan, "history must retain the location-count floor");
  assert.deepEqual(report.cost_plan.groups.map((group) => group.estimated_cost_ms), [120000, 30000]);
});

test("bare decision arrays retain workload coverage and all weighted groups", () => {
  const report = workload(base([8, 1, 8, 1]).decisions);
  assert.equal(report.pending_dom_group_count, 4);
  assert.equal(report.pending_dom_recommendation_count, 18);
  assert.equal(report.estimated_worker_duration_seconds, 270);
});

test("stale extractor in legacy history cannot raise fallback costs", () => {
  const report = workload(base([4, 1]), { extractor_hash: "old", processed_live_dom_group_count: 1,
    elapsed_ms: 400000, shard_count: 1 });
  assert.equal(report.timing_source, "default");
  assert.deepEqual(report.cost_plan.groups.map((group) => group.estimated_cost_ms), [120000, 30000]);
});

test("non-representable configured costs cannot publish a null or infinite cost plan", () => {
  assert.throws(() => buildRecommendationWorkload({ current: base([1]), defaultSecondsPerGroup: 1e308 }), /cost plan/i);
});

for (const corruption of ["hash", "code", "negative", "nonfinite", "zero locations", "duplicate", "oversize", "version"]) {
  test(`${corruption} timing history uses deterministic location-count fallback`, () => {
    const previous = history([measurement("2026-10-02|2", 2, 400000)]);
    if (corruption === "hash") previous.group_timings_hash = "bad";
    if (corruption === "code") previous.extractor_hash = "old";
    if (corruption === "negative") previous.group_timings[0].elapsed_ms = -1;
    if (corruption === "nonfinite") previous.group_timings[0].elapsed_ms = Infinity;
    if (corruption === "zero locations") previous.group_timings[0].location_count = 0;
    if (corruption === "duplicate") previous.group_timings.push({ ...previous.group_timings[0] });
    if (corruption === "oversize") previous.group_timings = Array.from({ length: 5001 }, (_, index) => measurement(`2026-10-02|${index + 1}`, 1, 100000));
    if (corruption === "version") previous.group_timing_version = 99;
    if (corruption !== "hash") rehashHistory(previous);
    const report = workload(base([4, 1]), previous);
    assert.ok(report.cost_plan, "invalid history must still produce a fallback cost plan");
    assert.deepEqual(report.cost_plan.groups.map((group) => group.estimated_cost_ms), [120000, 30000]);
    assert.equal(report.timing_source, "default");
  });
}

test("verifier measures only actual processed groups and carries bounded hashed timing metadata", async () => {
  const current = base([2, 1]);
  const result = await verify(current, 450);
  assert.deepEqual(result.dom_verification.group_timings,
    [measurement("2026-10-02|2", 2, 450), measurement("2026-10-03|2", 1, 450)]);
  assert.equal(result.dom_verification.group_timing_version, 1);
  assert.equal(result.dom_verification.group_timings_hash, history(result.dom_verification.group_timings).group_timings_hash);
  const zeroBudget = await verifyActiveRecommendations(current, { maxDurationMs: 0, workDir: path.join(root, String(sequence++)) });
  assert.deepEqual(zeroBudget.dom_verification.group_timings, []);
  assert.equal(zeroBudget.dom_verification.processed_live_dom_group_count, 0);
  assert.ok(result.dom_verification.group_timings.length <= 5000);
});

test("timing metadata caps large workloads without omitting any decisions", async () => {
  const current = { decisions: Array.from({ length: 5001 }, (_, index) => ({ ...base([1]).decisions[0], rental_days: index + 1 })) };
  const originalRun = DiscoverCarsScraper.prototype.run;
  DiscoverCarsScraper.prototype.run = async () => { throw new Error("fixture blocked search"); };
  try {
    const result = await verifyActiveRecommendations(current, { concurrency: 3, workDir: path.join(root, String(sequence++)) });
    assert.equal(result.decisions.length, 5001);
    assert.equal(result.dom_verification.processed_live_dom_group_count, 5001);
    assert.equal(result.dom_verification.group_timings.length, 5000);
    assert.equal(result.dom_verification.group_timing_truncated_count, 1);
    assert.equal(new Set(result.dom_verification.group_timings.map((entry) => entry.group_key)).size, 5000);
  } finally { DiscoverCarsScraper.prototype.run = originalRun; }
});

test("merge preserves immutable measured plan after later history changes with no data loss", async () => {
  const current = base([1, 1, 1, 1]);
  current.decisions.push({ ...current.decisions[0], action: "hold", suggested_rate_pln_day: null });
  const report = workload(current, history([measurement("2026-10-02|2", 1, 300000),
    measurement("2026-10-03|2", 1, 600000), measurement("2026-10-04|2", 1, 300000), measurement("2026-10-05|2", 1, 600000)]));
  assert.ok(report.cost_plan, "split must freeze the measured weights");
  const inputs = splitActiveRecommendations(current, 2, new Date().toISOString(), report);
  const checked = [];
  for (const input of inputs) checked.push(await verify(input));
  const later = workload(current, history([measurement("2026-10-02|2", 1, 900000)]));
  assert.notDeepEqual(later.cost_plan.shards, report.cost_plan.shards);
  const merged = mergeVerifiedRecommendationShards(current, checked, { shardCount: 2, workload: later });
  assert.equal(merged.recommendation_count, 4);
  assert.equal(merged.dom_verification.invalid_shard_count, 0);
  assert.deepEqual(merged.dom_verification.cost_plan, report.cost_plan);
  assert.deepEqual(merged.decisions.map(keyOf), current.decisions.map(keyOf));
  assert.equal(merged.decisions[4].action, "hold");
  assert.equal(merged.dom_verification.group_timings.length, 4);
  assert.equal(workload(current, merged).timing_source, "previous_group_timings");
});

test("mixed independently valid plans cannot duplicate or silently reassign membership at merge", async () => {
  const current = base([1, 1, 1, 1]);
  const fallback = workload(current);
  const measured = workload(current, history([measurement("2026-10-03|2", 1, 600000)]));
  const now = new Date().toISOString();
  const first = await verify(splitActiveRecommendations(current, 2, now, fallback)[0]);
  const second = await verify(splitActiveRecommendations(current, 2, now, measured)[1]);
  const merged = mergeVerifiedRecommendationShards(current, [first, second], { shardCount: 2 });
  assert.equal(merged.recommendation_count, 0);
  assert.equal(merged.dom_verification.invalid_shard_count, 2);
  assert.equal(merged.decisions.length, current.decisions.length);
});

test("a corrupt plan rejects only its shard regardless of order or shared split timestamp", async () => {
  const current = base([1, 1]);
  const report = workload(current);
  const inputs = splitActiveRecommendations(current, 2, new Date().toISOString(), report);
  const healthy = await verify(inputs[0]);
  const second = await verify(inputs[1]);
  for (const corruption of ["hash", "weight", "membership"]) {
    const corrupt = clone(second);
    if (corruption === "hash") corrupt.dom_shard.cost_plan.integrity_hash = "bad";
    if (corruption === "weight") corrupt.dom_shard.cost_plan.groups[0].estimated_cost_ms += 1;
    if (corruption === "membership") corrupt.dom_shard.cost_plan.shards[1].group_keys.pop();
    for (const shards of [[healthy, corrupt], [corrupt, healthy]]) {
      const merged = mergeVerifiedRecommendationShards(current, shards, { shardCount: 2 });
      assert.equal(merged.recommendation_count, 1, corruption);
      assert.equal(merged.decisions[0].dom_verification_status, "confirmed", corruption);
      assert.equal(merged.decisions[1].action, "hold", corruption);
      assert.equal(merged.dom_verification.invalid_shard_count, 1, corruption);
      assert.equal(merged.dom_verification.completed_shard_count, 1, corruption);
      assert.equal(merged.dom_verification.missing_output_count, 1, corruption);
      assert.deepEqual(merged.dom_verification.cost_plan, report.cost_plan);
    }
  }
});

for (const sharesGroup of [false, true]) {
  test(`source expiry between workload and split preserves healthy rows (${sharesGroup ? "shared" : "separate"} group)`, async () => {
    const planningTime = Date.parse("2026-10-01T12:00:00.000Z");
    const splitTime = planningTime + 2;
    const current = base([1, 1, 1]);
    Object.assign(current.decisions[0], {
      location: "Expiring location", source_validation_status: "dom_confirmed",
      source_generated_at: new Date(planningTime - 12 * 3600000 + 1).toISOString()
    });
    if (sharesGroup) current.decisions[0].start_date = current.decisions[1].start_date;
    const report = await withClock(planningTime, () => workload(current));
    assert.equal(report.pending_dom_recommendation_count, 2);
    const inputs = await withClock(splitTime, () => splitActiveRecommendations(current, 2, new Date().toISOString(), report));
    assert.deepEqual(inputs.flatMap((shard) => shard.decisions).map(keyOf).sort(), current.decisions.slice(1).map(keyOf).sort());
    const checked = [];
    for (const input of inputs) checked.push(await withClock(splitTime + 1, () => verify(input)));
    const merged = await withClock(splitTime + 2, () => mergeVerifiedRecommendationShards(current, checked, { shardCount: 2 }));
    assert.equal(merged.recommendation_count, 2);
    assert.equal(merged.decisions.length, 3);
    assert.equal(merged.decisions[0].action, "hold");
    assert.equal(merged.decisions[0].dom_verification_status, "dom_verification_shard_missing");
    assert.equal(merged.decisions[0].suggested_rate_pln_day, null);
    assert.deepEqual(merged.recommendations.map(keyOf), current.decisions.slice(1).map(keyOf));
    assert.equal(merged.dom_verification.invalid_shard_count, 0);
    assert.equal(merged.dom_verification.completed_shard_count, 2);
    assert.equal(merged.dom_verification.missing_output_count, 1);
    assert.deepEqual(merged.dom_verification.cost_plan, report.cost_plan);
  });
}

test("tampered weighted plans and missing metadata fail closed", async () => {
  const current = base([8, 1, 8, 1]);
  const report = workload(current);
  assert.ok(report.cost_plan, "split plan must be integrity checked");
  const inputs = splitActiveRecommendations(current, 2, new Date().toISOString(), report);
  const checked = await verify(inputs[0]);
  for (const corruption of ["weight", "membership", "missing plan", "hash"]) {
    const changed = clone(checked);
    if (corruption === "weight") changed.dom_shard.cost_plan.groups[0].estimated_cost_ms += 1;
    if (corruption === "membership") changed.dom_shard.cost_plan.shards[0].group_keys.pop();
    if (corruption === "missing plan") delete changed.dom_shard.cost_plan;
    if (corruption === "hash") changed.dom_shard.cost_plan.integrity_hash = "bad";
    const merged = mergeVerifiedRecommendationShards(current, [changed], { shardCount: 2 });
    assert.equal(merged.recommendation_count, 0, corruption);
    assert.equal(merged.dom_verification.invalid_shard_count, 1, corruption);
  }
  const altered = clone(report);
  altered.cost_plan.groups[0].location_count = 99;
  assert.throws(() => splitActiveRecommendations(current, 2, new Date().toISOString(), altered), /cost plan/i);
  assert.throws(() => splitActiveRecommendations(current, 3, new Date().toISOString(), report), /cost plan/i);
});

test("rehashing a duplicate, missing or reassigned group cannot bypass plan membership checks", () => {
  const current = base([8, 1, 8, 1]);
  for (const corruption of ["duplicate", "missing", "reassigned"]) {
    const report = clone(workload(current));
    const plan = report.cost_plan;
    if (corruption === "duplicate") plan.groups[1] = { ...plan.groups[0] };
    if (corruption === "missing") plan.groups.pop();
    if (corruption === "reassigned") plan.shards[1].group_keys.push(plan.shards[0].group_keys.pop());
    const { integrity_hash, ...content } = plan;
    plan.integrity_hash = inputFingerprint(content);
    assert.throws(() => splitActiveRecommendations(current, 2, new Date().toISOString(), report), /cost plan/i, corruption);
  }
});

test("merge still rejects invalid shard-count configuration even with no outputs", () => {
  for (const shardCount of [0, 17, NaN, 1.5]) {
    assert.throws(() => mergeVerifiedRecommendationShards(base([1]), [], { shardCount }), /shardCount/);
  }
});

test("CLI accepts workload, needs no merge history flag, and falls back for corrupt history JSON", async () => {
  const dir = path.join(root, String(sequence++));
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "input.json");
  const previous = path.join(dir, "previous.json");
  const output = path.join(dir, "recommendation-workload.json");
  fs.writeFileSync(input, JSON.stringify(base([8, 1, 8, 1])));
  fs.writeFileSync(previous, "{corrupt");
  const cwd = path.resolve(__dirname, "..");
  const run = spawnSync(process.execPath, ["src/recommendationWorkload.js", `--current=${input}`,
    `--previous-dom=${previous}`, `--output=${output}`, "--shard-count=2"], { cwd, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.timing_source, "default");
  const split = spawnSync(process.execPath, ["src/recommendationDomShards.js", "split", `--input=${input}`,
    `--output-dir=${path.join(dir, "shards")}`, `--workload=${output}`], { cwd, encoding: "utf8" });
  assert.equal(split.status, 0, split.stderr);
  const first = JSON.parse(fs.readFileSync(path.join(dir, "shards", "shard-0-input.json"), "utf8"));
  assert.equal(first.dom_shard.count, 2);
  assert.deepEqual(first.dom_shard.cost_plan, report.cost_plan);
  assert.deepEqual(JSON.parse(split.stdout).input_counts, [9, 9]);
  for (let index = 0; index < 2; index += 1) {
    const shard = JSON.parse(fs.readFileSync(path.join(dir, "shards", `shard-${index}-input.json`), "utf8"));
    fs.writeFileSync(path.join(dir, "shards", `shard-${index}-output.json`), JSON.stringify(await verify(shard)));
  }
  const mergedPath = path.join(dir, "merged.json");
  const merge = spawnSync(process.execPath, ["src/recommendationDomShards.js", "merge", `--base=${input}`,
    `--shards-dir=${path.join(dir, "shards")}`, `--output=${mergedPath}`, "--shard-count=2"], { cwd, encoding: "utf8" });
  assert.equal(merge.status, 0, merge.stderr);
  const merged = JSON.parse(fs.readFileSync(mergedPath, "utf8"));
  assert.equal(merged.recommendation_count, 18);
  assert.deepEqual(merged.dom_verification.cost_plan, report.cost_plan);
});

(async () => {
  let failures = 0;
  try {
    for (const { name, run } of tests) {
      try { await run(); console.log(`PASS ${name}`); }
      catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
    }
    console.log(`${tests.length - failures}/${tests.length} weighted verification tests passed`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  if (failures) process.exitCode = 1;
})();
