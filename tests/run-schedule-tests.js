const assert = require('node:assert/strict');
const { resolveSchedule, findDuplicate, markerName, runGate, warsawParts } = require('../src/discovercarsSchedule');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const YAML=require('yaml');

async function main() {
  const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/discovercars-daily.yml'),'utf8');
  assert.match(workflow,/concurrency:\s+group: discovercars-pages-site\s+cancel-in-progress: false\s+queue: max/,'Fallback triggers must not cancel a pending scheduled run');
  const night = resolveSchedule({ event: 'schedule', cron: '12 16 * * *', createdAt: '2026-09-29T00:23:53Z', now: '2026-09-29T00:32:07Z' });
  assert.equal(night.key, 'night-2026-09-29');
  assert.equal(night.rollingDays, 45);
  const {dueSchedule,nextDate,resolveCronSchedule}=require('../src/discovercarsScheduleConfig');
  // No Node globals/imports are available to the shared Worker/browser module.
  const sandbox={module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/discovercarsScheduleConfig.js'),'utf8'),sandbox);
  assert.equal(sandbox.module.exports.dueSchedule('2026-09-29T16:07:00Z').key,'night-2026-09-30');
  assert.deepEqual(warsawParts('2026-09-29T07:37:00Z'),{date:'2026-09-29',hour:9,minute:37});
  for (const [date,want] of [['2026-10-31','2026-11-01'],['2026-12-31','2027-01-01'],['2028-02-28','2028-02-29'],['2027-03-28','2027-03-29']]) {
    assert.equal(nextDate(date),want);
  }
  const transitionDays=[
    {date:'2026-10-24',next:'2026-10-25',summer:true},
    {date:'2026-10-25',next:'2026-10-26',summer:false},
    {date:'2026-12-15',next:'2026-12-16',summer:false},
    {date:'2027-03-27',next:'2027-03-28',summer:false},
    {date:'2027-03-28',next:'2027-03-29',summer:true}
  ];
  const crons=YAML.parse(workflow).on.schedule.map(s=>s.cron);
  assert.equal(crons.length,8,'Only the eight new DST fallback expressions may be active');
  for (const {date,next,summer} of transitionDays) {
    for (const [slot,rollingDays,reportDate,pairs] of [
      ['day',20,date,[['42 7 * * *','42 8 * * *'],['2 8 * * *','2 9 * * *']]],
      ['night',45,next,[['12 16 * * *','12 17 * * *'],['32 16 * * *','32 17 * * *']]]
    ]) {
      const want={slot,reportDate,key:`${slot}-${reportDate}`,rollingDays};
      for (const pair of pairs) {
        const active=pair[summer ? 0 : 1];
        const inactive=pair[summer ? 1 : 0];
        for (const cron of pair) assert.ok(crons.includes(cron),`Missing fallback: ${cron}`);
        assert.deepEqual(resolveCronSchedule(active,date+'T20:00:00Z'),want);
        assert.equal(resolveCronSchedule(inactive,date+'T20:00:00Z'),null,`${date} ${inactive}`);
        assert.deepEqual(resolveSchedule({event:'schedule',cron:active,createdAt:date+'T20:00:00Z',now:date+'T20:01:00Z'}),{shouldRun:true,runType:'full',...want});
        assert.equal(resolveSchedule({event:'schedule',cron:inactive,createdAt:date+'T20:00:00Z',now:date+'T20:01:00Z'}).shouldRun,false);
      }
      const utcHour=slot === 'day' ? (summer ? '07' : '08') : (summer ? '16' : '17');
      const minute=slot === 'day' ? 37 : 7;
      const start=`${date}T${utcHour}:${String(minute).padStart(2,'0')}:00Z`;
      for (const offset of [0,5,25]) assert.deepEqual(dueSchedule(Date.parse(start)+offset*60000),want);
      for (const offset of [-1,26,60]) assert.equal(dueSchedule(Date.parse(start)+offset*60000),null);
      assert.equal(dueSchedule(Date.parse(start)+5*60000,4),null);
      assert.deepEqual(dueSchedule(Date.parse(start)+5*60000,5),want);
    }
  }
  assert.equal(dueSchedule('2026-10-25T00:30:00Z'),null);
  assert.equal(dueSchedule('2026-10-25T01:30:00Z'),null);
  assert.equal(dueSchedule('2027-03-28T01:30:00Z'),null);
  for (const [cron,createdAt,reportDate] of [
    ['12 16 * * *','2026-10-25T00:23:00Z','2026-10-25'],
    ['32 17 * * *','2026-10-26T00:23:00Z','2026-10-26'],
    ['12 17 * * *','2027-03-28T00:23:00Z','2027-03-28'],
    ['32 16 * * *','2027-03-29T00:23:00Z','2027-03-29']
  ]) {
    const delayedNight=resolveSchedule({event:'schedule',cron,createdAt,now:createdAt});
    assert.equal(delayedNight.key,`night-${reportDate}`);
    assert.equal(delayedNight.rollingDays,45);
  }
  assert.throws(()=>resolveCronSchedule('7 7 * * *','2026-09-29T12:00:00Z'),/Unknown schedule/);
  assert.throws(()=>resolveCronSchedule('42 7 * * *',undefined),/creation time/);
  for (const cron of ['17 20 * * *','47 20 * * *','17 21 * * *','0 9 * * *','30 9 * * *','0 10 * * *','30 10 * * *']) {
    assert.equal(crons.includes(cron),false);
    assert.equal(resolveCronSchedule(cron,'2026-10-21T22:00:00Z'),null);
    assert.equal(resolveSchedule({event:'schedule',cron,createdAt:'2026-10-21T22:00:00Z',now:'2026-10-21T22:01:00Z'}).shouldRun,false);
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
  // Cloudflare, cron fallbacks and delayed/manual night runs share the same key.
  for (const context of [
    dueSchedule('2026-09-28T16:07:00Z'),
    resolveCronSchedule('12 16 * * *','2026-09-29T00:23:53Z'),
    resolveCronSchedule('32 16 * * *','2026-09-28T16:32:00Z'),
    resolveSchedule({event:'workflow_dispatch',slot:'night',reportDate:'2026-09-29',now:'2026-09-29T00:32:07Z'})
  ]) {
    assert.equal(context.key,'night-2026-09-29');
    assert.equal((await findDuplicate(context,completed,async()=>[{name:markerName('published','night-2026-09-29')}])).id,1);
  }
  assert.throws(()=>resolveSchedule({event:'schedule',cron:'7 7 * * *',createdAt:'2026-09-29T12:00:00Z',now:'2026-09-29T12:00:00Z'}),/Unknown schedule/);
  const delayed = resolveSchedule({event:'schedule',cron:'42 7 * * *',createdAt:'2026-09-29T16:08:34Z',now:'2026-09-29T16:10:00Z'});
  assert.equal(delayed.key,'day-2026-09-29');
  assert.equal(resolveSchedule({event:'schedule',cron:'42 7 * * *',createdAt:'2026-09-29T07:43:00Z',now:'2026-09-30T01:00:00Z'}).shouldRun,false);
  assert.equal(resolveSchedule({event:'schedule',cron:'12 16 * * *',createdAt:'2026-09-28T16:12:00Z',now:'2026-09-30T01:00:00Z'}).shouldRun,false);
  const external = resolveSchedule({event:'workflow_dispatch',slot:'day',reportDate:'2026-09-29',createdAt:'2026-09-29T07:00:00Z',now:'2026-09-29T07:00:00Z'});
  assert.equal(external.key,'day-2026-09-29');
  assert.equal(external.rollingDays,20);
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
