# Performance Observability Design

**Date:** 2026-09-15

**Issue:** #187

**Status:** Approved for implementation

## Purpose

SlashWho can currently observe the two ends of a request and almost nothing in
between. The web service emits one `http_request` record per API route and the
worker emits one rich `discovery_run` record per discovery run, but the three
upstream clients, the PostgreSQL repositories, the dossier assembly path, and
the Warcraft Logs evidence job emit no timing at all. An operator can see that
a dossier was slow. They cannot see which provider, which query, or which queue
caused it.

This design closes that gap without adding infrastructure. Every measurement
lands as additional fields on one summary record per unit of work, written to
stdout and read from Railway's log stream, because that is the only sink
available and the only one the measurement procedure in
`docs/research/2026-09-15-applicant-research-performance.md` assumes.

The goal is not coverage for its own sake. It is to answer four questions that
currently have no answer: which provider dominates a slow dossier, whether the
database or the queue is the real constraint, whether
`DOSSIER_PROVIDER_CONCURRENCY` is set correctly, and how long evidence
collection actually takes.

## Constraints

The design is bound by four existing properties of the codebase, each of which
rules out an otherwise obvious approach.

Both service containers are process-wide singletons. `createWebContainer` builds
its services once, which is why today's `onCacheEvent` callback is an
unattributed global counter. Any decorator installed at the composition root is
shared across concurrent requests and cannot attribute time to one of them.

The codebase injects everything. `logger`, `observe`, `onCacheEvent`,
`monotonic`, `random`, and `clock` are all explicit parameters, and the test
suite depends on that determinism. Introducing implicit ambient context would be
a new and inconsistent mechanism.

The web logger is a hard allowlist. `allowedFields` in
`apps/web/src/server/logger.ts` drops any field not named in it, silently and
without error. Every new web field must be added there or it will not appear.

The worker logger redacts by normalized key name, and its `sensitiveKeys` set
includes `score`. Any new field whose name reduces to `score` will be censored
to `[Redacted]`. No field defined below may end in "score".

## Approach

Measurement is explicit and confined to a small number of seams, rather than
applied to every call site or inferred from ambient context.

A new `packages/application/src/measurement.ts` exports
`createMeasurementScope()`. A scope is an accumulator with one method,
`time(bucket, work)`, which runs the work and records elapsed duration, a call
count, and the longest single call against that bucket. Timing uses
`try`/`finally`, so a call that throws or times out still contributes its
duration — the timeout case is the expensive one and must not be lost. The
monotonic clock is injected, matching the existing `monotonic` parameter on the
discovery handler.

`totals()` returns flat numeric fields suitable for direct spreading into a log
record. Buckets are disjoint by construction: database time never nests inside
provider time, and limiter wait is measured around admission only, never around
the work the limiter admits.

Scopes are created at three unit-of-work boundaries and passed down explicitly:
`withHttpRequest` in the web service, the discovery job handler, and a new
wrapper around the Warcraft Logs evidence job. Each boundary merges `totals()`
into the single record it emits.

Five seams are instrumented:

- the dossier service's two internal gateway decorators, which already wrap
  Blizzard and Raider.IO with the bounded caches and are therefore the natural
  place for provider timing;
- `concurrency.ts`, which gains an optional `onWait(ms)` callback so queueing
  delay at the provider limiter is reported separately from the work itself;
- the discovery job handler's gateway calls;
- the evidence job handler's Warcraft Logs calls; and
- a `measuredRepositories(repositories, scope)` wrapper applied per unit of
  work rather than at the composition root, which sidesteps the singleton
  problem without editing `postgres-repositories.ts`.

The four public `ApplicantDossierService` methods — `start`,
`addConnectedCharacter`, `readInitial`, and `read` — gain an optional trailing
`scope` parameter alongside the `signal` they already accept. Nothing becomes
required. Omitting a scope reproduces current behavior exactly.

Coverage is deliberately partial. A provider or database call introduced
outside a measured seam will be invisible. This is accepted in exchange for
leaving the 1,398-line Warcraft Logs client and the 2,381-line repositories file
structurally untouched.

## Bucket granularity

Buckets are per-provider on the discovery and evidence paths: `raiderio`,
`blizzard`, `warcraftlogs`, and `db`.

Two accumulators are not call buckets and carry a duration only, with no call
count or longest-call value: `limiterWaitMs`, the time spent awaiting admission
at the provider limiter. Throttling is reported separately as `rateLimitHits`
and `retryAfterMaxMs`, defined in the section below.

Every bucket derives its field names uniformly from its prefix, as
`<prefix>Ms`, `<prefix>Calls`, and `<prefix>MaxCallMs`. The database bucket is
therefore `dbMs`, `dbCalls`, and `dbMaxCallMs`. Uniformity is deliberate: it
keeps a rename map out of both the measurement module and the analysis script,
which discovers numeric fields generically.

On the dossier read path the buckets are per-operation instead — separating
`getMythicBossRankings` from `getCharacter` — because that path is where the
rank enrichment fan-out lives and where `DOSSIER_PROVIDER_CONCURRENCY` applies.
A single aggregated Raider.IO total would not distinguish one slow character
lookup from a wide, healthy boss-ranking fan-out, and those have different
remedies.

Each bucket reports three values: total milliseconds, call count, and the
longest single call. The longest-call value exists because a summed total hides
its own distribution: eight seconds across forty calls may be forty uniform
calls or thirty-nine fast ones behind a single six-second outlier, and only the
latter is worth chasing.

Achieved concurrency does not need its own field. Dividing a provider's total
milliseconds by the record's `durationMs` gives it, which is sufficient to
judge whether raising the limiter would help.

## Rate limit and retry separation

All three clients parse a `Retry-After` header
(`packages/blizzard/src/client.ts:41`, `packages/raiderio/src/client.ts:118`,
`packages/warcraftlogs/src/client.ts:210`) and return the delay to the caller as
part of a failure or limitation. None of them sleeps, and none of them retries
internally — verified by the absence of any `setTimeout`, `sleep`, or
`await new Promise` in all three files.

This matters for the design. There is no in-client sleep hiding inside the
provider buckets, so those buckets already hold request time only and require no
subtraction. The waiting that does occur happens between pg-boss delivery
attempts, where it is already visible through the existing `attempt` field and
the new `queueWaitMs` below.

What is genuinely missing is whether throttling is happening at all. A run can
be slow because an upstream is throttling the service into repeated delivery
attempts, and no current field distinguishes that from an upstream simply being
slow — remedies that differ completely, since one calls for raising a request
cap or reducing fan-out and the other for caching.

Each client therefore gains one optional `onThrottle({ retryAfterMs })`
callback, invoked where it already detects a throttled response. The clients
gain no other knowledge: no scope, no logger, no correlation ID. The callback is
optional, so existing construction sites are unaffected. The boundary
accumulates these into two fields: `rateLimitHits`, the number of throttled
responses observed, and `retryAfterMaxMs`, the largest delay an upstream asked
for.

There is deliberately no `retryCount` field. Since the clients do not retry, the
only retry count that exists is the pg-boss delivery attempt already recorded as
`attempt`, and adding a second similarly-named field would invite exactly the
confusion it appears to resolve.

## Queue wait

A saturated worker is invisible to every bucket above: the job waits in pg-boss
while each measured stage looks healthy. `fingerprintQueueWaitMs` already covers
the fingerprint admission path, but nothing covers ordinary discovery or
evidence jobs.

`DiscoverCharacterJob` and `CollectCharacterEvidenceJob` therefore carry
`enqueuedAt` alongside the correlation ID described below. Each handler computes
`queueWaitMs` on entry. Both fields are additive and optional, so jobs enqueued
by a previous deployment and still in flight during a rolling restart remain
valid; a missing `enqueuedAt` yields a null `queueWaitMs` rather than a wrong
one.

## Correlation

Correlation is log-only. No migration, and no request identifier is written to
any table.

`withHttpRequest` already mints a `correlationId` per request and returns it as
the `x-request-id` header. That value is added to the two job payloads and
echoed by the worker in `discovery_run` and the new `evidence_job` record,
making a user request traceable across the process boundary by grep.

Discovery jobs are deduplicated by `singletonKey: runId`, so several user
requests can collapse onto one run. The run carries the first requester's
correlation ID. Later requesters are not lost: each logs its own `http_request`
with `runJoined: true`, so the fan-in remains visible and an operator can see
that a request waited on work it did not start.

## Records

Three records, one per unit of work. No per-call log lines are emitted, because
Railway's log stream is the only sink and per-call volume would make it
unusable.

Where a record is described below as gaining "buckets", that means the three
values per bucket defined above — total milliseconds, call count, and longest
single call — named `<bucket>Ms`, `<bucket>Calls`, and `<bucket>MaxCallMs`.

**`http_request`** (extended) gains the per-operation provider buckets,
`dbMs`, `dbCalls`, `dbMaxCallMs`, `limiterWaitMs`, `rateLimitHits`,
`retryAfterMaxMs`,
`runJoined`, and the folded cache totals `cacheHits`, `cacheMisses`,
`cacheShared`, `cacheFailures`, and `cacheCapacity`. Every existing field is
retained.

**`discovery_run`** (extended) gains the per-provider buckets, `dbMs`,
`dbCalls`, `dbMaxCallMs`, `rateLimitHits`, `retryAfterMaxMs`,
`queueWaitMs`, and `correlationId`. Every existing field is retained, including the canonical
character key.

**`evidence_job`** (new) carries `runId`, `correlationId`, `durationMs`,
`queueWaitMs`, `outcome`, `warcraftLogsMs`, `warcraftLogsCalls`,
`warcraftLogsMaxCallMs`, `dbMs`, `dbCalls`, `dbMaxCallMs`,
`rateLimitHits`, `retryAfterMaxMs`, `requestCapUsed`, and `limitationCode`. The evidence path currently emits
nothing whatsoever, so this record is the single largest coverage gain in the
design.

## Logging hygiene

Two sites currently bypass their logger by calling `console.info` directly, and
both move onto the injected logger: the `dossier_cache` emission at
`apps/web/src/server/container.ts:94` and `evidence_cache_cleanup` in
`apps/worker/src/runtime.ts`. After this change nothing in either service
bypasses redaction.

The `dossier_cache` record is retired rather than merely relocated. Its cache
outcomes become folded totals on `http_request`, which both reduces log volume
and attributes each cache outcome to the request that caused it — something the
current process-wide callback cannot do.

`allowedFields` in `apps/web/src/server/logger.ts` is extended with every new
web field. All additions are integers, booleans, or the existing correlation ID.
No character identity, URL, request body, or upstream payload is added to any
record, so the privacy posture is unchanged.

## Analysis tooling

A log sink with no analysis step yields no percentiles, so the measurement
procedure in the research document is not satisfied by instrumentation alone.

A script under `scripts/` reads a captured log dump on stdin, filters to a
record type, and reports count, p50, p95, and maximum for each numeric field,
grouped by outcome. This makes the four scenarios named in the research document
— cold search, stale refresh, warm read, and read during evidence gathering —
directly comparable before and after a change. The script parses only the
structured records defined above and requires no service credentials.

## Documentation correction

`docs/research/2026-09-15-applicant-research-performance.md` states that the
worker's records "contain no character identity". This is incorrect.
`discovery_run` has always included the canonical `region`, `realm`, and `name`,
deliberately and by documented design — the allowlist comment at
`packages/application/src/discovery-job-handler.ts:57` names the canonical
public character key as an intended field.

The record is correct and the sentence is wrong, so the research document is
corrected to describe the actual contents: the canonical public character key is
included; owner identifiers, profile guesses, upstream bodies, and IP addresses
are not.

## Testing

Each measured seam gets a focused unit test using an injected monotonic clock,
following the existing pattern in the discovery handler tests. `measurement.ts`
is tested directly for accumulation, the longest-call value, disjointness of
buckets, and the `try`/`finally` guarantee that a throwing call still records
its duration.

The web logger test is extended to prove that every newly allowlisted field
survives serialization, and — more importantly — that a field absent from the
allowlist is still dropped. The worker logger test is extended to prove no new
field name is caught by the `score` redaction rule.

Correlation is tested by asserting that a correlation ID placed on a job payload
appears in the worker record, and that a deduplicated second request logs
`runJoined: true`.

The analysis script is tested against a fixture log dump with known
percentiles.

Existing tests for dossier assembly, cached evidence, gathering states, provider
limitations, and rank enrichment must continue to pass unchanged, since every
new parameter is optional and omitting it preserves current behavior.

## Out of scope

No metrics backend, log drain, tracing system, or `/metrics` endpoint. No
database migration and no persisted request identifier. No client-side web
vitals. No change to upstream timeout, request cap, cache TTL, or rate-limit
semantics. No refactoring of the Warcraft Logs client or the repositories file
beyond the single optional callback each requires.
