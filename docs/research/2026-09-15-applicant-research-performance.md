# Applicant research performance

Issue #187 baseline and follow-up measurement procedure.

## Existing measurement surface

Four record types now exist: `http_request`, `discovery_run`, `evidence_job`, and `upstream_throttle`.

The web service emits an `http_request` record for each dossier start/read/status request. It carries the endpoint, status, and total duration, plus per-operation provider buckets (`raiderIoRankingsMs`/`Calls`/`MaxCallMs`, `raiderIoCharacterMs`/`Calls`/`MaxCallMs`, `blizzardMs`/`Calls`/`MaxCallMs`) built from the same measurement scope used on the read path, database totals (`dbMs`/`dbCalls`/`dbMaxCallMs`), the concurrency limiter's cumulative wait (`limiterWaitMs`), and cache tallies for the Blizzard achievement and Raider.IO ranking caches (`cacheHits`, `cacheMisses`, `cacheShared`, `cacheFailures`, `cacheCapacity`). A request that joined an already-in-flight discovery run instead of starting a new one is marked `runJoined: true`.

The worker emits a `discovery_run` record per attempt, containing the run id, the canonical character key, attempt number, outcome, character count, total duration, discovery queue wait, and — when a fingerprint sweep ran — fingerprint queue wait, reserved/used request counts, and fingerprint duration, alongside the same provider (`raiderIoMs`/`Calls`, `blizzardMs`/`Calls`) and database buckets. It also emits an `evidence_job` record per Warcraft Logs evidence attempt, with queue wait, outcome, limitation codes, kill count, and the `warcraftLogsMs`/`Calls` buckets.

A `correlationId` links an `http_request` record to the `discovery_run` and `evidence_job` records it triggered, when one was emitted for that request.

Because the API clients (Raider.IO, Blizzard, Warcraft Logs) are constructed once per process, a throttle response cannot be attributed back to the request that triggered it. Throttling is therefore reported by its own `upstream_throttle` record instead: `provider` (a fixed literal from a closed set) and the upstream's own `retryAfterMs`.

These records carry the canonical public character key. They never carry an owner identifier, a profile guess, an upstream payload, a URL, a request body, or an IP address.

**Two things the numbers do not tell you:**

- A bounded-cache "shared" outcome — a request that joins an in-flight load already under way rather than starting its own — increments `cacheShared` but records no provider time for that call, even though the request genuinely waited on the load. Provider duration buckets therefore under-attribute time for requests that share a load; do not read a low `raiderIoRankingsMs` as evidence that ranking lookups are cheap when `cacheShared` is nonzero.
- A `*Calls` count counts measurement spans, not HTTP requests. One span can wrap more than one upstream call — the discovery path's `raiderIo` span wraps `discoverCharacter`, which can call `getCharacter`, `getClaimedCharacters`, and `resolveProfileGuess` in a single span. `raiderIoCalls: 1` does not mean exactly one HTTP request was made to Raider.IO.

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
- provider limitation or throttle counts.

Do not add character names, URLs, request bodies, or provider payloads to the capture.

Once a log window is captured, run each record type through the analysis script:

    cat capture.log | pnpm analyze:performance http_request
    cat capture.log | pnpm analyze:performance discovery_run
    cat capture.log | pnpm analyze:performance evidence_job
    cat capture.log | pnpm analyze:performance upstream_throttle

The script reads captured log lines from stdin, keeps only records whose `event` matches the argument, and reports the count together with p50, p95, and maximum for every numeric field on those records, a tally of records by `outcome`, and a tally by `provider` (populated for `upstream_throttle`).

## Improvement

Historic Raider.IO rank enrichment now uses bounded application concurrency (DOSSIER_PROVIDER_CONCURRENCY, default 4, maximum 12). This prevents a large dossier from opening one upstream request per unique guild/boss lookup simultaneously while preserving all lookup results and existing limitation behavior.

The concurrency limiter has a focused regression test. Existing dossier tests continue to cover cached evidence, gathering states, provider limitations, and rank enrichment.

## Remaining constraints

Warcraft Logs evidence remains durable and PostgreSQL-coordinated by design. Dossiers remain assembled per read and responses remain no-store. Blizzard achievement reads retain their existing account-aware ordering because later fingerprint-derived subjects may be skipped after account-wide evidence is established. Upstream timeout, request-cap, cache TTL, and rate-limit semantics are unchanged.

After deployment, compare the capture metrics above against the same scenarios and record the before/after values in the issue discussion.
