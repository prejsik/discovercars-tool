const assert = require("node:assert/strict");

const { loadConfig } = require("../src/discovercars/config");
const { parseMoney, toCsv } = require("../src/discovercars/utils");
const { mergePricingRecommendations } = require("../src/mergePricingRecommendations");
const { buildPricingRecommendations } = require("../src/pricingRecommendations");
const { buildHtmlReport } = require("../src/reportHtml");
const { buildSanityComparison, selectSanitySample } = require("../src/mmRateSanityCheck");
const { buildCalibrationUpdate } = require("../src/updateBrokerMarkupCalibration");
const { buildQualityAlerts } = require("../src/workflowQualityAlerts");
const { mergePayloads } = require("../src/mergeDiscovercarsResults");
const { parseArgs: parseChunkedArgs } = require("../src/runDiscovercarsChunked");
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
  assert.match(html, /top1_company/);
  assert.match(html, /top1_daily_rate/);
  assert.match(html, /MM Cars Rental \(8\.8\)/);
  assert.match(html, /mm-close/);
  assert.match(html, /50\.00 PLN\/day/);
});

runTest("buildHtmlReport marks MM Cars Rental when top2 is at least 5 PLN per day above MM top1", () => {
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

  assert.match(html, /class="mm mm-top1-gap">MM Cars Rental \(8\.8\)<\/td>/);
  assert.match(html, /class="mm mm-top1-gap">50\.00 PLN\/day<\/td>/);
});

runTest("buildPricingRecommendations raises MM top1 when top2 gap is at least 5 PLN per day", () => {
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

runTest("buildPricingRecommendations raises MM top1 when top2 gap is exactly 5 PLN per day", () => {
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
              { provider_name: "Flex To Go", total_price: 150, currency: "PLN", rental_days: 2 }
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
  assert.equal(output.recommendations[0].suggested_rate_pln_day, 74);
  assert.match(output.recommendations[0].reason, /co najmniej 5 PLN/);
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
  assert.equal(comparison.observed_broker_markup_multiplier, 1.33);
  assert.equal(comparison.live_mm_rank, "outside_top3");
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
        count: 2,
        average_multiplier: 1.1,
        average_markup_percent: 10,
        by_location: {
          Poznan: {
            count: 2,
            average_multiplier: 1.12,
            average_markup_percent: 12
          }
        },
        by_duration: {
          3: {
            count: 2,
            average_multiplier: 1.08,
            average_markup_percent: 8
          }
        }
      }
    },
    alpha: 0.5
  });

  assert.equal(output.learning.observation_count, 2);
  assert.equal(output.brokerMarkupCalibration.defaultMultiplier, 1.0875);
  assert.equal(output.brokerMarkupCalibration.locationMultipliers.Poznan, 1.105);
  assert.equal(output.brokerMarkupCalibration.durationMultipliers["3"], 1.08);
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

if (!process.exitCode) {
  console.log("All DiscoverCars tests passed.");
}
