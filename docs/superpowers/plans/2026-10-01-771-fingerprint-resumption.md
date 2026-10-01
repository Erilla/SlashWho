# Issue #771: fingerprint resumption delivery and claim sequencing

Status: proposed; awaiting manager review before implementation.

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

Capture the expected failing assertions before selecting the final fix. If the
regressions disprove the reported cause, revise this plan before implementation.

## Proposed fix, contingent on the regressions

Use the durable admission row ID as the identity of a resumption delivery.
Expose the settled admission's dispatch descriptor from the repository, with
its ID and the run's durable attempt baseline. Send resumed jobs under a
singleton key specific to that admission. The original delivery and its
successor then have different keys, while repeated dispatches for the same
admission still deduplicate, including after restart. Keep ordinary discovery
enqueue keys and evidence queue semantics unchanged. Avoid random keys and
timestamp keys, which cannot support repeatable recovery.

Stop decrementing the durable attempt on ordinary discovery deferral. Carry
an optional attempt baseline on resumed discovery payloads and translate queue
retry count into a strictly increasing durable claim attempt. Keep the queue's
retry allowance separate from the accumulated durable claim sequence: resumed
jobs must not accidentally exhaust their retries because earlier deliveries
already consumed attempt numbers. Payloads without the field retain existing
behaviour, so deployed jobs remain valid. Completed continuations retain their
existing claim bypass and snapshot ownership checks.

Extend pending admission dispatch selection and dispatch recording to include
not-due settlements, with appropriate run-state filtering so historical rows
and completed ordinary runs are not revived. Record dispatch for the specific
admission, not every row for a run. On restart, the same admission ID identifies
the same resumed job, closing the enqueue/record crash window without weakening
singleton deduplication. Reuse existing admission IDs and `dispatched_at` if
possible; no schema migration is currently expected.

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

- Approve admission-specific singleton identity versus retrying dispatch until
  the predecessor settles.
- Check the split between durable claim sequencing and per-delivery retry
  allowance, including compatibility with jobs already in flight.
- Check recovery of not-due rows and the crash windows around dispatch recording.
