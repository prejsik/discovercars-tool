import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot } from "../rules-panel/server/snapshot.mjs";
import { encryptEnvelope, decryptEnvelope } from "../rules-panel/server/preview-crypto.mjs";
import { hashJson } from "../rules-panel/server/impact-preview.mjs";

const job = await import("../rules-panel/server/run-preview-job.mjs").catch(() => ({}));
const now = new Date("2026-10-15T12:00:00Z");
const secret = randomBytes(32).toString("base64");
const previewId = "12345678-1234-4234-8234-123456789abc";

async function fixture() {
  const snapshot = await readSnapshot();
  const model = structuredClone(snapshot.documents);
  model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city += 1;
  const request = { schemaVersion: 1, previewId, draftRevision: "22345678-1234-4234-8234-123456789abc",
    sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash,
    modelHash: hashJson(model), baselineSha256: snapshot.baseline.sha256, model,
    requestedAt: "2026-10-15T11:59:00Z" };
  return { request, snapshot, options: { secret, previewId, githubSha: snapshot.source.revision, snapshot, now } };
}

test("encrypted job public validation API is available", () => {
  assert.equal(typeof job.validateEncryptedRequest, "function");
});

test("local preview callback is available without GitHub or plaintext persistence", () => {
  assert.equal(typeof job.runLocalPreview, "function");
});

test("authenticated request is bound to main checkout and the saved model", async () => {
  const { request, options } = await fixture();
  const encoded = await encryptEnvelope(request, secret, 45000);
  const result = await job.validateEncryptedRequest(encoded, options);
  assert.deepEqual(result, request);
});

test("rejects a main-head race before evidence or tests", async () => {
  const { request, options } = await fixture();
  const encoded = await encryptEnvelope(request, secret, 45000);
  await assert.rejects(job.validateEncryptedRequest(encoded, { ...options, githubSha: "0".repeat(40) }), { code: "source_changed" });
});

test("rejects authenticated but mismatched private identity and hashes", async () => {
  const { request, options } = await fixture();
  for (const [name, value, code] of [["previewId", "32345678-1234-4234-8234-123456789abc", "identity_mismatch"],
    ["modelHash", "0".repeat(64), "model_hash_mismatch"], ["sourceHash", "0".repeat(64), "source_changed"],
    ["baselineSha256", "0".repeat(64), "baseline_mismatch"], ["requestedAt", "2026-10-14T11:59:00Z", "request_expired"]]) {
    const encoded = await encryptEnvelope({ ...request, [name]: value }, secret, 45000);
    await assert.rejects(job.validateEncryptedRequest(encoded, options), { code });
  }
});

test("rejects tampered ciphertext and noneditable business model settings", async () => {
  const { request, options } = await fixture();
  const encoded = await encryptEnvelope(request, secret, 45000);
  const bytes = Buffer.from(encoded, "base64");
  bytes[20] ^= 1;
  await assert.rejects(job.validateEncryptedRequest(bytes.toString("base64"), options), { code: "invalid_envelope" });
  request.model.excel.min_excel_change_pln_day = 900;
  request.modelHash = hashJson(request.model);
  await assert.rejects(job.validateEncryptedRequest(await encryptEnvelope(request, secret, 45000), options), { code: "invalid_model" });
});

test("artifact writer emits only authenticated encrypted output, never cleartext prices", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "impact-job-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = { previewId, status: "blocked", testsSucceeded: false, confidentialPrice: 12345.67 };
  await job.writeEncryptedResult(result, { secret, directory });
  assert.deepEqual(await readdir(directory), ["preview.enc"]);
  const encoded = await readFile(join(directory, "preview.enc"), "utf8");
  assert.ok(!encoded.includes("confidentialPrice") && !encoded.includes("12345.67"));
  assert.deepEqual(await decryptEnvelope(encoded, secret), result);
});

test("local callback returns a blocked unpublished envelope for a foreign live baseline", async () => {
  const { request } = await fixture();
  const draft = { ...request, revision: request.draftRevision };
  const result = await job.runLocalPreview(draft, { previewId, requestedAt: new Date().toISOString(),
    fetcher: async () => new Response(JSON.stringify({ baseline: { workbook_sha256: "0".repeat(64) } })) });
  assert.equal(result.status, "blocked");
  assert.equal(result.testsSucceeded, false);
  assert.equal(result.previewId, previewId);
  assert.equal(result.error.code, "baseline_mismatch");
  assert.equal(result.before, undefined, "blocked evidence cannot return invented counts");
});

test("streaming reduction retains full decisions and verifies duplicate recommendation evidence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "impact-reduction-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const item = { location: "Test Airport", start_date: "2026-10-16", rental_days: 2,
    action: "increase", suggested_rate_pln_day: 99, dom_repricing: { offers: [{ provider: "Original", totalPrice: 200 }] } };
  const value = { source_generated_at: "2026-10-15T11:00:00Z", options: {}, decisions: [item], recommendations: [item] };
  const path = join(directory, "original.json");
  const output = join(directory, "normalized.json");
  await writeFile(path, JSON.stringify(value, null, 2));
  const command = fileURLToPath(new URL("../rules-panel/server/impact_normalize.py", import.meta.url));
  const result = spawnSync("python", [command, path, output], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const reduced = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(reduced.decisions, [item]);
  assert.deepEqual(reduced.recommendationKeys, [["Test Airport", "2026-10-16", 2]]);
  assert.equal(reduced.normalization.originalSha256, createHash("sha256").update(await readFile(path)).digest("hex"));
  value.recommendations[0] = { ...item, suggested_rate_pln_day: 20 };
  await writeFile(path, JSON.stringify(value));
  const invalid = spawnSync("python", [command, path, output], { encoding: "utf8", windowsHide: true });
  assert.notEqual(invalid.status, 0);
});

test("validate CLI authenticates before npm installation without node_modules or scraper imports", async (t) => {
  const { request, snapshot } = await fixture();
  request.requestedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), "impact-hermetic-validate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const files = ["rules-panel/server/run-preview-job.mjs", "rules-panel/server/preview-crypto.mjs",
    "rules-panel/server/impact-preview.mjs", "rules-panel/server/snapshot.mjs", "rules-panel/src/policy.mjs",
    "pricing-rules.config.example.json", "excel-rate-update.config.example.json", "locations.config.json", "input/baseline-manifest.json"];
  for (const file of files) {
    const path = join(directory, file);
    await mkdir(join(path, ".."), { recursive: true });
    await copyFile(join(root, file), path);
  }
  const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  await writeFile(join(directory, ".git"), `gitdir: ${gitDirectory}\n`);
  const result = spawnSync(process.execPath, [join(directory, "rules-panel/server/run-preview-job.mjs"), "validate"],
    { cwd: directory, encoding: "utf8", windowsHide: true, env: { ...process.env, NODE_PATH: "",
      PANEL_PREVIEW_KEY: secret, PANEL_PREVIEW_REQUEST: await encryptEnvelope(request, secret, 45000),
      PANEL_PREVIEW_ID: previewId, GITHUB_SHA: snapshot.source.revision, GITHUB_OUTPUT: join(directory, "workflow-output") } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(directory, "workflow-output"), "utf8"), `source_revision=${snapshot.source.revision}\n`);
});
