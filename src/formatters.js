const fs = require("fs");
const path = require("path");
const util = require("util");

const ANSI_RESET = "\x1b[0m";
const ANSI_MM = "\x1b[1;30;43m";

function normalizeProviderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function isMmCarsProvider(value) {
  return normalizeProviderName(value).includes("mm cars rental");
}

function highlightMmText(text) {
  return {
    [util.inspect.custom]: () => `${ANSI_MM}${text}${ANSI_RESET}`
  };
}

function toPrintableRow(result) {
  return {
    location: result.location,
    provider_name: result.provider_name,
    total_price: Number(result.total_price.toFixed(2)),
    currency: result.currency,
    rental_days: result.rental_days,
    pickup_date: result.pickup_date,
    dropoff_date: result.dropoff_date,
    car_name: result.car_name || "",
    source_url: result.source_url
  };
}

function printResultsTable(results) {
  if (!results.length) {
    console.log("No successful offers found.");
    return;
  }

  const rows = results.map(toPrintableRow);
  console.table(rows);
}

function printErrorsTable(errors) {
  if (!errors.length) {
    console.log("No location-level errors.");
    return;
  }

  console.table(errors);
}

function buildCheapestByLocation(results, locations) {
  const lookup = new Map();
  for (const result of results) {
    lookup.set(result.location.toLowerCase(), result);
  }

  const cheapestByLocation = {};
  for (const location of locations) {
    cheapestByLocation[location] = lookup.get(location.toLowerCase()) || null;
  }

  return cheapestByLocation;
}

function buildBreakdownLookup(locationBreakdown) {
  const lookup = new Map();

  for (const entry of locationBreakdown || []) {
    const key = String(entry?.location || "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    lookup.set(key, entry);
  }

  return lookup;
}

function buildTop3ByLocation(locationBreakdown, locations) {
  const breakdownLookup = buildBreakdownLookup(locationBreakdown);
  const output = {};

  for (const location of locations) {
    const entry = breakdownLookup.get(String(location).toLowerCase());
    output[location] = Array.isArray(entry?.top_3_offers) ? entry.top_3_offers : [];
  }

  return output;
}

function buildMmCarsRentalByLocation(locationBreakdown, locations) {
  const breakdownLookup = buildBreakdownLookup(locationBreakdown);
  const output = {};

  for (const location of locations) {
    const entry = breakdownLookup.get(String(location).toLowerCase());
    output[location] = entry?.mm_cars_rental_offer || null;
  }

  return output;
}

function buildTop3PlusMmByLocation(top3ByLocation, mmCarsRentalByLocation, locations) {
  const output = {};

  for (const location of locations) {
    const topOffers = Array.isArray(top3ByLocation[location]) ? top3ByLocation[location] : [];
    output[location] = {
      top_3: [0, 1, 2].map((index) => topOffers[index] || null),
      mm_cars_rental: mmCarsRentalByLocation[location] || null
    };
  }

  return output;
}

function buildOutputPayload({ results, errors, locationBreakdown, locations, weekend }) {
  const cheapestByLocation = buildCheapestByLocation(results, locations);
  const cheapestOverall = results[0] || null;
  const top3ByLocation = buildTop3ByLocation(locationBreakdown, locations);
  const mmCarsRentalByLocation = buildMmCarsRentalByLocation(locationBreakdown, locations);
  const top3PlusMmByLocation = buildTop3PlusMmByLocation(top3ByLocation, mmCarsRentalByLocation, locations);

  return {
    generated_at: new Date().toISOString(),
    time_zone: weekend.timeZone,
    pickup_date: weekend.pickupIso,
    dropoff_date: weekend.dropoffIso,
    rental_days: weekend.rentalDays,
    results,
    errors,
    cheapest_by_location: cheapestByLocation,
    cheapest_overall: cheapestOverall,
    top_3_by_location: top3ByLocation,
    mm_cars_rental_by_location: mmCarsRentalByLocation,
    top_3_plus_mm_by_location: top3PlusMmByLocation
  };
}

function printCheapestSummary(payload) {
  console.log("Cheapest by location:");
  for (const [location, offer] of Object.entries(payload.cheapest_by_location)) {
    console.log(`${location}: ${stringifyOffer(offer)}`);
  }

  console.log("Cheapest overall:");
  console.log(stringifyOffer(payload.cheapest_overall));

  printTopThreePlusMmByLocation(payload.top_3_by_location, payload.mm_cars_rental_by_location);
  printTopThreeByLocation(payload.top_3_by_location);
  printMmCarsByLocation(payload.mm_cars_rental_by_location);
}

function formatOfferPrice(offer) {
  if (!offer || !Number.isFinite(offer.total_price)) {
    return "Not available";
  }

  return `${offer.total_price.toFixed(2)} ${offer.currency || ""}`.trim();
}

function buildCompactScenarioRows(top3PlusMmByLocation, locations) {
  const rows = [];

  for (const location of locations || Object.keys(top3PlusMmByLocation || {})) {
    const locationData = top3PlusMmByLocation?.[location] || {};
    const top3 = Array.isArray(locationData.top_3) ? locationData.top_3 : [];
    const mmOffer = locationData.mm_cars_rental || null;

    const top1 = top3[0] || null;
    const top2 = top3[1] || null;
    const top3Offer = top3[2] || null;

    const top1Name = top1?.provider_name || "Not available";
    const top2Name = top2?.provider_name || "Not available";
    const top3Name = top3Offer?.provider_name || "Not available";

    rows.push({
      location,
      top1_company: isMmCarsProvider(top1Name) ? highlightMmText(top1Name) : top1Name,
      top1_price: formatOfferPrice(top1),
      top2_company: isMmCarsProvider(top2Name) ? highlightMmText(top2Name) : top2Name,
      top2_price: formatOfferPrice(top2),
      top3_company: isMmCarsProvider(top3Name) ? highlightMmText(top3Name) : top3Name,
      top3_price: formatOfferPrice(top3Offer),
      mm_cars_rental_price: mmOffer
        ? highlightMmText(formatOfferPrice(mmOffer))
        : "Not available"
    });
  }

  return rows;
}

function printCompactScenarioTable(payload, locations) {
  const rows = buildCompactScenarioRows(payload.top_3_plus_mm_by_location || {}, locations);
  console.table(rows);
}

function printTopThreePlusMmByLocation(top3ByLocation, mmCarsByLocation) {
  const locationKeys = new Set([
    ...Object.keys(top3ByLocation || {}),
    ...Object.keys(mmCarsByLocation || {})
  ]);

  const rows = [...locationKeys].sort((a, b) => a.localeCompare(b)).map((location) => {
    const topOffers = Array.isArray(top3ByLocation?.[location]) ? top3ByLocation[location] : [];
    const mmOffer = mmCarsByLocation?.[location] || null;

    return {
      location,
      top1_company: topOffers[0]?.provider_name || "Not available",
      top1_price: formatOfferPrice(topOffers[0]),
      top2_company: topOffers[1]?.provider_name || "Not available",
      top2_price: formatOfferPrice(topOffers[1]),
      top3_company: topOffers[2]?.provider_name || "Not available",
      top3_price: formatOfferPrice(topOffers[2]),
      mm_cars_rental_price: formatOfferPrice(mmOffer)
    };
  });

  console.log("Top 3 companies + MM Cars Rental by location:");
  console.table(rows);
}

function printTopThreeByLocation(top3ByLocation) {
  const rows = [];

  for (const [location, offers] of Object.entries(top3ByLocation || {})) {
    const safeOffers = Array.isArray(offers) ? offers : [];
    for (let index = 0; index < 3; index += 1) {
      const offer = safeOffers[index] || null;
      rows.push({
        location,
        rank: index + 1,
        provider_name: offer?.provider_name || "Not available",
        total_price: offer ? Number(offer.total_price.toFixed(2)) : null,
        currency: offer?.currency || "",
        car_name: offer?.car_name || ""
      });
    }
  }

  console.log("Top 3 cheapest companies by location:");
  console.table(rows);
}

function printMmCarsByLocation(mmCarsByLocation) {
  const rows = Object.entries(mmCarsByLocation || {}).map(([location, offer]) => ({
    location,
    found: Boolean(offer),
    provider_name: offer?.provider_name || "Not available",
    total_price: offer ? Number(offer.total_price.toFixed(2)) : null,
    currency: offer?.currency || "",
    car_name: offer?.car_name || ""
  }));

  console.log("MM Cars Rental by location:");
  console.table(rows);
}

function stringifyOffer(offer) {
  if (!offer) {
    return "Not available";
  }

  return `${offer.location} | ${offer.provider_name} | ${offer.total_price.toFixed(2)} ${offer.currency} | ${
    offer.car_name || "n/a"
  }`;
}

function savePayloadToFile(payload, filePath) {
  const target = path.resolve(filePath);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
  return target;
}

module.exports = {
  buildOutputPayload,
  printCompactScenarioTable,
  printCheapestSummary,
  printErrorsTable,
  printResultsTable,
  savePayloadToFile
};
