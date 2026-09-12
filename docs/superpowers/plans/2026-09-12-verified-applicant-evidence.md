# Verified Applicant Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute verified WCL first kills to their recorded guild and kill time, then derive Cutting Edge only from a source-reviewed raid catalogue.

**Architecture:** The WCL client supplies report guild and kill-end time. Domain owns immutable WCL zone/encounter metadata; only a successful catalogue lookup can create ordered boss evidence and a final-boss claim. Unmapped metadata produces a visible limitation.

**Tech Stack:** TypeScript, Vitest, Zod, Next.js, Warcraft Logs v2 GraphQL.

**Spec:** `docs/superpowers/specs/2026-09-12-verified-applicant-evidence-design.md`

## Global Constraints

- Never persist reports, evidence, or dossiers.
- Use `Report.guild` and `ReportFight.endTime`, never current character guilds or fight start time.
- Historic world rank remains `null`; never substitute WCL's current guild-zone rank.
- Only catalogue-supported raid zones may appear as Cutting Edge evidence.
- Preserve gathered evidence when a later WCL page fails.

---

## File structure

| File                                                    | Responsibility                                   |
| ------------------------------------------------------- | ------------------------------------------------ |
| `packages/domain/src/raid-tier-catalog.ts`              | Immutable supported WCL zone/encounter metadata. |
| `packages/domain/src/applicant-dossier.ts`              | Catalogue filtering before pure aggregation.     |
| `packages/warcraftlogs/src/client.ts`                   | Guild and boss-death-time query/parser.          |
| `packages/application/src/applicant-dossier-service.ts` | Contract-safe metadata limitation message.       |
| `apps/web/src/components/dossier-raid-list.tsx`         | First-kill guild and unknown-rank wording.       |

### Task 1: Add the domain raid-tier catalogue

**Files:**

- Create: `packages/domain/src/raid-tier-catalog.ts`
- Create: `packages/domain/src/raid-tier-catalog.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Produces: `lookupRaidEncounter(zoneId: string, encounterId: string): RaidEncounterMetadata | null`.
- Produces: `RaidEncounterMetadata = { raidId; raidName; bossId; bossName; bossOrder; isFinalBoss }`.

- [ ] **Step 1: Write the failing catalogue test**

```ts
it("maps a configured final encounter to ordered raid metadata", () => {
  expect(lookupRaidEncounter("42", "1234")).toEqual({
    raidId: "42",
    raidName: "Nerub-ar Palace",
    bossId: "1234",
    bossName: "Queen Ansurek",
    bossOrder: 8,
    isFinalBoss: true
  });
});
it("rejects a non-raid zone", () => {
  expect(lookupRaidEncounter("99999", "1234")).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @slashwho/domain test -- raid-tier-catalog.test.ts`

Expected: FAIL because the catalogue module does not exist.

- [ ] **Step 3: Implement the minimal immutable lookup**

```ts
export type RaidEncounterMetadata = Readonly<{
  raidId: string;
  raidName: string;
  bossId: string;
  bossName: string;
  bossOrder: number;
  isFinalBoss: boolean;
}>;
const entries: readonly RaidEncounterMetadata[] = [
  {
    raidId: "42",
    raidName: "Nerub-ar Palace",
    bossId: "1234",
    bossName: "Queen Ansurek",
    bossOrder: 8,
    isFinalBoss: true
  }
];
const byKey = new Map(
  entries.map((item) => [`${item.raidId}\0${item.bossId}`, item])
);
export function lookupRaidEncounter(zoneId: string, encounterId: string) {
  return byKey.get(`${zoneId}\0${encounterId}`) ?? null;
}
```

Add a source URL beside every shipped tier. Export the lookup from the domain index.

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm --filter @slashwho/domain test -- raid-tier-catalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/raid-tier-catalog.ts packages/domain/src/raid-tier-catalog.test.ts packages/domain/src/index.ts
git commit -m "feat: add raid tier catalogue"
```

### Task 2: Normalize WCL report guild and boss-death time

**Files:**

- Modify: `packages/warcraftlogs/src/client.ts`
- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.test.ts`

**Interfaces:**

- Produces: `WarcraftLogsFirstKillEvidence.guild: { name: string; realm: string } | null`.
- Produces: `killedAt = new Date(report.startTime + fight.endTime).toISOString()`.

- [ ] **Step 1: Write the failing WCL normalization tests**

```ts
it("attributes a kill to its report guild at boss death time", async () => {
  await expect(
    client.getFirstKillReports(key, { requestCap: 1 })
  ).resolves.toMatchObject({
    kind: "evidence",
    kills: [
      {
        killedAt: "2024-02-03T02:00:00.000Z",
        guild: { name: "Example Guild", realm: "silvermoon" }
      }
    ]
  });
});
it("keeps a public personal report valid when its guild is null", async () => {
  await expect(
    client.getFirstKillReports(key, { requestCap: 1 })
  ).resolves.toMatchObject({ kind: "evidence", kills: [{ guild: null }] });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @slashwho/warcraftlogs test -- client.test.ts`

Expected: FAIL because the client always returns a null guild and uses fight start time.

- [ ] **Step 3: Implement documented field parsing**

Add `guild { name server { slug } }` and `endTime` to `recentReportsQuery`. A null guild returns null; a non-null guild without both fields returns `schema_drift`. A missing or invalid `endTime` returns `schema_drift`. Use `reportStartTime + fightEndTime`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm --filter @slashwho/warcraftlogs test -- client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/warcraftlogs/src/client.ts packages/warcraftlogs/src/types.ts packages/warcraftlogs/src/client.test.ts
git commit -m "feat: attribute WCL kills to report guilds"
```

### Task 3: Filter evidence through catalogue metadata

**Files:**

- Modify: `packages/domain/src/applicant-dossier.ts`
- Modify: `packages/domain/src/applicant-dossier.test.ts`
- Modify: `packages/contracts/src/search.ts`
- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-dossier-service.test.ts`

**Interfaces:**

- Consumes: raw WCL `zoneId` / `encounterId` and `lookupRaidEncounter`.
- Produces: contract limitation code `raid_metadata_unknown`.

- [ ] **Step 1: Write failing domain and application tests**

```ts
it("does not emit a raid or Cutting Edge claim for unknown metadata", () => {
  const dossier = buildApplicantDossier({
    ...input,
    kills: [kill(root, { raidId: "99999", bossId: "1", isFinalBoss: false })]
  });
  expect(dossier.raids).toEqual([]);
  expect(dossier.limitations).toContainEqual(
    expect.objectContaining({
      source: "warcraft_logs",
      code: "raid_metadata_unknown"
    })
  );
});
```

Also assert a mapped final encounter gives `cuttingEdge: true`, while a mapped non-final encounter gives `null`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm --filter @slashwho/domain test -- applicant-dossier.test.ts; corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts`

Expected: FAIL because unrecognised WCL zone data is currently rendered directly.

- [ ] **Step 3: Implement catalogue filtering and visible disclosure**

Before grouping, resolve every raw kill through the catalogue. Omit an unknown entry and append one `raid_metadata_unknown` limitation per character/zone/encounter. Add that code to the strict contract schema and map it to: `Warcraft Logs raid metadata is not yet supported for this evidence, so it is not included in Cutting Edge results.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm --filter @slashwho/domain test -- applicant-dossier.test.ts; corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/applicant-dossier.ts packages/domain/src/applicant-dossier.test.ts packages/contracts/src/search.ts packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts
git commit -m "feat: derive Cutting Edge from raid metadata"
```

### Task 4: Clarify rendered evidence provenance

**Files:**

- Modify: `apps/web/src/components/dossier-raid-list.tsx`
- Modify: `apps/web/src/components/dossier-view.test.tsx`

**Interfaces:**

- Consumes: unchanged `ApplicantDossier`.
- Produces: visible `First-kill guild` and `World rank: unknown` copy.

- [ ] **Step 1: Write the failing component assertion**

```tsx
expect(screen.getByText("First-kill guild")).toBeVisible();
expect(screen.getByText("Example Guild · silvermoon")).toBeVisible();
expect(screen.getAllByText("World rank: unknown").length).toBeGreaterThan(0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @slashwho/web test -- dossier-view.test.tsx`

Expected: FAIL because the current label says `Guild` and null rank renders as an em dash.

- [ ] **Step 3: Implement explicit copy**

Change `Guild` to `First-kill guild`. Render null rank as `World rank: unknown`; retain `World #<rank>` if an authoritative source supplies a numeric rank later.

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm --filter @slashwho/web test -- dossier-view.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dossier-raid-list.tsx apps/web/src/components/dossier-view.test.tsx
git commit -m "fix: clarify dossier evidence provenance"
```

### Task 5: Verify and deploy

- [ ] **Step 1: Run repository checks**

Run: `corepack pnpm test:unit; corepack pnpm lint; corepack pnpm typecheck`

Expected: all commands exit 0.

- [ ] **Step 2: Run a credential-safe live WCL diagnostic**

Run: `railway run --service web --environment test corepack pnpm exec tsx -e "/* print only kill count, guild presence, and limitation code */"`

Expected: normalized evidence has report guilds where public logs declare them; unmapped zones produce visible limitations.

- [ ] **Step 3: Deploy and smoke-test the public dossier**

Run: `railway up --service web --environment test --detach --json --message "Add verified applicant kill evidence"`

Request: `GET /api/dossiers/eu/tarren-mill/lavalarryy`.

Expected: catalogue-supported raid sections show first-kill guilds and boss-death dates; unsupported zones are explicit limitations; historic rank remains unknown.

## Plan self-review

- Tasks 1 and 3 cover catalogue/final-boss CE evidence and non-raid exclusion; Task 2 covers documented guild/time fields; Task 4 covers user-facing honesty; Task 5 validates the deployed service.
- Historic world rank is deliberately excluded by the global constraints because the verified provider cannot provide it.
- Each introduced type or limitation has a producing task before its consuming task.
