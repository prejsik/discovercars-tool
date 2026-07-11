const assert = require("node:assert/strict");

const { loadConfig } = require("../src/discovercars/config");
const { parseMoney, toCsv } = require("../src/discovercars/utils");
const {
  buildGeoSearchPayload,
  DiscoverCarsScraper,
  extractOffersFromSearchApiPayload,
  resolveGeoLocationOverride,
  searchApiPayloadMatchesPeriod
} = require("../src/discovercars/scraper");
const { mergePricingRecommendations } = require("../src/mergePricingRecommendations");
const { buildLocationBreakdown } = require("../src/discoverCars");
const { buildPricingRecommendations } = require("../src/pricingRecommendations");
const { buildHtmlReport } = require("../src/reportHtml");
const {
  buildSanityComparison,
  enrichRecommendationsWithBaseline,
  selectSanitySample
} = require("../src/mmRateSanityCheck");
const { buildCalibrationUpdate } = require("../src/updateBrokerMarkupCalibration");
const { buildQualityAlerts, buildQualityReport, buildScrapeQualityReport } = require("../src/workflowQualityAlerts");
const { mergePayloads } = require("../src/mergeDiscovercarsResults");
const { parseArgs: parseChunkedArgs } = require("../src/runDiscovercarsChunked");
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

runTest("transmission helpers recognize automatic, manual, and ACRISS codes", () => {
  assert.equal(normalizeTransmission("Automatic Transmission"), "automatic");
  assert.equal(normalizeTransmission("Manual Transmission"), "manual");
  assert.equal(normalizeTransmission("EDAH"), "automatic");
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

runTest("active pricing candidates always require DOM validation", () => {
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
  assert.equal(scraper.shouldValidateApiOutcome("Warsaw", activeTop1Gap), true);
  assert.equal(scraper.shouldValidateApiOutcome("Krakow", inactiveTop1Gap), false);
  assert.equal(scraper.apiDomTelemetry.mandatory_recommendation_validation_count, 1);
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
    "--skip-postprocess"
  ]);

  assert.equal(options.startDates.length, 3);
  assert.deepEqual(options.durations, [2]);
  assert.deepEqual(options.locations, ["Warsaw"]);
  assert.equal(options.locationConcurrency, 3);
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
  assert.equal(dailyLocations.length, 13);
  assert(dailyLocations.includes("Galeria Krakowska Shopping Mall"));
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
  const html = buildHtmlReport({
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
  });

  assert.match(html, /<table>/);
  assert.match(html, /Top 1 firma/);
  assert.match(html, /Top 1 PLN\/d/);
  assert.match(html, /MM Cars Rental \(8\.8\)/);
  assert.match(html, /mm-close/);
  assert.match(html, /50\.00 PLN\/day/);
  assert.match(html, /filter-location/);
  assert.match(html, /brak MM Cars Rental/);
  assert.doesNotMatch(html, /source \/ car/i);
  assert.doesNotMatch(html, /evidence-cell/);
  assert.match(html, /table-layout: fixed/);
});

runTest("buildHtmlReport marks MM Cars Rental when top2 is at least 10 PLN per day above MM top1", () => {
  const html = buildHtmlReport({
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
  });

  assert.match(html, /offer-view-automatic mm mm-top1-gap">MM Cars Rental \(8\.8\)<\/span>/);
  assert.match(html, /offer-view-automatic mm mm-top1-gap">50\.00 PLN\/day<\/span>/);
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

  const gap20Html = buildHtmlReport(buildPayload(140));
  assert.match(gap20Html, /data-mm-state-automatic="top1-gap-20"/);
  assert.match(gap20Html, /offer-view-automatic mm mm-top1-gap-20/);
  assert.match(gap20Html, /option value="top1-gap-20"/);

  const gap30Html = buildHtmlReport(buildPayload(160));
  assert.match(gap30Html, /data-mm-state-automatic="top1-gap-30"/);
  assert.match(gap30Html, /offer-view-automatic mm mm-top1-gap-30/);
  assert.match(gap30Html, /option value="top1-gap-30"/);
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
  assert.match(html, /data-top1-high-automatic="true"/);
  assert.match(html, /offer-view-automatic top1-high/);
  assert.match(html, /option value="high">Powyżej 150 PLN\/d/);
  assert.doesNotMatch(html, /anomalia top1/i);
  assert.match(html, /nowy Excel zostal zablokowany/);
});

runTest("buildHtmlReport switches between automatic and all offers with MM position and cheaper count", () => {
  const automaticMm = { provider_name: "MM Cars Rental", total_price: 220, currency: "PLN", rental_days: 2 };
  const html = buildHtmlReport({
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
  });

  assert.match(html, /id="filter-transmission"/);
  assert.match(html, /value="automatic">Tylko automaty/);
  assert.match(html, /value="all">Wszystkie auta/);
  assert.match(html, /offer-view-automatic[^>]*>Auto One/);
  assert.match(html, /offer-view-all[^>]*>Manual One/);
  assert.match(html, /offer-view-automatic rank-cell">Top 2/);
  assert.match(html, /offer-view-all rank-cell">Top 3/);
  assert.match(html, /offer-view-automatic count-cell">1/);
  assert.match(html, /offer-view-all count-cell">4/);
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

runTest("required sanity check blocks publishing when missing or warning", () => {
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

  assert.equal(buildQualityReport({ ...input, sanityCheck: null }).status, "failure");
  assert.equal(buildQualityReport({
    ...input,
    sanityCheck: {
      checked_count: 1,
      warning_count: 1,
      baseline_verification_required: true,
      baseline_verified_count: 0,
      checks: [{ status: "WARNING" }]
    }
  }).status, "failure");
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

if (!process.exitCode) {
  console.log("All DiscoverCars tests passed.");
}
