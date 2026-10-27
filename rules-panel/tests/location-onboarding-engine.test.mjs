import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { prepareLocationAdditions } from '../server/location-onboarding.mjs';

const require = createRequire(import.meta.url);
const { getDailyLocations, buildPinnedLocationIds } = require('../../src/locationRegistry.js');
const { buildPricingRecommendations } = require('../../src/pricingRecommendations.js');
const { resolveBrokerMarkupCalibration } = require('../../src/brokerMarkupCalibration.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = async path => JSON.parse(await readFile(join(root, path), 'utf8'));

test('onboarded points work in the real scraper registry, pricing engine and both Python Excel exports', async () => {
  const documents = { pricing: await read('pricing-rules.config.example.json'), excel: await read('excel-rate-update.config.example.json'),
    locations: await read('locations.config.json') };
  const frozen = await read('input/broker-markup-frozen.json');
  const points = [
    { zone: 'RZLO', placeId: 6144, query: 'Rzeszow', markupSourceZone: 'WALO', daily: true },
    { zone: 'RZ1', placeId: 355145, query: 'Rzeszow', markupSourceZone: 'WA1', daily: true },
  ];
  const plan = prepareLocationAdditions({ documents, frozen, additions: points, unknownZones: ['RZLO','RZ1'], candidates: {
    RZLO: { placeId: 6144, label: 'Rzeszow Airport (RZE)', city: 'Rzesz\u00f3w', kind: 'airport' },
    RZ1: { placeId: 355145, label: 'Rzeszow Train Station', city: 'Rzeszow', kind: 'city' },
  } });
  const registry = plan.documents.locations;
  assert.ok(getDailyLocations(registry).includes('Rzeszow Train Station'));
  assert.equal(buildPinnedLocationIds(registry)['Rzeszow Airport (RZE)'], 6144);
  const newPoints = registry.locations.filter(location => location.zones.some(zone => ['RZLO','RZ1'].includes(zone)));
  assert.equal(newPoints.length, 2);
  for (const point of newPoints) {
    const offer = (provider_name, rate) => ({ provider_name, total_price: rate * 3, rental_days: 3, currency: 'PLN' });
    const view = { top_3: [offer('Competitor A',300), offer('Competitor B',400), offer('Competitor C',500)], mm_cars_rental: offer('MM Cars Rental',200) };
    const result = buildPricingRecommendations({ locations: [point.scraper_label], scenarios: [{
      group: 'CDMV', start_date: '2026-11-03', rental_days: 3,
      top_3_plus_mm_by_location: { [point.scraper_label]: view }, offer_views_by_location: { [point.scraper_label]: { automatic: view } },
    }] }, { ...documents.pricing.pricing, excelPolicy: documents.excel, locationRegistry: registry,
      brokerMarkupCalibration: plan.frozen.brokerMarkupCalibration, forceTop1: true }).decisions[0];
    assert.equal(result.target_rank, 1);
    assert.equal(result.mandatory_minimum_rate_pln_day, documents.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind[point.kind]);
    for (let day = 1; day <= 35; day++) {
      const resolve = location => resolveBrokerMarkupCalibration({ location, rental_days: day, group: 'CDMV' }, plan.frozen.brokerMarkupCalibration);
      const donor = points.find(item => item.zone === point.zones[0]).markupSourceZone;
      assert.equal(resolve(point.scraper_label).amountPlnDay, resolve(donor).amountPlnDay);
      assert.equal(resolve(point.zones[0]).amountPlnDay, resolve(donor).amountPlnDay);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'location-engine-'));
  try {
    await writeFile(join(directory, 'locations.json'), JSON.stringify(registry));
    await writeFile(join(directory, 'excel.json'), JSON.stringify({ ...documents.excel, baseline_manifest_file: '',
      location_registry_file: join(directory, 'locations.json'), pricing_rules_file: join(root, 'pricing-rules.config.example.json') }));
    const script = `import json,sys
from pathlib import Path
from datetime import date
import openpyxl
from tools import update_excel_rates as e
p=Path(sys.argv[1]);c=e.load_config(p/'excel.json')
assert c['zone_location_kinds']['RZLO']=='airport' and c['zone_location_kinds']['RZ1']=='city'
assert c['city_zone_airport_zones']['RZ1']==['RZLO']
assert 'Rzeszow Train Station' in c['daily_locations']
w=openpyxl.Workbook();s=w.active;s.title='Sheet1'
s.append(['Rental rates for packages: INCLUSIVE POA'])
s.append(['Min days']+[None]*7+[1,2,3,5,8,21]);s.append(['Max days']+[None]*7+[1,2,4,7,20,35])
s.append(['Group','Description','Rate code','Zone','Booking start date','Booking end date','Pickup start date','Pickup end date']+['Per day']*6)
recommendations=[]
for zone,label in [('RZLO','Rzeszow Airport (RZE)'),('RZ1','Rzeszow Train Station')]:
 for day in [date(2026,10,31),date(2026,11,3)]:
  s.append(['CDMV',None,None,zone,date(2026,1,1),date(2027,12,31),day,day]+[500]*6)
  recommendations.append(dict(action='decrease',recommendation_type='top1_undercut',location=label,start_date=day.isoformat(),rental_days=2,suggested_rate_pln_day=80,benchmark_rate_pln_day=81))
w.save(p/'source.xlsx');original=(p/'source.xlsx').read_bytes()
(p/'recommendations.json').write_text(json.dumps(dict(recommendations=recommendations)))
summary=e.apply_updates(p/'source.xlsx',p/'recommendations.json',p/'report.xlsx',c,None,False,import_output_path=p/'import.xlsx')
assert summary['change_count']>0 and summary['skipped_target_count']==2
assert not [row for row in summary['validation'] if row['status']=='FAIL'],summary['validation']
for name in ['report.xlsx','import.xlsx']:
 book=openpyxl.load_workbook(p/name);sheet=book['Sheet1']
 assert sheet.max_row==8
 for row in sheet.iter_rows(min_row=5,values_only=True):
  assert row[9]==(500 if e.parse_date_value(row[6])==date(2026,10,31) else 80),row
  assert tuple(row[8:9]+row[10:14])==(500,)*5,row
 book.close()
assert (p/'source.xlsx').read_bytes()==original
print('New points: daily search, city/airport relation, protected dates and both Excel exports passed.')`;
    const result = spawnSync(process.env.PYTHON ?? 'python', ['-B','-c',script,directory], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'location-engine-')), 'cleanup stays within the owned temporary test directory');
    await rm(directory, { recursive: true, force: true });
  }
});
