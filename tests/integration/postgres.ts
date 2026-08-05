import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

export async function startPostgres(): Promise<{
  pool: Pool;
  stop: () => Promise<void>;
}> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  return {
    pool,
    stop: async () => {
      await pool.end();
      await container.stop();
    }
  };
}
