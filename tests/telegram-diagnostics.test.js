const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTelegramSummary } = require('../src/telegramSummary');

test('Telegram points at this exact run in the panel, never a mutable latest incident', () => {
  const summary = buildTelegramSummary({env:{QUALITY_STATUS:'failure',RUN_URL:'https://github.com/prejsik/discovercars-tool/actions/runs/12345'},qualityAlerts:{status:'failure',blocking_alerts:['Excel error']}});
  assert.match(summary,/Panel: https:\/\/discovercars-rules-panel\.bartek-prejs\.workers\.dev\/\?view=results&runId=12345/);
});
