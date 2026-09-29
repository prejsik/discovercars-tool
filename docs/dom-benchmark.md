# DiscoverCars DOM verification benchmark

This manual workflow compares the current four-shard DOM verification topology in two bounded arms:

- four verifier processes running concurrently on one GitHub runner;
- the same four shard inputs running on four matrix runners.

It does not publish files, update Excel, send Telegram messages, or change the daily workflow.

## Source and sample

Dispatch `.github/workflows/discovercars-dom-benchmark.yml` with the run ID of a completed DiscoverCars daily workflow whose `discovercars-checkpoint-<run-id>` artifact is still retained.

The prepare job reads the checkpoint's pre-verification `pricing-recommendations.json`, uses `splitActiveRecommendations` to order eligible date-duration groups, and selects at most the first eight groups. It then uses the same API again to create four shard inputs. Held recommendations and recommendations with an already verified source status are not part of the live benchmark sample.

The sample, four shards, and manifest are uploaded once. Every worker downloads that artifact and verifies the same benchmark-input SHA-256. The manifest also hashes the shared verifier options:

- concurrency: 1;
- page timeout: 45 seconds;
- verifier budget: 14 minutes;
- process cap: 15 minutes;
- speed mode: `fast`.

## Outputs

Each arm records one timing file per shard, including elapsed time, exit code, input hash, and verifier-options hash. The report job merges both arms with `recommendationDomShards.js merge`, so absent, corrupt, duplicate, or unverified shard output is handled by the existing fail-closed behavior.

The `discovercars-dom-benchmark-report-<benchmark-run-id>` artifact contains:

- `benchmark-report.json` with timing, completeness, structural-quality, nonconfirmed, classification-difference, and rate-difference data;
- `benchmark-report.md` with the concise comparison;
- both merged recommendation payloads and merge summaries;
- the immutable input manifest.

Structural quality requires all four worker timings, zero worker failures, matching hashes, complete decision coverage, and zero merge-level missing, duplicate, unverified, missing-shard, or corrupt-output counts. A live recommendation may still be classified as nonconfirmed; that is reported separately from structural completeness.

## Interpretation limits

The arms make separate live requests and GitHub may start their workers at different times. The report compares critical-path worker duration and exposes all observed classification and rate differences. It deliberately sets `live_price_equivalence` to `false`: matching or differing prices cannot establish that the two arms observed an equivalent live market state.

The workflow becomes launchable only after the primary operator reviews and pushes it. Creating these files does not dispatch a workflow or authorize any external side effect.
