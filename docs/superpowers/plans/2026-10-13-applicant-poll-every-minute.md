# Applicant sheet: poll every minute — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The applicant sheet watcher polls the Sheet every minute, as configured, instead of every 10 minutes in practice. It doesn't spend Warcraft Logs points every minute while the points gate is blocking.

**Architecture:**

- **Its own schedule.** The watcher tick gets its own pg-boss cron queue on `* * * * *`, separate from the 5-minute evidence-resume sweep.
- **Due check.** A pure due check stamps the poll's _start_ time and allows 15 s of tolerance. The tick remembers a points block for 5 minutes, and alerts on time spent failing rather than on a count of failures.
- **Token caching.** The Sheets client caches its service-account token.

**Tech stack:**

- TypeScript and Node 22. Always run `corepack pnpm`; bare `pnpm` is not on `PATH`.
- pg-boss 12.27.0.
- vitest, with a `unit` project and an `integration` project. The integration project uses Testcontainers, so it needs Docker.

**Spec:** [`docs/superpowers/specs/2026-10-13-applicant-application-links-design.md`](../specs/2026-10-13-applicant-application-links-design.md), "Change 1: poll every minute". The spec was signed off at c70d1a26, on PR Erilla/SlashWho#813. This plan is the first of two; the linking plan is [`2026-10-13-applicant-application-links.md`](2026-10-13-applicant-application-links.md).

**Where to work:** a fresh worktree off `origin/main`, never the spec branch:

```bash
git fetch origin
git worktree add -b feat/applicant-poll-every-minute .claude/worktrees/feat-applicant-poll-every-minute origin/main
```

## Global constraints

- `APPLICANT_POLL_CADENCE_MS` accepts 60,000 to 3,600,000. The minimum drops from 300,000; the default stays 300,000.
- **Cron.** The new queue `applicant-sheet-tick` runs on `* * * * *` in UTC. Evidence resume stays on `*/5 * * * *` and no longer runs the watcher.
- **Queue policy: `exclusive`, not `stately`.** The spec says `stately`. pg-boss 12's `exclusive` allows at most one job queued _or_ active per queue. That meets both of the spec's goals (no overlapping ticks across replicas or a deploy overlap, and no pile-up behind a slow tick), and it's the policy this repo already uses for its other queues. Mention this deviation in the PR description.
- **Queue options:** `retryLimit: 0`, `expireInSeconds: 300`.
- **Due tolerance:** 15,000 ms. A poll is due when `now - last_polled_at >= cadenceMs - 15_000`, where `last_polled_at` is the poll's start time.
- **Points block:** a blocked allowance suppresses the drain's probe, and the poll's Warcraft Logs id probe, for 300,000 ms, in memory per process.
- **Failure alert.** `applicant_poll_failed` fires once polls have been failing continuously for 900,000 ms (15 minutes), at most once an hour. It no longer fires after 3 failures.
- **Back-off** keeps its shape: `min(3_600_000, cadenceMs × 2^min(failures, 4))`.
- **Token cache.** A service-account token is reused until 60 s before its `expires_in`; if Google omits `expires_in`, assume 3,600 s.
- **Logging.** Logs stay count-only. No Sheet values, identities, tokens or URLs appear in log records.

## Review focus

1. **Deploy overlap.** For about 10 s during a deploy, old and new workers both run. The old worker still runs the watcher inside evidence resume, and the new one on its own queue. Intake and claims are already advisory-locked, so the worst case is an extra poll that finds no change. A test pins that the new worker's evidence-resume handler doesn't run the watcher.
2. **Watcher disabled.** No `applicant-sheet-tick` schedule may be registered. A stale schedule left by an earlier enabled deploy must run a no-op handler, not throw. Task 3 tests both.
3. **Points block expiry.** After 5 minutes the drain must probe again even if nothing else changed. Task 4 tests the block expiring.
4. **Clock skew between worker and database.** The due check uses the worker's clock for both stamps, because `now` is passed into `reconcileApplicantCounts`. A test pins that `last_polled_at` is the time passed in, not the database's `now()`.
5. **A failure streak that ends.** Success resets the 15-minute clock. Task 5 tests a success in the middle of a streak.

---

### Task 1: The `applicant-sheet-tick` queue

**Files:**

- Modify: `packages/database/src/queue.ts`. Add the queue name export near line 8, the interface method near line 92, a `let applicantSheetTickRegistered = false;` near line 228, and the method after `scheduleEvidenceResume`, around line 607.
- Modify: every `DiscoveryQueue` fake. Find them with `git grep -n "scheduleEvidenceResume" -- '*.test.ts' tests/`; today they're in `apps/web/src/server/container.test.ts` (6 places), `apps/worker/src/runtime.test.ts:288` and `tests/integration/fingerprint-resumption.test.ts:122`.
- Test: `packages/database/src/queue.test.ts`

**Interfaces:**

- Produces: `export const applicantSheetTickQueueName = "applicant-sheet-tick";`, and on `DiscoveryQueue`, `scheduleApplicantSheetTick(handler: () => Promise<void>): Promise<void>;`.

- [ ] **Step 1: Add `schedule` to the pg-boss fake and write the failing test**

In `packages/database/src/queue.test.ts`, add `schedule: vi.fn(async () => {}),` to the `queueFakes` object (beside `send`), and `schedule = queueFakes.schedule;` to the mocked `PgBoss` class. Add `applicantSheetTickQueueName` to the import from `./queue`. Then append:

```ts
describe("applicant sheet tick queue", () => {
  it("runs the watcher every minute, never two at once, without retries", async () => {
    // Break caught: the watcher only ran inside the five-minute evidence
    // resume cron, so no cadence setting could poll more often than that.
    const queue = createDiscoveryQueue({
      connectionString: "postgres://worker:secret@database/slashwho"
    });
    const ticks: string[] = [];
    await queue.start();
    await queue.scheduleApplicantSheetTick(async () => {
      ticks.push("tick");
    });
    await queue.scheduleApplicantSheetTick(async () => {
      ticks.push("second registration");
    });

    expect(queueFakes.createQueue).toHaveBeenCalledWith(
      applicantSheetTickQueueName,
      { policy: "exclusive", retryLimit: 0, expireInSeconds: 300 }
    );
    expect(
      queueFakes.schedule.mock.calls.filter(
        ([name]) => name === applicantSheetTickQueueName
      )
    ).toEqual([[applicantSheetTickQueueName, "* * * * *", {}, { tz: "UTC" }]]);
    const worker = queueFakes.workers.filter(
      ({ name }) => name === applicantSheetTickQueueName
    );
    expect(worker).toHaveLength(1);
    await worker[0]?.handler([]);
    expect(ticks).toEqual(["tick"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm vitest run packages/database/src/queue.test.ts -t "applicant sheet tick"`
Expected: FAIL. `queue.scheduleApplicantSheetTick is not a function`, or a TypeScript import error for `applicantSheetTickQueueName`.

- [ ] **Step 3: Implement**

In `packages/database/src/queue.ts`:

```ts
export const applicantSheetTickQueueName = "applicant-sheet-tick";
```

In `interface DiscoveryQueue`, after `scheduleEvidenceResume`:

```ts
  /**
   * Runs the applicant sheet watcher every minute. At most one tick is queued
   * or running across every worker, so a slow Sheet read never overlaps the
   * next tick, and ticks never pile up behind it.
   */
  scheduleApplicantSheetTick(handler: () => Promise<void>): Promise<void>;
```

Beside `let evidenceResumeRegistered = false;`:

```ts
let applicantSheetTickRegistered = false;
```

After `scheduleEvidenceResume`'s implementation:

```ts
    async scheduleApplicantSheetTick(handler) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      if (applicantSheetTickRegistered) return;
      // Exclusive: one tick queued or active across every worker, so a deploy's
      // overlap or a second replica never runs two polls at once, and a slow
      // tick drops the next minute's job rather than queueing it behind. A
      // missed minute needs no retry: the next one does the same work.
      // createQueue is idempotent and the policy is fixed at creation, so this
      // queue is born exclusive and never needs the policy migration.
      await boss.createQueue(applicantSheetTickQueueName, {
        policy: "exclusive",
        retryLimit: 0,
        expireInSeconds: 300
      });
      await boss.updateQueue(applicantSheetTickQueueName, {
        retryLimit: 0,
        expireInSeconds: 300
      });
      await boss.schedule(applicantSheetTickQueueName, "* * * * *", {}, {
        tz: "UTC"
      });
      await boss.work(
        applicantSheetTickQueueName,
        { pollingIntervalSeconds: 0.5 },
        async () => {
          const execution = handler();
          inFlight.add(execution);
          try {
            await execution;
          } finally {
            inFlight.delete(execution);
          }
        }
      );
      applicantSheetTickRegistered = true;
    },
```

Note that `updateQueue` is called without `policy`, because pg-boss forbids changing it there; see the comment at `queue.ts:287-289`. The test's `createQueue` expectation pins the exact options. Add the same `updateQueue` expectation if you like, but don't drop the `createQueue` one.

Add `async scheduleApplicantSheetTick() {},` beside `scheduleEvidenceResume` in each fake listed under **Files**. Exception: in `apps/worker/src/runtime.test.ts`, capture the handler as Task 3 needs. Add `let applicantSheetTickHandler: (() => Promise<void>) | undefined;` beside `evidenceResumeHandler`, then:

```ts
    async scheduleApplicantSheetTick(handler) {
      applicantSheetTickHandler = handler;
    },
```

and in the returned object, beside `get evidenceResumeHandler()`:

```ts
    get applicantSheetTickHandler() {
      return applicantSheetTickHandler;
    },
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `corepack pnpm vitest run packages/database/src/queue.test.ts`
Expected: PASS.
Run: `corepack pnpm typecheck`
Expected: no errors. A missing fake method fails here with `Property 'scheduleApplicantSheetTick' is missing`.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/queue.ts packages/database/src/queue.test.ts apps/web/src/server/container.test.ts apps/worker/src/runtime.test.ts tests/integration/fingerprint-resumption.test.ts
git commit -m "feat(database): an exclusive every-minute queue for the applicant sheet tick"
```

---

### Task 2: Allow a one-minute cadence

**Files:**

- Modify: `apps/worker/src/config.ts:157-163`
- Modify: `.env.example:154` and the comment above it
- Test: `apps/worker/src/config.test.ts`

**Interfaces:**

- Produces: `config.applicantWatcher.cadenceMs` may now be as low as `60_000`.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/config.test.ts`:

```ts
it("accepts a one-minute applicant poll cadence and nothing shorter", () => {
  // Break caught: the floor was five minutes, so the watcher could never
  // notice a new application sooner than that.
  expect(
    loadWorkerConfig({ ...environment, APPLICANT_POLL_CADENCE_MS: "60000" })
      .applicantWatcher.cadenceMs
  ).toBe(60_000);
  expect(() =>
    loadWorkerConfig({ ...environment, APPLICANT_POLL_CADENCE_MS: "59999" })
  ).toThrow("invalid_applicant_poll_cadence");
  expect(loadWorkerConfig(environment).applicantWatcher.cadenceMs).toBe(
    300_000
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm vitest run apps/worker/src/config.test.ts -t "one-minute"`
Expected: FAIL, with `invalid_applicant_poll_cadence` thrown for 60000.

- [ ] **Step 3: Implement**

In `apps/worker/src/config.ts`, change the minimum (the third argument) and leave the default as it is:

```ts
    cadenceMs: integerInRange(
      environment.APPLICANT_POLL_CADENCE_MS,
      300_000,
      60_000,
      3_600_000,
      "invalid_applicant_poll_cadence"
    ),
```

In `.env.example`, put this directly above `# APPLICANT_POLL_CADENCE_MS=300000`:

```
# How often the watcher reads the Sheet, in ms: 60000 (one minute, the finest
# its schedule runs) to 3600000. Admissions drain on the same tick.
```

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/config.ts apps/worker/src/config.test.ts .env.example
git commit -m "feat(worker): allow a one-minute applicant poll cadence"
```

---

### Task 3: Run the watcher on its own schedule, with a start-stamped due check

**Files:**

- Modify: `apps/worker/src/applicant-watcher.ts`, adding the exported due check near the top, after the type declarations.
- Modify: `apps/worker/src/runtime.ts`: `createApplicantSheetTick` (from about line 925; `pollSheet` and the returned tick) and the schedule wiring (about lines 1229-1232).
- Test: `apps/worker/src/applicant-watcher.test.ts`, `apps/worker/src/runtime.test.ts`, `tests/integration/applicant-watcher.test.ts`

**Interfaces:**

- Consumes: `DiscoveryQueue.scheduleApplicantSheetTick` (Task 1).
- Produces: `export const applicantPollToleranceMs = 15_000;` and

```ts
export function isApplicantPollDue(input: {
  now: number;
  lastPolledAt: Date | string | null | undefined;
  nextAttemptAt: number;
  cadenceMs: number;
}): boolean;
```

- [ ] **Step 1: Write the failing unit test for the due check**

Append to `apps/worker/src/applicant-watcher.test.ts`, adding `isApplicantPollDue` to its import from `./applicant-watcher`:

```ts
describe("isApplicantPollDue", () => {
  const minute = 60_000;
  const last = new Date("2026-10-13T12:00:00.000Z");
  const at = (ms: number) => last.getTime() + ms;

  it("polls a tick that starts a little before a full cadence has passed", () => {
    // Break caught: last_polled_at was stamped after the read, so a tick that
    // started a few hundred ms early skipped a whole period, and a five-minute
    // cadence polled every ten.
    expect(
      isApplicantPollDue({
        now: at(minute - 800),
        lastPolledAt: last,
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(true);
  });

  it("does not poll twice inside one cadence", () => {
    expect(
      isApplicantPollDue({
        now: at(minute - 15_001),
        lastPolledAt: last,
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(false);
  });

  it("polls when nothing has been polled yet", () => {
    expect(
      isApplicantPollDue({
        now: at(0),
        lastPolledAt: null,
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(true);
  });

  it("waits out a failure back-off even when the cadence has passed", () => {
    expect(
      isApplicantPollDue({
        now: at(10 * minute),
        lastPolledAt: last,
        nextAttemptAt: at(11 * minute),
        cadenceMs: minute
      })
    ).toBe(false);
  });

  it("reads last_polled_at as the string pg may return", () => {
    expect(
      isApplicantPollDue({
        now: at(minute),
        lastPolledAt: last.toISOString(),
        nextAttemptAt: 0,
        cadenceMs: minute
      })
    ).toBe(true);
  });
});
```

If `describe` isn't already imported in that file, add it to the `vitest` import.

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm vitest run apps/worker/src/applicant-watcher.test.ts -t isApplicantPollDue`
Expected: FAIL. `isApplicantPollDue` is not exported.

- [ ] **Step 3: Implement the due check**

In `apps/worker/src/applicant-watcher.ts`:

```ts
/**
 * A poll is due a little early: cron ticks start with jitter, and a tick that
 * starts even slightly before a full cadence has passed would otherwise skip a
 * whole period.
 */
export const applicantPollToleranceMs = 15_000;

/** Whether this tick should read the Sheet. `lastPolledAt` is a poll's start. */
export function isApplicantPollDue(input: {
  now: number;
  lastPolledAt: Date | string | null | undefined;
  nextAttemptAt: number;
  cadenceMs: number;
}): boolean {
  if (input.now < input.nextAttemptAt) return false;
  if (!input.lastPolledAt) return true;
  return (
    input.now - new Date(input.lastPolledAt).getTime() >=
    input.cadenceMs - applicantPollToleranceMs
  );
}
```

- [ ] **Step 4: Run the unit test**

Run: `corepack pnpm vitest run apps/worker/src/applicant-watcher.test.ts -t isApplicantPollDue`
Expected: PASS.

- [ ] **Step 5: Write the failing runtime tests**

In `apps/worker/src/runtime.test.ts`, the two existing applicant tests ("times the applicant sheet poll and drain" and "times and names a failed applicant poll and a failed tick") call `await fakes.evidenceResumeHandler?.();`. Change both to `await fakes.applicantSheetTickHandler?.();`. In the first test, change the comment "The stepping clock is read at the sweep, the tick, the poll and the drain" to "The stepping clock is read at the tick, the poll and the drain". Then add these after them, in the same `describe`:

```ts
it("runs the applicant watcher on its own schedule, not the evidence resume sweep", async () => {
  // Break caught: inside the five-minute resume cron, no cadence setting
  // could poll more often than every five minutes.
  vi.mocked(pollApplicantSheet).mockClear();
  vi.mocked(drainApplicantIntents).mockResolvedValue({
    admitted: 0,
    suppressed: 0,
    deferred: 0,
    pointsBlocked: false
  });
  vi.mocked(pollApplicantSheet).mockResolvedValue({
    baseline: false,
    rebaselined: false,
    created: 0,
    backlog: 0,
    invalid: 0,
    truncated: 0,
    newApplicants: []
  });
  const fakes = runtimeFakes();
  const runtime = await createWorkerRuntime(applicantConfig, {
    ...fakes.dependencies,
    createEvidenceGateway: applicantGateway
  });

  await fakes.evidenceResumeHandler?.();
  expect(pollApplicantSheet).not.toHaveBeenCalled();

  await fakes.applicantSheetTickHandler?.();
  expect(pollApplicantSheet).toHaveBeenCalledTimes(1);
  await runtime.stop();
});

it("registers no applicant tick while the watcher is disabled", async () => {
  const fakes = runtimeFakes();
  const runtime = await createWorkerRuntime(config, fakes.dependencies);

  expect(fakes.applicantSheetTickHandler).toBeUndefined();
  await runtime.stop();
});

it("stamps a poll with the time it started, not the time its read finished", async () => {
  // Break caught: stamping after the read made every next tick look early.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const startedAt = new Date("2026-10-13T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    let stamped: Date | undefined;
    vi.mocked(pollApplicantSheet).mockImplementationOnce(async (input) => {
      vi.setSystemTime(new Date(startedAt.getTime() + 5_000));
      stamped = input.now?.();
      return {
        baseline: false,
        rebaselined: false,
        created: 0,
        backlog: 0,
        invalid: 0,
        truncated: 0,
        newApplicants: []
      };
    });
    vi.mocked(drainApplicantIntents).mockResolvedValueOnce({
      admitted: 0,
      suppressed: 0,
      deferred: 0,
      pointsBlocked: false
    });
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(applicantConfig, {
      ...fakes.dependencies,
      createEvidenceGateway: applicantGateway
    });

    await fakes.applicantSheetTickHandler?.();

    expect(stamped).toEqual(startedAt);
    await runtime.stop();
  } finally {
    vi.useRealTimers();
  }
});
```

In the first existing test, add `pointsBlocked: false` to the `drainApplicantIntents` mock value and to the expected `applicant_sheet_drain` record. Task 4 adds the field; until then this test fails to typecheck, which is expected in Step 6.

- [ ] **Step 6: Run them and watch them fail**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts -t "applicant"`
Expected: FAIL. `applicantSheetTickHandler` is undefined, because the runtime still uses evidence resume, and `stamped` is undefined.

- [ ] **Step 7: Implement in the runtime**

In `apps/worker/src/runtime.ts`, import `isApplicantPollDue` from `./applicant-watcher`, beside `drainApplicantIntents` and `pollApplicantSheet`.

In `createApplicantSheetTick`, start `pollSheet` by capturing the start time, and pass it to the poll:

```ts
  async function pollSheet(): Promise<void> {
    const pollStartedAt = clock();
    // last_polled_at is this poll's start, so the next due check measures a
    // whole cadence from when this tick began, however long the read took.
    const pollStartedAtDate = new Date();
    try {
      // ...unchanged...
      const poll = await pollApplicantSheet({
        pool: pool as Pool,
        readRows: () => applicantSheet.readRows(),
        now: () => pollStartedAtDate,
        // ...the rest unchanged...
```

In the returned tick, replace the two-branch `if` around `await pollSheet();` with:

```ts
if (
  isApplicantPollDue({
    now: Date.now(),
    lastPolledAt: due.rows[0]?.last_polled_at as
      Date | string | null | undefined,
    nextAttemptAt: applicantNextPollAttempt,
    cadenceMs: config.applicantWatcher.cadenceMs
  })
) {
  await pollSheet();
}
```

and delete the now-unused `const last = …` line.

Replace the schedule wiring, currently:

```ts
await initializedQueue.scheduleEvidenceResume(async () => {
  await evidenceResumeSweep(context);
  await applicantSheetTick?.();
});
```

with:

```ts
await initializedQueue.scheduleEvidenceResume(() =>
  evidenceResumeSweep(context)
);
if (applicantSheetTick)
  await initializedQueue.scheduleApplicantSheetTick(applicantSheetTick);
```

**A stale schedule while the watcher is disabled.** If the watcher is later disabled, pg-boss keeps the `applicant-sheet-tick` schedule from an earlier enabled deploy. It creates a job each minute that no worker consumes, which is harmless and expires. Nothing else is needed. Don't call `unschedule` at startup, because a disabled worker overlapping an enabled one would remove the enabled one's schedule.

- [ ] **Step 8: Pin `last_polled_at` to the poll's start in the integration test**

In `tests/integration/applicant-watcher.test.ts`, append:

```ts
it("stamps last_polled_at with the time the poll was given, not the database's now()", async () => {
  // Break caught: a late stamp made a one-minute cadence poll every two minutes.
  const startedAt = new Date("2026-10-13T12:00:00.000Z");
  await pollApplicantSheet({
    pool,
    readColumn: async () => [a],
    backlogLimit: 20,
    now: () => startedAt
  });
  const state = await pool.query<{ last_polled_at: Date }>(
    "SELECT last_polled_at FROM applicant_source_state WHERE source = 'applicant_sheet'"
  );
  expect(state.rows[0]?.last_polled_at).toEqual(startedAt);
});
```

- [ ] **Step 9: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/applicant-watcher.test.ts apps/worker/src/runtime.test.ts`
Expected: PASS, apart from the `pointsBlocked` field, which Task 4 adds. If you're running tasks strictly in order, temporarily leave `pointsBlocked` out of the two mocks and the expected record, and add it back in Task 4 Step 3.
Run: `corepack pnpm test:integration -- tests/integration/applicant-watcher.test.ts` (this needs Docker)
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/worker/src/applicant-watcher.ts apps/worker/src/applicant-watcher.test.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts tests/integration/applicant-watcher.test.ts
git commit -m "fix(worker): poll the applicant sheet on its own minute schedule, timed from each poll's start"
```

---

### Task 4: Remember a points block for five minutes

**Files:**

- Modify: `apps/worker/src/applicant-watcher.ts`: `drainApplicantIntents` (from about line 388), its return type, and the allowance check (about lines 425-431).
- Modify: `apps/worker/src/runtime.ts`: `createApplicantSheetTick`.
- Test: `tests/integration/applicant-watcher.test.ts` ("does not admit against points already reserved by queued evidence", about line 318), and `apps/worker/src/runtime.test.ts`.

**Interfaces:**

- Produces: `drainApplicantIntents(...)` now returns `Promise<{ admitted: number; suppressed: number; deferred: number; pointsBlocked: boolean }>`. `pointsBlocked` is true only when the loop stopped because the allowance probe failed or was too low. Stopping for an empty queue, a full queue or the daily limit doesn't count.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/applicant-watcher.test.ts`, the test "does not admit against points already reserved by queued evidence" ends with `expect(result).toEqual({ admitted: 0, suppressed: 0, deferred: 0 });`. Change that to:

```ts
expect(result).toEqual({
  admitted: 0,
  suppressed: 0,
  deferred: 0,
  pointsBlocked: true
});
```

In `apps/worker/src/runtime.test.ts`, in the applicant `describe`, add:

```ts
it("skips the drain and its points probe for five minutes after a points block", async () => {
  // Break caught: each minute's drain probed the WCL allowance, at 1 point
  // a probe, sixty times an hour while the gate was already blocking.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    vi.mocked(pollApplicantSheet).mockResolvedValue({
      baseline: false,
      rebaselined: false,
      created: 0,
      backlog: 0,
      invalid: 0,
      truncated: 0,
      newApplicants: []
    });
    vi.mocked(drainApplicantIntents).mockClear();
    vi.mocked(drainApplicantIntents).mockResolvedValue({
      admitted: 0,
      suppressed: 0,
      deferred: 0,
      pointsBlocked: true
    });
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(applicantConfig, {
      ...fakes.dependencies,
      createEvidenceGateway: applicantGateway
    });

    await fakes.applicantSheetTickHandler?.();
    vi.setSystemTime(start + 4 * 60_000);
    await fakes.applicantSheetTickHandler?.();
    expect(drainApplicantIntents).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + 5 * 60_000);
    await fakes.applicantSheetTickHandler?.();
    expect(drainApplicantIntents).toHaveBeenCalledTimes(2);
    await runtime.stop();
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts -t "points block"`
Expected: FAIL. The drain is called 2 times by the 4-minute check, where 1 is expected.

- [ ] **Step 3: Implement the drain's signal**

In `apps/worker/src/applicant-watcher.ts`, in `drainApplicantIntents`, change the return type to `Promise<{ admitted: number; suppressed: number; deferred: number; pointsBlocked: boolean }>`. Add `let pointsBlocked = false;` beside the counters, and at the allowance check:

```ts
const allowance = await input.warcraftlogs.getRateLimit();
if (
  allowance.kind !== "rate_limit" ||
  allowance.limitPerHour - allowance.pointsSpentThisHour - reservedPoints <
    neededPoints
) {
  pointsBlocked = true;
  break;
}
```

Change the final return to `return { admitted, suppressed, deferred, pointsBlocked };`.

In `apps/worker/src/runtime.ts`, in `createApplicantSheetTick`, add beside the other closure state:

```ts
// A blocked WCL allowance stays blocked for a while; probing it again every
// minute would spend a point a probe while points are already short.
const pointsBlockMs = 300_000;
let pointsBlockedUntil = 0;
```

In the returned tick, wrap the drain:

```ts
if (Date.now() >= pointsBlockedUntil) {
  const drainStartedAt = clock();
  const wcl = evidenceGateway;
  if (!wcl.resolveCharacterById)
    throw new Error("applicant_resolver_unavailable");
  const drained = await drainApplicantIntents({
    // ...unchanged arguments...
  });
  if (drained.pointsBlocked) pointsBlockedUntil = Date.now() + pointsBlockMs;
  logger?.info({
    event: "applicant_sheet_drain",
    ...drained,
    durationMs: elapsedMs(clock, drainStartedAt)
  });
}
```

In `pollSheet`'s `isSuppressed`, the Warcraft Logs id branch shares the block. Replace the `if (numericAllowance === undefined) { ... }` block with:

```ts
if (Date.now() < pointsBlockedUntil) return "defer";
if (numericAllowance === undefined) {
  const allowance = await evidenceGateway.getRateLimit();
  numericAllowance =
    allowance.kind === "rate_limit" &&
    allowance.limitPerHour - allowance.pointsSpentThisHour >=
      config.applicantWatcher.minimumPoints;
  if (!numericAllowance) pointsBlockedUntil = Date.now() + pointsBlockMs;
}
```

Restore `pointsBlocked: false` in the Task 3 mocks and in the expected `applicant_sheet_drain` record, if you left it out there.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts`
Expected: PASS.
Run: `corepack pnpm test:integration -- tests/integration/applicant-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/applicant-watcher.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts tests/integration/applicant-watcher.test.ts
git commit -m "fix(worker): skip the applicant drain's points probe for five minutes after a block"
```

---

### Task 5: Alert on fifteen minutes of failure, not three failures

**Files:**

- Modify: `apps/worker/src/runtime.ts`: `pollSheet`'s success and `catch` paths in `createApplicantSheetTick`.
- Test: `apps/worker/src/runtime.test.ts`

**Interfaces:**

- Produces: `applicant_poll_failed` details become `{ failures: number; failingMinutes: number }`.

- [ ] **Step 1: Write the failing test**

In the applicant `describe` in `apps/worker/src/runtime.test.ts`:

```ts
it("alerts once polls have failed for fifteen minutes, however many attempts that took", async () => {
  // Break caught: at a one-minute cadence, three failures came about six
  // minutes in, and a short Sheets outage paged the maintainer.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    vi.mocked(pollApplicantSheet).mockReset();
    vi.mocked(pollApplicantSheet).mockRejectedValue(new Error("sheet_down"));
    vi.mocked(drainApplicantIntents).mockResolvedValue({
      admitted: 0,
      suppressed: 0,
      deferred: 0,
      pointsBlocked: false
    });
    const notify = vi.fn(async () => undefined);
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(
      {
        ...applicantConfig,
        applicantWatcher: {
          ...applicantConfig.applicantWatcher,
          cadenceMs: 60_000
        }
      },
      {
        ...fakes.dependencies,
        createEvidenceGateway: applicantGateway,
        createFingerprintAlertNotifier: () => ({ notify })
      }
    );
    const tickAt = async (minutes: number) => {
      vi.setSystemTime(start + minutes * 60_000);
      await fakes.applicantSheetTickHandler?.();
    };
    const pollAlerts = () =>
      notify.mock.calls.filter(
        ([alert]) =>
          (alert as { event: string }).event === "applicant_poll_failed"
      );

    // Back-off from a one-minute base: next attempts at +2, +4, +8 minutes.
    await tickAt(0);
    await tickAt(2);
    await tickAt(6);
    expect(pollApplicantSheet).toHaveBeenCalledTimes(3);
    expect(pollAlerts()).toEqual([]);

    await tickAt(16);
    expect(pollAlerts()).toEqual([
      [
        {
          event: "applicant_poll_failed",
          details: { failures: 4, failingMinutes: 16 }
        }
      ]
    ]);
    await runtime.stop();
  } finally {
    vi.useRealTimers();
  }
});

it("restarts the failure clock after a successful poll", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    const ok = {
      baseline: false,
      rebaselined: false,
      created: 0,
      backlog: 0,
      invalid: 0,
      truncated: 0,
      newApplicants: []
    };
    vi.mocked(pollApplicantSheet)
      .mockReset()
      .mockRejectedValueOnce(new Error("sheet_down"))
      .mockResolvedValueOnce(ok)
      .mockRejectedValue(new Error("sheet_down"));
    vi.mocked(drainApplicantIntents).mockResolvedValue({
      admitted: 0,
      suppressed: 0,
      deferred: 0,
      pointsBlocked: false
    });
    const notify = vi.fn(async () => undefined);
    const fakes = runtimeFakes();
    const runtime = await createWorkerRuntime(
      {
        ...applicantConfig,
        applicantWatcher: {
          ...applicantConfig.applicantWatcher,
          cadenceMs: 60_000
        }
      },
      {
        ...fakes.dependencies,
        createEvidenceGateway: applicantGateway,
        createFingerprintAlertNotifier: () => ({ notify })
      }
    );
    const tickAt = async (minutes: number) => {
      vi.setSystemTime(start + minutes * 60_000);
      await fakes.applicantSheetTickHandler?.();
    };

    await tickAt(0); // fails
    await tickAt(2); // succeeds, so the streak ends
    await tickAt(10); // fails: the streak starts again here
    await tickAt(20); // 10 minutes into the new streak
    expect(
      notify.mock.calls.filter(
        ([alert]) =>
          (alert as { event: string }).event === "applicant_poll_failed"
      )
    ).toEqual([]);
    await runtime.stop();
  } finally {
    vi.useRealTimers();
  }
});
```

The fakes' pool answers the `last_polled_at` query with a row that has no `last_polled_at`, so each tick is due unless the back-off holds it. If `createFingerprintAlertNotifier`'s type needs more than `notify`, cast the factory's return with `as never`.

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts -t "fifteen minutes|failure clock"`
Expected: FAIL. An alert arrives after the third failure (at +6 minutes), with details `{ failures: 3 }`.

- [ ] **Step 3: Implement**

In `createApplicantSheetTick`, add beside `applicantPollFailures`:

```ts
// When the current run of failed polls began. A count of failures is a poor
// stand-in at a one-minute cadence: three of them is only six minutes.
let applicantFailingSince: number | null = null;
const pollFailureAlertMs = 900_000;
```

In `pollSheet`, beside `applicantPollFailures = 0;`, add `applicantFailingSince = null;`. In the `catch`, after `applicantPollFailures++;`, add `applicantFailingSince ??= Date.now();`. Then replace the alert condition and details:

```ts
const failingMs = Date.now() - applicantFailingSince;
if (
  failingMs >= pollFailureAlertMs &&
  Date.now() - applicantAlertedAt > 3_600_000
) {
  applicantAlertedAt = Date.now();
  await fingerprintAlertNotifier?.notify({
    event: "applicant_poll_failed",
    details: {
      failures: applicantPollFailures,
      failingMinutes: Math.floor(failingMs / 60_000)
    }
  });
}
```

Check the notifier's type for `details`. If it is a closed shape, extend it in `apps/worker/src/notifiers.ts`; the Discord renderer prints every detail as `key: value`, so no rendering change is needed.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts apps/worker/src/notifiers.ts
git commit -m "fix(worker): alert on fifteen minutes of failed applicant polls, not three failures"
```

---

### Task 6: Reuse the service-account token

**Files:**

- Modify: `apps/worker/src/applicant-sheet.ts`: `headersForRead`, about lines 36-72.
- Test: `apps/worker/src/applicant-sheet.test.ts`

**Interfaces:** none outside the file.

- [ ] **Step 1: Write the failing test**

Append to `apps/worker/src/applicant-sheet.test.ts`:

```ts
it("reuses a service-account token until a minute before it expires", async () => {
  // Break caught: every read minted a new token, 1,440 token requests a day
  // at a one-minute cadence.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = new Date("2026-10-13T12:00:00.000Z").getTime();
    vi.setSystemTime(start);
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" }
    });
    let tokens = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("oauth2")) {
        tokens++;
        return new Response(
          JSON.stringify({ access_token: `token-${tokens}`, expires_in: 3600 })
        );
      }
      return new Response(JSON.stringify({ values: [] }));
    });
    const client = createApplicantSheetClient({
      sheetId: "fake-sheet",
      column: "F",
      email: "fake@example.test",
      privateKey,
      fetch: fetch as typeof globalThis.fetch
    });

    await client.readColumn();
    vi.setSystemTime(start + 3_539_000);
    await client.readColumn();
    expect(tokens).toBe(1);

    vi.setSystemTime(start + 3_541_000);
    await client.readColumn();
    expect(tokens).toBe(2);
    const lastRead = fetch.mock.calls.at(-1) as unknown as [
      string,
      RequestInit
    ];
    expect((lastRead[1].headers as Record<string, string>).authorization).toBe(
      "Bearer token-2"
    );
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm vitest run apps/worker/src/applicant-sheet.test.ts -t "reuses"`
Expected: FAIL. `tokens` is 2 after the second read.

- [ ] **Step 3: Implement**

In `createApplicantSheetClient`, before `headersForRead`:

```ts
// A token lasts an hour; minting one per read would be 1,440 a day.
let cachedToken: { value: string; refreshAt: number } | undefined;
```

At the start of `headersForRead`, after the API-key early return:

```ts
if (cachedToken && Date.now() < cachedToken.refreshAt)
  return { authorization: `Bearer ${cachedToken.value}` };
```

Replace the tail that reads the token:

```ts
if (!response.ok) throw new Error("applicant_google_auth_rejected");
const body = (await response.json()) as {
  access_token?: unknown;
  expires_in?: unknown;
};
const token = body.access_token;
if (typeof token !== "string") throw new Error("applicant_google_auth_invalid");
const lifetimeSeconds =
  typeof body.expires_in === "number" && body.expires_in > 0
    ? body.expires_in
    : 3_600;
cachedToken = {
  value: token,
  refreshAt: Date.now() + (lifetimeSeconds - 60) * 1_000
};
return { authorization: `Bearer ${token}` };
```

The existing test "requests only the configured response column…" still expects 2 fetches for one read, and it still gets them.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/applicant-sheet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/applicant-sheet.ts apps/worker/src/applicant-sheet.test.ts
git commit -m "perf(worker): reuse the applicant sheet's service-account token until near expiry"
```

---

### Task 7: Docs, full verification and the pull request

**Files:**

- Modify: `docs/operations/applicant-sheet-watcher.md`

- [ ] **Step 1: Update the operations doc**

In `docs/operations/applicant-sheet-watcher.md`:

- In the paragraph that begins "Set `APPLICANT_POLL_CADENCE_MS`…", insert this after its first sentence:

  > The watcher runs on its own pg-boss schedule, `applicant-sheet-tick`, every minute (UTC). At most one tick is queued or running across all workers. `APPLICANT_POLL_CADENCE_MS` (60000 to 3600000) sets how often a tick reads the Sheet. A poll is due 15 s early, measured from the previous poll's start, so a one-minute cadence polls every minute. Admissions drain on every tick. After the Warcraft Logs allowance blocks a drain, the drain and its points probe pause for 5 minutes.

- In the paragraph that lists the `applicant_sheet_*` events, add:

  > `applicant_poll_failed` is sent once polls have been failing continuously for 15 minutes (at most hourly), with `failures` and `failingMinutes`.

- [ ] **Step 2: Run the full gate**

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
```

Expected: all pass. If `format:check` fails, run `corepack pnpm format`, then rerun it.

- [ ] **Step 3: Commit, push and open the PR**

```bash
git add docs/operations/applicant-sheet-watcher.md
git commit -m "docs(operations): the applicant watcher's minute schedule and failure alert"
git push -u origin feat/applicant-poll-every-minute
```

Open the PR with `gh pr create`. Use the title `fix(worker): poll the applicant sheet every minute`. In the body:

- Link the spec PR, Erilla/SlashWho#813.
- State the `exclusive`-not-`stately` choice and why.
- Say that `APPLICANT_POLL_CADENCE_MS=60000` is set on test only after merge and deploy, with the maintainer's go-ahead.
- Say that test currently polls about every 10 minutes at the 5-minute setting (12:05, 12:15, 12:25 … on 2026-10-13).

Don't enable auto-merge; the Manager reviews it.

- [ ] **Step 4: After merge and deploy (with the maintainer's go-ahead)**

```bash
railway variables set APPLICANT_POLL_CADENCE_MS=60000 --service worker --environment test
```

Then confirm the cadence from the poll events' spacing:

```bash
railway logs -s worker -e test --json -n 2000 | grep '"applicant_sheet_poll"'
```

Expected: `applicant_sheet_poll` records about 60 s apart.
