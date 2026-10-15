import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as policy from '../src/policy.mjs';

const read = async (name) => JSON.parse(await readFile(new URL(`../../${name}`, import.meta.url), 'utf8'));
const original = policy.createModel({
  pricing: await read('pricing-rules.config.example.json'),
  excel: await read('excel-rate-update.config.example.json'),
  locations: await read('locations.config.json'),
});
const input = () => ({
  groups: ['CDMV', 'CFAV'], zones: ['WA1', 'WALO'],
  startDate: '2026-10-15', endDate: '2026-11-02',
  bands: [[1, 1, 200], [2, 2, 190], [3, 4, 180], [5, 7, 170], [8, 20, 160], [21, 35, 150]]
    .map(([minDays, maxDays, amount]) => ({ minDays, maxDays, amount })),
  overrideProtected: false,
});
const preview = (model, extra = {}) => policy.previewPolicy(model, {
  zone: 'WA1', group: 'CFAV', pickupDate: '2026-10-15', duration: 2, baselineRate: 20, ...extra,
});

test('matrix helper is exported and creates six scoped rows without changing existing documents', () => {
  assert.equal(typeof policy.addFloorMatrix, 'function');
  const fields = input();
  const model = policy.addFloorMatrix(original, fields);
  const document = policy.toDocuments(model);
  const floors = document.pricing.pricing.mandatoryScopedFloorsPlnDay;
  assert.equal(floors.length, 6);
  assert.deepEqual(floors[1], {
    groups: ['CDMV', 'CFAV'], zones: ['WA1', 'WALO'], startDate: '2026-10-15', endDate: '2026-11-02',
    minDays: 2, maxDays: 2, minimumRatePlnDay: 190, overrideProtected: false,
  });
  delete document.pricing.pricing.mandatoryScopedFloorsPlnDay;
  assert.deepEqual(document, policy.toDocuments(original));
  fields.groups.push('FVMD');
  assert.deepEqual(floors[0].groups, ['CDMV', 'CFAV']);
  assert.deepEqual(policy.validateModel(model, original).errors, []);
  assert.equal(policy.buildRules(model).filter((row) => row.id.startsWith('scoped:')).length, 6);
});

test('scopes, dates, all six bands and higher baselines are honored without market authorization', () => {
  const model = policy.addFloorMatrix(original, input());
  for (const [duration, amount] of [[1, 200], [2, 190], [3, 180], [4, 180], [5, 170], [7, 170], [8, 160], [20, 160], [21, 150], [35, 150]]) {
    const result = preview(model, { duration });
    assert.equal(result.minimumAfterBaseline, amount);
    assert.equal(result.marketAllowed, false);
  }
  for (const patch of [{ zone: 'WR1' }, { group: 'SWAV' }, { pickupDate: '2026-10-14' }, { pickupDate: '2026-11-03' }]) {
    assert.equal(preview(model, patch).minimumAfterBaseline, 20);
  }
  assert.equal(preview(model, { pickupDate: '2026-11-02' }).minimumAfterBaseline, 190);
  assert.equal(preview(model, { baselineRate: 500 }).minimumAfterBaseline, 500);
  assert.deepEqual(model.excel, original.excel);
});

test('protected dates require an explicit override and higher existing holiday minima still win', () => {
  const fields = { ...input(), groups: ['FVMD'], startDate: '2026-12-15', endDate: '2027-01-10' };
  const model = policy.addFloorMatrix(original, fields);
  assert.equal(preview(model, { group: 'FVMD', pickupDate: '2026-12-25' }).minimumAfterBaseline, 700);
  assert.equal(preview(model, { group: 'FVMD', pickupDate: '2027-01-10' }).minimumAfterBaseline, 20);
  const overridden = policy.addFloorMatrix(original, { ...fields, overrideProtected: true });
  assert.equal(preview(overridden, { group: 'FVMD', pickupDate: '2027-01-10' }).minimumAfterBaseline, 190);
  assert.equal(preview(overridden, { group: 'FVMD', zone: 'SZLO', pickupDate: '2026-12-25' }).omitted, true);
});

test('scoped row edits and removals round trip, including unwrapped pricing', () => {
  const model = policy.addFloorMatrix(original, input());
  const row = policy.buildRules(model).find((entry) => entry.id === 'scoped:1');
  const updated = policy.updateRule(model, row.id, { ...row, amount: 250, groups: ['PDAH'], zones: ['WR1'] });
  assert.equal(preview(updated, { group: 'PDAH', zone: 'WR1' }).minimumAfterBaseline, 250);
  assert.equal(preview(updated).minimumAfterBaseline, 20);
  assert.deepEqual(policy.validateModel(updated, original).errors, []);
  let removed = updated;
  while (policy.buildRules(removed).some((entry) => entry.id === 'scoped:0')) removed = policy.removeRule(removed, 'scoped:0');
  assert.deepEqual(policy.toDocuments(removed), policy.toDocuments(original));
  const unwrapped = policy.createModel({ ...original, pricing: original.pricing.pricing });
  assert.equal(policy.toDocuments(policy.addFloorMatrix(unwrapped, input())).pricing.mandatoryScopedFloorsPlnDay.length, 6);
});

test('invalid matrix input is rejected atomically, without silent scope or protection loss', () => {
  for (const patch of [
    { groups: [] }, { groups: ['ZZZZ'] }, { groups: ['*'] }, { groups: ['CDMV', 'CDMV'] },
    { zones: [] }, { zones: ['FAKE'] }, { zones: ['*'] }, { zones: ['WA1', 'WA1'] },
    { startDate: '2026-02-30' }, { endDate: '2026-10-01' }, { overrideProtected: 'false' },
    { bands: [] }, { bands: input().bands.slice(1) },
    { bands: input().bands.map((band) => ({ ...band, amount: 0 })) },
    { bands: input().bands.map((band) => ({ ...band, amount: Infinity })) },
    { kind: 'city' },
  ]) assert.throws(() => policy.addFloorMatrix(original, { ...input(), ...patch }));
  assert.equal(original.pricing.pricing.mandatoryScopedFloorsPlnDay, undefined);
});

test('backend validation rejects forged scoped payloads and locked settings', () => {
  const valid = policy.addFloorMatrix(original, input());
  for (const patch of [
    { groups: ['ZZZZ'] }, { zones: ['FAKE'] }, { groups: ['*'] }, { minimumRatePlnDay: '190' },
    { overrideProtected: undefined }, { overrideProtected: 'false' }, { startDate: '' },
    { startDate: '2026-02-30' }, { maxDays: 3 }, { extra: true }, { kind: 'airport' },
  ]) {
    const forged = structuredClone(valid);
    Object.assign(forged.pricing.pricing.mandatoryScopedFloorsPlnDay[1], patch);
    assert.ok(policy.validateModel(forged, original).errors.length, JSON.stringify(patch));
    assert.equal(preview(forged).floor, null);
  }
  const forged = structuredClone(valid);
  forged.excel.group_price_parity.enabled = false;
  assert.ok(policy.validateModel(forged, original).errors.length);
});

test('overlapping matrices use the maximum and cannot erase a higher existing premium correction', () => {
  let model = policy.addFloorMatrix(original, input());
  model = policy.addFloorMatrix(model, { ...input(), bands: input().bands.map((band) => ({ ...band, amount: 100 })) });
  assert.equal(preview(model).floor, 190);
  assert.ok(policy.validateModel(model, original).warnings.some((warning) => /minim/.test(warning.message)));
  const premium = policy.addFloorMatrix(original, {
    ...input(), groups: ['EDAV'], bands: input().bands.map((band) => ({ ...band, amount: 60.5 })),
  });
  assert.equal(preview(premium, { group: 'EDAV' }).minimumAfterBaseline, 61);
});

test('matrix preview agrees with real Python mandatory and correction functions over a boundary grid', () => {
  let model = policy.addFloorMatrix(original, input());
  model = policy.addFloorMatrix(model, {
    ...input(), groups: ['EDAV'], bands: input().bands.map((band) => ({ ...band, amount: 60.5 })),
  });
  model = policy.addFloorMatrix(model, {
    ...input(), groups: ['FVMD'], zones: ['WA1', 'SZLO'], startDate: '2026-12-15', endDate: '2027-01-10', overrideProtected: true,
  });
  const cases = [];
  for (const zone of ['WA1', 'WALO', 'SZLO', 'WR1'])
    for (const group of ['CDMV', 'EDAV', 'CFAV', 'PDAH', 'FVMD'])
      for (const duration of [1, 2, 4, 7, 20, 35])
        for (const pickupDate of ['2026-10-14', '2026-10-15', '2026-10-30', '2026-10-31', '2026-11-02', '2026-11-03', '2026-12-15', '2027-01-05', '2027-01-10', '2027-01-11'])
          cases.push({ zone, group, duration, pickupDate });
  const script = `import json,sys,tempfile
from pathlib import Path
from tools import update_excel_rates as e
x=json.load(sys.stdin)
with tempfile.TemporaryDirectory() as directory:
 p=Path(directory)/'pricing.json';p.write_text(json.dumps(x['model']['pricing']))
 c=e.load_config(Path('excel-rate-update.config.example.json'));c.update(x['model']['excel']);c['pricing_rules_file']=str(p)
 for key,fn in [('_mandatory_scoped_floors',e.get_mandatory_scoped_floors),('_mandatory_group_floors',e.get_mandatory_group_floors),('_mandatory_zone_floors',e.get_mandatory_zone_floors),('_location_type_floors',e.get_location_type_floors)]: c[key]=fn(c)
 c['_location_type_allowed_groups']=e.resolve_apply_groups(c,None)
 bands=[(1,1),(2,2),(3,4),(5,7),(8,20),(21,35)];omitted=e.get_omitted_group_zones(c);out=[]
 for row in x['cases']:
  if (row['group'],row['zone']) in omitted: out.append([None,None]);continue
  low,high=next(b for b in bands if b[0]<=row['duration']<=b[1])
  args=(row['zone'],row['group'],low,high,c,row['pickupDate'])
  out.append([e.get_mandatory_floor(*args)[0],e.get_mandatory_correction_floor(*args)[0]])
 print(json.dumps(out))`;
  const result = spawnSync(process.env.PYTHON ?? 'python', ['-B', '-c', script], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), input: JSON.stringify({ model, cases }),
    encoding: 'utf8', timeout: 120000, maxBuffer: 4e6, windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const expected = JSON.parse(result.stdout);
  assert.equal(expected.length, cases.length);
  cases.forEach((fields, index) => {
    const actual = policy.previewPolicy(model, fields);
    assert.deepEqual([actual.floor, actual.correctionFloor], expected[index], JSON.stringify(fields));
  });
});
