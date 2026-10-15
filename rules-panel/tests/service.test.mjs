import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../src/service.mjs";

const snapshot = { schemaVersion: 1, documents: {}, source: { policyHash: "hash" } };
const workspace = { snapshot, draft: null, preview: null, history: [], status: { available: false }, capabilities: { sharedDraft: true, publish: false, preview: true } };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("unconfigured endpoint falls back to snapshot but a remote failure never does", async () => {
  const calls = [];
  const local = createService(async (url) => { calls.push(url); return url === "/api/workspace" ? reply({}, 404) : reply(snapshot); });
  assert.equal((await local.workspace()).capabilities.sharedDraft, false);
  assert.deepEqual(calls, ["/api/workspace", "/policy-snapshot.json"]);
  const failed = createService(async () => reply({ error: "Brak dostępu" }, 403));
  await assert.rejects(failed.workspace(), /Brak dostępu/);
});

test("save sends immutable expected and source revisions and trimmed mandatory reason", async () => {
  let body;
  const service = createService(async (url, options) => { assert.equal(url, "/api/draft"); assert.equal(options.headers["X-Panel-Request"], "1"); assert.equal(options.credentials, "same-origin"); body = JSON.parse(options.body); return reply(workspace); });
  await assert.rejects(service.save({ reason: "  a " }), /3.*500/);
  await service.save({ expectedRevision: "draft-a", sourceRevision: "main-a", sourceHash: "hash-a", model: { value: 42 }, reason: "  Korekta sezonu  " });
  assert.deepEqual(body, { expectedRevision: "draft-a", sourceRevision: "main-a", sourceHash: "hash-a", model: { value: 42 }, reason: "Korekta sezonu" });
});

test("409 exposes conflict and server message without automatic retry", async () => {
  let count = 0;
  const service = createService(async () => { count++; return reply({ error: "Nowszy szkic", revision: "new" }, 409); });
  await assert.rejects(service.save({ expectedRevision: "old", reason: "Zmiana minimum" }), (error) => error.code === "DRAFT_CONFLICT" && error.status === 409 && /Nowszy szkic/.test(error.message));
  assert.equal(count, 1);
});

test("preview can queue without pretending the workspace was refreshed", async () => {
  const service = createService(async (url, options) => { assert.equal(url, "/api/preview"); assert.deepEqual(JSON.parse(options.body), { draftRevision: "draft-a" }); return reply({ queued: true, draftRevision: "draft-a" }); });
  assert.deepEqual(await service.preview("draft-a"), { queued: true, draftRevision: "draft-a" });
});

test("publish and rollback have separate revision-bound payloads", async () => {
  const calls = [];
  const service = createService(async (url, options) => { calls.push([url, JSON.parse(options.body)]); return reply(url === "/api/publish" ? { revision: "main-b", url: "https://github.com/a/b/commit/main-b" } : workspace); });
  assert.equal((await service.publish("draft-a", "preview-a")).revision, "main-b");
  await service.rollback("history-a", "draft-a");
  assert.deepEqual(calls, [["/api/publish", { draftRevision: "draft-a", previewRevision: "preview-a" }], ["/api/rollback", { revision: "history-a", expectedRevision: "draft-a" }]]);
});
