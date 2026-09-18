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

Such a run carries its shortfall in `parse_limitation_code` alone:
`limitation_code` reports the history scan, which finished, and the negative
conclusions resting on it stand. A `partial` publication must name a shortfall
in one of the two channels, and either one satisfies that.

## Concluded tiers are stored once

A concluded raid tier cannot change, so its evidence is stored once and never
re-queried. Only the current tier keeps costing upstream requests. A tier is
recorded as **terminal** in `character_terminal_tiers`, per character, per
raid, per collection domain (`kills`, `parses`, `tier_bests`), and only when
all three of the following hold:

1. **The raid's current-content window has closed**, as
   `raid-current-content-windows.generated.json` records it. A raid the
   catalogue cannot place in time is never terminal: freezing undated evidence
   is worse than re-querying it, and such a raid keeps reporting
   `current_content_window_unknown`.
2. **The run read the tier without incident.** A limitation attributed to a
   raid leaves that raid re-queryable however old it is, and a limitation on
   the history scan leaves every raid re-queryable, because a truncated or
   drifted scan may be missing reports from any tier — kills and wipes, not
   merely parses. Whether collection is good enough is therefore not a
   judgement call but an invariant enforced per tier.
3. **Every kill in the tier has settled**, meaning it is older than
   `EVIDENCE_KILL_SETTLE_DAYS` (7 by default). The same threshold excludes an
   unsettled fight from `hydratedFightUrls`, so a kill from this week is
   re-read rather than frozen at whatever it showed on the night. **The 7 is a
   guess and explicitly unverified**; the `collected_at` now stored with each
   kill and tier best records when a percentile was observed, which is what
   should replace it with a measurement.

A terminal tier costs nothing: its zone is dropped before the tier-bests
budget is measured, its kills are never grouped for hydration, and the report
scan stops paging once it is below the oldest kill of any tier that is not yet
terminal. That stop raises no limitation — a cap there would mark the run
partial and block the very marks that allowed it.

Because the scan stops, a `complete` publication carries forward the stored
kills and wipes of terminal raids. Every other raid keeps the existing rule,
where a kill a complete run stops finding stops being claimed.

A dossier therefore converges rather than completing in one pass: clean tiers
settle and stop costing requests, while tiers that hit trouble keep being
retried until a run reads them cleanly, so the budget drains towards what is
actually unfinished.

Two things are frozen by policy rather than because they cannot move. A parse
is a percentile against a ranking pool and a world rank a position within one;
the kill is immutable, the number is not. We accept the first settled value as
final, because a reviewer wants what the applicant achieved rather than a
figure that quietly re-rates itself for years. Likewise a Warcraft Logs report
can be deleted or made private, and stored evidence is kept: we recorded what
was public when we saw it.

Two gaps are known. A decode that succeeds and produces a wrong value raises
no limitation and would go terminal; storing raw payloads for failed decodes
would reduce that risk and is not done here. And a kill outside its raid's
current-content window is skipped from hydration with no limitation, so its
tier can settle with that fight unhydrated — those kills are never displayed,
which is why hydration skips them.

### Correcting terminal evidence

Two escape hatches, for different needs.

`CURRENT_COLLECTION_VERSIONS` in the database package holds a version per
domain. Bumping one drops that domain's marks out of every read, so its tiers
re-collect once and settle again while the other domains stay terminal. A
parse fix therefore re-collects parses and not kills, rankings or
achievements. Whoever writes the next collection fix has to bump the right
one; if that habit does not stick, this degrades to the blunt global bump that
`evidence_version` still provides.

`corepack pnpm ops:rebuild <character-url>` forgets every terminal mark for
one character. It is a flag, not an action: it clears the marks and returns,
and the ordinary run, retry and budget machinery drains the backlog across as
many hourly windows as it takes. It deletes nothing, so the stored evidence
stays readable until its replacement arrives.

The dossier refresh control cannot reach a rebuild. It stays `full` outside the
cooldown and `light` inside it, one run per press, whatever it is sent.
`/api/dossiers/.../refresh` is unauthenticated, which is tolerable at one run
per press and would not be if a press could re-collect a whole history on
demand; keeping the mode unreachable is a better answer than gating a public
endpoint. A rebuild is operator-only and run with credentials.

A run also checks the Warcraft Logs hourly points allowance before it starts.
When fewer than `EVIDENCE_POINTS_RESERVE` points (1500 by default, capped at a
tenth of whatever allowance the account in use reports, so a visitor's smaller
budget is not fenced off by a threshold sized for the worker's; `0` switches
the gate off) remain, the
run is claimed, publishes nothing, and reschedules itself for the reported
reset — clamped to the queue's 1800-second maximum. On the last of its five
attempts the run refuses without asking for a retry and marks itself `failed`
with `points_budget_low`. That last step is load-bearing: a run abandoned in
`running` is counted active by `reserve` with no staleness cutoff and would
block every later reservation for that character. `failed` is in neither that
set nor `loadCompletedEvidence`'s `('complete','partial')`, so the character
falls back to its previous evidence and a later read reserves a fresh run. If the
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
