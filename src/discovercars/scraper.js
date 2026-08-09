const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const {
  ensureDir,
  formatMoney,
  normalizeWhitespace,
  parseDate,
  parseMoney,
  safeFilePart,
  toAccessibleDateLabels,
  writeTextFile
} = require("./utils");
const {
  filterOffersByTransmission,
  findTransmissionInCandidate,
  normalizeTransmission,
  normalizeTransmissionFilter
} = require("../extractors");

const COOKIE_BUTTON_PATTERNS = [
  /accept all/i,
  /accept/i,
  /allow all/i,
  /agree/i,
  /got it/i,
  /continue/i,
  /understand/i
];

const SEARCH_BUTTON_PATTERNS = [/search now/i, /^search$/i, /show cars/i, /find cars/i];
const PICKUP_VALIDATION_ERROR_PATTERN = /pick-?up location/i;
const IGNORED_API_PROVIDER_PATTERNS = [
  /^discover\s*cars\s*choice$/i,
  /^discovercars\s*choice$/i
];
const DEFAULT_API_DOM_SANITY_RATE = 0.05;
const DEFAULT_API_DOM_DRIFT_MIN_COMPARISONS = 20;
const DEFAULT_API_DOM_MEDIUM_DRIFT_RATE = 0.1;
const DEFAULT_API_DOM_HIGH_DRIFT_RATE = 0.25;
const DEFAULT_API_DOM_MEDIUM_SAMPLE_RATE = 0.1;
const DEFAULT_API_DOM_HIGH_SAMPLE_RATE = 0.2;
const DEFAULT_API_DOM_MAX_VALIDATIONS_PER_LOCATION = 50;
const DEFAULT_API_TIMEOUT_MS = 20_000;
const DEFAULT_GEO_LOCATION_OVERRIDES = Object.freeze({
  "galeria krakowska shopping mall": Object.freeze({
    latitude: 50.0662682,
    longitude: 19.9461205,
    radiusMeters: 20_000,
    geoLocationName: "Pawia 5, 31-154 Krakow, Poland"
  })
});
const SHARED_LOCATION_CANDIDATE_CACHE = new Map();
const SHARED_API_DOM_DRIFT_STATE = {
  by_location: {}
};

function createSharedBrowserProvider(launchBrowser = (options) => chromium.launch(options)) {
  let browserPromise = null;
  const provider = {
    async getBrowser(launchOptions = {}) {
      if (!browserPromise) {
        browserPromise = Promise.resolve()
          .then(() => launchBrowser(launchOptions))
          .catch((error) => {
            browserPromise = null;
            throw error;
          });
      }

      const currentPromise = browserPromise;
      const browser = await currentPromise;
      if (typeof browser.isConnected === "function" && !browser.isConnected()) {
        if (browserPromise === currentPromise) {
          browserPromise = null;
        }
        return await provider.getBrowser(launchOptions);
      }
      return browser;
    },
    async close() {
      const current = browserPromise;
      browserPromise = null;
      if (!current) {
        return;
      }
      const browser = await current.catch(() => null);
      if (browser) {
        await browser.close();
      }
    }
  };
  return provider;
}

function clampPositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function normalizeSpeedMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fast" || normalized === "turbo") {
    return normalized;
  }
  return "safe";
}

class DiscoverCarsScraper {
  constructor(config) {
    this.config = config;
    this.locationCandidateCache = config.locationCandidateCache || SHARED_LOCATION_CANDIDATE_CACHE;
    this.apiDomDriftState = config.apiDomDriftState || SHARED_API_DOM_DRIFT_STATE;
    this.apiDomTelemetry = {
      api_attempt_count: 0,
      api_success_count: 0,
      api_failure_count: 0,
      dom_validation_count: 0,
      dom_success_count: 0,
      dom_failure_count: 0,
      mandatory_recommendation_validation_count: 0,
      comparison_count: 0,
      drift_count: 0,
      browser_preferred_count: 0,
      fallback_count: 0,
      quick_result_signal_count: 0,
      full_result_wait_count: 0,
      adaptive_validation_triggered: false,
      reason_counts: {},
      by_location: {}
    };
  }

  async run() {
    ensureDir(this.config.artifactsDir);
    const sharedBrowserProvider = this.config.browserProvider || null;
    let ownedBrowserPromise = null;
    const getBrowser = async () => {
      if (sharedBrowserProvider) {
        return await sharedBrowserProvider.getBrowser(this.resolveLaunchOptions());
      }
      if (!ownedBrowserPromise) {
        ownedBrowserPromise = chromium.launch(this.resolveLaunchOptions());
      }
      return await ownedBrowserPromise;
    };

    const results = [];
    const failures = [];
    const offerViewsByLocation = {};
    const sourceValidationByLocation = {};
    const locations = Array.isArray(this.config.locations) ? [...this.config.locations] : [];
    const workerCount = clampPositiveInteger(this.config.locationConcurrency, 1, 1, 6);
    const boundedWorkers = Math.max(1, Math.min(workerCount, locations.length || 1));
    const outcomes = new Array(locations.length);

    try {
      let nextIndex = 0;
      const workers = Array.from({ length: boundedWorkers }, async () => {
        while (true) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          if (currentIndex >= locations.length) {
            return;
          }

          const location = locations[currentIndex];
          outcomes[currentIndex] = await this.runSingleLocation(location, getBrowser);
        }
      });

      await Promise.all(workers);

      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        const outcome = outcomes[index];
        if (!outcome) {
          failures.push({ location, error: "Unknown scraper failure." });
          console.log(`ERR ${location} -> Unknown scraper failure.`);
          continue;
        }

        if (outcome.ok) {
          results.push(...outcome.results);
          offerViewsByLocation[location] = outcome.offerViews || null;
          sourceValidationByLocation[location] = outcome.sourceValidation || { status: "api_unverified", reasons: [] };
          console.log(
            `OK  ${location} -> ${outcome.cheapest.provider} -> ${formatMoney(outcome.cheapest.totalPrice, outcome.cheapest.currency)}`
          );
          continue;
        }

        failures.push({ location, error: outcome.error.message });
        console.log(`ERR ${location} -> ${outcome.error.message}`);
      }
    } finally {
      if (ownedBrowserPromise) {
        await (await ownedBrowserPromise).close();
      }
    }

    return { results, failures, offerViewsByLocation, sourceValidationByLocation, telemetry: this.buildApiDomTelemetrySummary() };
  }

  resolveLaunchOptions() {
    const executablePath = firstExistingPath([
      this.config.browserExecutablePath,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ]);

    const options = {
      headless: this.config.headless
    };

    if (executablePath) {
      options.executablePath = executablePath;
    }

    return options;
  }

  async runSingleLocation(location, getBrowser) {
    if (this.isApiFirstEnabled()) {
      let apiOutcome = null;
      this.apiDomTelemetry.api_attempt_count += 1;
      try {
        apiOutcome = await this.runSingleLocationViaApi(location);
        this.apiDomTelemetry.api_success_count += 1;
        if (!this.shouldValidateApiOutcome(location, apiOutcome.results)) {
          return { ...apiOutcome, sourceValidation: { status: "api_unverified", reasons: [] } };
        }
      } catch (apiError) {
        this.apiDomTelemetry.api_failure_count += 1;
        apiOutcome = {
          ok: false,
          error: apiError instanceof Error ? apiError : new Error(String(apiError))
        };
      }

      const browser = await getBrowser();
      this.apiDomTelemetry.dom_validation_count += 1;
      this.recordDomValidation(location);
      const browserOutcome = await this.runSingleLocationWithBrowser(browser, location);
      if (browserOutcome.ok) {
        this.apiDomTelemetry.dom_success_count += 1;
      } else {
        this.apiDomTelemetry.dom_failure_count += 1;
      }
      if (!apiOutcome.ok) {
        if (browserOutcome.ok) {
          this.apiDomTelemetry.fallback_count += 1;
          return { ...browserOutcome, sourceValidation: { status: "dom_fallback", reasons: ["api_failure"] } };
        }
        return browserOutcome;
      }
      if (browserOutcome.ok) {
        const comparison = this.compareApiAndBrowserOutcomes(apiOutcome.results, browserOutcome.results);
        this.recordApiDomComparison(location, comparison);
        if (comparison.preferBrowser) {
          this.apiDomTelemetry.browser_preferred_count += 1;
          return { ...browserOutcome, sourceValidation: { status: "api_dom_conflict_dom_used", reasons: comparison.reasons } };
        }
        return {
          ...apiOutcome,
          sourceValidation: {
            status: comparison.reasons.length ? "api_dom_conflict_api_used" : "dom_confirmed",
            reasons: comparison.reasons
          }
        };
      }
      return { ...apiOutcome, sourceValidation: { status: "dom_validation_failed_api_used", reasons: ["dom_failure"] } };
    }

    const browser = await getBrowser();
    const outcome = await this.runSingleLocationWithBrowser(browser, location);
    return outcome.ok ? { ...outcome, sourceValidation: { status: "dom_only", reasons: [] } } : outcome;
  }

  async runSingleLocationWithBrowser(browser, location) {
    let context = null;
    let page = null;

    try {
      context = await browser.newContext({
        viewport: { width: 1440, height: 1200 },
        locale: "en-US"
      });
      await this.configureContext(context);

      page = await context.newPage();
      page.setDefaultTimeout(this.config.timeoutMs);
      page.setDefaultNavigationTimeout(this.config.timeoutMs);

      const responseCollector = this.createResponseCollector();
      page.on("response", async (response) => {
        await this.captureResponseOffers(responseCollector, response, location);
      });

      let homepagePrepared = false;
      if (!this.isFastMode()) {
        await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
        await this.acceptCookies(page);
        homepagePrepared = true;
      }

      let allOffers = await this.tryDirectSearchFlow(page, location, responseCollector);
      let offers = this.filterOffersByConfiguredTransmission(allOffers);

      if (!offers.length) {
        if (!homepagePrepared) {
          await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded" });
          await this.acceptCookies(page);
          homepagePrepared = true;
        }

        await this.fillSearchForm(page, location);
        await this.submitSearch(page);
        await this.ensureConfiguredSearchPeriod(page);
        await this.waitForResults(page, { collector: responseCollector });
        const fallbackCollectorWaitMs = normalizeTransmissionFilter(this.config.transmissionFilter) ? 1000 : 20000;
        await this.waitForCollectorOffers(responseCollector, fallbackCollectorWaitMs);

        if (normalizeTransmissionFilter(this.config.transmissionFilter)) {
          allOffers = await this.extractOffersFromDomWithScroll(page, location);
          offers = this.filterOffersByConfiguredTransmission(allOffers);
          if (!offers.length) {
            allOffers = await this.extractOffersFromPageScripts(page, location);
            offers = this.filterOffersByConfiguredTransmission(allOffers);
          }
          if (!offers.length) {
            allOffers = responseCollector.getOffers();
            offers = this.filterOffersByConfiguredTransmission(allOffers);
          }
        } else {
          allOffers = responseCollector.getOffers();
          offers = this.filterOffersByConfiguredTransmission(allOffers);
          if (!offers.length) {
            allOffers = await this.extractOffersFromPageScripts(page, location);
            offers = this.filterOffersByConfiguredTransmission(allOffers);
          }
          if (!offers.length) {
            allOffers = await this.extractOffersFromDomWithScroll(page, location);
            offers = this.filterOffersByConfiguredTransmission(allOffers);
          }
        }
      }
      if (!offers.length) {
        throw new Error("No automatic offers could be extracted from the results page.");
      }

      const locationOffers = selectBestOffersByProvider(
        offers,
        location,
        this.config.maxProvidersPerLocation,
        ["MM Cars Rental"]
      );
      if (!locationOffers.length) {
        throw new Error("No valid offers with provider and price were extracted.");
      }

      const cheapest = locationOffers[0];
      return {
        ok: true,
        cheapest,
        results: locationOffers,
        offerViews: this.buildOfferViews(allOffers, location)
      };
    } catch (error) {
      if (page) {
        await this.captureFailureArtifacts(page, location);
      }
      return { ok: false, error };
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  isApiFirstEnabled() {
    return this.config.apiFirst !== false;
  }

  shouldValidateApiOutcome(location, offers) {
    const selectedOffers = Array.isArray(offers) ? offers : [];
    if (!selectedOffers.length) {
      return true;
    }
    if (this.isPotentialPricingRecommendation(selectedOffers)) {
      this.apiDomTelemetry.mandatory_recommendation_validation_count += 1;
      return true;
    }
    const locationState = this.getLocationDriftState(location);
    const maxValidations = clampPositiveInteger(
      this.config.apiDomMaxValidationsPerLocation,
      DEFAULT_API_DOM_MAX_VALIDATIONS_PER_LOCATION,
      1,
      500
    );
    if (locationState.validation_count >= maxValidations) {
      return false;
    }
    const sanityRate = Math.max(
      this.getLocationValidationRate(location),
      selectedOffers.length < 3 ? HIGH_DRIFT_API_DOM_SANITY_RATE : 0
    );
    if (sanityRate <= 0) {
      return false;
    }
    return deterministicSample(location, this.config.pickupDate, this.config.dropoffDate, sanityRate);
  }

  isPotentialPricingRecommendation(offers) {
    const sorted = [...(offers || [])].sort((left, right) => Number(left.totalPrice) - Number(right.totalPrice));
    const mmIndex = sorted.findIndex((offer) => isMmCarsRentalProvider(offer.provider));
    if (mmIndex < 0) return false;
    const days = daysBetweenIso(this.config.pickupDate, this.config.dropoffDate);
    const daily = (offer) => Number(offer?.totalPrice) / days;
    const mmRate = daily(sorted[mmIndex]);
    if (!Number.isFinite(mmRate)) return false;
    if (mmIndex === 0) {
      const top2Rate = daily(sorted[1]);
      return Number.isFinite(top2Rate) && top2Rate - mmRate >= 10;
    }
    const competitorIndex = mmIndex === 1 ? 0 : Math.min(mmIndex - 1, 2);
    const competitorRate = daily(sorted[competitorIndex]);
    const decrease = mmRate - competitorRate + 1;
    return Number.isFinite(decrease) && decrease >= 0.5 && decrease < 10;
  }

  shouldPreferBrowserOutcome(apiOffers, browserOffers) {
    return this.compareApiAndBrowserOutcomes(apiOffers, browserOffers).preferBrowser;
  }

  compareApiAndBrowserOutcomes(apiOffers, browserOffers) {
    const apiList = Array.isArray(apiOffers) ? apiOffers : [];
    const browserList = Array.isArray(browserOffers) ? browserOffers : [];
    if (!apiList.length) {
      return { preferBrowser: browserList.length > 0, reasons: browserList.length ? ["api_empty"] : [] };
    }
    if (!browserList.length) {
      return { preferBrowser: false, reasons: [] };
    }

    const reasons = [];
    const apiSorted = [...apiList].sort((left, right) => Number(left.totalPrice) - Number(right.totalPrice));
    const browserSorted = [...browserList].sort((left, right) => Number(left.totalPrice) - Number(right.totalPrice));
    const apiTop1 = apiSorted[0] || null;
    const browserTop1 = browserSorted[0] || null;
    const apiMm = apiList.find((offer) => isMmCarsRentalProvider(offer.provider)) || null;
    const browserMm = browserList.find((offer) => isMmCarsRentalProvider(offer.provider)) || null;
    let preferBrowser = false;

    if (Boolean(apiMm) !== Boolean(browserMm)) {
      reasons.push(apiMm ? "mm_missing_in_dom" : "mm_missing_in_api");
      preferBrowser = !apiMm && Boolean(browserMm);
    }
    if (apiTop1 && browserTop1 && normalizeProviderForComparison(apiTop1.provider) !== normalizeProviderForComparison(browserTop1.provider)) {
      reasons.push("top1_provider_mismatch");
      preferBrowser ||= browserList.length >= 3;
    }

    const compareMatchedPrice = (apiOffer, browserOffer, label, absoluteTolerance, percentTolerance) => {
      if (!apiOffer || !browserOffer) return;
      if (normalizeProviderForComparison(apiOffer.provider) !== normalizeProviderForComparison(browserOffer.provider)) return;
      if (String(apiOffer.currency || "").toUpperCase() !== String(browserOffer.currency || "").toUpperCase()) {
        reasons.push(`${label}_currency_mismatch`);
        preferBrowser = true;
        return;
      }
      const days = Math.max(1, Number(this.config.rentalDays) || daysBetweenIso(this.config.pickupDate, this.config.dropoffDate));
      const apiDaily = Number(apiOffer.totalPrice) / days;
      const browserDaily = Number(browserOffer.totalPrice) / days;
      const tolerance = Math.max(absoluteTolerance, Math.abs(browserDaily) * percentTolerance);
      if (Number.isFinite(apiDaily) && Number.isFinite(browserDaily) && Math.abs(apiDaily - browserDaily) > tolerance) {
        reasons.push(`${label}_price_mismatch`);
        preferBrowser = true;
      }
    };

    compareMatchedPrice(apiTop1, browserTop1, "top1", 5, 0.05);
    compareMatchedPrice(apiMm, browserMm, "mm", 3, 0.03);
    return { preferBrowser, reasons: [...new Set(reasons)] };
  }

  getLocationDriftState(location) {
    if (!this.apiDomDriftState.by_location) this.apiDomDriftState.by_location = {};
    const key = normalizeWhitespace(location).toLowerCase();
    if (!this.apiDomDriftState.by_location[key]) {
      this.apiDomDriftState.by_location[key] = { comparison_count: 0, drift_count: 0, validation_count: 0, reason_counts: {} };
    }
    return this.apiDomDriftState.by_location[key];
  }

  getLocationValidationRate(location) {
    const state = this.getLocationDriftState(location);
    const baseRate = clampNumber(this.config.apiDomSanityRate, DEFAULT_API_DOM_SANITY_RATE, 0, 1);
    const minComparisons = clampPositiveInteger(this.config.apiDomDriftMinComparisons, DEFAULT_API_DOM_DRIFT_MIN_COMPARISONS, 1, 200);
    if (state.comparison_count < minComparisons) return baseRate;
    const driftRate = state.comparison_count ? state.drift_count / state.comparison_count : 0;
    if (driftRate >= DEFAULT_API_DOM_HIGH_DRIFT_RATE) {
      this.apiDomTelemetry.adaptive_validation_triggered = true;
      return Math.max(baseRate, DEFAULT_API_DOM_HIGH_SAMPLE_RATE);
    }
    if (driftRate >= DEFAULT_API_DOM_MEDIUM_DRIFT_RATE) {
      this.apiDomTelemetry.adaptive_validation_triggered = true;
      return Math.max(baseRate, DEFAULT_API_DOM_MEDIUM_SAMPLE_RATE);
    }
    return baseRate;
  }

  recordDomValidation(location) {
    const state = this.getLocationDriftState(location);
    state.validation_count += 1;
    const local = this.getLocalLocationTelemetry(location);
    local.validation_count += 1;
  }

  recordApiDomComparison(location, comparison) {
    const isDrift = Boolean(comparison?.reasons?.length);
    const state = this.getLocationDriftState(location);
    const local = this.getLocalLocationTelemetry(location);
    this.apiDomTelemetry.comparison_count += 1;
    state.comparison_count += 1;
    local.comparison_count += 1;
    if (isDrift) {
      this.apiDomTelemetry.drift_count += 1;
      state.drift_count += 1;
      local.drift_count += 1;
    }
    for (const reason of comparison?.reasons || []) {
      this.apiDomTelemetry.reason_counts[reason] = (this.apiDomTelemetry.reason_counts[reason] || 0) + 1;
      state.reason_counts[reason] = (state.reason_counts[reason] || 0) + 1;
      local.reason_counts[reason] = (local.reason_counts[reason] || 0) + 1;
    }
  }

  getLocalLocationTelemetry(location) {
    const key = normalizeWhitespace(location);
    if (!this.apiDomTelemetry.by_location[key]) {
      this.apiDomTelemetry.by_location[key] = { comparison_count: 0, drift_count: 0, validation_count: 0, reason_counts: {} };
    }
    return this.apiDomTelemetry.by_location[key];
  }

  buildApiDomTelemetrySummary() {
    const comparisons = this.apiDomTelemetry.comparison_count;
    const byLocation = {};
    for (const [location, state] of Object.entries(this.apiDomTelemetry.by_location || {})) {
      byLocation[location] = {
        ...state,
        drift_rate_percent: state.comparison_count ? Number((state.drift_count / state.comparison_count * 100).toFixed(2)) : 0,
        current_validation_rate: this.getLocationValidationRate(location)
      };
    }
    return {
      ...this.apiDomTelemetry,
      by_location: byLocation,
      configured_validation_rate: clampNumber(this.config.apiDomSanityRate, DEFAULT_API_DOM_SANITY_RATE, 0, 1),
      drift_rate_percent: comparisons
        ? Number((this.apiDomTelemetry.drift_count / comparisons * 100).toFixed(2))
        : 0
    };
  }

  async runSingleLocationViaApi(location) {
    const geoLocation = resolveGeoLocationOverride(location, this.config.geoLocationOverrides);
    if (geoLocation) {
      const search = await this.createGeoSearch(geoLocation);
      const payload = await fetchJson(
        search.apiUrl,
        this.getApiTimeoutMs(),
        this.config.currency
      );
      return this.buildApiOutcome(payload, location, search.apiUrl);
    }

    const candidates = await this.resolveLocationCandidatesViaApi(location);
    if (!candidates.length) {
      throw new Error("No location candidates found in DiscoverCars autocomplete API.");
    }

    const baseUrl = new URL(this.config.baseUrl);
    const directCandidateLimit = clampPositiveInteger(this.config.directCandidateLimit, 2, 1, 8);
    const uniqueCandidates = dedupeLocationCandidates(candidates).slice(0, directCandidateLimit);

    for (const candidate of uniqueCandidates) {
      const searchUrl = this.buildDirectSearchApiUrl(baseUrl.origin, candidate.placeID);
      const payload = await fetchJson(searchUrl, this.getApiTimeoutMs(), this.config.currency);
      try {
        return this.buildApiOutcome(payload, location, searchUrl);
      } catch {
        continue;
      }
    }

    throw new Error("No automatic offers extracted from DiscoverCars search API.");
  }

  buildApiOutcome(payload, location, sourceUrl) {
    if (!searchApiPayloadMatchesPeriod(payload, this.config)) {
      throw new Error("DiscoverCars search API returned offers for an unexpected rental period.");
    }

    const allApiOffers = extractOffersFromSearchApiPayload(payload, location, sourceUrl);
    const apiOffers = this.filterOffersByConfiguredTransmission(allApiOffers);
    const locationOffers = selectBestOffersByProvider(
      apiOffers,
      location,
      this.config.maxProvidersPerLocation,
      ["MM Cars Rental"]
    );
    if (!locationOffers.length) {
      throw new Error("No automatic offers extracted from DiscoverCars search API.");
    }
    return {
      ok: true,
      cheapest: locationOffers[0],
      results: locationOffers,
      offerViews: this.buildOfferViews(allApiOffers, location)
    };
  }

  buildOfferViews(offers, location) {
    const allOffers = Array.isArray(offers) ? offers.filter(Boolean) : [];
    const automaticOffers = filterOffersByTransmission(allOffers, "automatic");
    return {
      automatic: automaticOffers,
      all: allOffers,
      location
    };
  }

  getApiTimeoutMs() {
    const pageTimeoutMs = clampPositiveInteger(this.config.timeoutMs, 45_000, 5_000, 180_000);
    return clampPositiveInteger(
      this.config.apiTimeoutMs,
      Math.min(pageTimeoutMs, DEFAULT_API_TIMEOUT_MS),
      5_000,
      60_000
    );
  }

  async createGeoSearch(geoLocation) {
    const origin = new URL(this.config.baseUrl).origin;
    const createUrl = `${origin}/api/v2/search/create-search?`;
    const created = await fetchJson(
      createUrl,
      this.getApiTimeoutMs(),
      this.config.currency,
      2,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildGeoSearchPayload(this.config, geoLocation))
      }
    );
    const guid = normalizeWhitespace(created?.data?.guid);
    const sq = normalizeWhitespace(created?.data?.sq);
    if (!created?.success || !guid || !sq) {
      throw new Error("DiscoverCars geo search could not be created.");
    }

    return {
      apiUrl: `${origin}/api/v2/search/${guid}?sq=${encodeURIComponent(sq)}&searchVersion=2`,
      pageUrl: new URL(created.data.url || `/search/${guid}?sq=${encodeURIComponent(sq)}&searchVersion=2`, origin).toString()
    };
  }

  isFastMode() {
    return normalizeSpeedMode(this.config.speedMode) !== "safe";
  }

  async configureContext(context) {
    if (this.config.currency) {
      await context
        .addCookies([
          {
            name: "currency",
            value: this.config.currency,
            url: this.config.baseUrl
          }
        ])
        .catch(() => {});
    }

    if (!this.isFastMode()) {
      return;
    }

    await context.route("**/*", async (route) => {
      const resourceType = route.request().resourceType();
      if (resourceType === "image" || resourceType === "font" || resourceType === "media") {
        await route.abort().catch(() => {});
        return;
      }

      await route.continue().catch(() => {});
    });
  }

  async tryDirectSearchFlow(page, location, collector) {
    const geoLocation = resolveGeoLocationOverride(location, this.config.geoLocationOverrides);
    if (geoLocation) {
      return await this.tryDirectGeoSearchFlow(page, location, collector, geoLocation);
    }

    const candidates = await this.resolveLocationCandidates(page, location);
    if (!candidates.length) {
      return [];
    }

    const baseUrl = new URL(this.config.baseUrl);
    const directCandidateLimit = clampPositiveInteger(this.config.directCandidateLimit, 2, 1, 8);
    const directOffersWaitMs = clampPositiveInteger(this.config.directOffersWaitMs, 6000, 1000, 20000);
    const uniqueCandidates = dedupeLocationCandidates(candidates).slice(0, directCandidateLimit);
    const transmissionFilter = normalizeTransmissionFilter(this.config.transmissionFilter);
    const collectorWaitMs = transmissionFilter ? Math.min(directOffersWaitMs, 1000) : directOffersWaitMs;

    for (const candidate of uniqueCandidates) {
      collector.clear();
      const searchUrl = this.buildDirectSearchUrl(baseUrl.origin, candidate.placeID);
      await page.goto(searchUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await this.waitForResults(page, { collector });
      await this.waitForCollectorOffers(collector, collectorWaitMs);

      const domOffers = await this.extractOffersFromDomWithScroll(page, location);
      const pageScriptOffers = await this.extractOffersFromPageScripts(page, location);
      const collectorOffers = collector.getOffers();
      const offers = dedupeOffers(
        transmissionFilter
          ? [...domOffers, ...pageScriptOffers, ...collectorOffers]
          : [...collectorOffers, ...domOffers, ...pageScriptOffers]
      );
      const visibleFilteredOffers = this.filterOffersByConfiguredTransmission(domOffers);
      const filteredOffers = this.filterOffersByConfiguredTransmission(offers);
      if (filteredOffers.length) {
        if (transmissionFilter && !visibleFilteredOffers.length) {
          continue;
        }
        return filteredOffers;
      }
      if (offers.length && !transmissionFilter) {
        return offers;
      }
    }

    return [];
  }

  async tryDirectGeoSearchFlow(page, location, collector, geoLocation) {
    collector.clear();
    const search = await this.createGeoSearch(geoLocation);
    await page.goto(search.pageUrl, { waitUntil: "domcontentloaded" });
    await this.waitForResults(page, { collector });
    await this.waitForCollectorOffers(collector, 1000);

    const domOffers = await this.extractOffersFromDomWithScroll(page, location);
    const pageScriptOffers = await this.extractOffersFromPageScripts(page, location);
    const collectorOffers = collector.getOffers();
    const offers = dedupeOffers([...domOffers, ...pageScriptOffers, ...collectorOffers]);
    const visibleFilteredOffers = this.filterOffersByConfiguredTransmission(domOffers);
    const filteredOffers = this.filterOffersByConfiguredTransmission(offers);
    if (normalizeTransmissionFilter(this.config.transmissionFilter) && !visibleFilteredOffers.length) {
      return [];
    }
    return filteredOffers;
  }

  async resolveLocationCandidates(page, location) {
    const cacheKey = `${new URL(this.config.baseUrl).origin}|${normalizeWhitespace(location).toLowerCase()}`;
    if (this.locationCandidateCache.has(cacheKey)) {
      return [...this.locationCandidateCache.get(cacheKey)];
    }

    const baseUrl = new URL(this.config.baseUrl);
    const endpoint = `${baseUrl.origin}/api/v2/autocomplete?location=${encodeURIComponent(location)}`;
    const response = await page.request.get(endpoint).catch(() => null);
    if (!response || !response.ok()) {
      return [];
    }

    const payload = await response.json().catch(() => null);
    const rawCandidates = Array.isArray(payload?.result) ? payload.result : [];

    const normalizedLocation = normalizeWhitespace(location).toLowerCase();
    const allLocations = rawCandidates.filter((item) => /all locations/i.test(String(item.place || "")));
    const cityMatches = rawCandidates.filter((item) => normalizeWhitespace(item.city).toLowerCase().includes(normalizedLocation));
    const exactMatches = rawCandidates.filter((item) => normalizeWhitespace(item.place).toLowerCase().includes(normalizedLocation));

    const candidates = [
      ...allLocations,
      ...cityMatches,
      ...exactMatches,
      ...rawCandidates
    ];
    this.locationCandidateCache.set(cacheKey, candidates);
    return [...candidates];
  }

  async resolveLocationCandidatesViaApi(location) {
    const cacheKey = `${new URL(this.config.baseUrl).origin}|${normalizeWhitespace(location).toLowerCase()}`;
    if (this.locationCandidateCache.has(cacheKey)) {
      return [...this.locationCandidateCache.get(cacheKey)];
    }

    const baseUrl = new URL(this.config.baseUrl);
    const endpoint = `${baseUrl.origin}/api/v2/autocomplete?location=${encodeURIComponent(location)}`;
    const payload = await fetchJson(endpoint, this.config.timeoutMs, this.config.currency).catch(() => null);
    const rawCandidates = Array.isArray(payload?.result) ? payload.result : [];
    if (!rawCandidates.length) {
      return [];
    }

    const normalizedLocation = normalizeWhitespace(location).toLowerCase();
    const allLocations = rawCandidates.filter((item) => /all locations/i.test(String(item.place || "")));
    const cityMatches = rawCandidates.filter((item) => normalizeWhitespace(item.city).toLowerCase().includes(normalizedLocation));
    const exactMatches = rawCandidates.filter((item) => normalizeWhitespace(item.place).toLowerCase().includes(normalizedLocation));

    const candidates = [
      ...allLocations,
      ...cityMatches,
      ...exactMatches,
      ...rawCandidates
    ];
    this.locationCandidateCache.set(cacheKey, candidates);
    return [...candidates];
  }

  buildDirectSearchUrl(origin, placeId) {
    const sqPayload = {
      PickupLocationId: placeId,
      DropOffLocationId: placeId,
      PickupDateTime: `${this.config.pickupDate}T${this.config.pickupTime}:00`,
      DropOffDateTime: `${this.config.dropoffDate}T${this.config.dropoffTime}:00`,
      ResidenceCountry: normalizeCountryCode(this.config.residenceCountry) || "PL",
      DriverAge: Number.isFinite(this.config.driverAge) ? this.config.driverAge : 30,
      Hash: ""
    };

    const sq = encodeSqPayload(sqPayload);
    const guid = crypto.randomUUID();
    return `${origin}/search/${guid}?sq=${sq}`;
  }

  buildDirectSearchApiUrl(origin, placeId) {
    const sqPayload = {
      PickupLocationId: placeId,
      DropOffLocationId: placeId,
      PickupDateTime: `${this.config.pickupDate}T${this.config.pickupTime}:00`,
      DropOffDateTime: `${this.config.dropoffDate}T${this.config.dropoffTime}:00`,
      ResidenceCountry: normalizeCountryCode(this.config.residenceCountry) || "PL",
      DriverAge: Number.isFinite(this.config.driverAge) ? this.config.driverAge : 30,
      Hash: ""
    };

    const sq = encodeSqPayload(sqPayload);
    const guid = crypto.randomUUID();
    return `${origin}/api/v2/search/${guid}?sq=${sq}&searchVersion=2`;
  }

  createResponseCollector() {
    const offers = [];
    const seenKeys = new Set();
    const waiters = new Set();

    const notifyWaiters = () => {
      if (!offers.length) {
        return;
      }
      for (const resolve of waiters) {
        resolve(true);
      }
      waiters.clear();
    };

    return {
      add: (entries) => {
        for (const entry of entries) {
          const key = `${entry.provider}|${entry.totalPrice}|${entry.location}|${entry.transmission || ""}`;
          if (seenKeys.has(key)) {
            continue;
          }
          seenKeys.add(key);
          offers.push(entry);
        }
        notifyWaiters();
      },
      clear: () => {
        offers.length = 0;
        seenKeys.clear();
      },
      getOffers: () => [...offers],
      waitForOffers: async (timeoutMs) => {
        if (offers.length) {
          return true;
        }
        return await new Promise((resolve) => {
          const finish = (value) => {
            clearTimeout(timer);
            waiters.delete(finish);
            resolve(value);
          };
          const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
          waiters.add(finish);
        });
      }
    };
  }

  async captureResponseOffers(collector, response, fallbackLocation) {
    const url = response.url();
    const headers = response.headers();
    const contentType = String(headers["content-type"] || "");

    if (!/discovercars/i.test(url)) {
      return;
    }
    if (!/json|javascript/i.test(contentType)) {
      return;
    }

    try {
      const payload = await response.json();
      if (/\/api\/v2\/search\//i.test(url) && !searchApiPayloadMatchesPeriod(payload, this.config)) {
        return;
      }
      const offers = this.extractOffersFromUnknownPayload(payload, fallbackLocation, url);
      if (offers.length) {
        collector.add(offers);
      }
    } catch {
      return;
    }
  }

  async acceptCookies(page) {
    const selectors = [
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "#onetrust-accept-btn-handler",
      "button#onetrust-accept-btn-handler",
      "[data-testid='cookie-accept-all']"
    ];

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ timeout: 3000, force: true }).catch(() => {});
          await page.evaluate((cssSelector) => {
            const element = document.querySelector(cssSelector);
            if (element instanceof HTMLElement) {
              element.click();
            }
          }, selector).catch(() => {});
          await page.waitForTimeout(800);
          if (!(await this.cookieBannerLooksVisible(page))) {
            return;
          }
        }
      }

      for (const pattern of [
        /accept all cookies/i,
        ...COOKIE_BUTTON_PATTERNS
      ]) {
        const button = page.getByRole("button", { name: pattern }).first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3000, force: true }).catch(() => {});
          await page.evaluate(() => {
            const buttonElement = Array.from(document.querySelectorAll("button"))
              .find((element) => /accept all cookies|accept all|accept/i.test((element.textContent || "").trim()));
            if (buttonElement instanceof HTMLElement) {
              buttonElement.click();
            }
          }).catch(() => {});
          await page.waitForTimeout(800);
          if (!(await this.cookieBannerLooksVisible(page))) {
            return;
          }
        }
      }

      if (!(await this.cookieBannerLooksVisible(page))) {
        return;
      }

      await page.waitForTimeout(500);
    }
  }

  async cookieBannerLooksVisible(page) {
    const signals = [
      page.locator("#onetrust-banner-sdk").first(),
      page.getByText(/consent to cookies/i).first(),
      page.getByRole("button", { name: /accept all cookies/i }).first()
    ];

    for (const signal of signals) {
      if (await signal.isVisible().catch(() => false)) {
        return true;
      }
    }

    return false;
  }

  async fillSearchForm(page, location) {
    await this.setPickupLocation(page, location);
    await this.tryFillDateAndTimeInForm(page);
    await this.setResidenceCountry(page, this.config.residenceCountry);
    await this.setDriverAge(page, this.config.driverAge);
  }

  async tryFillDateAndTimeInForm(page) {
    const steps = [
      () => this.setDateRange(page, this.config.pickupDate, this.config.dropoffDate),
      () => this.setTime(page, this.config.pickupTime, 0),
      () => this.setTime(page, this.config.dropoffTime, 1)
    ];

    for (const step of steps) {
      await step().catch(() => {});
    }
  }

  async setPickupLocation(page, location) {
    await this.acceptCookies(page);

    const inputCandidates = [
      page.getByPlaceholder(/enter airport or city/i).first(),
      page.getByPlaceholder(/pick-up location/i).first(),
      page.getByLabel(/pick-up location/i).first(),
      page.locator("input[placeholder*='Pick-up']").first(),
      page.locator("input[name*='pick']").first(),
      page.locator("input:not([type='hidden']):not([type='submit']):not([type='button'])").first()
    ];

    let input = null;
    for (const candidate of inputCandidates) {
      if (await candidate.isVisible().catch(() => false)) {
        input = candidate;
        break;
      }
    }

    if (!input) {
      const trigger = page.getByText(/pick-up location/i).first();
      if (await trigger.isVisible().catch(() => false)) {
        await trigger.click({ timeout: 3000 });
      }

      for (const candidate of inputCandidates) {
        if (await candidate.isVisible().catch(() => false)) {
          input = candidate;
          break;
        }
      }
    }

    if (!input) {
      throw new Error("Could not find the pick-up location input.");
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await input.click({ timeout: 5000, force: true }).catch(() => {});
      await input.focus().catch(() => {});
      await input.press("Control+A").catch(() => {});
      await input.fill("");
      await input.type(location, { delay: 80 });
      await page.waitForTimeout(1000);

      const selected = await this.chooseAutocompleteOption(page, location, input);
      if (!selected) {
        continue;
      }

      const looksValid = await this.locationSelectionLooksValid(page, input, location);
      if (looksValid) {
        return;
      }
    }

    throw new Error(`Could not select pick-up location "${location}" from autocomplete.`);
  }

  async chooseAutocompleteOption(page, location, input) {
    const escapedLocation = escapeRegExp(location);
    const exactishPattern = new RegExp(escapedLocation, "i");
    const allLocationsPattern = new RegExp(`${escapedLocation}.*all locations`, "i");
    const autocompleteItemSelector = ".Autocomplete-AutocompleteItem, [class*='AutocompleteItem']";
    const optionCandidates = [
      page.locator(autocompleteItemSelector).filter({ hasText: allLocationsPattern }).first(),
      page.locator(autocompleteItemSelector).filter({ hasText: exactishPattern }).first(),
      page.locator(autocompleteItemSelector).first(),
      page.getByRole("option", { name: exactishPattern }).first(),
      page.locator("[role='option']").filter({ hasText: exactishPattern }).first(),
      page.locator("li").filter({ hasText: exactishPattern }).first(),
      page.locator("[class*='option']").filter({ hasText: exactishPattern }).first(),
      page.locator("[class*='suggest']").filter({ hasText: exactishPattern }).first()
    ];

    for (const option of optionCandidates) {
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 5000, force: true }).catch(() => {});
        await page.waitForTimeout(500);
        const pickerStillVisible = await page.locator(autocompleteItemSelector).first().isVisible().catch(() => false);
        if (!pickerStillVisible) {
          return true;
        }
      }
    }

    await input.press("ArrowDown").catch(() => {});
    await page.waitForTimeout(200);
    await input.press("Enter").catch(() => {});
    await page.waitForTimeout(500);
    return await this.locationSelectionLooksValid(page, input, location);
  }

  async locationSelectionLooksValid(page, input, expectedLocation) {
    const value = normalizeWhitespace(await input.inputValue().catch(() => ""));
    const hasErrorClass = await input.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      return element.classList.contains("Autocomplete-EnterLocation_hasError");
    }).catch(() => false);

    const hasValidationError = await this.hasPickupLocationValidationError(page);
    const hasAnyValue = Boolean(value);
    const valueLooksReasonable = hasAnyValue && new RegExp(escapeRegExp(expectedLocation), "i").test(value);

    return !hasErrorClass && !hasValidationError && (valueLooksReasonable || hasAnyValue);
  }

  async hasPickupLocationValidationError(page) {
    const inlineError = page
      .locator(".SearchModifier-Errors_isVisible .SearchModifier-Error")
      .filter({ hasText: PICKUP_VALIDATION_ERROR_PATTERN })
      .first();
    return await inlineError.isVisible().catch(() => false);
  }

  async setDateRange(page, pickupDate, dropoffDate) {
    await this.openCalendarFor(page, "pickup", 0);
    await page.waitForFunction(() => {
      const wrapper = document.querySelector(".DatePicker-CalendarWrapper_isVisible");
      return Boolean(wrapper);
    }, null, {
      timeout: 10000
    });
    await this.selectDateFromRangePicker(page, pickupDate);
    await page.waitForTimeout(250);
    await this.selectDateFromRangePicker(page, dropoffDate);
    await page.waitForTimeout(500);
  }

  async openCalendarFor(page, kind, locationIndex) {
    await this.acceptCookies(page);

    const patterns = kind === "pickup"
      ? [/pick-up date/i, /pickup date/i]
      : [/drop-off date/i, /dropoff date/i];

    const candidates = [
      page.locator(".DatePicker-CalendarField").nth(locationIndex),
      ...patterns.map((pattern) => page.getByText(pattern).nth(0)),
      ...patterns.map((pattern) => page.getByLabel(pattern).first()),
      page.locator("[data-testid*='date']").nth(locationIndex),
      page.locator("button, div").filter({ hasText: patterns[0] }).nth(0)
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ timeout: 4000, force: true }).catch(() => {});
        await page.waitForTimeout(600);
        return;
      }
    }

    throw new Error(`Could not open the ${kind} date picker.`);
  }

  async selectDateFromRangePicker(page, dateValue) {
    const dateParts = parseDate(dateValue, "date");
    const monthLabel = `${monthName(dateParts)} ${dateParts.year}`;

    for (let step = 0; step < 18; step += 1) {
      const monthVisible = await page
        .locator(".rdrMonth, .Calendar-NavigationMonth")
        .filter({ hasText: new RegExp(escapeRegExp(monthLabel), "i") })
        .first()
        .isVisible()
        .catch(() => false);
      if (monthVisible) {
        break;
      }
      const moved = await this.clickNextMonth(page);
      if (!moved) {
        break;
      }
      await page.waitForTimeout(250);
    }

    const clicked = await page.evaluate(
      ({ targetMonthLabel, targetDay }) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const months = Array.from(document.querySelectorAll(".rdrMonth"));
        const month = months.find((item) => normalize(item.textContent).includes(targetMonthLabel));
        if (!month) {
          return false;
        }

        const dayButtons = Array.from(
          month.querySelectorAll("button.rdrDay:not(.rdrDayPassive):not(.rdrDayDisabled)")
        );
        const dayButton = dayButtons.find(
          (button) => normalize(button.textContent) === String(targetDay)
        );
        if (!dayButton) {
          return false;
        }

        dayButton.click();
        return true;
      },
      { targetMonthLabel: monthLabel, targetDay: dateParts.day }
    );

    if (clicked) {
      await page.waitForTimeout(400);
      return;
    }

    const labels = toAccessibleDateLabels(dateParts);
    for (const label of labels) {
      const exactButton = page.getByRole("button", { name: new RegExp(escapeRegExp(label), "i") }).first();
      if (await exactButton.isVisible().catch(() => false)) {
        await exactButton.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
        return;
      }
    }

    throw new Error(`Could not select calendar date ${dateValue}.`);
  }

  async clickNextMonth(page) {
    const candidates = [
      page.getByRole("button", { name: /next month/i }).first(),
      page.getByRole("button", { name: /next/i }).first(),
      page.locator("[aria-label*='Next']").first(),
      page.locator("button").filter({ hasText: /^>$/ }).first()
    ];

    for (const candidate of candidates) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }

    return false;
  }

  async setTime(page, time, locationIndex) {
    await this.acceptCookies(page);

    const exactPattern = new RegExp(`^${escapeRegExp(time)}$`);

    const comboboxes = [
      page.getByRole("combobox", { name: /time/i }).nth(locationIndex),
      page.locator("select").nth(locationIndex),
      page.locator("[role='combobox']").nth(locationIndex)
    ];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) {
        continue;
      }

      const selected = await combobox.selectOption({ label: time }).then(() => true).catch(() => false);
      if (selected) {
        await page.waitForTimeout(200);
        return;
      }

      const clicked = await combobox.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (clicked) {
        const option = page.getByRole("option", { name: exactPattern }).first();
        if (await option.isVisible().catch(() => false)) {
          await option.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(300);
          return;
        }
      }
    }

    const timeText = page.getByText(exactPattern).nth(locationIndex);
    if (await timeText.isVisible().catch(() => false)) {
      await timeText.click({ timeout: 3000 }).catch(() => {});
    }
  }

  async setResidenceCountry(page, residenceCountry) {
    await this.acceptCookies(page);

    const comboboxes = [
      page.getByRole("combobox", { name: /country of residence/i }).first(),
      page.getByLabel(/country of residence/i).first(),
      page.locator("select").filter({ hasText: /poland|united kingdom|united states/i }).nth(0)
    ];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) {
        continue;
      }

      const selected = await combobox.selectOption({ label: residenceCountry }).then(() => true).catch(() => false);
      if (selected) {
        await page.waitForTimeout(200);
        return;
      }

      const clicked = await combobox.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) {
        continue;
      }

      const option = page.getByRole("option", { name: new RegExp(escapeRegExp(residenceCountry), "i") }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  async setDriverAge(page, driverAge) {
    await this.acceptCookies(page);

    const ageText = driverAge >= 30 && driverAge <= 65 ? "30-65" : String(driverAge);
    const comboboxes = [
      page.getByRole("combobox", { name: /age/i }).first(),
      page.getByLabel(/age/i).first(),
      page.locator("select").nth(1)
    ];

    for (const combobox of comboboxes) {
      if (!(await combobox.isVisible().catch(() => false))) {
        continue;
      }

      const selected = await combobox.selectOption({ label: ageText }).then(() => true).catch(() => false);
      if (selected) {
        await page.waitForTimeout(200);
        return;
      }

      const clicked = await combobox.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) {
        continue;
      }

      const option = page.getByRole("option", { name: new RegExp(`^${escapeRegExp(ageText)}$`) }).first();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    }
  }

  async submitSearch(page) {
    await this.acceptCookies(page);

    for (const pattern of SEARCH_BUTTON_PATTERNS) {
      const button = page.getByRole("button", { name: pattern }).first();
      if (await button.isVisible().catch(() => false)) {
        await Promise.allSettled([
          page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }),
          button.click({ timeout: 4000 })
        ]);
        await page.waitForTimeout(800);
        if (!(await this.looksLikeSearchPage(page)) && (await this.hasPickupLocationValidationError(page))) {
          throw new Error("Pick-up location was not accepted by DiscoverCars.");
        }
        return;
      }
    }

    const fallback = page.locator("button, a").filter({ hasText: /search/i }).first();
    if (await fallback.isVisible().catch(() => false)) {
      await Promise.allSettled([
        page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }),
        fallback.click({ timeout: 4000 })
      ]);
      await page.waitForTimeout(800);
      if (!(await this.looksLikeSearchPage(page)) && (await this.hasPickupLocationValidationError(page))) {
        throw new Error("Pick-up location was not accepted by DiscoverCars.");
      }
      return;
    }

    throw new Error("Could not find the DiscoverCars search button.");
  }

  async waitForQuickResultSignal(page, collector, timeoutMs) {
    if (!collector || typeof collector.waitForOffers !== "function") {
      return false;
    }

    const signals = [
      page.getByText(/sort by/i).first(),
      page.getByText(/free cancellation/i).first(),
      page.locator("[data-testid*='offer']").first()
    ];
    const pageReady = Promise.any(signals.map((signal) => signal
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)))
      .catch(() => false);
    const [offersReady, visible] = await Promise.all([
      collector.waitForOffers(timeoutMs),
      pageReady
    ]);
    return offersReady && visible;
  }

  async waitForResults(page, options = {}) {
    await page.waitForLoadState("domcontentloaded", { timeout: this.config.timeoutMs }).catch(() => {});
    const speedMode = normalizeSpeedMode(this.config.speedMode);
    const networkIdleTimeoutMs = speedMode === "turbo" ? 2_500 : speedMode === "fast" ? 5_000 : 15_000;
    const maxAttempts = speedMode === "turbo" ? 8 : speedMode === "fast" ? 12 : 20;
    const visibleSettleMs = speedMode === "turbo" ? 250 : speedMode === "fast" ? 600 : 1500;
    const pollMs = speedMode === "turbo" ? 250 : speedMode === "fast" ? 400 : 750;
    const finalSettleMs = speedMode === "turbo" ? 500 : speedMode === "fast" ? 1000 : 3000;
    const quickSignalTimeoutMs = Number.isFinite(options.quickSignalTimeoutMs)
      ? Math.max(1, options.quickSignalTimeoutMs)
      : speedMode === "turbo" ? 1_500 : speedMode === "fast" ? 2_500 : 4_000;

    if (await this.waitForQuickResultSignal(page, options.collector, quickSignalTimeoutMs)) {
      this.apiDomTelemetry.quick_result_signal_count += 1;
      await page.waitForTimeout(visibleSettleMs);
      return;
    }

    this.apiDomTelemetry.full_result_wait_count += 1;
    await page.waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs }).catch(() => {});
    await this.waitForLoadingScreenToFinish(page);

    const signals = [
      page.getByText(/sort by/i).first(),
      page.getByText(/free cancellation/i).first(),
      page.getByText(/very good/i).first(),
      page.locator("article").first(),
      page.locator("[class*='result']").first(),
      page.locator("[class*='offer']").first()
    ];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      for (const signal of signals) {
        if (await signal.isVisible().catch(() => false)) {
          await page.waitForTimeout(visibleSettleMs);
          return;
        }
      }
      await page.waitForTimeout(pollMs);
    }

    await page.waitForTimeout(finalSettleMs);
  }

  async waitForCollectorOffers(collector, timeoutMs) {
    if (typeof collector.waitForOffers === "function") {
      await collector.waitForOffers(timeoutMs);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (collector.getOffers().length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async ensureConfiguredSearchPeriod(page) {
    const discoveredSearchUrl = await this.findSearchUrl(page);
    if (!discoveredSearchUrl) {
      return;
    }

    const parsed = new URL(discoveredSearchUrl);
    const sqParam = parsed.searchParams.get("sq");
    if (!sqParam) {
      return;
    }

    const payload = decodeSqPayload(sqParam);
    if (!payload || typeof payload !== "object") {
      return;
    }

    payload.PickupDateTime = `${this.config.pickupDate}T${this.config.pickupTime}:00`;
    payload.DropOffDateTime = `${this.config.dropoffDate}T${this.config.dropoffTime}:00`;
    if (Number.isFinite(this.config.driverAge)) {
      payload.DriverAge = this.config.driverAge;
    }

    const residenceCode = normalizeCountryCode(this.config.residenceCountry);
    if (residenceCode) {
      payload.ResidenceCountry = residenceCode;
    }

    parsed.searchParams.set("sq", encodeSqPayload(payload));
    const updatedUrl = parsed.toString();
    const current = page.url();
    if (normalizeWhitespace(current) === normalizeWhitespace(updatedUrl)) {
      return;
    }

    await page.goto(updatedUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  }

  async findSearchUrl(page) {
    const current = page.url();
    if (/\/search\/[0-9a-f-]{36}/i.test(current) && /[?&]sq=/i.test(current)) {
      return current;
    }

    const extracted = await page.evaluate(() => {
      const html = document.documentElement?.outerHTML || "";
      const match = html.match(/https:\/\/www\.discovercars\.com\/search\/[0-9a-f-]{36}\?sq=[^"' <]+/i);
      if (!match) {
        return "";
      }
      return match[0].replace(/&amp;.*$/i, "");
    }).catch(() => "");

    return normalizeWhitespace(extracted);
  }

  async looksLikeSearchPage(page) {
    const url = page.url();
    if (/\/search\/[0-9a-f-]{36}/i.test(url) && /[?&]sq=/i.test(url)) {
      return true;
    }

    const loadingSignal = page.getByText(/searching 1,000\+ car rental brands/i).first();
    if (await loadingSignal.isVisible().catch(() => false)) {
      return true;
    }

    const sortBySignal = page.getByText(/sort by/i).first();
    return await sortBySignal.isVisible().catch(() => false);
  }

  async waitForLoadingScreenToFinish(page) {
    const loadingText = page.getByText(/Searching 1,000\+ car rental brands/i).first();
    if (!(await loadingText.isVisible().catch(() => false))) {
      return;
    }

    const speedMode = normalizeSpeedMode(this.config.speedMode);
    const maxWaitMs = speedMode === "turbo" ? 12_000 : speedMode === "fast" ? 20_000 : 60_000;
    const networkIdleTimeoutMs = speedMode === "turbo" ? 1_500 : speedMode === "fast" ? 2_500 : 5_000;
    const pollMs = speedMode === "turbo" ? 300 : speedMode === "fast" ? 500 : 1000;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const stillVisible = await loadingText.isVisible().catch(() => false);
      if (!stillVisible) {
        return;
      }
      await page.waitForLoadState("networkidle", { timeout: networkIdleTimeoutMs }).catch(() => {});
      await page.waitForTimeout(pollMs);
    }
  }

  async extractOffersFromPageScripts(page, fallbackLocation) {
    const html = await page.content();
    const scriptContents = [];
    const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = scriptRegex.exec(html)) != null) {
      scriptContents.push(match[1]);
    }

    const offers = [];
    for (const content of scriptContents) {
      const possibleJsonBlocks = content.match(/\{[\s\S]{50,}\}/g) || [];
      for (const block of possibleJsonBlocks) {
        try {
          const parsed = JSON.parse(block);
          offers.push(...this.extractOffersFromUnknownPayload(parsed, fallbackLocation, "script"));
        } catch {
          continue;
        }
      }
    }

    return dedupeOffers(offers);
  }

  extractOffersFromUnknownPayload(payload, fallbackLocation, source) {
    const apiOffers = extractOffersFromSearchApiPayload(payload, fallbackLocation, source);
    if (apiOffers.length) {
      return dedupeOffers(apiOffers);
    }

    const offers = [];
    const visited = new Set();

    const walk = (value) => {
      if (!value || typeof value !== "object") {
        return;
      }
      if (visited.has(value)) {
        return;
      }
      visited.add(value);

      if (Array.isArray(value)) {
        const normalized = value
          .map((item) => this.normalizeOfferCandidate(item, fallbackLocation, source))
          .filter(Boolean);
        if (normalized.length) {
          offers.push(...normalized);
        }
        for (const item of value) {
          walk(item);
        }
        return;
      }

      for (const nested of Object.values(value)) {
        walk(nested);
      }
    };

    walk(payload);
    return dedupeOffers(offers);
  }

  normalizeOfferCandidate(candidate, fallbackLocation, source) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }

    const provider = normalizeWhitespace(
      firstDefinedString([
        candidate.providerName,
        candidate.supplierName,
        candidate.vendorName,
        candidate.supplier_name,
        candidate.companyName,
        candidate.provider?.name,
        candidate.supplier?.name,
        candidate.vendor?.name,
        candidate.company?.name,
        candidate.rentalCompany?.name,
        candidate.partner?.name
      ])
    );
    const providerRating = firstRating([
      candidate.providerRating,
      candidate.supplierRating,
      candidate.vendorRating,
      candidate.companyRating,
      candidate.partnerRating,
      candidate.rating,
      candidate.score,
      candidate.reviewScore,
      candidate.review_score,
      candidate.provider?.rating,
      candidate.provider?.score,
      candidate.supplier?.rating,
      candidate.supplier?.score,
      candidate.supplier?.reviewScore,
      candidate.vendor?.rating,
      candidate.company?.rating,
      candidate.partner?.rating,
      candidate.rentalCompany?.rating,
      candidate.reviews?.rating,
      candidate.reviews?.score,
      candidate.reviews?.average,
      candidate.review?.rating,
      candidate.review?.score,
      candidate.rating?.value,
      candidate.rating?.score,
      candidate.rating?.average
    ]);

    const parsedMoney = firstMoney([
      candidate.totalPrice,
      candidate.price,
      candidate.price?.formatted,
      candidate.price?.amount,
      candidate.price?.total,
      candidate.prices?.total,
      candidate.prices?.default,
      candidate.pricing?.total,
      candidate.pricing?.amount,
      candidate.payment?.total,
      candidate.payment?.amount,
      candidate.payment?.payNow,
      candidate.payment?.payOnArrival,
      candidate.amount,
      candidate.formattedPrice,
      candidate.total,
      candidate.prices,
      candidate.total_price,
      candidate.amount_total
    ]);

    if (!provider || !parsedMoney) {
      return null;
    }

    const location = normalizeWhitespace(
      firstDefinedString([
        candidate.locationName,
        candidate.location?.name,
        candidate.location?.title,
        candidate.pickUpLocation?.name,
        candidate.pickupLocation?.name,
        candidate.pickupLocName,
        candidate.dropoffLocName,
        candidate.branch?.name,
        candidate.station?.name,
        fallbackLocation
      ])
    );
    const transmission = findTransmissionInCandidate(candidate);

    return {
      provider,
      providerRating,
      totalPrice: parsedMoney.value,
      currency: normalizeCurrency(parsedMoney.currency),
      location,
      carName: firstDefinedString([
        candidate.carName,
        candidate.vehicleName,
        candidate.modelName,
        candidate.car?.name,
        candidate.vehicle?.name,
        candidate.model?.name,
        candidate.title,
        candidate.acriss,
        candidate.car?.acriss,
        candidate.vehicle?.acriss
      ]) || null,
      transmission: transmission || null,
      source
    };
  }

  async extractOffersFromDom(page, fallbackLocation) {
    const rawCandidates = await page.evaluate((options) => {
      const defaultLocation = options.defaultLocation;
      const includeSupplierRows = String(options.transmissionFilter || "").toLowerCase() !== "automatic";
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const results = [];
      const parseRating = (value) => {
        const text = normalize(value).replace(",", ".");
        const matches = text.match(/\d+(?:\.\d+)?/g) || [];
        for (const match of matches) {
          const rating = Number.parseFloat(match);
          if (Number.isFinite(rating) && rating > 0 && rating <= 10) {
            return Number(rating.toFixed(1));
          }
        }
        return null;
      };

      const findRatingText = (root) => {
        const ratingSelectors = [
          ".SupplierInfo-RatingScore",
          "[class*='RatingScore']",
          "[class*='SupplierScore']",
          "[data-testid*='rating']",
          "[data-testid*='score']",
          "[class*='rating']",
          "[class*='score']",
          "[aria-label*='rating' i]",
          "[aria-label*='score' i]"
        ];

        for (const selector of ratingSelectors) {
          const element = root.querySelector(selector);
          const text = normalize(element?.textContent || element?.getAttribute?.("aria-label") || "");
          if (parseRating(text) != null) {
            return text;
          }
        }

        const lines = normalize(root.textContent).split(/\n+/).map(normalize).filter(Boolean);
        return lines.find((line) => /(rating|score|excellent|very good|good)/i.test(line) && parseRating(line) != null) || "";
      };

      const detectTransmission = (text) => {
        const normalized = normalize(text).toLowerCase();
        const hasAutomatic = /\b(automatic transmission|automatic|automat)\b/.test(normalized);
        const hasManual = /\b(manual transmission|manual)\b/.test(normalized);
        if (hasAutomatic && !hasManual) {
          return "automatic";
        }
        if (hasManual && !hasAutomatic) {
          return "manual";
        }
        return "";
      };

      const addCandidate = (providerText, priceText, ratingText = "", carName = "", transmissionText = "") => {
        const provider = normalize(providerText);
        const price = normalize(priceText);
        const providerRating = parseRating(ratingText);
        if (!provider || !price || !/\d/.test(price)) {
          return;
        }

        results.push({
          provider,
          providerRating,
          priceText: price,
          location: defaultLocation,
          carName: normalize(carName || "") || null,
          transmission: detectTransmission(transmissionText || carName) || null
        });
      };

      const supplierFilterRows = includeSupplierRows
        ? Array.from(document.querySelectorAll(".SearchFiltersGroup-FilterWrapper"))
        : [];
      for (const row of supplierFilterRows) {
        const provider = row.querySelector(".SearchFiltersGroup-FilterLabel")?.textContent || "";
        const price = row.querySelector(".SearchFiltersGroup-FilterMinPrice")?.textContent || "";
        addCandidate(provider, price, findRatingText(row));
      }

      if (results.length < 3) {
        const selectors = [
          ".SearchCar",
          "[class*='SearchCar']",
          "article",
          "[data-testid*='offer']",
          "[data-testid*='result']",
          "[class*='offer']",
          "[class*='result']",
          "[class*='vehicle']",
          "[class*='car']"
        ];

        const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
        for (const node of nodes) {
        const text = normalize(node.innerText);
        if (!text || !/\d/.test(text)) {
          continue;
        }

        const lines = text.split(/\n+/).map(normalize).filter(Boolean);
        const searchCarTotalMatch = text.match(/total for\s+\d+\s+days?\s+((?:EUR|USD|GBP|PLN|z[l\u0142])\s*[\d\s.,]+)/i);
        const searchCarPriceLine =
          normalize(searchCarTotalMatch?.[1] || "") ||
          lines.find((line) => /total for/i.test(line) && /(EUR|USD|GBP|PLN|z[l\u0142])/i.test(line)) ||
          "";
        const searchCarNameElement = node.querySelector(
          ".CarTitle-Name, h1, h2, h3, [data-testid*='car'], [data-testid*='vehicle'], [class*='car-name'], [class*='vehicle-name']"
        );
        const searchCarName = normalize(searchCarNameElement?.textContent || lines[0] || "");
        const searchCarProvider = Array.from(
          node.querySelectorAll("[class*='SupplierInfo'] img[alt], [class*='supplier'] img[alt], img[alt]")
        )
          .map((image) => normalize(image.getAttribute("alt") || ""))
          .find((alt) => {
            if (!alt || alt.length < 2 || alt.length > 80) {
              return false;
            }
            if (searchCarName && alt.toLowerCase() === searchCarName.toLowerCase()) {
              return false;
            }
            if (/(cars?|small|medium|large|suv|van|wagon|premium|mini|economy|compact)$/i.test(alt)) {
              return false;
            }
            return true;
          }) || "";
        if (searchCarPriceLine && searchCarProvider) {
          addCandidate(searchCarProvider, searchCarPriceLine, findRatingText(node), searchCarName, text);
          continue;
        }
        const priceLine = lines.find((line) => /(EUR|USD|GBP|PLN|€|\$|£|zł)/i.test(line) && /\d/.test(line)) || "";
        const providerLine = lines.find((line) => {
          if (line.length < 3 || line.length > 50) {
            return false;
          }
          if (/(free cancellation|book|total|price|rating|excellent|very good|from|pay now)/i.test(line)) {
            return false;
          }
          return /[a-z]/i.test(line);
        }) || "";

        if (!priceLine || !providerLine) {
          continue;
        }

          const carName = lines[0] || "";
          addCandidate(providerLine, priceLine, findRatingText(node), carName, text);
        }
      }

      return results;
    }, {
      defaultLocation: fallbackLocation,
      transmissionFilter: normalizeTransmissionFilter(this.config.transmissionFilter)
    });

    const offers = [];
    for (const candidate of rawCandidates) {
      const money = parseMoney(candidate.priceText);
      if (!money) {
        continue;
      }
      offers.push({
        provider: normalizeWhitespace(candidate.provider),
        providerRating: Number.isFinite(candidate.providerRating) ? Number(candidate.providerRating) : null,
        totalPrice: money.value,
        currency: normalizeCurrency(money.currency),
        location: normalizeWhitespace(candidate.location) || fallbackLocation,
        carName: candidate.carName ? normalizeWhitespace(candidate.carName) : null,
        transmission: normalizeTransmission(candidate.transmission) || null,
        source: "dom"
      });
    }

    return dedupeOffers(offers);
  }

  async extractOffersFromDomWithScroll(page, fallbackLocation) {
    const transmissionFilter = normalizeTransmissionFilter(this.config.transmissionFilter);
    const maxPasses = transmissionFilter === "automatic" ? 8 : 1;
    const collected = [];

    for (let pass = 0; pass < maxPasses; pass += 1) {
      collected.push(...await this.extractOffersFromDom(page, fallbackLocation));
      if (transmissionFilter !== "automatic") {
        break;
      }

      const automaticProviderCount = new Set(
        collected
          .filter((offer) => normalizeTransmission(offer.transmission) === "automatic")
          .map((offer) => normalizeWhitespace(offer.provider).toLowerCase())
          .filter(Boolean)
      ).size;
      const hasMmCarsRental = collected.some((offer) => {
        const provider = normalizeWhitespace(offer.provider).toLowerCase();
        return normalizeTransmission(offer.transmission) === "automatic" && provider === "mm cars rental";
      });
      if ((automaticProviderCount >= 3 && hasMmCarsRental) || automaticProviderCount >= 6) {
        break;
      }

      await page.evaluate(() => {
        window.scrollBy(0, Math.max(window.innerHeight * 0.8, 700));
      }).catch(() => {});
      await page.waitForTimeout(700);
    }

    return dedupeOffers(collected);
  }

  filterOffersByConfiguredTransmission(offers) {
    return filterOffersByTransmission(offers, this.config.transmissionFilter);
  }

  async captureFailureArtifacts(page, location) {
    const baseName = safeFilePart(location) || "location";
    const screenshotPath = path.join(this.config.artifactsDir, `${baseName}.png`);
    const htmlPath = path.join(this.config.artifactsDir, `${baseName}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (html) {
      writeTextFile(htmlPath, html);
    }
  }
}

function firstDefinedString(values) {
  for (const value of values) {
    if (typeof value === "string" && normalizeWhitespace(value)) {
      return value;
    }
  }
  return "";
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, base));
}

function deterministicSample(...parts) {
  const rate = Number(parts.pop());
  const hash = crypto
    .createHash("sha1")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return bucket < rate;
}

function isIgnoredApiProvider(provider) {
  const normalized = normalizeWhitespace(provider);
  return IGNORED_API_PROVIDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isMmCarsRentalProvider(provider) {
  const normalized = normalizeWhitespace(provider)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  return normalized.includes("mm cars rental");
}

function normalizeProviderForComparison(provider) {
  return normalizeWhitespace(provider).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function daysBetweenIso(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const days = Math.round((end - start) / 86400000);
  return Number.isFinite(days) && days > 0 ? days : 1;
}

function resolveGeoLocationOverride(location, configuredOverrides = {}) {
  const normalizedLocation = normalizeWhitespace(location).toLowerCase();
  const configuredEntry = Object.entries(configuredOverrides || {}).find(
    ([key]) => normalizeWhitespace(key).toLowerCase() === normalizedLocation
  );
  const raw = configuredEntry?.[1] || DEFAULT_GEO_LOCATION_OVERRIDES[normalizedLocation];
  const latitude = Number(raw?.latitude);
  const longitude = Number(raw?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return {
    latitude,
    longitude,
    radiusMeters: clampPositiveInteger(raw.radiusMeters ?? raw.radius_meters, 20_000, 1_000, 100_000),
    geoLocationName: normalizeWhitespace(raw.geoLocationName || raw.geo_location_name || location)
  };
}

function buildGeoSearchPayload(config, geoLocation) {
  const pickupTime = normalizeWhitespace(config.pickupTime || "11:00");
  const dropoffTime = normalizeWhitespace(config.dropoffTime || "11:00");
  return {
    is_drop_off: false,
    pick_up_country_id: 0,
    pick_up_city_id: 0,
    pick_up_location_id: 0,
    pickup_id: 0,
    drop_off_country_id: 0,
    drop_off_city_id: 0,
    drop_off_location_id: 0,
    dropoff_id: 0,
    pickup_from: `${config.pickupDate} ${pickupTime}`,
    pickup_to: `${config.dropoffDate} ${dropoffTime}`,
    pick_time: pickupTime,
    drop_time: dropoffTime,
    driver_age: String(Number.isFinite(config.driverAge) ? config.driverAge : 30),
    residence_country: normalizeCountryCode(config.residenceCountry) || "PL",
    partnerID: 0,
    excludeLocations: 0,
    recent_search: 0,
    isWhitelabel: false,
    latitude: geoLocation.latitude,
    longitude: geoLocation.longitude,
    radius_meters: geoLocation.radiusMeters,
    geo_location_name: geoLocation.geoLocationName
  };
}

function searchApiPayloadMatchesPeriod(payload, config) {
  const offers = Array.isArray(payload?.data?.offers) ? payload.data.offers : [];
  const expectedPickup = `${config.pickupDate}T${normalizeWhitespace(config.pickupTime || "11:00")}:00`;
  const expectedDropoff = `${config.dropoffDate}T${normalizeWhitespace(config.dropoffTime || "11:00")}:00`;

  for (const offer of offers) {
    const pickup = normalizeWhitespace(offer?.pickupClosingInfo?.pickupDatetime);
    const dropoff = normalizeWhitespace(offer?.pickupClosingInfo?.dropoffDatetime);
    if (pickup && !pickup.startsWith(expectedPickup)) {
      return false;
    }
    if (dropoff && !dropoff.startsWith(expectedDropoff)) {
      return false;
    }
  }
  return true;
}

function transmissionFromSearchApiOffer(offer) {
  const automaticFlag = offer?.vehicle?.specifications?.isAutomaticTransmission;
  if (automaticFlag === 1 || automaticFlag === true || automaticFlag === "1") {
    return "automatic";
  }
  if (automaticFlag === 0 || automaticFlag === false || automaticFlag === "0") {
    return "manual";
  }

  return normalizeTransmission(offer?.vehicle?.sipp || offer?.sipp || "");
}

function extractOffersFromSearchApiPayload(payload, fallbackLocation, sourceUrl = "api") {
  const rawOffers = Array.isArray(payload?.data?.offers) ? payload.data.offers : [];
  const offers = [];

  for (const offer of rawOffers) {
    if (!offer || typeof offer !== "object") {
      continue;
    }

    const provider = normalizeWhitespace(offer.supplier?.name || offer.provider?.name || offer.company?.name || "");
    if (!provider || isIgnoredApiProvider(provider)) {
      continue;
    }

    const parsedMoney = firstMoney([
      offer.price?.raw,
      offer.price?.formatted,
      offer.price,
      offer.totalPrice,
      offer.pricing?.total
    ]);
    if (!parsedMoney || !Number.isFinite(parsedMoney.value)) {
      continue;
    }

    const transmission = transmissionFromSearchApiOffer(offer);
    offers.push({
      provider,
      providerRating: firstRating([
        offer.supplier?.rating?.score,
        offer.supplier?.rating,
        offer.supplierRating,
        offer.rating
      ]),
      totalPrice: parsedMoney.value,
      currency: normalizeCurrency(parsedMoney.currency || "PLN"),
      location: normalizeWhitespace(
        firstDefinedString([
          offer.location?.name,
          offer.location?.title,
          offer.location?.city,
          fallbackLocation
        ])
      ) || fallbackLocation,
      carName: normalizeWhitespace(offer.vehicle?.carName || offer.vehicle?.name || offer.carName || "") || null,
      transmission: transmission || null,
      source: "api",
      sourceUrl,
      sipp: normalizeWhitespace(offer.vehicle?.sipp || offer.sipp || "") || null
    });
  }

  return dedupeOffers(offers);
}

async function fetchJson(url, timeoutMs, currency = "PLN", retries = 2, requestOptions = {}) {
  if (typeof fetch !== "function") {
    throw new Error("Node fetch API is unavailable.");
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), clampPositiveInteger(timeoutMs, 45000, 5000, 180000));
    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 DiscoverCars scraper",
          cookie: `currency=${normalizeCurrency(currency || "PLN") || "PLN"}`,
          ...(requestOptions.headers || {})
        }
      });
      if (!response.ok) {
        const error = new Error(`DiscoverCars API returned HTTP ${response.status}.`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= retries || error?.retryable === false) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function normalizeRatingValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
    return null;
  }

  return Number(parsed.toFixed(1));
}

function parseRatingValue(rawValue) {
  if (rawValue == null) {
    return null;
  }

  if (typeof rawValue === "number") {
    return normalizeRatingValue(rawValue);
  }

  if (typeof rawValue === "string") {
    const matches = normalizeWhitespace(rawValue).replace(",", ".").match(/\d+(?:\.\d+)?/g) || [];
    for (const match of matches) {
      const rating = normalizeRatingValue(match);
      if (rating != null) {
        return rating;
      }
    }
    return null;
  }

  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    const preferredKeys = [
      "rating",
      "score",
      "value",
      "average",
      "averageScore",
      "reviewScore",
      "supplierRating",
      "providerRating"
    ];

    for (const key of preferredKeys) {
      const rating = parseRatingValue(rawValue[key]);
      if (rating != null) {
        return rating;
      }
    }

    for (const [key, value] of Object.entries(rawValue)) {
      if (!/rating|score|review/i.test(key)) {
        continue;
      }
      const rating = parseRatingValue(value);
      if (rating != null) {
        return rating;
      }
    }
  }

  return null;
}

function firstRating(values) {
  for (const value of values) {
    const rating = parseRatingValue(value);
    if (rating != null) {
      return rating;
    }
  }
  return null;
}

function firstMoney(values) {
  for (const value of values) {
    let parsed = null;
    if (typeof value === "number" && Number.isFinite(value)) {
      parsed = parseMoney(value);
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const formattedCandidate = firstDefinedString([
        value.formatted,
        value.display,
        value.price
      ]);
      if (formattedCandidate) {
        parsed = parseMoney(formattedCandidate, normalizeCurrency(firstDefinedString([value.currency, value.curr])));
      }
      if (parsed) {
        return parsed;
      }

      const numericCandidate = [value.raw, value.amount, value.total, value.value]
        .find((item) => typeof item === "number" && Number.isFinite(item));

      if (numericCandidate != null) {
        parsed = parseMoney(numericCandidate, normalizeCurrency(firstDefinedString([value.currency, value.curr])));
      } else {
        parsed = parseMoney(firstDefinedString([
          value.amount,
          value.total,
          value.value,
          value.formatted,
          value.display,
          value.price
        ]));
      }
    } else {
      parsed = parseMoney(value);
    }

    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function monthName(dateParts) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)));
}

function dedupeOffers(offers) {
  const seen = new Set();
  const unique = [];

  for (const offer of offers) {
    const provider = normalizeWhitespace(offer.provider);
    if (!provider || !Number.isFinite(offer.totalPrice)) {
      continue;
    }

    const key = `${provider.toLowerCase()}|${offer.totalPrice}|${normalizeWhitespace(offer.location).toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      ...offer,
      provider,
      providerRating: Number.isFinite(offer.providerRating) ? Number(offer.providerRating) : null,
      location: normalizeWhitespace(offer.location)
    });
  }

  return unique;
}

function selectBestOffersByProvider(offers, fallbackLocation, maxProviders, forcedProviderNames) {
  const byProvider = new Map();

  for (const offer of offers) {
    const provider = normalizeWhitespace(offer.provider);
    if (!provider || !Number.isFinite(offer.totalPrice)) {
      continue;
    }

    const normalizedOffer = {
      provider,
      providerRating: Number.isFinite(offer.providerRating) ? Number(offer.providerRating) : null,
      totalPrice: offer.totalPrice,
      currency: normalizeCurrency(offer.currency),
      location: normalizeWhitespace(fallbackLocation || offer.location),
      source: normalizeWhitespace(offer.source),
      carName: normalizeWhitespace(offer.carName || offer.car_name || "") || null,
      transmission: normalizeTransmission(offer.transmission) || null,
      sourceUrl: normalizeWhitespace(offer.sourceUrl || offer.source_url || "") || null
    };

    const providerKey = provider.toLowerCase();
    const existing = byProvider.get(providerKey);
    if (!existing || normalizedOffer.totalPrice < existing.totalPrice) {
      byProvider.set(providerKey, normalizedOffer);
    }
  }

  const sorted = [...byProvider.values()].sort((left, right) => left.totalPrice - right.totalPrice);
  const limit = Number.isFinite(maxProviders) && maxProviders > 0 ? maxProviders : sorted.length;
  const selected = sorted.slice(0, limit);

  const forcedProviders = Array.isArray(forcedProviderNames) ? forcedProviderNames : [];
  for (const forcedProvider of forcedProviders) {
    const forcedKey = normalizeWhitespace(forcedProvider).toLowerCase();
    if (!forcedKey) {
      continue;
    }

    const alreadyIncluded = selected.some(
      (item) => normalizeWhitespace(item.provider).toLowerCase() === forcedKey
    );
    if (alreadyIncluded) {
      continue;
    }

    const forcedOffer = byProvider.get(forcedKey);
    if (forcedOffer) {
      selected.push(forcedOffer);
    }
  }

  return selected.sort((left, right) => left.totalPrice - right.totalPrice);
}

function normalizeCurrencyLegacy(value) {
  if (!value) {
    return "";
  }
  if (value === "ZŁ") {
    return "PLN";
  }
  if (value === "$") {
    return "USD";
  }
  if (value === "€") {
    return "EUR";
  }
  if (value === "£") {
    return "GBP";
  }
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function dedupeLocationCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const placeId = Number.parseInt(candidate?.placeID, 10);
    if (!Number.isFinite(placeId)) {
      continue;
    }
    if (seen.has(placeId)) {
      continue;
    }
    seen.add(placeId);
    unique.push({ ...candidate, placeID: placeId });
  }

  return unique;
}

function normalizeCurrency(value) {
  if (!value) {
    return "";
  }

  const normalized = String(value).toUpperCase();
  if (normalized === "ZŁ" || normalized === "ZĹ" || normalized === "ZL") {
    return "PLN";
  }
  if (value === "$") {
    return "USD";
  }
  if (value === "€" || value === "â‚¬") {
    return "EUR";
  }
  if (value === "£" || value === "ÂŁ") {
    return "GBP";
  }
  return normalized;
}

function decodeSqPayload(rawSq) {
  try {
    const decoded = decodeURIComponent(String(rawSq));
    const json = Buffer.from(decoded, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function encodeSqPayload(payload) {
  const json = JSON.stringify(payload);
  return encodeURIComponent(Buffer.from(json, "utf8").toString("base64"));
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
    CZECHIA: "CZ",
    "CZECH REPUBLIC": "CZ",
    SLOVAKIA: "SK",
    HUNGARY: "HU",
    ROMANIA: "RO",
    LITHUANIA: "LT",
    LATVIA: "LV",
    ESTONIA: "EE",
    SWEDEN: "SE",
    NORWAY: "NO",
    DENMARK: "DK",
    FINLAND: "FI",
    IRELAND: "IE",
    "UNITED KINGDOM": "GB",
    UK: "GB",
    "GREAT BRITAIN": "GB",
    "UNITED STATES": "US",
    USA: "US",
    CANADA: "CA",
    AUSTRALIA: "AU",
    "NEW ZEALAND": "NZ",
    NEWZEALAND: "NZ"
  };

  return mapping[normalized] || "";
}

module.exports = {
  buildGeoSearchPayload,
  createSharedBrowserProvider,
  DiscoverCarsScraper,
  extractOffersFromSearchApiPayload,
  resolveGeoLocationOverride,
  searchApiPayloadMatchesPeriod
};
