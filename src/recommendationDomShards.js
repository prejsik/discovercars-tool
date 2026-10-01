const fs = require("fs");
const path = require("path");
const {
  blockRecommendation,
  MAX_CURRENT_RUN_AGE_MS,
  extractorCodeHash,
  groupTimingMetadata,
  inputFingerprint,
  isFreshVerification,
  isSourceVerified,
  keyOf,
  readGroupTimings
} = require("./verifyActiveRecommendationsDom");

function listDecisions(payload) {
  if (Array.isArray(payload?.decisions)) return payload.decisions;
  if (Array.isArray(payload?.recommendations)) return payload.recommendations;
  if (Array.isArray(payload)) return payload;
  return [];
}

function isActive(item) {
  return item?.action !== "hold";
}

function dateDurationKey(item) {
  return `${String(item?.start_date || item?.pickup_date || "").slice(0, 10)}|${Number(item?.rental_days) || 1}`;
}

function pendingRecommendationGroups(payload, now = Date.now()) {
  const groups = new Map();
  for (const item of listDecisions(payload)) {
    if (!isActive(item) || isSourceVerified(item, payload?.source_generated_at, now)) continue;
    const groupKey = dateDurationKey(item);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }
  return groups;
}

function createCostPlan(payload, count, groups, createdAt, weights) {
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid DOM verification cost plan timestamp");
  const groupCosts = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([groupKey, items]) => {
      const locationCount = new Set(items.map((item) => item.location)).size;
      const weight = weights?.get(groupKey);
      return { group_key: groupKey, location_count: locationCount,
        estimated_cost_ms: weight?.estimated_cost_ms ?? locationCount * 30000,
        weight_source: weight?.weight_source ?? "location_count" };
    });
  if (groupCosts.some((group) => !Number.isSafeInteger(group.estimated_cost_ms) || group.estimated_cost_ms < 1)) {
    throw new Error("Invalid DOM verification cost plan cost");
  }
  const shards = Array.from({ length: count }, (_, index) => ({ index, group_keys: [], estimated_cost_ms: 0 }));
  for (const group of [...groupCosts].sort((left, right) => right.estimated_cost_ms - left.estimated_cost_ms
    || left.group_key.localeCompare(right.group_key))) {
    const shard = shards.reduce((lightest, candidate) => candidate.estimated_cost_ms < lightest.estimated_cost_ms ? candidate : lightest);
    shard.group_keys.push(group.group_key);
    shard.estimated_cost_ms += group.estimated_cost_ms;
  }
  for (const shard of shards) shard.group_keys.sort((left, right) => left.localeCompare(right));
  if (shards.some((shard) => !Number.isSafeInteger(shard.estimated_cost_ms))) throw new Error("Invalid DOM verification cost plan total");
  const plan = { version: 1, algorithm: "weighted-greedy-v1", created_at: createdAt,
    base_input_fingerprint: inputFingerprint(payload), extractor_hash: extractorCodeHash(),
    shard_count: count, groups: groupCosts, shards };
  return { ...plan, integrity_hash: inputFingerprint(plan) };
}

function buildVerificationCostPlan(payload, shardCount, createdAt, weights) {
  const count = Number(shardCount);
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error("shardCount must be an integer between 1 and 16");
  return createCostPlan(payload, count, pendingRecommendationGroups(payload, Date.parse(createdAt)), createdAt, weights);
}

function validateCostPlan(payload, count, groups, splitTime, plan) {
  if (!plan || plan.version !== 1 || plan.algorithm !== "weighted-greedy-v1" || plan.shard_count !== count
    || !isFreshVerification(plan.created_at, splitTime, MAX_CURRENT_RUN_AGE_MS)
    || !Array.isArray(plan.groups) || plan.groups.length !== groups.size || !Array.isArray(plan.shards)) {
    throw new Error("Invalid DOM verification cost plan");
  }
  const weights = new Map();
  for (const group of plan.groups) {
    const items = groups.get(group?.group_key);
    if (!items || weights.has(group.group_key) || group.location_count !== new Set(items.map((item) => item.location)).size
      || !Number.isSafeInteger(group.estimated_cost_ms) || group.estimated_cost_ms < 1
      || !["location_count", "previous_group", "previous_location", "previous_run"].includes(group.weight_source)) {
      throw new Error("Invalid DOM verification cost plan group");
    }
    weights.set(group.group_key, group);
  }
  const expected = createCostPlan(payload, count, groups, plan.created_at, weights);
  if (inputFingerprint(plan) !== inputFingerprint(expected)) {
    throw new Error("Invalid DOM verification cost plan integrity or allocation");
  }
  return expected;
}

function splitActiveRecommendations(payload, shardCount = 4, createdAt = new Date().toISOString(), workload) {
  const count = Number(shardCount);
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new Error("shardCount must be an integer between 1 and 16");
  }
  const splitTime = Date.parse(createdAt);
  if (!Number.isFinite(splitTime)) throw new Error("Invalid DOM shard split timestamp");

  const membershipTime = workload === undefined ? splitTime : Date.parse(workload?.cost_plan?.created_at);
  const groups = pendingRecommendationGroups(payload, membershipTime);
  const plan = workload === undefined ? createCostPlan(payload, count, groups, createdAt)
    : validateCostPlan(payload, count, groups, splitTime, workload?.cost_plan);

  const fingerprint = inputFingerprint(payload);
  const extractorHash = extractorCodeHash();
  const shards = Array.from({ length: count }, (_, index) => ({
    ...payload,
    decisions: [],
    recommendations: [],
    recommendation_count: 0,
    dom_shard: {
      index,
      count,
      base_input_fingerprint: fingerprint,
      extractor_hash: extractorHash,
      created_at: createdAt,
      cost_plan: plan,
      group_keys: [],
      input_count: 0
    }
  }));

  for (const plannedShard of plan.shards) {
    const shard = shards[plannedShard.index];
    for (const groupKey of plannedShard.group_keys) {
      shard.dom_shard.group_keys.push(groupKey);
      shard.decisions.push(...groups.get(groupKey));
    }
  }

  for (const shard of shards) {
    shard.recommendations = [...shard.decisions];
    shard.recommendation_count = shard.recommendations.length;
    shard.dom_shard.input_count = shard.decisions.length;
    shard.dom_shard.input_fingerprint = inputFingerprint(shard.decisions);
  }
  return shards;
}

function mergeVerifiedRecommendationShards(basePayload, shardPayloads, options = {}) {
  const baseDecisions = listDecisions(basePayload);
  const pendingByKey = new Map(
    baseDecisions
      .filter((item) => isActive(item) && !isSourceVerified(item, basePayload?.source_generated_at))
      .map((item) => [keyOf(item), item])
  );
  const outputByKey = new Map();
  const duplicateKeys = new Set();
  const summaries = [];
  const completedShardIndexes = new Set();
  const shardCount = options.shardCount === undefined ? 4 : Number(options.shardCount);
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 16) {
    throw new Error("shardCount must be an integer between 1 and 16");
  }
  const expectedPlans = new Map();
  const extractorHash = extractorCodeHash();
  const shardIndexes = new Set();
  const duplicateShardIndexes = new Set();
  const payloads = Array.isArray(shardPayloads) ? shardPayloads : [];
  const planIdentities = new Set();
  const validatedShards = [];
  for (const shard of payloads) {
    const index = shard?.dom_shard?.index;
    if (!Number.isInteger(index)) continue;
    if (shardIndexes.has(index)) duplicateShardIndexes.add(index);
    shardIndexes.add(index);
  }
  let invalidShardCount = 0;

  for (const shard of payloads) {
    if (!shard) continue;
    const metadata = shard.dom_shard;
    if (!metadata || !metadata.cost_plan || !Number.isInteger(metadata.index) || metadata.index < 0 || metadata.index >= shardCount
      || !isFreshVerification(metadata.created_at, Date.now(), MAX_CURRENT_RUN_AGE_MS)) {
      invalidShardCount += 1;
      continue;
    }
    // Plan-time membership is immutable; freshness is still checked per row at merge.
    const planIdentity = `${metadata.created_at}|${inputFingerprint(metadata.cost_plan)}`;
    if (!expectedPlans.has(planIdentity)) {
      try {
        expectedPlans.set(planIdentity, splitActiveRecommendations(basePayload, shardCount, metadata.created_at, { cost_plan: metadata.cost_plan }));
      } catch {
        invalidShardCount += 1;
        continue;
      }
    }
    const expectedShard = expectedPlans.get(planIdentity)[metadata.index];
    const expected = expectedShard.dom_shard;
    const summary = shard.dom_verification;
    if (metadata.count !== shardCount
      || metadata.base_input_fingerprint !== expected.base_input_fingerprint
      || metadata.input_fingerprint !== expected.input_fingerprint
      || metadata.extractor_hash !== extractorHash
      || !Array.isArray(metadata.group_keys) || inputFingerprint(metadata.group_keys) !== inputFingerprint(expected.group_keys)
      || metadata.input_count !== expected.input_count
      || summary?.extractor_hash !== extractorHash
      || summary?.input_fingerprint !== inputFingerprint(expectedShard)
      || !isFreshVerification(summary?.started_at, Date.now(), MAX_CURRENT_RUN_AGE_MS)
      || !isFreshVerification(summary?.completed_at, Date.now(), MAX_CURRENT_RUN_AGE_MS)
      || Date.parse(summary.started_at) < Date.parse(metadata.created_at)
      || Date.parse(summary.completed_at) < Date.parse(summary.started_at)
      || !Array.isArray(shard.decisions)
      || shard.decisions.some((item) => !expectedShard.decisions.some((input) => keyOf(input) === keyOf(item)))) {
      invalidShardCount += 1;
      continue;
    }
    planIdentities.add(planIdentity);
    validatedShards.push({ shard, expectedShard, summary });
  }

  for (const { shard, expectedShard, summary } of validatedShards) {
    if (planIdentities.size > 1) {
      invalidShardCount += 1;
      continue;
    }
    const metadata = shard.dom_shard;
    if (duplicateShardIndexes.has(metadata.index)) {
      for (const item of expectedShard.decisions) duplicateKeys.add(keyOf(item));
      continue;
    }
    summaries.push(summary);
    if (Number.isInteger(Number(shard?.dom_shard?.index))) {
      completedShardIndexes.add(shard.dom_shard.index);
    }
    for (const item of listDecisions(shard)) {
      const itemKey = keyOf(item);
      if (!pendingByKey.has(itemKey)) continue;
      if (outputByKey.has(itemKey)) duplicateKeys.add(itemKey);
      outputByKey.set(itemKey, { item, completedAt: summary.completed_at });
    }
  }

  let missingOutputCount = 0;
  let duplicateOutputCount = 0;
  let unverifiedOutputCount = 0;
  const finalDecisions = baseDecisions.map((item) => {
    if (!isActive(item)) return item;
    if (isSourceVerified(item, basePayload?.source_generated_at)) {
      return { ...item, dom_verification_status: "confirmed_existing_dom", dom_verification_reasons: [],
        dom_verified_at: item.dom_verified_at ?? item.source_generated_at ?? basePayload?.source_generated_at };
    }

    const itemKey = keyOf(item);
    if (duplicateKeys.has(itemKey)) {
      duplicateOutputCount += 1;
      return blockRecommendation(item, "dom_verification_shard_duplicate", ["duplicate_shard_output"]);
    }
    const { item: verified, completedAt } = outputByKey.get(itemKey) || {};
    if (!verified) {
      missingOutputCount += 1;
      return blockRecommendation(item, "dom_verification_shard_missing", ["missing_shard_output"]);
    }
    const blocked = verified.action === "hold";
    const mutableFields = new Set(["source_validation_status", "dom_verification_status", "dom_verification_reasons", "dom_verified_at"]);
    if (blocked) {
      for (const field of ["action", "suggested_rate_pln_day", "maximum_import_rate_pln_day", "change_pln_day", "data_quality_status", "reason"]) mutableFields.add(field);
    }
    const inputUnchanged = Object.keys(item).filter((field) => !mutableFields.has(field))
      .every((field) => inputFingerprint(verified[field] === undefined ? null : verified[field]) === inputFingerprint(item[field] === undefined ? null : item[field]));
    const confirmed = !blocked && isSourceVerified(verified)
      && ["confirmed", "confirmed_existing_dom"].includes(verified.dom_verification_status)
      && Array.isArray(verified.dom_verification_reasons) && verified.dom_verification_reasons.length === 0
      && isFreshVerification(verified.dom_verified_at, Date.now(), MAX_CURRENT_RUN_AGE_MS)
      && Date.parse(verified.dom_verified_at) <= Date.parse(completedAt);
    const validBlock = blocked && ["dom_recommendation_failed", "api_dom_conflict", "dom_verification_budget_exhausted"].includes(verified.dom_verification_status)
      && verified.suggested_rate_pln_day === null && verified.maximum_import_rate_pln_day === null && verified.change_pln_day === 0
      && Array.isArray(verified.dom_verification_reasons) && verified.dom_verification_reasons.length > 0;
    if (!inputUnchanged || (!confirmed && !validBlock) || (verified.dom_verified_at && !isFreshVerification(verified.dom_verified_at, Date.now(), MAX_CURRENT_RUN_AGE_MS))) {
      unverifiedOutputCount += 1;
      return blockRecommendation(item, "dom_verification_shard_unverified", ["unverified_shard_output"]);
    }
    return blocked
      ? { ...blockRecommendation(item, verified.dom_verification_status, verified.dom_verification_reasons), ...(verified.dom_verified_at ? { dom_verified_at: verified.dom_verified_at } : {}) }
      : { ...item, source_validation_status: "dom_recommendation_verified", dom_verification_status: verified.dom_verification_status,
        dom_verification_reasons: [], ...(verified.dom_verified_at ? { dom_verified_at: verified.dom_verified_at } : {}) };
  });

  const activeInputCount = baseDecisions.filter(isActive).length;
  const reusedExistingDomCount = baseDecisions.filter((item) => isActive(item) && isSourceVerified(item, basePayload?.source_generated_at)).length;
  const pendingGroups = new Set([...pendingByKey.values()].map(dateDurationKey));
  const reusedCheckpointGroups = Math.min(pendingGroups.size, summaries.reduce((total, summary) => total + Number(summary.reused_checkpoint_group_count || 0), 0));
  const liveGroupCount = pendingGroups.size - reusedCheckpointGroups;
  const processedGroupCount = summaries.reduce(
    (total, summary) => total + Number(summary.processed_live_dom_group_count || 0),
    0
  );
  const budgetExhaustedCount = summaries.reduce(
    (total, summary) => total + Number(summary.budget_exhausted_count || 0),
    0
  );
  const recommendations = finalDecisions.filter(isActive);
  const confirmedCount = finalDecisions.filter(
    (item) => isActive(item) && String(item.dom_verification_status || "").startsWith("confirmed")
  ).length;
  const blockedCount = baseDecisions.reduce(
    (total, item, index) => total + (isActive(item) && !isActive(finalDecisions[index]) ? 1 : 0),
    0
  );
  const timings = summaries.flatMap((summary) => readGroupTimings(summary, extractorHash) || []);

  return {
    ...basePayload,
    generated_at: new Date().toISOString(),
    decisions: finalDecisions,
    recommendations,
    recommendation_count: recommendations.length,
    dom_verification: {
      active_input_count: activeInputCount,
      reused_existing_dom_count: reusedExistingDomCount,
      live_dom_check_count: pendingByKey.size,
      live_dom_group_count: liveGroupCount,
      processed_live_dom_group_count: Math.min(processedGroupCount, liveGroupCount),
      skipped_live_dom_group_count: Math.max(0, liveGroupCount - processedGroupCount),
      confirmed_count: confirmedCount,
      blocked_count: blockedCount,
      budget_exhausted: summaries.some((summary) => Boolean(summary.budget_exhausted)),
      budget_exhausted_count: budgetExhaustedCount,
      missing_output_count: missingOutputCount,
      duplicate_output_count: duplicateOutputCount,
      unverified_output_count: unverifiedOutputCount,
      invalid_shard_count: invalidShardCount,
      duplicate_shard_count: duplicateShardIndexes.size,
      reused_checkpoint_count: summaries.reduce((total, summary) => total + Number(summary.reused_checkpoint_count || 0), 0),
      reused_checkpoint_group_count: reusedCheckpointGroups,
      extractor_hash: extractorHash,
      input_fingerprint: inputFingerprint(basePayload),
      cost_plan: completedShardIndexes.size ? validatedShards[0].expectedShard.dom_shard.cost_plan : null,
      ...groupTimingMetadata(timings, extractorHash, summaries.reduce((total, summary) => total + (Number(summary.group_timing_truncated_count) || 0), 0)),
      shard_count: shardCount,
      completed_shard_count: completedShardIndexes.size,
      missing_shard_count: Math.max(0, shardCount - completedShardIndexes.size),
      elapsed_ms: summaries.reduce((maximum, summary) => Math.max(maximum, Number(summary.elapsed_ms || 0)), 0),
      shards: summaries
    }
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function listShardOutputFiles(fileNames) {
  return (Array.isArray(fileNames) ? fileNames : [])
    .filter((name) => /^shard-\d+-output\.json$/.test(name))
    .sort((left, right) => left.localeCompare(right));
}

function readShardPayloads(shardsDir) {
  const resolved = path.resolve(shardsDir);
  const payloads = [];
  const corruptFiles = [];
  if (!fs.existsSync(resolved)) return { payloads, corruptFiles };
  for (const name of listShardOutputFiles(fs.readdirSync(resolved))) {
    try {
      const payload = readJson(path.join(resolved, name));
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.decisions)) throw new Error("Invalid shard payload");
      payloads.push(payload);
    } catch {
      corruptFiles.push(name);
    }
  }
  return { payloads, corruptFiles };
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
  if (command === "split") {
    if (!args.input || !args["output-dir"]) throw new Error("split requires --input and --output-dir");
    const workload = args.workload ? readJson(args.workload) : undefined;
    const count = args["shard-count"] === undefined ? workload?.cost_plan?.shard_count ?? 4 : Number(args["shard-count"]);
    const shards = splitActiveRecommendations(readJson(args.input), count, new Date().toISOString(), workload);
    shards.forEach((shard) => writeJson(path.join(args["output-dir"], `shard-${shard.dom_shard.index}-input.json`), shard));
    process.stdout.write(`${JSON.stringify({ shard_count: shards.length, matrix: { shard: shards.map((shard) => shard.dom_shard.index) }, input_counts: shards.map((shard) => shard.dom_shard.input_count) })}\n`);
    return;
  }
  if (command === "merge") {
    if (!args.base || !args["shards-dir"] || !args.output) throw new Error("merge requires --base, --shards-dir and --output");
    const shardsDir = path.resolve(args["shards-dir"]);
    const loaded = readShardPayloads(shardsDir);
    const output = mergeVerifiedRecommendationShards(
      readJson(args.base),
      loaded.payloads,
      { shardCount: Number(args["shard-count"]) || 4 }
    );
    output.dom_verification.corrupt_shard_file_count = loaded.corruptFiles.length;
    output.dom_verification.corrupt_shard_files = loaded.corruptFiles;
    for (const name of loaded.corruptFiles) {
      process.stderr.write(`Ignoring corrupt DOM shard output: ${name}\n`);
    }
    writeJson(args.output, output);
    process.stdout.write(`${JSON.stringify(output.dom_verification)}\n`);
    return;
  }
  throw new Error("Use split or merge");
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
  buildVerificationCostPlan,
  pendingRecommendationGroups,
  dateDurationKey,
  listShardOutputFiles,
  readShardPayloads,
  mergeVerifiedRecommendationShards,
  splitActiveRecommendations
};
