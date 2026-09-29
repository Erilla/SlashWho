import type { CharacterKey } from "@slashwho/domain";
import type { Pool, PoolClient } from "pg";
import { activeRunSql } from "./discovery-runs";
import { finishFingerprintSweep } from "./fingerprint-sweeps";
import { lockFingerprintSweeps, lockRoot } from "./locks";
import {
  type SnapshotCharacterRow,
  type SnapshotRow,
  mapSnapshotCharacter
} from "./mappers";
import type {
  CreateSnapshotInput,
  Repositories,
  SnapshotCharacterInput,
  SnapshotHistoryItem,
  SnapshotHistoryPage,
  StoredSnapshot
} from "./repositories";
import {
  type Queryable,
  one,
  withConsistentRead,
  withTransaction
} from "./sql";

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
      membership.guild_name,
      membership.guild_region,
      membership.guild_realm_slug,
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
  const characters = characterResult.rows.map(mapSnapshotCharacter);

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

// A snapshot is read in two statements, its row and then its membership. An
// amend can commit between them, so both run against one database snapshot.
function readSnapshot(pool: Pool, id: string): Promise<StoredSnapshot | null> {
  return withConsistentRead(pool, (client) => loadSnapshot(client, id));
}

function characterIdentity(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

/**
 * Upserts `characters` and returns their ids by `characterIdentity`.
 *
 * Rows are written in canonical key order, whatever order the caller holds
 * them in, so every transaction takes `characters` row locks in the same
 * order. Two transactions under different root locks can share characters --
 * a create for one root and an amend for another -- and locking them in
 * opposite orders deadlocks (#567). Display order is the caller's business
 * and is assigned separately by `insertMembership`.
 */
async function upsertCharacters(
  client: PoolClient,
  characters: readonly SnapshotCharacterInput[]
): Promise<Map<string, string>> {
  const characterIds = new Map<string, string>();
  const charactersByCanonicalKey = [...characters].sort((left, right) => {
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
    characterIds.set(characterIdentity(character.key), one(result).id);
  }
  return characterIds;
}

/**
 * Adds `characters` to a snapshot in the order given, numbering them from
 * `firstDisplayOrder`. Every character must already be in `characterIds`.
 */
async function insertMembership(
  client: PoolClient,
  snapshotId: string,
  firstDisplayOrder: number,
  characters: readonly SnapshotCharacterInput[],
  characterIds: ReadonlyMap<string, string>
): Promise<void> {
  for (const [index, character] of characters.entries()) {
    await client.query(
      `INSERT INTO snapshot_characters
        (snapshot_id, character_id, display_order, discovery_source,
         display_name, class_name, level, raider_io_url,
         guild_name, guild_region, guild_realm_slug)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        snapshotId,
        characterIds.get(characterIdentity(character.key))!,
        firstDisplayOrder + index,
        character.source,
        character.displayName,
        character.className,
        character.level,
        character.raiderIoUrl,
        character.guild?.name ?? null,
        character.guild?.region ?? null,
        character.guild?.realm ?? null
      ]
    );
  }
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

  const characterIds = await upsertCharacters(client, input.characters);

  const rootId = characterIds.get(characterIdentity(input.rootKey));
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
  const snapshotId = one(snapshotResult).id;

  await client.query(
    `UPDATE discovery_runs SET root_character_id = $2 WHERE id = $1`,
    [input.runId, rootId]
  );

  await insertMembership(client, snapshotId, 0, input.characters, characterIds);

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

export function createSnapshotRepositories(
  pool: Pool
): Pick<Repositories, "snapshots"> {
  return {
    snapshots: {
      async create(input, options) {
        options?.signal?.throwIfAborted();
        return withTransaction(pool, async (client) => {
          await lockRoot(client, input.rootKey);
          const snapshot = await createSnapshot(client, input, options);
          return snapshot;
        });
      },

      async createAndFinishFingerprintSweep(
        input,
        fingerprint,
        cursor,
        options
      ) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        options?.signal?.throwIfAborted();
        return withTransaction(pool, async (client) => {
          await lockRoot(client, input.rootKey);
          await lockFingerprintSweeps(client);
          const snapshot = await createSnapshot(client, input, options);
          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode,
            continuationAdmission: fingerprint.continuationAdmission,
            cursor: {
              resumeAfter: cursor.resumeAfter,
              resumeLimitationCode:
                cursor.resumeAfter === null ? null : cursor.limitationCode,
              historicalGuilds: cursor.historicalGuilds,
              excludedTournamentCharacterIds:
                cursor.excludedTournamentCharacterIds,
              resumeSnapshotId:
                cursor.resumeAfter === null ? null : snapshot.id,
              advanced: cursor.advanced
            }
          });
          options?.signal?.throwIfAborted();
          return snapshot;
        });
      },

      async amendAndFinishFingerprintSweep(
        snapshotId,
        characters,
        fingerprint,
        cursor,
        options
      ) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        options?.signal?.throwIfAborted();
        return withTransaction(pool, async (client) => {
          const rootResult = await client.query<{
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
          }>(
            `SELECT root.region, root.realm_slug, root.normalized_name
             FROM snapshots snapshot
             JOIN characters root ON root.id = snapshot.root_character_id
             WHERE snapshot.id = $1`,
            [snapshotId]
          );
          const rootRow = rootResult.rows[0];
          if (!rootRow) throw new Error("snapshot_not_found");
          await lockRoot(client, {
            region: rootRow.region,
            realm: rootRow.realm_slug,
            name: rootRow.normalized_name
          });
          await lockFingerprintSweeps(client);

          // Ownership, re-read under the root lock and before any write: a
          // fresh refresh for this root publishes its own snapshot and resets
          // the cursor, which makes this continuation's snapshot dead. Amending
          // it anyway would extend an orphan and, worse, overwrite the live
          // chain's cursor with this one's. Abort instead, touching neither the
          // snapshot nor the state row.
          const ownership = await client.query<{
            resume_snapshot_id: string | null;
            discovery_run_id: string | null;
          }>(
            `SELECT state.resume_snapshot_id, snapshot.discovery_run_id
             FROM fingerprint_sweep_states state
             LEFT JOIN snapshots snapshot
               ON snapshot.id = state.resume_snapshot_id
             WHERE state.region = $1
               AND state.realm_slug = $2
               AND state.normalized_name = $3`,
            [rootRow.region, rootRow.realm_slug, rootRow.normalized_name]
          );
          const owner = ownership.rows[0];
          if (
            !owner ||
            owner.resume_snapshot_id !== snapshotId ||
            owner.discovery_run_id !== fingerprint.runId
          ) {
            return null;
          }

          const orderResult = await client.query<{ next_order: number }>(
            // Read under the lock: a concurrent amend that committed between
            // the snapshot lookup and the lock would otherwise hand this one a
            // stale `display_order` to reuse.
            `SELECT COALESCE(MAX(display_order) + 1, 0) AS next_order
             FROM snapshot_characters
             WHERE snapshot_id = $1`,
            [snapshotId]
          );

          const existing = await client.query<{
            region: string;
            realm_slug: string;
            normalized_name: string;
          }>(
            `SELECT character.region, character.realm_slug,
                    character.normalized_name
             FROM snapshot_characters membership
             JOIN characters character ON character.id = membership.character_id
             WHERE membership.snapshot_id = $1`,
            [snapshotId]
          );
          const present = new Set(
            existing.rows.map(
              (row) => `${row.region}/${row.realm_slug}/${row.normalized_name}`
            )
          );

          const additions = characters.filter((character) => {
            const id = characterIdentity(character.key);
            if (present.has(id)) return false;
            present.add(id);
            return true;
          });
          const characterIds = await upsertCharacters(client, additions);
          await insertMembership(
            client,
            snapshotId,
            Number(one(orderResult).next_order),
            additions,
            characterIds
          );
          const appended = additions.length;

          await client.query(
            `UPDATE snapshots
             SET character_count = character_count + $2,
                 state = $3,
                 limitation_code = $4
             WHERE id = $1`,
            [
              snapshotId,
              appended,
              fingerprint.limitationCode === null ? "complete" : "partial",
              fingerprint.limitationCode
            ]
          );

          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode,
            continuationAdmission: fingerprint.continuationAdmission,
            cursor: {
              resumeAfter: cursor.resumeAfter,
              resumeLimitationCode:
                cursor.resumeAfter === null ? null : cursor.limitationCode,
              historicalGuilds: cursor.historicalGuilds,
              excludedTournamentCharacterIds:
                cursor.excludedTournamentCharacterIds,
              resumeSnapshotId: cursor.resumeAfter === null ? null : snapshotId,
              advanced: cursor.advanced
            }
          });

          const snapshot = await loadSnapshot(client, snapshotId);
          if (!snapshot) throw new Error("snapshot_not_found");
          options?.signal?.throwIfAborted();
          return snapshot;
        });
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
        return result.rows[0] ? readSnapshot(pool, result.rows[0].id) : null;
      },

      async getCurrentDeclaringCharacter(key) {
        // Superseded snapshots are never deleted, so the latest per root is
        // taken first; filtering the source before ordering keeps a newer
        // inferred membership elsewhere from hiding a declared one.
        const result = await pool.query<{ id: string }>(
          `WITH latest_snapshots AS (
             SELECT DISTINCT ON (snapshot.root_character_id)
               snapshot.id, snapshot.root_character_id, snapshot.refreshed_at
             FROM snapshots snapshot
             JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
             WHERE run.status = 'complete'
             ORDER BY snapshot.root_character_id,
                      snapshot.refreshed_at DESC,
                      snapshot.id DESC
           )
           SELECT snapshot.id
           FROM latest_snapshots snapshot
           JOIN snapshot_characters membership
             ON membership.snapshot_id = snapshot.id
            AND membership.discovery_source IN ('claimed', 'declared_main')
           JOIN characters character ON character.id = membership.character_id
           JOIN characters root ON root.id = snapshot.root_character_id
           WHERE character.region = $1
             AND character.realm_slug = $2
             AND character.normalized_name = $3
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
        return result.rows[0] ? readSnapshot(pool, result.rows[0].id) : null;
      },

      async listReverseDeclaredCharacters(key) {
        const result = await pool.query<SnapshotCharacterRow>(
          `WITH latest_snapshots AS (
             SELECT DISTINCT ON (snapshot.root_character_id)
               snapshot.id, snapshot.root_character_id
             FROM snapshots snapshot
             JOIN discovery_runs run ON run.id = snapshot.discovery_run_id
             WHERE run.status = 'complete'
             ORDER BY snapshot.root_character_id,
                      snapshot.refreshed_at DESC,
                      snapshot.id DESC
           )
           SELECT
             root_membership.character_id,
             root.region,
             root.realm_slug,
             root.normalized_name,
             root_membership.display_name,
             root_membership.class_name,
             root_membership.level,
             root_membership.raider_io_url,
             root_membership.guild_name,
             root_membership.guild_region,
             root_membership.guild_realm_slug,
             'declared_main' AS discovery_source,
             root_membership.display_order
           FROM latest_snapshots latest
           JOIN snapshot_characters edge
             ON edge.snapshot_id = latest.id
            AND edge.discovery_source = 'declared_main'
           JOIN characters declared_main ON declared_main.id = edge.character_id
           JOIN snapshot_characters root_membership
             ON root_membership.snapshot_id = latest.id
            AND root_membership.character_id = latest.root_character_id
           JOIN characters root ON root.id = latest.root_character_id
           WHERE declared_main.region = $1
             AND declared_main.realm_slug = $2
             AND declared_main.normalized_name = $3
             AND NOT EXISTS (
               SELECT 1 FROM snapshot_characters earlier_edge
               WHERE earlier_edge.snapshot_id = edge.snapshot_id
                 AND earlier_edge.discovery_source = 'declared_main'
                 AND earlier_edge.display_order < edge.display_order
             )
             AND (root.region, root.realm_slug, root.normalized_name)
                 <> ($1, $2, $3)
             AND NOT EXISTS (
               SELECT 1 FROM suppressed_characters suppression
               WHERE suppression.region = root.region
                 AND suppression.realm_slug = root.realm_slug
                 AND suppression.normalized_name = root.normalized_name
                 AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
             )
           ORDER BY root.region, root.realm_slug, root.normalized_name`,
          [key.region, key.realm, key.name]
        );
        return result.rows.map(mapSnapshotCharacter);
      },

      async find(id) {
        return readSnapshot(pool, id);
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
    }
  };
}
