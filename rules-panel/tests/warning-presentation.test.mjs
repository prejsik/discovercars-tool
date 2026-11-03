import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../server/snapshot.mjs';
import { createModel,validateModel } from '../src/policy.mjs';
import * as display from '../src/warning-presentation.mjs';
const source=createModel((await readSnapshot()).documents);
test('presentation removes duplicate warnings and omitted group-zone overlaps without altering validation',()=>{
  assert.equal(typeof display.presentWarnings,'function');
  const model=structuredClone(source);const p=model.pricing.pricing;
  p.mandatoryGroupFloorsPlnDay={FVMD:[{minDays:1,maxDays:35,minimumRatePlnDay:500}],PDAH:[{minDays:21,maxDays:35,minimumRatePlnDay:170}]};
  p.mandatoryZoneFloorsPlnDay={SZLO:[{minDays:1,maxDays:20,minimumRatePlnDay:150},{minDays:21,maxDays:35,minimumRatePlnDay:90}]};
  p.mandatoryScopedFloorsPlnDay=[];
  const validation=validateModel(model,model);const copy=structuredClone(validation);
  const warnings=display.presentWarnings(model,validation.warnings);
  assert.equal(warnings.filter(w=>w.message.includes('PDAH')&&w.message.includes('SZLO')).length,1);
  assert.equal(warnings.some(w=>w.message.includes('FVMD')&&w.message.includes('SZLO')),false);
  assert.deepEqual(validation,copy);
});
test('unchanged source overlaps are known rather than new warnings',()=>{
  assert.equal(typeof display.warningChanges,'function');
  const result=display.warningChanges(source,source);
  assert.equal(result.added.length,0);assert.ok(result.known.length>0);
  assert.equal(new Set(result.known.map(w=>w.key)).size,result.known.length);
});
