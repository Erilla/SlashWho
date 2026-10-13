# Progress patches and coalesced dossier reads (#824)

Status: revised after Manager review 5506068687; awaiting acceptance before
implementation. The fixed deadline and removal of the step-read gap with
stale-read fallback were approved in that review.

## Purpose and current evidence

While collection runs are active, update character progress from the cheap run
poll. Read published evidence in full after several nearby publishes, and
immediately when the final watched run settles. Keep unavailable and
not-applicable metrics intact.

Checked against freshly fetched `origin/main` at
`7c21c89f33b9365defa3046724e6f94576957795`. The reported behaviour still exists:
`evidence-run-watch.ts` reads on version moves and immediately on any settlement;
`landed()` resets its progress gap whenever watched IDs change. The repository
projection contains only status, deferral and ordered phase states. The page's
dossier effect counts every state replacement as a full read, so patching via
that effect would incorrectly reset watch and retry bookkeeping.

Worktree: `G:\repos\SlashWho\.claude\worktrees\feat-824-progress-poll`.
Branch: `feat/824-progress-poll`. Only #824 is active in this queue.

## Proposed contract and row updates

Extend each progress run with `key` (the existing character-key contract),
`collectionProgress` (the existing phase contract, allowing an empty list before
phases are initialised), and `evidenceState`. Keep ID, state and opaque version.
The repository query returns the owning key and ordered phase ID, state and
limitation code in one query, retaining suppression filtering and the 64-ID cap.
The application uses the existing phase conversion, and includes limitation
changes in the opaque version. No migration, provider calls, reservations or
snapshot assembly are required.

Run-derived evidence state is waiting for queued/retrying, scanning for running,
complete for completed, and partial for partial/failed/cancelled. Deferral still
controls the cheap poll's queued/running scheduling as today. Only rows with
unsettled runs are patched. A single-identity row already showing complete or
partial published evidence
keeps that evidence state while its refresh collects, matching the full dossier's
existing freshness behaviour; collection progress still updates. A settled
run's completion state is never used to expose new evidence before a full read.

Map a run to a non-excluded row when its owning key matches the row's `key` or
one of its `warcraftLogsAliases`, using existing canonical character IDs. Mirror
`mergeIdentityEvidence`: choose the subject's own unsettled run's progress first;
otherwise choose the first unsettled alias run in the row's alias order. Response
order must not determine the chosen progress. Ignore runs whose keys match no
visible row identity.

Full dossier assembly takes the most severe state across identities, ordered
`complete < partial < scanning < waiting`. The client cannot infer stored
freshness for an identity from a run response. For a multi-identity row, make
only the safe `waiting` to `scanning` move when every unsettled identity run is
running; otherwise preserve its displayed evidence state, including complete or
partial during a refresh. A missing run's state is unknown: do not use its
absence to infer a safe state move while waiting for the coalesced full read.
Final evidence states still come from the authoritative full read.

The progress response permits an empty phase list, but the dossier's existing
`collectionProgress` schema remains optional with `min(1)`. When the chosen run
returns no phases, preserve the row's existing `collectionProgress` (including
absence); never patch `[]` into a dossier row. Keep `researchState: gathering`
while any run belonging to the row is unsettled. Do not mark a row complete from
a settled progress response while waiting for published evidence to be read.

Preserve untouched character objects and all raid, kill, metric, retry-time and
snapshot fields. These patches operate on the latest displayed dossier.

Separate full-read bookkeeping from progress patches: patches must not call
`shown()`/`fullRead()`, advance the last full-read time, reset retry wakeups,
or claim a full-read request sequence. Capture the displayed/read generation
before the progress request and discard a response if a newer full snapshot or
watch set replaced it. Preserve cancellation, hidden-tab and error handling.

## Publish coalescing

Remove step-driven full reads entirely. Observe and record version moves to
patch rows and maintain the existing cheap queued/running poll cadence.

When a watched run settles or disappears, mark a pending full read. If other
watched runs remain queued/running, establish one deadline at the first observed
settlement: `now + max(10 seconds, last successful full-read duration)`. Further
publishes do not push that deadline back. Continue cheap polling and row updates
until the deadline, then read once. If all watched runs settle or disappear,
read immediately, including on the first progress response.

Measure successful full fetch/parse/validation duration with a monotonic clock;
initial server-provided snapshots use the 10-second minimum. Clear pending
publication state when a newer full read lands, then observe the new watched set
immediately to catch settlements during that read.

The step-read progress gap becomes unnecessary and is removed. Preserve the
existing after-full-read backoff against stale dossiers that repeatedly name
settled/missing runs. A watched-set shrink alone must not reset that fallback;
new run IDs may reset collection scheduling. This avoids replacing the old
reset bug with a stale-snapshot tight loop.

Do not implement the optional unchanged-dossier guard in this issue. It adds a
separate publication-version design without being needed for these criteria.
Both API routes retain `Cache-Control: no-store`.

## Test-first implementation and verification

1. Add failing contract/application and Docker repository tests for keys,
   ordered phases, limitation codes, evidence states, suppression and empty
   phase lists. Implement the narrow projection and schema.
2. Add watch tests for unlimited step moves without full reads, multiple nearby
   publishes sharing one fixed deadline, durations above 10 seconds, final
   settlement/missing run reading immediately, set shrink preserving fallback,
   and stale snapshots backing off. Implement the watch state machine.
3. Add page tests proving rows update without a dossier fetch, settled rows wait
   for the authoritative full snapshot, fresh evidence remains visible during a
   refresh, unavailable/not-applicable metrics remain unchanged, and stale or
   aborted progress responses cannot overwrite newer reads. Cover alias-only
   collection, subject and alias collecting together, subject-first selection,
   alias ordering independent of response order, and safe multi-identity state
   moves with queued or unknown identities. Cover empty phases preserving both
   present and absent row progress, and validate patched dossiers against the
   unchanged `min(1)` schema. Assert `researchState` remains gathering while any
   row run is unsettled. Verify patches leave full-read timing and retries alone.
   Implement the page integration.
   Add page/e2e coverage proving progress patches never use read-or-start and
   coalesced full reads remain poll reads that never start research, including a
   stale group page with live evidence after integration with #902.
4. Run the full Docker gate: format:check, lint, typecheck, test:unit,
   test:integration, build, test:e2e, using `corepack pnpm`. Self-review against
   origin/main, fetch/merge current origin/main and repeat the required gate.
   Convert this draft to an implementation PR only after verification. Never
   merge or enable auto-merge; the Manager decides.

## Deployment acceptance and coordination

After the Manager merges and the test deployment is confirmed, coordinate a
14-character ryun collection with the coordinator. Record deployment SHA,
visit/window, full `count=14` read count and summed duration/assembly time,
progress read count, and publish-to-visible timing. Also record how often a full
read changes a row's `evidenceState` from the state its progress patch displayed,
to assess drift in the conservative preservation rule. Compare to the issue's
29/30 September baseline, stating differences in collection conditions. Local
tests are not deployment measurements. If test access or a collection needs
credentials/restart, hand off the concrete measurement request to the
coordinator first; do not claim the measurement complete.

The #902 phase 2 draft (#904), Task 4, overlaps in
`dossier-page-client.tsx`'s read loop (`readCurrentOrStartResearch`) and
`packages/contracts/src/dossier.ts`, not just in character-group interfaces.
Progress patches must never call read-or-start. Coalesced full reads remain poll
reads, and poll reads must never start research on a stale group page. Preserve
#902's e2e invariant that polling live evidence sends no second start.

Coordinator's revised proposed landing order: #902 first, then #824. #902 is
already implementing and testing group read/reservation changes; this plan is
still awaiting acceptance. The coordinator is confirming interfaces and order
with #902's owner; the separate Manager retains control of merge order. Plan
revisions can proceed now. Keep overlapping implementation adaptable until #902
lands, then fetch/merge its changes from `origin/main` into this branch, resolve
the read-loop/contract overlap and rerun the full gate plus the no-second-start
coverage before final implementation review. Report interface objections or
dependency needs to the coordinator. #909 is worker-side and does not overlap
this change. Preserve external dependencies and publication transaction
boundaries; do not change identity or group discovery in #824.

## Decisions requested from Manager

The fixed publish deadline and removal of the obsolete step-read gap while
retaining stale-read fallback are approved. A run-derived evidence state with
preservation is approved for single-identity rows; no server freshness projection
is required. Please accept the revised alias mapping, conservative multi-identity
state rule, empty-phase/research-state invariants and explicit #902 overlap
coverage. The coordinator will confirm landing order separately.
