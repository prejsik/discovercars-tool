# Market compact UI verification

Baseline: `b484e5e5495521410eccbc3ada72ddc388dd25e4`.
Local branch: `codex/market-compact-review`.

## Scope

UI-only implementation of the 11 requested market-view changes. Pricing rules,
scraping, workbook generation, server code and band-median calculations are unchanged.
No GitHub push or Cloudflare deployment was performed for this change.

The clarified map layout uses 36-40 px rows and internal vertical scrolling,
not 25 simultaneously visible rows. The branch matrix retains its width when
the detail panel opens and scrolls horizontally with its first column pinned.

## Checks

- `npm test`: 376 passed, 0 failed.
- Existing `test:ui` suite: all 18 scripts passed.
- `node tests/market-compact-ui.mjs`: passed, including the final seven-day divider edge case.
- `npm run build`: passed after the final CSS change.
- `git diff --check`: passed; only line-ending conversion warnings.
- Protected backend, policy, scraper and Excel paths: no diff.

The new UI suite is also appended to `test:ui`. Assertions cover exact Excel
rates, class and zone changes, shared filters, no POST writes, no additional
API reads when filtering, neutral values retaining accessible exact values,
sticky matrix cells, full missing-offer text, compact rows and page overflow
at 320, 390, 1024 and 1440 px. Existing behavior checks were retained.

## Screenshots

Open `index.html` for the before/after comparison. There are 16 viewport
screenshots: four views, two widths (390 and 1440), before and after.
The same deterministic synthetic fixture is used on both sides; screenshots
are not evidence of live market prices or production deployment.

Local preview: http://127.0.0.1:4317/?view=prices
