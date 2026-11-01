const assert = require("node:assert/strict");
const test = require("node:test");
const { applyApiOnlyConstraintPolicy, buildPricingRecommendations, DEFAULT_OPTIONS } = require("../src/pricingRecommendations");
const { loadLocationRegistry } = require("../src/locationRegistry");

const registry = loadLocationRegistry();
const location = "Gdansk Airport (GDN)";
const generatedAt = () => new Date().toISOString();

function offer(provider, rate, days, currency = "PLN") {
  return {
    provider_name: provider,
    total_price: rate * days,
    rental_days: days,
    currency,
    transmission: "automatic"
  };
}

function scenario(days, index, changes = {}) {
  const top3 = changes.top3 || [
    offer("Budget", 200, days, changes.top1Currency || "PLN"),
    offer("Avis", 210, days),
    offer("Hertz", 220, days)
  ];
  const view = { top_3: top3 };
  if (changes.includeMm !== false) {
    view.mm_cars_rental = offer("MM Cars Rental", 100, days, changes.mmCurrency || "PLN");
  }
  const item = {
    scenario_id: `scenario-${index}`,
    start_date: changes.startDate || "2026-11-03",
    rental_days: days,
    top_3_plus_mm_by_location: { [location]: view },
    offer_views_by_location: { [location]: { automatic: view } }
  };
  if (changes.includeSourceValidation !== false) {
    item.source_validation_by_location = {
      [location]: { status: changes.sourceStatus || "api_unverified", reasons: changes.sourceReasons || [] }
    };
  }
  if (changes.includeSourceGeneratedAt !== false) {
    item.source_generated_at_by_location = { [location]: changes.sourceGeneratedAt ?? generatedAt() };
  }
  if (changes.includeSourceRunId !== false) {
    item.source_run_id_by_location = { [location]: changes.sourceRunId ?? `source-run-${index}` };
  }
  if (changes.group !== undefined) item.group = changes.group;
  return item;
}

function payload(durations = [9], overrides = [], root = {}) {
  const now = root.generatedAt === undefined ? generatedAt() : root.generatedAt;
  return {
    generated_at: now,
    run_id: root.runId === undefined ? "api-run-1" : root.runId,
    locations: [location],
    scenarios: durations.map((days, index) => scenario(days, index, overrides[index] || {}))
  };
}

function buildOptions(changes = {}) {
  return {
    ...DEFAULT_OPTIONS,
    bestAvailableRank: true,
    recommendedFallbackToMinimum: true,
    recommendedWindowStartDate: "2026-11-01",
    locationTypeFloorsPlnDay: {
      groups: ["GRP1"],
      minDays: 8,
      maxDays: 14,
      minimumRatesByKind: { airport: 250, city: 250 }
    },
    locationRegistry: registry,
    excelPolicy: {
      apply_groups: ["GRP1"],
      excluded_groups: [],
      protected_rate_periods: [],
      group_price_parity: { premium_adjustments_pln_day: {} }
    },
    brokerMarkupCalibration: { enabled: false, defaultMultiplier: 1 },
    ...changes
  };
}

function build(input, changes = {}) {
  return buildPricingRecommendations(input, buildOptions(changes));
}

test("strictly validates the opt-in rental-day list while accepting legacy absence and empty list", () => {
  const input = payload();
  for (const days of [undefined, [], [9], [11, 12], [12, 9, 11]]) {
    assert.doesNotThrow(() => build(input, { apiOnlyConstraintRentalDays: days }));
  }
  for (const days of [null, "9", ["9"], [9.5], [9, 9], [8], [13], [9, 11, 12, 14]]) {
    assert.throws(
      () => build(input, { apiOnlyConstraintRentalDays: days }),
      /apiOnlyConstraintRentalDays/
    );
  }
  assert.throws(
    () => build(input, { apiOnlyConstraintRentalDays: new Array(1) }),
    /apiOnlyConstraintRentalDays/
  );
});

test("selected active days become API-only holds without dropping any decisions", () => {
  const durations = [8, 9, 10, 11, 12, 13, 14, 9, 11, 12, 9, 11, 12];
  const input = payload(durations);
  const legacy = build(input, { apiOnlyConstraintRentalDays: [] });
  const output = build(input, { apiOnlyConstraintRentalDays: [9, 11, 12] });
  const legacyById = new Map(legacy.decisions.map((decision) => [decision.scenario_id, decision]));

  assert.equal(output.decisions.length, 13);
  assert.equal(output.recommendation_count, 4);
  assert.equal(output.skipped_count, 9);
  assert.equal(output.recommendations.length, 4);

  for (const item of output.decisions) {
    const previous = legacyById.get(item.scenario_id);
    if (![9, 11, 12].includes(item.rental_days)) {
      assert.equal(item.action, previous.action);
      assert.equal(item.recommendation_type, previous.recommendation_type);
      assert.equal(Object.hasOwn(item, "verification_scope"), false);
      continue;
    }

    assert.equal(previous.action, "increase");
    assert.equal(previous.recommendation_type, "minimum_fallback");
    assert.equal(previous.requires_popularity_verification, true);
    assert.equal(item.action, "hold");
    assert.equal(item.data_quality_status, "api_constraint_only");
    assert.equal(item.recommendation_type, "api_constraint_only");
    assert.equal(item.verification_scope, "api_only_constraint");
    assert.equal(item.api_recommendation_type, previous.recommendation_type);
    assert.equal(item.api_requires_popularity_verification, true);
    assert.equal(item.requires_popularity_verification, false);
    assert.equal(item.suggested_rate_pln_day, null);
    assert.equal(item.site_target_rate_pln_day, null);
    assert.equal(item.predicted_site_rate_pln_day, null);
    assert.equal(item.site_cap_rate_pln_day, previous.site_cap_rate_pln_day);
    assert.equal(item.maximum_import_rate_pln_day, previous.maximum_import_rate_pln_day);
    assert.equal(item.change_pln_day, 0);
    assert.match(item.reason, /^[\x00-\x7F]*$/);
    assert.match(item.reason, /API-only/i);
    assert.match(item.reason, /DOM/i);
    for (const field of ["dom_verified", "dom_verification_status", "dom_repricing", "dom_repricing_status"]) {
      assert.equal(Object.hasOwn(item, field), false);
    }
  }
});

test("the exported constraint policy is pure, reusable, and uses its supplied clock", () => {
  const [item] = build(payload([9]), { apiOnlyConstraintRentalDays: [] }).decisions;
  const original = structuredClone(item);
  const options = buildOptions({ apiOnlyConstraintRentalDays: [9, 11, 12] });
  const atFreshnessLimit = Date.parse(item.source_generated_at) + 12 * 60 * 60 * 1000;
  const constrained = applyApiOnlyConstraintPolicy(item, options, atFreshnessLimit);

  assert.notEqual(constrained, item);
  assert.deepEqual(item, original);
  assert.equal(constrained.data_quality_status, "api_constraint_only");
  assert.equal(constrained.maximum_import_rate_pln_day, item.maximum_import_rate_pln_day);
  assert.equal(applyApiOnlyConstraintPolicy(item, { ...options, apiOnlyConstraintRentalDays: [11] }, atFreshnessLimit), item);
  assert.equal(applyApiOnlyConstraintPolicy(item, { ...options, recommendedFallbackToMinimum: false }, atFreshnessLimit), item);
  assert.throws(
    () => applyApiOnlyConstraintPolicy(item, { ...options, apiOnlyConstraintRentalDays: [10] }, atFreshnessLimit),
    /apiOnlyConstraintRentalDays/
  );
});

test("partial repair markers cannot bypass the API-only constraint policy", () => {
  const [active] = build(payload([9]), { apiOnlyConstraintRentalDays: [] }).decisions;
  const options = buildOptions({ apiOnlyConstraintRentalDays: [9] });
  assert.equal(active.action, "increase");
  assert.ok(active.maximum_import_rate_pln_day > 0);

  for (const malformed of [
    { ...active, requires_dom_constraint_repair: true },
    { ...active, recommendation_type: "api_constraint_repair_pending", api_recommendation_type: active.recommendation_type }
  ]) {
    const result = applyApiOnlyConstraintPolicy(malformed, options);
    assert.equal(result.action, "hold");
    assert.equal(result.data_quality_status, "api_constraint_unavailable");
    assert.equal(result.maximum_import_rate_pln_day, null);
    assert.equal(result.requires_dom_constraint_repair, undefined);
    assert.equal(result.verification_scope, "api_only_constraint");
  }
});

test("healthy API and complete DOM sources may preserve a constraint cap", () => {
  const cases = [
    { sourceStatus: "api_unverified" },
    { sourceStatus: "dom_confirmed" },
    { sourceStatus: "dom_fallback", sourceReasons: ["api_failure"] },
    { sourceStatus: "dom_only" },
    { sourceStatus: "api_dom_conflict_dom_used", sourceReasons: ["api_dom_conflict"] }
  ];
  for (const source of cases) {
    const output = build(payload([9], [source]), { apiOnlyConstraintRentalDays: [9] });
    const [item] = output.decisions;
    assert.equal(item.action, "hold");
    assert.equal(item.data_quality_status, "api_constraint_only");
    assert.equal(item.source_validation_status, source.sourceStatus);
    assert.equal(item.maximum_import_rate_pln_day, 250);
    assert.equal(item.site_cap_rate_pln_day, 250);
    assert.equal(item.dom_verification_status, undefined);
  }
});

test("fresh known API-used failures queue one non-authorizing DOM repair", () => {
  for (const [sourceStatus, sourceReasons] of [
    ["api_dom_conflict_api_used", ["api_dom_conflict"]],
    ["dom_validation_failed_api_used", ["dom_failure"]]
  ]) {
    const [original] = build(payload([9], [{ sourceStatus, sourceReasons }]), { apiOnlyConstraintRentalDays: [] }).decisions;
    const [item] = build(payload([9], [{ sourceStatus, sourceReasons }]), { apiOnlyConstraintRentalDays: [9] }).decisions;

    assert.equal(item.action, original.action);
    assert.equal(item.action, "increase");
    assert.equal(item.data_quality_status, "api_constraint_repair_pending");
    assert.equal(item.recommendation_type, "api_constraint_repair_pending");
    assert.equal(item.requires_dom_constraint_repair, true);
    assert.equal(item.verification_scope, "api_constraint_dom_repair");
    assert.equal(item.api_recommendation_type, original.recommendation_type);
    assert.equal(item.source_validation_status, sourceStatus);
    assert.equal(item.api_constraint_repair.status, "pending");
    assert.equal(item.api_constraint_repair.source_validation_status, sourceStatus);
    for (const field of ["suggested_rate_pln_day", "maximum_import_rate_pln_day", "site_target_rate_pln_day", "predicted_site_rate_pln_day", "site_cap_rate_pln_day"]) {
      assert.equal(item[field], null, field);
    }
  }

  const invalidProvider = build(payload([9], [{ sourceStatus: "api_dom_conflict_api_used" }]), { apiOnlyConstraintRentalDays: [] }).decisions[0];
  const [notRepairable] = [applyApiOnlyConstraintPolicy({ ...invalidProvider, benchmark_provider: "MM Cars Rental" },
    buildOptions({ apiOnlyConstraintRentalDays: [9] }))];
  assert.equal(notRepairable.action, "hold");
  assert.equal(notRepairable.data_quality_status, "api_constraint_unavailable");
  assert.equal(notRepairable.requires_dom_constraint_repair, undefined);
});

test("missing, stale, conflicting, future, or timezone-less source metadata is unavailable", () => {
  const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const cases = [
    { name: "missing validation", override: { includeSourceValidation: false } },
    { name: "unknown incomplete source", override: { sourceStatus: "api_dom_incomplete_dom_used" } },
    { name: "stale timestamp", override: { sourceGeneratedAt: stale } },
    { name: "future timestamp", override: { sourceGeneratedAt: future } },
    { name: "timezone missing", override: { sourceGeneratedAt: "2026-11-03T12:00:00" } },
    { name: "missing source run id", override: { includeSourceRunId: false }, root: { runId: null } },
    {
      name: "missing generated timestamp",
      override: { includeSourceGeneratedAt: false },
      root: { generatedAt: null }
    }
  ];

  for (const { name, override, root = {} } of cases) {
    const [item] = build(payload([9], [override], root), { apiOnlyConstraintRentalDays: [9] }).decisions;
    assert.equal(item.action, "hold", name);
    assert.equal(item.data_quality_status, "api_constraint_unavailable", name);
    assert.equal(item.recommendation_type, "api_constraint_only", name);
    assert.equal(item.verification_scope, "api_only_constraint", name);
    assert.equal(item.requires_popularity_verification, false, name);
    assert.equal(item.maximum_import_rate_pln_day, null, name);
    assert.equal(item.site_cap_rate_pln_day, null, name);
    assert.equal(item.dom_verification_status, undefined, name);
  }
});

test("API-only references require a genuine competitor and an eligible prior active type", () => {
  const [valid] = build(payload([9]), { apiOnlyConstraintRentalDays: [] }).decisions;
  const options = buildOptions({ apiOnlyConstraintRentalDays: [9, 11, 12] });
  const invalid = [
    { benchmark_provider: "MM Cars Rental" },
    { benchmark_provider: " MM-Cars-Rental " },
    { benchmark_provider: "" },
    { mm_provider: "Budget" },
    { recommendation_type: "protected_date" },
    { recommendation_type: "unknown_active_type" }
  ];
  for (const overrides of invalid) {
    const item = applyApiOnlyConstraintPolicy({ ...valid, ...overrides }, options);
    assert.equal(item.action, "hold");
    assert.equal(item.data_quality_status, "api_constraint_unavailable", JSON.stringify(overrides));
    assert.equal(item.maximum_import_rate_pln_day, null);
  }
});

test("missing MM, bad currency, protected dates, and excluded classes remain their original holds", () => {
  const baseOptions = buildOptions({ apiOnlyConstraintRentalDays: [9] });
  const protectedOptions = buildOptions({
    apiOnlyConstraintRentalDays: [9],
    excelPolicy: {
      apply_groups: ["GRP1"],
      excluded_groups: ["EXCL"],
      protected_rate_periods: [{ start_date: "2026-11-03", end_date: "2026-11-03" }],
      group_price_parity: { premium_adjustments_pln_day: {} }
    }
  });
  const makeItem = (override = {}, options = baseOptions) => buildPricingRecommendations(
    payload([9], [override]), options
  ).decisions[0];
  const missingMm = makeItem({ includeMm: false });
  const badCurrency = makeItem({ mmCurrency: "EUR" });
  const protectedDate = makeItem({}, protectedOptions);
  const excludedClass = buildPricingRecommendations(
    payload([9], [{ group: "EXCL", startDate: "2026-11-04" }]),
    protectedOptions
  ).decisions[0];

  for (const item of [missingMm, badCurrency, protectedDate, excludedClass]) {
    assert.equal(item.action, "hold");
    assert.equal(Object.hasOwn(item, "verification_scope"), false);
    assert.equal(Object.hasOwn(item, "api_recommendation_type"), false);
  }
  assert.equal(missingMm.data_quality_status, "missing_mm");
  assert.equal(badCurrency.data_quality_status, "invalid_currency");
  assert.equal(protectedDate.data_quality_status, "protected_date");
  assert.equal(excludedClass.data_quality_status, "class_excluded");
});

test("the day list has no effect unless Recommended fallback is enabled", () => {
  const input = payload([9]);
  const output = build(input, {
    recommendedFallbackToMinimum: false,
    apiOnlyConstraintRentalDays: [9],
    locationTypeFloorsPlnDay: {
      groups: ["GRP1"],
      minDays: 8,
      maxDays: 14,
      minimumRatesByKind: { airport: 100, city: 100 }
    }
  });
  const [item] = output.decisions;

  assert.equal(item.action, "increase");
  assert.notEqual(item.data_quality_status, "api_constraint_only");
  assert.equal(Object.hasOwn(item, "verification_scope"), false);
});
