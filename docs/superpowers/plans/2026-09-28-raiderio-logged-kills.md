# Raider.IO-logged first kills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Raider.IO Mythic first kill that has a Raider.IO logged encounter into dossier evidence, with the encounter's kill guild and roster, and give Warcraft Logs kills that match one the same roster.

**Architecture:** The Raider.IO client keeps `loggedEncounterId` from `raid-progress` and gains `getLoggedEncounter`. A new `raiderio_logged_encounters` evidence phase reads each first kill's encounter (50 reads a run, 4 at a time) and stores the answer in a shared table: a kill with a visible roster is kept as first read, a hidden roster is read again after 7 days, and a permanent refusal (`not_found`, `private`, `schema_drift`) is stored as an unavailable row and asked again after 30 days. Each run publishes `character_raiderio_first_kills` rows in the same transaction as its other evidence. The dossier read leaves suppressed raiders off a roster, the domain merges the rows into kill events (2-hour match to Warcraft Logs kills), the contract carries an optional `roster` on each first kill, and the web kill card shows "No public logs found" and a lazy "View roster" disclosure.

**Tech Stack:** TypeScript, zod 4, PostgreSQL through `pg` with hand-written drizzle migrations, vitest (unit and Testcontainers integration projects), React with Testing Library, pnpm workspaces through Corepack.

**Spec:** `docs/superpowers/specs/2026-09-28-raiderio-logged-kills-design.md` (issue #732). Read it before starting any task.

## Global Constraints

- Always run pnpm as `corepack pnpm <script>`. A bare `pnpm` is not on `PATH`, and piping it hides the failure.
- UK English in comments, copy and docs.
- Never parse or store `killDetails.log.sources` (uploader account names can be BattleTags or Discord handles). Never store a raw Raider.IO response or a raw request URL.
- Only these logged-encounter fields are kept: `kill` (`pulledAt`, `defeatedAt`, `durationMs`, `isSuccess`, item-level average/min/max), `boss.slug`, `raid.slug`, `raid.difficulty`, `guild` (name, realm slug, region slug) or `null`, `guildPrivacy.raidComps`, `log.deaths.count`, `log.vantus.count`, and per roster entry `character.id`, `name`, `realm.slug`, `region.slug`, `class.name`, `spec.name`, `spec.role`, `itemLevelEquipped`.
- Raider.IO first kills only. Never read later kills, Heroic or Normal.
- At most 50 logged-encounter reads per run (`request_cap` beyond that), 4 at a time; a thrown read abandons the queue and marks the phase `limited`. Re-reads count against the same 50 and queue behind first reads.
- No worker-wide Raider.IO limiter is added. The per-run bounds stand: 50 encounter reads, 50 rank requests and at most one `getCharacter`; a 429 limits the phase.
- What is stored and when it is read again: a read with a visible roster is never read again; a read whose roster was private is read again once its `read_at` is more than 7 days old; a permanent answer (`not_found`, a 403 `private`, `schema_drift`) is an unavailable row with its code and `read_at`, read again once more than 30 days old. A stored read is never replaced by an unavailable answer.
- A `request_cap` from this phase never schedules a `capRetryMs` re-run. The backlog drains through ordinary runs, 50 at a time.
- A roster member under an active `suppressed_characters` row is left off the roster every dossier read shows. The rows stay stored; the player and role counts stay Raider.IO's.
- Matching tolerance is `STORED_KILL_MATCH_MS` (2 hours), the constant that already exists in `packages/application/src/verified-kills.ts:21`. The match rule and the "empty roster is private" rule are each written once, in `@slashwho/domain`, and imported everywhere else.
- Migration number `0066`; renumber (file, journal `idx`, `when`, and `tests/integration/migrations.test.ts`) if another lands first.
- A Raider.IO first kill never replaces or removes a Warcraft Logs kill. A partial or targeted publish carries every stored Raider.IO first kill forward; a limited `raiderio_logged_encounters` phase makes the run partial.
- Tests and fixtures use synthetic identities only: characters `Alfa`, `Bravo`, `Charlie`; guild `Fixture Guild Alfa`; Raider.IO character ids `424_242`/`424_243`; logged-encounter ids `700_001`-`700_003`. The owner's own characters (`Ryii`) may appear as elsewhere in the suite.
- "No public logs found" is display text for an empty list, never numeric zero. An unavailable roster is its own state, never "not present". A pug kill shows "—".
- Assembled dossier responses stay `Cache-Control: no-store` (nothing here touches the route).
- No live Raider.IO or Warcraft Logs traffic in any test. Fixtures are sanitised and small.

## Review Focus

- A Raider.IO kill list that fails (private profile, 429) on a character that already has stored Raider.IO first kills: the kills must survive the run unchanged, not vanish from a complete publish. Pinned in Task 5 ("carries stored first kills forward when Raider.IO cannot answer").
- A logged encounter whose `roster` is an empty array while `raidComps` is `true`: the panel must say "Roster unavailable", never render an empty table. Pinned in Task 2 ("treats an empty roster as unavailable, never as nobody").
- A roster member with no `itemLevelEquipped`: shown as "—", never `0`. Pinned in Task 2 (parser keeps `null`) and Task 7 (table shows "—").
- A logged encounter answering 404 forever (a deleted log): the run must not stay `partial`, and later runs must not ask again. The permanent answer is stored as an unavailable row and asked again only after 30 days. Pinned in Task 5 ("does not hold the run partial for a permanent answer" and "asks once about a deleted log across two runs").
- A character with more than 50 unread logged encounters (the rollout backlog): the run is `partial` with `request_cap`, but no cap retry is scheduled; the next ordinary run reads the next 50. Pinned in Task 5 ("drains a capped backlog on ordinary runs, never on a cap retry").
- A raider on the roster who has since been removed (`suppressed_characters`): never shown on anyone's dossier, while the counts stay Raider.IO's. Pinned in Task 4 ("leaves a suppressed raider off the roster a dossier reads, and still counts them") and Task 6 ("counts every raider Raider.IO listed, shown or not").
- A roster first read as private: read again once its `read_at` is more than 7 days old; a visible roster is never read again. Pinned in Task 5 ("reads a hidden roster again after a week, and a visible one never").
- A run whose Warcraft Logs kill scan was skipped and whose Raider.IO phase also fell short: it must stay Warcraft Logs-incomplete, so no "No qualifying public logs found" rests on a scan that never ran. Pinned in Task 6 ("keeps a skipped-scan run incomplete even when Raider.IO also fell short").
- A Raider.IO kill 2 h 1 min from the Warcraft Logs kill of the same boss on the same UTC date: it is not a match, but the dossier's existing same-region, same-date grouping still shows one event for the night, dated by the earlier kill, with the Warcraft Logs reports and parses and the Raider.IO roster. Pinned in Task 6 ("keeps a kill just outside the tolerance in the same-date event, dated by the earlier").
- Grong: Raider.IO ranks both faction versions as one boss (`grong`). A Raider.IO Grong kill must be placed, and must match either version's Warcraft Logs kill. Pinned in Task 3 ("shows Raider.IO's one Grong under the Grong the Journal lists first" and "matches Raider.IO's Grong to either faction's Warcraft Logs kill").

## Decisions this plan makes that the spec did not settle

1. **Where the character's Raider.IO id comes from.** Nothing in a run knows it: `RaiderIoCharacter` (`packages/raiderio/src/types.ts:3-20`) has no id and `normalize.ts` drops `characterDetails.character.id`. The client now keeps it as `raiderIoCharacterId`, and the phase makes one `getCharacter` read, only when some encounter with a visible roster has not yet been accepted for this character. Steady-state runs still make no request.
2. **Presence can fail.** A kill whose roster is visible but does not hold the character's id is not published. If the id cannot be learned, those kills are withheld this run and the phase is `limited` (so the run is partial and nothing stored is dropped).
3. **Which answers limit the phase.** Only retryable ones (`request_cap`, `rate_limited`, `unavailable`). `not_found`, a 403 `private` and `schema_drift` are permanent: the answer is stored in `raiderio_logged_encounters` as an unavailable row (`unavailable_code`, `read_at`), the kill is published unavailable with the code, and the run is not made partial. The row stops the id being read again for 30 days, so permanent answers never fill the cap on later runs.
4. **A logged encounter that is not a successful Mythic kill, or names another boss,** is `schema_drift`, a permanent answer.
5. **Empty roster.** A roster that is missing _or empty_ is `private`, so no empty table is ever drawn. The rule is `isRosterShown` in `packages/domain/src/logged-encounter.ts`, written once: the client applies it to each response, and the dossier applies it again only to the roster left once suppressed raiders are taken off.
6. **Complete-publish carry-forward.** The spec says "plus kills in terminal tiers", but terminal tiers are keyed by Warcraft Logs zone id (`character_terminal_tiers.raid_id`) and a Raider.IO first kill carries only Raider.IO slugs. The implementable equivalent is used: a complete publish keeps what the run found again plus every stored first kill in a Raider.IO raid the run did not ask about (tiers left out by `historicTierOrdinalsFrom`, which are exactly those closed below the terminal floor). A run that did not read the kill list at all publishes no Raider.IO section, and storage carries everything forward.
7. **The run-level reason for a Raider.IO-only partial.** `character_evidence_runs_completion_limitations_check` (`packages/database/src/schema.ts:956-964`) and the publish guard (`packages/database/src/evidence/repository.ts:734-757`) reject a partial with no reason. A new `raiderio_limitation_code` column is the fourth reason. The dossier treats a Raider.IO-only partial as Warcraft Logs-complete only when the run's kill scan ran: `kill_scan_skipped` is now loaded onto the run (`killScanSkipped`), and a skipped-scan partial stays incomplete whatever else it names. That also closes the same gap in the existing parse-budget branch.
8. **Guild for an unread encounter.** `character_raiderio_first_kills` also keeps Raider.IO's own `raid-progress` guild attribution (nullable). It is used for display only, while the encounter has not been read; it is never used for a world rank.
9. **Rank lookups** run inside the new phase with their own 50-request bound and 4-way pool, and never limit the phase. Only a kill whose logged encounter was read is ranked, because only it can stand as a kill event of its own; a kill with no logged encounter, or one not yet read, costs no rank request. A rank once checked is kept with its `historic_rank_checked_at`, a null rank included, so a checked kill is never asked about again.
10. **Where the later-kill rank rule is pinned.** The domain only carries a stored rank; the rank is computed at collection time, so the test lives in the application (Task 5), not the domain. It uses a synthetic guild with the problem's dates (a guild's first kill on 8 Apr ranked #3, a 20 Jul kill with the same guild unranked).
11. **Character key on `character_raiderio_first_kills`.** Like `character_mythic_kills`, the row is keyed by `evidence_run_id`; the character is the run's.
12. **Recorded fixtures.** The recorded-payload gate (`scripts/recorded-payloads.mts`) has no `raid-progress` or logged-encounter endpoint, no ISO-timestamp kind and no id kind, and it refuses any path off its allow-list, so a recording cannot hold `log.sources`. Task 1 adds both endpoints and two leaf kinds; the "sources is dropped" test injects `log.sources` into the fixture body at test time.
13. **Re-read intervals.** `RAIDER_IO_PRIVATE_ROSTER_REREAD_MS` (7 days) and `RAIDER_IO_UNAVAILABLE_ENCOUNTER_REREAD_MS` (30 days) live in the application. Re-reads queue behind first reads. A re-read the cap leaves out keeps its stored answer and does not limit the phase, since nothing is missing. A re-read that answers permanently leaves a stored private read as it is and only refreshes its `read_at`: a stored read is never unread. Storage enforces the same thing, since an available row is never overwritten and an unavailable answer never overwrites a read.
14. **Suppression filtering.** `raiderio_logged_encounter_members` gains `normalized_name`, written from `name` as every character key is normalised. Roster members' realm slugs are folded to the Blizzard form (lower case, accents dropped) by the client, as `parseCharacterPath` (`packages/domain/src/character-key.ts`) folds them, so a member's key is spelled as a suppression's is. The kill guild's realm is only lower-cased, because it goes back to Raider.IO in a rank request. The dossier's load (`loadPublishedRaiderIoFirstKills`) then leaves out members under an active suppression with the same `NOT EXISTS` that `packages/database/src/snapshots.ts:74-81` uses, and adds `roleCounts` over every stored member. The phase's own read (`raiderIoLoggedEncounters`) stays unfiltered, because the presence check needs the whole roster and never shows it. The rows are kept on removal (user decision, 2026-09-28).
15. **No cap retry.** `retryAfterMs` ignores a Raider.IO `request_cap`, so the rollout backlog never turns into full evidence runs that spend Warcraft Logs points to read Raider.IO. `rate_limited` and `unavailable` still schedule their ordinary retry.
16. **Run cost.** `character_evidence_run_costs` gains `raiderio_logged_encounter_requests` in the same migration, fed by the `raiderIoLoggedEncounterRequests` counter. The one `getCharacter` read is a Raider.IO character read, so it is counted under the existing `raiderIoHistoricRequests` counter, never under the encounter counter.
17. **Grong.** Raider.IO's slug overrides map several Journal encounters to one Raider.IO boss (`2325` and `2340` both to `grong`). The reverse lookup returns the first the Journal lists (`2325`) when every match is in the same raid and carries that override. The match rule compares Raider.IO slugs, so a Raider.IO Grong kill matches either faction's Warcraft Logs kill.
18. **Withheld Raider.IO kills.** An out-of-window Raider.IO kill is withheld under source `raiderio`. When it matches a Warcraft Logs kill that was itself withheld, it is not tallied again: one kill, counted once.
19. **One limitation mapper.** `historicKillLimitation`, `bossRankingLimitation` and the new logged-encounter case collapse into one `raiderIoLimitation` in `packages/raiderio/src/client.ts`.

---

## File structure

**Recording gate and fixtures (Task 1)**

- Modify `scripts/recorded-payloads.mts` — two endpoints, `iso-timestamp` and `opaque-id` leaf kinds, specialisation names, `characterDetails.character.id`.
- Modify `scripts/recorded-payloads.test.mts` — kind tests, hand-built registration.
- Create `tests/fixtures/recorded/raiderio/raid-progress-logged-first-kill.json`, `logged-encounter-guild-kill.json`, `logged-encounter-no-guild.json`.
- Create `tests/fixtures/raiderio/logged-encounter-private-roster.json` (hand-built).
- Modify `tests/fixtures/recorded/README.md`.

**Raider.IO client (Task 2)**

- Modify `packages/raiderio/src/types.ts`, `client.ts`, `normalize.ts`, `index.ts`, `client.test.ts`.
- Create `packages/domain/src/logged-encounter.ts` (`isRosterShown`) and `logged-encounter.test.ts`; modify `packages/domain/src/index.ts`.

**Domain catalogue (Task 3)**

- Create `packages/domain/src/kill-matching.ts` — `STORED_KILL_MATCH_MS` and `matchesRaiderIoKill`, the one match rule — and `kill-matching.test.ts`.
- Modify `packages/domain/src/raid-catalogue.ts` — `lookupRaidEncounterByRaiderIoSlugs`, which places Grong.
- Modify `packages/domain/src/index.ts`, `packages/domain/src/raid-catalogue.test.ts`, `packages/application/src/verified-kills.ts`.

**Database (Task 4)**

- Create `packages/database/drizzle/0066_raiderio_logged_kills.sql`.
- Modify `packages/database/drizzle/meta/_journal.json`, `packages/database/src/schema.ts`, `repositories.ts`, `mappers.ts`, `index.ts`.
- Create `packages/database/src/evidence/raiderio-first-kills.ts` — load/save SQL for the three tables.
- Modify `packages/database/src/evidence/merge.ts`, `merge.test.ts`, `load.ts`, `repository.ts` (publish guard, first-kill insert, run-cost column).
- Create `tests/integration/repositories-raiderio-first-kills.test.ts`, including suppression, re-read storage and run-cost tests.
- Modify `tests/integration/migrations.test.ts`, `tests/integration/repository-fixtures.ts`.

**Application phase (Task 5)**

- Create `packages/application/src/raiderio-first-kills.ts` and `raiderio-first-kills.test.ts`.
- Modify `packages/application/src/verified-kills.ts`, `evidence-phase-ledger.ts`, `evidence-publication.ts`, `applicant-evidence-job-handler.ts`, `applicant-evidence-job-handler.test.ts`, `resume-waiting-evidence.test.ts`, `applicant-dossier-service.test.ts`.
- Modify `packages/contracts/src/dossier.ts` (phase id), `apps/web/src/components/collection-progress.tsx` (label).

**Domain, contract and dossier service (Task 6)**

- Modify `packages/domain/src/applicant-dossier.ts`, `applicant-dossier.test.ts`, `index.ts`.
- Modify `packages/contracts/src/dossier.ts`, `index.ts`, `contracts.test.ts`.
- Create `packages/application/src/raiderio-first-kill-evidence.ts` and its test.
- Modify `packages/application/src/applicant-dossier-service.ts`, `applicant-dossier-service.test.ts`.

**Web (Task 7)**

- Create `apps/web/src/components/dossier-kill-roster.tsx` and `dossier-kill-roster.test.tsx`.
- Modify `apps/web/src/components/dossier-raid-list.tsx`, `dossier-raid-list.test.tsx`, `dossier-parse-list.tsx`, `dossier-character-name.tsx`, `dossier-view.test.tsx`, `apps/web/src/app/globals.css`.

**Docs (Task 8)**

- Modify `docs/dossier-evidence-semantics.md`.

Tasks run in order: each consumes names the previous ones produce.

---

### Task 1: Recording gate and sanitised fixtures for `raid-progress` and logged encounters

The committed-recording gate (`scripts/recorded-payloads.test.mts`, part of `test:unit`) refuses any file under `tests/fixtures/recorded/` whose endpoint, paths or values its allow-list does not name. It has no `raid-progress` or logged-encounter endpoint, keeps timestamps only as epoch numbers, and has no kind for an upstream id. This task teaches it both endpoints and two kinds, then commits the fixtures the later tasks read.

**Files:**

- Modify: `scripts/recorded-payloads.mts` (types at lines 16-40, `raiderio.character` policy at 212-246, `PlaceholderBook` at 406, `recordLeaf` at 451, `verifyLeaf` at 589)
- Modify: `scripts/recorded-payloads.test.mts` (the `recordPayload` "drops every field" test at 243, `handBuiltFixtures` at 447-595)
- Create: `tests/fixtures/recorded/raiderio/raid-progress-logged-first-kill.json`
- Create: `tests/fixtures/recorded/raiderio/logged-encounter-guild-kill.json`
- Create: `tests/fixtures/recorded/raiderio/logged-encounter-no-guild.json`
- Create: `tests/fixtures/raiderio/logged-encounter-private-roster.json`
- Modify: `tests/fixtures/recorded/README.md`

**Interfaces:**

- Consumes: nothing.
- Produces: `Endpoint` gains `"raiderio.raid-progress"` and `"raiderio.logged-encounter"`; `LeafKind` gains `{ kind: "iso-timestamp" }` and `{ kind: "opaque-id" }`; `export const maximumOpaqueId = 999`; `export const specialisationNames`; `PlaceholderBook#opaqueId(value: number, path: string): number`. Fixture files at the paths above, which Task 2 loads.

- [ ] **Step 1: Write the failing tests**

In `scripts/recorded-payloads.test.mts`, change the expected body of `"drops every field the allow-list does not name"` so the character keeps a synthetic id (the parser now reads it, Task 2):

```ts
expect(recording.body).toEqual({
  characterDetails: {
    character: {
      id: 1,
      name: "Alfa",
      level: 90,
      class: { name: "Mage" },
      realm: { slug: "silvermoon" },
      region: { slug: "eu" }
    },
    characterCustomizations: { discord_profile: "fixture-discord-alfa" }
  }
});
```

Append a new `describe` block after `describe("recordPayload", ...)`:

```ts
describe("Raider.IO kill logs", () => {
  // Inline test input shaped like the live response of 2026-09-28. Every
  // identity in it is fake; the point is what the recorder keeps.
  const encounterBody = () => ({
    killDetails: {
      kill: {
        pulledAt: "2026-07-20T17:17:29.977Z",
        defeatedAt: "2026-07-20T17:25:57.301Z",
        durationMs: 507_324,
        isSuccess: true,
        itemLevelEquippedAvg: 290.312,
        itemLevelEquippedMax: 293.062,
        itemLevelEquippedMin: 284.938
      },
      log: {
        id: "reallogid",
        sources: [
          {
            name: "Uploader#12345",
            characterName: "Realname",
            anonymized: false
          }
        ],
        deaths: { count: 2 },
        vantus: { spell: 1, count: 16 }
      },
      raid: { slug: "tier-mn-1", difficulty: "mythic", name: "Midnight" },
      boss: { slug: "midnight-falls", name: "Midnight Falls" },
      guild: {
        id: 1,
        name: "Realguild",
        realm: { slug: "twisting-nether", name: "Twisting Nether" },
        region: { slug: "eu" }
      },
      guildPrivacy: { raidComps: true, raidPulls: true },
      roster: [
        {
          character: {
            id: 424_242,
            name: "Realname",
            class: { id: 12, name: "Demon Hunter" },
            spec: { name: "Havoc", role: "dps" },
            itemLevelEquipped: 290.5,
            realm: { slug: "draenor" },
            region: { slug: "eu" }
          },
          vantus: true
        }
      ]
    }
  });

  it("keeps the fields the parser reads and never an uploader", () => {
    const recording = record(encounterBody(), "raiderio.logged-encounter");
    expect(recording.body).toEqual({
      killDetails: {
        kill: {
          pulledAt: "2020-01-02T00:00:00.000Z",
          defeatedAt: "2020-01-03T00:00:00.000Z",
          durationMs: 507_324,
          isSuccess: true,
          itemLevelEquippedAvg: 290.312,
          itemLevelEquippedMax: 293.062,
          itemLevelEquippedMin: 284.938
        },
        log: { deaths: { count: 2 }, vantus: { count: 16 } },
        raid: { slug: "tier-mn-1", difficulty: "mythic" },
        boss: { slug: "midnight-falls" },
        guild: {
          name: "Fixture Guild Alfa",
          realm: { slug: "twisting-nether" },
          region: { slug: "eu" }
        },
        guildPrivacy: { raidComps: true },
        roster: [
          {
            character: {
              id: 1,
              name: "Alfa",
              class: { name: "Demon Hunter" },
              spec: { name: "Havoc", role: "dps" },
              itemLevelEquipped: 290.5,
              realm: { slug: "draenor" },
              region: { slug: "eu" }
            }
          }
        ]
      }
    });
    expect(recording.ignored).toContain("killDetails.log.sources");
    expect(JSON.stringify(recording)).not.toContain("Uploader");
    expect(verifyRecording(recording)).toEqual([]);
  });

  it("maps one real id to one synthetic id across a session", () => {
    const recording = record(
      {
        characterRaidProgress: {
          raidProgress: [
            {
              raid: "tier-mn-1",
              encountersDefeated: {
                mythic: [
                  {
                    slug: "midnight-falls",
                    firstDefeated: "2026-07-20T17:25:57.000Z",
                    loggedEncounterId: 700_001
                  },
                  {
                    slug: "chimaerus-the-undreamt-god",
                    firstDefeated: "2026-07-13T20:00:00.000Z",
                    loggedEncounterId: 700_002
                  },
                  {
                    slug: "belo-ren-child-of-al-ar",
                    firstDefeated: "2026-07-20T16:00:00.000Z",
                    loggedEncounterId: 700_001
                  }
                ]
              }
            }
          ]
        }
      },
      "raiderio.raid-progress"
    );
    const mythic = (
      recording.body as {
        characterRaidProgress: {
          raidProgress: {
            encountersDefeated: { mythic: { loggedEncounterId: number }[] };
          }[];
        };
      }
    ).characterRaidProgress.raidProgress[0]!.encountersDefeated.mythic;
    expect(mythic.map((kill) => kill.loggedEncounterId)).toEqual([1, 2, 1]);
    expect(verifyRecording(recording)).toEqual([]);
  });

  it("refuses a real id or a real instant", () => {
    const recording = structuredClone(
      record(encounterBody(), "raiderio.logged-encounter")
    ) as Recording & {
      body: {
        killDetails: {
          kill: { pulledAt: string };
          roster: { character: { id: number } }[];
        };
      };
    };
    recording.body.killDetails.kill.pulledAt = "2026-07-20T17:17:29.977Z";
    recording.body.killDetails.roster[0]!.character.id = 424_242;
    expect(verifyRecording(recording)).toEqual([
      {
        path: "body.killDetails.kill.pulledAt",
        problem: "timestamp is not synthetic"
      },
      {
        path: "body.killDetails.roster[].character.id",
        problem: "id is not a synthetic sequence number"
      }
    ]);
  });
});
```

In `handBuiltFixtures`, register the hand-built private roster and correct the two `raid-progress` reasons that stop being true once the endpoint is recorded:

```ts
  "raiderio/logged-encounter-private-roster.json": {
    conformance: "upstream",
    endpoint: "raiderio.logged-encounter"
  },
```

```ts
  "raiderio/raid-progress-rate-limited.json": {
    conformance: "synthetic",
    reason: "a 429 has not been recorded; body is a placeholder marker"
  },
```

```ts
  "raiderio/raid-progress-valid.json": {
    conformance: "synthetic",
    reason:
      "carries a second tier's body in an envelope field recordings have no place for, and fields the allow-list drops; the recorded shape is recorded/raiderio/raid-progress-logged-first-kill.json"
  },
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm exec vitest run --project unit scripts/recorded-payloads.test.mts`
Expected: FAIL — `record(..., "raiderio.logged-encounter")` throws (`policies[options.endpoint]` is undefined), the "drops every field" test sees no `id`, and "are each registered as upstream-shaped or synthetic" fails because `raiderio/logged-encounter-private-roster.json` does not exist yet.

- [ ] **Step 3: Extend the gate**

In `scripts/recorded-payloads.mts`, extend `Endpoint`:

```ts
export type Endpoint =
  | "blizzard.character-profile"
  | "blizzard.guild-roster"
  | "blizzard.character-achievements"
  | "blizzard.playable-class-index"
  | "raiderio.character"
  | "raiderio.view-characters"
  | "raiderio.raid-progress"
  | "raiderio.logged-encounter";
```

Add two members to `LeafKind`, after `{ kind: "timestamp" }`:

```ts
  /** An ISO-8601 instant, replaced like `timestamp` with a synthetic whole day. */
  | { kind: "iso-timestamp" }
  /**
   * An upstream numeric id: a character's, or a logged encounter's. Replaced
   * with a small per-session sequence, because the real id links a recording
   * to the person it came from.
   */
  | { kind: "opaque-id" };
```

After `playableClassNames`, add:

```ts
/** Retail specialisation names, as Raider.IO spells them on a roster. */
export const specialisationNames = [
  "Affliction",
  "Arcane",
  "Arms",
  "Assassination",
  "Augmentation",
  "Balance",
  "Beast Mastery",
  "Blood",
  "Brewmaster",
  "Demonology",
  "Destruction",
  "Devastation",
  "Devourer",
  "Discipline",
  "Elemental",
  "Enhancement",
  "Feral",
  "Fire",
  "Frost",
  "Fury",
  "Guardian",
  "Havoc",
  "Holy",
  "Marksmanship",
  "Mistweaver",
  "Outlaw",
  "Preservation",
  "Protection",
  "Restoration",
  "Retribution",
  "Shadow",
  "Subtlety",
  "Survival",
  "Unholy",
  "Vengeance",
  "Windwalker"
] as const;

/** Synthetic ids count from 1; a real Raider.IO id is far larger. */
export const maximumOpaqueId = 999;
```

Add the two policies to `policies`, after `"raiderio.view-characters"`:

```ts
  "raiderio.raid-progress": {
    provider: "raiderio",
    success: [
      {
        path: "characterRaidProgress.raidProgress[].raid",
        leaf: { kind: "slug" }
      },
      ...(
        [
          ["slug", { kind: "slug" }],
          ["firstDefeated", { kind: "iso-timestamp" }],
          ["loggedEncounterId", { kind: "opaque-id" }],
          ["guild.name", { kind: "identity", identity: "guild" }],
          ["guild.realm.slug", { kind: "slug" }],
          ["guild.region.slug", { kind: "slug" }]
        ] as const
      ).map(([field, leaf]) => ({
        path: `characterRaidProgress.raidProgress[].encountersDefeated.mythic[].${field}`,
        leaf
      }))
    ],
    error: raiderIoError,
    maxItems: {
      "characterRaidProgress.raidProgress": 10,
      "characterRaidProgress.raidProgress[].encountersDefeated.mythic": 10
    }
  },
  // Only what the logged-encounter parser reads. `log.sources` names the
  // uploader's Raider.IO account, which can be a BattleTag or a Discord
  // handle, so it is never on this list.
  "raiderio.logged-encounter": {
    provider: "raiderio",
    success: [
      { path: "killDetails.kill.pulledAt", leaf: { kind: "iso-timestamp" } },
      { path: "killDetails.kill.defeatedAt", leaf: { kind: "iso-timestamp" } },
      { path: "killDetails.kill.durationMs", leaf: { kind: "number" } },
      { path: "killDetails.kill.isSuccess", leaf: { kind: "boolean" } },
      { path: "killDetails.kill.itemLevelEquippedAvg", leaf: { kind: "number" } },
      { path: "killDetails.kill.itemLevelEquippedMax", leaf: { kind: "number" } },
      { path: "killDetails.kill.itemLevelEquippedMin", leaf: { kind: "number" } },
      { path: "killDetails.log.deaths.count", leaf: { kind: "number" } },
      { path: "killDetails.log.vantus.count", leaf: { kind: "number" } },
      { path: "killDetails.raid.slug", leaf: { kind: "slug" } },
      {
        path: "killDetails.raid.difficulty",
        leaf: { kind: "enum", values: ["mythic", "heroic", "normal"] }
      },
      { path: "killDetails.boss.slug", leaf: { kind: "slug" } },
      {
        path: "killDetails.guild.name",
        leaf: { kind: "identity", identity: "guild" }
      },
      { path: "killDetails.guild.realm.slug", leaf: { kind: "slug" } },
      { path: "killDetails.guild.region.slug", leaf: { kind: "slug" } },
      { path: "killDetails.guildPrivacy.raidComps", leaf: { kind: "boolean" } },
      {
        path: "killDetails.roster[].character.id",
        leaf: { kind: "opaque-id" }
      },
      {
        path: "killDetails.roster[].character.name",
        leaf: { kind: "identity", identity: "character" }
      },
      {
        path: "killDetails.roster[].character.class.name",
        leaf: { kind: "enum", values: playableClassNames }
      },
      {
        path: "killDetails.roster[].character.spec.name",
        leaf: { kind: "enum", values: specialisationNames }
      },
      {
        path: "killDetails.roster[].character.spec.role",
        leaf: { kind: "enum", values: ["tank", "healer", "dps"] }
      },
      {
        path: "killDetails.roster[].character.itemLevelEquipped",
        leaf: { kind: "number" }
      },
      {
        path: "killDetails.roster[].character.realm.slug",
        leaf: { kind: "slug" }
      },
      {
        path: "killDetails.roster[].character.region.slug",
        leaf: { kind: "slug" }
      }
    ],
    error: raiderIoError,
    maxItems: { "killDetails.roster": 10 }
  },
```

In the `"raiderio.character"` success list, add as the first entry (the client now reads it, Task 2):

```ts
      { path: "characterDetails.character.id", leaf: { kind: "opaque-id" } },
```

In `PlaceholderBook`, add a field and a method:

```ts
  readonly #ids = new Map<number, number>();

  /** The same real id always maps to the same small synthetic one. */
  opaqueId(value: number, path: string): number {
    let assigned = this.#ids.get(value);
    if (assigned === undefined) {
      assigned = this.#ids.size + 1;
      if (assigned > maximumOpaqueId) {
        throw new RecordingRefused("placeholders_exhausted", path);
      }
      this.#ids.set(value, assigned);
    }
    return assigned;
  }
```

In `recordLeaf`, add two cases before the closing brace of the `switch`:

```ts
    case "iso-timestamp":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
        throw new RecordingRefused("unexpected_type", path);
      recorder.timestamps += 1;
      return new Date(
        syntheticTimestampBase + recorder.timestamps * dayMs
      ).toISOString();
    case "opaque-id":
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new RecordingRefused("unexpected_type", path);
      return recorder.book.opaqueId(value, path);
```

In `verifyLeaf`, add two cases:

```ts
    case "iso-timestamp": {
      if (typeof value !== "string") return "timestamp is not synthetic";
      const at = Date.parse(value);
      return Number.isFinite(at) &&
        new Date(at).toISOString() === value &&
        at > syntheticTimestampBase &&
        (at - syntheticTimestampBase) % dayMs === 0
        ? null
        : "timestamp is not synthetic";
    }
    case "opaque-id":
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= maximumOpaqueId
        ? null
        : "id is not a synthetic sequence number";
```

- [ ] **Step 4: Write the fixtures**

`tests/fixtures/recorded/raiderio/raid-progress-logged-first-kill.json` — one kill with a logged encounter, one without (Nexus-King Salhadaar has a kill and no log):

```json
{
  "provider": "raiderio",
  "endpoint": "raiderio.raid-progress",
  "recordedOn": "2026-09-28",
  "status": 200,
  "body": {
    "characterRaidProgress": {
      "raidProgress": [
        {
          "raid": "manaforge-omega",
          "encountersDefeated": {
            "mythic": [
              {
                "slug": "nexus-king-salhadaar",
                "firstDefeated": "2020-01-02T00:00:00.000Z",
                "loggedEncounterId": null,
                "guild": {
                  "name": "Fixture Guild Bravo",
                  "realm": { "slug": "draenor" },
                  "region": { "slug": "eu" }
                }
              }
            ]
          }
        },
        {
          "raid": "tier-mn-1",
          "encountersDefeated": {
            "mythic": [
              {
                "slug": "midnight-falls",
                "firstDefeated": "2020-01-03T00:00:00.000Z",
                "loggedEncounterId": 1,
                "guild": {
                  "name": "Fixture Guild Alfa",
                  "realm": { "slug": "twisting-nether" },
                  "region": { "slug": "eu" }
                }
              }
            ]
          }
        }
      ]
    }
  },
  "ignored": [
    "characterRaidProgress.raidProgress[].aotc",
    "characterRaidProgress.raidProgress[].cuttingEdge",
    "characterRaidProgress.raidProgress[].encountersDefeated.heroic",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].artifactTraits",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].bossIcon",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.displayName",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.faction",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.id",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.path",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.realm.id",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.realm.name",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.region.name",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guild.region.short_name",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].guildId",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].itemLevel",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].lastDefeated",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].lastRaidWeek",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].numKills",
    "characterRaidProgress.raidProgress[].encountersDefeated.mythic[].raidWeek",
    "characterRaidProgress.raidProgress[].encountersDefeated.normal",
    "characterRaidProgress.raidProgress[].progress",
    "characterRaidProgress.raidProgress[].raidWeekAotC",
    "characterRaidProgress.raidProgress[].raidWeekCuttingEdge",
    "characterRaidProgress.raidProgress[].tier",
    "characterRaidProgress.raidProgress[].weekRanges",
    "characterRaidProgress.tier"
  ]
}
```

The `ignored` list is the drift baseline, so it names every key the real response carries that the allow-list drops: the same keys `tests/fixtures/raiderio/raid-progress-valid.json` carries (`characterRaidProgress.tier`; per raid `aotc`, `cuttingEdge`, `tier`, `progress`, `weekRanges`, `raidWeekAotC`, `raidWeekCuttingEdge`, the `normal` and `heroic` lists; per kill the guild's `id`, `displayName`, `faction`, `path`, `realm.id`, `realm.name`, `region.name` and `region.short_name`), sorted as the recorder sorts them.

`tests/fixtures/recorded/raiderio/logged-encounter-guild-kill.json` — a guild's Midnight Falls kill, every identity replaced by the recorder's placeholders, roster cut to five, the connected character first:

```json
{
  "provider": "raiderio",
  "endpoint": "raiderio.logged-encounter",
  "recordedOn": "2026-09-28",
  "status": 200,
  "body": {
    "killDetails": {
      "kill": {
        "pulledAt": "2020-01-02T00:00:00.000Z",
        "defeatedAt": "2020-01-03T00:00:00.000Z",
        "durationMs": 507324,
        "isSuccess": true,
        "itemLevelEquippedAvg": 290.312,
        "itemLevelEquippedMax": 293.062,
        "itemLevelEquippedMin": 284.938
      },
      "log": { "deaths": { "count": 2 }, "vantus": { "count": 16 } },
      "raid": { "slug": "tier-mn-1", "difficulty": "mythic" },
      "boss": { "slug": "midnight-falls" },
      "guild": {
        "name": "Fixture Guild Alfa",
        "realm": { "slug": "twisting-nether" },
        "region": { "slug": "eu" }
      },
      "guildPrivacy": { "raidComps": true },
      "roster": [
        {
          "character": {
            "id": 1,
            "name": "Alfa",
            "class": { "name": "Demon Hunter" },
            "spec": { "name": "Havoc", "role": "dps" },
            "itemLevelEquipped": 290.5,
            "realm": { "slug": "draenor" },
            "region": { "slug": "eu" }
          }
        },
        {
          "character": {
            "id": 2,
            "name": "Bravo",
            "class": { "name": "Warrior" },
            "spec": { "name": "Protection", "role": "tank" },
            "itemLevelEquipped": 292.1,
            "realm": { "slug": "twisting-nether" },
            "region": { "slug": "eu" }
          }
        },
        {
          "character": {
            "id": 3,
            "name": "Charlie",
            "class": { "name": "Priest" },
            "spec": { "name": "Holy", "role": "healer" },
            "itemLevelEquipped": 291.4,
            "realm": { "slug": "twisting-nether" },
            "region": { "slug": "eu" }
          }
        },
        {
          "character": {
            "id": 4,
            "name": "Delta",
            "class": { "name": "Mage" },
            "spec": { "name": "Frost", "role": "dps" },
            "itemLevelEquipped": 289.9,
            "realm": { "slug": "twisting-nether" },
            "region": { "slug": "eu" }
          }
        },
        {
          "character": {
            "id": 5,
            "name": "Echo",
            "class": { "name": "Paladin" },
            "spec": { "name": "Holy", "role": "healer" },
            "itemLevelEquipped": 288.7,
            "realm": { "slug": "twisting-nether" },
            "region": { "slug": "eu" }
          }
        }
      ]
    }
  },
  "ignored": [
    "killDetails.boss.encounterId",
    "killDetails.boss.iconUrl",
    "killDetails.boss.name",
    "killDetails.boss.ordinal",
    "killDetails.boss.portraitUrl",
    "killDetails.boss.wingId",
    "killDetails.boss.wowEncounterId",
    "killDetails.guild.displayName",
    "killDetails.guild.faction",
    "killDetails.guild.id",
    "killDetails.guild.realm.name",
    "killDetails.guildPrivacy.raidPercents",
    "killDetails.guildPrivacy.raidPulls",
    "killDetails.guildPrivacy.shareRaidUntil",
    "killDetails.guildPrivacy.wereRaidCompsRestricted",
    "killDetails.guildPrivacy.wereRaidPercentsRestricted",
    "killDetails.guildPrivacy.wereRaidPullsRestricted",
    "killDetails.log.correlationId",
    "killDetails.log.id",
    "killDetails.log.sources",
    "killDetails.log.vantus.spell",
    "killDetails.loggedDetails",
    "killDetails.raid.expansion_id",
    "killDetails.raid.icon_url",
    "killDetails.raid.id",
    "killDetails.raid.name",
    "killDetails.raid.short_name",
    "killDetails.raid.type",
    "killDetails.raid.wowInstanceId",
    "killDetails.region",
    "killDetails.roster[].character.artifactTraits",
    "killDetails.roster[].character.class.id",
    "killDetails.roster[].character.class.slug",
    "killDetails.roster[].character.gender",
    "killDetails.roster[].character.items",
    "killDetails.roster[].character.race",
    "killDetails.roster[].character.realm.name",
    "killDetails.roster[].character.spec.class_id",
    "killDetails.roster[].character.spec.id",
    "killDetails.roster[].character.spec.is_melee",
    "killDetails.roster[].character.spec.slug",
    "killDetails.roster[].character.talentLoadout",
    "killDetails.roster[].character.thumbnail",
    "killDetails.roster[].vantus",
    "killDetails.status",
    "killDetails.ui",
    "killDetails.videos"
  ]
}
```

`tests/fixtures/recorded/raiderio/logged-encounter-no-guild.json` — the guild-less Chimaerus shape (`guild` and `guildPrivacy` both `null`):

```json
{
  "provider": "raiderio",
  "endpoint": "raiderio.logged-encounter",
  "recordedOn": "2026-09-28",
  "status": 200,
  "body": {
    "killDetails": {
      "kill": {
        "pulledAt": "2020-01-02T00:00:00.000Z",
        "defeatedAt": "2020-01-03T00:00:00.000Z",
        "durationMs": 312000,
        "isSuccess": true,
        "itemLevelEquippedAvg": 287.5,
        "itemLevelEquippedMax": 290,
        "itemLevelEquippedMin": 284
      },
      "log": { "deaths": { "count": 4 }, "vantus": { "count": 0 } },
      "raid": { "slug": "tier-mn-1", "difficulty": "mythic" },
      "boss": { "slug": "chimaerus-the-undreamt-god" },
      "guild": null,
      "guildPrivacy": null,
      "roster": [
        {
          "character": {
            "id": 1,
            "name": "Alfa",
            "class": { "name": "Hunter" },
            "spec": { "name": "Marksmanship", "role": "dps" },
            "itemLevelEquipped": 287.1,
            "realm": { "slug": "draenor" },
            "region": { "slug": "eu" }
          }
        },
        {
          "character": {
            "id": 2,
            "name": "Bravo",
            "class": { "name": "Druid" },
            "spec": { "name": "Restoration", "role": "healer" },
            "itemLevelEquipped": 288,
            "realm": { "slug": "silvermoon" },
            "region": { "slug": "eu" }
          }
        },
        {
          "character": {
            "id": 3,
            "name": "Charlie",
            "class": { "name": "Death Knight" },
            "spec": { "name": "Blood", "role": "tank" },
            "itemLevelEquipped": 289.2,
            "realm": { "slug": "kazzak" },
            "region": { "slug": "eu" }
          }
        }
      ]
    }
  },
  "ignored": [
    "killDetails.boss.encounterId",
    "killDetails.boss.iconUrl",
    "killDetails.boss.name",
    "killDetails.boss.ordinal",
    "killDetails.boss.portraitUrl",
    "killDetails.boss.wingId",
    "killDetails.boss.wowEncounterId",
    "killDetails.log.correlationId",
    "killDetails.log.id",
    "killDetails.log.sources",
    "killDetails.log.vantus.spell",
    "killDetails.loggedDetails",
    "killDetails.raid.expansion_id",
    "killDetails.raid.icon_url",
    "killDetails.raid.id",
    "killDetails.raid.name",
    "killDetails.raid.short_name",
    "killDetails.raid.type",
    "killDetails.raid.wowInstanceId",
    "killDetails.region",
    "killDetails.roster[].character.artifactTraits",
    "killDetails.roster[].character.class.id",
    "killDetails.roster[].character.class.slug",
    "killDetails.roster[].character.gender",
    "killDetails.roster[].character.items",
    "killDetails.roster[].character.race",
    "killDetails.roster[].character.realm.name",
    "killDetails.roster[].character.spec.class_id",
    "killDetails.roster[].character.spec.id",
    "killDetails.roster[].character.spec.is_melee",
    "killDetails.roster[].character.spec.slug",
    "killDetails.roster[].character.talentLoadout",
    "killDetails.roster[].character.thumbnail",
    "killDetails.roster[].vantus",
    "killDetails.status",
    "killDetails.ui",
    "killDetails.videos"
  ]
}
```

`tests/fixtures/raiderio/logged-encounter-private-roster.json` — hand-built from the recorded shape, the guild having hidden its composition:

```json
{
  "status": 200,
  "body": {
    "killDetails": {
      "kill": {
        "pulledAt": "2020-01-02T00:00:00.000Z",
        "defeatedAt": "2020-01-03T00:00:00.000Z",
        "durationMs": 507324,
        "isSuccess": true,
        "itemLevelEquippedAvg": 290.312,
        "itemLevelEquippedMax": 293.062,
        "itemLevelEquippedMin": 284.938
      },
      "log": { "deaths": { "count": 2 }, "vantus": { "count": 16 } },
      "raid": { "slug": "tier-mn-1", "difficulty": "mythic" },
      "boss": { "slug": "midnight-falls" },
      "guild": {
        "name": "Fixture Guild Alfa",
        "realm": { "slug": "twisting-nether" },
        "region": { "slug": "eu" }
      },
      "guildPrivacy": { "raidComps": false },
      "roster": []
    }
  }
}
```

- [ ] **Step 5: Document the recordings**

In `tests/fixtures/recorded/README.md`:

Add two rows to the "What a recording may contain" table, after `timestamp`:

```markdown
| `iso-timestamp` | the same synthetic whole-day sequence, as an ISO-8601 string |
| `opaque-id` | a per-session sequence from `1`; one real id maps to one synthetic id |
```

Replace the bullet beginning "**Everything the parsers don't read** is dropped" with:

```markdown
- **Everything the parsers don't read** is dropped: account ids, gear,
  scores, biographies, links, `_links`, media, customisations other than the
  two above, and a logged encounter's `log.sources`, which names the uploader's
  Raider.IO account. Character and logged-encounter ids the parsers do read
  are replaced with a small synthetic sequence.
- **Long arrays are cut**: roster members to 10, achievements to 25, a
  profile's characters to 10, a logged encounter's roster to 10.
```

(and delete the old "**Long arrays are cut**" bullet it replaces). In "Gaps", replace "and `raid-progress` and the guild rankings endpoints are not recorded endpoints yet." with "and the guild rankings endpoints are not recorded endpoints yet. The recorder and drift check do not yet fetch `raid-progress` or logged encounters; their recordings were redacted by hand into the recorder's exact form." Append to the "Provenance" table:

```markdown
| `raiderio/raid-progress-logged-first-kill.json` | 2026-09-28 | A kill list with one logged first kill and one kill with no logged encounter, from the #732 live checks. Redacted by hand into the recorder's form. |
| `raiderio/logged-encounter-guild-kill.json` | 2026-09-28 | A guild's Mythic kill with a visible roster, cut to five with the connected character first. Redacted by hand; `log.sources` dropped. |
| `raiderio/logged-encounter-no-guild.json` | 2026-09-28 | A guild-less kill (`guild` and `guildPrivacy` null). Redacted by hand; roster cut to three and numeric fields illustrative. |
```

Run `corepack pnpm exec prettier --write tests/fixtures/recorded/README.md` so the table columns align.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit scripts/recorded-payloads.test.mts`
Expected: PASS, including "raid-progress-logged-first-kill.json carries only allow-listed, redacted values", the two `logged-encounter-*.json` equivalents, and "raiderio/logged-encounter-private-roster.json asserts only shapes a recording has shown".

Run: `corepack pnpm exec tsc -p tsconfig.tools.json`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/recorded-payloads.mts scripts/recorded-payloads.test.mts tests/fixtures/recorded tests/fixtures/raiderio/logged-encounter-private-roster.json
git commit -m "test(fixtures): record Raider.IO kill lists and logged encounters (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Raider.IO client keeps `loggedEncounterId`, reads a logged encounter, and exposes the character's Raider.IO id

**Files:**

- Modify: `packages/raiderio/src/types.ts` (`RaiderIoCharacter` at 3-20, `HistoricMythicKill` at 42-47, `RaiderIoGateway` at 99-122)
- Modify: `packages/raiderio/src/client.ts` (`historicRaidProgressResponseSchema` at 96-120, `normalizeHistoricRaidProgress` at 188-212, `historicKillLimitation`/`bossRankingLimitation` at 214-258 and their callers at 522, 603, 626, the returned gateway at 630-636)
- Modify: `packages/raiderio/src/normalize.ts` (`upstreamCharacterSchema` at 22-32, `normalizeCharacterResponse` at 172-196)
- Modify: `packages/raiderio/src/index.ts`
- Create: `packages/domain/src/logged-encounter.ts`
- Test: `packages/domain/src/logged-encounter.test.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/raiderio/src/client.test.ts`

**Interfaces:**

- Consumes: fixtures from Task 1.
- Produces, from `@slashwho/domain`: `isRosterShown(raidComps: boolean | null | undefined, members: readonly unknown[]): boolean`, the one "empty roster is private" rule (Task 6 imports it too).
- Produces (all exported from `@slashwho/raiderio`):

```ts
export type HistoricMythicKill = Readonly<{
  raidSlug: string;
  bossSlug: string;
  firstDefeated: string;
  guild: { name: string; realm: string; region: string } | null;
  loggedEncounterId?: number | null; // always set by the client
}>;
export type RaiderIoRosterRole = "tank" | "healer" | "dps";
export type LoggedEncounterMember = Readonly<{
  raiderIoCharacterId: number; name: string; realm: string; region: string;
  className: string; specName: string; role: RaiderIoRosterRole; itemLevel: number | null;
}>;
export type LoggedEncounter = Readonly<{
  kind: "encounter";
  raidSlug: string; bossSlug: string;
  pulledAt: string; defeatedAt: string; durationMs: number;
  itemLevel: Readonly<{ average: number; min: number; max: number }>;
  guild: Readonly<{ name: string; realm: string; region: string }> | null;
  deathCount: number; vantusCount: number;
  roster:
    | Readonly<{ state: "available"; members: readonly LoggedEncounterMember[] }>
    | Readonly<{ state: "unavailable"; reason: "private" }>;
}>;
export type LoggedEncounterResult =
  | LoggedEncounter
  | { kind: "limitation"; code: RaiderIoEvidenceLimitation; retryAfterMs?: number };
// RaiderIoGateway gains:
getLoggedEncounter(raidSlug: string, loggedEncounterId: number, signal?: AbortSignal,
  onPhysicalRequest?: RaiderIoPhysicalRequestObserver): Promise<LoggedEncounterResult>;
// RaiderIoCharacter gains: readonly raiderIoCharacterId?: number;
```

- [ ] **Step 1: Write the failing tests**

In `packages/raiderio/src/client.test.ts`, update the expected kills of `"normalizes historic Mythic kills without retaining an upstream payload"` — both fixture entries carry `"loggedEncounterId": null`:

```ts
        {
          raidSlug: "nerubar-palace",
          bossSlug: "queen-ansurek",
          firstDefeated: "2025-02-04T17:59:00.000Z",
          guild: { name: "Example Guild", realm: "silvermoon", region: "eu" },
          loggedEncounterId: null
        },
        {
          raidSlug: "nerubar-palace",
          bossSlug: "the-silken-court",
          firstDefeated: "2025-01-29T20:00:00.000Z",
          guild: null,
          loggedEncounterId: null
        }
```

Append at the end of the file:

```ts
type RecordedBody = { status: number; body: unknown };

function readRecorded(file: string): RecordedBody {
  return JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          `../../../tests/fixtures/recorded/raiderio/${file}.json`,
          import.meta.url
        )
      ),
      "utf8"
    )
  ) as RecordedBody;
}

function readHandBuilt(file: string): RecordedBody {
  return JSON.parse(
    readFileSync(resolve(fixtureDirectory, `${file}.json`), "utf8")
  ) as RecordedBody;
}

/** A client whose only upstream is one logged encounter at its own path. */
function loggedEncounterClient(
  fixture: RecordedBody,
  edit: (body: Record<string, unknown>) => void = () => undefined
) {
  const requested: string[] = [];
  const body = structuredClone(fixture.body) as Record<string, unknown>;
  edit(body);
  const client = createRaiderIoClient({
    fetch: async (input) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      requested.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify(body), {
        status: fixture.status,
        headers: { "Content-Type": "application/json" }
      });
    },
    baseUrl: "https://fixtures.invalid",
    timeoutMs: 50,
    accessKey: "server-key"
  });
  return { client, requested };
}

type KillDetails = {
  kill: Record<string, unknown>;
  raid: Record<string, unknown>;
  log: Record<string, unknown>;
  guildPrivacy: Record<string, unknown> | null;
  roster?: { character: Record<string, unknown> }[];
};
const details = (body: Record<string, unknown>) =>
  body.killDetails as KillDetails;

describe("Raider.IO logged encounters", () => {
  it("reads a recorded guild kill's parsed fields from its own path", async () => {
    const { client, requested } = loggedEncounterClient(
      readRecorded("logged-encounter-guild-kill")
    );

    const result = await client.getLoggedEncounter("tier-mn-1", 700_001);

    // Not an /api/v1 path, so the access key is never attached.
    expect(requested).toEqual(["/api/raid/logged-encounters/tier-mn-1/700001"]);
    expect(result).toEqual({
      kind: "encounter",
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      pulledAt: "2020-01-02T00:00:00.000Z",
      defeatedAt: "2020-01-03T00:00:00.000Z",
      durationMs: 507_324,
      itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
      guild: {
        name: "Fixture Guild Alfa",
        realm: "twisting-nether",
        region: "eu"
      },
      deathCount: 2,
      vantusCount: 16,
      roster: {
        state: "available",
        members: [
          {
            raiderIoCharacterId: 1,
            name: "Alfa",
            realm: "draenor",
            region: "eu",
            className: "Demon Hunter",
            specName: "Havoc",
            role: "dps",
            itemLevel: 290.5
          },
          {
            raiderIoCharacterId: 2,
            name: "Bravo",
            realm: "twisting-nether",
            region: "eu",
            className: "Warrior",
            specName: "Protection",
            role: "tank",
            itemLevel: 292.1
          },
          {
            raiderIoCharacterId: 3,
            name: "Charlie",
            realm: "twisting-nether",
            region: "eu",
            className: "Priest",
            specName: "Holy",
            role: "healer",
            itemLevel: 291.4
          },
          {
            raiderIoCharacterId: 4,
            name: "Delta",
            realm: "twisting-nether",
            region: "eu",
            className: "Mage",
            specName: "Frost",
            role: "dps",
            itemLevel: 289.9
          },
          {
            raiderIoCharacterId: 5,
            name: "Echo",
            realm: "twisting-nether",
            region: "eu",
            className: "Paladin",
            specName: "Holy",
            role: "healer",
            itemLevel: 288.7
          }
        ]
      }
    });
  });

  it("never surfaces the log's uploaders, whatever they are called", async () => {
    // Break caught: `log.sources` names the uploader's Raider.IO account,
    // which can be a BattleTag or a Discord handle. It must never be parsed.
    const { client } = loggedEncounterClient(
      readRecorded("logged-encounter-guild-kill"),
      (body) => {
        details(body).log.sources = [
          {
            name: "Uploader#12345",
            avatar: "https://example.invalid/avatar.png",
            characterName: "Uploadername",
            anonymized: false
          }
        ];
      }
    );

    const result = await client.getLoggedEncounter("tier-mn-1", 700_001);

    expect(result.kind).toBe("encounter");
    expect(JSON.stringify(result)).not.toMatch(/Uploader|avatar|sources/);
  });

  it("keeps a guild-less kill with its roster", async () => {
    const { client } = loggedEncounterClient(
      readRecorded("logged-encounter-no-guild")
    );

    const result = await client.getLoggedEncounter("tier-mn-1", 700_002);

    expect(result).toMatchObject({
      kind: "encounter",
      bossSlug: "chimaerus-the-undreamt-god",
      guild: null,
      roster: { state: "available", members: expect.any(Array) }
    });
  });

  it("keeps the kill when the guild has hidden its roster", async () => {
    const { client } = loggedEncounterClient(
      readHandBuilt("logged-encounter-private-roster")
    );

    await expect(
      client.getLoggedEncounter("tier-mn-1", 700_001)
    ).resolves.toMatchObject({
      kind: "encounter",
      defeatedAt: "2020-01-03T00:00:00.000Z",
      guild: { name: "Fixture Guild Alfa" },
      roster: { state: "unavailable", reason: "private" }
    });
  });

  it.each([
    [
      "missing",
      (body: Record<string, unknown>) => void delete details(body).roster
    ],
    [
      "empty",
      (body: Record<string, unknown>) => void (details(body).roster = [])
    ]
  ])(
    "treats an %s roster as unavailable, never as nobody",
    async (_name, edit) => {
      const { client } = loggedEncounterClient(
        readRecorded("logged-encounter-guild-kill"),
        edit
      );
      await expect(
        client.getLoggedEncounter("tier-mn-1", 700_001)
      ).resolves.toMatchObject({
        roster: { state: "unavailable", reason: "private" }
      });
    }
  );

  it("spells a raider's realm as a character key spells it", async () => {
    // Break caught: a removal is keyed by the Blizzard realm slug. Kept with
    // Raider.IO's accents, a removed raider on an accented realm would never
    // match their suppression and would still be shown on other dossiers.
    const { client } = loggedEncounterClient(
      readRecorded("logged-encounter-guild-kill"),
      (body) => {
        (
          details(body).roster![0]!.character.realm as Record<string, unknown>
        ).slug = "Aggra-Português";
      }
    );
    const result = await client.getLoggedEncounter("tier-mn-1", 700_001);
    if (result.kind !== "encounter" || result.roster.state !== "available")
      throw new Error("expected_available_roster");
    expect(result.roster.members[0]!.realm).toBe("aggra-portugues");
  });

  it("keeps a missing item level as null, never zero", async () => {
    const { client } = loggedEncounterClient(
      readRecorded("logged-encounter-guild-kill"),
      (body) => {
        delete details(body).roster![0]!.character.itemLevelEquipped;
      }
    );
    const result = await client.getLoggedEncounter("tier-mn-1", 700_001);
    if (result.kind !== "encounter" || result.roster.state !== "available")
      throw new Error("expected_available_roster");
    expect(result.roster.members[0]!.itemLevel).toBeNull();
  });

  it.each([
    [
      "an unsuccessful pull",
      (body: Record<string, unknown>) =>
        void (details(body).kill.isSuccess = false)
    ],
    [
      "a Heroic kill",
      (body: Record<string, unknown>) =>
        void (details(body).raid.difficulty = "heroic")
    ],
    [
      "a malformed roster role",
      (body: Record<string, unknown>) =>
        void ((
          details(body).roster![0]!.character.spec as Record<string, unknown>
        ).role = "support")
    ]
  ])("reads %s as schema drift", async (_name, edit) => {
    const { client } = loggedEncounterClient(
      readRecorded("logged-encounter-guild-kill"),
      edit
    );
    await expect(
      client.getLoggedEncounter("tier-mn-1", 700_001)
    ).resolves.toEqual({ kind: "limitation", code: "schema_drift" });
  });

  it.each([
    [404, {}, { kind: "limitation", code: "not_found" }],
    [403, {}, { kind: "limitation", code: "private" }],
    [
      429,
      { "retry-after": "30" },
      { kind: "limitation", code: "rate_limited", retryAfterMs: 30_000 }
    ],
    [500, {}, { kind: "limitation", code: "unavailable" }]
  ])("classifies a %i as a limitation", async (status, headers, expected) => {
    const client = createRaiderIoClient({
      fetch: async () =>
        new Response(JSON.stringify({ statusCode: status }), {
          status,
          headers: { "Content-Type": "application/json", ...headers }
        }),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });
    await expect(
      client.getLoggedEncounter("tier-mn-1", 700_001)
    ).resolves.toEqual(expected);
  });

  it("refuses an id or slug it could not safely put in a path, without a request", async () => {
    let calls = 0;
    const client = createRaiderIoClient({
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });
    await expect(client.getLoggedEncounter("tier-mn-1", 0)).resolves.toEqual({
      kind: "limitation",
      code: "schema_drift"
    });
    await expect(
      client.getLoggedEncounter("../tier", 700_001)
    ).resolves.toEqual({ kind: "limitation", code: "schema_drift" });
    expect(calls).toBe(0);
  });

  it("reports each encounter request it sends", async () => {
    const { client } = loggedEncounterClient(
      readRecorded("logged-encounter-guild-kill")
    );
    let physical = 0;
    await client.getLoggedEncounter("tier-mn-1", 700_001, undefined, () => {
      physical += 1;
    });
    expect(physical).toBe(1);
  });
});

describe("Raider.IO kill list logged encounters", () => {
  it("keeps a recorded kill's logged encounter id, and null where there is none", async () => {
    const recording = readRecorded("raid-progress-logged-first-kill");
    const client = createRaiderIoClient({
      fetch: async () =>
        new Response(JSON.stringify(recording.body), {
          status: recording.status,
          headers: { "Content-Type": "application/json" }
        }),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    const result = await client.getHistoricMythicKills(sentinel, {
      tierOrdinals: [35]
    });

    expect(result).toEqual({
      kind: "evidence",
      kills: [
        {
          raidSlug: "manaforge-omega",
          bossSlug: "nexus-king-salhadaar",
          firstDefeated: "2020-01-02T00:00:00.000Z",
          guild: {
            name: "Fixture Guild Bravo",
            realm: "draenor",
            region: "eu"
          },
          loggedEncounterId: null
        },
        {
          raidSlug: "tier-mn-1",
          bossSlug: "midnight-falls",
          firstDefeated: "2020-01-03T00:00:00.000Z",
          guild: {
            name: "Fixture Guild Alfa",
            realm: "twisting-nether",
            region: "eu"
          },
          loggedEncounterId: 1
        }
      ]
    });
  });

  it.each([[[34, 35]], [[35, 34]]])(
    "keeps the id of the kill the earliest-kill merge keeps (tiers %j)",
    async (tierOrdinals) => {
      // Break caught: a merge that kept the earlier date but the later kill's
      // id would read a reclear's log as the first kill's.
      const kill = (firstDefeated: string, loggedEncounterId: number) => ({
        characterRaidProgress: {
          raidProgress: [
            {
              raid: "tier-mn-1",
              encountersDefeated: {
                mythic: [
                  { slug: "midnight-falls", firstDefeated, loggedEncounterId }
                ]
              }
            }
          ]
        }
      });
      const client = createRaiderIoClient({
        fetch: async (input) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url
          );
          const body =
            url.searchParams.get("tier") === "35"
              ? kill("2026-07-20T17:25:57.000Z", 700_001)
              : kill("2026-07-27T18:00:00.000Z", 700_003);
          return new Response(JSON.stringify(body), { status: 200 });
        },
        baseUrl: "https://fixtures.invalid",
        timeoutMs: 50
      });

      await expect(
        client.getHistoricMythicKills(sentinel, { tierOrdinals })
      ).resolves.toEqual({
        kind: "evidence",
        kills: [
          expect.objectContaining({
            firstDefeated: "2026-07-20T17:25:57.000Z",
            loggedEncounterId: 700_001
          })
        ]
      });
    }
  );
});

describe("Raider.IO character id", () => {
  it("reads the character's own Raider.IO id, which a roster names it by", async () => {
    const client = createRaiderIoClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            characterDetails: {
              character: {
                id: 424_242,
                name: "Sentinel",
                level: 90,
                class: { name: "Demon Hunter" },
                realm: { slug: "silvermoon" },
                region: { slug: "eu" }
              }
            }
          }),
          { status: 200 }
        ),
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 50
    });

    await expect(client.getCharacter(sentinel)).resolves.toMatchObject({
      raiderIoCharacterId: 424_242
    });
  });

  it("leaves the id absent rather than inventing one", async () => {
    const character = await recordedClient("character-claimed").getCharacter({
      region: "eu",
      realm: "silvermoon",
      name: "charlie"
    });
    expect(character).not.toHaveProperty("raiderIoCharacterId");
  });
});
```

Create `packages/domain/src/logged-encounter.test.ts`:

```ts
import { expect, it } from "vitest";

import { isRosterShown } from "./logged-encounter";

it.each([
  ["a visible roster", true, [{}], true],
  ["a roster whose privacy Raider.IO did not state", undefined, [{}], true],
  ["a guild with no privacy block (a pug)", null, [{}], true],
  ["a hidden composition", false, [{}], false],
  ["an empty roster", true, [], false]
] as const)("shows %s: %s", (_name, raidComps, members, shown) => {
  // An empty roster reads as "nobody was there", which Raider.IO never means.
  expect(isRosterShown(raidComps, members)).toBe(shown);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm exec vitest run --project unit packages/raiderio/src/client.test.ts packages/domain/src/logged-encounter.test.ts`
Expected: FAIL — `client.getLoggedEncounter is not a function`, `loggedEncounterId` missing from historic kills, `raiderIoCharacterId` missing, and `./logged-encounter` does not exist.

- [ ] **Step 3: Add the types**

In `packages/raiderio/src/types.ts`, add to `RaiderIoCharacter` (after `declaredMain`):

```ts
  /**
   * Raider.IO's own id for the character, which a logged encounter's roster
   * names it by. Absent from profile lists, which do not carry it.
   */
  readonly raiderIoCharacterId?: number;
```

Replace the `HistoricMythicKill` doc comment and type:

```ts
/**
 * A Mythic kill Raider.IO attributes to the character. On its own it is only a
 * place to search: it tells the Warcraft Logs scan which guild's logs to read
 * and on which night. Where Raider.IO also holds a parsed combat log of it
 * (`loggedEncounterId`), that log is evidence (#732).
 */
export type HistoricMythicKill = Readonly<{
  raidSlug: string;
  bossSlug: string;
  firstDefeated: string;
  guild: { name: string; realm: string; region: string } | null;
  /**
   * Raider.IO's logged encounter of this first kill, or null when it has
   * none. It always names the first kill, never a reclear. Always set by the
   * client; optional so a kill built without it still types.
   */
  loggedEncounterId?: number | null;
}>;
```

After `MythicBossRankingsResult`, add:

```ts
export type RaiderIoRosterRole = "tank" | "healer" | "dps";

/** One raider on a logged encounter's roster. */
export type LoggedEncounterMember = Readonly<{
  raiderIoCharacterId: number;
  name: string;
  realm: string;
  region: string;
  className: string;
  specName: string;
  role: RaiderIoRosterRole;
  /** Null when Raider.IO did not say; never zero. */
  itemLevel: number | null;
}>;

/**
 * Raider.IO's parsed combat log of one Mythic kill: only the fields #732
 * keeps. Never the uploaders, never the response.
 */
export type LoggedEncounter = Readonly<{
  kind: "encounter";
  raidSlug: string;
  bossSlug: string;
  pulledAt: string;
  defeatedAt: string;
  durationMs: number;
  itemLevel: Readonly<{ average: number; min: number; max: number }>;
  /** Null for a kill with no guild: a pug. */
  guild: Readonly<{ name: string; realm: string; region: string }> | null;
  deathCount: number;
  vantusCount: number;
  roster:
    | Readonly<{
        state: "available";
        members: readonly LoggedEncounterMember[];
      }>
    | Readonly<{ state: "unavailable"; reason: "private" }>;
}>;

export type LoggedEncounterResult =
  | LoggedEncounter
  | {
      kind: "limitation";
      code: RaiderIoEvidenceLimitation;
      retryAfterMs?: number;
    };
```

Add to `RaiderIoGateway`, after `getMythicBossRankings`:

```ts
  /** One logged encounter. The phase decides when one is read again (#732). */
  getLoggedEncounter(
    raidSlug: string,
    loggedEncounterId: number,
    signal?: AbortSignal,
    onPhysicalRequest?: RaiderIoPhysicalRequestObserver
  ): Promise<LoggedEncounterResult>;
```

- [ ] **Step 4: Read the id and the encounter**

Create `packages/domain/src/logged-encounter.ts`, the one place the rule is written:

```ts
/**
 * Whether a Raider.IO logged encounter's roster can be shown (#732). A hidden
 * composition, a missing roster and an empty one all mean the same to a
 * reader: nobody can be shown, which is never "nobody was there". Decided
 * here once. The Raider.IO client applies it to each response, and the
 * dossier applies it again to the roster left once suppressed raiders are
 * taken off.
 */
export function isRosterShown(
  raidComps: boolean | null | undefined,
  members: readonly unknown[]
): boolean {
  return raidComps !== false && members.length > 0;
}
```

In `packages/domain/src/index.ts`, add:

```ts
export { isRosterShown } from "./logged-encounter";
```

In `packages/raiderio/src/client.ts`, add `loggedEncounterId` to the Mythic entry of `historicRaidProgressResponseSchema`:

```ts
            z.object({
              slug: z.string().min(1),
              firstDefeated: z.string().datetime(),
              loggedEncounterId: z.number().int().positive().nullable().optional(),
              guild: z
```

In `normalizeHistoricRaidProgress`, add to the pushed kill:

```ts
        loggedEncounterId: encounter.loggedEncounterId ?? null,
```

The earliest-kill merge (lines 517-532) already keeps whole kill objects, so the id travels with the kill it keeps; the test above pins that.

Import the new types at the top of `client.ts` (`LoggedEncounter`, `LoggedEncounterResult`, `RaiderIoEvidenceLimitation`) alongside the existing `./types` import, change the first import to `import { isRosterShown, isValidCharacterKey, type CharacterKey } from "@slashwho/domain";`, and add after `guildEncountersSchema`:

```ts
// Recorded 2026-09-28. Only these fields are read. `log.sources` names the
// uploader's Raider.IO account, which can be a BattleTag or a Discord handle,
// so the schema never names it and zod strips it with everything else.
const loggedEncounterResponseSchema = z.object({
  killDetails: z.object({
    kill: z.object({
      pulledAt: z.string().datetime(),
      defeatedAt: z.string().datetime(),
      durationMs: z.number().int().nonnegative(),
      isSuccess: z.boolean(),
      itemLevelEquippedAvg: z.number().nonnegative(),
      itemLevelEquippedMax: z.number().nonnegative(),
      itemLevelEquippedMin: z.number().nonnegative()
    }),
    log: z.object({
      deaths: z.object({ count: z.number().int().nonnegative() }),
      vantus: z.object({ count: z.number().int().nonnegative() })
    }),
    raid: z.object({ slug: z.string().min(1), difficulty: z.string().min(1) }),
    boss: z.object({ slug: z.string().min(1) }),
    guild: z
      .object({
        name: z.string().min(1),
        realm: z.object({ slug: z.string().min(1) }),
        region: z.object({ slug: z.string().min(1) })
      })
      .nullable()
      .optional(),
    guildPrivacy: z.object({ raidComps: z.boolean() }).nullable().optional(),
    roster: z
      .array(
        z.object({
          character: z.object({
            id: z.number().int().positive(),
            name: z.string().min(1),
            class: z.object({ name: z.string().min(1) }),
            spec: z.object({
              name: z.string().min(1),
              role: z.enum(["tank", "healer", "dps"])
            }),
            itemLevelEquipped: z.number().nonnegative().nullable().optional(),
            realm: z.object({ slug: z.string().min(1) }),
            region: z.object({ slug: z.string().min(1) })
          })
        })
      )
      .optional()
  })
});

const lowerCase = (value: string) => value.toLocaleLowerCase("en-US");

/**
 * A roster member's realm as every character key spells it: lower case with
 * the accents dropped, as `parseCharacterPath` folds a Raider.IO URL
 * ("aggra-português" is "aggra-portugues"). A suppression is keyed the same
 * way, so a removed raider is recognised on another character's roster.
 */
const memberRealm = (value: string) =>
  lowerCase(value).normalize("NFD").replace(/\p{M}/gu, "");

function normalizeLoggedEncounter(value: unknown): LoggedEncounter {
  const { killDetails } = loggedEncounterResponseSchema.parse(value);
  // A first kill's log is a successful Mythic pull. Anything else is not the
  // kill the character's list named, and is refused as drift.
  if (!killDetails.kill.isSuccess || killDetails.raid.difficulty !== "mythic") {
    throw new Error("logged_encounter_not_a_mythic_kill");
  }
  const roster = killDetails.roster ?? [];
  const hidden = !isRosterShown(killDetails.guildPrivacy?.raidComps, roster);
  return {
    kind: "encounter",
    raidSlug: killDetails.raid.slug,
    bossSlug: killDetails.boss.slug,
    pulledAt: killDetails.kill.pulledAt,
    defeatedAt: killDetails.kill.defeatedAt,
    durationMs: killDetails.kill.durationMs,
    itemLevel: {
      average: killDetails.kill.itemLevelEquippedAvg,
      min: killDetails.kill.itemLevelEquippedMin,
      max: killDetails.kill.itemLevelEquippedMax
    },
    guild: killDetails.guild
      ? {
          name: killDetails.guild.name,
          realm: lowerCase(killDetails.guild.realm.slug),
          region: lowerCase(killDetails.guild.region.slug)
        }
      : null,
    deathCount: killDetails.log.deaths.count,
    vantusCount: killDetails.log.vantus.count,
    roster: hidden
      ? { state: "unavailable", reason: "private" }
      : {
          state: "available",
          members: roster.map(({ character }) => ({
            raiderIoCharacterId: character.id,
            name: character.name,
            realm: memberRealm(character.realm.slug),
            region: lowerCase(character.region.slug),
            className: character.class.name,
            specName: character.spec.name,
            role: character.spec.role,
            itemLevel: character.itemLevelEquipped ?? null
          }))
        }
  };
}
```

Replace `historicKillLimitation` and `bossRankingLimitation` (`client.ts:214-258`, the same switch written twice) with one mapper, which the new method uses too:

```ts
type RaiderIoLimitationResult = Readonly<{
  kind: "limitation";
  code: RaiderIoEvidenceLimitation;
  retryAfterMs?: number;
}>;

/**
 * An upstream failure as a limitation, for every evidence method: the kill
 * list, the boss rankings and a logged encounter answer failures alike.
 */
function raiderIoLimitation(error: unknown): RaiderIoLimitationResult {
  if (!isUpstreamFailure(error)) {
    return { kind: "limitation", code: "unavailable" };
  }
  switch (error.kind) {
    case "not_found":
      return { kind: "limitation", code: "not_found" };
    case "forbidden":
      return { kind: "limitation", code: "private" };
    case "schema_drift":
      return { kind: "limitation", code: "schema_drift" };
    case "transient":
      return {
        kind: "limitation",
        code: error.status === 429 ? "rate_limited" : "unavailable",
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs })
      };
  }
}
```

and change its three existing callers (`return historicKillLimitation(outcome.error);` at line 522, `return bossRankingLimitation(error);` at 603 and 626) to `return raiderIoLimitation(...)` with the same argument. `RaiderIoLimitationResult` is assignable to the limitation member of `HistoricMythicKillResult`, `MythicBossRankingsResult` and `LoggedEncounterResult` alike. The existing limitation tests of both older methods keep passing unchanged, and that is what pins the merge.

Inside `createRaiderIoClient`, after `getMythicBossRankings`, add:

```ts
async function getLoggedEncounter(
  raidSlug: string,
  loggedEncounterId: number,
  signal?: AbortSignal,
  onPhysicalRequest?: RaiderIoPhysicalRequestObserver
): Promise<LoggedEncounterResult> {
  // Both go into the path, so neither may be anything but what Raider.IO
  // itself sends: a slug and a positive integer.
  if (
    !/^[a-z0-9-]+$/.test(raidSlug) ||
    !Number.isSafeInteger(loggedEncounterId) ||
    loggedEncounterId <= 0
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }
  signal?.throwIfAborted();
  const url = new URL(
    `/api/raid/logged-encounters/${raidSlug}/${String(loggedEncounterId)}`,
    baseUrl
  );
  try {
    return await request(
      url,
      normalizeLoggedEncounter,
      signal,
      onPhysicalRequest
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return raiderIoLimitation(error);
  }
}
```

and add `getLoggedEncounter` to the returned object.

In `packages/raiderio/src/normalize.ts`, add to `upstreamCharacterSchema`:

```ts
  id: z.number().int().positive().optional(),
```

and in `normalizeCharacterResponse`'s return, after `declaredMain,`:

```ts
    ...(details.character.id === undefined
      ? {}
      : { raiderIoCharacterId: details.character.id }),
```

In `packages/raiderio/src/index.ts`, add to the type exports:

```ts
  LoggedEncounter,
  LoggedEncounterMember,
  LoggedEncounterResult,
  RaiderIoRosterRole,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/raiderio/src packages/domain/src/logged-encounter.test.ts`
Expected: PASS.

Run: `corepack pnpm --filter @slashwho/raiderio typecheck && corepack pnpm --filter @slashwho/domain typecheck`
Expected: exits 0.

Run: `corepack pnpm typecheck`
Expected: FAIL only where a hand-written `RaiderIoGateway` fake is now missing `getLoggedEncounter`. For each reported file, the fake is typed as a full `RaiderIoGateway`; add `getLoggedEncounter: vi.fn()` (or, for `tests/e2e/support/fake-raiderio.ts` if it reports, a method returning `{ kind: "limitation", code: "not_found" }`). Re-run until it exits 0. Fakes typed with `Pick<RaiderIoGateway, ...>` need nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/raiderio packages/domain/src/logged-encounter.ts packages/domain/src/logged-encounter.test.ts packages/domain/src/index.ts tests/e2e/support
git commit -m "feat(raiderio): keep logged encounter ids and read a logged encounter (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Domain catalogue: shared match tolerance, the one match rule, and Raider.IO slug lookup

**Files:**

- Create: `packages/domain/src/kill-matching.ts`
- Test: `packages/domain/src/kill-matching.test.ts`
- Modify: `packages/domain/src/raid-catalogue.ts` (after `lookupRaiderIoBoss`, which ends at line 918; the Grong overrides are at 359-361)
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/application/src/verified-kills.ts:13-21`
- Test: `packages/domain/src/raid-catalogue.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (exported from `@slashwho/domain`):
  - `STORED_KILL_MATCH_MS: number` (2 hours).
  - `lookupRaidEncounterByRaiderIoSlugs(raidSlug: string, bossSlug: string): RaidCatalogueEncounter | null`. When several encounters of one raid share an override slug (Grong), it returns the first the Journal lists.
  - `matchesRaiderIoKill(raiderIo: Readonly<{ raidSlug: string; bossSlug: string; killedAt: string }>, warcraftLogs: Readonly<{ raidName: string; bossName?: string; killedAt: string }>): boolean`, the one rule for "this Raider.IO first kill is that Warcraft Logs kill". Task 5 and Task 6 both import it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/src/raid-catalogue.test.ts` (add `lookupRaidEncounterByRaiderIoSlugs` to its import from `"./raid-catalogue"`; `supportedRaidCatalogue` and `lookupRaiderIoBoss` are already imported there):

```ts
it.each([
  [
    "tier-mn-1",
    "midnight-falls",
    "March on Quel'Danas",
    "Midnight Falls",
    "2740"
  ],
  [
    "tier-mn-1",
    "chimaerus-the-undreamt-god",
    "The Dreamrift",
    "Chimaerus the Undreamt God",
    "2795"
  ],
  [
    "tier-mn-1",
    "fallenking-salhadaar",
    "The Voidspire",
    "Fallen-King Salhadaar",
    null
  ],
  [
    "manaforge-omega",
    "dimensius",
    "Manaforge Omega",
    "Dimensius, the All-Devouring",
    null
  ]
])(
  "places Raider.IO's %s / %s in the catalogue",
  (raidSlug, bossSlug, raidName, bossName, bossId) => {
    const encounter = lookupRaidEncounterByRaiderIoSlugs(raidSlug, bossSlug);
    expect(encounter).toMatchObject({ raidName, bossName });
    if (bossId !== null) expect(encounter?.bossId).toBe(bossId);
  }
);

it("places every catalogued encounter Raider.IO names under a boss with the same slugs", () => {
  // Pinned against the forward lookup, so the two can never disagree about
  // which boss a Raider.IO kill is shown under. Where Raider.IO ranks two
  // Journal encounters as one boss, both place under the same one.
  for (const raid of supportedRaidCatalogue()) {
    for (const encounter of raid.encounters) {
      const slugs = lookupRaiderIoBoss(encounter.raidName, encounter.bossName);
      if (!slugs) continue;
      const placed = lookupRaidEncounterByRaiderIoSlugs(
        slugs.raidSlug,
        slugs.bossSlug
      );
      expect(placed, `${encounter.raidName} / ${encounter.bossName}`).not.toBe(
        null
      );
      expect(lookupRaiderIoBoss(placed!.raidName, placed!.bossName)).toEqual(
        slugs
      );
      expect(placed!.raidId).toBe(encounter.raidId);
    }
  }
});

it("shows Raider.IO's one Grong under the Grong the Journal lists first", () => {
  // Break caught: both faction versions override to `grong`, so a lookup
  // that demanded exactly one match placed neither, and a Raider.IO Grong
  // kill was dropped from the dossier without a word.
  expect(
    lookupRaidEncounterByRaiderIoSlugs("battle-of-dazaralor", "grong")
  ).toMatchObject({ bossId: "2325", bossName: "Grong, the Jungle Lord" });
  expect(
    lookupRaiderIoBoss("Battle of Dazar'alor", "Grong, the Revenant")
  ).toEqual({ raidSlug: "battle-of-dazaralor", bossSlug: "grong" });
});

it("places nothing it cannot name exactly", () => {
  expect(
    lookupRaidEncounterByRaiderIoSlugs("tier-mn-1", "not-a-boss")
  ).toBeNull();
  expect(
    lookupRaidEncounterByRaiderIoSlugs("not-a-raid", "midnight-falls")
  ).toBeNull();
});
```

Create `packages/domain/src/kill-matching.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { matchesRaiderIoKill, STORED_KILL_MATCH_MS } from "./kill-matching";

describe("matchesRaiderIoKill", () => {
  const midnightFalls = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z"
  };

  it("matches stored kills within two hours of Raider.IO's time", () => {
    expect(STORED_KILL_MATCH_MS).toBe(7_200_000);
  });

  it.each([
    ["an hour later", "2026-07-20T18:25:57.301Z", true],
    ["exactly two hours later", "2026-07-20T19:25:57.301Z", true],
    ["two hours and a second later", "2026-07-20T19:25:58.301Z", false],
    ["an hour earlier", "2026-07-20T16:25:57.301Z", true]
  ])("matches a Warcraft Logs kill %s: %s", (_name, killedAt, matches) => {
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "March on Quel'Danas",
        bossName: "Midnight Falls",
        killedAt
      })
    ).toBe(matches);
  });

  it("matches the boss by Raider.IO's slugs, whatever zone Warcraft Logs filed it under", () => {
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "VS / DR / MQD",
        bossName: "Midnight Falls",
        killedAt: "2026-07-20T18:00:00.000Z"
      })
    ).toBe(true);
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "March on Quel'Danas",
        bossName: "Belo'ren, Child of Al'ar",
        killedAt: "2026-07-20T17:25:57.301Z"
      })
    ).toBe(false);
  });

  it("never matches a kill it cannot name", () => {
    expect(
      matchesRaiderIoKill(midnightFalls, {
        raidName: "March on Quel'Danas",
        killedAt: "2026-07-20T17:25:57.301Z"
      })
    ).toBe(false);
  });

  it.each(["Grong, the Jungle Lord", "Grong, the Revenant"])(
    "matches Raider.IO's Grong to either faction's Warcraft Logs kill (%s)",
    (bossName) => {
      expect(
        matchesRaiderIoKill(
          {
            raidSlug: "battle-of-dazaralor",
            bossSlug: "grong",
            killedAt: "2019-02-12T20:00:00.000Z"
          },
          {
            raidName: "Battle of Dazar'alor",
            bossName,
            killedAt: "2019-02-12T20:30:00.000Z"
          }
        )
      ).toBe(true);
    }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src/raid-catalogue.test.ts packages/domain/src/kill-matching.test.ts`
Expected: FAIL — `lookupRaidEncounterByRaiderIoSlugs` is not exported and `./kill-matching` does not exist.

- [ ] **Step 3: Implement**

In `packages/domain/src/raid-catalogue.ts`, after `lookupRaiderIoBoss`:

```ts
/**
 * The encounter Raider.IO names by its own raid and boss slugs: the reverse of
 * `lookupRaiderIoBoss`, for evidence that arrives from Raider.IO rather than
 * from a Warcraft Logs zone (#732).
 *
 * Raider.IO ranks some bosses the Journal lists twice as one: both faction
 * versions of Grong override to `grong`. Such a kill is shown under the one
 * the Journal lists first. Two encounters that only happen to slug alike, or
 * that sit in different raids of one Raider.IO tier, stay ambiguous and place
 * nothing.
 */
export function lookupRaidEncounterByRaiderIoSlugs(
  raidSlug: string,
  bossSlug: string
): RaidCatalogueEncounter | null {
  const matches = [...encounters.values()]
    .filter(
      (encounter) =>
        raiderIoRaidSlugs.get(encounter.raidId) === raidSlug &&
        (encounter.raiderIoBossSlug ?? raiderIoBossSlug(encounter.bossName)) ===
          bossSlug
    )
    .sort((a, b) => a.bossOrder - b.bossOrder);
  const first = matches[0];
  if (!first) return null;
  if (matches.length === 1) return first;
  return matches.every(
    (encounter) =>
      encounter.raidId === first.raidId &&
      encounter.raiderIoBossSlug === bossSlug
  )
    ? first
    : null;
}
```

Create `packages/domain/src/kill-matching.ts` (the tolerance's comment moves here from `verified-kills.ts`):

```ts
import { lookupRaiderIoBoss } from "./raid-catalogue";

/**
 * How far a Warcraft Logs kill may sit from Raider.IO's first-defeated time
 * and still be the same kill. Wider than the minutes the two usually differ
 * by, because Raider.IO can be a whole hour off: it dates Ryun's Queen Azshara
 * 19:34Z against the log's 20:34Z (1 of 36 matched pairs, measured
 * 2026-09-23). Still inside one raid night.
 *
 * Shared by collection, which uses it to skip a search the stored kill
 * already answers, and by the dossier, which uses it to lend a Raider.IO
 * logged encounter's roster to the Warcraft Logs kill it matches (#732).
 */
export const STORED_KILL_MATCH_MS = 2 * 60 * 60 * 1_000;

/**
 * Whether a Raider.IO first kill is this Warcraft Logs kill (#732): the same
 * boss, named by Raider.IO's own slugs, within `STORED_KILL_MATCH_MS`. The
 * one place the rule is written. Collection uses it to leave a matched kill's
 * rank to the Warcraft Logs lookup, and the dossier uses it to lend the
 * matched kill a roster, so the two can never disagree about a kill.
 *
 * Comparing slugs rather than catalogue ids is what lets Raider.IO's one
 * Grong match either faction's Warcraft Logs kill. Who killed it is the
 * caller's to compare: collection holds one character, and the dossier many.
 */
export function matchesRaiderIoKill(
  raiderIo: Readonly<{ raidSlug: string; bossSlug: string; killedAt: string }>,
  warcraftLogs: Readonly<{
    raidName: string;
    bossName?: string;
    killedAt: string;
  }>
): boolean {
  if (warcraftLogs.bossName === undefined) return false;
  const boss = lookupRaiderIoBoss(warcraftLogs.raidName, warcraftLogs.bossName);
  return (
    boss?.raidSlug === raiderIo.raidSlug &&
    boss.bossSlug === raiderIo.bossSlug &&
    Math.abs(
      Date.parse(warcraftLogs.killedAt) - Date.parse(raiderIo.killedAt)
    ) <= STORED_KILL_MATCH_MS
  );
}
```

In `packages/domain/src/index.ts`, add `lookupRaidEncounterByRaiderIoSlugs` to the `./raid-catalogue` export list, and:

```ts
export { matchesRaiderIoKill, STORED_KILL_MATCH_MS } from "./kill-matching";
```

In `packages/application/src/verified-kills.ts`, delete the local `STORED_KILL_MATCH_MS` constant and its comment (lines 13-21) and import it:

```ts
import {
  raiderIoRaidContentWindowEnd,
  STORED_KILL_MATCH_MS,
  supportedRegions,
  type CharacterKey
} from "@slashwho/domain";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src packages/application/src/verified-kills.test.ts`
Expected: PASS, the whole domain suite included (the existing Grong tests at `raid-catalogue.test.ts:280-296` keep both Grongs apart for Warcraft Logs; nothing here changes the forward lookups).

Run: `corepack pnpm --filter @slashwho/domain typecheck && corepack pnpm --filter @slashwho/application typecheck`
Expected: exits 0.

If the placement test fails for some other encounter, two encounters share a slug pair without an override: print them, and do not loosen the test. Report the collision.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src packages/application/src/verified-kills.ts
git commit -m "feat(domain): place Raider.IO slugs in the catalogue and share the kill match rule (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Database: logged encounters, per-run first kills, and atomic publication

**Files:**

- Create: `packages/database/drizzle/0066_raiderio_logged_kills.sql`
- Modify: `packages/database/drizzle/meta/_journal.json` (append after idx 64)
- Modify: `packages/database/src/schema.ts` (imports at 1-18; `characterEvidenceRuns` at 829-966; `characterEvidenceRunCosts`, `raiderIoRankingsRequests` at 1172; after `characterMythicWipes`)
- Modify: `packages/database/src/repositories.ts` (`CharacterEvidenceRun` 291-328, `CompletedCharacterEvidence` 515-526, `StagedEvidenceCollection` 707-760, `EvidenceRunCost.requests` 800-822, `EvidenceRepository.publish` 982-1030)
- Modify: `packages/database/src/mappers.ts` (`EvidenceRunRow` 194-222, `evidenceRunModeSql` 376-378, `mapEvidenceRun` 411-445)
- Create: `packages/database/src/evidence/raiderio-first-kills.ts`
- Modify: `packages/database/src/evidence/merge.ts`, `merge.test.ts`
- Modify: `packages/database/src/evidence/load.ts:28-115`
- Modify: `packages/database/src/evidence/repository.ts` (publish guard 734-757, inserts after 1004, `UPDATE character_evidence_runs` 1025-1086, `recordRunCost` 1879-2005, new methods)
- Modify: `packages/database/src/index.ts`
- Create: `tests/integration/repositories-raiderio-first-kills.test.ts`
- Modify: `tests/integration/migrations.test.ts` (table list 41-83, journal slice 172-221), `tests/integration/repository-fixtures.ts:31-58`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces (exported from `@slashwho/database`):

```ts
export type RaiderIoLoggedEncounterRole = "tank" | "healer" | "dps";
export interface RaiderIoLoggedEncounterMemberInput { raiderIoCharacterId: number; name: string; realm: string;
  region: string; className: string; specName: string; role: RaiderIoLoggedEncounterRole; itemLevel: number | null; }
export interface RaiderIoLoggedEncounterInput { loggedEncounterId: number; raidSlug: string; bossSlug: string;
  pulledAt: string; defeatedAt: string; durationMs: number;
  guild: { name: string; realm: string; region: string } | null;
  itemLevel: { average: number; min: number; max: number }; deathCount: number; vantusCount: number;
  rosterState: "available" | "private"; members: readonly RaiderIoLoggedEncounterMemberInput[]; }
export interface StoredRaiderIoLoggedEncounter extends RaiderIoLoggedEncounterInput { readAt: string; }
export type RaiderIoLoggedEncounterUnavailableCode = "not_found" | "private" | "schema_drift";
export interface RaiderIoLoggedEncounterUnavailableInput { loggedEncounterId: number; code: RaiderIoLoggedEncounterUnavailableCode; }
export interface StoredRaiderIoLoggedEncounterUnavailable extends RaiderIoLoggedEncounterUnavailableInput { readAt: string; }
export type RaiderIoLoggedEncounterAnswers = Readonly<{ encounters: readonly RaiderIoLoggedEncounterInput[];
  unavailable: readonly RaiderIoLoggedEncounterUnavailableInput[]; }>;
export type StoredRaiderIoLoggedEncounterAnswers = Readonly<{ encounters: readonly StoredRaiderIoLoggedEncounter[];
  unavailable: readonly StoredRaiderIoLoggedEncounterUnavailable[]; }>;
export interface PublishedRaiderIoLoggedEncounter extends StoredRaiderIoLoggedEncounter {
  roleCounts: Readonly<Record<RaiderIoLoggedEncounterRole, number>>; } // members: suppressed raiders left out
export interface CharacterRaiderIoFirstKillInput { raidSlug: string; bossSlug: string; killedAt: string;
  guild: { name: string; realm: string; region: string } | null; loggedEncounterId: number | null;
  encounterState: "read" | "unavailable"; encounterLimitationCode: string | null;
  historicWorldRank: number | null; historicRankCheckedAt: string | null; }
export interface StoredCharacterRaiderIoFirstKill extends CharacterRaiderIoFirstKillInput {
  encounter: PublishedRaiderIoLoggedEncounter | null; }
export type RaiderIoFirstKillsPublication = Readonly<{ kills: readonly CharacterRaiderIoFirstKillInput[];
  askedRaidSlugs: readonly string[]; limitationCode: string | null; }>;
// EvidenceRepository gains (optional):
saveRaiderIoLoggedEncounters?(answers: RaiderIoLoggedEncounterAnswers, readAt: Date): Promise<void>;
raiderIoLoggedEncounters?(ids: readonly number[]): Promise<StoredRaiderIoLoggedEncounterAnswers>;
storedRaiderIoFirstKills?(key: CharacterKey): Promise<readonly CharacterRaiderIoFirstKillInput[]>;
// publish input gains: raiderIoFirstKills?: RaiderIoFirstKillsPublication;
// StagedEvidenceCollection gains: raiderIoFirstKills?: RaiderIoFirstKillsPublication;
// CompletedCharacterEvidence gains: raiderIoFirstKills?: readonly StoredCharacterRaiderIoFirstKill[];
// CharacterEvidenceRun gains: raiderIoLimitationCode?: string | null; killScanSkipped?: boolean;
// EvidenceRunCost.requests gains: raiderIoLoggedEncounters?: number;
// merge.ts, also exported from the package index: export function mergeRaiderIoFirstKills(stored, input, state, targeted): CharacterRaiderIoFirstKillInput[]
```

- [ ] **Step 1: Write the failing merge tests**

Append to `packages/database/src/evidence/merge.test.ts` (add `CharacterRaiderIoFirstKillInput` to the `../repositories` type import and `mergeRaiderIoFirstKills` to the `./merge` import):

```ts
describe("mergeRaiderIoFirstKills", () => {
  function firstKill(
    raidSlug: string,
    bossSlug: string,
    overrides: Partial<CharacterRaiderIoFirstKillInput> = {}
  ): CharacterRaiderIoFirstKillInput {
    return {
      raidSlug,
      bossSlug,
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: {
        name: "Fixture Guild Alfa",
        realm: "twisting-nether",
        region: "eu"
      },
      loggedEncounterId: 700_001,
      encounterState: "read",
      encounterLimitationCode: null,
      historicWorldRank: null,
      historicRankCheckedAt: null,
      ...overrides
    };
  }
  const midnightFalls = firstKill("tier-mn-1", "midnight-falls");
  const queenAnsurek = firstKill("nerubar-palace", "queen-ansurek", {
    killedAt: "2024-10-01T20:00:00.000Z",
    loggedEncounterId: 1_234
  });
  const stored = [midnightFalls, queenAnsurek];
  const bosses = (kills: readonly CharacterRaiderIoFirstKillInput[]) =>
    kills.map((kill) => kill.bossSlug);

  it("carries every stored kill forward when the run did not read Raider.IO", () => {
    expect(
      bosses(mergeRaiderIoFirstKills(stored, undefined, "complete", false))
    ).toEqual(["queen-ansurek", "midnight-falls"]);
  });

  it.each([
    ["partial", "partial" as const, false],
    ["targeted", "complete" as const, true]
  ])(
    "carries every stored kill forward on a %s publish",
    (_name, state, targeted) => {
      expect(
        bosses(
          mergeRaiderIoFirstKills(
            stored,
            { kills: [], askedRaidSlugs: ["tier-mn-1"], limitationCode: null },
            state,
            targeted
          )
        )
      ).toEqual(["queen-ansurek", "midnight-falls"]);
    }
  );

  it("keeps on a complete publish what the run found again, and every raid it did not ask about", () => {
    // Break caught: a complete publish dropping first kills of raids whose
    // tiers the run deliberately skipped, as #592 once did to stored kills.
    expect(
      bosses(
        mergeRaiderIoFirstKills(
          stored,
          { kills: [], askedRaidSlugs: ["tier-mn-1"], limitationCode: null },
          "complete",
          false
        )
      )
    ).toEqual(["queen-ansurek"]);
  });

  it("never loses a read encounter to a later failed read", () => {
    const merged = mergeRaiderIoFirstKills(
      stored,
      {
        kills: [
          firstKill("tier-mn-1", "midnight-falls", {
            killedAt: "2026-07-20T17:25:57.000Z",
            encounterState: "unavailable",
            encounterLimitationCode: "rate_limited"
          })
        ],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: "rate_limited"
      },
      "partial",
      false
    );
    expect(merged.find((kill) => kill.bossSlug === "midnight-falls")).toEqual(
      midnightFalls
    );
  });

  it("keeps a found world rank when a later lookup has none", () => {
    const merged = mergeRaiderIoFirstKills(
      [
        firstKill("tier-mn-1", "midnight-falls", {
          historicWorldRank: 3,
          historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
        })
      ],
      {
        kills: [midnightFalls],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: null
      },
      "complete",
      false
    );
    expect(merged[0]).toMatchObject({
      historicWorldRank: 3,
      historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
    });
  });

  it("never duplicates a boss", () => {
    const merged = mergeRaiderIoFirstKills(
      stored,
      {
        kills: [midnightFalls, queenAnsurek],
        askedRaidSlugs: ["tier-mn-1", "nerubar-palace"],
        limitationCode: null
      },
      "complete",
      false
    );
    expect(bosses(merged)).toEqual(["queen-ansurek", "midnight-falls"]);
  });
});
```

- [ ] **Step 2: Run the merge tests to verify they fail**

Run: `corepack pnpm exec vitest run --project unit packages/database/src/evidence/merge.test.ts`
Expected: FAIL — `mergeRaiderIoFirstKills` is not exported and `CharacterRaiderIoFirstKillInput` does not exist.

- [ ] **Step 3: Add the types**

In `packages/database/src/repositories.ts`, after `CharacterCuttingEdgeInput`:

```ts
export type RaiderIoLoggedEncounterRole = "tank" | "healer" | "dps";

/** One raider on a Raider.IO logged encounter's roster, as stored (#732). */
export interface RaiderIoLoggedEncounterMemberInput {
  raiderIoCharacterId: number;
  name: string;
  /** The Blizzard realm slug: lower case, accents dropped, as a character key. */
  realm: string;
  region: string;
  className: string;
  specName: string;
  role: RaiderIoLoggedEncounterRole;
  /** Null when Raider.IO did not say; never zero. */
  itemLevel: number | null;
}

/**
 * Raider.IO's parsed combat log of one Mythic kill. Shared: stored once for
 * every character and run that names it. A visible roster is kept as first
 * read; a private one may be replaced by a later read. Never its uploaders,
 * never the response.
 */
export interface RaiderIoLoggedEncounterInput {
  loggedEncounterId: number;
  raidSlug: string;
  bossSlug: string;
  pulledAt: string;
  defeatedAt: string;
  durationMs: number;
  /** Null for a kill with no guild: a pug. */
  guild: { name: string; realm: string; region: string } | null;
  itemLevel: { average: number; min: number; max: number };
  deathCount: number;
  vantusCount: number;
  rosterState: "available" | "private";
  /** Empty when the roster is private. */
  members: readonly RaiderIoLoggedEncounterMemberInput[];
}

export interface StoredRaiderIoLoggedEncounter extends RaiderIoLoggedEncounterInput {
  /** ISO 8601 of the read that stored this answer. */
  readAt: string;
}

/** Raider.IO's permanent refusals of a logged encounter: a deleted log, a 403, or a log of another kill. */
export type RaiderIoLoggedEncounterUnavailableCode =
  "not_found" | "private" | "schema_drift";

/**
 * A logged encounter Raider.IO answered for permanently without one. Stored
 * so later runs do not ask again until it is due a re-read, and never over a
 * read encounter.
 */
export interface RaiderIoLoggedEncounterUnavailableInput {
  loggedEncounterId: number;
  code: RaiderIoLoggedEncounterUnavailableCode;
}

export interface StoredRaiderIoLoggedEncounterUnavailable extends RaiderIoLoggedEncounterUnavailableInput {
  readAt: string;
}

/** What one run learned about logged encounters, to store in one call. */
export type RaiderIoLoggedEncounterAnswers = Readonly<{
  encounters: readonly RaiderIoLoggedEncounterInput[];
  unavailable: readonly RaiderIoLoggedEncounterUnavailableInput[];
}>;

/** The stored answers among some ids: read encounters and permanent refusals. */
export type StoredRaiderIoLoggedEncounterAnswers = Readonly<{
  encounters: readonly StoredRaiderIoLoggedEncounter[];
  unavailable: readonly StoredRaiderIoLoggedEncounterUnavailable[];
}>;

/**
 * A stored encounter as a dossier may show it. `members` leaves out every
 * raider under an active suppression, so a removed character never appears on
 * anyone's dossier; `roleCounts` counts everyone Raider.IO listed.
 */
export interface PublishedRaiderIoLoggedEncounter extends StoredRaiderIoLoggedEncounter {
  roleCounts: Readonly<Record<RaiderIoLoggedEncounterRole, number>>;
}

/**
 * One Raider.IO Mythic first kill of the run's character, as a run publishes
 * it (#732). `read` names a stored logged encounter. `unavailable` with an id
 * and a code is an encounter not read, and why; `unavailable` with neither is
 * a kill Raider.IO holds no log of.
 */
export interface CharacterRaiderIoFirstKillInput {
  raidSlug: string;
  bossSlug: string;
  /** The logged encounter's defeat once read; until then Raider.IO's first-defeated time. */
  killedAt: string;
  /** Raider.IO's attribution from the kill list, shown only while the log is unread. */
  guild: { name: string; realm: string; region: string } | null;
  loggedEncounterId: number | null;
  encounterState: "read" | "unavailable";
  encounterLimitationCode: string | null;
  historicWorldRank: number | null;
  /** When the rank was last looked up; set with a null rank too, so a checked kill is not asked about again. */
  historicRankCheckedAt: string | null;
}

export interface StoredCharacterRaiderIoFirstKill extends CharacterRaiderIoFirstKillInput {
  /** The stored encounter a `read` row names, as a dossier may show it; null otherwise. */
  encounter: PublishedRaiderIoLoggedEncounter | null;
}

/** What one run hands storage about the character's Raider.IO first kills. */
export type RaiderIoFirstKillsPublication = Readonly<{
  kills: readonly CharacterRaiderIoFirstKillInput[];
  /**
   * The Raider.IO raids the run's kill-list requests answered for. A complete
   * publish keeps stored first kills of every other raid: the run
   * deliberately did not look there.
   */
  askedRaidSlugs: readonly string[];
  /** Why the logged-encounter phase fell short, or null. Makes a partial run explicable. */
  limitationCode: string | null;
}>;
```

Add to `CharacterEvidenceRun`:

```ts
  /** Why this run's Raider.IO logged-encounter reads fell short (#732). Absent when they did not. */
  raiderIoLimitationCode?: string | null;
  /**
   * The run published without scanning the Warcraft Logs kill history, as a
   * light or targeted run does. Absent when it scanned. A negative conclusion
   * never rests on such a run.
   */
  killScanSkipped?: boolean;
```

Add to `CompletedCharacterEvidence`:

```ts
  /** The snapshot's Raider.IO first kills, each with its stored encounter. Absent from a store that keeps none. */
  raiderIoFirstKills?: readonly StoredCharacterRaiderIoFirstKill[];
```

Add to `StagedEvidenceCollection` (after `cuttingEdges`):

```ts
  /** The run's Raider.IO first kills. Absent means the run did not read them. */
  raiderIoFirstKills?: RaiderIoFirstKillsPublication;
```

Add to `EvidenceRunCost`'s `requests`, after `raiderIoRankings?`:

```ts
    /** Raider.IO logged-encounter reads (#732). Absent is zero. */
    raiderIoLoggedEncounters?: number;
```

Add to the `publish` input of `EvidenceRepository` (after `cuttingEdges`):

```ts
      /**
       * The run's Raider.IO first kills (#732). Absent means the run did not
       * read the kill list, and every stored first kill is carried forward.
       */
      raiderIoFirstKills?: RaiderIoFirstKillsPublication;
```

and three methods to `EvidenceRepository` (after `publish`):

```ts
  /**
   * Stores what a run learned about logged encounters. Outside any snapshot
   * transaction on purpose: a reader reaches an encounter only through a
   * published run's first kills. A visible roster is never overwritten, and
   * a permanent refusal never overwrites a read.
   */
  saveRaiderIoLoggedEncounters?(
    answers: RaiderIoLoggedEncounterAnswers,
    readAt: Date
  ): Promise<void>;
  /** The stored answers among these ids, each read encounter with its whole roster. */
  raiderIoLoggedEncounters?(
    ids: readonly number[]
  ): Promise<StoredRaiderIoLoggedEncounterAnswers>;
  /** The first kills of the character's newest publication. */
  storedRaiderIoFirstKills?(
    key: CharacterKey
  ): Promise<readonly CharacterRaiderIoFirstKillInput[]>;
```

In `packages/database/src/index.ts`, add to the type export list: `CharacterRaiderIoFirstKillInput`, `PublishedRaiderIoLoggedEncounter`, `RaiderIoFirstKillsPublication`, `RaiderIoLoggedEncounterAnswers`, `RaiderIoLoggedEncounterInput`, `RaiderIoLoggedEncounterMemberInput`, `RaiderIoLoggedEncounterRole`, `RaiderIoLoggedEncounterUnavailableCode`, `RaiderIoLoggedEncounterUnavailableInput`, `StoredCharacterRaiderIoFirstKill`, `StoredRaiderIoLoggedEncounter`, `StoredRaiderIoLoggedEncounterAnswers`, `StoredRaiderIoLoggedEncounterUnavailable`. Add the value export (a pure function, so the application's handler test can apply the rule storage applies):

```ts
export { mergeRaiderIoFirstKills } from "./evidence/merge";
```

- [ ] **Step 4: Implement the merge**

Append to `packages/database/src/evidence/merge.ts` (add `CharacterRaiderIoFirstKillInput` and `RaiderIoFirstKillsPublication` to the `../repositories` import):

```ts
const firstKillKey = (kill: CharacterRaiderIoFirstKillInput) =>
  `${kill.raidSlug}\0${kill.bossSlug}`;

function mergeFirstKill(
  previous: CharacterRaiderIoFirstKillInput,
  incoming: CharacterRaiderIoFirstKillInput
): CharacterRaiderIoFirstKillInput {
  // A logged encounter never changes, so one already read is never lost to a
  // later read that failed.
  const keepRead =
    previous.encounterState === "read" &&
    incoming.encounterState !== "read" &&
    previous.loggedEncounterId === incoming.loggedEncounterId;
  return {
    ...incoming,
    ...(keepRead
      ? {
          killedAt: previous.killedAt,
          encounterState: "read" as const,
          encounterLimitationCode: null
        }
      : {}),
    historicWorldRank: incoming.historicWorldRank ?? previous.historicWorldRank,
    historicRankCheckedAt:
      incoming.historicRankCheckedAt ?? previous.historicRankCheckedAt
  };
}

/**
 * The Raider.IO first kills one publish writes: the character's whole set,
 * merged. The rules follow `mergePublishedEvidence`: a run that did not read
 * the kill list, a partial run and a targeted one carry everything forward; a
 * complete one keeps what it found again plus every raid it did not ask
 * about. A Raider.IO first kill never touches a Warcraft Logs kill.
 */
export function mergeRaiderIoFirstKills(
  stored: readonly CharacterRaiderIoFirstKillInput[],
  input: RaiderIoFirstKillsPublication | undefined,
  state: "complete" | "partial",
  targeted: boolean
): CharacterRaiderIoFirstKillInput[] {
  const merged = new Map<string, CharacterRaiderIoFirstKillInput>();
  const asked = new Set(input?.askedRaidSlugs ?? []);
  for (const kill of stored) {
    const carried =
      input === undefined ||
      targeted ||
      state === "partial" ||
      !asked.has(kill.raidSlug);
    if (carried) merged.set(firstKillKey(kill), kill);
  }
  if (input !== undefined && !targeted) {
    const previous = new Map(stored.map((kill) => [firstKillKey(kill), kill]));
    for (const kill of input.kills) {
      const before = previous.get(firstKillKey(kill));
      merged.set(
        firstKillKey(kill),
        before === undefined ? kill : mergeFirstKill(before, kill)
      );
    }
  }
  return [...merged.values()].sort(
    (a, b) =>
      a.killedAt.localeCompare(b.killedAt) ||
      firstKillKey(a).localeCompare(firstKillKey(b))
  );
}
```

- [ ] **Step 5: Run the merge tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/database/src/evidence/merge.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the migration**

Create `packages/database/drizzle/0066_raiderio_logged_kills.sql`:

```sql
-- Raider.IO-logged first kills (#732).
--
-- A logged encounter is stored once and shared by every character and run
-- that names it. It is written outside the snapshot transaction; a reader
-- reaches one only through a published run's first kills, which are written
-- in the same transaction as the run's other evidence. The uploaders
-- (`log.sources`) and the raw response are never stored.
--
-- A row is one of two answers. A read carries the kill: a visible roster is
-- kept as first read, and a private one may be replaced by a later read. An
-- unavailable row is a permanent refusal (a deleted log, a 403, or a log of
-- another kill) with only its code, so later runs do not ask again until it
-- is due a re-read. `read_at` dates either answer.
CREATE TABLE "raiderio_logged_encounters" (
	"logged_encounter_id" bigint PRIMARY KEY NOT NULL,
	"unavailable_code" text,
	"raid_slug" text,
	"boss_slug" text,
	"pulled_at" timestamp with time zone,
	"defeated_at" timestamp with time zone,
	"duration_ms" integer,
	"guild_name" text,
	"guild_realm" text,
	"guild_region" text,
	"item_level_average" double precision,
	"item_level_min" double precision,
	"item_level_max" double precision,
	"death_count" integer,
	"vantus_count" integer,
	"roster_state" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "raiderio_logged_encounters_answer_check" CHECK (("unavailable_code" IS NULL AND "raid_slug" IS NOT NULL AND "boss_slug" IS NOT NULL AND "pulled_at" IS NOT NULL AND "defeated_at" IS NOT NULL AND "duration_ms" IS NOT NULL AND "item_level_average" IS NOT NULL AND "item_level_min" IS NOT NULL AND "item_level_max" IS NOT NULL AND "death_count" IS NOT NULL AND "vantus_count" IS NOT NULL AND "roster_state" IS NOT NULL) OR ("unavailable_code" IN ('not_found', 'private', 'schema_drift') AND "raid_slug" IS NULL AND "boss_slug" IS NULL AND "pulled_at" IS NULL AND "defeated_at" IS NULL AND "duration_ms" IS NULL AND "guild_name" IS NULL AND "item_level_average" IS NULL AND "item_level_min" IS NULL AND "item_level_max" IS NULL AND "death_count" IS NULL AND "vantus_count" IS NULL AND "roster_state" IS NULL)),
	CONSTRAINT "raiderio_logged_encounters_roster_state_check" CHECK ("roster_state" IS NULL OR "roster_state" IN ('available', 'private')),
	CONSTRAINT "raiderio_logged_encounters_guild_identity_check" CHECK (("guild_name" IS NULL AND "guild_realm" IS NULL AND "guild_region" IS NULL) OR ("guild_name" IS NOT NULL AND "guild_realm" IS NOT NULL AND "guild_region" IS NOT NULL)),
	CONSTRAINT "raiderio_logged_encounters_counts_check" CHECK ("duration_ms" >= 0 AND "death_count" >= 0 AND "vantus_count" >= 0)
);
--> statement-breakpoint
-- One row per raider. `realm` is the Blizzard realm slug and
-- `normalized_name` the lower-cased name, so a member is keyed exactly as a
-- `suppressed_characters` row is, and a removed raider is left off every
-- dossier's roster when it is read. The rows are kept on removal.
CREATE TABLE "raiderio_logged_encounter_members" (
	"logged_encounter_id" bigint NOT NULL,
	"raiderio_character_id" bigint NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"realm" text NOT NULL,
	"region" text NOT NULL,
	"class_name" text NOT NULL,
	"spec_name" text NOT NULL,
	"role" text NOT NULL,
	"item_level" double precision,
	CONSTRAINT "raiderio_logged_encounter_members_pk" PRIMARY KEY("logged_encounter_id","raiderio_character_id"),
	CONSTRAINT "raiderio_logged_encounter_members_role_check" CHECK ("role" IN ('tank', 'healer', 'dps'))
);
--> statement-breakpoint
ALTER TABLE "raiderio_logged_encounter_members" ADD CONSTRAINT "raiderio_logged_encounter_members_encounter_fk" FOREIGN KEY ("logged_encounter_id") REFERENCES "public"."raiderio_logged_encounters"("logged_encounter_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "character_raiderio_first_kills" (
	"evidence_run_id" uuid NOT NULL,
	"raid_slug" text NOT NULL,
	"boss_slug" text NOT NULL,
	"killed_at" timestamp with time zone NOT NULL,
	"guild_name" text,
	"guild_realm" text,
	"guild_region" text,
	"logged_encounter_id" bigint,
	"encounter_state" text NOT NULL,
	"encounter_limitation_code" text,
	"historic_world_rank" integer,
	"historic_rank_checked_at" timestamp with time zone,
	CONSTRAINT "character_raiderio_first_kills_pk" PRIMARY KEY("evidence_run_id","raid_slug","boss_slug"),
	CONSTRAINT "character_raiderio_first_kills_encounter_state_check" CHECK (("encounter_state" = 'read' AND "logged_encounter_id" IS NOT NULL AND "encounter_limitation_code" IS NULL) OR ("encounter_state" = 'unavailable' AND (("logged_encounter_id" IS NULL AND "encounter_limitation_code" IS NULL) OR ("logged_encounter_id" IS NOT NULL AND "encounter_limitation_code" IS NOT NULL)))),
	CONSTRAINT "character_raiderio_first_kills_guild_identity_check" CHECK (("guild_name" IS NULL AND "guild_realm" IS NULL AND "guild_region" IS NULL) OR ("guild_name" IS NOT NULL AND "guild_realm" IS NOT NULL AND "guild_region" IS NOT NULL)),
	CONSTRAINT "character_raiderio_first_kills_historic_world_rank_check" CHECK ("historic_world_rank" IS NULL OR "historic_world_rank" > 0)
);
--> statement-breakpoint
ALTER TABLE "character_raiderio_first_kills" ADD CONSTRAINT "character_raiderio_first_kills_evidence_run_id_character_evidence_runs_id_fk" FOREIGN KEY ("evidence_run_id") REFERENCES "public"."character_evidence_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- A fourth way for a run to be partial: its Raider.IO logged-encounter reads
-- fell short. The completion check encodes "a partial run must name a
-- shortfall" and is widened again, as 0022 and 0031 widened it.
ALTER TABLE "character_evidence_runs" ADD COLUMN "raiderio_limitation_code" text;
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  DROP CONSTRAINT "character_evidence_runs_completion_limitations_check";
--> statement-breakpoint
ALTER TABLE "character_evidence_runs"
  ADD CONSTRAINT "character_evidence_runs_completion_limitations_check" CHECK (("character_evidence_runs"."status" = 'complete' AND "character_evidence_runs"."limitation_code" IS NULL) OR ("character_evidence_runs"."status" = 'partial' AND ("character_evidence_runs"."limitation_code" IS NOT NULL OR "character_evidence_runs"."parse_limitation_code" IS NOT NULL OR "character_evidence_runs"."kill_scan_skipped" OR "character_evidence_runs"."raiderio_limitation_code" IS NOT NULL)) OR "character_evidence_runs"."status" NOT IN ('complete', 'partial'));
--> statement-breakpoint
-- What the new phase costs, beside the other Raider.IO requests (#298).
ALTER TABLE "character_evidence_run_costs"
  ADD COLUMN "raiderio_logged_encounter_requests" integer DEFAULT 0 NOT NULL;
```

Append to `packages/database/drizzle/meta/_journal.json` `entries` (the previous `when` is 1792011600016, later than now, so `when` is previous + 1):

```json
{
  "idx": 65,
  "version": "7",
  "when": 1792011600017,
  "tag": "0066_raiderio_logged_kills",
  "breakpoints": true
}
```

- [ ] **Step 7: Describe the tables in `schema.ts`**

Add `bigint` to the `drizzle-orm/pg-core` import. In `characterEvidenceRuns`, after `killScanSkipped`:

```ts
    // A fourth way to be partial (#732): the run's Raider.IO logged-encounter
    // reads fell short. Null for a run whose reads did not.
    raiderIoLimitationCode: text("raiderio_limitation_code"),
```

and replace the completion check's second argument (the `sql` template inside `check("character_evidence_runs_completion_limitations_check", ...)`) with:

<!-- prettier-ignore -->
```ts
      sql`(${table.status} = 'complete' AND ${table.limitationCode} IS NULL) OR (${table.status} = 'partial' AND (${table.limitationCode} IS NOT NULL OR ${table.parseLimitationCode} IS NOT NULL OR ${table.killScanSkipped} OR ${table.raiderIoLimitationCode} IS NOT NULL)) OR ${table.status} NOT IN ('complete', 'partial')`
```

(and add "or its Raider.IO logged-encounter reads" to the comment above it). In `characterEvidenceRunCosts`, after `raiderIoRankingsRequests`:

```ts
    /** Raider.IO logged-encounter reads (#732). Zero on a run that read none. */
    raiderIoLoggedEncounterRequests: integer(
      "raiderio_logged_encounter_requests"
    )
      .default(0)
      .notNull(),
```

and extend the comment above `raiderIoHistoricRequests` with: "`raiderio_historic_requests` also counts the one character profile read the logged-encounter phase may make to learn the character's Raider.IO id (#732)." After `characterMythicWipes`, add:

```ts
/**
 * Raider.IO's answer about one logged encounter (#732): a read kill, or a
 * permanent refusal with only its code. Shared across characters and runs; a
 * reader reaches it only through a published run's
 * `character_raiderio_first_kills`.
 */
export const raiderIoLoggedEncounters = pgTable(
  "raiderio_logged_encounters",
  {
    loggedEncounterId: bigint("logged_encounter_id", { mode: "number" })
      .primaryKey()
      .notNull(),
    unavailableCode: text("unavailable_code"),
    raidSlug: text("raid_slug"),
    bossSlug: text("boss_slug"),
    pulledAt: timestamp("pulled_at", { withTimezone: true }),
    defeatedAt: timestamp("defeated_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    guildName: text("guild_name"),
    guildRealm: text("guild_realm"),
    guildRegion: text("guild_region"),
    itemLevelAverage: doublePrecision("item_level_average"),
    itemLevelMin: doublePrecision("item_level_min"),
    itemLevelMax: doublePrecision("item_level_max"),
    deathCount: integer("death_count"),
    vantusCount: integer("vantus_count"),
    rosterState: text("roster_state"),
    readAt: timestamp("read_at", { withTimezone: true }).notNull()
  },
  (table) => [
    check(
      "raiderio_logged_encounters_answer_check",
      sql`(${table.unavailableCode} IS NULL AND ${table.raidSlug} IS NOT NULL AND ${table.bossSlug} IS NOT NULL AND ${table.pulledAt} IS NOT NULL AND ${table.defeatedAt} IS NOT NULL AND ${table.durationMs} IS NOT NULL AND ${table.itemLevelAverage} IS NOT NULL AND ${table.itemLevelMin} IS NOT NULL AND ${table.itemLevelMax} IS NOT NULL AND ${table.deathCount} IS NOT NULL AND ${table.vantusCount} IS NOT NULL AND ${table.rosterState} IS NOT NULL) OR (${table.unavailableCode} IN ('not_found', 'private', 'schema_drift') AND ${table.raidSlug} IS NULL AND ${table.bossSlug} IS NULL AND ${table.pulledAt} IS NULL AND ${table.defeatedAt} IS NULL AND ${table.durationMs} IS NULL AND ${table.guildName} IS NULL AND ${table.itemLevelAverage} IS NULL AND ${table.itemLevelMin} IS NULL AND ${table.itemLevelMax} IS NULL AND ${table.deathCount} IS NULL AND ${table.vantusCount} IS NULL AND ${table.rosterState} IS NULL)`
    ),
    check(
      "raiderio_logged_encounters_roster_state_check",
      sql`${table.rosterState} IS NULL OR ${table.rosterState} IN ('available', 'private')`
    ),
    check(
      "raiderio_logged_encounters_guild_identity_check",
      sql`(${table.guildName} IS NULL AND ${table.guildRealm} IS NULL AND ${table.guildRegion} IS NULL) OR (${table.guildName} IS NOT NULL AND ${table.guildRealm} IS NOT NULL AND ${table.guildRegion} IS NOT NULL)`
    ),
    check(
      "raiderio_logged_encounters_counts_check",
      sql`${table.durationMs} >= 0 AND ${table.deathCount} >= 0 AND ${table.vantusCount} >= 0`
    )
  ]
);

export const raiderIoLoggedEncounterMembers = pgTable(
  "raiderio_logged_encounter_members",
  {
    loggedEncounterId: bigint("logged_encounter_id", { mode: "number" })
      .notNull()
      .references(() => raiderIoLoggedEncounters.loggedEncounterId, {
        onDelete: "cascade"
      }),
    raiderIoCharacterId: bigint("raiderio_character_id", {
      mode: "number"
    }).notNull(),
    name: text("name").notNull(),
    // Keyed as `suppressed_characters` is, so a removed raider is left off.
    normalizedName: text("normalized_name").notNull(),
    realm: text("realm").notNull(),
    region: text("region").notNull(),
    className: text("class_name").notNull(),
    specName: text("spec_name").notNull(),
    role: text("role").notNull(),
    itemLevel: doublePrecision("item_level")
  },
  (table) => [
    primaryKey({
      name: "raiderio_logged_encounter_members_pk",
      columns: [table.loggedEncounterId, table.raiderIoCharacterId]
    }),
    check(
      "raiderio_logged_encounter_members_role_check",
      sql`${table.role} IN ('tank', 'healer', 'dps')`
    )
  ]
);

/** One run's Raider.IO first kills, part of its snapshot (#732). */
export const characterRaiderIoFirstKills = pgTable(
  "character_raiderio_first_kills",
  {
    evidenceRunId: uuid("evidence_run_id")
      .notNull()
      .references(() => characterEvidenceRuns.id, { onDelete: "cascade" }),
    raidSlug: text("raid_slug").notNull(),
    bossSlug: text("boss_slug").notNull(),
    killedAt: timestamp("killed_at", { withTimezone: true }).notNull(),
    guildName: text("guild_name"),
    guildRealm: text("guild_realm"),
    guildRegion: text("guild_region"),
    loggedEncounterId: bigint("logged_encounter_id", { mode: "number" }),
    encounterState: text("encounter_state").notNull(),
    encounterLimitationCode: text("encounter_limitation_code"),
    historicWorldRank: integer("historic_world_rank"),
    historicRankCheckedAt: timestamp("historic_rank_checked_at", {
      withTimezone: true
    })
  },
  (table) => [
    primaryKey({
      name: "character_raiderio_first_kills_pk",
      columns: [table.evidenceRunId, table.raidSlug, table.bossSlug]
    }),
    check(
      "character_raiderio_first_kills_encounter_state_check",
      sql`(${table.encounterState} = 'read' AND ${table.loggedEncounterId} IS NOT NULL AND ${table.encounterLimitationCode} IS NULL) OR (${table.encounterState} = 'unavailable' AND ((${table.loggedEncounterId} IS NULL AND ${table.encounterLimitationCode} IS NULL) OR (${table.loggedEncounterId} IS NOT NULL AND ${table.encounterLimitationCode} IS NOT NULL)))`
    ),
    check(
      "character_raiderio_first_kills_guild_identity_check",
      sql`(${table.guildName} IS NULL AND ${table.guildRealm} IS NULL AND ${table.guildRegion} IS NULL) OR (${table.guildName} IS NOT NULL AND ${table.guildRealm} IS NOT NULL AND ${table.guildRegion} IS NOT NULL)`
    ),
    check(
      "character_raiderio_first_kills_historic_world_rank_check",
      sql`${table.historicWorldRank} IS NULL OR ${table.historicWorldRank} > 0`
    )
  ]
);
```

- [ ] **Step 8: Carry the run's Raider.IO limitation and skipped scan through the mapper**

In `packages/database/src/mappers.ts`, add to `EvidenceRunRow`:

```ts
  raiderio_limitation_code?: string | null;
  kill_scan_skipped?: boolean;
```

change `evidenceRunModeSql` to select both:

```ts
return `${alias}.mode, ${alias}.origin, ${alias}.tier_search_raid_id, ${alias}.omitted_invalid_timestamp, ${alias}.parse_limitation_codes_seen, ${alias}.light_refresh, ${alias}.raiderio_limitation_code, ${alias}.kill_scan_skipped`;
```

and add to `mapEvidenceRun`, after the `lightRefresh` spread:

```ts
    ...(row.raiderio_limitation_code
      ? { raiderIoLimitationCode: row.raiderio_limitation_code }
      : {}),
    ...(row.kill_scan_skipped ? { killScanSkipped: true } : {}),
```

- [ ] **Step 9: Write the storage module**

Create `packages/database/src/evidence/raiderio-first-kills.ts`:

```ts
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";

import type {
  CharacterRaiderIoFirstKillInput,
  PublishedRaiderIoLoggedEncounter,
  RaiderIoLoggedEncounterAnswers,
  RaiderIoLoggedEncounterRole,
  RaiderIoLoggedEncounterUnavailableCode,
  StoredCharacterRaiderIoFirstKill,
  StoredRaiderIoLoggedEncounter,
  StoredRaiderIoLoggedEncounterAnswers
} from "../repositories";
import { withTransaction, type Queryable } from "../sql";
import { insertEvidenceRows } from "./rows";

// `bigint` columns arrive from `pg` as text; every id here is far below 2^53.
type FirstKillRow = {
  raid_slug: string;
  boss_slug: string;
  killed_at: Date;
  guild_name: string | null;
  guild_realm: string | null;
  guild_region: string | null;
  logged_encounter_id: string | null;
  encounter_state: "read" | "unavailable";
  encounter_limitation_code: string | null;
  historic_world_rank: number | null;
  historic_rank_checked_at: Date | null;
};

// A read row carries every kill column and an unavailable row only its code;
// `raiderio_logged_encounters_answer_check` guarantees one or the other.
type EncounterRow = {
  logged_encounter_id: string;
  unavailable_code: RaiderIoLoggedEncounterUnavailableCode | null;
  raid_slug: string | null;
  boss_slug: string | null;
  pulled_at: Date | null;
  defeated_at: Date | null;
  duration_ms: number | null;
  guild_name: string | null;
  guild_realm: string | null;
  guild_region: string | null;
  item_level_average: number | null;
  item_level_min: number | null;
  item_level_max: number | null;
  death_count: number | null;
  vantus_count: number | null;
  roster_state: "available" | "private" | null;
  read_at: Date;
};

type MemberRow = {
  logged_encounter_id: string;
  raiderio_character_id: string;
  name: string;
  realm: string;
  region: string;
  class_name: string;
  spec_name: string;
  role: RaiderIoLoggedEncounterRole;
  item_level: number | null;
};

type RoleCountRow = {
  logged_encounter_id: string;
  role: RaiderIoLoggedEncounterRole;
  count: number;
};

function guildOf(
  name: string | null,
  realm: string | null,
  region: string | null
): { name: string; realm: string; region: string } | null {
  return name === null || realm === null || region === null
    ? null
    : { name, realm, region };
}

function required<T>(value: T | null): T {
  // The answer check makes every kill column of a read row NOT NULL.
  if (value === null) throw new Error("raiderio_logged_encounter_row_invalid");
  return value;
}

function mapFirstKill(row: FirstKillRow): CharacterRaiderIoFirstKillInput {
  return {
    raidSlug: row.raid_slug,
    bossSlug: row.boss_slug,
    killedAt: row.killed_at.toISOString(),
    guild: guildOf(row.guild_name, row.guild_realm, row.guild_region),
    loggedEncounterId:
      row.logged_encounter_id === null ? null : Number(row.logged_encounter_id),
    encounterState: row.encounter_state,
    encounterLimitationCode: row.encounter_limitation_code,
    historicWorldRank: row.historic_world_rank,
    historicRankCheckedAt: row.historic_rank_checked_at?.toISOString() ?? null
  };
}

async function loadRunRaiderIoFirstKills(
  client: Queryable,
  runId: string
): Promise<CharacterRaiderIoFirstKillInput[]> {
  const result = await client.query<FirstKillRow>(
    `SELECT raid_slug, boss_slug, killed_at, guild_name, guild_realm,
            guild_region, logged_encounter_id, encounter_state,
            encounter_limitation_code, historic_world_rank,
            historic_rank_checked_at
       FROM character_raiderio_first_kills
      WHERE evidence_run_id = $1
      ORDER BY killed_at, raid_slug, boss_slug`,
    [runId]
  );
  return result.rows.map(mapFirstKill);
}

/**
 * The first kills of the character's newest publication. Every publish writes
 * the whole merged set, so the newest run holds all of it; the tie is broken
 * as `loadCompletedEvidence` breaks it, so this is the run a dossier shows.
 */
export async function loadLatestRaiderIoFirstKills(
  client: Queryable,
  key: CharacterKey
): Promise<CharacterRaiderIoFirstKillInput[]> {
  const run = await client.query<{ id: string }>(
    `SELECT id
       FROM character_evidence_runs
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        AND status IN ('complete', 'partial')
      ORDER BY completed_at DESC, id DESC
      LIMIT 1`,
    [key.region, key.realm, key.name]
  );
  const runId = run.rows[0]?.id;
  return runId === undefined ? [] : loadRunRaiderIoFirstKills(client, runId);
}

async function selectEncounterRows(
  client: Queryable,
  ids: readonly number[]
): Promise<EncounterRow[]> {
  const result = await client.query<EncounterRow>(
    `SELECT logged_encounter_id, unavailable_code, raid_slug, boss_slug,
            pulled_at, defeated_at, duration_ms, guild_name, guild_realm,
            guild_region, item_level_average, item_level_min, item_level_max,
            death_count, vantus_count, roster_state, read_at
       FROM raiderio_logged_encounters
      WHERE logged_encounter_id = ANY($1::bigint[])
      ORDER BY logged_encounter_id`,
    [ids]
  );
  return result.rows;
}

/**
 * The roster rows of these encounters. With `shownOnly`, a raider under an
 * active suppression is left out by the same test `snapshots.ts` applies to
 * a dossier's own characters, so a removed character never appears on anyone
 * else's dossier. The rows themselves are kept.
 */
async function selectMemberRows(
  client: Queryable,
  ids: readonly number[],
  shownOnly: boolean
): Promise<Map<string, MemberRow[]>> {
  const result = await client.query<MemberRow>(
    `SELECT member.logged_encounter_id, member.raiderio_character_id,
            member.name, member.realm, member.region, member.class_name,
            member.spec_name, member.role, member.item_level
       FROM raiderio_logged_encounter_members member
      WHERE member.logged_encounter_id = ANY($1::bigint[])
        AND (NOT $2::boolean OR NOT EXISTS (
          SELECT 1
            FROM suppressed_characters suppression
           WHERE suppression.region = member.region
             AND suppression.realm_slug = member.realm
             AND suppression.normalized_name = member.normalized_name
             AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
        ))
      ORDER BY member.logged_encounter_id, member.raiderio_character_id`,
    [ids, shownOnly]
  );
  const byEncounter = new Map<string, MemberRow[]>();
  for (const member of result.rows) {
    byEncounter.set(member.logged_encounter_id, [
      ...(byEncounter.get(member.logged_encounter_id) ?? []),
      member
    ]);
  }
  return byEncounter;
}

function mapEncounter(
  row: EncounterRow,
  members: readonly MemberRow[]
): StoredRaiderIoLoggedEncounter {
  return {
    loggedEncounterId: Number(row.logged_encounter_id),
    raidSlug: required(row.raid_slug),
    bossSlug: required(row.boss_slug),
    pulledAt: required(row.pulled_at).toISOString(),
    defeatedAt: required(row.defeated_at).toISOString(),
    durationMs: required(row.duration_ms),
    guild: guildOf(row.guild_name, row.guild_realm, row.guild_region),
    itemLevel: {
      average: required(row.item_level_average),
      min: required(row.item_level_min),
      max: required(row.item_level_max)
    },
    deathCount: required(row.death_count),
    vantusCount: required(row.vantus_count),
    rosterState: required(row.roster_state),
    members: members.map((member) => ({
      raiderIoCharacterId: Number(member.raiderio_character_id),
      name: member.name,
      realm: member.realm,
      region: member.region,
      className: member.class_name,
      specName: member.spec_name,
      role: member.role,
      itemLevel: member.item_level
    })),
    readAt: row.read_at.toISOString()
  };
}

/**
 * The stored answers among these ids, for collection: each read encounter
 * with its whole roster (the presence check needs every raider and shows
 * none), and each permanent refusal with its code.
 */
export async function loadRaiderIoLoggedEncounters(
  client: Queryable,
  ids: readonly number[]
): Promise<StoredRaiderIoLoggedEncounterAnswers> {
  if (ids.length === 0) return { encounters: [], unavailable: [] };
  const rows = await selectEncounterRows(client, ids);
  const members = await selectMemberRows(client, ids, false);
  return {
    encounters: rows
      .filter((row) => row.unavailable_code === null)
      .map((row) =>
        mapEncounter(row, members.get(row.logged_encounter_id) ?? [])
      ),
    unavailable: rows.flatMap((row) =>
      row.unavailable_code === null
        ? []
        : [
            {
              loggedEncounterId: Number(row.logged_encounter_id),
              code: row.unavailable_code,
              readAt: row.read_at.toISOString()
            }
          ]
    )
  };
}

/**
 * The read encounters among these ids as a dossier may show them: suppressed
 * raiders left off, and every raider Raider.IO listed still counted by role.
 */
async function loadShownRaiderIoLoggedEncounters(
  client: Queryable,
  ids: readonly number[]
): Promise<PublishedRaiderIoLoggedEncounter[]> {
  if (ids.length === 0) return [];
  const rows = (await selectEncounterRows(client, ids)).filter(
    (row) => row.unavailable_code === null
  );
  const members = await selectMemberRows(client, ids, true);
  const counted = await client.query<RoleCountRow>(
    `SELECT logged_encounter_id, role, count(*)::int AS count
       FROM raiderio_logged_encounter_members
      WHERE logged_encounter_id = ANY($1::bigint[])
      GROUP BY logged_encounter_id, role`,
    [ids]
  );
  const roleCounts = new Map<
    string,
    Record<RaiderIoLoggedEncounterRole, number>
  >();
  for (const row of counted.rows) {
    const counts = roleCounts.get(row.logged_encounter_id) ?? {
      tank: 0,
      healer: 0,
      dps: 0
    };
    counts[row.role] = row.count;
    roleCounts.set(row.logged_encounter_id, counts);
  }
  return rows.map((row) => ({
    ...mapEncounter(row, members.get(row.logged_encounter_id) ?? []),
    roleCounts: roleCounts.get(row.logged_encounter_id) ?? {
      tank: 0,
      healer: 0,
      dps: 0
    }
  }));
}

/** One run's first kills, each with the stored encounter it names, as a dossier may show it. */
export async function loadPublishedRaiderIoFirstKills(
  client: Queryable,
  runId: string
): Promise<StoredCharacterRaiderIoFirstKill[]> {
  const kills = await loadRunRaiderIoFirstKills(client, runId);
  const readIds = kills.flatMap((kill) =>
    kill.encounterState === "read" && kill.loggedEncounterId !== null
      ? [kill.loggedEncounterId]
      : []
  );
  const encounters = new Map(
    (await loadShownRaiderIoLoggedEncounters(client, readIds)).map(
      (encounter) => [encounter.loggedEncounterId, encounter] as const
    )
  );
  return kills.map((kill) => ({
    ...kill,
    encounter:
      kill.encounterState === "read" && kill.loggedEncounterId !== null
        ? (encounters.get(kill.loggedEncounterId) ?? null)
        : null
  }));
}

/**
 * Stores what one run learned, in one transaction. A visible roster is kept
 * as first read: the kill and who was in it never change. A private roster
 * or a permanent refusal is replaced by a later read. A permanent refusal
 * replaces only another refusal, never a read: a later failure does not
 * unread a kill.
 */
export async function storeRaiderIoLoggedEncounters(
  pool: Pool,
  answers: RaiderIoLoggedEncounterAnswers,
  readAt: Date
): Promise<void> {
  if (answers.encounters.length === 0 && answers.unavailable.length === 0)
    return;
  await withTransaction(pool, async (client) => {
    for (const encounter of answers.encounters) {
      const written = await client.query(
        `INSERT INTO raiderio_logged_encounters (
           logged_encounter_id, unavailable_code, raid_slug, boss_slug,
           pulled_at, defeated_at, duration_ms, guild_name, guild_realm,
           guild_region, item_level_average, item_level_min, item_level_max,
           death_count, vantus_count, roster_state, read_at
         ) VALUES ($1::bigint, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, $14, $15, $16)
         ON CONFLICT (logged_encounter_id) DO UPDATE SET
           unavailable_code = NULL,
           raid_slug = EXCLUDED.raid_slug,
           boss_slug = EXCLUDED.boss_slug,
           pulled_at = EXCLUDED.pulled_at,
           defeated_at = EXCLUDED.defeated_at,
           duration_ms = EXCLUDED.duration_ms,
           guild_name = EXCLUDED.guild_name,
           guild_realm = EXCLUDED.guild_realm,
           guild_region = EXCLUDED.guild_region,
           item_level_average = EXCLUDED.item_level_average,
           item_level_min = EXCLUDED.item_level_min,
           item_level_max = EXCLUDED.item_level_max,
           death_count = EXCLUDED.death_count,
           vantus_count = EXCLUDED.vantus_count,
           roster_state = EXCLUDED.roster_state,
           read_at = EXCLUDED.read_at
         WHERE raiderio_logged_encounters.roster_state IS DISTINCT FROM 'available'`,
        [
          encounter.loggedEncounterId,
          encounter.raidSlug,
          encounter.bossSlug,
          encounter.pulledAt,
          encounter.defeatedAt,
          encounter.durationMs,
          encounter.guild?.name ?? null,
          encounter.guild?.realm ?? null,
          encounter.guild?.region ?? null,
          encounter.itemLevel.average,
          encounter.itemLevel.min,
          encounter.itemLevel.max,
          encounter.deathCount,
          encounter.vantusCount,
          encounter.rosterState,
          readAt
        ]
      );
      // A visible roster already held: nothing was written, nothing changes.
      if (written.rowCount !== 1) continue;
      await client.query(
        `DELETE FROM raiderio_logged_encounter_members
          WHERE logged_encounter_id = $1::bigint`,
        [encounter.loggedEncounterId]
      );
      const members = encounter.members;
      if (members.length === 0) continue;
      await client.query(
        `INSERT INTO raiderio_logged_encounter_members (
           logged_encounter_id, raiderio_character_id, name, normalized_name,
           realm, region, class_name, spec_name, role, item_level
         )
         SELECT $1::bigint, item.*
           FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[],
                       $6::text[], $7::text[], $8::text[], $9::text[],
                       $10::double precision[])
             AS item(raiderio_character_id, name, normalized_name, realm,
                     region, class_name, spec_name, role, item_level)
         ON CONFLICT DO NOTHING`,
        [
          encounter.loggedEncounterId,
          members.map((member) => member.raiderIoCharacterId),
          members.map((member) => member.name),
          // As every character key and every suppression is normalised.
          members.map((member) => member.name.toLocaleLowerCase("en-US")),
          members.map((member) => member.realm),
          members.map((member) => member.region),
          members.map((member) => member.className),
          members.map((member) => member.specName),
          members.map((member) => member.role),
          members.map((member) => member.itemLevel)
        ]
      );
    }
    for (const answer of answers.unavailable) {
      await client.query(
        `INSERT INTO raiderio_logged_encounters (
           logged_encounter_id, unavailable_code, read_at
         ) VALUES ($1::bigint, $2, $3)
         ON CONFLICT (logged_encounter_id) DO UPDATE SET
           unavailable_code = EXCLUDED.unavailable_code,
           read_at = EXCLUDED.read_at
         WHERE raiderio_logged_encounters.unavailable_code IS NOT NULL`,
        [answer.loggedEncounterId, answer.code, readAt]
      );
    }
  });
}

/** One run's first kills, in one statement, inside the publish transaction. */
export async function insertRaiderIoFirstKills(
  client: Queryable,
  runId: string,
  kills: readonly CharacterRaiderIoFirstKillInput[]
): Promise<void> {
  await insertEvidenceRows(
    client,
    "character_raiderio_first_kills",
    runId,
    [
      ["raid_slug", "text", (kill) => kill.raidSlug],
      ["boss_slug", "text", (kill) => kill.bossSlug],
      ["killed_at", "timestamptz", (kill) => kill.killedAt],
      ["guild_name", "text", (kill) => kill.guild?.name ?? null],
      ["guild_realm", "text", (kill) => kill.guild?.realm ?? null],
      ["guild_region", "text", (kill) => kill.guild?.region ?? null],
      ["logged_encounter_id", "bigint", (kill) => kill.loggedEncounterId],
      ["encounter_state", "text", (kill) => kill.encounterState],
      [
        "encounter_limitation_code",
        "text",
        (kill) => kill.encounterLimitationCode
      ],
      ["historic_world_rank", "integer", (kill) => kill.historicWorldRank],
      [
        "historic_rank_checked_at",
        "timestamptz",
        (kill) => kill.historicRankCheckedAt
      ]
    ],
    kills
  );
}
```

- [ ] **Step 10: Wire it into loading, publishing and the cost row**

In `packages/database/src/evidence/load.ts`, import `loadPublishedRaiderIoFirstKills` from `./raiderio-first-kills` and add to the object `loadCompletedEvidence` returns, after `tierBests`:

```ts
    // From the snapshot run, like the kills: the first kills are part of what
    // the newest publication shows, read with today's suppressions.
    raiderIoFirstKills: await loadPublishedRaiderIoFirstKills(
      client,
      snapshot.id
    ),
```

In `packages/database/src/evidence/repository.ts`, import:

```ts
import { mergePublishedEvidence, mergeRaiderIoFirstKills } from "./merge";
import {
  insertRaiderIoFirstKills,
  loadLatestRaiderIoFirstKills,
  loadRaiderIoLoggedEncounters,
  storeRaiderIoLoggedEncounters
} from "./raiderio-first-kills";
```

Widen the publish guard (the comment already asks for this):

```ts
const partialNamesNoReason =
  input.state === "partial" &&
  input.limitationCode === null &&
  input.parseLimitationCode === null &&
  input.scanSkipped !== true &&
  (input.raiderIoFirstKills?.limitationCode ?? null) === null;
```

and add to its comment: "a fourth, Raider.IO logged-encounter reads that fell short (#732)". Inside the transaction, right after the `character_evidence_cutting_edges` insert:

```ts
// In the same transaction as every other row of this snapshot, so
// no reader ever sees a run's kills without its Raider.IO first
// kills, or the reverse.
await insertRaiderIoFirstKills(
  client,
  runId,
  mergeRaiderIoFirstKills(
    await loadLatestRaiderIoFirstKills(client, activeKey),
    input.raiderIoFirstKills,
    input.state,
    targeted
  )
);
```

In the `UPDATE character_evidence_runs` statement, add after `publication_scope = $18,`:

```sql
                 raiderio_limitation_code = $19,
```

and append to its parameter array, after its last element `targeted ? "tier" : "full"` (which now needs a trailing comma):

<!-- prettier-ignore -->
```ts
              input.raiderIoFirstKills?.limitationCode ?? null
```

In `recordRunCost`, add `raiderio_logged_encounter_requests` after `guild_report_requests` in the column list, `$45` after `$44` in `VALUES`, `raiderio_logged_encounter_requests = EXCLUDED.raiderio_logged_encounter_requests` after `guild_report_requests = EXCLUDED.guild_report_requests` in `ON CONFLICT ... DO UPDATE SET` (with the comma that the new last line needs), and, in the parameter array, after its last element `cost.requests.guildReports ?? 0` (which now needs a trailing comma):

<!-- prettier-ignore -->
```ts
            cost.requests.raiderIoLoggedEncounters ?? 0
```

Add three methods to the `evidence` object, after `getCompleted`:

```ts
      async saveRaiderIoLoggedEncounters(answers, readAt) {
        await storeRaiderIoLoggedEncounters(pool, answers, readAt);
      },

      async raiderIoLoggedEncounters(ids) {
        return loadRaiderIoLoggedEncounters(pool, ids);
      },

      async storedRaiderIoFirstKills(key) {
        return loadLatestRaiderIoFirstKills(pool, key);
      },
```

- [ ] **Step 11: Write the failing integration tests**

In `tests/integration/repository-fixtures.ts`, add `raiderio_logged_encounters,` to the `TRUNCATE TABLE` list (the members table and the first kills cascade; `suppressed_characters` is already there).

In `tests/integration/migrations.test.ts`, insert into the expected table list, keeping it sorted:

```ts
      "character_mythic_wipes",
      "character_raiderio_first_kills",
      "character_terminal_tiers",
```

```ts
      "operators",
      "raiderio_logged_encounter_members",
      "raiderio_logged_encounters",
      "rate_limit_events",
```

and change the journal check to the last 35 entries, appending the new one:

<!-- prettier-ignore -->
```ts
      journal.entries.slice(-35).map(({ idx, tag }) => ({ idx, tag }))
```

```ts
      { idx: 64, tag: "0065_guild_report_requests" },
      { idx: 65, tag: "0066_raiderio_logged_kills" }
```

Create `tests/integration/repositories-raiderio-first-kills.test.ts`:

```ts
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CharacterRaiderIoFirstKillInput,
  EvidenceRunCost,
  RaiderIoLoggedEncounterInput,
  RaiderIoLoggedEncounterMemberInput
} from "../../packages/database/src";
import {
  mythicKill,
  resetRepositoryTables,
  rootKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

// Synthetic identities throughout: this repository is public.
const killGuild = {
  name: "Fixture Guild Alfa",
  realm: "twisting-nether",
  region: "eu"
};
const alfa: RaiderIoLoggedEncounterMemberInput = {
  raiderIoCharacterId: 424_242,
  name: "Alfa",
  realm: "draenor",
  region: "eu",
  className: "Demon Hunter",
  specName: "Havoc",
  role: "dps",
  itemLevel: null
};
const bravo: RaiderIoLoggedEncounterMemberInput = {
  raiderIoCharacterId: 424_243,
  name: "Bravo",
  realm: "twisting-nether",
  region: "eu",
  className: "Warrior",
  specName: "Protection",
  role: "tank",
  itemLevel: 292.1
};
const encounter: RaiderIoLoggedEncounterInput = {
  loggedEncounterId: 700_001,
  raidSlug: "tier-mn-1",
  bossSlug: "midnight-falls",
  pulledAt: "2026-07-20T17:17:29.977Z",
  defeatedAt: "2026-07-20T17:25:57.301Z",
  durationMs: 507_324,
  guild: killGuild,
  itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
  deathCount: 2,
  vantusCount: 16,
  rosterState: "available",
  members: [alfa, bravo]
};

function firstKill(
  overrides: Partial<CharacterRaiderIoFirstKillInput> = {}
): CharacterRaiderIoFirstKillInput {
  return {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: "2026-09-28T12:00:00.000Z",
    ...overrides
  };
}

describe("PostgreSQL repositories: Raider.IO first kills", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;

  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });

  beforeEach(async () => {
    await resetRepositoryTables(pool);
  });

  afterAll(async () => {
    await stop();
  });

  async function reserve(at: string): Promise<string> {
    const reservation = await repositories.evidence.reserve({
      origin: "dossier_read",
      key: rootKey,
      freshnessCutoff: new Date(at),
      at: new Date(at)
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");
    return reservation.run.id;
  }

  const save = (
    answers: Parameters<
      NonNullable<TestRepositories["evidence"]["saveRaiderIoLoggedEncounters"]>
    >[0],
    at: string
  ) =>
    repositories.evidence.saveRaiderIoLoggedEncounters!(answers, new Date(at));
  const stored = (ids: readonly number[]) =>
    repositories.evidence.raiderIoLoggedEncounters!(ids);

  async function publishFirstKill(): Promise<void> {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      raiderIoFirstKills: {
        kills: [firstKill()],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: null
      },
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });
  }

  it("keeps a visible roster as first read, however often it is read", async () => {
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    await save(
      {
        encounters: [{ ...encounter, deathCount: 99, members: [] }],
        unavailable: []
      },
      "2026-09-29T12:00:00.000Z"
    );

    expect(await stored([700_001, 1])).toEqual({
      encounters: [{ ...encounter, readAt: "2026-09-28T12:00:00.000Z" }],
      unavailable: []
    });
  });

  it("replaces a hidden roster with a later read, dated by that read", async () => {
    await save(
      {
        encounters: [{ ...encounter, rosterState: "private", members: [] }],
        unavailable: []
      },
      "2026-09-01T12:00:00.000Z"
    );
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );

    expect(await stored([700_001])).toEqual({
      encounters: [{ ...encounter, readAt: "2026-09-28T12:00:00.000Z" }],
      unavailable: []
    });
  });

  it("stores a permanent answer, and never lets one unread a kill", async () => {
    await save(
      {
        encounters: [encounter],
        unavailable: [{ loggedEncounterId: 700_002, code: "not_found" }]
      },
      "2026-09-01T12:00:00.000Z"
    );
    // A refusal refreshes a refusal, and never overwrites a read.
    await save(
      {
        encounters: [],
        unavailable: [
          { loggedEncounterId: 700_001, code: "not_found" },
          { loggedEncounterId: 700_002, code: "schema_drift" }
        ]
      },
      "2026-09-28T12:00:00.000Z"
    );

    expect(await stored([700_001, 700_002])).toEqual({
      encounters: [{ ...encounter, readAt: "2026-09-01T12:00:00.000Z" }],
      unavailable: [
        {
          loggedEncounterId: 700_002,
          code: "schema_drift",
          readAt: "2026-09-28T12:00:00.000Z"
        }
      ]
    });

    // A later read replaces a refusal.
    await save(
      {
        encounters: [{ ...encounter, loggedEncounterId: 700_002 }],
        unavailable: []
      },
      "2026-10-30T12:00:00.000Z"
    );
    expect((await stored([700_002])).unavailable).toEqual([]);
  });

  it("publishes first kills with the snapshot and shows each with its encounter", async () => {
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      tierBests: [],
      raiderIoFirstKills: {
        kills: [
          firstKill(),
          firstKill({
            raidSlug: "manaforge-omega",
            bossSlug: "nexus-king-salhadaar",
            killedAt: "2025-09-10T20:00:00.000Z",
            loggedEncounterId: null,
            encounterState: "unavailable",
            historicRankCheckedAt: null
          })
        ],
        askedRaidSlugs: ["tier-mn-1", "manaforge-omega"],
        limitationCode: null
      },
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.raiderIoFirstKills).toEqual([
      {
        ...firstKill({
          raidSlug: "manaforge-omega",
          bossSlug: "nexus-king-salhadaar",
          killedAt: "2025-09-10T20:00:00.000Z",
          loggedEncounterId: null,
          encounterState: "unavailable",
          historicRankCheckedAt: null
        }),
        encounter: null
      },
      {
        ...firstKill(),
        encounter: {
          ...encounter,
          readAt: "2026-09-28T12:00:00.000Z",
          roleCounts: { tank: 1, healer: 0, dps: 1 }
        }
      }
    ]);
    expect(
      await repositories.evidence.storedRaiderIoFirstKills!(rootKey)
    ).toHaveLength(2);
  });

  it("leaves a suppressed raider off the roster a dossier reads, and still counts them", async () => {
    // Break caught (#734 review): a removed character who raided with the
    // kill guild would be named, with realm, class and item level, on the
    // dossier of everyone who shared the kill.
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    await publishFirstKill();
    await repositories.suppressions.suppress(
      { region: "eu", realm: "twisting-nether", name: "bravo" },
      "github-issue-1",
      null
    );

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.raiderIoFirstKills?.[0]?.encounter).toMatchObject({
      members: [alfa],
      roleCounts: { tank: 1, healer: 0, dps: 1 }
    });
    // Collection's presence check still sees the whole roster, and the row
    // is kept: removal suppresses reads, it does not delete.
    expect((await stored([700_001])).encounters[0]?.members).toEqual([
      alfa,
      bravo
    ]);
    const rows = await pool.query(
      "SELECT count(*)::int AS count FROM raiderio_logged_encounter_members"
    );
    expect(rows.rows[0]).toEqual({ count: 2 });
  });

  it("shows the raider again once the suppression expires", async () => {
    await save(
      { encounters: [encounter], unavailable: [] },
      "2026-09-28T12:00:00.000Z"
    );
    await publishFirstKill();
    await repositories.suppressions.suppress(
      { region: "eu", realm: "twisting-nether", name: "bravo" },
      "github-issue-1",
      new Date(Date.now() - 60_000)
    );

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.raiderIoFirstKills?.[0]?.encounter?.members).toEqual([
      alfa,
      bravo
    ]);
  });

  it("carries first kills forward through a run that did not read them, and drops them only where a complete run looked", async () => {
    const publish = async (
      runId: string,
      completedAt: string,
      raiderIoFirstKills?: Parameters<
        TestRepositories["evidence"]["publish"]
      >[1]["raiderIoFirstKills"]
    ) =>
      repositories.evidence.publish(runId, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        ...(raiderIoFirstKills ? { raiderIoFirstKills } : {}),
        completedAt: new Date(completedAt)
      });
    const queenAnsurek = firstKill({
      raidSlug: "nerubar-palace",
      bossSlug: "queen-ansurek",
      killedAt: "2024-10-01T20:00:00.000Z",
      loggedEncounterId: 1_234,
      encounterState: "unavailable",
      encounterLimitationCode: "not_found"
    });

    await publish(
      await reserve("2026-09-01T12:00:00.000Z"),
      "2026-09-01T12:05:00.000Z",
      {
        kills: [firstKill(), queenAnsurek],
        askedRaidSlugs: ["tier-mn-1", "nerubar-palace"],
        limitationCode: null
      }
    );
    await publish(
      await reserve("2026-09-02T12:00:00.000Z"),
      "2026-09-02T12:05:00.000Z"
    );
    expect(
      (await repositories.evidence.storedRaiderIoFirstKills!(rootKey)).map(
        (kill) => kill.bossSlug
      )
    ).toEqual(["queen-ansurek", "midnight-falls"]);

    await publish(
      await reserve("2026-09-03T12:00:00.000Z"),
      "2026-09-03T12:05:00.000Z",
      {
        kills: [],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: null
      }
    );
    expect(
      (await repositories.evidence.storedRaiderIoFirstKills!(rootKey)).map(
        (kill) => kill.bossSlug
      )
    ).toEqual(["queen-ansurek"]);
  });

  it("accepts a run partial only for its Raider.IO shortfall, and says so", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      raiderIoFirstKills: {
        kills: [
          firstKill({
            encounterState: "unavailable",
            encounterLimitationCode: "request_cap"
          })
        ],
        askedRaidSlugs: ["tier-mn-1"],
        limitationCode: "request_cap"
      },
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.run).toMatchObject({
      status: "partial",
      raiderIoLimitationCode: "request_cap"
    });
    expect(completed?.run).not.toHaveProperty("killScanSkipped");
  });

  it("loads a skipped kill scan onto the run", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await repositories.evidence.publish(runId, {
      state: "partial",
      limitationCode: null,
      parseLimitationCode: null,
      scanSkipped: true,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt: new Date("2026-09-28T12:05:00.000Z")
    });

    expect(
      (await repositories.evidence.getCompleted(rootKey))?.run
    ).toMatchObject({ status: "partial", killScanSkipped: true });
  });

  it("still refuses a partial run that names no shortfall at all", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    await expect(
      repositories.evidence.publish(runId, {
        state: "partial",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [],
        wipes: [],
        tierBests: [],
        raiderIoFirstKills: {
          kills: [],
          askedRaidSlugs: [],
          limitationCode: null
        },
        completedAt: new Date("2026-09-28T12:05:00.000Z")
      })
    ).rejects.toThrow("character_evidence_publication_invalid");
  });

  it("records the logged-encounter reads on the run's cost row", async () => {
    const runId = await reserve("2026-09-28T12:00:00.000Z");
    const cost: EvidenceRunCost = {
      runId,
      attempt: 1,
      outcome: "published",
      credentials: "own",
      limitationCode: null,
      parseLimitationCode: null,
      pointsSpent: 10,
      pointsLimitPerHour: 18_000,
      pointsRemainingBefore: 17_000,
      pointsRemainingAfter: 16_990,
      requestCapUsed: 300,
      parseRequestCapUsed: 24,
      requests: {
        historyScan: 1,
        guildAttendance: 0,
        reportHydration: 0,
        zoneRankings: 0,
        fightParses: 0,
        rankingIdentities: 0,
        raiderIoHistoric: 18,
        raiderIoLoggedEncounters: 7
      },
      recovery: {
        raiderIoOutcome: "evidence",
        raiderIoMs: 100,
        verifiedKillsSearched: 0,
        verifiedKillsSkippedEmpty: 0,
        recoveredKills: 0
      }
    };

    await repositories.evidence.recordRunCost(cost);

    const rows = await pool.query(
      `SELECT raiderio_historic_requests, raiderio_logged_encounter_requests
         FROM character_evidence_run_costs WHERE run_id = $1`,
      [runId]
    );
    expect(rows.rows).toEqual([
      {
        raiderio_historic_requests: 18,
        raiderio_logged_encounter_requests: 7
      }
    ]);
  });

  it("never publishes a run's kills without its Raider.IO first kills", async () => {
    // Break caught: first kills written after the run was marked complete
    // would let a reader see a snapshot with half its evidence.
    await pool.query(`
      CREATE FUNCTION reject_raiderio_first_kill() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'raiderio_first_kill_rejected'; END $$;
      CREATE TRIGGER reject_raiderio_first_kill
        BEFORE INSERT ON character_raiderio_first_kills
        FOR EACH ROW EXECUTE FUNCTION reject_raiderio_first_kill();
    `);
    try {
      const runId = await reserve("2026-09-28T12:00:00.000Z");
      await expect(
        repositories.evidence.publish(runId, {
          state: "complete",
          limitationCode: null,
          parseLimitationCode: null,
          kills: [mythicKill()],
          wipes: [],
          tierBests: [],
          raiderIoFirstKills: {
            kills: [
              firstKill({
                encounterState: "unavailable",
                encounterLimitationCode: "request_cap"
              })
            ],
            askedRaidSlugs: ["tier-mn-1"],
            limitationCode: null
          },
          completedAt: new Date("2026-09-28T12:05:00.000Z")
        })
      ).rejects.toThrow("raiderio_first_kill_rejected");

      const kills = await pool.query(
        "SELECT count(*)::int AS count FROM character_mythic_kills WHERE evidence_run_id = $1",
        [runId]
      );
      expect(kills.rows[0]).toEqual({ count: 0 });
      expect(await repositories.evidence.getCompleted(rootKey)).toBeNull();
      expect((await repositories.evidence.find(runId))?.status).toBe("queued");
    } finally {
      await pool.query(`
        DROP TRIGGER IF EXISTS reject_raiderio_first_kill ON character_raiderio_first_kills;
        DROP FUNCTION IF EXISTS reject_raiderio_first_kill();
      `);
    }
  });
});
```

- [ ] **Step 12: Run the integration tests (Docker must be running)**

Run: `corepack pnpm exec vitest run --project integration tests/integration/repositories-raiderio-first-kills.test.ts tests/integration/migrations.test.ts tests/integration/repositories-evidence-searches.test.ts`
Expected: PASS. If they are reported as skipped, Docker is not running; start it and re-run — a skipped suite is not a pass. (`repositories-evidence-searches.test.ts` pins the cost row's other columns, which the new column must leave alone.)

Run: `corepack pnpm exec vitest run --project unit packages/database/src`
Expected: PASS, including `migration-journal.test.ts`.

Run: `corepack pnpm --filter @slashwho/database typecheck`
Expected: exits 0.

- [ ] **Step 13: Commit**

```bash
git add packages/database tests/integration
git commit -m "feat(database): store Raider.IO logged encounters and publish first kills with the snapshot (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Application: the `raiderio_logged_encounters` phase

**Files:**

- Create: `packages/application/src/raiderio-first-kills.ts`
- Test: `packages/application/src/raiderio-first-kills.test.ts`
- Modify: `packages/application/src/verified-kills.ts` (`VerifiedKillsResult` 23-36, `raiderIoVerifiedKills` 45-75), `verified-kills.test.ts`
- Modify: `packages/application/src/evidence-phase-ledger.ts:6-14, 86-117`
- Modify: `packages/application/src/evidence-publication.ts` (`EvidencePublication` 25-77, `toStagedCollection` 89-128, `fromStagedCollection` 130-178)
- Modify: `packages/application/src/applicant-evidence-job-handler.ts` (`ApplicantEvidenceStore` 190-340, `raiderio` option 358-359, the cost row's `requests` at 1221-1238, after the `raiderio_rankings` block ending at 2230, `retryAfterMs` at 2270-2273, `incomplete` at 2278-2282, the main `stageAndPublish` at 2300-2356)
- Modify: `packages/application/src/applicant-evidence-job-handler.test.ts` (including the exact cost-row expectation at 2953-2966), `resume-waiting-evidence.test.ts:56-65, 108-117`, `applicant-dossier-service.test.ts:781-790`
- Modify: `packages/contracts/src/dossier.ts:70-80`, `apps/web/src/components/collection-progress.tsx:20-29`

**Interfaces:**

- Consumes: `HistoricMythicKill.loggedEncounterId`, `RaiderIoGateway.getLoggedEncounter`, `RaiderIoCharacter.raiderIoCharacterId`, `LoggedEncounter` (Task 2); `lookupRaidEncounterByRaiderIoSlugs`, `matchesRaiderIoKill`, `STORED_KILL_MATCH_MS` (Task 3); `CharacterRaiderIoFirstKillInput`, `RaiderIoLoggedEncounterInput`, `RaiderIoLoggedEncounterAnswers`, `StoredRaiderIoLoggedEncounterAnswers`, `RaiderIoLoggedEncounterUnavailableCode`, `RaiderIoFirstKillsPublication`, `mergeRaiderIoFirstKills` (test only), `EvidenceRunCost.requests.raiderIoLoggedEncounters`, and the optional store methods `saveRaiderIoLoggedEncounters`, `raiderIoLoggedEncounters`, `storedRaiderIoFirstKills` (Task 4).
- Produces:

```ts
// packages/application/src/raiderio-first-kills.ts
export const MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN = 50;
export const RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY = 4;
export const MAX_RAIDER_IO_FIRST_KILL_RANK_REQUESTS_PER_RUN = 50;
export const RAIDER_IO_PRIVATE_ROSTER_REREAD_MS = 7 * 24 * 60 * 60 * 1_000;
export const RAIDER_IO_UNAVAILABLE_ENCOUNTER_REREAD_MS =
  30 * 24 * 60 * 60 * 1_000;
export type RaiderIoFirstKillLimitation = Readonly<{
  code: RaiderIoEvidenceLimitation;
  retryAfterMs?: number;
}>;
export type RaiderIoFirstKillCollection = Readonly<{
  kills: readonly CharacterRaiderIoFirstKillInput[];
  encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>;
  limitation: RaiderIoFirstKillLimitation | null;
}>;
export function collectRaiderIoFirstKills(
  input: CollectInput
): Promise<RaiderIoFirstKillCollection>;
export function rankRaiderIoFirstKills(
  input: RankInput
): Promise<readonly CharacterRaiderIoFirstKillInput[]>;
// verified-kills.ts: VerifiedKillsResult gains firstKills?, askedRaidSlugs?
// evidence-phase-ledger.ts: EvidencePhaseId gains "raiderio_logged_encounters"
// EvidencePublication and ApplicantEvidenceStore.publish gain raiderIoFirstKills?: RaiderIoFirstKillsPublication
```

- [ ] **Step 1: Write the failing module tests**

Create `packages/application/src/raiderio-first-kills.test.ts`:

```ts
import type {
  CharacterRaiderIoFirstKillInput,
  RaiderIoLoggedEncounterAnswers,
  StoredRaiderIoLoggedEncounter,
  StoredRaiderIoLoggedEncounterAnswers,
  StoredRaiderIoLoggedEncounterUnavailable
} from "@slashwho/database";
import type {
  HistoricMythicKill,
  LoggedEncounter,
  LoggedEncounterMember,
  MythicBossRanking,
  RaiderIoGateway
} from "@slashwho/raiderio";
import { describe, expect, it, vi } from "vitest";

import {
  collectRaiderIoFirstKills,
  MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN,
  rankRaiderIoFirstKills
} from "./raiderio-first-kills";

// Synthetic identities throughout: this repository is public.
const key = { region: "eu" as const, realm: "draenor", name: "alfa" };
const killGuild = {
  name: "Fixture Guild Alfa",
  realm: "twisting-nether",
  region: "eu"
};
const alfaId = 424_242;
const alfa: LoggedEncounterMember = {
  raiderIoCharacterId: alfaId,
  name: "Alfa",
  realm: "draenor",
  region: "eu",
  className: "Demon Hunter",
  specName: "Havoc",
  role: "dps",
  itemLevel: 290.5
};
const bravo: LoggedEncounterMember = {
  raiderIoCharacterId: 424_243,
  name: "Bravo",
  realm: "twisting-nether",
  region: "eu",
  className: "Warrior",
  specName: "Protection",
  role: "tank",
  itemLevel: 292.1
};
const now = new Date("2026-09-28T12:00:00.000Z");
const none: StoredRaiderIoLoggedEncounterAnswers = {
  encounters: [],
  unavailable: []
};

function kill(
  bossSlug: string,
  loggedEncounterId: number | null,
  firstDefeated = "2026-07-20T17:25:57.000Z"
): HistoricMythicKill {
  return {
    raidSlug: "tier-mn-1",
    bossSlug,
    firstDefeated,
    guild: killGuild,
    loggedEncounterId
  };
}

function encounter(
  bossSlug: string,
  roster: LoggedEncounter["roster"] = {
    state: "available",
    members: [bravo, alfa]
  }
): LoggedEncounter {
  return {
    kind: "encounter",
    raidSlug: "tier-mn-1",
    bossSlug,
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    guild: killGuild,
    deathCount: 2,
    vantusCount: 16,
    roster
  };
}

function storedRead(
  overrides: Partial<StoredRaiderIoLoggedEncounter> = {}
): StoredRaiderIoLoggedEncounter {
  return {
    loggedEncounterId: 700_001,
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    guild: killGuild,
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    deathCount: 2,
    vantusCount: 16,
    rosterState: "available",
    members: [bravo, alfa],
    readAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const midnightFalls = kill("midnight-falls", 700_001);

type Gateway = Pick<RaiderIoGateway, "getLoggedEncounter"> &
  Partial<Pick<RaiderIoGateway, "getCharacter">>;

function gateway(overrides: Partial<Gateway> = {}) {
  return {
    getLoggedEncounter: vi.fn<Gateway["getLoggedEncounter"]>(
      async (_raidSlug, id) =>
        encounter(id === 700_001 ? "midnight-falls" : `boss-${String(id)}`)
    ),
    getCharacter: vi.fn<NonNullable<Gateway["getCharacter"]>>(async () => ({
      key,
      displayName: "Alfa",
      className: "Demon Hunter",
      level: 90,
      guild: null,
      ownerId: null,
      profileGuess: null,
      declaredMain: null,
      raiderIoCharacterId: alfaId
    })),
    ...overrides
  };
}

function collect(
  kills: readonly HistoricMythicKill[],
  raiderio: Gateway = gateway(),
  overrides: Partial<Parameters<typeof collectRaiderIoFirstKills>[0]> = {}
) {
  return collectRaiderIoFirstKills({
    key,
    kills,
    published: [],
    storedEncounters: async () => none,
    saveAnswers: async () => undefined,
    raiderio,
    signal: new AbortController().signal,
    now: () => now,
    ...overrides
  });
}

/** A store that keeps what it is given, so two runs can be played back to back. */
function memoryStore() {
  const encounters: StoredRaiderIoLoggedEncounter[] = [];
  const unavailable: StoredRaiderIoLoggedEncounterUnavailable[] = [];
  return {
    storedEncounters: async (
      ids: readonly number[]
    ): Promise<StoredRaiderIoLoggedEncounterAnswers> => ({
      encounters: encounters.filter((item) =>
        ids.includes(item.loggedEncounterId)
      ),
      unavailable: unavailable.filter((item) =>
        ids.includes(item.loggedEncounterId)
      )
    }),
    saveAnswers: async (answers: RaiderIoLoggedEncounterAnswers) => {
      const readAt = now.toISOString();
      encounters.push(
        ...answers.encounters.map((item) => ({ ...item, readAt }))
      );
      unavailable.push(
        ...answers.unavailable.map((item) => ({ ...item, readAt }))
      );
    }
  };
}

describe("collectRaiderIoFirstKills", () => {
  it("reads a first kill's logged encounter and publishes it read, at the log's own time", async () => {
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const result = await collect([midnightFalls], gateway(), {
      saveAnswers: async (answers) => void saved.push(answers)
    });

    expect(result.limitation).toBeNull();
    expect(result.kills).toEqual([
      {
        raidSlug: "tier-mn-1",
        bossSlug: "midnight-falls",
        killedAt: "2026-07-20T17:25:57.301Z",
        guild: killGuild,
        loggedEncounterId: 700_001,
        encounterState: "read",
        encounterLimitationCode: null,
        historicWorldRank: null,
        historicRankCheckedAt: null
      }
    ]);
    expect(saved).toEqual([
      {
        encounters: [
          expect.objectContaining({
            loggedEncounterId: 700_001,
            rosterState: "available",
            members: [bravo, alfa]
          })
        ],
        unavailable: []
      }
    ]);
  });

  it("publishes a kill with no logged encounter as unavailable, without a read", async () => {
    const raiderio = gateway();
    const result = await collect(
      [kill("nexus-king-salhadaar", null, "2025-09-10T20:00:00.000Z")],
      raiderio
    );

    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalled();
    expect(result.kills).toEqual([
      expect.objectContaining({
        killedAt: "2025-09-10T20:00:00.000Z",
        loggedEncounterId: null,
        encounterState: "unavailable",
        encounterLimitationCode: null
      })
    ]);
    expect(result.limitation).toBeNull();
  });

  it(`stops at ${String(MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN)} reads and names the rest request_cap`, async () => {
    const kills = Array.from({ length: 51 }, (_, index) =>
      kill(`boss-${String(index + 1)}`, index + 1)
    );
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
        encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        })
      )
    });

    const result = await collect(kills, raiderio);

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(50);
    expect(result.kills.at(-1)).toMatchObject({
      loggedEncounterId: 51,
      encounterState: "unavailable",
      encounterLimitationCode: "request_cap"
    });
    expect(result.limitation).toEqual({ code: "request_cap" });
  });

  it("reads at most four encounters at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        });
      })
    });

    await collect(
      Array.from({ length: 10 }, (_, index) =>
        kill(`boss-${String(index + 1)}`, index + 1)
      ),
      raiderio
    );

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(10);
    expect(most).toBe(4);
  });

  it("never reads a visible roster again", async () => {
    const raiderio = gateway();

    const result = await collect([midnightFalls], raiderio, {
      storedEncounters: async () => ({
        encounters: [storedRead({ readAt: "2025-09-28T12:00:00.000Z" })],
        unavailable: []
      })
    });

    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalled();
    expect(result.kills[0]).toMatchObject({ encounterState: "read" });
  });

  it.each([
    [
      "a hidden roster read 8 days ago",
      "private",
      "2026-09-20T11:00:00.000Z",
      1
    ],
    [
      "a hidden roster read 6 days ago",
      "private",
      "2026-09-22T12:00:00.000Z",
      0
    ],
    [
      "a visible roster read a year ago",
      "available",
      "2025-09-28T12:00:00.000Z",
      0
    ]
  ] as const)(
    "reads a hidden roster again after a week, and a visible one never: %s",
    async (_name, rosterState, readAt, reads) => {
      // Break caught (#734 review): a guild can open its roster after the
      // kill, and a roster stored as hidden then stayed hidden for good.
      const raiderio = gateway();

      const result = await collect([midnightFalls], raiderio, {
        storedEncounters: async () => ({
          encounters: [
            storedRead({
              rosterState,
              members: rosterState === "private" ? [] : [bravo, alfa],
              readAt
            })
          ],
          unavailable: []
        })
      });

      expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(reads);
      expect(result.kills[0]).toMatchObject({ encounterState: "read" });
      expect(result.encounters.get(700_001)?.rosterState).toBe(
        reads === 1 ? "available" : rosterState
      );
    }
  );

  it("keeps a hidden roster as read when the re-read is refused, and dates the attempt", async () => {
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const hidden = storedRead({
      rosterState: "private",
      members: [],
      readAt: "2026-09-01T00:00:00.000Z"
    });
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "not_found" as const
      }))
    });

    const result = await collect([midnightFalls], raiderio, {
      storedEncounters: async () => ({ encounters: [hidden], unavailable: [] }),
      saveAnswers: async (answers) => void saved.push(answers)
    });

    expect(result.limitation).toBeNull();
    expect(result.kills[0]).toMatchObject({ encounterState: "read" });
    // Saved again unchanged, so its `read_at` moves and it waits another week.
    const { readAt, ...unchanged } = hidden;
    void readAt;
    expect(saved).toEqual([{ encounters: [unchanged], unavailable: [] }]);
  });

  it.each([
    ["31 days ago", "2026-08-28T11:00:00.000Z", 1],
    ["29 days ago", "2026-08-30T12:00:00.000Z", 0]
  ])(
    "asks again about a permanent answer only after 30 days: stored %s",
    async (_name, readAt, reads) => {
      const raiderio = gateway({
        getLoggedEncounter: vi.fn(async () => ({
          kind: "limitation" as const,
          code: "not_found" as const
        }))
      });

      const result = await collect([midnightFalls], raiderio, {
        storedEncounters: async () => ({
          encounters: [],
          unavailable: [
            { loggedEncounterId: 700_001, code: "not_found", readAt }
          ]
        })
      });

      expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(reads);
      expect(result.kills[0]).toMatchObject({
        encounterState: "unavailable",
        encounterLimitationCode: "not_found"
      });
      expect(result.limitation).toBeNull();
    }
  );

  it("asks once about a deleted log across two runs", async () => {
    // Break caught (#734 review): only a successful read was stored, so a
    // deleted log cost one request on every run for good.
    const store = memoryStore();
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "not_found" as const
      }))
    });

    await collect([midnightFalls], raiderio, store);
    const second = await collect([midnightFalls], raiderio, store);

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(1);
    expect(second.kills[0]).toMatchObject({
      encounterState: "unavailable",
      encounterLimitationCode: "not_found"
    });
    expect(second.limitation).toBeNull();
  });

  it("never spends the cap on permanent answers it already holds", async () => {
    // Break caught (#734 review): 50 refusals at the front of the queue would
    // take the whole cap every run and hold the character partial for good.
    const kills = Array.from({ length: 60 }, (_, index) =>
      kill(`boss-${String(index + 1)}`, index + 1)
    );
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
        encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        })
      )
    });

    const result = await collect(kills, raiderio, {
      storedEncounters: async () => ({
        encounters: [],
        unavailable: Array.from({ length: 50 }, (_, index) => ({
          loggedEncounterId: index + 1,
          code: "not_found" as const,
          readAt: "2026-09-27T00:00:00.000Z"
        }))
      })
    });

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(10);
    expect(result.limitation).toBeNull();
  });

  it("reads every first read before any re-read, and a deferred re-read keeps its answer", async () => {
    const kills = [
      kill("midnight-falls", 700_001),
      ...Array.from({ length: 50 }, (_, index) =>
        kill(`boss-${String(index + 1)}`, index + 1)
      )
    ];
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
        encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        })
      )
    });

    const result = await collect(kills, raiderio, {
      storedEncounters: async () => ({
        encounters: [
          storedRead({
            rosterState: "private",
            members: [],
            readAt: "2026-09-01T00:00:00.000Z"
          })
        ],
        unavailable: []
      })
    });

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(50);
    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalledWith(
      "tier-mn-1",
      700_001,
      expect.anything(),
      undefined
    );
    expect(result.kills[0]).toMatchObject({
      loggedEncounterId: 700_001,
      encounterState: "read"
    });
    expect(result.limitation).toBeNull();
  });

  it("counts the character present only by its own Raider.IO id on the roster", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () =>
        encounter("midnight-falls", {
          state: "available",
          members: [bravo]
        })
      )
    });

    const result = await collect([midnightFalls], raiderio);

    expect(raiderio.getCharacter).toHaveBeenCalledTimes(1);
    expect(result.kills).toEqual([]);
    expect(result.limitation).toBeNull();
  });

  it("does not ask for the character's id once its presence is established", async () => {
    const published: CharacterRaiderIoFirstKillInput = {
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      loggedEncounterId: 700_001,
      encounterState: "read",
      encounterLimitationCode: null,
      historicWorldRank: null,
      historicRankCheckedAt: null
    };
    const raiderio = gateway();

    const result = await collect([midnightFalls], raiderio, {
      published: [published]
    });

    expect(raiderio.getCharacter).not.toHaveBeenCalled();
    expect(result.kills).toHaveLength(1);
  });

  it("falls back to Raider.IO's own attribution when the roster is hidden", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () =>
        encounter("midnight-falls", { state: "unavailable", reason: "private" })
      )
    });

    const result = await collect([midnightFalls], raiderio);

    expect(raiderio.getCharacter).not.toHaveBeenCalled();
    expect(result.kills[0]).toMatchObject({ encounterState: "read" });
    expect(result.encounters.get(700_001)).toMatchObject({
      rosterState: "private",
      members: []
    });
  });

  it("withholds unchecked kills and limits the phase when the character's id cannot be learned", async () => {
    const raiderio = gateway({
      getCharacter: vi.fn(async () => {
        throw new Error("raiderio_down");
      })
    });

    const result = await collect([midnightFalls], raiderio);

    expect(result.kills).toEqual([]);
    expect(result.limitation).toEqual({ code: "unavailable" });
  });

  it("abandons the queue once a read throws", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => {
        throw new Error("raiderio_down");
      })
    });

    const result = await collect(
      Array.from({ length: 6 }, (_, index) =>
        kill(`boss-${String(index + 1)}`, index + 1)
      ),
      raiderio
    );

    // The four already in flight when the first one threw, and no more.
    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(4);
    expect(result.limitation).toEqual({ code: "unavailable" });
    expect(
      result.kills.every(
        (item) =>
          item.encounterState === "unavailable" &&
          item.encounterLimitationCode === "unavailable"
      )
    ).toBe(true);
  });

  it("keeps a rate limit's retry time", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "rate_limited" as const,
        retryAfterMs: 30_000
      }))
    });

    const result = await collect([midnightFalls], raiderio);

    expect(result.limitation).toEqual({
      code: "rate_limited",
      retryAfterMs: 30_000
    });
  });

  it.each(["not_found", "private", "schema_drift"] as const)(
    "does not hold the run partial for a permanent answer (%s), and stores it",
    async (code) => {
      const saved: RaiderIoLoggedEncounterAnswers[] = [];
      const raiderio = gateway({
        getLoggedEncounter: vi.fn(async () => ({
          kind: "limitation" as const,
          code
        }))
      });

      const result = await collect([midnightFalls], raiderio, {
        saveAnswers: async (answers) => void saved.push(answers)
      });

      expect(result.limitation).toBeNull();
      expect(result.kills[0]).toMatchObject({
        encounterState: "unavailable",
        encounterLimitationCode: code
      });
      expect(saved).toEqual([
        {
          encounters: [],
          unavailable: [{ loggedEncounterId: 700_001, code }]
        }
      ]);
    }
  );

  it("refuses an encounter that names another boss, and stores the refusal", async () => {
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () =>
        encounter("chimaerus-the-undreamt-god")
      )
    });

    const result = await collect([midnightFalls], raiderio, {
      saveAnswers: async (answers) => void saved.push(answers)
    });

    expect(result.kills[0]).toMatchObject({
      encounterState: "unavailable",
      encounterLimitationCode: "schema_drift"
    });
    expect(result.encounters.size).toBe(0);
    expect(saved[0]?.unavailable).toEqual([
      { loggedEncounterId: 700_001, code: "schema_drift" }
    ]);
  });

  it("keeps a read nobody could store as unread", async () => {
    const result = await collect([midnightFalls], gateway(), {
      saveAnswers: async () => {
        throw new Error("database_down");
      }
    });

    expect(result.kills[0]).toMatchObject({
      encounterState: "unavailable",
      encounterLimitationCode: "unavailable"
    });
    expect(result.limitation).toEqual({ code: "unavailable" });
  });
});

describe("rankRaiderIoFirstKills", () => {
  const readKill: CharacterRaiderIoFirstKillInput = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: null
  };
  const { readAt, ...readEncounter } = storedRead();
  void readAt;
  const encounters = new Map([[700_001, readEncounter]]);
  const guildRank = (firstDefeated: string): MythicBossRanking => ({
    bossSlug: "midnight-falls",
    rank: 3,
    guildName: "Fixture Guild Alfa",
    guildRealm: "twisting-nether",
    guildRegion: "eu",
    firstDefeated
  });

  function rank(
    rows: readonly MythicBossRanking[],
    overrides: Partial<Parameters<typeof rankRaiderIoFirstKills>[0]> = {}
  ) {
    const getMythicBossRankings = vi.fn(async () => ({
      kind: "rankings" as const,
      rows
    }));
    return {
      getMythicBossRankings,
      result: rankRaiderIoFirstKills({
        kills: [readKill],
        encounters,
        warcraftLogsKills: [],
        published: [],
        raiderio: { getMythicBossRankings },
        signal: new AbortController().signal,
        now: () => now,
        ...overrides
      })
    };
  }

  it("gives a later kill with a ranked guild no world rank: the guild's #3 is its own 8 Apr kill", async () => {
    // The problem's dates (#732), with a synthetic guild: the guild is world
    // #3 on Midnight Falls from 2026-04-08T14:54:22Z, and a 20 Jul kill with
    // the same guild must never borrow it.
    const { getMythicBossRankings, result } = rank([
      guildRank("2026-04-08T14:54:22.000Z")
    ]);

    expect(await result).toEqual([
      {
        ...readKill,
        historicWorldRank: null,
        historicRankCheckedAt: "2026-09-28T12:00:00.000Z"
      }
    ]);
    expect(getMythicBossRankings).toHaveBeenCalledWith(
      {
        raidSlug: "tier-mn-1",
        bossSlug: "midnight-falls",
        guild: killGuild
      },
      expect.any(AbortSignal),
      undefined
    );
  });

  it("ranks a guild's own first kill from the encounter guild's exact defeat", async () => {
    const { result } = rank([guildRank("2026-07-20T17:25:57.000Z")]);
    expect((await result)[0]?.historicWorldRank).toBe(3);
  });

  it("asks nothing for a kill a Warcraft Logs kill already matches", async () => {
    const { getMythicBossRankings, result } = rank([], {
      warcraftLogsKills: [
        {
          raidName: "March on Quel'Danas",
          bossName: "Midnight Falls",
          killedAt: "2026-07-20T18:25:00.000Z"
        }
      ]
    });
    expect(await result).toEqual([readKill]);
    expect(getMythicBossRankings).not.toHaveBeenCalled();
  });

  it.each([3, null])(
    "asks nothing again once a rank is checked, a null rank included (%s)",
    async (checkedRank) => {
      // Break caught (#734 pre-flight): a null rank was asked about again on
      // every run, up to 50 requests a run spent on answers that never change.
      const { getMythicBossRankings, result } = rank([], {
        published: [
          {
            ...readKill,
            historicWorldRank: checkedRank,
            historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
          }
        ]
      });
      expect(await result).toEqual([
        {
          ...readKill,
          historicWorldRank: checkedRank,
          historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
        }
      ]);
      expect(getMythicBossRankings).not.toHaveBeenCalled();
    }
  );

  it("asks nothing for a pug", async () => {
    const { getMythicBossRankings, result } = rank([], {
      encounters: new Map([[700_001, { ...readEncounter, guild: null }]])
    });
    expect(await result).toEqual([readKill]);
    expect(getMythicBossRankings).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no logged encounter",
      {
        ...readKill,
        loggedEncounterId: null,
        encounterState: "unavailable" as const
      }
    ],
    [
      "a logged encounter not yet read",
      {
        ...readKill,
        encounterState: "unavailable" as const,
        encounterLimitationCode: "request_cap"
      }
    ]
  ])(
    "asks nothing for a kill with %s, which is never a kill event of its own",
    async (_name, unread) => {
      // Break caught (#734 pre-flight): ranked from Raider.IO's attribution,
      // such kills cost rank requests the dossier could never show.
      const { getMythicBossRankings, result } = rank([], {
        kills: [unread],
        encounters: new Map()
      });
      expect(await result).toEqual([unread]);
      expect(getMythicBossRankings).not.toHaveBeenCalled();
    }
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/raiderio-first-kills.test.ts`
Expected: FAIL — cannot resolve `./raiderio-first-kills`.

- [ ] **Step 3: Implement the module**

Create `packages/application/src/raiderio-first-kills.ts`:

```ts
import type {
  CharacterRaiderIoFirstKillInput,
  RaiderIoLoggedEncounterAnswers,
  RaiderIoLoggedEncounterInput,
  RaiderIoLoggedEncounterUnavailableCode,
  RaiderIoLoggedEncounterUnavailableInput,
  StoredRaiderIoLoggedEncounter,
  StoredRaiderIoLoggedEncounterAnswers
} from "@slashwho/database";
import {
  lookupRaidEncounterByRaiderIoSlugs,
  matchesRaiderIoKill,
  supportedRegions,
  type CharacterKey
} from "@slashwho/domain";
import type {
  HistoricMythicKill,
  LoggedEncounter,
  MythicBossRanking,
  MythicBossRankingsOptions,
  RaiderIoEvidenceLimitation,
  RaiderIoGateway
} from "@slashwho/raiderio";

import { createConcurrencyLimiter } from "./concurrency";
import {
  historicWorldRankForKill,
  raiderIoRankingRequest,
  rankingRequestKey
} from "./historic-world-rank";

/** The same bounds as `raiderio_rankings`: 50 reads a run, four at a time. */
export const MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN = 50;
export const RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY = 4;
/** World-rank lookups for first kills no Warcraft Logs kill matches. */
export const MAX_RAIDER_IO_FIRST_KILL_RANK_REQUESTS_PER_RUN = 50;

const dayMs = 24 * 60 * 60 * 1_000;
/**
 * A roster read as hidden is read again after a week: a guild can open its
 * compositions after the kill. A visible roster is never read again, because
 * the kill and who was in it do not change.
 */
export const RAIDER_IO_PRIVATE_ROSTER_REREAD_MS = 7 * dayMs;
/**
 * A permanent refusal is asked again after 30 days, in case the log was
 * restored or re-uploaded. Until then it costs nothing and fills no cap.
 */
export const RAIDER_IO_UNAVAILABLE_ENCOUNTER_REREAD_MS = 30 * dayMs;

export type RaiderIoFirstKillLimitation = Readonly<{
  code: RaiderIoEvidenceLimitation;
  retryAfterMs?: number;
}>;

export type RaiderIoFirstKillCollection = Readonly<{
  kills: readonly CharacterRaiderIoFirstKillInput[];
  /** Every read encounter the kills name that is now stored, read or held before. */
  encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>;
  /** Why the phase fell short, or null. Only work a retry can finish counts. */
  limitation: RaiderIoFirstKillLimitation | null;
}>;

// A deleted log (`not_found`), a 403 (`private`) or one that names another
// boss (`schema_drift`) answers the same way every time: it is stored as an
// unavailable row and marks that kill's encounter unavailable, without
// holding the run partial.
function isPermanent(
  code: RaiderIoEvidenceLimitation
): code is RaiderIoLoggedEncounterUnavailableCode {
  return code === "not_found" || code === "private" || code === "schema_drift";
}

type Guild = CharacterRaiderIoFirstKillInput["guild"];

function encounterInput(
  loggedEncounterId: number,
  encounter: LoggedEncounter
): RaiderIoLoggedEncounterInput {
  return {
    loggedEncounterId,
    raidSlug: encounter.raidSlug,
    bossSlug: encounter.bossSlug,
    pulledAt: encounter.pulledAt,
    defeatedAt: encounter.defeatedAt,
    durationMs: encounter.durationMs,
    guild: encounter.guild ? { ...encounter.guild } : null,
    itemLevel: { ...encounter.itemLevel },
    deathCount: encounter.deathCount,
    vantusCount: encounter.vantusCount,
    rosterState:
      encounter.roster.state === "available" ? "available" : "private",
    members:
      encounter.roster.state === "available"
        ? encounter.roster.members.map((member) => ({ ...member }))
        : []
  };
}

function withoutReadAt(
  encounter: StoredRaiderIoLoggedEncounter
): RaiderIoLoggedEncounterInput {
  const { readAt, ...rest } = encounter;
  void readAt;
  return rest;
}

/**
 * Reads the logged encounter of every Raider.IO first kill that has one
 * (#732), and says which kills are the character's.
 *
 * What is stored decides what is read. A visible roster is never read again;
 * a hidden one is read again once a week old; a permanent refusal is asked
 * again once 30 days old. First reads come before re-reads, and all of them
 * share one bound, as `raiderio_rankings` does: 50 a run, four at a time, and
 * a read that throws abandons the rest. A kill counts as the character's only
 * when the roster holds the character's own Raider.IO id; where the roster is
 * hidden, Raider.IO's own attribution of the kill stands in for it.
 */
export async function collectRaiderIoFirstKills(
  input: Readonly<{
    key: CharacterKey;
    kills: readonly HistoricMythicKill[];
    /** The character's stored first kills: a `read` one has already passed its presence check. */
    published: readonly CharacterRaiderIoFirstKillInput[];
    storedEncounters: (
      ids: readonly number[]
    ) => Promise<StoredRaiderIoLoggedEncounterAnswers>;
    saveAnswers: (answers: RaiderIoLoggedEncounterAnswers) => Promise<void>;
    raiderio: Pick<RaiderIoGateway, "getLoggedEncounter"> &
      Partial<Pick<RaiderIoGateway, "getCharacter">>;
    signal: AbortSignal;
    now: () => Date;
    /** Called once per logged-encounter request actually sent. */
    onEncounterRequest?: () => void;
    /** Called once for the character read, if one is made. */
    onCharacterRequest?: () => void;
  }>
): Promise<RaiderIoFirstKillCollection> {
  const killById = new Map<number, HistoricMythicKill>();
  for (const kill of input.kills) {
    if (kill.loggedEncounterId != null)
      killById.set(kill.loggedEncounterId, kill);
  }
  const ids = [...killById.keys()];
  const stored: StoredRaiderIoLoggedEncounterAnswers =
    ids.length === 0
      ? { encounters: [], unavailable: [] }
      : await input.storedEncounters(ids);
  const at = input.now().getTime();

  const encounters = new Map<number, RaiderIoLoggedEncounterInput>();
  const storedRead = new Map<number, RaiderIoLoggedEncounterInput>();
  const storedUnavailable = new Map<
    number,
    RaiderIoLoggedEncounterUnavailableCode
  >();
  const due = new Set<number>();
  for (const encounter of stored.encounters) {
    const kept = withoutReadAt(encounter);
    encounters.set(encounter.loggedEncounterId, kept);
    storedRead.set(encounter.loggedEncounterId, kept);
    if (
      encounter.rosterState === "private" &&
      at - Date.parse(encounter.readAt) > RAIDER_IO_PRIVATE_ROSTER_REREAD_MS
    ) {
      due.add(encounter.loggedEncounterId);
    }
  }
  for (const answer of stored.unavailable) {
    storedUnavailable.set(answer.loggedEncounterId, answer.code);
    if (
      at - Date.parse(answer.readAt) >
      RAIDER_IO_UNAVAILABLE_ENCOUNTER_REREAD_MS
    ) {
      due.add(answer.loggedEncounterId);
    }
  }
  const held = (id: number) => encounters.has(id) || storedUnavailable.has(id);
  const unread = ids.filter((id) => !held(id));
  // A re-read already has an answer to show, so first reads go first. A
  // re-read the cap leaves out keeps its answer and limits nothing.
  const toRead = [...unread, ...ids.filter((id) => due.has(id))].slice(
    0,
    MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN
  );
  // This run's answer for an id no stored answer covers, or a fresh
  // permanent refusal, which replaces a stored one.
  const answered = new Map<number, RaiderIoEvidenceLimitation>(
    unread
      .slice(MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN)
      .map((id) => [id, "request_cap"] as const)
  );
  let limitation: RaiderIoFirstKillLimitation | null =
    unread.length > MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN
      ? { code: "request_cap" }
      : null;
  const fallShort = (next: RaiderIoFirstKillLimitation) => {
    limitation ??= next;
  };
  // A retryable miss matters only where nothing stored answers the id.
  const miss = (id: number, code: RaiderIoEvidenceLimitation) => {
    if (!held(id)) answered.set(id, code);
  };

  const limiter = createConcurrencyLimiter(
    RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY
  );
  let abandoned = false;
  const readNow: RaiderIoLoggedEncounterInput[] = [];
  const unavailableNow: RaiderIoLoggedEncounterUnavailableInput[] = [];
  const refuse = (id: number, code: RaiderIoLoggedEncounterUnavailableCode) => {
    const kept = storedRead.get(id);
    if (kept) {
      // A read is never unread. Saved again unchanged, the hidden roster's
      // `read_at` moves on and it is not asked about again for a week.
      readNow.push(kept);
      return;
    }
    answered.set(id, code);
    unavailableNow.push({ loggedEncounterId: id, code });
  };
  await Promise.all(
    toRead.map((id) =>
      limiter.run(async () => {
        if (abandoned) {
          miss(id, "unavailable");
          return;
        }
        const kill = killById.get(id)!;
        try {
          const result = await input.raiderio.getLoggedEncounter(
            kill.raidSlug,
            id,
            input.signal,
            input.onEncounterRequest
          );
          if (result.kind === "limitation") {
            if (isPermanent(result.code)) {
              refuse(id, result.code);
              return;
            }
            miss(id, result.code);
            fallShort({
              code: result.code,
              ...(result.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: result.retryAfterMs })
            });
            return;
          }
          if (
            result.raidSlug !== kill.raidSlug ||
            result.bossSlug !== kill.bossSlug
          ) {
            // The log names another boss than the kill it was listed under.
            refuse(id, "schema_drift");
            return;
          }
          readNow.push(encounterInput(id, result));
        } catch (error) {
          if (input.signal.aborted) throw error;
          abandoned = true;
          miss(id, "unavailable");
          fallShort({ code: "unavailable" });
        }
      })
    )
  );

  if (readNow.length > 0 || unavailableNow.length > 0) {
    try {
      await input.saveAnswers({
        encounters: readNow,
        unavailable: unavailableNow
      });
      for (const encounter of readNow) {
        encounters.set(encounter.loggedEncounterId, encounter);
      }
    } catch {
      // Unsaved, a new read would name an encounter no reader can find. A
      // stored answer stands; a refusal is still this run's true answer.
      for (const encounter of readNow) {
        miss(encounter.loggedEncounterId, "unavailable");
      }
      fallShort({ code: "unavailable" });
    }
  }

  const established = new Set(
    input.published.flatMap((kill) =>
      kill.encounterState === "read" && kill.loggedEncounterId !== null
        ? [kill.loggedEncounterId]
        : []
    )
  );
  const needsPresenceCheck = [...encounters.values()].some(
    (encounter) =>
      encounter.rosterState === "available" &&
      !established.has(encounter.loggedEncounterId)
  );
  const characterId = needsPresenceCheck
    ? await raiderIoCharacterId(input)
    : null;
  if (needsPresenceCheck && characterId === null) {
    fallShort({ code: "unavailable" });
  }

  const kills = input.kills.flatMap(
    (kill): CharacterRaiderIoFirstKillInput[] => {
      const base = {
        raidSlug: kill.raidSlug,
        bossSlug: kill.bossSlug,
        guild: (kill.guild ? { ...kill.guild } : null) satisfies Guild,
        historicWorldRank: null,
        historicRankCheckedAt: null
      };
      const id = kill.loggedEncounterId ?? null;
      if (id === null) {
        return [
          {
            ...base,
            killedAt: kill.firstDefeated,
            loggedEncounterId: null,
            encounterState: "unavailable",
            encounterLimitationCode: null
          }
        ];
      }
      const encounter = encounters.get(id);
      if (!encounter) {
        return [
          {
            ...base,
            killedAt: kill.firstDefeated,
            loggedEncounterId: id,
            encounterState: "unavailable",
            encounterLimitationCode:
              answered.get(id) ?? storedUnavailable.get(id) ?? "unavailable"
          }
        ];
      }
      if (encounter.rosterState === "available" && !established.has(id)) {
        // Where the id could not be learned the kill waits for a run that
        // can; the run is partial, so nothing stored is dropped meanwhile.
        if (characterId === null) return [];
        if (
          !encounter.members.some(
            (member) => member.raiderIoCharacterId === characterId
          )
        ) {
          return [];
        }
      }
      return [
        {
          ...base,
          killedAt: encounter.defeatedAt,
          loggedEncounterId: id,
          encounterState: "read",
          encounterLimitationCode: null
        }
      ];
    }
  );

  return { kills, encounters, limitation };
}

async function raiderIoCharacterId(
  input: Readonly<{
    key: CharacterKey;
    raiderio: Partial<Pick<RaiderIoGateway, "getCharacter">>;
    signal: AbortSignal;
    onCharacterRequest?: () => void;
  }>
): Promise<number | null> {
  if (!input.raiderio.getCharacter) return null;
  try {
    input.onCharacterRequest?.();
    const character = await input.raiderio.getCharacter(
      input.key,
      input.signal
    );
    return character.raiderIoCharacterId ?? null;
  } catch (error) {
    if (input.signal.aborted) throw error;
    return null;
  }
}

const rankKey = (
  kill: Pick<
    CharacterRaiderIoFirstKillInput,
    "raidSlug" | "bossSlug" | "loggedEncounterId"
  >
) => `${kill.raidSlug}\0${kill.bossSlug}\0${String(kill.loggedEncounterId)}`;

function rankable(
  kill: CharacterRaiderIoFirstKillInput,
  encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>
) {
  // Only a kill whose log was read stands as a kill event of its own, so only
  // it is worth a rank request; its guild is the encounter's own.
  if (kill.encounterState !== "read" || kill.loggedEncounterId === null)
    return null;
  const guild = encounters.get(kill.loggedEncounterId)?.guild;
  if (!guild) return null;
  const region = guild.region as CharacterKey["region"];
  if (!supportedRegions.includes(region)) return null;
  const catalogued = lookupRaidEncounterByRaiderIoSlugs(
    kill.raidSlug,
    kill.bossSlug
  );
  if (!catalogued) return null;
  const rankableKill = {
    raidName: catalogued.raidName,
    bossName: catalogued.bossName,
    killedAt: kill.killedAt,
    guild: { name: guild.name, realm: guild.realm }
  };
  const request = raiderIoRankingRequest(rankableKill, region);
  return request ? { rankableKill, region, request } : null;
}

/**
 * World ranks for read first kills no Warcraft Logs kill matches, from the
 * encounter's guild and exact defeat time through `historicWorldRankForKill`.
 * A guild's first kill gets its rank and a later kill with the same guild gets
 * none. A matched kill keeps the Warcraft Logs lookup it already has. A rank
 * once checked is kept with its check time, a null rank included, and never
 * asked about again. Never limits the phase: a lookup that fails is simply
 * made again next run.
 */
export async function rankRaiderIoFirstKills(
  input: Readonly<{
    kills: readonly CharacterRaiderIoFirstKillInput[];
    encounters: ReadonlyMap<number, RaiderIoLoggedEncounterInput>;
    warcraftLogsKills: readonly Readonly<{
      raidName: string;
      bossName?: string;
      killedAt: string;
    }>[];
    published: readonly CharacterRaiderIoFirstKillInput[];
    raiderio: Pick<RaiderIoGateway, "getMythicBossRankings">;
    signal: AbortSignal;
    now: () => Date;
    onPhysicalRequest?: () => void;
  }>
): Promise<readonly CharacterRaiderIoFirstKillInput[]> {
  const checked = new Map(
    input.published
      .filter((kill) => kill.historicRankCheckedAt !== null)
      .map((kill) => [rankKey(kill), kill] as const)
  );
  const candidates = input.kills.flatMap((kill) => {
    if (checked.has(rankKey(kill))) return [];
    if (
      input.warcraftLogsKills.some((stored) =>
        matchesRaiderIoKill(kill, stored)
      )
    )
      return [];
    const found = rankable(kill, input.encounters);
    return found ? [{ kill, ...found }] : [];
  });
  const requests = new Map<string, MythicBossRankingsOptions>();
  for (const candidate of candidates) {
    requests.set(rankingRequestKey(candidate.request), candidate.request);
  }
  const results = new Map<string, readonly MythicBossRanking[]>();
  const limiter = createConcurrencyLimiter(
    RAIDER_IO_LOGGED_ENCOUNTER_CONCURRENCY
  );
  let abandoned = false;
  await Promise.all(
    [...requests]
      .slice(0, MAX_RAIDER_IO_FIRST_KILL_RANK_REQUESTS_PER_RUN)
      .map(([requestKey, request]) =>
        limiter.run(async () => {
          if (abandoned) return;
          try {
            const result = await input.raiderio.getMythicBossRankings(
              request,
              input.signal,
              input.onPhysicalRequest
            );
            if (result.kind === "rankings")
              results.set(requestKey, result.rows);
          } catch (error) {
            if (input.signal.aborted) throw error;
            abandoned = true;
          }
        })
      )
  );
  const checkedAt = input.now().toISOString();
  const ranks = new Map<CharacterRaiderIoFirstKillInput, number | null>();
  for (const candidate of candidates) {
    const rows = results.get(rankingRequestKey(candidate.request));
    if (rows) {
      ranks.set(
        candidate.kill,
        historicWorldRankForKill(candidate.rankableKill, candidate.region, rows)
      );
    }
  }
  return input.kills.map((kill) => {
    const before = checked.get(rankKey(kill));
    if (before) {
      return {
        ...kill,
        historicWorldRank: before.historicWorldRank,
        historicRankCheckedAt: before.historicRankCheckedAt
      };
    }
    return ranks.has(kill)
      ? {
          ...kill,
          historicWorldRank: ranks.get(kill)!,
          historicRankCheckedAt: checkedAt
        }
      : kill;
  });
}
```

- [ ] **Step 4: Run the module tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/raiderio-first-kills.test.ts`
Expected: PASS.

- [ ] **Step 5: Hand back every first kill from `raiderIoVerifiedKills`**

Add to `packages/application/src/verified-kills.test.ts`, inside its `describe` for `raiderIoVerifiedKills` (or at the end of the file):

```ts
it("hands back every first kill and the raids its tiers answer for (#732)", async () => {
  const midnightFalls: HistoricMythicKill = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    firstDefeated: "2026-07-20T17:25:57.000Z",
    guild: null,
    loggedEncounterId: 700_001
  };
  const result = await raiderIoVerifiedKills(
    {
      getHistoricMythicKills: async () => ({
        kind: "evidence",
        kills: [midnightFalls]
      })
    },
    key,
    { storedKills: [], killScanFloor: "2026-09-20T00:00:00.000Z" }
  );

  // No guild, so never a place to search -- and still a first kill.
  expect(result.kills).toEqual([]);
  expect(result.firstKills).toEqual([midnightFalls]);
  expect(result.askedRaidSlugs).toEqual(["tier-mn-1"]);
});
```

Run: `corepack pnpm exec vitest run --project unit packages/application/src/verified-kills.test.ts`
Expected: FAIL — `firstKills` is undefined.

In `packages/application/src/verified-kills.ts`, add to `VerifiedKillsResult`:

```ts
  /**
   * Every first kill Raider.IO answered with, before any is filtered as a
   * search hint (#732). Absent when Raider.IO could not answer.
   */
  firstKills?: readonly HistoricMythicKill[];
  /** The raids the asked tiers answer for, and any a kill came back from. */
  askedRaidSlugs?: readonly string[];
```

Replace the top-of-function doc comment's "Never evidence: a kill counts only once a hydrated log attributes it." with "A plain kill is never evidence: it counts only once a hydrated log attributes it, or once Raider.IO's own logged encounter of it is read (#732)." In `raiderIoVerifiedKills`, compute the tiers once and pass them to the request:

```ts
  const tierOrdinals = historicTierOrdinalsFrom(options.killScanFloor);
  let result: Awaited<ReturnType<RaiderIoGateway["getHistoricMythicKills"]>>;
  try {
    result = await raiderio.getHistoricMythicKills(key, {
      tierOrdinals,
```

and return the new fields:

```ts
return {
  kills: searchableKills(result.kills, options),
  guilds: raiderIoGuilds(result.kills),
  firstKills: result.kills,
  askedRaidSlugs: [
    ...new Set([
      ...raiderIoHistoricTiers
        .filter((tier) => tierOrdinals.includes(tier.ordinal))
        .flatMap((tier) => tier.raidSlugs),
      ...result.kills.map((kill) => kill.raidSlug)
    ])
  ].sort()
};
```

Run: `corepack pnpm exec vitest run --project unit packages/application/src/verified-kills.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the phase to the plan, the contract and the progress label**

In `packages/application/src/evidence-phase-ledger.ts`, add `| "raiderio_logged_encounters"` after `"raiderio_rankings"` in `EvidencePhaseId`, and in both `providers` and `collection`:

```ts
      ...(input.raiderIo
        ? (["raiderio_rankings", "raiderio_logged_encounters"] as const)
        : []),
```

In `packages/contracts/src/dossier.ts`, add `"raiderio_logged_encounters",` after `"raiderio_rankings",` in `collectionPhaseSchema`. In `apps/web/src/components/collection-progress.tsx`, add to `stepLabel`:

```ts
  raiderio_logged_encounters: "Reading Raider.IO kill logs",
```

Insert `"raiderio_logged_encounters",` directly after `"raiderio_rankings",` in every phase-plan array literal that lists the full plan in tests: `packages/application/src/applicant-evidence-job-handler.test.ts` lines 4381, 4453, 4509, 4568, 4629, 4681, 4772, 4847, 5420, 6358; `packages/application/src/resume-waiting-evidence.test.ts` lines 62 and 114; `packages/application/src/applicant-dossier-service.test.ts` line 788. (Each is followed by `"blizzard_achievements",`. A run whose reserved phases are not the whole plan gets no ledger at all, `applicant-evidence-job-handler.ts:1493-1523`, so a stale list silently drops every transition those tests assert.)

Run: `corepack pnpm exec vitest run --project unit packages/application/src/evidence-phase-ledger.test.ts packages/application/src/resume-waiting-evidence.test.ts apps/web/src/components/collection-progress.test.tsx`
Expected: PASS.

- [ ] **Step 7: Carry the publication through the stage**

In `packages/application/src/evidence-publication.ts`, import `RaiderIoFirstKillsPublication` from `@slashwho/database`, add to `EvidencePublication` (after `cuttingEdges`):

```ts
  /**
   * The run's Raider.IO first kills (#732). Absent when the run did not read
   * the kill list, and storage then carries every stored one forward.
   */
  raiderIoFirstKills?: RaiderIoFirstKillsPublication;
```

In `toStagedCollection`, after `cuttingEdges: publication.cuttingEdges,`:

```ts
    ...(publication.raiderIoFirstKills
      ? { raiderIoFirstKills: publication.raiderIoFirstKills }
      : {}),
```

In `fromStagedCollection`, after `cuttingEdges: staged.cuttingEdges ?? [],`:

```ts
    ...(staged.raiderIoFirstKills
      ? { raiderIoFirstKills: staged.raiderIoFirstKills }
      : {}),
```

- [ ] **Step 8: Write the failing handler tests**

In `packages/application/src/applicant-evidence-job-handler.test.ts`, add `fullEvidencePhasePlan` to the imports (`import { fullEvidencePhasePlan } from "./evidence-phase-ledger";`), `CharacterRaiderIoFirstKillInput` and `RaiderIoLoggedEncounterAnswers` to the `@slashwho/database` type import, and a value import of the storage merge (a pure function; the dossier web tests already import `@slashwho/database` values):

```ts
import { mergeRaiderIoFirstKills } from "@slashwho/database";
```

In the exact cost-row expectation of `"records the spend, the caps in force and the requests it issued"` (line 2953-2966), add after `raiderIoRankings: 0,`:

```ts
              raiderIoLoggedEncounters: 0,
```

Append a new `describe` inside the top-level `describe("applicant evidence job handler", ...)`:

```ts
describe("Raider.IO-logged first kills (#732)", () => {
  // Synthetic identities throughout: this repository is public.
  const killGuild = {
    name: "Fixture Guild Alfa",
    realm: "twisting-nether",
    region: "eu"
  };
  const midnightFalls = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    firstDefeated: "2026-07-20T17:25:57.000Z",
    guild: killGuild,
    loggedEncounterId: 700_001
  };
  const encounter = {
    kind: "encounter" as const,
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    guild: killGuild,
    deathCount: 2,
    vantusCount: 16,
    roster: {
      state: "available" as const,
      members: [
        {
          raiderIoCharacterId: 424_242,
          name: "Alfa",
          realm: "silvermoon",
          region: "eu",
          className: "Demon Hunter",
          specName: "Havoc",
          role: "dps" as const,
          itemLevel: 290.5
        }
      ]
    }
  };
  const storedFirstKill: CharacterRaiderIoFirstKillInput = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: encounter.defeatedAt,
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: null
  };
  const noKills = {
    kind: "evidence" as const,
    parsedFightUrls: [],
    kills: [],
    wipes: [],
    tierBests: [],
    troubledRaidIds: { parses: [], tierBests: [] }
  };

  function raiderIo(
    overrides: Partial<
      Pick<
        RaiderIoGateway,
        "getHistoricMythicKills" | "getLoggedEncounter" | "getCharacter"
      >
    > = {}
  ) {
    return {
      getMythicBossRankings: vi.fn(async () => ({
        kind: "rankings" as const,
        rows: []
      })),
      getHistoricMythicKills: vi.fn(async () => ({
        kind: "evidence" as const,
        kills: [midnightFalls]
      })),
      getLoggedEncounter: vi.fn(
        async (
          _raidSlug: string,
          _id: number,
          _signal?: AbortSignal,
          onPhysicalRequest?: () => void
        ) => {
          onPhysicalRequest?.();
          return encounter;
        }
      ),
      getCharacter: vi.fn(async () => ({
        key,
        displayName: "Alfa",
        className: "Demon Hunter",
        level: 90,
        guild: null,
        ownerId: null,
        profileGuess: null,
        declaredMain: null,
        raiderIoCharacterId: 424_242
      })),
      ...overrides
    };
  }

  function loggedStore() {
    const evidence = store();
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const transitions: Array<{ id: string; state: string }> = [];
    evidence.saveRaiderIoLoggedEncounters = async (answers) => {
      saved.push(answers);
    };
    evidence.raiderIoLoggedEncounters = async () => ({
      encounters: [],
      unavailable: []
    });
    evidence.storedRaiderIoFirstKills = async () => [];
    evidence.listPhases = async () =>
      fullEvidencePhasePlan().map((id, ordinal) => ({
        id,
        ordinal,
        state: "pending" as const,
        startedAt: null,
        completedAt: null,
        limitationCode: null
      }));
    evidence.recordPhaseTransitions = async (_runId, phases) => {
      transitions.push(...phases.map(({ id, state }) => ({ id, state })));
    };
    return Object.assign(evidence, { saved, transitions });
  }

  function loggedHandler(
    evidence: ReturnType<typeof loggedStore>,
    raiderio: ReturnType<typeof raiderIo>
  ) {
    return handlerFor({
      evidence,
      warcraftLogs: {
        getFirstKillReports: vi.fn(async () => noKills),
        ...openGate
      } as unknown as Pick<
        WarcraftLogsGateway,
        "getFirstKillReports" | "getRateLimit"
      >,
      raiderio,
      pointsReserve: 0,
      now: () => new Date("2026-09-28T12:00:00.000Z")
    });
  }

  it("publishes each first kill with its logged encounter read and stored", async () => {
    const evidence = loggedStore();

    await loggedHandler(evidence, raiderIo()).execute(run.id);

    expect(evidence.saved).toEqual([
      {
        encounters: [expect.objectContaining({ loggedEncounterId: 700_001 })],
        unavailable: []
      }
    ]);
    const published = evidence.published[0]!.result;
    expect(published.state).toBe("complete");
    expect(published.raiderIoFirstKills).toMatchObject({
      limitationCode: null,
      kills: [
        {
          raidSlug: "tier-mn-1",
          bossSlug: "midnight-falls",
          killedAt: "2026-07-20T17:25:57.301Z",
          loggedEncounterId: 700_001,
          encounterState: "read",
          historicWorldRank: null
        }
      ]
    });
    expect(published.raiderIoFirstKills?.askedRaidSlugs).toContain("tier-mn-1");
    expect(evidence.transitions).toContainEqual({
      id: "raiderio_logged_encounters",
      state: "completed"
    });
  });

  it("makes the run partial, and retries it, when a read fails", async () => {
    const evidence = loggedStore();
    const raiderio = raiderIo({
      getLoggedEncounter: vi.fn(async () => {
        throw new Error("raiderio_down");
      })
    });

    await loggedHandler(evidence, raiderio).execute(run.id);

    const published = evidence.published[0]!.result;
    expect(published.state).toBe("partial");
    expect(published.raiderIoFirstKills).toMatchObject({
      limitationCode: "unavailable",
      kills: [
        {
          encounterState: "unavailable",
          encounterLimitationCode: "unavailable"
        }
      ]
    });
    // transientRetryMs is 900 000 in DEFAULT_HANDLER_OPTIONS.
    expect(published.retryAfterAt).toEqual(
      new Date("2026-09-28T12:15:00.000Z")
    );
    expect(evidence.transitions).toContainEqual({
      id: "raiderio_logged_encounters",
      state: "limited"
    });
  });

  it("drains a capped backlog on ordinary runs, never on a cap retry", async () => {
    // Break caught (#734 review): at rollout every long-time Mythic raider has
    // more than 50 unread logs. A cap retry would be a whole evidence run,
    // spending Warcraft Logs points to read Raider.IO.
    const evidence = loggedStore();
    const raiderio = raiderIo({
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
    });

    await loggedHandler(evidence, raiderio).execute(run.id);

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(50);
    const published = evidence.published[0]!.result;
    expect(published.state).toBe("partial");
    expect(published.raiderIoFirstKills?.limitationCode).toBe("request_cap");
    expect(published).not.toHaveProperty("retryAfterAt");
  });

  it("carries stored first kills forward when Raider.IO cannot answer", async () => {
    // Break caught: a complete publish with an empty Raider.IO section would
    // drop every first kill a private profile once had.
    const evidence = loggedStore();
    const stored = [storedFirstKill];
    evidence.storedRaiderIoFirstKills = async () => stored;
    const raiderio = raiderIo({
      getHistoricMythicKills: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "private" as const
      }))
    });

    await loggedHandler(evidence, raiderio).execute(run.id);

    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalled();
    const published = evidence.published[0]!.result;
    expect(published).not.toHaveProperty("raiderIoFirstKills");
    expect(published.state).toBe("complete");
    // What storage writes from this publication, by the rule storage applies.
    expect(
      mergeRaiderIoFirstKills(
        stored,
        published.raiderIoFirstKills,
        published.state,
        false
      )
    ).toEqual([storedFirstKill]);
  });

  it("reads nothing already stored and asks no id it already holds", async () => {
    const evidence = loggedStore();
    evidence.raiderIoLoggedEncounters = async () => ({
      encounters: [
        {
          loggedEncounterId: 700_001,
          raidSlug: "tier-mn-1",
          bossSlug: "midnight-falls",
          pulledAt: encounter.pulledAt,
          defeatedAt: encounter.defeatedAt,
          durationMs: encounter.durationMs,
          guild: encounter.guild,
          itemLevel: encounter.itemLevel,
          deathCount: 2,
          vantusCount: 16,
          rosterState: "available",
          members: encounter.roster.members,
          readAt: "2026-09-01T00:00:00.000Z"
        }
      ],
      unavailable: []
    });
    evidence.storedRaiderIoFirstKills = async () => [storedFirstKill];
    const raiderio = raiderIo();

    await loggedHandler(evidence, raiderio).execute(run.id);

    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalled();
    expect(raiderio.getCharacter).not.toHaveBeenCalled();
    expect(evidence.saved).toEqual([]);
    expect(
      evidence.published[0]!.result.raiderIoFirstKills?.kills
    ).toHaveLength(1);
  });

  it("counts each logged-encounter read on the cost row, and the character read with the kill list's", async () => {
    const evidence = loggedStore();

    await loggedHandler(evidence, raiderIo()).execute(run.id);

    expect(evidence.costs).toEqual([
      expect.objectContaining({
        requests: expect.objectContaining({
          raiderIoLoggedEncounters: 1,
          // The profile read that learned the character's Raider.IO id.
          raiderIoHistoric: 1
        })
      })
    ]);
  });
});
```

Run: `corepack pnpm exec vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts -t "Raider.IO-logged first kills"`
Expected: FAIL — the store has no `saveRaiderIoLoggedEncounters` member in its type, and no publication carries `raiderIoFirstKills`.

- [ ] **Step 9: Wire the phase into the handler**

In `packages/application/src/applicant-evidence-job-handler.ts`:

Add to the `@slashwho/database` type import: `CharacterRaiderIoFirstKillInput`, `RaiderIoFirstKillsPublication`, `RaiderIoLoggedEncounterAnswers`, `StoredRaiderIoLoggedEncounterAnswers`. Add:

```ts
import {
  collectRaiderIoFirstKills,
  rankRaiderIoFirstKills,
  type RaiderIoFirstKillLimitation
} from "./raiderio-first-kills";
```

Add to `ApplicantEvidenceStore`, after `collectedTierZones`:

```ts
  /** The first kills of the character's newest publication (#732). */
  storedRaiderIoFirstKills?(
    key: CharacterKey
  ): Promise<readonly CharacterRaiderIoFirstKillInput[]>;
  /** The stored answers among these logged-encounter ids. */
  raiderIoLoggedEncounters?(
    ids: readonly number[]
  ): Promise<StoredRaiderIoLoggedEncounterAnswers>;
  /** Stores a run's logged-encounter answers, outside the snapshot transaction. */
  saveRaiderIoLoggedEncounters?(
    answers: RaiderIoLoggedEncounterAnswers,
    readAt: Date
  ): Promise<void>;
```

and to its `publish` input, after `cuttingEdges?`:

```ts
      raiderIoFirstKills?: RaiderIoFirstKillsPublication;
```

Widen the `raiderio` option:

```ts
  raiderio?: Pick<RaiderIoGateway, "getMythicBossRankings"> &
    Partial<
      Pick<
        RaiderIoGateway,
        "getHistoricMythicKills" | "getLoggedEncounter" | "getCharacter"
      >
    >;
```

In the cost row's `requests` (line 1236), after `raiderIoRankings: requests("raiderIoRankings"),`:

```ts
            raiderIoLoggedEncounters: requests("raiderIoLoggedEncounter"),
```

Directly after the closing brace of `if (options.raiderio && !targeted) { ... }` (the `raiderio_rankings` block) and before `let cuttingEdges`, add:

```ts
// Raider.IO's parsed combat log of each first kill (#732). Read only
// when this run read the kill list: without it there is nothing to
// look up, and storage carries every stored first kill forward.
let raiderIoFirstKills: RaiderIoFirstKillsPublication | undefined;
let raiderIoShortfall: RaiderIoFirstKillLimitation | null = null;
const raiderIoLogs = options.raiderio;
const getLoggedEncounter = raiderIoLogs?.getLoggedEncounter;
if (!targeted && raiderIoLogs && getLoggedEncounter && verified?.firstKills) {
  const firstKills = verified.firstKills;
  const logged = firstKills.some((kill) => kill.loggedEncounterId != null);
  await phaseLedger?.transition(
    "raiderio_logged_encounters",
    logged ? "active" : "skipped"
  );
  try {
    const published =
      (await evidence.storedRaiderIoFirstKills?.(run.key)) ?? [];
    const collected = await scope.time("raiderIoLoggedEncounters", () =>
      collectRaiderIoFirstKills({
        key: run.key,
        kills: firstKills,
        published,
        storedEncounters: async (ids) =>
          (await evidence.raiderIoLoggedEncounters?.(ids)) ?? {
            encounters: [],
            unavailable: []
          },
        saveAnswers: async (answers) => {
          await evidence.saveRaiderIoLoggedEncounters?.(answers, now());
        },
        raiderio: {
          getLoggedEncounter,
          ...(raiderIoLogs.getCharacter
            ? { getCharacter: raiderIoLogs.getCharacter }
            : {})
        },
        signal: activeContext.signal,
        now,
        onEncounterRequest: () =>
          scope.increment("raiderIoLoggedEncounterRequests"),
        // A Raider.IO character read, counted with the kill list's
        // character reads rather than with the encounters.
        onCharacterRequest: () => scope.increment("raiderIoHistoricRequests")
      })
    );
    const ranked = await rankRaiderIoFirstKills({
      kills: collected.kills,
      encounters: collected.encounters,
      warcraftLogsKills: [...publishedKills, ...storedEvidence.kills],
      published,
      raiderio: raiderIoLogs,
      signal: activeContext.signal,
      now,
      onPhysicalRequest: () => scope.increment("raiderIoRankingsRequests")
    });
    raiderIoShortfall = collected.limitation;
    raiderIoFirstKills = {
      kills: ranked,
      askedRaidSlugs: verified.askedRaidSlugs ?? [],
      limitationCode: collected.limitation?.code ?? null
    };
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

Change `retryAfterMs` so a Raider.IO shortfall asks for its own retry, except a cap:

```ts
const retryAfterMs = Math.max(
  retryDelayMs(response.limitation) ?? 0,
  retryDelayMs(drivingParse) ?? 0,
  // A capped Raider.IO backlog drains on ordinary runs, 50 at a time.
  // A cap retry would be a whole evidence run, spending Warcraft Logs
  // points to read Raider.IO (#732).
  retryDelayMs(
    raiderIoShortfall?.code === "request_cap" ? null : raiderIoShortfall
  ) ?? 0
);
```

(`RaiderIoEvidenceLimitation` codes are all `WarcraftLogsLimitationCode` members, so `retryDelayMs` accepts `raiderIoShortfall` as it is.) Change `incomplete` (a `??` chain stops at a `false` `scanSkipped`, so the Raider.IO code is joined with `||`):

```ts
const incomplete =
  Boolean(
    response.limitation ??
    drivingParse ??
    (targeted ? undefined : response.scanSkipped)
  ) || raiderIoFirstKills?.limitationCode != null;
```

In the main `stageAndPublish` call, add after `cuttingEdges,`:

```ts
            ...(raiderIoFirstKills ? { raiderIoFirstKills } : {}),
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src`
Expected: PASS, including the six new handler tests, the updated cost-row expectation, and every existing phase-transition test.

Run: `corepack pnpm --filter @slashwho/application typecheck && corepack pnpm --filter @slashwho/contracts typecheck && corepack pnpm --filter @slashwho/worker typecheck && corepack pnpm --filter @slashwho/web typecheck`
Expected: all exit 0. If the worker reports that its `raiderio: gateway` is not assignable, the discovery gateway's `getCharacter` return type has diverged from `@slashwho/raiderio`'s `RaiderIoCharacter`; widen `createGateway`'s return type in `apps/worker/src/runtime.ts:138-143` to include `Pick<EvidenceRaiderIoGateway, "getMythicBossRankings" | "getLoggedEncounter" | "getCharacter">` rather than casting.

- [ ] **Step 11: Commit**

```bash
git add packages/application packages/contracts/src/dossier.ts apps/web/src/components/collection-progress.tsx apps/worker
git commit -m "feat(application): read Raider.IO logged encounters of first kills as an evidence phase (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Domain, contract and dossier service: Raider.IO first kills become kill events with a roster

**Files:**

- Modify: `packages/domain/src/applicant-dossier.ts` (types 16-198, `withhold` 547-561, the kills loop 562-584, `buildApplicantDossier` 511-877)
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/applicant-dossier.test.ts`
- Modify: `packages/contracts/src/dossier.ts:159-170`, `packages/contracts/src/index.ts`, `packages/contracts/src/contracts.test.ts`
- Create: `packages/application/src/raiderio-first-kill-evidence.ts`
- Test: `packages/application/src/raiderio-first-kill-evidence.test.ts`
- Modify: `packages/application/src/applicant-dossier-service.ts` (`EvidenceResult` 248-262, the evidence builder return ~493-545 with `warcraftLogsComplete` at 510-516, `mergeIdentityEvidence` 588-630, `buildApplicantDossier` call ~930-948), `applicant-dossier-service.test.ts` (fixture 72-345, the parse-budget test at 965-981)

**Interfaces:**

- Consumes: `STORED_KILL_MATCH_MS`, `matchesRaiderIoKill`, `lookupRaidEncounterByRaiderIoSlugs` (Task 3); `isRosterShown` (Task 2); `StoredCharacterRaiderIoFirstKill`, `PublishedRaiderIoLoggedEncounter`, `CharacterEvidenceRun.raiderIoLimitationCode`, `CharacterEvidenceRun.killScanSkipped` (Task 4).
- Produces (exported from `@slashwho/domain`):

```ts
export type DossierRosterRole = "tank" | "healer" | "dps";
export type DossierRosterMember = Readonly<{
  name: string;
  realm: string;
  region: string;
  className: string;
  specName: string;
  role: DossierRosterRole;
  itemLevel: number | null;
}>;
export type DossierLoggedEncounter = Readonly<{
  pulledAt: string;
  defeatedAt: string;
  durationMs: number;
  guild: DossierKillEvidence["guild"];
  itemLevel: Readonly<{ average: number; min: number; max: number }>;
  deathCount: number;
  vantusCount: number;
  roster:
    | Readonly<{
        state: "available";
        /** Everyone Raider.IO listed, by role, including raiders `members` leaves out. */
        roleCounts: Readonly<Record<DossierRosterRole, number>>;
        /** The raiders a dossier may name: suppressed ones already left out. */
        members: readonly DossierRosterMember[];
      }>
    | Readonly<{ state: "private" }>;
}>;
export type DossierRaiderIoFirstKill = Readonly<{
  character: CharacterKey;
  raidSlug: string;
  bossSlug: string;
  killedAt: string;
  guild: DossierKillEvidence["guild"];
  historicWorldRank: number | null;
  encounter:
    | Readonly<{ state: "read"; encounter: DossierLoggedEncounter }>
    | Readonly<{ state: "not_read" }>
    | Readonly<{ state: "none" }>;
}>;
export type ApplicantDossierRosterMember = DossierRosterMember &
  Readonly<{ isDossierCharacter: boolean }>;
export type ApplicantDossierKillRoster =
  | Readonly<{
      state: "available";
      playerCount: number;
      roleCounts: Readonly<Record<DossierRosterRole, number>>;
      itemLevel: Readonly<{ average: number; min: number; max: number }>;
      pulledAt: string;
      durationMs: number;
      deathCount: number;
      vantusCount: number;
      members: readonly ApplicantDossierRosterMember[];
    }>
  | Readonly<{
      state: "unavailable";
      reason: "private" | "no_logged_encounter" | "not_read";
    }>;
// BuildApplicantDossierInput gains raiderIoFirstKills?: readonly DossierRaiderIoFirstKill[]
// ApplicantDossierFirstKill gains roster?: ApplicantDossierKillRoster
```

From `@slashwho/contracts`: `dossierRosterMemberSchema`, `dossierKillRosterSchema`, type `DossierKillRoster`; `dossierFirstKillSchema` gains `roster: dossierKillRosterSchema.optional()`.
From the application: `dossierRaiderIoFirstKill(kill: StoredCharacterRaiderIoFirstKill, character: CharacterKey): DossierRaiderIoFirstKill`.

- [ ] **Step 1: Write the failing domain tests**

Append to `packages/domain/src/applicant-dossier.test.ts` (add `ApplicantDossier`, `DossierLoggedEncounter` and `DossierRaiderIoFirstKill` to the `./applicant-dossier` type import):

```ts
describe("Raider.IO-logged first kills (#732)", () => {
  // Synthetic identities throughout: this repository is public.
  const alfaKey: CharacterKey = {
    region: "eu",
    realm: "draenor",
    name: "alfa"
  };
  const alfa = { key: alfaKey, displayName: "Alfa" };
  const killGuild = {
    name: "Fixture Guild Alfa",
    region: "eu" as const,
    realm: "twisting-nether"
  };
  const members = [
    {
      name: "Charlie",
      realm: "twisting-nether",
      region: "eu",
      className: "Priest",
      specName: "Holy",
      role: "healer" as const,
      itemLevel: 291.4
    },
    {
      name: "Alfa",
      realm: "draenor",
      region: "eu",
      className: "Demon Hunter",
      specName: "Havoc",
      role: "dps" as const,
      itemLevel: null
    },
    {
      name: "Bravo",
      realm: "twisting-nether",
      region: "eu",
      className: "Warrior",
      specName: "Protection",
      role: "tank" as const,
      itemLevel: 292.1
    }
  ];
  const loggedEncounter: DossierLoggedEncounter = {
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    guild: killGuild,
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    deathCount: 2,
    vantusCount: 16,
    roster: {
      state: "available",
      roleCounts: { tank: 1, healer: 1, dps: 1 },
      members
    }
  };
  function raiderIoKill(
    overrides: Partial<DossierRaiderIoFirstKill> = {}
  ): DossierRaiderIoFirstKill {
    return {
      character: alfaKey,
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      historicWorldRank: null,
      encounter: { state: "read", encounter: loggedEncounter },
      ...overrides
    };
  }
  const damageParse = {
    damage: { state: "available" as const, percentile: 88 },
    healing: { state: "not_applicable" as const },
    bossDamage: { state: "unavailable" as const }
  };
  function midnightFallsKill(
    character: CharacterKey,
    overrides: Partial<DossierKillEvidence> = {}
  ): DossierKillEvidence {
    return kill(character, {
      raidId: "1308",
      raidName: "March on Quel'Danas",
      bossId: "2740",
      bossName: "Midnight Falls",
      journalBossId: "2740",
      bossOrder: 2,
      killedAt: "2026-07-20T18:25:00.000Z",
      guild: killGuild,
      historicWorldRank: null,
      reportUrl: "https://www.warcraftlogs.com/reports/fixturealfa#fight=9",
      performance: damageParse,
      ...overrides
    });
  }
  function boss(dossier: ApplicantDossier, bossName = "Midnight Falls") {
    const found = dossier.raids
      .flatMap((raid) => raid.bosses)
      .find((item) => item.bossName === bossName);
    if (!found) throw new Error("boss_not_found");
    return found;
  }
  const availableRoster = {
    state: "available",
    playerCount: 3,
    roleCounts: { tank: 1, healer: 1, dps: 1 },
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    pulledAt: "2026-07-20T17:17:29.977Z",
    durationMs: 507_324,
    deathCount: 2,
    vantusCount: 16,
    members: [
      { ...members[2], isDossierCharacter: false },
      { ...members[0], isDossierCharacter: false },
      { ...members[1], isDossierCharacter: true }
    ]
  };

  it("shows a logged kill with no public logs as a kill of its own, with its guild and roster", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [raiderIoKill()],
      limitations: []
    });

    const midnightFalls = verifiedKill(boss(dossier));
    expect(midnightFalls.firstKill).toEqual({
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      historicWorldRank: null,
      reportUrl: null,
      reportUrls: [],
      reports: [],
      characters: [alfaKey],
      parses: [],
      roster: availableRoster
    });
    expect(midnightFalls.bestParses).toEqual([]);
  });

  it("counts every raider Raider.IO listed, shown or not", () => {
    // A raider removed from SlashWho is left off the list before it gets
    // here (#734 review), but the raid still had twenty players.
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [
        raiderIoKill({
          encounter: {
            state: "read",
            encounter: {
              ...loggedEncounter,
              roster: {
                state: "available",
                roleCounts: { tank: 2, healer: 4, dps: 14 },
                members
              }
            }
          }
        })
      ],
      limitations: []
    });

    expect(verifiedKill(boss(dossier)).firstKill.roster).toMatchObject({
      state: "available",
      playerCount: 20,
      roleCounts: { tank: 2, healer: 4, dps: 14 },
      members: availableRoster.members
    });
  });

  it("shows a roster left with nobody to name as hidden, never as an empty table", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [
        raiderIoKill({
          encounter: {
            state: "read",
            encounter: {
              ...loggedEncounter,
              roster: {
                state: "available",
                roleCounts: { tank: 1, healer: 0, dps: 0 },
                members: []
              }
            }
          }
        })
      ],
      limitations: []
    });

    expect(verifiedKill(boss(dossier)).firstKill.roster).toEqual({
      state: "unavailable",
      reason: "private"
    });
  });

  it("makes the boss a kill, not a boss with no logs", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      wipes: [],
      completeWarcraftLogsCharacters: [alfaKey],
      raiderIoFirstKills: [raiderIoKill()],
      limitations: []
    });

    expect(boss(dossier).state).toBe("kill");
    expect(boss(dossier, "Belo'ren, Child of Al'ar").state).toBe("no_logs");
  });

  it("lends a matching Warcraft Logs kill the roster and changes nothing else about it", () => {
    const warcraftLogs = midnightFallsKill(alfaKey);
    const without = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [warcraftLogs],
      limitations: []
    });
    const withRoster = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [warcraftLogs],
      raiderIoFirstKills: [raiderIoKill()],
      limitations: []
    });

    const before = verifiedKill(boss(without));
    const after = verifiedKill(boss(withRoster));
    expect(after.firstKills).toHaveLength(1);
    expect(after.firstKill).toEqual({
      ...before.firstKill,
      roster: availableRoster
    });
    expect(after.bestParses).toEqual(before.bestParses);
  });

  it("keeps a kill just outside the tolerance in the same-date event, dated by the earlier", () => {
    // 2 h 1 min after Raider.IO's time: not the same kill, but the dossier's
    // same-region, same-date grouping still shows one event for the night.
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [
        midnightFallsKill(alfaKey, {
          killedAt: "2026-07-20T19:26:58.000Z"
        })
      ],
      raiderIoFirstKills: [raiderIoKill()],
      limitations: []
    });

    const midnightFalls = verifiedKill(boss(dossier));
    expect(midnightFalls.firstKills).toHaveLength(1);
    expect(midnightFalls.firstKill).toMatchObject({
      killedAt: "2026-07-20T17:25:57.301Z",
      reportUrl: "https://www.warcraftlogs.com/reports/fixturealfa#fight=9",
      roster: availableRoster
    });
    expect(midnightFalls.firstKill.parses).toEqual([
      expect.objectContaining({ character: "Alfa" })
    ]);
  });

  it("makes an earlier Raider.IO kill the boss's first kill", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [
        midnightFallsKill(alfaKey, {
          killedAt: "2026-07-27T20:00:00.000Z"
        })
      ],
      raiderIoFirstKills: [raiderIoKill()],
      limitations: []
    });

    const midnightFalls = verifiedKill(boss(dossier));
    expect(midnightFalls.firstKills.map((item) => item.killedAt)).toEqual([
      "2026-07-27T20:00:00.000Z",
      "2026-07-20T17:25:57.301Z"
    ]);
    expect(midnightFalls.firstKill).toMatchObject({
      killedAt: "2026-07-20T17:25:57.301Z",
      reportUrl: null,
      parses: []
    });
    // The Warcraft Logs kill's parses still reach the best-parse row.
    expect(midnightFalls.bestParses).toEqual([
      expect.objectContaining({ character: "Alfa" })
    ]);
  });

  it("still shows another character's Warcraft Logs parses as the best", () => {
    const dossier = buildApplicantDossier({
      root,
      characters: [rootCharacter, alfa],
      kills: [
        midnightFallsKill(root, { killedAt: "2026-07-27T20:00:00.000Z" })
      ],
      raiderIoFirstKills: [raiderIoKill()],
      limitations: []
    });

    const midnightFalls = verifiedKill(boss(dossier));
    expect(midnightFalls.firstKill.parses).toEqual([]);
    expect(midnightFalls.bestParses.map((parse) => parse.character)).toEqual([
      "Ryii"
    ]);
  });

  it("carries the rank collection gave the kill from its encounter guild", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [raiderIoKill({ historicWorldRank: 3 })],
      limitations: []
    });
    expect(verifiedKill(boss(dossier)).firstKill.historicWorldRank).toBe(3);
  });

  it("shows a pug's kill with no guild", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [
        raiderIoKill({
          guild: null,
          encounter: {
            state: "read",
            encounter: { ...loggedEncounter, guild: null }
          }
        })
      ],
      limitations: []
    });
    expect(verifiedKill(boss(dossier)).firstKill.guild).toBeNull();
  });

  it.each([
    [
      "hidden by the guild",
      raiderIoKill({
        encounter: {
          state: "read",
          encounter: { ...loggedEncounter, roster: { state: "private" } }
        }
      }),
      "private"
    ],
    [
      "not read yet",
      raiderIoKill({ encounter: { state: "not_read" } }),
      "not_read"
    ]
  ])("says why a roster is unavailable: %s", (_name, first, reason) => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [first],
      limitations: []
    });
    expect(verifiedKill(boss(dossier)).firstKill.roster).toEqual({
      state: "unavailable",
      reason
    });
  });

  it("names a matched kill Raider.IO holds no log of, and never counts an unlogged one as evidence", () => {
    const unlogged = raiderIoKill({ encounter: { state: "none" } });
    const matched = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [midnightFallsKill(alfaKey)],
      raiderIoFirstKills: [unlogged],
      limitations: []
    });
    expect(verifiedKill(boss(matched)).firstKill.roster).toEqual({
      state: "unavailable",
      reason: "no_logged_encounter"
    });

    const alone = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [unlogged],
      limitations: []
    });
    expect(alone.raids).toEqual([]);
  });

  it("leaves a kill no Raider.IO kill matched with no roster at all", () => {
    const dossier = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [midnightFallsKill(alfaKey)],
      limitations: []
    });
    expect(verifiedKill(boss(dossier)).firstKill).not.toHaveProperty("roster");
  });

  it("withholds an out-of-window Raider.IO kill under Raider.IO, and counts a kill both sources withheld once", () => {
    // Break caught (#734 pre-flight): the withheld Raider.IO kill was
    // labelled Warcraft Logs, and tallied a second time beside its own
    // Warcraft Logs copy.
    const late = raiderIoKill({
      raidSlug: "nerubar-palace",
      bossSlug: "queen-ansurek",
      killedAt: "2025-06-01T20:00:00.000Z"
    });
    const withheld = (dossier: ApplicantDossier) =>
      dossier.limitations.filter((limitation) =>
        limitation.code.startsWith("current_content_")
      );
    const queenAnsurek = [
      { raidName: "Nerub-ar Palace", bossName: "Queen Ansurek", kills: 1 }
    ];

    const alone = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [],
      raiderIoFirstKills: [late],
      limitations: []
    });
    expect(withheld(alone)).toEqual([
      expect.objectContaining({
        source: "raiderio",
        character: alfaKey,
        code: "current_content_evidence_withheld",
        encounters: queenAnsurek
      })
    ]);

    const both = buildApplicantDossier({
      root: alfaKey,
      characters: [alfa],
      kills: [
        kill(alfaKey, {
          raidId: "1273",
          raidName: "Nerub-ar Palace",
          bossId: "2602",
          bossName: "Queen Ansurek",
          journalBossId: "2602",
          bossOrder: 8,
          killedAt: "2025-06-01T20:30:00.000Z"
        })
      ],
      raiderIoFirstKills: [late],
      limitations: []
    });
    expect(withheld(both)).toEqual([
      expect.objectContaining({
        source: "warcraft_logs",
        code: "current_content_evidence_withheld",
        encounters: queenAnsurek
      })
    ]);
  });
});
```

- [ ] **Step 2: Run the domain tests to verify they fail**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src/applicant-dossier.test.ts -t "Raider.IO-logged first kills"`
Expected: FAIL — `raiderIoFirstKills` is not an input and `DossierLoggedEncounter` does not exist.

- [ ] **Step 3: Implement the domain merge**

In `packages/domain/src/applicant-dossier.ts`, add `lookupRaidEncounterByRaiderIoSlugs` to the `./raid-catalogue` import and:

```ts
import { matchesRaiderIoKill } from "./kill-matching";
import { isRosterShown } from "./logged-encounter";
```

After `DossierCuttingEdgeEvidence`, add:

```ts
export type DossierRosterRole = "tank" | "healer" | "dps";
export type DossierRosterMember = Readonly<{
  name: string;
  realm: string;
  region: string;
  className: string;
  specName: string;
  role: DossierRosterRole;
  itemLevel: number | null;
}>;
/** Raider.IO's parsed combat log of one Mythic kill (#732). */
export type DossierLoggedEncounter = Readonly<{
  pulledAt: string;
  defeatedAt: string;
  durationMs: number;
  guild: DossierKillEvidence["guild"];
  itemLevel: Readonly<{ average: number; min: number; max: number }>;
  deathCount: number;
  vantusCount: number;
  roster:
    | Readonly<{
        state: "available";
        /** Everyone Raider.IO listed, by role, including raiders `members` leaves out. */
        roleCounts: Readonly<Record<DossierRosterRole, number>>;
        /** The raiders a dossier may name: suppressed ones already left out. */
        members: readonly DossierRosterMember[];
      }>
    | Readonly<{ state: "private" }>;
}>;
/**
 * One Raider.IO Mythic first kill of a dossier character (#732). `read` is
 * evidence of its own; `not_read` is evidence whose log is still to be read,
 * attributed by Raider.IO's own kill list; `none` is a plain kill with no log,
 * which lends nothing and is never evidence alone.
 */
export type DossierRaiderIoFirstKill = Readonly<{
  character: CharacterKey;
  raidSlug: string;
  bossSlug: string;
  killedAt: string;
  guild: DossierKillEvidence["guild"];
  historicWorldRank: number | null;
  encounter:
    | Readonly<{ state: "read"; encounter: DossierLoggedEncounter }>
    | Readonly<{ state: "not_read" }>
    | Readonly<{ state: "none" }>;
}>;
export type ApplicantDossierRosterMember = DossierRosterMember &
  Readonly<{ isDossierCharacter: boolean }>;
export type ApplicantDossierKillRoster =
  | Readonly<{
      state: "available";
      playerCount: number;
      roleCounts: Readonly<Record<DossierRosterRole, number>>;
      itemLevel: Readonly<{ average: number; min: number; max: number }>;
      pulledAt: string;
      durationMs: number;
      deathCount: number;
      vantusCount: number;
      members: readonly ApplicantDossierRosterMember[];
    }>
  | Readonly<{
      state: "unavailable";
      reason: "private" | "no_logged_encounter" | "not_read";
    }>;
```

Add `raiderIoFirstKills?: readonly DossierRaiderIoFirstKill[];` to `BuildApplicantDossierInput`, and to `ApplicantDossierFirstKill`:

```ts
  /** Absent when no Raider.IO first kill was matched to this event. */
  roster?: ApplicantDossierKillRoster;
```

Change `CatalogueMatchedKill` so a kill can carry the Raider.IO first kill it matched or came from:

```ts
type CatalogueMatchedKill = DossierKillEvidence &
  RaidCatalogueEncounter &
  Readonly<{ raiderIoFirstKill?: DossierRaiderIoFirstKill }>;
```

Add these helpers after `currentness`:

```ts
const UNPARSED: DossierKillPerformance = {
  damage: { state: "unavailable" },
  healing: { state: "unavailable" },
  bossDamage: { state: "unavailable" }
};

/** A kill with a public Warcraft Logs report behind it, not a Raider.IO one alone. */
function hasPublicLog(kill: CatalogueMatchedKill): boolean {
  return kill.raiderIoFirstKill === undefined || kill.reportUrl !== null;
}

const ROLE_ORDER: Readonly<Record<DossierRosterRole, number>> = {
  tank: 0,
  healer: 1,
  dps: 2
};

function isDossierCharacter(
  member: DossierRosterMember,
  characters: readonly DossierCharacter[]
): boolean {
  return characters.some(
    ({ key }) =>
      key.region === member.region.toLocaleLowerCase("en-US") &&
      key.realm === member.realm.toLocaleLowerCase("en-US") &&
      key.name === member.name.toLocaleLowerCase("en-US")
  );
}

function killRoster(
  shared: readonly CatalogueMatchedKill[],
  characters: readonly DossierCharacter[]
): ApplicantDossierKillRoster | undefined {
  const firsts = shared.flatMap((kill) =>
    kill.raiderIoFirstKill ? [kill.raiderIoFirstKill] : []
  );
  if (firsts.length === 0) return undefined;
  const read = firsts.find((first) => first.encounter.state === "read");
  if (read?.encounter.state === "read") {
    const encounter = read.encounter.encounter;
    // Suppressed raiders are already off the list. What is left is judged by
    // the one rule the client judged the response by, so a list left with
    // nobody to name reads as hidden, never as "nobody was there".
    if (
      encounter.roster.state === "private" ||
      !isRosterShown(true, encounter.roster.members)
    ) {
      return { state: "unavailable", reason: "private" };
    }
    const members = [...encounter.roster.members]
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
          text(a.name, b.name) ||
          text(a.realm, b.realm)
      )
      .map((member) => ({
        ...member,
        isDossierCharacter: isDossierCharacter(member, characters)
      }));
    // Raider.IO's counts: a raider left off the list still raided.
    const { tank, healer, dps } = encounter.roster.roleCounts;
    return {
      state: "available",
      playerCount: tank + healer + dps,
      roleCounts: { tank, healer, dps },
      itemLevel: encounter.itemLevel,
      pulledAt: encounter.pulledAt,
      durationMs: encounter.durationMs,
      deathCount: encounter.deathCount,
      vantusCount: encounter.vantusCount,
      members
    };
  }
  return {
    state: "unavailable",
    reason: firsts.some((first) => first.encounter.state === "not_read")
      ? "not_read"
      : "no_logged_encounter"
  };
}
```

In `buildApplicantDossier`, give `withhold` the limitation's source, keyed by it, so a Raider.IO kill is never labelled Warcraft Logs:

```ts
const withhold = (
  code: string,
  kill: Readonly<{
    character: CharacterKey;
    raidName: string;
    bossName: string;
  }>,
  source: DossierLimitation["source"] = "warcraft_logs"
) => {
  const key = `${source}\0${code}\0${canonicalCharacterId(kill.character)}`;
  const entry = withheldKillReasons.get(key) ?? {
    limitation: { source, character: kill.character, code },
    encounters: new Map()
  };
  tallyEncounter(entry.encounters, kill.raidName, kill.bossName);
  withheldKillReasons.set(key, entry);
};
// The Warcraft Logs kills withheld as out of window, so a Raider.IO first
// kill of the same kill is not tallied a second time.
const withheldWarcraftLogsKills: CatalogueMatchedKill[] = [];
```

In the `for (const suppliedKill of input.kills)` loop, record each kill withheld for currentness, just before its `withhold(code, kill);`:

```ts
withheldWarcraftLogsKills.push(kill);
```

Directly after that loop and before `limitations.push(...withheldKillReasons...)`, add:

```ts
// A Raider.IO first kill with a parsed combat log is evidence of its own
// (#732). One that matches a Warcraft Logs kill of the same character and
// boss lends that kill its roster and changes nothing else about it.
const sameKill = (
  first: DossierRaiderIoFirstKill,
  kill: CatalogueMatchedKill
) =>
  canonicalCharacterId(kill.character) ===
    canonicalCharacterId(first.character) && matchesRaiderIoKill(first, kill);
for (const first of input.raiderIoFirstKills ?? []) {
  const metadata = lookupRaidEncounterByRaiderIoSlugs(
    first.raidSlug,
    first.bossSlug
  );
  if (metadata === null) continue;
  const at = Date.parse(first.killedAt);
  const matched = allKills
    .map((kill, index) => ({
      kill,
      index,
      distance: Math.abs(Date.parse(kill.killedAt) - at)
    }))
    .filter(
      ({ kill }) =>
        kill.raiderIoFirstKill === undefined && sameKill(first, kill)
    )
    .sort(
      (a, b) => a.distance - b.distance || compareEvidence(a.kill, b.kill)
    )[0];
  if (matched) {
    allKills[matched.index] = { ...matched.kill, raiderIoFirstKill: first };
    continue;
  }
  // Raider.IO's plain kill list is a place to search, never evidence.
  if (first.encounter.state === "none") continue;
  const raiderIoKill: CatalogueMatchedKill = {
    ...metadata,
    journalBossId: metadata.bossId,
    character: first.character,
    killedAt: first.killedAt,
    guild:
      first.encounter.state === "read"
        ? first.encounter.encounter.guild
        : first.guild,
    historicWorldRank: first.historicWorldRank,
    reportUrl: null,
    performance: UNPARSED,
    raiderIoFirstKill: first
  };
  const eligible = currentness(raiderIoKill.killedAt, raiderIoKill.raidId);
  if (eligible !== true) {
    // Its Warcraft Logs copy was withheld and tallied already: one kill,
    // counted once.
    if (withheldWarcraftLogsKills.some((kill) => sameKill(first, kill)))
      continue;
    withhold(
      eligible === false
        ? "current_content_evidence_withheld"
        : "current_content_window_unknown",
      raiderIoKill,
      "raiderio"
    );
    continue;
  }
  allKills.push(raiderIoKill);
}
```

In the `firstKills` mapping inside `for (const kills of byBoss.values())`, compute the parse set from public logs only and attach the roster:

```ts
const logged = shared.filter(hasPublicLog);
const roster = killRoster(shared, input.characters);
return {
  selected,
  shared,
  logged,
  firstKill: {
    killedAt: selected.killedAt,
    guild: attributed ?? null,
    historicWorldRank: ranks.size === 1 ? [...ranks][0]! : null,
    reportUrl: preferredReport?.reportUrl ?? selected.reportUrl,
    reportUrls,
    reports,
    characters: input.characters
      .filter((c) => ids.has(canonicalCharacterId(c.key)))
      .map((c) => c.key),
    parses: aggregateEventParses(logged, characters),
    ...(roster ? { roster } : {})
  }
};
```

and in `raid.bosses.push(...)` change the best parses to the same public-log set:

```ts
      bestParses: aggregateBossParses(
        firstKills.map((entry) => entry.logged),
        characters,
        tierBestsByBoss.get([selected.raidId, selected.bossId].join("\0")) ?? []
      ),
```

In `packages/domain/src/index.ts`, add to the `./applicant-dossier` type exports: `ApplicantDossierKillRoster`, `ApplicantDossierRosterMember`, `DossierLoggedEncounter`, `DossierRaiderIoFirstKill`, `DossierRosterMember`, `DossierRosterRole`.

- [ ] **Step 4: Run the domain tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src`
Expected: PASS, the whole domain suite (the change must not move any existing kill event or limitation).

- [ ] **Step 5: Write the failing contract test**

Add `dossierFirstKillSchema` to the imports of `packages/contracts/src/contracts.test.ts` and append:

```ts
it("carries a first kill's roster, or the reason there is none, and never a Raider.IO id", () => {
  const firstKill = {
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: {
      name: "Fixture Guild Alfa",
      region: "eu",
      realm: "twisting-nether"
    },
    historicWorldRank: null,
    reportUrl: null,
    reports: [],
    characters: [applicantCharacter],
    parses: []
  };
  const member = {
    name: "Alfa",
    realm: "draenor",
    region: "eu",
    className: "Demon Hunter",
    specName: "Havoc",
    role: "dps",
    itemLevel: null,
    isDossierCharacter: true
  };
  const roster = {
    state: "available",
    playerCount: 1,
    roleCounts: { tank: 0, healer: 0, dps: 1 },
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    pulledAt: "2026-07-20T17:17:29.977Z",
    durationMs: 507_324,
    deathCount: 2,
    vantusCount: 16,
    members: [member]
  };
  const accepts = (value: unknown) =>
    dossierFirstKillSchema.safeParse({ ...firstKill, roster: value }).success;

  expect(dossierFirstKillSchema.safeParse(firstKill).success).toBe(true);
  expect(accepts(roster)).toBe(true);
  for (const reason of ["private", "no_logged_encounter", "not_read"]) {
    expect(accepts({ state: "unavailable", reason })).toBe(true);
  }
  expect(accepts({ state: "unavailable", reason: "hidden" })).toBe(false);
  expect(accepts({ ...roster, members: [] })).toBe(false);
  expect(
    accepts({ ...roster, members: [{ ...member, raiderIoCharacterId: 1 }] })
  ).toBe(false);
});
```

Run: `corepack pnpm exec vitest run --project unit packages/contracts/src/contracts.test.ts`
Expected: FAIL — `roster` is an unrecognised key on the strict schema.

- [ ] **Step 6: Implement the contract**

In `packages/contracts/src/dossier.ts`, before `dossierFirstKillSchema`:

```ts
/** One raider on a Raider.IO logged encounter's roster (#732). No Raider.IO id. */
export const dossierRosterMemberSchema = z
  .object({
    name: z.string().min(1),
    realm: z.string().min(1),
    region: z.string().min(1),
    className: z.string().min(1),
    specName: z.string().min(1),
    role: z.enum(["tank", "healer", "dps"]),
    /** Null when Raider.IO did not say; never zero. */
    itemLevel: z.number().nonnegative().nullable(),
    isDossierCharacter: z.boolean()
  })
  .strict();

/**
 * Who was in the raid, from Raider.IO's logged encounter of the kill, or why
 * that cannot be shown. Unavailable is its own state: never "not present".
 * The counts are Raider.IO's, so they can exceed the raiders listed: a raider
 * removed from SlashWho is counted and never named.
 */
export const dossierKillRosterSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("available"),
      playerCount: z.number().int().nonnegative(),
      roleCounts: z
        .object({
          tank: z.number().int().nonnegative(),
          healer: z.number().int().nonnegative(),
          dps: z.number().int().nonnegative()
        })
        .strict(),
      itemLevel: z
        .object({
          average: z.number().nonnegative(),
          min: z.number().nonnegative(),
          max: z.number().nonnegative()
        })
        .strict(),
      pulledAt: z.iso.datetime(),
      durationMs: z.number().int().nonnegative(),
      deathCount: z.number().int().nonnegative(),
      vantusCount: z.number().int().nonnegative(),
      members: z.array(dossierRosterMemberSchema).min(1)
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum(["private", "no_logged_encounter", "not_read"])
    })
    .strict()
]);
```

Add to `dossierFirstKillSchema`'s object, after `parses`:

```ts
    /** Absent when no Raider.IO first kill was matched to this kill. */
    roster: dossierKillRosterSchema.optional(),
```

and after the other type exports:

```ts
export type DossierKillRoster = z.infer<typeof dossierKillRosterSchema>;
```

Export `dossierKillRosterSchema`, `dossierRosterMemberSchema` and type `DossierKillRoster` from `packages/contracts/src/index.ts` alongside `dossierFirstKillSchema`.

Run: `corepack pnpm exec vitest run --project unit packages/contracts/src`
Expected: PASS.

- [ ] **Step 7: Write the failing application mapping tests**

Create `packages/application/src/raiderio-first-kill-evidence.test.ts`:

```ts
import type {
  PublishedRaiderIoLoggedEncounter,
  StoredCharacterRaiderIoFirstKill
} from "@slashwho/database";
import { describe, expect, it } from "vitest";

import { dossierRaiderIoFirstKill } from "./raiderio-first-kill-evidence";

// Synthetic identities throughout: this repository is public.
const character = {
  region: "eu" as const,
  realm: "draenor",
  name: "alfa"
};
const killGuild = {
  name: "Fixture Guild Alfa",
  realm: "twisting-nether",
  region: "eu"
};
const encounter: PublishedRaiderIoLoggedEncounter = {
  loggedEncounterId: 700_001,
  raidSlug: "tier-mn-1",
  bossSlug: "midnight-falls",
  pulledAt: "2026-07-20T17:17:29.977Z",
  defeatedAt: "2026-07-20T17:25:57.301Z",
  durationMs: 507_324,
  guild: killGuild,
  itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
  deathCount: 2,
  vantusCount: 16,
  rosterState: "available",
  members: [
    {
      raiderIoCharacterId: 424_242,
      name: "Alfa",
      realm: "draenor",
      region: "eu",
      className: "Demon Hunter",
      specName: "Havoc",
      role: "dps",
      itemLevel: 290.5
    }
  ],
  roleCounts: { tank: 2, healer: 4, dps: 14 },
  readAt: "2026-09-28T12:00:00.000Z"
};
function stored(
  overrides: Partial<StoredCharacterRaiderIoFirstKill> = {}
): StoredCharacterRaiderIoFirstKill {
  return {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: "2026-09-28T12:00:00.000Z",
    encounter,
    ...overrides
  };
}

describe("dossierRaiderIoFirstKill", () => {
  it("attributes a read kill to the character, keeps Raider.IO's counts, and drops every Raider.IO id", () => {
    const kill = dossierRaiderIoFirstKill(stored(), character);
    expect(kill).toEqual({
      character,
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      historicWorldRank: null,
      encounter: {
        state: "read",
        encounter: {
          pulledAt: "2026-07-20T17:17:29.977Z",
          defeatedAt: "2026-07-20T17:25:57.301Z",
          durationMs: 507_324,
          guild: killGuild,
          itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
          deathCount: 2,
          vantusCount: 16,
          roster: {
            state: "available",
            roleCounts: { tank: 2, healer: 4, dps: 14 },
            members: [
              {
                name: "Alfa",
                realm: "draenor",
                region: "eu",
                className: "Demon Hunter",
                specName: "Havoc",
                role: "dps",
                itemLevel: 290.5
              }
            ]
          }
        }
      }
    });
    expect(JSON.stringify(kill)).not.toContain("424242");
    expect(JSON.stringify(kill)).not.toContain("700001");
  });

  it.each([
    [
      "no logged encounter",
      stored({
        loggedEncounterId: null,
        encounterState: "unavailable",
        encounter: null
      }),
      "none"
    ],
    [
      "a read not yet made",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "request_cap",
        encounter: null
      }),
      "not_read"
    ],
    [
      "a log Raider.IO no longer has",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "not_found",
        encounter: null
      }),
      "none"
    ],
    [
      "a log Raider.IO refuses to show",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "private",
        encounter: null
      }),
      "none"
    ],
    [
      "a log of another kill",
      stored({
        encounterState: "unavailable",
        encounterLimitationCode: "schema_drift",
        encounter: null
      }),
      "none"
    ],
    [
      "a read row whose encounter is missing",
      stored({ encounter: null }),
      "not_read"
    ]
  ])("maps %s", (_name, kill, state) => {
    // Break caught (#734 pre-flight): a 403 is as permanent as a 404, and
    // mapped to "not read yet" it promised a roster that never comes.
    expect(dossierRaiderIoFirstKill(kill, character).encounter.state).toBe(
      state
    );
  });

  it("drops a guild in a region the dossier cannot name rather than failing the read", () => {
    const kill = dossierRaiderIoFirstKill(
      stored({
        guild: { name: "Guild", realm: "realm", region: "cn" },
        encounter: {
          ...encounter,
          guild: { name: "Guild", realm: "realm", region: "cn" }
        }
      }),
      character
    );
    expect(kill.guild).toBeNull();
    expect(
      kill.encounter.state === "read" && kill.encounter.encounter.guild
    ).toBeNull();
  });

  it("hands a roster the guild hid over as private", () => {
    const hidden = dossierRaiderIoFirstKill(
      stored({
        encounter: {
          ...encounter,
          rosterState: "private",
          members: [],
          roleCounts: { tank: 0, healer: 0, dps: 0 }
        }
      }),
      character
    );
    expect(
      hidden.encounter.state === "read" && hidden.encounter.encounter.roster
    ).toEqual({ state: "private" });
  });
});
```

Run: `corepack pnpm exec vitest run --project unit packages/application/src/raiderio-first-kill-evidence.test.ts`
Expected: FAIL — cannot resolve `./raiderio-first-kill-evidence`.

- [ ] **Step 8: Implement the mapping and wire it into the dossier**

Create `packages/application/src/raiderio-first-kill-evidence.ts`:

```ts
import type {
  PublishedRaiderIoLoggedEncounter,
  StoredCharacterRaiderIoFirstKill
} from "@slashwho/database";
import {
  supportedRegions,
  type CharacterKey,
  type DossierKillEvidence,
  type DossierLoggedEncounter,
  type DossierRaiderIoFirstKill
} from "@slashwho/domain";

// Raider.IO's permanent refusals, the same three the collection phase stores
// as unavailable: a log it no longer has, one it refuses to show (403), and
// one that named another kill. None will ever be read, so the kill is as
// good as unlogged.
const PERMANENTLY_UNREAD: ReadonlySet<string> = new Set([
  "not_found",
  "private",
  "schema_drift"
]);

function dossierGuild(
  guild: Readonly<{ name: string; realm: string; region: string }> | null
): DossierKillEvidence["guild"] {
  if (!guild) return null;
  const region = guild.region.toLocaleLowerCase("en-US");
  return (supportedRegions as readonly string[]).includes(region)
    ? {
        name: guild.name,
        realm: guild.realm,
        region: region as CharacterKey["region"]
      }
    : null;
}

function dossierEncounter(
  encounter: PublishedRaiderIoLoggedEncounter
): DossierLoggedEncounter {
  return {
    pulledAt: encounter.pulledAt,
    defeatedAt: encounter.defeatedAt,
    durationMs: encounter.durationMs,
    guild: dossierGuild(encounter.guild),
    itemLevel: { ...encounter.itemLevel },
    deathCount: encounter.deathCount,
    vantusCount: encounter.vantusCount,
    // Raider.IO's own ids stop here: the contract has no place for them.
    // Whether what is left can be shown is the domain's `isRosterShown`.
    roster:
      encounter.rosterState === "available"
        ? {
            state: "available",
            roleCounts: { ...encounter.roleCounts },
            members: encounter.members.map((member) => ({
              name: member.name,
              realm: member.realm,
              region: member.region,
              className: member.className,
              specName: member.specName,
              role: member.role,
              itemLevel: member.itemLevel
            }))
          }
        : { state: "private" }
  };
}

/** A stored Raider.IO first kill as the dossier reads it, attributed to its subject. */
export function dossierRaiderIoFirstKill(
  kill: StoredCharacterRaiderIoFirstKill,
  character: CharacterKey
): DossierRaiderIoFirstKill {
  return {
    character,
    raidSlug: kill.raidSlug,
    bossSlug: kill.bossSlug,
    killedAt: kill.killedAt,
    guild: dossierGuild(kill.guild),
    historicWorldRank: kill.historicWorldRank,
    encounter:
      kill.loggedEncounterId === null ||
      PERMANENTLY_UNREAD.has(kill.encounterLimitationCode ?? "")
        ? { state: "none" }
        : kill.encounterState === "read" && kill.encounter
          ? { state: "read", encounter: dossierEncounter(kill.encounter) }
          : { state: "not_read" }
  };
}
```

In `packages/application/src/applicant-dossier-service.ts`:

- import `dossierRaiderIoFirstKill` from `./raiderio-first-kill-evidence` and `type DossierRaiderIoFirstKill` from `@slashwho/domain`;
- add to `EvidenceResult`:

```ts
  raiderIoFirstKills: readonly DossierRaiderIoFirstKill[];
```

- in the object the evidence builder returns (after `tierBests:`):

```ts
    raiderIoFirstKills:
      completed?.raiderIoFirstKills?.map((kill) =>
        dossierRaiderIoFirstKill(kill, attributed)
      ) ?? [],
```

- replace `warcraftLogsComplete` and the comment above it, so a run partial only for its parse budget or for Raider.IO keeps its "no logs" conclusions, and only when its history scan ran:

```ts
    // Negative conclusions rest on the history scan, which `limitationCode`
    // reports. A run whose only shortfall is its parse budget, or its
    // Raider.IO logged-encounter reads (#732), scanned the whole history and
    // publishes `partial` to say so, so requiring `complete` here would
    // silently withdraw conclusions the evidence still supports. A run whose
    // scan was skipped scanned nothing, so it never supports one, whatever
    // else it names.
    warcraftLogsComplete:
      reservation.kind === "fresh" &&
      (completed?.run.status === "complete" ||
        (completed?.run.status === "partial" &&
          completed.run.killScanSkipped !== true &&
          (completed.run.parseLimitationCode !== null ||
            completed.run.raiderIoLimitationCode != null))) &&
      completed.run.limitationCode === null &&
      completed.wipeCapable,
```

- in `mergeIdentityEvidence`, after `tierBests`:

```ts
    // Every name's collection is attributed to the subject, so one first kill
    // per boss: the subject's own name first.
    raiderIoFirstKills: uniqueBy(
      results.flatMap((item) => item.raiderIoFirstKills),
      (kill) => `${kill.raidSlug}\0${kill.bossSlug}`
    ),
```

- in the `buildApplicantDossier({ ... })` call, after `tierBests:`:

```ts
      raiderIoFirstKills: evidence.flatMap((item) => item.raiderIoFirstKills),
```

- [ ] **Step 9: Pin the service end to end**

In `packages/application/src/applicant-dossier-service.test.ts`, add three options to `fixture`'s options type:

```ts
    evidenceRaiderIoLimitationCode?: string | null;
    evidenceKillScanSkipped?: boolean;
    raiderIoFirstKills?: readonly StoredCharacterRaiderIoFirstKill[];
```

(import `StoredCharacterRaiderIoFirstKill` from `@slashwho/database`), and in the `completed:` object the `reserve` mock returns, add to `run` after `parseLimitationCode`:

```ts
            ...(options.evidenceRaiderIoLimitationCode
              ? { raiderIoLimitationCode: options.evidenceRaiderIoLimitationCode }
              : {}),
            ...(options.evidenceKillScanSkipped
              ? { killScanSkipped: true }
              : {}),
```

and after `tierBests: options.tierBests ?? [],`:

```ts
          ...(options.raiderIoFirstKills
            ? { raiderIoFirstKills: options.raiderIoFirstKills }
            : {}),
```

Add next to `"keeps no-log gaps for a run whose only shortfall is its parse budget"`:

```ts
it("keeps no-log gaps for a run whose only shortfall is Raider.IO's logs (#732)", async () => {
  const result = await fixture({
    includeCachedKills: false,
    evidenceStatus: "partial",
    evidenceLimitationCode: null,
    evidenceRaiderIoLimitationCode: "request_cap"
  }).dossiers.read(root);
  if (result.kind !== "ready") throw new Error("dossier_not_ready");

  expect(result.dossier.raids[0]?.bosses[0]).toMatchObject({
    state: "no_logs"
  });
});

it.each([
  [
    "Raider.IO also fell short",
    { evidenceRaiderIoLimitationCode: "request_cap" }
  ],
  [
    "its parse budget ran out",
    { evidenceParseLimitationCode: "parse_request_cap" }
  ]
])(
  "keeps a skipped-scan run incomplete even when %s",
  async (_name, shortfall) => {
    // Break caught (#734 review): a light run publishes `partial` with its
    // scan skipped; had a Raider.IO shortfall made it read as complete, the
    // dossier would assert "No qualifying public logs found" from a history
    // scan that never ran.
    const result = await fixture({
      includeCachedKills: false,
      evidenceStatus: "partial",
      evidenceLimitationCode: null,
      evidenceKillScanSkipped: true,
      ...shortfall
    }).dossiers.read(root);
    if (result.kind !== "ready") throw new Error("dossier_not_ready");

    expect(result.dossier.raids[0]?.bosses[0]).toMatchObject({
      state: "incomplete"
    });
  }
);

it("shows a stored Raider.IO-logged first kill as the boss's kill, with its roster", async () => {
  const killGuild = {
    name: "Fixture Guild Alfa",
    realm: "twisting-nether",
    region: "eu"
  };
  const result = await fixture({
    includeCachedKills: false,
    raiderIoFirstKills: [
      {
        raidSlug: "tier-mn-1",
        bossSlug: "midnight-falls",
        killedAt: "2026-07-20T17:25:57.301Z",
        guild: killGuild,
        loggedEncounterId: 700_001,
        encounterState: "read",
        encounterLimitationCode: null,
        historicWorldRank: null,
        historicRankCheckedAt: null,
        encounter: {
          loggedEncounterId: 700_001,
          raidSlug: "tier-mn-1",
          bossSlug: "midnight-falls",
          pulledAt: "2026-07-20T17:17:29.977Z",
          defeatedAt: "2026-07-20T17:25:57.301Z",
          durationMs: 507_324,
          guild: killGuild,
          itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
          deathCount: 2,
          vantusCount: 16,
          rosterState: "private",
          members: [],
          roleCounts: { tank: 0, healer: 0, dps: 0 },
          readAt: "2026-09-28T12:00:00.000Z"
        }
      }
    ]
  }).dossiers.read(root);
  if (result.kind !== "ready") throw new Error("dossier_not_ready");

  const midnightFalls = result.dossier.raids
    .flatMap((raid) => raid.bosses)
    .find((boss) => boss.bossName === "Midnight Falls");
  expect(midnightFalls).toMatchObject({
    state: "kill",
    firstKill: {
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      reportUrl: null,
      parses: [],
      roster: { state: "unavailable", reason: "private" }
    }
  });
});
```

The existing test `"keeps no-log gaps for a run whose only shortfall is its parse budget"` is unchanged and must still pass: its run's scan ran.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src packages/domain/src packages/contracts/src`
Expected: PASS.

Run: `corepack pnpm --filter @slashwho/domain typecheck && corepack pnpm --filter @slashwho/contracts typecheck && corepack pnpm --filter @slashwho/application typecheck`
Expected: all exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/domain packages/contracts packages/application
git commit -m "feat(dossier): show Raider.IO-logged first kills with their kill guild and roster (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web: "No public logs found" and the lazy roster disclosure

Next.js is not touched here: these are plain React components and CSS. (If a step does need a Next API, read `apps/web/node_modules/next/dist/docs/` first, as `apps/web/AGENTS.md` requires.)

**Files:**

- Create: `apps/web/src/components/dossier-kill-roster.tsx`
- Test: `apps/web/src/components/dossier-kill-roster.test.tsx`
- Modify: `apps/web/src/components/dossier-character-name.tsx:68-75, 129, 228` (export the class-colour helper; its two call sites)
- Modify: `apps/web/src/components/dossier-parse-list.tsx:13-18, 82-96`
- Modify: `apps/web/src/components/dossier-raid-list.tsx` (`ReportLinks` 51-70, `KillEvidence` 461-601)
- Modify: `apps/web/src/components/dossier-raid-list.test.tsx`, `apps/web/src/components/dossier-view.test.tsx:281-285`
- Modify: `apps/web/src/app/globals.css` (after `.dossier-evidence dd`, ~line 2073)

**Interfaces:**

- Consumes: `dossierFirstKillSchema.roster` / `DossierKillRoster` (Task 6).
- Produces: `DossierKillRoster({ roster, guildRealm }: { roster: DossierKillRoster; guildRealm: string | null })`, `rosterSummary(roster): string`, `classColourModifier(className: string | null): string | null`, and `DossierParseList`'s new optional `emptyText` prop.

- [ ] **Step 1: Write the failing roster tests**

Create `apps/web/src/components/dossier-kill-roster.test.tsx`:

```tsx
// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { DossierKillRoster as Roster } from "@slashwho/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { DossierKillRoster, rosterSummary } from "./dossier-kill-roster";

afterEach(cleanup);

const roster: Extract<Roster, { state: "available" }> = {
  state: "available",
  playerCount: 20,
  roleCounts: { tank: 2, healer: 4, dps: 14 },
  itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
  pulledAt: "2026-07-20T17:17:29.977Z",
  durationMs: 507_324,
  deathCount: 2,
  vantusCount: 16,
  members: [
    {
      name: "Bravo",
      realm: "twisting-nether",
      region: "eu",
      className: "Warrior",
      specName: "Protection",
      role: "tank",
      itemLevel: 292.1,
      isDossierCharacter: false
    },
    {
      name: "Charlie",
      realm: "twisting-nether",
      region: "eu",
      className: "Priest",
      specName: "Holy",
      role: "healer",
      itemLevel: 291.4,
      isDossierCharacter: false
    },
    {
      name: "Alfa",
      realm: "draenor",
      region: "eu",
      className: "Demon Hunter",
      specName: "Havoc",
      role: "dps",
      itemLevel: null,
      isDossierCharacter: true
    }
  ]
};

it("summarises the raid in one line", () => {
  expect(rosterSummary(roster)).toBe(
    "20 players · 2 tanks, 4 healers, 14 DPS · item level 290.3 (284.9–293.1) · pulled 17:17 UTC · 8:27 fight · 2 deaths · 16 Vantus runes"
  );
  expect(
    rosterSummary({
      ...roster,
      playerCount: 1,
      roleCounts: { tank: 1, healer: 0, dps: 0 },
      deathCount: 1,
      vantusCount: 1
    })
  ).toMatch(
    /^1 player · 1 tank, 0 healers, 0 DPS · .* · 1 death · 1 Vantus rune$/
  );
});

it("lists each raider with role, class colour, realm where it differs, and item level", () => {
  render(<DossierKillRoster guildRealm="Twisting Nether" roster={roster} />);

  expect(screen.getByText(rosterSummary(roster))).toBeInTheDocument();
  const rows = within(
    screen.getByRole("table", { name: "Raid roster" })
  ).getAllByRole("row");
  expect(rows).toHaveLength(4);
  const [, tank, , alfa] = rows;

  expect(within(tank!).getByRole("img", { name: "Tank" })).toBeInTheDocument();
  expect(within(tank!).queryByText("Twisting Nether")).not.toBeInTheDocument();
  expect(within(tank!).getByText("292.1")).toBeInTheDocument();
  expect(tank).not.toHaveClass("dossier-roster-row--connected");

  expect(within(alfa!).getByRole("img", { name: "DPS" })).toBeInTheDocument();
  expect(within(alfa!).getByText("Alfa")).toHaveClass(
    "dossier-character-name--demon-hunter"
  );
  expect(within(alfa!).getByText("Connected character")).toBeInTheDocument();
  expect(within(alfa!).getByText("Draenor")).toBeInTheDocument();
  // An item level Raider.IO did not give is a dash, never zero.
  expect(within(alfa!).getByText("—")).toBeInTheDocument();
  expect(alfa).toHaveClass("dossier-roster-row--connected");
});

it("shows every realm for a kill with no guild", () => {
  render(<DossierKillRoster guildRealm={null} roster={roster} />);
  expect(screen.getAllByText("Twisting Nether")).toHaveLength(2);
});

it.each([
  ["private", "The guild has hidden this raid's roster on Raider.IO."],
  ["no_logged_encounter", "Raider.IO has no logged encounter of this kill."],
  ["not_read", "Raider.IO's logged encounter has not been read yet."]
] as const)(
  "says why the roster is unavailable (%s), and never draws an empty table",
  (reason, text) => {
    render(
      <DossierKillRoster
        guildRealm={null}
        roster={{ state: "unavailable", reason }}
      />
    );
    expect(screen.getByText("Roster unavailable")).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  }
);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `corepack pnpm exec vitest run --project unit apps/web/src/components/dossier-kill-roster.test.tsx`
Expected: FAIL — cannot resolve `./dossier-kill-roster`.

- [ ] **Step 3: Implement the roster**

In `apps/web/src/components/dossier-character-name.tsx`, rename `colourClass` (line 68) to an exported `classColourModifier` (same body) and update both of its call sites, at lines 129 and 228 (each becomes `const modifier = classColourModifier(resolved.className);`):

```ts
/** The class-colour modifier for a class name, or null for one without a colour. */
export function classColourModifier(className: string | null): string | null {
  const normalized = className
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  return normalized ? (classColourClass[normalized] ?? null) : null;
}
```

Create `apps/web/src/components/dossier-kill-roster.tsx`:

```tsx
import type { DossierKillRoster as Roster } from "@slashwho/contracts";

import { classColourModifier } from "./dossier-character-name";

type AvailableRoster = Extract<Roster, { state: "available" }>;
type RosterRole = AvailableRoster["members"][number]["role"];

const unavailableReason: Readonly<
  Record<Extract<Roster, { state: "unavailable" }>["reason"], string>
> = {
  private: "The guild has hidden this raid's roster on Raider.IO.",
  no_logged_encounter: "Raider.IO has no logged encounter of this kill.",
  not_read: "Raider.IO's logged encounter has not been read yet."
};

const roleLabel: Readonly<Record<RosterRole, string>> = {
  tank: "Tank",
  healer: "Healer",
  dps: "DPS"
};

function counted(count: number, one: string): string {
  return `${String(count)} ${count === 1 ? one : `${one}s`}`;
}

function itemLevel(value: number): string {
  return value.toFixed(1);
}

function fightLength(durationMs: number): string {
  const seconds = Math.round(durationMs / 1_000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Realm slugs as the realm reads: `twisting-nether` is Twisting Nether. */
function realmName(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function sameRealm(a: string, b: string): boolean {
  const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return fold(a) === fold(b);
}

/** The roster's one summary line: size, roles, item level, and the fight. */
export function rosterSummary(roster: AvailableRoster): string {
  const { tank, healer, dps } = roster.roleCounts;
  return [
    counted(roster.playerCount, "player"),
    `${counted(tank, "tank")}, ${counted(healer, "healer")}, ${String(dps)} DPS`,
    `item level ${itemLevel(roster.itemLevel.average)} (${itemLevel(roster.itemLevel.min)}–${itemLevel(roster.itemLevel.max)})`,
    `pulled ${new Date(roster.pulledAt).toISOString().slice(11, 16)} UTC`,
    `${fightLength(roster.durationMs)} fight`,
    counted(roster.deathCount, "death"),
    counted(roster.vantusCount, "Vantus rune")
  ].join(" · ");
}

function RoleIcon({ role }: { role: RosterRole }) {
  const label = roleLabel[role];
  return (
    <svg
      aria-label={label}
      className={`dossier-roster-role dossier-roster-role--${role}`}
      fill="none"
      role="img"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 20 20"
    >
      <title>{label}</title>
      {role === "tank" ? (
        <path d="M10 2 4 5v5c0 4 3 7 6 8 3-1 6-4 6-8V5z" />
      ) : role === "healer" ? (
        <path d="M10 4v12M4 10h12" />
      ) : (
        <path d="m4 16 9-9M12 4l4 4-2 2-4-4z" />
      )}
    </svg>
  );
}

/**
 * Who was in the raid, from Raider.IO's logged encounter of the kill (#732).
 * An unavailable roster says why, and is never drawn as an empty table: that
 * would read as "nobody was there".
 */
export function DossierKillRoster({
  roster,
  guildRealm
}: {
  roster: Roster;
  /** The kill guild's realm; a raider on it shows no realm of their own. */
  guildRealm: string | null;
}) {
  if (roster.state === "unavailable") {
    return (
      <div className="dossier-roster-unavailable">
        <p>Roster unavailable</p>
        <p>{unavailableReason[roster.reason]}</p>
      </div>
    );
  }
  return (
    <div className="dossier-roster">
      <p className="dossier-roster-summary">{rosterSummary(roster)}</p>
      <table aria-label="Raid roster" className="dossier-roster-table">
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Character</th>
            <th scope="col">Class</th>
            <th scope="col">Realm</th>
            <th scope="col">Item level</th>
          </tr>
        </thead>
        <tbody>
          {roster.members.map((member) => {
            const modifier = classColourModifier(member.className);
            return (
              <tr
                className={
                  member.isDossierCharacter
                    ? "dossier-roster-row dossier-roster-row--connected"
                    : "dossier-roster-row"
                }
                key={`${member.region}/${member.realm}/${member.name}`}
              >
                <td>
                  <RoleIcon role={member.role} />
                </td>
                <td>
                  <span
                    className={
                      modifier
                        ? `dossier-character-name dossier-character-name--${modifier}`
                        : "dossier-character-name"
                    }
                  >
                    {member.name}
                  </span>
                  {member.isDossierCharacter ? (
                    <span className="dossier-roster-connected">
                      Connected character
                    </span>
                  ) : null}
                </td>
                <td>{member.className}</td>
                <td>
                  {guildRealm !== null && sameRealm(member.realm, guildRealm)
                    ? null
                    : realmName(member.realm)}
                </td>
                <td>
                  {member.itemLevel === null
                    ? "—"
                    : itemLevel(member.itemLevel)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

Run: `corepack pnpm exec vitest run --project unit apps/web/src/components/dossier-kill-roster.test.tsx`
Expected: PASS.

- [ ] **Step 4: Write the failing kill-card tests**

Append to `apps/web/src/components/dossier-raid-list.test.tsx`:

```tsx
it("shows a kill with no public logs as such, and builds its roster only once asked (#732)", () => {
  const roster = {
    state: "available" as const,
    playerCount: 2,
    roleCounts: { tank: 1, healer: 0, dps: 1 },
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    pulledAt: "2026-07-20T17:17:29.977Z",
    durationMs: 507_324,
    deathCount: 2,
    vantusCount: 16,
    members: [
      {
        name: "Bravo",
        realm: "twisting-nether",
        region: "eu",
        className: "Warrior",
        specName: "Protection",
        role: "tank" as const,
        itemLevel: 292.1,
        isDossierCharacter: false
      },
      {
        name: "Ryii",
        realm: "silvermoon",
        region: "eu",
        className: "Mage",
        specName: "Frost",
        role: "dps" as const,
        itemLevel: null,
        isDossierCharacter: true
      }
    ]
  };
  renderWithDossierCharacters(
    <DossierRaidList
      raids={[
        {
          raidId: "1308",
          raidName: "March on Quel'Danas",
          imageUrl: null,
          cuttingEdge: null,
          bosses: [
            {
              ...boss,
              bossName: "Midnight Falls",
              firstKill: {
                ...boss.firstKill,
                killedAt: "2026-07-20T17:25:57.301Z",
                guild: {
                  name: "Fixture Guild Alfa",
                  region: "eu",
                  realm: "twisting-nether"
                },
                reports: [],
                roster
              }
            }
          ]
        }
      ]}
    />
  );

  const firstKillParses = screen.getAllByRole("region", {
    name: "First kill parses"
  })[0]!;
  expect(
    within(firstKillParses).getByText("No public logs found")
  ).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Best parses" })).getByText(
      "No public logs found"
    )
  ).toBeVisible();

  fireEvent.click(screen.getByText("View kill evidence"));
  const evidence = screen.getByRole("region", { name: "Kill evidence" });
  const reports = within(evidence).getByText("Reports", {
    selector: "dt"
  }).parentElement!;
  expect(within(reports).getByText("No public logs found")).toBeVisible();

  expect(
    within(evidence).queryByRole("table", { name: "Raid roster" })
  ).not.toBeInTheDocument();
  fireEvent.click(within(evidence).getByText("View roster"));
  const table = within(evidence).getByRole("table", { name: "Raid roster" });
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  expect(within(table).getByText("Connected character")).toBeInTheDocument();
});

it("offers no roster disclosure for a kill Raider.IO never matched", () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={[
        {
          raidId: "1320",
          raidName: "The Venomous Abyss",
          imageUrl: null,
          cuttingEdge: null,
          bosses: [boss]
        }
      ]}
    />
  );
  fireEvent.click(screen.getByText("View kill evidence"));
  expect(screen.queryByText("View roster")).not.toBeInTheDocument();
});

it("says the roster is unavailable inside the disclosure", () => {
  renderWithDossierCharacters(
    <DossierRaidList
      raids={[
        {
          raidId: "1308",
          raidName: "March on Quel'Danas",
          imageUrl: null,
          cuttingEdge: null,
          bosses: [
            {
              ...boss,
              firstKill: {
                ...boss.firstKill,
                roster: { state: "unavailable", reason: "private" }
              }
            }
          ]
        }
      ]}
    />
  );
  fireEvent.click(screen.getByText("View kill evidence"));
  fireEvent.click(screen.getByText("View roster"));
  expect(screen.getByText("Roster unavailable")).toBeInTheDocument();
  expect(
    screen.getByText("The guild has hidden this raid's roster on Raider.IO.")
  ).toBeInTheDocument();
});
```

In `apps/web/src/components/dossier-view.test.tsx`, change the `"Report: —"` expectation (around line 283) to `"No public logs found"`.

Run: `corepack pnpm exec vitest run --project unit apps/web/src/components/dossier-raid-list.test.tsx apps/web/src/components/dossier-view.test.tsx`
Expected: FAIL — the empty parse lists say "No parse values were available.", Reports says "Report: —", and there is no "View roster".

- [ ] **Step 5: Implement the card and panel changes**

In `apps/web/src/components/dossier-parse-list.tsx`, add `emptyText?: string;` to `DossierParseListProps`, take it in the component (`emptyText = "No parse values were available."`) and render it:

```tsx
      {parses.length === 0 ? (
        <p className="dossier-parse-empty">{emptyText}</p>
      ) : (
```

In `apps/web/src/components/dossier-raid-list.tsx`:

- import `{ DossierKillRoster } from "./dossier-kill-roster";`
- in `ReportLinks`, replace `if (reports.length === 0) return <>Report: —</>;` with:

```tsx
// Display text for an empty list: a kill with no public report, such as one
// known only from Raider.IO's logged encounter (#732). Never a count of 0.
if (reports.length === 0) return <>No public logs found</>;
```

- add `const NO_PUBLIC_LOGS = "No public logs found";` above `KillEvidence`, and pass `emptyText={NO_PUBLIC_LOGS}` to all three `DossierParseList` uses in `KillEvidence` (the collapsed "First kill parses", "Best parses", and the panel's per-event parses);
- in the panel's `<dl>`, after the `Parses` `<div>`, add:

<!-- prettier-ignore -->
```tsx
            {evidence.roster ? (
              <div className="dossier-evidence-wide">
                <dt>Roster</dt>
                <dd>
                  <LazyDetails summary="View roster">
                    <DossierKillRoster
                      guildRealm={evidence.guild?.realm ?? null}
                      roster={evidence.roster}
                    />
                  </LazyDetails>
                </dd>
              </div>
            ) : null}
```

(A JSX child of the `<dl>`, so the braces are an expression container and nothing follows `null` but the closing brace.)

In `apps/web/src/app/globals.css`, after `.dossier-evidence dd { ... }`:

```css
.dossier-evidence-wide {
  grid-column: 1 / -1;
}

.dossier-roster {
  overflow-x: auto;
}

.dossier-roster-summary {
  margin: 0.4rem 0;
  color: var(--muted);
  font-size: 0.8125rem;
}

.dossier-roster-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.dossier-roster-table th {
  padding: 0.25rem 0.4rem;
  color: var(--muted);
  font-weight: 720;
  text-align: left;
}

.dossier-roster-table td {
  padding: 0.25rem 0.4rem;
  border-top: 1px solid var(--border);
}

.dossier-roster-row--connected {
  box-shadow: inset 3px 0 0 var(--success);
}

.dossier-roster-connected {
  margin-left: 0.4rem;
  color: var(--success);
  font-size: 0.75rem;
  font-weight: 720;
}

.dossier-roster-role {
  width: 1rem;
  height: 1rem;
  vertical-align: middle;
}

.dossier-roster-unavailable p {
  margin: 0.2rem 0 0;
}

.dossier-roster-unavailable p:first-child {
  font-weight: 720;
}
```

- [ ] **Step 6: Run the web tests and checks**

Run: `corepack pnpm exec vitest run --project unit apps/web/src`
Expected: PASS.

Run: `corepack pnpm --filter @slashwho/web typecheck && corepack pnpm lint`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): show kills with no public logs and a lazy Raider.IO roster (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Evidence semantics documentation and the full gate

**Files:**

- Modify: `docs/dossier-evidence-semantics.md`

**Interfaces:**

- Consumes: the behaviour of Tasks 1-7.
- Produces: documentation only.

- [ ] **Step 1: Document the evidence source and the policy change**

Append to `docs/dossier-evidence-semantics.md`:

```markdown
## Raider.IO-logged first kills

A Raider.IO Mythic **first kill** is evidence when Raider.IO holds a logged
encounter of it (#732). A logged encounter is a parsed combat log, so it is
treated as one: the character counts as present only when the roster holds
their Raider.IO character id. Where the guild has hidden the roster, Raider.IO's
own attribution of that logged encounter to the character stands in for it.
Raider.IO's plain kill list, without a logged encounter, stays a place to
search Warcraft Logs and is never evidence on its own. Later kills, Heroic and
Normal are never read.

Warcraft Logs stays the source for everything it has. A Raider.IO first kill
within two hours (`STORED_KILL_MATCH_MS`) of a Warcraft Logs kill of the same
character and boss is that kill: the Warcraft Logs kill keeps its reports,
parses and guild, and gains the roster. An unmatched one becomes a kill of its
own, dated by the encounter's defeat, with the encounter's guild and no
reports or parses; if it is earlier than the character's Warcraft Logs kill it
becomes the boss's first kill. The same-region, same-date grouping above still
applies, so an unmatched Raider.IO kill on the night of a Warcraft Logs kill
shares that night's event. Its world rank comes from the encounter's guild and
exact defeat time, so a guild's first kill gets its rank and a later kill with
that guild gets none.

What is kept of a logged encounter is fixed: the kill's pull and defeat times,
duration and item levels, the raid and boss, the guild, whether the roster is
visible, deaths and Vantus runes, and each raider's Raider.IO id, name, realm,
region, class, specialisation, role and item level. The uploaders
(`log.sources`, which can hold a BattleTag or Discord handle) and the raw
response are never kept. A logged encounter is stored once and shared; each
run publishes its first kills with the rest of its snapshot. A visible roster
is never read again: the kill and who was in it do not change. A roster the
guild hid is read again once a week old, since a guild can open it later. A
permanent refusal (a deleted log, a 403, or a log of another kill) is stored
too, so it is not asked about again for 30 days, and the kill counts as having
no logged encounter meanwhile.

A raider removed from SlashWho (`suppressed_characters`) is left off every
roster a dossier shows, while the player and role counts stay Raider.IO's. The
stored rows are kept; removal suppresses reads, as it does everywhere else.

States stay distinct:

- Reports and parses a kill has no public log for are shown as "No public logs
  found". That is display text for an empty list, never numeric zero.
- A roster that cannot be shown is "Roster unavailable", with the reason: the
  guild hid it, Raider.IO has no logged encounter of the kill, or it has not
  been read yet. It is never an empty table and never "not present".
- A raider whose item level Raider.IO did not give shows "—", never 0.
- A kill with no guild (a pug) shows "—", as elsewhere.

A failed or capped logged-encounter read makes the run partial, so it never
removes a stored kill; a run that could not read the kill list at all carries
every stored Raider.IO first kill forward unchanged. A capped run is not
retried early: the rest are read on the character's next ordinary run, 50 at a
time. A run partial only for its Raider.IO reads still supports "No qualifying
public logs found", because its Warcraft Logs history scan ran; a run whose
scan was skipped never does.
```

Run: `corepack pnpm exec prettier --check docs/dossier-evidence-semantics.md`
Expected: passes (run `--write` on the file if it does not).

- [ ] **Step 2: Run the whole gate**

Docker must be running for `test:integration` and `test:e2e`; a skipped suite is not a passing one.

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
```

Expected: every command exits 0. `test:unit` includes `scripts/recorded-payloads.test.mts` (the recorded-fixture gate) and `packages/database/src/migration-journal.test.ts`. No test makes a live Raider.IO or Warcraft Logs request.

- [ ] **Step 3: Commit**

```bash
git add docs/dossier-evidence-semantics.md
git commit -m "docs(evidence): Raider.IO-logged first kills as an evidence source (#732)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** Reading the data (§1): Task 2 (id, gateway method, privacy mapping through `isRosterShown`, one limitation mapper) and Task 5 (phase, cap 50, concurrency 4, abandon on throw, re-read rules, permanent answers stored, presence by id with fallback, no cap retry). Matching (§2): Task 3 (`matchesRaiderIoKill`, Grong placed), Task 6 (2-hour match, unmatched kill events, earlier first kill, withheld under Raider.IO and counted once) and Task 5 (world rank through `historicWorldRankForKill`, read kills only, a checked rank cached; the later-kill rule pinned with a synthetic guild). Storage (§3): Task 4 (three tables with unavailable rows and `normalized_name`, the run-cost column, publish atomicity, merge rules). Removal (§4): Task 4 (the suppression filter on the dossier's load, counts kept) and Task 6 (a roster left with nobody to name). Contract and domain (§5): Task 6, including the skipped-scan rule for `warcraftLogsComplete`. Interface (§6) and evidence states (§7): Task 7. Testing (§8): recorded fixtures in Task 1, each layer's tests in its task, synthetic identities throughout, no live traffic. Documentation (§9): Task 8. Out of scope: the different-guild flag and the Raider.IO link are not built (spec, Out of scope).
- **Review and pre-flight findings.** PR #734's eight inline comments and pre-flight D1-D13 are each answered by a Global Constraint, a Decision (3, 5, 7, 9, 13-19) or a pinned test named in Review Focus. The four snippets prettier had turned into invalid code (a trailing `;` in a `check()` argument, an array element, an object property and a JSX child) are now written as they sit in context, and the fragments prettier would rewrite carry `<!-- prettier-ignore -->`. Line references were re-checked against `bf7cb95a`.
- **Deviations** are listed once, under "Decisions this plan makes that the spec did not settle", and none adds scope the spec rules out.
