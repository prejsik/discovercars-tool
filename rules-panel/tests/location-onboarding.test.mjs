import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { inspectBaseline, compareBaselineCoverage } from '../server/baseline.mjs';
import { MAX_LOCATION_ADDITIONS, prepareLocationAdditions } from '../server/location-onboarding.mjs';
import markup from '../../src/brokerMarkupCalibration.js';

const baselineDocuments = {
  excel: { apply_groups: ['CDMV'], excluded_groups: ['FVMD'], omitted_group_zones: {} },
  locations: { locations: [{ zones: ['KRLO'] }] },
};
const rateRow = (group, zone) => [group, '', '', zone, '27-04-26', '16-11-26', '16-10-26', '16-10-26', 35, 35, 35, 40, 40, 100];
function workbook(rows = [rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO')], edit = text => text) {
  const row = (number, values) => `<row r="${number}">${values.map((value, index) => `<c r="${String.fromCharCode(65 + index)}${number}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`;
  const headers = ['Group', 'Description', 'Rate code', 'Zone', 'Booking start date', 'Booking end date', 'Pickup start date', 'Pickup end date', ...Array(6).fill('Per day')];
  const sheet = edit(`<worksheet><sheetData>${row(2, ['Min days', '', '', '', '', '', '', '', 1, 2, 3, 5, 8, 21])}${row(3, ['Max days', '', '', '', '', '', '', '', 1, 2, 4, 7, 20, 35])}${row(4, headers)}${rows.map((values, index) => row(index + 5, values)).join('')}</sheetData></worksheet>`);
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  }).map(([name, text]) => [name, strToU8(text)])));
}

test('baseline discovery reports sorted unique unknown zones only when explicitly enabled', async () => {
  const rows = [rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO'), rateRow('CDMV', 'ZZ9'), rateRow('FVMD', 'AA2'), rateRow('CDMV', 'ZZ9')];
  const bytes = workbook(rows);
  const original = bytes.slice();
  const documents = structuredClone(baselineDocuments);
  const summary = await inspectBaseline(bytes, documents, { allowUnknownZones: true });
  assert.deepEqual(summary.unknownZones, ['AA2', 'ZZ9']);
  assert.deepEqual(summary.zones, ['AA2', 'KRLO', 'ZZ9']);
  assert.deepEqual(summary.pairs, ['CDMV/KRLO', 'CDMV/ZZ9', 'FVMD/AA2', 'FVMD/KRLO']);
  assert.equal(summary.rowCount, 5);
  assert.deepEqual(bytes, original);
  assert.deepEqual(documents, baselineDocuments);
  for (const options of [undefined, {}, { allowUnknownZones: false }, { allowUnknownZones: 'true' }]) {
    await assert.rejects(inspectBaseline(bytes, documents, options), error => error.status === 422);
  }
});

test('default baseline summary is unchanged and discovery includes an empty unknown-zone list', async () => {
  const bytes = workbook();
  const strict = await inspectBaseline(bytes, baselineDocuments);
  assert.equal(Object.hasOwn(strict, 'unknownZones'), false);
  assert.deepEqual(await inspectBaseline(bytes, baselineDocuments, { allowUnknownZones: true }), { ...strict, unknownZones: [] });
});

for (const zone of ['', 'A', 'aA2', 'AB_2', 'ABCDEFGHIJKLM', 'AA-2']) {
  test(`discovery rejects malformed unknown zone ${JSON.stringify(zone)}`, async () => {
    await assert.rejects(inspectBaseline(workbook([rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO'), rateRow('CDMV', zone)]), baselineDocuments, { allowUnknownZones: true }), error => error.status === 422);
  });
}

for (const [name, rows, edit] of [
  ['unknown classes', [rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO'), rateRow('HACK', 'AA2')]],
  ['missing existing zones', [rateRow('CDMV', 'AA2'), rateRow('FVMD', 'AA2')]],
  ['missing existing classes', [rateRow('CDMV', 'KRLO'), rateRow('CDMV', 'AA2')]],
  ['zero rates', [rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO'), rateRow('CDMV', 'AA2')], text => text.replace('>35<', '>0<')],
  ['negative rates', [rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO'), rateRow('CDMV', 'AA2')], text => text.replace('>35<', '>-1<')],
  ['bad headers', undefined, text => text.replace('>Zone<', '>Location<')],
  ['bad duration bands', undefined, text => text.replace('>21<', '>22<')],
  ['invalid dates', undefined, text => text.replace('16-10-26', '31-02-26')],
  ['formulas', undefined, text => text.replace('<is><t>35</t></is>', '<f>1+1</f><v>35</v>')],
]) {
  test(`discovery still rejects ${name}`, async () => {
    await assert.rejects(inspectBaseline(workbook(rows, edit), baselineDocuments, { allowUnknownZones: true }), error => error.status === 422);
  });
}

test('discovery preserves exclusions and previous pair coverage validation', async () => {
  const rows = [rateRow('CDMV', 'KRLO'), rateRow('FVMD', 'KRLO'), rateRow('CDMV', 'AA2')];
  const documents = structuredClone(baselineDocuments);
  documents.excel.omitted_group_zones.AA2 = ['CDMV'];
  await assert.rejects(inspectBaseline(workbook(rows), documents, { allowUnknownZones: true }), error => error.status === 422);
  const summary = await inspectBaseline(workbook(rows), baselineDocuments, { allowUnknownZones: true });
  assert.throws(() => compareBaselineCoverage(summary, { pairs: ['FVMD/AA2'] }), /FVMD\/AA2/);
});

const airportTable = { '1': 46, '2': 36, '3-4': 20, '5-7': 15, '8-20': 18, '21-35': 18 };
const cityTable = { '1': 36, '2': 26, '3-4': 10, '5-7': 6, '8-20': 9, '21-35': 9 };
const airport = { placeId: 6144, label: 'Rzesz\u00f3w\u2013Jasionka Airport (RZE)', city: 'Rzeszow', kind: 'airport' };
function onboarding() {
  return {
    documents: {
      pricing: { pricing: { brokerMarkupCalibration: { manualOnly: true },
        mandatoryZoneFloorsPlnDay: { KRLO: [{ minDays: 1, maxDays: 35, minimumRatePlnDay: 300 }] },
        mandatoryGroupFloorsPlnDay: { '*': [{ minDays: 1, maxDays: 35, minimumRatePlnDay: 99 }] } } },
      excel: { ...structuredClone(baselineDocuments.excel), scoped_overrides: [{ zones: ['KRLO'], amount: 123 }] },
      locations: { schema_version: 1, profiles: { daily: ['krakow_airport'], legacy_default: ['Krakow'] },
        locations: [
          { id: 'krakow_airport', scraper_label: 'Krakow Airport (KRK)', city: 'Krakow', kind: 'airport', zones: ['KRLO', 'KRTI'], discovercars: { place_id: 4146 } },
          { id: 'krakow_station', scraper_label: 'Krakow Train Station', city: 'Krakow', kind: 'city', zones: ['KRDW'], discovercars: { place_id: 8504 } },
        ], aliases: { Krakow: ['KRLO', 'KRTI', 'KRDW'] }, zone_seeds: { KRTI: 'KRLO' }, zone_mirrors: { KRTI: 'KRLO' } },
    },
    frozen: { schema_version: 2, status: 'fixed_user_approved', frozen_at: '2026-09-30', note: 'Never recalibrate',
      brokerMarkupCalibration: { enabled: true, manualOnly: true, model: 'fixed_amount', baseGroups: ['CDMV'], groupSupplementsPlnDay: { FVMD: 10 },
        zoneLocations: { KRLO: 'Krakow Airport (KRK)', KRTI: 'Krakow Airport (KRK)', KRDW: 'Krakow Train Station' },
        locationDurationAmounts: { 'Krakow Airport (KRK)': structuredClone(airportTable), 'Krakow Train Station': structuredClone(cityTable) } } },
    additions: [{ zone: 'RZLO', query: 'Rzeszow', placeId: 6144, markupSourceZone: 'KRLO', daily: true }],
    unknownZones: ['RZLO'],
    candidates: { RZLO: structuredClone(airport) },
  };
}

function assertRejected(input) {
  const original = structuredClone(input);
  assert.throws(() => prepareLocationAdditions(input), error => error.status === 422);
  assert.deepEqual(input, original, 'rejection must not mutate any input');
}

test('two new zones for one verified place merge alongside a mapping to an existing point', () => {
  const input = onboarding();
  input.unknownZones.push('RZTI', 'KRNEW');
  input.additions.push({ ...input.additions[0], zone: 'RZTI' }, { zone: 'KRNEW', existingLocationId: 'krakow_station', daily: false });
  input.candidates.RZTI = structuredClone(airport);
  const before = structuredClone(input);
  const result = prepareLocationAdditions(input);
  assert.deepEqual(Object.keys(result).sort(), ['additions', 'documents', 'frozen']);
  assert.deepEqual(input, before);
  assert.deepEqual(result.additions, before.additions);
  assert.notEqual(result.additions, input.additions);
  assert.equal(result.documents.locations.locations.length, 3);
  assert.deepEqual(result.documents.locations.locations[2], { id: 'location_6144', scraper_label: airport.label,
    city: 'Rzeszow', kind: 'airport', zones: ['RZLO', 'RZTI'], discovercars: { place_id: 6144, require_place_id: true } });
  assert.deepEqual(result.documents.locations.locations[0], before.documents.locations.locations[0]);
  assert.deepEqual(result.documents.locations.locations[1], { ...before.documents.locations.locations[1], zones: ['KRDW', 'KRNEW'] });
  assert.deepEqual(result.documents.locations.profiles.daily, ['krakow_airport', 'location_6144']);
  const calibration = result.frozen.brokerMarkupCalibration;
  assert.equal(calibration.zoneLocations.RZLO, airport.label);
  assert.equal(calibration.zoneLocations.RZTI, airport.label);
  assert.equal(calibration.zoneLocations.KRNEW, 'Krakow Train Station');
  assert.deepEqual(calibration.locationDurationAmounts[airport.label], airportTable);
  assert.notEqual(calibration.locationDurationAmounts[airport.label], calibration.locationDurationAmounts['Krakow Airport (KRK)']);
  for (const [key, value] of Object.entries(before.frozen.brokerMarkupCalibration.zoneLocations)) assert.equal(calibration.zoneLocations[key], value);
  for (const [key, value] of Object.entries(before.frozen.brokerMarkupCalibration.locationDurationAmounts)) assert.deepEqual(calibration.locationDurationAmounts[key], value);
  for (const key of ['pricing', 'excel']) assert.equal(JSON.stringify(result.documents[key]), JSON.stringify(before.documents[key]));
  for (const key of ['aliases', 'zone_seeds', 'zone_mirrors']) assert.deepEqual(result.documents.locations[key], before.documents.locations[key]);
  assert.equal(result.frozen.frozen_at, before.frozen.frozen_at);
  assert.equal(result.frozen.note, before.frozen.note);
  result.documents.pricing.pricing.mandatoryZoneFloorsPlnDay.KRLO[0].minimumRatePlnDay = 1;
  result.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['1'] = 1;
  result.additions[0].zone = 'CHANGED';
  assert.deepEqual(input, before, 'returned documents, frozen tables and additions must be deep clones');
});

for (const daily of [false, true]) {
  test(`new place daily=${daily} appends membership only when requested`, () => {
    const input = onboarding();
    input.additions[0].daily = daily;
    const result = prepareLocationAdditions(input);
    assert.deepEqual(result.documents.locations.profiles.daily, daily ? ['krakow_airport', 'location_6144'] : ['krakow_airport']);
  });
}

test('existing daily points stay daily for false; true adds an existing non-daily point only once', () => {
  const input = onboarding();
  input.unknownZones = ['KRNEW', 'KRNEW2', 'KRNEW3'];
  input.additions = [
    { zone: 'KRNEW', existingLocationId: 'krakow_airport', daily: false },
    { zone: 'KRNEW2', existingLocationId: 'krakow_station', daily: true },
    { zone: 'KRNEW3', existingLocationId: 'krakow_station', daily: true },
  ];
  input.candidates = {};
  const result = prepareLocationAdditions(input);
  assert.deepEqual(result.documents.locations.profiles.daily, ['krakow_airport', 'krakow_station']);
  assert.deepEqual(result.frozen.brokerMarkupCalibration.locationDurationAmounts, input.frozen.brokerMarkupCalibration.locationDurationAmounts);
});

test('existing point inherits its effective frozen redirect rather than creating or changing a label table', () => {
  const input = onboarding();
  const calibration = input.frozen.brokerMarkupCalibration;
  calibration.zoneLocations.KRDW = 'Krakow Airport (KRK)';
  calibration.zoneLocations['Krakow Train Station'] = 'Krakow Airport (KRK)';
  delete calibration.locationDurationAmounts['Krakow Train Station'];
  input.additions = [{ zone: 'RZLO', existingLocationId: 'krakow_station', markupSourceZone: 'KRLO', daily: false }];
  input.candidates = {};
  const result = prepareLocationAdditions(input);
  assert.equal(result.frozen.brokerMarkupCalibration.zoneLocations.RZLO, 'Krakow Airport (KRK)');
  assert.deepEqual(result.frozen.brokerMarkupCalibration.locationDurationAmounts, calibration.locationDurationAmounts);
});

for (const [city, canonical] of [['krak\u00f3W', 'Krakow'], ['\u0141\u00f3D\u0179', 'Lodz'], ['WROC\u0141AW', 'Wroclaw']]) {
  test(`candidate city ${city} reuses an existing registry city without changing the verified label`, () => {
    const input = onboarding();
    input.documents.locations.locations[0].city = canonical;
    input.candidates.RZLO.city = city;
    const added = prepareLocationAdditions(input).documents.locations.locations[2];
    assert.equal(added.city, canonical);
    assert.equal(added.scraper_label, airport.label);
  });
}

test('zero fixed markup is a valid six-band donor and a query is optional for an already verified place', () => {
  const input = onboarding();
  delete input.additions[0].query;
  input.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['1'] = 0;
  assert.equal(prepareLocationAdditions(input).frozen.brokerMarkupCalibration.locationDurationAmounts[airport.label]['1'], 0);
});

test('empty discovery returns independent unchanged copies', () => {
  const input = onboarding();
  input.unknownZones = []; input.additions = []; input.candidates = {};
  const result = prepareLocationAdditions(input);
  assert.deepEqual(result, { documents: input.documents, frozen: input.frozen, additions: [] });
  assert.notEqual(result.documents, input.documents);
  assert.notEqual(result.frozen, input.frozen);
});

test('new city point shares the canonical city with airport references without changing pricing scopes', () => {
  const input = onboarding();
  input.candidates.RZLO = { placeId: 6144, label: 'Krak\u00f3w Downtown', city: 'KRAK\u00d3W', kind: 'city' };
  const result = prepareLocationAdditions(input);
  const added = result.documents.locations.locations[2];
  assert.equal(added.kind, 'city');
  assert.equal(added.city, 'Krakow');
  assert.deepEqual(result.documents.locations.locations.filter(entry => entry.kind === 'airport' && entry.city === added.city).map(entry => entry.scraper_label), ['Krakow Airport (KRK)']);
  assert.deepEqual(result.documents.pricing, input.documents.pricing);
  assert.deepEqual(result.documents.excel, input.documents.excel);
});

for (const daily of [false, true]) {
  test(`missing daily profile is ${daily ? 'created' : 'left untouched'} for daily=${daily}`, () => {
    const input = onboarding();
    delete input.documents.locations.profiles;
    input.additions[0].daily = daily;
    const registry = prepareLocationAdditions(input).documents.locations;
    assert.deepEqual(registry.profiles, daily ? { daily: ['location_6144'] } : undefined);
  });
}

test('existing point accepts an explicit equal donor without replacing frozen tables', () => {
  const input = onboarding();
  input.additions = [{ zone: 'RZLO', existingLocationId: 'krakow_airport', markupSourceZone: 'KRTI', daily: false }];
  input.candidates = {};
  const result = prepareLocationAdditions(input);
  assert.equal(result.frozen.brokerMarkupCalibration.zoneLocations.RZLO, 'Krakow Airport (KRK)');
  assert.deepEqual(result.frozen.brokerMarkupCalibration.locationDurationAmounts, input.frozen.brokerMarkupCalibration.locationDurationAmounts);
});

test('two distinct new places receive independent tables and exact verified labels', () => {
  const input = onboarding();
  input.unknownZones.push('RZCITY');
  input.additions.push({ zone: 'RZCITY', placeId: 355145, markupSourceZone: 'KRDW', daily: false });
  input.candidates.RZCITY = { placeId: 355145, label: 'Rzeszow Train Station', city: 'Rzeszow', kind: 'city' };
  const result = prepareLocationAdditions(input);
  assert.equal(result.documents.locations.locations.length, 4);
  assert.equal(result.documents.locations.locations[3].id, 'location_355145');
  assert.deepEqual(result.frozen.brokerMarkupCalibration.locationDurationAmounts['Rzeszow Train Station'], cityTable);
  assert.deepEqual(result.documents.locations.profiles.daily, ['krakow_airport', 'location_6144']);
});

for (const [order, canonical] of [
  [['RZLO', 'RZCITY'], 'Rzesz\u00f3w'],
  [['RZCITY', 'RZLO'], 'Rzeszow'],
]) {
  for (const existingCity of [false, true]) {
    test(`batch city canonicalization links airport/station in ${order.join(',')} order with existing city=${existingCity}`, () => {
      const input = onboarding();
      if (existingCity) input.documents.locations.locations[0].city = 'RZESZOW';
      const additions = {
        RZLO: input.additions[0],
        RZCITY: { zone: 'RZCITY', placeId: 355145, markupSourceZone: 'KRDW', daily: false },
      };
      input.unknownZones = order;
      input.additions = order.map(zone => additions[zone]);
      input.candidates = {
        RZLO: { ...airport, city: 'Rzesz\u00f3w' },
        RZCITY: { placeId: 355145, label: 'Rzeszow Train Station', city: 'Rzeszow', kind: 'city' },
      };
      const before = structuredClone(input);
      const result = prepareLocationAdditions(input);
      const locations = result.documents.locations.locations;
      const addedAirport = locations.find(entry => entry.id === 'location_6144');
      const station = locations.find(entry => entry.id === 'location_355145');
      assert.equal(addedAirport.city, existingCity ? 'RZESZOW' : canonical);
      assert.equal(station.city, addedAirport.city);
      assert.ok(locations.filter(entry => entry.kind === 'airport' && entry.city === station.city).includes(addedAirport));
      assert.equal(addedAirport.scraper_label, airport.label);
      assert.equal(station.scraper_label, 'Rzeszow Train Station');
      assert.deepEqual(input, before);
    });
  }
}

for (const [name, change] of [
  ['unmapped unknown zone', value => value.unknownZones.push('RZTI')],
  ['extra zone', value => value.additions.push({ ...value.additions[0], zone: 'RZTI' })],
  ['duplicate mapping', value => value.additions.push({ ...value.additions[0] })],
  ['duplicate discovery zone', value => value.unknownZones.push('RZLO')],
  ['existing zone in discovery', value => { value.unknownZones = ['KRLO']; value.additions[0].zone = 'KRLO'; }],
  ['existing zone in mapping', value => value.additions[0].zone = 'KRLO'],
  ['malformed zone', value => { value.unknownZones = ['rzlo']; value.additions[0].zone = 'rzlo'; }],
  ['non-array additions', value => value.additions = {}],
  ['non-array discovery', value => value.unknownZones = {}],
  ['null mapping', value => value.additions[0] = null],
  ['sparse mappings', value => value.additions = new Array(1)],
  ['unknown mapping field', value => value.additions[0].label = 'Client-selected label'],
  ['client-supplied city', value => value.additions[0].city = 'Other city'],
  ['client-supplied kind', value => value.additions[0].kind = 'airport'],
  ['missing daily', value => delete value.additions[0].daily],
  ['non-boolean daily', value => value.additions[0].daily = 'true'],
  ['missing selection', value => delete value.additions[0].placeId],
  ['invalid place id', value => value.additions[0].placeId = 0],
  ['non-integer place id', value => value.additions[0].placeId = 6.5],
  ['unsafe place id', value => value.additions[0].placeId = Number.MAX_SAFE_INTEGER + 1],
  ['missing new-place donor', value => delete value.additions[0].markupSourceZone],
  ['unknown donor', value => value.additions[0].markupSourceZone = 'NOPE'],
  ['new zone used as donor', value => value.additions[0].markupSourceZone = 'RZLO'],
  ['blank query', value => value.additions[0].query = ' '],
  ['oversize query', value => value.additions[0].query = 'x'.repeat(201)],
  ['missing verified candidate', value => value.candidates = {}],
  ['candidate list instead of per-zone object', value => value.candidates = [airport]],
  ['mismatched verified id', value => value.candidates.RZLO.placeId = 9999],
  ['invalid verified id', value => value.candidates.RZLO.placeId = -1],
  ['blank candidate label', value => value.candidates.RZLO.label = ' '],
  ['blank candidate city', value => value.candidates.RZLO.city = ' '],
  ['railway candidate', value => value.candidates.RZLO.kind = 'railway'],
  ['generic all-locations candidate', value => value.candidates.RZLO.kind = 'all_locations'],
  ['raw lookup candidate', value => value.candidates.RZLO = { placeID: 6144, place: airport.label, city: 'Rzeszow', location: 'airport' }],
  ['candidate for unrelated zone', value => value.candidates.UNRELATED = airport],
  ['duplicate registry place id', value => { value.candidates.RZLO.placeId = 4146; value.additions[0].placeId = 4146; }],
  ['duplicate normalized registry label', value => value.candidates.RZLO.label = '  KRAK\u00d3W   AIRPORT (KRK)  '],
  ['duplicate punctuation-normalized registry label', value => value.candidates.RZLO.label = 'Krakow-Airport [KRK]'],
  ['duplicate engine-normalized label with accents', value => { value.documents.locations.locations[0].scraper_label = 'Rzesz w Airport (RZE)'; value.candidates.RZLO.label = 'Rzesz\u00f3w Airport (RZE)'; }],
  ['duplicate internal id', value => value.documents.locations.locations[0].id = 'location_6144'],
  ['existing frozen label collision', value => value.frozen.brokerMarkupCalibration.locationDurationAmounts[airport.label] = cityTable],
  ['existing frozen label alias collision', value => value.frozen.brokerMarkupCalibration.zoneLocations[airport.label] = 'Krakow Train Station'],
  ['existing frozen label reference collision', value => value.frozen.brokerMarkupCalibration.zoneLocations.OLDZONE = airport.label],
  ['missing documents', value => value.documents = null],
  ['missing pricing document', value => delete value.documents.pricing],
  ['missing Excel document', value => delete value.documents.excel],
  ['missing location registry', value => delete value.documents.locations],
  ['malformed daily profile', value => value.documents.locations.profiles.daily = {}],
  ['missing frozen document', value => value.frozen = null],
  ['automatic frozen calibration', value => value.frozen.brokerMarkupCalibration.manualOnly = false],
  ['non-fixed frozen calibration', value => value.frozen.brokerMarkupCalibration.model = 'multiplier'],
  ['missing frozen zone map', value => delete value.frozen.brokerMarkupCalibration.zoneLocations],
  ['missing donor mapping', value => delete value.frozen.brokerMarkupCalibration.zoneLocations.KRLO],
  ['missing donor table', value => delete value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']],
  ['missing donor band', value => delete value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['2']],
  ['extra donor band', value => value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['36-99'] = 10],
  ['negative donor markup', value => value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['1'] = -1],
  ['non-finite donor markup', value => value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['1'] = Infinity],
  ['string donor markup', value => value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']['1'] = '46'],
  ['frozen mapping overwrite', value => value.frozen.brokerMarkupCalibration.zoneLocations.RZLO = 'Krakow Airport (KRK)'],
  ['unknown existing point', value => { value.additions = [{ zone: 'RZLO', existingLocationId: 'missing', daily: false }]; value.candidates = {}; }],
  ['mixed existing and new selection', value => value.additions[0].existingLocationId = 'krakow_airport'],
  ['unequal donor for existing point', value => { value.additions = [{ zone: 'RZLO', existingLocationId: 'krakow_station', markupSourceZone: 'KRLO', daily: false }]; value.candidates = {}; }],
  ['conflicting zone tables for existing point', value => { value.frozen.brokerMarkupCalibration.zoneLocations.KRTI = 'Krakow Train Station'; value.additions = [{ zone: 'RZLO', existingLocationId: 'krakow_airport', daily: false }]; value.candidates = {}; }],
  ['missing label-scenario table for existing point', value => { value.frozen.brokerMarkupCalibration.zoneLocations.KRDW = 'Krakow Airport (KRK)'; delete value.frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Train Station']; value.additions = [{ zone: 'RZLO', existingLocationId: 'krakow_station', daily: false }]; value.candidates = {}; }],
]) {
  test(`onboarding rejects ${name} without mutating inputs`, () => {
    const input = onboarding(); change(input); assertRejected(input);
  });
}

for (const [name, change] of [
  ['different daily flags', value => value.additions[1].daily = false],
  ['different donor tables', value => value.additions[1].markupSourceZone = 'KRDW'],
  ['different donor zones even with equal tables', value => value.additions[1].markupSourceZone = 'KRTI'],
  ['inconsistent verified labels', value => value.candidates.RZTI.label = 'Another verified label'],
  ['inconsistent verified cities', value => value.candidates.RZTI.city = 'Another city'],
  ['inconsistent verified kinds', value => value.candidates.RZTI.kind = 'city'],
  ['same normalized label for different new place ids', value => { value.candidates.RZTI.placeId = 9999; value.additions[1].placeId = 9999; }],
]) {
  test(`new zones sharing a place reject ${name} atomically`, () => {
    const input = onboarding();
    input.unknownZones.push('RZTI'); input.additions.push({ ...input.additions[0], zone: 'RZTI' }); input.candidates.RZTI = structuredClone(airport);
    change(input); assertRejected(input);
  });
}

test('onboarding accepts twelve zones and rejects oversized mapping/discovery arrays before any mutation', () => {
  const input = onboarding();
  input.unknownZones = Array.from({ length: 12 }, (_, index) => `RZ${index}`);
  input.additions = input.unknownZones.map(zone => ({ ...input.additions[0], zone }));
  input.candidates = Object.fromEntries(input.unknownZones.map(zone => [zone, structuredClone(airport)]));
  assert.equal(prepareLocationAdditions(input).documents.locations.locations[2].zones.length, 12);
  input.unknownZones.push('RZ12'); input.additions.push({ ...input.additions[0], zone: 'RZ12' }); input.candidates.RZ12 = structuredClone(airport);
  assertRejected(input);
  assert.equal(MAX_LOCATION_ADDITIONS, 12);
});

test('real frozen calibration and registry preserve old entries including proxy markup scenarios', async () => {
  const read = async path => JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));
  const documents = { pricing: await read('pricing-rules.config.example.json'), excel: await read('excel-rate-update.config.example.json'), locations: await read('locations.config.json') };
  const frozen = await read('input/broker-markup-frozen.json');
  const input = { documents, frozen, additions: [{ zone: 'SZNEW', existingLocationId: 'szczecin_train_station', daily: false },
    { zone: 'RZLO', placeId: 6144, markupSourceZone: 'KRLO', daily: true }], unknownZones: ['RZLO', 'SZNEW'], candidates: { RZLO: airport } };
  const before = structuredClone(input);
  const result = prepareLocationAdditions(input);
  const next = result.frozen.brokerMarkupCalibration;
  for (const entry of documents.locations.locations) {
    const updated = result.documents.locations.locations.find(location => location.id === entry.id);
    assert.deepEqual({ ...updated, zones: entry.zones }, entry);
    for (const zone of entry.zones) for (const duration of [1, 2, 3, 5, 8, 21]) {
      const item = { zone, location: entry.scraper_label, rental_days: duration, group: 'CDMV' };
      assert.deepEqual(markup.resolveBrokerMarkupCalibration(item, next), markup.resolveBrokerMarkupCalibration(item, frozen.brokerMarkupCalibration));
    }
  }
  assert.equal(next.zoneLocations.SZNEW, 'Katowice Downtown');
  assert.equal(markup.resolveBrokerMarkupCalibration({ zone: 'SZNEW', location: 'Szczecin Train Station', rental_days: 1, group: 'CDMV' }, next).amountPlnDay, 70);
  assert.deepEqual(next.locationDurationAmounts[airport.label], frozen.brokerMarkupCalibration.locationDurationAmounts['Krakow Airport (KRK)']);
  for (const [key, value] of Object.entries(frozen.brokerMarkupCalibration.zoneLocations)) assert.equal(next.zoneLocations[key], value);
  for (const [key, value] of Object.entries(frozen.brokerMarkupCalibration.locationDurationAmounts)) assert.deepEqual(next.locationDurationAmounts[key], value);
  assert.equal(JSON.stringify(result.documents.pricing), JSON.stringify(documents.pricing));
  assert.equal(JSON.stringify(result.documents.excel), JSON.stringify(documents.excel));
  assert.deepEqual(input, before);
});
