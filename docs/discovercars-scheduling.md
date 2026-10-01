# DiscoverCars schedules

## GitHub-only operation

- Night: 45 pickup dates, existing evening UTC retry windows.
- Day: 30 pickup dates, 09:07 and 09:37 Europe/Warsaw (summer/winter windows are filtered).
- Same production scraper, locations, durations 2-14, Excel quality checks, Pages and Telegram secrets.
- GitHub cron is best effort, not a guarantee of results by 14:30.
- A short, serialized gate checks and records the slot/date claim. Scraping and verification do not hold the shared Pages lock. Only the final publication job uses `discovercars-pages-site`, also used by manual report publication.
- Pushes run the separate `discovercars-ci.yml` regression workflow. They do not start a production scrape, replace reports, or send Telegram messages.
- Collection uses two independent runners with disjoint pickup dates and all requested locations/durations in each. Each runner allows four active pages (one chunk, two scenarios, two locations), keeping the previous aggregate eight-page budget. One-day manual scopes use one runner. The original global scope is checked again after merging.
- Collection artifacts retain successful chunk results and partial scenario checkpoints for a restart of the same Actions run. `Re-run failed jobs` retries failed collection shards after their checkpoint upload; rerunning all jobs restores the original immutable scope/plan first. Restoring requires matching scope, run ID, scraper code and fresh timestamps (at most two hours old). Incompatible or expired pieces are re-collected. A hard runner loss before artifact upload can still lose progress; this is not an external continuous backup.
- Verification uses 1-16 workload-sized shards on independent runners, with at most four running at once. Groups are assigned by predicted location work, using valid bounded historical timings when available. Split-time assignments are immutable during merging. The target is 90 minutes per shard with a hard 150-minute evidence budget. More shards run in waves; the forecast reports the remaining wall time, not an assumption that all 16 run at once.
- Only confirmed checks are resumable. Checkpoints bind the exact input, extractor version and a two-hour reuse limit. Current-run evidence has a separate twelve-hour validity window so queued verification waves do not invalidate an otherwise normal long run. A failed or missing shard blocks its unchecked recommendations, while checked results can still be exported with an explicit partial status.
- A fixed requested scope is saved before scraping. Missing dates, durations and locations cannot disappear from the coverage denominator. Midnight does not change the pickup date list halfway through a run.
- The publication guard compares source start timestamps. An older run cannot overwrite a fresher report or Excel. Its own results remain available in its Actions artifact. Failure to preserve a complete current bundle aborts deployment instead of silently deleting existing files. Both workbooks are required together; new manifests bind their SHA-256 digests to the same publication.

Each scheduled attempt has an explicit slot/date identity. A successful no-op has no publication marker and cannot suppress a retry. A completion marker is uploaded only after successful Pages deployment, Excel artifact upload and final quality checks. API errors fail closed rather than starting an unchecked duplicate. Schedule markers expire after seven days; duplicate checks only inspect the last three days. Collection and verification checkpoint artifacts expire after two days; their shorter data-freshness limits still apply.

The gate anchors scheduled dates to the original run creation time and the preceding nominal cron occurrence, not the eventual job start. A GitHub schedule delayed by more than a full day cannot be unambiguously dated from GitHub's event; external dispatch supplies an explicit report date. Obsolete dates are rejected.

## Independent server trigger (prepared, not deployed)

Current operating choice: stay on GitHub cron, without adding a server or a new paid service. The templates below are optional and are not installed by a repository push. A laptop is not required for GitHub-hosted runs. Exact start/completion times cannot be guaranteed by the cron schedule.

Install only on an approved always-on Linux server. This does not run the scraper there; it dispatches the same GitHub workflow at 09:00 Warsaw and verifies that the `Run scraper` step actually starts. It leaves a queued run alone, checks again at 09:20/09:40, and caps dispatch attempts at three. Systemd prevents overlapping instances of the same service. Use one designated scheduler host.

Required: Node 22, this repository checked out at `/opt/discovercars-tool`, and a dedicated `discovercars-scheduler` OS user. The service templates are in `deploy/`. Configure `/etc/discovercars-scheduler.env` securely (root-owned, mode 0600) with `GH_TOKEN` scoped to this repository, Actions read/write; repository metadata read is automatic. Prefer a short-lived GitHub App token with a server-managed refresh mechanism if available. Never commit or paste tokens into chat.

GitHub's per-run `GITHUB_TOKEN` cannot be reused permanently on an external server. Existing Telegram and pricing secrets stay in GitHub; do not copy them. Approve the target host/access before installation. Enable the provided timer there and verify with `systemctl list-timers` and `journalctl -u discovercars-scheduler.service`. Nonzero service exit means the start was not confirmed; wire it into the server's existing monitoring. No external alert destination is configured by these templates.

External requests use `workflow_dispatch` with `schedule_slot=day` and `report_date=YYYY-MM-DD` on `main`. The production gate overrides manual smoke-test input defaults with all daily locations, rolling 30, durations 2-14. Both cron fallback and external dispatch share the same deduplication key. A trigger request accepted by GitHub is not proof the scraper started; the watchdog checks the jobs API for that.

## Verification

`node tests/run-schedule-tests.js`

`node tests/run-scheduler-watchdog-tests.js`

`node tests/run-pipeline-tests.js`

`node tests/run-scrape-shard-tests.js`

`node tests/run-weighted-verification-tests.js`

`node tests/run-verification-resume-tests.js`

`node tests/run-scope-quality-tests.js`

Incident covered: the daytime success-with-skipped-scraper from September 28 must not block the three nighttime attempts on September 29. Also cover publication markers, failed/expired attempts, queued runs, summer/winter transitions, delayed jobs across midnight, invalid report dates and external dispatch.
