import { StaleFingerprintDeliveryError } from "./fingerprint-delivery-error";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CharacterKey } from "@slashwho/domain";
import { lockFingerprintSweeps, lockRoot } from "./locks";
import { withTransaction } from "./sql";
import { createDiscoveryRunRepositories } from "./discovery-runs";
import { createSnapshotRepositories } from "./snapshots";
import {
  requeueContinuations,
  createFingerprintSweepRepositories
} from "./fingerprint-sweeps";
import { createSmallStoreRepositories } from "./small-stores";
import type { Repositories } from "./repositories";

export type FingerprintDeliveryDescriptor = {
  admissionId: string;
  attemptBase: number;
  continuation: boolean;
};

export interface FingerprintDeliveryRepository {
  boundAdmission(runId: string, jobId: string): Promise<string | null>;
  executeOriginal(
    input: {
      runId: string;
      jobId: string;
      attempt: number;
      maxAttempts: number;
    },
    work: (
      repositories: Pick<
        Repositories,
        "runs" | "snapshots" | "fingerprintSweeps" | "negativeCache"
      >
    ) => Promise<void>
  ): Promise<void>;
  descriptor(runId: string): Promise<FingerprintDeliveryDescriptor | null>;
  markDispatched(admissionId: string, at: Date): Promise<void>;
  recoverLegacy(): Promise<void>;
  recoverTerminal(): Promise<void>;
  execute(
    input: {
      runId: string;
      admissionId: string;
      jobId: string;
      attempt: number;
      maxAttempts: number;
    },
    work: (execution: {
      repositories: Pick<
        Repositories,
        "runs" | "snapshots" | "fingerprintSweeps" | "negativeCache"
      >;
      attempt: number;
      maxAttempts: number;
      continuation: boolean;
    }) => Promise<void>
  ): Promise<void>;
  isIdentifiedRun(runId: string): Promise<boolean>;
}

type Fence = {
  admissionId: string;
  runId: string;
  key: CharacterKey;
  token: string;
};

async function lockAndCheck(client: PoolClient, fence: Fence): Promise<void> {
  await lockRoot(client, fence.key);
  await lockFingerprintSweeps(client);
  const valid = await client.query(
    `SELECT id FROM fingerprint_sweep_admissions a
     WHERE id = $1 AND discovery_run_id = $2 AND execution_token = $3
       AND consumed_at IS NULL
       AND (a.dispatch_kind <> 'continuation' OR EXISTS (
         SELECT 1 FROM fingerprint_sweep_states s JOIN snapshots snap ON snap.id = s.resume_snapshot_id
         WHERE s.region = a.region AND s.realm_slug = a.realm_slug AND s.normalized_name = a.normalized_name
           AND s.resume_after IS NOT NULL AND snap.discovery_run_id = a.discovery_run_id))
       AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions newer
         WHERE newer.discovery_run_id = a.discovery_run_id AND newer.queue_order > a.queue_order)
     FOR UPDATE`,
    [fence.admissionId, fence.runId, fence.token]
  );
  if (valid.rowCount !== 1) throw new StaleFingerprintDeliveryError();
}

/**
 * Storage for one accepted execution. Transactions check cycle ownership under
 * the same locks as publication; single-statement writes receive that same
 * transaction boundary. Provider calls never hold these locks.
 */
function fencedPool(
  pool: Pool,
  key: CharacterKey,
  currentFence: () => Fence | null,
  initialExecution: { runId: string; attempt: number },
  bindAdmission: (client: PoolClient) => Promise<void>
): Pool {
  const check = async (client: PoolClient) => {
    const fence = currentFence();
    if (fence) await lockAndCheck(client, fence);
    else {
      await lockRoot(client, key);
      await lockFingerprintSweeps(client);
      const run = await client.query<{ attempt: number }>(
        "SELECT attempt FROM discovery_runs WHERE id = $1",
        [initialExecution.runId]
      );
      if ((run.rows[0]?.attempt ?? 0) > initialExecution.attempt)
        throw new StaleFingerprintDeliveryError();
    }
  };
  const finish = async (client: PoolClient) => {
    await bindAdmission(client);
    const fence = currentFence();
    if (!fence) return;
    await client.query(
      `UPDATE fingerprint_sweep_admissions a SET consumed_at = now()
      FROM discovery_runs r WHERE a.id = $1 AND r.id = a.discovery_run_id
        AND a.execution_token = $2 AND a.consumed_at IS NULL
        AND (r.status = 'failed' OR (r.status = 'complete' AND a.dispatch_kind = 'ordinary') OR
          (a.dispatch_kind = 'continuation' AND EXISTS (SELECT 1 FROM fingerprint_sweep_states state
            WHERE state.region = a.region AND state.realm_slug = a.realm_slug
              AND state.normalized_name = a.normalized_name AND state.continuation_failures >= 5)))`,
      [fence.admissionId, fence.token]
    );
    await client.query(
      `UPDATE fingerprint_sweep_reservations reservation SET released_at = now()
      FROM fingerprint_sweep_admissions a WHERE reservation.admission_id = a.id
        AND a.id = $1 AND a.execution_token = $2 AND a.consumed_at IS NOT NULL
        AND reservation.released_at IS NULL`,
      [fence.admissionId, fence.token]
    );
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          let readOnly = false;
          return new Proxy(client, {
            get(connection, name) {
              if (name === "query")
                return async (...args: unknown[]) => {
                  const sql = args[0] as string;
                  if (sql.startsWith("BEGIN"))
                    readOnly = sql.includes("READ ONLY");
                  if (sql === "COMMIT" && !readOnly) await finish(connection);
                  const result = await connection.query(
                    sql,
                    args[1] as unknown[] | undefined
                  );
                  if (sql === "BEGIN") await check(connection);
                  return result;
                };
              const value: unknown = Reflect.get(connection, name);
              return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(connection)
                : value;
            }
          });
        };
      if (property === "query")
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0].trim() : "";
          if (/^SELECT\b/i.test(sql))
            return target.query(
              args[0] as string,
              args[1] as unknown[] | undefined
            );
          return withTransaction(target, async (client) => {
            await check(client);
            const result = await client.query(
              args[0] as string,
              args[1] as unknown[] | undefined
            );
            await finish(client);
            return result;
          });
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

function executionRepositories(
  pool: Pool,
  key: CharacterKey,
  input: { runId: string; jobId: string; attempt: number; maxAttempts: number },
  baseline: number,
  initialFence: Fence | null
) {
  let fence = initialFence;
  let admitting = false;
  const scoped = fencedPool(
    pool,
    key,
    () => fence,
    input,
    async (client) => {
      if (!admitting) return;
      // An immediate admission remains on the already executing physical job.
      // Bind it before commit so backlog recovery cannot dispatch a competitor.
      // A budget deferral stays unbound and captures its durable resumption base.
      const bound = await client.query<{ id: string; execution_token: string }>(
        `UPDATE fingerprint_sweep_admissions a
      SET attempt_base = $4, execution_job_id = $2, execution_attempt = $3,
        execution_max_attempts = $5, execution_token = $6, dispatched_at = now()
      WHERE a.discovery_run_id = $1 AND a.status = 'admitted' AND a.consumed_at IS NULL
        AND a.execution_job_id IS NULL AND a.dispatched_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions n
          WHERE n.discovery_run_id = a.discovery_run_id AND n.queue_order > a.queue_order)
      RETURNING id, execution_token`,
        [
          input.runId,
          input.jobId,
          input.attempt,
          baseline,
          input.maxAttempts,
          randomUUID()
        ]
      );
      const row = bound.rows[0];
      if (row)
        fence = {
          admissionId: row.id,
          runId: input.runId,
          key,
          token: row.execution_token
        };
    }
  );
  const sweeps = createFingerprintSweepRepositories(scoped).fingerprintSweeps;
  return {
    ...createDiscoveryRunRepositories(scoped),
    ...createSnapshotRepositories(scoped),
    fingerprintSweeps: {
      ...sweeps,
      async requestAdmission(
        input: Parameters<typeof sweeps.requestAdmission>[0]
      ) {
        admitting = true;
        try {
          return await sweeps.requestAdmission(input);
        } finally {
          admitting = false;
        }
      }
    },
    negativeCache: createSmallStoreRepositories(scoped).negativeCache
  };
}

export function createFingerprintDeliveryRepository(
  pool: Pool
): FingerprintDeliveryRepository {
  return {
    async boundAdmission(runId, jobId) {
      const result = await pool.query<{ id: string }>(
        `SELECT a.id FROM fingerprint_sweep_admissions a
        WHERE a.discovery_run_id = $1 AND a.execution_job_id = $2 AND a.consumed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions n
            WHERE n.discovery_run_id = a.discovery_run_id AND n.queue_order > a.queue_order)`,
        [runId, jobId]
      );
      return result.rows[0]?.id ?? null;
    },
    async executeOriginal(input, work) {
      const run = await createDiscoveryRunRepositories(pool).runs.find(
        input.runId
      );
      if (!run) return;
      try {
        await work(executionRepositories(pool, run.rootKey, input, 0, null));
      } catch (error) {
        if (!(error instanceof StaleFingerprintDeliveryError)) throw error;
      }
    },
    async recoverTerminal() {
      const candidates = await pool.query<{
        id: string;
        run_id: string;
        region: CharacterKey["region"];
        realm: string;
        name: string;
      }>(
        `SELECT a.id, r.id AS run_id, r.root_region AS region, r.root_realm_slug AS realm,
          r.root_normalized_name AS name FROM fingerprint_sweep_admissions a
         JOIN discovery_runs r ON r.id = a.discovery_run_id
         LEFT JOIN pgboss.job j ON j.id = a.execution_job_id
         WHERE a.execution_job_id IS NOT NULL AND a.consumed_at IS NULL
           AND (j.id IS NULL OR j.state IN ('completed','failed','cancelled'))
           AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions n
             WHERE n.discovery_run_id = a.discovery_run_id AND n.queue_order > a.queue_order)`
      );
      for (const candidate of candidates.rows) {
        await withTransaction(pool, async (client) => {
          await lockRoot(client, candidate);
          await lockFingerprintSweeps(client);
          const retired = await client.query<{ dispatch_kind: string }>(
            `UPDATE fingerprint_sweep_admissions a
            SET consumed_at = now(), status = 'released' WHERE a.id = $1 AND consumed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions n
                WHERE n.discovery_run_id = a.discovery_run_id AND n.queue_order > a.queue_order)
              AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.id = a.execution_job_id
                AND j.state IN ('created','retry','active')) RETURNING dispatch_kind`,
            [candidate.id]
          );
          if (!retired.rows[0]) return;
          await client.query(
            `UPDATE fingerprint_sweep_reservations SET released_at = coalesce(released_at, now())
            WHERE admission_id = $1`,
            [candidate.id]
          );
          if (retired.rows[0].dispatch_kind === "ordinary") {
            await client.query(
              `UPDATE discovery_runs SET status = 'failed', error_code = 'upstream_unavailable',
              completed_at = now(), next_retry_at = NULL WHERE id = $1 AND status IN ('running','queued','retrying')`,
              [candidate.run_id]
            );
            return;
          }
          const failures = await client.query<{
            continuation_failures: number;
          }>(
            `UPDATE fingerprint_sweep_states
            SET continuation_failures = continuation_failures + 1 WHERE region = $1 AND realm_slug = $2
              AND normalized_name = $3 AND EXISTS (SELECT 1 FROM snapshots snap
                WHERE snap.id = fingerprint_sweep_states.resume_snapshot_id AND snap.discovery_run_id = $4)
              RETURNING continuation_failures`,
            [
              candidate.region,
              candidate.realm,
              candidate.name,
              candidate.run_id
            ]
          );
          const count = failures.rows[0]?.continuation_failures ?? 5;
          if (count >= 5) return;
          const at = new Date();
          await requeueContinuations(client, {
            at,
            notBefore: new Date(
              at.getTime() +
                Math.min(60 * 60_000, 2 * 60_000 * 2 ** Math.max(0, count - 1))
            ),
            runId: candidate.run_id,
            maxFailures: 5,
            limit: 1
          });
        });
      }
    },
    async isIdentifiedRun(runId) {
      const result = await pool.query(
        `SELECT 1 FROM fingerprint_sweep_admissions
        WHERE discovery_run_id = $1 AND attempt_base IS NOT NULL LIMIT 1`,
        [runId]
      );
      return result.rowCount === 1;
    },
    async descriptor(runId) {
      const result = await pool.query<{
        id: string;
        attempt_base: number;
        dispatch_kind: string;
      }>(
        `SELECT a.id, a.attempt_base, a.dispatch_kind
        FROM fingerprint_sweep_admissions a JOIN discovery_runs r ON r.id = a.discovery_run_id
        WHERE a.discovery_run_id = $1 AND a.consumed_at IS NULL
          AND a.status IN ('admitted', 'not_due') AND a.attempt_base IS NOT NULL AND a.execution_job_id IS NULL
          AND (r.status IN ('queued','running','retrying') OR a.dispatch_kind = 'continuation')
          AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions n
            WHERE n.discovery_run_id = a.discovery_run_id AND n.queue_order > a.queue_order)
        ORDER BY a.queue_order DESC LIMIT 1`,
        [runId]
      );
      const row = result.rows[0];
      return row
        ? {
            admissionId: row.id,
            attemptBase: row.attempt_base,
            continuation: row.dispatch_kind === "continuation"
          }
        : null;
    },
    async markDispatched(admissionId, at) {
      await pool.query(
        `UPDATE fingerprint_sweep_admissions SET dispatched_at = $2
        WHERE id = $1 AND consumed_at IS NULL AND dispatched_at IS NULL`,
        [admissionId, at]
      );
    },
    async recoverLegacy() {
      const roots = await pool.query<{
        run_id: string;
        region: CharacterKey["region"];
        realm: string;
        name: string;
      }>(
        `SELECT DISTINCT r.id AS run_id, r.root_region AS region, r.root_realm_slug AS realm,
          r.root_normalized_name AS name FROM discovery_runs r
         JOIN fingerprint_sweep_admissions a ON a.discovery_run_id = r.id
         WHERE a.attempt_base IS NULL AND a.consumed_at IS NULL ORDER BY r.id`
      );
      for (const root of roots.rows) {
        await withTransaction(pool, async (client) => {
          await lockRoot(client, root);
          await lockFingerprintSweeps(client);
          await client.query(
            `UPDATE fingerprint_sweep_admissions a SET consumed_at = now()
            WHERE a.discovery_run_id = $1 AND a.attempt_base IS NULL AND a.consumed_at IS NULL
              AND (a.status NOT IN ('waiting','admitted','not_due') OR EXISTS (
                SELECT 1 FROM fingerprint_sweep_admissions n WHERE n.discovery_run_id = a.discovery_run_id
                  AND n.queue_order > a.queue_order))`,
            [root.run_id]
          );
          const actionable = await client.query<{
            id: string;
            kind: string;
            baseline: number;
          }>(
            `SELECT a.id, CASE WHEN r.status = 'complete' THEN 'continuation' ELSE 'ordinary' END AS kind,
              greatest(r.attempt, coalesce((SELECT j.retry_count + 1 FROM pgboss.job j
                WHERE j.id::text = r.queue_job_id AND j.state <> 'created'), 0)) AS baseline
             FROM fingerprint_sweep_admissions a JOIN discovery_runs r ON r.id = a.discovery_run_id
             LEFT JOIN fingerprint_sweep_states s ON s.region = r.root_region
               AND s.realm_slug = r.root_realm_slug AND s.normalized_name = r.root_normalized_name
             LEFT JOIN snapshots snap ON snap.id = s.resume_snapshot_id
             WHERE r.id = $1 AND a.attempt_base IS NULL AND a.consumed_at IS NULL
               AND (r.status IN ('queued','running','retrying') OR
                 (r.status = 'complete' AND s.resume_after IS NOT NULL AND snap.discovery_run_id = r.id
                   AND a.status IN ('waiting','admitted')))
             ORDER BY a.queue_order DESC LIMIT 1 FOR UPDATE OF a, r`,
            [root.run_id]
          );
          const row = actionable.rows[0];
          if (!row) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions SET consumed_at = now()
              WHERE discovery_run_id = $1 AND attempt_base IS NULL AND consumed_at IS NULL`,
              [root.run_id]
            );
            return;
          }
          await client.query(
            `UPDATE pgboss.job SET state = 'cancelled', completed_on = now()
            WHERE name = 'discover-character' AND data->>'runId' = $1
              AND NOT (data ? 'admissionId') AND state IN ('created','retry','active')`,
            [root.run_id]
          );
          await client.query(
            `UPDATE fingerprint_sweep_admissions
            SET attempt_base = $2, dispatch_kind = $3, execution_max_attempts = 5, dispatched_at = NULL
            WHERE id = $1 AND attempt_base IS NULL`,
            [row.id, row.baseline, row.kind]
          );
          if (row.kind === "ordinary")
            await client.query(
              `UPDATE discovery_runs
            SET status = 'queued' WHERE id = $1 AND status = 'running'`,
              [root.run_id]
            );
        });
      }
    },
    async execute(input, work) {
      const run = await createDiscoveryRunRepositories(pool).runs.find(
        input.runId
      );
      if (!run) return;
      const token = randomUUID();
      const accepted = await withTransaction(pool, async (client) => {
        await lockRoot(client, run.rootKey);
        await lockFingerprintSweeps(client);
        const result = await client.query<{
          attempt_base: number;
          dispatch_kind: string;
          execution_max_attempts: number;
        }>(
          `UPDATE fingerprint_sweep_admissions a SET execution_job_id = $3,
            execution_attempt = $4, execution_token = $6, dispatched_at = coalesce(dispatched_at, now())
           WHERE id = $1 AND discovery_run_id = $2 AND consumed_at IS NULL
             AND attempt_base IS NOT NULL AND status IN ('admitted','not_due','released','finished')
             AND (execution_job_id IS NULL OR execution_job_id = $3)
             AND execution_attempt < $4 AND $4 <= execution_max_attempts
             AND execution_max_attempts = $5
             AND NOT EXISTS (SELECT 1 FROM fingerprint_sweep_admissions n
               WHERE n.discovery_run_id = a.discovery_run_id AND n.queue_order > a.queue_order)
           RETURNING attempt_base, dispatch_kind, execution_max_attempts`,
          [
            input.admissionId,
            input.runId,
            input.jobId,
            input.attempt,
            input.maxAttempts,
            token
          ]
        );
        const row = result.rows[0];
        if (!row) return null;
        if (row.dispatch_kind === "ordinary") {
          const claim = await client.query(
            `UPDATE discovery_runs SET status = 'running', attempt = $2,
            started_at = coalesce(started_at, now()), next_retry_at = NULL
            WHERE id = $1 AND status IN ('queued','running','retrying') AND attempt < $2 RETURNING id`,
            [input.runId, row.attempt_base + input.attempt]
          );
          if (claim.rowCount !== 1) throw new StaleFingerprintDeliveryError();
        } else {
          const owner = await client.query(
            `SELECT 1 FROM fingerprint_sweep_states s
            JOIN snapshots snap ON snap.id = s.resume_snapshot_id
            WHERE s.region = $1 AND s.realm_slug = $2 AND s.normalized_name = $3
              AND s.resume_after IS NOT NULL AND snap.discovery_run_id = $4`,
            [
              run.rootKey.region,
              run.rootKey.realm,
              run.rootKey.name,
              input.runId
            ]
          );
          if (owner.rowCount !== 1) throw new StaleFingerprintDeliveryError();
        }
        return row;
      }).catch((error: unknown) => {
        if (error instanceof StaleFingerprintDeliveryError) return null;
        throw error;
      });
      if (!accepted) return;
      const repositories = executionRepositories(
        pool,
        run.rootKey,
        input,
        accepted.attempt_base,
        {
          admissionId: input.admissionId,
          runId: input.runId,
          key: run.rootKey,
          token
        }
      );
      const runs = repositories.runs;
      try {
        await work({
          repositories: {
            runs: { ...runs, claim: async () => runs.find(input.runId) },
            snapshots: repositories.snapshots,
            fingerprintSweeps: repositories.fingerprintSweeps,
            negativeCache: repositories.negativeCache
          },
          attempt: accepted.attempt_base + input.attempt,
          maxAttempts: accepted.attempt_base + accepted.execution_max_attempts,
          continuation: accepted.dispatch_kind === "continuation"
        });
      } catch (error) {
        if (!(error instanceof StaleFingerprintDeliveryError)) throw error;
      }
    }
  };
}
