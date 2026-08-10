# Achievement-Fingerprint Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic, privacy-preserving Blizzard achievement-fingerprint discovery to SlashWho's existing durable search workflow.

**Architecture:** A `discover-character` run still owns all public state and is the only snapshot writer. A private FIFO admission queue coordinates eligible runs against a PostgreSQL-backed Blizzard request-budget ledger, then re-dispatches the existing discovery run to perform one in-memory Blizzard guild-roster sweep and atomically merge matches into its normal snapshot.

**Tech Stack:** TypeScript, pnpm workspaces, Zod, Vitest, PostgreSQL, Drizzle migrations, pg-boss, Node `fetch`, Railway worker configuration.

## Global Constraints

- Use `BLIZZARD_CLIENT_ID` and `BLIZZARD_CLIENT_SECRET` only in the private worker service; never serialize or log them.
- Persist no achievement IDs, completion timestamps, fingerprint signatures, match scores, raw Blizzard bodies, access tokens, or candidate cursor/list.
- Raider.IO privacy-hidden ownership is the sole privacy signal. It excludes fingerprint-derived linkage; there is no SlashWho opt-out.
- Match only within one region; do not support CN fingerprints or cross-region comparisons.
- Accept only at least 200 common achievements with at least 20% identical completion timestamps.
- The initial shared limit is 28,800 Blizzard requests per rolling hour. Reserve a sweep's full configured cap before it begins; wait FIFO rather than reject.
- A root may publish at most one fingerprint sweep every seven days. Only successful snapshot publication advances that time.
- A cap-bounded sweep publishes a partial snapshot with internal `fingerprint_sweep_capped`; transport failures, 429s, 5xxs, schema failures, aborts, and shutdowns publish nothing and retain the previous snapshot.
- Public API payloads, pages, and snapshot history remain provenance-free; fingerprint and budget details are internal only.
- Follow `docs/contributing.md`: short-lived `feat/` branches, conventional commits, PR to `main`, squash merge.

---

## File structure

| Path                                                                        | Responsibility                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/blizzard/src/client.ts`                                           | OAuth token acquisition, regional Profile API requests, response validation, safe failure conversion.                           |
| `packages/blizzard/src/fingerprint.ts`                                      | Ephemeral achievement extraction and pure threshold comparison.                                                                 |
| `packages/blizzard/src/types.ts`                                            | Blizzard gateway and roster/fingerprint value types; no persistent representations.                                             |
| `packages/domain/src/fingerprint-discovery.ts`                              | Cap-aware root-guild sweep over a `BlizzardGateway`, producing candidate character observations and partial/failure outcomes.   |
| `packages/database/src/schema.ts` and `drizzle/0002_fingerprint_sweeps.sql` | Internal source enum extension, per-root sweep state, FIFO admission rows, and rolling reservation ledger.                      |
| `packages/database/drizzle/0004_simple_venom.sql`                           | Individual timestamped fingerprint request events for rolling-hour admission accounting.                                        |
| `packages/database/src/repositories.ts` / `postgres-repositories.ts`        | Transactional sweep eligibility, FIFO admission, budget reservation/use/release, and snapshot completion bookkeeping.           |
| `packages/database/src/queue.ts`                                            | Private `fingerprint-admission` pg-boss queue and dispatch contract.                                                            |
| `packages/application/src/discovery-job-handler.ts`                         | Coordinates Raider.IO discovery, deferred admission, fingerprint sweep, merged atomic snapshot, and safe retry/abort behaviour. |
| `apps/worker/src/config.ts` / `runtime.ts`                                  | Validated Blizzard and sweep settings; creates the Blizzard client and registers admission workers/maintenance.                 |
| Existing unit, integration, and runtime tests                               | Demonstrate privacy, budget, snapshot, retry, and public-contract invariants.                                                   |

### Dependency seam

`@slashwho/blizzard` depends on `@slashwho/domain` for the existing canonical character key. To avoid a reverse workspace dependency, the domain module owns the small `FingerprintGateway` interface it needs. The application layer supplies an adapter around `BlizzardGateway`; domain tests use a fake. The domain module never imports `@slashwho/blizzard`.

## Task 1: Create the Blizzard boundary and pure matcher

**Files:**

- Create: `packages/blizzard/src/types.ts`
- Create: `packages/blizzard/src/fingerprint.ts`
- Create: `packages/blizzard/src/fingerprint.test.ts`
- Create: `packages/blizzard/src/client.ts`
- Create: `packages/blizzard/src/client.test.ts`
- Create: `packages/blizzard/src/index.ts`
- Create: `packages/blizzard/package.json`

**Interfaces:**

- Consumes: `CharacterKey` from `@slashwho/domain` and an injected `fetch` implementation.
- Produces:

```ts
export type AchievementFingerprint = ReadonlyMap<number, number>;

export type BlizzardRosterCharacter = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
}>;

export interface BlizzardGateway {
  getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal
  ): Promise<readonly BlizzardRosterCharacter[]>;
  getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<AchievementFingerprint>;
}

export function compareFingerprints(
  root: AchievementFingerprint,
  candidate: AchievementFingerprint,
  policy: { minimumCommon: number; minimumIdenticalPercent: number }
): { common: number; identical: number; isMatch: boolean };
```

- [ ] **Step 1: Write failing matcher tests**

```ts
it("requires both the common-achievement floor and identical-timestamp floor", () => {
  expect(compareFingerprints(root, tooSmall, policy).isMatch).toBe(false);
  expect(compareFingerprints(root, belowPercent, policy).isMatch).toBe(false);
  expect(compareFingerprints(root, exactBoundary, policy)).toMatchObject({
    common: 200,
    identical: 40,
    isMatch: true
  });
});
```

- [ ] **Step 2: Run the matcher test to verify it fails**

Run: `pnpm --filter @slashwho/blizzard test -- fingerprint.test.ts`

Expected: FAIL because the workspace and matcher do not exist.

- [ ] **Step 3: Implement the smallest pure matcher and ephemeral types**

Extract only numeric achievement ID/timestamp pairs from a validated response. Compare maps without mutation, return counts only to the caller, and do not add serialization or storage helpers.

- [ ] **Step 4: Write failing HTTP-boundary tests**

```ts
it("passes the abort signal and never includes an upstream body in its error", async () => {
  const gateway = createBlizzardClient({
    fetch,
    clientId: "id",
    clientSecret: "secret"
  });
  await expect(
    gateway.getAchievementFingerprint(key, controller.signal)
  ).rejects.toMatchObject({
    kind: "transient",
    retryAfterMs: 60_000
  });
  expect(fetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ signal: controller.signal })
  );
});
```

- [ ] **Step 5: Implement the Blizzard client**

Implement cached-in-process OAuth token acquisition, regional API URL construction, roster normalization to `BlizzardRosterCharacter`, achievement extraction, `Retry-After` parsing, and typed `not_found`, `transient`, and `schema_drift` failures. Keep token and raw payload values local to `client.ts`.

- [ ] **Step 6: Run package tests and static checks**

Run: `pnpm --filter @slashwho/blizzard test && pnpm --filter @slashwho/blizzard typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/blizzard
git commit -m "feat(blizzard): add ephemeral fingerprint client"
```

## Task 2: Build the cap-aware domain sweep

**Files:**

- Create: `packages/domain/src/fingerprint-discovery.ts`
- Create: `packages/domain/src/fingerprint-discovery.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/package.json`

**Interfaces:**

- Consumes: `CharacterKey`, `DiscoveredCharacter`, and `toRaiderIoUrl` from existing domain modules. The caller supplies a domain-owned adapter; the domain package does not import `@slashwho/blizzard`.
- Produces:

```ts
export type FingerprintCandidate = Readonly<{
  key: CharacterKey;
  displayName: string;
  className: string;
  level: number;
}>;

export interface FingerprintGateway {
  getGuildRoster(
    root: CharacterKey,
    signal?: AbortSignal
  ): Promise<readonly FingerprintCandidate[]>;
  getAchievementFingerprint(
    key: CharacterKey,
    signal?: AbortSignal
  ): Promise<ReadonlyMap<number, number>>;
}

export type FingerprintSweepOutcome =
  | {
      kind: "matched";
      characters: readonly DiscoveredCharacter[];
      requestsUsed: number;
    }
  | {
      kind: "capped";
      characters: readonly DiscoveredCharacter[];
      requestsUsed: number;
    }
  | {
      kind: "failure";
      code: "upstream_unavailable" | "upstream_schema_changed";
      retryable: boolean;
      retryAfterMs?: number;
    };

export function discoverFingerprintMatches(
  root: CharacterKey,
  gateway: FingerprintGateway,
  options: {
    requestCap: number;
    minimumCommon: number;
    minimumIdenticalPercent: number;
    isSuppressed(key: CharacterKey): Promise<boolean>;
    isPrivacyHidden(key: CharacterKey): Promise<boolean>;
    signal?: AbortSignal;
  }
): Promise<FingerprintSweepOutcome>;
```

- [ ] **Step 1: Write failing domain tests**

```ts
it("fetches the root once, skips suppressed/privacy-hidden candidates, and stops at its cap", async () => {
  await expect(
    discoverFingerprintMatches(root, gateway, options)
  ).resolves.toMatchObject({
    kind: "capped",
    requestsUsed: 3,
    characters: [expect.objectContaining({ source: "fingerprint" })]
  });
});
```

- [ ] **Step 2: Run the domain test to verify it fails**

Run: `pnpm --filter @slashwho/domain test -- fingerprint-discovery.test.ts`

Expected: FAIL because the domain sweep is not exported.

- [ ] **Step 3: Implement the in-memory sweep**

Count every roster and achievement request against `requestCap`; request the root fingerprint once; evaluate roster candidates deterministically; check suppression/privacy before retaining a result; convert accepted matches to ordinary `DiscoveredCharacter` rows with source `fingerprint`; discard each candidate fingerprint after comparison. Return `capped` only after a measured cap stop.

- [ ] **Step 4: Add failure and abort tests**

```ts
it("returns a retryable failure for a 429 and throws the abort reason without a partial result", async () => {
  gateway.getAchievementFingerprint = async () => {
    throw rateLimited;
  };
  await expect(
    discoverFingerprintMatches(root, gateway, options)
  ).resolves.toMatchObject({ kind: "failure", retryable: true });
  await expect(
    discoverFingerprintMatches(root, gateway, {
      ...options,
      signal: aborted.signal
    })
  ).rejects.toBe(aborted.signal.reason);
});
```

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm --filter @slashwho/domain test -- fingerprint-discovery.test.ts`

Expected: PASS.

```bash
git add packages/domain
git commit -m "feat(domain): add cap-aware fingerprint sweep"
```

## Task 3: Add durable sweep state and rolling budget admission

**Files:**

- Modify: `packages/database/src/schema.ts`
- Create: `packages/database/drizzle/0002_fingerprint_sweeps.sql`
- Create: `packages/database/drizzle/meta/0002_snapshot.json`
- Modify: `packages/database/drizzle/meta/_journal.json`
- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Modify: `packages/database/src/postgres-repositories.test.ts`
- Modify: `packages/database/src/public-api.typecheck.ts`

**Interfaces:**

- Consumes: canonical root keys and discovery-run IDs.
- Produces:

```ts
export type FingerprintAdmission =
  | { kind: "not_due" }
  | { kind: "waiting"; retryAt: Date }
  | { kind: "admitted"; reservationId: string; requestCap: number };

export interface FingerprintSweepRepository {
  requestAdmission(input: {
    runId: string;
    key: CharacterKey;
    requestCap: number;
    hourlyBudget: number;
    cadenceCutoff: Date;
    at: Date;
  }): Promise<FingerprintAdmission>;
  recordRequest(reservationId: string, count: number, at: Date): Promise<void>;
  finish(
    reservationId: string,
    input: { published: boolean; at: Date; limitationCode: string | null }
  ): Promise<void>;
  release(reservationId: string, at: Date): Promise<void>;
  listWaiting(limit: number): Promise<readonly string[]>;
}
```

- [ ] **Step 1: Write failing PostgreSQL integration tests**

```ts
it("admits only the FIFO head when two caps would exceed the rolling budget", async () => {
  await repository.requestAdmission(first);
  await expect(repository.requestAdmission(second)).resolves.toMatchObject({
    kind: "waiting"
  });
  await repository.finish(firstReservation, {
    published: true,
    at,
    limitationCode: null
  });
  await expect(repository.requestAdmission(second)).resolves.toMatchObject({
    kind: "admitted"
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `pnpm test:integration -- postgres-repositories.test.ts`

Expected: FAIL because no fingerprint tables or repository exist.

- [ ] **Step 3: Add the migration and schema types**

Create internal tables for per-root sweep state, FIFO admission rows, and reservation accounting. Add `fingerprint` to `discovery_source`. A reservation records cap, used count, admitted time, expiry time, and terminal release/completion metadata; it stores no upstream or matching data.

- [ ] **Step 4: Implement transactional repository methods**

Under one global PostgreSQL advisory lock, select the oldest waiting eligible row, calculate active commitment as used plus unreleased reservation capacity, and admit only when the full cap fits. On finish/release, retain used count until the reservation's one-hour expiry, release unused count immediately, and set the seven-day timestamp only when the snapshot was published.

- [ ] **Step 5: Add atomicity and cadence tests**

```ts
it("does not advance cadence or retain unused capacity after an aborted sweep", async () => {
  const admitted = await repository.requestAdmission(input);
  await repository.recordRequest(admitted.reservationId, 3, at);
  await repository.release(admitted.reservationId, at);
  await expect(
    repository.requestAdmission({ ...input, at: plusOneMinute })
  ).resolves.toMatchObject({ kind: "admitted" });
});
```

- [ ] **Step 6: Run migration and integration verification**

Run: `pnpm test:integration -- postgres-repositories.test.ts && pnpm --filter @slashwho/database typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/database
git commit -m "feat(database): reserve fingerprint sweep budget"
```

## Task 4: Add private FIFO admission dispatch

**Files:**

- Modify: `packages/database/src/queue.ts`
- Modify: `packages/database/src/queue.test.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`

**Interfaces:**

- Consumes: waiting discovery-run IDs from `FingerprintSweepRepository`.
- Produces:

```ts
export const fingerprintAdmissionQueueName = "fingerprint-admission";

export interface DiscoveryQueue {
  // Existing members remain unchanged.
  enqueueFingerprintAdmission(runId: string): Promise<string>;
  workFingerprintAdmissions(
    handler: (runId: string) => Promise<void>
  ): Promise<void>;
}
```

- [ ] **Step 1: Write failing queue/runtime tests**

```ts
it("registers the private admission worker and re-enqueues only admitted discovery runs", async () => {
  await admissionHandler(waitingRunId);
  expect(fakes.enqueued).toEqual([{ runId: waitingRunId, key }]);
  expect(fakes.handler.execute).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `pnpm --filter @slashwho/database test -- queue.test.ts && pnpm --filter @slashwho/worker test -- runtime.test.ts`

Expected: FAIL because the private queue is not registered.

- [ ] **Step 3: Implement the private pg-boss queue**

Create and start `fingerprint-admission` with a singleton key per run. Its handler asks the repository to admit FIFO work, then enqueues an admitted run back onto `discover-character`. Waiting runs remain durable in the admission table/queue and do not consume a discovery worker execution or delivery retry.

- [ ] **Step 4: Wire shutdown and recovery**

Make runtime startup recover waiting admission rows before readiness, and make `stop()` cease new admission work before its existing graceful drain. Do not add a public queue or API route.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm --filter @slashwho/database test -- queue.test.ts && pnpm --filter @slashwho/worker test -- runtime.test.ts`

Expected: PASS.

```bash
git add packages/database apps/worker
git commit -m "feat(worker): dispatch fingerprint admissions"
```

## Task 5: Orchestrate merged snapshots in the discovery handler

**Files:**

- Modify: `packages/application/src/discovery-job-handler.ts`
- Modify: `packages/application/src/discovery-job-handler.test.ts`
- Modify: `packages/application/src/index.ts`
- Modify: `apps/worker/src/runtime.ts`

**Interfaces:**

- Consumes: existing `discoverCharacter`, `discoverFingerprintMatches`, `FingerprintSweepRepository`, `BlizzardGateway`, and `DiscoveryWorkContext`. `packages/application/src/blizzard-fingerprint-adapter.ts` adapts `BlizzardGateway` to the domain-owned `FingerprintGateway`; it does not duplicate matching or upstream logic.
- Produces an extended handler option:

```ts
export type DiscoveryJobHandlerOptions = {
  repositories: Repositories;
  gateway: RaiderIoGateway;
  blizzardGateway: BlizzardGateway;
  fingerprint: {
    requestCap: number;
    hourlyBudget: number;
    cadenceMs: number;
    minimumCommon: number;
    minimumIdenticalPercent: number;
  };
  // Existing retry, clock, logger, and cache options remain.
};
```

- [ ] **Step 1: Write failing handler tests for deferred admission**

```ts
it("defers an eligible run to private FIFO admission without consuming a delivery retry", async () => {
  repositories.fingerprintSweeps.requestAdmission = async () => ({
    kind: "waiting",
    retryAt
  });
  await handler.execute(run.id, delivery());
  expect(repositories.runs.find(run.id)).resolves.toMatchObject({
    status: "queued"
  });
  expect(gateway.getCharacter).toHaveBeenCalled();
  expect(blizzardGateway.getGuildRoster).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the handler test to verify it fails**

Run: `pnpm --filter @slashwho/application test -- discovery-job-handler.test.ts`

Expected: FAIL because the handler has no fingerprint admission branch.

- [ ] **Step 3: Implement admission, sweeping, and merge**

Run existing Raider.IO discovery first. If the normal result cannot produce a trustworthy snapshot, preserve its existing behaviour and never start a fingerprint sweep. For a trustworthy result, request admission. On `waiting`, persist only the internal admission state and return without snapshot publication. On `admitted`, invoke the domain sweep, record each consumed Blizzard request, merge deduplicated fingerprint observations with Raider.IO observations, then call the existing atomic snapshot repository once.

- [ ] **Step 4: Write failing failure/partial/abort tests**

```ts
it("publishes only a cap-bounded partial result and releases an aborted reservation", async () => {
  fingerprintSweep.mockResolvedValue({
    kind: "capped",
    characters: [match],
    requestsUsed: 300
  });
  await handler.execute(run.id, delivery());
  expect(snapshot.limitationCode).toBe("fingerprint_sweep_capped");

  controller.abort(abortReason);
  await expect(
    handler.execute(nextRun.id, { ...delivery(), signal: controller.signal })
  ).rejects.toBe(abortReason);
  expect(repositories.fingerprintSweeps.release).toHaveBeenCalled();
});
```

- [ ] **Step 5: Extend allowlisted logs without sensitive data**

Add only queue wait, reservation/use counts, duration, and final limitation class. Extend `apps/worker/src/logger.test.ts` with achievement IDs, timestamps, tokens, and scores as redaction markers, and prove none reaches output.

- [ ] **Step 6: Run focused tests and commit**

Run: `pnpm --filter @slashwho/application test -- discovery-job-handler.test.ts && pnpm --filter @slashwho/worker test -- logger.test.ts`

Expected: PASS.

```bash
git add packages/application apps/worker
git commit -m "feat(application): merge fingerprint discovery snapshots"
```

## Task 6: Validate worker configuration and public non-disclosure

**Files:**

- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/config.test.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `packages/application/src/serializers.test.ts`
- Modify: `apps/web/src/app/privacy/page.tsx` (or create it if absent)
- Modify: privacy-page test colocated with the route/component

**Interfaces:**

- Consumes: worker environment values `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `BLIZZARD_SWEEP_REQUEST_CAP`, `BLIZZARD_HOURLY_REQUEST_BUDGET`, `FINGERPRINT_MINIMUM_COMMON`, `FINGERPRINT_MINIMUM_IDENTICAL_PERCENT`, and `FINGERPRINT_SWEEP_CADENCE_HOURS`.
- Produces a `WorkerConfig` whose fingerprint fields are positive validated numbers and whose cadence defaults to 168 hours.

- [ ] **Step 1: Write failing configuration and serializer tests**

```ts
it("rejects missing Blizzard credentials and invalid sweep bounds", () => {
  expect(() => loadWorkerConfig({ DATABASE_URL: url })).toThrow(
    "blizzard_client_id_required"
  );
  expect(() =>
    loadWorkerConfig({ ...env, BLIZZARD_SWEEP_REQUEST_CAP: "0" })
  ).toThrow("invalid_blizzard_sweep_request_cap");
});

it("never exposes fingerprint source, score, queue, or reservation fields", () => {
  expect(serializeCharacterResource(snapshot)).not.toHaveProperty(
    "discoverySource"
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @slashwho/worker test -- config.test.ts && pnpm --filter @slashwho/application test -- serializers.test.ts`

Expected: FAIL because the fingerprint configuration and privacy wording are absent.

- [ ] **Step 3: Implement validated configuration and runtime construction**

Load credentials only in worker configuration; pass them directly to `createBlizzardClient`; do not expose them to web configuration. Register defaults of 28,800/hour, 20%, 200 common achievements, and 168 hours. Keep all public schemas and serializers unchanged except for tests proving no internal field leaks.

- [ ] **Step 4: Document the privacy boundary**

Add concise `/privacy` copy stating that privacy-hidden Raider.IO ownership is excluded from fingerprint-derived links and that public lists do not disclose discovery method. Do not add a public opt-out flow.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm --filter @slashwho/worker test -- config.test.ts && pnpm --filter @slashwho/application test -- serializers.test.ts && pnpm --filter @slashwho/web test -- privacy`

Expected: PASS.

```bash
git add apps/worker packages/application packages/contracts apps/web
git commit -m "feat(worker): configure private Blizzard sweeps"
```

## Task 7: Run end-to-end verification and staging smoke test

**Files:**

- Modify: deployment/environment documentation if Railway variable setup is not already recorded.
- Modify: `README.md` only if it names discovery sources or privacy behaviour contradicted by this feature.

**Interfaces:**

- Consumes: all prior tasks and operator-managed Railway worker secrets.
- Produces: a verified branch and a manually recorded staging smoke-test result without secret or raw upstream data.

- [ ] **Step 1: Run the complete local gate**

Run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits 0. If Docker is unavailable, start Docker Desktop hidden, verify `docker version`, then rerun the integration suite; do not alter tests to skip it.

- [ ] **Step 2: Review public-contract and retention evidence**

Run:

```bash
rg -n "fingerprint|achievement|blizzard" apps/web packages/contracts packages/application/src/serializers.ts
git diff main...HEAD --check
```

Expected: only the approved `/privacy` wording and internal implementation references appear; contracts and serializers contain no score, source, queue, credential, ID, timestamp, or raw-payload field.

- [ ] **Step 3: Stage and run the bounded staging smoke test**

Deploy to Railway `test` with only the already-provisioned worker credentials. Submit one known eligible public root, confirm the worker reserves its cap, completes within it, and the public page/API shows a normal undifferentiated list. Record only root key, run outcome, request count, duration, snapshot state, and limitation class.

- [ ] **Step 4: Commit documentation evidence and open the feature PR**

```bash
git add README.md docs apps packages
git commit -m "docs: record fingerprint sweep validation"
git push -u origin feat/achievement-fingerprint-discovery
gh pr create --base main --title "feat: add achievement fingerprint discovery"
```

## Plan self-review

- Spec coverage: Tasks 1–2 implement ephemeral Blizzard matching and the threshold; Tasks 3–4 implement seven-day eligibility, FIFO admission, and rolling budget; Task 5 implements merged atomic snapshots, cap handling, retries, and shutdown release; Task 6 implements config, privacy copy, and public non-disclosure; Task 7 verifies all acceptance criteria in CI and staging.
- Placeholder scan: no deferred implementation steps, unnamed types, or generic testing directions remain; every task names its files, interfaces, commands, and expected result.
- Type consistency: `BlizzardGateway`, `FingerprintSweepOutcome`, `FingerprintSweepRepository`, `FingerprintAdmission`, and the extended `DiscoveryJobHandlerOptions` are introduced before later tasks consume them.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-10-achievement-fingerprint-discovery-implementation.md`.

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task and review between tasks.
2. **Inline Execution** — execute the tasks in this session with checkpoints.
