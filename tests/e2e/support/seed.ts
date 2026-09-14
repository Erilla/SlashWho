import type { StoredSnapshot } from "@slashwho/database";
// Value import only: the @slashwho/database entry point re-exports `migrate.ts`,
// whose `import.meta.url` cannot be transpiled by Playwright's CommonJS TypeScript
// loader ("Cannot use 'import.meta' outside a module"). The type import above is
// erased at compile time, so it can use the package entry point.
import { createPostgresRepositories } from "../../../packages/database/src/postgres-repositories";
import { toRaiderIoUrl, type CharacterKey } from "@slashwho/domain";
import { Pool } from "pg";

type SeedCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
}>;

type SeedSnapshotInput = Readonly<{
  key: CharacterKey;
  displayName: string;
  refreshedAt: Date;
  state?: "complete" | "partial";
  limitationCode?: string | null;
  characters?: readonly SeedCharacter[];
}>;

function databaseUrl(): string {
  const value = process.env.E2E_DATABASE_URL;
  if (!value) throw new Error("e2e_database_url_unavailable");
  return value;
}

export async function releaseUpstreamCharacterRead(): Promise<void> {
  const baseUrl = process.env.E2E_RAIDER_IO_BASE_URL;
  if (!baseUrl) throw new Error("e2e_fixture_base_url_unavailable");
  const response = await fetch(new URL("/__control/release", baseUrl), {
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("e2e_fixture_release_failed");
}

export async function seedSnapshot(
  input: SeedSnapshotInput
): Promise<StoredSnapshot> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const repositories = createPostgresRepositories(pool);
    const run = await repositories.runs.createOrReuse(input.key, "anonymous");
    const characters = input.characters ?? [
      {
        key: input.key,
        displayName: input.displayName,
        className: "Mage",
        level: 80
      }
    ];
    return await repositories.snapshots.create({
      runId: run.id,
      rootKey: input.key,
      state: input.state ?? "complete",
      limitationCode: input.limitationCode ?? null,
      refreshedAt: input.refreshedAt,
      characters: characters.map((character, index) => ({
        ...character,
        raiderIoUrl: toRaiderIoUrl(character.key),
        source: index === 0 ? "input" : "claimed"
      }))
    });
  } finally {
    await pool.end();
  }
}

export async function seedCharacterEvidence(
  key: CharacterKey,
  options: Readonly<{
    withLaterParseEvent?: boolean;
    withSampleKills?: boolean;
    withSecondRaid?: boolean;
  }> = {}
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const repositories = createPostgresRepositories(pool);
    const now = new Date();
    const reservation = await repositories.evidence.reserve({
      key,
      freshnessCutoff: new Date(now.valueOf() - 60_000),
      at: now
    });
    if (reservation.kind === "fresh") return;
    if (reservation.kind !== "reserved") {
      throw new Error("e2e_character_evidence_not_reserved");
    }
    await repositories.evidence.publish(reservation.run.id, {
      state: "complete",
      limitationCode: null,
      completedAt: now,
      kills:
        options.withSampleKills === false
          ? []
          : [
              {
                raidId: "42",
                raidName: "Nerub-ar Palace",
                bossId: "1234",
                bossName: "Queen Ansurek",
                journalBossId: null,
                bossOrder: 8,
                isFinalBoss: true,
                killedAt: "2025-01-13T21:31:40.000Z",
                reportUrl: "https://www.warcraftlogs.com/reports/e2eReport",
                fightUrl:
                  "https://www.warcraftlogs.com/reports/e2eReport#fight=9",
                guild: { name: "Arachnid", realm: "silvermoon" },
                historicWorldRank: 147,
                performance: {
                  damage: { state: "available", percentile: 87.19 },
                  healing: { state: "not_applicable" },
                  bossDamage: { state: "unavailable" }
                }
              },
              {
                raidId: "42",
                raidName: "Nerub-ar Palace",
                bossId: "1234",
                bossName: "Queen Ansurek",
                journalBossId: null,
                bossOrder: 8,
                isFinalBoss: true,
                killedAt: "2025-01-13T22:31:40.000Z",
                reportUrl: "https://www.warcraftlogs.com/reports/e2eReport",
                fightUrl:
                  "https://www.warcraftlogs.com/reports/e2eReport#fight=10",
                guild: { name: "Arachnid", realm: "silvermoon" },
                historicWorldRank: 147,
                performance: {
                  damage: { state: "available", percentile: 99.29 },
                  healing: { state: "not_applicable" },
                  bossDamage: { state: "unavailable" }
                }
              },
              ...(options.withLaterParseEvent
                ? [
                    {
                      raidId: "42",
                      raidName: "Nerub-ar Palace",
                      bossId: "1234",
                      bossName: "Queen Ansurek",
                      journalBossId: null,
                      bossOrder: 8,
                      isFinalBoss: true,
                      killedAt: "2025-01-14T21:31:40.000Z",
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/e2eLaterReport",
                      fightUrl:
                        "https://www.warcraftlogs.com/reports/e2eLaterReport#fight=11",
                      guild: { name: "Arachnid", realm: "silvermoon" },
                      historicWorldRank: 147,
                      performance: {
                        damage: { state: "available", percentile: 100 },
                        healing: { state: "not_applicable" },
                        bossDamage: { state: "unavailable" }
                      }
                    }
                  ]
                : []),
              ...(options.withSecondRaid
                ? [
                    {
                      raidId: "43",
                      raidName: "Vault of the Incarnates",
                      bossId: "2499",
                      bossName: "Raszageth the Storm-Eater",
                      journalBossId: "2499",
                      bossOrder: 8,
                      isFinalBoss: true,
                      killedAt: "2023-01-09T21:31:40.000Z",
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/e2eVaultReport",
                      fightUrl:
                        "https://www.warcraftlogs.com/reports/e2eVaultReport#fight=11",
                      guild: { name: "Arachnid", realm: "silvermoon" },
                      historicWorldRank: 212,
                      performance: {
                        damage: { state: "unavailable" as const },
                        healing: { state: "unavailable" as const },
                        bossDamage: { state: "unavailable" as const }
                      }
                    }
                  ]
                : [])
            ],
      wipes: []
    });
  } finally {
    await pool.end();
  }
}

export async function suppressCharacter(
  key: CharacterKey,
  reason: string
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    await createPostgresRepositories(pool).suppressions.suppress(
      key,
      reason,
      null
    );
  } finally {
    await pool.end();
  }
}
