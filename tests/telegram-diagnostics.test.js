const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTelegramSummary } = require('../src/telegramSummary');

test('exhausted Pages publication links to this run\'s ready Excel package', () => {
  const excelUrl = 'https://github.com/prejsik/discovercars-tool/actions/runs/12345/artifacts/123';
  const env = { QUALITY_STATUS: 'degraded', PAGES_PUBLICATION_FAILED: 'true', EXCEL_ARTIFACT_URL: excelUrl };
  const message = buildTelegramSummary({ env, excelAvailable: true });
  assert.match(message, /^DiscoverCars \| Excele gotowe, panel jeszcze nieodświeżony\n/);
  assert.ok(message.includes(`Pobierz nowe pliki (import i rekomendacje): ${excelUrl}`));
  assert.doesNotMatch(message, /BŁĄD PUBLIKACJI|latest-excel/);
  assert.match(buildTelegramSummary({ env, excelAvailable: false }), /BŁĄD PUBLIKACJI/);
  assert.match(buildTelegramSummary({ env: { ...env, EXCEL_ARTIFACT_URL: '' }, excelAvailable: true }), /BŁĄD PUBLIKACJI/);
  assert.match(buildTelegramSummary({ env, excelAvailable: true, qualityAlerts: { status: 'failure' } }), /^DiscoverCars \| BŁĄD\n/);
});

test('Telegram points at this exact run in the panel, never a mutable latest incident', () => {
  const summary = buildTelegramSummary({env:{QUALITY_STATUS:'failure',RUN_URL:'https://github.com/prejsik/discovercars-tool/actions/runs/12345'},qualityAlerts:{status:'failure',blocking_alerts:['Excel error']}});
  assert.match(summary,/Panel: https:\/\/discovercars-rules-panel\.bartek-prejs\.workers\.dev\/\?view=results&runId=12345/);
});
