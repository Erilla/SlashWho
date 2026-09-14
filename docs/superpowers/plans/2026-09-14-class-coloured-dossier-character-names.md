# Class-Coloured Dossier Character Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every applicant-dossier character mention with its known World of Warcraft class colour while preserving canonical identity through evidence attribution.

**Architecture:** Change raid and Cutting Edge participant arrays from display-name strings to canonical `CharacterKey` objects, retaining the identity already stored in snapshots and evidence runs. A shared React module resolves keyed references against the dossier's top-level characters and owns display names, class normalization, class styles, list punctuation, and neutral fallback behavior.

**Tech Stack:** TypeScript 5.9, Zod, React 19, Next.js 16, Vitest, Testing Library, Playwright, CSS.

**Spec:** `docs/superpowers/specs/2026-09-14-class-coloured-dossier-character-names-design.md`

## Global Constraints

- Snapshot membership remains the only source for a character's display name and class.
- Raid and Cutting Edge participant data carries canonical identity; it does not duplicate class data.
- No database migration or backfill is required because canonical identity, display name, class, and evidence ownership are already stored.
- Missing characters, missing classes, and unsupported classes render a visible neutral name without inference.
- Class styling applies only to character-name spans and preserves all source/status labels, dates, ranks, guild names, messages, and link semantics.
- The darkest class colours must meet WCAG AA contrast against `--surface` (`#111119`) and `--surface-raised` (`#161620`).
- Character colours persist through hover and focus; names remain intact beside icons and at narrow widths.
- The applicant-dossier contract change, domain builder, application, and web client land atomically.

---

### Task 1: Preserve canonical participant identity in the domain dossier

**Files:**

- Modify: `packages/domain/src/applicant-dossier.ts`
- Test: `packages/domain/src/applicant-dossier.test.ts`

**Interfaces:**

- Consumes: existing `CharacterKey`, `DossierKillEvidence.character`, `DossierCuttingEdgeEvidence.character`, and `BuildApplicantDossierInput.characters`.
- Produces: `ApplicantDossierFirstKill.characters: readonly CharacterKey[]` and `ApplicantDossierCuttingEdge.characters: readonly CharacterKey[]`, deterministically ordered by `input.characters`.

- [ ] **Step 1: Write failing keyed-attribution tests**

Update existing expectations and add same-display-name coverage using literal keys:

```ts
it("preserves canonical identities for same-named kill participants", () => {
  const sameNamedAlt: CharacterKey = {
    region: "us",
    realm: "illidan",
    name: "ryii"
  };
  const dossier = buildApplicantDossier({
    root,
    characters: [rootCharacter, { key: sameNamedAlt, displayName: "Ryii" }],
    kills: [kill(sameNamedAlt)],
    limitations: []
  });

  expect(dossier.raids[0]!.bosses[0]!.firstKill.characters).toEqual([
    sameNamedAlt
  ]);
});

it("preserves canonical identities for same-named Cutting Edge characters", () => {
  const sameNamedAlt: CharacterKey = {
    region: "us",
    realm: "illidan",
    name: "ryii"
  };
  const dossier = buildApplicantDossier({
    root,
    characters: [rootCharacter, { key: sameNamedAlt, displayName: "Ryii" }],
    kills: [],
    cuttingEdges: [
      {
        achievementId: "40254",
        completedAt: "2025-01-14T20:30:00.000Z",
        character: sameNamedAlt
      }
    ],
    limitations: []
  });

  expect(dossier.cuttingEdges[0]!.characters).toEqual([sameNamedAlt]);
});
```

Change existing string expectations such as `['Ryii', 'Ryalts']` to `[root, altKey]`.

- [ ] **Step 2: Run the domain tests and verify RED**

Run: `pnpm exec vitest run --project unit packages/domain/src/applicant-dossier.test.ts`

Expected: FAIL because the builder still returns display-name strings instead of the literal `CharacterKey` objects.

- [ ] **Step 3: Change domain output types and mappings to keys**

In `packages/domain/src/applicant-dossier.ts`, change both participant interfaces:

```ts
export type ApplicantDossierFirstKill = Readonly<{
  killedAt: string;
  guild: Readonly<{ name: string; realm: string }> | null;
  historicWorldRank: number | null;
  reportUrl: string | null;
  reportUrls: readonly string[];
  characters: readonly CharacterKey[];
}>;

export type ApplicantDossierCuttingEdge = Readonly<{
  achievementId: string;
  achievementName: string;
  description: string;
  iconUrl: string | null;
  completedAt: string;
  characters: readonly CharacterKey[];
}>;
```

Preserve the existing filters and ordering, but return keys:

```ts
characters: input.characters
  .filter((character) => ids.has(canonicalCharacterId(character.key)))
  .map((character) => character.key);
```

```ts
characters: input.characters
  .filter((character) =>
    entry.characters.has(canonicalCharacterId(character.key))
  )
  .map((character) => character.key);
```

- [ ] **Step 4: Run the domain tests and verify GREEN**

Run: `pnpm exec vitest run --project unit packages/domain/src/applicant-dossier.test.ts`

Expected: all applicant-dossier domain tests PASS, including both same-name identity regressions.

- [ ] **Step 5: Commit the domain change**

```powershell
git add -- packages/domain/src/applicant-dossier.ts packages/domain/src/applicant-dossier.test.ts
git commit -m "refactor: preserve dossier participant identity"
```

### Task 2: Publish keyed participants through the dossier contract

**Files:**

- Modify: `packages/contracts/src/dossier.ts`
- Test: `packages/contracts/src/contracts.test.ts`
- Test: `packages/application/src/applicant-dossier-service.test.ts`
- Test: `apps/web/src/app/api/dossiers/api-contract.test.ts`

**Interfaces:**

- Consumes: Task 1's `characters: readonly CharacterKey[]` on raid kills and Cutting Edge achievements.
- Produces: Zod-parsed `ApplicantDossier` values whose participant `characters` arrays contain `CharacterKey`; the retired display-name-string representation is rejected.

- [ ] **Step 1: Make contract fixtures expect keyed participants**

In `packages/contracts/src/contracts.test.ts`, change the valid dossier fixture and add an explicit rejection assertion:

```ts
firstKill: {
  killedAt: "2024-10-01T20:00:00.000Z",
  guild: { name: "Guild", realm: "silvermoon" },
  historicWorldRank: null,
  reportUrl: "https://www.warcraftlogs.com/reports/example",
  characters: [applicantCharacter]
}
```

```ts
const stringParticipants = {
  ...validDossier,
  raids: [
    {
      ...validDossier.raids[0]!,
      bosses: [
        {
          ...validDossier.raids[0]!.bosses[0]!,
          firstKill: {
            ...validDossier.raids[0]!.bosses[0]!.firstKill,
            characters: ["Ryii"]
          }
        }
      ]
    }
  ]
};
expect(applicantDossierSchema.safeParse(stringParticipants).success).toBe(
  false
);
```

Update application and route fixtures from `characters: ['Ryii']` to literal `CharacterKey` values such as `characters: [root]`.

- [ ] **Step 2: Run contract and application tests and verify RED**

Run: `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/application/src/applicant-dossier-service.test.ts apps/web/src/app/api/dossiers/api-contract.test.ts`

Expected: FAIL because `dossierFirstKillSchema` and `dossierCuttingEdgeSchema` still require strings.

- [ ] **Step 3: Change both contract participant schemas**

In `packages/contracts/src/dossier.ts`, use the existing strict key schema in both places:

```ts
characters: z.array(characterKeySchema);
```

Keep `.min(1)` on Cutting Edge participants:

```ts
characters: z.array(characterKeySchema).min(1);
```

Do not add display name or class to the nested evidence schemas.

- [ ] **Step 4: Run contract, application, and route tests and verify GREEN**

Run: `pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts packages/application/src/applicant-dossier-service.test.ts apps/web/src/app/api/dossiers/api-contract.test.ts`

Expected: all selected tests PASS and the retired string-participant assertion remains rejected.

- [ ] **Step 5: Commit the contract change**

```powershell
git add -- packages/contracts/src/dossier.ts packages/contracts/src/contracts.test.ts packages/application/src/applicant-dossier-service.test.ts apps/web/src/app/api/dossiers/api-contract.test.ts
git commit -m "refactor: key dossier evidence participants"
```

### Task 3: Build the shared character-name rendering module

**Files:**

- Create: `apps/web/src/components/dossier-character-name.tsx`
- Create: `apps/web/src/components/dossier-character-name.test.tsx`
- Modify: `apps/web/src/components/dossier-character-list.tsx`
- Modify: `apps/web/src/components/dossier-character-list.test.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**

- Consumes: `DossierCharacter`, `CharacterKey`, and the top-level dossier character collection.
- Produces: `DossierCharacterProvider({ characters, children })`, `DossierCharacterName({ character })`, and `DossierCharacterNames({ characters, empty? })`.

- [ ] **Step 1: Write the shared renderer's failing behavior matrix**

Create `apps/web/src/components/dossier-character-name.test.tsx`. Use a table containing these exact pairs:

```ts
const classes = [
  ["Death Knight", "death-knight"],
  ["Demon Hunter", "demon-hunter"],
  ["Druid", "druid"],
  ["Evoker", "evoker"],
  ["Hunter", "hunter"],
  ["Mage", "mage"],
  ["Monk", "monk"],
  ["Paladin", "paladin"],
  ["Priest", "priest"],
  ["Rogue", "rogue"],
  ["Shaman", "shaman"],
  ["Warlock", "warlock"],
  ["Warrior", "warrior"]
] as const;
```

For each row, render a full `DossierCharacter` and assert the visible name has `dossier-character-name--${modifier}`. Add tests that:

```tsx
render(
  <DossierCharacterProvider characters={[mage, sameNamedPriest]}>
    <DossierCharacterName character={sameNamedPriest.key} />
  </DossierCharacterProvider>
);
expect(screen.getByText("Ryii")).toHaveClass("dossier-character-name--priest");
```

Also render characters with `className: null`, `className: 'Unknown class'`, and an unresolved key; assert each has exactly `dossier-character-name` and retains its visible name.

- [ ] **Step 2: Run the renderer tests and verify RED**

Run: `pnpm exec vitest run --project unit apps/web/src/components/dossier-character-name.test.tsx apps/web/src/components/dossier-character-list.test.tsx`

Expected: FAIL because the shared module and general `dossier-character-name--*` modifiers do not yet exist.

- [ ] **Step 3: Implement canonical resolution and class normalization**

Create the provider context and exact-key resolver:

```ts
type CharacterReference = DossierCharacter | CharacterKey;

function sameCharacter(left: CharacterKey, right: CharacterKey): boolean {
  return (
    left.region === right.region &&
    left.realm.toLowerCase() === right.realm.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function resolveCharacter(
  reference: CharacterReference,
  characters: readonly DossierCharacter[]
): Readonly<{ displayName: string; className: string | null }> {
  if ("displayName" in reference) return reference;
  return (
    characters.find((character) => sameCharacter(character.key, reference)) ?? {
      displayName: reference.name,
      className: null
    }
  );
}
```

Normalize class names by trimming, lowercasing, and removing spaces, underscores, and hyphens. Map exactly the thirteen matrix entries to CSS modifiers. `DossierCharacterName` must always emit the base `dossier-character-name` class and add one modifier only for a supported class.

Implement keyed lists without flattening text:

```tsx
export function DossierCharacterNames({
  characters,
  empty = "—"
}: Readonly<{ characters: readonly CharacterKey[]; empty?: string }>) {
  if (characters.length === 0) return <>{empty}</>;
  return (
    <>
      {characters.map((character, index) => (
        <Fragment
          key={`${character.region}/${character.realm}/${character.name}`}
        >
          {index > 0 ? ", " : null}
          <DossierCharacterName character={character} />
        </Fragment>
      ))}
    </>
  );
}
```

- [ ] **Step 4: Centralize accessible class styles and Connected characters**

Replace `dossier-character-link--*` with shared `dossier-character-name--*` selectors. Use these adjusted dark-theme values for the three conventional colours that otherwise fall below 4.5:1 on `--surface-raised`:

```css
.dossier-character-name {
  color: var(--text);
  font-weight: 720;
  white-space: nowrap;
}

.dossier-character-name--death-knight {
  color: #ed405b;
}
.dossier-character-name--demon-hunter {
  color: #c653df;
}
.dossier-character-name--shaman {
  color: #168bff;
}
```

Retain the existing colours for Druid, Evoker, Hunter, Mage, Monk, Paladin, Priest, Rogue, Warlock, and Warrior under the renamed shared selectors. Remove the hover rule that changes a coloured name to white; retain underline and the existing focus outline.

Replace the private mapping in `DossierCharacterList` with:

```tsx
<DossierCharacterName character={character} />
```

- [ ] **Step 5: Run shared renderer tests and verify GREEN**

Run: `pnpm exec vitest run --project unit apps/web/src/components/dossier-character-name.test.tsx apps/web/src/components/dossier-character-list.test.tsx`

Expected: the thirteen-class matrix, exact-key duplicate-name lookup, both class fallbacks, unresolved-key fallback, accessible link, and scroll tests all PASS.

- [ ] **Step 6: Commit the shared rendering module**

```powershell
git add -- apps/web/src/components/dossier-character-name.tsx apps/web/src/components/dossier-character-name.test.tsx apps/web/src/components/dossier-character-list.tsx apps/web/src/components/dossier-character-list.test.tsx apps/web/src/app/globals.css
git commit -m "feat: add shared dossier character names"
```

### Task 4: Route every dossier mention through the shared module

**Files:**

- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`
- Test: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`
- Modify: `apps/web/src/components/dossier-cutting-edge-list.tsx`
- Test: `apps/web/src/components/dossier-cutting-edge-list.test.tsx`
- Modify: `apps/web/src/components/dossier-raid-list.tsx`
- Test: `apps/web/src/components/dossier-raid-list.test.tsx`
- Modify: `apps/web/src/components/dossier-limitations.tsx`
- Test: `apps/web/src/components/dossier-view.test.tsx`

**Interfaces:**

- Consumes: Task 2's keyed dossier participants and Task 3's provider/name/list renderers.
- Produces: class-coloured names in the dossier heading, Connected characters, Cutting Edge attribution, boss summaries, expanded boss evidence, and limitation attribution.

- [ ] **Step 1: Convert web fixtures to keyed participant arrays**

Change every dossier fixture in the listed test files from display-name strings to literal keys:

```ts
characters: [
  { region: "eu", realm: "silvermoon", name: "ryii" },
  { region: "eu", realm: "draenor", name: "ryalts" }
];
```

Keep presentation assertions on `Ryii` and `Ryalts`; the top-level dossier character collection supplies those display names.

- [ ] **Step 2: Write the failing all-surfaces test**

In `apps/web/src/components/dossier-view.test.tsx`, render a full dossier and assert each name-bearing surface contains a shared name span with its expected modifier. Include two top-level characters with the same display name but different keys/classes, and prove a keyed evidence reference resolves to the correct class:

```ts
const sameNamedPriest = {
  key: { region: "us", realm: "illidan", name: "ryii" },
  displayName: "Ryii",
  className: "Priest",
  raiderIoUrl: "https://raider.io/characters/us/illidan/ryii",
  source: "fingerprint_derived" as const
};
```

Scope assertions to the heading, Connected characters region, Cutting Edge card, `.dossier-boss-first-kill`, expanded evidence definition, and limitation list item. Do not infer the expected class from text; use literal `dossier-character-name--mage` and `dossier-character-name--priest` expectations.

- [ ] **Step 3: Run the dossier web tests and verify RED**

Run: `pnpm exec vitest run --project unit apps/web/src/components/dossier-view.test.tsx apps/web/src/components/dossier-cutting-edge-list.test.tsx apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

Expected: FAIL because the heading and evidence/attribution surfaces still render plain keys or joined values instead of shared character-name spans.

- [ ] **Step 4: Provide dossier characters and replace every plain mention**

Wrap the complete dossier page so the heading and every child surface share the same registry:

```tsx
<DossierCharacterProvider characters={dossier?.characters ?? []}>
  <main className="page-shell dossier-page">
    {/* existing dossier content */}
  </main>
</DossierCharacterProvider>
```

Render the heading and limitation key with `DossierCharacterName`:

```tsx
<h1>
  <DossierCharacterName character={identity} />
</h1>
```

```tsx
<>
  {" Affected character: "}
  <DossierCharacterName character={limitation.character} />.
</>
```

Render Cutting Edge and both raid evidence locations with the keyed list interface:

```tsx
<DossierCharacterNames characters={entry.achievement.characters} />
```

```tsx
<DossierCharacterNames characters={firstKill.characters} />
```

```tsx
<DossierCharacterNames characters={evidence.characters} />
```

Do not wrap guild, boss, raid, achievement, status, or arbitrary message text.

- [ ] **Step 5: Run dossier web tests and verify GREEN**

Run: `pnpm exec vitest run --project unit apps/web/src/components/dossier-view.test.tsx apps/web/src/components/dossier-cutting-edge-list.test.tsx apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

Expected: all selected tests PASS, including exact-key same-name resolution and every current dossier surface.

- [ ] **Step 6: Run complete verification**

Run each command and require the stated result:

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm exec playwright test tests/e2e/responsive.spec.ts --grep "matches dossier summary panels|does not create a desktop scroll range"
git diff --check
```

Expected: formatting, lint, typecheck, all unit tests, production build, both layout-specific responsive tests, and whitespace validation PASS. The repository may print its known Node 22 engine warning under the installed Node 24 runtime. Do not change the unrelated #99 report-link label assertion in the first responsive test as part of #97.

- [ ] **Step 7: Commit the dossier integration**

```powershell
git add -- apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx apps/web/src/components/dossier-cutting-edge-list.tsx apps/web/src/components/dossier-cutting-edge-list.test.tsx apps/web/src/components/dossier-raid-list.tsx apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-limitations.tsx apps/web/src/components/dossier-view.test.tsx
git commit -m "feat: colour every dossier character mention"
```

- [ ] **Step 8: Review final branch scope**

Run:

```powershell
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: no uncommitted files, only #97 domain/contract/web changes plus the approved spec and this plan, and focused commits matching the four tasks.
