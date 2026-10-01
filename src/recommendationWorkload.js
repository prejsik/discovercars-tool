const fs = require("fs");
const path = require("path");
const { readGroupTimings, extractorCodeHash, MAX_CURRENT_RUN_AGE_MS } = require("./verifyActiveRecommendationsDom");
const { buildVerificationCostPlan, pendingRecommendationGroups } = require("./recommendationDomShards");

function listDecisions(payload) {
  if (Array.isArray(payload?.decisions)) return payload.decisions;
  if (Array.isArray(payload?.recommendations)) return payload.recommendations;
  if (Array.isArray(payload)) return payload;
  return [];
}

function activeItems(payload) {
  return listDecisions(payload).filter((item) => item?.action !== "hold");
}

function historicalGroupCost(summary) {
  if (summary.extractor_hash !== undefined && summary.extractor_hash !== extractorCodeHash()) return 0;
  const validMeasurement = (entry) => Number.isSafeInteger(entry?.processed_live_dom_group_count)
    && entry.processed_live_dom_group_count > 0 && Number.isFinite(entry.elapsed_ms)
    && entry.elapsed_ms > 0 && entry.elapsed_ms <= MAX_CURRENT_RUN_AGE_MS;
  const shards = Array.isArray(summary.shards) ? summary.shards : [];
  if (shards.length > 16) return 0;
  const measured = shards.filter((shard) => shard?.processed_live_dom_group_count > 0);
  if (measured.length) {
    return measured.every(validMeasurement)
      ? Math.max(...measured.map((shard) => shard.elapsed_ms / shard.processed_live_dom_group_count)) : 0;
  }
  const count = summary.shard_count ?? 1;
  return validMeasurement(summary) && Number.isInteger(count) && count >= 1 && count <= 16
    ? summary.elapsed_ms / Math.ceil(summary.processed_live_dom_group_count / count) : 0;
}

function buildRecommendationWorkload({
  current,
  previous,
  previousDom,
  shardCount,
  defaultSecondsPerGroup = 30
}) {
  const createdAt = new Date().toISOString();
  const currentActive = activeItems(current);
  const previousActive = activeItems(previous);
  const pendingGroups = pendingRecommendationGroups(current, Date.parse(createdAt));
  const pendingCount = [...pendingGroups.values()].reduce((total, items) => total + items.length, 0);
  const normalizedPreviousDom = previousDom?.dom_verification || previousDom || {};
  const hasGroupHistory = ["group_timings", "group_timing_version", "group_timings_hash"]
    .some((field) => Object.prototype.hasOwnProperty.call(normalizedPreviousDom, field));
  const timings = hasGroupHistory ? readGroupTimings(normalizedPreviousDom) : null;
  const timingsByKey = new Map((timings || []).map((timing) => [timing.group_key, timing]));
  const measuredLocationCost = (timings || []).reduce((maximum, timing) => Math.max(maximum, timing.elapsed_ms / timing.location_count), 0);
  const legacyCost = hasGroupHistory ? 0 : historicalGroupCost(normalizedPreviousDom);
  const configuredDefault = Number(defaultSecondsPerGroup);
  const defaultLocationCost = Math.max(1, Number.isFinite(configuredDefault) && configuredDefault > 0 ? configuredDefault : 30) * 1000;
  const weights = new Map([...pendingGroups.entries()].map(([groupKey, items]) => {
    const locations = new Set(items.map((item) => item.location)).size;
    const timing = timingsByKey.get(groupKey);
    const measuredCost = timing ? timing.elapsed_ms * locations / timing.location_count : measuredLocationCost * locations;
    const fallbackCost = defaultLocationCost * locations;
    return [groupKey, { estimated_cost_ms: Math.ceil(Math.max(fallbackCost, measuredCost, legacyCost)),
      weight_source: measuredCost > fallbackCost ? (timing ? "previous_group" : "previous_location")
        : legacyCost > fallbackCost ? "previous_run" : "location_count" }];
  }));
  const totalCostMs = [...weights.values()].reduce((total, group) => total + group.estimated_cost_ms, 0);
  const observedSecondsPerGroup = pendingGroups.size ? totalCostMs / 1000 / pendingGroups.size : defaultLocationCost / 1000;
  const targetWorkerSeconds = 5400;
  const maxParallel = 4;
  const adaptiveShardCount = Math.min(16, pendingGroups.size || 1, Math.max(Math.min(4, pendingGroups.size || 1),
    Math.ceil(totalCostMs / 1000 / targetWorkerSeconds)));
  const normalizedShardCount = shardCount === undefined ? adaptiveShardCount : Number(shardCount);
  if (!Number.isInteger(normalizedShardCount) || normalizedShardCount < 1 || normalizedShardCount > 16) {
    throw new Error("shardCount must be an integer between 1 and 16");
  }
  const costPlan = buildVerificationCostPlan(current, normalizedShardCount, createdAt, weights);
  const estimatedGroupsPerShard = Math.max(...costPlan.shards.map((shard) => shard.group_keys.length));
  const estimatedWorkerSeconds = Math.ceil(Math.max(...costPlan.shards.map((shard) => shard.estimated_cost_ms)) / 1000);
  const runnerWaves = Math.ceil(normalizedShardCount / maxParallel);
  const estimatedDurationSeconds = estimatedWorkerSeconds * runnerWaves;
  const growthPercent = previousActive.length > 0
    ? Number((((currentActive.length - previousActive.length) / previousActive.length) * 100).toFixed(1))
    : null;
  const budgetSeconds = 9000;
  const estimatedBudgetUsagePercent = Number((estimatedWorkerSeconds / budgetSeconds * 100).toFixed(1));

  return {
    generated_at: createdAt,
    cost_plan: costPlan,
    active_recommendation_count: currentActive.length,
    previous_active_recommendation_count: previousActive.length || null,
    pre_dom_recommendation_growth_percent: growthPercent,
    recommendation_growth_percent: null,
    recommendation_surge: false,
    alert: "",
    pending_dom_recommendation_count: pendingCount,
    pending_dom_group_count: pendingGroups.size,
    shard_count: normalizedShardCount,
    matrix: { shard: Array.from({ length: normalizedShardCount }, (_, index) => index) },
    max_parallel: maxParallel,
    target_worker_duration_seconds: targetWorkerSeconds,
    estimated_runner_waves: runnerWaves,
    estimated_worker_duration_seconds: estimatedWorkerSeconds,
    estimated_remaining_duration_seconds: estimatedDurationSeconds,
    estimated_groups_per_shard: estimatedGroupsPerShard,
    estimated_seconds_per_group: Number(observedSecondsPerGroup.toFixed(1)),
    estimated_dom_duration_seconds: estimatedDurationSeconds,
    dom_budget_seconds: budgetSeconds,
    estimated_budget_usage_percent: estimatedBudgetUsagePercent,
    over_budget: estimatedWorkerSeconds > budgetSeconds,
    over_target: estimatedWorkerSeconds > targetWorkerSeconds,
    timing_source: timings?.length ? "previous_group_timings" : legacyCost > 0 ? "previous_run" : "default"
  };
}

function finalizeRecommendationWorkload(workload, { current, previous, runType }) {
  const currentActive = activeItems(current);
  const previousActive = activeItems(previous);
  const growthPercent = previousActive.length > 0
    ? Number((((currentActive.length - previousActive.length) / previousActive.length) * 100).toFixed(1))
    : null;
  const recommendationSurge = runType === "full" && growthPercent !== null && growthPercent > 100;
  return {
    ...(workload || {}),
    final_active_recommendation_count: currentActive.length,
    previous_final_active_recommendation_count: previousActive.length || null,
    recommendation_growth_percent: growthPercent,
    recommendation_surge: recommendationSurge,
    alert: recommendationSurge
      ? `ALERT: liczba aktywnych rekomendacji wzrosla o ${growthPercent}% (${previousActive.length} -> ${currentActive.length}).`
      : "",
    comparison_run_type: String(runType || "")
  };
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(path.resolve(filePath))) return null;
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function readTimingHistory(filePath) {
  try { return readJsonIfExists(filePath); } catch { return null; }
}

function parseArgs(argv) {
  return Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...value] = arg.slice(2).split("=");
    return [key, value.join("=")];
  }));
}

function runCli(argv) {
  const args = parseArgs(argv);
  if (!args.current || !args.output) throw new Error("Use --current=... --output=...");
  const report = Object.prototype.hasOwnProperty.call(args, "finalize")
    ? finalizeRecommendationWorkload(readJsonIfExists(args.workload || args.output), {
      current: readJsonIfExists(args.current),
      previous: readJsonIfExists(args.previous),
      runType: args["run-type"]
    })
    : buildRecommendationWorkload({
      current: readJsonIfExists(args.current),
      previous: readJsonIfExists(args.previous),
      previousDom: readTimingHistory(args["previous-dom"]),
      shardCount: args["shard-count"] === undefined ? undefined : Number(args["shard-count"]),
      defaultSecondsPerGroup: Number(args["default-seconds-per-group"]) || 30
    });
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report)}\n`);
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
  buildRecommendationWorkload,
  finalizeRecommendationWorkload
};
