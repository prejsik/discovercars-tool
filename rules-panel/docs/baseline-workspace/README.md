# Baza i lokalizacje

UI and read-only snapshot metadata changes. No changes to `processBaseline`,
`publishBaseline`, workbook validation, pricing configuration, scraper or Excel export.

## Changes

- Current baseline: manifest coverage, confirmation, matching last Excel timestamp and GitHub history.
- Latest verified Excel and custom upload shown side by side. Both import checkboxes start unchecked.
- Custom file selection and drag/drop use the same existing check and publish calls.
- Checked coverage comparison warns about removed codes/classes and shorter dates without adding a publication blocker. Existing server validation remains authoritative.
- Explicit Set/Cancel buttons replace browser confirmation. Source SHA, checked file SHA, previous baseline SHA and onboarding hashes remain unchanged in requests.
- New-code summary table, editable assignment forms and one six-band markup table. Verified locations no longer repeat markup amounts.
- Searchable, permanently visible location directory with type and incomplete-data filters.
- Report coverage reuses `useMarketReport` and the existing market endpoints/cache. No endpoint added. Completeness means confirmed market data for every expected duration on each reported start date, in the all-cars view, not presence of an MM offer. Points absent from the report are labelled unknown/outside scope rather than counted as complete or missing.
- Diagnostics retain downloads and a link to the baseline screen, not a second publishing workflow.

## Verification

385 unit tests, all 23 UI scripts and the production build passed. Worker access-control and report runtime tests passed. Final affected-view checks were repeated after presentation cleanup. Existing upload, onboarding, concurrency,
checked-hash and exact-payload assertions are retained. New tests cover read-only
coverage in both snapshot adapters, import confirmation, coverage comparisons,
location completeness, filters, drag/drop, cancellation, stale report checks and
responsive widths 320/390/1440. No production publication performed.

## Screenshots

Controlled API fixture, not a live baseline recommendation.

| View | Desktop | Mobile |
|---|---|---|
| Current base and upload choices | [1440](baseline-1440.png) | [390](baseline-390.png) |
| Checked comparison | [1440](comparison-1440.png) | [390](comparison-390.png) |

