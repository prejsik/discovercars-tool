const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

const PRUNE_REASONS = new Set(['missing_rental_duration', 'invalid_pickup_date',
  'no_location_zone_mapping', 'protected_date', 'maximum_duration_exceeded',
  'no_excel_duration_column', 'no_eligible_excel_cell']);

function validateVerificationPlan(original, planned) {
  if (!Array.isArray(original?.decisions) || !Array.isArray(planned?.decisions)
    || original.decisions.length !== planned.decisions.length) throw new Error('Invalid verification plan scope.');
  const replacements = new Map();
  const decisions = original.decisions.map((item, index) => {
    const next = planned.decisions[index];
    if (isDeepStrictEqual(item, next)) return item;
    if (!item || !['increase', 'decrease'].includes(item.action)
      || item.requires_popularity_verification !== true || item.data_quality_status !== 'popularity_pending'
      || !PRUNE_REASONS.has(next?.verification_plan_reason)
      || typeof next.reason !== 'string' || !next.reason.trim()) throw new Error('Unproven verification-plan hold.');
    const expected = { ...item, action: 'hold', recommendation_action: 'hold', suggested_rate_pln_day: null,
      maximum_import_rate_pln_day: null, site_cap_rate_pln_day: null,
      site_target_rate_pln_day: null, predicted_site_rate_pln_day: null, change_pln_day: 0,
      data_quality_status: 'excel_ineligible', requires_popularity_verification: false,
      verification_plan_status: 'skipped_excel_irrelevant', verification_plan_reason: next.verification_plan_reason,
      reason: next.reason };
    if (!isDeepStrictEqual(next, expected)) throw new Error('Verification plan changed rate evidence or identity.');
    // Both source arrays contain the same original decisions; bind changes to the complete original item.
    const key = JSON.stringify(item);
    if (replacements.has(key) && !isDeepStrictEqual(replacements.get(key), expected)) {
      throw new Error('Conflicting verification-plan holds.');
    }
    replacements.set(key, expected);
    return expected;
  });
  const expected = { ...original, decisions };
  if (Array.isArray(original.recommendations)) {
    expected.recommendations = original.recommendations.map(item => replacements.get(JSON.stringify(item)) || item);
  }
  if (Object.hasOwn(original, 'recommendation_count')) {
    expected.recommendation_count = (expected.recommendations || decisions).filter(item => item.action !== 'hold').length;
  }
  if (!isDeepStrictEqual(planned, expected)) throw new Error('Verification plan changed policy, coverage or parallel recommendation data.');
  return true;
}

if (require.main === module) {
  try {
    const [originalPath, plannedPath] = process.argv.slice(2);
    validateVerificationPlan(JSON.parse(fs.readFileSync(originalPath)), JSON.parse(fs.readFileSync(plannedPath)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateVerificationPlan };
