# Issue #771: fingerprint resumption delivery and claim sequencing

Status: revised after manager review; awaiting approval before implementation.

Issue: https://github.com/Erilla/SlashWho/issues/771

Branch: `fix/771-fingerprint-resumption`, based on fresh `origin/main`
at `d3a0af4d`.

## Required behaviour

An ordinary discovery run deferred for fingerprint admission must eventually
execute after either an admitted or a not-due settlement, even when its original
delivery is still active at settlement or the worker restarts. A deferral at
attempt 2 or later must remain claimable through a fresh queue job. Duplicate
dispatches must produce one effective resumed delivery. Completed sweep
continuations must keep their completed run and amend their existing snapshot.

## Evidence and reproduction first

Source inspection confirms that discovery enqueue deduplicates against active
jobs, the dispatcher marks admission dispatched after that enqueue, deferral
decrements the durable attempt, and a fresh queue job supplies attempt 1. These
are candidate causes, not yet reproduced failures.

Before changing production code, add and run Docker-backed regressions using
the real PostgreSQL repositories, pg-boss queue and discovery handler:

1. Hold the original delivery at an explicit promise barrier after deferral;
   settle admission while that delivery remains active; release the barrier;
   assert that the run completes with exactly one effective resumed execution.
   Cover both admitted and not-due outcomes, repeated dispatch and concurrent
   dispatchers. Use barriers rather than timing sleeps to establish the race.
2. Reach discovery attempt 2 through a controlled retry, defer for budget, then
   resume through a fresh job. Assert a successful claim and publication rather
   than merely a successful queue delivery. Extend to a later attempt and a
   further retry of the resumed job.
3. Restart between settlement and enqueue, and between enqueue and recording
   dispatch. Recover both settlement outcomes without a dossier read. Check
   completed continuation dispatch separately, including successive cycles.
4. Lose dispatch recording for admission A, allow A's delivery to execute,
   advance the durable attempt, defer into admission B and become terminal.
   Recover/recreate A after B exists. Assert A cannot claim B's run, consume B's
   reservation, change either baseline or reset its delivery retry allowance.
   Include replay while B is waiting and after B is admitted.
5. For a completed sweep chain, let continuation A finish and become terminal,
   admit B, then replay A through a fresh queue job. Assert no extra provider
   reads, request events, budget consumption, cursor writes or snapshot changes.
   Also replay a terminal delivery for an admission with no successor yet, to
   ensure the execution fence does not depend solely on finding a newer row.

Capture the expected failing assertions before selecting the final fix. If the
regressions disprove the reported cause, revise this plan before implementation.

## Proposed fix, contingent on the regressions

Use the durable admission row ID as the identity of a resumption delivery.
Expose the settled admission's dispatch descriptor from the repository, with
its ID and an immutable admission-bound attempt baseline. Send resumed jobs under a
singleton key specific to that admission. The original delivery and its
successor then have different keys, while repeated dispatches for the same
admission still deduplicate, including after restart. Keep ordinary discovery
enqueue keys and evidence queue semantics unchanged. Avoid random keys and
timestamp keys, which cannot support repeatable recovery.

### Immutable sequencing and execution fence

Stop decrementing the durable attempt on ordinary discovery deferral. Persist
the baseline once when the waiting admission is created, in the same transaction
as deferral; settlement and recovery read that stored value and never derive a
replacement from the run's current attempt. Each new admission captures its own
baseline. Dispatch descriptors and job payloads carry admission identity;
execution validates their values against the database rather than trusting an
arbitrary payload baseline.

Add durable admission execution metadata: immutable baseline, first executing
queue job ID, highest accepted delivery attempt, and consumption state. Pass the
real pg-boss job ID through the delivery context. At execution entry, atomically
validate that this is the current admission for the run, it is settled and still
executable, and its reservation (if admitted) is the exact live reservation for
that admission. Bind the first executing job ID once. Retries must carry that
same job ID with a higher delivery attempt within the original retry limit;
a recreated terminal job cannot bind again or restart its retry allowance.

For ordinary resumptions, combine this fence and the durable run claim in one
transaction under the existing fingerprint lock and a consistent run/admission
lock order. The durable attempt is stored baseline plus delivery attempt. Queue
retry allowance and back-off use delivery attempt, while claim sequencing and
run persistence use durable attempt. Duplicate deliveries or obsolete admission
IDs return without provider calls or durable state changes.

For completed continuations, use the same admission execution fence before any
provider work while preserving the completed-run claim bypass. Pass the admitted
reservation identity through the handler instead of looking up whichever latest
reservation happens to exist. Publication, release and successor creation must
validate admission identity and execution ownership atomically; publication or
deferral consumes A before B becomes current. Existing run/snapshot ownership
guards remain additional checks, not substitutes for cycle ownership. These
checks prevent a delayed A from publishing into B even if A passed an earlier
read-only check. A stale job must not release B's reservation in its cleanup path.

Payloads without admission identity retain the legacy delivery path for jobs
already in flight. They cannot act as newly identified admission deliveries or
borrow a newer cycle's reservation: legacy continuation handling must bind to
its own unconsumed admission through the same atomic entry fence. If historical
state cannot identify that cycle safely, reject the legacy continuation and let
durable backlog/stranded-chain recovery enqueue an identified successor. Cover
this deployment transition in integration tests rather than assuming old jobs
can safely skip the new fence.

Extend pending admission dispatch selection and dispatch recording to include
not-due settlements, with appropriate run-state filtering so historical rows
and completed ordinary runs are not revived. Record dispatch for the specific
admission, not every row for a run. On restart, the same admission ID identifies
the same resumed job while it remains runnable. Once terminal, the durable
execution fence prevents a recreated job from executing again; singleton keys
alone do not provide that guarantee. Exclude consumed/superseded admissions
from recovery and mark dispatch only for the matching descriptor, without
modifying a successor admission.

A schema migration is expected for immutable baselines and durable execution
metadata. Backfill undispatched historical admissions conservatively under the
same locks before issuing identified jobs; do not invent a baseline for an
already consumed cycle. Specify the exact backfill from the reproduced fixtures
and review its compatibility before implementation. Preserve the existing
admission IDs and dispatch timestamps where their semantics remain valid.

Alternative: refuse deduplication onto active predecessor jobs and retry
admission dispatch until they settle. This avoids a new queue key but requires
careful admitted/not-due retry recovery and a startup drain that cannot spin on
blocked rows. Prefer admission-specific delivery identity because it represents
the successor explicitly and remains recoverable across crashes.

## Verification and hand-off

Run focused queue, worker and discovery unit tests plus Docker-backed recovery
regressions, then the complete required gate: `format:check`, `lint`,
`typecheck`, `test:unit`, `test:integration`, `build`, `test:e2e`, always through
`corepack pnpm`. Docker is available at planning time (server 29.8.0).

Review the implementation against `origin/main`, fetch and merge current
`origin/main`, and repeat the required gate. Update this draft into the linked
implementation PR only after those checks pass. Do not enable auto-merge;
the manager decides.

## Manager decisions requested

- Admission-specific singleton identity was preferred in the first review.
  Confirm the immutable baseline and first-executing-job binding close terminal
  replay without resetting retry allowance.
- Check atomic current-admission/consumption fencing for both ordinary runs and
  completed continuation cycles, including guarded cleanup and publication.
- Check both added terminal replay regressions, the schema migration/backfill
  requirement and the conservative legacy payload transition.
