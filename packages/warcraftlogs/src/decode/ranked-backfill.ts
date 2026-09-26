import {
  currentContentEligibilityByRaidId,
  lookupRaidByName,
  lookupRaidForEvidence,
  type CharacterKey
} from "@slashwho/domain";

import { MYTHIC_DIFFICULTY } from "../queries";
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsLimitation
} from "../types";
import {
  nonEmptyString,
  nonNegativeInteger,
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
 * that names a different raid is never taken on the strength of its bosses:
 * older single-raid tiers keep exactly the zones they had.
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
    if (named === null) {
      const members = raidEncountersInZone(
        zone?.encounters,
        name,
        journalRaidId
      );
      if (!members) return null;
      if (members.length === 0) continue;
      filter = members;
    } else if (named.raidId !== journalRaidId) continue;
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

export function decodedRankedKill(
  value: unknown,
  expected: {
    code: string;
    fightId: number;
    spec?: string;
    zoneId: number;
    encounterId: number;
    characterId: number;
    journalRaidId: string;
    region: CharacterKey["region"];
  }
): readonly WarcraftLogsFirstKillEvidence[] | WarcraftLogsLimitation {
  const report = record(record(record(value)?.data)?.reportData)?.report;
  if (report === null) return [];
  const entry = record(report);
  if (!entry || entry.code !== expected.code)
    return { kind: "limitation", code: "schema_drift" };
  if (positiveInteger(record(entry.zone)?.id) !== expected.zoneId) return [];
  const fights = entry.fights;
  if (!Array.isArray(fights) || fights.length !== 1)
    return { kind: "limitation", code: "schema_drift" };
  const fight = record(fights[0]);
  if (
    positiveInteger(fight?.id) !== expected.fightId ||
    positiveInteger(fight?.encounterID) !== expected.encounterId ||
    fight?.difficulty !== MYTHIC_DIFFICULTY ||
    fight.kill !== true
  )
    return [];
  const ranked = entry.rankedCharacters;
  const actors = record(entry.masterData)?.actors;
  if (ranked === null) return [];
  if (!Array.isArray(ranked) || !Array.isArray(actors))
    return { kind: "limitation", code: "schema_drift" };
  const identities = ranked.map(record);
  const canonical = identities.filter(
    (item) => positiveInteger(item?.canonicalID) === expected.characterId
  );
  if (canonical.length !== 1) return [];
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
  if (matches.length !== 1) return [];
  const actor = matches[0]!;
  // Specs are an independent consistency check when the report supplies
  // them. Identity was already established by canonical ID and unique actor.
  if (expected.spec && Array.isArray(fight.friendlySpecs)) {
    const actorIndex = Array.isArray(fight.friendlyPlayers)
      ? fight.friendlyPlayers.indexOf(actor.id)
      : -1;
    const fightSpec = nonEmptyString(fight.friendlySpecs[actorIndex]);
    if (
      fightSpec &&
      fightSpec.toLocaleLowerCase("en-US") !==
        expected.spec.toLocaleLowerCase("en-US")
    )
      return [];
  }
  const alias = {
    region: expected.region,
    realm: String(actor.server).toLocaleLowerCase("en-US"),
    name: String(actor.name).toLocaleLowerCase("en-US")
  } as CharacterKey;
  const decoded = decodedHydratedReport(value, alias);
  if (decoded.kind !== "evidence") return decoded;
  if (decoded.limitation) return decoded.limitation;
  return decoded.kills.filter(
    (kill) =>
      kill.reportCode === expected.code &&
      kill.fightId === expected.fightId &&
      kill.bossId === String(expected.encounterId) &&
      // A combined zone's fights name no raid, so the boss has to place them.
      lookupRaidForEvidence(kill)?.raidId === expected.journalRaidId &&
      currentContentEligibilityByRaidId(
        kill.killedAt,
        expected.journalRaidId
      ) === true
  );
}
