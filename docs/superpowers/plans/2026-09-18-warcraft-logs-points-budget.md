# Warcraft Logs Points Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An evidence run asks Warcraft Logs how much of the hourly points allowance is left and refuses to start when too little remains, so a sweep defers instead of burning the whole allowance for no new evidence.

**Architecture:** The gateway gains `getRateLimit`, which returns normalised `rateLimitData` facts and carries no policy. `applicant-evidence-job-handler.ts` reads it after `claim` and, when `limitPerHour - pointsSpentThisHour` falls below `EVIDENCE_POINTS_RESERVE`, throws a retryable error instead of collecting — publishing nothing. The evidence queue learns the `retryAfterMs` machinery the discovery queue already has, so the refusal reschedules the job rather than failing it. A second sample after each run logs what the run actually spent, which is the evidence that replaces the reserve's guessed default.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (`unit` and `integration` projects), pg-boss over PostgreSQL, Drizzle migrations (none needed here).

**Spec:** `docs/superpowers/specs/2026-09-18-warcraft-logs-points-budget-design.md`

**Issue:** #282

## Global Constraints

- **`pointsSpentThisHour` is fractional.** Never parse it with an integer
  validator, never round it, never store it in an `integer` column. `9058.65`
  is a real observed value.
- **`limitPerHour` is read at runtime, never configured.** It moved 9000 →
  18000 mid-session on 2026-09-17. No env var, no migration, no constant.
- **`pointsResetIn` is authoritative.** Do not read `Retry-After` or
  `X-RateLimit-Remaining` for this decision; both were observed tracking a
  different bucket and caused two misdiagnoses on 2026-09-17.
- **Clamp the requested retry delay to 1800 seconds and floor it at 1.**
  `requestedRetryDelaySeconds` (`packages/database/src/queue.ts:131`) returns
  `null` for anything fractional, `< 1`, or `> retryDelayMax` (1800), and the
  job then falls back to `retryDelay: 1` with backoff — retrying almost
  immediately into another refusal. `pointsResetIn` reaches 3600.
- **A failed `getRateLimit` must not refuse the run.** The gate fails open. A
  gate that fails closed on its own transport errors can stop all collection
  permanently.
- **Never "just not claim" a refused run.** An unclaimed run stays `queued`,
  and `reserve` counts `('queued','running','retrying')` as `active`, so the
  character would never collect again. Claim, then throw.
- **Nothing is published on a refusal.** A zero-kill publish risks the
  destructive merge that caused the 24/175 → 1/175 loss in #250.
- **Read the rate limit from the _selected_ gateway**, i.e. after the
  per-run-credentials branch in the handler. A visitor's own Warcraft Logs
  credentials have their own allowance; reading the worker's shared allowance
  and applying it to their client would be measuring the wrong bucket.
- **Deliberate deviation from the spec, agreed here:** the spec writes
  `WarcraftLogsRateLimit` without a discriminant. This plan gives it
  `kind: "rate_limit"` so it narrows against `WarcraftLogsLimitation` the way
  `WarcraftLogsIdentity` (`kind: "identity"`) and the evidence result already
  do. Without a discriminant `result.kind` is a type error and every call site
  needs an `in` check. Fields are otherwise exactly as the spec names them.
- **`getRateLimit` is required, not optional, on the handler's gateway `Pick`.**
  An optional method that silently skips the gate is precisely the failure this
  change exists to prevent. Existing test fakes get updated.
- Run `npx prettier --check <the files you changed>` AND
  `npx eslint <the files you changed>` (repo-wide `pnpm lint` is broken by
  pre-existing `.worktrees/*` parse errors) and full `pnpm typecheck` before
  each commit. Use `corepack pnpm` — bare `pnpm` is not on PATH.
- Integration tests need Docker (Testcontainers `postgres:16-alpine`).
- Baseline before any change: 81 unit test files, 903 tests, 0 failures.

---

### Task 1: `getRateLimit` on the Warcraft Logs gateway

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.ts`
- Modify: `packages/warcraftlogs/src/index.ts`
- Test: `packages/warcraftlogs/src/client.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `WarcraftLogsRateLimit = Readonly<{ kind: "rate_limit"; limitPerHour: number; pointsSpentThisHour: number; pointsResetInSeconds: number }>`;
  `WarcraftLogsRateLimitResult = WarcraftLogsRateLimit | WarcraftLogsLimitation`;
  `WarcraftLogsGateway.getRateLimit(signal?: AbortSignal): Promise<WarcraftLogsRateLimitResult>`.

The upstream field is `pointsResetIn`; our field is `pointsResetInSeconds`. The
decoder must accept a fractional `pointsSpentThisHour` and must not treat a
fractional one as drift.

- [ ] **Step 1: Write the failing tests**

Add to `packages/warcraftlogs/src/client.test.ts`, inside the existing
top-level `describe`:

```ts
it("reads the hourly points allowance including a fractional spend", async () => {
  // Break caught: an integer validator on pointsSpentThisHour would reject the
  // real 9058.65 as schema drift, and the budget gate would silently fail open.
  const { client } = clientFor((url) =>
    url.pathname === "/oauth/token"
      ? token()
      : jsonResponse({
          data: {
            rateLimitData: {
              limitPerHour: 18000,
              pointsSpentThisHour: 9058.65,
              pointsResetIn: 949
            }
          }
        })
  );

  expect(await client.getRateLimit()).toEqual({
    kind: "rate_limit",
    limitPerHour: 18000,
    pointsSpentThisHour: 9058.65,
    pointsResetInSeconds: 949
  });
});

it("returns a limitation when the rate limit query cannot be read", async () => {
  // Break caught: throwing here would make the admission gate fail closed on
  // its own transport errors and stop all evidence collection permanently.
  const { client } = clientFor((url) =>
    url.pathname === "/oauth/token"
      ? token()
      : new Response("upstream-body-marker", { status: 503 })
  );

  expect(await client.getRateLimit()).toEqual({
    kind: "limitation",
    code: "unavailable"
  });
});

it("reports schema drift when the rate limit response omits its fields", async () => {
  // Break caught: a missing limitPerHour read as 0 would make every run look
  // over budget and refuse collection forever.
  const { client } = clientFor((url) =>
    url.pathname === "/oauth/token"
      ? token()
      : jsonResponse({ data: { rateLimitData: { pointsResetIn: 949 } } })
  );

  expect(await client.getRateLimit()).toEqual({
    kind: "limitation",
    code: "schema_drift"
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts -t "rate limit"`

Expected: FAIL — `client.getRateLimit is not a function`.

- [ ] **Step 3: Add the types**

In `packages/warcraftlogs/src/types.ts`, after `WarcraftLogsIdentityResult`:

```ts
/**
 * The Warcraft Logs hourly points allowance as the API reports it. Normalised
 * facts only: the reserve threshold that decides what is "too little left" is
 * policy and lives with the caller.
 */
export type WarcraftLogsRateLimit = Readonly<{
  kind: "rate_limit";
  limitPerHour: number;
  /** Fractional upstream; a real observed value is 9058.65. */
  pointsSpentThisHour: number;
  /** Upstream calls this `pointsResetIn`. It reaches 3600. */
  pointsResetInSeconds: number;
}>;

export type WarcraftLogsRateLimitResult =
  WarcraftLogsRateLimit | WarcraftLogsLimitation;
```

And add to the `WarcraftLogsGateway` interface, above `getFirstKillReports`:

```ts
  getRateLimit(signal?: AbortSignal): Promise<WarcraftLogsRateLimitResult>;
```

- [ ] **Step 4: Add the query, the helper, and the decoder**

In `packages/warcraftlogs/src/client.ts`, import the new type alongside the
existing ones:

```ts
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsTierBestParse,
  WarcraftLogsGateway,
  WarcraftLogsIdentityResult,
  WarcraftLogsLimitation,
  WarcraftLogsParseMetric,
  WarcraftLogsPerformance,
  WarcraftLogsRateLimitResult,
  WarcraftLogsReportResult,
  WarcraftLogsWipeEvidence
} from "./types";
```

Add the query beside the other query constants (after
`characterZoneParsesQuery`):

```ts
// The allowance the account is actually spending. `Retry-After` and
// `X-RateLimit-Remaining` track a different bucket and say nothing about this
// one; two misdiagnoses on 2026-09-17 came from reading them instead.
const rateLimitQuery = `
  query RateLimit {
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;
```

Add a validator beside `nonNegativeFiniteNumber`:

```ts
function positiveFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
```

Add the decoder beside `canonicalIdentity`:

```ts
function rateLimitFacts(value: unknown): WarcraftLogsRateLimitResult {
  const envelope = record(value);
  const data = envelope && record(envelope.data);
  const rateLimitData = data && record(data.rateLimitData);
  const limitPerHour =
    rateLimitData && positiveFiniteNumber(rateLimitData.limitPerHour);
  // Fractional upstream. An integer check here would reject 9058.65 as drift.
  const pointsSpentThisHour =
    rateLimitData && nonNegativeFiniteNumber(rateLimitData.pointsSpentThisHour);
  const pointsResetInSeconds =
    rateLimitData && nonNegativeInteger(rateLimitData.pointsResetIn);
  if (
    limitPerHour === null ||
    pointsSpentThisHour === null ||
    pointsResetInSeconds === null
  ) {
    return { kind: "limitation", code: "schema_drift" };
  }
  return {
    kind: "rate_limit",
    limitPerHour,
    pointsSpentThisHour,
    pointsResetInSeconds
  };
}
```

- [ ] **Step 5: Add the gateway method and export it**

In `createWarcraftLogsClient`, beside `resolveCharacter`:

```ts
async function getRateLimit(
  signal?: AbortSignal
): Promise<WarcraftLogsRateLimitResult> {
  const result = await graphql(rateLimitQuery, {}, signal);
  return result.kind === "success" ? rateLimitFacts(result.value) : result;
}
```

Change the factory's return at the end of the file:

```ts
return { getRateLimit, resolveCharacter, getFirstKillReports };
```

In `packages/warcraftlogs/src/index.ts`, add `WarcraftLogsRateLimit` and
`WarcraftLogsRateLimitResult` to the exported type list, keeping it
alphabetical (between `WarcraftLogsPerformance` and
`WarcraftLogsReportResult`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts`

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Check, then commit**

```bash
npx prettier --check packages/warcraftlogs/src/types.ts packages/warcraftlogs/src/client.ts packages/warcraftlogs/src/client.test.ts packages/warcraftlogs/src/index.ts
npx eslint packages/warcraftlogs/src
corepack pnpm typecheck
git add packages/warcraftlogs/src
git commit -m "feat: read the Warcraft Logs hourly points allowance"
```

---

### Task 2: The `points_budget_low` limitation code and its reader copy

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/contracts/src/dossier.ts:156-171`
- Modify: `packages/application/src/applicant-dossier-service.ts:195-218`
- Test: `packages/application/src/applicant-dossier-service.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `"points_budget_low"` as a member of `WarcraftLogsLimitationCode`
  and of the `dossierLimitationSchema` code enum.

`points_budget_low` is distinct from `rate_limited` on purpose: "we declined to
start" and "upstream refused us" are different facts about different actors,
and conflating them caused repeated misdiagnosis on 2026-09-17. The code does
not start with `parse_`, so without an explicit `case` it falls through
`limitationMessage`'s `default` and is described as a parse problem, which it
is not.

`limitation_code` is a plain `text` column in every table that stores one
(`0005_character_evidence.sql:10`, `0009_character_kill_parses.sql`) with no
enum or `CHECK` on its value, so **no migration is required**.

- [ ] **Step 1: Write the failing test**

Add to `packages/application/src/applicant-dossier-service.test.ts`:

`limitationMessage` is module-private. Assert through the same public path the
neighbouring parse-limitation test at line ~1444 uses — the `fixture({
evidenceLimitationCode })` helper and `dossiers.read(root)`. Add this beside
that test:

```ts
it("describes points_budget_low as a deferral, not a parse failure", async () => {
  // Break caught: points_budget_low does not start with "parse_", so without an
  // explicit case it falls through limitationMessage's default and tells the
  // reader parse availability is partial -- when in fact nothing was collected
  // and the run is waiting for the allowance to reset.
  const { dossiers } = fixture({ evidenceLimitationCode: "points_budget_low" });

  const result = await dossiers.read(root);
  if (result.kind !== "ready") throw new Error("Expected dossier");
  const limitation = result.dossier.limitations.find(
    (item) =>
      item.source === "warcraft_logs" &&
      item.character !== null &&
      item.character.name === root.name
  );
  expect(limitation).toEqual(
    expect.objectContaining({
      code: "points_budget_low",
      message:
        "Warcraft Logs collection was deferred because this dossier's hourly " +
        "points allowance is nearly spent. It resumes automatically once the " +
        "allowance resets; shown evidence is partial."
    })
  );
});
```

The refusal path itself publishes nothing, so this code does not reach storage
today. The copy still has to be right: the code is part of the domain
vocabulary the spec defines, and the `default` branch's answer for it is
actively wrong.

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm vitest run --project unit packages/application/src/applicant-dossier-service.test.ts -t "deferral"`

Expected: FAIL — the message is the `default` branch's "parse availability is
partial" copy. (Depending on how `fixture` types its argument, this may first
fail to compile because `"points_budget_low"` is not yet a member of the code
union; that is still a red test.)

- [ ] **Step 3: Add the code to both enums and the copy**

In `packages/warcraftlogs/src/types.ts`, add to `WarcraftLogsLimitationCode`
after `"rate_limited"`:

```ts
  /** We declined to start: too little of the hourly allowance was left. */
  | "points_budget_low"
```

In `packages/contracts/src/dossier.ts`, add `"points_budget_low"` to the
`z.enum([...])` list, after `"rate_limited"`.

In `packages/application/src/applicant-dossier-service.ts`, add a case to the
`switch (code)` in `limitationMessage`, after the `"rate_limited"` case:

```ts
    case "points_budget_low":
      return `${label} collection was deferred because this dossier's hourly points allowance is nearly spent. It resumes automatically once the allowance resets; shown evidence is partial.`;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/application packages/contracts`

Expected: PASS.

- [ ] **Step 5: Check, then commit**

```bash
npx prettier --check packages/warcraftlogs/src/types.ts packages/contracts/src/dossier.ts packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts
npx eslint packages/warcraftlogs/src packages/contracts/src packages/application/src
corepack pnpm typecheck
git add packages/warcraftlogs/src/types.ts packages/contracts/src/dossier.ts packages/application/src
git commit -m "feat: name a declined collection points_budget_low"
```

---

### Task 3: `EVIDENCE_POINTS_RESERVE` worker config

**Files:**

- Modify: `apps/worker/src/config.ts:6-34` (the `WorkerConfig` type) and
  `apps/worker/src/config.ts:184-198` (beside the other evidence settings)
- Modify: `.env.example:52`
- Test: `apps/worker/src/config.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `WorkerConfig.evidencePointsReserve: number`, read from
  `EVIDENCE_POINTS_RESERVE`, default `1500`, error code
  `invalid_evidence_points_reserve`.

- [ ] **Step 1: Write the failing test**

Add to `apps/worker/src/config.test.ts`, inside the existing test that covers
the evidence caps (the one asserting `invalid_evidence_parse_request_cap`):

```ts
expect(() =>
  loadWorkerConfig({ ...environment, EVIDENCE_POINTS_RESERVE: "0" })
).toThrow("invalid_evidence_points_reserve");
```

and extend that test's `toMatchObject` to include `evidencePointsReserve: 1500`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm vitest run --project unit apps/worker/src/config.test.ts`

Expected: FAIL — no error is thrown for `"0"`, and `evidencePointsReserve` is
`undefined`.

- [ ] **Step 3: Add the setting**

In the `WorkerConfig` type, after `evidenceParseCapRetryMs: number;`:

```ts
evidencePointsReserve: number;
```

In the returned object, after the `evidenceParseCapRetryMs` entry:

```ts
    // How much of the Warcraft Logs hourly allowance must remain before a run
    // is allowed to start.
    //
    // 1500 IS A GUESS. It is derived only from ten runs exceeding 9000 points
    // on 2026-09-17, so the average run costs more than 900; 1500 is that
    // floor plus headroom, picked so a run is refused rather than started and
    // abandoned part-way. The average says nothing about the distribution.
    // The `pointsSpentByRun` deltas the evidence job now logs are what replace
    // this guess with evidence -- revisit this within a day of the first
    // deployment. EVIDENCE_PARSE_REQUEST_CAP sat diverged between Railway (12)
    // and code (24) until 2026-09-17 precisely because nothing forced that
    // review.
    evidencePointsReserve: positiveInteger(
      environment.EVIDENCE_POINTS_RESERVE,
      1_500,
      "invalid_evidence_points_reserve"
    ),
```

In `.env.example`, after the `EVIDENCE_PARSE_CAP_RETRY_MS` block:

```
# How much of the Warcraft Logs hourly points allowance must remain before an
# evidence run may start. 1500 is a guess from one evening's observations and
# is meant to be revisited against the logged per-run spend, not left alone.
EVIDENCE_POINTS_RESERVE=1500
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm vitest run --project unit apps/worker/src/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Check, then commit**

```bash
npx prettier --check apps/worker/src/config.ts apps/worker/src/config.test.ts .env.example
npx eslint apps/worker/src
corepack pnpm typecheck
git add apps/worker/src/config.ts apps/worker/src/config.test.ts .env.example
git commit -m "feat: configure the evidence points reserve"
```

---

### Task 4: Admission check, refusal, and spend delta in the evidence handler

**Files:**

- Modify: `packages/application/src/applicant-evidence-job-handler.ts`
- Test: `packages/application/src/applicant-evidence-job-handler.test.ts`

**Interfaces:**

- Consumes: `WarcraftLogsGateway.getRateLimit` (Task 1);
  `"points_budget_low"` (Task 2).
- Produces: `ApplicantEvidenceJobHandlerOptions.pointsReserve: number`;
  `options.warcraftLogs` and the return of `options.createWarcraftLogsGateway`
  both widen to `Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit">`;
  the thrown refusal `Error("evidence_points_budget_low") & { retryable: true; retryAfterMs: number; code: "points_budget_low" }`;
  log fields `pointsLimitPerHour`, `pointsRemainingBefore`, `pointsSpentByRun`,
  `pointsRemainingAfter`.

Widening the `Pick` breaks the existing gateway fakes in the test file at lines
106, 364, 403 and 436. Updating each is mechanical and expected — Step 5.

- [ ] **Step 1: Write the failing tests**

Add to `packages/application/src/applicant-evidence-job-handler.test.ts`. The
helper keeps the new tests readable:

```ts
function budgetGateway(
  rateLimit: Awaited<ReturnType<WarcraftLogsGateway["getRateLimit"]>>,
  getFirstKillReports = vi.fn(async () => ({
    kind: "evidence" as const,
    kills: [],
    wipes: [],
    tierBests: []
  }))
) {
  return {
    getRateLimit: vi.fn(async () => rateLimit),
    getFirstKillReports
  } as unknown as Pick<
    WarcraftLogsGateway,
    "getFirstKillReports" | "getRateLimit"
  >;
}

it("refuses to start when too little of the hourly allowance remains", async () => {
  // Break caught: ten runs started against an exhausted allowance on
  // 2026-09-17, were all rate limited within six minutes, and gained nothing.
  const evidence = store();
  const warcraftLogs = budgetGateway({
    kind: "rate_limit",
    limitPerHour: 18_000,
    pointsSpentThisHour: 17_500.5,
    pointsResetInSeconds: 949
  });
  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs,
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 1_500
  });

  await expect(handler.execute(run.id)).rejects.toMatchObject({
    retryable: true,
    retryAfterMs: 949_000
  });
  expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  // Nothing published: a zero-kill publish risks the destructive merge of #250.
  expect(evidence.published).toEqual([]);
});

it("clamps a refusal's retry past the queue's maximum delay", async () => {
  // Break caught: requestedRetryDelaySeconds returns null above 1800, the job
  // falls back to retryDelay 1 with backoff, and retries straight into another
  // refusal. pointsResetIn reaches 3600.
  const handler = createApplicantEvidenceJobHandler({
    evidence: store(),
    warcraftLogs: budgetGateway({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 17_999,
      pointsResetInSeconds: 3_600
    }),
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 1_500
  });

  await expect(handler.execute(run.id)).rejects.toMatchObject({
    retryable: true,
    retryAfterMs: 1_800_000
  });
});

it("collects when the allowance is healthy", async () => {
  // Break caught: an off-by-one or inverted comparison would refuse every run
  // and stop collection entirely.
  const evidence = store();
  const warcraftLogs = budgetGateway({
    kind: "rate_limit",
    limitPerHour: 18_000,
    pointsSpentThisHour: 1_000.25,
    pointsResetInSeconds: 949
  });
  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs,
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 1_500
  });

  await handler.execute(run.id);

  expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledOnce();
  expect(evidence.published).toHaveLength(1);
});

it("collects when the allowance itself cannot be read", async () => {
  // Break caught: a gate that fails closed on its own transport errors can
  // stop all evidence collection permanently.
  const evidence = store();
  const warcraftLogs = budgetGateway({
    kind: "limitation",
    code: "unavailable"
  });
  const handler = createApplicantEvidenceJobHandler({
    evidence,
    warcraftLogs,
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 1_500
  });

  await handler.execute(run.id);

  expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledOnce();
  expect(evidence.published).toHaveLength(1);
});

it("logs what the run spent against the allowance", async () => {
  // Break caught: the 1500 reserve is an admitted guess, and without a measured
  // per-run spend there is nothing to replace it with.
  const infos: Array<Record<string, unknown>> = [];
  const getRateLimit = vi
    .fn()
    .mockResolvedValueOnce({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 1_000.25,
      pointsResetInSeconds: 949
    })
    .mockResolvedValueOnce({
      kind: "rate_limit",
      limitPerHour: 18_000,
      pointsSpentThisHour: 1_950.75,
      pointsResetInSeconds: 900
    });
  const handler = createApplicantEvidenceJobHandler({
    evidence: store(),
    warcraftLogs: {
      getRateLimit,
      getFirstKillReports: vi.fn(async () => ({
        kind: "evidence" as const,
        kills: [],
        wipes: [],
        tierBests: []
      }))
    } as unknown as Pick<
      WarcraftLogsGateway,
      "getFirstKillReports" | "getRateLimit"
    >,
    requestCap: 500,
    parseRequestCap: 24,
    parseCapRetryMs: 1_800_000,
    pointsReserve: 1_500,
    logger: { info: (value) => infos.push(value) }
  });

  await handler.execute(run.id);

  expect(infos.at(-1)).toMatchObject({
    pointsLimitPerHour: 18_000,
    pointsRemainingBefore: 16_999.75,
    pointsSpentByRun: 950.5,
    pointsRemainingAfter: 16_049.25
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `corepack pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts`

Expected: FAIL — `pointsReserve` is not a known option, `getRateLimit` is never
called, and `handler.execute` resolves instead of rejecting.

- [ ] **Step 3: Widen the options and add the refusal**

In `packages/application/src/applicant-evidence-job-handler.ts`, import the new
type:

```ts
import type {
  WarcraftLogsFirstKillEvidence,
  WarcraftLogsGateway,
  WarcraftLogsLimitationCode,
  WarcraftLogsRateLimit,
  WarcraftLogsWipeEvidence
} from "@slashwho/warcraftlogs";
```

Widen both gateway members of `ApplicantEvidenceJobHandlerOptions`:

```ts
  warcraftLogs: Pick<
    WarcraftLogsGateway,
    "getFirstKillReports" | "getRateLimit"
  >;
  createWarcraftLogsGateway?: (credentials: {
    clientId: string;
    clientSecret: string;
  }) => Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit">;
```

and add the reserve after `parseCapRetryMs`:

```ts
/**
 * How many Warcraft Logs points must remain unspent this hour before a run
 * may start. The gateway reports the allowance; this is the policy applied
 * to it.
 */
pointsReserve: number;
```

Add above `createApplicantEvidenceJobHandler`:

```ts
// The queue's own ceiling. `requestedRetryDelaySeconds` rejects anything above
// `retryDelayMax` and the job then falls back to `retryDelay: 1` with backoff,
// retrying almost immediately into another refusal. `pointsResetIn` reaches
// 3600, so a long reset costs one extra attempt; by the second refusal the
// reset is necessarily within this window.
const MAXIMUM_REFUSAL_RETRY_SECONDS = 1_800;

type PointsBudgetRefusal = Error & {
  readonly retryable: true;
  readonly retryAfterMs: number;
  readonly code: "points_budget_low";
};

function pointsBudgetRefusal(resetInSeconds: number): PointsBudgetRefusal {
  // Whole seconds, at least 1 and at most 1800: outside that range
  // `requestedRetryDelaySeconds` returns null and the delay is discarded.
  const delaySeconds = Math.min(
    Math.max(Math.ceil(resetInSeconds), 1),
    MAXIMUM_REFUSAL_RETRY_SECONDS
  );
  return Object.assign(new Error("evidence_points_budget_low"), {
    retryable: true as const,
    retryAfterMs: delaySeconds * 1_000,
    code: "points_budget_low" as const
  });
}

function isPointsBudgetRefusal(error: unknown): error is PointsBudgetRefusal {
  return (
    error instanceof Error &&
    (error as Partial<PointsBudgetRefusal>).code === "points_budget_low"
  );
}

function remainingPoints(budget: WarcraftLogsRateLimit): number {
  return budget.limitPerHour - budget.pointsSpentThisHour;
}
```

- [ ] **Step 4: Wire the check into `execute`**

Add the four new fields to the initial `record` literal, beside
`requestCapUsed`, so the log shape is stable whether or not the budget is
readable:

```ts
        pointsLimitPerHour: null,
        pointsRemainingBefore: null,
        pointsSpentByRun: null,
        pointsRemainingAfter: null,
```

Immediately after the `activeContext.signal.throwIfAborted();` that follows the
gateway selection — and before `hydratedFightUrls` — insert:

```ts
// Read from `gateway`, not `options.warcraftLogs`: a run carrying a
// visitor's own credentials spends *their* allowance, and the worker's
// shared allowance says nothing about it.
//
// A limitation here does not refuse the run. We are no worse off than
// before this gate existed, and a gate that fails closed on its own
// transport errors could stop all collection permanently.
const budgetBefore = await gateway.getRateLimit(activeContext.signal);
const openingBudget = budgetBefore.kind === "rate_limit" ? budgetBefore : null;
if (openingBudget) {
  record.pointsLimitPerHour = openingBudget.limitPerHour;
  record.pointsRemainingBefore = remainingPoints(openingBudget);
  if (remainingPoints(openingBudget) < options.pointsReserve) {
    // The run stays claimed and nothing is published. Leaving it
    // unclaimed instead would be a bug: `reserve` counts
    // ('queued','running','retrying') as active, so the character
    // would join a run that is never processed and never collect
    // again. Publishing instead risks the destructive merge of #250.
    record.outcome = "points_budget_low";
    record.limitationCode = "points_budget_low";
    throw pointsBudgetRefusal(openingBudget.pointsResetInSeconds);
  }
}
activeContext.signal.throwIfAborted();
```

Immediately after the `activeContext.signal.throwIfAborted();` that follows the
`getFirstKillReports` call — before the `response.kind === "limitation"` branch,
so a rate-limited run is measured too — insert:

```ts
// What the run actually cost. This is the measurement that replaces the
// guessed reserve with evidence, so it is sampled even when the run was
// limited. A negative `pointsSpentByRun` means the hourly window reset
// mid-run; it is logged as observed rather than clamped away.
const budgetAfter = await gateway.getRateLimit(activeContext.signal);
if (budgetAfter.kind === "rate_limit") {
  record.pointsRemainingAfter = remainingPoints(budgetAfter);
  if (openingBudget) {
    record.pointsSpentByRun =
      budgetAfter.pointsSpentThisHour - openingBudget.pointsSpentThisHour;
  }
}
```

Change the `catch` so a refusal is not mislabelled as an unexpected error:

```ts
      } catch (error) {
        record.outcome = activeContext.signal.aborted
          ? "cancelled"
          : isPointsBudgetRefusal(error)
            ? "points_budget_low"
            : "unexpected_error";
        throw error;
      } finally {
```

- [ ] **Step 5: Update the existing gateway fakes**

At lines ~106, ~364, ~403 and ~436 the file builds gateway fakes cast to
`Pick<WarcraftLogsGateway, "getFirstKillReports">`. For each, widen the cast to
`Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit">` and add a
member that keeps the gate open:

```ts
getRateLimit: async () => ({
  kind: "rate_limit" as const,
  limitPerHour: 18_000,
  pointsSpentThisHour: 0,
  pointsResetInSeconds: 949
}),
```

Add `pointsReserve: 1_500` to every existing
`createApplicantEvidenceJobHandler({...})` call in the file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit packages/application`

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 7: Check, then commit**

```bash
npx prettier --check packages/application/src/applicant-evidence-job-handler.ts packages/application/src/applicant-evidence-job-handler.test.ts
npx eslint packages/application/src
corepack pnpm typecheck
git add packages/application/src
git commit -m "feat: refuse an evidence run when the points allowance is low"
```

---

### Task 5: Honour a retry directive on the evidence queue

**Files:**

- Modify: `packages/database/src/queue.ts:398-434` (`workCharacterEvidence`)
- Test: `tests/integration/queue.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks — the refusal shape is
  `{ retryable: true, retryAfterMs: number }`, which
  `requestedRetryDelaySeconds` already reads.
- Produces: nothing new.

**This is the gap that makes Task 4 work.** The spec says the refusal "reuses
machinery that already exists" — and it does exist, but only on the
`discover-character` queue (`queue.ts:334-343`) and the `fingerprint-admission`
queue (`queue.ts:368-382`). `workCharacterEvidence` calls its handler with no
`catch` at all, so today a thrown `retryAfterMs` is ignored and the job retries
on pg-boss backoff from `retryDelay: 1`. Without this task a refusal retries
after about a second, straight into another refusal, and burns all five
attempts in seconds.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/queue.test.ts`, beside the two existing retry-delay
tests. Add `const characterEvidenceQueueName = "collect-character-evidence";`
next to the other queue-name constants at the top of the file if it is not
already there.

```ts
it("schedules an evidence retry no earlier than the requested delay", async () => {
  // Break caught: workCharacterEvidence ignored retryAfterMs entirely, so a
  // points-budget refusal retried on the 1-second backoff, straight into
  // another refusal, and burned every attempt in seconds.
  const queue = createDiscoveryQueue({ connectionString });
  cleanup.push(() => queue.stop({ graceful: false, timeoutMs: 1_000 }));
  await queue.start();
  const inspector = new PgBoss(connectionString);
  cleanup.push(() => inspector.stop({ graceful: false, timeout: 1_000 }));
  await inspector.start();

  let failedAt = 0;
  await queue.workCharacterEvidence(async () => {
    failedAt = Date.now();
    throw Object.assign(new Error("evidence_points_budget_low"), {
      retryable: true,
      retryAfterMs: 5_000
    });
  });
  const jobId = await queue.enqueueCharacterEvidence(
    "00000000-0000-4000-8000-000000000009"
  );

  await eventually(async () => {
    const [job] = await inspector.findJobs(characterEvidenceQueueName, {
      id: jobId
    });
    return job?.state === "retry";
  });
  const [retrying] = await inspector.findJobs(characterEvidenceQueueName, {
    id: jobId
  });
  expect(retrying!.startAfter.getTime()).toBeGreaterThanOrEqual(
    failedAt + 4_900
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm vitest run --project integration tests/integration/queue.test.ts -t "evidence retry"`

Expected: FAIL — `startAfter` is roughly one second after `failedAt`, not five.
Docker must be running.

- [ ] **Step 3: Wire the directive into the evidence worker**

In `workCharacterEvidence`, replace the body of the `execution` IIFE:

```ts
const execution = (async () => {
  try {
    await handler(job.data, {
      attempt: job.retryCount + 1,
      maxAttempts: job.retryLimit + 1,
      signal: job.signal
    });
  } catch (error) {
    // A points-budget refusal carries how long to wait. Without this
    // the job retries on the 1-second backoff, straight into another
    // refusal, and exhausts retryLimit in seconds.
    const retryDelaySeconds = requestedRetryDelaySeconds(error);
    if (retryDelaySeconds !== null) {
      await updateActiveRetryDelay(
        boss.getDb(),
        job.id,
        retryDelaySeconds,
        collectCharacterEvidenceQueueName
      );
    }
    throw error;
  }
})();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `corepack pnpm vitest run --project integration tests/integration/queue.test.ts`

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Check, then commit**

```bash
npx prettier --check packages/database/src/queue.ts tests/integration/queue.test.ts
npx eslint packages/database/src tests/integration
corepack pnpm typecheck
git add packages/database/src/queue.ts tests/integration/queue.test.ts
git commit -m "fix: honour a retry directive on the evidence queue"
```

---

### Task 6: Wire the reserve through the worker runtime

**Files:**

- Modify: `apps/worker/src/runtime.ts:55` and `apps/worker/src/runtime.ts:308-331`
- Test: `apps/worker/src/runtime.test.ts:209-210`, `:551-583`
- Modify: `docs/dossier-cache-policy.md`

**Interfaces:**

- Consumes: `WorkerConfig.evidencePointsReserve` (Task 3);
  `ApplicantEvidenceJobHandlerOptions.pointsReserve` (Task 4).
- Produces: nothing new.

Without this task nothing in production reads the setting, and `typecheck`
fails because `pointsReserve` is a required option.

- [ ] **Step 1: Write the failing test**

In `apps/worker/src/runtime.test.ts`, extend the `toMatchObject` assertion in
`"registers worker-owned Warcraft Logs evidence collection"`:

```ts
expect(handlerOptions).toMatchObject({
  warcraftLogs,
  createWarcraftLogsGateway: expect.any(Function),
  decryptionKey: config.evidenceJobCredentialEncryptionKey,
  requestCap: 500,
  parseRequestCap: 8,
  pointsReserve: config.evidencePointsReserve,
  evidence: (
    fakes.repositories as typeof fakes.repositories & {
      evidence: unknown;
    }
  ).evidence
});
```

and ensure the test `config` in this file carries an `evidencePointsReserve`
value (add `evidencePointsReserve: 1_500` wherever the file builds its
`WorkerConfig` fixture, beside `evidenceParseRequestCap`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm vitest run --project unit apps/worker/src/runtime.test.ts`

Expected: FAIL — `pointsReserve` is `undefined` on the captured options.

- [ ] **Step 3: Pass the setting through and widen the gateway type**

In `apps/worker/src/runtime.ts`, widen the dependency signature at line 55:

```ts
  ) => Pick<WarcraftLogsGateway, "getFirstKillReports" | "getRateLimit">;
```

and add to the `dependencies.createEvidenceHandler({...})` call, after
`parseCapRetryMs`:

```ts
pointsReserve: config.evidencePointsReserve,
```

In `apps/worker/src/runtime.test.ts`, widen the two
`Pick<WarcraftLogsGateway, "getFirstKillReports">` casts at lines ~210 and ~556
to include `| "getRateLimit"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm vitest run --project unit apps/worker`

Expected: PASS.

- [ ] **Step 5: Document the behaviour**

In `docs/dossier-cache-policy.md`, beside the existing
`EVIDENCE_PARSE_CAP_RETRY_MS` paragraph (around line 47), add:

```markdown
A run also checks the Warcraft Logs hourly points allowance before it starts.
When fewer than `EVIDENCE_POINTS_RESERVE` points (1500 by default) remain, the
run is claimed, publishes nothing, and reschedules itself for the reported
reset — clamped to the queue's 1800-second maximum. Five refusals in a row fail
the run, which is safe: `failed` is in neither the active set nor
`loadCompletedEvidence`'s `('complete','partial')`, so the character falls back
to its previous evidence and a later read reserves a fresh run. If the
allowance itself cannot be read the run proceeds, because a gate that fails
closed on its own transport errors could stop all collection permanently.
```

- [ ] **Step 6: Full verification, then commit**

```bash
npx prettier --check apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts docs/dossier-cache-policy.md
npx eslint apps/worker/src
corepack pnpm typecheck
corepack pnpm test:unit
git add apps/worker/src docs/dossier-cache-policy.md
git commit -m "feat: apply the evidence points reserve in the worker"
```

Expected: the 903 pre-existing unit tests still pass, plus the new ones.

---

## Verification beyond the tests

The spec's honest end-to-end check cannot be run from the test suite. After
deployment:

1. Confirm `EVIDENCE_POINTS_RESERVE` is set in the Railway worker service, or
   deliberately left to the 1500 default. `EVIDENCE_PARSE_REQUEST_CAP` sat
   diverged between Railway and code for weeks; do not repeat it.
2. Trigger a sweep that previously exhausted the allowance. Most runs should
   refuse up front, and `rateLimitData.pointsSpentThisHour` should stay well
   short of `limitPerHour`.
3. Read `pointsSpentByRun` across the evidence job logs and **revisit the 1500
   reserve within a day**. That is the whole point of the delta logging; the
   guess is not meant to survive contact with data.

## Deliberately out of scope

- Mid-run rate-limit checks, pending the delta measurements this change
  produces.
- Staggering refresh dispatch.
- #271 `parse_schema_drift`, which recurred on `rinn` and `riln` on 2026-09-17
  and leaves those characters stuck regardless of this work.
