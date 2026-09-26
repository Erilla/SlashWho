/**
 * Every GraphQL document the client sends, and how a query names its
 * character. Nothing here decodes a response or spends a request.
 */
import type { CharacterKey } from "@slashwho/domain";

import type { RankingIdentity } from "./decode/rankings";

/** Warcraft Logs' difficulty id for Mythic, the only difficulty collected. */
export const MYTHIC_DIFFICULTY = 5;
// WCL's 50,000 query complexity ceiling is scored from the query's shape at
// about 1,625 a report, so a page holds at most 30. Points are about 2.08 a
// report, so a bigger page saves no points. It would move every stored history
// cursor, which is a page number, and make a light refresh's one page dearer.
// Measured in docs/operations/evidence-run-cost.md.
export const REPORTS_PER_PAGE = 10;

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
            masterData { actors(type: "Player") { id name server type } }
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
