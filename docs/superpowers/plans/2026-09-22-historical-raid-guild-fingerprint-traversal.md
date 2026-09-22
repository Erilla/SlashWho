# Historical Raid-Guild Fingerprint Traversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find new direct fingerprint matches through every cached historical raid guild without recollecting known characters.

**Architecture:** Persist region-qualified report guilds, freeze every eligible guild from the starting snapshot into continuation state, and use the existing Blizzard reservation for every roster and fingerprint request. Dossier reads coalesce cadence-due discovery; only a new fingerprint admission receives evidence collection.

**Tech Stack:** TypeScript, Vitest, PostgreSQL/Drizzle, pg-boss, Blizzard API.

**Spec:** `docs/superpowers/specs/2026-09-22-historical-raid-guild-fingerprint-traversal.md`

## Global Constraints

- Never infer a missing historical guild region or expose/log source guilds.
- Preserve direct-root fingerprint floors, suppression, reservation accounting, and atomic continuation ownership.
- A visit returns the current snapshot promptly; it can enqueue only one cadence-due sweep.
- Queue full evidence only after a newly admitted fingerprint match.

---

### Task 1: Persist usable historical guild identities

**Files:** `packages/database/src/schema.ts`, `packages/database/src/repositories.ts`, `packages/database/src/postgres-repositories.ts`, a Drizzle migration, `packages/application/src/applicant-evidence-job-handler.ts`, and their tests.

**Interfaces:** `CharacterMythicKillInput.guild` becomes `CharacterGuild | null`.

- [ ] **Step 1: Write the failing test**

```ts
expect(completed.kills[0]?.guild).toEqual({
  name: "Rancour", region: "eu", realm: "draenor"
});
```

- [ ] **Step 2: Run `corepack pnpm exec vitest run packages/application/src/applicant-evidence-job-handler.test.ts tests/integration/repositories.test.ts` and verify the stored guild has no region.**

- [ ] **Step 3: Add nullable `guild_region`, write/read it atomically with the other guild fields, and map incomplete legacy identities to `null`. Copy the normalized Warcraft Logs region in the evidence handler.**

- [ ] **Step 4: Re-run the focused tests, then commit `feat: retain evidence guild regions`.**

### Task 2: Fetch Blizzard rosters by historical guild identity

**Files:** `packages/blizzard/src/types.ts`, `packages/blizzard/src/client.ts`, `packages/blizzard/src/client.test.ts`, `packages/application/src/blizzard-fingerprint-adapter.ts`, `packages/application/src/discovery-job-handler.ts`.

**Interfaces:** Add `getGuildRosterByIdentity(guild, signal, observer)` to Blizzard and fingerprint gateways.

- [ ] **Step 1: Write the failing test**

```ts
await expect(gateway.getGuildRosterByIdentity({
  name: "Rancour", region: "eu", realm: "draenor"
})).resolves.toContainEqual(expect.objectContaining({
  key: { region: "eu", realm: "draenor", name: "mistakinus" }
}));
```

- [ ] **Step 2: Run `corepack pnpm exec vitest run packages/blizzard/src/client.test.ts` and verify the method is missing.**

- [ ] **Step 3: Validate the guild identity, reuse the normalized roster parser/class cache, observe every physical request, and preserve typed 404 errors. Thread it through timing and reservation adapters.**

- [ ] **Step 4: Re-run Blizzard and discovery-handler tests, then commit `feat: read historical guild rosters`.**

### Task 3: Traverse all frozen sources with one direct-root comparison

**Files:** `packages/domain/src/fingerprint-discovery.ts`, `packages/domain/src/fingerprint-discovery.test.ts`, `packages/domain/src/index.ts`.

**Interfaces:** `discoverFingerprintMatches` accepts `historicalGuilds` and returns/accepts an opaque source-and-candidate cursor.

- [ ] **Step 1: Write the Ictinus regression**

```ts
expect(outcome.characters.map((item) => item.key.name)).toEqual([
  "boptinus", "mistakinus"
]);
```

- [ ] **Step 2: Add red cases for duplicate guilds/candidates, stale guild 404, cross-region candidates, suppression, and a cap that resumes into a later guild. Run `corepack pnpm exec vitest run packages/domain/src/fingerprint-discovery.test.ts`.**

- [ ] **Step 3: Fetch the root roster plus every ordered historical guild through one request helper; make historical 404 empty, coalesce candidates globally, sort canonically, and compare every candidate directly to the root.**

- [ ] **Step 4: Re-run the domain suite and commit `feat: traverse historical guild fingerprint sources`.**

### Task 4: Persist frozen source plans for continuation

**Files:** `packages/database/src/schema.ts`, `packages/database/src/repositories.ts`, `packages/database/src/postgres-repositories.ts`, a Drizzle migration, `tests/integration/repositories.test.ts`, `packages/application/src/discovery-job-handler.test.ts`.

**Interfaces:** Extend `FingerprintSweepCursor` and `getResumeState` with `historicalGuilds` and the opaque cursor.

- [ ] **Step 1: Write the failing continuation test**

```ts
expect(await repositories.fingerprintSweeps.getResumeState(root)).toMatchObject({
  historicalGuilds: [{ name: "Rancour", region: "eu", realm: "draenor" }]
});
```

- [ ] **Step 2: Run integration/handler tests and verify state only holds `resumeAfter`.**

- [ ] **Step 3: Store validated JSON guild tuples transactionally, use them unchanged on continuation, and clear them on seal or supersession. Treat malformed legacy JSON as no continuation.**

- [ ] **Step 4: Re-run the focused suites and commit `feat: resume historical guild fingerprint sources`.**

### Task 5: Build plans from cache and collect only new matches

**Files:** `packages/application/src/discovery-job-handler.ts`, `packages/application/src/discovery-job-handler.test.ts`, `apps/worker/src/runtime.ts`, `apps/worker/src/runtime.test.ts`.

**Interfaces:** Handler reads starting snapshot completed evidence and receives `enqueueCharacterEvidence`.

- [ ] **Step 1: Write a failing Ictinus/Boptinus/Mistakinus handler test where Boptinus evidence yields Rancour, Mistakinus is admitted, no evidence is queued for Boptinus, and one full collection is queued for Mistakinus.**

- [ ] **Step 2: Run `corepack pnpm exec vitest run packages/application/src/discovery-job-handler.test.ts apps/worker/src/runtime.test.ts` and verify no plan/evidence work exists.**

- [ ] **Step 3: Build the all-guild plan from the starting snapshot only; continuations use persisted sources only. After successful snapshot persistence, reserve/enqueue full evidence for newly admitted matches and skip fresh/active/known entries.**

- [ ] **Step 4: Re-run focused tests and commit `feat: collect evidence for new fingerprint matches`.**

### Task 6: Schedule a cadence-due discovery on a dossier visit

**Files:** `packages/application/src/search-service.ts`, `packages/application/src/applicant-dossier-service.ts`, `packages/database/src/repositories.ts`, `packages/database/src/postgres-repositories.ts`, and their tests.

**Interfaces:** Add `SearchService.scheduleConnectedCharacterSweep(key): Promise<void>`.

- [ ] **Step 1: Write the failing visit test**

```ts
await dossiers.read(ictinus);
expect(queue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ key: ictinus }));
await dossiers.read(ictinus);
expect(queue.enqueue).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run search/dossier service tests and verify a fresh snapshot does no discovery work.**

- [ ] **Step 3: Add one locked repository operation that creates/reuses a run only for an existing snapshot with due fingerprint work. Invoke it after snapshot load without delaying the dossier response.**

- [ ] **Step 4: Re-run focused tests and commit `feat: sweep connected characters on dossier visits`.**

### Task 7: Document and verify

**Files:** `.env.example`, `docs/deployment/railway.md`, affected tests.

- [ ] **Step 1: Document cadence, all-source continuation, and new-match-only evidence collection.**

- [ ] **Step 2: Run `corepack pnpm format:check`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:integration`, `corepack pnpm build`, and `corepack pnpm test:e2e`.**

- [ ] **Step 3: Commit documentation, push the branch, and open a PR titled `feat(discovery): traverse historical raid guilds` with `Closes #419`.**

## Plan Self-Review

- Tasks 1-2 retain and read safe guild identity.
- Tasks 3-4 provide complete bounded traversal and continuation.
- Task 5 covers the regression and evidence trigger.
- Task 6 makes visits schedule discovery without repeated work.
- Task 7 validates and delivers the change.
