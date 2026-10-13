# Linking the characters in each application, and polling every minute

**Status (2026-10-13): proposed.** Nothing here is built. It went through one
design review with the Manager before being written; this spec folds in that
review's findings and the maintainer's answers to it.

## Problem

At 10:45:40 UTC on 2026-10-13, the applicant sheet watcher on test read one
application listing two characters: eu/hyjal/tropipe and eu/hyjal/tropicos. It
queued intake for each, and nothing else. At 10:46:03 a reviewer opened
Tropipe's dossier and added Tropicos as a connected character by hand.

The watcher never writes `manual_dossier_connections`, and it has no idea of an
application. Its intents are per identity, from occurrence counts. Two
characters from one row share nothing but a timestamp. So every multi-character
application needs a reviewer to repeat by hand what the applicant already told
us.

Separately, the watcher is slower than its setting suggests. It is configured
to poll every 5 minutes, but on test it polls about every 10 (12:05, 12:15,
12:25, 12:35 …, with the odd 5-minute gap), and the setting can't go lower
anyway.

This spec covers two changes, shipped in this order:

1. **Poll every minute.** A small, separate pull request.
2. **Link each application.** The watcher records which characters arrived
   together, then links them once the root character exists.

## Decisions

The maintainer decided:

- **Root.** The first character link in the cell is the root. Every other
  character in that row connects to it (root → member), as the reviewer did by
  hand. "First" means the first accepted candidate after parsing and
  de-duplication.
- **Scope.** New applications only. Baselines and re-baselines record nothing,
  as now. An ops backfill script is a possible follow-up, not part of this.
- **Resubmission.** If a reviewer removes a link the watcher made, and the
  applicant later submits a new application with the same characters, the link
  is added again. A fresh application is new evidence. Exclusions persist,
  because re-adding an existing row does not clear `excluded_at`. Removals
  don't persist, because Remove deletes the row. Reviewers who want a link to
  stay gone should Exclude it.
- **The link column holds free text.** The form question asks for a Raider.IO
  link but accepts free text. Usually it holds the applicant's own characters,
  but references, a partner or an officer can appear. That's why the
  safeguards below exist.
- **Label.** Links from applications carry an origin, and the dossier labels
  them "From application", not "Manually added".

## Change 1: poll every minute

### Why the setting alone doesn't work

- `APPLICANT_POLL_CADENCE_MS` is 300,000 on test, which is also the minimum
  `config.ts` accepts (300,000 to 3,600,000).
- The watcher tick runs only inside `scheduleEvidenceResume`, a pg-boss cron
  at `*/5 * * * *`. Nothing can poll more often than that.
- The due check, `Date.now() - last_polled_at >= cadenceMs`, compares against
  a `last_polled_at` stamped inside `reconcileApplicantCounts`, *after* the
  Sheets read. When the cadence equals the cron period, a tick whose start is
  earlier than the previous read's duration falls just short and skips a
  whole period. That is the 10-minute spacing on test.

### Design

- **Its own schedule.** Add an `applicant-sheet-tick` pg-boss queue on
  `* * * * *` (one minute is the finest pg-boss cron goes), with
  `policy: 'singleton'`, `expireInSeconds: 300` and `retryLimit: 0`. The
  evidence-resume sweep stays on `*/5` and no longer calls the watcher.
  Singleton stops two replicas, or the old and new worker during a deploy,
  from running overlapping ticks.
- **Due check.** Stamp `last_polled_at` with the poll's start time (pass
  `now` into `reconcileApplicantCounts`), and treat a poll as due when
  `elapsed >= cadenceMs - 15_000`.
- **Minimum.** Lower the `APPLICANT_POLL_CADENCE_MS` minimum to 60,000, and
  set it to 60,000 on test after deploy (with the maintainer's go-ahead).
- **Points probe.** `drainApplicantIntents` calls `getRateLimit()`, which
  costs 1 WCL point, on every tick with waiting intents. Each minute, that
  would be 60 points an hour, spent while the points gate is blocking. After
  a blocked probe, skip the probe and the drain for 5 minutes. The Warcraft
  Logs id suppression check in the poll gets the same cache.
- **Failure alert.** Today it fires after 3 consecutive failures, which at 5
  minutes means about 15–30 minutes. Each minute, 3 failures is only about 6
  minutes. Fire instead when polls have failed continuously for 15 minutes or
  more. The back-off keeps its shape (cadence × 2^n, capped at 1 hour), so
  from a 1-minute base: 2, 4, 8, 16 minutes.
- **Token caching.** With a service account, the client mints a fresh OAuth
  token on every read. Cache it until 60 s before it expires. At 1,440 reads
  a day, Sheets quota is not a concern either way.

### Effect

A new application gets intake within about a minute. Admissions also drain
each minute. Their limits don't change (5 per day, 1 per tick, the points
gate), so they start sooner but no more of them run.

### Tests and docs

- `config.test.ts`: accepts 60,000 and rejects 59,999.
- Watcher tests: the due check with start-time stamping and tolerance; a
  blocked allowance skips the probe for 5 minutes; the time-based failure
  alert; token reuse until near expiry.
- Queue test: the new schedule is registered once, as a singleton.
- Update `.env.example` and `docs/operations/applicant-sheet-watcher.md` for
  the new cadence, the new schedule and the alert threshold.

## Change 2: link each application

### Data model (migration 0074)

`manual_dossier_connections` gains:

- `origin text NOT NULL DEFAULT 'dossier'`, with
  `CHECK (origin IN ('dossier', 'applicant_sheet'))`.
- `applicant_application_id uuid NULL`, referencing
  `applicant_source_applications(id) ON DELETE SET NULL`.

New tables:

- `applicant_source_applications`: `id uuid`, `source`, `root_intent_sequence
  bigint UNIQUE` (FK to `applicant_source_intents`), `root_identity`,
  `submitted_at` (the form response's timestamp), `created_at`, `settled_at`
  (when the root intent reached `done` or `suppressed`), `last_checked_at`,
  `closed_at`, and count columns per outcome. An index on `(root_identity,
  submitted_at)` supports the selection rule below.
- `applicant_source_application_members`: `application_id`, `ordinal`,
  `identity`, `outcome` (NULL while waiting).

Member rows are deleted when their application closes. Only the counts stay,
so the database doesn't keep a lasting record of which characters were
submitted together. Links already written keep their `applicant_application_id`
until the application row is deleted.

Both tables hold only the identity strings `applicant_source_intents` already
holds (`character:[…]` and `warcraftlogs_id:N`), plus timestamps. No BattleTags,
Discord ids, names, URLs or raw cells.

The new tables reference `applicant_source_intents`, so the doc's new-baseline
procedure must clear them first.

### Which row an application comes from

The poll knows rows, but `reconcileApplicantCounts` only knows counts. The
watcher maps a new occurrence back to a row by occurrence index, which is
wrong after a sort or insertion. That's acceptable for an alert, but not for
a write. Consider a character that is a reference in Bob's row and the first
link in its owner's new row. After a sort, the index can land on Bob's row,
and his characters would be linked to it.

So the application doesn't use the occurrence index. It uses the form's own
timestamp:

- The poll also reads `'Form Responses'!A2:A` (the Forms timestamp), as a
  separate request with `valueRenderOption=UNFORMATTED_VALUE` and
  `dateTimeRenderOption=SERIAL_NUMBER`. It can't share the existing batchGet:
  that request uses `FORMATTED_VALUE`, and switching it would turn an
  18-digit Discord id into a lossy double. If the two reads return different
  row counts, the poll records intents as usual but no applications, and
  counts `applications_skipped_read_mismatch`.
- When an intent is inserted for identity X, the candidate rows are those
  where X is the **first** link and the timestamp is later than the
  `submitted_at` of X's newest existing application, or any row at all if X
  has none.
  - **Exactly one candidate:** record an application from that row.
  - **None:** record nothing. The new occurrence came from another position,
    such as a reference in someone else's row.
  - **Several** (two submissions in one poll): use the newest, and count the
    rest as `applications_ambiguous`.
- A Forms edit that adds links to an existing row doesn't change that row's
  timestamp, so it never creates an application.
- A deferred root intent, inserted in a later poll, applies the same rule to
  that poll's read.

The application is written in the intake transaction, using
`RETURNING sequence` from the intent insert. `pollApplicantSheet` threads the
per-row candidate lists and timestamps through to
`reconcileApplicantCounts`. A row with a single link records nothing.

### Safeguards at intake

- **Cap.** A row with more than 5 accepted links (the root plus 4) records an
  application with no members, closed at once, and counts `over_cap`. Nothing
  is linked.

### The linking step

The linking step runs at the end of each watcher tick, after the drain. It
makes no provider calls, so the points gate doesn't apply to it. Its
selection:

- Open applications whose root intent is settled (`done` or `suppressed`).
- Ordered by `last_checked_at`, so waiting applications don't starve newer
  ones.
- At most 50 per tick.
- `FOR UPDATE SKIP LOCKED`.

For each application:

1. **Root suppressed.** If the root intent is `suppressed`, or
   `suppressions.isActive(rootKey, now)` is true, close the application with
   every member `suppressed`.
2. **Root key.** Decode the root intent's `canonical_identity` with
   `decodeApplicantIdentity`; it's a `character:[…]` string, not a
   `CharacterKey`.
3. **Root exists.** Check for the character by key, and wait if it isn't
   there. `done` means discovery was queued, not that it has finished. The
   check must be explicit, because `manualConnections.add` returns
   `duplicate` both for an existing link and for a missing root.
4. **Each member without an outcome:**
   - **Resolve its key.** A character identity is its own key. A Warcraft Logs
     id resolves through the newest `done` intent for that identity, which
     follows renames. If there isn't one yet, wait. The step never calls
     `resolveCharacterById`.
   - **`suppressed`:** the member's intent is suppressed, or
     `suppressions.isActive(memberKey, now)` is true. Check live, because a
     character member may have no intent yet.
   - **`same_character`:** the canonical identity equals the root's.
   - **`skipped_region`:** a different region from the root.
   - **`skipped_excluded`:** the root's dossier has excluded this character,
     manually or as a discovered link.
   - **`skipped_cross_group`:** the member already belongs to a multi-member
     character group other than the root's. Merging two established groups is
     always a reviewer's call. This makes the linking step the first reader of
     the phase 1 `character_groups` tables. A member with no group yet (not yet
     discovered) is not skipped.
   - **`linked`:** otherwise, call `manualConnections.add` with origin
     `applicant_sheet` and the application id. Record `linked` whether the
     result is `added` or `duplicate`.
5. **Close** the application when every member has an outcome.

**Expiry.** Seven days after `settled_at`, remaining members become `expired`
and the application closes. The clock starts at settlement, not creation,
because admissions run FIFO at 1 a tick and 5 a day, so a burst of
applications can wait days for its root to be admitted.

**Idempotence.** The add and the member update aren't one transaction. The
step adds first and marks second, so a crash between them repeats an add that
`ON CONFLICT` makes harmless.

**Logging.** Each tick emits one count-only event:
`applicant_links { linked, waiting, suppressed, same_character,
skipped_region, skipped_excluded, skipped_cross_group, expired }`. A failure
in the step is logged and never fails the drain.

Members marked `linked` are never revisited, so a reviewer's removal holds
until the applicant submits again.

### Origin and the reviewer's add

- **Worker add:** `INSERT … origin = 'applicant_sheet' … ON CONFLICT DO
  NOTHING`. An existing reviewer link stays a reviewer link.
- **Web add:** `ON CONFLICT DO UPDATE SET origin = 'dossier',
  applicant_application_id = NULL`. A reviewer adding a link the worker
  already made turns it into a reviewer link. It keeps `excluded_at`
  unchanged.
- **Dossier:** connections with origin `applicant_sheet` read as a new
  `source: "applicant_added"`, labelled "From application". Everything else
  that treats manual connections today (pending rows, exclusion, removal,
  groups) treats these the same way.
- **CONTEXT.md:** extend **Manual connection** to say a connection can come
  from an application. It's still not an ownership claim, and it's labelled
  separately.

### The arrival alert

Today's alert fires once per new link occurrence, so a 4-link row sends 4
alerts. Change it to one alert per application: the applicant details as
now, the root's dossier URL, and "N other characters listed; they'll be
linked once checks pass". A row that records no application (one link, or no
root match) keeps the current per-occurrence alert. There is no second alert
when links are written.

### Character groups

- Rows the worker writes are ordinary manual connections. The replay counts
  them as `manual_added`.
- Web adds don't trigger a group recompute, and neither do these. The hourly
  maintenance cycle picks them up. Until then the replay shows `drift_pending`,
  which doesn't fail it.
- A burst of links during the phase 1 exit run would add `manual_added`
  coverage and pending drift. So linking ships behind
  `APPLICANT_LINKING_ENABLED` (default `false`). It is switched on outside
  that run, or with a note beside the run's counts.

### Tests

**Intake**
- One application with its members in cell order.
- None for single-link rows, baselines or re-baselines.
- None when the new occurrence isn't a first link.
- The newest of two first-link rows is chosen, and the other is counted as
  ambiguous.
- A sorted sheet still picks the right row.
- A read-count mismatch records intents but no applications.
- A deferred root records its application in the later poll.
- Over-cap rows record no members.

**The linking step**
- Waits for an unsettled root, then for an undiscovered one.
- Links character members with `origin = 'applicant_sheet'`.
- Waits for, then links, a Warcraft Logs id member through its newest `done`
  intent.
- Covers a suppressed root, an intent-suppressed member and a live-suppressed
  member.
- Covers `same_character`, `skipped_region`, `skipped_excluded` and
  `skipped_cross_group`.
- A repeated add is idempotent.
- Expiry runs from `settled_at`.
- Member rows are deleted on close.
- Skip-locked selection and `last_checked_at` ordering.

**Origin**
- A web add over a worker link becomes `dossier` and keeps `excluded_at`.
- A worker add over a reviewer link leaves it unchanged.
- The dossier shows "From application".

**Resubmission**
- After a reviewer removes a worker link, a new application links it again.
- After a reviewer excludes one, the link stays excluded.

**Alert**
- One alert per application, with the root's dossier URL and the member count.

### Docs

`docs/operations/applicant-sheet-watcher.md`:
- It says the watcher only starts discovery and evidence. Describe the
  linking, its safeguards and the flag.
- Extend the "only … stored" list with the application tables, and note that
  their members are deleted on close.
- Add the new tables to the new-baseline procedure.
- Note the extra column A read.

Also update CONTEXT.md, as above.

## Out of scope

- A backfill for applications already in the sheet.
- Remembering a reviewer's removal (a tombstone). The maintainer chose
  re-linking on resubmission.
- Admin Settings controls for the watcher.
