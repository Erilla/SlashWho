# Linked-character evidence implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this bounded fix test-first in this worktree.

**Goal:** An applicant's Raider.IO linked characters start evidence collection without a reviewer opening the dossier.

**Architecture:** After successful Raider.IO discovery and before fingerprint admission or snapshot publication, enqueue full evidence for every non-root discovered character. Add a separate `enqueueLinkedEvidence(key, root)` handler seam; compose it with the same reservation/queue mechanism used for fingerprint matches, but respect the configured evidence freshness window and record origin `discovery`. Preserve the existing fingerprint callback's force-full freshness policy.

**Tech stack:** TypeScript, PostgreSQL, pg-boss, Vitest and Playwright.

**Spec:** [Issue #766](https://github.com/Erilla/SlashWho/issues/766).

## Constraints and decisions for Manager review

- Apply this to ordinary discovery, including Sheet submissions, rather than introducing a Sheet-specific queue flag that can be lost during recovery or coalescing.
- Collect only the non-root characters returned by discovery; its canonical deduplication and tournament/suppression filtering remain authoritative. Recheck suppression immediately before reserving evidence.
- Use the configured evidence freshness cutoff for Raider.IO links. Fresh runs are reused and active runs coalesce. Dispatch an active queued reservation with no job ID so a failed enqueue is repairable on redelivery.
- Admit this evidence before fingerprint admission: a deferred or disabled fingerprint sweep must not hold the known Raider.IO characters' evidence hostage. A dispatch failure leaves discovery retryable and does not publish an unattended character with no job.
- Keep fingerprint matches on their existing callback and origin. Keep the evidence worker serial and retain the existing points gate and retry policy.
- Add the truthful `discovery` run origin through a hand-written constraint migration, schema, contract and operational documentation. No table, new scheduler, new upstream query or historical bulk backfill.
- No merging or auto-merge. This draft contains the plan only until Manager review; the same PR becomes the implementation PR after the full local gate and review.

## Review focus

1. Fingerprint admission deferred/disabled: known Raider.IO links still collect.
2. Discovery redelivered after an enqueue failure: active reservations with no job recover without duplicating live jobs.
3. Existing fresh linked evidence: no new upstream collection.
4. Suppression activated between discovery and admission: no evidence reservation.
5. Root, filtered tournament character or repeated canonical link: no redundant collection.

## Task 1: Start unattended linked-character collection

Files: `packages/application/src/discovery-job-handler.ts` and its tests; `apps/worker/src/runtime.ts` and its tests; `packages/contracts/src/collection-monitor.ts` and contract tests; `packages/database/src/schema.ts`, the next numbered SQL migration and journal; `tests/integration/repositories-evidence-origin.test.ts`; `docs/operations/evidence-run-cost.md` and `docs/operations/applicant-sheet-watcher.md`.

- [ ] Add handler regression tests for Raider.IO links without a dossier read, before publication, with disabled/deferred fingerprint discovery, and with a queue failure. Run them and observe the missing admission calls.
- [ ] Add runtime tests for `discovery` origin/root, freshness cutoff, coalesced/fresh/suppressed runs and repair of undispatched queued evidence. Add a real PostgreSQL test for origin persistence.
- [ ] Implement the admission seam and runtime composition; add the origin migration and contract/schema support. Do not modify the existing fingerprint scheduling policy.
- [ ] Run the targeted unit/integration tests and verify the original unattended scenario is green. Update the monitor/watcher documentation and commit the coherent fix.

## Task 2: Validate, review and monitor the PR

- [ ] Start Docker if needed. Run `corepack pnpm format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `build` and `test:e2e`; inspect results and fix failures.
- [ ] Review against `origin/main`, address findings, fetch/merge `origin/main` and rerun required checks.
- [ ] Update the PR title/body to the final fix, include `Closes #766`, mark ready and retain no auto-merge.
- [ ] Watch CI and read both PR discussion and inline review comments. Diagnose/fix findings, run the affected gates, push and resolve addressed review threads.
