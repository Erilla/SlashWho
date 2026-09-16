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

Continuation rides the existing fingerprint-admission re-enqueue path rather
than introducing a job type. When a sweep is deferred today, the handler calls
`enqueueFingerprintAdmission(runId)` and the poller in
`apps/worker/src/runtime.ts:276` re-dispatches it. A continuation is the same
shape: the run stays alive, is re-admitted through the ordinary gate, and
resumes from a persisted cursor.

```
discoverFingerprintMatches(root, gateway, {..., resumeAfter})
  |- roster fetch, root fingerprint         (3 requests)
  |- candidates = sorted(roster) - root
  |- if resumeAfter: candidates.filter(id > resumeAfter)
  `- fingerprint each until cap
        |- exhausted  -> { kind: "matched", characters, requestsUsed }
        `- cap hit    -> { kind: "capped",  characters, requestsUsed,
                            resumeAfter: <last swept canonical id> }

handler:
  capped + resumeAfter present
    |- amendAndFinishFingerprintSweep(snapshotId, characters, cursor)
    |- release reservation
    `- enqueueFingerprintAdmission(runId)
  matched (roster exhausted)
    `- amend and seal: cursor cleared
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
- **A dedicated continuation job type.** The admission re-enqueue path already
  carries this.
- **`FINGERPRINT_MAX_CONTINUATIONS`.** The 30-minute run lifetime
  (`discovery-job-handler.ts:225`) already bounds the chain. A guild large enough
  to exhaust it produces a visible, retryable truncation instead of today's
  silent permanent loss.
- **Sibling traversal in Raider.IO discovery.** `discovery.ts` reaching alts that
  declare a common main is a separate gap with its own trade-offs. This design
  reaches `yawners` through the fingerprint path instead.
