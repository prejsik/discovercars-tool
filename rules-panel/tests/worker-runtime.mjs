import assert from 'node:assert/strict';
import { unstable_dev } from 'wrangler';

const worker = await unstable_dev('worker/entry.mjs', {
  config: 'wrangler.jsonc', local: true, ip: '127.0.0.1', port: 4320,
  vars: { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ACCESS_EMAILS: '' },
  experimental: { disableExperimentalWarning: true },
});
try {
  for (const path of ['/', '/index.html', '/policy-snapshot.json', '/assets/app.js', '/api/session']) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 503, `Unconfigured Worker must block ${path}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.doesNotMatch(await response.text(), /pricing|baseline|CDMV|<html/i);
  }
  console.log('Worker runtime: every asset blocked without Access configuration.');
} finally {
  await worker.stop();
}
