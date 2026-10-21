const fs = require('node:fs');
const {warsawParts,nextDate,resolveCronSchedule} = require('./discovercarsScheduleConfig');

const WORKFLOW = 'discovercars-daily.yml';

function resolveSchedule({event,cron,createdAt,now=new Date().toISOString(),slot,reportDate}) {
  const today = warsawParts(now).date;
  if (event === 'schedule') {
    const schedule = resolveCronSchedule(cron,createdAt);
    if (!schedule) return {shouldRun:false,runType:'skip',reason:'Inactive or retired UTC schedule for Warsaw'};
    ({slot,reportDate} = schedule);
  } else if (event !== 'workflow_dispatch' || !slot) {
    return {shouldRun:true,runType:event === 'push' ? 'push-smoke' : 'manual'};
  }
  if (!['day','night'].includes(slot)) throw new Error('Invalid schedule slot');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate || '') || new Date(`${reportDate}T12:00:00Z`).toISOString().slice(0,10) !== reportDate) throw new Error('Invalid report date');
  const key = `${slot}-${reportDate}`;
  if (reportDate !== today && !(slot === 'night' && reportDate === nextDate(today))) {
    return {shouldRun:false,runType:'skip',key,reason:'Stale or future report date'};
  }
  return {shouldRun:true,runType:'full',slot,reportDate,key,rollingDays:slot === 'day' ? 20 : 45};
}

function markerName(kind,key) {
  return `discovercars-schedule-${kind}-${key}`;
}

async function findDuplicate(context,runs,getArtifacts) {
  for (const run of runs) {
    const active = run.status === 'in_progress';
    // A failed collection shard can still produce a validated partial publication.
    const complete = run.status === 'completed';
    if (!active && !complete) continue;
    const artifacts = await getArtifacts(run.id);
    const name = markerName(active ? 'claim' : 'published',context.key);
    if (artifacts.some(a=>a.name === name && !a.expired)) return run;
  }
  return null;
}

function githubClient({token,repository,apiUrl='https://api.github.com'}) {
  if (!token || !repository) throw new Error('Missing GitHub token or repository');
  async function request(path) {
    for (let attempt=0;attempt<3;attempt++) {
      const response = await fetch(`${apiUrl}/repos/${repository}/${path}`, {
        headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
        signal:AbortSignal.timeout(30000)
      });
      if (response.ok) return response.json();
      if (response.status<500 || attempt === 2) throw new Error(`GitHub API ${response.status} for ${path}`);
      await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
    }
  }
  async function list(path,key) {
    const items=[];
    for (let page=1;page<=20;page++) {
      const body=await request(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
      items.push(...(body[key]||[]));
      if ((body[key]||[]).length<100) return items;
    }
    throw new Error('GitHub pagination limit reached; refusing incomplete duplicate check');
  }
  return {request,list};
}

async function runGate(env=process.env) {
  const event=JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  const api=githubClient({token:env.GITHUB_TOKEN,repository:env.GITHUB_REPOSITORY,apiUrl:env.GITHUB_API_URL});
  const run=await api.request(`actions/runs/${env.GITHUB_RUN_ID}`);
  const originalStartedAt=Date.parse(run.created_at);
  if (!Number.isFinite(originalStartedAt)) throw new Error('Missing run creation time');
  const context=resolveSchedule({event:env.GITHUB_EVENT_NAME,cron:event.schedule,createdAt:run.created_at,slot:event.inputs?.schedule_slot,reportDate:event.inputs?.report_date});
  if (context.key && context.shouldRun) {
    if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('Scheduled production runs require main');
    const since=new Date(Date.now()-72*3600000).toISOString();
    const runs=await api.list(`actions/workflows/${WORKFLOW}/runs?branch=main&created=${encodeURIComponent('>='+since)}`,'workflow_runs');
    const duplicate=await findDuplicate(context,runs.filter(r=>String(r.id)!==env.GITHUB_RUN_ID),id=>api.list(`actions/runs/${id}/artifacts`,'artifacts'));
    if (duplicate) {context.shouldRun=false;context.runType='skip';context.reason=`Already active or published: ${duplicate.id}`;}
  }
  console.log(JSON.stringify(context));
  const outputs={should_run:context.shouldRun,run_type:context.runType,schedule_key:context.key||'',schedule_slot:context.slot||'',rolling_days:context.rollingDays||'',run_started_epoch:Math.floor(originalStartedAt/1000)};
  fs.appendFileSync(env.GITHUB_OUTPUT,Object.entries(outputs).map(([k,v])=>`${k}=${v}\n`).join(''));
  if (context.shouldRun && context.key) {
    fs.mkdirSync('output',{recursive:true});
    fs.writeFileSync('output/schedule-context.json',JSON.stringify({...context,run_id:env.GITHUB_RUN_ID,created_at:run.created_at},null,2)+'\n');
  }
  return context;
}

module.exports={resolveSchedule,findDuplicate,markerName,warsawParts,githubClient,WORKFLOW,runGate};
if (require.main === module) runGate().catch(error=>{console.error(error.message);process.exitCode=1;});
