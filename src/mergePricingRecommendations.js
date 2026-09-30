const fs = require("fs");
const path = require("path");
const { resolveBrokerMarkupCalibration, fixedMarkupFields } = require("./brokerMarkupCalibration");

function listRecommendations(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && Array.isArray(payload.recommendations)) {
    return payload.recommendations;
  }
  return [];
}

function listDecisions(payload) {
  if (payload && Array.isArray(payload.decisions)) {
    return payload.decisions;
  }
  return listRecommendations(payload);
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
  const decisionAware = Array.isArray(basePayload?.decisions) || Array.isArray(updatePayload?.decisions);
  const baseRecommendations = decisionAware ? listDecisions(basePayload) : listRecommendations(basePayload);
  const updateRecommendations = decisionAware ? listDecisions(updatePayload) : listRecommendations(updatePayload);
  const updateByKey = new Map();

  for (const item of updateRecommendations) {
    updateByKey.set(recommendationKey(item), item);
  }

  const merged = [];
  let replacedCount = 0;
  let frozenCalibrationBlockedCount = 0;
  const frozenCalibration = updatePayload?.options?.brokerMarkupCalibration;
  for (const item of baseRecommendations) {
    if (updateByKey.has(recommendationKey(item))) {
      replacedCount += 1;
      continue;
    }
    const expected = frozenCalibration?.manualOnly === true
      ? resolveBrokerMarkupCalibration(item, frozenCalibration)
      : null;
    const previousMultiplier = Number(item.broker_markup_multiplier ?? 1);
    const fixedMismatch = expected?.model === 'fixed_amount' && (
      item.broker_markup_model !== expected.model
      || item.broker_markup_amount_pln_day !== expected.amountPlnDay
      || JSON.stringify(Object.entries(item.broker_markup_group_supplements_pln_day || {}).sort())
        !== JSON.stringify(Object.entries(expected.groupSupplementsPlnDay).sort())
    );
    if (expected && (fixedMismatch || !Number.isFinite(previousMultiplier) || Math.abs(previousMultiplier - expected.multiplier) > 0.000001)) {
      frozenCalibrationBlockedCount += 1;
      merged.push({
        ...item,
        action: "hold",
        reason: "Starsza rekomendacja korzystala z innego narzutu niz zamrozony model. Wymaga ponownego przeliczenia.",
        data_quality_status: "markup_needs_review",
        suggested_rate_pln_day: null,
        maximum_import_rate_pln_day: null,
        site_cap_rate_pln_day: null,
        site_target_rate_pln_day: null,
        predicted_site_rate_pln_day: null,
        target_rank: null,
        change_pln_day: 0,
        previous_broker_markup_multiplier: item.broker_markup_multiplier ?? null,
        broker_markup_multiplier: expected.multiplier,
        broker_markup_percent: expected.percent,
        broker_markup_source: expected.source,
        ...fixedMarkupFields(expected)
      });
    } else {
      merged.push(item);
    }
  }
  merged.push(...updateRecommendations);
  merged.sort(compareRecommendations);
  const includeNoop = Boolean(updatePayload?.options?.includeNoop || basePayload?.options?.includeNoop);
  const publishedRecommendations = decisionAware && !includeNoop
    ? merged.filter((item) => item?.action !== "hold")
    : merged;

  const output = {
    generated_at: now.toISOString(),
    source_generated_at: updatePayload?.source_generated_at || updatePayload?.generated_at || basePayload?.source_generated_at || null,
    options: updatePayload?.options || basePayload?.options || {},
    merge: {
      base_generated_at: basePayload?.generated_at || null,
      update_generated_at: updatePayload?.generated_at || null,
      base_count: baseRecommendations.length,
      update_count: updateRecommendations.length,
      replaced_count: replacedCount,
      final_count: merged.length,
      covered_scope_count: updateByKey.size,
      decision_aware: decisionAware,
      frozen_calibration_blocked_count: frozenCalibrationBlockedCount
    },
    recommendation_count: countActiveRecommendations(publishedRecommendations),
    skipped_count: Number(basePayload?.skipped_count || 0) + Number(updatePayload?.skipped_count || 0),
    recommendations: publishedRecommendations
  };
  if (decisionAware) {
    output.decisions = merged;
  }
  return output;
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
