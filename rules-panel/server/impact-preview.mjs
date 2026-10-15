import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const hashJson = (value) => digest(JSON.stringify(value));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const pricingOf = (documents) => documents.pricing.pricing ?? documents.pricing;
const publicMessages = {
  hash_mismatch: "Odcisk pliku nie zgadza sie z przypietym zrodlem. Podglad zostal zatrzymany.",
  baseline_mismatch: "Raport lub manifest wskazuje inna baze niz aktualnie zatwierdzony plik.",
  source_changed: "Zmienily sie zasady, lokalizacje lub zrodlo. Odswiez dane i zapisz nowy szkic.",
  stale_evidence: "Dane zrodlowe sa starsze niz 24 godziny lub maja date z przyszlosci.",
  missing_timestamp: "Brakuje wiarygodnej daty zebrania danych z oznaczeniem strefy czasowej.",
  missing_artifact: "Brakuje wymaganego pliku lub jego przypietego odcisku.",
  invalid_json: "Nie mozna odczytac danych z pliku JSON.",
  invalid_request: "Nieprawidlowa wersja lub identyfikator podgladu.",
  invalid_documents: "Nieprawidlowa struktura dokumentow zasad lub ukladu arkusza.",
  invalid_model: "Szkic zawiera nieprawidlowe albo niedozwolone zmiany zasad.",
  locations_changed: "Podglad nie zmienia rejestru lokalizacji.",
  learning_forbidden: "Podglad nie moze zmieniac ani uczyc narzutu brokera.",
  invalid_provenance: "Nie mozna potwierdzic pochodzenia opublikowanych danych.",
  incomplete_recommendations: "Brakuje decyzji cenowych wymaganych do przeliczenia arkusza.",
  incomplete_scope: "Zakres lub identyfikatory decyzji sa niespojne z manifestem raportu.",
  inconsistent_recommendations: "Decyzje i kopie rekomendacji w raporcie sa niespojne.",
  run_mismatch: "Dane pochodza z innego przebiegu niz przypiety manifest.",
  missing_calibration: "Brakuje zatwierdzonego, zamrozonego narzutu brokera.",
  engine_failed: "Silnik eksportu odrzucil dane lub konfiguracje. Nie wyliczono wyniku podgladu.",
  engine_timeout: "Pelny eksport przekroczyl czas wykonania. Nie wyliczono wyniku podgladu.",
  validation_failed: "Kontrola rzeczywistego eksportu wykryla blad. Publikacja pozostaje zablokowana.",
  invalid_import: "Wygenerowany arkusz zawiera nieprawidlowe stawki, daty lub strukture.",
  ambiguous_grid: "Arkusz zawiera powtorzone pozycje, ktorych nie mozna jednoznacznie porownac.",
  evidence_unavailable: "Nie mozna pobrac kompletnego, bezpiecznego zestawu danych raportu.",
  publication_race: "Raport zmienil sie podczas pobierania. Uruchom podglad ponownie.",
  tests_failed: "Testy regresji nie przeszly. Publikacja pozostaje zablokowana.",
  model_hash_mismatch: "Odcisk zapisanego szkicu nie zgadza sie z jego zawartoscia.",
  identity_mismatch: "Zlecenie dotyczy innego podgladu.",
  invalid_envelope: "Nie mozna potwierdzic autentycznosci zaszyfrowanego zlecenia.",
  request_expired: "Zlecenie podgladu wygaslo lub ma date z przyszlosci.",
  invalid_environment: "Brakuje bezpiecznego srodowiska wykonania podgladu.",
  limit_exceeded: "Plik wejsciowy przekracza techniczny limit bezpiecznego odczytu.",
};
export const publicErrorMessage = (code) => publicMessages[code] ?? "Nie mozna bezpiecznie wykonac podgladu. Publikacja pozostaje zablokowana.";
function blocked(code, message) { throw Object.assign(new Error(publicErrorMessage(code)), { code }); }
function check(condition, code, message) { if (!condition) blocked(code, message); }
const key = (item) => JSON.stringify([item.location, item.start_date, item.rental_days]);

function sourceTime(value, now, times) {
  const time = typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
  check(Number.isFinite(time), "missing_timestamp", "A timezone-qualified source collection timestamp is required.");
  check(time <= now && now - time <= DAY, "stale_evidence", "Source evidence is future-dated or older than 24 hours.");
  times.push(time);
}

function checkDocuments(documents) {
  check(object(documents) && object(documents.pricing) && object(documents.excel) && object(documents.locations),
    "invalid_documents", "Pricing, Excel and location documents are required.");
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      check(!name.startsWith("_") && !["__proto__", "constructor", "prototype"].includes(name),
        "invalid_documents", "Private engine options are not accepted.");
      walk(child);
    }
  };
  walk(documents);
  const excel = documents.excel;
  check(!excel.broker_markup_learning?.enabled, "learning_forbidden", "Preview cannot enable calibration learning.");
  check(pricingOf(documents).brokerMarkupCalibration?.manualOnly === true,
    "learning_forbidden", "Preview requires frozen manual-only calibration.");
  const layout = { worksheet: "Sheet1", header_row: 4, data_start_row: 5, duration_min_row: 2, duration_max_row: 3 };
  for (const [name, value] of Object.entries(layout)) {
    check(excel[name] === undefined || excel[name] === value, "invalid_documents", "Only the existing Sheet1 layout is supported.");
  }
  const columns = { group: 1, zone: 4, booking_end_date: 6, pickup_start_date: 7, pickup_end_date: 8, rate_start: 9 };
  for (const [name, value] of Object.entries(excel.columns ?? {})) {
    check(columns[name] === value, "invalid_documents", "Column remapping is not supported by preview.");
  }
}

// The caller pins bytes before execution; stage those exact bytes so mutable paths cannot race export.
export async function runImpactPreview(input, { now = new Date() } = {}) {
  const { buildPricingRecommendations } = require("../../src/pricingRecommendations.js");
  const { mergeBrokerMarkupCalibration } = require("../../src/brokerMarkupCalibration.js");
  const { rebuildDomRecommendation, inputFingerprint, isSourceVerified } = require("../../src/verifyActiveRecommendationsDom.js");
  const request = structuredClone(input);
  check(request.schemaVersion === 1 && UUID.test(request.draftRevision) && /^[a-f0-9]{40}$/.test(request.sourceRevision)
    && typeof request.runId === "string" && request.runId.length > 0, "invalid_request", "Immutable request identity is required.");
  checkDocuments(request.current);
  request.proposed = { ...request.proposed, locations: request.proposed?.locations ?? request.current.locations };
  checkDocuments(request.proposed);
  check(isDeepStrictEqual(request.current.locations, request.proposed.locations), "locations_changed", "Location registry changes are outside preview scope.");
  check(isDeepStrictEqual(pricingOf(request.current).brokerMarkupCalibration, pricingOf(request.proposed).brokerMarkupCalibration),
    "learning_forbidden", "Frozen calibration settings cannot change in a preview.");
  const hashes = { currentDocuments: hashJson(request.current), proposedDocuments: hashJson(request.proposed) };
  const bytes = {};
  const values = {};
  for (const name of ["baselineWorkbook", "baselineManifest", "runManifest", "finalRecommendations", "results", "calibration"]) {
    const artifact = request.artifacts?.[name];
    if (!artifact && ["results", "calibration"].includes(name)) continue;
    check(object(artifact) && typeof artifact.path === "string" && SHA.test(artifact.sha256), "missing_artifact", `Pinned ${name} is required.`);
    let data;
    try {
      check((await stat(artifact.path)).size <= 64 * 1024 * 1024, "limit_exceeded", "Input artifact exceeds 64 MiB.");
      data = await readFile(artifact.path);
    } catch (error) {
      if (error.code === "limit_exceeded") throw error;
      blocked("missing_artifact", `Cannot read ${name}.`);
    }
    check(digest(data) === artifact.sha256, "hash_mismatch", `Pinned ${name} hash does not match its bytes.`);
    hashes[name] = artifact.sha256;
    bytes[name] = data;
    if (name !== "baselineWorkbook") {
      try { values[name] = JSON.parse(data.toString("utf8")); }
      catch { blocked("invalid_json", `Invalid JSON in ${name}.`); }
    }
  }
  const manifest = values.runManifest;
  check(values.baselineManifest.workbook_sha256 === hashes.baselineWorkbook
    && manifest.baseline?.workbook_sha256 === hashes.baselineWorkbook,
  "baseline_mismatch", "Run evidence and baseline manifest must reference the pinned baseline workbook.");
  check(["success", "degraded"].includes(manifest.status) && /^[a-f0-9]{40}$/.test(manifest.git_sha)
    && typeof manifest.run_id === "string" && manifest.run_id.length > 0,
  "invalid_provenance", "Published evidence with source commit and run identity is required.");
  const times = [];
  sourceTime(manifest.source_started_at, now.getTime(), times);
  const final = values.finalRecommendations;
  sourceTime(final.source_generated_at, now.getTime(), times);
  check(Array.isArray(final.decisions) && final.decisions.length > 0
    && (Array.isArray(final.recommendations) || Array.isArray(final.recommendationKeys)),
    "incomplete_recommendations", "Final evidence must include all decisions, including holds.");
  const scope = manifest.expected_scope;
  check(scope && [scope.locations, scope.start_dates, scope.durations].every((list) => Array.isArray(list) && list.length > 0),
    "incomplete_scope", "Run manifest must include explicit expected locations, dates and durations.");
  const decisions = new Map();
  for (const item of final.decisions) {
    if (item.source_generated_at) sourceTime(item.source_generated_at, now.getTime(), times);
    check(item.action === "hold" || String(item.source_run_id) === manifest.run_id, "run_mismatch", "Active decision source run does not match run manifest.");
    check(scope.locations.includes(item.location) && scope.start_dates.includes(item.start_date)
      && scope.durations.includes(item.rental_days) && !decisions.has(key(item))
      && ["hold", "increase", "decrease"].includes(item.action) && typeof item.reason === "string" && item.reason.length > 0,
    "incomplete_scope", "Final decisions have duplicate, invalid or out-of-scope entries.");
    decisions.set(key(item), item);
  }
  const recommendationKeys = new Set(final.recommendationKeys?.map((value) => JSON.stringify(value))
    ?? final.recommendations.map(key));
  check((final.recommendations?.every((item) => isDeepStrictEqual(item, decisions.get(key(item)))) ?? true)
    && [...recommendationKeys].every((value) => decisions.has(value))
    && final.decisions.filter((item) => item.action !== "hold").every((item) => recommendationKeys.has(key(item))),
  "inconsistent_recommendations", "Recommendations and decisions must describe the same final evidence.");
  const before = { decisions: final.decisions };
  const pricingChanged = !isDeepStrictEqual(request.current.pricing, request.proposed.pricing);
  const coverage = { totalDecisionCount: decisions.size, missingDecisionCount:
    scope.locations.length * scope.start_dates.length * scope.durations.length - decisions.size,
    rawReplayedDecisionCount: 0, domReplayedDecisionCount: 0, frozenMarketDecisionCount: 0 };
  const replay = (documents, payload) => {
    const pricing = pricingOf(documents);
    check(!pricing.brokerMarkupCalibration.enabled || values.calibration?.brokerMarkupCalibration?.manualOnly === true,
      "missing_calibration", "Enabled pricing requires the pinned frozen calibration artifact.");
    return buildPricingRecommendations(payload, { ...pricing, locationRegistry: documents.locations, excelPolicy: documents.excel,
      brokerMarkupCalibration: mergeBrokerMarkupCalibration(pricing.brokerMarkupCalibration, values.calibration ?? {}),
      calibrationNow: now.getTime() });
  };
  const economic = (item) => Object.fromEntries(["action", "recommendation_type", "target_rank", "suggested_rate_pln_day",
    "maximum_import_rate_pln_day", "site_cap_rate_pln_day", "data_quality_status"].map((name) => [name, item?.[name] ?? null]));
  let rawBefore = new Map();
  let rawAfter = new Map();
  if (values.results) {
    const results = values.results;
    sourceTime(results.generated_at, now.getTime(), times);
    check(String(results.run_id) === manifest.run_id, "run_mismatch", "Raw source run differs from run manifest.");
    const complete = Array.isArray(results.scenarios) && results.scenarios.length > 0 && results.scenarios.every((scenario) =>
      scope.locations.every((location) => object(scenario.top_3_plus_mm_by_location?.[location])
        && typeof scenario.source_validation_by_location?.[location]?.status === "string"));
    if (complete) {
      for (const scenario of results.scenarios) for (const location of scope.locations)
        sourceTime(scenario.source_generated_at_by_location?.[location] ?? scenario.generated_at ?? results.generated_at, now.getTime(), times);
      rawBefore = new Map(replay(request.current, results).decisions.map((item) => [key(item), item]));
      rawAfter = new Map(replay(request.proposed, results).decisions.map((item) => [key(item), item]));
    }
  }
  const after = { decisions: final.decisions.map((item) => {
    if (rawBefore.has(key(item)) && isDeepStrictEqual(economic(rawBefore.get(key(item))), economic(item))) {
      coverage.rawReplayedDecisionCount++;
      return rawAfter.get(key(item));
    }
    const record = item.dom_repricing;
    if (pricingChanged && record && isSourceVerified(item, final.source_generated_at, now.getTime(), final.options)) {
      const options = { ...final.options, ...pricingOf(request.proposed), locationRegistry: request.proposed.locations, excelPolicy: request.proposed.excel,
        brokerMarkupCalibration: mergeBrokerMarkupCalibration(pricingOf(request.proposed).brokerMarkupCalibration, values.calibration ?? {}) };
      // Counterfactual policy stamp is ephemeral; original evidence was independently validated above.
      const simulated = rebuildDomRecommendation(record.input,
        { ...record, policy_fingerprint: inputFingerprint(options) }, options);
      if (simulated) { coverage.domReplayedDecisionCount++; return simulated; }
    }
    coverage.frozenMarketDecisionCount++;
    return item;
  }) };
  const mode = coverage.rawReplayedDecisionCount === decisions.size ? "full_replay"
    : coverage.domReplayedDecisionCount ? "verified_dom_replay" : pricingChanged || values.results ? "frozen_market" : "excel_only";
  const directory = await mkdtemp(join(tmpdir(), "discovercars-impact-"));
  try {
    const artifacts = {};
    for (const [name, data] of Object.entries(bytes)) {
      artifacts[name] = join(directory, name === "baselineWorkbook" ? "baseline.xlsx" : `${name}.json`);
      await writeFile(artifacts[name], data, { mode: 0o600 });
    }
    const task = join(directory, "task.json");
    const exportInput = (value) => ({ decisions: value.decisions.map(({ dom_repricing, ...item }) => item) });
    await writeFile(task, JSON.stringify({ ...request, artifacts, before: exportInput(before), after: exportInput(after), now: now.toISOString() }), { mode: 0o600 });
    let summary;
    try {
      const result = await exec(process.env.PYTHON ?? "python", [join(root, "rules-panel/server/impact_preview.py"), task],
        { cwd: directory, windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" } });
      summary = JSON.parse(result.stdout);
    } catch (error) { blocked(error.killed ? "engine_timeout" : "engine_failed"); }
    if (summary.error) blocked(summary.error.code, summary.error.message);
    hashes.exportEngine = digest(await readFile(join(root, "tools/update_excel_rates.py")));
    hashes.pricingEngine = digest(await readFile(join(root, "src/pricingRecommendations.js")));
    const engineHashes = {};
    for (const name of ["src/pricingRules.js", "src/brokerMarkupCalibration.js", "src/locationRegistry.js",
      "src/currentBrokerMarkup.js", "src/top1RateSignals.js", "src/verifyActiveRecommendationsDom.js"])
      engineHashes[name] = digest(await readFile(join(root, name)));
    return { schemaVersion: 1, status: "success", mode, draftRevision: request.draftRevision, sourceRevision: request.sourceRevision,
      sourceHash: hashes.currentDocuments, modelHash: hashJson(request.proposed), baselineSha256: hashes.baselineWorkbook,
      resultsSha256: final.normalization?.originalSha256 ?? hashes.results ?? hashes.finalRecommendations,
      resultsKind: values.results ? "raw_and_final" : "final_recommendations", coverage,
      runId: request.runId, dataCollectedAt: new Date(Math.min(...times)).toISOString(), completedAt: now.toISOString(),
      provenance: { hashes, engineHashes, sourceRunId: manifest.run_id, sourceRunRevision: manifest.git_sha, sourceStatus: manifest.status },
      freshness: { maximumAgeHours: 24, oldestAgeSeconds: Math.ceil((now.getTime() - Math.min(...times)) / 1000) },
      limits: { maxImportRows: request.proposed.excel.max_import_rows ?? null,
        pickupDateExpansion: request.proposed.excel.pickup_date_expansion ?? { enabled: false }, sampleLimit: 20 }, ...summary,
      limitations: ["To odtworzenie zapisanych danych, nie gwarancja przyszlej pozycji ani przychodu.",
        `Ponownie przeliczono ${coverage.rawReplayedDecisionCount + coverage.domReplayedDecisionCount} decyzji rynkowych; zachowano ${coverage.frozenMarketDecisionCount} decyzji z raportu bez nowego potwierdzenia jakosci.`,
        "Minima, ochrona dat, dopuszczone klasy, limity i parytet sa liczone przez rzeczywisty silnik eksportu dla calego arkusza."] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 4 && process.argv[2] === "--request", "invalid_arguments", "Usage: impact-preview.mjs --request pinned-request.json");
    const request = JSON.parse(await readFile(resolve(process.argv[3]), "utf8"));
    process.stdout.write(`${JSON.stringify(await runImpactPreview(request))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "blocked", error: {
      code: error.code ?? "preview_failed", message: publicErrorMessage(error.code) } })}\n`);
    process.exitCode = 1;
  }
}
