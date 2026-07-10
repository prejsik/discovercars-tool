const fs = require("fs");
const path = require("path");
const { loadPricingRules } = require("./pricingRules");
const { buildObservationKey, buildTop1RateSignalIndex } = require("./top1RateSignals");

const MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN = 10;
const PRICING_RULES = loadPricingRules();
const MM_TOP1_GAP_PRICE_PER_DAY_THRESHOLD_PLN = PRICING_RULES.top1GapThresholdPlnDay;
const MM_TOP1_GAP_20_PRICE_PER_DAY_THRESHOLD_PLN = 20;
const MM_TOP1_GAP_30_PRICE_PER_DAY_THRESHOLD_PLN = 30;

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

  const rentalDays = Number(offer.rental_days);
  const divisor = Number.isFinite(rentalDays) && rentalDays > 0 ? rentalDays : 1;
  return `${(Number(offer.total_price) / divisor).toFixed(2)} ${offer.currency || ""}/day`.trim();
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

function getMmTop1GapPerDay(mmOffer, rankedOffers) {
  if (!mmOffer || !Number.isFinite(Number(mmOffer.total_price)) || !isPlnOffer(mmOffer)) {
    return null;
  }

  const topOffers = Array.isArray(rankedOffers) ? rankedOffers.filter(Boolean) : [];
  const firstOffer = topOffers[0] || null;
  const secondOffer = topOffers[1] || null;
  if (!isMmCarsProvider(firstOffer?.provider_name) || !secondOffer || isMmCarsProvider(secondOffer.provider_name)) {
    return null;
  }

  if (!Number.isFinite(Number(secondOffer.total_price)) || !isSameCurrency(mmOffer, secondOffer)) {
    return null;
  }

  const priceDifference = Number(secondOffer.total_price) - Number(mmOffer.total_price);
  if (priceDifference <= 0) {
    return null;
  }

  const rentalDays = getRentalDaysForComparison(mmOffer, secondOffer);
  return priceDifference / rentalDays;
}

function getMmTop1GapState(mmOffer, rankedOffers) {
  const gapPerDay = getMmTop1GapPerDay(mmOffer, rankedOffers);
  if (!Number.isFinite(gapPerDay) || gapPerDay < MM_TOP1_GAP_PRICE_PER_DAY_THRESHOLD_PLN) {
    return null;
  }

  if (gapPerDay >= MM_TOP1_GAP_30_PRICE_PER_DAY_THRESHOLD_PLN) {
    return "top1-gap-30";
  }

  if (gapPerDay >= MM_TOP1_GAP_20_PRICE_PER_DAY_THRESHOLD_PLN) {
    return "top1-gap-20";
  }

  return "top1-gap";
}

function getMmClassName(offer, rankedOffers) {
  const top1GapState = getMmTop1GapState(offer, rankedOffers);
  if (top1GapState) {
    return `mm mm-${top1GapState}`;
  }

  if (isMmCloseToHigherRankedProvider(offer, rankedOffers)) {
    return "mm mm-close";
  }

  return "mm";
}

function buildProviderCell(offer, rankedOffers) {
  const text = formatProviderName(offer);
  if (!isMmCarsProvider(offer?.provider_name)) {
    return `<td>${escapeHtml(text)}</td>`;
  }

  return `<td class="${getMmClassName(offer, rankedOffers)}">${escapeHtml(text)}</td>`;
}

function buildMmPriceCell(mmOffer, rankedOffers) {
  if (!mmOffer) {
    return "<td class=\"muted\">Not available</td>";
  }

  return `<td class="${getMmClassName(mmOffer, rankedOffers)}">${escapeHtml(formatOfferPrice(mmOffer))}</td>`;
}

function buildTop1PriceCell(offer, signal) {
  const classes = signal?.is_high_rate ? "top1-high" : "";
  const title = signal?.is_high_rate
    ? `Top1 powyzej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzien.`
    : "";
  return `<td${classes ? ` class="${classes}"` : ""}${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(formatOfferPrice(offer))}</td>`;
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

function getOfferView(scenarioPayload, location, mode) {
  const legacy = scenarioPayload?.top_3_plus_mm_by_location?.[location] || {};
  const automatic = scenarioPayload?.offer_views_by_location?.[location]?.automatic || legacy;
  if (mode === "all") {
    return scenarioPayload?.offer_views_by_location?.[location]?.all || automatic;
  }
  return automatic;
}

function getMmState(view) {
  const top3 = Array.isArray(view?.top_3) ? view.top_3 : [];
  const mmOffer = view?.mm_cars_rental || null;
  const top1GapState = getMmTop1GapState(mmOffer, top3);
  return !mmOffer
    ? "missing"
    : top1GapState
      ? top1GapState
      : isMmCloseToHigherRankedProvider(mmOffer, top3)
        ? "close"
        : "normal";
}

function isTop1High(view) {
  const offer = view?.top_3?.[0] || null;
  const total = Number(offer?.total_price);
  const days = Number(offer?.rental_days) || 1;
  return Number.isFinite(total) && total / days > PRICING_RULES.top1HighRateThresholdPlnDay;
}

function viewSpan(mode, content, className = "", title = "") {
  const classes = [`offer-view`, `offer-view-${mode}`, className].filter(Boolean).join(" ");
  return `<span class="${classes}"${title ? ` title="${escapeHtml(title)}"` : ""}>${content}</span>`;
}

function buildDualCell(automaticContent, allContent, automaticClass = "", allClass = "", automaticTitle = "", allTitle = "") {
  return `<td class="view-cell">${viewSpan("automatic", automaticContent, automaticClass, automaticTitle)}${viewSpan("all", allContent, allClass, allTitle)}</td>`;
}

function providerContent(offer) {
  return escapeHtml(formatProviderName(offer));
}

function priceContent(offer) {
  return escapeHtml(formatOfferPrice(offer));
}

function mmRankLabel(view) {
  const rank = Number(view?.mm_provider_rank);
  if (Number.isFinite(rank) && rank > 0) {
    return `Top ${rank}`;
  }
  const top3 = Array.isArray(view?.top_3) ? view.top_3 : [];
  const legacyRank = top3.findIndex((offer) => isMmCarsProvider(offer?.provider_name));
  if (legacyRank >= 0) {
    return `Top ${legacyRank + 1}`;
  }
  return view?.mm_cars_rental ? "Poza Top3" : "Brak MM";
}

function cheaperOffersLabel(view) {
  const count = Number(view?.cheaper_offer_count);
  return Number.isFinite(count) && count >= 0 ? String(count) : "Brak danych";
}

function buildScenarioRows(rootPayload, scenarioPayload) {
  const locations = scenarioLocations(rootPayload, scenarioPayload);

  return locations
    .map((location, index) => {
      const automatic = getOfferView(scenarioPayload, location, "automatic");
      const all = getOfferView(scenarioPayload, location, "all");
      const automaticTop3 = Array.isArray(automatic?.top_3) ? automatic.top_3 : [];
      const allTop3 = Array.isArray(all?.top_3) ? all.top_3 : [];
      const automaticMm = automatic?.mm_cars_rental || null;
      const allMm = all?.mm_cars_rental || null;
      const rowClass = index % 2 === 0 ? "even" : "odd";
      const automaticHigh = isTop1High(automatic);
      const allHigh = isTop1High(all);
      const automaticTop1Title = automaticHigh ? `Top1 powyzej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzien.` : "";
      const allTop1Title = allHigh ? `Top1 powyzej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzien.` : "";

      return `<tr class="${rowClass}" data-location="${escapeHtml(location)}" data-mm-state-automatic="${getMmState(automatic)}" data-mm-state-all="${getMmState(all)}" data-top1-high-automatic="${automaticHigh}" data-top1-high-all="${allHigh}">
        <td class="index">${index}</td>
        <td class="location">${escapeHtml(location)}</td>
        ${buildDualCell(providerContent(automaticTop3[0]), providerContent(allTop3[0]), isMmCarsProvider(automaticTop3[0]?.provider_name) ? getMmClassName(automaticTop3[0], automaticTop3) : "", isMmCarsProvider(allTop3[0]?.provider_name) ? getMmClassName(allTop3[0], allTop3) : "")}
        ${buildDualCell(priceContent(automaticTop3[0]), priceContent(allTop3[0]), automaticHigh ? "top1-high" : "", allHigh ? "top1-high" : "", automaticTop1Title, allTop1Title)}
        ${buildDualCell(providerContent(automaticTop3[1]), providerContent(allTop3[1]), isMmCarsProvider(automaticTop3[1]?.provider_name) ? getMmClassName(automaticTop3[1], automaticTop3) : "", isMmCarsProvider(allTop3[1]?.provider_name) ? getMmClassName(allTop3[1], allTop3) : "")}
        ${buildDualCell(priceContent(automaticTop3[1]), priceContent(allTop3[1]))}
        ${buildDualCell(providerContent(automaticTop3[2]), providerContent(allTop3[2]), isMmCarsProvider(automaticTop3[2]?.provider_name) ? getMmClassName(automaticTop3[2], automaticTop3) : "", isMmCarsProvider(allTop3[2]?.provider_name) ? getMmClassName(allTop3[2], allTop3) : "")}
        ${buildDualCell(priceContent(automaticTop3[2]), priceContent(allTop3[2]))}
        ${buildDualCell(priceContent(automaticMm), priceContent(allMm), automaticMm ? getMmClassName(automaticMm, automaticTop3) : "muted", allMm ? getMmClassName(allMm, allTop3) : "muted")}
        ${buildDualCell(escapeHtml(mmRankLabel(automatic)), escapeHtml(mmRankLabel(all)), "rank-cell", "rank-cell")}
        ${buildDualCell(escapeHtml(cheaperOffersLabel(automatic)), escapeHtml(cheaperOffersLabel(all)), "count-cell", "count-cell")}
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

function summarizeApiDomMonitoring(payload, scenarios) {
  if (payload?.api_dom_monitoring) {
    return payload.api_dom_monitoring;
  }
  const summary = { comparison_count: 0, drift_count: 0, fallback_count: 0, adaptive_validation_triggered: false };
  for (const scenario of scenarios) {
    const item = scenario?.api_dom_monitoring;
    if (!item) continue;
    summary.comparison_count += Number(item.comparison_count || 0);
    summary.drift_count += Number(item.drift_count || 0);
    summary.fallback_count += Number(item.fallback_count || 0);
    summary.adaptive_validation_triggered ||= Boolean(item.adaptive_validation_triggered);
  }
  return summary;
}

function buildScenarioTable(rootPayload, scenarioPayload, index, total) {
  return `<section class="scenario" data-date="${escapeHtml(scenarioPayload.start_date || "")}" data-duration="${escapeHtml(scenarioPayload.rental_days || "")}">
    <h2>${escapeHtml(scenarioTitle(scenarioPayload, index, total))}</h2>
    <div class="period">${escapeHtml(scenarioPeriod(scenarioPayload))}</div>
    <table>
      <colgroup>
        <col class="col-index">
        <col class="col-location">
        <col class="col-company">
        <col class="col-rate">
        <col class="col-company">
        <col class="col-rate">
        <col class="col-company">
        <col class="col-rate">
        <col class="col-mm-rate">
        <col class="col-rank">
        <col class="col-count">
      </colgroup>
      <thead>
        <tr>
          <th>#</th>
          <th>Lokalizacja</th>
          <th>Top 1 firma</th>
          <th>Top 1 PLN/d</th>
          <th>Top 2 firma</th>
          <th>Top 2 PLN/d</th>
          <th>Top 3 firma</th>
          <th>Top 3 PLN/d</th>
          <th>MM PLN/d</th>
          <th>Pozycja MM</th>
          <th>Tańsze oferty</th>
        </tr>
      </thead>
      <tbody>
        ${buildScenarioRows(rootPayload, scenarioPayload)}
      </tbody>
    </table>
    ${buildErrorsHtml(scenarioPayload.errors)}
  </section>`;
}

function buildQualityBanner(quality) {
  if (!quality || quality.status === "success") {
    return "";
  }
  const alerts = Array.isArray(quality.alerts) ? quality.alerts.slice(0, 3).join(" ") : "";
  const message = quality.status === "failure"
    ? "Raport danych zostal opublikowany, ale nowy Excel zostal zablokowany przez kontrole jakosci."
    : "Raport zawiera ostrzezenia kontroli jakosci.";
  return `<div class="quality-banner quality-${escapeHtml(quality.status)}"><strong>${escapeHtml(message)}</strong>${alerts ? ` ${escapeHtml(alerts)}` : ""}</div>`;
}

function buildHtmlReport(payload, options = {}) {
  const scenarios = normalizeScenarios(payload);
  const top1SignalIndex = buildTop1RateSignalIndex(payload, PRICING_RULES);
  const generatedAt = payload.generated_at || new Date().toISOString();
  const locations = [...new Set(scenarios.flatMap((scenario) => scenarioLocations(payload, scenario)))].sort();
  const durations = [...new Set(scenarios.map((scenario) => Number(scenario.rental_days)).filter(Number.isFinite))].sort((a, b) => a - b);
  const locationChecks = scenarios.reduce((sum, scenario) => sum + scenarioLocations(payload, scenario).length, 0);
  const missingMm = scenarios.reduce((sum, scenario) => sum + scenarioLocations(payload, scenario).filter(
    (location) => !scenario?.top_3_plus_mm_by_location?.[location]?.mm_cars_rental
  ).length, 0);
  const errorCount = scenarios.reduce((sum, scenario) => sum + (scenario.errors || []).length, 0);
  const top1Signals = [...top1SignalIndex.values()];
  const highTop1Count = top1Signals.filter((signal) => signal.is_high_rate).length;
  const apiDom = summarizeApiDomMonitoring(payload, scenarios);

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
      --orange-bg: #d96b00;
      --orange-text: #ffffff;
      --magenta-bg: #a61e74;
      --magenta-text: #ffffff;
      --red-bg: #c62828;
      --red-text: #ffffff;
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

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: end;
      margin: 0 0 18px;
      padding: 12px 0;
      border-top: 1px solid #2d333b;
      border-bottom: 1px solid #2d333b;
    }

    .toolbar label { color: var(--muted); font-size: 12px; }
    .toolbar select, .toolbar input {
      display: block;
      margin-top: 4px;
      min-height: 34px;
      border: 1px solid #596273;
      border-radius: 4px;
      background: #11151b;
      color: var(--text);
      padding: 5px 8px;
    }

    .summary { color: var(--muted); margin-bottom: 14px; font-size: 13px; }

    .quality-banner {
      margin: 0 0 16px;
      padding: 10px 12px;
      border: 2px solid #f0a020;
      background: #3a2807;
      color: #fff1c7;
      font-size: 13px;
    }

    .quality-failure { border-color: #ff5c5c; background: #3b1010; color: #ffd6d6; }

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
      overflow-x: visible;
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
      table-layout: fixed;
    }

    col.col-index { width: 3%; }
    col.col-location { width: 16%; }
    col.col-company { width: 11%; }
    col.col-rate { width: 7%; }
    col.col-mm-rate { width: 8%; }
    col.col-rank { width: 8%; }
    col.col-count { width: 11%; }

    th, td {
      border: 2px solid var(--line);
      padding: 6px 7px;
      text-align: left;
      white-space: normal;
      vertical-align: middle;
      overflow-wrap: anywhere;
      line-height: 1.25;
    }

    th {
      color: var(--text);
      font-weight: 700;
      background: #111;
      font-size: 11px;
    }

    td {
      color: var(--green);
      font-weight: 700;
      font-size: 12px;
    }

    th:nth-child(4), th:nth-child(6), th:nth-child(8), th:nth-child(9), th:nth-child(10), th:nth-child(11),
    td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(9), td:nth-child(10), td:nth-child(11) {
      text-align: right;
      white-space: nowrap;
    }

    .view-cell { padding: 0; }
    .offer-view { display: block; padding: 6px 7px; min-height: 100%; }
    .offer-view-all { display: none; }
    body[data-offer-view="all"] .offer-view-automatic { display: none; }
    body[data-offer-view="all"] .offer-view-all { display: block; }
    .rank-cell, .count-cell { color: var(--text); }

    td.index {
      color: var(--text);
      text-align: center;
    }

    td.location {
      color: var(--green);
    }

    .mm {
      background: var(--yellow-bg);
      color: var(--yellow-text);
    }

    .mm-close {
      background: var(--red-bg);
      color: var(--red-text);
    }

    .mm-top1-gap {
      background: var(--blue-bg);
      color: var(--blue-text);
    }

    .mm-top1-gap-20 {
      background: var(--orange-bg);
      color: var(--orange-text);
    }

    .mm-top1-gap-30 {
      background: var(--magenta-bg);
      color: var(--magenta-text);
    }

    .top1-high {
      background: #7a1d1d;
      color: #ffffff;
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
      th, td { padding: 5px; }
      td { font-size: 11px; }
    }

    @media (max-width: 720px) {
      body { padding: 10px; }
      .scenario { margin-bottom: 26px; }
      table, tbody, tr, td { display: block; width: 100%; }
      table { border: 0; background: transparent; }
      colgroup, thead { display: none; }
      tbody { display: grid; gap: 10px; }
      tr { border: 1px solid var(--line); background: #0d0f12; }
      td, td.index,
      td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(9), td:nth-child(10), td:nth-child(11) {
        display: grid;
        grid-template-columns: minmax(92px, 38%) 1fr;
        gap: 8px;
        border: 0;
        border-bottom: 1px solid #3d434b;
        padding: 7px 9px;
        text-align: left;
        white-space: normal;
      }
      td:last-child { border-bottom: 0; }
      td::before { color: var(--muted); font-weight: 400; }
      td:nth-child(1)::before { content: "#"; }
      td:nth-child(2)::before { content: "Lokalizacja"; }
      td:nth-child(3)::before { content: "Top 1 firma"; }
      td:nth-child(4)::before { content: "Top 1 PLN/d"; }
      td:nth-child(5)::before { content: "Top 2 firma"; }
      td:nth-child(6)::before { content: "Top 2 PLN/d"; }
      td:nth-child(7)::before { content: "Top 3 firma"; }
      td:nth-child(8)::before { content: "Top 3 PLN/d"; }
      td:nth-child(9)::before { content: "MM PLN/d"; }
      td:nth-child(10)::before { content: "Pozycja MM"; }
      td:nth-child(11)::before { content: "Tańsze oferty"; }
    }
  </style>
</head>
<body data-offer-view="automatic">
  <h1>DiscoverCars report</h1>
  <div class="meta">Generated at: ${escapeHtml(generatedAt)} | Time zone: ${escapeHtml(payload.time_zone || "Europe/Warsaw")}</div>
  ${buildQualityBanner(options.quality)}
  <div class="summary">Scenariusze: ${scenarios.length} | sprawdzenia lokalizacji: ${locationChecks} | brak MM Cars Rental: ${missingMm} | błędy: ${errorCount} | Top1 &gt; ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/d: ${highTop1Count} | API-DOM: ${apiDom.drift_count || 0}/${apiDom.comparison_count || 0} rozjazdów${apiDom.adaptive_validation_triggered ? " (próba DOM zwiększona)" : ""}</div>
  <div class="legend">
    <span><span class="badge mm">MM Cars Rental</span> MM Cars Rental in table</span>
    <span><span class="badge mm mm-close">MM close</span> MM Cars Rental max 10 PLN/day more expensive than a higher-ranked competitor</span>
    <span><span class="badge mm mm-top1-gap">Top1: +5 PLN/d</span> Top 2 jest droższy od MM o min. 5 PLN/dzień</span>
    <span><span class="badge mm mm-top1-gap-20">Top1: +20 PLN/d</span> Top 2 jest droższy od MM o min. 20 PLN/dzień</span>
    <span><span class="badge mm mm-top1-gap-30">Top1: +30 PLN/d</span> Top 2 jest droższy od MM o min. 30 PLN/dzień</span>
    <span><span class="badge top1-high">Top1 &gt; 150</span> stawka Top1 przekracza 150 PLN/dzień</span>
  </div>
  <div class="toolbar">
    <label>Skrzynia<select id="filter-transmission"><option value="automatic">Tylko automaty</option><option value="all">Wszystkie auta</option></select></label>
    <label>Data<input id="filter-date" type="date"></label>
    <label>Lokalizacja<select id="filter-location"><option value="">Wszystkie</option>${locations.map((location) => `<option>${escapeHtml(location)}</option>`).join("")}</select></label>
    <label>Duration<select id="filter-duration"><option value="">Wszystkie</option>${durations.map((duration) => `<option value="${duration}">${duration} dni</option>`).join("")}</select></label>
    <label>Stan MM<select id="filter-state"><option value="">Wszystkie</option><option value="missing">Brak MM</option><option value="top1-gap">Top1: różnica 5–19,99 PLN/d</option><option value="top1-gap-20">Top1: różnica 20–29,99 PLN/d</option><option value="top1-gap-30">Top1: różnica min. 30 PLN/d</option><option value="close">Blisko wyższej pozycji</option><option value="normal">Pozostałe</option></select></label>
    <label>Kontrola Top1<select id="filter-top1"><option value="">Wszystkie</option><option value="high">Powyżej 150 PLN/d</option><option value="normal">Do 150 PLN/d</option></select></label>
  </div>
  ${scenarios.map((scenario, index) => buildScenarioTable(payload, scenario, index, scenarios.length)).join("\n")}
  <script>
    const transmissionControl = document.getElementById("filter-transmission");
    const controls = ["filter-date", "filter-location", "filter-duration", "filter-state", "filter-top1"].map((id) => document.getElementById(id));
    function applyFilters() {
      const offerView = transmissionControl.value;
      document.body.dataset.offerView = offerView;
      const date = controls[0].value;
      const location = controls[1].value;
      const duration = controls[2].value;
      const state = controls[3].value;
      const top1State = controls[4].value;
      for (const section of document.querySelectorAll(".scenario")) {
        const scenarioMatch = (!date || section.dataset.date === date) && (!duration || section.dataset.duration === duration);
        let visibleRows = 0;
        for (const row of section.querySelectorAll("tbody tr")) {
          const mmState = offerView === "all" ? row.dataset.mmStateAll : row.dataset.mmStateAutomatic;
          const top1High = offerView === "all" ? row.dataset.top1HighAll : row.dataset.top1HighAutomatic;
          const top1Match = !top1State || (top1State === "high" ? top1High === "true" : top1High !== "true");
          const visible = scenarioMatch && (!location || row.dataset.location === location) && (!state || mmState === state) && top1Match;
          row.hidden = !visible;
          if (visible) visibleRows += 1;
        }
        section.hidden = visibleRows === 0;
      }
    }
    transmissionControl.addEventListener("input", applyFilters);
    controls.forEach((control) => control.addEventListener("input", applyFilters));
  </script>
</body>
</html>`;
}

function writeHtmlReport(payload, outputPath, options = {}) {
  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buildHtmlReport(payload, options), "utf8");
  return targetPath;
}

function generateReportFromFile(inputPath, outputPath, options = {}) {
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  return writeHtmlReport(payload, outputPath, options);
}

if (require.main === module) {
  const inputPath = process.argv[2] || "output/results-latest.json";
  const outputPath = process.argv[3] || "output/report.html";
  const qualityArg = process.argv.find((arg) => arg.startsWith("--quality="));
  const qualityPath = qualityArg ? qualityArg.slice("--quality=".length) : null;
  const quality = qualityPath && fs.existsSync(qualityPath)
    ? JSON.parse(fs.readFileSync(qualityPath, "utf8"))
    : null;
  const writtenPath = generateReportFromFile(inputPath, outputPath, { quality });
  console.log(`HTML report saved to ${writtenPath}`);
}

module.exports = {
  buildHtmlReport,
  generateReportFromFile,
  writeHtmlReport
};
