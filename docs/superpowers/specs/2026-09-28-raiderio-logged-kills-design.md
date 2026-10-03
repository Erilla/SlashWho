# Raider.IO-logged first kills, with kill guild and roster

Issue: #732.

## Problem

A Mythic kill can have no public Warcraft Logs report, but still have a combat
log on Raider.IO. The dossier then shows the boss as "No qualifying public logs
found".

On 2026-09-28, [Quellaria](https://slashwho.com/dossiers/eu/draenor/quellaria)
showed Cutting Edge: Midnight Falls, achieved 20 Jul 2026, next to a Midnight
Falls card saying there were no logs. The kill belongs to Quellaria's
Raider.IO-declared connected character, Eundariel, and is
[Raider.IO logged encounter 10095623](https://raider.io/raid-logged-encounters/tier-mn-1/10095623).
It was a Mythic kill with Method (Twisting Nether), and the other 19 players
were Method's raiders. Nothing on the dossier showed any of this. A recruiter
needs to see the kill, the guild it was credited to, and who was in the raid.

## Decision

Every Raider.IO Mythic **first kill** of a shown character becomes evidence
when Raider.IO has a logged encounter for it. We read that encounter's kill
guild and roster, whether or not Warcraft Logs also has the kill. We never
read later kills.

- **A Raider.IO combat log counts as a kill.** Today `verified-kills.ts`
  treats Raider.IO kills as places to search, "never evidence". This design
  changes that policy. A logged encounter is a parsed combat log, and the
  character's presence on its roster, matched by Raider.IO character id, is
  the proof that they were there. Historic roster profile IDs can differ after
  a transfer. A validated historic `name-<id>` locator may be resolved by
  Raider.IO to the current subject's exact positive safe integer ID (#782);
  that saved upstream resolution also establishes presence. Names, class and
  suffixes are locators or candidate filters only, never identity proof or
  inferred account connections. Unresolved identity leaves collection partial
  and preserves published evidence; the historical roster remains unchanged.
  Where the guild has hidden the roster,
  Raider.IO's own attribution of that logged encounter to the character stands
  in for it. Raider.IO's plain kill list, without a logged encounter, still
  stays a search hint only.
- **Warcraft Logs stays the source for everything it has.** Where the two
  sources match the same kill, the Warcraft Logs kill keeps its reports,
  parses and guild, and gains the roster.

## What Raider.IO gives us

Both endpoints are internal website endpoints. We already call
`/api/characters/…/raid-progress`.

1. **The character's kills:**
   `GET /api/characters/{region}/{realm}/{name}/raid-progress?tier={n}`
   - `getHistoricMythicKills` already requests this for every tier in
     `raiderIoHistoricTiers` on each run.
   - Each Mythic entry carries `loggedEncounterId: number | null`. We
     currently drop it.
   - Checked on 2026-09-28 against the example character's six Mythic kills
     and its connected character's Midnight Falls: `loggedEncounterId` always
     points to the **first** kill, and its `defeatedAt` equals
     `firstDefeated` to the second.
   - It can be `null`: the example character's Nexus-King Salhadaar kill
     has no logged encounter.

2. **The kill:** `GET /api/raid/logged-encounters/{raidSlug}/{loggedEncounterId}`
   returns `killDetails`. We keep only these parsed fields:
   - `kill`: `pulledAt`, `defeatedAt`, `durationMs`, `isSuccess`, and the
     item-level average, minimum and maximum.
   - `boss.slug`, `raid.slug` and `raid.difficulty`.
   - `guild`: name, realm slug and region slug, or `null` for a pug.
   - `guildPrivacy.raidComps` and `guildPrivacy.shareRaidUntil` (an ISO
     instant, or none).
   - `log.deaths.count` and `log.vantus.count`.
   - For each roster entry: `character.id`, `name`, `realm.slug`,
     `region.slug`, `class.name`, `spec.name` and `spec.role`
     (`tank | healer | dps`), plus `itemLevelEquipped`.

   We never keep `log.sources`. It holds the uploader's Raider.IO account
   name, which can be a BattleTag or Discord handle. We also never keep the
   raw response.

## Design

### 1. Reading the data

- **Keep the id.** `historicRaidProgressResponseSchema` gains an optional,
  nullable `loggedEncounterId`, and `HistoricMythicKill` carries it. The
  earliest-kill merge in `getHistoricMythicKills` keeps the id of the kill it
  keeps.
- **A new gateway method.** `getLoggedEncounter(raidSlug, id, signal)` returns
  one of:
  - `{ kind: "encounter", … }` with the parsed fields;
  - `{ kind: "limitation", code }`, the same code set as the other methods,
    from one limitation mapper that all three methods share.

  `raidComps === false`, or a missing or empty roster, parses to
  `{ kind: "encounter", roster: { state: "unavailable", reason: "private" } }`.
  The kill itself is still kept. That rule is written once, in the domain,
  and the client and the dossier both use it. A roster member's realm is
  folded to the Blizzard slug (lower case, accents dropped), as every
  character key is.

- **When it runs.** A new `raiderio_logged_encounters` phase follows
  `raiderio_rankings` and uses the same bounds: at most 50 encounter reads per
  run (`request_cap` beyond that), 4 at a time, and a thrown error or a
  `rate_limited` answer abandons the queue and marks the phase `limited`: no
  further read is sent once Raider.IO has said to stop.
- **What is read again.** Before reading, the phase looks up every id in
  `raiderio_logged_encounters` (see storage):
  - a kill stored with a **visible roster** is read again once the guild's
    stored `shareRaidUntil` has passed, or, where Raider.IO named none, once
    its `read_at` is more than 30 days old, because a guild can hide its
    compositions after the kill. (A re-read made after `shareRaidUntil` that
    still finds the roster visible, and so stores the same past end, waits
    the ordinary 30 days rather than costing a read every run.) A re-read
    that finds the roster hidden (`raidComps` false, a missing or empty
    roster, or a 403 `private`) turns the stored row private and deletes its
    raiders in the same transaction; one that finds it still visible
    refreshes the roster. `not_found`, `schema_drift` and transient failures
    never downgrade a visible roster: a refusal only moves `read_at` on;
  - a kill stored with a **private roster** is read again once its `read_at`
    is more than 7 days old, because a guild can open its roster after the
    kill. A later read that shows the roster replaces the stored one; a later
    refusal only moves `read_at` on, and never unreads the kill;

  Whatever a re-read finds, the kill itself (its times, duration, item
  levels, guild, deaths and Vantus runes) stays as first read; only the
  roster and the guild's privacy change. A kill already accepted stays
  accepted when its roster becomes hidden.
  - a **permanent answer** (`not_found`, a 403 `private`, or `schema_drift`,
    which includes a log of another boss) is stored as an unavailable row
    with its code and `read_at`, and asked again only once it is more than
    30 days old.

  Re-reads count against the same 50 and queue behind first reads. A re-read
  the cap leaves out keeps its stored answer and does not limit the phase.
  Steady-state runs therefore make no new encounter reads unless there are
  new first kills or answers that are due again, and stored permanent answers
  never fill the cap.

- **Which answers limit the phase.** Only retryable ones: `request_cap`,
  `rate_limited` and `unavailable`. A permanent answer marks that kill's
  encounter unavailable with its code, and the run is not made partial.
- **No early retry for the cap.** A `request_cap` from this phase never
  schedules a `capRetryMs` re-run: a re-run is a whole evidence run, which
  would spend Warcraft Logs points to read Raider.IO. The backlog (at rollout,
  every stored character's back catalogue is unread) drains through ordinary
  runs, 50 at a time, and meanwhile the unread kills show "not read yet".
  The same holds for `rate_limited` and `unavailable`: no shortfall of this
  phase, whatever its code, schedules a whole-run retry. The run is partial,
  so nothing stored is dropped, and the character's next ordinary run reads
  again.
- **No worker-wide limiter.** The per-run bounds stand: 50 encounter reads,
  50 rank requests and at most one character read. A 429 limits the phase.
  If the rollout makes many runs partial at once, they drain as above.
- **Presence check.** The character counts as present only if the roster has
  their Raider.IO character id. When the roster is unavailable (private or not
  read), presence falls back to the character's own `raid-progress` entry,
  since Raider.IO attributed that kill to them. The id comes from one
  character read, made only when some visible roster has not yet been
  accepted for the character.

### 2. Matching against Warcraft Logs

Matching works per character and per boss. The rule is written once, in the
domain, and collection and the dossier both import it.

- **Matched.** A Raider.IO first kill matches a stored Warcraft Logs kill of
  the same character and boss when the two times are within
  `STORED_KILL_MATCH_MS` (2 hours). That tolerance already exists because
  Raider.IO can be an hour out. The boss is compared by Raider.IO's own slugs,
  so a Raider.IO boss that the Journal lists twice (Grong, whose two faction
  versions Raider.IO ranks as one) matches either version's Warcraft Logs
  kill. The Warcraft Logs kill event gains the encounter's roster, and
  nothing else about it changes.
- **Unmatched.** It becomes a kill event of its own, with:
  - `reportUrl: null` and no reports;
  - empty parses;
  - the guild from the logged encounter;
  - the characters present, which are the dossier's characters on the roster.

  Its `killedAt` is `defeatedAt`. If it is earlier than the character's
  Warcraft Logs first kill, it becomes the boss's first kill, and the
  existing `firstKills` ordering takes care of this. A Raider.IO boss the
  Journal lists twice is shown under the one the Journal lists first.

- **Out of window.** An unmatched Raider.IO kill outside the raid's
  current-content window is withheld like a Warcraft Logs kill, under the
  source `raiderio`. When its Warcraft Logs copy was withheld too, it is not
  counted again.
- **World rank.** Unmatched kills go through `historicWorldRankForKill`, using
  the encounter's guild and exact `defeatedAt`. A guild's first kill therefore
  gets its rank, and a later kill with that guild gets none. In the problem's
  example, the kill guild is world #3 on Midnight Falls from its own 8 Apr
  kill, and that rank is correctly **not** given to the 20 Jul kill. Only a
  kill whose logged encounter was read is ranked, since only it can stand as
  an event of its own. A rank once checked is kept with its check time, a
  null rank included, and not asked about again. Matched kills keep their
  existing rank lookup.

### 3. Storage and snapshots

Migration `0066` (renumber if another lands first) adds three tables and two
columns.

- **`raiderio_logged_encounters`** holds Raider.IO's answer for one logged
  encounter and is keyed by `logged_encounter_id`. A row is one of two
  answers:
  - **read**: raid slug, boss slug, `pulled_at`, `defeated_at` and
    `duration_ms`; guild name, realm and region, all nullable; item-level
    average, minimum and maximum; `death_count` and `vantus_count`;
    `roster_state` (`available | private`); and `share_raid_until`, the
    guild's `shareRaidUntil`, nullable;
  - **unavailable**: only `unavailable_code`
    (`not_found | private | schema_drift`), every kill column null.

  Both carry `read_at`. A check constraint enforces one shape or the other.
  Storage enforces the re-read rules: a later read of a read row changes
  only `roster_state`, `share_raid_until`, `read_at` and the roster rows
  (deleted when the roster turns private), never the kill columns; an
  unavailable row may be replaced by a later read; and an unavailable answer
  never overwrites a read.

  It is shared across characters and runs. It is written outside the snapshot
  transaction, but no reader can reach it except through a published run's
  rows.

- **`raiderio_logged_encounter_members`** holds one row per roster entry:
  - `logged_encounter_id` (FK), `raiderio_character_id`, `name` and
    `normalized_name` (the lower-cased name);
  - `realm` (the Blizzard slug) and `region`;
  - `class_name`, `spec_name`, `role` and `item_level`.

  A member is keyed exactly as a `suppressed_characters` row is, so a removed
  raider can be recognised (see §4).

- **`character_raiderio_first_kills`** is per run and belongs to the
  snapshot. It holds:
  - `evidence_run_id` (the character is the run's, as for
    `character_mythic_kills`), raid slug and boss slug;
  - `logged_encounter_id` (nullable);
  - `killed_at`, and Raider.IO's own kill-list guild, shown only while the
    encounter is unread;
  - `encounter_state` (`read | unavailable`) and its limitation code;
  - `historic_world_rank` and `historic_rank_checked_at`.

  It is written in the same `publish` transaction as `character_mythic_kills`,
  so a snapshot never shows it half-written. It is not added as a nullable
  report column on `character_mythic_kills`, because `report_url`/`fight_url`
  are NOT NULL there and the kill merge is keyed on `fightUrl`.

- **Run columns.** `character_evidence_runs.raiderio_limitation_code` is a
  fourth reason a run may be partial, alongside the Warcraft Logs, parse and
  skipped-scan reasons. `character_evidence_run_costs` gains
  `raiderio_logged_encounter_requests`. The one character read is a Raider.IO
  character read, so it is counted with the existing
  `raiderio_historic_requests`.
- **Merge rules** follow `mergePublishedEvidence`:
  - a partial or targeted publish carries every stored Raider.IO first kill
    forward;
  - a complete publish keeps what the run found again, plus every stored
    first kill in a Raider.IO raid the run did not ask about (the tiers the
    run skipped as closed);
  - a run that could not read the kill list publishes no Raider.IO section,
    and every stored first kill is carried forward;
  - a limited `raiderio_logged_encounters` phase makes the run partial, so a
    failed read never removes a kill;
  - a read encounter is never lost to a later failed read.

  A Raider.IO first kill never replaces or removes a Warcraft Logs kill.

### 4. Removal

A roster names raiders who are not the dossier's subject, so the existing
removal policy (`docs/operations/removals.md`) reaches it. The dossier read
leaves out every roster member under an active `suppressed_characters` row,
with the same test on region, realm slug and normalised name that
`snapshots.ts` applies to a dossier's own characters. A removed character is
therefore never named on anyone's dossier, and a suppression takes effect on
the next read, without a new run.

- The player and role counts stay Raider.IO's: a removed raider is counted
  and never named.
- The rows are kept (user decision, 2026-09-28), as removal keeps snapshots.
  An expired suppression shows the raider again.
- Collection's presence check reads the whole roster, because it compares
  only the subject's own id and shows nothing.

### 5. Contract and domain

- **Contract.** `dossierFirstKillSchema` gains an optional `roster`, a
  discriminated union:

  ```ts
  type DossierKillRoster =
    | {
        state: "available";
        playerCount: number;
        roleCounts: { tank: number; healer: number; dps: number };
        itemLevel: { average: number; min: number; max: number };
        pulledAt: string;
        durationMs: number;
        deathCount: number;
        vantusCount: number;
        members: Array<{
          name: string;
          realm: string;
          region: string;
          className: string;
          specName: string;
          role: "tank" | "healer" | "dps";
          itemLevel: number | null;
          isDossierCharacter: boolean;
        }>;
      }
    | {
        state: "unavailable";
        reason: "private" | "no_logged_encounter" | "not_read";
      };
  ```

  Absent means no Raider.IO kill was matched. `members` is never empty and
  carries no Raider.IO id. `reportUrl` is already nullable and `parses` may be
  empty.

- **Domain.** `applicant-dossier.ts` merges Raider.IO first kills into the kill
  events before choosing `firstKill`. A boss with only a Raider.IO kill
  becomes `state: "kill"` rather than `no_logs`. A roster left with nobody to
  name once suppressed raiders are taken off reads as `private`, by the same
  rule the client uses.
- **Conclusions.** A run partial only for its Raider.IO reads still supports
  "No qualifying public logs found", because its Warcraft Logs history scan
  ran. A run whose kill scan was skipped never does, whatever else it names:
  `kill_scan_skipped` is loaded onto the run for this. A permanent answer
  (`not_found`, `private`, `schema_drift`) counts as no logged encounter, so a
  kill it names is never shown alone.

### 6. Interface

This uses the existing kill card and evidence panel, with no badges. In the
collapsed card:

- The heading, "First kill: {date} · {characters}" and "World rank" are
  unchanged.
- First kill parses and Best parses show "No public logs found" when there
  are none. Best parses still shows another character's Warcraft Logs parses
  when they exist.

In the expanded "View kill evidence" panel:

- The existing fields are unchanged: First kill, Guild (with the profile
  icons), World rank, Reports, Characters present and Parses.
- **Reports** and **First kill parses** show "No public logs found" when there
  are none.
- A nested **View roster** disclosure spans the panel's width and opens
  lazily, like `LazyDetails`. It shows:
  - a summary line: player count, role split, average item level with its
    range, pull time, fight length, deaths and Vantus runes;
  - a table of role icon, character (in class colour), class, realm (only
    where it differs from the kill guild's) and item level, with dossier
    characters highlighted and labelled "Connected character".
- When the roster is unavailable, View roster shows "Roster unavailable" and
  a one-line reason: hidden by the guild, no logged encounter on Raider.IO,
  or not read yet. It is never an empty table.

### 7. Evidence states

- **Parses and reports without a public log** are shown as "No public logs
  found". This is display text for an empty list, never numeric zero.
- **An unavailable roster** is its own state and is never shown as "not
  present".
- **A kill with no guild** (a pug) shows "—", as today.
- **A raider with no item level** shows "—", never 0.

### 8. Testing

All test identities are synthetic (characters, guilds and Raider.IO ids), as
the recorded fixtures already are; the repository is public.

- **Recorded fixtures.** These are sanitised recordings under
  `tests/fixtures/recorded/raiderio/`, following the README: a guild's
  Midnight Falls encounter with a visible roster, a guild-less encounter, a
  `raid-progress` response with a `null` `loggedEncounterId`, and a
  private-roster response built by hand from the recorded shape. Each
  recording's `ignored` list names every key of the real response the
  allow-list drops.
- **Client.** Parsing, `log.sources` never surfacing, privacy mapping, realm
  folding, limitation codes, and the id kept by the earliest-kill merge.
- **Catalogue.** Every Raider.IO slug pair places a boss, Grong included, and
  the match rule matches either Grong.
- **Application.** The phase's cap and concurrency, the re-read rules (a
  visible roster once its `shareRaidUntil` has passed or after 30 days
  without one, a private one after 7 days, a permanent answer after 30), a
  visible roster re-read as hidden turning private, a 429 abandoning the
  queue, a deleted log asked about once across two runs, stored answers never
  filling the cap, the presence check by character id, a limited phase making
  the run partial, a capped run scheduling no retry, and the rank rule: a
  guild's first kill ranked and a later kill with it unranked, pinned with a
  synthetic guild on the problem's dates.
- **Domain.** Matched versus unmatched within the 2-hour tolerance, an earlier
  Raider.IO kill becoming the first kill, the world rank carried from
  collection, the counts kept when a raider is left off, and a withheld
  Raider.IO kill labelled `raiderio` and counted once.
- **Database.** Publish atomicity, the merge carrying the new rows forward on
  partial and targeted runs, the storage re-read rules, a suppressed raider
  left off the dossier's roster while counted, and the run-cost column.
- **Service.** A Raider.IO-only partial keeps its "no logs" conclusions; a
  skipped-scan run stays incomplete.
- **Web.** The card and panel with "No public logs found", the roster
  disclosure, and each unavailable reason.
- **Gate.** No live Raider.IO traffic in the pull-request gate.

### 9. Documentation

`docs/dossier-evidence-semantics.md` gains the Raider.IO-logged kill as an
evidence source, together with the policy change above, the re-read rules and
the removal rule.

## Out of scope

- Later kills, Heroic and Normal.
- Raiders' own guilds. The roster does not carry them, and looking them up
  would cost one read per raider.
- A derived "boosted" signal, for example a final boss killed with another
  guild before the character's own guild reached the boss before it. It was
  considered and dropped from the design.
- A flag for a kill guild that differs from the character's own guild. #732
  asks for one; it was removed at the user's direction during design. The
  kill card's Guild field shows the kill guild, and the character's own guild
  is on the dossier already, with no badge comparing them.
- A link to the Raider.IO logged encounter. #732 asks for one; it was removed
  at the user's direction during design. Nothing here stores or shows a
  Raider.IO URL.
- A worker-wide Raider.IO rate limiter. The per-run bounds stand, and a 429
  limits the phase.
