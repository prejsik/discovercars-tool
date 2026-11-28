const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTelegramSummary } = require('../src/telegramSummary');

const panel = 'https://discovercars-rules-panel.bartek-prejs.workers.dev';
const artifact = 'https://github.com/prejsik/discovercars-tool/actions/runs/12345/artifacts/123';
const digest = 'a'.repeat(64);
const options = {
  env: {
    QUALITY_STATUS: 'degraded',
    GITHUB_RUN_ID: '12345',
    PAGE_URL: 'https://example.test/report.html',
    PAGES_EXCEL_URL: 'https://example.test/latest-excel/rates-import-ready.xlsx',
    EXCEL_ARTIFACT_URL: artifact
  },
  manifest: { run_id: '12345', excel_files: { 'rates-import-ready.xlsx': digest } },
  excelAvailable: true
};

const links = message => message.match(/https:\/\/\S+/g);

test('published message contains only the run-bound import and the price panel', () => {
  const message = buildTelegramSummary(options);
  assert.deepEqual(links(message), [
    `${panel}/api/report/file?kind=import&runId=12345&sha256=${digest}`,
    `${panel}/?view=prices`
  ]);
  assert.match(message, /Stawki w Excelu.*Dlaczego\?/);
});

test('unpublished runs link the artifact and this run’s panel diagnostics in the same message', () => {
  for (const failed of ['true', 'false']) {
    const message = buildTelegramSummary({
      ...options,
      env: { ...options.env, PAGE_URL: '', PAGES_EXCEL_URL: '', ARTIFACT_URL: 'https://example.test/report.zip',
        PAGES_PUBLICATION_FAILED: failed },
      publicationDecision: { excel: { reason: 'newer_source_already_published' } }
    });
    assert.deepEqual(links(message), [artifact, `${panel}/?view=results&runId=12345`]);
    assert.match(message, /^Import \(ZIP z GitHuba, wymaga logowania\): /m);
    assert.match(message, /Panel nie pokazuje uzasadnień z tego przebiegu/);
  }
});

test('a missing or mismatched manifest falls back to the run artifact', () => {
  for (const manifest of [null, { ...options.manifest, run_id: '99999' }]) {
    const message = buildTelegramSummary({ ...options, manifest });
    assert.equal(links(message)[0], artifact);
    assert.doesNotMatch(message, /latest-excel|api\/report\/file/);
  }
});

test('missing or blocked import is never advertised as downloadable', () => {
  const blocked = buildTelegramSummary({ ...options, qualityAlerts: { status: 'failure' } });
  assert.deepEqual(links(blocked), [`${panel}/?view=results&runId=12345`]);
  const unavailable = buildTelegramSummary({
    ...options, env: { ...options.env, PAGES_EXCEL_URL: '', EXCEL_ARTIFACT_URL: '', PAGES_PUBLICATION_FAILED: 'true' }
  });
  assert.match(unavailable, /^DiscoverCars \| BŁĄD PUBLIKACJI/);
  assert.match(unavailable, /brak linku do pliku importowego/);
  assert.deepEqual(links(unavailable), [`${panel}/?view=results&runId=12345`]);
});
