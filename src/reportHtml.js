const fs = require("fs");
const path = require("path");

const MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN = 10;

function normalizeProviderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function isMmCarsProvider(value) {
  return normalizeProviderName(value).includes("mm cars rental");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatProviderRating(rating) {
  const numeric = Number(rating);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }

  return numeric.toFixed(1).replace(/\.0$/, "");
}

function formatProviderName(offer) {
  if (!offer) {
    return "Not available";
  }

  const providerName = String(offer.provider_name || "Not available").trim() || "Not available";
  const rating = formatProviderRating(offer.provider_rating);
  return rating ? `${providerName} (${rating})` : providerName;
}

function formatOfferPrice(offer) {
  if (!offer || !Number.isFinite(Number(offer.total_price))) {
    return "Not available";
  }

  return `${Number(offer.total_price).toFixed(2)} ${offer.currency || ""}`.trim();
}

function isSameCurrency(left, right) {
  return String(left?.currency || "").trim().toUpperCase() === String(right?.currency || "").trim().toUpperCase();
}

function isPlnOffer(offer) {
  return String(offer?.currency || "").trim().toUpperCase() === "PLN";
}

function getRentalDaysForComparison(mmOffer, higherRankedOffer) {
  const candidates = [mmOffer?.rental_days, higherRankedOffer?.rental_days]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  return candidates[0] || 1;
}

function isMmCloseToHigherRankedProvider(mmOffer, rankedOffers) {
  if (!mmOffer || !Number.isFinite(Number(mmOffer.total_price)) || !isPlnOffer(mmOffer)) {
    return false;
  }

  const topOffers = Array.isArray(rankedOffers) ? rankedOffers.filter(Boolean) : [];
  const mmRankIndex = topOffers.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  const higherRankedOffers = (mmRankIndex >= 0 ? topOffers.slice(0, mmRankIndex) : topOffers)
    .filter((offer) => offer && !isMmCarsProvider(offer.provider_name));

  for (const higherRankedOffer of higherRankedOffers) {
    if (!Number.isFinite(Number(higherRankedOffer.total_price)) || !isSameCurrency(mmOffer, higherRankedOffer)) {
      continue;
    }

    const priceDifference = Number(mmOffer.total_price) - Number(higherRankedOffer.total_price);
    if (priceDifference <= 0) {
      continue;
    }

    const rentalDays = getRentalDaysForComparison(mmOffer, higherRankedOffer);
    if (priceDifference / rentalDays <= MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN) {
      return true;
    }
  }

  return false;
}

function buildProviderCell(offer, rankedOffers) {
  const text = formatProviderName(offer);
  if (!isMmCarsProvider(offer?.provider_name)) {
    return `<td>${escapeHtml(text)}</td>`;
  }

  const className = isMmCloseToHigherRankedProvider(offer, rankedOffers) ? "mm mm-close" : "mm";
  return `<td class="${className}">${escapeHtml(text)}</td>`;
}

function buildMmPriceCell(mmOffer, rankedOffers) {
  if (!mmOffer) {
    return "<td class=\"muted\">Not available</td>";
  }

  const className = isMmCloseToHigherRankedProvider(mmOffer, rankedOffers) ? "mm mm-close" : "mm";
  return `<td class="${className}">${escapeHtml(formatOfferPrice(mmOffer))}</td>`;
}

function scenarioLocations(rootPayload, scenarioPayload) {
  const rootLocations = Array.isArray(rootPayload.locations) ? rootPayload.locations : [];
  if (rootLocations.length) {
    return rootLocations;
  }

  return Object.keys(scenarioPayload.top_3_plus_mm_by_location || {}).sort((a, b) => a.localeCompare(b));
}

function scenarioTitle(scenarioPayload, index, total) {
  const label = scenarioPayload.start_day_label || scenarioPayload.start_date || scenarioPayload.scenario_id || "Scenario";
  return `Scenario ${index + 1}/${total}: ${label} + ${scenarioPayload.rental_days} day(s)`;
}

function scenarioPeriod(scenarioPayload) {
  const pickup = scenarioPayload.pickup_date || "";
  const dropoff = scenarioPayload.dropoff_date || "";
  const rentalDays = scenarioPayload.rental_days || "";
  return `${pickup} -> ${dropoff} (rental_days=${rentalDays})`;
}

function buildScenarioRows(rootPayload, scenarioPayload) {
  const locations = scenarioLocations(rootPayload, scenarioPayload);
  const tableData = scenarioPayload.top_3_plus_mm_by_location || {};

  return locations
    .map((location, index) => {
      const locationData = tableData[location] || {};
      const top3 = Array.isArray(locationData.top_3) ? locationData.top_3 : [];
      const mmOffer = locationData.mm_cars_rental || null;
      const rowClass = index % 2 === 0 ? "even" : "odd";

      return `<tr class="${rowClass}">
        <td class="index">${index}</td>
        <td class="location">${escapeHtml(location)}</td>
        ${buildProviderCell(top3[0], top3)}
        <td>${escapeHtml(formatOfferPrice(top3[0]))}</td>
        ${buildProviderCell(top3[1], top3)}
        <td>${escapeHtml(formatOfferPrice(top3[1]))}</td>
        ${buildProviderCell(top3[2], top3)}
        <td>${escapeHtml(formatOfferPrice(top3[2]))}</td>
        ${buildMmPriceCell(mmOffer, top3)}
      </tr>`;
    })
    .join("\n");
}

function buildErrorsHtml(errors) {
  if (!Array.isArray(errors) || !errors.length) {
    return "";
  }

  const items = errors
    .map((error) => `<li><strong>${escapeHtml(error.location || "Unknown")}:</strong> ${escapeHtml(error.error || error.message || error)}</li>`)
    .join("\n");

  return `<details class="errors"><summary>Errors (${errors.length})</summary><ul>${items}</ul></details>`;
}

function normalizeScenarios(payload) {
  return Array.isArray(payload.scenarios) && payload.scenarios.length ? payload.scenarios : [payload];
}

function buildScenarioTable(rootPayload, scenarioPayload, index, total) {
  return `<section class="scenario">
    <h2>${escapeHtml(scenarioTitle(scenarioPayload, index, total))}</h2>
    <div class="period">${escapeHtml(scenarioPeriod(scenarioPayload))}</div>
    <table>
      <thead>
        <tr>
          <th>(index)</th>
          <th>location</th>
          <th>top1_company</th>
          <th>top1_price</th>
          <th>top2_company</th>
          <th>top2_price</th>
          <th>top3_company</th>
          <th>top3_price</th>
          <th>mm_cars_rental_price</th>
        </tr>
      </thead>
      <tbody>
        ${buildScenarioRows(rootPayload, scenarioPayload)}
      </tbody>
    </table>
    ${buildErrorsHtml(scenarioPayload.errors)}
  </section>`;
}

function buildHtmlReport(payload) {
  const scenarios = normalizeScenarios(payload);
  const generatedAt = payload.generated_at || new Date().toISOString();

  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DiscoverCars report</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #11151b;
      --line: #d7d7d7;
      --text: #e9edf2;
      --muted: #9aa4b2;
      --green: #22e642;
      --yellow-bg: #caa300;
      --yellow-text: #253040;
      --blue-bg: #1e5bd7;
      --blue-text: #ffffff;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
      padding: 24px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 22px;
      font-weight: 700;
    }

    .meta {
      color: var(--muted);
      margin-bottom: 24px;
      font-size: 13px;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 24px;
      color: var(--muted);
      font-size: 13px;
    }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: 700;
    }

    .scenario {
      margin: 0 0 34px;
      padding-top: 8px;
      border-top: 2px solid #2d333b;
    }

    h2 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 700;
    }

    .period {
      color: var(--text);
      margin-bottom: 8px;
      font-size: 14px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #0d0f12;
      border: 2px solid var(--line);
      table-layout: auto;
    }

    th, td {
      border: 2px solid var(--line);
      padding: 8px 11px;
      text-align: left;
      white-space: nowrap;
      vertical-align: middle;
    }

    th {
      color: var(--text);
      font-weight: 700;
      background: #111;
    }

    td {
      color: var(--green);
      font-weight: 700;
    }

    td.index {
      color: var(--text);
      width: 72px;
    }

    td.location {
      color: var(--green);
    }

    .mm {
      background: var(--yellow-bg);
      color: var(--yellow-text);
    }

    .mm-close {
      background: var(--blue-bg);
      color: var(--blue-text);
    }

    .muted {
      color: var(--muted);
    }

    .errors {
      margin-top: 10px;
      color: #ffb4a9;
    }

    @media (max-width: 1100px) {
      body { padding: 14px; }
      .scenario { overflow-x: auto; }
      table { min-width: 1120px; }
    }
  </style>
</head>
<body>
  <h1>DiscoverCars report</h1>
  <div class="meta">Generated at: ${escapeHtml(generatedAt)} | Time zone: ${escapeHtml(payload.time_zone || "Europe/Warsaw")}</div>
  <div class="legend">
    <span><span class="badge mm">MM Cars Rental</span> MM Cars Rental in table</span>
    <span><span class="badge mm mm-close">MM close</span> MM Cars Rental max 10 PLN/day more expensive than a higher-ranked competitor</span>
  </div>
  ${scenarios.map((scenario, index) => buildScenarioTable(payload, scenario, index, scenarios.length)).join("\n")}
</body>
</html>`;
}

function writeHtmlReport(payload, outputPath) {
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildHtmlReport(payload), "utf8");
  return targetPath;
}

function generateReportFromFile(inputPath, outputPath) {
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  return writeHtmlReport(payload, outputPath);
}

if (require.main === module) {
  const inputPath = process.argv[2] || "output/results-latest.json";
  const outputPath = process.argv[3] || "output/report.html";
  const writtenPath = generateReportFromFile(inputPath, outputPath);
  console.log(`HTML report saved to ${writtenPath}`);
}

module.exports = {
  buildHtmlReport,
  generateReportFromFile,
  writeHtmlReport
};
