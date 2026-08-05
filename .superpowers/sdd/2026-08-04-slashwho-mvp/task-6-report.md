# Task 6 report: durable discovery worker

## Status

Implemented the `discover-character` pg-boss queue, application job handler,
worker runtime, health server, startup retry, readiness, bounded drain, and
redacted logging. The queue and all concurrency/atomicity tests use real
PostgreSQL 16; no PostgreSQL or pg-boss mocks were used.

## Files

- Added `packages/database/src/queue.ts` and exported the queue adapter from
  `packages/database/src/index.ts`.
- Added `packages/application/src/discovery-job-handler.ts` and its public
  exports.
- Added worker `config.ts`, `logger.ts`, `health-server.ts`, and `runtime.ts`,
  then composed them in `apps/worker/src/main.ts`.
- Added unit tests for discovery handling, logger redaction, health/readiness,
  startup retry, startup cleanup, runtime routing, and shutdown ordering.
- Added real-PostgreSQL integration tests for two-worker exclusivity, pg-boss
  lifecycle/retry limits, upstream Retry-After scheduling, graceful drain, and
  snapshot rollback atomicity.
- Extended the domain failure outcome to carry the sanitized numeric
  `retryAfterMs` already emitted by the Raider.IO gateway.
- Added workspace dependencies/exports and updated `pnpm-lock.yaml`.

## TDD evidence

- RED: domain test received no `retryAfterMs`; GREEN: the sanitized transient
  delay is preserved (14/14 domain tests at that cycle).
- RED: handler test could not resolve the missing module; GREEN: snapshot,
  stale-data, negative-cache, retry, and terminal-state cases passed.
- RED: integration tests reported `createDiscoveryQueue is not a function`;
  GREEN: real pg-boss creation, work, retry, completion, and failure passed.
- RED: health/logger/runtime suites could not resolve their missing modules;
  GREEN: health/readiness, redaction, startup retry, routing, and drain passed.
- RED: a nested `owner_id`/`validation_name` secret marker appeared in logger
  output; GREEN: recursive key sanitization removed it.
- RED: pg-boss scheduled a retry before the handler's longer Retry-After;
  GREEN: the active job receives the validated, 30-minute-capped delay before
  failure settlement.
- RED: initialization failure never called queue stop; GREEN: queue and pool
  cleanup both run on failed startup.
- RED: a run exactly 30 minutes old entered `retrying`; GREEN: the application
  terminates it, making five attempts/30 minutes a whichever-comes-first bound.
- One lifecycle observation initially exceeded a 20-second test polling window
  because real pg-boss jitter plus polling can approach that boundary; the test
  observation limit was raised without changing production retry settings.

## Versions

- Node.js: `v22.15.0`
- pnpm: `11.20.0`
- PostgreSQL test image: `postgres:16-alpine` (`PostgreSQL 16.14`)
- Docker Desktop engine: `29.2.0`
- pg-boss: `12.27.0`
- Pino: `10.3.1`

## pg-boss v12 API adjustments

- v12.27 retains the illustrative batch work callback (`async ([job])`).
- The public adapter's `timeoutMs` maps to pg-boss v12's stop option `timeout`.
- `createQueue()` is followed by `updateQueue()` so an existing queue also has
  the required retry/expiry policy before any send.
- pg-boss v12 has no public per-attempt Retry-After option for an already-active
  job. The adapter uses the public `getDb().executeSql()` seam to update only the
  active `pgboss.job` row's validated retry delay before settlement. This is
  deliberately covered by a real-PostgreSQL scheduling test and is the only
  version-coupled internal-schema touchpoint.

## Verification

- Focused handler/runtime command: PASS, 2 files and 11/11 tests.
- Focused PostgreSQL queue/atomicity command: PASS, 2 files and 5/5 tests.
- Full `corepack pnpm test` under Node 22.15: PASS, 14 files and 77/77 tests.
- `corepack pnpm exec prettier --check .`: PASS.
- `corepack pnpm exec eslint .`: PASS.
- `corepack pnpm -r typecheck`: PASS for all seven workspace projects.
- `git diff --check`: PASS.

## Shutdown and concurrency evidence

- Two independently constructed pg-boss workers consumed one job exactly once.
- A real job was observed in `created`, `active`, `retry`, and terminal `failed`
  states, with `retryCount: 4`, `retryLimit: 4`, and exactly five invocations.
- A graceful stop remained pending while claimed work was blocked; after the
  work was released, stop returned and the database job was `completed`.
- Runtime readiness becomes false before queue drain starts, and the PostgreSQL
  pool closes only after drain resolves. Failed initialization uses non-graceful
  queue cleanup and closes the pool.

## Self-review

- Snapshot publication composes the repository's existing single transaction;
  the handler does not reproduce persistence SQL.
- Retry and definitive failure paths never call snapshot creation, so an older
  trustworthy snapshot remains current.
- Confirmed absence alone writes the negative cache; schema drift maps to the
  stable public `search_failed` code and transient exhaustion maps to
  `upstream_unavailable`.
- Queue payloads contain only run ID and canonical public character key. Runtime
  passes only run ID to the handler. Production logs contain only allowlisted
  lifecycle fields, with defense-in-depth Pino redaction and recursive
  sanitization for credentials, bodies, owner/profile guesses, and validation
  names.
- Mutation review: removing atomic snapshot creation, retry transition, attempt
  or lifetime bound, Retry-After propagation/application, queue exclusivity,
  drain ordering, readiness gates, or recursive redaction fails a test.

## Concerns

- The active-job retry-delay update is intentionally coupled to pg-boss v12's
  default `pgboss.job` schema because v12.27 exposes no active-job option update.
  Revalidate that one integration test before upgrading pg-boss or configuring a
  non-default pg-boss schema.
