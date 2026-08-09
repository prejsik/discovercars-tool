function clampPositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveGlobalConcurrency(options = {}) {
  const maxActivePages = clampPositiveInteger(options.maxActivePages, 8);
  let chunkConcurrency = clampPositiveInteger(options.chunkConcurrency, 1);
  let scenarioConcurrency = clampPositiveInteger(options.scenarioConcurrency, 1);
  let locationConcurrency = clampPositiveInteger(options.locationConcurrency, 1);

  while (chunkConcurrency * scenarioConcurrency * locationConcurrency > maxActivePages) {
    if (locationConcurrency > 1) {
      locationConcurrency -= 1;
      continue;
    }
    if (scenarioConcurrency > 1) {
      scenarioConcurrency -= 1;
      continue;
    }
    if (chunkConcurrency > 1) {
      chunkConcurrency -= 1;
      continue;
    }
    break;
  }

  return {
    maxActivePages,
    chunkConcurrency,
    scenarioConcurrency,
    locationConcurrency,
    activePageLimit: chunkConcurrency * scenarioConcurrency * locationConcurrency
  };
}

function normalizeLocationKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isScenarioCheckpointComplete(payload, expectedLocations = []) {
  const hasUsablePayload = Boolean(
    payload
    && Array.isArray(payload.results)
    && payload.results.length
    && Array.isArray(payload.errors)
    && payload.errors.length === 0
  );
  if (!hasUsablePayload) {
    return false;
  }

  if (!Array.isArray(expectedLocations) || expectedLocations.length === 0) {
    return true;
  }

  const coveredLocations = new Set();
  for (const [location, offers] of Object.entries(payload.top_3_by_location || {})) {
    if (Array.isArray(offers) && offers.length > 0) {
      coveredLocations.add(normalizeLocationKey(location));
    }
  }
  for (const result of payload.results) {
    if (result?.location) {
      coveredLocations.add(normalizeLocationKey(result.location));
    }
  }

  return expectedLocations.every((location) => coveredLocations.has(normalizeLocationKey(location)));
}

function getPayloadScenarios(payload) {
  if (Array.isArray(payload?.scenarios) && payload.scenarios.length > 0) {
    return payload.scenarios;
  }
  if (payload && Number.isFinite(Number(payload.rental_days))) {
    return [payload];
  }
  return [];
}

function getPayloadLocations(payload) {
  if (Array.isArray(payload?.locations) && payload.locations.length > 0) {
    return payload.locations;
  }
  return Object.keys(payload?.top_3_by_location || {});
}

function isRunPayloadComplete(payload) {
  const scenarios = getPayloadScenarios(payload);
  const locations = getPayloadLocations(payload);
  return scenarios.length > 0
    && locations.length > 0
    && scenarios.every((scenario) => isScenarioCheckpointComplete(scenario, locations));
}

function isChunkPayloadComplete(payload, expected = {}) {
  if (!isRunPayloadComplete(payload)) {
    return false;
  }

  const expectedLocations = new Set((expected.locations || []).map(normalizeLocationKey));
  const actualLocations = new Set(getPayloadLocations(payload).map(normalizeLocationKey));
  if (
    expectedLocations.size !== actualLocations.size
    || [...expectedLocations].some((location) => !actualLocations.has(location))
  ) {
    return false;
  }

  const expectedScenarios = new Set();
  for (const startDate of expected.startDates || []) {
    for (const duration of expected.durations || []) {
      expectedScenarios.add(`${startDate}|${Number(duration)}`);
    }
  }

  const actualScenarios = new Set(getPayloadScenarios(payload).map((scenario) => {
    const startDate = scenario.start_date || String(scenario.pickup_date || "").slice(0, 10);
    return `${startDate}|${Number(scenario.rental_days)}`;
  }));

  return expectedScenarios.size > 0
    && actualScenarios.size === expectedScenarios.size
    && [...expectedScenarios].every((scenario) => actualScenarios.has(scenario));
}

module.exports = {
  isChunkPayloadComplete,
  isRunPayloadComplete,
  isScenarioCheckpointComplete,
  resolveGlobalConcurrency
};
