import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { type RunRow, mapRun } from "./mappers";
import type { Repositories } from "./repositories";
import { one, withTransaction } from "./sql";

export const activeRunSql = "('queued', 'running', 'retrying')";

async function requireUpdated(
  client: Pool,
  text: string,
  values: unknown[]
): Promise<void> {
  const result = await client.query(text, values);
  if (result.rowCount !== 1) throw new Error("discovery_run_not_found");
}

export function createDiscoveryRunRepositories(
  pool: Pool
): Pick<Repositories, "searchReservations" | "runs"> {
  return {
    searchReservations: {
      async reserve(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1) {
          throw new RangeError("rate_limit_out_of_range");
        }
        if (input.expiresAt <= input.at) {
          throw new RangeError("rate_limit_expiry_out_of_range");
        }

        return withTransaction(pool, async (client) => {
          const rootLock = `root:${input.key.region}:${input.key.realm}:${input.key.name}`;
          await client.query(
            `SELECT pg_advisory_xact_lock(lock_id)
             FROM (
               SELECT DISTINCT hashtextextended(value, 0) AS lock_id
               FROM unnest($1::text[]) AS value
               ORDER BY lock_id
             ) locks`,
            [[`bucket:${input.callerBucketHash}`, rootLock]]
          );

          const suppression = await client.query(
            `SELECT 1 FROM suppressed_characters
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
               AND (expires_at IS NULL OR expires_at > $4)
             LIMIT 1`,
            [input.key.region, input.key.realm, input.key.name, input.at]
          );
          if (suppression.rowCount === 1) {
            return { kind: "suppressed" };
          }

          const current = await client.query<{ id: string }>(
            `SELECT snapshot.id
             FROM snapshots snapshot
             JOIN characters root ON root.id = snapshot.root_character_id
             JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
             WHERE root.region = $1 AND root.realm_slug = $2
               AND root.normalized_name = $3
               AND run.status = 'complete'
               AND snapshot.refreshed_at > $4
             ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
             LIMIT 1`,
            [
              input.key.region,
              input.key.realm,
              input.key.name,
              input.freshnessCutoff
            ]
          );
          if (current.rowCount === 1) {
            return { kind: "fresh" };
          }

          if (current.rowCount === 0) {
            const negative = await client.query(
              `SELECT 1 FROM negative_character_cache
               WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                 AND expires_at > $4
               LIMIT 1`,
              [input.key.region, input.key.realm, input.key.name, input.at]
            );
            if (negative.rowCount === 1) {
              return { kind: "negative" };
            }
          }

          const active = await client.query<RunRow>(
            `SELECT * FROM discovery_runs
             WHERE root_region = $1
               AND root_realm_slug = $2
               AND root_normalized_name = $3
               AND status IN ${activeRunSql}
             FOR UPDATE`,
            [input.key.region, input.key.realm, input.key.name]
          );
          if (active.rows[0]) {
            return { kind: "active", run: mapRun(active.rows[0]) };
          }

          const usage = await client.query<{
            count: string;
            retry_at: Date | null;
          }>(
            `SELECT count(*)::text AS count, min(expires_at) AS retry_at
             FROM rate_limit_events
             WHERE caller_bucket_hash = $1 AND expires_at > $2`,
            [input.callerBucketHash, input.at]
          );
          if (Number(one(usage).count) >= input.limit) {
            const retryAt = one(usage).retry_at;
            if (!retryAt) throw new Error("rate_limit_retry_missing");
            return { kind: "rate_limited", retryAt };
          }

          const runResult = await client.query<RunRow>(
            `INSERT INTO discovery_runs
              (root_region, root_realm_slug, root_normalized_name, caller_class)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [
              input.key.region,
              input.key.realm,
              input.key.name,
              input.callerClass
            ]
          );
          const run = mapRun(one(runResult));
          await client.query(
            `INSERT INTO rate_limit_events
              (caller_bucket_hash, discovery_run_id, expires_at)
             VALUES ($1, $2, $3)`,
            [input.callerBucketHash, run.id, input.expiresAt]
          );
          return { kind: "reserved", run };
        });
      },

      async cancel(runId) {
        return withTransaction(pool, async (client) => {
          const failure = await client.query(
            `UPDATE discovery_runs
             SET status = 'failed', error_code = 'search_failed',
                 completed_at = now(), next_retry_at = NULL
             WHERE id = $1 AND status = 'queued'
             RETURNING id`,
            [runId]
          );
          if (failure.rowCount !== 1) {
            throw new Error("search_reservation_not_cancellable");
          }
          const charge = await client.query(
            "DELETE FROM rate_limit_events WHERE discovery_run_id = $1",
            [runId]
          );
          if (charge.rowCount !== 1) {
            throw new Error("search_reservation_charge_missing");
          }
        });
      },

      async listPending(limit = 100) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError("pending_dispatch_limit_out_of_range");
        }
        const result = await pool.query<{
          id: string;
          root_region: CharacterKey["region"];
          root_realm_slug: string;
          root_normalized_name: string;
        }>(
          `SELECT id, root_region, root_realm_slug, root_normalized_name
           FROM discovery_runs
           WHERE status = 'queued' AND queue_job_id IS NULL
           ORDER BY created_at, id
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => ({
          runId: row.id,
          key: {
            region: row.root_region,
            realm: row.root_realm_slug,
            name: row.root_normalized_name
          }
        }));
      },

      async markEnqueued(runId, queueJobId) {
        const result = await pool.query(
          `UPDATE discovery_runs
           SET queue_job_id = $2
           WHERE id = $1
             AND (queue_job_id IS NULL OR queue_job_id = $2)`,
          [runId, queueJobId]
        );
        if (result.rowCount !== 1) {
          throw new Error("search_reservation_not_found");
        }
      }
    },

    runs: {
      async createOrReuse(key, caller) {
        const result = await pool.query<RunRow>(
          `INSERT INTO discovery_runs
            (root_region, root_realm_slug, root_normalized_name, caller_class)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (root_region, root_realm_slug, root_normalized_name)
             WHERE status IN ${activeRunSql}
           DO UPDATE SET root_normalized_name = EXCLUDED.root_normalized_name
           RETURNING *`,
          [key.region, key.realm, key.name, caller]
        );
        return mapRun(one(result));
      },

      async claim(id, attempt) {
        const result = await pool.query<RunRow>(
          `UPDATE discovery_runs
           SET status = 'running', attempt = $2,
               started_at = COALESCE(started_at, now()),
               next_retry_at = NULL
           WHERE id = $1
             AND attempt < $2
             AND status IN ${activeRunSql}
           RETURNING *`,
          [id, attempt]
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },

      async markRetrying(id, attempt, nextRetryAt) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'retrying', attempt = $2, next_retry_at = $3
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id, attempt, nextRetryAt]
        );
      },

      async completeWithLiveSweepSnapshot(id, snapshotId) {
        // The snapshot must be the one this root's sweep cursor is still
        // extending, mirroring what `getResumeState` treats as a live chain.
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
                   SELECT 1 FROM fingerprint_sweep_states state
                   WHERE state.region = discovery_runs.root_region
                     AND state.realm_slug = discovery_runs.root_realm_slug
                     AND state.normalized_name =
                       discovery_runs.root_normalized_name
                     AND state.resume_after IS NOT NULL
                     AND state.resume_snapshot_id = $2
                 )
               )
             )`,
          [id, snapshotId]
        );
      },

      async fail(id, code) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'failed', error_code = $2, completed_at = now(),
               next_retry_at = NULL
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id, code]
        );
      },

      async recordGuildReadsDropped(id, count) {
        if (!Number.isInteger(count) || count < 0) {
          throw new RangeError("guild_reads_dropped_out_of_range");
        }
        await requireUpdated(
          pool,
          "UPDATE discovery_runs SET guild_reads_dropped = $2 WHERE id = $1",
          [id, count]
        );
      },

      async find(id) {
        const result = await pool.query<RunRow>(
          "SELECT * FROM discovery_runs WHERE id = $1",
          [id]
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },

      async findActive(key) {
        const result = await pool.query<RunRow>(
          `SELECT * FROM discovery_runs
           WHERE root_region = $1
             AND root_realm_slug = $2
             AND root_normalized_name = $3
             AND status IN ${activeRunSql}`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0] ? mapRun(result.rows[0]) : null;
      },

      async listRecent(limit) {
        const result = await pool.query<RunRow>(
          `SELECT * FROM discovery_runs
           ORDER BY created_at DESC, id DESC
           LIMIT $1`,
          [limit]
        );
        return result.rows.map(mapRun);
      }
    }
  };
}
