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

function buildQualityAlerts({ results, recommendations, excelSummary, sanityCheck, expectedLocations }) {
  const alerts = [];
  const scenarios = listScenarios(results);
  const locations = splitCsv(expectedLocations);

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
    }
  }

  if (!recommendations) {
    alerts.push("Brak pliku final-pricing-recommendations.json.");
  } else if (listRecommendations(recommendations).filter((item) => item.action !== "hold").length === 0) {
    alerts.push("Brak aktywnych rekomendacji cenowych.");
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

  if (sanityCheck) {
    const warnings = listSanityWarnings(sanityCheck);
    if (warnings.length) {
      const threshold = sanityCheck.threshold_pln_day ?? "brak danych";
      const details = warnings
        .slice(0, 3)
        .map((item) => {
          const scenario = `${item.location || "?"} ${item.start_date || "?"} ${item.rental_days || "?"}d`;
          const delta = item.delta_pln_day ?? "brak danych";
          return `${scenario}: roznica ${delta} PLN/dzien`;
        })
        .join("; ");
      alerts.push(
        `Sanity check MM: ${warnings.length}/${sanityCheck.checked_count || 0} probek przekracza prog ${threshold} PLN/dzien. ${details}`
      );
    }
  }

  return alerts;
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
  const alerts = buildQualityAlerts({
    results: readJsonIfExists(args.results),
    recommendations: readJsonIfExists(args.recommendations),
    excelSummary: readJsonIfExists(args["excel-summary"]),
    sanityCheck: readJsonIfExists(args["sanity-check"]),
    expectedLocations: args.locations
  });
  const output = {
    alert_count: alerts.length,
    alerts
  };
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
  buildQualityAlerts
};
