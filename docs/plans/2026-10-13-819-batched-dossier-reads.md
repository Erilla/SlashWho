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

Choose review option (a) for the preparation boundary: in a small follow-up
commit after #906 merges, remove prepareNewRun and its application closure.
The repository loads the existing scheduling inputs under its lock, then calls
a pure domain decideLightRefresh(inputs): boolean. Inputs contain only values:
selected completion/version, evaluation time, stored/terminal tiers, recovery
time, settlement kills, hydrated fight URLs and collected tier zones. Preserve
the existing staged early exits to avoid expensive reads for already-ineligible
runs. Move the decision and its pure dependencies out of settled-collection;
domain must not import application/database or accept functions/read views.
There is no transaction capability to escape, nor a caller-supplied callback
that can capture a pool. Test decision equivalence, package import boundaries,
and real transaction traces showing only scheduling reads between the lock and
the first intended reservation write. Retain atomic insertion/light policy and
#906's two-reader regression. This is hardening of the merged seam, not a second
reservation engine.

#904 (issue #902, group dossier reads, currently on a merge/deploy hold) composes
as a separate earlier membership snapshot. Its groupReads.read transaction
closes before evidence selection begins. Consume its resolved subject shape and
membership/suppression decisions without re-reading membership suppression in
the evidence snapshot. Evidence pins immutable publication IDs; roster-member
suppression remains a distinct evidence projection. Whichever PR lands second
integrates the first and reruns the combined gate. Use #904's current subject
shape in fixtures if it has landed; do not bypass its operational hold. Reuse
#907's active phase/progress shape and a shared tierSearchResumesAt calculation.

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
3. Separate metadata selection from hydration. If the opened root needs a
   locked fallback, execute no payload, phase, historic-alias or roster hydration
   statements in the first snapshot: return pinned selections, release its
   client, reserve and enqueue the root first. Only then admit member fallbacks
   and open a consistent hydration read over the pinned IDs from both selection
   and locked reservations. Assert statement ordering, not elapsed time alone:
   stale-root enqueue precedes every hydration statement for every member.
   A fresh root hydrates fresh selections in the original snapshot; a stale
   root uses two snapshots. If a fresh root has stale members, any subsequent
   hydration for their locked selections is an additional mixed-path read.
   Hydrate with ANY(run ids): kills, wipes,
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
   rechecks every predicate under its existing lock and loads scheduling values
   for the pure domain decision before inserting a full run. Apply the callback
   removal described above first; no application closure executes under the lock.
6. Preserve #906's root admission barrier: schedule and enqueue the opened/root
   character before admitting member fallback work. Do not hydrate a stale root's
   full payload before that barrier. Bound remaining locked fallbacks at four
   concurrent keys using the existing concurrency facility. Batch hydration of
   the immutable selections returned by locked reservations in a subsequent
   consistent read; do not reselect newer publications. This second transaction
   is needed only on the mixed/stale path. An all-fresh evidence read uses one
   transaction, in addition to #904's earlier membership snapshot when present.

Fresh evidence can coexist with an active run. Preserve #906 queue promotion,
missing-job repair and progress reporting. Ordinary all-fresh reads with no
active repair need no database write transaction or advisory lock. Fresh keys
with an active job still read evidence lock-free, but queue promotion/repair can
write queue state (and guarded markEnqueued for a missing job). Manager accepted
this qualification with strict tests: all-fresh/no-active takes zero write
transactions and advisory locks; fresh-plus-active takes no advisory lock, with
only raise-only promotion or idempotent missing-job repair. Two concurrent
lock-free repair readers must converge on one job and one durable linkage,
without not_enqueuable errors; a stale attempt cannot overwrite a newer linkage
or terminal run. No fresh key runs locked reserve solely to hydrate evidence.

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
Keep this same named roster timing after batching, inside the batch's client.
Document beside the baseline that splitting the roster substep changes dbCalls
and dbMs accounting relative to the historical 39 repository calls; neither
counter is a SQL statement count. Compare the same instrumentation semantics
before/after and report the separate enclosing duration where retained.

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
dbMs logs. Record missing fields as unmeasured, never as zero. Post both baseline
and after results as comments on #819, explicitly labelling the 15-member cohort.
If provider-free large-dossier gather p50 is not close to about 130 ms, report the
miss and keep #819 open pending investigation or an explicitly tracked follow-up;
do not close the issue silently on code merge or sparse measurement coverage.

## Pool guard

Propose explicit web max 8 and connectionTimeoutMillis 5000, plus the bounded
fallback concurrency above. Read-only test diagnostics at 2026-10-13T17:13:54.916Z
reported max_connections 100, superuser reserve 3, other reserve 0 and eight
connections (one active diagnostic); deployment manifests had one web and one
worker replica. The previous max-20 arithmetic omitted web's separate pg-boss
pool. With max 20 the conservative steady allowance is 20 + 10 web boss + 10
worker application + 10 worker boss + 2 dedicated listeners + 2 migrations + 10
operations = 64; simultaneous old/new web and worker overlap makes it 116,
exceeding 97. Both Railway manifests specify overlapSeconds 10 and shared-package
watch patterns, so simultaneous overlap must be budgeted, not dismissed because
pools grow lazily.

With max 8: steady = 8 + 10 + 10 + 10 + 2 + 2 + 10 = 52; overlapping two copies
of each service = 2 * (8 + 10 + 10 + 10 + 2) + 2 + 10 = 92, leaving five ordinary
slots. Allow one dedicated listener per boss even if web does not currently use
one. Each standalone predeploy migration checks out one client and uses
drizzle(client) sequentially (migrate.ts); in-process startup migrations use the
already-budgeted application pool. Verify the pinned pg-boss defaults, actual
listener count, migration execution and replica counts before rollout. These
are capacity allowances, not measured peaks. Stop/recalculate if they change.

Demand assumption: one mixed dossier uses at most four concurrent application
clients for bounded fallbacks, released before its queue calls; a fresh dossier
uses one consistent-read client. Eight slots allow one mixed read, two concurrent
fresh reads and two polling/other clients. Two mixed reads can occupy all eight;
additional requests/polls wait finitely. Queue calls use separately budgeted boss
pools, not additional simultaneous application clients. This is a planning
concurrency assumption to verify under local concurrent dossier/poll load, not a
claim about measured traffic. Batch size/alias count no longer determines client
demand. A larger max requires a new overlap-safe capacity justification.

Leave PostgreSQL limits, replicas, overlap and worker/boss configuration unchanged.
Map application-pool acquisition timeout to a typed service-unavailable failure
and HTTP 503 with Cache-Control: no-store for the entire read, initial or full.
Never turn it into absent/empty evidence, zero counts or a partial success body.
Test saturated acquisition failure, release of acquired clients and the real HTTP
error response using local fixtures; do not rely on an external server's timing.

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

Approve pure domain preparation with repository-owned inputs, metadata-first
stale-root ordering, separate #904 membership/evidence snapshots, the concurrent
repair guarantees, persistent named roster timing and its disclosed accounting,
and max 8/timeout 5000/fallback concurrency four with overlap-safe rechecks and
whole-read 503 failure. Baseline instrumentation must precede the
optimisation measurement. #906 merge and this approval remain coding gates.
