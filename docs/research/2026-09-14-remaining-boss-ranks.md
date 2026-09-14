# Remaining historic boss rankings

Follow-up to issue #80, checked against the public Raider.IO API on 2026-09-14.

## Correction: guild-specific boss ranks are available

The coverage conclusion below describes only the documented public leaderboard,
not all data available from Raider.IO. Inspection of the guild website found
`/api/guilds/raid-rankings?region=eu&realm=draenor&guild=Rancour&raid=the-venomous-abyss&difficulty=mythic`.
Its `bossRankings` entries carry explicit `boss` and `ranks.world` fields:
Sszorak 276, Vashnik 476, Entombed Sentinels 297, Lost Explorers 30 and Nekzali 48.
Historical Nerub-ar Palace returns eight boss ranks, including Queen Ansurek
381 (distinct from the overall raid rank of 371).

The client now joins this website endpoint with the documented guild profile's
`raid_encounters:RAID:mythic` field. Only a boss with a confirmed defeat date
is eligible: the website also returns attempt standings for undefeated bosses.
The application retains exact boss/guild/realm/region and first-kill time matching,
and shares a bounded 15-minute cache by guild and raid across all linked characters.
The website endpoint is not the documented v1 contract; strict schema validation
preserves a source limitation if it changes.

The following investigation is retained as context for the earlier incorrect
conclusion; it is superseded by this verified source.

## Verified identifier fixes

The [static-data endpoint](https://raider.io/api/v1/raiding/static-data?expansion_id=11)
groups The Voidspire, The Dreamrift and March on Quel'Danas under `tier-mn-1`.
Fallen-King Salhadaar uses `fallenking-salhadaar`. The [previous expansion's
static data](https://raider.io/api/v1/raiding/static-data?expansion_id=10) identifies
Dimensius as `dimensius`, despite the Journal name being longer.

Live world Mythic boss requests for Dimensius, Fallen-King Salhadaar, Vaelgor &
Ezzorak, Chimaerus and Midnight Falls all succeeded with these identifiers.
Each returned 50 entries and none contained Rancour. Correct identifiers fix
failed/skipped lookups, but cannot supply a rank absent from the response.

## Broader ranking coverage remains unresolved

The [published API specification](https://raider.io/swagger.json) documents
`region` and `realm` filters for `raiding/boss-rankings`, but no pagination or
guild filter. The default world requests inspected return 50 entries.

For Queen Ansurek, an EU/Draenor boss request does contain Rancour, with rank 15
and regionRank 227, but no worldRank. Rank 15 is the realm position, so it must
not be displayed as a world rank.

The guild-filtered world `raiding/raid-rankings` endpoint and guild profile
`raid_rankings:nerubar-palace` field return Rancour at world 371. These are raid
progression rankings, not a documented per-boss world rank. The guild profile's
`raid_encounters` field and `guilds/boss-kill` endpoint provide kill timestamps
without a boss world rank. The hall-of-fame response inspected contains only
the top three guilds per boss.

Do not substitute a realm position or overall raid position into the existing
boss world-rank field. Issue #80 remains open for a supported source of broader
historic boss world ranks and clearer missing-rank presentation.
