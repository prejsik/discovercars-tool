import test from 'node:test';
import assert from 'node:assert/strict';
import { tickSchedule } from '../worker/scheduler.mjs';
import { GitHubRepository } from '../worker/github.mjs';

function setup() {
  const values = new Map();
  const calls = [];
  const fixture = { runs: [], artifacts: [], jobs: [], failPost: false, failRead: false };
  const storage = { get: async key => structuredClone(values.get(key)), put: async (key, value) => values.set(key, structuredClone(value)) };
  const repository = { api: async (path, options = {}) => {
    calls.push({ path, ...options });
    if (options.method === 'POST') {
      if (fixture.failPost) throw new Error('Connection lost after sending request');
      return null;
    }
    if (fixture.failRead) throw new Error('GitHub unavailable');
    if (path.includes('/artifacts')) return { artifacts: fixture.artifacts };
    if (path.includes('/jobs')) return { jobs: fixture.jobs };
    return { workflow_runs: fixture.runs };
  } };
  return { values, calls, fixture, storage, repository, tick: now => tickSchedule({ now, repository, storage }) };
}
const day = '2026-10-21T07:37:00Z';
const external = { id: 123, head_branch: 'main', event: 'workflow_dispatch', display_title: 'DiscoverCars day 2026-10-21', created_at: day, status: 'queued' };
const posts = calls => calls.filter(call => call.method === 'POST');

test('dispatches the correct main workflow at both Warsaw times, including winter', async () => {
  for (const [now, slot, reportDate] of [
    [day, 'day', '2026-10-21'], ['2026-10-21T16:07:00Z', 'night', '2026-10-22'],
    ['2026-10-25T08:37:00Z', 'day', '2026-10-25'], ['2026-10-25T17:07:00Z', 'night', '2026-10-26'],
  ]) {
    const f = setup();
    assert.equal((await f.tick(now)).action, 'dispatched');
    assert.deepEqual(posts(f.calls).map(call => ({path: call.path, body: call.body})), [{
      path: '/actions/workflows/discovercars-daily.yml/dispatches',
      body: { ref: 'main', inputs: { schedule_slot: slot, report_date: reportDate } },
    }]);
  }
});

test('outside the dispatch window performs no GitHub reads or writes', async () => {
  const f = setup();
  for (const now of ['2026-10-21T07:36:59Z', '2026-10-21T08:08:00Z', '2026-10-21T16:06:59Z', '2026-10-21T17:00:00Z']) {
    assert.equal((await f.tick(now)).action, 'outside-window');
  }
  assert.equal(f.calls.length, 0);
});

test('does not duplicate queued external or GitHub-cron runs', async () => {
  for (const run of [external, { ...external, event: 'schedule', display_title: 'DiscoverCars 42 7 * * *', created_at: '2026-10-21T07:42:00Z' }]) {
    const f = setup(); f.fixture.runs = [run];
    assert.equal((await f.tick('2026-10-21T07:43:00Z')).action, 'monitor');
    assert.equal(posts(f.calls).length, 0);
  }
});

test('only actual scraper steps confirm start, not an active gate or skipped collection', async () => {
  const f = setup(); f.fixture.runs = [{ ...external, status: 'in_progress' }];
  f.fixture.jobs = [{ steps: [{ name: 'Run scraper', status: 'completed', conclusion: 'skipped' }] }];
  assert.equal((await f.tick('2026-10-21T07:40:00Z')).action, 'monitor');
  f.fixture.jobs = [{ steps: [{ name: 'Run scraper', status: 'in_progress', conclusion: null }] }];
  assert.equal((await f.tick('2026-10-21T07:41:00Z')).action, 'started');
  f.fixture.failRead = true;
  assert.equal((await f.tick('2026-10-21T07:42:00Z')).action, 'started');
  assert.equal(posts(f.calls).length, 0);
});

test('publication evidence prevents a repeat even when the workflow conclusion is failure', async () => {
  const f = setup(); f.fixture.runs = [{ ...external, status: 'completed', conclusion: 'failure' }];
  f.fixture.artifacts = [{ name: 'discovercars-schedule-published-day-2026-10-21' }];
  assert.equal((await f.tick(day)).action, 'done');
  assert.equal(posts(f.calls).length, 0);
});

test('day publication does not block the next morning report', async () => {
  const f = setup(); f.fixture.runs = [{ ...external, status: 'completed', conclusion: 'success' }];
  f.fixture.artifacts = [{ name: 'discovercars-schedule-published-day-2026-10-21' }];
  assert.equal((await f.tick('2026-10-21T16:07:00Z')).action, 'dispatched');
  assert.equal(posts(f.calls)[0].body.inputs.schedule_slot, 'night');
});

test('an ambiguous POST is never retried without a visible completed attempt', async () => {
  const f = setup(); f.fixture.failPost = true;
  assert.equal((await f.tick(day)).action, 'unconfirmed');
  assert.equal((await f.tick('2026-10-21T07:42:00Z')).action, 'unconfirmed');
  assert.equal(posts(f.calls).length, 1);
});

test('successful POST is persisted before subsequent ticks and survives a new scheduler invocation', async () => {
  const f = setup();
  assert.equal((await f.tick(day)).action, 'dispatched');
  assert.equal((await tickSchedule({now:'2026-10-21T07:38:00Z',repository:f.repository,storage:f.storage})).action, 'unconfirmed');
  assert.equal(posts(f.calls).length, 1);
});

test('GitHub read failure fails closed instead of dispatching blindly', async () => {
  const f = setup(); f.fixture.failRead = true;
  await assert.rejects(f.tick(day), /GitHub unavailable/);
  assert.equal(posts(f.calls).length, 0);
});

test('a pending run older than fifteen minutes is reported as delayed without another dispatch', async () => {
  const f = setup(); f.fixture.runs = [external];
  const result = await f.tick('2026-10-21T07:53:00Z');
  assert.equal(result.action, 'monitor');
  assert.equal(result.delayed, true);
  assert.equal(posts(f.calls).length, 0);
});

test('completed failures allow only three attempts and never an immediate retry', async () => {
  const f = setup();
  await f.tick(day);
  f.fixture.runs = [{...external,status:'completed',conclusion:'failure'}];
  assert.equal((await f.tick('2026-10-21T07:38:00Z')).action, 'cooldown');
  assert.equal((await f.tick('2026-10-21T07:42:00Z')).action, 'dispatched');
  f.fixture.runs.unshift({...external,id:124,created_at:'2026-10-21T07:42:00Z',status:'completed',conclusion:'failure'});
  assert.equal((await f.tick('2026-10-21T07:47:00Z')).action, 'dispatched');
  f.fixture.runs.unshift({...external,id:125,created_at:'2026-10-21T07:47:00Z',status:'completed',conclusion:'failure'});
  assert.equal((await f.tick('2026-10-21T07:52:00Z')).action, 'exhausted');
  assert.equal(posts(f.calls).length, 3);
});

test('another day, manual run or branch never counts as this scheduled attempt', async () => {
  const f = setup(); f.fixture.runs = [
    {...external,head_branch:'other'}, {...external,display_title:'DiscoverCars workflow_dispatch'},
    {...external,display_title:'DiscoverCars day 2026-10-20'},
  ];
  assert.equal((await f.tick(day)).action, 'dispatched');
});

test('the real GitHub adapter sends exactly the daily workflow dispatch without changing contents or permissions', async () => {
  const f = setup(); const writes = [];
  const repository = new GitHubRepository({}, {fetcher: async (url, options) => {
    if (options.method === 'POST') {
      writes.push({url,body:JSON.parse(options.body)});
      return new Response(null, {status:204});
    }
    return Response.json({workflow_runs:[]});
  }});
  repository.token = async () => 'test-installation-token';
  assert.equal((await tickSchedule({now:day,repository,storage:f.storage})).action, 'dispatched');
  assert.deepEqual(writes,[{url:'https://api.github.com/repos/prejsik/discovercars-tool/actions/workflows/discovercars-daily.yml/dispatches',
    body:{ref:'main',inputs:{schedule_slot:'day',report_date:'2026-10-21'}}}]);
});

test('missing or incomplete API pages never permit a dispatch', async () => {
  for (const reply of [{}, {workflow_runs:Array.from({length:100},(_,id)=>({...external,id}))}]) {
    const f = setup(); const calls = [];
    const repository = {api:async (path,options={})=>{calls.push({path,...options});return reply;}};
    await assert.rejects(tickSchedule({now:day,repository,storage:f.storage}), /Incomplete GitHub/);
    assert.equal(posts(calls).length,0);
  }
});
