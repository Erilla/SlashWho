# Live collection updates

Issue: #411

## Decision

Use bounded client polling, not server-sent events. Both affected pages retain
their existing authoritative read endpoints and use one reusable client update
seam to refetch and apply a new snapshot. The change does not add a second
collection-state model, a new public event payload, or a page reload loop.

The application already has authoritative, `no-store` JSON reads for a
dossier, dossier research status, and the operator collection monitor. It also
has proven dossier polling with cancellation and increasing delays. Polling is
therefore the smaller reliable transport: it crosses the separate worker and
web processes through their shared persisted state, requires no new broker,
and works whenever ordinary authenticated fetches work.

SSE would need a durable worker-to-web notification channel, lifecycle and
back-pressure management for long-lived connections, and a polling fallback.
It also cannot carry the browser's custom dossier credential headers through
`EventSource`. An opaque event plus a normal follow-up read would preserve the
boundary, but would still add all of that infrastructure without removing the
need for the read paths below.

## Shared update seam

Introduce a focused client utility whose only responsibility is to schedule
and cancel reads of an authoritative resource. Consumers supply:

- whether their current resource can still change;
- a function that reads and validates the current JSON snapshot;
- a function that atomically applies that snapshot to their local page state.

The utility starts with the current dossier delay schedule (one second,
doubling to a capped ten seconds), schedules only one request at a time, and
cancels its request and timer on unmount or navigation. A retryable network,
429, or 5xx failure keeps the last known-good state and retries at the capped
delay. A malformed response or non-retryable authorization/error response
stops the updater and exposes the existing page-level error treatment. Hidden
documents pause scheduled reads; returning to a visible document causes one
fresh read before normal scheduling resumes.

This is bounded in cadence and concurrency, rather than a browser reload
loop: one page has at most one pending timer and one in-flight request, and a
terminal resource stops its timer. A manually initiated refresh remains
available independently.

## Dossier behavior

The dossier remains the source of truth for its rows, evidence, limitations,
and research message. While its research state is `gathering`, the updater
reads the existing canonical dossier endpoint with `cache: "no-store"` and
the same credential-header policy used by dossier reads. A validated response
replaces the dossier snapshot only; it does not reset manual-dialog state,
navigation state, or unrelated UI.

The existing start-job status polling remains responsible for discovery-job
completion. The shared updater owns post-publication dossier refreshes, so a
complete or partial evidence publication becomes visible through the
authoritative dossier representation. Abort and freshness guards prevent a
late initial/status response from overwriting a newer snapshot.

## Collection monitor behavior

Keep the route-level operator authorization and initial server render. Move
the rendered monitor tables behind a small client boundary that receives the
initial `CollectionMonitorResponse` and uses the shared updater to read the
existing `/api/operations/collection-monitor` endpoint. Browser session
cookies continue to authenticate that request; no operator secret enters the
client.

The client replaces only its monitor snapshot. The existing character/run
keys preserve row identity while a published run moves from `inFlight` to
`completed` or `failed`, and the response supplies terminal time, limitation,
and evidence-version fields. Polling continues while the displayed monitor
has active rows, then stops after it reaches a terminal snapshot. It does not
construct or retain an alternate collection model.

## Authorization, privacy, and caching

No endpoint gains broader access. Dossier reads continue through public-read
authorization and its credential-override rules; monitor reads continue to
require an operator session or Bearer credential before data is read. All
reads and error responses retain `Cache-Control: no-store`.

The browser receives only data already permitted by the authoritative dossier
or monitor contracts. The update seam neither serializes queue records nor
exposes raw provider payloads, encrypted credential fields, secrets, or
credential headers.

## Accessibility and errors

Add a dedicated polite live region to each client view. It announces only a
meaningful publication transition: the dossier's visible collection state
changes to complete/partial, or a monitor run reaches/moves between a terminal
state. Repeated polling attempts, elapsed-time changes, and identical
snapshots produce no announcement. Errors do not discard rendered content;
the last valid snapshot remains visible and the established manual refresh
control continues to work.

## Verification

Unit and component tests will use the repository's Vitest/jsdom fake-timer and
fetch-stubbing patterns to prove:

1. a complete publication replaces only the relevant dossier/monitor state;
2. a partial publication exposes its limitation and result summary;
3. at most one request is pending at a time, terminal state stops polling, and
   unmount/navigation cancels it;
4. retryable transport failure and visibility return refetch safely without a
   reload, while unavailable transport leaves the last valid snapshot and
   manual refresh usable;
5. live-region output is emitted once per meaningful state transition;
6. dossier credential headers, monitor operator authorization, contracts, and
   `no-store` cache headers remain enforced.

