# Market view: shared filters and Excel bands

Scope: frontend presentation only. No changes to pricing rules, scraper,
Excel generation, server code, policy engine, API endpoints or chart axes.
Publication: review branch and PR only; no merge or Cloudflare deployment.

## Acceptance checks

After each numbered point: `npm test`, `npm run build`, and the affected UI
scripts were run successfully. Corrections were retested before continuing.

| Point | Change | Unit / build | UI scripts |
| --- | --- | --- | --- |
| 1 | Band median, majority missing, corner dot, same summary criterion | PASS | matrix-rules-ui |
| 2 | First report start date plus 13 days | PASS | matrix-rules-ui |
| 3 | Automatic transmission defaults | PASS | matrix-rules-ui |
| 4 | Shared location, transmission and date state across tabs | PASS | matrix-rules-ui |
| 5 | In-flow desktop band detail, mobile modal bottom sheet | PASS | matrix-rules-ui |
| 6 | Full calendar month clipped to report, shared range preserved | PASS | market-workspace-ui, market-autoload-ui |
| 7 | Common filter bar above tabs, duplicate controls removed | PASS | matrix-rules-ui, market-workspace-ui, market-autoload-ui |
| 8 | Map only, no alternate branch table | PASS | market-workspace-ui, market-autoload-ui |
| 9 | 44px matrix rows, inline rate and difference | PASS | matrix-rules-ui |
| 10 | Inline branch navigation and summary | PASS | matrix-rules-ui, market-workspace-ui |
| 11 | One month heading and weekend column background | PASS | market-workspace-ui, market-autoload-ui |
| 12 | Text legend with color squares below map | PASS | matrix-rules-ui, market-workspace-ui, market-autoload-ui |

## Calculation boundaries

- Map bands use lengths 2; 3,4; 5,6,7; and 8 through 14 respectively.
  The 8-20 Excel band does not imply new 15-20-day market observations.
- Median uses confirmed finite MM-minus-competitor pairs only.
- Missing MM must be confirmed for more than half the expected lengths
  in the selected band. Unknown/uncollected observations are not missing MM.
- A partial missing count gets a corner dot, preserving a comparable median.
- Summary counts days with majority missing MM or median greater than 10 PLN/day.
- Initial range uses report start dates, not the wall clock or the first
  successful price observation. An empty report does not invent dates.
- Calendar month navigation changes only the displayed month, not the shared
  date range used by the map, branch matrix, chart and Excel inspection.
- Existing exact Excel band values and class selection remain unchanged.
  The branch matrix still labels its existing worst market difference;
  only the overview map changes to a median, as requested.

## Final regression

- Unit tests: 375 passed, zero failed or skipped.
- Production build: passed.
- Full UI suite: all 18 scripts passed (`npm run test:ui`).
- Preserved assertions: import 63.00, baseline 65.00, historical minimum 30.00,
  current draft minimum 55.00, class switching, no stale class result, no POST
  writes in price inspection, and reuse of already loaded price/workbook data.
- Page overflow checked at 320, 390, 1024 and 1440 px. Wide data grids scroll
  within their own regions, not the entire page. The desktop band panel is
  beside the matrix; mobile uses the existing bottom sheet.
- Source comparison confirms PriceChart is unchanged and protected paths
  have no diff. No production data or shared configuration was written.

Local Vite dependency-cache 504 errors during verification were resolved by
restarting only the owned development server with `--force`; no application
or backend workaround was introduced.

## Screenshots

Playwright fixtures, not current production prices:

| View | 390 px | 1440 px |
| --- | --- | --- |
| Map | [390](verification/map-390.png) | [1440](verification/map-1440.png) |
| Band detail | [390](verification/band-detail-390.png) | [1440](verification/band-detail-1440.png) |
| Calendar | [390](verification/calendar-390.png) | [1440](verification/calendar-1440.png) |
