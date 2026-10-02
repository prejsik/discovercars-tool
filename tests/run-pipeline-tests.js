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
for (const name of fs.readdirSync(path.join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name))) {
  YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
}
const bash = process.platform === 'win32'
  ? [process.env.GIT_BASH_PATH, path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')]
    .find(value => value && fs.existsSync(value))
  : 'bash';
assert(bash, 'Git Bash is required to check workflow shell scripts');
for (const [name, definition] of Object.entries(pipeline.jobs)) {
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
assert.match(job('publish'), /src\/publicationPolicy.js/);
assert.match(job('publish'), /Could not preserve/);
assert.doesNotMatch(job('publish'), /verifyActiveRecommendationsDom.js|tools\/update_excel_rates.py/);
assert.doesNotMatch(job('assemble') + job('publish'), /quality\.outputs\.status \|\| needs\.scrape\.outputs\.scrape_quality_status/);
assert.match(job('assemble'), /name: Withhold unvalidated workbooks/);
assert.match(job('publish'), /--validate-only=pages/);

function workflowValue(value, context) {
  const evaluate = expression => Function('github', 'steps', 'needs', 'success', 'always', `return (${expression.replace(/steps\.([\w-]+)/g, 'steps["$1"]')});`)(
    context.github, context.steps, context.needs, () => !context.failed, () => true
  );
  if (typeof value !== 'string') return value;
  const expression = value.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (expression) return evaluate(expression[1]);
  return value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, inner) => String(evaluate(inner)));
}

function pagesRetry({ attempt, artifacts = [], uploadFails = false, validationFails = false, configurationFails = false, deploymentFails = false }) {
  const validation = pipeline.jobs.publish.steps.find(step => step.name === 'Validate completed Pages bundles');
  const configuration = pipeline.jobs.publish.steps.find(step => step.name === 'Configure GitHub Pages');
  const context = {
    github: { run_id: '456', run_attempt: attempt },
    failed: (validationFails && validation['continue-on-error'] !== true) || (configurationFails && configuration['continue-on-error'] !== true),
    steps: { 'pages-site': { outcome: 'success', outputs: {} }, 'pages-validation': { outcome: validationFails ? 'failure' : 'success' },
      'pages-configure': { outcome: validationFails ? 'skipped' : configurationFails ? 'failure' : 'success' } },
    needs: { scrape: { outputs: { should_run: 'true', pages_enabled: 'true', scrape_quality_status: 'success' } },
      assemble: { outputs: { quality_status: 'success' } } }
  };
  const retainedArtifacts = [...artifacts];
  let deploymentRequests = 0;
  let deployedSnapshot = null;
  for (const step of pipeline.jobs.publish.steps.filter(item => /actions\/(upload-pages-artifact|deploy-pages)@/.test(item.uses || ''))) {
    const condition = step.if || 'true';
    const statusCheck = /\b(?:always|success|failure|cancelled)\s*\(/.test(condition);
    const allowed = (statusCheck || !context.failed) && workflowValue(`\${{ ${condition} }}`, context);
    let outcome = 'skipped';
    if (allowed) {
      outcome = 'success';
      const inputName = step.uses.startsWith('actions/upload-pages-artifact') ? 'name' : 'artifact_name';
      const artifactName = workflowValue(step.with?.[inputName] || 'github-pages', context);
      if (inputName === 'name') {
        if (uploadFails || retainedArtifacts.some(artifact => artifact.name === artifactName)) outcome = 'failure';
        else retainedArtifacts.push({ name: artifactName, snapshot: `attempt-${attempt}` });
      } else {
        deploymentRequests += 1;
        const selected = retainedArtifacts.filter(artifact => artifact.name === artifactName);
        if (deploymentFails || selected.length !== 1) outcome = 'failure';
        else deployedSnapshot = selected[0].snapshot;
      }
      if (outcome === 'failure' && step['continue-on-error'] !== true) context.failed = true;
    }
    if (step.id) context.steps[step.id] = { outcome, outputs: {} };
  }
  const notification = pipeline.jobs.publish.steps.find(step => step.name === 'Notify Telegram');
  const env = { QUALITY_STATUS: 'success', ARTIFACT_URL: 'https://example.test/results', EXCEL_ARTIFACT_URL: 'https://example.test/excel' };
  if (notification.env.PAGES_PUBLICATION_FAILED) env.PAGES_PUBLICATION_FAILED = String(workflowValue(notification.env.PAGES_PUBLICATION_FAILED, context));
  const message = buildTelegramSummary({ env, qualityAlerts: { status: 'success' }, reportAvailable: true, excelAvailable: true });
  return { artifacts: retainedArtifacts, deploymentRequests, deployedSnapshot, failed: context.failed, message };
}

const firstPagesAttempt = pagesRetry({ attempt: '1' });
const pagesRetryCases = [
  ['failed retry upload never deploys a retained previous-attempt snapshot', () => {
    const result = pagesRetry({ attempt: '2', artifacts: firstPagesAttempt.artifacts, uploadFails: true });
    assert.equal(result.deploymentRequests, 0);
    assert.equal(result.deployedSnapshot, null);
    assert.equal(result.failed, true);
  }],
  ['successful retry deploys its current snapshot while retaining the previous artifact', () => {
    const result = pagesRetry({ attempt: '2', artifacts: firstPagesAttempt.artifacts });
    assert.equal(result.deployedSnapshot, 'attempt-2');
    assert.equal(result.artifacts.length, 2);
    assert.equal(result.failed, false);
    assert.match(result.message, /^DiscoverCars \| GOTOWE\n/);
  }],
  ['failed upload produces a publication alert even when downloadable artifacts exist', () => {
    const result = pagesRetry({ attempt: '2', artifacts: firstPagesAttempt.artifacts, uploadFails: true });
    assert.match(result.message, /^DiscoverCars \| BŁĄD PUBLIKACJI\n/);
    assert.match(result.message, /GitHub Pages/);
  }],
  ['failed Pages deployment remains a job failure and produces a publication alert', () => {
    const result = pagesRetry({ attempt: '2', deploymentFails: true });
    assert.equal(result.failed, true);
    assert.match(result.message, /^DiscoverCars \| BŁĄD PUBLIKACJI\n/);
  }],
  ['invalid Pages bundle is never deployed', () => {
    const result = pagesRetry({ attempt: '2', artifacts: firstPagesAttempt.artifacts, validationFails: true });
    assert.equal(result.deploymentRequests, 0);
    assert.equal(result.failed, true);
    assert.match(result.message, /^DiscoverCars \| BŁĄD PUBLIKACJI\n/);
  }],
  ['failed Pages configuration never uploads or deploys and produces a publication alert', () => {
    const result = pagesRetry({ attempt: '2', artifacts: firstPagesAttempt.artifacts, configurationFails: true });
    assert.equal(result.artifacts.length, firstPagesAttempt.artifacts.length);
    assert.equal(result.deploymentRequests, 0);
    assert.equal(result.failed, true);
    assert.match(result.message, /^DiscoverCars \| BŁĄD PUBLIKACJI\n/);
  }]
];
let pagesRetryFailureCount = 0;
for (const [name, verify] of pagesRetryCases) {
  try { verify(); console.log(`PASS Pages retry: ${name}`); }
  catch (error) { pagesRetryFailureCount += 1; console.error(`FAIL Pages retry: ${name}: ${error.message}`); }
}
assert.equal(pagesRetryFailureCount, 0, 'Pages retry safety regressions');
assert.match(buildTelegramSummary({ env: { QUALITY_STATUS: 'failure', PAGES_PUBLICATION_FAILED: 'true' } }), /^DiscoverCars \| BŁĄD\n/);

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
} finally { fs.rmSync(optionsDirectory, { recursive: true, force: true }); }

let publicationCases = 0;
function checkPublication({ reportTime, excelTime, failedPath, failedStatus = '500', candidateMissing, invalidDigest,
  qualityStatus = 'success', candidateStatus = qualityStatus, verify }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discovercars-publish-'));
  const write = (file, value) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  try {
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
    let script = pipeline.jobs.publish.steps.find(step => step.id === 'pages-site').run;
    script = script.replace('node src/publicResults.js output/results-latest.json output/results-public.json', 'cp output/results-latest.json output/results-public.json')
      .replace('node src/publicationPolicy.js', `node "${path.join(root, 'src/publicationPolicy.js').replaceAll('\\', '/')}"`);
    if (qualityStatus === 'failure') script = pipeline.jobs.assemble.steps.find(step => step.name === 'Withhold unvalidated workbooks').run + '\n' + script;
    script += `\nnode "${path.join(root, 'src/publicationPolicy.js').replaceAll('\\', '/')}" --validate-only=pages\n`;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-s'], {
      cwd: directory, input: fakeCurl + script, encoding: 'utf8', timeout: process.platform === 'win32' ? 120000 : 30000,
      env: { ...process.env, RUN_TYPE: 'full', PAGE_URL: 'https://example.test/', QUALITY_STATUS: qualityStatus,
        GITHUB_OUTPUT: path.join(directory, 'actions-output').replaceAll('\\', '/'), GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', FAILED_PATH: failedPath || '-', FAILED_STATUS: failedStatus }
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
  reportTime: '2026-10-01T06:00:00Z', excelTime: '2026-10-01T06:00:00Z',
  verify({ result, read }) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read('pages/latest-full/report.html'), 'new');
    assert.equal(read('pages/latest-excel/rates-import-ready.xlsx'), 'new');
    assert.match(read('actions-output'), /excel_url=/);
  }
});
checkPublication({
  failedPath: 'latest-full/run-manifest.json',
  verify({ result }) { assert.notEqual(result.status, 0); assert.match(result.stdout, /Could not preserve/); }
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
