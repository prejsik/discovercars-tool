const fs = require("fs");
const path = require("path");
const { buildCompletionMessages, summarizeDomVerification } = require("./workflowQualityAlerts");

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "brak danych";
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)} s`;
  }
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${totalMinutes} min`;
}

function summarizeNumberList(value, rangeSeparator = "-") {
  const numbers = [...new Set(String(value || "")
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter(Number.isFinite))]
    .sort((left, right) => left - right);
  if (!numbers.length) {
    return "brak danych";
  }
  const contiguous = numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
  return contiguous && numbers.length > 1
    ? `${numbers[0]}${rangeSeparator}${numbers[numbers.length - 1]}`
    : numbers.join(", ");
}

function recommendationStats(payload) {
  const recommendations = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.recommendations)
      ? payload.recommendations
      : [];
  const active = recommendations.filter((item) => item && item.action !== "hold");
  const configuredTotal = Number(payload?.recommendation_count);
  return {
    total: Number.isFinite(configuredTotal) ? configuredTotal : active.length,
    increases: active.filter((item) => item.action === "increase").length,
    decreases: active.filter((item) => item.action === "decrease").length
  };
}

function rangeLabel(env) {
  const durations = summarizeNumberList(env.DURATIONS);
  if (String(env.START_DATES || "").trim()) {
    const count = Number(env.START_DATE_COUNT) || String(env.START_DATES).split(",").filter(Boolean).length;
    return `${count} konkretnych dat · najem ${durations} dni`;
  }
  return `rolling ${env.ROLLING_DAYS || "?"} dni · najem ${durations} dni`;
}

function scenarioHasMmAnywhere(scenario) {
  const offerViews = Object.values(scenario?.offer_views_by_location || {});
  if (offerViews.some((views) => views?.automatic?.mm_cars_rental || views?.all?.mm_cars_rental)) {
    return true;
  }

  if (Object.values(scenario?.top_3_plus_mm_by_location || {}).some((entry) => entry?.mm_cars_rental)) {
    return true;
  }

  return Object.values(scenario?.mm_cars_rental_by_location || {}).some(Boolean);
}

function listStartDatesWithoutMm(results) {
  const scenarios = Array.isArray(results?.scenarios) ? results.scenarios : results ? [results] : [];
  const coverage = new Map();
  for (const scenario of scenarios) {
    const startDate = String(scenario?.start_date || scenario?.pickup_date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      continue;
    }
    coverage.set(startDate, Boolean(coverage.get(startDate)) || scenarioHasMmAnywhere(scenario));
  }
  return [...coverage.entries()]
    .filter(([, hasMm]) => !hasMm)
    .map(([startDate]) => startDate)
    .sort();
}

function formatIsoDate(isoDate) {
  const [year, month, day] = String(isoDate).split("-");
  return `${day}.${month}.${year}`;
}

function startDatesLabel(options, env) {
  const sources = [
    options.expectedScope?.start_dates,
    options.results?.collection_scope?.start_dates,
    options.results?.start_dates,
    String(env.START_DATES || "").split(","),
    (Array.isArray(options.results?.scenarios) ? options.results.scenarios : options.results ? [options.results] : [])
      .map((scenario) => scenario?.start_date || scenario?.pickup_date)
  ];
  let dates = [];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    dates = [...new Set(source.map((date) => String(date || "").trim().slice(0, 10)).filter((date) =>
      /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
      && new Date(date).toISOString().slice(0, 10) === date))].sort();
    if (dates.length) break;
  }
  if (!dates.length) return "brak danych";
  if (dates.length === 1) return formatIsoDate(dates[0]);
  const contiguous = dates.every((date, index) => !index || Date.parse(date) - Date.parse(dates[index - 1]) === 86400000);
  if (!contiguous) {
    return `${dates.slice(0, 10).map(formatIsoDate).join(", ")}${dates.length > 10 ? `; pozostałe daty: ${dates.length - 10}` : ""}`;
  }
  const first = dates[0];
  const last = dates[dates.length - 1];
  const firstLabel = first.slice(0, 7) === last.slice(0, 7) ? first.slice(8)
    : first.slice(0, 4) === last.slice(0, 4) ? `${first.slice(8)}.${first.slice(5, 7)}` : formatIsoDate(first);
  return `${firstLabel}–${formatIsoDate(last)}`;
}

function nonNegativeCount(value) {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function priceCoverageLabel(quality) {
  const expected = nonNegativeCount(quality.expected_location_check_count);
  const missing = nonNegativeCount(quality.missing_top3_count);
  if (!expected || missing == null || missing > expected) return "Dane cenowe: brak danych.";
  const found = expected - missing;
  const percent = found === expected ? 100 : Math.min(99.99, found / expected * 100);
  return `Dane cenowe uzyskano dla ${found}/${expected} sprawdzeń (${new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 2 }).format(percent)}%).`;
}

function formatAverageMagnitude(value) {
  if (value == null || value === "") {
    return "brak danych";
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "brak danych";
  }
  const formatted = new Intl.NumberFormat("pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(number));
  return `${formatted} PLN/dobę`;
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildPriceConflictAlert(excelSummary) {
  const count = Number(excelSummary?.city_top1_airport_cap_conflict_count || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }

  const conflicts = Array.isArray(excelSummary?.city_top1_airport_cap_conflicts)
    ? excelSummary.city_top1_airport_cap_conflicts.slice(0, 3)
    : [];
  const lines = [`ALERT CENOWY: pominięto ${count} pasm cenowych z powodu konfliktu floor/cap.`];
  for (const conflict of conflicts) {
    const pickupDate = /^\d{4}-\d{2}-\d{2}$/.test(String(conflict?.pickup_date || ""))
      ? formatIsoDate(conflict.pickup_date)
      : truncateText(conflict?.pickup_date || "brak daty", 20);
    const groups = Array.isArray(conflict?.groups)
      ? conflict.groups.join(", ")
      : String(conflict?.groups || "brak danych");
    const durationBand = truncateText(conflict?.duration_band || "brak danych", 30);
    const reason = truncateText(conflict?.skip_reason || "brak powodu", 280);
    lines.push(
      `${truncateText(conflict?.zone || "brak strefy", 60)} · ${pickupDate} · ${durationBand} dni · grupy ${truncateText(groups, 100)}: ${reason}`
    );
  }
  const omittedCount = Math.max(0, count - conflicts.length);
  if (omittedCount > 0) {
    lines.push(`Pozostałe konflikty: ${omittedCount}.`);
  }
  return lines.join("\n");
}

function buildTelegramSummary(options = {}) {
  const env = options.env || process.env;
  const quality = options.qualityAlerts || {};
  const qualityStatus = env.QUALITY_STATUS === "failure" || quality.status === "failure" || quality.publication_status === "blocked"
    ? "failure" : quality.status || env.QUALITY_STATUS || "failure";
  const domVerification = quality.dom_verification || summarizeDomVerification(options.recommendations);
  const completionMessages = buildCompletionMessages({ ...quality, dom_verification: domVerification });
  const alerts = Array.isArray(options.qualityAlerts?.alerts) ? options.qualityAlerts.alerts : [];
  const blockingAlerts = Array.isArray(options.qualityAlerts?.blocking_alerts)
    ? options.qualityAlerts.blocking_alerts
    : [];
  const nowEpoch = Number(options.nowEpoch ?? Math.floor(Date.now() / 1000));
  const startedEpoch = Number(env.RUN_STARTED_EPOCH);
  const runSeconds = Number.isFinite(startedEpoch) && startedEpoch > 0 ? Math.max(0, nowEpoch - startedEpoch) : NaN;
  const reportUrl = env.PAGE_URL || env.ARTIFACT_URL || "brak linku";
  const excelUrl = env.PAGES_EXCEL_URL || env.EXCEL_ARTIFACT_URL || "niedostępny";
  const excelReportUrl = env.PAGES_EXCEL_REPORT_URL || env.EXCEL_ARTIFACT_URL || "niedostępny";
  const reportAvailable = options.reportAvailable !== false;
  const excelReady = qualityStatus !== "failure" && options.excelAvailable !== false;
  const reportPublished = Boolean(env.PAGE_URL || env.ARTIFACT_URL);
  const excelPublished = Boolean(
    (env.PAGES_EXCEL_URL && env.PAGES_EXCEL_REPORT_URL)
      || env.EXCEL_ARTIFACT_URL
  );
  const pagesPublicationFailed = env.PAGES_PUBLICATION_FAILED === "true";
  const publicationFailure = qualityStatus !== "failure"
    && (pagesPublicationFailed || !reportAvailable || !reportPublished || !excelReady || !excelPublished);
  const statusLabel = qualityStatus === "failure"
    ? "BŁĄD"
    : publicationFailure
      ? "BŁĄD PUBLIKACJI"
      : "GOTOWE";
  const timeLabel = `${formatDuration(runSeconds)} (scraper ${formatDuration(env.SCRAPER_DURATION_SECONDS)})`;
  const missingMmStartDates = listStartDatesWithoutMm(options.results);
  const missingMmAlert = missingMmStartDates.length
    ? `ALERT: nie potwierdzono oferty MM Cars Rental w żadnej lokalizacji dla dat startu: ${missingMmStartDates.slice(0, 10).map(formatIsoDate).join(", ")}${missingMmStartDates.length > 10 ? ` · Pozostałe daty bez MM: ${missingMmStartDates.length - 10}.` : ""}`
    : "";
  const recommendationSurgeAlert = options.recommendationWorkload?.recommendation_surge
    ? String(options.recommendationWorkload.alert || "ALERT: nietypowy wzrost liczby aktywnych rekomendacji.")
    : "";
  const priceConflictAlert = buildPriceConflictAlert(options.excelSummary);

  if (qualityStatus === "failure") {
    const reason = blockingAlerts[0] || alerts[0] || "brak szczegółów - sprawdź GitHub Actions";
    return [
      `DiscoverCars | ${statusLabel}`,
      "",
      "Excel nie został opublikowany.",
      `Powód: ${reason}`,
      `Zakres: ${rangeLabel(env)}`,
      ...completionMessages,
      ...(priceConflictAlert ? [priceConflictAlert] : []),
      ...(missingMmAlert ? [missingMmAlert] : []),
      ...(recommendationSurgeAlert ? [recommendationSurgeAlert] : []),
      `Czas: ${timeLabel}`,
      "",
      `Raport: ${reportUrl}`,
      `GitHub Actions: ${env.RUN_URL || "brak linku"}`
    ].join("\n");
  }

  if (publicationFailure) {
    const reason = pagesPublicationFailed
      ? "publikacja raportu i plików Excel na GitHub Pages nie powiodła się"
      : !reportAvailable
        ? "raport HTML nie został wygenerowany"
        : !reportPublished
          ? "raport nie został udostępniony"
          : !excelReady
            ? "nie wygenerowano obu wymaganych plików Excel"
            : "pliki Excel nie zostały udostępnione";
    return [
      `DiscoverCars | ${statusLabel}`,
      "",
      `Powód: ${reason}.`,
      `Zakres: ${rangeLabel(env)}`,
      ...completionMessages,
      ...(priceConflictAlert ? [priceConflictAlert] : []),
      ...(missingMmAlert ? [missingMmAlert] : []),
      ...(recommendationSurgeAlert ? [recommendationSurgeAlert] : []),
      `Czas: ${timeLabel}`,
      "",
      `Raport: ${reportUrl}`,
      `GitHub Actions: ${env.RUN_URL || "brak linku"}`
    ].join("\n");
  }

  const statistics = options.excelSummary?.change_statistics || {};
  const increases = nonNegativeCount(statistics.increase_count);
  const decreases = nonNegativeCount(statistics.decrease_count);
  const conflictCount = nonNegativeCount(options.excelSummary?.city_top1_airport_cap_conflict_count);
  const minimumZoneRaises = nonNegativeCount(options.excelSummary?.mandatory_zone_floor_change_count) || 0;
  const minimumZones = (options.excelSummary?.mandatory_zone_floor_zones || []).join(", ");
  const minimumZoneScope = options.excelSummary?.mandatory_zone_floor_date_scope;
  const minimumGroupRaises = nonNegativeCount(options.excelSummary?.mandatory_group_floor_change_count) || 0;
  const minimumGroups = (Array.isArray(options.excelSummary?.mandatory_group_floor_groups)
    ? options.excelSummary.mandatory_group_floor_groups : []).join(", ");
  const minimumGroupLabel = minimumGroups || "grup";
  const minimumGroupScope = options.excelSummary?.mandatory_group_floor_date_scope;
  const durations = options.expectedScope?.durations || env.DURATIONS || options.results?.rental_day_options;
  const lines = [
    "DiscoverCars",
    "",
    `Daty startu: ${startDatesLabel(options, env)}`,
    `Czas trwania: ${summarizeNumberList(durations, "–")} dni`,
    priceCoverageLabel(quality),
    minimumZoneRaises > 0 || minimumGroupRaises > 0
      ? `Bez potwierdzonej ceny nie zmieniano stawek na podstawie rynku; wyjątkiem są obowiązkowe minima ${[
        ...(minimumZoneRaises > 0 ? ["lokalizacji"] : []),
        ...(minimumGroupRaises > 0 ? ["klas"] : [])
      ].join(" i ")}.`
      : "Tam, gdzie nie znaleziono lub nie potwierdzono ceny, nie zmieniano stawek.",
    ...(missingMmAlert ? [missingMmAlert] : []),
    "",
    increases == null || decreases == null ? "Zmiany w Excelu: brak danych."
      : `Zmiany w Excelu: ${increases} podwyżek i ${decreases} obniżek stawek.`,
    ...(increases > 0 ? [`Średnia podwyżka względem bazy: ${formatAverageMagnitude(statistics.average_increase_pln_day)}.`] : []),
    ...(decreases > 0 ? [`Średnia obniżka względem bazy: ${formatAverageMagnitude(statistics.average_decrease_pln_day)}.`] : []),
    ...(minimumZoneRaises > 0 ? [
      `Minima ${minimumZones}: ${minimumZoneRaises} podwyżek niezależnie od scrapera, także poza jego zakresem dat.`,
      ...(minimumZoneScope?.start_date && minimumZoneScope?.end_date
        ? [`Zakres korekt minimum: ${formatIsoDate(minimumZoneScope.start_date)}–${formatIsoDate(minimumZoneScope.end_date)}.`] : [])
    ] : []),
    ...(minimumGroupRaises > 0 ? [
      `Minimum ${minimumGroupLabel}: ${minimumGroupRaises} podwyżek niezależnie od scrapera, także poza jego zakresem dat.`,
      ...(minimumGroupScope?.start_date && minimumGroupScope?.end_date
        ? [`Zakres korekt minimum ${minimumGroupLabel}: ${formatIsoDate(minimumGroupScope.start_date)}–${formatIsoDate(minimumGroupScope.end_date)}.`] : [])
    ] : []),
    ...(conflictCount > 0 ? [`Pominięto ${conflictCount} przedziałów stawek ze względu na zasady cenowe. Szczegóły w rekomendacjach.`] : []),
    "",
    `Import: ${excelUrl}`,
    `Rekomendacje: ${excelReportUrl}`,
    `Raport cen: ${reportUrl}`
  ];
  return lines.join("\n");
}

function buildTelegramSummaryFromFiles(env = process.env) {
  const outputDir = path.resolve(env.OUTPUT_DIR || "output");
  return buildTelegramSummary({
    env,
    recommendations: safeReadJson(path.join(outputDir, "final-pricing-recommendations.json")),
    excelSummary: safeReadJson(path.join(outputDir, "excel-rate-update-summary.json")),
    qualityAlerts: safeReadJson(path.join(outputDir, "quality-alerts.json")),
    recommendationWorkload: safeReadJson(path.join(outputDir, "recommendation-workload.json")),
    results: safeReadJson(path.join(outputDir, "results-latest.json")),
    expectedScope: safeReadJson(path.join(outputDir, "scrape-scope.json")),
    reportAvailable: fs.existsSync(path.join(outputDir, "report.html")),
    excelAvailable: fs.existsSync(path.join(outputDir, "rates-import-ready.xlsx"))
      && fs.existsSync(path.join(outputDir, "rates-updated.xlsx"))
  });
}

if (require.main === module) {
  process.stdout.write(`${buildTelegramSummaryFromFiles()}\n`);
}

module.exports = {
  buildTelegramSummary,
  buildTelegramSummaryFromFiles,
  formatDuration,
  listStartDatesWithoutMm,
  recommendationStats,
  summarizeNumberList
};
