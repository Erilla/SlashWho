import type { PublicErrorCode } from "@slashwho/contracts";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import type {
  CallerClass,
  DiscoveryRun,
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
      async create(input) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
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
          for (const character of input.characters) {
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
        await pool.query(
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
      }
    },

    rateLimits: {
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

    negativeCache: {
      async put(key, expiresAt) {
        await pool.query(
          `INSERT INTO negative_character_cache
            (region, realm_slug, normalized_name, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (region, realm_slug, normalized_name)
           DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = now()`,
          [key.region, key.realm, key.name, expiresAt]
        );
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
      }
    }
  };
}
