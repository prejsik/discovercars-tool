import test from 'node:test';
import assert from 'node:assert/strict';
import * as codec from '../server/preview-crypto.mjs';
const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
test('private preview envelope encrypts and authenticates JSON', async () => {
  assert.equal(typeof codec.encryptEnvelope, 'function');
  const payload = { previewId: crypto.randomUUID(), model: { secretDraft: 123 } };
  const first = await codec.encryptEnvelope(payload, key);
  const second = await codec.encryptEnvelope(payload, key);
  assert.notEqual(first, second);
  assert.ok(!first.includes('secretDraft'));
  assert.deepEqual(await codec.decryptEnvelope(first, key), payload);
  const changed = first.slice(0, 25) + (first[25] === 'A' ? 'B' : 'A') + first.slice(26);
  await assert.rejects(codec.decryptEnvelope(changed, key));
  await assert.rejects(codec.decryptEnvelope(first, btoa('x'.repeat(32))));
});
test('invalid keys and oversized payloads are refused before dispatch', async () => {
  await assert.rejects(codec.encryptEnvelope({}, 'not-a-key'));
  await assert.rejects(codec.encryptEnvelope({ data: 'x'.repeat(300000) }, key, 50000));
});
