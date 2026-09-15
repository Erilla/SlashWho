# Applicant research performance

Issue #187 baseline and follow-up measurement procedure.

## Existing measurement surface

The web service emits privacy-safe HTTP duration records for dossier start/read/status endpoints and cache events for Blizzard achievement and Raider.IO ranking caches. The worker emits discovery_run records containing total run duration, character count, retry outcome, queue wait, fingerprint duration, and request usage. These records contain no character identity or upstream payloads.

Capture at least 20 representative dossier requests for each scenario:

- cold search with no current snapshot;
- stale snapshot refresh;
- warm dossier read with cached provider data; and
- dossier read while Warcraft Logs evidence is gathering.

Record:

- submission to first HTTP 200 dossier response;
- submission to a settled evidence response;
- p50, p95, and maximum values;
- cache hit, miss, shared, failure, and capacity outcomes;
- discovery queue wait and total worker duration; and
- provider limitation or request-cap counts.

A simple capture can collect structured service logs and group records by an operator-provided request window. Do not add character names, URLs, request bodies, or provider payloads to the capture.

## Improvement

Historic Raider.IO rank enrichment now uses bounded application concurrency (DOSSIER_PROVIDER_CONCURRENCY, default 4, maximum 12). This prevents a large dossier from opening one upstream request per unique guild/boss lookup simultaneously while preserving all lookup results and existing limitation behavior.

The concurrency limiter has a focused regression test. Existing dossier tests continue to cover cached evidence, gathering states, provider limitations, and rank enrichment.

## Remaining constraints

Warcraft Logs evidence remains durable and PostgreSQL-coordinated by design. Dossiers remain assembled per read and responses remain no-store. Blizzard achievement reads retain their existing account-aware ordering because later fingerprint-derived subjects may be skipped after account-wide evidence is established. Upstream timeout, request-cap, cache TTL, and rate-limit semantics are unchanged.

After deployment, compare the capture metrics above against the same scenarios and record the before/after values in the issue discussion.
