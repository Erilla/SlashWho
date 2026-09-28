import type { Pool, PoolClient } from "pg";
import {
  canonicalCharacterId,
  familyOf,
  type CharacterKey,
  type ConnectionFamily,
  type ObservationSource
} from "@slashwho/domain";
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
    recomputeGroupsOf() {
      return Promise.reject(new Error("not_implemented"));
    },
    recomputePass() {
      return Promise.reject(new Error("not_implemented"));
    },
    rebuild() {
      return Promise.reject(new Error("not_implemented"));
    }
  };
  return { characterConnections };
}

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
