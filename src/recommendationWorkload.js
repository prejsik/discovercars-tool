const fs = require("fs");
const path = require("path");
const { isSourceVerified } = require("./verifyActiveRecommendationsDom");
const { dateDurationKey } = require("./recommendationDomShards");

function listDecisions(payload) {
  if (Array.isArray(payload?.decisions)) return payload.decisions;
  if (Array.isArray(payload?.recommendations)) return payload.recommendations;
  if (Array.isArray(payload)) return payload;
  return [];
}

function activeItems(payload) {
  return listDecisions(payload).filter((item) => item?.action !== "hold");
}

function buildRecommendationWorkload({
  current,
  previous,
  previousDom,
  shardCount,
  defaultSecondsPerGroup = 30
}) {
  const currentActive = activeItems(current);
  const previousActive = activeItems(previous);
  const pending = currentActive.filter((item) => !isSourceVerified(item, current?.source_generated_at));
  const pendingGroups = new Set(pending.map(dateDurationKey));
  const normalizedPreviousDom = previousDom?.dom_verification || previousDom || {};
  const previousProcessedGroups = Number(normalizedPreviousDom.processed_live_dom_group_count || 0);
  const previousShardCount = Math.max(1, Number(normalizedPreviousDom.shard_count) || 1);
  const previousElapsedSeconds = Number(normalizedPreviousDom.elapsed_ms || 0) / 1000;
  const previousGroupsPerShard = previousProcessedGroups > 0
    ? Math.ceil(previousProcessedGroups / previousShardCount)
    : 0;
  const measuredShards = (Array.isArray(normalizedPreviousDom.shards) ? normalizedPreviousDom.shards : [])
    .filter((shard) => Number(shard.processed_live_dom_group_count) > 0 && Number(shard.elapsed_ms) > 0
      && Number.isFinite(Number(shard.elapsed_ms)) && Number.isFinite(Number(shard.processed_live_dom_group_count)))
    .map((shard) => Number(shard.elapsed_ms) / 1000 / Number(shard.processed_live_dom_group_count));
  const observedSecondsPerGroup = measuredShards.length ? Math.max(...measuredShards) : previousElapsedSeconds > 0 && previousGroupsPerShard > 0
    ? previousElapsedSeconds / previousGroupsPerShard
    : Math.max(1, Number(defaultSecondsPerGroup) || 30);
  const targetWorkerSeconds = 5400;
  const maxParallel = 4;
  const adaptiveShardCount = Math.min(16, pendingGroups.size || 1, Math.max(Math.min(4, pendingGroups.size || 1),
    Math.ceil(pendingGroups.size * observedSecondsPerGroup / targetWorkerSeconds)));
  const normalizedShardCount = shardCount === undefined ? adaptiveShardCount : Number(shardCount);
  if (!Number.isInteger(normalizedShardCount) || normalizedShardCount < 1 || normalizedShardCount > 16) {
    throw new Error("shardCount must be an integer between 1 and 16");
  }
  const estimatedGroupsPerShard = Math.ceil(pendingGroups.size / normalizedShardCount);
  const estimatedWorkerSeconds = Math.ceil(estimatedGroupsPerShard * observedSecondsPerGroup);
  const runnerWaves = Math.ceil(normalizedShardCount / maxParallel);
  const estimatedDurationSeconds = estimatedWorkerSeconds * runnerWaves;
  const growthPercent = previousActive.length > 0
    ? Number((((currentActive.length - previousActive.length) / previousActive.length) * 100).toFixed(1))
    : null;
  const budgetSeconds = 9000;
  const estimatedBudgetUsagePercent = Number((estimatedWorkerSeconds / budgetSeconds * 100).toFixed(1));

  return {
    generated_at: new Date().toISOString(),
    active_recommendation_count: currentActive.length,
    previous_active_recommendation_count: previousActive.length || null,
    pre_dom_recommendation_growth_percent: growthPercent,
    recommendation_growth_percent: null,
    recommendation_surge: false,
    alert: "",
    pending_dom_recommendation_count: pending.length,
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
    timing_source: measuredShards.length || (previousElapsedSeconds > 0 && previousGroupsPerShard > 0) ? "previous_run" : "default"
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
      previousDom: readJsonIfExists(args["previous-dom"]),
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
