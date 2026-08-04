import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";

const migrationLockKey = 0x534c4153;

export function resolveMigrationsFolder(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
}

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
    await migrate(drizzle(client), {
      migrationsFolder: resolveMigrationsFolder()
    });
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [migrationLockKey])
      .catch(() => undefined);
    client.release();
  }
}
