# Evidence-run phase checkpoints

Issue #431 adds a durable phase ledger for an evidence run. A phase records
only a stable step identifier, state, timestamps, and an optional limitation
code. It is operational progress, not evidence: it contains no provider body,
report code, cursor, credential, or provenance.

The ledger is not a general resumable checkpoint. A process that stops without
a known outcome leaves its latest `active` phase unchanged; that is truthful
about observed work and deliberately makes no promise that a subsequent worker
can resume it. A recognised cancellation or failure records `cancelled` or
`failed` on that phase instead.

The existing staged-evidence collection remains the only checkpoint that
protects correctness today: after a completed upstream collection it retains
the sanitised collection until publication can commit, so publication retries
do not re-spend the scan. General gateway cursors require provider-specific
correctness proofs and are deferred to a separately scoped follow-up.
