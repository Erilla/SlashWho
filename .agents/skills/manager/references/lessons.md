# Review checklist by area

Pick the sections that match the PR and put them in the reviewer's brief as specific questions. Each one comes from a real bug or near miss in this repo, and the project memory has the detail.

## Evidence collection and publishing

- A **complete publish drops what the run didn't re-find.** If a change skips or narrows a read and still publishes complete, stored kills, parses or attendance are deleted. This cost 9 characters on 2026-09-23.
- **The widest window wins.** Narrowing a content window, or reranking sources, can withhold real kills. Moving a kill to another raid changes current-content eligibility.
- Failures (429, refusal, schema drift, spent budget) must become a limitation or a retry. They must never become a silent "searched, nothing found".

## Warcraft Logs

- `report.zone` is not per fight. Trust each fight's `gameZone` and difficulty (Mythic is 5).
- `journalID` is always 0, so boss names are the only join to the catalogue. Replay stored rows under the old and new rules before changing name resolution. Pin curated data by name in tests, because counts miss transposed values.
- Points are charged per report part: fights 1, masterData 1, rankings 2 per metric, zoneRankings 5 per metric. A 100-report listing costs about 2. Check any claimed saving with this arithmetic.
- The allowance fully resets each hour. The allowance probe costs 1 point, so a clean handover between runs shows a gap of 1. Point deltas share production's counter.
- Guild attendance returns every guild report, so filter on players{name} before hydrating.
- The run's caps come from the allowance its own credentials report (`effectiveRequestCap`). Visitor and operator costing must stay separate.

## Identity and names (from #735 to #741)

- **Crediting evidence to a character.** It must rest on the WCL canonical character id matching exactly one ranked entry, plus a unique actor in that fight's `friendlyPlayers`. It must never rest on a name alone.
- **Former names, aliases and ranked names.** They are scoped by realm. The current name wins, and a report that credits the current name isn't also read under a former name.
- **Tests for each safeguard.** Ask for a test on each one: the canonical-id filter, the realm, and current-name-first. Then check the test fails when the safeguard is removed. Several reviews found a safeguard whose removal passed every test.
- **Narrowing what is read.** When a change narrows reads, for example deferring attendance or skipping reports, missing or failed data must not be treated as "nothing there". Only defer on limitations a later run actually continues.
- **Batching reads.** When fights are batched into one read, every check has to apply to every fight, not just the one that triggered the read. A requested fight that is missing from the read is `schema_drift`, not a silent miss.

## Blizzard and Raider.IO

- Blizzard allows 100 requests a second and 36,000 an hour per client id, and the web and the worker share one client id. The worker's limit and the web's limit are tied together by a failing test in `apps/worker/src/runtime.test.ts`. Any change to either must keep that test meaningful: it must use the schema maximum, not the default.
- `BLIZZARD_HOURLY_REQUEST_BUDGET` charges discovery only. Uncharged traffic (evidence runs, web reads) must fit in what's left.
- Limiter queue wait must be excluded from latency buckets and reported as `*LimiterWaitMs`.
- Fast-end and latency statistics must come from successful calls only. 404s, 429s and aborts are fast and misleading.
- Constants that each take a share of the same budget in different files are never checked against each other. Invariants belong in tests, not comments.
- `*_BASE_URL` settings must reach every client, including visitor-credential gateways, or e2e sends dummy credentials to live providers. The worker's WCL client once ignored `WARCRAFT_LOGS_BASE_URL`; this was fixed in #704.
- **Raider.IO has no worker-wide limiter,** only per-phase caps. A 429 should stop the queue. Permanent answers (`not_found`, `private`, `schema_drift`) should be stored, not re-read every run. A Raider.IO shortfall must not trigger a full evidence re-run through `capRetryMs`.
- **Roster and privacy data from providers.** Suppressed characters are filtered when the data is read. Privacy that a provider can change (for example `shareRaidUntil`) must be re-read, not cached forever.

## Concurrency and measurement

- Results must be placed by index and must not depend on completion order. Request caps must be reserved before a request starts.
- `overlapping: "shared"` scopes split wall time. The "slowest call" must use each call's own elapsed time.
- New log fields must match the logger allowlist or `measurementField` pattern, because unknown fields are silently dropped.

## Web page and polling

- A stale response must never overwrite a newer one (sequence claims from #629).
- Stop conditions (#683) and resume wake-ups, including resume times already in the past, must interact correctly with the quick progress watcher (#707).
- Retries must be bounded or visible. A lasting failure shows an error after about 15 s. A deployment fault (`trusted_client_ip_unavailable`) is final.
- Server-Timing only appears on routes that opt in, and only when `SERVER_TIMING_ENABLED` is "true". It must not leak account existence or cache state.

## Database and migrations

- Migration numbers must follow main's latest. Journal `when` values must strictly increase. Parallel PRs collide.
- Transaction boundaries, advisory locks and statement order must not change in a refactor. Check `evidenceRunColumns` when adding run columns.
- Test PostgreSQL tuning must stay test-only.

## Security and dependencies

- The lockfile's `minimumReleaseAge` policy is deliberate. Pin an older fixed version instead of relaxing it.
- Committed fixtures must contain no real credentials, and no real names beyond the owner's own characters that are already in the repo.
- Artifacts from this public repo are visible to any GitHub user. Logs must contain fixture data only.
