const fs = require("fs");
const path = require("path");

const DEFAULT_LOCATION_REGISTRY_PATH = path.resolve(__dirname, "..", "locations.config.json");

function normalizeZones(zones) {
  return [...new Set((zones || []).map((zone) => String(zone || "").trim().toUpperCase()).filter(Boolean))];
}

function validateLocationRegistry(registry) {
  if (!registry || registry.schema_version !== 1 || !Array.isArray(registry.locations)) {
    throw new Error("Location registry must use schema_version 1 and contain a locations array.");
  }

  const ids = new Set();
  const labels = new Set();
  for (const location of registry.locations) {
    const id = String(location?.id || "").trim();
    const label = String(location?.scraper_label || "").trim();
    const zones = normalizeZones(location?.zones);
    if (!id || !label || !zones.length) {
      throw new Error("Every registry location requires id, scraper_label, and at least one zone.");
    }
    if (ids.has(id) || labels.has(label)) {
      throw new Error(`Duplicate location registry entry: ${id || label}.`);
    }
    ids.add(id);
    labels.add(label);
  }

  for (const [alias, zones] of Object.entries(registry.aliases || {})) {
    if (!String(alias).trim() || !normalizeZones(zones).length) {
      throw new Error("Every location alias requires a name and at least one zone.");
    }
  }

  for (const item of registry.profiles?.daily || []) {
    if (!ids.has(String(item))) {
      throw new Error(`Daily location profile references unknown location id: ${item}.`);
    }
  }
  return registry;
}

function loadLocationRegistry(registryPath = DEFAULT_LOCATION_REGISTRY_PATH) {
  const resolvedPath = path.resolve(registryPath);
  const registry = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  validateLocationRegistry(registry);
  return { ...registry, __path: resolvedPath };
}

function getProfileLocations(profileName, registry = loadLocationRegistry()) {
  const byId = new Map(registry.locations.map((location) => [location.id, location.scraper_label]));
  return (registry.profiles?.[profileName] || []).map((item) => byId.get(item) || String(item));
}

function getDailyLocations(registry = loadLocationRegistry()) {
  return getProfileLocations("daily", registry);
}

function buildLocationZones(registry = loadLocationRegistry()) {
  const mapping = {};
  for (const location of registry.locations) {
    mapping[location.scraper_label] = normalizeZones(location.zones);
  }
  for (const [alias, zones] of Object.entries(registry.aliases || {})) {
    mapping[alias] = normalizeZones(zones);
  }
  return mapping;
}

function buildGeoLocationOverrides(registry = loadLocationRegistry()) {
  const overrides = {};
  for (const location of registry.locations) {
    const geo = location?.discovercars?.geo;
    if (!geo) {
      continue;
    }
    overrides[location.scraper_label] = {
      latitude: Number(geo.latitude),
      longitude: Number(geo.longitude),
      radiusMeters: Number(geo.radius_meters),
      geoLocationName: String(geo.name || location.scraper_label)
    };
  }
  return overrides;
}

module.exports = {
  DEFAULT_LOCATION_REGISTRY_PATH,
  buildGeoLocationOverrides,
  buildLocationZones,
  getDailyLocations,
  getProfileLocations,
  loadLocationRegistry,
  validateLocationRegistry
};
