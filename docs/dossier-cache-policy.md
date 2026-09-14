# Applicant dossier cache policy

Issue #65. Dossiers are assembled on every read from the current discovery
snapshot. No assembled dossier is stored or cached, and the HTTP response stays
`Cache-Control: no-store`. A newly published snapshot immediately changes the
characters included; shared per-character evidence remains reusable within its
own freshness window. This preserves the domain rule that dossiers are views,
not stored records.

| Source                                                             | Storage                                 | Freshness and bound                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Warcraft Logs normalized kills, parse states, and safe limitations | PostgreSQL, per character               | `FRESHNESS_HOURS` (24 hours by default); one active scan per character; terminal runs retained for 30 days |
| Blizzard Cutting Edge completions                                  | Web-process memory, per character       | 15 minutes after success; 1,000 entries and at most 1,000 pending loads                                    |
| Raider.IO guild boss rankings                                      | Web-process memory, per raid/boss query | 15 minutes after success; 256 entries and at most 256 pending loads                                        |
| Blizzard and Warcraft Logs OAuth tokens                            | Owning process memory                   | Provider expiry minus 60 seconds; one shared token refresh                                                 |

Only catalogue-recognized Cutting Edge IDs and completion dates enter the
achievement cache. Full achievement responses and discovery fingerprints are
not cached or persisted. No raw provider response, OAuth token, credential or
request URL is persisted by these caches. The WCL evidence store holds only
normalized kills, explicit parse states, percentiles when available, and public
report/fight links as evidence; it never stores ranking JSON or API request
URLs.

WCL first discovers retained kill evidence within `EVIDENCE_REQUEST_CAP` (500
pages by default), then hydrates report-scoped parse groups within the separate
`EVIDENCE_PARSE_REQUEST_CAP` (8 requests by default). Ranking payloads are
filtered to identities matching the requested character before the bounded
canonical lookup, so unrelated ranked players cannot exhaust attribution
capacity or invalidate an otherwise usable parse. The cap includes the
canonical lookup requests. A cap or upstream failure leaves verified kills
intact and marks parse metrics `unavailable` with a partial limitation; it does
not manufacture a zero or silently claim completeness. `not_applicable` is
distinct and is used only when independent role evidence establishes that a
metric does not apply.

The provider publishes an hourly point budget, not a fixed cost contract for
`Report.rankings`. The credentialed test probe measured 8 points for one
three-metric query and 9 points after bounded canonical lookups; those are
observations in that environment, not defaults, guarantees, or a cost formula.

Concurrent reads of a key share a promise. Independent browser cancellation
does not cancel the shared upstream request, which has a 15-second timeout.
Expired memory entries are discarded on the next cache access; oldest entries
are evicted at capacity. Restarting a process clears its cache. Replicas each
have their own memory cache; only WCL scan reservations coordinate across them.

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
snapshot membership changes, bounded memory eviction, shared token refresh,
concurrent database reservations, atomic publication and retention cascading.
