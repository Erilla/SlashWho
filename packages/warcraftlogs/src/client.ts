import { supportedRegions, type CharacterKey } from "@slashwho/domain";

import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsIdentityResult,
  WarcraftLogsLimitation,
  WarcraftLogsParseMetric,
  WarcraftLogsPerformance,
  WarcraftLogsReportResult,
  WarcraftLogsWipeEvidence
} from "./types";

const MYTHIC_DIFFICULTY = 5;
// Nested actor/fight selections make a 100-report page exceed WCL's
// 50,000-point query complexity ceiling. Ten reports fit that limit.
const REPORTS_PER_PAGE = 10;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAX_RANKING_IDENTITIES = 50;

const resolveCharacterQuery = `
  query ResolveCharacter($name: String!, $realm: String!, $region: String!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        name
        server {
          slug
          region { slug }
        }
      }
    }
  }
`;

const recentReportsQuery = `
  query RecentReports($name: String!, $realm: String!, $region: String!, $page: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        server { normalizedName }
        recentReports(limit: ${REPORTS_PER_PAGE}, page: $page) {
          data {
            code
            startTime
            guild { name server { slug region { slug } } }
            zone { id name encounters { id journalID } }
            masterData { actors { id name server type } }
            fights {
              id
              encounterID
              name
              startTime
              endTime
              kill
              difficulty
              friendlyPlayers
            }
          }
          has_more_pages
        }
      }
    }
  }
`;

const reportFightParsesQuery = `
  query ReportFightParses(
    $code: String!
    $fightIDs: [Int!]!
    $encounterID: Int!
    $difficulty: Int!
  ) {
    reportData {
      report(code: $code) {
        code
        archiveStatus { isArchived isAccessible archiveDate }
        masterData { actors { id name server type } }
        damage: rankings(
          compare: Rankings
          difficulty: $difficulty
          encounterID: $encounterID
          fightIDs: $fightIDs
          playerMetric: dps
          timeframe: Historical
        )
        healing: rankings(
          compare: Rankings
          difficulty: $difficulty
          encounterID: $encounterID
          fightIDs: $fightIDs
          playerMetric: hps
          timeframe: Historical
        )
        bossDamage: rankings(
          compare: Rankings
          difficulty: $difficulty
          encounterID: $encounterID
          fightIDs: $fightIDs
          playerMetric: bossdps
          timeframe: Historical
        )
      }
    }
  }
`;

export type CreateWarcraftLogsClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides the Warcraft Logs origin for deterministic local integration tests. */
  baseUrl?: string;
}>;

type AccessToken = Readonly<{
  value: string;
  expiresAt: number;
}>;

type GraphqlSuccess = Readonly<{ kind: "success"; value: unknown }>;
type GraphqlResult = GraphqlSuccess | WarcraftLogsLimitation;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isLimitation(value: unknown): value is WarcraftLogsLimitation {
  return record(value)?.kind === "limitation";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validTimestampMilliseconds(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_MILLISECONDS
    ? value
    : null;
}

function validCharacterKey(value: CharacterKey): CharacterKey {
  const valid =
    supportedRegions.includes(value.region) &&
    /^[a-z0-9-]+$/.test(value.realm) &&
    /^[\p{L}\p{M}'-]+$/u.test(value.name) &&
    value.realm === value.realm.toLocaleLowerCase("en-US") &&
    value.name === value.name.toLocaleLowerCase("en-US");
  if (!valid) throw new Error("invalid_character_key");
  return value;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

function responseLimitation(response: Response): WarcraftLogsLimitation {
  if (response.status === 404) return { kind: "limitation", code: "not_found" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "limitation", code: "private" };
  }
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response);
    return {
      kind: "limitation",
      code: "rate_limited",
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
    };
  }
  return { kind: "limitation", code: "unavailable" };
}

function graphQlErrorLimitation(value: unknown): WarcraftLogsLimitation | null {
  const envelope = record(value);
  const errors = envelope && envelope.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const error = record(errors[0]);
  const message =
    error && nonEmptyString(error.message)?.toLocaleLowerCase("en-US");
  const extensions = error && record(error.extensions);
  const code =
    extensions && nonEmptyString(extensions.code)?.toLocaleUpperCase("en-US");
  if (code === "NOT_FOUND" || message?.includes("not found")) {
    return { kind: "limitation", code: "not_found" };
  }
  if (
    code === "FORBIDDEN" ||
    code === "UNAUTHORIZED" ||
    message?.includes("private") ||
    message?.includes("forbidden") ||
    message?.includes("not authorized")
  ) {
    return { kind: "limitation", code: "private" };
  }
  return { kind: "limitation", code: "unavailable" };
}

function canonicalIdentity(value: unknown): WarcraftLogsIdentityResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  if (character === null) return { kind: "limitation", code: "not_found" };

  const entry = record(character);
  const server = entry && record(entry.server);
  const region = server && record(server.region);
  const displayName = entry && nonEmptyString(entry.name);
  const realm = server && nonEmptyString(server.slug);
  const regionSlug = region && nonEmptyString(region.slug);
  if (!displayName || !realm || !regionSlug) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const key = {
    region: regionSlug.toLocaleLowerCase("en-US"),
    realm: realm.toLocaleLowerCase("en-US"),
    name: displayName.toLocaleLowerCase("en-US")
  } as CharacterKey;
  try {
    validCharacterKey(key);
  } catch {
    return { kind: "limitation", code: "schema_drift" };
  }
  return { kind: "identity", key, displayName };
}

function firstKillReports(
  value: unknown,
  requestedKey: CharacterKey
): WarcraftLogsReportResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && characterData.character;
  if (character === null) return { kind: "limitation", code: "not_found" };

  const entry = record(character);
  const characterServer = entry && record(entry.server);
  const normalizedRealm =
    characterServer && nonEmptyString(characterServer.normalizedName);
  const recentReports = entry && record(entry.recentReports);
  const reports = recentReports && recentReports.data;
  const hasMorePages = recentReports && recentReports.has_more_pages;
  if (
    !normalizedRealm ||
    !Array.isArray(reports) ||
    typeof hasMorePages !== "boolean"
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }

  const kills = new Map<string, WarcraftLogsFirstKillEvidence>();
  const wipes = new Map<string, WarcraftLogsWipeEvidence>();
  const schemaDrift = (): WarcraftLogsReportResult =>
    kills.size > 0 || wipes.size > 0
      ? {
          kind: "evidence",
          kills: [...kills.values()],
          wipes: [...wipes.values()],
          limitation: { kind: "limitation", code: "schema_drift" }
        }
      : { kind: "limitation", code: "schema_drift" };
  for (const reportValue of reports) {
    const report = record(reportValue);
    const code = report && nonEmptyString(report.code);
    const reportStartTime =
      report && validTimestampMilliseconds(report.startTime);
    const reportGuild = report && report.guild;
    const fights = report && report.fights;
    const zone = report && record(report.zone);
    const raidId = zone && positiveInteger(zone.id);
    const raidName = zone && nonEmptyString(zone.name);
    const masterData = report && record(report.masterData);
    const actors = masterData && masterData.actors;
    if (
      !code ||
      reportStartTime === null ||
      !raidId ||
      !raidName ||
      !Array.isArray(actors) ||
      !Array.isArray(fights)
    ) {
      return schemaDrift();
    }

    let guild: WarcraftLogsFirstKillEvidence["guild"] = null;
    if (reportGuild !== null && reportGuild !== undefined) {
      const guildRecord = record(reportGuild);
      const guildServer = guildRecord && record(guildRecord.server);
      const guildRegion = guildServer && record(guildServer.region);
      const guildName = guildRecord && nonEmptyString(guildRecord.name);
      const guildRealm = guildServer && nonEmptyString(guildServer.slug);
      const guildRegionSlug = guildRegion && nonEmptyString(guildRegion.slug);
      const region = guildRegionSlug?.toLocaleLowerCase("en-US");
      if (
        !guildName ||
        !guildRealm ||
        !region ||
        !supportedRegions.includes(region as CharacterKey["region"])
      ) {
        return schemaDrift();
      }
      guild = {
        name: guildName,
        region: region as CharacterKey["region"],
        realm: guildRealm
      };
    }

    const journalBossIds = new Map<number, string>();
    const zoneEncounters = zone && zone.encounters;
    if (Array.isArray(zoneEncounters)) {
      for (const encounterValue of zoneEncounters) {
        const encounter = record(encounterValue);
        const encounterId = encounter && positiveInteger(encounter.id);
        const journalId = encounter && positiveInteger(encounter.journalID);
        if (encounterId && journalId) {
          journalBossIds.set(encounterId, String(journalId));
        }
      }
    }

    const participantIds = new Set<number>();
    for (const actorValue of actors) {
      const actor = record(actorValue);
      if (actor?.type !== "Player") continue;
      const actorId = actor && positiveInteger(actor.id);
      const name = actor && nonEmptyString(actor.name);
      const server = actor && nonEmptyString(actor.server);
      // An actor without a complete identity cannot establish this character's
      // participation. Ignore it rather than discarding other attributable
      // kills in the report.
      if (!actorId || !name || !server) continue;
      if (
        name.toLocaleLowerCase("en-US") === requestedKey.name &&
        server.toLocaleLowerCase("en-US") ===
          normalizedRealm.toLocaleLowerCase("en-US")
      ) {
        participantIds.add(actorId);
      }
    }

    for (const fightValue of fights) {
      const fight = record(fightValue);
      const id = fight && positiveInteger(fight.id);
      const encounterId = fight && nonNegativeInteger(fight.encounterID);
      const bossName = fight && nonEmptyString(fight.name);
      const fightStartTime =
        fight && validTimestampMilliseconds(fight.startTime);
      const fightEndTime = fight && validTimestampMilliseconds(fight.endTime);
      const killed = fight && fight.kill;
      const difficulty = fight && fight.difficulty;
      const friendlyPlayers = fight && fight.friendlyPlayers;
      if (!id || encounterId === null) {
        return schemaDrift();
      }
      // Warcraft Logs represents trash pulls with encounterID 0. They have no
      // boss identity and must not turn an otherwise valid report into schema
      // drift or dossier evidence.
      if (encounterId === 0) continue;
      if (
        fightStartTime === null ||
        fightEndTime === null ||
        fightEndTime < fightStartTime
      ) {
        return schemaDrift();
      }
      if (
        typeof killed !== "boolean" ||
        !Number.isSafeInteger(difficulty) ||
        !Array.isArray(friendlyPlayers) ||
        friendlyPlayers.some((player) => !positiveInteger(player))
      ) {
        return schemaDrift();
      }
      if (!bossName) return schemaDrift();
      if (
        difficulty !== MYTHIC_DIFFICULTY ||
        !friendlyPlayers.some((player) => participantIds.has(player))
      ) {
        continue;
      }

      const evidenceAtMilliseconds = reportStartTime + fightEndTime;
      if (
        !Number.isSafeInteger(evidenceAtMilliseconds) ||
        evidenceAtMilliseconds > MAX_DATE_MILLISECONDS
      ) {
        return schemaDrift();
      }
      const evidenceAt = new Date(evidenceAtMilliseconds).toISOString();
      const reportUrl = `https://www.warcraftlogs.com/reports/${encodeURIComponent(code)}`;
      const fightUrl = `${reportUrl}#fight=${id}`;
      if (!killed) {
        const candidate: WarcraftLogsWipeEvidence = {
          raidId: String(raidId),
          raidName,
          bossId: String(encounterId),
          bossName,
          journalBossId: journalBossIds.get(encounterId) ?? null,
          bossOrder: encounterId,
          attemptedAt: evidenceAt,
          reportUrl,
          fightUrl
        };
        const identifier = `${candidate.raidId}\0${candidate.bossId}`;
        const current = wipes.get(identifier);
        if (
          !current ||
          candidate.attemptedAt > current.attemptedAt ||
          (candidate.attemptedAt === current.attemptedAt &&
            candidate.fightUrl < current.fightUrl)
        ) {
          wipes.set(identifier, candidate);
        }
        continue;
      }
      const candidate: WarcraftLogsFirstKillEvidence = {
        raidId: String(raidId),
        raidName,
        bossId: String(encounterId),
        bossName,
        journalBossId: journalBossIds.get(encounterId) ?? null,
        bossOrder: encounterId,
        isFinalBoss: false,
        killedAt: evidenceAt,
        reportCode: code,
        fightId: id,
        difficulty,
        performance: unavailablePerformance(),
        reportUrl,
        fightUrl,
        guild,
        historicWorldRank: null
      };
      kills.set(candidate.fightUrl, candidate);
    }
  }

  return {
    kind: "evidence",
    kills: [...kills.values()].sort(
      (a, b) =>
        a.bossOrder - b.bossOrder ||
        a.killedAt.localeCompare(b.killedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    ),
    wipes: [...wipes.values()].sort(
      (a, b) =>
        a.raidId.localeCompare(b.raidId) ||
        a.bossOrder - b.bossOrder ||
        b.attemptedAt.localeCompare(a.attemptedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    )
  };
}

type RankingMetricName = keyof WarcraftLogsPerformance;
type RankingIdentity = Readonly<{
  id: number;
  name: string;
  realm: string;
  region: string;
}>;
type RankingRow = Readonly<{
  metric: RankingMetricName;
  fightId: number;
  characterId: number;
  percentile: number | null;
}>;
type RankingScope = Readonly<{
  reportCode: string;
  encounterId: number;
  difficulty: number;
  fightIds: readonly number[];
}>;

const unavailableParseMetric: WarcraftLogsParseMetric = {
  state: "unavailable"
};

function unavailablePerformance(): WarcraftLogsPerformance {
  return {
    damage: unavailableParseMetric,
    healing: unavailableParseMetric,
    bossDamage: unavailableParseMetric
  };
}

function normalizedIdentity(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function normalizedRealm(value: string): string {
  return value.replaceAll(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
}

function toParseLimitation(
  limitation: WarcraftLogsLimitation
): WarcraftLogsLimitation {
  switch (limitation.code) {
    case "private":
      return { kind: "limitation", code: "parse_private" };
    case "rate_limited":
      return {
        kind: "limitation",
        code: "parse_rate_limited",
        ...(limitation.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: limitation.retryAfterMs })
      };
    case "schema_drift":
      return { kind: "limitation", code: "parse_schema_drift" };
    default:
      return { kind: "limitation", code: "parse_unavailable" };
  }
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

function decodeRankingRows(
  value: unknown,
  scope: RankingScope
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
  const archiveStatus = report && record(report.archiveStatus);
  if (!report || code !== scope.reportCode || !archiveStatus) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  if (
    typeof archiveStatus.isArchived !== "boolean" ||
    typeof archiveStatus.isAccessible !== "boolean"
  ) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  if (!archiveStatus.isAccessible) {
    return { kind: "limitation", code: "parse_unavailable" };
  }
  const masterData = record(report.masterData);
  const actors = masterData && masterData.actors;
  if (!Array.isArray(actors)) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }

  const identities = new Map<number, RankingIdentity>();
  const rows: RankingRow[] = [];
  const fightIds = new Set(scope.fightIds);
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
      if (
        !fightIds.has(fightId) ||
        encounterId !== scope.encounterId ||
        difficulty !== scope.difficulty
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
          rows.push({
            metric,
            fightId,
            characterId: identity.id,
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
  if (identities.size > MAX_RANKING_IDENTITIES) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  return { identities: [...identities.values()], rows, actors };
}

function rankingCharacterIdentityQuery(
  identities: readonly RankingIdentity[]
): string {
  const variables = identities
    .map((_, index) => `$character${index}: Int!`)
    .join(", ");
  const selections = identities
    .map(
      (_, index) =>
        `character${index}: character(id: $character${index}) { id name server { slug region { slug } } }`
    )
    .join("\n");
  return `query RankingCharacterIdentities(${variables}) { characterData { ${selections} } }`;
}

function canonicalRankingCharacterIds(
  value: unknown,
  identities: readonly RankingIdentity[],
  actors: unknown,
  requestedKey: CharacterKey
): readonly number[] | WarcraftLogsLimitation {
  if (!Array.isArray(actors)) {
    return { kind: "limitation", code: "parse_schema_drift" };
  }
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  if (!characterData) return { kind: "limitation", code: "parse_schema_drift" };

  const requestedIds: number[] = [];
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
    const matchingActors = actors.filter((actorValue) => {
      const actor = record(actorValue);
      return (
        actor?.type === "Player" &&
        typeof actor.name === "string" &&
        typeof actor.server === "string" &&
        normalizedIdentity(actor.name) === normalizedIdentity(name) &&
        normalizedRealm(actor.server) === normalizedRealm(realm)
      );
    });
    if (matchingActors.length !== 1) {
      return { kind: "limitation", code: "parse_schema_drift" };
    }
    if (
      normalizedIdentity(name) === requestedKey.name &&
      normalizedRealm(realm) === normalizedRealm(requestedKey.realm) &&
      normalizedIdentity(regionSlug) === requestedKey.region
    ) {
      requestedIds.push(identity.id);
    }
  }
  return requestedIds.length === 1
    ? requestedIds
    : { kind: "limitation", code: "parse_schema_drift" };
}

function normalizedPerformance(
  rows: readonly RankingRow[],
  requestedIds: readonly number[],
  fightIds: readonly number[]
): ReadonlyMap<number, WarcraftLogsPerformance> | WarcraftLogsLimitation {
  const performance = new Map<number, WarcraftLogsPerformance>(
    fightIds.map((fightId) => [fightId, unavailablePerformance()])
  );
  const values = new Map<string, number>();
  for (const row of rows) {
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

function hasMoreReportPages(value: unknown): boolean | null {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const characterData = data && record(data.characterData);
  const character = characterData && record(characterData.character);
  const recentReports = character && record(character.recentReports);
  return recentReports && typeof recentReports.has_more_pages === "boolean"
    ? recentReports.has_more_pages
    : null;
}

export function createWarcraftLogsClient(
  options: CreateWarcraftLogsClientOptions
): WarcraftLogsGateway {
  if (!options.clientId || !options.clientSecret) {
    throw new Error("invalid_client_credentials");
  }
  const baseUrl = options.baseUrl ? new URL(options.baseUrl) : undefined;
  if (baseUrl && !/^https?:$/.test(baseUrl.protocol)) {
    throw new Error("invalid_base_url");
  }
  let cachedToken: AccessToken | undefined;
  let tokenRequest: Promise<string | WarcraftLogsLimitation> | undefined;

  function tokenUrl(): URL {
    return new URL("/oauth/token", baseUrl ?? "https://www.warcraftlogs.com");
  }

  function graphqlUrl(): URL {
    return new URL("/api/v2/client", baseUrl ?? "https://www.warcraftlogs.com");
  }

  async function accessToken(
    signal?: AbortSignal
  ): Promise<string | WarcraftLogsLimitation> {
    signal?.throwIfAborted();
    tokenRequest ??= fetchAccessToken(AbortSignal.timeout(15_000)).finally(
      () => {
        tokenRequest = undefined;
      }
    );
    const token = await tokenRequest;
    signal?.throwIfAborted();
    return token;
  }

  async function fetchAccessToken(
    signal?: AbortSignal
  ): Promise<string | WarcraftLogsLimitation> {
    if (cachedToken && cachedToken.expiresAt > Date.now()) {
      return cachedToken.value;
    }

    let response: Response;
    try {
      response = await options.fetch(tokenUrl().toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(
            `${options.clientId}:${options.clientSecret}`
          ).toString("base64")}`
        },
        body: "grant_type=client_credentials",
        signal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "unavailable" };
    }

    signal?.throwIfAborted();
    if (!response.ok) return responseLimitation(response);
    try {
      const body = record(await response.json());
      signal?.throwIfAborted();
      const value = body && nonEmptyString(body.access_token);
      const expiresIn = body && nonNegativeFiniteNumber(body.expires_in);
      if (!value || expiresIn === null || expiresIn <= 0) {
        return { kind: "limitation", code: "schema_drift" };
      }
      cachedToken = {
        value,
        expiresAt: Date.now() + Math.max(0, expiresIn * 1_000 - 60_000)
      };
      return value;
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  async function graphql(
    query: string,
    variables: Record<string, string | number | readonly number[]>,
    signal?: AbortSignal
  ): Promise<GraphqlResult> {
    const token = await accessToken(signal);
    if (typeof token !== "string") return token;
    signal?.throwIfAborted();

    let response: Response;
    try {
      response = await options.fetch(graphqlUrl().toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables }),
        signal
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "unavailable" };
    }

    signal?.throwIfAborted();
    if (!response.ok) return responseLimitation(response);
    try {
      const body = await response.json();
      signal?.throwIfAborted();
      return graphQlErrorLimitation(body) ?? { kind: "success", value: body };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  async function resolveCharacter(
    requestedKey: CharacterKey,
    signal?: AbortSignal
  ): Promise<WarcraftLogsIdentityResult> {
    const key = validCharacterKey(requestedKey);
    const result = await graphql(
      resolveCharacterQuery,
      { name: key.name, realm: key.realm, region: key.region },
      signal
    );
    return result.kind === "success" ? canonicalIdentity(result.value) : result;
  }

  async function getFirstKillReports(
    requestedKey: CharacterKey,
    options: Readonly<{
      requestCap: number;
      parseRequestCap: number;
      signal?: AbortSignal;
    }>
  ): Promise<WarcraftLogsReportResult> {
    const key = validCharacterKey(requestedKey);
    if (!Number.isSafeInteger(options.requestCap) || options.requestCap <= 0) {
      return { kind: "limitation", code: "request_cap" };
    }
    if (
      !Number.isSafeInteger(options.parseRequestCap) ||
      options.parseRequestCap <= 0
    ) {
      return { kind: "limitation", code: "parse_request_cap" };
    }

    const kills = new Map<string, WarcraftLogsFirstKillEvidence>();
    const wipes = new Map<string, WarcraftLogsWipeEvidence>();
    let scanLimitation: WarcraftLogsLimitation | undefined;
    for (let page = 1; page <= options.requestCap; page++) {
      const result = await graphql(
        recentReportsQuery,
        { name: key.name, realm: key.realm, region: key.region, page },
        options.signal
      ).catch((error: unknown) => {
        if (options.signal?.reason?.name !== "TimeoutError") throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      });
      if (result.kind !== "success") {
        scanLimitation = result;
        break;
      }

      const normalized = firstKillReports(result.value, key);
      if (normalized.kind === "limitation") {
        scanLimitation = normalized;
        break;
      }
      for (const kill of normalized.kills) {
        kills.set(kill.fightUrl, kill);
      }
      for (const wipe of normalized.wipes) {
        const identifier = `${wipe.raidId}\0${wipe.bossId}`;
        const current = wipes.get(identifier);
        if (
          !current ||
          wipe.attemptedAt > current.attemptedAt ||
          (wipe.attemptedAt === current.attemptedAt &&
            wipe.fightUrl < current.fightUrl)
        ) {
          wipes.set(identifier, wipe);
        }
      }
      if (normalized.limitation) {
        scanLimitation = normalized.limitation;
        break;
      }

      const hasMorePages = hasMoreReportPages(result.value);
      if (hasMorePages === null) {
        scanLimitation = { kind: "limitation", code: "schema_drift" };
        break;
      }
      if (!hasMorePages) break;
      if (page === options.requestCap) {
        scanLimitation = { kind: "limitation", code: "request_cap" };
      }
    }

    let parseLimitation: WarcraftLogsLimitation | undefined;
    const groups = new Map<string, RankingScope>();
    for (const kill of kills.values()) {
      const groupKey = `${kill.reportCode}:${kill.bossId}:${kill.difficulty}`;
      const existing = groups.get(groupKey);
      groups.set(
        groupKey,
        existing
          ? { ...existing, fightIds: [...existing.fightIds, kill.fightId] }
          : {
              reportCode: kill.reportCode,
              encounterId: Number(kill.bossId),
              difficulty: kill.difficulty,
              fightIds: [kill.fightId]
            }
      );
    }
    let parseRequests = 0;
    for (const group of groups.values()) {
      if (parseRequests >= options.parseRequestCap) {
        parseLimitation = { kind: "limitation", code: "parse_request_cap" };
        break;
      }
      parseRequests += 1;
      const rankings = await graphql(
        reportFightParsesQuery,
        {
          code: group.reportCode,
          fightIDs: group.fightIds,
          encounterID: group.encounterId,
          difficulty: group.difficulty
        },
        options.signal
      ).catch((error: unknown) => {
        if (options.signal?.reason?.name !== "TimeoutError") throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      });
      if (rankings.kind !== "success") {
        parseLimitation = toParseLimitation(rankings);
        break;
      }
      const decoded = decodeRankingRows(rankings.value, group);
      if (isLimitation(decoded)) {
        parseLimitation = decoded;
        break;
      }
      if (decoded.identities.length === 0) continue;
      if (parseRequests >= options.parseRequestCap) {
        parseLimitation = { kind: "limitation", code: "parse_request_cap" };
        break;
      }
      parseRequests += 1;
      const canonical = await graphql(
        rankingCharacterIdentityQuery(decoded.identities),
        Object.fromEntries(
          decoded.identities.map((identity, index) => [
            `character${index}`,
            identity.id
          ])
        ),
        options.signal
      ).catch((error: unknown) => {
        if (options.signal?.reason?.name !== "TimeoutError") throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      });
      if (canonical.kind !== "success") {
        parseLimitation = toParseLimitation(canonical);
        break;
      }
      const requestedIds = canonicalRankingCharacterIds(
        canonical.value,
        decoded.identities,
        decoded.actors,
        key
      );
      if (isLimitation(requestedIds)) {
        parseLimitation = requestedIds;
        break;
      }
      const performance = normalizedPerformance(
        decoded.rows,
        requestedIds,
        group.fightIds
      );
      if (isLimitation(performance)) {
        parseLimitation = performance;
        break;
      }
      for (const [fightId, value] of performance) {
        for (const [fightUrl, kill] of kills) {
          if (
            kill.reportCode === group.reportCode &&
            kill.fightId === fightId
          ) {
            kills.set(fightUrl, { ...kill, performance: value });
          }
        }
      }
    }

    const sortedKills = [...kills.values()].sort(
      (a, b) =>
        a.raidId.localeCompare(b.raidId) ||
        a.bossOrder - b.bossOrder ||
        a.killedAt.localeCompare(b.killedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    );
    const sortedWipes = [...wipes.values()].sort(
      (a, b) =>
        a.raidId.localeCompare(b.raidId) ||
        a.bossOrder - b.bossOrder ||
        b.attemptedAt.localeCompare(a.attemptedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    );
    return sortedKills.length || sortedWipes.length
      ? {
          kind: "evidence",
          kills: sortedKills,
          wipes: sortedWipes,
          ...(scanLimitation ? { limitation: scanLimitation } : {}),
          ...(parseLimitation ? { parseLimitation } : {})
        }
      : (scanLimitation ??
          parseLimitation ?? { kind: "evidence", kills: [], wipes: [] });
  }

  return { resolveCharacter, getFirstKillReports };
}
