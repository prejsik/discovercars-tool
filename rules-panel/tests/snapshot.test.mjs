import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import { readSnapshot } from "../server/snapshot.mjs";

const panelRoot = fileURLToPath(new URL("../", import.meta.url));

test("snapshot contains source hashes and current rules without private paths or secrets", async () => {
  const snapshot = await readSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.source.policyHash, /^[a-f0-9]{64}$/);
  assert.match(snapshot.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(
    snapshot.documents.pricing.pricing.locationTypeFloorsPlnDay
      .minimumRatesByKind.city,
    60,
  );
  assert.equal(snapshot.documents.excel.max_recommendation_duration_days, 20);
  assert.ok(
    snapshot.documents.locations.locations.some((item) =>
      item.zones.includes("SZLO"),
    ),
  );
  assert.equal(snapshot.capabilities.publish, false);
  assert.equal(snapshot.capabilities.mode, "local");
  assert.equal(JSON.stringify(snapshot).includes("C:\\\\Users"), false);
  assert.deepEqual(Object.keys(snapshot.baseline).sort(), [
    "approvedAt",
    "filename",
    "sha256",
  ]);
});

test("same source produces a stable policy fingerprint", async () => {
  assert.equal(
    (await readSnapshot()).source.policyHash,
    (await readSnapshot()).source.policyHash,
  );
});

test("hosted preview declares Access authentication without changing policy or enabling publication", async () => {
  const local = await readSnapshot();
  const hosted = await readSnapshot({ mode: "hosted-preview" });
  assert.deepEqual(hosted.capabilities, {
    mode: "hosted-preview",
    authentication: "cloudflare-access",
    publish: false,
  });
  assert.deepEqual(local.capabilities, { mode: "local", publish: false });
  assert.deepEqual(hosted.documents, local.documents);
  assert.deepEqual(hosted.baseline, local.baseline);
  assert.equal(hosted.source.policyHash, local.source.policyHash);
  assert.equal(hosted.source.revision, local.source.revision);
});

test("production build emits a timestamped hosted preview snapshot", async () => {
  const startedAt = Date.now();
  const bundle = await build({
    root: panelRoot,
    logLevel: "silent",
    build: { write: false },
  });
  const asset = bundle.output.find(
    (item) => item.fileName === "policy-snapshot.json",
  );
  assert.ok(asset, "build must include the policy snapshot");
  const snapshot = JSON.parse(asset.source);
  assert.deepEqual(snapshot.capabilities, {
    mode: "hosted-preview",
    authentication: "cloudflare-access",
    publish: false,
  });
  const loadedAt = Date.parse(snapshot.source.loadedAt);
  assert.ok(loadedAt >= startedAt && loadedAt <= Date.now());
});

test("local dev serves a local read-only snapshot rather than claiming hosted authentication", async (t) => {
  const server = await createServer({
    root: panelRoot,
    logLevel: "silent",
    server: { port: 0, strictPort: false, open: false },
  });
  t.after(() => server.close());
  await server.listen();
  const response = await fetch(
    `http://127.0.0.1:${server.httpServer.address().port}/policy-snapshot.json`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).capabilities, {
    mode: "local",
    publish: false,
  });
});
