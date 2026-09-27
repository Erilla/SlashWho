import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import {
  runMigrations,
  type CharacterMythicKillInput,
  type CharacterMythicWipeInput,
  type SnapshotCharacterInput,
  type StoredSnapshot
} from "../../packages/database/src";
import { startPostgres } from "./postgres";
import {
  createTestRepositories,
  type TestRepositories
} from "./test-repositories";

/**
 * A migrated PostgreSQL of its own for one repositories test file. Each file
 * starts one, so the files run in parallel without sharing a database.
 */
export async function startRepositoryDatabase(): Promise<{
  pool: Pool;
  stop: () => Promise<void>;
  repositories: TestRepositories;
}> {
  const { pool, stop } = await startPostgres();
  await runMigrations(pool);
  return { pool, stop, repositories: createTestRepositories(pool) };
}

/** Empties every table a repositories test writes, before each test. */
export async function resetRepositoryTables(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE TABLE
    character_mythic_kills,
    character_alias_recollections,
    character_mythic_wipes,
    character_evidence_runs,
    -- Keyed by character rather than by run, so nothing above cascades to
    -- it and a mark left by one test would be read by the next.
    character_terminal_tiers,
    character_historic_aliases,
    dossier_character_exclusions,
    dossier_searches,
    character_attendance_searches,
    snapshot_characters,
    snapshots,
    discovery_runs,
    characters,
    suppressed_characters,
    negative_character_cache,
    rate_limit_events,
    manual_dossier_connections,
    operator_auth_events,
    operator_login_attempts,
    operator_sessions,
    operators,
    account_request_attempts,
    accounts
    CASCADE`);
}

export async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed_out");
}

export const rootKey = {
  region: "eu",
  realm: "silvermoon",
  name: "ryii"
} as const;

export const altKey = {
  region: "us",
  realm: "area-52",
  name: "other"
} as const;

export function observation(
  key: CharacterKey,
  displayName: string,
  source: SnapshotCharacterInput["source"] = "input"
): SnapshotCharacterInput {
  return {
    key,
    displayName,
    className: "Mage",
    level: 80,
    guild: null,
    raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
    source
  };
}

export function mythicKill(
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
    killedAt: "2026-08-04T12:00:00.000Z",
    reportUrl: "https://www.warcraftlogs.com/reports/example",
    fightUrl: "https://www.warcraftlogs.com/reports/example#fight=1",
    guild: { name: "Example Guild", region: "eu", realm: "silvermoon" },
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

export function mythicWipe(
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

export async function seedCompleteSnapshot(
  repositories: TestRepositories,
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

export async function admitSweep(
  repositories: TestRepositories,
  runId: string,
  key: CharacterKey
): Promise<{
  reservationId: string;
  finishedAt: Date;
  limitationCode: string | null;
}> {
  const at = new Date();
  const admission = await repositories.fingerprintSweeps.requestAdmission({
    runId,
    key,
    requestCap: 10,
    hourlyBudget: 100,
    // A cutoff ahead of `at` keeps the cadence gate open, so this helper can be
    // called twice for the same root without depending on Task 5.
    cadenceCutoff: new Date(at.getTime() + 60_000),
    at
  });
  if (admission.kind !== "admitted") throw new Error("not admitted");
  return {
    reservationId: admission.reservationId,
    finishedAt: new Date(),
    limitationCode: "fingerprint_sweep_capped"
  };
}
