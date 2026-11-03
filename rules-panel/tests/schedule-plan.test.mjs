import test from 'node:test';
import assert from 'node:assert/strict';
import { readSchedulePlan } from '../server/schedule-plan.mjs';
test('read-only display follows the existing scheduler in winter and summer', () => {
  const expected=[{slot:'day',time:'09:37',rollingDays:20},{slot:'night',time:'18:07',rollingDays:45}];
  assert.deepEqual(readSchedulePlan('2026-01-05'),expected);
  assert.deepEqual(readSchedulePlan('2026-07-05'),expected);
});
