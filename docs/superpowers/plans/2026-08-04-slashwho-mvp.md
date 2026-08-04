# SlashWho MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved SlashWho MVP as a public Next.js website and versioned API backed by a durable PostgreSQL discovery worker, with immutable refresh history and Railway-ready staging and production deployments.

**Architecture:** Build one TypeScript pnpm workspace containing a thin Next.js web/API adapter, a separate pg-boss worker, and five shared packages. Keep character/discovery rules pure in `domain`, upstream I/O in `raiderio`, persistence and queue ownership in `database`, public wire formats in `contracts`, and use-case orchestration in `application`. Every HTTP and worker entry point composes those modules; neither owns business rules.

**Tech Stack:** Node.js 22.12+, pnpm 11, TypeScript 7, Next.js 16, React 19, Zod 4, Drizzle ORM, PostgreSQL 16, pg-boss 12, Vitest 4, Testcontainers 12, Playwright 1.62, ESLint 10, Prettier 3, Pino 10.

## Global Constraints

- Preserve the canonical key `region/realm-slug/normalized-name`; retain upstream display casing separately.
- Store no BattleTags, Discord handles, guess strings, raw IPs, API keys, or raw Raider.IO bodies.
- Never create a snapshot from an upstream transport, `429`, or `5xx` failure.
- Make successful snapshots immutable and replace the current view only after an atomic commit.
- Enforce one active discovery run per root character in PostgreSQL, not process memory.
- Use recorded, sanitized Raider.IO fixtures in automated tests; live upstream checks never gate pull requests.
- Read all operational limits from validated environment configuration.
- Keep route handlers, React pages, and the worker entry point thin enough to test orchestration below the framework boundary.
- Complete each task with a focused commit and do not combine later refactors into an earlier task.

## Responsibility and Interface Map

```text
apps/web
  Next.js pages + route handlers
      -> packages/application (web-facing orchestration)
      -> packages/contracts (parse/serialize public JSON)

apps/worker
  pg-boss process lifecycle
      -> packages/application (job orchestration)
      -> packages/raiderio (upstream gateway)

packages/application
  search creation, freshness, auth, rate limiting, refresh execution
      -> packages/domain (pure identity/discovery policy)
      -> packages/database (ports implemented by PostgreSQL)

packages/domain
  CharacterKey, discovery traversal, snapshot outcome; no I/O

packages/raiderio
  RaiderIoGateway implementation; raw payloads never leave package

packages/database
  Drizzle schema, migrations, repositories, pg-boss adapter

packages/contracts
  Zod schemas and inferred API/job types; no application dependencies
```

The design listed four shared packages. This plan adds `packages/application` as the composition layer so framework adapters do not import concrete SQL queries or duplicate orchestration. It consumes the other packages and exposes these stable seams:

```ts
export interface SearchService {
  create(input: CreateSearchCommand): Promise<CreateSearchResult>;
  getRun(jobId: string): Promise<PublicDiscoveryRun | null>;
  getCurrent(key: CharacterKey): Promise<CharacterResource | null>;
  getHistory(key: CharacterKey, cursor?: string): Promise<HistoryPage | null>;
  getSnapshot(
    key: CharacterKey,
    snapshotId: string,
  ): Promise<SnapshotResource | null>;
}

export interface DiscoveryJobHandler {
  execute(runId: string): Promise<void>;
}
```

---

### Task 1: Establish the reproducible workspace and green skeleton

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml` (generated)
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.npmrc`
- Create: `.env.example`
- Create: `vitest.workspace.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/health/route.ts`
- Create: `apps/web/src/app/health/route.test.ts`
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/main.ts`
- Create: `packages/{contracts,domain,raiderio,database,application}/package.json`
- Create: `packages/{contracts,domain,raiderio,database,application}/tsconfig.json`
- Create: `packages/{contracts,domain,raiderio,database,application}/src/index.ts`

- [ ] **Step 1: Add a failing framework-boundary test**

```ts
// apps/web/src/app/health/route.test.ts
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /health", () => {
  it("reports process liveness without leaking configuration", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 2: Run it and confirm the missing workspace/route failure**

Run: `corepack pnpm vitest apps/web/src/app/health/route.test.ts`

Expected: FAIL because the workspace and `route.ts` do not exist.

- [ ] **Step 3: Create the workspace manifests and minimal applications**

Use exact package pins from the generated lockfile. Root scripts must be:

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm --parallel --filter @slashwho/web --filter @slashwho/worker dev",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "playwright test"
  },
  "engines": { "node": ">=22.12 <23" },
  "packageManager": "pnpm@11.20.0"
}
```

The route implementation is intentionally process-only:

```ts
// apps/web/src/app/health/route.ts
export function GET(): Response {
  return Response.json({ status: "ok" });
}
```

The worker entry point should only prove startup wiring at this stage:

```ts
// apps/worker/src/main.ts
export async function main(): Promise<void> {
  process.stdout.write(JSON.stringify({ event: "worker_boot" }) + "\n");
}

if (process.env.NODE_ENV !== "test") void main();
```

- [ ] **Step 4: Install, format, and run all baseline checks**

Run: `corepack pnpm install`

Run: `corepack pnpm format`

Run: `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build`

Expected: all commands pass and Next.js produces a production build.

- [ ] **Step 5: Commit the skeleton**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.mjs .prettierrc.json .prettierignore .npmrc .env.example vitest.workspace.ts apps packages
git commit -m "chore: scaffold SlashWho workspace"
```

---

### Task 2: Define public contracts and canonical character identity

**Files:**

- Create: `packages/contracts/src/character.ts`
- Create: `packages/contracts/src/search.ts`
- Create: `packages/contracts/src/history.ts`
- Create: `packages/contracts/src/errors.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/contracts.test.ts`
- Create: `packages/domain/src/character-key.ts`
- Create: `packages/domain/src/character-key.test.ts`
- Modify: `packages/domain/src/index.ts`

**Produces:** `CharacterKey`, `parseRaiderIoCharacterUrl`, `toRaiderIoUrl`, and Zod schemas/types for every `/api/v1` payload.

- [ ] **Step 1: Write failing identity and contract tests**

```ts
// packages/domain/src/character-key.test.ts
import { describe, expect, it } from "vitest";
import { parseRaiderIoCharacterUrl, toCharacterPath } from "./character-key";

it("canonicalizes a Raider.IO character URL", () => {
  const key = parseRaiderIoCharacterUrl(
    "https://raider.io/characters/EU/Silvermoon/Ryii/",
  );
  expect(key).toEqual({ region: "eu", realm: "silvermoon", name: "ryii" });
  expect(toCharacterPath(key)).toBe("/characters/eu/silvermoon/ryii");
});

it.each([
  "https://example.com/characters/eu/silvermoon/ryii",
  "https://raider.io/guilds/eu/silvermoon/example",
  "https://raider.io/characters/xx/silvermoon/ryii",
  "https://user@raider.io/characters/eu/silvermoon/ryii",
])("rejects unsupported input: %s", (value) => {
  expect(() => parseRaiderIoCharacterUrl(value)).toThrow(
    "invalid_character_url",
  );
});
```

```ts
// packages/contracts/src/contracts.test.ts
import { expect, it } from "vitest";
import { createSearchResponseSchema, characterResourceSchema } from "./index";

it("rejects internal provenance in a public character response", () => {
  const value = validCharacterResourceFixture({ source: "profile_guess" });
  expect(characterResourceSchema.safeParse(value).success).toBe(false);
});

it("accepts queued and cached search outcomes", () => {
  expect(createSearchResponseSchema.parse(queuedSearchFixture()).kind).toBe(
    "job",
  );
  expect(createSearchResponseSchema.parse(cachedSearchFixture()).kind).toBe(
    "character",
  );
});
```

- [ ] **Step 2: Run the focused unit tests and verify failure**

Run: `corepack pnpm vitest packages/domain/src/character-key.test.ts packages/contracts/src/contracts.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 3: Implement the canonical parser and exhaustive public schemas**

```ts
// packages/domain/src/character-key.ts
export const supportedRegions = ["us", "eu", "kr", "tw"] as const;
export type Region = (typeof supportedRegions)[number];
export type CharacterKey = Readonly<{
  region: Region;
  realm: string;
  name: string;
}>;

export function parseRaiderIoCharacterUrl(input: string): CharacterKey {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid_character_url");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "raider.io" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid_character_url");
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length !== 4 || parts[0].toLowerCase() !== "characters")
    throw new Error("invalid_character_url");
  const [region, realm, name] = parts
    .slice(1)
    .map((part) => part.toLocaleLowerCase("en-US"));
  if (
    !supportedRegions.includes(region as Region) ||
    !/^[a-z0-9-]+$/.test(realm) ||
    !/^[\p{L}\p{M}'-]+$/u.test(name)
  ) {
    throw new Error("invalid_character_url");
  }
  return { region: region as Region, realm, name };
}
```

Define a strict discriminated response and use it everywhere:

```ts
export const createSearchResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("character"),
      character: characterResourceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("job"),
      jobId: z.string().uuid(),
      status: discoveryRunStatusSchema,
      statusUrl: z.string().startsWith("/api/v1/searches/"),
      characterUrl: z.string().startsWith("/characters/"),
    })
    .strict(),
]);
```

Include schemas for search request, job status, current character resource, cursor history page, historical snapshot, and safe API error. Export inferred types from the package root.

- [ ] **Step 4: Prove canonicalization and wire-format safety**

Run: `corepack pnpm --filter @slashwho/domain test && corepack pnpm --filter @slashwho/contracts test && corepack pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit contracts and identity**

```bash
git add packages/contracts packages/domain
git commit -m "feat: define character identity and API contracts"
```

---

### Task 3: Create the PostgreSQL schema, migrations, and repository contract

**Files:**

- Create: `packages/database/drizzle.config.ts`
- Create: `packages/database/src/schema.ts`
- Create: `packages/database/src/client.ts`
- Create: `packages/database/src/migrate.ts`
- Create: `packages/database/src/repositories.ts`
- Create: `packages/database/src/postgres-repositories.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/drizzle/0000_initial.sql` (generated, then reviewed)
- Create: `tests/integration/postgres.ts`
- Create: `tests/integration/migrations.test.ts`
- Create: `tests/integration/repositories.test.ts`

**Consumes:** `CharacterKey` and public snapshot types.

**Produces:** `Repositories`, `runMigrations(pool)`, and transaction-safe persistence methods used by web and worker.

- [ ] **Step 1: Write failing real-PostgreSQL integration tests**

Start PostgreSQL once per test file with `PostgreSqlContainer("postgres:16-alpine")`. Test empty migration, two concurrent `runMigrations` calls, active-run reuse, immutable snapshots, failed-refresh preservation, suppression filtering, cursor history, and expired rate-event cleanup.

```ts
it("reuses one active run under concurrent requests", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      repositories.runs.createOrReuse(key, "anonymous"),
    ),
  );
  expect(new Set(results.map((result) => result.id))).toHaveSize(1);
});

it("does not replace the latest snapshot when a refresh fails", async () => {
  const previous = await seedCompleteSnapshot(repositories);
  const run = await repositories.runs.createOrReuse(
    previous.rootKey,
    "anonymous",
  );
  await repositories.runs.fail(run.id, "upstream_unavailable");
  expect((await repositories.snapshots.getCurrent(previous.rootKey))?.id).toBe(
    previous.id,
  );
});
```

- [ ] **Step 2: Run integration tests and confirm failure before schema exists**

Run: `corepack pnpm vitest --project integration tests/integration/migrations.test.ts tests/integration/repositories.test.ts`

Expected: FAIL on missing database exports. Docker must be running; if unavailable, stop and report the environmental prerequisite rather than weakening the tests.

- [ ] **Step 3: Define schema and generate the initial migration**

Implement the six application tables from the design plus a dedicated `negative_character_cache` table. The generated SQL must contain these invariants:

```sql
CREATE UNIQUE INDEX characters_canonical_key_idx
  ON characters (region, realm_slug, normalized_name);

CREATE UNIQUE INDEX discovery_runs_one_active_root_idx
  ON discovery_runs (root_region, root_realm_slug, root_normalized_name)
  WHERE status IN ('queued', 'running', 'retrying');

ALTER TABLE snapshots
  ADD CONSTRAINT snapshots_state_limitation_check CHECK (
    (state = 'complete' AND limitation_code IS NULL) OR
    (state = 'partial' AND limitation_code IS NOT NULL)
  );

CREATE UNIQUE INDEX snapshot_characters_membership_idx
  ON snapshot_characters (snapshot_id, character_id);
```

Snapshot observations (`display_name`, `class_name`, `level`, `raider_io_url`) belong on `snapshot_characters`, while `characters` keeps only the latest observed values. Add a negative-result expiry to `characters` or a dedicated `negative_character_cache` table; use the dedicated table so confirmed absence never masquerades as a character.

- [ ] **Step 4: Implement repositories and advisory-locked migration startup**

```ts
export interface Repositories {
  runs: {
    createOrReuse(
      key: CharacterKey,
      caller: CallerClass,
    ): Promise<DiscoveryRun>;
    markRunning(id: string): Promise<void>;
    markRetrying(id: string, attempt: number, nextRetryAt: Date): Promise<void>;
    complete(id: string, snapshotId: string): Promise<void>;
    fail(id: string, code: PublicErrorCode): Promise<void>;
    find(id: string): Promise<DiscoveryRun | null>;
    findActive(key: CharacterKey): Promise<DiscoveryRun | null>;
  };
  snapshots: SnapshotRepository;
  suppressions: SuppressionRepository;
  rateLimits: RateLimitRepository;
  negativeCache: NegativeCacheRepository;
}
```

```ts
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [0x534c4153]);
    await migrate(drizzle(client), {
      migrationsFolder: resolveMigrationsFolder(),
    });
  } finally {
    await client
      .query("SELECT pg_advisory_unlock($1)", [0x534c4153])
      .catch(() => undefined);
    client.release();
  }
}
```

Write a snapshot and all membership rows in one database transaction. Reject update/delete operations for snapshots from the public repository surface.

- [ ] **Step 5: Run migration and repository integration coverage**

Run: `corepack pnpm vitest --project integration tests/integration/migrations.test.ts tests/integration/repositories.test.ts`

Run: `corepack pnpm typecheck`

Expected: PASS, including repeated migration and concurrency tests.

- [ ] **Step 6: Commit persistence**

```bash
git add packages/database tests/integration
git commit -m "feat: add durable discovery persistence"
```

---

### Task 4: Implement the sanitized Raider.IO gateway

**Files:**

- Create: `packages/raiderio/src/types.ts`
- Create: `packages/raiderio/src/errors.ts`
- Create: `packages/raiderio/src/client.ts`
- Create: `packages/raiderio/src/normalize.ts`
- Modify: `packages/raiderio/src/index.ts`
- Create: `packages/raiderio/src/client.test.ts`
- Create: `tests/fixtures/raiderio/{character-visible-owner,character-private-owner,character-declared-main,profile-valid,profile-invalid,claimed-characters,missing-character,rate-limited,server-error,schema-drift}.json`

**Produces:** an implementation of this I/O port:

```ts
export interface RaiderIoGateway {
  getCharacter(key: CharacterKey): Promise<RaiderIoCharacter>;
  getClaimedCharacters(ownerId: string): Promise<readonly RaiderIoCharacter[]>;
  resolveProfileGuess(value: string): Promise<RaiderIoProfile | null>;
}
```

- [ ] **Step 1: Add failing fixture-driven HTTP-boundary tests**

Build a `fixtureFetch` that matches endpoint category and returns a real `Response`. Assert normalization, declared-main extraction, owner privacy, independent profile-match validation, `Retry-After`, missing-character classification, transient errors, and schema drift.

```ts
it("classifies a 429 as retryable and preserves Retry-After", async () => {
  const client = createRaiderIoClient({ fetch: fixtureFetch("rate-limited") });
  await expect(client.getCharacter(ryii)).rejects.toMatchObject({
    kind: "transient",
    retryAfterMs: 30_000,
  });
});

it("does not expose raw profile validation values", async () => {
  const result = await client.resolveProfileGuess("sensitive-value");
  expect(JSON.stringify(result)).not.toContain("sensitive-value");
});
```

- [ ] **Step 2: Run tests and verify the gateway is absent**

Run: `corepack pnpm vitest packages/raiderio/src/client.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement endpoint calls, Zod boundary parsing, and safe errors**

```ts
export type RaiderIoFailure =
  | { kind: "not_found" }
  | { kind: "transient"; status?: number; retryAfterMs?: number }
  | { kind: "schema_drift" };

export function createRaiderIoClient(options: {
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  timeoutMs: number;
}): RaiderIoGateway;
```

Use an `AbortSignal.timeout`, validate each raw response inside this package, map it immediately to normalized values, and discard the raw object. Construct outbound paths from a validated `CharacterKey`. Do not attach raw bodies or private lookup values to thrown errors.

- [ ] **Step 4: Run package tests and a privacy-string scan**

Run: `corepack pnpm --filter @slashwho/raiderio test && corepack pnpm typecheck`

Run: `rg -n "battletag|discord_profile|rawBody|responseBody" packages apps --glob '!**/*.test.ts'`

Expected: tests pass; matches are limited to transient worker-memory parsing fields in `raiderio` and contain no logging or persistence.

- [ ] **Step 5: Commit the gateway and sanitized fixtures**

```bash
git add packages/raiderio tests/fixtures/raiderio
git commit -m "feat: add Raider.IO gateway"
```

---

### Task 5: Build the bounded discovery engine as a pure domain workflow

**Files:**

- Create: `packages/domain/src/discovery.ts`
- Create: `packages/domain/src/discovery.test.ts`
- Create: `packages/domain/src/deduplicate.ts`
- Create: `packages/domain/src/deduplicate.test.ts`
- Modify: `packages/domain/src/index.ts`

**Consumes:** the `RaiderIoGateway` port and `CharacterKey`.

**Produces:** `discoverCharacter(root, gateway, options): Promise<DiscoveryOutcome>`.

- [ ] **Step 1: Write failing traversal-table tests**

Cover visible owner, claimed characters, one declared-main pivot, privacy-hidden owner, valid and invalid guesses, cycles, duplicate characters, suppressed results, request cap, confirmed absence, and transport failure.

```ts
it("pivots through a declared main once and deduplicates the result", async () => {
  const outcome = await discoverCharacter(
    altKey,
    scriptedGateway({
      characterEdges: [
        [altKey, mainCharacter],
        [mainKey, mainCharacter],
      ],
      claimed: [altCharacter, mainCharacter, secondAlt],
    }),
    { requestCap: 12, isSuppressed: async () => false },
  );

  expect(outcome.kind).toBe("snapshot");
  expect(outcome.characters.map((item) => item.key)).toEqual([
    altKey,
    mainKey,
    secondAltKey,
  ]);
});

it("returns failure rather than a partial snapshot on transport failure", async () => {
  const outcome = await discoverCharacter(
    altKey,
    throwingGateway("transient"),
    options,
  );
  expect(outcome).toEqual({
    kind: "failure",
    code: "upstream_unavailable",
    retryable: true,
  });
});
```

- [ ] **Step 2: Run the domain tests and verify failure**

Run: `corepack pnpm vitest packages/domain/src/discovery.test.ts packages/domain/src/deduplicate.test.ts`

Expected: FAIL on missing workflow.

- [ ] **Step 3: Implement an explicit outcome type and request budget**

```ts
export type DiscoveryOutcome =
  | {
      kind: "snapshot";
      state: "complete";
      characters: readonly DiscoveredCharacter[];
    }
  | {
      kind: "snapshot";
      state: "partial";
      limitationCode: "privacy_hidden" | "request_cap";
      characters: readonly DiscoveredCharacter[];
    }
  | {
      kind: "failure";
      code:
        | "character_not_found"
        | "upstream_unavailable"
        | "upstream_schema_changed";
      retryable: boolean;
    };

export async function discoverCharacter(
  root: CharacterKey,
  gateway: RaiderIoGateway,
  options: {
    requestCap: number;
    isSuppressed(key: CharacterKey): Promise<boolean>;
  },
): Promise<DiscoveryOutcome>;
```

Use `visitedCharacters`, `visitedOwners`, and a monotonically decreasing request budget. Keep the output order stable: input, declared main, then claimed/profile results sorted by region, realm, and normalized name. Record provenance only in `DiscoveredCharacter.source`; later public serializers must omit it.

- [ ] **Step 4: Run every domain permutation**

Run: `corepack pnpm --filter @slashwho/domain test && corepack pnpm typecheck`

Expected: PASS with no network or database access.

- [ ] **Step 5: Commit discovery policy**

```bash
git add packages/domain
git commit -m "feat: implement bounded character discovery"
```

---

### Task 6: Connect pg-boss and implement the durable worker lifecycle

**Files:**

- Create: `packages/database/src/queue.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/application/src/discovery-job-handler.ts`
- Create: `packages/application/src/discovery-job-handler.test.ts`
- Modify: `packages/application/src/index.ts`
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/logger.ts`
- Create: `apps/worker/src/logger.test.ts`
- Create: `apps/worker/src/health-server.ts`
- Create: `apps/worker/src/health-server.test.ts`
- Create: `apps/worker/src/runtime.ts`
- Create: `apps/worker/src/runtime.test.ts`
- Modify: `apps/worker/src/main.ts`
- Create: `tests/integration/queue.test.ts`
- Create: `tests/integration/snapshot-atomicity.test.ts`

**Produces:** `DiscoveryQueue.enqueue(runId, key)`, one `discover-character` consumer, bounded retry scheduling, and graceful shutdown.

- [ ] **Step 1: Write failing handler and queue integration tests**

```ts
it("atomically persists a trustworthy snapshot and completes the run", async () => {
  gateway.result = completeOutcome;
  await handler.execute(run.id);
  await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
    status: "complete",
  });
  await expect(
    repositories.snapshots.getCurrent(rootKey),
  ).resolves.toMatchObject({ characterCount: 3 });
});

it("keeps the old snapshot when the gateway becomes unavailable", async () => {
  const old = await seedCompleteSnapshot(repositories);
  gateway.result = transientFailure;
  await expect(handler.execute(refreshRun.id)).rejects.toMatchObject({
    retryable: true,
  });
  expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(old.id);
});
```

In `queue.test.ts`, start two pg-boss workers and assert one handler invocation for one job; assert create/claim/retry/complete/fail transitions and the configured five-attempt/30-minute ceiling.

- [ ] **Step 2: Run focused unit and integration tests; verify missing adapters**

Run: `corepack pnpm vitest packages/application/src/discovery-job-handler.test.ts apps/worker/src/runtime.test.ts`

Run: `corepack pnpm vitest --project integration tests/integration/queue.test.ts tests/integration/snapshot-atomicity.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement queue and handler composition**

```ts
export interface DiscoveryQueue {
  start(): Promise<void>;
  enqueue(payload: { runId: string; key: CharacterKey }): Promise<string>;
  work(
    handler: (payload: DiscoverCharacterJob) => Promise<void>,
  ): Promise<void>;
  stop(options: { graceful: boolean; timeoutMs: number }): Promise<void>;
  isReady(): boolean;
}
```

Configure the queue explicitly before sending work:

```ts
await boss.start();
await boss.createQueue("discover-character");
await boss.work<DiscoverCharacterJob>("discover-character", async ([job]) => {
  await handler.execute(job.data.runId);
});
```

The application handler owns status transitions. On a retryable failure it calculates bounded exponential delay with jitter, respects a longer upstream `Retry-After`, calls `markRetrying`, then throws for pg-boss retry. On definitive absence it writes the negative cache and marks the run failed. On snapshot outcomes it uses one transaction to upsert observations, write membership, and complete the run.

- [ ] **Step 4: Implement startup, readiness, and SIGTERM drain**

`createWorkerRuntime(config)` must connect with bounded startup retries, run migrations, initialize pg-boss, register work, and expose `health()` plus `stop()`. Bind a small HTTP health server to `PORT`: `/health` reports process liveness and `/ready` returns success only after database and queue initialization. `main.ts` installs `SIGTERM`/`SIGINT` once and gives in-flight work `WORKER_DRAIN_TIMEOUT_MS` before returning jobs to the queue. Configure Pino redaction for `authorization`, `cookie`, request bodies, and any field matching owner/profile validation values; the logger test must assert a unique secret marker is absent from captured output.

- [ ] **Step 5: Prove concurrency, retries, atomicity, and shutdown**

Run: `corepack pnpm vitest packages/application/src/discovery-job-handler.test.ts apps/worker/src/runtime.test.ts`

Run: `corepack pnpm vitest --project integration tests/integration/queue.test.ts tests/integration/snapshot-atomicity.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit durable execution**

```bash
git add packages/database packages/application apps/worker tests/integration
git commit -m "feat: add durable discovery worker"
```

---

### Task 7: Add search policy, bot authentication, rate limiting, and suppression

**Files:**

- Create: `packages/application/src/config.ts`
- Create: `packages/application/src/auth.ts`
- Create: `packages/application/src/auth.test.ts`
- Create: `packages/application/src/rate-limit.ts`
- Create: `packages/application/src/rate-limit.test.ts`
- Create: `packages/application/src/search-service.ts`
- Create: `packages/application/src/search-service.test.ts`
- Create: `packages/application/src/serializers.ts`
- Create: `packages/application/src/serializers.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`
- Create: `tests/integration/search-service.test.ts`
- Create: `tests/integration/suppression.test.ts`

**Produces:** the `SearchService` interface from the responsibility map and safe caller classification.

- [ ] **Step 1: Write failing policy tests**

Test fresh cache -> `200` resource/no queue; stale cache -> old resource plus one refresh job; empty cache -> job; duplicate requests -> same run; recent negative -> not found; raw IP/key never stored; bot and anonymous buckets independent; suppression returns not found and filters related characters.

```ts
it("serves stale data immediately and reuses one refresh", async () => {
  clock.setSystemTime("2026-08-04T12:00:00Z");
  await seedSnapshot({ refreshedAt: "2026-08-03T11:59:59Z" });
  const [first, second] = await Promise.all([
    service.create(command),
    service.create(command),
  ]);
  expect(first).toMatchObject({
    kind: "job",
    staleCharacter: expect.any(Object),
  });
  expect(second).toMatchObject({ kind: "job", jobId: first.jobId });
  expect(queue.enqueued).toHaveLength(1);
});
```

- [ ] **Step 2: Run policy tests and confirm failure**

Run: `corepack pnpm vitest packages/application/src/{auth,rate-limit,search-service,serializers}.test.ts`

Run: `corepack pnpm vitest --project integration tests/integration/search-service.test.ts tests/integration/suppression.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement validated configuration and constant-time authentication**

```ts
export const applicationConfigSchema = z.object({
  BOT_API_KEY: z.string().min(32),
  RATE_LIMIT_HASH_SECRET: z.string().min(32),
  ANONYMOUS_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(10),
  BOT_SEARCHES_PER_HOUR: z.coerce.number().int().positive().default(60),
  PUBLIC_READS_PER_MINUTE: z.coerce.number().int().positive().default(300),
  FRESHNESS_HOURS: z.coerce.number().positive().default(24),
  NEGATIVE_CACHE_MINUTES: z.coerce.number().positive().default(15),
  DISCOVERY_REQUEST_CAP: z.coerce.number().int().positive().default(12),
});
```

Hash rate buckets as `HMAC-SHA256(secret, "anonymous:" + trustedClientIp)` or `HMAC-SHA256(secret, "bot:" + stableKeyId)`. Compare equal-length bearer-key digests with `timingSafeEqual`; do not log the header or derived digest. An invalid Bearer credential returns `401` and is never silently downgraded to anonymous. Accept one Railway-set trusted client-IP header chosen from verified deployment documentation, never an arbitrary forwarded chain. Track cached/public reads in a separate, much higher-capacity bucket so they do not consume search-job allowance.

- [ ] **Step 4: Implement freshness, queue reuse, safe serialization, and cleanup**

Make `create()` reserve a rate event and active run in one transaction only when new work is actually needed. If enqueue fails, mark the reserved run failed safely so a later request can retry. Add `cleanupExpired(now)` for rate events, negative cache, and expired suppressions, then register a pg-boss `maintenance-cleanup` schedule from the worker runtime and prove repeated scheduling remains idempotent. Serialize allowlisted fields through Zod `.parse()` before returning them from the application package. Use a stable `(refreshedAt, snapshotId)` tuple for opaque history cursors so equal timestamps cannot skip or duplicate rows.

- [ ] **Step 5: Run all application and PostgreSQL policy tests**

Run: `corepack pnpm --filter @slashwho/application test`

Run: `corepack pnpm vitest --project integration tests/integration/search-service.test.ts tests/integration/suppression.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit application policy**

```bash
git add packages/application tests/integration
git commit -m "feat: add search security and freshness policy"
```

---

### Task 8: Expose the versioned API through thin Next.js route handlers

**Files:**

- Create: `apps/web/src/server/config.ts`
- Create: `apps/web/src/server/container.ts`
- Create: `apps/web/src/server/http.ts`
- Create: `apps/web/src/server/http.test.ts`
- Create: `apps/web/src/server/logger.ts`
- Create: `apps/web/src/server/logger.test.ts`
- Create: `apps/web/src/app/api/v1/searches/route.ts`
- Create: `apps/web/src/app/api/v1/searches/[jobId]/route.ts`
- Create: `apps/web/src/app/api/v1/characters/[region]/[realm]/[name]/route.ts`
- Create: `apps/web/src/app/api/v1/characters/[region]/[realm]/[name]/history/route.ts`
- Create: `apps/web/src/app/api/v1/characters/[region]/[realm]/[name]/history/[snapshotId]/route.ts`
- Create: `apps/web/src/app/ready/route.ts`
- Create: `apps/web/src/app/api/v1/api-contract.test.ts`
- Create: `tests/fixtures/contracts/bot-client-v1.json`

**Consumes:** `SearchService` and `contracts` only from route handlers.

- [ ] **Step 1: Write failing API contract tests**

Instantiate handlers with a test container/service override. Cover `200`, `202`, `400`, cached `404`, suppressed `404`, `429` plus `Retry-After`, all job states, cursor pagination, canonical redirects, stale payload with active job, historical membership, bot auth, and safe error bodies.

```ts
it("returns a schema-valid 202 with Location for queued work", async () => {
  const response = await POST(jsonRequest({ characterUrl: RYII_URL }));
  expect(response.status).toBe(202);
  expect(response.headers.get("location")).toMatch(/^\/api\/v1\/searches\//);
  expect(createSearchResponseSchema.parse(await response.json())).toMatchObject(
    { kind: "job" },
  );
});

it("does not echo malformed input", async () => {
  const response = await POST(jsonRequest({ characterUrl: "secret-marker" }));
  expect(JSON.stringify(await response.json())).not.toContain("secret-marker");
});
```

- [ ] **Step 2: Run the contract suite and verify routes are missing**

Run: `corepack pnpm vitest apps/web/src/app/api/v1/api-contract.test.ts apps/web/src/server/http.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement one HTTP result mapper and thin route adapters**

```ts
export async function POST(request: Request): Promise<Response> {
  const body = createSearchRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) return apiError(400, "invalid_character_url");
  const result = await getContainer().searches.create(
    toCommand(request, body.data),
  );
  return createSearchHttpResponse(result);
}
```

For Next.js 16 dynamic routes, await route params:

```ts
export async function GET(
  request: Request,
  context: { params: Promise<{ region: string; realm: string; name: string }> },
): Promise<Response> {
  const key = parseRouteKey(await context.params);
  return currentCharacterHttpResponse(
    await getContainer().searches.getCurrent(key),
  );
}
```

Set `Cache-Control: public, max-age=60, stale-while-revalidate=300` only on successful read resources; search/job/status responses are `no-store`. Apply the independent public-read limit to character and history routes. Add correlation IDs and allowlist structured logs containing endpoint category, status, duration, and counts—not full input URLs. The logger test must prove authorization, cookies, request payloads, BattleTags, Discord/profile values, and raw upstream bodies are redacted. The web container must run the shared advisory-locked migrations before becoming ready; `/ready` queries `SELECT 1`, while `/health` remains process-only.

- [ ] **Step 4: Lock the bot-facing compatibility fixture**

Store representative request and response bodies for every `/api/v1` endpoint in `tests/fixtures/contracts/bot-client-v1.json`; test each body with the shared schemas. This is the artifact SeriouslyCasualBotV2 will consume during its later integration.

- [ ] **Step 5: Run API, type, and production-build verification**

Run: `corepack pnpm vitest apps/web/src/app/api/v1/api-contract.test.ts apps/web/src/server/http.test.ts`

Run: `corepack pnpm typecheck && corepack pnpm --filter @slashwho/web build`

Expected: PASS.

- [ ] **Step 6: Commit the API**

```bash
git add apps/web tests/fixtures/contracts
git commit -m "feat: expose SlashWho API v1"
```

---

### Task 9: Build the approved homepage, character view, and refresh history

**Files:**

- Create: `apps/web/src/app/globals.css`
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/components/logo.tsx`
- Create: `apps/web/src/components/site-header.tsx`
- Create: `apps/web/src/components/search-form.tsx`
- Create: `apps/web/src/components/search-form.test.tsx`
- Create: `apps/web/src/components/character-list.tsx`
- Create: `apps/web/src/components/refresh-history.tsx`
- Create: `apps/web/src/components/refresh-state.tsx`
- Create: `apps/web/src/components/character-view.test.tsx`
- Create: `apps/web/src/app/characters/[region]/[realm]/[name]/page.tsx`
- Create: `apps/web/src/app/characters/[region]/[realm]/[name]/character-page-client.tsx`
- Create: `apps/web/src/app/characters/[region]/[realm]/[name]/history/[snapshotId]/page.tsx`
- Create: `apps/web/src/app/privacy/page.tsx`
- Create: `apps/web/src/app/api/page.tsx`

- [ ] **Step 1: Write failing interaction and rendering tests**

Use Testing Library with accessible queries. Verify labelled URL input, adjacent validation error, keyboard submit, canonical navigation, polling across queued/running/retrying states, old data remaining visible during stale refresh, complete/partial treatment, exact refresh date/time, and no provenance/change-summary text.

```tsx
it("keeps stale characters visible while a refresh is active", async () => {
  render(<CharacterPageClient initial={staleResourceWithActiveJob} />);
  expect(screen.getByRole("link", { name: /Ryii/ })).toBeVisible();
  expect(screen.getByText("Refreshing")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Refresh history" }),
  ).toBeVisible();
  expect(
    screen.queryByText(/added|removed|profile guess/i),
  ).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run component tests and verify failure**

Run: `corepack pnpm vitest apps/web/src/components/search-form.test.tsx apps/web/src/components/character-view.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement the flat visual system and minimal homepage**

Declare approved tokens centrally:

```css
:root {
  color-scheme: dark;
  --page: #09090f;
  --surface: #111119;
  --border: #22222d;
  --text: #f4f4f5;
  --muted: #858594;
  --accent: #38bdf8;
  --accent-ink: #062a3c;
  --success: #22c55e;
  --partial: #f59e0b;
}
```

The header contains only a flat, single-color slash logo at top-left and `API`/`GitHub` links at top-right. The homepage body contains the flat frost-blue slash immediately before `Who`, one programmatically labelled search input, and one `Search` button. Do not add cards, explainer copy, directories, gradients, shadows, or the word `Slash`.

- [ ] **Step 4: Implement server-loaded character/history routes and bounded polling**

Server pages load current or immutable snapshot data through the application container. Canonicalize alternative route casing with a permanent redirect. The client polls only while a job is active, applies capped backoff, stops on terminal state/unmount, and refreshes server data after completion.

Desktop layout uses `minmax(0, 1fr) minmax(16rem, 22rem)`; below the mobile breakpoint, history stacks after the character list. History rows show exact localized date/time, result count, and Complete/Partial. Add direct Raider.IO links built from normalized identity.

- [ ] **Step 5: Add privacy and API reference pages**

The privacy page states public data sources, permanent snapshot retention, fields never stored, and links to the repository's removal-request issue template. The API page documents the five endpoints, bot Bearer authentication, polling, status/error enums, and links to the checked-in bot compatibility fixture without exposing any secret.

- [ ] **Step 6: Run component, accessibility, type, and build checks**

Run: `corepack pnpm vitest apps/web/src/components`

Run: `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm --filter @slashwho/web build`

Expected: PASS with no accessibility-query workarounds.

- [ ] **Step 7: Commit the public website**

```bash
git add apps/web
git commit -m "feat: build public character search experience"
```

---

### Task 10: Prove the browser journey and production operations

**Files:**

- Create: `playwright.config.ts`
- Create: `tests/e2e/search.spec.ts`
- Create: `tests/e2e/history.spec.ts`
- Create: `tests/e2e/responsive.spec.ts`
- Create: `tests/e2e/support/fake-raiderio.ts`
- Create: `tests/e2e/support/seed.ts`
- Create: `scripts/live-smoke.mts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/live-smoke.yml`
- Create: `Dockerfile.web`
- Create: `Dockerfile.worker`
- Create: `railway.web.toml`
- Create: `railway.worker.toml`
- Create: `docs/deployment/railway.md`
- Create: `docs/operations/removals.md`
- Create: `.github/ISSUE_TEMPLATE/removal-request.yml`
- Modify: `README.md`

- [ ] **Step 1: Write the failing critical Playwright journey**

```ts
test("searches, refreshes, and opens an immutable snapshot", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Raider.IO character URL").fill(RYII_URL);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/characters\/eu\/silvermoon\/ryii$/);
  await expect(page.getByText("Refreshing")).toBeVisible();
  await expect(page.getByRole("link", { name: /Ryii/ })).toBeVisible();
  await page.getByRole("link", { name: /3 characters/ }).click();
  await expect(page).toHaveURL(/\/history\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("heading", { name: "Refresh history" }),
  ).toBeVisible();
});
```

- [ ] **Step 2: Run the critical journey and verify harness/config failure**

Run: `corepack pnpm playwright test tests/e2e/search.spec.ts`

Expected: FAIL because the deterministic E2E environment is not configured.

- [ ] **Step 3: Add the deterministic E2E harness and complete browser coverage**

Launch PostgreSQL, web, worker, and a local fixture HTTP server through Playwright `webServer`/global setup. Point `RAIDER_IO_BASE_URL` only at the fixture server. Seed stale history and suppression cases through repository helpers. Cover all public states, history navigation, keyboard flow, visible focus, mobile history stacking, and absence of internal provenance.

- [ ] **Step 4: Add production containers and Railway configuration**

Use multi-stage Docker builds with `corepack pnpm deploy`/Next standalone output. Both containers run `runMigrations` before starting; worker readiness additionally checks queue initialization. Pin health paths and restart policies in the two Railway config files. Document dashboard setup:

1. Create isolated staging and production environments.
2. Add PostgreSQL plus web and worker services.
3. Set each service's config path and Dockerfile.
4. Reference private `DATABASE_URL`; expose only web publicly.
5. Set `BOT_API_KEY`, `RATE_LIMIT_HASH_SECRET`, limits, timeouts, and Raider.IO base URL separately per environment.
6. Map `main` to staging and `prod` to production.
7. Enable scheduled production volume backups before launch.
8. Verify the exact trusted Railway client-IP header against current Railway documentation before setting `TRUSTED_CLIENT_IP_HEADER`; fail closed when unset.

- [ ] **Step 5: Add CI and non-gating live smoke workflow**

The required job must execute, in order:

```yaml
- run: corepack pnpm format:check
- run: corepack pnpm lint
- run: corepack pnpm typecheck
- run: corepack pnpm test:unit
- run: corepack pnpm test:integration
- run: corepack pnpm build
- run: corepack pnpm playwright test tests/e2e/search.spec.ts
```

Use pinned action major versions, dependency caching, Playwright browser caching, and Docker-capable Ubuntu runners. The live smoke workflow is manual plus scheduled, has low concurrency, reads URLs from repository variables, and is not referenced by a branch ruleset.

- [ ] **Step 6: Document removal operations and project commands**

`docs/operations/removals.md` must give the maintainer exact repository-command steps to add, audit, expire, and verify suppression without deleting immutable snapshots or encouraging ad-hoc production SQL. Add `removal-request.yml` with only public character identity, request reason, and a warning not to submit private ownership evidence publicly. Update README with architecture, local PostgreSQL/Docker prerequisites, setup, test matrix, development commands, branch-to-Railway mapping, privacy link, and API link.

- [ ] **Step 7: Run the complete local release gate**

Run: `corepack pnpm format:check`

Run: `corepack pnpm lint`

Run: `corepack pnpm typecheck`

Run: `corepack pnpm test:unit`

Run: `corepack pnpm test:integration`

Run: `corepack pnpm build`

Run: `corepack pnpm playwright test`

Expected: every command passes. Record the command output in the pull request description.

- [ ] **Step 8: Validate container and deployment artifacts**

Run: `docker build -f Dockerfile.web -t slashwho-web:local .`

Run: `docker build -f Dockerfile.worker -t slashwho-worker:local .`

Run: `docker run --rm slashwho-web:local node --version`

Run: `docker run --rm slashwho-worker:local node --version`

Expected: both images build and report a Node 22 runtime. Validate Railway configuration syntax using the current Railway CLI before creating services.

- [ ] **Step 9: Commit release engineering**

```bash
git add playwright.config.ts tests/e2e scripts .github Dockerfile.web Dockerfile.worker railway.web.toml railway.worker.toml docs README.md
git commit -m "chore: add CI and Railway deployment"
```

---

## Final Review and Handoff

- [ ] Run `rg -n "TODO|FIXME|placeholder|similar to|implement later" apps packages tests scripts docs README.md` and resolve every product-code or plan placeholder.
- [ ] Confirm no public schema includes `source`, owner identifiers, guesses, raw responses, credentials, or rate-limit bucket hashes.
- [ ] Confirm every design acceptance criterion maps to at least one automated test or an explicit Railway staging validation step.
- [ ] Run the full release gate again from a clean checkout.
- [ ] Review `git diff main...HEAD --check` and `git status --short`.
- [ ] Use `superpowers:requesting-code-review`, then address findings with `superpowers:receiving-code-review`.
- [ ] Open a squash-only pull request from the implementation branch to `main`; require `ci` before merge.
- [ ] Deploy `main` to Railway staging and validate web health, worker readiness, one complete search, one stale refresh, one historical snapshot, rate limiting, suppression, and graceful worker restart.
- [ ] Fast-forward `prod` from the validated `main` commit and verify the production health/readiness endpoints and backup schedule.
