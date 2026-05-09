const assert = require("node:assert/strict");

const { loadConfig } = require("../src/discovercars/config");
const { parseMoney, toCsv } = require("../src/discovercars/utils");
const { buildHtmlReport } = require("../src/reportHtml");

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
  assert.match(html, /MM Cars Rental \(8\.8\)/);
  assert.match(html, /mm-close/);
});

runTest("buildHtmlReport marks MM Cars Rental when top2 is over 5 PLN per day above MM top1", () => {
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
              { provider_name: "Alamo", provider_rating: 8.7, total_price: 112, currency: "PLN", rental_days: 2 }
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
  assert.match(html, /class="mm mm-top1-gap">100\.00 PLN<\/td>/);
});

if (!process.exitCode) {
  console.log("All DiscoverCars tests passed.");
}
