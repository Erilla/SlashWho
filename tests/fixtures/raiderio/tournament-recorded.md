# Tournament profile recording

Recorded on 2026-09-14 from Raider.IO's public character endpoint for
`eu/eu-mythic-dungeons/Bindedpala`, its public owner's
`/api/user/view-characters?name=…` response, and the individual character
endpoint for one retail member of that same list.

`tournament-recorded.json` retains the observed character name, level, class,
realm and region structure and both tournament indicators:
`characterDetails.isTournamentProfile` (`true` / `false`) and
`character.realm.realmType` (`tr` / `live`). The profile-list response has the
realm type but no detail-level tournament flag.

Character names are replaced with `Tournament` and `Retail`; the owner name
is replaced with `fixture-owner`. Only these two members are retained. Gear,
scores, achievements, customization/contact fields and other unrelated
payload fields are omitted. No credentials or raw responses are stored.

Tests explicitly construct additional variants for malformed flags, declared
mains, absent realm type and differing slugs; these variants are synthetic,
not additional recorded upstream observations.
