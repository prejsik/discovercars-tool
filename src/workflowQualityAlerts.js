const fs = require("fs");
const path = require("path");

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function splitCsv(value) {
  return String(value || "")
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

function hasLocationData(scenario, location) {
  const data = scenario?.top_3_plus_mm_by_location?.[location];
  return Boolean(data && (Array.isArray(data.top_3) && data.top_3.length > 0));
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

function buildScrapeQualityReport({ results, expectedLocations }) {
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

function buildQualityReport({
  results,
  recommendations,
  excelSummary,
  sanityCheck,
  expectedLocations,
  scrapeOnly = false,
  requireSanity = false
}) {
  const alerts = [];
  const scenarios = listScenarios(results);
  const locations = splitCsv(expectedLocations);
  const scrape = buildScrapeQualityReport({ results, expectedLocations });
  const requireVerifiedSanitySample = Boolean(requireSanity && Number(excelSummary?.change_count || 0) > 0);

  if (!results) {
    alerts.push("Brak pliku results-latest.json.");
  } else if (!scenarios.length) {
    alerts.push("Brak scenariuszy w results-latest.json.");
  }

  if (scenarios.length && locations.length) {
    for (const location of locations) {
      const missingCount = scenarios.filter((scenario) => !hasLocationData(scenario, location)).length;
      if (missingCount > 0) {
        alerts.push(`Brak danych dla ${location}: ${missingCount}/${scenarios.length} scenariuszy.`);
      }
      const missingMmCount = scenarios.filter((scenario) => !hasMmData(scenario, location)).length;
      if (missingMmCount > 0) {
        alerts.push(`Brak MM Cars Rental dla ${location}: ${missingMmCount}/${scenarios.length} scenariuszy.`);
      }
    }
  }

  if (scrape.invalid_currency_count > 0) {
    alerts.push(`Nieprawidlowa lub mieszana waluta: ${scrape.invalid_currency_count} scenariuszy/lokalizacji.`);
  }
  if (scrape.chunk_failure_count > 0) {
    alerts.push(`Niepelne chunki scrapera po retry: ${scrape.chunk_failure_count}.`);
  }
  const apiDom = scrape.api_dom_monitoring || {};
  if (Number(apiDom.comparison_count || 0) > 0 && Number(apiDom.drift_count || 0) > 0) {
    const reasonSummary = Object.entries(apiDom.reason_counts || {})
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 4)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    alerts.push(
      `Kontrola API-DOM: rozjazd ${apiDom.drift_count}/${apiDom.comparison_count} (${apiDom.drift_rate_percent || 0}%), wybrano DOM ${apiDom.browser_preferred_count || 0} razy.${reasonSummary ? ` Powody: ${reasonSummary}.` : ""}`
    );
  }
  if (apiDom.adaptive_validation_triggered) {
    alerts.push("Kontrola API-DOM zwiekszyla probe tylko dla lokalizacji z podwyzszonym poziomem rozjazdow.");
  }

  if (scrapeOnly) {
    return { ...scrape, alert_count: alerts.length, alerts };
  }

  if (!recommendations) {
    alerts.push("Brak pliku final-pricing-recommendations.json.");
  } else if (listRecommendations(recommendations).filter((item) => item.action !== "hold").length === 0) {
    alerts.push("Brak aktywnych rekomendacji cenowych.");
  }
  if (Number(recommendations?.dom_verification?.blocked_count || 0) > 0) {
    alerts.push(
      `Kontrola DOM rekomendacji zablokowala ${recommendations.dom_verification.blocked_count}/${recommendations.dom_verification.active_input_count || 0} aktywnych zmian.`
    );
  }

  if (!excelSummary) {
    alerts.push("Brak pliku excel-rate-update-summary.json.");
  } else {
    if (Number(excelSummary.change_count || 0) === 0) {
      alerts.push("Excel nie zawiera zmian stawek.");
    }
    for (const row of Array.isArray(excelSummary.validation) ? excelSummary.validation : []) {
      if (row.status && row.status !== "OK" && row.status !== "INFO") {
        alerts.push(`Validation ${row.status}: ${row.check} (${row.issue_count}).`);
      }
    }
  }

  let requiredSanityFailed = false;
  if (requireVerifiedSanitySample && !sanityCheck) {
    alerts.push("Brak obowiazkowego sanity checku MM po potwierdzonym imporcie baseline.");
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
      alerts.push("Obowiazkowy sanity check MM nie zweryfikowal zadnej probki.");
      requiredSanityFailed = true;
    }
    if (
      requireVerifiedSanitySample
      && sanityCheck.baseline_verification_required
      && Number(sanityCheck.baseline_verified_count || 0) < Number(sanityCheck.checked_count || 0)
    ) {
      alerts.push(
        `Baseline po imporcie potwierdzony dla ${sanityCheck.baseline_verified_count || 0}/${sanityCheck.checked_count || 0} probek.`
      );
      if (Number(sanityCheck.baseline_verified_count || 0) === 0) {
        requiredSanityFailed = true;
      }
    }
  }

  let status = scrape.status;
  const failedExcelValidation = Array.isArray(excelSummary?.validation)
    && excelSummary.validation.some((row) => row?.status === "FAIL");
  if (!recommendations || !excelSummary || failedExcelValidation || requiredSanityFailed) {
    status = "failure";
  } else if (status === "success" && alerts.length) {
    status = "degraded";
  }

  return {
    ...scrape,
    status,
    sanity_required: Boolean(requireSanity),
    sanity_checked_count: Number(sanityCheck?.checked_count || 0),
    sanity_warning_count: Number(sanityCheck?.warning_count || 0),
    baseline_verified_count: Number(sanityCheck?.baseline_verified_count || 0),
    alert_count: alerts.length,
    alerts
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
    const [key, value = ""] = arg.slice(2).split("=");
    args[key] = value;
  }
  return args;
}

function runCli(argv) {
  const args = parseArgs(argv);
  const report = buildQualityReport({
    results: readJsonIfExists(args.results),
    recommendations: readJsonIfExists(args.recommendations),
    excelSummary: readJsonIfExists(args["excel-summary"]),
    sanityCheck: readJsonIfExists(args["sanity-check"]),
    expectedLocations: args.locations,
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
  buildQualityAlerts,
  buildQualityReport,
  buildScrapeQualityReport
};
