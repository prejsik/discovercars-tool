const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");
const { chromium } = require("playwright");
const { DiscoverCarsScraper } = require("../src/discovercars/scraper");

const location = "Gdansk Airport (GDN)";

function offerCard({ provider, price, index, id = index, currency = "PLN", transmission = "Automatic transmission" }) {
  return `<div class="SearchList-Card" data-search-list-card-index="${index}" data-offer-id="${id}">
    <div class="SearchCar">
      <h3 class="CarTitle-Name">Compact car</h3>
      <div class="SupplierInfo"><img alt="${provider}"></div>
      <p>Total for 1 day ${currency} ${price}</p>
      <p>${transmission}</p>
    </div>
  </div>`;
}

function resultsPage({
  cards = [
    offerCard({ provider: "Budget", price: "70.00", index: 0 }),
    offerCard({ provider: "MM Cars Rental", price: "125.00", index: 1 })
  ],
  count = 4,
  automaticChecked = true,
  automaticHidden = false,
  selectedSort = "Price",
  sortHidden = false,
  activePage = null,
  pending = false
} = {}) {
  return `<!doctype html><html><body>
    <label><input type="checkbox" aria-label="Automatic" ${automaticChecked ? "checked" : ""} ${automaticHidden ? 'style="display:none"' : ""}></label>
    <select aria-label="Sort by" ${sortHidden ? 'style="display:none"' : ""}>
      <option value="Recommended" ${selectedSort === "Recommended" ? "selected" : ""}>Recommended</option>
      <option value="Price" ${selectedSort === "Price" ? "selected" : ""}>Price</option>
      <option value="SupplierRating">SupplierRating</option>
    </select>
    <div class="SearchSorting-ShownCars">${count} offers</div>
    <div class="SearchList">${cards.join("")}${pending ? '<div class="SearchList-Loader">Loading</div>' : ""}</div>
    ${activePage == null ? "" : `<div class="Pagination">
      <button class="Pagination-Button" ${activePage === 1 ? 'aria-current="page"' : ""}>1</button>
      <button class="Pagination-Button" ${activePage === 2 ? 'aria-current="page"' : ""}>2</button>
      <button class="Pagination-NavigationButton_next">Next</button>
    </div>`}
  </body></html>`;
}

function paginatedResultsPage({ pageOneCards, pageTwoCards, refreshDelayMs = 700, refreshCards = true }) {
  return `<!doctype html><html><body>
    <label><input type="checkbox" aria-label="Automatic" checked></label>
    <select aria-label="Sort by">
      <option value="Recommended">Recommended</option>
      <option value="Price" selected>Price</option>
      <option value="SupplierRating">SupplierRating</option>
    </select>
    <div class="SearchSorting-ShownCars">6 offers</div>
    <div class="SearchList" id="results">${pageOneCards.join("")}</div>
    <div class="Pagination">
      <button class="Pagination-Button" id="page-one" aria-current="page">1</button>
      <button class="Pagination-Button" id="page-two">2</button>
      <button class="Pagination-NavigationButton_next" id="next-page">Next</button>
    </div>
    <script>
      document.querySelector("#next-page").addEventListener("click", () => {
        document.querySelector("#page-one").removeAttribute("aria-current");
        document.querySelector("#page-two").setAttribute("aria-current", "page");
        document.querySelector("#next-page").disabled = true;
        if (${refreshCards}) {
          document.querySelector("#results").setAttribute("aria-busy", "true");
          setTimeout(() => {
            document.querySelector("#results").innerHTML = ${JSON.stringify(pageTwoCards.join(""))};
            document.querySelector("#results").removeAttribute("aria-busy");
          }, ${refreshDelayMs});
        }
      });
    </script>
  </body></html>`;
}

function scraperConfig(browser, changes = {}) {
  return {
    baseUrl: "https://www.discovercars.com",
    artifactsDir: os.tmpdir(),
    browserProvider: { getBrowser: async () => browser },
    currency: "PLN",
    headless: true,
    locations: [location],
    locationConcurrency: 1,
    maxProvidersPerLocation: 3,
    pickupDate: "2026-11-10",
    dropoffDate: "2026-11-11",
    speedMode: "fast",
    transmissionFilter: "automatic",
    domReadMaxPasses: 2,
    domReadTimeoutMs: 5000,
    ...changes
  };
}

async function extractFixture(browser, markup, changes = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  try {
    const page = await context.newPage();
    await page.setContent(markup);
    const scraper = new DiscoverCarsScraper(scraperConfig(browser, {
      domOnly: true,
      domRankingGoal: "price_top1",
      ...changes
    }));
    const domEvidence = {
      automatic_filter_confirmed: false,
      price_sort_confirmed: false,
      ranking_complete: false,
      listing_complete: false,
      expected_offer_count: null,
      observed_offer_count: 0,
      read_pass_count: 0
    };
    const offers = await scraper.extractOffersFromDomWithScroll(page, location, {
      domOnly: true,
      domEvidence,
      domReadBudget: {}
    });
    return { offers, domEvidence };
  } finally {
    await context.close();
  }
}

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true });
});
test.after(async () => {
  await browser?.close();
});

test("price_top1 uses a stable independent DOM prefix with only competitor and MM", async () => {
  const scraper = new DiscoverCarsScraper(scraperConfig(browser, { domRankingGoal: "price_top1" }));
  let apiCalls = 0;
  scraper.shouldValidateApiOutcome = () => false;
  scraper.runSingleLocationViaApi = async () => {
    apiCalls += 1;
    throw new Error("price_top1 must not use API evidence");
  };
  scraper.tryDirectSearchFlow = async (page, requestedLocation, _collector, options) => {
    await page.setContent(resultsPage());
    return await scraper.extractOffersFromDomWithScroll(page, requestedLocation, options);
  };

  const outcome = await scraper.runSingleLocation(location, async () => browser);

  assert.equal(apiCalls, 0);
  assert.equal(outcome.ok, true, outcome.error?.message);
  assert.equal(outcome.domEvidence.ranking_complete, true);
  assert.equal(outcome.domEvidence.ranking_goal, "price_top1");
  assert.equal(outcome.domEvidence.listing_complete, false);
  assert.equal(outcome.domEvidence.expected_offer_count, 4);
  assert.equal(outcome.domEvidence.observed_offer_count, 2);
  assert.equal(outcome.domEvidence.read_pass_count, 2);
  assert.equal(outcome.sourceValidation.status, "dom_only");
  assert.deepEqual(outcome.results.map(({ provider, totalPrice, currency }) => [provider, totalPrice, currency]), [
    ["Budget", 70, "PLN"],
    ["MM Cars Rental", 125, "PLN"]
  ]);
});

test("price_top1 accepts MM from page two after a fresh quote-identified transition", async () => {
  const result = await extractFixture(browser, paginatedResultsPage({
    pageOneCards: [
      offerCard({ provider: "Budget", price: "70.00", index: 0, id: "page1-budget" }),
      offerCard({ provider: "Avis", price: "90.00", index: 1, id: "page1-avis" })
    ],
    pageTwoCards: [
      offerCard({ provider: "MM Cars Rental", price: "125.00", index: 0, id: "page2-mm" }),
      offerCard({ provider: "Hertz", price: "150.00", index: 1, id: "page2-hertz" })
    ]
  }), { domReadMaxPasses: 12, domReadTimeoutMs: 10_000 });

  assert.equal(result.domEvidence.ranking_complete, true);
  assert.equal(result.domEvidence.ranking_goal, "price_top1");
  assert.equal(result.domEvidence.listing_complete, false);
  assert.deepEqual(result.offers.map(({ provider, totalPrice }) => [provider, totalPrice]), [
    ["Budget", 70],
    ["Avis", 90],
    ["MM Cars Rental", 125],
    ["Hertz", 150]
  ]);
});

test("price_top1 rejects a page-two label change without fresh quote identities", async () => {
  const result = await extractFixture(browser, paginatedResultsPage({
    pageOneCards: [
      offerCard({ provider: "Budget", price: "70.00", index: 0, id: "page1-budget" }),
      offerCard({ provider: "Avis", price: "90.00", index: 1, id: "page1-avis" })
    ],
    pageTwoCards: [
      offerCard({ provider: "MM Cars Rental", price: "125.00", index: 0, id: "page2-mm" }),
      offerCard({ provider: "Hertz", price: "150.00", index: 1, id: "page2-hertz" })
    ],
    refreshCards: false
  }), { domReadMaxPasses: 4, domReadTimeoutMs: 5000 });

  assert.equal(result.domEvidence.ranking_complete, false);
  assert.equal(Object.hasOwn(result.domEvidence, "ranking_goal"), false);
});

test("price_top1 will not paginate from an unknown first-page quote", async () => {
  const result = await extractFixture(browser, paginatedResultsPage({
    pageOneCards: [
      offerCard({ provider: "Budget", price: "70.00", index: 0, id: "" }),
      offerCard({ provider: "Avis", price: "90.00", index: 1, id: "page1-avis" })
    ],
    pageTwoCards: [
      offerCard({ provider: "MM Cars Rental", price: "125.00", index: 0, id: "page2-mm" }),
      offerCard({ provider: "Hertz", price: "150.00", index: 1, id: "page2-hertz" })
    ]
  }), { domReadMaxPasses: 4, domReadTimeoutMs: 5000 });

  assert.equal(result.domEvidence.ranking_complete, false);
  assert.equal(Object.hasOwn(result.domEvidence, "ranking_goal"), false);
});

test("default mode still requires the existing top-three or complete-listing proof", async () => {
  const result = await extractFixture(browser, resultsPage(), { domRankingGoal: undefined });

  assert.equal(result.domEvidence.automatic_filter_confirmed, true);
  assert.equal(result.domEvidence.price_sort_confirmed, true);
  assert.equal(result.domEvidence.ranking_complete, false);
  assert.equal(result.domEvidence.listing_complete, false);
  assert.equal(Object.hasOwn(result.domEvidence, "ranking_goal"), false);
});

test("price_top1 never marks incomplete coverage, bad controls, pending cards, or stale pagination", async (t) => {
  const gap = await extractFixture(browser, resultsPage({ cards: [
    offerCard({ provider: "Budget", price: "70.00", index: 0 }),
    offerCard({ provider: "MM Cars Rental", price: "125.00", index: 2 })
  ] }));
  const wrongCurrency = await extractFixture(browser, resultsPage({ cards: [
    offerCard({ provider: "Budget", price: "70.00", index: 0, currency: "USD" }),
    offerCard({ provider: "MM Cars Rental", price: "125.00", index: 1, currency: "USD" })
  ] }));
  const failedControls = await extractFixture(browser, resultsPage({
    automaticChecked: false,
    automaticHidden: true,
    selectedSort: "Recommended",
    sortHidden: true
  }));
  const pending = await extractFixture(browser, resultsPage({ pending: true }));
  const stalePagination = await extractFixture(browser, resultsPage({ activePage: 2 }));
  const missingMm = await extractFixture(browser, resultsPage({ cards: [
    offerCard({ provider: "Budget", price: "70.00", index: 0 }),
    offerCard({ provider: "Avis", price: "80.00", index: 1 })
  ] }));
  const missingCompetitor = await extractFixture(browser, resultsPage({ cards: [
    offerCard({ provider: "MM Cars Rental", price: "70.00", index: 0 }),
    offerCard({ provider: "MM Cars Rental Plus", price: "80.00", index: 1 })
  ] }));
  const oneRead = await extractFixture(browser, resultsPage(), { domReadMaxPasses: 1 });

  for (const [name, result] of [
    ["index gap", gap],
    ["wrong currency", wrongCurrency],
    ["failed controls", failedControls],
    ["pending cards", pending],
    ["page two", stalePagination],
    ["missing MM", missingMm],
    ["missing competitor", missingCompetitor],
    ["only one stable read", oneRead]
  ]) {
    await t.test(name, () => {
      assert.equal(result.domEvidence.ranking_complete, false);
      assert.equal(Object.hasOwn(result.domEvidence, "ranking_goal"), false);
    });
  }

  assert.equal(failedControls.domEvidence.automatic_filter_confirmed, false);
  assert.equal(failedControls.domEvidence.price_sort_confirmed, false);
});
