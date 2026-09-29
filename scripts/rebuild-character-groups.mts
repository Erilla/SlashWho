#!/usr/bin/env tsx
// Rebuild character groups from snapshots and manual connections (#738).
// Run: corepack pnpm ops:rebuild-groups --confirm <host>
//   (with DATABASE_URL set; see the runbook). Run it once without --confirm
//   to see the host DATABASE_URL points at.
import { Pool } from "pg";
import { createPostgresRepositories } from "@slashwho/database";
import { runIfMain } from "./lib/cli.mts";

/**
 * The host the rebuild would run against, parsed from DATABASE_URL, once
 * `--confirm <host>` names that same host. The rebuild deletes every observed
 * link, marker and group and restarts the replay window, so a shell still
 * holding another environment's URL must not run it silently. Only the host
 * is ever named, never the URL or its password.
 */
export function rebuildTarget(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): { host: string } {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("database_url_required");
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("database_url_invalid");
  }
  if (!host) throw new Error("database_url_invalid");
  const flag = argv.indexOf("--confirm");
  const confirmed = flag === -1 ? undefined : argv[flag + 1];
  if (confirmed !== host) {
    throw new Error(
      `rebuild refused: pass --confirm ${host} to rebuild the character groups on ${host}`
    );
  }
  return { host };
}

export async function main(): Promise<void> {
  const { host } = rebuildTarget(process.argv.slice(2), process.env);
  process.stderr.write(`rebuilding character groups on ${host}\n`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const connections = createPostgresRepositories(pool).characterConnections;
    if (!connections) throw new Error("character_connections_unavailable");
    const result = await connections.rebuild();
    process.stdout.write(
      `${JSON.stringify({ event: "character_groups_rebuilt", host, ...result })}\n`
    );
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_rebuild_failed");
