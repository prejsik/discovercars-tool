import schedule from '../../src/discovercarsScheduleConfig.js';

// Read the scheduler's public interface at build time; never dispatch a run.
export function readSchedulePlan(day = '2026-01-05') {
  const slots = new Map();
  for (let minute = 0; minute < 1440; minute++) {
    const at = new Date(Date.parse(`${day}T00:00:00Z`) + minute * 60000);
    const due = schedule.dueSchedule(at, 0);
    if (!due) continue;
    const { hour, minute: localMinute } = schedule.warsawParts(at);
    slots.set(due.slot, { slot: due.slot, time: `${String(hour).padStart(2,'0')}:${String(localMinute).padStart(2,'0')}`, rollingDays: due.rollingDays });
  }
  return [...slots.values()].sort((a,b) => a.time.localeCompare(b.time));
}
