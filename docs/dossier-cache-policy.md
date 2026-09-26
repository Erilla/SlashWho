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
| Blizzard Cutting Edge completions                                  | Web-process memory, per character       | Served 15 minutes after success, held until re-read or evicted; 1,000 entries and at most 1,000 pending loads |
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

A run that spends one of its own request budgets publishes `partial` and
records `retry_after_at` at `EVIDENCE_CAP_RETRY_MS` (30 minutes by default),
which is what makes the next read collect it rather than treat it as fresh for
the full window. A zone already read since its newest kill is dropped before
the zone budget is measured, so the budget advances into deeper tiers and a
saturated character stops raising the cap and settles at `complete`.

Every other limitation is classified the same way, and the classification is
the whole of it: a code either has an answer to "when might this be worth
trying again" or it does not. An unreachable upstream and throttling that
carried no `Retry-After` are transient and wait `EVIDENCE_TRANSIENT_RETRY_MS`
(15 minutes by default). A character with no public logs, a private one, and
schema drift get no retry, because none of those is resolved by waiting —
drift needs a code fix and the rebuild that follows it. Where upstream sent its
own `Retry-After`, that is kept in preference to either default.

A code with no retry is genuinely settled rather than merely quiet, but it
still reads on the dossier as an unfinished run. Making that distinction
visible is outstanding work, not something this classification achieves.

Such a run carries its shortfall in `parse_limitation_code` alone:
`limitation_code` reports the history scan, which finished, and the negative
conclusions resting on it stand. A `partial` publication must name a shortfall
in one of the two channels, and either one satisfies that.

## What drives a waiting run

A `retry_after_at` makes a run _eligible_ to resume; it does not make it
happen. The worker runs a resume sweep every five minutes that lists the
characters whose newest completed run asked to be resumed and whose deadline
has passed, then reserves and enqueues each of them, up to
`EVIDENCE_RESUME_SWEEP_LIMIT` (25 by default) per tick.

Without it, `reserve` was reached only from a dossier read or the refresh
endpoint. Collection therefore continued only when somebody happened to load
the page — so the dossier nobody was watching was the one that quietly never
finished, and every completeness measurement was an artefact of how often
someone looked.

The sweep only reserves and enqueues. It adds no concurrency and holds no
budget of its own: the evidence queue still collects one run at a time and the
points gate still refuses a run it cannot afford, so a sweep cannot spend more
per hour than a reader already could. It carries no credentials either — a
visitor's Warcraft Logs key belongs to the read that supplied it, so a sweep
reserves anonymously and the run falls back to the worker's own account.

Its population is deliberately narrower than `reserve`'s own staleness rule,
which also hands back evidence merely older than `FRESHNESS_HOURS`. Sweeping
those too would make this a background re-collection of every character ever
seen; they are re-collected when read, as before.

One gap remains. A character whose _first ever_ run fails outright has no
completed run for the sweep to read, so only a dossier read recovers it — as
was true before the sweep existed. Widening the population to cover it would
also make a `not_found` character retry forever, so it needs the limitation
classification above to be consulted there too.

## Recovering a run nothing is working on

A run whose worker dies between `claim` and its publication stays `running`
for ever. `reserve` counts `(queued, running, retrying)` as active with no
staleness cutoff, so every later dossier read joins a run that is running
nowhere, the resume sweep skips the character as already in hand, and it never
collects again. An orderly shutdown records an outcome; a hard kill, an OOM, a
container pulled by the platform or a database failure mid-publish cannot.

The same five-minute sweep therefore releases abandoned runs before it resumes
waiting ones — first, so a character freed on a tick can resume on that same
tick. A run is abandoned when either holds:

- **Its queue job can no longer run.** Completed, cancelled, failed, or
  deleted from pg-boss altogether: whatever the run row says, nothing is going
  to pick that job up. This is the arm that fires in practice.
- **Nothing has ever touched it and it is older than fifteen minutes.** No
  job id and no claim means `reserve` created the row and the process died
  before `enqueue` returned. `markEnqueued` normally follows within
  milliseconds, so a run still in that gap after fifteen minutes is orphaned
  with near-certainty — and it cannot be deferred or mid-collection, so there
  is nothing to wait out.
- **It is older than eight hours**, measured from `started_at` where a worker
  claimed it and `created_at` where none did. The far backstop, for anything
  pathological that slips past both arms above.

**This is recovery in hours, not minutes, and deliberately so.** When a worker
is killed, pg-boss does not fail its job — it expires the `active` job after
`expireInSeconds` (1800) and moves it to `retry` while retries remain, and
each of those redeliveries genuinely re-claims and re-collects the run. With
`retryLimit` 4 that chain can run five times before the job reaches `failed`.
Until then the run is not abandoned at all, and releasing it would buy a
duplicate Warcraft Logs collection. The queue arm therefore fires once the
chain is spent, which is the first moment the run is provably dead. What the
five-minute cadence buys is that recovery happens promptly _after_ that point
rather than up to an hour later.

Eight hours for the far backstop follows from the same arithmetic. `started_at` is
stamped on the first claim and never advanced, so a healthy run working
through a full deferral chain — five attempts, each able to occupy 1800
seconds and to wait up to another 1800 before the next — can measure close to
five hours old. Six hours would leave about an hour of margin; eight leaves
three. Releasing a live run costs a duplicate collection rather than
corruption, but it is still spend nobody asked for.

A run that has been reserved but not yet enqueued is deliberately exempt from
the queue arm: `reserve` inserts the row before `enqueue` returns an id, so
asking the queue about it would find nothing and release a run a reader is
still starting.

The orphan cutoff is gated on never having been claimed, not merely on having
no job id, because those are different populations. `markEnqueued` requires
status `queued`, so a worker that claims the job before the enqueuing process
records its id leaves a genuinely running run with no job id for its whole
life. `claim` stamps `started_at`, so that run is excluded from the orphan
arm and keeps the eight-hour backstop. The claim guard alone would not save
it: that guard refuses the _next_ claim, while the attempt already collecting
would carry on and discard its entire scan at `publish`.

Released runs become `failed` with the code `abandoned`, which is in neither
the active set nor `loadCompletedEvidence`. The character falls back to its
previous evidence immediately. The write is guarded on the active statuses, so
a publication that lands while the sweep is deciding keeps its outcome.

**An abandoned run holding a staged collection is completed, not released.** A
run abandoned after `stageCollection` but before `publish` holds a finished
Warcraft Logs scan, and the history scan is 68–86% of what a run costs, so
releasing it would throw away the expensive part of the run rather than an
incidental part of it. The window is the whole interval between a finished scan
and a stored one, and every hard kill, OOM or container pull during it lands
here. Recovery therefore publishes the stage and counts the run as
`republished` rather than `released`.

The bytes published are the ones a re-claimed attempt would have republished
anyway, and `publish` takes the run row `FOR UPDATE` and refuses anything not
still active — so a publication that lands while the sweep is deciding keeps
its outcome. A publication that throws for any other reason drops the run into
the release batch instead, which needs no case analysis: a stage `publish`
refuses must not leave the run active for ever, and a run that published for
real between the read and the write makes the release a no-op through the same
status guard.

A republished run settles its terminal tiers, exactly as the run that collected
it would have. That needs the raids the run attributed a parse-domain
limitation to, which no settled column records, so the stage carries them
alongside the publication. Marking is timed from the stage's own `completedAt`
rather than the sweep's clock: that is the instant the original run would have
used, and it is the stricter of the two, since a later reading widens the
settled window and could freeze a percentile that was still moving when the
scan read it.

**A stage carrying no trouble sets settles nothing, and that is not the same as
one whose trouble sets are empty.** Stages written before the field existed
cannot say which raids they had trouble with, and reading that silence as
"none" would mark a troubled raid terminal and freeze the parse gaps the
trouble was raised to hold open. Marking nothing costs a re-query; over-marking
costs evidence that can only be corrected by a rebuild. The population is
self-clearing within a deploy.

Marking happens only after the publication succeeds, because a mark that
outlived a failed publish would stop the tier being collected while nothing was
stored for it. A mark that fails after a successful publication is left
unmarked and the publication stands — the evidence is stored and the run has
left the active set, so releasing it at that point would be wrong.

Recovery unblocks a character; it does not by itself put one back in
circulation. If the previous completed run left a retry deadline, the resume
pass takes it on the same tick. If that run finished cleanly, or the character
has no completed run at all, nothing schedules it and a dossier read is what
starts collection again — the same gap the resume sweep already has. A
republication is the case where the ordering pays twice over: a stage that was
`partial` carries its own `retry_after_at`, so publishing it on this tick puts
the character in front of the resume pass on the same tick, and the run it
resumes into starts from a smaller scan because the republication settled its
tiers first.

The sweep's record carries counts alone — `resumed`, `released` and
`republished` — and never a character key, although recovery now reads one to
mark what it republishes.

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

For a reviewed cohort whose reports need their Warcraft Logs uploader
provenance re-read, put one canonical Raider.IO character URL on each line of a
local input file (comments beginning with `#` are allowed), then run the
operator-only paced backfill. The explicit limit is a second confirmation that
the input is the intended cohort; the interval spaces queue admission while the
worker's existing points budget continues to limit upstream work:

```bash
corepack pnpm ops:backfill-uploader-provenance -- \
  --input issue-410.urls --interval-ms 60000 --limit 59
```

The input file is operational data and must not be committed. The command
stops on its first error instead of continuing with an unreviewed remainder.
It uses the same rebuild path as the one-character command, so it preserves
currently visible evidence while terminal tiers are recollected.

The dossier refresh control cannot reach a rebuild. It stays `full` outside the
cooldown and `light` inside it, one run per press, whatever it is sent.
`/api/dossiers/.../refresh` is unauthenticated, which is tolerable at one run
per press and would not be if a press could re-collect a whole history on
demand; keeping the mode unreachable is a better answer than gating a public
endpoint. A rebuild is operator-only and run with credentials.

A run's history scan is bounded by the same allowance. `EVIDENCE_REQUEST_CAP`
is a ceiling rather than the value a run receives: the effective cap is a share
of whatever `limitPerHour` the run's own credentials report, and the share
differs by whose credentials those are. On the worker's own account that is
half the allowance, 300 pages at 18000; on a visitor's it is 15%, 18 pages at 3600. The scan buys most of a run's points and all of the variance in them, so
this is what decides what a started run costs — the reserve below only decides
whether it starts.

The smaller visitor share is a deliberate product choice, not a tuning
artefact: a visitor supplied credentials to see one dossier, and spending their
whole hourly quota every window until the character converges is spending
someone else's resource.

For a character whose history fits inside the cap, the effect is simply a
smaller scan. Above it, a visitor's dossier does not converge at all: a
truncated scan settles no tier, so the scan floor never advances and the next
run re-reads the same pages. That is a limitation of how a truncated scan is
treated rather than of this cap — see #334 — and it is still an improvement on
the flat cap it replaces, which exhausted a visitor's allowance mid-scan
instead.

Neither bound promises a run finishes. A character with deep history costs more
points to scan than a visitor's entire hourly allowance, at any cap, so that
case takes several windows by nature — the run publishes what it has, sets a
retry deadline, and the resume sweep carries it on.

A run also checks the Warcraft Logs hourly points allowance before it starts.
When fewer than `EVIDENCE_POINTS_RESERVE` points (3500 by default, capped at
30% of whatever allowance the account in use reports, so a visitor's smaller
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

A run that stops on a fault publishes as partial under `collection_failed`
rather than being abandoned, and carries a `retry_after_at` cooldown
(`EVIDENCE_FAILURE_COOLDOWN_MS`, 30 minutes by default). Reservation honours
that cooldown, which is what keeps a character whose collection keeps breaking
from being re-collected on every page read: a `failed` run is invisible to
reservation, so without the cooldown the next read starts another one. A
partial publication carries previous kills, wipes and parses forward, so
stopping this way can only add to what is stored.

Between a finished Warcraft Logs scan and a successful publication the
collection is held in `character_evidence_collections`, one row per run. A
retry that finds a stage republishes it instead of paying for the scan again,
and the publication deletes the stage in its own transaction. The recovery
sweep reads the same stage for a run whose worker never came back, so the two
readers publish and settle identically. Maintenance drops stages whose run has
settled and reports the count as `removedCollectionStages` on the
`evidence_cache_cleanup` record.

The stage carries the raids the run attributed a parse-domain limitation to
alongside the publication, because terminal marking needs them and nothing a
settled run stores records them. That is what lets either reader settle the
tiers the collecting run had earned rather than storing the evidence and
settling nothing.

Verification covers repeated and concurrent reads, TTL expiry, failed refresh,
snapshot membership changes, least-recently-used memory eviction, shared token
refresh, concurrent database reservations, atomic publication and retention
cascading.
