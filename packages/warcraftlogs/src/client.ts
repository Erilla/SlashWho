import {
  currentContentEligibility,
  supportedRegions,
  type CharacterKey
} from "@slashwho/domain";

import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsTierBestParse,
  WarcraftLogsGateway,
  WarcraftLogsIdentityResult,
  WarcraftLogsLimitation,
  WarcraftLogsParseMetric,
  WarcraftLogsPerformance,
  WarcraftLogsRateLimitResult,
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
              gameZone { id name }
            }
          }
          has_more_pages
        }
      }
    }
  }
`;

// Scoped to the report and its exact fight IDs, but deliberately not to a
// single encounter or difficulty: the schema widens the result when those
// filters are omitted, so one request covers every boss killed on a raid
// night. Each returned row still carries its own encounter and difficulty,
// which the decoder checks against the fight it claims to describe.
const reportFightParsesQuery = `
  query ReportFightParses($code: String!, $fightIDs: [Int!]!) {
    reportData {
      report(code: $code) {
        code
        masterData { actors { id name server type } }
        damage: rankings(
          compare: Rankings
          fightIDs: $fightIDs
          playerMetric: dps
          timeframe: Historical
        )
        healing: rankings(
          compare: Rankings
          fightIDs: $fightIDs
          playerMetric: hps
          timeframe: Historical
        )
        bossDamage: rankings(
          compare: Rankings
          fightIDs: $fightIDs
          playerMetric: bossdps
          timeframe: Historical
        )
      }
    }
  }
`;

// One request per zone, aliased across the three metrics, returning every
// encounter in that zone. This is what the "best parse" row needs and the only
// bounded way to get it: report rankings cost one request per report and a
// character's history is unbounded, so a budget-capped scan could only ever
// report the best of whatever reports it happened to reach.
const characterZoneParsesQuery = `
  query CharacterZoneParses($name: String!, $realm: String!, $region: String!, $zoneID: Int!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        damage: zoneRankings(
          zoneID: $zoneID
          metric: dps
          difficulty: ${MYTHIC_DIFFICULTY}
          timeframe: Historical
        )
        healing: zoneRankings(
          zoneID: $zoneID
          metric: hps
          difficulty: ${MYTHIC_DIFFICULTY}
          timeframe: Historical
        )
        bossDamage: zoneRankings(
          zoneID: $zoneID
          metric: bossdps
          difficulty: ${MYTHIC_DIFFICULTY}
          timeframe: Historical
        )
      }
    }
  }
`;

// The allowance the account is actually spending. `Retry-After` and
// `X-RateLimit-Remaining` track a different bucket and say nothing about this
// one; two misdiagnoses on 2026-09-17 came from reading them instead.
const rateLimitQuery = `
  query RateLimit {
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

export type CreateWarcraftLogsClientOptions = Readonly<{
  fetch: typeof globalThis.fetch;
  clientId: string;
  clientSecret: string;
  /** Overrides the Warcraft Logs origin for deterministic local integration tests. */
  baseUrl?: string;
  onThrottle?(event: { retryAfterMs: number | undefined }): void;
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

function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
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

/**
 * A reporting callback must never change what this client returns. If the
 * logger behind `onThrottle` throws, the raw thrown value would otherwise
 * replace the failure being built here, degrading a genuine rate limit into an
 * unavailable upstream. Swallowed silently: there is no safe place to report a
 * failure of the reporting path itself, and it must not become a second
 * failure.
 */
function reportThrottle(
  onThrottle:
    ((event: { retryAfterMs: number | undefined }) => void) | undefined,
  retryAfterMs: number | undefined
): void {
  try {
    onThrottle?.({ retryAfterMs });
  } catch {
    // Intentionally ignored; see above.
  }
}

function responseLimitation(
  response: Response,
  onThrottle?: (event: { retryAfterMs: number | undefined }) => void
): WarcraftLogsLimitation {
  if (response.status === 404) return { kind: "limitation", code: "not_found" };
  if (response.status === 401 || response.status === 403) {
    return { kind: "limitation", code: "private" };
  }
  // Upstream asking us to back off is throttling whether or not it also sent
  // 429 — a 503 carrying Retry-After is the same signal. This affects only
  // when onThrottle fires, never the limitation this function returns.
  const retryAfter = retryAfterMs(response);
  if (response.status === 429 || retryAfter !== undefined) {
    reportThrottle(onThrottle, retryAfter);
  }
  if (response.status === 429) {
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

function rateLimitFacts(value: unknown): WarcraftLogsRateLimitResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const rateLimitData = data && record(data.rateLimitData);
  const limitPerHour =
    rateLimitData && positiveFiniteNumber(rateLimitData.limitPerHour);
  // Fractional upstream. An integer check here would reject 9058.65 as drift.
  const pointsSpentThisHour =
    rateLimitData && nonNegativeFiniteNumber(rateLimitData.pointsSpentThisHour);
  const pointsResetInSeconds =
    rateLimitData && nonNegativeInteger(rateLimitData.pointsResetIn);
  if (
    limitPerHour === null ||
    pointsSpentThisHour === null ||
    pointsResetInSeconds === null
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }
  return {
    kind: "rate_limit",
    limitPerHour,
    pointsSpentThisHour,
    pointsResetInSeconds
  };
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
  const killedByReportBoss = new Set<string>();
  const schemaDrift = (): WarcraftLogsReportResult =>
    kills.size > 0 || wipes.size > 0
      ? {
          kind: "evidence",
          kills: [...kills.values()],
          wipes: [...wipes.values()],
          tierBests: [],
          // One page's normalisation attributes trouble to no raid: the caller
          // owns that judgement across the whole read.
          troubledRaidIds: [],
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
      // A report carries one zone, but a raid night that also ran Mythic+ is
      // filed under the dungeon season. Only the fight knows its own instance.
      const fightZone = fight && record(fight.gameZone);
      const fightRaidId =
        (fightZone && positiveInteger(fightZone.id)) ?? raidId;
      const fightRaidName =
        (fightZone && nonEmptyString(fightZone.name)) ?? raidName;
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
          raidId: String(fightRaidId),
          raidName: fightRaidName,
          bossId: String(encounterId),
          bossName,
          journalBossId: journalBossIds.get(encounterId) ?? null,
          bossOrder: encounterId,
          attemptedAt: evidenceAt,
          reportUrl,
          fightUrl
        };
        wipes.set(candidate.fightUrl, candidate);
        continue;
      }
      const candidate: WarcraftLogsFirstKillEvidence = {
        raidId: String(fightRaidId),
        raidName: fightRaidName,
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
      killedByReportBoss.add(`${candidate.reportUrl}\0${candidate.bossId}`);
      kills.set(candidate.fightUrl, candidate);
    }
  }

  const filteredWipes = [...wipes.values()].filter((wipe) => {
    const key = `${wipe.reportUrl}\0${wipe.bossId}`;
    return !killedByReportBoss.has(key);
  });

  return {
    kind: "evidence",
    tierBests: [],
    troubledRaidIds: [],
    kills: [...kills.values()].sort(
      (a, b) =>
        a.bossOrder - b.bossOrder ||
        a.killedAt.localeCompare(b.killedAt) ||
        a.fightUrl.localeCompare(b.fightUrl)
    ),
    wipes: [...filteredWipes].sort(
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
type RankingScope = Readonly<{
  reportCode: string;
  fights: ReadonlyMap<
    number,
    Readonly<{ encounterId: number; difficulty: number }>
  >;
  earliestKilledAt: string;
  /** The most recent kill in this report, used to favour the current tier. */
  latestKilledAt: string;
  /** Whether this report carries the first kill of any boss. */
  hasFirstKill: boolean;
}>;

const unavailableParseMetric: WarcraftLogsParseMetric = {
  state: "unavailable"
};

function unavailablePerformance(): WarcraftLogsPerformance {
  return {
    spec: null,
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
  const requestedIds = new Set(
    requestedIdentities.map((identity) => identity.id)
  );
  return {
    identities: requestedIdentities,
    rows: rows.filter((row) => requestedIds.has(row.characterId)),
    actors
  };
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

function canonicalRankingCharacterIdsByIdentity(
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

function decodeCanonicalIdentityIds(
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

// Keyed by class then specialisation, because four specialisation names are
// shared by two classes each (Frost, Holy, Protection, Restoration) and a
// name-only lookup silently hands one class the other's icon.
const specIconNames: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  DeathKnight: {
    Blood: "spell_deathknight_bloodpresence",
    Frost: "spell_deathknight_frostpresence",
    Unholy: "spell_deathknight_unholypresence"
  },
  DemonHunter: {
    Devourer: "classicon_demonhunter_void",
    Havoc: "ability_demonhunter_specdps",
    Vengeance: "ability_demonhunter_spectank"
  },
  Druid: {
    Balance: "spell_nature_starfall",
    Feral: "ability_druid_catform",
    Guardian: "ability_racial_bearform",
    Restoration: "spell_nature_healingtouch"
  },
  Evoker: {
    Augmentation: "classicon_evoker_augmentation",
    Devastation: "classicon_evoker_devastation",
    Preservation: "classicon_evoker_preservation"
  },
  Hunter: {
    BeastMastery: "ability_hunter_bestialdiscipline",
    Marksmanship: "ability_hunter_focusedaim",
    Survival: "ability_hunter_camouflage"
  },
  Mage: {
    Arcane: "spell_holy_magicalsentry",
    Fire: "spell_fire_firebolt02",
    Frost: "spell_frost_frostbolt02"
  },
  Monk: {
    Brewmaster: "spell_monk_brewmaster_spec",
    Mistweaver: "spell_monk_mistweaver_spec",
    Windwalker: "spell_monk_windwalker_spec"
  },
  Paladin: {
    Holy: "spell_holy_holybolt",
    Protection: "ability_paladin_shieldofthetemplar",
    Retribution: "spell_holy_auraoflight"
  },
  Priest: {
    Discipline: "spell_holy_powerwordshield",
    Holy: "spell_holy_guardianspirit",
    Shadow: "spell_shadow_shadowwordpain"
  },
  Rogue: {
    Assassination: "ability_rogue_deadlybrew",
    Outlaw: "ability_rogue_waylay",
    Subtlety: "ability_stealth"
  },
  Shaman: {
    Elemental: "spell_nature_lightning",
    Enhancement: "spell_shaman_improvedstormstrike",
    Restoration: "spell_nature_magicimmunity"
  },
  Warlock: {
    Affliction: "spell_shadow_deathcoil",
    Demonology: "spell_shadow_metamorphosis",
    Destruction: "spell_shadow_rainoffire"
  },
  Warrior: {
    Arms: "ability_warrior_savageblow",
    Fury: "ability_warrior_innerrage",
    Protection: "ability_warrior_defensivestance"
  }
};

// Warcraft Logs does not always report a class alongside a specialisation. A
// name that belongs to exactly one class stays resolvable on its own; a shared
// name without a class resolves to nothing, because a guess renders a
// confidently wrong icon.
const unambiguousSpecIconNames: ReadonlyMap<string, string> = (() => {
  const counts = new Map<string, string | null>();
  for (const specs of Object.values(specIconNames)) {
    for (const [specName, iconName] of Object.entries(specs)) {
      counts.set(specName, counts.has(specName) ? null : iconName);
    }
  }
  return new Map(
    [...counts].flatMap(([specName, iconName]) =>
      iconName === null ? [] : [[specName, iconName] as const]
    )
  );
})();

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

function specKey(value: string): string {
  return value.replaceAll(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Resolves the icon for a rank's specialisation. Warcraft Logs rarely reports a
 * class on its ranks, so `knownClassName` — the class the caller already holds
 * for this character, which cannot change — settles the four specialisation
 * names that two classes share.
 */
function specPerformance(
  identity: SpecIdentity | null,
  knownClassName?: string
): WarcraftLogsPerformance["spec"] {
  if (identity === null) return null;
  const specName = specKey(identity.specName);
  const className = specKey(identity.className ?? knownClassName ?? "");
  const iconName =
    (className === "" ? undefined : specIconNames[className]?.[specName]) ??
    unambiguousSpecIconNames.get(specName);
  return iconName === undefined
    ? null
    : {
        name: identity.specName,
        iconUrl: `https://wow.zamimg.com/images/wow/icons/medium/${iconName}.jpg`
      };
}

function normalizedPerformance(
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

type ZoneScope = Readonly<{
  /** The Warcraft Logs zone id, as the fights themselves report it. */
  zoneId: number;
  raidName: string;
  /** The most recent displayed kill in this zone, used to favour live tiers. */
  latestKilledAt: string;
}>;

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
function decodeZoneRankings(
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
    if (!response.ok) return responseLimitation(response, options.onThrottle);
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
    if (!response.ok) return responseLimitation(response, options.onThrottle);
    try {
      const body = await response.json();
      signal?.throwIfAborted();
      return graphQlErrorLimitation(body) ?? { kind: "success", value: body };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { kind: "limitation", code: "schema_drift" };
    }
  }

  async function getRateLimit(
    signal?: AbortSignal
  ): Promise<WarcraftLogsRateLimitResult> {
    const result = await graphql(rateLimitQuery, {}, signal);
    return result.kind === "success" ? rateLimitFacts(result.value) : result;
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
      className?: string;
      /**
       * Fight URLs whose parses are already stored. The budget is small, so a
       * run spends it on what is still missing rather than redoing the same
       * reports every time.
       */
      hydratedFightUrls?: ReadonlySet<string>;
      /**
       * When each zone's tier bests were last collected, keyed by raid id. A
       * zone collected since its newest kill is dropped before the zone budget
       * is measured, so a saturated character stops raising the cap.
       */
      collectedTierZones?: ReadonlyMap<string, string>;
      /**
       * Raids this character is finished with, per collection domain. A
       * terminal raid costs no request. Whether a raid is terminal is the
       * caller's policy; this only decides what to spend requests on.
       */
      terminalRaidIds?: Readonly<{
        kills: ReadonlySet<string>;
        parses: ReadonlySet<string>;
        tierBests: ReadonlySet<string>;
      }>;
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
        wipes.set(wipe.fightUrl, wipe);
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
    let parseRequests = 0;
    // Raids this read had trouble with, of any kind. Kept per raid rather than
    // per run so one zone's failure does not stop every other zone settling.
    const troubledRaidIds = new Set<string>();

    // The zones whose kills this dossier can display, newest raid night first.
    // A kill outside its raid's current-content window is never shown, so its
    // zone is not worth a request; an unknown window is left in, because
    // missing catalogue data must not silently disable collection.
    const zones = new Map<string, ZoneScope>();
    for (const kill of kills.values()) {
      if (currentContentEligibility(kill.killedAt, kill.raidName) === false) {
        continue;
      }
      const zoneId = Number(kill.raidId);
      if (!Number.isSafeInteger(zoneId) || zoneId <= 0) continue;
      const seen = zones.get(kill.raidId);
      zones.set(
        kill.raidId,
        seen
          ? {
              ...seen,
              latestKilledAt:
                kill.killedAt > seen.latestKilledAt
                  ? kill.killedAt
                  : seen.latestKilledAt
            }
          : {
              zoneId,
              raidName: kill.raidName,
              latestKilledAt: kill.killedAt
            }
      );
    }
    // Half of what is left once the canonical identity request is reserved, so
    // a character with a long history still advances its per-fight hydration.
    // One request covers a whole tier, so the newest zones — the ones a
    // reviewer is reading — are reached immediately and deeper tiers land on
    // later runs. A budget with nothing to spare after per-fight hydration
    // buys no zones at all rather than starving the row that needs an exact
    // fight.
    const zoneRequestCap = Math.floor((options.parseRequestCap - 1) / 2);
    const tierBests: WarcraftLogsTierBestParse[] = [];
    // Kept apart from `parseLimitation` so a zone-rankings failure never hides
    // a later per-fight failure, nor stops per-fight hydration being tried.
    let tierParseLimitation: WarcraftLogsLimitation | undefined;
    const orderedZones = [...zones.values()].sort(
      (a, b) =>
        b.latestKilledAt.localeCompare(a.latestKilledAt) || a.zoneId - b.zoneId
    );
    // A zone collected since its newest kill has nothing left to fetch, so it
    // is dropped before the budget is measured, not merely skipped inside it.
    // Without this the zone list is rebuilt whole on every run, a veteran
    // always exceeds the budget, and the run raises `parse_request_cap` no
    // matter how saturated it is -- while the budget re-reads the same newest
    // zones and never reaches the deeper ones it displaced.
    const pendingZones = orderedZones.filter((zone) => {
      const raidId = String(zone.zoneId);
      // A terminal zone is dropped before the budget is measured, not skipped
      // inside it, so it cannot raise a cap it no longer competes for.
      if (options.terminalRaidIds?.tierBests.has(raidId)) return false;
      const collectedAt = options.collectedTierZones?.get(raidId);
      return collectedAt === undefined || collectedAt <= zone.latestKilledAt;
    });
    if (pendingZones.length > zoneRequestCap) {
      tierParseLimitation = { kind: "limitation", code: "parse_request_cap" };
      // The zones the budget will not reach were read by nobody, so none of
      // them may settle on the strength of this run.
      for (const zone of pendingZones.slice(zoneRequestCap)) {
        troubledRaidIds.add(String(zone.zoneId));
      }
    }
    for (const zone of pendingZones.slice(0, zoneRequestCap)) {
      parseRequests += 1;
      const rankings = await graphql(
        characterZoneParsesQuery,
        {
          name: key.name,
          realm: key.realm,
          region: key.region,
          zoneID: zone.zoneId
        },
        options.signal
      ).catch((error: unknown) => {
        if (options.signal?.reason?.name !== "TimeoutError") throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      });
      if (rankings.kind !== "success") {
        troubledRaidIds.add(String(zone.zoneId));
        tierParseLimitation = toParseLimitation(rankings);
        // The loop stops here, so every zone still queued was read by nobody.
        for (const pending of pendingZones.slice(
          pendingZones.indexOf(zone) + 1,
          zoneRequestCap
        )) {
          troubledRaidIds.add(String(pending.zoneId));
        }
        break;
      }
      const decoded = decodeZoneRankings(
        rankings.value,
        zone,
        key,
        options.className
      );
      if (isLimitation(decoded)) {
        troubledRaidIds.add(String(zone.zoneId));
        tierParseLimitation = decoded;
        // Drift describes this one zone's response. Every other zone is a
        // separate request with its own answer, so the budget goes on reading
        // them rather than being abandoned over a shape one zone returned.
        if (decoded.code === "parse_schema_drift") continue;
        for (const pending of pendingZones.slice(
          pendingZones.indexOf(zone) + 1,
          zoneRequestCap
        )) {
          troubledRaidIds.add(String(pending.zoneId));
        }
        break;
      }
      tierBests.push(...decoded);
    }

    const groups = new Map<string, RankingScope>();
    const groupRaidIds = new Map<string, Set<string>>();
    // Grouped by report alone. A raid night's kills share one report, and one
    // ranking request returns all of them, so grouping any finer would spend a
    // request per boss for data the first request already carried.
    // A boss's first kill is the evidence the dossier headlines, so the budget
    // must reach it before any repeat kill of the same boss.
    const firstKillFightUrls = new Set<string>();
    const earliestByBoss = new Map<
      string,
      { killedAt: string; fightUrl: string }
    >();
    for (const kill of kills.values()) {
      const bossKey = `${kill.raidId} ${kill.bossId} ${kill.difficulty}`;
      const seen = earliestByBoss.get(bossKey);
      if (!seen || kill.killedAt < seen.killedAt) {
        earliestByBoss.set(bossKey, {
          killedAt: kill.killedAt,
          fightUrl: kill.fightUrl
        });
      }
    }
    for (const entry of earliestByBoss.values())
      firstKillFightUrls.add(entry.fightUrl);

    for (const kill of kills.values()) {
      // A kill outside its raid's current-content window is never shown, so
      // hydrating it spends a scarce, rate-limited request on nothing. An
      // unknown window is left alone: absent catalogue data must not silently
      // disable hydration.
      if (currentContentEligibility(kill.killedAt, kill.raidName) === false) {
        continue;
      }
      // A raid finished with is not hydrated again: its first-kill parses were
      // read cleanly once, and a concluded tier cannot produce a new one.
      if (options.terminalRaidIds?.parses.has(kill.raidId)) continue;
      if (options.hydratedFightUrls?.has(kill.fightUrl)) continue;
      const raidsInGroup = groupRaidIds.get(kill.reportCode);
      if (raidsInGroup) raidsInGroup.add(kill.raidId);
      else groupRaidIds.set(kill.reportCode, new Set([kill.raidId]));
      const isFirstKill = firstKillFightUrls.has(kill.fightUrl);
      const existing = groups.get(kill.reportCode);
      const fight = {
        encounterId: Number(kill.bossId),
        difficulty: kill.difficulty
      };
      groups.set(
        kill.reportCode,
        existing
          ? {
              ...existing,
              fights: new Map(existing.fights).set(kill.fightId, fight),
              earliestKilledAt:
                kill.killedAt < existing.earliestKilledAt
                  ? kill.killedAt
                  : existing.earliestKilledAt,
              latestKilledAt:
                kill.killedAt > existing.latestKilledAt
                  ? kill.killedAt
                  : existing.latestKilledAt,
              hasFirstKill: existing.hasFirstKill || isFirstKill
            }
          : {
              reportCode: kill.reportCode,
              fights: new Map([[kill.fightId, fight]]),
              earliestKilledAt: kill.killedAt,
              latestKilledAt: kill.killedAt,
              hasFirstKill: isFirstKill
            }
      );
    }
    const decodedGroups: Array<{
      group: RankingScope;
      decoded: Extract<
        ReturnType<typeof decodeRankingRows>,
        { identities: readonly RankingIdentity[] }
      >;
    }> = [];
    const identities = new Map<number, RankingIdentity>();
    // Every raid a group's fights belong to, so a failure can be attributed to
    // the tiers it actually touched rather than to the whole run.
    function troubleGroups(scopes: Iterable<RankingScope>): void {
      for (const scope of scopes) {
        for (const raidId of groupRaidIds.get(scope.reportCode) ?? []) {
          troubledRaidIds.add(raidId);
        }
      }
    }
    // Reports carrying a boss's first kill come first, newest tier before
    // oldest, then everything else. The budget is small and the upstream rate
    // limit tight, so what survives must be the evidence a dossier headlines,
    // starting with current content. Already-stored fights are skipped above,
    // so successive runs advance through the rest instead of redoing these.
    const orderedGroups = [...groups.values()].sort(
      (a, b) =>
        Number(b.hasFirstKill) - Number(a.hasFirstKill) ||
        b.latestKilledAt.localeCompare(a.latestKilledAt) ||
        a.reportCode.localeCompare(b.reportCode)
    );
    for (const [index, group] of orderedGroups.entries()) {
      // Reserve one request for the shared canonical identity lookup, so a cap
      // of N spends N-1 requests on rankings and one on identities.
      if (parseRequests + 1 >= options.parseRequestCap) {
        parseLimitation = { kind: "limitation", code: "parse_request_cap" };
        // Everything from here on was read by nobody, so none of the tiers
        // those reports belong to may settle on this run.
        troubleGroups(orderedGroups.slice(index));
        break;
      }
      parseRequests += 1;
      const rankings = await graphql(
        reportFightParsesQuery,
        { code: group.reportCode, fightIDs: [...group.fights.keys()] },
        options.signal
      ).catch((error: unknown) => {
        if (options.signal?.reason?.name !== "TimeoutError") throw error;
        return { kind: "limitation" as const, code: "unavailable" as const };
      });
      if (rankings.kind !== "success") {
        parseLimitation = toParseLimitation(rankings);
        troubleGroups(orderedGroups.slice(index));
        break;
      }
      const decoded = decodeRankingRows(rankings.value, group, key);
      if (isLimitation(decoded)) {
        parseLimitation = decoded;
        // One report's rankings being unreadable says nothing about the next
        // report's, so the remaining budget hydrates the groups it can rather
        // than stopping the run at the first response the decoder rejects.
        if (decoded.code === "parse_schema_drift") {
          troubleGroups([group]);
          continue;
        }
        troubleGroups(orderedGroups.slice(index));
        break;
      }
      decodedGroups.push({ group, decoded });
      for (const identity of decoded.identities)
        identities.set(identity.id, identity);
    }

    if (identities.size > 0) {
      if (parseRequests >= options.parseRequestCap) {
        parseLimitation ??= { kind: "limitation", code: "parse_request_cap" };
        // The identity lookup is shared, so without it no decoded group gets
        // its performance applied: every tier they cover was read incompletely.
        troubleGroups(decodedGroups.map(({ group }) => group));
      } else {
        const canonicalIdentities = [...identities.values()];
        const canonical = await graphql(
          rankingCharacterIdentityQuery(canonicalIdentities),
          Object.fromEntries(
            canonicalIdentities.map((identity, index) => [
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
          troubleGroups(decodedGroups.map(({ group }) => group));
        } else {
          const canonicalIds = decodeCanonicalIdentityIds(
            canonical.value,
            canonicalIdentities
          );
          if (isLimitation(canonicalIds)) {
            parseLimitation = canonicalIds;
            troubleGroups(decodedGroups.map(({ group }) => group));
          } else
            for (const { group, decoded } of decodedGroups) {
              const requestedIds = canonicalRankingCharacterIdsByIdentity(
                canonicalIds,
                decoded.identities,
                decoded.actors,
                key
              );
              if (isLimitation(requestedIds)) {
                parseLimitation = requestedIds;
                troubleGroups([group]);
                continue;
              }
              // No ranked appearance by this character in this report is an
              // ordinary gap - an unranked fight, or a report that ranks
              // nobody - so the group is left unparsed without a limitation.
              if (requestedIds.length === 0) continue;
              const performance = normalizedPerformance(
                decoded.rows,
                requestedIds,
                [...group.fights.keys()],
                options.className
              );
              if (isLimitation(performance)) {
                parseLimitation = performance;
                troubleGroups(
                  decodedGroups
                    .slice(decodedGroups.findIndex((it) => it.group === group))
                    .map((it) => it.group)
                );
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
    const reportedParseLimitation = parseLimitation ?? tierParseLimitation;
    const troubled = [...troubledRaidIds].sort();
    return sortedKills.length || sortedWipes.length
      ? {
          kind: "evidence",
          kills: sortedKills,
          wipes: sortedWipes,
          tierBests,
          troubledRaidIds: troubled,
          ...(scanLimitation ? { limitation: scanLimitation } : {}),
          ...(reportedParseLimitation
            ? { parseLimitation: reportedParseLimitation }
            : {})
        }
      : (scanLimitation ??
          reportedParseLimitation ?? {
            kind: "evidence",
            kills: [],
            wipes: [],
            tierBests: [],
            troubledRaidIds: troubled
          });
  }

  return { getRateLimit, resolveCharacter, getFirstKillReports };
}
