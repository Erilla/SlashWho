# Skip Fingerprint-Admission Recollection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid queuing fingerprint-admission evidence work when a complete, full-scope publication is already fresh, while still recollecting fresh light or partial/capped evidence.

**Architecture:** Keep the ordinary evidence freshness policy in the shared reservation repository. Fingerprint admission first reserves at the configured freshness cutoff; if that result is fresh but its selected full publication is partial, light, or not full mode, repeat the reservation with a cutoff of `at` to force full collection. A fresh complete full-mode publication needs no new reservation. Extract the dispatch decision into a small worker helper so Docker tests can exercise it with the real PostgreSQL repository and pg-boss queue. Existing active-run promotion and missing-job repair remain unchanged.

**Tech Stack:** TypeScript, worker runtime, Vitest, PostgreSQL-backed integration suite.

**Spec:** GitHub issue #846, “Skip fingerprint-admission re-collection of characters with fresh evidence”.

## Global Constraints

- Use `config.evidenceFreshnessHours` for the ordinary freshness window.
- Keep fingerprint-admission priority at 20 and preserve its origin, root, queue payload and full collection mode.
- Preserve active-run promotion and repair of queued reservations whose queue job ID is missing.
- Do not change upstream budgets, worker concurrency, persistence schema or migrations.
- Measure the effect on Railway test after deployment; local tests do not satisfy that acceptance criterion.

## Review Focus

- A complete, fresh full-mode publication skips a new run.
- A fresh light run still causes a full run.
- A fresh partial/capped run still causes a full run.
- A complete full-mode publication older than the configured window still causes a full run.
- Existing queued/running work is joined and promoted/repaired without creating duplicate work.
- Every evidence `request_cap` and `parse_request_cap` path publishes `partial`, so a capped run cannot pass the reuse predicate as `complete`.

---

### Implementation: Pin cap and reservation behavior, then reuse complete evidence

**Files:**

- Create: `apps/worker/src/fingerprint-admission-evidence.ts` (freshness decision and enqueue/repair helper)
- Modify: `apps/worker/src/runtime.ts` (`enqueueFullEvidence` delegates to the helper)
- Test: `apps/worker/src/runtime.test.ts`
- Test: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Test: `tests/integration/fingerprint-admission-freshness.test.ts`

**Interfaces:**

- Read `EvidenceReservationResult.completed.run` fields `mode`, `status`, and `lightRefresh`; no database API or schema change.
- Exercise the same helper from runtime and PostgreSQL tests, using `createPostgresRepositories(...).evidence` and `createDiscoveryQueue`.
- Keep dispatch through `enqueueCharacterEvidence`, promotion through `promoteCharacterEvidence`, and persistence through `markEnqueued`.

- [x] Add/retain handler-level assertions that `request_cap` and `parse_request_cap` publish `partial`.
- [x] Add runtime tests for complete fresh reuse, light/partial forced full reservation, stale full collection, and active work promotion/repair.
- [x] Add Docker-backed cases for complete reuse, light and partial recollection, and active priority-20 promotion without duplicates.
- [x] Implement the freshness policy in the worker helper and delegate from the runtime.
- [x] Run focused runtime and cap handler tests, then the dedicated PostgreSQL/pg-boss integration test.

Focused verification completed:

```powershell
corepack pnpm exec vitest run apps/worker/src/runtime.test.ts -t "fingerprint admission|fingerprint reader joins"
corepack pnpm exec vitest run packages/application/src/applicant-evidence-job-handler.test.ts -t "publishes a parse-capped search as partial|publishes a capped ranked walk as a partial"
corepack pnpm test:integration tests/integration/fingerprint-admission-freshness.test.ts --maxWorkers=2
```

Railway measurement after deployment remains an acceptance requirement; local tests do not replace it.
