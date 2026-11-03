import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../server/snapshot.mjs';
import { createModel,updateRule,removeRule } from '../src/policy.mjs';
import * as review from '../src/change-review.mjs';
const source=createModel((await readSnapshot()).documents);
test('large-change boundary is symmetric, inclusive and rejects invalid input',()=>{
  assert.equal(typeof review.amountChange,'function');
  assert.equal(review.amountChange(30,90).large,true);
  assert.equal(review.amountChange(90,30).large,true);
  assert.equal(review.amountChange(30,89.99).large,false);
  assert.equal(review.amountChange(30,4999).delta,4969);
  assert.equal(review.amountChange(0,20),null);
  assert.equal(review.amountChange(30,''),null);
});
test('confirmation is bound to the rule and exact before/after amounts',()=>{
  assert.equal(typeof review.requiredConfirmations,'function');
  const model=updateRule(source,'location:airport',{amount:4999});
  const changes=review.requiredConfirmations(model,source);assert.equal(changes.length,1);
  assert.throws(()=>review.confirmedChanges(changes,[]),/Potwierdź/);
  assert.throws(()=>review.confirmedChanges(changes,[{...changes[0],after:4998}]),/Potwierdź/);
  assert.deepEqual(review.confirmedChanges(changes,changes),changes);
  assert.deepEqual(review.requiredConfirmations(source,source),[]);
});

test('deleting a rule does not turn shifted unchanged array entries into large price changes',()=>{
  const model=structuredClone(source);
  const row={groups:['CDMV'],zones:['KRLO'],startDate:'2026-11-01',endDate:'2027-01-01',overrideProtected:false};
  model.pricing.pricing.mandatoryScopedFloorsPlnDay=[{...row,minDays:1,maxDays:1,minimumRatePlnDay:300},{...row,minDays:2,maxDays:2,minimumRatePlnDay:50}];
  const next=removeRule(model,'scoped:0');
  assert.deepEqual(review.requiredConfirmations(next,model),[]);
  assert.equal(typeof review.ruleDifferences,'function');
  const changes=review.ruleDifferences(next,model);
  assert.equal(changes.length,1);assert.equal(changes[0].before.amount,300);assert.equal(changes[0].after,undefined);
});
