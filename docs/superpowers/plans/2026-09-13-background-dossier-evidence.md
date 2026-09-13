# Background Applicant Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gather complete normalized Warcraft Logs evidence in the worker and present a fast cached dossier with coalesced kills and complete visual media treatment.

**Architecture:** Add per-character evidence run/cache repositories and a pg-boss queue. The worker owns WCL scanning and atomic cache publication; the web schedules stale scans and renders completed cache rows. Domain aggregation coalesces same-guild/same-boss kills within two minutes.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, pg-boss, Next.js, React, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-13-background-dossier-evidence-design.md`

## Global Constraints

- Persist normalized evidence only; never a raw Warcraft Logs payload, OAuth token, or credential.
- Preserve source limitations and last successful evidence during a failed refresh.
- WCL credentials are worker-only after rollout.
- Same kill means same boss, normalized guild name/realm, and timestamps within 120,000 ms.
- The shared fallback icon must remain local and have meaningful alt text.

---

### Task 1: Evidence cache persistence and queue

**Files:**

- Modify: `packages/database/src/schema.ts`, `packages/database/src/repositories.ts`, `packages/database/src/postgres-repositories.ts`, `packages/database/src/index.ts`, `packages/database/src/queue.ts`
- Create: `packages/database/drizzle/0004_character_evidence.sql`
- Test: `packages/database/src/postgres-repositories.test.ts`, `packages/database/src/queue.test.ts`

- [ ] Add a failing repository test that reserves one active evidence run per canonical character, atomically replaces its normalized kills, and retains a prior completed result while a refresh is active.
- [ ] Run the focused repository test and confirm it fails because no evidence repository exists.
- [ ] Add evidence-run and normalized-kill tables plus `EvidenceRepository` methods: `reserve`, `claim`, `publish`, `fail`, `getCompleted`, and `listStatus`.
- [ ] Add `collect-character-evidence` pg-boss queue support with singleton character keys and worker registration.
- [ ] Re-run repository and queue tests and commit `feat: persist character evidence cache`.

### Task 2: Worker-owned WCL collection

**Files:**

- Modify: `apps/worker/src/config.ts`, `apps/worker/src/runtime.ts`, `packages/application/src/applicant-evidence-job-handler.ts`, `packages/application/src/index.ts`, `packages/warcraftlogs/src/client.ts`
- Create: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Test: `apps/worker/src/config.test.ts`, `apps/worker/src/runtime.test.ts`, `packages/warcraftlogs/src/client.test.ts`

- [ ] Write a failing handler test that pages a high-volume character beyond the web timeout, publishes gathered normalized kills, and records a limitation without deleting an earlier completed result.
- [ ] Run it to verify the missing handler failure.
- [ ] Add worker WCL credential/config validation, a bounded worker request cap, gateway composition, and handler retry/limitation mapping.
- [ ] Re-run focused tests and commit `feat: collect applicant evidence in worker`.

### Task 3: Cached dossier orchestration and browser refresh

**Files:**

- Modify: `packages/application/src/applicant-dossier-service.ts`, `packages/application/src/applicant-dossier-service.test.ts`, `apps/web/src/server/container.ts`, `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`, `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`
- Test: `apps/web/src/app/api/dossiers/api-contract.test.ts`

- [ ] Write failing service tests proving a dossier schedules missing/stale character scans, serves completed cache rows without invoking WCL directly, and reports active evidence gathering.
- [ ] Run them red.
- [ ] Replace web WCL calls with cache reads and enqueue calls; expose evidence-job state through the existing dossier response/research state.
- [ ] Update polling so it refreshes cached evidence after queued character jobs settle.
- [ ] Re-run focused service, route, and client tests and commit `feat: serve applicant evidence from cache`.

### Task 4: Same-kill coalescing

**Files:**

- Modify: `packages/domain/src/applicant-dossier.ts`, `packages/domain/src/applicant-dossier.test.ts`

- [ ] Add a failing domain test with two report URLs for the same boss/guild within two minutes; expect one evidence row with unioned characters and deterministic report selection.
- [ ] Run it red.
- [ ] Add the grouping key/window before existing boss ordering and historic-rank enrichment.
- [ ] Re-run the domain tests and commit `fix: coalesce duplicate kill reports`.

### Task 5: Fallback media and raid blocks

**Files:**
- Modify: `apps/web/src/components/dossier-raid-list.tsx`, `apps/web/src/components/dossier-cutting-edge-list.tsx`, `apps/web/src/app/globals.css`
- Create: `apps/web/src/components/dossier-media-fallback.tsx`
- Test: `apps/web/src/components/dossier-raid-list.test.tsx`, `apps/web/src/components/dossier-cutting-edge-list.test.tsx`

- [ ] Add failing component tests that expect a labelled fallback when media is null and a raid block class around each tier.
- [ ] Run the tests red.
- [ ] Render the shared local emblem in every missing raid, boss, and achievement slot and style full-background raid blocks.
- [ ] Re-run focused UI tests and commit `feat: complete dossier media treatment`.

### Task 6: Verify and deploy

**Files:** none beyond any generated migration metadata required by Drizzle.

- [ ] Run `corepack pnpm test`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm build`, and `corepack pnpm test:e2e`.
- [ ] Create a PR, wait for required checks, squash merge, and verify both Railway test services succeed.
- [ ] Configure worker-only WCL credentials without printing values; remove WCL credentials from web after worker collection is live.
- [ ] Verify a fresh Rinn dossier eventually includes its cached current-tier evidence and no duplicate same-kill rows.
