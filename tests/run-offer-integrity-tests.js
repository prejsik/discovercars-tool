const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const {
  DiscoverCarsScraper,
  extractOffersFromSearchApiPayload
} = require("../src/discovercars/scraper");
const { searchCheapestOffers } = require("../src/discoverCars");
const { dedupeOffers } = require("../src/extractors");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const LOCATION = "Fixture Airport";
const GEO_LOCATION = "Galeria Krakowska Shopping Mall";
const config = {
  baseUrl: "https://www.discovercars.com/",
  pickupDate: "2026-10-02",
  dropoffDate: "2026-10-03",
  pickupTime: "11:00",
  dropoffTime: "11:00",
  rentalDays: 1,
  transmissionFilter: "automatic",
  maxProvidersPerLocation: 20,
  pinnedLocationIds: { [LOCATION]: 123 },
  apiDomDriftState: { by_location: {} },
  speedMode: "fast",
  timeoutMs: 1000
};
const offer = (overrides = {}) => ({
  provider: "Supplier",
  totalPrice: 100,
  currency: "PLN",
  location: LOCATION,
  transmission: "automatic",
  carName: "Toyota Yaris",
  source: "api",
  ...overrides
});
const leaderboard = (overrides = {}) => [offer(overrides), offer({ provider: "Second", totalPrice: 140, offerId: "second" }),
  offer({ provider: "Third", totalPrice: 160, offerId: "third" })];
const apiPayload = (entries) => ({ data: { offers: entries.map((entry) => ({
  id: entry.offerId,
  supplier: { name: entry.provider },
  price: { raw: entry.totalPrice, formatted: `${entry.currency} ${entry.totalPrice}`, currency: entry.currency },
  vehicle: { carName: entry.carName, specifications: {
    isAutomaticTransmission: entry.transmission === "automatic" ? 1 : entry.transmission === "manual" ? 0 : undefined
  } }
})) } });
const card = (entry, hidden = false) => `<article class="SearchCar"${hidden ? ' style="display:none"' : ""}${entry.offerId ? ` data-offer-id="${entry.offerId}"` : ""}>
  <h3 class="CarTitle-Name">${entry.carName}</h3>
  <div class="SupplierInfo"><img alt="${entry.provider}"></div>
  <p>${entry.transmission || "Unknown"} transmission</p>
  <p>Total for 1 day ${entry.currency} ${entry.totalPrice}</p>
</article>`;

// Real extraction and registered flows; only network/navigation and waits are replaced.
async function fixture(browser, options = {}) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.abort());
  const realPage = await context.newPage();
  const dom = options.dom || options.domPasses?.[0] || [];
  const api = options.api || [];
  const htmlFor = (entries) => `<main>${entries.map((entry) => card(entry)).join("")}${(options.hidden || []).map((entry) => card(entry, true)).join("")}${options.extraHtml || ""}</main>
    <script type="application/json">${JSON.stringify(apiPayload(api))}</script>`;
  let pass = 0;
  const page = {
    goto: async () => realPage.setContent(htmlFor(dom)),
    evaluate: (...args) => realPage.evaluate(...args),
    content: () => realPage.content(),
    waitForTimeout: async () => {
      if (options.domPasses && pass < options.domPasses.length - 1) {
        pass += 1;
        await realPage.setContent(htmlFor(options.domPasses[pass]));
      }
    },
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    on: () => {}
  };
  const fakeBrowser = { newContext: async () => ({ newPage: async () => page, close: async () => {} }) };
  const scraper = new DiscoverCarsScraper({ ...config, ...options.config, apiDomDriftState: { by_location: {} } });
  scraper.configureContext = async () => {};
  scraper.acceptCookies = async () => {};
  scraper.fillSearchForm = async () => {};
  scraper.submitSearch = async () => page.goto("fixture");
  scraper.ensureConfiguredSearchPeriod = async () => {};
  scraper.captureFailureArtifacts = async () => {};
  scraper.waitForResults = async (_page, { collector } = {}) => {
    if (collector) collector.add(extractOffersFromSearchApiPayload(apiPayload(api), options.location || LOCATION));
  };
  scraper.waitForCollectorOffers = async () => {};
  scraper.createGeoSearch = async () => ({ pageUrl: "https://www.discovercars.com/fixture-geo" });
  scraper.runSingleLocationViaApi = async (location) => scraper.buildApiOutcome(apiPayload(api), location, "fixture-api");
  if (options.form) scraper.resolveLocationCandidates = async () => [];
  return { scraper, fakeBrowser, close: () => context.close() };
}

for (const reversed of [false, true]) {
  test(`equal manual/automatic API prices preserve both views (${reversed ? "automatic first" : "manual first"})`, () => {
    const rows = [offer({ transmission: "manual", offerId: "manual" }), offer({ offerId: "auto" })];
    const scraper = new DiscoverCarsScraper(config);
    const result = scraper.buildApiOutcome(apiPayload(reversed ? rows.reverse() : rows), LOCATION, "fixture-api");
    assert.equal(result.offerViews.all.length, 2);
    assert.equal(result.offerViews.automatic.length, 1);
    assert.equal(result.results[0].transmission, "automatic");
    assert.equal(result.results[0].offerId, "auto");
  });
}

for (const reversed of [false, true]) {
  test(`legacy-batch preserves cheapest automatic and both views (${reversed ? "automatic first" : "manual first"})`, async () => {
    const tied = [offer({ transmission: "manual", offerId: "manual" }), offer({ offerId: "auto" })];
    const rows = [
      ...(reversed ? tied.reverse() : tied),
      offer({ offerId: "auto" }),
      offer({ offerId: "auto-other-id" }),
      offer({ totalPrice: 120, offerId: "more-expensive-auto" }),
      offer({ provider: "Second", totalPrice: 140, offerId: "second" }),
      offer({ provider: "Third", totalPrice: 160, offerId: "third" })
    ];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const requestUrl = new URL(url);
      if (requestUrl.origin !== "https://www.discovercars.com") throw new Error(`Unexpected fixture URL: ${url}`);
      const payload = requestUrl.pathname === "/api/v2/autocomplete"
        ? { result: [{ placeID: 123, place: LOCATION }] }
        : requestUrl.pathname.startsWith("/api/v2/search/") ? apiPayload(rows) : null;
      if (!payload) throw new Error(`Unexpected fixture URL: ${url}`);
      return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
    };
    try {
      const result = await searchCheapestOffers({
        strategy: "legacy-batch",
        locations: [LOCATION],
        weekend: { pickupIso: "2026-10-02T11:00:00", dropoffIso: "2026-10-03T11:00:00", rentalDays: 1 },
        currency: "PLN",
        transmissionFilter: "automatic",
        apiFirst: true,
        apiDomSanityRate: 0,
        browserProvider: { getBrowser: async () => { throw new Error("Fixture must stay offline and API-only"); } },
        quietLegacyLogs: true,
        logger: { info: () => {}, error: () => {} }
      });
      assert.deepEqual(result.errors, []);
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].provider_name, "Supplier");
      assert.equal(result.results[0].total_price, 100);
      assert.equal(result.results[0].transmission, "automatic");
      const breakdown = result.locationBreakdown[0];
      assert.equal(breakdown.offer_views.all.offer_count, 5);
      assert.equal(breakdown.offer_views.automatic.offer_count, 4);
      assert.equal(breakdown.offer_views.all.cheapest_offer.transmission, reversed ? "automatic" : "manual");
      assert.equal(breakdown.offer_views.automatic.cheapest_offer.transmission, "automatic");
      assert.equal(breakdown.offer_views.automatic.cheapest_offer.total_price, 100);
    } finally {
      global.fetch = originalFetch;
    }
  });
}

test("collected-offer dedupe normalizes transmission aliases and removes exact duplicates", () => {
  const row = { location: LOCATION, provider_name: "Supplier", total_price: 100, currency: "PLN", car_name: "Toyota Yaris" };
  const unique = dedupeOffers(["manual", "manual", "Manual Transmission", "automatic", "automatic", "Automatic Transmission"]
    .map((transmission) => ({ ...row, transmission })));
  assert.deepEqual(unique.map((entry) => entry.transmission), ["manual", "automatic"]);
});

test("API dedupe preserves model, currency and offer ID but removes repeated identical offers", () => {
  const rows = [
    offer({ offerId: "a" }), offer({ offerId: "a" }),
    offer({ offerId: "b" }),
    offer({ carName: "Toyota Corolla" }),
    offer({ currency: "EUR" })
  ];
  const parsed = extractOffersFromSearchApiPayload(apiPayload(rows), LOCATION);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((item) => item.currency), ["PLN", "PLN", "PLN", "EUR"]);
  assert.deepEqual(parsed.slice(0, 2).map((item) => item.offerId), ["a", "b"]);
});

test("collector preserves distinct currencies, models and IDs while removing same-offer duplicates", () => {
  const scraper = new DiscoverCarsScraper(config);
  const collector = scraper.createResponseCollector();
  collector.add([offer({ offerId: "a" }), offer({ offerId: "a" }), offer({ offerId: "b" }),
    offer({ currency: "EUR" }), offer({ carName: "Toyota Corolla" })]);
  assert.equal(collector.getOffers().length, 4);
});

test("API-only, script and untagged evidence can never confirm DOM", () => {
  const scraper = new DiscoverCarsScraper(config);
  for (const source of ["api", "script", "", undefined]) {
    const comparison = scraper.compareApiAndBrowserOutcomes([offer()], [offer({ source })]);
    assert.equal(comparison.confirmed, false);
    assert.ok(comparison.reasons.includes("dom_evidence_not_independent"));
  }
});

test("empty or incomplete DOM evidence cannot confirm an API ranking", () => {
  const scraper = new DiscoverCarsScraper(config);
  const api = leaderboard();
  for (const dom of [[], [offer({ source: "dom" })]]) {
    const comparison = scraper.compareApiAndBrowserOutcomes(api, dom);
    assert.equal(comparison.confirmed, false);
    assert.ok(comparison.reasons.length > 0);
  }
});

test("mixed DOM/API and unknown transmission evidence fail closed", () => {
  const scraper = new DiscoverCarsScraper(config);
  for (const dom of [
    [offer({ source: "dom" }), offer({ provider: "Second" })],
    [offer({ source: "dom", transmission: null })]
  ]) {
    const comparison = scraper.compareApiAndBrowserOutcomes([offer()], dom);
    assert.equal(comparison.confirmed, false);
    assert.ok(comparison.reasons.length > 0);
  }
});

test("complete independent DOM evidence confirms and detects every provider's price conflict", () => {
  const scraper = new DiscoverCarsScraper(config);
  const api = leaderboard();
  const dom = api.map((entry) => ({ ...entry, source: "dom" }));
  assert.equal(scraper.compareApiAndBrowserOutcomes(api, dom).confirmed, true);
  dom[1].totalPrice = 200;
  const conflict = scraper.compareApiAndBrowserOutcomes(api, dom);
  assert.equal(conflict.confirmed, false);
  assert.equal(conflict.preferBrowser, true);
  assert.ok(conflict.reasons.includes("provider_price_mismatch"));
});

test("currency and transmission conflicts cannot be confirmed", () => {
  const scraper = new DiscoverCarsScraper(config);
  for (const overrides of [{ currency: "EUR" }, { transmission: "manual" }]) {
    const comparison = scraper.compareApiAndBrowserOutcomes(leaderboard(), leaderboard({ source: "dom", ...overrides }).map((entry) => ({ ...entry, source: "dom" })));
    assert.equal(comparison.confirmed, false);
    assert.ok(comparison.reasons.length > 0);
  }
});

test("extra API models from covered providers do not invalidate matching cheapest automatic prices", () => {
  const scraper = new DiscoverCarsScraper(config);
  const api = [...leaderboard(), offer({ totalPrice: 180, offerId: "extra", carName: "Toyota Corolla" })];
  const dom = leaderboard({ carName: "Rendered car", offerId: "rendered" }).map((entry) => ({ ...entry, source: "dom" })).reverse();
  assert.equal(scraper.compareApiAndBrowserOutcomes(api, dom).confirmed, true);
});

test("unseen API providers outside Top3 and MM do not require a full DOM inventory", () => {
  const scraper = new DiscoverCarsScraper(config);
  const api = [...leaderboard(), offer({ provider: "Fourth", totalPrice: 200 })];
  const dom = leaderboard().map((entry) => ({ ...entry, source: "dom" }));
  assert.equal(scraper.compareApiAndBrowserOutcomes(api, dom).confirmed, true);
});

test("MM outside API Top3 is still required as independent DOM evidence", () => {
  const scraper = new DiscoverCarsScraper(config);
  const api = [...leaderboard(), offer({ provider: "MM Cars Rental", totalPrice: 200 })];
  const dom = leaderboard().map((entry) => ({ ...entry, source: "dom" }));
  const incomplete = scraper.compareApiAndBrowserOutcomes(api, dom);
  assert.equal(incomplete.confirmed, false);
  assert.ok(incomplete.reasons.includes("mm_missing_in_dom"));
  assert.equal(scraper.compareApiAndBrowserOutcomes(api, [...dom, offer({ provider: "MM Cars Rental", totalPrice: 200, source: "dom" })]).confirmed, true);
});

test("matching sparse API/DOM cannot confirm an incomplete Top3 leaderboard", () => {
  const scraper = new DiscoverCarsScraper(config);
  const comparison = scraper.compareApiAndBrowserOutcomes([offer()], [offer({ source: "dom" })]);
  assert.equal(comparison.confirmed, false);
  assert.ok(comparison.reasons.includes("dom_top3_incomplete"));
});

test("a cheaper independently rendered provider changes the decision-relevant leaderboard", () => {
  const scraper = new DiscoverCarsScraper(config);
  const dom = [...leaderboard().map((entry) => ({ ...entry, source: "dom" })), offer({ provider: "New", totalPrice: 80, source: "dom" })];
  const comparison = scraper.compareApiAndBrowserOutcomes(leaderboard(), dom);
  assert.equal(comparison.confirmed, false);
  assert.ok(comparison.reasons.includes("top3_provider_mismatch"));
});

test("the same rendered/API offer is not counted twice when only API has SIPP metadata", () => {
  const scraper = new DiscoverCarsScraper(config);
  const views = scraper.buildOfferViews([offer({ source: "dom" }), offer({ sipp: "EDAR", offerId: "a" })], LOCATION);
  assert.equal(views.all.length, 1);
  assert.equal(views.automatic.length, 1);
});

test("repeated observations of the same ID retain one current offer", () => {
  const scraper = new DiscoverCarsScraper(config);
  const views = scraper.buildOfferViews([offer({ offerId: "a" }), offer({ offerId: "a", totalPrice: 120 })], LOCATION);
  assert.equal(views.all.length, 1);
  assert.equal(views.all[0].totalPrice, 120);
});

for (const location of [LOCATION, GEO_LOCATION]) {
  for (const filter of ["automatic", "all"]) {
    test(`registered ${location === LOCATION ? "direct" : "geo"} domOnly flow preserves all/automatic DOM views (${filter})`, async (browser) => {
      const dom = [offer({ totalPrice: 120, transmission: "manual", offerId: "manual" }), ...leaderboard({ totalPrice: 120, offerId: "auto" })];
      const f = await fixture(browser, { location, dom, api: [offer()], config: { domOnly: true, transmissionFilter: filter } });
      try {
        const result = await f.scraper.runSingleLocation(location, async () => f.fakeBrowser);
        assert.equal(result.ok, true);
        assert.equal(result.cheapest.totalPrice, 120);
        assert.equal(result.sourceValidation.status, "dom_only");
        assert.equal(result.offerViews.all.length, 4);
        assert.equal(result.offerViews.automatic.length, 3);
        assert.ok([...result.results, ...result.offerViews.all].every((entry) => entry.source === "dom"));
        assert.deepEqual(result.offerViews.all.map((entry) => entry.offerId).sort(), ["auto", "manual", "second", "third"]);
      } finally { await f.close(); }
    });
  }
}

for (const location of [LOCATION, GEO_LOCATION]) {
test(`sampled ${location === LOCATION ? "direct" : "geo"} validation cannot confirm API100 against rendered DOM120`, async (browser) => {
  const f = await fixture(browser, { location, dom: leaderboard({ totalPrice: 120 }), api: leaderboard(), config: { apiDomSanityRate: 1 } });
  try {
    const result = await f.scraper.runSingleLocation(location, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "api_dom_conflict_dom_used");
    assert.equal(result.cheapest.totalPrice, 120);
    assert.equal(result.cheapest.source, "dom");
    assert.ok(result.sourceValidation.reasons.includes("top1_price_mismatch"));
  } finally { await f.close(); }
});
}

test("sampled API-only results remain unverified when DOM extraction fails", async (browser) => {
  const f = await fixture(browser, { api: [offer()], config: { apiDomSanityRate: 1 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_validation_failed_api_used");
    assert.equal(result.cheapest.source, "api");
  } finally { await f.close(); }
});

test("sampled complete matching DOM confirms API without changing API provenance", async (browser) => {
  const f = await fixture(browser, { dom: leaderboard(), api: leaderboard(), config: { apiDomSanityRate: 1 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_confirmed");
    assert.equal(result.cheapest.source, "api");
  } finally { await f.close(); }
});

for (const sampled of [true, false]) {
  test(`${sampled ? "sampled" : "final"} DOM scroll waits for all required Top3 providers plus MM`, async (browser) => {
    const mm = offer({ provider: "MM Cars Rental", totalPrice: 200 });
    const f = await fixture(browser, {
      domPasses: [[...leaderboard().slice(0, 2), mm], [...leaderboard(), mm]],
      api: [...leaderboard(), mm],
      config: sampled ? { apiDomSanityRate: 1 } : {
        domOnly: true, requiredDomProvidersByLocation: { [LOCATION]: ["Supplier", "Second", "Third", "MM Cars Rental"] }
      }
    });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.sourceValidation.status, sampled ? "dom_confirmed" : "dom_only");
      if (!sampled) assert.equal(result.offerViews.automatic.length, 4);
    } finally { await f.close(); }
  });
}

test("partial DOM after API failure cannot be relabeled as trusted dom_fallback", async (browser) => {
  const f = await fixture(browser, { dom: [offer()], config: { apiDomSanityRate: 1 } });
  f.scraper.runSingleLocationViaApi = async () => { throw new Error("Fixture API unavailable"); };
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
    assert.ok(result.sourceValidation.reasons.includes("api_failure"));
  } finally { await f.close(); }
});

test("all-view strict scrolling gathers the required automatic leaderboard", async (browser) => {
  const mm = offer({ provider: "MM Cars Rental", totalPrice: 200 });
  const f = await fixture(browser, {
    domPasses: [[...leaderboard().slice(0, 2), mm], [...leaderboard(), mm]],
    config: { domOnly: true, transmissionFilter: "all", requiredDomProvidersByLocation: { [LOCATION]: ["Supplier", "Second", "Third", "MM Cars Rental"] } }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(result.offerViews.automatic.length, 4);
  } finally { await f.close(); }
});

test("transparent cards and cards under transparent containers are not independent DOM evidence", async (browser) => {
  const f = await fixture(browser, {
    extraHtml: `<div style="opacity:0">${card(offer())}</div>`,
    config: { domOnly: true }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, false);
  } finally { await f.close(); }
});

test("partial genuine DOM remains dom_incomplete, not trusted dom_only", async (browser) => {
  const f = await fixture(browser, { dom: [offer()], config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
    assert.ok(result.sourceValidation.reasons.includes("dom_top3_incomplete"));
  } finally { await f.close(); }
});

test("invalid prices and mixed currencies cannot receive trusted dom_only provenance", async (browser) => {
  for (const overrides of [{ totalPrice: 0 }, { currency: "EUR" }]) {
    const f = await fixture(browser, { dom: leaderboard(overrides), config: { domOnly: true } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.sourceValidation.status, "dom_incomplete");
      assert.ok(result.sourceValidation.reasons.length > 0);
    } finally { await f.close(); }
  }
});

test("sampled incomplete DOM view is not confirmed even when selected Top1 matches", async (browser) => {
  const f = await fixture(browser, {
    dom: [offer()], api: [offer(), offer({ provider: "Second", totalPrice: 140 })],
    config: { apiDomSanityRate: 1, maxProvidersPerLocation: 1 }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.notEqual(result.sourceValidation.status, "dom_confirmed");
    assert.ok(result.sourceValidation.reasons.length > 0);
  } finally { await f.close(); }
});

test("sampled incomplete DOM plus price conflict never receives a trusted conflict status", async (browser) => {
  const f = await fixture(browser, {
    dom: [offer({ totalPrice: 120 })], api: [offer(), offer({ provider: "Second", totalPrice: 140 })],
    config: { apiDomSanityRate: 1 }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "api_dom_incomplete_dom_used");
    assert.ok(result.sourceValidation.reasons.includes("dom_top3_incomplete"));
  } finally { await f.close(); }
});

test("provider ranking verification does not demand identical car IDs or models", () => {
  const scraper = new DiscoverCarsScraper(config);
  const comparison = scraper.compareApiAndBrowserOutcomes(leaderboard({ offerId: "a" }), leaderboard({ offerId: "b", carName: "Other model" }).map((entry) => ({ ...entry, source: "dom" })));
  assert.equal(comparison.confirmed, true);
});

for (const filter of ["automatic", "all"]) {
  test(`DOM-only form fallback never promotes script/collector offers (${filter})`, async (browser) => {
    const f = await fixture(browser, { form: true, api: [offer()], config: { domOnly: true, apiFirst: false, transmissionFilter: filter } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.ok, false);
    } finally { await f.close(); }
  });
}

test("browser script/collector fallback remains explicitly unverified", async (browser) => {
  const f = await fixture(browser, { form: true, api: [offer()], config: { apiFirst: false } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, true);
    assert.equal(result.sourceValidation.status, "browser_unverified");
  } finally { await f.close(); }
});

test("hidden cards and supplier filter minima are not rendered DOM offers", async (browser) => {
  const f = await fixture(browser, {
    hidden: [offer()],
    extraHtml: '<div class="SearchFiltersGroup-FilterWrapper"><span class="SearchFiltersGroup-FilterLabel">Supplier</span><span class="SearchFiltersGroup-FilterMinPrice">PLN 100</span></div>',
    config: { domOnly: true, apiFirst: false, transmissionFilter: "all" }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, false);
  } finally { await f.close(); }
});

test("DOM-only form success retains manual and automatic views", async (browser) => {
  const f = await fixture(browser, { form: true, dom: [offer({ transmission: "manual" }), ...leaderboard()], config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, true);
    assert.equal(result.offerViews.all.length, 4);
    assert.equal(result.offerViews.automatic.length, 3);
    assert.equal(result.sourceValidation.status, "dom_only");
  } finally { await f.close(); }
});

test("unknown DOM transmission cannot be filled from an automatic API offer", async (browser) => {
  const f = await fixture(browser, { dom: [offer({ transmission: null })], api: [offer()], config: { domOnly: true, apiFirst: false } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, false);
  } finally { await f.close(); }
});

test("unsampled API-first path stays browser-free and api_unverified", async () => {
  const scraper = new DiscoverCarsScraper(config);
  scraper.runSingleLocationViaApi = async () => scraper.buildApiOutcome(apiPayload([offer()]), LOCATION, "fixture-api");
  scraper.shouldValidateApiOutcome = () => false;
  const result = await scraper.runSingleLocation(LOCATION, async () => { throw new Error("Browser must not be opened"); });
  assert.equal(result.ok, true);
  assert.equal(result.sourceValidation.status, "api_unverified");
});

async function main() {
  const browser = await chromium.launch({ headless: true });
  let failures = 0;
  try {
    for (const { name, fn } of tests) {
      try { await fn(browser); console.log(`PASS ${name}`); }
      catch (error) { failures += 1; console.error(`FAIL ${name}\n${error.stack}`); }
    }
  } finally { await browser.close(); }
  console.log(`${tests.length - failures}/${tests.length} offer integrity tests passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
