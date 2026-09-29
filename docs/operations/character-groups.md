# Character groups (phase 1)

## What phase 1 is

The worker writes character groups best effort, alongside its existing
publications. Nothing reads them yet: no dossier page, no search result and no
API response is affected by what this phase writes. The replay
(`ops:replay-groups`) is the gate that decides whether phase 2 can begin
reading them. It reconciles the stored ledger and groups against a fresh,
independent read of today's dossiers, and fails loudly rather than silently
passing bad data forward.

## Reaching the test database

`ops:rebuild-groups` and `ops:replay-groups` are repository commands that run
on the maintainer's machine, so, exactly as
[`docs/operations/removals.md:9-21`](removals.md) describes for `ops:removals`,
they need a `DATABASE_URL` that resolves from outside Railway's network:

```bash
railway link
export DATABASE_URL="$(railway variables list --service Postgres --environment test --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p')"
test -n "$DATABASE_URL" || echo "enable the Postgres TCP proxy for this environment first"
```

Run `unset DATABASE_URL` when the operation is finished, and never paste the
value into a file, an issue, or the operations log.

Before any replay, export the web's `DOSSIER_CHARACTER_CEILING` too. The
replay compares pages against the ceiling the web applies, and without the
variable it uses the default, 50, whatever the web is set to:

```bash
ceiling="$(railway variables list --service web --environment test --kv | sed -n 's/^DOSSIER_CHARACTER_CEILING=//p')"
if [ -n "$ceiling" ]; then export DOSSIER_CHARACTER_CEILING="$ceiling"; else unset DOSSIER_CHARACTER_CEILING; fi
```

When the web does not set it, it uses the same default, so leaving it unset
is then correct.

The replay's pool opens every session with
`default_transaction_read_only=on`, so neither its audit read nor its reads of
today's pages can write.

## Before the deploy

Check the number of groups on test. Every character has a group of its own,
and each maintenance step recomputes one group in about 15 round trips, so a
cycle that needs more than one hourly pass lengthens the drift bound (see
[`drift_pending` versus `drift_stale_pending`](#drift_pending-versus-drift_stale_pending)).
Once the migration has run, `SELECT count(*) FROM character_groups` gives the
number; before it, `SELECT count(*) FROM characters` is the same. Note it
beside the first replay, so a later cycle length can be read against it.

## After the deploy

1. Confirm the worker and web are both on the phase 1 commit
   (`railway deployment list -s worker -e test`), with no older worker still
   running.
2. Run `corepack pnpm ops:rebuild-groups --confirm <host>` once, when test is
   quiet, where `<host>` is the test database's host. Run without `--confirm`
   first: the script names the host `DATABASE_URL` points at, never the URL or
   its password, and refuses to run. Check that it is test's host, then run it
   again with `--confirm` and that host. This step
   is load-bearing, not a convenience: the replay's ledger checks only cover
   the window starting at the newest `backfill`/`rebuild` ledger row. The
   migration's backfill runs at deploy, but an older worker can still finish
   a run or a sweep cycle after it. That publication writes no ledger row and
   no observations, so the replay reports it as a lost write under check (a),
   and its new members fail check (b). The rebuild re-derives every observer
   from its latest snapshot and moves the window start past those
   publications. Skip this step and the first replays fail on writes the
   phase 1 worker never saw. The three-day window starts from this rebuild's
   `written_at`.
3. Run `corepack pnpm ops:replay-groups`, with the ceiling exported as
   above, and keep its JSON. Its `windowStart` should be the rebuild's time,
   and `publicationsChecked` counts the publications check (a) looked at: a
   replay run just after a rebuild checks almost nothing, and says so.

## Daily

Run the replay, and search the worker logs for
`character_groups_write_failed`. `railway logs` returns at most 5,000 lines
per call, so read each worker deployment's logs by id and page through the
day with `--since` and `--until`:

```bash
railway logs <deployment-id> -s worker -e test --json -n 5000 --since <ISO> --until <ISO>
```

in 30-minute slices, filtering the `--json` lines (one object per line, with
`event` among the fields) in a small script rather than by grepping text.

Each `character_groups_write_failed` record carries a `stage`:

- `stage: "write"` is a lost observation write, which the replay's ledger
  checks cannot explain. It restarts the three days.
- `stage: "recompute"` is a group recompute that failed after its write
  committed, or a maintenance pass that failed. No write was lost: the next
  maintenance cycle recomputes the groups it missed. It does not restart the
  three days on its own. A recompute that never heals shows up in the replay
  as `drift_stale_pending`, which does.

A replay failure, a `stage: "write"` record, or an `a_completeness` finding
means: fix the cause, rebuild, and restart the three days.

Before treating a lone `removed` failure as a restart, run the replay once
more. A continuation or seal amends its snapshot in place, keeping its id, so
one that commits between the replay's audit read and its page reads can show
a false `removed` that `page_moved` does not catch. A `removed` that survives
the second run is real.

## Triggering each risky path

Each path needs at least one publication in the window, and the replay's
`coverage` shows which appeared:

- **A first sweep cycle.** Search, on the test site, a character that has
  never been swept (no `fingerprint_sweep_states` row). This writes both
  families in one ledger write: a Raider.IO row and a fingerprint row.
  Coverage: `sweep_publication` and `sweep_first_cycle` (from the fingerprint
  row), plus that row's own reason, `matched` or `capped`.
- **A capped sweep, a continuation and a seal.** Search a character whose
  guild roster exceeds `BLIZZARD_SWEEP_REQUEST_CAP` (300), such as one in a
  large guild. Cycle 1 publishes reason `capped` (coverage: `capped`,
  `sweep_publication`, `sweep_first_cycle`). The admission worker then runs
  continuation cycles, each also reason `capped` (coverage: `capped`,
  `sweep_publication`, `sweep_continuation`), until a cycle reads to the end
  of the roster: the seal. Coverage adds `sweep_seal` alongside
  `sweep_continuation`. A seal is recognised by its reservation, which
  published without the `fingerprint_sweep_capped` limitation, not by its
  ledger reason: a seal is usually `matched` or `unread`, but it is
  `skipped_guild` when its chain skipped a guild, and `blocked_by_newer` when
  a newer run holds the observer, while a capped cycle that skipped a guild
  is also `skipped_guild`. Watch the admission logs for
  `fingerprint_admission` records.
- **A live-sweep completion.** More than `FRESHNESS_HOURS` (24 h) after the
  capped search above, while its chain is still continuing, search the same
  character again. The run completes against the live snapshot, writing a
  Raider.IO-only, no-reservation row. Coverage: `live_sweep_completion` only
  — it carries no `sweepReservationId`, so it never counts towards
  `sweep_publication`.
- **A `not_due` refresh.** Search a character swept within the last 7 days
  whose dossier is over 24 hours old; for example, repeat a first-cycle
  search the next day. Coverage: `not_due_refresh`, alongside the row's own
  reason, `raiderio_complete`, `raiderio_limited` or `privacy_hidden`.
  `not_due_refresh` counts a Raider.IO row, other than a baseline or a
  live-sweep completion, from a run with no fingerprint row, whose observer
  has an earlier fingerprint row. It can therefore also count another
  Raider.IO-only run of a root that was swept before, not only a `not_due`
  refresh, so confirm the path from the `fingerprint_admission` records in
  the admission logs.
- **A privacy-hidden run.** Search a character with no public Raider.IO
  claim, such as one whose dossier today reads "Raider.IO shows no public
  account claim". Coverage: `privacy_hidden`.
- **Manual connection add and remove.** On any dossier page, add a connected
  character, and later remove one. The add shows in coverage as
  `manual_added`; the remove leaves no ledger trace and instead must be
  checked by hand, in the replay's `drift_manual` report rather than in
  `coverage`. `drift_manual` is a stored group coarser than the links now
  justify, across characters no published snapshot ever showed one of them
  observing the other. A coarser group across a pair some snapshot did
  show is a missed split, and fails as `drift`. A live-sweep completion
  never publishes a snapshot of its own, so a pair only it observed sits
  outside snapshot history, and a missed split between such a pair reports
  as `drift_manual`; closing that gap needs pair ids on the ledger, which is
  deferred. Check that the next
  maintenance cycle's `character_groups_recompute` record appears for both
  changes, and that the replay shows no failing drift.

## Exit criteria

From the spec:

- three consecutive days of passing replays;
- no failing drift (`drift` or `drift_stale_pending`) after each completed
  cursor cycle, and no `maintenance_stale` — `drift_pending` and
  `drift_manual` are reports, not failures, and do not block on their own;
- no `character_groups_write_failed` with `stage: "write"`, and no
  `a_completeness` finding — a `stage: "recompute"` record heals through the
  maintenance cycle and blocks only if the replay then reports
  `drift_stale_pending`;
- every path above appears in `coverage`;
- the integration suite passing.

### `drift_pending` versus `drift_stale_pending`

`drift_pending` is expected and reported, not failed: a stored group can
lag its trigger while the recompute catches up. The trigger is a member's
earliest write that no completed cycle covers, an ungrouped character's
creation, or the earliest manual change no completed cycle covers. Taking
the earliest uncovered write, not the newest, means a group written every
hour still goes stale.

The bound is `max(2 h, 1 h + 2 × (lastCycleCompletedAt − lastCycleStartedAt))`,
or 2 h before any cycle has completed. The measured cycle length is clamped
to 6 h, so the bound is at most 13 h: a cycle that straddled a worker outage
measures the outage too, and must not mask the next stall. A maintenance pass completes at most
two cycles: it stops at the first completed cycle that began during it. So
a trigger that lands just after a cycle starts can wait up to an hour for the
next pass, then for the current cycle and a covering one. Once a pending
arm's trigger is older than the bound, the replay reports it instead as the
failure `drift_stale_pending`, naming the bound in minutes. That means the
maintenance recompute is not completing its cycles. Check the worker's
`character_groups_recompute` records for whether cycles are starting,
finishing, and finishing inside their budget.

### `maintenance_stale`

The replay fails `maintenance_stale` when no maintenance cycle has completed
within the same bound, measured from the later of `windowStart` and
`lastCycleCompletedAt`. Both times, and `lastCycleStartedAt`, are in the
replay's JSON. With no cycle completed, drift is never judged, so without
this check a maintenance pass that throws every time would pass the replay.
Check the worker's `character_groups_write_failed` records with
`stage: "recompute"`, and the `character_groups_recompute` records, for why
cycles stopped completing.

### `page_moved`

The replay reads today's pages after its own consistent read of the groups.
A page whose root published a new snapshot in between is skipped and reported
as `page_moved`, and counted in `movedPages` rather than `pages`: it is not a
failure, and the next replay compares it.

## Log records

- `character_groups_recompute` with `groupsRecomputed`, `cycleCompleted`,
  `cyclesCompleted`, `mergedGroups` and `durationMs`. `cyclesCompleted` is
  0, 1 or 2: a pass finishes the cycle already in progress, and stops at the
  first completed cycle that began during it;
- `character_groups_merged` with `mergedGroups` and `stage` (`publication`
  from the handler's recompute, or `maintenance` from the pass), when a
  recompute joins two or more groups that each had more than one member.
  `mergedGroups` counts the recomputed groups that did. It is logged only,
  with no webhook, and counts merges through manual links as well as
  observed ones;
- `character_groups_write` with `unknownCharacters`;
- `character_groups_write_failed` with `stage` (`write` or `recompute`),
  `errorName`, and `errorCode` when there is a safe one: the PostgreSQL
  SQLSTATE (`55P03` is a lock timeout), or the repository's own error code.
  The maintenance pass adds `durationMs`.

## Rollback

Revert the code. The tables go stale, and nothing reads them. After a
roll-forward, rebuild and restart the three days.

Reverting the code does not revert the migration. 0069, with `when`
1792011600020, stays applied, and Drizzle skips any migration whose `when` is
not strictly greater than the newest applied one. So a later migration added
on the reverted tree must take a `when` strictly greater than 1792011600020.
Following the usual +1 convention from the reverted tree's newest migration
(0068_raiderio_vantus_null, `when` 1792011600019) would give it 1792011600020
exactly, and Drizzle would skip it silently.
