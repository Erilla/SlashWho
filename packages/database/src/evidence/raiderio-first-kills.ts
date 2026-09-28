import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";

import type {
  CharacterRaiderIoFirstKillInput,
  PublishedRaiderIoLoggedEncounter,
  RaiderIoLoggedEncounterAnswers,
  RaiderIoLoggedEncounterRole,
  RaiderIoLoggedEncounterUnavailableCode,
  StoredCharacterRaiderIoFirstKill,
  StoredRaiderIoLoggedEncounter,
  StoredRaiderIoLoggedEncounterAnswers
} from "../repositories";
import { withTransaction, type Queryable } from "../sql";
import { insertEvidenceRows } from "./rows";

// `bigint` columns arrive from `pg` as text; every id here is far below 2^53.
type FirstKillRow = {
  raid_slug: string;
  boss_slug: string;
  killed_at: Date;
  guild_name: string | null;
  guild_realm: string | null;
  guild_region: string | null;
  logged_encounter_id: string | null;
  encounter_state: "read" | "unavailable";
  encounter_limitation_code: string | null;
  historic_world_rank: number | null;
  historic_rank_checked_at: Date | null;
};

// A read row carries every kill column and an unavailable row only its code;
// `raiderio_logged_encounters_answer_check` guarantees one or the other.
type EncounterRow = {
  logged_encounter_id: string;
  unavailable_code: RaiderIoLoggedEncounterUnavailableCode | null;
  raid_slug: string | null;
  boss_slug: string | null;
  pulled_at: Date | null;
  defeated_at: Date | null;
  duration_ms: number | null;
  guild_name: string | null;
  guild_realm: string | null;
  guild_region: string | null;
  item_level_average: number | null;
  item_level_min: number | null;
  item_level_max: number | null;
  death_count: number | null;
  vantus_count: number | null;
  roster_state: "available" | "private" | null;
  read_at: Date;
};

type MemberRow = {
  logged_encounter_id: string;
  raiderio_character_id: string;
  name: string;
  realm: string;
  region: string;
  class_name: string;
  spec_name: string;
  role: RaiderIoLoggedEncounterRole;
  item_level: number | null;
};

type RoleCountRow = {
  logged_encounter_id: string;
  role: RaiderIoLoggedEncounterRole;
  count: number;
};

function guildOf(
  name: string | null,
  realm: string | null,
  region: string | null
): { name: string; realm: string; region: string } | null {
  return name === null || realm === null || region === null
    ? null
    : { name, realm, region };
}

function required<T>(value: T | null): T {
  // The answer check makes every kill column of a read row NOT NULL.
  if (value === null) throw new Error("raiderio_logged_encounter_row_invalid");
  return value;
}

function mapFirstKill(row: FirstKillRow): CharacterRaiderIoFirstKillInput {
  return {
    raidSlug: row.raid_slug,
    bossSlug: row.boss_slug,
    killedAt: row.killed_at.toISOString(),
    guild: guildOf(row.guild_name, row.guild_realm, row.guild_region),
    loggedEncounterId:
      row.logged_encounter_id === null ? null : Number(row.logged_encounter_id),
    encounterState: row.encounter_state,
    encounterLimitationCode: row.encounter_limitation_code,
    historicWorldRank: row.historic_world_rank,
    historicRankCheckedAt: row.historic_rank_checked_at?.toISOString() ?? null
  };
}

async function loadRunRaiderIoFirstKills(
  client: Queryable,
  runId: string
): Promise<CharacterRaiderIoFirstKillInput[]> {
  const result = await client.query<FirstKillRow>(
    `SELECT raid_slug, boss_slug, killed_at, guild_name, guild_realm,
            guild_region, logged_encounter_id, encounter_state,
            encounter_limitation_code, historic_world_rank,
            historic_rank_checked_at
       FROM character_raiderio_first_kills
      WHERE evidence_run_id = $1
      ORDER BY killed_at, raid_slug, boss_slug`,
    [runId]
  );
  return result.rows.map(mapFirstKill);
}

/**
 * The first kills of the character's newest publication. Every publish writes
 * the whole merged set, so the newest run holds all of it; the tie is broken
 * as `loadCompletedEvidence` breaks it, so this is the run a dossier shows.
 */
export async function loadLatestRaiderIoFirstKills(
  client: Queryable,
  key: CharacterKey
): Promise<CharacterRaiderIoFirstKillInput[]> {
  const run = await client.query<{ id: string }>(
    `SELECT id
       FROM character_evidence_runs
      WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
        AND status IN ('complete', 'partial')
      ORDER BY completed_at DESC, id DESC
      LIMIT 1`,
    [key.region, key.realm, key.name]
  );
  const runId = run.rows[0]?.id;
  return runId === undefined ? [] : loadRunRaiderIoFirstKills(client, runId);
}

async function selectEncounterRows(
  client: Queryable,
  ids: readonly number[]
): Promise<EncounterRow[]> {
  const result = await client.query<EncounterRow>(
    `SELECT logged_encounter_id, unavailable_code, raid_slug, boss_slug,
            pulled_at, defeated_at, duration_ms, guild_name, guild_realm,
            guild_region, item_level_average, item_level_min, item_level_max,
            death_count, vantus_count, roster_state, read_at
       FROM raiderio_logged_encounters
      WHERE logged_encounter_id = ANY($1::bigint[])
      ORDER BY logged_encounter_id`,
    [ids]
  );
  return result.rows;
}

/**
 * The roster rows of these encounters. With `shownOnly`, a raider under an
 * active suppression is left out by the same test `snapshots.ts` applies to
 * a dossier's own characters, so a removed character never appears on anyone
 * else's dossier. The rows themselves are kept.
 */
async function selectMemberRows(
  client: Queryable,
  ids: readonly number[],
  shownOnly: boolean
): Promise<Map<string, MemberRow[]>> {
  const result = await client.query<MemberRow>(
    `SELECT member.logged_encounter_id, member.raiderio_character_id,
            member.name, member.realm, member.region, member.class_name,
            member.spec_name, member.role, member.item_level
       FROM raiderio_logged_encounter_members member
      WHERE member.logged_encounter_id = ANY($1::bigint[])
        AND (NOT $2::boolean OR NOT EXISTS (
          SELECT 1
            FROM suppressed_characters suppression
           WHERE suppression.region = member.region
             AND suppression.realm_slug = member.realm
             AND suppression.normalized_name = member.normalized_name
             AND (suppression.expires_at IS NULL OR suppression.expires_at > now())
        ))
      ORDER BY member.logged_encounter_id, member.raiderio_character_id`,
    [ids, shownOnly]
  );
  const byEncounter = new Map<string, MemberRow[]>();
  for (const member of result.rows) {
    byEncounter.set(member.logged_encounter_id, [
      ...(byEncounter.get(member.logged_encounter_id) ?? []),
      member
    ]);
  }
  return byEncounter;
}

function mapEncounter(
  row: EncounterRow,
  members: readonly MemberRow[]
): StoredRaiderIoLoggedEncounter {
  return {
    loggedEncounterId: Number(row.logged_encounter_id),
    raidSlug: required(row.raid_slug),
    bossSlug: required(row.boss_slug),
    pulledAt: required(row.pulled_at).toISOString(),
    defeatedAt: required(row.defeated_at).toISOString(),
    durationMs: required(row.duration_ms),
    guild: guildOf(row.guild_name, row.guild_realm, row.guild_region),
    itemLevel: {
      average: required(row.item_level_average),
      min: required(row.item_level_min),
      max: required(row.item_level_max)
    },
    deathCount: required(row.death_count),
    vantusCount: required(row.vantus_count),
    rosterState: required(row.roster_state),
    members: members.map((member) => ({
      raiderIoCharacterId: Number(member.raiderio_character_id),
      name: member.name,
      realm: member.realm,
      region: member.region,
      className: member.class_name,
      specName: member.spec_name,
      role: member.role,
      itemLevel: member.item_level
    })),
    readAt: row.read_at.toISOString()
  };
}

/**
 * The stored answers among these ids, for collection: each read encounter
 * with its whole roster (the presence check needs every raider and shows
 * none), and each permanent refusal with its code.
 */
export async function loadRaiderIoLoggedEncounters(
  client: Queryable,
  ids: readonly number[]
): Promise<StoredRaiderIoLoggedEncounterAnswers> {
  if (ids.length === 0) return { encounters: [], unavailable: [] };
  const rows = await selectEncounterRows(client, ids);
  const members = await selectMemberRows(client, ids, false);
  return {
    encounters: rows
      .filter((row) => row.unavailable_code === null)
      .map((row) =>
        mapEncounter(row, members.get(row.logged_encounter_id) ?? [])
      ),
    unavailable: rows.flatMap((row) =>
      row.unavailable_code === null
        ? []
        : [
            {
              loggedEncounterId: Number(row.logged_encounter_id),
              code: row.unavailable_code,
              readAt: row.read_at.toISOString()
            }
          ]
    )
  };
}

/**
 * The read encounters among these ids as a dossier may show them: suppressed
 * raiders left off, and every raider Raider.IO listed still counted by role.
 */
async function loadShownRaiderIoLoggedEncounters(
  client: Queryable,
  ids: readonly number[]
): Promise<PublishedRaiderIoLoggedEncounter[]> {
  if (ids.length === 0) return [];
  const rows = (await selectEncounterRows(client, ids)).filter(
    (row) => row.unavailable_code === null
  );
  const members = await selectMemberRows(client, ids, true);
  const counted = await client.query<RoleCountRow>(
    `SELECT logged_encounter_id, role, count(*)::int AS count
       FROM raiderio_logged_encounter_members
      WHERE logged_encounter_id = ANY($1::bigint[])
      GROUP BY logged_encounter_id, role`,
    [ids]
  );
  const roleCounts = new Map<
    string,
    Record<RaiderIoLoggedEncounterRole, number>
  >();
  for (const row of counted.rows) {
    const counts = roleCounts.get(row.logged_encounter_id) ?? {
      tank: 0,
      healer: 0,
      dps: 0
    };
    counts[row.role] = row.count;
    roleCounts.set(row.logged_encounter_id, counts);
  }
  return rows.map((row) => ({
    ...mapEncounter(row, members.get(row.logged_encounter_id) ?? []),
    roleCounts: roleCounts.get(row.logged_encounter_id) ?? {
      tank: 0,
      healer: 0,
      dps: 0
    }
  }));
}

/** One run's first kills, each with the stored encounter it names, as a dossier may show it. */
export async function loadPublishedRaiderIoFirstKills(
  client: Queryable,
  runId: string
): Promise<StoredCharacterRaiderIoFirstKill[]> {
  const kills = await loadRunRaiderIoFirstKills(client, runId);
  const readIds = kills.flatMap((kill) =>
    kill.encounterState === "read" && kill.loggedEncounterId !== null
      ? [kill.loggedEncounterId]
      : []
  );
  const encounters = new Map(
    (await loadShownRaiderIoLoggedEncounters(client, readIds)).map(
      (encounter) => [encounter.loggedEncounterId, encounter] as const
    )
  );
  return kills.map((kill) => ({
    ...kill,
    encounter:
      kill.encounterState === "read" && kill.loggedEncounterId !== null
        ? (encounters.get(kill.loggedEncounterId) ?? null)
        : null
  }));
}

/**
 * Stores what one run learned, in one transaction. A visible roster is kept
 * as first read: the kill and who was in it never change. A private roster
 * or a permanent refusal is replaced by a later read. A permanent refusal
 * replaces only another refusal, never a read: a later failure does not
 * unread a kill.
 */
export async function storeRaiderIoLoggedEncounters(
  pool: Pool,
  answers: RaiderIoLoggedEncounterAnswers,
  readAt: Date
): Promise<void> {
  if (answers.encounters.length === 0 && answers.unavailable.length === 0)
    return;
  await withTransaction(pool, async (client) => {
    for (const encounter of answers.encounters) {
      const written = await client.query(
        `INSERT INTO raiderio_logged_encounters (
           logged_encounter_id, unavailable_code, raid_slug, boss_slug,
           pulled_at, defeated_at, duration_ms, guild_name, guild_realm,
           guild_region, item_level_average, item_level_min, item_level_max,
           death_count, vantus_count, roster_state, read_at
         ) VALUES ($1::bigint, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                   $12, $13, $14, $15, $16)
         ON CONFLICT (logged_encounter_id) DO UPDATE SET
           unavailable_code = NULL,
           raid_slug = EXCLUDED.raid_slug,
           boss_slug = EXCLUDED.boss_slug,
           pulled_at = EXCLUDED.pulled_at,
           defeated_at = EXCLUDED.defeated_at,
           duration_ms = EXCLUDED.duration_ms,
           guild_name = EXCLUDED.guild_name,
           guild_realm = EXCLUDED.guild_realm,
           guild_region = EXCLUDED.guild_region,
           item_level_average = EXCLUDED.item_level_average,
           item_level_min = EXCLUDED.item_level_min,
           item_level_max = EXCLUDED.item_level_max,
           death_count = EXCLUDED.death_count,
           vantus_count = EXCLUDED.vantus_count,
           roster_state = EXCLUDED.roster_state,
           read_at = EXCLUDED.read_at
         WHERE raiderio_logged_encounters.roster_state IS DISTINCT FROM 'available'`,
        [
          encounter.loggedEncounterId,
          encounter.raidSlug,
          encounter.bossSlug,
          encounter.pulledAt,
          encounter.defeatedAt,
          encounter.durationMs,
          encounter.guild?.name ?? null,
          encounter.guild?.realm ?? null,
          encounter.guild?.region ?? null,
          encounter.itemLevel.average,
          encounter.itemLevel.min,
          encounter.itemLevel.max,
          encounter.deathCount,
          encounter.vantusCount,
          encounter.rosterState,
          readAt
        ]
      );
      // A visible roster already held: nothing was written, nothing changes.
      if (written.rowCount !== 1) continue;
      await client.query(
        `DELETE FROM raiderio_logged_encounter_members
          WHERE logged_encounter_id = $1::bigint`,
        [encounter.loggedEncounterId]
      );
      const members = encounter.members;
      if (members.length === 0) continue;
      await client.query(
        `INSERT INTO raiderio_logged_encounter_members (
           logged_encounter_id, raiderio_character_id, name, normalized_name,
           realm, region, class_name, spec_name, role, item_level
         )
         SELECT $1::bigint, item.*
           FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[],
                       $6::text[], $7::text[], $8::text[], $9::text[],
                       $10::double precision[])
             AS item(raiderio_character_id, name, normalized_name, realm,
                     region, class_name, spec_name, role, item_level)
         ON CONFLICT DO NOTHING`,
        [
          encounter.loggedEncounterId,
          members.map((member) => member.raiderIoCharacterId),
          members.map((member) => member.name),
          // As every character key and every suppression is normalised.
          members.map((member) => member.name.toLocaleLowerCase("en-US")),
          members.map((member) => member.realm),
          members.map((member) => member.region),
          members.map((member) => member.className),
          members.map((member) => member.specName),
          members.map((member) => member.role),
          members.map((member) => member.itemLevel)
        ]
      );
    }
    for (const answer of answers.unavailable) {
      await client.query(
        `INSERT INTO raiderio_logged_encounters (
           logged_encounter_id, unavailable_code, read_at
         ) VALUES ($1::bigint, $2, $3)
         ON CONFLICT (logged_encounter_id) DO UPDATE SET
           unavailable_code = EXCLUDED.unavailable_code,
           read_at = EXCLUDED.read_at
         WHERE raiderio_logged_encounters.unavailable_code IS NOT NULL`,
        [answer.loggedEncounterId, answer.code, readAt]
      );
    }
  });
}

/** One run's first kills, in one statement, inside the publish transaction. */
export async function insertRaiderIoFirstKills(
  client: Queryable,
  runId: string,
  kills: readonly CharacterRaiderIoFirstKillInput[]
): Promise<void> {
  await insertEvidenceRows(
    client,
    "character_raiderio_first_kills",
    runId,
    [
      ["raid_slug", "text", (kill) => kill.raidSlug],
      ["boss_slug", "text", (kill) => kill.bossSlug],
      ["killed_at", "timestamptz", (kill) => kill.killedAt],
      ["guild_name", "text", (kill) => kill.guild?.name ?? null],
      ["guild_realm", "text", (kill) => kill.guild?.realm ?? null],
      ["guild_region", "text", (kill) => kill.guild?.region ?? null],
      ["logged_encounter_id", "bigint", (kill) => kill.loggedEncounterId],
      ["encounter_state", "text", (kill) => kill.encounterState],
      [
        "encounter_limitation_code",
        "text",
        (kill) => kill.encounterLimitationCode
      ],
      ["historic_world_rank", "integer", (kill) => kill.historicWorldRank],
      [
        "historic_rank_checked_at",
        "timestamptz",
        (kill) => kill.historicRankCheckedAt
      ]
    ],
    kills
  );
}
