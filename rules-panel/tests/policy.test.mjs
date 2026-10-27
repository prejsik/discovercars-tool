import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createModel, buildRules, validateModel, updateRule, addRule, removeRule,
  setGroupEnabled, toDocuments, previewPolicy, knownGroups, DURATION_BANDS,
} from '../src/policy.mjs';

const readConfig = async (name) => JSON.parse(await readFile(new URL(`../../${name}`, import.meta.url), 'utf8'));
const documents = {
  pricing: await readConfig('pricing-rules.config.example.json'),
  excel: await readConfig('excel-rate-update.config.example.json'),
  locations: await readConfig('locations.config.json'),
};
const model = () => createModel(documents);
const preview = (input = {}, value = model()) => previewPolicy(value, {
  zone: 'WA1', group: 'CDMV', pickupDate: '2026-10-15', duration: 2, baselineRate: 20, ...input,
});

test('editing a cloned model and exported documents cannot mutate inputs or each other', () => {
  const originalZones = [...documents.locations.locations[0].zones];
  const value = model();
  assert.deepEqual(Object.keys(value).sort(), ['excel', 'locations', 'pricing']);
  const exported = toDocuments(value);
  assert.deepEqual(exported, { pricing: documents.pricing, excel: documents.excel });
  exported.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city = 999;
  value.locations.locations[0].zones.push('FAKE');
  assert.equal(value.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city, 60);
  assert.deepEqual(documents.locations.locations[0].zones, originalZones);
});

test('source range configuration survives a rule edit and JSON document roundtrip without rolling defaults', () => {
  const original = model();
  original.excel.pickup_date_expansion = { enabled: true, mode: 'source_ranges', time_zone: 'Europe/Warsaw' };
  assert.deepEqual(validateModel(original, original).errors, []);
  const edited = updateRule(original, 'location:city', { amount: 65 });
  const exported = JSON.parse(JSON.stringify(toDocuments(edited)));
  const restored = createModel({ ...exported, locations: original.locations });
  assert.deepEqual(validateModel(restored, original).errors, []);
  assert.deepEqual(exported.excel.pickup_date_expansion, {
    enabled: true, mode: 'source_ranges', time_zone: 'Europe/Warsaw',
  });
  assert.equal(restored.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city, 65);
  assert.equal(original.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city, 60);
});

test('source range settings remain immutable when bypassing rule edit handlers', () => {
  const original = model();
  original.excel.pickup_date_expansion = { enabled: true, mode: 'source_ranges', time_zone: 'Europe/Warsaw' };
  for (const change of [
    (value) => { delete value.excel.pickup_date_expansion.mode; },
    (value) => { value.excel.pickup_date_expansion.rolling_days = 100; },
    (value) => { value.excel.pickup_date_expansion.time_zone = 'UTC'; },
  ]) {
    const value = createModel(original);
    change(value);
    assert.ok(validateModel(value, original).errors.some((item) => item.path === 'model'));
  }
});

test('actual documents build typed rows without replacing separate priority duration bands', () => {
  const rows = buildRules(model());
  assert.equal(rows.find((row) => row.id === 'location:city').amount, 60);
  assert.equal(rows.find((row) => row.id === 'location:airport').amount, 30);
  assert.equal(rows.find((row) => row.id === 'group:PDAH:0').minDays, 21);
  assert.equal(rows.find((row) => row.id === 'zone:SZLO:2').amount, 130);
  assert.deepEqual(rows.filter((row) => row.id.startsWith('priority:0')).map((row) => [row.minDays, row.maxDays]), [[2, 2], [3, 4]]);
  assert.equal(rows.find((row) => row.id === 'protected:0').amount, null);
  assert.ok(rows.filter((row) => row.category === 'legacy').every((row) => !row.editable));
  for (const row of rows) {
    for (const key of ['id', 'title', 'category', 'groups', 'zones', 'kind', 'minDays', 'maxDays', 'amount', 'startDate', 'endDate', 'overrideProtected', 'editable']) {
      assert.ok(Object.hasOwn(row, key), `${row.id}: ${key}`);
    }
  }
});

test('known classes include frozen, parity, adjustment and omission sources, never wildcard', () => {
  const value = model();
  value.excel.group_price_parity.premium_adjustments_pln_day.ZZZZ = 1;
  value.excel.group_rate_adjustments_pln_day.YYYY = 1;
  value.excel.omitted_group_zones.WA1 = ['XXXX'];
  assert.ok(['FVMD', 'CFAV', 'PDAH', 'ZZZZ', 'YYYY', 'XXXX'].every((group) => knownGroups(value).includes(group)));
  assert.ok(!knownGroups(value).includes('*'));
  assert.deepEqual(DURATION_BANDS, [[1, 1], [2, 2], [3, 4], [5, 7], [8, 20], [21, 35]]);
});

test('amount edits are immutable and preserve unknown config and rule fields', () => {
  const original = model();
  original.pricing.custom = { untouched: [1, 2] };
  original.pricing.pricing.mandatoryGroupFloorsPlnDay.PDAH[0].note = 'keep';
  const value = updateRule(original, 'group:PDAH:0', { amount: 180 });
  assert.equal(original.pricing.pricing.mandatoryGroupFloorsPlnDay.PDAH[0].minimumRatePlnDay, 170);
  assert.equal(value.pricing.pricing.mandatoryGroupFloorsPlnDay.PDAH[0].minimumRatePlnDay, 180);
  assert.equal(value.pricing.pricing.mandatoryGroupFloorsPlnDay.PDAH[0].note, 'keep');
  assert.deepEqual(toDocuments(value).pricing.custom, { untouched: [1, 2] });
  assert.equal(buildRules(updateRule(value, 'location:city', { amount: 65 })).find((row) => row.id === 'location:airport').amount, 30);
});

test('mandatory group and protected period additions serialize into existing schema only', () => {
  const original = model();
  let value = addRule(original, { category: 'mandatory', groups: ['CFAV'], zones: ['*'], minDays: 5, maxDays: 7, amount: 120 });
  value = addRule(value, { category: 'protected', startDate: '2027-02-01', endDate: '2027-02-10' });
  assert.deepEqual(value.pricing.pricing.mandatoryGroupFloorsPlnDay.CFAV, [{ minDays: 5, maxDays: 7, minimumRatePlnDay: 120 }]);
  assert.deepEqual(value.excel.protected_rate_periods.at(-1), { start_date: '2027-02-01', end_date: '2027-02-10' });
  assert.equal(original.pricing.pricing.mandatoryGroupFloorsPlnDay.CFAV, undefined);
  value = removeRule(value, 'group:CFAV:0');
  assert.equal(value.pricing.pricing.mandatoryGroupFloorsPlnDay.CFAV, undefined);
  assert.deepEqual(removeRule(value, 'protected:2').excel.protected_rate_periods, original.excel.protected_rate_periods);
});

test('wildcard group minima are not wildcard market authorization', () => {
  const value = addRule(removeRule(model(), 'group:*:0'), { category: 'mandatory', groups: ['*'], minDays: 2, maxDays: 2, amount: 125 });
  assert.equal(preview({ group: 'CFAV' }, value).floor, 125);
  assert.equal(preview({ group: 'CFAV' }, value).marketAllowed, false);
  assert.deepEqual(value.excel.apply_groups, documents.excel.apply_groups);
});

test('zone minima can be added only for all groups without dates or protection flags', () => {
  const value = addRule(model(), { category: 'mandatory', groups: ['*'], zones: ['WA1'], minDays: 1, maxDays: 35, amount: 100 });
  assert.deepEqual(value.pricing.pricing.mandatoryZoneFloorsPlnDay.WA1, [{ minDays: 1, maxDays: 35, minimumRatePlnDay: 100 }]);
  for (const patch of [{ groups: ['CDMV'] }, { startDate: '2027-02-01', endDate: '2027-02-10' }, { overrideProtected: true }]) {
    assert.throws(() => addRule(model(), { category: 'mandatory', groups: ['*'], zones: ['WA1'], amount: 100, ...patch }), /stref|zakres|dat|ochron/i);
  }
});

test('unsupported structural changes and deletion of main floors fail closed', () => {
  for (const id of ['location:city', 'location:airport', 'priority:0', 'legacy:global']) {
    assert.throws(() => removeRule(model(), id), /usun|odczyt/i);
  }
  assert.throws(() => updateRule(model(), 'group:PDAH:0', { groups: ['EVIL'] }), /zakres|klas|struktural/i);
  assert.throws(() => updateRule(model(), 'location:city', { zones: ['SZLO'] }), /zakres|stref|struktural/i);
  assert.throws(() => updateRule(model(), 'location:city', { id: '__proto__' }), /pola|struktural/i);
  assert.throws(() => addRule(model(), { category: 'mandatory', groups: ['EVIL'], amount: 99 }), /klas/i);
  assert.throws(() => addRule(model(), { category: 'mandatory', groups: ['CDMV', 'EDAV'], amount: 99 }), /jedn|klas/i);
  assert.throws(() => addRule(model(), { category: 'mandatory', zones: ['EVIL'], amount: 99 }), /stref/i);
  assert.throws(() => updateRule(model(), 'missing', { amount: 100 }), /nieznan/i);
});

test('group toggles preserve parity and omissions while maintaining explicit permissions', () => {
  const original = model();
  const disabled = setGroupEnabled(original, 'EDAV', false);
  assert.ok(!disabled.excel.apply_groups.includes('EDAV'));
  assert.ok(disabled.excel.excluded_groups.includes('EDAV'));
  assert.deepEqual(disabled.excel.group_price_parity, original.excel.group_price_parity);
  assert.deepEqual(disabled.excel.omitted_group_zones, original.excel.omitted_group_zones);
  const enabled = setGroupEnabled(disabled, 'EDAV', true);
  assert.ok(enabled.excel.apply_groups.includes('EDAV'));
  assert.ok(!enabled.excel.excluded_groups.includes('EDAV'));
  assert.ok(original.excel.apply_groups.includes('EDAV'));
  assert.throws(() => setGroupEnabled(original, '*', true), /klas/i);
  assert.throws(() => setGroupEnabled(original, 'EVIL', true), /klas|nieznan/i);
});

test('unchanged actual configs validate, unsafe amounts and impossible dates do not', () => {
  const original = model();
  assert.deepEqual(validateModel(original, original).errors, []);
  for (const amount of [0, -1, NaN, Infinity, '60', null]) {
    const result = validateModel(updateRule(original, 'location:city', { amount }), original);
    assert.ok(result.errors.some((item) => /minimumRatesByKind.city/.test(item.path)), String(amount));
  }
  for (const date of ['2026-02-29', '2026-04-31', '2026-1-01', 'today', '2027-01-02T00:00:00Z']) {
    assert.ok(validateModel(updateRule(original, 'protected:0', { startDate: date }), original).errors.length, date);
  }
  assert.ok(validateModel(updateRule(original, 'protected:0', { startDate: '2027-01-02' }), original).errors.length);
});

test('validation blocks unknown group/zone and unrelated config mutations, even when bypassing handlers', () => {
  const original = model();
  for (const change of [
    (value) => value.excel.apply_groups.push('EVIL'),
    (value) => { value.excel.apply_groups = ['*']; },
    (value) => { value.pricing.pricing.mandatoryZoneFloorsPlnDay.EVIL = [{ minDays: 1, maxDays: 35, minimumRatePlnDay: 80 }]; },
    (value) => { value.excel.baseline_manifest_file = 'changed.json'; },
    (value) => { value.excel.group_price_parity.enabled = false; },
    (value) => { value.locations.locations[0].kind = 'city'; },
    (value) => { value.pricing.pricing.pricingPolicy.precedence.reverse(); },
  ]) {
    const value = model();
    change(value);
    assert.ok(validateModel(value, original).errors.length);
  }
});

test('validation keeps zone coverage and same-key group non-overlap required by Python', () => {
  const original = model();
  const missing = removeRule(original, 'zone:SZLO:0');
  assert.ok(validateModel(missing, original).errors.some((item) => /pokry|1.35/i.test(item.message)));
  const overlap = addRule(original, { category: 'mandatory', groups: ['PDAH'], minDays: 20, maxDays: 35, amount: 200 });
  assert.ok(validateModel(overlap, original).errors.some((item) => /nakładają/i.test(item.message)));
  const complete = addRule(original, { category: 'mandatory', zones: ['WA1'], minDays: 1, maxDays: 35, amount: 100 });
  assert.deepEqual(validateModel(complete, original).errors, []);
});

test('cross-group wildcard minima and protected period overlaps warn instead of blocking', () => {
  const original = model();
  let value = addRule(original, { category: 'mandatory', groups: ['CFAV'], minDays: 1, maxDays: 35, amount: 125, startDate: '2026-10-30', endDate: '2026-11-01' });
  value = addRule(value, { category: 'protected', startDate: '2026-10-31', endDate: '2026-11-02' });
  const result = validateModel(value, original);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((item) => /najwyższa/i.test(item.message)));
  assert.ok(result.warnings.some((item) => /ochron.*nakładają/i.test(item.message)));
  assert.equal(preview({ group: 'CFAV', pickupDate: '2026-10-30' }, value).floor, 125);
});

test('city and airport floors replace higher legacy and lower priority minima', () => {
  assert.equal(preview().floor, 60);
  assert.equal(preview({ zone: 'KRLO' }).floor, 30);
  assert.equal(preview({ zone: 'KRTI' }).floor, 30);
  assert.equal(preview({ duration: 8, pickupDate: '2026-07-15' }).floor, 60);
  assert.ok(preview().matchedRuleIds.includes('location:city'));
  assert.equal(preview().marketAllowed, true);
  assert.equal(preview().minimumAfterBaseline, 60);
  assert.equal(preview({ baselineRate: 200 }).minimumAfterBaseline, 200);
});

test('location-only mandatory correction reserves configured premium without changing displayed rule floor', () => {
  const result = preview({ group: 'EDAV' });
  assert.equal(result.floor, 60);
  assert.equal(result.correctionFloor, 61);
  assert.equal(result.minimumAfterBaseline, 61);
});

test('SZLO duration table overrides frozen classes outside protected periods', () => {
  for (const [duration, floor] of [[1, 300], [2, 150], [3, 130], [4, 130], [5, 110], [7, 110], [8, 90], [20, 90], [21, 90], [35, 90]]) {
    const result = preview({ zone: 'SZLO', group: 'CFAV', duration });
    assert.equal(result.floor, floor, String(duration));
    assert.equal(result.minimumAfterBaseline, floor);
    assert.equal(result.marketAllowed, false);
  }
});

test('SZLO protection discrepancy is explicit and never promises an increase blocked by Python', () => {
  const result = preview({ zone: 'SZLO', group: 'CFAV', pickupDate: '2026-12-20', duration: 1, baselineRate: 50 });
  assert.equal(result.protected, true);
  assert.equal(result.marketAllowed, false);
  assert.equal(result.floor, null);
  assert.equal(result.conservativeFloor, 300);
  assert.equal(result.minimumAfterBaseline, 50);
  assert.ok(result.limitations.some((text) => /SZLO|stref/i.test(text) && /chron/i.test(text)));
});

test('wildcard holiday explicit override raises protected frozen groups, retaining higher baseline', () => {
  for (const pickupDate of ['2026-10-30', '2026-10-31', '2026-11-01']) {
    const result = preview({ group: 'CFAV', pickupDate, duration: 35, baselineRate: 80 });
    assert.equal(result.floor, 110);
    assert.equal(result.minimumAfterBaseline, 110);
    assert.equal(result.marketAllowed, false);
    assert.ok(result.matchedRuleIds.includes('group:*:0'));
  }
  assert.equal(preview({ group: 'CFAV', pickupDate: '2026-11-02', duration: 35 }).floor, null);
  assert.equal(preview({ group: 'CFAV', pickupDate: '2026-10-31', baselineRate: 150 }).minimumAfterBaseline, 150);
});

test('PDAH long-term minimum bypasses market freeze but not protection without explicit override', () => {
  assert.equal(preview({ group: 'PDAH', duration: 21 }).floor, 170);
  assert.equal(preview({ group: 'PDAH', duration: 35 }).minimumAfterBaseline, 170);
  assert.equal(preview({ group: 'PDAH', duration: 20 }).floor, null);
  assert.equal(preview({ group: 'PDAH', duration: 21, pickupDate: '2026-12-20', baselineRate: 100 }).minimumAfterBaseline, 100);
  assert.equal(preview({ group: 'PDAH', duration: 21, pickupDate: '2026-10-31' }).floor, 110);
});

test('omission wins over all class holiday and zone minima', () => {
  const result = preview({ zone: 'SZLO', group: 'FVMD', pickupDate: '2026-12-20' });
  assert.equal(result.omitted, true);
  assert.equal(result.marketAllowed, false);
  assert.equal(result.floor, null);
  assert.equal(result.minimumAfterBaseline, null);
  assert.equal(preview({ group: 'FVMD', pickupDate: '2026-12-20', duration: 2 }).floor, 700);
});

test('normal protected dates and long durations cannot authorize market changes', () => {
  assert.equal(preview({ pickupDate: '2027-01-10' }).floor, null);
  assert.equal(preview({ pickupDate: '2027-01-10' }).protected, true);
  assert.equal(preview({ duration: 21 }).marketAllowed, false);
  assert.equal(preview({ duration: 21 }).minimumAfterBaseline, 20);
  assert.equal(preview({ group: 'CFAV' }).marketAllowed, false);
});

test('legacy fallback uses dated minima after timeless scoped and zone overrides are removed', () => {
  const value = model();
  delete value.pricing.pricing.locationTypeFloorsPlnDay;
  value.pricing.pricing.priorityTop1Rules = [];
  assert.equal(preview({ zone: 'KRLO' }, value).floor, 50);
  assert.equal(preview({ zone: 'KRDW' }, value).floor, 50);
  assert.equal(preview({ duration: 8, pickupDate: '2026-07-15' }, value).floor, 115);
  assert.equal(preview({ duration: 1, pickupDate: '2026-07-15' }, value).floor, 70);
  assert.equal(preview({ duration: 1, pickupDate: '2026-10-15' }, value).floor, 50);
});

test('priority fallback overrides legacy only in the exact allowed band and pickup scope', () => {
  const value = model();
  delete value.pricing.pricing.locationTypeFloorsPlnDay;
  assert.equal(preview({}, value).floor, 30);
  assert.equal(preview({ duration: 5 }, value).floor, 40);
  assert.equal(preview({ duration: 1 }, value).floor, 50);
  assert.equal(preview({ pickupDate: '2026-10-26' }, value).floor, 50);
});

test('invalid preview inputs fail closed with explicit limitations and no price claims', () => {
  for (const input of [{ zone: 'FAKE' }, { group: '*' }, { pickupDate: '2026-02-30' }, { duration: 0 }, { duration: 2.5 }, { baselineRate: Infinity }]) {
    const result = preview(input);
    assert.equal(result.marketAllowed, false);
    assert.equal(result.floor, null);
    assert.ok(result.limitations.length);
  }
  const result = preview({ baselineRate: undefined });
  assert.equal(result.floor, 60);
  assert.equal(result.minimumAfterBaseline, null);
  assert.ok(result.limitations.some((text) => /rynkow|cen/i.test(text)));
});

test('group enable/disable is idempotent and cannot reorder untouched permission lists', () => {
  const original = model();
  assert.deepEqual(setGroupEnabled(original, 'CDMV', true), original);
  assert.deepEqual(setGroupEnabled(original, 'FVMD', false), original);
  assert.deepEqual(validateModel(setGroupEnabled(original, 'FVMD', true), original).errors, []);
});

test('editing dates, durations and priority bands changes only the corresponding schema fields', () => {
  const original = model();
  const value = updateRule(original, 'priority:0:1', { amount: 45, minDays: 5, maxDays: 7, endDate: '2026-10-26' });
  assert.deepEqual(value.pricing.pricing.priorityTop1Rules[0].durationBands, [[2, 2], [5, 7]]);
  assert.equal(value.pricing.pricing.priorityTop1Rules[0].minimumRatePlnDay, 45);
  assert.equal(original.pricing.pricing.priorityTop1Rules[0].minimumRatePlnDay, 30);
  assert.deepEqual(value.pricing.pricing.priorityTop1Rules[0].locations, ['*']);
  const protectedValue = updateRule(original, 'protected:0', { startDate: '2026-10-29', endDate: '2026-10-30' });
  assert.deepEqual(protectedValue.excel.protected_rate_periods[0], { start_date: '2026-10-29', end_date: '2026-10-30' });
  assert.deepEqual(validateModel(protectedValue, original).errors, []);
});

test('clearing dated group scope is independent of patch field order and leaves no orphan override', () => {
  const original = model();
  const value = updateRule(original, 'group:*:0', { overrideProtected: false, startDate: '', endDate: '' });
  assert.deepEqual(value.pricing.pricing.mandatoryGroupFloorsPlnDay['*'][0], { minDays: 1, maxDays: 35, minimumRatePlnDay: 110 });
  assert.deepEqual(validateModel(value, original).errors, []);
});

test('unwrapped pricing documents retain their original shape across editing and export', () => {
  const original = createModel({ ...documents, pricing: documents.pricing.pricing });
  const value = updateRule(original, 'location:city', { amount: 75 });
  assert.equal(toDocuments(value).pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city, 75);
  assert.equal(Object.hasOwn(toDocuments(value).pricing, 'pricing'), false);
  assert.deepEqual(validateModel(value, original).errors, []);
});

test('malformed nested configs are reported instead of crashing validation', () => {
  const original = model();
  for (const change of [
    (value) => { value.pricing.pricing = 'invalid'; },
    (value) => { value.excel.protected_rate_periods = [null]; },
    (value) => { value.pricing.pricing.priorityTop1Rules = [{ durationBands: [null] }]; },
    (value) => { value.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind = []; },
    (value) => { value.pricing.pricing.mandatoryGroupFloorsPlnDay.PDAH = [null]; },
  ]) {
    const value = model();
    change(value);
    assert.ok(validateModel(value, original).errors.length);
    assert.equal(preview({}, value).marketAllowed, false);
  }
});

test('all supported duration columns use FVMD dated amounts and protection override boundaries', () => {
  for (const [duration, floor] of [[1, 1000], [2, 700], [3, 600], [4, 600], [5, 500], [7, 500], [8, 500], [20, 500], [21, 400], [35, 400]]) {
    for (const pickupDate of ['2026-12-15', '2027-01-05']) assert.equal(preview({ group: 'FVMD', duration, pickupDate }).floor, floor);
  }
  assert.equal(preview({ group: 'FVMD', pickupDate: '2026-12-14' }).floor, null);
  assert.equal(preview({ group: 'FVMD', pickupDate: '2027-01-06' }).floor, null);
});

test('invalid durations and missing protected/date endpoints cannot be exported as valid drafts', () => {
  const original = model();
  for (const patch of [{ minDays: 0 }, { minDays: 2.5 }, { maxDays: 36 }, { minDays: 35, maxDays: 21 }]) {
    assert.ok(validateModel(updateRule(original, 'group:PDAH:0', patch), original).errors.length);
  }
  assert.ok(validateModel(updateRule(original, 'location:city', { maxDays: 21 }), original).errors.length);
  assert.ok(validateModel(updateRule(original, 'group:*:0', { endDate: '' }), original).errors.length);
  assert.ok(validateModel(addRule(original, { category: 'mandatory', groups: ['CFAV'], overrideProtected: true, amount: 100 }), original).errors.length);
});

test('preview rejects malformed policy precedence rather than silently using its own hierarchy', () => {
  const value = model();
  value.pricing.pricing.pricingPolicy.precedence.reverse();
  assert.ok(validateModel(value).errors.some((item) => /kolejność|hierarch|polityk/i.test(item.message)));
  assert.equal(preview({}, value).floor, null);
});

test('ignore_cap policy permits floor editing and preview without changing the pricing document shape', () => {
  for (const wrapped of [true, false]) {
    const original = createModel({ ...documents, pricing: wrapped ? documents.pricing : documents.pricing.pricing });
    const pricing = wrapped ? original.pricing.pricing : original.pricing;
    pricing.pricingPolicy.normalFloorCapConflict = 'ignore_cap';
    const value = updateRule(original, 'location:city', { amount: 75 });
    assert.deepEqual(validateModel(value, original).errors, []);
    const exported = toDocuments(value).pricing;
    assert.equal(Object.hasOwn(exported, 'pricing'), wrapped);
    assert.equal((wrapped ? exported.pricing : exported).pricingPolicy.normalFloorCapConflict, 'ignore_cap');
    assert.equal(preview({}, value).floor, 75);
    assert.equal(preview({}, value).marketAllowed, true);
    assert.equal(preview({ pickupDate: '2027-01-10' }, value).marketAllowed, false);
    assert.equal(preview({ group: 'CFAV' }, value).marketAllowed, false);
    assert.equal(preview({ zone: 'SZLO', group: 'FVMD' }, value).omitted, true);
    assert.ok(preview({}, value).limitations.some((text) => /dowod/i.test(text)));
  }
});

test('omitted conflict field or pricing policy retains ignore_cap preview behavior without rewriting documents', () => {
  const explicit = model();
  explicit.pricing.pricing.pricingPolicy.normalFloorCapConflict = 'ignore_cap';
  for (const omitPolicy of [false, true]) {
    const value = createModel(explicit);
    if (omitPolicy) delete value.pricing.pricing.pricingPolicy;
    else delete value.pricing.pricing.pricingPolicy.normalFloorCapConflict;
    assert.deepEqual(validateModel(value).errors, []);
    assert.deepEqual(preview({}, value), preview({}, explicit));
    assert.deepEqual(toDocuments(value).pricing, value.pricing);
  }
});

test('retired and unknown conflict policies fail validation and block preview', () => {
  for (const conflict of ['preserve_baseline', 'cap_floor', 'IGNORE_CAP', '', false, 0, {}, []]) {
    const value = model();
    value.pricing.pricing.pricingPolicy.normalFloorCapConflict = conflict;
    assert.ok(validateModel(value).errors.some((item) => item.path === 'pricing.pricing.pricingPolicy'), JSON.stringify(conflict));
    assert.equal(preview({}, value).floor, null);
    assert.equal(preview({}, value).marketAllowed, false);
  }
});

test('full-row editor patches accept unchanged display fields but never replace identity or scope', () => {
  const original = model();
  for (const id of ['location:city', 'group:PDAH:0', 'zone:SZLO:0', 'priority:0', 'protected:0']) {
    const row = buildRules(original).find((item) => item.id === id);
    const patch = { ...row, ...(row.category === 'protected' ? { startDate: '2026-10-29' } : { amount: 200 }) };
    const value = updateRule(original, id, patch);
    const updated = buildRules(value).find((item) => item.id === id);
    assert.equal(updated[row.category === 'protected' ? 'startDate' : 'amount'], row.category === 'protected' ? '2026-10-29' : 200);
    assert.throws(() => updateRule(original, id, { ...patch, id: 'different' }), /identyfik|struktural|pola/i);
  }
});

test('blank preview values return visible reasons without throwing or authorizing changes', () => {
  for (const input of [{ pickupDate: '' }, { baselineRate: '' }, { baselineRate: NaN }]) {
    const result = preview(input);
    assert.equal(result.marketAllowed, false);
    assert.ok(result.reasons.length);
  }
});

test('operational row titles, preview and validation messages are Polish', () => {
  const original = model();
  assert.match(buildRules(original).find((row) => row.id === 'location:city').title, /Miast|Miejsk/i);
  assert.match(buildRules(original).find((row) => row.id === 'location:airport').title, /Lotnisk/i);
  assert.match(buildRules(original).find((row) => row.id === 'protected:0').title, /Chronion/i);
  const messages = [
    ...buildRules(original).map((row) => row.title),
    ...preview().reasons, ...preview().limitations,
    ...preview({ pickupDate: '' }).reasons,
    ...validateModel(updateRule(original, 'location:city', { amount: 0 }), original).errors.map((item) => item.message),
  ];
  assert.ok(messages.every((message) => !/\b(city|airport|legacy|unknown|protected|use|must|rule|group|effective|invalid)\b/i.test(message)));
});
