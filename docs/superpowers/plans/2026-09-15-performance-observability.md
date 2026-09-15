# Performance Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every slow SlashWho request diagnosable from its log record alone, by attributing time to a provider, the database, the queue, or the concurrency limiter.

**Architecture:** A small explicit accumulator (`createMeasurementScope`) is created at three unit-of-work boundaries — the web request wrapper, the discovery job handler, and the evidence job handler — and passed down to five instrumented seams. Each boundary merges the accumulated totals into the single summary log record it already emits (or, for evidence, a new one). Nothing is logged per call.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, pino, pg-boss, Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-09-15-performance-observability-design.md`

## Global Constraints

- Every new parameter is **optional**. Omitting it must reproduce current behavior exactly, and every existing test must pass unchanged.
- Bucket fields are derived uniformly as `<prefix>Ms`, `<prefix>Calls`, `<prefix>MaxCallMs`. Prefixes: `raiderIo`, `blizzard`, `warcraftLogs`, `db`, and on the dossier read path `raiderIoRankings` and `raiderIoCharacter`.
- Non-bucket accumulators: `limiterWaitMs`, `rateLimitHits`, `retryAfterMaxMs`, `queueWaitMs`.
- **No new field name may reduce to `score`** after lowercasing and stripping non-letters — `apps/worker/src/logger.ts` censors those to `[Redacted]`.
- **Every new web field must be added to `allowedFields`** in `apps/web/src/server/logger.ts` or it is silently dropped.
- No character name, realm, region, URL, request body, or upstream payload may be added to any record. All new fields are integers, booleans, or the existing `correlationId`.
- Clients receive **no** scope, logger, or correlation ID — only an optional `onThrottle` callback.
- Run `pnpm test:unit` and `pnpm typecheck` before every commit. Run `pnpm format` before committing.
- Repo uses US spelling in source and docs.

---

### Task 1: Measurement scope

**Files:**

- Create: `packages/application/src/measurement.ts`
- Test: `packages/application/src/measurement.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `createMeasurementScope(monotonic?: () => number): MeasurementScope`, and the type `MeasurementScope` with methods `time<T>(prefix: string, work: () => Promise<T>): Promise<T>`, `observe(field: string, value: number): void`, `observeMax(field: string, value: number): void`, `increment(field: string, amount?: number): void`, `mark(field: string): void`, `totals(): Readonly<Record<string, number | boolean>>`. Every later task consumes this. `mark` exists because `runJoined` is a boolean, and the analysis script in Task 10 ignores non-numeric fields by design.

- [ ] **Step 1: Write the failing test**

```ts
// packages/application/src/measurement.test.ts
import { describe, expect, it } from "vitest";

import { createMeasurementScope } from "./measurement";

function fakeClock(steps: readonly number[]): () => number {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)]!;
}

describe("createMeasurementScope", () => {
  it("accumulates duration, call count, and longest call per prefix", async () => {
    const scope = createMeasurementScope(fakeClock([0, 10, 10, 40]));

    await scope.time("raiderIo", async () => "first");
    await scope.time("raiderIo", async () => "second");

    expect(scope.totals()).toMatchObject({
      raiderIoMs: 40,
      raiderIoCalls: 2,
      raiderIoMaxCallMs: 30
    });
  });

  it("records the duration of a call that throws", async () => {
    const scope = createMeasurementScope(fakeClock([0, 25]));

    await expect(
      scope.time("blizzard", async () => {
        throw new Error("upstream_timeout");
      })
    ).rejects.toThrow("upstream_timeout");

    expect(scope.totals()).toMatchObject({
      blizzardMs: 25,
      blizzardCalls: 1,
      blizzardMaxCallMs: 25
    });
  });

  it("returns the work's resolved value unchanged", async () => {
    const scope = createMeasurementScope(fakeClock([0, 1]));
    await expect(scope.time("db", async () => ({ rows: 3 }))).resolves.toEqual({
      rows: 3
    });
  });

  it("keeps prefixes disjoint", async () => {
    const scope = createMeasurementScope(fakeClock([0, 5, 5, 9]));

    await scope.time("db", async () => undefined);
    await scope.time("warcraftLogs", async () => undefined);

    expect(scope.totals()).toMatchObject({
      dbMs: 5,
      dbCalls: 1,
      warcraftLogsMs: 4,
      warcraftLogsCalls: 1
    });
  });

  it("accumulates observed, maximum, and incremented fields", () => {
    const scope = createMeasurementScope(fakeClock([0]));

    scope.observe("limiterWaitMs", 12);
    scope.observe("limiterWaitMs", 8);
    scope.increment("rateLimitHits");
    scope.increment("rateLimitHits");
    scope.observeMax("retryAfterMaxMs", 1_000);
    scope.observeMax("retryAfterMaxMs", 250);

    expect(scope.totals()).toEqual({
      limiterWaitMs: 20,
      rateLimitHits: 2,
      retryAfterMaxMs: 1_000
    });
  });

  it("marks a boolean flag", () => {
    const scope = createMeasurementScope(fakeClock([0]));
    scope.mark("runJoined");
    expect(scope.totals()).toEqual({ runJoined: true });
  });

  it("omits fields that were never touched", () => {
    expect(createMeasurementScope(fakeClock([0])).totals()).toEqual({});
  });

  it("rounds to whole milliseconds and never reports a negative duration", async () => {
    const scope = createMeasurementScope(fakeClock([10.6, 10.2]));
    await scope.time("db", async () => undefined);
    expect(scope.totals().dbMs).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/application/src/measurement.test.ts`
Expected: FAIL — `Failed to resolve import "./measurement"`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/application/src/measurement.ts

/**
 * One unit of work's accumulated performance totals. A scope is deliberately a
 * plain accumulator with an injected clock rather than ambient context: this
 * codebase injects its clocks and observers everywhere else, and the service
 * containers are process-wide singletons, so an implicitly shared scope could
 * not attribute time to one request.
 *
 * Field names are derived uniformly from a prefix so that no rename map is
 * needed here or in the analysis script.
 */
export type MeasurementScope = {
  /** Times `work` against `prefix`, recording duration even when it throws. */
  time<T>(prefix: string, work: () => Promise<T>): Promise<T>;
  /** Adds to a running total, e.g. `limiterWaitMs`. */
  observe(field: string, value: number): void;
  /** Keeps the largest value seen, e.g. `retryAfterMaxMs`. */
  observeMax(field: string, value: number): void;
  /** Adds to a counter, e.g. `rateLimitHits`. */
  increment(field: string, amount?: number): void;
  /** Sets a boolean flag, e.g. `runJoined`. */
  mark(field: string): void;
  /** Flat fields, ready to spread into a log record. */
  totals(): Readonly<Record<string, number | boolean>>;
};

export function createMeasurementScope(
  monotonic: () => number = () => performance.now()
): MeasurementScope {
  const values = new Map<string, number>();
  const flags = new Set<string>();

  const add = (field: string, value: number) => {
    values.set(field, (values.get(field) ?? 0) + value);
  };

  return {
    async time(prefix, work) {
      const startedAt = monotonic();
      try {
        return await work();
      } finally {
        // finally, not a catch: a timed-out or failed upstream call is the
        // expensive case and must still contribute its duration.
        const elapsed = Math.max(0, Math.round(monotonic() - startedAt));
        add(`${prefix}Ms`, elapsed);
        add(`${prefix}Calls`, 1);
        const maxField = `${prefix}MaxCallMs`;
        values.set(maxField, Math.max(values.get(maxField) ?? 0, elapsed));
      }
    },

    observe(field, value) {
      add(field, Math.max(0, Math.round(value)));
    },

    observeMax(field, value) {
      values.set(
        field,
        Math.max(values.get(field) ?? 0, Math.max(0, Math.round(value)))
      );
    },

    increment(field, amount = 1) {
      add(field, amount);
    },

    mark(field) {
      flags.add(field);
    },

    totals() {
      return {
        ...Object.fromEntries(values),
        ...Object.fromEntries([...flags].map((field) => [field, true]))
      };
    }
  };
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/application/src/index.ts`, following the existing export style in that file:

```ts
export { createMeasurementScope, type MeasurementScope } from "./measurement";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run --project unit packages/application/src/measurement.test.ts && pnpm typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/application/src/measurement.ts packages/application/src/measurement.test.ts packages/application/src/index.ts
git commit -m "feat: add measurement scope for per-unit-of-work performance totals"
```

---

### Task 2: Limiter wait

**Files:**

- Modify: `packages/application/src/concurrency.ts`
- Test: `packages/application/src/concurrency.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1 (the limiter reports raw milliseconds; the caller decides where they go).
- Produces: `createConcurrencyLimiter(limit: number, options?: { onWait?(waitedMs: number): void; monotonic?(): number })`. The callback fires once per `run` call, with the milliseconds spent waiting for admission — never including the work itself.

- [ ] **Step 1: Write the failing test**

Append to `packages/application/src/concurrency.test.ts`:

```ts
it("reports admission wait without including the work", async () => {
  const waits: number[] = [];
  let clock = 0;
  const limiter = createConcurrencyLimiter(1, {
    onWait: (ms) => waits.push(ms),
    monotonic: () => clock
  });

  let releaseFirst: (() => void) | undefined;
  const first = limiter.run(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
  );

  const second = limiter.run(async () => {
    clock += 100;
  });

  clock = 30;
  releaseFirst!();
  await Promise.all([first, second]);

  expect(waits).toEqual([0, 30]);
});

it("reports a zero wait when admission is immediate", async () => {
  const waits: number[] = [];
  const limiter = createConcurrencyLimiter(2, {
    onWait: (ms) => waits.push(ms),
    monotonic: () => 0
  });

  await Promise.all([
    limiter.run(async () => undefined),
    limiter.run(async () => undefined)
  ]);

  expect(waits).toEqual([0, 0]);
});

it("works without an onWait callback", async () => {
  const limiter = createConcurrencyLimiter(1);
  await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/application/src/concurrency.test.ts`
Expected: FAIL — `createConcurrencyLimiter` accepts one argument; `waits` is empty.

- [ ] **Step 3: Write the implementation**

Replace the body of `packages/application/src/concurrency.ts` with:

```ts
export type ConcurrencyLimiterOptions = {
  /** Called once per `run`, with the milliseconds spent awaiting admission. */
  onWait?(waitedMs: number): void;
  monotonic?(): number;
};

export function createConcurrencyLimiter(
  limit: number,
  options: ConcurrencyLimiterOptions = {}
) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("concurrency_limit_invalid");
  }

  const monotonic = options.monotonic ?? (() => performance.now());

  let active = 0;
  const pending: Array<{
    work: () => Promise<unknown>;
    queuedAt: number;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  function drain() {
    while (active < limit && pending.length > 0) {
      const item = pending.shift()!;
      active += 1;
      // Reported before the work starts, so the wait never includes it.
      options.onWait?.(Math.max(0, Math.round(monotonic() - item.queuedAt)));
      Promise.resolve()
        .then(item.work)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        pending.push({
          work,
          queuedAt: monotonic(),
          resolve: resolve as (value: unknown) => void,
          reject
        });
        drain();
      });
    }
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run --project unit packages/application/src/concurrency.test.ts && pnpm typecheck`
Expected: PASS, including all pre-existing limiter tests.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add packages/application/src/concurrency.ts packages/application/src/concurrency.test.ts
git commit -m "feat: report admission wait from the provider concurrency limiter"
```

---

### Task 3: Client throttle callbacks

**Files:**

- Modify: `packages/blizzard/src/client.ts`, `packages/raiderio/src/client.ts`, `packages/warcraftlogs/src/client.ts`
- Test: `packages/blizzard/src/client.test.ts`, `packages/raiderio/src/client.test.ts`, `packages/warcraftlogs/src/client.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: each client's options type gains `onThrottle?(event: { retryAfterMs: number | undefined }): void`. It fires wherever the client already detects a throttled response — `responseFailure` in the Blizzard and Raider.IO clients, and the `status === 429` branch at `packages/warcraftlogs/src/client.ts:219`. Clients receive nothing else.

- [ ] **Step 1: Write the failing test (Blizzard)**

Append to `packages/blizzard/src/client.test.ts`, matching the existing fetch-stub style in that file:

```ts
it("reports a throttled response through onThrottle", async () => {
  const throttles: Array<{ retryAfterMs: number | undefined }> = [];
  const client = createBlizzardClient({
    fetch: async (input) =>
      String(input).includes("oauth")
        ? Response.json({ access_token: "t", expires_in: 3_600 })
        : new Response("", { status: 429, headers: { "Retry-After": "2" } }),
    clientId: "id",
    clientSecret: "secret",
    onThrottle: (event) => throttles.push(event)
  });

  await client
    .getCompletedAchievements(
      { region: "eu", realm: "silvermoon", name: "tester" },
      AbortSignal.timeout(1_000)
    )
    .catch(() => undefined);

  expect(throttles).toEqual([{ retryAfterMs: 2_000 }]);
});

it("does not require onThrottle", async () => {
  const client = createBlizzardClient({
    fetch: async () => new Response("", { status: 429 }),
    clientId: "id",
    clientSecret: "secret"
  });
  await expect(
    client.getCompletedAchievements(
      { region: "eu", realm: "silvermoon", name: "tester" },
      AbortSignal.timeout(1_000)
    )
  ).rejects.toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/blizzard/src/client.test.ts`
Expected: FAIL — `onThrottle` is not a known option; `throttles` is empty.

- [ ] **Step 3: Implement in the Blizzard client**

Add `onThrottle?(event: { retryAfterMs: number | undefined }): void;` to `CreateBlizzardClientOptions`. Then thread it into `responseFailure`, which currently takes only a `Response`:

```ts
function responseFailure(
  response: Response,
  onThrottle?: (event: { retryAfterMs: number | undefined }) => void
): BlizzardFailure {
  if (response.status === 404) return { kind: "not_found" };

  const retryAfter = retryAfterMs(response);
  if (response.status === 429 || retryAfter !== undefined) {
    onThrottle?.({ retryAfterMs: retryAfter });
  }
  return {
    kind: "transient",
    status: response.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter })
  };
}
```

Update every `responseFailure(response)` call site inside `createBlizzardClient` to `responseFailure(response, options.onThrottle)`. Find them with:

```bash
grep -n "responseFailure(" packages/blizzard/src/client.ts
```

- [ ] **Step 4: Run the Blizzard tests**

Run: `pnpm vitest run --project unit packages/blizzard/src/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Repeat for the Raider.IO client**

`packages/raiderio/src/client.ts` has the same shape: add `onThrottle?(event: { retryAfterMs: number | undefined }): void;` to its options type, give its `responseFailure` the same second parameter and the same `429 || retryAfter !== undefined` guard, and update its call sites. Its `responseFailure` must keep returning `not_found` for 404 and its existing permanent answer for 403 **before** the throttle check — a private profile is a visibility answer, not throttling.

Add the equivalent test to `packages/raiderio/src/client.test.ts`:

```ts
it("reports a throttled response through onThrottle", async () => {
  const throttles: Array<{ retryAfterMs: number | undefined }> = [];
  const client = createRaiderIoClient({
    fetch: async () =>
      new Response("", { status: 429, headers: { "Retry-After": "5" } }),
    baseUrl: "https://raider.io",
    timeoutMs: 1_000,
    onThrottle: (event) => throttles.push(event)
  });

  await client
    .getCharacter(
      { region: "eu", realm: "silvermoon", name: "tester" },
      AbortSignal.timeout(1_000)
    )
    .catch(() => undefined);

  expect(throttles).toEqual([{ retryAfterMs: 5_000 }]);
});

it("does not report a private profile as throttling", async () => {
  const throttles: unknown[] = [];
  const client = createRaiderIoClient({
    fetch: async () => new Response("", { status: 403 }),
    baseUrl: "https://raider.io",
    timeoutMs: 1_000,
    onThrottle: () => throttles.push(true)
  });

  await client
    .getCharacter(
      { region: "eu", realm: "silvermoon", name: "tester" },
      AbortSignal.timeout(1_000)
    )
    .catch(() => undefined);

  expect(throttles).toEqual([]);
});
```

- [ ] **Step 6: Repeat for the Warcraft Logs client**

`packages/warcraftlogs/src/client.ts:219` already has an explicit `if (response.status === 429)` branch. Add `onThrottle?(event: { retryAfterMs: number | undefined }): void;` to its options type and invoke it inside that branch, immediately after `const retryAfter = retryAfterMs(response);`. Do not change any other behavior in this file.

Add the equivalent test to `packages/warcraftlogs/src/client.test.ts`, following the fetch-stub and OAuth-stub pattern already used there.

- [ ] **Step 7: Run all client tests and typecheck**

Run: `pnpm vitest run --project unit packages/blizzard packages/raiderio packages/warcraftlogs && pnpm typecheck`
Expected: PASS, with every pre-existing client test unchanged.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add packages/blizzard packages/raiderio packages/warcraftlogs
git commit -m "feat: report upstream throttling from the Blizzard, Raider.IO, and Warcraft Logs clients"
```

---

### Task 4: Measured repositories wrapper

**Files:**

- Create: `packages/application/src/measured-repositories.ts`
- Test: `packages/application/src/measured-repositories.test.ts`
- Modify: `packages/application/src/index.ts`

**Interfaces:**

- Consumes: `MeasurementScope` from Task 1.
- Produces: `measuredRepositories<T extends object>(repositories: T, scope: MeasurementScope): T`. Times every method call on every nested repository under the `db` prefix. Applied per unit of work, never at the composition root — the containers are singletons.

- [ ] **Step 1: Write the failing test**

```ts
// packages/application/src/measured-repositories.test.ts
import { describe, expect, it, vi } from "vitest";

import { createMeasurementScope } from "./measurement";
import { measuredRepositories } from "./measured-repositories";

function clock(steps: readonly number[]): () => number {
  let index = 0;
  return () => steps[Math.min(index++, steps.length - 1)]!;
}

describe("measuredRepositories", () => {
  it("times each repository call under the db prefix", async () => {
    const scope = createMeasurementScope(clock([0, 5, 5, 20]));
    const repositories = {
      snapshots: {
        getCurrent: async () => ({ id: "s1" }),
        create: async () => undefined
      }
    };

    const measured = measuredRepositories(repositories, scope);
    await measured.snapshots.getCurrent();
    await measured.snapshots.create();

    expect(scope.totals()).toMatchObject({
      dbMs: 20,
      dbCalls: 2,
      dbMaxCallMs: 15
    });
  });

  it("returns the underlying result unchanged", async () => {
    const scope = createMeasurementScope(clock([0, 1]));
    const measured = measuredRepositories(
      { snapshots: { getCurrent: async () => ({ id: "s1" }) } },
      scope
    );
    await expect(measured.snapshots.getCurrent()).resolves.toEqual({
      id: "s1"
    });
  });

  it("forwards arguments", async () => {
    const getCurrent = vi.fn(async (_key: string) => null);
    const measured = measuredRepositories(
      { snapshots: { getCurrent } },
      createMeasurementScope(clock([0, 1]))
    );
    await measured.snapshots.getCurrent("eu/silvermoon/tester");
    expect(getCurrent).toHaveBeenCalledWith("eu/silvermoon/tester");
  });

  it("records a call that rejects", async () => {
    const scope = createMeasurementScope(clock([0, 9]));
    const measured = measuredRepositories(
      {
        snapshots: {
          getCurrent: async () => {
            throw new Error("connection_lost");
          }
        }
      },
      scope
    );

    await expect(measured.snapshots.getCurrent()).rejects.toThrow(
      "connection_lost"
    );
    expect(scope.totals()).toMatchObject({ dbMs: 9, dbCalls: 1 });
  });

  it("leaves non-function and absent properties alone", () => {
    const measured = measuredRepositories(
      { snapshots: { label: "snapshots" } },
      createMeasurementScope(clock([0]))
    );
    expect(measured.snapshots.label).toBe("snapshots");
    expect(
      (measured.snapshots as Record<string, unknown>).missing
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/application/src/measured-repositories.test.ts`
Expected: FAIL — `Failed to resolve import "./measured-repositories"`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/application/src/measured-repositories.ts
import type { MeasurementScope } from "./measurement";

/**
 * Wraps a repositories object so every method call is timed under the `db`
 * prefix. Applied per unit of work rather than at the composition root, because
 * both service containers are process-wide singletons and a shared wrapper
 * could not attribute a query to the request that caused it.
 *
 * A Proxy keeps `packages/database/src/postgres-repositories.ts` untouched.
 */
export function measuredRepositories<T extends object>(
  repositories: T,
  scope: MeasurementScope
): T {
  const wrapped = new Map<string | symbol, unknown>();

  return new Proxy(repositories, {
    get(target, property, receiver) {
      const group = Reflect.get(target, property, receiver);
      if (typeof group !== "object" || group === null) return group;
      if (wrapped.has(property)) return wrapped.get(property);

      const measuredGroup = new Proxy(group as object, {
        get(groupTarget, method, groupReceiver) {
          const value = Reflect.get(groupTarget, method, groupReceiver);
          if (typeof value !== "function") return value;
          return (...args: readonly unknown[]) =>
            scope.time("db", async () =>
              (value as (...inner: readonly unknown[]) => unknown).apply(
                groupTarget,
                args
              )
            );
        }
      });

      wrapped.set(property, measuredGroup);
      return measuredGroup;
    }
  }) as T;
}
```

- [ ] **Step 4: Export from the package index**

```ts
export { measuredRepositories } from "./measured-repositories";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run --project unit packages/application/src/measured-repositories.test.ts && pnpm typecheck`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add packages/application/src/measured-repositories.ts packages/application/src/measured-repositories.test.ts packages/application/src/index.ts
git commit -m "feat: time repository calls per unit of work without touching the repositories"
```

---

### Task 5: Instrument the dossier service

**Files:**

- Modify: `packages/application/src/applicant-dossier-service.ts` (options type ~602-613, gateway decorators 630-679, limiter 621-623, method signatures 50-61, `readInitial` 716-765, `read` 768+)
- Test: `packages/application/src/applicant-dossier-service.test.ts`

**Interfaces:**

- Consumes: `MeasurementScope` (Task 1), `createConcurrencyLimiter` options (Task 2).
- Produces: the four `ApplicantDossierService` methods each accept an optional trailing `scope?: MeasurementScope`. Provider buckets on this path are per-operation: `raiderIoRankings` and `raiderIoCharacter`, plus `blizzard`. Cache outcomes are reported through the existing `onCacheEvent`, unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/application/src/applicant-dossier-service.test.ts`, reusing that file's existing fake-gateway and fake-repository builders:

```ts
it("attributes provider time per operation on readInitial", async () => {
  const scope = createMeasurementScope(
    (() => {
      let index = 0;
      const steps = [0, 12, 12, 12];
      return () => steps[Math.min(index++, steps.length - 1)]!;
    })()
  );

  const service = createApplicantDossierService({
    ...baseOptions,
    raiderio: {
      ...baseOptions.raiderio,
      getCharacter: async () => ({ isTournamentProfile: false })
    }
  });

  await service.readInitial(
    { region: "eu", realm: "silvermoon", name: "tester" },
    undefined,
    scope
  );

  expect(scope.totals()).toMatchObject({
    raiderIoCharacterMs: 12,
    raiderIoCharacterCalls: 1
  });
});

it("records limiter wait on the scope", async () => {
  const scope = createMeasurementScope(() => 0);
  const service = createApplicantDossierService(baseOptions);

  await service.read(
    { region: "eu", realm: "silvermoon", name: "tester" },
    undefined,
    scope
  );

  expect(scope.totals().limiterWaitMs).toBeGreaterThanOrEqual(0);
});

it("behaves identically when no scope is supplied", async () => {
  const service = createApplicantDossierService(baseOptions);
  await expect(
    service.read({ region: "eu", realm: "silvermoon", name: "tester" })
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/application/src/applicant-dossier-service.test.ts`
Expected: FAIL — `readInitial` expects 2 arguments; totals are empty.

- [ ] **Step 3: Widen the interface**

In the `ApplicantDossierService` interface (lines 50-61), add the optional scope to all four methods:

```ts
export interface ApplicantDossierService {
  start(
    input: CreateDossierCommand,
    scope?: MeasurementScope
  ): Promise<CreateDossierResult>;
  addConnectedCharacter(
    root: CharacterKey,
    input: CreateDossierCommand,
    scope?: MeasurementScope
  ): Promise<CreateSearchResult | { kind: "linked" | "duplicate" }>;
  readInitial(
    key: CharacterKey,
    signal?: AbortSignal,
    scope?: MeasurementScope
  ): Promise<ReadDossierResult>;
  read(
    key: CharacterKey,
    signal?: AbortSignal,
    scope?: MeasurementScope
  ): Promise<ReadDossierResult>;
}
```

Import `MeasurementScope` from `./measurement` at the top of the file.

- [ ] **Step 4: Make the limiter and gateway decorators scope-aware**

The decorators are built once per service, but a scope arrives per call, so the scope must be passed in rather than captured. Change the two internal decorator constants into factories taking the scope, and build the limiter with an `onWait` that writes to the scope currently in play.

Replace the limiter construction (lines 621-623) and the `blizzard`/`raiderio` decorator constants (lines 630-679) with:

```ts
// One scope per in-flight call. The service is a singleton, so the active
// scope is passed to the factories below instead of being captured.
const limiterScopes = new Set<MeasurementScope>();
const providerConcurrency = createConcurrencyLimiter(
  options.config.DOSSIER_PROVIDER_CONCURRENCY,
  {
    onWait: (ms) => {
      for (const scope of limiterScopes) scope.observe("limiterWaitMs", ms);
    }
  }
);

function measuredBlizzard(
  scope?: MeasurementScope
): Pick<BlizzardGateway, "getCompletedAchievements"> {
  return {
    async getCompletedAchievements(key, signal) {
      signal?.throwIfAborted();
      return awaitWithAbort(
        achievements(`${key.region}/${key.realm}/${key.name}`, async () => {
          const run = async () =>
            options.blizzard.getCompletedAchievements(
              key,
              AbortSignal.timeout(15_000)
            );
          const rows = scope ? await scope.time("blizzard", run) : await run();
          return rows
            .filter(
              (row) => lookupCuttingEdgeAchievement(row.achievementId) !== null
            )
            .map(({ achievementId, completedAt }) => ({
              achievementId,
              completedAt
            }));
        }),
        signal
      );
    }
  };
}

function measuredRaiderIo(
  scope?: MeasurementScope
): Pick<RaiderIoGateway, "getMythicBossRankings"> {
  return {
    async getMythicBossRankings(boss, signal) {
      signal?.throwIfAborted();
      try {
        const result = await rankings(rankingKey(boss), async () => {
          const run = async () =>
            options.raiderio.getMythicBossRankings(
              boss,
              AbortSignal.timeout(15_000)
            );
          const response = scope
            ? await scope.time("raiderIoRankings", run)
            : await run();
          if (response.kind !== "rankings") {
            options.onCacheEvent?.(
              "raiderio_rankings",
              `failure_${response.code}`
            );
            throw new RankingLookupFailure(response);
          }
          return response;
        });
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof RankingLookupFailure) return error.result;
        return { kind: "limitation", code: "unavailable" };
      }
    }
  };
}
```

Note that timing sits **inside** the cache loader, so a cache hit correctly records no provider time — the cache outcome is already reported separately through `onCacheEvent`.

- [ ] **Step 5: Wire the scope through the four methods**

In `readInitial`, accept the third parameter, register the scope with the limiter for the duration of the call, time the direct `getCharacter` call, and pass the measured decorators into `assembleDossier`:

```ts
    async readInitial(key, signal, scope) {
      if (scope) limiterScopes.add(scope);
      try {
        // ... existing body unchanged down to the getCharacter call ...
        const loadCharacter = async () =>
          options.raiderio.getCharacter(key, requestSignal);
        const character = scope
          ? await scope.time("raiderIoCharacter", loadCharacter)
          : await loadCharacter();
        // ... existing tournament-profile check unchanged ...
        // in the assembleDossier call, replace `blizzard,` and `raiderio,` with:
        //   blizzard: measuredBlizzard(scope),
        //   raiderio: measuredRaiderIo(scope),
      } finally {
        if (scope) limiterScopes.delete(scope);
      }
    },
```

Apply the same `limiterScopes` add/remove `try`/`finally` and the same two `assembleDossier` substitutions in `read`. In `start` and `addConnectedCharacter`, accept the extra parameter and ignore it — they perform no provider work — so that the interface is uniform for callers.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run --project unit packages/application && pnpm typecheck`
Expected: PASS, with every pre-existing dossier test unchanged.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts
git commit -m "feat: attribute provider and limiter time on the dossier read path"
```

---

### Task 6: Extend the web record

**Files:**

- Modify: `apps/web/src/server/logger.ts`, `apps/web/src/server/http.ts`, `apps/web/src/server/container.ts:92-96`
- Modify: `apps/web/src/app/api/dossiers/route.ts`, `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts`, `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/connected-characters/route.ts`, `apps/web/src/app/api/dossiers/jobs/[jobId]/route.ts`
- Test: `apps/web/src/server/logger.test.ts`, `apps/web/src/server/http.test.ts`

**Interfaces:**

- Consumes: `createMeasurementScope`, `measuredRepositories`, and the scope-aware dossier service (Tasks 1, 4, 5).
- Produces: `withHttpRequest(endpoint, action, logger?, clock?)` where `action` becomes `(scope: MeasurementScope) => Promise<Response>`. The emitted `http_request` record gains the scope's totals plus the folded cache counters.

- [ ] **Step 1: Write the failing logger test**

Append to `apps/web/src/server/logger.test.ts`:

```ts
it("keeps the new performance fields", () => {
  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({
    event: "http_request",
    correlationId: "c1",
    endpoint: "dossier",
    status: 200,
    durationMs: 100,
    raiderIoRankingsMs: 40,
    raiderIoRankingsCalls: 3,
    raiderIoRankingsMaxCallMs: 20,
    raiderIoCharacterMs: 10,
    raiderIoCharacterCalls: 1,
    raiderIoCharacterMaxCallMs: 10,
    blizzardMs: 15,
    blizzardCalls: 1,
    blizzardMaxCallMs: 15,
    dbMs: 8,
    dbCalls: 4,
    dbMaxCallMs: 5,
    limiterWaitMs: 12,
    rateLimitHits: 1,
    retryAfterMaxMs: 2_000,
    runJoined: true,
    cacheHits: 2,
    cacheMisses: 1,
    cacheShared: 0,
    cacheFailures: 0,
    cacheCapacity: 0
  });

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(record).toMatchObject({
    raiderIoRankingsMs: 40,
    dbCalls: 4,
    limiterWaitMs: 12,
    rateLimitHits: 1,
    retryAfterMaxMs: 2_000,
    runJoined: true,
    cacheHits: 2
  });
});

it("still drops a field that is not allowlisted", () => {
  const lines: string[] = [];
  const logger = createWebLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({ event: "http_request", characterName: "tester" });

  expect(JSON.parse(lines[0]!)).not.toHaveProperty("characterName");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit apps/web/src/server/logger.test.ts`
Expected: FAIL — the new fields are absent from the serialized record.

- [ ] **Step 3: Extend the allowlist**

In `apps/web/src/server/logger.ts`, extend `allowedFields`:

```ts
const allowedFields = new Set([
  "event",
  "correlationId",
  "endpoint",
  "status",
  "durationMs",
  "count",
  // The error class only. Messages, bodies, URLs, and payloads stay out by
  // construction: any field not named here is dropped before serialization.
  "errorName",
  // Performance totals. Integers and booleans only — never identity.
  "raiderIoRankingsMs",
  "raiderIoRankingsCalls",
  "raiderIoRankingsMaxCallMs",
  "raiderIoCharacterMs",
  "raiderIoCharacterCalls",
  "raiderIoCharacterMaxCallMs",
  "blizzardMs",
  "blizzardCalls",
  "blizzardMaxCallMs",
  "dbMs",
  "dbCalls",
  "dbMaxCallMs",
  "limiterWaitMs",
  "rateLimitHits",
  "retryAfterMaxMs",
  "runJoined",
  "cacheHits",
  "cacheMisses",
  "cacheShared",
  "cacheFailures",
  "cacheCapacity"
]);
```

- [ ] **Step 4: Give `withHttpRequest` a scope**

In `apps/web/src/server/http.ts`, change the signature so the action receives a scope, and merge totals into the record:

```ts
export async function withHttpRequest(
  endpoint: string,
  action: (scope: MeasurementScope) => Promise<Response>,
  logger: HttpLogger = webLogger,
  clock: () => number = performance.now.bind(performance)
): Promise<Response> {
  const correlationId = randomUUID();
  const scope = createMeasurementScope(clock);
  const startedAt = clock();
  let response: Response;
  let failure: string | undefined;
  try {
    response = await action(scope);
  } catch (error) {
    failure = errorName(error);
    response = apiError("search_failed");
  }
  response.headers.set("x-request-id", correlationId);
  const count = await publicResponseCount(response);
  logger.info({
    event: "http_request",
    correlationId,
    endpoint,
    status: response.status,
    durationMs: Math.max(0, Math.round(clock() - startedAt)),
    ...scope.totals(),
    ...(count === undefined ? {} : { count }),
    ...(failure === undefined ? {} : { errorName: failure })
  });
  return response;
}
```

Import `createMeasurementScope` and `MeasurementScope` from `@slashwho/application`.

- [ ] **Step 5: Fold cache events onto the request**

In `apps/web/src/server/container.ts`, replace the `console.info` at lines 92-96. The container is a singleton, so the callback routes to whichever scopes are active, mirroring the limiter pattern from Task 5. Expose a registration helper from the container:

```ts
const cacheScopes = new Set<MeasurementScope>();
const cacheField: Record<string, string> = {
  hit: "cacheHits",
  miss: "cacheMisses",
  shared: "cacheShared",
  failure: "cacheFailures",
  capacity: "cacheCapacity"
};

// ... in the createApplicantDossierService call:
      onCacheEvent: (_source, event) => {
        // Unknown outcomes (e.g. `failure_<code>`) count as failures.
        const field = cacheField[event] ?? "cacheFailures";
        for (const scope of cacheScopes) scope.increment(field);
      },
```

Add `cacheScopes` to the returned `WebContainer` as `trackCache(scope: MeasurementScope): () => void`, which adds the scope and returns a disposer that removes it. Add that method to the `WebContainer` type.

- [ ] **Step 6: Wire the four routes**

Each route's action now takes the scope, registers it for cache tracking, and passes it to the service. For `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts`:

```ts
return withHttpRequest("dossier", async (scope) => {
  const container = await getContainer();
  const untrack = container.trackCache(scope);
  try {
    // existing body, with the service call gaining the scope:
    //   await container.dossiers.read(key, request.signal, scope)
  } finally {
    untrack();
  }
});
```

Apply the same shape to the other three routes, passing `scope` to `start`, `addConnectedCharacter`, `readInitial`, and `read` wherever each route calls them. `WebContainer` exposes only `searches`, `dossiers`, `ready`, and `close` — no repositories — so no route wraps repositories directly; database time on the web side is recorded inside the services.

- [ ] **Step 7: Mark requests that joined an existing run**

`search-service.ts` already distinguishes a reservation it created from one that was already active: `jobResult(reservation, …)` is called for both `kind: "active"` and `kind: "reserved"` (lines 307 and 325). `kind: "active"` is exactly the deduplicated case the spec calls out, where a request waits on work it did not start.

Surface it on `CreateSearchResult` as `joinedExistingRun: boolean`, set from `reservation.kind === "active"`, and in the dossier start route:

```ts
const result = await container.dossiers.start(command, scope);
if ("joinedExistingRun" in result && result.joinedExistingRun) {
  scope.mark("runJoined");
}
```

Add a test to `apps/web/src/server/http.test.ts` asserting that a marked scope produces `runJoined: true` on the emitted record, and that an unmarked one omits the field entirely.

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm vitest run --project unit apps/web packages/application && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm format
git add apps/web packages/application/src/search-service.ts
git commit -m "feat: add performance totals and folded cache counters to http_request"
```

---

### Task 7: Correlation and queue wait

**Files:**

- Modify: `packages/database/src/queue.ts:9-20, 239-290`
- Modify: `packages/application/src/search-service.ts:114-125, 310-315`, `packages/application/src/applicant-dossier-service.ts:264-280`
- Test: `packages/database/src/queue.test.ts`, `packages/application/src/search-service.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `DiscoverCharacterJob` and `CollectCharacterEvidenceJob` each gain `correlationId?: string` and `enqueuedAt?: string` (ISO 8601). `enqueueCharacterEvidence(runId: string, meta?: { correlationId?: string; enqueuedAt?: string })`. `queue.enqueue` accepts the two new optional payload fields. Both are optional so jobs enqueued by a previous deployment stay valid across a rolling restart.

- [ ] **Step 1: Write the failing test**

Append to `packages/database/src/queue.test.ts`. That file already mocks pg-boss through a `vi.hoisted` `queueFakes` object whose `send` is a `vi.fn`, so assert against `queueFakes.send.mock.calls` rather than introducing a new helper:

```ts
describe("job telemetry", () => {
  it("carries correlation and enqueue time on the discovery payload", async () => {
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueue({
      runId: "00000000-0000-4000-8000-000000000010",
      key: { region: "eu", realm: "silvermoon", name: "root" },
      correlationId: "c1",
      enqueuedAt: "2026-09-15T10:00:00.000Z"
    });

    expect(queueFakes.send.mock.calls[0]?.[1]).toMatchObject({
      correlationId: "c1",
      enqueuedAt: "2026-09-15T10:00:00.000Z"
    });
  });

  it("keeps the singleton key on the run id alone", async () => {
    // Break caught: keying deduplication on the correlation id would let one
    // character be discovered once per requester.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const runId = "00000000-0000-4000-8000-000000000011";
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueue({
      runId,
      key: { region: "eu", realm: "silvermoon", name: "root" },
      correlationId: "c1"
    });

    expect(queueFakes.send.mock.calls[0]?.[2]).toMatchObject({
      singletonKey: runId
    });
  });

  it("carries correlation and enqueue time on the evidence payload", async () => {
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueueCharacterEvidence(
      "00000000-0000-4000-8000-000000000012",
      { correlationId: "c2", enqueuedAt: "2026-09-15T10:00:01.000Z" }
    );

    expect(queueFakes.send.mock.calls[0]?.[1]).toMatchObject({
      correlationId: "c2",
      enqueuedAt: "2026-09-15T10:00:01.000Z"
    });
  });

  it("enqueues evidence without metadata", async () => {
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    await queue.start();
    queueFakes.send.mockClear();

    await queue.enqueueCharacterEvidence(
      "00000000-0000-4000-8000-000000000013"
    );

    expect(queueFakes.send.mock.calls[0]?.[1]).toEqual({
      runId: "00000000-0000-4000-8000-000000000013"
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/database/src/queue.test.ts`
Expected: FAIL — the payload type rejects the new fields.

- [ ] **Step 3: Widen the job types**

```ts
/** Optional so jobs enqueued before this deployment stay valid in flight. */
type JobTelemetry = {
  correlationId?: string;
  /** ISO 8601. Absent yields a null queueWaitMs rather than a wrong one. */
  enqueuedAt?: string;
};

export type DiscoverCharacterJob = {
  runId: string;
  key: CharacterKey;
} & JobTelemetry;

export type CollectCharacterEvidenceJob = {
  runId: string;
} & JobTelemetry;
```

Change the interface entry to `enqueueCharacterEvidence(runId: string, meta?: JobTelemetry): Promise<string>;` and export `JobTelemetry`.

- [ ] **Step 4: Pass metadata through the implementation**

```ts
    async enqueueCharacterEvidence(runId, meta) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const id = await boss.send(
        collectCharacterEvidenceQueueName,
        { runId, ...(meta ?? {}) },
        { singletonKey: runId }
      );
      // ... existing fallback unchanged ...
    },
```

`enqueue` already forwards its whole payload, so it needs no change beyond the widened type. Leave `singletonKey: payload.runId` exactly as it is — deduplication must not key on the correlation ID.

- [ ] **Step 5: Add a queue-wait helper**

Create `packages/application/src/queue-wait.ts`:

```ts
/**
 * Milliseconds a job waited between enqueue and execution, or null when the
 * job predates this field. Never negative, so clock skew reads as zero wait.
 */
export function queueWaitMs(
  enqueuedAt: string | undefined,
  startedAt: Date
): number | null {
  if (!enqueuedAt) return null;
  const queuedAt = Date.parse(enqueuedAt);
  if (!Number.isFinite(queuedAt)) return null;
  return Math.max(0, Math.round(startedAt.getTime() - queuedAt));
}
```

Test it in `packages/application/src/queue-wait.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { queueWaitMs } from "./queue-wait";

describe("queueWaitMs", () => {
  it("measures the wait", () => {
    expect(
      queueWaitMs(
        "2026-09-15T10:00:00.000Z",
        new Date("2026-09-15T10:00:02.500Z")
      )
    ).toBe(2_500);
  });

  it("returns null without an enqueue time", () => {
    expect(queueWaitMs(undefined, new Date())).toBeNull();
  });

  it("returns null for an unparseable enqueue time", () => {
    expect(queueWaitMs("not-a-date", new Date())).toBeNull();
  });

  it("clamps clock skew to zero", () => {
    expect(
      queueWaitMs(
        "2026-09-15T10:00:05.000Z",
        new Date("2026-09-15T10:00:00.000Z")
      )
    ).toBe(0);
  });
});
```

Export it from `packages/application/src/index.ts`.

- [ ] **Step 6: Populate the fields at both enqueue sites**

In `search-service.ts` at the `options.queue.enqueue` call (~line 312), add the two fields from an optional `correlationId` threaded in on `CreateSearchCommand`, plus `enqueuedAt: new Date().toISOString()`. In `applicant-dossier-service.ts` at line 275, pass the same metadata to `enqueueCharacterEvidence`. `recoverPendingSearches` re-enqueues stored payloads and must set a **fresh** `enqueuedAt` at re-enqueue time, so a recovered job measures its new wait rather than the original one.

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm vitest run --project unit packages/database packages/application && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add packages/database packages/application
git commit -m "feat: carry correlation id and enqueue time on discovery and evidence jobs"
```

---

### Task 8: Extend the discovery record

**Files:**

- Modify: `packages/application/src/discovery-job-handler.ts:61-77 (record type), 187-203 (record init), 537-540 (emission)`
- Test: `packages/application/src/discovery-job-handler.test.ts`

**Interfaces:**

- Consumes: `createMeasurementScope` (Task 1), `measuredRepositories` (Task 4), `queueWaitMs` (Task 7).
- Produces: `discovery_run` gains `correlationId`, `queueWaitMs`, and the `raiderIo`, `blizzard`, `db` buckets plus `rateLimitHits` and `retryAfterMaxMs`.

- [ ] **Step 1: Write the failing test**

Append to `packages/application/src/discovery-job-handler.test.ts`, reusing its existing fixture builders:

```ts
it("records correlation, queue wait, and provider totals", async () => {
  const records: Array<Record<string, unknown>> = [];
  const handler = createDiscoveryJobHandler({
    ...baseOptions,
    logger: { info: (record) => records.push(record) },
    monotonic: (() => {
      let index = 0;
      const steps = [0, 30, 30, 30];
      return () => steps[Math.min(index++, steps.length - 1)]!;
    })()
  });

  await handler.execute(
    {
      runId: "run-1",
      key: { region: "eu", realm: "silvermoon", name: "root" },
      correlationId: "c1",
      enqueuedAt: new Date(Date.now() - 1_000).toISOString()
    },
    { attempt: 1, maxAttempts: 3, signal: new AbortController().signal }
  );

  expect(records[0]).toMatchObject({
    event: "discovery_run",
    correlationId: "c1"
  });
  expect(records[0]!.queueWaitMs).toBeGreaterThanOrEqual(900);
});

it("reports a null queue wait for a job with no enqueue time", async () => {
  const records: Array<Record<string, unknown>> = [];
  const handler = createDiscoveryJobHandler({
    ...baseOptions,
    logger: { info: (record) => records.push(record) }
  });

  await handler.execute(
    {
      runId: "run-2",
      key: { region: "eu", realm: "silvermoon", name: "root" }
    },
    { attempt: 1, maxAttempts: 3, signal: new AbortController().signal }
  );

  expect(records[0]).toMatchObject({ queueWaitMs: null });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/application/src/discovery-job-handler.test.ts`
Expected: FAIL — `correlationId` and `queueWaitMs` are absent from the record.

- [ ] **Step 3: Extend the record type**

Add to `DiscoveryRunRecord` (after `durationMs`), keeping the existing allowlist comment accurate:

```ts
correlationId: string | null;
queueWaitMs: number | null;
```

Bucket totals are spread in at emission time, so they need no declaration — widen the type with an index signature for numeric extras:

```ts
} & Record<string, unknown>;
```

Do **not** widen further than this; the comment above the type is the contract.

- [ ] **Step 4: Create the scope and emit**

At the top of `execute`, alongside the existing `observedAt`:

```ts
const scope = createMeasurementScope(monotonic);
const repositories = measuredRepositories(options.repositories, scope);
```

Use `repositories` in place of `options.repositories` throughout `execute` (not elsewhere in the module). Initialize the two new fields in the record literal:

```ts
        correlationId: run.correlationId ?? null,
        queueWaitMs: queueWaitMs(run.enqueuedAt, new Date()),
```

Wrap the gateway calls in `execute` with `scope.time("raiderIo", ...)` and `scope.time("blizzard", ...)`. Then merge totals at emission (lines 537-540):

```ts
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record, ...scope.totals() });
        }
      }
```

- [ ] **Step 5: Wire `onThrottle` in the worker runtime**

In `apps/worker/src/runtime.ts`, the gateways are constructed in `defaultDependencies`. Because they are singletons, route throttle events the same way as the limiter in Task 5: keep a `Set<MeasurementScope>` in the discovery handler options and have the handler register its scope for the duration of `execute`. Add to the handler's `try`:

```ts
options.registerThrottleScope?.(scope);
```

and remove it in the `finally`. The runtime passes `onThrottle` to each client constructor, incrementing `rateLimitHits` and `observeMax("retryAfterMaxMs", …)` on every registered scope.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm vitest run --project unit packages/application apps/worker && pnpm typecheck`
Expected: PASS, with every pre-existing discovery test unchanged.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add packages/application/src/discovery-job-handler.ts packages/application/src/discovery-job-handler.test.ts apps/worker/src/runtime.ts
git commit -m "feat: attribute provider, database, and queue time on discovery_run"
```

---

### Task 9: The evidence record

**Files:**

- Modify: `packages/application/src/applicant-evidence-job-handler.ts`, `apps/worker/src/runtime.ts`
- Test: `packages/application/src/applicant-evidence-job-handler.test.ts`

**Interfaces:**

- Consumes: `createMeasurementScope`, `measuredRepositories`, `queueWaitMs`.
- Produces: a new `evidence_job` record. `createApplicantEvidenceJobHandler` gains `logger?: { info(value: Record<string, unknown>): void }` and `monotonic?: () => number`. `execute` gains an optional second payload form carrying `correlationId` and `enqueuedAt`.

- [ ] **Step 1: Write the failing test**

```ts
it("emits one evidence_job record per run", async () => {
  const records: Array<Record<string, unknown>> = [];
  const handler = createApplicantEvidenceJobHandler({
    ...baseOptions,
    logger: { info: (record) => records.push(record) },
    monotonic: (() => {
      let index = 0;
      const steps = [0, 50, 50, 50];
      return () => steps[Math.min(index++, steps.length - 1)]!;
    })()
  });

  await handler.execute(
    {
      runId: "run-1",
      correlationId: "c1",
      enqueuedAt: new Date(Date.now() - 2_000).toISOString()
    },
    { attempt: 1, maxAttempts: 3, signal: new AbortController().signal }
  );

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    event: "evidence_job",
    runId: "run-1",
    correlationId: "c1",
    outcome: "complete",
    warcraftLogsCalls: 1
  });
  expect(records[0]!.queueWaitMs).toBeGreaterThanOrEqual(1_900);
});

it("records a limitation outcome", async () => {
  const records: Array<Record<string, unknown>> = [];
  const handler = createApplicantEvidenceJobHandler({
    ...baseOptions,
    warcraftLogs: {
      getFirstKillReports: async () => ({
        kind: "limitation",
        code: "rate_limited"
      })
    },
    logger: { info: (record) => records.push(record) }
  });

  await handler.execute("run-2");

  expect(records[0]).toMatchObject({
    outcome: "limitation",
    limitationCode: "rate_limited"
  });
});

it("records a run that was never claimed", async () => {
  const records: Array<Record<string, unknown>> = [];
  const handler = createApplicantEvidenceJobHandler({
    ...baseOptions,
    evidence: { ...baseOptions.evidence, claim: async () => null },
    logger: { info: (record) => records.push(record) }
  });

  await handler.execute("run-3");

  expect(records[0]).toMatchObject({ outcome: "not_claimed" });
});

it("emits nothing when no logger is supplied", async () => {
  const handler = createApplicantEvidenceJobHandler(baseOptions);
  await expect(handler.execute("run-4")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`
Expected: FAIL — `logger` is not an accepted option; no records.

- [ ] **Step 3: Implement**

Add to `ApplicantEvidenceJobHandlerOptions`:

```ts
  logger?: { info(value: Record<string, unknown>): void };
  monotonic?: () => number;
```

Accept either a plain run id or a job payload, so existing callers keep working:

```ts
export type ApplicantEvidenceJobInput =
  | string
  | Readonly<{
      runId: string;
      correlationId?: string;
      enqueuedAt?: string;
    }>;
```

Wrap the existing body. The record is built up as the run proceeds and emitted once in a `finally`, exactly mirroring the discovery handler:

```ts
    async execute(
      input: ApplicantEvidenceJobInput,
      context?: DiscoveryWorkContext
    ): Promise<void> {
      const job = typeof input === "string" ? { runId: input } : input;
      const monotonic = options.monotonic ?? (() => performance.now());
      const scope = createMeasurementScope(monotonic);
      const observedAt = monotonic();
      const record: Record<string, unknown> = {
        event: "evidence_job",
        runId: job.runId,
        correlationId: job.correlationId ?? null,
        queueWaitMs: queueWaitMs(job.enqueuedAt, new Date()),
        attempt: context?.attempt ?? 1,
        outcome: "unknown",
        limitationCode: null,
        parseLimitationCode: null,
        killCount: 0,
        requestCapUsed: options.requestCap,
        durationMs: 0
      };
      const evidence = measuredRepositories(
        { evidence: options.evidence },
        scope
      ).evidence;

      try {
        // ... existing body, with `options.evidence` replaced by `evidence`,
        // the getFirstKillReports call wrapped in
        //   scope.time("warcraftLogs", () => ...)
        // and each return path setting record.outcome to one of
        //   "not_claimed" | "limitation" | "partial" | "complete"
        // alongside record.limitationCode, record.parseLimitationCode and
        // record.killCount.
      } catch (error) {
        record.outcome = context?.signal.aborted
          ? "cancelled"
          : "unexpected_error";
        throw error;
      } finally {
        if (options.logger) {
          record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
          options.logger.info({ ...record, ...scope.totals() });
        }
      }
    }
```

- [ ] **Step 4: Wire the logger and throttle in the runtime**

In `apps/worker/src/runtime.ts`, pass `logger` and `monotonic` when constructing the evidence handler, and register the scope for Warcraft Logs throttle events the same way as Task 8. Confirm the evidence work registration passes `job.data` (not just the run id) so the correlation fields arrive — see `packages/database/src/queue.ts:396`.

- [ ] **Step 5: Route the two remaining `console.info` calls through pino**

Replace `console.info(JSON.stringify({ event: "evidence_cache_cleanup", removedEvidenceRuns }))` in `apps/worker/src/runtime.ts` with `logger?.info({ event: "evidence_cache_cleanup", removedEvidenceRuns })`. After this and Task 6, no `console.info` remains in either service — verify with:

```bash
grep -rn "console\." apps packages --include=*.ts --include=*.tsx | grep -v "\.test\."
```

Expected: no output.

- [ ] **Step 6: Confirm no new field is redacted**

Append to `apps/worker/src/logger.test.ts`:

```ts
it("keeps the evidence_job performance fields", () => {
  const lines: string[] = [];
  const logger = createWorkerLogger({
    write: (line: string) => lines.push(line)
  } as never);

  logger.info({
    event: "evidence_job",
    runId: "run-1",
    correlationId: "c1",
    durationMs: 50,
    queueWaitMs: 2_000,
    warcraftLogsMs: 40,
    warcraftLogsCalls: 1,
    warcraftLogsMaxCallMs: 40,
    dbMs: 10,
    dbCalls: 2,
    dbMaxCallMs: 6,
    rateLimitHits: 1,
    retryAfterMaxMs: 3_000,
    requestCapUsed: 80,
    killCount: 4
  });

  const record = JSON.parse(lines[0]!) as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    expect(value, `${key} was redacted`).not.toBe("[Redacted]");
  }
});
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm vitest run --project unit && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add packages/application apps/worker
git commit -m "feat: emit an evidence_job record and route remaining logs through pino"
```

---

### Task 10: Percentile analysis script

**Files:**

- Create: `scripts/analyze-performance-logs.mts`, `scripts/analyze-performance-logs.test.mts`
- Modify: `package.json`

**Interfaces:**

- Consumes: the three record shapes from Tasks 6, 8, and 9.
- Produces: `summarize(lines: readonly string[], event: string): PerformanceSummary` where `PerformanceSummary` is `{ event: string; count: number; fields: Record<string, { p50: number; p95: number; max: number }>; outcomes: Record<string, number> }`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/analyze-performance-logs.test.mts
import { describe, expect, it } from "vitest";

import { percentile, summarize } from "./analyze-performance-logs.mts";

const lines = [
  JSON.stringify({
    event: "http_request",
    durationMs: 100,
    dbMs: 10,
    status: 200
  }),
  JSON.stringify({
    event: "http_request",
    durationMs: 200,
    dbMs: 20,
    status: 200
  }),
  JSON.stringify({
    event: "discovery_run",
    durationMs: 999,
    outcome: "snapshot"
  }),
  "not json at all",
  ""
];

describe("percentile", () => {
  it("interpolates between samples", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });

  it("returns the only sample", () => {
    expect(percentile([7], 95)).toBe(7);
  });

  it("returns 0 for no samples", () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe("summarize", () => {
  it("summarizes one event type and ignores the rest", () => {
    const summary = summarize(lines, "http_request");
    expect(summary.count).toBe(2);
    expect(summary.fields.durationMs).toEqual({ p50: 150, p95: 195, max: 200 });
    expect(summary.fields.dbMs!.max).toBe(20);
  });

  it("skips unparseable lines rather than throwing", () => {
    expect(() => summarize(lines, "discovery_run")).not.toThrow();
    expect(summarize(lines, "discovery_run").count).toBe(1);
  });

  it("counts outcomes", () => {
    expect(summarize(lines, "discovery_run").outcomes).toEqual({ snapshot: 1 });
  });

  it("reports nothing for an absent event", () => {
    expect(summarize(lines, "evidence_job")).toMatchObject({
      count: 0,
      fields: {}
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --project unit scripts/analyze-performance-logs.test.mts`
Expected: FAIL — cannot resolve `./analyze-performance-logs.mts`.

- [ ] **Step 3: Write the implementation**

```ts
// scripts/analyze-performance-logs.mts
/**
 * Reads captured SlashWho log lines on stdin and reports p50/p95/max for every
 * numeric field of one record type. The log stream is the only sink, so this
 * script is what makes the percentiles in
 * docs/research/2026-09-15-applicant-research-performance.md obtainable.
 *
 * Usage: cat capture.log | pnpm tsx scripts/analyze-performance-logs.mts http_request
 */

export type FieldSummary = { p50: number; p95: number; max: number };

export type PerformanceSummary = {
  event: string;
  count: number;
  fields: Record<string, FieldSummary>;
  outcomes: Record<string, number>;
};

export function percentile(samples: readonly number[], target: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const position = ((sorted.length - 1) * target) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return (
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  );
}

export function summarize(
  lines: readonly string[],
  event: string
): PerformanceSummary {
  const samples = new Map<string, number[]>();
  const outcomes: Record<string, number> = {};
  let count = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Captured streams interleave non-JSON platform output. Skip it.
      continue;
    }
    if (record.event !== event) continue;
    count += 1;

    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        const bucket = samples.get(key) ?? [];
        bucket.push(value);
        samples.set(key, bucket);
      }
    }
    if (typeof record.outcome === "string") {
      outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    }
  }

  const fields: Record<string, FieldSummary> = {};
  for (const [key, values] of samples) {
    fields[key] = {
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: Math.max(...values)
    };
  }

  return { event, count, fields, outcomes };
}

async function main(): Promise<void> {
  const event = process.argv[2];
  if (!event) {
    process.stderr.write(
      "usage: analyze-performance-logs.mts <http_request|discovery_run|evidence_job>\n"
    );
    process.exitCode = 1;
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const summary = summarize(
    Buffer.concat(chunks).toString("utf8").split("\n"),
    event
  );

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("analyze-performance-logs.mts")) {
  await main();
}
```

- [ ] **Step 4: Add the package script**

In `package.json`, alongside the existing `ops:` and `generate:` entries:

```json
"analyze:performance": "tsx scripts/analyze-performance-logs.mts"
```

- [ ] **Step 5: Run tests, lint, and typecheck**

Run: `pnpm vitest run --project unit scripts/analyze-performance-logs.test.mts && pnpm typecheck && pnpm lint`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add scripts/analyze-performance-logs.mts scripts/analyze-performance-logs.test.mts package.json
git commit -m "feat: add a percentile summary script for captured performance logs"
```

---

### Task 11: Update the research document

**Files:**

- Modify: `docs/research/2026-09-15-applicant-research-performance.md`

**Interfaces:**

- Consumes: the field names produced by Tasks 6, 8, 9, and the script from Task 10.
- Produces: nothing code-facing.

- [ ] **Step 1: Correct the privacy sentence**

Replace "These records contain no character identity or upstream payloads." with an accurate statement. `discovery_run` has always carried the canonical `region`, `realm`, and `name` deliberately — see the allowlist comment at `packages/application/src/discovery-job-handler.ts:57`:

```markdown
These records carry the canonical public character key. They never carry an
owner identifier, a profile guess, an upstream payload, a URL, a request body,
or an IP address.
```

- [ ] **Step 2: Replace the measurement surface section**

Describe what now exists: `http_request` with per-operation provider buckets, database totals, limiter wait, throttle counters, and folded cache counters; `discovery_run` with provider, database, queue-wait, and throttle fields; and the new `evidence_job` record. State that a correlation ID links all three, and that a request which joined an existing run is marked `runJoined`.

- [ ] **Step 3: Replace the capture procedure with the script**

```markdown
Capture a log window covering at least 20 requests per scenario, then run:

    cat capture.log | pnpm analyze:performance http_request
    cat capture.log | pnpm analyze:performance discovery_run
    cat capture.log | pnpm analyze:performance evidence_job

Each run reports count, p50, p95, and maximum for every numeric field, plus a
breakdown by outcome.
```

- [ ] **Step 4: Verify and commit**

Run: `pnpm format:check`
Expected: PASS.

```bash
git add docs/research/2026-09-15-applicant-research-performance.md
git commit -m "docs: describe the performance records and the analysis script"
```

---

## Final verification

- [ ] Run the whole unit suite: `pnpm test:unit` — expect PASS.
- [ ] Run typecheck and lint: `pnpm typecheck && pnpm lint` — expect PASS.
- [ ] Run the integration suite: `pnpm test:integration` — expect PASS.
- [ ] Confirm no stray console logging: `grep -rn "console\." apps packages --include=*.ts --include=*.tsx | grep -v "\.test\."` — expect no output.
- [ ] Confirm no new field reduces to `score`: `grep -rn "Score\b" apps packages --include=*.ts | grep -v "\.test\."` — expect no new matches.
