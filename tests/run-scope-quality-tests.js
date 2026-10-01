const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildQualityReport, buildScrapeQualityReport } = require("../src/workflowQualityAlerts");
const { buildTelegramSummary } = require("../src/telegramSummary");
const { buildHtmlReport } = require("../src/reportHtml");

let failures = 0;
function test(name, run) {
  try {
    run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}: ${error.message.slice(0, 1000)}`);
  }
}

function scopeFixture(startDates = ["2026-10-02", "2026-10-03"], durations = [2, 3], locations = ["Warsaw"]) {
  const scenarioKeys = startDates.flatMap((date) => durations.map((duration) => `${date}|${duration}`));
  return {
    schema_version: 1,
    generated_at: "2026-10-01T10:00:00.000Z",
    time_zone: "Europe/Warsaw",
    anchor_date: "2026-10-01",
    mode: "start-dates",
    rolling_days: null,
    start_dates: startDates,
    durations,
    locations,
    expected_scenario_count: scenarioKeys.length,
    expected_location_check_count: scenarioKeys.length * locations.length,
    scenario_keys: scenarioKeys,
    location_check_keys: scenarioKeys.flatMap((key) => locations.map((location) => `${key}|${location}`))
  };
}

function scenario(startDate = "2026-10-02", rentalDays = 2, locations = ["Warsaw"]) {
  return {
    start_date: startDate,
    pickup_date: `${startDate}T11:00:00+02:00`,
    rental_days: rentalDays,
    results: locations.map((location) => ({ location })),
    errors: [],
    top_3_plus_mm_by_location: Object.fromEntries(locations.map((location) => [location, {
      top_3: [{ provider_name: "Other", currency: "PLN", total_price: 200, rental_days: rentalDays }],
      mm_cars_rental: { provider_name: "MM Cars Rental", currency: "PLN", total_price: 220, rental_days: rentalDays }
    }]))
  };
}

const gridDates = Array.from({ length: 60 }, (_, index) => new Date(Date.UTC(2026, 9, 2 + index)).toISOString().slice(0, 10));
const gridDurations = Array.from({ length: 13 }, (_, index) => index + 2);
const fullScope = scopeFixture(gridDates, gridDurations, ["Warsaw", "Gdansk"]);
const fullResults = { locations: fullScope.locations, scenarios: gridDates.flatMap((date) => gridDurations.map((duration) => scenario(date, duration, fullScope.locations))) };
const publicationInput = {
  recommendations: { recommendations: [{ action: "increase" }] },
  excelSummary: { change_count: 1, validation: [{ status: "OK", check: "Import", issue_count: 0 }] }
};
const env = {
  QUALITY_STATUS: "success", ROLLING_DAYS: "60", DURATIONS: "2,3,4,5,6,7,8,9,10,11,12,13,14",
  PAGE_URL: "https://example.test/report.html", PAGES_EXCEL_URL: "https://example.test/import.xlsx",
  PAGES_EXCEL_REPORT_URL: "https://example.test/recommendations.xlsx"
};

test("one of 780 scenarios cannot masquerade as 100 percent success", () => {
  const quality = buildQualityReport({ ...publicationInput, expectedScope: fullScope, results: { locations: fullScope.locations, scenarios: [fullResults.scenarios[0]] } });
  assert.equal(quality.status, "degraded");
  assert.equal(quality.publication_status, "partial");
  assert.equal(quality.expected_scenario_count, 780);
  assert.equal(quality.missing_scenario_count, 779);
  assert.equal(quality.missing_start_date_count, 59);
  assert.equal(quality.expected_location_check_count, 1560);
  assert.equal(quality.top3_coverage_percent, 0.13);
  assert.equal(quality.missing_top3_count, 1558);
  assert(quality.missing_scenario_keys.length <= 20);
  assert(quality.missing_location_check_keys.length <= 20);
  assert.equal(quality.blocking_alerts.length, 0);
});

test("a whole missing date is partial even above the old 95 percent threshold", () => {
  const quality = buildScrapeQualityReport({ expectedScope: fullScope, results: { ...fullResults, scenarios: fullResults.scenarios.slice(0, -13) } });
  assert.equal(quality.status, "degraded");
  assert.equal(quality.missing_scenario_count, 13);
  assert.deepEqual(quality.missing_start_dates, ["2026-11-30"]);
  assert.equal(quality.top3_coverage_percent, 98.33);
});

test("complete 60 by 13 grid is complete with 1560 location checks", () => {
  const quality = buildQualityReport({ ...publicationInput, expectedScope: fullScope, results: fullResults });
  assert.equal(quality.status, "success");
  assert.equal(quality.publication_status, "complete");
  assert.equal(quality.matched_scenario_count, 780);
  assert.equal(quality.matched_location_check_count, 1560);
  assert.equal(quality.top3_coverage_percent, 100);
  assert.equal(quality.missing_scenario_count, 0);
});

test("a duplicate cannot replace a missing scenario or inflate coverage", () => {
  const expectedScope = scopeFixture(["2026-10-02"], [2, 3]);
  const quality = buildScrapeQualityReport({ expectedScope, results: { scenarios: [scenario(), scenario()] } });
  assert.equal(quality.duplicate_scenario_count, 1);
  assert.equal(quality.missing_scenario_count, 1);
  assert.equal(quality.top3_coverage_percent, 50);
  assert.notEqual(quality.status, "success");
});

test("even a duplicate added to a complete grid prevents complete status", () => {
  const quality = buildScrapeQualityReport({ expectedScope: scopeFixture(["2026-10-02"], [2]), results: { scenarios: [scenario(), scenario()] } });
  assert.equal(quality.duplicate_scenario_count, 1);
  assert.equal(quality.publication_status, "partial");
});

test("wrong duration and location are extra, not matching checks", () => {
  const quality = buildScrapeQualityReport({ expectedScope: scopeFixture(["2026-10-02"], [2], ["Warsaw", "Gdansk"]), results: { scenarios: [scenario(), scenario("2026-10-02", 4, ["Poznan"])] } });
  assert.equal(quality.extra_scenario_count, 1);
  assert.equal(quality.extra_location_check_count, 1);
  assert.equal(quality.missing_location_check_count, 1);
  assert.equal(quality.top3_coverage_percent, 50);
  assert.deepEqual(quality.extra_scenario_keys, ["2026-10-02|4"]);
  assert.deepEqual(quality.missing_location_check_keys, ["2026-10-02|2|Gdansk"]);
});

test("unexpected location within a matching scenario prevents complete status", () => {
  const quality = buildScrapeQualityReport({ expectedScope: scopeFixture(["2026-10-02"], [2]), results: { scenarios: [scenario("2026-10-02", 2, ["Warsaw", "Poznan"])] } });
  assert.equal(quality.extra_location_check_count, 1);
  assert.equal(quality.publication_status, "partial");
});

test("pickup date fallback and numeric duration strings match exact scope", () => {
  const item = scenario();
  delete item.start_date;
  item.rental_days = "2";
  assert.equal(buildScrapeQualityReport({ expectedScope: scopeFixture(["2026-10-02"], [2]), results: { scenarios: [item] } }).status, "success");
});

test("no expected data and invalid currencies stay blocking", () => {
  const input = { ...publicationInput, expectedScope: scopeFixture(["2026-10-02"], [2]) };
  assert.equal(buildQualityReport({ ...input, results: { scenarios: [] } }).publication_status, "blocked");
  const bad = scenario();
  bad.top_3_plus_mm_by_location.Warsaw.mm_cars_rental.currency = "EUR";
  assert.equal(buildQualityReport({ ...input, results: { scenarios: [bad] } }).publication_status, "blocked");
  delete bad.top_3_plus_mm_by_location.Warsaw.mm_cars_rental.currency;
  assert.equal(buildQualityReport({ ...input, results: { scenarios: [bad] } }).status, "failure");
});

test("legacy callers retain observed coverage but production requires a manifest", () => {
  const input = { ...publicationInput, expectedLocations: "Warsaw", results: { scenarios: [scenario()] } };
  assert.equal(buildQualityReport(input).status, "success");
  const required = buildQualityReport({ ...input, requireScope: true });
  assert.equal(required.status, "failure");
  assert.equal(required.publication_status, "blocked");
  assert.match(required.blocking_alerts.join(" "), /zakres/i);
});

test("invalid or contradictory manifest cannot fall back to observed success", () => {
  const expectedScope = scopeFixture(["2026-10-02"], [2]);
  for (const mutation of [{ schema_version: 9 }, { expected_scenario_count: 780 }, { start_dates: [] }, { scenario_keys: [] }, { locations: ["Warsaw", "Warsaw"] }]) {
    const quality = buildQualityReport({ ...publicationInput, expectedScope: { ...expectedScope, ...mutation }, results: { scenarios: [scenario()] } });
    assert.equal(quality.status, "failure", JSON.stringify(mutation));
    assert.match(quality.scope_validation_error, /scope/i);
    assert.equal(quality.top3_coverage_percent, 0);
  }
  assert.equal(buildQualityReport({ ...publicationInput, expectedScope, expectedLocations: "Poznan", results: { scenarios: [scenario()] } }).status, "failure");
});

test("scope is anchored to Warsaw tomorrow across midnight and daylight saving", () => {
  const { buildScrapeScope } = require("../src/scrapeScope");
  const scope = buildScrapeScope({ now: new Date("2026-10-24T22:30:00Z"), rollingDays: 3, durations: "2,3", locations: "Warsaw,Gdansk" });
  assert.equal(scope.schema_version, 1);
  assert.equal(scope.anchor_date, "2026-10-25");
  assert.equal(scope.time_zone, "Europe/Warsaw");
  assert.deepEqual(scope.start_dates, ["2026-10-26", "2026-10-27", "2026-10-28"]);
  assert.equal(scope.expected_scenario_count, 6);
  assert.equal(scope.expected_location_check_count, 12);
  assert.equal(scope.location_check_keys.at(-1), "2026-10-28|3|Gdansk");
});

test("explicit dates take precedence, sort and deduplicate without accepting invalid inputs", () => {
  const { buildScrapeScope } = require("../src/scrapeScope");
  const input = { now: new Date("2026-10-01T10:00:00Z"), startDates: "2026-10-05,2026-10-02,2026-10-05", rollingDays: 60, durations: [3, 2, 3], locations: ["Warsaw", "Warsaw"] };
  const scope = buildScrapeScope(input);
  assert.deepEqual(scope.start_dates, ["2026-10-02", "2026-10-05"]);
  assert.deepEqual(scope.durations, [2, 3]);
  assert.equal(scope.mode, "start-dates");
  assert.equal(scope.rolling_days, null);
  for (const mutation of [{ startDates: "2026-02-30" }, { durations: "2bad" }, { durations: [0] }, { locations: [] }, { startDates: [], rollingDays: 0 }]) {
    assert.throws(() => buildScrapeScope({ ...input, ...mutation }));
  }
});

const domInput = {
  ...publicationInput,
  expectedScope: scopeFixture(["2026-10-02"], [2]),
  results: { scenarios: [scenario()] },
  recommendations: { recommendations: [{ action: "increase" }], dom_verification: {
    active_input_count: 8012, confirmed_count: 4424, blocked_count: 3588,
    budget_exhausted: true, budget_exhausted_count: 3588
  } }
};

test("4424 of 8012 verified changes expose partial status and budgeted counts", () => {
  const quality = buildQualityReport(domInput);
  assert.equal(quality.status, "degraded");
  assert.equal(quality.publication_status, "partial");
  assert.equal(quality.dom_verification.checked_count, 4424);
  assert.equal(quality.dom_verification.blocked_count, 3588);
  assert.equal(quality.dom_verification.budget_exhausted_count, 3588);
  assert.match(quality.completion_messages.join(" "), /Sprawdzono 4424\/8012; pominięto 3588 zmian przez limit czasu/);
  assert.doesNotMatch(quality.alerts.join(" "), /\bAPI\b|\bDOM\b/);
});

test("partial Telegram keeps Excel links and concise nontechnical completion", () => {
  const qualityAlerts = buildQualityReport(domInput);
  const message = buildTelegramSummary({ env, ...publicationInput, qualityAlerts, excelAvailable: true, reportAvailable: true });
  assert.match(message, /^DiscoverCars \| CZĘŚCIOWO GOTOWE/);
  assert.match(message, /Sprawdzono 4424\/8012; pominięto 3588 zmian przez limit czasu/);
  assert.match(message, /Excel importowy: https:\/\/example.test\/import.xlsx/);
  assert.doesNotMatch(message, /\bAPI\b|\bDOM\b|8012.*4424.*8012/);
  assert(message.length < 4096);
});

test("partial HTML exposes the same completion without technical tags", () => {
  const html = buildHtmlReport(domInput.results, { quality: buildQualityReport(domInput) });
  assert.match(html, /Częściowo gotowe/);
  assert.match(html, /Sprawdzono 4424\/8012; pominięto 3588 zmian przez limit czasu/);
  assert.doesNotMatch(html, /Kontrola DOM|API-DOM/);
});

test("a partial scrape completion is bounded and does not hide safe Excel", () => {
  const qualityAlerts = buildQualityReport({ ...publicationInput, expectedScope: fullScope, results: { scenarios: [fullResults.scenarios[0]] } });
  const message = buildTelegramSummary({ env, ...publicationInput, qualityAlerts, excelAvailable: true });
  assert.match(message, /Zakres sprawdzony: 1\/780/);
  assert.match(message, /Excel importowy:/);
  assert(message.length < 4096);
});

test("a workflow failure cannot be overwritten by a stale successful quality file", () => {
  const message = buildTelegramSummary({ env: { ...env, QUALITY_STATUS: "failure" }, qualityAlerts: { status: "success", publication_status: "complete" }, ...publicationInput, excelAvailable: true });
  assert.match(message, /^DiscoverCars \| BŁĄD\n/);
  assert.doesNotMatch(message, /Excel importowy:/);
});

test("partial data never bypass failed Excel validation or required sanity verification", () => {
  const input = { ...publicationInput, expectedScope: fullScope, results: { scenarios: [fullResults.scenarios[0]] } };
  assert.equal(buildQualityReport({ ...input, excelSummary: { change_count: 1, validation: [{ status: "FAIL", check: "Import", issue_count: 1 }] } }).publication_status, "blocked");
  assert.equal(buildQualityReport({ ...input, requireSanity: true }).publication_status, "blocked");
});

test("invalid currency in a displayed offer view cannot escape the scope quality gate", () => {
  const item = scenario();
  item.offer_views_by_location = { Warsaw: { all: { top_3: [{ currency: "EUR" }] } } };
  const quality = buildQualityReport({ ...publicationInput, expectedScope: scopeFixture(["2026-10-02"], [2]), results: { scenarios: [item] } });
  assert.equal(quality.publication_status, "blocked");
  assert.equal(quality.invalid_currency_count, 1);
});

test("raw verification counts in a quality file still produce numeric completion", () => {
  const message = buildTelegramSummary({ env, ...publicationInput, qualityAlerts: { status: "degraded", publication_status: "partial", dom_verification: domInput.recommendations.dom_verification }, excelAvailable: true });
  assert.match(message, /Sprawdzono 4424\/8012/);
  assert.doesNotMatch(message, /undefined|NaN/);
});

test("small gaps never round an incomplete scope up to 100 percent", () => {
  const locations = Array.from({ length: 30 }, (_, index) => `Location ${index}`);
  const expectedScope = scopeFixture(gridDates, gridDurations, locations);
  const scenarios = gridDates.flatMap((date) => gridDurations.map((duration) => scenario(date, duration, locations)));
  delete scenarios[0].top_3_plus_mm_by_location["Location 0"];
  scenarios[0].results = scenarios[0].results.slice(1);
  const quality = buildScrapeQualityReport({ expectedScope, results: { scenarios } });
  assert.equal(quality.missing_location_check_count, 1);
  assert.equal(quality.top3_coverage_percent, 99.99);
  assert.equal(quality.status, "degraded");
});

test("missing MM date alerts remain bounded for a full yearly scope", () => {
  const dates = Array.from({ length: 365 }, (_, index) => new Date(Date.UTC(2026, 9, 2 + index)).toISOString().slice(0, 10));
  const results = { scenarios: dates.map((date) => {
    const item = scenario(date);
    item.top_3_plus_mm_by_location.Warsaw.mm_cars_rental = null;
    return item;
  }) };
  const qualityAlerts = buildQualityReport({ ...publicationInput, expectedScope: scopeFixture(dates, [2]), results });
  const message = buildTelegramSummary({ env, ...publicationInput, results, qualityAlerts, excelAvailable: true });
  assert.match(message, /Pozostałe daty bez MM: 355/);
  assert(message.length < 4096);
});

test("scope and quality CLIs enforce the same file contract, missing scope fails closed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-scope-quality-"));
  try {
    const scopePath = path.join(tempDir, "scope.json");
    const resultsPath = path.join(tempDir, "results.json");
    const scopeRun = spawnSync(process.execPath, [path.resolve(__dirname, "../src/scrapeScope.js"), "--locations=Warsaw", "--rolling-days=60", "--start-dates=2026-10-02,2026-10-03", "--durations=2,3", `--output=${scopePath}`], { encoding: "utf8" });
    assert.equal(scopeRun.status, 0, scopeRun.stderr);
    assert.equal(JSON.parse(fs.readFileSync(scopePath)).expected_scenario_count, 4);
    fs.writeFileSync(resultsPath, JSON.stringify({ scenarios: [scenario()] }));
    const run = (args) => spawnSync(process.execPath, [path.resolve(__dirname, "../src/workflowQualityAlerts.js"), "--scrape-only", `--results=${resultsPath}`, ...args], { encoding: "utf8" });
    const partial = run([`--scope=${scopePath}`]);
    assert.equal(partial.status, 0, partial.stderr);
    assert.equal(JSON.parse(partial.stdout).top3_coverage_percent, 25);
    assert.equal(JSON.parse(partial.stdout).publication_status, "partial");
    assert.equal(JSON.parse(run([`--scope=${scopePath}.missing`]).stdout).status, "failure");
    assert.equal(JSON.parse(run(["--require-scope"]).stdout).status, "failure");
    fs.writeFileSync(scopePath, "{bad");
    assert.equal(JSON.parse(run([`--scope=${scopePath}`]).stdout).status, "failure");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

if (failures) process.exitCode = 1;
