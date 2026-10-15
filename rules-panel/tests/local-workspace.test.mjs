import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import * as local from '../server/local-workspace.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function previewFixture(t, previewRunner, directory) {
  const prefix = join(resolve(tmpdir()), 'rules-panel-preview-');
  const root = directory ?? await mkdtemp(prefix);
  if (!directory) t.after(async () => {
    assert.ok(resolve(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  const storage = new local.FileStorage(root);
  await storage.put('operational-status', { available: true, checkedAt: new Date().toISOString() });
  const middleware = local.localWorkspaceMiddleware({ directory: root, previewRunner });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(`${origin}/api/${path}`, body === undefined ? { signal: AbortSignal.timeout(5000) } : {
      signal: AbortSignal.timeout(5000),
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Panel-Request': '1' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const save = async (amount, expectedRevision = null) => {
    const { snapshot } = await request('workspace');
    const model = structuredClone(snapshot.documents);
    model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city = amount;
    return request('draft', { model, expectedRevision, sourceRevision: snapshot.source.revision,
      sourceHash: snapshot.source.policyHash, reason: `Test minimum ${amount}` });
  };
  return { root, storage, request, save };
}

function trackStorage(t) {
  const operations = [];
  for (const name of ['put', 'transaction']) {
    const original = local.FileStorage.prototype[name];
    t.mock.method(local.FileStorage.prototype, name, function (...args) {
      const operation = original.apply(this, args);
      operations.push(operation);
      return operation;
    });
  }
  return async () => {
    // Let runner callbacks enqueue their real file operations, including a skipped CAS.
    await new Promise(resolve => setImmediate(resolve));
    await Promise.all(operations);
  };
}
test('local development storage survives recreation and serializes transactions', async () => {
  assert.equal(typeof local.FileStorage, 'function');
  const root = await mkdtemp(join(tmpdir(), 'rules-panel-storage-'));
  try {
    const store = new local.FileStorage(root);
    await store.put('draft', { value: 0 });
    const other = new local.FileStorage(root);
    await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? store : other).transaction(async db => {
      const data = await db.get('draft');
      await new Promise(resolve => setTimeout(resolve, 2));
      await db.put('draft', { value: data.value + 1 });
    })));
    assert.equal((await new local.FileStorage(root).get('draft')).value, 10);
    await store.put({ 'audit:2': 2, 'audit:1': 1 });
    assert.deepEqual([...(await store.list({ prefix: 'audit:', limit: 1 })).values()], [1]);
    assert.equal(await store.get('absent'), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ['success', 'failure']) for (const nextStatus of ['running', 'success']) {
  test(`late preview A ${outcome} cannot overwrite ${nextStatus} preview B`, { timeout: 15000 }, async t => {
    const flush = trackStorage(t);
    const a = deferred(), b = deferred(), aStarted = deferred(), bStarted = deferred();
    let runs = 0;
    const fixture = await previewFixture(t, () => {
      runs++;
      if (runs === 1) { aStarted.resolve(); return a.promise; }
      bStarted.resolve(); return b.promise;
    });
    const first = await fixture.save(76);
    const previewA = await fixture.request('preview', { draftRevision: first.draft.revision });
    await aStarted.promise;
    const second = await fixture.save(77, first.draft.revision);
    const previewB = await fixture.request('preview', { draftRevision: second.draft.revision });
    await bStarted.promise;
    if (nextStatus === 'success') b.resolve({ status: 'success', draftRevision: second.draft.revision, marker: 'B' });
    await flush();
    const preserved = (await fixture.request('workspace')).preview;
    assert.equal(preserved.status, nextStatus);
    assert.equal(preserved.revision ?? preserved.previewId, previewB.previewId);
    if (outcome === 'success') a.resolve({ status: 'success', draftRevision: first.draft.revision, marker: 'A' });
    else a.reject(new Error('Preview A failed'));
    await flush();
    const { preview } = await fixture.request('workspace');
    assert.deepEqual(preview, preserved);
    assert.equal(preview.draftRevision, second.draft.revision);
    assert.notEqual(previewA.previewId, previewB.previewId);
    b.resolve({ status: 'success', draftRevision: second.draft.revision, marker: 'B' });
    await flush();
  });
}

for (const status of ['running', 'requesting', 'queued']) {
  test(`middleware restart interrupts orphaned ${status} preview and permits a new run`, { timeout: 15000 }, async t => {
    const flush = trackStorage(t);
    const first = await previewFixture(t, () => { throw new Error('Old runner must not start'); });
    const { draft } = await first.save(76);
    const previewId = crypto.randomUUID();
    await first.storage.put('preview', { previewId, draftRevision: draft.revision,
      sourceRevision: draft.sourceRevision, requestedAt: new Date().toISOString(), status, queued: true });
    const started = deferred(), result = deferred();
    const restarted = await previewFixture(t, () => { started.resolve(); return result.promise; }, first.root);
    const recovered = (await restarted.request('workspace')).preview;
    assert.equal(recovered.status, 'failure');
    assert.match(recovered.error, /przerwan.*restar/i);
    assert.equal(recovered.previewId, previewId);
    const next = await restarted.request('preview', { draftRevision: draft.revision });
    assert.notEqual(next.previewId, previewId);
    await started.promise;
    assert.equal((await restarted.request('workspace')).preview.status, 'running');
    result.resolve({ status: 'success', draftRevision: draft.revision });
    await flush();
    assert.equal((await restarted.request('workspace')).preview.revision, next.previewId);
  });
}

for (const outcome of ['success', 'failure']) {
  test(`old middleware ${outcome} callback cannot replace a restarted preview of the same draft`, { timeout: 15000 }, async t => {
    const flush = trackStorage(t);
    const a = deferred(), b = deferred(), aStarted = deferred(), bStarted = deferred();
    const first = await previewFixture(t, () => { aStarted.resolve(); return a.promise; });
    const { draft } = await first.save(76);
    const previewA = await first.request('preview', { draftRevision: draft.revision });
    await aStarted.promise;
    const restarted = await previewFixture(t, () => { bStarted.resolve(); return b.promise; }, first.root);
    assert.equal((await restarted.request('workspace')).preview.status, 'failure');
    const previewB = await restarted.request('preview', { draftRevision: draft.revision });
    await bStarted.promise;
    if (outcome === 'success') a.resolve({ status: 'success', draftRevision: draft.revision, marker: 'old middleware' });
    else a.reject(new Error('Old middleware failed'));
    await flush();
    const pending = (await restarted.request('workspace')).preview;
    assert.equal(pending.previewId, previewB.previewId);
    assert.equal(pending.status, 'running');
    assert.notEqual(previewA.previewId, previewB.previewId);
    b.resolve({ status: 'success', draftRevision: draft.revision, marker: 'new middleware' });
    await flush();
    const completed = (await restarted.request('workspace')).preview;
    assert.equal(completed.revision, previewB.previewId);
    assert.equal(completed.marker, 'new middleware');
  });
}

for (const status of ['success', 'failure']) {
  test(`middleware restart preserves terminal ${status} preview`, async t => {
    const fixture = await previewFixture(t, () => { throw new Error('No preview requested'); });
    const preview = { previewId: crypto.randomUUID(), status, completedAt: new Date().toISOString(), marker: 'unchanged' };
    await fixture.storage.put('preview', preview);
    assert.deepEqual((await fixture.request('workspace')).preview, preview);
    assert.deepEqual((await fixture.request('workspace')).preview, preview);
  });
}
