# Warcraft Logs points budget

Status: design, approved in chat 2026-09-17/18. Not yet implemented.

## Problem

Evidence runs are each individually well-behaved — every run is bounded by
`EVIDENCE_REQUEST_CAP` and `EVIDENCE_PARSE_REQUEST_CAP` — yet collectively they
exhaust the Warcraft Logs allowance and then achieve nothing for hours.

Observed 2026-09-17 on `eu/silvermoon/ryii`:

- ten characters refreshed at 16:31; all ten rate limited between 16:35:57 and
  16:36:04, six minutes after starting;
- the cycle repeated at 17:36 and again at 21:39, each time spending the
  allowance and gaining nothing;
- `pointsSpentThisHour` read **9058.65** against a then-limit of 9000;
- net gain across the whole evening: best parses unchanged at 125/175, first
  kill parses 211 → 212.

Nothing in the codebase models the Warcraft Logs allowance. Blizzard has
`blizzardHourlyRequestBudget`, enforced through `fingerprint_sweep_admissions`
and checked in `discovery-job-handler.ts`. Warcraft Logs has per-run request
caps only, which bound one run's requests and say nothing about what is left
upstream.

## What the upstream actually reports

Confirmed against the live API on 2026-09-17:

```graphql
{
  rateLimitData {
    limitPerHour
    pointsSpentThisHour
    pointsResetIn
  }
}
```

```json
{ "limitPerHour": 18000, "pointsSpentThisHour": 9058.65, "pointsResetIn": 949 }
```

Three properties drive the design:

1. **`pointsSpentThisHour` is fractional.** Budget arithmetic must not be
   integer. Mirroring the Blizzard table, whose `hourly_budget` is an `integer`
   column, would truncate silently.
2. **`limitPerHour` is not ours to choose, and it changes.** It was raised from
   9000 to 18000 mid-session. Any limit configured in Railway or written into a
   migration is wrong the moment the account tier changes. It must be read at
   runtime.
3. **`pointsResetIn` is authoritative; the `Retry-After` header is not.** The
   header reported 1036 seconds remaining at 22:15 and the API answered at
   22:16. `X-RateLimit-Remaining` read 798/800 throughout, tracking a different
   bucket entirely and saying nothing about the binding constraint. Two
   misdiagnoses on 2026-09-17 came from trusting those headers.

## Design

### Gateway

Add to `WarcraftLogsGateway` (`packages/warcraftlogs/src/types.ts`):

```ts
getRateLimit(
  signal?: AbortSignal
): Promise<WarcraftLogsRateLimit | WarcraftLogsLimitation>;

type WarcraftLogsRateLimit = Readonly<{
  limitPerHour: number;
  pointsSpentThisHour: number;
  pointsResetInSeconds: number;
}>;
```

The gateway knows how to ask and returns normalised facts with no policy, as
`getFirstKillReports` already does. It returns a limitation on transport
failure rather than throwing, matching the existing shape. The reserve
threshold never lives here.

### Admission

In `applicant-evidence-job-handler.ts`, after `claim` and before
`getFirstKillReports`:

- read the rate limit;
- if `limitPerHour - pointsSpentThisHour < reserve`, refuse the run;
- otherwise collect as now, then sample the rate limit again and log the delta.

A failed `getRateLimit` does **not** refuse the run. We are no worse off than
today, and a gate that fails closed on its own transport errors would be able
to stop all collection permanently.

### Refusing a run

A refused run throws a retryable error carrying `retryAfterMs`. This reuses
machinery that already exists: `requestedRetryDelaySeconds` in
`packages/database/src/queue.ts` reads `{ retryable: true, retryAfterMs }` off a
thrown error, and `updateActiveRetryDelay` applies it to the active job.

Nothing is published, so nothing can be lost — this specifically avoids a
zero-kill publish, which risks the destructive merge that caused the 24/175 →
1/175 data loss in #250 and needed #252 to repair.

**Not claiming the run instead would be a bug.** An unclaimed run stays
`queued`, and `reserve` reports any run in `('queued','running','retrying')` as
`active`, so every later read would join a run that is never processed and the
character would never collect again.

Two constraints from `queueOptions`:

- `requestedRetryDelaySeconds` requires a whole number of seconds and
  **≤ `retryDelayMax` (1800)**; outside that range it returns `null` and the job
  falls back to `retryDelay: 1` with backoff — retrying almost immediately into
  another refusal. `pointsResetIn` can be up to 3600, so **the requested delay
  must be clamped to 1800** rather than passed through. A refusal with more than
  1800 seconds remaining therefore costs one extra attempt; at the second
  refusal the reset is necessarily within 1800.
- `retryLimit: 4` gives five attempts. Sustained exhaustion fails the run.
  That terminal state is safe: `failed` is in neither the `active` set nor
  `loadCompletedEvidence`'s `('complete','partial')`, so the character falls
  back to its previous evidence and a later read reserves a fresh run.

### The reserve threshold

`EVIDENCE_POINTS_RESERVE`, a worker config value, defaulting to **1500**
points.

**1500 is a guess and must be labelled as one in the config comment.** It is
derived only from the observation that ten runs exceeded 9000 points, so the
average run costs more than 900; 1500 is that floor plus headroom, chosen so a
run is refused rather than started and abandoned part-way. That floor says nothing about
the distribution, only the average. The
logged deltas are what replace the guess with evidence, and the threshold should
be revisited within a day of the first deployment rather than left to ossify —
`EVIDENCE_PARSE_REQUEST_CAP` sat diverged between Railway (12) and code (24)
until 2026-09-17 precisely because nothing forced that review.

### Limitation code

A new code, `points_budget_low`, distinct from `rate_limited`. "We declined to
start" and "upstream refused us" are different facts about different actors, and
conflating signals caused repeated misdiagnosis on 2026-09-17. Adding it touches
the enum in `packages/warcraftlogs/src/types.ts`, the contract enum in
`packages/contracts/src/dossier.ts`, and the reader-facing copy.

## Testing

- **Gateway** — `getRateLimit` parses a live-shaped response including a
  fractional `pointsSpentThisHour`; returns a limitation on transport failure.
- **Handler** — refuses and throws retryable with the reset-derived delay when
  remaining points are below the reserve; collects normally when above it;
  collects when `getRateLimit` itself fails; clamps a >1800s reset to 1800.
- **Queue** — a thrown refusal reschedules rather than failing the run
  (integration, against Postgres).

Each test must be confirmed red before its implementation, per the repo's TDD
practice.

## Out of scope

- **Mid-run checks.** Re-reading `rateLimitData` during a run would bound the
  damage a single expensive `zoneRankings` sweep can do. Deferred deliberately:
  the delta measurements from this change are what would show whether single-run
  overshoot is real. Revisit with data, not before.
- **`parse_schema_drift`**, still unexplained and recurring (#271); `rinn` and
  `riln` hit it again on 2026-09-17 with no retry time, leaving them stuck.
- **Staggering refresh dispatch**, which spreads load but cannot prevent
  exhaustion, and is largely redundant once admission is points-aware.
