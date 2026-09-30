# What SlashWho can assemble from the data it already holds

Issue #759. Investigated 2026-09-30 against `origin/main` at `25a2d681`. The
database figures come from read-only queries against Railway `test` the same
day, with 222 characters and 1,965 evidence runs. The queries are in
[Reproducing the figures](#reproducing-the-figures).

## Question

SlashWho stores and fetches a good deal about every character it researches,
and the applicant dossier shows only part of it. What else could we assemble
without a new upstream integration, and ideally without a new upstream
request?

## Answer

A lot, and most of it needs no new request at all.

**The stored evidence is richer than the dossier:**

- **Volume on `test`.** The current runs alone hold 34,905 Mythic kills and
  108,210 wipes for 121 characters. They span 41 raids and 2017-02-12 to
  2026-09-28.
- **Detail on the kills.** 27,722 kills carry parses and 27,649 a spec.
- **Rosters.** Raider.IO rosters are stored for 2,716 logged kills.
- **The dossier's view of it.** Almost all of this reaches the dossier only as
  per-boss kill events.

Summaries across tiers, guilds and characters can be built from those rows
alone.

**Five candidates are measured and worth building first.** None needs a new
request. On `test`:

1. **Raid schedule per guild tenure.**
   - 93 guild tenures of 10 or more nights were measured, across 62
     characters.
   - The median tenure puts all of its nights on three weekdays. At the 25th
     percentile the figure is still 96%.
   - The start hour has an interquartile range of one hour.
2. **Main per tier.** In 29 of the 45 dossier roots with kills, the character
   that did most of the killing changes from one tier to another.
3. **Progression effort per boss.**
   - 989 of 3,019 first kills have stored wipes before them. For those, the
     median is 35 wipes and the 90th percentile about 196.
   - 288 bosses were wiped on and never killed.
   - These counts are lower bounds; see candidate 3 below.
4. **Farm engagement and recency.** A killed boss has a median of 7 kills, and
   59% of them were killed five or more times. The last kill date per tier is
   stored.
5. **Spec history.** 28% of character-tiers show more than one spec, and 55 of
   118 characters played a different set of specs from one tier to another.

**One open question can already be answered from stored data.**
`EVIDENCE_KILL_SETTLE_DAYS` is seven days, and the code calls that value "a
guess and explicitly unverified" (`apps/worker/src/config.ts:490-495`). The
per-run evidence copies hold 378,377 distinct parse readings over 35,177
fights. Across readings taken a day or more apart:

- **Young kills.** 0 of 446 re-reads of kills under 7 days old moved by a
  point or more.
- **Kills 7 to 28 days old.** 5 of 1,666 moved.
- **Older kills.** 161 of 33,476 moved. The median move was 16.5 points, which
  looks like a correction rather than drift.

The sample of young kills is small, but it points towards a shorter settle
window. It deserves its own issue (see [Recommendations](#recommendations)).

**Three things turned up on the way:**

- **A breach of the storage rules.** Discovery job payloads persist a
  Raider.IO owner name (possibly a BattleTag) and a Discord handle in
  `pgboss.job`.
- **Evidence tables grow fast.** Every publish copies the whole evidence
  history under the new run: 16 times the current rows for kills and 20 times
  for wipes.
- **Parses are re-read about eleven times per fight.**

Details are in [Found on the way](#found-on-the-way).

## Cost classes

Each candidate falls into one of three classes:

| Class       | Meaning                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Stored**  | Built from rows already in PostgreSQL, or from a generated catalogue in code. No upstream request.                                |
| **Decoder** | The field already arrives in a response we pay for. It needs a parser and storage change, but no new request and no extra points. |
| **Request** | Needs a new request, or a new query part, to a provider we already use.                                                           |

## What we hold

### Stored

These are the evidence tables, with their size on `test`:

| Table                                                             | Rows (all runs) | Rows (current runs) | What it records                                                                             |
| ----------------------------------------------------------------- | --------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `character_mythic_kills` (`packages/database/src/schema.ts:1399`) | 562,914         | 34,905              | One Mythic kill fight: raid, boss, time, guild, uploader, spec, three parses, historic rank |
| `character_mythic_wipes` (`schema.ts:1551`)                       | 2,223,864       | 108,210             | One Mythic wipe fight: raid, boss, time, guild (no region), uploader                        |
| `character_tier_best_parses` (`schema.ts:1495`)                   | 8,745           | —                   | Best percentile per boss across a whole zone                                                |
| `character_raiderio_first_kills` (`schema.ts:1666`)               | 7,431           | —                   | Raider.IO first kill per boss, guild, logged encounter id                                   |
| `raiderio_logged_encounters` (`schema.ts:1583`)                   | 2,716           | shared              | Pull and kill time, duration, item level (average, min, max), deaths, Vantus                |
| `raiderio_logged_encounter_members` (`schema.ts:1633`)            | 46,429          | shared              | Every raider on a logged kill: name, realm, class, spec, role, item level                   |
| `character_evidence_cutting_edges` (`schema.ts:1166`)             | 6,489           | —                   | Cutting Edge achievement ids and dates per character                                        |

Row counts are `pg_stat_user_tables` estimates for all runs, and exact counts
for current runs.

**Identity and relationship tables:**

- `characters`, 222 rows.
- `snapshot_characters`, 603 rows over 77 snapshots.
- `character_connections`, 338 rows, and `character_groups`, 34 rows. These
  are the #738 link graph, which has no application reader yet
  (`packages/database/src/repositories.ts:1975-2001`).
- `warcraft_logs_character_ids`.
- `character_historic_aliases`.

**Operational tables:**

- `character_evidence_run_costs`, 2,139 rows. A rolling 28 days of cost per
  attempt, readable only through SQL (`docs/operations/evidence-run-cost.md`).
- `character_evidence_run_phases`, 7,679 rows. Per-step start and end times.

**History depth.** Snapshots, discovery runs and evidence runs are never
deleted, and every publish writes the character's whole merged history under
the new run id (`packages/database/src/evidence/repository.ts:927-972`). So a
per-run history of every kill, wipe, parse and Cutting Edge exists. The dossier
reads only the newest run (`packages/database/src/evidence/load.ts:40-97`).

The genuine observations are the distinct `(fight, collected_at)` pairs.
Carry-forward keeps a skipped fight's `collected_at` (`schema.ts:1437-1447`).

**Not stored at all:**

- guild rosters;
- achievement fingerprints (`CONTEXT.md`, "Ephemeral fingerprint");
- any guild entity;
- raid, encounter and Cutting Edge catalogues, which are generated JSON in
  `packages/domain/src`.

### Fetched and dropped

These are the largest drops. Every one arrives on a request made today.

| Response                                                                                         | Dropped on arrival                                                                                                                             | Evidence                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Raider.IO `raid-progress`, up to 17 tiers a full run (`packages/raiderio/src/client.ts:578-666`) | Heroic and Normal kills; `aotc`, `cuttingEdge` and raid weeks; per boss `numKills`, `lastDefeated` and `itemLevel`                             | `tests/fixtures/recorded/raiderio/raid-progress-logged-first-kill.json:46-73`                                   |
| Raider.IO logged encounter (`client.ts:761-792`)                                                 | Each raider's talents, gear, race and gender; the Blizzard encounter and instance ids; boss order; the flags for restricted pulls and percents | `tests/fixtures/recorded/raiderio/logged-encounter-guild-kill.json:88-135`                                      |
| Raider.IO character, about 82 KB, fetched at up to seven points per flow (`client.ts:504-524`)   | Everything except identity, guild, declared main and owner. The recorder strips gear and scores, so the exact keys are unverified              | `tests/fixtures/recorded/README.md:76-79`; `docs/research/2026-09-27-issue-656-raiderio-guild-reads.md:132-135` |
| Blizzard achievements, about 1.9 MB (`packages/blizzard/src/client.ts:49`)                       | Every achievement other than Cutting Edge, and all criteria                                                                                    | `docs/research/2026-09-12-blizzard-cutting-edge-achievements.md:23-26`                                          |
| Warcraft Logs `Report.rankings` blob (`packages/warcraftlogs/src/queries.ts:262-294`)            | `amount`, `duration`, `size`, `bracketPercent`, `totalParses`, `rank`, `best`, the role bucket the character ranked in, and `partition`        | `tests/fixtures/warcraftlogs/report-rankings-valid.json:40-122`                                                 |
| Warcraft Logs `zoneRankings` blob (`queries.ts:296-326`)                                         | `medianPercent`, `totalKills`, `bestAmount`, `bestRank`, `allStars`                                                                            | `docs/research/2026-09-17-warcraft-logs-zone-rankings.md:71-74`                                                 |
| Warcraft Logs `fights` on every history page (`queries.ts:97-126`)                               | Pull start (so kill duration); the raid roster in `friendlyPlayers`; **wipes on a boss the same report killed**                                | `packages/warcraftlogs/src/decode/reports.ts:250-256`, `:322-325`                                               |

**How the dropped fields were evidenced.** Recordings keep only allow-listed
fields (`tests/fixtures/recorded/README.md:76-81`). Only three Raider.IO
recordings carry an `ignored` baseline that lists what the parser dropped. No
Blizzard or Warcraft Logs response has ever been recorded live. Anything in the
table not backed by one of those sources, a query document or a research note
is marked unverified.

**How reading more would be priced:**

- **Warcraft Logs** charges points per report part loaded, not per field
  (`docs/operations/evidence-run-cost.md:244-258`). A field on a part already
  loaded is therefore free.
- **Ranking blobs** (`rankings`, `zoneRankings` and `encounterRankings`) are
  untyped JSON that arrives whole. Reading more of them changes only the
  decoder.

### Shown today

The dossier shows:

- **Characters.** Each connected character, with its source label, guild and
  class colour.
- **Cutting Edge.** The earliest date per achievement across the whole
  account.
- **Guild history.** A timeline of Warcraft Logs raid nights per guild, which
  drops guilds with a single night.
- **Per-boss kill events.** Each with:
  - first-kill parses and best parses;
  - world rank;
  - reports;
  - the Raider.IO roster.
- **Wipes, grouped per night.**
- **Limitations.**

The build is `buildApplicantDossier` in
`packages/domain/src/applicant-dossier.ts:719-1160`, assembled by
`packages/application/src/applicant-dossier-service.ts:848-1086`.

**Already assembled but hidden.** Some data is in the JSON or in application
objects and never rendered:

- the class name as text;
- a roster member's spec;
- `bossOrder`;
- which character earned each Cutting Edge. The domain folds these to the
  earliest date (`applicant-dossier.ts:727-745`);
- the difference between `unavailable` and `not_applicable`. Both render
  "-" (`apps/web/src/components/dossier-parse-list.tsx:40-53`). That respects
  the rule against showing either as zero, but a reader cannot tell them
  apart;
- the uploader on a kill that has only one report;
- the full time of a kill. Only the date is shown.

## Constraints on any new view

These decisions are already made. A candidate that crosses one says so below.

- **No stored dossier.** A dossier is never stored, so it is always a view of
  the moment (`CONTEXT.md`, "Applicant dossier";
  `docs/dossier-cache-policy.md:3-8`).
- **No directory or archive.** The service is not a public API, a searchable
  directory or a historical character archive (`README.md`, Operations).
  Snapshot history stays internal
  (`docs/superpowers/specs/2026-09-11-applicant-dossier-design.md:165-167`).
- **Raider.IO's kill list is not evidence.** It is never evidence on its own,
  and "Later kills, Heroic and Normal are never read"
  (`docs/dossier-evidence-semantics.md:29-31`).
- **Raid-section windows.** Kills outside a raid's current-content window are
  never displayed in the raid section (`docs/dossier-cache-policy.md:280-285`).
  They do feed guild history (`applicant-dossier-service.ts:1035-1037`).
- **Evidence states stay distinct.** An available `0`, `unavailable` and
  `not_applicable` are never collapsed. An aggregate over percentiles must say
  how many values it covers and must not treat a missing one as zero.
- **Storage prohibitions.** Never BattleTags, Discord handles, raw client IPs,
  plaintext API keys, guess strings, raw Raider.IO responses or raw request
  URLs (`CLAUDE.md`). Keeping a whole achievement list would be the "stored
  signature" `CONTEXT.md` forbids.
- **Third-party raiders.** Rows about raiders who were never searched need
  removal handling. `raiderio_logged_encounter_members` is the precedent: it is
  filtered on read for suppressed characters
  (`packages/database/src/evidence/raiderio-first-kills.ts:163-189`).

## Candidates

### For reviewers, in the dossier

| #   | Candidate                          | Class                             | Built from                                                                           | Support on `test`                                                                          | Constraint check                                                             |
| --- | ---------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | Raid schedule per guild tenure     | Stored                            | Kill and wipe times grouped into nights per guild                                    | 93 tenures of ≥10 nights; median 100% of nights on three weekdays; start-hour IQR one hour | Derived from public logs; no new identity                                    |
| 2   | Main per tier                      | Stored                            | Snapshot membership and each member's current run                                    | 29 of 45 roots with kills change main across tiers                                         | Uses only the dossier's own characters                                       |
| 3   | Progression effort per boss        | Stored now; Decoder to complete   | Wipes before the first kill; bosses wiped and never killed                           | 989 of 3,019 first kills have prior wipes; median 35, p90 about 196; 288 never killed      | Show as "at least"; a boss with no stored wipes is unknown, not "first pull" |
| 4   | Farm engagement and recency        | Stored                            | Kills per boss after the first; last kill per tier                                   | Median 7 kills per boss; 59% killed ≥5 times                                               | Uses Warcraft Logs kills, not Raider.IO's `numKills`                         |
| 5   | Spec and role history              | Stored; Decoder for full coverage | `spec_name` on kills; roster role on logged kills                                    | Spec on 27,649 of 34,905 kills; 28% of character-tiers show more than one spec             | Role needs class and spec together                                           |
| 6   | Parse profile per tier             | Stored                            | Every available percentile in a tier, beside first-kill and best                     | 27,722 parsed kills                                                                        | Only over `available` values, with the count shown                           |
| 7   | Kill pace against the raid opening | Stored                            | First kill against the region start in `raid-current-content-windows.generated.json` | Not measured                                                                               | Only for raids with a catalogued window                                      |
| 8   | Item level against the raid        | Stored                            | Roster member item level against the kill's average, minimum and maximum             | 2,716 logged kills, all with item level                                                    | Raider.IO-logged first kills only                                            |
| 9   | Cutting Edge per character         | Stored                            | Per-run Cutting Edge rows, before the fold to the earliest date                      | 6,489 rows                                                                                 | None                                                                         |
| 10  | Shared history with a known roster | Stored and Request                | Logged-kill rosters matched against a reference roster                               | 10,207 distinct raiders in rosters; 124 are characters SlashWho already holds              | **Needs a decision** (see candidate 10 below)                                |

**1. Raid schedule per guild tenure.**

- **What we can say.** When and how regularly a character raided with each
  guild, e.g. "Wed/Thu/Sun, from about 19:00".
- **Why it matters.** Schedule fit is one of the first questions a recruiter
  asks, and the answer is sitting in stored fight times.
- **How nights are formed.** Grouping by UTC date shifted six hours, so a
  night that runs past midnight stays one night.
- **Caveats:**
  - The times are fight _end_ times: report start plus fight end
    (`packages/warcraftlogs/src/decode/reports.ts:270-279`).
  - They are in UTC, so a view should present them in the viewer's or the
    realm region's time zone.
  - The logged hours per night (median 1.9) and the pulls per night (median 10) are understated, because kill-report wipes are dropped (candidate 3).
    Weekday and start hour are not affected.
- **Where it fits.** Beside the existing guild history.

**2. Main per tier.**

- **What we can say.** Which linked character carried each tier.
- **What the dossier does today.** It lists the characters present at each
  kill, but never summarises that into a timeline.
- **How it is built.** Pick the character with the most kills per raid in the
  root's latest snapshot. On `test` that character changes across tiers for
  two roots in three.

**3. Progression effort per boss.**

- **What we can say:**
  - how many pulls and nights preceded the first kill;
  - for a boss never killed, that the character progressed on it.
- **What stored data supports.** A lower bound only, for two reasons:
  - The decoder drops every wipe on a boss that the same report also killed
    (`packages/warcraftlogs/src/decode/reports.ts:322-325`), so pulls on the
    kill night are lost.
  - Ranked-report hydration filters `killType: Kills` (`queries.ts:240-260`).
- **Completing it is a decoder change:**
  - Keep the kill-report wipes.
  - Drop the `killType` filter, which costs nothing because Warcraft Logs
    filters are free (`docs/operations/evidence-run-cost.md:258`).
- **How close they got.** For a boss never killed, the best pull percentage
  would help. It needs `fightPercentage` or `bossPercentage` on `fights`, which
  is unverified. Check it against the Warcraft Logs schema before relying on
  it.
- **Presentation rule.** The count must read "at least N". A boss with no
  stored wipes is unknown, never "killed on the first pull".

**4. Farm engagement and recency.**

- **What we can say.** Whether the character kept raiding a tier after its
  first kills, and when their last Mythic kill in each tier was.
- **What the dossier shows today.** It lists every kill event per boss, but
  never summarises them.
- **Where the data comes from.** Stored Warcraft Logs kills are enough.
  Raider.IO's `numKills` and `lastDefeated` would duplicate them, and the
  evidence semantics exclude Raider.IO's later kills anyway.

**5. Spec and role history.**

- **What we can say.** Which spec the character played per tier, and whether
  they changed role, e.g. "healed in two tiers".
- **Where specs come from.** `spec_name` comes from the rankings read, so
  unparsed kills have none.
- **Filling the gaps.** `fights.friendlySpecs` would fill them for free. It is
  already selected by the ranked-report query (`queries.ts:254`), and it
  parallels `friendlyPlayers` on the `fights` part the history pages already
  load.
- **Where roles come from.** Logged kills already store each raider's role.

**6. Parse profile per tier.**

- **What we can say.** The median and spread of a character's percentiles
  across all their parsed kills in a tier, next to the existing first-kill and
  best rows.
- **What the dossier has today.** Only those two single points.
- **Rules:**
  - Computed only over `available` values.
  - The count of values it covers is shown.
  - Never computed from `unavailable` rows.
- **A cheaper route.** `zoneRankings.medianPercent` is Warcraft Logs' own
  median, already in the blob we pay for. It is a different claim (a
  zone-wide median, not ours), so label it as such.

**7. Kill pace against the raid opening.**

- **What we can say.** Days from the raid's regional start to the first kill,
  or "week N".
- **What it needs.** The generated windows file already carries start dates
  per region (`scripts/raid-current-content-windows.mts:45-67`).
- **Measured?** Not on `test`. It needs the join from Warcraft Logs zone to
  Raider.IO slug, which exists in the raid catalogue
  (`packages/domain/src/raid-catalogue.ts`).

**8. Item level against the raid.**

- **What we can say.** The character's item level on a logged kill, against
  the raid's average, minimum and maximum.
- **Where it applies.** Only to the first kills Raider.IO has logged. The
  roster table has no index on member identity, but it is small.

**9. Cutting Edge per character.**

- **What we can say.** Which character earned each Cutting Edge.
- **What the domain does today.** It keeps only the earliest date per
  achievement across the account.

**10. Shared history with a known roster.**

- **What we can say.** "Has raided with N of our current members."
- **Why it needs a decision.** It is the most requested kind of recruiter
  signal, and the most sensitive:
  - **Across dossiers**, it becomes a co-raider graph. That moves towards the
    searchable directory the service is not.
  - **Within one dossier**, against the reviewing guild's own roster, it needs
    a reference roster. Blizzard's guild roster is already read during sweeps,
    but it is discarded, so this is a new read or a new stored surface.
- **Coverage today.** 124 of the 10,207 raiders in stored rosters are
  characters SlashWho already holds.
- **Wider coverage.** Warcraft Logs `friendlyPlayers` would cover kills
  Raider.IO has not logged. That is a new identifying surface with the same
  removal needs.

### For operators

| #   | Candidate                                          | Class  | Built from                                    | Support on `test`                                         |
| --- | -------------------------------------------------- | ------ | --------------------------------------------- | --------------------------------------------------------- |
| 11  | Replace `EVIDENCE_KILL_SETTLE_DAYS` with data      | Stored | Distinct parse readings per fight across runs | 378,377 readings over 35,177 fights; results under Answer |
| 12  | Parse re-read attribution                          | Stored | The same readings joined to run `origin`      | About 10.8 readings per fight                             |
| 13  | Cost and step-time panel in the collection monitor | Stored | `character_evidence_run_costs`, run phases    | 2,139 cost rows over 28 days                              |
| 14  | Snapshot history                                   | Stored | `snapshots`, `snapshot_characters`            | 77 snapshots; thin                                        |

**11. Settle window.** The query is under
[Reproducing the figures](#reproducing-the-figures).

- **What it shows.** Rankings read with `timeframe: Historical` barely move
  once a kill has been read.
- **Why it is not conclusive yet.** Only 446 of the genuine re-read pairs were
  of kills under a week old.
- **What to do.** Run the same query again after a raid reset has produced
  more young kills, then decide the window.

**12. Re-read attribution.**

- **The finding.** Fights over a year old have 215,885 reading pairs. So old
  fights are being read again, which costs points.
- **Plausible causes.** The #390 re-collection and the rebuilds of the last
  two weeks.
- **What to do.** Attribute the readings by run `origin` before assuming
  waste.

**13. Cost panel.** Points per run, per origin and per step are stored today,
but they are readable only through SQL and the Discord webhook
(`apps/worker/src/notifiers.ts:54-96`).

**14. Snapshot history.**

- **What exists.** `getHistory` and `getSnapshot` are implemented, but no route
  calls them (`packages/application/src/search-service.ts:475-498`).
- **What it could show.** Alt-list churn and guild-at-snapshot.
- **Who it is for.** Operators only, given the design decision above.

### Decoder candidates that need a product decision first

- **Heroic, Normal and AotC** from Raider.IO `raid-progress`. This contradicts
  `docs/dossier-evidence-semantics.md:29-31`.
- **Mythic+** from the Raider.IO character payload. It is a new evidence
  domain, and the field names are unverified until a payload is recorded with
  them.
- **Other Blizzard achievements** beyond Cutting Edge. A small curated set,
  such as Mythic boss feats or AotC, follows the Cutting Edge precedent. The
  whole list must never be stored.

## Found on the way

- **Storage-rule breach: Discord handles and possible BattleTags in
  `pgboss.job`.**
  - **What happens.** `DiscoverCharacterJob.rootCharacter` is the whole
    normalised Raider.IO character (`packages/database/src/queue.ts:17-27`).
    That object includes:
    - `ownerId`, the Raider.IO account name, which "can be a BattleTag or a
      Discord handle";
    - `profileGuess`, the `discord_profile` customisation.

    Sources: `packages/raiderio/src/normalize.ts:191-192`,
    `packages/raiderio/src/client.ts:174-176`.

  - **Where it is enqueued.** Whole, at
    `packages/application/src/search-service.ts:409-415` and
    `packages/application/src/start-applicant-collection.ts:44-48`.
  - **What `test` holds.** 215 `discover-character` jobs, created from
    2026-09-23 to 2026-09-30. Of these, 8 carried a non-null `ownerId` and 19 a
    non-null `profileGuess`. The count was read without printing any value.
  - **Status.** Raised separately; it needs a fix and a scrub of the existing
    rows.
- **Evidence copies grow quickly.**
  - **The size now.** The database is 1,319 MB, and the wipe table alone is
    954 MB.
  - **Why.** Superseded runs are never pruned (`schema.ts:1712-1714`).
  - **Current against total.** Current runs hold 6% of the kill rows and 5% of
    the wipe rows.
  - **The rate.** In the last two weeks a single day wrote up to 118,174 kill
    rows and 643,776 wipe rows.
  - **What a retention policy could do.** Keep one row per distinct
    `(fight, collected_at)` reading. That keeps what candidate 11 needs and
    drops the copies.
- **Wipes lose the guild region.** `character_mythic_wipes` has no
  `guild_region` column. The decoder reads the region and drops it
  (`schema.ts:1567-1569`).
- **A dead path and a deprecated one still running:**
  - **Dead.** The world boss-rankings request (`client.ts:738-758`) is
    unreachable. `raiderIoRankingRequest` returns null without a guild
    (`packages/application/src/historic-world-rank.ts:54-61`), and with a guild
    the client takes the guild endpoints instead.
  - **Deprecated.** `getHistoricMythicKills` is marked `@deprecated`
    (`packages/raiderio/src/types.ts:177`), but it runs on every full evidence
    run (`packages/application/src/verified-kills.ts:66`).
- **Stale text:**
  - **README.** `README.md` still says the website and bot "share one durable
    API". That API was removed in #51.
  - **Two comments contradict the code:**
    - `packages/contracts/src/dossier.ts:125` says only manual connections can
      be excluded.
    - `apps/web/src/components/dossier-character-menu.tsx:34-39` says row
      actions exist only for manual links.
- **Unthrottled writes.** The connected-characters `PATCH` and `DELETE`
  handlers run with no rate limit
  (`apps/web/src/app/api/dossiers/[region]/[realm]/[name]/connected-characters/route.ts:37-112`).
  The `POST` passes the request headers to the service, and the other two do
  not. This may be deliberate for an unlisted tool, but it is worth
  confirming.

## Recommendations

In order:

1. **Fix the `pgboss.job` breach** and scrub the existing rows. It breaks a
   stated rule today.
2. **Build candidates 1, 2 and 4** (schedule, main per tier, farm and
   recency). They are stored-only, need no new request, and are measured on
   `test`. They can share one "tier summary" view beside guild history.
3. **Keep kill-report wipes and drop the ranked-report `killType` filter**,
   then build candidate 3. The decoder change is free in points and makes the
   pull counts honest.
4. **Decide the settle window from data** (candidate 11). Re-run the query
   after the next raid reset.
5. **Add a retention policy for superseded evidence copies** that keeps
   distinct readings. Do this before production volumes arrive.
6. **Put candidate 10 to the maintainer as a decision**, not a build. It
   touches the not-a-directory stance and needs a reference roster.

Candidates 5 to 9 are small follow-ons once a tier summary view exists.

## Reproducing the figures

**How the queries were run:**

- Read-only, over `railway ssh --service worker --environment test`, inside
  `BEGIN READ ONLY`.
- Every query that touches current evidence uses the dossier's rule for a
  character's current run (`packages/database/src/evidence/repository.ts:1689-1711`):

```sql
with latest as (
  select distinct on (region, realm_slug, normalized_name) id
  from character_evidence_runs
  where status in ('complete', 'partial') and publication_scope = 'full'
  order by region, realm_slug, normalized_name, completed_at desc, id desc
)
```

**Settle window, candidate 11.** A reading is one `(character, fight,
collected_at)`; pairs are consecutive readings. The figures quoted count
available-to-available pairs at least a day apart, grouped by the kill's age at
the earlier reading:

```sql
with raw as (
  select r.region, r.realm_slug, r.normalized_name, k.source_fight_key,
    k.killed_at, k.collected_at, k.damage_parse_state::text as ds,
    k.damage_percentile as dp
  from character_mythic_kills k
  join character_evidence_runs r on r.id = k.evidence_run_id
), per_reading as (
  select region, realm_slug, normalized_name, source_fight_key, killed_at,
    collected_at, min(ds) as ds, min(dp) as dp
  from raw group by 1, 2, 3, 4, 5, 6
), seq as (
  select *, lag(ds) over w as prev_ds, lag(dp) over w as prev_dp,
    lag(collected_at) over w as prev_at
  from per_reading
  window w as (partition by region, realm_slug, normalized_name,
    source_fight_key order by collected_at)
)
select extract(epoch from (prev_at - killed_at)) / 86400 as age_days,
  abs(dp - prev_dp) as moved
from seq
where prev_ds = 'available' and ds = 'available'
  and collected_at - prev_at >= interval '1 day';
```

Only 102 of the 378,377 readings had more than one value under the same
`collected_at`, so treating a reading as one observation is safe.

**Raid schedule, candidate 1:**

1. Union each current run's kills and wipes that name a guild.
2. Group them into nights by `(at - interval '6 hours')::date` per character
   and guild.
3. Keep tenures of 10 or more nights.
4. For each tenure, compute the share of nights on its three most common ISO
   weekdays, and the interquartile range of the hour of its first fight.

**Progression, candidate 3:**

1. For each current run, take the first kill per `(raid_id, boss_id)`.
2. Count that run's wipes on the same raid and boss before it, and the
   distinct nights they fell on.
3. "Never killed" is a raid and boss with wipes and no kill in the same run.

**Main per tier, candidate 2:**

1. Take each root's latest snapshot and join its members to their current run.
2. Count kills per member per `raid_id`.
3. Pick the top member for each raid.
4. Count the roots whose top member differs between raids.

**Rosters, candidate 10.** Count distinct `raiderio_character_id` in
`raiderio_logged_encounter_members`, and match `(region, realm, normalized_name)`
against `characters`.

**Job payloads.** Counted with
`data->'rootCharacter'->>'ownerId' is not null` and the same test on
`profileGuess`, over `pgboss.job` where `name = 'discover-character'`. No value
was selected.

## Caveats

- **The data is from `test`, not production.** `test` holds 222 characters,
  many seeded or re-collected during development. Ratios are more trustworthy
  than absolute counts.
- **Some evidence was collected under older rules.** The current-run
  definition excludes tier-search runs, whose rows add to some characters'
  evidence.
- **The wipe figures are lower bounds throughout.** They include the schedule
  pulls-per-night figure and all of candidate 3.
- **Unverified fields must be checked before an issue depends on them.** That
  applies to anything marked unverified above, in particular Warcraft Logs
  `fightPercentage` and `bossPercentage`, and the Raider.IO character
  payload's Mythic+ keys. Check them against a recorded payload or the
  provider's schema.
