import type { CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import { lockCharacterEvidence } from "../locks";
import {
  type EvidenceRunRow,
  evidenceRunColumns,
  mapEvidenceRun,
  parsePerformanceValues
} from "../mappers";
import type {
  CharacterEvidenceRun,
  EvidenceCollectionDomain,
  EvidenceMonitorPhase,
  EvidenceReservationResult,
  EvidenceRunMode,
  EvidenceRunPhase,
  HistoricAliasScanProgress,
  Repositories,
  StagedEvidenceCollection,
  StoredCharacterMythicKill,
  StoredEvidenceGuild,
  StoredRankedBackfillCursor
} from "../repositories";
import { one, withTransaction } from "../sql";
import {
  CURRENT_COLLECTION_VERSIONS,
  CURRENT_EVIDENCE_VERSION,
  isEvidenceFresh
} from "./freshness";
import {
  loadCompletedEvidence,
  loadLatestTierSearchKills,
  loadPositiveEvidenceForPartial,
  loadStoredPerformanceByFightUrl,
  loadStoredTierBestParses
} from "./load";
import { mergePublishedEvidence } from "./merge";
import { insertEvidenceRows, performanceColumns } from "./rows";

/**
 * The distinct guilds a character's stored kills were in. A guild is in the
 * character's own region; rows from before #427 carry no region of their own.
 */
function storedEvidenceGuilds(
  kills: readonly StoredCharacterMythicKill[],
  region: CharacterKey["region"]
): readonly StoredEvidenceGuild[] {
  const guilds = new Map<string, StoredEvidenceGuild>();
  for (const kill of kills) {
    const guild = kill.guild;
    if (!guild || guild.name.length === 0 || guild.realm.length === 0) continue;
    const item = { name: guild.name, realm: guild.realm, region };
    guilds.set(`${item.realm}\u0000${item.name}`, item);
  }
  return [...guilds.values()];
}

/** A changed alias makes every old kill-tier conclusion and scan cursor stale. */
async function invalidateHistoricAliasKillScan(
  client: PoolClient,
  key: CharacterKey
): Promise<void> {
  const values = [key.region, key.realm, key.name];
  await client.query(
    `DELETE FROM character_terminal_tiers
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        AND domain = 'kills'`,
    values
  );
  await client.query(
    `UPDATE character_evidence_runs
        SET kill_scan_completed_at = NULL,
            kill_scan_resume_page = NULL,
            kill_scan_resume_boundary_report_code = NULL,
            historic_alias_progress = NULL
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        AND status IN ('complete', 'partial')`,
    values
  );
  await client.query(
    `DELETE FROM character_attendance_searches
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
    values
  );
}

async function requestHistoricAliasRecollection(
  client: PoolClient,
  key: CharacterKey
): Promise<void> {
  await client.query(
    `INSERT INTO character_alias_recollections
       (region, realm_slug, normalized_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (region, realm_slug, normalized_name)
     DO UPDATE SET requested_at = now()`,
    [key.region, key.realm, key.name]
  );
}

export function createEvidenceRepositories(
  pool: Pool
): Pick<Repositories, "evidence"> {
  return {
    evidence: {
      async historicAliases(key) {
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `SELECT alias.region, alias.realm_slug, alias.normalized_name
             FROM character_historic_aliases alias
             JOIN characters character ON character.id = alias.character_id
            WHERE character.region = $1 AND character.realm_slug = $2
              AND character.normalized_name = $3
            ORDER BY alias.created_at, alias.region, alias.realm_slug, alias.normalized_name`,
          [key.region, key.realm, key.name]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },
      async addHistoricAlias(key, alias) {
        return withTransaction(pool, async (client) => {
          await lockCharacterEvidence(client, key);
          const result = await client.query(
            `INSERT INTO character_historic_aliases
               (character_id, region, realm_slug, normalized_name)
             SELECT id, $4, $5, $6 FROM characters
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
             ON CONFLICT DO NOTHING RETURNING character_id`,
            [
              key.region,
              key.realm,
              key.name,
              alias.region,
              alias.realm,
              alias.name
            ]
          );
          if (result.rowCount === 1) {
            await invalidateHistoricAliasKillScan(client, key);
            await requestHistoricAliasRecollection(client, key);
          }
          const exists =
            result.rowCount === 1
              ? true
              : (
                  await client.query(
                    `SELECT 1 FROM characters WHERE region = $1
                  AND realm_slug = $2 AND normalized_name = $3`,
                    [key.region, key.realm, key.name]
                  )
                ).rowCount === 1;
          return result.rowCount === 1
            ? "added"
            : exists
              ? "duplicate"
              : "missing";
        });
      },
      async removeHistoricAlias(key, alias) {
        return withTransaction(pool, async (client) => {
          await lockCharacterEvidence(client, key);
          const result = await client.query(
            `DELETE FROM character_historic_aliases alias USING characters character
              WHERE alias.character_id = character.id
                AND character.region = $1 AND character.realm_slug = $2
                AND character.normalized_name = $3
                AND alias.region = $4 AND alias.realm_slug = $5
                AND alias.normalized_name = $6`,
            [
              key.region,
              key.realm,
              key.name,
              alias.region,
              alias.realm,
              alias.name
            ]
          );
          if (result.rowCount === 1) {
            await invalidateHistoricAliasKillScan(client, key);
            await requestHistoricAliasRecollection(client, key);
          }
          return result.rowCount === 1 ? "removed" : "missing";
        });
      },
      async reserve({
        key,
        freshnessCutoff,
        at,
        credentials,
        phasePlan,
        lightRefresh
      }) {
        if (
          Number.isNaN(freshnessCutoff.valueOf()) ||
          Number.isNaN(at.valueOf())
        ) {
          throw new RangeError("character_evidence_reservation_time_invalid");
        }
        return withTransaction(pool, async (client) => {
          await lockCharacterEvidence(client, key);
          const aliasRecollection = await client.query(
            `SELECT 1 FROM character_alias_recollections
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
            [key.region, key.realm, key.name]
          );
          const aliasRecollectionPending = aliasRecollection.rowCount === 1;
          const completed = await loadCompletedEvidence(client, key);
          // Asked before the freshness check, not after it. A refresh forces a
          // run past the freshness window, so a caller reading fresh evidence
          // can be looking at a character that is being re-collected right now
          // -- and it has no other way to find that out.
          const active = await client.query<EvidenceRunRow>(
            `SELECT ${evidenceRunColumns()}
             FROM character_evidence_runs
             WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
               AND status IN ('queued', 'running', 'retrying')
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          const activeRun = active.rows[0]
            ? mapEvidenceRun(active.rows[0])
            : null;
          // A capped ranked walk has already paid for its explicit tier
          // search. Its retry is continuation work, even if an unrelated
          // ordinary collection published after it. A failed attempt has no
          // publication or cursor; retain the last published cursor and back
          // off for 30 minutes after a failure so a low points balance cannot
          // create a tight retry loop.
          //
          // Every capped walk is read, not only the due ones: one that is not
          // due yet is when fresh evidence next changes, and a page stops
          // following evidence it has no such time for (#663). `due_at` is
          // the later of the walk's retry time and the failure cool-down.
          const rankedContinuations = await client.query<{
            tier_search_raid_id: string;
            due_at: Date;
          }>(
            `WITH latest AS (
               SELECT DISTINCT ON (tier_search_raid_id)
                      tier_search_raid_id, created_at, status,
                      ranked_backfill_attempted, ranked_backfill_cursor,
                      retry_after_at
                 FROM character_evidence_runs
                WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                  AND mode = 'tier_search'
                  AND status IN ('complete', 'partial')
                ORDER BY tier_search_raid_id, created_at DESC, id DESC
             )
             SELECT tier_search_raid_id,
                    GREATEST(
                      retry_after_at,
                      (SELECT MAX(failed.completed_at) + interval '30 minutes'
                         FROM character_evidence_runs failed
                        WHERE failed.region = $1 AND failed.realm_slug = $2
                          AND failed.normalized_name = $3
                          AND failed.tier_search_raid_id = latest.tier_search_raid_id
                          AND failed.mode = 'tier_search'
                          AND failed.status = 'failed'
                          AND failed.created_at > latest.created_at)
                    ) AS due_at
               FROM latest
              WHERE status = 'partial' AND ranked_backfill_attempted = true
                AND jsonb_typeof(ranked_backfill_cursor) = 'object'
                AND retry_after_at IS NOT NULL
              ORDER BY retry_after_at, tier_search_raid_id`,
            [key.region, key.realm, key.name]
          );
          const continuationRaidId =
            rankedContinuations.rows.find((row) => row.due_at <= at)
              ?.tier_search_raid_id ?? null;
          const pendingContinuations = rankedContinuations.rows
            .map((row) => row.due_at)
            .filter((dueAt) => dueAt > at);
          const tierSearchResumesAt =
            pendingContinuations.length === 0
              ? null
              : new Date(
                  Math.min(...pendingContinuations.map((due) => due.getTime()))
                );
          if (
            completed !== null &&
            completed.evidenceVersion !== undefined &&
            completed.evidenceVersion >= CURRENT_EVIDENCE_VERSION &&
            completed.run.completedAt !== null &&
            !aliasRecollectionPending &&
            continuationRaidId === null &&
            isEvidenceFresh(
              completed.run.completedAt,
              completed.run.retryAfterAt,
              freshnessCutoff,
              at
            )
          ) {
            return {
              kind: "fresh",
              run: completed.run,
              completed,
              active: activeRun,
              tierSearchResumesAt
            } satisfies EvidenceReservationResult;
          }

          if (activeRun) {
            return {
              kind: "active",
              run: activeRun,
              completed,
              active: activeRun
            } satisfies EvidenceReservationResult;
          }

          if (aliasRecollectionPending) {
            // An older active run may have re-marked stale tiers after the edit.
            // Clear them again at the reservation that will actually re-read
            // the aliases, then consume the request in the same transaction.
            await invalidateHistoricAliasKillScan(client, key);
            await client.query(
              `DELETE FROM character_alias_recollections
                WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
              [key.region, key.realm, key.name]
            );
          }

          const inserted = await client.query<EvidenceRunRow>(
            `INSERT INTO character_evidence_runs
              (region, realm_slug, normalized_name, mode, tier_search_raid_id,
               wcl_client_id_encrypted, wcl_client_secret_encrypted, account_credential_owner_id, account_credential_version,
               light_refresh)
             VALUES ($1, $2, $3,
                     CASE WHEN $4::text IS NULL THEN 'full' ELSE 'tier_search' END,
                     $4, $5, $6, $7, $8, $9)
             RETURNING ${evidenceRunColumns()}`,
            [
              key.region,
              key.realm,
              key.name,
              continuationRaidId,
              credentials && "wclClientIdEncrypted" in credentials
                ? credentials.wclClientIdEncrypted
                : null,
              credentials && "wclClientSecretEncrypted" in credentials
                ? credentials.wclClientSecretEncrypted
                : null,
              credentials && "accountId" in credentials
                ? credentials.accountId
                : null,
              credentials && "credentialVersion" in credentials
                ? credentials.credentialVersion
                : null,
              // A tier continuation is its own mode, never a light refresh.
              continuationRaidId === null && lightRefresh === true
            ]
          );
          const reservedRun = mapEvidenceRun(one(inserted));
          if (phasePlan && phasePlan.length > 0) {
            await client.query(
              `INSERT INTO character_evidence_run_phases
                 (run_id, phase_id, ordinal, state)
               SELECT $1, item.phase_id, item.ordinal, 'pending'
                 FROM unnest($2::text[]) WITH ORDINALITY
                   AS item(phase_id, ordinal)`,
              [reservedRun.id, phasePlan]
            );
          }
          return {
            kind: "reserved",
            run: reservedRun,
            completed,
            active: reservedRun,
            completedVersionCurrent:
              completed?.evidenceVersion !== undefined &&
              completed.evidenceVersion >= CURRENT_EVIDENCE_VERSION
          } satisfies EvidenceReservationResult;
        });
      },

      async latestTierSearches(keys, since) {
        if (Number.isNaN(since.valueOf())) {
          throw new RangeError("character_evidence_tier_search_time_invalid");
        }
        if (keys.length === 0) return [];
        const result = await pool.query<{
          id: string;
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
          tier_search_raid_id: string;
          status: CharacterEvidenceRun["status"];
          created_at: Date;
        }>(
          `SELECT DISTINCT ON (runs.region, runs.realm_slug,
                              runs.normalized_name, runs.tier_search_raid_id)
                  runs.id, runs.region, runs.realm_slug, runs.normalized_name,
                  runs.tier_search_raid_id, runs.status, runs.created_at
             FROM character_evidence_runs runs
             JOIN unnest($1::text[], $2::text[], $3::text[])
                    AS keys(region, realm_slug, normalized_name)
               ON runs.region = keys.region
              AND runs.realm_slug = keys.realm_slug
              AND runs.normalized_name = keys.normalized_name
            WHERE runs.mode = 'tier_search' AND runs.created_at >= $4
            ORDER BY runs.region, runs.realm_slug, runs.normalized_name,
                     runs.tier_search_raid_id, runs.created_at DESC,
                     runs.id DESC`,
          [
            keys.map((key) => key.region),
            keys.map((key) => key.realm),
            keys.map((key) => key.name),
            since
          ]
        );
        return result.rows.map((row) => ({
          key: {
            region: row.region,
            realm: row.realm_slug,
            name: row.normalized_name
          },
          raidId: row.tier_search_raid_id,
          status: row.status,
          createdAt: row.created_at,
          runId: row.id
        }));
      },

      async withCompletedEvidence(keys) {
        if (keys.length === 0) return [];
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `SELECT keys.region, keys.realm_slug, keys.normalized_name
             FROM unnest($1::text[], $2::text[], $3::text[])
                    WITH ORDINALITY AS keys(region, realm_slug, normalized_name, ordinal)
            WHERE EXISTS (
                    SELECT 1 FROM character_evidence_runs runs
                     WHERE runs.region = keys.region
                       AND runs.realm_slug = keys.realm_slug
                       AND runs.normalized_name = keys.normalized_name
                       AND runs.status IN ('complete', 'partial'))
            ORDER BY keys.ordinal`,
          [
            keys.map((key) => key.region),
            keys.map((key) => key.realm),
            keys.map((key) => key.name)
          ]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },

      async reserveTierSearch({
        key,
        raidId,
        at,
        searchedSince,
        phasePlan,
        credentials
      }) {
        if (
          Number.isNaN(at.valueOf()) ||
          Number.isNaN(searchedSince.valueOf())
        ) {
          throw new RangeError("character_evidence_reservation_time_invalid");
        }
        if (raidId.length === 0) {
          throw new RangeError("character_evidence_tier_search_raid_invalid");
        }
        return withTransaction(pool, async (client) => {
          await lockCharacterEvidence(client, key);
          const columns = evidenceRunColumns();
          // One run per character at a time, whatever its mode: the unique
          // index says so, and a search joining an ordinary run would quietly
          // search nothing.
          const active = await client.query<EvidenceRunRow>(
            `SELECT ${columns}
               FROM character_evidence_runs
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                AND status IN ('queued', 'running', 'retrying')
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          if (active.rows[0]) {
            return { kind: "active", run: mapEvidenceRun(active.rows[0]) };
          }
          // Whatever became of it: a search that failed or found nothing was
          // still paid for, and repeating it on the next click is exactly the
          // spend the limit exists to stop.
          const recent = await client.query<EvidenceRunRow>(
            `SELECT ${columns}
               FROM character_evidence_runs
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                AND mode = 'tier_search' AND tier_search_raid_id = $4
                AND created_at >= $5
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [key.region, key.realm, key.name, raidId, searchedSince]
          );
          if (recent.rows[0]) {
            return { kind: "recent", run: mapEvidenceRun(recent.rows[0]) };
          }
          // A tier search adds to evidence the character already has. With
          // none, the ordinary collection has to run first.
          const completed = await client.query(
            `SELECT 1 FROM character_evidence_runs
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                AND status IN ('complete', 'partial')
              LIMIT 1`,
            [key.region, key.realm, key.name]
          );
          if (completed.rowCount === 0) {
            return { kind: "no_evidence" };
          }
          const inserted = await client.query<EvidenceRunRow>(
            `INSERT INTO character_evidence_runs
               (region, realm_slug, normalized_name, mode, tier_search_raid_id, created_at, account_credential_owner_id, account_credential_version)
             VALUES ($1, $2, $3, 'tier_search', $4, $5, $6, $7)
             RETURNING ${columns}`,
            [
              key.region,
              key.realm,
              key.name,
              raidId,
              at,
              credentials?.accountId ?? null,
              credentials?.credentialVersion ?? null
            ]
          );
          const run = mapEvidenceRun(one(inserted));
          if (phasePlan && phasePlan.length > 0) {
            await client.query(
              `INSERT INTO character_evidence_run_phases
                 (run_id, phase_id, ordinal, state)
               SELECT $1, item.phase_id, item.ordinal, 'pending'
                 FROM unnest($2::text[]) WITH ORDINALITY
                   AS item(phase_id, ordinal)`,
              [run.id, phasePlan]
            );
          }
          return { kind: "reserved", run };
        });
      },

      async find(id) {
        const result = await pool.query<EvidenceRunRow>(
          `SELECT ${evidenceRunColumns()}
           FROM character_evidence_runs WHERE id = $1`,
          [id]
        );
        return result.rows[0] ? mapEvidenceRun(result.rows[0]) : null;
      },

      async claim(id, attempt) {
        if (!Number.isInteger(attempt) || attempt < 1) {
          throw new RangeError("character_evidence_attempt_invalid");
        }
        const result = await pool.query<EvidenceRunRow>(
          `UPDATE character_evidence_runs
           SET status = 'running', attempt = $2,
               started_at = COALESCE(started_at, now()), error_code = NULL,
               limitation_code = NULL
           WHERE id = $1
             AND attempt < $2
             AND status IN ('queued', 'running', 'retrying')
           RETURNING ${evidenceRunColumns()}`,
          [id, attempt]
        );
        return result.rows[0] ? mapEvidenceRun(result.rows[0]) : null;
      },

      async markLightRefresh(id) {
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET light_refresh = true
           WHERE id = $1 AND status = 'queued'`,
          [id]
        );
        if (result.rowCount !== 1) {
          throw new Error("character_evidence_run_not_enqueuable");
        }
      },

      async markEnqueued(id, queueJobId) {
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET queue_job_id = $2
           WHERE id = $1
             AND status = 'queued'
             AND (queue_job_id IS NULL OR queue_job_id = $2)`,
          [id, queueJobId]
        );
        if (result.rowCount !== 1) {
          throw new Error("character_evidence_run_not_enqueuable");
        }
      },

      async seedPhases(runId, phases) {
        if (phases.length === 0) return;
        const result = await pool.query(
          `INSERT INTO character_evidence_run_phases
             (run_id, phase_id, ordinal, state)
           SELECT $1, item.phase_id, item.ordinal, 'pending'
             FROM unnest($2::text[], $3::integer[]) AS item(phase_id, ordinal)
           ON CONFLICT (run_id, phase_id) DO NOTHING`,
          [
            runId,
            phases.map((phase) => phase.id),
            phases.map((phase) => phase.ordinal)
          ]
        );
        if ((result.rowCount ?? 0) !== phases.length) {
          const count = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM character_evidence_run_phases WHERE run_id = $1`,
            [runId]
          );
          if (Number(count.rows[0]?.count) !== phases.length) {
            throw new Error("character_evidence_phase_plan_conflict");
          }
        }
      },

      async recordPhaseTransitions(runId, phases) {
        for (const phase of phases) {
          const result = await pool.query(
            `UPDATE character_evidence_run_phases
                SET state = $3, started_at = $4, completed_at = $5,
                    limitation_code = $6
              WHERE run_id = $1 AND phase_id = $2
                AND EXISTS (
                  SELECT 1 FROM character_evidence_runs run
                   WHERE run.id = $1
                     AND run.status IN ('queued', 'running', 'retrying')
                )
                AND (
                  state = $3 OR
                  (state = 'pending' AND $3 IN ('active', 'skipped')) OR
                  (state = 'limited' AND $3 = 'active') OR
                  (state = 'active' AND $3 IN ('completed', 'limited', 'failed', 'cancelled'))
                )`,
            [
              runId,
              phase.id,
              phase.state,
              phase.startedAt,
              phase.completedAt,
              phase.limitationCode
            ]
          );
          if (result.rowCount !== 1)
            throw new Error("character_evidence_phase_not_found");
        }
      },

      async listPhases(runId) {
        const result = await pool.query<
          EvidenceRunPhase & { phase_id: string }
        >(
          `SELECT phase_id AS id, ordinal, state, started_at AS "startedAt",
                  completed_at AS "completedAt", limitation_code AS "limitationCode"
             FROM character_evidence_run_phases
            WHERE run_id = $1 ORDER BY ordinal`,
          [runId]
        );
        return result.rows;
      },

      async readRunProgress(ids, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_evidence_progress_time_invalid");
        }
        if (ids.length === 0) return [];
        const result = await pool.query<{
          id: string;
          status: CharacterEvidenceRun["status"];
          deferred: boolean;
          phase_states: string[];
        }>(
          `SELECT runs.id, runs.status,
                  runs.limitation_code IS NOT NULL AS deferred,
                  COALESCE(
                    array_agg(phases.state ORDER BY phases.ordinal)
                      FILTER (WHERE phases.state IS NOT NULL),
                    '{}'
                  ) AS phase_states
             FROM character_evidence_runs runs
             LEFT JOIN character_evidence_run_phases phases
               ON phases.run_id = runs.id
            WHERE runs.id = ANY($1::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM suppressed_characters suppressed
                 WHERE suppressed.region = runs.region
                   AND suppressed.realm_slug = runs.realm_slug
                   AND suppressed.normalized_name = runs.normalized_name
                   AND (suppressed.expires_at IS NULL
                        OR suppressed.expires_at > $2)
              )
            GROUP BY runs.id, runs.status, runs.limitation_code`,
          [ids, at]
        );
        return result.rows.map((row) => ({
          id: row.id,
          status: row.status,
          deferred: row.deferred,
          phaseStates: row.phase_states
        }));
      },

      async publish(runId, input) {
        // A partial run must name what it fell short of. There are three
        // answers, not one, and each was added by a run this guard had already
        // rejected: a history-scan limitation, a parse limitation, or a run
        // that deliberately did not scan at all.
        //
        // Requiring the history code alone rejected every parse-capped run
        // (#290). Requiring either code rejected every parse-only run whose
        // work fit inside its budget (#367) -- which is precisely the run a
        // nearly-finished character makes, so a character failed more reliably
        // the closer it came to being done.
        //
        // Add the reason here when a fourth way to be partial appears; a
        // partial that can name nothing really is a bug.
        const partialNamesNoReason =
          input.state === "partial" &&
          input.limitationCode === null &&
          input.parseLimitationCode === null &&
          input.scanSkipped !== true;
        if (
          Number.isNaN(input.completedAt.valueOf()) ||
          (input.state === "complete" && input.limitationCode !== null) ||
          partialNamesNoReason
        ) {
          throw new RangeError("character_evidence_publication_invalid");
        }
        for (const kill of input.kills) {
          if (
            kill.guild !== null &&
            (kill.guild.name.length === 0 || kill.guild.realm.length === 0)
          ) {
            throw new RangeError("character_evidence_guild_invalid");
          }
          // Rejects a malformed parse before the transaction opens; the
          // merge parses it again for the rows it writes.
          parsePerformanceValues(kill.performance);
        }
        return withTransaction(pool, async (client) => {
          const active = await client.query<{
            id: string;
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
            mode: EvidenceRunMode;
            tier_search_raid_id: string | null;
          }>(
            `SELECT id, region, realm_slug, normalized_name, mode,
                    tier_search_raid_id
             FROM character_evidence_runs
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
             FOR UPDATE`,
            [runId]
          );
          if (active.rowCount !== 1) {
            throw new Error("character_evidence_run_not_active");
          }
          const activeRun = one(active);
          const activeKey = {
            region: activeRun.region,
            realm: activeRun.realm_slug,
            name: activeRun.normalized_name
          };
          // A tier search is a targeted collection (#450): it read one raid's
          // attendance and ranked kills and nothing else, so what it did not
          // find says nothing about anything stored. Decided from the run
          // rather than the input, so a republished stage, a recovered stage
          // and a stopped attempt are all published the same way.
          const targeted = activeRun.mode === "tier_search";
          // Raids this character is finished with. Collection no longer pages
          // into them, so for these raids "the run did not find it" no longer
          // means "it is gone" -- it means we deliberately did not look.
          const terminalKillRaidIds = new Set(
            (
              await client.query<{ raid_id: string }>(
                `SELECT raid_id
                   FROM character_terminal_tiers
                  WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                    AND domain = 'kills'
                    AND collection_version >= $4::integer`,
                [
                  activeKey.region,
                  activeKey.realm,
                  activeKey.name,
                  CURRENT_COLLECTION_VERSIONS.kills
                ]
              )
            ).rows.map((row) => row.raid_id)
          );
          const stored = await loadPositiveEvidenceForPartial(
            client,
            activeKey
          );
          const tierSearchKills =
            input.state === "complete" && !targeted
              ? await loadLatestTierSearchKills(client, activeKey)
              : [];
          const storedPerformance = await loadStoredPerformanceByFightUrl(
            client,
            activeKey
          );
          // When each fight's parses were actually read, so a fight this run
          // skipped keeps the time it was observed rather than being restamped
          // with this run's completion. A restamp would say every untouched
          // percentile was just re-checked, and make drift unmeasurable.
          const storedCollectedAt = new Map(
            (
              await client.query<{ fight_url: string; collected_at: Date }>(
                `SELECT k.fight_url, max(k.collected_at) AS collected_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                  GROUP BY k.fight_url`,
                [activeKey.region, activeKey.realm, activeKey.name]
              )
            ).rows.map((row) => [row.fight_url, row.collected_at] as const)
          );
          const storedHistoricRankLookups = new Map(
            (
              await client.query<{
                fight_url: string;
                historic_world_rank: number | null;
                historic_rank_checked_at: Date | null;
              }>(
                `SELECT DISTINCT ON (k.fight_url)
                        k.fight_url, k.historic_world_rank, k.historic_rank_checked_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                  ORDER BY k.fight_url, r.completed_at DESC NULLS LAST, r.id DESC`,
                [activeKey.region, activeKey.realm, activeKey.name]
              )
            ).rows.map(
              (row) =>
                [
                  row.fight_url,
                  {
                    historicWorldRank: row.historic_world_rank,
                    historicRankCheckedAt: row.historic_rank_checked_at
                  }
                ] as const
            )
          );
          // When each fight's rankings were last asked about and answered.
          // Carried forward exactly like `collected_at`, and for the same
          // reason: a fight this run skipped was skipped *because* it had
          // already been answered, so restamping it with this run's
          // completion would be a claim it was re-read.
          const storedParsesReadAt = new Map(
            (
              await client.query<{ fight_url: string; parses_read_at: Date }>(
                `SELECT k.fight_url, max(k.parses_read_at) AS parses_read_at
                   FROM character_mythic_kills k
                   JOIN character_evidence_runs r ON r.id = k.evidence_run_id
                  WHERE r.region = $1 AND r.realm_slug = $2
                    AND r.normalized_name = $3
                    AND r.status IN ('complete', 'partial')
                    AND k.parses_read_at IS NOT NULL
                  GROUP BY k.fight_url`,
                [activeKey.region, activeKey.realm, activeKey.name]
              )
            ).rows.map((row) => [row.fight_url, row.parses_read_at] as const)
          );
          const storedTierBests = await loadStoredTierBestParses(client, {
            region: activeRun.region,
            realm: activeRun.realm_slug,
            name: activeRun.normalized_name
          });
          const merged = mergePublishedEvidence(
            {
              positive: stored,
              tierSearchKills,
              terminalKillRaidIds,
              performanceByFightUrl: storedPerformance,
              collectedAtByFightUrl: storedCollectedAt,
              parsesReadAtByFightUrl: storedParsesReadAt,
              historicRankByFightUrl: storedHistoricRankLookups,
              tierBests: storedTierBests
            },
            input,
            targeted
          );
          // One statement per table rather than one per row. Carry-forward
          // makes every publish rewrite the character's whole history, and
          // all of it happens while the run's row lock is held.
          await insertEvidenceRows(
            client,
            "character_mythic_kills",
            runId,
            [
              ["source_fight_key", "text", ({ kill }) => kill.fightUrl],
              ["raid_id", "text", ({ kill }) => kill.raidId],
              ["raid_name", "text", ({ kill }) => kill.raidName],
              ["boss_id", "text", ({ kill }) => kill.bossId],
              ["boss_name", "text", ({ kill }) => kill.bossName],
              ["journal_boss_id", "text", ({ kill }) => kill.journalBossId],
              ["boss_order", "integer", ({ kill }) => kill.bossOrder],
              ["killed_at", "timestamptz", ({ kill }) => kill.killedAt],
              ["report_url", "text", ({ kill }) => kill.reportUrl],
              ["fight_url", "text", ({ kill }) => kill.fightUrl],
              ["guild_name", "text", ({ kill }) => kill.guild?.name ?? null],
              [
                "guild_region",
                "text",
                ({ kill }) => kill.guild?.region ?? null
              ],
              ["guild_realm", "text", ({ kill }) => kill.guild?.realm ?? null],
              ["uploader", "text", ({ kill }) => kill.uploader ?? null],
              [
                "historic_world_rank",
                "integer",
                ({ historicWorldRank }) => historicWorldRank
              ],
              [
                "historic_rank_checked_at",
                "timestamptz",
                ({ historicRankCheckedAt }) => historicRankCheckedAt
              ],
              ...performanceColumns(),
              ["collected_at", "timestamptz", ({ collectedAt }) => collectedAt],
              [
                "parses_read_at",
                "timestamptz",
                ({ parsesReadAt }) => parsesReadAt
              ]
            ],
            merged.kills
          );
          await insertEvidenceRows(
            client,
            "character_tier_best_parses",
            runId,
            [
              ["raid_id", "text", ({ tierBest }) => tierBest.raidId],
              ["raid_name", "text", ({ tierBest }) => tierBest.raidName],
              ["boss_id", "text", ({ tierBest }) => tierBest.bossId],
              ["boss_name", "text", ({ tierBest }) => tierBest.bossName],
              ["rankings_url", "text", ({ tierBest }) => tierBest.rankingsUrl],
              ...performanceColumns(),
              ["collected_at", "timestamptz", ({ collectedAt }) => collectedAt]
            ],
            merged.tierBests
          );
          await insertEvidenceRows(
            client,
            "character_mythic_wipes",
            runId,
            [
              ["raid_id", "text", (wipe) => wipe.raidId],
              ["raid_name", "text", (wipe) => wipe.raidName],
              ["boss_id", "text", (wipe) => wipe.bossId],
              ["boss_name", "text", (wipe) => wipe.bossName],
              ["journal_boss_id", "text", (wipe) => wipe.journalBossId],
              ["boss_order", "integer", (wipe) => wipe.bossOrder],
              ["attempted_at", "timestamptz", (wipe) => wipe.attemptedAt],
              ["report_url", "text", (wipe) => wipe.reportUrl],
              ["fight_url", "text", (wipe) => wipe.fightUrl],
              ["guild_name", "text", (wipe) => wipe.guild?.name ?? null],
              ["guild_realm", "text", (wipe) => wipe.guild?.realm ?? null],
              ["uploader", "text", (wipe) => wipe.uploader ?? null]
            ],
            merged.wipes
          );
          // Cutting edges are read from the newest full publication, so a
          // targeted one has none of its own to write.
          await insertEvidenceRows(
            client,
            "character_evidence_cutting_edges",
            runId,
            [
              ["achievement_id", "text", (edge) => edge.achievementId],
              ["completed_at", "timestamptz", (edge) => edge.completedAt]
            ],
            targeted ? [] : (input.cuttingEdges ?? [])
          );
          // The terminal publication marker belongs to this transaction, not
          // to the worker's finally block: evidence a reader can see must not
          // ever say its final phase is still pending after a crash.
          await client.query(
            `UPDATE character_evidence_run_phases
                SET state = CASE WHEN $3 = 'collection_failed' THEN 'failed' ELSE 'completed' END,
                    started_at = COALESCE(started_at, $2),
                    completed_at = $2,
                    limitation_code = CASE WHEN $3 = 'collection_failed' THEN $3 ELSE NULL END
              WHERE run_id = $1 AND phase_id = 'publication'`,
            [runId, input.completedAt, input.limitationCode]
          );
          const publication = await client.query(
            `UPDATE character_evidence_runs
             SET status = $2, limitation_code = $3, parse_limitation_code = $4,
                 parse_limitation_codes_seen = $8,
                 omitted_invalid_timestamp = $17,
                 retry_after_at = $5, error_code = NULL, completed_at = $6, evidence_version = $7,
                 kill_scan_skipped = $9,
                 kill_scan_completed_at = CASE
                   WHEN $9 OR $3::text IS NOT NULL THEN kill_scan_completed_at
                   ELSE $6
                 END,
                 kill_scan_resume_page = CASE
                   WHEN $10 THEN $11::integer
                   ELSE kill_scan_resume_page
                 END,
                 kill_scan_resume_boundary_report_code = CASE
                   WHEN $10 THEN $12::text
                   ELSE kill_scan_resume_boundary_report_code
                 END,
                 ranked_backfill_cursor = CASE
                   WHEN $13 THEN $14::jsonb
                   ELSE ranked_backfill_cursor
                 END,
                 ranked_backfill_attempted = $13,
                 historic_alias_progress = CASE
                   WHEN $15 THEN $16::jsonb
                   ELSE historic_alias_progress
                 END,
                 publication_scope = $18,
                 wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
            [
              runId,
              input.state,
              input.limitationCode,
              input.parseLimitationCode,
              input.retryAfterAt ?? null,
              input.completedAt,
              CURRENT_EVIDENCE_VERSION,
              // Empty, never null: a run that raised nothing is a different
              // fact from a run written before the column existed. A caller
              // that named only the code it was judged by recorded exactly
              // that, so it stands in for the list.
              input.parseLimitationCodesSeen ??
                (input.parseLimitationCode ? [input.parseLimitationCode] : []),
              // A targeted search read no history, whatever its input says,
              // so it can neither stamp a clean scan nor move the ordinary
              // history cursor or the aliases' progress.
              targeted || (input.scanSkipped ?? false),
              !targeted && Object.hasOwn(input, "historyScanResumePage"),
              input.historyScanResumePage ?? null,
              input.historyScanResumeBoundaryReportCode ?? null,
              Object.hasOwn(input, "rankedBackfillCursor"),
              // A finished walk is SQL NULL. JSON `null` would satisfy
              // IS NOT NULL and look like a resumable cursor to old rows.
              input.rankedBackfillCursor == null
                ? null
                : JSON.stringify(input.rankedBackfillCursor),
              !targeted && Object.hasOwn(input, "historicAliasProgress"),
              JSON.stringify(input.historicAliasProgress ?? null),
              input.omittedInvalidTimestamp ?? false,
              targeted ? "tier" : "full"
            ]
          );
          if (publication.rowCount !== 1) {
            throw new Error("character_evidence_run_not_active");
          }
          // In the publication's own transaction: a stage that outlived the
          // publication it fed would be republished by a later attempt over
          // evidence already stored.
          await client.query(
            `DELETE FROM character_evidence_collections WHERE run_id = $1`,
            [runId]
          );
        });
      },

      async stageCollection(runId, payload) {
        const result = await pool.query(
          `INSERT INTO character_evidence_collections (run_id, payload)
           SELECT $1, $2::jsonb
           FROM character_evidence_runs
           WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
           ON CONFLICT (run_id)
           DO UPDATE SET payload = EXCLUDED.payload, created_at = now()`,
          [runId, JSON.stringify(payload)]
        );
        // Selecting from the run rather than inserting blind keeps a stage
        // from outliving the run it belongs to: a run this worker no longer
        // owns has nothing to republish.
        if (result.rowCount !== 1) {
          throw new Error("character_evidence_run_not_active");
        }
      },

      async stagedCollection(runId) {
        const result = await pool.query<{ payload: StagedEvidenceCollection }>(
          `SELECT payload FROM character_evidence_collections WHERE run_id = $1`,
          [runId]
        );
        return result.rows[0]?.payload ?? null;
      },

      async clearSettledCollectionStages() {
        const result = await pool.query(
          `DELETE FROM character_evidence_collections AS stage
           USING character_evidence_runs AS run
           WHERE run.id = stage.run_id
             AND run.status NOT IN ('queued', 'running', 'retrying')`
        );
        return result.rowCount ?? 0;
      },

      async fail(id, code) {
        if (code.length === 0)
          throw new RangeError("character_evidence_error_invalid");
        return withTransaction(pool, async (client) => {
          const result = await client.query<{ completed_at: Date }>(
            `UPDATE character_evidence_runs
             SET status = 'failed', error_code = $2, completed_at = now(),
                 wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
             WHERE id = $1 AND status IN ('queued', 'running', 'retrying')
             RETURNING completed_at`,
            [id, code]
          );
          if (result.rowCount !== 1)
            throw new Error("character_evidence_run_not_active");
          await client.query(
            `UPDATE character_evidence_run_phases
                SET state = 'failed',
                    started_at = COALESCE(started_at, $2),
                    completed_at = $2,
                    limitation_code = $3
              WHERE run_id = $1 AND phase_id = 'publication'`,
            [id, one(result).completed_at, code]
          );
        });
      },

      async getCompleted(key) {
        return loadCompletedEvidence(pool, key);
      },

      async recordHistoricRankLookup(killId, rank, checkedAt) {
        await pool.query(
          `UPDATE character_mythic_kills AS kill
              SET historic_world_rank = COALESCE(kill.historic_world_rank, $2),
                  historic_rank_checked_at = COALESCE(kill.historic_rank_checked_at, $3)
             FROM character_evidence_runs AS run
            WHERE kill.id = $1
              AND kill.evidence_run_id = run.id
              AND run.status IN ('complete', 'partial')
              AND kill.historic_rank_checked_at IS NULL`,
          [killId, rank, checkedAt]
        );
      },

      async hydratedFightUrls(key, settledBefore) {
        const settledBeforeIso = settledBefore.toISOString();
        // Read through the same loader a dossier does, rather than restating
        // its scope in SQL. An earlier restatement matched every run ever, so
        // a parse surviving only on a superseded run suppressed collection of
        // a fight the dossier shows blank — and nothing then refilled it.
        const completed = await loadCompletedEvidence(pool, key);
        const hydrated = new Set(
          (completed?.kills ?? [])
            .filter(
              (kill) =>
                // A kill whose rankings have not settled is re-read rather
                // than left frozen at whatever it showed on the night. Its
                // percentile is still moving, so skipping it would freeze a
                // value we have reason to believe is wrong.
                kill.killedAt < settledBeforeIso &&
                (kill.performance.damage.state === "available" ||
                kill.performance.healing.state === "available" ||
                kill.performance.bossDamage.state === "available"
                  ? // Metrics collected before specialization support are not
                    // hydrated: the parse-tier version bump must let Warcraft
                    // Logs replace them with its now-available spec data.
                    kill.performance.spec !== null
                  : // Asked and answered with nothing is finished too. Without
                    // this half the parse budget goes on re-reading reports
                    // that have already said no -- and the hydration order
                    // sorts those failed groups to the front, so they are what
                    // it spends the budget on first (#297).
                    kill.parsesReadAt !== null)
            )
            .map((kill) => kill.fightUrl)
        );
        return [...hydrated].sort();
      },

      async collectedTierZones(key) {
        // Scoped exactly like `loadStoredTierBestParses`, which is the set
        // `publish` carries forward: a zone counts as collected only while its
        // rows survive into the next run's evidence. `completed_at` is the
        // run's, so a kill newer than it reopens the zone for collection.
        const result = await pool.query<{
          raid_id: string;
          collected_at: Date;
        }>(
          `SELECT t.raid_id, max(t.collected_at) AS collected_at
             FROM character_tier_best_parses t
             JOIN character_evidence_runs r ON r.id = t.evidence_run_id
            WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
              AND r.status IN ('complete', 'partial')
            GROUP BY t.raid_id`,
          [key.region, key.realm, key.name]
        );
        return result.rows
          .map((row) => [row.raid_id, row.collected_at.toISOString()] as const)
          .sort((a, b) => a[0].localeCompare(b[0]));
      },

      async storedEvidenceTiers(key, tierSearchRaidId) {
        // Read through the same loader a dossier does, so the scan can never
        // stop above evidence the dossier still shows.
        const completed = await loadCompletedEvidence(pool, key);
        const scan = await pool.query<{ completed_at: Date }>(
          `SELECT completed_at
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND kill_scan_skipped = false
              AND kill_scan_completed_at IS NOT NULL
            ORDER BY kill_scan_completed_at DESC
            LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        const resume = await pool.query<{
          kill_scan_resume_page: number | null;
          kill_scan_resume_boundary_report_code: string | null;
        }>(
          `SELECT kill_scan_resume_page, kill_scan_resume_boundary_report_code
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND status IN ('complete', 'partial')
              AND kill_scan_skipped = false
            ORDER BY completed_at DESC, id DESC
            LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        const ranked = tierSearchRaidId
          ? await pool.query<{
              ranked_backfill_cursor: StoredRankedBackfillCursor | null;
            }>(
              `SELECT ranked_backfill_cursor
                 FROM character_evidence_runs
                WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
                  AND tier_search_raid_id = $4
                  AND status IN ('complete', 'partial')
                  AND ranked_backfill_attempted = true
                ORDER BY completed_at DESC, id DESC
                LIMIT 1`,
              [key.region, key.realm, key.name, tierSearchRaidId]
            )
          : null;
        const attendance = tierSearchRaidId
          ? await pool.query<{ tier_search_outcome: string }>(
              `SELECT cost.tier_search_outcome
                 FROM character_evidence_run_costs cost
                 JOIN character_evidence_runs run ON run.id = cost.run_id
                WHERE run.region = $1 AND run.realm_slug = $2
                  AND run.normalized_name = $3
                  AND run.tier_search_raid_id = $4
                  AND run.status IN ('complete', 'partial')
                  AND cost.tier_search_outcome IS NOT NULL
                ORDER BY run.completed_at DESC, cost.attempt DESC
                LIMIT 1`,
              [key.region, key.realm, key.name, tierSearchRaidId]
            )
          : null;
        const aliasProgress = await pool.query<{
          historic_alias_progress: HistoricAliasScanProgress[];
        }>(
          `SELECT historic_alias_progress
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND status IN ('complete', 'partial')
              AND historic_alias_progress IS NOT NULL
            ORDER BY completed_at DESC, id DESC
            LIMIT 1`,
          [key.region, key.realm, key.name]
        );
        const scanTurn = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM character_evidence_runs
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND status IN ('complete', 'partial')
              AND kill_scan_skipped = false`,
          [key.region, key.realm, key.name]
        );
        return {
          kills: (completed?.kills ?? []).map((kill) => ({
            raidId: kill.raidId,
            raidName: kill.raidName,
            bossName: kill.bossName,
            journalBossId: kill.journalBossId,
            killedAt: kill.killedAt,
            reportUrl: kill.reportUrl
          })),
          wipes: (completed?.wipes ?? []).map((wipe) => ({
            raidId: wipe.raidId,
            raidName: wipe.raidName,
            bossName: wipe.bossName,
            journalBossId: wipe.journalBossId,
            attemptedAt: wipe.attemptedAt,
            reportUrl: wipe.reportUrl
          })),
          guilds: storedEvidenceGuilds(completed?.kills ?? [], key.region),
          ...(completed?.kills ? { parseOnlyKills: completed.kills } : {}),
          // Freshness answers whether a scan result can still be reused; the
          // newest publication answers whether there is parse work to resume.
          // Neither fact substitutes for the other. In particular, a clean
          // complete run must not turn a later manual refresh into a no-scan
          // attempt merely because its scan is recent.
          parseWorkOutstanding:
            completed?.run.limitationCode === null &&
            completed.run.parseLimitationCode !== null,
          ...(scan.rows[0]?.completed_at
            ? { lastCleanKillScanAt: scan.rows[0].completed_at.toISOString() }
            : {}),
          ...(resume.rows[0]?.kill_scan_resume_page
            ? { historyScanResumePage: resume.rows[0].kill_scan_resume_page }
            : {}),
          ...(resume.rows[0]?.kill_scan_resume_boundary_report_code
            ? {
                historyScanResumeBoundaryReportCode:
                  resume.rows[0].kill_scan_resume_boundary_report_code
              }
            : {}),
          historicAliasProgress:
            aliasProgress.rows[0]?.historic_alias_progress ?? [],
          identityScanTurn: Number(scanTurn.rows[0]?.count ?? 0),
          ...(ranked?.rows[0]?.ranked_backfill_cursor
            ? { rankedBackfillCursor: ranked.rows[0].ranked_backfill_cursor }
            : {}),
          ...(attendance?.rows[0]
            ? {
                tierSearchAttendanceComplete:
                  attendance.rows[0].tier_search_outcome === "complete"
              }
            : {})
        };
      },

      async lastRaiderIoRecoveryAt(key) {
        const result = await pool.query<{ completed_at: Date | null }>(
          `SELECT max(run.completed_at) AS completed_at
             FROM character_evidence_run_costs cost
             JOIN character_evidence_runs run ON run.id = cost.run_id
            WHERE run.region = $1 AND run.realm_slug = $2
              AND run.normalized_name = $3
              AND run.status IN ('complete', 'partial')
              AND cost.raiderio_historic_outcome = 'evidence'`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0]?.completed_at ?? null;
      },

      async terminalTiers(key) {
        const result = await pool.query<{
          raid_id: string;
          domain: EvidenceCollectionDomain;
        }>(
          `SELECT raid_id, domain
             FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND collection_version >= CASE domain
                    WHEN 'kills' THEN $4::integer
                    WHEN 'parses' THEN $5::integer
                    ELSE $6::integer
                  END
            ORDER BY raid_id, domain`,
          [
            key.region,
            key.realm,
            key.name,
            CURRENT_COLLECTION_VERSIONS.kills,
            CURRENT_COLLECTION_VERSIONS.parses,
            CURRENT_COLLECTION_VERSIONS.tier_bests
          ]
        );
        return result.rows.map((row) => ({
          raidId: row.raid_id,
          domain: row.domain
        }));
      },

      async recordWarcraftLogsCharacterId(key, characterId, at) {
        if (!Number.isSafeInteger(characterId) || characterId <= 0) {
          throw new RangeError("warcraft_logs_character_id_invalid");
        }
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("warcraft_logs_character_id_time_invalid");
        }
        await pool.query(
          `INSERT INTO warcraft_logs_character_ids
             (region, realm_slug, normalized_name, character_id, resolved_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (region, realm_slug, normalized_name)
           DO UPDATE SET character_id = EXCLUDED.character_id,
                         resolved_at = EXCLUDED.resolved_at`,
          [key.region, key.realm, key.name, characterId, at]
        );
      },

      async warcraftLogsCharacterId(key) {
        const result = await pool.query<{ character_id: number }>(
          `SELECT character_id
             FROM warcraft_logs_character_ids
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        return result.rows[0]?.character_id ?? null;
      },

      async warcraftLogsCharacterIds(keys) {
        if (keys.length === 0) return [];
        const result = await pool.query<{
          region: string;
          realm_slug: string;
          normalized_name: string;
          character_id: number;
        }>(
          `SELECT ids.region, ids.realm_slug, ids.normalized_name,
                  ids.character_id
             FROM warcraft_logs_character_ids AS ids
             JOIN unnest($1::text[], $2::text[], $3::text[])
                    AS wanted(region, realm_slug, normalized_name)
               ON ids.region = wanted.region
              AND ids.realm_slug = wanted.realm_slug
              AND ids.normalized_name = wanted.normalized_name`,
          [
            keys.map((key) => key.region),
            keys.map((key) => key.realm),
            keys.map((key) => key.name)
          ]
        );
        return result.rows.map((row) => ({
          key: {
            region: row.region as CharacterKey["region"],
            realm: row.realm_slug,
            name: row.normalized_name
          },
          characterId: row.character_id
        }));
      },

      async markTerminalTiers(key, tiers, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_terminal_tier_time_invalid");
        }
        if (tiers.length === 0) return;
        await pool.query(
          `INSERT INTO character_terminal_tiers
             (region, realm_slug, normalized_name, raid_id, domain,
              collection_version, marked_at)
           SELECT $1, $2, $3, entry.raid_id,
                  entry.domain::evidence_collection_domain,
                  CASE entry.domain
                    WHEN 'kills' THEN $6::integer
                    WHEN 'parses' THEN $7::integer
                    ELSE $8::integer
                  END,
                  $9
             FROM unnest($4::text[], $5::text[]) AS entry(raid_id, domain)
           ON CONFLICT (region, realm_slug, normalized_name, raid_id, domain)
           DO UPDATE SET collection_version = EXCLUDED.collection_version,
                         marked_at = EXCLUDED.marked_at`,
          [
            key.region,
            key.realm,
            key.name,
            tiers.map((tier) => tier.raidId),
            tiers.map((tier) => tier.domain),
            CURRENT_COLLECTION_VERSIONS.kills,
            CURRENT_COLLECTION_VERSIONS.parses,
            CURRENT_COLLECTION_VERSIONS.tier_bests,
            at
          ]
        );
      },

      async clearTerminalTiers(key) {
        // Marks only. The stored kills, wipes and tier bests stay exactly where
        // they are: a rebuild must not leave a dossier empty while it waits for
        // the replacement evidence to arrive.
        const result = await pool.query(
          `DELETE FROM character_terminal_tiers
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        return result.rowCount ?? 0;
      },
      async emptyAttendanceSearches(key, searchedSince) {
        if (Number.isNaN(searchedSince.valueOf())) {
          throw new RangeError("character_attendance_search_time_invalid");
        }
        const result = await pool.query<{
          guild_region: string;
          guild_realm: string;
          guild_name: string;
          verified_at: Date;
        }>(
          `SELECT guild_region, guild_realm, guild_name, verified_at
             FROM character_attendance_searches
            WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
              AND searched_at >= $4
              AND collection_version >= $5`,
          [
            key.region,
            key.realm,
            key.name,
            searchedSince,
            CURRENT_COLLECTION_VERSIONS.kills
          ]
        );
        return result.rows.map((row) => ({
          at: row.verified_at.toISOString(),
          guild: {
            name: row.guild_name,
            realm: row.guild_realm,
            region: row.guild_region
          }
        }));
      },

      async recordEmptyAttendanceSearches(key, searches, at) {
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_attendance_search_time_invalid");
        }
        if (searches.length === 0) return;
        await pool.query(
          `INSERT INTO character_attendance_searches
             (region, realm_slug, normalized_name, guild_region, guild_realm,
              guild_name, verified_at, collection_version, searched_at)
           SELECT $1, $2, $3, entry.guild_region, entry.guild_realm,
                  entry.guild_name, entry.verified_at, $8, $9
             FROM unnest($4::text[], $5::text[], $6::text[],
                         $7::timestamptz[])
                  AS entry(guild_region, guild_realm, guild_name, verified_at)
           ON CONFLICT (region, realm_slug, normalized_name, guild_region,
                        guild_realm, guild_name, verified_at)
           DO UPDATE SET collection_version = EXCLUDED.collection_version,
                         searched_at = EXCLUDED.searched_at`,
          [
            key.region,
            key.realm,
            key.name,
            searches.map((search) => search.guild.region),
            searches.map((search) => search.guild.realm),
            searches.map((search) => search.guild.name),
            searches.map((search) => new Date(search.at)),
            CURRENT_COLLECTION_VERSIONS.kills,
            at
          ]
        );
      },

      async listResumable(limit, at) {
        if (limit <= 0) return [];
        if (Number.isNaN(at.valueOf())) {
          throw new RangeError("character_evidence_resume_time_invalid");
        }
        // `latest` is each character's most recent completed run, picked the
        // same way `loadCompletedEvidence` picks it, so this and the dossier
        // read never disagree about which run speaks for a character.
        //
        // The `NOT EXISTS` is the whole of the in-flight guard: `reserve`
        // would return `active` for such a character and the sweep would do
        // nothing, so excluding it here saves the round trip rather than
        // changing the outcome.
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `WITH latest AS (
             SELECT DISTINCT ON (region, realm_slug, normalized_name)
               region, realm_slug, normalized_name, mode,
               ranked_backfill_cursor, retry_after_at AS due_at
             FROM character_evidence_runs
             WHERE status IN ('complete', 'partial')
               -- A targeted search's deadline is its own, and only a ranked
               -- continuation (below) acts on it (#450).
               AND publication_scope = 'full'
             ORDER BY region, realm_slug, normalized_name,
               completed_at DESC, id DESC
           ), ranked AS (
             SELECT DISTINCT ON (region, realm_slug, normalized_name, tier_search_raid_id)
                    region, realm_slug, normalized_name, tier_search_raid_id,
                    created_at, status,
                    ranked_backfill_attempted,
                    ranked_backfill_cursor, retry_after_at
               FROM character_evidence_runs
              WHERE mode = 'tier_search'
                AND status IN ('complete', 'partial')
              ORDER BY region, realm_slug, normalized_name, tier_search_raid_id,
                created_at DESC, id DESC
           ), due AS (
             SELECT latest.region, latest.realm_slug, latest.normalized_name,
                    latest.due_at
               FROM latest
              WHERE latest.due_at IS NOT NULL AND latest.due_at <= $1
                AND NOT (latest.mode = 'tier_search'
                         AND COALESCE(
                           jsonb_typeof(latest.ranked_backfill_cursor) = 'object',
                           false
                         ))
             UNION ALL
             SELECT ranked.region, ranked.realm_slug, ranked.normalized_name,
                    ranked.retry_after_at AS due_at
               FROM ranked
              WHERE ranked.status = 'partial'
                AND ranked.ranked_backfill_attempted = true
                AND jsonb_typeof(ranked.ranked_backfill_cursor) = 'object'
                AND ranked.retry_after_at <= $1
                AND NOT EXISTS (
                  SELECT 1 FROM character_evidence_runs failed
                   WHERE failed.region = ranked.region
                     AND failed.realm_slug = ranked.realm_slug
                     AND failed.normalized_name = ranked.normalized_name
                     AND failed.tier_search_raid_id = ranked.tier_search_raid_id
                     AND failed.mode = 'tier_search' AND failed.status = 'failed'
                     AND failed.created_at > ranked.created_at
                     AND failed.completed_at > $1 - interval '30 minutes'
                )
             UNION ALL
             SELECT region, realm_slug, normalized_name, requested_at AS due_at
               FROM character_alias_recollections
              WHERE requested_at <= $1
           )
           SELECT due.region, due.realm_slug, due.normalized_name
             FROM due
            WHERE NOT EXISTS (
               SELECT 1 FROM character_evidence_runs active
               WHERE active.region = due.region
                 AND active.realm_slug = due.realm_slug
                 AND active.normalized_name = due.normalized_name
                 AND active.status IN ('queued', 'running', 'retrying')
             )
            GROUP BY due.region, due.realm_slug, due.normalized_name
            ORDER BY min(due.due_at)
            LIMIT $2`,
          [at, limit]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },

      async listStatus(keys) {
        if (keys.length === 0) return [];
        const result = await pool.query<EvidenceRunRow>(
          `SELECT DISTINCT ON (run.region, run.realm_slug, run.normalized_name)
             ${evidenceRunColumns("run")}
           FROM character_evidence_runs run
           JOIN unnest($1::text[], $2::text[], $3::text[])
             AS requested(region, realm_slug, normalized_name)
             ON requested.region = run.region
            AND requested.realm_slug = run.realm_slug
            AND requested.normalized_name = run.normalized_name
           ORDER BY run.region, run.realm_slug, run.normalized_name,
             (run.status IN ('queued', 'running', 'retrying')) DESC,
             run.created_at DESC, run.id DESC`,
          [
            keys.map((key) => key.region),
            keys.map((key) => key.realm),
            keys.map((key) => key.name)
          ]
        );
        return result.rows.map(mapEvidenceRun);
      },

      async recordLimitation(runId, code) {
        if (code.length === 0) {
          throw new RangeError("character_evidence_limitation_invalid");
        }
        await pool.query(
          `UPDATE character_evidence_runs
           SET limitation_code = $2
           WHERE id = $1 AND status IN ('queued', 'running', 'retrying')`,
          [runId, code]
        );
      },

      async clearStaleCredentials(cutoffs) {
        if (
          Number.isNaN(cutoffs.settled.valueOf()) ||
          Number.isNaN(cutoffs.active.valueOf())
        ) {
          throw new RangeError("character_evidence_credential_cutoff_invalid");
        }
        // A run still in the active set keeps its credentials for the longer
        // window: it may simply be waiting out a points-budget deferral, and a
        // run stripped mid-flight does not fail -- it quietly spends the
        // worker's shared allowance instead of the visitor's.
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
           WHERE created_at < CASE
                   WHEN status IN ('queued', 'running', 'retrying')
                     THEN $2::timestamptz
                   ELSE $1::timestamptz
                 END
             AND (wcl_client_id_encrypted IS NOT NULL OR wcl_client_secret_encrypted IS NOT NULL)`,
          [cutoffs.settled, cutoffs.active]
        );
        return result.rowCount ?? 0;
      },

      async listForMonitor({ completedLimit }) {
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
          status: CharacterEvidenceRun["status"];
          evidence_version: number;
          attempt: number;
          limitation_code: string | null;
          parse_limitation_code: string | null;
          retry_after_at: Date | null;
          error_code: string | null;
          started_at: Date | null;
          completed_at: Date | null;
          phases: EvidenceMonitorPhase[];
        }>(
          // One query rather than one per run: a large dossier queues hundreds.
          // The run id stays inside the join and never reaches the projection.
          // Completed runs are the only set that grows without bound, so only
          // they are limited, newest first to match the outer ordering.
          `WITH runs AS (
             (SELECT id, region, realm_slug, normalized_name, status,
                     evidence_version, attempt, limitation_code,
                     parse_limitation_code, retry_after_at, error_code,
                     created_at, started_at, completed_at
                FROM character_evidence_runs
               WHERE status NOT IN ('complete', 'partial'))
             UNION ALL
             (SELECT id, region, realm_slug, normalized_name, status,
                     evidence_version, attempt, limitation_code,
                     parse_limitation_code, retry_after_at, error_code,
                     created_at, started_at, completed_at
                FROM character_evidence_runs
               WHERE status IN ('complete', 'partial')
               ORDER BY completed_at DESC NULLS LAST, id DESC
               LIMIT $1)
           )
           SELECT runs.region, runs.realm_slug, runs.normalized_name,
                  runs.status, runs.evidence_version, runs.attempt,
                  runs.limitation_code, runs.parse_limitation_code,
                  runs.retry_after_at, runs.error_code, runs.started_at,
                  runs.completed_at, steps.phases
             FROM runs
             CROSS JOIN LATERAL (
               SELECT COALESCE(
                        json_agg(
                          json_build_object(
                            'id', phase.phase_id,
                            'state', phase.state,
                            'limitationCode', phase.limitation_code
                          ) ORDER BY phase.ordinal
                        ),
                        '[]'::json
                      ) AS phases
                 FROM character_evidence_run_phases phase
                WHERE phase.run_id = runs.id
                  AND runs.status IN ('queued', 'running', 'retrying')
             ) steps
            ORDER BY CASE
                       WHEN runs.status IN ('queued', 'running', 'retrying') THEN 0
                       WHEN runs.status IN ('complete', 'partial') THEN 1
                       ELSE 2
                     END,
                     CASE WHEN runs.status IN ('queued', 'running', 'retrying')
                       THEN COALESCE(runs.started_at, runs.created_at)
                     END ASC NULLS LAST,
                     runs.completed_at DESC NULLS LAST,
                     runs.id DESC`,
          [completedLimit]
        );
        return result.rows.map((row) => ({
          key: {
            region: row.region,
            realm: row.realm_slug,
            name: row.normalized_name
          },
          status: row.status,
          evidenceVersion: row.evidence_version,
          attempt: row.attempt,
          limitationCode: row.limitation_code,
          parseLimitationCode: row.parse_limitation_code,
          retryAfterAt: row.retry_after_at,
          errorCode: row.error_code,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          phases: row.phases
        }));
      },

      async listActive(limit) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new RangeError("character_evidence_active_limit_out_of_range");
        }
        const result = await pool.query<{
          id: string;
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
          queue_job_id: string | null;
          started_at: Date | null;
          created_at: Date;
        }>(
          `SELECT id, region, realm_slug, normalized_name,
                  queue_job_id, started_at, created_at
           FROM character_evidence_runs
           WHERE status IN ('queued', 'running', 'retrying')
           ORDER BY created_at, id
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => ({
          runId: row.id,
          key: {
            region: row.region,
            realm: row.realm_slug,
            name: row.normalized_name
          },
          queueJobId: row.queue_job_id,
          startedAt: row.started_at,
          createdAt: row.created_at
        }));
      },

      async recordRunCost(cost) {
        if (!Number.isInteger(cost.attempt) || cost.attempt < 1) {
          throw new RangeError("character_evidence_run_cost_attempt_invalid");
        }
        // Upserted rather than inserted: an attempt re-entered after a crash
        // writes the cost of the work it actually did, and a primary-key
        // violation here would surface as a lost run rather than a lost row.
        await pool.query(
          `INSERT INTO character_evidence_run_costs (
             run_id, attempt, outcome, credentials,
             limitation_code, parse_limitation_code,
             points_spent, points_limit_per_hour,
             points_remaining_before, points_remaining_after,
             request_cap_used, parse_request_cap_used,
             history_scan_requests, zone_rankings_requests,
             fight_parses_requests, ranking_identities_requests,
             guild_attendance_requests, report_hydration_requests,
             raiderio_historic_outcome, raiderio_historic_ms,
             verified_kills_searched, attendance_recovered_kills,
             verified_kills_skipped_empty,
             mode, character_guilds_requests, tier_search_raid_id,
             tier_search_outcome, tier_search_requests, tier_search_guilds,
             tier_search_reports_hydrated, tier_search_recovered_kills,
             tier_search_recovered_wipes,
             raiderio_historic_requests, raiderio_rankings_requests,
             blizzard_achievements_requests,
             duration_ms, queue_wait_ms, warcraft_logs_ms,
             warcraft_logs_historic_alias_ms, db_ms, db_max_call_name
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
                   $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
                   $33, $34, $35, $36, $37, $38, $39, $40, $41)
           ON CONFLICT (run_id, attempt) DO UPDATE SET
             recorded_at = now(),
             outcome = EXCLUDED.outcome,
             credentials = EXCLUDED.credentials,
             limitation_code = EXCLUDED.limitation_code,
             parse_limitation_code = EXCLUDED.parse_limitation_code,
             points_spent = EXCLUDED.points_spent,
             points_limit_per_hour = EXCLUDED.points_limit_per_hour,
             points_remaining_before = EXCLUDED.points_remaining_before,
             points_remaining_after = EXCLUDED.points_remaining_after,
             request_cap_used = EXCLUDED.request_cap_used,
             parse_request_cap_used = EXCLUDED.parse_request_cap_used,
             history_scan_requests = EXCLUDED.history_scan_requests,
             zone_rankings_requests = EXCLUDED.zone_rankings_requests,
             fight_parses_requests = EXCLUDED.fight_parses_requests,
             ranking_identities_requests = EXCLUDED.ranking_identities_requests,
             guild_attendance_requests = EXCLUDED.guild_attendance_requests,
             report_hydration_requests = EXCLUDED.report_hydration_requests,
             raiderio_historic_outcome = EXCLUDED.raiderio_historic_outcome,
             raiderio_historic_ms = EXCLUDED.raiderio_historic_ms,
             verified_kills_searched = EXCLUDED.verified_kills_searched,
             attendance_recovered_kills = EXCLUDED.attendance_recovered_kills,
             verified_kills_skipped_empty = EXCLUDED.verified_kills_skipped_empty,
             mode = EXCLUDED.mode,
             character_guilds_requests = EXCLUDED.character_guilds_requests,
             tier_search_raid_id = EXCLUDED.tier_search_raid_id,
             tier_search_outcome = EXCLUDED.tier_search_outcome,
             tier_search_requests = EXCLUDED.tier_search_requests,
             tier_search_guilds = EXCLUDED.tier_search_guilds,
             tier_search_reports_hydrated = EXCLUDED.tier_search_reports_hydrated,
             tier_search_recovered_kills = EXCLUDED.tier_search_recovered_kills,
             tier_search_recovered_wipes = EXCLUDED.tier_search_recovered_wipes,
             raiderio_historic_requests = EXCLUDED.raiderio_historic_requests,
             raiderio_rankings_requests = EXCLUDED.raiderio_rankings_requests,
             blizzard_achievements_requests =
               EXCLUDED.blizzard_achievements_requests,
             duration_ms = EXCLUDED.duration_ms,
             queue_wait_ms = EXCLUDED.queue_wait_ms,
             warcraft_logs_ms = EXCLUDED.warcraft_logs_ms,
             warcraft_logs_historic_alias_ms =
               EXCLUDED.warcraft_logs_historic_alias_ms,
             db_ms = EXCLUDED.db_ms,
             db_max_call_name = EXCLUDED.db_max_call_name`,
          [
            cost.runId,
            cost.attempt,
            cost.outcome,
            cost.credentials,
            cost.limitationCode,
            cost.parseLimitationCode,
            cost.pointsSpent,
            cost.pointsLimitPerHour,
            cost.pointsRemainingBefore,
            cost.pointsRemainingAfter,
            cost.requestCapUsed,
            cost.parseRequestCapUsed,
            cost.requests.historyScan,
            cost.requests.zoneRankings,
            cost.requests.fightParses,
            cost.requests.rankingIdentities,
            cost.requests.guildAttendance,
            cost.requests.reportHydration,
            cost.recovery.raiderIoOutcome,
            cost.recovery.raiderIoMs,
            cost.recovery.verifiedKillsSearched,
            cost.recovery.recoveredKills,
            cost.recovery.verifiedKillsSkippedEmpty,
            cost.mode ?? "full",
            cost.requests.characterGuilds ?? 0,
            cost.tierSearch?.raidId ?? null,
            cost.tierSearch?.outcome ?? null,
            cost.tierSearch?.requests ?? null,
            cost.tierSearch?.guilds ?? null,
            cost.tierSearch?.reportsHydrated ?? null,
            cost.tierSearch?.recoveredKills ?? null,
            cost.tierSearch?.recoveredWipes ?? null,
            cost.requests.raiderIoHistoric ?? 0,
            cost.requests.raiderIoRankings ?? 0,
            cost.requests.blizzardAchievements ?? 0,
            cost.timings?.durationMs ?? null,
            cost.timings?.queueWaitMs ?? null,
            cost.timings?.warcraftLogsMs ?? null,
            cost.timings?.warcraftLogsHistoricAliasMs ?? null,
            cost.timings?.dbMs ?? null,
            cost.timings?.dbMaxCallName ?? null
          ]
        );
      },

      async clearExpiredRunCosts(cutoff) {
        if (Number.isNaN(cutoff.valueOf())) {
          throw new RangeError("character_evidence_run_cost_cutoff_invalid");
        }
        const result = await pool.query(
          `DELETE FROM character_evidence_run_costs WHERE recorded_at < $1`,
          [cutoff]
        );
        return result.rowCount ?? 0;
      },

      async releaseAbandoned(runIds) {
        if (runIds.length === 0) return 0;
        // Same columns `fail` writes, for the same reason: `failed` is in
        // neither the active set nor `loadCompletedEvidence`, so the character
        // falls back to its previous evidence and the next read reserves a
        // fresh run. The status guard is what makes this lose the race to a
        // publication rather than overwrite it.
        const result = await pool.query(
          `UPDATE character_evidence_runs
           SET status = 'failed', error_code = 'abandoned', completed_at = now(),
               wcl_client_id_encrypted = NULL, wcl_client_secret_encrypted = NULL
           WHERE id = ANY($1::uuid[])
             AND status IN ('queued', 'running', 'retrying')`,
          [runIds]
        );
        return result.rowCount ?? 0;
      }
    }
  };
}
