import { specIconUrl, type CharacterKey } from "@slashwho/domain";

import { MYTHIC_DIFFICULTY } from "../queries";
import type {
  WarcraftLogsLimitation,
  WarcraftLogsParseGroup,
  WarcraftLogsParseMetric,
  WarcraftLogsPerformance,
  WarcraftLogsTierBestParse,
  WarcraftLogsTierZone
} from "../types";
import {
  isLimitation,
  nonEmptyString,
  normalizedIdentity,
  normalizedRealm,
  positiveInteger,
  record
} from "./primitives";

const MAX_RANKING_IDENTITIES = 50;

export type RankingMetricName = keyof WarcraftLogsPerformance;
export type RankingIdentity = Readonly<{
  id: number;
  name: string;
  realm: string;
  region: string;
}>;
type SpecIdentity = Readonly<{
  className: string | null;
  specName: string;
}>;
type RankingRow = Readonly<{
  metric: RankingMetricName;
  fightId: number;
  characterId: number;
  spec: SpecIdentity | null;
  percentile: number | null;
}>;
/**
 * One report's worth of parse hydration. A report is the unit of request
 * because `Report.rankings` returns every requested fight in a single call;
 * `fights` records what each fight is expected to be so a returned row can be
 * rejected if it describes a different encounter or difficulty.
 */
export type RankingScope = WarcraftLogsParseGroup;

const unavailableParseMetric: WarcraftLogsParseMetric = {
  state: "unavailable"
};

export function unavailablePerformance(): WarcraftLogsPerformance {
  return {
    spec: null,
    damage: unavailableParseMetric,
    healing: unavailableParseMetric,
    bossDamage: unavailableParseMetric
  };
}

function rankingIdentity(
  value: unknown
): RankingIdentity | WarcraftLogsLimitation {
  const character = record(value);
  const server = character && record(character.server);
  const id = character && positiveInteger(character.id);
  const name = character && nonEmptyString(character.name);
  const realm = server && nonEmptyString(server.name);
  const region = server && nonEmptyString(server.region);
  if (!id || !name || !realm || !region) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  return { id, name, realm, region };
}

function actorsIncludeKey(
  actors: readonly unknown[],
  requestedKey: CharacterKey
): boolean {
  return actors.some((actorValue) => {
    const actor = record(actorValue);
    return (
      actor?.type === "Player" &&
      typeof actor.name === "string" &&
      typeof actor.server === "string" &&
      normalizedIdentity(actor.name) ===
        normalizedIdentity(requestedKey.name) &&
      normalizedRealm(actor.server) === normalizedRealm(requestedKey.realm)
    );
  });
}

export function decodeRankingRows(
  value: unknown,
  scope: RankingScope,
  requestedKey: CharacterKey
):
  | Readonly<{
      identities: readonly RankingIdentity[];
      rows: readonly RankingRow[];
      actors: readonly unknown[];
    }>
  | WarcraftLogsLimitation {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const reportData = data && record(data.reportData);
  const report = reportData && record(reportData.report);
  const code = report && nonEmptyString(report.code);
  if (!report || code !== scope.reportCode) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  const masterData = record(report.masterData);
  const actors = masterData && masterData.actors;
  if (!Array.isArray(actors)) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }

  const identities = new Map<number, RankingIdentity>();
  const rows: RankingRow[] = [];
  for (const metric of [
    "damage",
    "healing",
    "bossDamage"
  ] as const satisfies readonly RankingMetricName[]) {
    const metricValue = record(report[metric]);
    const metricRows = metricValue && metricValue.data;
    if (!Array.isArray(metricRows)) {
      return { kind: "limitation", code: "parse_schema_drift" };
    }
    for (const metricRowValue of metricRows) {
      const metricRow = record(metricRowValue);
      const fightId = metricRow && positiveInteger(metricRow.fightID);
      const encounter = metricRow && record(metricRow.encounter);
      const encounterId = encounter && positiveInteger(encounter.id);
      const difficulty = metricRow && positiveInteger(metricRow.difficulty);
      const roles = metricRow && record(metricRow.roles);
      if (!fightId || !encounterId || !difficulty || !roles) {
        return { kind: "limitation", code: "parse_schema_drift" };
      }
      // A row is kept only when it describes a fight this scope asked for and
      // agrees with that fight's own encounter and difficulty. Rows for other
      // fights are ignored rather than rejected: omitting the encounter and
      // difficulty filters widens the response by design.
      const expected = scope.fights.get(fightId);
      if (
        !expected ||
        encounterId !== expected.encounterId ||
        difficulty !== expected.difficulty
      ) {
        continue;
      }
      for (const roleName of ["tanks", "healers", "dps"] as const) {
        const role = record(roles[roleName]);
        const characters = role && role.characters;
        if (!role || !Array.isArray(characters)) {
          return { kind: "limitation", code: "parse_schema_drift" };
        }
        for (const characterValue of characters) {
          const identity = rankingIdentity(characterValue);
          if (isLimitation(identity)) return identity;
          const knownIdentity = identities.get(identity.id);
          if (
            knownIdentity &&
            (knownIdentity.name !== identity.name ||
              knownIdentity.realm !== identity.realm ||
              knownIdentity.region !== identity.region)
          ) {
            return { kind: "limitation", code: "parse_schema_drift" };
          }
          identities.set(identity.id, identity);
          const rankPercent = record(characterValue)?.rankPercent;
          const specName = nonEmptyString(record(characterValue)?.spec);
          rows.push({
            metric,
            fightId,
            characterId: identity.id,
            spec:
              specName === null
                ? null
                : {
                    className: reportedClassName(record(characterValue)?.class),
                    specName
                  },
            percentile:
              typeof rankPercent === "number" &&
              Number.isFinite(rankPercent) &&
              rankPercent >= 0 &&
              rankPercent <= 100
                ? rankPercent
                : null
          });
        }
      }
    }
  }
  const requestedIdentities = [...identities.values()].filter(
    (identity) =>
      normalizedIdentity(identity.name) ===
        normalizedIdentity(requestedKey.name) &&
      normalizedRealm(identity.realm) === normalizedRealm(requestedKey.realm) &&
      normalizedIdentity(identity.region) ===
        normalizedIdentity(requestedKey.region)
  );
  if (requestedIdentities.length > MAX_RANKING_IDENTITIES) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  // Matching nobody is ordinary when nobody was ranked, or when this character
  // was not in the report at all. It is not ordinary when the report ranked
  // somebody for a fight this character was in: both sides of the match were in
  // hand and the decoder still could not connect them, which is what a change
  // to how ranking rows carry identity looks like. Left silent, that reads
  // exactly like a character who has no parses.
  //
  // Its own code rather than `parse_schema_drift` (#349). #319 named the
  // trade: a character genuinely in the fight and genuinely unranked lands
  // here too. That makes this common and mostly benign, where structural
  // drift is rare and alarming, and the two cannot share an unretryable
  // classification without stranding ordinary characters for a day.
  if (
    requestedIdentities.length === 0 &&
    identities.size > 0 &&
    actorsIncludeKey(actors, requestedKey)
  ) {
    return { kind: "limitation", code: "parse_identity_unmatched" };
  }
  const requestedIds = new Set(
    requestedIdentities.map((identity) => identity.id)
  );
  return {
    identities: requestedIdentities,
    rows: rows.filter((row) => requestedIds.has(row.characterId)),
    actors
  };
}

export function canonicalRankingCharacterIdsByIdentity(
  canonicalIds: ReadonlySet<number>,
  identities: readonly RankingIdentity[],
  actors: unknown,
  requestedKey: CharacterKey
): readonly number[] | WarcraftLogsLimitation {
  if (!Array.isArray(actors)) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  const requestedIds: number[] = [];
  for (const identity of identities) {
    if (!canonicalIds.has(identity.id)) {
      return { kind: "limitation", code: "parse_schema_drift" };
    }
    const matchingActors = actors.filter((actorValue) => {
      const actor = record(actorValue);
      return (
        actor?.type === "Player" &&
        typeof actor.name === "string" &&
        typeof actor.server === "string" &&
        normalizedIdentity(actor.name) === normalizedIdentity(identity.name) &&
        normalizedRealm(actor.server) === normalizedRealm(identity.realm)
      );
    });
    if (matchingActors.length !== 1) {
      return { kind: "limitation", code: "parse_schema_drift" };
    }
    if (
      normalizedIdentity(identity.name) ===
        normalizedIdentity(requestedKey.name) &&
      normalizedRealm(identity.realm) === normalizedRealm(requestedKey.realm) &&
      normalizedIdentity(identity.region) ===
        normalizedIdentity(requestedKey.region)
    ) {
      requestedIds.push(identity.id);
    }
  }
  // Two ranked characters sharing this key cannot be told apart, so the group
  // is refused. None is not a contradiction: the character simply holds no
  // ranking in this report, and the caller leaves those fights unparsed.
  return requestedIds.length > 1
    ? { kind: "limitation", code: "parse_schema_drift" }
    : requestedIds;
}

export function decodeCanonicalIdentityIds(
  value: unknown,
  identities: readonly RankingIdentity[]
): ReadonlySet<number> | WarcraftLogsLimitation {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  if (!characterData) return { kind: "limitation", code: "parse_schema_drift" };
  const ids = new Set<number>();
  for (const [index, identity] of identities.entries()) {
    const character = record(characterData[`character${index}`]);
    const server = character && record(character.server);
    const region = server && record(server.region);
    const id = character && positiveInteger(character.id);
    const name = character && nonEmptyString(character.name);
    const realm = server && nonEmptyString(server.slug);
    const regionSlug = region && nonEmptyString(region.slug);
    if (
      id !== identity.id ||
      !name ||
      !realm ||
      !regionSlug ||
      normalizedIdentity(name) !== normalizedIdentity(identity.name) ||
      normalizedRealm(realm) !== normalizedRealm(identity.realm) ||
      normalizedIdentity(regionSlug) !== normalizedIdentity(identity.region)
    ) {
      return { kind: "limitation", code: "parse_schema_drift" };
    }
    ids.add(id);
  }
  return ids;
}

// Warcraft Logs reports a rank's class as a numeric class id, not a name.
// Verified against `gameData { classes { id name } }`.
const warcraftLogsClassNames: Readonly<Record<number, string>> = {
  1: "DeathKnight",
  2: "Druid",
  3: "Hunter",
  4: "Mage",
  5: "Monk",
  6: "Paladin",
  7: "Priest",
  8: "Rogue",
  9: "Shaman",
  10: "Warlock",
  11: "Warrior",
  12: "DemonHunter",
  13: "Evoker"
};

function reportedClassName(value: unknown): string | null {
  if (typeof value === "number") {
    return warcraftLogsClassNames[value] ?? null;
  }
  return nonEmptyString(value);
}

/**
 * A rank's specialisation, with its icon. Warcraft Logs rarely reports a class
 * on its ranks, so `knownClassName` — the class the caller already holds for
 * this character, which cannot change — settles the four specialisation names
 * that two classes share.
 */
function specPerformance(
  identity: SpecIdentity | null,
  knownClassName?: string
): WarcraftLogsPerformance["spec"] {
  if (identity === null) return null;
  const iconUrl = specIconUrl(
    identity.specName,
    identity.className ?? knownClassName
  );
  return iconUrl === null ? null : { name: identity.specName, iconUrl };
}

export function normalizedPerformance(
  rows: readonly RankingRow[],
  requestedIds: readonly number[],
  fightIds: readonly number[],
  knownClassName?: string
): ReadonlyMap<number, WarcraftLogsPerformance> | WarcraftLogsLimitation {
  const performance = new Map<number, WarcraftLogsPerformance>(
    fightIds.map((fightId) => [fightId, unavailablePerformance()])
  );
  const values = new Map<string, number>();
  const specs = new Map<number, SpecIdentity>();
  for (const row of rows) {
    if (row.spec !== null) specs.set(row.fightId, row.spec);
    if (!requestedIds.includes(row.characterId) || row.percentile === null) {
      continue;
    }
    const key = `${row.fightId}:${row.metric}`;
    values.set(
      key,
      Math.max(values.get(key) ?? row.percentile, row.percentile)
    );
  }
  for (const [fightId, initial] of performance) {
    performance.set(fightId, {
      spec: specPerformance(specs.get(fightId) ?? null, knownClassName),
      damage: values.has(`${fightId}:damage`)
        ? { state: "available", percentile: values.get(`${fightId}:damage`)! }
        : initial.damage,
      healing: values.has(`${fightId}:healing`)
        ? { state: "available", percentile: values.get(`${fightId}:healing`)! }
        : initial.healing,
      bossDamage: values.has(`${fightId}:bossDamage`)
        ? {
            state: "available",
            percentile: values.get(`${fightId}:bossDamage`)!
          }
        : initial.bossDamage
    });
  }
  return performance;
}

export type ZoneScope = WarcraftLogsTierZone;

function characterRankingsUrl(
  key: CharacterKey,
  zoneId: number,
  encounterId: number
): string {
  const path = [key.region, key.realm, key.name]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://www.warcraftlogs.com/character/${path}#zone=${zoneId}&boss=${encounterId}&difficulty=${MYTHIC_DIFFICULTY}`;
}

/**
 * Turns one zone's aliased `zoneRankings` response into a best parse per
 * encounter. Unlike report rankings there is no fight for a row to agree with,
 * so the only identity check available is the one the request already made: it
 * named this character, this zone and Mythic difficulty.
 */
export function decodeZoneRankings(
  value: unknown,
  scope: ZoneScope,
  key: CharacterKey,
  knownClassName?: string
): readonly WarcraftLogsTierBestParse[] | WarcraftLogsLimitation {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  // A character Warcraft Logs will not serve is a parse-side gap, never a
  // reason to discard the kill evidence already collected for them.
  if (character === null) {
    return { kind: "limitation", code: "parse_unavailable" };
  }
  const entry = record(character);
  if (!entry) return { kind: "limitation", code: "parse_schema_drift" };

  const metrics = [
    "damage",
    "healing",
    "bossDamage"
  ] as const satisfies readonly RankingMetricName[];
  const percentiles = new Map<string, number>();
  const bossNames = new Map<number, string>();
  const specs = new Map<number, SpecIdentity>();
  for (const metric of metrics) {
    const metricValue = record(entry[metric]);
    const rankings = metricValue && metricValue.rankings;
    if (!Array.isArray(rankings)) {
      // `{ error }` is Warcraft Logs declining a question rather than
      // answering one -- a difficulty that zone never had, say. It is a
      // legitimate response meaning "this does not apply here", so it leaves
      // the metric with no rankings rather than raising a limitation that
      // would stop the tier settling (#351). Recognised positively: a payload
      // carrying neither an error nor rankings is still drift.
      if (
        metricValue &&
        !("rankings" in metricValue) &&
        nonEmptyString(metricValue.error) !== null
      ) {
        continue;
      }
      return { kind: "limitation", code: "parse_schema_drift" };
    }
    for (const rankingValue of rankings) {
      const ranking = record(rankingValue);
      const encounter = ranking && record(ranking.encounter);
      const encounterId = encounter && positiveInteger(encounter.id);
      const bossName = encounter && nonEmptyString(encounter.name);
      if (!ranking || !encounterId || !bossName) {
        return { kind: "limitation", code: "parse_schema_drift" };
      }
      bossNames.set(encounterId, bossName);
      // `bestSpec` is the specialisation the reported ranking was set in;
      // `spec` is only the character's most recent one, so it is the fallback.
      const specName =
        nonEmptyString(ranking.bestSpec) ?? nonEmptyString(ranking.spec);
      if (specName !== null && !specs.has(encounterId)) {
        specs.set(encounterId, {
          className: reportedClassName(ranking.class),
          specName
        });
      }
      const rankPercent = ranking.rankPercent;
      // An encounter listed without a percentile for this metric is ordinary:
      // a healer is not ranked on damage. Skipping leaves that metric
      // unavailable rather than inventing a zero.
      if (
        typeof rankPercent !== "number" ||
        !Number.isFinite(rankPercent) ||
        rankPercent < 0 ||
        rankPercent > 100
      ) {
        continue;
      }
      const percentileKey = `${encounterId}:${metric}`;
      percentiles.set(
        percentileKey,
        Math.max(percentiles.get(percentileKey) ?? rankPercent, rankPercent)
      );
    }
  }

  const metricFor = (
    encounterId: number,
    metric: RankingMetricName
  ): WarcraftLogsParseMetric => {
    const percentile = percentiles.get(`${encounterId}:${metric}`);
    return percentile === undefined
      ? unavailableParseMetric
      : { state: "available", percentile };
  };
  return [...bossNames]
    .filter(([encounterId]) =>
      metrics.some((metric) => percentiles.has(`${encounterId}:${metric}`))
    )
    .map(([encounterId, bossName]) => ({
      raidId: String(scope.zoneId),
      raidName: scope.raidName,
      bossId: String(encounterId),
      bossName,
      rankingsUrl: characterRankingsUrl(key, scope.zoneId, encounterId),
      performance: {
        spec: specPerformance(specs.get(encounterId) ?? null, knownClassName),
        damage: metricFor(encounterId, "damage"),
        healing: metricFor(encounterId, "healing"),
        bossDamage: metricFor(encounterId, "bossDamage")
      }
    }))
    .sort((a, b) => Number(a.bossId) - Number(b.bossId));
}
