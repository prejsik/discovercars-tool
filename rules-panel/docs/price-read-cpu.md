# Price read CPU fix

## Observed failure

Authenticated production reads of `/api/report/prices` returned HTTP 503. Scoped Cloudflare logs reported `outcome: exceededCpu` and `Worker exceeded CPU time limit`, including CDMV/KRLO and CDMV/GDLO. The current report manifests were approximately 630 KB each. Every context read parsed two manifests and read a GitHub revision before returning compact metadata.

The cold path could exceed the public HTTP Worker's CPU allowance even though CI and local simulations passed. This is a runtime budget issue, not evidence of wrong rates.

## Change

- Keep Cloudflare Access verification, the allowlist, GET-only endpoints and private/no-store responses at the HTTP boundary.
- Delegate only price metadata/binary evidence to a read-only RPC method on the **existing** private `RulesWorkspace` object. It rechecks the approved actor and integration before reading. No new binding, migration, plan, permission or persistent data is introduced.
- Return native `Response` objects over RPC, including binary streams. Parsing manifests, GitHub authentication, hashing and JSON serialization no longer execute in the small HTTP request budget.
- Cache only parsed `locations.config.json`, pinned to its immutable 40-character commit SHA. Bound it to eight revisions, share pending reads and discard failures. Do not reuse a GitHub installation token across requests.
- Mutable latest manifests are fetched on every read. A new run, changed commit, changed file digest or a corrupt source is still detected by the existing report helpers. The helper implementations and SHA/signature comparisons are unchanged.
- Price reads do not enter the publication queue or write Durable Object storage. Existing baseline/policy publication and scheduler methods are unchanged.

Cloudflare references: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [RPC supported types](https://developers.cloudflare.com/workers/runtime-apis/rpc/).

## Verification

The new HTTP boundary regression test was run and failed before the fix: when direct HTTP-side source work was disallowed, the original endpoint returned 502 instead of the delegated result. It passes after delegation.

Unit tests cover pinned/bounded configuration caching, concurrent reads, fresh manifests, changed run/commit/digest, retry after failure, exact binary bytes and rejected mismatching hashes. The Workers runtime test uses the actual `RulesWorkspace.priceEvidence` method and RPC `Response` transfer, two 630 KB manifests, a 1 MB binary source, actor denial, stale-run denial and zero storage writes.

Local checks: panel unit suite, complete worker suite including the new RPC test, production build/dry-run, price/calendar UI and compact-market UI. UI regressions retain exact rates, class/code changes, protected dates, responsive widths and no writes in read-only flows. Production confirmation must exercise real authenticated class/duration/code changes and inspect scoped Worker outcomes; local tests do not simulate Cloudflare's enforced CPU budget.
