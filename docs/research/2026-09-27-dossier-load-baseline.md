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
scenario. Every other scenario, and the whole e2e suite, runs the fakes with
no delay.

The five scenarios are:

| Scenario  | What the read has to do                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm, 1   | A fresh snapshot and completed evidence for one character                                                                                                                 |
| Warm, 12  | The same for 12 connected characters, the default `DOSSIER_CHARACTER_CEILING`                                                                                             |
| Gathering | A fresh snapshot but no evidence, so the read queues a Warcraft Logs run and the page polls until it is published                                                         |
| Providers | Completed evidence with no world ranks and no stored Cutting Edge, so the read looks up Raider.IO rankings and Blizzard achievements, each delayed by the latency setting |
| Cold      | No snapshot at all, so the page starts research, polls the discovery job, then reads the dossier and waits for its evidence                                               |

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

| Phase           | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `shell`         | The server shell's `DOMContentLoaded`                                      |
| `requested`     | The page starts its first dossier read                                     |
| `headers`       | That read's response headers arrive                                        |
| `firstResponse` | That read's body has been read                                             |
| `rendered`      | The connected-characters panel is first in the DOM                         |
| `settled`       | The first full read with no character `waiting` or `scanning`              |
| `server …`      | The first read's `Server-Timing`: `total`, then each timed bucket and wait |

The profiler also prints each fetch the page started before its first dossier
read.

`settled` deliberately does not follow the page's own rule for when to stop
polling. The page keeps polling while any character is `partial`, and a
partial result can be final, in which case the poll never ends (#663).

`Server-Timing` is sent only by the dossier read route
(`/api/dossiers/{region}/{realm}/{name}`, through `withTimedHttpRequest`), and
only when `SERVER_TIMING_ENABLED` is exactly `true`. The e2e global setup
turns it on, and production leaves it unset. The header carries durations
only: no call names, counts, flags or request data.

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
   sending them. That serial round trip is not in this profile. In
   production it would cost a full round trip plus about 7–20 ms of server
   time (the `account_session` `http_request` records on `test`).

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
- The warm scenarios read seeded evidence with no stored Cutting Edge
  achievements. The fake Blizzard answers the achievement read, and the
  15-minute process cache then serves repeats, so `blizzard` appears only on
  a scenario's first read.
- Before #654 the web ignored `BLIZZARD_BASE_URL`, and every read made a live
  Blizzard call of about 230 ms. Any profile taken before that fix is invalid.

## Follow-ups

- **Start the first read sooner (#667).** The read cannot begin until the
  client page has started, about 80 ms after the shell locally and more on a
  slow device. The server shell could fetch the first read itself, or the page
  could start it before hydration.
- **Profile a visitor with stored provider keys.** Their read waits on a
  serial `/api/account/session` round trip, and none of these scenarios
  covers that.
- **Production's 62 database calls: answered (#666, #682).** Production makes
  the same 31 calls as local, and slower. The 62-call read was a cache-miss
  outlier. See "Production records".
- **Add a database-latency mode to the profiler.** #682 modelled Railway with a
  local TCP proxy (set `noDelay`, and do not delay with `setTimeout` on
  Windows, which rounds to about 15.6 ms). Folding that into
  `profile:dossier` would let the local baseline include database latency.
- **Evidence appears only at the next poll.** The 1 s, 2 s, 4 s backoff means
  a visitor can wait up to one full interval after evidence is published.
- **Unbounded polling on `partial`:** #663.
