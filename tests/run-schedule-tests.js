const assert = require('node:assert/strict');
const { resolveSchedule, findDuplicate, markerName, runGate, warsawParts } = require('../src/discovercarsSchedule');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');

async function main() {
  const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/discovercars-daily.yml'),'utf8');
  assert.match(workflow,/concurrency:\s+group: discovercars-pages-site\s+cancel-in-progress: false\s+queue: max/,'Fallback triggers must not cancel a pending scheduled run');
  const night = resolveSchedule({ event: 'schedule', cron: '17 20 * * *', createdAt: '2026-09-29T00:23:53Z', now: '2026-09-29T00:32:07Z' });
  assert.equal(night.key, 'night-2026-09-29');
  assert.equal(night.rollingDays, 45);
  for (const cron of ['17 20 * * *', '47 20 * * *', '17 21 * * *']) {
    const scheduledNight = resolveSchedule({ event: 'schedule', cron, createdAt: '2026-10-01T21:30:00Z', now: '2026-10-01T21:31:00Z' });
    assert.equal(scheduledNight.rollingDays, 45);
    assert.equal(scheduledNight.key, 'night-2026-10-02');
  }
  // The incident: a skipped daytime success, then two skipped nighttime successes.
  const skipped = [36458632252,36502893905,36503726433].map(id => ({id, status:'completed', conclusion:'success'}));
  assert.equal(await findDuplicate(night, skipped, async () => []), null);
  const completed = [{id:1,status:'completed',conclusion:'success'}];
  assert.equal(await findDuplicate(night, completed, async () => [{name:markerName('published','day-2026-09-29')}]), null);
  assert.equal(await findDuplicate(night, completed, async () => [{name:markerName('claim',night.key)}]), null);
  assert.equal((await findDuplicate(night, completed, async () => [{name:markerName('published',night.key)}])).id, 1);
  assert.equal(await findDuplicate(night, completed, async () => [{name:markerName('published',night.key),expired:true}]), null);
  assert.equal((await findDuplicate(night, [{...completed[0],conclusion:'failure'}], async () => [{name:markerName('published',night.key)}])).id, 1);
  assert.equal((await findDuplicate(night, [{...completed[0],conclusion:'cancelled'}], async () => [{name:markerName('published',night.key)}])).id, 1);
  assert.equal(await findDuplicate(night, [{...completed[0],conclusion:'failure'}], async () => [{name:markerName('claim',night.key)}]), null);
  assert.equal(await findDuplicate(night, [{...completed[0],conclusion:'failure'}], async () => [{name:markerName('published',night.key),expired:true}]), null);
  assert.equal((await findDuplicate(night, [{id:2,status:'in_progress'}], async () => [{name:markerName('claim',night.key)}])).id, 2);
  assert.equal(await findDuplicate(night, [{id:2,status:'queued'}], async () => [{name:markerName('claim',night.key)}]), null);
  for (const day of ['2026-09-29','2026-10-25','2026-12-15','2027-03-28']) {
    const slots = ['7 7 * * *','7 8 * * *'].map(cron => resolveSchedule({event:'schedule',cron,createdAt:day+'T12:00:00Z',now:day+'T12:00:00Z'}));
    assert.equal(slots.filter(s=>s.shouldRun).length,1,day);
    const enabled = slots.find(s=>s.shouldRun);
    assert.equal(enabled.key,`day-${day}`);
    assert.equal(enabled.rollingDays,30);
  }
  const delayed = resolveSchedule({event:'schedule',cron:'7 7 * * *',createdAt:'2026-09-29T16:08:34Z',now:'2026-09-29T16:10:00Z'});
  assert.equal(delayed.key,'day-2026-09-29');
  assert.equal(resolveSchedule({event:'schedule',cron:'7 7 * * *',createdAt:'2026-09-29T07:08:00Z',now:'2026-09-30T01:00:00Z'}).shouldRun,false);
  const external = resolveSchedule({event:'workflow_dispatch',slot:'day',reportDate:'2026-09-29',createdAt:'2026-09-29T07:00:00Z',now:'2026-09-29T07:00:00Z'});
  assert.equal(external.key,'day-2026-09-29');
  assert.equal(external.rollingDays,30);
  assert.equal(resolveSchedule({event:'workflow_dispatch',slot:'night',reportDate:'2026-09-30',now:'2026-09-29T20:00:00Z'}).rollingDays,45);
  assert.throws(()=>resolveSchedule({event:'workflow_dispatch',slot:'day',reportDate:'bad',now:'2026-09-29T07:00:00Z'}));
  assert.equal(resolveSchedule({event:'workflow_dispatch',slot:'day',reportDate:'2026-09-28',now:'2026-09-29T07:00:00Z'}).shouldRun,false);
  assert.equal(resolveSchedule({event:'workflow_dispatch',now:'2026-09-29T07:00:00Z'}).runType,'manual');
  assert.equal(resolveSchedule({event:'push',now:'2026-09-29T07:00:00Z'}).runType,'push-smoke');
  await assert.rejects(findDuplicate(night, completed, async()=>{throw new Error('API unavailable');}), /API unavailable/);
  // Exercise the actual gate adapter, API pagination, artifact matching and GITHUB_OUTPUT.
  const date=warsawParts(new Date()).date;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'discovercars-schedule-'));
  const eventPath=path.join(root,'event.json');
  const outputPath=path.join(root,'outputs');
  fs.writeFileSync(eventPath,JSON.stringify({inputs:{schedule_slot:'day',report_date:date}}));
  let apiFailure=false;
  const originalCreatedAt = new Date(Date.now() - 3600000).toISOString();
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(apiFailure){res.writeHead(403);res.end('{}');return;}
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.endsWith('/runs/99')) return res.end(JSON.stringify({created_at:originalCreatedAt}));
    if(url.pathname.endsWith('/artifacts')) return res.end(JSON.stringify({artifacts:[{name:markerName('published',`day-${date}`)}]}));
    return res.end(JSON.stringify({workflow_runs:[{id:98,status:'completed',conclusion:'success'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const env={GITHUB_TOKEN:'test-token',GITHUB_EVENT_PATH:eventPath,GITHUB_OUTPUT:outputPath,GITHUB_RUN_ID:'99',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'prejsik/discovercars-tool',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_API_URL:`http://127.0.0.1:${server.address().port}`};
  try {
    const result=await runGate(env);
    assert.equal(result.shouldRun,false);
    assert.match(fs.readFileSync(outputPath,'utf8'),/should_run=false/);
    assert.match(fs.readFileSync(outputPath,'utf8'),new RegExp(`run_started_epoch=${Math.floor(Date.parse(originalCreatedAt)/1000)}\\n`), 'A retry must not make the source look newer than its original run');
    apiFailure=true;
    await assert.rejects(runGate(env),/GitHub API 403/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    // Test-created temporary files only.
    fs.rmSync(root,{recursive:true,force:true});
  }
  console.log('PASS: incident replay, separate slots, publication evidence, active/queued runs, dates, DST and external dispatch');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
