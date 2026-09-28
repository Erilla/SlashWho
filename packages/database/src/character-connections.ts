import type { Pool, PoolClient } from "pg";
import {
  assignGroupIds,
  canonicalCharacterId,
  components,
  familyOf,
  type CharacterKey,
  type ConnectionFamily,
  type ObservationSource
} from "@slashwho/domain";
import { REBUILD_SQL } from "./character-groups-backfill-sql";
import type {
  CharacterConnectionRepository,
  FamilyObservationWrite,
  Repositories
} from "./repositories";
import { lockRoot } from "./locks";
import { withTransaction } from "./sql";

/** Taken shared by every writer of the group tables; exclusive by the rebuild. */
export async function lockRebuildShared(client: PoolClient): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
    ["character-groups-rebuild"]
  );
}

export async function lockRebuildExclusive(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "character-groups-rebuild"
  ]);
}

/** Serialises every group recompute. Taken after any root lock, never before. */
export async function lockGroups(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "character-groups"
  ]);
}

const LOCK_TIMEOUT = "5s";

/** Every source discovery can attribute a link to. */
const ALL_OBSERVATION_SOURCES = [
  "claimed",
  "declared_main",
  "profile_guess",
  "fingerprint"
] as const satisfies readonly ObservationSource[];

/**
 * The sources a `family`-family `replaced` retraction may remove, derived
 * from `familyOf` so a new Raider.IO source can't be missed here.
 */
function sourcesForFamily(
  family: ConnectionFamily
): readonly ObservationSource[] {
  return ALL_OBSERVATION_SOURCES.filter(
    (source) => familyOf(source) === family
  );
}

export function createCharacterConnectionRepositories(
  pool: Pool
): Pick<Repositories, "characterConnections"> {
  const characterConnections: CharacterConnectionRepository = {
    async writeObservations(input) {
      return withTransaction(pool, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await lockRebuildShared(client);
        await lockRoot(client, input.observerKey);

        // `run_started_at` is resolved in SQL and carried as text from here
        // on, never round-tripped through a JS `Date`: a `Date` only holds
        // millisecond precision, but `discovery_runs.started_at` and
        // `character_connections.observed_at` are both timestamptz
        // (microsecond precision, matching the backfill), and the
        // marker/ledger/retraction comparisons below need that full
        // precision to order writes correctly.
        const run = await client.query<{
          run_started_at: string;
          root_region: string;
          root_realm_slug: string;
          root_normalized_name: string;
        }>(
          `SELECT COALESCE(started_at, created_at)::text AS run_started_at,
                  root_region, root_realm_slug, root_normalized_name
             FROM discovery_runs WHERE id = $1`,
          [input.runId]
        );
        const runRow = run.rows[0];
        if (!runRow) throw new Error("character_connections_run_missing");
        const runStartedAt = runRow.run_started_at;

        const runRootId = canonicalCharacterId({
          region: runRow.root_region as CharacterKey["region"],
          realm: runRow.root_realm_slug,
          name: runRow.root_normalized_name
        });
        if (runRootId !== canonicalCharacterId(input.observerKey)) {
          throw new Error("character_connections_run_root_mismatch");
        }

        const ids = await characterIds(client, [
          input.observerKey,
          ...input.families.flatMap((family) =>
            family.observed.map((item) => item.key)
          )
        ]);
        const observerId = ids.get(canonicalCharacterId(input.observerKey));
        if (!observerId)
          throw new Error("character_connections_observer_missing");

        const changed = new Set<string>();
        let unknownCharacters = 0;

        for (const family of input.families) {
          // An observer's markers and observed rows are only ever written
          // under that observer's root lock (held above) or the exclusive
          // rebuild lock, so no concurrent writer for this observer can be
          // racing this comparison: the marker this reads is either
          // committed and stable, or not our concern yet.
          const marker = await client.query<{ blocked: boolean }>(
            `SELECT run_started_at > $3::timestamptz AS blocked
               FROM character_connection_writes
              WHERE observer_character_id = $1 AND family = $2`,
            [observerId, family.family, runStartedAt]
          );
          const blockedByNewer = marker.rows[0]?.blocked === true;
          if (blockedByNewer) {
            await logWrite(
              client,
              input.runId,
              family,
              observerId,
              "blocked",
              "blocked_by_newer",
              runStartedAt
            );
            continue;
          }

          for (const item of family.observed) {
            if (familyOf(item.source) !== family.family)
              throw new Error("character_connections_family_mismatch");
            const otherId = ids.get(canonicalCharacterId(item.key));
            if (!otherId) {
              unknownCharacters += 1;
              continue;
            }
            if (otherId === observerId) continue;

            // The winning `discovery_run_id` on a re-observed pair is
            // whichever write carried the newest `observed_at`, so it may
            // name an earlier run than the latest writer if that writer
            // only renewed an already-newer row. Retraction below stays
            // safe with this because it also requires
            // `observed_at < run_started_at`: a row can only be retracted
            // by a run whose start is after the row's own `observed_at`,
            // whichever run's id is currently attached to it.
            const inserted = await client.query<{ created: boolean }>(
              `INSERT INTO character_connections
                 (character_low_id, character_high_id, kind, source,
                  observed_from_character_id, discovery_run_id, observed_at)
               VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid),
                       'observed', $3, $1, $4, now())
               ON CONFLICT (character_low_id, character_high_id, source, observed_from_character_id)
                 WHERE kind = 'observed'
               DO UPDATE SET
                 observed_at = GREATEST(character_connections.observed_at, EXCLUDED.observed_at),
                 discovery_run_id = CASE
                   WHEN EXCLUDED.observed_at >= character_connections.observed_at
                   THEN EXCLUDED.discovery_run_id
                   ELSE character_connections.discovery_run_id
                 END
               RETURNING (xmax = 0) AS created`,
              [observerId, otherId, item.source, input.runId]
            );
            if (inserted.rows[0]?.created) {
              changed.add(observerId);
              changed.add(otherId);
            }
          }

          if (family.decision === "replaced") {
            const sources = sourcesForFamily(family.family);
            const removed = await client.query<{
              low: string;
              high: string;
            }>(
              `DELETE FROM character_connections
               WHERE kind = 'observed'
                 AND observed_from_character_id = $1
                 AND source = ANY($2::text[])
                 AND discovery_run_id <> $3
                 AND observed_at < $4::timestamptz
               RETURNING character_low_id AS low, character_high_id AS high`,
              [observerId, sources, input.runId, runStartedAt]
            );
            for (const row of removed.rows) {
              changed.add(row.low);
              changed.add(row.high);
            }
          }

          await client.query(
            `INSERT INTO character_connection_writes
               (observer_character_id, family, run_id, run_started_at)
             VALUES ($1, $2, $3, $4::timestamptz)
             ON CONFLICT (observer_character_id, family) DO UPDATE SET
               run_id = CASE
                 WHEN EXCLUDED.run_started_at >= character_connection_writes.run_started_at
                 THEN EXCLUDED.run_id
                 ELSE character_connection_writes.run_id
               END,
               run_started_at = GREATEST(
                 character_connection_writes.run_started_at,
                 EXCLUDED.run_started_at
               )`,
            [observerId, family.family, input.runId, runStartedAt]
          );

          await logWrite(
            client,
            input.runId,
            family,
            observerId,
            family.decision,
            family.reason,
            runStartedAt
          );
        }

        changed.add(observerId);
        return { changedCharacterIds: [...changed].sort(), unknownCharacters };
      });
    },
    async recomputeGroupsOf(seedIds) {
      const done = new Set<string>();
      for (const seed of seedIds) {
        if (done.has(seed)) continue;
        const members = await withTransaction(pool, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          await lockRebuildShared(client);
          await lockGroups(client);
          return recomputeComponent(client, seed);
        });
        for (const id of members) done.add(id);
      }
    },

    async recomputePass({ budgetMs }) {
      const startedAt = Date.now();
      const withinBudget = () => Date.now() - startedAt < budgetMs;
      let groupsRecomputed = 0;
      let ungroupedAssigned = 0;

      /**
       * Assigns one ungrouped character to a group, in its own short
       * transaction. Returns false once none remain.
       */
      const assignNextUngrouped = (): Promise<boolean> =>
        withTransaction(pool, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          await lockRebuildShared(client);
          await lockGroups(client);
          await client.query(
            `UPDATE character_groups_maintenance
             SET cycle_started_at = COALESCE(cycle_started_at, now())
             WHERE id = 1`
          );
          const ungrouped = await client.query<{ id: string }>(
            `SELECT c.id FROM characters c LEFT JOIN character_group_members m ON m.character_id = c.id
             WHERE m.character_id IS NULL ORDER BY c.id LIMIT 1`
          );
          if (!ungrouped.rows[0]) return false;
          await recomputeComponent(client, ungrouped.rows[0].id);
          return true;
        });

      // Ungrouped characters, handled once up front in their own short
      // transactions rather than re-scanned for on every group step below.
      while (withinBudget()) {
        if (!(await assignNextUngrouped())) break;
        ungroupedAssigned += 1;
      }
      if (!withinBudget()) {
        return { groupsRecomputed, ungroupedAssigned, cycleCompleted: false };
      }

      for (;;) {
        if (!withinBudget()) {
          return { groupsRecomputed, ungroupedAssigned, cycleCompleted: false };
        }
        const step = await withTransaction(pool, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          await lockRebuildShared(client);
          await lockGroups(client);
          const state = await client.query<{ cursor_group_id: string | null }>(
            `UPDATE character_groups_maintenance
             SET cycle_started_at = COALESCE(cycle_started_at, now())
             WHERE id = 1 RETURNING cursor_group_id`
          );
          const cursor = state.rows[0]?.cursor_group_id ?? null;
          const next = await client.query<{
            id: string;
            seed: string | null;
          }>(
            `SELECT g.id, (SELECT character_id FROM character_group_members WHERE group_id = g.id ORDER BY character_id LIMIT 1) AS seed
             FROM character_groups g WHERE $1::uuid IS NULL OR g.id > $1::uuid ORDER BY g.id LIMIT 1`,
            [cursor]
          );
          const group = next.rows[0];
          if (!group) return { kind: "no_next_group" as const };
          if (!group.seed) {
            // An empty group has nothing to recompute: drop it and move on,
            // rather than leaving it to be skipped forever.
            await client.query(`DELETE FROM character_groups WHERE id = $1`, [
              group.id
            ]);
            await client.query(
              `UPDATE character_groups_maintenance SET cursor_group_id = $1 WHERE id = 1`,
              [group.id]
            );
            return { kind: "empty_group_deleted" as const };
          }
          await recomputeComponent(client, group.seed);
          await client.query(
            `UPDATE character_groups_maintenance SET cursor_group_id = $1 WHERE id = 1`,
            [group.id]
          );
          return { kind: "group_recomputed" as const };
        });

        if (step.kind === "group_recomputed") groupsRecomputed += 1;

        if (step.kind === "no_next_group") {
          // Check once more for ungrouped characters -- created since the
          // batch above ran -- before recording the cycle as complete.
          const before = ungroupedAssigned;
          while (withinBudget()) {
            if (!(await assignNextUngrouped())) break;
            ungroupedAssigned += 1;
          }
          if (!withinBudget()) {
            return {
              groupsRecomputed,
              ungroupedAssigned,
              cycleCompleted: false
            };
          }
          if (ungroupedAssigned === before) {
            await withTransaction(pool, async (client) => {
              await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
              await lockRebuildShared(client);
              await lockGroups(client);
              await client.query(
                `UPDATE character_groups_maintenance
                 SET last_cycle_started_at = cycle_started_at, last_cycle_completed_at = now(),
                     cycle_started_at = NULL, cursor_group_id = NULL
                 WHERE id = 1`
              );
            });
            return { groupsRecomputed, ungroupedAssigned, cycleCompleted: true };
          }
          // Draining created new groups that may sort past the cursor;
          // give the walk another pass before trying to finish again.
          continue;
        }
      }
    },

    async rebuild() {
      return withTransaction(pool, async (client) => {
        await lockRebuildExclusive(client);
        await lockGroups(client);
        await client.query(`DELETE FROM character_connections WHERE kind = 'observed'`);
        await client.query(`DELETE FROM character_connection_writes`);
        await client.query(`DELETE FROM character_groups`);
        await client.query(REBUILD_SQL.pinLatest);
        await client.query(REBUILD_SQL.pinSwept);
        await client.query(REBUILD_SQL.raiderio);
        await client.query(REBUILD_SQL.fingerprint);
        await client.query(REBUILD_SQL.markerAndLedger);
        await client.query(REBUILD_SQL.groups);
        const counts = await client.query<{
          observers: string;
          links: string;
          groups: string;
        }>(
          `SELECT (SELECT count(DISTINCT observer_character_id) FROM character_connection_writes)::text AS observers,
                  (SELECT count(*) FROM character_connections WHERE kind = 'observed')::text AS links,
                  (SELECT count(*) FROM character_groups)::text AS groups`
        );
        const row = counts.rows[0]!;
        return {
          observers: Number(row.observers),
          links: Number(row.links),
          groups: Number(row.groups)
        };
      });
    }
  };
  return { characterConnections };
}

/**
 * Recompute the component containing `seed`, iterating to closure: BFS over
 * counting links, plus (whenever a node is visited) every other member of
 * that node's *current* group, repeated until nothing new turns up. A link
 * whose own recompute hasn't run yet (or crashed) can leave a node grouped
 * with another node it has no direct counting-link path to; pulling in that
 * old group's members once and stopping there, without continuing the walk
 * from them, dropped exactly that link and stamped a slice of a still-live
 * component as though it were closed. Only once the node set stops growing
 * does `components` run, over every link collected among them. Returns
 * every character visited.
 */
async function recomputeComponent(
  client: PoolClient,
  seed: string
): Promise<string[]> {
  const nodes = new Set<string>([seed]);
  const links: { a: string; b: string }[] = [];
  let frontier = [seed];
  while (frontier.length > 0) {
    const next = new Set<string>();

    const edges = await client.query<{ a: string; b: string }>(
      COUNTING_LINKS_FROM,
      [frontier]
    );
    for (const edge of edges.rows) {
      links.push(edge);
      for (const id of [edge.a, edge.b]) {
        if (!nodes.has(id)) next.add(id);
      }
    }

    // Every other member of a visited node's *current* group: closure over
    // group co-membership too, so a link whose own recompute is still
    // pending is still reached from here, in the next round of this loop.
    const groupmates = await client.query<{ character_id: string }>(
      `SELECT character_id FROM character_group_members
       WHERE group_id IN (SELECT group_id FROM character_group_members WHERE character_id = ANY($1))`,
      [frontier]
    );
    for (const row of groupmates.rows) {
      if (!nodes.has(row.character_id)) next.add(row.character_id);
    }

    for (const id of next) nodes.add(id);
    frontier = [...next];
  }
  const membershipRows = await client.query<{
    character_id: string;
    group_id: string;
  }>(
    `SELECT character_id, group_id FROM character_group_members WHERE character_id = ANY($1)`,
    [[...nodes]]
  );
  const parts = components(
    nodes,
    links.filter((link) => nodes.has(link.a) && nodes.has(link.b))
  );
  const membership = new Map(
    membershipRows.rows.map((row) => [row.character_id, row.group_id])
  );
  const groupRows = await client.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM character_groups WHERE id = ANY($1)`,
    [[...new Set(membership.values())]]
  );
  const groups = new Map(
    groupRows.rows.map((row) => [
      row.id,
      { id: row.id, createdAt: row.created_at }
    ])
  );
  const { assignments, deletedGroupIds } = assignGroupIds(
    parts,
    membership,
    groups
  );
  for (const assignment of assignments) {
    const groupId =
      assignment.groupId ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO character_groups DEFAULT VALUES RETURNING id`
        )
      ).rows[0]!.id;
    await client.query(
      `UPDATE character_groups SET recomputed_at = now() WHERE id = $1`,
      [groupId]
    );
    await client.query(
      `INSERT INTO character_group_members (character_id, group_id) SELECT unnest($1::uuid[]), $2
       ON CONFLICT (character_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
      [assignment.members, groupId]
    );
  }
  if (deletedGroupIds.length > 0) {
    await client.query(`DELETE FROM character_groups WHERE id = ANY($1)`, [
      deletedGroupIds
    ]);
  }
  return [...nodes];
}

/**
 * Counting links touching any of $1:
 * - observed links, except pairs that have a rejection row;
 * - every resolved manual connection, excluded or not.
 * In phase 1 nothing writes rejections; honouring them now keeps a phase 3
 * rollback safe.
 */
const COUNTING_LINKS_FROM = `
  SELECT connection.character_low_id AS a, connection.character_high_id AS b
  FROM character_connections connection
  WHERE connection.kind = 'observed'
    AND (connection.character_low_id = ANY($1) OR connection.character_high_id = ANY($1))
    AND NOT EXISTS (
      SELECT 1 FROM character_connections rejection
      WHERE rejection.kind = 'rejected'
        AND rejection.character_low_id = connection.character_low_id
        AND rejection.character_high_id = connection.character_high_id
    )
  UNION
  SELECT manual.root_character_id, target.id
  FROM manual_dossier_connections manual
  JOIN characters target ON target.region = manual.connected_region
    AND target.realm_slug = manual.connected_realm_slug
    AND target.normalized_name = manual.connected_normalized_name
  WHERE target.id <> manual.root_character_id
    AND (manual.root_character_id = ANY($1) OR target.id = ANY($1))`;

async function logWrite(
  client: PoolClient,
  runId: string,
  family: FamilyObservationWrite,
  observerId: string,
  decision: string,
  reason: string,
  runStartedAt: string
): Promise<void> {
  await client.query(
    `INSERT INTO character_connection_write_log
       (run_id, sweep_reservation_id, observer_character_id, family, decision,
        reason, run_started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      runId,
      family.sweepReservationId,
      observerId,
      family.family,
      decision,
      reason,
      runStartedAt
    ]
  );
}

/** Existing character ids by canonical key. Never inserts (P2). */
export async function characterIds(
  client: Pick<PoolClient | Pool, "query">,
  keys: readonly CharacterKey[]
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const result = await client.query<{
    id: string;
    region: string;
    realm_slug: string;
    normalized_name: string;
  }>(
    `SELECT id, region, realm_slug, normalized_name FROM characters
     WHERE (region, realm_slug, normalized_name) IN (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     )`,
    [
      keys.map((key) => key.region),
      keys.map((key) => key.realm),
      keys.map((key) => key.name)
    ]
  );
  return new Map(
    result.rows.map((row) => [
      canonicalCharacterId({
        region: row.region as CharacterKey["region"],
        realm: row.realm_slug,
        name: row.normalized_name
      }),
      row.id
    ])
  );
}
