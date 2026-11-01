const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

test('optional planning failure retains unpruned recommendations and permits verification', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/discovercars-daily.yml'), 'utf8'));
  const steps = workflow.jobs.scrape.steps;
  const planner = steps.find(step => step.name === 'Plan Excel-relevant DOM verification');
  assert.ok(planner, 'planner must run before workload split');
  assert.ok(steps.indexOf(planner) < steps.findIndex(step => step.id === 'workload'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verification-plan-workflow-'));
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  try {
    fs.mkdirSync(path.join(directory, 'output'));
    fs.mkdirSync(path.join(directory, 'src'));
    fs.copyFileSync(path.join(__dirname, '../src/validateVerificationPlan.js'), path.join(directory, 'src/validateVerificationPlan.js'));
    const item = { scenario_id: 'one', location: 'Airport', action: 'increase', suggested_rate_pln_day: 123,
      site_target_rate_pln_day: 135, predicted_site_rate_pln_day: 140,
      requires_popularity_verification: true, data_quality_status: 'popularity_pending' };
    const original = { options: { a: 1, b: 2 }, decisions: [item], recommendations: [{ ...item }], recommendation_count: 1 };
    const source = JSON.stringify(original);
    const output = path.join(directory, 'output/final-pricing-recommendations.json');
    fs.writeFileSync(output, source);
    // Missing planner script models an unavailable optional runtime, with the real workflow shell.
    const failed = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', planner.run], {
      cwd: directory, encoding: 'utf8', timeout: 30000
    });
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), source);
    assert.match(failed.stdout, /warning|unpruned|full verification/i);
    fs.mkdirSync(path.join(directory, 'tools'));
    const plannerPath = path.join(directory, 'tools/plan_recommendation_verification.py');
    fs.writeFileSync(plannerPath, "from pathlib import Path\nPath('output/planned-pricing-recommendations.tmp.json').write_text('invalid json')\n");
    const invalid = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', planner.run], {
      cwd: directory, encoding: 'utf8', timeout: 30000
    });
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(fs.readFileSync(output, 'utf8'), source, 'malformed optional output must not replace the full input');
    const runCandidate = candidate => {
      fs.writeFileSync(output, source);
      fs.writeFileSync(plannerPath, "from pathlib import Path\nPath('output/planned-pricing-recommendations.tmp.json').write_text("
        + JSON.stringify(JSON.stringify(candidate)) + ")\n");
      const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', planner.run], {
        cwd: directory, encoding: 'utf8', timeout: 30000
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(fs.readFileSync(output, 'utf8'));
    };
    const undocumented = { ...original, decisions: [{ ...item, action: 'hold', suggested_rate_pln_day: null }] };
    assert.deepEqual(runCandidate(undocumented), original, 'undocumented holds must not suppress verification');
    const held = { ...item, action: 'hold', recommendation_action: 'hold', suggested_rate_pln_day: null,
      maximum_import_rate_pln_day: null, site_cap_rate_pln_day: null,
      site_target_rate_pln_day: null, predicted_site_rate_pln_day: null, change_pln_day: 0,
      data_quality_status: 'excel_ineligible', requires_popularity_verification: false,
      verification_plan_status: 'skipped_excel_irrelevant', verification_plan_reason: 'no_eligible_excel_cell',
      reason: 'No eligible Excel cell' };
    const valid = { ...original, options: { b: 2, a: 1 }, decisions: [held], recommendations: [{ ...held }], recommendation_count: 0 };
    assert.deepEqual(runCandidate(valid), valid);
    for (const changed of [
      { ...valid, decisions: [{ ...held, location: 'Different airport' }] },
      { ...valid, decisions: [{ ...held, verification_plan_reason: 'already_at_floor' }] },
      { ...valid, decisions: [{ ...held, dom_verification_status: 'confirmed' }] },
      { ...valid, recommendations: original.recommendations }
    ]) assert.deepEqual(runCandidate(changed), original, 'invalid pruning must retain full verification');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
