const WARSAW_TIME_ZONE = "Europe/Warsaw";

const WEEKDAY_INDEX = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7
};

const START_DAY_TO_WEEKDAY = {
  thursday: 4,
  friday: 5
};

const partsFormatterCache = new Map();
const offsetFormatterCache = new Map();

function getPartsFormatter(timeZone) {
  if (!partsFormatterCache.has(timeZone)) {
    partsFormatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
        hourCycle: "h23"
      })
    );
  }

  return partsFormatterCache.get(timeZone);
}

function getOffsetFormatter(timeZone) {
  if (!offsetFormatterCache.has(timeZone)) {
    offsetFormatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
        hourCycle: "h23"
      })
    );
  }

  return offsetFormatterCache.get(timeZone);
}

function getZonedDateParts(date, timeZone = WARSAW_TIME_ZONE) {
  const formatter = getPartsFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  const weekdayKey = String(map.weekday || "").slice(0, 3);

  return {
    year: Number.parseInt(map.year, 10),
    month: Number.parseInt(map.month, 10),
    day: Number.parseInt(map.day, 10),
    hour: Number.parseInt(map.hour, 10),
    minute: Number.parseInt(map.minute, 10),
    second: Number.parseInt(map.second, 10),
    weekday: WEEKDAY_INDEX[weekdayKey] || 1
  };
}

function getTimeZoneOffsetMinutes(date, timeZone = WARSAW_TIME_ZONE) {
  const formatter = getOffsetFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const zonePart = parts.find((part) => part.type === "timeZoneName");
  const zoneText = String(zonePart?.value || "").replace("UTC", "GMT");
  const offsetMatch = zoneText.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);

  if (offsetMatch) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number.parseInt(offsetMatch[2], 10) || 0;
    const minutes = Number.parseInt(offsetMatch[3] || "0", 10) || 0;
    return sign * (hours * 60 + minutes);
  }

  const zoned = getZonedDateParts(date, timeZone);
  const asUtcMillis = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second
  );

  return Math.round((asUtcMillis - date.getTime()) / 60000);
}

function addDaysToDateParts(parts, days) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  base.setUTCDate(base.getUTCDate() + days);

  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate()
  };
}

function zonedLocalDateTimeToUtcDate(localDateTime, timeZone = WARSAW_TIME_ZONE) {
  const targetMillis = Date.UTC(
    localDateTime.year,
    localDateTime.month - 1,
    localDateTime.day,
    localDateTime.hour,
    localDateTime.minute,
    localDateTime.second || 0
  );

  let guess = targetMillis;

  for (let step = 0; step < 5; step += 1) {
    const offset = getTimeZoneOffsetMinutes(new Date(guess), timeZone);
    const nextGuess = targetMillis - offset * 60_000;
    if (nextGuess === guess) {
      break;
    }
    guess = nextGuess;
  }

  return new Date(guess);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatOffset(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function toIsoWithOffset(date, timeZone = WARSAW_TIME_ZONE) {
  const zoned = getZonedDateParts(date, timeZone);
  const offset = getTimeZoneOffsetMinutes(date, timeZone);

  return `${zoned.year}-${pad2(zoned.month)}-${pad2(zoned.day)}T${pad2(zoned.hour)}:${pad2(
    zoned.minute
  )}:${pad2(zoned.second)}${formatOffset(offset)}`;
}

function parseDateOnlyString(dateText) {
  const match = String(dateText || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid pickup date format "${dateText}". Expected YYYY-MM-DD.`);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`Invalid pickup date value "${dateText}".`);
  }

  return { year, month, day };
}

function resolvePickupDateParts(pickupDateInput, timeZone = WARSAW_TIME_ZONE) {
  if (pickupDateInput && typeof pickupDateInput === "object" && !(pickupDateInput instanceof Date)) {
    const year = Number.parseInt(pickupDateInput.year, 10);
    const month = Number.parseInt(pickupDateInput.month, 10);
    const day = Number.parseInt(pickupDateInput.day, 10);
    const probe = new Date(Date.UTC(year, month - 1, day));

    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      probe.getUTCFullYear() === year &&
      probe.getUTCMonth() === month - 1 &&
      probe.getUTCDate() === day
    ) {
      return { year, month, day };
    }
  }

  if (pickupDateInput instanceof Date) {
    const zoned = getZonedDateParts(pickupDateInput, timeZone);
    return {
      year: zoned.year,
      month: zoned.month,
      day: zoned.day
    };
  }

  if (typeof pickupDateInput === "string") {
    return parseDateOnlyString(pickupDateInput);
  }

  throw new Error("pickupDate is required (Date, YYYY-MM-DD, or { year, month, day }).");
}

function computeRentalWindowFromPickupDate(options = {}) {
  const timeZone = options.timeZone || WARSAW_TIME_ZONE;
  const pickupHour = Number.isFinite(options.pickupHour) ? options.pickupHour : 10;
  const dropoffHour = Number.isFinite(options.dropoffHour) ? options.dropoffHour : 10;
  const rentalDays =
    Number.isFinite(options.rentalDays) && options.rentalDays > 0 ? Number(options.rentalDays) : 2;
  const pickupDate = resolvePickupDateParts(options.pickupDateParts || options.pickupDate, timeZone);
  const dropoffDate = addDaysToDateParts(pickupDate, rentalDays);

  const pickupLocal = {
    year: pickupDate.year,
    month: pickupDate.month,
    day: pickupDate.day,
    hour: pickupHour,
    minute: 0,
    second: 0
  };

  const dropoffLocal = {
    year: dropoffDate.year,
    month: dropoffDate.month,
    day: dropoffDate.day,
    hour: dropoffHour,
    minute: 0,
    second: 0
  };

  const pickupUtc = zonedLocalDateTimeToUtcDate(pickupLocal, timeZone);
  const dropoffUtc = zonedLocalDateTimeToUtcDate(dropoffLocal, timeZone);
  const computedRentalDays = Math.round((dropoffUtc.getTime() - pickupUtc.getTime()) / 86_400_000);

  return {
    timeZone,
    pickupLocal,
    dropoffLocal,
    pickupUtc,
    dropoffUtc,
    pickupIso: toIsoWithOffset(pickupUtc, timeZone),
    dropoffIso: toIsoWithOffset(dropoffUtc, timeZone),
    rentalDays: computedRentalDays
  };
}

function computeNearestRentalWindow(options = {}) {
  const timeZone = options.timeZone || WARSAW_TIME_ZONE;
  const pickupHour = Number.isFinite(options.pickupHour) ? options.pickupHour : 10;
  const dropoffHour = Number.isFinite(options.dropoffHour) ? options.dropoffHour : 10;
  const rentalDays =
    Number.isFinite(options.rentalDays) && options.rentalDays > 0 ? Number(options.rentalDays) : 2;
  const startDayNormalized = String(options.startDay || "friday").trim().toLowerCase();
  const targetWeekday = START_DAY_TO_WEEKDAY[startDayNormalized] || START_DAY_TO_WEEKDAY.friday;

  const now = options.now instanceof Date ? options.now : new Date();
  const nowZoned = getZonedDateParts(now, timeZone);

  let daysUntilStart = (targetWeekday - nowZoned.weekday + 7) % 7;
  const isTargetDayAfterPickupTime =
    nowZoned.weekday === targetWeekday &&
    (nowZoned.hour > pickupHour ||
      (nowZoned.hour === pickupHour && (nowZoned.minute > 0 || nowZoned.second > 0)));

  if (isTargetDayAfterPickupTime) {
    daysUntilStart = 7;
  }

  const pickupDate = addDaysToDateParts(nowZoned, daysUntilStart);
  const rentalWindow = computeRentalWindowFromPickupDate({
    timeZone,
    pickupHour,
    dropoffHour,
    rentalDays,
    pickupDateParts: pickupDate
  });

  return {
    startDay: startDayNormalized,
    ...rentalWindow
  };
}

function computeNearestWeekend(options = {}) {
  return computeNearestRentalWindow({
    ...options,
    startDay: "friday",
    rentalDays: 2
  });
}

module.exports = {
  WARSAW_TIME_ZONE,
  START_DAY_TO_WEEKDAY,
  addDaysToDateParts,
  computeNearestRentalWindow,
  computeRentalWindowFromPickupDate,
  computeNearestWeekend,
  getTimeZoneOffsetMinutes,
  getZonedDateParts,
  toIsoWithOffset,
  zonedLocalDateTimeToUtcDate
};
