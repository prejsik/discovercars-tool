const assert = require("node:assert/strict");

const {
  buildBenchmarkInput,
  compareBenchmarkResults
} = require("../src/domVerificationBenchmark");

function decision({
  date,
  days,
  location,
  action = "increase",
  status = "api_unverified",
  top1Rate = 100
}) {
  return {
    action,
    location,
    start_date: date,
    rental_days: days,
    source_validation_status: status,
    source_generated_at: new Date().toISOString(),
    top1_rate_pln_day: top1Rate,
    suggested_rate_pln_day: top1Rate - 1
  };
}

function confirmed(item, overrides = {}) {
  return {
    ...item,
    source_validation_status: "dom_recommendation_verified",
    dom_verification_status: "confirmed",
    dom_verification_reasons: [],
    dom_verified_at: new Date().toISOString(),
    ...overrides
  };
}

function timing(arm, shard, inputSha256, verifierOptionsSha256, elapsedMs = 1_000) {
  return {
    arm,
    shard,
    input_sha256: inputSha256,
    verifier_options_sha256: verifierOptionsSha256,
    started_epoch_ms: 1_000 + shard * 10,
    completed_epoch_ms: 1_000 + shard * 10 + elapsedMs,
    elapsed_ms: elapsedMs,
    exit_code: 0
  };
}

function runTest(name, fn) {
  const RealDate = Date;
  const now = RealDate.parse("2026-10-01T08:00:00.000Z");
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  } finally {
    global.Date = RealDate;
  }
}

runTest("benchmark sampling deterministically selects at most eight sorted groups through four shards", () => {
  const pending = Array.from({ length: 10 }, (_, index) => decision({
    date: `2026-10-${String(10 - index).padStart(2, "0")}`,
    days: index % 2 ? 3 : 2,
    location: `Location ${index}`
  }));
  pending.push(decision({
    date: "2026-10-01",
    days: 3,
    location: "Second location in selected group"
  }));
  const payload = {
    generated_at: "2026-09-29T08:00:00.000Z",
    decisions: [
      ...pending,
      decision({ date: "2026-09-30", days: 1, location: "Held", action: "hold" }),
      decision({ date: "2026-09-29", days: 1, location: "Already verified", status: "dom_confirmed" })
    ]
  };

  const first = buildBenchmarkInput(payload, {
    groupLimit: 8,
    shardCount: 4,
    sourceRunId: "12345"
  });
  const second = buildBenchmarkInput(payload, {
    groupLimit: 8,
    shardCount: 4,
    sourceRunId: "12345"
  });

  assert.deepEqual(first, second);
  assert.equal(first.manifest.selected_group_count, 8);
  assert.equal(first.shards.length, 4);
  assert.deepEqual(first.manifest.selected_group_keys, [
    "2026-10-01|3",
    "2026-10-02|2",
    "2026-10-03|3",
    "2026-10-04|2",
    "2026-10-05|3",
    "2026-10-06|2",
    "2026-10-07|3",
    "2026-10-08|2"
  ]);
  assert.equal(first.sample.decisions.length, 9);
  assert.deepEqual(
    first.shards.flatMap((shard) => shard.dom_shard.group_keys).sort(),
    first.manifest.selected_group_keys
  );
  assert.equal(first.manifest.shard_count, 4);
  assert.equal(first.manifest.benchmark_input_sha256.length, 64);
});

runTest("benchmark sampling rechecks stale and timestamp-free source confirmations", () => {
  const stale = decision({ date: "2026-10-02", days: 2, location: "Stale", status: "dom_confirmed" });
  stale.source_generated_at = "2026-09-29T08:00:00.000Z";
  const missing = decision({ date: "2026-10-03", days: 2, location: "Missing timestamp", status: "dom_confirmed" });
  delete missing.source_generated_at;
  const fresh = decision({ date: "2026-10-04", days: 2, location: "Fresh", status: "dom_confirmed" });
  const prepared = buildBenchmarkInput({ decisions: [stale, missing, fresh] }, { shardCount: 1 });
  assert.deepEqual(prepared.sample.decisions.map((item) => item.location), ["Stale", "Missing timestamp"]);
});

runTest("benchmark comparison reports missing decisions, nonconfirmed results, and rate differences independently", () => {
  const alpha = decision({ date: "2026-10-01", days: 2, location: "Alpha", top1Rate: 100 });
  const beta = decision({ date: "2026-10-02", days: 3, location: "Beta", top1Rate: 110 });
  const gamma = decision({ date: "2026-10-03", days: 4, location: "Gamma", top1Rate: 120 });
  const prepared = buildBenchmarkInput({ decisions: [alpha, beta, gamma] }, {
    groupLimit: 8,
    shardCount: 4,
    sourceRunId: "98765"
  });
  const hash = prepared.manifest.benchmark_input_sha256;
  const optionsHash = prepared.manifest.verifier_options_sha256;
  const sameRunner = {
    decisions: [confirmed(alpha), confirmed(beta), confirmed(gamma)],
    dom_verification: {
      missing_output_count: 0,
      duplicate_output_count: 0,
      unverified_output_count: 0,
      missing_shard_count: 0,
      corrupt_shard_file_count: 0
    }
  };
  const separateRunners = {
    decisions: [
      confirmed(alpha, { top1_rate_pln_day: 101 }),
      {
        ...beta,
        action: "hold",
        dom_verification_status: "api_dom_conflict",
        dom_verification_reasons: ["top1_rate_mismatch"]
      }
    ],
    dom_verification: {
      missing_output_count: 1,
      duplicate_output_count: 0,
      unverified_output_count: 0,
      missing_shard_count: 1,
      corrupt_shard_file_count: 0
    }
  };

  const report = compareBenchmarkResults({
    manifest: prepared.manifest,
    sameRunner,
    separateRunners,
    sameRunnerTimings: Array.from({ length: 4 }, (_, shard) => timing("same_runner", shard, hash, optionsHash, 1_000 + shard)),
    separateRunnerTimings: Array.from({ length: 4 }, (_, shard) => timing("separate_runners", shard, hash, optionsHash, 800 + shard))
  });

  assert.deepEqual(report.comparison.missing_decisions.same_runner, []);
  assert.deepEqual(report.comparison.missing_decisions.separate_runners, [
    "gamma|2026-10-03|4"
  ]);
  assert.deepEqual(
    report.comparison.nonconfirmed.separate_runners.map((item) => item.key),
    ["beta|2026-10-02|3"]
  );
  assert.deepEqual(report.comparison.nonconfirmed.same_runner, []);
  assert.deepEqual(report.comparison.rate_differences, [{
    key: "alpha|2026-10-01|2",
    fields: [{
      field: "top1_rate_pln_day",
      same_runner: 100,
      separate_runners: 101
    }]
  }]);
  assert.equal(report.quality.same_source_input_hash, true);
  assert.equal(report.quality.same_verifier_options, true);
  assert.equal(report.arms.same_runner.structural_quality_passed, true);
  assert.equal(report.arms.separate_runners.structural_quality_passed, false);
  assert.equal(report.claims.live_price_equivalence, false);
});

console.log("All DOM benchmark tests passed.");
