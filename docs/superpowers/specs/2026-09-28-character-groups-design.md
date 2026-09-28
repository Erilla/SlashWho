# Character groups: one dossier per account, reused by every member

Issue: #738.

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
| Discovery runs in 28 days                                                    | 78                     |
| ... whose root was in another dossier refreshed within the previous 24 hours | 9                      |

No two dossiers disagree about who belongs together. Where they differ, one
discovery found more than another. So the per-root snapshots are the same
account's characters, stored up to six times over.

## Goals

- **Speed.** A member's dossier appears immediately.
- **Cost.** Discovery is skipped while the member's group is fresh.
- **Consistency.** Every member of a group shows the same list.
- **Same outcome, no data lost.** Every character any dossier shows today is
  still shown, every limitation it shows is still shown, and no stored row is
  deleted or rewritten. See [Preserved behaviour](#preserved-behaviour).

## Decision

Characters are linked by **connections**, and the characters a chain of
connections reaches form a **group**. A dossier is the group of the character
that was opened, seen from that character. Reach is fully transitive: every
member of a group sees the identical list.

### Data model

**`character_connections`**: a link observed by discovery, or a reviewer's
rejection of one. One row per link.

| Column                       | Meaning                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `character_low_id`           | One end of the link.                                                                                                             |
| `character_high_id`          | The other end. The pair is stored in a fixed order (`low < high`, enforced by a check), so A–B and B–A are the same link.        |
| `kind`                       | `observed` or `rejected`.                                                                                                        |
| `source`                     | For an `observed` link, the discovery source: `claimed`, `declared_main`, `fingerprint` or `profile_guess`. Null for `rejected`. |
| `observed_from_character_id` | The starting character of the discovery that observed it. Null for `rejected`.                                                   |
| `discovery_run_id`           | The run that observed it. Null for `rejected`.                                                                                   |
| `observed_at`                | When the link was observed or rejected.                                                                                          |

- **One observed row per observer.** An `observed` link is unique on
  `(low, high, source, observed_from_character_id)`, so each starting character
  holds its own observation of a pair.
- **A rejection overrides every observation.** A `rejected` link is unique on
  `(low, high)`, and while it exists no observation of that pair connects
  anything.

**`character_groups`**: one row per group, holding `id`, `created_at` and
`last_discovered_at`. `last_discovered_at` is the newest completion of any
discovery published into the group. It is what freshness is judged by.

**`character_group_members`**: `character_id` (the primary key) and `group_id`.
Every character belongs to exactly one group; a character with no connections
is a group of one.

**Unchanged tables.** `manual_dossier_connections` and
`dossier_character_exclusions` stay where they are, with their rows unchanged.
They are read as group data:

- A manual connection made from any member is an edge of the group. Its target
  is keyed by region, realm and name, so a pending target, one not discovered
  yet, needs no character row. It becomes part of the group once discovery
  creates the character.
- An exclusion made from any member applies to the whole group.

**Snapshots** and their memberships are still written by every discovery
run, unchanged. They are the immutable record of what each run found. The
dossier stops reading membership from them.

**Research state and limitations** are computed, not stored. They come from
the latest completed snapshot of every group member that has one, which is
the source of truth today. Duplicating them onto the group row would add
something to keep consistent and nothing to read.

### Publishing a discovery

A discovery's snapshot publication and its group update are one transaction:

1. Take the transaction-level advisory lock that serialises every group
   update. Publications are rare (78 in 28 days on test), so one global lock is
   correct and costs nothing measurable.
2. Write the snapshot, exactly as today.
3. Update the run's observed connections, following the retraction rules
   below.
4. Recompute the groups of every character whose connections changed. Load the
   connected component over observed, non-rejected links and every resolved
   manual connection, excluded or not, then merge or split groups to match.
5. Set `last_discovered_at` on the resulting groups.
6. Commit.

Readers see either the state before the publication or the state after it,
never a group half recomputed. This is the snapshot rule, _a new snapshot is
published only once its full membership is committed_, applied to groups.

**Which group keeps its id.** When groups merge, the oldest group's id survives
and the others are deleted after their members move. When a group splits, the
component with the most members keeps the id, and ties go to the component
holding the lowest character id. Group ids never leave the database.

**Continuations.** A fingerprint sweep continuation already amends its
published snapshot (`amendAndFinishFingerprintSweep`). It adds its new
fingerprint links in the same transaction and recomputes the same way.

### What a run may retract

This is the discovery counterpart of "a partial parse never removes verified
kill evidence".

- **A complete full discovery** replaces every observed link its starting
  character's earlier runs recorded, so it can retract a link.
- **A partial discovery only adds links.** That covers a privacy-hidden profile,
  a capped sweep and an upstream failure part way through. It never removes a
  link it did not re-observe.
- **A Raider.IO-only discovery** replaces only its starting character's
  Raider.IO-sourced links (`claimed`, `declared_main`, `profile_guess`). It
  never touches fingerprint links.
- **A failed discovery** changes nothing, and `last_discovered_at` does not
  move.

A link observed only from a character nobody reopens is never re-checked. The
same is true of today's snapshots, which persist until their root is searched
again. Link expiry is out of scope.

### Convergence

Discovery reads what is specific to its starting character: its Raider.IO
profile, and its guild rosters compared against its achievements. So what a
group contains depends on who has been discovered, and the group is the union
of every member's observations.

When a publication brings a character into a group for the first time, that
character gets a **Raider.IO-only discovery**. It reads the character's profile,
claims and declared main, about three requests, and skips the fingerprint
admission. The handler already runs Raider.IO before asking for an admission,
so this is a job option, not a new handler. A Raider.IO-only discovery queues
further Raider.IO-only discoveries only for members it newly adds, so the chain
stops once nothing new turns up.

The fingerprint sweep still runs only from a character discovered in full.
Reusing one sweep for siblings on the same roster is #719.

Evidence is queued by today's triggers only:

- a newly admitted fingerprint match is collected on joining, as now;
- every other member is collected when a dossier read reaches it.

Eagerly collecting every new member is a separate change.

## Reads, searches and edits

**Resolving the group.** One function, `groupOf(key)`, returns a character's
group and its members, or nothing for a character never discovered. It
replaces every root-only `snapshots.getCurrent` that decides "which dossier is
this":

- the search service;
- `resolveSubjects`, the tier search and the dossier read;
- `isConnectedToDossier` and `sharedIdentityKeys`;
- the connected-characters, exclusion and historic-alias routes.

**Search (`search.create`).**

| The character's group                                 | Result                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh (`last_discovered_at` within `FRESHNESS_HOURS`) | `ready`. Nothing is reserved and the search rate limit is not spent, the same as a fresh own snapshot today.                             |
| Stale, with a discovery running in the group          | Join that run.                                                                                                                           |
| Stale, with none running                              | Reserve a full discovery from the searched character. The group's current members are shown while it runs, as a stale snapshot is today. |
| None (never discovered)                               | Unchanged: the negative cache, then Raider.IO, then a discovery from the character.                                                      |

Active runs stay one per starting character, which is today's unique index on
`discovery_runs`.

**Dossier read (`GET /api/dossiers/{character}`).**

- **Members:** the group's members, ranked and capped by
  `DOSSIER_CHARACTER_CEILING` as today.
- **URL and root:** the URL stays the opened character's, and the response's
  `root` is the opened character.
- **Labels:** the opened character's row is labelled `input`. Every other
  member's label comes from its strongest link in the group:
  1. Raider.IO-sourced (`claimed`, `declared_main`, `profile_guess`), which
     the reviewer surface already shows as Raider.IO-declared;
  2. then `fingerprint`;
  3. then manual.

  That is today's order: a snapshot's label already wins over a manual
  connection's. The reviewer surface keeps its existing three labels.

- **Research state and limitations:** the union over the members' latest
  snapshots. A limitation is phrased about the character whose discovery
  raised it, so on Eundariel's page a privacy-hidden limitation from
  Quellaria's discovery names Quellaria, not Eundariel.
- **No more borrowed view:** the `provisional` borrow and the page's
  follow-up `startResearch()` go away. A character already in a group never
  gets `discovery_not_ready`; only a character never discovered does, as today.
  The contract keeps accepting `provisional`, so an old page open during the
  deploy still parses a response, but the service stops producing it.
- **A stale group:** the read reserves or joins a discovery by the same rule as
  search.

**Evidence runs.** Unchanged. A run reserved from a read records the opened
character as `root`, meaning the page it was reserved for.

**Manual connection.**

- **Adding one:** unchanged. It writes `manual_dossier_connections` from the
  opened character and starts a full discovery rooted at the target, so the
  target's own Raider.IO alts and fingerprint matches join. The group is
  recomputed when the target's discovery publishes.
- **Removing one:** deletes the row and recomputes. The target and anything
  only connected through it leave the group, which is what removing a
  connection does to a dossier today.

**Exclusion.** Today's meaning, applied to the group rather than one dossier.

- The excluded character keeps its row, greyed and labelled, so the exclusion
  can be reversed.
- It contributes no kills, wipes, parses or Cutting Edge, raises no
  limitation, and never costs another character its place under the ceiling.
- Excluding a manually connected character leaves alone the characters its own
  discovery found.
- It changes no connection and never splits the group.

**"Not the same person" (new).** A reviewer action for a wrong link, most
likely a false fingerprint match.

- It writes a `rejected` link between the two characters and recomputes, so the
  wrong character leaves the group together with anything that was only
  connected through it.
- The rejected character is listed once on the page it was rejected from, so
  the rejection can be undone there. Undoing it deletes the rejection and
  recomputes.
- No rejections exist today, so nothing existing changes.

**Tier search.** It searches every included group member, as it searches
every included dossier character today.

**Refresh.** Unchanged: it re-collects one character's evidence, light or
full, and does not rediscover.

## Preserved behaviour

Each of these is a requirement with a check that fails the build or the
deploy, not a promise.

| #   | Requirement                                                                                                                                                                                                                                                 | Check                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1  | Every character a dossier shows today is in its root's group. A dossier today is the root's latest completed snapshot, its manual connections, and those connections' own latest snapshots.                                                                 | The migration raises an exception and rolls back if any is missing. The integration suite seeds identical, containing and manual-connection shapes and asserts the same thing. |
| P2  | No existing row is deleted or rewritten: `snapshots`, `snapshot_characters`, `discovery_runs`, `manual_dossier_connections`, `dossier_character_exclusions`, the `fingerprint_sweep_*` tables and every evidence table. No table is dropped in this change. | The migration only creates and inserts. A migration test compares row counts and checksums of those tables before and after.                                                   |
| P3  | Evidence is untouched. It stays keyed per character, and no evidence run is queued or cancelled by the migration.                                                                                                                                           | Covered by P2. The migration has no evidence side effects to test.                                                                                                             |
| P4  | Every limitation a dossier shows today is still shown on its group's page.                                                                                                                                                                                  | A unit test on the union, and an integration test with a partial snapshot inside an otherwise complete group.                                                                  |
| P5  | A member's source label never weakens. A character a dossier labels Raider.IO-declared today is never shown as fingerprint-derived.                                                                                                                         | A unit test on the label ordering.                                                                                                                                             |
| P6  | Manual connections and exclusions keep their rows and their effect. The 4 manual connections on test (none pending, none excluded) still bring in their targets.                                                                                            | Covered by P1 and P2, plus an end-to-end test that adds, excludes and removes a connection.                                                                                    |
| P7  | Where this change does alter what is shown, it only adds characters.                                                                                                                                                                                        | The replay script below reports added characters and fails on any removed one.                                                                                                 |

**Replay before switching.** `scripts/diagnostics/character-groups-replay.mts`
runs read-only against a deployment's database. For every existing root it
compares today's dossier with the root's group and prints four counts: removed
(which must be 0), unchanged, grew, and groups over `DOSSIER_CHARACTER_CEILING`.
It is run against test before the pull request merges and again after the
deploy.

On test on 2026-09-28, the same comparison run as ad hoc SQL gave:

| Result                           | Dossiers        |
| -------------------------------- | --------------- |
| Removed characters               | 0               |
| Unchanged                        | 36 of 42        |
| Grew                             | 6               |
| Largest group                    | 23 (ceiling 50) |
| Groups with more than one member | 24              |

Each of the six grows to exactly the size of the largest dossier already
existing in its group. It gains characters an existing discovery of the same
person already found, and no new combination is created.

| Root        | Today | Group | Largest existing dossier in the group |
| ----------- | ----: | ----: | ------------------------------------: |
| ryann       |     2 |    14 |                                    14 |
| yawners     |     2 |    10 |                                    10 |
| ryii        |    10 |    14 |                                    14 |
| ryrn        |    10 |    14 |                                    14 |
| mommystrike |     2 |     5 |                                     5 |
| regnii      |    22 |    23 |                                    23 |

## Migration

One Drizzle migration and its journal entry. Before numbering it, check
`origin/main` for a migration added in parallel.

1. **Create** `character_connections`, `character_groups` and
   `character_group_members`.
2. **Backfill observed links** from each root's latest completed snapshot:
   - one link per non-`input` member;
   - `source` is the member's discovery source, the root is
     `observed_from_character_id`, `discovery_run_id` is the snapshot's run, and
     `observed_at` is the snapshot's `refreshed_at`.
3. **Compute groups** with a recursive CTE over the backfilled links and every
   resolved manual connection. An excluded manual connection is included,
   because it is still shown greyed today. Every character not reached gets a
   group of its own. `last_discovered_at` is the newest `refreshed_at` among
   the group's roots, or null for a group with no discovered root.
4. **Assert P1.** A `DO` block raises an exception if any today's-dossier
   member is outside its root's group, which rolls the migration back.

Reads switch to groups in the same release. Snapshots keep being written, so a
rollback is a code revert with the new tables left in place.

## Supersedes

- **Provisional dossier membership**
  (`2026-09-26-provisional-dossier-membership-design.md`). Its borrowing of
  another root's snapshot is replaced by group membership. That covers any
  source, not only declared ones. Its `provisional` research state is no
  longer produced.
- **`CONTEXT.md`, "Known reverse declaration."** The deliberate one-hop rule
  gives way to transitive groups. Discovery still performs its reverse
  declaration lookup as today; groups make the result reachable from every
  member.
- **`CONTEXT.md`, "Excluded connection."** It is scoped to the group, not to the
  dossier it was made on. Its effect is otherwise unchanged.
- **`CONTEXT.md`, "Applicant dossier."** It stays a view of the moment and is
  never stored. What it lists is now the group.

`CONTEXT.md` gains **Group** and **Connection**, and the entries above are
edited in the same pull request.

## Error handling

- **Merge alert.** A publication that merges two groups of more than one member
  each logs `character_groups_merged` with both sizes. It also sends it to
  `MAINTAINER_ALERT_WEBHOOK_URL` when that is set, so a wrong fingerprint match
  joining two accounts is seen and can be rejected. Delivery is best effort and
  never fails the publication.
- **Recompute fails.** The whole publication rolls back, snapshot included, and
  the run takes today's retry path for a failed publication. A snapshot never
  commits without its group update.
- **Ceiling.** `DOSSIER_CHARACTER_CEILING` still caps how many characters are
  researched. A group over it shows the overflow as it does today.
- **Privacy.** The new tables hold character ids, sources, run ids and times.
  They hold no BattleTags, Discord handles, raw provider responses or request
  URLs. Dossier responses stay `Cache-Control: no-store`.

## Testing

Fixtures only, with no live Raider.IO, Blizzard or Warcraft Logs traffic.

- **Unit.** Group recomputation covers:
  - merges;
  - a split on a rejection, including what leaves with the rejected character;
  - a split on a retraction;
  - a partial run never retracting;
  - a Raider.IO-only run leaving fingerprint links alone;
  - the id-survival rule;
  - the label ordering (P5) and the limitation union (P4).
- **Integration (PostgreSQL).**
  - A reader never observes a half-recomputed group while a publication is in
    flight.
  - Two concurrent publications merging the same groups produce one group.
  - A failed recompute rolls the snapshot back with it.
  - The migration backfills seeded snapshots shaped like test's (identical,
    containing, manual) into the expected groups. It passes P1, and fails when a
    member is deliberately made unreachable.
  - P2's row-count and checksum comparison.
- **End to end.**
  - Opening a member of a fresh group shows the same list and queues no
    discovery.
  - A stale group reserves exactly one discovery.
  - A manual connection shows on every member's page.
  - An exclusion greys the character on every member's page and is reversible.
  - "Not the same person" removes the character and is reversible.

## Out of scope

- Reusing one fingerprint sweep across siblings on the same roster (#719).
- Collecting evidence for every new member when it joins, rather than when a
  read reaches it.
- Expiring links that nobody has re-observed.
- Dropping snapshots, `manual_dossier_connections` or
  `dossier_character_exclusions`.
