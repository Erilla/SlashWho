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
  legacyResolveSubjects,
  replayCharacterGroups
} from "@slashwho/application";
import { requiredEnvironment, runIfMain } from "../lib/cli.mts";

const CONFIG = { DOSSIER_CHARACTER_CEILING: 50 };

export async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL")
  });
  try {
    const repositories = createPostgresRepositories(pool);
    const audit = await loadCharacterGroupsAudit(pool);
    const legacy = new Map();
    for (const key of audit.roots) {
      legacy.set(
        canonicalCharacterId(key),
        await legacyResolveSubjects(key, repositories, CONFIG)
      );
    }
    const report = replayCharacterGroups(audit, legacy, CONFIG);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_replay_failed");
