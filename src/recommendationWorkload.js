const fs = require("fs");
const path = require("path");
const { VERIFIED_SOURCE_STATUSES } = require("./verifyActiveRecommendationsDom");
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
  shardCount = 4,
  defaultSecondsPerGroup = 30
}) {
  const currentActive = activeItems(current);
  const previousActive = activeItems(previous);
  const pending = currentActive.filter((item) => !VERIFIED_SOURCE_STATUSES.has(item?.source_validation_status));
  const pendingGroups = new Set(pending.map(dateDurationKey));
  const normalizedPreviousDom = previousDom?.dom_verification || previousDom || {};
  const previousProcessedGroups = Number(normalizedPreviousDom.processed_live_dom_group_count || 0);
  const previousShardCount = Math.max(1, Number(normalizedPreviousDom.shard_count) || 1);
  const previousElapsedSeconds = Number(normalizedPreviousDom.elapsed_ms || 0) / 1000;
  const previousGroupsPerShard = previousProcessedGroups > 0
    ? Math.ceil(previousProcessedGroups / previousShardCount)
    : 0;
  const observedSecondsPerGroup = previousElapsedSeconds > 0 && previousGroupsPerShard > 0
    ? previousElapsedSeconds / previousGroupsPerShard
    : Number(defaultSecondsPerGroup) || 30;
  const normalizedShardCount = Math.max(1, Number(shardCount) || 4);
  const estimatedGroupsPerShard = Math.ceil(pendingGroups.size / normalizedShardCount);
  const estimatedDurationSeconds = Math.ceil(estimatedGroupsPerShard * observedSecondsPerGroup);
  const growthPercent = previousActive.length > 0
    ? Number((((currentActive.length - previousActive.length) / previousActive.length) * 100).toFixed(1))
    : null;
  const budgetSeconds = 9000;
  const estimatedBudgetUsagePercent = Number((estimatedDurationSeconds / budgetSeconds * 100).toFixed(1));

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
    estimated_groups_per_shard: estimatedGroupsPerShard,
    estimated_seconds_per_group: Number(observedSecondsPerGroup.toFixed(1)),
    estimated_dom_duration_seconds: estimatedDurationSeconds,
    dom_budget_seconds: budgetSeconds,
    estimated_budget_usage_percent: estimatedBudgetUsagePercent,
    over_budget: estimatedDurationSeconds > budgetSeconds,
    timing_source: previousElapsedSeconds > 0 && previousGroupsPerShard > 0 ? "previous_run" : "default"
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
      shardCount: Number(args["shard-count"]) || 4,
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
