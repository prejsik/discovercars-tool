import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../src/market-review.mjs';
test('dashboard and worklist share an exact 14-day current window, not old report fallback',()=>{
  assert.equal(typeof review.overviewRows,'function');
  const data={rows:[
    {date:'2026-11-03',duration:2,transmission:'all'},
    {date:'2026-11-16',duration:14,transmission:'all'},
    {date:'2026-11-17',duration:3,transmission:'all'},
    {date:'2026-11-04',duration:3,transmission:'automatic'},
    {date:'2026-11-04',duration:21,transmission:'all'},
    {date:'2026-11-02',duration:3,transmission:'all'},
  ]};
  assert.equal(review.overviewRows(data,'2026-11-03').length,2);
  assert.equal(review.overviewRows(data,'2026-12-01').length,0);
});
