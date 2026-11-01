# DiscoverCars Cheapest Offers Scraper

This tool automates DiscoverCars with Playwright and finds the cheapest rental offer for each requested location.

## Features

- opens DiscoverCars and fills the search form
- accepts multiple locations in one run
- handles dynamic loading and common cookie popups
- tries to extract offers first from network JSON responses, then from embedded page data, and finally from the rendered DOM
- uses DiscoverCars geo-search API directly for the Galeria Krakowska address
- rejects search API payloads whose pickup or drop-off period differs from the requested period
- continues processing even if one location fails
- prints a sorted summary table
- saves the results to CSV

## Setup

Install dependencies:

```powershell
cd C:\Users\barte\OneDrive\Codex
"C:\Program Files\nodejs\npm.cmd" install
```

Install Playwright Chromium:

```powershell
npx playwright install chromium
```

If `npx` is blocked in PowerShell, use:

```powershell
"C:\Program Files\nodejs\npx.cmd" playwright install chromium
```

If Google Chrome or Microsoft Edge is already installed on the machine, the scraper can use that system browser automatically and you may skip the Playwright browser download step.

## Run

Using a config file:

```powershell
node .\src\discovercars\cli.js --config .\discovercars.config.example.json
```

Using CLI arguments:

```powershell
node .\src\discovercars\cli.js `
  --location "Warsaw" `
  --location "Krakow" `
  --pickup-date 2026-05-15 `
  --pickup-time 11:00 `
  --dropoff-date 2026-05-18 `
  --dropoff-time 11:00 `
  --output-csv .\output\discovercars-results.csv
```

Run with a visible browser:

```powershell
node .\src\discovercars\cli.js --config .\discovercars.config.example.json --headed
```

## CSV Output

The CSV contains:

- `location`
- `provider`
- `total_price`
- `currency`
- `source`

## API-DOM quality control

- API is the primary source for every scenario.
- DOM validation starts at a deterministic 5% sample.
- Escalation is calculated independently per location after at least 20 comparisons: 5%, 10%, or at most 20%.
- Sparse API results use a 20% DOM sample instead of forcing a browser check for every scenario.
- A location is capped at 50 sampled DOM validations per process; API failures still use DOM fallback.
- Active price recommendations without prior DOM confirmation are verified in DOM before Excel generation.
- The HTML report hides implementation details such as API/DOM and focuses on prices, MM Cars Rental position, and the number of cheaper offers.
- A single Chromium process is reused within a scraper process, while every location still runs in a fresh isolated browser context.
- DOM readiness uses a fast result signal first and automatically falls back to the previous full loading and network-idle checks.

## Price verification scope

- Collection still includes every rental duration from 2 through 14 days; shared Excel bands do not reduce source coverage.
- `apiOnlyConstraintRentalDays: [9, 11, 12]` keeps these durations in the API collection and audit, but removes routine final browser checks for healthy sources. Their normal records are non-actionable API constraints, never DOM confirmations. The 8-20 Excel band still requires every source duration 8-14 and independent fresh DOM witnesses for 8, 10, 13 and 14.
- An API-only constraint may limit a verified target but cannot set a lower price itself. If the final verified market rate after the existing pricing rules exceeds its cap, a required witness is missing, or evidence is stale/invalid, the market update preserves the baseline. Independent mandatory-floor corrections retain their existing precedence.
- Fresh confirmed DOM evidence remains valid when reused from a checkpoint or obtained through a complete DOM fallback; its origin alone is not a missing-data condition. Evidence freshness, price, currency, supplier and identity checks still apply.
- Only a fresh, otherwise valid 9/11/12 observation with a recognized recoverable source failure may request one exceptional DOM repair. Pending repair has no import-authorizing price; healthy API references, stale/missing identity and policy holds do not request repair. A genuine repair is rebuilt with the same financial rules and may supply that duration's DOM witness, including a Popular-MM hold.
- The checkpoint records a consumed repair attempt even if it fails or is interrupted. Resume does not repeat that attempt; budget exhaustion before it starts does not consume it. An unsuccessful repair preserves the affected market band, without blocking unrelated cells or independent mandatory floors.
- Under the price Top1 / Recommended / minimum policy, final DOM verification needs a proven price-ordered automatic prefix containing MM and the cheapest competitor, not three suppliers. Default collection and report Top3 coverage are unchanged.
- Recommended sorting is checked only when price Top1 is infeasible, and only for the first 20 calendar pickup dates of the run. The anchor is saved before sharding and reused during live repricing and retries.
- Beyond that window, feasible price Top1 remains available; an infeasible price Top1 preserves the baseline instead of authorizing a minimum fallback.
- Before verification sharding, an optional read-only Excel planner skips only checks proven unable to affect eligible workbook cells. A baseline already at its floor is not proof: a fresh price can still justify an increase.
- If the planner is unavailable or times out, the existing full verification path runs. Unknown DOM evidence preserves rates. Protected dates, excluded classes and explicit mandatory-floor exceptions retain their existing precedence.

## Notes

- Production location names, DiscoverCars identifiers, import zones, aliases, and the daily profile live in `locations.config.json`.
- `input/baseline-manifest.json` must confirm that the hashed baseline workbook was imported before the Excel updater can use it.
- Concurrency is controlled by the selected `safe`, `fast`, or `turbo` profile and bounded to reduce flakiness and anti-bot risk.
- On a failed location, the tool stores debug artifacts in the configured `artifactsDir`.
- If DiscoverCars changes their UI, the main places to adjust are:
  - `fillSearchForm`
  - `chooseAutocompleteOption`
  - `setDateAndTime`
  - `extractOffersFromDom`
