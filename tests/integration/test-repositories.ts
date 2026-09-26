import type { Pool } from "pg";
import { createPostgresRepositories } from "../../packages/database/src";

const activeRunSql = "('queued', 'running', 'retrying')";

async function requireUpdated(
  pool: Pool,
  text: string,
  values: unknown[]
): Promise<void> {
  const result = await pool.query(text, values);
  if (result.rowCount !== 1) throw new Error("discovery_run_not_found");
}

/**
 * The production repositories plus the shortcuts tests use to arrange state.
 * None of these belong on the production interface: `runs.complete` in
 * particular is a second way to publish a snapshot that skips the atomic
 * publication production uses.
 */
export function createTestRepositories(pool: Pool) {
  const repositories = createPostgresRepositories(pool);
  return {
    ...repositories,
    runs: {
      ...repositories.runs,
      async markRunning(id: string): Promise<void> {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'running', started_at = COALESCE(started_at, now()),
               next_retry_at = NULL
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id]
        );
      },
      async complete(id: string, snapshotId: string): Promise<void> {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'complete', snapshot_id = $2,
               completed_at = COALESCE(completed_at, now()),
               next_retry_at = NULL, error_code = NULL
           WHERE id = $1
             AND (
               (status = 'complete' AND snapshot_id = $2)
               OR (
                 status IN ${activeRunSql}
                 AND EXISTS (
                   SELECT 1 FROM snapshots
                   WHERE snapshots.id = $2
                     AND snapshots.discovery_run_id = discovery_runs.id
                 )
               )
             )`,
          [id, snapshotId]
        );
      }
    },
    rateLimits: {
      ...repositories.rateLimits,
      async record(callerBucketHash: string, expiresAt: Date): Promise<void> {
        await pool.query(
          `INSERT INTO rate_limit_events (caller_bucket_hash, expires_at)
           VALUES ($1, $2)`,
          [callerBucketHash, expiresAt]
        );
      },
      async countActive(
        callerBucketHash: string,
        at = new Date()
      ): Promise<number> {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM rate_limit_events
           WHERE caller_bucket_hash = $1 AND expires_at > $2`,
          [callerBucketHash, at]
        );
        return Number(result.rows[0]?.count ?? 0);
      }
    }
  };
}

export type TestRepositories = ReturnType<typeof createTestRepositories>;
