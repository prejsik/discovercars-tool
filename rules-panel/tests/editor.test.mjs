import test from "node:test";
import assert from "node:assert/strict";
import { locationOptions, filterRules, floorRequest, publishBlocker } from "../src/editor.mjs";

test("location choices show Polish labels with each Excel code", () => {
  assert.deepEqual(locationOptions({ locations: { locations: [
    { id: "gdansk_airport", city: "Gdansk", kind: "airport", zones: ["GDLO"] },
    { id: "wroclaw_train_station", city: "Wroclaw", kind: "city", zones: ["WRDW", "WR2"] },
  ] } }).map(({ value, label }) => [value, label]), [["GDLO", "Gdańsk · Lotnisko (GDLO)"], ["WRDW", "Wrocław · Dworzec kolejowy (WRDW)"], ["WR2", "Wrocław · Dworzec kolejowy (WR2)"]]);
});

test("publication requires a current saved draft, independent of impact preview", () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  const workspace = { capabilities: { publish: true }, snapshot: { source: { revision: "main-a", policyHash: "hash-a" }, baseline: { sha256: "base-a" } }, draft: { revision: "draft-a", modelHash: "model-a" }, preview: { revision: "preview-a", draftRevision: "draft-a", sourceRevision: "main-a", sourceHash: "hash-a", baselineSha256: "base-a", modelHash: "model-a", status: "success", testsSucceeded: true, completedAt: "2026-10-15T09:30:00Z", dataCollectedAt: "2026-10-15T08:00:00Z" } };
  Object.assign(workspace.draft, { sourceRevision: 'main-a', sourceHash: 'hash-a', baselineSha256: 'base-a' });
  assert.equal(publishBlocker(workspace, now), "");
  assert.equal(publishBlocker({ ...workspace, preview: null }), "");
  for (const patch of [{ draftRevision: "other" }, { sourceRevision: "other" }, { sourceHash: "other" }, { modelHash: "other" }, { baselineSha256: "other" }, { testsSucceeded: false }, { status: "running" }, { error: "failed" }, { completedAt: "2026-10-15T08:59:59Z" }, { dataCollectedAt: "2026-10-14T09:59:59Z" }, { dataCollectedAt: "2026-10-16T00:00:00Z" }]) {
    assert.equal(publishBlocker({ ...workspace, preview: { ...workspace.preview, ...patch } }, now), "");
  }
  assert.ok(publishBlocker({ ...workspace, capabilities: { publish: false } }, now));
  assert.ok(publishBlocker({ ...workspace, draft: null }));
  assert.ok(publishBlocker({ ...workspace, draft: { ...workspace.draft, sourceRevision: 'other' } }));
});

test("default view omits expired rules but keeps today and future", () => {
  const rows = [{ id: 1, endDate: "2026-10-14" }, { id: 2, endDate: "2026-10-15" }, { id: 3, startDate: "2026-12-01" }, { id: 4 }];
  assert.deepEqual(filterRules(rows, { today: "2026-10-15" }).map(({ id }) => id), [2, 3, 4]);
  assert.equal(filterRules(rows, { today: "2026-10-15", period: "all" }).length, 4);
  assert.deepEqual(filterRules(rows, { today: "2026-10-15", period: "expired" }).map(({ id }) => id), [1]);
});

test("matrix requires six complete bands and never widens selected scopes", () => {
  const request = floorRequest({ groups: ["CDMV", "EDAV"], zones: ["GDLO", "WRDW"], startDate: "2026-11-01", endDate: "2026-11-30", amounts: ["70", "80", "90", "100", "120", "150"] });
  assert.deepEqual(request, { groups: ["CDMV", "EDAV"], zones: ["GDLO", "WRDW"], startDate: "2026-11-01", endDate: "2026-11-30", bands: [{ minDays: 1, maxDays: 1, amount: 70 }, { minDays: 2, maxDays: 2, amount: 80 }, { minDays: 3, maxDays: 4, amount: 90 }, { minDays: 5, maxDays: 7, amount: 100 }, { minDays: 8, maxDays: 20, amount: 120 }, { minDays: 21, maxDays: 35, amount: 150 }], overrideProtected: false });
  assert.throws(() => floorRequest({ groups: [], zones: ["GDLO"], amounts: ["70"] }), /klas/);
  assert.throws(() => floorRequest({ groups: ["CDMV"], zones: [], amounts: ["70"] }), /lokalizac/);
  assert.throws(() => floorRequest({ groups: ["CDMV"], zones: ["GDLO"], amounts: [""] }), /stawk/);
  assert.throws(() => floorRequest({ groups: ["CDMV"], zones: ["GDLO"], amounts: ["-1"] }), /stawk/);
  assert.throws(() => floorRequest({ groups: ["CDMV"], zones: ["GDLO"], amounts: ["70", "80", "90", "100", "", "150"] }), /sześciu/);
});

test("new scoped minimum requires an explicit start and end date", () => {
  const input = { groups: ["CDMV"], zones: ["GDLO"], amounts: [70, 70, 70, 70, 70, 70] };
  assert.throws(() => floorRequest(input), /dat/);
  assert.throws(() => floorRequest({ ...input, startDate: "2026-11-01" }), /dat/);
  assert.throws(() => floorRequest({ ...input, endDate: "2026-11-30" }), /dat/);
});
