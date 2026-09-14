# Applicant Dossier Evidence Presentation Design

**Date:** 2026-09-13

**Status:** Approved for implementation

## Summary

Make the applicant dossier a reviewer-friendly, ordered presentation of the
complete public Mythic kill evidence across the submitted and linked
characters. Each visual section is a distinct panel. Cutting Edge achievements
are combined per achievement and show the earliest completion. Mythic boss
evidence is full-width and ordered newest tier first with the final boss first.

## Goals

- Show one Cutting Edge row per official achievement, across every dossier
  character, with its earliest completion and all qualifying characters.
- Render every Cutting Edge row as a modern, game-inspired achievement card
  with its official Blizzard achievement icon.
- Put newest Cutting Edge achievements first and make their scrollable body the
  same usable minimum height as Connected characters.
- Link every connected-character name to its Raider.IO character page and use
  the official class colour.
- Make Historic Mythic boss evidence span both dossier columns, display the
  first kill's date and character(s) in each boss headline, and label the
  disclosure "View kill evidence".
- Preserve every distinct Mythic WCL fight for each boss across all selected
  characters, with oldest evidence first in the disclosure.
- Populate historic world rank from Raider.IO's historical Mythic boss
  leaderboard only after it is matched to the verified WCL guild and kill;
  show an explicit unknown when the rank cannot be verified.
- Order tiers newest-first and each tier's bosses final-boss-first.

## Data and ordering

The dossier contract retains one boss summary (`firstKill`) and adds/retains an
ordered collection of all distinct kill evidence (`firstKills`). A shared WCL
fight is one evidence entry, attributed to every dossier character identified
in it. The collection sorts by kill time ascending, then a deterministic report
identifier.

The domain model combines official Cutting Edge records by achievement ID,
rather than achievement ID plus completion time. Its completion date is the
earliest observed date and its character list is the union of qualifying
characters. Those entries sort by completion date descending.

Warcraft Logs remains authoritative for report URLs, participant attribution,
report guild, and the full kill timeline. Raider.IO's published Mythic
boss-ranking endpoint is the rank authority. It is queried once per
catalogue-mapped boss, then a row must match the WCL evidence on normalized
guild name, region, realm/connected realm, and first-defeat timestamp within a
two-minute tolerance. The rank on that row is a historical world _boss-kill_
rank; a generic current guild or zone rank is never substituted.

Raider.IO's guild boss-kill endpoint may corroborate the matched guild and
timestamp but does not itself return rank. Rank enrichment is cached and capped
by unique boss to respect the public API's rate limit and to avoid a dossier
request multiplying calls by character.

Tier recency comes from the static raid catalogue's canonical tier order (not
alphabetical raid names). Bosses sort final-boss first, then descending
encounter order. This intentionally reverses the prior encounter-order display.

## Presentation

`Connected characters` and `Historic Cutting Edge` render as separate panels
with a shared minimum content height and vertical scrolling when necessary.
Both the remaining content panels and the full-width Mythic evidence panel use
the same panel frame.

Each Cutting Edge row is a modern interpretation of the in-game achievement
tooltip: dark treatment, a gold achievement title, concise description, earned
date, and qualifying characters. It uses the official Blizzard icon for the
achievement, not a locally invented emblem. The generated Cutting Edge
catalogue obtains the nullable icon URL once from Blizzard's static achievement
media resource and the dossier sends that public Render URL to the card. If an
official icon is unavailable, the card remains complete without an image.

Each character name is a Raider.IO link with a class-derived colour while its
source badge and realm remain visible. Class is therefore added to the dossier
character contract and propagated from stored snapshot character metadata.

The Mythic evidence panel spans the grid. A boss header contains art, name,
first-kill date, first-kill character(s), and world rank. Expanding its details
lists all kill evidence in chronological order, including date, guild, rank,
report, and the participating dossier character(s).

## Error handling and honesty

- Raider.IO rank absence does not discard valid WCL evidence.
- A mismatch between sources does not fabricate a rank: WCL keeps its report
  evidence and Raider.IO enrichment is omitted.
- Raider.IO returns only its retained top 50 ranking rows and covers retail
  raids from Emerald Nightmare onward. Evidence outside that coverage, outside
  the top 50, or with an ambiguous guild/realm/time match remains unranked.
- A character without known class gets the standard link colour, not an
  invented class colour.
- Unknown rank and guild continue to render as `—`.

## Relationship to earlier evidence design

This supersedes the statement in
`2026-09-12-verified-applicant-evidence-design.md` that historic rank must
always remain null. That restriction correctly rejected _current WCL guild
rank_ as historical rank. This design instead uses Raider.IO's dated,
boss-specific world-ranking row, so it does not make that invalid inference.

## Testing strategy

- Domain tests cover achievement coalescing/earliest dates, all-kill retention,
  rank enrichment, uncertain-match fallback, and tier/boss ordering.
- Raider.IO client tests cover boss-leaderboard parsing, cache keys, and the
  top-50/no-coverage unknown result.
- Contract and application tests cover class propagation and strict
  guild/realm/time source matching.
- Component tests cover panel roles/classes, Raider.IO links, class colouring,
  achievement-card icon/fallback rendering, headline metadata, disclosure
  wording, and chronological evidence rows.
- Browser tests cover the full-width evidence panel and ordering on a rendered
  dossier.
