/**
 * Every GraphQL document the client sends, and how a query names its
 * character. Nothing here decodes a response or spends a request.
 */
import type { CharacterKey } from "@slashwho/domain";

import type { RankingIdentity } from "./decode/rankings";

/** Warcraft Logs' difficulty id for Mythic, the only difficulty collected. */
export const MYTHIC_DIFFICULTY = 5;
// WCL's 50,000 query complexity ceiling is scored from the query's shape at
// about 1,625 a report, so a page holds at most 30. Points are charged per
// report for its fights (and, in the follow-up, its actors), so a bigger page
// saves no points. It would move every stored history cursor, which is a page
// number, and make a light refresh's one page dearer. Measured in
// docs/operations/evidence-run-cost.md.
export const REPORTS_PER_PAGE = 10;
/**
 * A guild listing that loads no report part costs about 1 point for up to 100
 * reports (1.83 for a full 100), so its page is as large as Warcraft Logs
 * serves.
 */
export const GUILD_REPORTS_PER_PAGE = 100;

export const resolveCharacterQuery = `
  query ResolveCharacter($name: String!, $realm: String!, $region: String!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        id
        name
        server {
          slug
          region { slug }
        }
      }
    }
  }
`;

export const resolveCharacterByIdQuery = `
  query ResolveCharacterById($id: Int!) {
    characterData {
      character(id: $id) {
        id
        name
        server {
          slug
          region { slug }
        }
      }
    }
  }
`;

/**
 * How a query names its character: by the stable ID when one is known, which
 * survives renames and transfers, and by name, realm and region otherwise.
 * The two differ only in the argument list and the variables they bind.
 */
export type CharacterLookup =
  | Readonly<{ kind: "name"; key: CharacterKey }>
  | Readonly<{ kind: "id"; characterId: number }>;

export function characterLookup(
  key: CharacterKey,
  characterId: number | undefined
): CharacterLookup {
  return characterId === undefined
    ? { kind: "name", key }
    : { kind: "id", characterId };
}

function characterParameters(lookup: CharacterLookup): string {
  return lookup.kind === "id"
    ? "$characterId: Int!"
    : "$name: String!, $realm: String!, $region: String!";
}

function characterArguments(lookup: CharacterLookup): string {
  return lookup.kind === "id"
    ? "id: $characterId"
    : "name: $name, serverSlug: $realm, serverRegion: $region";
}

export function characterVariables(
  lookup: CharacterLookup
): Record<string, string | number> {
  return lookup.kind === "id"
    ? { characterId: lookup.characterId }
    : {
        name: lookup.key.name,
        realm: lookup.key.realm,
        region: lookup.key.region
      };
}

export const recentReportsQuery = (lookup: CharacterLookup) => `
  query RecentReports(${characterParameters(lookup)}, $page: Int!) {
    characterData {
      character(${characterArguments(lookup)}) {
        server { normalizedName }
        recentReports(limit: ${REPORTS_PER_PAGE}, page: $page) {
          data {
            code
            startTime
            owner { name }
            guild { name server { slug region { slug } } }
            zone { id name encounters { id journalID } }
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

/**
 * The player actors of the history reports that hold a Mythic encounter fight,
 * one alias a report. Warcraft Logs charges a point for each report whose
 * `masterData` is loaded and another for its `fights`, and only a Mythic
 * encounter fight can become evidence, so a history page asks for fights alone
 * and loads actors only where they can attribute one (#712).
 */
export function reportActorsQuery(count: number): string {
  const variables = Array.from(
    { length: count },
    (_, index) => `$code${index}: String!`
  ).join(", ");
  const selections = Array.from(
    { length: count },
    (_, index) =>
      `report${index}: report(code: $code${index}) { code masterData { actors(type: "Player") { id name server type } } }`
  ).join("\n");
  return `query ReportActors(${variables}) { reportData { ${selections} } }`;
}

export const guildAttendanceQuery = `
  query GuildAttendance($name: String!, $realm: String!, $region: String!, $page: Int!) {
    guildData {
      guild(name: $name, serverSlug: $realm, serverRegion: $region) {
        attendance(limit: 25, page: $page) {
          data { code startTime players { name } }
          has_more_pages
        }
      }
    }
  }
`;

/**
 * A guild's reports that started inside a window, both ends inclusive. It
 * lists every report attendance lists and more, for 1 point a request against
 * attendance's ~1 a report, but names no players (measured 2026-09-28, #712).
 * An unknown guild is a GraphQL error, "No guild exists for this
 * name/server/region.", with `reports: null`.
 */
export const guildReportsQuery = `
  query GuildReports($name: String!, $realm: String!, $region: String!, $startTime: Float!, $endTime: Float!, $page: Int!) {
    reportData {
      reports(guildName: $name, guildServerSlug: $realm, guildServerRegion: $region, startTime: $startTime, endTime: $endTime, limit: ${GUILD_REPORTS_PER_PAGE}, page: $page) {
        data { code startTime }
        has_more_pages
      }
    }
  }
`;

export const characterGuildsQuery = `
  query CharacterGuilds($name: String!, $realm: String!, $region: String!) {
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        guilds { name server { slug region { slug } } }
      }
    }
  }
`;

export const reportByCodeQuery = `
  query ReportByCode($code: String!) {
    reportData {
      report(code: $code) {
        code
        startTime
        owner { name }
        guild { name server { slug region { slug } } }
        zone { id name encounters { id journalID } }
        masterData { actors(type: "Player") { id name server type } }
        fights {
          id encounterID name startTime endTime kill difficulty friendlyPlayers
          gameZone { id name }
        }
      }
    }
  }
`;

export const historicRaidZonesQuery = `
  query HistoricRaidZones {
    worldData { zones { id name partitions { id } encounters { id name } } }
  }
`;

export const historicZoneRankingsQuery = (lookup: CharacterLookup) => `
  query HistoricZoneRankings(${characterParameters(lookup)}, $zoneId: Int!, $partition: Int!) {
    characterData {
      character(${characterArguments(lookup)}) {
        id
        damage: zoneRankings(zoneID: $zoneId, difficulty: 5, partition: $partition, metric: dps, timeframe: Historical)
        healing: zoneRankings(zoneID: $zoneId, difficulty: 5, partition: $partition, metric: hps, timeframe: Historical)
      }
    }
  }
`;

export const historicEncounterRankingsQuery = (metric: "dps" | "hps") => `
  query HistoricEncounterRankings($characterId: Int!, $encounterId: Int!, $partition: Int!) {
    characterData {
      character(id: $characterId) {
        encounterRankings(encounterID: $encounterId, difficulty: 5, partition: $partition, metric: ${metric}, timeframe: Historical)
      }
    }
  }
`;

export const historicRankedReportQuery = `
  query HistoricRankedReport($code: String!, $fightId: Int!) {
    reportData {
      report(code: $code) {
        code startTime
        owner { name }
        guild { name server { slug region { slug } } }
        zone { id name encounters { id journalID } }
        rankedCharacters { id canonicalID name server { slug name } }
        masterData { actors(type: "Player") { id name server type } }
        fights(fightIDs: [$fightId]) {
          id encounterID name startTime endTime kill difficulty friendlyPlayers friendlySpecs
          gameZone { id name }
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
export const reportFightParsesQuery = `
  query ReportFightParses($code: String!, $fightIDs: [Int!]!) {
    reportData {
      report(code: $code) {
        code
        masterData { actors(type: "Player") { id name server type } }
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
export const characterZoneParsesQuery = (lookup: CharacterLookup) => `
  query CharacterZoneParses(${characterParameters(lookup)}, $zoneID: Int!) {
    characterData {
      character(${characterArguments(lookup)}) {
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
export const rateLimitQuery = `
  query RateLimit {
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

// A run's opening allowance and its character, in one document. Every request
// costs at least a point, and the two together cost one, so asking them apart
// spent a point a run on nothing. The allowance an in-document
// `rateLimitData` reports excludes that document's own charge, exactly as a
// lone `RateLimit` read does, so the reading means what it meant (measured
// 2026-09-28, #712).
export const rateLimitWithCharacterQuery = `
  query ResolveCharacter($name: String!, $realm: String!, $region: String!) {
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
    characterData {
      character(name: $name, serverSlug: $realm, serverRegion: $region) {
        id
        name
        server {
          slug
          region { slug }
        }
      }
    }
  }
`;

export function rankingCharacterIdentityQuery(
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
