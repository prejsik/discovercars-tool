const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  dateDurationKey,
  splitActiveRecommendations
} = require("./recommendationDomShards");
const {
  VERIFIED_SOURCE_STATUSES,
  keyOf
} = require("./verifyActiveRecommendationsDom");

const DEFAULT_VERIFIER_OPTIONS = Object.freeze({
  concurrency: 1,
  max_duration_ms: 840_000,
  process_timeout_seconds: 900,
  speed_mode: "fast",
  timeout_ms: 45_000
});

const RATE_FIELDS = Object.freeze([
  "top1_rate_pln_day",
  "top2_rate_pln_day",
  "top3_rate_pln_day",
  "mm_rate_pln_day",
  "suggested_rate_pln_day",
  "maximum_import_rate_pln_day",
  "change_pln_day"
]);

function listDecisions(payload) {
  if (Array.isArray(payload?.decisions)) return payload.decisions;
  if (Array.isArray(payload?.recommendations)) return payload.recommendations;
  return [];
}

function jsonText(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function payloadSha256(payload) {
  return sha256Text(jsonText(payload));
}

function assertUniqueDecisionKeys(decisions) {
  const seen = new Set();
  for (const item of decisions) {
    const itemKey = keyOf(item);
    if (seen.has(itemKey)) {
      throw new Error(`Benchmark input contains duplicate decision key: ${itemKey}`);
    }
    seen.add(itemKey);
  }
}

function buildBenchmarkInput(payload, options = {}) {
  const groupLimit = Number(options.groupLimit ?? 8);
  const shardCount = Number(options.shardCount ?? 4);
  if (!Number.isInteger(groupLimit) || groupLimit < 1 || groupLimit > 8) {
    throw new Error("groupLimit must be an integer from 1 to 8");
  }
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive integer");
  }

  const ordered = splitActiveRecommendations(payload, 1)[0];
  const selectedGroupKeys = ordered.dom_shard.group_keys.slice(0, groupLimit);
  if (!selectedGroupKeys.length) {
    throw new Error("Source checkpoint has no active recommendations requiring DOM verification");
  }

  const selectedGroups = new Set(selectedGroupKeys);
  const decisions = ordered.decisions.filter((item) => selectedGroups.has(dateDurationKey(item)));
  assertUniqueDecisionKeys(decisions);
  const sample = {
    ...payload,
    decisions,
    recommendations: [...decisions],
    recommendation_count: decisions.length,
    dom_benchmark_sample: {
      group_limit: groupLimit,
      selected_group_count: selectedGroupKeys.length,
      selected_group_keys: selectedGroupKeys
    }
  };
  const shards = splitActiveRecommendations(sample, shardCount);
  const verifierOptions = { ...DEFAULT_VERIFIER_OPTIONS };
  const manifest = {
    schema_version: 1,
    source_run_id: String(options.sourceRunId || ""),
    source_payload_sha256: payloadSha256(payload),
    benchmark_input_sha256: payloadSha256(sample),
    verifier_options_sha256: payloadSha256(verifierOptions),
    verifier_options: verifierOptions,
    group_limit: groupLimit,
    selected_group_count: selectedGroupKeys.length,
    selected_group_keys: selectedGroupKeys,
    selected_decision_count: decisions.length,
    selected_decision_keys: decisions.map(keyOf),
    shard_count: shardCount,
    shard_input_counts: shards.map((shard) => shard.dom_shard.input_count)
  };

  return { sample, shards, manifest };
}

function indexDecisions(payload) {
  const byKey = new Map();
  const duplicateKeys = new Set();
  for (const item of listDecisions(payload)) {
    const itemKey = keyOf(item);
    if (byKey.has(itemKey)) duplicateKeys.add(itemKey);
    byKey.set(itemKey, item);
  }
  return { byKey, duplicateKeys: [...duplicateKeys].sort() };
}

function isConfirmed(item) {
  if (!item || item.action === "hold") return false;
  return String(item.dom_verification_status || "").startsWith("confirmed")
    || VERIFIED_SOURCE_STATUSES.has(item.source_validation_status);
}

function classificationOf(item) {
  return {
    classification: isConfirmed(item) ? "confirmed" : "nonconfirmed",
    action: item?.action || null,
    dom_verification_status: item?.dom_verification_status || null,
    data_quality_status: item?.data_quality_status || null,
    reasons: Array.isArray(item?.dom_verification_reasons) ? item.dom_verification_reasons : []
  };
}

function summarizeTimings(timings, manifest) {
  const rows = (Array.isArray(timings) ? timings : [])
    .map((item) => ({ ...item, shard: Number(item.shard) }))
    .sort((left, right) => left.shard - right.shard);
  const elapsed = rows.map((item) => Number(item.elapsed_ms)).filter(Number.isFinite);
  const starts = rows.map((item) => Number(item.started_epoch_ms)).filter(Number.isFinite);
  const completions = rows.map((item) => Number(item.completed_epoch_ms)).filter(Number.isFinite);
  const expectedWorkers = Number(manifest.shard_count);
  const successfulWorkers = rows.filter((item) => Number(item.exit_code) === 0).length;
  const inputHashMatches = rows.filter(
    (item) => item.input_sha256 === manifest.benchmark_input_sha256
  ).length;
  const optionHashMatches = rows.filter(
    (item) => item.verifier_options_sha256 === manifest.verifier_options_sha256
  ).length;

  return {
    expected_worker_count: expectedWorkers,
    observed_worker_count: rows.length,
    successful_worker_count: successfulWorkers,
    input_hash_match_count: inputHashMatches,
    verifier_options_hash_match_count: optionHashMatches,
    critical_path_ms: elapsed.length ? Math.max(...elapsed) : null,
    total_worker_ms: elapsed.length ? elapsed.reduce((total, value) => total + value, 0) : null,
    wall_window_ms: starts.length && completions.length
      ? Math.max(...completions) - Math.min(...starts)
      : null,
    workers: rows
  };
}

function summarizeArm(payload, timings, manifest) {
  const expectedKeys = manifest.selected_decision_keys;
  const expectedSet = new Set(expectedKeys);
  const indexed = indexDecisions(payload);
  const outputKeys = [...indexed.byKey.keys()];
  const missing = expectedKeys.filter((itemKey) => !indexed.byKey.has(itemKey));
  const unexpected = outputKeys.filter((itemKey) => !expectedSet.has(itemKey)).sort();
  const nonconfirmed = expectedKeys
    .filter((itemKey) => indexed.byKey.has(itemKey) && !isConfirmed(indexed.byKey.get(itemKey)))
    .map((itemKey) => ({ key: itemKey, ...classificationOf(indexed.byKey.get(itemKey)) }));
  const merge = payload?.dom_verification || {};
  const mergeQualityCounts = {
    missing_output_count: Number(merge.missing_output_count || 0),
    duplicate_output_count: Number(merge.duplicate_output_count || 0),
    unverified_output_count: Number(merge.unverified_output_count || 0),
    missing_shard_count: Number(merge.missing_shard_count || 0),
    corrupt_shard_file_count: Number(merge.corrupt_shard_file_count || 0)
  };
  const timing = summarizeTimings(timings, manifest);
  const structuralQualityPassed = missing.length === 0
    && unexpected.length === 0
    && indexed.duplicateKeys.length === 0
    && Object.values(mergeQualityCounts).every((value) => value === 0)
    && timing.observed_worker_count === timing.expected_worker_count
    && timing.successful_worker_count === timing.expected_worker_count
    && timing.input_hash_match_count === timing.expected_worker_count
    && timing.verifier_options_hash_match_count === timing.expected_worker_count;

  return {
    structural_quality_passed: structuralQualityPassed,
    completeness: {
      expected_decision_count: expectedKeys.length,
      output_decision_count: outputKeys.length,
      missing_decision_count: missing.length,
      missing_decision_keys: missing,
      unexpected_decision_count: unexpected.length,
      unexpected_decision_keys: unexpected,
      duplicate_decision_count: indexed.duplicateKeys.length,
      duplicate_decision_keys: indexed.duplicateKeys,
      ...mergeQualityCounts
    },
    classification: {
      confirmed_count: expectedKeys.length - missing.length - nonconfirmed.length,
      nonconfirmed_count: nonconfirmed.length,
      nonconfirmed
    },
    timing,
    decisionsByKey: indexed.byKey
  };
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareBenchmarkResults({
  manifest,
  sameRunner,
  separateRunners,
  sameRunnerTimings,
  separateRunnerTimings
}) {
  if (!manifest || !Array.isArray(manifest.selected_decision_keys)) {
    throw new Error("Benchmark manifest is missing selected_decision_keys");
  }
  const same = summarizeArm(sameRunner, sameRunnerTimings, manifest);
  const separate = summarizeArm(separateRunners, separateRunnerTimings, manifest);
  const classificationDifferences = [];
  const rateDifferences = [];

  for (const itemKey of manifest.selected_decision_keys) {
    const sameItem = same.decisionsByKey.get(itemKey);
    const separateItem = separate.decisionsByKey.get(itemKey);
    if (!sameItem || !separateItem) continue;

    const sameClassification = classificationOf(sameItem);
    const separateClassification = classificationOf(separateItem);
    if (!valuesEqual(sameClassification, separateClassification)) {
      classificationDifferences.push({
        key: itemKey,
        same_runner: sameClassification,
        separate_runners: separateClassification
      });
    }

    const fields = RATE_FIELDS.flatMap((field) => {
      const sameValue = Object.hasOwn(sameItem, field) ? sameItem[field] : null;
      const separateValue = Object.hasOwn(separateItem, field) ? separateItem[field] : null;
      return valuesEqual(sameValue, separateValue)
        ? []
        : [{ field, same_runner: sameValue, separate_runners: separateValue }];
    });
    if (fields.length) rateDifferences.push({ key: itemKey, fields });
  }

  const sameCriticalPath = same.timing.critical_path_ms;
  const separateCriticalPath = separate.timing.critical_path_ms;
  const separateSpeedupPercent = Number.isFinite(sameCriticalPath)
    && Number.isFinite(separateCriticalPath)
    && sameCriticalPath > 0
    ? Number((((sameCriticalPath - separateCriticalPath) / sameCriticalPath) * 100).toFixed(2))
    : null;
  const sameSourceInputHash = [same.timing, separate.timing].every(
    (timing) => timing.observed_worker_count === timing.expected_worker_count
      && timing.input_hash_match_count === timing.expected_worker_count
  );
  const sameVerifierOptions = [same.timing, separate.timing].every(
    (timing) => timing.observed_worker_count === timing.expected_worker_count
      && timing.verifier_options_hash_match_count === timing.expected_worker_count
  );
  const stripInternal = ({ decisionsByKey, ...arm }) => arm;

  return {
    schema_version: 1,
    source: {
      run_id: manifest.source_run_id,
      source_payload_sha256: manifest.source_payload_sha256,
      benchmark_input_sha256: manifest.benchmark_input_sha256,
      selected_group_count: manifest.selected_group_count,
      selected_decision_count: manifest.selected_decision_count,
      shard_count: manifest.shard_count
    },
    verifier_options: manifest.verifier_options,
    quality: {
      same_source_input_hash: sameSourceInputHash,
      same_verifier_options: sameVerifierOptions
    },
    arms: {
      same_runner: stripInternal(same),
      separate_runners: stripInternal(separate)
    },
    comparison: {
      timing: {
        same_runner_critical_path_ms: sameCriticalPath,
        separate_runners_critical_path_ms: separateCriticalPath,
        separate_runners_speedup_percent: separateSpeedupPercent
      },
      missing_decisions: {
        same_runner: same.completeness.missing_decision_keys,
        separate_runners: separate.completeness.missing_decision_keys
      },
      nonconfirmed: {
        same_runner: same.classification.nonconfirmed,
        separate_runners: separate.classification.nonconfirmed
      },
      classification_differences: classificationDifferences,
      rate_differences: rateDifferences
    },
    claims: {
      live_price_equivalence: false,
      note: "The arms perform separate live DOM requests. Rate and classification differences are reported, not treated as proof of price equivalence."
    }
  };
}

function formatMarkdown(report) {
  const rows = [
    ["Same runner", report.arms.same_runner],
    ["Separate runners", report.arms.separate_runners]
  ];
  const lines = [
    "# DiscoverCars DOM verification benchmark",
    "",
    `Source run: \`${report.source.run_id}\``,
    "",
    `Benchmark input SHA-256: \`${report.source.benchmark_input_sha256}\``,
    "",
    "| Arm | Structural quality | Critical path | Decisions | Nonconfirmed |",
    "| --- | --- | ---: | ---: | ---: |"
  ];
  for (const [label, arm] of rows) {
    lines.push(`| ${label} | ${arm.structural_quality_passed ? "pass" : "fail"} | ${arm.timing.critical_path_ms ?? "n/a"} ms | ${arm.completeness.output_decision_count}/${arm.completeness.expected_decision_count} | ${arm.classification.nonconfirmed_count} |`);
  }
  lines.push(
    "",
    `Separate-runner speedup: ${report.comparison.timing.separate_runners_speedup_percent ?? "n/a"}%`,
    "",
    `Classification differences: ${report.comparison.classification_differences.length}`,
    "",
    `Rate differences: ${report.comparison.rate_differences.length}`,
    "",
    `Same input hash: ${report.quality.same_source_input_hash ? "yes" : "no"}`,
    "",
    `Same verifier options: ${report.quality.same_verifier_options ? "yes" : "no"}`,
    "",
    `> ${report.claims.note}`,
    ""
  );
  return lines.join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, jsonText(payload), "utf8");
}

function findFiles(directory, predicate) {
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved)) return [];
  const output = [];
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    const entryPath = path.join(resolved, entry.name);
    if (entry.isDirectory()) output.push(...findFiles(entryPath, predicate));
    else if (predicate(entry.name)) output.push(entryPath);
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function readTimings(directory) {
  return findFiles(directory, (name) => /^shard-\d+-timing\.json$/.test(name)).map(readJson);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = Object.fromEntries(rest.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...value] = arg.slice(2).split("=");
    return [key, value.join("=")];
  }));
  return { command, args };
}

function runCli(argv) {
  const { command, args } = parseArgs(argv);
  if (command === "prepare") {
    if (!args.input || !args.output || !args.manifest || !args["shards-dir"]) {
      throw new Error("prepare requires --input, --output, --manifest and --shards-dir");
    }
    const prepared = buildBenchmarkInput(readJson(args.input), {
      groupLimit: Number(args["group-limit"] || 8),
      shardCount: Number(args["shard-count"] || 4),
      sourceRunId: args["source-run-id"]
    });
    writeJson(args.output, prepared.sample);
    writeJson(args.manifest, prepared.manifest);
    prepared.shards.forEach((shard) => {
      writeJson(path.join(args["shards-dir"], `shard-${shard.dom_shard.index}-input.json`), shard);
    });
    process.stdout.write(`${JSON.stringify(prepared.manifest)}\n`);
    return;
  }
  if (command === "compare") {
    const required = [
      "manifest",
      "same-runner",
      "separate-runners",
      "same-runner-timings",
      "separate-runner-timings",
      "output",
      "markdown"
    ];
    const missing = required.filter((name) => !args[name]);
    if (missing.length) throw new Error(`compare requires --${missing.join(", --")}`);
    const report = compareBenchmarkResults({
      manifest: readJson(args.manifest),
      sameRunner: readJson(args["same-runner"]),
      separateRunners: readJson(args["separate-runners"]),
      sameRunnerTimings: readTimings(args["same-runner-timings"]),
      separateRunnerTimings: readTimings(args["separate-runner-timings"])
    });
    writeJson(args.output, report);
    const markdownPath = path.resolve(args.markdown);
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, formatMarkdown(report), "utf8");
    process.stdout.write(`${JSON.stringify({
      same_runner_structural_quality: report.arms.same_runner.structural_quality_passed,
      separate_runners_structural_quality: report.arms.separate_runners.structural_quality_passed,
      separate_runners_speedup_percent: report.comparison.timing.separate_runners_speedup_percent
    })}\n`);
    return;
  }
  throw new Error("Use prepare or compare");
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_VERIFIER_OPTIONS,
  RATE_FIELDS,
  buildBenchmarkInput,
  compareBenchmarkResults,
  formatMarkdown,
  payloadSha256
};
