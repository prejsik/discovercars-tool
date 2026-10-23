const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const engine = require('../src/pricingRules');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const fixtureDirectory = path.join(__dirname, 'fixtures/excel-policy-0939d46');
const fixturePolicy = path.join(fixtureDirectory, 'pricing-rules.config.example.json');
const { pricing } = require(fixturePolicy);
const excelPolicy = require(path.join(fixtureDirectory, 'excel-rate-update.config.example.json'));

const floor = (patch = {}) => ({ groups: ['CDMV', 'CFAV'], zones: ['WA1', 'WALO'],
  startDate: '2026-10-15', endDate: '2026-11-02', minDays: 2, maxDays: 2,
  minimumRatePlnDay: 190, overrideProtected: false, ...patch });
const resolve = (patch = {}, { zone = 'WA1', group = 'CFAV', days = 2, pickup = '2026-10-15' } = {}) =>
  engine.resolveMandatoryScopedFloorPlnDay(zone, days, { mandatoryScopedFloorsPlnDay: [floor(patch)] }, group, pickup, excelPolicy.protected_rate_periods);

test('JS public resolver honors scope, inclusive dates and explicit holiday protection', () => {
  assert.equal(typeof engine.resolveMandatoryScopedFloorPlnDay, 'function');
  assert.equal(resolve(), 190);
  for (const query of [{ zone: 'WR1' }, { group: 'PDAH' }, { days: 3 }, { pickup: '2026-10-14' }, { pickup: '2026-11-03' }]) assert.equal(resolve({}, query), 0);
  assert.equal(resolve({}, { pickup: '2026-11-02' }), 190);
  assert.equal(resolve({}, { pickup: '2026-10-31' }), 0);
  assert.equal(resolve({ overrideProtected: true }, { pickup: '2026-10-31' }), 190);
});

test('JS schema rejects invalid scope, dates, bands, amounts, fields and protection context', () => {
  assert.equal(typeof engine.validateMandatoryScopedFloorsPlnDay, 'function');
  for (const patch of [{ groups: [] }, { groups: ['*'] }, { zones: [] }, { zones: ['wa1'] },
    { startDate: '2026-02-30' }, { endDate: '2026-10-01' }, { maxDays: 3 },
    { minimumRatePlnDay: '190' }, { minimumRatePlnDay: Infinity }, { overrideProtected: 'false' }, { kind: 'city' }]) {
    assert.throws(() => engine.validateMandatoryScopedFloorsPlnDay([floor(patch)]), /mandatoryScopedFloorsPlnDay/);
  }
  assert.throws(() => engine.resolveMandatoryScopedFloorPlnDay('WA1', 2, { mandatoryScopedFloorsPlnDay: [floor()] }, 'CFAV', '2026-10-15'), /protect/i);
  assert.equal(engine.resolveMandatoryScopedFloorPlnDay('WA1', 2, {}, 'CFAV', '2026-10-15'), 0);
  for (const floors of [null, {}, 'bad', [floor({ groups: [] })], [floor({ overrideProtected: 'false' })]]) {
    assert.throws(() => engine.resolveMandatoryScopedFloorPlnDay('WA1', 2, { mandatoryScopedFloorsPlnDay: floors }, 'CFAV', '2026-10-15', []), /mandatoryScopedFloorsPlnDay/);
  }
});

test('JS scoped resolver respects explicit policy omissions before a protected-date override', () => {
  assert.equal(engine.resolveMandatoryScopedFloorPlnDay('SZLO', 2, {
    mandatoryScopedFloorsPlnDay: [floor({ groups: ['FVMD'], zones: ['SZLO'], overrideProtected: true })], excelPolicy,
  }, 'FVMD', '2026-10-31', excelPolicy.protected_rate_periods), 0);
});

const decision = (options, { group = 'CDMV', date = '2026-10-15', location = 'Warsaw West Train Station' } = {}) => {
  const offer = (provider_name, daily) => ({ provider_name, total_price: daily * 2, rental_days: 2, currency: 'PLN' });
  return buildPricingRecommendations({ locations: [location], scenarios: [{
    group, start_date: date, rental_days: 2,
    top_3_plus_mm_by_location: { [location]: { top_3: [offer('Other', 100)], mm_cars_rental: offer('MM Cars Rental', 20) } },
  }] }, { ...pricing, forceTop1: true, brokerMarkupCalibration: { enabled: false }, excelPolicy, ...options }).decisions[0];
};

test('real JS recommendations cannot recommend below scoped mandatory floors', () => {
  const options = { mandatoryScopedFloorsPlnDay: [floor()] };
  const result = decision(options);
  assert.equal(result.mandatory_minimum_rate_pln_day, 190);
  assert.equal(result.action, 'hold');
  assert.equal(result.suggested_rate_pln_day, null);
  assert.equal(decision(options, { location: 'Wroclaw Downtown' }).mandatory_minimum_rate_pln_day, 60);
  assert.equal(decision(options, { date: '2026-10-31' }).mandatory_minimum_rate_pln_day, 60);
  for (const bad of [floor({ groups: ['ZZZZ'] }), floor({ zones: ['FAKE'] })]) {
    assert.throws(() => decision({ mandatoryScopedFloorsPlnDay: [bad] }), /known|scope|group|zone/i);
  }
  assert.throws(() => decision({ ...options, excelPolicy: { ...excelPolicy, protected_rate_periods: 'bad' } }), /protect/i);
});

test('higher existing dated class floors prevail wherever the scoped matrix is active', () => {
  const rules = [floor({ groups: ['FVMD'], startDate: '2026-12-15', endDate: '2027-01-10', overrideProtected: true })];
  const result = decision({ mandatoryScopedFloorsPlnDay: rules }, { group: 'FVMD', date: '2026-12-25' });
  assert.equal(result.mandatory_minimum_rate_pln_day, 700);
  assert.equal(result.action, 'hold');
  const old = decision({}, { group: 'FVMD', date: '2026-12-25' });
  assert.equal(old.mandatory_minimum_rate_pln_day, undefined);
});

test('real loader validates new shared field and leaves old config behavior untouched', () => {
  const baseline = engine.loadPricingRules(fixturePolicy);
  assert.equal(baseline.mandatoryScopedFloorsPlnDay, undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-rules-'));
  try {
    const filename = path.join(dir, 'rules.json');
    fs.writeFileSync(filename, JSON.stringify({ pricing: { ...pricing, mandatoryScopedFloorsPlnDay: [floor()] } }));
    assert.deepEqual(engine.loadPricingRules(filename).mandatoryScopedFloorsPlnDay, [floor()]);
    fs.writeFileSync(filename, JSON.stringify({ pricing: { mandatoryScopedFloorsPlnDay: [floor({ maxDays: 3 })] } }));
    assert.throws(() => engine.loadPricingRules(filename), /mandatoryScopedFloorsPlnDay/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
