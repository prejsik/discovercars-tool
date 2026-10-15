import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../server/private-store.mjs';
function fakeStorage() {
  const values = new Map();
  const db = {
    get: async key => structuredClone(values.get(key)),
    put: async (key, value) => {
      if (typeof key === 'object') for (const [name, data] of Object.entries(key)) values.set(name, structuredClone(data));
      else values.set(key, structuredClone(value));
    },
    list: async ({ prefix, limit }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).sort().slice(0, limit)),
    transaction: async task => task(db),
  };
  return db;
}
test('private store persists drafts and append-only history across store instances', async () => {
  assert.equal(typeof storage.PrivateWorkspaceStore, 'function');
  const db = fakeStorage();
  const first = new storage.PrivateWorkspaceStore(db, {});
  const a = await first.saveDraft({ model: { price: 60 }, savedBy: 'director', reason: 'test', savedAt: new Date().toISOString() }, null);
  const second = new storage.PrivateWorkspaceStore(db, {});
  assert.equal((await second.draft()).revision, a.revision);
  const b = await second.saveDraft({ model: { price: 70 }, savedBy: 'owner', reason: 'update', savedAt: new Date().toISOString() }, a.revision);
  assert.equal((await second.history()).length, 2);
  assert.equal((await second.getRevision(a.revision)).model.price, 60);
  assert.notEqual(a.revision, b.revision);
  await assert.rejects(second.saveDraft({}, a.revision), error => error.status === 409);
});

test('a lost GitHub response cannot lose the original approval identity', async () => {
  const db = fakeStorage(); let receipt;
  const repository = { publish: async record => {
    receipt = { approvalId: record.approvalId, draftRevision: record.draft.revision, revision: 'a'.repeat(40), approvedAt: record.approvedAt };
    throw new Error('Response lost after GitHub accepted commit');
  } };
  const store = new storage.PrivateWorkspaceStore(db, repository);
  const input = { draft: { revision: crypto.randomUUID(), reason: 'Minimum', sourceRevision: 'b'.repeat(40) },
    preview: { revision: crypto.randomUUID() }, actor: 'director@example.test', approvedAt: new Date().toISOString() };
  await assert.rejects(store.publish(input));
  assert.ok(receipt.approvalId);
  const restarted = new storage.PrivateWorkspaceStore(db, repository);
  await restarted.reconcilePublication(receipt);
  await restarted.reconcilePublication(receipt);
  const final = (await restarted.history()).filter(entry => entry.action === 'publish');
  assert.equal(final.length, 1);
  assert.equal(final[0].actor, 'director@example.test');
  assert.equal(final[0].publishedRevision, 'a'.repeat(40));
});

for (const next of [{ previewId: 'a', status: 'success' }, { previewId: 'b', status: 'running' }]) {
  for (const pollingFails of [false, true]) {
    test(`polling cannot overwrite a concurrent ${next.previewId}/${next.status} result, error=${pollingFails}`, async () => {
      const db = fakeStorage();
      const pending = { previewId: 'a', status: 'running', requestedAt: new Date(Date.now() - 30000).toISOString() };
      await db.put('preview', pending);
      const repository = { pollPreview: async () => {
        await db.put('preview', next);
        if (pollingFails) throw new Error('Network interrupted');
        return pending;
      } };
      const store = new storage.PrivateWorkspaceStore(db, repository);
      assert.deepEqual(await store.preview(), next);
      assert.deepEqual(await db.get('preview'), next);
    });
  }
}
