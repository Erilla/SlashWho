# Linking the characters in each application, and polling every minute

**Status (2026-10-13): proposed, revision 3.** Nothing here is built. The
design went through one review with the Manager before being written. This
revision folds in its reviews of the written drafts (38bb2789 and cf2e9d6e),
plus the maintainer's answers.

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
   together, then links them once they exist and pass the checks below.

## Decisions

The maintainer decided:

- **Root.** The first character link in the cell is the root. Every other
  character in that row connects to it (root → member), as the reviewer did by
  hand. "First" means the first accepted candidate after parsing and
  de-duplication.
- **Scope.** New applications only. Rows submitted before the watcher's
  high-water mark never become applications (see
  [Which row an application comes from](#which-row-an-application-comes-from)).
  An ops backfill script is a possible follow-up, not part of this.
- **Resubmission.** If a reviewer removes a link the watcher made, and the
  applicant later submits a new application with the same characters, the link
  is added again. A fresh application is new evidence. Exclusions persist:
  re-adding an existing row does not clear `excluded_at`, and the linking step
  skips a pair either dossier has excluded. Removals don't persist, because
  Remove deletes the row. Reviewers who want a link to stay gone should
  Exclude it.
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
  a `last_polled_at` stamped inside `reconcileApplicantCounts`, _after_ the
  Sheets read. When the cadence equals the cron period, a tick whose start is
  earlier than the previous read's duration falls just short and skips a
  whole period. That is the 10-minute spacing on test.

### Design

- **Its own schedule.** Add an `applicant-sheet-tick` pg-boss queue on
  `* * * * *` (one minute is the finest pg-boss cron goes), with
  `policy: 'stately'`, `expireInSeconds: 300` and `retryLimit: 0`. The
  evidence-resume sweep stays on `*/5` and no longer calls the watcher.
  `stately` allows at most one active job and one queued job. So two
  replicas, or the old and new worker during a deploy, can't run overlapping
  ticks, and cron jobs don't pile up behind a slow tick. (`singleton` limits
  only active jobs.)
- **Due check.** Stamp `last_polled_at` with the poll's start time (pass
  `now` into `reconcileApplicantCounts`), and treat a poll as due when
  `elapsed >= cadenceMs - 15_000`.
- **Minimum.** Lower the `APPLICANT_POLL_CADENCE_MS` minimum to 60,000, and
  set it to 60,000 on test after deploy (with the maintainer's go-ahead).
- **Points probe.** `drainApplicantIntents` calls `getRateLimit()`, which
  costs 1 WCL point, on every tick with waiting intents. Each minute, that
  would be 60 points an hour, spent while the points gate is blocking. After
  a blocked probe, skip the probe and the drain for 5 minutes, in memory per
  process. The Warcraft Logs id suppression check in the poll shares that
  cache.
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
- Queue test: the new schedule is registered once, with the `stately` policy.
- Update `.env.example` and `docs/operations/applicant-sheet-watcher.md` for
  the new cadence, the new schedule and the alert threshold.

## Change 2: link each application

### Data model (migration 0074)

The migration is `0074`, journal idx 73, with a `when` greater than 1792011600024. It creates the new tables first, then adds the column that
references them.

New tables:

- `applicant_source_applications`:
  - `id uuid`, `source`
  - `root_intent_sequence bigint UNIQUE` (FK to `applicant_source_intents`)
  - `root_identity`
  - `submitted_serial double precision`: the form response's raw
    column-A serial number, with no time-zone conversion
  - `created_at`
  - `settled_at`: when the root intent reached `done` or `suppressed`
  - `last_checked_at`, `closed_at`
  - one count column per outcome
  - an index on `(root_identity, submitted_serial)`
- `applicant_source_application_members`: `application_id`, `ordinal`,
  `identity`, `member_intent_sequence bigint NULL`, `outcome` (NULL while
  waiting).

`applicant_source_state` gains `submitted_serial_mark double precision NULL`,
the high-water mark described below.

`manual_dossier_connections` gains:

- `origin text NOT NULL DEFAULT 'dossier'`, with
  `CHECK (origin IN ('dossier', 'applicant_sheet'))`. A constant default is
  metadata-only on PostgreSQL 11 and later, so existing rows need no
  backfill.
- `applicant_application_id uuid NULL`, referencing
  `applicant_source_applications(id) ON DELETE SET NULL`.

**Retention.**

- Member rows are deleted when their application closes. Only the counts
  stay, so the database doesn't keep a record of which characters were
  submitted together.
- An application still open 30 days after `created_at` closes with every
  remaining member `expired`. This covers roots that never settle, such as a
  Warcraft Logs id that never resolves.
- Closed application rows, with their `root_identity`, `submitted_serial` and
  counts, are deleted 30 days after `closed_at` by the hourly maintenance
  cleanup.
- Deleting an application sets `applicant_application_id` to NULL on its
  links. The links stay, with `origin = 'applicant_sheet'`.

**Privacy.** Both tables hold only the identity strings
`applicant_source_intents` already holds (`character:[…]` and
`warcraftlogs_id:N`), plus timestamps and a form serial. No BattleTags,
Discord ids, names, URLs or raw cells. `submitted_serial` records the same
moment `observed_at` already records, to within a minute.

**Resets.** The new tables reference `applicant_source_intents`, so the doc's
new-baseline procedure must clear them first.

### Which row an application comes from

The poll knows rows, but `reconcileApplicantCounts` only knows counts. The
watcher maps a new occurrence back to a row by occurrence index, which is
wrong after a sort or insertion. That's acceptable for an alert, but not for
a write. Consider a character that is a reference in Bob's row and the first
link in its owner's new row. After a sort, the index can land on Bob's row,
and his characters would be linked to it.

So applications don't use the occurrence index. They use the form's own
timestamp, as a raw serial, against a high-water mark.

**Reading column A.**

- After the existing batchGet, the poll makes a second request: a batchGet
  of `'Form Responses'!A2:A` and the link column, with
  `valueRenderOption=UNFORMATTED_VALUE` and
  `dateTimeRenderOption=SERIAL_NUMBER`. It can't reuse the first batchGet:
  that request uses `FORMATTED_VALUE`, and switching it would turn an
  18-digit Discord id into a lossy double. Unformatted makes no difference to
  the text in link cells.
- Serials are compared only with each other and never converted to UTC, so
  the spreadsheet's time zone and daylight saving don't matter.
- **Aligning the reads.** The link column from the second request must match
  the first request's link column, cell for cell.
  - The second read may have extra rows at the end, appended by Forms
    between the reads. Drop them.
  - Any other difference fails the whole poll without advancing any state,
    exactly as for a read error, and the poll retries on the next tick. That
    covers a deletion, a sort, and a deletion plus an append between the
    reads.

**The high-water mark.**

- `applicant_source_state.submitted_serial_mark` is the largest column-A
  serial seen at the end of the last successful poll.
- The baseline poll and each re-baselining poll set it without recording
  applications.
- **First poll after deploy.** The column starts NULL. A poll that finds the
  mark NULL only sets it: it records no applications and sends
  per-occurrence alerts as today, like a baseline that still admits intents.
- When an occurrence is first seen, it carries the mark as it stood at the
  start of that poll. A deferred occurrence stores that mark in its
  `deferred_observed_ats` entry, beside its time and index.
- **Older deferred entries.** Entries written before the deploy (a bare
  timestamp string, or `{at, index}`) carry no mark. When inserted, they
  record no application and get a per-occurrence alert, as today.

**Choosing the row.** When an intent is inserted for identity X, the
candidate rows are those where:

- X is the **first** accepted link;
- the serial is greater than the occurrence's carried mark;
- the serial is greater than the `submitted_serial` of X's newest existing
  application, if X has one.

Then:

- **Exactly one candidate:** record an application from that row.
- **None:** record nothing. The new occurrence came from another position
  (such as a reference in someone else's row), or from a row older than the
  mark. This also stops a pre-baseline row from becoming an application when
  X later appears as a reference elsewhere.
- **Several** (two submissions in one poll): use the newest, and count the
  rest as `applications_ambiguous`.

**Edited responses.** If respondents can edit their responses, Google Forms
may set the row's timestamp to the time of the edit. That isn't verified for
this form. Either way, the rules above handle it:

- An edited row rises above the mark, but it creates an application only if
  a newly inserted intent's identity is its first link. If the edit put a
  new character first, that is the applicant's updated application, and
  linking it is intended.
- It alerts only if one of its identities' counts rose in that poll (see
  [The arrival alert](#the-arrival-alert)). An edit that only rewrites
  existing links alerts nobody.

The application is written in the intake transaction, using
`RETURNING sequence` from the intent insert. `pollApplicantSheet` threads the
per-row candidate lists and serials through to `reconcileApplicantCounts`. A
row with a single accepted link records nothing.

If the root intent is inserted as `suppressed`, the intake transaction sets
`settled_at` there and then.

**Member intents.** Each member records the intent that belongs to this
application in `member_intent_sequence`.

- If the member's intent is inserted in the same intake transaction, record
  that sequence.
- If the member's occurrence is deferred, leave it NULL. When an intent for
  that identity is next inserted, the same transaction fills it into every
  open application member with that identity and a NULL sequence.

This keys the wait on the right intent. A later resubmission's pending
intent can't stall an older application.

### Safeguards at intake

- **Cap.** A row with more than 5 accepted links (the root plus 4) records an
  application with no members, closed at once, and counts `over_cap`. Nothing
  is linked.

### The linking step

The linking step runs at the end of each watcher tick, after the drain, and
only when `APPLICANT_LINKING_ENABLED` is true. It makes no provider calls, so
the points gate doesn't apply to it.

**Settlement.** `admitCanonicalIntent` and the drain's final state update,
which move a root intent to `done` or `suppressed`, also set `settled_at` on
any application whose `root_intent_sequence` is that intent, in the same
statement's transaction. The linking step considers only settled
applications.

**Selection:**

- Open applications with `settled_at` set.
- Ordered by `last_checked_at`, oldest first, so waiting applications don't
  starve newer ones. Each visit updates `last_checked_at`.
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
4. **Each member without an outcome.** "The member's intent" is the one in
   its `member_intent_sequence`.
   - **Wait** until that intent is `done` or `suppressed`. A member with no
     intent yet (deferred, or still backlogged) waits too.
   - **Resolve its key.** A character identity is its own key. A Warcraft Logs
     id resolves through that intent's `canonical_identity`, which follows
     renames. The step never calls `resolveCharacterById`.
   - **`suppressed`:** the intent is `suppressed`, or
     `suppressions.isActive(memberKey, now)` is true.
   - **`same_character`:** the canonical identity equals the root's.
   - **Wait** until the member's character row exists.
   - **`skipped_region`:** a different region from the root.
   - **`skipped_excluded`:** either dossier has excluded the other: the
     root's dossier has excluded the member, or the member's dossier has
     excluded the root. Both manual and discovered exclusions count.
     Otherwise a resubmission that puts the excluded character first would
     write the reverse link, and groups count manual links whether excluded
     or not.
     - Exclusions are written under every key sharing the target's Warcraft
       Logs identity when they're made. So compare against each side's
       shared-identity key set (`sharedIdentityKeys`), not one key. A member
       resolved through a Warcraft Logs id to a new name is still caught.
   - **`skipped_cross_group`:** see below.
   - **`linked`:** otherwise, call `manualConnections.add` with origin
     `applicant_sheet` and the application id. Record `linked` whether the
     result is `added` or `duplicate`.
5. **Close** the application when every member has an outcome, and delete its
   member rows.

**The cross-group check.**

- It runs only after the member's intent is settled and its character row
  exists, so it never decides on a member that hasn't been discovered.
- It computes both components on the fly, from the same counting links as
  `COUNTING_LINKS_FROM`: observed links without a rejection, plus every
  resolved manual connection. It doesn't read `character_group_members`,
  which lags behind until a recompute.
  - **It uses #738's shared counting-links fragments,** not a query of its
    own, so it and the group recompute cannot drift apart. From #738's
    phase 3 that includes the manual-half rejection predicate, so a rejected
    manual or applicant link doesn't count here either.
- It skips the member when the root and the member are in **different**
  components and **both** have more than one member. Merging two established
  groups is always a reviewer's call. A member already in the root's
  component, or on its own, is linked.
- **What was measured, and what it doesn't show.** On test, 2026-10-13,
  there were 5 resolved manual links made by reviewers. With each link's own
  edge removed, the root and the target were already in the same component
  in all 5 (component sizes 10, 17, 10, 10 and 2). That includes Tropipe →
  Tropicos, which Raider.IO connected once Tropicos was discovered.
  - This is **not** evidence that the rule is safe. The rule only fires for
    pairs that aren't already connected, and the sample contains none, so
    it says nothing about how often the rule blocks a link that was needed.
  - What it does suggest is that an applicant's characters are usually
    connected through Raider.IO anyway. So the rule should rarely fire, and
    when it does, the pair genuinely deserves a reviewer's look.
- **Measuring it live.** `applicant_links` also counts
  `needed_link_pairs`: pairs that reached the cross-group check in different
  components. Read `skipped_cross_group` against that count, not against all
  links.
- **If it blocks too much.** If `skipped_cross_group` is most of
  `needed_link_pairs`, narrow the rule: for example, skip only when the
  member's component holds another application's root, or another
  dossier's manual link.
- **Rollback.** The check reads `character_connections`, a #738 table, so the
  #738 phase 1 rollback can no longer assume nothing reads it. Before
  reverting phase 1, set `APPLICANT_LINKING_ENABLED=false`. Record this in
  the character-groups design's rollback section and in
  `docs/operations/character-groups.md`.

**Rejections (#738 phase 3).** Phase 3 adds a `skipped_rejected` outcome,
checked before `linked`: a member whose pair with the root has a `rejected`
row is skipped. Without it, a resubmitted application would keep re-adding a
row that can't count. It joins the counts in `applicant_links`.

**Expiry.** Seven days after `settled_at`, remaining members become `expired`
and the application closes. The clock starts at settlement, not creation,
because admissions run FIFO at 1 a tick and 5 a day, so a burst of
applications can wait days for its root to be admitted. Members still waiting
for their own admission at that point also expire. Their count shows in
`applicant_links`.

**Idempotence.** The add and the member update aren't one transaction. The
step adds first and marks second, so a crash between them repeats an add that
`ON CONFLICT` makes harmless.

**Logging.** Each tick emits one count-only event:
`applicant_links { linked, waiting, suppressed, same_character,
skipped_region, skipped_excluded, skipped_cross_group, needed_link_pairs,
expired }`. A failure
in the step is logged and never fails the drain.

Members marked `linked` are never revisited, so a reviewer's removal holds
until the applicant submits again.

### Origin and the reviewer's add

**Writes.**

- **Worker add:** `INSERT … origin = 'applicant_sheet' … ON CONFLICT DO
NOTHING`. An existing reviewer link stays a reviewer link.
- **Web add:** `ON CONFLICT DO UPDATE SET origin = 'dossier',
applicant_application_id = NULL WHERE manual_dossier_connections.origin <>
'dossier' RETURNING (xmax = 0) AS inserted`.
  - A new row returns `inserted` true, so the result is `added`.
  - A conversion from `applicant_sheet` returns `inserted` false, so the
    result is `duplicate`.
  - An existing reviewer link returns no row, so the result is `duplicate`.
  - A reviewer re-adding an existing link therefore still sees "duplicate",
    as today. `excluded_at` is never touched.
  - `add` must decide from the returned `inserted` column, not from
    `rowCount === 1`. A conversion returns one row, and `rowCount` would
    report it as `added`.

**Reads.** `source` stays `manually_added` for every manual connection. A
separate optional field carries the origin, and is used only to choose the
label text. A new source value would fall through to wrong values in at
least these places:

- `applicant-dossier-service.ts:793-800` maps unknown sources to
  `raiderio_declared`.
- `dossierSourceLabelSchema` in `packages/contracts/src/dossier.ts` is a
  closed enum.
- `dossier-character-menu.tsx:266` offers Remove only for `manually_added`.
- `labelOf` in `character-groups-replay.ts:547-553` would rank the link as
  `raiderio_declared` while the group page says `manually_added`. That would
  fail `label_weakened` on every page with an applicant link.
- `group-subjects.ts:60` and `:129` hard-code `manually_added`.

So:

- **Contracts:** the dossier character schema gains
  `origin: z.literal("application").optional()`.
- **The manual-connections repository** returns `origin` from `list`.
- **`dossier-subjects.ts:154`** sets `origin: "application"` on the admitted
  row when the connection's origin is `applicant_sheet`.
- **`dossier-character-list.tsx`** shows "From application" when `origin` is
  `"application"`, and "Manually added" otherwise.
- **Unchanged:** sources, the Remove and Exclude actions, `labelOf`, group
  subjects and every other reader.
- **Phase 2 of character groups.** When group pages are built,
  `group-subjects.ts:129` must carry `origin` too. Otherwise group pages
  would say "Manually added" for these links. Note this in the
  character-groups design's phase 2 section.
- **CONTEXT.md:** extend **Manual connection** to say a connection can come
  from an application. It's still not an ownership claim, and it's labelled
  separately.

### The arrival alert

Today's alert fires once per newly recorded link occurrence, so a 4-link row
sends 4 alerts. Instead, alerts become per **new row**: a row whose column-A
serial is above the poll's starting mark, and which holds at least one
accepted link whose identity's count rose in this poll. The rise counts
whether that occurrence was recorded as an intent or deferred, so a row
whose links are all deferred (a full backlog, or Warcraft Logs ids being
held) still alerts when it's first seen.

- **A row with several accepted links:** one alert. It carries the applicant
  details as now and the root's dossier URL, plus one of:
  - "N other characters listed; they'll be linked if they pass the checks",
    when linking is enabled and the row is within the cap;
  - "N other characters listed; too many to link automatically", for an
    over-cap row;
  - just "N other characters listed", when linking is disabled.
- **A row with one accepted link:** the current alert, unchanged.
- **Not tied to the intent's admission.** The alert goes out when the row is
  first seen, even if the root's intent is deferred and its application is
  recorded later. A deferred occurrence that carries a mark never alerts
  when its intent is inserted, so there's no second alert. Nothing alerts
  when links are written.
- **Exceptions that keep the per-occurrence alert:** a poll that finds the
  mark NULL, and a deferred entry from before the deploy that carries no
  mark.
- **No occurrence-index mapping.** Alerts are keyed by row through the
  serial, so the ambiguity of the old mapping doesn't come back.
- **Baselines and re-baselines** send no alerts, as now.
- **Read-alignment failure.** If the two reads don't match, the poll fails
  and sends nothing. It retries on the next tick.

### Character groups

- Rows the worker writes are ordinary manual connections, and their source is
  unchanged. The replay counts them as `manual_added`, and `labelOf` agrees
  with the group page.
- Web adds don't trigger a group recompute, and neither do these. The hourly
  maintenance cycle picks them up. Until then the replay shows `drift_pending`,
  which doesn't fail it.
  - **Optionally,** the link step can call `recomputeGroupsOf` for both ends
    after each `linked`, best effort, so the link reaches the group at once.
    #738's phase 2 recommends this but doesn't require it.
- **Phase 2's request field.** #738's phase 2 calls its own `POST start` field
  `startedFrom: "page"`, not `origin`. So this spec's `origin` column keeps its
  name, with no clash.
- A burst of links during the phase 1 exit run would add `manual_added`
  coverage and pending drift. So linking ships behind
  `APPLICANT_LINKING_ENABLED` (default `false`). It is switched on outside
  that run, or with a note beside the run's counts.

### Tests

**Intake**

- One application with its members in cell order.
- None for single-link rows, baselines or re-baselines.
- None when the new occurrence isn't a first link.
- None for a pre-mark row whose first link later appears as a reference in a
  new row.
- The newest of two first-link rows is chosen, and the other is counted as
  ambiguous.
- A sorted sheet still picks the right row.
- The second read's extra trailing rows are dropped.
- A deletion, a sort, or a deletion plus an append between the reads fails
  the poll without advancing.
- A deferred root records its application in the later poll, using the mark
  it carried.
- With a NULL mark, the poll only sets the mark: no applications, and
  per-occurrence alerts.
- A deferred entry without a mark records no application and alerts per
  occurrence.
- `member_intent_sequence` is set for a member inserted in the same
  transaction. It is filled in later for a deferred member. A later
  resubmission's intent doesn't stall the older application.
- Over-cap rows record no members.
- A root inserted as `suppressed` is settled at intake.

**The linking step**

- Waits for an unsettled root, then for an undiscovered one.
- Settlement is written when the drain moves the root intent to `done` or
  `suppressed`.
- Links character members with `origin = 'applicant_sheet'`.
- Waits for a member's own intent to settle, then for its character row.
- Resolves a Warcraft Logs id member through its newest `done` intent.
- Covers a suppressed root, an intent-suppressed member and a live-suppressed
  member.
- Covers `same_character` and `skipped_region`.
- Covers `skipped_excluded` in both directions, and for manual and
  discovered exclusions.
- `skipped_excluded` also applies to a member resolved through a Warcraft
  Logs id to a new name, when its shared-identity keys are excluded.
- An application that never settles closes as `expired` 30 days after
  creation.
- `needed_link_pairs` counts only pairs in different components.
- Cross-group check:
  - skips when both are in different multi-member components;
  - links when the member is on its own or already in the root's component;
  - computes components from the counting links, not group membership;
  - a member undiscovered at link time waits, is later discovered into
    another group, and is then skipped.
- A repeated add is idempotent.
- Expiry runs from `settled_at`.
- Member rows are deleted on close.
- Closed applications are deleted after 30 days, leaving their links with
  `applicant_application_id` NULL.
- Skip-locked selection, `last_checked_at` ordering, and the flag switches
  the step off.

**Origin**

- A web add over a worker link becomes `dossier`, keeps `excluded_at`, and
  returns `duplicate`.
- A web add over a reviewer link returns `duplicate` and changes nothing.
- A web add of a new link returns `added`.
- A worker add over a reviewer link leaves it unchanged.
- The dossier shows "From application", and still offers Remove and Exclude.
- `labelOf` and the group page agree on `manually_added` for an applicant
  link.

**Resubmission**

- After a reviewer removes a worker link, a new application links it again.
- After a reviewer excludes one, it isn't re-linked in either direction.

**Alert**

- One alert per new multi-link row, with the root's dossier URL and the right
  text for each case.
- No second alert when a deferred root's application is recorded.
- A new row whose links are all deferred alerts once, when first seen.
- An edited row whose counts don't rise sends no alert.
- Single-link rows alert as today.

### Docs

`docs/operations/applicant-sheet-watcher.md`:

- It says the watcher only starts discovery and evidence. Describe the
  linking, its safeguards and the flag.
- Extend the "only … stored" list with the application tables and the
  serial mark. Note that their members are deleted on close, and closed
  applications after 30 days.
- Add the new tables to the new-baseline procedure.
- Describe the second read and its alignment rule: any mismatch apart from
  appended rows fails the poll.

Also update:

- `docs/operations/character-groups.md` and the character-groups design's
  rollback section: set `APPLICANT_LINKING_ENABLED=false` before reverting
  phase 1.
- CONTEXT.md, as above.

## Out of scope

- A backfill for applications already in the sheet.
- Remembering a reviewer's removal (a tombstone). The maintainer chose
  re-linking on resubmission.
- Admin Settings controls for the watcher.
