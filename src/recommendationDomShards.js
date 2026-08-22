const fs = require("fs");
const path = require("path");
const {
  VERIFIED_SOURCE_STATUSES,
  blockRecommendation,
  keyOf
} = require("./verifyActiveRecommendationsDom");

function listDecisions(payload) {
  if (Array.isArray(payload?.decisions)) return payload.decisions;
  if (Array.isArray(payload?.recommendations)) return payload.recommendations;
  return [];
}

function isActive(item) {
  return item?.action !== "hold";
}

function isSourceVerified(item) {
  return VERIFIED_SOURCE_STATUSES.has(item?.source_validation_status);
}

function dateDurationKey(item) {
  return `${String(item?.start_date || item?.pickup_date || "").slice(0, 10)}|${Number(item?.rental_days) || 1}`;
}

function splitActiveRecommendations(payload, shardCount = 4) {
  const count = Number(shardCount);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("shardCount must be a positive integer");
  }

  const groups = new Map();
  for (const item of listDecisions(payload)) {
    if (!isActive(item) || isSourceVerified(item)) continue;
    const groupKey = dateDurationKey(item);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }

  const shards = Array.from({ length: count }, (_, index) => ({
    ...payload,
    decisions: [],
    recommendations: [],
    recommendation_count: 0,
    dom_shard: {
      index,
      count,
      group_keys: [],
      input_count: 0
    }
  }));

  [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([groupKey, items], groupIndex) => {
      const shard = shards[groupIndex % count];
      shard.dom_shard.group_keys.push(groupKey);
      shard.decisions.push(...items);
    });

  for (const shard of shards) {
    shard.recommendations = [...shard.decisions];
    shard.recommendation_count = shard.recommendations.length;
    shard.dom_shard.input_count = shard.decisions.length;
  }
  return shards;
}

function mergeVerifiedRecommendationShards(basePayload, shardPayloads, options = {}) {
  const baseDecisions = listDecisions(basePayload);
  const pendingByKey = new Map(
    baseDecisions
      .filter((item) => isActive(item) && !isSourceVerified(item))
      .map((item) => [keyOf(item), item])
  );
  const outputByKey = new Map();
  const duplicateKeys = new Set();
  const summaries = [];
  const completedShardIndexes = new Set();

  for (const shard of Array.isArray(shardPayloads) ? shardPayloads : []) {
    if (!shard) continue;
    if (shard.dom_verification) summaries.push(shard.dom_verification);
    if (Number.isInteger(Number(shard?.dom_shard?.index))) {
      completedShardIndexes.add(Number(shard.dom_shard.index));
    }
    for (const item of listDecisions(shard)) {
      const itemKey = keyOf(item);
      if (!pendingByKey.has(itemKey)) continue;
      if (outputByKey.has(itemKey)) duplicateKeys.add(itemKey);
      outputByKey.set(itemKey, item);
    }
  }

  let missingOutputCount = 0;
  let duplicateOutputCount = 0;
  let unverifiedOutputCount = 0;
  const finalDecisions = baseDecisions.map((item) => {
    if (!isActive(item)) return item;
    if (isSourceVerified(item)) {
      return { ...item, dom_verification_status: "confirmed_existing_dom" };
    }

    const itemKey = keyOf(item);
    if (duplicateKeys.has(itemKey)) {
      duplicateOutputCount += 1;
      return blockRecommendation(item, "dom_verification_shard_duplicate", ["duplicate_shard_output"]);
    }
    const verified = outputByKey.get(itemKey);
    if (!verified) {
      missingOutputCount += 1;
      return blockRecommendation(item, "dom_verification_shard_missing", ["missing_shard_output"]);
    }
    const confirmed = verified.action === "hold"
      || String(verified.dom_verification_status || "").startsWith("confirmed")
      || isSourceVerified(verified);
    if (!confirmed) {
      unverifiedOutputCount += 1;
      return blockRecommendation(item, "dom_verification_shard_unverified", ["unverified_shard_output"]);
    }
    return verified;
  });

  const activeInputCount = baseDecisions.filter(isActive).length;
  const reusedExistingDomCount = baseDecisions.filter((item) => isActive(item) && isSourceVerified(item)).length;
  const pendingGroups = new Set([...pendingByKey.values()].map(dateDurationKey));
  const processedGroupCount = summaries.reduce(
    (total, summary) => total + Number(summary.processed_live_dom_group_count || 0),
    0
  );
  const budgetExhaustedCount = summaries.reduce(
    (total, summary) => total + Number(summary.budget_exhausted_count || 0),
    0
  );
  const shardCount = Math.max(1, Number(options.shardCount) || 4);
  const recommendations = finalDecisions.filter(isActive);
  const confirmedCount = finalDecisions.filter(
    (item) => isActive(item) && String(item.dom_verification_status || "").startsWith("confirmed")
  ).length;
  const blockedCount = baseDecisions.reduce(
    (total, item, index) => total + (isActive(item) && !isActive(finalDecisions[index]) ? 1 : 0),
    0
  );

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
      live_dom_group_count: pendingGroups.size,
      processed_live_dom_group_count: Math.min(processedGroupCount, pendingGroups.size),
      skipped_live_dom_group_count: Math.max(0, pendingGroups.size - processedGroupCount),
      confirmed_count: confirmedCount,
      blocked_count: blockedCount,
      budget_exhausted: summaries.some((summary) => Boolean(summary.budget_exhausted)),
      budget_exhausted_count: budgetExhaustedCount,
      missing_output_count: missingOutputCount,
      duplicate_output_count: duplicateOutputCount,
      unverified_output_count: unverifiedOutputCount,
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
      payloads.push(readJson(path.join(resolved, name)));
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
    const shards = splitActiveRecommendations(readJson(args.input), Number(args["shard-count"]) || 4);
    shards.forEach((shard) => writeJson(path.join(args["output-dir"], `shard-${shard.dom_shard.index}-input.json`), shard));
    process.stdout.write(`${JSON.stringify({ shard_count: shards.length, input_counts: shards.map((shard) => shard.dom_shard.input_count) })}\n`);
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
  dateDurationKey,
  listShardOutputFiles,
  readShardPayloads,
  mergeVerifiedRecommendationShards,
  splitActiveRecommendations
};
