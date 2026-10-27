import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { createWorker } from '../worker/index.mjs';

const issuer = 'https://test-team.cloudflareaccess.com';
const audience = 'panel-audience';
const emails = ['owner@example.test', 'director@example.test', 'backup@example.test'];
const keys = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256' };
const worker = createWorker({ resolveKeys: () => createLocalJWKSet({ keys: [jwk] }) });

async function token(overrides = {}, privateKey = keys.privateKey) {
  return new SignJWT({ email: emails[0], type: 'app', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.iss ?? issuer).setAudience(overrides.aud ?? audience)
    .setSubject('user-id').setIssuedAt()
    .setExpirationTime(overrides.exp ?? '10m').sign(privateKey);
}

function setup(overrides = {}) {
  const requests = [];
  const env = {
    ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: audience,
    ACCESS_EMAILS: emails.join(','),
    ASSETS: { fetch: async request => {
      requests.push(request);
      return new Response('confidential-rules', { headers: { 'Content-Type': 'application/json' } });
    } }, ...overrides,
  };
  return { env, requests };
}

async function request(path = '/', jwt, options = {}) {
  return new Request(`https://panel.example.com${path}`, {
    ...options, headers: { ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}), ...options.headers },
  });
}

test('deployment routes every asset through auth and disables preview URLs', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.assets.directory, './dist');
});

for (const path of ['/', '/index.html', '/policy-snapshot.json', '/assets/app.js', '/api/session', '/api/baseline/check', '/api/baseline/publish', '/api/report/file', '/api/report-baseline/check', '/api/report-baseline/publish', '/api/scheduler']) {
  test(`anonymous request cannot read ${path}`, async () => {
    const { env, requests } = setup();
    const response = await worker.fetch(await request(path), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(requests.length, 0);
  });
}

test('scheduled events use a private coordination object and current Warsaw window, not a stale event time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T07:37:00Z') });
  const calls = [];
  const env = { SCRAPER_SCHEDULE_ENABLED: 'true', GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2',
    GITHUB_APP_PRIVATE_KEY: 'configured', PANEL_PREVIEW_KEY: 'configured',
    RULES_WORKSPACE: { getByName: name => ({ scheduleTick: async now => {
      calls.push({ name, now }); return { action: 'monitor' };
    } }) } };
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-21T07:37:00Z') }, env);
  assert.deepEqual(calls, [{name:'prejsik/discovercars-tool:scheduler',now:'2026-10-21T07:37:00.000Z'}]);
  t.mock.timers.setTime(Date.parse('2026-10-21T10:00:00Z'));
  await worker.scheduled({ scheduledTime: Date.parse('2026-10-21T07:37:00Z') }, env);
  await worker.scheduled({}, { ...env, SCRAPER_SCHEDULE_ENABLED: 'false' });
  assert.equal(calls.length, 1);
});

test('missing server configuration denies before asset lookup', async () => {
  for (const key of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ACCESS_EMAILS']) {
    const { env, requests } = setup({ [key]: '' });
    assert.equal((await worker.fetch(await request('/', await token()), env)).status, 503);
    assert.equal(requests.length, 0);
  }
});

for (const email of emails) {
  test(`signed approved identity can read all protected assets: ${email}`, async () => {
    const { env, requests } = setup();
    const response = await worker.fetch(await request('/policy-snapshot.json', await token({ email })), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'confidential-rules');
    assert.equal(requests.length, 1);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
}

for (const [name, overrides] of Object.entries({
  outsider: { email: 'outsider@example.test' },
  wrongIssuer: { iss: 'https://other.cloudflareaccess.com' },
  wrongAudience: { aud: 'other-application' },
  expired: { exp: 1 },
  serviceToken: { type: 'service' },
  missingEmail: { email: undefined },
})) {
  test(`denies ${name}`, async () => {
    const { env, requests } = setup();
    const response = await worker.fetch(await request('/', await token(overrides)), env);
    assert.equal(response.status, 403);
    assert.equal(requests.length, 0);
  });
}

test('forged signature and spoofed email headers do not grant access', async () => {
  const other = await generateKeyPair('RS256');
  const { env, requests } = setup();
  for (const jwt of [await token({}, other.privateKey), 'invalid.token', undefined]) {
    const response = await worker.fetch(await request('/', jwt, {
      headers: { 'cf-access-authenticated-user-email': emails[0] },
    }), env);
    assert.ok([401, 403].includes(response.status));
  }
  assert.equal(requests.length, 0);
});

test('authenticated writes are rejected without touching any assets', async () => {
  const { env, requests } = setup();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await worker.fetch(await request('/policy-snapshot.json', await token(), { method }), env);
    assert.equal(response.status, 405);
  }
  assert.equal(requests.length, 0);
});

test('session uses signed identity and never returns token', async () => {
  const { env, requests } = setup();
  const response = await worker.fetch(await request('/api/session', await token()), env);
  assert.deepEqual(await response.json(), { email: emails[0], publish: false });
  assert.equal(requests.length, 0);
});

test('shared mutations require same-origin JSON and forward only signed actor', async () => {
  const received = [];
  const { env } = setup({
    PANEL_WRITES_ENABLED: 'true', GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2', GITHUB_APP_PRIVATE_KEY: 'configured', PANEL_PREVIEW_KEY: 'configured',
    RULES_WORKSPACE: { getByName: name => ({ handle: async (...args) => { received.push({ name, args }); return { status: 200, body: { saved: true } }; } }) },
  });
  const jwt = await token({ email: emails[1] });
  const headers = { origin: 'https://panel.example.com', 'content-type': 'application/json', 'x-panel-request': '1' };
  for (const path of ['/api/draft', '/api/baseline/check', '/api/baseline/publish', '/api/report-baseline/check', '/api/report-baseline/publish', '/api/locations/search'])
    for (const patch of [{ origin: 'https://evil.example' }, { 'content-type': 'text/plain' }, { 'x-panel-request': '' }]) {
      const response = await worker.fetch(await request(path, jwt, { method: 'POST', headers: { ...headers, ...patch }, body: '{}' }), env);
      assert.equal(response.status, 403);
    }
  assert.equal(received.length, 0);
  const response = await worker.fetch(await request('/api/draft', jwt, { method: 'POST', headers, body: JSON.stringify({ actor: 'spoofed@example.com' }) }), env);
  assert.equal(response.status, 200);
  assert.equal(received[0].name, 'prejsik/discovercars-tool');
  assert.equal(received[0].args[2], emails[1]);
});

test('oversized authenticated API bodies never reach shared storage', async () => {
  let calls = 0;
  const { env } = setup({ PANEL_WRITES_ENABLED: 'true', GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2',
    GITHUB_APP_PRIVATE_KEY: 'configured', PANEL_PREVIEW_KEY: 'configured', RULES_WORKSPACE: { getByName: () => { calls++; } } });
  const response = await worker.fetch(await request('/api/draft', await token(), { method: 'POST',
    headers: { origin: 'https://panel.example.com', 'content-type': 'application/json', 'x-panel-request': '1' },
    body: JSON.stringify({ data: 'x'.repeat(300000) }) }), env);
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test('key service failure denies without returning implementation details', async () => {
  const broken = createWorker({ resolveKeys: () => { throw new Error('private error detail'); } });
  const { env, requests } = setup();
  const response = await broken.fetch(await request('/', await token()), env);
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /private error detail/);
  assert.equal(requests.length, 0);
});
