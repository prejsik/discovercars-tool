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
  return rules;
}

module.exports = {
  DEFAULT_PRICING_RULES,
  loadPricingRules,
  resolveLocationTypeFloorPlnDay,
  resolveMandatoryZoneFloorPlnDay,
  validateLocationTypeFloorsPlnDay,
  validateMandatoryZoneFloorsPlnDay
};
