const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildPricingRecommendations, DEFAULT_OPTIONS } = require("../src/pricingRecommendations");
const { DiscoverCarsScraper } = require("../src/discovercars/scraper");
const { isSourceVerified, verifyActiveRecommendations } = require("../src/verifyActiveRecommendationsDom");
const { mergeVerifiedRecommendationShards, splitActiveRecommendations } = require("../src/recommendationDomShards");
const { mergePricingRecommendations } = require("../src/mergePricingRecommendations");
const { loadLocationRegistry } = require("../src/locationRegistry");

const location = "Gdansk Airport (GDN)";
const date = "2026-11-03";
const registry = loadLocationRegistry();

function pricingOptions(changes = {}) {
  return {
    ...DEFAULT_OPTIONS,
    bestAvailableRank: true,
    recommendedFallbackToMinimum: true,
    apiOnlyConstraintRentalDays: [9],
    recommendedWindowStartDate: date,
    locationTypeFloorsPlnDay: {
      groups: ["GRP1"], minDays: 8, maxDays: 14,
      minimumRatesByKind: { airport: 250, city: 250 }
    },
    locationRegistry: registry,
    excelPolicy: {
      apply_groups: ["GRP1"], excluded_groups: [], protected_rate_periods: [],
      group_price_parity: { premium_adjustments_pln_day: {} }
    },
    brokerMarkupCalibration: {
      enabled: true, manualOnly: true, model: "fixed_amount",
      locationDurationAmounts: { [location]: { "8-20": 0 } },
      groupSupplementsPlnDay: { GRP1: 0 }
    },
    ...changes
  };
}

function pendingInput(changes = {}) {
  const generatedAt = new Date().toISOString();
  const days = 9;
  const offer = (provider_name, rate) => ({ provider_name, total_price: rate * days,
    rental_days: days, currency: "PLN", transmission: "automatic" });
  const payload = {
    generated_at: generatedAt,
    run_id: "repair-source-run",
    locations: [location],
    scenarios: [{ scenario_id: `${date}/${days}`, start_date: date, pickup_date: date,
      rental_days: days, group: "GRP1",
      top_3_plus_mm_by_location: { [location]: {
        top_3: [offer("Budget", 200), offer("Avis", 210), offer("Hertz", 220)],
        mm_cars_rental: offer("MM Cars Rental", 100)
      } },
      source_validation_by_location: { [location]: {
        status: "api_dom_conflict_api_used", reasons: ["api_dom_conflict"]
      } }
    }]
  };
  return buildPricingRecommendations(payload, pricingOptions(changes));
}

function domOutput({ recommendedProvider = "Budget" } = {}) {
  const offers = [["Budget", 200], ["MM Cars Rental", 300]].map(([provider, rate]) => ({
    provider, totalPrice: rate * 9, location, currency: "PLN", transmission: "automatic", source: "dom"
  }));
  return {
    results: offers,
    domEvidenceByLocation: { [location]: {
      automatic_filter_confirmed: true, price_sort_confirmed: true, ranking_complete: true,
      ranking_goal: "price_top1"
    } },
    recommendedRankingByLocation: { [location]: {
      status: "confirmed", sort: "Recommended", transmission: "automatic",
      observed_at: new Date().toISOString(),
      top_offer: { provider_name: recommendedProvider, total_price: 200 * 9,
        currency: "PLN", transmission: "automatic" }
    } }
  };
}

function withScraperRun(run, callback) {
  const original = DiscoverCarsScraper.prototype.run;
  DiscoverCarsScraper.prototype.run = run;
  return Promise.resolve().then(callback).finally(() => { DiscoverCarsScraper.prototype.run = original; });
}

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "api-constraint-repair-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("fresh repairable API failure is an active pending record without authorizing prices", () => {
  const input = pendingInput();
  assert.equal(input.decisions.length, 1);
  const [item] = input.decisions;
  assert.equal(item.action, "increase");
  assert.equal(item.data_quality_status, "api_constraint_repair_pending");
  assert.equal(item.recommendation_type, "api_constraint_repair_pending");
  assert.equal(item.requires_dom_constraint_repair, true);
  assert.equal(item.verification_scope, "api_constraint_dom_repair");
  for (const field of ["suggested_rate_pln_day", "maximum_import_rate_pln_day", "site_target_rate_pln_day"]) {
    assert.equal(item[field], null, field);
  }
});

test("legacy merge cannot let a partial repair marker bypass the constraint policy", () => {
  const input = pendingInput({ apiOnlyConstraintRentalDays: [] });
  const [item] = input.decisions;
  assert.equal(item.action, "increase");
  assert.ok(item.maximum_import_rate_pln_day > 0);
  item.requires_dom_constraint_repair = true;
  input.options.apiOnlyConstraintRentalDays = [9];

  const merged = mergePricingRecommendations(input, { options: input.options, decisions: [], recommendations: [] });
  const result = merged.decisions[0];
  assert.equal(result.action, "hold");
  assert.equal(result.data_quality_status, "api_constraint_unavailable");
  assert.equal(result.maximum_import_rate_pln_day, null);
  assert.equal(result.requires_dom_constraint_repair, undefined);
});

test("one genuine DOM repair rebuilds an ordinary decision and reuses its checkpoint", async t => {
  const directory = tempDirectory(t);
  const input = pendingInput();
  let calls = 0;
  await withScraperRun(async function () { calls += 1; return domOutput(); }, async () => {
    const output = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    const repaired = output.decisions[0];
    assert.equal(calls, 1);
    assert.notEqual(repaired.action, "hold");
    assert.equal(repaired.data_quality_status, "ok");
    assert.equal(repaired.recommendation_type, "minimum_fallback");
    assert.equal(repaired.api_constraint_repair.status, "confirmed");
    assert.equal(repaired.api_constraint_repair.source_validation_status, "api_dom_conflict_api_used");
    assert.equal(Object.hasOwn(repaired, "requires_dom_constraint_repair"), false);
    assert.equal(Object.hasOwn(repaired, "verification_scope"), false);
    assert.equal(Object.hasOwn(repaired, "api_recommendation_type"), false);
    assert.equal(isSourceVerified(repaired, input.source_generated_at, Date.now(), input.options), true);

    const emptyRefresh = mergePricingRecommendations(output, {
      options: input.options, decisions: [], recommendations: []
    });
    const retained = emptyRefresh.decisions[0];
    assert.equal(retained.action, repaired.action);
    assert.equal(isSourceVerified(retained, emptyRefresh.source_generated_at, Date.now(), emptyRefresh.options), true);

    const resumed = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    assert.equal(calls, 1);
    assert.equal(resumed.dom_verification.reused_checkpoint_count, 1);
    assert.equal(isSourceVerified(resumed.decisions[0], input.source_generated_at, Date.now(), input.options), true);
  });
});

test("failed repair is consumed before the call and checkpoint resume does not retry it", async t => {
  const directory = tempDirectory(t);
  const input = pendingInput();
  let calls = 0;
  let preResultCheckpoint;
  await withScraperRun(async function () {
    calls += 1;
    const checkpointPath = path.join(directory, "checkpoint.json");
    const checkpointBytes = fs.readFileSync(checkpointPath);
    const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
    assert.equal(checkpoint.entries[0].status, "repair_attempted");
    assert.equal(checkpoint.entries[0].repair_attempted, true);
    preResultCheckpoint = checkpointBytes;
    throw new Error("synthetic DOM failure");
  }, async () => {
    const failed = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    assert.equal(calls, 1);
    assert.equal(failed.decisions[0].action, "hold");
    assert.equal(failed.decisions[0].api_constraint_repair.status, "failed");

    fs.writeFileSync(path.join(directory, "checkpoint.json"), preResultCheckpoint);
    const resumed = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    assert.equal(calls, 1);
    assert.equal(resumed.decisions[0].action, "hold");
    assert.equal(resumed.decisions[0].api_constraint_repair.status, "failed");
  });
});

test("shard merge accepts only authenticated price-free repair failure holds", async t => {
  const directory = tempDirectory(t);
  const input = pendingInput();
  let calls = 0;
  await withScraperRun(async function () { calls += 1; throw new Error("synthetic DOM failure"); }, async () => {
    const shard = splitActiveRecommendations(input, 1)[0];
    const verified = await verifyActiveRecommendations(shard, { workDir: directory, concurrency: 1 });
    const firstProof = verified.decisions[0].api_constraint_repair.attempt_proof;
    assert.equal(firstProof.checkpoint_input_fingerprint, verified.dom_verification.input_fingerprint);
    assert.equal(firstProof.checkpoint_extractor_hash, verified.dom_verification.extractor_hash);
    assert.equal(firstProof.source_run_id, input.decisions[0].source_run_id);
    assert.equal(firstProof.checkpoint_status, "repair_attempted");
    const checkpointPath = path.join(directory, "checkpoint.json");
    const initialCheckpoint = fs.readFileSync(checkpointPath);
    fs.unlinkSync(checkpointPath);
    const merged = mergeVerifiedRecommendationShards(input, [verified], { shardCount: 1 });
    fs.writeFileSync(checkpointPath, initialCheckpoint);
    assert.equal(calls, 1);
    assert.equal(merged.dom_verification.unverified_output_count, 0);
    assert.equal(merged.dom_verification.blocked_count, 1);
    assert.equal(merged.decisions[0].api_constraint_repair.status, "failed");
    assert.equal(merged.decisions[0].maximum_import_rate_pln_day, null);

    const resumedShard = await verifyActiveRecommendations(shard, { workDir: directory, concurrency: 1 });
    assert.equal(calls, 1);
    assert.equal(resumedShard.decisions[0].api_constraint_repair.attempt_proof.checkpoint_status, "repair_failed");
    const resumedCheckpoint = fs.readFileSync(checkpointPath);
    fs.unlinkSync(checkpointPath);
    const resumedMerge = mergeVerifiedRecommendationShards(input, [resumedShard], { shardCount: 1 });
    fs.writeFileSync(checkpointPath, resumedCheckpoint);
    assert.equal(resumedMerge.dom_verification.unverified_output_count, 0);
    assert.equal(resumedMerge.dom_verification.blocked_count, 1);
    assert.equal(resumedMerge.decisions[0].api_constraint_repair.status, "failed");

    for (const tamper of [
      output => { output.maximum_import_rate_pln_day = 50; },
      output => { output.api_constraint_repair.reason = "changed after verification"; },
      output => { output.api_constraint_repair.attempt_proof.checkpoint_integrity_hash = "invalid"; }
    ]) {
      const changed = structuredClone(verified);
      tamper(changed.decisions[0]);
      const rejected = mergeVerifiedRecommendationShards(input, [changed], { shardCount: 1 });
      assert.equal(rejected.dom_verification.unverified_output_count, 1);
      assert.equal(rejected.decisions[0].dom_verification_status, "dom_verification_shard_unverified");
      assert.equal(rejected.decisions[0].maximum_import_rate_pln_day, null);
    }
  });
});

test("long DOM failure messages stay bounded and remain authenticated shard holds", async t => {
  const directory = tempDirectory(t);
  const input = pendingInput();
  await withScraperRun(async function () { throw new Error("x".repeat(5000)); }, async () => {
    const shard = splitActiveRecommendations(input, 1)[0];
    const verified = await verifyActiveRecommendations(shard, { workDir: directory, concurrency: 1 });
    const failed = verified.decisions[0];
    assert.equal(failed.api_constraint_repair.status, "failed");
    assert.equal(failed.api_constraint_repair.reason.length, 500);
    const merged = mergeVerifiedRecommendationShards(input, [verified], { shardCount: 1 });
    assert.equal(merged.dom_verification.unverified_output_count, 0);
    assert.equal(merged.dom_verification.blocked_count, 1);
    assert.equal(merged.decisions[0].api_constraint_repair.reason.length, 500);
  });
});

test("budget exhaustion before starting a group does not consume the repair attempt", async t => {
  const directory = tempDirectory(t);
  const input = pendingInput();
  let calls = 0;
  await withScraperRun(async function () { calls += 1; return domOutput(); }, async () => {
    const exhausted = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1, maxDurationMs: 0 });
    assert.equal(calls, 0);
    assert.equal(exhausted.dom_verification.budget_exhausted, true);

    const resumed = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    assert.equal(calls, 1);
    assert.equal(resumed.decisions[0].api_constraint_repair.status, "confirmed");
  });
});

test("stale identity and disabled/protected policy block repair before any DOM call", async t => {
  const cases = [
    { name: "stale source", change: input => { input.decisions[0].source_generated_at = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(); } },
    { name: "future source", change: input => { input.decisions[0].source_generated_at = new Date(Date.now() + 60_000).toISOString(); } },
    { name: "missing source timestamp", change: input => { input.decisions[0].source_generated_at = null; } },
    { name: "missing source id", change: input => { input.decisions[0].source_run_id = null; } },
    { name: "disabled feature", change: input => { input.options.recommendedFallbackToMinimum = false; } },
    { name: "unselected day", change: input => { input.options.apiOnlyConstraintRentalDays = []; } },
    { name: "protected date", change: input => { input.options.excelPolicy.protected_rate_periods = [{ start_date: date, end_date: date }]; } }
  ];
  let calls = 0;
  await withScraperRun(async function () { calls += 1; return domOutput(); }, async () => {
    for (const scenario of cases) {
      const input = pendingInput();
      scenario.change(input);
      const output = await verifyActiveRecommendations(input, { workDir: tempDirectory(t), concurrency: 1 });
      assert.equal(output.decisions[0].action, "hold", scenario.name);
      assert.equal(output.decisions[0].api_constraint_repair.attempted, false, scenario.name);
    }
  });
  assert.equal(calls, 0);
});

test("Recommended MM Top1 remains a genuine verified hold and tampered repricing is rejected", async t => {
  const directory = tempDirectory(t);
  const input = pendingInput();
  await withScraperRun(async function () { return domOutput({ recommendedProvider: "MM Cars Rental" }); }, async () => {
    const output = await verifyActiveRecommendations(input, { workDir: directory, concurrency: 1 });
    const held = output.decisions[0];
    assert.equal(held.action, "hold");
    assert.equal(held.data_quality_status, "popular_top1_preserved");
    assert.equal(held.api_constraint_repair.status, "confirmed");
    assert.equal(isSourceVerified(held, input.source_generated_at, Date.now(), input.options), true);

    held.dom_repricing.policy_fingerprint = "tampered";
    assert.equal(isSourceVerified(held, input.source_generated_at, Date.now(), input.options), false);
  });
});
