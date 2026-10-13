# Issue #819: lock-free, set-based dossier evidence reads

Status: proposed for Manager review. Refs #819 and #789. Implementation waits
for both plan approval and the reviewed merge of #906; do not merge this draft
as a completed fix.

## Outcome and dependency

Fresh dossier evidence should use one consistent read transaction and a fixed
number of set-based statements, regardless of subject or Warcraft Logs alias
count. Only keys needing reservation or other durable changes take the existing
locked path. Preserve evidence, scheduling, collection policy and HTTP no-store.
No migrations, provider calls, budgets or database configuration changes.

The worktree started at origin/main d6597a80. The historical reserve/roster
round trips still exist there. #906, reviewed at 028495f58e48fc044f5ea68ff76792124e4e16e3,
adds reserveForScheduling, immutable CompletedEvidenceSelection and deferred
hydrateCompletedEvidence. Rebase the design onto its actual merged result before
coding. Reuse that seam and its scheduling decision engine; do not add a second
reservation implementation or restore late markLightRefresh.

## Repository boundary and read algorithm

1. Add an optional batched dossier-read capability to EvidenceRepository, with
   typed character-key inputs and per-key results. Keep SQL, Queryable, locks,
   suppression and publication selection inside the database package. In-memory
   repositories without the capability retain their current behaviour. Deduplicate
   subject and WCL alias keys by the existing canonical identity, then distribute
   results back to their original subject/alias positions.
2. In one withConsistentRead (REPEATABLE READ READ ONLY), select latest published
   any-scope and full-scope runs for all keys. Preserve current completed_at DESC,
   id DESC ordering, including null completion and the targeted-only fallback.
   Read pending alias recollections, active runs and ranked-continuation state
   set-wise. Extract the existing pure freshness decision so both this reader and
   locked reserve use identical version, completion, alias, continuation and
   isEvidenceFresh checks. Freeze the request's evaluation time/cutoff.
3. Hydrate fresh selections in this snapshot with ANY(run ids): kills, wipes,
   tier bests and Raider.IO first kills from snapshotRunId; Cutting Edge and
   Blizzard phase from the selected full publication. Load distinct logged
   encounters once, shown members once with the existing suppression NOT EXISTS,
   and role totals once. Role totals still count the same complete roster as
   today's query, including members omitted by suppression from the shown roster.
   Reuse mapping helpers and preserve each collection's current ordering and
   available zero/unavailable/not_applicable states.
4. Include batched historic aliases for subjects and excluded subjects, and
   phases for selected active runs, in the read capability. This removes the
   per-character historicAliases/listPhases tail; these are evidence reads, not
   a reason to add locks. Return active and tierSearchResumesAt exactly as reserve
   does today. Published-run predicates exclude queued/running/retrying runs.
5. Return fallback keys without pretending their unlocked metadata authorises
   a write. Release the consistent-read client before taking any write locks or
   calling queue APIs. For those keys call #906 reserveForScheduling, which
   rechecks every predicate under its existing lock and runs its transaction-bound
   preparation callback before inserting a full run. That callback remains read
   only, uses only the supplied scheduling reads, and never retains that view or
   calls providers/queues/another pooled repository.
6. Preserve #906's root admission barrier: schedule and enqueue the opened/root
   character before admitting member fallback work. Do not hydrate a stale root's
   full payload before that barrier. Bound remaining locked fallbacks at four
   concurrent keys using the existing concurrency facility. Batch hydration of
   the immutable selections returned by locked reservations in a subsequent
   consistent read; do not reselect newer publications. This second transaction
   is needed only on the mixed/stale path. A fresh read uses one transaction.

Fresh evidence can coexist with an active run. Preserve #906 queue promotion,
missing-job repair and progress reporting. Ordinary all-fresh reads with no
active repair need no database write transaction or advisory lock. Fresh keys
with an active job still read evidence lock-free, but queue promotion/repair can
write queue state (and markEnqueued for a missing job). Manager should confirm
this necessary qualification of the issue's literal all-fresh/no-writes criterion;
removing that behaviour would regress #844. No fresh key runs locked reserve
solely to hydrate evidence.

## Instrumentation and baseline before optimisation

First expose the roster load as a named measured read while retaining the
current per-key algorithm. Keep the existing consistent/locked client: do not
split roster loading onto a separately acquired connection. Use a request-bound,
typed optional database read-step observer for the static roster operation name,
adapted by measured-repositories to MeasurementScope. Do not use global state or
export SQL clients to application code. Exclude this substep from its enclosing
repository timer so dbMs/dbCalls do not count it twice; retain the whole-call
duration separately if needed for comparison. Add real logger serialisation tests
for static names and numeric timings, including concurrent request isolation.

Deploy/measure this instrumentation before changing the read algorithm, after
#906 lands. Record SHA, deployment IDs, exact UTC coverage, retained log counts,
sample count and cohort size. Use provider-free successful dossier reads and
report gather p50/range, dbMaxCallMs/name, dbMs, dbCalls and roster timing for
single-character and large dossiers. Historical 14-character figures are context,
not a substitute for this baseline; the preserved live cohort now has 15 members.
Do not manufacture a 14-member cohort. If retained traffic is insufficient,
report that and agree a bounded ordinary-read sampling method with the coordinator
before making requests. No refresh POST, recollection or live provider test.

Repeat the same metrics after rollout. Aim toward historical approximately
130 ms gather p50, but distinguish improvements from cohort, deployment and
provider changes. Pool/lock waiting are not independently established by existing
dbMs logs. Record missing fields as unmeasured, never as zero.

## Pool guard

Propose explicit web max 20 and connectionTimeoutMillis 5000, plus the bounded
fallback concurrency above. Read-only test diagnostics at 2026-10-13T17:13:54.916Z
reported max_connections 100, superuser reserve 3, other reserve 0 and eight
connections (one active diagnostic); deployment manifests had one web and one
worker replica. Capacity planning allows web 20 + worker application 10 + pg-boss
10 + one listener + one migration + ten operational connections = 52 of 97
ordinary slots. Verify pg-boss's actual pinned pool/listener configuration and
current replica counts before implementation/rollout; these are allowances, not
measurements of all peaks. Recalculate if replicas or database limits change.
Leave PostgreSQL limits and worker configuration unchanged. Test the explicit
web options and finite acquisition failure behaviour without relying on timing
an external server.

## Test-first implementation and verification

- Add Docker-backed equivalence fixtures comparing the batch result with existing
  reserve/hydration on identical published data: full and tier snapshots,
  targeted-only fallback, shared encounters, suppression, parse states and order.
  Include a publication still being written and prove it is never returned.
- Assert actual SQL/transaction behaviour for one and many keys: fixed fresh-path
  statement count, one query each for shared encounters/members/roles, READ ONLY
  snapshot, no advisory locks/write transactions. Exercise duplicate aliases,
  empty inputs and concurrent publication/suppression changes at the snapshot
  boundary. Do not assert only calls to newly added wrappers.
- Cover each fallback predicate separately: obsolete version, missing completion,
  alias pending, ranked continuation due, stale completion and expired retry.
  Verify lock-time recheck against a competing fresh publisher, root admission
  before member work, at most four concurrent fallbacks, and immutable hydration
  selection despite a later publication. Preserve #906's two-reader light-run
  race regression and raise-only queue promotion/repair cases.
- Cover fresh plus active progress, historic aliases/excluded subjects, no-store,
  request-local measurements, repository fallback compatibility and an unchanged
  assembled result for the same stored fixture. Use local fixtures only.
- Run format:check, lint, typecheck, test:unit, Docker test:integration, build and
  test:e2e, inspect for skips, self-review, merge freshly fetched origin/main and
  repeat the full gate before making the implementation PR ready. Manager decides
  merging; never enable auto-merge from this chat.

## Decisions requested in plan review

Approve the repository-owned batching boundary and immutable mixed-path hydration;
the fresh-plus-active queue-write qualification; the request-bound roster timer
with explicit non-double-counting; and max 20/timeout 5000/fallback concurrency
four subject to the capacity recheck. Baseline instrumentation must precede the
optimisation measurement. #906 merge and this approval remain coding gates.
