const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { loadConfig } = require("../src/discovercars/config");
const { parseMoney, toCsv } = require("../src/discovercars/utils");
const {
  buildGeoSearchPayload,
  createSharedBrowserProvider,
  DiscoverCarsScraper,
  extractOffersFromSearchApiPayload,
  resolveGeoLocationOverride,
  searchApiPayloadMatchesPeriod
} = require("../src/discovercars/scraper");
const { mergePricingRecommendations } = require("../src/mergePricingRecommendations");
const { buildLocationBreakdown } = require("../src/discoverCars");
const { buildPricingRecommendations } = require("../src/pricingRecommendations");
const { buildHtmlReport, buildReportData, generateReportFromFile } = require("../src/reportHtml");
const { buildPublicResultsPayload } = require("../src/publicResults");
const { buildTelegramSummary, formatDuration, summarizeNumberList } = require("../src/telegramSummary");
const {
  buildSanityComparison,
  enrichRecommendationsWithBaseline,
  selectSanitySample
} = require("../src/mmRateSanityCheck");
const { buildCalibrationUpdate } = require("../src/updateBrokerMarkupCalibration");
const { buildQualityAlerts, buildQualityReport, buildScrapeQualityReport } = require("../src/workflowQualityAlerts");
const { verifyActiveRecommendations } = require("../src/verifyActiveRecommendationsDom");
const { mergePayloads } = require("../src/mergeDiscovercarsResults");
const { compareBenchmark } = require("../tools/compare_discovercars_benchmark");
const { parseArgs: parseChunkedArgs, runCommand } = require("../src/runDiscovercarsChunked");
const { createCheckpointController } = require("../src/index");
const {
  isChunkPayloadComplete,
  isRunPayloadComplete,
  isScenarioCheckpointComplete,
  resolveGlobalConcurrency
} = require("../src/executionPolicy");
const { buildGeoLocationOverrides, buildLocationZones, getDailyLocations } = require("../src/locationRegistry");
const {
  filterOffersByTransmission,
  findTransmissionInCandidate,
  normalizeTransmission
} = require("../src/extractors");

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

runTest("parseMoney handles common currency formats", () => {
  assert.deepEqual(parseMoney("EUR 123.45"), {
    value: 123.45,
    currency: "EUR",
    raw: "EUR 123.45"
  });

  assert.deepEqual(parseMoney("1 234,56 zł"), {
    value: 1234.56,
    currency: "ZŁ",
    raw: "1 234,56 zł"
  });
});

runTest("parseMoney ignores rental duration before a currency-tagged total", () => {
  assert.deepEqual(parseMoney("Total for 3 days PLN 295.40"), {
    value: 295.4,
    currency: "PLN",
    raw: "Total for 3 days PLN 295.40"
  });
});

runTest("transmission helpers recognize automatic, manual, and ACRISS codes", () => {
  assert.equal(normalizeTransmission("Automatic Transmission"), "automatic");
  assert.equal(normalizeTransmission("Manual Transmission"), "manual");
  assert.equal(normalizeTransmission("CGAV"), "automatic");
  assert.equal(normalizeTransmission("CDMV"), "manual");
  assert.equal(findTransmissionInCandidate({ sipp: "CDAR" }), "automatic");
  assert.equal(findTransmissionInCandidate({ sipp: "CXMR" }), "manual");
  assert.equal(
    findTransmissionInCandidate({ vehicle: { specs: { gearboxType: "Automatic" } } }),
    "automatic"
  );
});

runTest("automatic transmission filter removes manual and unknown offers", () => {
  const filtered = filterOffersByTransmission(
    [
      { provider_name: "Manual Supplier", total_price: 100, transmission: "manual" },
      { provider_name: "Unknown Supplier", total_price: 110 },
      { provider_name: "Automatic Supplier", total_price: 120, transmission: "automatic" }
    ],
    "automatic"
  );

  assert.deepEqual(
    filtered.map((offer) => offer.provider_name),
    ["Automatic Supplier"]
  );
});

runTest("DiscoverCars search API parser uses data.offers and ignores filter pseudo-prices", () => {
  const offers = extractOffersFromSearchApiPayload(
    {
      data: {
        offers: [
          {
            price: { raw: 120, formatted: "PLN 120.00" },
            supplier: { name: "Manual Supplier", rating: { score: "8.1" } },
            vehicle: {
              carName: "Toyota Yaris",
              sipp: "EDMR",
              specifications: { isAutomaticTransmission: 0 }
            }
          },
          {
            price: { raw: 150, formatted: "PLN 150.00" },
            supplier: { name: "Automatic Supplier", rating: { score: "8.8" } },
            vehicle: {
              carName: "Toyota Corolla",
              sipp: "CDAR",
              specifications: { isAutomaticTransmission: 1 }
            }
          },
          {
            price: { raw: 99, formatted: "PLN 99.00" },
            supplier: { name: "DiscoverCars choice", rating: { score: "9.0" } },
            vehicle: {
              carName: "Promo",
              sipp: "EDAR",
              specifications: { isAutomaticTransmission: 1 }
            }
          }
        ],
        filter: {
          supplier: [
            { title: "Fake Filter Supplier", min: "PLN 1.00" }
          ],
          carSpecifications: [
            { key: "transmission-a", min: "PLN 99.00", title: "Automatic Transmission" }
          ]
        }
      }
    },
    "Krakow Airport (KRK)",
    "https://www.discovercars.com/api/v2/search/test"
  );

  assert.deepEqual(
    offers.map((offer) => [offer.provider, offer.totalPrice, offer.transmission]),
    [
      ["Manual Supplier", 120, "manual"],
      ["Automatic Supplier", 150, "automatic"]
    ]
  );
  assert.equal(filterOffersByTransmission(offers, "automatic")[0].provider, "Automatic Supplier");
});

runTest("DiscoverCars API outcome preserves automatic and all offer views", () => {
  const scraper = new DiscoverCarsScraper({
    pickupDate: "2026-07-20",
    pickupTime: "11:00",
    dropoffDate: "2026-07-22",
    dropoffTime: "11:00",
    transmissionFilter: "automatic",
    maxProvidersPerLocation: 10
  });
  const period = {
    pickupDatetime: "2026-07-20T11:00:00+02:00",
    dropoffDatetime: "2026-07-22T11:00:00+02:00"
  };
  const outcome = scraper.buildApiOutcome({
    data: {
      offers: [
        {
          price: { raw: 100, formatted: "PLN 100.00" },
          supplier: { name: "Manual Supplier" },
          vehicle: { sipp: "EDMR", specifications: { isAutomaticTransmission: 0 } },
          pickupClosingInfo: period
        },
        {
          price: { raw: 120, formatted: "PLN 120.00" },
          supplier: { name: "Automatic Supplier" },
          vehicle: { sipp: "EDAR", specifications: { isAutomaticTransmission: 1 } },
          pickupClosingInfo: period
        }
      ]
    }
  }, "Warsaw", "api");

  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.offerViews.automatic.length, 1);
  assert.equal(outcome.offerViews.all.length, 2);
});

runTest("location breakdown counts offers cheaper than MM before limiting providers to top3", () => {
  const breakdown = buildLocationBreakdown("Warsaw", [
    { provider_name: "Supplier A", total_price: 80, currency: "PLN", car_name: "A1" },
    { provider_name: "Supplier A", total_price: 90, currency: "PLN", car_name: "A2" },
    { provider_name: "Supplier B", total_price: 95, currency: "PLN", car_name: "B1" },
    { provider_name: "MM Cars Rental", total_price: 100, currency: "PLN", car_name: "MM1" },
    { provider_name: "Supplier C", total_price: 110, currency: "PLN", car_name: "C1" }
  ]);

  assert.equal(breakdown.mm_provider_rank, 3);
  assert.equal(breakdown.cheaper_offer_count, 3);
  assert.equal(breakdown.top_3_offers.length, 3);
});

runTest("Galeria Krakowska uses the direct geo-search payload", () => {
  const geoLocation = resolveGeoLocationOverride("Galeria Krakowska Shopping Mall");
  assert.equal(geoLocation.latitude, 50.0662682);
  assert.equal(geoLocation.longitude, 19.9461205);

  const payload = buildGeoSearchPayload({
    pickupDate: "2026-07-20",
    pickupTime: "11:00",
    dropoffDate: "2026-07-22",
    dropoffTime: "11:00",
    residenceCountry: "Poland",
    driverAge: 30
  }, geoLocation);
  assert.equal(payload.pickup_from, "2026-07-20 11:00");
  assert.equal(payload.pickup_to, "2026-07-22 11:00");
  assert.equal(payload.radius_meters, 20000);
  assert.equal(payload.residence_country, "PL");
});

runTest("DiscoverCars API period guard rejects stale search results", () => {
  const config = {
    pickupDate: "2026-07-20",
    pickupTime: "11:00",
    dropoffDate: "2026-07-22",
    dropoffTime: "11:00"
  };
  const payload = {
    data: {
      offers: [{
        pickupClosingInfo: {
          pickupDatetime: "2026-07-20T11:00:00+02:00",
          dropoffDatetime: "2026-07-22T11:00:00+02:00"
        }
      }]
    }
  };
  assert.equal(searchApiPayloadMatchesPeriod(payload, config), true);
  payload.data.offers[0].pickupClosingInfo.pickupDatetime = "2026-07-12T11:00:00+02:00";
  assert.equal(searchApiPayloadMatchesPeriod(payload, config), false);
});

runTest("mergePayloads combines chunked scenarios in date and duration order", () => {
  const merged = mergePayloads([
    {
      generated_at: "2026-06-29T10:00:00.000Z",
      locations: ["Krakow Airport (KRK)"],
      scenarios: [
        {
          scenario_id: "date-20260708-3d",
          start_date: "2026-07-08",
          rental_days: 3,
          results: [],
          errors: [],
          top_3_plus_mm_by_location: {}
        }
      ]
    },
    {
      generated_at: "2026-06-29T11:00:00.000Z",
      locations: ["Krakow Airport (KRK)"],
      scenarios: [
        {
          scenario_id: "date-20260701-2d",
          start_date: "2026-07-01",
          rental_days: 2,
          results: [],
          errors: [],
          top_3_plus_mm_by_location: {}
        }
      ]
    }
  ], ["chunk-2.json", "chunk-1.json"]);

  assert.deepEqual(
    merged.scenarios.map((scenario) => scenario.scenario_id),
    ["date-20260701-2d", "date-20260708-3d"]
  );
  assert.deepEqual(merged.start_dates, ["2026-07-01", "2026-07-08"]);
  assert.equal(merged.merge_meta.source_files.length, 2);
});

runTest("mergePayloads refreshes only locations present in a partial update", () => {
  const base = {
    generated_at: "2026-07-09T01:00:00.000Z",
    locations: ["Airport", "City"],
    scenarios: [{
      scenario_id: "date-20260710-2d",
      start_date: "2026-07-10",
      rental_days: 2,
      generated_at: "2026-07-09T01:00:00.000Z",
      results: [{ location: "Airport", total_price: 100 }, { location: "City", total_price: 110 }],
      errors: [],
      top_3_plus_mm_by_location: {
        Airport: { top_3: [{ total_price: 100 }] },
        City: { top_3: [{ total_price: 110 }] }
      }
    }]
  };
  const update = {
    generated_at: "2026-07-09T05:00:00.000Z",
    locations: ["Airport"],
    scenarios: [{
      scenario_id: "date-20260710-2d",
      start_date: "2026-07-10",
      rental_days: 2,
      results: [{ location: "Airport", total_price: 90 }],
      errors: [],
      top_3_plus_mm_by_location: { Airport: { top_3: [{ total_price: 90 }] } }
    }]
  };

  const merged = mergePayloads([base, update], ["base/results.json", "update/results.json"]);
  const scenario = merged.scenarios[0];
  assert.equal(scenario.top_3_plus_mm_by_location.Airport.top_3[0].total_price, 90);
  assert.equal(scenario.top_3_plus_mm_by_location.City.top_3[0].total_price, 110);
  assert.equal(scenario.source_generated_at_by_location.Airport, "2026-07-09T05:00:00.000Z");
  assert.equal(scenario.source_generated_at_by_location.City, "2026-07-09T01:00:00.000Z");
  assert.equal(merged.merge_meta.partial_scenario_merge_count, 1);
});

runTest("API DOM sanity prefers browser when comparable prices differ materially", () => {
  const scraper = new DiscoverCarsScraper({ pickupDate: "2026-07-10", dropoffDate: "2026-07-12" });
  const api = [
    { provider: "MM Cars Rental", totalPrice: 100, currency: "PLN" },
    { provider: "Other", totalPrice: 110, currency: "PLN" },
    { provider: "Third", totalPrice: 120, currency: "PLN" }
  ];
  const browser = api.map((item) => ({ ...item }));
  assert.equal(scraper.shouldPreferBrowserOutcome(api, browser), false);
  browser[0].totalPrice = 120;
  assert.equal(scraper.shouldPreferBrowserOutcome(api, browser), true);
});

runTest("API DOM comparison does not drift only because DOM has fewer offers", () => {
  const scraper = new DiscoverCarsScraper({ pickupDate: "2026-07-10", dropoffDate: "2026-07-12" });
  const api = [
    { provider: "MM Cars Rental", totalPrice: 100, currency: "PLN" },
    { provider: "Other", totalPrice: 110, currency: "PLN" },
    { provider: "Third", totalPrice: 120, currency: "PLN" }
  ];
  const comparison = scraper.compareApiAndBrowserOutcomes(api, api.slice(0, 2));
  assert.equal(comparison.preferBrowser, false);
  assert.deepEqual(comparison.reasons, []);
});

runTest("API DOM sanity increases DOM validation after repeated drift", () => {
  const scraper = new DiscoverCarsScraper({
    pickupDate: "2026-07-10",
    dropoffDate: "2026-07-12",
    apiDomSanityRate: 0.05,
    apiDomDriftMinComparisons: 20,
    apiDomDriftState: { by_location: {} }
  });
  for (let index = 0; index < 20; index += 1) {
    scraper.recordApiDomComparison("Warsaw", { reasons: index < 6 ? ["mm_price_mismatch"] : [] });
  }
  assert.equal(scraper.getLocationValidationRate("Warsaw"), 0.2);
  assert.equal(scraper.getLocationValidationRate("Krakow"), 0.05);
  assert.equal(scraper.apiDomTelemetry.adaptive_validation_triggered, true);
  assert.equal(scraper.buildApiDomTelemetrySummary().drift_rate_percent, 30);
});

runTest("sparse API results use the adaptive sample rate without throwing", () => {
  const scraper = new DiscoverCarsScraper({
    pickupDate: "2026-08-27",
    dropoffDate: "2026-08-29",
    apiDomSanityRate: 0,
    apiDomDriftState: { by_location: {} }
  });
  let shouldValidate = null;
  assert.doesNotThrow(() => {
    shouldValidate = scraper.shouldValidateApiOutcome("Warsaw Airport (WAW)", [
      { provider: "Provider A", totalPrice: 100 },
      { provider: "Provider B", totalPrice: 110 }
    ]);
  });
  assert.equal(typeof shouldValidate, "boolean");
});

runTest("pricing candidates wait for final recommendation DOM validation", () => {
  const scraper = new DiscoverCarsScraper({
    pickupDate: "2026-07-10",
    dropoffDate: "2026-07-12",
    apiDomSanityRate: 0,
    apiDomDriftState: { by_location: {} }
  });
  const activeTop1Gap = [
    { provider: "MM Cars Rental", totalPrice: 200, currency: "PLN" },
    { provider: "Other", totalPrice: 240, currency: "PLN" },
    { provider: "Third", totalPrice: 260, currency: "PLN" }
  ];
  const inactiveTop1Gap = activeTop1Gap.map((item) => ({ ...item }));
  inactiveTop1Gap[1].totalPrice = 218;
  assert.equal(scraper.shouldValidateApiOutcome("Warsaw", activeTop1Gap), false);
  assert.equal(scraper.shouldValidateApiOutcome("Krakow", inactiveTop1Gap), false);
});

runTest("sparse API results respect the per-location DOM validation cap", () => {
  const scraper = new DiscoverCarsScraper({
    pickupDate: "2026-07-10",
    dropoffDate: "2026-07-12",
    apiDomSanityRate: 0.05,
    apiDomMaxValidationsPerLocation: 50,
    apiDomDriftState: { by_location: {} }
  });
  scraper.getLocationDriftState("Gdansk Downtown").validation_count = 50;
  const sparseOffers = [{ provider: "Autounion", totalPrice: 120, currency: "PLN" }];
  assert.equal(scraper.shouldValidateApiOutcome("Gdansk Downtown", sparseOffers), false);
});

runTest("chunked runner expands rolling days into ISO start dates", () => {
  const options = parseChunkedArgs([
    "--rolling-days=3",
    "--durations=2",
    "--locations=Warsaw",
    "--chunk-stall-timeout=120000",
    "--skip-postprocess"
  ]);

  assert.equal(options.startDates.length, 3);
  assert.deepEqual(options.durations, [2]);
  assert.deepEqual(options.locations, ["Warsaw"]);
  assert.equal(options.locationConcurrency, 3);
  assert.equal(options.chunkStallTimeoutMs, 120000);
  for (const startDate of options.startDates) {
    assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

runTest("loadConfig merges repeated locations and validates required fields", () => {
  const config = loadConfig([
    "--location",
    "Warsaw",
    "--location",
    "Krakow",
    "--pickup-date",
    "2026-05-15",
    "--pickup-time",
    "10:00",
    "--dropoff-date",
    "2026-05-18",
    "--dropoff-time",
    "10:00"
  ]);

  assert.deepEqual(config.locations, ["Warsaw", "Krakow"]);
  assert.equal(config.pickupDate, "2026-05-15");
  assert.equal(config.dropoffTime, "10:00");
  assert.equal(config.apiTimeoutMs, 20000);
});

runTest("location registry is the source for daily locations, zones, and geo overrides", () => {
  const dailyLocations = getDailyLocations();
  const zones = buildLocationZones();
  const geoOverrides = buildGeoLocationOverrides();
  assert.equal(dailyLocations.length, 21);
  assert(dailyLocations.includes("Galeria Krakowska Shopping Mall"));
  assert(dailyLocations.includes("Bydgoszcz Airport (BZG)"));
  assert(dailyLocations.includes("Lodz Downtown"));
  assert(dailyLocations.includes("Lodz Lublinek Airport (LCJ)"));
  assert(dailyLocations.includes("Lubin Downtown"));
  assert(dailyLocations.includes("Olsztyn Downtown"));
  assert(dailyLocations.includes("Opole Downtown"));
  assert(dailyLocations.includes("Torun Downtown"));
  assert(dailyLocations.includes("Warsaw West Train Station"));
  assert.deepEqual(zones["Krakow Airport (KRK)"], ["KRLO", "KRTI"]);
  assert.deepEqual(zones["Warsaw"], ["WA1", "WA2", "WALO"]);
  assert.equal(geoOverrides["Galeria Krakowska Shopping Mall"].radiusMeters, 20000);

  const config = loadConfig(["--config", "discovercars.config.example.json"]);
  assert.equal(config.geoLocationOverrides["Galeria Krakowska Shopping Mall"].latitude, 50.0662682);
});

runTest("toCsv writes stable header and row data", () => {
  const csv = toCsv([
    {
      location: "Warsaw",
      provider: "Alamo",
      providerRating: 8.7,
      totalPrice: 199.99,
      currency: "EUR",
      source: "network"
    }
  ]);

  assert.match(csv, /^location,duration_days,pickup_date,dropoff_date,provider,provider_rating,total_price,currency,source/);
  assert.match(csv, /Warsaw,,,,Alamo,8\.7,199\.99,EUR,network/);
});

runTest("buildHtmlReport renders compact tables and MM Cars Rental highlight", () => {
  const payload = {
    generated_at: "2026-05-04T15:00:00.000Z",
    time_zone: "Europe/Warsaw",
    locations: ["Warsaw"],
    scenarios: [
      {
        scenario_id: "2026-05-05-2",
        start_day_label: "2026-05-05 (Tuesday)",
        pickup_date: "2026-05-05T10:00:00+02:00",
        dropoff_date: "2026-05-07T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Warsaw: {
            top_3: [
              { provider_name: "Alamo", provider_rating: 8.7, total_price: 100, currency: "PLN", rental_days: 2 },
              { provider_name: "MM Cars Rental", provider_rating: 8.8, total_price: 115, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: {
              provider_name: "MM Cars Rental",
              provider_rating: 8.8,
              total_price: 115,
              currency: "PLN",
              rental_days: 2
            }
          }
        }
      }
    ]
  };
  const html = buildHtmlReport(payload);
  const automatic = buildReportData(payload).scenarios[0].rows[0][2];

  assert.match(html, /<table aria-label="Porównanie cen:/);
  assert.match(html, /Top 1 firma/);
  assert.match(html, /Top 1 PLN\/d/);
  assert.equal(automatic[0], "Alamo (8.7)");
  assert.equal(automatic[2], "50,00 PLN/d");
  assert.equal(automatic[5], "MM Cars Rental (8.8)");
  assert.equal(automatic[6], "mm mm-close");
  assert.match(html, /filter-location/);
  assert.match(html, /bez MM Cars Rental/);
  assert.match(html, /Kontrola cen DiscoverCars/);
  assert.match(html, /Wygenerowano:/);
  assert.match(html, /Legenda oznaczeń/);
  assert.match(html, /<main id="report-results"><\/main>/);
  assert.match(html, /<script type="application\/json" id="report-data">/);
  assert.match(html, /insertAdjacentHTML\("beforeend"/);
  assert.doesNotMatch(html, /visibleScenarioLimit \+= scenarioPageSize;\s*applyFilters\(false\)/);
  assert.doesNotMatch(html, /source \/ car/i);
  assert.doesNotMatch(html, /evidence-cell/);
  assert.doesNotMatch(html, /Not available|Scenario \d|rental_days|\/day/);
  assert.match(html, /table-layout: fixed/);
});

runTest("buildHtmlReport marks MM Cars Rental when top2 is at least 10 PLN per day above MM top1", () => {
  const payload = {
    generated_at: "2026-05-04T15:00:00.000Z",
    time_zone: "Europe/Warsaw",
    locations: ["Warsaw"],
    scenarios: [
      {
        scenario_id: "2026-05-05-2",
        start_day_label: "2026-05-05 (Tuesday)",
        pickup_date: "2026-05-05T10:00:00+02:00",
        dropoff_date: "2026-05-07T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Warsaw: {
            top_3: [
              { provider_name: "MM Cars Rental", provider_rating: 8.8, total_price: 100, currency: "PLN", rental_days: 2 },
              { provider_name: "Alamo", provider_rating: 8.7, total_price: 120, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: {
              provider_name: "MM Cars Rental",
              provider_rating: 8.8,
              total_price: 100,
              currency: "PLN",
              rental_days: 2
            }
          }
        }
      }
    ]
  };
  const automatic = buildReportData(payload).scenarios[0].rows[0][2];

  assert.equal(automatic[0], "MM Cars Rental (8.8)");
  assert.equal(automatic[1], "mm mm-top1-gap");
  assert.equal(automatic[2], "50,00 PLN/d");
  assert.equal(automatic[12], "mm mm-top1-gap");
  assert.match(buildHtmlReport(payload), /MM Cars Rental jest Top1; kolejna firma jest droższa o 10-19,99 PLN\/d/);
});

runTest("public results keep report views while removing duplicated technical payload", () => {
  const automaticMm = {
    provider_name: "MM Cars Rental",
    provider_rating: 8.8,
    total_price: 220,
    currency: "PLN",
    rental_days: 2,
    car_name: "Kia Rio",
    source: "api",
    source_url: "https://example.test/private-search"
  };
  const compact = buildPublicResultsPayload({
    generated_at: "2026-08-19T05:00:00.000Z",
    locations: ["Warsaw Chopin Airport (WAW)"],
    scenarios: [{
      scenario_id: "2026-08-20__2",
      start_date: "2026-08-20",
      rental_days: 2,
      results: [automaticMm],
      top_3_by_location: { "Warsaw Chopin Airport (WAW)": [automaticMm] },
      top_3_plus_mm_by_location: {
        "Warsaw Chopin Airport (WAW)": { top_3: [automaticMm], mm_cars_rental: automaticMm }
      },
      offer_views_by_location: {
        "Warsaw Chopin Airport (WAW)": {
          automatic: { top_3: [automaticMm], mm_cars_rental: automaticMm, mm_provider_rank: 1, cheaper_offer_count: 0 },
          all: { top_3: [{ ...automaticMm, total_price: 200 }], mm_cars_rental: automaticMm, mm_provider_rank: 2, cheaper_offer_count: 3 }
        }
      }
    }]
  });

  const scenario = compact.scenarios[0];
  const views = scenario.offer_views_by_location["Warsaw Chopin Airport (WAW)"];
  assert.equal(compact.schema_version, 2);
  assert.equal(views.automatic.mm_provider_rank, 1);
  assert.equal(views.all.cheaper_offer_count, 3);
  assert.equal(views.all.top_3[0].total_price, 200);
  assert.equal(views.automatic.mm_cars_rental.provider_rating, 8.8);
  assert.equal("results" in scenario, false);
  assert.equal("top_3_by_location" in scenario, false);
  assert.equal("top_3_plus_mm_by_location" in scenario, false);
  assert.doesNotMatch(JSON.stringify(compact), /source_url|private-search|car_name/);
});

runTest("GitHub Pages publishes compact results while Actions keeps the full artifact", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "discovercars-daily.yml"), "utf8");
  assert.match(workflow, /node src\/publicResults\.js output\/results-latest\.json output\/results-public\.json/);
  assert.match(workflow, /cp output\/results-public\.json "pages\/\$run_dir\/results-latest\.json"/);
  assert.match(workflow, /name: Upload scraper results[\s\S]*output\/results-latest\.json/);
});

runTest("daily workflow renders the final quality-aware HTML only once", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "discovercars-daily.yml"), "utf8");
  const reportCommands = workflow.match(/node src\/reportHtml\.js/g) || [];
  assert.equal(reportCommands.length, 1);
  assert.match(workflow, /node src\/reportHtml\.js output\/results-latest\.json output\/report\.html --quality=output\/quality-alerts\.json/);
});

runTest("Playwright installation avoids apt and cannot block the workflow for hours", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "discovercars-daily.yml"), "utf8");
  const installStep = workflow.match(/- name: Install Playwright Chromium[\s\S]*?(?=\n      - name:)/)?.[0] || "";

  assert.match(installStep, /timeout-minutes: 10/);
  assert.match(installStep, /for attempt in 1 2 3/);
  assert.match(installStep, /timeout --kill-after=15s 180s npx playwright install chromium/);
  assert.doesNotMatch(installStep, /--with-deps/);
});

runTest("daily workflow checkpoints scraping and verifies four DOM shards before publication", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "discovercars-daily.yml"), "utf8");
  const verificationStep = workflow.match(/- name: Verify active recommendations in DOM[\s\S]*?(?=\n      - name:)/)?.[0] || "";

  assert.match(workflow, /scrape:\s*[\s\S]*?name: Scrape and prepare recommendations/);
  assert.match(workflow, /publish:\s*[\s\S]*?needs: scrape/);
  assert.match(workflow, /name: Upload scraper checkpoint/);
  assert.match(workflow, /name: Download scraper checkpoint/);
  assert.match(workflow, /node src\/recommendationDomShards\.js split/);
  assert.match(workflow, /node src\/recommendationDomShards\.js merge/);
  assert.match(verificationStep, /for shard in 0 1 2 3/);
  assert.match(verificationStep, /timeout --kill-after=30s 9300s node src\/verifyActiveRecommendationsDom\.js/);
  assert.match(verificationStep, /--max-duration-ms=9000000/);
  assert.match(verificationStep, /--concurrency=1/);
});

runTest("DOM sharding keeps date-duration groups together and merge fails closed", () => {
  const {
    listShardOutputFiles,
    readShardPayloads,
    mergeVerifiedRecommendationShards,
    splitActiveRecommendations
  } = require("../src/recommendationDomShards");
  const base = {
    decisions: [
      { action: "increase", location: "Warsaw Airport", start_date: "2026-08-23", rental_days: 2, source_validation_status: "api_unverified" },
      { action: "decrease", location: "Gdansk Airport", start_date: "2026-08-23", rental_days: 2, source_validation_status: "api_unverified" },
      { action: "increase", location: "Krakow Airport", start_date: "2026-08-24", rental_days: 3, source_validation_status: "dom_confirmed" },
      { action: "hold", location: "Poznan Airport", start_date: "2026-08-25", rental_days: 4 }
    ]
  };

  const shards = splitActiveRecommendations(base, 4);
  assert.deepEqual(
    listShardOutputFiles(["shard-0-output.json", "shard-0-summary.json", "notes.json", "shard-3-output.json"]),
    ["shard-0-output.json", "shard-3-output.json"]
  );
  const shardDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-dom-shards-"));
  try {
    fs.writeFileSync(path.join(shardDir, "shard-0-output.json"), JSON.stringify({ decisions: [] }));
    fs.writeFileSync(path.join(shardDir, "shard-1-output.json"), "{invalid json");
    const loaded = readShardPayloads(shardDir);
    assert.equal(loaded.payloads.length, 1);
    assert.deepEqual(loaded.corruptFiles, ["shard-1-output.json"]);
  } finally {
    fs.rmSync(shardDir, { recursive: true, force: true });
  }
  assert.equal(shards.length, 4);
  const assigned = shards.filter((shard) => shard.decisions.length > 0);
  assert.equal(assigned.length, 1);
  assert.deepEqual(
    assigned[0].decisions.map((item) => item.location).sort(),
    ["Gdansk Airport", "Warsaw Airport"]
  );

  const verifiedShard = {
    ...assigned[0],
    decisions: [{
      ...assigned[0].decisions[0],
      source_validation_status: "dom_recommendation_verified",
      dom_verification_status: "confirmed"
    }],
    dom_verification: {
      processed_live_dom_group_count: 1,
      skipped_live_dom_group_count: 0,
      budget_exhausted_count: 0,
      elapsed_ms: 1200
    }
  };
  const merged = mergeVerifiedRecommendationShards(base, [verifiedShard]);
  const warsaw = merged.decisions.find((item) => item.location === "Warsaw Airport");
  const gdansk = merged.decisions.find((item) => item.location === "Gdansk Airport");
  assert.equal(warsaw.dom_verification_status, "confirmed");
  assert.equal(gdansk.action, "hold");
  assert.equal(gdansk.dom_verification_status, "dom_verification_shard_missing");
  assert.equal(merged.dom_verification.missing_output_count, 1);
  assert.equal(merged.recommendation_count, 2);
});

runTest("recommendation workload forecasts four shards and detects growth above 100 percent", () => {
  const {
    buildRecommendationWorkload,
    finalizeRecommendationWorkload
  } = require("../src/recommendationWorkload");
  const current = {
    decisions: [
      { action: "increase", location: "A", start_date: "2026-08-23", rental_days: 2, source_validation_status: "api_unverified" },
      { action: "increase", location: "B", start_date: "2026-08-23", rental_days: 2, source_validation_status: "api_unverified" },
      { action: "decrease", location: "C", start_date: "2026-08-24", rental_days: 3, source_validation_status: "api_unverified" },
      { action: "increase", location: "D", start_date: "2026-08-25", rental_days: 4, source_validation_status: "dom_confirmed" },
      { action: "increase", location: "E", start_date: "2026-08-26", rental_days: 5, source_validation_status: "api_unverified" }
    ]
  };
  const previous = { recommendations: [{ action: "increase" }, { action: "decrease" }] };
  const report = buildRecommendationWorkload({
    current,
    previous,
    previousDom: {
      processed_live_dom_group_count: 8,
      shard_count: 4,
      elapsed_ms: 120000
    },
    shardCount: 4
  });

  assert.equal(report.active_recommendation_count, 5);
  assert.equal(report.pending_dom_group_count, 3);
  assert.equal(report.estimated_dom_duration_seconds, 60);
  assert.equal(report.estimated_budget_usage_percent, 0.7);
  assert.equal(report.over_budget, false);

  const finalized = finalizeRecommendationWorkload(report, {
    current,
    previous,
    runType: "full"
  });
  assert.equal(finalized.final_active_recommendation_count, 5);
  assert.equal(finalized.recommendation_growth_percent, 150);
  assert.equal(finalized.recommendation_surge, true);
  assert.match(finalized.alert, /wzrosla o 150%/);

  const exactDouble = finalizeRecommendationWorkload(report, {
    current: { recommendations: Array.from({ length: 4 }, () => ({ action: "increase" })) },
    previous,
    runType: "full"
  });
  assert.equal(exactDouble.recommendation_surge, false);
  const manual = finalizeRecommendationWorkload(report, { current, previous, runType: "manual" });
  assert.equal(manual.recommendation_surge, false);
  const withoutBaseline = finalizeRecommendationWorkload(report, {
    current,
    previous: { recommendations: [] },
    runType: "full"
  });
  assert.equal(withoutBaseline.recommendation_surge, false);
});

runTest("compareBenchmark recommends parallel execution only when speed and quality are preserved", () => {
  const buildResults = () => ({
    locations: ["Airport"],
    scenarios: [
      {
        scenario_id: "2026-08-14__2",
        start_date: "2026-08-14",
        rental_days: 2,
        results: [{ location: "Airport", total_price: 100 }],
        errors: [],
        top_3_plus_mm_by_location: {
          Airport: {
            top_3: [{ supplier: "Competitor", total_price: 100, currency: "PLN" }],
            mm_cars_rental: { supplier: "MM Cars Rental", total_price: 110, currency: "PLN" }
          }
        }
      }
    ]
  });

  const report = compareBenchmark({
    baselineResults: buildResults(),
    parallelResults: buildResults(),
    baselineTiming: { duration_seconds: 100 },
    parallelTimings: [
      { started_epoch: 10, completed_epoch: 45, duration_seconds: 35 },
      { started_epoch: 12, completed_epoch: 50, duration_seconds: 38 }
    ],
    parallelShardResults: [buildResults(), buildResults()],
    expectedLocations: "Airport",
    expectedStartDates: "2026-08-14",
    expectedDurations: "2",
    expectedScenarioCount: 1,
    minimumSpeedupPercent: 20
  });

  assert.equal(report.parallel.duration_seconds, 40);
  assert.equal(report.comparison.speedup_percent, 60);
  assert.equal(report.comparison.scenario_parity, true);
  assert.equal(report.comparison.quality_preserved, true);
  assert.equal(report.comparison.production_change_recommended, true);
});

runTest("global concurrency budget caps nested chunk, scenario, and location workers", () => {
  assert.deepEqual(resolveGlobalConcurrency({
    maxActivePages: 8,
    chunkConcurrency: 2,
    scenarioConcurrency: 2,
    locationConcurrency: 3
  }), {
    maxActivePages: 8,
    chunkConcurrency: 2,
    scenarioConcurrency: 2,
    locationConcurrency: 2,
    activePageLimit: 8
  });
});

runTest("checkpoint resumes only complete scenarios without location errors", () => {
  const complete = {
    results: [{ location: "Warsaw" }, { location: "Krakow" }],
    errors: [],
    top_3_by_location: { Warsaw: [{ total_price: 100 }], Krakow: [{ total_price: 110 }] }
  };
  assert.equal(isScenarioCheckpointComplete(complete, ["Warsaw", "Krakow"]), true);
  assert.equal(isScenarioCheckpointComplete(complete, ["Warsaw", "Krakow", "Gdansk"]), false);
  assert.equal(isScenarioCheckpointComplete({ ...complete, errors: [{ location: "Krakow" }] }, ["Warsaw", "Krakow"]), false);
  assert.equal(isScenarioCheckpointComplete({ results: [], errors: [{ location: "Warsaw" }] }, ["Warsaw"]), false);
  assert.equal(isRunPayloadComplete({ locations: ["Warsaw", "Krakow"], scenarios: [complete] }), true);
  assert.equal(isRunPayloadComplete({ locations: ["Warsaw", "Krakow", "Gdansk"], scenarios: [complete] }), false);

  const chunkPayload = {
    locations: ["Warsaw", "Krakow"],
    scenarios: [
      { ...complete, start_date: "2026-08-16", rental_days: 2 },
      { ...complete, start_date: "2026-08-16", rental_days: 3 }
    ]
  };
  assert.equal(isChunkPayloadComplete(chunkPayload, {
    startDates: ["2026-08-16"],
    durations: [2, 3],
    locations: ["Krakow", "Warsaw"]
  }), true);
  assert.equal(isChunkPayloadComplete(chunkPayload, {
    startDates: ["2026-08-16", "2026-08-17"],
    durations: [2, 3],
    locations: ["Krakow", "Warsaw"]
  }), false);
  assert.equal(isChunkPayloadComplete(chunkPayload, {
    startDates: ["2026-08-16"],
    durations: [2, 3],
    locations: ["Krakow", "Warsaw", "Gdansk"]
  }), false);

  const flatChunkPayload = { ...complete, pickup_date: "2026-08-16T11:00:00+02:00", rental_days: 2 };
  assert.equal(isChunkPayloadComplete(flatChunkPayload, {
    startDates: ["2026-08-16"],
    durations: [2],
    locations: ["Krakow", "Warsaw"]
  }), true);
});

runTest("buildHtmlReport separates MM top1 gaps of at least 20 and 30 PLN per day", () => {
  const buildPayload = (runnerUpTotalPrice) => ({
    generated_at: "2026-05-04T15:00:00.000Z",
    time_zone: "Europe/Warsaw",
    locations: ["Warsaw"],
    scenarios: [{
      start_date: "2026-05-05",
      rental_days: 2,
      top_3_plus_mm_by_location: {
        Warsaw: {
          top_3: [
            { provider_name: "MM Cars Rental", total_price: 100, currency: "PLN", rental_days: 2 },
            { provider_name: "Alamo", total_price: runnerUpTotalPrice, currency: "PLN", rental_days: 2 }
          ],
          mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 100, currency: "PLN", rental_days: 2 }
        }
      }
    }]
  });

  const gap20Payload = buildPayload(140);
  const gap20Html = buildHtmlReport(gap20Payload);
  const gap20View = buildReportData(gap20Payload).scenarios[0].rows[0][2];
  assert.equal(gap20View[15], "top1-gap-20");
  assert.equal(gap20View[1], "mm mm-top1-gap-20");
  assert.match(gap20Html, /type="checkbox" value="top1-gap-20"/);

  const gap30Payload = buildPayload(160);
  const gap30Html = buildHtmlReport(gap30Payload);
  const gap30View = buildReportData(gap30Payload).scenarios[0].rows[0][2];
  assert.equal(gap30View[15], "top1-gap-30");
  assert.equal(gap30View[1], "mm mm-top1-gap-30");
  assert.match(gap30Html, /type="checkbox" value="top1-gap-30"/);
});

runTest("top1 above 150 PLN per day is highlighted without blocking recommendations", () => {
  const payload = {
    locations: ["Warsaw"],
    scenarios: [{
    scenario_id: "2026-07-10-2",
    start_date: "2026-07-10",
    rental_days: 2,
    top_3_plus_mm_by_location: {
      Warsaw: {
        top_3: [
          { provider_name: "Competitor", total_price: 400, currency: "PLN", rental_days: 2 },
          { provider_name: "MM Cars Rental", total_price: 410, currency: "PLN", rental_days: 2 }
        ],
        mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 410, currency: "PLN", rental_days: 2 }
      }
    }
  }]};
  const recommendations = buildPricingRecommendations(payload);
  const target = recommendations.decisions[0];
  assert.equal(target.action, "decrease");
  assert.equal(target.top1_high_rate, true);

  const html = buildHtmlReport(payload, {
    quality: { status: "failure", alerts: ["Testowa blokada Excela."] }
  });
  const automatic = buildReportData(payload).scenarios[0].rows[0][2];
  assert.equal(automatic[16], true);
  assert.equal(automatic[3], "top1-high");
  assert.match(html, /type="checkbox" value="high"><span>Powyżej 150 PLN\/d/);
  assert.doesNotMatch(html, /anomalia top1/i);
  assert.match(html, /nowy Excel zablokowała kontrola jakości/);
});

runTest("quality banner shows blocking causes instead of missing MM warnings", () => {
  const html = buildHtmlReport({ locations: [], scenarios: [] }, {
    quality: {
      status: "failure",
      alerts: [
        "Brak MM Cars Rental dla Gdansk Downtown: 195/195 scenariuszy.",
        "Brak obowiazkowego sanity checku MM po potwierdzonym imporcie baseline."
      ],
      blocking_alerts: ["Brak obowiazkowego sanity checku MM po potwierdzonym imporcie baseline."]
    }
  });

  assert.match(html, /Brak obowiazkowego sanity checku MM/);
  assert.doesNotMatch(html, /Brak MM Cars Rental dla Gdansk Downtown/);
});

runTest("buildHtmlReport defaults to all cars and airports with optional automatic and branch filters", () => {
  const automaticMm = { provider_name: "MM Cars Rental", total_price: 220, currency: "PLN", rental_days: 2 };
  const payload = {
    locations: ["Warsaw"],
    scenarios: [{
      scenario_id: "2026-07-12-2",
      start_date: "2026-07-12",
      rental_days: 2,
      top_3_plus_mm_by_location: {
        Warsaw: {
          top_3: [{ provider_name: "Auto One", total_price: 200, currency: "PLN", rental_days: 2 }, automaticMm],
          mm_cars_rental: automaticMm
        }
      },
      offer_views_by_location: {
        Warsaw: {
          automatic: {
            top_3: [{ provider_name: "Auto One", total_price: 200, currency: "PLN", rental_days: 2 }, automaticMm],
            mm_cars_rental: automaticMm,
            mm_provider_rank: 2,
            cheaper_offer_count: 1
          },
          all: {
            top_3: [
              { provider_name: "Manual One", total_price: 160, currency: "PLN", rental_days: 2 },
              { provider_name: "Auto One", total_price: 200, currency: "PLN", rental_days: 2 },
              automaticMm
            ],
            mm_cars_rental: automaticMm,
            mm_provider_rank: 3,
            cheaper_offer_count: 4
          }
        }
      }
    }]
  };
  const html = buildHtmlReport(payload);
  const row = buildReportData(payload).scenarios[0].rows[0];
  const automatic = row[2];
  const all = row[3];

  assert.match(html, /id="filter-transmission"/);
  assert.match(html, /<body data-offer-view="all">/);
  assert.match(html, /id="filter-transmission"><option value="all">Wszystkie auta/);
  assert.match(html, /value="automatic">Tylko automaty/);
  assert.match(html, /id="filter-location-type"><option value="airport">Lotniska/);
  assert.match(html, /value="all">Wszystkie oddziały/);
  assert.match(html, /class="multi-filter" id="filter-location"/);
  assert.match(html, /class="multi-filter" id="filter-duration"/);
  assert.match(html, /id="filter-date-from"/);
  assert.match(html, /id="filter-date-to"/);
  assert.match(html, /id="reset-filters"/);
  assert.match(html, /id="copy-view"[^>]*aria-live="polite"/);
  assert.match(html, /id="toggle-filters"[^>]*aria-controls="report-filters"/);
  assert.match(html, /id="results-status"[^>]*aria-live="polite"/);
  assert.match(html, /id="empty-state" hidden/);
  assert.match(html, /id="load-more"/);
  assert.match(html, /type="checkbox" value="2"/);
  assert.match(html, /selectedDurations\.has\(scenario\.duration\)/);
  assert.match(html, /text = checked\.length \+ " wybrane"/);
  assert.match(html, /visibleScenarioLimit = scenarioPageSize/);
  assert.match(html, /const scenarioPageSize = 20/);
  assert.match(html, /matchingScenariosCache[\s\S]*\.slice\(startIndex, shownSections\)/);
  assert.match(html, /\.filter-field:nth-of-type\(even\) \.multi-options/);
  assert.match(html, /new URLSearchParams\(location\.search\)/);
  assert.match(html, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(html, /navigator\.clipboard\.writeText\(window\.location\.href\)/);
  assert.equal(row[1], "branch");
  assert.match(html, /locationType === "all" \|\| row\[1\] === locationType/);
  assert.match(html, /syncCompactLayout\(\);/);
  assert.equal(automatic[0], "Auto One");
  assert.equal(all[0], "Manual One");
  assert.equal(automatic[13], "Top 2");
  assert.equal(all[13], "Top 3");
  assert.equal(automatic[14], "1");
  assert.equal(all[14], "4");
  assert.equal(buildReportData(payload).scenarios[0].title, "12.07.2026 · 2 dni");
  assert.doesNotMatch(html, /12\.07\.2026 02:00/);
  assert.doesNotMatch(html, /API-DOM|API \/ DOM|source-badge/);

  const airportPayload = {
    locations: ["Warsaw Chopin Airport (WAW)"],
    scenarios: [{
      start_date: "2026-07-12",
      rental_days: 2,
      top_3_plus_mm_by_location: {
        "Warsaw Chopin Airport (WAW)": {
          top_3: [{ provider_name: "Other", total_price: 200, currency: "PLN", rental_days: 2 }]
        }
      }
    }]
  };
  assert.equal(buildReportData(airportPayload).scenarios[0].rows[0][1], "airport");

  const multiDurationHtml = buildHtmlReport({
    locations: ["Warsaw Chopin Airport (WAW)"],
    scenarios: [2, 5].map((rentalDays) => ({
      start_date: "2026-07-12",
      rental_days: rentalDays,
      top_3_plus_mm_by_location: {
        "Warsaw Chopin Airport (WAW)": {
          top_3: [{ provider_name: "Other", total_price: 100 * rentalDays, currency: "PLN", rental_days: rentalDays }]
        }
      }
    }))
  });
  assert.match(multiDurationHtml, /type="checkbox" value="2"/);
  assert.match(multiDurationHtml, /type="checkbox" value="5"/);
});

runTest("generateReportFromFile explains a damaged JSON file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-report-"));
  const inputPath = path.join(tempDir, "broken.json");
  const outputPath = path.join(tempDir, "report.html");
  try {
    fs.writeFileSync(inputPath, "{", "utf8");
    assert.throws(
      () => generateReportFromFile(inputPath, outputPath),
      /plik JSON jest uszkodzony lub niepełny/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

runTest("generateReportFromFile distinguishes a missing JSON file", () => {
  const missingPath = path.join(os.tmpdir(), `discovercars-missing-${Date.now()}.json`);
  assert.throws(
    () => generateReportFromFile(missingPath, path.join(os.tmpdir(), "unused-report.html")),
    /Nie znaleziono pliku danych raportu/
  );
});

runTest("report CLI falls back when the quality JSON is damaged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-quality-fallback-"));
  const inputPath = path.join(tempDir, "results.json");
  const qualityPath = path.join(tempDir, "quality.json");
  const outputPath = path.join(tempDir, "report.html");
  try {
    fs.writeFileSync(inputPath, JSON.stringify({ locations: [], scenarios: [] }), "utf8");
    fs.writeFileSync(qualityPath, "{damaged", "utf8");
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, "../src/reportHtml.js"),
      inputPath,
      outputPath,
      `--quality=${qualityPath}`
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(outputPath), true);
    assert.match(fs.readFileSync(outputPath, "utf8"), /Kontrola cen DiscoverCars/);
    assert.match(result.stderr, /bez statusu kontroli jakości/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

runTest("buildHtmlReport keeps an empty run empty", () => {
  const html = buildHtmlReport({ locations: [], scenarios: [] });
  assert.match(html, /<main id="report-results"><\/main>/);
  assert.match(html, /"scenarios":\[\]/);
  assert.match(html, /Brak wyników dla wybranych filtrów/);
});

runTest("Telegram summary keeps durations and elapsed time compact", () => {
  assert.equal(summarizeNumberList("2,3,4,5,6,7,8,9,10,11,12,13,14"), "2-14");
  assert.equal(summarizeNumberList("2,5,10"), "2, 5, 10");
  assert.equal(formatDuration(15120), "4 h 12 min");
});

runTest("Telegram success summary contains only decision-ready details", () => {
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "success",
      ROLLING_DAYS: "45",
      DURATIONS: "2,3,4,5,6,7,8,9,10,11,12,13,14",
      RUN_STARTED_EPOCH: "1000",
      SCRAPER_DURATION_SECONDS: "13800",
      PAGE_URL: "https://example.test/report.html",
      PAGES_EXCEL_URL: "https://example.test/import.xlsx",
      PAGES_EXCEL_REPORT_URL: "https://example.test/recommendations.xlsx"
    },
    nowEpoch: 16120,
    excelAvailable: true,
    recommendations: {
      recommendation_count: 2,
      recommendations: [
        { action: "increase" },
        { action: "decrease" },
        { action: "hold" }
      ]
    },
    excelSummary: {
      change_count: 14,
      change_statistics: {
        increase_count: 8,
        decrease_count: 6,
        average_increase_pln_day: 12.345,
        average_decrease_pln_day: -8.2
      }
    },
    qualityAlerts: { alerts: [] }
  });

  assert.equal(message, [
    "DiscoverCars | GOTOWE",
    "",
    "Zakres: rolling 45 dni · najem 2-14 dni",
    "Rekomendacje: 2 (podwyżki 1, obniżki 1)",
    "Excel: 14 zmian · gotowy do importu",
    "Średnia zmiana: podwyżka +12,35 PLN/dzień · obniżka -8,20 PLN/dzień",
    "Czas: 4 h 12 min (scraper 3 h 50 min)",
    "",
    "Raport: https://example.test/report.html",
    "Excel importowy: https://example.test/import.xlsx",
    "Excel z rekomendacjami: https://example.test/recommendations.xlsx"
  ].join("\n"));
  assert.doesNotMatch(message, /Scenariusze|sprawdzenia|GitHub Actions/);
});

runTest("Telegram summary highlights a recommendation surge above 100 percent", () => {
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "success",
      ROLLING_DAYS: "60",
      DURATIONS: "2,3,4,5,6,7",
      PAGE_URL: "https://example.test/report.html",
      PAGES_EXCEL_URL: "https://example.test/import.xlsx",
      PAGES_EXCEL_REPORT_URL: "https://example.test/recommendations.xlsx"
    },
    excelAvailable: true,
    recommendations: { recommendations: [] },
    excelSummary: { change_count: 0 },
    qualityAlerts: { alerts: [] },
    recommendationWorkload: {
      recommendation_surge: true,
      alert: "ALERT: liczba aktywnych rekomendacji wzrosla o 150% (2 -> 5)."
    }
  });

  assert.match(message, /ALERT: liczba aktywnych rekomendacji wzrosla o 150% \(2 -> 5\)\./);
});

runTest("Telegram alerts only when MM is absent everywhere for a start date", () => {
  const mm = { provider_name: "MM Cars Rental", total_price: 200, currency: "PLN", rental_days: 2 };
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "success",
      ROLLING_DAYS: "3",
      DURATIONS: "2,3",
      PAGE_URL: "https://example.test/report.html",
      PAGES_EXCEL_URL: "https://example.test/import.xlsx",
      PAGES_EXCEL_REPORT_URL: "https://example.test/recommendations.xlsx"
    },
    excelAvailable: true,
    recommendations: [],
    excelSummary: { change_count: 0 },
    qualityAlerts: { alerts: [] },
    results: {
      scenarios: [
        { start_date: "2026-08-20", rental_days: 2, offer_views_by_location: { Airport: { automatic: { mm_cars_rental: null }, all: { mm_cars_rental: null } } } },
        { start_date: "2026-08-20", rental_days: 3, top_3_plus_mm_by_location: { City: { mm_cars_rental: null } } },
        { start_date: "2026-08-21", rental_days: 2, offer_views_by_location: { Airport: { automatic: { mm_cars_rental: null }, all: { mm_cars_rental: mm } } } },
        { start_date: "2026-08-21", rental_days: 3, top_3_plus_mm_by_location: { City: { mm_cars_rental: null } } },
        { start_date: "2026-08-22", rental_days: 2, top_3_plus_mm_by_location: { Airport: { mm_cars_rental: mm } } }
      ]
    }
  });

  assert.match(message, /ALERT: MM Cars Rental niewidoczne nigdzie dla start date: 20\.08\.2026/);
  assert.doesNotMatch(message, /21\.08\.2026|22\.08\.2026/);
});

runTest("Telegram failure summary leads with the blocking reason", () => {
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "failure",
      START_DATES: "2026-08-16,2026-08-17",
      START_DATE_COUNT: "2",
      DURATIONS: "2,5,10",
      RUN_STARTED_EPOCH: "1000",
      SCRAPER_DURATION_SECONDS: "120",
      ARTIFACT_URL: "https://example.test/artifact",
      RUN_URL: "https://example.test/actions/1"
    },
    nowEpoch: 1300,
    excelAvailable: false,
    qualityAlerts: {
      alerts: ["Ostrzeżenie dodatkowe."],
      blocking_alerts: ["Brak obowiązkowego sanity checku.", "Drugi powód."]
    }
  });

  assert.match(message, /^DiscoverCars \| BŁĄD/);
  assert.match(message, /Excel nie został opublikowany\./);
  assert.match(message, /Powód: Brak obowiązkowego sanity checku\./);
  assert.match(message, /Zakres: 2 konkretnych dat · najem 2, 5, 10 dni/);
  assert.match(message, /GitHub Actions: https:\/\/example\.test\/actions\/1/);
  assert.doesNotMatch(message, /Drugi powód|Excel importowy|Rekomendacje:/);
});

runTest("Telegram degraded summary keeps the Excel link and warning count", () => {
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "degraded",
      ROLLING_DAYS: "14",
      DURATIONS: "2,3,4",
      PAGE_URL: "https://example.test/report.html",
      PAGES_EXCEL_URL: "https://example.test/import.xlsx",
      PAGES_EXCEL_REPORT_URL: "https://example.test/recommendations.xlsx"
    },
    excelAvailable: true,
    recommendations: [],
    excelSummary: { change_count: 0 },
    qualityAlerts: { alerts: ["Pierwsze.", "Drugie."] }
  });

  assert.match(message, /^DiscoverCars \| GOTOWE\n/);
  assert.doesNotMatch(message, /GOTOWE Z OSTRZEŻENIAMI/);
  assert.match(message, /Ostrzeżenia: 2 · szczegóły w raporcie/);
  assert.match(message, /Excel importowy: https:\/\/example\.test\/import\.xlsx/);
});

runTest("Telegram falls back to artifacts when GitHub Pages deployment fails", () => {
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "success",
      ROLLING_DAYS: "7",
      DURATIONS: "2,3",
      ARTIFACT_URL: "https://example.test/results-artifact",
      EXCEL_ARTIFACT_URL: "https://example.test/excel-artifact"
    },
    reportAvailable: true,
    excelAvailable: true,
    recommendations: [],
    excelSummary: { change_count: 0 },
    qualityAlerts: { alerts: [] }
  });

  assert.match(message, /^DiscoverCars \| GOTOWE/);
  assert.match(message, /Raport: https:\/\/example\.test\/results-artifact/);
  assert.match(message, /Excel importowy: https:\/\/example\.test\/excel-artifact/);
  assert.match(message, /Excel z rekomendacjami: https:\/\/example\.test\/excel-artifact/);
});

runTest("Telegram reports publication failure instead of false success", () => {
  const message = buildTelegramSummary({
    env: {
      QUALITY_STATUS: "success",
      ROLLING_DAYS: "7",
      DURATIONS: "2,3",
      RUN_URL: "https://example.test/actions/2"
    },
    reportAvailable: true,
    excelAvailable: true,
    recommendations: [],
    excelSummary: { change_count: 0 },
    qualityAlerts: { alerts: [] }
  });

  assert.match(message, /^DiscoverCars \| BŁĄD PUBLIKACJI/);
  assert.match(message, /Powód: raport nie został udostępniony\./);
  assert.match(message, /GitHub Actions: https:\/\/example\.test\/actions\/2/);
  assert.doesNotMatch(message, /gotowy do importu/);
});

runTest("buildPricingRecommendations raises MM top1 when top2 gap is at least 10 PLN per day", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Krakow"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Krakow: {
            top_3: [
              { provider_name: "MM Cars Rental", total_price: 140, currency: "PLN", rental_days: 2 },
              { provider_name: "Flex To Go", total_price: 164, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 140, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].action, "increase");
  assert.equal(output.recommendations[0].recommendation_type, "top1_gap");
  assert.equal(output.recommendations[0].target_rank, 1);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 81);
  assert.match(output.recommendations[0].reason, /top2 jest drozszy/);
});

runTest("buildPricingRecommendations forceTop1 undercuts top1 even when MM is outside top3", () => {
  const payload = {
    locations: ["Warsaw"],
    scenarios: [{
      scenario_id: "2026-08-16-3",
      start_date: "2026-08-16",
      rental_days: 3,
      top_3_plus_mm_by_location: {
        Warsaw: {
          top_3: [
            { provider_name: "Competitor A", total_price: 300, currency: "PLN", rental_days: 3 },
            { provider_name: "Competitor B", total_price: 330, currency: "PLN", rental_days: 3 },
            { provider_name: "Competitor C", total_price: 360, currency: "PLN", rental_days: 3 }
          ],
          mm_cars_rental: {
            provider_name: "MM Cars Rental",
            total_price: 450,
            currency: "PLN",
            rental_days: 3
          }
        }
      }
    }]
  };

  const output = buildPricingRecommendations(payload, { forceTop1: true });
  assert.equal(output.recommendations[0].action, "decrease");
  assert.equal(output.recommendations[0].recommendation_type, "force_top1_undercut");
  assert.equal(output.recommendations[0].target_rank, 1);
  assert.equal(output.recommendations[0].site_target_rate_pln_day, 99);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 99);
});

runTest("buildPricingRecommendations forceTop1 uses competitor top1 when MM is missing", () => {
  const output = buildPricingRecommendations({
    locations: ["Warsaw"],
    scenarios: [{
      scenario_id: "2026-09-20-3",
      start_date: "2026-09-20",
      rental_days: 3,
      top_3_plus_mm_by_location: {
        Warsaw: {
          top_3: [
            { provider_name: "Competitor A", total_price: 300, currency: "PLN", rental_days: 3 },
            { provider_name: "Competitor B", total_price: 330, currency: "PLN", rental_days: 3 }
          ],
          mm_cars_rental: null
        }
      }
    }]
  }, { forceTop1: true });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].recommendation_type, "force_top1_undercut");
  assert.equal(output.recommendations[0].site_target_rate_pln_day, 99);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 99);
  assert.equal(output.recommendations[0].mm_rate_pln_day, null);
  assert.equal(output.recommendations[0].change_pln_day, null);
  assert.match(output.recommendations[0].reason, /nie jest widoczne/);
});

runTest("buildPricingRecommendations does not recommend changes from duration 8", () => {
  const output = buildPricingRecommendations({
    locations: ["Krakow"],
    scenarios: [{
      scenario_id: "2026-09-20-8",
      start_date: "2026-09-20",
      rental_days: 8,
      top_3_plus_mm_by_location: {
        Krakow: {
          top_3: [
            { provider_name: "MM Cars Rental", total_price: 800, currency: "PLN", rental_days: 8 },
            { provider_name: "Competitor A", total_price: 960, currency: "PLN", rental_days: 8 }
          ],
          mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 800, currency: "PLN", rental_days: 8 }
        }
      }
    }]
  });

  assert.equal(output.recommendation_count, 0);
  assert.equal(output.decisions[0].action, "hold");
  assert.equal(output.decisions[0].data_quality_status, "duration_excluded");
  assert.match(output.decisions[0].reason, /od 8 dni/);
});

runTest("buildPricingRecommendations raises MM top1 when top2 gap is exactly 10 PLN per day", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Krakow"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Krakow: {
            top_3: [
              { provider_name: "MM Cars Rental", total_price: 140, currency: "PLN", rental_days: 2 },
              { provider_name: "Flex To Go", total_price: 160, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 140, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].action, "increase");
  assert.equal(output.recommendations[0].recommendation_type, "top1_gap");
  assert.equal(output.recommendations[0].target_rank, 1);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 79);
  assert.match(output.recommendations[0].reason, /co najmniej 10 PLN/);
});

runTest("buildPricingRecommendations blocks mixed currencies and keeps a decision constraint", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-07-09T07:00:00.000Z",
    locations: ["Warsaw"],
    scenarios: [{
      scenario_id: "date-20260710-2d",
      start_date: "2026-07-10",
      rental_days: 2,
      top_3_plus_mm_by_location: {
        Warsaw: {
          top_3: [
            { provider_name: "MM Cars Rental", total_price: 140, currency: "PLN", rental_days: 2 },
            { provider_name: "Other", total_price: 80, currency: "EUR", rental_days: 2 }
          ],
          mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 140, currency: "PLN", rental_days: 2 }
        }
      }
    }]
  });

  assert.equal(output.recommendation_count, 0);
  assert.equal(output.decisions.length, 1);
  assert.equal(output.decisions[0].action, "hold");
  assert.equal(output.decisions[0].data_quality_status, "invalid_currency");
});

runTest("buildPricingRecommendations uses top1 undercut when MM is top2 and less than 10 PLN per day from top1", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Warsaw"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Warsaw: {
            top_3: [
              { provider_name: "Car24", total_price: 180, currency: "PLN", rental_days: 2 },
              { provider_name: "MM Cars Rental", total_price: 196, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 196, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].action, "decrease");
  assert.equal(output.recommendations[0].recommendation_type, "top1_undercut");
  assert.equal(output.recommendations[0].target_rank, 1);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 89);
  assert.match(output.recommendations[0].reason, /jest top2/);
});

runTest("buildPricingRecommendations skips top1 undercut when MM top2 needs at least 10 PLN per day", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Warsaw"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Warsaw: {
            top_3: [
              { provider_name: "Car24", total_price: 180, currency: "PLN", rental_days: 2 },
              { provider_name: "MM Cars Rental", total_price: 198, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 198, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 0);
});

runTest("buildPricingRecommendations flags a small decrease needed to enter top3", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Gdansk"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Gdansk: {
            top_3: [
              { provider_name: "Car24", total_price: 200, currency: "PLN", rental_days: 2 },
              { provider_name: "Flex To Go", total_price: 220, currency: "PLN", rental_days: 2 },
              { provider_name: "Kaizen Rent", total_price: 240, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 250, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].action, "decrease");
  assert.equal(output.recommendations[0].recommendation_type, "top3_small_decrease");
  assert.equal(output.recommendations[0].benchmark_provider, "Kaizen Rent");
  assert.equal(output.recommendations[0].target_rank, 3);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 119);
});

runTest("buildPricingRecommendations uses top1 undercut for a small decrease from top2 to top1", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Poznan"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Poznan: {
            top_3: [
              { provider_name: "Car24", total_price: 200, currency: "PLN", rental_days: 2 },
              { provider_name: "MM Cars Rental", total_price: 210, currency: "PLN", rental_days: 2 },
              { provider_name: "Flex To Go", total_price: 230, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 210, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].action, "decrease");
  assert.equal(output.recommendations[0].recommendation_type, "top1_undercut");
  assert.equal(output.recommendations[0].target_rank, 1);
  assert.equal(output.recommendations[0].benchmark_provider, "Car24");
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 99);
});

runTest("buildPricingRecommendations converts site target to import rate with broker markup calibration", () => {
  const output = buildPricingRecommendations(
    {
      generated_at: "2026-06-09T07:00:00.000Z",
      locations: ["Poznan"],
      scenarios: [
        {
          scenario_id: "2026-06-10-2",
          start_date: "2026-06-10",
          pickup_date: "2026-06-10T10:00:00+02:00",
          dropoff_date: "2026-06-12T10:00:00+02:00",
          rental_days: 2,
          top_3_plus_mm_by_location: {
            Poznan: {
              top_3: [
                { provider_name: "Car24", total_price: 200, currency: "PLN", rental_days: 2 },
                { provider_name: "MM Cars Rental", total_price: 210, currency: "PLN", rental_days: 2 }
              ],
              mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 210, currency: "PLN", rental_days: 2 }
            }
          }
        }
      ]
    },
    {
      brokerMarkupCalibration: {
        enabled: true,
        defaultMultiplier: 1.075,
        locationMultipliers: {
          Poznan: 1.1
        }
      }
    }
  );

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].site_target_rate_pln_day, 99);
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 90);
  assert.equal(output.recommendations[0].predicted_site_rate_pln_day, 99);
  assert.equal(output.recommendations[0].broker_markup_multiplier, 1.1);
  assert.equal(output.recommendations[0].broker_markup_source, "location:Poznan");
  assert.equal(output.recommendations[0].change_pln_day, -6);
});

runTest("buildPricingRecommendations uses small decrease to pass a top2 rival when MM is top3", () => {
  const output = buildPricingRecommendations({
    generated_at: "2026-06-09T07:00:00.000Z",
    locations: ["Poznan"],
    scenarios: [
      {
        scenario_id: "2026-06-10-2",
        start_date: "2026-06-10",
        pickup_date: "2026-06-10T10:00:00+02:00",
        dropoff_date: "2026-06-12T10:00:00+02:00",
        rental_days: 2,
        top_3_plus_mm_by_location: {
          Poznan: {
            top_3: [
              { provider_name: "Car24", total_price: 190, currency: "PLN", rental_days: 2 },
              { provider_name: "Flex To Go", total_price: 200, currency: "PLN", rental_days: 2 },
              { provider_name: "MM Cars Rental", total_price: 210, currency: "PLN", rental_days: 2 }
            ],
            mm_cars_rental: { provider_name: "MM Cars Rental", total_price: 210, currency: "PLN", rental_days: 2 }
          }
        }
      }
    ]
  });

  assert.equal(output.recommendation_count, 1);
  assert.equal(output.recommendations[0].action, "decrease");
  assert.equal(output.recommendations[0].recommendation_type, "top3_small_decrease");
  assert.equal(output.recommendations[0].target_rank, 2);
  assert.equal(output.recommendations[0].benchmark_provider, "Flex To Go");
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 99);
});

runTest("mergePricingRecommendations lets short run replace matching full-run recommendations", () => {
  const output = mergePricingRecommendations(
    {
      generated_at: "2026-06-12T01:00:00.000Z",
      recommendations: [
        {
          action: "increase",
          location: "Warsaw",
          start_date: "2026-06-13",
          rental_days: 2,
          suggested_rate_pln_day: 100
        },
        {
          action: "decrease",
          location: "Krakow",
          start_date: "2026-07-20",
          rental_days: 7,
          suggested_rate_pln_day: 90
        },
        {
          action: "increase",
          location: "Gdansk",
          start_date: "2026-06-14",
          rental_days: 1,
          suggested_rate_pln_day: 110
        }
      ]
    },
    {
      generated_at: "2026-06-12T07:00:00.000Z",
      recommendations: [
        {
          action: "decrease",
          location: "Warsaw",
          pickup_date: "2026-06-13T10:00:00+02:00",
          rental_days: 2,
          suggested_rate_pln_day: 95
        },
        {
          action: "hold",
          location: "Gdansk",
          start_date: "2026-06-14",
          rental_days: 1,
          suggested_rate_pln_day: null
        }
      ]
    },
    new Date("2026-06-12T07:05:00.000Z")
  );

  assert.equal(output.merge.base_count, 3);
  assert.equal(output.merge.update_count, 2);
  assert.equal(output.merge.replaced_count, 2);
  assert.equal(output.recommendation_count, 2);
  assert.equal(output.recommendations.length, 3);
  assert.equal(output.recommendations[0].location, "Warsaw");
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 95);
  assert.equal(output.recommendations[1].location, "Gdansk");
  assert.equal(output.recommendations[1].action, "hold");
  assert.equal(output.recommendations[2].location, "Krakow");
});

runTest("mergePricingRecommendations removes a stale active recommendation when fresh decision is hold", () => {
  const output = mergePricingRecommendations(
    {
      decisions: [{ action: "increase", location: "Warsaw", start_date: "2026-07-10", rental_days: 2 }],
      recommendations: [{ action: "increase", location: "Warsaw", start_date: "2026-07-10", rental_days: 2 }]
    },
    {
      decisions: [{ action: "hold", location: "Warsaw", start_date: "2026-07-10", rental_days: 2 }],
      recommendations: []
    }
  );

  assert.equal(output.decisions.length, 1);
  assert.equal(output.decisions[0].action, "hold");
  assert.equal(output.recommendations.length, 0);
  assert.equal(output.recommendation_count, 0);
});

runTest("buildQualityAlerts reports missing city data and workbook warnings", () => {
  const alerts = buildQualityAlerts({
    expectedLocations: "Warsaw,Krakow",
    results: {
      scenarios: [
        {
          top_3_plus_mm_by_location: {
            Warsaw: {
              top_3: [{ provider_name: "MM Cars Rental" }]
            }
          }
        }
      ]
    },
    recommendations: {
      recommendations: []
    },
    excelSummary: {
      change_count: 0,
      validation: [
        {
          check: "Zmienione stawki ponizej floor cenowego",
          status: "WARNING",
          issue_count: 3
        }
      ]
    }
  });

  assert(alerts.some((item) => item.includes("Brak danych dla Krakow")));
  assert(alerts.some((item) => item.includes("Brak aktywnych rekomendacji")));
  assert(alerts.some((item) => item.includes("Excel nie zawiera zmian")));
  assert(alerts.some((item) => item.includes("Validation WARNING")));
});

runTest("buildScrapeQualityReport distinguishes missing MM from missing top3 and rejects non-PLN", () => {
  const degraded = buildScrapeQualityReport({
    expectedLocations: "Warsaw",
    results: {
      scenarios: [{
        results: [{ location: "Warsaw" }],
        errors: [],
        top_3_plus_mm_by_location: {
          Warsaw: { top_3: [{ provider_name: "Other", currency: "PLN" }], mm_cars_rental: null }
        }
      }]
    }
  });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.missing_top3_count, 0);
  assert.equal(degraded.missing_mm_count, 1);

  const failed = buildScrapeQualityReport({
    expectedLocations: "Warsaw",
    results: {
      scenarios: [{
        results: [{ location: "Warsaw" }],
        errors: [],
        top_3_plus_mm_by_location: {
          Warsaw: { top_3: [{ provider_name: "Other", currency: "EUR" }], mm_cars_rental: null }
        }
      }]
    }
  });
  assert.equal(failed.status, "failure");
  assert.equal(failed.invalid_currency_count, 1);
});

runTest("selectSanitySample picks active unique recommendation scenarios", () => {
  const sample = selectSanitySample({
    recommendations: [
      { action: "hold", location: "Warsaw", start_date: "2026-06-20", rental_days: 2, mm_rate_pln_day: 90 },
      { action: "decrease", location: "Warsaw", start_date: "2026-06-20", rental_days: 2, mm_rate_pln_day: 90 },
      { action: "decrease", location: "Warsaw", start_date: "2026-06-20", rental_days: 2, mm_rate_pln_day: 91 },
      { action: "increase", location: "Gdansk", start_date: "2026-06-21", rental_days: 3, mm_rate_pln_day: 110 },
      { action: "increase", location: "Poznan", start_date: "2026-06-22", rental_days: 4, mm_rate_pln_day: null }
    ]
  }, 3);

  assert.equal(sample.length, 2);
  assert.deepEqual(sample.map((item) => `${item.location}-${item.start_date}-${item.rental_days}`), [
    "Gdansk-2026-06-21-3",
    "Warsaw-2026-06-20-2"
  ]);
});

runTest("selectSanitySample spreads a six-item sample across locations", () => {
  const recommendations = {
    recommendations: ["Gdansk Airport", "Katowice Downtown", "Krakow Airport", "Poznan Downtown", "Warsaw Airport", "Wroclaw Downtown"]
      .flatMap((location, locationIndex) => [2, 5, 10].map((rentalDays) => ({
        action: "increase",
        recommendation_type: locationIndex % 2 ? "top1_gap" : "top1_undercut",
        location,
        start_date: `2026-07-${String(10 + locationIndex).padStart(2, "0")}`,
        rental_days: rentalDays,
        mm_rate_pln_day: 100
      })))
  };
  const sample = selectSanitySample(recommendations, 6);
  assert.equal(sample.length, 6);
  assert.equal(new Set(sample.map((item) => item.location)).size, 6);
});

runTest("buildSanityComparison warns when live MM rate differs from recommendation source", () => {
  const comparison = buildSanityComparison({
    thresholdPlnDay: 10,
    recommendation: {
      location: "Katowice",
      start_date: "2026-06-17",
      rental_days: 10,
      recommendation_type: "top3_small_decrease",
      mm_rate_pln_day: 85.5,
      suggested_rate_pln_day: 80,
      site_target_rate_pln_day: 86,
      predicted_site_rate_pln_day: 85.6,
      broker_markup_multiplier: 1.07,
      broker_markup_percent: 7,
      broker_markup_source: "default",
      baseline_import_rate_pln_day: 100,
      source_generated_at: "2026-06-15T02:41:25.842Z"
    },
    livePayload: {
      generated_at: "2026-06-15T08:45:18.668Z",
      mm_cars_rental_by_location: {
        Katowice: {
          provider_name: "MM Cars Rental",
          total_price: 1064,
          rental_days: 10
        }
      },
      top_3_by_location: {
        Katowice: [
          { provider_name: "Kaizen Rent" },
          { provider_name: "GO Rental Cars" },
          { provider_name: "CarFree Rent a Car" }
        ]
      }
    }
  });

  assert.equal(comparison.status, "WARNING");
  assert.equal(comparison.live_mm_rate_pln_day, 106.4);
  assert.equal(comparison.delta_pln_day, 20.9);
  assert.equal(comparison.site_target_rate_pln_day, 86);
  assert.equal(comparison.predicted_site_rate_pln_day, 85.6);
  assert.equal(comparison.live_minus_site_target_pln_day, 20.4);
  assert.equal(comparison.live_minus_predicted_site_pln_day, 20.8);
  assert.equal(comparison.broker_markup_multiplier, 1.07);
  assert.equal(comparison.observed_broker_markup_multiplier, 1.064);
  assert.equal(comparison.live_mm_rank, "outside_top3");
});

runTest("sanity recommendations use confirmed baseline import rates from Excel summary", () => {
  const recommendations = {
    recommendations: [{
      action: "increase",
      location: "Warsaw",
      start_date: "2026-07-11",
      rental_days: 3,
      mm_rate_pln_day: 110
    }]
  };
  const enriched = enrichRecommendationsWithBaseline(recommendations, {
    broker_markup_observations: {
      observations: [{
        location: "Warsaw",
        pickup_date: "2026-07-11",
        duration_days: 3,
        old_import_rate_pln_day: 100,
        live_mm_rate_pln_day: 110
      }]
    }
  });
  assert.equal(enriched[0].baseline_import_rate_pln_day, 100);
  assert.equal(enriched[0].baseline_live_mm_rate_pln_day, 110);
});

runTest("required sanity check blocks missing verification but keeps warnings degraded", () => {
  const input = {
    expectedLocations: "Warsaw",
    results: {
      locations: ["Warsaw"],
      scenarios: [{
        results: [{ location: "Warsaw" }],
        errors: [],
        top_3_plus_mm_by_location: {
          Warsaw: {
            top_3: [{ provider_name: "Other", currency: "PLN" }],
            mm_cars_rental: { provider_name: "MM Cars Rental", currency: "PLN" }
          }
        }
      }]
    },
    recommendations: { recommendations: [{ action: "increase" }] },
    excelSummary: { change_count: 1, validation: [] },
    requireSanity: true
  };

  const missingSanity = buildQualityReport({ ...input, sanityCheck: null });
  assert.equal(missingSanity.status, "failure");
  assert.deepEqual(missingSanity.blocking_alerts, [
    "Brak obowiazkowego sanity checku MM po potwierdzonym imporcie baseline."
  ]);
  assert.equal(buildQualityReport({
    ...input,
    sanityCheck: {
      checked_count: 1,
      warning_count: 1,
      baseline_verification_required: true,
      baseline_verified_count: 1,
      checks: [{ status: "WARNING", warning_reasons: ["live_rate_changed_since_full_scrape"] }]
    }
  }).status, "degraded");
  assert.equal(buildQualityReport({
    ...input,
    sanityCheck: {
      checked_count: 1,
      warning_count: 1,
      baseline_verification_required: true,
      baseline_verified_count: 0,
      checks: [{ status: "WARNING", warning_reasons: ["live_rate_unavailable"] }]
    }
  }).status, "failure");
  assert.equal(buildQualityReport({
    ...input,
    sanityCheck: {
      checked_count: 13,
      warning_count: 3,
      baseline_verification_required: true,
      baseline_verified_count: 10,
      checks: [
        { status: "WARNING", warning_reasons: ["live_rate_changed_since_full_scrape"] },
        { status: "WARNING", warning_reasons: ["baseline_markup_outside_allowed_range"] },
        { status: "WARNING", warning_reasons: ["live_rate_changed_since_full_scrape"] }
      ]
    }
  }).status, "degraded");
  assert.equal(buildQualityReport({
    ...input,
    sanityCheck: {
      checked_count: 1,
      warning_count: 0,
      baseline_verification_required: true,
      baseline_verified_count: 1,
      checks: [{ status: "OK" }]
    }
  }).status, "success");
});

runTest("buildCalibrationUpdate learns broker markup from Excel observations with smoothing", () => {
  const output = buildCalibrationUpdate({
    baseConfig: {
      pricing: {
        brokerMarkupCalibration: {
          enabled: true,
          defaultMultiplier: 1.075,
          minMultiplier: 1,
          maxMultiplier: 1.2,
          locationMultipliers: {
            Poznan: 1.09
          }
        }
      }
    },
    excelSummary: {
      broker_markup_observations: {
        enabled: true,
        count: 3,
        average_multiplier: 1.1,
        median_multiplier: 1.1,
        average_markup_percent: 10,
        by_location: {
          Poznan: {
            count: 3,
            average_multiplier: 1.12,
            median_multiplier: 1.12,
            average_markup_percent: 12
          }
        },
        by_duration: {
          3: {
            count: 3,
            average_multiplier: 1.08,
            median_multiplier: 1.08,
            average_markup_percent: 8
          }
        },
        by_location_duration: {
          Poznan: {
            3: {
              count: 3,
              average_multiplier: 1.11,
              median_multiplier: 1.11
            }
          }
        }
      }
    },
    alpha: 0.5
  });

  assert.equal(output.learning.observation_count, 3);
  assert.equal(output.brokerMarkupCalibration.defaultMultiplier, 1.0875);
  assert.equal(output.brokerMarkupCalibration.locationMultipliers.Poznan, 1.105);
  assert.equal(output.brokerMarkupCalibration.durationMultipliers["3"], 1.08);
  assert.equal(output.brokerMarkupCalibration.locationDurationMultipliers.Poznan["3"], 1.11);
});

runTest("buildCalibrationUpdate ignores segments below the minimum sample count", () => {
  const output = buildCalibrationUpdate({
    baseConfig: { pricing: { brokerMarkupCalibration: { enabled: true, defaultMultiplier: 1.075 } } },
    excelSummary: {
      broker_markup_observations: {
        enabled: true,
        count: 1,
        median_multiplier: 1.2,
        by_location: { Warsaw: { count: 1, median_multiplier: 1.2 } }
      }
    },
    minSamples: 3
  });
  assert.equal(output.brokerMarkupCalibration.defaultMultiplier, 1.075);
  assert.equal(output.brokerMarkupCalibration.locationMultipliers.Warsaw, undefined);
});

runTest("buildQualityAlerts includes MM sanity check warnings", () => {
  const alerts = buildQualityAlerts({
    expectedLocations: "",
    results: { scenarios: [] },
    recommendations: { recommendations: [{ action: "increase" }] },
    excelSummary: { change_count: 1, validation: [] },
    sanityCheck: {
      threshold_pln_day: 10,
      checked_count: 1,
      warning_count: 1,
      checks: [
        {
          status: "WARNING",
          location: "Katowice",
          start_date: "2026-06-17",
          rental_days: 10,
          delta_pln_day: 20.9
        }
      ]
    }
  });

  assert(alerts.some((item) => item.includes("Sanity check MM")));
  assert(alerts.some((item) => item.includes("Katowice 2026-06-17 10d")));
});

runTest("buildScrapeQualityReport exposes API DOM drift monitoring", () => {
  const report = buildScrapeQualityReport({
    expectedLocations: "Warsaw",
    results: {
      locations: ["Warsaw"],
      api_dom_monitoring: {
        comparison_count: 5,
        drift_count: 2,
        drift_rate_percent: 40,
        browser_preferred_count: 2,
        adaptive_validation_triggered: true
      },
      scenarios: [{
        results: [{ location: "Warsaw" }],
        errors: [],
        top_3_plus_mm_by_location: {
          Warsaw: {
            top_3: [{ provider_name: "Other", currency: "PLN" }],
            mm_cars_rental: { provider_name: "MM Cars Rental", currency: "PLN" }
          }
        }
      }]
    }
  });
  assert.equal(report.status, "degraded");
  assert.equal(report.api_dom_monitoring.drift_count, 2);
  assert.equal(report.api_dom_monitoring.adaptive_validation_triggered, true);
});

async function runAsyncTests() {
  const originalScraperRun = DiscoverCarsScraper.prototype.run;
  let expiredBudgetScrapeCalls = 0;
  DiscoverCarsScraper.prototype.run = async function runExpiredBudgetProbe() {
    expiredBudgetScrapeCalls += 1;
    throw new Error("DOM scrape should not start after the verification budget expires");
  };
  try {
    const expiredBudgetOutput = await verifyActiveRecommendations({
      decisions: [{
        action: "increase",
        location: "Warsaw Train Station",
        start_date: "2026-08-22",
        rental_days: 2,
        source_validation_status: "api_unverified",
        suggested_rate_pln_day: 100
      }],
      recommendations: []
    }, {
      concurrency: 2,
      maxDurationMs: 0,
      speedMode: "fast",
      timeoutMs: 1,
      workDir: os.tmpdir()
    });
    assert.equal(expiredBudgetScrapeCalls, 0);
    assert.equal(expiredBudgetOutput.recommendations.length, 0);
    assert.equal(expiredBudgetOutput.decisions[0].action, "hold");
    assert.equal(expiredBudgetOutput.decisions[0].dom_verification_status, "dom_verification_budget_exhausted");
    assert.equal(expiredBudgetOutput.dom_verification.budget_exhausted_count, 1);
    assert.equal(expiredBudgetOutput.dom_verification.budget_exhausted, true);
    console.log("PASS DOM recommendation verification blocks unchecked changes when its time budget expires");
  } finally {
    DiscoverCarsScraper.prototype.run = originalScraperRun;
  }

  const checkpointWrites = [];
  const checkpointController = createCheckpointController({
    enabled: true,
    checkpointPath: path.join(os.tmpdir(), `discovercars-checkpoint-${process.pid}.json`),
    runSignature: "checkpoint-batch-test",
    cli: { resetState: false, locations: ["Warsaw"] },
    scenarios: [],
    maxPendingCompletions: 3,
    maxWriteDelayMs: 60_000,
    writeState: (_filePath, state) => {
      checkpointWrites.push(JSON.parse(JSON.stringify(state)));
    }
  });
  const completedPayload = (scenarioId) => ({
    scenario_id: scenarioId,
    results: [{ location: "Warsaw" }],
    errors: [],
    top_3_by_location: { Warsaw: [{ total_price: 100 }] }
  });

  await checkpointController.markScenarioCompleted(completedPayload("scenario-1"));
  assert.equal(checkpointWrites.length, 1);
  await checkpointController.markScenarioCompleted(completedPayload("scenario-2"));
  await checkpointController.markScenarioCompleted(completedPayload("scenario-3"));
  assert.equal(checkpointWrites.length, 1);
  await checkpointController.markScenarioCompleted(completedPayload("scenario-4"));
  assert.equal(checkpointWrites.length, 2);
  assert.equal(checkpointWrites.at(-1).completed_count, 4);
  await checkpointController.markScenarioCompleted(completedPayload("scenario-5"));
  await checkpointController.flush();
  assert.equal(checkpointWrites.length, 3);
  assert.equal(checkpointWrites.at(-1).completed_count, 5);
  console.log("PASS checkpoint batches writes and flushes pending scenarios");

  let checkpointWriteAttempts = 0;
  const retriedCheckpointWrites = [];
  const retryingCheckpointController = createCheckpointController({
    enabled: true,
    checkpointPath: path.join(os.tmpdir(), `discovercars-checkpoint-retry-${process.pid}.json`),
    runSignature: "checkpoint-retry-test",
    cli: { resetState: false, locations: ["Warsaw"] },
    scenarios: [],
    maxPendingCompletions: 10,
    maxWriteDelayMs: 5,
    writeState: async (_filePath, state) => {
      checkpointWriteAttempts += 1;
      if (checkpointWriteAttempts === 2) {
        throw new Error("simulated checkpoint failure");
      }
      retriedCheckpointWrites.push(JSON.parse(JSON.stringify(state)));
    }
  });
  await retryingCheckpointController.markScenarioCompleted(completedPayload("retry-1"));
  await retryingCheckpointController.markScenarioCompleted(completedPayload("retry-2"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(checkpointWriteAttempts, 2);
  await retryingCheckpointController.flush();
  assert.equal(checkpointWriteAttempts, 3);
  assert.equal(retriedCheckpointWrites.at(-1).completed_count, 2);
  console.log("PASS checkpoint flush retries a failed background write");

  const failingCheckpointController = createCheckpointController({
    enabled: true,
    checkpointPath: path.join(os.tmpdir(), `discovercars-checkpoint-failure-${process.pid}.json`),
    runSignature: "checkpoint-failure-test",
    cli: { resetState: false, locations: ["Warsaw"] },
    scenarios: [],
    writeState: async () => {
      throw new Error("persistent checkpoint failure");
    }
  });
  await assert.rejects(
    failingCheckpointController.markScenarioCompleted(completedPayload("failure-1")),
    /persistent checkpoint failure/
  );
  await assert.rejects(failingCheckpointController.flush(), /persistent checkpoint failure/);
  console.log("PASS checkpoint flush surfaces a persistent write failure");

  const watchdogDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-watchdog-"));
  const watchdogLog = path.join(watchdogDir, "run.log");
  try {
    await assert.rejects(
      runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(),
        logPath: watchdogLog,
        label: "stalled-test",
        stallTimeoutMs: 100,
        progressCheckIntervalMs: 25
      }),
      /made no progress/
    );
    assert.match(fs.readFileSync(watchdogLog, "utf8"), /terminating process tree/);
    console.log("PASS chunk watchdog terminates a stalled child process");

    const progressPath = path.join(watchdogDir, "state.json");
    const progressScript = [
      "const fs=require('fs')",
      "const p=process.argv[1]",
      "let count=0",
      "const timer=setInterval(()=>fs.writeFileSync(p,String(++count)),60)",
      "setTimeout(()=>{clearInterval(timer);process.exit(0)},360)"
    ].join(";");
    await runCommand(process.execPath, ["-e", progressScript, progressPath], {
      cwd: process.cwd(),
      logPath: watchdogLog,
      label: "progress-test",
      progressPath,
      stallTimeoutMs: 150,
      progressCheckIntervalMs: 25
    });
    console.log("PASS chunk watchdog preserves a child with checkpoint progress");
  } finally {
    fs.rmSync(watchdogDir, { recursive: true, force: true });
  }

  let launchCount = 0;
  let closeCount = 0;
  const fakeBrowser = {
    isConnected: () => true,
    close: async () => {
      closeCount += 1;
    }
  };
  const provider = createSharedBrowserProvider(async () => {
    launchCount += 1;
    return fakeBrowser;
  });

  const [first, second] = await Promise.all([
    provider.getBrowser({ headless: true }),
    provider.getBrowser({ headless: true })
  ]);
  assert.equal(first, fakeBrowser);
  assert.equal(second, fakeBrowser);
  assert.equal(launchCount, 1);
  await provider.close();
  assert.equal(closeCount, 1);
  console.log("PASS shared browser provider reuses and closes one browser");

  let reconnectLaunchCount = 0;
  let reconnectedCloseCount = 0;
  const disconnectedBrowser = { isConnected: () => false, close: async () => {} };
  const reconnectedBrowser = {
    isConnected: () => true,
    close: async () => {
      reconnectedCloseCount += 1;
    }
  };
  const reconnectingProvider = createSharedBrowserProvider(async () => {
    reconnectLaunchCount += 1;
    return reconnectLaunchCount === 1 ? disconnectedBrowser : reconnectedBrowser;
  });
  const reconnected = await Promise.all(Array.from({ length: 4 }, () => reconnectingProvider.getBrowser()));
  assert.equal(reconnectLaunchCount, 2);
  assert.ok(reconnected.every((browser) => browser === reconnectedBrowser));
  await reconnectingProvider.close();
  assert.equal(reconnectedCloseCount, 1);
  console.log("PASS shared browser provider serializes concurrent reconnects");

  let networkIdleCalls = 0;
  const visibleSignal = {
    first: () => visibleSignal,
    waitFor: async () => {},
    isVisible: async () => true
  };
  const quickPage = {
    getByText: () => visibleSignal,
    locator: () => visibleSignal,
    waitForLoadState: async (state) => {
      if (state === "networkidle") networkIdleCalls += 1;
    },
    waitForTimeout: async () => {}
  };
  const quickScraper = new DiscoverCarsScraper({ timeoutMs: 1000, speedMode: "fast" });
  await quickScraper.waitForResults(quickPage, {
    collector: { waitForOffers: async () => true },
    quickSignalTimeoutMs: 5
  });
  assert.equal(networkIdleCalls, 0);
  console.log("PASS ready DOM signal skips networkidle wait");

  let fallbackNetworkIdleCalls = 0;
  const hiddenSignal = {
    first: () => hiddenSignal,
    waitFor: async () => {
      throw new Error("not visible");
    },
    isVisible: async () => false
  };
  const fallbackPage = {
    getByText: () => hiddenSignal,
    locator: () => hiddenSignal,
    waitForLoadState: async (state) => {
      if (state === "networkidle") fallbackNetworkIdleCalls += 1;
    },
    waitForTimeout: async () => {}
  };
  await quickScraper.waitForResults(fallbackPage, {
    collector: { waitForOffers: async () => false },
    quickSignalTimeoutMs: 1
  });
  assert.equal(fallbackNetworkIdleCalls, 1);
  console.log("PASS missing quick DOM signal preserves networkidle fallback");
}

runAsyncTests().then(() => {
  if (!process.exitCode) {
    console.log("All DiscoverCars tests passed.");
  }
}).catch((error) => {
  console.error("FAIL shared browser provider reuses and closes one browser");
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
