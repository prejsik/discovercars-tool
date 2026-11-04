# Pricing rules UI clarity

UI and text changes only. No pricing values, scraper, locations configuration or Excel export changes.

## Implemented

- Accessible dark active List/Calendar switch.
- Scoped rule names and unique family labels; secondary zone codes identify the market source.
- Polish plural forms and local server messages.
- Optional impact preview for the current draft only; stale results hidden; publication remains independent.
- Compact six-band summaries and reduced expanded rows.
- Calendar highlights unusual minima and protected dates, with all six minima visible below.
- Airport/non-airport/city selection shortcuts and one new-rule comparison notice.
- Group enable/disable confirmation with reason, cancellation and error handling.

## Point 9: Manual baseline field retained

The existing price-loader reads the historical baseline of a published report. It does not expose the current approved baseline independently. Reusing it could silently populate the wrong rate after a baseline upload. No new endpoint was added; the field stays manual as permitted in the request.

## Verification

Local npm test: 378 passed. Build passed. All 20 Playwright scripts passed (earlier scripts plus resumed suite after selector updates). Engine compatibility: 1350 comparisons passed. Screenshots use a controlled workspace fixture; they are not live pricing recommendations. No merge or production deployment.

## Before / After

### list 1440px

| Before | After |
|---|---|
| ![Before](before/list-1440.png) | ![After](after/list-1440.png) |

### list 390px

| Before | After |
|---|---|
| ![Before](before/list-390.png) | ![After](after/list-390.png) |

### family 1440px

| Before | After |
|---|---|
| ![Before](before/family-1440.png) | ![After](after/family-1440.png) |

### family 390px

| Before | After |
|---|---|
| ![Before](before/family-390.png) | ![After](after/family-390.png) |

### calendar 1440px

| Before | After |
|---|---|
| ![Before](before/calendar-1440.png) | ![After](after/calendar-1440.png) |

### calendar 390px

| Before | After |
|---|---|
| ![Before](before/calendar-390.png) | ![After](after/calendar-390.png) |

### new-rule 1440px

| Before | After |
|---|---|
| ![Before](before/new-rule-1440.png) | ![After](after/new-rule-1440.png) |

### new-rule 390px

| Before | After |
|---|---|
| ![Before](before/new-rule-390.png) | ![After](after/new-rule-390.png) |

### review 1440px

| Before | After |
|---|---|
| ![Before](before/review-1440.png) | ![After](after/review-1440.png) |

### review 390px

| Before | After |
|---|---|
| ![Before](before/review-390.png) | ![After](after/review-390.png) |

### groups 1440px

| Before | After |
|---|---|
| ![Before](before/groups-1440.png) | ![After](after/groups-1440.png) |

### groups 390px

| Before | After |
|---|---|
| ![Before](before/groups-390.png) | ![After](after/groups-390.png) |
