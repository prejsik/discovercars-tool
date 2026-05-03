const crypto = require("crypto");
const path = require("path");
const { chromium } = require("playwright");
const { DiscoverCarsScraper } = require("./discovercars/scraper");
const {
  dedupeOffers,
  extractOffersFromDom,
  extractOffersFromPayload,
  normalizeWhitespace,
  sortOffersByPrice
} = require("./extractors");

const COOKIE_BUTTON_PATTERNS = [/accept all cookies/i, /accept all/i, /accept/i, /allow all/i, /agree/i];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpeedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fast" || normalized === "turbo") {
    return normalized;
  }
  return "safe";
}

function isFastMode(options) {
  return normalizeSpeedMode(options?.speedMode) !== "safe";
}

async function blockHeavyResources(context) {
  await context.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();
    if (resourceType === "image" || resourceType === "font" || resourceType === "media") {
      await route.abort().catch(() => {});
      return;
    }

    await route.continue().catch(() => {});
  });
}

function toDatePart(isoDateTime) {
  return String(isoDateTime).slice(0, 10);
}

function toTimePart(isoDateTime) {
  return String(isoDateTime).slice(11, 16);
}

function normalizeCountryCode(value) {
  const normalized = normalizeWhitespace(value).toUpperCase();
  if (/^[A-Z]{2}$/.test(normalized)) {
    return normalized;
  }

  const mapping = {
    POLAND: "PL",
    GERMANY: "DE",
    FRANCE: "FR",
    ITALY: "IT",
    SPAIN: "ES",
    PORTUGAL: "PT",
    "UNITED KINGDOM": "GB",
    UK: "GB",
    "UNITED STATES": "US",
    USA: "US"
  };

  return mapping[normalized] || "";
}

function encodeSqPayload(payload) {
  const json = JSON.stringify(payload);
  return encodeURIComponent(Buffer.from(json, "utf8").toString("base64"));
}

function buildDirectSearchUrl(origin, placeId, options) {
  const sqPayload = {
    PickupLocationId: placeId,
    DropOffLocationId: placeId,
    PickupDateTime: `${toDatePart(options.weekend.pickupIso)}T${toTimePart(options.weekend.pickupIso)}:00`,
    DropOffDateTime: `${toDatePart(options.weekend.dropoffIso)}T${toTimePart(options.weekend.dropoffIso)}:00`,
    ResidenceCountry: normalizeCountryCode(options.residenceCountry) || "PL",
    DriverAge: 30,
    Hash: ""
  };

  const sq = encodeSqPayload(sqPayload);
  const guid = crypto.randomUUID();
  return `${origin}/search/${guid}?sq=${sq}&searchVersion=2`;
}

function makeExtractionContext(location, options, sourceUrl) {
  return {
    location,
    currency: options.currency,
    pickup_date: options.weekend.pickupIso,
    dropoff_date: options.weekend.dropoffIso,
    rental_days: options.weekend.rentalDays,
    source_url: sourceUrl
  };
}

function dedupeLocationCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const placeId = String(candidate?.placeID || "").trim();
    if (!placeId || seen.has(placeId)) {
      continue;
    }
    seen.add(placeId);
    unique.push(candidate);
  }

  return unique;
}

function normalizeOutputOffer(offer, fallbackCurrency) {
  return {
    location: offer.location,
    provider_name: offer.provider_name,
    total_price: Number(offer.total_price),
    currency: offer.currency || fallbackCurrency || "PLN",
    pickup_date: offer.pickup_date,
    dropoff_date: offer.dropoff_date,
    rental_days: offer.rental_days,
    car_name: offer.car_name || null,
    source_url: offer.source_url
  };
}

function normalizeOutputOffers(offers, fallbackCurrency) {
  const normalized = [];
  for (const offer of offers || []) {
    const normalizedOffer = normalizeOutputOffer(offer, fallbackCurrency);
    if (!Number.isFinite(normalizedOffer.total_price)) {
      continue;
    }
    if (!normalizeWhitespace(normalizedOffer.provider_name)) {
      continue;
    }
    normalized.push(normalizedOffer);
  }

  return sortOffersByPrice(dedupeOffers(normalized));
}

function isMmCarsRental(providerName) {
  const normalized = normalizeWhitespace(providerName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");

  return normalized.includes("mm cars rental");
}

function reduceOffersToCheapestPerProvider(offers) {
  const cheapestByProvider = new Map();

  for (const offer of sortOffersByPrice(offers || [])) {
    const providerName = normalizeWhitespace(offer?.provider_name);
    if (!providerName) {
      continue;
    }

    const providerKey = providerName.toLowerCase();
    const existing = cheapestByProvider.get(providerKey);
    if (!existing || offer.total_price < existing.total_price) {
      cheapestByProvider.set(providerKey, offer);
    }
  }

  return sortOffersByPrice([...cheapestByProvider.values()]);
}

function buildLocationBreakdown(location, offers) {
  const sortedOffers = sortOffersByPrice(offers);
  const providerOffers = reduceOffersToCheapestPerProvider(sortedOffers);
  const top3Offers = providerOffers.slice(0, 3);
  const cheapestOffer = top3Offers[0] || null;
  const mmCarsOffer = providerOffers.find((offer) => isMmCarsRental(offer.provider_name)) || null;

  return {
    location,
    cheapest_offer: cheapestOffer,
    top_3_offers: top3Offers,
    mm_cars_rental_offer: mmCarsOffer
  };
}

async function searchCheapestOffers(options) {
  if (options.strategy === "legacy-batch") {
    return await runLegacyFallbackBatch(options);
  }

  const browser = await chromium.launch({
    headless: !options.headful
  });

  const results = [];
  const errors = [];
  const locationBreakdown = [];

  try {
    for (const location of options.locations) {
      try {
        let locationOffers = [];
        locationOffers = await runLocationWithStrategy(browser, location, options);

        if (!locationOffers.length) {
          throw new Error(`No offers available for location "${location}".`);
        }

        const breakdown = buildLocationBreakdown(location, locationOffers);
        locationBreakdown.push(breakdown);
        if (breakdown.cheapest_offer) {
          results.push(breakdown.cheapest_offer);
        }

        const top3String = breakdown.top_3_offers
          .map((offer) => `${offer.provider_name} ${offer.total_price.toFixed(2)} ${offer.currency}`)
          .join(" | ");
        const mmCarsString = breakdown.mm_cars_rental_offer
          ? `${breakdown.mm_cars_rental_offer.total_price.toFixed(2)} ${breakdown.mm_cars_rental_offer.currency}`
          : "N/A";

        options.logger.info(
          `[OK] ${location}: top3 => ${top3String}; MM Cars Rental => ${mmCarsString}`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({
          location,
          error: errorMessage
        });
        options.logger.error(`[ERROR] ${location}: ${errorMessage}`);
      }
    }
  } finally {
    await browser.close();
  }

  return {
    results: sortOffersByPrice(results),
    errors,
    locationBreakdown
  };
}

async function runLocationWithStrategy(browser, location, options) {
  const strategy = String(options.strategy || "hybrid").toLowerCase();

  if (strategy === "direct-only") {
    return await runLocationWithRetry(browser, location, options);
  }

  if (strategy === "hybrid") {
    try {
      return await runLocationWithRetry(browser, location, options);
    } catch (directFlowError) {
      options.logger.warn(
        `[${location}] direct API flow failed, switching to legacy fallback: ${
          directFlowError instanceof Error ? directFlowError.message : String(directFlowError)
        }`
      );
      return await runLegacyFallbackForLocation(location, options);
    }
  }

  return await runLegacyFallbackForLocation(location, options);
}

async function runLegacyFallbackBatch(options) {
  const scraper = new DiscoverCarsScraper({
    baseUrl: "https://www.discovercars.com",
    locations: options.locations,
    pickupDate: toDatePart(options.weekend.pickupIso),
    pickupTime: toTimePart(options.weekend.pickupIso),
    dropoffDate: toDatePart(options.weekend.dropoffIso),
    dropoffTime: toTimePart(options.weekend.dropoffIso),
    residenceCountry: options.residenceCountry || "Poland",
    currency: options.currency || "PLN",
    driverAge: 30,
    timeoutMs: options.timeoutMs,
    headless: !options.headful,
    locationConcurrency: options.locationConcurrency,
    directCandidateLimit: options.directCandidateLimit,
    directOffersWaitMs: options.directOffersWaitMs,
    speedMode: options.speedMode || "safe",
    browserExecutablePath: null,
    outputCsv: path.resolve("output", `discovercars-fallback-batch-${Date.now()}.csv`),
    artifactsDir: path.resolve("artifacts", "discovercars")
  });

  const execution = () => scraper.run();
  const fallbackOutput = options.quietLegacyLogs
    ? await runWithMutedConsoleLog(execution)
    : await execution();

  const offersByLocation = new Map();
  for (const location of options.locations) {
    offersByLocation.set(normalizeLocationKey(location), []);
  }

  for (const legacy of fallbackOutput.results || []) {
    const key = normalizeLocationKey(legacy.location);
    if (!offersByLocation.has(key)) {
      offersByLocation.set(key, []);
    }
    offersByLocation.get(key).push({
      location: legacy.location || "",
      provider_name: legacy.provider,
      total_price: Number(legacy.totalPrice),
      currency: legacy.currency || options.currency || "PLN",
      pickup_date: options.weekend.pickupIso,
      dropoff_date: options.weekend.dropoffIso,
      rental_days: options.weekend.rentalDays,
      car_name: legacy.carName || null,
      source_url: legacy.sourceUrl || "https://www.discovercars.com/"
    });
  }

  const failureByLocation = new Map(
    (fallbackOutput.failures || []).map((item) => [normalizeLocationKey(item.location), item.error])
  );

  const results = [];
  const errors = [];
  const locationBreakdown = [];

  for (const location of options.locations) {
    const key = normalizeLocationKey(location);
    const locationOffers = normalizeOutputOffers(offersByLocation.get(key) || [], options.currency);
    if (locationOffers.length) {
      const breakdown = buildLocationBreakdown(location, locationOffers);
      locationBreakdown.push(breakdown);
      if (breakdown.cheapest_offer) {
        results.push(breakdown.cheapest_offer);
      }

      const top3String = breakdown.top_3_offers
        .map((offer) => `${offer.provider_name} ${offer.total_price.toFixed(2)} ${offer.currency}`)
        .join(" | ");
      const mmCarsString = breakdown.mm_cars_rental_offer
        ? `${breakdown.mm_cars_rental_offer.total_price.toFixed(2)} ${breakdown.mm_cars_rental_offer.currency}`
        : "N/A";

      options.logger.info(
        `[OK] ${location}: top3 => ${top3String}; MM Cars Rental => ${mmCarsString}`
      );
      continue;
    }

    const reason = failureByLocation.get(key) || `No offers available for location "${location}".`;
    errors.push({
      location,
      error: reason
    });
    options.logger.error(`[ERROR] ${location}: ${reason}`);
  }

  return {
    results: sortOffersByPrice(results),
    errors,
    locationBreakdown
  };
}

async function runLegacyFallbackForLocation(location, options) {
  const scraper = new DiscoverCarsScraper({
    baseUrl: "https://www.discovercars.com",
    locations: [location],
    pickupDate: toDatePart(options.weekend.pickupIso),
    pickupTime: toTimePart(options.weekend.pickupIso),
    dropoffDate: toDatePart(options.weekend.dropoffIso),
    dropoffTime: toTimePart(options.weekend.dropoffIso),
    residenceCountry: options.residenceCountry || "Poland",
    currency: options.currency || "PLN",
    driverAge: 30,
    timeoutMs: options.timeoutMs,
    headless: !options.headful,
    locationConcurrency: options.locationConcurrency,
    directCandidateLimit: options.directCandidateLimit,
    directOffersWaitMs: options.directOffersWaitMs,
    speedMode: options.speedMode || "safe",
    browserExecutablePath: null,
    outputCsv: path.resolve("output", `discovercars-fallback-${Date.now()}.csv`),
    artifactsDir: path.resolve("artifacts", "discovercars")
  });

  const execution = () => scraper.run();
  const fallbackOutput = options.quietLegacyLogs
    ? await runWithMutedConsoleLog(execution)
    : await execution();

  if (!fallbackOutput.results?.length) {
    const reason =
      fallbackOutput.failures?.[0]?.error ||
      "Legacy fallback failed to produce any offer.";
    throw new Error(reason);
  }

  const legacyOffers = fallbackOutput.results
    .map((legacy) => ({
      location: legacy.location || location,
      provider_name: legacy.provider,
      total_price: Number(legacy.totalPrice),
      currency: legacy.currency || options.currency || "PLN",
      pickup_date: options.weekend.pickupIso,
      dropoff_date: options.weekend.dropoffIso,
      rental_days: options.weekend.rentalDays,
      car_name: legacy.carName || null,
      source_url: legacy.sourceUrl || "https://www.discovercars.com/"
    }))
    .filter((offer) => Number.isFinite(offer.total_price));

  return normalizeOutputOffers(legacyOffers, options.currency);
}

function normalizeLocationKey(value) {
  return normalizeWhitespace(value).toLowerCase();
}

let mutedConsoleLogDepth = 0;
let originalConsoleLog = null;

async function runWithMutedConsoleLog(action) {
  if (mutedConsoleLogDepth === 0) {
    originalConsoleLog = console.log;
    console.log = () => {};
  }
  mutedConsoleLogDepth += 1;

  try {
    return await action();
  } finally {
    mutedConsoleLogDepth -= 1;
    if (mutedConsoleLogDepth === 0 && originalConsoleLog) {
      console.log = originalConsoleLog;
      originalConsoleLog = null;
    }
  }
}

async function runLocationWithRetry(browser, location, options) {
  let lastError = new Error("Unknown scraping error.");

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    try {
      options.logger.info(`[${location}] attempt ${attempt}/${options.retries}`);
      return await scrapeLocationOnce(browser, location, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      options.logger.warn(`[${location}] attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < options.retries) {
        await sleep(1000 * attempt);
      }
    }
  }

  throw new Error(`Failed after ${options.retries} attempt(s): ${lastError.message}`);
}

async function scrapeLocationOnce(browser, location, options) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    locale: "en-GB",
    timezoneId: options.weekend.timeZone
  });

  if (isFastMode(options)) {
    await blockHeavyResources(context);
  }

  await context
    .addCookies([
      {
        name: "currency",
        value: options.currency || "PLN",
        url: "https://www.discovercars.com"
      }
    ])
    .catch(() => {});

  const page = await context.newPage();
  page.setDefaultTimeout(options.timeoutMs);
  page.setDefaultNavigationTimeout(options.timeoutMs);

  const collectedOffers = [];
  const responseHandler = async (response) => {
    await tryExtractOffersFromResponse(response, collectedOffers, location, options);
  };
  page.on("response", responseHandler);

  try {
    const baseOrigin = "https://www.discovercars.com";
    if (!isFastMode(options)) {
      await page.goto(baseOrigin, { waitUntil: "domcontentloaded" });
      await acceptCookies(page);
    }

    const candidates = await resolveLocationCandidates(page, location);
    if (!candidates.length) {
      throw new Error("No location candidates found in DiscoverCars autocomplete API.");
    }

    for (const candidate of candidates.slice(0, 1)) {
      const searchUrl = buildDirectSearchUrl(baseOrigin, candidate.placeID, options);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
      await waitForResults(page, Math.min(options.timeoutMs, 20_000), options);
      await waitForCollectorOffers(collectedOffers, 6_000);

      const sourceUrl = page.url();
      const extractionContext = makeExtractionContext(location, options, sourceUrl);

      const offersFromNetwork = sortOffersByPrice(
        dedupeOffers(
          collectedOffers.map((offer) => ({
            ...offer,
            source_url: sourceUrl || offer.source_url
          }))
        )
      );

      const offersFromDom = await extractOffersFromDom(page, extractionContext).catch(() => []);
      const offersFromScripts = await extractOffersFromPageScripts(page, extractionContext).catch(() => []);

      const offers = sortOffersByPrice(
        dedupeOffers([...offersFromNetwork, ...offersFromDom, ...offersFromScripts])
      );

      if (offers.length) {
        const normalizedOffers = normalizeOutputOffers(
          offers.map((offer) => ({
            ...offer,
            source_url: sourceUrl || offer.source_url
          })),
          options.currency
        );
        if (normalizedOffers.length) {
          return normalizedOffers;
        }
      }
    }

    throw new Error("No offers extracted from direct search flow (network and DOM fallback failed).");
  } finally {
    page.off("response", responseHandler);
    await context.close();
  }
}

async function resolveLocationCandidates(page, location) {
  const endpoint = `https://www.discovercars.com/api/v2/autocomplete?location=${encodeURIComponent(location)}`;
  const response = await page.request.get(endpoint).catch(() => null);
  if (!response || !response.ok()) {
    return [];
  }

  const payload = await response.json().catch(() => null);
  const rawCandidates = Array.isArray(payload?.result) ? payload.result : [];
  if (!rawCandidates.length) {
    return [];
  }

  const normalizedLocation = normalizeWhitespace(location).toLowerCase();
  const allLocations = rawCandidates.filter((item) => /all locations/i.test(String(item.place || "")));
  const cityMatches = rawCandidates.filter((item) =>
    normalizeWhitespace(item.city).toLowerCase().includes(normalizedLocation)
  );
  const exactMatches = rawCandidates.filter((item) =>
    normalizeWhitespace(item.place).toLowerCase().includes(normalizedLocation)
  );

  return dedupeLocationCandidates([...allLocations, ...cityMatches, ...exactMatches, ...rawCandidates]);
}

async function tryExtractOffersFromResponse(response, collectedOffers, location, options) {
  const responseUrl = response.url();
  if (!/discovercars/i.test(responseUrl)) {
    return;
  }

  const contentType = String(response.headers()["content-type"] || "").toLowerCase();
  if (!/json|javascript|text\/plain/.test(contentType)) {
    return;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    const rawText = await response.text().catch(() => "");
    payload = parseJsonFromText(rawText);
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  const context = makeExtractionContext(location, options, responseUrl);
  const offers = extractOffersFromPayload(payload, context);
  if (offers.length) {
    collectedOffers.push(...offers);
  }
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const candidates = [raw, raw.replace(/^\)\]\}',?\s*/, "")];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  return null;
}

async function extractOffersFromPageScripts(page, context) {
  const html = await page.content().catch(() => "");
  if (!html) {
    return [];
  }

  const offers = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) != null) {
    const content = match[1];
    const possibleJsonBlocks = content.match(/\{[\s\S]{80,}\}/g) || [];
    for (const block of possibleJsonBlocks) {
      try {
        const parsed = JSON.parse(block);
        offers.push(...extractOffersFromPayload(parsed, context));
      } catch {
        continue;
      }
    }
  }

  return sortOffersByPrice(dedupeOffers(offers));
}

async function waitForCollectorOffers(collectedOffers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (collectedOffers.length > 0) {
      return;
    }
    await sleep(250);
  }
}

async function waitForResults(page, timeoutMs, options = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  const speedMode = normalizeSpeedMode(options.speedMode);
  const effectiveTimeoutMs =
    speedMode === "turbo"
      ? Math.min(timeoutMs, 10_000)
      : speedMode === "fast"
        ? Math.min(timeoutMs, 14_000)
        : timeoutMs;
  const networkIdleTimeoutMs = speedMode === "turbo" ? 1_500 : speedMode === "fast" ? 2_500 : 6_000;
  const settleMs = speedMode === "turbo" ? 250 : speedMode === "fast" ? 400 : 700;
  const pollMs = speedMode === "turbo" ? 200 : speedMode === "fast" ? 250 : 350;
  const deadline = Date.now() + effectiveTimeoutMs;

  while (Date.now() < deadline) {
    const signals = [
      page.getByText(/sort by/i).first(),
      page.getByText(/free cancellation/i).first(),
      page.getByText(/very good/i).first(),
      page.locator("article").first(),
      page.locator("[data-testid*='offer']").first(),
      page.locator("[class*='offer']").first(),
      page.locator("[class*='result']").first()
    ];

    for (const signal of signals) {
      if (await signal.isVisible().catch(() => false)) {
        await page.waitForTimeout(settleMs);
        return;
      }
    }

    await page.waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs }).catch(() => {});
    await page.waitForTimeout(pollMs);
  }
}

async function acceptCookies(page) {
  const selectors = [
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#onetrust-accept-btn-handler",
    "button#onetrust-accept-btn-handler",
    "[data-testid='cookie-accept-all']"
  ];

  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click({ timeout: 2_500, force: true }).catch(() => {});
      }
    }

    for (const pattern of COOKIE_BUTTON_PATTERNS) {
      const button = page.getByRole("button", { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 2_500, force: true }).catch(() => {});
      }
    }

    const stillVisible = await page.locator("#onetrust-banner-sdk").first().isVisible().catch(() => false);
    if (!stillVisible) {
      return;
    }

    await page.waitForTimeout(200);
  }
}

module.exports = {
  searchCheapestOffers
};
