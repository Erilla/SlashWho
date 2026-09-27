import { type CharacterKey, toRaiderIoUrl } from "@slashwho/domain";
import type { Pool } from "pg";
import { activeRunSql } from "./discovery-runs";
import { lockRoot } from "./locks";
import type { Repositories } from "./repositories";
import { one, withTransaction } from "./sql";

export function createSmallStoreRepositories(
  pool: Pool
): Pick<
  Repositories,
  | "manualConnections"
  | "suppressions"
  | "rateLimits"
  | "recentSearches"
  | "negativeCache"
> {
  return {
    manualConnections: {
      async listDiscoveredExclusions(root) {
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
        }>(
          `SELECT exclusion.region, exclusion.realm_slug, exclusion.normalized_name
             FROM dossier_character_exclusions exclusion
             JOIN characters owner ON owner.id = exclusion.root_character_id
            WHERE owner.region = $1 AND owner.realm_slug = $2
              AND owner.normalized_name = $3`,
          [root.region, root.realm, root.name]
        );
        return result.rows.map((row) => ({
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        }));
      },
      async setDiscoveredExcluded(root, character, excluded) {
        const values = [
          root.region,
          root.realm,
          root.name,
          character.region,
          character.realm,
          character.name
        ];
        if (excluded) {
          const result = await pool.query(
            `INSERT INTO dossier_character_exclusions
               (root_character_id, region, realm_slug, normalized_name)
             SELECT id, $4, $5, $6 FROM characters
              WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
             ON CONFLICT DO NOTHING`,
            values
          );
          return result.rowCount === 1 ? "updated" : "missing";
        }
        await pool.query(
          `DELETE FROM dossier_character_exclusions exclusion USING characters owner
            WHERE exclusion.root_character_id = owner.id
              AND owner.region = $1 AND owner.realm_slug = $2
              AND owner.normalized_name = $3
              AND exclusion.region = $4 AND exclusion.realm_slug = $5
              AND exclusion.normalized_name = $6`,
          values
        );
        return "updated";
      },
      async add(root, character) {
        // The connected side is a key, so this records the link whether or not
        // the character has been discovered yet. Only the root must exist.
        const result = await pool.query(
          `INSERT INTO manual_dossier_connections
             (root_character_id, connected_region, connected_realm_slug,
              connected_normalized_name)
           SELECT root.id, $4, $5, $6
           FROM characters root
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
           ON CONFLICT DO NOTHING
           RETURNING root_character_id`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name
          ]
        );
        return result.rowCount === 1 ? "added" : "duplicate";
      },

      async list(root) {
        const result = await pool.query<{
          region: string;
          realm_slug: string;
          normalized_name: string;
          display_name: string | null;
          class_name: string | null;
          level: number | null;
          raider_io_url: string | null;
          excluded: boolean;
        }>(
          // Left join: a connection linked before discovery has no character
          // row yet, and must still be listed so the dossier can show it as
          // being researched.
          `SELECT connection.connected_region AS region,
                  connection.connected_realm_slug AS realm_slug,
                  connection.connected_normalized_name AS normalized_name,
                  connected.display_name,
                  connected.class_name,
                  connected.level,
                  connected.raider_io_url,
                  connection.excluded_at IS NOT NULL AS excluded
           FROM manual_dossier_connections connection
           JOIN characters owner ON owner.id = connection.root_character_id
           LEFT JOIN characters connected
             ON connected.region = connection.connected_region
            AND connected.realm_slug = connection.connected_realm_slug
            AND connected.normalized_name = connection.connected_normalized_name
           WHERE owner.region = $1
             AND owner.realm_slug = $2
             AND owner.normalized_name = $3
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters suppression
               WHERE suppression.region = connection.connected_region
                 AND suppression.realm_slug = connection.connected_realm_slug
                 AND suppression.normalized_name = connection.connected_normalized_name
                 AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
             )
           ORDER BY connection.created_at,
                    connection.connected_region,
                    connection.connected_realm_slug,
                    connection.connected_normalized_name`,
          [root.region, root.realm, root.name]
        );
        return result.rows.map((row) => {
          const key = {
            region: row.region as CharacterKey["region"],
            realm: row.realm_slug,
            name: row.normalized_name
          };
          return {
            key,
            displayName: row.display_name ?? row.normalized_name,
            className: row.class_name,
            // Level orders the dossier's characters. An undiscovered character
            // has none, and sorts last rather than claiming a rank.
            level: row.level ?? 0,
            raiderIoUrl: row.raider_io_url ?? toRaiderIoUrl(key),
            pending: row.display_name === null,
            excluded: row.excluded
          };
        });
      },

      async setExcluded(root, character, excluded) {
        const result = await pool.query(
          `UPDATE manual_dossier_connections connection
           SET excluded_at = CASE WHEN $7::boolean THEN now() ELSE NULL END
           FROM characters owner
           WHERE owner.id = connection.root_character_id
             AND owner.region = $1
             AND owner.realm_slug = $2
             AND owner.normalized_name = $3
             AND connection.connected_region = $4
             AND connection.connected_realm_slug = $5
             AND connection.connected_normalized_name = $6`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name,
            excluded
          ]
        );
        return result.rowCount === 1 ? "updated" : "missing";
      },

      async remove(root, character) {
        // Only the link is deleted. The character row and every snapshot that
        // found it are shared with other dossiers and stay untouched.
        const result = await pool.query(
          `DELETE FROM manual_dossier_connections connection
           USING characters owner
           WHERE owner.id = connection.root_character_id
             AND owner.region = $1
             AND owner.realm_slug = $2
             AND owner.normalized_name = $3
             AND connection.connected_region = $4
             AND connection.connected_realm_slug = $5
             AND connection.connected_normalized_name = $6`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name
          ]
        );
        return result.rowCount === 1 ? "removed" : "missing";
      }
    },

    suppressions: {
      async suppress(key, reason, expiresAt) {
        return withTransaction(pool, async (client) => {
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
        });
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
        return withTransaction(pool, async (client) => {
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
          if (Number(one(usage).count) >= limit) {
            return {
              allowed: false,
              retryAt: one(usage).retry_at
            };
          }
          await client.query(
            `INSERT INTO rate_limit_events (caller_bucket_hash, expires_at)
             VALUES ($1, $2)`,
            [callerBucketHash, expiresAt]
          );
          return { allowed: true, retryAt: null };
        });
      },

      async cleanupExpired(at = new Date()) {
        const result = await pool.query(
          "DELETE FROM rate_limit_events WHERE expires_at <= $1",
          [at]
        );
        return result.rowCount ?? 0;
      }
    },

    recentSearches: {
      async record(key, at = new Date()) {
        // GREATEST keeps a slow request from moving a newer search backwards.
        await pool.query(
          `INSERT INTO dossier_searches
            (region, realm_slug, normalized_name, searched_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (region, realm_slug, normalized_name)
           DO UPDATE SET searched_at =
             GREATEST(dossier_searches.searched_at, EXCLUDED.searched_at)`,
          [key.region, key.realm, key.name, at]
        );
      },

      async listRecent(limit) {
        // The current snapshot is chosen as getCurrent chooses it: the newest
        // one published by a completed run, so a snapshot whose membership is
        // still being written is never read.
        const result = await pool.query<{
          region: CharacterKey["region"];
          realm_slug: string;
          normalized_name: string;
          display_name: string | null;
          searched_at: Date;
          in_progress: boolean;
        }>(
          `SELECT search.region, search.realm_slug, search.normalized_name,
                  root.display_name, search.searched_at,
                  (
                    EXISTS (
                      SELECT 1 FROM discovery_runs run
                      WHERE run.root_region = search.region
                        AND run.root_realm_slug = search.realm_slug
                        AND run.root_normalized_name = search.normalized_name
                        AND run.status IN ${activeRunSql}
                    )
                    OR EXISTS (
                      SELECT 1 FROM character_evidence_runs evidence
                      WHERE evidence.status IN ${activeRunSql}
                        AND (
                          (evidence.region = search.region
                            AND evidence.realm_slug = search.realm_slug
                            AND evidence.normalized_name = search.normalized_name)
                          OR EXISTS (
                            SELECT 1
                            FROM snapshot_characters membership
                            JOIN characters member
                              ON member.id = membership.character_id
                            WHERE membership.snapshot_id = current_snapshot.id
                              AND member.region = evidence.region
                              AND member.realm_slug = evidence.realm_slug
                              AND member.normalized_name = evidence.normalized_name
                          )
                        )
                    )
                  ) AS in_progress
           FROM dossier_searches search
           LEFT JOIN characters root
             ON root.region = search.region
            AND root.realm_slug = search.realm_slug
            AND root.normalized_name = search.normalized_name
           LEFT JOIN LATERAL (
             SELECT snapshot.id
             FROM snapshots snapshot
             JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
             WHERE snapshot.root_character_id = root.id
               AND run.status = 'complete'
             ORDER BY snapshot.refreshed_at DESC, snapshot.id DESC
             LIMIT 1
           ) current_snapshot ON true
           WHERE NOT EXISTS (
             SELECT 1 FROM suppressed_characters suppression
             WHERE suppression.region = search.region
               AND suppression.realm_slug = search.realm_slug
               AND suppression.normalized_name = search.normalized_name
               AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
           )
           ORDER BY search.searched_at DESC, search.region, search.realm_slug,
                    search.normalized_name
           LIMIT $1`,
          [limit]
        );
        return result.rows.map((row) => ({
          key: {
            region: row.region,
            realm: row.realm_slug,
            name: row.normalized_name
          },
          displayName: row.display_name,
          searchedAt: row.searched_at,
          inProgress: row.in_progress
        }));
      }
    },

    negativeCache: {
      async put(key, expiresAt) {
        return withTransaction(pool, async (client) => {
          await lockRoot(client, key);
          await client.query(
            `INSERT INTO negative_character_cache
              (region, realm_slug, normalized_name, expires_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (region, realm_slug, normalized_name)
             DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = now()`,
            [key.region, key.realm, key.name, expiresAt]
          );
        });
      },

      async putAndFailRun(key, expiresAt, runId, options) {
        options?.signal?.throwIfAborted();
        return withTransaction(pool, async (client) => {
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
        });
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
