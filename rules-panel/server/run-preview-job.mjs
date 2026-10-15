import { readFile, writeFile, appendFile, mkdtemp, mkdir, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decryptEnvelope, encryptEnvelope } from "./preview-crypto.mjs";
import { readSnapshot } from "./snapshot.mjs";
import { validateModel } from "../src/policy.mjs";
import { runImpactPreview, hashJson, publicErrorMessage } from "./impact-preview.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const PAGE = "https://prejsik.github.io/discovercars-tool/latest-full/";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code, message) => { throw Object.assign(new Error(publicErrorMessage(code)), { code }); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

export async function validateEncryptedRequest(encoded, { secret, previewId, githubSha, snapshot, now = new Date() }) {
  let request;
  try { request = await decryptEnvelope(encoded, secret, 45000); }
  catch { fail("invalid_envelope", "Preview request authentication failed."); }
  return validateRequest(request, { previewId, githubSha, snapshot, now });
}

function validateRequest(request, { previewId, githubSha, snapshot, now }) {
  check(request?.schemaVersion === 1 && UUID.test(request.previewId) && UUID.test(request.draftRevision)
    && /^[a-f0-9]{40}$/.test(request.sourceRevision), "invalid_request", "Invalid immutable preview identity.");
  check(request.previewId === previewId, "identity_mismatch", "Dispatch and encrypted preview identities differ.");
  check(request.sourceRevision === githubSha && request.sourceRevision === snapshot.source.revision
    && request.sourceHash === snapshot.source.policyHash, "source_changed", "Main or source documents changed after the draft was saved.");
  check(request.baselineSha256 === snapshot.baseline.sha256, "baseline_mismatch", "The pinned baseline changed.");
  check(request.modelHash === hashJson(request.model), "model_hash_mismatch", "The saved model hash does not match.");
  const age = now.getTime() - Date.parse(request.requestedAt);
  check(Number.isFinite(age) && age >= 0 && age <= 60 * 60 * 1000, "request_expired", "Preview request is expired or future-dated.");
  check(validateModel(request.model, snapshot.documents).errors.length === 0, "invalid_model", "Model contains invalid or noneditable settings.");
  return request;
}

export async function writeEncryptedResult(result, { secret, directory }) {
  const encrypted = await encryptEnvelope(result, secret);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "preview.enc"), encrypted, { mode: 0o600, flag: "wx" });
}

async function download(name, runId, fetcher = fetch, destination = null, base = PAGE) {
  const url = new URL(name, base);
  url.searchParams.set("preview", runId);
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(30000), cache: "no-store" });
  const maximum = destination ? 256 * 1024 * 1024 : 64 * 1024 * 1024;
  check(response.ok && Number(response.headers.get("content-length") ?? 0) <= maximum,
    "evidence_unavailable", `Published ${name} is unavailable or exceeds its input safety bound.`);
  let size = 0;
  const chunks = [];
  const file = destination ? await open(destination, "wx", 0o600) : null;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      check(size <= maximum, "evidence_unavailable", `Published ${name} exceeds its input safety bound.`);
      if (file) await file.writeFile(chunk);
      else chunks.push(chunk);
    }
  } finally { await file?.close(); }
  if (file) return size;
  return Buffer.concat(chunks);
}

async function evidence(directory, request, snapshot, runId, fetcher = fetch) {
  const artifacts = {};
  const pin = async (name, bytes) => {
    const path = join(directory, `${name}.${name === "baselineWorkbook" ? "xlsx" : "json"}`);
    await writeFile(path, bytes, { mode: 0o600 });
    artifacts[name] = { path, sha256: sha(bytes) };
  };
  const firstManifest = await download("run-manifest.json", runId, fetcher);
  const manifest = JSON.parse(firstManifest.toString("utf8"));
  check(manifest.baseline?.workbook_sha256 === request.baselineSha256, "baseline_mismatch", "Published evidence belongs to another baseline.");
  check(/^[a-f0-9]{40}$/.test(manifest.git_sha), "invalid_provenance", "Published evidence is missing an immutable source commit.");
  const pricingChanged = !isDeepStrictEqual(snapshot.documents.pricing, request.model.pricing);
  const sourceBase = `https://raw.githubusercontent.com/prejsik/discovercars-tool/${manifest.git_sha}/`;
  const policyProof = { revision: manifest.git_sha, hashes: {} };
  const sourceFiles = [["pricing-rules.config.example.json", snapshot.documents.pricing],
    ["locations.config.json", snapshot.documents.locations],
    ["input/broker-markup-frozen.json", JSON.parse(await readFile(join(root, "input/broker-markup-frozen.json"), "utf8"))]];
  for (const [name, current] of sourceFiles) {
    const bytes = await download(name, runId, fetcher, null, sourceBase);
    check(isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), current),
      "source_changed", "Published pricing, locations or frozen calibration differ from the current pinned documents.");
    policyProof.hashes[name] = sha(bytes);
  }
  await pin("runManifest", firstManifest);
  await pin("baselineWorkbook", await readFile(join(root, "input/mm-cars-rental-rates-inclusive-fp.xlsx")));
  await pin("baselineManifest", await readFile(join(root, "input/baseline-manifest.json")));
  const original = join(directory, "published-final.json");
  await download("final-pricing-recommendations.json", runId, fetcher, original);
  const normalized = join(directory, "normalized-final.json");
  try {
    await exec(process.env.PYTHON ?? "python", [join(root, "rules-panel/server/impact_normalize.py"), original, normalized],
      { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" } });
  } catch { fail("inconsistent_recommendations", "Published final recommendations failed streaming evidence validation."); }
  await pin("finalRecommendations", await readFile(normalized));
  await pin("calibration", await readFile(join(root, "input/broker-markup-frozen.json")));
  if (pricingChanged) await pin("results", await download("results-latest.json", runId, fetcher));
  check(sha(firstManifest) === sha(await download("run-manifest.json", runId, fetcher)),
    "publication_race", "Published evidence changed during download.");
  return { artifacts, policyProof };
}

async function runTests() {
  // Test output may contain financial fixtures on failure. Capture it, never relay it to public Actions logs.
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
  delete env.PANEL_PREVIEW_KEY;
  delete env.PANEL_PREVIEW_REQUEST;
  const commands = [["npm", ["run", "test:all"], root],
    ["npm", ["test"], join(root, "rules-panel")], ["npm", ["run", "test:engine"], join(root, "rules-panel")]];
  for (const [command, args, cwd] of commands) {
    try { await exec(command, args, { cwd, env, windowsHide: true, timeout: 600000, maxBuffer: 8 * 1024 * 1024 }); }
    catch { fail("tests_failed", "The required regression test suite failed. Publication is blocked."); }
  }
}

export async function runLocalPreview(draft, { previewId, requestedAt = new Date().toISOString(), fetcher = fetch }) {
  const snapshot = await readSnapshot();
  const request = validateRequest({ schemaVersion: 1, ...draft, previewId,
    draftRevision: draft.revision ?? draft.draftRevision, requestedAt },
  { previewId, githubSha: snapshot.source.revision, snapshot, now: new Date() });
  const directory = await mkdtemp(join(tmpdir(), "rules-panel-local-preview-"));
  const identity = { schemaVersion: 1, previewId, revision: previewId, draftRevision: request.draftRevision,
    sourceRevision: request.sourceRevision, sourceHash: request.sourceHash, modelHash: request.modelHash,
    baselineSha256: request.baselineSha256, runId: `local-${previewId}`, testsSucceeded: false };
  try {
    const { artifacts, policyProof } = await evidence(directory, request, snapshot, identity.runId, fetcher);
    const preview = await runImpactPreview({ schemaVersion: 1, draftRevision: request.draftRevision,
      sourceRevision: request.sourceRevision, runId: identity.runId,
      current: snapshot.documents, proposed: request.model, artifacts });
    return { ...preview, ...identity, provenance: { ...preview.provenance, policyProof }, completedAt: new Date().toISOString(),
      limitations: [...preview.limitations, "Podglad lokalny nie potwierdza testow GitHub Actions i nie uprawnia do publikacji."] };
  } catch (error) {
    return { ...identity, status: "blocked", dataCollectedAt: null, completedAt: new Date().toISOString(),
      error: { code: error.code ?? "evidence_unavailable", message: publicErrorMessage(error.code) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  const secret = process.env.PANEL_PREVIEW_KEY;
  const snapshot = await readSnapshot();
  const request = await validateEncryptedRequest(process.env.PANEL_PREVIEW_REQUEST,
    { secret, previewId: process.env.PANEL_PREVIEW_ID, githubSha: process.env.GITHUB_SHA, snapshot });
  if (process.argv[2] === "validate") {
    check(Boolean(process.env.GITHUB_OUTPUT), "invalid_environment", "A workflow output file is required.");
    await appendFile(process.env.GITHUB_OUTPUT, `source_revision=${request.sourceRevision}\n`);
    process.stdout.write("Authenticated preview request validated.\n");
    return;
  }
  check(process.argv[2] === "run" && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
    && Boolean(process.env.RUNNER_TEMP), "invalid_environment", "A trusted preview job environment is required.");
  const directory = await mkdtemp(join(tmpdir(), "rules-panel-job-"));
  let result;
  const identity = { schemaVersion: 1, previewId: request.previewId, revision: request.previewId,
    draftRevision: request.draftRevision, sourceRevision: request.sourceRevision, sourceHash: request.sourceHash,
    modelHash: request.modelHash, baselineSha256: request.baselineSha256, runId: process.env.GITHUB_RUN_ID };
  try {
    const { artifacts, policyProof } = await evidence(directory, request, snapshot, process.env.GITHUB_RUN_ID);
    const preview = await runImpactPreview({ schemaVersion: 1, draftRevision: request.draftRevision,
      sourceRevision: request.sourceRevision, runId: process.env.GITHUB_RUN_ID,
      current: snapshot.documents, proposed: request.model, artifacts });
    check(preview.modelHash === request.modelHash && preview.sourceHash === request.sourceHash,
      "source_changed", "Preview hashes changed during export.");
    await runTests();
    result = { ...preview, ...identity, provenance: { ...preview.provenance, policyProof }, testsSucceeded: true, completedAt: new Date().toISOString() };
  } catch (error) {
    result = { ...identity, status: "blocked", testsSucceeded: false, dataCollectedAt: null,
      completedAt: new Date().toISOString(), error: { code: error.code ?? "preview_failed",
        message: publicErrorMessage(error.code) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
  await writeEncryptedResult(result, { secret, directory: join(process.env.RUNNER_TEMP, "rules-panel-preview") });
  process.stdout.write(result.status === "success" ? "Encrypted preview completed.\n" : "Encrypted preview is blocked.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Preview job rejected. No plaintext details were logged.\n"); process.exitCode = 1; });
}
