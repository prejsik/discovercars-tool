import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot } from '../server/snapshot.mjs';
import { createModel,updateRule } from '../src/policy.mjs';
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
