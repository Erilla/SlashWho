# Dossier load baseline

Issue #646. How long a dossier takes to load, where the time goes, and how to
measure it again.

## How to measure

```bash
corepack pnpm profile:dossier
```

`PROFILE_LOADS` sets the loads per warm scenario (default 20). The gathering
scenario takes a quarter as many, because each of its loads needs a new
character.

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

`Server-Timing` is set by `withHttpRequest` on every wrapped API response. It
carries durations only: no call names, counts, flags or request data.

## Results

Windows 11, local Docker PostgreSQL, 10 loads per warm scenario and 3
gathering loads, 2026-09-27, `main` at the #654 fix. All values are p50 in
milliseconds.

| Phase                | Warm, 1 character | Warm, 12 characters | Gathering |
| -------------------- | ----------------: | ------------------: | --------: |
| shell                |                27 |                  33 |        37 |
| requested            |               101 |                 109 |       105 |
| headers              |               130 |                 155 |       138 |
| rendered             |               142 |                 171 |       152 |
| settled              |               130 |                 155 |     3,252 |
| server total         |                25 |                  40 |        29 |
| server `db` (summed) |                24 |                 189 |        26 |

Each scenario's warm-up load rendered at about 250–290 ms.

## Where the time goes

1. **Before the read starts: about 75 ms after the shell, and about 100 ms
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

2. **The server read: 25–40 ms locally.** This is almost all database time.
   At 12 characters, `db` sums to about 190 ms within a 40 ms request, because
   `assembleDossier` gathers each subject in parallel and the web scope sums
   overlapping calls (see "Caveats").
3. **Rendering: about 12–16 ms** after the response.
4. **Gathering evidence: about 3.1 s longer than a warm load.** The settle time
   falls where the page's poll backoff (1 s, then 2 s) puts the second
   re-read, not where the worker finishes. A visitor sees new evidence only
   at the next poll after it is published.

## Production is not this machine

The one production-shaped sample, a dossier read on `test` on 2026-09-26, took
1,184 ms on the server. It made 62 database calls (`dbMs` 1,891 summed, the
largest `evidence.reserve` at 221 ms) and 751 ms of Raider.IO rankings lookups
(6 physical calls). Locally the same kind of read takes 25–40 ms. The
difference is database round-trip latency and live provider latency, and the
local fakes and container remove both. The local profile therefore shows how
many steps a load takes and in what order, but not how long each database step
takes in production.

Railway keeps only the current deployment's logs. Across the last 40 web
deployments on `test`, one dossier `http_request` record survived, so logs
cannot provide a production baseline either.

## Caveats

- The web `MeasurementScope` sums overlapping calls, so `db` can exceed
  `total` (190 ms against 40 ms at 12 characters). Read it as work done, not
  as wall time. The worker's `discovery_run` uses the `shared` mode instead.
- The warm scenarios read seeded evidence with no stored Cutting Edge
  achievements. The fake Blizzard answers the achievement read, and the
  15-minute process cache then serves repeats, so `blizzard` appears only on
  a scenario's first read.
- Before #654 the web ignored `BLIZZARD_BASE_URL`, and every read made a live
  Blizzard call of about 230 ms. Any profile taken before that fix is invalid.

## Follow-ups

- **Start the first read sooner.** The read cannot begin until the client
  page has started, about 75 ms after the shell locally and more on a slow
  device. The server shell could fetch the first read itself, or the page
  could start it before hydration.
- **Profile a visitor with stored provider keys.** Their read waits on a
  serial `/api/account/session` round trip, and none of these scenarios
  covers that.
- **Find out what production's 62 database calls are.** The local
  `dbCalls` for the same read would show whether production makes extra
  calls or makes the same calls more slowly. A profiler mode that adds
  latency to database calls would model Railway.
- **Evidence appears only at the next poll.** The 1 s, 2 s, 4 s backoff means
  a visitor can wait up to one full interval after evidence is published.
- **Unbounded polling on `partial`:** #663.
