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

## After the deploy

1. Confirm the worker and web are both on the phase 1 commit
   (`railway deployment list -s worker -e test`), with no older worker still
   running.
2. Run `corepack pnpm ops:rebuild-groups` once, when test is quiet. This step
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
3. Run `corepack pnpm ops:replay-groups`, and keep its JSON.

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
  `sweep_publication`, `sweep_continuation`), until a cycle ends `matched` or
  `unread` — the seal (coverage adds `sweep_seal` alongside
  `sweep_continuation`). Watch the admission logs for `fingerprint_admission`
  records.
- **A live-sweep completion.** More than `FRESHNESS_HOURS` (24 h) after the
  capped search above, while its chain is still continuing, search the same
  character again. The run completes against the live snapshot, writing a
  Raider.IO-only, no-reservation row. Coverage: `live_sweep_completion` only
  — it carries no `sweepReservationId`, so it never counts towards
  `sweep_publication`.
- **A `not_due` refresh.** Search a character swept within the last 7 days
  whose dossier is over 24 hours old; for example, repeat a first-cycle
  search the next day. Coverage: `raiderio_complete` or `privacy_hidden` on a
  run with no fingerprint row.
- **A privacy-hidden run.** Search a character with no public Raider.IO
  claim, such as one whose dossier today reads "Raider.IO shows no public
  account claim". Coverage: `privacy_hidden`.
- **Manual connection add and remove.** On any dossier page, add a connected
  character, and later remove one. The add shows in coverage as
  `manual_added`; the remove leaves no ledger trace and instead must be
  checked by hand, in the replay's `drift_manual` report (a coarser stored
  group than the links now justify) rather than in `coverage`. Check that the
  next maintenance cycle's `character_groups_recompute` record appears for
  both changes, and that the replay shows no failing drift.

## Exit criteria

From the spec:

- three consecutive days of passing replays;
- no failing drift (`drift` or `drift_stale_pending`) after each completed
  cursor cycle — `drift_pending` and `drift_manual` are reports, not
  failures, and do not block on their own;
- no `character_groups_write_failed` with `stage: "write"`, and no
  `a_completeness` finding — a `stage: "recompute"` record heals through the
  maintenance cycle and blocks only if the replay then reports
  `drift_stale_pending`;
- every path above appears in `coverage`;
- the integration suite passing.

### `drift_pending` versus `drift_stale_pending`

`drift_pending` is expected and reported, not failed: a stored group can
lag its trigger (a member's newest write, an ungrouped character's creation,
or a manual change) for up to two hourly maintenance intervals while the
recompute catches up. Once a pending arm's trigger is more than two hours
old, the replay reports it instead as the failure `drift_stale_pending`.
That means the maintenance recompute is not completing its cycles — check
the worker's `character_groups_recompute` records for whether cycles are
starting, finishing, and finishing inside their budget.

### `page_moved`

The replay reads today's pages after its own consistent read of the groups.
A page whose root published a new snapshot in between is skipped and reported
as `page_moved`, and counted in `movedPages` rather than `pages`: it is not a
failure, and the next replay compares it.

## Log records

- `character_groups_recompute` with `groupsRecomputed`, `cycleCompleted` and
  `durationMs`;
- `character_groups_write` with `unknownCharacters`;
- `character_groups_write_failed` with `stage` (`write` or `recompute`) and
  `errorName`, plus `durationMs` when the maintenance pass logs it.

## Rollback

Revert the code. The tables go stale, and nothing reads them. After a
roll-forward, rebuild and restart the three days.
