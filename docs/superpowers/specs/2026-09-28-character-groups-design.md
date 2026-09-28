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
- **Same outcome, no data lost.** Every character any page shows today is
  still shown, every limitation it shows is still shown, no label weakens, and
  no stored row is deleted or rewritten. See
  [Preserved behaviour](#preserved-behaviour).

The cost saving is modest. 9 of 78 discovery runs on test in 28 days would
have been skipped, about 12%, each up to 300 Blizzard requests. The case for
this change rests on instant pages for siblings and one consistent list, and
it should be weighed on those.

## Maintainer decisions

Recorded because each overrides a deliberate earlier rule or accepts a stated
risk. All were made on 2026-09-28.

- **Groups plus connections.** This replaces the issue's first framing, "reuse
  the owner's snapshot". There is no owner:
  - The issue's "a character with its own snapshot keeps it" gives way to "a
    character's own snapshot contributes to its group".
  - "Refresh the owner's discovery" gives way to "discover from the character
    being opened".
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
- **No automatic discovery of new members.** A group grows as its members are
  opened, as discovery does today.
- **Links stop merging after 90 days unobserved.**
- **Three phases.** Write the new tables first and compare, switch reads
  second, add rejection and expiry third.

## Model

### Terms

- **Connection.** One observation of a link between two characters: which
  discovery saw it, from which starting character, by which source, and when.
  A pair can have several observations, one per observer and source. A
  reviewer's rejection is also stored as a connection row.
- **Group.** The characters reached from one another through connections that
  count. Every character is in exactly one group; a character with no
  connections is a group of one.
- **A page's members.** What a dossier page for the opened character O
  lists:
  1. start from O's group;
  2. walk only the links that count;
  3. skip suppressed characters, which are neither shown nor walked through;
  4. from phase 3, add the far ends of O's own expired links.

### Which links count

One predicate, `countingLinks(at)`, used by every recompute, read and replay.
There is no second copy of the rule:

- every `observed` connection;
- every resolved manual connection, excluded or not, because an excluded
  character is still shown greyed today;
- from phase 3, minus links rejected for their pair, and minus observed links
  more than 90 days old.

Suppression is not part of the predicate. It is applied when a page is read,
because it can be lifted or expire.

### Tables

**`character_connections`**: one row per observation or rejection.

| Column                       | Meaning                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `character_low_id`           | One end of the link.                                                                                                     |
| `character_high_id`          | The other end. The pair is stored in a fixed order (`low < high`, enforced by a check).                                  |
| `kind`                       | `observed` or, from phase 3, `rejected`.                                                                                 |
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
  it. Undoing one action deletes only its own rows, so a pair another action
  also rejected stays rejected.

**`character_groups`**: one row per group, holding `id`, `created_at` and
`last_discovered_at`.

**`character_group_members`**: `character_id` (the primary key) and `group_id`.

**Group freshness is derived.** `last_discovered_at` is the newest
`refreshed_at` among the latest completed snapshots of the group's members.
Every recompute rewrites it. Because it is a pure function of the members, a
group split off by a recompute gets its own value without any special rule.
It is stored only so freshness is one indexed read.

**Unchanged tables.** `snapshots`, `snapshot_characters`, `discovery_runs`,
`manual_dossier_connections`, `dossier_character_exclusions` and the
`fingerprint_sweep_*` tables keep their rows and columns. No column is added
to an existing table in any phase.

- **Snapshots** are still written by every discovery. A published snapshot's
  membership stays immutable, except for the existing continuation amendment
  (`amendAndFinishFingerprintSweep`). The dossier stops reading membership from
  snapshots in phase 2.
- **A manual connection is a link** between the member it was made from and
  its target. A pending target, one not discovered yet, has no character row
  and joins the group once discovery creates it.
- **An exclusion applies to the group that contains the member it was made
  from.** If a split puts the excluded character in another group, the
  exclusion has no effect there, and it applies again if they rejoin.

### Publishing a discovery

**Lock order.** Every writer takes locks in this one order, which is what
rules out deadlocks:

1. the existing bucket and root advisory locks, sorted, as today;
2. the existing fingerprint-sweeps lock;
3. the groups lock: one transaction-level advisory lock serialising every
   group recompute.

A writer that needs only the groups lock takes only that. That covers a manual
connection add or remove, a rejection, an undo and the maintenance pass. No
writer takes the groups lock and then a root lock. No lock is held across a
provider call: discovery finishes every Raider.IO and Blizzard read before it
opens the transaction.

**Steps, in one transaction:**

1. Take the locks above.
2. Write the snapshot, or amend it for a continuation, exactly as today.
3. Update O's observations by the retraction rules below.
4. Recompute the groups of every character whose counting links changed.
5. Commit.

A failure anywhere rolls the whole publication back, snapshot included. So a
snapshot never commits without its group update, and a reader sees either the
state before or the state after, never a group half recomputed.

**Which group keeps its id.** On a merge, the oldest group's id survives. On a
split, the part with the most members keeps it; ties go to the part holding
the lowest character id. Group ids never leave the database.

### What a run may retract

Retraction is decided separately for each source family, from what the run
actually did, not from its snapshot's overall state. This is the discovery
counterpart of "a partial parse never removes verified kill evidence".

| Family                                                  | O's earlier observations of this family that this run did not see are retracted when                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raider.IO (`claimed`, `declared_main`, `profile_guess`) | The run's Raider.IO part finished with no Raider.IO limitation. A `privacy_hidden` run, or one where Raider.IO failed part way, retracts no Raider.IO link.                                |
| Fingerprint                                             | The run's sweep reached `matched`, meaning the whole roster was swept. For a continuation chain, this is at the seal, over the observations the chain's cycles made since cycle 1 started. |

- **Nothing to retract in these cases:**
  - a sweep that was `not_due`;
  - a sweep that was capped and still continuing;
  - a sweep that failed;
  - a run that completed against a live sweep's snapshot
    (`completeWithLiveSweepSnapshot`).
- **The `not_due` case matters.** Today such a run publishes a snapshot of the
  Raider.IO characters alone, which can be `complete`. That must never cut
  fingerprint links.
- **Every observation a run makes is added**, whatever its outcome, and
  renews `observed_at` for the pairs it saw again.

### Convergence

Discovery reads what is specific to its starting character: its Raider.IO
profile, and its guild rosters compared against its achievements. A group is
the union of every member's observations. It grows as members are opened and
discovered, as dossiers do today. Nothing discovers a member automatically.

## Phase 1: write connections and groups, read nothing

The worker starts maintaining the new tables. No page, route or response
changes.

**Migration `0067`** (after #734's `0066`; recheck `origin/main` before
merging, and renumber the file, journal index, `when` and migrations test if
another migration took the number):

1. **Create** the three tables.
2. **Backfill Raider.IO links** from each root's latest completed snapshot.
3. **Backfill fingerprint links** from each root's latest completed snapshot
   whose run published a fingerprint sweep, found through
   `fingerprint_sweep_admissions` and `fingerprint_sweep_reservations`.
   - This matches the retraction rule: a later `not_due` publication does not
     cut them.
   - A root whose latest snapshot dropped fingerprint members through a
     `not_due` refresh therefore gets them back. That is growth, and the replay
     reports it.
4. **Compute groups** with a recursive CTE over `countingLinks`, and derive
   `last_discovered_at`.
5. **Sanity check.** A `DO` block raises an exception, rolling the migration
   back, if any latest-snapshot member or resolved manual target is outside its
   root's group. This only guards the query itself; the real check is the
   replay.

**Worker.** Every publication path follows [Publishing a
discovery](#publishing-a-discovery):

- `snapshots.create`;
- `amendAndFinishFingerprintSweep`;
- `completeWithLiveSweepSnapshot`.

Adding or removing a manual connection is a web action, and phase 1 does not
touch the web. Manual links are read live from `manual_dossier_connections`
and are never copied into `character_connections`. Instead, the worker's
maintenance pass recomputes, under the groups lock, the groups at both ends
of every resolved manual connection. So in phase 1 a manual edit shows in the
groups within one pass. Phase 2 moves that recompute into the edit's own
transaction.

**Rebuild.** `scripts/rebuild-character-groups` rebuilds observed links and
groups from snapshots and manual connections exactly as the migration does,
then recomputes. It is idempotent, and it never deletes rejection rows.

- **When it runs.** It runs in full once whenever phase 1 code starts after
  being absent, and on demand.
- **What it's for.** It is what makes rolling back and forward safe.

**Replay.** `scripts/diagnostics/character-groups-replay.mts` runs read-only.
It calls the real phase 2 resolution code, which is shipped in phase 1 but
called by no route: `pageMembers`, labels and research state. It compares
that with what today's code produces (`resolveSubjects` and the assembled
research state) for:

- every root;
- every character in any latest snapshot, which covers the pages that are
  borrowed or `provisional` today.

For each page it compares members, labels, excluded state, limitation codes and
research state. It fails on any of:

- a character removed;
- a label weakened;
- a character newly shown as excluded;
- a limitation code missing;
- a page over `DOSSIER_CHARACTER_CEILING`.

It reports pages that grew and research states that changed.

**Exit criteria for phase 1.** The replay passes against test on three
consecutive days of live publications.

It also passes in the integration suite, on seeded fixtures with:

- identical, containing and manual shapes;
- a `not_due` refresh and a capped sweep with a continuation;
- a suppressed member and a suppressed manual target;
- a historic alias;
- an exclusion.

On 2026-09-28, an ad hoc SQL version of the membership comparison against test
gave these results:

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
both run phase 1's writes, so deploy order does not matter.

- **If phase 1 was reverted in between,** the rebuild runs before the switch.
- **Rolling back phase 2** is a code revert. The worker keeps writing through
  phase 1's code, so nothing goes stale.

### Reading a group

- **`groupOf(key)`** returns the key's group, or nothing for a character never
  discovered or a suppressed one. A suppressed key reads as not found, as
  today.
- **`pageMembers(O)`** is the walk defined under [Terms](#terms).
- **One consistent read.** Every read that feeds one response runs inside one
  `withConsistentRead`: the group, its links for labels, its members' latest
  snapshots for research state, and its exclusions. A reader therefore never
  mixes two recomputes.

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

The group logic lives inside `searchReservations.reserve`, under its existing
bucket and root locks followed by the groups lock. Search and the applicant
watcher both go through it, so they cannot disagree.

| O's group                                             | Result                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh (`last_discovered_at` within `FRESHNESS_HOURS`) | `fresh`. Nothing is reserved and no search rate limit is spent, as for a fresh own snapshot today.                                      |
| Stale, and any member has an active discovery run     | `active`, joining that run. The groups lock makes this atomic, so two concurrent searches for two members reserve one run between them. |
| Stale, with no run active                             | Reserve a discovery from O, as today.                                                                                                   |
| None                                                  | Unchanged: the negative cache, then Raider.IO, then a discovery from O.                                                                 |

- **The URL returned is always O's**, even when the run joined belongs to
  another member. Today `search-service.ts` returns the run's own character
  URL.
- **`readInitial`** looks for an active run anywhere in O's group, not only
  O's own, so a joining page is not told `not_ready`.

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

  **Contract additions.** The contract gains a separate `hasManualConnection`
  flag. The menu's Remove item uses that flag instead of the label, so a manual
  target labelled by a provider path can still be removed.

  **Fallback.** A member with no path from O cannot occur within one
  consistent read. If it does, it keeps the label from the latest snapshot
  containing it, and `group_member_unreachable` is logged.

- **Research state.** The contract stays one `{state, message}`.
  - **`state`** is `complete` only if every contributing latest snapshot is
    complete and O has a complete snapshot of its own. Otherwise it is
    `partial`, so a sibling page never claims more than was checked.
  - **`message`:** as `CONTEXT.md` requires, only privacy-hidden ownership is
    explained to the reader. When contributing snapshots carry it, the message
    names their characters, for example "Raider.IO shows no public account
    claim for Quellaria, so additional linked characters may exist". Other
    limitation codes stay internal.
- **The read never reserves.** As today, only `POST start` reserves.
  - **Contract additions:** the response gains `groupStale`, and the page calls
    `start` when it is true. That replaces the page's current start on
    `provisional` or a root-only view.
  - **`provisional`:** the service no longer produces it. The contract keeps
    accepting it, so a new page against an old server, or after a rollback,
    still parses.
- **The check for new guild members.** `scheduleConnectedCharacterSweep(O)` is
  due only when no member of O's group has published a sweep within
  `FINGERPRINT_SWEEP_CADENCE_HOURS` and no member has a live continuation
  cursor. It then queues a discovery from O, as today. Opening a sibling of a
  group swept this week costs nothing.

### Reviewer edits

Every edit resolves rows across the group, not only rows made on the page
being viewed:

- **Excluded.** A target T is excluded on O's page if any exclusion row made
  from a member of O's group names it.
- **Exclude:** writes a row from O only if the group has none for T.
- **Include:** deletes every row in the group that names T.
- **Removing a manual connection:** deletes every manual row from a member of
  the group that targets T, then recomputes under the groups lock in the same
  transaction.
- **Adding a manual connection:** writes the row from O and recomputes under
  the groups lock in the same transaction, so the target appears at once, as
  it does today. It then calls `search.create` for the target, as today, which
  discovers the target if it is unknown or stale.
- **Excluding O.** O is never shown excluded on its own page, even if a row
  made from another page names it. The searched character cannot be excluded,
  and O's page offers no exclude action for O.

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
  reachable from O through X. It leaves no second path by which X stays
  attached.
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
- **When it takes effect.** `character_groups` gains `links_valid_until`: the
  oldest counting observed link's `observed_at` plus 90 days, rewritten on
  every recompute. The maintenance pass recomputes every group whose
  `links_valid_until` has passed.
  - That step runs in its own `try`, whatever the earlier cleanup steps did.
    Today `maintenanceCleanup` rethrows an earlier failure.
  - A failure in it is logged as `character_groups_expiry_failed`.
- **Renewal.** A link is renewed when its observer re-observes it, and
  retracted by the rules above.

Adding `links_valid_until` changes a table created in phase 1, not an
existing one.

## Preserved behaviour

Each requirement has a check that fails the build or blocks the phase.

| #   | Requirement                                                                                                                                                                                | Check                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Every character a page shows today is still shown. That covers root pages and today's borrowed and `provisional` pages.                                                                    | The replay compares the old and new read code's output page by page and fails on a removal. It runs in the integration suite on fixtures and against test for three days.              |
| P2  | No existing row is deleted or rewritten, and no column is added to an existing table. That covers snapshots, discovery runs, manual connections, exclusions, sweep state and all evidence. | The migrations only create and insert. A migration test compares row counts and checksums of those tables before and after.                                                            |
| P3  | Evidence is untouched and stays keyed per character.                                                                                                                                       | Covered by P2. No phase queues or cancels an evidence run except through today's triggers.                                                                                             |
| P4  | Every limitation a page shows today is still shown.                                                                                                                                        | The replay fails on a missing code. Integration tests take a `not_due` refresh, a capped sweep with its continuation and a privacy-hidden run through publication, then read the page. |
| P5  | A member's label never weakens.                                                                                                                                                            | The replay fails on a weakened label. At run time a read logs `group_label_weakened` if a label is weaker than the member's row in O's own latest snapshot, and a test covers it.      |
| P6  | Manual connections and exclusions keep their rows and their effect, from every member's page.                                                                                              | The replay compares excluded state. End-to-end tests add, exclude, include and remove from a page other than the one the row was made on.                                              |
| P7  | Where anything changes, it only adds characters.                                                                                                                                           | The replay reports growth, and fails on removals, newly excluded characters and over-ceiling pages.                                                                                    |

## Error handling

- **Merge alert.** The worker logs `character_groups_merged`, with both sizes
  and the source of the bridging link, and sends it to
  `MAINTAINER_ALERT_WEBHOOK_URL` when set, in two cases:
  - a publication or maintenance recompute merges two groups each with more
    than one member;
  - from phase 3, a merge rejoins a rejected character.

  With fully transitive reach, this alert is the main safeguard. Merges caused
  by a reviewer's own manual connection are made by the web, which has no
  webhook, and are only logged. They are the reviewer's own assertion.

- **A recompute failure during publication** rolls the publication back, and
  the run takes today's retry path. For a continuation, that path is
  `continueWithoutProgress`, and the chain is abandoned after
  `MAX_CONTINUATION_NON_PROGRESS_CYCLES` (5).
- **The ceiling.** `DOSSIER_CHARACTER_CEILING` caps research as today. A page
  over it fails the replay, so no group reaches it unnoticed.
- **Privacy.**
  - The new tables hold character ids, sources, run ids and times, and nothing
    else: no BattleTags, Discord handles, raw provider responses or request
    URLs.
  - Suppression is applied at read time, so a suppressed character, or a
    suppressed manual target, never reveals its discoveries through a group.
  - Dossier responses stay `Cache-Control: no-store`.

## Testing

Fixtures only, with no live Raider.IO, Blizzard or Warcraft Logs traffic.

**Phase 1**

- **Unit:** `countingLinks`, recompute (merges, splits on retraction, id
  survival), retraction by family (`not_due`, capped, `matched`, a sealed
  chain, privacy-hidden), and derived freshness.
- **Integration:**
  - each publication path writes and recomputes under the lock order;
  - a failed recompute rolls the snapshot back;
  - two concurrent publications merging the same groups;
  - the migration and rebuild on seeded shapes;
  - P2's row-count and checksum comparison;
  - the replay on fixtures (P1, P4 to P7).

**Phase 2**

- **Unit:** path labels (P5), including a fingerprint-then-claimed chain and a
  manual target with and without a provider path; research state; the check
  for new guild members being due.
- **Integration:**
  - reservation, where concurrent searches for two members reserve one run;
  - search and the applicant watcher agree;
  - `readInitial` joining a sibling's run;
  - recent searches' in-progress state;
  - suppression hiding a member and a manual target, and lifting;
  - consistent reads during a publication.
- **End to end:**
  - a fresh group's member opens with the same list and queues nothing;
  - a stale group reserves one run;
  - cross-page exclude, include and remove;
  - adding a manual connection to a known character shows it at once.

**Phase 3**

- **Unit:**
  - the cut, with X linked to O directly, through a third character, and
    through a manual link;
  - undoing it with an overlapping rejection;
  - expiry and renewal.
- **Integration:**
  - the maintenance pass applying expiry after an earlier cleanup step failed;
  - a far end working with exclusion and historic-alias routes;
  - the rejoin alert.
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
