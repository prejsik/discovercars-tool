const fs = require("fs");
const path = require("path");
const { validateScrapeScope } = require("./scrapeScope");

const KEY_SAMPLE_LIMIT = 20;

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function splitCsv(value) {
  return (Array.isArray(value) ? value.join(",") : String(value || ""))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function listScenarios(results) {
  if (Array.isArray(results?.scenarios)) {
    return results.scenarios;
  }
  return results ? [results] : [];
}

function listRecommendations(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.recommendations)) {
    return payload.recommendations;
  }
  return [];
}

function listSanityWarnings(payload) {
  if (!payload || !Array.isArray(payload.checks)) {
    return [];
  }
  return payload.checks.filter((item) => item && item.status !== "OK");
}

function getExcelErrorMessage(excelSummary) {
  if (!excelSummary || (excelSummary.status !== "error" && !excelSummary.error)) {
    return "";
  }
  const error = excelSummary.error;
  const message = typeof error === "string" ? error : error?.message;
  return String(message || "Generator Excel zakonczyl sie bledem bez komunikatu.")
    .replace(/\s+/g, " ")
    .trim();
}

function hasLocationData(scenario, location) {
  const data = scenario?.top_3_plus_mm_by_location?.[location];
  return Boolean(data && Array.isArray(data.top_3) && data.top_3.some(Boolean));
}

function hasMmData(scenario, location) {
  return Boolean(scenario?.top_3_plus_mm_by_location?.[location]?.mm_cars_rental);
}

function listOfferCurrencies(scenario, location) {
  const data = scenario?.top_3_plus_mm_by_location?.[location] || {};
  return [...new Set(
    [...(data.top_3 || []), data.mm_cars_rental]
      .filter(Boolean)
      .map((offer) => String(offer.currency || "").trim().toUpperCase())
      .filter(Boolean)
  )];
}

function summarizeApiDomMonitoring(results, scenarios) {
  if (results?.api_dom_monitoring) {
    return results.api_dom_monitoring;
  }
  const summary = {
    comparison_count: 0,
    drift_count: 0,
    fallback_count: 0,
    browser_preferred_count: 0,
    adaptive_validation_triggered: false,
    reason_counts: {}
  };
  for (const scenario of scenarios || []) {
    const monitoring = scenario?.api_dom_monitoring;
    if (!monitoring) {
      continue;
    }
    summary.comparison_count += Number(monitoring.comparison_count || 0);
    summary.drift_count += Number(monitoring.drift_count || 0);
    summary.fallback_count += Number(monitoring.fallback_count || 0);
    summary.browser_preferred_count += Number(monitoring.browser_preferred_count || 0);
    summary.adaptive_validation_triggered ||= Boolean(monitoring.adaptive_validation_triggered);
    for (const [reason, count] of Object.entries(monitoring.reason_counts || {})) {
      summary.reason_counts[reason] = (summary.reason_counts[reason] || 0) + Number(count || 0);
    }
  }
  summary.drift_rate_percent = summary.comparison_count
    ? Number((summary.drift_count / summary.comparison_count * 100).toFixed(2))
    : 0;
  return summary;
}

function publicationStatus(status) {
  return status === "failure" ? "blocked" : status === "degraded" ? "partial" : "complete";
}

function scenarioKey(scenario) {
  const date = String(scenario?.start_date || scenario?.pickup_date || "").slice(0, 10);
  return `${date}|${Number(scenario?.rental_days)}`;
}

function observedLocations(scenario) {
  return [...new Set([
    ...Object.keys(scenario?.top_3_plus_mm_by_location || {}),
    ...Object.keys(scenario?.offer_views_by_location || {}),
    ...Object.keys(scenario?.mm_cars_rental_by_location || {}),
    ...(Array.isArray(scenario?.results) ? scenario.results.map((item) => item?.location).filter(Boolean) : [])
  ])];
}

function hasInvalidCurrency(scenario, location) {
  const data = scenario?.top_3_plus_mm_by_location?.[location] || {};
  const views = Object.values(scenario?.offer_views_by_location?.[location] || {});
  const offers = [...(data.top_3 || []), data.mm_cars_rental,
    ...views.flatMap((view) => [...(view?.top_3 || []), view?.mm_cars_rental])].filter(Boolean);
  return offers.some((offer) => String(offer.currency || "").trim().toUpperCase() !== "PLN");
}

function buildExpectedScopeQualityReport(results, scope) {
  const scenarios = listScenarios(results);
  const expectedKeys = new Set(scope.scenario_keys);
  const expectedLocationKeys = new Set(scope.location_check_keys);
  const byKey = new Map();
  const extraKeys = new Set();
  const duplicateKeys = new Set();
  const locationKeys = new Set();
  const extraLocationKeys = new Set();
  let duplicateCount = 0;
  let extraCount = 0;
  let invalidCurrencyCount = 0;
  for (const scenario of scenarios) {
    const key = scenarioKey(scenario);
    if (byKey.has(key)) {
      duplicateCount += 1;
      duplicateKeys.add(key);
    } else {
      byKey.set(key, scenario);
    }
    if (!expectedKeys.has(key)) {
      extraCount += 1;
      extraKeys.add(key);
    }
    for (const location of observedLocations(scenario)) {
      const locationKey = `${key}|${location}`;
      if (expectedLocationKeys.has(locationKey)) locationKeys.add(locationKey);
      else extraLocationKeys.add(locationKey);
      if (hasInvalidCurrency(scenario, location)) invalidCurrencyCount += 1;
    }
  }
  const missingKeys = scope.scenario_keys.filter((key) => !byKey.has(key));
  const missingLocationKeys = scope.location_check_keys.filter((key) => !locationKeys.has(key));
  const missingDates = scope.start_dates.filter((date) => !scope.durations.some((duration) => byKey.has(`${date}|${duration}`)));
  const coverage = scope.locations.map((location) => {
    let top3Count = 0;
    let mmCount = 0;
    for (const key of scope.scenario_keys) {
      if (hasLocationData(byKey.get(key), location)) top3Count += 1;
      if (hasMmData(byKey.get(key), location)) mmCount += 1;
    }
    return {
      location,
      scenario_count: scope.expected_scenario_count,
      top3_count: top3Count,
      mm_count: mmCount,
      invalid_currency_count: scenarios.filter((scenario) => hasInvalidCurrency(scenario, location)).length
    };
  });
  const top3Count = coverage.reduce((sum, item) => sum + item.top3_count, 0);
  const mmCount = coverage.reduce((sum, item) => sum + item.mm_count, 0);
  const monitoring = summarizeApiDomMonitoring(results, scenarios);
  const failedCount = scenarios.filter((scenario) => !(scenario?.results || []).length && (scenario?.errors || []).length).length;
  const chunkFailureCount = Array.isArray(results?.chunk_failures) ? results.chunk_failures.length : 0;
  let status = "success";
  if (!top3Count || invalidCurrencyCount) status = "failure";
  else if (missingKeys.length || missingLocationKeys.length || extraCount || extraLocationKeys.size || duplicateCount
    || top3Count < scope.expected_location_check_count || mmCount < scope.expected_location_check_count
    || failedCount || chunkFailureCount || monitoring.adaptive_validation_triggered) status = "degraded";
  return {
    status,
    publication_status: publicationStatus(status),
    expected_scope_provided: true,
    scope_schema_version: scope.schema_version,
    scope_anchor_date: scope.anchor_date,
    scenario_count: scenarios.length,
    expected_scenario_count: scope.expected_scenario_count,
    matched_scenario_count: scope.expected_scenario_count - missingKeys.length,
    missing_scenario_count: missingKeys.length,
    extra_scenario_count: extraCount,
    duplicate_scenario_count: duplicateCount,
    missing_scenario_keys: missingKeys.slice(0, KEY_SAMPLE_LIMIT),
    extra_scenario_keys: [...extraKeys].slice(0, KEY_SAMPLE_LIMIT),
    duplicate_scenario_keys: [...duplicateKeys].slice(0, KEY_SAMPLE_LIMIT),
    expected_start_date_count: scope.start_dates.length,
    missing_start_date_count: missingDates.length,
    missing_start_dates: missingDates.slice(0, KEY_SAMPLE_LIMIT),
    expected_location_check_count: scope.expected_location_check_count,
    matched_location_check_count: locationKeys.size,
    missing_location_check_count: missingLocationKeys.length,
    extra_location_check_count: extraLocationKeys.size,
    missing_location_check_keys: missingLocationKeys.slice(0, KEY_SAMPLE_LIMIT),
    extra_location_check_keys: [...extraLocationKeys].slice(0, KEY_SAMPLE_LIMIT),
    key_sample_limit: KEY_SAMPLE_LIMIT,
    top3_coverage_percent: top3Count === scope.expected_location_check_count ? 100
      : Math.min(99.99, Number((top3Count / scope.expected_location_check_count * 100).toFixed(2))),
    missing_top3_count: scope.expected_location_check_count - top3Count,
    missing_mm_count: scope.expected_location_check_count - mmCount,
    invalid_currency_count: invalidCurrencyCount,
    failed_scenario_count: failedCount,
    chunk_failure_count: chunkFailureCount,
    coverage,
    api_dom_monitoring: monitoring
  };
}

function buildScrapeQualityReport({ results, expectedLocations, expectedScope, requireScope = false }) {
  if (expectedScope !== undefined || requireScope) {
    try {
      const scope = validateScrapeScope(expectedScope);
      if (expectedLocations && JSON.stringify([...new Set(splitCsv(expectedLocations))].sort()) !== JSON.stringify([...scope.locations].sort())) {
        throw new Error("Scope locations do not match requested locations.");
      }
      return buildExpectedScopeQualityReport(results, scope);
    } catch (error) {
      return {
        status: "failure", publication_status: "blocked", expected_scope_provided: Boolean(expectedScope),
        scope_validation_error: error.message, scenario_count: listScenarios(results).length,
        expected_location_check_count: 0, top3_coverage_percent: 0, missing_top3_count: 0,
        missing_mm_count: 0, invalid_currency_count: 0, failed_scenario_count: 0,
        chunk_failure_count: 0, coverage: [], api_dom_monitoring: summarizeApiDomMonitoring(results, listScenarios(results))
      };
    }
  }
  const scenarios = listScenarios(results);
  const apiDomMonitoring = summarizeApiDomMonitoring(results, scenarios);
  const locations = splitCsv(expectedLocations || results?.locations?.join(","));
  const coverage = [];
  let missingTop3Count = 0;
  let missingMmCount = 0;
  let invalidCurrencyCount = 0;

  for (const location of locations) {
    const top3Count = scenarios.filter((scenario) => hasLocationData(scenario, location)).length;
    const mmCount = scenarios.filter((scenario) => hasMmData(scenario, location)).length;
    const invalidCurrencyScenarios = scenarios.filter((scenario) => {
      const currencies = listOfferCurrencies(scenario, location);
      return currencies.length > 1 || currencies.some((currency) => currency !== "PLN");
    }).length;
    missingTop3Count += Math.max(0, scenarios.length - top3Count);
    missingMmCount += Math.max(0, scenarios.length - mmCount);
    invalidCurrencyCount += invalidCurrencyScenarios;
    coverage.push({
      location,
      scenario_count: scenarios.length,
      top3_count: top3Count,
      mm_count: mmCount,
      invalid_currency_count: invalidCurrencyScenarios
    });
  }

  const expectedChecks = scenarios.length * locations.length;
  const top3Coverage = expectedChecks ? (expectedChecks - missingTop3Count) / expectedChecks : 0;
  const failedScenarioCount = scenarios.filter(
    (scenario) => !(scenario.results || []).length && (scenario.errors || []).length
  ).length;
  const chunkFailureCount = Array.isArray(results?.chunk_failures) ? results.chunk_failures.length : 0;
  let status = "success";
  if (!results || !scenarios.length || invalidCurrencyCount > 0 || top3Coverage < 0.95) {
    status = "failure";
  } else if (
    missingTop3Count > 0
    || missingMmCount > 0
    || failedScenarioCount > 0
    || chunkFailureCount > 0
    || apiDomMonitoring.adaptive_validation_triggered
  ) {
    status = "degraded";
  }

  return {
    status,
    publication_status: publicationStatus(status),
    expected_scope_provided: false,
    scenario_count: scenarios.length,
    expected_location_check_count: expectedChecks,
    top3_coverage_percent: Number((top3Coverage * 100).toFixed(2)),
    missing_top3_count: missingTop3Count,
    missing_mm_count: missingMmCount,
    invalid_currency_count: invalidCurrencyCount,
    failed_scenario_count: failedScenarioCount,
    chunk_failure_count: chunkFailureCount,
    coverage,
    api_dom_monitoring: apiDomMonitoring
  };
}

function summarizeDomVerification(recommendations) {
  const data = recommendations?.dom_verification;
  if (!data) return null;
  const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const active = count(data.active_input_count);
  const blocked = count(data.blocked_count);
  const budgetCount = count(data.budget_exhausted_count ?? (data.budget_exhausted ? blocked : 0));
  return {
    ...data,
    active_input_count: active,
    confirmed_count: count(data.confirmed_count),
    blocked_count: blocked,
    budget_exhausted_count: budgetCount,
    budget_exhausted: Boolean(data.budget_exhausted || budgetCount),
    checked_count: Math.max(0, active - budgetCount)
  };
}

function buildCompletionMessages(quality = {}) {
  const messages = [];
  if (quality.expected_scope_provided && quality.expected_scenario_count) {
    messages.push(`Zakres sprawdzony: ${quality.matched_scenario_count}/${quality.expected_scenario_count}; dane dla ${quality.expected_location_check_count - quality.missing_top3_count}/${quality.expected_location_check_count} połączeń daty, najmu i lokalizacji.`);
  }
  const verification = summarizeDomVerification({ dom_verification: quality.dom_verification });
  if (verification?.active_input_count) {
    const budgetCount = Number(verification.budget_exhausted_count || 0);
    const otherBlocked = Math.max(0, Number(verification.blocked_count || 0) - budgetCount);
    messages.push(`Sprawdzono ${verification.checked_count}/${verification.active_input_count}${budgetCount ? `; pominięto ${budgetCount} zmian przez limit czasu` : ""}${otherBlocked ? `; pominięto ${otherBlocked} zmian po kontroli cen` : ""}.`);
  }
  return messages;
}

function buildQualityReport({
  results,
  recommendations,
  excelSummary,
  sanityCheck,
  expectedLocations,
  expectedScope,
  requireScope = false,
  scrapeOnly = false,
  requireSanity = false
}) {
  const alerts = [];
  const blockingAlerts = [];
  const addBlockingAlert = (message) => {
    alerts.push(message);
    blockingAlerts.push(message);
  };
  const scenarios = listScenarios(results);
  const scrape = buildScrapeQualityReport({ results, expectedLocations, expectedScope, requireScope });
  const requireVerifiedSanitySample = Boolean(requireSanity && Number(excelSummary?.change_count || 0) > 0);
  const excelErrorMessage = getExcelErrorMessage(excelSummary);

  if (!results) {
    addBlockingAlert("Brak pliku results-latest.json.");
  } else if (!scenarios.length) {
    addBlockingAlert("Brak scenariuszy w results-latest.json.");
  }

  if (scrape.scope_validation_error) {
    addBlockingAlert(`Brak lub nieprawidłowy manifest zakresu: ${scrape.scope_validation_error}`);
  }
  if (scrape.missing_scenario_count > 0) {
    alerts.push(`Brak scenariuszy: ${scrape.missing_scenario_count}/${scrape.expected_scenario_count}; brak całych dat: ${scrape.missing_start_date_count}.`);
  }
  if (scrape.extra_scenario_count || scrape.duplicate_scenario_count || scrape.extra_location_check_count) {
    alerts.push(`Dane poza zakresem: ${scrape.extra_scenario_count || 0} scenariuszy, ${scrape.extra_location_check_count || 0} lokalizacji; powtórzone scenariusze: ${scrape.duplicate_scenario_count || 0}.`);
  }
  if (scenarios.length) {
    for (const row of scrape.coverage) {
      const { location, scenario_count: expectedCount } = row;
      const missingCount = expectedCount - row.top3_count;
      if (missingCount > 0) {
        alerts.push(`Brak danych dla ${location}: ${missingCount}/${expectedCount} scenariuszy.`);
      }
      const missingMmCount = expectedCount - row.mm_count;
      if (missingMmCount > 0) {
        alerts.push(`Brak MM Cars Rental dla ${location}: ${missingMmCount}/${expectedCount} scenariuszy.`);
      }
    }
  }

  if (scrape.invalid_currency_count > 0) {
    addBlockingAlert(`Nieprawidlowa lub mieszana waluta: ${scrape.invalid_currency_count} scenariuszy/lokalizacji.`);
  }
  if (!scrape.scope_validation_error && scrape.expected_scope_provided && scrape.status === "failure" && !scrape.invalid_currency_count) {
    addBlockingAlert("Brak użytecznych danych cenowych w oczekiwanym zakresie.");
  } else if (!scrape.expected_scope_provided && !scrape.scope_validation_error && scrape.top3_coverage_percent < 95) {
    addBlockingAlert(`Pokrycie Top 3 wynosi ${scrape.top3_coverage_percent}%, ponizej wymaganego minimum 95%.`);
  }
  if (scrape.chunk_failure_count > 0) {
    alerts.push(`Niepelne chunki scrapera po retry: ${scrape.chunk_failure_count}.`);
  }
  const apiDom = scrape.api_dom_monitoring || {};
  if (Number(apiDom.comparison_count || 0) > 0 && Number(apiDom.drift_count || 0) > 0) {
    alerts.push(
      `Kontrola cen: różnice w ${apiDom.drift_count}/${apiDom.comparison_count} porównań; użyto potwierdzonych cen ${apiDom.browser_preferred_count || 0} razy.`
    );
  }
  if (apiDom.adaptive_validation_triggered) {
    alerts.push("Kontrola cen objęła więcej próbek w lokalizacjach z różnicami cen.");
  }

  if (scrapeOnly) {
    return { ...scrape, completion_messages: buildCompletionMessages(scrape), alert_count: alerts.length, alerts, blocking_alerts: blockingAlerts };
  }

  if (!recommendations) {
    addBlockingAlert("Brak pliku final-pricing-recommendations.json.");
  } else if (listRecommendations(recommendations).filter((item) => item.action !== "hold").length === 0) {
    alerts.push("Brak aktywnych rekomendacji cenowych.");
  }
  const domVerification = summarizeDomVerification(recommendations);
  if (domVerification && (domVerification.blocked_count || domVerification.budget_exhausted)) {
    alerts.push(...buildCompletionMessages({ dom_verification: domVerification }));
  }

  if (!excelSummary) {
    addBlockingAlert("Brak pliku excel-rate-update-summary.json.");
  } else if (excelErrorMessage) {
    addBlockingAlert(`Blad generowania pliku Excel: ${excelErrorMessage}`);
  } else {
    if (Number(excelSummary.change_count || 0) === 0) {
      alerts.push("Excel nie zawiera zmian stawek.");
    }
    for (const row of Array.isArray(excelSummary.validation) ? excelSummary.validation : []) {
      if (row.status && row.status !== "OK" && row.status !== "INFO") {
        const message = `Validation ${row.status}: ${row.check} (${row.issue_count}).`;
        if (row.status === "FAIL") {
          addBlockingAlert(message);
        } else {
          alerts.push(message);
        }
      }
    }
  }

  let requiredSanityFailed = false;
  if (requireVerifiedSanitySample && !sanityCheck) {
    addBlockingAlert("Brak obowiazkowego sanity checku MM po potwierdzonym imporcie baseline.");
    requiredSanityFailed = true;
  } else if (sanityCheck) {
    const warnings = listSanityWarnings(sanityCheck);
    if (warnings.length) {
      const threshold = sanityCheck.threshold_pln_day ?? "brak danych";
      const details = warnings
        .slice(0, 3)
        .map((item) => {
          const scenario = `${item.location || "?"} ${item.start_date || "?"} ${item.rental_days || "?"}d`;
          const delta = item.delta_pln_day ?? "brak danych";
          const reasons = Array.isArray(item.warning_reasons) && item.warning_reasons.length
            ? `; powod ${item.warning_reasons.join(",")}`
            : "";
          const multiplier = item.observed_broker_markup_multiplier == null
            ? ""
            : `; narzut x${item.observed_broker_markup_multiplier}`;
          return `${scenario}: roznica ${delta} PLN/dzien${reasons}${multiplier}`;
        })
        .join("; ");
      alerts.push(
        `Sanity check MM: ${warnings.length}/${sanityCheck.checked_count || 0} probek przekracza prog ${threshold} PLN/dzien. ${details}`
      );
    }
    if (requireVerifiedSanitySample && Number(sanityCheck.checked_count || 0) === 0) {
      addBlockingAlert("Obowiazkowy sanity check MM nie zweryfikowal zadnej probki.");
      requiredSanityFailed = true;
    }
    if (
      requireVerifiedSanitySample
      && sanityCheck.baseline_verification_required
      && Number(sanityCheck.baseline_verified_count || 0) < Number(sanityCheck.checked_count || 0)
    ) {
      const message = `Baseline po imporcie potwierdzony dla ${sanityCheck.baseline_verified_count || 0}/${sanityCheck.checked_count || 0} probek.`;
      if (Number(sanityCheck.baseline_verified_count || 0) === 0) {
        addBlockingAlert(message);
        requiredSanityFailed = true;
      } else {
        alerts.push(message);
      }
    }
  }

  let status = scrape.status;
  const failedExcelValidation = Array.isArray(excelSummary?.validation)
    && excelSummary.validation.some((row) => row?.status === "FAIL");
  if (!recommendations || !excelSummary || excelErrorMessage || failedExcelValidation || requiredSanityFailed) {
    status = "failure";
  } else if (status === "success" && alerts.length) {
    status = "degraded";
  }

  return {
    ...scrape,
    status,
    publication_status: publicationStatus(status),
    dom_verification: domVerification,
    completion_messages: buildCompletionMessages({ ...scrape, dom_verification: domVerification }),
    sanity_required: Boolean(requireSanity),
    sanity_checked_count: Number(sanityCheck?.checked_count || 0),
    sanity_warning_count: Number(sanityCheck?.warning_count || 0),
    baseline_verified_count: Number(sanityCheck?.baseline_verified_count || 0),
    alert_count: alerts.length,
    alerts,
    blocking_alerts: blockingAlerts
  };
}

function buildQualityAlerts(input) {
  return buildQualityReport(input).alerts;
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    const value = equals < 0 ? "" : arg.slice(equals + 1);
    args[key] = value;
  }
  return args;
}

function runCli(argv) {
  const args = parseArgs(argv);
  const scopeRequested = Object.prototype.hasOwnProperty.call(args, "scope");
  let expectedScope;
  if (scopeRequested) {
    try {
      expectedScope = readJsonIfExists(args.scope);
    } catch {
      expectedScope = null;
    }
  }
  const report = buildQualityReport({
    results: readJsonIfExists(args.results),
    recommendations: readJsonIfExists(args.recommendations),
    excelSummary: readJsonIfExists(args["excel-summary"]),
    sanityCheck: readJsonIfExists(args["sanity-check"]),
    expectedLocations: args.locations,
    expectedScope,
    requireScope: scopeRequested || Object.prototype.hasOwnProperty.call(args, "require-scope"),
    scrapeOnly: Object.prototype.hasOwnProperty.call(args, "scrape-only"),
    requireSanity: Object.prototype.hasOwnProperty.call(args, "require-sanity")
  });
  const output = report;
  const outputPath = args.output ? path.resolve(args.output) : null;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  } else {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2));
}

module.exports = {
  buildCompletionMessages,
  summarizeDomVerification,
  buildQualityAlerts,
  buildQualityReport,
  buildScrapeQualityReport
};
