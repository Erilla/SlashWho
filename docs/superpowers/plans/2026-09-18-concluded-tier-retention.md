# Concluded Tier Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A raid tier that has concluded, was read without incident, and whose kills have settled is stored once and never re-queried, so a character's runs only ever cost upstream requests for the tier that is still moving.

**Architecture:** A new `character_terminal_tiers` table records, per character per raid per collection domain (`kills`, `parses`, `tier_bests`), that the tier is finished with. Marks are written by the evidence job handler after a run publishes — it owns the policy: concluded window, no limitation attributed to that tier, every kill older than the settle threshold. Marks are read back into `getFirstKillReports`, which uses them to drop zones from the tier-bests budget, skip parse hydration for terminal raids, and stop the report page scan early once it is below every terminal tier. Because the scan stops, `publish` must carry terminal-tier kills and wipes forward even on a `complete` publish. Each mark carries the collection version of its own domain, so a parse fix bumps `parses` and re-collects parses alone; an operator-only `rebuild` clears every mark for a character and lets the existing run, retry and budget machinery drain the backlog.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (`unit` and `integration` projects), Drizzle migrations over PostgreSQL, pg-boss queue.

**Spec:** `docs/superpowers/specs/2026-09-18-concluded-tier-retention-design.md`

**Issue:** #285. Scope confirmed with the maintainer before planning — see "Scope decisions" below.

## Scope decisions

Two decisions were taken with the maintainer before this plan was written. They
narrow the spec deliberately; do not widen them back out while implementing.

1. **Warcraft Logs only.** The spec's retention table also names Raider.IO
   `raid-progress`, Raider.IO world boss rankings, Blizzard achievements and the
   Blizzard class index. None of those is stored per character today:
   `getHistoricMythicKills` has no caller in the dossier path at all, and the
   other three are 15-minute in-process bounded caches
   (`docs/dossier-cache-policy.md`). Making them terminal means building
   per-character persistence that does not exist, which is a separate subsystem.
   Task 9 raises a follow-up issue for it.
2. **Per-domain collection versions are in.** The spec calls them "proposed, not
   required"; the maintainer asked for them alongside the rebuild. They live
   entirely inside `@slashwho/database` — `markTerminalTiers` stamps the current
   version and `terminalTiers` filters on it, so no caller has to know a version
   exists.

## Global Constraints

- **A raid with no window entry must never be marked terminal.** `raidTierConclusion` returns `"unknown"` for both a raid name the catalogue does not know and a raid with no window row, and `"unknown"` never marks. The `current_content_window_unknown` limitation stays visible and the tier keeps being re-queried.
- **Terminal requires a clean read.** A tier is marked only if the run that read it attributed no limitation to it. A scan limitation (`request_cap`, `schema_drift`, `rate_limited`, `unavailable`, `private`, `points_budget_low`) blocks every `kills` mark for that run; a parse limitation blocks every `parses` and `tier_bests` mark; a zone- or report-level limitation blocks the raids it touched.
- **`EVIDENCE_KILL_SETTLE_DAYS` defaults to 7 and is explicitly unverified.** Say so in the config comment and in `.env.example`, the same way `EVIDENCE_POINTS_RESERVE` does.
- **Percentiles and world ranks are terminal by policy, not by nature.** Where the code freezes one, the comment must say it is a policy choice.
- **The dossier refresh route must never produce a rebuild.** `/api/dossiers/.../refresh` is unauthenticated; `rebuild` is reachable only from the operator script.
- **A rebuild is a flag, not an action.** It clears marks and returns. It must never try to re-collect synchronously.
- **A rebuild must not discard stored evidence before its replacement arrives.** Clearing marks touches `character_terminal_tiers` only; no kill, wipe or tier-best row is deleted.
- Every new repository write is one transaction, matching the atomicity of the existing `publish`.
- Run `corepack pnpm lint`, `corepack pnpm typecheck` and `corepack pnpm format:check` before each commit. Bare `pnpm` is not on PATH in this environment; the `corepack` prefix is required.
- Integration tests need Docker (Testcontainers `postgres:16-alpine`). Run them with `corepack pnpm test:integration`.
- Conventional commit prefixes, one coherent change per commit, per `docs/contributing.md`.

## File structure

| File                                                               | Responsibility                                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/src/raid-catalogue.ts`                            | `raidTierConclusion` — is this raid's window closed, open, or unknown                                                   |
| `packages/database/src/schema.ts`                                  | `character_terminal_tiers`, `evidence_collection_domain`, `character_mythic_kills.collected_at`                         |
| `packages/database/drizzle/0022_concluded_tier_retention.sql`      | The migration                                                                                                           |
| `packages/database/src/repositories.ts`                            | `EvidenceCollectionDomain`, `TerminalTier`, three new `EvidenceRepository` methods, `hydratedFightUrls` settle argument |
| `packages/database/src/postgres-repositories.ts`                   | Their SQL, the per-domain versions, terminal carry-forward in `publish`                                                 |
| `packages/warcraftlogs/src/types.ts`                               | `terminalRaidIds` and `killScanFloor` options, `troubledRaidIds` on the result                                          |
| `packages/warcraftlogs/src/client.ts`                              | Skipping zones and parse groups, the early scan stop, attributing limitations to raids                                  |
| `packages/application/src/terminal-tiers.ts`                       | **New.** The marking policy: concluded + clean + settled                                                                |
| `packages/application/src/applicant-evidence-job-handler.ts`       | Reads marks in, writes marks out, passes the settle cutoff                                                              |
| `packages/application/src/refresh-mode.ts`, `refresh-character.ts` | The third `rebuild` mode                                                                                                |
| `packages/application/src/applicant-dossier-service.ts`            | `rebuildCharacter`, kept off `refreshCharacter`                                                                         |
| `apps/worker/src/config.ts`, `.env.example`                        | `EVIDENCE_KILL_SETTLE_DAYS`                                                                                             |
| `scripts/rebuild-character.mts`                                    | The operator trigger                                                                                                    |
| `tests/integration/repositories.test.ts`                           | Terminal marks and carry-forward against real PostgreSQL                                                                |

---

### Task 1: Tell a concluded raid tier from a current or unknown one

**Files:**

- Modify: `packages/domain/src/raid-catalogue.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/raid-catalogue.test.ts`

**Interfaces:**

- Consumes: existing `lookupRaidByName`, `lookupRaidCurrentContentWindow`.
- Produces: `export type RaidTierConclusion = "concluded" | "current" | "unknown"` and `export function raidTierConclusion(raidName: string, at: Date): RaidTierConclusion`, both re-exported from `@slashwho/domain`.

Three outcomes, not two. `"unknown"` is the whole point of the guard: a raid the
catalogue does not know, and a raid it knows with no window row, are both
undatable, and freezing undated evidence is worse than re-querying it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/domain/src/raid-catalogue.test.ts`:

```ts
describe("raidTierConclusion", () => {
  const after = new Date("2026-09-18T00:00:00.000Z");

  it("reports a raid whose window has closed as concluded", () => {
    expect(raidTierConclusion("Aberrus, the Shadowed Crucible", after)).toBe(
      "concluded"
    );
  });

  it("reports a raid still inside its window as current", () => {
    expect(
      raidTierConclusion(
        "Aberrus, the Shadowed Crucible",
        new Date("2023-06-01T00:00:00.000Z")
      )
    ).toBe("current");
  });

  it("reports a raid the catalogue does not know as unknown", () => {
    // Never "concluded": an undatable raid must keep being re-queried rather
    // than have evidence frozen against a boundary we cannot place.
    expect(raidTierConclusion("VS / DR / MQD", after)).toBe("unknown");
    expect(raidTierConclusion("Not A Raid", after)).toBe("unknown");
  });

  it("reports an open-ended window as current however late it is read", () => {
    const openEnded = [...currentContentWindowRaidNames()].find(
      (name) =>
        lookupRaidCurrentContentWindow(raidIdForName(name))?.endsAt === null
    );
    if (openEnded) {
      expect(
        raidTierConclusion(openEnded, new Date("2099-01-01T00:00:00.000Z"))
      ).toBe("current");
    }
  });
});
```

If the last test's helpers do not exist in this test file, replace its body with
a direct assertion against whichever raid in
`packages/domain/src/raid-current-content-windows.generated.json` currently has
`"endsAt": null`, looked up by name. Do not add exports to the catalogue purely
to serve a test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/domain/src/raid-catalogue.test.ts`
Expected: FAIL — `raidTierConclusion is not a function`.

- [ ] **Step 3: Implement**

Add to `packages/domain/src/raid-catalogue.ts`, next to `currentContentEligibility`:

```ts
/**
 * Whether a raid's current-content window has closed.
 *
 * `"unknown"` is not a weaker `"current"`: a raid the catalogue cannot place in
 * time must never be treated as terminal, because freezing undated evidence is
 * worse than re-querying it. Callers storing evidence indefinitely must act on
 * `"concluded"` alone.
 */
export type RaidTierConclusion = "concluded" | "current" | "unknown";

export function raidTierConclusion(
  raidName: string,
  at: Date
): RaidTierConclusion {
  const raid = lookupRaidByName(raidName);
  if (raid === null) return "unknown";
  const window = lookupRaidCurrentContentWindow(raid.raidId);
  if (!window) return "unknown";
  if (window.endsAt === null) return "current";
  const endsAt = Date.parse(window.endsAt);
  if (Number.isNaN(endsAt) || Number.isNaN(at.valueOf())) return "unknown";
  return endsAt <= at.getTime() ? "concluded" : "current";
}
```

Add `raidTierConclusion` and `type RaidTierConclusion` to the export list in
`packages/domain/src/index.ts`, beside `currentContentEligibility`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/domain/src/raid-catalogue.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/domain/src/raid-catalogue.ts packages/domain/src/raid-catalogue.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): tell a concluded raid tier from a current or unknown one"
```

---

### Task 2: Store which tiers a character is finished with

**Files:**

- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0022_concluded_tier_retention.sql`
- Modify: `packages/database/drizzle/meta/_journal.json`
- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `export type EvidenceCollectionDomain = "kills" | "parses" | "tier_bests"`
  - `export type TerminalTier = Readonly<{ raidId: string; domain: EvidenceCollectionDomain }>`
  - On `EvidenceRepository`: `terminalTiers(key: CharacterKey): Promise<readonly TerminalTier[]>`, `markTerminalTiers(key: CharacterKey, tiers: readonly TerminalTier[], at: Date): Promise<void>`, `clearTerminalTiers(key: CharacterKey): Promise<number>`.

Keyed by character, not by run. `character_evidence_runs` rows are deleted after
30 days by the worker's maintenance, and a terminal mark has to outlive that or
the whole design unwinds every month.

The collection version never leaves this package. `markTerminalTiers` stamps the
current version for each domain; `terminalTiers` returns only rows at or above
it. A bump therefore re-collects exactly one domain, and no caller has to know
versions exist.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/repositories.test.ts`, alongside the other evidence
tests:

```ts
it("stores terminal tiers per character and returns them until cleared", async () => {
  const key = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "terminalmarks"
  };
  const at = new Date("2026-09-18T10:00:00.000Z");

  expect(await repositories.evidence.terminalTiers(key)).toEqual([]);

  await repositories.evidence.markTerminalTiers(
    key,
    [
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "parses" },
      { raidId: "43", domain: "tier_bests" }
    ],
    at
  );

  expect(await repositories.evidence.terminalTiers(key)).toEqual([
    { raidId: "42", domain: "kills" },
    { raidId: "42", domain: "parses" },
    { raidId: "43", domain: "tier_bests" }
  ]);

  // Marking again is idempotent rather than a duplicate-key failure: a run
  // re-reads a tier it had already settled whenever a rebuild is draining.
  await repositories.evidence.markTerminalTiers(
    key,
    [{ raidId: "42", domain: "kills" }],
    at
  );
  expect(await repositories.evidence.terminalTiers(key)).toHaveLength(3);

  expect(await repositories.evidence.clearTerminalTiers(key)).toBe(3);
  expect(await repositories.evidence.terminalTiers(key)).toEqual([]);
});

it("keeps one character's terminal tiers out of another's", async () => {
  const mine = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "marksmine"
  };
  const theirs = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "markstheirs"
  };
  const at = new Date("2026-09-18T10:00:00.000Z");

  await repositories.evidence.markTerminalTiers(
    mine,
    [{ raidId: "42", domain: "kills" }],
    at
  );

  expect(await repositories.evidence.terminalTiers(theirs)).toEqual([]);
  expect(await repositories.evidence.clearTerminalTiers(theirs)).toBe(0);
  expect(await repositories.evidence.terminalTiers(mine)).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm test:integration -- -t "terminal tiers"`
Expected: FAIL — `repositories.evidence.terminalTiers is not a function`.

- [ ] **Step 3: Add the schema, the migration and the repository methods**

In `packages/database/src/schema.ts`, beside the other enums:

```ts
/**
 * The parts of a character's Warcraft Logs evidence that settle independently.
 * Each carries its own collection version, so a parse fix re-collects parses
 * without also re-collecting kills and tier bests.
 */
export const evidenceCollectionDomain = pgEnum("evidence_collection_domain", [
  "kills",
  "parses",
  "tier_bests"
]);
```

Add `collectedAt` to `characterMythicKills`, immediately after
`bossDamagePercentile`, mirroring `characterTierBestParses.collectedAt`:

```ts
/**
 * When this fight's parses were actually read. A percentile is a value
 * against a ranking pool with no record of when it was observed; storing
 * the observation time makes drift measurable from our own data at no
 * upstream cost, and is what should eventually replace the guessed
 * `EVIDENCE_KILL_SETTLE_DAYS`. Carried forward unchanged when a later run
 * skips a fight it has already hydrated.
 */
collectedAt: timestamp("collected_at", { withTimezone: true })
  .defaultNow()
  .notNull();
```

And the new table, after `characterTierBestParses`:

```ts
/**
 * Tiers this character is finished with: stored once, never re-queried.
 *
 * Keyed by character rather than by evidence run, because the worker's
 * maintenance deletes terminal runs after 30 days and a mark has to outlive
 * that. `collectionVersion` is this package's own escape hatch — a bump to one
 * domain's version re-collects that domain's tiers and leaves the others
 * settled.
 */
export const characterTerminalTiers = pgTable(
  "character_terminal_tiers",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    /** The Warcraft Logs zone id, matching `character_mythic_kills.raid_id`. */
    raidId: text("raid_id").notNull(),
    domain: evidenceCollectionDomain("domain").notNull(),
    collectionVersion: integer("collection_version").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "character_terminal_tiers_pkey",
      columns: [
        table.region,
        table.realmSlug,
        table.normalizedName,
        table.raidId,
        table.domain
      ]
    })
  ]
);
```

Create `packages/database/drizzle/0022_concluded_tier_retention.sql`:

```sql
CREATE TYPE "public"."evidence_collection_domain" AS ENUM('kills', 'parses', 'tier_bests');--> statement-breakpoint
CREATE TABLE "character_terminal_tiers" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"raid_id" text NOT NULL,
	"domain" "evidence_collection_domain" NOT NULL,
	"collection_version" integer NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_terminal_tiers_pkey" PRIMARY KEY("region","realm_slug","normalized_name","raid_id","domain")
);--> statement-breakpoint
ALTER TABLE "character_mythic_kills" ADD COLUMN "collected_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "character_mythic_kills" AS k
   SET "collected_at" = r."completed_at"
  FROM "character_evidence_runs" AS r
 WHERE r."id" = k."evidence_run_id" AND r."completed_at" IS NOT NULL;
```

Append to the `entries` array in `packages/database/drizzle/meta/_journal.json`:

```json
{
  "idx": 21,
  "version": "7",
  "when": 1790164800000,
  "tag": "0022_concluded_tier_retention",
  "breakpoints": true
}
```

In `packages/database/src/repositories.ts`, above `EvidenceRepository`:

```ts
export type EvidenceCollectionDomain = "kills" | "parses" | "tier_bests";

/** One raid a character is finished collecting one domain of evidence for. */
export type TerminalTier = Readonly<{
  raidId: string;
  domain: EvidenceCollectionDomain;
}>;
```

and on the interface, after `collectedTierZones`:

```ts
  /**
   * Tiers this character is finished with, at or above the current collection
   * version for their domain. Rows below it are omitted, which is how a
   * version bump re-collects one domain and leaves the rest settled.
   */
  terminalTiers(key: CharacterKey): Promise<readonly TerminalTier[]>;
  /** Records tiers as terminal, stamping each with its domain's version. */
  markTerminalTiers(
    key: CharacterKey,
    tiers: readonly TerminalTier[],
    at: Date
  ): Promise<void>;
  /**
   * Forgets every terminal mark for one character, so the next runs re-collect
   * its history. Deletes no evidence: the stored kills, wipes and tier bests
   * stay readable until their replacements arrive.
   */
  clearTerminalTiers(key: CharacterKey): Promise<number>;
```

In `packages/database/src/postgres-repositories.ts`, beside
`CURRENT_EVIDENCE_VERSION`:

```ts
/**
 * Per-domain collection versions. Bump one when a collection fix changes what
 * that domain stores: terminal tiers below the new version re-collect once and
 * settle again, while the other domains stay terminal. `CURRENT_EVIDENCE_VERSION`
 * cannot serve this — it invalidates everything, which is ruinous once the
 * point is to stop re-querying.
 */
const CURRENT_COLLECTION_VERSIONS: Readonly<
  Record<EvidenceCollectionDomain, number>
> = {
  kills: 1,
  parses: 1,
  tier_bests: 1
};
```

and inside the `evidence` object, after `collectedTierZones`:

```ts
      async terminalTiers(key) {
        const result = await pool.query<{
          raid_id: string;
          domain: EvidenceCollectionDomain;
        }>(
          `SELECT raid_id, domain
             FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND collection_version >= CASE domain
                    WHEN 'kills' THEN $4::integer
                    WHEN 'parses' THEN $5::integer
                    ELSE $6::integer
                  END
            ORDER BY raid_id, domain`,
          [
            key.region,
            key.realm,
            key.name,
            CURRENT_COLLECTION_VERSIONS.kills,
            CURRENT_COLLECTION_VERSIONS.parses,
            CURRENT_COLLECTION_VERSIONS.tier_bests
          ]
        );
        return result.rows.map((row) => ({
          raidId: row.raid_id,
          domain: row.domain
        }));
      },

      async markTerminalTiers(key, tiers, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_terminal_tier_time_invalid");
        }
        if (tiers.length === 0) return;
        await pool.query(
          `INSERT INTO character_terminal_tiers
             (region, realm_slug, normalized_name, raid_id, domain,
              collection_version, marked_at)
           SELECT $1, $2, $3, entry.raid_id, entry.domain::evidence_collection_domain,
                  CASE entry.domain
                    WHEN 'kills' THEN $6::integer
                    WHEN 'parses' THEN $7::integer
                    ELSE $8::integer
                  END,
                  $9
             FROM unnest($4::text[], $5::text[]) AS entry(raid_id, domain)
           ON CONFLICT (region, realm_slug, normalized_name, raid_id, domain)
           DO UPDATE SET collection_version = EXCLUDED.collection_version,
                         marked_at = EXCLUDED.marked_at`,
          [
            key.region,
            key.realm,
            key.name,
            tiers.map((tier) => tier.raidId),
            tiers.map((tier) => tier.domain),
            CURRENT_COLLECTION_VERSIONS.kills,
            CURRENT_COLLECTION_VERSIONS.parses,
            CURRENT_COLLECTION_VERSIONS.tier_bests,
            at
          ]
        );
      },

      async clearTerminalTiers(key) {
        const result = await pool.query(
          `DELETE FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        return result.rowCount ?? 0;
      },
```

Import `EvidenceCollectionDomain` and `TerminalTier` from `./repositories` at the
top of `postgres-repositories.ts` alongside the existing type imports.

The existing `publish` writes `character_mythic_kills` without `collected_at`;
the column defaults to `now()`, so that INSERT keeps compiling. Task 3 makes it
explicit.

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm test:integration -- -t "terminal tiers"`
Expected: PASS, both tests.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/database tests/integration/repositories.test.ts
git commit -m "feat(database): store which raid tiers a character is finished with"
```

---

### Task 3: Keep terminal evidence when the scan stops re-finding it

**Files:**

- Modify: `packages/database/src/postgres-repositories.ts`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**

- Consumes: `character_terminal_tiers` and `character_mythic_kills.collected_at` from Task 2.
- Produces: no new signatures. `publish` behaviour changes: a `complete` publish carries forward stored kills and wipes belonging to raids terminal for `kills`, and every publish preserves a carried kill's `collected_at`.

This is the task that makes the whole design safe. A `complete` publish
deliberately does **not** resurrect kills the run no longer found — that is how a
deleted report stops being claimed. Once the scan stops paging into concluded
tiers, those kills are "no longer found" on every run, and a complete publish
would erase a character's entire history the first time it settled.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/repositories.test.ts`:

```ts
it("carries terminal-tier kills and wipes through a complete publish", async () => {
  const key = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "terminalcarry"
  };
  const first = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date("2026-09-18T00:00:00.000Z"),
    at: new Date("2026-09-18T00:00:00.000Z")
  });
  await repositories.evidence.publish(first.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [
      killInput({ raidId: "42", bossId: "1", fightUrl: "https://a/1" }),
      killInput({ raidId: "99", bossId: "2", fightUrl: "https://b/2" })
    ],
    wipes: [wipeInput({ raidId: "42", fightUrl: "https://a/w" })],
    tierBests: [],
    completedAt: new Date("2026-09-18T00:00:00.000Z")
  });

  await repositories.evidence.markTerminalTiers(
    key,
    [{ raidId: "42", domain: "kills" }],
    new Date("2026-09-18T00:05:00.000Z")
  );

  // The second run never re-reads raid 42 — that is the point of the mark —
  // so it reports only raid 99. Raid 42 must survive anyway.
  const second = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
    at: new Date("2026-09-19T00:00:00.000Z")
  });
  await repositories.evidence.publish(second.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [killInput({ raidId: "99", bossId: "2", fightUrl: "https://b/2" })],
    wipes: [],
    tierBests: [],
    completedAt: new Date("2026-09-19T00:00:00.000Z")
  });

  const completed = await repositories.evidence.getCompleted(key);
  expect(completed?.kills.map((kill) => kill.fightUrl).sort()).toEqual([
    "https://a/1",
    "https://b/2"
  ]);
  expect(completed?.wipes.map((wipe) => wipe.fightUrl)).toEqual([
    "https://a/w"
  ]);
});

it("drops a non-terminal tier's kills that a complete run no longer finds", async () => {
  // The existing contract, which the carry-forward must not swallow: a report
  // made private in a tier still being collected stops being claimed.
  const key = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "nonterminaldrop"
  };
  const first = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date("2026-09-18T00:00:00.000Z"),
    at: new Date("2026-09-18T00:00:00.000Z")
  });
  await repositories.evidence.publish(first.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [killInput({ raidId: "99", bossId: "2", fightUrl: "https://b/2" })],
    wipes: [],
    tierBests: [],
    completedAt: new Date("2026-09-18T00:00:00.000Z")
  });

  const second = await repositories.evidence.reserve({
    key,
    freshnessCutoff: new Date("2026-09-19T00:00:00.000Z"),
    at: new Date("2026-09-19T00:00:00.000Z")
  });
  await repositories.evidence.publish(second.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [],
    wipes: [],
    tierBests: [],
    completedAt: new Date("2026-09-19T00:00:00.000Z")
  });

  expect((await repositories.evidence.getCompleted(key))?.kills).toEqual([]);
});
```

`killInput` and `wipeInput` are small local helpers. If the file has no
equivalent, add them next to the test:

```ts
function killInput(
  overrides: Partial<CharacterMythicKillInput> &
    Pick<CharacterMythicKillInput, "raidId" | "bossId" | "fightUrl">
): CharacterMythicKillInput {
  return {
    raidName: "Test Raid",
    bossName: "Test Boss",
    journalBossId: null,
    bossOrder: 1,
    isFinalBoss: false,
    killedAt: new Date("2024-01-01T00:00:00.000Z"),
    reportUrl: "https://www.warcraftlogs.com/reports/abc",
    guild: null,
    historicWorldRank: null,
    performance: {
      damage: { state: "unavailable" },
      healing: { state: "unavailable" },
      bossDamage: { state: "unavailable" }
    },
    ...overrides
  } as CharacterMythicKillInput;
}

function wipeInput(
  overrides: Partial<CharacterMythicWipeInput> &
    Pick<CharacterMythicWipeInput, "raidId" | "fightUrl">
): CharacterMythicWipeInput {
  return {
    raidName: "Test Raid",
    bossId: "1",
    bossName: "Test Boss",
    journalBossId: null,
    bossOrder: 1,
    attemptedAt: new Date("2024-01-01T00:00:00.000Z"),
    reportUrl: "https://www.warcraftlogs.com/reports/abc",
    ...overrides
  } as CharacterMythicWipeInput;
}
```

Match `killedAt`/`attemptedAt` to whatever the existing tests in this file pass
— `Date` or ISO string — rather than assuming.

- [ ] **Step 2: Run the tests to verify the first fails and the second passes**

Run: `corepack pnpm test:integration -- -t "terminal-tier kills"`
Expected: FAIL — raid 42's kill and wipe are gone after the second publish.

Run: `corepack pnpm test:integration -- -t "no longer finds"`
Expected: PASS already. It is the regression guard for this change, not a new
behaviour.

- [ ] **Step 3: Implement the carry-forward**

In `publish`, after `activeRun` is read and before `previous` is loaded, read the
character's terminal tiers inside the same transaction:

```ts
const terminalKillRaidIds = new Set(
  (
    await client.query<{ raid_id: string }>(
      `SELECT raid_id
                   FROM character_terminal_tiers
                  WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                    AND domain = 'kills'
                    AND collection_version >= $4::integer`,
      [
        activeRun.region,
        activeRun.realm_slug,
        activeRun.normalized_name,
        CURRENT_COLLECTION_VERSIONS.kills
      ]
    )
  ).rows.map((row) => row.raid_id)
);
```

Then load the stored evidence for a complete publish too, restricted to those
raids. Replace the `const previous =` expression with:

```ts
// A partial publish carries everything forward, as it always has. A
// complete one carries forward only the raids that are terminal for
// kills: collection no longer pages into them, so "the run did not
// find it" no longer means "it is gone". Every other raid keeps the
// existing contract, where a kill a complete run stopped finding
// stops being claimed.
const stored = await loadPositiveEvidenceForPartial(client, {
  region: activeRun.region,
  realm: activeRun.realm_slug,
  name: activeRun.normalized_name
});
const previous =
  input.state === "partial"
    ? stored
    : {
        kills: stored.kills.filter((kill) =>
          terminalKillRaidIds.has(kill.raidId)
        ),
        wipes: stored.wipes.filter((wipe) =>
          terminalKillRaidIds.has(wipe.raidId)
        )
      };
```

`previous` is then always non-null, so the two `previous?.` reads below it can
stay as they are — optional chaining on a defined value is harmless — or be
simplified to `previous.`. Prefer simplifying, and keep the `?? []` on the wipes
spread only if the type still permits undefined.

Now make `collected_at` explicit so a carried kill keeps its observation time.
Alongside `storedPerformance`, load the stored times:

```ts
const storedCollectedAt = new Map(
  (
    await client.query<{ fight_url: string; collected_at: Date }>(
      `SELECT k.fight_url, max(k.collected_at) AS collected_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                  GROUP BY k.fight_url`,
      [activeRun.region, activeRun.realm_slug, activeRun.normalized_name]
    )
  ).rows.map((row) => [row.fight_url, row.collected_at] as const)
);
```

Add `collected_at` to the kill INSERT's column list and a `$24` placeholder, and
pass:

```ts
// This run read the fight only if it came back with a parse.
// A fight carried forward keeps the time it was actually
// observed, so the percentile's age stays honest and drift
// stays measurable — the run's own completion would say every
// untouched fight was just re-read.
incomingFightUrls.has(kill.fightUrl)
  ? input.completedAt
  : (storedCollectedAt.get(kill.fightUrl) ?? input.completedAt);
```

where `incomingFightUrls` is built once, before the loop, from
`input.kills.map((kill) => kill.fightUrl)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm test:integration -- -t "publish"`
Expected: PASS, including both new tests and every pre-existing publish test.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/database tests/integration/repositories.test.ts
git commit -m "fix(database): keep terminal evidence a settled scan no longer re-finds"
```

---

### Task 4: Stop spending parse requests on terminal tiers

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.ts`
- Test: `packages/warcraftlogs/src/client.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks — the gateway is told which raids are terminal, it does not work it out.
- Produces: on `getFirstKillReports`'s options, `terminalRaidIds?: Readonly<{ kills: ReadonlySet<string>; parses: ReadonlySet<string>; tierBests: ReadonlySet<string> }>`. On the `evidence` result, `troubledRaidIds: readonly string[]`.

`troubledRaidIds` is what makes the clean-read rule enforceable per tier rather
than per run. Without it, one zone's drift would either freeze every other zone
or block them all.

- [ ] **Step 1: Write the failing tests**

Add to `packages/warcraftlogs/src/client.test.ts`:

```ts
it("spends no zone request on a tier already terminal for tier bests", async () => {
  const fetch = fetchStub({
    reports: [
      reportPage([killFight({ zoneId: 42 }), killFight({ zoneId: 99 })])
    ],
    zoneRankings: { 42: zoneRankingsBody(42), 99: zoneRankingsBody(99) }
  });
  const client = createWarcraftLogsClient({ fetch, ...credentials });

  const result = await client.getFirstKillReports(key, {
    requestCap: 5,
    parseRequestCap: 24,
    terminalRaidIds: {
      kills: new Set(),
      parses: new Set(),
      tierBests: new Set(["42"])
    }
  });

  expect(result.kind).toBe("evidence");
  expect(zoneIdsRequested(fetch)).toEqual([99]);
});

it("spends no hydration request on a tier already terminal for parses", async () => {
  const fetch = fetchStub({
    reports: [reportPage([killFight({ zoneId: 42, reportCode: "aaa" })])],
    zoneRankings: {}
  });
  const client = createWarcraftLogsClient({ fetch, ...credentials });

  const result = await client.getFirstKillReports(key, {
    requestCap: 5,
    parseRequestCap: 24,
    terminalRaidIds: {
      kills: new Set(),
      parses: new Set(["42"]),
      tierBests: new Set(["42"])
    }
  });

  expect(result.kind).toBe("evidence");
  expect(reportCodesRequested(fetch)).toEqual([]);
});

it("names the raids a zone failure touched so the rest can still settle", async () => {
  const fetch = fetchStub({
    reports: [
      reportPage([killFight({ zoneId: 42 }), killFight({ zoneId: 99 })])
    ],
    zoneRankings: { 42: driftedZoneRankingsBody(), 99: zoneRankingsBody(99) }
  });
  const client = createWarcraftLogsClient({ fetch, ...credentials });

  const result = await client.getFirstKillReports(key, {
    requestCap: 5,
    parseRequestCap: 24
  });

  expect(result).toMatchObject({ kind: "evidence" });
  if (result.kind !== "evidence") throw new Error("expected evidence");
  expect(result.troubledRaidIds).toEqual(["42"]);
});
```

Reuse whatever stub helpers this file already has rather than the invented names
above — read the top of `client.test.ts` first and match its existing fixture
builders. The assertions are what matter: which zone ids and report codes reach
`fetch`, and what `troubledRaidIds` contains.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts`
Expected: FAIL — zone 42 is still requested; `troubledRaidIds` is undefined.

- [ ] **Step 3: Implement**

In `packages/warcraftlogs/src/types.ts`, add to the `getFirstKillReports` options:

```ts
      /**
       * Raids this character is finished with, per collection domain. A
       * terminal raid costs no request: its zone is dropped before the zone
       * budget is measured, and its kills are never grouped for hydration.
       * Whether a raid is terminal is the caller's policy — window, settling
       * and clean-read rules all live with them.
       */
      terminalRaidIds?: Readonly<{
        kills: ReadonlySet<string>;
        parses: ReadonlySet<string>;
        tierBests: ReadonlySet<string>;
      }>;
```

and to the `evidence` result variant:

```ts
      /**
       * Raids a limitation was attributed to during this read. A caller storing
       * evidence indefinitely must not mark these terminal: the tier was read,
       * but not cleanly. Raids absent from this list and from `limitation` /
       * `parseLimitation` were read without incident.
       */
      troubledRaidIds: readonly string[];
```

In `client.ts`:

Declare the collector near `parseLimitation`:

```ts
// Raids this read had trouble with, whatever kind. Kept per raid rather
// than per run so one zone's drift does not stop every other zone settling.
const troubledRaidIds = new Set<string>();
```

Drop terminal zones where `collectedTierZones` is already applied — extend the
`pendingZones` filter:

```ts
const pendingZones = orderedZones.filter((zone) => {
  const raidId = String(zone.zoneId);
  if (options.terminalRaidIds?.tierBests.has(raidId)) return false;
  const collectedAt = options.collectedTierZones?.get(raidId);
  return collectedAt === undefined || collectedAt <= zone.latestKilledAt;
});
```

Record trouble in the zone loop. Where `tierParseLimitation` is assigned from a
failed zone request, and again from `decodeZoneRankings`, add
`troubledRaidIds.add(String(zone.zoneId));` immediately before each assignment.

Skip terminal raids when grouping kills for hydration, beside the existing
`hydratedFightUrls` check:

```ts
if (options.terminalRaidIds?.parses.has(kill.raidId)) continue;
if (options.hydratedFightUrls?.has(kill.fightUrl)) continue;
```

Record trouble in the per-report hydration loop. Wherever `parseLimitation` is
assigned inside that loop (the failed `reportFightParsesQuery`, the
`decodeRankingRows` limitation, the canonical-identity failures, and the
`normalizedPerformance` limitation), add the raids of that group first. A group
is keyed by report code, so derive them once per group:

```ts
const groupRaidIds = new Set(
  [...kills.values()]
    .filter((kill) => kill.reportCode === group.reportCode)
    .map((kill) => kill.raidId)
);
```

and on each failure path in that loop, `for (const raidId of groupRaidIds) troubledRaidIds.add(raidId);`.

Finally add `troubledRaidIds: [...troubledRaidIds].sort()` to **both** returned
`evidence` objects at the end of the function, including the empty
`{ kind: "evidence", kills: [], wipes: [], tierBests: [] }` fallback.

Existing tests asserting on the whole result with `toEqual` will now fail on the
added key. Update them to include `troubledRaidIds: []` rather than loosening
the assertion.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/warcraftlogs
git commit -m "feat(warcraftlogs): spend no parse request on a terminal tier"
```

---

### Task 5: Stop the report scan once it is below every terminal tier

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.ts`
- Test: `packages/warcraftlogs/src/client.test.ts`

**Interfaces:**

- Consumes: the options object extended in Task 4.
- Produces: `killScanFloor?: string` (an ISO instant) on `getFirstKillReports`'s options.

The page scan is the other half of the cost: 353 reports is 36 pages of
`RecentReports` on every run. Reports come newest first, so once a page's
fights are all older than the floor, everything beyond it is too.

A stop here is a **clean** stop. It must not set `scanLimitation`, because a
`request_cap` limitation would mark the run partial, block every `kills` mark by
the clean-read rule, and set a retry — undoing the saving and looping forever.

- [ ] **Step 1: Write the failing tests**

```ts
it("stops paging once a page is entirely below the kill scan floor", async () => {
  const fetch = fetchStub({
    reports: [
      reportPage([killFight({ killedAt: "2026-09-10T00:00:00.000Z" })], {
        hasMorePages: true
      }),
      reportPage([killFight({ killedAt: "2023-01-01T00:00:00.000Z" })], {
        hasMorePages: true
      }),
      reportPage([killFight({ killedAt: "2022-01-01T00:00:00.000Z" })], {
        hasMorePages: true
      })
    ]
  });
  const client = createWarcraftLogsClient({ fetch, ...credentials });

  const result = await client.getFirstKillReports(key, {
    requestCap: 10,
    parseRequestCap: 24,
    killScanFloor: "2024-01-01T00:00:00.000Z"
  });

  expect(result).toMatchObject({ kind: "evidence" });
  if (result.kind !== "evidence") throw new Error("expected evidence");
  // Two pages read: the first is above the floor, the second is wholly below
  // it and ends the scan. The third is never requested.
  expect(reportPagesRequested(fetch)).toEqual([1, 2]);
  // And it is a clean stop, not a cap: a limitation here would mark the run
  // partial and block the very marks that made the stop possible.
  expect(result.limitation).toBeUndefined();
});

it("keeps paging when a page below the floor still carries a newer fight", async () => {
  const fetch = fetchStub({
    reports: [
      reportPage(
        [
          killFight({ killedAt: "2022-01-01T00:00:00.000Z" }),
          killFight({ killedAt: "2026-09-10T00:00:00.000Z" })
        ],
        { hasMorePages: true }
      ),
      reportPage([killFight({ killedAt: "2026-09-01T00:00:00.000Z" })], {
        hasMorePages: false
      })
    ]
  });
  const client = createWarcraftLogsClient({ fetch, ...credentials });

  await client.getFirstKillReports(key, {
    requestCap: 10,
    parseRequestCap: 24,
    killScanFloor: "2024-01-01T00:00:00.000Z"
  });

  expect(reportPagesRequested(fetch)).toEqual([1, 2]);
});

it("pages normally when no floor is given", async () => {
  const fetch = fetchStub({
    reports: [
      reportPage([killFight({ killedAt: "2022-01-01T00:00:00.000Z" })], {
        hasMorePages: true
      }),
      reportPage([killFight({ killedAt: "2021-01-01T00:00:00.000Z" })], {
        hasMorePages: false
      })
    ]
  });
  const client = createWarcraftLogsClient({ fetch, ...credentials });

  await client.getFirstKillReports(key, {
    requestCap: 10,
    parseRequestCap: 24
  });

  expect(reportPagesRequested(fetch)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts`
Expected: FAIL — the first test reads all three pages.

- [ ] **Step 3: Implement**

Add to the options type in `types.ts`:

```ts
      /**
       * The instant below which the report scan may stop, as an ISO string.
       * Set when every tier that closed before it is terminal for kills, so
       * pages older than it can only re-find evidence already stored. Reports
       * come newest first, so a page whose fights all predate this ends the
       * scan — cleanly, with no limitation: a cap here would mark the run
       * partial and block the marks that allowed the stop.
       */
      killScanFloor?: string;
```

In the page loop in `client.ts`, after the page's kills and wipes have been
merged and after the `normalized.limitation` check, before `hasMoreReportPages`:

```ts
if (options.killScanFloor !== undefined) {
  const dated = [
    ...normalized.kills.map((kill) => kill.killedAt),
    ...normalized.wipes.map((wipe) => wipe.attemptedAt)
  ];
  // A page with nothing dated says nothing about how far back we are, so
  // it must not end the scan.
  if (dated.length > 0 && dated.every((at) => at < options.killScanFloor!)) {
    break;
  }
}
```

ISO-8601 UTC strings compare correctly lexicographically, which is how
`earliestKilledAt` is already compared throughout this file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/warcraftlogs
git commit -m "feat(warcraftlogs): stop the report scan below every terminal tier"
```

---

### Task 6: Decide which tiers are terminal, and act on the decision

**Files:**

- Create: `packages/application/src/terminal-tiers.ts`
- Create: `packages/application/src/terminal-tiers.test.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `packages/database/src/postgres-repositories.ts`, `packages/database/src/repositories.ts`
- Modify: `apps/worker/src/config.ts`, `apps/worker/src/config.test.ts`, `apps/worker/src/runtime.ts`, `.env.example`
- Test: `packages/application/src/terminal-tiers.test.ts`, `packages/application/src/applicant-evidence-job-handler.test.ts`

**Interfaces:**

- Consumes: `raidTierConclusion` (Task 1); `terminalTiers` / `markTerminalTiers` (Task 2); `terminalRaidIds`, `killScanFloor`, `troubledRaidIds` (Tasks 4–5).
- Produces:
  - `export function terminalTiersFrom(input: TerminalTierInput): readonly TerminalTier[]`
  - `export function killScanFloorFrom(terminal: readonly TerminalTier[], at: Date): string | undefined`
  - On `ApplicantEvidenceJobHandlerOptions`: `killSettleMs: number`.
  - On `ApplicantEvidenceStore`: `terminalTiers`, `markTerminalTiers`, and `hydratedFightUrls(key, settledBefore)`.

The policy lives here, in one pure module, because it is the part most likely to
be argued with later: the settle threshold is a guess, and freezing a percentile
is a deliberate choice rather than a fact about the data.

- [ ] **Step 1: Write the failing policy tests**

Create `packages/application/src/terminal-tiers.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { killScanFloorFrom, terminalTiersFrom } from "./terminal-tiers";

const at = new Date("2026-09-18T12:00:00.000Z");
const settleMs = 7 * 24 * 60 * 60 * 1000;

const concludedRaid = "Aberrus, the Shadowed Crucible";

function kill(raidId: string, raidName: string, killedAt: string) {
  return { raidId, raidName, killedAt };
}

describe("terminalTiersFrom", () => {
  it("marks every domain of a concluded tier read without incident", () => {
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [kill("42", concludedRaid, "2023-06-01T00:00:00.000Z")],
        scanLimitation: null,
        parseLimitation: null,
        troubledRaidIds: []
      })
    ).toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "parses" },
      { raidId: "42", domain: "tier_bests" }
    ]);
  });

  it("never marks a raid with no catalogued window", () => {
    // `current_content_window_unknown` is live today. An undatable raid must
    // keep being re-queried rather than be frozen against a boundary we do not
    // have.
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [
          kill("42", "Not A Catalogued Raid", "2019-01-01T00:00:00.000Z")
        ],
        scanLimitation: null,
        parseLimitation: null,
        troubledRaidIds: []
      })
    ).toEqual([]);
  });

  it("never marks the current tier", () => {
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [
          kill(
            "42",
            concludedRaid,
            // Read as though the tier were still open.
            "2023-06-01T00:00:00.000Z"
          )
        ],
        scanLimitation: null,
        parseLimitation: null,
        troubledRaidIds: [],
        now: new Date("2023-07-01T00:00:00.000Z")
      })
    ).toEqual([]);
  });

  it("withholds every kill mark when the scan reported a limitation", () => {
    // `schema_changed` and `request_cap` both mean history may be missing, so
    // no tier can be trusted complete, however old it is.
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [kill("42", concludedRaid, "2023-06-01T00:00:00.000Z")],
        scanLimitation: "schema_drift",
        parseLimitation: null,
        troubledRaidIds: []
      })
    ).toEqual([]);
  });

  it("withholds parse marks when the parse read reported a limitation", () => {
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [kill("42", concludedRaid, "2023-06-01T00:00:00.000Z")],
        scanLimitation: null,
        parseLimitation: "parse_request_cap",
        troubledRaidIds: []
      })
    ).toEqual([{ raidId: "42", domain: "kills" }]);
  });

  it("withholds every mark for a raid a limitation was attributed to", () => {
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [
          kill("42", concludedRaid, "2023-06-01T00:00:00.000Z"),
          kill("43", concludedRaid, "2023-06-01T00:00:00.000Z")
        ],
        scanLimitation: null,
        parseLimitation: null,
        troubledRaidIds: ["42"]
      })
    ).toEqual([
      { raidId: "43", domain: "kills" },
      { raidId: "43", domain: "parses" },
      { raidId: "43", domain: "tier_bests" }
    ]);
  });

  it("never marks a tier holding a kill that has not settled", () => {
    expect(
      terminalTiersFrom({
        at,
        settleMs,
        kills: [
          kill("42", concludedRaid, "2023-06-01T00:00:00.000Z"),
          kill("42", concludedRaid, "2026-09-16T00:00:00.000Z")
        ],
        scanLimitation: null,
        parseLimitation: null,
        troubledRaidIds: []
      })
    ).toEqual([]);
  });
});

describe("killScanFloorFrom", () => {
  it("gives no floor when nothing is terminal for kills", () => {
    expect(killScanFloorFrom([], at)).toBeUndefined();
  });

  it("gives no floor while a concluded tier below the newest terminal one is not terminal", () => {
    // The floor is only safe where *every* tier below it is settled; a gap
    // means the scan must still page past it.
    expect(
      killScanFloorFrom([{ raidId: "42", domain: "parses" }], at)
    ).toBeUndefined();
  });
});
```

The third test passes a `now` override; give `TerminalTierInput` an optional
`now` that defaults to `at`, or drop that test and assert the current tier via a
raid whose window is open. Either is fine — do not add a clock to production
code purely for a test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/terminal-tiers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the policy module**

Create `packages/application/src/terminal-tiers.ts`:

```ts
import type { TerminalTier } from "@slashwho/database";
import {
  raidTierConclusion,
  lookupRaidByName,
  lookupRaidCurrentContentWindow
} from "@slashwho/domain";

export type TerminalTierInput = Readonly<{
  /** When this run completed. */
  at: Date;
  /**
   * How long after a kill its rankings are taken to have settled. A kill
   * younger than this is never terminal, whatever tier it belongs to. The
   * value is a guess -- see `EVIDENCE_KILL_SETTLE_DAYS`.
   */
  settleMs: number;
  kills: readonly Readonly<{
    raidId: string;
    raidName: string;
    killedAt: string;
  }>[];
  /** The run's history-scan limitation, if any. */
  scanLimitation: string | null;
  /** The run's parse limitation, if any. */
  parseLimitation: string | null;
  /** Raids this run attributed a limitation to. */
  troubledRaidIds: readonly string[];
}>;

/**
 * Which tiers this run is allowed to stop re-querying.
 *
 * Three rules, all of which must hold, and none of which is an optimisation:
 *
 * 1. The raid's current-content window has closed. An unknown window is never
 *    concluded -- freezing undated evidence is worse than re-querying it.
 * 2. The run read the tier without incident. A limitation anywhere in the scan
 *    means history may be missing; a limitation attributed to this raid means
 *    this tier specifically was not read cleanly. Either way it stays
 *    re-queryable, however old it is.
 * 3. Every kill in the tier has settled. Percentiles move for a few days after
 *    a kill, and freezing one early is unrecoverable without a rebuild.
 *
 * Note what rule 3 accepts: a settled percentile is treated as final even
 * though the pool it ranks against keeps moving. That is a policy choice -- a
 * reviewer wants what the applicant achieved, not a figure that re-rates itself
 * for years -- not a property of the data.
 */
export function terminalTiersFrom(
  input: TerminalTierInput
): readonly TerminalTier[] {
  const settledBefore = input.at.getTime() - input.settleMs;
  const troubled = new Set(input.troubledRaidIds);
  const raids = new Map<string, { raidName: string; settled: boolean }>();
  for (const kill of input.kills) {
    const killedAt = Date.parse(kill.killedAt);
    // An undatable kill cannot be shown to have settled, so it blocks its tier.
    const settled = !Number.isNaN(killedAt) && killedAt < settledBefore;
    const seen = raids.get(kill.raidId);
    raids.set(kill.raidId, {
      raidName: kill.raidName,
      settled: seen ? seen.settled && settled : settled
    });
  }

  const marks: TerminalTier[] = [];
  for (const [raidId, raid] of [...raids].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    if (!raid.settled) continue;
    if (troubled.has(raidId)) continue;
    if (raidTierConclusion(raid.raidName, input.at) !== "concluded") continue;
    if (input.scanLimitation === null) marks.push({ raidId, domain: "kills" });
    if (input.parseLimitation === null) {
      marks.push({ raidId, domain: "parses" });
      marks.push({ raidId, domain: "tier_bests" });
    }
  }
  return marks;
}

/**
 * The instant the report scan may stop at, or `undefined` for no early stop.
 *
 * Safe only where every tier that closed at or before it is terminal for
 * kills. One unsettled tier below the newest terminal one means the scan must
 * still page past it, so the floor is the end of the newest unbroken run of
 * terminal tiers counting from the oldest.
 */
export function killScanFloorFrom(
  terminal: readonly TerminalTier[],
  at: Date
): string | undefined {
  const terminalKillRaids = new Set(
    terminal
      .filter((tier) => tier.domain === "kills")
      .map((tier) => tier.raidId)
  );
  if (terminalKillRaids.size === 0) return undefined;
  return undefined; // replaced below
}
```

`killScanFloorFrom` needs the window of each terminal raid, and the terminal
marks carry Warcraft Logs zone ids rather than Journal raid ids, so the raid
**name** is not available from the marks alone. Implement it against the kills
the run already holds, which carry both, by giving it the same
`kills` list:

```ts
export function killScanFloorFrom(
  terminal: readonly TerminalTier[],
  kills: TerminalTierInput["kills"],
  at: Date
): string | undefined {
  const terminalKillRaids = new Set(
    terminal
      .filter((tier) => tier.domain === "kills")
      .map((tier) => tier.raidId)
  );
  const raidNames = new Map(kills.map((kill) => [kill.raidId, kill.raidName]));
  let floor: string | undefined;
  for (const [raidId, raidName] of [...raidNames].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const raid = lookupRaidByName(raidName);
    const window = raid ? lookupRaidCurrentContentWindow(raid.raidId) : null;
    const endsAt = window?.endsAt ?? null;
    if (endsAt === null || Date.parse(endsAt) > at.getTime()) continue;
    if (!terminalKillRaids.has(raidId)) {
      // A concluded tier that is not terminal has to stay reachable, so the
      // scan may not stop above it.
      floor = floor === undefined || endsAt > floor ? undefined : floor;
      return undefined;
    }
    if (floor === undefined || endsAt > floor) floor = endsAt;
  }
  return floor;
}
```

Simplify that loop while implementing: the requirement is "the newest `endsAt`
among terminal-for-kills raids, but `undefined` if any concluded raid the run
saw is not terminal for kills". Write it as two passes if that reads better.
Update the test's `killScanFloorFrom` calls to the three-argument signature, and
add a positive case asserting the floor equals the terminal raid's `endsAt`.

Export both from `packages/application/src/index.ts`.

- [ ] **Step 4: Run the policy tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/application/src/terminal-tiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing handler test**

Add to `packages/application/src/applicant-evidence-job-handler.test.ts`:

```ts
it("marks a concluded tier terminal after a clean run and passes it to the next", async () => {
  const evidence = store();
  const marked: Array<{ raidId: string; domain: string }> = [];
  evidence.markTerminalTiers = async (_key, tiers) => {
    marked.push(...tiers);
  };
  const getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    tierBests: [],
    wipes: [],
    troubledRaidIds: [],
    kills: [
      {
        raidId: "42",
        raidName: "Aberrus, the Shadowed Crucible",
        bossId: "7",
        bossName: "Boss",
        journalBossId: null,
        bossOrder: 1,
        isFinalBoss: false,
        killedAt: "2023-06-01T00:00:00.000Z",
        reportCode: "abc",
        fightId: 1,
        difficulty: 5,
        reportUrl: "https://www.warcraftlogs.com/reports/abc",
        fightUrl: "https://www.warcraftlogs.com/reports/abc#fight=1",
        guild: null,
        historicWorldRank: null,
        performance: {
          damage: { state: "unavailable" as const },
          healing: { state: "unavailable" as const },
          bossDamage: { state: "unavailable" as const }
        }
      }
    ]
  }));

  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs: { getFirstKillReports, ...openGate },
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 0,
    killSettleMs: 7 * 24 * 60 * 60 * 1000,
    now: () => new Date("2026-09-18T12:00:00.000Z")
  });
  await handler.execute(run.id);

  expect(marked).toEqual([
    { raidId: "42", domain: "kills" },
    { raidId: "42", domain: "parses" },
    { raidId: "42", domain: "tier_bests" }
  ]);
});

it("hands the gateway the tiers it may skip", async () => {
  const evidence = store();
  evidence.terminalTiers = async () => [
    { raidId: "42", domain: "kills" as const },
    { raidId: "42", domain: "tier_bests" as const }
  ];
  const getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    kills: [],
    wipes: [],
    tierBests: [],
    troubledRaidIds: []
  }));

  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs: { getFirstKillReports, ...openGate },
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 0,
    killSettleMs: 7 * 24 * 60 * 60 * 1000
  });
  await handler.execute(run.id);

  expect(getFirstKillReports.mock.calls[0]?.[1]).toMatchObject({
    terminalRaidIds: {
      kills: new Set(["42"]),
      parses: new Set(),
      tierBests: new Set(["42"])
    }
  });
});

it("marks nothing when the run reported a limitation", async () => {
  const evidence = store();
  const marked: Array<{ raidId: string; domain: string }> = [];
  evidence.markTerminalTiers = async (_key, tiers) => {
    marked.push(...tiers);
  };
  const getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    tierBests: [],
    wipes: [],
    troubledRaidIds: [],
    limitation: { kind: "limitation" as const, code: "schema_drift" as const },
    kills: []
  }));

  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs: { getFirstKillReports, ...openGate },
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 0,
    killSettleMs: 7 * 24 * 60 * 60 * 1000
  });
  await handler.execute(run.id);

  expect(marked).toEqual([]);
});
```

Add `terminalTiers` and `markTerminalTiers` stubs to the shared `store()` helper
so every existing test keeps compiling:

```ts
    async terminalTiers() {
      return [];
    },
    async markTerminalTiers() {},
```

- [ ] **Step 6: Run the handler tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`
Expected: FAIL — `killSettleMs` is not an option; nothing is marked.

- [ ] **Step 7: Wire the handler**

On `ApplicantEvidenceStore`, add:

```ts
  terminalTiers(key: CharacterKey): Promise<readonly TerminalTier[]>;
  markTerminalTiers(
    key: CharacterKey,
    tiers: readonly TerminalTier[],
    at: Date
  ): Promise<void>;
```

and change `hydratedFightUrls` to `hydratedFightUrls(key: CharacterKey, settledBefore: Date): Promise<readonly string[]>`.

On the options, add:

```ts
/**
 * How long after a kill its rankings are taken to have settled. A kill
 * younger than this is re-read rather than frozen, and its tier cannot go
 * terminal. The default of seven days is a guess, like
 * `EVIDENCE_POINTS_RESERVE`: the observation times now stored alongside each
 * percentile are what should replace it with a measurement.
 */
killSettleMs: number;
```

In `execute`, where `hydratedFightUrls` and `collectedTierZones` are read:

```ts
const settledBefore = new Date(now().getTime() - options.killSettleMs);
const hydratedFightUrls = new Set(
  await options.evidence.hydratedFightUrls(run.key, settledBefore)
);
const collectedTierZones = new Map(
  await options.evidence.collectedTierZones(run.key)
);
const storedTerminal = await options.evidence.terminalTiers(run.key);
const terminalRaidIds = {
  kills: new Set(
    storedTerminal
      .filter((tier) => tier.domain === "kills")
      .map((tier) => tier.raidId)
  ),
  parses: new Set(
    storedTerminal
      .filter((tier) => tier.domain === "parses")
      .map((tier) => tier.raidId)
  ),
  tierBests: new Set(
    storedTerminal
      .filter((tier) => tier.domain === "tier_bests")
      .map((tier) => tier.raidId)
  )
};
```

Pass `terminalRaidIds` to `getFirstKillReports`. A `rebuild` cleared the marks
before the run was reserved, so nothing extra is needed for it here.

After the successful `evidence.publish(...)` call at the end of `execute`, add:

```ts
// Marked after publication, never before: a mark that outlived a failed
// publish would stop the tier being collected while nothing was stored.
const marks = terminalTiersFrom({
  at: now(),
  settleMs: options.killSettleMs,
  kills: response.kills,
  scanLimitation: response.limitation?.code ?? null,
  parseLimitation: response.parseLimitation?.code ?? null,
  troubledRaidIds: response.troubledRaidIds
});
record.terminalTierCount = marks.length;
if (marks.length > 0) {
  await evidence.markTerminalTiers(run.key, marks, now());
}
```

Add `terminalTierCount: 0` to the initial `record` so the log line's shape is
stable.

Compute the scan floor before the gateway call and pass it:

```ts
const previousKills = (await options.evidence.hydratedKills?.(run.key)) ?? [];
```

Do **not** add another store method for that. The floor needs raid names for
terminal raids, which the run does not have before it scans. Pass
`killScanFloor` derived from the _stored_ marks and the _previous_ run's kills
only if a cheap source is already to hand; otherwise compute the floor at the
end of the run alongside the marks and store nothing — the saving then starts on
the run after next, which is acceptable and simpler.

Take the simpler route: **compute nothing before the scan in this task.** Task 5's
`killScanFloor` is wired in Task 7's integration, where `getCompleted` already
returns the previous kills with their raid names. Leave `killScanFloor` unset
here and note it in the commit message.

Add `killSettleMs` to the worker's handler construction in
`apps/worker/src/runtime.ts`, reading a new config value.

In `apps/worker/src/config.ts`:

```ts
    // Rankings are understood to settle a few days after a kill. Seven days is
    // a guess and is explicitly unverified -- two attempts to measure it
    // retrospectively failed, so the observation times now stored alongside
    // each percentile are what should replace it. Setting it too low freezes a
    // wrong percentile permanently.
    evidenceKillSettleDays: integerInRange(
      environment.EVIDENCE_KILL_SETTLE_DAYS,
      7,
      0,
      365,
      "invalid_evidence_kill_settle_days"
    ),
```

Match `integerInRange`'s actual parameter order in that file rather than the
order above. Add `evidenceKillSettleDays: number` to `WorkerConfig`, a test in
`apps/worker/src/config.test.ts` covering the default and one invalid value
(mirror the `EVIDENCE_POINTS_RESERVE` tests), and to `.env.example`:

```
# Days after a kill before its rankings are taken as settled and its tier may
# stop being re-queried. 7 is a guess and is explicitly unverified.
EVIDENCE_KILL_SETTLE_DAYS=7
```

Finally, implement the `hydratedFightUrls` settle filter in
`postgres-repositories.ts`:

```ts
      async hydratedFightUrls(key, settledBefore) {
        const completed = await loadCompletedEvidence(pool, key);
        const hydrated = new Set(
          (completed?.kills ?? [])
            .filter(
              (kill) =>
                // A kill whose rankings have not settled is re-read rather
                // than left frozen at whatever it showed on the night.
                kill.killedAt < settledBefore &&
                (kill.performance.damage.state === "available" ||
                  kill.performance.healing.state === "available" ||
                  kill.performance.bossDamage.state === "available")
            )
            .map((kill) => kill.fightUrl)
        );
        return [...hydrated].sort();
      },
```

Update `EvidenceRepository.hydratedFightUrls`'s signature and doc comment, and
every existing caller and test.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `corepack pnpm test:unit`
Expected: PASS, all projects.

- [ ] **Step 9: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/application packages/database apps/worker .env.example
git commit -m "feat: mark a concluded tier terminal once a run reads it cleanly"
```

---

### Task 7: Stop the scan early, end to end

**Files:**

- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Modify: `packages/application/src/terminal-tiers.ts` if the floor helper needs adjusting

**Interfaces:**

- Consumes: `killScanFloorFrom` (Task 6), `killScanFloor` (Task 5), `getCompleted` (existing).
- Produces: no new signatures.

Tasks 4 and 6 stop the _parse_ spend. This one stops the _page_ spend, which is
the 36 `RecentReports` requests a 353-report character costs on every run. It is
separated because it depends on reading the previous run's kills for their raid
names, and that is a distinct decision worth reviewing on its own.

- [ ] **Step 1: Write the failing test**

```ts
it("tells the gateway how far back it needs to page", async () => {
  const evidence = store();
  evidence.terminalTiers = async () => [
    { raidId: "42", domain: "kills" as const }
  ];
  evidence.getCompletedKills = async () => [
    {
      raidId: "42",
      raidName: "Aberrus, the Shadowed Crucible",
      killedAt: "2023-06-01T00:00:00.000Z"
    }
  ];
  const getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    kills: [],
    wipes: [],
    tierBests: [],
    troubledRaidIds: []
  }));

  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs: { getFirstKillReports, ...openGate },
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 0,
    killSettleMs: 7 * 24 * 60 * 60 * 1000
  });
  await handler.execute(run.id);

  // Aberrus closed on 2023-11-15, so nothing older than that needs re-reading.
  expect(getFirstKillReports.mock.calls[0]?.[1]).toMatchObject({
    killScanFloor: "2023-11-15T23:00:00.000Z"
  });
});

it("pages the whole history when no tier is terminal for kills", async () => {
  const evidence = store();
  const getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    kills: [],
    wipes: [],
    tierBests: [],
    troubledRaidIds: []
  }));

  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs: { getFirstKillReports, ...openGate },
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 0,
    killSettleMs: 7 * 24 * 60 * 60 * 1000
  });
  await handler.execute(run.id);

  expect(getFirstKillReports.mock.calls[0]?.[1].killScanFloor).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`
Expected: FAIL — `killScanFloor` is undefined in the first test.

- [ ] **Step 3: Implement**

Add to `ApplicantEvidenceStore`:

```ts
  /**
   * The raid id, raid name and kill time of every stored kill, which is what
   * turns a terminal raid id into a date the scan can stop at. Raid names are
   * not derivable from the marks: those carry Warcraft Logs zone ids, and the
   * content windows are keyed by Journal raid.
   */
  storedKillTiers(
    key: CharacterKey
  ): Promise<
    readonly Readonly<{ raidId: string; raidName: string; killedAt: string }>[]
  >;
```

Implement it in `postgres-repositories.ts` beside `collectedTierZones`, scoped
identically through `loadCompletedEvidence`:

```ts
      async storedKillTiers(key) {
        const completed = await loadCompletedEvidence(pool, key);
        return (completed?.kills ?? []).map((kill) => ({
          raidId: kill.raidId,
          raidName: kill.raidName,
          killedAt:
            kill.killedAt instanceof Date
              ? kill.killedAt.toISOString()
              : String(kill.killedAt)
        }));
      },
```

In the handler, beside the `terminalRaidIds` block:

```ts
const killScanFloor = killScanFloorFrom(
  storedTerminal,
  await options.evidence.storedKillTiers(run.key),
  now()
);
```

and pass `...(killScanFloor ? { killScanFloor } : {})` to `getFirstKillReports`.

Add a `storedKillTiers` stub returning `[]` to the test helper `store()`, and
rename the test's `getCompletedKills` to `storedKillTiers` to match.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/application packages/database
git commit -m "feat: stop paging reports below a character's terminal tiers"
```

---

### Task 8: Rebuild one character, from an operator's hands only

**Files:**

- Modify: `packages/application/src/refresh-mode.ts`, `refresh-mode.test.ts`
- Modify: `packages/application/src/refresh-character.ts`, `refresh-character.test.ts`
- Modify: `packages/application/src/applicant-dossier-service.ts`
- Create: `scripts/rebuild-character.mts`
- Create: `scripts/rebuild-character.test.mts`
- Modify: `package.json`
- Test: `apps/web/src/app/api/dossiers/**/refresh/route.test.ts` (or the nearest existing route test)

**Interfaces:**

- Consumes: `clearTerminalTiers` (Task 2).
- Produces: `RefreshMode` gains `"rebuild"`; `refreshCharacter` gains `rebuild?: boolean`; `ApplicantDossierService` gains `rebuildCharacter(key, scope?)`.

A rebuild is a flag. It clears the marks and returns; the existing run, retry and
budget machinery drains the backlog across as many runs as it takes. Doing the
work synchronously would exhaust the allowance and abandon the character
part-way, which is what happened on 2026-09-17.

- [ ] **Step 1: Write the failing tests**

In `packages/application/src/refresh-mode.test.ts`:

```ts
it("never derives a rebuild from the cooldown", () => {
  // `rebuild` is chosen by the caller, never by elapsed time. A reader
  // pressing Refresh asks for current information, not for a character's whole
  // history to be re-collected.
  const modes = [
    refreshMode(null, new Date("2026-09-18T12:00:00.000Z"), 900_000),
    refreshMode(
      new Date("2026-09-18T11:59:00.000Z"),
      new Date("2026-09-18T12:00:00.000Z"),
      900_000
    ),
    refreshMode(
      new Date("2026-09-17T00:00:00.000Z"),
      new Date("2026-09-18T12:00:00.000Z"),
      900_000
    )
  ];
  expect(modes).not.toContain("rebuild");
});
```

In `packages/application/src/refresh-character.test.ts`:

```ts
it("clears every terminal mark before reserving a rebuild", async () => {
  const cleared: unknown[] = [];
  const evidence = evidenceStub();
  evidence.clearTerminalTiers = async (key) => {
    cleared.push(key);
    return 3;
  };

  const result = await refreshCharacter({
    key,
    at: new Date("2026-09-18T12:00:00.000Z"),
    cooldownMs: 900_000,
    rebuild: true,
    repositories: { evidence },
    queue
  });

  expect(cleared).toEqual([key]);
  expect(result.mode).toBe("rebuild");
});

it("does not clear terminal marks on an ordinary refresh", async () => {
  const cleared: unknown[] = [];
  const evidence = evidenceStub();
  evidence.clearTerminalTiers = async (key) => {
    cleared.push(key);
    return 0;
  };

  await refreshCharacter({
    key,
    at: new Date("2026-09-18T12:00:00.000Z"),
    cooldownMs: 900_000,
    repositories: { evidence },
    queue
  });

  expect(cleared).toEqual([]);
});

it("queues a rebuild as one ordinary full run, not a whole history at once", async () => {
  // The flag is the whole mechanism: the backlog drains over as many runs as
  // the points budget allows.
  const enqueued: Array<{ runId: string; meta: unknown }> = [];
  await refreshCharacter({
    key,
    at: new Date("2026-09-18T12:00:00.000Z"),
    cooldownMs: 900_000,
    rebuild: true,
    repositories: { evidence: evidenceStub() },
    queue: {
      async enqueueCharacterEvidence(runId, meta) {
        enqueued.push({ runId, meta });
        return "job-1";
      }
    }
  });

  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]?.meta).toMatchObject({ mode: "full" });
});
```

And a route test asserting the hard requirement. If no test file exists for the
refresh route, create `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/refresh/route.test.ts`:

```ts
it("never produces a rebuild, whatever it is sent", async () => {
  // Hard requirement: the endpoint is unauthenticated, and a press that could
  // re-collect 353 reports would let anyone burn the whole Warcraft Logs
  // allowance on demand.
  const modes: string[] = [];
  const dossiers = {
    async refreshCharacter() {
      modes.push("full");
      return { mode: "full" as const, lastCollectedAt: null };
    }
  };
  // Drive POST with a body asking for a rebuild in every shape a caller might
  // try, then assert the service was called with no mode at all.
  for (const body of [
    JSON.stringify({ mode: "rebuild" }),
    JSON.stringify({ rebuild: true }),
    "rebuild"
  ]) {
    const response = await POST(
      new Request(
        "https://slashwho.test/api/dossiers/eu/silvermoon/rinn/refresh",
        {
          method: "POST",
          body
        }
      ),
      {
        params: Promise.resolve({
          region: "eu",
          realm: "silvermoon",
          name: "rinn"
        })
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "full" });
  }
  expect(modes).toEqual(["full", "full", "full"]);
});
```

Wire `getContainer` however the neighbouring web route tests already do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm test:unit`
Expected: FAIL on the refresh-character tests. The route test should pass
immediately — the route already ignores its body — and is the regression guard.

- [ ] **Step 3: Implement**

`refresh-mode.ts`:

```ts
/**
 * `full` re-scans every report and re-hydrates parses. `light` reads only the
 * most recent page. `rebuild` additionally forgets every terminal mark, so the
 * character's whole history is collected again over as many runs as the budget
 * allows.
 *
 * `refreshMode` never returns `rebuild`: unlike the other two it is chosen by
 * the caller, and only by an operator. It is deliberately unreachable from the
 * unauthenticated dossier refresh route.
 */
export type RefreshMode = "full" | "light" | "rebuild";
```

`refresh-character.ts` — add `rebuild?: boolean` to the options and:

```ts
const mode: RefreshMode = options.rebuild
  ? "rebuild"
  : refreshMode(lastCollectedAt, options.at, options.cooldownMs);

if (options.rebuild) {
  // Clearing the marks *is* the rebuild. Nothing stored is deleted: the
  // existing kills, wipes and tier bests stay readable until their
  // replacements arrive, and the run, retry and budget machinery drains the
  // backlog across as many runs as it takes.
  await evidence.clearTerminalTiers(options.key);
}
```

and, at the enqueue, map the queue's mode:

```ts
      // The queue knows `full` and `light` only. A rebuild is a full run over
      // cleared marks -- the difference is what it no longer skips.
      { enqueuedAt: options.at.toISOString(), mode: mode === "light" ? "light" : "full" }
```

`applicant-dossier-service.ts` — leave `refreshCharacter` exactly as it is, and
add beside it:

```ts
  /**
   * Forgets every terminal mark for one character so its history is collected
   * again. Operator-only: deliberately not reachable from the unauthenticated
   * dossier refresh route, where one press would cost a whole history.
   */
  rebuildCharacter(
    key: CharacterKey,
    scope?: MeasurementScope
  ): Promise<RefreshCharacterResult>;
```

implemented as `refreshCharacter({ ..., rebuild: true })`.

Create `scripts/rebuild-character.mts`, modelled on `scripts/removals.mts`:
export a pure `parseRebuildOperation(argv)` returning `{ characterUrl }`, throw
`character_url_required` on a missing argument, and have `main()` build a `Pool`
and `createDiscoveryQueue` from `DATABASE_URL`, resolve the key with
`parseRaiderIoCharacterUrl`, call the rebuild, and print one JSON line
`{ character, mode, clearedTiers }`. Test the parser in
`scripts/rebuild-character.test.mts` the way `removals.test.mts` tests its own.

Add to `package.json` scripts: `"ops:rebuild": "tsx scripts/rebuild-character.mts"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add packages/application apps/web scripts package.json
git commit -m "feat: rebuild one character's history from an operator trigger"
```

---

### Task 9: Prove it end to end, and write down what changed

**Files:**

- Modify: `tests/integration/repositories.test.ts`
- Modify: `docs/dossier-cache-policy.md`
- Modify: `CONTEXT.md`
- Modify: `packages/database/src/public-api.typecheck.ts` if the new exports belong there

**Interfaces:**

- Consumes: everything above.
- Produces: no new signatures.

- [ ] **Step 1: Write the failing integration test**

```ts
it("converges: a troubled tier keeps being re-queried, a clean one settles", async () => {
  const key = { region: "eu" as const, realm: "silvermoon", name: "converges" };
  const at = new Date("2026-09-18T12:00:00.000Z");

  await repositories.evidence.markTerminalTiers(
    key,
    [{ raidId: "42", domain: "kills" }],
    at
  );

  expect(await repositories.evidence.terminalTiers(key)).toEqual([
    { raidId: "42", domain: "kills" }
  ]);

  // A rebuild forgets the mark and keeps every stored row.
  const first = await repositories.evidence.reserve({
    key,
    freshnessCutoff: at,
    at
  });
  await repositories.evidence.publish(first.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [killInput({ raidId: "42", bossId: "1", fightUrl: "https://a/1" })],
    wipes: [],
    tierBests: [],
    completedAt: at
  });

  expect(await repositories.evidence.clearTerminalTiers(key)).toBe(1);
  expect(await repositories.evidence.terminalTiers(key)).toEqual([]);
  expect((await repositories.evidence.getCompleted(key))?.kills).toHaveLength(
    1
  );
});

it("re-collects only the bumped domain's tiers", async () => {
  // Per-domain versions: marks below the current version for their own domain
  // disappear from `terminalTiers`, and the other domains stay settled. Drive
  // it by writing a row at version 0 directly, since the repository always
  // stamps the current version.
  const key = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "domainbump"
  };
  await pool.query(
    `INSERT INTO character_terminal_tiers
       (region, realm_slug, normalized_name, raid_id, domain, collection_version)
     VALUES ($1, $2, $3, '42', 'parses', 0), ($1, $2, $3, '42', 'kills', 1)`,
    [key.region, key.realm, key.name]
  );

  expect(await repositories.evidence.terminalTiers(key)).toEqual([
    { raidId: "42", domain: "kills" }
  ]);
});

it("keeps a carried kill's observation time rather than restamping it", async () => {
  const key = {
    region: "eu" as const,
    realm: "silvermoon",
    name: "observedat"
  };
  const first = new Date("2026-09-18T12:00:00.000Z");
  const second = new Date("2026-09-19T12:00:00.000Z");
  const reserved = await repositories.evidence.reserve({
    key,
    freshnessCutoff: first,
    at: first
  });
  await repositories.evidence.publish(reserved.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [
      killInput({
        raidId: "42",
        bossId: "1",
        fightUrl: "https://a/1",
        performance: {
          damage: { state: "available", percentile: 95 },
          healing: { state: "unavailable" },
          bossDamage: { state: "unavailable" }
        }
      })
    ],
    wipes: [],
    tierBests: [],
    completedAt: first
  });

  await repositories.evidence.markTerminalTiers(
    key,
    [{ raidId: "42", domain: "kills" }],
    first
  );

  const next = await repositories.evidence.reserve({
    key,
    freshnessCutoff: second,
    at: second
  });
  await repositories.evidence.publish(next.run.id, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [],
    wipes: [],
    tierBests: [],
    completedAt: second
  });

  const stored = await pool.query<{ collected_at: Date }>(
    `SELECT k.collected_at
       FROM character_mythic_kills k
       JOIN character_evidence_runs r ON r.id = k.evidence_run_id
      WHERE r.normalized_name = $1
      ORDER BY r.completed_at DESC
      LIMIT 1`,
    [key.name]
  );
  // The fight was observed on the 18th and merely carried on the 19th. A
  // restamp would make a percentile look freshly checked and destroy the drift
  // measurement the column exists for.
  expect(stored.rows[0]?.collected_at).toEqual(first);
});
```

- [ ] **Step 2: Run the tests to verify they fail, then pass**

Run: `corepack pnpm test:integration`
Expected: FAIL first on whichever behaviour is still missing. Fix, then PASS.

- [ ] **Step 3: Update the documentation**

In `docs/dossier-cache-policy.md`, after the paragraph describing the zone
budget, add a paragraph covering:

- What terminal means, and the three conditions (concluded window, clean read, settled kills).
- That an unknown window is never terminal and keeps raising `current_content_window_unknown`.
- That percentiles and world ranks are frozen by policy, not because they cannot move.
- That a report deleted or made private keeps its stored evidence.
- The per-domain collection versions and what bumping one does.
- `EVIDENCE_KILL_SETTLE_DAYS`, its default of 7, and that it is unverified.
- `corepack pnpm ops:rebuild <character-url>` as the correction path, and that the dossier refresh control cannot reach it.
- That a dossier now converges over several runs rather than completing in one pass.

In `CONTEXT.md`, add a language entry:

```markdown
**Terminal tier**:
A raid tier one character's evidence is stored for indefinitely and never
re-queried. A tier becomes terminal only when its current-content window has
closed, the run that read it reported no limitation for it, and every kill in
it is older than `EVIDENCE_KILL_SETTLE_DAYS`. A raid with no catalogued window
is never terminal. The stored percentiles are treated as final by policy, not
because a ranking cannot move.
_Avoid_: Archived tier, frozen evidence, cached tier
```

- [ ] **Step 4: Run everything**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test:unit && corepack pnpm test:integration
```

- [ ] **Step 5: Commit and raise the follow-up issue**

```bash
git add docs CONTEXT.md tests packages
git commit -m "test: prove concluded tiers settle and troubled ones keep retrying"
```

Then raise the follow-up for the upstreams this plan deliberately left out:

```bash
gh issue create \
  --title "Retain concluded-tier evidence for Raider.IO and Blizzard too" \
  --body "Follow-up to #285, which implemented concluded-tier retention for Warcraft Logs only.

The spec's retention table (\`docs/superpowers/specs/2026-09-18-concluded-tier-retention-design.md\`) also covers Raider.IO \`raid-progress\`, Raider.IO world boss rankings, Blizzard achievements and the Blizzard class index. None of those is stored per character today:

- \`getHistoricMythicKills\` (Raider.IO \`raid-progress\`) has no caller in the dossier path at all.
- World boss rankings and achievements are 15-minute in-process bounded caches, per \`docs/dossier-cache-policy.md\`.
- The class index is static data fetched per process.

Making any of them terminal means building per-character persistence that does not exist, which is why #285 scoped to Warcraft Logs, where the cost actually is."
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: the conclusion check
(Task 1), terminal storage (Task 2), the carry-forward that makes it safe (Task
3), the parse and scan savings (Tasks 4–5, 7), the clean-read rule and the settle
threshold (Task 6), the rebuild and the route guarantee (Task 8), per-domain
versions (Task 2, proved in Task 9), observation timestamps (Tasks 2–3, proved in
Task 9), documentation (Task 9). The spec's other upstreams are excluded by an
explicit scope decision recorded at the top, with a follow-up issue in Task 9.

**Spec tests.** All ten of the spec's listed tests appear: no re-query of a
concluded tier (Tasks 4–5), a troubled tier stays re-queryable (Task 6), settle
(Task 6), rebuild over several runs and keeping evidence (Tasks 8–9), the route
never rebuilding (Task 8), unknown window (Tasks 1, 6), a domain bump (Task 9),
and a newly connected character collecting once (covered by the same paths — it
is a character with no marks, which Task 7's second test asserts).

**A gap worth naming.** "A tier that concludes between two runs becomes terminal
at the boundary" is covered only indirectly: `raidTierConclusion` is evaluated
against `now()` on every run, so the first run after the boundary marks it. Add
an explicit assertion for it in Task 6's policy tests if it is cheap.

**Known rough edge.** Task 6's `killScanFloorFrom` is sketched twice, because the
first sketch cannot work — terminal marks carry Warcraft Logs zone ids, and the
content windows are keyed by Journal raid id, so the raid _name_ has to come from
the kills. The second signature is the one to implement; the task says so
explicitly and Task 7 supplies the kills through `storedKillTiers`. Simplify the
loop while implementing rather than transcribing it.
