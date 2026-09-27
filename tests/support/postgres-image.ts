import type { PostgreSqlContainer } from "@testcontainers/postgresql";

/** The PostgreSQL image the integration and end-to-end suites both run. */
export const postgresImage = "postgres:16-alpine";

/**
 * Trades durability for speed in a throwaway test database: nothing waits on
 * an fsync, and the data directory lives in memory. None of these settings
 * changes what one transaction can see of another's work, so the isolation
 * and snapshot-atomicity guarantees the suites exercise are unaffected. A
 * crashed container loses its data, which a test database discards anyway.
 */
export function tuneForTests(
  container: PostgreSqlContainer
): PostgreSqlContainer {
  return container
    .withCommand([
      "postgres",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off"
    ])
    .withTmpFs({ "/var/lib/postgresql/data": "rw" });
}
