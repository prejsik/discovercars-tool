import schedule from '../../src/discovercarsScheduleConfig.js';

const WORKFLOW = '/actions/workflows/discovercars-daily.yml';
const MINUTE = 60000;

function matches(run, context) {
  if (run.head_branch !== 'main') return false;
  if (run.event === 'workflow_dispatch') return run.display_title?.trim() === `DiscoverCars ${context.slot} ${context.reportDate}`;
  if (run.event !== 'schedule') return false;
  try {
    return schedule.resolveCronSchedule(String(run.display_title).replace(/^DiscoverCars /, '').trim(), run.created_at)?.key === context.key;
  } catch { return false; }
}

async function list(repository, path, key) {
  const result = [];
  for (let page = 1; page <= 5; page++) {
    const body = await repository.api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(body[key])) throw new Error(`Incomplete GitHub ${key} response`);
    result.push(...body[key]);
    if (body[key].length < 100) return result;
  }
  throw new Error('Incomplete GitHub pagination; scheduler stopped safely');
}

export async function tickSchedule({ now, repository, storage }) {
  const context = schedule.dueSchedule(now, 30);
  if (!context) return { action: 'outside-window' };
  const key = `scraper-schedule:${context.slot}`;
  const stored = await storage.get(key);
  const state = stored?.key === context.key ? stored : { key: context.key, attempts: 0 };
  if (['done', 'started'].includes(state.action)) return state;
  const since = new Date(Date.parse(now) - 48 * 3600000).toISOString();
  const runs = (await list(repository, `${WORKFLOW}/runs?branch=main&created=${encodeURIComponent('>=' + since)}`, 'workflow_runs'))
    .filter(run => matches(run, context));
  const save = async result => {
    const next = { ...state, ...result };
    await storage.put(key, next);
    return next;
  };
  for (const run of runs.filter(run => run.status === 'completed')) {
    const artifacts = await list(repository, `/actions/runs/${run.id}/artifacts`, 'artifacts');
    if (artifacts.some(item => !item.expired && item.name === `discovercars-schedule-published-${context.key}`)) {
      return save({ action: 'done', runId: run.id });
    }
  }
  const pending = runs.find(run => run.status !== 'completed');
  if (pending) {
    const jobs = await list(repository, `/actions/runs/${pending.id}/jobs`, 'jobs');
    const started = jobs.some(job => (job.steps ?? []).some(step => step.name === 'Run scraper'
      && (step.status === 'in_progress' || step.conclusion === 'success')));
    return save({ action: started ? 'started' : 'monitor', runId: pending.id,
      delayed: !started && Date.parse(now) - Date.parse(pending.created_at) >= 15 * MINUTE });
  }
  if (state.attemptedAt) {
    // A lost POST response may still mean success. Never retry until that run is visible and finished.
    const visibleAttempt = runs.some(run => Date.parse(run.created_at) >= Date.parse(state.attemptedAt) - 3000);
    if (!visibleAttempt) return save({ action: 'unconfirmed', delayed: Date.parse(now) - Date.parse(state.attemptedAt) >= 15 * MINUTE });
    if (Date.parse(now) - Date.parse(state.attemptedAt) < 5 * MINUTE) return save({ action: 'cooldown' });
  }
  if (state.attempts >= 3) return save({ action: 'exhausted' });
  // Persist intent before the external write, including when the process is interrupted.
  state.attempts++;
  state.attemptedAt = now;
  await save({ action: 'unconfirmed' });
  try {
    await repository.api(`${WORKFLOW}/dispatches`, { method: 'POST', body: {
      ref: 'main', inputs: { schedule_slot: context.slot, report_date: context.reportDate },
    } });
    return save({ action: 'dispatched' });
  } catch {
    return save({ action: 'unconfirmed' });
  }
}
