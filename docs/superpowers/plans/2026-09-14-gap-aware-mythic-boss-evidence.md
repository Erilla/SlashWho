# Gap-Aware Mythic Boss Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every supported Mythic raid boss as an aggregate verified kill, concrete wipe, honest no-log result, or incomplete-evidence state.

**Architecture:** Reuse the existing bounded Warcraft Logs report traversal to normalize participant-attributed wipes, persist one representative wipe per character and boss beside cached kills, and aggregate cached evidence over the finite ordered raid catalogue. Expose the aggregate as a discriminated API contract so the reviewer UI can render accessible status icons and collapse wholly negative tiers without turning partial upstream reads into negative evidence.

**Tech Stack:** TypeScript 5.9, Warcraft Logs GraphQL client, PostgreSQL/Drizzle, Zod, React 19/Next.js 16, Vitest, Testing Library, Playwright

**Spec:** `docs/superpowers/specs/2026-09-14-gap-aware-mythic-boss-evidence-design.md`

## Global Constraints

- A boss state uses strict precedence: `kill`, then `wipe`, then `no_logs`, then `incomplete` when absence cannot be established.
- A wipe requires a completed Mythic `kill: false` fight containing the requested character in `friendlyPlayers`.
- `no_logs` requires complete Warcraft Logs evidence for every selected character.
- Keep the existing ten-report page size, worker request cap, dossier character cap, and overall timeouts.
- Catalogue traversal must not make external requests.
- The whole-tier visible label is exactly `No logs found`; its accessible explanation must say that no qualifying public logs were found and that this does not prove no attempt.

---

### Task 1: Normalize Participant-Attributed Wipes

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.ts`
- Test: `packages/warcraftlogs/src/client.test.ts`

**Interfaces:**

- Consumes: the existing `recentReports` response, actor identity matching, pagination cap, and partial-result limitation.
- Produces: `WarcraftLogsWipeEvidence` and `WarcraftLogsReportResult` evidence values containing `kills` and `wipes`.

- [ ] **Step 1: Write failing gateway tests for qualifying and rejected wipes**

Add a report fixture inline with a requested player and four fights: participant Mythic wipe, non-participant Mythic wipe, participant Heroic wipe, and participant Mythic kill. Assert only the first becomes a wipe and the kill remains a kill:

```ts
expect(result).toMatchObject({
  kind: "evidence",
  wipes: [
    {
      raidId: "42",
      bossId: "7",
      attemptedAt: "2026-09-12T20:05:00.000Z",
      fightUrl: "https://www.warcraftlogs.com/reports/report#fight=1"
    }
  ],
  kills: [expect.objectContaining({ bossId: "8" })]
});
```

- [ ] **Step 2: Run the focused gateway tests and verify RED**

Run: `pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts`

Expected: FAIL because evidence results do not contain `wipes`.

- [ ] **Step 3: Add the normalized wipe type and collect wipes from existing fights**

Define:

```ts
export type WarcraftLogsWipeEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  attemptedAt: string;
  reportUrl: string;
  fightUrl: string;
}>;
```

Add `wipes: readonly WarcraftLogsWipeEvidence[]` to the evidence result. During
normalization, accept `kill === false` only after the existing Mythic and
participant checks. Select the most recent wipe per raid/boss using
`attemptedAt`, then `fightUrl`, and merge page results with the same rule.
Preserve collected wipes as well as kills in partial evidence results.

- [ ] **Step 4: Add a failing deterministic-selection test**

Supply two pages containing wipes for the same supported encounter and assert
that only the later attempt remains, with the lexically smaller fight URL used
for equal timestamps.

- [ ] **Step 5: Run the focused gateway tests and verify GREEN**

Run: `pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/warcraftlogs/src/types.ts packages/warcraftlogs/src/client.ts packages/warcraftlogs/src/client.test.ts
git commit -m "feat: collect participant Mythic wipe evidence"
```

### Task 2: Persist Representative Wipes with Evidence Runs

**Files:**

- Create: `packages/database/drizzle/0006_character_mythic_wipes.sql`
- Modify: `packages/database/drizzle/meta/_journal.json`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Test: `tests/integration/migrations.test.ts`
- Test: `tests/integration/repositories.test.ts`
- Test: `packages/application/src/applicant-evidence-job-handler.test.ts`

**Interfaces:**

- Consumes: `WarcraftLogsWipeEvidence`, `EvidenceRepository.publish`, and a completed or partial character evidence run.
- Produces: `CharacterMythicWipeInput`, `StoredCharacterMythicWipe`, and `CompletedCharacterEvidence.wipes`.

- [ ] **Step 1: Write failing storage and job-handler tests**

Publish a complete run with one wipe and assert `getCompleted` returns it:

```ts
expect(completed).toMatchObject({
  run: { status: "complete", limitationCode: null },
  wipes: [
    {
      raidId: "42",
      bossId: "7",
      attemptedAt: "2026-09-12T20:05:00.000Z",
      fightUrl: "https://www.warcraftlogs.com/reports/report#fight=1"
    }
  ]
});
```

Update the job-handler success test so its gateway returns `wipes` and its
published result includes the same array. Update limitation tests to publish
`wipes: []`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`

Run: `pnpm vitest run --project integration tests/integration/migrations.test.ts tests/integration/repositories.test.ts`

Expected: FAIL because publish and completed evidence do not support wipes and
the wipe table does not exist.

- [ ] **Step 3: Add the wipe migration and schema**

Create `character_mythic_wipes` with a UUID primary key, `evidence_run_id`
foreign key using `ON DELETE CASCADE`, raid/boss identity columns,
`journal_boss_id`, `boss_order`, `attempted_at`, `report_url`, and `fight_url`.
Add a unique constraint on `(evidence_run_id, raid_id, boss_id)` and an index on
`evidence_run_id`. Register migration `0006_character_mythic_wipes` in the
Drizzle journal and mirror the table in `schema.ts`.

- [ ] **Step 4: Extend repository types and atomic publication**

Define:

```ts
export interface CharacterMythicWipeInput {
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  attemptedAt: string;
  reportUrl: string;
  fightUrl: string;
}

export interface StoredCharacterMythicWipe extends CharacterMythicWipeInput {
  id: string;
}
```

Add `wipes` to `EvidenceRepository.publish` and `CompletedCharacterEvidence`.
Insert wipes in the same publication transaction as kills and load them ordered
by raid, boss, attempt time descending, and fight URL. Preserve the existing
rule that a partial replacement cannot erase the prior complete result.

- [ ] **Step 5: Pass wipes through the worker job handler**

Include `wipes: response.wipes` for evidence results and `wipes: []` for a pure
limitation result.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`

Run: `pnpm vitest run --project integration tests/integration/migrations.test.ts tests/integration/repositories.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/database packages/application/src/applicant-evidence-job-handler.ts packages/application/src/applicant-evidence-job-handler.test.ts tests/integration/migrations.test.ts tests/integration/repositories.test.ts
git commit -m "feat: persist Mythic wipe evidence"
```

### Task 3: Aggregate the Ordered Catalogue into Boss States

**Files:**

- Modify: `packages/domain/src/raid-catalogue.ts`
- Modify: `packages/domain/src/applicant-dossier.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/raid-catalogue.test.ts`
- Test: `packages/domain/src/applicant-dossier.test.ts`

**Interfaces:**

- Consumes: `DossierKillEvidence[]`, `DossierWipeEvidence[]`, selected characters, and `completeWarcraftLogsCharacters: readonly CharacterKey[]`.
- Produces: catalogue-backed `ApplicantDossierRaid[]` containing discriminated `kill`, `wipe`, `no_logs`, or `incomplete` bosses.

- [ ] **Step 1: Write failing catalogue traversal tests**

Assert a new `supportedRaidCatalogue()` export returns immutable raids in
descending `tierOrdinal` order and each raid's encounters in ascending
`bossOrder` order. Mutation attempts must not affect a later call.

- [ ] **Step 2: Write failing aggregation tests**

Cover these exact cases:

```ts
expect(bossWithLinkedKill.state).toBe("kill");
expect(bossWithWipeButNoKill.state).toBe("wipe");
expect(bossWithNoEvidenceAndAllComplete.state).toBe("no_logs");
expect(bossWithNoEvidenceAndOnePartial.state).toBe("incomplete");
```

Also assert a kill wins over a wipe from another linked character, wipe details
contain contributing display names, every supported encounter appears once,
and catalogue order is retained.

- [ ] **Step 3: Run domain tests and verify RED**

Run: `pnpm vitest run --project unit packages/domain/src/raid-catalogue.test.ts packages/domain/src/applicant-dossier.test.ts`

Expected: FAIL because catalogue traversal and non-kill states do not exist.

- [ ] **Step 4: Expose immutable ordered catalogue traversal**

Return copied, frozen raid objects with copied, frozen encounter arrays from
`supportedRaidCatalogue()`. Keep all existing lookup functions unchanged.

- [ ] **Step 5: Add wipe input and discriminated boss output types**

Define:

```ts
export type DossierWipeEvidence = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  journalBossId: string | null;
  bossOrder: number;
  character: CharacterKey;
  attemptedAt: string;
  reportUrl: string;
}>;

export type ApplicantDossierBoss =
  | (ApplicantDossierBossMetadata &
      Readonly<{
        state: "kill";
        firstKill: ApplicantDossierFirstKill;
        firstKills: readonly ApplicantDossierFirstKill[];
      }>)
  | (ApplicantDossierBossMetadata &
      Readonly<{ state: "wipe"; wipe: ApplicantDossierWipe }>)
  | (ApplicantDossierBossMetadata & Readonly<{ state: "no_logs" }>)
  | (ApplicantDossierBossMetadata & Readonly<{ state: "incomplete" }>);
```

`ApplicantDossierWipe` contains `attemptedAt`, `reportUrl`, and `characters`.

- [ ] **Step 6: Build raids from catalogue and merge evidence**

Normalize kills and wipes through the existing strict catalogue matching.
Build every catalogue raid and encounter, aggregate contributing characters,
then apply state precedence. A boss is `no_logs` only when every dossier
character appears in `completeWarcraftLogsCharacters`; otherwise it is
`incomplete`. Keep existing kill grouping, first-kill ordering, guild/rank
attribution, and report-link behavior intact.

- [ ] **Step 7: Run domain tests and verify GREEN**

Run: `pnpm vitest run --project unit packages/domain/src/raid-catalogue.test.ts packages/domain/src/applicant-dossier.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add packages/domain/src/raid-catalogue.ts packages/domain/src/raid-catalogue.test.ts packages/domain/src/applicant-dossier.ts packages/domain/src/applicant-dossier.test.ts packages/domain/src/index.ts
git commit -m "feat: aggregate catalogue boss evidence states"
```

### Task 4: Carry Cached Wipes and Completion through the Application and Contract

**Files:**

- Modify: `packages/application/src/applicant-dossier-service.ts`
- Test: `packages/application/src/applicant-dossier-service.test.ts`
- Modify: `packages/contracts/src/dossier.ts`
- Test: `packages/contracts/src/contracts.test.ts`

**Interfaces:**

- Consumes: `CompletedCharacterEvidence.wipes`, `run.status`, and the domain boss-state union from Task 3.
- Produces: a validated dossier response preserving every boss variant.

- [ ] **Step 1: Write failing application tests for cached aggregation**

Create two linked characters with cached evidence and assert:

- a cached kill from either character produces `state: "kill"`;
- with no kill, a cached wipe produces `state: "wipe"` and names its character;
- fresh completed runs with neither produce `state: "no_logs"`; and
- an active, partial, failed, or absent completed run produces
  `state: "incomplete"` for unresolved bosses.

- [ ] **Step 2: Write failing contract variant tests**

Parse one valid value for each state and assert strict rejection of a
`no_logs` or `incomplete` boss carrying `firstKill` or `wipe`, and of a `wipe`
boss without `attemptedAt`, `reportUrl`, and `characters`.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `pnpm vitest run --project unit packages/application/src/applicant-dossier-service.test.ts packages/contracts/src/contracts.test.ts`

Expected: FAIL because wipes, completion, and boss variants are not mapped.

- [ ] **Step 4: Map stored wipes and complete characters into the domain**

Add `cachedWipe` beside `cachedKill`. Extend `EvidenceResult` with `wipes` and
`warcraftLogsComplete`. Treat only a fresh completed run whose status is
`complete` and limitation code is `null` as complete for negative evidence.
Pass all mapped wipes and the corresponding complete character keys to
`buildApplicantDossier`. Skipped characters and gathering or limited evidence
remain incomplete.

- [ ] **Step 5: Replace the boss contract with a discriminated union**

Keep common metadata in `dossierBossMetadataSchema`, then define strict `kill`,
`wipe`, `no_logs`, and `incomplete` objects with `z.discriminatedUnion("state",
...)`. Retain `firstKills` as optional on the kill variant for compatibility
with existing fixtures while always emitting it from current domain code.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm vitest run --project unit packages/application/src/applicant-dossier-service.test.ts packages/contracts/src/contracts.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts packages/contracts/src/dossier.ts packages/contracts/src/contracts.test.ts
git commit -m "feat: expose aggregate boss evidence states"
```

### Task 5: Render Accessible Boss States and Collapsed No-Log Tiers

**Files:**

- Modify: `apps/web/src/components/dossier-raid-list.tsx`
- Modify: `apps/web/src/components/dossier-raid-list.test.tsx`
- Modify: `apps/web/src/components/dossier-view.test.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `tests/e2e/search.spec.ts`

**Interfaces:**

- Consumes: the contract boss-state union from Task 4.
- Produces: accessible status icons, evidence details, incomplete rows, and collapsed all-no-log raid rows.

- [ ] **Step 1: Read the installed Next.js guidance before editing**

Run: `Get-Content -Raw apps/web/node_modules/next/dist/docs/01-app/03-api-reference/01-components/image.md`

If that exact guide is absent, locate the relevant component guide with:
`rg --files apps/web/node_modules/next/dist/docs | rg 'image|accessibility|css'`.

- [ ] **Step 2: Write failing component tests for all visual states**

Assert:

```ts
expect(screen.getByRole("img", { name: "Verified Mythic kill" })).toBeVisible();
expect(screen.getByRole("img", { name: "Mythic wipe found" })).toBeVisible();
expect(screen.getByText("No qualifying public logs found")).toBeVisible();
expect(screen.getByText("Evidence incomplete")).toBeVisible();
expect(screen.getByText("No logs found")).toBeVisible();
expect(screen.getByText(/does not prove no attempt/i)).toBeVisible();
```

For an all-`no_logs` tier, assert no boss articles or artwork are rendered and
the raid row has the muted-state class. For a mixed tier, assert bosses remain
in catalogue order and wipe details show the direct report link and character
names.

- [ ] **Step 3: Run component tests and verify RED**

Run: `pnpm vitest run --project unit apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-view.test.tsx`

Expected: FAIL because wipe, no-log, incomplete, and collapsed-tier rendering
do not exist.

- [ ] **Step 4: Split state rendering into focused internal components**

Keep `DossierRaidList` as the list coordinator and add internal
`BossStatusIcon`, `KillBoss`, `WipeBoss`, and `UnavailableBoss` components in
the same file. Use exhaustive `switch (boss.state)` handling. The kill path
retains existing metadata and report links. The wipe path shows attempt date,
characters, and a Warcraft Logs fight link. `no_logs` displays the exact
evidence-result label. `incomplete` displays no negative icon.

- [ ] **Step 5: Collapse wholly negative tiers and add non-colour cues**

When `raid.bosses.every((boss) => boss.state === "no_logs")`, render one
`.dossier-raid-no-logs` row with raid name, visible `No logs found`, and visible
or screen-reader explanatory text `No qualifying public logs found; this does
not prove no attempt.` Add borders, opacity/background treatment, and distinct
SVG shapes for kill, wipe, and no-log states. Every SVG has `role="img"`, an
`aria-label`, and `<title>`.

- [ ] **Step 6: Update the reviewer-view and browser fixtures**

Give all existing boss fixtures `state: "kill"`. Add an end-to-end assertion
that a seeded no-evidence dossier exposes `No logs found` and the
non-conclusive explanation without relying on colour.

- [ ] **Step 7: Run focused UI and browser tests and verify GREEN**

Run: `pnpm vitest run --project unit apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-view.test.tsx`

Run: `pnpm playwright test tests/e2e/search.spec.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add apps/web/src/components/dossier-raid-list.tsx apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-view.test.tsx apps/web/src/app/globals.css tests/e2e/search.spec.ts
git commit -m "feat: render gap-aware Mythic boss states"
```

### Task 6: Verify, Review, and Open the Test PR

**Files:**

- Modify only files required by failures found during verification.

**Interfaces:**

- Consumes: the complete feature branch.
- Produces: a reviewed PR linked to issue #60 and suitable for the repository's test deployment path.

- [ ] **Step 1: Run the complete verification suite**

Run each command and require a zero exit code:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm test:e2e
```

- [ ] **Step 2: Inspect the final diff and repository state**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, no uncommitted changes, and only issue #60
commits.

- [ ] **Step 3: Request code review and resolve actionable findings**

Review both specification coverage and repository standards. For each valid
finding, add a failing regression test, verify RED, implement the minimum fix,
verify GREEN, and commit the correction.

- [ ] **Step 4: Re-run complete verification after review fixes**

Run the six commands from Step 1 again and require zero exit codes.

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin codex/issue-60-gap-aware-evidence
gh pr create --base main --head codex/issue-60-gap-aware-evidence --title "Show gap-aware Mythic boss evidence states" --body-file .github-pr-body.md
```

The PR body must include `Closes #60`, summarize the four-state evidence model,
state the no-log honesty rule and request bounds, list verification commands,
and identify the Node 24-versus-22 local engine warning if it remains.
