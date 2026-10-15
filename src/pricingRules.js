const fs = require("fs");
const path = require("path");

const DEFAULT_PRICING_RULES = Object.freeze({
  top1GapThresholdPlnDay: 10,
  top1RaiseBufferPlnDay: 1,
  top1UndercutThresholdPlnDay: 10,
  undercutBufferPlnDay: 1,
  top3SmallDecreaseThresholdPlnDay: 10,
  minChangePlnDay: 0.5,
  roundingIncrementPlnDay: 0.01,
  top1HighRateThresholdPlnDay: 150,
  maxRecommendationRentalDays: 20
});

function validateMandatoryZoneFloorsPlnDay(floors) {
  if (floors === undefined) return;
  if (!floors || typeof floors !== "object" || Array.isArray(floors)) {
    throw new Error("mandatoryZoneFloorsPlnDay must be a zone-to-duration-band object.");
  }
  for (const [zone, bands] of Object.entries(floors)) {
    if (!zone.trim() || zone !== zone.trim().toUpperCase() || !Array.isArray(bands) || !bands.length) {
      throw new Error(`Invalid mandatoryZoneFloorsPlnDay zone or bands: ${zone}.`);
    }
    for (const band of bands) {
      if (!Number.isSafeInteger(band?.minDays) || band.minDays < 1
          || !Number.isSafeInteger(band?.maxDays) || band.maxDays < band.minDays || band.maxDays > 35
          || !Number.isFinite(band?.minimumRatePlnDay) || band.minimumRatePlnDay <= 0) {
        throw new Error(`Invalid mandatoryZoneFloorsPlnDay duration or minimum for ${zone}.`);
      }
    }
    const ordered = [...bands].sort((a, b) => a.minDays - b.minDays);
    if (ordered.some((band, index) => index > 0 && band.minDays <= ordered[index - 1].maxDays)) {
      throw new Error(`Overlapping mandatoryZoneFloorsPlnDay duration bands for ${zone}.`);
    }
    if (ordered[ordered.length - 1].maxDays !== 35
        || ordered.some((band, index) => band.minDays !== (index === 0 ? 1 : ordered[index - 1].maxDays + 1))) {
      throw new Error(`mandatoryZoneFloorsPlnDay must cover every day from 1 to 35 for ${zone}.`);
    }
  }
}

function resolveMandatoryZoneFloorPlnDay(zone, rentalDays, pricingRules) {
  const days = Number(rentalDays);
  const band = pricingRules.mandatoryZoneFloorsPlnDay?.[zone]?.find((item) =>
    days >= item.minDays && days <= item.maxDays
  );
  return band?.minimumRatePlnDay || 0;
}

function validateLocationTypeFloorsPlnDay(rule) {
  if (rule === undefined || rule === null) return;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)
      || !Array.isArray(rule.groups) || !rule.groups.length
      || rule.groups.some((group) => typeof group !== "string" || !/^[A-Z0-9]{4}$/.test(group))
      || new Set(rule.groups).size !== rule.groups.length
      || !Number.isSafeInteger(rule.minDays) || rule.minDays < 1
      || !Number.isSafeInteger(rule.maxDays) || rule.maxDays < rule.minDays || rule.maxDays > 20
      || Object.keys(rule.minimumRatesByKind || {}).sort().join(",") !== "airport,city"
      || ["city", "airport"].some((kind) => !Number.isFinite(rule.minimumRatesByKind?.[kind]) || rule.minimumRatesByKind[kind] <= 0)) {
    throw new Error("Invalid locationTypeFloorsPlnDay groups, duration or city/airport minimum.");
  }
}

function resolveLocationTypeFloorPlnDay(kind, rentalDays, pricingRules, group) {
  const rule = pricingRules.locationTypeFloorsPlnDay;
  if (!rule || (group != null && !rule.groups.includes(group))
      || rentalDays < rule.minDays || rentalDays > rule.maxDays) return 0;
  return rule.minimumRatesByKind[kind] || 0;
}

const SCOPED_FLOOR_BANDS = [[1, 1], [2, 2], [3, 4], [5, 7], [8, 20], [21, 35]];
const SCOPED_FLOOR_KEYS = ['endDate', 'groups', 'maxDays', 'minDays', 'minimumRatePlnDay', 'overrideProtected', 'startDate', 'zones'];

function realDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validateMandatoryScopedFloorsPlnDay(floors, known = {}) {
  if (floors === undefined) return;
  if (!Array.isArray(floors)) throw new Error('mandatoryScopedFloorsPlnDay must be an array.');
  for (const rule of floors) {
    const scope = (key, pattern) => Array.isArray(rule?.[key]) && rule[key].length > 0
      && new Set(rule[key]).size === rule[key].length
      && rule[key].every((item) => typeof item === 'string' && pattern.test(item)
        && (!known[key] || known[key].includes(item)));
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || Object.keys(rule).sort().join(',') !== SCOPED_FLOOR_KEYS.join(',')
      || !scope('groups', /^[A-Z0-9]{4}$/) || !scope('zones', /^[A-Z0-9]+$/)
      || !realDate(rule.startDate) || !realDate(rule.endDate) || rule.startDate > rule.endDate
      || !SCOPED_FLOOR_BANDS.some(([low, high]) => rule.minDays === low && rule.maxDays === high)
      || !Number.isFinite(rule.minimumRatePlnDay) || rule.minimumRatePlnDay <= 0
      || typeof rule.overrideProtected !== 'boolean') {
      throw new Error('Invalid mandatoryScopedFloorsPlnDay known group/zone scope, dates, band, minimum or protection.');
    }
  }
}

function validateScopedFloorProtection(periods) {
  if (!Array.isArray(periods) || periods.some((period) => !realDate(period?.start_date)
    || !realDate(period?.end_date) || period.start_date > period.end_date)) {
    throw new Error('mandatoryScopedFloorsPlnDay requires explicit valid protected_rate_periods.');
  }
}

function prepareMandatoryScopedFloors(pricingRules, registry) {
  const floors = pricingRules.mandatoryScopedFloorsPlnDay;
  validateMandatoryScopedFloorsPlnDay(floors);
  if (!floors?.length) return null;
  const excel = pricingRules.excelPolicy ?? JSON.parse(fs.readFileSync(path.resolve(
    pricingRules.excelPolicyFile || path.join(__dirname, '..', 'excel-rate-update.config.example.json')
  ), 'utf8'));
  validateScopedFloorProtection(excel.protected_rate_periods);
  const groups = [
    ...(excel.apply_groups || []), ...(excel.excluded_groups || []),
    ...(pricingRules.locationTypeFloorsPlnDay?.groups || []),
    ...Object.keys(pricingRules.mandatoryGroupFloorsPlnDay || {}),
    ...(pricingRules.priorityTop1Rules || []).flatMap((rule) => rule.groups || []),
    ...(excel.minimum_rates?.scoped_overrides || []).flatMap((rule) => rule.groups || []),
    ...(excel.group_price_parity?.base_groups || []),
    ...Object.keys(excel.group_price_parity?.premium_adjustments_pln_day || {}),
    ...Object.keys(excel.group_rate_adjustments_pln_day || {}), ...Object.keys(excel.excluded_group_highlights || {}),
    ...Object.values(excel.omitted_group_zones || {}).flat(),
  ].filter((group) => typeof group === 'string' && /^[A-Z0-9]{4}$/.test(group));
  validateMandatoryScopedFloorsPlnDay(floors, { groups, zones: registry.locations.flatMap((entry) => entry.zones) });
  return excel;
}

function resolveMandatoryScopedFloorPlnDay(zone, rentalDays, pricingRules, group, pickupDate, protectedPeriods) {
  const floors = pricingRules.mandatoryScopedFloorsPlnDay;
  validateMandatoryScopedFloorsPlnDay(floors);
  if (!floors?.length) return 0;
  validateScopedFloorProtection(protectedPeriods);
  if (!realDate(pickupDate)) throw new Error('mandatoryScopedFloorsPlnDay requires a valid pickup date.');
  if (pricingRules.excelPolicy?.omitted_group_zones?.[zone]?.includes(group)) return 0;
  const protectedDate = protectedPeriods.some((period) => period.start_date <= pickupDate && pickupDate <= period.end_date);
  return Math.max(0, ...floors.filter((rule) => rule.zones.includes(zone) && rule.groups.includes(group)
    && rule.minDays <= rentalDays && rentalDays <= rule.maxDays
    && rule.startDate <= pickupDate && pickupDate <= rule.endDate
    && (!protectedDate || rule.overrideProtected === true)).map((rule) => rule.minimumRatePlnDay));
}

function resolveMandatoryGroupFloorPlnDay(group, rentalDays, pricingRules, pickupDate, protectedPeriods) {
  validateScopedFloorProtection(protectedPeriods);
  const protectedDate = protectedPeriods.some((period) => period.start_date <= pickupDate && pickupDate <= period.end_date);
  const floors = pricingRules.mandatoryGroupFloorsPlnDay || {};
  return Math.max(0, ...[...(floors[group] || []), ...(floors['*'] || [])].filter((band) =>
    band.minDays <= rentalDays && rentalDays <= band.maxDays
    && (!band.start_date || band.start_date <= pickupDate && pickupDate <= band.end_date)
    && (!protectedDate || band.override_protected_dates === true)).map((band) => band.minimumRatePlnDay));
}

function loadPricingRules(configPath = process.env.PRICING_RULES_CONFIG) {
  const resolvedPath = path.resolve(configPath || "pricing-rules.config.example.json");
  if (!fs.existsSync(resolvedPath)) {
    return { ...DEFAULT_PRICING_RULES };
  }

  const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const rules = {
    ...DEFAULT_PRICING_RULES,
    ...(payload?.pricing || payload || {})
  };
  validateMandatoryZoneFloorsPlnDay(rules.mandatoryZoneFloorsPlnDay);
  validateLocationTypeFloorsPlnDay(rules.locationTypeFloorsPlnDay);
  validateMandatoryScopedFloorsPlnDay(rules.mandatoryScopedFloorsPlnDay);
  return rules;
}

module.exports = {
  DEFAULT_PRICING_RULES,
  loadPricingRules,
  prepareMandatoryScopedFloors,
  resolveLocationTypeFloorPlnDay,
  resolveMandatoryScopedFloorPlnDay,
  resolveMandatoryGroupFloorPlnDay,
  resolveMandatoryZoneFloorPlnDay,
  validateLocationTypeFloorsPlnDay,
  validateMandatoryScopedFloorsPlnDay,
  validateMandatoryZoneFloorsPlnDay
};
