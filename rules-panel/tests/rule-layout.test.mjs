import test from 'node:test';
import assert from 'node:assert/strict';
import * as editor from '../src/editor.mjs';

const rule = (id, patch = {}) => ({ id, title: 'SZLO: minimum', category: 'mandatory', groups: ['*'], zones: ['SZLO'], minDays: 1, maxDays: 1, amount: 300, editable: true, ...patch });

test('duration summaries preserve every rule and only join identical business scopes', () => {
  assert.equal(typeof editor.groupRuleBands, 'function');
  const rules = [rule('a'), rule('b', { minDays: 2, maxDays: 2, amount: 150 }), rule('c', { zones: ['WR1'] }), rule('d', { overrideProtected: true }), rule('e', { startDate: '2026-12-15' }), rule('f', { groups: ['PDAH'] })];
  const groups = editor.groupRuleBands(rules);
  assert.deepEqual(groups.map(group => group.map(item => item.id)), [['a', 'b'], ['c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(groups.flat(), rules);
});

test('Top 1 bands can share a summary but dates, classes, and permissions stay separate', () => {
  assert.equal(typeof editor.groupRuleBands, 'function');
  const rules = [rule('a', { category: 'priority', title: 'Top 1: 2 days' }), rule('b', { category: 'priority', title: 'Top 1: 3-4 days' }), rule('c', { category: 'priority', editable: false }), rule('d', { title: 'Different mandatory rule' })];
  assert.deepEqual(editor.groupRuleBands(rules).map(group => group.map(item => item.id)), [['a', 'b'], ['c'], ['d']]);
});
