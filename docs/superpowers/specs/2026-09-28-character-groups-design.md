# Character groups: one dossier per account, reused by every member

Issue: #738. Delivered in three phases, each its own pull request.

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
`last_discovered_at`, and from phase 3 `links_valid_until`.

**`character_group_members`**: `character_id` (the primary key) and `group_id`.

**Group freshness.** `last_discovered_at` is the newest `refreshed_at` among
the latest completed snapshots of the group's members.

- **When it's written.** Every recompute rewrites it, and every publication
  recomputes the starting character's own group whether or not a link
  changed. So an ordinary rediscovery that finds the same characters still
  renews freshness.
- **Why it's stored.** It is a pure function of the members, so a group split
  off gets its own value without a special rule. It is stored only so
  freshness is one indexed read.

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

1. the existing bucket and root advisory locks, sorted, as today;
2. the existing fingerprint-sweeps lock;
3. the groups lock: one transaction-level advisory lock serialising every
   group recompute;
4. only then, any `discovery_runs` row lock, such as phase 2's `reserve`
   locking another member's run `FOR UPDATE`.

- **Writers that need only the groups lock** take only that: a manual
  connection add or remove, a rejection, an undo and the maintenance pass.
- **What the ordering guarantees.** No writer takes the groups lock and then
  a root lock, and no writer holds a `discovery_runs` row lock while waiting
  for an advisory lock. This rules out deadlocks among advisory locks, and
  between them and those row locks.
- **No lock is held across a provider call.** Discovery finishes every
  Raider.IO and Blizzard read before it opens the transaction.

**Steps.**

1. Take the locks above.
2. Write the snapshot, or amend it, exactly as today.
3. Update O's observations by the retraction rules below.
4. Recompute O's group and the groups of every character whose counting links
   changed, rewriting `last_discovered_at`.

- **Phase 1:** the snapshot commits as today. Steps 3 and 4 then run in a
  separate, best-effort transaction, so a failure logs
  `character_groups_write_failed` and never fails the publication.
- **Phase 2 onwards:** all four steps are one transaction. A failure rolls the
  whole publication back, snapshot included. A snapshot then never commits
  without its group update, and a reader sees either the state before or the
  state after.

**Which group keeps its id.** On a merge, the oldest group's id survives. On a
split, the part with the most members keeps it; ties go to the part holding
the lowest character id. Group ids never leave the database.

### What a run may retract

Retraction is decided separately for each source family, from what the run
actually did, not from its snapshot's overall state.

| Family                                                  | O's earlier observations of this family that this run did not see are retracted when                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raider.IO (`claimed`, `declared_main`, `profile_guess`) | The run did its own Raider.IO discovery and `raiderIoLimitation` is null. This is read from the handler, never from the snapshot, whose limitation becomes `fingerprint_sweep_capped` on a capped cycle. A `privacy_hidden` run retracts none. A continuation cycle never retracts a Raider.IO link: it did no Raider.IO discovery of its own. |
| Fingerprint                                             | The sweep reached `matched` over a roster it actually read. For a continuation chain, this is at the seal, over the observations the chain's cycles made since cycle 1 started. An empty `matched` caused by a 404 on O's profile or roster retracts nothing.                                                                                  |

- **Nothing to retract in these cases:**
  - a sweep that was `not_due`;
  - a sweep that was capped and still continuing;
  - a sweep that failed;
  - a run that completed against a live sweep's snapshot.
- **The `not_due` case matters.** Such a run publishes the Raider.IO
  characters alone, and can be `complete`. That must never cut fingerprint
  links.
- **Every observation a run makes is added**, whatever its outcome, and
  renews `observed_at` for the pairs it saw again. A run completing against a
  live sweep's snapshot still records its Raider.IO observations.

### Convergence

Discovery reads what is specific to its starting character: its Raider.IO
profile, and its guild rosters compared against its achievements. A group is
the union of every member's observations. It grows as members are opened and
discovered, as dossiers do today. Nothing discovers a member automatically.

## Phase 1: write connections and groups, read nothing

The worker starts maintaining the new tables in best-effort transactions. No
page, route, response or publication outcome changes.

**Migration `0067`** (after #734's `0066`; recheck `origin/main` before
merging, and renumber the file, journal index, `when` and migrations test if
another migration took the number):

1. **Create** the three tables.
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
4. **Compute groups** with a recursive CTE over `countingLinks`, and derive
   `last_discovered_at`.
5. **Sanity check.** A `DO` block raises an exception if any latest-snapshot
   member or resolved manual target is outside its root's group. That rolls
   back only the migration, which creates tables and touches no existing data.
   It guards the query itself; the real check is the replay.

**Worker.** Every publication path runs steps 3 and 4 in a best-effort
transaction after its own commit. Nothing about the publication itself changes:
`completeWithLiveSweepSnapshot` stays the single statement it is today, and
continuations cannot be pushed into `continueWithoutProgress` by the new
writes.

**Manual edits in phase 1.** Adding or removing a manual connection is a web
action, and phase 1 does not touch the web. So the worker's maintenance pass
recomputes every group from the stored observations and the live manual rows,
under the groups lock. That catches removals as well as additions.

- It is a phase 1 measure. The groups are small, and phase 2 moves the
  recompute into each edit's own transaction.
- It runs as its own maintenance step, in its own `try`. A failure logs
  `character_groups_write_failed` and never skips `recoverPendingSearches` or
  any other step. Today `maintenanceCleanup` rethrows an earlier failure.

**Rebuild.** `scripts/rebuild-character-groups` rebuilds observed links and
groups from snapshots and manual connections exactly as the migration does. It
never deletes rejection rows.

- **It is a recovery, not a replay of history.** It resets `observed_at` to
  snapshot times. It cannot restore Raider.IO observations from runs that
  completed against a live sweep's snapshot, nor older fingerprint links that
  a capped chain had not yet sealed. The next discovery of each observer
  re-observes them.
- **When it's run.** It is run by hand as a documented step when rolling
  forward after a revert of phase 1 or 2. It is not run automatically.

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
     tests the best-effort writes and should be zero outside a maintenance
     interval.
- **What it compares per page:** members, labels, excluded state, limitation
  codes and research state.
- **It fails on any of:**
  - a character removed;
  - a label weakened;
  - a page over `DOSSIER_CHARACTER_CEILING`;
  - a character shown as excluded on a page where no exclusion row in its
    group names it;
  - a limitation code missing that no shared exclusion explains.
- **It reports without failing:**
  - pages that grew;
  - research states that changed;
  - characters excluded on a page because a shared exclusion made from
    another member names them, which is the intended effect of one shared
    dossier;
  - the limitations those exclusions remove.
- **It never prints a suppressed character's key.**

**Exit criteria for phase 1.**

- The replay passes against test on three consecutive days of live
  publications, and reports zero drift after each maintenance pass.
- It also passes in the integration suite, on seeded fixtures with:
  - identical, containing and manual shapes;
  - a `not_due` refresh;
  - a capped sweep with a continuation;
  - a suppressed member and a suppressed manual target;
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

| O's group                                             | Result                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh (`last_discovered_at` within `FRESHNESS_HOURS`) | `fresh`. Nothing is reserved and no search rate limit is spent, as for a fresh own snapshot today.                                      |
| Stale, and any member has an active discovery run     | `active`, joining that run. The groups lock makes this atomic, so concurrent searches for several members reserve one run between them. |
| Stale, with no run active                             | Reserve a discovery from O, as today.                                                                                                   |
| None                                                  | Unchanged: the negative cache, then Raider.IO, then a discovery from O.                                                                 |

- **The `fresh` result for a member with no snapshot of its own.**
  `search.create` returns a `character` result built from O's `characters` row
  and its group. Today it re-reads only O's own snapshot and would answer
  `character_not_found`. The landing-page search therefore opens the page, and
  `recentSearches.record` runs.
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
- **Labels.** O's row keeps today's `submitted` label. Every other member's
  label describes how it relates to O:
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

- **Contract additions.** One field, optional, because the dossier schema is
  `.strict()` and `/demo` parses the frozen `ryii-dossier.json`:
  `hasManualConnection`, true when any member of the group has a manual row
  targeting this character. The menu's Remove item uses it instead of the
  label, so a manual target labelled by a provider path can still be removed.
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
- **The read never reserves, and the page starts research as it does today.**
  - The page calls `POST start` only for a root-only view: a character that is
    in no group with anyone else and has never been discovered. That is
    today's root-only case.
  - `provisional` is no longer produced, and the page's "root differs" case
    cannot occur. A stale dossier view does not start research on its own, as
    a stale own-snapshot view does not today; search does.
  - The contract keeps accepting `provisional`, so a new page against an old
    server, or after a rollback, still parses.
- **The check for new guild members.** `scheduleConnectedCharacterSweep(O)`
  goes through `reserve`, so it joins a member's active or waiting run instead
  of adding one. It is due only when:
  - no member of O's group has published a sweep within
    `FINGERPRINT_SWEEP_CADENCE_HOURS`;
  - no member has a resumable cursor, meaning a set `resume_after` with fewer
    than `MAX_CONTINUATION_NON_PROGRESS_CYCLES` (5) continuation failures;
  - no member has an active or waiting discovery run.

  An abandoned chain therefore does not block the group. Opening several
  siblings before the first sweep publishes queues one run, not one each.

### Reviewer edits

Every edit resolves rows across the group, and keeps the two exclusion stores
apart:

| Edit                           | Effect                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is T excluded on O's page?     | Yes if any manual row targeting T from a member of O's group has `excluded` set, or any `dossier_character_exclusions` row from a member of O's group names T.                                                                                                                                                                                                                                                   |
| Exclude T                      | If any member of the group has a manual row targeting T, set `excluded` on every such row. Otherwise insert one `dossier_character_exclusions` row from O, unless the group already has one naming T.                                                                                                                                                                                                            |
| Include T                      | Clear `excluded` on every manual row in the group targeting T, and delete every `dossier_character_exclusions` row in the group naming T. It never deletes a manual row.                                                                                                                                                                                                                                         |
| Remove the manual connection T | Delete every manual row from a member of the group targeting T, then recompute under the groups lock in the same transaction. The dialog says "Remove the manual connection to T". If a provider path still reaches T, it adds that T stays in the dossier through that link.                                                                                                                                    |
| Add a manual connection to T   | As today, first call `search.create` for T. Only a `job` or `character` result links anything, so a rate-limited, suppressed or invalid target links nothing. Then, in a new transaction, write the row from O and recompute under the groups lock. T appears at once, as today. If T and a member of O's group are a rejected pair, the add returns `rejected`, and the page says to undo that rejection first. |
| Exclude O                      | O is never shown excluded on its own page, even if a row made from another page names it. The searched character cannot be excluded, and O's page offers no exclude action for O.                                                                                                                                                                                                                                |

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
  passed, as its own step in its own `try`. A failure in it is logged as
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

| #   | Requirement                                                                                                                                                                                                                                                             | Check                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Every character a page shows today is still shown. That covers root pages and today's borrowed and `provisional` pages.                                                                                                                                                 | The replay compares the old and new read code's output page by page and fails on a removal. It runs in the integration suite on fixtures and against test for three days.                           |
| P2  | No migration or automatic process deletes or rewrites an existing row, and no column is added to an existing table. That covers snapshots, discovery runs, manual connections, exclusions, sweep state and all evidence. Reviewer actions delete rows as they do today. | Migrations only create and insert. A migration test compares row counts and checksums of those tables before and after. No worker path writes to them beyond what it writes today.                  |
| P3  | Evidence is untouched and stays keyed per character.                                                                                                                                                                                                                    | Covered by P2. No phase queues or cancels an evidence run except through today's triggers.                                                                                                          |
| P4  | Every limitation a page raises today is still raised, except where a shared exclusion explains it.                                                                                                                                                                      | The replay fails on an unexplained missing code. Integration tests take a `not_due` refresh, a capped sweep with its continuation and a privacy-hidden run through publication, then read the page. |
| P5  | A member's label never weakens.                                                                                                                                                                                                                                         | The replay fails on a weakened label. At run time a read logs `group_label_weakened` if a label is weaker than the member's row in O's own latest snapshot, and a test covers it.                   |
| P6  | Manual connections and both kinds of exclusion keep their rows and their effect, from every member's page.                                                                                                                                                              | The replay compares excluded state against the exclusion rows. End-to-end tests add, exclude, include and remove from a page other than the one the row was made on.                                |
| P7  | Where anything changes, it only adds characters, or greys one that a shared exclusion names.                                                                                                                                                                            | The replay reports growth and shared exclusions. It fails on removals, unexplained exclusions and over-ceiling pages.                                                                               |

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

  With fully transitive reach, this alert is the main safeguard. A merge made
  through a manual connection is a reviewer's own assertion, and is only
  logged, in every phase, whichever process makes it.

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
  - recompute: merges, splits on retraction, id survival, and freshness
    rewritten when no link changed;
  - retraction by family: `not_due`, capped, `matched`, an empty `matched`
    after a 404, a sealed chain, privacy-hidden, and a continuation never
    touching Raider.IO links;
  - per-source recording before de-duplication.
- **Integration:**
  - each of the four publication paths writes after its commit;
  - a failing group write leaves the publication and continuation untouched;
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
  - search and the applicant watcher agree, including the re-enqueue key;
  - the `fresh` result for a member with no snapshot of its own;
  - `readInitial` joining a sibling's run;
  - recent searches' in-progress state;
  - suppression hiding a member, a manual target and a research message name,
    then lifting;
  - consistent reads during a publication;
  - the atomic publication rolling back on a failed recompute.
- **End to end:**
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
