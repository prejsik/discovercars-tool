const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const { spawnSync } = require('node:child_process');
const { publicationDecision } = require('../src/publicationPolicy');
const { buildTelegramSummary } = require('../src/telegramSummary');

const candidate = { status: 'success', source_started_at: '2026-10-01T07:00:00Z', generated_at: '2026-10-01T12:00:00Z' };
assert.equal(publicationDecision(candidate, null).promote, true);
assert.equal(publicationDecision(candidate, { source_started_at: '2026-10-01T08:00:00Z' }).promote, false);
assert.equal(publicationDecision(candidate, { source_started_at: '2026-10-01T06:00:00Z', generated_at: '2026-10-01T13:00:00Z' }).promote, true);
assert.equal(publicationDecision(candidate, { generated_at: '2026-10-01T08:00:00Z' }).promote, false);
assert.equal(publicationDecision(candidate, candidate).promote, true);
assert.throws(() => publicationDecision({}, null), /timestamp/);
assert.throws(() => publicationDecision(candidate, {}), /timestamp/);

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/discovercars-daily.yml'), 'utf8').replaceAll('\r\n', '\n');
const ci = fs.readFileSync(path.join(root, '.github/workflows/discovercars-ci.yml'), 'utf8');
const job = (name) => workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [a-z][a-z_-]*:\n/)[0] || '';
const pipeline = YAML.parse(workflow);
assert.deepEqual(Object.keys(pipeline.jobs), ['gate', 'prepare', 'collect', 'scrape', 'verify', 'assemble', 'publish']);
assert.equal(pipeline.env.SCHEDULE_ROLLING_DAYS, '45');
assert.equal(pipeline.jobs.prepare.needs, 'gate');
assert.equal(pipeline.jobs.collect.needs, 'prepare');
assert.equal(pipeline.jobs.collect.strategy['max-parallel'], 2);
assert.equal(pipeline.jobs.collect.strategy['fail-fast'], false);
assert.deepEqual(pipeline.jobs.scrape.needs, ['gate', 'prepare', 'collect']);
assert.match(pipeline.jobs.scrape.if, /always\(\)/);
assert.doesNotMatch(pipeline.jobs.scrape.if, /needs.prepare.result == 'success'/);
assert.equal(pipeline.jobs.collect.steps.find(step => step.name === 'Run scraper')['continue-on-error'], true);
assert.equal(pipeline.jobs.collect.steps.find(step => step.name === 'Upload collection checkpoint').if, 'always()');
assert.match(pipeline.jobs.collect.steps.find(step => step.name === 'Preserve collection failure for job retry').if, /steps.collection.outcome == 'failure'/);
assert.equal(pipeline.jobs.prepare.steps.find(step => step.name === 'Restore immutable collection plan for retry').if, 'github.run_attempt > 1');
assert.match(pipeline.jobs.prepare.steps.find(step => step.name === 'Freeze requested scrape scope').run, /-f output\/collection-plan.json && -f output\/scrape-scope.json/);
assert.equal(pipeline.jobs.scrape.steps.find(step => step.name === 'Download collection plan')['continue-on-error'], true);
assert.doesNotMatch(pipeline.jobs.scrape.steps.find(step => step.name === 'Upload scraper checkpoint').with.path, /^output\s*$|raw-shards/);
assert.match(pipeline.jobs.scrape.steps.find(step => step.name === 'Upload scraper checkpoint').with.path, /output\/previous-full-final-pricing-recommendations.json/);
assert.equal(pipeline.jobs.verify.strategy['max-parallel'], 4);
assert.deepEqual(pipeline.jobs.assemble.needs, ['scrape', 'verify']);
assert.deepEqual(pipeline.jobs.publish.needs, ['scrape', 'assemble']);
assert.equal(pipeline.jobs.publish.concurrency.group, 'discovercars-pages-site');
const publishSteps = pipeline.jobs.publish.steps;
const telegramStep = publishSteps.find(step => step.name === 'Notify Telegram');
assert.equal((telegramStep.run.match(/\/sendMessage"/g) ?? []).length, 1);
assert.doesNotMatch(telegramStep.run, /sendDocument|--attachments/);
const firstPublication = publishSteps.find(step => step.id === 'pages-first');
const retryPublication = publishSteps.find(step => step.id === 'pages-retry');
assert.ok(firstPublication && retryPublication, 'the publish job must have a bounded automatic retry');
assert.equal(firstPublication['continue-on-error'], true);
assert.equal(retryPublication.uses, firstPublication.uses);
assert.notEqual(firstPublication.with.attempt, retryPublication.with.attempt);
assert.match(retryPublication.if, /steps\.pages-first\.outcome == 'failure'/);
assert.ok(publishSteps.indexOf(retryPublication) < publishSteps.findIndex(step => step.name === 'Notify Telegram'));
const publicationSource = fs.readFileSync(path.join(root, firstPublication.uses, 'action.yml'), 'utf8');
const publicationAction = YAML.parse(publicationSource);
assert.equal(publicationAction.runs.using, 'composite');
for (const name of fs.readdirSync(path.join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name))) {
  const definition = YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
  if (!/^(discovercars-|rules-panel-preview\.)/.test(name)) continue;
  for (const [jobName, jobDefinition] of Object.entries(definition.jobs)) {
    if (!jobDefinition.steps?.some(step => /\bplaywright\s+install\b/.test(step.run || ''))) continue;
    assert.equal(jobDefinition['runs-on'], 'ubuntu-24.04',
      `${name}/${jobName} must pin a runner OS supported by the locked Playwright version`);
  }
}
const bash = process.platform === 'win32'
  ? [process.env.GIT_BASH_PATH, path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')]
    .find(value => value && fs.existsSync(value))
  : 'bash';
assert(bash, 'Git Bash is required to check workflow shell scripts');
for (const [name, definition] of [...Object.entries(pipeline.jobs), ['publication action', publicationAction.runs]]) {
  const needs = [definition.needs || []].flat();
  const ids = definition.steps.map(step => step.id).filter(Boolean);
  for (const expression of JSON.stringify(definition).match(/\$\{\{.*?\}\}/g) || []) {
    for (const match of expression.matchAll(/needs\.([\w-]+)\./g)) {
      assert(needs.includes(match[1]), `${name} references undeclared dependency ${match[1]}`);
    }
    for (const match of expression.matchAll(/steps\.([\w-]+)\./g)) {
      assert(ids.includes(match[1]), `${name} references unknown step ${match[1]}`);
    }
  }
  for (const step of definition.steps.filter(step => step.run)) {
    const script = step.run.replace(/\$\{\{[\s\S]*?\}\}/g, 'test-value');
    const result = spawnSync(bash, ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(result.status, 0, `${name}/${step.name}: ${result.stderr}`);
  }
}
assert.doesNotMatch(workflow.split('\njobs:')[0], /\n  push:/);
assert.doesNotMatch(workflow.split('\njobs:')[0], /\nconcurrency:/);
assert.match(ci, /\n  push:/);
assert.match(ci, /npm run test:all/);
assert.doesNotMatch(ci, /TELEGRAM|deploy-pages|pages: write/);
assert.match(job('gate'), /group: discovercars-schedule-claim/);
assert.match(job('gate'), /Record scheduled run claim/);
assert.match(job('prepare'), /node src\/scrapeScope\.js/);
assert.match(job('prepare'), /src\/scrapeShards.js plan/);
assert.match(job('prepare'), /name: Upload collection plan/);
assert.match(job('collect'), /src\/scrapeShards.js run/);
assert.match(job('collect'), /name: Restore collection checkpoint/);
assert.match(job('collect'), /name: Upload collection checkpoint/);
assert.match(job('collect'), /--restore-dir=/);
assert.doesNotMatch(job('collect'), /--reset-state/);
assert.match(job('scrape'), /src\/scrapeShards.js merge/);
assert.match(job('scrape'), /--scope=output\/scrape-scope.json/);
assert.match(job('scrape'), /--workload=output\/recommendation-workload.json/);
assert.match(job('verify'), /fail-fast: false/);
assert.match(job('verify'), /max-parallel: 4/);
assert.match(job('verify'), /fromJSON\(needs.scrape.outputs.shard_matrix/);
assert.match(job('verify'), /--checkpoint=/);
assert.match(job('verify'), /name: Upload verification checkpoint/);
assert.doesNotMatch(job('verify'), /deploy-pages/);
assert.match(job('assemble'), /recommendationDomShards.js merge/);
assert.match(job('assemble'), /name: Generate Excel import workbook/);
assert.match(job('assemble'), /--scope=output\/scrape-scope.json/);
assert.doesNotMatch(job('assemble'), /concurrency:|deploy-pages/);
assert.match(job('publish'), /group: discovercars-pages-site/);
assert.match(publicationSource, /src\/publicationPolicy.js/);
assert.match(publicationSource, /Could not preserve/);
assert.doesNotMatch(job('publish') + publicationSource, /verifyActiveRecommendationsDom.js|tools\/update_excel_rates.py|src\/scrapeShards.js/);
assert.doesNotMatch(job('assemble') + job('publish'), /quality\.outputs\.status \|\| needs\.scrape\.outputs\.scrape_quality_status/);
assert.match(job('assemble'), /name: Withhold unvalidated workbooks/);
assert.match(publicationSource, /--validate-only=pages/);

function workflowValue(value, context) {
  const evaluate = expression => Function('github', 'steps', 'needs', 'inputs', 'success', 'always', 'failure', 'cancelled', `return (${expression.replace(/steps\.([\w-]+)/g, 'steps["$1"]')});`)(
    context.github, context.steps, context.needs, context.inputs, () => !context.failed, () => true, () => Boolean(context.failed), () => false
  );
  if (typeof value !== 'string') return value;
  const expression = value.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (expression) return evaluate(expression[1]);
  return value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, inner) => String(evaluate(inner)));
}

function stepRuns(step, context) {
  const condition = step.if || 'true';
  const hasStatusCheck = /\b(?:always|success|failure|cancelled)\s*\(/.test(condition);
  return (hasStatusCheck || !context.failed) && workflowValue(`\${{ ${condition} }}`, context);
}

function simulatePublication({ runAttempt = '1', artifacts = [], failures = {}, pagesEnabled = true, bundleReady = true } = {}) {
  const context = {
    github: { run_id: '456', run_attempt: runAttempt },
    steps: { bundle: { outcome: bundleReady ? 'success' : 'failure' } },
    needs: { scrape: { outputs: { should_run: 'true', pages_enabled: String(pagesEnabled),
      scrape_quality_status: 'success', schedule_key: 'night-2026-10-01' } },
      assemble: { outputs: { quality_status: 'success', excel_artifact_url: 'https://example.test/excel' } } },
    failed: false
  };
  const snapshots = new Map(artifacts.map(name => [name, name]));
  const attempts = [];
  const deployed = [];
  const messages = [];
  const responses = (attempt) => ({
    run_report_url: `https://example.test/public/report?${attempt}`,
    excel_url: `https://example.test/public/import?${attempt}`
  });
  const manifest = { run_id: '456', excel_files: { 'rates-import-ready.xlsx': 'a'.repeat(64) } };
  let recorded = false;
  for (const step of publishSteps) {
    if (step === firstPublication || step === retryPublication) {
      let outcome = 'skipped';
      const attempt = step.with.attempt;
      const local = { ...context, inputs: { attempt }, steps: {}, failed: false };
      if (stepRuns(step, context)) {
        attempts.push(attempt);
        for (const inner of publicationAction.runs.steps) {
          let result = 'skipped';
          if (stepRuns(inner, local)) {
            result = failures[attempt] === inner.id ? 'failure' : 'success';
            if (inner.id === 'pages-upload') {
              const name = workflowValue(inner.with.name, local);
              if (snapshots.has(name)) result = 'failure';
              if (result === 'success') snapshots.set(name, name);
            } else if (inner.id === 'pages-deployment') {
              const name = workflowValue(inner.with.artifact_name, local);
              assert.ok(snapshots.has(name), 'cannot deploy an artifact not uploaded by this snapshot');
              if (result === 'success') deployed.push(name);
            }
            if (result === 'failure' && inner['continue-on-error'] !== true) local.failed = true;
          }
          local.steps[inner.id] = { outcome: result };
        }
        outcome = local.failed ? 'failure' : 'success';
      }
      // The preparation can emit URLs even if deploy later fails.
      context.steps[step.id] = { outcome, outputs: local.steps['pages-site']?.outcome === 'success' ? responses(attempt) : {} };
      if (outcome === 'failure' && step['continue-on-error'] !== true) context.failed = true;
    }
    if (step.name === 'Notify Telegram' && stepRuns(step, context)) {
      const env = { GITHUB_RUN_ID: '456', QUALITY_STATUS: 'success', ARTIFACT_URL: 'https://example.test/results', EXCEL_ARTIFACT_URL: 'https://example.test/excel' };
      for (const key of ['PAGES_PUBLICATION_FAILED', 'PAGE_URL', 'PAGES_EXCEL_URL']) {
        env[key] = String(workflowValue(step.env[key], context));
      }
      messages.push(buildTelegramSummary({ env, manifest, reportAvailable: true, excelAvailable: true }));
    }
    if (step.name === 'Record published scheduled report') recorded = stepRuns(step, context);
  }
  assert.equal(messages.length, 1, 'send one notification after the publication attempts');
  return { artifacts: [...snapshots.keys()], attempts, deployed, failed: context.failed, message: messages[0], recorded };
}

const first = simulatePublication();
assert.deepEqual(first.attempts, ['1']);
assert.deepEqual(first.deployed, ['github-pages-456-1-1']);
assert.equal(first.recorded, true);
assert.match(first.message, /^DiscoverCars\n/);

for (const stage of ['pages-site', 'pages-validation', 'pages-configure', 'pages-upload', 'pages-deployment']) {
  const recovered = simulatePublication({ failures: { '1': stage } });
  assert.deepEqual(recovered.attempts, ['1', '2']);
  assert.deepEqual(recovered.deployed, ['github-pages-456-1-2']);
  assert.equal(recovered.failed, false);
  assert.equal(recovered.recorded, true);
  assert.match(recovered.message, /^DiscoverCars\n/);
  assert.match(recovered.message, /^Import: https:\/\/[^/]+\/api\/report\/file\?kind=import&runId=456&sha256=a{64}$/m);

  const exhausted = simulatePublication({ failures: { '1': stage, '2': stage }, runAttempt: '2', artifacts: first.artifacts });
  assert.deepEqual(exhausted.attempts, ['1', '2']);
  assert.deepEqual(exhausted.deployed, []);
  assert.equal(exhausted.failed, true);
  assert.equal(exhausted.recorded, false);
  assert.match(exhausted.message, /^DiscoverCars \| Import gotowy, panel jeszcze nieodświeżony\n/);
  assert.match(exhausted.message, /Import \(ZIP z GitHuba, wymaga logowania\): https:\/\/example\.test\/excel/);
  assert.doesNotMatch(exhausted.message, /example\.test\/public/);
  console.log(`PASS publication retry accepts recovery or warns once after repeated ${stage} failure`);
}
const resumed = simulatePublication({ runAttempt: '2', artifacts: first.artifacts });
assert.deepEqual(resumed.deployed, ['github-pages-456-2-1']);
assert.deepEqual(resumed.artifacts, ['github-pages-456-1-1', 'github-pages-456-2-1']);
for (const prerequisites of [{ pagesEnabled: false }, { bundleReady: false }]) {
  const skipped = simulatePublication(prerequisites);
  assert.deepEqual(skipped.attempts, []);
  assert.deepEqual(skipped.deployed, []);
  assert.equal(skipped.recorded, false);
}
assert.match(buildTelegramSummary({ env: { QUALITY_STATUS: 'failure', PAGES_PUBLICATION_FAILED: 'true' } }), /^DiscoverCars \| BŁĄD\n/);
const preflightFailureMessage = buildTelegramSummary({
  env: { QUALITY_STATUS: 'success', PREPARATION_FAILURE_STAGE: 'excel_preflight' },
  qualityAlerts: { status: 'failure', blocking_alerts: ['Brak pliku results-latest.json.'] }
});
assert.match(preflightFailureMessage, /Powód: Testy Excela/);
assert.doesNotMatch(preflightFailureMessage, /Brak pliku results-latest/);
assert.match(buildTelegramSummary({
  env: { QUALITY_STATUS: 'success', PREPARATION_FAILURE_STAGE: 'preparation' },
  qualityAlerts: { status: 'success' }, excelAvailable: true, reportAvailable: true
}), /^DiscoverCars \| BŁĄD\n/);

const optionsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'discovercars-options-'));
try {
  for (const [override, expectedDays] of [['45', '45'], ['20', '20'], ['', '2']]) {
    const output = path.join(optionsDirectory, `options-${expectedDays}`);
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-s'], {
      cwd: root, input: pipeline.jobs.prepare.steps.find(step => step.id === 'options').run,
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, GITHUB_OUTPUT: output.replaceAll('\\', '/'), SCHEDULE_ROLLING_DAYS: pipeline.env.SCHEDULE_ROLLING_DAYS,
        SCHEDULE_DURATIONS: pipeline.env.SCHEDULE_DURATIONS, SCHEDULE_SPEED_MODE: pipeline.env.SCHEDULE_SPEED_MODE,
        INPUT_LOCATIONS: 'Warsaw Train Station', INPUT_ROLLING_DAYS: '2', INPUT_START_DATES: '', INPUT_DURATIONS: '1',
        INPUT_SPEED_MODE: 'safe', RUN_TYPE: override ? 'full' : 'manual', SCHEDULE_ROLLING_OVERRIDE: override }
    });
    assert.equal(result.status, 0, result.stderr);
    const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split(/\r?\n/).map(line => line.split('=')));
    assert.equal(values.rolling_days, expectedDays);
    assert.equal(values.durations, override ? pipeline.env.SCHEDULE_DURATIONS : '1');
    assert.equal(values.speed_mode, override ? 'fast' : 'safe');
    assert.equal(values.locations, override ? require('../src/locationRegistry').getDailyLocations().join(',') : 'Warsaw Train Station');
  }
  const failureStep = pipeline.jobs.prepare.steps.find(step => step.id === 'preparation-failure');
  assert(failureStep, 'preparation failures must reach the Telegram notification');
  for (const [label, failed, excelOutcome, regressionOutcome, expectedReason] of [
    ['scheduled preflight', true, 'failure', 'skipped', /Testy Excela/],
    ['manual regression', true, 'skipped', 'failure', /Testy regresji/],
    ['setup failure', true, 'skipped', 'skipped', /przygotowanie/],
    ['successful preparation', false, 'success', 'skipped', null]
  ]) {
    const context = { failed, steps: { 'excel-preflight': { outcome: excelOutcome }, regression: { outcome: regressionOutcome } } };
    const output = path.join(optionsDirectory, `failure-${excelOutcome}-${regressionOutcome}`);
    let stage = '';
    if (workflowValue(`\${{ ${failureStep.if} }}`, context)) {
      const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-s'], {
        cwd: root, input: failureStep.run, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, GITHUB_OUTPUT: output.replaceAll('\\', '/'),
          ...Object.fromEntries(Object.entries(failureStep.env).map(([key, value]) => [key, workflowValue(value, context)])) }
      });
      assert.equal(result.status, 0, result.stderr);
      stage = fs.readFileSync(output, 'utf8').trim().slice('stage='.length);
    }
    context.steps['preparation-failure'] = { outputs: { stage } };
    const prepareStage = workflowValue(pipeline.jobs.prepare.outputs.preparation_failure_stage, context);
    context.needs = { prepare: { outputs: { preparation_failure_stage: prepareStage } } };
    const scrapeStage = workflowValue(pipeline.jobs.scrape.outputs.preparation_failure_stage, context);
    context.needs.scrape = { outputs: { preparation_failure_stage: scrapeStage } };
    const notification = pipeline.jobs.publish.steps.find(step => step.name === 'Notify Telegram');
    const telegramStage = workflowValue(notification.env.PREPARATION_FAILURE_STAGE, context);
    const message = buildTelegramSummary({
      env: { QUALITY_STATUS: failed ? 'failure' : 'success', PREPARATION_FAILURE_STAGE: telegramStage,
        ARTIFACT_URL: 'https://example.test/results', EXCEL_ARTIFACT_URL: 'https://example.test/excel' },
      qualityAlerts: failed ? { status: 'failure', blocking_alerts: ['Brak pliku results-latest.json.'] } : { status: 'success' },
      excelAvailable: !failed, reportAvailable: !failed
    });
    if (failed) {
      assert.match(message, /^DiscoverCars \| BŁĄD\n/, label);
      assert.match(message, expectedReason, label);
      assert.match(message, /Scraper nie został uruchomiony/, label);
      assert.doesNotMatch(message, /Brak pliku results-latest/, label);
    } else {
      assert.equal(telegramStage, '', label);
      assert.match(message, /^DiscoverCars\n/, label);
    }
    console.log(`PASS preparation failure notification: ${label}`);
  }
  const retainedDirectory = path.join(optionsDirectory, 'retained-attempt');
  fs.mkdirSync(path.join(retainedDirectory, 'output'), { recursive: true });
  const retainedFiles = {
    'scrape-scope.json': require('../src/scrapeScope').buildScrapeScope({ locations: 'Warsaw', startDates: '2026-10-02', durations: '2' }),
    'results-latest.json': { scenarios: [{ start_date: '2026-10-02', rental_days: 2, errors: [],
      top_3_plus_mm_by_location: { Warsaw: { top_3: [{ provider_name: 'Other', currency: 'PLN', total_price: 200 }],
        mm_cars_rental: { provider_name: 'MM Cars Rental', currency: 'PLN', total_price: 220 } } } }] },
    'final-pricing-recommendations.json': { recommendations: [{ action: 'increase' }] },
    'excel-rate-update-summary.json': { change_count: 1, validation: [{ status: 'OK' }] }
  };
  for (const [name, data] of Object.entries(retainedFiles)) fs.writeFileSync(path.join(retainedDirectory, 'output', name), JSON.stringify(data));
  for (const name of ['rates-import-ready.xlsx', 'rates-updated.xlsx']) fs.writeFileSync(path.join(retainedDirectory, 'output', name), 'retained-workbook');
  const qualityStep = pipeline.jobs.assemble.steps.find(step => step.id === 'quality');
  const context = { failed: false, needs: { scrape: { outputs: {
    should_run: 'true', locations: 'Warsaw', preparation_failure_stage: 'excel_preflight'
  } } } };
  const qualityRun = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-s'], {
    cwd: retainedDirectory,
    input: workflowValue(qualityStep.run, context).replace('node src/workflowQualityAlerts.js', `node "${path.join(root, 'src/workflowQualityAlerts.js').replaceAll('\\', '/')}"`),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GITHUB_OUTPUT: path.join(retainedDirectory, 'actions-output').replaceAll('\\', '/'),
      ...Object.fromEntries(Object.entries(qualityStep.env).map(([key, value]) => [key, workflowValue(value, context)])) }
  });
  assert.equal(qualityRun.status, 0, qualityRun.stderr);
  const retainedQuality = JSON.parse(fs.readFileSync(path.join(retainedDirectory, 'output', 'quality-alerts.json'), 'utf8'));
  assert.equal(retainedQuality.top3_coverage_percent, 100);
  assert.equal(retainedQuality.status, 'failure');
  assert.match(retainedQuality.blocking_alerts[0], /Testy Excela/);
  context.steps = { quality: { outputs: { status: retainedQuality.status } } };
  const withholdStep = pipeline.jobs.assemble.steps.find(step => step.name === 'Withhold unvalidated workbooks');
  assert.equal(workflowValue(`\${{ ${withholdStep.if} }}`, context), true);
  const withholdRun = spawnSync(bash, ['-e', '-c', withholdStep.run], { cwd: retainedDirectory, encoding: 'utf8' });
  assert.equal(withholdRun.status, 0, withholdRun.stderr);
  for (const name of ['rates-import-ready.xlsx', 'rates-updated.xlsx']) assert.equal(fs.existsSync(path.join(retainedDirectory, 'output', name)), false);
  const excelUpload = pipeline.jobs.assemble.steps.find(step => step.id === 'upload-excel');
  assert.equal(workflowValue(`\${{ ${excelUpload.if} }}`, context), false);
  const finalGate = pipeline.jobs.publish.steps.find(step => step.name === 'Enforce final quality gate');
  const finalRun = spawnSync(bash, ['-e', '-c', finalGate.run], { encoding: 'utf8', env: { ...process.env, QUALITY_STATUS: retainedQuality.status } });
  assert.notEqual(finalRun.status, 0);
  console.log('PASS preparation failure blocks retained workbooks, Excel upload and the final publication gate');
} finally { fs.rmSync(optionsDirectory, { recursive: true, force: true }); }

let publicationCases = 0;
function checkPublication({ reportTime, excelTime, failedPath, failedStatus = '500', candidateMissing, invalidDigest,
  qualityStatus = 'success', candidateStatus = qualityStatus, previousStaging = false, verify }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discovercars-publish-'));
  const write = (file, value) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  try {
    if (previousStaging) write('pages/latest-smoke/leftover.json', 'from an incomplete first attempt');
    write('output/run-manifest.json', { ...candidate, status: candidateStatus,
      ...(invalidDigest ? { excel_files: { 'rates-import-ready.xlsx': 'incorrect' } } : {}) });
    for (const file of ['report.html', 'run-log.txt', 'rates-updated.xlsx', 'rates-import-ready.xlsx']) {
      if (file !== candidateMissing) write(`output/${file}`, 'new');
    }
    for (const file of ['results-latest.json', 'quality-alerts.json', 'final-pricing-recommendations.json']) write(`output/${file}`, {});
    if (reportTime) {
      write('remote/latest-full/run-manifest.json', { source_started_at: reportTime });
      write('remote/latest-full/report.html', 'existing-report');
      for (const file of ['results-latest.json', 'quality-alerts.json']) write(`remote/latest-full/${file}`, {});
      for (const file of ['rates-import-ready.xlsx', 'rates-updated.xlsx']) write(`remote/latest-full/${file}`, 'old');
      write('remote/index.html', 'existing-report');
      write('remote/report.html', 'existing-report');
    }
    if (excelTime) {
      write('remote/latest-excel/run-manifest.json', { source_started_at: excelTime });
      write('remote/latest-excel/rates-import-ready.xlsx', 'existing-import');
      write('remote/latest-excel/rates-updated.xlsx', 'existing-review');
    }
    const fakeCurl = `curl() {
      local destination url rel
      while (( $# )); do
        case "$1" in
          --output) destination="$2"; shift 2 ;;
          --write-out|--header|--retry|--max-time) shift 2 ;;
          https:*) url="$1"; shift ;;
          *) shift ;;
        esac
      done
      rel="\${url#https://example.test/}"
      rel="\${rel%%\\?*}"
      if [[ "$rel" == "$FAILED_PATH" ]]; then printf 'error' > "$destination"; printf '%s' "$FAILED_STATUS"; return 0; fi
      if [[ -f "remote/$rel" ]]; then cp "remote/$rel" "$destination"; printf '200';
      else printf '' > "$destination"; printf '404'; fi
    }\n`;
    let script = publicationAction.runs.steps.find(step => step.id === 'pages-site').run;
    script = script.replace('node src/publicResults.js output/results-latest.json output/results-public.json', 'cp output/results-latest.json output/results-public.json')
      .replace('node src/publicationPolicy.js', `node "${path.join(root, 'src/publicationPolicy.js').replaceAll('\\', '/')}"`);
    if (qualityStatus === 'failure') script = pipeline.jobs.assemble.steps.find(step => step.name === 'Withhold unvalidated workbooks').run + '\n' + script;
    script += `\nnode "${path.join(root, 'src/publicationPolicy.js').replaceAll('\\', '/')}" --validate-only=pages\n`;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-s'], {
      cwd: directory, input: fakeCurl + script, encoding: 'utf8', timeout: process.platform === 'win32' ? 120000 : 30000,
      env: { ...process.env, RUN_TYPE: 'full', PAGE_URL: 'https://example.test/', QUALITY_STATUS: qualityStatus,
        GITHUB_OUTPUT: path.join(directory, 'actions-output').replaceAll('\\', '/'), GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1',
        PAGES_PUBLICATION_TRY: previousStaging ? '2' : '1', FAILED_PATH: failedPath || '-', FAILED_STATUS: failedStatus }
    });
    const read = file => fs.readFileSync(path.join(directory, file), 'utf8');
    assert(!result.error, result.error?.message);
    verify({ result, read, exists: file => fs.existsSync(path.join(directory, file)) });
    console.log(`PASS publication bundle case ${++publicationCases}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
checkPublication({
  reportTime: '2026-10-01T08:00:00Z', excelTime: '2026-10-01T08:00:00Z',
  verify({ result, read }) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read('pages/latest-full/report.html'), 'existing-report');
    assert.equal(read('pages/latest-excel/rates-import-ready.xlsx'), 'existing-import');
    assert.equal(read('pages/index.html'), 'existing-report');
    assert.doesNotMatch(read('actions-output'), /run_report_url=|excel_url=/);
  }
});
checkPublication({
  reportTime: '2026-10-01T06:00:00Z', excelTime: '2026-10-01T08:00:00Z',
  verify({ result, read }) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read('pages/latest-full/report.html'), 'new');
    assert.equal(read('pages/latest-excel/rates-import-ready.xlsx'), 'existing-import');
    assert.match(read('actions-output'), /run_report_url=/);
    assert.doesNotMatch(read('actions-output'), /excel_url=/);
  }
});
checkPublication({
  reportTime: '2026-10-01T06:00:00Z', excelTime: '2026-10-01T06:00:00Z', previousStaging: true,
  verify({ result, read, exists }) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(exists('pages/latest-smoke/leftover.json'), false);
    assert.equal(read('pages/latest-full/report.html'), 'new');
    assert.equal(read('pages/latest-excel/rates-import-ready.xlsx'), 'new');
    assert.match(read('actions-output'), /excel_url=/);
  }
});
checkPublication({
  failedPath: 'latest-smoke/run-manifest.json', failedStatus: '503',
  verify({ result }) { assert.notEqual(result.status, 0); assert.match(result.stdout, /Could not preserve .*HTTP 503/); }
});
checkPublication({
  excelTime: '2026-10-01T06:00:00Z', failedPath: 'latest-excel/rates-import-ready.xlsx', failedStatus: '404',
  verify({ result }) { assert.notEqual(result.status, 0); assert.match(result.stderr, /Missing publication file/); }
});
checkPublication({
  excelTime: '2026-10-01T06:00:00Z', candidateMissing: 'rates-import-ready.xlsx',
  verify({ result, read }) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing publication file/);
    assert.equal(read('pages/latest-excel/rates-import-ready.xlsx'), 'existing-import');
    assert.equal(JSON.parse(read('pages/latest-excel/run-manifest.json')).source_started_at, '2026-10-01T06:00:00Z');
  }
});
checkPublication({
  invalidDigest: true,
  verify({ result }) { assert.notEqual(result.status, 0); assert.match(result.stderr, /Workbook checksum mismatch/); }
});
checkPublication({
  qualityStatus: 'failure', candidateStatus: 'success',
  verify({ result }) { assert.notEqual(result.status, 0); }
});
checkPublication({
  qualityStatus: 'failure', reportTime: '2026-10-01T06:00:00Z', excelTime: '2026-10-01T06:00:00Z',
  verify({ result, read, exists }) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(read('pages/latest-full/run-manifest.json')).status, 'failure');
    assert.equal(exists('pages/latest-full/rates-import-ready.xlsx'), false);
    assert.equal(exists('output/rates-updated.xlsx'), false);
    assert.equal(read('pages/latest-excel/rates-import-ready.xlsx'), 'existing-import');
    assert.doesNotMatch(read('actions-output'), /excel_url=/);
  }
});
console.log('PASS: publication freshness and isolated production pipeline contracts.');
