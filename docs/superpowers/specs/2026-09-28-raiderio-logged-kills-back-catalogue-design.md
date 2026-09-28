# Raider.IO-logged first kills in settled tiers

Follows #732 (PR #734). Found in #734's final review.

## Problem

`historicTierOrdinalsFrom` (`packages/application/src/verified-kills.ts`)
leaves out every Raider.IO tier whose raids all closed before the character's
kill-scan floor. That was right while Raider.IO's kill list was only a search
hint (#298): whatever such a tier returns is below the floor, which is never
searched, or a kill made after its raid's content window closed.

Since #732 the kill list also carries `loggedEncounterId`, and a logged first
kill is evidence. For a character with settled older tiers, those tiers are
never asked again, so their logged kills never reach the
`raiderio_logged_encounters` phase, not even once. #734's merge carries such
kills forward, but nothing ever collects them. A veteran applicant keeps "No
qualifying public logs found" on old bosses that Raider.IO has a logged kill
for.

There are two more gaps of the same kind:

- **Settled rosters are never re-read.** A tier that was read while current and
  has since settled is never asked again, so its stored rosters are never
  re-read. If a guild later hides its compositions, the dossier keeps naming
  its raiders, which #732's re-read rule exists to stop.
- **A partial run can skip a presence check for good.** `collectRaiderIoFirstKills`
  treats a kill as established when its published row is `read` and its stored
  roster was visible before the run (`raiderio-first-kills.ts:358-371`). Take a
  kill accepted behind a hidden roster:
  1. A re-read opens the roster, and the character is not on it.
  2. The run is partial for some other reason, such as the parse budget.
  3. `saveAnswers` has already stored the roster as visible. The collection
     leaves the kill out, but the partial merge carries the stored row forward.
  4. On the next run the kill counts as established and is never checked
     again.

  This happens on main today for asked tiers. The design below would send the
  whole back catalogue through it.

## Decision

- **Settled tiers:** each character asks each settled tier's kill list once
  every 90 days. That costs one Raider.IO request per tier. In between, the
  phase rebuilds the tier's kills from the character's own stored first kills,
  so their rosters keep being re-read by the existing rules without asking
  for the kill list.
- **Presence:** whether a kill's presence was checked is recorded on the first
  kill itself, not inferred from the roster's history.

Nothing else about #732 changes:

- only parsed fields are stored, never `log.sources` or a raw response;
- a partial result never removes kill evidence;
- the 50-read cap, the concurrency and the rate-limit handling stand, and no
  shortfall schedules a whole-run retry.

## Design

### 1. Asking a settled tier

- **A new table, `character_raiderio_tier_reads`,** with the columns
  `region`, `realm_slug`, `normalized_name`, `tier_ordinal`,
  `collection_version` and `read_at`. It is keyed by the character and
  `tier_ordinal`.
- **Migration `0067`.** The character groups spec (#738) also plans `0067`.
  Whichever lands second renumbers:
  - the SQL file;
  - the journal `idx`;
  - a `when` strictly greater than the other migration's;
  - the migrations test's slice.
- **Its own collection version.** `CURRENT_RAIDER_IO_TIER_READ_VERSION = 1`
  sits beside `CURRENT_COLLECTION_VERSIONS` in
  `packages/database/src/evidence/freshness.ts`, with the same contract: a
  collection fix to Raider.IO first kills bumps it, and every settled tier is
  asked once more.
- **It is not a new `evidence_collection_domain`.** `character_terminal_tiers`
  is keyed by Warcraft Logs raid id, and every `CASE domain … ELSE tier_bests`
  in its SQL would have to learn a fourth value.
- **What counts as marked.** A tier counts as marked only while both hold:
  - its mark is at the current version;
  - its `read_at` is at most `RAIDER_IO_TIER_READ_TTL_MS` (90 days) plus the
    character's offset old (see below).
- **Why marks expire.** Raider.IO can attach a logged encounter to an old kill
  later, for example after a late upload, or it can withdraw one. A mark keyed
  by name also outlives a change of owner. Expiry bounds all of these, at no
  more than 16 requests per character every 90 days.
- **`historicTierOrdinalsFrom` takes the marked tiers.** It leaves a tier out
  only when:
  - every raid the tier answers for closed before the floor, as today; and
  - the tier is marked.

  The other rules stand: no floor, or a floor that can't be read, keeps every
  tier, and the last pinned tier is always kept.

- **A back-catalogue tier is evidence only.** A tier asked only because it is
  unmarked (every raid closed before the floor) is:
  - **included in** `firstKills` and `askedRaidSlugs`;
  - **kept out of** `kills` (search hints) and `guilds` (a tier search's
    attendance walk).

  So the ask costs Raider.IO one request and costs no Warcraft Logs points,
  including on a tier-search run. Its raids must be in `askedRaidSlugs`: that
  is how a complete marking run, and every re-ask after expiry, drops a stored
  kill that Raider.IO no longer lists, whether withdrawn or belonging to a
  name's previous owner.

- **Expiries are spread out.** Each character's TTL is 90 days plus an offset
  of 0-14 days, taken from a stable hash of the character key. Tiers marked in
  the same rollout week therefore don't all expire on the same day.
- **The repository** gains three methods:
  - `raiderIoTierReads(key, since)` returns the ordinals marked at the current
    version with `read_at >= since`;
  - `markRaiderIoTierReads(key, ordinals, at)` upserts the version with
    `GREATEST`, so a worker from an older release can never lower it during a
    rolling deploy, and sets `read_at`;
  - `clearTerminalTiers(key)` also deletes the character's tier reads, in the
    same transaction. A rebuild then re-asks Raider.IO even if its first
    run is rate limited and writes terminal marks again.

  If the marks can't be read, they are treated as none. That costs a few
  Raider.IO requests, never a kill.

### 2. When a tier is marked

- **Which tiers.** The handler marks the tiers asked this run only because they
  were unmarked.
- **Where.** In the post-publish block, after `if (targeted) return;`. The
  write is wrapped in its own `.catch`, so it never fails the run: the tier is
  just asked again. It is outside `markTerminalTiers`' uncaught throw.
- **When.** All four of these must hold:
  - the publish was `complete`;
  - the kill list came back whole (the client already reports any failed tier
    as a limitation of the whole list);
  - the `raiderio_logged_encounters` phase ran and returned. A phase that
    threw, or one that never ran (no `getLoggedEncounter`, or a targeted
    run), marks nothing;
  - the phase had no shortfall (`raiderIoShortfall === null`).

  A partial publish carries stale rows forward, so it must not vouch for a
  tier. A capped, rate-limited or failed phase marks nothing either: the tier
  is asked again next run, and the next 50 reads drain its backlog.

- **All or nothing.** The run marks every such tier or none, whichever tier the
  shortfall came from. It fails safe: the only cost is repeated tier requests,
  at most 16 per run until a complete run lands.

### 3. Re-reading kills in settled tiers

- **The phase gets the settled kills.** When the kill list was read, every
  stored first kill in a raid the run did not ask about is rebuilt as a
  Raider.IO kill, with:
  - `raidSlug`, `bossSlug` and `loggedEncounterId`;
  - `firstDefeated`, from the stored `killedAt`;
  - the stored kill-list guild.

  Every such kill is rebuilt, due or not and logged or not, and they go into
  `collectRaiderIoFirstKills` with the run's own kills. Rebuilding only the
  due ones while adding their raids to `askedRaidSlugs` would delete the rest
  on a complete publish.

- **What they cost.** A rebuilt kill with a stored encounter or refusal is read
  again only under #732's rules:
  - a visible roster, once the guild's `shareRaidUntil` has passed, or after
    30 days where Raider.IO named no end;
  - a private roster, after 7 days;
  - a permanent refusal, after 30 days.

  A rebuilt kill whose last answer was retryable (`request_cap`, `unavailable`,
  `rate_limited`) has no stored answer. It is a first read, like any unread
  kill, and counts toward `request_cap`. A rebuilt kill with no logged
  encounter costs nothing.

- **Queue order.** Re-reads queue behind first reads within the 50-read cap.
  Among re-reads, the order is:
  1. kills in raids of tiers that would be asked anyway (not closed before the
     floor);
  2. every other kill, by oldest `read_at`.

  This holds whichever path supplied the kill, the kill list or a rebuild. So
  neither the rollout's first due date nor a 90-day re-ask lets a whole back
  catalogue crowd out current rosters.

- **They count as asked.** The rebuilt kills' raid slugs join `askedRaidSlugs`,
  so `mergeRaiderIoFirstKills` treats them like any asked raid:
  - a kill found again is kept;
  - a re-read that finds the roster hidden turns it private;
  - a failed presence check drops the kill on a complete publish;
  - a partial publish carries everything forward;
  - a failed read never removes a kill.
- **No kill list, no rebuild.** If the run could not read the kill list,
  nothing is rebuilt and storage carries every stored first kill forward, as
  today.
- **The phase ledger.** It counts rebuilt kills when deciding whether any
  logged kill exists. So a run whose only logged kills are rebuilt records the
  phase as `active`, then `completed` or `limited`, not `skipped`. To make this
  possible, `storedRaiderIoFirstKills` loads before the `active`/`skipped`
  transition, not inside the phase's `try`. If that load throws, the phase is
  recorded as `active` and then `limited` with `unavailable`, never `skipped`,
  and the run is partial as today.

### 4. Presence recorded on the first kill

- **A new column.** `character_raiderio_first_kills` gains `presence_checked
boolean NOT NULL DEFAULT false`, in the same migration.
- **What sets it.** A `read` kill is published with it true only when its
  roster was visible and held the character's Raider.IO id in this run's
  check, or when the flag was already true.
- **What leaves it false.** A kill accepted on Raider.IO's own attribution
  behind a hidden roster is published with it false, as is any `unavailable`
  kill.
- **`established` comes from the flag.** A published kill is established only
  when its flag is true, instead of "published `read`, and the roster was
  visible before this run". So a kill accepted behind a hidden roster whose
  roster has since opened is checked on every run until one checks it. A
  partial run can no longer carry it past the check.
- **The merge.**
  - `mergeFirstKill` keeps the incoming flag when the run found the kill
    again.
  - When `keepRead` restores `read` from the previous row, because Raider.IO
    dropped the kill's link, it restores the previous row's flag too.
  - A carried row keeps its own flag, so a partial run cannot change it
    either way.
- **A missing flag reads as false.** This covers a staged
  `raiderIoFirstKills` collection written before the deploy and published
  after it, and a publish by an old worker during a rolling deploy. Both reset
  flags to false, which is the safe direction: the kill is checked again.
- **Backfill.** Existing rows start false. Each character with a visible
  stored roster then makes one Raider.IO character read on its next run, and
  every such kill is checked again against the stored members. No encounter is
  re-read for it.
- **No version bump.** Neither `CURRENT_EVIDENCE_VERSION` nor
  `CURRENT_COLLECTION_VERSIONS` changes:
  - the dossier doesn't read the flag;
  - the backfill already forces the re-check;
  - a bump would re-collect every character.
- **A character read with no id.** A character read can succeed but return no
  Raider.IO id, for example for a tournament profile. That answer doesn't
  change, so it is permanent, not a shortfall:
  - a kill that needs a check is emitted as `read` with the flag false,
    accepted on Raider.IO's attribution, as behind a hidden roster;
  - the phase does not fall short for it, so the run is not held partial and
    tiers can still be marked.

  A character read that throws is still a shortfall (`unavailable`), as today.
  Such a character makes one character read per run while any kill waits on
  its check.

- **A failed check is permanent.** A kill whose visible roster lacks the
  character is dropped by the next complete publish. A log's roster doesn't
  change, a dropped kill is not stored to be re-read, and a later re-ask meets
  the same roster.
- **Name reuse is not closed here.** First-kill rows are keyed by name, so a
  new owner inherits the old owner's checked rows. This already exists on
  main. On settled tiers it now lasts only until the tier's mark expires,
  when the re-ask drops what Raider.IO no longer lists. Storing the Raider.IO
  id that passed the check would close it fully; that is left out.

### 5. What does not change

- What is stored about an encounter and a roster, and what is never stored.
- The dossier read, the contract and the web interface.
- Run cost accounting:
  - a tier request is still a Raider.IO character read, counted in
    `raiderio_historic_requests`;
  - re-reads count in `raiderio_logged_encounter_requests`.

### 6. Cost

- **Settled tiers.** Each character with a floor asks each settled tier's kill
  list at most once every 90 days: at most 16 requests, since the last pinned
  tier is always asked.
- **Back catalogue.** A veteran's logged kills drain at 50 encounter reads a
  run, as #732's rollout backlog does.
- **Backfill.** One character read on each character's next run. A character
  whose Raider.IO profile has no id makes one character read per run for as
  long as a kill waits on its check. That is one request, and it never holds
  the run partial.
- **Steady state.** Re-reads of settled kills fall due at most weekly for a
  private roster, and every 30 days for a visible roster or a refusal.

None of it costs Warcraft Logs points.

### 7. Testing

Every identity is synthetic. No test sends live Raider.IO or Warcraft Logs
traffic.

- **`historicTierOrdinalsFrom`:**
  - an unmarked settled tier is kept and a marked one left out;
  - a mark at an older version is ignored;
  - the no-floor and last-tier rules are unchanged.
- **`raiderIoVerifiedKills`:** a back-catalogue tier's kills reach
  `firstKills`, and its raids reach `askedRaidSlugs`. Its kills never reach
  `kills` or `guilds`.
- **The expiry offset:** it is stable for a key, stays within 0-14 days, and
  differs across keys.
- **`collectRaiderIoFirstKills`:**
  - a rebuilt kill with a stored answer is re-read only when due, and one
    with a retryable code is a first read;
  - a due re-read that finds the roster hidden turns it private;
  - one that finds the roster visible without the character leaves the kill
    out;
  - re-reads queue with current-tier raids first, then everything else by
    oldest `read_at`, including kills from a re-asked back-catalogue tier;
  - `established` follows `presenceChecked`;
  - a character read that succeeds with no id publishes the kill with the flag
    false and no shortfall, while a character read that throws still falls
    short.
- **The presence regression:** a partial run opens a roster without the
  character, and the next run still checks the kill and a complete publish
  drops it.
- **Job handler, with a veteran whose tier is settled:**
  - the first complete run asks the tier, publishes its logged kill, and marks
    the tier;
  - the second complete run does not ask for the tier's kill list, but
    re-reads a due roster from it. It also keeps the tier's rebuilt kills
    that are not due and those with no logged encounter;
  - an expired mark asks the tier again, and a complete re-ask drops a stored
    kill in that tier that the kill list no longer returns;
  - a character with no Raider.IO id completes its run and marks its tiers;
  - a throw from `storedRaiderIoFirstKills` records the phase as `limited`,
    not `skipped`;
  - nothing is marked after a failed publish, a partial publish, a phase that
    threw, a phase that never ran, or a targeted run;
  - a capped phase marks nothing, the next run asks the tier again, and
    neither schedules a retry;
  - a failed kill list marks nothing and carries every first kill forward;
  - a failed mark write does not fail the run;
  - a run whose only logged kills are rebuilt records the phase as run.
- **Database:**
  - marks round-trip, gated on version and `read_at`;
  - `GREATEST` keeps a newer version;
  - `clearTerminalTiers` clears the marks;
  - `presence_checked` round-trips through publish and the merge;
  - `keepRead` restores the previous row's flag;
  - a staged collection with no flag publishes it as false;
  - the migrations test covers `0067`.

### 8. Documentation

- `historicTierOrdinalsFrom`'s comment gains the mark rule.
- The "Raider.IO-logged first kills" section of
  `docs/dossier-evidence-semantics.md` gains:
  - a settled tier is asked once per character every 90 days;
  - its logged kills keep being re-read from what was stored;
  - a kill accepted behind a hidden roster is presence-checked once the roster
    opens, however many runs that takes.

## Out of scope

- Reading later kills, or Heroic and Normal kills.
- A worker-wide Raider.IO rate limiter.
- Marking each tier on its own rather than all or nothing per run.
- Clearing a tier's mark when a presence check fails. The roster doesn't
  change, and the 90-day expiry re-asks anyway.
