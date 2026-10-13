# Progress patches and coalesced dossier reads (#824)

Status: proposed for Manager review; no implementation yet.

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
controls the cheap poll's queued/running scheduling as today. Only unsettled
rows are patched. A row already showing complete or partial published evidence
keeps that evidence state while its refresh collects, matching the full dossier's
existing freshness behaviour; collection progress still updates. A settled
run's completion state is never used to expose new evidence before a full read.

Patch only matching, non-excluded characters in the latest displayed dossier,
using existing canonical character IDs. Preserve untouched character objects and
all raid, kill, metric, retry-time and snapshot fields. Patch no unknown keys.
Where multiple watched runs share a key, select the same active-progress priority
as dossier assembly rather than allowing response order to decide.

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
   aborted progress responses cannot overwrite newer reads. Verify row patches
   leave full-read timing and retries alone. Implement the page integration.
4. Run the full Docker gate: format:check, lint, typecheck, test:unit,
   test:integration, build, test:e2e, using `corepack pnpm`. Self-review against
   origin/main, fetch/merge current origin/main and repeat the required gate.
   Convert this draft to an implementation PR only after verification. Never
   merge or enable auto-merge; the Manager decides.

## Deployment acceptance and coordination

After the Manager merges and the test deployment is confirmed, coordinate a
14-character ryun collection with the coordinator. Record deployment SHA,
visit/window, full `count=14` read count and summed duration/assembly time,
progress read count, and publish-to-visible timing. Compare to the issue's
29/30 September baseline, stating differences in collection conditions. Local
tests are not deployment measurements. If test access or a collection needs
credentials/restart, hand off the concrete measurement request to the
coordinator first; do not claim the measurement complete.

Coordinate overlap with #902 before touching character-group interfaces. This
change uses existing keys and membership and does not alter identity or group
discovery. Preserve external dependencies and publication transaction boundaries.

## Decisions requested from Manager

Review the fixed publish deadline, removal of the obsolete step-read gap while
retaining stale-read fallback, and the evidence-state preservation rule for
refreshes over published evidence. In particular, confirm the cheap response's
run-derived state plus preservation of the row's published state is sufficient,
or require a cheap server projection of the dossier's freshness-derived state.
