import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { buildPricingRecommendations } = require("../src/pricingRecommendations.js");
const adapter = await import("../rules-panel/server/impact-preview.mjs").catch(() => ({}));
const now = new Date();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => structuredClone(value);

async function fixture(t, count = 1) {
  const dir = await mkdtemp(join(tmpdir(), "impact-preview-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workbook = join(dir, "baseline.xlsx");
  execFileSync("python", [join(root, "tests/impact-preview-fixture.py"), workbook, String(count)], { windowsHide: true });
  const documents = {
    pricing: { pricing: { brokerMarkupCalibration: { enabled: false, manualOnly: true } } },
    excel: { worksheet: "Sheet1", apply_groups: ["CDMV"], excluded_groups: [], omitted_group_zones: {},
      minimum_rates: { global_min_pln_day: 0, bands: [], scoped_overrides: [] },
      group_rate_adjustments_pln_day: {}, group_price_parity: { enabled: false },
      city_top1_airport_cap: { enabled: false }, normalize_pickup_end_to_start: false,
      pickup_date_expansion: { enabled: false }, broker_markup_learning: { enabled: false } },
    locations: { schema_version: 1, locations: [{ id: "test", scraper_label: "Test Airport",
      city: "Test", kind: "airport", zones: ["TEST"], daily: true }] },
  };
  const dates = Array.from({ length: count }, (_, i) => new Date(Date.UTC(2026, 9, 16 + i)).toISOString().slice(0, 10));
  const offer = (provider, rate) => ({ provider_name: provider, total_price: rate * 2, rental_days: 2, currency: "PLN" });
  const view = { top_3: [offer("MM Cars Rental", 80), offer("Competitor", 100), offer("Other", 120)],
    mm_cars_rental: offer("MM Cars Rental", 80) };
  const results = { generated_at: new Date(now.getTime() - 3600000).toISOString(), run_id: "source-123", locations: ["Test Airport"],
    scenarios: dates.map((start_date, i) => ({ scenario_id: `s${i}`, start_date, rental_days: 2,
      top_3_plus_mm_by_location: { "Test Airport": view },
      source_validation_by_location: { "Test Airport": { status: "api_verified", reasons: [] } } })) };
  const final = buildPricingRecommendations(results, documents.pricing.pricing);
  const artifacts = {};
  async function pin(name, value) {
    const path = join(dir, `${name}.json`);
    const bytes = JSON.stringify(value);
    await writeFile(path, bytes);
    artifacts[name] = { path, sha256: sha(bytes) };
  }
  artifacts.baselineWorkbook = { path: workbook, sha256: sha(await readFile(workbook)) };
  await pin("baselineManifest", { schema_version: 1, status: "user_approved_baseline", approved_by: "user",
    approved_at: "2026-10-13", workbook_sha256: artifacts.baselineWorkbook.sha256 });
  await pin("runManifest", { generated_at: results.generated_at, source_started_at: results.generated_at,
    run_id: results.run_id, git_sha: "a".repeat(40), status: "success",
    baseline: { workbook_sha256: artifacts.baselineWorkbook.sha256 },
    expected_scope: { start_dates: dates, durations: [2], locations: results.locations } });
  await pin("results", results);
  await pin("finalRecommendations", final);
  const request = { schemaVersion: 1, draftRevision: "b2345678-1234-4234-8234-123456789abc", sourceRevision: "c".repeat(40),
    runId: "preview-456", current: documents, proposed: clone(documents), artifacts };
  return { dir, request, artifacts, pin, results, final };
}

test("public preview API is available", () => {
  assert.equal(typeof adapter.runImpactPreview, "function", "the real preview adapter must export runImpactPreview");
});

test("compares all 120 exported rate cells rather than truncated engine changes", async (t) => {
  const { request, dir } = await fixture(t, 120);
  request.proposed.excel.min_excel_change_pln_day = 20;
  const before = await readdir(dir);
  const result = await adapter.runImpactPreview(request, { now });
  assert.equal(result.status, "success");
  assert.equal(result.mode, "full_replay");
  assert.equal(result.before.changeCount, 120);
  assert.equal(result.after.changeCount, 0);
  assert.equal(result.impact.changedRateCells, 120);
  assert.equal(result.impact.decreasedRateCells, 120);
  assert.equal(result.impact.samples[0].beforeRate, 99);
  assert.equal(result.impact.samples[0].afterRate, 80);
  assert.ok(result.impact.samples[0].beforeDecision.reason);
  assert.equal(result.draftRevision, request.draftRevision);
  assert.equal(result.baselineSha256, request.artifacts.baselineWorkbook.sha256);
  assert.equal(result.resultsSha256, request.artifacts.results.sha256);
  assert.equal(result.testsSucceeded, undefined, "only the job runner can attest a test suite");
  assert.deepEqual(await readdir(dir), before, "all exports stay in internal temp storage");
  assert.equal(sha(await readFile(request.artifacts.baselineWorkbook.path)), result.baselineSha256);
});

test("final-only evidence supports Excel changes and freezes unsupported market decisions", async (t) => {
  const { request } = await fixture(t);
  delete request.artifacts.results;
  request.proposed.excel.min_excel_change_pln_day = 20;
  const result = await adapter.runImpactPreview(request, { now });
  assert.equal(result.mode, "excel_only");
  assert.equal(result.impact.changedRateCells, 1);
  request.proposed.pricing.pricing.undercutBufferPlnDay = 2;
  const limited = await adapter.runImpactPreview(request, { now });
  assert.equal(limited.coverage.frozenMarketDecisionCount, 1);
  assert.equal(limited.impact.changedRateCells, 1);
});

test("rejects altered bytes before running the engine", async (t) => {
  const { request } = await fixture(t);
  await writeFile(request.artifacts.finalRecommendations.path, "{}");
  await assert.rejects(adapter.runImpactPreview(request, { now }), { code: "hash_mismatch" });
});

test("rejects stale source timestamps without using final file generation time", async (t) => {
  const { request, results, pin } = await fixture(t);
  results.generated_at = "2026-10-01T00:00:00Z";
  await pin("results", results);
  await assert.rejects(adapter.runImpactPreview(request, { now }), { code: "stale_evidence" });
});

test("rejects run manifest baseline and run identity mismatches", async (t) => {
  const { request, pin } = await fixture(t);
  const manifest = JSON.parse(await readFile(request.artifacts.runManifest.path, "utf8"));
  manifest.baseline.workbook_sha256 = "0".repeat(64);
  await pin("runManifest", manifest);
  await assert.rejects(adapter.runImpactPreview(request, { now }), { code: "baseline_mismatch" });
});

test("compact public results retain frozen final market evidence without pretending full replay", async (t) => {
  const { request, results, pin } = await fixture(t);
  delete results.scenarios[0].source_validation_by_location;
  await pin("results", results);
  const result = await adapter.runImpactPreview(request, { now });
  assert.equal(result.coverage.rawReplayedDecisionCount, 0);
  assert.equal(result.coverage.frozenMarketDecisionCount, 1);
});

test("fails closed when final decisions and recommendation copies disagree", async (t) => {
  const { request, final, pin } = await fixture(t);
  final.decisions[0] = { ...final.decisions[0], suggested_rate_pln_day: 50 };
  await pin("finalRecommendations", final);
  await assert.rejects(adapter.runImpactPreview(request, { now }), { code: "inconsistent_recommendations" });
});

test("changed pricing reuses validated DOM offers through the actual repricing engine", async (t) => {
  const { request, final, pin } = await fixture(t);
  const { rebuildDomRecommendation, inputFingerprint } = require("../src/verifyActiveRecommendationsDom.js");
  const item = final.decisions[0];
  const verifiedAt = new Date(Date.now() - 1000).toISOString();
  const record = { version: 1, input: item, input_fingerprint: inputFingerprint(item),
    policy_fingerprint: inputFingerprint(final.options), verified_at: verifiedAt,
    evidence: { automatic_filter_confirmed: true, price_sort_confirmed: true, ranking_complete: true },
    offers: [["MM Cars Rental", 160], ["Competitor", 200], ["Other", 240]].map(([provider, totalPrice]) =>
      ({ provider, totalPrice, source: "dom", transmission: "automatic", location: item.location, currency: "PLN" })) };
  const verified = rebuildDomRecommendation(item, record, final.options);
  assert.ok(verified, "fixture must be accepted by the existing DOM evidence validator");
  final.decisions = [verified];
  final.recommendations = [verified];
  await pin("finalRecommendations", final);
  delete request.artifacts.results;
  request.proposed.pricing.pricing.top1RaiseBufferPlnDay = 2;
  const result = await adapter.runImpactPreview(request, { now: new Date() });
  assert.equal(result.coverage.domReplayedDecisionCount, 1);
  assert.equal(result.impact.samples[0].beforeRate, 99);
  assert.equal(result.impact.samples[0].afterRate, 98);
});

test("scoped replay uses proposed date protection in both raw and cached DOM paths", async (t) => {
  for (const mode of ["raw", "dom"]) await t.test(mode, async (subtest) => {
    const { request, final, pin, results } = await fixture(subtest);
    results.scenarios[0].group = "CDMV";
    await pin("results", results);
    if (mode === "dom") {
      const { rebuildDomRecommendation, inputFingerprint } = require("../src/verifyActiveRecommendationsDom.js");
      const item = final.decisions[0];
      const record = { version: 1, input: item, input_fingerprint: inputFingerprint(item),
        policy_fingerprint: inputFingerprint(final.options), verified_at: new Date(Date.now() - 1000).toISOString(),
        evidence: { automatic_filter_confirmed: true, price_sort_confirmed: true, ranking_complete: true },
        offers: [["MM Cars Rental", 160], ["Competitor", 200], ["Other", 240]].map(([provider, totalPrice]) =>
          ({ provider, totalPrice, source: "dom", transmission: "automatic", location: item.location, currency: "PLN" })) };
      const verified = rebuildDomRecommendation(item, record, final.options);
      assert.ok(verified);
      final.decisions = [verified]; final.recommendations = [verified];
      await pin("finalRecommendations", final);
      delete request.artifacts.results;
    }
    request.proposed.excel.protected_rate_periods = [{ start_date: "2026-10-16", end_date: "2026-10-16" }];
    request.proposed.pricing.pricing.mandatoryScopedFloorsPlnDay = [{ groups: ["CDMV"], zones: ["TEST"],
      startDate: "2026-10-16", endDate: "2026-10-16", minDays: 2, maxDays: 2, minimumRatePlnDay: 110, overrideProtected: false }];
    const result = await adapter.runImpactPreview(request, { now: new Date() });
    assert.equal(result.after.activeRecommendationCount, 1, "newly protected dates must not acquire the scoped market floor");
    assert.equal(result.after.changeCount, 0, "the real export must preserve the protected rate");
  });
});

test("honors the configured import row ceiling without inventing a global ceiling", async (t) => {
  const { request } = await fixture(t);
  request.proposed.excel.max_import_rows = 4;
  await assert.rejects(adapter.runImpactPreview(request, { now }), { code: "engine_failed" });
  request.proposed.excel.max_import_rows = null;
  const result = await adapter.runImpactPreview(request, { now });
  assert.equal(result.limits.maxImportRows, null);
  assert.equal(result.limits.pickupDateExpansion.enabled, false);
});

test("accepts published degraded evidence and reports its gaps without a blanket preview ban", async (t) => {
  const { request, pin } = await fixture(t);
  const manifest = JSON.parse(await readFile(request.artifacts.runManifest.path, "utf8"));
  manifest.status = "degraded";
  await pin("runManifest", manifest);
  const result = await adapter.runImpactPreview(request, { now });
  assert.equal(result.status, "success");
  assert.equal(result.provenance.sourceStatus, "degraded");
});

test("real export FAIL validation cannot be mistaken for an eligible preview", async (t) => {
  const { request, pin } = await fixture(t);
  const path = request.artifacts.baselineWorkbook.path;
  execFileSync("python", [join(root, "tests/impact-preview-fixture.py"), path, "1", "missing-band"], { windowsHide: true });
  const hash = sha(await readFile(path));
  request.artifacts.baselineWorkbook.sha256 = hash;
  const manifest = JSON.parse(await readFile(request.artifacts.baselineManifest.path, "utf8"));
  manifest.workbook_sha256 = hash;
  await pin("baselineManifest", manifest);
  const run = JSON.parse(await readFile(request.artifacts.runManifest.path, "utf8"));
  run.baseline.workbook_sha256 = hash;
  await pin("runManifest", run);
  await assert.rejects(adapter.runImpactPreview(request, { now }), { code: "validation_failed" });
});

test("CLI returns machine-readable blocked evidence and a nonzero exit", async (t) => {
  const { request, dir } = await fixture(t);
  request.artifacts.baselineWorkbook.sha256 = "0".repeat(64);
  const path = join(dir, "request.json");
  await writeFile(path, JSON.stringify(request));
  const result = spawnSync(process.execPath, [join(root, "rules-panel/server/impact-preview.mjs"), "--request", path],
    { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "hash_mismatch");
});
