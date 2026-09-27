import type { CharacterGuild, CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import { lockFingerprintSweeps } from "./locks";
import type {
  FingerprintAdmission,
  FingerprintContinuationAdmission,
  Repositories
} from "./repositories";
import { type Queryable, one, withTransaction } from "./sql";

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
  at: Date,
  // A continuation already skipped the cadence gate in requestAdmission; this
  // keeps that exemption scoped to only its own admission row when the
  // (global, cross-run) head-of-queue candidate is picked here.
  bypassCadenceFor?: string
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
         OR admission.id = $1
       )
     ORDER BY admission.requested_at, admission.queue_order
     LIMIT 1
     FOR UPDATE OF admission`,
    [bypassCadenceFor ?? null]
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
    Number(one(usage).commitment) + candidate.request_cap >
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
    reservationId: one(reservation).id,
    requestCap: candidate.request_cap,
    committedRequests: Number(one(usage).commitment) + candidate.request_cap,
    hourlyBudget: candidate.hourly_budget
  };
}

function historicalGuildsFromDatabase(
  value: unknown
): readonly CharacterGuild[] {
  if (!Array.isArray(value)) return [];
  const guilds = new Map<string, CharacterGuild>();
  for (const guild of value as unknown[]) {
    if (
      typeof guild !== "object" ||
      guild === null ||
      !("name" in guild) ||
      !("region" in guild) ||
      !("realm" in guild) ||
      typeof guild.name !== "string" ||
      typeof guild.realm !== "string" ||
      !["us", "eu", "kr", "tw"].includes(String(guild.region))
    ) {
      continue;
    }
    const normalized = {
      name: guild.name,
      region: guild.region as CharacterKey["region"],
      realm: guild.realm
    };
    guilds.set(
      `${normalized.region}/${normalized.realm}/${normalized.name}`,
      normalized
    );
  }
  return [...guilds.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, guild]) => guild);
}

export async function finishFingerprintSweep(
  client: PoolClient,
  reservationId: string,
  input: {
    published: boolean;
    at: Date;
    limitationCode: string | null;
    continuationAdmission?: FingerprintContinuationAdmission | undefined;
    /**
     * Omitted by a caller that has no claim on the sweep cursor. The resume
     * columns are then left exactly as they are, so finishing one reservation
     * cannot wipe a cursor belonging to a chain it knows nothing about.
     */
    cursor?: {
      resumeAfter: string | null;
      resumeLimitationCode: string | null;
      historicalGuilds?: readonly CharacterGuild[] | undefined;
      resumeSnapshotId: string | null;
      advanced: boolean;
    };
  }
): Promise<void> {
  const reservation = await client.query<{
    admission_id: string;
    discovery_run_id: string;
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
     RETURNING reservation.admission_id, admission.discovery_run_id,
               admission.region,
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
  if (!input.published) return;
  const cursor = input.cursor;
  if (!cursor) {
    await client.query(
      `INSERT INTO fingerprint_sweep_states
        (region, realm_slug, normalized_name, last_published_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET
         last_published_at = greatest(
           fingerprint_sweep_states.last_published_at,
           EXCLUDED.last_published_at
         )`,
      [row.region, row.realm_slug, row.normalized_name, input.at]
    );
    return;
  }
  await client.query(
    `INSERT INTO fingerprint_sweep_states
      (region, realm_slug, normalized_name, last_published_at,
       resume_after, resume_limitation_code, resume_historical_guilds,
       resume_snapshot_id,
       continuation_failures)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 0)
     ON CONFLICT (region, realm_slug, normalized_name)
     DO UPDATE SET
       last_published_at = greatest(
         fingerprint_sweep_states.last_published_at,
         EXCLUDED.last_published_at
       ),
       resume_after = EXCLUDED.resume_after,
       resume_limitation_code = EXCLUDED.resume_limitation_code,
       resume_historical_guilds = EXCLUDED.resume_historical_guilds,
       resume_snapshot_id = EXCLUDED.resume_snapshot_id,
       continuation_failures = CASE
         WHEN $9 THEN 0
         ELSE fingerprint_sweep_states.continuation_failures
       END`,
    [
      row.region,
      row.realm_slug,
      row.normalized_name,
      input.at,
      cursor.resumeAfter,
      cursor.resumeLimitationCode,
      cursor.resumeAfter === null
        ? null
        : JSON.stringify(cursor.historicalGuilds ?? []),
      cursor.resumeSnapshotId,
      cursor.advanced
    ]
  );
  if (cursor.resumeAfter !== null && input.continuationAdmission) {
    const continuation = input.continuationAdmission;
    await client.query(
      `INSERT INTO fingerprint_sweep_admissions
        (discovery_run_id, region, realm_slug, normalized_name, request_cap,
         hourly_budget, cadence_cutoff, requested_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
       WHERE NOT EXISTS (
         SELECT 1 FROM fingerprint_sweep_admissions
         WHERE discovery_run_id = $1 AND status IN ('waiting', 'admitted')
       )`,
      [
        row.discovery_run_id,
        row.region,
        row.realm_slug,
        row.normalized_name,
        continuation.requestCap,
        continuation.hourlyBudget,
        continuation.cadenceCutoff,
        input.at
      ]
    );
  }
}

/**
 * Inserts a `waiting` admission for each chain that has a live cursor and no
 * live admission, optionally only the one `runId` owns. A live admission is
 * one still waiting, or admitted with a reservation that is neither released
 * nor expired. The caller holds the fingerprint lock, so two callers cannot
 * both find a chain bare and queue it twice.
 *
 * The caps come from the run's previous admission, which every chain has:
 * the cursor is only ever written by an admitted cycle. `cadence_cutoff` is
 * set to the admission time, so the row passes the cadence filter everywhere
 * -- a continuation finishes a sweep in progress and was never cadence-gated.
 */
async function requeueContinuations(
  client: Queryable,
  input: {
    at: Date;
    runId: string | null;
    maxFailures: number | null;
    limit: number;
  }
): Promise<readonly string[]> {
  const result = await client.query<{ discovery_run_id: string }>(
    `INSERT INTO fingerprint_sweep_admissions
      (discovery_run_id, region, realm_slug, normalized_name, request_cap,
       hourly_budget, cadence_cutoff, requested_at)
     SELECT snapshot.discovery_run_id, state.region, state.realm_slug,
            state.normalized_name, previous.request_cap,
            previous.hourly_budget, $1, $1
     FROM fingerprint_sweep_states state
     JOIN snapshots snapshot ON snapshot.id = state.resume_snapshot_id
     CROSS JOIN LATERAL (
       SELECT request_cap, hourly_budget
       FROM fingerprint_sweep_admissions
       WHERE discovery_run_id = snapshot.discovery_run_id
       ORDER BY requested_at DESC, queue_order DESC
       LIMIT 1
     ) previous
     WHERE state.resume_after IS NOT NULL
       AND ($2::uuid IS NULL OR snapshot.discovery_run_id = $2::uuid)
       AND ($3::integer IS NULL OR state.continuation_failures < $3::integer)
       AND NOT EXISTS (
         SELECT 1
         FROM fingerprint_sweep_admissions live
         LEFT JOIN fingerprint_sweep_reservations reservation
           ON reservation.admission_id = live.id
         WHERE live.discovery_run_id = snapshot.discovery_run_id
           AND (
             live.status = 'waiting'
             OR (
               live.status = 'admitted'
               AND reservation.released_at IS NULL
               AND reservation.expires_at > $1
             )
           )
       )
     ORDER BY state.last_published_at, snapshot.discovery_run_id
     LIMIT $4
     RETURNING discovery_run_id`,
    [input.at, input.runId, input.maxFailures, input.limit]
  );
  return result.rows.map((row) => row.discovery_run_id);
}

export function createFingerprintSweepRepositories(
  pool: Pool
): Pick<Repositories, "fingerprintSweeps"> {
  return {
    fingerprintSweeps: {
      async isDueForVisit(key, cadenceCutoff) {
        const result = await pool.query<{
          last_published_at: Date | null;
          resume_after: string | null;
        }>(
          `SELECT last_published_at, resume_after
           FROM fingerprint_sweep_states
           WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        const state = result.rows[0];
        // No row means this character has never published a sweep.
        if (!state) return true;
        return (
          state.resume_after === null &&
          (state.last_published_at === null ||
            state.last_published_at <= cadenceCutoff)
        );
      },

      async requestAdmission(input): Promise<FingerprintAdmission> {
        assertFingerprintAdmissionInput(input);
        return withTransaction(pool, async (client) => {
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
            !input.continuation &&
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > input.cadenceCutoff
          ) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET status = 'not_due'
               WHERE discovery_run_id = $1 AND status = 'waiting'`,
              [input.runId]
            );
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
            admissionId = one(admission).id;
          }

          const result = await admitFingerprintWaitingRun(
            client,
            admissionId,
            input.at,
            input.continuation ? admissionId : undefined
          );
          // A continuation's run was completed by cycle 1 and must stay
          // complete: it has already published its snapshot, and reverting it
          // to `queued` both fails (no row matches) and would lie about a
          // finished dossier. Deferral for a continuation is carried entirely
          // by the re-enqueued admission job, not by the run's status.
          if (result.kind === "waiting" && !input.continuation) {
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
          return result;
        });
      },

      async recordRequest(reservationId, count, at) {
        if (!Number.isInteger(count) || count < 1) {
          throw new RangeError("fingerprint_request_count_out_of_range");
        }
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_request_time_invalid");
        }
        return withTransaction(pool, async (client) => {
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
        });
      },

      async finish(reservationId, input) {
        if (Number.isNaN(input.at.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        return withTransaction(pool, async (client) => {
          await lockFingerprintSweeps(client);
          // No cursor argument: this caller finishes a reservation without any
          // knowledge of the sweep chain, so it must not clear a cursor it does
          // not own. Only the create/amend paths, which computed the cursor
          // themselves, may write those columns.
          await finishFingerprintSweep(client, reservationId, input);
        });
      },

      async release(reservationId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_release_time_invalid");
        }
        return withTransaction(pool, async (client) => {
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
        });
      },

      async getResumeState(key) {
        const result = await pool.query<{
          resume_after: string | null;
          resume_limitation_code: string | null;
          resume_historical_guilds: unknown;
          resume_snapshot_id: string | null;
          discovery_run_id: string | null;
        }>(
          `SELECT state.resume_after, state.resume_limitation_code,
                  state.resume_historical_guilds,
                  state.resume_snapshot_id, snapshot.discovery_run_id
           FROM fingerprint_sweep_states state
           LEFT JOIN snapshots snapshot
             ON snapshot.id = state.resume_snapshot_id
           WHERE state.region = $1
             AND state.realm_slug = $2
             AND state.normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        const row = result.rows[0];
        // `discovery_run_id` names the only run allowed to continue this chain.
        // Without it the cursor points at nothing amendable, so it reads as no
        // cursor at all rather than as a continuation nobody owns.
        if (!row?.resume_after || !row.resume_snapshot_id) return null;
        if (!row.discovery_run_id) return null;
        return {
          resumeAfter: row.resume_after,
          snapshotId: row.resume_snapshot_id,
          runId: row.discovery_run_id,
          limitationCode: row.resume_limitation_code,
          historicalGuilds: historicalGuildsFromDatabase(
            row.resume_historical_guilds
          )
        };
      },

      async recordContinuationFailure(key) {
        const result = await pool.query<{ continuation_failures: number }>(
          `UPDATE fingerprint_sweep_states
           SET continuation_failures = continuation_failures + 1
           WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
           RETURNING continuation_failures`,
          [key.region, key.realm, key.name]
        );
        // No state row means no cursor to be stuck on, so nothing to bound.
        return Number(result.rows[0]?.continuation_failures ?? 0);
      },

      async requeueContinuation(runId, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_admission_time_invalid");
        }
        return withTransaction(pool, async (client) => {
          await lockFingerprintSweeps(client);
          // The caller is the cycle that ended, so a reservation the run still
          // holds is its own: one whose release failed, or one a cycle with no
          // sweep configured never used. Left held, it would count as a live
          // admission and keep the next cycle from being queued.
          await client.query(
            `WITH released AS (
               UPDATE fingerprint_sweep_reservations reservation
               SET released_at = $2
               FROM fingerprint_sweep_admissions admission
               WHERE reservation.admission_id = admission.id
                 AND admission.discovery_run_id = $1
                 AND admission.status = 'admitted'
                 AND reservation.released_at IS NULL
               RETURNING reservation.admission_id
             )
             UPDATE fingerprint_sweep_admissions
             SET status = 'released'
             WHERE id IN (SELECT admission_id FROM released)`,
            [runId, at]
          );
          const queued = await requeueContinuations(client, {
            at,
            runId,
            maxFailures: null,
            limit: 1
          });
          return queued.length > 0;
        });
      },

      async requeueStrandedContinuations({ at, maxFailures, limit }) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_admission_time_invalid");
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError("fingerprint_stranded_limit_out_of_range");
        }
        if (!Number.isInteger(maxFailures) || maxFailures < 1) {
          throw new RangeError("fingerprint_stranded_failures_out_of_range");
        }
        return withTransaction(pool, async (client) => {
          await lockFingerprintSweeps(client);
          return requeueContinuations(client, {
            at,
            runId: null,
            maxFailures,
            limit
          });
        });
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
        return withTransaction(pool, async (client) => {
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
            return { kind: "settled" };
          }

          const state = await client.query<{
            last_published_at: Date | null;
            resume_after: string | null;
            discovery_run_id: string | null;
          }>(
            `SELECT state.last_published_at, state.resume_after,
                    snapshot.discovery_run_id
             FROM fingerprint_sweep_states state
             LEFT JOIN snapshots snapshot ON snapshot.id = state.resume_snapshot_id
             WHERE state.region = $1 AND state.realm_slug = $2
               AND state.normalized_name = $3`,
            [admission.region, admission.realm_slug, admission.normalized_name]
          );
          const liveContinuation =
            state.rows[0]?.resume_after !== null &&
            state.rows[0]?.discovery_run_id === runId;
          if (
            !liveContinuation &&
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > admission.cadence_cutoff
          ) {
            await client.query(
              `UPDATE fingerprint_sweep_admissions
               SET status = 'not_due'
               WHERE id = $1`,
              [admission.id]
            );
            return { kind: "not_due" };
          }

          const result = await admitFingerprintWaitingRun(
            client,
            admission.id,
            at,
            liveContinuation ? admission.id : undefined
          );
          return result.kind === "admitted" ? { kind: "admitted" } : result;
        });
      },

      async cleanupExpired(at = new Date()) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("fingerprint_cleanup_time_invalid");
        }
        // Each physical Blizzard request leaves one row, so the table would
        // grow by the whole hourly budget every hour. A request stops counting
        // towards the rolling hour once its own timestamp leaves the window, so
        // prune on requested_at: deleting by reservation would drop events the
        // admission accounting still has to see.
        const result = await pool.query(
          `DELETE FROM fingerprint_sweep_request_events
           WHERE requested_at <= $1::timestamptz - interval '1 hour'`,
          [at]
        );
        return result.rowCount ?? 0;
      }
    }
  };
}
