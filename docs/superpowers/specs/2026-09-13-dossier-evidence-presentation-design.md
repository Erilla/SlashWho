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
- Put newest Cutting Edge achievements first and make their scrollable body the
  same usable minimum height as Connected characters.
- Link every connected-character name to its Raider.IO character page and use
  the official class colour.
- Make Historic Mythic boss evidence span both dossier columns, display the
  first kill's date and character(s) in each boss headline, and label the
  disclosure "View kill evidence".
- Preserve every distinct Mythic WCL fight for each boss across all selected
  characters, with oldest evidence first in the disclosure.
- Populate historic world rank and first-kill guild from Raider.IO when it
  publishes those values for the matching earliest boss kill; show an explicit
  unknown only when neither source supplies it.
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

Raider.IO is the authoritative supplemental source for its published
`historicWorldRank` and first-defeated guild. Matching is by normalized raid and
boss identity per character. Warcraft Logs remains authoritative for report
URLs, participant attribution, and the full kill timeline. A rank is never
inferred from present-day guild rankings.

Tier recency comes from the static raid catalogue's canonical tier order (not
alphabetical raid names). Bosses sort final-boss first, then descending
encounter order. This intentionally reverses the prior encounter-order display.

## Presentation

`Connected characters` and `Historic Cutting Edge` render as separate panels
with a shared minimum content height and vertical scrolling when necessary.
Both the remaining content panels and the full-width Mythic evidence panel use
the same panel frame.

Each character name is a Raider.IO link with a class-derived colour while its
source badge and realm remain visible. Class is therefore added to the dossier
character contract and propagated from stored snapshot character metadata.

The Mythic evidence panel spans the grid. A boss header contains art, name,
first-kill date, first-kill character(s), and world rank. Expanding its details
lists all kill evidence in chronological order, including date, guild, rank,
report, and the participating dossier character(s).

## Error handling and honesty

- Raider.IO rank/guild absence does not discard valid WCL evidence.
- A mismatch between sources does not fabricate a rank: WCL keeps its report
  evidence and Raider.IO enrichment is omitted.
- A character without known class gets the standard link colour, not an
  invented class colour.
- Unknown rank and guild continue to render as `—`.

## Relationship to earlier evidence design

This supersedes the statement in
`2026-09-12-verified-applicant-evidence-design.md` that historic rank must
always remain null. That restriction correctly rejected _current WCL guild
rank_ as historical rank. This design instead uses Raider.IO's explicit
historical rank field, so it does not make that invalid inference.

## Testing strategy

- Domain tests cover achievement coalescing/earliest dates, all-kill retention,
  rank enrichment, and tier/boss ordering.
- Contract and application tests cover class propagation and source matching.
- Component tests cover panel roles/classes, Raider.IO links, class colouring,
  headline metadata, disclosure wording, and chronological evidence rows.
- Browser tests cover the full-width evidence panel and ordering on a rendered
  dossier.
