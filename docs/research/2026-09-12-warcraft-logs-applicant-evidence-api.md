# Warcraft Logs applicant-evidence API research

Date: 2026-09-12

## Scope and source authority

This note covers the public Warcraft Logs v2 GraphQL client API, using its
published schema and a schema introspection check against the client endpoint.
The documented client endpoint is `https://www.warcraftlogs.com/api/v2/client`;
it uses client-credentials OAuth. The API overview describes the schema as the
source of truth: <https://www.warcraftlogs.com/api/docs>.

## Report attribution and Mythic kill evidence

`Report.guild` is the authoritative report-level guild attribution. It is
nullable: a null value means the report was uploaded to personal logs. The
`Guild` object has `id`, `name`, and `server`; this is the appropriate guild to
associate with a recorded kill, rather than the character's current `guilds`
membership.

`Report.fights` accepts `difficulty`, `encounterID`, `fightIDs`, `killType`,
and `translate`. Each `ReportFight` supplies `id`, `encounterID`, `name`,
`difficulty`, `kill`, `startTime`, and `endTime`. Report timestamps are in
milliseconds and the fight timestamps are relative to `Report.startTime`.
For the time the boss died, use `report.startTime + fight.endTime`; using
`fight.startTime` identifies the start of the pull instead.

Official schema references:

- [Report](https://www.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html)
- [ReportFight](https://www.warcraftlogs.com/v2-api-docs/warcraft/reportfight.doc.html)
- [Guild](https://www.warcraftlogs.com/v2-api-docs/warcraft/guild.doc.html)
- [Server](https://www.warcraftlogs.com/v2-api-docs/warcraft/server.doc.html)
- [Character](https://www.warcraftlogs.com/v2-api-docs/warcraft/character.doc.html)

Example query for an already-known report code:

```graphql
query ReportApplicantEvidence($code: String!) {
  reportData {
    report(code: $code) {
      code
      startTime
      guild {
        id
        name
        server {
          name
          slug
          region {
            slug
          }
        }
      }
      fights(killType: Kills) {
        id
        encounterID
        name
        difficulty
        kill
        startTime
        endTime
      }
    }
  }
}
```

`reportData.report(code:allowUnlisted:)` is documented in
[ReportData](https://www.warcraftlogs.com/v2-api-docs/warcraft/reportdata.doc.html).
For public dossier input, do not set `allowUnlisted: true`; the schema warns
that multi-user applications should avoid doing so unless they can authorize
access to the code.

## Guild world rank

The published schema supports a guild's zone progression rank:

```graphql
query GuildZoneRank($guildId: Int!, $zoneId: Int!) {
  guildData {
    guild(id: $guildId) {
      zoneRanking(zoneId: $zoneId) {
        progress {
          worldRank {
            number
          }
          regionRank {
            number
          }
          serverRank {
            number
          }
        }
      }
    }
  }
}
```

The exact path is `Guild.zoneRanking(zoneId)`, then
`GuildZoneRankings.progress(size)`, then
`WorldRegionServerRankPositions.worldRank/regionRank/serverRank`, each a
`Rank` with `number`, `percentile`, and `color`.

Official schema references:

- [GuildData](https://www.warcraftlogs.com/v2-api-docs/warcraft/guilddata.doc.html)
- [GuildZoneRankings](https://www.warcraftlogs.com/v2-api-docs/warcraft/guildzonerankings.doc.html)
- [WorldRegionServerRankPositions](https://www.warcraftlogs.com/v2-api-docs/warcraft/worldregionserverrankpositions.doc.html)
- [Rank](https://www.warcraftlogs.com/v2-api-docs/warcraft/rank.doc.html)

### Important limitation

This is a current guild-zone progression rank, not a documented historic rank
at a report's kill timestamp. `zoneRanking` has no timestamp or partition
argument, and the Guild documentation says omitting the zone selects the latest
zone. `Report.rankings(timeframe: Historical)` exists, but it is mutable JSON
for report/fight/player ranking data; the schema does not document it as a
guild-progression rank at the kill. Therefore the API above must not be shown
as “world rank for that boss when killed.”

## Raid metadata and Cutting Edge

`worldData.zone(id)` and `worldData.zones(expansion_id)` expose zones. A
`Zone` has `id`, `name`, `difficulties`, `encounters`, `expansion`, `frozen`,
and `partitions`; an `Encounter` has `id`, `name`, `journalID`, and `zone`.
The schema exposes no encounter ordering, final-boss marker, Cutting Edge flag,
or historic achievement claim.

Official schema references:

- [WorldData](https://www.warcraftlogs.com/v2-api-docs/warcraft/worlddata.doc.html)
- [Zone](https://www.warcraftlogs.com/v2-api-docs/warcraft/zone.doc.html)
- [Encounter](https://www.warcraftlogs.com/v2-api-docs/warcraft/encounter.doc.html)

Conclusion: Warcraft Logs can provide report guild and verified Mythic kill
evidence, but cannot by itself establish Cutting Edge or a historic
world-rank-at-kill. Those claims require a separate authoritative historical
source or explicit curated data with provenance.
