const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildTelegramSummary, listTelegramAttachments } = require('../src/telegramSummary');

test('exhausted Pages publication attaches this run\'s ready Excel files', () => {
  const excelUrl = 'https://github.com/prejsik/discovercars-tool/actions/runs/12345/artifacts/123';
  const env = { QUALITY_STATUS: 'degraded', PAGES_PUBLICATION_FAILED: 'true', EXCEL_ARTIFACT_URL: excelUrl };
  const message = buildTelegramSummary({ env, excelAvailable: true });
  assert.match(message, /^DiscoverCars \| Excele gotowe, panel jeszcze nieodświeżony\n/);
  assert.match(message, /^Import i rekomendacje: pliki w załącznikach pod tą wiadomością\.$/m);
  assert.ok(message.includes(`Kopia w GitHub (ZIP, wymaga logowania): ${excelUrl}`));
  assert.doesNotMatch(message, /BŁĄD PUBLIKACJI|latest-excel/);
  assert.equal(listTelegramAttachments({ env, excelAvailable: true }).length, 2);
  assert.match(buildTelegramSummary({ env, excelAvailable: false }), /BŁĄD PUBLIKACJI/);
  // Attachments no longer depend on the GitHub artifact upload.
  const withoutArtifact = buildTelegramSummary({ env: { ...env, EXCEL_ARTIFACT_URL: '' }, excelAvailable: true });
  assert.match(withoutArtifact, /^DiscoverCars \| Excele gotowe, panel jeszcze nieodświeżony\n/);
  assert.doesNotMatch(withoutArtifact, /Kopia w GitHub/);
  assert.match(buildTelegramSummary({ env, excelAvailable: true, qualityAlerts: { status: 'failure' } }), /^DiscoverCars \| BŁĄD\n/);
});

test('Telegram points at this exact run in the panel, never a mutable latest incident', () => {
  const summary = buildTelegramSummary({env:{QUALITY_STATUS:'failure',RUN_URL:'https://github.com/prejsik/discovercars-tool/actions/runs/12345'},qualityAlerts:{status:'failure',blocking_alerts:['Excel error']}});
  assert.match(summary,/Panel: https:\/\/discovercars-rules-panel\.bartek-prejs\.workers\.dev\/\?view=results&runId=12345/);
});

test('Excel not promoted to Pages is attached in Telegram instead of a login-only artifact link', () => {
  const artifactUrl = 'https://github.com/prejsik/discovercars-tool/actions/runs/45445022628/artifacts/14987655699';
  // Night run 25.11.2026: a newer backup run already owned latest-excel, so Pages links were empty.
  const options = {
    env: { QUALITY_STATUS: 'degraded', PAGE_URL: '', PAGES_EXCEL_URL: '', PAGES_EXCEL_REPORT_URL: '',
      PAGES_PUBLICATION_FAILED: 'false', EXCEL_ARTIFACT_URL: artifactUrl,
      ARTIFACT_URL: 'https://github.com/prejsik/discovercars-tool/actions/runs/45445022628/artifacts/14987625862',
      PAGES_SITE_URL: 'https://prejsik.github.io/discovercars-tool/' },
    excelAvailable: true,
    reportAvailable: true,
    publicationDecision: { excel: { promote: false, reason: 'newer_source_already_published' } }
  };
  const message = buildTelegramSummary(options);
  assert.match(message, /^DiscoverCars\n/);
  assert.doesNotMatch(message, /^(Import|Rekomendacje): https:\/\/github\.com/m);
  assert.match(message, /^Import i rekomendacje: pliki w załącznikach pod tą wiadomością\.$/m);
  assert.match(message, /^Na stronie jest Excel z nowszego przebiegu: https:\/\/prejsik\.github\.io\/discovercars-tool\/latest-excel\/rates-import-ready\.xlsx$/m);
  assert.ok(message.includes(`Kopia w GitHub (ZIP, wymaga logowania): ${artifactUrl}`));
  assert.deepEqual(listTelegramAttachments(options, 'out'), [
    { label: 'Import', path: path.join('out', 'rates-import-ready.xlsx') },
    { label: 'Rekomendacje', path: path.join('out', 'rates-updated.xlsx') }
  ]);
});

test('Telegram attaches nothing when this run has public Pages links or no ready Excel', () => {
  const published = { env: { QUALITY_STATUS: 'success', PAGE_URL: 'r', PAGES_EXCEL_URL: 'https://example.test/import.xlsx',
    PAGES_EXCEL_REPORT_URL: 'https://example.test/rec.xlsx' }, excelAvailable: true, reportAvailable: true };
  assert.match(buildTelegramSummary(published), /^Import: https:\/\/example\.test\/import\.xlsx$/m);
  assert.deepEqual(listTelegramAttachments(published, 'out'), []);
  assert.deepEqual(listTelegramAttachments({ ...published, env: { QUALITY_STATUS: 'success' }, excelAvailable: false }, 'out'), []);
  assert.deepEqual(listTelegramAttachments({ ...published, env: { QUALITY_STATUS: 'failure' } }, 'out'), []);
});
