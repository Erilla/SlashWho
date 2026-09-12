# Blizzard Cutting Edge achievement research

Date: 2026-09-12

## Decision

Yes. Blizzard's public character-achievements data can provide a verified,
historical **Cutting Edge achievement** for the entered character. This is a
better authority for Cutting Edge than inferring it from a recorded final-boss
kill: the achievement itself requires the Mythic kill before the following
raid tier releases.

The safe rule is: a character entry is Cutting Edge when its achievement ID is
in the current static **Feats of Strength → Raids** catalogue, its English name
starts exactly `Cutting Edge:`, and it has a numeric
`completed_timestamp`. Do not use only a name match from arbitrary character
data, and do not require `criteria.is_completed`.

## Official endpoints

Use client-credentials OAuth and the character's region:

1. `GET /profile/wow/character/{realm-slug}/{character-name}/achievements`
   with `namespace=profile-{region}` and `locale=en_GB`. It returns the
   character's achievement entries, including `id`, embedded achievement name,
   criteria, and `completed_timestamp`.
2. At catalogue-generation time, request
   `GET /data/wow/achievement-category/81` and then its Raids subcategory
   `GET /data/wow/achievement-category/15271`, using
   `namespace=static-{region}` and `locale=en_GB`.
3. Keep only the Raids category entries whose names begin `Cutting Edge:`. For
   a displayable raid/boss association and auditable description, fetch each
   selected `GET /data/wow/achievement/{id}` once during catalogue generation.

Blizzard documents the character endpoint in its [WoW Profile API
reference](https://community.developer.battle.net/documentation/world-of-warcraft/profile-apis),
and the static achievement/category endpoints in the [WoW Game Data API
reference](https://community.developer.battle.net/documentation/world-of-warcraft/game-data-apis).
Its API patch notes explicitly list the achievement and achievement-category
paths, while its API update distinguishes `profile-{region}` from
`static-{region}` namespaces: [endpoint list](https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-patch-notes-20200609/8902/1),
[namespace guidance](https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-update-visions-of-nzoth/3461).

## Live verification

An authenticated `static-eu` read on 2026-09-12 showed that category `81`
is **Feats of Strength**, with child category `15271` **Raids**. Category
`15271` has `parent_category.id: 81`; it contained 92 achievements, 33 of
which had the `Cutting Edge:` prefix.

For example, static achievement `40254` is named **Cutting Edge: Queen
Ansurek**, is zero points, and describes defeating Queen Ansurek in Nerub-ar
Palace on Mythic before the next raid tier. Its static `category` is `15271`
(**Raids**), not `81` directly; category ancestry therefore matters.

The character response for `eu/tarren-mill/lavalarryy` contained the same
achievement ID, the embedded name, and a millisecond
`completed_timestamp`. It also demonstrated why `criteria.is_completed` must
not be the completion test: another Cutting Edge entry had a timestamp while
its criteria field was false. Blizzard staff explicitly state that
`completed_timestamp` represents completion, while criteria completion is
character-specific for non-account-wide achievements: [completion
semantics](https://us.forums.blizzard.com/en/blizzard/t/character-achievements-api-when-is-an-achievement-completed/7171)
and [timestamp clarification](https://us.forums.blizzard.com/en/blizzard/t/wow-achievement-api-bug/1348).

## Implementation recommendation

- Generate and version a small static `cutting-edge-achievements` catalogue
  with achievement ID, English name, description, category ID, and retrieval
  time. Refresh it with the existing Blizzard Journal catalogue; never fetch
  dozens of static records during a dossier request.
- On every dossier request, retrieve the profile achievement list once and
  intersect completed IDs with that generated catalogue. Display the official
  achievement name and its completion timestamp as **Cutting Edge achieved**.
- Associate achievement records to the Journal/WCL raid and boss through a
  reviewed mapping. Achievement titles are not a stable boss key (for example,
  `Imperator's Fall`), so title parsing would create incorrect associations.
- Keep WCL evidence separate: it can substantiate the applicant's logged
  character kill and first logged guild, whereas the Blizzard achievement
  establishes that this character earned Cutting Edge. It does not establish a
  historic world rank or prove that the WCL report is the achievement-triggering
  kill.

## Limits to show in the dossier

The Profile API reflects what the Armoury exposes and can be affected by the
player's character-achievement display privacy setting; Blizzard says that
setting is not exposed through the API. Profile data may also be delayed until
the character logs out after the weekly reset. Therefore distinguish
**not found in public achievement data** from **did not earn Cutting Edge**,
and retain an explicit unavailable/hidden state rather than showing a negative
claim. These limitations are documented in Blizzard's [character achievement
API explanation](https://us.forums.blizzard.com/en/blizzard/t/character-achievements-api-when-is-an-achievement-completed/7171)
and [Profile API update](https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-update-visions-of-nzoth/3461).
