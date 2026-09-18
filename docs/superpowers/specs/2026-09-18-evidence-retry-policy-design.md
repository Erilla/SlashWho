# Evidence retry policy

Closes #292.

## The problem

`collect-character-evidence` carries a flat `retryLimit: 4`
(`packages/database/src/queue.ts`). The handler rethrows every error it
catches, so the queue cannot tell a transient fault from a deterministic one
and gives both four more attempts.

On 2026-09-18 one run spent five attempts on the same deterministic throw:

```
09:43:26  43086349  a1  unexpected_error  pointsSpentByRun=2523.24  killCount=135
09:45:47  43086349  a2  unexpected_error  pointsSpentByRun=1180.95  killCount=135
09:47:07  43086349  a3  unexpected_error  pointsSpentByRun=1350.49  killCount=135
09:48:18  43086349  a4  unexpected_error  pointsSpentByRun=1840.23  killCount=135
09:49:08  43086349  a5  unexpected_error  pointsSpentByRun=1745.19  killCount=135
```

Roughly 8,600 Warcraft Logs points for nothing published. `killCount` is
identical across all five: each attempt re-fetched the same data and failed the
same way. Eleven of the twelve executions in that window were failures or
retries of failures, and together they consumed the hourly allowance.

The root cause of those particular failures was #290, fixed separately. This
design stands regardless: any deterministic failure is multiplied by five at
full upstream cost, and nothing in the loop notices that the previous attempt
already did this work and already failed.

## What this changes

1. A retry decision that distinguishes deterministic faults from transient
   ones, so a failure that will recur does not get four more chances.
2. A cost veto, so the points an attempt already spent participate in the
   decision.
3. Resumption, so a retry that does happen does not repeat work already done:
   publish-as-partial for failures during collection, and a staged payload for
   the window between a finished scan and a successful publish.

## Where the decision lives

A pure policy function, applied by the handler. `queue.ts` is untouched.

pg-boss has no per-job "do not retry" lever. The only sound way to end a job
early is for the handler not to throw, which is the handler's decision to make.
`discovery-job-handler.ts` already ends a non-retryable run exactly this way --
it fails the run and returns -- and the evidence handler is the outlier in
rethrowing everything.

```
evidenceRetryDecision({
  classification,   // from the error, see below
  attempt,          // context.attempt
  maxAttempts,      // context.maxAttempts
  pointsSpent,      // number | null
  collectionBegan,  // boolean
  costCeiling       // EVIDENCE_RETRY_COST_CEILING
}): { action: "retry" | "stop"; reason: RetryReason }
```

Table-driven and pure, so the whole policy is testable without a queue, a
gateway or a database. `RetryReason` is a closed union authored in source:
`deterministic`, `cost_veto`, `unclassified_exhausted`, `retryable`,
`cancelled`.

## Classification

The gateway barely throws. `packages/warcraftlogs/src/client.ts` turns
transport faults, 429s and schema drift into *returned* limitations
(`unavailable`, `rate_limited`, `schema_drift`) which the handler already
publishes as a partial. That keeps the table short.

| Source | Classification | Why |
|---|---|---|
| Points-budget refusal (`points_budget_low`) | Retryable, unchanged | Deliberate, carries its own delay, spends nothing -- the refusal precedes collection. Its terminal-attempt handling is untouched. |
| Abort / shutdown (`signal.aborted`) | Retryable | A graceful deploy is the definition of transient. |
| Database transport failure (connection lost, timeout) | Retryable | Genuinely transient, cheap to establish. |
| Database constraint violation (SQLSTATE `23xxx`) | Deterministic | The same rows violate the same constraint. This is #290's class. |
| `RangeError`, `TypeError`, our own guard throws (a snake_case `errorCode`) | Deterministic | A programming error or a violated invariant: identical input, identical throw. |
| Anything else | One retry, then stop | A second identical failure is evidence of determinism; the first is not. |

The classifier reads exactly what `errorFields` already extracts --
`errorName` and `errorCode` -- so no new error plumbing is needed, and a human
reading the log record can see why there was no second attempt.

A unique-violation from two workers racing is arguably transient rather than
deterministic. It is treated as deterministic anyway: #296 made evidence
collection serial, so the race it would describe is closed at the source.

## The cost veto

`pointsSpentByRun` is currently sampled only on the happy path, after a
successful scan and before publication. The second `getRateLimit` call moves
into a helper used by both the success path and the catch block, wrapped so
that a failure to *measure* never replaces the error being handled --
`record.pointsSpentByRun` stays null, which is what happened: unmeasured.

- An attempt that spent more than `EVIDENCE_RETRY_COST_CEILING` points is not
  retried, whatever the classification says. It overrides `retryable` and
  overrides the one-free-retry default. The sole exception is the points
  refusal, which by construction spent nothing and is the mechanism that waits
  for the allowance to reset.
- Unmeasured spend with `collectionBegan` true counts as expensive. If we
  cannot tell what an attempt cost and we know it ran a scan, assuming it was
  cheap is the assumption that produced this issue.
- Spend at or below the ceiling falls through to the classification table.

`EVIDENCE_RETRY_COST_CEILING` defaults to 250, `0` disables the veto -- the
same shape and the same operator escape hatch as `EVIDENCE_POINTS_RESERVE`.

**250 is a guess.** It is derived from the five attempts in #292 (1,180-2,523
points each) and the `EVIDENCE_POINTS_RESERVE` comment putting an average run
above 900. It sits comfortably below a real collection and comfortably above
the handful of requests an early failure makes, which is all it needs to do to
separate "failed before doing the work" from "failed after paying for it". Like
the reserve, it is revisited against logged `pointsSpentByRun` once deployed.

## The stop path

On `stop`, the handler publishes `state: "partial"` with whatever the scan
produced (`kills: []` if it never got that far), `limitationCode:
"collection_failed"`, and `retryAfterAt = now + EVIDENCE_FAILURE_COOLDOWN_MS`,
then returns normally so pg-boss completes the job.

This is safe against the destructive merge of #250: `publish` calls
`loadPositiveEvidenceForPartial` for a partial publication and carries prior
kills, wipes and parses forward, so a failing run can only add, never subtract.

`EVIDENCE_FAILURE_COOLDOWN_MS` defaults to 30 minutes, matching
`EVIDENCE_PARSE_CAP_RETRY_MS` and for the same reason: long enough that a
persistently broken character is not re-collected on every page read, short
enough that a character recovers without intervention.

### Why a cooldown is load-bearing

`reserve` (`packages/database/src/postgres-repositories.ts`) treats `failed` as
nothing at all: it is neither in the active set (`queued`, `running`,
`retrying`) nor in `loadCompletedEvidence`'s (`complete`, `partial`). A run
that fails fast with no brake is therefore re-reserved by the very next page
read, turning five retries into an unbounded reservation loop driven by
traffic -- worse than the bug being fixed.

Publishing a partial with `retry_after_at` closes this with machinery that
already exists: `isEvidenceFresh` honours `retryAfterAt`, so reservation is
suppressed until the cooldown lapses. No new column and no new query.

### When publishing is itself what is broken

If `publish` is the failing call -- #290's exact case -- the stop path's
publish fails too. The fallback is the existing `evidence.fail(runId, code)`,
which takes the run out of the active set so the character is not wedged,
accepting that the next read reserves again. This is a strictly better failure
than today's five full collections, and it is named here rather than papered
over.

## The `collection_failed` code

"Our own code threw" is not a Warcraft Logs fact, so the Warcraft Logs package
keeps describing only Warcraft Logs facts and the union is widened at the store
boundary:

```ts
type EvidenceLimitationCode = WarcraftLogsLimitationCode | "collection_failed";
```

Three places change:

1. `EvidenceLimitationCode` at the store boundary, replacing
   `WarcraftLogsLimitationCode` in `ApplicantEvidenceStore.publish`,
   `recordLimitation` and `fail`.
2. The `dossierLimitationSchema` enum in `packages/contracts/src/dossier.ts`.
3. A `case` in `limitationMessage` in `applicant-dossier-service.ts`. Without
   it the code falls through to the `default`, which claims a *parse*
   shortfall and would be wrong.

No migration: `limitation_code` is `text`, and the
`character_evidence_runs_completion_limitations_check` constraint only requires
a partial run to name some code.

Reader copy, in the register of the existing messages: Warcraft Logs collection
was interrupted by an error, shown evidence is partial, it retries
automatically.

## Staging the publish step

A new table:

```
character_evidence_collections
  run_id      uuid primary key references character_evidence_runs(id) on delete cascade
  payload     jsonb not null
  created_at  timestamptz not null default now()
```

Written once the scan returns and before `publish` is attempted. An attempt
whose run already has a stage skips the gateway entirely and goes straight to
publishing, which is what makes a retry after a transient publish failure cost
nothing upstream. The stage is deleted in the same transaction as a successful
publication. The hourly `maintenance-cleanup` job drops stages whose run is no
longer active.

The payload holds only the normalised gateway facts `publish` already takes --
kills, wipes, tier bests and the limitation codes. Never credentials.

A retry sees the same `runId` (pg-boss retries the same job and the run stays
claimed), so keying the stage on `run_id` is sufficient; no separate attempt
dimension is needed.

## Observability

The `evidence_job` record gains two fields:

- `retryDecision`: `retry` | `stop`
- `retryReason`: `deterministic` | `cost_veto` | `unclassified_exhausted` |
  `retryable` | `cancelled`

Both are closed enumerations authored in source, so they carry no unbounded
text and the `errorFields` constraint -- no names, realms, URLs or payloads in
a log record -- holds.

The chat announcement's `finished` call carries the same two fields alongside
the `pointsSpent` it already sends. What #292 is really about is money spent on
failure, and this puts it where someone is already watching.

## Testing

Written in this order, each red first.

**Unit, the policy function.** The classification table crossed with the cost
veto: a deterministic code stops on attempt 1; an unclassified error retries
once and stops on attempt 2; a retryable transport error stops anyway once
spend exceeds the ceiling; unmeasured spend with `collectionBegan` stops; the
points refusal retries regardless of attempt within `maxAttempts`, preserving
today's behaviour; a ceiling of `0` disables the veto.

**Unit, the handler.** A stop decision publishes partial with
`collection_failed` and a `retryAfterAt`, and does not throw; a retry decision
throws; a publish failure on the stop path falls back to `fail`; an attempt
whose run has a stage never calls the gateway; `pointsSpentByRun` is populated
on the error path; a measurement failure in the catch does not replace the
original error.

**Integration.** The migration applies; a staged payload survives a round trip;
the stage is gone after a successful publication; cleanup drops stages for
inactive runs; and the regression that proves #292 -- a deterministic failure
yields exactly one execution, not five.

**Contract.** `collection_failed` parses against `dossierLimitationSchema` and
renders its own message rather than the parse-shortfall default.

## Documentation

- `docs/dossier-cache-policy.md`: the `collection_failed` cooldown, since that
  file describes when a character is re-collected.
- `apps/worker/src/config.ts`: `EVIDENCE_RETRY_COST_CEILING` and
  `EVIDENCE_FAILURE_COOLDOWN_MS` documented in the register
  `EVIDENCE_POINTS_RESERVE` established -- what the number means, that it is a
  guess, and what evidence replaces it.

## Out of scope

- The root cause of the #292 failures (#290, fixed separately).
- Concurrent runs defeating the points admission check (#296, merged).
- Any change to `retryLimit: 4` itself. The ceiling stays; what changes is how
  many of those attempts a given failure is allowed to reach.
