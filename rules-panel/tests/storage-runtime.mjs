import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unstable_dev } from 'wrangler';
const directory = await mkdtemp(join(tmpdir(), 'rules-panel-do-'));
let worker;
const start = () => unstable_dev('tests/storage-worker.mjs', {
  config: 'tests/storage-wrangler.jsonc', local: true, ip: '127.0.0.1', port: 4325,
  persist: true, persistTo: directory, experimental: { disableExperimentalWarning: true },
});
try {
  worker = await start();
  const post = input => worker.fetch('/', { method: 'POST', body: JSON.stringify(input) }).then(response => response.json());
  const writes = await Promise.all([post({ expectedRevision: null, amount: 60 }), post({ expectedRevision: null, amount: 70 })]);
  assert.deepEqual(writes.map(item => item.status).sort(), [200, 409]);
  const first = writes.find(item => item.status === 200).draft;
  assert.equal(await (await worker.fetch('/?name=other')).json(), null);
  await worker.stop();
  worker = await start();
  const restored = await (await worker.fetch('/')).json();
  assert.equal(restored.revision, first.revision);
  assert.deepEqual(restored.model, first.model);
  console.log('SQLite runtime: concurrent edits protected, storage survives restart, workspaces isolated.');
} finally {
  if (worker) await worker.stop();
  await rm(directory, { recursive: true, force: true });
}
