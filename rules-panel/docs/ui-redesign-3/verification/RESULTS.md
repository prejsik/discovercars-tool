# UI redesign 3: verification

Branch: `ui-redesign-3`. Base: `08008a8`. Verified locally on Windows, 2026-11-03.

## Scope

Five stages in five commits, one PR to main, no merge or production deployment.
Only `rules-panel/` changes. Pricing configuration, scraper, Python/Excel generator,
baseline workbooks, schedules, Worker backend and publication authorization are unchanged.

## Stage checks

| Stage | Implementation | Unit tests | Other checks |
| --- | --- | --- | --- |
| 1 | Local IBM Plex fonts, price tones, navigation, Polish labels | 370 passed | Build, engine compatibility, affected browser flows |
| 2 | Default branch/date map with confirmed-data aggregation | 371 passed | Build, engine compatibility, map and workspace UI |
| 3 | Branch matrix, context-preserving side panel | 372 passed | Build, engine compatibility, matrix and decision UI |
| 4 | PLN calendar gaps, multiple rental lengths | 373 passed | Build, engine compatibility, calendar and workspace UI |
| 5 | Operational dashboard and final integration corrections | 374 passed | Build, engine compatibility, full browser suite |

Final commands from `rules-panel/`:

- `npm test`: 374 passed, 0 failed, 0 skipped.
- `npm run test:engine`: 1,350 comparisons with the real Python pricing engine passed.
- `npm run test:ui`: all 18 browser test scripts passed.
- `npm run build`: passed; application JS 425.63 kB / 127.69 kB gzip.
- `git diff --check`: passed (only Windows line-ending notices).

Browser checks include baseline replacement, draft concurrency, rule publication gates,
amount validation, location onboarding, source-bound Excel links, diagnostics, report
filters, map/branch navigation, calendar, historical decisions and responsive layout.
Critical market layouts were checked at 320, 390, 1024 and 1440 px; individual existing
flows also test 768 px. Tables scroll inside their own containers, not the whole page.

The matrix test explicitly distinguishes the current draft minimum (55 PLN in the
fixture) from the recorded historical minimum (30 PLN), preserves the exact imported
rate (63 PLN), checks class context in the full table, and closes the side panel when
leaving the price workspace. Dashboard and prices reuse the same report load/cache.
A synthetic 4.32 MB report loaded in 1,873 ms locally; this is not a Cloudflare latency
guarantee. Existing context-before/context-after integrity checks remain enabled.

## Screenshots

These use deterministic test fixtures, not current business prices. Stages 2-4 were
recaptured after integration so they include the final shared styling. Stage 1 records
the initial foundation milestone.

| View | Desktop | Mobile |
| --- | --- | --- |
| Foundations | [1440 px](stage-1-1440.png) | [390 px](stage-1-390.png) |
| Branch/date map | [1440 px](stage-2-1440.png) | [390 px](stage-2-390.png) |
| Branch matrix and details | [1440 px](stage-3-1440.png) | [390 px](stage-3-390.png) |
| Price calendar | [1440 px](stage-4-1440.png) | [390 px](stage-4-390.png) |
| Dashboard | [1440 px](stage-5-1440.png) | [390 px](stage-5-390.png) |

## Deliberate corrections to the reference brief

- Neutral price gaps retain their actual sign; a positive value is not labeled plus/minus.
- Current rule minimum explicitly includes the panel draft and is not presented as the
  historical Excel minimum. Missing evidence stays missing, not replaced by an average.
- Dashboard filters select relevant branches while the map keeps all observed lengths
  for each retained branch. The UI states this to avoid implying a filtered cell is a
  full-market comparison when it is not.
- Local drafts remain described as browser-local, not shared across the computer.
- No expected revenue, booking probability or actionable increase is inferred from a gap.
- No additional backend endpoints or second dashboard download of the price report.

## Remaining boundaries

Browser tests use mocked API fixtures and do not publish real pricing rules or replace
a real baseline. Production Cloudflare Access and live customer data were not exercised.
Remote PR CI is separate from the completed local checks. No production deployment,
live scraper run or independent-agent review was performed.
