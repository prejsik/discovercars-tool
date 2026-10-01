const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { chromium } = require("playwright");
const { DiscoverCarsScraper } = require("../src/discovercars/scraper");
const { verifyActiveRecommendations } = require("../src/verifyActiveRecommendationsDom");
const { buildRecommendationWorkload } = require("../src/recommendationWorkload");
const { splitActiveRecommendations, mergeVerifiedRecommendationShards } = require("../src/recommendationDomShards");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-verification-resume-"));
let sequence = 0;
function item(overrides = {}) {
  return {
    action: "increase", location: "Warsaw Airport", start_date: "2026-10-02", rental_days: 2,
    source_validation_status: "api_unverified", suggested_rate_pln_day: 110,
    maximum_import_rate_pln_day: 120, top1_provider: "Budget", top1_rate_pln_day: 100,
    top2_provider: "Avis", top2_rate_pln_day: 105, top3_provider: "Hertz", top3_rate_pln_day: 110,
    mm_provider: "MM Cars Rental", mm_rate_pln_day: 130,
    currency: "PLN", ...overrides
  };
}
function options(overrides = {}) {
  return { workDir: path.join(root, String(sequence++)), concurrency: 1, speedMode: "fast", ...overrides };
}
function offers(config) {
  const days = (Date.parse(config.dropoffDate) - Date.parse(config.pickupDate)) / 86400000;
  return {
    results: config.locations.flatMap((location) => [["Budget", 100], ["Avis", 105], ["Hertz", 110], ["MM Cars Rental", 130]]
      .map(([provider, rate]) => ({ location, provider, totalPrice: rate * days,
        currency: "PLN", transmission: "automatic", source: "dom" })))
  };
}
async function withScrape(run, body) {
  const original = DiscoverCarsScraper.prototype.run;
  DiscoverCarsScraper.prototype.run = run;
  try { return await body(); } finally { DiscoverCarsScraper.prototype.run = original; }
}
function readCheckpoint(opts) {
  const checkpointPath = opts.checkpointPath || path.join(opts.workDir, "checkpoint.json");
  assert.ok(fs.existsSync(checkpointPath), "completed DOM verification must persist a checkpoint");
  return JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
}
async function completedShard(base, count = 1) {
  return verifyShard(splitActiveRecommendations(base, count)[0]);
}

async function verifyShard(shard) {
  return withScrape(async function () { return offers(this.config); },
    () => verifyActiveRecommendations(shard, options()));
}

async function withClock(now, run) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try { return await run(); } finally { global.Date = RealDate; }
}

test("timestamp-free source tags cannot bypass a zero verification budget", async () => {
  const base = { decisions: [item({ source_validation_status: "dom_confirmed" })] };
  const output = await verifyActiveRecommendations(base, options({ maxDurationMs: 0 }));
  assert.equal(output.recommendation_count, 0);
  assert.equal(output.dom_verification.reused_existing_dom_count, 0);
  assert.equal(splitActiveRecommendations(base, 1)[0].decisions.length, 1);
  assert.equal(buildRecommendationWorkload({ current: base }).pending_dom_recommendation_count, 1);
});

for (const field of ["summary", "input_fingerprint", "extractor_hash", "started_at", "completed_at"]) {
  test(`merge rejects a completed shard missing ${field}`, async () => {
    const base = { decisions: [item()] };
    const checked = await verifyShard(splitActiveRecommendations(base, 1)[0]);
    if (field === "summary") delete checked.dom_verification;
    else delete checked.dom_verification[field];
    const output = mergeVerifiedRecommendationShards(base, [checked], { shardCount: 1 });
    assert.equal(output.recommendation_count, 0);
    assert.equal(output.dom_verification.invalid_shard_count, 1);
  });
}

for (const corruption of ["missing timestamp", "null timestamp", "conflict reasons", "missing reasons", "wrong input hash"]) {
  test(`merge rejects ${corruption} rather than inventing a confirmation`, async () => {
    const base = { decisions: [item({ source_generated_at: new Date().toISOString() })] };
    const checked = await verifyShard(splitActiveRecommendations(base, 1)[0]);
    if (corruption === "missing timestamp") delete checked.decisions[0].dom_verified_at;
    if (corruption === "null timestamp") checked.decisions[0].dom_verified_at = null;
    if (corruption === "conflict reasons") checked.decisions[0].dom_verification_reasons = ["provider_price_mismatch"];
    if (corruption === "missing reasons") delete checked.decisions[0].dom_verification_reasons;
    if (corruption === "wrong input hash") checked.dom_verification.input_fingerprint = "different-input";
    const output = mergeVerifiedRecommendationShards(base, [checked], { shardCount: 1 });
    assert.equal(output.recommendation_count, 0);
    assert.equal(output.decisions[0].action, "hold");
    assert.equal(output.decisions[0].suggested_rate_pln_day, null);
  });
}

test("source expiry at merge blocks only that row and preserves other completed shards", async () => {
  const now = Date.now();
  const base = { decisions: [
    item({ start_date: "2026-10-01", source_validation_status: "dom_confirmed",
      source_generated_at: new Date(now - 12 * 3600000 + 1000).toISOString() }),
    item(), item({ start_date: "2026-10-03" })
  ] };
  const shards = splitActiveRecommendations(base, 4);
  assert.deepEqual(shards.map((shard) => shard.decisions.length), [1, 1, 0, 0]);
  const checked = [];
  for (const shard of shards) checked.push(await verifyShard(shard));
  const realNow = Date.now;
  Date.now = () => now + 2000;
  try {
    const output = mergeVerifiedRecommendationShards(base, checked, { shardCount: 4 });
    assert.equal(output.decisions[0].action, "hold");
    assert.equal(output.decisions[0].suggested_rate_pln_day, null);
    assert.equal(output.recommendation_count, 2);
    assert.equal(output.dom_verification.invalid_shard_count, 0);
    assert.deepEqual(output.recommendations.map((decision) => decision.start_date), ["2026-10-02", "2026-10-03"]);
  } finally { Date.now = realNow; }
});

test("source evidence expiring during verification is blocked before returning", async () => {
  const now = Date.now();
  const base = { decisions: [
    item({ source_validation_status: "dom_confirmed", source_generated_at: new Date(now - 12 * 3600000 + 1000).toISOString() }),
    item({ start_date: "2026-10-03" })
  ] };
  const realNow = Date.now;
  try {
    await withScrape(async function () {
      Date.now = () => now + 2000;
      return offers(this.config);
    }, async () => {
      const output = await verifyActiveRecommendations(base, options());
      assert.equal(output.decisions[0].action, "hold");
      assert.equal(output.recommendation_count, 1);
    });
  } finally { Date.now = realNow; }
});

test("two-hour checkpoint reuse and twelve-hour current-run evidence have independent boundaries", async () => {
  const now = Date.now();
  const base = { decisions: [item()] };
  const input = await withClock(now, () => splitActiveRecommendations(base, 1)[0]);
  const opts = options();
  let checked;
  await withScrape(async function () { return offers(this.config); }, async () => {
    checked = await withClock(now, () => verifyActiveRecommendations(input, opts));
    const resumed = await withClock(now + 7200000,
      () => verifyActiveRecommendations(input, { ...opts, maxDurationMs: 0 }));
    assert.equal(resumed.recommendation_count, 1);
    assert.equal(resumed.dom_verification.reused_checkpoint_count, 1);
    const expired = await withClock(now + 7200001,
      () => verifyActiveRecommendations(input, { ...opts, maxDurationMs: 0 }));
    assert.equal(expired.recommendation_count, 0);
    assert.equal(expired.dom_verification.reused_checkpoint_count, 0);
  });
  const current = await withClock(now + 43200000,
    () => mergeVerifiedRecommendationShards(base, [checked], { shardCount: 1 }));
  assert.equal(current.recommendation_count, 1);
  const stale = await withClock(now + 43200001,
    () => mergeVerifiedRecommendationShards(base, [checked], { shardCount: 1 }));
  assert.equal(stale.recommendation_count, 0);
});

test("one shared browser closes after isolated location contexts, with DOM-only config", async () => {
  const originals = {
    launch: chromium.launch, configure: DiscoverCarsScraper.prototype.configureContext,
    direct: DiscoverCarsScraper.prototype.tryDirectSearchFlow
  };
  let launches = 0;
  let closed = 0;
  let contextsClosed = 0;
  const contexts = [];
  chromium.launch = async () => {
    launches += 1;
    return {
      isConnected: () => true,
      newContext: async () => {
        const context = {
          newPage: async () => ({ setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, on() {} }),
          close: async () => { contextsClosed += 1; }
        };
        contexts.push(context);
        return context;
      },
      close: async () => { closed += 1; }
    };
  };
  DiscoverCarsScraper.prototype.configureContext = async () => {};
  DiscoverCarsScraper.prototype.tryDirectSearchFlow = async function (_page, location) {
    assert.equal(this.config.domOnly, true);
    assert.equal(this.config.apiFirst, false);
    assert.deepEqual(this.config.requiredDomProvidersByLocation[location], ["Budget", "Avis", "Hertz", "MM Cars Rental"]);
    return offers(this.config).results.filter((offer) => offer.location === location);
  };
  try {
    const output = await verifyActiveRecommendations({ decisions: [item(), item({ start_date: "2026-10-03" })] }, options());
    assert.equal(output.recommendation_count, 2);
    assert.equal(launches, 1);
    assert.equal(closed, 1);
    assert.equal(contexts.length, 2);
    assert.notEqual(contexts[0], contexts[1]);
    assert.equal(contextsClosed, 2);
  } finally {
    chromium.launch = originals.launch;
    DiscoverCarsScraper.prototype.configureContext = originals.configure;
    DiscoverCarsScraper.prototype.tryDirectSearchFlow = originals.direct;
  }
});

test("fresh completed checkpoint resumes in a new CLI process without a browser or network", async () => {
  const opts = options();
  const payload = { decisions: [item()] };
  await withScrape(async function () { return offers(this.config); }, async () => {
    const first = await verifyActiveRecommendations(payload, opts);
    assert.equal(first.recommendation_count, 1);
  });
  const input = path.join(opts.workDir, "input.json");
  const output = path.join(opts.workDir, "output.json");
  fs.mkdirSync(opts.workDir, { recursive: true });
  fs.writeFileSync(input, JSON.stringify(payload));
  const cli = spawnSync(process.execPath, ["src/verifyActiveRecommendationsDom.js", `--input=${input}`,
    `--output=${output}`, `--checkpoint=${path.join(opts.workDir, "checkpoint.json")}`, "--max-duration-ms=0"],
  { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const resumed = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(resumed.recommendation_count, 1);
  assert.equal(resumed.dom_verification.processed_live_dom_group_count, 0);
  assert.equal(resumed.dom_verification.reused_checkpoint_count, 1);
  assert.equal(resumed.dom_verification.budget_exhausted, false);
});

test("checkpoint is atomic and persisted after each completed group before the next starts", async () => {
  const opts = options();
  let calls = 0;
  await withScrape(async function () {
    if (calls++ === 1) {
      const checkpoint = readCheckpoint(opts);
      assert.equal(Object.keys(checkpoint.entries).length, 1);
      assert.deepEqual(fs.readdirSync(opts.workDir), ["checkpoint.json"]);
    }
    return offers(this.config);
  }, async () => {
    const output = await verifyActiveRecommendations({ decisions: [item(), item({ start_date: "2026-10-03" })] }, opts);
    assert.equal(output.recommendation_count, 2);
    assert.equal(Object.keys(readCheckpoint(opts).entries).length, 2);
  });
});

test("changed input cannot restore old suggested rates or confirmed decisions", async () => {
  const opts = options();
  let calls = 0;
  await withScrape(async function () { calls += 1; return offers(this.config); }, async () => {
    await verifyActiveRecommendations({ decisions: [item()] }, opts);
    const changed = await verifyActiveRecommendations({ decisions: [item({ suggested_rate_pln_day: 117 })] }, opts);
    assert.equal(calls, 2);
    assert.equal(changed.decisions[0].suggested_rate_pln_day, 117);
    assert.equal(changed.dom_verification.reused_checkpoint_count, 0);
  });
});

test("stale source-confirmed rows require a live recheck, including payload-level timestamps", async () => {
  const yesterday = new Date(Date.now() - 24 * 3600000).toISOString();
  for (const payload of [
    { decisions: [item({ source_validation_status: "dom_confirmed", source_generated_at: yesterday })] },
    { decisions: [item({ source_validation_status: "dom_confirmed", dom_verified_at: yesterday })] },
    { source_generated_at: yesterday, decisions: [item({ source_validation_status: "dom_confirmed" })] }
  ]) {
    let calls = 0;
    await withScrape(async function () { calls += 1; return offers(this.config); }, async () => {
      const output = await verifyActiveRecommendations(payload, options());
      assert.equal(calls, 1);
      assert.equal(output.dom_verification.reused_existing_dom_count, 0);
      assert.equal(output.recommendation_count, 1);
      assert.equal(buildRecommendationWorkload({ current: payload }).pending_dom_recommendation_count, 1);
      assert.equal(splitActiveRecommendations(payload, 1)[0].decisions.length, 1);
    });
  }
});

test("a recent explicit DOM confirmation can supersede an older source timestamp", async () => {
  await withScrape(async () => { throw new Error("existing recent DOM evidence needs no network"); }, async () => {
    const output = await verifyActiveRecommendations({ decisions: [item({
      source_validation_status: "dom_confirmed", source_generated_at: new Date(Date.now() - 24 * 3600000).toISOString(),
      dom_verified_at: new Date().toISOString()
    })] }, options({ maxDurationMs: 0 }));
    assert.equal(output.recommendation_count, 1);
    assert.equal(output.dom_verification.reused_existing_dom_count, 1);
    assert.equal(output.dom_verification.live_dom_check_count, 0);
  });
});

test("fresh recheck of a stale immutable input can merge, but cannot reuse yesterday's source tag", async () => {
  const yesterday = new Date(Date.now() - 24 * 3600000).toISOString();
  const base = { generated_at: yesterday, decisions: [item({ source_generated_at: yesterday, source_validation_status: "dom_confirmed" })] };
  let calls = 0;
  await withScrape(async function () { calls += 1; return offers(this.config); }, async () => {
    const shard = splitActiveRecommendations(base, 1)[0];
    const checked = await verifyActiveRecommendations(shard, options());
    assert.equal(calls, 1);
    assert.equal(mergeVerifiedRecommendationShards(base, [checked], { shardCount: 1 }).recommendation_count, 1);
  });
});

test("provider-level recommendation summary compares genuine DOM top three plus MM without inventing model identity", async () => {
  const decision = item({ top2_provider: "Avis", top2_rate_pln_day: 105,
    top3_provider: "Hertz", top3_rate_pln_day: 110, mm_provider: "MM Cars Rental", mm_rate_pln_day: 130 });
  await withScrape(async function () {
    return { results: [["Budget", 200], ["Avis", 210], ["Hertz", 220], ["Other", 240], ["MM Cars Rental", 260]]
      .map(([provider, totalPrice]) => ({ provider, totalPrice, location: "Warsaw Airport", currency: "PLN",
        transmission: "automatic", carName: "Actual rendered model", source: "dom" })) };
  }, async () => {
    const output = await verifyActiveRecommendations({ decisions: [decision] }, options());
    assert.equal(output.recommendation_count, 1);
    assert.equal(output.decisions[0].suggested_rate_pln_day, 110);
  });
});

test("API or unknown transmission evidence never checkpoints a blocked comparison", async () => {
  for (const invalid of [{ source: "api" }, { transmission: null }]) {
    const opts = options();
    await withScrape(async function () {
      return { results: offers(this.config).results.map((offer) => ({ ...offer, ...invalid })) };
    }, async () => {
      const output = await verifyActiveRecommendations({ decisions: [item()] }, opts);
      assert.equal(output.recommendation_count, 0);
      assert.ok(!fs.existsSync(path.join(opts.workDir, "checkpoint.json")));
    });
  }
});

test("mixed currency in a later rendered offer cannot disappear before comparison", async () => {
  await withScrape(async function () {
    return { results: [...offers(this.config).results, { provider: "Other", totalPrice: 1000,
      currency: "EUR", location: "Warsaw Airport", source: "dom", transmission: "automatic" }] };
  }, async () => {
    const output = await verifyActiveRecommendations({ decisions: [item()] }, options());
    assert.equal(output.recommendation_count, 0);
  });
});

test("explicitly unconfirmed comparator output cannot be treated as confirmed", async () => {
  const original = DiscoverCarsScraper.prototype.compareApiAndBrowserOutcomes;
  DiscoverCarsScraper.prototype.compareApiAndBrowserOutcomes = () => ({ confirmed: false, complete: false, reasons: [] });
  try {
    await withScrape(async function () { return offers(this.config); }, async () => {
      const output = await verifyActiveRecommendations({ decisions: [item()] }, options());
      assert.equal(output.recommendation_count, 0);
    });
  } finally { DiscoverCarsScraper.prototype.compareApiAndBrowserOutcomes = original; }
});

for (const invalidation of ["old", "future", "code", "corrupt", "tampered"]) {
  test(`${invalidation} checkpoint is ignored and never restores confirmation`, async () => {
    const opts = options();
    const payload = { decisions: [item()] };
    let calls = 0;
    await withScrape(async function () { calls += 1; return offers(this.config); }, async () => {
      await verifyActiveRecommendations(payload, opts);
      const file = path.join(opts.workDir, "checkpoint.json");
      const checkpoint = readCheckpoint(opts);
      if (invalidation === "corrupt") fs.writeFileSync(file, "{bad");
      else {
        if (invalidation === "code") checkpoint.extractor_hash = "outdated-extractor";
        if (invalidation === "old" || invalidation === "future") {
          for (const entry of Object.values(checkpoint.entries)) {
            entry.verified_at = new Date(Date.now() + (invalidation === "old" ? -7200001 : 60000)).toISOString();
          }
        }
        if (invalidation === "tampered") Object.values(checkpoint.entries)[0].status = "api_dom_conflict";
        if (invalidation !== "tampered") {
          const { integrity_hash, ...content } = checkpoint;
          checkpoint.integrity_hash = crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
        }
        fs.writeFileSync(file, JSON.stringify(checkpoint));
      }
      const next = await verifyActiveRecommendations(payload, opts);
      assert.equal(calls, 2);
      assert.equal(next.dom_verification.reused_checkpoint_count, 0);
    });
  });
}

test("failed locations retry while completed locations resume without being scraped again", async () => {
  const opts = options();
  const payload = { decisions: [item(), item({ location: "Gdansk Airport" })] };
  const locations = [];
  await withScrape(async function () {
    locations.push(this.config.locations);
    return locations.length === 1 ? { results: offers(this.config).results.filter((offer) => offer.location === "Warsaw Airport") } : offers(this.config);
  }, async () => {
    const first = await verifyActiveRecommendations(payload, opts);
    assert.equal(first.dom_verification.blocked_count, 1);
    const second = await verifyActiveRecommendations(payload, opts);
    assert.equal(second.recommendation_count, 2);
    assert.deepEqual(locations, [["Warsaw Airport", "Gdansk Airport"], ["Gdansk Airport"]]);
    assert.equal(second.dom_verification.reused_checkpoint_count, 1);
    assert.equal(first.dom_verification.group_timings[0].location_count, 2);
    assert.equal(second.dom_verification.group_timings[0].location_count, 1);
  });
});

test("blocked scraper errors are retried and never counted as checkpoint confirmations", async () => {
  const opts = options();
  let calls = 0;
  await withScrape(async function () {
    if (++calls === 1) throw new Error("blocked");
    return offers(this.config);
  }, async () => {
    const payload = { decisions: [item()] };
    const first = await verifyActiveRecommendations(payload, opts);
    assert.equal(first.recommendation_count, 0);
    const second = await verifyActiveRecommendations(payload, opts);
    assert.equal(second.recommendation_count, 1);
    assert.equal(calls, 2);
    assert.equal(second.dom_verification.reused_checkpoint_count, 0);
  });
});

test("input holds sharing a search key cannot be overwritten by active confirmations", async () => {
  await withScrape(async function () { return offers(this.config); }, async () => {
    const output = await verifyActiveRecommendations({ decisions: [item(), item({ action: "hold", suggested_rate_pln_day: null })] }, options());
    assert.equal(output.decisions[1].action, "hold");
    assert.equal(output.recommendation_count, 1);
  });
});

test("unfinished groups remain budget-blocked while completed checkpoint survives", async () => {
  const opts = options({ maxDurationMs: 40 });
  const payload = { decisions: [item(), item({ start_date: "2026-10-03" })] };
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await withScrape(async function () {
      now += 60;
      return offers(this.config);
    }, async () => {
      const output = await verifyActiveRecommendations(payload, opts);
      assert.equal(output.dom_verification.processed_live_dom_group_count, 1);
      assert.equal(output.dom_verification.budget_exhausted_count, 1);
      assert.equal(output.dom_verification.elapsed_ms, 60);
      assert.deepEqual(output.dom_verification.group_timings, [{ group_key: "2026-10-02|2", location_count: 1, elapsed_ms: 60 }]);
      const resumed = await verifyActiveRecommendations(payload, { ...opts, maxDurationMs: 0 });
      assert.equal(resumed.dom_verification.reused_checkpoint_count, 1);
      assert.equal(resumed.decisions[1].dom_verification_status, "dom_verification_budget_exhausted");
    });
  } finally { Date.now = realNow; }
});

test("adaptive shard plan bounds worker duration and includes four-runner queue waves", () => {
  const current = { decisions: Array.from({ length: 600 }, (_, index) => item({ rental_days: index + 1 })) };
  const report = buildRecommendationWorkload({ current, defaultSecondsPerGroup: 90 });
  assert.equal(report.shard_count, 10);
  assert.deepEqual(report.matrix, { shard: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  assert.equal(report.estimated_worker_duration_seconds, 5400);
  assert.equal(report.estimated_dom_duration_seconds, 16200);
  assert.equal(report.estimated_runner_waves, 3);
  assert.equal(report.max_parallel, 4);
});

test("workload and split CLIs emit the same workflow matrix and bounded shard count", () => {
  const dir = options().workDir;
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "input.json");
  const output = path.join(dir, "workload.json");
  fs.writeFileSync(input, JSON.stringify({ decisions: Array.from({ length: 600 }, (_, index) => item({ rental_days: index + 1 })) }));
  const cwd = path.resolve(__dirname, "..");
  const workload = spawnSync(process.execPath, ["src/recommendationWorkload.js", `--current=${input}`,
    `--output=${output}`, "--default-seconds-per-group=90"], { cwd, encoding: "utf8" });
  assert.equal(workload.status, 0, workload.stderr);
  const report = JSON.parse(workload.stdout);
  assert.equal(report.shard_count, 10);
  assert.deepEqual(report.matrix, { shard: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), report);
  const split = spawnSync(process.execPath, ["src/recommendationDomShards.js", "split", `--input=${input}`,
    `--output-dir=${path.join(dir, "shards")}`, "--shard-count=10"], { cwd, encoding: "utf8" });
  assert.equal(split.status, 0, split.stderr);
  const plan = JSON.parse(split.stdout);
  assert.equal(plan.shard_count, 10);
  assert.deepEqual(plan.matrix, report.matrix);
  assert.deepEqual(plan.input_counts, [60, 60, 60, 60, 60, 60, 60, 60, 60, 60]);
});

test("shard plan uses min four when possible, small plans avoid empties, huge plans cap at sixteen", () => {
  for (const [groups, count] of [[0, 1], [2, 2], [4, 4], [5000, 16]]) {
    const report = buildRecommendationWorkload({
      current: { decisions: Array.from({ length: groups }, (_, index) => item({ rental_days: index + 1 })) },
      defaultSecondsPerGroup: 90
    });
    assert.equal(report.shard_count, count);
    assert.equal(report.matrix.shard.length, count);
  }
  assert.throws(() => splitActiveRecommendations({ decisions: [item()] }, 17), /16/);
});

test("slow small workloads never create empty adaptive shards", () => {
  const report = buildRecommendationWorkload({ current: { decisions: [item(), item({ rental_days: 3 })] }, defaultSecondsPerGroup: 20000 });
  assert.equal(report.shard_count, 2);
  assert.equal(report.over_budget, true);
});

test("forecast uses measured slow shard throughput, not average underestimation", () => {
  const report = buildRecommendationWorkload({
    current: { decisions: Array.from({ length: 20 }, (_, index) => item({ rental_days: index + 1 })) },
    previousDom: { dom_verification: { shard_count: 4, elapsed_ms: 600000, processed_live_dom_group_count: 40,
      shards: [{ processed_live_dom_group_count: 5, elapsed_ms: 600000 },
        { processed_live_dom_group_count: 15, elapsed_ms: 60000 }] } }
  });
  assert.equal(report.estimated_seconds_per_group, 120);
  assert.equal(report.timing_source, "previous_run");
});

test("shard merge rejects outputs from a different input even if search keys match", async () => {
  const base = { decisions: [item()] };
  const stale = await completedShard(base);
  const changed = { decisions: [item({ suggested_rate_pln_day: 119 })] };
  const merged = mergeVerifiedRecommendationShards(changed, [stale], { shardCount: 1 });
  assert.equal(merged.recommendation_count, 0);
  assert.equal(merged.decisions[0].suggested_rate_pln_day, null);
  assert.equal(merged.dom_verification.invalid_shard_count, 1);
});

test("shard merge refuses rate mutation, stale extractor and stale completion", async () => {
  const base = { decisions: [item()] };
  for (const corruption of ["rate", "code", "age"]) {
    const shard = await completedShard(base);
    if (corruption === "rate") shard.decisions[0].suggested_rate_pln_day = 999;
    if (corruption === "code") shard.dom_shard.extractor_hash = "old";
    if (corruption === "age") shard.dom_shard.created_at = new Date(Date.now() - 43200001).toISOString();
    assert.equal(mergeVerifiedRecommendationShards(base, [shard], { shardCount: 1 }).recommendation_count, 0);
  }
});

test("duplicate shard index is rejected even when duplicate payload omits decisions", async () => {
  const base = { decisions: [item()] };
  const shard = await completedShard(base);
  const merged = mergeVerifiedRecommendationShards(base, [shard, { ...shard, decisions: [] }], { shardCount: 1 });
  assert.equal(merged.recommendation_count, 0);
  assert.equal(merged.dom_verification.duplicate_output_count, 1);
});

test("valid hashed split and verified output merge while missing outputs fail closed", async () => {
  const base = { decisions: [item(), item({ rental_days: 3 })] };
  const shard = await completedShard(base, 2);
  const merged = mergeVerifiedRecommendationShards(base, [shard], { shardCount: 2 });
  assert.equal(merged.recommendation_count, 1);
  assert.equal(merged.dom_verification.missing_output_count, 1);
  assert.equal(merged.dom_verification.completed_shard_count, 1);
});

test("queued shard with an old split timestamp still accepts newly completed individual checks", async () => {
  const base = { decisions: [item()] };
  const input = await withClock(Date.now() - 7200001, () => splitActiveRecommendations(base, 1)[0]);
  const checked = await verifyShard(input);
  assert.equal(mergeVerifiedRecommendationShards(base, [checked], { shardCount: 1 }).recommendation_count, 1);
});

test("multi-wave current-run checks survive a four-hour merge but previous-day evidence is rejected", async () => {
  const base = { generated_at: new Date().toISOString(), decisions: [item(), item({ rental_days: 3 })] };
  const fourHoursAgo = Date.now() - 4 * 3600000 - 1000;
  const inputs = await withClock(fourHoursAgo, () => splitActiveRecommendations(base, 8));
  const shards = [await withClock(fourHoursAgo, () => verifyShard(inputs[0]))];
  for (const input of inputs.slice(1)) shards.push(await verifyShard(input));
  assert.equal(mergeVerifiedRecommendationShards(base, shards, { shardCount: 8 }).recommendation_count, 2);
  shards[0].decisions[0].dom_verified_at = new Date(Date.now() - 24 * 3600000).toISOString();
  assert.equal(mergeVerifiedRecommendationShards(base, shards, { shardCount: 8 }).recommendation_count, 1);
});

test("malformed shard metadata fails closed rather than crashing merge", async () => {
  const base = { decisions: [item()] };
  const shard = await completedShard(base);
  delete shard.dom_shard.group_keys;
  const output = mergeVerifiedRecommendationShards(base, [shard], { shardCount: 1 });
  assert.equal(output.recommendation_count, 0);
  assert.equal(output.dom_verification.invalid_shard_count, 1);
});

test("partial checkpoint resume retains processed versus skipped group budget semantics in merge", async () => {
  const base = { decisions: [item(), item({ rental_days: 3 })] };
  const shard = splitActiveRecommendations(base, 1)[0];
  const opts = options();
  await withScrape(async function () { return offers(this.config); }, async () => {
    await verifyActiveRecommendations(shard, opts);
    const resumed = await verifyActiveRecommendations(shard, { ...opts, maxDurationMs: 0 });
    const output = mergeVerifiedRecommendationShards(base, [resumed], { shardCount: 1 });
    assert.equal(output.recommendation_count, 2);
    assert.equal(output.dom_verification.reused_checkpoint_count, 2);
    assert.equal(output.dom_verification.processed_live_dom_group_count, 0);
    assert.equal(output.dom_verification.skipped_live_dom_group_count, 0);
    assert.equal(output.dom_verification.budget_exhausted, false);
    assert.deepEqual(resumed.dom_verification.group_timings, []);
    assert.deepEqual(output.dom_verification.group_timings, []);
  });
});

test("shared browser closes in finally when scraper throws", async () => {
  const originalLaunch = chromium.launch;
  let closed = 0;
  chromium.launch = async () => ({ isConnected: () => true, close: async () => { closed += 1; } });
  try {
    await withScrape(async function () {
      assert.ok(this.config.browserProvider, "verifier must share its browser provider");
      await this.config.browserProvider.getBrowser();
      throw new Error("fixture scrape failure");
    }, async () => {
      const output = await verifyActiveRecommendations({ decisions: [item()] }, options());
      assert.equal(output.recommendation_count, 0);
      assert.equal(output.decisions[0].dom_verification_status, "dom_recommendation_failed");
      assert.equal(closed, 1);
    });
  } finally { chromium.launch = originalLaunch; }
});

(async () => {
  let failures = 0;
  try {
    for (const { name, run } of tests) {
      try { await run(); console.log(`PASS ${name}`); }
      catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
    }
    console.log(`${tests.length - failures}/${tests.length} verification resume tests passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failures) process.exitCode = 1;
})();
