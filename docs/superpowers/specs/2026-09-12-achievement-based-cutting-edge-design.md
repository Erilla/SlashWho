# Achievement-Based Cutting Edge Design

**Date:** 2026-09-12

**Status:** Approved for planning

## Summary

Use Blizzard's public character-achievements profile response as the sole
authority for an applicant's historic Cutting Edge achievements. A generated,
versioned catalogue contains only the achievement IDs in the official Feats of
Strength > Raids category whose English name begins `Cutting Edge:`. The
dossier intersects each researched character's completed achievement IDs with
that catalogue and renders the official achievement name and completion date.

Warcraft Logs continues to provide boss-level logged kill evidence, report
links, and first logged guilds. It does not prove Cutting Edge, and it is not
used to infer it. Historic world rank remains unknown.

## Goals

- Show every publicly verifiable Cutting Edge achievement for every dossier
  character, including its official name and completion timestamp.
- Use only a numeric `completed_timestamp` to establish completion.
- Keep an auditable, generated static catalogue; do not query achievement
  categories or individual achievement definitions while serving dossiers.
- Keep logged Mythic boss evidence and official Cutting Edge achievements
  separate in the public contract and UI.
- Make unavailable, private, malformed, rate-limited, and capped Blizzard
  achievement reads explicit limitations, never a negative claim.

## Non-goals

- Do not infer a Cutting Edge achievement from a final-boss kill, encounter
  order, achievement title, or completion criteria.
- Do not associate achievements to raids or bosses by parsing their title.
- Do not persist raw achievement profiles, achievement IDs outside the
  generated catalogue, or dossier results.
- Do not claim historic world rank.

## Architecture

### Catalogue generation

Extend the existing credentialed Blizzard generation script to fetch static
achievement category `81` (Feats of Strength), its `15271` Raids child, and
the definitions of its `Cutting Edge:` entries. It writes a checked-in JSON
catalogue containing achievement ID, English name, description, category ID,
and generation timestamp. Generation validates the parent/child hierarchy and
prefix so a category drift fails the build instead of silently broadening the
catalogue.

### Runtime profile evidence

Extend `BlizzardGateway` with a separate `getCompletedAchievements` method
that returns only numeric achievement IDs and ISO timestamps from the public
character profile endpoint. The method is distinct from the existing
achievement-fingerprint method so its different retention and error semantics
remain visible. The web container creates this gateway using server-only
Blizzard credentials; the same `BLIZZARD_CLIENT_ID` and
`BLIZZARD_CLIENT_SECRET` must be present on the Railway **web** service, never
sent to the browser.

`ApplicantDossierService` fetches this evidence once per selected dossier
character in parallel with Warcraft Logs. It intersects completed IDs with the
generated catalogue and emits separate Cutting Edge records. Failures become a
`blizzard` limitation for that character while preserving WCL results and any
other characters' achievement evidence.

### Contract and UI

`ApplicantDossier` gains `cuttingEdges`, a chronologically ordered collection
of `{ achievementId, achievementName, description, completedAt, characters }`.
Shared completed achievements are grouped only when their ID and timestamp
match; character names are retained as evidence. The dossier page has a
Historic Cutting Edge section displaying official achievement names and dates,
and renames the existing raid section to Historic Mythic boss evidence. A
missing or unavailable achievement profile shows an explicit limitation; an
empty valid profile says no public Cutting Edge achievements were found, not
that the applicant failed to achieve CE.

## Data flow

```text
Blizzard static achievement categories (generation only)
  -> versioned Cutting Edge catalogue

public Blizzard character achievements
  -> completed IDs + timestamps
  -> catalogue intersection
  -> Cutting Edge dossier records

public Warcraft Logs reports
  -> logged boss, guild, end time, report URL
  -> historic Mythic boss evidence
```

## Error handling and honesty rules

- Treat an unreadable achievement profile as unknown; never infer a missing CE.
- Treat an empty, valid profile response as no **public** CE achievement data.
- Ignore an achievement entry without a finite numeric completion timestamp.
- Do not use `criteria.is_completed` as it can disagree with the timestamp for
  account-wide achievements.
- Do not use a static achievement title as a raid or boss key.
- Existing WCL partial-result and historic-rank behaviour is unchanged.

## Testing strategy

- Blizzard client tests cover URL, normalization, timestamp-only completion,
  and typed upstream failures.
- Catalogue generator tests cover Feats of Strength ancestry, prefix filtering,
  deterministic output, and malformed static data.
- Domain tests cover catalogue intersection, ordering, shared-character
  grouping, and the exclusion of timestamp-free/unknown IDs.
- Application tests cover per-character Blizzard limitations without loss of
  WCL evidence.
- Contract/UI tests cover the new CE collection, separation from boss evidence,
  and public unknown/empty copy.

## Source evidence

The official endpoint and live-response findings are documented in
`docs/research/2026-09-12-blizzard-cutting-edge-achievements.md`.
