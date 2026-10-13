# Short discovery-job polling and hidden-tab pause (#825)

Status: approved at `c3dd883c` in Manager review 5507191913, with the
15-second continuous-failure notice condition incorporated below.

## Purpose and checked baseline

Notice the first committed discovery snapshot within roughly one to two seconds
on a visible page. Pause discovery-job polling while hidden and resume promptly
without bypassing a server's Retry-After or overlapping requests.

Issue #825 and all comments were read. Checked against freshly fetched
`origin/main` at `cf394e6d46daa2a3c4a0869b27d698a1d7f32a91`, including #907.
The job effect still has its own timer loop, uses the general 1/2/4/8/10-second
backoff and has no visibility handling. It reads the full dossier after complete.
The existing authoritative evidence poll already pauses when hidden.

Coordinator verified the isolated worktree and base before setup or edits.
Only #825 is active for implementation; #824 remains open for
its separate deployment acceptance and later queue entries remain unstarted.

## Approach and alternatives

Keep the existing discovery-job effect and its status/full-read/error handling.
Add a small pure schedule helper beside the evidence-watch helpers, and add
visibility and request-serialization guards to this effect. This confines the
change to the existing discovery loop and retains #907's full-read/progress race
protections.

Moving the two-stage discovery flow onto `useAuthoritativePoll` would require a
broader generic-hook change and careful terminal/full-read retry mapping.
Server long-polling would introduce connection sizing and query-frequency
decisions. Neither is needed for the short visible-page schedule in this issue.

## Timing and retries

Keep the first job ask immediate. Its next delay is one second, then two seconds
between asks until 90 seconds have elapsed since this job watch began. After
that window use 4/8/10 seconds, capped at 10 seconds. Hidden time counts towards
the elapsed window; returning to the page does not restart the fast window.
This is about 30 status reads per minute while healthy, well within the current
public-read limit of 300; do not change any limit or upstream budget.

Use the existing Retry-After parser for status responses and completed-dossier
read failures. Record a not-before deadline when a transient response asks for
a delay, even if the tab is already hidden. Every scheduled read waits at least
the remaining deadline. Visibility resume is immediate when there is no such
floor; otherwise it waits until the floor expires. Do not reset or discard the
floor when visibility changes. Malformed or absent Retry-After adds no floor,
matching the current parser semantics.

The short schedule applies to transient failures as well as queued/running/
retrying statuses. Show the existing failure notice only once both at least five asks have failed
and those failures have continued for at least 15 seconds. A successful answer
resets both the count and the failure-start time and clears the notice as today.
Pin both conditions and success recovery in timing tests. No new error data is
stored or logged.

## Visibility, in-flight reads and completion

Do not start a job request or schedule a timer while `document.visibilityState`
is hidden. Clear any pending job timer when hidden. An already-started request
may finish, but its result cannot start another job or full-dossier request
while hidden. A hidden completion is followed again immediately on becoming
visible, then its committed full dossier is read as usual.

On visible resume, clear the old timer and request immediately subject to the
Retry-After floor. If a job or completion-triggered full read is already in
flight, record one pending resume rather than starting a concurrent request.
After that request finishes, schedule at most one next ask, respecting any new
Retry-After response it produced. Prevent a visibility event or a late reply
from restarting a terminal or cleaned-up job loop.

Seeing complete on a visible page still begins the full read immediately. Keep
the existing 409/transient-full-read retry behaviour, terminal failure handling,
sequence checks and cancellation on identity/job changes or unmount. A successful
completion stops the job loop; visible events must not restart it. The job route
retains `jsonNoStore`; no route, contract, database, logger or storage change.

## Test-first work and verification

1. Add failing pure schedule tests that exercise the first delay, every interval
   through 90 seconds, the capped fallback, and elapsed hidden time. Implement
   the narrow schedule helper.
2. Add failing page tests for short polling through at least the first 60 seconds
   and an immediate full read after completion. Implement the helper integration
   and pin the dual time/count failure-notice conditions.
3. Add page regressions for an initially hidden tab, hiding a scheduled timer,
   immediate visible resume, hiding during an in-flight status or completion
   read, single pending resume/no overlap, terminal completion not restarting,
   cleanup/identity changes, and Retry-After across hidden/resume boundaries.
   Exercise both seconds and HTTP-date Retry-After and a transient completed-read
   failure. Implement the visibility/serialization guards.
4. Preserve and run all #907 stale-progress/uncommitted-full-read regressions,
   retry wakeups, no-second-start page/browser coverage, and job-route no-store
   contract coverage. Use local fixtures; no live provider traffic in the gate.
5. Run the full gate with Docker and `corepack pnpm`: format:check, lint,
   typecheck, test:unit, test:integration, build, test:e2e. Self-review against
   origin/main, fetch/merge current origin/main and repeat the required gate.
   Only then publish the implementation for Manager review. Never merge or
   enable auto-merge; the Manager decides.

## Overlap and deployment measurement plan

#902 / PR #904 changes the same dossier page's read/start flow. Coordinate this
plan through the coordinator, keep this change inside the discovery effect and
schedule helper, and preserve #907's snapshot-lineage guards and immediate stale
progress retry. The branch landing second must integrate the first from fresh
origin/main and reverify discovery/evidence polling and no-second-start tests.
The Manager controls actual landing order.

After implementation and confirmed test deployment, propose a concrete,
coordinator-approved window for at least five new web searches. Those searches
are not authorised to be manufactured now. The plan will identify the deployed
SHA, chosen ordinary test cases, UTC start/end window, collection/public-read
conditions, and a method for associating each job's first committed snapshot with
its first complete status response and first full visible render. Browser
request/response timings plus read-only discovery/snapshot timestamps are needed;
the existing aggregate http_request logs alone do not correlate identities.

Measure snapshot-to-complete observation delay (target mean under two seconds),
search-to-first-full-render time, job-request count and any hidden-tab/throttle
conditions. Compare with the issue's September p50 5.65-second observation delay
and p50 28.9-second render baseline; distinguish mean from median and explain
changes in deployed code or collection conditions. Publish only aggregates,
without new production logging or persistent per-visitor data. Local timer tests
are not deployment measurements. If the approved measurement window or adequate
timing access is absent, leave acceptance pending and report that dependency.

## Accepted decisions

Manager approved the minimal existing-loop change, 90-second fast window with hidden time
included, dual 15-second/five-failure threshold on the faster schedule, and serialized
visible resume that preserves Retry-After. #902 overlap handling and the separate five-search measurement authorisation
gate remain as approved; #904 is held for ship evidence, so #825 may land first.
