# Impact Preview v1

## Entry Points

- Local API: `runLocalPreview(draft, { previewId, requestedAt })` from `server/run-preview-job.mjs`. `draft` contains `revision` (UUID), `sourceRevision`, `sourceHash`, `modelHash`, `baselineSha256`, and `model: { pricing, excel, locations }`. It returns a completed envelope; the API may queue it in the background. Local results always have `testsSucceeded: false` and cannot authorize publication.
- Pinned CLI: `node rules-panel/server/impact-preview.mjs --request <absolute-request.json>`. JSON goes to stdout; blocked requests exit 1. This local CLI is not a public Actions log sink.
- Private Actions runner: `node rules-panel/server/run-preview-job.mjs validate|run`. Dispatch fields are only `preview_id` and the encrypted `request`; secret is `PANEL_PREVIEW_KEY`. Validation works before npm installation. Only encrypted `preview.enc` is uploaded.

## Immutable Request

The CLI accepts `schemaVersion: 1`, `draftRevision` (UUID), `sourceRevision` (40-character commit SHA), `runId`, `current`, `proposed`, and `artifacts`. Both document sets contain pricing, Excel configuration and the unchanged location registry. Every artifact reference is `{ path, sha256 }` with a SHA-256 of its exact bytes.

Required artifacts: `baselineWorkbook`, `baselineManifest`, `runManifest`, `finalRecommendations`. Optional: `results`, `calibration` (required for enabled markup replay). Canonical baseline: `input/mm-cars-rental-rates-inclusive-fp.xlsx`, pinned by `input/baseline-manifest.json`. No generated import is promoted to a baseline.

`sourceHash` and `modelHash` are SHA-256 of UTF-8 `JSON.stringify` of the respective `{ pricing, excel, locations }` document objects, matching the shared workspace service. Actions additionally binds the decrypted request to `github.sha`, the actual checkout and an age of at most one hour.

## Evidence And Replay

The runner reads the fixed public `latest-full` report URLs. The manifest is downloaded before and after the data; both byte hashes must match. The report commit's pricing, locations and frozen calibration are read from immutable official GitHub raw URLs and compared with the current source documents. An unrelated newer source commit is not itself a mismatch.

Published `success` and `degraded` reports are usable. Missing market support is retained as frozen final decisions, not converted into permission to change market targets. Scope gaps and replay coverage are explicit. Artifact/hash/baseline inconsistency still blocks the entire calculation.

Large final JSON is streamed through Python's standard JSON decoder. All final decisions, including their full DOM repricing support, are preserved. Duplicated recommendation objects are checked against those decisions and replaced by identity references. Original byte hash, byte size and counts are retained in `normalization`; the reduced artifact has its own pinned hash.

Complete raw evidence is used only where replay agrees with final economic decisions. Compact public JSON is never labelled complete raw replay. Changed pricing can replay independently validated cached DOM offers using the existing `rebuildDomRecommendation` engine; only its ephemeral counterfactual policy stamp changes after original support is validated. Other market decisions remain frozen, including quality holds. Mandatory floors and all other Excel constraints are evaluated by the actual export engine over the full workbook.

The existing DOM verifier's 12-hour freshness limit is unchanged. General source/publication freshness is bounded at 24 hours. Proposed raw and DOM replay receive the matching in-memory `excelPolicy`, so changed date protection or omissions cannot fall back to an older disk configuration.

Configuration is not rewritten for the simulation except to redirect input dependencies to their pinned temporary copies. The current configuration uses `pickup_date_expansion.mode: "source_ranges"` and `max_import_rows: null`, preserving all baseline pickup-date ranges in both Excel outputs without a 100-day cutoff. Ranges split only at scraper recommendation dates and mandatory-floor/protected-date boundaries; other ranges remain compact. Market changes apply only to dates present in scraper recommendations. The scraper schedule remains unchanged at 45 days overnight and 20 days during the day; future requests use their actual configuration. The engine's configured limits, class permissions, protected dates, parity and frozen markup remain authoritative. Technical input-size/time bounds are resource guards, not business rules.

## Completed Envelope

Identity fields: `schemaVersion`, `previewId`, `revision` (preview UUID), `draftRevision`, `sourceRevision`, `sourceHash`, `modelHash`, `baselineSha256`, `resultsSha256`, `runId`, `completedAt`, `dataCollectedAt`, `testsSucceeded`.

The engine CLI does not manufacture preview UUIDs or test attestations. The runner adds those fields. `dataCollectedAt` is the oldest included collection timestamp, never the time a file was copied or regenerated.

- `before`, `after`: `changeCount` (actual engine change operations), `changeStatistics`, `activeRecommendationCount`, `holdDecisionCount`, `importRowCount`, `rateCellCount`, `skippedTargetCount`, `validation`, `recommendationDateScope`, `floorChangeCount`, `cityCapConflictCount`.
- `impact`: exact semantic grid comparison with `changedRateCells`, `increasedRateCells`, `decreasedRateCells`, `addedRateCells`, `removedRateCells`, `unchangedRateCells`, `samples`, `samplesTruncated`. Counts are not inferred from the export engine's truncated first 100 changes. Reordering rows does not create false price changes.
- `impact.samples[]`: `position: { zone, group, cell, pickupDate, pickupEndDate, durationBand }`, `beforeCell`, `afterCell`, `beforeRate`, `afterRate`, `beforeDecision`, `afterDecision`. Decision objects expose `reason` and `status`; report reasons come from the actual export review sheet. At most 20 samples are included; totals remain exact.
- `coverage`: `totalDecisionCount`, `missingDecisionCount`, `rawReplayedDecisionCount`, `domReplayedDecisionCount`, `frozenMarketDecisionCount`.
- `provenance`: hashes of every pinned input and actual engine source, source run ID/revision/status and immutable source-policy proof. `limits` reports the actual Excel configuration. `limitations` and `error.message` are Polish, director-facing text.

## Status Boundary

`requesting`, `queued`, `running` belong to the API queue. This adapter returns only `success` or `blocked`; infrastructure failures may be represented by the API as `failure`.

`success` means both real temporary exports completed and the exact comparison is available. It does not claim complete market replay, live ranking, broker import or future revenue. Read `mode`, `coverage` and `limitations` together. Modes are `full_replay`, `verified_dom_replay`, `frozen_market`, `excel_only`.

`blocked` has `error: { code, message }`, no invented counts, and `testsSucceeded: false` in runner envelopes. Stable error codes include `baseline_mismatch`, `hash_mismatch`, `source_changed`, `stale_evidence`, `publication_race`, `inconsistent_recommendations`, `engine_timeout`, `engine_failed`, `validation_failed`, `tests_failed`.

Only the Actions runner may set `testsSucceeded: true`, after root `test:all`, panel `npm test` and panel `test:engine` pass. Publication also requires exact draft/source/model/baseline bindings, a verified successful Actions run, completion within one hour and collection within 24 hours. A successful local preview never satisfies that gate.

All exports and downloads are temporary and removed after execution. No scraping, learning, schedule changes, baseline promotion or production-directory writes occur. This workflow is prepared locally; its deployment or dispatch remains a separately authorized action.
