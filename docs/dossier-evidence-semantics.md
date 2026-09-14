# Applicant dossier evidence semantics

## Historic Mythic kill events

SlashWho groups Historic Mythic kill evidence by canonical raid, canonical
boss, region, and UTC calendar date. Guild attribution is not part of event
identity because separate Warcraft Logs uploads can disagree or omit it.

Each grouped event retains every distinct supporting report or fight URL and
all participating connected characters. When reports provide conflicting
non-null guilds, the dossier displays the lexicographically first normalized
guild name and realm so the result is independent of input order. If only one
report supplies a guild, that attribution is displayed. Historic world rank is
shown only when the selected guild's matching evidence supplies one consistent
rank; a rank from a differently attributed report is never lent to it.

This intentionally favors a simplified reviewer surface: distinct reclears of
the same boss in the same region on the same UTC date may appear as one event.
Evidence on different dates, for different bosses, or from different regions
remains separate.
