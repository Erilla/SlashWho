import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { runMigrations } from "./migrate";

type MigrationPool = {
  end(): Promise<void>;
};

export type MigrationDependencies = Readonly<{
  createPool(connectionString: string): MigrationPool;
  runMigrations(pool: MigrationPool): Promise<void>;
}>;

const defaultDependencies: MigrationDependencies = {
  createPool: (connectionString) => new Pool({ connectionString }),
  runMigrations: (pool) => runMigrations(pool as Pool)
};

export async function migrateFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: MigrationDependencies = defaultDependencies
): Promise<void> {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("database_url_required");
  const pool = dependencies.createPool(databaseUrl);
  try {
    await dependencies.runMigrations(pool);
  } finally {
    await pool.end();
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) {
  void migrateFromEnvironment().catch(() => {
    process.stderr.write("database_migration_failed\n");
    process.exitCode = 1;
  });
}
