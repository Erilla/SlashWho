# Issue #771: fingerprint resumption delivery and claim sequencing

Status: metadata/backfill checkpoint approved by the manager at b5701ee9;
implementation and regression coverage complete, full gate and review in progress.

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

## Reproduction results and concrete compatibility checkpoint

The manager approved reproduction at `685631de`. The initial Docker-backed run
reproduced all six original failures: both active-delivery settlement races and
deferrals at attempts 2 and 3 for both outcomes leave the run `queued`. For the
attempt cases, the successor queue job itself reaches `completed` without
completing discovery. Seven existing continuation tests still pass. The added
terminal continuation replay test fails because it reads `memberg`, `memberh`
and `memberi` after A is complete and B admitted. The ordinary obsolete-admission
probe supplies explicit durable contexts to the real handler and shows the run
attempt changing from 1 to 2; this is a design probe, not yet the full two-cycle
queue crash regression. That full regression remains required once the offset
and delivery identity APIs exist, before calling the implementation complete.

Commands: `corepack pnpm test:integration
tests/integration/fingerprint-resumption.test.ts
tests/integration/fingerprint-continuation-retry.test.ts` (eight expected failures,
seven passes); `corepack pnpm exec tsc -p tsconfig.tools.json --pretty false`.
The tests are intentionally red at this stage; no full passing gate is claimed.

The branch has now merged current `origin/main` at `26f54d32`. Its #773 payload
allow-list must explicitly permit the new admission ID and baseline fields;
arbitrary extra fields remain excluded. Legacy jobs and jobs without admission
identity must not silently borrow a newer admission. Re-run the reproductions
on this merged base before publishing this checkpoint.

### Schema and immutable values

Add nullable `attempt_base` (non-negative integer), `dispatch_kind` (ordinary or
continuation), `execution_job_id` (UUID), `execution_attempt` (non-negative
integer, initially 0), `execution_max_attempts` (positive integer),
`execution_token` (UUID), and `consumed_at` (timestamp) on admission rows.
Null baseline/kind identify pre-upgrade rows, not a permission to recompute an
already initialised row. Persist baseline, kind and retry allowance once, under
the fingerprint lock when a new admission is created. All descriptor reads,
retries and recovery use these stored values. Baseline/kind/allowance writes
are insert-only except the one-time legacy initialisation described below.
Test immutability via repeated settlement and recovery after run attempts move.

Entry takes root lock, fingerprint lock, then run/admission row locks in that
order, matching the existing snapshot transaction order. Choose current cycle
by greatest `queue_order` for the run, not timestamps. Validate admission ID,
unconsumed state, exact reservation and run/snapshot ownership, bind the first
executing job ID and update the highest accepted delivery attempt plus a fresh
execution token atomically with the ordinary run claim. A retry of that same job
must have a strictly higher delivery attempt within its persisted allowance.
An older token cannot publish, release or create a successor. Every state
transition out of A consumes A before B becomes visible in the same transaction.
Do not hold transaction locks across provider requests.

When a bound delivery is terminal without a recorded successful settlement,
never redispatch that admission as a new job. Reconcile it using the recorded
queue state and existing bounded failure policy: retire/release only its own
reservation, fail an exhausted ordinary run, or queue a fresh continuation
admission through the existing non-progress/back-off bound. Successful consumed
rows and superseded rows are excluded from backlog scans. Cover both terminal
success and terminal failure, including the case with no successor yet.

### Legacy transition and backfill

The DDL only adds metadata; it does not infer that an old admission executed
from `dispatched_at`, since that timestamp can be absent after a successful send
or present after deduplication onto the wrong active delivery. Historical ended
admissions (finished/released) and all but the highest `queue_order` per run are
non-executable under the new entry fence. No historical baseline is invented.

Before new worker delivery registration, initialise actionable legacy rows once
in a recovery transaction using root-then-fingerprint lock ordering. For the
latest waiting/admitted/not-due ordinary admission on an active run, capture
the maximum of the current stored run attempt and the delivered attempt
(`retry_count + 1`) of its linked legacy ordinary job if that job is retained
and has actually been delivered. Read this before cancelling the job, persist
the value once, and never recompute it on recovery. If the job has been archived,
the stored run attempt is the available durable lower bound: the next claim
still strictly exceeds it. This handles old attempt-2 deferral rows whose
stored attempt is 1 without discarding retained queue history. For a completed
run, initialise only an admitted/waiting
continuation whose live cursor and snapshot belong to that run; never return
the run to an active status. Completed ordinary runs and failed runs are
non-actionable. Expired/released continuation reservations go through existing
stranded-chain recovery to a fresh admission, rather than being revived.

Under those same locks, cancel created/retry/active legacy discovery jobs for
these actionable fingerprint runs and replace their deliveries with identified
jobs. Reset a legacy ordinary run left `running` to `queued` while preserving
its stored attempt; preserve cursor, snapshot, waiting priority and live budget
reservation. Clear only the matching legacy admission's dispatch marker so
admitted/not-due recovery can enqueue it. Waiting rows stay admission-gated.
Leave unrelated discovery and evidence jobs alone. Repeated startup is
idempotent: rows with an initialised baseline are not backfilled again, and
identified deliveries retain their execution binding and retry allowance.

**Deployment prerequisite:** old workers must be drained/stopped before this
transition, with only new workers starting afterwards. An old binary ignores
admission metadata and can otherwise still publish through its unguarded
continuation path; cancelling an active queue row cannot stop its provider work.
Do not claim mixed-version rolling-worker safety. This is a proposed deployment
requirement for manager review, not a production action authorised or performed
in this task. If uninterrupted mixed-worker operation is required, revise the
design with database-enforced write fencing before coding.

Legacy unbound payloads encountered after transition are rejected for
fingerprint-associated runs and recovered through the identified backlog. Keep
the old payload path for unrelated ordinary discovery jobs. Test upgrade
fixtures with each actionable status, attempt-2 legacy deferral, completed
cursor, active legacy job, multiple historical admissions, repeated startup,
and restart between cancellation, initialisation and replacement enqueue.

### Approval requested

Review the exact metadata/backfill above and the stop-old/start-new worker
transition. After approval, implement test-first, replace the ordinary design
probe with the full pg-boss A-to-B lost-dispatch-recording regression, add the
remaining crash/retry/upgrade fixtures, then run the full gate and self-review.
No production code changes should precede this checkpoint's approval.
