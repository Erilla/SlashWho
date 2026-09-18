# Concluded tier retention

Status: design. Not implemented. Raised for implementation in a separate
session.

## Principle

A concluded raid tier cannot change. Evidence collected for one should be stored
once and never re-queried. Only the current tier keeps moving, so only the
current tier should keep costing upstream requests.

Today every run re-derives everything within its budget, regardless of whether
the tier it is reading closed three years ago. On `eu/silvermoon/ryii` one
character spans 353 reports, nearly all of them in tiers that ended years ago,
and the parse budget is spent re-reading them instead of on the tier a recruiter
actually cares about.

## What is queried today

**Warcraft Logs**

| Query                                              | Purpose                 |
| -------------------------------------------------- | ----------------------- |
| `ResolveCharacter`                                 | identity and class      |
| `RecentReports`                                    | the report list         |
| `ReportFightParses`                                | per-report fight parses |
| `RankingCharacterIdentities`                       | identity attribution    |
| `zoneRankings` (damage/healing/bossDamage aliases) | tier bests              |
| `RateLimit`                                        | points budget (#283)    |

**Raider.IO**

| Endpoint                                              | Purpose                                     |
| ----------------------------------------------------- | ------------------------------------------- |
| `/api/characters/{region}/{realm}/{name}`             | profile                                     |
| `/api/characters/.../raid-progress?tier=N`            | historic mythic kills, one request per tier |
| `/api/user/view-characters`                           | claimed characters, profile guess           |
| `/api/guilds/raid-rankings`, `/api/v1/guilds/profile` | guild rank for a raid                       |
| `/api/v1/raiding/boss-rankings`                       | world boss rankings                         |

**Blizzard**

| Endpoint                                 | Purpose                             |
| ---------------------------------------- | ----------------------------------- |
| `/profile/wow/character/{realm}/{name}`  | profile                             |
| `.../achievements`                       | completed achievements, fingerprint |
| `/data/wow/guild/{realm}/{guild}/roster` | guild roster                        |
| `/data/wow/playable-class/index`         | static class index                  |

## Retention rules

**Terminal** means stored once and never re-queried in normal operation.

| Data                                          | Rule                                                        | Why                                                 |
| --------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| Raider.IO `raid-progress`, concluded tier     | terminal                                                    | already per-tier; the strongest fit in the codebase |
| Raider.IO world boss rankings, concluded tier | terminal                                                    | see "relative values" below                         |
| Blizzard achievements                         | append-only; store permanently, re-query only for additions | a completed achievement never un-completes          |
| Blizzard class index                          | terminal per game patch                                     | static data                                         |
| WCL kills and wipes, concluded tier           | terminal                                                    | the fight happened or it did not                    |
| WCL first-kill parse, concluded tier          | terminal once `available`                                   | see "relative values"                               |
| WCL tier bests, concluded tier                | terminal once `available`                                   |                                                     |
| WCL tier bests, current tier                  | re-query                                                    | a new kill reopens the zone (#280)                  |
| Profile, guild roster, claimed characters     | always re-query                                             | names, realms, guilds and rosters change            |

## What "concluded" means

`packages/domain/src/raid-current-content-windows.generated.json` already holds
`startsAt`/`endsAt` per raid slug, generated from Raider.IO static data. A tier
is concluded when `endsAt` is in the past.

**A raid with no window entry must never be treated as terminal.** The
`current_content_window_unknown` limitation is live on five characters of
`eu/silvermoon/ryii` today, so this is not hypothetical: an unknown window
currently means we cannot place that raid in time. Marking those terminal would
freeze evidence we cannot even date. Unknown falls back to the existing re-query
behaviour, and the limitation stays visible.

## The correction path

**Decision, made in the absence of a stated preference, and the part of this
design most worth overriding:** terminal records carry a **per-domain collection
version**, not the single global `CURRENT_EVIDENCE_VERSION`.

Without an escape hatch, indefinite storage freezes every bug permanently. Every
parse fix of the last week — spec icons, the numeric class id, drift handling
(#272), zone settling (#280) — reached existing dossiers only by re-collecting.
Under a naive "never re-query", `ryii` would sit at 125/175 forever, because the
data those fixes repair is exactly the data we would stop fetching.

`CURRENT_EVIDENCE_VERSION` is too blunt for this. It invalidates everything, so a
fix to parse decoding would re-collect kills, wipes, rankings and achievements
too. That is affordable when nothing is terminal and ruinous when the whole point
is to stop re-querying.

So: separate versions per domain (kills, parses, tier bests, rankings,
achievements). A fix bumps only the domain it touches. A run re-collects terminal
records below that domain's version once, and they are terminal again afterwards.

## Relative values

Two of the rules above store a number that is not strictly immutable. Treating
them as terminal is a policy choice, not a fact about the data, and should be
recorded as one.

A parse is a **percentile against a ranking pool**, and a world rank is a
position within one. The kill is immutable; its percentile moves whenever anyone
else's log enters or leaves that pool. For a long-concluded tier the drift is
small but not zero.

We accept the first observed value as final. A recruiter reading a dossier wants
what the applicant achieved, not a figure that quietly re-rates itself for years.
The alternative — re-querying concluded tiers to chase fractional percentile
movement — is exactly the cost this design exists to remove.

Similarly, a Warcraft Logs report can be deleted or made private. Stored evidence
is kept: we recorded what was public when we saw it, and an applicant dossier is
better served by that than by evidence silently vanishing.

## New connected characters

A character discovered later is collected across its history once, as now.
Terminal applies per character per tier, so a new connection pays the full
historic cost a single time and never again.

## What this fixes

The budget problems become largely self-limiting. Once a character's concluded
tiers are stored, its runs only ever ask about the current tier, so the parse
budget stops being consumed by history. That reframes several open issues:

- **#262** (hydration cannot finish or resume) — the backlog stops growing.
- **#274** (a report that cannot be hydrated re-spends budget every run) — still
  real, but bounded to the current tier once history is terminal.
- **#282 / #283** (the points budget) — complementary. The budget stops the
  waste; this removes the work.

## Risks

- **A wrong terminal mark is durable.** A record stored from a buggy decode is
  frozen until someone notices and bumps that domain's version. This raises the
  cost of a silent decoding bug, which is exactly the shape of
  `parse_schema_drift` (#271, #273), still unexplained at the time of writing.
  Storing raw payloads for failed decodes so they can be re-read offline would
  reduce that risk and is worth considering alongside this.
- **Tier windows come from generated data.** If a window is wrong, evidence is
  marked terminal against the wrong boundary. The unknown-window fallback covers
  a missing entry, not an incorrect one.
- **Per-domain versions are a new invariant** that whoever writes the next
  collection fix has to maintain. If the habit does not stick, this degrades to
  the current blunt bump.

## Testing

- A concluded tier is not re-queried on a second run; a current tier is.
- A raid with no window entry is re-queried and still reports
  `current_content_window_unknown`.
- A domain version bump re-collects only that domain's terminal records.
- A tier that concludes between two runs becomes terminal at the boundary.
- A newly connected character collects its full history once, then goes terminal.

Each test confirmed red before implementation, per the repo's TDD practice.

## Out of scope

- Storing raw upstream payloads for failed decodes. Related, and arguably a
  prerequisite for the risk above, but a separate change.
- #271 / #273, the unexplained drift itself.
- Backfilling or re-verifying evidence already stored before this lands.
