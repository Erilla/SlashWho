import {
  currentContentEligibilityByRaidId,
  lookupRaidByName,
  lookupRaidForEvidence,
  isValidCharacterKey,
  type CharacterKey
} from "@slashwho/domain";

import { MYTHIC_DIFFICULTY } from "../queries";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsLimitation,
  WarcraftLogsReportResult
} from "../types";
import {
  nonEmptyString,
  nonNegativeInteger,
  normalizedRealm,
  positiveInteger,
  record
} from "./primitives";
import { decodedHydratedReport } from "./reports";

/**
 * The zones and partitions whose rankings can hold a journal raid's kills.
 *
 * A zone that names the raid is walked whole, as it always was. A zone that
 * names no raid at all -- Warcraft Logs files the opening Midnight raids under
 * one `VS / DR / MQD` zone -- is walked only when one of its encounters is the
 * raid's boss, and then only for those encounters, so a Voidspire walk does not
 * spend its cap hydrating Dreamrift fights the decoder would discard. A zone
 * that names a different raid is treated the same way, because Warcraft Logs
 * also ranks a season under one raid's name: zone 53, `The Venomous Abyss`,
 * holds The Tidebound Grotto's boss too (#729). Its bosses place a kill only
 * within the named raid's own tier, so older single-raid tiers keep exactly
 * the zones they had.
 */
export function historicZoneIds(
  value: unknown,
  journalRaidId: string
): {
  zoneIds: number[];
  partitionIds: number[];
  zoneEncounterIds: (number[] | null)[];
} | null {
  const zones = record(record(record(value)?.data)?.worldData)?.zones;
  if (!Array.isArray(zones)) return null;
  const scopes = new Set<string>();
  const encounterFilters = new Map<number, number[] | null>();
  for (const value of zones) {
    const zone = record(value);
    const id = positiveInteger(zone?.id);
    const name = nonEmptyString(zone?.name);
    if (!id || !name) return null;
    const named = lookupRaidByName(name);
    let filter: number[] | null = null;
    if (named?.raidId !== journalRaidId) {
      const members = raidEncountersInZone(
        zone?.encounters,
        name,
        journalRaidId
      );
      // Another raid's zone was once skipped unread; its malformed encounter
      // list must not now fail a walk it only possibly contributes to.
      if (!members) {
        if (named !== null) continue;
        return null;
      }
      if (members.length === 0) continue;
      filter = members;
    }
    if (!Array.isArray(zone?.partitions)) return null;
    const partitions = zone.partitions.length ? zone.partitions : [{ id: -1 }];
    for (const value of partitions) {
      const partitionId = Number(record(value)?.id);
      if (!Number.isSafeInteger(partitionId) || partitionId === 0) return null;
      scopes.add(`${id}:${partitionId}`);
    }
    encounterFilters.set(id, filter);
  }
  const ordered = [...scopes]
    .map((scope) => scope.split(":").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    zoneIds: ordered.map(([zoneId]) => zoneId),
    partitionIds: ordered.map(([, partitionId]) => partitionId),
    zoneEncounterIds: ordered.map(
      ([zoneId]) => encounterFilters.get(zoneId) ?? null
    )
  };
}

/**
 * The encounters of a raid-less zone that belong to the journal raid, resolved
 * boss by boss exactly as a kill in that zone is (`lookupRaidForEvidence`), so
 * the walk selects precisely the fights the decoder will keep.
 */
function raidEncountersInZone(
  value: unknown,
  zoneName: string,
  journalRaidId: string
): number[] | null {
  // Dungeon, Mythic+ and PvP zones also name no raid; one without an encounter
  // list simply has none of the raid's bosses.
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const members: number[] = [];
  for (const item of value) {
    const encounter = record(item);
    const id = positiveInteger(encounter?.id);
    const bossName = nonEmptyString(encounter?.name);
    if (!id || !bossName) return null;
    const raid = lookupRaidForEvidence({
      raidName: zoneName,
      bossName,
      journalBossId: null
    });
    if (raid?.raidId === journalRaidId) members.push(id);
  }
  return members.sort((a, b) => a - b);
}

const UNRANKED_METRIC_ERROR = "Invalid class or spec number specified.";

export function historicEncounterIds(
  value: unknown,
  characterId?: number
): { id: number; encounters: number[] } | null {
  const character = record(
    record(record(value)?.data)?.characterData
  )?.character;
  const entry = record(character);
  const id = positiveInteger(entry?.id);
  if (!id || (characterId !== undefined && id !== characterId)) return null;
  const encounters = new Set<number>();
  for (const metric of ["damage", "healing"] as const) {
    // A metric a character never ranked in may be null (for example hps on
    // a damage-only character). That is an empty result, not schema drift.
    if (entry?.[metric] === null) continue;
    // Warcraft Logs can also answer a metric with an error object in place of
    // its rankings, and no GraphQL `errors` entry. This one arrives for
    // characters that do rank in the metric, so it says only that the metric
    // has no rankings here. Any other error still reads as drift.
    if (record(entry?.[metric])?.error === UNRANKED_METRIC_ERROR) continue;
    const rankings = record(entry?.[metric])?.rankings;
    if (!Array.isArray(rankings)) return null;
    for (const value of rankings) {
      const rank = record(value);
      const encounterId =
        positiveInteger(rank?.encounterID) ??
        positiveInteger(record(rank?.encounter)?.id);
      const kills = nonNegativeInteger(rank?.totalKills);
      if (!encounterId || kills === null) return null;
      if (kills > 0) encounters.add(encounterId);
    }
  }
  return { id, encounters: [...encounters].sort((a, b) => a - b) };
}

export function historicReportRefs(
  value: unknown
): { code: string; fightId: number; spec?: string }[] | null {
  const character = record(
    record(record(value)?.data)?.characterData
  )?.character;
  const entry = record(character);
  if (!entry) return null;
  if (entry.encounterRankings === null) return [];
  const ranks = record(entry.encounterRankings)?.ranks;
  if (!Array.isArray(ranks)) return null;
  const refs: { code: string; fightId: number; spec?: string }[] = [];
  for (const value of ranks) {
    const rank = record(value);
    if (rank?.report === null) continue;
    const report = record(rank?.report);
    const code = nonEmptyString(report?.code);
    const fightId = positiveInteger(report?.fightID);
    if (!code || !fightId) return null;
    if (!refs.some((ref) => ref.code === code && ref.fightId === fightId)) {
      const spec = nonEmptyString(rank?.spec);
      refs.push({ code, fightId, ...(spec ? { spec } : {}) });
    }
  }
  return refs;
}

/**
 * The name and realm the character was ranked under in a hydrated ranked
 * report, proved by canonical id, or null when the report does not say. A
 * character renamed since raided under this name, and it is the only name
 * the guild's attendance for that night can list (#733).
 */
export function rankedCharacterName(
  value: unknown,
  characterId: number
): Readonly<{ name: string; realm: string }> | null {
  const report = record(record(record(value)?.data)?.reportData)?.report;
  const ranked = record(report)?.rankedCharacters;
  if (!Array.isArray(ranked)) return null;
  const matches = ranked
    .map(record)
    .filter((item) => positiveInteger(item?.canonicalID) === characterId);
  if (matches.length !== 1) return null;
  const name = nonEmptyString(matches[0]?.name);
  const realm = nonEmptyString(record(matches[0]?.server)?.slug);
  return name && realm ? { name, realm } : null;
}

/**
 * A hydrated report decoded under the name the character was ranked under
 * in it, when that name is not the key's: a renamed character raided under
 * a former name, which the key cannot match (#733). Null when the report
 * ranks nobody by that canonical id, or ranks them under the key's own name.
 */
export function decodedUnderRankedName(
  value: unknown,
  key: CharacterKey,
  characterId: number | undefined
): WarcraftLogsReportResult | null {
  if (characterId === undefined) return null;
  const ranked = rankedCharacterName(value, characterId);
  if (!ranked) return null;
  const identity = {
    region: key.region,
    realm: ranked.realm.toLocaleLowerCase("en-US"),
    name: ranked.name.normalize("NFC").toLocaleLowerCase("en-US")
  };
  if (
    !isValidCharacterKey(identity) ||
    (identity.name === key.name && identity.realm === key.realm)
  ) {
    return null;
  }
  return decodedHydratedReport(value, identity);
}

/**
 * The character's Mythic kills in one hydrated ranked report: every kill of
 * the zone's ranked encounters, not only the ranked fight that led to the
 * report, so a raid night is read once for all its bosses (#712). Identity is
 * proved once for the report, by canonical id and a unique actor, and each
 * kill still needs that actor among its fight's players.
 *
 * The ranking's spec is not checked against the fight. It was a secondary
 * check on the one fight a read was for; applied to that fight alone, it made
 * the kills a read credits depend on which boss the walk reached first. A
 * spec the log records differently makes the kill no less the character's.
 *
 * A report that ranks nobody (`rankedCharacters: null`, as 2017 logs do) is
 * proved by the ranking instead: see `actorProvedByRanking` (#742).
 */
export function decodedRankedKills(
  value: unknown,
  expected: {
    code: string;
    /** The ranked fight that led here, and the spec it was ranked as. */
    ranked: Readonly<{ fightId: number; spec?: string }>;
    zoneId: number;
    /** The zone's encounters the character is ranked on. */
    encounterIds: readonly number[];
    characterId: number;
    journalRaidId: string;
    region: CharacterKey["region"];
    /**
     * The names, with realm slug, the character is known to have raided
     * under: the current one, linked former ones, and any the walk proved.
     */
    knownNames: readonly Readonly<{ name: string; realm: string }>[];
  }
): readonly WarcraftLogsFirstKillEvidence[] | WarcraftLogsLimitation {
  const report = record(record(record(value)?.data)?.reportData)?.report;
  if (report === null) return [];
  const entry = record(report);
  if (!entry || entry.code !== expected.code)
    return { kind: "limitation", code: "schema_drift" };
  if (positiveInteger(record(entry.zone)?.id) !== expected.zoneId) return [];
  const fights = entry.fights;
  if (!Array.isArray(fights))
    return { kind: "limitation", code: "schema_drift" };
  const ranked = entry.rankedCharacters;
  const actors = record(entry.masterData)?.actors;
  // The ranking named this fight a Mythic kill of this report. A kills-only
  // read that leaves it out is not the report the ranking described.
  const rankedFight = fights
    .map(record)
    .find((fight) => positiveInteger(fight?.id) === expected.ranked.fightId);
  if (!rankedFight) return { kind: "limitation", code: "schema_drift" };
  if (!Array.isArray(actors))
    return { kind: "limitation", code: "schema_drift" };
  const alias =
    ranked === null
      ? actorProvedByRanking(rankedFight, actors, expected)
      : Array.isArray(ranked)
        ? actorProvedByCanonicalId(ranked, actors, expected)
        : undefined;
  if (alias === undefined) return { kind: "limitation", code: "schema_drift" };
  if (alias === null) return [];
  const decoded = decodedHydratedReport(value, alias);
  if (decoded.kind !== "evidence") return decoded;
  if (decoded.limitation) return decoded.limitation;
  const encounters = new Set(expected.encounterIds.map(String));
  return decoded.kills.filter(
    (kill) =>
      kill.reportCode === expected.code &&
      encounters.has(kill.bossId) &&
      kill.difficulty === MYTHIC_DIFFICULTY &&
      // A combined zone's fights name no raid, so the boss has to place them.
      lookupRaidForEvidence(kill)?.raidId === expected.journalRaidId &&
      currentContentEligibilityByRaidId(
        kill.killedAt,
        expected.journalRaidId
      ) === true
  );
}

/**
 * The report's actor for the character, proved by the report's own
 * `rankedCharacters`: the one entry with the character's canonical id, and
 * the one actor that entry's name and server describe. Null when either is
 * missing or ambiguous.
 */
function actorProvedByCanonicalId(
  ranked: readonly unknown[],
  actors: readonly unknown[],
  expected: Readonly<{ characterId: number; region: CharacterKey["region"] }>
): CharacterKey | null {
  const identities = ranked.map(record);
  const canonical = identities.filter(
    (item) => positiveInteger(item?.canonicalID) === expected.characterId
  );
  if (canonical.length !== 1) return null;
  const same = (
    item: Record<string, unknown> | null,
    actor: Record<string, unknown> | null
  ) => {
    const server = record(item?.server);
    return (
      typeof item?.name === "string" &&
      typeof server?.name === "string" &&
      typeof actor?.name === "string" &&
      typeof actor.server === "string" &&
      item.name.toLocaleLowerCase("en-US") ===
        actor.name.toLocaleLowerCase("en-US") &&
      server.name.toLocaleLowerCase("en-US") ===
        actor.server.toLocaleLowerCase("en-US")
    );
  };
  const matches = actors
    .map(record)
    .filter(
      (actor) =>
        actor?.type === "Player" &&
        same(canonical[0]!, actor) &&
        identities.filter((item) => same(item, actor)).length === 1
    );
  if (matches.length !== 1) return null;
  const actor = matches[0]!;
  return {
    region: expected.region,
    realm: String(actor.server).toLocaleLowerCase("en-US"),
    name: String(actor.name).toLocaleLowerCase("en-US")
  };
}

/**
 * The report's actor for the character, proved by the ranking alone, for a
 * report that ranks nobody (#742). The ranking is the character's own, asked
 * for by Warcraft Logs id, and it names this fight, so the character was one
 * of its players. The one player there carrying a name the character is
 * known by, and logged as the spec the ranking gives, is them.
 *
 * A name nobody knows proves nothing: a character renamed since raided under
 * a name only a link, or another report's `rankedCharacters`, can supply.
 * Two players with known names, a spec that differs, or specs that are
 * missing prove nothing either. Null in each case; undefined when the
 * fight's players have drifted.
 */
function actorProvedByRanking(
  fight: Record<string, unknown>,
  actors: readonly unknown[],
  expected: Readonly<{
    ranked: Readonly<{ spec?: string }>;
    region: CharacterKey["region"];
    knownNames: readonly Readonly<{ name: string; realm: string }>[];
  }>
): CharacterKey | null | undefined {
  const players = fight.friendlyPlayers;
  const specs = fight.friendlySpecs;
  if (!Array.isArray(players)) return undefined;
  // The spec is the cross-check. A fight whose specs are missing, or do not
  // line up with its players, proves nothing, and credits nothing: failing
  // the walk on it would park every later press on this one report.
  if (!Array.isArray(specs) || players.length !== specs.length) return null;
  const spec = expected.ranked.spec?.toLocaleLowerCase("en-US");
  if (!spec) return null;
  const known = new Map(
    expected.knownNames.map((item) => {
      const name = item.name.normalize("NFC").toLocaleLowerCase("en-US");
      return [`${normalizedRealm(item.realm)}\0${name}`, item] as const;
    })
  );
  const byId = new Map(
    actors
      .map(record)
      .filter((actor) => actor?.type === "Player")
      .map((actor) => [positiveInteger(actor?.id), actor] as const)
  );
  const matches = players.flatMap((id: unknown, index) => {
    const actor = byId.get(positiveInteger(id));
    const name = nonEmptyString(actor?.name);
    const server = nonEmptyString(actor?.server);
    if (!name || !server) return [];
    const item = known.get(
      `${normalizedRealm(server)}\0${name.normalize("NFC").toLocaleLowerCase("en-US")}`
    );
    return item ? [{ item, spec: specs[index] as unknown }] : [];
  });
  if (matches.length !== 1) return null;
  const { item, spec: logged } = matches[0]!;
  if (typeof logged !== "string" || logged.toLocaleLowerCase("en-US") !== spec)
    return null;
  const alias = {
    region: expected.region,
    realm: item.realm.toLocaleLowerCase("en-US"),
    name: item.name.normalize("NFC").toLocaleLowerCase("en-US")
  };
  return isValidCharacterKey(alias) ? alias : null;
}
