const fs = require("fs");
const path = require("path");

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

function summarizeNumberList(value) {
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
    ? `${numbers[0]}-${numbers[numbers.length - 1]}`
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

function buildTelegramSummary(options = {}) {
  const env = options.env || process.env;
  const qualityStatus = env.QUALITY_STATUS || "failure";
  const recommendations = recommendationStats(options.recommendations);
  const excelChangeCount = Number(options.excelSummary?.change_count);
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
  const publicationFailure = qualityStatus !== "failure"
    && (!reportAvailable || !reportPublished || !excelReady || !excelPublished);
  const statusLabel = qualityStatus === "failure"
    ? "BŁĄD"
    : publicationFailure
      ? "BŁĄD PUBLIKACJI"
    : qualityStatus === "degraded"
      ? "GOTOWE Z OSTRZEŻENIAMI"
      : "GOTOWE";
  const timeLabel = `${formatDuration(runSeconds)} (scraper ${formatDuration(env.SCRAPER_DURATION_SECONDS)})`;

  if (qualityStatus === "failure") {
    const reason = blockingAlerts[0] || alerts[0] || "brak szczegółów - sprawdź GitHub Actions";
    return [
      `DiscoverCars | ${statusLabel}`,
      "",
      "Excel nie został opublikowany.",
      `Powód: ${reason}`,
      `Zakres: ${rangeLabel(env)}`,
      `Czas: ${timeLabel}`,
      "",
      `Raport: ${reportUrl}`,
      `GitHub Actions: ${env.RUN_URL || "brak linku"}`
    ].join("\n");
  }

  if (publicationFailure) {
    const reason = !reportAvailable
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
      `Czas: ${timeLabel}`,
      "",
      `Raport: ${reportUrl}`,
      `GitHub Actions: ${env.RUN_URL || "brak linku"}`
    ].join("\n");
  }

  const lines = [
    `DiscoverCars | ${statusLabel}`,
    "",
    `Zakres: ${rangeLabel(env)}`,
    `Rekomendacje: ${recommendations.total} (podwyżki ${recommendations.increases}, obniżki ${recommendations.decreases})`,
    `Excel: ${Number.isFinite(excelChangeCount) ? excelChangeCount : "brak danych"} zmian · ${excelReady ? "gotowy do importu" : "niedostępny"}`,
    `Czas: ${timeLabel}`
  ];
  if (qualityStatus === "degraded") {
    lines.push(`Ostrzeżenia: ${alerts.length} · szczegóły w raporcie`);
  }
  lines.push("", `Raport: ${reportUrl}`);
  if (excelReady) {
    lines.push(`Excel importowy: ${excelUrl}`, `Excel z rekomendacjami: ${excelReportUrl}`);
  }
  return lines.join("\n");
}

function buildTelegramSummaryFromFiles(env = process.env) {
  const outputDir = path.resolve(env.OUTPUT_DIR || "output");
  return buildTelegramSummary({
    env,
    recommendations: safeReadJson(path.join(outputDir, "final-pricing-recommendations.json")),
    excelSummary: safeReadJson(path.join(outputDir, "excel-rate-update-summary.json")),
    qualityAlerts: safeReadJson(path.join(outputDir, "quality-alerts.json")),
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
  recommendationStats,
  summarizeNumberList
};
