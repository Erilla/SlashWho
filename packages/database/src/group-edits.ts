import type { Pool, PoolClient } from "pg";
import {
  groupPageMembers,
  canonicalCharacterId,
  type CharacterKey
} from "@slashwho/domain";
import { COUNTING_LINKS } from "./counting-links";
import {
  lockRebuildShared,
  lockGroups,
  recomputeComponent
} from "./character-connections";
import { loadGroupRead } from "./group-reads";
import { withTransaction } from "./sql";
import type { ManualConnectionRepository } from "./repositories";

async function withEdit<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withTransaction(pool, async (client) => {
    await lockRebuildShared(client);
    await lockGroups(client);
    return work(client);
  });
}

async function rejected(
  client: Pick<PoolClient, "query">,
  root: CharacterKey,
  target: CharacterKey
): Promise<boolean> {
  const result = await client.query(
    `WITH RECURSIVE edges AS (${COUNTING_LINKS}), undirected AS (SELECT a, b FROM edges UNION SELECT b, a FROM edges),
    seeds(side, id) AS (SELECT 0, id FROM characters WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
      UNION ALL SELECT 1, id FROM characters WHERE region = $4 AND realm_slug = $5 AND normalized_name = $6),
    reach(side, id) AS (SELECT * FROM seeds UNION SELECT r.side, e.b FROM reach r JOIN undirected e ON e.a = r.id)
    SELECT 1 FROM character_connections c JOIN reach a ON a.side = 0 JOIN reach b ON b.side = 1
    WHERE c.kind = 'rejected' AND c.character_low_id = LEAST(a.id, b.id) AND c.character_high_id = GREATEST(a.id, b.id) LIMIT 1`,
    [
      root.region,
      root.realm,
      root.name,
      target.region,
      target.realm,
      target.name
    ]
  );
  return result.rowCount === 1;
}

export function createGroupEdits(
  pool: Pool
): Pick<
  ManualConnectionRepository,
  | "canAddGroupConnection"
  | "addGroupConnection"
  | "removeGroupConnection"
  | "setGroupExcluded"
> {
  return {
    canAddGroupConnection: async (root, target) =>
      !(await rejected(pool, root, target)),
    addGroupConnection: (root, target) =>
      withEdit(pool, async (client) => {
        if (await rejected(client, root, target)) return "rejected";
        const inserted = await client.query<{ root_character_id: string }>(
          `INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name)
        SELECT id, $4, $5, $6 FROM characters WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        ON CONFLICT DO NOTHING RETURNING root_character_id`,
          [
            root.region,
            root.realm,
            root.name,
            target.region,
            target.realm,
            target.name
          ]
        );
        const id = inserted.rows[0]?.root_character_id;
        if (!id) return "duplicate";
        await recomputeComponent(client, id);
        return "added";
      }),
    removeGroupConnection: (root, target) =>
      withEdit(pool, async (client) => {
        const read = await loadGroupRead(client, root, new Date());
        const id = read?.graph.idOf(root);
        if (!read || !id) return "missing";
        const makers = [
          ...new Set([
            id,
            ...read.storedMemberIds,
            ...groupPageMembers(id, read.graph)
          ])
        ];
        const targetId = read.graph.idOf(target);
        const targets = targetId
          ? [...read.graph.sharedIdentity(targetId)].flatMap((aliasId) => {
              const c = read.graph.characters.get(aliasId);
              return c ? [c.key] : [];
            })
          : [target];
        let removed = 0;
        for (const alias of targets) {
          const result = await client.query(
            `DELETE FROM manual_dossier_connections WHERE root_character_id = ANY($1::uuid[])
        AND connected_region = $2 AND connected_realm_slug = $3 AND connected_normalized_name = $4`,
            [makers, alias.region, alias.realm, alias.name]
          );
          removed += result.rowCount ?? 0;
        }
        if (!removed) return "missing";
        await recomputeComponent(client, id);
        return "removed";
      }),
    setGroupExcluded: (root, targets, excluded) =>
      withEdit(pool, async (client) => {
        const read = await loadGroupRead(client, root, new Date());
        const id = read?.graph.idOf(root);
        if (!read || !id) return "missing";
        const visible = groupPageMembers(id, read.graph);
        const makers = excluded
          ? [...visible]
          : [...new Set([id, ...read.storedMemberIds, ...visible])];
        let updated = false;
        for (const target of targets) {
          const targetId = read.graph.idOf(target);
          if (
            excluded &&
            (canonicalCharacterId(target) === canonicalCharacterId(root) ||
              (targetId && read.graph.sharedIdentity(id).has(targetId)))
          )
            continue;
          if (excluded && (!targetId || !visible.has(targetId))) {
            // Pending manual targets also remain reviewable.
            if (
              !read.graph.undiscoveredManualTargets.some(
                (row) =>
                  visible.has(row.makerId) &&
                  canonicalCharacterId(row.targetKey) ===
                    canonicalCharacterId(target)
              )
            )
              continue;
          }
          const values = [
            makers,
            target.region,
            target.realm,
            target.name,
            excluded
          ];
          const manual = await client.query(
            `UPDATE manual_dossier_connections SET excluded_at = CASE WHEN $5 THEN now() ELSE NULL END
          WHERE root_character_id = ANY($1::uuid[]) AND connected_region = $2 AND connected_realm_slug = $3 AND connected_normalized_name = $4`,
            values
          );
          if (!excluded) {
            await client.query(
              `DELETE FROM dossier_character_exclusions WHERE root_character_id = ANY($1::uuid[]) AND region = $2 AND realm_slug = $3 AND normalized_name = $4`,
              values.slice(0, 4)
            );
            updated = true;
          } else if (!manual.rowCount) {
            await client.query(
              `INSERT INTO dossier_character_exclusions (root_character_id, region, realm_slug, normalized_name)
            SELECT $5::uuid, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM dossier_character_exclusions
              WHERE root_character_id = ANY($1::uuid[]) AND region = $2 AND realm_slug = $3 AND normalized_name = $4) ON CONFLICT DO NOTHING`,
              [makers, target.region, target.realm, target.name, id]
            );
            updated = true;
          } else updated = true;
        }
        return updated ? "updated" : "missing";
      })
  };
}
