import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { processBaseline } from '../server/baseline-onboarding-service.mjs';
import { inspectBaseline } from '../server/baseline.mjs';

function workbook(zones) {
  const headers = ['Group','Description','Rate code','Zone','Booking start date','Booking end date','Pickup start date','Pickup end date',...Array(6).fill('Per day')];
  const row = (number, values) => `<row r="${number}">${values.map((value,i) => `<c r="${String.fromCharCode(65+i)}${number}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`;
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${row(2,['Min days','','','','Date format:','','','',1,2,3,5,8,21])}${row(3,['Max days','','','','dd-MM-yy','','','',1,2,4,7,20,35])}${row(4,headers)}${zones.map((zone,i)=>row(i+5,['CDMV','','',zone,'01-01-26','31-12-27','31-10-26','31-12-27',500,500,500,500,500,500])).join('')}</sheetData></worksheet>`,
  }).map(([name, value]) => [name, strToU8(value)])));
}

async function setup() {
  const documents = { pricing: { pricing: {} }, excel: { apply_groups: ['CDMV'], excluded_groups: [], omitted_group_zones: {} },
    locations: { schema_version: 1, profiles: { daily: ['warsaw'] }, locations: [
      { id: 'warsaw', scraper_label: 'Warsaw Chopin Airport (WAW)', city: 'Warsaw', kind: 'airport', zones: ['WALO'], discovercars: { place_id: 100 } },
    ] } };
  const previousBytes = workbook(['WALO']);
  const previous = await inspectBaseline(previousBytes, documents);
  const snapshot = { source: { revision: 'a'.repeat(40) }, baseline: { sha256: previous.sha256, filename: 'old.xlsx' }, documents };
  const frozen = JSON.parse(await readFile(new URL('../../input/broker-markup-frozen.json', import.meta.url), 'utf8'));
  const writes = [];
  const cache = new Map();
  const input = { filename: 'new.xlsx', content: Buffer.from(workbook(['WALO','RZLO'])).toString('base64'), importConfirmed: true };
  const repository = { snapshot: async () => snapshot, baselineBytes: async () => previousBytes,
    frozenMarkup: async () => frozen, publishBaseline: async value => { writes.push(value); return { revision: 'b'.repeat(40) }; } };
  const storage = { get: async key => cache.get(key), put: async (key,value) => cache.set(key,value) };
  const search = async () => [{ placeId: 6144, label: 'Rzeszow Airport (RZE)', city: 'Rzeszow', kind: 'airport' }];
  const additions = [{ zone: 'RZLO', placeId: 6144, query: 'Rzeszow', markupSourceZone: 'WALO', daily: true }];
  return { repository, storage, input, search, additions, writes, snapshot, frozen };
}

test('incomplete onboarding only discovers new zones and keeps the active baseline untouched', async () => {
  const ctx = await setup();
  const original = JSON.stringify(ctx.snapshot);
  const result = await processBaseline({ ...ctx, actor: 'director@example.com' });
  assert.deepEqual(result.onboarding.unknownZones, ['RZLO']);
  assert.equal(result.onboarding.ready, false);
  assert.equal(ctx.writes.length, 0);
  assert.equal(JSON.stringify(ctx.snapshot), original);
  await assert.rejects(processBaseline({ ...ctx, publish: true, actor: 'director@example.com' }), error => error.status === 422);
  assert.equal(ctx.writes.length, 0);
});

test('verified complete configuration and original Excel are handed to one atomic publication', async () => {
  const ctx = await setup();
  const original = JSON.stringify([ctx.snapshot, ctx.frozen]);
  const input = { ...ctx.input, locationAdditions: ctx.additions };
  const check = await processBaseline({ ...ctx, input, actor: 'director@example.com' });
  assert.equal(check.onboarding.ready, true);
  assert.equal(ctx.writes.length, 0);
  await processBaseline({ ...ctx, actor: 'director@example.com', publish: true, input: { ...input,
    sourceRevision: check.sourceRevision, previousSha256: check.previousSha256,
    checkedSha256: check.summary.sha256, checkedOnboardingHash: check.onboardingHash } });
  assert.equal(ctx.writes.length, 1);
  assert.equal(ctx.writes[0].input.content, input.content);
  assert.equal(ctx.writes[0].onboarding.documents.locations.locations.length, 2);
  assert.equal(JSON.stringify([ctx.snapshot, ctx.frozen]), original);
});

test('changed configuration, stale main and failed verification cannot publish partial state', async () => {
  const ctx = await setup();
  const input = { ...ctx.input, locationAdditions: ctx.additions };
  const check = await processBaseline({ ...ctx, input, actor: 'director@example.com' });
  const approved = { ...input, sourceRevision: check.sourceRevision, previousSha256: check.previousSha256,
    checkedSha256: check.summary.sha256, checkedOnboardingHash: check.onboardingHash };
  for (const changed of [ { ...approved, sourceRevision: 'c'.repeat(40) },
    { ...approved, locationAdditions: [{ ...ctx.additions[0], daily: false }] },
    { ...approved, checkedSha256: 'd'.repeat(64) } ]) {
    await assert.rejects(processBaseline({ ...ctx, input: changed, publish: true, actor: 'director@example.com' }), error => error.status === 409);
  }
  await assert.rejects(processBaseline({ ...ctx, input: approved, publish: true, actor: 'director@example.com',
    search: async () => { throw new Error('Lookup down'); } }));
  assert.equal(ctx.writes.length, 0);
});

test('malformed, partial and mismatched location assignments never reach publication', async () => {
  const ctx = await setup();
  for (const additions of [[null], [{}], [{ ...ctx.additions[0], placeId: 42 }],
    [{ ...ctx.additions[0], markupSourceZone: 'MISSING' }], [{ ...ctx.additions[0], zone: 'WALO' }]]) {
    await assert.rejects(processBaseline({ ...ctx, input: { ...ctx.input, locationAdditions: additions }, actor: 'director@example.com' }),
      error => error.status === 422);
  }
  assert.equal(ctx.writes.length, 0);
});

test('main conflict keeps the previous configuration and does not cache an unpublished baseline', async () => {
  const ctx = await setup();
  const input = { ...ctx.input, locationAdditions: ctx.additions };
  const check = await processBaseline({ ...ctx, input });
  const original = JSON.stringify(ctx.snapshot);
  ctx.repository.publishBaseline = async () => { const error = new Error('Conflict'); error.status = 409; throw error; };
  await assert.rejects(processBaseline({ ...ctx, publish: true, input: { ...input,
    sourceRevision: check.sourceRevision, previousSha256: check.previousSha256,
    checkedSha256: check.summary.sha256, checkedOnboardingHash: check.onboardingHash } }), error => error.status === 409);
  assert.equal(JSON.stringify(ctx.snapshot), original);
  assert.equal(await ctx.storage.get(`baseline-coverage:${check.summary.sha256}`), undefined);
});

test('provider identity changes invalidate the verified configuration before publication', async () => {
  const ctx = await setup();
  const input = { ...ctx.input, locationAdditions: ctx.additions };
  const check = await processBaseline({ ...ctx, input });
  const approved = { ...input, sourceRevision: check.sourceRevision, previousSha256: check.previousSha256,
    checkedSha256: check.summary.sha256, checkedOnboardingHash: check.onboardingHash };
  for (const patch of [{ label: 'Different Airport' }, { city: 'Different City' }, { kind: 'city' }]) {
    const search = async () => [{ ...((await ctx.search())[0]), ...patch }];
    await assert.rejects(processBaseline({ ...ctx, input: approved, publish: true, search }), error => error.status === 409);
  }
  assert.equal(ctx.writes.length, 0);
});

test('a manually checked non-daily point works when the registry has no daily profile', async () => {
  const ctx = await setup();
  delete ctx.snapshot.documents.locations.profiles;
  const result = await processBaseline({ ...ctx, input: { ...ctx.input,
    locationAdditions: [{ ...ctx.additions[0], daily: false }] } });
  assert.equal(result.onboarding.ready, true);
  assert.equal(result.onboarding.addedLocations[0].daily, false);
  assert.equal(ctx.writes.length, 0);
});
