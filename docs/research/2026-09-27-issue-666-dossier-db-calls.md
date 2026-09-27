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
  anything the local fixtures exercise. **#687 has since measured it: it is
  dossier assembly.** On `test`, `assemble` has a median of 371 ms on a
  provider-free ten-character read (see [The ~370 ms, measured](#the-370-ms-measured)).

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

## The ~370 ms, measured

#687 added two buckets to the dossier read's `http_request` record and to
`Server-Timing`:

- `assemble` covers what the dossier service does once the evidence has
  arrived: limitations, `buildApplicantDossier`, tier-search states, guild
  history, character serialisation and the `applicantDossierSchema.parse`
  of the result. The two database reads made during assembly are excluded,
  because `db` already times them. Every other await in the frame is
  excluded along with them, so `assemble` is this request's own synchronous
  work.
- `respond` covers the route's `compactDossierWipes`, `jsonNoStore`'s
  validation and serialisation, and `withHttpRequest` reading the body back
  to count it. `respondCalls` is 2, and `respondMaxCallMs` is the route's
  share.

The sample was 2026-09-27, web deployment `38c56d64` (#701 and later), on
serial reads with nothing else running. `railway logs` returned it with no
errors. That gave 13 ten-character reads of `eu/silvermoon/ryii`, 12 of them
with no provider time, plus 10 fourteen-character reads of `rinn` and `ryun`,
all provider-free:

| Field                             | 10 chars p50 | range     | 14 chars p50 | range     |
| --------------------------------- | -----------: | --------- | -----------: | --------- |
| `durationMs`                      |          541 | 506–704   |          544 | 523–612   |
| `assembleMs`                      |          371 | 352–416   |          384 | 372–431   |
| `respondMs`                       |           45 | 42–51     |           45 | 41–49     |
| `respondMaxCallMs` (route)        |           38 | 35–44     |           38 | 34–40     |
| `durationMs` − assemble − respond |          117 | 102–237   |          119 | 102–159   |
| `dbMs` (summed)                   |          659 | 562–1,409 |        1,041 | 880–1,152 |
| `dbCalls`                         |           27 | 27        |           35 | 35        |

Assembly is about 70% of a warm read. The route's compaction, validation and
serialisation take about 38 ms, and counting takes about 7 ms. What remains,
about 117 ms, is gathering the evidence: `resolveSubjects` and the concurrent
`evidence.reserve` transactions. That is less than the 5 ms model above
predicts, which is about 216 ms: that model's 266 ms read less about 50 ms of
local work. So 5 ms is an upper bound on production's round trip, not a fit.

This sample's ten-character reads made 27 database calls, where #666's made
32, and took 541 ms at the median against 635. Ryii's dossier has changed
since then. The split does not depend on that difference.

Assembly takes about the same time at 10 and 14 characters, so it does not
scale with the number of characters. It more likely scales with the evidence
those characters carry. Locally, a seeded 12-character read takes about
50 ms in total, assembly included. That points at the size of real evidence rather than
at Railway's CPU. #686, which profiles a dossier with production-sized
evidence, is the way to find which stage inside `assemble` dominates.

## What is still unexplained

About 5 ms per round trip is high for `postgres.railway.internal`, which is
Railway's private network in the same region as the web service. The log
cannot separate network time from time spent executing statements over real
evidence. #687 has since shown that the ~370 ms outside the database is
dossier assembly, above. Two
things differ from the local fixtures and are not modelled:

- **Real evidence is larger.** `evidence.reserve` loads each character's
  completed kills, wipes, tier bests and Cutting Edge rows. Real characters
  have far more rows than the seeded ones, so each statement returns more
  data. The read then builds, validates (`applicantDossierSchema`) and
  serialises a larger dossier on Railway's CPU.
- **Pool contention.** The web's `pg` pool uses the default of 10 clients.
  A read with more subjects than that queues its later `evidence.reserve`
  transactions for a client, and the wait is counted inside the call. The
  12-character local scenario includes this. A ten-character production read
  meets it only when its aliases take it past 10 reservations.

## Follow-ups

- **Add the latency mode to the profiler** once #670 merges, for example as
  `PROFILE_DB_RTT_MS`, using the proxy above.
- **Seed production-sized evidence** in a profiler scenario, so the time
  outside the database shows up locally.
- **Time the read path's own work.** Done in #687, which added `assemble`
  and `respond` buckets. The split is in
  [The ~370 ms, measured](#the-370-ms-measured).
- **Correct the baseline's note on log retention.**
  `2026-09-27-dossier-load-baseline.md` says Railway keeps only the current
  deployment's logs, but removed deployments can still be read by id.
