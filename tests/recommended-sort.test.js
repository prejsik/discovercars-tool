const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");
const { chromium } = require("playwright");
const { DiscoverCarsScraper } = require("../src/discovercars/scraper");

function card({ provider, price, transmission = "Automatic transmission", id, index = id, indexed = true }) {
  const indexAttribute = indexed ? `data-search-list-card-index="${index}"` : "";
  return `<div class="SearchList-Card" ${indexAttribute} data-offer-id="${id}">
    <div class="SearchCar">
      <h3 class="CarTitle-Name">Compact car</h3>
      <div class="SupplierInfo"><img alt="${provider}"></div>
      <p>Total for 1 day PLN ${price}</p>
      <p>${transmission}</p>
    </div>
  </div>`;
}

function resultsPage({
  recommendedCards,
  delayMs = 0,
  paginationPage = null,
  indexed = true,
  paginationMode = null,
  pageOneCards = null,
  pageTwoCards = null,
  pageTwoTopCards = null,
  topResetDelayMs = 0,
  paginationRefreshDelayMs = 0,
  refreshPageCards = true
}) {
  const priceCards = [
    card({ provider: "Price First", price: "70.00", id: 0, indexed }),
    card({ provider: "Price Second", price: "125.00", id: 1, indexed })
  ].join("");
  const initialCards = paginationPage === 2 && pageTwoCards ? pageTwoCards : priceCards;
  const pagination = paginationPage == null
    ? ""
    : paginationMode === "navigable"
      ? `<div class="Pagination">
          <button class="Pagination-NavigationButton_prev">Previous</button>
          <div class="Pagination-Pages">
            <button class="Pagination-Button" id="page-one">1</button>
            <button class="Pagination-Button" id="page-two" aria-current="page">2</button>
          </div>
        </div>`
      : `<div class="Pagination"><button aria-current="page">${paginationPage}</button></div>`;

  return `<!doctype html>
    <html><body>
      <label><input type="checkbox" aria-label="Automatic" checked></label>
      <div class="SearchFiltersGroup-FilterWrapper_transmission-a">
        <span class="SearchFiltersGroup-Filter_isActive"></span>
      </div>
      <select aria-label="Sort by">
        <option value="Recommended">Recommended</option>
        <option value="Price" selected>Price</option>
        <option value="SupplierRating">SupplierRating</option>
      </select>
      <div id="list">${initialCards}</div>
      ${pagination}
      <script>
        const sort = document.querySelector("select[aria-label='Sort by']");
        let currentSort = sort.value;
        sort.addEventListener("change", () => {
          if (sort.value === currentSort) return;
          currentSort = sort.value;
          const render = () => {
            document.querySelector("#list").innerHTML = sort.value === "Recommended"
              ? ${JSON.stringify(recommendedCards)}
              : ${JSON.stringify(priceCards)};
          };
          if (sort.value === "Recommended" && ${delayMs} > 0) setTimeout(render, ${delayMs});
          else render();
        });
        const pageOne = document.querySelector("#page-one");
        const pageTwo = document.querySelector("#page-two");
        if (${Boolean(pageTwoTopCards)} && ${topResetDelayMs} > 0) {
          setTimeout(() => {
            document.querySelector("#list").innerHTML = ${JSON.stringify(pageTwoTopCards)};
          }, ${topResetDelayMs});
        }
        if (pageOne && pageTwo) {
          pageOne.addEventListener("click", () => {
            pageOne.setAttribute("aria-current", "page");
            pageTwo.removeAttribute("aria-current");
            if (${refreshPageCards}) {
              setTimeout(() => {
                document.querySelector("#list").innerHTML = ${JSON.stringify(pageOneCards || priceCards)};
              }, ${paginationRefreshDelayMs});
            }
          });
          document.querySelector(".Pagination-NavigationButton_prev").addEventListener("click", () => pageOne.click());
        }
      </script>
    </body></html>`;
}

test("captures only requested Recommended first cards without changing price results", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const apiCalls = [];
  const recommendationChecks = [];
  const sortsAfterCapture = [];
  const scraper = new DiscoverCarsScraper({
    baseUrl: "https://www.discovercars.com",
    artifactsDir: os.tmpdir(),
    browserProvider: { getBrowser: async () => browser },
    currency: "PLN",
    headless: true,
    locations: ["Warsaw", "Gdansk", "Lodz", "Szczecin", "Gdynia", "Rzeszow", "Torun", "Bydgoszcz", "Olsztyn", "Poznan", "Krakow"],
    locationConcurrency: 1,
    maxProvidersPerLocation: 2,
    pickupDate: "2026-11-10",
    dropoffDate: "2026-11-11",
    recommendedRankingLocations: ["Warsaw", "Gdansk", "Lodz", "Szczecin", "Gdynia", "Rzeszow", "Torun", "Bydgoszcz", "Olsztyn", "Poznan"],
    recommendedRankingNeeded: (location, priceOffers) => {
      recommendationChecks.push({
        location,
        priceOffers: priceOffers.map(({ provider, totalPrice, source }) => [provider, totalPrice, source])
      });
      return location !== "Poznan";
    },
    speedMode: "fast",
    transmissionFilter: "automatic"
  });

  scraper.shouldValidateApiOutcome = () => false;
  scraper.runSingleLocationViaApi = async (location) => {
    apiCalls.push(location);
    const offer = {
      provider: "API Price",
      totalPrice: 80,
      currency: "PLN",
      location,
      transmission: "automatic",
      source: "api"
    };
    return { ok: true, cheapest: offer, results: [offer], offerViews: { all: [offer] } };
  };
  scraper.tryDirectSearchFlow = async (page, location) => {
    const pageOneCards = location === "Bydgoszcz"
      ? card({ provider: "Page Two First", price: "155.00", id: 20, index: 0 })
      : [
        card({ provider: "Price First", price: "70.00", id: 0 }),
        card({ provider: "Price Second", price: "125.00", id: 1 })
      ].join("");
    const pageTwoCards = [
      card({ provider: "Page Two First", price: "155.00", id: 20, index: 0 }),
      card({ provider: "Page Two Second", price: "180.00", id: 21, index: 1 })
    ].join("");
    const navigablePageTwo = ["Torun", "Bydgoszcz", "Olsztyn"].includes(location);
    const virtualizedPageTwo = location === "Olsztyn"
      ? [
        card({ provider: "Virtualized Page Two First", price: "155.00", id: 25, index: 5 }),
        card({ provider: "Virtualized Page Two Second", price: "180.00", id: 26, index: 6 })
      ].join("")
      : null;
    const pageTwoTopCards = location === "Olsztyn"
      ? [
        card({ provider: "Page Two First", price: "155.00", id: 20, index: 0 }),
        card({ provider: "Page Two Second", price: "180.00", id: 21, index: 1 })
      ].join("")
      : null;
    const recommendedCards = location === "Gdansk"
      ? [
        card({ provider: "Manual First", price: "90.00", transmission: "Manual transmission", id: 0 }),
        card({ provider: "Later Automatic", price: "110.00", id: 1 })
      ].join("")
      : location === "Lodz"
        ? [
          card({ provider: "Price First", price: "70.00", id: 0 }),
          card({ provider: "Price Second", price: "125.00", id: 1 })
        ].join("")
        : location === "Szczecin"
          ? [
            card({ provider: "Later Indexed First", price: "125.00", id: 5, index: 5 }),
            card({ provider: "Earlier Indexed Second", price: "70.00", id: 0, index: 0 })
          ].join("")
        : location === "Rzeszow"
          ? [
            card({ provider: "Unindexed First", price: "125.00", id: 0, indexed: false }),
            card({ provider: "Unindexed Second", price: "70.00", id: 1, indexed: false })
          ].join("")
      : [
        card({ provider: "Recommended First", price: "125.00", id: 0 }),
        card({ provider: "Cheaper Offer", price: "70.00", id: 1 })
      ].join("");
    await page.setContent(resultsPage({
      recommendedCards,
      delayMs: location === "Warsaw" ? 1200 : 0,
      paginationPage: location === "Gdynia" || navigablePageTwo ? 2 : null,
      indexed: location !== "Rzeszow",
      paginationMode: navigablePageTwo ? "navigable" : null,
      pageOneCards,
      pageTwoCards: virtualizedPageTwo || pageTwoCards,
      pageTwoTopCards,
      topResetDelayMs: location === "Olsztyn" ? 700 : 0,
      paginationRefreshDelayMs: location === "Torun" ? 700 : 0,
      refreshPageCards: location !== "Olsztyn"
    }));
    return [
      { provider: "Price First", totalPrice: 70, currency: "PLN", location, transmission: "automatic", source: "dom" },
      { provider: "Price Second", totalPrice: 125, currency: "PLN", location, transmission: "automatic", source: "dom" }
    ];
  };

  if (typeof scraper.captureRecommendedRankingFromDom === "function") {
    const capture = scraper.captureRecommendedRankingFromDom.bind(scraper);
    scraper.captureRecommendedRankingFromDom = async (...args) => {
      const result = await capture(...args);
      sortsAfterCapture.push(await args[0].locator("select[aria-label='Sort by']").inputValue());
      return result;
    };
  }

  const output = await scraper.run();

  assert.deepEqual(apiCalls, ["Krakow"]);
  assert.deepEqual(recommendationChecks, ["Warsaw", "Gdansk", "Lodz", "Szczecin", "Gdynia", "Rzeszow", "Torun", "Bydgoszcz", "Olsztyn", "Poznan"].map((location) => ({
    location,
    priceOffers: [
      ["Price First", 70, "dom"],
      ["Price Second", 125, "dom"]
    ]
  })));
  assert.deepEqual(Object.keys(output.recommendedRankingByLocation || {}).sort(), ["Bydgoszcz", "Gdansk", "Gdynia", "Lodz", "Olsztyn", "Rzeszow", "Szczecin", "Torun", "Warsaw"]);

  const recommended = output.recommendedRankingByLocation.Warsaw;
  assert.equal(recommended.status, "confirmed");
  assert.equal(recommended.sort, "Recommended");
  assert.equal(recommended.transmission, "automatic");
  assert.deepEqual(recommended.top_offer, {
    provider_name: "Recommended First",
    total_price: 125,
    currency: "PLN",
    transmission: "automatic"
  });
  assert.equal(new Date(recommended.observed_at).toISOString(), recommended.observed_at);

  const rejected = output.recommendedRankingByLocation.Gdansk;
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.reason, "recommended_top_offer_not_automatic");
  assert.equal(Object.hasOwn(rejected, "top_offer"), false);

  const unacknowledged = output.recommendedRankingByLocation.Lodz;
  assert.equal(unacknowledged.status, "failed");
  assert.equal(unacknowledged.reason, "recommended_refresh_unconfirmed");
  assert.equal(Object.hasOwn(unacknowledged, "top_offer"), false);

  const pageReturned = output.recommendedRankingByLocation.Torun;
  assert.equal(pageReturned.status, "confirmed", JSON.stringify(pageReturned));
  assert.equal(pageReturned.top_offer.provider_name, "Recommended First");

  const labelOnlyPageChange = output.recommendedRankingByLocation.Bydgoszcz;
  assert.equal(labelOnlyPageChange.status, "failed");
  assert.equal(labelOnlyPageChange.reason, "recommended_page_refresh_unconfirmed");
  assert.equal(Object.hasOwn(labelOnlyPageChange, "top_offer"), false);

  const virtualizedTopNotPageOne = output.recommendedRankingByLocation.Olsztyn;
  assert.equal(virtualizedTopNotPageOne.status, "failed");
  assert.equal(virtualizedTopNotPageOne.reason, "recommended_page_refresh_unconfirmed");
  assert.equal(Object.hasOwn(virtualizedTopNotPageOne, "top_offer"), false);

  for (const location of ["Szczecin", "Rzeszow"]) {
    assert.equal(output.recommendedRankingByLocation[location].status, "failed");
    assert.equal(output.recommendedRankingByLocation[location].reason, "recommended_list_position_unconfirmed");
    assert.equal(Object.hasOwn(output.recommendedRankingByLocation[location], "top_offer"), false);
  }

  assert.equal(output.recommendedRankingByLocation.Gdynia.status, "failed");
  assert.equal(output.recommendedRankingByLocation.Gdynia.reason, "recommended_page_one_unavailable");
  assert.equal(Object.hasOwn(output.recommendedRankingByLocation.Gdynia, "top_offer"), false);

  assert.deepEqual(sortsAfterCapture, ["Price", "Price", "Price", "Price", "Price", "Price", "Price", "Price", "Price"]);
  assert.deepEqual(output.results.filter((offer) => ["Warsaw", "Gdansk", "Lodz", "Szczecin", "Gdynia", "Rzeszow", "Torun", "Bydgoszcz", "Olsztyn", "Poznan"].includes(offer.location))
    .map((offer) => [offer.location, offer.provider, offer.totalPrice]), [
    ["Warsaw", "Price First", 70],
    ["Warsaw", "Price Second", 125],
    ["Gdansk", "Price First", 70],
    ["Gdansk", "Price Second", 125],
    ["Lodz", "Price First", 70],
    ["Lodz", "Price Second", 125],
    ["Szczecin", "Price First", 70],
    ["Szczecin", "Price Second", 125],
    ["Gdynia", "Price First", 70],
    ["Gdynia", "Price Second", 125],
    ["Rzeszow", "Price First", 70],
    ["Rzeszow", "Price Second", 125],
    ["Torun", "Price First", 70],
    ["Torun", "Price Second", 125],
    ["Bydgoszcz", "Price First", 70],
    ["Bydgoszcz", "Price Second", 125],
    ["Olsztyn", "Price First", 70],
    ["Olsztyn", "Price Second", 125],
    ["Poznan", "Price First", 70],
    ["Poznan", "Price Second", 125]
  ]);
});

test("captures a requested Recommended offer when no policy callback is configured", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const scraper = new DiscoverCarsScraper({
    baseUrl: "https://www.discovercars.com",
    artifactsDir: os.tmpdir(),
    browserProvider: { getBrowser: async () => browser },
    currency: "PLN",
    headless: true,
    locations: ["Warsaw"],
    locationConcurrency: 1,
    maxProvidersPerLocation: 2,
    pickupDate: "2026-11-10",
    dropoffDate: "2026-11-11",
    recommendedRankingLocations: ["Warsaw"],
    speedMode: "fast",
    transmissionFilter: "automatic"
  });
  scraper.runSingleLocationViaApi = async () => {
    throw new Error("Requested Recommended locations must use the browser path.");
  };
  scraper.tryDirectSearchFlow = async (page, location) => {
    const recommendedCards = [
      card({ provider: "Recommended First", price: "125.00", id: 0 }),
      card({ provider: "Cheaper Offer", price: "70.00", id: 1 })
    ].join("");
    await page.setContent(resultsPage({ recommendedCards }));
    return [
      { provider: "Price First", totalPrice: 70, currency: "PLN", location, transmission: "automatic", source: "dom" },
      { provider: "Price Second", totalPrice: 125, currency: "PLN", location, transmission: "automatic", source: "dom" }
    ];
  };

  const output = await scraper.run();

  assert.equal(output.recommendedRankingByLocation.Warsaw.status, "confirmed");
  assert.equal(output.recommendedRankingByLocation.Warsaw.top_offer.provider_name, "Recommended First");
});
