# Historic guild boss-rank research

Date: 2026-09-13

## Decision

Use Raider.IO's published Mythic boss leaderboard to enrich a verified Warcraft
Logs kill with a historical world boss-kill rank. Do not use a guild's current
zone rank as historic evidence.

## Published endpoints

Raider.IO documents the public endpoint:

```text
GET /api/v1/raiding/boss-rankings
  ?raid={raid-slug}&boss={boss-slug}&difficulty=mythic&region=world
```

Its `bossRankings` rows contain `rank`, guild identity and
`encountersDefeated.firstDefeated`. The companion
`GET /api/v1/guilds/boss-kill` endpoint returns the guild's `defeatedAt` and
roster but no rank. Source: [Raider.IO Developer API](https://raider.io/api)
and its [OpenAPI contract](https://raider.io/swagger.json).

## Matching rule

Assign a rank only if the mapped Mythic boss, normalized guild name, region,
realm (or connected realm), and first-defeat timestamp all match the WCL report
guild and kill time. Permit at most two minutes for source timestamp rounding.
Otherwise leave the rank unknown.

## Limits

- The response retains only the top 50 boss rows and has no paging parameter.
- The current documented raid coverage starts at Emerald Nightmare; older raids
  remain unranked.
- The API is public and rate limited. Cache lookups per boss and show
  Raider.IO attribution; do not scrape pages.

Warcraft Logs' guild-zone rank is current progression and its report rankings
are performance data, neither of which is a historical boss-progression rank.
Sources: [Guild zone rankings](https://www.warcraftlogs.com/v2-api-docs/warcraft/guildzonerankings.doc.html)
and [Report rankings](https://www.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html).
