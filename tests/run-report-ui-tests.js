const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { buildHtmlReport } = require("../src/reportHtml");

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T09:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function buildFixture() {
  const locations = ["Warsaw Chopin Airport (WAW)", "Warsaw Train Station"];
  const durations = [2, 5, 7];
  const scenarios = Array.from({ length: 30 }, (_, index) => {
    const start = new Date(Date.UTC(2026, 7, 16 + Math.floor(index / durations.length)));
    const startDate = start.toISOString().slice(0, 10);
    const rentalDays = durations[index % durations.length];
    const byLocation = Object.fromEntries(locations.map((location, locationIndex) => {
      const top1 = { provider_name: "Competitor", total_price: (90 + locationIndex) * rentalDays, currency: "PLN", rental_days: rentalDays };
      const mm = { provider_name: "MM Cars Rental", total_price: (100 + locationIndex) * rentalDays, currency: "PLN", rental_days: rentalDays };
      return [location, { top_3: [top1, mm], mm_cars_rental: mm }];
    }));
    return {
      start_date: startDate,
      pickup_date: `${startDate}T09:00:00.000Z`,
      dropoff_date: addDays(startDate, rentalDays),
      rental_days: rentalDays,
      top_3_plus_mm_by_location: byLocation
    };
  });

  return {
    generated_at: "2026-08-08T06:00:00.000Z",
    time_zone: "Europe/Warsaw",
    locations,
    scenarios
  };
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-report-ui-"));
  const reportPath = path.join(tempDir, "report.html");
  fs.writeFileSync(reportPath, buildHtmlReport(buildFixture()), "utf8");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    await page.goto(pathToFileURL(reportPath).href);

    assert.equal(await page.locator(".scenario:visible").count(), 5);
    assert.equal(await page.locator("#report-filters").getAttribute("hidden"), "");
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);

    await page.locator("#toggle-filters").click();
    for (const id of ["filter-location", "filter-duration", "filter-state", "filter-top1"]) {
      await page.locator(`#${id}`).evaluate((element) => { element.open = true; });
      const bounds = await page.locator(`#${id} .multi-options`).boundingBox();
      assert.ok(bounds.x >= 0, `${id} opens left of the viewport`);
      assert.ok(bounds.x + bounds.width <= 390, `${id} opens right of the viewport`);
    }
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);

    await page.selectOption("#filter-transmission", "automatic");
    await page.fill("#filter-date-from", "2026-08-20");
    await page.locator("#filter-duration input").evaluateAll((inputs) => {
      const input = inputs.find((item) => item.value === "5");
      input.checked = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.match(page.url(), /view=automatic/);
    assert.match(page.url(), /from=2026-08-20/);
    assert.match(page.url(), /days=5/);

    await page.reload();
    assert.equal(await page.locator("#filter-transmission").inputValue(), "automatic");
    assert.equal(await page.locator("#filter-date-from").inputValue(), "2026-08-20");
    assert.equal(await page.locator("#filter-duration input[value='5']").isChecked(), true);
    assert.equal(await page.locator("#toggle-filters").innerText(), "Pokaż filtry: lotniska · 3 filtry");

    await page.locator("#toggle-filters").click();
    await page.locator("#reset-filters").click();
    assert.equal(await page.locator(".scenario:visible").count(), 5);
    assert.equal(new URL(page.url()).search, "");

    await page.locator("#filter-date-from").evaluate((input) => {
      input.value = "2030-01-01";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.locator("#empty-state").isVisible(), true);
    assert.equal(await page.locator("#load-more").isVisible(), false);

    await page.locator("#reset-filters").click();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.reload();
    assert.equal(await page.locator(".scenario:visible").count(), 5);
    assert.equal(await page.locator("#report-filters").getAttribute("hidden"), "");
    assert.equal(await page.locator("tbody tr").first().evaluate((row) => getComputedStyle(row).display), "block");
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => document.querySelectorAll(".scenario:not([hidden])").length === 20);
    assert.equal(await page.locator(".scenario:visible").count(), 20);
    assert.equal(await page.locator("#report-filters").isVisible(), true);
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true);
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log("All DiscoverCars report UI tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
