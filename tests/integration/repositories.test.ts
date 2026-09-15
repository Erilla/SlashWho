import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresRepositories,
  runMigrations,
  type Repositories,
  type CharacterMythicKillInput,
  type CharacterMythicWipeInput,
  type SnapshotCharacterInput,
  type StoredSnapshot
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

const rootKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
} as const;

const altKey = {
  region: "us",
  realm: "area-52",
  name: "other"
} as const;

function observation(
  key: CharacterKey,
  displayName: string,
  source: SnapshotCharacterInput["source"] = "input"
): SnapshotCharacterInput {
  return {
    key,
    displayName,
    className: "Mage",
    level: 80,
    raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
    source
  };
}

function mythicKill(
  overrides: Partial<CharacterMythicKillInput> = {}
): CharacterMythicKillInput {
  const { performance: overridePerformance, ...restOverrides } = overrides;
  return {
    raidId: "42",
    raidName: "Nerub-ar Palace",
    bossId: "1234",
    bossName: "Queen Ansurek",
    journalBossId: "3014",
    bossOrder: 8,
    isFinalBoss: true,
    killedAt: "2026-08-04T12:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/example",
    fightUrl: "https://www.warcraftlogs.com/reports/example#fight=1",
    guild: { name: "Example Guild", realm: "silvermoon" },
    historicWorldRank: null,
    performance: {
      spec: null,
      damage: { state: "unavailable" },
      healing: { state: "unavailable" },
      bossDamage: { state: "unavailable" },
      ...overridePerformance
    },
    ...restOverrides
  };
}

function mythicWipe(
  overrides: Partial<CharacterMythicWipeInput> = {}
): CharacterMythicWipeInput {
  return {
    raidId: "42",
    raidName: "Nerub-ar Palace",
    bossId: "1233",
    bossName: "Nexus-Princess Ky'veza",
    journalBossId: "2920",
    bossOrder: 6,
    attemptedAt: "2026-08-04T11:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/wipe",
    fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=1",
    ...overrides
  };
}

async function seedCompleteSnapshot(
  repositories: Repositories,
  options: {
    refreshedAt?: Date;
    displayName?: string;
    characters?: SnapshotCharacterInput[];
    state?: "complete" | "partial";
    limitationCode?: string | null;
  } = {}
): Promise<StoredSnapshot> {
  const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
  await repositories.runs.markRunning(run.id);
  const snapshot = await repositories.snapshots.create({
    runId: run.id,
    rootKey,
    state: options.state ?? "complete",
    limitationCode: options.limitationCode ?? null,
    refreshedAt: options.refreshedAt ?? new Date(),
    characters: options.characters ?? [
      observation(rootKey, options.displayName ?? "Ryii")
    ]
  });
  await repositories.runs.complete(run.id, snapshot.id);
  return snapshot;
}

describe("PostgreSQL repositories", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: Repositories;

  beforeAll(async () => {
    ({ pool, stop } = await startPostgres());
    await runMigrations(pool);
    repositories = createPostgresRepositories(pool);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE
      character_mythic_kills,
      character_mythic_wipes,
      character_evidence_runs,
      snapshot_characters,
      snapshots,
      discovery_runs,
      characters,
      suppressed_characters,
      negative_character_cache,
      rate_limit_events,
      manual_dossier_connections
      CASCADE`);
  });

  it("keeps enriched parses when a later partial run cannot re-enrich them", async () => {
    // Break caught: a rate-limited re-collection re-found the same kills without
    // parse data and overwrote richer stored rows, losing specs and percentiles.
    const enriched = mythicKill({
      performance: {
        spec: {
          name: "Assassination",
          iconUrl:
            "https://wow.zamimg.com/images/wow/icons/medium/ability_rogue_deadlybrew.jpg"
        },
        damage: { state: "available", percentile: 91 },
        healing: { state: "available", percentile: 82 },
        bossDamage: { state: "available", percentile: 87 }
      }
    });
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "partial",
      limitationCode: "parse_request_cap",
      parseLimitationCode: null,
      kills: [enriched],
      wipes: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    // The same fight, re-found by a rate-limited run that enriched nothing.
    const second = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T13:00:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (second.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(second.run.id, {
      state: "partial",
      limitationCode: "parse_rate_limited",
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      completedAt: new Date("2026-08-04T13:05:00.000Z")
    });

    const stored = await repositories.evidence.getCompleted(rootKey);
    expect(stored?.kills).toHaveLength(1);
    expect(stored?.kills[0]?.performance).toMatchObject({
      spec: { name: "Assassination" },
      damage: { state: "available", percentile: 91 },
      healing: { state: "available", percentile: 82 },
      bossDamage: { state: "available", percentile: 87 }
    });
  });

  it("carries the character's class onto a claimed evidence run", async () => {
    // Break caught: Warcraft Logs omits a class on its ranks, so evidence
    // collection needs the stored class to settle shared specialisation names.
    await seedCompleteSnapshot(repositories);
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    const claimed = await repositories.evidence.claim(reservation.run.id, 1);

    expect(claimed?.className).toBe("Mage");
    await expect(
      repositories.evidence.find(reservation.run.id)
    ).resolves.toMatchObject({ className: "Mage" });
  });

  it("retains the last completed evidence while a stale character refresh is active", async () => {
    // Break caught: a refresh could make previously completed dossier evidence
    // disappear until its replacement scan finishes.
    const completedAt = new Date("2026-08-04T12:00:00.000Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: completedAt
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      completedAt
    });

    const refresh = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:01:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });

    expect(refresh).toMatchObject({
      kind: "reserved",
      completed: {
        run: { id: first.run.id, status: "complete" },
        kills: [mythicKill()],
        wipes: [mythicWipe()]
      }
    });
    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: first.run.id, status: "complete" },
      kills: [mythicKill()],
      wipes: [mythicWipe()]
    });
    await expect(
      repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-08-04T12:01:00.000Z"),
        at: new Date("2026-08-04T13:01:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "active",
      run: { id: refresh.run.id, status: "queued" },
      completed: { run: { id: first.run.id } }
    });
  });

  it("refreshes evidence produced before the fight-parse cache version", async () => {
    // Break caught: deploying a parse decoder fix could leave every previously
    // cached kill fresh forever, so the worker would never recompute its metrics.
    const completedAt = new Date("2026-08-04T12:00:00.000Z");
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: completedAt
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      completedAt
    });
    await pool.query(
      "UPDATE character_evidence_runs SET evidence_version = 2 WHERE id = $1",
      [first.run.id]
    );

    await expect(
      repositories.evidence.reserve({
        key: rootKey,
        freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
        at: new Date("2026-08-04T13:00:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "reserved",
      completed: { run: { id: first.run.id }, kills: [mythicKill()] }
    });
  });

  it("persists every distinct wipe fight for one boss", async () => {
    // Break caught: a per-boss uniqueness key silently dropped earlier wipes,
    // even though the dossier must show the complete report history.
    const reservation = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reservation.kind !== "reserved")
      throw new Error("evidence_not_reserved");

    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [
        mythicWipe(),
        mythicWipe({
          attemptedAt: "2026-08-04T10:00:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=2"
        })
      ],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      wipes: [
        expect.objectContaining({
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=1"
        }),
        expect.objectContaining({
          fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=2"
        })
      ]
    });
  });

  it("atomically publishes a complete replacement evidence scan", async () => {
    // Break caught: a reader could observe a completed run with only part of
    // its normalized WCL fights after a worker crashes during persistence.
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");

    await repositories.evidence.publish(reserved.run.id, {
      state: "partial",
      limitationCode: "request_cap",
      parseLimitationCode: null,
      completedAt: new Date("2026-08-04T12:05:00.000Z"),
      kills: [
        mythicKill(),
        mythicKill({
          bossId: "1235",
          bossName: "Silken Court",
          bossOrder: 7,
          fightUrl: "https://www.warcraftlogs.com/reports/example#fight=2"
        })
      ],
      wipes: [mythicWipe()]
    });

    await expect(repositories.evidence.getCompleted(rootKey)).resolves.toEqual({
      run: expect.objectContaining({
        id: reserved.run.id,
        status: "partial",
        limitationCode: "request_cap"
      }),
      evidenceVersion: 10,
      kills: [
        expect.objectContaining({ bossId: "1234", bossOrder: 8 }),
        expect.objectContaining({ bossId: "1235", bossOrder: 7 })
      ],
      wipes: [expect.objectContaining({ bossId: "1233", bossOrder: 6 })],
      wipeCapable: true
    });
  });

  it("recovers complete evidence hidden behind a legacy partial refresh", async () => {
    const first = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (first.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(first.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });
    await pool.query(
      `INSERT INTO character_evidence_runs
        (region, realm_slug, normalized_name, status, limitation_code, completed_at)
       VALUES ($1, $2, $3, 'partial', 'request_cap', $4)`,
      [
        rootKey.region,
        rootKey.realm,
        rootKey.name,
        new Date("2026-08-04T12:30:00.000Z")
      ]
    );
    const refresh = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:31:00.000Z"),
      at: new Date("2026-08-04T13:00:00.000Z")
    });
    if (refresh.kind !== "reserved") throw new Error("evidence_not_reserved");

    await repositories.evidence.publish(refresh.run.id, {
      state: "partial",
      limitationCode: "schema_drift",
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      completedAt: new Date("2026-08-04T13:01:00.000Z")
    });

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: refresh.run.id, status: "partial" },
      kills: [mythicKill()],
      wipes: [mythicWipe()],
      wipeCapable: true
    });
  });

  it("marks pre-wipe-schema evidence as incapable of negative conclusions", async () => {
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T11:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [mythicKill()],
      wipes: [],
      completedAt: new Date("2026-08-04T12:00:00.000Z")
    });
    await pool.query(
      "UPDATE character_evidence_runs SET evidence_version = 1 WHERE id = $1",
      [reserved.run.id]
    );

    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      wipeCapable: false,
      kills: [mythicKill()]
    });
  });

  it("validates independent history and parse limitation publication states", async () => {
    // Break caught: adding a second limitation channel could reject valid
    // complete/partial states or permit an ambiguous partial publication.
    const cases = [
      {
        state: "complete" as const,
        limitationCode: null,
        parseLimitationCode: null
      },
      {
        state: "partial" as const,
        limitationCode: "request_cap",
        parseLimitationCode: null
      },
      {
        state: "complete" as const,
        limitationCode: null,
        parseLimitationCode: "parse_request_cap"
      },
      {
        state: "partial" as const,
        limitationCode: "request_cap",
        parseLimitationCode: "parse_request_cap"
      }
    ];
    for (const [index, input] of cases.entries()) {
      const key = { ...rootKey, name: `limitation-${index}` };
      const reserved = await repositories.evidence.reserve({
        key,
        freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
        at: new Date("2026-08-04T12:00:00.000Z")
      });
      if (reserved.kind !== "reserved")
        throw new Error("evidence_not_reserved");
      await repositories.evidence.publish(reserved.run.id, {
        ...input,
        kills: [],
        wipes: [],
        completedAt: new Date("2026-08-04T12:05:00.000Z")
      });
      await expect(
        repositories.evidence.find(reserved.run.id)
      ).resolves.toMatchObject({
        status: input.state,
        limitationCode: input.limitationCode,
        parseLimitationCode: input.parseLimitationCode
      });
    }
    for (const [index, input] of [
      {
        state: "complete" as const,
        limitationCode: "request_cap",
        parseLimitationCode: null
      },
      {
        state: "partial" as const,
        limitationCode: null,
        parseLimitationCode: "parse_request_cap"
      }
    ].entries()) {
      const reserved = await repositories.evidence.reserve({
        key: { ...rootKey, name: `invalid-limitation-${index}` },
        freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
        at: new Date("2026-08-04T12:00:00.000Z")
      });
      if (reserved.kind !== "reserved")
        throw new Error("evidence_not_reserved");
      await expect(
        repositories.evidence.publish(reserved.run.id, {
          ...input,
          kills: [],
          wipes: [],
          completedAt: new Date("2026-08-04T12:05:00.000Z")
        })
      ).rejects.toThrow("character_evidence_publication_invalid");
    }
  });

  it("round-trips normalized kill parses", async () => {
    // Break caught: storage could lose a normalized parse state or percentile,
    // including a valid zero, while replacing a completed evidence scan.
    const initial = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (initial.kind !== "reserved") throw new Error("evidence_not_reserved");

    const initialKills = [
      mythicKill({
        performance: {
          damage: { state: "available", percentile: 0 },
          healing: { state: "not_applicable" },
          bossDamage: { state: "unavailable" }
        }
      }),
      mythicKill({
        bossId: "1235",
        bossName: "Silken Court",
        bossOrder: 7,
        fightUrl: "https://www.warcraftlogs.com/reports/example#fight=2",
        performance: {
          damage: { state: "available", percentile: 99.25 },
          healing: { state: "unavailable" },
          bossDamage: { state: "not_applicable" }
        }
      })
    ];
    await repositories.evidence.publish(initial.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: initialKills,
      wipes: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });

    const replacement = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:06:00.000Z"),
      at: new Date("2026-08-04T12:06:00.000Z")
    });
    if (replacement.kind !== "reserved") {
      throw new Error("replacement_not_reserved");
    }

    const withoutIds = (kills: readonly { id: string }[]) =>
      kills.map((kill) => {
        const { id, ...withoutId } = kill;
        void id;
        return withoutId;
      });
    await expect(
      repositories.evidence.getCompleted(rootKey)
    ).resolves.toMatchObject({
      run: { id: initial.run.id },
      kills: initialKills
    });
    expect(
      withoutIds((await repositories.evidence.getCompleted(rootKey))!.kills)
    ).toEqual(initialKills);

    const replacementKills = [
      mythicKill({
        bossId: "1236",
        bossName: "The Bloodbound Horror",
        bossOrder: 1,
        fightUrl: "https://www.warcraftlogs.com/reports/example#fight=3",
        performance: {
          damage: { state: "not_applicable" },
          healing: { state: "available", percentile: 99.25 },
          bossDamage: { state: "available", percentile: 0 }
        }
      })
    ];
    await repositories.evidence.publish(replacement.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: replacementKills,
      wipes: [],
      completedAt: new Date("2026-08-04T12:10:00.000Z")
    });

    const completed = await repositories.evidence.getCompleted(rootKey);
    expect(completed?.run.id).toBe(replacement.run.id);
    expect(withoutIds(completed!.kills)).toEqual(replacementKills);
  });

  it("rejects an invalid normalized parse before publication", async () => {
    // Break caught: an out-of-range parse percentile could reach persistence
    // and violate the normalized state/value contract.
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");

    await expect(
      repositories.evidence.publish(reserved.run.id, {
        state: "complete",
        limitationCode: null,
        parseLimitationCode: null,
        kills: [
          mythicKill({
            performance: {
              damage: { state: "available", percentile: 100.01 },
              healing: { state: "unavailable" },
              bossDamage: { state: "unavailable" }
            }
          })
        ],
        wipes: [],
        completedAt: new Date("2026-08-04T12:05:00.000Z")
      })
    ).rejects.toThrow(RangeError);
    await expect(
      repositories.evidence.find(reserved.run.id)
    ).resolves.toMatchObject({
      status: "queued"
    });
  });

  it("rejects null percentiles for available parse states", async () => {
    // Break caught: PostgreSQL CHECK treats a null available percentile as
    // unknown unless the available branch requires a concrete value.
    const reserved = await repositories.evidence.reserve({
      key: rootKey,
      freshnessCutoff: new Date("2026-08-04T12:00:00.000Z"),
      at: new Date("2026-08-04T12:00:00.000Z")
    });
    if (reserved.kind !== "reserved") throw new Error("evidence_not_reserved");
    await repositories.evidence.publish(reserved.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [
        mythicKill({
          performance: {
            damage: { state: "available", percentile: 0 },
            healing: { state: "available", percentile: 0 },
            bossDamage: { state: "available", percentile: 0 }
          }
        })
      ],
      wipes: [],
      completedAt: new Date("2026-08-04T12:05:00.000Z")
    });
    const completed = await repositories.evidence.getCompleted(rootKey);
    const kill = completed?.kills[0];
    if (!kill) throw new Error("published_kill_missing");
    expect(kill.performance).toEqual({
      spec: null,
      damage: { state: "available", percentile: 0 },
      healing: { state: "available", percentile: 0 },
      bossDamage: { state: "available", percentile: 0 }
    });

    for (const percentileColumn of [
      "damage_percentile",
      "healing_percentile",
      "boss_damage_percentile"
    ]) {
      await expect(
        pool.query(
          `UPDATE character_mythic_kills
           SET ${percentileColumn} = NULL
           WHERE id = $1`,
          [kill.id]
        )
      ).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("stores encrypted WCL credentials only when the reservation creates a new run", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    expect(reservation.kind).toBe("reserved");
    expect(reservation.run.wclClientIdEncrypted).toBe("encrypted-id");
    expect(reservation.run.wclClientSecretEncrypted).toBe("encrypted-secret");
  });

  it("clears encrypted WCL credentials when a run is published", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter2"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      completedAt: new Date()
    });
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBeNull();
    expect(found?.wclClientSecretEncrypted).toBeNull();
  });

  it("clears encrypted WCL credentials when a run fails", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter3"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    await repositories.evidence.fail(reservation.run.id, "some_error");
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBeNull();
    expect(found?.wclClientSecretEncrypted).toBeNull();
  });

  it("clears stale encrypted WCL credentials left behind by an abandoned run", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter4"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });
    await repositories.evidence.claim(reservation.run.id, 1);
    // Simulate the job never reaching publish()/fail() (a crash, a timeout,
    // the process being killed) by backdating created_at past the window.
    await pool.query(
      `UPDATE character_evidence_runs SET created_at = $2 WHERE id = $1`,
      [reservation.run.id, new Date(Date.now() - 2 * 60 * 60_000)]
    );

    const removed = await repositories.evidence.clearStaleCredentials(
      new Date(Date.now() - 60 * 60_000)
    );

    expect(removed).toBe(1);
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBeNull();
    expect(found?.wclClientSecretEncrypted).toBeNull();
  });

  it("leaves credentials on runs created after the cutoff untouched", async () => {
    const key = {
      region: "eu",
      realm: "silvermoon",
      name: "Testcharacter5"
    } as const;
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(0),
      at: new Date(),
      credentials: {
        wclClientIdEncrypted: "encrypted-id",
        wclClientSecretEncrypted: "encrypted-secret"
      }
    });

    const removed = await repositories.evidence.clearStaleCredentials(
      new Date(Date.now() - 60 * 60_000)
    );

    expect(removed).toBe(0);
    const found = await repositories.evidence.find(reservation.run.id);
    expect(found?.wclClientIdEncrypted).toBe("encrypted-id");
    expect(found?.wclClientSecretEncrypted).toBe("encrypted-secret");
  });

  describe("manual dossier connections", () => {
    const pendingKey = {
      region: "eu",
      realm: "silvermoon",
      name: "undiscovered"
    } as const;

    it("links a character that has not been discovered yet", async () => {
      // Break caught: the insert used to join `characters` twice, so a target
      // with no row yielded no rows and was reported as a duplicate. A
      // reviewer could not link a character before its discovery finished.
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.add(rootKey, pendingKey)
      ).resolves.toBe("added");

      const listed = await repositories.manualConnections.list(rootKey);
      expect(listed).toEqual([
        {
          key: pendingKey,
          displayName: "undiscovered",
          className: null,
          level: 0,
          raiderIoUrl:
            "https://raider.io/characters/eu/silvermoon/undiscovered",
          pending: true,
          excluded: false
        }
      ]);
    });

    it("reports a repeated link as a duplicate rather than adding it twice", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);

      await expect(
        repositories.manualConnections.add(rootKey, pendingKey)
      ).resolves.toBe("duplicate");
      expect(await repositories.manualConnections.list(rootKey)).toHaveLength(
        1
      );
    });

    it("resolves the character once discovery creates it", async () => {
      // Break caught: the link is stored by key, so it has to pick up the real
      // display name, class and level on its own as soon as the character
      // exists, with no second write and no backfill step.
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, altKey);

      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { pending: true, className: null, level: 0 }
      ]);

      const run = await repositories.runs.createOrReuse(altKey, "anonymous");
      await repositories.runs.markRunning(run.id);
      const snapshot = await repositories.snapshots.create({
        runId: run.id,
        rootKey: altKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date(),
        characters: [observation(altKey, "Other")]
      });
      await repositories.runs.complete(run.id, snapshot.id);

      expect(await repositories.manualConnections.list(rootKey)).toEqual([
        {
          key: altKey,
          displayName: "Other",
          className: "Mage",
          level: 80,
          raiderIoUrl: "https://raider.io/characters/us/area-52/other",
          pending: false,
          excluded: false
        }
      ]);
    });

    it("withholds a connection whose character has an active removal request", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);
      await repositories.suppressions.suppress(pendingKey, "removal", null);

      expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
    });

    it("marks a connection as excluded and restores it again", async () => {
      await seedCompleteSnapshot(repositories);
      await repositories.manualConnections.add(rootKey, pendingKey);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, true)
      ).resolves.toBe("updated");
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { excluded: true }
      ]);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, false)
      ).resolves.toBe("updated");
      expect(await repositories.manualConnections.list(rootKey)).toMatchObject([
        { excluded: false }
      ]);
    });

    it("reports an exclusion of a character that is not linked as missing", async () => {
      // Two reviewers can hold the same dossier, so the second must be told
      // the link has gone rather than shown a change it did not make.
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.setExcluded(rootKey, pendingKey, true)
      ).resolves.toBe("missing");
    });

    it("unlinks a connection without touching the character or its snapshot", async () => {
      await seedCompleteSnapshot(repositories, {
        characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
      });
      await repositories.manualConnections.add(rootKey, altKey);

      await expect(
        repositories.manualConnections.remove(rootKey, altKey)
      ).resolves.toBe("removed");

      expect(await repositories.manualConnections.list(rootKey)).toEqual([]);
      // #186: removal unlinks, it does not delete the discovered character or
      // the snapshot that found it.
      const snapshot = await repositories.snapshots.getCurrent(rootKey);
      expect(
        snapshot?.characters.map((character) => character.key.name)
      ).toContain(altKey.name);
    });

    it("reports a removal of a character that is not linked as missing", async () => {
      await seedCompleteSnapshot(repositories);

      await expect(
        repositories.manualConnections.remove(rootKey, pendingKey)
      ).resolves.toBe("missing");
    });

    it("keeps an exclusion scoped to the dossier it was made on", async () => {
      // A connection is stored per root, so excluding a character on one
      // applicant's dossier must say nothing about anyone else's.
      await seedCompleteSnapshot(repositories, {
        characters: [observation(rootKey, "Ryii"), observation(altKey, "Other")]
      });
      await repositories.manualConnections.add(rootKey, pendingKey);
      await repositories.manualConnections.add(altKey, pendingKey);

      await repositories.manualConnections.setExcluded(
        rootKey,
        pendingKey,
        true
      );

      expect(await repositories.manualConnections.list(altKey)).toMatchObject([
        { excluded: false }
      ]);
    });
  });

  afterAll(async () => {
    await stop();
  });

  it("reuses one active run under concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repositories.runs.createOrReuse(rootKey, "anonymous")
      )
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
  });

  it("atomically grants one claim for a delivery attempt", async () => {
    // Break caught: duplicate deliveries could both perform discovery and persistence.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");

    const claims = await Promise.all([
      repositories.runs.claim(run.id, 1),
      repositories.runs.claim(run.id, 1)
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      attempt: 1
    });
  });

  it("records retry and failure lifecycle fields without leaking diagnostics", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "bot");
    const retryAt = new Date("2026-08-04T12:05:00.000Z");
    await repositories.runs.markRunning(run.id);
    await repositories.runs.markRetrying(run.id, 3, retryAt);
    expect(await repositories.runs.find(run.id)).toMatchObject({
      status: "retrying",
      attempt: 3,
      nextRetryAt: retryAt
    });

    await repositories.runs.fail(run.id, "upstream_unavailable");

    expect(await repositories.runs.find(run.id)).toMatchObject({
      status: "failed",
      callerClass: "bot",
      attempt: 3,
      nextRetryAt: null,
      errorCode: "upstream_unavailable"
    });
    expect(await repositories.runs.findActive(rootKey)).toBeNull();
  });

  it("clears a scheduled retry when the run starts again", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRetrying(
      run.id,
      2,
      new Date("2026-08-04T12:05:00.000Z")
    );

    await repositories.runs.markRunning(run.id);

    expect(await repositories.runs.find(run.id)).toMatchObject({
      status: "running",
      nextRetryAt: null
    });
  });

  it("stores a snapshot and every membership row atomically", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const duplicate = observation(rootKey, "Ryii");

    await expect(
      repositories.snapshots.create({
        runId: run.id,
        rootKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
        characters: [duplicate, duplicate]
      })
    ).rejects.toMatchObject({ code: "23505" });

    const counts = await pool.query<{ characters: string; snapshots: string }>(`
      SELECT
        (SELECT count(*)::text FROM characters) AS characters,
        (SELECT count(*)::text FROM snapshots) AS snapshots
    `);
    expect(counts.rows[0]).toEqual({ characters: "0", snapshots: "0" });
  });

  it("rolls back fingerprint cadence completion when merged snapshot publication cannot finish", async () => {
    // Break caught: a crash between snapshot completion and cadence advancement
    // could make the public snapshot visible while the sweep stayed reusable.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff: new Date("2026-08-01T12:00:00.000Z"),
      at: new Date("2026-08-08T12:00:00.000Z")
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");

    await expect(
      repositories.snapshots.createAndFinishFingerprintSweep(
        {
          runId: run.id,
          rootKey,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date("2026-08-08T12:00:00.000Z"),
          characters: [observation(rootKey, "Ryii")]
        },
        {
          reservationId: "00000000-0000-4000-8000-000000000999",
          finishedAt: new Date("2026-08-08T12:00:00.000Z"),
          limitationCode: null
        }
      )
    ).rejects.toThrow("fingerprint_reservation_not_active");

    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      snapshotId: null
    });
  });

  it("publishes the snapshot and advances fingerprint cadence together", async () => {
    // Break caught: a successful combined publication could commit the snapshot
    // but leave the next run eligible for another sweep immediately.
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);
    const at = new Date("2026-08-08T12:00:00.000Z");
    const admission = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff: new Date("2026-08-01T12:00:00.000Z"),
      at
    });
    if (admission.kind !== "admitted") throw new Error("sweep_not_admitted");

    await repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: run.id,
        rootKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: at,
        characters: [observation(rootKey, "Ryii")]
      },
      {
        reservationId: admission.reservationId,
        finishedAt: at,
        limitationCode: null
      }
    );

    const nextRun = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: nextRun.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 2,
        cadenceCutoff: new Date("2026-08-01T12:00:00.000Z"),
        at: new Date("2026-08-08T12:01:00.000Z")
      })
    ).resolves.toEqual({ kind: "not_due" });
  });

  it("avoids deadlocks for overlapping snapshots with inverse display order", async () => {
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const secondRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    await pool.query(`
      CREATE FUNCTION test_pause_character_write() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER test_pause_character_write
      AFTER INSERT OR UPDATE ON characters
      FOR EACH ROW EXECUTE FUNCTION test_pause_character_write();
    `);

    let results: PromiseSettledResult<StoredSnapshot>[];
    try {
      results = await Promise.allSettled([
        repositories.snapshots.create({
          runId: firstRun.id,
          rootKey,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
          characters: [
            observation(rootKey, "Ryii"),
            observation(altKey, "Other", "claimed")
          ]
        }),
        repositories.snapshots.create({
          runId: secondRun.id,
          rootKey: altKey,
          state: "complete",
          limitationCode: null,
          refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
          characters: [
            observation(altKey, "Other"),
            observation(rootKey, "Ryii", "claimed")
          ]
        })
      ]);
    } finally {
      await pool.query("DROP TRIGGER test_pause_character_write ON characters");
      await pool.query("DROP FUNCTION test_pause_character_write() CASCADE");
    }

    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    if (results[0]?.status === "fulfilled") {
      expect(results[0].value.characters.map(({ key }) => key)).toEqual([
        rootKey,
        altKey
      ]);
    }
    if (results[1]?.status === "fulfilled") {
      expect(results[1].value.characters.map(({ key }) => key)).toEqual([
        altKey,
        rootKey
      ]);
    }
  });

  it("rejects a snapshot whose root does not match its discovery run", async () => {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");

    await expect(
      repositories.snapshots.create({
        runId: run.id,
        rootKey: altKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
        characters: [observation(altKey, "Other")]
      })
    ).rejects.toThrow("discovery_run_root_mismatch");

    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM snapshots"
    );
    expect(result.rows[0]?.count).toBe("0");
  });

  it("rejects completing a run with another run's snapshot", async () => {
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const secondRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    const secondSnapshot = await repositories.snapshots.create({
      runId: secondRun.id,
      rootKey: altKey,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
      characters: [observation(altKey, "Other")]
    });

    await expect(
      repositories.runs.complete(firstRun.id, secondSnapshot.id)
    ).rejects.toThrow("discovery_run_not_found");
    expect((await repositories.runs.find(firstRun.id))?.status).toBe("queued");
  });

  it("keeps historical observations immutable when latest values change", async () => {
    const oldSnapshot = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-03T12:00:00.000Z"),
      displayName: "OldCasing"
    });
    const newSnapshot = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-04T12:00:00.000Z"),
      displayName: "NewCasing"
    });

    expect(
      (await repositories.snapshots.find(oldSnapshot.id))?.characters[0]
    ).toMatchObject({ displayName: "OldCasing" });
    expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
      newSnapshot.id
    );
    expect(
      (await repositories.snapshots.getCurrent(rootKey))?.characters[0]
    ).toMatchObject({ displayName: "NewCasing" });
  });

  it("does not replace the latest snapshot when a refresh fails", async () => {
    const previous = await seedCompleteSnapshot(repositories);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.fail(run.id, "upstream_unavailable");

    expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
      previous.id
    );
  });

  it("allows either snapshot publication or failure to win, never both", async () => {
    const previous = await seedCompleteSnapshot(repositories);
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);

    const [publication, failure] = await Promise.allSettled([
      repositories.snapshots.create({
        runId: run.id,
        rootKey,
        state: "complete",
        limitationCode: null,
        refreshedAt: new Date(previous.refreshedAt.getTime() + 1_000),
        characters: [observation(rootKey, "RefreshedRyii")]
      }),
      repositories.runs.fail(run.id, "upstream_unavailable")
    ]);

    expect([publication.status, failure.status].sort()).toEqual([
      "fulfilled",
      "rejected"
    ]);
    const finalRun = await repositories.runs.find(run.id);
    if (publication.status === "fulfilled") {
      expect(finalRun).toMatchObject({
        status: "complete",
        snapshotId: publication.value.id
      });
      expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
        publication.value.id
      );
    } else {
      expect(finalRun?.status).toBe("failed");
      expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
        previous.id
      );
    }
  });

  it("filters actively suppressed characters from snapshot results", async () => {
    const snapshot = await seedCompleteSnapshot(repositories, {
      characters: [
        observation(rootKey, "Ryii"),
        observation(altKey, "Other", "claimed")
      ]
    });
    await repositories.suppressions.suppress(
      altKey,
      "verified_removal_request",
      null
    );

    expect(
      (await repositories.snapshots.find(snapshot.id))?.characters
    ).toEqual([expect.objectContaining({ key: rootKey })]);
    expect(await repositories.suppressions.isActive(altKey)).toBe(true);
  });

  it("hides an entire snapshot when its root is actively suppressed", async () => {
    await seedCompleteSnapshot(repositories);
    await repositories.suppressions.suppress(
      rootKey,
      "verified_removal_request",
      null
    );

    expect(await repositories.snapshots.getCurrent(rootKey)).toBeNull();
  });

  it("paginates snapshot history with a stable cursor", async () => {
    const oldest = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-01T12:00:00.000Z")
    });
    const middle = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-02T12:00:00.000Z")
    });
    const newest = await seedCompleteSnapshot(repositories, {
      refreshedAt: new Date("2026-08-03T12:00:00.000Z")
    });

    const first = await repositories.snapshots.listHistory(rootKey, {
      cursor: null,
      limit: 2
    });
    expect(first.items.map(({ id }) => id)).toEqual([newest.id, middle.id]);
    expect(first.nextCursor).not.toBeNull();

    const second = await repositories.snapshots.listHistory(rootKey, {
      cursor: first.nextCursor,
      limit: 2
    });
    expect(second.items.map(({ id }) => id)).toEqual([oldest.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("does not skip or duplicate equal-timestamp history rows", async () => {
    // Break caught: timestamp-only cursors could lose snapshots created in the same instant.
    const refreshedAt = new Date("2026-08-04T12:00:00.000Z");
    const snapshots = [
      await seedCompleteSnapshot(repositories, { refreshedAt }),
      await seedCompleteSnapshot(repositories, { refreshedAt }),
      await seedCompleteSnapshot(repositories, { refreshedAt })
    ];

    const observed: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await repositories.snapshots.listHistory(rootKey, {
        cursor,
        limit: 1
      });
      observed.push(...page.items.map(({ id }) => id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(observed)).toEqual(new Set(snapshots.map(({ id }) => id)));
    expect(observed).toHaveLength(3);
  });

  it("rejects malformed cursor UUIDs before querying PostgreSQL", async () => {
    const malformedCursor = Buffer.from(
      JSON.stringify({
        refreshedAt: "2026-08-04T12:00:00.000Z",
        id: `00000000${"-".repeat(28)}`
      })
    ).toString("base64url");

    await expect(
      repositories.snapshots.listHistory(rootKey, {
        cursor: malformedCursor,
        limit: 10
      })
    ).rejects.toThrow("invalid_cursor");
  });

  it("expires confirmed-missing character cache entries", async () => {
    const expiresAt = new Date("2026-08-04T13:00:00.000Z");
    await repositories.negativeCache.put(rootKey, expiresAt);

    expect(
      await repositories.negativeCache.find(
        rootKey,
        new Date("2026-08-04T12:59:59.000Z")
      )
    ).toEqual({ key: rootKey, expiresAt });
    expect(
      await repositories.negativeCache.find(
        rootKey,
        new Date("2026-08-04T13:00:00.000Z")
      )
    ).toBeNull();
  });

  it("deletes expired rate-limit events while retaining active events", async () => {
    const now = new Date("2026-08-04T13:00:00.000Z");
    await repositories.rateLimits.record(
      "sha256:expired",
      new Date("2026-08-04T12:59:59.000Z")
    );
    await repositories.rateLimits.record(
      "sha256:active",
      new Date("2026-08-04T13:00:01.000Z")
    );

    expect(await repositories.rateLimits.cleanupExpired(now)).toBe(1);
    expect(
      await repositories.rateLimits.countActive("sha256:expired", now)
    ).toBe(0);
    expect(
      await repositories.rateLimits.countActive("sha256:active", now)
    ).toBe(1);
  });

  it("admits only the FIFO head when two caps would exceed the rolling budget", async () => {
    // Break caught: later sweeps could jump the queue or oversubscribe the global hourly budget.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const firstKey = rootKey;
    const secondKey = altKey;
    const firstRun = await repositories.runs.createOrReuse(
      firstKey,
      "anonymous"
    );
    const secondRun = await repositories.runs.createOrReuse(
      secondKey,
      "anonymous"
    );
    const first = {
      runId: firstRun.id,
      key: firstKey,
      requestCap: 3,
      hourlyBudget: 5,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    };
    const second = { ...first, runId: secondRun.id, key: secondKey };

    const admitted =
      await repositories.fingerprintSweeps.requestAdmission(first);
    expect(admitted).toMatchObject({ kind: "admitted", requestCap: 3 });
    if (admitted.kind !== "admitted")
      throw new Error("first_sweep_not_admitted");

    await expect(
      repositories.fingerprintSweeps.requestAdmission(second)
    ).resolves.toMatchObject({ kind: "waiting" });
    await expect(
      repositories.fingerprintSweeps.listWaiting(10)
    ).resolves.toEqual([secondRun.id]);

    await repositories.fingerprintSweeps.finish(admitted.reservationId, {
      published: true,
      at,
      limitationCode: null
    });

    await expect(
      repositories.fingerprintSweeps.requestAdmission(second)
    ).resolves.toMatchObject({ kind: "admitted", requestCap: 3 });
  });

  it("atomically returns a budget-waiting discovery run to its unconsumed delivery", async () => {
    // Break caught: a crash after persisting private admission could leave the
    // run running, or its redispatch could start past the original retry count.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const blockerRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const waitingRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    await repositories.runs.claim(waitingRun.id, 1);
    const blocker = await repositories.fingerprintSweeps.requestAdmission({
      runId: blockerRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    });
    expect(blocker.kind).toBe("admitted");

    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: waitingRun.id,
        key: altKey,
        requestCap: 1,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at
      })
    ).resolves.toMatchObject({ kind: "waiting" });

    await expect(repositories.runs.find(waitingRun.id)).resolves.toMatchObject({
      status: "queued",
      attempt: 0
    });
  });

  it("admits a durable waiting run through private admission dispatch after budget frees", async () => {
    // Break caught: waiting sweeps could need another discovery delivery instead of being admitted privately.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const waitingRun = await repositories.runs.createOrReuse(
      altKey,
      "anonymous"
    );
    const first = {
      runId: firstRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 5,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    };
    const waiting = { ...first, runId: waitingRun.id, key: altKey };
    const admitted =
      await repositories.fingerprintSweeps.requestAdmission(first);
    if (admitted.kind !== "admitted")
      throw new Error("first_sweep_not_admitted");
    await expect(
      repositories.fingerprintSweeps.requestAdmission(waiting)
    ).resolves.toMatchObject({ kind: "waiting" });

    await repositories.fingerprintSweeps.release(admitted.reservationId, at);

    await expect(
      repositories.fingerprintSweeps.admitWaiting(
        waitingRun.id,
        new Date("2026-08-10T12:01:00.000Z")
      )
    ).resolves.toEqual({ kind: "admitted" });
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        ...waiting,
        at: new Date("2026-08-10T12:01:00.000Z")
      })
    ).resolves.toMatchObject({ kind: "admitted", requestCap: 3 });
  });

  it("keeps an admitted sweep dispatch-pending until its discovery job is durably enqueued", async () => {
    // Break caught: a crash after budget reservation could lose a run before discovery is re-enqueued.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: run.id,
        key: rootKey,
        requestCap: 3,
        hourlyBudget: 5,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at
      })
    ).resolves.toMatchObject({ kind: "admitted" });

    await expect(
      repositories.fingerprintSweeps.listAdmittedUndispatched(10)
    ).resolves.toEqual([run.id]);
    await repositories.fingerprintSweeps.markDispatched(run.id, at);
    await expect(
      repositories.fingerprintSweeps.listAdmittedUndispatched(10)
    ).resolves.toEqual([]);
  });

  it("does not advance cadence or retain unused capacity after an aborted sweep", async () => {
    // Break caught: aborts could consume future cadence or the entire unused reservation.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const input = {
      runId: run.id,
      key: rootKey,
      requestCap: 5,
      hourlyBudget: 8,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    };
    const admitted =
      await repositories.fingerprintSweeps.requestAdmission(input);
    expect(admitted).toMatchObject({ kind: "admitted" });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");

    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      3,
      at
    );
    await repositories.fingerprintSweeps.release(admitted.reservationId, at);

    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        ...input,
        at: new Date("2026-08-10T12:01:00.000Z")
      })
    ).resolves.toMatchObject({ kind: "admitted", requestCap: 5 });
  });

  it("prunes fingerprint request events only once they leave the rolling hour", async () => {
    // Break caught: one row per Blizzard request accumulates without limit, and
    // a prune keyed on the reservation would delete events the rolling-hour
    // budget still has to count.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_request_events,
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const sweptRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const admitted = await repositories.fingerprintSweeps.requestAdmission({
      runId: sweptRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at: new Date("2026-08-10T12:00:00.000Z")
    });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");
    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      1,
      new Date("2026-08-10T12:10:00.000Z")
    );
    const lastRequestedAt = new Date("2026-08-10T12:55:00.000Z");
    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      2,
      lastRequestedAt
    );
    await repositories.fingerprintSweeps.release(
      admitted.reservationId,
      lastRequestedAt
    );
    await repositories.runs.fail(sweptRun.id, "upstream_unavailable");

    const at = new Date("2026-08-10T13:20:00.000Z");
    await expect(
      repositories.fingerprintSweeps.cleanupExpired(at)
    ).resolves.toBe(1);
    const retained = await pool.query<{ requested_at: Date }>(
      `SELECT requested_at FROM fingerprint_sweep_request_events
       ORDER BY requested_at`
    );
    expect(retained.rows.map((row) => row.requested_at)).toEqual([
      lastRequestedAt,
      lastRequestedAt
    ]);

    const nextRun = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: nextRun.id,
        key: rootKey,
        requestCap: 2,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at
      })
    ).resolves.toMatchObject({
      kind: "waiting",
      retryAt: new Date("2026-08-10T13:55:00.000Z")
    });
  });

  it("retains each physical fingerprint request for its own rolling hour", async () => {
    // Break caught: extending a reservation expiry from its admission time can
    // undercount late Profile API requests and admit a budget-overlapping sweep.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_request_events,
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const admittedAt = new Date("2026-08-10T12:00:00.000Z");
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const admitted = await repositories.fingerprintSweeps.requestAdmission({
      runId: firstRun.id,
      key: rootKey,
      requestCap: 3,
      hourlyBudget: 3,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at: admittedAt
    });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");
    const usedAt = new Date("2026-08-10T12:55:00.000Z");
    await repositories.fingerprintSweeps.recordRequest(
      admitted.reservationId,
      3,
      usedAt
    );
    await repositories.fingerprintSweeps.release(
      admitted.reservationId,
      usedAt
    );
    await repositories.runs.fail(firstRun.id, "upstream_unavailable");

    const secondRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: secondRun.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 3,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at: new Date("2026-08-10T13:10:00.000Z")
      })
    ).resolves.toMatchObject({
      kind: "waiting",
      retryAt: new Date("2026-08-10T13:55:00.000Z")
    });
  });

  it("returns not due only after a published sweep within its cadence", async () => {
    // Break caught: a partial, unpublished, or aborted sweep could suppress a later sweep.
    await pool.query(`TRUNCATE TABLE
      fingerprint_sweep_reservations,
      fingerprint_sweep_admissions,
      fingerprint_sweep_states
      CASCADE`);
    const at = new Date("2026-08-10T12:00:00.000Z");
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const admitted = await repositories.fingerprintSweeps.requestAdmission({
      runId: run.id,
      key: rootKey,
      requestCap: 1,
      hourlyBudget: 2,
      cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
      at
    });
    if (admitted.kind !== "admitted") throw new Error("sweep_not_admitted");
    await repositories.fingerprintSweeps.finish(admitted.reservationId, {
      published: true,
      at,
      limitationCode: null
    });
    await repositories.runs.fail(run.id, "upstream_unavailable");

    const nextRun = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      repositories.fingerprintSweeps.requestAdmission({
        runId: nextRun.id,
        key: rootKey,
        requestCap: 1,
        hourlyBudget: 2,
        cadenceCutoff: new Date("2026-08-03T12:00:00.000Z"),
        at: new Date("2026-08-10T12:01:00.000Z")
      })
    ).resolves.toEqual({ kind: "not_due" });
  });
});
