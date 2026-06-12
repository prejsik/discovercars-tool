const assert = require("node:assert/strict");

const { loadConfig } = require("../src/discovercars/config");
const { parseMoney, toCsv } = require("../src/discovercars/utils");
const { mergePricingRecommendations } = require("../src/mergePricingRecommendations");
const { buildPricingRecommendations } = require("../src/pricingRecommendations");
const { buildHtmlReport } = require("../src/reportHtml");
const { buildQualityAlerts } = require("../src/workflowQualityAlerts");

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

if (!process.exitCode) {
  console.log("All DiscoverCars tests passed.");
}
