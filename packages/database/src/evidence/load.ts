import {
  type CharacterKey,
  isNonRaidZone,
  lookupRaidForEvidence
} from "@slashwho/domain";
import {
  type CharacterMythicKillRow,
  type CharacterMythicWipeRow,
  type CharacterTierBestParseRow,
  type EvidenceRunRow,
  evidenceRunColumns,
  mapCharacterMythicKill,
  mapCharacterMythicWipe,
  mapCharacterTierBestParse,
  mapEvidenceRun,
  mapParseMetric,
  parsePerformanceValues,
  tierBestParseColumns
} from "../mappers";
import type {
  CharacterTierBestParseInput,
  CompletedCharacterEvidence,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe
} from "../repositories";
import type { Queryable } from "../sql";

export async function loadCompletedEvidence(
  client: Queryable,
  key: CharacterKey
): Promise<CompletedCharacterEvidence | null> {
  // Two runs speak for a character, and they are usually the same one. The
  // newest publication holds the snapshot: every kill, wipe and parse there
  // is. The newest `full` publication holds what was last collected in full:
  // when, with what shortfall, when to retry, and the cutting edges. A
  // targeted tier search adds to the snapshot without re-reading any of that
  // (#450), so taking those facts from it would call untouched evidence
  // freshly checked.
  const selectRun = (scope: "any" | "full") =>
    client.query<EvidenceRunRow>(
      `SELECT ${evidenceRunColumns()}, evidence_version, publication_scope
       FROM character_evidence_runs
       WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
         AND status IN ('complete', 'partial')
         ${scope === "full" ? "AND publication_scope = 'full'" : ""}
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
      [key.region, key.realm, key.name]
    );
  const snapshot = (await selectRun("any")).rows[0];
  if (!snapshot) return null;
  // A character whose every publication is targeted has nothing better to
  // report than the snapshot itself. `reserveTierSearch` refuses a character
  // with no evidence, so this is only reachable after an operator removal.
  const run =
    snapshot.publication_scope === "tier"
      ? ((await selectRun("full")).rows[0] ?? snapshot)
      : snapshot;

  const killsResult = await client.query<CharacterMythicKillRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, killed_at, report_url, fight_url,
            guild_name, guild_region, guild_realm, uploader, historic_world_rank, historic_rank_checked_at, spec_name, spec_icon_url,
            damage_parse_state,
            damage_percentile, healing_parse_state, healing_percentile,
            boss_damage_parse_state, boss_damage_percentile, parses_read_at
     FROM character_mythic_kills
     WHERE evidence_run_id = $1
     ORDER BY killed_at, source_fight_key`,
    [snapshot.id]
  );
  const wipesResult = await client.query<CharacterMythicWipeRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, attempted_at, report_url, fight_url, guild_name, guild_realm, uploader
     FROM character_mythic_wipes
     WHERE evidence_run_id = $1
     ORDER BY raid_id, boss_order, attempted_at DESC, fight_url`,
    [snapshot.id]
  );
  const tierBestsResult = await client.query<CharacterTierBestParseRow>(
    `SELECT ${tierBestParseColumns}
     FROM character_tier_best_parses
     WHERE evidence_run_id = $1
     ORDER BY raid_id, boss_id`,
    [snapshot.id]
  );
  const cuttingEdgesResult = await client.query<{
    achievement_id: string;
    completed_at: Date;
  }>(
    `SELECT achievement_id, completed_at
       FROM character_evidence_cutting_edges
      WHERE evidence_run_id = $1
      ORDER BY achievement_id`,
    [run.id]
  );
  const blizzardPhase = await client.query<{ state: string }>(
    `SELECT state FROM character_evidence_run_phases
      WHERE run_id = $1 AND phase_id = 'blizzard_achievements'`,
    [run.id]
  );
  return {
    run: mapEvidenceRun(run),
    evidenceVersion: run.evidence_version,
    kills: killsResult.rows.map(mapCharacterMythicKill),
    wipes: wipesResult.rows.map(mapCharacterMythicWipe),
    tierBests: tierBestsResult.rows.map(mapCharacterTierBestParse),
    cuttingEdges: cuttingEdgesResult.rows.map((row) => ({
      achievementId: row.achievement_id,
      completedAt: row.completed_at.toISOString()
    })),
    cuttingEdgesCollected: blizzardPhase.rows[0]?.state === "completed",
    wipeCapable: snapshot.evidence_version >= 2
  };
}

/**
 * Parses already stored for a character, keyed by fight.
 *
 * Collection deliberately does not re-fetch a fight it has already hydrated, so
 * every publish — not only a partial one — has to carry those values forward.
 * Without this a complete run writes the skipped fights back blank.
 *
 * `id DESC` is not decoration. `loadCompletedEvidence` picks the run a dossier
 * shows with `completed_at DESC, id DESC`, so this has to break a tie the same
 * way or a publish can carry forward a copy of a fight the dossier does not
 * show. A tie in an ORDER BY leaving the winner to PostgreSQL's discretion is
 * exactly the shape of #331, which cost a day of oscillating coverage before
 * anyone could attribute it.
 */
export async function loadStoredPerformanceByFightUrl(
  client: Queryable,
  key: CharacterKey
): Promise<Map<string, ReturnType<typeof parsePerformanceValues>>> {
  const result = await client.query<
    Pick<
      CharacterMythicKillRow,
      | "fight_url"
      | "spec_name"
      | "spec_icon_url"
      | "damage_parse_state"
      | "damage_percentile"
      | "healing_parse_state"
      | "healing_percentile"
      | "boss_damage_parse_state"
      | "boss_damage_percentile"
    >
  >(
    `SELECT DISTINCT ON (k.fight_url)
            k.fight_url, k.spec_name, k.spec_icon_url,
            k.damage_parse_state, k.damage_percentile,
            k.healing_parse_state, k.healing_percentile,
            k.boss_damage_parse_state, k.boss_damage_percentile
     FROM character_mythic_kills k
     JOIN character_evidence_runs r ON r.id = k.evidence_run_id
     WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
       AND r.status IN ('complete', 'partial')
     ORDER BY k.fight_url, r.completed_at DESC NULLS LAST, r.id DESC`,
    [key.region, key.realm, key.name]
  );
  return new Map(
    result.rows.map((row) => [
      row.fight_url,
      parsePerformanceValues({
        spec:
          row.spec_name === null || row.spec_icon_url === null
            ? null
            : { name: row.spec_name, iconUrl: row.spec_icon_url },
        damage: mapParseMetric(row.damage_parse_state, row.damage_percentile),
        healing: mapParseMetric(
          row.healing_parse_state,
          row.healing_percentile
        ),
        bossDamage: mapParseMetric(
          row.boss_damage_parse_state,
          row.boss_damage_percentile
        )
      })
    ])
  );
}

/**
 * Tier bests already stored for a character, keyed by zone and encounter.
 *
 * One run reads only the newest few zones, so every publish — complete or
 * partial — has to carry the rest forward. Without this a run that reached
 * only the current tier would blank every earlier tier's best parse.
 */
export async function loadStoredTierBestParses(
  client: Queryable,
  key: CharacterKey
): Promise<
  Map<
    string,
    {
      tierBest: CharacterTierBestParseInput;
      performance: ReturnType<typeof parsePerformanceValues>;
      /** When this zone was actually read, preserved across carry-forward. */
      collectedAt: Date;
    }
  >
> {
  const result = await client.query<CharacterTierBestParseRow>(
    `SELECT DISTINCT ON (t.raid_id, t.boss_id)
            t.id, t.raid_id, t.raid_name, t.boss_id, t.boss_name,
            t.rankings_url, t.spec_name, t.spec_icon_url,
            t.damage_parse_state, t.damage_percentile,
            t.healing_parse_state, t.healing_percentile,
            t.boss_damage_parse_state, t.boss_damage_percentile,
            t.collected_at
     FROM character_tier_best_parses t
     JOIN character_evidence_runs r ON r.id = t.evidence_run_id
     WHERE r.region = $1 AND r.realm_slug = $2 AND r.normalized_name = $3
       AND r.status IN ('complete', 'partial')
     ORDER BY t.raid_id, t.boss_id, r.completed_at DESC NULLS LAST, r.id DESC`,
    [key.region, key.realm, key.name]
  );
  return new Map(
    result.rows.map((row) => {
      const { id, ...tierBest } = mapCharacterTierBestParse(row);
      void id;
      return [
        `${tierBest.raidId}\0${tierBest.bossId}`,
        {
          tierBest,
          performance: parsePerformanceValues(tierBest.performance),
          collectedAt: row.collected_at
        }
      ];
    })
  );
}

export async function loadPositiveEvidenceForPartial(
  client: Queryable,
  key: CharacterKey
): Promise<{
  kills: readonly StoredCharacterMythicKill[];
  wipes: readonly StoredCharacterMythicWipe[];
}> {
  const runs = await client.query<Pick<EvidenceRunRow, "id" | "status">>(
    `SELECT id, status
     FROM character_evidence_runs
     WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
       AND status IN ('complete', 'partial')
     ORDER BY completed_at DESC, id DESC`,
    [key.region, key.realm, key.name]
  );
  const baselineIndex = runs.rows.findIndex((run) => run.status === "complete");
  const relevantRuns =
    baselineIndex === -1 ? runs.rows : runs.rows.slice(0, baselineIndex + 1);
  const runIds = relevantRuns.map((run) => run.id);
  if (runIds.length === 0) return { kills: [], wipes: [] };
  // Every run in the window holds its own copy of each fight, and those copies
  // are identical on `(killed_at, source_fight_key)` -- so ordering by that
  // alone leaves which copy of a fight the caller sees up to the sort, which
  // PostgreSQL does not keep stable once the set outgrows a handful of rows.
  // The newest run's copy is the only correct one: it is the one every earlier
  // publish already merged into. Pick it explicitly (#326).
  const kills = await client.query<CharacterMythicKillRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, killed_at, report_url, fight_url,
            guild_name, guild_region, guild_realm, uploader, historic_world_rank, historic_rank_checked_at, spec_name, spec_icon_url,
            damage_parse_state, damage_percentile, healing_parse_state,
            healing_percentile, boss_damage_parse_state, boss_damage_percentile,
            parses_read_at
     FROM (
       SELECT DISTINCT ON (k.fight_url)
              k.id, k.raid_id, k.raid_name, k.boss_id, k.boss_name,
              k.journal_boss_id, k.boss_order, k.killed_at,
              k.report_url, k.fight_url, k.source_fight_key, k.guild_name,
              k.guild_region, k.guild_realm, k.uploader, k.historic_world_rank, k.historic_rank_checked_at, k.spec_name, k.spec_icon_url,
              k.damage_parse_state, k.damage_percentile,
              k.healing_parse_state, k.healing_percentile,
              k.boss_damage_parse_state, k.boss_damage_percentile,
              k.parses_read_at
         FROM character_mythic_kills k
         JOIN character_evidence_runs r ON r.id = k.evidence_run_id
        WHERE k.evidence_run_id = ANY($1::uuid[])
        ORDER BY k.fight_url, r.completed_at DESC NULLS LAST, r.id DESC
     ) k
     ORDER BY killed_at, source_fight_key`,
    [runIds]
  );
  const wipes = await client.query<CharacterMythicWipeRow>(
    `SELECT id, raid_id, raid_name, boss_id, boss_name, journal_boss_id,
            boss_order, attempted_at, report_url, fight_url, guild_name, guild_realm, uploader
     FROM (
       SELECT DISTINCT ON (w.fight_url)
              w.id, w.raid_id, w.raid_name, w.boss_id, w.boss_name,
              w.journal_boss_id, w.boss_order, w.attempted_at, w.report_url,
              w.fight_url, w.guild_name, w.guild_realm, w.uploader
         FROM character_mythic_wipes w
         JOIN character_evidence_runs r ON r.id = w.evidence_run_id
        WHERE w.evidence_run_id = ANY($1::uuid[])
        ORDER BY w.fight_url, r.completed_at DESC NULLS LAST, r.id DESC
     ) w
     ORDER BY raid_id, boss_order, attempted_at DESC, fight_url`,
    [runIds]
  );
  // Rows in a zone positively identified as not a raid stop being carried.
  // They were stored because a Mythic dungeon boss shares a difficulty with a
  // Mythic raid boss, and collection no longer produces them -- but a
  // character whose every publish is partial carries all its stored evidence
  // forward, so without this they would never drain and the counts they
  // inflate would stay wrong (#346). Keyed on identifying the zone as a
  // dungeon, never on failing to identify it as a raid: a new tier the
  // catalogue has not caught up with also fails to resolve, and dropping that
  // would delete real kills.
  return {
    kills: kills.rows
      .map(mapCharacterMythicKill)
      .filter((kill) => !isNonRaidZone(kill.raidName)),
    wipes: wipes.rows
      .map(mapCharacterMythicWipe)
      .filter((wipe) => !isNonRaidZone(wipe.raidName))
  };
}

/**
 * A tier search can confirm an old exact report that `recentReports` will
 * never return to an ordinary scan. Keep the newest published search's kills
 * for its selected raid across complete ordinary runs. A search is additive
 * (#450), so its snapshot already holds every kill an earlier one confirmed.
 */
export async function loadLatestTierSearchKills(
  client: Queryable,
  key: CharacterKey
): Promise<readonly StoredCharacterMythicKill[]> {
  const result = await client.query<
    CharacterMythicKillRow & { tier_search_raid_id: string }
  >(
    `WITH latest AS (
       SELECT DISTINCT ON (tier_search_raid_id)
              id, tier_search_raid_id
         FROM character_evidence_runs
        WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
          AND mode = 'tier_search' AND status IN ('complete', 'partial')
        ORDER BY tier_search_raid_id, completed_at DESC, id DESC
     )
     SELECT kill.*, latest.tier_search_raid_id
       FROM latest
       JOIN character_mythic_kills kill ON kill.evidence_run_id = latest.id`,
    [key.region, key.realm, key.name]
  );
  return result.rows
    .map((row) => ({
      kill: mapCharacterMythicKill(row),
      journalRaidId: row.tier_search_raid_id
    }))
    .filter(
      ({ kill, journalRaidId }) =>
        lookupRaidForEvidence(kill)?.raidId === journalRaidId
    )
    .map(({ kill }) => kill);
}
