#!/usr/bin/env tsx
// Replay character groups against today's dossiers, read-only (#738).
// Run: corepack pnpm ops:replay-groups   (with DATABASE_URL set; see the runbook)
// Exits 1 on any failure. Never prints a suppressed character's key.
import { Pool } from "pg";
import { canonicalCharacterId } from "@slashwho/domain";
import {
  createPostgresRepositories,
  loadCharacterGroupsAudit
} from "@slashwho/database";
import {
  applicationConfigSchema,
  legacyResolveSubjects,
  replayCharacterGroups
} from "@slashwho/application";
import { requiredEnvironment, runIfMain } from "../lib/cli.mts";

/**
 * The ceiling the web applies, read with the web's own parser so its default
 * and bounds cannot drift from it. Only this key is parsed: the full
 * application config also demands the web's secrets.
 */
export function replayConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env
): { DOSSIER_CHARACTER_CEILING: number } {
  const parsed = applicationConfigSchema
    .pick({ DOSSIER_CHARACTER_CEILING: true })
    .safeParse(environment);
  if (!parsed.success) throw new Error("invalid_dossier_character_ceiling");
  return parsed.data;
}

/**
 * Every session on the replay's pool is read-only, the legacy half's reads
 * included, so nothing the replay calls can write whatever it does.
 */
export function replayPoolConfig(connectionString: string): {
  connectionString: string;
  options: string;
} {
  return {
    connectionString,
    options: "-c default_transaction_read_only=on"
  };
}

export async function main(): Promise<void> {
  const config = replayConfig();
  const pool = new Pool(replayPoolConfig(requiredEnvironment("DATABASE_URL")));
  try {
    const repositories = createPostgresRepositories(pool);
    const audit = await loadCharacterGroupsAudit(pool);
    const legacy = new Map();
    for (const key of audit.roots) {
      legacy.set(
        canonicalCharacterId(key),
        await legacyResolveSubjects(key, repositories, config)
      );
    }
    const report = replayCharacterGroups(audit, legacy, config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_replay_failed");
