const DEFAULT_CONFIG = {
  enabled: false,
  defaultMultiplier: 1,
  minMultiplier: 1,
  maxMultiplier: 1.25,
  locationMultipliers: {},
  durationMultipliers: {},
  locationDurationMultipliers: {}
};

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMultiplier(value, fallback = 1) {
  const number = asNumber(value);
  if (number === null || number <= 0) {
    return fallback;
  }
  return number;
}

function normalizeConfig(rawConfig = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...(rawConfig || {})
  };
  const fallbackMultiplier = normalizeMultiplier(
    config.defaultMultiplier ?? config.default_markup_multiplier,
    1
  );
  const defaultMarkupPercent = asNumber(config.defaultMarkupPercent ?? config.default_markup_percent);
  if (defaultMarkupPercent !== null) {
    config.defaultMultiplier = 1 + defaultMarkupPercent / 100;
  } else {
    config.defaultMultiplier = fallbackMultiplier;
  }
  config.minMultiplier = normalizeMultiplier(config.minMultiplier ?? config.min_multiplier, 1);
  config.maxMultiplier = normalizeMultiplier(config.maxMultiplier ?? config.max_multiplier, 1.25);
  if (config.maxMultiplier < config.minMultiplier) {
    config.maxMultiplier = config.minMultiplier;
  }
  config.locationMultipliers = config.locationMultipliers || config.location_multipliers || {};
  config.durationMultipliers = config.durationMultipliers || config.duration_multipliers || {};
  config.locationDurationMultipliers = config.locationDurationMultipliers || config.location_duration_multipliers || {};
  return config;
}

function extractBrokerMarkupConfig(rawConfig = {}) {
  return rawConfig?.brokerMarkupCalibration || rawConfig?.pricing?.brokerMarkupCalibration || rawConfig || {};
}

function mergeLocationDurationMultipliers(base = {}, learned = {}) {
  const merged = {};
  for (const location of new Set([...Object.keys(base || {}), ...Object.keys(learned || {})])) {
    merged[location] = {
      ...(base?.[location] || {}),
      ...(learned?.[location] || {})
    };
  }
  return merged;
}

function mergeBrokerMarkupCalibration(baseConfig = {}, learnedConfig = {}) {
  const base = normalizeConfig(extractBrokerMarkupConfig(baseConfig));
  const learned = extractBrokerMarkupConfig(learnedConfig);
  const merged = {
    ...base,
    ...learned,
    locationMultipliers: {
      ...(base.locationMultipliers || {}),
      ...(learned.locationMultipliers || learned.location_multipliers || {})
    },
    durationMultipliers: {
      ...(base.durationMultipliers || {}),
      ...(learned.durationMultipliers || learned.duration_multipliers || {})
    },
    locationDurationMultipliers: mergeLocationDurationMultipliers(
      base.locationDurationMultipliers,
      learned.locationDurationMultipliers || learned.location_duration_multipliers
    )
  };
  return normalizeConfig(merged);
}

function lookupLocationMultiplier(location, locationMultipliers) {
  const normalizedLocation = normalizeKey(location);
  if (!normalizedLocation) {
    return null;
  }

  const entries = Object.entries(locationMultipliers || {});
  for (const [key, value] of entries) {
    if (normalizeKey(key) === normalizedLocation) {
      return {
        value,
        source: `location:${key}`
      };
    }
  }

  for (const [key, value] of entries) {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey && normalizedLocation.startsWith(normalizedKey)) {
      return {
        value,
        source: `location-prefix:${key}`
      };
    }
  }

  return null;
}

function lookupDurationMultiplier(rentalDays, durationMultipliers) {
  const duration = asNumber(rentalDays);
  if (duration === null) {
    return null;
  }

  const entries = Object.entries(durationMultipliers || {});
  for (const [key, value] of entries) {
    const parts = String(key).split("-").map((item) => asNumber(item));
    if (parts.length === 1 && parts[0] === duration) {
      return {
        value,
        source: `duration:${key}`
      };
    }
    if (parts.length === 2 && parts[0] !== null && parts[1] !== null && duration >= parts[0] && duration <= parts[1]) {
      return {
        value,
        source: `duration:${key}`
      };
    }
  }

  return null;
}

function lookupLocationDurationMultiplier(location, rentalDays, locationDurationMultipliers) {
  const normalizedLocation = normalizeKey(location);
  if (!normalizedLocation) {
    return null;
  }

  const entries = Object.entries(locationDurationMultipliers || {});
  const exact = entries.find(([key]) => normalizeKey(key) === normalizedLocation);
  const prefix = entries.find(([key]) => {
    const normalizedKey = normalizeKey(key);
    return normalizedKey && normalizedLocation.startsWith(normalizedKey);
  });
  const selected = exact || prefix;
  if (!selected) {
    return null;
  }

  const durationMatch = lookupDurationMultiplier(rentalDays, selected[1]);
  if (!durationMatch) {
    return null;
  }
  return {
    value: durationMatch.value,
    source: `location-duration:${selected[0]}/${durationMatch.source.replace("duration:", "")}`
  };
}

function resolveBrokerMarkupCalibration(item, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) {
    return {
      enabled: false,
      multiplier: 1,
      percent: 0,
      source: "disabled"
    };
  }

  const locationDurationMatch = lookupLocationDurationMultiplier(
    item?.location,
    item?.rental_days,
    config.locationDurationMultipliers
  );
  const locationMatch = lookupLocationMultiplier(item?.location, config.locationMultipliers);
  const durationMatch = lookupDurationMultiplier(item?.rental_days, config.durationMultipliers);
  const selected = locationDurationMatch || locationMatch || durationMatch || {
    value: config.defaultMultiplier,
    source: "default"
  };
  const multiplier = clamp(
    normalizeMultiplier(selected.value, config.defaultMultiplier),
    config.minMultiplier,
    config.maxMultiplier
  );

  return {
    enabled: true,
    multiplier: Number(multiplier.toFixed(6)),
    percent: Number(((multiplier - 1) * 100).toFixed(2)),
    source: selected.source
  };
}

module.exports = {
  extractBrokerMarkupConfig,
  mergeBrokerMarkupCalibration,
  resolveBrokerMarkupCalibration
};
