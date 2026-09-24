import type { StoredSnapshot } from "@slashwho/database";
// Value import only: the @slashwho/database entry point re-exports `migrate.ts`,
// whose `import.meta.url` cannot be transpiled by Playwright's CommonJS TypeScript
// loader ("Cannot use 'import.meta' outside a module"). The type import above is
// erased at compile time, so it can use the package entry point.
import { createPostgresRepositories } from "../../../packages/database/src/postgres-repositories";
import { toRaiderIoUrl, type CharacterKey } from "@slashwho/domain";
import { Pool } from "pg";
import { decryptAccountMail } from "@slashwho/application";
import { hashOperatorCredential } from "../../../apps/web/src/server/operator-auth";

type SeedCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
  guild?: Readonly<{
    name: string;
    region: CharacterKey["region"];
    realm: string;
  }> | null;
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

/** Creates a verified account without mail so browser authorization tests can sign in. */
export async function seedVerifiedAccount(
  email: string,
  password: string,
  role: "user" | "admin" = "user"
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const hash = await hashOperatorCredential(password);
    await pool.query(
      `INSERT INTO accounts (canonical_email, email, role, verified_at,
        password_hash, password_salt, scrypt_version, scrypt_cost, created_at, updated_at)
       VALUES ($1, $1, $2, now(), $3, $4, $5, $6, now(), now())`,
      [
        email,
        role,
        hash.passwordHash,
        hash.passwordSalt,
        hash.scryptVersion,
        hash.scryptCost
      ]
    );
  } finally {
    await pool.end();
  }
}

/** Reads the local outbox link; no browser test sends mail to Resend. */
export async function accountMailLink(email: string): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const result = await pool.query<{ encrypted_message: string }>(
      `SELECT o.encrypted_message FROM account_mail_outbox o
       JOIN account_mail_tokens t ON t.id = o.token_id
       JOIN accounts a ON a.id = t.account_id
       WHERE a.canonical_email = $1 ORDER BY o.created_at DESC LIMIT 1`,
      [email]
    );
    if (!result.rows[0]) throw new Error("e2e_mail_unavailable");
    const message = JSON.parse(
      decryptAccountMail(
        result.rows[0].encrypted_message,
        Buffer.from("b".repeat(64), "hex")
      )
    ) as { text: string };
    const match = message.text.match(/https?:\/\/\S+/);
    if (!match) throw new Error("e2e_mail_link_unavailable");
    return match[0];
  } finally {
    await pool.end();
  }
}

const seedSpec = {
  name: "Fire",
  iconUrl:
    "https://wow.zamimg.com/images/wow/icons/medium/spell_fire_firebolt.jpg"
} as const;

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
        guild: character.guild ?? null,
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
    laterParseEventOnly?: boolean;
    withSampleKills?: boolean;
    withSecondRaid?: boolean;
    historicWorldRank?: number;
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
      parseLimitationCode: null,
      completedAt: now,
      tierBests: [],
      kills:
        options.withSampleKills === false
          ? []
          : [
              ...(options.laterParseEventOnly
                ? []
                : [
                    {
                      raidId: "42",
                      raidName: "Nerub-ar Palace",
                      bossId: "1234",
                      bossName: "Queen Ansurek",
                      journalBossId: null,
                      bossOrder: 8,
                      killedAt: "2025-01-13T21:31:40.000Z",
                      historicWorldRank: options.historicWorldRank,
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/e2eReport",
                      fightUrl:
                        "https://www.warcraftlogs.com/reports/e2eReport#fight=9",
                      guild: { name: "Arachnid", realm: "silvermoon" },
                      performance: {
                        spec: seedSpec,
                        damage: {
                          state: "available" as const,
                          percentile: 87.19
                        },
                        healing: { state: "not_applicable" as const },
                        bossDamage: { state: "unavailable" as const }
                      }
                    },
                    {
                      raidId: "42",
                      raidName: "Nerub-ar Palace",
                      bossId: "1234",
                      bossName: "Queen Ansurek",
                      journalBossId: null,
                      bossOrder: 8,
                      killedAt: "2025-01-13T22:31:40.000Z",
                      historicWorldRank: options.historicWorldRank,
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/e2eReport",
                      fightUrl:
                        "https://www.warcraftlogs.com/reports/e2eReport#fight=10",
                      guild: { name: "Arachnid", realm: "silvermoon" },
                      performance: {
                        spec: seedSpec,
                        damage: {
                          state: "available" as const,
                          percentile: 99.29
                        },
                        healing: { state: "not_applicable" as const },
                        bossDamage: { state: "unavailable" as const }
                      }
                    }
                  ]),
              ...(options.withLaterParseEvent
                ? [
                    {
                      raidId: "42",
                      raidName: "Nerub-ar Palace",
                      bossId: "1234",
                      bossName: "Queen Ansurek",
                      journalBossId: null,
                      bossOrder: 8,
                      killedAt: "2025-01-14T21:31:40.000Z",
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/e2eLaterReport",
                      fightUrl:
                        "https://www.warcraftlogs.com/reports/e2eLaterReport#fight=11",
                      guild: { name: "Arachnid", realm: "silvermoon" },
                      performance: {
                        spec: seedSpec,
                        damage: {
                          state: "available" as const,
                          percentile: 100
                        },
                        healing: { state: "not_applicable" as const },
                        bossDamage: { state: "unavailable" as const }
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
                      killedAt: "2023-01-09T21:31:40.000Z",
                      reportUrl:
                        "https://www.warcraftlogs.com/reports/e2eVaultReport",
                      fightUrl:
                        "https://www.warcraftlogs.com/reports/e2eVaultReport#fight=11",
                      guild: { name: "Arachnid", realm: "silvermoon" },
                      performance: {
                        spec: seedSpec,
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

export async function countDiscoveryRuns(key: CharacterKey): Promise<number> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM discovery_runs
       WHERE root_region = $1
         AND root_realm_slug = $2
         AND root_normalized_name = $3`,
      [key.region, key.realm, key.name]
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

/** Links a character to a dossier the way the Add character action does. */
export async function seedManualConnection(
  root: CharacterKey,
  character: CharacterKey
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    await createPostgresRepositories(pool).manualConnections.add(
      root,
      character
    );
  } finally {
    await pool.end();
  }
}
