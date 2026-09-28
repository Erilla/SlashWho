# Character groups: one dossier per account, reused by every member

Issue: #738. Delivered in three phases, each its own pull request.

**Status (2026-09-28).**

- **Up for approval now:** the model (Terms through Convergence) and phase 1.
- **Draft:** phases 2 and 3. They are kept as the current best design, not as
  approved, and are re-reviewed against phase 1's real data from test before
  either is built. The implementation plan covers phase 1 only.
- **Where phase 1's design depends on phase 2 or 3,** that is stated as a
  constraint phase 1 must leave room for. Examples are the replay calling phase
  2's resolution code, and `countingLinks` honouring rejections.

## Problem

A dossier's character list is a snapshot rooted at the character that was
searched. Opening another member of that dossier runs discovery again from
scratch, rooted at that member: Raider.IO lookups and a fingerprint sweep of up
to 300 Blizzard requests. It does this even when the first dossier was refreshed
minutes earlier.

Evidence does not have this problem. It is already keyed per character and
shared by every dossier.

Nothing from Raider.IO or Blizzard is stored that discovery could be re-derived
from, and that is deliberate: the service stores no raw provider responses. Only
discovery's outcome can be reused.

### Measured on test, 2026-09-28

| Measure                                                                      | Value                  |
| ---------------------------------------------------------------------------- | ---------------------- |
| Characters                                                                   | 218                    |
| Dossier roots (characters with a completed snapshot)                         | 42                     |
| Membership rows across all snapshots                                         | 530                    |
| Characters in two or more roots' latest snapshots                            | 50 (10 of them in six) |
| Overlapping pairs of latest snapshots                                        | 28                     |
| ... identical                                                                | 10                     |
| ... one containing the other                                                 | 18                     |
| ... partially overlapping                                                    | 0                      |
| Links that join two groups each with more than one member                    | 0                      |
| Oldest link                                                                  | 14 days                |
| Discovery runs in 28 days                                                    | 78                     |
| ... whose root was in another dossier refreshed within the previous 24 hours | 9                      |

No two dossiers disagree about who belongs together. Where they differ, one
discovery found more than another. So the per-root snapshots are the same
account's characters, stored up to six times over.

## Goals

- **Speed.** A member's dossier appears immediately.
- **Cost.** Discovery is skipped while the member's group is fresh.
- **Consistency.** Every member of a group shows the same list.
- **Same outcome, no data lost.** In phases 1 and 2, every character any page
  shows today is still shown, every limitation it raises is still raised, no
  label weakens, and no migration or automatic process deletes or rewrites a
  stored row. See [Preserved behaviour](#preserved-behaviour). Phase 3 removes
  characters only when a reviewer or the expiry rule deliberately does so.

The cost saving is modest. 9 of 78 discovery runs on test in 28 days would
have been skipped, about 12%, each up to 300 Blizzard requests. The case for
this change rests on instant pages for siblings and one consistent list, and
it should be weighed on those.

## Maintainer decisions

Recorded because each overrides a deliberate earlier rule or accepts a stated
risk. All were made on 2026-09-28.

- **Groups plus connections.** This replaces the issue's first framing, "reuse
  the owner's snapshot". There is no owner:
  - "A character with its own snapshot keeps it" becomes "a character's own
    snapshot contributes to its group".
  - "Refresh the owner's discovery" becomes "discover from the character being
    opened".
- **Any member reuses the dossier, whatever its source.** This supersedes the
  declared-only borrow of `2026-09-26-provisional-dossier-membership-design.md`.
- **Fully transitive reach, kept after review.** One wrong link, most likely a
  false fingerprint match, joins two whole accounts on every page of both
  until a reviewer rejects it. Two alternatives were considered and declined:
  holding fingerprint links that would bridge two multi-member groups, and
  capping group size. The safeguards are the merge alert and "Not the same
  person". This replaces the deliberate one-hop rule in `CONTEXT.md`'s "Known
  reverse declaration".
- **One shared dossier.** Reviewer edits apply to the whole group. One
  reviewer's exclusion greys the character on every member's page, up to 23
  pages on test today. This replaces the per-dossier scope in `CONTEXT.md`'s
  "Excluded connection".
- **The check for new guild members runs once per group**, not once per
  character.
  - **What it costs in coverage.** A sweep from O walks the guilds of O and of
    O's own Raider.IO characters. Another member's guilds are walked only when
    a sweep runs from that member, which now happens once per group a week
    rather than once per opened character.
- **No automatic discovery of new members.** A group grows as its members are
  opened, as dossiers do today.
- **Viewing a stale group's page starts a rediscovery.**
  - The page sends one `POST start` from the opened character, charged to the
    viewer's search allowance as any start is.
  - A fresh group's page never does.
  - This extends today's `provisional` auto-start to every stale group page.
    Today a stale own-snapshot page does not auto-start.
  - A start that is refused, for example by the rate limit, leaves the
    displayed dossier as it is, with no research error.
- **Links stop merging after 90 days unobserved.**
- **Three phases.** Write the new tables first and compare, switch reads
  second, add rejection and expiry third.

## Model

### Terms

- **Connection.** One observation of a link between two characters: which
  discovery saw it, from which starting character, by which source, and when.
  A pair can have several observations, one per observer and source. A
  reviewer's rejection is also stored as a connection row.
- **Group.** The characters reached from one another through links that
  count. Every character is in exactly one group; a character with no
  connections is a group of one.
- **A page's members.** What the dossier page for the opened character O
  lists:
  1. start at O;
  2. walk the links that count, within O's stored group;
  3. skip suppressed characters, which are neither shown nor walked through;
  4. from phase 3, add the far ends of O's own expired links.

### Which links count

One predicate, `countingLinks(at)`, shipped in phase 1 and used by every
recompute, read and replay:

- every `observed` connection;
- every resolved manual connection, excluded or not, because an excluded
  character is still shown greyed today;
- minus every link between a pair that has a `rejected` row;
- from phase 3, minus observed links more than 90 days old.

**Rejections count from phase 1.** Nothing writes a rejection until phase 3,
but honouring them from the start means reverting phase 3 leaves them in
force: rejected characters do not silently rejoin.

**Suppression is not part of the predicate.** It is applied when a page is
read, because it can be lifted or expire.

### Tables

**`character_connections`**: one row per observation or rejection.

| Column                       | Meaning                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `character_low_id`           | One end of the link.                                                                                                     |
| `character_high_id`          | The other end. The pair is stored in a fixed order (`low < high`, enforced by a check).                                  |
| `kind`                       | `observed` or `rejected`.                                                                                                |
| `source`                     | For `observed`, the discovery source: `claimed`, `declared_main`, `profile_guess` or `fingerprint`. Null for `rejected`. |
| `observed_from_character_id` | For `observed`, the starting character of the discovery that saw it.                                                     |
| `discovery_run_id`           | For `observed`, the run that last saw it.                                                                                |
| `observed_at`                | For `observed`, when it was last seen. Re-observation moves it forward. For `rejected`, when the rejection was made.     |
| `rejection_id`               | For `rejected`, the reviewer action that wrote it.                                                                       |
| `rejected_from_character_id` | For `rejected`, the page the action was taken on.                                                                        |

- **Uniqueness.** An `observed` row is unique on
  `(low, high, source, observed_from_character_id)`. A `rejected` row is unique
  on `(low, high, rejection_id)`.
- **A rejected pair.** A pair is rejected while any rejection row exists for
  it. Undoing one action deletes only its own rows.
- **Record per source, before de-duplication.** A character found by both
  Raider.IO and the sweep gets one observation for each source.
  `deduplicate.ts` keeps one row for the snapshot, but the connections record
  every source the run saw.

**`character_groups`**: one row per group, holding `id`, `created_at` and
`recomputed_at` (the database's `now()` at its last recompute), and from phase
3 `links_valid_until`.

**`character_group_members`**: `character_id` (the primary key) and `group_id`.

**Freshness: one definition, derived when it's read.**
`isFresh(members, at)` is true when any of the given members has a discovery
run with status `complete` whose `completed_at` is within `FRESHNESS_HOURS` of
`at`.

- **What counts as a completed run.** Every run that completes counts,
  whatever its snapshot's state, including one that completes against a live
  sweep's snapshot (`completeWithLiveSweepSnapshot`). A failed run doesn't.
- **What it's called with.** Always a page's members, never the whole stored
  group. It is the only freshness rule, and search's short cut, `reserve`,
  `groupStale` and the replay all call it.
- **Why no stored timestamp.** An earlier draft stored a group
  `last_discovered_at` taken from snapshot `refreshed_at`, and it was wrong
  twice over:
  - a continuation amends its snapshot without moving `refreshed_at`, and a
    live-sweep completion writes no snapshot at all, so a group could stay
    stale for good;
  - a stored group-wide value also counts members hidden behind a suppressed
    character.

  Deriving it from run completion removes both problems, and it is one indexed
  lookup per page member.

**Unchanged tables.** `snapshots`, `snapshot_characters`, `discovery_runs`,
`manual_dossier_connections`, `dossier_character_exclusions` and the
`fingerprint_sweep_*` tables keep their rows and columns. No column is added
to an existing table in any phase.

- **Snapshots** are still written by every discovery. A published snapshot's
  membership stays immutable, except for the existing continuation amendment
  (`amendAndFinishFingerprintSweep`). The dossier stops reading membership from
  snapshots in phase 2.
- **A manual connection is a link** between the member it was made from and
  its target. It is read live from `manual_dossier_connections` and never
  copied into `character_connections`.
- **Two exclusion stores, both unchanged.**
  - A manual target is excluded by its manual row's `excluded` flag.
  - A discovered character is excluded by a `dossier_character_exclusions`
    row.
  - Either applies to the group that contains the member it was made from. If
    a split puts the excluded character in another group, the exclusion has no
    effect there, and it applies again if they rejoin.
  - **A self-exclusion is ignored.** Today the root's own row offers Exclude,
    and `setDiscoveredExcluded` will write a row from O naming O. That is
    harmless today, because `resolveSubjects` never shows the root excluded.
    Under groups it would grey O on every sibling's page.
    - **Which rows count.** A self-exclusion is a row whose named key is in its
      maker's shared Warcraft Logs identity set, meaning the maker itself or
      any key sharing its recorded Warcraft Logs id (#423). Today, excluding
      O's merged row writes one row naming O and one naming each such alias.
    - **What happens to them.** Every read and the replay ignore these rows.
      Phase 2 guards the write for all those keys and hides Exclude on the
      opened character's row. The replay counts the self-exclusions on test.

### Publishing a discovery

**Publication paths.** Every path that publishes follows this section:

- `snapshots.create`, for a Raider.IO-only publication, including a `not_due`
  one;
- `createAndFinishFingerprintSweep`, which is every first sweep cycle and the
  only path that knows `matched` from `capped`;
- `amendAndFinishFingerprintSweep`, which is every continuation cycle;
- `completeWithLiveSweepSnapshot`, a run that completes against a live
  sweep's snapshot.

**Lock order.** Every writer takes locks in this one order:

0. the rebuild lock: a transaction-level advisory lock. Every writer of the new
   tables takes it shared; only the rebuild takes it exclusive. Phase 2's
   single publication transaction must take it before `lockRoot`, which is
   today the first statement of every snapshot writer;
1. the existing bucket and root advisory locks, sorted, as today;
2. the existing fingerprint-sweeps lock;
3. the groups lock: one transaction-level advisory lock serialising every
   group recompute;
4. only then, any `discovery_runs` row lock, such as phase 2's `reserve`
   locking another member's run `FOR UPDATE`.

- **Writers that need only the groups lock** take only that, after the
  rebuild lock: a manual connection add or remove, a rejection, an undo and each
  maintenance recompute.
- **Phase 1's post-commit write is several short transactions, never one long
  one.**
  - The **observation write** takes the rebuild lock (shared), then O's root
    lock. It writes the connection rows, the marker and the ledger, and
    commits. It takes no groups lock, so it never holds O's root lock while
    waiting for a recompute. A landing search, `suppress(O)` or
    `negativeCache.put(O)` is held up only for that write's own milliseconds.
  - **Each affected group's recompute** is then its own transaction: the rebuild
    lock (shared), then the groups lock, recomputing that one group.
- **What the ordering guarantees.** No writer takes the groups lock and then a
  root lock, and no writer holds a `discovery_runs` row lock while waiting for
  an advisory lock. This rules out deadlocks among advisory locks, and between
  them and those row locks.
- **No lock is held across a provider call.** Discovery finishes every
  Raider.IO and Blizzard read before it opens a transaction.

**Steps.**

1. Take the locks above.
2. Write the snapshot, or amend it, exactly as today.
3. Update O's observations by the retraction rules below, and write the marker
   and the ledger.
4. Recompute the groups of every character whose counting links changed.

In phase 1 these are not one transaction. Steps 1 and 2 are today's
publication. Step 3 is the observation write, which takes the rebuild lock
and O's root lock, and no groups lock. Step 4 is one short transaction per
affected group. See [Phase 1 and phase 2](#phase-1-and-phase-2).

**Step 3 is monotone,** so a delayed write can never undo a newer one:

- it never lowers `observed_at`;
- it never retracts a row observed after its own run started;
- it writes nothing for a source family whose newest recorded write, for this
  observer, came from a run started after this one. The newer run's write
  stands, and the ledger records `blocked_by_newer`.

**The marker: `character_connection_writes`.** One row per observer and source
family: `observer_character_id`, `family` (`raiderio` or `fingerprint`),
`run_id` and `run_started_at`.

- **When it's written.** In the same transaction as the rows, for each family
  the run actually discovered, even when the write left no rows. A newer run
  that retracted everything therefore still blocks an older, delayed write.
- **It only moves forward:** `run_started_at = GREATEST(existing, new)`, and
  `run_id` changes only when it does.
- **Continuation cycles** write the fingerprint family under their chain's
  cycle-1 run, whose `started_at` is set once. They are compared with the
  newest fingerprint write, so only a newer sweep chain blocks them, never a
  Raider.IO-only run.
- **Runs that didn't sweep.** A `not_due` publication or a live-sweep
  completion discovers only the Raider.IO family, so it records and blocks only
  that family. It never blocks a chain's later cycles or its seal.
- **Clocks.** `run_started_at` is the run's `discovery_runs.started_at`. Every
  `observed_at` and `written_at` in the new tables is the database's `now()`,
  never the worker's clock.

**The ledger: `character_connection_write_log`.** Append-only: one row per
publication per source family it wrote or decided. It is written in the same
transaction as the rows, so a publication has a ledger row if and only if its
write committed.

| Column                  | Meaning                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`                | The discovery run whose publication this is.                                                                                                                                                                                                   |
| `sweep_reservation_id`  | For every sweep publication, cycle 1 included, its sweep reservation. Null for a publication with no sweep.                                                                                                                                    |
| `observer_character_id` | O.                                                                                                                                                                                                                                             |
| `family`                | `raiderio` or `fingerprint`.                                                                                                                                                                                                                   |
| `decision`              | `added_only`, `replaced` or `blocked`.                                                                                                                                                                                                         |
| `reason`                | Why, from the handler's own facts: `raiderio_complete`, `raiderio_limited`, `privacy_hidden`, `continuation`, `not_due`, `capped`, `matched`, `unread`, `skipped_guild`, `live_sweep_completion`, `blocked_by_newer`, `backfill` or `rebuild`. |
| `run_started_at`        | The run's `discovery_runs.started_at`. The ledger's rows are ordered by this, then by `written_at`.                                                                                                                                            |
| `written_at`            | The database's `now()`.                                                                                                                                                                                                                        |

It holds run, reservation and character ids and enum values, nothing else.

**What gets recorded.**

- **On which paths.** Observations are recorded on the four publication paths
  only.
- **What.** Each records its run's **published set per source**, after the
  tournament-profile filter: `excludedTournamentCharacterIds` never reach any
  new table. That set is taken before `deduplicate.ts` keeps one copy for the
  snapshot, so a character both sources found gets both observations. A run
  completing against a live sweep's snapshot records its Raider.IO
  observations.
- **Renewal.** Each write renews `observed_at` for the pairs it saw again.
- **A run that publishes nothing records nothing,** such as a failed sweep that
  is retried, or a run left waiting for an admission. The run that eventually
  publishes records them.

**Phase 1 and phase 2.**

- **Phase 1:** the snapshot commits as today. Steps 3 and 4 then run as the
  short transactions above, on a best-effort basis.
  - They run after the handler's own follow-ups, including
    `enqueueFingerprintAdmission`, and outside the handler's measured scope,
    after the `finally` that records its timings. So they neither delay the
    follow-ups nor inflate the run's measured duration or database time.
  - They sit in a `finally` after the commit, and in a catch-all that ignores
    the job's abort signal. So they still run when a follow-up such as
    `enqueueFingerprintAdmission` throws after the commit, and an abort cannot
    turn them into a `cancelled` job or skip anything after them.
  - Each transaction sets a `lock_timeout` of 5 seconds. A write that times
    out, for example behind a rebuild, logs `character_groups_write_failed`
    rather than holding a job slot past its expiry. A rebuild restarts the
    window anyway.
  - A failure logs `character_groups_write_failed` and never fails the
    publication.
- **Phase 2 onwards (draft):** steps 1 to 4 are one transaction.

**Which group keeps its id.** On a merge, the oldest group's id survives. On a
split, the part with the most members keeps it; ties go to the part holding
the lowest character id. Group ids never leave the database.

### What a run may retract

Retraction is decided separately for each source family, from what the run
actually did, not from its snapshot's overall state. The decision and its
reason are written to the ledger.

| Family                                                  | O's earlier observations of this family that this run did not see are retracted when                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raider.IO (`claimed`, `declared_main`, `profile_guess`) | The run published its own snapshot, did its own Raider.IO discovery, and `raiderIoLimitation` is null. This is read from the handler, never from the snapshot, whose limitation becomes `fingerprint_sweep_capped` on a capped cycle. A `privacy_hidden` run retracts none. A continuation cycle never retracts a Raider.IO link. Nor does a live-sweep completion, even when its own Raider.IO part was unlimited: the chain's snapshot still shows those characters.                                       |
| Fingerprint                                             | The sweep reached `matched` having read every roster it set out to. For a continuation chain, this is at the seal, over the observations the chain's cycles made since cycle 1 started. It needs one domain change: `discoverFingerprintMatches` gains an outcome `unread` for a 404 on O's profile or roster, which today returns the same empty `matched` as a real empty match, and `unread` retracts nothing. A `matched` that skipped a 404'd historical guild also retracts nothing (`skipped_guild`). |

- **Nothing to retract in these cases:**
  - a sweep that was `not_due`;
  - a sweep that was capped and still continuing;
  - a sweep that failed;
  - a run that completed against a live sweep's snapshot.
- **The `not_due` case matters.** Such a run publishes the Raider.IO
  characters alone, and can be `complete`. That must never cut fingerprint
  links.

### Convergence

Discovery reads what is specific to its starting character: its Raider.IO
profile, and its guild rosters compared against its achievements. A group is
the union of every member's observations. It grows as members are opened and
discovered, as dossiers do today. Nothing discovers a member automatically.

## Phase 1: write connections and groups, read nothing

The worker starts maintaining the new tables in best-effort transactions. No
page, route, response or publication outcome changes.

**Migration `0067`** (after #734's `0066`. The parallel spec on
`fix/raiderio-logged-kills-back-catalogue` also plans `0067`. Whichever lands
second renumbers the SQL file, the journal index, a strictly greater `when`,
and the migrations test's slice):

1. **Create six tables:**
   - `character_connections`;
   - `character_groups`;
   - `character_group_members`;
   - `character_connection_writes`;
   - `character_connection_write_log`;
   - `character_groups_maintenance`, one row holding the recompute cursor and
     when a full cursor cycle last completed.
2. **Backfill Raider.IO links** from each root's latest completed snapshot.
   `observed_at` is the snapshot's `refreshed_at`.
3. **Backfill fingerprint links** from each root's latest completed snapshot
   whose run published a fingerprint sweep, found through
   `fingerprint_sweep_admissions` and `fingerprint_sweep_reservations`.
   - This matches the retraction rule: a later `not_due` publication does not
     cut them.
   - A root whose latest snapshot dropped fingerprint members through a
     `not_due` refresh gets them back. That is growth, and the replay reports
     it.
4. **Backfill the marker and the ledger.**
   - **One row per root and family.** Each root gets one marker row and one
     ledger row, with reason `backfill` and decision `replaced`, for each
     family.
   - **Whose run.** Their `run_id` and `run_started_at` are those of the run
     whose snapshot that family's rows came from. For the fingerprint family,
     that can be an older sweep snapshot than the latest one, and check (c)
     then finds the right ledger row.
5. **Compute groups** with a recursive CTE over `countingLinks`.
6. **Sanity check.** A `DO` block raises an exception if any latest-snapshot
   member or resolved manual target is outside its root's group. That rolls
   back only the migration, which creates tables and touches no existing data.
   It guards the query itself; the real check is the replay.

**Worker.** Every publication path runs steps 3 and 4 after its own commit and
follow-ups, as described above. Nothing about the publication itself changes:
`completeWithLiveSweepSnapshot` stays the single statement it is today, and
continuations cannot be pushed into `continueWithoutProgress` by the new
writes.

**Lost writes are detected, not healed.** Nothing replays a lost write
automatically, in any phase. A write is lost in one of two ways:

- it fails, and logs `character_groups_write_failed`;
- the worker dies between the snapshot commit and the write, through a deploy
  restart, an out-of-memory kill or a job expiry, and logs nothing. The
  ledger's completeness check finds that publication with no ledger row.

An automatic heal was considered and rejected:

- replaying a run from its snapshot re-adds links a newer run retracted;
- it cannot know what to retract, because `raiderIoLimitation` and the
  sweep's outcome live only in the handler;
- it loses the second source of a character both sources found;
- it cannot see a lost continuation cycle.

Both kinds of loss get the same response: fix the cause, run the rebuild, and
restart the three days.

**A lost recompute is not a lost write.**

- **What it is.** The observation write committed, but the worker died before
  the group recompute. The ledger row exists, so check (a) passes.
- **Why it heals itself.** A group recompute is a pure function of stored links,
  unlike an observation write. So the maintenance cursor is the guaranteed
  backstop: its next full cycle recomputes the group.
- **How it's reported.** The replay reports such a group as pending until then,
  and fails only on drift that survives a full cursor cycle.

**Manual edits in phase 1.** Adding or removing a manual connection is a web
action, and phase 1 does not touch the web. So the worker's maintenance pass
recomputes every group from the stored observations and the live manual rows.
That catches removals as well as additions.

- **Scope.** It is a phase 1 measure. The groups are small, and phase 2 moves
  the recompute into each edit's own transaction.
- **Isolation.** It runs as its own maintenance step, in its own `try`. A
  failure logs `character_groups_write_failed` and never skips
  `recoverPendingSearches` or any other step. Today `maintenanceCleanup`
  rethrows an earlier failure.
- **It is bounded.**
  - Each group is its own short transaction under the groups lock, so the lock
    is held for one group at a time.
  - The pass walks groups in id order for at most 30 seconds in total, then
    saves its position in `character_groups_maintenance` and resumes there
    next pass. When it wraps round, it records that a full cycle completed.
  - It logs `character_groups_recompute` with its duration and the groups
    covered.
  - Maintenance runs hourly with a 300-second job expiry, so 30 seconds leaves
    the rest of the pass its time.

**Rebuild.** `scripts/rebuild-character-groups` rebuilds observed links, the
marker and groups from snapshots and manual connections exactly as the
migration does.

- **Locking.** It runs in one transaction holding the rebuild lock exclusively,
  then the groups lock. So no post-commit write or recompute interleaves with
  its deletes and re-inserts, and the worker need not be stopped.
- **What it writes.** For each rebuilt observer and family, it appends one
  ledger row with reason `rebuild` and decision `replaced`, whose run is the
  run of the snapshot that family's rows came from, and resets the marker to
  match. It never deletes ledger rows or rejection rows.
- **When to run it.** When test is quiet, because post-commit writes that meet
  its lock time out and log a failure.
- **It is a recovery, not a replay of history.**
  - It resets `observed_at` to snapshot times.
  - It cannot restore Raider.IO observations from runs that completed against a
    live sweep's snapshot, nor older fingerprint links that a capped chain had
    not yet sealed. The next discovery of each observer re-observes them.
- **When it's run.** By hand, as a documented step: after a lost write, and
  when rolling forward after a revert. It is not run automatically.

**Replay.** `scripts/diagnostics/character-groups-replay.mts` runs read-only.
It calls the real phase 2 resolution code, shipped in phase 1 but called by no
route: `pageMembers`, labels and research state.

- **What it compares.** That code against what today's code produces
  (`resolveSubjects` and the assembled research state), for:
  - every root;
  - every character in any latest snapshot, which covers the pages that are
    borrowed or `provisional` today.
- **Two readings.**
  1. It runs the phase 2 code over groups it recomputes in memory from the
     current links, which tests the read logic.
  2. It separately reports drift between those and the stored groups, which
     tests the writes.
     - Drift is checked only against a state after a full cursor cycle has
       completed.
     - **A pending group is skipped:** one whose members' newest ledger
       `written_at` is later than its `recomputed_at` and less than 10 minutes
       old.
     - **Drift entirely from manual links is reported, not failed.** That is
       drift where the stored group is coarser than the recomputed one only
       across pairs that share no observed link. A removed manual row leaves
       no trace, and this is how its effect is recognised.
     - **Other drift that survives a full cursor cycle fails.**
- **What it compares per page:** members, labels, excluded state, limitation
  codes and research state.
  - Excluded state follows Warcraft Logs identity aliases, as today's read
    does (#423, `groupBySharedWarcraftLogsId`): a row counts as excluded when
    any of its alias keys is named.
  - Self-exclusions are ignored, and counted separately.
- **Reconciling writes against the ledger.** Every check reads from what is
  stored, never from an inference about what a run decided. Publications
  younger than 10 minutes are skipped, because their write may still be
  pending. A publication's age runs from its run's `completed_at`, or for an
  amended snapshot from its reservation's `finished_at`, because an amend never
  moves `refreshed_at`.
  - **(a) Completeness.** Every publication in the window has the ledger rows
    it owes:
    - every completed `discovery_runs` row, live-sweep completions included,
      owes a Raider.IO row, matched by `run_id`;
    - every published `fingerprint_sweep_reservations` row, cycle 1,
      continuation cycles and seals alike, owes a fingerprint row, matched by
      `sweep_reservation_id`.

    Abandoned and superseded cycles only release, and never publish. The window
    starts at the later of the writer's deploy and the newest `rebuild` ledger
    row. A publication with no ledger row is a lost write.

  - **(b) Presence.** Every member of every root's latest snapshot, other than
    the root itself, has an observation from that root in some family. It reads raw membership, which
    ignores suppression, so a suppressed member or a suppressed root is still
    checked, and never printed. "Some family" allows for de-duplication: a
    character the sweep re-matched but the snapshot keeps as Raider.IO counts
    either way.
  - **(c) Provenance.** Every observation's `discovery_run_id` has a ledger row
    for its observer and family. An observation no snapshot holds, such as a
    new alt found by a live-sweep completion, is therefore accounted for.
  - **(d) Retraction applied.** For each observer and family, take the newest
    `replaced` ledger row, ordered by `run_started_at` then `written_at`. Every
    surviving observation from that observer in that family was last seen by
    that run, or by a later run with a non-`blocked` ledger row. A later
    `added_only` row, such as a privacy-hidden run, no longer makes the check
    vacuous.

  Any failure of (a) to (d) fails the replay.

- **It fails on any of:**
  - a character removed;
  - a label weakened;
  - a page over `DOSSIER_CHARACTER_CEILING`;
  - a character shown as excluded on a page where no exclusion row in its
    group names it;
  - a limitation code missing that no shared exclusion explains;
  - any of the ledger checks (a) to (d).
- **It reports without failing:**
  - pages that grew;
  - research states that changed;
  - characters excluded on a page because a shared exclusion made from
    another member names them, which is the intended effect of one shared
    dossier;
  - the limitations those exclusions remove;
  - drift from manual links alone.
- **It never prints a suppressed character's key.**

**Exit criteria for phase 1.**

- **Three clean days.** The replay passes against test on three consecutive
  days of live publications. Drift is zero after each completed cursor cycle.
- **No lost writes.** In those three days there is no
  `character_groups_write_failed`, and no publication missing a ledger row. If
  either happens, fix its cause, run the rebuild, and restart the three days.
- **Every risky path was exercised.** The window must include at least one
  publication of each of:
  - a first sweep cycle (`createAndFinishFingerprintSweep`);
  - a continuation cycle;
  - a seal;
  - a live-sweep completion;
  - a `not_due` refresh;
  - a privacy-hidden run;
  - a capped sweep;
  - a manual connection added and one removed.

  Test's volume is low, about 8 discovery runs in three days. So the phase 1
  plan lists how to trigger each path deliberately (for example a stale root
  with a live chain, a capped sweep, a `not_due` refresh), and the replay
  reports which paths the window covered.

- **Fixtures.** It also passes in the integration suite, on seeded fixtures
  with:
  - identical, containing and manual shapes;
  - a `not_due` refresh;
  - a capped sweep with a continuation;
  - a character found by both sources;
  - a live-sweep completion that finds a new alt;
  - an `unread` sweep;
  - a suppressed member, a suppressed root and a suppressed manual target;
  - a replay run while a write is still pending;
  - a historic alias;
  - both kinds of exclusion.

On 2026-09-28 an ad hoc SQL version of the membership comparison against test
gave:

| Result                           | Pages           |
| -------------------------------- | --------------- |
| Characters removed               | 0               |
| Roots unchanged                  | 36 of 42        |
| Roots grown                      | 6               |
| Labels weakened (286 compared)   | 0               |
| Largest group                    | 23 (ceiling 50) |
| Groups with more than one member | 24              |

Each grown root reaches exactly the size of the largest dossier already
existing in its group. Those members already have evidence collected, so the
growth costs little new collection.

| Root        | Today | Group | Largest existing dossier in the group |
| ----------- | ----: | ----: | ------------------------------------: |
| ryann       |     2 |    14 |                                    14 |
| yawners     |     2 |    10 |                                    10 |
| ryii        |    10 |    14 |                                    14 |
| ryrn        |    10 |    14 |                                    14 |
| mommystrike |     2 |     5 |                                     5 |
| regnii      |    22 |    23 |                                    23 |

**Rollback.** Revert the code. The tables go stale, and nothing reads them.

## Phase 2: read, search and edit from groups

> **Draft.** Not approved. Re-reviewed against phase 1's data before it is
> built.

Phase 2 merges only after phase 1 has met its exit criteria, and after the
replay passes again against the tree phase 2 will deploy. Its worker and web
both keep phase 1's writes, now inside the publication transaction, so deploy
order does not matter.

- **If phase 1 was reverted in between,** the rebuild is run before phase 2
  deploys.
- **Rolling back phase 2** is a code revert. The worker keeps writing through
  phase 1's code.

### Reading a group

- **`groupOf(key)`** returns the key's stored group, or nothing for a
  character never discovered or a suppressed one. A suppressed key reads as
  not found, as today.
- **Group decisions are made over page members.** These are all computed over
  `pageMembers(O)`, never the stored group:
  - freshness (`isFresh`);
  - "a member has an active run";
  - the due checks for new guild members;
  - which rows the reviewer edits below read and write.

  A member reachable only through a suppressed character therefore cannot make
  O's group fresh, have its run joined, hold off O's check, or have its rows
  grey, flag or be deleted from O's page. A suppressed member's own rows are
  untouched, and take effect again if the suppression lifts.

- **`pageMembers(O)`** is the walk defined under [Terms](#terms). It walks the
  current counting links within O's stored group, which phase 2 keeps
  consistent with the links in every writing transaction.
- **One consistent read.** Every read that feeds one response runs inside one
  `withConsistentRead`: the group, its links for labels, its members' latest
  snapshots for research state, and its exclusions.

`groupOf` and `pageMembers` replace every root-only `snapshots.getCurrent`
that decides "which dossier is this":

- `search.create`, including its fresh-snapshot short cut;
- `searchReservations.reserve`;
- `startApplicantCollection`, through `reserve`;
- `recentSearches.listRecent`, whose in-progress state comes from the group;
- `resolveSubjects`, the dossier read and the tier search;
- `readInitial`;
- `isConnectedToDossier` and `sharedIdentityKeys`;
- the connected-characters, exclusion and historic-alias routes;
- `scheduleConnectedCharacterSweep`.

### Search and reservation

The group logic lives inside `searchReservations.reserve`, following the lock
order. Search, the applicant watcher and the check for new guild members all
go through it, so none of them can disagree.

**Cheap checks first, then the lock.** `reserve` first runs `isFresh` and the
active-run test without the groups lock, and returns straight away when the
group is fresh. It takes the groups lock only on the stale path, and repeats
both tests under the lock before reserving. Every holder of the groups lock is
bounded:

- a publication holds it for its database writes only;
- a stale `reserve` holds it for:
  - walking `pageMembers(O)`, bounded by `DOSSIER_CHARACTER_CEILING`;
  - `isFresh` and the active-run test per member;
  - one `FOR UPDATE` on a member's run;
  - the rate count;
  - at most two inserts.

  That is tens of milliseconds, with no provider call.

- each maintenance recompute, phase 1's and phase 3's expiry pass alike, holds
  it for at most 30 seconds and then resumes from a saved position.

| O's page members                                  | Result                                                                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh (`isFresh`)                                 | `fresh`. Nothing is reserved and no search rate limit is spent, as for a fresh own snapshot today.                                      |
| Stale, and any member has an active discovery run | `active`, joining that run. The groups lock makes this atomic, so concurrent searches for several members reserve one run between them. |
| Stale, with no run active                         | Reserve a discovery from O, as today.                                                                                                   |
| None                                              | Unchanged: the negative cache, then Raider.IO, then a discovery from O.                                                                 |

- **The `fresh` result for a member with no snapshot of its own.**
  - **Today** the fresh branch re-reads only O's own snapshot and answers
    `character_not_found`.
  - **The public contract is unchanged.** A `character` result carries a
    `CharacterResource`, whose strict schema needs a snapshot id, state and
    time.
  - **What changes.** `search.create` gains an internal result kind,
    `group_ready`, carrying O's key and nothing else. The web route maps it to
    `{kind: "ready"}`, exactly as it maps `character`.

  The landing-page search therefore opens the page.

- **Recording a recent search.** `dossier_searches` is one global list with no
  visitor on it, shown to everyone on the landing page. So only a deliberate
  search may add to it.
  - **A landing-page search** keeps today's rule, which records a `job` or
    `character` result, and now also records `group_ready`.
  - **The `groupStale` start** sends `origin: "page"` in its `POST` body, and
    `dossiers.start` never records it. Merely viewing a sibling's page
    therefore never adds that character to the landing list.
  - **The root-only automatic start** is recorded, as today. Only the
    `groupStale` start is new, and only it carries `origin`.
  - **The request contract.** `createDossierRequestSchema` is `.strict()`, so
    phase 2 adds `origin` to it as an optional field.
- **Order of checks in `search.create`.** Today's order is kept: Raider.IO is
  read before `reserve`, so no reservation ever has to be cancelled. The
  checks run in this order:
  1. **The fresh short cut:** `isFresh(pageMembers(O))`. A fresh group answers
     `group_ready` or `character` here, before the negative cache, so a
     negatively cached member of a fresh group still opens from a landing
     search.
  2. **The negative cache.** It is checked for every key, not only one with no
     snapshot, as today. A hit answers `not_found` with no Raider.IO read.
  3. **A read-only rate-limit check.** It tests whether `reserve` would refuse
     the caller's bucket, without charging it. A refusal answers
     `rate_limited` with no Raider.IO read.
  4. **The Raider.IO root read**, as today. A 404 writes the negative cache, as
     today.
  5. **`reserve`**, which charges, and returns `reserved`, `active` or `fresh`.
     On `active` or `fresh` the Raider.IO result is simply unused, because
     `jobResult` needs no root character.

  Nothing is cancelled that this call did not insert, so another visitor's
  run is never failed or refunded. The gap between reserving and enqueueing
  stays as short as it is today. A renamed member, or a low-level alt the sweep
  found, costs one Raider.IO read per `NEGATIVE_CACHE_TTL_MS`, not one per page
  load.

- **The URL returned is always O's**, even when the run joined belongs to
  another member. Today `search-service.ts` returns the run's own character
  URL.
- **`readInitial`** looks for an active run anywhere in O's group, not only
  O's own, so a joining page is not told `not_ready`.
- **Re-enqueueing a joined run.** When the applicant watcher joins another
  member's queued run that has no queue job, it enqueues with that run's
  `rootKey`, not O. Today `start-applicant-collection.ts` passes O.

### Reading a dossier

- **Members:** `pageMembers(O)`, ranked and capped by
  `DOSSIER_CHARACTER_CEILING` as today. Every member is researched alike: its
  evidence is collected and it counts under the ceiling. That includes, from
  phase 3, the far ends of O's own expired links. The page and the ceiling
  therefore count the same characters.
- **URL and root:** the URL stays O's, and the response's `root` is O.
- **Labels.** O's row keeps the label today's code gives a snapshot's root:
  its `input` source, shown as `raiderio_declared`. That is also what the
  frozen demo `ryii-dossier.json` holds.
  - **`submitted` stays reserved for a root-only view.** The page's
    `isRootOnly` means "any row labelled `submitted`", and a root-only view
    starts research. Giving O that label would make every group page start
    research.
  - Staleness is signalled separately, by `groupStale` (below). End-to-end
    tests check that a fresh sibling page sends no `POST start`, and a stale
    one sends exactly one.

  Every other member's label describes how it relates to O:
  - A path's strength is the weakest provider link on it. Raider.IO is
    stronger than fingerprint.
  - Manual links are neutral: they neither strengthen nor weaken a path. A path
    of manual links only has strength "manual".
  - A member's label is the strongest path from O, ranked Raider.IO, then
    fingerprint, then manual-only.

  This keeps today's labels:
  - a snapshot member's direct link is itself a path, so its label can only
    stay or strengthen;
  - a manual target with no provider path is labelled manually added;
  - the characters beyond a manual link keep the label of the links beyond
    it.

  A character reached by a fingerprint link and then a Raider.IO claim is
  labelled fingerprint-derived.

  **Fallback.** A member with no path from O cannot occur within one
  consistent read. If it does, it keeps the label from the latest snapshot
  containing it, and `group_member_unreachable` is logged.

- **Contract additions.** Two fields, both optional, because the dossier schema
  is `.strict()` and `/demo` parses the frozen `ryii-dossier.json`:
  - `hasManualConnection` on a character, true when any page member has a
    manual row targeting it. The menu's Remove item uses it instead of the
    label, so a manual target labelled by a provider path can still be
    removed.
  - `groupStale` on the dossier. It is true only when all of these hold:
    - `isFresh(pageMembers(O))` is false;
    - no page member has an active discovery run;
    - O is not in the negative cache;
    - no page member has a discovery run that failed within the back-off
      window.

    It is absent or false otherwise.
    - **The back-off window.** `FRESHNESS_HOURS` after the member's most recent
      failed run. It doubles with each consecutive failed run, up to
      `FINGERPRINT_SWEEP_CADENCE_HOURS`. A cancelled reservation ends
      `failed`, so it counts too. Explicit searches ignore the back-off.
    - **Why a start never loops.** A page already following a run never starts
      another, and a member Raider.IO no longer knows doesn't keep asking.
      `isFresh` counts a run that completed against a live sweep's snapshot, so
      a character whose own sweep chain is live or abandoned becomes fresh as
      soon as one start completes. A member whose runs keep failing, whether
      from schema drift, the job lifetime or an upstream outage, costs one
      start per back-off window, not one per load.
- **Research state.** The contract stays one `{state, message}`.
  - **Where it comes from:** the latest completed snapshots of the page's
    members, the characters actually shown, not of the whole group.
  - **`state`** is `complete` only if every contributing snapshot is complete
    and O has a complete snapshot of its own. Otherwise it is `partial`, so a
    sibling page never claims more than was checked.
  - **`message`:** as `CONTEXT.md` requires, only privacy-hidden ownership is
    explained to the reader. When contributing snapshots carry it, the message
    names their roots, all of which are non-suppressed page members, for
    example "Raider.IO shows no public account claim for Quellaria, so
    additional linked characters may exist". Other limitation codes stay
    internal.
- **The read never reserves. The page starts research in two cases:**
  - **A root-only view,** a character in no group with anyone else and never
    discovered. This is today's case, keyed on the `submitted` label, and a
    refused start shows today's research error.
  - **`groupStale` is true.** The page sends one `POST start`, with
    `origin: "page"`, per page load.
    - **Only the first read decides.** `readCurrentOrStartResearch` evaluates
      `groupStale`, as today it runs only without an active job id. Nothing
      re-evaluates it: not `readDossierPoll`, `refreshDossier`,
      `readExpandedDossier` nor `readCompletedDossier`. A page polling live
      evidence therefore never sends a second start.
    - **It never adds a second run.** It joins any member's run through
      `reserve`.
    - **A refused start is silent.** "Refused" means any result other than a
      job or ready: `rate_limited`, `not_found`, `invalid`, `unauthorized`,
      `client_ip_unavailable`, suppressed or failed. The dossier stays
      displayed with no research error, because the page already shows usable
      content.
    - **A failed job is silent too.** That includes a joined member's run. The
      page keeps its content and shows no error. `researchFailed` and its
      message stay for the root-only case alone.
    - **It is never recorded** as a recent search.
  - **`provisional`** is no longer produced, and the page's "root differs" case
    cannot occur. The contract keeps accepting `provisional`, so a new page
    against an old server, or after a rollback, still parses.
- **The check for new guild members.** `scheduleConnectedCharacterSweep(O)`
  is due only when, over O's page members:
  - no member has published a sweep within `FINGERPRINT_SWEEP_CADENCE_HOURS`;
  - no member has a resumable cursor, meaning a set `resume_after` with fewer
    than `MAX_CONTINUATION_NON_PROGRESS_CYCLES` (5) continuation failures;
  - no member has an active discovery run (`queued`, `running` or
    `retrying`).

  It runs these tests without the groups lock first, and returns at once when
  the check isn't due. It fires on every dossier read, polls included, so the
  common case must cost no lock. When due, it reserves through `reserve`,
  passing the due tests (cadence and resumable cursor) as `sweepDue`, and
  `reserve` repeats them and the active-run test under the groups lock. A
  sweep that publishes between the unlocked test and the lock therefore stops
  the reservation.
  - **Freshness doesn't hold it off.** It passes `ignoreFreshness`, because
    the weekly check is not a search and must not wait up to
    `FRESHNESS_HOURS` behind a fresh group.
  - **Its rate-limit bucket.** It is charged to its own caller bucket,
    `fingerprint-sweep-visit`, with a limit high enough never to refuse. That
    matches today, where it bypasses rate limits entirely.

  An abandoned chain therefore does not block the group. Opening several
  siblings before the first sweep publishes queues one run, not one each.

### Reviewer edits

Every edit resolves rows across the group, not just the rows made on the page
being viewed. The scope differs by direction:

- **Reads** ("is T excluded?", `hasManualConnection`) use page members only.
  A suppressed member's rows neither grey nor flag anything on O's page.
- **Writes that clear** (Include, Remove) act across the whole stored group,
  suppressed members included. Otherwise a suppressed member's row would
  survive, keep T in the stored group, and grey or bring back T once the
  suppression lifts. Deleting or clearing such a row reveals nothing about
  the suppressed character.
- **Writes that add** (Exclude, a manual connection) write from O only.

The two exclusion stores are kept apart:

| Edit                           | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is T excluded on O's page?     | Yes if any manual row targeting T from a member of O's group has `excluded` set, or any `dossier_character_exclusions` row from a member of O's group names T.                                                                                                                                                                                                                                                                                                                                                                          |
| Exclude T                      | If any member of the group has a manual row targeting T, set `excluded` on every such row. Otherwise insert one `dossier_character_exclusions` row from O, unless the group already has one naming T.                                                                                                                                                                                                                                                                                                                                   |
| Include T                      | Clear `excluded` on every manual row in the group targeting T, and delete every `dossier_character_exclusions` row in the group naming T. It never deletes a manual row.                                                                                                                                                                                                                                                                                                                                                                |
| Remove the manual connection T | Delete every manual row from a member of the group targeting T, then recompute under the groups lock in the same transaction. The dialog says "Remove the manual connection to T". If a provider path still reaches T, it adds that T stays in the dossier through that link.                                                                                                                                                                                                                                                           |
| Add a manual connection to T   | First check rejections, group against group. If the group T would bring in and O's group contain any rejected pair, the add returns `rejected` before anything is queued or spent, and the page says to undo that rejection first. Otherwise, as today, call `search.create` for T. Only a `job`, `character` or `group_ready` result links anything, so a rate-limited, suppressed or invalid target links nothing. Then, in a new transaction, write the row from O and recompute under the groups lock. T appears at once, as today. |
| Exclude O                      | O is never shown excluded on its own page, even if a row made from another page names it. A self-exclusion, meaning a row naming any key in its maker's shared Warcraft Logs identity set, is ignored everywhere. Phase 2 hides Exclude on the opened character's row, which today offers it, and guards the write.                                                                                                                                                                                                                     |

- **What `search.create` for T does.** It discovers T if T's own group is stale
  or T is unknown, as today. If T is already in a fresh group, that group's
  members are what a discovery from T would largely re-find, so nothing is
  queued. The link then merges the two groups.
- **A pending manual target.** One that isn't discovered yet has no character
  row. It joins the group through the publication that creates its row: that
  publication recomputes the groups of every manual connection naming the new
  character.

**Tier search** searches every included page member. **Refresh** is unchanged:
it re-collects one character's evidence and does not rediscover.

## Phase 3: rejection and expiry

> **Draft.** Not approved. Re-reviewed against phase 1's data before it is
> built.

### Not the same person

A reviewer action that removes one character X from the group of the page it
is taken on, O. Rejecting only the pair would not be enough, because groups
are built from paths.

- **The cut.** Set X aside and find what O still reaches through counting
  links. For each of those characters that X links to directly, write a
  `rejected` row under one new `rejection_id`. That covers observed, manual and
  expired links alike. Then recompute.
- **What leaves.** X leaves together with exactly the characters that were only
  reachable from O through X, and no second path leaves X attached.
- **Undoing it.** X is listed once, as rejected, on O's page, and undo is
  available there only. It deletes the action's rows and recomputes.
- **A later rejoin.** A link discovered later can join the two sides again.
  The merge alert fires whenever a merge rejoins a character that any
  rejection row names, whatever the group sizes. The rejoined character is
  shown as an ordinary member, and the reviewer can reject again.

### Link expiry

Characters are keyed by region, realm and name. A sold or transferred
character, or a name reused after a deletion, can therefore carry an old link
that is no longer true. So an `observed` link whose `observed_at` is more than
90 days old stops counting (`CONNECTION_MERGE_TTL_DAYS`, a domain constant
with its own test).

- **Manual links and rejections** never expire.
- **Where an expired link still shows.** On its observer's page, its far end is
  a member, as a stale snapshot's member is today. That far end also works
  with every route that page offers: exclude, historic alias, and the
  connected check through `pageMembers`.
- **Its label** is the stronger of its expired link's own label and any live
  path's label, so it never weakens.
- **Where it doesn't show.** It is on no other member's page.
- **When it takes effect.** `links_valid_until` is the oldest counting observed
  link's `observed_at` plus 90 days, rewritten on every recompute. The
  maintenance pass recomputes every group whose `links_valid_until` has
  passed, as its own step in its own `try`, within the same 30-second bound
  and saved position as phase 1's recompute. A failure in it is logged as
  `character_groups_expiry_failed`.
- **Renewal.** A link is renewed when its observer re-observes it, and
  retracted by the rules above.

**Rollback.** Revert the code.

- **Rejections stay in force**, because phase 1's `countingLinks` already
  honours them; only the reviewer's controls go.
- **Expired links count again**, so groups they had split can rejoin until
  phase 3 is re-applied.

## Preserved behaviour

These requirements hold through phases 1 and 2. Each has a check that fails
the build or blocks the phase. Phase 3 removes characters only deliberately:
by a reviewer's rejection, and by expiry on every page but the observer's.

| #   | Requirement                                                                                                                                                                                                                                                             | Check                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Every character a page shows today is still shown. That covers root pages and today's borrowed and `provisional` pages.                                                                                                                                                 | The replay compares the old and new read code's output page by page and fails on a removal. It runs in the integration suite on fixtures and against test for three days.                                                                                             |
| P2  | No migration or automatic process deletes or rewrites an existing row, and no column is added to an existing table. That covers snapshots, discovery runs, manual connections, exclusions, sweep state and all evidence. Reviewer actions delete rows as they do today. | A migration test compares row counts and checksums of those tables before and after. The publication integration tests checksum the same tables after each publication path, with the group writer switched on and off, and fail if they differ.                      |
| P3  | Evidence is untouched and stays keyed per character.                                                                                                                                                                                                                    | The publication and read integration tests count evidence runs queued with the group code on and off, and fail if they differ. The evidence tables are covered by P2's checksums.                                                                                     |
| P4  | Every limitation a page raises today is still raised, except where a shared exclusion explains it.                                                                                                                                                                      | The replay fails on an unexplained missing code. Integration tests take a `not_due` refresh, a capped sweep with its continuation and a privacy-hidden run through publication, then read the page.                                                                   |
| P5  | A member's label never weakens.                                                                                                                                                                                                                                         | The replay fails on a weakened label. At run time a read logs `group_label_weakened` if any member other than O has a label weaker than its row in O's own latest snapshot, and a test covers it. O's own row is excluded: it keeps today's root label by definition. |
| P6  | Manual connections and both kinds of exclusion keep their rows and their effect, from every member's page.                                                                                                                                                              | The replay compares excluded state against the exclusion rows. End-to-end tests add, exclude, include and remove from a page other than the one the row was made on.                                                                                                  |
| P7  | Where anything changes, it only adds characters, or greys one that a shared exclusion names.                                                                                                                                                                            | The replay reports growth and shared exclusions. It fails on removals, unexplained exclusions and over-ceiling pages.                                                                                                                                                 |

**How the checksums compare.** P2's and P3's writer-on against writer-off
checksums cover every column except those set from the clock (`created_at`,
`completed_at`, `started_at`, `refreshed_at`, `recorded_at`) and generated
ids. Those differ between any two runs, so including them would make the
check always fail.

**The old read code stays until phase 3.** The replay needs today's
`resolveSubjects` to compare against. Phase 2 therefore keeps it, renamed
`legacyResolveSubjects` and called only by the replay and its tests. Phase 3
removes it.

**What the replay cannot see.** It compares page output, so flows need tests
of their own:

- adding a manual connection;
- search and reservation;
- the check for new guild members;
- `readInitial`.

The integration and end-to-end tests below cover each of them.

## Error handling

- **Merge alert.** The worker logs `character_groups_merged`, with both sizes
  and the source of the bridging link, and sends it to
  `MAINTAINER_ALERT_WEBHOOK_URL` when set, in two cases:
  - a publication or maintenance recompute merges two groups each with more
    than one member through an observed link;
  - from phase 3, a merge rejoins a rejected character.

  With fully transitive reach, this alert is the main safeguard.
  - **A merge through a manual connection** is a reviewer's own assertion. It
    is only logged, in every phase, whichever process makes it.
  - **The exception is a rejoin.** A manual add can't rejoin a rejected
    character, because the group-against-group check refuses it. If any merge
    does rejoin one, the worker's next maintenance pass raises the alert. The
    web has no webhook.

- **A recompute failure.**
  - In phase 1 it is logged and changes nothing else.
  - From phase 2 it rolls the publication back, and the run takes today's
    retry path. For a continuation, that path is `continueWithoutProgress`,
    and the chain is abandoned after `MAX_CONTINUATION_NON_PROGRESS_CYCLES`
    (5).
- **The ceiling.** `DOSSIER_CHARACTER_CEILING` caps research as today. A page
  over it fails the replay, so no group reaches it unnoticed.
- **Privacy.**
  - The new tables hold character ids, sources, run ids and times, and nothing
    else: no BattleTags, Discord handles, raw provider responses or request
    URLs.
  - Suppression is applied at read time, so a suppressed character, or a
    suppressed manual target, is neither shown nor walked through. It never
    reveals its discoveries through a group.
  - The research message names only non-suppressed page members.
  - The replay never prints a suppressed key.
  - Dossier responses stay `Cache-Control: no-store`.

## Testing

Fixtures only, with no live Raider.IO, Blizzard or Warcraft Logs traffic.

**Phase 1**

- **Unit:**
  - `countingLinks`, including rejected pairs;
  - recompute: merges, splits on retraction and id survival;
  - `isFresh` over run completion, including a live-sweep completion, a failed
    run and a partial snapshot;
  - `character_connection_writes`: a live-sweep completion in the middle of a
    chain, then a later cycle and the seal, still write the fingerprint family;
    a newer run that left no rows still blocks an older delayed write;
  - retraction by family: `not_due`, capped, `matched`, an empty `matched`
    after a 404, a sealed chain, privacy-hidden, and a continuation never
    touching Raider.IO links;
  - per-source recording before de-duplication.
- **Integration:**
  - each of the four publication paths writes after its commit;
  - a failing group write leaves the publication and continuation untouched,
    including an aborted job and a delayed `enqueueFingerprintAdmission`;
  - a delayed continuation write after a newer run cannot lower `observed_at`
    or retract that run's rows;
  - a delayed write for an observer whose newer run has been written adds
    nothing, including a delayed continuation after a newer retraction;
  - the maintenance recompute stops at its 30-second bound and resumes;
  - the ledger checks: (a) fails on a publication with no ledger row, (b) on
    a snapshot member with no observation, (c) on an observation with no
    ledger row, and (d) on a retraction not applied. None fails on a
    character found by both sources, a live-sweep completion's new alt, an
    `unread` sweep, a suppressed member or root, or a publication younger
    than 10 minutes;
  - a worker killed between the snapshot commit and the write leaves a
    publication with no ledger row, and the replay fails on it;
  - a worker killed between the observation write and the group recompute
    leaves a pending group, which the replay skips, and the next full cursor
    cycle recomputes it;
  - a cycle-1 sweep publication is matched in check (a) by its
    `sweep_reservation_id`;
  - a backfilled root whose latest snapshot is a `not_due` refresh passes
    check (c) against the older sweep run's ledger row;
  - check (d) still applies after a later `added_only` row;
  - a follow-up that throws after the commit still gets its observation
    write, and a write behind a rebuild times out and logs a failure;
  - the replay's path-coverage report lists each of the exit criteria's
    paths;
  - drift: a manual removal made mid-cycle is reported, not failed, and a
    partial cursor cycle is never checked;
  - the observation write never waits on the groups lock while holding O's
    root lock, and runs outside the handler's measured timings;
  - the rebuild runs while post-commit writes are attempted and none
    interleaves;
  - tournament-excluded characters never appear in any new table;
  - the maintenance recompute catches a removed manual connection, and a
    failure in it does not skip `recoverPendingSearches`;
  - the migration and rebuild on seeded shapes;
  - P2's row-count and checksum comparison;
  - the replay on fixtures (P1, P4 to P7), including a shared exclusion
    reported rather than failed.

**Phase 2**

- **Unit:**
  - path labels (P5), including a fingerprint-then-claimed chain and a manual
    target with and without a provider path;
  - research state from page members only;
  - the check for new guild members being due, including an abandoned chain.
- **Integration:**
  - reservation, where concurrent searches for several members reserve one
    run;
  - a search for a member Raider.IO answers 404, while another visitor's run
    for the group is queued, leaves that run queued and charged;
  - a rate-limited search makes no Raider.IO read;
  - a `POST` carrying `origin` parses, and one without it still does;
  - search and the applicant watcher agree, including the re-enqueue key;
  - the `fresh` result for a member with no snapshot of its own;
  - `readInitial` joining a sibling's run;
  - recent searches' in-progress state;
  - suppression hiding a member, a manual target and a research message name,
    then lifting;
  - consistent reads during a publication;
  - the atomic publication rolling back on a failed recompute.
- **End to end:**
  - a fresh sibling page sends no `POST start`, and a stale one sends exactly
    one, which joins a running member's run if there is one; O's row carries
    today's root label;
  - a stale page whose start is rate-limited, or whose joined run fails, keeps
    showing its dossier with no research error;
  - a stale page whose member's last run failed sends no start within the
    back-off window, and a landing search for it still reserves;
  - Remove and Include from O's page clear a suppressed member's row too, so
    T neither returns nor greys when the suppression lifts;
  - a stale page whose O owns a live sweep chain, and one whose O owns an
    abandoned chain, each send one start and then none on later loads;
  - a stale page for a member Raider.IO answers 404 sends one start, costs one
    Raider.IO read, and then none within the negative-cache time;
  - a page's automatic start is not added to recent searches, and a landing
    search for a `group_ready` member is;
  - polling a page with live evidence sends no second start;
  - a self-exclusion made on O's page, including through a Warcraft Logs
    alias, does not grey O on a sibling's page;
  - a suppressed member's exclusion does not grey T on O's page, and Remove
    leaves the suppressed member's row in place;
  - a fresh group's member opens with the same list and queues nothing;
  - opening several siblings queues at most one sweep;
  - cross-page exclude and include for both stores;
  - removal with a provider path remaining;
  - adding a manual connection to a known character shows it at once, and to
    a rate-limited or suppressed one links nothing.

**Phase 3**

- **Unit:**
  - the cut, with X linked to O directly, through a third character, and
    through a manual link;
  - undoing it with an overlapping rejection;
  - expiry and renewal.
- **Integration:**
  - the maintenance pass applying expiry after an earlier cleanup step failed;
  - a far end working with exclusion and historic-alias routes;
  - the rejoin alert;
  - a manual add to a rejected pair answering `rejected`.
- **End to end:** "Not the same person" and its undo.

## Supersedes

- **Provisional dossier membership**
  (`2026-09-26-provisional-dossier-membership-design.md`). Its borrow is
  replaced by groups, and `provisional` is no longer produced.
- **`CONTEXT.md`, "Known reverse declaration."** The one-hop rule gives way to
  transitive groups. Discovery's reverse-declaration lookup itself is
  unchanged.
- **`CONTEXT.md`, "Excluded connection."** It is scoped to the group, not the
  dossier it was made on. Its effect is otherwise unchanged.
- **`CONTEXT.md`, "Applicant dossier."** It is still never stored. What it
  lists is the page's members.

`CONTEXT.md` gains **Connection**, **Group** and **A page's members**. The
entries above are edited in phase 2's pull request.

## Out of scope

- Reusing one fingerprint sweep across siblings on the same roster (#719).
- Discovering or collecting evidence for new members automatically.
- Re-checking expired links automatically. They are renewed only when their
  observer is discovered again.
- Dropping snapshots, `manual_dossier_connections` or
  `dossier_character_exclusions`.
