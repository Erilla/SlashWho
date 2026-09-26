# Blizzard fingerprint sweep concurrency

Issue #549. Investigated 2026-09-26 against `origin/main` at `2922426c`.

## Question

The fingerprint sweep reads candidate achievement profiles one at a time
(`for (const candidate of candidates)`,
`packages/domain/src/fingerprint-discovery.ts:356`). The issue measured a
300-request sweep on Railway test: 299 Blizzard calls, 84,817 ms of Blizzard
time, a maximum single call of 1,102 ms, so a mean of about 284 ms. It asks for
a bounded concurrency "picked from Blizzard's published per-second limit and
the other consumers of the same client credentials, not from a guess".

What concurrency should the sweep use, and does a concurrency cap alone keep
the service inside Blizzard's limits?

## Answer

**Use a concurrency of 6, enforced process-wide on the worker's Blizzard
client, together with a process-wide rate limit of 20 requests per second on
that same client.** If the change ships without the rate limiter, use **4**.

Why: Blizzard publishes 100 requests per second and 36,000 per hour per API
client. A concurrency cap alone does not bound the request rate. The rate is
in-flight requests divided by latency, and we have no latency floor: only a
mean (284 ms) and a maximum (1,102 ms). Fast answers (404s for unreadable
profiles, cache hits at Blizzard's edge) raise the rate. At a pessimistic
100 ms, 6-way would be 60 requests per second from the sweep alone. Add the web
service's Cutting Edge reads (up to 4 in flight per replica by default, so up
to 40 per second at 100 ms) and the total could exceed 100. A 20 per second
limiter makes the sweep's share independent of latency. It still finishes a
300-request sweep in about 15 s (against 85 s today), and worst-case shared
traffic stays near 60 per second, leaving 40% headroom. At the measured 284 ms
mean, 6-way generates about 21 requests per second, so the limiter rarely binds
in normal running. Without a limiter, 4-way keeps the pessimistic total at
about 80 per second (4 / 0.1 + 40), and a sweep takes about 21 s. The headroom
matters because a single 429 currently fails the whole sweep
(`packages/domain/src/fingerprint-discovery.ts:207-237`), with no retry inside
the client.

## Blizzard's published limits

| Limit                 | Published value                                                                                                                                                                                                                                       | Source                                                                                                                                                                                                                                                                                  | Confidence                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per second            | 100 requests per second                                                                                                                                                                                                                               | Developer portal, Getting Started, "Throttling" section: "API clients are limited to 36,000 requests per hour at a rate of 100 requests per second." ([page](https://community.developer.battle.net/documentation/guides/getting-started))                                              | High, primary. Read on 2026-09-26 in a rendered browser. `develop.battle.net/documentation/guides/getting-started` now 301s to this host.                                                                   |
| Per hour              | 36,000 requests per hour                                                                                                                                                                                                                              | Same page. The API Terms of Use also give the figure: "thirty-six thousand (36,000) calls to the Blizzard Developer API per hour" ([terms](https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use), last updated 1 October 2019) | High, primary.                                                                                                                                                                                              |
| Exceeding per second  | 429 "for the remainder of the second until the quota refreshes" (Getting Started)                                                                                                                                                                     | Same page                                                                                                                                                                                                                                                                               | High, primary. The wording implies a fixed one-second window, not a sliding one.                                                                                                                            |
| Exceeding per hour    | The guide says "slower service until traffic decreases". The Terms say Blizzard "may suspend or terminate Your access" if You exceed the limit or degrade its services.                                                                               | Same two pages                                                                                                                                                                                                                                                                          | High, primary. This is a contractual risk, not only a 429.                                                                                                                                                  |
| Scope of the limit    | The guide says the limit applies to "API clients", which reads as per client credential. The Terms address "You" (the developer), which could mean the developer account across all its clients (up to 50 clients per developer, per the same guide). | Same two pages                                                                                                                                                                                                                                                                          | Medium. Neither page mentions a per-region or per-IP limit. We assume one quota per client, shared across regions. That assumption is pessimistic for this service, which uses one client for every region. |
| Headers / Retry-After | Not documented. Neither page names a `Retry-After` or rate-limit header.                                                                                                                                                                              | Same two pages                                                                                                                                                                                                                                                                          | Not verified. The client honours `Retry-After` when present (`packages/blizzard/src/client.ts:48-58`), but we have no primary evidence that Blizzard sends it.                                              |

No secondary sources were needed. A web search surfaced forum threads
repeating the same figures. They were not used.

## Consumers of the credentials in this repository

Every consumer uses `createBlizzardClient`
(`packages/blizzard/src/client.ts:225`). The worker builds one client instance
(`apps/worker/src/runtime.ts:267-274`), which both discovery and evidence runs
use (`apps/worker/src/runtime.ts:734-735`). The web service builds its own
instance (`apps/web/src/server/container.ts:179-185`) from its own
`BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET`
(`apps/web/src/server/config.ts:174-181`). The repository cannot show whether
the two services use the same Blizzard client, but the service owner confirmed
on 2026-09-26 that they do. The web and worker terms below therefore share one
quota.

| Consumer                              | Where                                                                                                                                       | Requests per invocation                                                                                                                                                                                                                                        | In flight at once (per process)                                                                                                                                                                                                                                                                                                                                                                                                             | Charged to `BLIZZARD_HOURLY_REQUEST_BUDGET`?                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fingerprint sweep (discovery)         | Loop at `packages/domain/src/fingerprint-discovery.ts:356-404`; adapter at `packages/application/src/blizzard-fingerprint-adapter.ts:14-22` | Up to the reservation cap, 300 (`.env.example:89`, `docs/deployment/railway.md:158`). Roster reads use 1-3 (profile, class index cached for 24 h at `packages/blizzard/src/client.ts:39`, then roster), plus one per historical guild. Each candidate costs 1. | 1 today (serial). One discovery job at a time per worker: `discover-character` is registered without `localConcurrency` (`packages/database/src/queue.ts:353-361`), and pg-boss 12.27.0 defaults it to 1 and `batchSize` to 1 (`node_modules/.pnpm/pg-boss@12.27.0/node_modules/pg-boss/dist/manager.js:537`). The fingerprint-admission worker only enqueues discovery jobs; it never runs a sweep (`apps/worker/src/runtime.ts:763-783`). | Yes. Each request is recorded through `recordRequest` (`packages/application/src/discovery-job-handler.ts:623-629`, `packages/database/src/postgres-repositories.ts:4336-4370`).     |
| Evidence run Cutting Edge read        | `packages/application/src/applicant-evidence-job-handler.ts:2108-2128`                                                                      | 1 (`getCompletedAchievements` for the run's character, skipped for targeted runs)                                                                                                                                                                              | 1. `collect-character-evidence` is `localConcurrency: 1` (`packages/database/src/queue.ts:436-469`). It can overlap a sweep, because the two queues are independent.                                                                                                                                                                                                                                                                        | **No.** Only a counter is bumped (`applicant-evidence-job-handler.ts:2120`). This confirms the earlier finding in `docs/operations/evidence-run-cost.md:514-516`, which still holds. |
| Web dossier Cutting Edge reads        | `packages/application/src/applicant-dossier-service.ts:853-900` (gather), `:1450-1466` (gateway with a 15 s timeout and a 15-minute cache)  | Up to 25 per cold dossier (`ACHIEVEMENT_KEYS_PER_DOSSIER`, `applicant-dossier-service.ts:1365`). Warm reads within 15 minutes are cache hits.                                                                                                                  | Bounded by one process-wide limiter, `DOSSIER_PROVIDER_CONCURRENCY` (`applicant-dossier-service.ts:1438-1440`), default 4 and maximum 12 (`packages/application/src/config.ts:51-56`). Raider.IO ranking reads share the same limiter (`applicant-dossier-service.ts:995-998`), so Blizzard gets at most that many slots. This is per web replica.                                                                                          | **No.** Nothing in the web path records against the budget.                                                                                                                          |
| Visitor-supplied Blizzard credentials | `apps/web/src/server/credential-headers.ts:36-44`                                                                                           | As above                                                                                                                                                                                                                                                       | As above                                                                                                                                                                                                                                                                                                                                                                                                                                    | Not relevant: this uses the visitor's own client and quota.                                                                                                                          |
| OAuth token                           | `packages/blizzard/src/client.ts:235-297`                                                                                                   | 1 per process per token lifetime, single-flight, 15 s timeout                                                                                                                                                                                                  | 1                                                                                                                                                                                                                                                                                                                                                                                                                                           | Not charged. Negligible.                                                                                                                                                             |
| Measurement prototype                 | `scripts/prototypes/fingerprint-sweep-measurement.ts`                                                                                       | Manual only                                                                                                                                                                                                                                                    | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                         | n/a                                                                                                                                                                                  |

No other code calls Blizzard. The Journal and achievement catalogues are
generated artefacts, not runtime reads (`docs/research/2026-09-21-upstream-query-cost.md:34`).

### Do the per-consumer shares compose?

Only one Blizzard budget constant exists: `BLIZZARD_HOURLY_REQUEST_BUDGET`,
default 28,800 (`apps/worker/src/config.ts:289-296`, `.env.example:90`,
`docs/deployment/railway.md:159`). That is 80% of the published 36,000. The
only cross-constant check is that the sweep cap fits inside it
(`apps/worker/src/config.ts:294`, repeated at
`packages/database/src/postgres-repositories.ts:372-374`). The remaining
7,200 per hour is implicitly left for web and evidence reads, but no code or
test states or checks that allocation. There is also no per-second budget
anywhere.

## Existing controls

- **Hourly budget admission.** A sweep is admitted only if requests recorded in
  the trailing hour, plus the unspent remainder of every live reservation, plus
  this sweep's cap all fit in the budget
  (`packages/database/src/postgres-repositories.ts:444-461`). Sweeps are
  admitted head-of-queue, and several can hold reservations at once (up to
  28,800 / 300 = 96 per hour). Only one runs at a time per worker, though, as
  shown above. The admission is sound under concurrency within a sweep,
  because the cap is enforced per request inside the reservation
  (`used_count + $2 <= request_cap`, `postgres-repositories.ts:4349-4358`) and
  again by the adapter (`blizzard-fingerprint-adapter.ts:14-22`).
- **429 / Retry-After.** The client turns any non-OK response into a
  `transient` failure that carries `retryAfterMs` if the header is present, and
  reports throttles (`packages/blizzard/src/client.ts:80-95`). It does not
  retry. The adapter logs and alerts on a 429
  (`blizzard-fingerprint-adapter.ts:24-38`,
  `discovery-job-handler.ts:631-639`). The sweep then converts the failure into
  a retryable `upstream_unavailable` outcome
  (`fingerprint-discovery.ts:207-237`). For a first cycle, the run retries
  through the discovery retry schedule, which honours `Retry-After`
  (`discovery-job-handler.ts:318-337`, `:941`). A continuation retries as a
  fresh continuation (`discovery-job-handler.ts:666-679`). Either way, the
  requests already spent stay spent.
- **Limiters.** The only concurrency limiter is the generic
  `createConcurrencyLimiter` (`packages/application/src/concurrency.ts:7-61`).
  It is used by the web dossier (`DOSSIER_PROVIDER_CONCURRENCY`) and for
  evidence-run Raider.IO rankings (`RAIDER_IO_RANKING_CONCURRENCY = 4`,
  `applicant-evidence-job-handler.ts:452`). There is no rate limiter or token
  bucket for any Blizzard traffic.
- **Timeouts.** The token fetch has 15 s (`client.ts:237`) and web Cutting Edge
  reads have 15 s (`applicant-dossier-service.ts:1459`). The worker's sweep and
  evidence reads pass only the job's abort signal
  (`discovery-job-handler.ts:651-664`), so they have no per-request timeout.
- **Serial points outside Blizzard.** Each request's budget write takes a global
  transaction-scoped advisory lock, `fingerprint-sweeps`
  (`postgres-repositories.ts:355-359`, `:4346`). The write happens inside the
  request, before the fetch (`client.ts:305-307`). Concurrent reads will
  therefore queue on that lock one database round trip at a time. The issue's
  run averaged about 13 ms per database call (8,013 ms / 614), so this adds a
  floor of about 4 s for 300 requests. Each candidate also makes two
  `isSuppressed` queries (`fingerprint-discovery.ts:368`, `:395`).

## Derivation

Assumptions:

- One worker replica and one web replica, as the evidence queue comment states
  for the worker (`packages/database/src/queue.ts:465-468`). The web replica
  count is not in the repository.
- Worker and web use the same Blizzard client (confirmed by the service owner
  on 2026-09-26).
- `DOSSIER_PROVIDER_CONCURRENCY` is at its default of 4. It is not set in
  `.env.example` or `docs/deployment/railway.md`.
- Latency for the rate conversion: the measured mean is 284 ms. The
  pessimistic figure is **100 ms**, chosen because we have no minimum. The
  2026-09-21 note saw 300 requests take about 2.5 minutes (about 500 ms each),
  so 284 ms is already on the fast side of what has been seen
  (`docs/research/2026-09-21-upstream-query-cost.md:33`).
- Target: stay at or below about 60% of the published 100 per second, because a
  429 costs a whole sweep attempt. The window is a fixed second, so two bursts
  either side of a boundary can briefly double the apparent rate.

Rate from N in-flight requests = N / latency.

| Source                         | In flight | At 284 ms | At 100 ms |
| ------------------------------ | --------- | --------- | --------- |
| Sweep, serial (today)          | 1         | 3.5/s     | 10/s      |
| Sweep, N = 4                   | 4         | 14/s      | 40/s      |
| Sweep, N = 6                   | 6         | 21/s      | 60/s      |
| Sweep, N = 8 (issue's example) | 8         | 28/s      | 80/s      |
| Evidence run                   | 1         | 3.5/s     | 10/s      |
| Web, default limiter           | 4         | 14/s      | 40/s      |
| Web, maximum limiter           | 12        | 42/s      | 120/s     |

Worst-case totals on the shared credential at 100 ms (sweep + evidence + web
default):

- N = 8, no rate limiter: 80 + 10 + 40 = **130/s**. That exceeds 100, so reject
  it.
- N = 6, no rate limiter: 60 + 10 + 40 = **110/s**. That exceeds 100, so reject
  it.
- N = 4, no rate limiter: 40 + 10 + 40 = **90/s**. It fits, with thin headroom.
- N = 6, with a 20/s limiter on the worker client (covering sweep and
  evidence): 20 + 40 = **60/s**. It fits with 40% headroom, and this is the
  recommendation.

The web figure is itself unbounded in rate and grows with web replicas and with
`DOSSIER_PROVIDER_CONCURRENCY` (12 alone could reach 120/s at 100 ms). That is
an existing exposure, not one this issue creates. It is an argument for putting
the same kind of limiter on the web client later.

Sweep duration, from the issue's 300-request run:

- Blizzard time: 84.8 s / N at the measured latency. That gives about 21 s at
  N = 4, 14 s at N = 6 and 10.6 s at N = 8. The 20/s limiter sets a floor of
  300 / 20 = 15 s.
- Add the non-Blizzard remainder. Today that is 90.2 - 84.8 = 5.4 s of wall
  time beyond Blizzard, and the budget-write lock sets a floor of about 4 s.
  The recommendation therefore lands at **about 15-20 s**, against 90 s today.
  The issue's "roughly 11 s at 8-way" divides only the Blizzard time.

Hourly check:

- Published 36,000 per hour. The sweep budget is 28,800, so at most 96 full
  sweeps per hour. Concurrency does not change what a sweep costs. It changes
  how fast the budget can be spent. Serial sweeps at about 3.5/s would need
  about 2.3 h to spend 28,800, so today's latency is an accidental hourly
  throttle. At 20/s the budget can be spent in 24 minutes. After this change,
  the admission gate is the only hourly guard, and it already enforces the
  budget (`postgres-repositories.ts:444-461`).
- The 7,200 left over must cover uncharged web and evidence reads: 288 cold
  full (25-read) dossiers per hour, or fewer when evidence runs also read.
  Nothing enforces that allocation. If sweeps become frequent enough to use
  their whole budget, uncharged traffic could push the client over 36,000. The
  published consequence is slower service, and the Terms allow suspension.
  Measuring web Cutting Edge misses per hour is the missing input.

Should the cap be global per process rather than per sweep? **Yes.** Today a
worker runs one sweep at a time, so a per-sweep and a per-process cap are
numerically the same. The cap should still live on the worker's Blizzard
client (or on a limiter shared by every caller of that client) for three
reasons:

1. Evidence runs share the client and overlap sweeps.
2. Raising `localConcurrency` on `discover-character` later would otherwise
   multiply the per-sweep figure silently.
3. The rate limiter has to be per credential to mean anything.

Blizzard's limit is per client, so the correct scope is per credential across
replicas. Per process is correct only while the worker has one replica. Encode
that as a test or a startup check rather than a comment.

## Open questions and things not verified

- **Same credentials in both services: settled.** The service owner confirmed
  on 2026-09-26 that web and worker share one client.
  `docs/deployment/railway.md` still lists `BLIZZARD_CLIENT_ID` only under the
  worker variables (`:140-141`), not the web variables (`:39-100`), so the
  deployment doc does not record this.
- **A second client is not extra quota.** The guide's per-second wording names
  "API clients", so a second client on the same account may get its own 100/s
  throttle. The Terms, however, place the 36,000 per hour on "You" (the
  developer). They also forbid using third-party services to make extra
  requests on your behalf, and allow suspension for exceeding the limit. Read
  together, a second client probably shares the account's hourly quota, and
  using one to widen the per-second headroom works against a limit Blizzard can
  enforce against the whole account. A separate client is still useful for
  attributing each service's traffic, but the derivation above must not count
  it as capacity. Neither page mentions regions or IPs.
- **Whether Blizzard sends `Retry-After` or rate-limit headers.** Not
  documented. The code copes either way.
- **Latency floor.** Only the mean and maximum are recorded (`blizzardMs`,
  `blizzardCalls`, `blizzardMaxCallMs`). A minimum or p5 per `discovery_run`
  would replace the 100 ms assumption with a measurement.
- **Web replica count and `DOSSIER_PROVIDER_CONCURRENCY` in production.** Not
  in the repository. Both scale the web term above linearly.
- **Uncharged hourly volume.** Web Cutting Edge misses per hour and evidence
  runs per hour are not measured against the Blizzard budget
  (`docs/operations/evidence-run-cost.md:514-520` describes how to count the
  evidence side by hand).
- **No per-request timeout on worker Blizzard reads.** Under concurrency, a
  hung read holds a slot until the job aborts. That is outside this issue's
  scope, but it matters more once slots are shared.
