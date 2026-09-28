# Raider.IO-logged first kills in settled tiers: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** each character reads a settled Raider.IO tier's logged first kills
once every 90 days or so. Their rosters keep being re-read from what was
stored. Presence is recorded on the first kill, so a partial run cannot skip
the check.

**Architecture:**

- A new per-character table, `character_raiderio_tier_reads`, lets
  `historicTierOrdinalsFrom` keep asking a settled tier until the tier is
  marked.
- The handler marks a tier only after a complete publish with a clean
  Raider.IO phase.
- Stored first kills in raids a run did not ask about are rebuilt as kill-list
  entries and fed to `collectRaiderIoFirstKills`, so they get due re-reads and
  presence checks.
- A new `presence_checked` column on `character_raiderio_first_kills` replaces
  the inferred "established" rule.

**Tech stack:** TypeScript, Vitest (projects `unit` and `integration`),
PostgreSQL through `pg`, Drizzle schema with hand-written SQL migrations.
Run pnpm as `corepack pnpm`.

**Spec:** `docs/superpowers/specs/2026-09-28-raiderio-logged-kills-back-catalogue-design.md`.
Read it before starting any task; the tasks argue from it.

## Global constraints

- Only parsed fields are stored, never `log.sources` or a raw Raider.IO
  response. Nothing new is logged.
- A partial result never removes kill evidence. A partial publish carries every
  stored first kill forward.
- No Raider.IO shortfall schedules a whole-run retry (`retryAfterMs` is
  untouched).
- The phase bounds are unchanged: `MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN
= 50`, concurrency 4, and a 429 or a throw abandons the queue.
- Constants: `CURRENT_RAIDER_IO_TIER_READ_VERSION = 1`;
  `RAIDER_IO_TIER_READ_TTL_MS = 90 days`; offset 0-14 whole days from a stable
  hash of the character key.
- No bump to `CURRENT_EVIDENCE_VERSION` or `CURRENT_COLLECTION_VERSIONS`.
- Migration `0067_raiderio_tier_reads`: journal `idx` 66,
  `when` 1792011600018. If #738 lands first with `0067`, renumber to `0068`,
  and update the journal `idx`, a `when` greater than #738's, and the
  migrations test's slice.
- Tests use synthetic identities only (`alfa`, `Fixture Guild Alfa`, ids
  `424_242` and `700_001`), with no live Raider.IO or Warcraft Logs traffic.
- UK English in comments and docs. Match the surrounding comment density.
- Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review focus

These are the failure modes most likely to reach a person, one line each,
with the task that pins each one:

1. **A complete run with a marked tier deletes the tier's first kills.** This
   happens if rebuilt kills are filtered to due ones while their raids join
   `askedRaidSlugs`. Pinned in Task 5, Step 1, test "keeps every rebuilt
   kill".
2. **A partial run lets an opened roster count as established.** Pinned in
   Task 4, Step 1, test "presence regression".
3. **A tier is marked by a run that never really collected it** (partial,
   phase threw, phase skipped, targeted). Pinned in Task 5, Step 1, the
   `it.each` of no-mark cases.
4. **A back-catalogue tier costs Warcraft Logs points** through its kills as
   search hints or its guilds. Pinned in Task 3, Step 1, test "keeps a
   back-catalogue tier out of kills and guilds".
5. **A profile with no Raider.IO id holds every run partial for good.** Pinned
   in Task 4, Step 1, test "no id", and in Task 5, the no-id handler test.

---

### Task 1: storage for tier reads and the presence flag

**Files:**

- Create: `packages/database/drizzle/0067_raiderio_tier_reads.sql`
- Modify: `packages/database/drizzle/meta/_journal.json` (append an entry)
- Modify: `packages/database/src/schema.ts` (new table after
  `characterTerminalTiers`, and a new column on `characterRaiderIoFirstKills`
  near line 1503)
- Modify: `packages/database/src/evidence/freshness.ts` (constant)
- Modify: `packages/database/src/repositories.ts` (the
  `CharacterRaiderIoFirstKillInput` field at line 619, and two optional
  methods beside `clearTerminalTiers` at line 1302)
- Modify: `packages/database/src/evidence/raiderio-first-kills.ts` (the row
  type, `mapFirstKill`, the `SELECT` in `loadRunRaiderIoFirstKills`, and
  `insertRaiderIoFirstKills`)
- Modify: `packages/database/src/evidence/repository.ts` (implement the two
  methods; `clearTerminalTiers` also clears tier reads, in one transaction)
- Modify: `packages/database/src/index.ts` (export the constant, if
  `CURRENT_COLLECTION_VERSIONS` is exported there; follow whatever it does)
- Modify: `tests/integration/repository-fixtures.ts` (add
  `character_raiderio_tier_reads` to the `TRUNCATE`)
- Modify: `tests/integration/migrations.test.ts` (table list near line 45, and
  the journal slice at line 187: move the slice window by one and append
  `{ idx: 66, tag: "0067_raiderio_tier_reads" }`)
- Test: `tests/integration/repositories-raiderio-first-kills.test.ts`

**Interfaces:**

- Produces:
  - `CharacterRaiderIoFirstKillInput.presenceChecked?: boolean`. Absent means
    false. Loaded rows always set it.
  - `EvidenceRepository.raiderIoTierReads?(key: CharacterKey, since: Date): Promise<readonly number[]>`
    returns the ordinals marked at `>= CURRENT_RAIDER_IO_TIER_READ_VERSION`
    with `read_at >= since`, ascending.
  - `EvidenceRepository.markRaiderIoTierReads?(key: CharacterKey, ordinals: readonly number[], at: Date): Promise<void>`
  - `CURRENT_RAIDER_IO_TIER_READ_VERSION = 1`, exported from
    `@slashwho/database`.

- [ ] **Step 1: Write the failing integration tests**

Append these inside the `describe` in
`tests/integration/repositories-raiderio-first-kills.test.ts`. Reuse the file's
`reserve` and `firstKill` helpers and `rootKey`.

```ts
it("round-trips presence_checked, and reads a missing flag as false", async () => {
  const runId = await reserve("2026-09-28T12:00:00.000Z");
  await repositories.evidence.publish(runId, {
    state: "complete",
    limitationCode: null,
    parseLimitationCode: null,
    kills: [],
    wipes: [],
    tierBests: [],
    raiderIoFirstKills: {
      kills: [
        firstKill({ presenceChecked: true }),
        // A staged collection written before the deploy carries no flag.
        firstKill({ bossSlug: "belo-ren", loggedEncounterId: 700_002 })
      ],
      askedRaidSlugs: ["tier-mn-1"],
      limitationCode: null
    },
    completedAt: new Date("2026-09-28T12:05:00.000Z")
  });

  const stored = await repositories.evidence.storedRaiderIoFirstKills!(rootKey);
  expect(stored.map((kill) => [kill.bossSlug, kill.presenceChecked])).toEqual([
    ["belo-ren", false],
    ["midnight-falls", true]
  ]);
});

it("marks tier reads, gated on version and read_at, and never lowers the version", async () => {
  const reads = repositories.evidence;
  await reads.markRaiderIoTierReads!(
    rootKey,
    [22, 23],
    new Date("2026-06-01T00:00:00.000Z")
  );
  await reads.markRaiderIoTierReads!(
    rootKey,
    [24],
    new Date("2026-09-01T00:00:00.000Z")
  );

  expect(
    await reads.raiderIoTierReads!(
      rootKey,
      new Date("2026-05-01T00:00:00.000Z")
    )
  ).toEqual([22, 23, 24]);
  // Expired: older than `since`.
  expect(
    await reads.raiderIoTierReads!(
      rootKey,
      new Date("2026-08-01T00:00:00.000Z")
    )
  ).toEqual([24]);

  // An older worker's mark must not lower the version.
  await pool.query(
    `UPDATE character_raiderio_tier_reads SET collection_version = 99
        WHERE tier_ordinal = 22`
  );
  await reads.markRaiderIoTierReads!(
    rootKey,
    [22],
    new Date("2026-09-02T00:00:00.000Z")
  );
  const row = await pool.query<{ collection_version: number }>(
    `SELECT collection_version FROM character_raiderio_tier_reads
        WHERE tier_ordinal = 22`
  );
  expect(row.rows[0]!.collection_version).toBe(99);

  // A mark below the current version is not read back.
  await pool.query(
    `UPDATE character_raiderio_tier_reads SET collection_version = 0
        WHERE tier_ordinal = 23`
  );
  expect(
    await reads.raiderIoTierReads!(
      rootKey,
      new Date("2026-05-01T00:00:00.000Z")
    )
  ).toEqual([22, 24]);
});

it("clears tier reads with a rebuild's terminal marks", async () => {
  await repositories.evidence.markRaiderIoTierReads!(
    rootKey,
    [22],
    new Date("2026-09-01T00:00:00.000Z")
  );

  await repositories.evidence.clearTerminalTiers(rootKey);

  expect(
    await repositories.evidence.raiderIoTierReads!(
      rootKey,
      new Date("2026-01-01T00:00:00.000Z")
    )
  ).toEqual([]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm vitest run --project integration tests/integration/repositories-raiderio-first-kills.test.ts`
Expected: FAIL. TypeScript accepts `presenceChecked` only after Step 3, so
expect a type or `undefined is not a function` failure on
`markRaiderIoTierReads`.

- [ ] **Step 3: Write the migration**

Create `packages/database/drizzle/0067_raiderio_tier_reads.sql`:

```sql
-- Raider.IO tiers each character has read after they settled (#732 follow-up).
--
-- A tier whose raids all closed before the character's kill-scan floor is
-- asked once, and not again while its mark is current, so its logged first
-- kills are collected without asking on every run. Keyed by character, not by
-- run: nothing cascades to it, and a rebuild clears it with the terminal
-- marks.
CREATE TABLE "character_raiderio_tier_reads" (
	"region" text NOT NULL,
	"realm_slug" text NOT NULL,
	"normalized_name" text NOT NULL,
	"tier_ordinal" integer NOT NULL,
	"collection_version" integer NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_raiderio_tier_reads_pkey" PRIMARY KEY("region","realm_slug","normalized_name","tier_ordinal")
);
--> statement-breakpoint
-- Whether a published first kill's presence was checked against a visible
-- roster. False until checked; existing rows are checked again once.
ALTER TABLE "character_raiderio_first_kills" ADD COLUMN "presence_checked" boolean DEFAULT false NOT NULL;
```

Append to `packages/database/drizzle/meta/_journal.json` `entries`:

```json
{
  "idx": 66,
  "version": "7",
  "when": 1792011600018,
  "tag": "0067_raiderio_tier_reads",
  "breakpoints": true
}
```

In `packages/database/src/schema.ts`, add `presenceChecked:
boolean("presence_checked").default(false).notNull(),` to
`characterRaiderIoFirstKills` after `historicRankCheckedAt`. Import `boolean`
from `drizzle-orm/pg-core` if it isn't imported yet. After
`characterTerminalTiers`, add:

```ts
/**
 * Raider.IO tiers each character has read after they settled. A tier whose
 * raids all closed before the kill-scan floor is asked again only once its
 * mark falls below the current version or expires.
 */
export const characterRaiderIoTierReads = pgTable(
  "character_raiderio_tier_reads",
  {
    region: text("region").notNull(),
    realmSlug: text("realm_slug").notNull(),
    normalizedName: text("normalized_name").notNull(),
    tierOrdinal: integer("tier_ordinal").notNull(),
    collectionVersion: integer("collection_version").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "character_raiderio_tier_reads_pkey",
      columns: [
        table.region,
        table.realmSlug,
        table.normalizedName,
        table.tierOrdinal
      ]
    })
  ]
);
```

- [ ] **Step 4: Add the constant, the types and the methods**

In `packages/database/src/evidence/freshness.ts`, after
`CURRENT_COLLECTION_VERSIONS`:

```ts
/**
 * The collection version of `character_raiderio_tier_reads`. Bump it when a
 * fix changes what a settled tier's Raider.IO first kills collect: every
 * settled tier is then asked once more, and nothing else is re-collected.
 */
export const CURRENT_RAIDER_IO_TIER_READ_VERSION = 1;
```

In `packages/database/src/repositories.ts`, add this to
`CharacterRaiderIoFirstKillInput`:

```ts
  /**
   * Whether this kill passed the presence check against a visible roster.
   * Absent reads as false, so an unchecked kill is checked again; never
   * inferred from the roster's history.
   */
  presenceChecked?: boolean;
```

Beside `clearTerminalTiers`, add:

```ts
  /** Settled Raider.IO tiers read at the current version since `since`. */
  raiderIoTierReads?(key: CharacterKey, since: Date): Promise<readonly number[]>;
  /**
   * Marks settled tiers as read. Written only after a complete publish whose
   * Raider.IO phase fell short of nothing. Never lowers a stored version.
   */
  markRaiderIoTierReads?(
    key: CharacterKey,
    ordinals: readonly number[],
    at: Date
  ): Promise<void>;
```

Update `clearTerminalTiers`' doc comment to say it also clears the character's
Raider.IO tier reads.

In `packages/database/src/evidence/raiderio-first-kills.ts`:

- add `presence_checked: boolean;` to `FirstKillRow`;
- add `presence_checked` to the `SELECT` in `loadRunRaiderIoFirstKills`;
- add `presenceChecked: row.presence_checked` to `mapFirstKill`;
- add
  `["presence_checked", "boolean", (kill) => kill.presenceChecked === true]`
  to `insertRaiderIoFirstKills`.

`insertEvidenceRows` takes any SQL type name and casts it as
`$n::boolean[]`, so `rows.ts` needs no change.

In `packages/database/src/evidence/repository.ts`, next to `clearTerminalTiers`:

```ts
      async raiderIoTierReads(key, since) {
        if (Number.isNaN(since.valueOf())) {
          throw new RangeError("character_raiderio_tier_read_time_invalid");
        }
        const result = await pool.query<{ tier_ordinal: number }>(
          `SELECT tier_ordinal
             FROM character_raiderio_tier_reads
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND collection_version >= $4 AND read_at >= $5
            ORDER BY tier_ordinal`,
          [
            key.region,
            key.realm,
            key.name,
            CURRENT_RAIDER_IO_TIER_READ_VERSION,
            since
          ]
        );
        return result.rows.map((row) => row.tier_ordinal);
      },

      async markRaiderIoTierReads(key, ordinals, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_raiderio_tier_read_time_invalid");
        }
        if (ordinals.length === 0) return;
        // GREATEST: a worker from an older release, mid-deploy, must not lower
        // a mark a newer one wrote.
        await pool.query(
          `INSERT INTO character_raiderio_tier_reads
             (region, realm_slug, normalized_name, tier_ordinal,
              collection_version, read_at)
           SELECT $1, $2, $3, ordinal, $5, $6
             FROM unnest($4::integer[]) AS ordinal
           ON CONFLICT (region, realm_slug, normalized_name, tier_ordinal)
           DO UPDATE SET
             collection_version = GREATEST(
               character_raiderio_tier_reads.collection_version,
               EXCLUDED.collection_version
             ),
             read_at = EXCLUDED.read_at`,
          [
            key.region,
            key.realm,
            key.name,
            ordinals,
            CURRENT_RAIDER_IO_TIER_READ_VERSION,
            at
          ]
        );
      },
```

Change `clearTerminalTiers` so both deletes run in one transaction, with the
`withTransaction` helper from `../sql` that `raiderio-first-kills.ts` already
uses:

```ts
      async clearTerminalTiers(key) {
        // Marks only. The stored kills, wipes and tier bests stay exactly where
        // they are: a rebuild must not leave a dossier empty while it waits for
        // the replacement evidence to arrive. Raider.IO tier reads go with the
        // terminal marks, so a rebuild asks every settled tier again even if
        // its first run is rate limited before the floor returns.
        return withTransaction(pool, async (client) => {
          const result = await client.query(
            `DELETE FROM character_terminal_tiers
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [key.region, key.realm, key.name]
          );
          await client.query(
            `DELETE FROM character_raiderio_tier_reads
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [key.region, key.realm, key.name]
          );
          return result.rowCount ?? 0;
        });
      },
```

Import `CURRENT_RAIDER_IO_TIER_READ_VERSION` next to
`CURRENT_COLLECTION_VERSIONS` at the top of `repository.ts`. Import
`withTransaction` if `repository.ts` doesn't already.

Add `character_raiderio_tier_reads,` to the `TRUNCATE` in
`tests/integration/repository-fixtures.ts`, next to
`character_terminal_tiers`. Add `"character_raiderio_tier_reads",` in sorted
position to the table list in `tests/integration/migrations.test.ts`. Also
update the journal slice assertion: change `.slice(-35)` to `.slice(-36)` and
append `{ idx: 66, tag: "0067_raiderio_tier_reads" }`. If an existing test
already checks that `firstKill()` round-trips with `toEqual`, add
`presenceChecked: false` to the expected value.

- [ ] **Step 5: Run the tests and see them pass**

Run: `corepack pnpm vitest run --project integration tests/integration/repositories-raiderio-first-kills.test.ts tests/integration/migrations.test.ts tests/integration/repositories-evidence.test.ts`
Expected: PASS. If a `toEqual` on a loaded first kill now fails because of
the extra `presenceChecked: false`, add the field to that expectation. That
is a correct consequence, not a bug.

- [ ] **Step 6: Typecheck and commit**

Run: `corepack pnpm typecheck`
Expected: no errors.

```bash
git add packages/database tests/integration
git commit -m "feat(database): store settled Raider.IO tier reads and first-kill presence

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: the merge keeps the presence flag

**Files:**

- Modify: `packages/database/src/evidence/merge.ts:237-264` (`mergeFirstKill`)
- Test: `packages/database/src/evidence/merge.test.ts`

**Interfaces:**

- Consumes: `CharacterRaiderIoFirstKillInput.presenceChecked` (Task 1).

- [ ] **Step 1: Write the failing tests**

Append to `packages/database/src/evidence/merge.test.ts`, with the file's
imports. `mergeRaiderIoFirstKills` is exported from `./merge`.

```ts
describe("mergeRaiderIoFirstKills presence", () => {
  const read: CharacterRaiderIoFirstKillInput = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: null,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: null,
    presenceChecked: true
  };
  const publication = (kills: readonly CharacterRaiderIoFirstKillInput[]) => ({
    kills,
    askedRaidSlugs: ["tier-mn-1"],
    limitationCode: null
  });

  it("takes the flag of a kill the run found again", () => {
    expect(
      mergeRaiderIoFirstKills(
        [read],
        publication([{ ...read, presenceChecked: false }]),
        "complete",
        false
      )[0]!.presenceChecked
    ).toBe(false);
  });

  it("keeps the previous flag when it keeps the previous read", () => {
    // Raider.IO dropped the link: the incoming row is unavailable, unchecked.
    const dropped: CharacterRaiderIoFirstKillInput = {
      ...read,
      loggedEncounterId: null,
      encounterState: "unavailable",
      encounterLimitationCode: null,
      presenceChecked: false
    };
    expect(
      mergeRaiderIoFirstKills([read], publication([dropped]), "complete", false)
    ).toEqual([read]);
  });

  it("carries a row's own flag through a partial run", () => {
    const unchecked = { ...read, presenceChecked: false };
    expect(
      mergeRaiderIoFirstKills([unchecked], publication([]), "partial", false)
    ).toEqual([unchecked]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm vitest run --project unit packages/database/src/evidence/merge.test.ts`
Expected: FAIL on "keeps the previous flag". The spread of `incoming`
carries `presenceChecked: false`.

- [ ] **Step 3: Implement**

In `mergeFirstKill`, add the flag inside the `keepRead` spread:

```ts
    ...(keepRead
      ? {
          killedAt: previous.killedAt,
          loggedEncounterId: previous.loggedEncounterId,
          encounterState: "read" as const,
          encounterLimitationCode: null,
          // The read that is kept was checked (or not) as it was read.
          presenceChecked: previous.presenceChecked === true
        }
      : {}),
```

- [ ] **Step 4: Run them to see them pass**

Run: `corepack pnpm vitest run --project unit packages/database/src/evidence/merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/evidence
git commit -m "fix(database): keep a kept read's presence flag in the first-kill merge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: tier selection, the back-catalogue split and the read TTL

**Files:**

- Modify: `packages/application/src/verified-kills.ts`
- Create: `packages/application/src/raiderio-tier-reads.ts`
- Test: `packages/application/src/verified-kills.test.ts`
- Test: `packages/application/src/raiderio-tier-reads.test.ts`

**Interfaces:**

- Produces:
  - `settledTierOrdinals(killScanFloor: string | undefined, tiers?, contentWindowEnd?): readonly number[]`:
    the tiers whose raids all closed before the floor, never the last one.
  - `historicTierOrdinalsFrom(killScanFloor: string | undefined, markedTierOrdinals: ReadonlySet<number>, tiers?, contentWindowEnd?): readonly number[]`.
    Note the new required second parameter.
  - `raiderIoVerifiedKills` option
    `markedTierOrdinals: ReadonlySet<number>` (required).
  - On `VerifiedKillsResult`:
    - `backCatalogueTierOrdinals?: readonly number[]`, the tiers asked only
      because they were unmarked;
    - `currentRaidSlugs?: readonly string[]`, the raids of asked tiers that
      are not settled.
  - `raiderIoTierReadSince(key: CharacterKey, at: Date): Date`, with
    `RAIDER_IO_TIER_READ_TTL_MS` and `raiderIoTierReadOffsetMs(key)`.

- [ ] **Step 1: Write the failing tests**

In `packages/application/src/verified-kills.test.ts`, update the two existing
`historicTierOrdinalsFrom` calls to pass `new Set([1, 2, 3, 4])` as the new
second argument (every tier marked, which keeps their meaning). Then append:

```ts
it("keeps an unmarked settled tier, and leaves out a marked one", () => {
  const tiers = [
    { ordinal: 1, raidSlugs: ["closed"] },
    { ordinal: 2, raidSlugs: ["closed-too"] },
    { ordinal: 3, raidSlugs: ["current"] }
  ];
  const ends = (slug: string) =>
    slug === "current" ? null : "2020-01-01T00:00:00.000Z";

  expect(
    historicTierOrdinalsFrom(
      "2021-01-01T00:00:00.000Z",
      new Set([2]),
      tiers,
      ends
    )
  ).toEqual([1, 3]);
  expect(settledTierOrdinals("2021-01-01T00:00:00.000Z", tiers, ends)).toEqual([
    1, 2
  ]);
});

it("keeps every tier without a floor, marked or not", () => {
  expect(historicTierOrdinalsFrom(undefined, new Set([19, 20])).length).toBe(
    raiderIoHistoricTiers.length
  );
});
```

Add this to the `raiderIoVerifiedKills` describe. Copy the call shape of the
existing tests there, including how they stub `getHistoricMythicKills`:

```ts
it("keeps a back-catalogue tier out of kills and guilds, and in askedRaidSlugs", async () => {
  // Break caught (#734 follow-up review): a settled tier's guilds reaching a
  // tier search would spend Warcraft Logs points on attendance nobody needs.
  const settledKill: HistoricMythicKill = {
    raidSlug: "nerubar-palace",
    bossSlug: "queen-ansurek",
    firstDefeated: "2024-10-01T20:00:00.000Z",
    guild: { name: "Fixture Guild Bravo", realm: "draenor", region: "eu" },
    loggedEncounterId: 700_002
  };
  const getHistoricMythicKills = vi.fn(async () => ({
    kind: "evidence" as const,
    kills: [settledKill]
  }));

  const result = await raiderIoVerifiedKills(
    { getHistoricMythicKills },
    { region: "eu", realm: "draenor", name: "alfa" },
    {
      storedKills: [],
      // Above every pinned raid's close, so every tier but the last settles.
      killScanFloor: "2026-09-01T00:00:00.000Z",
      markedTierOrdinals: new Set()
    }
  );

  expect(result.firstKills).toEqual([settledKill]);
  expect(result.askedRaidSlugs).toContain("nerubar-palace");
  expect(result.kills).toEqual([]);
  expect(result.guilds).toEqual([]);
  expect(result.backCatalogueTierOrdinals).toContain(32);
  expect(result.currentRaidSlugs).toEqual(["tier-mn-1"]);
});
```

Create `packages/application/src/raiderio-tier-reads.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  RAIDER_IO_TIER_READ_TTL_MS,
  raiderIoTierReadOffsetMs,
  raiderIoTierReadSince
} from "./raiderio-tier-reads";

const dayMs = 24 * 60 * 60 * 1_000;

describe("raiderIoTierReadSince", () => {
  it("expires a mark after 90 days plus a stable offset of up to 14 days", () => {
    const key = { region: "eu" as const, realm: "draenor", name: "alfa" };
    const at = new Date("2026-09-28T12:00:00.000Z");
    const offset = raiderIoTierReadOffsetMs(key);

    expect(RAIDER_IO_TIER_READ_TTL_MS).toBe(90 * dayMs);
    expect(offset).toBe(raiderIoTierReadOffsetMs({ ...key }));
    expect(offset % dayMs).toBe(0);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(14 * dayMs);
    expect(raiderIoTierReadSince(key, at).getTime()).toBe(
      at.getTime() - RAIDER_IO_TIER_READ_TTL_MS - offset
    );
  });

  it("spreads offsets across characters", () => {
    const offsets = new Set(
      [
        "alfa",
        "bravo",
        "charlie",
        "delta",
        "echo",
        "foxtrot",
        "golf",
        "hotel"
      ].map((name) =>
        raiderIoTierReadOffsetMs({ region: "eu", realm: "draenor", name })
      )
    );
    expect(offsets.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/verified-kills.test.ts packages/application/src/raiderio-tier-reads.test.ts`
Expected: FAIL. `settledTierOrdinals` and `./raiderio-tier-reads` are not
defined, and `historicTierOrdinalsFrom` still drops tier 2's settled sibling.

- [ ] **Step 3: Implement**

Create `packages/application/src/raiderio-tier-reads.ts`:

```ts
import type { CharacterKey } from "@slashwho/domain";

const dayMs = 24 * 60 * 60 * 1_000;

/**
 * How long a settled Raider.IO tier's read stands before it is asked again.
 * Raider.IO can attach a logged encounter to an old kill later, or withdraw
 * one, and a name can change owner; a re-ask is one request per tier.
 */
export const RAIDER_IO_TIER_READ_TTL_MS = 90 * dayMs;
const MAX_OFFSET_DAYS = 14;

/**
 * A stable 0-14 day offset per character, so tiers marked in the same rollout
 * week do not all fall due on the same day. FNV-1a over the key.
 */
export function raiderIoTierReadOffsetMs(key: CharacterKey): number {
  let hash = 0x811c9dc5;
  for (const char of `${key.region}/${key.realm}/${key.name}`) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % (MAX_OFFSET_DAYS + 1)) * dayMs;
}

/** Marks read before this are expired for the character. */
export function raiderIoTierReadSince(key: CharacterKey, at: Date): Date {
  return new Date(
    at.getTime() - RAIDER_IO_TIER_READ_TTL_MS - raiderIoTierReadOffsetMs(key)
  );
}
```

In `packages/application/src/verified-kills.ts`, replace
`historicTierOrdinalsFrom` with:

```ts
type PinnedTier = Readonly<{ ordinal: number; raidSlugs: readonly string[] }>;

/**
 * The tiers every raid of which stopped being current content before the
 * character's scan floor. Whatever such a tier returns is below the floor or a
 * first kill made after its raid's window closed, so it holds no search hint
 * (#298), only Raider.IO-logged first kills (#732). Never the last pinned tier,
 * which current raids ride along on.
 */
export function settledTierOrdinals(
  killScanFloor: string | undefined,
  tiers: readonly PinnedTier[] = raiderIoHistoricTiers,
  contentWindowEnd: (
    raidSlug: string
  ) => string | null = raiderIoRaidContentWindowEnd
): readonly number[] {
  const floor =
    killScanFloor === undefined ? Number.NaN : Date.parse(killScanFloor);
  if (Number.isNaN(floor)) return [];
  const closedBelowFloor = (slug: string) => {
    const endsAt = contentWindowEnd(slug);
    return endsAt !== null && Date.parse(endsAt) < floor;
  };
  return tiers
    .filter(
      (tier, index) =>
        index !== tiers.length - 1 && tier.raidSlugs.every(closedBelowFloor)
    )
    .map((tier) => tier.ordinal);
}

/**
 * The Raider.IO tiers still worth asking, given the character's scan floor.
 *
 * A settled tier is left out only once it is marked as read
 * (`character_raiderio_tier_reads`, current version, not expired). Until then
 * it is asked, once, for its logged first kills. Asking every settled tier on
 * every run was most of a full run's Raider.IO requests and about a quarter
 * of its median time (#298); leaving them all out for good meant a settled
 * tier's logged kills were never collected at all.
 *
 * Kept whenever that cannot be shown: no floor, a floor that cannot be read,
 * or a raid the catalogue cannot place. The last pinned tier is always kept,
 * because current raids ride along on every tier's response and one of them
 * has to be asked for this week's kills to arrive at all.
 */
export function historicTierOrdinalsFrom(
  killScanFloor: string | undefined,
  markedTierOrdinals: ReadonlySet<number>,
  tiers: readonly PinnedTier[] = raiderIoHistoricTiers,
  contentWindowEnd: (
    raidSlug: string
  ) => string | null = raiderIoRaidContentWindowEnd
): readonly number[] {
  const settled = new Set(
    settledTierOrdinals(killScanFloor, tiers, contentWindowEnd)
  );
  return tiers
    .filter(
      (tier) =>
        !settled.has(tier.ordinal) || !markedTierOrdinals.has(tier.ordinal)
    )
    .map((tier) => tier.ordinal);
}
```

In `raiderIoVerifiedKills`:

- add `markedTierOrdinals: ReadonlySet<number>;` to `options`;
- compute
  `const settled = new Set(settledTierOrdinals(options.killScanFloor));`;
- call
  `historicTierOrdinalsFrom(options.killScanFloor, options.markedTierOrdinals)`;
- on the evidence path, build the split:

```ts
  const backCatalogueTierOrdinals = tierOrdinals.filter((ordinal) =>
    settled.has(ordinal)
  );
  const backCatalogueRaids = new Set(
    raiderIoHistoricTiers
      .filter((tier) => backCatalogueTierOrdinals.includes(tier.ordinal))
      .flatMap((tier) => tier.raidSlugs)
  );
  // A back-catalogue tier is evidence only: its kills are below the floor or
  // after their raid's window, so they are no search hint, and its guilds are
  // no place for a tier search to walk.
  const searchable = result.kills.filter(
    (kill) => !backCatalogueRaids.has(kill.raidSlug)
  );
  return {
    kills: searchableKills(searchable, options),
    guilds: raiderIoGuilds(searchable),
    firstKills: result.kills,
    askedRaidSlugs: /* unchanged expression */,
    backCatalogueTierOrdinals,
    currentRaidSlugs: raiderIoHistoricTiers
      .filter(
        (tier) =>
          tierOrdinals.includes(tier.ordinal) && !settled.has(tier.ordinal)
      )
      .flatMap((tier) => tier.raidSlugs)
      .sort()
  };
```

Add the two new fields to `VerifiedKillsResult`, each with a one-line doc
comment. Update the handler's call at
`applicant-evidence-job-handler.ts:1686`, for now passing
`markedTierOrdinals: new Set(raiderIoHistoricTierOrdinals)`. That keeps
today's behaviour until Task 5 loads real marks. Import
`raiderIoHistoricTierOrdinals` from `@slashwho/raiderio`. Export
`settledTierOrdinals` and the `raiderio-tier-reads` names from
`packages/application/src/index.ts` only if `historicTierOrdinalsFrom` is
exported there. Follow the existing pattern.

- [ ] **Step 4: Run them to see them pass**

Run: `corepack pnpm vitest run --project unit packages/application/src/verified-kills.test.ts packages/application/src/raiderio-tier-reads.test.ts packages/application/src/applicant-evidence-job-handler.test.ts`
Expected: PASS, including the handler's "asks Raider.IO only for the tiers
above the scan floor" test, which is unchanged by the temporary all-marked
set.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src
git commit -m "feat(application): ask a settled Raider.IO tier until it is marked, as evidence only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: collection records presence, handles a missing id, and orders re-reads

**Files:**

- Modify: `packages/application/src/raiderio-first-kills.ts`
- Test: `packages/application/src/raiderio-first-kills.test.ts`

**Interfaces:**

- Consumes: `CharacterRaiderIoFirstKillInput.presenceChecked` (Task 1).
- Produces:
  - A `collectRaiderIoFirstKills` input
    `priorityRaidSlugs?: ReadonlySet<string>`, the raids whose due re-reads go
    first.
  - Output kills carry `presenceChecked: boolean`.
  - `rebuildSettledFirstKills(published: readonly CharacterRaiderIoFirstKillInput[], askedRaidSlugs: readonly string[]): HistoricMythicKill[]`.

- [ ] **Step 1: Write the failing tests**

In `packages/application/src/raiderio-first-kills.test.ts`, update the fixture
in "does not ask for the character's id once its presence is established"
(line 688) to include `presenceChecked: true`. Also add `presenceChecked: true`
to the expected kill in the first test (line 196), since a visible roster
with the character now publishes true. Then append:

```ts
  it("presence regression: a roster opened by a partial run is still checked next run", async () => {
    // Break caught (#734 follow-up review): `established` was inferred from
    // "published read, roster visible before this run". A partial run that
    // opened the roster stored it visible and carried the unchecked kill
    // forward, so the next run never checked it.
    const carried: CharacterRaiderIoFirstKillInput = {
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      loggedEncounterId: 700_001,
      encounterState: "read",
      encounterLimitationCode: null,
      historicWorldRank: null,
      historicRankCheckedAt: null,
      presenceChecked: false
    };
    const raiderio = gateway();

    const result = await collect([midnightFalls], raiderio, {
      published: [carried],
      // The previous run already stored the opened roster, without Alfa.
      storedEncounters: async () => ({
        encounters: [storedRead({ members: [bravo] })],
        unavailable: []
      })
    });

    expect(raiderio.getCharacter).toHaveBeenCalledTimes(1);
    expect(result.kills).toEqual([]);
  });

  it("publishes a checked kill with the flag, and a hidden-roster one without", async () => {
    const visible = await collect([midnightFalls]);
    const hidden = await collect(
      [midnightFalls],
      gateway({
        getLoggedEncounter: vi.fn(async () =>
          encounter("midnight-falls", { state: "unavailable", reason: "private" })
        )
      })
    );

    expect(visible.kills[0]).toMatchObject({ presenceChecked: true });
    expect(hidden.kills[0]).toMatchObject({
      encounterState: "read",
      presenceChecked: false
    });
  });

  it("no id: accepts the kill unchecked, without a shortfall, when the character read has no id", async () => {
    // Break caught (#734 follow-up review): a profile Raider.IO gives no id,
    // such as a tournament character, held every run partial for good.
    const raiderio = gateway({
      getCharacter: vi.fn(async () => ({
        key,
        displayName: "Alfa",
        className: "Demon Hunter",
        level: 90,
        guild: null,
        ownerId: null,
        profileGuess: null,
        declaredMain: null,
        raiderIoCharacterId: null
      }))
    });

    const result = await collect([midnightFalls], raiderio);

    expect(result.limitation).toBeNull();
    expect(result.kills).toEqual([
      expect.objectContaining({
        encounterState: "read",
        presenceChecked: false
      })
    ]);
  });

  it("queues due re-reads with current raids first, then by oldest read_at", async () => {
    const settledA = { ...kill("a", 1), raidSlug: "nerubar-palace" };
    const settledB = { ...kill("b", 2), raidSlug: "nerubar-palace" };
    const current = kill("c", 3);
    const due = (id: number, bossSlug: string, raidSlug: string, readAt: string) =>
      storedRead({ loggedEncounterId: id, bossSlug, raidSlug, readAt });
    const order: number[] = [];
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (raidSlug: string, id: number) => {
        order.push(id);
        return {
          ...encounter(["a", "b", "c"][id - 1]!),
          raidSlug
        };
      })
    });

    await collect([settledA, settledB, current], raiderio, {
      priorityRaidSlugs: new Set(["tier-mn-1"]),
      storedEncounters: async () => ({
        encounters: [
          due(1, "a", "nerubar-palace", "2026-08-10T00:00:00.000Z"),
          due(2, "b", "nerubar-palace", "2026-08-01T00:00:00.000Z"),
          due(3, "c", "tier-mn-1", "2026-08-20T00:00:00.000Z")
        ],
        unavailable: []
      })
    });

    // Concurrency 4 starts all three at once, in queue order.
    expect(order).toEqual([3, 2, 1]);
  });
});

describe("rebuildSettledFirstKills", () => {
  it("rebuilds every stored first kill in a raid the run did not ask about", () => {
    const stored = (
      raidSlug: string,
      bossSlug: string,
      loggedEncounterId: number | null
    ): CharacterRaiderIoFirstKillInput => ({
      raidSlug,
      bossSlug,
      killedAt: "2024-10-01T20:00:00.000Z",
      guild: killGuild,
      loggedEncounterId,
      encounterState: loggedEncounterId === null ? "unavailable" : "read",
      encounterLimitationCode: null,
      historicWorldRank: null,
      historicRankCheckedAt: null
    });

    expect(
      rebuildSettledFirstKills(
        [
          stored("nerubar-palace", "queen-ansurek", 700_002),
          stored("nerubar-palace", "ulgrax", null),
          stored("tier-mn-1", "midnight-falls", 700_001)
        ],
        ["tier-mn-1"]
      )
    ).toEqual([
      {
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek",
        firstDefeated: "2024-10-01T20:00:00.000Z",
        guild: killGuild,
        loggedEncounterId: 700_002
      },
      {
        raidSlug: "nerubar-palace",
        bossSlug: "ulgrax",
        firstDefeated: "2024-10-01T20:00:00.000Z",
        guild: killGuild,
        loggedEncounterId: null
      }
    ]);
  });
});
```

Add `rebuildSettledFirstKills` to the import from `./raiderio-first-kills`.

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/raiderio-first-kills.test.ts`
Expected: FAIL. The regression test publishes the kill without calling
`getCharacter`; "no id" reports `unavailable`; `rebuildSettledFirstKills` is
undefined.

- [ ] **Step 3: Implement**

In `packages/application/src/raiderio-first-kills.ts`:

1. Add `priorityRaidSlugs?: ReadonlySet<string>;` to the input type, with a doc
   comment: "Raids of tiers asked anyway; their due re-reads queue before the
   back catalogue's."
2. Order the due re-reads. Build `readAtById` from `stored.encounters` and
   `stored.unavailable`, then replace the `toRead` construction:

```ts
const readAtById = new Map<number, number>([
  ...stored.encounters.map(
    (item) => [item.loggedEncounterId, Date.parse(item.readAt)] as const
  ),
  ...stored.unavailable.map(
    (item) => [item.loggedEncounterId, Date.parse(item.readAt)] as const
  )
]);
const priority = (id: number) =>
  input.priorityRaidSlugs?.has(killById.get(id)!.raidSlug) ? 0 : 1;
// Current raids first, then the oldest answer: a back catalogue falling due
// at once must not crowd out rosters a recruiter is looking at now.
const dueIds = ids
  .filter((id) => due.has(id))
  .sort(
    (a, b) =>
      priority(a) - priority(b) ||
      readAtById.get(a)! - readAtById.get(b)! ||
      a - b
  );
const toRead = [...unread, ...dueIds].slice(
  0,
  MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN
);
```

3. Replace the `visibleBefore`/`established` block with a flag-based one:

```ts
// Presence is established only where it was checked and recorded on the
// kill itself. Inferring it from "read, and the roster was visible before
// this run" let a partial run that opened a roster carry an unchecked kill
// past its check for good.
const established = new Set(
  input.published.flatMap((kill) =>
    kill.encounterState === "read" &&
    kill.loggedEncounterId !== null &&
    kill.presenceChecked === true
      ? [kill.loggedEncounterId]
      : []
  )
);
```

4. Make `raiderIoCharacterId` distinguish "no id" from a failure:

```ts
type CharacterIdAnswer =
  | Readonly<{ kind: "id"; id: number }>
  // The read succeeded and Raider.IO gives the profile no id. That answer
  // does not change, so it is not a shortfall.
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "failed" }>;

async function raiderIoCharacterId(
  /* same input */
): Promise<CharacterIdAnswer> {
  if (!input.raiderio.getCharacter) return { kind: "failed" };
  try {
    input.onCharacterRequest?.();
    const character = await input.raiderio.getCharacter(
      input.key,
      input.signal
    );
    return character.raiderIoCharacterId == null
      ? { kind: "none" }
      : { kind: "id", id: character.raiderIoCharacterId };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { kind: "failed" };
  }
}
```

Missing `getCharacter` stays a failure, as today's `null` was.

At the call site:

```ts
const character = needsPresenceCheck ? await raiderIoCharacterId(input) : null;
if (character?.kind === "failed") fallShort({ code: "unavailable" });
```

5. In the `kills` mapping, replace the presence branch and its return:

```ts
let presenceChecked = false;
if (encounter.rosterState === "available") {
  if (established.has(id)) {
    presenceChecked = true;
  } else if (character?.kind === "id") {
    if (
      !encounter.members.some(
        (member) => member.raiderIoCharacterId === character.id
      )
    ) {
      return [];
    }
    presenceChecked = true;
  } else if (character?.kind !== "none") {
    // Where the id could not be learned the kill waits for a run that
    // can; the run is partial, so nothing stored is dropped meanwhile.
    return [];
  }
  // "none": accepted on Raider.IO's attribution, as behind a hidden
  // roster, and checked again on a later run.
}
return [
  {
    ...base,
    killedAt: encounter.defeatedAt,
    loggedEncounterId: id,
    encounterState: "read",
    encounterLimitationCode: null,
    presenceChecked
  }
];
```

Give both `unavailable` returns above it `presenceChecked: false`.

6. Add the rebuild helper after `collectRaiderIoFirstKills`:

```ts
/**
 * The character's stored first kills in raids this run's kill list did not
 * ask about, as kill-list entries, so a settled tier's rosters keep being
 * re-read without asking for its kill list (#732 follow-up). Every one is
 * rebuilt, due or not: their raids join `askedRaidSlugs`, and a complete
 * publish keeps only what the run hands it.
 */
export function rebuildSettledFirstKills(
  published: readonly CharacterRaiderIoFirstKillInput[],
  askedRaidSlugs: readonly string[]
): HistoricMythicKill[] {
  const asked = new Set(askedRaidSlugs);
  return published
    .filter((kill) => !asked.has(kill.raidSlug))
    .map((kill) => ({
      raidSlug: kill.raidSlug,
      bossSlug: kill.bossSlug,
      firstDefeated: kill.killedAt,
      guild: kill.guild ? { ...kill.guild } : null,
      loggedEncounterId: kill.loggedEncounterId
    }));
}
```

Update the doc comment of `collectRaiderIoFirstKills` where it describes
presence: "A kill counts as the character's only once a visible roster held
the character's own Raider.IO id, recorded on the kill as `presenceChecked`".

- [ ] **Step 4: Run them to see them pass**

Run: `corepack pnpm vitest run --project unit packages/application/src/raiderio-first-kills.test.ts`
Expected: PASS. If "checks presence once a hidden roster it accepted a kill
through opens" (line 716) now publishes differently, it should still expect
`[]`: the kill is unchecked and the roster lacks Alfa. Leave it unchanged.
Any other existing test that uses `toEqual` on an output kill now needs the
new `presenceChecked` field: `true` for a kill checked against a visible
roster, `false` otherwise. Add the field; don't loosen those tests to
`objectContaining`.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src
git commit -m "fix(application): record Raider.IO presence on the first kill, and rebuild settled kills

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: handler wiring (load marks, rebuild, ledger, mark)

**Files:**

- Modify: `packages/application/src/applicant-evidence-job-handler.ts`:
  - the `raiderIoVerifiedKills` call near line 1686;
  - the phase at lines 2277-2366;
  - the post-publish block at lines 2502-2521.
- Test: `packages/application/src/applicant-evidence-job-handler.test.ts`:
  - the `describe` that holds `loggedStore` and `loggedHandler`, near
    line 5697;
  - the floor test at line 3747.

**Interfaces:**

- Consumes:
  - `raiderIoTierReads?` and `markRaiderIoTierReads?` (Task 1);
  - `raiderIoTierReadSince` (Task 3);
  - `backCatalogueTierOrdinals` and `currentRaidSlugs` (Task 3);
  - `rebuildSettledFirstKills` and `priorityRaidSlugs` (Task 4).

- [ ] **Step 1: Write the failing handler tests**

Update the floor test at line 3747. Give its `evidence` a
`raiderIoTierReads = async () => raiderIoHistoricTierOrdinals.slice(0, -1)`,
so every settled tier is marked, and keep `tierOrdinals: [35]`. Add a sibling
test with no marks that expects all 17 ordinals. Its break-caught comment:
"a settled tier was never asked, so its logged kills were never collected".

In the logged-encounter `describe`, add `presenceChecked: true` to
`storedFirstKill` (line 5680), because "reads nothing already stored and asks
no id it already holds" relies on it being established. Then add a settled
setup and the tests:

```ts
// A floor above every pinned raid's close: every tier but 35 is settled.
function settledStore(marked: readonly number[] = []) {
  const evidence = loggedStore();
  evidence.stored.push({ raidId: "42", domain: "kills" });
  evidence.storedKills.push(
    {
      raidId: "42",
      raidName: "The Dreamrift",
      killedAt: "2026-06-01T00:00:00.000Z"
    },
    {
      raidId: "43",
      raidName: "The Venomous Abyss",
      killedAt: "2026-09-01T00:00:00.000Z"
    }
  );
  const marks: number[][] = [];
  evidence.raiderIoTierReads = async () => marked;
  evidence.markRaiderIoTierReads = async (_key, ordinals) => {
    marks.push([...ordinals]);
  };
  return Object.assign(evidence, { marks });
}
const queenAnsurek = {
  raidSlug: "nerubar-palace",
  bossSlug: "queen-ansurek",
  firstDefeated: "2024-10-01T20:00:00.000Z",
  guild: killGuild,
  loggedEncounterId: 700_002
};
const storedQueen: CharacterRaiderIoFirstKillInput = {
  raidSlug: "nerubar-palace",
  bossSlug: "queen-ansurek",
  killedAt: "2024-10-01T20:00:00.000Z",
  guild: killGuild,
  loggedEncounterId: 700_002,
  encounterState: "read",
  encounterLimitationCode: null,
  historicWorldRank: null,
  historicRankCheckedAt: "2026-09-01T00:00:00.000Z",
  presenceChecked: true
};

it("asks a settled tier once, publishes its logged kill, and marks it", async () => {
  const evidence = settledStore();
  const raiderio = raiderIo({
    getHistoricMythicKills: vi.fn(async () => ({
      kind: "evidence" as const,
      kills: [midnightFalls, queenAnsurek]
    })),
    getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
      id === 700_002
        ? {
            ...encounter,
            raidSlug: "nerubar-palace",
            bossSlug: "queen-ansurek"
          }
        : encounter
    )
  });

  await loggedHandler(evidence, raiderio).execute(run.id);

  expect(raiderio.getHistoricMythicKills).toHaveBeenCalledWith(
    key,
    expect.objectContaining({
      tierOrdinals: raiderIoHistoricTierOrdinals
    })
  );
  const published = evidence.published[0]!.result;
  expect(published.state).toBe("complete");
  expect(published.raiderIoFirstKills?.kills).toContainEqual(
    expect.objectContaining({
      bossSlug: "queen-ansurek",
      encounterState: "read"
    })
  );
  expect(evidence.marks).toEqual([raiderIoHistoricTierOrdinals.slice(0, -1)]);
});

it("keeps every rebuilt kill, due or not, logged or not, and re-reads a due roster without the kill list", async () => {
  // Break caught (#734 follow-up review): rebuilding only the due kills
  // while their raids joined askedRaidSlugs deleted the rest on a complete
  // publish, the failure that cost 9 characters on 2026-09-23.
  const evidence = settledStore(raiderIoHistoricTierOrdinals.slice(0, -1));
  const noLog: CharacterRaiderIoFirstKillInput = {
    ...storedQueen,
    bossSlug: "ulgrax",
    loggedEncounterId: null,
    encounterState: "unavailable",
    presenceChecked: false
  };
  const dueRoster: CharacterRaiderIoFirstKillInput = {
    ...storedQueen,
    bossSlug: "the-bloodbound-horror",
    loggedEncounterId: 700_003
  };
  evidence.storedRaiderIoFirstKills = async () => [
    storedQueen,
    noLog,
    dueRoster
  ];
  const storedEncounter = (id: number, bossSlug: string, readAt: string) => ({
    loggedEncounterId: id,
    raidSlug: "nerubar-palace",
    bossSlug,
    pulledAt: encounter.pulledAt,
    defeatedAt: "2024-10-01T20:00:00.000Z",
    durationMs: encounter.durationMs,
    guild: encounter.guild,
    itemLevel: encounter.itemLevel,
    deathCount: 2,
    vantusCount: 16,
    shareRaidUntil: null,
    rosterState: "available" as const,
    members: encounter.roster.members,
    readAt
  });
  evidence.raiderIoLoggedEncounters = async () => ({
    encounters: [
      // Read last week: not due.
      storedEncounter(700_002, "queen-ansurek", "2026-09-21T00:00:00.000Z"),
      // Read 40 days ago with no end named: due.
      storedEncounter(
        700_003,
        "the-bloodbound-horror",
        "2026-08-19T00:00:00.000Z"
      )
    ],
    unavailable: []
  });
  const raiderio = raiderIo({
    getLoggedEncounter: vi.fn(async () => ({
      ...encounter,
      raidSlug: "nerubar-palace",
      bossSlug: "the-bloodbound-horror",
      roster: { state: "unavailable" as const, reason: "private" as const }
    }))
  });

  await loggedHandler(evidence, raiderio).execute(run.id);

  expect(raiderio.getHistoricMythicKills).toHaveBeenCalledWith(
    key,
    expect.objectContaining({ tierOrdinals: [35] })
  );
  expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(1);
  expect(evidence.saved[0]!.encounters).toEqual([
    expect.objectContaining({
      loggedEncounterId: 700_003,
      rosterState: "private"
    })
  ]);
  const published = evidence.published[0]!.result;
  expect(published.state).toBe("complete");
  const kept = mergeRaiderIoFirstKills(
    [storedQueen, noLog, dueRoster],
    published.raiderIoFirstKills,
    published.state,
    false
  ).map((kill) => kill.bossSlug);
  expect(kept).toEqual(
    expect.arrayContaining(["queen-ansurek", "ulgrax", "the-bloodbound-horror"])
  );
  expect(evidence.transitions).toContainEqual({
    id: "raiderio_logged_encounters",
    state: "completed"
  });
});

it("drops a stored settled kill the kill list no longer returns, on a complete re-ask", async () => {
  // Marks expired (none current): the tier is asked again and has
  // withdrawn the kill.
  const evidence = settledStore();
  evidence.storedRaiderIoFirstKills = async () => [storedQueen];
  const raiderio = raiderIo();

  await loggedHandler(evidence, raiderio).execute(run.id);

  const published = evidence.published[0]!.result;
  expect(published.state).toBe("complete");
  expect(published.raiderIoFirstKills?.askedRaidSlugs).toContain(
    "nerubar-palace"
  );
  expect(
    mergeRaiderIoFirstKills(
      [storedQueen],
      published.raiderIoFirstKills,
      published.state,
      false
    ).map((kill) => kill.bossSlug)
  ).not.toContain("queen-ansurek");
});

it.each([
  [
    "the phase is capped",
    (evidence: ReturnType<typeof settledStore>) => evidence,
    () =>
      raiderIo({
        getHistoricMythicKills: vi.fn(async () => ({
          kind: "evidence" as const,
          kills: Array.from({ length: 51 }, (_, index) => ({
            ...midnightFalls,
            bossSlug: `boss-${String(index + 1)}`,
            loggedEncounterId: index + 1
          }))
        })),
        getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) => ({
          ...encounter,
          bossSlug: `boss-${String(id)}`,
          roster: { state: "unavailable" as const, reason: "private" as const }
        }))
      })
  ],
  [
    "the kill list fails",
    (evidence: ReturnType<typeof settledStore>) => evidence,
    () =>
      raiderIo({
        getHistoricMythicKills: vi.fn(async () => ({
          kind: "limitation" as const,
          code: "unavailable" as const
        }))
      })
  ],
  [
    "the stored first kills cannot be read",
    (evidence: ReturnType<typeof settledStore>) => {
      evidence.storedRaiderIoFirstKills = async () => {
        throw new Error("database_down");
      };
      return evidence;
    },
    () => raiderIo()
  ],
  [
    "the phase never runs",
    (evidence: ReturnType<typeof settledStore>) => evidence,
    () => {
      const raiderio = raiderIo();
      return { ...raiderio, getLoggedEncounter: undefined } as never;
    }
  ]
] as const)("marks nothing when %s", async (_name, prepare, gatewayFor) => {
  const evidence = prepare(settledStore());
  const raiderio = gatewayFor();

  await loggedHandler(evidence, raiderio).execute(run.id);

  expect(evidence.marks).toEqual([]);
  expect(evidence.published[0]!.result).not.toHaveProperty("retryAfterAt");
});

it("marks nothing when the publish is partial for Warcraft Logs reasons", async () => {
  const evidence = settledStore();
  const handler = handlerFor({
    evidence,
    warcraftLogs: {
      getFirstKillReports: vi.fn(async () => ({
        ...noKills,
        limitation: { code: "request_cap" }
      })),
      ...openGate
    },
    raiderio: raiderIo(),
    pointsReserve: 0,
    now: () => new Date("2026-09-28T12:00:00.000Z")
  });

  await handler.execute(run.id);

  expect(evidence.published[0]!.result.state).toBe("partial");
  expect(evidence.marks).toEqual([]);
});

it("marks nothing when the publish fails, and a failed mark write does not fail the run", async () => {
  const failing = settledStore();
  failing.publish = async () => {
    throw new Error("publish_failed");
  };
  await loggedHandler(failing, raiderIo()).execute(run.id);
  expect(failing.marks).toEqual([]);

  const throwing = settledStore();
  throwing.markRaiderIoTierReads = async () => {
    throw new Error("mark_failed");
  };
  await loggedHandler(throwing, raiderIo()).execute(run.id);
  expect(throwing.published[0]!.result.state).toBe("complete");
});

it("no id: completes the run and marks its tiers when Raider.IO gives the profile no id", async () => {
  const evidence = settledStore();
  const raiderio = raiderIo({
    getCharacter: vi.fn(async () => ({
      key,
      displayName: "Alfa",
      className: "Demon Hunter",
      level: 90,
      guild: null,
      ownerId: null,
      profileGuess: null,
      declaredMain: null,
      raiderIoCharacterId: null
    }))
  });

  await loggedHandler(evidence, raiderio).execute(run.id);

  expect(evidence.published[0]!.result.state).toBe("complete");
  expect(evidence.marks).toHaveLength(1);
});

it("records the phase as run when its only logged kills are rebuilt", async () => {
  const evidence = settledStore(raiderIoHistoricTierOrdinals.slice(0, -1));
  evidence.storedRaiderIoFirstKills = async () => [storedQueen];
  const raiderio = raiderIo({
    getHistoricMythicKills: vi.fn(async () => ({
      kind: "evidence" as const,
      kills: []
    }))
  });

  await loggedHandler(evidence, raiderio).execute(run.id);

  expect(evidence.transitions).toContainEqual({
    id: "raiderio_logged_encounters",
    state: "completed"
  });
});

it("records the phase as limited when the stored first kills cannot be read", async () => {
  const evidence = settledStore();
  evidence.storedRaiderIoFirstKills = async () => {
    throw new Error("database_down");
  };

  await loggedHandler(evidence, raiderIo()).execute(run.id);

  expect(evidence.published[0]!.result.state).toBe("partial");
  expect(evidence.transitions).toContainEqual({
    id: "raiderio_logged_encounters",
    state: "limited"
  });
  expect(evidence.transitions).not.toContainEqual({
    id: "raiderio_logged_encounters",
    state: "skipped"
  });
});
```

Import `raiderIoHistoricTierOrdinals` from `@slashwho/raiderio` and
`CharacterRaiderIoFirstKillInput` from `@slashwho/database` if they aren't
imported yet. Check how the `store()` fake exposes `stored`, `storedKills`,
`published` and `publish`, and adjust names to the fake's real ones. The
floor test at line 3747 uses `stored` and `storedKills`. If the fake records
a failed publish elsewhere, point the failed-publish assertion there. A
targeted run marks nothing because the phase never runs, so `if (targeted)
return;` covers it; if the file already has a targeted-run helper, add a
targeted case to the `it.each` with it.

- [ ] **Step 2: Run them to see them fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts -t "settled|marks nothing|no id|rebuilt|stored first kills|scan floor"`
Expected: FAIL. No mark is written, settled tiers are not asked (Task 3's
temporary all-marked set), and nothing is rebuilt.

- [ ] **Step 3: Implement the wiring**

At the `raiderIoVerifiedKills` call (near line 1686), load the marks just
before `verified` and replace Task 3's temporary set:

```ts
// Settled Raider.IO tiers already read (#732 follow-up). A failure to
// read them costs a few Raider.IO requests, never a kill.
const markedTierOrdinals = new Set(
  historicKills
    ? await (
        evidence.raiderIoTierReads?.(
          run.key,
          raiderIoTierReadSince(run.key, now())
        ) ?? Promise.resolve([])
      ).catch(() => [])
    : []
);
```

Pass `markedTierOrdinals` in the options object.

Rewrite the phase block (lines 2277-2366) as follows. It keeps the existing
`collectRaiderIoFirstKills` and `rankRaiderIoFirstKills` arguments unchanged
except where shown.

```ts
let raiderIoFirstKills: RaiderIoFirstKillsPublication | undefined;
let raiderIoShortfall: RaiderIoFirstKillLimitation | null = null;
// True only when the phase ran and returned: the one case that may
// vouch for a settled tier.
let raiderIoPhaseRan = false;
const raiderIoLogs = options.raiderio;
const getLoggedEncounter = raiderIoLogs?.getLoggedEncounter;
if (!targeted && raiderIoLogs && getLoggedEncounter && verified?.firstKills) {
  const askedRaidSlugs = verified.askedRaidSlugs ?? [];
  // Loaded before the ledger decides active or skipped: a settled
  // tier's kills are rebuilt from it, and they may be the only logged
  // kills this run has.
  let published: readonly CharacterRaiderIoFirstKillInput[] | null;
  try {
    published = (await evidence.storedRaiderIoFirstKills?.(run.key)) ?? [];
  } catch (error) {
    if (activeContext.signal.aborted) throw error;
    published = null;
  }
  const rebuilt =
    published === null
      ? []
      : rebuildSettledFirstKills(published, askedRaidSlugs);
  const firstKills = [...verified.firstKills, ...rebuilt];
  const logged =
    published === null ||
    firstKills.some((kill) => kill.loggedEncounterId != null);
  await phaseLedger?.transition(
    "raiderio_logged_encounters",
    logged ? "active" : "skipped"
  );
  try {
    if (published === null) throw new Error("stored_first_kills_unread");
    const storedFirstKills = published;
    const collected = await scope.time("raiderIoLoggedEncounters", () =>
      collectRaiderIoFirstKills({
        key: run.key,
        kills: firstKills,
        published: storedFirstKills,
        priorityRaidSlugs: new Set(verified.currentRaidSlugs ?? [])
        /* storedEncounters, saveAnswers, raiderio, signal, now,
                   onEncounterRequest, onCharacterRequest: unchanged */
      })
    );
    const ranked = await rankRaiderIoFirstKills({
      /* unchanged, with published: storedFirstKills */
    });
    raiderIoShortfall = collected.limitation;
    raiderIoFirstKills = {
      kills: ranked,
      askedRaidSlugs: [
        ...new Set([...askedRaidSlugs, ...rebuilt.map((kill) => kill.raidSlug)])
      ].sort(),
      limitationCode: collected.limitation?.code ?? null
    };
    raiderIoPhaseRan = true;
  } catch (error) {
    if (activeContext.signal.aborted) throw error;
    // Nothing read here can be trusted to be whole: publish no first
    // kill of this run's own, and hold the run partial so storage
    // carries every stored one forward.
    raiderIoShortfall = { code: "unavailable" };
    raiderIoFirstKills = {
      kills: [],
      askedRaidSlugs: [],
      limitationCode: "unavailable"
    };
  }
  if (logged) {
    await phaseLedger?.transition(
      "raiderio_logged_encounters",
      raiderIoShortfall ? "limited" : "completed",
      raiderIoShortfall?.code
    );
  }
}
```

In the post-publish block, between `if (targeted) return;` and the
`terminalTiersFrom` call, add:

```ts
// A settled Raider.IO tier is marked read only once a complete publish
// holds everything its kill list named: a partial one carries stale
// rows forward, and a short phase left logged kills unanswered. A
// lost mark only asks the tier again.
const backCatalogue = verified?.backCatalogueTierOrdinals ?? [];
if (
  !incomplete &&
  raiderIoPhaseRan &&
  raiderIoShortfall === null &&
  backCatalogue.length > 0
) {
  await evidence
    .markRaiderIoTierReads?.(run.key, backCatalogue, now())
    .catch(() => undefined);
}
```

Import `rebuildSettledFirstKills` from `./raiderio-first-kills`,
`raiderIoTierReadSince` from `./raiderio-tier-reads`, and
`CharacterRaiderIoFirstKillInput` from `@slashwho/database` if needed. Remove
the `raiderIoHistoricTierOrdinals` import Task 3 added, if nothing else uses
it.

- [ ] **Step 4: Run the handler tests and see them pass**

Run: `corepack pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`
Expected: PASS, whole file. An existing logged-encounter test that asserts
exact `askedRaidSlugs` or exact kills may need the rebuilt raids or the
`presenceChecked` field. Adjust only those expectations, and note each one in
the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src
git commit -m "feat(application): read settled Raider.IO tiers once and keep re-reading their rosters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: documentation and the full gate

**Files:**

- Modify: `docs/dossier-evidence-semantics.md` (the "Raider.IO-logged first
  kills" section, after the paragraph about re-reads, near line 66)

- [ ] **Step 1: Add the paragraph**

After the paragraph ending "A kill already accepted stays accepted when its
roster becomes hidden.", insert:

```markdown
A tier whose raids all closed before the character's kill-scan floor is
asked once per character, and again only once that read is about 90 days old
(each character's expiry is offset by up to two weeks so they don't fall due
together), or once a collection fix bumps its version. The ask costs one
Raider.IO request and no Warcraft Logs points: its kills are evidence only,
never a place to search. Between asks, the character's stored first kills in
such a tier are re-read from what was stored, under the same rules as above,
without asking for the kill list. Whether a kill's presence was checked is
recorded on the kill itself, so a kill accepted behind a hidden roster is
checked once the roster opens, however many runs that takes, and a partial
run cannot carry it past the check. A tier is marked as read only by a
complete run whose logged-encounter reads fell short of nothing.
```

- [ ] **Step 2: Run the full gate**

Run each in turn:

- `corepack pnpm format:check`, then, if it fails,
  `corepack pnpm format` and re-check;
- `corepack pnpm lint`;
- `corepack pnpm typecheck`;
- `corepack pnpm test:unit`;
- `corepack pnpm test:integration`.

Expected: all pass. If `format:check` or `lint` is not a script name, read
`package.json` `scripts` and use the ones CI runs (`checks (format:check)`,
`checks (lint)`, `checks (typecheck)`).

Check the changed files for cp1252 bytes (all must be UTF-8):

```bash
git diff --name-only origin/main | xargs -I{} sh -c 'iconv -f utf-8 -t utf-8 "{}" >/dev/null || echo "bad: {}"'
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/dossier-evidence-semantics.md
git commit -m "docs: settled Raider.IO tiers are read once and their rosters re-read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Open the pull request**

```bash
git push
gh pr create --repo Erilla/SlashWho --base main --head fix/raiderio-logged-kills-back-catalogue --title "fix: collect Raider.IO-logged first kills in settled tiers" --body-file <scratchpad>/pr-body.md
```

The body links #732 and #734, summarises the spec's three gaps and the fix,
lists the migration number (and the #738 renumber note), and ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```
