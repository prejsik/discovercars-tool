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
const card = (entry, hidden = false, leadingImageAlt = "") => `<article class="SearchCar"${hidden ? ' style="display:none"' : ""}${entry.offerId ? ` data-offer-id="${entry.offerId}"` : ""}${entry.domIndex == null ? "" : ` data-search-list-card-index="${entry.domIndex}"`}>
  ${leadingImageAlt ? `<img alt="${leadingImageAlt}">` : ""}
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
  const pages = options.domPages?.map((entries, page) => entries.map((entry, index) => ({
    ...entry, domIndex: index, offerId: entry.offerId ?? `page-${page + 1}-quote-${index}`
  })));
  const dom = options.dom || options.domPasses?.[0] || pages?.[0] || [];
  const api = options.api || [];
  const cardsFor = (entries) => `${entries.map((entry, index) => {
    const html = card(entry);
    return options.lazySupplierIndexes?.includes(index)
      ? html.replace(`<img alt="${entry.provider}">`, `<img data-lazy-provider="${entry.provider}" alt="">`) : html;
  }).join("")}${(options.hidden || []).map((entry) => card(entry, true)).join("")}${options.extraHtml || ""}`;
  const automaticControl = options.customAutomatic
    ? Array.from({ length: options.duplicateControls ? 4 : 1 }, (_, index) => `<li class="SearchFiltersGroup-FilterWrapper_transmission-a"${options.duplicateControls && index < 2 ? ' style="display:none"' : ""}><div class="SearchFiltersGroup-Filter"><div class="SearchFiltersGroup-FilterRow"><span class="SearchFiltersGroup-FilterLabel">Automatic Transmission</span><span class="SearchFiltersGroup-FilterMinPrice">PLN 100</span></div></div></li>`).join("")
    : '<label><input type="checkbox" id="automatic">Automatic Transmission</label>';
  const htmlFor = (entries) => `${options.automaticControl === false ? "" : automaticControl}
    ${options.lazySupplierIndexes || options.cardMinHeight ? `<style>.SearchCar { min-height: ${options.cardMinHeight || 900}px; }</style>` : ""}
    ${options.sortControl === false ? "" : '<label>Sort by <select aria-label="Sort by"><option value="recommended">Recommended</option><option value="price">Price</option></select></label>'}
    ${options.countText ? `<div class="SearchSorting-ShownCars">${options.countText}</div>` : options.expectedCount == null ? "" : `<div class="SearchSorting-ShownCars">${options.expectedCount} offers found</div>`}
    ${options.secondaryCount == null ? "" : `<span class="showing-cars">${options.secondaryCount}</span>`}
    <main>${cardsFor(entries)}</main>
    ${pages ? '<div class="Pagination"><button class="Pagination-Button" aria-current="page">1</button><button class="Pagination-NavigationButton_next" aria-label="Next page">Next page</button></div>' : ""}
    ${options.lazyPending ? '<div class="SearchCarList-Loader" role="progressbar">Loading offers</div>' : ""}
    ${options.cookieOverlay ? '<div id="onetrust-banner-sdk" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4)"><button id="onetrust-accept-btn-handler">Accept all cookies</button></div>' : ""}
    <script type="application/json">${JSON.stringify(apiPayload(api))}</script>
    <script>
      (() => {
      window.revealLazySuppliers = () => {
        for (const image of document.querySelectorAll('[data-lazy-provider]')) {
          const rect = image.closest('.SearchCar').getBoundingClientRect();
          if (rect.top < window.innerHeight && rect.bottom > 0) image.alt = image.dataset.lazyProvider;
        }
      };
      window.addEventListener('scroll', window.revealLazySuppliers);
      window.applyControls = () => {
        if ((document.querySelector('#automatic')?.checked || document.querySelector('.SearchFiltersGroup-Filter_isActive')) && ${options.filterWorks !== false}) {
          for (const entry of document.querySelectorAll('main > .SearchCar')) {
            if (/manual transmission/i.test(entry.innerText)) entry.style.display = 'none';
          }
        }
        if (document.querySelector('select')?.value === 'price' && ${options.sortWorks !== false}) {
          const entries = [...document.querySelectorAll('main > .SearchCar')];
          entries.sort((a, b) => Number(a.innerText.match(/Total for 1 day \\w+ ([\\d.]+)/)?.[1]) - Number(b.innerText.match(/Total for 1 day \\w+ ([\\d.]+)/)?.[1]));
          for (const entry of entries) document.querySelector('main').append(entry);
        }
      };
      document.querySelector('#automatic')?.addEventListener('change', window.applyControls);
      for (const row of document.querySelectorAll('.SearchFiltersGroup-FilterWrapper_transmission-a')) {
        row.addEventListener('click', () => {
          const active = !row.querySelector('.SearchFiltersGroup-Filter_isActive');
          for (const filter of document.querySelectorAll('.SearchFiltersGroup-Filter')) filter.classList.toggle('SearchFiltersGroup-Filter_isActive', active);
          window.applyControls();
        });
      }
      document.querySelector('#onetrust-accept-btn-handler')?.addEventListener('click', () => document.querySelector('#onetrust-banner-sdk').remove());
      const pages = ${JSON.stringify(pages?.map(cardsFor) || [])};
      let currentPage = 0;
      document.querySelector('.Pagination-NavigationButton_next')?.addEventListener('click', () => {
        if (${options.paginationWorks !== false} && currentPage + 1 < pages.length) {
          currentPage += 1;
          document.querySelector('.Pagination [aria-current="page"]').textContent = String(currentPage + 1);
          document.querySelector('.Pagination-NavigationButton_next').disabled = currentPage + 1 === pages.length;
          const replaceCards = () => {
            document.querySelector('main').innerHTML = pages[currentPage];
            window.applyControls();
            window.scrollTo(0, 0);
          };
          if (${Boolean(options.paginationDelayPasses || options.paginationNeverReplaces)}) {
            window.replacePendingPage = replaceCards;
            window.paginationWaits = 0;
          } else {
            replaceCards();
          }
        }
      });
      document.querySelector('select')?.addEventListener('change', window.applyControls);
      })();
    </script>`;
  let pass = 0;
  let readErrors = options.readErrors || 0;
  let readAttempts = 0;
  const page = {
    goto: async () => realPage.setContent(htmlFor(dom)),
    evaluate: (...args) => {
      if (args[1]?.readState) readAttempts += 1;
      if (args[1]?.readState && options.hangRead) return new Promise(() => {});
      if (args[1]?.readState && readErrors > 0) {
        readErrors -= 1;
        return Promise.reject(new Error("Fixture navigation interrupted DOM read"));
      }
      return realPage.evaluate(...args);
    },
    content: () => realPage.content(),
    locator: (...args) => realPage.locator(...args),
    getByRole: (...args) => realPage.getByRole(...args),
    getByText: (...args) => realPage.getByText(...args),
    waitForTimeout: async () => {
      if (options.lazySupplierIndexes) await realPage.evaluate(() => window.revealLazySuppliers());
      if (options.paginationDelayPasses && !options.paginationNeverReplaces) {
        await realPage.evaluate((passes) => {
          if (window.replacePendingPage && ++window.paginationWaits >= passes) {
            const replace = window.replacePendingPage;
            window.replacePendingPage = null;
            replace();
          }
        }, options.paginationDelayPasses);
      }
      if (options.domPasses && pass < options.domPasses.length - 1) {
        pass += 1;
        await realPage.locator('main').evaluate((element, html) => { element.innerHTML = html; window.applyControls(); }, cardsFor(options.domPasses[pass]));
        if (options.clearPendingAfterPass) await realPage.locator('.SearchCarList-Loader').evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
      }
    },
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    on: () => {}
  };
  let contextCloseCount = 0;
  const fakeBrowser = { newContext: async () => ({ newPage: async () => page, close: async () => { contextCloseCount += 1; } }) };
  const scraper = new DiscoverCarsScraper({ ...config, ...options.config, apiDomDriftState: { by_location: {} } });
  scraper.configureContext = async () => {};
  if (!options.cookieOverlay) scraper.acceptCookies = async () => {};
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
  return { scraper, fakeBrowser, page: realPage, readAttempts: () => readAttempts,
    contextCloseCount: () => contextCloseCount, close: () => context.close() };
}

test("pending lazy loading cannot certify an already visible three-supplier prefix", async (browser) => {
  const f = await fixture(browser, { dom: leaderboard(), lazyPending: true,
    config: { domOnly: true, domReadMaxPasses: 3 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
    assert.equal(result.domEvidence.read_pass_count, 3);
  } finally { await f.close(); }
});

test("ranking waits for pending cards to settle at the new cheapest price", async (browser) => {
  const f = await fixture(browser, { domPasses: [leaderboard(), leaderboard({ totalPrice: 20 })],
    lazyPending: true, clearPendingAfterPass: true, config: { domOnly: true, domReadMaxPasses: 4 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.cheapest.totalPrice, 20);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.ok(result.domEvidence.read_pass_count >= 3, "the changed prefix must settle on a second independent read");
    assert.equal(result.sourceValidation.status, "dom_only");
  } finally { await f.close(); }
});

test("an offer-shaped article outside actual card slots cannot join the trusted ranking", async (browser) => {
  const unrelated = card(offer({ provider: "Extraneous", totalPrice: 1 })).replace('class="SearchCar"', 'class="offer"');
  const f = await fixture(browser, { dom: leaderboard(), extraHtml: unrelated, config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.cheapest.totalPrice, 100);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.offerViews.automatic.some((entry) => entry.provider === "Extraneous"), false);
  } finally { await f.close(); }
});

test("a cheaper observed suffix invalidates the entire apparent price-sorted prefix", async (browser) => {
  const f = await fixture(browser, { dom: [...leaderboard(), offer({ provider: "Cheaper", totalPrice: 20 })],
    sortWorks: false, config: { domOnly: true, domReadMaxPasses: 3 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
  } finally { await f.close(); }
});

test("a hung rendered evaluation exhausts the read deadline and closes only the owned context", async (browser) => {
  const f = await fixture(browser, { dom: leaderboard(), hangRead: true,
    config: { domOnly: true, domReadTimeoutMs: 500 } });
  const started = Date.now();
  let artifactAttempts = 0;
  let fallbackAttempts = 0;
  f.scraper.captureFailureArtifacts = async () => { artifactAttempts += 1; await new Promise(() => {}); };
  f.scraper.fillSearchForm = async () => { fallbackAttempts += 1; throw new Error("Unexpected timeout fallback"); };
  let guard;
  try {
    const result = await Promise.race([
      f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser),
      new Promise((resolve) => { guard = setTimeout(() => resolve({ hung: true }), 2000); })
    ]);
    assert.equal(result.hung, undefined, "a hung evaluate must not outlive the bounded read budget");
    assert.equal(result.ok, false);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(f.readAttempts(), 1);
    assert.equal(f.contextCloseCount(), 1);
    assert.equal(artifactAttempts, 0, "deadline failures must not attempt potentially hung screenshots or content reads");
    assert.equal(fallbackAttempts, 0, "the abandoned page must not be navigated again");
    assert.ok(Date.now() - started < 2000);
  } finally { clearTimeout(guard); await f.close(); }
});

test("run exposes independently rendered ranking evidence without claiming a full listing", async (browser) => {
  const dom = [...leaderboard(), offer({ provider: "MM Cars Rental", totalPrice: 200, offerId: "mm" })];
  const f = await fixture(browser, { dom, expectedCount: 12, config: { domOnly: true, locations: [LOCATION],
    artifactsDir: "artifacts", browserProvider: { getBrowser: async () => f.fakeBrowser },
    requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental"] } } });
  try {
    const result = await f.scraper.run();
    assert.deepEqual(result.domEvidenceByLocation[LOCATION], {
      automatic_filter_confirmed: true, price_sort_confirmed: true, ranking_complete: true,
      listing_complete: false, expected_offer_count: 12, observed_offer_count: 4, read_pass_count: 2
    });
    assert.ok(result.offerViewsByLocation[LOCATION].automatic.every((entry) => entry.source === "dom"));
  } finally { await f.close(); }
});

test("adaptive DOM reading reaches delayed required suppliers beyond eight passes", async (browser) => {
  const partial = leaderboard().slice(0, 2);
  const complete = [...leaderboard(), offer({ provider: "MM Cars Rental", totalPrice: 200, offerId: "mm" })];
  const f = await fixture(browser, { domPasses: [...Array.from({ length: 9 }, () => partial), complete], expectedCount: 4,
    config: { domOnly: true, requiredDomProvidersByLocation: { [LOCATION]: ["Third", "MM Cars Rental"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.domEvidence.observed_offer_count, 4);
    assert.ok(result.domEvidence.read_pass_count > 8 && result.domEvidence.read_pass_count <= 24);
  } finally { await f.close(); }
});

test("a proven two-supplier automatic listing can be trusted without weakening the comparator", async (browser) => {
  const dom = [offer({ offerId: "a" }), offer({ provider: "MM Cars Rental", totalPrice: 140, offerId: "mm" }),
    offer({ provider: "MM Cars Rental", totalPrice: 160, offerId: "mm2", carName: "Toyota Corolla" })];
  const f = await fixture(browser, { dom, expectedCount: 3, config: { domOnly: true,
    requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.domEvidence.listing_complete, true);
    assert.equal(result.domEvidence.observed_offer_count, 3);
    assert.equal(f.scraper.compareApiAndBrowserOutcomes(dom, result.offerViews.automatic).confirmed, false);
  } finally { await f.close(); }
});

test("distinct rendered duplicate-price cards count toward listing completeness before quote dedupe", async (browser) => {
  const dom = [offer({ domIndex: 0 }), offer({ domIndex: 1 }),
    offer({ provider: "MM Cars Rental", totalPrice: 140, domIndex: 2 })];
  const f = await fixture(browser, { dom, expectedCount: 3, config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.observed_offer_count, 3);
    assert.equal(result.domEvidence.listing_complete, true);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.offerViews.automatic.length, 2);
    assert.equal(result.sourceValidation.status, "dom_only");
  } finally { await f.close(); }
});

for (const options of [{}, { expectedCount: 8 }, { expectedCount: 2, lazyPending: true }]) {
  test(`two visible suppliers alone cannot prove completion (${JSON.stringify(options)})`, async (browser) => {
    const f = await fixture(browser, { ...options, dom: leaderboard().slice(0, 2), config: { domOnly: true, domReadMaxPasses: 3 } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.sourceValidation.status, "dom_incomplete");
      assert.equal(result.domEvidence.ranking_complete, false);
      assert.equal(result.domEvidence.listing_complete, false);
      assert.equal(result.domEvidence.read_pass_count, 3);
    } finally { await f.close(); }
  });
}

for (const options of [
  { automaticControl: false }, { sortControl: false },
  { sortWorks: false, dom: leaderboard().reverse() },
  { filterWorks: false, dom: [offer({ transmission: "manual", totalPrice: 50 }), ...leaderboard()] },
  { dom: [offer(), offer({ provider: "", totalPrice: 120 }), ...leaderboard().slice(1)] }
]) {
  test(`unconfirmed controls or a card gap cannot produce complete ranking (${JSON.stringify(options)})`, async (browser) => {
    const f = await fixture(browser, { dom: leaderboard(), ...options, config: { domOnly: true, domReadMaxPasses: 3 } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      if (options.filterWorks === false) {
        assert.equal(result.ok, false, "a manual cheapest slot leaves no valid automatic prefix");
        assert.match(result.error.message, /No automatic offers/);
      } else {
        assert.equal(result.sourceValidation.status, "dom_incomplete");
      }
      assert.equal(result.domEvidence.ranking_complete, false);
      assert.equal(result.domEvidence.listing_complete, false);
    } finally { await f.close(); }
  });
}

test("complete inventory proves the new ranking even when an API-required supplier disappeared", async (browser) => {
  const f = await fixture(browser, { dom: leaderboard(), expectedCount: 3, config: { domOnly: true, domReadMaxPasses: 3,
    requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.listing_complete, true);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.ok(result.offerViews.automatic.every((entry) => entry.provider !== "MM Cars Rental"));
  } finally { await f.close(); }
});

test("sampled automatic DOM filtering preserves the unfiltered API report views", async (browser) => {
  const api = [offer({ transmission: "manual", totalPrice: 90, offerId: "manual" }), ...leaderboard()];
  const f = await fixture(browser, { dom: api, api, config: { apiDomSanityRate: 1 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "dom_confirmed");
    assert.equal(result.offerViews.all.length, 4);
    assert.equal(result.offerViews.automatic.length, 3);
    assert.ok(result.offerViews.all.every((entry) => entry.source === "api"));
    assert.equal(result.domEvidence.automatic_filter_confirmed, true);
    assert.equal(await f.page.locator('#automatic').isChecked(), true);
    assert.equal(await f.page.locator('main > .SearchCar:visible').count(), 3);
  } finally { await f.close(); }
});

test("browser-preferred automatic repricing preserves the separate unfiltered API all view", async (browser) => {
  const api = [offer({ transmission: "manual", totalPrice: 90, offerId: "manual" }), ...leaderboard()];
  const f = await fixture(browser, { dom: leaderboard({ totalPrice: 120 }), api, config: { apiDomSanityRate: 1 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.sourceValidation.status, "api_dom_conflict_dom_used");
    assert.equal(result.cheapest.totalPrice, 120);
    assert.equal(result.cheapest.source, "dom");
    assert.equal(result.offerViews.automatic.length, 3);
    assert.ok(result.offerViews.automatic.every((entry) => entry.source === "dom"));
    assert.equal(result.offerViews.all.length, 4);
    assert.ok(result.offerViews.all.every((entry) => entry.source === "api"));
    assert.equal(result.offerViews.all.find((entry) => entry.transmission === "manual").totalPrice, 90);
    assert.equal(result.offerViews.all.find((entry) => entry.provider === "Supplier" && entry.transmission === "automatic").totalPrice, 100);
  } finally { await f.close(); }
});

test("unfiltered browser report collection leaves transmission UI untouched", async (browser) => {
  const f = await fixture(browser, { dom: [offer({ transmission: "manual", totalPrice: 90 }), ...leaderboard()],
    config: { apiFirst: false, transmissionFilter: "all" } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.offerViews.all.length, 4);
    assert.equal(await f.page.locator('#automatic').isChecked(), false);
    assert.equal(result.domEvidence.automatic_filter_confirmed, false);
    assert.equal(result.domEvidence.ranking_complete, false);
  } finally { await f.close(); }
});

test("DiscoverCars custom automatic checkbox is clicked and its active state confirmed", async (browser) => {
  const f = await fixture(browser, { customAutomatic: true, dom: [offer({ transmission: "manual", totalPrice: 50 }), ...leaderboard()],
    config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.automatic_filter_confirmed, true);
    assert.equal(result.domEvidence.price_sort_confirmed, true);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.offerViews.all.length, 3);
  } finally { await f.close(); }
});

test("fast direct DOM search clears OneTrust before selecting a duplicated rendered automatic filter", async (browser) => {
  const f = await fixture(browser, { customAutomatic: true, duplicateControls: true, cookieOverlay: true,
    dom: [offer({ transmission: "manual", totalPrice: 50 }), ...leaderboard()], config: { domOnly: true, domReadMaxPasses: 3 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.automatic_filter_confirmed, true);
    assert.equal(result.domEvidence.price_sort_confirmed, true);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(await f.page.locator('#onetrust-banner-sdk').count(), 0);
    assert.equal(await f.page.locator('main > .SearchCar:visible').count(), 3);
  } finally { await f.close(); }
});

for (const countText of ["Showing 2 of 714 offers", "Showing 2 out of 714 offers", "2 offers found"]) {
  test(`filtered rendered count can prove a two-supplier market (${countText})`, async (browser) => {
    const f = await fixture(browser, { dom: leaderboard().slice(0, 2), countText, config: { domOnly: true } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.domEvidence.expected_offer_count, 2);
      assert.equal(result.domEvidence.listing_complete, true);
      assert.equal(result.domEvidence.ranking_complete, true);
      assert.equal(result.sourceValidation.status, "dom_only");
    } finally { await f.close(); }
  });
}

test("the authoritative filtered composite count is not overwritten by an unfiltered descendant total", async (browser) => {
  const f = await fixture(browser, { dom: leaderboard().slice(0, 2), countText: "Showing 2 out of 714 offers",
    secondaryCount: 714, config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.expected_offer_count, 2);
    assert.equal(result.domEvidence.listing_complete, true);
    assert.equal(result.sourceValidation.status, "dom_only");
  } finally { await f.close(); }
});

test("a complete small market is independently read across pagination with page-local slot indexes", async (browser) => {
  const f = await fixture(browser, { domPages: [
    [offer({ provider: "MM Cars Rental" }), offer({ provider: "MM Cars Rental" })],
    [offer({ provider: "CarNet", totalPrice: 140 }), offer({ provider: "CarNet", totalPrice: 160 })]
  ], countText: "Showing 4 out of 9 offers", config: { domOnly: true, domReadMaxPasses: 8,
    requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental", "CarNet", "Disappeared supplier"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.expected_offer_count, 4);
    assert.equal(result.domEvidence.observed_offer_count, 4);
    assert.equal(result.domEvidence.listing_complete, true);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(await f.page.locator('.Pagination [aria-current="page"]').innerText(), "2");
    assert.deepEqual([...new Set(result.offerViews.automatic.map((entry) => entry.provider))], ["MM Cars Rental", "CarNet"]);
    assert.ok(result.domEvidence.read_pass_count <= 8);
  } finally { await f.close(); }
});

test("pagination cannot skip an unparsed card gap on the preceding page", async (browser) => {
  const f = await fixture(browser, { domPages: [[offer(), offer({ provider: "" })], leaderboard()],
    expectedCount: 5, config: { domOnly: true, domReadMaxPasses: 3 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(await f.page.locator('.Pagination [aria-current="page"]').innerText(), "1");
    assert.equal(result.sourceValidation.status, "dom_incomplete");
  } finally { await f.close(); }
});

for (const neverReplaces of [false, true]) {
  test(`a changed active-page label cannot reuse stale preceding-page cards (${neverReplaces ? "never replaced" : "delayed replacement"})`, async (browser) => {
    const f = await fixture(browser, { domPages: [
      [offer({ provider: "MM Cars Rental" }), offer({ provider: "MM Cars Rental" })],
      [offer({ provider: "CarNet", totalPrice: 140 }), offer({ provider: "CarNet", totalPrice: 160 })]
    ], expectedCount: 4, paginationDelayPasses: 3, paginationNeverReplaces: neverReplaces,
    config: { domOnly: true, domReadMaxPasses: 8,
      requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental", "CarNet", "Disappeared supplier"] } } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      if (neverReplaces) {
        assert.equal(result.domEvidence.observed_offer_count, 2, "old cards cannot be counted again at a new page offset");
        assert.equal(result.domEvidence.listing_complete, false);
        assert.equal(result.domEvidence.ranking_complete, false);
        assert.equal(result.sourceValidation.status, "dom_incomplete");
      } else {
        assert.equal(result.domEvidence.listing_complete, true);
        assert.equal(result.domEvidence.observed_offer_count, 4);
        assert.equal(result.sourceValidation.status, "dom_only");
        assert.equal(result.offerViews.automatic.find((entry) => entry.provider === "CarNet").totalPrice, 140);
        assert.ok(result.domEvidence.read_pass_count >= 5);
      }
    } finally { await f.close(); }
  });
}

test("remounting a different subset of the old virtual page is not replacement-card evidence", async (browser) => {
  const previous = [offer({ provider: "MM Cars Rental", domIndex: 0, offerId: "old-0" }),
    offer({ provider: "MM Cars Rental", domIndex: 1, offerId: "old-1" })];
  const f = await fixture(browser, { domPages: [previous, [offer({ provider: "CarNet", totalPrice: 140 }),
    offer({ provider: "CarNet", totalPrice: 160 })]], domPasses: [previous, previous.slice(1), previous],
  cardMinHeight: 500, paginationNeverReplaces: true, expectedCount: 4,
  config: { domOnly: true, domReadMaxPasses: 8, requiredDomProvidersByLocation: { [LOCATION]: ["CarNet"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(await f.page.locator('.Pagination [aria-current="page"]').innerText(), "2");
    assert.equal(result.domEvidence.observed_offer_count, 2);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
  } finally { await f.close(); }
});

for (const partialReplacement of [false, true]) {
  test(`all next-page quotes need fresh identifiers (${partialReplacement ? "partial replacement" : "name-only change"})`, async (browser) => {
    const previous = [offer({ offerId: "old-0" }), offer({ offerId: "old-1" })];
    const next = partialReplacement
      ? [previous[0], offer({ provider: "CarNet", totalPrice: 140, offerId: "new-1" })]
      : [offer({ offerId: "old-0", carName: "Toyota Yaris or similar" }), previous[1]];
    const f = await fixture(browser, { domPages: [previous, next], expectedCount: 4,
      config: { domOnly: true, domReadMaxPasses: 6, requiredDomProvidersByLocation: { [LOCATION]: ["Unread supplier"] } } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.domEvidence.listing_complete, false);
      assert.equal(result.domEvidence.ranking_complete, false);
      assert.equal(result.domEvidence.observed_offer_count, 2);
      assert.equal(result.sourceValidation.status, "dom_incomplete");
    } finally { await f.close(); }
  });
}

test("a cheaper second page cannot masquerade as a sorted complete automatic listing", async (browser) => {
  const f = await fixture(browser, { domPages: [[offer({ totalPrice: 140 })], [offer({ provider: "Second", totalPrice: 100 })]],
    expectedCount: 2, config: { domOnly: true, domReadMaxPasses: 5 } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.observed_offer_count, 2);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
  } finally { await f.close(); }
});

test("all next-page quotes stay fresh when a retained old card appears on a later read", async (browser) => {
  const f = await fixture(browser, { domPages: [
    [offer({ provider: "MM Cars Rental", offerId: "old-0" }), offer({ provider: "MM Cars Rental", offerId: "old-1" })],
    [offer({ provider: "MM Cars Rental", offerId: "new-0" }), offer({ provider: "CarNet", offerId: "new-1" }),
      offer({ provider: "MM Cars Rental", offerId: "old-1" })]
  ], expectedCount: 5, config: { domOnly: true, domReadMaxPasses: 8,
    requiredDomProvidersByLocation: { [LOCATION]: ["Unread supplier"] } } });
  const extract = f.scraper.extractOffersFromDom.bind(f.scraper);
  let secondPageReads = 0;
  f.scraper.extractOffersFromDom = async (...args) => {
    if (await f.page.locator('.Pagination [aria-current="page"]').innerText() === "2") {
      await f.page.locator('[data-offer-id="old-1"]').evaluate((node, hidden) => {
        node.style.display = hidden ? "none" : "";
      }, ++secondPageReads === 1);
    }
    return extract(...args);
  };
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
  } finally { await f.close(); }
});

test("all next-page quotes bind one identifier to one cached slot across virtual reads", async (browser) => {
  const f = await fixture(browser, { domPages: [
    [offer({ provider: "MM Cars Rental", offerId: "old-0" }), offer({ provider: "MM Cars Rental", offerId: "old-1" })],
    [offer({ provider: "CarNet", offerId: "new-0" }), offer({ provider: "CarNet", offerId: "new-1" })]
  ], expectedCount: 4, config: { domOnly: true, domReadMaxPasses: 8,
    requiredDomProvidersByLocation: { [LOCATION]: ["Unread supplier"] } } });
  const extract = f.scraper.extractOffersFromDom.bind(f.scraper);
  let secondPageReads = 0;
  f.scraper.extractOffersFromDom = async (...args) => {
    if (await f.page.locator('.Pagination [aria-current="page"]').innerText() === "2") {
      const html = card(offer({ provider: "CarNet", offerId: "new-0", domIndex: ++secondPageReads === 1 ? 0 : 1 }));
      await f.page.locator('main').evaluate((node, content) => { node.innerHTML = content; }, html);
    }
    return extract(...args);
  };
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.listing_complete, false);
    assert.equal(result.domEvidence.ranking_complete, false);
    assert.equal(result.sourceValidation.status, "dom_incomplete");
  } finally { await f.close(); }
});

test("indexed virtual cards can complete a contiguous price prefix across passes", async (browser) => {
  const entries = [...leaderboard(), offer({ provider: "MM Cars Rental", totalPrice: 200, offerId: "mm" })]
    .map((entry, index) => ({ ...entry, domIndex: index }));
  const f = await fixture(browser, { domPasses: [entries.slice(0, 2), entries.slice(2)], expectedCount: 10,
    config: { domOnly: true, requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.domEvidence.observed_offer_count, 4);
    assert.equal(result.domEvidence.listing_complete, false);
  } finally { await f.close(); }
});

test("the earliest unparsed rendered card is brought into view before skipping to the list tail", async (browser) => {
  const dom = [...leaderboard(), offer({ provider: "MM Cars Rental", totalPrice: 200 })]
    .map((entry, domIndex) => ({ ...entry, domIndex }));
  const f = await fixture(browser, { dom, expectedCount: 4, lazySupplierIndexes: [2],
    config: { domOnly: true, domReadMaxPasses: 6, requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental"] } } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.domEvidence.observed_offer_count, 4);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(result.offerViews.automatic.find((entry) => entry.provider === "Third").totalPrice, 160);
    assert.ok(result.domEvidence.read_pass_count <= 6);
  } finally { await f.close(); }
});

test("an indexed missing cheapest or middle card cannot be filled by API evidence", async (browser) => {
  for (const indices of [[1, 2, 3], [0, 2, 3]]) {
    const dom = leaderboard().map((entry, index) => ({ ...entry, domIndex: indices[index] }));
    const f = await fixture(browser, { dom, api: leaderboard(), config: { domOnly: true, domReadMaxPasses: 3 } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.domEvidence.ranking_complete, false);
      if (indices[0] !== 0) {
        assert.equal(result.ok, false, "quotes after a missing cheapest card cannot form a returned prefix");
        assert.match(result.error.message, /No automatic offers/);
      } else {
        assert.equal(result.sourceValidation.status, "dom_incomplete");
        assert.equal(result.offerViews.automatic.length, 1, "quotes beyond the middle gap are excluded");
      }
    } finally { await f.close(); }
  }
});

test("a transient rendered read failure is retried and counted", async (browser) => {
  const f = await fixture(browser, { dom: leaderboard(), readErrors: 1, config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.domEvidence.ranking_complete, true);
    assert.equal(result.domEvidence.read_pass_count, 3);
    assert.equal(result.sourceValidation.status, "dom_only");
  } finally { await f.close(); }
});

test("failed run output keeps bounded incomplete DOM evidence", async (browser) => {
  const f = await fixture(browser, { readErrors: 100, config: { domOnly: true, domReadMaxPasses: 3,
    locations: [LOCATION], artifactsDir: "artifacts", browserProvider: { getBrowser: async () => f.fakeBrowser } } });
  try {
    const result = await f.scraper.run();
    assert.equal(result.failures.length, 1);
    assert.equal(result.domEvidenceByLocation[LOCATION].ranking_complete, false);
    assert.equal(result.domEvidenceByLocation[LOCATION].observed_offer_count, 0);
    assert.equal(result.domEvidenceByLocation[LOCATION].read_pass_count, 3);
    assert.equal(f.readAttempts(), 3, "the per-location budget also bounds fallback reads");
  } finally { await f.close(); }
});

const supplierLogoNames = ["CarFree Rent a Car", "AddCar", "GO Rental Cars", "Dolcar Rent a Car"];

for (const provider of supplierLogoNames) {
  test(`rendered supplier logo preserves the provider name ${provider}`, async (browser) => {
    const f = await fixture(browser, { dom: [offer({ provider })], config: { domOnly: true } });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.ok, true);
      assert.deepEqual(result.offerViews.automatic.map((entry) => entry.provider), [provider]);
      assert.equal(result.cheapest.totalPrice, 100);
      assert.equal(result.cheapest.source, "dom");
      assert.equal(result.sourceValidation.status, "dom_incomplete");
    } finally { await f.close(); }
  });
}

test("card-scoped supplier logo takes precedence over a preceding generic car image", async (browser) => {
  const f = await fixture(browser, {
    extraHtml: card(offer({ provider: "GO Rental Cars" }), false, "Renault Captur"),
    config: { domOnly: true }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, true);
    assert.deepEqual(result.offerViews.automatic.map((entry) => entry.provider), ["GO Rental Cars"]);
  } finally { await f.close(); }
});

test("real rendered supplier logos confirm the matching API leaderboard through the comparator", async (browser) => {
  const api = [
    offer({ provider: "MM Cars Rental", totalPrice: 100 }),
    offer({ provider: "CarFree Rent a Car", totalPrice: 140 }),
    offer({ provider: "AddCar", totalPrice: 160 }),
    offer({ provider: "GO Rental Cars", totalPrice: 180 }),
    offer({ provider: "Dolcar Rent a Car", totalPrice: 200 })
  ];
  const f = await fixture(browser, {
    dom: api,
    config: { domOnly: true, requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental", ...supplierLogoNames] } }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, true);
    const dom = result.offerViews.automatic;
    const comparison = f.scraper.compareApiAndBrowserOutcomes(api, dom);
    assert.deepEqual(comparison.reasons, []);
    assert.equal(comparison.confirmed, true);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.deepEqual(dom.map((entry) => entry.provider), ["MM Cars Rental", ...supplierLogoNames]);
    assert.ok(dom.every((entry) => entry.source === "dom" && entry.transmission === "automatic"));
  } finally { await f.close(); }
});

test("hidden supplier-logo cards cannot complete or confirm the rendered leaderboard", async (browser) => {
  for (const provider of supplierLogoNames) {
    const api = [offer({ provider: "MM Cars Rental", totalPrice: 100 }), offer({ provider: "Budget", totalPrice: 140 }),
      offer({ provider, totalPrice: 160 })];
    const f = await fixture(browser, {
      dom: api.slice(0, 2), hidden: [api[2]],
      config: { domOnly: true, requiredDomProvidersByLocation: { [LOCATION]: ["MM Cars Rental", "Budget", provider] } }
    });
    try {
      const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
      assert.equal(result.ok, true);
      assert.deepEqual(result.offerViews.automatic.map((entry) => entry.provider), ["MM Cars Rental", "Budget"]);
      assert.equal(result.sourceValidation.status, "dom_incomplete");
      const comparison = f.scraper.compareApiAndBrowserOutcomes(api, result.offerViews.automatic);
      assert.equal(comparison.confirmed, false);
      assert.ok(comparison.reasons.includes("dom_top3_incomplete"));
      assert.ok(comparison.reasons.includes("dom_required_provider_missing"));
    } finally { await f.close(); }
  }
});

test("generic image fallback keeps its vehicle and category guards without a supplier logo", async (browser) => {
  const f = await fixture(browser, {
    extraHtml: `<article class="SearchCar"><h3 class="CarTitle-Name">Toyota Yaris</h3>
      <img alt="Toyota Yaris"><img alt="SUV"><img alt="Compact"><img alt="Rental Cars">
      <img alt="X"><img alt="${"x".repeat(81)}"><img alt="Budget">
      <p>Automatic transmission</p><p>Total for 1 day PLN 100</p></article>`,
    config: { domOnly: true }
  });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, true);
    assert.deepEqual(result.offerViews.automatic.map((entry) => entry.provider), ["Budget"]);
  } finally { await f.close(); }
});

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
    test(`registered ${location === LOCATION ? "direct" : "geo"} domOnly flow retains only actually filtered DOM views (${filter})`, async (browser) => {
      const dom = [offer({ totalPrice: 120, transmission: "manual", offerId: "manual" }), ...leaderboard({ totalPrice: 120, offerId: "auto" })];
      const f = await fixture(browser, { location, dom, api: [offer()], config: { domOnly: true, transmissionFilter: filter } });
      try {
        const result = await f.scraper.runSingleLocation(location, async () => f.fakeBrowser);
        assert.equal(result.ok, true);
        assert.equal(result.cheapest.totalPrice, 120);
        assert.equal(result.sourceValidation.status, "dom_only");
        assert.equal(result.offerViews.all.length, 3);
        assert.equal(result.offerViews.automatic.length, 3);
        assert.ok([...result.results, ...result.offerViews.all].every((entry) => entry.source === "dom"));
        assert.deepEqual(result.offerViews.all.map((entry) => entry.offerId).sort(), ["auto", "second", "third"]);
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
      if (overrides.totalPrice === 0) {
        assert.equal(result.ok, false, "an invalid cheapest slot leaves no valid returned prefix");
        assert.match(result.error.message, /No automatic offers/);
      } else {
        assert.equal(result.sourceValidation.status, "dom_incomplete");
        assert.ok(result.sourceValidation.reasons.length > 0);
      }
      assert.equal(result.domEvidence.ranking_complete, false);
      assert.equal(result.domEvidence.listing_complete, false);
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

test("DOM-only form success retains actual automatic-filtered views", async (browser) => {
  const f = await fixture(browser, { form: true, dom: [offer({ transmission: "manual" }), ...leaderboard()], config: { domOnly: true } });
  try {
    const result = await f.scraper.runSingleLocation(LOCATION, async () => f.fakeBrowser);
    assert.equal(result.ok, true);
    assert.equal(result.offerViews.all.length, 3);
    assert.equal(result.offerViews.automatic.length, 3);
    assert.equal(result.sourceValidation.status, "dom_only");
    assert.equal(await f.page.locator('#automatic').isChecked(), true);
    assert.equal(await f.page.locator('main > .SearchCar:visible').count(), 3);
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
