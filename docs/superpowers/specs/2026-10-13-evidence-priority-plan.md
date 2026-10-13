# Plan for #844: prioritise reader-facing evidence

Status: approved at 63e7ce04 by Manager review 5506163348; implementation in progress.

## Purpose and current evidence

A visitor should wait for the current evidence run, then have their new or joined
waiting collection run ahead of background work. The searched root must be
scheduled before its dossier members. Root means the character the visitor
searched or opened, including any member opened within a character group; it is
not the group's original discovery root. Serial execution, upstream budgets and
the exclusive singleton policy stay intact.

Checked against origin/main at 7c21c89f and the actual #906 review:

- `packages/database/src/queue.ts` sends evidence with only `singletonKey` and
  runs evidence with `localConcurrency: 1`.
- `packages/application/src/applicant-dossier-service.ts` reserves and enqueues
  subjects and their Warcraft Logs aliases concurrently in assembly.
- Reservation coalesces onto active work, including a background run whose job
  is waiting. Fresh results can also carry an active background reservation.
- Worker `enqueueLinkedEvidence` uses origin `discovery` for reader discovery
  and background follow-ups. `DiscoveryRun.callerClass` alone does not identify
  the originating intent reliably across sweeps and continuations.
- Pinned pg-boss 12.27.0 sorts fetches by descending priority, then creation time
  and ID by default. Retries preserve the job priority. ADR 0001 remains valid.
- `CharacterEvidenceRun` exposes its durable origin; no schema migration is needed.
- `evidence.reserve()` currently calls `loadCompletedEvidence` inside its
  transaction. Splitting only `gatherCharacterEvidence` would still put full
  root evidence loading in front of fresh member reads.

## Priority policy

Use one exported, exhaustive origin-to-priority helper in the database queue
package and optional numeric `priority` in evidence enqueue metadata. The adapter
copies it into pg-boss send options, never into job JSON. Omitted priority stays
0 for compatibility with older callers and existing jobs. The pure policy has a
dedicated `@slashwho/database/evidence-priority` export so application imports do
not load database migrations into Playwright's CommonJS test loader.

| Priority | Origins                                          |
| -------- | ------------------------------------------------ |
| 30       | dossier_initial, applicant_sheet                 |
| 20       | dossier_read, fingerprint_admission, tier_search |
| 10       | resume_sweep, discovery                          |
| 0        | refresh, rebuild, historic_alias, unknown        |

Use a newly reserved run's durable origin for its send-time priority. Ordinary
repair uses that original origin too. Treat unclassified `discovery` as band 10;
do not infer reader intent from correlation IDs, a root key or caller class.
A reader explicitly joining discovery work can promote its waiting job through
the same join policy below. Tests cover sweep-started snapshots and continuations.

A pg-boss retry of the same reader job retains its priority and start deadline.
A newly reserved `resume_sweep` continuation gets 10 even if the previous run was
reader-facing. This is an explicit limitation: fresh reader requests outrank
unattended continuation work. The earlier run's origin is not relabelled or
carried forward as a guess. A reader joining that continuation promotes its
waiting job again. Measure retry and new-reservation waits separately.

## Reader joins promote waiting jobs

Add a queue operation `promoteCharacterEvidence(jobId, priority)` that raises
priority atomically using the pinned private schema contract:

```sql
UPDATE pgboss.job
SET priority = GREATEST(priority, $2)
WHERE name = 'collect-character-evidence'
  AND id = $1::uuid
  AND state IN ('created', 'retry');
```

Validate the job ID and scheduling input consistently with queue operations.
A no-op because the job was claimed or settled is expected, not a reason to
create another job. Preserve the run ID, job ID, singleton key, durable origin,
collection mode, credentials, retry count and retry/start deadline. Concurrent
promotions cannot lower priority. Already running work is not pre-empted.

When dossier_initial, dossier_read or applicant_sheet joins an active run with a
queueJobId, request promotion to the current reader's band. Inspect the active
run on fresh reservation results too. Explicit tier_search or
fingerprint_admission joins should use their band where existing coalescing paths
expose the active run. A lower-band caller never demotes a higher-band job.

For an existing queued reservation without a job ID, repair/reuse the same run
and enqueue with the maximum of its durable-origin band and the current reader
band. Preserve its original mode and credentials. If exclusive singleton send
returns an existing job instead, apply raise-only promotion to the returned job
ID. Do not create a second evidence run, relabel origin or duplicate collection.

Existing backlog stays at 0 unless a reader explicitly joins its waiting work;
there is no blanket backlog rewrite or operational deletion.

## Root scheduling barrier and concurrent reads

Self-review reproduced an owner/joiner race: a new dossier reservation was visible
while its owner was still deciding light/full policy. A joining reader could
repair it as full, then the owner's light send would reuse that wrong job; a
worker claim could also make the late markLightRefresh fail.

`reserveForScheduling(input, prepareNewRun)` now chooses that policy inside the
same shared locked transaction as `reserve`. Preparation runs only for a new
full reservation, after alias invalidation and before INSERT/visibility; fresh,
active and targeted-continuation results skip it. The callback receives selected
completed metadata, its version-current flag and a read-only view bound to the
same transaction. It must use only those reads, with no external provider calls,
queue operations, pool reads or side effects. Return a boolean light policy;
`light_refresh` is persisted on INSERT before any join or repair can see the run.
The PostgreSQL dossier path must not perform a later markLightRefresh write.

Settlement reads use only tier/progress metadata, three kill settlement columns
and hydration flags from the selected snapshot; display payloads hydrate later.
Terminal/recovery/zone reads and hydration predicates are shared with existing
repository paths. Full `reserve()` callers retain their existing contract.

A Docker regression holds preparation while a second reader attempts to join,
proves the join cannot complete before preparation commits, and verifies both
readers see the same run with its persisted light policy. A dossier regression
proves that already-fixed light metadata sends a light job without a later mode
write. Manager must review this self-review refinement and callback contract.

Split scheduling from evidence hydration. Introduce a metadata-only reservation
path for dossier assembly, sharing the existing locked reservation decision and
freshness/continuation/alias-invalidation logic with `reserve()`. It must avoid
loading completed kills, wipes, tier bests and other full stored evidence before
the root scheduling decision. Existing full-result callers retain their contract.
Return the chosen completed-run metadata/version and active reservation needed
for freshness and light/full mode decisions; hydrate the selected stored evidence
once afterwards. Preserve completed-run selection and publication consistency.

The root scheduling step reserves with its light/full preparation callback,
enqueues and marks enqueued; or promotes/repairs
joined waiting work. Await only this scheduling step before member/alias
scheduling. Do not await root evidence hydration, phases, rankings or dossier
assembly. If the root is fresh or already active, skip the new-enqueue barrier;
perform any required join promotion and start the remaining reads immediately.
Do not wait for collection completion in any branch.

After the scheduling boundary, hydrate the root and members concurrently and
schedule the other subjects and aliases concurrently. Reuse the root reservation
and evidence exactly once. Preserve subject order, alias attribution, exclusions,
light-refresh semantics and stored-only reads. No excluded subject can reserve,
promote or enqueue evidence. The metadata-only path must preserve existing
freshness and terminal-tier decisions rather than forcing full collection.

All dossier_initial members share their origin's band. Root-first ordering applies
to newly scheduled work within that assembly. It cannot reorder work already
executing or guarantee precedence across unrelated reader requests.

## Alternatives and trade-offs

- Recommended: send-time priority bands, raise-only promotion on reader joins,
  and a scheduling-only root barrier. This uses the existing serial queue.
- Root-specific priority alone leaves reservation races and does not help a
  reader joining background work. Defer additional role plumbing.
- Separate queues or extra workers introduce budget/accounting races and are
  outside #844. Shared concurrency belongs to #800 after its dependencies.

Strict bands can delay background work under sustained foreground demand. Keep
this limitation visible and measure it; do not add unrequested ageing or relax
upstream budgets. Unattended newly reserved reader continuations use band 10 as
specified above. Metadata-only reservation is necessary to avoid worsening the
fresh dossier latency being investigated under #787; cover it explicitly.

## Coordination and integration order

Manager review 5506163348 overrides the earlier #902-first proposal: whichever
implementation PR is reviewed and green first may land. Do not wait for #902's
seven-day ship evidence. The branch landing second integrates and reverifies the
other's overlapping behaviour. Manager controls merge order. #844 is authorised
to implement now in its existing isolated worktree.

#904/#902 phase 2 rewrites reservations and joins in applicant-dossier-service.ts,
start-applicant-collection.ts and worker runtime.ts, and adds a queue application
name option. Keep the metadata reservation seam and priority call sites adaptable
to those interfaces. After #902 lands, use the character the visitor opened as
root even when it is not the group's original root. Recheck exclusions, reused
member evidence, group joins and worker discovery follow-ups on its actual code.
Report incompatible interfaces or any expansion of this plan to the coordinator.

#909 changes queue.ts/runtime.ts textually; integrate and reverify its scheduler
without changing poll behaviour. The coordinator confirmed #787 has no substantive interface overlap with this
seam. Queued #819 (lock-free/set-based evidence reads) is the stronger later
overlap; its area owner has been notified to inspect and reuse this seam before
starting #819. Keep the shared reservation and hydration change bounded and
retain the seam regression tests below. Implementation follows the approved bounded seam and its regression tests.

## Test-first implementation and verification

1. Add failing unit tests for every origin band and send-option propagation,
   including omitted metadata and no scheduling fields leaking into job JSON.
2. Add failing join tests: background runs joined by initial/read/applicant
   callers, fresh results with active runs, missing-job repair, exclusive send
   returning an existing job, raise-only concurrent promotions and unchanged
   mode/credentials/origin. Excluded subjects must never promote or dispatch.
3. Add a failing root-order test holding reserve/enqueue, proving no member or
   alias enqueues ahead of the newly reserved root, with one root dispatch and
   unchanged attribution/output order. Add a fresh-dossier test holding full
   root hydration while member reads start, proving concurrent evidence reads
   and no full-root read inside the scheduling barrier. Add repository tests
   preserving freshness, completed selection, terminal light/full decisions,
   continuation and alias invalidation for the metadata-only path.
4. Add failing caller tests for tier search, refresh/rebuild/alias, resume sweep,
   worker discovery repair and fingerprint admission. Cover sweep/continuation
   discovery at 10 and repaired reader/background origins without promotion
   unless an explicit reader actually joins. Cover new resume reservations at 10.
5. Add Docker-backed queue tests: background A then foreground B runs B first;
   background A and B then reader joins B runs B first with exactly two jobs and
   unchanged origin; equal bands retain FIFO and exclusive deduplication. Verify
   serial execution, promotion of retry jobs preserving future start deadlines,
   priority retained on retry, and no promotion of active or settled jobs.
6. Implement the helper, queue send/promotion operations, shared metadata
   reservation seam, caller dispatch/join handling and scheduling-only barrier.
7. Integrate freshly fetched origin/main including #902 and #909 if they land first;
   recheck current group interfaces and opened-member root semantics. Run
   format:check, lint, typecheck, test:unit, test:integration, build and test:e2e
   with Docker and inspect actual output. Self-review against origin/main,
   fetch/merge current origin/main and rerun the entire gate.
8. Convert this draft into the implementation PR only after plan acceptance,
   integration and the full gate. Never merge or enable auto-merge.

## Deployment acceptance measurement

After Manager merges and test deployment is confirmed, coordinate a bounded
measurement with the coordinator. Record deployment SHA, observation window,
priority/origin, enqueue time, first-attempt time and completion time for newly
queued reader work and a reader joining a waiting background job, with background
jobs already waiting. Show each overtakes waiting background work after the
in-flight run finishes, and compare root wait with the issue's 207-second example.
Use the searched/opened member as root for the group case. Confirm promotion
preserves the existing run/job and origin rather than creating more work.

Report first-attempt wait and completion time separately, including points
refusal, retry deadline and new resume-sweep reservations. Use existing run
records/job rows and safe aggregate telemetry; do not publish credentials or
character identity. Record background wait and queue size in the same window.
Local integration results do not satisfy post-deployment acceptance. If no
background backlog occurs naturally, agree a bounded fixture with the coordinator
first rather than generating unbounded WCL work.

## Review decisions

Please review the revised raise-only reader join promotion, discovery fallback at
10, metadata-only root scheduling path, explicit new-resume demotion and the Manager-approved first-green
integration order. This work changes scheduling and its necessary read seam;
character-group discovery and evidence publication semantics remain governed by
#902 and the existing repository contracts.
