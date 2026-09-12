# Blizzard Journal API raid catalogue research

Date: 2026-09-12

## Decision

Blizzard's Journal Game Data API is a good **automatic seed and refresh
source for the live Retail Encounter Journal**. It can supply a raid's stable
instance ID, encounter IDs, names, difficulty support, and the encounter list
as displayed by the Journal. It is **not sufficient by itself** to make the
two applicant claims that need historical meaning:

- it has no documented `is_final_boss`, encounter-order, Cutting Edge, tier
  release-date, or historical-snapshot field;
- it does not provide historic world rank.

Therefore use it to generate a versioned catalogue, but retain a small,
reviewed override/provenance record for each raid's final boss (and a separate
achievement/tier policy for Cutting Edge). Do not label the last element of
`encounters` as final without that review: it is a reasonable Journal-display
inference, not an API guarantee.

## Automatic catalogue workflow

Use client-credentials OAuth to obtain a bearer token, then query static Game
Data in the character's region:

1. `GET https://{region}.api.blizzard.com/data/wow/journal-expansion/index`
   with `namespace=static-{region}` and a locale. The current response calls
   the collection `tiers` (not `expansions`).
2. Fetch each `tiers[].key.href` (`/data/wow/journal-expansion/{id}`). Its
   `raids[]` list is already separated from dungeons.
3. Fetch each `raids[].key.href`
   (`/data/wow/journal-instance/{id}`). Keep only instances whose
   `category.type` is `RAID`; persist instance ID/name, expansion ID/name,
   `modes`, and the ordered-as-returned `encounters[]` IDs/names.
4. Optionally fetch `/data/wow/journal-encounter/{id}` for encounter detail.
   Match Blizzard Journal encounter IDs to Warcraft Logs `Encounter.journalID`,
   rather than assuming a Warcraft Logs encounter ID is a Blizzard Journal ID.

The Bearer token is obtained with `POST
https://{region}.battle.net/oauth/token`, HTTP Basic client ID/secret and
`grant_type=client_credentials`. This is server-to-server authentication; no
user redirect URL or sign-in is needed.

Official endpoint inventory and static namespace guidance are in Blizzard's
[Journal API announcement](https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-update-visions-of-nzoth/3461) and the
[WoW Game Data API reference](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis).
The official announcement also says this Journal API release does not apply to
WoW Classic, so it must not be represented as a complete Classic-era
historical authority.

## Live verification

On 2026-09-12, an authenticated `static-eu` response for **Nerub-ar Palace**
(instance `1273`) contained:

- `category.type: "RAID"`;
- `modes` including `MYTHIC`;
- eight ordered encounter references, ending with Queen Ansurek;
- `expansion` pointing to The War Within.

The expansion endpoint yielded raid lists for Classic through the current
Retail expansion. It also exposed non-progression/special instances (for
example Blackrock Depths, Khaz Algar, Dragon Isles, Invasion Points) and a
duplicated `Current Season`/expansion listing. Catalogue generation therefore
needs explicit filters and deduplication before it becomes the applicant
raid-tier list.

## Warcraft Logs linkage

Warcraft Logs' official schema provides `Zone.encounters` and each
`Encounter.journalID`; that lets the app associate a logged boss kill with the
Blizzard Journal record. Its schema exposes no encounter order or final-boss
flag, which is why the Blizzard data still cannot eliminate the reviewed
final-boss mapping.

- [Warcraft Logs Zone schema](https://www.warcraftlogs.com/v2-api-docs/warcraft/zone.doc.html)
- [Warcraft Logs Encounter schema](https://www.warcraftlogs.com/v2-api-docs/warcraft/encounter.doc.html)

## Implementation consequences

- Refresh and snapshot generated catalogue data during releases; do not query
  it on every dossier request.
- Store `source: blizzard-journal`, retrieval time, locale, instance ID and
  encounter IDs alongside generated records.
- Store reviewed `finalBossJournalEncounterId` separately, including its
  source and reviewer. This makes a change to the generated list auditable.
- Compute a Cutting Edge candidate only when the dossier has a verified Mythic
  kill of that reviewed final boss and the raid's explicit CE policy says it
  applies. Older raid difficulties and achievement timelines require that
  policy; a generic "last boss killed" rule would overclaim.
- Continue displaying historic world rank as unavailable until an authoritative
  timestamped ranking source is added.
