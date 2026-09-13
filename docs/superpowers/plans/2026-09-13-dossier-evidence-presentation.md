# Applicant Dossier Evidence Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present applicant evidence in ordered panels with official achievement icons, linked class-coloured characters, complete Mythic history, and verifiable historical boss ranks.

**Architecture:** Generate icon metadata first, then add a bounded Raider.IO boss-ranking gateway. The application matches that enrichment strictly to WCL evidence; the domain owns aggregation/order and React renders the resulting contract.

**Tech Stack:** TypeScript, Zod, Vitest, React Testing Library, Playwright, Next.js, Blizzard static API, Raider.IO API.

**Spec:** `docs/superpowers/specs/2026-09-13-dossier-evidence-presentation-design.md`

## Global Constraints

- Never infer historic rank from WCL's current guild-zone rank.
- Match Raider.IO by boss, guild, region, realm/connected realm, and two-minute timestamp tolerance.
- Leave ranks unknown outside top 50, pre-Emerald Nightmare coverage, or ambiguous matches.
- Cache documented Raider.IO API requests per boss and display attribution.
- Browser icon URLs must be public Blizzard Render URLs; credentials remain server-side.

---

### Task 1: Generate Cutting Edge icon metadata

**Files:** `scripts/cutting-edge-catalogue.mts`, `scripts/cutting-edge-catalogue.test.mts`, `packages/domain/src/cutting-edge-catalogue.ts`, `packages/domain/src/cutting-edge-catalogue.test.ts`, `packages/domain/src/cutting-edge-catalogue.generated.json`.

**Produces:** `lookupCuttingEdgeAchievement(id)` includes `iconUrl: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
expect(await fetchCuttingEdgeAchievements(options)).toContainEqual(
  expect.objectContaining({
    achievementId: "40254",
    iconUrl: "https://render.example/icon.jpg"
  })
);
```

- [ ] **Step 2: Verify red**

Run: `corepack pnpm vitest run scripts/cutting-edge-catalogue.test.mts`

Expected: FAIL because no icon URL is generated.

- [ ] **Step 3: Implement minimal media lookup**

```ts
const media = await jsonRequest(
  new URL(`/data/wow/media/achievement/${id}`, baseUrl)
);
const iconUrl = mediaAsset(media, "icon");
return {
  achievementId: String(id),
  achievementName: name,
  description,
  iconUrl
};
```

Use the existing token; accept only an `icon` URL and retain null when absent.

- [ ] **Step 4: Verify green**

Run: `corepack pnpm vitest run scripts/cutting-edge-catalogue.test.mts packages/domain/src/cutting-edge-catalogue.test.ts`

Expected: PASS with populated and null icon fixtures.

- [ ] **Step 5: Commit**

Commit message: `feat: generate Cutting Edge icon metadata`.

### Task 2: Fetch bounded Raider.IO boss rankings

**Files:** `packages/raiderio/src/types.ts`, `packages/raiderio/src/client.ts`, `packages/raiderio/src/client.test.ts`, `packages/raiderio/src/index.ts`.

**Produces:** `getMythicBossRankings({ raidSlug, bossSlug }, signal)` with rank, guild identity, realm, and first-defeat timestamp rows.

- [ ] **Step 1: Write failing client tests**

```ts
await expect(
  gateway.getMythicBossRankings({
    raidSlug: "nerubar-palace",
    bossSlug: "queen-ansurek"
  })
).resolves.toMatchObject({
  kind: "rankings",
  rows: [{ rank: 2, guildName: "Echo" }]
});
```

Include HTTP 429 -> `rate_limited` and malformed row -> `schema_drift`.

- [ ] **Step 2: Verify red**

Run: `corepack pnpm vitest run packages/raiderio/src/client.test.ts`

Expected: FAIL because the gateway method is absent.

- [ ] **Step 3: Implement request and cache**

```ts
const url = new URL("/api/v1/raiding/boss-rankings", baseUrl);
url.search = new URLSearchParams({
  raid: raidSlug,
  boss: bossSlug,
  difficulty: "mythic",
  region: "world"
}).toString();
```

Validate positive rank and ISO time; cache successful results by `raidSlug + "\0" + bossSlug`, not failures.

- [ ] **Step 4: Verify green**

Run: `corepack pnpm vitest run packages/raiderio/src/client.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: read Raider.IO historical boss rankings`.

### Task 3: Build the expanded, ordered dossier contract

**Files:** `packages/domain/src/applicant-dossier.ts`, `packages/domain/src/applicant-dossier.test.ts`, `packages/contracts/src/dossier.ts`, `packages/application/src/applicant-dossier-service.ts`, `packages/application/src/applicant-dossier-service.test.ts`.

**Produces:** Class-aware characters, achievement icons, all distinct kills, merged earliest Cutting Edge records, and rank enrichment.

- [ ] **Step 1: Write failing domain tests**

```ts
expect(dossier.cuttingEdges).toEqual([
  expect.objectContaining({
    achievementId: "40254",
    completedAt: "2025-01-14T20:30:00.000Z",
    characters: ["Ryii", "Ryalts"]
  })
]);
expect(dossier.raids[0]!.bosses.map((boss) => boss.bossName)).toEqual([
  "Queen Ansurek",
  "Sikran"
]);
expect(dossier.raids[0]!.bosses[0]!.firstKills).toHaveLength(2);
```

Use two distinct dated reports for one character/boss and one shared report for two characters.

- [ ] **Step 2: Verify red**

Run: `corepack pnpm vitest run packages/domain/src/applicant-dossier.test.ts`

Expected: FAIL because current aggregation keeps one kill per character/boss and sorts alphabetically.

- [ ] **Step 3: Implement aggregation and enrichment**

Coalesce Cutting Edge by achievement ID using minimum completion plus unioned characters. Retain each report URL (or per-character timestamp fallback), sort details oldest-first, bosses final-first then descending encounter order, and raids by catalogue recency. Propagate class/url fields. Assign rank only after strict Raider.IO row matching; mismatched realm/time remains null.

- [ ] **Step 4: Verify green**

Run: `corepack pnpm vitest run packages/domain/src/applicant-dossier.test.ts packages/application/src/applicant-dossier-service.test.ts packages/contracts/src/dossier.test.ts`

Expected: PASS, including class URL, rank 2, and null rank mismatch cases.

- [ ] **Step 5: Commit**

Commit message: `feat: order and enrich dossier evidence`.

### Task 4: Render panels, achievement cards, and kill details

**Files:** `apps/web/src/components/dossier-character-list.tsx`, `dossier-character-list.test.tsx`, `dossier-cutting-edge-list.tsx`, `dossier-cutting-edge-list.test.tsx`, `dossier-raid-list.tsx`, `dossier-raid-list.test.tsx`, `apps/web/src/app/globals.css`.

**Produces:** Distinct panels, full-width Mythic panel, class-coloured Raider.IO links, modern icon cards, and chronological disclosure rows.

- [ ] **Step 1: Write failing component tests**

```tsx
expect(screen.getByRole("link", { name: "Ryii" })).toHaveAttribute(
  "href",
  "https://raider.io/characters/eu/silvermoon/ryii"
);
expect(screen.getByAltText("Cutting Edge: Queen Ansurek icon")).toHaveAttribute(
  "src",
  "https://render.example/40254.jpg"
);
expect(screen.getByText("View kill evidence")).toBeVisible();
```

Assert date/characters in the boss headline and detail dates oldest-first.

- [ ] **Step 2: Verify red**

Run: `corepack pnpm vitest run apps/web/src/components/dossier-character-list.test.tsx apps/web/src/components/dossier-cutting-edge-list.test.tsx apps/web/src/components/dossier-raid-list.test.tsx`

Expected: FAIL for missing links, card icon, headline metadata, and new disclosure copy.

- [ ] **Step 3: Implement markup and CSS**

Use `dossier-panel` for sections and full grid span for Mythic evidence. Give Connected characters/Cutting Edge equal scrollable minimum height. Use an explicit WoW class colour map with ordinary-link fallback; render the selected modern dark card with gold title and nullable icon.

- [ ] **Step 4: Verify green**

Run: `corepack pnpm vitest run apps/web/src/components/dossier-character-list.test.tsx apps/web/src/components/dossier-cutting-edge-list.test.tsx apps/web/src/components/dossier-raid-list.test.tsx && corepack pnpm playwright test tests/e2e/responsive.spec.ts`

Expected: PASS without horizontal overflow.

- [ ] **Step 5: Commit**

Commit message: `feat: present ordered applicant evidence panels`.

### Task 5: Verify the whole applicant journey

**Files:** `tests/e2e/search.spec.ts`, `tests/e2e/support/fake-raiderio.ts`.

- [ ] **Step 1: Write failing browser assertions**

```ts
await expect(page.getByRole("link", { name: "Ryii" })).toHaveAttribute(
  "href",
  /raider\.io\/characters\/eu\/silvermoon\/ryii$/
);
await expect(page.getByText("View kill evidence")).toBeVisible();
```

Make fake boss rankings match the WCL guild/time and return rank 147.

- [ ] **Step 2: Verify red then green**

Run: `corepack pnpm playwright test tests/e2e/search.spec.ts`

Expected: FAIL before Tasks 1-4, then PASS.

- [ ] **Step 3: Run release verification and commit**

Run: `corepack pnpm format:check && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test:unit && corepack pnpm test:integration && corepack pnpm build && corepack pnpm playwright test tests/e2e/search.spec.ts`

Expected: all commands PASS.

Commit message: `test: cover dossier evidence presentation`.
