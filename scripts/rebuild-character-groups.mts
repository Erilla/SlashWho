#!/usr/bin/env tsx
// Rebuild character groups from snapshots and manual connections (#738).
// Run: corepack pnpm ops:rebuild-groups --confirm <host:port/database>
//   (with DATABASE_URL set; see the runbook). Run it once without --confirm
//   to see the target DATABASE_URL points at.
import { Pool } from "pg";
import { createPostgresRepositories } from "@slashwho/database";
import { runIfMain } from "./lib/cli.mts";

/**
 * The database the rebuild would run against, as `host:port/database` parsed
 * from DATABASE_URL, once `--confirm <target>` names that same target. The
 * rebuild deletes every observed link, marker and group and restarts the
 * replay window, so a shell still holding another environment's URL must not
 * run it silently. Railway's proxy hosts are shared across environments and
 * differ only by port, so the hostname alone would not tell test from
 * production. Only the target is ever named, never the URL or its password.
 */
export function rebuildTarget(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): { target: string } {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("database_url_required");
  let target: string;
  try {
    const url = new URL(databaseUrl);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!url.hostname || !database) throw new Error("incomplete");
    target = `${url.host}/${database}`;
  } catch {
    throw new Error("database_url_invalid");
  }
  const flag = argv.indexOf("--confirm");
  const confirmed = flag === -1 ? undefined : argv[flag + 1];
  if (confirmed !== target) {
    throw new Error(
      `rebuild refused: pass --confirm ${target} to rebuild the character groups on ${target}`
    );
  }
  return { target };
}

export async function main(): Promise<void> {
  const { target } = rebuildTarget(process.argv.slice(2), process.env);
  process.stderr.write(`rebuilding character groups on ${target}\n`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const connections = createPostgresRepositories(pool).characterConnections;
    if (!connections) throw new Error("character_connections_unavailable");
    const result = await connections.rebuild();
    process.stdout.write(
      `${JSON.stringify({ event: "character_groups_rebuilt", target, ...result })}\n`
    );
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_rebuild_failed");
