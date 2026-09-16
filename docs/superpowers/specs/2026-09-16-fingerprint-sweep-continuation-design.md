# Fingerprint sweep continuation

**Date:** 2026-09-16
**Status:** Approved for planning

## Problem

A fingerprint sweep abandons every roster candidate past `BLIZZARD_SWEEP_REQUEST_CAP` and never returns to them. Because `discoverFingerprintMatches` sorts candidates by `canonicalCharacterId` for determinism, the abandoned set is always the same alphabetical tail. In any guild larger than the cap, those members are permanently undiscoverable: re-running the sweep restarts at the same first candidate and stops at the same wall.

### Observed failure

The dossier for `eu/silvermoon/yawnersw` does not discover `eu/draenor/yawners`, although the two are the same player.

Measured against the live Blizzard and Raider.IO APIs on 2026-09-16:

```
Rancour-Draenor roster (Blizzard):  396 members
candidates (roster minus root):     395
cap reaches candidate:              #296-297
eu/draenor/yawners:                 #310
eu/draenor/yawnersowo:              #311
```

The fingerprint itself is not the problem. Both alts match comfortably against the root:

```
achievements silvermoon/yawnersw:  3109 entries
achievements draenor/yawners:      3112 entries
  common=3109  identical=977   pct=31.4  => MATCH  (thresholds: 200 / 20%)
achievements draenor/yawnersowo:   3112 entries
  common=3109  identical=1669  pct=53.7  => MATCH
```

Both alts sit in the dead zone, which is why the published snapshot carries zero
`fingerprint`-sourced characters. `yawnersowo` appears only because Raider.IO's
`main_character` edge reaches it independently; `yawners` has no such edge,
because declared-main traversal in `discovery.ts` walks child to main and never
main to siblings.

Request accounting: `onProfileRequest` fires once per Blizzard HTTP call
(`packages/blizzard/src/client.ts:278`), so a sweep spends 3-4 requests on
overhead (root profile, playable-class index when cold, roster, root
fingerprint) before the first candidate. A candidate with no achievement profile
still consumes its request: `recordProfileRequest` fires before the HTTP call and
the 404 `continue` in `fingerprint-discovery.ts:288` does not refund it.

## Goal

A sweep that hits the cap resumes where it stopped instead of abandoning the
tail, so every roster candidate is eventually fingerprinted.

## Design

### Mechanism

Continuation rides the existing fingerprint-admission re-enqueue path and the
existing discovery queue. When a sweep is deferred today, the handler calls
`enqueueFingerprintAdmission(runId)` and the poller in
`apps/worker/src/runtime.ts:276` re-dispatches an ordinary discovery job for
that run.

That path cannot be reused unchanged. Publishing in cycle 1 completes the run
(`createSnapshot` sets `discovery_runs.status = 'complete'`,
`postgres-repositories.ts:1340`), and `execute()` returns immediately for a
completed run (`discovery-job-handler.ts:274`), so a re-dispatched cycle 2 would
silently do nothing. The existing deferral only works because it returns
*before* publishing, keeping the run active across the gap.

Leaving the run active until the chain seals was rejected: `getCurrent` requires
`run.status = 'complete'` (`postgres-repositories.ts:1400`), so the dossier would
show nothing until the whole roster was swept, which is the deferred-publication
behaviour this design exists to avoid.

Instead the job payload marks the continuation. `DiscoverCharacterJob` gains one
optional field, and `execute()` branches on it before the completed-run guard:

```ts
type DiscoverCharacterJob = {
  runId: string;
  key: CharacterKey;
  enqueuedAt: string;
  continuation?: true;          // new
};
```

A continuation skips the completed-run guard and skips `discoverCharacter`
entirely, going straight to the sweep with the stored cursor. Skipping
re-discovery is not merely an optimisation: re-running the full Raider.IO sweep
each cycle would burn budget and race the amend.

```
discoverFingerprintMatches(root, gateway, {..., resumeAfter})
  |- roster fetch, root fingerprint         (3 requests)
  |- candidates = sorted(roster) - root
  |- if resumeAfter: candidates.filter(id > resumeAfter)
  `- fingerprint each until cap
        |- exhausted  -> { kind: "matched", characters, requestsUsed }
        `- cap hit    -> { kind: "capped",  characters, requestsUsed,
                            resumeAfter: <last swept canonical id> }

handler execute(runId, ctx, job):
  job.continuation
    |- skip completed-run guard, skip discoverCharacter
    `- load cursor from fingerprint_sweep_states, sweep, amend

  sweep capped, resumeAfter present
    |- cycle 1: createAndFinishFingerprintSweep (publishes, completes run)
    |  cycle n: amendAndFinishFingerprintSweep(snapshotId, characters, cursor)
    |- persist cursor + resume_snapshot_id
    `- enqueueFingerprintAdmission(runId)   -> dispatches with continuation: true
  sweep matched (roster exhausted)
    `- publish or amend, then seal: cursor cleared
```

Cycle 1 publishes the snapshot exactly as it does today, so the dossier is not
held back waiting for the tail. Cycles 2..n amend that snapshot in place and
re-enter the same admission gate, so the hourly budget still throttles the chain.

### Snapshot semantics

Continuations amend the snapshot published by cycle 1 rather than superseding
it. This trades the internal immutability convention for a stable dossier
identity across the chain. The trade is safe today: `listHistory` and
snapshot-by-id exist in the repository layer but are not reachable from any web
route or contract, so no shared URL's content changes under a reader.

### Cursor

The cursor is the `canonicalCharacterId` of the last candidate that consumed a
request, including 404s and non-matches: those candidates are swept, merely not
matched. Because `compareCandidates` already sorts by that key, the cursor is
stable under roster churn. A member who joins ahead of the cursor is missed on
this pass; one who joins behind it is picked up. An integer offset was rejected:
a single departure ahead of the offset silently skips a candidate, reproducing
the class of bug being fixed.

### Per-cycle overhead

Each cycle re-fetches root profile, roster, and root fingerprint (3 requests;
class names are process-cached). For Rancour that is 6 requests across 2 cycles.
The cost buys self-contained cycles that stay correct under roster churn.
Caching the root fingerprint across cycles is deliberately not done: it saves one
request per cycle and adds staleness handling.

## Interfaces

### Domain

`packages/domain/src/fingerprint-discovery.ts`:

```ts
export type DiscoverFingerprintMatchesOptions = {
  ...
  resumeAfter?: string;          // canonicalCharacterId of last swept candidate
};

// capped gains the cursor; matched means the roster was exhausted
| { kind: "capped"; characters; requestsUsed; resumeAfter?: string }
```

Resumption is one filter applied after the existing sort.

`resumeAfter` is optional on `capped` because the budget can be exhausted before
any candidate is swept: the roster fetch and the root fingerprint each return
`capped` with nothing swept. A `capped` outcome with no cursor leaves the stored
cursor unchanged, so the next cycle retries the same range rather than skipping
it.

### Queue

`packages/database/src/queue.ts`. `DiscoverCharacterJob` gains `continuation?:
true`. The singleton key must change: it is currently `payload.runId`
(`queue.ts:249`), so a continuation would collide with the completed cycle-1 job
for the same run and be dropped. It becomes `runId` for an ordinary job and
`${runId}:continuation` for a continuation, keeping the existing dedupe
behaviour within each kind.

`dispatchAdmittedFingerprintRun` (`apps/worker/src/runtime.ts:265`) sets
`continuation: true` when the run's sweep state carries a cursor.

### Schema

`packages/database/drizzle/0018_fingerprint_sweep_cursor.sql`, extending
`fingerprint_sweep_states` (already keyed by root character, already holding
`lastPublishedAt`):

```sql
ALTER TABLE fingerprint_sweep_states
  ADD COLUMN resume_after       text,
  ADD COLUMN resume_snapshot_id uuid REFERENCES snapshots(id) ON DELETE SET NULL;
```

`resume_snapshot_id` identifies the snapshot a continuation amends.
`ON DELETE SET NULL` degrades a continuation into a no-op rather than an FK
error if the snapshot is reaped.

### Repository

`packages/database/src/repositories.ts`, mirroring the existing
`createAndFinishFingerprintSweep`:

```ts
amendAndFinishFingerprintSweep(
  snapshotId: string,
  characters: SnapshotCharacterInput[],     // appended, deduplicated
  fingerprint: { reservationId; finishedAt; limitationCode: string | null },
  cursor: { resumeAfter: string | null },   // null seals the sweep
  options?: { signal?: AbortSignal }
): Promise<StoredSnapshot>;
```

One transaction, matching the atomicity contract of the existing create-and-finish
call, so a crash mid-cycle cannot leave the reservation finished with the
characters unwritten.

## Edge cases

| Case | Behaviour |
|---|---|
| Root leaves the guild mid-chain | Roster fetch returns `[]` or a different guild; seal the sweep and clear the cursor. Not an error. |
| Cursor points past the end of a shrunken roster | Filter yields no candidates; seal. |
| Fresh refresh requested for the root | New run, new snapshot, cursor reset. The in-flight continuation finds `resume_snapshot_id` superseded and is discarded rather than amending a stale snapshot. |
| `maxJobLifetimeMs` reached mid-chain | Existing behaviour: the run fails and is retryable. The cursor persists, so a retry resumes rather than restarting. |
| Continuation admitted but budget exhausted | Existing `waiting` path; cursor untouched. |
| Budget exhausted before the first candidate | `capped` with no `resumeAfter`; cursor left unchanged so the next cycle retries the same range. |
| Continuation dispatched for a run with no cursor | Sweep state carries no `resume_after`; dispatch omits `continuation`, and the completed-run guard makes it a no-op as today. |
| Continuation job enqueued twice | Singleton key `${runId}:continuation` dedupes it, as `runId` does for ordinary jobs. |

## Testing

Test-driven, following the existing suites.

- `packages/domain/src/fingerprint-discovery.test.ts` — a cap hit returns
  `resumeAfter` at the last swept candidate; `resumeAfter` skips exactly the
  swept prefix; a cursor past the roster end yields `matched` with no matches; a
  404 candidate still advances the cursor.
- `packages/application/src/discovery-job-handler.test.ts` — a capped sweep
  amends and re-enqueues without sealing; an exhausted sweep seals with the
  cursor cleared; a two-cycle chain over a 400-member fake roster surfaces a
  match found only in cycle 2, as a regression test for the Yawners case.
- `tests/integration/migrations.test.ts` — pin `0018`.
- `tests/integration/repositories.test.ts` — `amendAndFinishFingerprintSweep`
  appends and deduplicates, and rolls back wholly on failure.

## Out of scope

- **Candidate ordering.** Once the tail is always eventually swept, alphabetical
  ordering stops being a defect and becomes the property that makes the cursor
  stable. No change.
- **Root fingerprint caching across cycles.** See per-cycle overhead above.
- **A dedicated continuation queue or run lifecycle.** The existing discovery
  queue and admission re-enqueue path carry this, with one optional payload flag
  and a scoped singleton key. Giving continuations their own discovery run was
  considered and rejected as a second run/snapshot relationship to maintain.
- **`FINGERPRINT_MAX_CONTINUATIONS`.** The 30-minute run lifetime
  (`discovery-job-handler.ts:225`) already bounds the chain. A guild large enough
  to exhaust it produces a visible, retryable truncation instead of today's
  silent permanent loss.
- **Sibling traversal in Raider.IO discovery.** `discovery.ts` reaching alts that
  declare a common main is a separate gap with its own trade-offs. This design
  reaches `yawners` through the fingerprint path instead.
