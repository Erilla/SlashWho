# Applicant dossier cache policy

Issue #65. Dossiers are assembled on every read from the current discovery
snapshot. No assembled dossier is stored or cached, and the HTTP response stays
`Cache-Control: no-store`. A newly published snapshot immediately changes the
characters included; shared per-character evidence remains reusable within its
own freshness window. This preserves the domain rule that dossiers are views,
not stored records.

| Source                                                             | Storage                                 | Freshness and bound                                                                                           |
| ------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Warcraft Logs normalized kills, parse states, and safe limitations | PostgreSQL, per character               | `FRESHNESS_HOURS` (24 hours by default); one active scan per character; terminal runs retained for 30 days    |
| Blizzard Cutting Edge completions                                  | Web-process memory, per character       | Served 15 minutes after success, held until re-read or evicted; 400 entries and at most 400 pending loads     |
| Raider.IO guild boss rankings                                      | Web-process memory, per raid/boss query | Served 15 minutes after success, held until re-read or evicted; 1,000 entries and at most 1,000 pending loads |
| Blizzard and Warcraft Logs OAuth tokens                            | Owning process memory                   | Provider expiry minus 60 seconds; one shared token refresh                                                    |

Only catalogue-recognized Cutting Edge IDs and completion dates enter the
achievement cache. Full achievement responses and discovery fingerprints are
not cached or persisted. No raw provider response, OAuth token, credential or
request URL is persisted by these caches. The WCL evidence store holds only
normalized kills, explicit parse states, percentiles when available, per-tier
best parses, and public report/fight and character-rankings links as evidence;
it never stores ranking JSON or API request URLs.

WCL first discovers retained kill evidence within `EVIDENCE_REQUEST_CAP` (500
pages by default), then reads parses within the separate
`EVIDENCE_PARSE_REQUEST_CAP` (24 requests by default). That budget covers two
different reads. A character's best parse for a boss comes from `zoneRankings`,
which returns every encounter in a raid zone in one request, so it costs one
request per tier rather than scaling with a character's report history; these
take at most half the remaining budget, newest tier first, and a tier the
budget did not reach keeps the best already stored for it. The rest hydrates
first-kill parses one report at a time, because those must come from the exact
fight and one ranking request returns every requested fight in that report, so
a raid night's bosses cost one request rather than one each. Ranking payloads
are
filtered to identities matching the requested character before the bounded
canonical lookup, so unrelated ranked players cannot exhaust attribution
capacity or invalidate an otherwise usable parse. The cap includes the
canonical lookup requests. A cap or upstream failure leaves verified kills
intact and marks parse metrics `unavailable` with a partial limitation; it does
not manufacture a zero or silently claim completeness. `not_applicable` is
distinct and is used only when independent role evidence establishes that a
metric does not apply.

A run that spends its whole parse budget publishes `partial` and records
`retry_after_at` at `EVIDENCE_PARSE_CAP_RETRY_MS` (30 minutes by default),
which is what makes the next read collect it rather than treat it as fresh for
the full window. A zone already read since its newest kill is dropped before
the zone budget is measured, so the budget advances into deeper tiers and a
saturated character stops raising the cap and settles at `complete`.

A run also checks the Warcraft Logs hourly points allowance before it starts.
When fewer than `EVIDENCE_POINTS_RESERVE` points (1500 by default) remain, the
run is claimed, publishes nothing, and reschedules itself for the reported
reset — clamped to the queue's 1800-second maximum. Five refusals in a row fail
the run, which is safe: `failed` is in neither the active set nor
`loadCompletedEvidence`'s `('complete','partial')`, so the character falls back
to its previous evidence and a later read reserves a fresh run. If the
allowance itself cannot be read the run proceeds, because a gate that fails
closed on its own transport errors could stop all collection permanently.

The provider publishes an hourly point budget, not a fixed cost contract for
`Report.rankings`. The credentialed test probe measured 8 points for one
three-metric query and 9 points after bounded canonical lookups; those are
observations in that environment, not defaults, guarantees, or a cost formula.

Concurrent reads of a key share a promise. Independent browser cancellation
does not cancel the shared upstream request, which has a 15-second timeout.
An expired memory entry is discarded when that entry is next read; the lookup
path does not sweep the whole cache. At capacity the least recently read entry
is evicted, so a boss every dossier looks up survives while one looked up once
does not displace it. A read hit does not extend an entry's freshness window:
its 15 minutes run from the load, so a hot key still re-fetches on schedule.
Restarting a process clears its cache. Replicas each have their own memory
cache, so each one cold-loads the same keys independently; only WCL scan
reservations coordinate across them.

Both memory caches are sized the same way, as one dossier's measured working
set times 40 concurrent cold reads of distinct rosters inside the 15-minute
window: ~25 ranking keys per dossier gives 1,000 entries, and ~10 achievement
keys gives 400. An expired value stays resident until that key is read again
or eviction reaches it, so the 15 minutes bound how long a value is _served_,
not how long it is _held_; the entry count remains the bound on what a process
retains.

Failed achievement/ranking loads are not cached as empty successful results.
The achievement panel explains that newly earned achievements may take up to
15 minutes to appear.
After expiry a failed achievement refresh produces an unavailable limitation
and no Cutting Edge claims. Failed ranking refreshes leave ranks unknown.
Missing/stale WCL evidence queues a scan and displays the gathering state;
cached kills shown during refresh are explicitly described as cached. Settled
partial results retain their provider limitation.

Evidence also carries an internal cache generation. Deployments that change
Warcraft Logs normalization advance that generation, so previously completed
rows are re-collected even when their timestamp is still within the freshness
window. The prior completed evidence remains readable while the replacement
scan runs; a successful publication atomically replaces its normalized kills,
parse states, and limitations.

The worker's scheduled maintenance deletes terminal WCL evidence runs older
than 30 days, with their kill rows removed by the existing cascading foreign
key. Active jobs are excluded. A later request re-collects expired history.
Cleanup logs `evidence_cache_cleanup` with the removed run count. Web cache
events log `dossier_cache` with source and hit/miss/shared/failure/capacity only,
never character names, URLs, payloads or credentials. WCL run status and
completed timestamps remain queryable in the evidence tables.

Verification covers repeated and concurrent reads, TTL expiry, failed refresh,
snapshot membership changes, least-recently-used memory eviction, shared token
refresh, concurrent database reservations, atomic publication and retention
cascading.
