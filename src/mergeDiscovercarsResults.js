const fs = require("fs");
const path = require("path");

const DEFAULT_OUTPUT = path.resolve("output", "results-latest.json");
const WARSAW_TIME_ZONE = "Europe/Warsaw";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeScenarios(payload) {
  if (Array.isArray(payload?.scenarios) && payload.scenarios.length) {
    return payload.scenarios;
  }
  return payload ? [payload] : [];
}

function uniqueInOrder(items) {
  const seen = new Set();
  const output = [];
  for (const item of items || []) {
    const normalized = String(item || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function collectCheapestOverallAcrossScenarios(scenarios) {
  let cheapest = null;
  for (const scenario of scenarios || []) {
    for (const offer of scenario.results || []) {
      if (!cheapest || Number(offer.total_price) < Number(cheapest.total_price)) {
        cheapest = {
          scenario_id: scenario.scenario_id,
          start_day: scenario.start_day,
          rental_days: scenario.rental_days,
          ...offer
        };
      }
    }
  }
  return cheapest;
}

function buildFallbackSummary(scenarios) {
  const summary = {
    scenarios_with_fallback: 0,
    scenarios_without_fallback: 0,
    by_reason: {}
  };

  for (const scenario of scenarios || []) {
    const execution = scenario?.execution || {};
    if (execution.fallback_used) {
      summary.scenarios_with_fallback += 1;
      const reason = execution.fallback_reason || "unspecified";
      summary.by_reason[reason] = (summary.by_reason[reason] || 0) + 1;
    } else {
      summary.scenarios_without_fallback += 1;
    }
  }

  return summary;
}

function inferLocations(payloads, scenarios) {
  const fromRoots = payloads.flatMap((payload) => (Array.isArray(payload.locations) ? payload.locations : []));
  if (fromRoots.length) {
    return uniqueInOrder(fromRoots);
  }

  const fromScenarios = [];
  for (const scenario of scenarios || []) {
    fromScenarios.push(...Object.keys(scenario.top_3_plus_mm_by_location || {}));
    fromScenarios.push(...Object.keys(scenario.top_3_by_location || {}));
  }
  return uniqueInOrder(fromScenarios).sort((left, right) => left.localeCompare(right));
}

function scenarioSortKey(scenario) {
  const startDate = String(scenario?.start_date || scenario?.pickup_date || "");
  const rentalDays = Number(scenario?.rental_days);
  return {
    startDate,
    rentalDays: Number.isFinite(rentalDays) ? rentalDays : Number.MAX_SAFE_INTEGER,
    scenarioId: String(scenario?.scenario_id || "")
  };
}

function sortScenarios(scenarios) {
  return [...(scenarios || [])].sort((left, right) => {
    const leftKey = scenarioSortKey(left);
    const rightKey = scenarioSortKey(right);
    return (
      leftKey.startDate.localeCompare(rightKey.startDate) ||
      leftKey.rentalDays - rightKey.rentalDays ||
      leftKey.scenarioId.localeCompare(rightKey.scenarioId)
    );
  });
}

function collectInputFiles(rawInputs) {
  const files = [];
  for (const rawInput of rawInputs || []) {
    const inputPath = path.resolve(rawInput);
    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input path does not exist: ${inputPath}`);
    }

    const stat = fs.statSync(inputPath);
    if (stat.isFile()) {
      files.push(inputPath);
      continue;
    }

    const directResult = path.join(inputPath, "results-latest.json");
    if (fs.existsSync(directResult)) {
      files.push(directResult);
    }

    const childResults = fs.readdirSync(inputPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(inputPath, entry.name, "results-latest.json"))
      .filter((candidate) => fs.existsSync(candidate));
    files.push(...childResults);
  }

  return uniqueInOrder(files);
}

function mergePayloads(payloads, sourceFiles = []) {
  const byScenarioId = new Map();
  let duplicateScenarioCount = 0;

  for (const payload of payloads) {
    for (const scenario of normalizeScenarios(payload)) {
      const scenarioId = String(scenario?.scenario_id || "").trim();
      if (!scenarioId) {
        continue;
      }
      if (byScenarioId.has(scenarioId)) {
        duplicateScenarioCount += 1;
      }
      byScenarioId.set(scenarioId, scenario);
    }
  }

  const scenarios = sortScenarios([...byScenarioId.values()]);
  const errors = [];
  for (const scenario of scenarios) {
    for (const error of scenario.errors || []) {
      errors.push({
        scenario_id: scenario.scenario_id,
        start_day: scenario.start_day,
        rental_days: scenario.rental_days,
        ...error
      });
    }
  }

  const locations = inferLocations(payloads, scenarios);
  const rentalDayOptions = [...new Set(
    scenarios
      .map((scenario) => Number(scenario.rental_days))
      .filter((value) => Number.isFinite(value))
  )].sort((left, right) => left - right);

  return {
    generated_at: new Date().toISOString(),
    time_zone: payloads.find((payload) => payload?.time_zone)?.time_zone || WARSAW_TIME_ZONE,
    locations,
    scenario_mode: "start-dates",
    start_days: [],
    start_dates: uniqueInOrder(scenarios.map((scenario) => scenario.start_date).filter(Boolean)),
    rolling_days: null,
    rental_day_options: rentalDayOptions,
    execution_profile: {
      mode: "chunked-merge",
      source_file_count: sourceFiles.length,
      duplicate_scenario_count: duplicateScenarioCount
    },
    scenarios,
    errors,
    fallback_summary: buildFallbackSummary(scenarios),
    cheapest_overall: collectCheapestOverallAcrossScenarios(scenarios),
    merge_meta: {
      merged_at: new Date().toISOString(),
      source_files: sourceFiles,
      scenario_count: scenarios.length,
      duplicate_scenario_count: duplicateScenarioCount
    }
  };
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    output: DEFAULT_OUTPUT
  };

  for (const arg of argv) {
    if (arg.startsWith("--output=")) {
      options.output = path.resolve(arg.slice("--output=".length));
      continue;
    }
    if (arg.startsWith("--input-dir=")) {
      options.inputs.push(arg.slice("--input-dir=".length));
      continue;
    }
    if (arg.startsWith("--inputs=")) {
      options.inputs.push(...arg.slice("--inputs=".length).split(",").filter(Boolean));
      continue;
    }
    if (!arg.startsWith("--")) {
      options.inputs.push(arg);
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceFiles = collectInputFiles(options.inputs);
  if (!sourceFiles.length) {
    throw new Error("No input result files found. Pass files, directories, --inputs=..., or --input-dir=...");
  }

  const payloads = sourceFiles.map(readJson);
  const merged = mergePayloads(payloads, sourceFiles);
  writeJson(options.output, merged);
  console.log(
    JSON.stringify(
      {
        output: options.output,
        source_file_count: sourceFiles.length,
        scenario_count: merged.scenarios.length,
        duplicate_scenario_count: merged.merge_meta.duplicate_scenario_count
      },
      null,
      2
    )
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  collectInputFiles,
  mergePayloads,
  sortScenarios
};
