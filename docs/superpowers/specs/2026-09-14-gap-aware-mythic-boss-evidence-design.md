# Gap-Aware Mythic Boss Evidence Design

**Date:** 2026-09-14

**Status:** Approved for implementation

## Summary

Extend the reviewer surface so every boss in every supported raid tier has an
honest aggregate evidence state. A boss is a verified kill when any linked
character has qualifying Mythic kill evidence, a wipe when no linked character
has a kill but at least one has a qualifying Mythic wipe, and `No logs found`
only when every selected character's bounded Warcraft Logs traversal completed
without either kind of evidence.

A supported tier with no qualifying evidence collapses to a greyed raid row
showing its name and `No logs found`. Positive and indeterminate tiers retain
their ordered boss rows. Incomplete upstream reads never become negative
evidence.

## Goals

- Represent every raid and encounter in the ordered supported raid catalogue.
- Aggregate linked-character boss evidence with strict precedence: kill, then
  wipe, then no logs.
- Require concrete Warcraft Logs fight participation for both kills and wipes.
- Make the absence result visibly and accessibly an evidence-search result, not
  proof that the applicant never attempted the encounter.
- Reuse the existing bounded character report traversal without introducing a
  per-tier or per-boss request multiplier.
- Preserve all current limitation behavior when evidence gathering is partial.

## Non-goals

- Do not claim that missing public logs prove a character did not attempt or
  kill a boss.
- Do not infer wipes from a missing kill.
- Do not retain every wipe or calculate pull counts, best percentage, or
  progression history.
- Do not persist applicant dossiers or raw Warcraft Logs responses.
- Do not query Warcraft Logs once per catalogue raid or encounter.
- Do not change the supported raid catalogue as part of this issue.

## Evidence semantics

For a requested character and boss, a qualifying fight must:

- map to a supported catalogue raid and encounter;
- have Mythic difficulty;
- identify the requested character as a friendly player in the fight; and
- contain a valid completed fight result.

`kill` must be `true` for kill evidence and `false` for wipe evidence. Trash,
non-Mythic fights, anonymous or mismatched actors, unsupported encounters, and
malformed fights are not evidence.

The Warcraft Logs gateway retains all existing kill records because downstream
logic needs distinct first kills. For wipes it retains one deterministic
representative record per character and boss: the most recent qualifying wipe,
breaking timestamp ties by report/fight URL. The wipe record contains the
attempt time and direct fight URL so the status remains auditable.

Across all selected linked characters, a boss state uses this precedence:

1. `kill` when at least one character has a qualifying kill;
2. `wipe` when there are no kills and at least one character has a qualifying
   wipe;
3. `no_logs` when there are no kills or wipes and every selected character's
   Warcraft Logs traversal completed; or
4. `incomplete` when there is no positive evidence and at least one relevant
   traversal was limited.

Positive evidence remains valid even if another character's traversal is
limited. A limitation only prevents a negative conclusion for a boss without
positive evidence.

## Architecture

`@slashwho/warcraftlogs` continues to own OAuth, pagination, request bounds,
actor matching, and report normalization. The existing report query already
requests the fight kill flag, difficulty, friendly-player IDs, and timing, so
the gateway will normalize qualifying `kill: false` fights during the same
requests used for kills. Its evidence result gains representative wipes and an
explicit completion signal derived from whether pagination ended normally.

`@slashwho/domain` owns catalogue traversal and evidence aggregation. The raid
catalogue will expose its ordered supported raids and encounters as immutable
values in addition to its existing lookup functions. The dossier builder will
start from that catalogue rather than only from observed kills, merge kills and
wipes by catalogue boss, and derive the aggregate state using the precedence
above. Catalogue tier order and encounter order remain the sole display-order
sources.

`@slashwho/application` maps normalized Warcraft Logs kills and wipes to domain
evidence per selected character. It also tells the domain builder which
characters completed Warcraft Logs traversal. Existing limitation records and
messages remain the reviewer-facing explanation for indeterminate evidence.
Cached evidence may supply existing kills, but it cannot establish a complete
negative scan unless the cache explicitly records the completed traversal and
wipe data needed by this design. Until that cache shape is extended, cached
kill-only evidence must be treated as incomplete for negative states.

`@slashwho/contracts` exposes a discriminated boss evidence state:

- `kill`, with existing first-kill evidence;
- `wipe`, with representative wipe time, report URL, and involved characters;
- `no_logs`; or
- `incomplete`.

The contract retains stable boss metadata on every variant. Variant-specific
fields prevent the UI from accidentally reading kill details from a wipe or
negative result.

## Data flow

```text
bounded WCL character report pages
  -> supported Mythic fights containing the requested character
  -> all kills + representative wipe per character/boss + completion state
  -> application mapping and existing limitation collection
  -> ordered raid catalogue traversal
  -> aggregate boss state (kill > wipe > no_logs/incomplete)
  -> reviewer-surface raid rows and accessible evidence details
```

## Reviewer-surface presentation

Supported raids appear in catalogue tier order.

A tier containing any kill, wipe, or incomplete boss renders its complete boss
sequence. Each boss has a distinct icon shape and visible text equivalent:

- `Verified Mythic kill` with the existing check icon and kill details;
- `Mythic wipe found` with a distinct wipe icon and expandable attempt evidence;
- `No qualifying public logs found` with a distinct no-log icon; or
- `Evidence incomplete`, with no negative icon and the existing limitation
  explanation elsewhere in the dossier.

The aggregate kill or wipe details name all linked characters contributing to
that state. Kill evidence takes precedence, so wipe evidence is not displayed
for a boss that has any verified kill.

When every boss in a tier is `no_logs`, the tier collapses to one visually
muted row containing the raid name and the exact visible text `No logs found`.
Its accessible name and nearby explanatory copy state `No qualifying public
logs found; this does not prove no attempt.` The muted styling supplements the
text and must not be the only state cue.

The existing global empty state disappears because the supported catalogue
always supplies raid rows. If no tier contains positive evidence, the reviewer
still sees the collapsed no-log rows or incomplete states as appropriate.

## Bounds and failure handling

- Keep the existing ten reports per Warcraft Logs page.
- Keep the dossier-wide request cap, per-character allocation, selected
  character cap, and overall timeout already validated by application config.
- Traverse the finite checked-in catalogue in memory; this creates no external
  requests.
- A private, not-found, rate-limited, capped, unavailable, timed-out, or
  schema-invalid Warcraft Logs response makes that character's traversal
  incomplete.
- Evidence collected before a later limitation remains usable as positive kill
  or wipe evidence.
- Any unresolved boss whose negative result depends on an incomplete character
  scan becomes `incomplete`, never `no_logs`.
- Unsupported or ambiguous raid metadata remains excluded instead of being
  guessed into a catalogue row.

## Testing strategy

- Warcraft Logs gateway tests prove that a Mythic `kill: false` fight becomes
  wipe evidence only when the requested character participated, that the most
  recent representative wipe is deterministic, and that pagination completion
  or limitation is reported honestly.
- Domain tests prove full catalogue traversal, natural raid/boss ordering,
  kill-over-wipe precedence across linked characters, wipe-over-no-log
  precedence, and the incomplete-scan guard on negative states.
- Application tests prove completion metadata and wipe attribution cross the
  service boundary, and that cached kill-only evidence cannot produce negative
  states.
- Contract tests prove all four boss variants accept only their relevant
  fields.
- Component tests prove accessible icons and visible labels, evidence links and
  character attribution, incomplete presentation, and the greyed whole-tier
  `No logs found` row with its non-conclusive explanation.
- The full unit, integration, typecheck, lint, format-check, build, and relevant
  browser test suites run before the PR is opened.

## Source evidence

The Warcraft Logs GraphQL schema documents report fights, their kill result,
difficulty, and friendly-player membership. The design deliberately reuses
those fields from the existing bounded report query rather than adding a
per-encounter query surface:

- <https://www.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html>
- <https://www.warcraftlogs.com/v2-api-docs/warcraft/reportfight.doc.html>
