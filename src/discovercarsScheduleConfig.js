const SLOTS = {
  day: {
    hour: 9, minute: 37, rollingDays: 20,
    crons: ['42 7 * * *', '2 8 * * *', '42 8 * * *', '2 9 * * *'],
    fallbackMinutes: [9 * 60 + 42, 10 * 60 + 2]
  },
  night: {
    hour: 18, minute: 7, rollingDays: 45,
    crons: ['12 16 * * *', '32 16 * * *', '12 17 * * *', '32 17 * * *'],
    fallbackMinutes: [18 * 60 + 12, 18 * 60 + 32]
  }
};
const LEGACY_CRONS = ['17 20 * * *', '47 20 * * *', '17 21 * * *', '0 9 * * *', '30 9 * * *', '0 10 * * *', '30 10 * * *'];
const WARSAW_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function warsawParts(now) {
  const parts = Object.fromEntries(WARSAW_FORMAT.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return {date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute)};
}

function nextDate(date) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function scheduleContext(slot, date) {
  const reportDate = slot === 'night' ? nextDate(date) : date;
  return {slot, reportDate, key: `${slot}-${reportDate}`, rollingDays: SLOTS[slot].rollingDays};
}

function dueSchedule(now, windowMinutes = 25) {
  const local = warsawParts(now);
  for (const [slot, config] of Object.entries(SLOTS)) {
    const elapsed = local.hour * 60 + local.minute - (config.hour * 60 + config.minute);
    // Inclusive, minute-granular end keeps the +25 minute fallback eligible.
    if (elapsed >= 0 && elapsed <= windowMinutes) return scheduleContext(slot, local.date);
  }
  return null;
}

function resolveCronSchedule(cron, createdAt) {
  if (LEGACY_CRONS.includes(cron)) return null;
  const entry = Object.entries(SLOTS).find(([, config]) => config.crons.includes(cron));
  if (!entry) throw new Error(`Unknown schedule: ${cron}`);
  const created = new Date(createdAt);
  if (!Number.isFinite(created.getTime())) throw new Error('Missing run creation time');
  const [minute, hour] = cron.split(' ').map(Number);
  // Anchor to the most recent nominal trigger, even when GitHub creates it after midnight.
  const nominal = new Date(created);
  nominal.setUTCHours(hour, minute, 0, 0);
  if (nominal > created) nominal.setUTCDate(nominal.getUTCDate() - 1);
  const local = warsawParts(nominal);
  const [slot, config] = entry;
  if (!config.fallbackMinutes.includes(local.hour * 60 + local.minute)) return null;
  return scheduleContext(slot, local.date);
}

module.exports = {warsawParts, nextDate, dueSchedule, resolveCronSchedule};
