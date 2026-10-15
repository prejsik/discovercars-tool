import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../server/snapshot.mjs';
import { updateRule, createModel } from '../src/policy.mjs';
import * as workspace from '../server/workspace-service.mjs';

const snapshot = await readSnapshot();
const actor = 'director@example.test';
const now = '2026-10-15T12:00:00Z';
function setup() {
  let draft = null;
  let preview = null;
  let published = null;
  let current = structuredClone(snapshot);
  const history = [];
  const records = new Map();
  let requests = 0;
  const store = {
    async snapshot() { return structuredClone(current); },
    async draft() { return structuredClone(draft); },
    async preview() { return structuredClone(preview); },
    async history() { return structuredClone(history); },
    async publication() { return published; },
    async status() { return { available: false }; },
    async saveDraft(record, expectedRevision) {
      assert.equal(draft?.revision ?? null, expectedRevision);
      draft = { ...record, revision: `${history.length + 1}`.padStart(40, '0') };
      history.unshift({ revision: draft.revision, actor: record.savedBy, reason: record.reason });
      records.set(draft.revision, structuredClone(draft));
      return structuredClone(draft);
    },
    async getRevision(revision) { return records.get(revision); },
    async requestPreview() { requests++; return { queued: true }; },
    async verifyPreview() { return true; },
    async publish(record) { published = { revision: 'b'.repeat(40), draftRevision: record.draft.revision }; return published; },
  };
  return { store, current, setPreview: value => { preview = value; },
    requests: () => requests, service: new workspace.WorkspaceService(store, { clock: () => new Date(now) }) };
}
function change(amount = 65) { return updateRule(createModel(snapshot.documents), 'location:city', { amount }); }
function input(model = change(), expectedRevision = null) {
  return { sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash, expectedRevision, model, reason: 'Zmiana minimum miejskiego' };
}

test('workspace service is an executable public interface', () => {
  assert.equal(typeof workspace.WorkspaceService, 'function');
});

test('save identifies actor server-side and rejects overwriting another revision', async () => {
  const { service } = setup();
  const result = await service.save(input(), actor);
  assert.equal(result.draft.savedBy, actor);
  assert.equal(result.draft.model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city, 65);
  await assert.rejects(service.save(input(change(66)), actor), error => error.status === 409);
});

test('baseline, location, parity, markup and unrelated config cannot be changed', async () => {
  for (const mutate of [model => { model.excel.input = 'evil.xlsx'; },
    model => { model.locations.locations[0].zones = ['HACK']; },
    model => { model.excel.group_price_parity.enabled = false; },
    model => { model.pricing.pricing.brokerMarkupMode = 'automatic'; }]) {
    const { service } = setup();
    const model = change(); mutate(model);
    await assert.rejects(service.save(input(model), actor), error => error.status === 422);
  }
});

test('stale source, blank reasons and no-op saves are rejected', async () => {
  const { service } = setup();
  await assert.rejects(service.save({ ...input(), sourceRevision: 'a'.repeat(40) }, actor), error => error.status === 409);
  await assert.rejects(service.save({ ...input(), reason: '' }, actor), error => error.status === 422);
  await assert.rejects(service.save(input(createModel(snapshot.documents)), actor), error => error.status === 422);
});

test('publish needs a current tested preview bound to exact draft, baseline and source', async () => {
  const { service, setPreview, current } = setup();
  const { draft } = await service.save(input(), actor);
  await assert.rejects(service.publish({ draftRevision: draft.revision }, actor), error => error.status === 409);
  const good = { revision: 'c'.repeat(40), draftRevision: draft.revision,
    sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash,
    modelHash: draft.modelHash, baselineSha256: snapshot.baseline.sha256,
    completedAt: now, dataCollectedAt: now, testsSucceeded: true, status: 'success', runId: '123' };
  for (const patch of [{ testsSucceeded: false }, { modelHash: 'wrong' }, { baselineSha256: 'wrong' },
    { dataCollectedAt: '2026-10-10T12:00:00Z' }, { completedAt: '2026-10-10T12:00:00Z' }]) {
    setPreview({ ...good, ...patch });
    await assert.rejects(service.publish({ draftRevision: draft.revision, previewRevision: good.revision }, actor), error => error.status === 409);
  }
  setPreview(good);
  current.baseline.sha256 = 'd'.repeat(64);
  await assert.rejects(service.publish({ draftRevision: draft.revision, previewRevision: good.revision }, actor), error => error.status === 409);
  current.baseline.sha256 = snapshot.baseline.sha256;
  const result = await service.publish({ draftRevision: draft.revision, previewRevision: good.revision }, actor);
  assert.equal(result.revision, 'b'.repeat(40));
});

test('rollback prepares a new draft and retains history without publishing', async () => {
  const { service, store } = setup();
  const first = (await service.save(input(change(65)), actor)).draft;
  const second = (await service.save(input(change(70), first.revision), actor)).draft;
  const restored = await service.rollback({ revision: first.revision, expectedRevision: second.revision }, actor);
  assert.notEqual(restored.draft.revision, first.revision);
  assert.equal(restored.draft.model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city, 65);
  assert.equal(restored.history.length, 3);
  assert.equal(await store.publication(), null);
});

test('preview dispatch checks current revision before doing external work', async () => {
  const { service, requests } = setup();
  const { draft } = await service.save(input(), actor);
  await assert.rejects(service.requestPreview({ draftRevision: 'a'.repeat(40) }, actor), error => error.status === 409);
  assert.equal(requests(), 0);
  await service.requestPreview({ draftRevision: draft.revision }, actor);
  assert.equal(requests(), 1);
});

test('accepted JSON key order cannot break stored draft fingerprint', async () => {
  const { service } = setup();
  const model = change();
  const { draft } = await service.save(input({ locations: model.locations, excel: model.excel, pricing: model.pricing }), actor);
  assert.equal(draft.modelHash, await workspace.hashJson(draft.model));
  await service.requestPreview({ draftRevision: draft.revision }, actor);
});
