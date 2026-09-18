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

Terminal is additionally gated on the kill having settled — see "A kill must
settle before it goes terminal". A kill in a concluded tier satisfies that by
age; a kill in the current tier becomes terminal once it does.

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

Without an escape hatch, indefinite storage freezes every bug permanently. Every
parse fix of the last week — spec icons, the numeric class id, drift handling
(#272), zone settling (#280) — reached existing dossiers only by re-collecting.
Under a naive "never re-query", `ryii` would sit at 125/175 forever, because the
data those fixes repair is exactly the data we would stop fetching.

There are two escape hatches, and they answer different needs.

### A full refresh, triggered deliberately

**Required.** An operator must be able to say "forget what you know about this
character and collect it again", ignoring every terminal mark. This is the
mechanism for applying a collection fix to history, and for recovering from a
wrong terminal mark discovered later.

Three properties matter:

**It is a flag, not an action.** A full refresh cannot complete in one run. One
character on this dossier spans 353 reports, and the points budget (#283) bounds
what any single run may spend. So a refresh marks the character's terminal
records as needing re-collection and lets the existing run, retry and budget
machinery drain that backlog across as many runs as it takes. A design that
tries to do the work synchronously will exhaust the allowance and abandon the
character part-way, which is precisely the failure of 2026-09-17.

**It extends the existing refresh, rather than adding a parallel path.**
`refreshMode` already returns `full | light`, the route and the dossier control
already exist, and `refreshCharacter` already forces a run by passing `at` as the
freshness cutoff. A third mode — `rebuild` — reuses all of it. Unlike the other
two, it is chosen by the caller rather than derived from a cooldown.

**It needs a gate, and does not have one today.** The refresh endpoint is
unauthenticated. A `full` press costs one run; a `rebuild` press costs an entire
character's history, so an unauthenticated rebuild is a way for anyone to burn
the whole Warcraft Logs allowance repeatedly. Authenticating or otherwise
restricting this endpoint is a prerequisite of shipping `rebuild`, not a
follow-up.

Scope is per character. A dossier-wide rebuild is every connected character's
history at once — worth having eventually, but it multiplies the cost by ten on
a dossier like this one, so it should follow the per-character version rather
than ship with it.

### Per-domain collection versions

**Proposed, not required. The part of this design most worth overriding.**

A full refresh is manual and total. It needs someone to remember, and it
re-collects kills, rankings and achievements to fix a parse bug. Per-domain
versions (kills, parses, tier bests, rankings, achievements) let a fix bump only
the domain it touches, so terminal records below that version re-collect once,
automatically, and are terminal again afterwards.

`CURRENT_EVIDENCE_VERSION` cannot serve this: it invalidates everything, which is
affordable when nothing is terminal and ruinous when the whole point is to stop
re-querying.

If only one of the two is built, build the full refresh. It is the mechanism that
is genuinely required; per-domain versions are an optimisation that trades a new
invariant — every future collection fix has to bump the right domain — for not
having to remember.

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
better served by that than by evidence silently vanishing. Confirmed as intended.

### A kill must settle before it goes terminal

Rankings are understood to settle a few days after a kill. A kill younger than
`EVIDENCE_KILL_SETTLE_DAYS` — **default 7, and explicitly unverified** — is never
terminal, whatever tier it belongs to.

This matters less for concluded tiers, whose kills are months old by definition,
and a great deal for the current tier: without it the whole current tier is
re-queried on every run forever; with it, only the last week of it is. That is
the expensive part of the workload, so this rule carries most of the saving.

**The 7 is a guess, like `EVIDENCE_POINTS_RESERVE`.** The settling period was not
confirmed against Warcraft Logs, and the risk of setting it too low is a
permanently frozen wrong percentile.

Two attempts to measure it retrospectively failed, and the reason is worth
recording so it is not retried: comparing the committed `/demo` snapshot against
the live dossier mixes three effects that cannot be separated — genuine upstream
drift, a precision change (stored percentiles were full floats, the API now
returns integers), and corrections from this week's parse fixes, since the
snapshot predates the shared-name attribution fix and therefore contains values
that were simply wrong.

So make it measurable going forward instead: **store the observation time
alongside each percentile.** Today a metric records its value with no record of
when it was seen — only the owning run's `completed_at`. One column turns drift
into a query against our own data, at no upstream cost, and is what should
replace the guessed 7.

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
- A kill younger than the settle threshold is re-queried even in a concluded
  tier; the same kill is terminal once older than it.
- A `rebuild` re-collects a character whose tiers are all terminal, and does so
  across several runs rather than one, leaving the remainder queued when the
  points budget refuses a run.
- A `rebuild` does not discard stored evidence before its replacement arrives.
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
