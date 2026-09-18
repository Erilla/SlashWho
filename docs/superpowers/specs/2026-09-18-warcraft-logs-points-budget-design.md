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

**This is check-then-act, and it is only sound while runs are serial.** The
design assumed serial execution on the grounds that pg-boss `batchSize`
defaults to 1 and the worker awaits its handler. That was wrong: the evidence
queue also set `localConcurrency: 3`, so one worker ran three handlers at once.
#291 recorded the consequence — on 2026-09-18 three runs started within a
second, each read a near-full allowance before any had spent anything, all
three were admitted, and between them they spent the full 18000-point
allowance in eight minutes. The gate refused exactly one run, after most of
the allowance was gone.

The same overlap made the delta measurement unattributable: `pointsSpentByRun`
is a before/after difference, so concurrent runs charge their spend to each
other. Twelve deltas from that window summed to roughly 33,000 against an
18,000 allowance.

`localConcurrency` is now 1, which restores the assumption rather than
replacing the mechanism. Note that it is **per worker instance** — one instance
runs today, so this is sufficient, but horizontal scaling would reintroduce the
race across instances. A shared reservation is the answer at that point, and
not before: reserving requires predicting a run's cost, and Warcraft Logs holds
the truth about per-query cost.

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

`EVIDENCE_POINTS_RESERVE`, a worker config value, defaulting to **5000**
points. **This is measured, not guessed** — the derivation is below, and a
reader should be able to tell the two apart without archaeology.

It began at 1500, a labelled guess derived only from the observation that ten
runs exceeded 9000 points on 2026-09-17, so the average run costs more than
900; 1500 was that floor plus headroom, chosen so a run is refused rather than
started and abandoned part-way. That floor said nothing about the distribution,
only the average.

#295 settled it against the logged `pointsSpentByRun` deltas on 2026-09-18,
in the first window where they mean anything: #296 made runs serial, so a
before/after delta no longer charges overlapping runs to each other, and #293
stopped runs failing before they collected. Twenty-two deltas were logged
between 12:10 and 15:10; three read a character with nothing to fetch and cost
2, 22 and 31 points. The other nineteen collected:

| min | p25  | median | p75  | p90  | max  |
| --- | ---- | ------ | ---- | ---- | ---- |
| 862 | 1392 | 1609   | 2216 | 3627 | 4775 |

Three things follow.

**The old reserve was below the median.** Twelve of the nineteen cost more than
1500, so admission was approving runs that could not finish more often than it
was not — the exact failure the reserve exists to prevent. The suspicion
recorded in #291 is confirmed. 5000 covers the measured maximum.

**The spread is structural.** Spend tracks request volume at a steady 15–20
points each, and the history scan varies from 32 to 190 requests with how much
history a character has. A 5x range between characters is the normal case, not
noise, which is why a threshold has to be read off the tail rather than the
average.

**The share cap had become the real threshold.** `effectiveReserve` clips the
configured value to a share of the account's reported allowance; at 0.1 of the
worker's 18000 that was 1800, so any configured value above 1800 was inert.
The share moves to **0.3** in the same change, so 5000 reaches the gate intact
and a visitor's 3600 account keeps a 1080 reserve — about the least a
collection can cost.

#### Why the maximum, and not p75

Covering the maximum is the conservative reading and it is not free. A 5000
reserve against a median run of 1609 leaves up to 5000 points — a quarter of
the window, three median runs' worth — unspent while the sweep has already
stopped admitting. The window this was measured in ended at 16422 of 18000;
under the new reserve it would have stopped admitting around 13000.

The argument for the maximum is "never start what you cannot finish", and that
argument is weaker here than it first sounds, because an overrun is not wasted.
A run that exceeds the remaining allowance takes a 429, publishes what it has
as partial, and `mergeParseMetric` carries the work forward into the next
attempt. What an overrun actually costs is the `retry_after_at` deferral —
observed at up to about 32 minutes — not the points. So the real trade is
"refuse and do nothing" against "start, do a couple of thousand points of
useful work, and defer that character for half an hour". Read that way, p75
(2216) or p90 (3627) would admit considerably more work per window and pay the
deferral only sometimes.

The maximum is chosen anyway, for one window's data and deliberately for now.
The measurement is nineteen runs over three hours on one day, the tail is the
part of it least well characterised, and a first measured value has more to
lose from being too permissive than from being too cautious — the failure it
replaces was runs admitted that could not finish. **Revisit against p75/p90
once there is a wider sample, and in particular once #314's terminal marking
has had time to shrink runs**: the spread is driven by history-scan volume,
which is exactly what that change reduces, so the tail this value is sized
against should move.

#### Caveats

Every collection in the sample was truncated by `parse_request_cap`, so these
are capped costs and an uncapped run costs at least this much.

The code default and the Railway variable were set together, because
`EVIDENCE_PARSE_REQUEST_CAP` sat diverged between Railway (12) and code (24)
until 2026-09-17 precisely because nothing forced that second look.

Scaling the reserve to the reported allowance keeps a visitor's account from
being fenced off, but it does not make a visitor's dossier collectable. Their
3600 allowance is smaller than the 4775 an expensive run costs, so no reserve
setting reaches that case — the parse cap does, and it is applied flat
regardless of whose credentials are in play. Tracked in #320; the mechanism
`effectiveReserve` already uses is the one that is missing from the other knob.

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
