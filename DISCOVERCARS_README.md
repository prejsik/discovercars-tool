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
- The HTML report shows API, DOM confirmation, fallback, or conflict under each location and lists drift reasons.

## Notes

- Production location names, DiscoverCars identifiers, import zones, aliases, and the daily profile live in `locations.config.json`.
- `input/baseline-manifest.json` must confirm that the hashed baseline workbook was imported before the Excel updater can use it.
- The scraper works sequentially on purpose to reduce flakiness and lower the chance of anti-bot triggers.
- On a failed location, the tool stores debug artifacts in the configured `artifactsDir`.
- If DiscoverCars changes their UI, the main places to adjust are:
  - `fillSearchForm`
  - `chooseAutocompleteOption`
  - `setDateAndTime`
  - `extractOffersFromDom`
