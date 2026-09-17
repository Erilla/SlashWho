# Warcraft Logs fight-parse contract for issue #90

Date: 2026-09-14

## Decision summary

Use `Report.rankings`, scoped to the already-verified report and exact fight IDs,
and request `dps`, `hps`, and `bossdps` as three GraphQL aliases. Use
`compare: Rankings` and `timeframe: Historical`, matching the product decision
for SlashWho: a score from that exact kill, compared with each player's best
score around the time the kill occurred. Never substitute a character-level
best from some other report or fight.

The important qualification is that `Report.rankings` returns the opaque
GraphQL scalar `JSON`. Warcraft Logs publishes the arguments and enum values,
but not a typed result contract. The implementation therefore has to validate
the runtime payload defensively, and a credentialed contract spike is required
before any concrete response keys can be called authoritative.

Primary sources used here are the [Warcraft Logs v2 schema][wcl-schema], the
[Warcraft Logs rankings guide][wcl-ranks], and first-party RPGLogs/Archon
documentation. RPGLogs operates Warcraft Logs; the [RPGLogs branding
page][rpglogs-branding] groups Warcraft Logs and Archon among its associated
sites.

## Authoritative query surface

The schema defines this exact field:

```graphql
rankings(
  compare: RankingCompareType
  difficulty: Int
  encounterID: Int
  fightIDs: [Int]
  playerMetric: ReportRankingMetricType
  timeframe: RankingTimeframeType
): JSON
```

All arguments are optional in GraphQL, but SlashWho should supply every scoping
argument relevant to attribution. The report itself is selected by unique
`code`; `fightIDs` excludes all other fights, `encounterID` excludes other
bosses, and `difficulty` excludes other difficulties. The schema explicitly
says omitted fight, encounter, and difficulty filters include broader data.
See [`Report.rankings`][report].

The three metric enum values required by issue #90 are:

- `dps`: damage per second;
- `hps`: healing per second;
- `bossdps`: boss damage per second.

They are members of [`ReportRankingMetricType`][report-metric]. That enum also
contains `default`, `krsi`, `playerscore`, `playerspeed`, `tankhps`, `wdps`, and
FFXIV-specific adjusted-DPS variants. Those are not substitutes for the three
requested Warcraft metrics.

The exact comparison enums are:

- [`RankingCompareType`][compare]: `Rankings` or `Parses`;
- [`RankingTimeframeType`][timeframe]: `Today` or `Historical`.

A suitable batched query for one report is:

```graphql
query ReportFightParses(
  $code: String!
  $fightIDs: [Int!]
  $encounterID: Int!
  $difficulty: Int!
) {
  reportData {
    report(code: $code) {
      code
      archiveStatus {
        isArchived
        isAccessible
        archiveDate
      }
      damage: rankings(
        compare: Rankings
        difficulty: $difficulty
        encounterID: $encounterID
        fightIDs: $fightIDs
        playerMetric: dps
        timeframe: Historical
      )
      healing: rankings(
        compare: Rankings
        difficulty: $difficulty
        encounterID: $encounterID
        fightIDs: $fightIDs
        playerMetric: hps
        timeframe: Historical
      )
      bossDamage: rankings(
        compare: Rankings
        difficulty: $difficulty
        encounterID: $encounterID
        fightIDs: $fightIDs
        playerMetric: bossdps
        timeframe: Historical
      )
    }
  }
  rateLimitData {
    limitPerHour
    pointsSpentThisHour
    pointsResetIn
  }
}
```

`[Int!]` is valid as the variable type passed to the schema's `[Int]` argument:
it is stricter about null members. Do not hard-code a global "Mythic" integer
from this note. Difficulty IDs are game- and sometimes zone-specific; resolve
the desired value from [`Zone.difficulties`][zone] and verify the retained
fight has the same difficulty.

One request can include multiple retained fight IDs from the same report,
encounter, and difficulty. Different reports must remain separate because the
report code is the outer identity. If an evidence row combines references from
multiple reports, query each report and select the highest valid percentile for
each displayed metric **only within those supporting references**, retaining
the winning report code and fight ID for the link.

## What the percentile means

Warcraft Logs distinguishes a _parse_ (any scored performance) from a
_ranking_ (that player's best parse). `compare: Rankings` compares the selected
fight's score against players' best scores across the tier; `compare: Parses`
compares it against all parses in a typical two-week window. The selected fight
is still a parse in either case—the `compare` value chooses the comparison
population. See [Ranking terminology and the Rule of Eight][wcl-ranks].

`timeframe: Historical` evaluates the score against values around when the
fight occurred. `Today` evaluates it against current values as the tier ages.
The guide says character and guild pages default to `(ranking, historical, all
brackets)`, while report damage/healing panes default to `(parses, today, both
all and bracket)`, and report ranking panes default to `(rankings, today, all
and bracket)`. SlashWho's chosen `Rankings` + `Historical` therefore matches
the character-page comparison concept, not either report-pane default. The UI
should not imply it is reproducing the number currently shown in Warcraft
Logs' Damage Done pane.

Historical percentiles are not immediately final. Warcraft Logs processes
history in 24-hour windows with a noon UTC cutoff; until the next window is
collected, a new parse is compared with the previous day's cached percentile
values. The guide explains that historical percentiles are derived by
interpolation between cached percentile thresholds and can change at lock-in.

A percentile describes position within the selected comparison population. A
95th-percentile DPS/HPS parse is higher than 95% of that population, as stated
by the first-party [Archon methodology FAQ][archon-percentile]. It is not the
raw DPS/HPS amount and not the absolute rank position.

## Role applicability and missing data

`Report.rankings` has no `role` argument. The API accepts each requested metric
for the report/fight and decides which ranking rows exist. Although the
character ranking endpoints expose a `role` filter (`Any`, `DPS`, `Healer`, or
`Tank`), that filter is not part of the report-ranking contract. The schema
defines `hps` only as healing per second and does not state a normative rule
such as "healers always have HPS and non-healers never do". Warcraft Logs also
supports damage rankings for tanks, and its rankings UI exposes role filters;
role and metric are not synonyms.

Consequences for SlashWho:

1. Treat a valid returned row as authoritative for that character/metric/fight,
   regardless of assumptions based on class or specialization.
2. Do not infer a numeric zero when no row is returned. Missing can mean not
   applicable, not ranked/processed, private or hidden data, a blacklisted
   rank, archive access, or response/schema failure; the published JSON
   contract does not discriminate these cases.
3. `not applicable` may be an explicit SlashWho presentation policy based on
   an independently established fight role, but it is not a status emitted by
   the typed WCL schema. Otherwise use `unavailable`.
4. Validate character identity as well as the report/fight filters. A name
   alone is insufficient if the runtime JSON offers stronger identifiers such
   as actor/character IDs, server, or region. Which keys are actually present
   must be established by the credentialed contract spike below.

## JSON response-shape limitation

The schema declares rankings as the scalar [`JSON`][json], not a GraphQL object
or union. Consequently the published schema guarantees none of the nested
field names, nullability, identity fields, percentile field, array layout, or
error/status variants inside that payload. GraphQL introspection cannot reveal
them, and the first-party [`RPGLogsApiSdk`][sdk] does not expose a typed
`Report.rankings` operation in its documented method list.

Without authenticated sample calls, this note cannot authoritatively assert:

- whether the percentile key is named `rankPercent`, `percentile`, or something
  else;
- whether results are grouped by fight, role, spec, or metric;
- whether fight identity is repeated on each row;
- how missing, invalid, unranked, private, or blacklisted parses differ;
- whether duplicate rows can occur for one actor/fight/metric;
- whether archived-but-inaccessible reports still return rankings.

Before merging a concrete decoder, run the query against controlled public
reports that cover a DPS, healer, and tank; multiple fight IDs; a zero/low
percentile; and, if available, an archived report. Capture sanitized fixtures,
then reject rather than coerce any payload outside the observed contract.
Accept percentiles only when numeric, finite, and within `0..100`; a genuine
numeric `0` remains distinct from missing. Preserve report code, fight ID,
encounter, difficulty, character identity, metric, percentile, and the report
revision/cache timestamp alongside every accepted value.

## Historical, frozen, and archived data

Historical ranking comparison is a documented feature of `Report.rankings`;
it is not the same as raw-event archive access. The schema says a frozen zone
will never change and may be cached forever, and the rankings guide says prior
partitions become frozen when a new partition is created. See [`Zone`][zone]
and [Partitions][wcl-ranks].

Separately, [`Report.archiveStatus`][archive-status] supplies `isArchived`,
`isAccessible`, and `archiveDate`. The Report documentation explicitly says
events, tables, and graphs for archived reports are inaccessible unless the
retrieving user has a subscription with archive access. It does **not** list
rankings in that sentence. That omission is not a guarantee that rankings are
available: because rankings are opaque JSON, archived ranking availability
must be measured with authenticated calls and represented as unavailable on
failure. `isAccessible` is always false for archived reports when not using
user authentication, according to the archive-status schema.

## Rate limit and request cost

Warcraft Logs uses an hourly point budget. [`RateLimitData`][rate-limit]
publishes only:

- `limitPerHour`;
- `pointsSpentThisHour`;
- `pointsResetIn`.

No first-party document found publishes a fixed point cost for
`Report.rankings`, a cost formula, or a maximum number of `fightIDs`. Therefore
an exact cost cannot be claimed without credentials. Measure it by sampling
`pointsSpentThisHour` immediately before/with/after controlled queries, testing
one metric versus the three aliases and increasing fight counts. The result is
operational evidence, not a permanent contract: retain rate-limit handling and
bound batches. Fetch ranking hydration after kill evidence has been filtered,
so points are not spent on fights the UI will discard.

The public endpoint uses OAuth client credentials, while private reports
require the user endpoint and authorization-code access. See [Warcraft Logs API
authentication][api-docs]. SlashWho must not turn an authentication, rate-limit,
or partial GraphQL error into `0` or into a supposedly complete evidence row.

## Percentile colour contract

The first-party [RPGLogs rankings guide][rpglogs-ranks] gives both thresholds
and exact colors, and the [RPGLogs branding page][rpglogs-branding] independently
lists the same seven hex codes:

| Percentile shown | Continuous implementation interval | Hex       |
| ---------------- | ---------------------------------- | --------- |
| 0–24             | `0 <= p < 25`                      | `#666666` |
| 25–49            | `25 <= p < 50`                     | `#1eff00` |
| 50–74            | `50 <= p < 75`                     | `#0070ff` |
| 75–94            | `75 <= p < 95`                     | `#a335ee` |
| 95–98            | `95 <= p < 99`                     | `#ff8000` |
| 99               | `99 <= p < 100`                    | `#e268a8` |
| 100              | `p == 100`                         | `#e5cc80` |

The continuous intervals are the unrounded implementation of the guide's
integer labels and its wording “99+”; they prevent rounding a value across a
colour boundary. Do not clamp invalid values into a band. Colour is supporting
meaning only: render an accessible metric label and percentile text as required
by issue #90.

## Implementation contract distilled

- Hydrate only retained, verified Mythic kill references.
- Query by exact report code and exact retained fight IDs, additionally passing
  the retained encounter and resolved Mythic difficulty.
- Request the three metrics by aliases with `Rankings` + `Historical`.
- Parse the JSON with a strict, fixture-backed decoder and preserve an explicit
  unavailable state for every ambiguity or upstream limitation.
- Attach each accepted parse to its exact report/fight/character/metric source.
- For a multi-report evidence row, choose the highest valid value among that
  row's sources only and keep the winning source link.
- At boss-card level, compute “first kill parses” from the earliest displayed
  kill event and “best shown parses” only from displayed evidence; never pull a
  character-wide best from unrelated history.
- Apply the seven RPGLogs colours to the original numeric percentile, while
  retaining textual labels.

## Explicit blockers and uncertainties

1. No WCL client credentials were used for this research, so the opaque JSON
   response keys and exact cost remain unverified.
2. The official schema does not define role applicability or machine-readable
   missing-reason states for report rankings.
3. The official archive documentation is explicit only about events, tables,
   and graphs. It does not guarantee report-ranking availability for archived
   reports.
4. The schema does not state ordering, uniqueness, or completeness guarantees
   for rows inside the JSON scalar.
5. Historical percentiles can change until their daily lock-in; cache/UI text
   should not claim they were immutable at upload time.

## Credentialed probe evidence (2026-09-14)

A read-only probe ran with the Railway `test` worker credentials against a
public fight selected from the deployed test dossier API. The checked-in
fixtures are a deterministic sanitization of the observed structural contract;
they contain no source report code, player name, realm, region, or provider
character ID.

The scoped `dps`, `hps`, and `bossdps` aliases each returned the same shape:
`{ data: [{ fightID, encounter: { id, name }, difficulty, roles }] }`.
`roles` has `tanks`, `healers`, and `dps`; each has `characters`, whose rows
include `id`, `name`, `server: { id, name, region }`, `class`, `spec`, and a
numeric `rankPercent`. The sample had one row per alias, exact fight ID 26,
encounter ID 3306, difficulty 5, and 2/4/14 tank/healer/DPS rows. The query
envelope supplies the report code, aliases, `compare: Rankings`,
`timeframe: Historical`, exact fight, encounter, and difficulty dimensions;
the rows do not repeat every one of those dimensions.

`rankPercent` was numeric (sample values included 20, 23, 42, 50, and 52).
The public report was not archived (`isArchived: false`) and was accessible.
An empty but successful `{ data: [] }` response was also observed for a
separately scoped public selection, so absence is an unavailable upstream
state rather than a numeric zero or a conclusion about applicability. The
three-alias request measured an eight-point increase in
`pointsSpentThisHour` (20 to 28); treat that only as a measured test
environment sample, not a fixed provider cost.

### Character-identity proof

Ranking-row `characters[].id` is a stable global Character ID, but it is not
equal to either `ReportActor.id` or `ReportActor.gameID`. A direct ID join to
`masterData.actors` therefore must be rejected. The schema exposes
`characterData.character(id: Int)`, which supplies an authoritative canonical
Character object. The probe proved, without retaining any source identity,
that the ranking ID equals that Character object's ID; its canonical
name/server/region equals the requested dossier character; and exactly one
Player in the report's `masterData.actors` has the same canonical name/server.
This is the required two-step identity proof, not name-only ranking matching:

`ranking character ID -> Character(id) canonical identity -> unique report actor`.

The report actor has no global Character ID field that equals the ranking ID,
so later normalization must retain this qualified cross-walk and reject a
missing or non-unique canonical actor match. It must never fall back to a
ranking-row name alone.

The executable probe now performs that validation for every distinct ranking
character ID (bounded at 50): it aliases `characterData.character(id: ...)`
lookups, verifies the global ID plus canonical name/server/region against the
ranking row, then requires exactly one matching Player actor. Realm comparison
normalizes display separators (for example, a display space versus the
canonical slug hyphen) but does not weaken the ID, name, region, or uniqueness
checks. A successful post-validation run measured a nine-point delta; this
includes the bounded canonical lookups and remains an operational sample only.

### Unobserved failure states and decoder policy

No credentialed private-report, archived-and-inaccessible-report, or malformed
ranking JSON response was safely available in the test dossier selection.
Those provider-specific shapes are therefore unobserved rather than inferred.
The decoder policy is strict: malformed ranking JSON or an invalid/missing/
mismatched/non-unique Character-to-actor bridge is rejected as schema drift;
private, inaccessible, archived, or otherwise unavailable ranking responses
produce an unavailable metric state. None of those states may become zero or
`not_applicable` without independent role evidence.

## Shipped operational semantics

The release performs `Report.rankings` with `compare: Rankings` and
`timeframe: Historical` only after retaining public Mythic kill references. A
ranking is accepted only when its query scope and canonical identity prove the
same report, fight, encounter, difficulty, region, realm, and character as the
evidence row. The canonical proof remains `ranking character ID ->
Character(id) canonical identity -> unique report actor`; a raw ranking name
is never attribution evidence. Each available percentile retains its exact
public fight URL.

The worker has independent positive request limits: `EVIDENCE_REQUEST_CAP`
defaults to 500 report-list pages, while `EVIDENCE_PARSE_REQUEST_CAP` defaults
to 8 parse-hydration requests (ranking batches and the bounded canonical
lookups they require). This protects the hourly provider budget. The observed
8-point three-alias query and 9-point post-validation probe are live test
measurements, not a fixed cost, provider commitment, or safe extrapolation.

Only normalized kill and parse-state evidence is retained. It follows the
existing `FRESHNESS_HOURS` window (24 hours by default); terminal evidence
runs and their cascading kill rows are removed after 30 days. The assembled
dossier remains a current, uncached view with `Cache-Control: no-store`.
Unavailable parse data, a cap, or a partial upstream result never weakens an
otherwise verified kill. A supplied numeric `0` remains an available result;
`unavailable` and `not_applicable` remain distinct nonnumeric states.

On the reviewer surface, **First kill parses** summarize the earliest displayed
event, and **Best shown parses** select only among the displayed events for the
boss. Neither is an all-history best.

> Superseded for the best row as of 2026-09-17. See
> `docs/research/2026-09-17-warcraft-logs-zone-rankings.md`: the best row is now
> read from `zoneRankings` and _is_ the character's best for that tier. The
> first-kill row is unchanged and still comes only from that fight's report
> rankings.

The exact percentile bands are grey
`#666666` (0–<25), green `#1eff00` (25–<50), blue `#0070ff` (50–<75), purple
`#a335ee` (75–<95), orange `#ff8000` (95–<99), pink `#e268a8` (99–<100), and
gold `#e5cc80` (100); colour supplements the metric's text label and link.

[api-docs]: https://www.warcraftlogs.com/api/docs
[archive-status]: https://www.warcraftlogs.com/v2-api-docs/warcraft/reportarchivestatus.doc.html
[archon-percentile]: https://www.archon.gg/wow/articles/help/archon-disclaimers-and-faq
[compare]: https://www.warcraftlogs.com/v2-api-docs/warcraft/rankingcomparetype.doc.html
[json]: https://www.warcraftlogs.com/v2-api-docs/warcraft/json.doc.html
[rate-limit]: https://www.warcraftlogs.com/v2-api-docs/warcraft/ratelimitdata.doc.html
[report]: https://www.warcraftlogs.com/v2-api-docs/warcraft/report.doc.html
[report-metric]: https://www.warcraftlogs.com/v2-api-docs/warcraft/reportrankingmetrictype.doc.html
[rpglogs-branding]: https://www.archon.gg/fellowship/articles/help/rpg-logs-branding-information
[rpglogs-ranks]: https://www.archon.gg/fellowship/articles/help/rankings-and-parses
[sdk]: https://github.com/RPGLogs/RPGLogsApiSdk
[timeframe]: https://www.warcraftlogs.com/v2-api-docs/warcraft/rankingtimeframetype.doc.html
[wcl-ranks]: https://www.warcraftlogs.com/help/ranks/
[wcl-schema]: https://www.warcraftlogs.com/v2-api-docs/warcraft/
[zone]: https://www.warcraftlogs.com/v2-api-docs/warcraft/zone.doc.html
