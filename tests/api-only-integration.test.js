const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { pendingRecommendationGroups, splitActiveRecommendations, mergeVerifiedRecommendationShards } = require('../src/recommendationDomShards');
const { isSourceVerified, verifyActiveRecommendations } = require('../src/verifyActiveRecommendationsDom');
const { DiscoverCarsScraper } = require('../src/discovercars/scraper');
const { mergeBrokerMarkupCalibration } = require('../src/brokerMarkupCalibration');
const { mergePricingRecommendations } = require('../src/mergePricingRecommendations');

const pricing = require('../pricing-rules.config.example.json').pricing;
const productionOptions = { ...pricing, brokerMarkupCalibration: mergeBrokerMarkupCalibration(
  pricing.brokerMarkupCalibration, require('../input/broker-markup-frozen.json')) };
const location = 'Gdansk Airport (GDN)';

function sourcePayload(durations = Array.from({ length: 13 }, (_, index) => index + 2)) {
  const generated = new Date().toISOString();
  return { run_id: 'api-only-integration', generated_at: generated, start_dates: ['2026-11-03'],
    locations: [location], scenarios: durations.map(days => {
      const offer = (provider_name, daily) => ({ provider_name, total_price: daily * days,
        rental_days: days, transmission: 'automatic', currency: 'PLN' });
      return { scenario_id: `2026-11-03/${days}`, start_date: '2026-11-03', pickup_date: '2026-11-03', rental_days: days,
        top_3_plus_mm_by_location: { [location]: { top_3: [offer('Budget', 300), offer('Avis', 350), offer('Hertz', 400)],
          mm_cars_rental: offer('MM Cars Rental', 200) } },
        source_validation_by_location: { [location]: { status: 'api_unverified', reasons: [] } } };
    }) };
}

test('production policy preserves API duration 2-14 but queues no expensive checks for 9,11,12', () => {
  const payload = sourcePayload();
  const result = buildPricingRecommendations(payload, productionOptions);
  assert.deepEqual(result.decisions.map(item => item.rental_days), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(result.decisions.filter(item => item.action !== 'hold').map(item => item.rental_days),
    [2, 3, 4, 5, 6, 7, 8, 10, 13, 14]);
  assert.equal(result.recommendation_count, 10);
  assert.equal(pendingRecommendationGroups(result).size, 10);
  for (const days of [9, 11, 12]) {
    const item = result.decisions.find(value => value.rental_days === days);
    assert.equal(item.data_quality_status, 'api_constraint_only');
    assert.equal(item.verification_scope, 'api_only_constraint');
    assert.equal(item.suggested_rate_pln_day, null);
    assert.ok(item.maximum_import_rate_pln_day > 0);
    assert.equal(item.dom_verified_at, undefined);
    assert.equal(isSourceVerified(item, result.source_generated_at, Date.now(), result.options), false);
  }
});

test('partial refresh cannot revive an older active check for API-only duration', () => {
  const before = buildPricingRecommendations(sourcePayload([9]), { ...productionOptions, apiOnlyConstraintRentalDays: [] });
  const update = buildPricingRecommendations(sourcePayload([8]), productionOptions);
  const merged = mergePricingRecommendations(before, update);
  const retained = merged.decisions.find(item => item.rental_days === 9);
  assert.equal(retained.action, 'hold');
  assert.equal(retained.data_quality_status, 'api_constraint_only');
  assert.equal(pendingRecommendationGroups(merged).size, 1);
});

test('partial refresh preserves one pending repair without replacing it with an unavailable hold', () => {
  const source = sourcePayload([9]);
  source.scenarios[0].source_validation_by_location[location] = {
    status: 'dom_validation_failed_api_used', reasons: ['dom_failure']
  };
  const before = buildPricingRecommendations(source, productionOptions);
  const update = buildPricingRecommendations(sourcePayload([8]), productionOptions);
  const merged = mergePricingRecommendations(before, update);
  const pending = merged.decisions.find(item => item.rental_days === 9);
  assert.equal(pending.data_quality_status, 'api_constraint_repair_pending');
  assert.equal(pending.requires_dom_constraint_repair, true);
  assert.equal(pending.suggested_rate_pln_day, null);
  assert.equal(pending.maximum_import_rate_pln_day, null);
  assert.equal(pendingRecommendationGroups(merged).size, 2);
});

function renderedResult(days, competitorRate, popularFirst = 'Budget') {
  return {
    results: [['Budget', competitorRate], ['MM Cars Rental', 200]].map(([provider, rate]) => ({ provider,
      totalPrice: rate * days, currency: 'PLN', transmission: 'automatic', source: 'dom', location })),
    domEvidenceByLocation: { [location]: { automatic_filter_confirmed: true, price_sort_confirmed: true,
      ranking_complete: true, ranking_goal: 'price_top1' } },
    recommendedRankingByLocation: { [location]: { status: 'confirmed', sort: 'Recommended', transmission: 'automatic',
      observed_at: new Date().toISOString(), top_offer: { provider_name: popularFirst, total_price: 200 * days,
        currency: 'PLN', transmission: 'automatic' } } }
  };
}

function exportVerified(directory, payload) {
  const input = path.join(directory, 'verified.json');
  fs.writeFileSync(input, JSON.stringify(payload));
  const script = `import json, sys
from pathlib import Path
root=Path.cwd()
sys.path.insert(0, str(root / 'tests'))
from test_api_only_constraints import ApiOnlyConstraintFixture
import openpyxl
fixture=ApiOnlyConstraintFixture(Path(sys.argv[1]), location_zones={'Gdansk Airport (GDN)': ['WA1']})
fixture.write_workbook([('CDMV','WA1','2026-11-03',100),('EDMV','WA1','2026-11-03',101),('PDAH','WA1','2026-11-03',100)])
payload=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
summary,review,imported=fixture.apply(payload['decisions'])
rates=[]
for file in (review, imported):
 book=openpyxl.load_workbook(file,read_only=True,data_only=True)
 rates.append([book['Sheet1'].cell(row,9).value for row in (5,6,7)])
 book.close()
print(json.dumps({'rates':rates,'validation':summary['validation'],'changes':summary['change_count']}))
`;
  const result = spawnSync('python', ['-c', script, directory, input], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 60000
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function mergeAwayFromWorker(directory, input, outputs) {
  const saved = [];
  try {
    for (const output of outputs) {
      const file = output.dom_verification?.checkpoint_path;
      if (!file || !fs.existsSync(file)) continue;
      const relative = path.relative(directory, file);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      saved.push([file, fs.readFileSync(file)]);
      fs.unlinkSync(file);
    }
    return mergeVerifiedRecommendationShards(input, outputs, { shardCount: 2 });
  } finally {
    for (const [file, bytes] of saved) fs.writeFileSync(file, bytes);
  }
}

test('real builder, verification shards and Python export agree on reduced evidence and conservative holds', async t => {
  const original = DiscoverCarsScraper.prototype.run;
  for (const scenario of [
    { name: 'verified-selected-target', apiRate: 300, siteRate: 120, want: [118, 119, 100] },
    { name: 'trusted-dom-fallback-remains-a-constraint-without-extra-visit', apiRate: 300, siteRate: 120,
      fallback: true, want: [118, 119, 100] },
    { name: 'unverified-lower-api-cap', apiRate: 100, siteRate: 120, want: [100, 101, 100] },
    { name: 'selected-popular-MM-veto', apiRate: 300, siteRate: 120, veto: true, want: [100, 101, 100] },
    { name: 'failed-api-only-source-repaired-once', apiRate: 300, siteRate: 120, repair: true, reuse: true, want: [118, 119, 100] },
    { name: 'genuine-day9-DOM-repair-can-set-a-lower-verified-target', apiRate: 300, siteRate: 120,
      repair: true, repairRate: 90, want: [88, 89, 100] },
    { name: 'failed-api-only-repair-preserves-baseline-on-resume', apiRate: 300, siteRate: 120,
      repair: true, repairFails: true, want: [100, 101, 100] },
    { name: 'repair-popular-MM-veto-preserves-shared-band', apiRate: 300, siteRate: 120,
      repair: true, repairVeto: true, want: [100, 101, 100] }
  ]) await t.test(scenario.name, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-only-export-'));
    const called = [];
    try {
      const source = sourcePayload([8, 9, 10, 11, 12, 13, 14]);
      for (const item of source.scenarios) item.top_3_plus_mm_by_location[location].top_3[0].total_price = scenario.apiRate * item.rental_days;
      if (scenario.repair) {
        source.scenarios.find(item => item.rental_days === 9).source_validation_by_location[location] = {
          status: 'api_dom_conflict_api_used', reasons: ['price_mismatch']
        };
      }
      if (scenario.fallback) {
        source.scenarios.find(item => item.rental_days === 9).source_validation_by_location[location] = {
          status: 'dom_fallback', reasons: ['api_failure']
        };
      }
      const input = buildPricingRecommendations(source, { ...productionOptions,
        brokerMarkupCalibration: { enabled: true, manualOnly: true, model: 'fixed_amount',
          locationDurationAmounts: { [location]: { '8-20': 0 } } } });
      DiscoverCarsScraper.prototype.run = async function () {
        const days = this.config.rentalDays || Math.round((Date.parse(this.config.dropoffDate) - Date.parse(this.config.pickupDate)) / 86400000);
        called.push(days);
        assert.ok((scenario.repair ? [8, 9, 10, 13, 14] : [8, 10, 13, 14]).includes(days));
        if (scenario.repairFails && days === 9) throw new Error('fixture repair read failed');
        return (scenario.veto && days === 8) || (scenario.repairVeto && days === 9)
          ? renderedResult(days, 20, 'MM Cars Rental')
          : renderedResult(days, days === 9 && scenario.repairRate ? scenario.repairRate : scenario.siteRate);
      };
      if (scenario.repair) {
        const pending = input.decisions.find(item => item.rental_days === 9);
        assert.equal(pending.data_quality_status, 'api_constraint_repair_pending');
        assert.equal(pending.requires_dom_constraint_repair, true);
        assert.equal(pending.suggested_rate_pln_day, null);
        assert.equal(pending.maximum_import_rate_pln_day, null);
        const notYetVerified = exportVerified(directory, input);
        assert.deepEqual(notYetVerified.rates, [[100, 101, 100], [100, 101, 100]]);
      }
      const shards = splitActiveRecommendations(input, 2);
      const verified = [];
      for (const [index, shard] of shards.entries()) verified.push(await verifyActiveRecommendations(shard, {
        concurrency: 1, workDir: path.join(directory, `shard-${index}`)
      }));
      const merged = scenario.repairFails
        ? mergeAwayFromWorker(directory, input, verified)
        : mergeVerifiedRecommendationShards(input, verified, { shardCount: 2 });
      assert.equal(merged.dom_verification.unverified_output_count, 0);
      assert.equal(merged.dom_verification.invalid_shard_count, 0);
      const expectedChecks = scenario.repair ? [8, 9, 10, 13, 14] : [8, 10, 13, 14];
      assert.deepEqual(called.slice().sort((a, b) => a - b), expectedChecks);
      const expectedActive = scenario.veto ? 3 : scenario.repair && !scenario.repairFails && !scenario.repairVeto ? 5 : 4;
      assert.equal(merged.decisions.filter(item => item.action !== 'hold').length, expectedActive,
        JSON.stringify(merged.decisions.map(item => ({ days: item.rental_days, action: item.action,
          status: item.dom_verification_status, reasons: item.dom_verification_reasons, quality: item.data_quality_status }))));
      for (const days of [9, 11, 12]) {
        const record = merged.decisions.find(item => item.rental_days === days);
        if (scenario.repair && days === 9) {
          assert.equal(record.action === 'hold', Boolean(scenario.repairFails || scenario.repairVeto));
          if (!scenario.repairFails) {
            assert.equal(isSourceVerified(record, merged.source_generated_at, Date.now(), merged.options), true);
            assert.equal(record.verification_scope, undefined);
            assert.equal(record.api_recommendation_type, undefined);
          }
          continue;
        }
        assert.equal(record.verification_scope, 'api_only_constraint');
        assert.equal(record.dom_verified_at, undefined);
      }
      const exported = exportVerified(directory, merged);
      assert.deepEqual(exported.rates, [scenario.want, scenario.want], JSON.stringify(exported));
      assert.ok(exported.validation.every(row => row.status !== 'FAIL'));
      if (scenario.repairFails) {
        const resumed = [];
        for (const [index, shard] of shards.entries()) resumed.push(await verifyActiveRecommendations(shard, {
          concurrency: 1, workDir: path.join(directory, `shard-${index}`)
        }));
        assert.deepEqual(called.slice().sort((a, b) => a - b), expectedChecks);
        const resumedMerge = mergeAwayFromWorker(directory, input, resumed);
        assert.equal(resumedMerge.dom_verification.unverified_output_count, 0);
        assert.equal(resumedMerge.decisions.find(item => item.rental_days === 9).api_constraint_repair.status, 'failed');
        const retried = exportVerified(directory, resumedMerge);
        assert.deepEqual(retried.rates, [scenario.want, scenario.want], JSON.stringify(retried));
      }
      if (scenario.reuse) {
        const retained = mergePricingRecommendations(merged, { options: merged.options, decisions: [], recommendations: [] });
        const repaired = retained.decisions.find(item => item.rental_days === 9);
        assert.equal(repaired.action === 'hold', false, JSON.stringify({
          repairStatus: repaired.api_constraint_repair, reason: repaired.reason, quality: repaired.data_quality_status,
          merge: retained.merge,
          beforeVerified: isSourceVerified(merged.decisions.find(item => item.rental_days === 9),
            merged.source_generated_at, Date.now(), merged.options)
        }));
        assert.equal(isSourceVerified(repaired, retained.source_generated_at, Date.now(), retained.options), true);
        const cachedShards = splitActiveRecommendations(retained, 2);
        const cachedVerified = [];
        for (const [index, shard] of cachedShards.entries()) cachedVerified.push(await verifyActiveRecommendations(shard, {
          concurrency: 1, workDir: path.join(directory, `cached-shard-${index}`)
        }));
        const cached = mergeVerifiedRecommendationShards(retained, cachedVerified, { shardCount: 2 });
        assert.deepEqual(called.slice().sort((a, b) => a - b), expectedChecks);
        for (const item of cached.decisions.filter(item => item.action !== 'hold')) {
          assert.equal(item.dom_verification_status, 'confirmed_existing_dom');
        }
        const cachedExport = exportVerified(directory, cached);
        assert.deepEqual(cachedExport.rates, [scenario.want, scenario.want], JSON.stringify(cachedExport));
      }
    } finally {
      DiscoverCarsScraper.prototype.run = original;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
