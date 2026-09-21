import { Pool } from "pg";

import { runMigrations } from "../../../packages/database/src/migrate";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("e2e_database_url_unavailable");

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

void migrate();
