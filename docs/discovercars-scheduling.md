# DiscoverCars schedules

## GitHub-only operation

- Night: 60 pickup dates, existing evening UTC retry windows.
- Day: 30 pickup dates, 09:07 and 09:37 Europe/Warsaw (summer/winter windows are filtered).
- Same production scraper, locations, durations 2-14, Excel quality checks, Pages and Telegram secrets.
- GitHub cron is best effort, not a guarantee of results by 14:30.
- The whole workflow remains serialized to protect shared Pages publishing. `queue: max` preserves pending attempts instead of replacing the previous pending attempt. A running job may delay another slot.

Each scheduled attempt has an explicit slot/date identity. A successful no-op has no publication marker and cannot suppress a retry. A completion marker is uploaded only after successful Pages deployment, Excel artifact upload and final quality checks. API errors fail closed rather than starting an unchecked duplicate. Artifacts expire after seven days; duplicate checks only inspect the last three days.

The gate anchors scheduled dates to the original run creation time and the preceding nominal cron occurrence, not the eventual job start. A GitHub schedule delayed by more than a full day cannot be unambiguously dated from GitHub's event; external dispatch supplies an explicit report date. Obsolete dates are rejected.

## Independent server trigger (prepared, not deployed)

Install only on an approved always-on Linux server. This does not run the scraper there; it dispatches the same GitHub workflow at 09:00 Warsaw and verifies that the `Run scraper` step actually starts. It leaves a queued run alone, checks again at 09:20/09:40, and caps dispatch attempts at three. Systemd prevents overlapping instances of the same service. Use one designated scheduler host.

Required: Node 22, this repository checked out at `/opt/discovercars-tool`, and a dedicated `discovercars-scheduler` OS user. The service templates are in `deploy/`. Configure `/etc/discovercars-scheduler.env` securely (root-owned, mode 0600) with `GH_TOKEN` scoped to this repository, Actions read/write; repository metadata read is automatic. Prefer a short-lived GitHub App token with a server-managed refresh mechanism if available. Never commit or paste tokens into chat.

GitHub's per-run `GITHUB_TOKEN` cannot be reused permanently on an external server. Existing Telegram and pricing secrets stay in GitHub; do not copy them. Approve the target host/access before installation. Enable the provided timer there and verify with `systemctl list-timers` and `journalctl -u discovercars-scheduler.service`. Nonzero service exit means the start was not confirmed; wire it into the server's existing monitoring. No external alert destination is configured by these templates.

External requests use `workflow_dispatch` with `schedule_slot=day` and `report_date=YYYY-MM-DD` on `main`. The production gate overrides manual smoke-test input defaults with all daily locations, rolling 30, durations 2-14. Both cron fallback and external dispatch share the same deduplication key. A trigger request accepted by GitHub is not proof the scraper started; the watchdog checks the jobs API for that.

## Verification

`node tests/run-schedule-tests.js`

`node tests/run-scheduler-watchdog-tests.js`

Incident covered: the daytime success-with-skipped-scraper from September 28 must not block the three nighttime attempts on September 29. Also cover publication markers, failed/expired attempts, queued runs, summer/winter transitions, delayed jobs across midnight, invalid report dates and external dispatch.
