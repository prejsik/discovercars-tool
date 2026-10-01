const {githubClient,WORKFLOW,findDuplicate,resolveSchedule,warsawParts,markerName}=require('../src/discovercarsSchedule');

function matchesSlot(run,context,now) {
  if (run.display_title?.trim() === `DiscoverCars day ${context.reportDate}` && run.event !== 'push') return true;
  if (run.event !== 'schedule') return false;
  try {
    const schedule=resolveSchedule({event:'schedule',cron:String(run.display_title).replace(/^DiscoverCars /,'').trim(),createdAt:run.created_at,now});
    return schedule.shouldRun && schedule.key === context.key;
  } catch {return false;}
}

function planDispatch({context,runs,published=false,now=new Date().toISOString()}) {
  if (published) return {action:'done'};
  const matching=runs.filter(r=>matchesSlot(r,context,now));
  const pending=matching.find(r=>r.status !== 'completed');
  if (pending) return {action:'monitor',run:pending};
  const local=warsawParts(now);
  if (local.date !== context.reportDate || local.hour !== 11) return {action:'outside-window'};
  const attempts=matching.filter(r=>r.conclusion !== 'success' || r.has_schedule_claim);
  if (attempts.length>=3) return {action:'exhausted'};
  return {action:'dispatch'};
}

function scraperStarted(jobs) {
  return jobs.some(j=>(j.steps||[]).some(s=>s.name === 'Run scraper' && (s.status === 'in_progress' || s.conclusion === 'success')));
}

async function main() {
  const repository='prejsik/discovercars-tool';
  const token=process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const api=githubClient({token,repository});
  const reportDate=warsawParts(new Date()).date;
  const context=resolveSchedule({event:'workflow_dispatch',slot:'day',reportDate});
  const listRuns=()=>api.list(`actions/workflows/${WORKFLOW}/runs?branch=main&created=${encodeURIComponent('>='+reportDate+'T00:00:00Z')}`,'workflow_runs');
  let runs=await listRuns();
  const artifactCache=new Map();
  const getArtifacts=async id=>{
    if(!artifactCache.has(id)) artifactCache.set(id,await api.list(`actions/runs/${id}/artifacts`,'artifacts'));
    return artifactCache.get(id);
  };
  const duplicate=await findDuplicate(context,runs,getArtifacts);
  for (const run of runs.filter(r=>matchesSlot(r,context,new Date().toISOString()) && r.conclusion==='success')) {
    run.has_schedule_claim=(await getArtifacts(run.id)).some(a=>!a.expired && a.name===markerName('claim',context.key));
  }
  const plan=planDispatch({context,runs,published:duplicate?.status==='completed'});
  if (plan.action==='done' || plan.action==='outside-window') {console.log(plan.action);return;}
  if (plan.action==='exhausted') throw new Error('Three dispatch attempts already made today; operator attention required');
  let target=duplicate || plan.run;
  if (!target) {
    // A POST is deliberately not retried: a timeout may mean GitHub accepted it.
    const response=await fetch(`https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW}/dispatches`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
      body:JSON.stringify({ref:'main',inputs:{schedule_slot:'day',report_date:reportDate}}),signal:AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Workflow dispatch HTTP ${response.status}`);
    console.log(`Dispatched ${context.key}; checking actual scraper start`);
  }
  const deadline=Date.now()+15*60*1000;
  while (Date.now()<deadline) {
    runs=await listRuns();
    target=target ? runs.find(r=>r.id===target.id) : runs.find(r=>r.display_title===`DiscoverCars day ${reportDate}` && !['failure','cancelled'].includes(r.conclusion));
    if (target) {
      const jobs=await api.list(`actions/runs/${target.id}/jobs`,'jobs');
      if (scraperStarted(jobs)) {console.log(`Scraper started: ${target.html_url}`);return;}
      if (target.status==='completed') {
        const winner=await findDuplicate(context,runs,id=>api.list(`actions/runs/${id}/artifacts`,'artifacts'));
        if (winner?.status==='completed') {console.log(`Published: ${winner.html_url}`);return;}
        throw new Error(`Run completed without scraper start: ${target.html_url}`);
      }
    }
    await new Promise(resolve=>setTimeout(resolve,30000));
  }
  throw new Error('No confirmed scraper start after 15 minutes; queued run kept, no duplicate dispatched');
}

module.exports={planDispatch,scraperStarted,matchesSlot};
if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
