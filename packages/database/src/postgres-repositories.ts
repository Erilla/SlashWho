import type { PublicErrorCode } from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import type {
  CallerClass,
  CreateSnapshotInput,
  DiscoveryRun,
  FingerprintAdmission,
  Repositories,
  SnapshotHistoryItem,
  SnapshotHistoryPage,
  StoredSnapshot,
  StoredSnapshotCharacter
} from "./repositories";

interface RunRow {
  id: string;
  root_region: CharacterKey["region"];
  root_realm_slug: string;
  root_normalized_name: string;
  root_character_id: string | null;
  queue_job_id: string | null;
  status: DiscoveryRun["status"];
  caller_class: CallerClass;
  attempt: number;
  next_retry_at: Date | null;
  error_code: PublicErrorCode | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  snapshot_id: string | null;
}

interface SnapshotRow {
  id: string;
  discovery_run_id: string;
  root_region: CharacterKey["region"];
  root_realm_slug: string;
  root_normalized_name: string;
  state: StoredSnapshot["state"];
  limitation_code: string | null;
  refreshed_at: Date;
  character_count: number;
}

interface SnapshotCharacterRow {
  character_id: string;
  region: CharacterKey["region"];
  realm_slug: string;
  normalized_name: string;
  display_name: string;
  class_name: string;
  level: number;
  raider_io_url: string;
  discovery_source: StoredSnapshotCharacter["source"];
  display_order: number;
}

type Queryable = Pick<Pool | PoolClient, "query">;

const activeRunSql = "('queued', 'running', 'retrying')";

async function lockRoot(client: Queryable, key: CharacterKey): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `root:${key.region}:${key.realm}:${key.name}`
  ]);
}

async function lockFingerprintSweeps(client: Queryable): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "fingerprint-sweeps"
  ]);
}

function assertFingerprintAdmissionInput(input: {
  requestCap: number;
  hourlyBudget: number;
  cadenceCutoff: Date;
  at: Date;
}): void {
  if (!Number.isInteger(input.requestCap) || input.requestCap < 1) {
    throw new RangeError("fingerprint_request_cap_out_of_range");
  }
  if (!Number.isInteger(input.hourlyBudget) || input.hourlyBudget < 1) {
    throw new RangeError("fingerprint_hourly_budget_out_of_range");
  }
  if (input.requestCap > input.hourlyBudget) {
    throw new RangeError("fingerprint_request_cap_exceeds_hourly_budget");
  }
  if (
    Number.isNaN(input.cadenceCutoff.valueOf()) ||
    Number.isNaN(input.at.valueOf())
  ) {
    throw new RangeError("fingerprint_admission_time_invalid");
  }
}

async function fingerprintRetryAt(client: Queryable, at: Date): Promise<Date> {
  const result = await client.query<{ retry_at: Date | null }>(
    `SELECT min(retry_at) AS retry_at FROM (
       SELECT expires_at AS retry_at
       FROM fingerprint_sweep_reservations
       WHERE expires_at > $1 AND released_at IS NULL
       UNION ALL
       SELECT requested_at + interval '1 hour' AS retry_at
       FROM fingerprint_sweep_request_events
       WHERE requested_at + interval '1 hour' > $1
     ) retained`,
    [at]
  );
  return result.rows[0]?.retry_at ?? at;
}

async function admitFingerprintWaitingRun(
  client: Queryable,
  admissionId: string,
  at: Date
): Promise<Extract<FingerprintAdmission, { kind: "admitted" | "waiting" }>> {
  const head = await client.query<{
    id: string;
    request_cap: number;
    hourly_budget: number;
    requested_at: Date;
  }>(
    `SELECT admission.id, admission.request_cap, admission.hourly_budget, admission.requested_at
     FROM fingerprint_sweep_admissions admission
     LEFT JOIN fingerprint_sweep_states state
       ON state.region = admission.region
      AND state.realm_slug = admission.realm_slug
      AND state.normalized_name = admission.normalized_name
     WHERE admission.status = 'waiting'
       AND (
         state.last_published_at IS NULL
         OR state.last_published_at <= admission.cadence_cutoff
       )
     ORDER BY admission.requested_at, admission.queue_order
     LIMIT 1
     FOR UPDATE OF admission`
  );
  const candidate = head.rows[0];
  if (!candidate || candidate.id !== admissionId) {
    const requested = await client.query<{ requested_at: Date }>(
      `SELECT requested_at FROM fingerprint_sweep_admissions WHERE id = $1`,
      [admissionId]
    );
    return {
      kind: "waiting",
      retryAt: await fingerprintRetryAt(client, at),
      blockedSince: requested.rows[0]?.requested_at
    };
  }

  const usage = await client.query<{ commitment: string }>(
    `SELECT (
       SELECT count(*) FROM fingerprint_sweep_request_events
       WHERE requested_at > $1::timestamptz - interval '1 hour'
     ) + coalesce(sum(request_cap - used_count) FILTER (
       WHERE released_at IS NULL AND expires_at > $1
     ), 0)::bigint AS commitment
     FROM fingerprint_sweep_reservations`,
    [at]
  );
  if (
    Number(usage.rows[0]!.commitment) + candidate.request_cap >
    candidate.hourly_budget
  ) {
    return {
      kind: "waiting",
      retryAt: await fingerprintRetryAt(client, at),
      blockedSince: candidate.requested_at
    };
  }

  const reservation = await client.query<{ id: string }>(
    `INSERT INTO fingerprint_sweep_reservations
     (admission_id, request_cap, admitted_at, expires_at)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '1 hour')
     RETURNING id`,
    [admissionId, candidate.request_cap, at]
  );
  await client.query(
    `UPDATE fingerprint_sweep_admissions
     SET status = 'admitted', dispatched_at = NULL
     WHERE id = $1`,
    [admissionId]
  );
  return {
    kind: "admitted",
    reservationId: reservation.rows[0]!.id,
    requestCap: candidate.request_cap,
    committedRequests: Number(usage.rows[0]!.commitment) + candidate.request_cap,
    hourlyBudget: candidate.hourly_budget
  };
}

function mapRun(row: RunRow): DiscoveryRun {
  return {
    id: row.id,
    rootKey: {
      region: row.root_region,
      realm: row.root_realm_slug,
      name: row.root_normalized_name
    },
    rootCharacterId: row.root_character_id,
    queueJobId: row.queue_job_id,
    status: row.status,
    callerClass: row.caller_class,
    attempt: row.attempt,
    nextRetryAt: row.next_retry_at,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    snapshotId: row.snapshot_id
  };
}

function encodeCursor(item: SnapshotHistoryItem): string {
  return Buffer.from(
    JSON.stringify({ refreshedAt: item.refreshedAt.toISOString(), id: item.id })
  ).toString("base64url");
}

function decodeCursor(cursor: string): { refreshedAt: Date; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as {
      refreshedAt?: unknown;
      id?: unknown;
    };
    const refreshedAt = new Date(String(value.refreshedAt));
    if (
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value.id
      ) ||
      Number.isNaN(refreshedAt.valueOf())
    ) {
      throw new Error("invalid_cursor");
    }
    return { refreshedAt, id: value.id };
  } catch {
    throw new Error("invalid_cursor");
  }
}

async function loadSnapshot(
  client: Queryable,
  id: string
): Promise<StoredSnapshot | null> {
  const snapshotResult = await client.query<SnapshotRow>(
    `SELECT
      s.id,
      s.discovery_run_id,
      root.region AS root_region,
      root.realm_slug AS root_realm_slug,
      root.normalized_name AS root_normalized_name,
      s.state,
      s.limitation_code,
      s.refreshed_at,
      s.character_count
    FROM snapshots s
    JOIN characters root ON root.id = s.root_character_id
    WHERE s.id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM suppressed_characters suppression
        WHERE suppression.region = root.region
          AND suppression.realm_slug = root.realm_slug
          AND suppression.normalized_name = root.normalized_name
          AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
      )`,
    [id]
  );
  const row = snapshotResult.rows[0];
  if (!row) return null;

  const characterResult = await client.query<SnapshotCharacterRow>(
    `SELECT
      membership.character_id,
      character.region,
      character.realm_slug,
      character.normalized_name,
      membership.display_name,
      membership.class_name,
      membership.level,
      membership.raider_io_url,
      membership.discovery_source,
      membership.display_order
    FROM snapshot_characters membership
    JOIN characters character ON character.id = membership.character_id
    WHERE membership.snapshot_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM suppressed_characters suppression
        WHERE suppression.region = character.region
          AND suppression.realm_slug = character.realm_slug
          AND suppression.normalized_name = character.normalized_name
          AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
      )
    ORDER BY membership.display_order`,
    [id]
  );
  const characters: StoredSnapshotCharacter[] = characterResult.rows.map(
    (character) => ({
      characterId: character.character_id,
      key: {
        region: character.region,
        realm: character.realm_slug,
        name: character.normalized_name
      },
      displayName: character.display_name,
      className: character.class_name,
      level: character.level,
      raiderIoUrl: character.raider_io_url,
      source: character.discovery_source,
      displayOrder: character.display_order
    })
  );

  return {
    id: row.id,
    runId: row.discovery_run_id,
    rootKey: {
      region: row.root_region,
      realm: row.root_realm_slug,
      name: row.root_normalized_name
    },
    state: row.state,
    limitationCode: row.limitation_code,
    refreshedAt: row.refreshed_at,
    characterCount: characters.length,
    characters
  };
}

async function createSnapshot(
  client: PoolClient,
  input: CreateSnapshotInput,
  options?: { signal?: AbortSignal }
): Promise<StoredSnapshot> {
  const runResult = await client.query(
    `SELECT 1 FROM discovery_runs
     WHERE id = $1
       AND root_region = $2
       AND root_realm_slug = $3
       AND root_normalized_name = $4
       AND status IN ${activeRunSql}
     FOR UPDATE`,
    [input.runId, input.rootKey.region, input.rootKey.realm, input.rootKey.name]
  );
  if (runResult.rowCount !== 1) {
    throw new Error("discovery_run_root_mismatch");
  }

  const characterIds = new Map<string, string>();
  const charactersByCanonicalKey = [...input.characters].sort((left, right) => {
    const leftKey = `${left.key.region}\0${left.key.realm}\0${left.key.name}`;
    const rightKey = `${right.key.region}\0${right.key.realm}\0${right.key.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (const character of charactersByCanonicalKey) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO characters
        (region, realm_slug, normalized_name, display_name, class_name,
         level, raider_io_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         class_name = EXCLUDED.class_name,
         level = EXCLUDED.level,
         raider_io_url = EXCLUDED.raider_io_url,
         updated_at = now()
       RETURNING id`,
      [
        character.key.region,
        character.key.realm,
        character.key.name,
        character.displayName,
        character.className,
        character.level,
        character.raiderIoUrl
      ]
    );
    characterIds.set(
      `${character.key.region}/${character.key.realm}/${character.key.name}`,
      result.rows[0]!.id
    );
  }

  const rootId = characterIds.get(
    `${input.rootKey.region}/${input.rootKey.realm}/${input.rootKey.name}`
  );
  if (!rootId) throw new Error("snapshot_root_missing");

  const snapshotResult = await client.query<{ id: string }>(
    `INSERT INTO snapshots
      (root_character_id, discovery_run_id, state, limitation_code,
       refreshed_at, character_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      rootId,
      input.runId,
      input.state,
      input.limitationCode,
      input.refreshedAt,
      input.characters.length
    ]
  );
  const snapshotId = snapshotResult.rows[0]!.id;

  await client.query(
    `UPDATE discovery_runs SET root_character_id = $2 WHERE id = $1`,
    [input.runId, rootId]
  );

  for (const [displayOrder, character] of input.characters.entries()) {
    const characterId = characterIds.get(
      `${character.key.region}/${character.key.realm}/${character.key.name}`
    )!;
    await client.query(
      `INSERT INTO snapshot_characters
        (snapshot_id, character_id, display_order, discovery_source,
         display_name, class_name, level, raider_io_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        snapshotId,
        characterId,
        displayOrder,
        character.source,
        character.displayName,
        character.className,
        character.level,
        character.raiderIoUrl
      ]
    );
  }

  const publication = await client.query(
    `UPDATE discovery_runs
     SET status = 'complete', snapshot_id = $2,
         completed_at = COALESCE(completed_at, now()),
         next_retry_at = NULL, error_code = NULL
     WHERE id = $1 AND status IN ${activeRunSql}`,
    [input.runId, snapshotId]
  );
  if (publication.rowCount !== 1) {
    throw new Error("discovery_run_not_active");
  }

  const snapshot = await loadSnapshot(client, snapshotId);
  if (!snapshot) throw new Error("snapshot_not_found");
  options?.signal?.throwIfAborted();
  return snapshot;
}

async function finishFingerprintSweep(
  client: PoolClient,
  reservationId: string,
  input: { published: boolean; at: Date; limitationCode: string | null }
): Promise<void> {
  const reservation = await client.query<{
    admission_id: string;
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
  }>(
    `UPDATE fingerprint_sweep_reservations reservation
     SET released_at = $2,
         finished_at = $2,
         published = $3,
         limitation_code = $4
     FROM fingerprint_sweep_admissions admission
     WHERE reservation.id = $1
       AND reservation.admission_id = admission.id
       AND reservation.released_at IS NULL
     RETURNING reservation.admission_id, admission.region,
               admission.realm_slug, admission.normalized_name`,
    [reservationId, input.at, input.published, input.limitationCode]
  );
  const row = reservation.rows[0];
  if (!row) throw new Error("fingerprint_reservation_not_active");
  await client.query(
    `UPDATE fingerprint_sweep_admissions
     SET status = 'finished'
     WHERE id = $1`,
    [row.admission_id]
  );
  if (input.published) {
    await client.query(
      `INSERT INTO fingerprint_sweep_states
        (region, realm_slug, normalized_name, last_published_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET last_published_at = greatest(
         fingerprint_sweep_states.last_published_at,
         EXCLUDED.last_published_at
       )`,
      [row.region, row.realm_slug, row.normalized_name, input.at]
    );
  }
}

async function requireUpdated(
  client: Pool,
  text: string,
  values: unknown[]
): Promise<void> {
  const result = await client.query(text, values);
  if (result.rowCount !== 1) throw new Error("discovery_run_not_found");
}

export function createPostgresRepositories(pool: Pool): Repositories {
  return {
    searchReservations: {
      async reserve(input) {
        if (!Number.isInteger(input.limit) || input.limit < 1) {
          throw new RangeError("rate_limit_out_of_range");
        }
        if (input.expiresAt <= input.at) {
          throw new RangeError("rate_limit_expiry_out_of_range");
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
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
            await client.query("COMMIT");
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
            await client.query("COMMIT");
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
              await client.query("COMMIT");
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
            await client.query("COMMIT");
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
          if (Number(usage.rows[0]!.count) >= input.limit) {
            const retryAt = usage.rows[0]!.retry_at;
            if (!retryAt) throw new Error("rate_limit_retry_missing");
            await client.query("COMMIT");
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
          const run = mapRun(runResult.rows[0]!);
          await client.query(
            `INSERT INTO rate_limit_events
              (caller_bucket_hash, discovery_run_id, expires_at)
             VALUES ($1, $2, $3)`,
            [input.callerBucketHash, run.id, input.expiresAt]
          );
          await client.query("COMMIT");
          return { kind: "reserved", run };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async cancel(runId) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
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
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
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
        return mapRun(result.rows[0]!);
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

      async markRunning(id) {
        await requireUpdated(
          pool,
          `UPDATE discovery_runs
           SET status = 'running', started_at = COALESCE(started_at, now()),
               next_retry_at = NULL
           WHERE id = $1 AND status IN ${activeRunSql}`,
          [id]
        );
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

      async complete(id, snapshotId) {
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
      }
    },

    snapshots: {
      async create(input, options) {
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, input.rootKey);
          const runResult = await client.query(
            `SELECT 1 FROM discovery_runs
             WHERE id = $1
               AND root_region = $2
               AND root_realm_slug = $3
               AND root_normalized_name = $4
               AND status IN ${activeRunSql}
             FOR UPDATE`,
            [
              input.runId,
              input.rootKey.region,
              input.rootKey.realm,
              input.rootKey.name
            ]
          );
          if (runResult.rowCount !== 1) {
            throw new Error("discovery_run_root_mismatch");
          }

          const characterIds = new Map<string, string>();
          const charactersByCanonicalKey = [...input.characters].sort(
            (left, right) => {
              const leftKey = `${left.key.region}\0${left.key.realm}\0${left.key.name}`;
              const rightKey = `${right.key.region}\0${right.key.realm}\0${right.key.name}`;
              return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
            }
          );
          for (const character of charactersByCanonicalKey) {
            const result = await client.query<{ id: string }>(
              `INSERT INTO characters
                (region, realm_slug, normalized_name, display_name, class_name,
                 level, raider_io_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (region, realm_slug, normalized_name)
               DO UPDATE SET
                 display_name = EXCLUDED.display_name,
                 class_name = EXCLUDED.class_name,
                 level = EXCLUDED.level,
                 raider_io_url = EXCLUDED.raider_io_url,
                 updated_at = now()
               RETURNING id`,
              [
                character.key.region,
                character.key.realm,
                character.key.name,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl
              ]
            );
            characterIds.set(
              `${character.key.region}/${character.key.realm}/${character.key.name}`,
              result.rows[0]!.id
            );
          }

          const rootId = characterIds.get(
            `${input.rootKey.region}/${input.rootKey.realm}/${input.rootKey.name}`
          );
          if (!rootId) throw new Error("snapshot_root_missing");

          const snapshotResult = await client.query<{ id: string }>(
            `INSERT INTO snapshots
              (root_character_id, discovery_run_id, state, limitation_code,
               refreshed_at, character_count)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [
              rootId,
              input.runId,
              input.state,
              input.limitationCode,
              input.refreshedAt,
              input.characters.length
            ]
          );
          const snapshotId = snapshotResult.rows[0]!.id;

          await client.query(
            `UPDATE discovery_runs SET root_character_id = $2 WHERE id = $1`,
            [input.runId, rootId]
          );

          for (const [displayOrder, character] of input.characters.entries()) {
            const characterId = characterIds.get(
              `${character.key.region}/${character.key.realm}/${character.key.name}`
            )!;
            await client.query(
              `INSERT INTO snapshot_characters
                (snapshot_id, character_id, display_order, discovery_source,
                 display_name, class_name, level, raider_io_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                snapshotId,
                characterId,
                displayOrder,
                character.source,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl
              ]
            );
          }

          const publication = await client.query(
            `UPDATE discovery_runs
             SET status = 'complete', snapshot_id = $2,
                 completed_at = COALESCE(completed_at, now()),
                 next_retry_at = NULL, error_code = NULL
             WHERE id = $1 AND status IN ${activeRunSql}`,
            [input.runId, snapshotId]
          );
          if (publication.rowCount !== 1) {
            throw new Error("discovery_run_not_active");
          }

          const snapshot = await loadSnapshot(client, snapshotId);
          if (!snapshot) throw new Error("snapshot_not_found");
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
          return snapshot;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async createAndFinishFingerprintSweep(input, fingerprint, options) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, input.rootKey);
          await lockFingerprintSweeps(client);
          const snapshot = await createSnapshot(client, input, options);
          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode
          });
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
          return snapshot;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async getCurrent(key) {
        const result = await pool.query<{ id: string }>(
          `SELECT snapshot.id
           FROM snapshots snapshot
           JOIN characters root ON root.id = snapshot.root_character_id
           JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
             AND run.status = 'complete'
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters suppression
               WHERE suppression.region = root.region
                 AND suppression.realm_slug = root.realm_slug
                 AND suppression.normalized_name = root.normalized_name
                 AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
             )
           ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
           LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0] ? loadSnapshot(pool, result.rows[0].id) : null;
      },

      async find(id) {
        return loadSnapshot(pool, id);
      },

      async listHistory(key, page): Promise<SnapshotHistoryPage> {
        if (
          !Number.isInteger(page.limit) ||
          page.limit < 1 ||
          page.limit > 100
        ) {
          throw new RangeError("history_limit_out_of_range");
        }
        const cursor = page.cursor ? decodeCursor(page.cursor) : null;
        const values: unknown[] = [key.region, key.realm, key.name];
        let cursorClause = "";
        if (cursor) {
          values.push(cursor.refreshedAt, cursor.id);
          cursorClause =
            "AND (snapshot.refreshed_at, snapshot.id) < ($4::timestamptz, $5::uuid)";
        }
        values.push(page.limit + 1);
        const limitParameter = `$${values.length}`;
        const result = await pool.query<{
          id: string;
          refreshed_at: Date;
          state: SnapshotHistoryItem["state"];
          character_count: string;
        }>(
          `SELECT
             snapshot.id,
             snapshot.refreshed_at,
             snapshot.state,
             (
               SELECT count(*)
               FROM snapshot_characters membership
               JOIN characters member ON member.id = membership.character_id
               WHERE membership.snapshot_id = snapshot.id
                 AND NOT EXISTS (
                   SELECT 1 FROM suppressed_characters member_suppression
                   WHERE member_suppression.region = member.region
                     AND member_suppression.realm_slug = member.realm_slug
                     AND member_suppression.normalized_name = member.normalized_name
                     AND (member_suppression.expires_at IS NULL OR member_suppression.expires_at > now())
                 )
             ) AS character_count
           FROM snapshots snapshot
           JOIN characters root ON root.id = snapshot.root_character_id
           JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
             AND run.status = 'complete'
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters root_suppression
               WHERE root_suppression.region = root.region
                 AND root_suppression.realm_slug = root.realm_slug
                 AND root_suppression.normalized_name = root.normalized_name
                 AND (root_suppression.expires_at IS NULL OR root_suppression.expires_at > now())
             )
             ${cursorClause}
           ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
           LIMIT ${limitParameter}`,
          values
        );
        const hasMore = result.rows.length > page.limit;
        const items = result.rows.slice(0, page.limit).map((row) => ({
          id: row.id,
          refreshedAt: row.refreshed_at,
          state: row.state,
          characterCount: Number(row.character_count)
        }));
        return {
          items,
          nextCursor: hasMore ? encodeCursor(items.at(-1)!) : null
        };
      }
    },

    suppressions: {
      async suppress(key, reason, expiresAt) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockRoot(client, key);
          await client.query(
            `INSERT INTO suppressed_characters
              (region, realm_slug, normalized_name, reason, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET
               suppressed_at = now(),
               reason = EXCLUDED.reason,
               expires_at = EXCLUDED.expires_at`,
            [key.region, key.realm, key.name, reason, expiresAt]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async isActive(key, at = new Date()) {
        const result = await pool.query(
          `SELECT 1 FROM suppressed_characters
           WHERE region = $1
             AND realm_slug = $2
             AND normalized_name = $3
             AND (expires_at IS NULL OR expires_at > $4)
           LIMIT 1`,
          [key.region, key.realm, key.name, at]
        );
        return result.rowCount === 1;
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          `DELETE FROM suppressed_characters
           WHERE expires_at IS NOT NULL AND expires_at <= $1`,
          [at]
        );
        return result.rowCount ?? 0;
      }
    },

    rateLimits: {
      async reserve(callerBucketHash, limit, expiresAt, at = new Date()) {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new RangeError("rate_limit_out_of_range");
        }
        if (expiresAt <= at) {
          throw new RangeError("rate_limit_expiry_out_of_range");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 1))",
            [callerBucketHash]
          );
          const usage = await client.query<{
            count: string;
            retry_at: Date | null;
          }>(
            `SELECT count(*)::text AS count, min(expires_at) AS retry_at
             FROM rate_limit_events
             WHERE caller_bucket_hash = $1 AND expires_at > $2`,
            [callerBucketHash, at]
          );
          if (Number(usage.rows[0]!.count) >= limit) {
            await client.query("COMMIT");
            return {
              allowed: false,
              retryAt: usage.rows[0]!.retry_at
            };
          }
          await client.query(
            `INSERT INTO rate_limit_events (caller_bucket_hash, expires_at)
             VALUES ($1, $2)`,
            [callerBucketHash, expiresAt]
          );
          await client.query("COMMIT");
          return { allowed: true, retryAt: null };
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async record(callerBucketHash, expiresAt) {
        await pool.query(
          `INSERT INTO rate_limit_events (caller_bucket_hash, expires_at)
           VALUES ($1, $2)`,
          [callerBucketHash, expiresAt]
        );
      },

      async countActive(callerBucketHash, at = new Date()) {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM rate_limit_events
           WHERE caller_bucket_hash = $1 AND expires_at > $2`,
          [callerBucketHash, at]
        );
        return Number(result.rows[0]!.count);
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          "DELETE FROM rate_limit_events WHERE expires_at <= $1",
          [at]
        );
        return result.rowCount ?? 0;
      }
    },

    fingerprintSweeps: {
      async requestAdmission(input): Promise<FingerprintAdmission> {
        assertFingerprintAdmissionInput(input);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);

          const existingAdmission = await client.query<{
            reservation_id: string;
            request_cap: number;
          }>(
            `SELECT reservation.id AS reservation_id, reservation.request_cap
             FROM fingerprint_sweep_admissions admission
             JOIN fingerprint_sweep_reservations reservation
               ON reservation.admission_id = admission.id
             WHERE admission.discovery_run_id = $1
               AND admission.status = 'admitted'
               AND reservation.released_at IS NULL
             ORDER BY admission.requested_at DESC
             LIMIT 1
             FOR UPDATE OF admission, reservation`,
            [input.runId]
          );
          const existing = existingAdmission.rows[0];
          if (existing) {
            await client.query("COMMIT");
            return {
              kind: "admitted",
              reservationId: existing.reservation_id,
              requestCap: existing.request_cap
            };
          }

          const state = await client.query<{ last_published_at: Date | null }>(
            `SELECT last_published_at
             FROM fingerprint_sweep_states
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [input.key.region, input.key.realm, input.key.name]
          );
          if (
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > input.cadenceCutoff
          ) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET status = 'not_due'
               WHERE discovery_run_id = $1 AND status = 'waiting'`,
              [input.runId]
            );
            await client.query("COMMIT");
            return { kind: "not_due" };
          }

          const waiting = await client.query<{ id: string }>(
            `SELECT id
             FROM fingerprint_sweep_admissions
             WHERE discovery_run_id = $1 AND status = 'waiting'
             ORDER BY requested_at, queue_order
             LIMIT 1
             FOR UPDATE`,
            [input.runId]
          );
          let admissionId = waiting.rows[0]?.id;
          if (admissionId) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET request_cap = $2, hourly_budget = $3, cadence_cutoff = $4
               WHERE id = $1`,
              [
                admissionId,
                input.requestCap,
                input.hourlyBudget,
                input.cadenceCutoff
              ]
            );
          } else {
            const admission = await client.query<{ id: string }>(
              `INSERT INTO fingerprint_sweep_admissions
                (discovery_run_id, region, realm_slug, normalized_name, request_cap,
                 hourly_budget, cadence_cutoff, requested_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               RETURNING id`,
              [
                input.runId,
                input.key.region,
                input.key.realm,
                input.key.name,
                input.requestCap,
                input.hourlyBudget,
                input.cadenceCutoff,
                input.at
              ]
            );
            admissionId = admission.rows[0]!.id;
          }

          const result = await admitFingerprintWaitingRun(
            client,
            admissionId,
            input.at
          );
          if (result.kind === "waiting") {
            const deferred = await client.query(
              `UPDATE discovery_runs
               SET status = 'queued', attempt = greatest(attempt - 1, 0),
                   next_retry_at = NULL
               WHERE id = $1 AND status IN ('running', 'queued')`,
              [input.runId]
            );
            if (deferred.rowCount !== 1) {
              throw new Error("fingerprint_waiting_run_not_running");
            }
          }
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async recordRequest(reservationId, count, at) {
        if (!Number.isInteger(count) || count < 1) {
          throw new RangeError("fingerprint_request_count_out_of_range");
        }
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_request_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          const result = await client.query(
            `UPDATE fingerprint_sweep_reservations
             SET used_count = used_count + $2
             WHERE id = $1
               AND released_at IS NULL
               AND expires_at > $3
               AND used_count + $2 <= request_cap
             RETURNING id`,
            [reservationId, count, at]
          );
          if (result.rowCount !== 1) {
            throw new Error("fingerprint_reservation_not_active");
          }
          await client.query(
            `INSERT INTO fingerprint_sweep_request_events (reservation_id, requested_at)
             SELECT $1, $3::timestamptz FROM generate_series(1, $2)`,
            [reservationId, count, at]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async finish(reservationId, input) {
        if (Number.isNaN(input.at.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          await finishFingerprintSweep(client, reservationId, input);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async release(reservationId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_release_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          const result = await client.query<{ admission_id: string }>(
            `UPDATE fingerprint_sweep_reservations
             SET released_at = $2
             WHERE id = $1 AND released_at IS NULL
             RETURNING admission_id`,
            [reservationId, at]
          );
          const row = result.rows[0];
          if (!row) throw new Error("fingerprint_reservation_not_active");
          await client.query(
            `UPDATE fingerprint_sweep_admissions
             SET status = 'released'
             WHERE id = $1`,
            [row.admission_id]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async listWaiting(limit, offset = 0) {
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1_000 ||
          !Number.isInteger(offset) ||
          offset < 0
        ) {
          throw new RangeError("fingerprint_waiting_limit_out_of_range");
        }
        const result = await pool.query<{ discovery_run_id: string }>(
          `SELECT discovery_run_id
           FROM fingerprint_sweep_admissions
           WHERE status = 'waiting'
           ORDER BY requested_at, queue_order
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        return result.rows.map((row) => row.discovery_run_id);
      },

      async listAdmittedUndispatched(limit) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError(
            "fingerprint_admission_dispatch_limit_out_of_range"
          );
        }
        const result = await pool.query<{ discovery_run_id: string }>(
          `SELECT discovery_run_id
           FROM fingerprint_sweep_admissions
           WHERE status = 'admitted' AND dispatched_at IS NULL
           ORDER BY requested_at, queue_order
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => row.discovery_run_id);
      },

      async markDispatched(runId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_admission_time_invalid");
        }
        await pool.query(
          `UPDATE fingerprint_sweep_admissions
           SET dispatched_at = $2
           WHERE discovery_run_id = $1
             AND status = 'admitted'
             AND dispatched_at IS NULL`,
          [runId, at]
        );
      },

      async admitWaiting(runId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_admission_time_invalid");
        }
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockFingerprintSweeps(client);
          const waiting = await client.query<{
            id: string;
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
            cadence_cutoff: Date;
          }>(
            `SELECT id, region, realm_slug, normalized_name, cadence_cutoff
             FROM fingerprint_sweep_admissions
             WHERE discovery_run_id = $1 AND status = 'waiting'
             ORDER BY requested_at, queue_order
             LIMIT 1
             FOR UPDATE`,
            [runId]
          );
          const admission = waiting.rows[0];
          if (!admission) {
            await client.query("COMMIT");
            return { kind: "settled" };
          }

          const state = await client.query<{ last_published_at: Date | null }>(
            `SELECT last_published_at
             FROM fingerprint_sweep_states
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [admission.region, admission.realm_slug, admission.normalized_name]
          );
          if (
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > admission.cadence_cutoff
          ) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET status = 'not_due'
               WHERE id = $1`,
              [admission.id]
            );
            await client.query("COMMIT");
            return { kind: "not_due" };
          }

          const result = await admitFingerprintWaitingRun(
            client,
            admission.id,
            at
          );
          await client.query("COMMIT");
          return result.kind === "admitted" ? { kind: "admitted" } : result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }
    },

    negativeCache: {
      async put(key, expiresAt) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await lockRoot(client, key);
          await client.query(
            `INSERT INTO negative_character_cache
              (region, realm_slug, normalized_name, expires_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = now()`,
            [key.region, key.realm, key.name, expiresAt]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async putAndFailRun(key, expiresAt, runId, options) {
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, key);
          const cacheResult = await client.query(
            `INSERT INTO negative_character_cache
              (region, realm_slug, normalized_name, expires_at)
             SELECT $1, $2, $3, $4
             WHERE EXISTS (
               SELECT 1 FROM discovery_runs
               WHERE id = $5 AND status IN ${activeRunSql}
             )
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = now()
             RETURNING normalized_name`,
            [key.region, key.realm, key.name, expiresAt, runId]
          );
          if (cacheResult.rowCount !== 1) {
            throw new Error("discovery_run_not_active");
          }
          options?.signal?.throwIfAborted();
          const failure = await client.query(
            `UPDATE discovery_runs
             SET status = 'failed', error_code = 'character_not_found',
                 completed_at = now(), next_retry_at = NULL
             WHERE id = $1 AND status IN ${activeRunSql}`,
            [runId]
          );
          if (failure.rowCount !== 1) {
            throw new Error("discovery_run_not_active");
          }
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },

      async find(key, at = new Date()) {
        const result = await pool.query<{ expires_at: Date }>(
          `SELECT expires_at FROM negative_character_cache
           WHERE region = $1
             AND realm_slug = $2
             AND normalized_name = $3
             AND expires_at > $4`,
          [key.region, key.realm, key.name, at]
        );
        return result.rows[0]
          ? { key, expiresAt: result.rows[0].expires_at }
          : null;
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          "DELETE FROM negative_character_cache WHERE expires_at <= $1",
          [at]
        );
        return result.rowCount ?? 0;
      }
    }
  };
}
