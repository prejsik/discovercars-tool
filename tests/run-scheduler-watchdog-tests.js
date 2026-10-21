const assert=require('node:assert/strict');
const {planDispatch,scraperStarted,main}=require('../tools/dispatch_daily_scraper');
const now='2026-09-29T07:37:00Z';
const context={key:'day-2026-09-29',slot:'day',reportDate:'2026-09-29'};
const pending={id:1,display_title:'DiscoverCars day 2026-09-29',status:'queued'};
assert.equal(planDispatch({context,runs:[],now}).action,'dispatch');
assert.equal(planDispatch({context,runs:[pending],now}).action,'monitor');
const cronPending={id:5,event:'schedule',display_title:'DiscoverCars 42 7 * * *',created_at:'2026-09-29T07:42:00Z',status:'queued'};
assert.equal(planDispatch({context,runs:[cronPending],now:'2026-09-29T07:57:00Z'}).action,'monitor');
assert.equal(planDispatch({context,runs:[{...cronPending,display_title:'DiscoverCars 42 8 * * *',created_at:'2026-09-29T08:42:00Z'}],now:'2026-09-29T08:57:00Z'}).action,'outside-window');
assert.equal(planDispatch({context,runs:[pending],published:true,now}).action,'done');
assert.equal(planDispatch({context,runs:[],now:'2026-09-29T07:36:00Z'}).action,'outside-window');
assert.equal(planDispatch({context,runs:[],now:'2026-09-29T08:02:00Z'}).action,'dispatch');
assert.equal(planDispatch({context,runs:[],now:'2026-09-29T08:03:00Z'}).action,'outside-window');
assert.equal(planDispatch({context:{...context,key:'day-2026-12-15',reportDate:'2026-12-15'},runs:[],now:'2026-12-15T08:37:00Z'}).action,'dispatch');
const failures=[1,2,3].map(id=>({...pending,id,status:'completed',conclusion:'failure'}));
assert.equal(planDispatch({context,runs:failures,now}).action,'exhausted');
assert.equal(planDispatch({context,runs:failures.slice(0,2),now}).action,'dispatch');
const skipped=failures.map(r=>({...r,conclusion:'success',has_schedule_claim:false}));
assert.equal(planDispatch({context,runs:skipped,now}).action,'dispatch');
assert.equal(planDispatch({context,runs:skipped.map(r=>({...r,has_schedule_claim:true})),now}).action,'exhausted');
assert.equal(planDispatch({context,runs:[{...pending,display_title:'DiscoverCars night 2026-09-29'}],now}).action,'dispatch');
const night={key:'night-2026-09-30',slot:'night',reportDate:'2026-09-30'};
const nightPending={id:6,event:'workflow_dispatch',display_title:'DiscoverCars night 2026-09-30',status:'queued'};
for (const stamp of ['2026-09-29T16:07:00Z','2026-09-29T16:12:00Z','2026-09-29T16:32:00Z']) {
  assert.equal(planDispatch({context:night,runs:[],now:stamp}).action,'dispatch');
  assert.equal(planDispatch({context:night,runs:[nightPending],now:stamp}).action,'monitor');
  assert.equal(planDispatch({context:night,runs:failures.map(r=>({...r,display_title:nightPending.display_title})),now:stamp}).action,'exhausted');
}
assert.equal(planDispatch({context:night,runs:[],now:'2026-09-29T16:06:00Z'}).action,'outside-window');
assert.equal(planDispatch({context:night,runs:[],now:'2026-09-29T16:33:00Z'}).action,'outside-window');
assert.equal(planDispatch({context:night,runs:[],now:'2026-09-30T16:07:00Z'}).action,'outside-window');
assert.equal(planDispatch({context:night,runs:[nightPending],now:'2026-09-30T00:10:00Z'}).action,'monitor');
assert.equal(planDispatch({context:night,runs:[{...nightPending,event:'push'}],now:'2026-09-29T16:07:00Z'}).action,'dispatch');
for (const [date,next,hour] of [['2026-10-25','2026-10-26','17'],['2027-03-28','2027-03-29','16']]) {
  const dstNight={slot:'night',key:`night-${next}`,reportDate:next};
  assert.equal(planDispatch({context:dstNight,runs:[],now:`${date}T${hour}:07:00Z`}).action,'dispatch');
  for (const minute of [12,32]) {
    const run={id:7,event:'schedule',display_title:`DiscoverCars ${minute} ${Number(hour)} * * *`,created_at:`${date}T${hour}:${minute}:00Z`,status:'queued'};
    assert.equal(planDispatch({context:dstNight,runs:[run],now:`${next}T00:10:00Z`}).action,'monitor');
    const inactiveHour=hour === '17' ? '16' : '17';
    assert.equal(planDispatch({context:dstNight,runs:[{...run,display_title:`DiscoverCars ${minute} ${inactiveHour} * * *`}],now:`${date}T${hour}:07:00Z`}).action,'dispatch');
  }
}
assert.equal(scraperStarted([{steps:[{name:'Run scraper',conclusion:'skipped',status:'completed'}]}]),false);
assert.equal(scraperStarted([{steps:[{name:'Run scraper',conclusion:null,status:'in_progress'}]}]),true);
assert.equal(scraperStarted([{steps:[{name:'Run scraper',conclusion:'success',status:'completed'}]}]),true);
async function testCli() {
  const originalFetch=global.fetch;
  const originalToken=process.env.GH_TOKEN;
  process.env.GH_TOKEN='test-token';
  try {
    for (const scenario of [
      {now:'2026-09-29T07:37:00Z',slot:'day',date:'2026-09-29'},
      {now:'2026-10-25T17:07:00Z',slot:'night',date:'2026-10-26'},
      {now:'2027-03-28T16:32:00Z',slot:'night',date:'2027-03-29'},
      {now:'2026-09-29T16:07:00Z',slot:'night',date:'2026-09-30',postError:true},
      {now:'2026-09-29T16:07:00Z',slot:'night',date:'2026-09-30',postStatus:503},
      {now:'2026-09-29T16:07:00Z',slot:'night',date:'2026-09-30',pending:true},
      {now:'2026-09-29T16:07:00Z',slot:'night',date:'2026-09-30',published:true},
      {now:'2026-09-29T16:07:00Z',slot:'night',date:'2026-09-30',exhausted:true},
      {now:'2026-09-29T16:07:00Z',slot:'night',date:'2026-09-30',readError:true},
      {now:'2026-09-29T16:32:00Z',slot:'night',date:'2026-09-30',expireDuringRead:true},
      {now:'2026-09-29T16:33:00Z',slot:'night',date:'2026-09-30',outside:true}
    ]) {
      let stamp=scenario.now;
      let posts=0;
      let reads=0;
      let jobs=0;
      const run={id:42,event:'workflow_dispatch',display_title:`DiscoverCars ${scenario.slot} ${scenario.date}`,status:'queued',conclusion:null,created_at:stamp,html_url:'https://example.invalid/run/42'};
      global.fetch=async (url,options={})=>{
        assert.equal(new URL(url).origin,'https://api.github.com');
        if (options.method === 'POST') {
          posts++;
          assert.equal(new URL(url).pathname,'/repos/prejsik/discovercars-tool/actions/workflows/discovercars-daily.yml/dispatches');
          assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{schedule_slot:scenario.slot,report_date:scenario.date}});
          if (scenario.postError) throw new Error('uncertain dispatch timeout');
          return new Response(null,{status:scenario.postStatus || 204});
        }
        reads++;
        if (scenario.readError) return new Response('{}',{status:403});
        const pathname=new URL(url).pathname;
        if (pathname.endsWith('/jobs')) {
          jobs++;
          return Response.json({jobs:[{id:1,status:'in_progress',conclusion:null,steps:[{name:'Run scraper',status:'in_progress',conclusion:null}]}]});
        }
        if (pathname.endsWith('/artifacts')) return Response.json({artifacts:scenario.published ? [{name:`discovercars-schedule-published-${scenario.slot}-${scenario.date}`,expired:false}] : []});
        assert.equal(pathname,'/repos/prejsik/discovercars-tool/actions/workflows/discovercars-daily.yml/runs');
        if (scenario.expireDuringRead) stamp='2026-09-29T16:33:00Z';
        const runs=scenario.exhausted ? [1,2,3].map(id=>({...run,id,status:'completed',conclusion:'failure'}))
          : scenario.published ? [{...run,status:'completed',conclusion:'failure'}]
          : scenario.pending || posts ? [run] : [];
        return Response.json({workflow_runs:runs});
      };
      const operation=()=>main(()=>stamp);
      if (scenario.postError) await assert.rejects(operation,/uncertain dispatch timeout/);
      else if (scenario.postStatus) await assert.rejects(operation,/Workflow dispatch HTTP 503/);
      else if (scenario.readError) await assert.rejects(operation,/GitHub API 403/);
      else if (scenario.exhausted) await assert.rejects(operation,/Three dispatch attempts/);
      else await operation();
      const noPost=scenario.pending || scenario.published || scenario.exhausted || scenario.readError || scenario.expireDuringRead || scenario.outside;
      assert.equal(posts,noPost ? 0 : 1,'Dispatch must be bounded to a single POST, including uncertain failures');
      assert.equal(jobs,!noPost && !scenario.postError && !scenario.postStatus || scenario.pending ? 1 : 0);
      if (scenario.outside) assert.equal(reads,0,'Outside-window CLI must do no API work');
    }
  } finally {
    global.fetch=originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN=originalToken;
  }
  console.log('PASS: both Warsaw slots, DST, bounded attempts, actual scraper start, CLI payload, single POST on timeout/error');
}
testCli().catch(error=>{console.error(error);process.exitCode=1;});
