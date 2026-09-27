# Dossier load baseline

Issue #646. How long a dossier takes to load, where the time goes, and how to
measure it again.

## How to measure

```bash
corepack pnpm profile:dossier
```

`PROFILE_LOADS` sets the loads per warm scenario (default 20). Scenarios that
need a new character for every load take fewer: half as many for the provider
scenario, and a quarter as many for the gathering and cold scenarios.
`PROFILE_PROVIDER_LATENCY_MS` (default 150) sets how long the fake Raider.IO
and the fake Blizzard achievement read take to answer in the provider
scenarios. Every other scenario, and the whole e2e suite, runs the fakes with
no delay.

`PROFILE_DB_RTT_MS` adds a database round trip. Locally, PostgreSQL answers
in almost no time, so a change that removes or parallelises database calls
looks free. When the variable is set, the global setup puts a TCP proxy in
front of PostgreSQL for the web server only. The proxy holds every chunk for
half the round trip in each direction. The worker, migrations and seeds keep
a direct connection. `0` runs through the proxy with no delay, which shows the
proxy's own overhead. Unset, there is no proxy, and neither `test:e2e` nor CI
ever sets it. Every summary header states the round trip it ran with.

```bash
PROFILE_DB_RTT_MS=5 corepack pnpm profile:dossier
```

For choosing a value, see
[the #666 note](2026-09-27-issue-666-dossier-db-calls.md#modelling-railways-latency).
At about 5 ms, `dbMs / dbCalls` and `dbMaxCallMs` match production reads on
`test`. Latency alone does not reproduce production's request time at any
setting.

The nine scenarios are these seven and the two stored-keys scenarios described
after them:

| Scenario           | What the read has to do                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm, 1            | A fresh snapshot and completed evidence for one character                                                                                                                 |
| Warm, 12           | The same for 12 connected characters, the default `DOSSIER_CHARACTER_CEILING`                                                                                             |
| Production median  | Warm, for 10 characters holding a median ten-character dossier's evidence on `test`: 76 kills, 161 wipes, 2 tier bests and 6 Cutting Edge rows each, all synthetic        |
| Production largest | The same at the largest ten-character dossier's volume: 307 kills, 1,378 wipes, 7 tier bests and 18 Cutting Edge rows each                                                |
| Gathering          | A fresh snapshot but no evidence, so the read queues a Warcraft Logs run and the page polls until it is published                                                         |
| Providers          | Completed evidence with no world ranks and no stored Cutting Edge, so the read looks up Raider.IO rankings and Blizzard achievements, each delayed by the latency setting |
| Cold               | No snapshot at all, so the page starts research, polls the discovery job, then reads the dossier and waits for its evidence                                               |

The seeded warm scenarios hold two kills per character. The production-sized
ones (#686) generate their evidence from the raid and Cutting Edge catalogues
(`tests/e2e/support/synthetic-evidence.ts`). No real character's rows are
used. `2026-09-27-issue-666-dossier-db-calls.md` ("Evidence volume") has the
aggregate counts they are sized from, and how those were taken. Each warm
scenario also prints its dossier's serialised size, from one read made apart
from the timed loads.

The two stored-keys scenarios (#689) repeat the warm single read for a visitor
who has saved provider keys in the browser: once with no provider latency, and
once with the latency setting and half the loads. Before each load the
profiler writes dummy values for all five keys to the page's `localStorage`,
where the settings page keeps them. They are test values that only reach the
local fakes, which accept any key. Each stored-keys scenario reads the same
character on every load, because the visitor's own gateways have no cache to
warm.

The provider scenario gives every load a new character and a new guild. The
rankings cache is keyed by raid and guild, the achievement cache by character,
and a ranking lookup is recorded against the kill once it has been made, so
reusing either would turn later loads into cache hits.

The profiler is a Playwright config (`playwright.profile.config.ts`) over the
e2e global setup. It runs against a PostgreSQL container, the fake Raider.IO,
Blizzard and Warcraft Logs servers, the worker, and the production `next start`
build. It never contacts a live provider, and neither `test:e2e` nor CI runs
it. Each load opens a fresh browser context, so there is no HTTP cache,
storage or warm page. The first load of each scenario is discarded as a
warm-up and reported separately.

All phases are measured on the page's own clock, from navigation start:

| Phase           | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `shell`         | The server shell's `DOMContentLoaded`                                        |
| `requested`     | The page starts its first dossier read                                       |
| `headers`       | That read's response headers arrive                                          |
| `firstResponse` | That read's body has been read                                               |
| `rendered`      | The connected-characters panel is first in the DOM                           |
| `published`     | The worker published the evidence the load waited for (see below)            |
| `settled`       | The first full read with no character `waiting` or `scanning`                |
| `settleLag`     | `settled` minus `published`: how late the page noticed                       |
| `server …`      | The first read's `Server-Timing`: `total`, then each timed bucket and wait   |
| `reads …`       | How many dossier reads and run-progress reads the page made before `settled` |

`published` exists only in the gathering and cold scenarios. It is the
character's newest published run's `completed_at`, which the worker sets from
its own clock, placed on the page's clock through `performance.timeOrigin`.
The worker and the browser run on the same machine, so the two clocks agree.
`completed_at` is taken just before the publish transaction commits, so
`settleLag` slightly overstates how late the page was.

Two more phases appear only when a session check held the first read back:

| Phase               | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `sessionCheckStart` | The `GET /api/account/session` the read waited on was sent |
| `sessionCheckEnd`   | Its response arrived; the read starts straight after       |

The account hook sends the same request, so the profiler takes the session
request that finished last before the read started. An anonymous read starts
before either finishes, so it has no session check.

The profiler also prints each fetch the page started before its first dossier
read, and counts the loads in which the shell's early read fired (#684) and
the loads whose first read carried saved keys.

`settled` deliberately does not follow the page's own rule for when to stop
polling. The page keeps polling while any character is `partial`, and a
partial result can be final, in which case the poll never ends (#663).

`Server-Timing` is sent only by the dossier read route
(`/api/dossiers/{region}/{realm}/{name}`, through `withTimedHttpRequest`), and
only when `SERVER_TIMING_ENABLED` is exactly `true`. The e2e global setup
turns it on, and production leaves it unset. The header carries durations
only: no call names, counts, flags or request data.

Besides the database, provider and limiter buckets, the dossier read times its
own CPU work (#687). `assemble` is everything the dossier service does once the
evidence is in hand, from building the dossier to validating it against the
contract, less the two database reads it makes on the way, which stay in `db`.
`respond` is the route's wipe compaction, validation and JSON serialisation,
plus `withHttpRequest` reading the body back to count it. Both are serial, so
read them against `total` directly rather than against the summed `db`.

The gate exists because even durations say too much in production. On the
dossier read, `limiterWait` shows any visitor how close the shared provider
allowances are to running out, and whether `blizzard` or `raiderIoRankings`
appears shows whether another visitor recently warmed the cache for that
character. On an account route, an exact `total` would tell an address with an
active account from one without, which is what those routes' neutral replies
exist to hide. No other route opts in.

## Results

Windows 11, local Docker PostgreSQL, default load counts (20 warm, 10
provider, 5 gathering and 5 cold), provider latency 150 ms, 2026-09-27,
`main` with the #654 fix. All values are p50 in milliseconds.

| Phase                     | Warm, 1 | Warm, 12 | Gathering | Providers |  Cold |
| ------------------------- | ------: | -------: | --------: | --------: | ----: |
| shell                     |      39 |       37 |        38 |        36 |    36 |
| requested                 |     122 |      119 |       109 |       114 |   121 |
| headers                   |     155 |      170 |       146 |       308 |   135 |
| rendered                  |     171 |      190 |       162 |       322 |   208 |
| settled                   |     155 |      171 |     3,253 |       309 | 3,281 |
| server total              |      28 |       45 |        34 |       187 |    10 |
| server `db` (summed)      |      26 |      207 |        23 |        27 |     9 |
| server `raiderIoRankings` |         |          |           |       158 |       |
| server `blizzard`         |         |          |        10 |       159 |       |

The warm scenarios' warm-up loads rendered at 393 ms (1 character) and 280 ms
(12 characters). In the cold scenario, the first response is the
`discovery_not_ready` refusal (10 ms of server time), and the dossier renders
once discovery has published a snapshot.

### Production-sized evidence

The same machine on 2026-09-27, `main` after #684, which starts the first
read before hydration, so `requested` is earlier than in the table above.
The four warm scenarios came from one run, with 20 loads each and no
database latency. All values are p50 in milliseconds.

| Phase                | Warm, 1 | Warm, 12 | Production median | Production largest |
| -------------------- | ------: | -------: | ----------------: | -----------------: |
| shell                |      34 |       33 |                33 |                 46 |
| requested            |      23 |       27 |                24 |                 27 |
| headers              |      69 |       91 |               189 |                846 |
| firstResponse        |     108 |      139 |               197 |                883 |
| rendered             |     137 |      175 |               261 |              1,097 |
| settled              |     108 |      139 |               197 |                883 |
| server total         |      25 |       45 |               155 |                789 |
| server `db` (summed) |      22 |      225 |               308 |              1,550 |
| response bytes       |  45,892 |   62,086 |           923,395 |          4,027,441 |

Those runs varied by up to 50%. A second run put the median-sized dossier's
server `total` at 238 ms and the largest at 1,119 ms.

Later runs, on `main` after #701 (the `assemble` and `respond` buckets) and
#685 (`PROFILE_DB_RTT_MS`), were steady. They put server `total` at about
100 ms (median-sized) and 470 ms (largest) with no latency. At a 5 ms round
trip they were about 230 ms and 540–580 ms, against about 245 ms for the 12
seeded characters, which make two more characters' worth of round trips.
`assemble` was about 50 ms and 300 ms, against 2 ms for the seeded ones. The
#666 note ("Evidence volume") compares that with production's 371 ms.

Rendering grows with the dossier too: 64 ms after the response for the
median-sized dossier, and 214 ms for the largest, against 29–36 ms for the
seeded ones.

### A visitor with saved provider keys

Issue #689. Same machine, 2026-09-27, `main` after #684 (the early read),
default load counts, provider latency 150 ms. The warm single column comes
from the same run, for comparison. All values are p50 in milliseconds.

| Phase             | Warm, 1 | Stored keys | Stored keys, 150 ms |
| ----------------- | ------: | ----------: | ------------------: |
| shell             |      39 |          46 |                  45 |
| sessionCheckStart |         |         139 |                 144 |
| sessionCheckEnd   |         |         147 |                 152 |
| requested         |      30 |         148 |                 153 |
| headers           |      90 |         199 |                 347 |
| rendered          |     171 |         216 |                 364 |
| server total      |      34 |          46 |                 188 |
| server `blizzard` |         |          12 |                 157 |
| early read fired  |   20/20 |        0/20 |                0/10 |
| saved keys sent   |    0/20 |       20/20 |               10/10 |

- **The early read stands aside.** It fired in none of the stored-keys loads,
  so the read waits for the client page to start: it was requested at
  148 ms, against 30 ms for an anonymous visitor, whose read goes out while
  the HTML is still parsing.
- **The session check is short locally but serial.** It took about 8 ms, and
  the read started about 1 ms after it returned. In production it would add
  a full round trip plus about 7–20 ms of server time before the read.
- **The panel renders about 45 ms later.** Rendering waits for hydration in
  both cases, so the anonymous early read only hides the read behind start-up;
  with stored keys the read and its server time come after it instead.
- **The lost cache is paid on every load.** An anonymous warm read of a
  character is served its Blizzard achievements from the shared cache, so
  `blizzard` is absent. The visitor's own gateway has no cache, so every
  stored-keys load calls the fake Blizzard: 12 ms at no latency, and 157 ms
  at 150 ms, which takes the server time from 46 ms to 188 ms and the render
  from 216 ms to 364 ms. Raider.IO did not appear because these characters
  have no guild, so the read has no ranking to look up.

A first run of the same scenarios, straight after building the web app, had
p95 values three to five times the p50 in the shell phase and in the
stored-keys scenario at 150 ms. The rerun above was steady, so treat a single
run's p95 with care.

## Where the time goes

1. **Before the read starts: about 80 ms after the shell, and about 110–120 ms
   from navigation.** The page is a server shell that renders
   `DossierPageClient` with `initialDossier={null}`, so nothing can be
   fetched until the page's JavaScript has loaded and started. That start-up
   is the whole gap for an anonymous visitor.

   The `GET /api/account/session` the profiler lists before the read comes
   from the account hook (`use-account-session.ts`) and runs alongside the
   read, not before it. The read waits on a session round trip of its own
   only when the browser holds stored provider keys: `dossierFetch` awaits
   `credentialHeadersForRequest()`, which then checks the session before
   sending them. The stored-keys scenarios measure it (see above). In
   production it would cost a full round trip plus about 7–20 ms of server
   time (the `account_session` `http_request` records on `test`).

   Since this baseline was taken, #684 has started the first read from an
   inline script while the HTML is parsed, so for an anonymous visitor the
   read no longer waits for the page to start. The numbers above predate that
   change; re-run the profiler to see the new gap. A visitor with saved
   provider keys still takes the old path, because the early read stands
   aside for them (#689).

2. **The server read: 28–45 ms locally when no provider is called.** This is
   almost all database time. At 12 characters, `db` sums to about 210 ms
   within a 45 ms request, because `assembleDossier` gathers each subject in
   parallel and the web scope sums overlapping calls (see "Caveats").
3. **Provider lookups: about one provider round trip, not the sum.** With both
   fakes answering in 150 ms, the Raider.IO rankings lookup (two physical
   requests, sent together) and the Blizzard achievement read each took about
   160 ms. They overlap, so the read took 187 ms, not 320. A read that needs
   both therefore costs roughly the slower provider's latency on top of the
   database time. That holds until the lookups outnumber
   `DOSSIER_PROVIDER_CONCURRENCY` (4), after which they queue in waves; one
   character with one guild here needs only two.
4. **Rendering: about 12–20 ms** after the response.
5. **Gathering and cold reads: about 3.1 s longer than a warm load.** In both,
   the settle time falls where the page's poll backoff (1 s, then 2 s) puts a
   re-read, not where the worker finishes. A visitor sees new evidence only at
   the next poll after it is published. A cold read also waits for discovery
   before its dossier renders (208 ms, against 171 ms warm), but discovery
   against the fake is fast enough that the evidence poll still dominates.

## Noticing a publish (#690)

A gathering dossier used to learn of a publish only at its next full read,
on the 1 s, 2 s, 4 s, 8 s, then 10 s backoff. It now watches its runs:

- The dossier names the runs it is waiting on in `evidenceRunIds`, including
  a tier search for a character past the display cap.
- The page asks `GET /api/dossiers/evidence-runs?ids=…` for their progress.
  That is one query (status, deferral and step states, with suppressed
  characters left out) behind the public-read admission check, with no
  reservation and no provider call. It sends no provider keys, so it never
  waits on the session check a stored key costs a full read.
- It asks every 500 ms while a run is collecting, easing to 1 s and then 2 s
  if the run goes quiet, and on a backoff from 500 ms while every run only
  waits. A run deferred for the Warcraft Logs points allowance stays `running`
  for up to an hour, so a deferred run counts as waiting.
- A run that published, or that the progress read no longer returns, is
  re-read at once. Any other move (a step, a start, a deferral) is re-read no
  more often than the old backoff, counted from the last full read of any
  kind. So watching never makes more full reads than the backoff did.

### Before and after

Same machine and method as "Results", `PROFILE_LOADS=40` (10 gathering and
10 cold loads), 2026-09-27, with no injected database round trip. `main` is
`0d9c816e` run with this branch's profiler, which adds `published`,
`settleLag` and the read counts; #690 is this branch merged with it. Both
include #704, before which the worker ignored `WARCRAFT_LOGS_BASE_URL`, so
any gathering or cold figure taken before it is not comparable.

| p50 / p95, ms  | Gathering, `main` | Gathering, #690 |  Cold, `main` | Cold, #690 |
| -------------- | ----------------: | --------------: | ------------: | ---------: |
| published      |         401 / 587 |       290 / 499 |     482 / 659 |  347 / 579 |
| settled        |     1,215 / 1,240 |       694 / 705 | 1,198 / 1,222 |  752 / 786 |
| settleLag      |         799 / 995 |       324 / 536 |     733 / 909 |  279 / 468 |
| dossier reads  |             2 / 2 |           2 / 2 |         4 / 4 |      4 / 4 |
| progress reads |                   |           2 / 2 |               |      2 / 2 |

`settled` now follows the publish rather than the backoff: the page is late
by at most one progress interval and one full read. Full reads per load are
unchanged. The progress reads replace
full reads that, on `test`, cost about 635 ms of server time each (#666).

A progress read counts against `PUBLIC_READS_PER_MINUTE` (300) like any
public read, so a visible tab watching a collecting run spends at most 120 a
minute. A hidden tab asks nothing.

## Production is not this machine

The production-shaped sample this section started from, a dossier read on
`test` on 2026-09-26, took 1,184 ms on the server. It later turned out to be an
outlier: see "Production records" below. It made 62 database calls (`dbMs` 1,891 summed, the
largest `evidence.reserve` at 221 ms) and 751 ms of Raider.IO rankings lookups
(3 lookups, 6 physical calls, the slowest lookup 357 ms). That is about 250 ms
per lookup. Its `limiterWaitMs` was 0, so the three were admitted together
and probably overlapped, costing closer to the slowest lookup's 357 ms of wall
time than the 751 ms summed. The provider scenario makes one such lookup per
read, so it shows the cost of a single lookup at a chosen latency, not the
overlap of several. Most of the remaining time is the database: locally a warm read takes 28–45 ms, and the local container removes
the round-trip latency Railway adds to each of those 62 calls. The local
profile therefore shows how many steps a load takes and in what order, but
not how long each database step takes in production (#666).

### Production records

An earlier version of this section said Railway keeps only the current
deployment's logs, and that one dossier `http_request` record survived across
40 web deployments. Both were wrong. `railway logs <deployment-id>` still
returns a removed deployment's output, and the loop that counted the records
discarded errors: `railway logs` calls in quick succession intermittently fail
with `Deployment not found`, and each failure was counted as no records.
Counted correctly, the `test` web service's logs hold 173 dossier records
across 11 deployments, from 2026-09-26 and 2026-09-27.

`docs/research/2026-09-27-issue-666-dossier-db-calls.md` (#666, #682) reads
them. Its main findings:

- Production makes the same calls as local: a warm 12-character read makes 31
  database calls in both. The 1,184 ms, 62-call sample above is one of 5 reads
  (out of 173) with more than 40 calls, and all 5 missed the Raider.IO ranking
  cache.
- A 10-character production read that calls no provider takes 635 ms on the
  server at the median (98 reads), against 45 ms locally for 12 characters.
- A 5 ms round trip between the web server and PostgreSQL reproduces
  production's time per call, but not its total. About 370 ms of a production
  read is spent outside what the local fixtures exercise.

When counting records across deployments, keep `railway logs`' errors and
count failed fetches separately. A total is valid only when no fetch failed.

## Caveats

- The web `MeasurementScope` sums overlapping calls, so `db` can exceed
  `total` (207 ms against 45 ms at 12 characters). Read it as work done, not
  as wall time. The worker's `discovery_run` uses the `shared` mode instead.
- The seeded warm scenarios (1 and 12) read evidence with no stored Cutting Edge
  achievements. The fake Blizzard answers the achievement read, and the
  15-minute process cache then serves repeats, so `blizzard` appears only on
  a scenario's first read.
- Before #654 the web ignored `BLIZZARD_BASE_URL`, and every read made a live
  Blizzard call of about 230 ms. Any profile taken before that fix is invalid.

## Follow-ups

Done:

- **Start the first read sooner: done (#667, #684).** The first read now
  starts from an inline script before hydration.
- **Profile a visitor with stored provider keys: done (#689).** See "A
  visitor with saved provider keys".
- **Production's 62 database calls: answered (#666, #682).** Production makes
  the same 31 calls as local, and slower. The 62-call read was a cache-miss
  outlier. See "Production records".

Open:

- **Add a database-latency mode to the profiler (#685).** #682 modelled
  Railway with a local TCP proxy (set `noDelay`, and do not delay with
  `setTimeout` on Windows, which rounds to about 15.6 ms). Folding that into
  `profile:dossier` would let the local baseline include database latency.
- **Profile production-sized evidence (#686)** and **time assembly and
  validation on the read path (#687).** Both target the roughly 370 ms of a
  production read that the local fixtures do not exercise.
- **Evidence appears only at the next poll: answered (#690).** The page now
  watches its runs through a cheap progress read. See "Noticing a publish".
- **Unbounded polling on `partial` (#663).**
