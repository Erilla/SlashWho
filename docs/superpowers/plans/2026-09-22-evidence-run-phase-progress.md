# Evidence Run Phase Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a privacy-safe, ordered collection-phase ledger for every active evidence run so readers can distinguish current, completed, skipped, limited and terminal work.

**Architecture:** A private application ledger module owns the fixed transition graph, idempotency, timestamps and bounded persistence cadence. The evidence handler asks that module to transition phases as real Warcraft Logs, Raider.IO and Blizzard collection boundaries occur; repositories atomically persist terminal ledger updates with evidence publication or failure.

**Tech Stack:** TypeScript, Vitest, Drizzle schema/migrations, PostgreSQL repositories.

**Spec:** GitHub issue #431 and approved design in this task (2026-09-22).

## Global Constraints

- Seed only phases applicable to the actual collection plan; no impossible provider phase may remain pending.
- Progress contains stable identifiers, state, timestamps, and phase-local limitation codes only; it contains no raw provider payloads, report codes, credentials, or provenance.
- The ledger module alone decides legal transitions, idempotency, timestamps, and write coalescing.
- A publication and its terminal phase state commit in one database transaction.
- Unknown hard stops retain `active`; known cancellation or failure changes that phase to `cancelled` or `failed`.
- General resumable checkpoints are explicitly out of scope; staged evidence remains the existing publication-protection checkpoint.

---

### Task 1: Define the private phase ledger contract

**Files:**

- Create: `packages/application/src/evidence-phase-ledger.ts`
- Test: `packages/application/src/evidence-phase-ledger.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**

- Consumes: an applicable ordered phase plan and a repository `recordPhaseTransition(runId, transition)` callback.
- Produces: `createEvidencePhaseLedger`, whose `transition`, `completePending`, `cancelActive`, and `failActive` methods accept only stable phase identifiers and approved states.

- [ ] **Step 1: Write failing ledger tests**

```ts
it("coalesces repeated active notices and rejects an out-of-order completion", async () => {
  const writes: unknown[] = [];
  const ledger = createEvidencePhaseLedger(plan, (transition) =>
    writes.push(transition)
  );
  await ledger.transition("warcraft_logs_history", "active", at);
  await ledger.transition("warcraft_logs_history", "active", later);
  await expect(
    ledger.transition("publication", "completed", later)
  ).rejects.toThrow("evidence_phase_transition_invalid");
  expect(writes).toHaveLength(1);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the ledger module does not exist.**

Run: `corepack pnpm vitest run packages/application/src/evidence-phase-ledger.test.ts`

- [ ] **Step 3: Implement the minimal private ledger.**

```ts
export function createEvidencePhaseLedger(plan, persist) {
  // validate order/state transitions; retain the last persisted state and
  // suppress repeat notices that do not materially change it.
}
```

- [ ] **Step 4: Run the focused test and verify it passes.**

Run: `corepack pnpm vitest run packages/application/src/evidence-phase-ledger.test.ts`

### Task 2: Persist and query privacy-safe phase rows

**Files:**

- Create: `packages/database/drizzle/0029_evidence_run_phases.sql`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Modify: `packages/database/src/index.ts`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**

- Consumes: ledger-approved phase transitions.
- Produces: `EvidenceRepository.phaseView(runId)` and transition/publish/fail inputs that carry phase state inside their existing transaction.

- [ ] **Step 1: Write failing integration tests** for ordered reads, phase-local limitations, terminal skips, and atomic publication terminalization.

- [ ] **Step 2: Run the relevant integration test and verify the missing repository/schema contract fails.**

Run: `corepack pnpm vitest run --project integration tests/integration/repositories.test.ts`

- [ ] **Step 3: Add the phase table and repository implementation.** The table stores one row per `(run_id, phase_id)`, allowed state, `started_at`, `completed_at`, and nullable limitation code. `publish` locks the active run, inserts evidence, applies its terminal ledger update, then settles the run before commit; `fail` applies a known terminal phase change in the same transaction.

- [ ] **Step 4: Run the integration test and verify it passes.**

Run: `corepack pnpm vitest run --project integration tests/integration/repositories.test.ts`

### Task 3: Report real collection boundaries from gateways and orchestration

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.ts`
- Modify: `packages/warcraftlogs/src/client.test.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.test.ts`

**Interfaces:**

- Consumes: the private `EvidencePhaseLedger` owned by the evidence handler.
- Produces: real phase transitions for identity, history, tier bests, per-fight parsing, attribution, Raider.IO/Blizzard phases when applicable, and terminal publication.

- [ ] **Step 1: Write failing tests** proving a paginated history scan emits its active boundary before the gateway resolves, terminal tiers are skipped, a limitation stays attached to its producing phase, and an aborted scan retains active state.

- [ ] **Step 2: Run focused application and gateway tests to verify they fail for missing progress callbacks.**

Run: `corepack pnpm vitest run packages/application/src/applicant-evidence-job-handler.test.ts packages/warcraftlogs/src/client.test.ts`

- [ ] **Step 3: Add optional, payload-free transition callbacks at real gateway boundaries and route them through the ledger.** Do not emit page counts, report codes, character values, or synthetic percentage progress. Add explicit skipped transitions for terminal tiers. On recognized cancellation/failure ask the ledger for `cancelled`/`failed`; let an unknown process stop retain the stored active phase.

- [ ] **Step 4: Run focused application and gateway tests and verify they pass.**

Run: `corepack pnpm vitest run packages/application/src/applicant-evidence-job-handler.test.ts packages/warcraftlogs/src/client.test.ts`

### Task 4: Expose the application query seam and record the checkpoint decision

**Files:**

- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-dossier-service.test.ts`
- Create: `docs/decisions/evidence-run-phase-checkpoints.md`

**Interfaces:**

- Consumes: repository `phaseView` results.
- Produces: a backend-only phase view suitable for #329 and the operator monitor, without UI rendering or provider data.

- [ ] **Step 1: Write a failing application test** that reads an active run’s phase view without triggering a fresh collection.

- [ ] **Step 2: Run the focused test and verify it fails because the seam is absent.**

Run: `corepack pnpm vitest run packages/application/src/applicant-dossier-service.test.ts`

- [ ] **Step 3: Add the narrow read seam and document the checkpoint decision.** The decision records that phase state reports rather than reconstructs in-flight work; the existing staged collection protects collection-to-publication retries; general gateway resume cursors are deferred to a separately scoped issue.

- [ ] **Step 4: Run the focused test and verify it passes.**

Run: `corepack pnpm vitest run packages/application/src/applicant-dossier-service.test.ts`

### Task 5: Verify the completed contract

**Files:**

- Modify only files required by failing tests or formatter output.

- [ ] **Step 1: Run unit tests, integration tests, lint, typecheck, and formatting checks.**

Run: `corepack pnpm test:unit && corepack pnpm test:integration && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`

- [ ] **Step 2: Inspect `git diff --check` and the final diff** to verify no UI work, raw provider data, or unbounded persistence entered the change.

- [ ] **Step 3: Commit the implementation and create a pull request** using `Closes #431`, without enabling auto-merge.
