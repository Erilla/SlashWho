# Warcraft Logs Fight Parses Design

**Date:** 2026-09-14

**Issue:** #90

**Status:** Approved for implementation

## Purpose

Add player-specific Warcraft Logs performance parses to verified Historic
Mythic kill evidence without weakening the dossier's evidence boundaries. A
parse is evidence about one character in one public report fight. It must not
be borrowed from a different kill, encounter, difficulty, report, or patch.

Every displayed kill event will expose the best valid parse found among that
event's supporting reports. Each boss summary will also show the first event's
parses and the best parses found across all evidence events displayed for that
boss. "Best" never expands the search beyond SlashWho's displayed evidence.

## Provider semantics

The worker will use the public Warcraft Logs v2 `Report.rankings` field. After
the existing report scan discovers valid Mythic kill evidence, the client will
load rankings for the retained report and fight identifiers in a second phase.
One report query may cover several retained fight IDs and will request three
aliases:

- `playerMetric: dps` for damage;
- `playerMetric: hps` for healing; and
- `playerMetric: bossdps` for boss damage.

All three use the verified fight's Mythic difficulty (currently `5` for the
supported Retail raid evidence), `timeframe: Historical`, and
`compare: Rankings`. This defines each value as the fight's historical,
all-bracket percentile compared with other players' best rankings, rather than
a current-day or item-level-bracket percentile. The UI labels the values as
historical parse percentiles and does not expose raw DPS/HPS amounts as though
they were percentiles.

`Report.rankings` returns an explicitly mutable `JSON` scalar. The schema is
authoritative for the field and its arguments, but not for the JSON object's
internal shape. The client therefore treats the response as untrusted data,
normalizes only documented and fixture-proven fields, and converts structural
changes into a parse-specific limitation.

## Attribution and selection

A credentialed contract spike against controlled public DPS, healer, and tank
reports is the first implementation task. It will capture sanitized fixtures,
measure the query's point cost, and establish which identity and missing-state
fields the opaque JSON actually supplies. No decoder is implemented from
guessed keys.

A ranking entry is eligible only when the observed contract can prove all of
the following match the kill record being enriched:

- report code;
- fight ID;
- encounter ID;
- Mythic difficulty;
- canonical character name, realm, and region; and
- requested metric.

Matching by name alone is forbidden. If the runtime payload cannot prove the
strong character identity required above, no parse is accepted. A row from
another fight, character, realm, difficulty, or encounter is ignored and
cannot supply a fallback.

When Warcraft Logs yields more than one eligible value for a
character/metric/fight, the highest valid percentile is retained. When the
domain later groups multiple supporting reports into one displayed kill event,
it selects the highest valid percentile per character and metric from only
those reports. The selected value retains its exact fight URL. The earliest
displayed event supplies the boss's "First kill parses" summary. The highest
value per character and metric across every displayed event for that boss
supplies "Best shown parses". Each summary value retains its supporting fight
URL.

## Normalized model and persistence

The Warcraft Logs gateway adds normalized performance evidence to each kill:

- the character's fight role when Warcraft Logs supplies one; and
- damage, healing, and boss-damage metric states.

Each metric is a discriminated state:

- `available`, with a finite percentile from 0 through 100;
- `not_applicable`, when an independently established fight role makes the
  metric inapplicable under SlashWho's documented policy; or
- `unavailable`, when no valid comparable parse can be established.

Zero is a valid available percentile only when Warcraft Logs explicitly
returns it. Missing, private, malformed, capped, archived, or otherwise
unavailable data is never normalized to zero.

The database stores these normalized states with the existing
`character_mythic_kills` evidence rows. It does not store raw ranking payloads,
credentials, tokens, or request URLs. Publication remains transactional: a
reader sees the previous completed evidence run or the whole replacement run,
never a mixture. Parse data inherits the existing per-character evidence
freshness and 30-day terminal-run retention policy.

The dossier contract represents performance per displayed character and
metric, including the selected percentile state and source fight URL for an
available value. Domain aggregation, not React components, computes event and
boss summaries.

## Request budget and failure behaviour

History discovery and ranking hydration have separate worker-owned request
budgets so a long history scan cannot silently consume every parse request.
Ranking queries are grouped by report code and include only retained fight IDs.
Batch sizes and default limits will be set from the credentialed cost
measurement rather than assumed to be free or constant.
The worker records the existing complete or partial history state plus a
parse-specific limitation when ranking hydration is capped, rate-limited,
unavailable, private, archived, or structurally invalid.

A parse failure does not erase a verified kill or make the kill itself
unverified. The kill remains visible, affected metrics remain unavailable, and
the dossier limitation explains that performance evidence is partial. A
failed refresh does not erase the last completed cached result. The existing
`Cache-Control: no-store` assembled response policy remains unchanged.

## Presentation

Each expanded kill-evidence event contains a Parses section grouped by
character. Available values use concise labels such as "Damage 87th
percentile", "Healing 62nd percentile", and "Boss damage 91st percentile".
Non-applicable and unavailable states are written explicitly without numeric
stand-ins.

Each boss card's collapsed summary adds two compact groups:

- **First kill parses** from the earliest displayed kill event; and
- **Best shown parses** across all kill events displayed for that boss.

Available values are links to the exact supporting Warcraft Logs fight.
Metric type and percentile remain visible text, so colour is never the only
signal. Percentiles retain sufficient precision that presentation rounding
cannot cross a colour boundary.

SlashWho will use the Warcraft Logs ranking palette exactly:

| Percentile               | Colour    |
| ------------------------ | --------- |
| 0-24                     | `#666666` |
| 25-49                    | `#1eff00` |
| 50-74                    | `#0070ff` |
| 75-94                    | `#a335ee` |
| 95-98                    | `#ff8000` |
| 99 through less than 100 | `#e268a8` |
| 100                      | `#e5cc80` |

Neutral unavailable states do not receive a performance colour. The palette
is centralized in a pure mapping helper and CSS custom properties so boundary
tests and presentation cannot diverge.

## Testing

Implementation follows red-green-refactor and covers:

- valid damage, healing, and boss-damage ranking normalization;
- exact report, fight, encounter, difficulty, region, realm, and character
  matching;
- duplicate eligible entries selecting the highest percentile;
- zero as a valid parse and missing data as non-zero-free unavailable state;
- role-based non-applicability;
- private, archived, malformed, capped, rate-limited, and unavailable ranking
  results while verified kills remain present;
- request grouping and independent history/ranking caps;
- database round trips, constraints, atomic replacement, expiry, and cleanup;
- event-level best selection, first-event summaries, and boss-level best-shown
  summaries with correct source URLs;
- strict dossier contract parsing;
- accessible UI labels and links;
- every Warcraft Logs colour boundary; and
- responsive browser coverage for the expanded and collapsed presentation.

## Source record

The authoritative API, ranking-semantics, availability, cost, and palette
findings are recorded in
`docs/research/2026-09-14-warcraft-logs-fight-parses.md`.
