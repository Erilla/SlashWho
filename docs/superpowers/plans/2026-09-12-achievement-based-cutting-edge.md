# Achievement-Based Cutting Edge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show verified public Blizzard Cutting Edge achievements separately from Warcraft Logs boss evidence in each applicant dossier.

**Architecture:** A checked-in Blizzard static-data snapshot defines the eligible Cutting Edge achievement IDs. A server-only Blizzard profile client returns completed IDs and timestamps; the application intersects that transient data with the snapshot and the domain aggregates it for the contract/UI. Warcraft Logs remains the independent source of boss, guild, and report facts.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js, Blizzard Profile and Game Data APIs, Railway.

**Spec:** `docs/superpowers/specs/2026-09-12-achievement-based-cutting-edge-design.md`

## Global Constraints

- Treat only a finite numeric `completed_timestamp` as proof of completion; never use `criteria.is_completed`.
- Only static category `15271` entries whose English name starts `Cutting Edge:` are catalogue entries.
- Keep credentials server-only and configure `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` on the Railway web service before deploying.
- Never persist profile responses, completion IDs, completion timestamps, or dossier results.
- Do not infer a CE achievement from WCL evidence or an achievement title; historic world rank remains null.
- A Blizzard profile failure is unknown evidence, not a negative CE claim.

---

### Task 1: Generate a versioned Cutting Edge catalogue

**Files:**

- Create: `scripts/cutting-edge-catalogue.mts`
- Create: `scripts/cutting-edge-catalogue.test.ts`
- Create: `scripts/generate-cutting-edge-catalogue.mts`
- Create: `packages/domain/src/cutting-edge-catalogue.generated.json`
- Modify: `package.json`

**Interfaces:**

- Produces `GeneratedCuttingEdgeAchievement = { achievementId: string; achievementName: string; description: string; categoryId: "15271" }`.
- Produces `fetchCuttingEdgeAchievements(options): Promise<readonly GeneratedCuttingEdgeAchievement[]>`.
- The generated JSON has `{ source: "blizzard-achievement-category"; generatedAt: string; region: string; locale: "en_GB"; achievements: GeneratedCuttingEdgeAchievement[] }`.

- [ ] **Step 1: Write failing generator tests**

```ts
it("keeps only Feats of Strength Raid achievements whose names begin Cutting Edge:", async () => {
  await expect(fetchCuttingEdgeAchievements(fixtureOptions)).resolves.toEqual([
    {
      achievementId: "40254",
      achievementName: "Cutting Edge: Queen Ansurek",
      description:
        "Defeat Queen Ansurek in Nerub-ar Palace on Mythic Difficulty before the release of the next raid tier.",
      categoryId: "15271"
    }
  ]);
});

it("rejects a Raids category that is not a Feats of Strength child", async () => {
  await expect(fetchCuttingEdgeAchievements(badParentOptions)).rejects.toThrow(
    "cutting_edge_category_parent_invalid"
  );
});
```

- [ ] **Step 2: Run the generator tests and verify they fail**

Run: `corepack pnpm exec vitest run scripts/cutting-edge-catalogue.test.ts`

Expected: FAIL because the module and exported function do not exist.

- [ ] **Step 3: Implement static category traversal and strict normalization**

```ts
export async function fetchCuttingEdgeAchievements(
  options: FetchCuttingEdgeAchievementsOptions
): Promise<readonly GeneratedCuttingEdgeAchievement[]> {
  const feats = await jsonRequest(options, "/data/wow/achievement-category/81");
  const raids = await jsonRequest(
    options,
    "/data/wow/achievement-category/15271"
  );
  if (raids.parent_category?.id !== 81) {
    throw new Error("cutting_edge_category_parent_invalid");
  }
  return await Promise.all(
    raids.achievements
      .filter((entry) => entry.name.startsWith("Cutting Edge:"))
      .map((entry) => fetchAchievementDefinition(options, entry.id))
  );
}
```

Validate every ID, name, category ID, and description before emitting it; sort by numeric ID for deterministic output.

- [ ] **Step 4: Verify generator tests pass**

Run: `corepack pnpm exec vitest run scripts/cutting-edge-catalogue.test.ts`

Expected: PASS.

- [ ] **Step 5: Add a credentialed generator command and create the snapshot**

Use the same OAuth and `static-${region}` request conventions as `scripts/generate-raid-catalogue.mts`. Add a package script named `generate:cutting-edge-catalogue`; it writes `packages/domain/src/cutting-edge-catalogue.generated.json` when `SLASHWHO_CUTTING_EDGE_CATALOGUE_OUTPUT` is set. Run it with the existing Railway worker credentials and inspect its summary only (no raw credentials or profile data).

- [ ] **Step 6: Commit the self-contained catalogue work**

```bash
git add scripts/cutting-edge-catalogue.mts scripts/cutting-edge-catalogue.test.ts scripts/generate-cutting-edge-catalogue.mts packages/domain/src/cutting-edge-catalogue.generated.json package.json
git commit -m "feat: generate Cutting Edge achievement catalogue"
```

### Task 2: Expose completed achievement evidence from the Blizzard client

**Files:**

- Modify: `packages/blizzard/src/types.ts`
- Modify: `packages/blizzard/src/client.ts`
- Modify: `packages/blizzard/src/client.test.ts`
- Modify: `packages/blizzard/src/index.ts`

**Interfaces:**

- Produces `CompletedAchievement = { achievementId: string; completedAt: string }`.
- Adds `BlizzardGateway.getCompletedAchievements(key, signal?, onProfileRequest?): Promise<readonly CompletedAchievement[]>`.

- [ ] **Step 1: Write failing client tests**

```ts
it("returns only achievement entries with numeric IDs and completion timestamps", async () => {
  const completed = await gateway.getCompletedAchievements(character);
  expect(completed).toEqual([
    { achievementId: "40254", completedAt: "2025-01-14T20:30:00.000Z" }
  ]);
});

it("does not use criteria completion when the timestamp is present", async () => {
  await expect(
    gateway.getCompletedAchievements(character)
  ).resolves.toContainEqual({
    achievementId: "40254",
    completedAt: "2025-01-14T20:30:00.000Z"
  });
});
```

- [ ] **Step 2: Run client tests and verify the new tests fail**

Run: `corepack pnpm --filter @slashwho/blizzard test -- client.test.ts`

Expected: FAIL because `getCompletedAchievements` is not defined.

- [ ] **Step 3: Add a purpose-specific profile normalizer and gateway method**

```ts
function completedAchievementsFromResponse(
  value: unknown
): readonly CompletedAchievement[] | null {
  const achievements = valueRecord(value)?.achievements;
  if (!Array.isArray(achievements)) return null;
  return achievements.flatMap((entry) => {
    const id = finiteNumber(valueRecord(entry)?.id);
    const timestamp = finiteNumber(valueRecord(entry)?.completed_timestamp);
    return id !== null && timestamp !== null
      ? [
          {
            achievementId: String(id),
            completedAt: new Date(timestamp).toISOString()
          }
        ]
      : [];
  });
}
```

Use the existing `achievementsUrl`, error mapping, OAuth cache, abort handling, and request observer. Keep the fingerprint method unchanged.

- [ ] **Step 4: Verify Blizzard tests pass**

Run: `corepack pnpm --filter @slashwho/blizzard test -- client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the client API**

```bash
git add packages/blizzard/src/types.ts packages/blizzard/src/client.ts packages/blizzard/src/client.test.ts packages/blizzard/src/index.ts
git commit -m "feat: read completed Blizzard achievements"
```

### Task 3: Aggregate Cutting Edge evidence in domain and contract layers

**Files:**

- Create: `packages/domain/src/cutting-edge-catalogue.ts`
- Create: `packages/domain/src/cutting-edge-catalogue.test.ts`
- Modify: `packages/domain/src/applicant-dossier.ts`
- Modify: `packages/domain/src/applicant-dossier.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/contracts/src/dossier.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces `DossierCuttingEdgeEvidence = { achievementId: string; completedAt: string; character: CharacterKey }`.
- Adds `cuttingEdges: readonly ApplicantDossierCuttingEdge[]` to domain and contract dossiers.
- `ApplicantDossierCuttingEdge = { achievementId: string; achievementName: string; description: string; completedAt: string; characters: readonly string[] }`.

- [ ] **Step 1: Write failing domain and contract tests**

```ts
it("groups the same completed Cutting Edge achievement across characters", () => {
  expect(buildApplicantDossier(input).cuttingEdges).toEqual([
    {
      achievementId: "40254",
      achievementName: "Cutting Edge: Queen Ansurek",
      description: expect.stringContaining("Nerub-ar Palace"),
      completedAt: "2025-01-14T20:30:00.000Z",
      characters: ["Ryii", "Ryalts"]
    }
  ]);
});

it("rejects a dossier that omits cuttingEdges", () => {
  expect(() =>
    applicantDossierSchema.parse(dossierWithoutCuttingEdges)
  ).toThrow();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `corepack pnpm --filter @slashwho/domain test -- applicant-dossier.test.ts && corepack pnpm --filter @slashwho/contracts test -- contracts.test.ts`

Expected: FAIL because the input and response types do not include Cutting Edge records.

- [ ] **Step 3: Implement catalogue lookup and deterministic grouping**

Load `cutting-edge-catalogue.generated.json` in a focused lookup module. Ignore evidence IDs absent from the catalogue. In `buildApplicantDossier`, group valid records by achievement ID plus completion timestamp, gather display names from input characters, and sort records by `completedAt` then `achievementId`. Do not alter the existing WCL raid grouping or use `isFinalBoss` to set CE.

- [ ] **Step 4: Add strict Zod schemas and exports**

```ts
export const dossierCuttingEdgeSchema = z
  .object({
    achievementId: z.string().regex(/^\d+$/),
    achievementName: z.string().min(1),
    description: z.string().min(1),
    completedAt: z.iso.datetime(),
    characters: z.array(z.string().min(1)).min(1)
  })
  .strict();
```

Require `cuttingEdges` in `applicantDossierSchema` and update all fixtures.

- [ ] **Step 5: Verify domain and contract tests pass**

Run: `corepack pnpm --filter @slashwho/domain test -- applicant-dossier.test.ts cutting-edge-catalogue.test.ts && corepack pnpm --filter @slashwho/contracts test -- contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit domain and contract work**

```bash
git add packages/domain packages/contracts
git commit -m "feat: add dossier Cutting Edge evidence"
```

### Task 4: Gather per-character CE evidence in the dossier service and web container

**Files:**

- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-dossier-service.test.ts`
- Modify: `apps/web/src/server/config.ts`
- Modify: `apps/web/src/server/config.test.ts`
- Modify: `apps/web/src/server/container.ts`
- Modify: `apps/web/src/server/container.test.ts`

**Interfaces:**

- `ApplicantDossierService` accepts `blizzard: Pick<BlizzardGateway, "getCompletedAchievements">`.
- Contract limitation source adds `blizzard`; existing limitation codes remain the typed public status.
- `WebConfig.dossier` gains `blizzardClientId` and `blizzardClientSecret`.

- [ ] **Step 1: Write failing application tests**

```ts
it("retains Warcraft Logs evidence when one Blizzard achievement profile is unavailable", async () => {
  vi.mocked(blizzard.getCompletedAchievements).mockRejectedValueOnce(
    Object.assign(new Error("blizzard_transient"), { kind: "transient" })
  );
  await expect(dossiers.read(root)).resolves.toMatchObject({
    kind: "ready",
    dossier: {
      raids: [{ raidId: "1273" }],
      limitations: [
        { source: "blizzard", character: root, code: "unavailable" }
      ]
    }
  });
});
```

Also add a config test that rejects absent Blizzard credentials and a container test proving it creates the Blizzard gateway without exposing it to route/client code.

- [ ] **Step 2: Run tests and verify they fail**

Run: `corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts && corepack pnpm --filter web test -- server/config.test.ts server/container.test.ts`

Expected: FAIL because no dossier Blizzard dependency or public `blizzard` limitation source exists.

- [ ] **Step 3: Implement bounded concurrent gathering and limitation mapping**

For each selected subject, start `warcraftLogs.getFirstKillReports` and `blizzard.getCompletedAchievements` under the existing shared timeout signal. Convert Blizzard typed failures to per-character limitations, preserving successful achievement evidence from other subjects and all WCL evidence. Pass only normalized `{ achievementId, completedAt, character }` records to `buildApplicantDossier`.

Add the `blizzard` copy in `limitationMessage`, such as `Blizzard achievement evidence could not be read; Cutting Edge status is unknown for this character.`

- [ ] **Step 4: Wire server-only credentials**

Use `createBlizzardClient` in `createWebContainer`, with values loaded from `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET`. Update all config/container fixtures; do not expose either property from any API response.

- [ ] **Step 5: Verify application and web server tests pass**

Run: `corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts && corepack pnpm --filter web test -- server/config.test.ts server/container.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit service and container wiring**

```bash
git add packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts apps/web/src/server/config.ts apps/web/src/server/config.test.ts apps/web/src/server/container.ts apps/web/src/server/container.test.ts
git commit -m "feat: gather dossier Cutting Edge achievements"
```

### Task 5: Render official CE results separately from boss evidence

**Files:**

- Create: `apps/web/src/components/dossier-cutting-edge-list.tsx`
- Create: `apps/web/src/components/dossier-cutting-edge-list.test.tsx`
- Modify: `apps/web/src/components/dossier-raid-list.tsx`
- Modify: `apps/web/src/components/dossier-view.test.tsx`
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- `DossierCuttingEdgeList({ cuttingEdges })` renders contract `cuttingEdges`.
- `DossierRaidList` is titled `Historic Mythic boss evidence` and does not make CE claims.

- [ ] **Step 1: Write failing component tests**

```tsx
it("renders an official Cutting Edge achievement with date and characters", () => {
  render(<DossierCuttingEdgeList cuttingEdges={[cuttingEdge]} />);
  expect(
    screen.getByRole("heading", { name: "Historic Cutting Edge" })
  ).toBeVisible();
  expect(screen.getByText("Cutting Edge: Queen Ansurek")).toBeVisible();
  expect(screen.getByText("Ryii, Ryalts")).toBeVisible();
});

it("labels Warcraft Logs results as Mythic boss evidence", () => {
  render(<DossierRaidList raids={raids} />);
  expect(
    screen.getByRole("heading", { name: "Historic Mythic boss evidence" })
  ).toBeVisible();
});
```

- [ ] **Step 2: Run UI tests and verify they fail**

Run: `corepack pnpm --filter web test -- components/dossier-cutting-edge-list.test.tsx components/dossier-view.test.tsx app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

Expected: FAIL because the CE component and contract property do not exist.

- [ ] **Step 3: Implement accessible CE rendering**

Render the official name as each item heading; show the completion date in UTC, description, and the participating character names. The empty state must say `No public Cutting Edge achievements were found.` Do not present it as proof that a character never earned CE. Keep source failure details in the existing limitations list.

- [ ] **Step 4: Render both evidence sections from the page client**

```tsx
<DossierCharacterList characters={dossier.characters} />
<DossierCuttingEdgeList cuttingEdges={dossier.cuttingEdges} />
<DossierRaidList raids={dossier.raids} />
<DossierLimitations limitations={dossier.limitations} />
```

Update test fixtures to include `cuttingEdges`, change the legacy CE heading assertion to the new boss-evidence heading, and use small existing dossier layout styles for the new list.

- [ ] **Step 5: Verify UI tests pass**

Run: `corepack pnpm --filter web test -- components/dossier-cutting-edge-list.test.tsx components/dossier-view.test.tsx app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit UI work**

```bash
git add apps/web/src/components apps/web/src/app/dossiers apps/web/src/app/globals.css
git commit -m "feat: render verified Cutting Edge achievements"
```

### Task 6: Verify, configure Railway, deploy, and inspect the live dossier

**Files:**

- Modify: `README.md` only if it already documents Railway web-service variables.

- [ ] **Step 1: Run the complete local quality gate**

Run: `corepack pnpm test:unit && corepack pnpm lint && corepack pnpm typecheck`

Expected: all tests, lint, and type checks pass. Investigate and correct any failure before deployment.

- [ ] **Step 2: Confirm web-service credentials without printing their values**

Run: `railway variable list --service web --environment test --json | ConvertFrom-Json | Select-Object -ExpandProperty PSObject | Select-Object -ExpandProperty Properties | Where-Object Name -in 'BLIZZARD_CLIENT_ID','BLIZZARD_CLIENT_SECRET' | Select-Object Name`

Expected: both names appear. If they are absent, copy the existing worker values to the web service using Railway's variable tooling; never display the secret values.

- [ ] **Step 3: Deploy the web service**

Run: `railway up --service web --environment test --detach --json --message "Add verified Cutting Edge achievements"`

Expected: a deployment ID.

- [ ] **Step 4: Verify deployment health and live data shape**

Poll `railway deployment list --service web --environment test --json` until the new deployment is `SUCCESS`, then request `https://web-test-7765.up.railway.app/api/dossiers/eu/tarren-mill/lavalarryy`. Validate the strict response schema and confirm that `cuttingEdges` is an array, WCL raid evidence still appears when available, and no secret or raw achievement payload appears in the response.

- [ ] **Step 5: Commit any documentation-only variable guidance**

```bash
git add README.md
git commit -m "docs: configure dossier Blizzard credentials"
```

Skip this commit if README.md did not need a change.
