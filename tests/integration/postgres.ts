import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool, type PoolClient } from "pg";

export async function startPostgres(): Promise<{
  pool: Pool;
  stop: () => Promise<void>;
}> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  // pool.end() resolves once the pool has stopped tracking its clients, before
  // their sockets close. Stopping the container inside that window sends a
  // 57P01 to a client that still carries the pool's idle error listener, and
  // the pool re-emits it as an unhandled error. Wait for every client's
  // 'remove', which the pool emits only after that client's end completes.
  const open = new Set<PoolClient>();
  pool.on("connect", (client) => open.add(client));
  pool.on("remove", (client) => open.delete(client));

  return {
    pool,
    stop: async () => {
      const drained = new Promise<void>((resolve) => {
        const settle = () => {
          if (open.size === 0) resolve();
        };
        pool.on("remove", settle);
        settle();
      });
      await pool.end();
      await drained;
      await container.stop();
    }
  };
}
