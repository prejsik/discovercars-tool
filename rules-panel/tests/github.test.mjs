import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../worker/github.mjs';
import { readSnapshot } from '../server/snapshot.mjs';
import { hashJson } from '../server/workspace-service.mjs';
const snapshot = await readSnapshot();
test('GitHub adapter publishes only two policy documents and an anonymous receipt atomically', async () => {
  assert.equal(typeof github.GitHubRepository, 'function');
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.startsWith('/git/commits/') && !options.method) return { tree: { sha: 'tree-before' } };
    if (path === '/git/trees') return { sha: 'tree-after' };
    if (path === '/git/commits') return { sha: 'c'.repeat(40) };
    if (path === '/git/refs/heads/main') return {};
    throw new Error(`Unexpected request ${path}`);
  };
  const repository = new github.GitHubRepository({}, { api });
  await repository.publish({ draft: { revision: 'private-id', sourceRevision: snapshot.source.revision,
    model: snapshot.documents, reason: 'PRIVATE REASON', savedBy: 'private@example.com' },
    preview: { revision: 'preview-id', runId: '123' }, actor: 'private@example.com', approvedAt: '2026-10-15T12:00:00Z' });
  const tree = calls.find(call => call.path === '/git/trees').body.tree;
  assert.deepEqual(tree.map(file => file.path).sort(), [
    'excel-rate-update.config.example.json', 'pricing-rules.config.example.json', 'rules-panel-publication.json',
  ]);
  const update = calls.at(-1);
  assert.equal(update.path, '/git/refs/heads/main');
  assert.equal(update.body.force, false);
  assert.deepEqual(calls.find(call => call.path === '/git/commits').body.parents, [snapshot.source.revision]);
  assert.ok(!JSON.stringify(calls).includes('private@example.com'));
  assert.ok(!JSON.stringify(calls).includes('PRIVATE REASON'));
});

test('preview verification rejects another workflow, SHA or incomplete run', async () => {
  const run = { status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40),
    path: '.github/workflows/rules-panel-preview.yml', display_title: 'Rules preview preview-id', event: 'workflow_dispatch' };
  const repository = new github.GitHubRepository({}, { api: async () => run });
  const preview = { runId: '123', previewId: 'preview-id', sourceRevision: 'a'.repeat(40) };
  assert.equal(await repository.verifyPreview(preview), true);
  for (const field of ['path', 'head_sha', 'conclusion', 'event', 'display_title']) {
    const old = run[field]; run[field] = 'wrong';
    assert.equal(await repository.verifyPreview(preview), false); run[field] = old;
  }
});

test('bounded reader rejects large upstream bodies', async () => {
  await assert.rejects(github.readLimited(new Response('x'.repeat(1025)), 1024));
  assert.equal(new TextDecoder().decode(await github.readLimited(new Response('ok'), 1024)), 'ok');
});

test('status reads actual-size manifests without promoting a generated workbook to baseline', async () => {
  const manifest = { generated_at: '2026-10-15T08:00:00Z', source_started_at: '2026-10-15T01:00:00Z', git_sha: 'a'.repeat(40), run_id: '123',
    quality: { details: 'x'.repeat(1400000) }, baseline: { workbook_sha256: 'wrong-generated-base' } };
  const result = await github.readOperationalStatus({ sha256: 'confirmed-base', importConfirmed: false }, async () => Response.json(manifest));
  assert.equal(result.available, true);
  assert.equal(result.baseline.sha256, 'confirmed-base');
  assert.equal(result.baseline.importConfirmed, false);
});

test('malformed status manifests are never reported as verified runs', async () => {
  assert.equal((await github.readOperationalStatus({}, async () => Response.json({}))).available, false);
});

test('publication identifies its actual commit after unrelated main changes', async () => {
  const receipt = { draftRevision: 'approved-draft', policyHash: await hashJson(snapshot.documents) };
  const publishedRevision = 'd'.repeat(40);
  const calls = [];
  const repository = new github.GitHubRepository({}, { api: async path => {
    calls.push(path);
    return [{ sha: publishedRevision }];
  } });
  repository.snapshot = async () => snapshot;
  repository.json = async () => receipt;
  const publication = await repository.publication();
  assert.equal(publication.revision, publishedRevision);
  assert.equal(publication.currentRevision, snapshot.source.revision);
  assert.equal(publication.policyMatchesCurrent, true);
  assert.ok(publication.url.endsWith(publishedRevision));
  assert.ok(calls[0].includes('path=rules-panel-publication.json'));
  assert.ok(calls[0].includes(`sha=${snapshot.source.revision}`));
  receipt.policyHash = 'changed-policy';
  assert.equal((await repository.publication()).policyMatchesCurrent, false);
});

test('missing publication history cannot claim the current HEAD published a rule', async () => {
  const repository = new github.GitHubRepository({}, { api: async () => [] });
  repository.snapshot = async () => snapshot;
  repository.json = async () => ({ draftRevision: 'approved-draft' });
  await assert.rejects(repository.publication(), /historii publikacji/);
});
