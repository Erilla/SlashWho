import type { Pool } from "pg";
import {
  canonicalCharacterId,
  familyOf,
  type CharacterKey,
  type GroupGraph,
  type GroupSweepState,
  type ObservationSource
} from "@slashwho/domain";
import { COUNTING_LINKS_WITH_STRENGTH } from "./counting-links";
import { mapRun, type RunRow } from "./mappers";
import type { DiscoveryRun, StoredSnapshot } from "./repositories";
import { loadSnapshot } from "./snapshots";
import { withConsistentRead, type Queryable } from "./sql";

export type GroupRead = Readonly<{
  groupId: string | null;
  storedMemberIds: readonly string[];
  graph: GroupGraph;
  ownSnapshot: StoredSnapshot | null;
  snapshots: readonly StoredSnapshot[];
  runs: readonly DiscoveryRun[];
  sweepStates: readonly GroupSweepState[];
  negativeUntil: Date | null;
  activeEvidenceKeys: readonly CharacterKey[];
}>;

export interface GroupReadRepository {
  read(key: CharacterKey, at: Date): Promise<GroupRead | null>;
}

export { groupMemberFacts } from "@slashwho/domain";

export function createGroupReadRepository(pool: Pool): GroupReadRepository {
  return {
    read: (key, at) =>
      withConsistentRead(pool, (client) => loadGroupRead(client, key, at))
  };
}

/** All response membership facts on the caller's client, before any provider call. */
export async function loadGroupRead(
  client: Queryable,
  key: CharacterKey,
  at: Date
): Promise<GroupRead | null> {
  const params = [key.region, key.realm, key.name, at];
  const root = (
    await client.query<{ id: string; group_id: string | null }>(
      `
    SELECT c.id, m.group_id FROM characters c
    LEFT JOIN character_group_members m ON m.character_id = c.id
    WHERE c.region = $1 AND c.realm_slug = $2 AND c.normalized_name = $3
      AND NOT EXISTS (SELECT 1 FROM suppressed_characters s WHERE s.region = c.region
        AND s.realm_slug = c.realm_slug AND s.normalized_name = c.normalized_name
        AND (s.expires_at IS NULL OR s.expires_at > $4))`,
      params
    )
  ).rows[0];
  if (!root) return null;
  const storedRows = await client.query<{ character_id: string }>(
    `SELECT character_id FROM character_group_members WHERE group_id = $1`,
    [root.group_id]
  );
  const storedMemberIds = storedRows.rows.map((row) => row.character_id);
  const ownId = (
    await client.query<{ id: string }>(
      `
    SELECT s.id FROM snapshots s JOIN discovery_runs r ON r.id = s.discovery_run_id
    WHERE s.root_character_id = $1 AND r.status = 'complete'
    ORDER BY s.refreshed_at DESC, s.id DESC LIMIT 1`,
      [root.id]
    )
  ).rows[0]?.id;
  const ownSnapshot = ownId ? await loadSnapshot(client, ownId) : null;
  const ids = [
    ...new Set([
      root.id,
      ...storedMemberIds,
      ...(ownSnapshot?.characters.map((c) => c.characterId) ?? [])
    ])
  ];
  // Include resolved manual targets for the folded-in makers too.
  const targets = await client.query<{ id: string }>(
    `SELECT c.id FROM manual_dossier_connections m JOIN characters c
    ON c.region = m.connected_region AND c.realm_slug = m.connected_realm_slug AND c.normalized_name = m.connected_normalized_name
    WHERE m.root_character_id = ANY($1::uuid[])`,
    [ids]
  );
  for (const row of targets.rows) if (!ids.includes(row.id)) ids.push(row.id);
  const characterRows = await client.query<{
    id: string;
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
    display_name: string;
    class_name: string;
    level: number;
    raider_io_url: string;
    group_id: string | null;
    suppressed: boolean;
  }>(
    `
    SELECT c.*, m.group_id, EXISTS (SELECT 1 FROM suppressed_characters s
      WHERE s.region = c.region AND s.realm_slug = c.realm_slug AND s.normalized_name = c.normalized_name
      AND (s.expires_at IS NULL OR s.expires_at > $2)) AS suppressed
    FROM characters c LEFT JOIN character_group_members m ON m.character_id = c.id WHERE c.id = ANY($1::uuid[])`,
    [ids, at]
  );
  const characters = new Map(
    characterRows.rows.map((row) => [
      row.id,
      {
        key: {
          region: row.region,
          realm: row.realm_slug,
          name: row.normalized_name
        },
        displayName: row.display_name,
        className: row.class_name,
        level: row.level,
        raiderIoUrl: row.raider_io_url
      }
    ])
  );
  const byKey = new Map(
    [...characters].map(([id, c]) => [canonicalCharacterId(c.key), id])
  );
  const suppressed = new Set(
    characterRows.rows.filter((row) => row.suppressed).map((row) => row.id)
  );
  const edges = await client.query<{
    a: string;
    b: string;
    source: ObservationSource | null;
  }>(
    `SELECT * FROM (${COUNTING_LINKS_WITH_STRENGTH}) links WHERE a = ANY($1::uuid[]) AND b = ANY($1::uuid[])`,
    [ids]
  );
  const manualRows = await client.query<{
    maker: string;
    target: string | null;
    region: CharacterKey["region"];
    realm: string;
    name: string;
    excluded: boolean;
    origin: string | null;
  }>(
    `
    SELECT m.root_character_id AS maker, c.id AS target, m.connected_region AS region,
      m.connected_realm_slug AS realm, m.connected_normalized_name AS name,
      m.excluded_at IS NOT NULL AS excluded, to_jsonb(m)->>'origin' AS origin
    FROM manual_dossier_connections m LEFT JOIN characters c ON c.region = m.connected_region
      AND c.realm_slug = m.connected_realm_slug AND c.normalized_name = m.connected_normalized_name
    WHERE m.root_character_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM suppressed_characters s
      WHERE s.region = m.connected_region AND s.realm_slug = m.connected_realm_slug AND s.normalized_name = m.connected_normalized_name
      AND (s.expires_at IS NULL OR s.expires_at > $2))`,
    [ids, at]
  );
  const exclusionRows = await client.query<{ maker: string; target: string }>(
    `SELECT e.root_character_id AS maker, c.id AS target
    FROM dossier_character_exclusions e JOIN characters c ON c.region = e.region AND c.realm_slug = e.realm_slug AND c.normalized_name = e.normalized_name
    WHERE e.root_character_id = ANY($1::uuid[])`,
    [ids]
  );
  const wclRows = await client.query<{ id: string; character_id: number }>(
    `SELECT c.id, w.character_id FROM characters c
    JOIN warcraft_logs_character_ids w ON w.region = c.region AND w.realm_slug = c.realm_slug AND w.normalized_name = c.normalized_name
    WHERE c.id = ANY($1::uuid[])`,
    [ids]
  );
  const warcraftLogsIds = new Map(
    wclRows.rows.map((row) => [row.id, row.character_id])
  );
  const latestIds = await client.query<{ id: string }>(
    `SELECT DISTINCT ON (s.root_character_id) s.id
    FROM snapshots s JOIN discovery_runs r ON r.id = s.discovery_run_id AND r.status = 'complete'
    WHERE s.root_character_id = ANY($1::uuid[]) ORDER BY s.root_character_id, s.refreshed_at DESC, s.id DESC`,
    [ids]
  );
  const snapshots: StoredSnapshot[] = [];
  for (const row of latestIds.rows) {
    const s = await loadSnapshot(client, row.id);
    if (s) snapshots.push(s);
  }
  const runs = (
    await client.query<RunRow>(
      `SELECT r.* FROM discovery_runs r JOIN characters c
    ON c.region = r.root_region AND c.realm_slug = r.root_realm_slug AND c.normalized_name = r.root_normalized_name
    WHERE c.id = ANY($1::uuid[]) ORDER BY r.created_at DESC, r.id DESC`,
      [ids]
    )
  ).rows.map(mapRun);
  const sweeps = await client.query<{
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
    last_published_at: Date | null;
    resume_after: string | null;
    continuation_failures: number;
  }>(
    `SELECT s.* FROM fingerprint_sweep_states s JOIN characters c
    ON c.region = s.region AND c.realm_slug = s.realm_slug AND c.normalized_name = s.normalized_name WHERE c.id = ANY($1::uuid[])`,
    [ids]
  );
  const negativeUntil =
    (
      await client.query<{ expires_at: Date }>(
        `SELECT expires_at FROM negative_character_cache
    WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3 AND expires_at > $4`,
        params
      )
    ).rows[0]?.expires_at ?? null;
  const graph: GroupGraph = {
    characters,
    idOf: (k) => byKey.get(canonicalCharacterId(k)),
    groupOf: new Map(
      characterRows.rows.flatMap((row) =>
        row.group_id ? [[row.id, row.group_id] as const] : []
      )
    ),
    links: edges.rows.map((row) => ({
      a: row.a,
      b: row.b,
      strength: row.source === null ? "manual" : familyOf(row.source)
    })),
    manual: manualRows.rows.flatMap((row) =>
      row.target
        ? [
            {
              makerId: row.maker,
              targetId: row.target,
              excluded: row.excluded,
              origin: row.origin ?? "reviewer"
            }
          ]
        : []
    ),
    undiscoveredManualTargets: manualRows.rows.flatMap((row) =>
      row.target
        ? []
        : [
            {
              makerId: row.maker,
              targetKey: {
                region: row.region,
                realm: row.realm,
                name: row.name
              },
              excluded: row.excluded,
              origin: row.origin ?? "reviewer"
            }
          ]
    ),
    discoveredExclusions: exclusionRows.rows.map((row) => ({
      makerId: row.maker,
      targetId: row.target
    })),
    suppressed,
    warcraftLogsIds,
    sharedIdentity: (id) =>
      new Set(
        [...warcraftLogsIds]
          .filter(
            ([other, wcl]) => other === id || wcl === warcraftLogsIds.get(id)
          )
          .map(([other]) => other)
          .concat(id)
      ),
    latestSnapshot: new Map(
      snapshots.map((s) => [
        byKey.get(canonicalCharacterId(s.rootKey))!,
        {
          state: s.state,
          limitationCode: s.limitationCode,
          refreshedAt: s.refreshedAt
        }
      ])
    ),
    snapshotMembers: new Map(
      snapshots.map((s) => [
        byKey.get(canonicalCharacterId(s.rootKey))!,
        s.characters.map((c) => c.characterId)
      ])
    ),
    snapshotSources: new Map(
      snapshots.map((s) => [
        byKey.get(canonicalCharacterId(s.rootKey))!,
        new Map(s.characters.map((c) => [c.characterId, c.source]))
      ])
    )
  };
  const activeEvidence = await client.query<{
    region: CharacterKey["region"];
    realm_slug: string;
    normalized_name: string;
  }>(
    `SELECT DISTINCT e.region, e.realm_slug, e.normalized_name FROM character_evidence_runs e JOIN characters c ON c.region = e.region AND c.realm_slug = e.realm_slug AND c.normalized_name = e.normalized_name WHERE c.id = ANY($1::uuid[]) AND e.status IN ('queued', 'running', 'retrying')`,
    [ids]
  );
  return {
    activeEvidenceKeys: activeEvidence.rows.map((row) => ({
      region: row.region,
      realm: row.realm_slug,
      name: row.normalized_name
    })),
    groupId: root.group_id,
    storedMemberIds,
    graph,
    ownSnapshot,
    snapshots,
    runs,
    sweepStates: sweeps.rows.map((row) => ({
      key: {
        region: row.region,
        realm: row.realm_slug,
        name: row.normalized_name
      },
      lastPublishedAt: row.last_published_at,
      resumeAfter: row.resume_after,
      continuationFailures: row.continuation_failures
    })),
    negativeUntil
  };
}
