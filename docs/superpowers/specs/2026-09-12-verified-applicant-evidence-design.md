# Verified Applicant Evidence Design

**Date:** 2026-09-12

**Status:** Approved for implementation

## Summary

Enrich an applicant dossier with only Warcraft Logs facts that its documented
public GraphQL schema can prove: the report guild and the timestamp at which a
Mythic encounter died. Add a versioned raid-tier catalogue to identify raid
encounters and final encounters, allowing the existing pure dossier aggregation
to mark a tier as Cutting Edge only when public Mythic kill evidence includes
its catalogue final encounter.

Historic world rank remains `null`. Warcraft Logs exposes current guild-zone
progression rank, not the guild's rank at a historical kill. The application
must not substitute one for the other.

## Goals

- Attribute an accepted first Mythic kill to the guild recorded on its report.
- Use the kill's end time, not the start of the pull, for the first-kill date
  and ordering.
- Render only configured raid tiers, excluding Mythic+ seasons and other
  non-raid WCL zones.
- Mark a raid `cuttingEdge: true` only when its configured final Mythic boss
  appears in the dossier's verified evidence; otherwise retain `null`.
- Retain each tier's complete boss ordering in one auditable catalogue so the
  UI can state which bosses have evidence and which have no conclusion.
- Make unmapped WCL raid metadata visible as a limitation rather than guessing.

## Non-goals

- Do not persist evidence, reports, or dossier results.
- Do not show a guild's current zone rank as historic world rank.
- Do not infer a guild from the applicant's current roster or profile.
- Do not infer a final boss from encounter ID ordering supplied by WCL.

## Architecture

`@slashwho/warcraftlogs` remains responsible for OAuth, report pagination, and
normalizing report facts. Its report query asks for `Report.guild` and each
fight's `endTime`; it returns a nullable guild and `report.startTime +
fight.endTime` for a valid kill.

`@slashwho/domain` owns a static, versioned raid-tier catalogue. A catalogue
entry is keyed by WCL zone ID and contains the display name, final encounter
ID, and the full ordered encounter list. It is the sole source for whether a
zone is a raid, boss order, and final-boss status. The catalogue is compiled
from documented game/journal evidence with a source reference per tier; it is
not derived from an upstream response at request time.

The normalized client passes WCL zone and encounter IDs to the catalogue. An
unmapped zone produces a `raid_metadata_unknown` dossier limitation and is not
rendered as Cutting Edge evidence. A mapped encounter has its catalogue name,
order, and final-boss flag. The existing dossier builder continues to select
the earliest valid kill per character/boss, deduplicate shared report fights,
and derives `cuttingEdge` from the catalogue final-boss flag.

## Data flow

```text
public WCL report
  -> report guild + report start + fight end + zone/encounter IDs
  -> WCL normalized evidence
  -> raid-tier catalogue lookup
  -> verified boss evidence / visible unmapped-metadata limitation
  -> pure dossier aggregation
  -> applicant UI
```

## Error handling and honesty rules

- `Report.guild: null` is displayed as an unknown guild; it is not a failure.
- A missing or malformed `endTime` makes that report page schema-invalid, with
  any earlier collected evidence retained under the existing partial-result
  behavior.
- A zone or encounter absent from the catalogue never gets an invented order,
  final-boss flag, or Cutting Edge claim.
- A catalogue tier appears only with verified boss evidence. Missing boss
  evidence is not evidence that the applicant failed to kill it.
- Historic world rank stays `null` with the existing unknown presentation.

## Catalogue coverage

The catalogue must cover every WCL raid zone that this application supports,
with every encounter in each tier. Entries are added in source-reviewed
chunks, and an unmapped-zone limitation is the safe behaviour while coverage
is expanded. This makes the existing live result immediately less misleading
without falsely claiming that a partial catalogue is all historic coverage.

## Testing strategy

- A WCL client test proves that a report guild and fight end time normalize
  into first-kill evidence.
- A WCL client test proves a report without a guild remains valid and has a
  nullable guild.
- Domain tests prove catalogue order/final-boss metadata controls Cutting Edge
  and excludes non-raid zones.
- Application tests prove an unmapped zone becomes a visible limitation and
  no Cutting Edge raid is emitted from it.
- Contract/UI tests prove guild display and unknown historical rank remain
  explicit.

## Source evidence

The supported WCL fields and the historic-rank limitation are recorded in
`docs/research/2026-09-12-warcraft-logs-applicant-evidence-api.md`.
