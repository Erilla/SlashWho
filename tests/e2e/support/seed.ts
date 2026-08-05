import { createPostgresRepositories } from "../../../packages/database/src/postgres-repositories";
import type { StoredSnapshot } from "../../../packages/database/src/repositories";
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
