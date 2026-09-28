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
were Method's raiders. It was almost certainly a boost. A recruiter needs to
see the kill, the guild it was credited to, and who was in the raid.

## Decision

Every Raider.IO Mythic **first kill** of a shown character becomes evidence
when Raider.IO has a logged encounter for it. We read that encounter's kill
guild and roster, whether or not Warcraft Logs also has the kill. We never
read later kills.

- **A Raider.IO combat log counts as a kill.** Today `verified-kills.ts`
  treats Raider.IO kills as places to search, "never evidence". This design
  changes that policy. A logged encounter is a parsed combat log, and the
  character's presence on its roster, matched by Raider.IO character id, is
  the proof that they were there. Where the guild has hidden the roster,
  Raider.IO's own attribution of that logged encounter to the character stands
  in for it. Raider.IO's plain kill list, without a
  logged encounter, still stays a search hint only.
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
   - Checked on 2026-09-28 against Quellaria's six Mythic kills and
     Eundariel's Midnight Falls: `loggedEncounterId` always points to the
     **first** kill, and its `defeatedAt` equals `firstDefeated` to the
     second.
   - It can be `null`: Quellaria's Nexus-King Salhadaar has a kill but no
     logged encounter.
2. **The kill:** `GET /api/raid/logged-encounters/{raidSlug}/{loggedEncounterId}`
   returns `killDetails`. We keep only these parsed fields:
   - `kill`: `pulledAt`, `defeatedAt`, `durationMs`, `isSuccess`, and the
     item-level average, minimum and maximum.
   - `boss.slug`, `raid.slug` and `raid.difficulty`.
   - `guild`: name, realm slug and region slug, or `null` for a pug.
   - `guildPrivacy.raidComps`.
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
  - `{ kind: "limitation", code }`, the same code set as the other methods.

  `raidComps === false`, or a missing roster, parses to
  `{ kind: "encounter", roster: { state: "unavailable", reason: "private" } }`.
  The kill itself is still kept.
- **When it runs.** A new `raiderio_logged_encounters` phase follows
  `raiderio_rankings` and uses the same bounds: at most 50 encounter reads per
  run (`request_cap` beyond that), 4 at a time, and a thrown error abandons
  the queue and marks the phase `limited`.
- **Reuse.** A logged encounter never changes. Before reading, the phase skips
  every id already stored in `raiderio_logged_encounters` (see storage).
  Steady-state runs therefore make no new encounter reads unless there are new
  first kills.
- **Presence check.** The character counts as present only if the roster has
  their Raider.IO character id. When the roster is unavailable (private or not
  read), presence falls back to the character's own `raid-progress` entry,
  since Raider.IO attributed that kill to them.

### 2. Matching against Warcraft Logs

Matching works per character and per boss.

- **Matched.** A Raider.IO first kill matches a stored Warcraft Logs kill of
  the same character and boss when the two times are within
  `STORED_KILL_MATCH_MS` (2 hours). That tolerance already exists because
  Raider.IO can be an hour out. The Warcraft Logs kill event gains the
  encounter's roster, and nothing else about it changes.
- **Unmatched.** It becomes a kill event of its own, with:
  - `reportUrl: null` and no reports;
  - empty parses;
  - the guild from the logged encounter;
  - the characters present, which are the dossier's characters on the roster.

  Its `killedAt` is `defeatedAt`. If it is earlier than the character's
  Warcraft Logs first kill, it becomes the boss's first kill, and the
  existing `firstKills` ordering takes care of this.
- **World rank.** Unmatched kills go through `historicWorldRankForKill`, using
  the encounter's guild and exact `defeatedAt`. A guild's first kill therefore
  gets its rank, and a later kill with that guild gets none. Method is world
  #3 on Midnight Falls from its 8 Apr kill, and that rank is correctly **not**
  given to Eundariel's 20 Jul kill. Matched kills keep their existing rank
  lookup.

### 3. Storage and snapshots

Migration `0066` (renumber if another lands first) adds three tables.

- **`raiderio_logged_encounters`** holds the immutable kill and is keyed by
  `logged_encounter_id`:
  - raid slug, boss slug, `pulled_at`, `defeated_at` and `duration_ms`;
  - guild name, realm and region, all nullable;
  - item-level average, minimum and maximum;
  - `death_count` and `vantus_count`;
  - `roster_state` (`available | private`);
  - `read_at`.

  It is shared across characters and runs, because a kill never changes.
  It is written outside the snapshot transaction, but no reader can reach it
  except through a published run's rows.
- **`raiderio_logged_encounter_members`** holds one row per roster entry:
  - `logged_encounter_id` (FK), `raiderio_character_id` and `name`;
  - `realm` and `region`;
  - `class_name`, `spec_name`, `role` and `item_level`.
- **`character_raiderio_first_kills`** is per run and belongs to the
  snapshot. It holds:
  - `evidence_run_id`, the character key, raid slug and boss slug;
  - `logged_encounter_id` (nullable);
  - `killed_at`;
  - `encounter_state` (`read | unavailable`) and its limitation code;
  - `historic_world_rank` and `historic_rank_checked_at`.

  It is written in the same `publish` transaction as `character_mythic_kills`,
  so a snapshot never shows it half-written. It is not added as a nullable
  report column on `character_mythic_kills`, because `report_url`/`fight_url`
  are NOT NULL there and the kill merge is keyed on `fightUrl`.
- **Merge rules** follow `mergePublishedEvidence`:
  - a partial or targeted publish carries every stored Raider.IO first kill
    forward;
  - a complete publish keeps what the run found again, plus kills in terminal
    tiers;
  - a limited `raiderio_logged_encounters` phase makes the run partial, so a
    failed read never removes a kill.

  A Raider.IO first kill never replaces or removes a Warcraft Logs kill.

### 4. Contract and domain

- **Contract.** `dossierFirstKillSchema` gains an optional `roster`, a
  discriminated union:
  - `{ state: "available", playerCount, roleCounts: { tank, healer, dps },
    itemLevel: { average, min, max }, pulledAt, durationMs, deathCount,
    vantusCount, members: [...] }`, where each member has `name, realm,
    region, className, specName, role, itemLevel, isDossierCharacter`;
  - `{ state: "unavailable", reason: "private" | "no_logged_encounter" |
    "not_read" }`.

  Absent means no Raider.IO kill was matched. `reportUrl` is already
  nullable and `parses` may be empty.
- **Domain.** `applicant-dossier.ts` merges Raider.IO first kills into the kill
  events before choosing `firstKill`. A boss with only a Raider.IO kill
  becomes `state: "kill"` rather than `no_logs`.

### 5. Interface

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

### 6. Evidence states

- **Parses and reports without a public log** are shown as "No public logs
  found". This is display text for an empty list, never numeric zero.
- **An unavailable roster** is its own state and is never shown as "not
  present".
- **A kill with no guild** (a pug) shows "—", as today.

### 7. Testing

- **Recorded fixtures.** These are sanitised recordings under
  `tests/fixtures/recorded/raiderio/`, following the README: the Method
  Midnight Falls encounter, a guild-less encounter (Quellaria's Chimaerus), a
  `raid-progress` response with a `null` `loggedEncounterId`, and a
  private-roster response built by hand from the recorded shape.
- **Client.** Parsing, `log.sources` never surfacing, privacy mapping,
  limitation codes, and the id kept by the earliest-kill merge.
- **Application.** The phase's cap and concurrency, skipping stored ids, the
  presence check by character id, and a limited phase making the run partial.
- **Domain.** Matched versus unmatched within the 2-hour tolerance, an earlier
  Raider.IO kill becoming the first kill, and the world rank from the
  encounter guild. Method's 20 Jul kill gets `null`, pinned by name.
- **Database.** Publish atomicity, and the merge carrying the new rows forward
  on partial and targeted runs.
- **Web.** The card and panel with "No public logs found", the roster
  disclosure, and each unavailable reason.
- **Gate.** No live Raider.IO traffic in the pull-request gate.

### 8. Documentation

`docs/dossier-evidence-semantics.md` gains the Raider.IO-logged kill as an
evidence source, together with the policy change above.

## Out of scope

- Later kills, Heroic and Normal.
- Raiders' own guilds. The roster does not carry them, and looking them up
  would cost one read per raider.
- A derived "boosted" signal, for example a final boss killed with another
  guild before the character's own guild reached the boss before it. It was
  considered and dropped from the design.
