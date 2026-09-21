# Issue #387: Regnitrap's two-character dossier

## Outcome

The two-character result is an incorrect partial discovery outcome, not a
complete bounded result. A fingerprint sweep had already found 20 additional
fingerprint-derived characters for the same root. Its continuation was never
started. A later ordinary refresh then skipped another fingerprint admission
because the seven-day cadence was still active and published a fresh snapshot
containing only the two Raider.IO-derived members.

This diagnosis does **not** change collection behaviour. It requires a
separately scoped implementation follow-up.

## Reproduction

```text
corepack pnpm tsx scripts/diagnostics/issue-387-regnitrap-repro.mts
```

The script makes only these two read-only requests to the supplied test
deployment:

```text
GET /api/dossiers/jobs/f56e76af-1405-43e0-bb7b-093a2411909d
GET /api/dossiers/eu/draenor/regnitrap
```

It fails when the fixed completed job's dossier has exactly two characters. On
2026-09-21, two consecutive invocations both exited `1` and reported:

```text
jobStatus=complete
characterCount=2
characters=regnitrap, shortrageni
researchState=partial
researchMessage=Raider.IO shows no public account claim for this character...
ISSUE-387 REPRODUCED: expected discovery to reach more than two characters
```

The job id and GET-only API make this agent-runnable and free of collection
side effects. It is deterministic for the immutable completed job while the
test deployment retains its current snapshot; a later refresh can legitimately
replace that snapshot, so the script intentionally fails loudly rather than
silently treating a changed deployment as the same evidence.

## Evidence

All database inspection below used read-only queries from the test worker over
the private Railway network. No credential values, raw provider responses, or
private account identifiers were read or retained.

| Observation                  | Result                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linked job                   | Completed in about one second on 2026-09-21; its snapshot is `partial` with `privacy_hidden` and two members.                                                                                                                                                                              |
| Current members              | `regnitrap` (`input`) and `shortrageni` (`declared_main`).                                                                                                                                                                                                                                 |
| Worker configuration         | Blizzard credentials were configured; the fingerprint path was available. The deployed code was `2bdd8a4d` (`origin/main`).                                                                                                                                                                |
| Earlier fingerprint snapshot | Published on 2026-09-19 with 22 members: 1 input, 1 declared-main, and **20 fingerprint-derived**.                                                                                                                                                                                         |
| Earlier sweep                | Spent its 300-request reservation, published `fingerprint_sweep_capped`, and persisted a non-null continuation cursor carrying the original `privacy_hidden` limitation.                                                                                                                   |
| Continuation queue           | Exactly one `fingerprint-admission` job was created after that capped sweep. It completed immediately, but no continuation `discover-character` job was created.                                                                                                                           |
| New job's admission          | There is no new admission record for the 2026-09-21 job. The cadence check considered the 2026-09-19 publication recent enough (the configured default is seven days), returned `not_due`, and normal snapshot publication replaced the 22-member snapshot with the two Raider.IO members. |

The public response's privacy-hidden message is therefore honest but
incomplete: it describes the Raider.IO ownership limitation, not the loss of
the already discovered fingerprint memberships.

## Root cause

When a fingerprint sweep caps, the discovery handler finishes its admission
and writes a cursor, then only calls `enqueueFingerprintAdmission(runId)`.
Finishing the reservation changes that admission's status to `finished`. The
queued admission worker subsequently calls `admitWaiting(runId)`, which looks
only for a `waiting` admission. It finds none, returns `settled`, and dispatches
no continuation.

The relevant paths are:

- [`packages/application/src/discovery-job-handler.ts`](../../packages/application/src/discovery-job-handler.ts): the capped-sweep path writes the cursor and queues an admission follow-up.
- [`packages/database/src/postgres-repositories.ts`](../../packages/database/src/postgres-repositories.ts): finishing a reservation marks its admission `finished`; `admitWaiting` accepts only `waiting` rows.
- [`apps/worker/src/runtime.ts`](../../apps/worker/src/runtime.ts): a follow-up dispatch happens only when `admitWaiting` returns `admitted`.

The persisted cursor survives, but it points at the older snapshot. A fresh
run does not own that cursor; its cadence-gated no-op fingerprint pass then
publishes a new two-member snapshot. That accounts for every observed state
without attributing the result to an upstream account claim, reverse-declared
main lookup, or missing Blizzard credentials.

## Hypotheses tested

1. **Expected privacy-hidden bounded result — disproved.** The earlier snapshot
   contained 20 valid fingerprint matches, so two members are not the known
   bounded set.
2. **Privacy-hidden skips fingerprint discovery — disproved.** The worker had
   Blizzard credentials and the 19 September run successfully made 300
   fingerprint requests and published its matches.
3. **Continuation lost after a capped sweep — confirmed.** The cursor remained
   while its only follow-up admission job settled without creating a continuation
   delivery. The admission state transition above explains why.
4. **Known reverse declaration omitted — not causal.** The direct declared-main
   relationship is present as `shortrageni`; the 20 missing members are from
   fingerprint discovery.
5. **Job/snapshot mismatch — disproved.** The linked job, root, completion time,
   and current two-member snapshot join directly in storage.

## Follow-up scope

Create a focused fix issue to make a capped fingerprint sweep create or retain
a **new waiting admission** for its persisted cursor, then dispatch the owning
run as a continuation. Its regression test should reproduce this lifecycle:

1. admit and cap a first sweep;
2. publish its cursor and fingerprint members;
3. process the queued admission follow-up;
4. assert that a continuation delivery is created and can amend the original
   snapshot;
5. assert that a fresh cadence-gated run cannot replace those memberships with
   only its Raider.IO result while that cursor remains live.

The existing remote probe should become green only after the test deployment
has been deliberately recollected; it is not a substitute for the deterministic
local regression test above.
