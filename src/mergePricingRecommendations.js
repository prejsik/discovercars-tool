const fs = require("fs");
const path = require("path");

function listRecommendations(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.recommendations)) {
    return payload.recommendations;
  }
  return [];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.includes("T") ? text.split("T", 1)[0] : text;
}

function recommendationKey(item) {
  return [
    normalizeText(item.location),
    normalizeDate(item.start_date || item.pickup_date),
    String(Number(item.rental_days) || item.rental_days || "").trim()
  ].join("|");
}

function compareRecommendations(left, right) {
  const leftDate = normalizeDate(left.start_date || left.pickup_date);
  const rightDate = normalizeDate(right.start_date || right.pickup_date);
  if (leftDate !== rightDate) {
    return leftDate.localeCompare(rightDate);
  }
  const locationCompare = normalizeText(left.location).localeCompare(normalizeText(right.location));
  if (locationCompare !== 0) {
    return locationCompare;
  }
  return (Number(left.rental_days) || 0) - (Number(right.rental_days) || 0);
}

function countActiveRecommendations(items) {
  return items.filter((item) => item && item.action !== "hold").length;
}

function mergePricingRecommendations(basePayload, updatePayload, now = new Date()) {
  const baseRecommendations = listRecommendations(basePayload);
  const updateRecommendations = listRecommendations(updatePayload);
  const updateByKey = new Map();

  for (const item of updateRecommendations) {
    updateByKey.set(recommendationKey(item), item);
  }

  const merged = [];
  let replacedCount = 0;
  for (const item of baseRecommendations) {
    if (updateByKey.has(recommendationKey(item))) {
      replacedCount += 1;
      continue;
    }
    merged.push(item);
  }
  merged.push(...updateRecommendations);
  merged.sort(compareRecommendations);

  return {
    generated_at: now.toISOString(),
    source_generated_at: updatePayload?.source_generated_at || updatePayload?.generated_at || basePayload?.source_generated_at || null,
    options: updatePayload?.options || basePayload?.options || {},
    merge: {
      base_generated_at: basePayload?.generated_at || null,
      update_generated_at: updatePayload?.generated_at || null,
      base_count: baseRecommendations.length,
      update_count: updateRecommendations.length,
      replaced_count: replacedCount,
      final_count: merged.length
    },
    recommendation_count: countActiveRecommendations(merged),
    skipped_count: Number(basePayload?.skipped_count || 0) + Number(updatePayload?.skipped_count || 0),
    recommendations: merged
  };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function runCli(argv) {
  const [basePath, updatePath, outputPath] = argv;
  if (!basePath || !updatePath || !outputPath) {
    process.stderr.write("Usage: node src/mergePricingRecommendations.js base.json update.json output.json\n");
    process.exitCode = 1;
    return;
  }

  const output = mergePricingRecommendations(loadJson(basePath), loadJson(updatePath));
  const resolvedOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`Merged pricing recommendations saved to ${resolvedOutputPath}\n`);
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  mergePricingRecommendations,
  recommendationKey
};
