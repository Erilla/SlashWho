# Skip Fingerprint-Admission Recollection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Avoid queuing fingerprint-admission evidence work when a complete, full-scope publication is already fresh, while still recollecting fresh light or partial/capped evidence.

**Architecture:** Keep the ordinary evidence freshness policy in the shared reservation repository. Fingerprint admission first reserves at the configured freshness cutoff; if that result is fresh but its selected full publication is partial, light, or not full mode, repeat the reservation with a cutoff of `at` to force full collection. A fresh complete full-mode publication needs no new reservation. Existing active-run promotion and missing-job repair remain unchanged.

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

---

### Task 1: Reuse complete fresh fingerprint evidence

**Files:**
- Modify: `apps/worker/src/runtime.ts` (`enqueueFullEvidence`)
- Test: `apps/worker/src/runtime.test.ts`

**Interfaces:**
- Consume `EvidenceReservationResult.completed.run` and its existing `mode`, `status`, and `lightRefresh` fields; no database API or schema changes.
- Continue to dispatch only through `queue.enqueueCharacterEvidence` and persist `markEnqueued` as today.

- [ ] **Step 1: Add failing runtime tests**

Cover a fresh `complete`, `full`, non-light result (no forced reservation or evidence enqueue); fresh `light` and fresh `partial` results (force a second reservation at `at`, then dispatch its full run); and a complete full-mode result outside the configured window (ordinary stale reservation creates and dispatches a full run). Keep the existing active-run promotion and undispatched-job repair tests.

- [ ] **Step 2: Run the focused worker test**

Run: `corepack pnpm exec vitest run apps/worker/src/runtime.test.ts -t "fingerprint admission"`

Expected: the new reuse and forced-full tests fail before the runtime change; existing join/repair cases continue to run when selected.

- [ ] **Step 3: Implement the minimum policy in `enqueueFullEvidence`**

Use `at - config.evidenceFreshnessHours * 60 * 60_000` for the first reservation. Reuse a fresh publication only when its run is `mode === "full"`, `status === "complete"`, and `lightRefresh !== true`. For a fresh result that fails those checks, make a second reservation with `freshnessCutoff: at`; pass that result through the existing dispatch, active-run promotion and repair logic. Do not create an additional run when the second reservation joins active work.

- [ ] **Step 4: Verify focused tests**

Run: `corepack pnpm exec vitest run apps/worker/src/runtime.test.ts -t "fingerprint admission"`

Expected: all selected cases pass and no other source file or public interface changes.

- [ ] **Step 5: Commit the implementation**

```powershell
git add apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts
git commit -m "fix(worker): reuse fresh fingerprint evidence"
```
