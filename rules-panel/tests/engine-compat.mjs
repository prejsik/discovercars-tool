import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createModel, previewPolicy } from '../src/policy.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const read = name => JSON.parse(readFileSync(new URL(`../../${name}`,import.meta.url),'utf8'));
const model = createModel({pricing:read('pricing-rules.config.example.json'),excel:read('excel-rate-update.config.example.json'),locations:read('locations.config.json')});
const cases=[];
for(const zone of ['WA1','KRLO','SZLO'])
  for(const group of ['CDMV','EDAV','CFAV','PDAH','FVMD'])
    for(const duration of [1,2,3,4,5,7,8,20,21,35])
      for(const pickupDate of ['2026-07-15','2026-10-29','2026-10-30','2026-10-31','2026-11-01','2026-12-15','2027-01-05','2027-01-10','2027-01-11'])
        cases.push({zone,group,duration,pickupDate,baselineRate:20});
const script = `import sys,json
from pathlib import Path
from tools import update_excel_rates as e
c=e.load_config(Path('excel-rate-update.config.example.json'))
c['_mandatory_zone_floors']=e.get_mandatory_zone_floors(c)
c['_mandatory_group_floors']=e.get_mandatory_group_floors(c)
c['_location_type_floors']=e.get_location_type_floors(c)
c['_location_type_allowed_groups']=e.resolve_apply_groups(c,None)
bands=[(1,1),(2,2),(3,4),(5,7),(8,20),(21,35)]
omitted=e.get_omitted_group_zones(c)
out=[]
for x in json.load(sys.stdin):
 low,high=next(b for b in bands if b[0]<=x['duration']<=b[1])
 if (x['group'],x['zone']) in omitted: out.append([None,None]); continue
 args=(x['zone'],x['group'],low,high,c,x['pickupDate'])
 out.append([e.get_mandatory_floor(*args)[0],e.get_mandatory_correction_floor(*args)[0]])
print(json.dumps(out))`;
const python=spawnSync(process.env.PYTHON??'python',['-B','-c',script],{cwd:root,encoding:'utf8',input:JSON.stringify(cases),maxBuffer:4e6,timeout:120000,windowsHide:true});
assert.equal(python.status,0,python.error?.message??python.stderr);
const expected=JSON.parse(python.stdout);
assert.equal(expected.length,cases.length);
cases.forEach((input,index)=>{
  const result=previewPolicy(model,input);
  assert.equal(result.floor,expected[index][0],JSON.stringify(input));
  assert.equal(result.correctionFloor,expected[index][1],JSON.stringify(input));
});
console.log(`PASS ${cases.length} actual Python mandatory-floor and correction comparisons (not a full recommendation simulation).`);
