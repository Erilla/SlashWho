# Official raid artwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show optional first-party Blizzard artwork beside historic Mythic raids and bosses.

**Architecture:** Extend the generated Blizzard Journal catalogue with optional raid-tile and primary-creature zoom URLs. Preserve those nullable values through the domain and API contract, then conditionally render them in the dossier evidence list.

**Tech Stack:** TypeScript, Vitest, Zod, Next.js/React, Blizzard static Game Data API.

**Spec:** `docs/superpowers/specs/2026-09-12-official-raid-artwork-design.md`

## Global Constraints

- Use only first-party Blizzard image URLs.
- Raid media is `media/journal-instance/{id}` asset `tile`.
- Boss media is `media/creature-display/{id}` asset `zoom` for the exact-name Journal encounter creature.
- Missing or malformed media is `null`, never an error, guessed asset, or third-party substitute.
- Render no image element or empty-image container when its URL is null.
- Use `${raid.raidName} artwork` and `${boss.bossName} artwork` as image alt text.

---

### Task 1: Generate official artwork metadata

**Files:**

- Modify: `scripts/raid-catalogue.mts`
- Modify: `scripts/raid-catalogue.test.mts`
- Modify: `scripts/generate-raid-catalogue.mts`

**Interfaces:**

- Produces `GeneratedJournalRaid.imageUrl: string | null`.
- Produces `GeneratedJournalEncounter.imageUrl: string | null`.

- [ ] **Step 1: Write failing catalogue tests**

```ts
expect(await fetchJournalRaids(options)).resolves.toEqual([
  {
    journalRaidId: "1273",
    raidName: "Nerub-ar Palace",
    imageUrl: "https://render.example/raids/nerub-ar.jpg",
    encounters: [
      {
        journalBossId: "2602",
        bossName: "Queen Ansurek",
        bossOrder: 1,
        imageUrl: "https://render.example/bosses/ansurek.jpg"
      }
    ]
  }
]);
```

Add fixtures proving a non-matching creature name and a matching creature with no `zoom` asset both result in `imageUrl: null`.

- [ ] **Step 2: Run the test red**

Run: `corepack pnpm vitest run scripts/raid-catalogue.test.mts`

Expected: FAIL because the generator neither reads media nor returns image URLs.

- [ ] **Step 3: Implement minimal static media enrichment**

Keep `normalizeJournalRaid` focused on instance validation. In `fetchJournalRaids`, request the valid instance tile; for each encounter request its Journal data, find the creature whose name exactly equals the encounter name, then request that creature display media and take only the `zoom` asset. Invalid optional shapes resolve to `null`; required Journal traversal still fails normally.

- [ ] **Step 4: Run the test green**

Run: `corepack pnpm vitest run scripts/raid-catalogue.test.mts`

Expected: PASS for tile, exact-match zoom render, and both null fallbacks.

- [ ] **Step 5: Commit**

```bash
git add scripts/raid-catalogue.mts scripts/raid-catalogue.test.mts scripts/generate-raid-catalogue.mts
git commit -m "feat: generate official raid artwork metadata"
```

### Task 2: Propagate nullable artwork through dossier data

**Files:**

- Modify: `packages/domain/src/raid-catalogue.ts`
- Modify: `packages/domain/src/raid-catalogue.test.ts`
- Modify: `packages/domain/src/applicant-dossier.ts`
- Modify: `packages/domain/src/applicant-dossier.test.ts`
- Modify: `packages/contracts/src/dossier.ts`
- Modify: `packages/contracts/src/contracts.test.ts`

**Interfaces:**

- Consumes generated `imageUrl` fields from Task 1.
- Produces nullable `imageUrl` fields on `ApplicantDossierRaid` and `ApplicantDossierBoss`.

- [ ] **Step 1: Write failing propagation and schema tests**

```ts
expect(lookupJournalEncounter("2602")).toMatchObject({
  imageUrl: expect.stringMatching(/^https:\/\//)
});
expect(buildApplicantDossier(input).raids[0]).toMatchObject({
  imageUrl: expect.any(String),
  bosses: [expect.objectContaining({ imageUrl: expect.any(String) })]
});
expect(() =>
  applicantDossierSchema.parse({
    ...validDossier,
    raids: [{ ...validDossier.raids[0], imageUrl: 42 }]
  })
).toThrow();
```

Add an unmapped WCL kill fixture and assert its raid and boss image URLs are literal `null`.

- [ ] **Step 2: Run the test red**

Run: `corepack pnpm vitest run --project unit packages/domain/src/raid-catalogue.test.ts packages/domain/src/applicant-dossier.test.ts packages/contracts/src/contracts.test.ts`

Expected: FAIL because optional image URLs are not part of the lookup, output, or Zod schema.

- [ ] **Step 3: Add the nullable fields**

Map each generated URL through `lookupJournalEncounter` and `lookupRaidByName`. Add nullable image URLs to the dossier output types and Zod schemas. Apply metadata values to mapped kills and set `null` for unmapped WCL groups.

- [ ] **Step 4: Run the test green**

Run: `corepack pnpm vitest run --project unit packages/domain/src/raid-catalogue.test.ts packages/domain/src/applicant-dossier.test.ts packages/contracts/src/contracts.test.ts`

Expected: PASS, including literal null fallback and rejected non-string URLs.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/raid-catalogue.ts packages/domain/src/raid-catalogue.test.ts packages/domain/src/applicant-dossier.ts packages/domain/src/applicant-dossier.test.ts packages/contracts/src/dossier.ts packages/contracts/src/contracts.test.ts
git commit -m "feat: expose optional dossier artwork"
```

### Task 3: Render accessible, resilient artwork

**Files:**

- Modify: `apps/web/src/components/dossier-raid-list.tsx`
- Create: `apps/web/src/components/dossier-raid-list.test.tsx`
- Modify: `apps/web/src/components/dossier-view.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- Consumes nullable image URLs from Task 2.
- Produces image elements only when an image URL exists.

- [ ] **Step 1: Write failing component tests**

```tsx
render(<DossierRaidList raids={[raidWithArtwork]} />);
expect(screen.getByAltText("Nerub-ar Palace artwork")).toHaveAttribute(
  "src",
  "https://render.example/raids/nerub-ar.jpg"
);
expect(screen.getByAltText("Queen Ansurek artwork")).toHaveAttribute(
  "src",
  "https://render.example/bosses/ansurek.jpg"
);

render(<DossierRaidList raids={[raidWithoutArtwork]} />);
expect(screen.queryByRole("img")).not.toBeInTheDocument();
expect(screen.getByText("Queen Ansurek")).toBeVisible();
```

- [ ] **Step 2: Run the test red**

Run: `corepack pnpm vitest run --project unit apps/web/src/components/dossier-raid-list.test.tsx`

Expected: FAIL because historic evidence contains no images.

- [ ] **Step 3: Add conditional presentation**

Render a small raid tile next to the raid heading and a square boss render next to each boss heading. Use standard `<img>` tags with the required alt text, `loading="lazy"`, and image-only wrappers created conditionally. Add compact `object-fit: cover` CSS without changing evidence disclosure behavior.

- [ ] **Step 4: Run the test green**

Run: `corepack pnpm vitest run --project unit apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-view.test.tsx`

Expected: PASS for exact alt/source values and absent-art text layout.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/dossier-raid-list.tsx apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-view.test.tsx apps/web/src/app/globals.css
git commit -m "feat: show official dossier raid artwork"
```

### Task 4: Refresh, verify, and deploy

**Files:**

- Modify: `packages/domain/src/raid-catalogue.generated.json`

**Interfaces:**

- Consumes Task 1 generator and configured Blizzard credentials.
- Produces committed current official media URLs.

- [ ] **Step 1: Regenerate the catalogue**

Run the catalogue generator with `SLASHWHO_RAID_CATALOGUE_OUTPUT=packages/domain/src/raid-catalogue.generated.json`. Read credentials from configured environment only; do not print them or authorization headers.

- [ ] **Step 2: Verify all project checks**

Run: `corepack pnpm test:unit && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && git diff --check`

Expected: every command exits 0. Inspect the generated diff to ensure artwork URLs are only nullable fields attached to valid Journal raids and encounters.

- [ ] **Step 3: Commit the refreshed catalogue**

```bash
git add packages/domain/src/raid-catalogue.generated.json
git commit -m "chore: refresh raid artwork catalogue"
```

- [ ] **Step 4: Deploy and live check**

Run: `railway up --service web --environment test --detach --json`

Wait for Railway deployment status `SUCCESS`, then request `https://web-test-7765.up.railway.app/api/dossiers/eu/tarren-mill/lavalarryy` and confirm the payload validates, returns optional artwork URLs, and preserves its existing evidence.
