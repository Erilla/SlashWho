# Plan for #844: prioritise reader-facing evidence

Status: proposed; awaiting Manager review before implementation.

## Purpose and current evidence

A visitor should wait for the current evidence run, then have their newly queued
collection run ahead of background work. The searched root must be reserved and
enqueued before its dossier members. Serial execution, upstream budgets and the
exclusive singleton policy stay intact.

Checked against freshly fetched origin/main at 7c21c89f:

- `packages/database/src/queue.ts` sends evidence with only `singletonKey` and
  runs evidence with `localConcurrency: 1`.
- `packages/application/src/applicant-dossier-service.ts` reserves and enqueues
  canonical subjects and their Warcraft Logs aliases concurrently in assembly.
- Worker discovery now has an additional `discovery` evidence origin, including
  repair of a queued reservation without a job. It needs an explicit policy too.
- Pinned pg-boss 12.27.0 sorts fetches by descending priority, then creation time
  and ID by default. Retries preserve the job priority. ADR 0001 remains valid.
- `CharacterEvidenceRun` exposes its durable origin; no schema migration is needed.

## Proposed policy

Use one exported, exhaustive origin-to-priority helper in the database queue
module and an optional numeric `priority` in evidence enqueue metadata. The
adapter copies it into pg-boss send options, never into the job JSON. An omitted
priority remains 0 for compatibility with older callers and existing jobs.

| Priority | Origins |
| --- | --- |
| 30 | dossier_initial, applicant_sheet |
| 20 | dossier_read, fingerprint_admission, tier_search, discovery |
| 10 | resume_sweep |
| 0 | refresh, rebuild, historic_alias, unknown |

Use the reservation run's durable origin when dispatching and repairing runs,
so repair does not turn another caller's background reservation into foreground
work. Extend the narrow resume reservation type to expose origin, as the real
repository already does. Priority applies to a job, not a character permanently.
A new resume-sweep reservation receives 10; a pg-boss retry of the same reader
job retains its original priority.

In dossier assembly, gather the canonical searched root first and await its
reservation/enqueue and evidence read before starting members and aliases.
Reuse that evidence exactly once when assembling the root's merged evidence;
preserve subject order, alias attribution, exclusions and stored-only reads.
Do not wait for collection completion. Other members and aliases remain
concurrent after this short root scheduling barrier.

All dossier_initial members share their origin's band. Root-first is guaranteed
within that assembly by enqueue ordering, not by adding another stored role.
Queued background work already active for the same character is reused without
promotion or duplication. Work already executing is not pre-empted.

## Alternatives and trade-offs

- Recommended: send-time priorities plus a canonical-root scheduling barrier.
  This directly uses the existing queue and needs no migration or budget change.
- Root-specific priority alone leaves concurrent reservation races and adds role
  plumbing. It can overtake unrelated foreground work; defer unless review asks.
- Separate queues or extra workers would introduce budget/accounting races and
  are outside #844. Shared concurrency belongs to #800 after its dependencies.

Strict bands can delay background work under sustained foreground demand. Keep
this limitation visible and measure it; do not add unrequested ageing or relax
upstream budgets. Existing job rows retain priority 0; no backlog rewrite or
operational deletion is proposed.

## Test-first implementation and verification

1. Add failing unit tests for every origin band and adapter priority propagation,
   including omitted metadata and no scheduling fields leaking into job JSON.
2. Add a failing dossier test that holds the root reservation/enqueue, proves no
   member or alias can enqueue ahead of it, then checks one root dispatch and
   unchanged attribution/output ordering. Cover fresh root and excluded subjects.
3. Add failing caller tests for dossier reads, applicant collection and replay,
   refresh/rebuild/alias, tier search, resume sweep, worker discovery repair and
   fingerprint admission. Assert repaired runs retain their original origin band.
4. Add Docker-backed queue integration coverage: enqueue background first and
   foreground second before starting the worker, then assert foreground runs
   first. Verify FIFO within one band, serial execution, exclusive deduplication,
   and a retry preserving priority while respecting its future start deadline.
5. Implement the helper, queue metadata mapping, dispatch paths and root barrier.
6. Run format:check, lint, typecheck, test:unit, test:integration, build and
   test:e2e with Docker; inspect actual suite output. Self-review against
   origin/main, fetch/merge current origin/main and rerun the entire gate.
7. Convert this draft into the implementation PR only after review and the full
   gate. Never merge or enable auto-merge; Manager decides readiness and merge.

## Deployment acceptance measurement

After Manager merges and test deployment is confirmed, coordinate a bounded
measurement with the coordinator. Record deployment SHA, observation window,
job priority/origin, enqueue time, first-attempt time and completion time for a
reader root and its members with background jobs already waiting. Show that the
next eligible reader job overtakes waiting background work after the in-flight
run finishes, and compare root wait with the issue's 207-second example.
Report first-attempt wait and completion time separately, including any points
refusal and retry deadline. Use existing run records/job rows and safe aggregate
telemetry; do not publish credentials or character identity. Record background
wait during the same window and queue size so the comparison is interpretable.
Local integration results do not satisfy post-deployment acceptance. If no
background backlog occurs naturally, agree a bounded fixture with the
coordinator first rather than generating unbounded WCL work.

## Review decisions

Please review the priority bands (especially discovery at 20 and refresh at 0),
the root-before-alias/member barrier, and keeping existing queued background
runs unpromoted. Confirm the proposed post-deployment measurement and any
coordination needed with #902. This work changes scheduling only and preserves
character-group discovery and publication semantics.
