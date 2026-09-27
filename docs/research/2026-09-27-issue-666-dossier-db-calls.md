# Why a production dossier read made 62 database calls

Issue #666. The question was whether a dossier read on `test` makes more
database calls than the same read locally, or makes the same calls more
slowly.

## Answer

**It makes the same calls. Each call is slower, and database latency explains
only part of the gap.**

- A warm 12-character read makes 31 database calls, both locally and on
  `test`. The 62-call sample from #646 is an outlier: 5 of 173 production
  reads made more than 40 calls.
- An injected database round trip of about 5 ms reproduces production's
  per-call cost (`dbMs / dbCalls`) and slowest call (`dbMaxCallMs`). It
  reproduces less than half of production's request time.
- The rest of a production read, about 370 ms at the median, is spent outside
  anything the local fixtures exercise. Evidence volume accounts for about
  90 ms of it, roughly a quarter (#686, "Evidence volume" below). Between
  220 and 280 ms of a production read is still unexplained; the range is how
  much slower the local baseline ran in #686's runs than in this note's.

## Production records

`railway logs` returns only the newest deployment's output by default. A
removed deployment's output can still be read by passing its id:

```bash
railway deployment list -s web -e test --limit 100
railway logs -s web -e test -n 5000 <deployment-id>
```

The baseline in `2026-09-27-dossier-load-baseline.md` found one surviving
dossier record because it read only the default. Reading every deployment
listed on 2026-09-27 returned 500 `http_request` records. 173 of them were
`endpoint: "dossier"`, from 2026-09-26 and 2026-09-27, across 11 deployments.

`count` on a dossier record is the number of characters in the response. By
character count:

| Characters | Reads | `dbCalls` median | `dbCalls` range | `durationMs` median |
| ---------: | ----: | ---------------: | --------------: | ------------------: |
|          1 |    14 |                5 |           5–166 |                 259 |
|          2 |    25 |               16 |           11–61 |                 138 |
|         10 |   127 |               32 |           25–81 |                 672 |
|         11 |     2 |               30 |           29–30 |               1,420 |
|         12 |     2 |               31 |           31–31 |                 579 |
|         14 |     3 |               35 |           35–40 |               1,121 |

`evidence.reserve` was the slowest call on 164 of the 173 reads.

For the 98 ten-character reads that spent nothing on a provider (no Raider.IO
or Blizzard time):

| Field         |   p50 |   p95 |   max |
| ------------- | ----: | ----: | ----: |
| `durationMs`  |   635 |   900 | 1,873 |
| `dbMs`        | 1,171 | 2,011 | 3,848 |
| `dbMaxCallMs` |   158 |   251 |   401 |
| `dbCalls`     |    32 |    37 |    37 |

They made between 26 and 37 calls. The spread tracks each dossier's aliases
and manual connections: every alias is its own `evidence.reserve`.

### The reads with extra calls

Five reads made more than 40 calls. Each of them also missed the Raider.IO
ranking cache:

| Characters | `dbCalls` | `durationMs` | Raider.IO ms | Cache misses |
| ---------: | --------: | -----------: | -----------: | -----------: |
|         10 |        62 |        1,184 |          751 |            3 |
|         10 |        81 |        1,552 |          483 |            1 |
|         10 |        46 |          737 |          127 |            1 |
|          2 |        61 |        3,653 |        4,078 |            6 |
|          1 |       166 |        3,941 |        7,388 |            9 |

The 62-call read is the #646 sample. A local read shows the same jump the
first time it runs against a cold process: the 12-character scenario's
warm-up made 55 calls, and every read after it made 31. The log does not
name the extra calls. It gives only the count and the slowest call's name.

## Local counts

This used the #646 profiler (`corepack pnpm profile:dossier`, open as #670),
with 10 loads per warm scenario. The web server's `http_request` lines were
captured by a temporary change to the e2e global setup, which is not
committed.

| Scenario      | `dbCalls` | `durationMs` p50 | `dbMs` p50 | `dbMaxCallMs` p50 |
| ------------- | --------: | ---------------: | ---------: | ----------------: |
| 1 character   |         9 |               46 |         41 |                16 |
| 12 characters |        31 |               50 |        231 |                24 |

Every warm-up load was excluded. The call count was identical on every other
load.

## Modelling Railway's latency

Because the counts match, the next step was to add latency to each database
round trip. A TCP proxy between the web server and PostgreSQL held every
chunk for half the chosen round-trip time in each direction. The worker kept
a direct connection.

| Injected RTT | 12 chars `durationMs` | `dbMs` | `dbMs / dbCalls` | `dbMaxCallMs` | 1 char `durationMs` |
| -----------: | --------------------: | -----: | ---------------: | ------------: | ------------------: |
|         none |                    50 |    231 |              7.5 |            24 |                  46 |
|         1 ms |                   109 |    530 |               17 |            59 |                  64 |
|         2 ms |                   139 |    698 |               23 |            76 |                  94 |
|         5 ms |                   266 |  1,262 |               41 |           149 |                 179 |
|        10 ms |                   470 |  2,240 |               72 |           270 |                 328 |
|   production |                   635 |  1,171 |               35 |           158 |                   — |

Production's row is the ten-character reads with no provider time.

Request time grows by about 43 round trips per millisecond of latency at 12
characters, and by about 28 at one character. That is the length of the
serial chain: `resolveSubjects`' sequential reads, then one `evidence.reserve`
transaction per subject. A warm reserve is about 13 statements on one pooled
client, and all of them run one after another.

At 5 ms, `dbMs / dbCalls` and `dbMaxCallMs` land on production's values, but
request time is 266 ms against production's 635. At 10 ms, request time is
still short of production's, and every database figure overshoots it.
Latency alone cannot reproduce a production read at any setting.

### Two proxy pitfalls

Anyone building this into the profiler should avoid two traps. Both made the
first attempts wrong by an order of magnitude:

- **Set `noDelay` on both sockets.** Without it, Nagle's algorithm holds the
  small protocol messages back.
- **Do not delay with `setTimeout` on Windows.** It rounds up to the system
  timer's resolution of about 15.6 ms. That makes every setting a ~31 ms
  round trip: 0.5 ms and 10 ms gave the same 740–850 ms reads. Release queued
  chunks from a `setImmediate` loop that checks `performance.now()`.

## What is still unexplained

About 5 ms per round trip is high for `postgres.railway.internal`, which is
Railway's private network in the same region as the web service. The log
cannot separate network time from time spent executing statements over real
evidence. Nor does it say what the ~370 ms outside the database does.
Evidence volume, measured below, accounts for about 90 ms of it. One more
difference from the local fixtures is not modelled:

- **Pool contention.** The web's `pg` pool uses the default of 10 clients.
  A read with more subjects than that queues its later `evidence.reserve`
  transactions for a client, and the wait is counted inside the call. The
  12-character local scenario includes this. A ten-character production read
  meets it only when its aliases take it past 10 reservations.

## Evidence volume

Issue #686. The seeded characters hold two kills each, and no wipes, tier
bests or Cutting Edge rows. This section measures how much evidence real
characters hold, seeds that much synthetic evidence locally, and times the
read.

### How the volumes were taken

Three aggregate queries ran against the `test` database on 2026-09-27,
through `railway ssh` into the worker, the access pattern in
`docs/operations/evidence-run-cost.md`. Each query returned only counts and
percentiles. No character name, key or row left the database, and none is
recorded here.

A character's evidence is what the read shows, as `loadCompletedEvidence`
chooses it: the newest completed or partial run for kills, wipes and tier
bests, and the newest `full` run for Cutting Edge rows. Percentiles are
`percentile_disc`.

### Per character

158 characters have completed evidence on `test`. 66 of them have no kills.

| Rows per character  | p50 |   p95 |    max | mean |
| ------------------- | --: | ----: | -----: | ---: |
| Kills               |  16 |   865 |  2,089 |  151 |
| Wipes               |  10 | 2,478 | 12,838 |  493 |
| Tier bests          |   0 |    16 |     44 |  2.3 |
| Cutting Edge rows   |   0 |    19 |     19 |  4.3 |
| Bosses killed       |   3 |    54 |    189 |   14 |
| Raids with a kill   |   1 |    12 |     27 |  3.2 |
| Reports with a kill |   8 |   324 |    833 |   57 |
| Guilds with a kill  |   1 |     5 |     11 |  1.7 |

Across all 23,831 stored kills, 81% have all three parses available, 16%
have been checked for a world rank, and 1.3% hold one.

### Per dossier

A median character says little about a dossier, because a few characters
hold most of the evidence. Summing over each root's newest snapshot gives
each dossier's own volume. Six dossiers have ten characters, the size of 127
of the 173 production reads:

| Ten-character dossier | Kills |  Wipes | Tier bests | Cutting Edge |
| --------------------- | ----: | -----: | ---------: | -----------: |
| Median                |   759 |  1,613 |         15 |           58 |
| Largest               | 3,072 | 13,779 |         70 |          184 |

The log cannot say which dossier a production read was for, so these are the
dossiers that exist, not a weighting of the reads.

### The production-sized scenarios

`corepack pnpm profile:dossier` now has two more warm scenarios. Each seeds
ten characters with synthetic completed evidence
(`tests/e2e/support/synthetic-evidence.ts`), spreading one dossier's totals
evenly across them:

| Scenario                 | Kills each | Wipes each | Tier bests each | Cutting Edge each |
| ------------------------ | ---------: | ---------: | --------------: | ----------------: |
| Warm, production median  |         76 |        161 |               2 |                 6 |
| Warm, production largest |        307 |      1,378 |               7 |                18 |

The rows are generated from the raid and Cutting Edge catalogues in the
proportions above: about 11 kills per boss, 3 per report, and four in five
parsed. Every kill is marked as checked for a world rank and the Blizzard
phase as completed. The read therefore makes no provider call, like the
production reads it is compared with.

The profiler also prints each warm scenario's serialised size, from one full
read made apart from the timed loads:

| Scenario                 | Response bytes |
| ------------------------ | -------------: |
| Warm, 1                  |         45,892 |
| Warm, 12                 |         62,086 |
| Warm, production median  |        923,395 |
| Warm, production largest |      4,027,441 |

Production's response sizes were not taken. A median ten-character dossier
on `test` should be close to the synthetic median's 0.9 MB, and the page
reads it again at every poll.

### Timings

Server `total` p50 in milliseconds. Each row is one run. The 5 ms rows used
a temporary TCP proxy between the web server and PostgreSQL, built as
described above and not committed. #685 has since made it a profiler setting,
`PROFILE_DB_RTT_MS`.

| Database RTT | Loads | Warm, 12 | Production median | Production largest |
| -----------: | ----: | -------: | ----------------: | -----------------: |
|         none |    20 |       45 |               155 |                789 |
|         none |    10 |       51 |               238 |              1,119 |
|         5 ms |    10 |      335 |               394 |              1,365 |
|         5 ms |    20 |      389 |               615 |              1,448 |
|         5 ms |    20 |      308 |               404 |              1,305 |
|         5 ms |    20 |      348 |               429 |                852 |

Runs on this machine vary by up to 50%, so compare scenarios within a row.
The 12-character scenario took 308–389 ms here at 5 ms, against 266 ms in
"Modelling Railway's latency". The proxy and the machine's load both differ
between the two measurements.

### How much volume accounts for

**About 90 ms of the 370 ms.** Within each 5 ms run, the median-sized
dossier took 59, 226, 96 and 81 ms longer than twelve small characters. The
median of those is 89 ms.

That leaves 220–280 ms unexplained, and the two ends come from two
baselines:

- **280 ms** is 370 less 90. The 370 ms is production's 635 ms less the
  266 ms the 12-character scenario took at 5 ms in "Modelling Railway's
  latency".
- **220 ms** is production's 635 ms less the 415 ms the median-sized read
  took in these runs.

They differ because the 12-character scenario itself ran at 308–389 ms in
these runs (median about 340), roughly 60–75 ms slower than the 266 ms
above. The same-run difference, 90 ms, is the figure for volume. Which end
of the remainder is right depends on which absolute baseline matches
production, and neither can be checked against it.

Without latency, volume costs more: 110–190 ms. At 5 ms, each subject's
reservation spends most of its time waiting on round trips, and building
the other subjects' evidence overlaps those waits.

The largest dossier took 850–1,450 ms at 5 ms and 0.8–1.1 s with no latency.
Evidence volume alone can make a dossier read take over a second.

Three things could close the rest of the gap. None of them is measured:

- **Railway's CPU.** Most of the volume cost is CPU work: building,
  validating and serialising a 0.9 MB response. A shared Railway vCPU slower
  than this desktop multiplies it. The assembly timing bucket in
  "Follow-ups" would show this directly.
- **Skew.** Real dossiers hold most of their evidence on one or two
  characters. One large reservation then runs on its own after the small
  ones finish, where the synthetic dossier runs ten medium ones in parallel.
- **Aliases.** Each alias is its own `evidence.reserve`, and the synthetic
  dossiers have none.

## Follow-ups

- **Add the latency mode to the profiler** once #670 merges, for example as
  `PROFILE_DB_RTT_MS`, using the proxy above.
- **Seed production-sized evidence** in a profiler scenario, so the time
  outside the database shows up locally. Done in #686; see "Evidence
  volume".
- **Consider the dossier's size.** A median ten-character dossier serialises
  to about 0.9 MB and the largest to about 4 MB, and the page reads it again
  at every poll.
- **Time the read path's own work.** A bucket for dossier assembly and
  response validation would split the unexplained 370 ms in production
  without any new call names in the logs.
- **Correct the baseline's note on log retention.**
  `2026-09-27-dossier-load-baseline.md` says Railway keeps only the current
  deployment's logs, but removed deployments can still be read by id.
