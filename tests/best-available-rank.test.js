const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPricingRecommendations } = require('../src/pricingRecommendations');
const { pricing } = require('../pricing-rules.config.example.json');
const excel = require('../excel-rate-update.config.example.json');
const registry = require('../locations.config.json');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function decision(rates, { zone = 'GDLO', days = 3, date = '2026-11-02', mm = 150, markup, policy = pricing } = {}) {
  const location = registry.locations.find(point => point.zones.includes(zone)).scraper_label;
  const offer = (provider_name, rate) => ({ provider_name, total_price: rate * days, rental_days: days, currency: 'PLN' });
  const view = { top_3: rates.map((rate, i) => offer(`Competitor ${i}`, rate)), mm_cars_rental: mm == null ? null : offer('MM Cars Rental', mm) };
  return buildPricingRecommendations({ locations: [location], scenarios: [{ start_date: date, rental_days: days,
    top_3_plus_mm_by_location: { [location]: view }, offer_views_by_location: { [location]: { automatic: view } } }] },
  { ...policy, recommendedFallbackToMinimum: false, excelPolicy: excel, locationRegistry: registry, brokerMarkupCalibration: markup || { enabled: false } }).decisions[0];
}

test('legacy best-rank policy chooses the best feasible rank without a 10 PLN limit', () => {
  for (const date of ['2026-11-02', '2027-06-01', '2028-02-01']) {
    for (const days of [2, 3, 4, 5, 7, 8, 14]) {
      for (const [rates, rank] of [[[60, 80, 100], 1], [[20, 60, 100], 2], [[20, 25, 60], 3]]) {
        const result = decision(rates, { days, date });
        assert.equal(result.target_rank, rank);
        assert.equal(result.suggested_rate_pln_day, 59);
      }
    }
  }
});

test('current floors remain binding for cities and special airports', () => {
  assert.equal(decision([50, 85, 100], { zone: 'GD1' }).target_rank, 2);
  assert.equal(decision([50, 85, 100], { zone: 'KALO' }).target_rank, 2);
  assert.equal(decision([100, 140, 180], { zone: 'SZLO' }).target_rank, 2);
  assert.equal(decision([10, 20, 30]).action, 'hold');
  assert.equal(decision([60, 80, 100], { mm: null }).action, 'hold');
  assert.equal(decision([60, 80, 100], { days: 21 }).action, 'hold');
});

test('rank feasibility includes the fixed broker amount and the existing premium reserve', () => {
  const markup = require('../input/broker-markup-frozen.json').brokerMarkupCalibration;
  const { resolveBrokerMarkupCalibration } = require('../src/brokerMarkupCalibration');
  const amount = resolveBrokerMarkupCalibration({ location: 'Gdansk Airport (GDN)', rental_days: 3, group: 'CDMV' }, markup).amountPlnDay;
  const policy = structuredClone(pricing);
  policy.locationTypeFloorsPlnDay.minimumRatesByKind.airport = 30;
  const top1 = decision([amount + 32, amount + 85, amount + 105], { markup, policy });
  assert.equal(top1.target_rank, 1);
  assert.equal(top1.suggested_rate_pln_day, 31);
  const top2 = decision([amount + 31, amount + 85, amount + 105], { markup, policy });
  assert.equal(top2.target_rank, 2);
  assert.equal(top2.suggested_rate_pln_day, 84);
});

test('expired Top1 and obsolete seasonal minima are absent from production policy', () => {
  assert.deepEqual(pricing.priorityTop1Rules, []);
  assert.deepEqual(excel.minimum_rates.bands, []);
  assert.deepEqual(excel.protected_rate_periods, [{ start_date: '2026-12-15', end_date: '2027-01-02' }]);
});

test('real Excel exports preserve exclusions, protected dates and premium parity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'best-rank-'));
  try {
    const recommendations = [];
    for (const date of ['2026-11-03', '2026-12-15']) {
      for (let days = 2; days <= 14; days++) {
        const rates = days === 3 ? [85, 100, 120] : days === 4 ? [20, 25, 85] : [60, 90, 120];
        recommendations.push(decision(rates, { date, days }));
      }
    }
    fs.writeFileSync(path.join(directory, 'recommendations.json'), JSON.stringify({ recommendations }));
    const script = `import sys,json
from pathlib import Path
from datetime import date
import openpyxl
from tools import update_excel_rates as e
p=Path(sys.argv[1]);root=Path.cwd()
config=json.loads((root/'excel-rate-update.config.example.json').read_text())
legacy_rules=json.loads((root/'pricing-rules.config.example.json').read_text())
legacy_rules['pricing']['recommendedFallbackToMinimum']=False
(p/'legacy-pricing.json').write_text(json.dumps(legacy_rules))
config.update(baseline_manifest_file='',location_registry_file=str(root/'locations.config.json'),pricing_rules_file=str(p/'legacy-pricing.json'))
(p/'config.json').write_text(json.dumps(config));c=e.load_config(p/'config.json')
w=openpyxl.Workbook();s=w.active;s.title='Sheet1'
s.append(['Rental rates for packages: INCLUSIVE POA'])
s.append(['Min days']+[None]*7+[1,2,3,5,8,21]);s.append(['Max days']+[None]*7+[1,2,4,7,20,35])
s.append(['Group','Description','Rate code','Zone','Booking start date','Booking end date','Pickup start date','Pickup end date']+['Per day']*6)
for day in [date(2026,11,3),date(2026,12,15)]:
 for group in ['CDMV','EDAV','CFAV']:
  s.append([group,None,None,'GDLO',date(2026,1,1),date(2027,12,31),day,day]+[80]*6)
w.save(p/'base.xlsx')
summary=e.apply_updates(p/'base.xlsx',p/'recommendations.json',p/'report.xlsx',c,None,False,import_output_path=p/'import.xlsx')
assert summary['change_count']>0,summary
assert not [v for v in summary['validation'] if v['status']=='FAIL'],summary['validation']
assert all(v['target_rank']==3 and v['recommendation_type']=='priority_top3' for v in summary['changes'] if v['duration_band']=='3-4'),summary['changes']
for name in ['report.xlsx','import.xlsx']:
 book=openpyxl.load_workbook(p/name);sheet=book['Sheet1']
 for row in sheet.iter_rows(min_row=5,values_only=True):
  expected=80 if row[0]=='CFAV' or e.parse_date_value(row[6])==date(2026,12,15) else 59 if row[0]=='EDAV' else 58
  amounts=[expected]*4
  if expected!=80: amounts[1]=84 if row[0]=='EDAV' else 83
  assert list(row[9:13])==amounts,(name,row)
  assert row[8]==80 and row[13]==80,(name,row)
 book.close()
print('Excel parity, exclusions, protected dates and 8-20 evidence passed.')`;
    const result = spawnSync(process.env.PYTHON || 'python', ['-B', '-c', script, directory], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  } finally {
    assert.ok(directory.startsWith(path.join(os.tmpdir(), 'best-rank-')));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
