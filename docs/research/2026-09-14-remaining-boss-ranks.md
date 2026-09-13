# Remaining historic boss rankings

Follow-up to issue #80, checked against the public Raider.IO API on 2026-09-14.

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
