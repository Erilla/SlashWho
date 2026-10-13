# Discovery-poll deployment measurement proposal (#825)

Status: design only. No deployment search is authorised by this document. The
implementation must merge and the deployed SHA, recorder method, five eligible
named cases and UTC window must be separately agreed before live execution.

## Cases and eligibility

Five named candidates, drawn from the existing public Ryun roster observed on
13 October, are shown below. They have not been searched for this measurement,
and their eligibility has not been verified. They share a roster, so cache and
job sharing must be reported; they are not independent account samples.

| Case | Candidate ordinary search | Needed before authorisation                           |
| ---- | ------------------------- | ----------------------------------------------------- |
| A    | eu/silvermoon/raan        | Legitimate case, naturally needs a new first snapshot |
| B    | eu/silvermoon/riln        | Same eligibility, no completed first snapshot reused  |
| C    | eu/silvermoon/rinn        | Same eligibility, no already-running job joined       |
| D    | eu/silvermoon/ryaa        | Same eligibility, ordinary inputs only                |
| E    | eu/silvermoon/ryann       | Same eligibility, unchanged normal admission/budgets  |

The coordinator must confirm these are appropriate real test cases and use
read-only records to check natural eligibility. No forced refresh, snapshot
expiry/deletion, roster edit, budget change or job cancellation may make a case
eligible. If a candidate is fresh, absent, suppressed, already complete, or joins
existing work, keep that attempted outcome separate and request a replacement
named legitimate case before another search. Do not silently substitute a name
or drop an unsuccessful attempt. Five eligible completed cases are required for
the primary aggregate; otherwise report the measurement as incomplete.

## Recorder boundary and capability evidence

Proposed recorder: an isolated, test-only Playwright context, attached only to
the confirmed Railway test origin. It observes normal search requests, response
completion and connected-row rendering. It must not create an agent worker or
connect a worker to test PostgreSQL, change production code, or add production
logs/storage. A read-only database operator separately supplies publish records.

Installed Playwright 1.62.1 exposes Request.timing(), with startTime in UTC epoch
milliseconds and responseEnd relative to startTime. The existing local
`tests/profile/dossier-load.profile.ts` already uses browser.newContext(),
page.addInitScript(), performance.timeOrigin/performance.now() and a
MutationObserver. Its existing renderer mark detects the first panel only, so
it cannot be reused unchanged for the first FULL linked snapshot.

These are verified source/API prerequisites, not a completed capture tool. The
remote recorder and combined parse/render correlation have not been run or
validated. Current CUA browser observation was checked: DOM counts work, but
performance is unavailable in its read-only page scope. Do not claim that CUA
captures network timing or reuse its DOM sampling as a sub-two-second timing
measurement. The proposed separate recorder method needs explicit agreement.

Before any live window, validate the recorder using local synthetic responses
only: immediate and delayed completion; headers before body completion; a slow
JSON body; an initial/provisional row set before the committed full read; an
unchanged membership set whose research message changes; hidden-tab and
Retry-After samples; joined/cached results; and a censored case. Disable the e2e
Docker global setup for that recorder-only fixture; no shared restart is needed.

## Timestamp definitions

All browser event timestamps use one context clock:
`UTC milliseconds = performance.timeOrigin + performance.now()`. Retain the
monotonic offset as well. Convert output to UTC ISO strings; do not infer UTC
from the host's displayed timezone.

- T_submit: normal search form submit captured before the application sends its
  start request. Also retain T_start_request from browser Request.timing(). A
  navigation to an existing job page has no T_submit and cannot qualify for the
  search-to-render metric.
- T_job_assigned: the start response has been parsed and its returned job ID is
  available in memory. A ready response is cached/no-job, outside the primary
  discovery sample. Do not retain typed URLs, request headers or credentials.
- T_complete_wire: the first successful status response for that exact job ID
  whose validated body says complete has finished receiving its body:
  request.timing().startTime + request.timing().responseEnd. Missing (-1) timing
  must be reported as unavailable, never treated as zero. Response-header time
  alone is insufficient.
- T_complete_parsed: a temporary page-side JSON observer records when the normal
  job response JSON parse resolves, without making another request. The same
  body must validate against the deployed status contract. This is a proxy just
  before the application's contract validation, not an exact React callback
  timestamp. Keep its small observer/validation gap explicit.
- T_full_request: request start for the unambiguously completion-triggered full GET. It is an upper bound on the application having processed complete, including any credential preamble. If overlapping evidence/other full reads prevent attribution, this bound is unavailable; do not choose a convenient unrelated GET.
- T_full_response: the corresponding full dossier response after that complete
  observation has been parsed and validated. Exclude scope=initial reads and
  unrelated refresh/tier reads. Retain expected membership and research message
  only in memory for render matching.
- T_full_dom: first DOM observation after that full request starts whose
  connected-character identities/count AND research message match that full
  response. A previously visible provisional roster is not enough. Buffer
  bounded DOM state samples before the response callback, since React may render
  before the Node-side clone finishes parsing.
- T_render_opportunity: the matching DOM predicate survives to a following
  animation-frame render opportunity while the document is visible. This is a
  render proxy/bound, not proof of the exact first painted pixel. Retain T_full_dom
  separately. A hidden frame cannot qualify as a visible render.

The response observer must return the original response/body unchanged and not
wait on reporting, capture extra provider traffic, replace application errors,
or change any Retry-After behaviour. Verify that observer overhead in the local
fixture does not alter request ordering; report overhead, not a zero assumption.

## Publish correlation and clock uncertainty

Match the returned in-memory job ID to discovery_runs.id. Query only that row
and its linked snapshot, using a read-only transaction and parameterised ID:

```sql
BEGIN READ ONLY;
SELECT r.status, r.created_at, r.completed_at, r.snapshot_id,
       s.discovery_run_id, s.refreshed_at, s.character_count
FROM discovery_runs r
LEFT JOIN snapshots s
  ON s.id = r.snapshot_id AND s.discovery_run_id = r.id
WHERE r.id = $1;
COMMIT;
```

Require complete plus a matching committed snapshot. Ordinary publication writes
membership and status in one transaction. In snapshots.ts, completed_at uses
COALESCE(completed_at, now()): it retains the first completion timestamp, but
PostgreSQL now() is the transaction timestamp, not its exact commit instant.
Treat completed_at as a first-publication BEFORE-COMMIT proxy, not an exact
commit timestamp. Snapshot refreshed_at is caller-supplied and may change in a
continuation, so it is corroboration rather than an interchangeable clock.
Actual transaction commit time is unavailable unless existing configuration
already exposes it; do not enable commit timestamp tracking or add logging.

Calibrate before and after the approved window with read-only
SELECT clock_timestamp(). Record client UTC immediately before and after each
round trip. If server-minus-client offset is in [L,U], derived from those round
trips, convert a browser event to a server interval [T+L,T+U]. Use the union of
before/after bounds and report RTT/skew uncertainty. Do not rely on an HTTP Date
header's one-second resolution for a two-second target. If no credible clock
bound is available, publish browser-only intervals and mark cross-clock
publish-to-observation acceptance unavailable.

For a newly created qualifying job, the transaction timestamp precedes its
visibility at commit. Therefore [T_complete+L-completed_at,
T_complete+U-completed_at] is a clock-bounded completion-PROXY delay; its upper
bound conservatively includes commit lag. A mean upper bound below 2 seconds
supports the target conservatively. Otherwise the exact commit-to-observation
mean cannot be claimed from these proxies. Do not replace negative/unknown
values with zero or silently discard them; report inconsistent samples.

## Deployment and window attribution

Confirm test web and worker deployment IDs/status/commit hashes read-only before
and after the window. Require one pinned SHA containing #825 for the primary
sample. A deployment change splits the sample; never blend it into one five-case
aggregate. Record the same exact SHA for browser assets and the server metadata
where verifiable; if asset-to-deployment matching is unavailable, disclose it.
Include other intervening fixes (#787/#905, #804/#908, #824/#907, #909 and any
later #902 work), dataset/character-count drift, cache state, and budget waits.

Read existing deployment-specific http_request logs in memory for the exact UTC
window. Aggregate search/status/full/progress counts and durationMs/assembleMs;
keep unrelated traffic separate or state that it cannot be correlated. Existing
logs omit identity, so counts alone cannot map a job to a character. Use the
browser job ID and the read-only query for correlation, not new server logging.

## Outputs and retention

Primary table uses case labels A-E only, deployment SHA, UTC window, outcome,
character count, status/full/progress read counts, clock-bounded proxy delay,
T_submit-to-T_full_dom and T_submit-to-T_render_opportunity, and visibility/
throttle/cache/join conditions. Summaries include n, mean, p50 and max, plus
censored/unavailable/out-of-scope attempt counts. The observation-delay target
uses MEAN under 2 seconds; compare September's p50 5.65 seconds as a median,
not as its mean. Search-to-render p50 compares with September's p50 28.9 seconds
only after explaining the render definition and intervening dataset/code changes.

Keep raw bodies, job/snapshot IDs and DOM membership samples only in memory for
one case, with a maximum 10-minute observation limit and a maximum 1000 DOM
samples. At the bound, mark the case censored and dispose it rather than extend
or force completion. Clear raw data immediately after its correlated aggregate
is produced, on error, or at the limit; close each isolated context. No HAR,
trace, video, screenshot file, raw network log or console dump. No saved provider
keys or browser storage export. Persist only the approved aggregate report and
case labels, never response bodies/IDs. Keep bounded raw data only as long as
needed for the immediate read-only correlation; if that query cannot be completed
inside the case limit, publish that metric as unavailable rather than retain it.

Live execution remains pending separate method/case/window authorisation after
merge and confirmed deployment. No search has been initiated by this design.
