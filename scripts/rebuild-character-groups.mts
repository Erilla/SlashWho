#!/usr/bin/env tsx
// Rebuild character groups from snapshots and manual connections (#738).
// Run: corepack pnpm ops:rebuild-groups   (with DATABASE_URL set; see the runbook)
import { Pool } from "pg";
import { createPostgresRepositories } from "@slashwho/database";
import { requiredEnvironment, runIfMain } from "./lib/cli.mts";

export async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL")
  });
  try {
    const connections = createPostgresRepositories(pool).characterConnections;
    if (!connections) throw new Error("character_connections_unavailable");
    const result = await connections.rebuild();
    process.stdout.write(
      `${JSON.stringify({ event: "character_groups_rebuilt", ...result })}\n`
    );
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_rebuild_failed");
