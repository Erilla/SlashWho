# SlashWho MVP Design

**Date:** 2026-08-04

**Status:** Design approved; written specification awaiting final review

## Summary

SlashWho is a public website and versioned API that accepts a Raider.IO character URL and finds other characters publicly linked to the same Raider.IO identity. Searches run as durable background jobs. Their results become permanent, crawlable character pages with immutable refresh snapshots.

The MVP deliberately uses only Raider.IO signals. It does not perform the Blizzard achievement-fingerprint sweep or gather guild history and Mythic raid logs from SeriouslyCasualBotV2. The architecture preserves the background-job contract needed to add those heavier sources later without changing website or bot clients.

## Goals

- Accept a full Raider.IO character URL as the search input.
- Use every lightweight Raider.IO-only signal already validated by SeriouslyCasualBotV2:
  - visible owner and claimed-character list;
  - declared-main links and a pivot through the declared main;
  - validated profile guesses when the owner is privacy-hidden.
- Return a compact list containing character name, region, realm, class, level, and Raider.IO link.
- Give every searched character a canonical public page at `/characters/{region}/{realm}/{name}`.
- Retain immutable refresh snapshots permanently and expose their dates, result counts, and completion state.
- Show cached data immediately and automatically refresh data older than 24 hours.
- Expose one shared API contract to the website and SeriouslyCasualBotV2.
- Deploy a staging and production topology to Railway.
- Support a small public launch of tens to low hundreds of searches per day without introducing Redis.

## Non-goals

- Blizzard achievement-fingerprint discovery.
- Warcraft Logs, Mythic raid progression, or guild-history collection.
- User accounts or sign-in.
- User-editable claims, merges, or corrections.
- Displaying technical discovery provenance or raw upstream responses.
- Computing a public added/removed change log between snapshots. Users can view dated snapshots, but the MVP sidebar is refresh history rather than a relationship diff.
- A public directory of recently searched characters on the homepage.
- Third-party API-key issuance or a developer dashboard.
- Multi-region or high-availability infrastructure at launch.

## User experience

### Homepage

The homepage is intentionally minimal:

- flat obsidian background;
- a flat frost-blue slash logo in the top-left;
- space for `API` and `GitHub` links in the top-right;
- a centred `/Who` brand, with the slash mark immediately before `Who` and no visible `Slash` word;
- one Raider.IO URL input and `Search` action;
- no feature cards, explainer copy, public directory, or secondary content.

The form is keyboard accessible, has a programmatic label even when the visible treatment relies on placeholder text, and reports validation errors adjacent to the input.

### Character page

The canonical page is:

```text
/characters/{region}/{realm}/{name}
```

It mirrors Raider.IO's region/realm/name path shape while remaining under the SlashWho domain.

The desktop page has:

- the slash-only header logo and `API` / `GitHub` links;
- breadcrumbs and the starting character's identity;
- a direct Raider.IO link;
- the most recent refresh time and current refresh state;
- a simple character list in the main column;
- a right-hand `Refresh history` sidebar.

Each character row displays:

- display name;
- region;
- realm;
- class;
- level;
- link to its canonical SlashWho page, which in turn links to Raider.IO.

The refresh-history sidebar displays each stored snapshot's exact date and time, returned character count, and `Complete` or `Partial` state. Selecting a snapshot shows the character list captured by that refresh. It does not show internal sources or compute added/removed labels.

On narrow screens, refresh history stacks below the character list.

### Visual tokens

The approved initial tokens are:

| Role | Value |
| --- | --- |
| Page background | `#09090f` |
| Raised surface | `#111119` |
| Border | `#22222d` |
| Primary text | `#f4f4f5` |
| Muted text | `#858594` |
| Frost-blue accent | `#38bdf8` |
| Accent ink | `#062a3c` |
| Successful refresh | `#22c55e` |
| Partial refresh | `#f59e0b` |

Focus treatments must remain visible against obsidian, and text/action combinations must meet WCAG AA contrast requirements.

## Architecture

SlashWho is a TypeScript monorepo with two deployable applications and shared packages:

```text
apps/
  web/        Next.js website and HTTP API
  worker/     Background discovery worker
packages/
  contracts/  Request, response, and job schemas
  domain/     Character identity and discovery rules
  raiderio/   Raider.IO client and normalization
  database/   PostgreSQL schema, queries, and migrations
tests/
  integration/
  e2e/
  fixtures/
```

The workspace uses pnpm and Node.js 22.12 or newer. Next.js App Router renders the site and implements API route handlers. Zod schemas in `packages/contracts` validate runtime input and output. Drizzle owns application schema and migrations. `pg-boss` stores and processes jobs in the same PostgreSQL database.

### Web/API service

The web service:

- renders the homepage and public character pages;
- parses and validates Raider.IO URLs;
- exposes `/api/v1` routes;
- applies anonymous and bot-specific rate limits;
- reads stored snapshots;
- creates or reuses refresh jobs;
- polls job status for the interactive page;
- never performs the full discovery workflow inside an HTTP request.

Application data is read from PostgreSQL rather than relying on Next.js's process-local cache, so a restart or later horizontal scaling cannot serve a divergent current snapshot.

### Worker service

The worker:

- consumes `discover-character` jobs through `pg-boss`;
- is the only component that runs the complete Raider.IO discovery workflow;
- normalizes and deduplicates characters;
- writes a new snapshot atomically after a trustworthy run;
- retries transient failures and reports progress through the discovery-run record;
- exits gracefully after finishing or returning an in-flight job to the durable queue.

### PostgreSQL

PostgreSQL is the only stateful dependency. It holds application data, rate-limit events, and the `pg-boss` queue. Redis is not part of the MVP.

Both applications run the same idempotent migration command at startup under a PostgreSQL advisory lock. This avoids relying on deployment ordering between Railway services: one process migrates while the other waits, then both verify the resulting schema version before accepting work.

## Character identity

The canonical key is the normalized tuple:

```text
region / realm-slug / character-name
```

- Region is lower-case and restricted to Raider.IO-supported regions.
- Realm is stored as Raider.IO's lower-case slug.
- Character name comparison is case-insensitive, while the latest upstream display casing is retained.
- Canonical routes use normalized values and redirect alternative casing or equivalent input to the canonical route.
- Every outbound Raider.IO URL is constructed from the normalized tuple, never concatenated from unvalidated input.

## Discovery workflow

1. Load the starting character from Raider.IO and confirm it exists.
2. Record the starting character.
3. Inspect its declared-main relationship. If present, record the main and pivot through it once.
4. Resolve the visible Raider.IO owner from the starting character and declared main.
5. For each validated owner, load its claimed-character list and record every returned character.
6. When the owner is privacy-hidden, try the cheap profile guesses used by SeriouslyCasualBotV2:
   - the public `discord_profile` value, when present;
   - the character name.
7. Accept a guessed profile only when the returned profile independently matches the public value used to validate it.
8. Normalize and deduplicate every result by canonical character key.

The worker keeps visited-character and visited-owner sets, follows a declared-main edge at most once per character, and enforces a configurable upstream-request cap with an initial default of 12 calls per job. Hitting the cap creates a `Partial` snapshot rather than continuing an unbounded traversal.

BattleTags, Discord handles, raw guess strings, and raw Raider.IO response bodies exist only in worker memory for the duration of a job and are neither stored nor logged.

## Freshness and background jobs

The freshness window is 24 hours from the latest trustworthy snapshot.

- A search with a fresh snapshot returns the current resource immediately and does not enqueue work.
- A search with no snapshot creates a job and directs the user to the canonical page's loading state.
- A stale page renders the previous snapshot immediately, creates or reuses a refresh job, and displays a non-blocking `Refreshing` state.
- Only one active job may exist for a canonical starting character.
- Duplicate browser and bot requests reuse that active job.

Discovery runs have these public states:

- `queued`
- `running`
- `retrying`
- `complete`
- `failed`

Successful snapshot states are:

- `complete`: the relevant Raider.IO ownership and claimed-character requests returned definitive results;
- `partial`: the workflow completed but privacy, a traversal cap, or another explicitly recorded limitation means more characters may exist.

An upstream transport failure is not `partial`. It is an unmeasured failure and does not create or replace a snapshot.

## API contract

All API payloads are JSON and validated against shared Zod schemas. Version one uses the `/api/v1` prefix.

### Create or reuse a search

```text
POST /api/v1/searches
```

Request:

```json
{
  "characterUrl": "https://raider.io/characters/eu/silvermoon/Ryii"
}
```

Responses:

- `200 OK` with the current character resource when the snapshot is fresh;
- `202 Accepted` with `jobId`, `status`, `statusUrl`, and canonical `characterUrl` when work is queued, active, or refreshing;
- `400 Bad Request` for malformed or unsupported URLs;
- `429 Too Many Requests` with `Retry-After` when the caller exceeds its search allowance.

The first upstream character lookup runs in the worker, so a previously unknown missing character is reported through the job resource as `failed` with public code `character_not_found`. A recently cached definitive missing result may be rejected synchronously with `404` to avoid repeatedly queuing the same lookup.

### Read job status

```text
GET /api/v1/searches/{jobId}
```

The response includes job state, canonical character URL, timestamps, retry timing when applicable, and a stable public error code. It never includes credentials, raw upstream responses, or private diagnostic context.

### Read the current character resource

```text
GET /api/v1/characters/{region}/{realm}/{name}
```

The response includes the root character, the latest snapshot state and refresh time, the current character list, and an active refresh job reference when one exists.

### Read refresh history

```text
GET /api/v1/characters/{region}/{realm}/{name}/history
```

The response is cursor-paginated and returns snapshot ID, exact refresh timestamp, `complete` or `partial` state, character count, and links for reading that snapshot. Snapshot character membership is immutable.

### Read one historical snapshot

```text
GET /api/v1/characters/{region}/{realm}/{name}/history/{snapshotId}
```

The response contains the immutable character membership and character fields observed during that refresh. The corresponding website route is `/characters/{region}/{realm}/{name}/history/{snapshotId}`.

## Data model

### `characters`

One row per canonical character:

- UUID primary key;
- region;
- realm slug;
- normalized name;
- latest display name;
- class;
- level;
- canonical Raider.IO URL;
- created and updated timestamps.

A unique constraint covers region, realm slug, and normalized name.

### `discovery_runs`

One row per public search job:

- UUID public job ID;
- root character key and resolved character ID;
- queue job ID;
- status;
- caller class (`anonymous` or `bot`), without storing a raw API key;
- attempt count and next retry time;
- stable public error code;
- created, started, and completed timestamps;
- resulting snapshot ID when successful.

A partial unique index permits only one active `queued`, `running`, or `retrying` run per canonical root character.

### `snapshots`

An immutable successful refresh:

- UUID primary key;
- root character ID;
- discovery-run ID;
- state (`complete` or `partial`);
- limitation code for a partial snapshot;
- exact refresh timestamp;
- character count.

### `snapshot_characters`

Immutable membership of a snapshot:

- snapshot ID;
- character ID;
- stable display order;
- internal discovery source (`input`, `claimed`, `declared_main`, or `profile_guess`).
- display name, class, level, and canonical Raider.IO URL as observed during that refresh.

The discovery source supports diagnostics but is omitted from public website and API responses.

### `suppressed_characters`

Characters excluded through the removal process:

- canonical character key;
- suppression timestamp;
- internal reason;
- optional expiry.

Suppressed characters return `404`, are removed from related lists, and are not rediscovered while suppression is active.

### `rate_limit_events`

Short-lived events keyed by a one-way hash of the caller bucket. Raw IP addresses and API keys are not stored. A scheduled cleanup removes expired events.

`pg-boss` owns its internal queue schema separately from application tables.

## Failure semantics

Expected absence and unmeasured data are distinct:

- invalid URL: synchronous `400`, no job;
- confirmed missing character: the initial background job fails with `character_not_found`; subsequent cached requests may return `404` synchronously;
- privacy-hidden owner: successful but potentially `partial` result;
- definitive empty claimed-character response: measured empty result;
- timeout, `429`, connection failure, or `5xx`: unknown, retry or fail without creating a snapshot;
- failed refresh with an older snapshot: retain and continue serving the older snapshot with its original time;
- failed first search: render a retryable error state, not an empty character list.

Transient `429` and `5xx` failures use bounded exponential backoff with jitter. Upstream `Retry-After` wins when present. The initial policy is five attempts within a maximum 30-minute job lifetime. Stable internal diagnostics are correlated by job ID, while the API exposes only safe error codes.

## Access control and abuse prevention

Public character and history reads are anonymous. Search creation has two caller classes:

- anonymous: initial allowance of 10 new or forced refresh jobs per IP bucket per hour;
- authenticated bot: initial allowance of 60 search jobs per API key per hour.

Cached reads have a higher general request limit and do not consume the search-job allowance.

The bot sends a Railway-managed secret as `Authorization: Bearer <key>`. The web browser never receives it. The service compares the configured secret in constant time, redacts authorization headers, and never logs the credential.

Client IP bucketing trusts only Railway's documented proxy boundary and does not accept an arbitrary user-supplied forwarded chain.

Rate values are configuration, not hard-coded domain rules, so they can be tuned from observed traffic without an API change.

## Privacy and suppression

SlashWho stores only public World of Warcraft character information and the fact that Raider.IO publicly linked characters at a particular refresh time. It does not expose or persist BattleTags, Discord handles, validation guesses, or raw Raider.IO responses.

The public `/privacy` page documents data sources, permanent snapshot retention, and a removal route through the repository's issue tracker. Removal is manually verified by the maintainer for the MVP. An accepted request creates a suppression entry and removes the character from public pages and future discovery results. A self-service identity or ownership system is outside the MVP.

Logs contain correlation IDs, endpoint categories, status codes, durations, and counts. They do not contain authorization headers, raw response bodies, Discord handles, BattleTags, or full request payloads.

## Testing strategy

### Unit tests with Vitest

- Raider.IO URL parsing and canonicalization.
- Character normalization and deduplication.
- Owner, declared-main, and profile-guess traversal.
- Cycle and request-cap handling.
- Freshness and active-job reuse decisions.
- Snapshot classification as complete, partial, or failed.
- Authentication and rate-limit policy.
- Suppression filtering.

Unit tests are colocated with packages and use no network or database.

### Integration tests with real PostgreSQL

Testcontainers starts a disposable PostgreSQL instance. Integration tests:

- apply migrations from an empty database;
- exercise repositories without mocking PostgreSQL;
- verify advisory-locked concurrent migration startup;
- create, claim, retry, complete, and fail `pg-boss` jobs;
- prove concurrent workers cannot process one job twice;
- prove duplicate searches reuse one active run;
- prove snapshot writes are atomic and immutable;
- prove a failed refresh preserves the previous snapshot;
- exercise suppression and rate-limit cleanup.

### Raider.IO contract fixtures

Recorded and sanitized fixtures cover:

- visible owner with claimed characters;
- privacy-hidden owner;
- declared-main pivot;
- valid and invalid profile guesses;
- missing character;
- rate limiting and transient server errors;
- upstream schema drift.

HTTP-boundary tests use those fixtures rather than mocking domain functions.

### API contract tests

- Validate request and response bodies against shared schemas.
- Exercise anonymous and bot-authenticated behavior.
- Verify status codes, `Retry-After`, cursor pagination, canonical URLs, and safe errors.
- Maintain a bot-client compatibility fixture for `/api/v1`.

### Browser tests with Playwright

- Submit a valid Raider.IO URL from the homepage.
- Redirect to the canonical character page.
- Render queued, running, retrying, complete, partial, and failed states.
- Show a stale snapshot immediately while refresh runs.
- Display the simple character list and dated refresh-history sidebar.
- Navigate to an older snapshot.
- Verify responsive stacking and keyboard operation.

### Live smoke tests

A very small list of known public Raider.IO characters runs manually or on a schedule. Live upstream tests never gate a pull request because external availability and private endpoint behavior would make CI nondeterministic.

### CI gate

The required `ci` check runs:

1. format verification;
2. lint;
3. TypeScript type checking;
4. unit tests;
5. PostgreSQL integration tests;
6. production builds for web and worker;
7. the critical Playwright search journey.

Once the workflow exists, both `main` and `prod` rulesets require the `ci` status before updates.

## Railway deployment

Each Railway environment contains:

- one Next.js web/API service;
- one Node.js worker service;
- one PostgreSQL service.

`main` deploys to a persistent staging environment. `prod` deploys to production after `main` has been validated and fast-forwarded. Staging and production use isolated databases and secrets.

The web and worker use private-network `DATABASE_URL` references. Only the web service receives a public domain. The database is not exposed publicly for normal operation.

Production enables scheduled volume backups before public launch. Point-in-time recovery is optional at MVP traffic but can be enabled without changing the application design.

The worker handles `SIGTERM`, stops claiming new jobs, and gives in-flight work a bounded drain period. Both services retry initial database connection because Railway may start services independently.

## Observability

Structured logs include:

- correlation and discovery-run IDs;
- normalized root character key;
- phase name;
- upstream endpoint category, never raw URL query data;
- attempt, duration, status class, and result counts;
- final snapshot state and limitation code.

Initial health endpoints report process health and database connectivity. Worker readiness additionally confirms queue initialization. Metrics of interest are queued-job age, job duration, retry rate, upstream `429` rate, complete/partial/failure counts, cache freshness, and snapshot growth.

## Acceptance criteria

The MVP is ready for staging validation when:

1. A valid Raider.IO URL creates or reuses a durable job and redirects to its canonical character page.
2. The worker discovers all characters exposed by the approved Raider.IO-only signal chain.
3. The current page displays name, region, realm, class, level, and links for deduplicated characters.
4. Fresh results are reused for 24 hours; stale results display immediately while one refresh job runs.
5. Successful refreshes create immutable permanent snapshots visible as dated refresh history.
6. An upstream failure never replaces valid data with an empty snapshot.
7. Anonymous and bot-authenticated limits are independent and return correct retry information.
8. Suppressed characters are absent from pages, API responses, and later discovery.
9. The homepage and character page match the approved flat-obsidian, frost-blue, slash-only visual direction on desktop and mobile.
10. CI passes formatting, linting, type checking, unit, integration, build, and critical browser checks.
11. Staging runs separate web, worker, and PostgreSQL services on Railway.
12. SeriouslyCasualBotV2 can create a search and poll/read results using the authenticated `/api/v1` contract.

## Future extensions

The durable job, snapshot, and API model intentionally leaves room for:

- Blizzard achievement-fingerprint discovery;
- richer confidence and provenance views;
- guild history and Mythic raid logs;
- notification callbacks instead of polling;
- third-party API keys and developer management;
- a dedicated API service if web/API scaling needs diverge;
- Redis only if measured contention or rate-limiting requirements justify it.

These extensions require separate designs and do not expand the MVP.
