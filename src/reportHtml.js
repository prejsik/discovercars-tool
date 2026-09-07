const fs = require("fs");
const path = require("path");
const { loadPricingRules } = require("./pricingRules");
const { buildPublicResultsPayload } = require("./publicResults");

const MM_CLOSE_PRICE_PER_DAY_THRESHOLD_PLN = 10;
const PRICING_RULES = loadPricingRules();
const MM_TOP1_GAP_PRICE_PER_DAY_THRESHOLD_PLN = PRICING_RULES.top1GapThresholdPlnDay;
const MM_TOP1_GAP_20_PRICE_PER_DAY_THRESHOLD_PLN = 20;
const MM_TOP1_GAP_30_PRICE_PER_DAY_THRESHOLD_PLN = 30;
const REPORT_TIME_ZONE = "Europe/Warsaw";
const INITIAL_SCENARIO_LIMIT = 20;
const COMPACT_LAYOUT_MAX_WIDTH = 1220;
const DAILY_RATE_FORMATTER = new Intl.NumberFormat("pl-PL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const DATE_TIME_FORMATTERS = new Map();

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
    return "Brak oferty";
  }

  const providerName = String(offer.provider_name || "Brak oferty").trim() || "Brak oferty";
  const rating = formatProviderRating(offer.provider_rating);
  return rating ? `${providerName} (${rating})` : providerName;
}

function formatOfferPrice(offer) {
  if (!offer || !Number.isFinite(Number(offer.total_price))) {
    return "Brak oferty";
  }

  const rentalDays = Number(offer.rental_days);
  const divisor = Number.isFinite(rentalDays) && rentalDays > 0 ? rentalDays : 1;
  const dailyRate = DAILY_RATE_FORMATTER.format(Number(offer.total_price) / divisor);
  return `${dailyRate} ${offer.currency || ""}/d`.trim();
}

function polishPlural(value, one, few, many) {
  const number = Math.abs(Number(value));
  if (number === 1) {
    return one;
  }
  const lastDigit = number % 10;
  const lastTwoDigits = number % 100;
  return lastDigit >= 2 && lastDigit <= 4 && !(lastTwoDigits >= 12 && lastTwoDigits <= 14)
    ? few
    : many;
}

function formatDaysLabel(value) {
  const days = Number(value);
  if (!Number.isFinite(days)) {
    return "brak danych";
  }
  return `${days} ${polishPlural(days, "dzień", "dni", "dni")}`;
}

function formatDateTime(value, timeZone = REPORT_TIME_ZONE) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    const [year, month, day] = String(value).split("-");
    return `${day}.${month}.${year}`;
  }
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return String(value || "Brak daty");
  }
  if (!DATE_TIME_FORMATTERS.has(timeZone)) {
    DATE_TIME_FORMATTERS.set(timeZone, new Intl.DateTimeFormat("pl-PL", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }));
  }
  return DATE_TIME_FORMATTERS.get(timeZone).format(date).replace(",", "");
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
    return "<td class=\"muted\">Brak oferty</td>";
  }

  return `<td class="${getMmClassName(mmOffer, rankedOffers)}">${escapeHtml(formatOfferPrice(mmOffer))}</td>`;
}

function buildTop1PriceCell(offer, signal) {
  const classes = signal?.is_high_rate ? "top1-high" : "";
  const title = signal?.is_high_rate
    ? `Top1 powyżej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzień.`
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

function scenarioTitle(scenarioPayload) {
  const pickup = scenarioPayload.pickup_date || scenarioPayload.start_date || scenarioPayload.scenario_id || "";
  const dropoff = scenarioPayload.dropoff_date || "";
  const period = dropoff
    ? `${formatDateTime(pickup)} → ${formatDateTime(dropoff)}`
    : formatDateTime(pickup);
  return `${period} · ${formatDaysLabel(scenarioPayload.rental_days)}`;
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

function statusTitleForClass(className) {
  const classes = String(className || "").split(/\s+/);
  if (classes.includes("mm-top1-gap-30")) {
    return "MM Cars Rental jest Top1; kolejna firma jest droższa o co najmniej 30 PLN/d.";
  }
  if (classes.includes("mm-top1-gap-20")) {
    return "MM Cars Rental jest Top1; kolejna firma jest droższa o 20-29,99 PLN/d.";
  }
  if (classes.includes("mm-top1-gap")) {
    return "MM Cars Rental jest Top1; kolejna firma jest droższa o 10-19,99 PLN/d.";
  }
  if (classes.includes("mm-close")) {
    return "MM Cars Rental jest do 10 PLN/d od wyższej pozycji.";
  }
  if (classes.includes("mm")) {
    return "Oferta MM Cars Rental.";
  }
  return "";
}

function viewSpan(mode, content, className = "", title = "") {
  const classes = [`offer-view`, `offer-view-${mode}`, className].filter(Boolean).join(" ");
  const resolvedTitle = title || statusTitleForClass(className);
  const titleAttributes = resolvedTitle
    ? ` title="${escapeHtml(resolvedTitle)}" aria-label="${content}. ${escapeHtml(resolvedTitle)}"`
    : "";
  return `<span class="${classes}"${titleAttributes}>${content}</span>`;
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

function isAirportLocation(location) {
  return /airport|lotnisko/i.test(String(location || ""));
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
      const automaticTop1Title = automaticHigh ? `Top1 powyżej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzień.` : "";
      const allTop1Title = allHigh ? `Top1 powyżej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzień.` : "";

      return `<tr class="${rowClass}" data-location="${escapeHtml(location)}" data-location-type="${isAirportLocation(location) ? "airport" : "branch"}" data-mm-state-automatic="${getMmState(automatic)}" data-mm-state-all="${getMmState(all)}" data-top1-high-automatic="${automaticHigh}" data-top1-high-all="${allHigh}">
        <td class="index">${index + 1}</td>
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

function buildReportView(view) {
  const top3 = Array.isArray(view?.top_3) ? view.top_3 : [];
  const mmOffer = view?.mm_cars_rental || null;
  const top1High = isTop1High(view);
  const top1Title = top1High ? `Top1 powyżej ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/dzień.` : "";

  return [
    formatProviderName(top3[0]),
    isMmCarsProvider(top3[0]?.provider_name) ? getMmClassName(top3[0], top3) : "",
    formatOfferPrice(top3[0]),
    top1High ? "top1-high" : "",
    top1Title,
    formatProviderName(top3[1]),
    isMmCarsProvider(top3[1]?.provider_name) ? getMmClassName(top3[1], top3) : "",
    formatOfferPrice(top3[1]),
    formatProviderName(top3[2]),
    isMmCarsProvider(top3[2]?.provider_name) ? getMmClassName(top3[2], top3) : "",
    formatOfferPrice(top3[2]),
    formatOfferPrice(mmOffer),
    mmOffer ? getMmClassName(mmOffer, top3) : "muted",
    mmRankLabel(view),
    cheaperOffersLabel(view),
    getMmState(view),
    top1High
  ];
}

function buildReportData(payload) {
  const publicPayload = buildPublicResultsPayload(payload);
  return {
    locations: publicPayload.locations,
    scenarios: publicPayload.scenarios.map((scenario) => ({
      date: scenario.start_date || "",
      duration: String(scenario.rental_days ?? ""),
      title: scenarioTitle(scenario),
      rows: scenarioLocations(publicPayload, scenario).map((location) => [
        location,
        isAirportLocation(location) ? "airport" : "branch",
        buildReportView(getOfferView(scenario, location, "automatic")),
        buildReportView(getOfferView(scenario, location, "all"))
      ]),
      errors: scenario.errors || []
    }))
  };
}

function serializeInlineJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function buildErrorsHtml(errors) {
  if (!Array.isArray(errors) || !errors.length) {
    return "";
  }

  const items = errors
    .map((error) => `<li><strong>${escapeHtml(error.location || "Nieznana lokalizacja")}:</strong> ${escapeHtml(error.error || error.message || error)}</li>`)
    .join("\n");

  return `<details class="errors"><summary>Błędy (${errors.length})</summary><ul>${items}</ul></details>`;
}

function normalizeScenarios(payload) {
  return Array.isArray(payload.scenarios) ? payload.scenarios : [payload];
}

function buildScenarioTable(rootPayload, scenarioPayload) {
  const title = scenarioTitle(scenarioPayload);
  return `<section class="scenario" data-date="${escapeHtml(scenarioPayload.start_date || "")}" data-duration="${escapeHtml(scenarioPayload.rental_days || "")}">
    <h2>${escapeHtml(title)}</h2>
    <table aria-label="Porównanie cen: ${escapeHtml(title)}">
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
          <th scope="col">#</th>
          <th scope="col">Lokalizacja</th>
          <th scope="col">Top 1 firma</th>
          <th scope="col">Top 1 PLN/d</th>
          <th scope="col">Top 2 firma</th>
          <th scope="col">Top 2 PLN/d</th>
          <th scope="col">Top 3 firma</th>
          <th scope="col">Top 3 PLN/d</th>
          <th scope="col">MM PLN/d</th>
          <th scope="col" title="Pozycja MM Cars Rental w rankingu firm">Pozycja MM</th>
          <th scope="col" title="Liczba pojedynczych ofert tańszych od oferty MM Cars Rental">Tańsze oferty</th>
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
  const alertSource = quality.status === "failure"
    ? quality.blocking_alerts
    : quality.alerts;
  const alerts = Array.isArray(alertSource)
    ? alertSource
      .filter((item) => !/API-DOM|kontrola DOM|Brak MM Cars Rental dla/i.test(String(item)))
      .map((item) => String(item).replace(/^Validation WARNING:\s*/i, "")
        .replace("Pominiete rekomendacje", "Pominięte rekomendacje")
        .replace("Cele rankingowe nieosiagalne po finalnej stawce", "Nieosiągalne cele rankingowe po zastosowaniu końcowej stawki")
        .replace("Sprzeczne rekomendacje w przedziale duration", "Sprzeczne rekomendacje w przedziale długości najmu")
        .replace("Sanity check MM:", "Kontrola stawek MM:")
        .replace("probek przekracza prog", "próbek przekracza próg")
        .replaceAll("PLN/dzien", "PLN/dzień")
        .replace("roznica", "różnica")
        .replace("powod", "powód")
        .replace("live_rate_changed_since_full_scrape", "cena zmieniła się od pełnego pomiaru")
        .replace("baseline_markup_outside_allowed_range", "narzut poza dopuszczalnym zakresem"))
    : [];
  const message = quality.status === "failure"
    ? "Raport danych został opublikowany, ale nowy Excel zablokowała kontrola jakości."
    : "Raport zawiera ostrzeżenia kontroli jakości.";
  return `<div class="quality-banner quality-${escapeHtml(quality.status)}" role="status"><strong>${escapeHtml(message)}</strong>${alerts.length ? `<details${quality.status === "failure" ? " open" : ""}><summary>Szczegóły (${alerts.length})</summary><ul>${alerts.map((alert) => `<li>${escapeHtml(alert)}</li>`).join("")}</ul></details>` : ""}</div>`;
}

function buildMultiFilter(id, label, options, allLabel = "Wszystkie") {
  const optionHtml = options.map((option) => `<label class="multi-option"><input type="checkbox" value="${escapeHtml(option.value)}"><span>${escapeHtml(option.label)}</span></label>`).join("");
  return `<div class="filter-field"><span class="filter-label" id="${escapeHtml(id)}-label">${escapeHtml(label)}</span><details class="multi-filter" id="${escapeHtml(id)}" data-all-label="${escapeHtml(allLabel)}" aria-labelledby="${escapeHtml(id)}-label"><summary>${escapeHtml(allLabel)}</summary><div class="multi-options t-dropdown">${optionHtml}</div></details></div>`;
}

function buildHtmlReport(payload, options = {}) {
  const reportData = buildReportData(payload);
  const scenarios = reportData.scenarios;
  const generatedAt = payload.generated_at || new Date().toISOString();
  const timeZone = payload.time_zone || REPORT_TIME_ZONE;
  const scenarioDates = scenarios
    .map((scenario) => scenario.date)
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")))
    .sort();
  const minStartDate = scenarioDates[0] || "";
  const maxStartDate = scenarioDates[scenarioDates.length - 1] || "";
  const locations = [...reportData.locations].sort();
  const durations = [...new Set(scenarios.map((scenario) => Number(scenario.duration)).filter(Number.isFinite))].sort((a, b) => a - b);
  const locationChecks = scenarios.reduce((sum, scenario) => sum + scenario.rows.length, 0);
  const missingMm = scenarios.reduce((sum, scenario) => sum + scenario.rows.filter((row) => row[2][15] === "missing").length, 0);
  const errorCount = scenarios.reduce((sum, scenario) => sum + (scenario.errors || []).length, 0);
  const highTop1Count = scenarios.reduce((sum, scenario) => sum + scenario.rows.filter((row) => row[2][16]).length, 0);
  const locationOptions = locations.map((location) => ({ value: location, label: location }));
  const durationOptions = durations.map((duration) => ({ value: String(duration), label: formatDaysLabel(duration) }));
  const mmStateOptions = [
    { value: "missing", label: "Brak MM" },
    { value: "top1-gap", label: "Top1: różnica 10–19,99 PLN/d" },
    { value: "top1-gap-20", label: "Top1: różnica 20–29,99 PLN/d" },
    { value: "top1-gap-30", label: "Top1: różnica min. 30 PLN/d" },
    { value: "close", label: "Do 10 PLN/d od wyższej pozycji" },
    { value: "normal", label: "Pozostałe" }
  ];
  const top1Options = [
    { value: "high", label: "Powyżej 150 PLN/d" },
    { value: "normal", label: "Do 150 PLN/d" }
  ];
  return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kontrola cen DiscoverCars</title>
  <link rel="icon" href="data:,">
  <style>
    :root {
      --bg: #0c1015;
      --panel: #121820;
      --panel-raised: #18212b;
      --line: #34404d;
      --text: #edf2f7;
      --muted: #a9b4c0;
      --focus: #79b8ff;
      --yellow-bg: #caa300;
      --yellow-text: #253040;
      --blue-bg: #1e5bd7;
      --blue-text: #ffffff;
      --orange-bg: #a44800;
      --orange-text: #ffffff;
      --magenta-bg: #a61e74;
      --magenta-text: #ffffff;
      --red-bg: #c62828;
      --red-text: #ffffff;
      color-scheme: dark;
      --dropdown-open-dur: 200ms;
      --dropdown-pre-scale: 0.97;
      --dropdown-ease: cubic-bezier(0.22, 1, 0.36, 1);
      --toast-open: 200ms;
      --toast-close: 150ms;
      --toast-distance: 4px;
      --toast-blur: 0px;
      --toast-scale: 1;
      --toast-ease: cubic-bezier(0.22, 1, 0.36, 1);
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Arial, sans-serif;
      padding: 24px;
      font-variant-numeric: tabular-nums;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      font-weight: 700;
    }

    .meta {
      flex-basis: 100%;
      color: var(--muted);
      margin-bottom: 18px;
      font-size: 13px;
    }

    .legend-panel {
      margin: 0 0 14px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
    }

    .legend-panel > summary {
      cursor: pointer;
      padding: 9px 12px;
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 0 12px 12px;
      color: var(--muted);
      font-size: 13px;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: end;
      margin: 0 0 18px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: rgba(12, 16, 21, 0.94);
      position: sticky;
      top: 0;
      z-index: 15;
      backdrop-filter: blur(8px);
    }

    .toolbar > label, .filter-label { color: var(--muted); font-size: 12px; }
    .toolbar select, .toolbar input[type="date"], .multi-filter > summary {
      display: block;
      margin-top: 4px;
      min-height: 36px;
      border: 1px solid #596273;
      border-radius: 4px;
      background: var(--panel);
      color: var(--text);
      padding: 6px 8px;
    }

    button {
      min-height: 36px;
      border: 1px solid #667284;
      border-radius: 4px;
      background: var(--panel-raised);
      color: var(--text);
      padding: 7px 12px;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    button:hover { background: #243140; }
    button:disabled { cursor: default; opacity: 0.55; }

    :focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }

    .filter-field { min-width: 130px; }
    .filter-label { display: block; }
    .multi-filter { position: relative; margin-top: 4px; }
    .multi-filter > summary {
      min-width: 130px;
      cursor: pointer;
      list-style: none;
      line-height: 22px;
    }
    .multi-filter > summary::-webkit-details-marker { display: none; }
    .multi-filter > summary::after { content: "▾"; float: right; margin-left: 12px; }
    .multi-filter[open] > summary::after { content: "▴"; }
    .multi-options {
      position: absolute;
      z-index: 20;
      top: calc(100% + 4px);
      left: 0;
      min-width: 220px;
      max-width: 340px;
      max-height: 280px;
      overflow-y: auto;
      border: 1px solid #596273;
      border-radius: 4px;
      background: var(--panel);
      box-shadow: 0 8px 20px #00000066;
      padding: 6px;
    }
    .multi-option {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 7px 6px;
      color: var(--text);
      font-size: 12px;
      cursor: pointer;
    }
    .multi-option:hover { background: #242b35; }
    .multi-option input { flex: 0 0 auto; margin: 1px 0 0; }

    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      color: var(--muted);
      margin-bottom: 14px;
      font-size: 13px;
    }

    .summary strong { color: var(--text); }
    .summary-label { flex-basis: 100%; color: var(--text); font-weight: 600; }
    .report-range { display: block; margin-top: 5px; }
    .date-error { color: #ffb4a9; margin: 0 0 14px; font-size: 14px; }
    input[aria-invalid="true"] { border-color: #ffb4a9 !important; }
    .empty-state p { margin-top: 0; }
    .view-feedback { position: fixed; bottom: 20px; right: 20px; z-index: 30; max-width: min(420px, calc(100vw - 40px)); padding: 12px 16px; background: #173627; border: 1px solid #56886a; border-radius: 4px; font-size: 14px; color: #dcfce7; pointer-events: none; }
    .copy-fallback { margin-bottom: 14px; }
    .copy-fallback input { width: 100%; padding: 10px; color: var(--text); background: var(--panel); border: 1px solid var(--line); }
    #copy-view { min-width: 112px; }
    .report-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 20px; margin-bottom: 8px; }
    .report-heading h1 { margin: 0; }
    .report-nav { margin: 0; }
    a { color: #9dccff; text-underline-offset: 3px; }
    .report-nav a { display: inline-flex; min-height: 36px; align-items: center; font-size: 13px; }
    .quality-banner summary { cursor: pointer; padding: 8px 0; }
    .quality-banner ul { margin: 4px 0; padding-left: 20px; line-height: 1.5; overflow-wrap: anywhere; }
    .t-dropdown {
      transform-origin: top left;
    }
    .multi-filter[open] .t-dropdown { animation: dropdown-open var(--dropdown-open-dur) var(--dropdown-ease); }
    @keyframes dropdown-open {
      from { transform: scale(var(--dropdown-pre-scale)); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .t-toast {
      opacity: 0;
      transform: translateY(var(--toast-distance)) scale(var(--toast-scale));
      filter: blur(var(--toast-blur));
      transition: opacity var(--toast-close) var(--toast-ease), transform var(--toast-close) var(--toast-ease), filter var(--toast-close) var(--toast-ease);
    }
    .t-toast.is-open {
      opacity: 1;
      transform: translateY(0) scale(1);
      filter: blur(0);
      transition: opacity var(--toast-open) var(--toast-ease), transform var(--toast-open) var(--toast-ease), filter var(--toast-open) var(--toast-ease);
    }
    @media (prefers-reduced-motion: reduce) {
      .t-dropdown, .t-toast { transition: none !important; animation: none !important; }
    }

    .results-status {
      color: var(--muted);
      font-size: 12px;
      min-height: 16px;
      margin: -8px 0 18px;
    }

    .compact-filter-toggle { display: none; }
    .toolbar-actions { display: flex; gap: 8px; }

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
      border-top: 1px solid var(--line);
      overflow-x: visible;
    }

    h2 {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 700;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
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
      border: 1px solid var(--line);
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
      background: #171e27;
      font-size: 11px;
    }

    td {
      color: var(--text);
      font-weight: 500;
      font-size: 12px;
    }

    tbody tr:hover td:not(.view-cell) { background-color: #18212b; }

    th:nth-child(4), th:nth-child(6), th:nth-child(8), th:nth-child(9), th:nth-child(10), th:nth-child(11),
    td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(9), td:nth-child(10), td:nth-child(11) {
      text-align: right;
      white-space: nowrap;
    }

    .view-cell { padding: 0; }
    .offer-view { display: block; padding: 6px 7px; min-height: 100%; }
    .offer-view-automatic { display: none; }
    body[data-offer-view="automatic"] .offer-view-all { display: none; }
    body[data-offer-view="automatic"] .offer-view-automatic { display: block; }
    .rank-cell, .count-cell { color: var(--text); }

    td.index {
      color: var(--text);
      text-align: center;
    }

    td.location {
      color: #d7e2ee;
      font-weight: 650;
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

    .empty-state {
      margin: 24px 0;
      padding: 24px;
      border: 1px dashed #596273;
      border-radius: 4px;
      color: var(--muted);
      text-align: center;
    }

    .report-actions {
      display: flex;
      justify-content: center;
      margin: 4px 0 40px;
    }

    @media (max-width: 1100px) {
      body { padding: 14px; }
      th, td { padding: 5px; }
      td { font-size: 11px; }
    }

    @media (max-width: ${COMPACT_LAYOUT_MAX_WIDTH}px) {
      body { padding: 10px; }
      h1 { font-size: 21px; }
      .compact-filter-toggle {
        display: block;
        width: 100%;
        margin-bottom: 10px;
        text-align: left;
      }
      .toolbar { position: static; padding: 10px; }
      .toolbar > label, .filter-field { flex: 1 1 145px; min-width: 0; }
      .toolbar select, .toolbar input[type="date"], .multi-filter > summary { width: 100%; }
      .multi-options { max-width: calc(100vw - 20px); }
      .filter-field:nth-of-type(even) .multi-options { left: auto; right: 0; }
      .results-status { margin-top: 0; }
      .scenario { margin-bottom: 26px; }
      table, tbody, tr, td { display: block; width: 100%; }
      table { border: 0; background: transparent; }
      colgroup, thead { display: none; }
      tbody { display: grid; gap: 10px; }
      tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(105px, 36%); border: 1px solid var(--line); background: var(--panel); }
      td, td.index,
      td:nth-child(4), td:nth-child(6), td:nth-child(8), td:nth-child(9), td:nth-child(10), td:nth-child(11) {
        display: block;
        border: 0;
        border-bottom: 1px solid #3d434b;
        padding: 7px 9px;
        text-align: left;
        white-space: normal;
      }
      td { min-width: 0; font-size: 13px; }
      td.index { display: none; }
      td.location { grid-column: 1 / -1; font-size: 14px; padding: 12px 9px; }
      td:nth-child(3), td:nth-child(5), td:nth-child(7) { display: grid; grid-template-columns: 38px minmax(0, 1fr); align-items: center; gap: 4px; }
      td:nth-child(4), td:nth-child(6), td:nth-child(8) { text-align: right; }
      td:nth-child(9) { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
      td:nth-child(10), td:nth-child(11) { border-bottom: 0; }
      td:nth-child(10)::before, td:nth-child(11)::before { display: block; font-size: 12px; margin-bottom: 3px; }
      .toolbar select, .toolbar input[type="date"], .multi-filter > summary, button, .multi-option { min-height: 44px; }
      .multi-option { align-items: center; font-size: 14px; }
      .multi-option input { width: 18px; height: 18px; }
      .multi-options { max-height: min(280px, 45vh); }
      td::before { color: var(--muted); font-weight: 400; }
      td:nth-child(3)::before { content: "Top 1"; }
      td:nth-child(5)::before { content: "Top 2"; }
      td:nth-child(7)::before { content: "Top 3"; }
      td:nth-child(9)::before { content: "MM PLN/d"; }
      td:nth-child(10)::before { content: "Pozycja MM"; }
      td:nth-child(11)::before { content: "Tańsze oferty"; }
    }
  </style>
</head>
<body data-offer-view="all">
  <header class="report-heading"><h1>Kontrola cen DiscoverCars</h1>
  <nav class="report-nav" aria-label="Raporty"><a href="https://prejsik.github.io/discovercars-tool/manual-reports/index.html">Raporty ręczne i pliki Excel</a></nav>
  <div class="meta">Wygenerowano: ${escapeHtml(formatDateTime(generatedAt, timeZone))} · strefa ${escapeHtml(timeZone)}${minStartDate ? `<span class="report-range">Start najmu: ${escapeHtml(minStartDate.split("-").reverse().join("."))} – ${escapeHtml(maxStartDate.split("-").reverse().join("."))}</span>` : ""}</div>
  </header>
  ${buildQualityBanner(options.quality)}
  <div class="summary" role="region" aria-label="Podsumowanie bieżącego widoku">
    <span class="summary-label" id="summary-view">Wszystkie auta · Lotniska</span>
    <span><strong id="summary-scenarios">${scenarios.length}</strong> <span id="summary-scenarios-label">scenariuszy</span></span>
    <span><strong id="summary-checks">${locationChecks}</strong> <span id="summary-checks-label">sprawdzeń lokalizacji</span></span>
    <span><strong id="summary-missing">${missingMm}</strong> bez MM Cars Rental</span>
    <span><strong>${errorCount}</strong> ${polishPlural(errorCount, "błąd", "błędy", "błędów")} w całym raporcie</span>
    <span><strong id="summary-high">${highTop1Count}</strong> ze stawką Top1 &gt; ${PRICING_RULES.top1HighRateThresholdPlnDay} PLN/d</span>
  </div>
  <details class="legend-panel">
    <summary>Legenda oznaczeń</summary>
    <div class="legend" role="region" aria-label="Znaczenie oznaczeń">
      <span><span class="badge mm">MM Cars Rental</span> oferta MM Cars Rental</span>
      <span><span class="badge mm mm-close">Blisko wyższej pozycji</span> do 10 PLN/d więcej od wyżej sklasyfikowanej firmy</span>
      <span><span class="badge mm mm-top1-gap">Top1: +10 PLN/d</span> druga firma jest droższa o 10–19,99 PLN/d</span>
      <span><span class="badge mm mm-top1-gap-20">Top1: +20 PLN/d</span> druga firma jest droższa o 20–29,99 PLN/d</span>
      <span><span class="badge mm mm-top1-gap-30">Top1: +30 PLN/d</span> druga firma jest droższa o co najmniej 30 PLN/d</span>
      <span><span class="badge top1-high">Top1 &gt; 150</span> stawka Top1 przekracza 150 PLN/d</span>
    </div>
  </details>
  <button class="compact-filter-toggle" id="toggle-filters" type="button" aria-expanded="false" aria-controls="report-filters">Pokaż filtry: lotniska</button>
  <div class="toolbar" id="report-filters" role="region" aria-label="Filtry raportu">
    <label>Skrzynia<select id="filter-transmission"><option value="all">Wszystkie auta</option><option value="automatic">Tylko automaty</option></select></label>
    <label>Oddziały<select id="filter-location-type"><option value="airport">Lotniska</option><option value="all">Wszystkie oddziały</option></select></label>
    <label>Start od<input id="filter-date-from" type="date"${minStartDate ? ` min="${escapeHtml(minStartDate)}"` : ""}${maxStartDate ? ` max="${escapeHtml(maxStartDate)}"` : ""}></label>
    <label>Start do<input id="filter-date-to" type="date"${minStartDate ? ` min="${escapeHtml(minStartDate)}"` : ""}${maxStartDate ? ` max="${escapeHtml(maxStartDate)}"` : ""}></label>
    ${buildMultiFilter("filter-location", "Lokalizacja", locationOptions)}
    ${buildMultiFilter("filter-duration", "Długość najmu", durationOptions)}
    ${buildMultiFilter("filter-state", "Stan MM", mmStateOptions)}
    ${buildMultiFilter("filter-top1", "Kontrola Top1", top1Options)}
    <div class="toolbar-actions">
      <button id="copy-view" type="button">Kopiuj widok</button>
      <button id="reset-filters" type="button">Wyczyść filtry</button>
    </div>
  </div>
  <div class="date-error" id="date-error" role="alert" hidden></div>
  <div class="view-feedback t-toast" id="view-feedback" role="status" aria-live="polite"></div>
  <div class="copy-fallback" id="copy-fallback" hidden><label>Link do widoku<input id="view-link" type="url" readonly></label></div>
  <div class="results-status" id="results-status" role="status" aria-live="polite"></div>
  <div class="empty-state" id="empty-state" hidden role="region" aria-label="Wyniki filtrowania"><p id="empty-message">Brak wyników dla wybranych filtrów.</p><button type="button" id="empty-reset">Wyczyść filtry</button></div>
  <main id="report-results"></main>
  <div class="report-actions"><button id="load-more" type="button" hidden>Pokaż kolejne</button></div>
  <script type="application/json" id="report-data">${serializeInlineJson(reportData)}</script>
  <script>
    const reportData = JSON.parse(document.getElementById("report-data").textContent);
    const transmissionControl = document.getElementById("filter-transmission");
    const locationTypeControl = document.getElementById("filter-location-type");
    const dateFromControl = document.getElementById("filter-date-from");
    const dateToControl = document.getElementById("filter-date-to");
    const resetControl = document.getElementById("reset-filters");
    const copyViewControl = document.getElementById("copy-view");
    const toolbar = document.getElementById("report-filters");
    const filterToggle = document.getElementById("toggle-filters");
    const resultsStatus = document.getElementById("results-status");
    const emptyState = document.getElementById("empty-state");
    const dateError = document.getElementById("date-error");
    const viewFeedback = document.getElementById("view-feedback");
    const copyFallback = document.getElementById("copy-fallback");
    const loadMoreControl = document.getElementById("load-more");
    const reportResults = document.getElementById("report-results");
    const multiControls = ["filter-location", "filter-duration", "filter-state", "filter-top1"].map((id) => document.getElementById(id));
    const compactViewport = window.matchMedia("(max-width: ${COMPACT_LAYOUT_MAX_WIDTH}px)");
    const reportMinDate = ${JSON.stringify(minStartDate)};
    const reportMaxDate = ${JSON.stringify(maxStartDate)};
    const scenarioPageSize = ${INITIAL_SCENARIO_LIMIT};
    let visibleScenarioLimit = scenarioPageSize;
    let matchingScenariosCache = [];
    let matchingRowsCache = 0;
    let renderedScenarioCount = 0;
    let feedbackTimer;

    function polishPlural(value, one, few, many) {
      const number = Math.abs(Number(value));
      if (number === 1) return one;
      const lastDigit = number % 10;
      const lastTwoDigits = number % 100;
      return lastDigit >= 2 && lastDigit <= 4 && !(lastTwoDigits >= 12 && lastTwoDigits <= 14) ? few : many;
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function statusTitleForClass(className) {
      const classes = String(className || "").split(/\\s+/);
      if (classes.includes("mm-top1-gap-30")) return "MM Cars Rental jest Top1; kolejna firma jest droższa o co najmniej 30 PLN/d.";
      if (classes.includes("mm-top1-gap-20")) return "MM Cars Rental jest Top1; kolejna firma jest droższa o 20-29,99 PLN/d.";
      if (classes.includes("mm-top1-gap")) return "MM Cars Rental jest Top1; kolejna firma jest droższa o 10-19,99 PLN/d.";
      if (classes.includes("mm-close")) return "MM Cars Rental jest do 10 PLN/d od wyższej pozycji.";
      if (classes.includes("mm")) return "Oferta MM Cars Rental.";
      return "";
    }

    function viewSpan(mode, content, className = "", title = "") {
      const classes = ["offer-view", "offer-view-" + mode, className].filter(Boolean).join(" ");
      const resolvedTitle = title || statusTitleForClass(className);
      const safeContent = escapeHtml(content);
      const titleAttributes = resolvedTitle
        ? ' title="' + escapeHtml(resolvedTitle) + '" aria-label="' + safeContent + ". " + escapeHtml(resolvedTitle) + '"'
        : "";
      return '<span class="' + classes + '"' + titleAttributes + ">" + safeContent + "</span>";
    }

    function dualCell(automaticContent, allContent, automaticClass = "", allClass = "", automaticTitle = "", allTitle = "") {
      return '<td class="view-cell">'
        + viewSpan("automatic", automaticContent, automaticClass, automaticTitle)
        + viewSpan("all", allContent, allClass, allTitle)
        + "</td>";
    }

    function buildRow(row, index) {
      const automatic = row[2];
      const all = row[3];
      return '<tr class="' + (index % 2 === 0 ? "even" : "odd")
        + '" data-location="' + escapeHtml(row[0])
        + '" data-location-type="' + row[1]
        + '" data-mm-state-automatic="' + automatic[15]
        + '" data-mm-state-all="' + all[15]
        + '" data-top1-high-automatic="' + automatic[16]
        + '" data-top1-high-all="' + all[16] + '">'
        + '<td class="index">' + (index + 1) + "</td>"
        + '<td class="location">' + escapeHtml(row[0]) + "</td>"
        + dualCell(automatic[0], all[0], automatic[1], all[1])
        + dualCell(automatic[2], all[2], automatic[3], all[3], automatic[4], all[4])
        + dualCell(automatic[5], all[5], automatic[6], all[6])
        + dualCell(automatic[7], all[7])
        + dualCell(automatic[8], all[8], automatic[9], all[9])
        + dualCell(automatic[10], all[10])
        + dualCell(automatic[11], all[11], automatic[12], all[12])
        + dualCell(automatic[13], all[13], "rank-cell", "rank-cell")
        + dualCell(automatic[14], all[14], "count-cell", "count-cell")
        + "</tr>";
    }

    function buildErrors(errors) {
      if (!Array.isArray(errors) || !errors.length) return "";
      const items = errors.map((error) => '<li><strong>' + escapeHtml(error.location || "Nieznana lokalizacja") + ":</strong> " + escapeHtml(error.error || error.message || error) + "</li>").join("");
      return '<details class="errors"><summary>Błędy (' + errors.length + ")</summary><ul>" + items + "</ul></details>";
    }

    function buildScenarioTable(scenario, rows) {
      const safeTitle = escapeHtml(scenario.title);
      return '<section class="scenario" data-date="' + escapeHtml(scenario.date) + '" data-duration="' + escapeHtml(scenario.duration) + '">'
        + "<h2>" + safeTitle + "</h2>"
        + '<table aria-label="Porównanie cen: ' + safeTitle + '"><colgroup><col class="col-index"><col class="col-location"><col class="col-company"><col class="col-rate"><col class="col-company"><col class="col-rate"><col class="col-company"><col class="col-rate"><col class="col-mm-rate"><col class="col-rank"><col class="col-count"></colgroup>'
        + '<thead><tr><th scope="col">#</th><th scope="col">Lokalizacja</th><th scope="col">Top 1 firma</th><th scope="col">Top 1 PLN/d</th><th scope="col">Top 2 firma</th><th scope="col">Top 2 PLN/d</th><th scope="col">Top 3 firma</th><th scope="col">Top 3 PLN/d</th><th scope="col">MM PLN/d</th><th scope="col" title="Pozycja MM Cars Rental w rankingu firm">Pozycja MM</th><th scope="col" title="Liczba pojedynczych ofert tańszych od oferty MM Cars Rental">Tańsze oferty</th></tr></thead>'
        + "<tbody>" + rows.map(buildRow).join("") + "</tbody></table>"
        + buildErrors(scenario.errors) + "</section>";
    }

    function activeFilterSuffix() {
      const count = Number(transmissionControl.value !== "all")
        + Number(Boolean(dateFromControl.value || dateToControl.value))
        + multiControls.filter((control) => selectedValues(control).size > 0).length;
      if (!count) return "";
      const noun = count === 1 ? "filtr" : count < 5 ? "filtry" : "filtrów";
      return " · " + count + " " + noun;
    }

    function updateCompactFilterToggle(collapsed = toolbar.hidden) {
      const locationLabel = locationTypeControl.value === "airport" ? "lotniska" : "wszystkie oddziały";
      filterToggle.textContent = (collapsed ? "Pokaż filtry: " : "Ukryj filtry: ") + locationLabel + activeFilterSuffix();
      filterToggle.setAttribute("aria-expanded", String(!collapsed));
    }

    function syncCompactLayout() {
      visibleScenarioLimit = scenarioPageSize;
      toolbar.hidden = compactViewport.matches;
      updateCompactFilterToggle(toolbar.hidden);
      applyFilters(false);
    }

    function selectedValues(control) {
      return new Set(Array.from(control.querySelectorAll("input:checked")).map((input) => input.value));
    }

    function updateMultiSummary(control) {
      const checked = Array.from(control.querySelectorAll("input:checked"));
      const summary = control.querySelector("summary");
      let text;
      if (!checked.length) {
        text = control.dataset.allLabel;
      } else if (checked.length === 1) {
        text = checked[0].closest("label").querySelector("span").textContent;
      } else {
        text = checked.length + " wybrane";
      }
      summary.textContent = text;
      summary.setAttribute("aria-label", control.previousElementSibling.textContent + ": " + text);
    }

    function updateShareableUrl() {
      const params = new URLSearchParams();
      if (transmissionControl.value !== "all") params.set("view", transmissionControl.value);
      if (locationTypeControl.value !== "airport") params.set("branches", locationTypeControl.value);
      if (dateFromControl.value) params.set("from", dateFromControl.value);
      if (dateToControl.value) params.set("to", dateToControl.value);
      const parameterNames = ["location", "days", "mm", "top1"];
      multiControls.forEach((control, index) => {
        selectedValues(control).forEach((value) => params.append(parameterNames[index], value));
      });
      const query = params.toString();
      history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
    }

    function restoreFiltersFromUrl() {
      const params = new URLSearchParams(location.search);
      if (["all", "automatic"].includes(params.get("view"))) transmissionControl.value = params.get("view");
      if (["airport", "all"].includes(params.get("branches"))) locationTypeControl.value = params.get("branches");
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(params.get("from") || "")) dateFromControl.value = params.get("from");
      if (/^\\d{4}-\\d{2}-\\d{2}$/.test(params.get("to") || "")) dateToControl.value = params.get("to");
      const parameterNames = ["location", "days", "mm", "top1"];
      multiControls.forEach((control, index) => {
        const selected = new Set(params.getAll(parameterNames[index]));
        control.querySelectorAll("input").forEach((input) => { input.checked = selected.has(input.value); });
      });
      dateToControl.min = dateFromControl.value || reportMinDate;
      dateFromControl.max = dateToControl.value || reportMaxDate;
    }

    function renderScenarioPage(append = false) {
      const shownSections = Math.min(visibleScenarioLimit, matchingScenariosCache.length);
      const startIndex = append ? renderedScenarioCount : 0;
      const html = matchingScenariosCache
        .slice(startIndex, shownSections)
        .map(({ scenario, rows }) => buildScenarioTable(scenario, rows))
        .join("");
      if (append) {
        reportResults.insertAdjacentHTML("beforeend", html);
      } else {
        reportResults.innerHTML = html;
      }
      renderedScenarioCount = shownSections;
      emptyState.hidden = matchingScenariosCache.length > 0;
      document.getElementById("empty-message").textContent = dateError.hidden
        ? "Brak wyników dla wybranych filtrów."
        : "Nie można wyświetlić wyników dla nieprawidłowego zakresu dat.";
      loadMoreControl.hidden = shownSections >= matchingScenariosCache.length;
      loadMoreControl.textContent = "Pokaż kolejne " + Math.min(
        scenarioPageSize,
        matchingScenariosCache.length - shownSections
      );
      resultsStatus.textContent = matchingScenariosCache.length
        ? "Scenariusze: " + shownSections + "/" + matchingScenariosCache.length + " · pasujące wiersze: " + matchingRowsCache
        : dateError.hidden ? "Brak pasujących scenariuszy" : "Nieprawidłowy zakres dat";
    }

    function validateDates() {
      const reversed = dateFromControl.value && dateToControl.value && dateFromControl.value > dateToControl.value;
      const outOfRange = [dateFromControl, dateToControl].filter((input) => input.value
        && ((reportMinDate && input.value < reportMinDate) || (reportMaxDate && input.value > reportMaxDate)));
      const message = reversed ? "Data końcowa nie może być wcześniejsza niż data początkowa."
        : outOfRange.length ? "Daty poza zakresem raportu: " + reportMinDate + " – " + reportMaxDate + "." : "";
      dateError.hidden = !message;
      dateError.textContent = message;
      [dateFromControl, dateToControl].forEach((input) => {
        input.setAttribute("aria-describedby", "date-error");
        input.setAttribute("aria-invalid", String(Boolean(reversed || outOfRange.includes(input))));
      });
      return !message;
    }

    function applyFilters(resetLimit = true) {
      if (resetLimit) {
        visibleScenarioLimit = scenarioPageSize;
      }
      const offerView = transmissionControl.value;
      const locationType = locationTypeControl.value;
      document.body.dataset.offerView = offerView;
      const dateFrom = dateFromControl.value;
      const dateTo = dateToControl.value;
      const datesValid = validateDates();
      const selectedLocations = selectedValues(multiControls[0]);
      const selectedDurations = selectedValues(multiControls[1]);
      const selectedStates = selectedValues(multiControls[2]);
      const selectedTop1States = selectedValues(multiControls[3]);
      multiControls.forEach(updateMultiSummary);

      const matchingScenarios = [];
      let matchingRows = 0;
      let missingCount = 0;
      let highCount = 0;
      for (const scenario of reportData.scenarios) {
        const scenarioMatch = datesValid && (!dateFrom || scenario.date >= dateFrom)
          && (!dateTo || scenario.date <= dateTo)
          && (!selectedDurations.size || selectedDurations.has(scenario.duration));
        if (!scenarioMatch) continue;

        const rows = scenario.rows.filter((row) => {
          const view = offerView === "all" ? row[3] : row[2];
          const mmState = view[15];
          const top1State = view[16] ? "high" : "normal";
          const top1Match = !selectedTop1States.size || selectedTop1States.has(top1State);
          const locationTypeMatch = locationType === "all" || row[1] === locationType;
          const locationMatch = !selectedLocations.size || selectedLocations.has(row[0]);
          const stateMatch = !selectedStates.size || selectedStates.has(mmState);
          return locationTypeMatch && locationMatch && stateMatch && top1Match;
        });
        if (rows.length > 0) {
          matchingScenarios.push({ scenario, rows });
          matchingRows += rows.length;
          rows.forEach((row) => {
            const view = offerView === "all" ? row[3] : row[2];
            missingCount += Number(view[15] === "missing");
            highCount += Number(Boolean(view[16]));
          });
        }
      }

      matchingScenariosCache = matchingScenarios;
      matchingRowsCache = matchingRows;
      document.getElementById("summary-view").textContent = transmissionControl.selectedOptions[0].textContent
        + " · " + locationTypeControl.selectedOptions[0].textContent + activeFilterSuffix();
      document.getElementById("summary-scenarios").textContent = matchingScenarios.length;
      document.getElementById("summary-scenarios-label").textContent = polishPlural(matchingScenarios.length, "scenariusz", "scenariusze", "scenariuszy");
      document.getElementById("summary-checks").textContent = matchingRows;
      document.getElementById("summary-checks-label").textContent = polishPlural(matchingRows, "sprawdzenie", "sprawdzenia", "sprawdzeń") + " lokalizacji";
      document.getElementById("summary-missing").textContent = missingCount;
      document.getElementById("summary-high").textContent = highCount;
      copyFallback.hidden = true;
      viewFeedback.textContent = "";
      clearTimeout(feedbackTimer);
      viewFeedback.classList.remove("is-open");
      renderedScenarioCount = 0;
      renderScenarioPage(false);
      updateCompactFilterToggle(toolbar.hidden);
      updateShareableUrl();
    }

    function resetDateBounds() {
      if (reportMaxDate) {
        dateFromControl.max = reportMaxDate;
      } else {
        dateFromControl.removeAttribute("max");
      }
      if (reportMinDate) {
        dateToControl.min = reportMinDate;
      } else {
        dateToControl.removeAttribute("min");
      }
    }

    function resetFilters() {
      transmissionControl.value = "all";
      locationTypeControl.value = "airport";
      dateFromControl.value = "";
      dateToControl.value = "";
      resetDateBounds();
      multiControls.forEach((control) => {
        control.open = false;
        control.querySelectorAll("input:checked").forEach((input) => { input.checked = false; });
      });
      applyFilters(true);
    }

    transmissionControl.addEventListener("input", () => applyFilters(true));
    locationTypeControl.addEventListener("input", () => applyFilters(true));
    dateFromControl.addEventListener("input", () => {
      dateToControl.min = dateFromControl.value || reportMinDate;
      applyFilters(true);
    });
    dateToControl.addEventListener("input", () => {
      dateFromControl.max = dateToControl.value || reportMaxDate;
      applyFilters(true);
    });
    multiControls.forEach((control) => {
      control.addEventListener("change", () => applyFilters(true));
      control.addEventListener("toggle", () => {
        if (control.open) {
          multiControls.filter((other) => other !== control).forEach((other) => { other.open = false; });
        }
      });
    });
    resetControl.addEventListener("click", resetFilters);
    document.getElementById("empty-reset").addEventListener("click", () => {
      resetFilters();
      (toolbar.hidden ? filterToggle : transmissionControl).focus();
    });
    copyViewControl.addEventListener("click", async () => {
      clearTimeout(feedbackTimer);
      copyViewControl.disabled = true;
      try {
        if (location.protocol === "file:") throw new Error("local-file");
        await navigator.clipboard.writeText(window.location.href);
        viewFeedback.textContent = "Link do wybranego widoku skopiowany.";
      } catch {
        if (location.protocol === "file:") {
          viewFeedback.textContent = "To lokalny plik. Do udostępnienia potrzebna jest opublikowana wersja raportu.";
        } else {
          viewFeedback.textContent = "Schowek jest niedostępny. Link do widoku:";
          copyFallback.hidden = false;
          const input = document.getElementById("view-link");
          input.value = window.location.href;
          input.focus();
          input.select();
        }
      } finally {
        viewFeedback.classList.add("is-open");
        feedbackTimer = window.setTimeout(() => viewFeedback.classList.remove("is-open"), 5000);
        copyViewControl.disabled = false;
      }
    });
    filterToggle.addEventListener("click", () => {
      toolbar.hidden = !toolbar.hidden;
      updateCompactFilterToggle(toolbar.hidden);
    });
    loadMoreControl.addEventListener("click", () => {
      const previousCount = renderedScenarioCount;
      visibleScenarioLimit += scenarioPageSize;
      renderScenarioPage(true);
      const nextHeading = reportResults.children[previousCount]?.querySelector("h2");
      if (nextHeading) {
        nextHeading.tabIndex = -1;
        nextHeading.focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".multi-filter")) {
        multiControls.forEach((control) => { control.open = false; });
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const active = document.activeElement.closest(".multi-filter[open]");
        multiControls.forEach((control) => { control.open = false; });
        if (active) active.querySelector("summary").focus();
      }
    });
    compactViewport.addEventListener("change", syncCompactLayout);
    restoreFiltersFromUrl();
    syncCompactLayout();
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

function readJsonFile(filePath, label) {
  const resolvedPath = path.resolve(filePath);
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Nie znaleziono pliku ${label} "${resolvedPath}".`);
    }
    throw new Error(`Nie można odczytać ${label} "${resolvedPath}". ${error.message}`);
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Nie można odczytać ${label} "${resolvedPath}": plik JSON jest uszkodzony lub niepełny. ${error.message}`);
  }
}

function generateReportFromFile(inputPath, outputPath, options = {}) {
  const payload = readJsonFile(inputPath, "danych raportu");
  return writeHtmlReport(payload, outputPath, options);
}

if (require.main === module) {
  try {
    const inputPath = process.argv[2] || "output/results-latest.json";
    const outputPath = process.argv[3] || "output/report.html";
    const qualityArg = process.argv.find((arg) => arg.startsWith("--quality="));
    const qualityPath = qualityArg ? qualityArg.slice("--quality=".length) : null;
    let quality = null;
    if (qualityPath && fs.existsSync(qualityPath)) {
      try {
        quality = readJsonFile(qualityPath, "kontroli jakości");
      } catch (error) {
        console.warn(`${error.message} Raport zostanie utworzony bez statusu kontroli jakości.`);
      }
    }

    let writtenPath;
    try {
      writtenPath = generateReportFromFile(inputPath, outputPath, { quality });
    } catch (error) {
      if (!quality) {
        throw error;
      }
      console.warn(`${error.message} Ponawiam tworzenie raportu bez statusu kontroli jakości.`);
      writtenPath = generateReportFromFile(inputPath, outputPath);
    }
    console.log(`HTML report saved to ${writtenPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  buildHtmlReport,
  buildReportData,
  generateReportFromFile,
  writeHtmlReport
};
