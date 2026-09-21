# Live Collection Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh active dossier evidence and operator collection-monitor views after complete or partial publication without a browser reload.

**Architecture:** A reusable React hook owns bounded scheduling, aborting, response ordering, visibility pause/resume, and retry classification while callers retain authoritative endpoint parsing and state application. The monitor response gains a server-derived `hasActiveRuns` flag; the dossier derives liveness from character `evidenceState` values. Both clients continue to fetch their existing no-store endpoints.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod contracts, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-21-live-collection-updates-design.md`

## Global Constraints

- Use bounded polling only; do not add SSE, a worker-to-web event broker, or a page reload loop.
- Keep dossier and monitor requests/responses `Cache-Control: no-store` and reuse their existing authorization paths.
- Do not send raw provider payloads, credential material, or an operator secret to the browser.
- Dossier liveness is any relevant character `evidenceState` of `waiting`, `scanning`, or `partial`; do not use deprecated `researchState`.
- The polling hook owns request abortion and response freshness; no stale response may overwrite a newer or terminal snapshot.
- Treat 401, 403, and 404 as terminal/non-retryable; honor a valid 429 `Retry-After` value.
- Announce only meaningful complete/partial or monitor-terminal transitions through a polite live region.

---

### Task 1: Build the authoritative polling hook

**Files:**

- Create: `apps/web/src/lib/use-authoritative-poll.ts`
- Create: `apps/web/src/lib/use-authoritative-poll.test.tsx`

**Interfaces:**

- Produces `useAuthoritativePoll<T>(options: AuthoritativePollOptions<T>): void`.
- `AuthoritativePollOptions<T>` has `active: boolean`, `read(signal): Promise<PollReadResult<T>>`, `onSnapshot(snapshot): void`, and `onTerminalError(response): void`.
- `PollReadResult<T>` is `{ kind: "snapshot"; value: T } | { kind: "retry"; retryAfterMs?: number } | { kind: "terminal"; response: Response }`.
- Later tasks provide contract-validated snapshot readers and page-specific terminal-error handlers.

- [ ] **Step 1: Write failing hook tests for lifecycle and concurrency**

```tsx
it("does not read an initially terminal resource", () => {
  renderHook(() =>
    useAuthoritativePoll({ active: false, read, onSnapshot, onTerminalError })
  );
  expect(read).not.toHaveBeenCalled();
});

it("keeps one in-flight read and ignores an older response after a newer snapshot", async () => {
  const older = deferred<PollReadResult<string>>();
  read
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({ kind: "snapshot", value: "complete" });
  // Trigger the replacement generation, resolve it, then resolve `older` as partial.
  expect(onSnapshot).toHaveBeenLastCalledWith("complete");
});
```

- [ ] **Step 2: Run the hook tests to verify they fail**

Run: `corepack pnpm vitest run --project unit apps/web/src/lib/use-authoritative-poll.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement bounded scheduling and freshness ownership**

```ts
const pollDelaysMs = [1_000, 2_000, 4_000, 8_000, 10_000] as const;
// Keep a generation counter, one AbortController, and one timeout ref.
// Increment the generation before every read and before cleanup; apply a
// snapshot only when its generation is current and the component is mounted.
// Clear and abort both resources during cleanup.
```

- [ ] **Step 4: Extend the failing tests for retry classification and visibility**

```tsx
it("uses Retry-After for a 429 before the next request", async () => {
  read.mockResolvedValueOnce({ kind: "retry", retryAfterMs: 15_000 });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
});

it("pauses while hidden and refreshes once when visible", async () => {
  Object.defineProperty(document, "visibilityState", {
    value: "hidden",
    configurable: true
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(read).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true
  });
  document.dispatchEvent(new Event("visibilitychange"));
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([401, 403, 404])("reports %i once as terminal", async (status) => {
  read.mockResolvedValueOnce({
    kind: "terminal",
    response: new Response(null, { status })
  });
  expect(onTerminalError).toHaveBeenCalledWith(
    expect.objectContaining({ status })
  );
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 5: Implement retry, terminal, and visibility behavior**

```ts
function retryDelay(response: Response): number | undefined {
  if (response.status !== 429) return undefined;
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}
// 401/403/404 call onTerminalError and stop. Network/5xx become retry reads.
// Add one visibilitychange listener; on visible, invalidate the old generation
// and read immediately if active.
```

- [ ] **Step 6: Run the focused hook suite**

Run: `corepack pnpm vitest run --project unit apps/web/src/lib/use-authoritative-poll.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the hook**

```bash
git add apps/web/src/lib/use-authoritative-poll.ts apps/web/src/lib/use-authoritative-poll.test.tsx
git commit -m "feat: add authoritative polling hook"
```

### Task 2: Make monitor liveness server-owned

**Files:**

- Modify: `packages/contracts/src/collection-monitor.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `apps/web/src/server/collection-monitor.ts`
- Modify: `apps/web/src/server/collection-monitor.test.ts`
- Modify: `apps/web/src/app/api/operations/collection-monitor/route.test.ts`

**Interfaces:**

- Adds required `hasActiveRuns: boolean` to `CollectionMonitorResponse`.
- `createCollectionMonitorService().list()` calculates it from the same evidence-run lifecycle branch that fills `inFlight`.
- The existing monitor route serializes the enriched validated response unchanged.

- [ ] **Step 1: Write failing contract and service tests**

```ts
expect(
  collectionMonitorResponseSchema.parse({ ...monitor, hasActiveRuns: true })
).toMatchObject({ hasActiveRuns: true });
expect(service.list()).resolves.toMatchObject({ hasActiveRuns: false });
// Use a queued, running, and retrying fixture to assert true; complete,
// partial, and failed-only fixtures assert false.
```

- [ ] **Step 2: Run the focused contract and service tests to verify failure**

Run: `corepack pnpm vitest run --project unit packages/contracts/src/contracts.test.ts apps/web/src/server/collection-monitor.test.ts`

Expected: FAIL because `hasActiveRuns` is absent.

- [ ] **Step 3: Add the contract field and calculate it in the service**

```ts
const hasActiveRuns = rows.some(
  (row) =>
    row.status === "queued" ||
    row.status === "running" ||
    row.status === "retrying"
);
const response: CollectionMonitorResponse = {
  generatedAt,
  hasActiveRuns,
  inFlight: [],
  completed: [],
  failed: []
};
```

- [ ] **Step 4: Update route fixtures and add a no-store authenticated response assertion**

```ts
expect(await response.json()).toEqual({ ...monitor, hasActiveRuns: true });
expect(response.headers.get("cache-control")).toBe("no-store");
```

- [ ] **Step 5: Run focused tests**

Run: `corepack pnpm vitest run --project unit packages/contracts/src/contracts.test.ts apps/web/src/server/collection-monitor.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit server-owned liveness**

```bash
git add packages/contracts/src/collection-monitor.ts packages/contracts/src/contracts.test.ts apps/web/src/server/collection-monitor.ts apps/web/src/server/collection-monitor.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts
git commit -m "feat: expose collection monitor liveness"
```

### Task 3: Convert the collection monitor to a live client view

**Files:**

- Create: `apps/web/src/app/operations/collection-monitor/collection-monitor-client.tsx`
- Create: `apps/web/src/app/operations/collection-monitor/collection-monitor-client.test.tsx`
- Modify: `apps/web/src/app/operations/collection-monitor/page.tsx`
- Modify: `apps/web/src/app/operations/collection-monitor/page.test.tsx`

**Interfaces:**

- `CollectionMonitorClient({ initialMonitor }: { initialMonitor: CollectionMonitorResponse })` owns monitor state and invokes `useAuthoritativePoll` with `active: monitor.hasActiveRuns`.
- The server page still authorizes before reading and passes the initial monitor snapshot into the client component.

- [ ] **Step 1: Write failing client tests for complete and partial publications**

```tsx
it("moves the matching in-flight run into completed after a complete publication", async () => {
  mockFetchMonitor(inFlightMonitor, completeMonitor);
  render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(screen.getByText("complete")).toBeVisible();
  expect(screen.getByText("Unrelated character")).toBeVisible();
});

it("shows a partial run's limitation and keeps polling through its continuation", async () => {
  mockFetchMonitor(partialMonitor, completeMonitor);
  render(<CollectionMonitorClient initialMonitor={inFlightMonitor} />);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(screen.getByText("request_cap")).toBeVisible();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(screen.getByText("complete")).toBeVisible();
});
```

- [ ] **Step 2: Run the monitor-client test to verify failure**

Run: `corepack pnpm vitest run --project unit apps/web/src/app/operations/collection-monitor/collection-monitor-client.test.tsx`

Expected: FAIL because the client component does not exist.

- [ ] **Step 3: Move presentational tables and add authoritative monitor reading**

```tsx
const [monitor, setMonitor] = useState(initialMonitor);
useAuthoritativePoll({
  active: monitor.hasActiveRuns,
  async read(signal) {
    const response = await fetch("/api/operations/collection-monitor", {
      cache: "no-store",
      signal
    });
    return parseMonitorPollResponse(response);
  },
  onSnapshot: setMonitor,
  onTerminalError: setMonitorError
});
```

- [ ] **Step 4: Add restrained monitor announcements and terminal/error tests**

```tsx
<p className="visually-hidden" aria-live="polite" role="status">
  {announcement}
</p>
// Derive announcement from the previous and next monitor snapshots only when
// a matching row becomes complete, partial, or failed. Assert identical
// snapshots and generatedAt-only changes produce no announcement.
```

- [ ] **Step 5: Keep the server authorization boundary intact**

```tsx
return (
  <CollectionMonitorClient initialMonitor={await collectionMonitor.list()} />
);
```

Update page tests to verify unauthenticated requests still redirect before
`list()`, while authenticated server rendering supplies `hasActiveRuns`.

- [ ] **Step 6: Run focused monitor tests**

Run: `corepack pnpm vitest run --project unit apps/web/src/app/operations/collection-monitor/collection-monitor-client.test.tsx apps/web/src/app/operations/collection-monitor/page.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the live monitor**

```bash
git add apps/web/src/app/operations/collection-monitor
git commit -m "feat: refresh active collection monitor"
```

### Task 4: Refactor dossier evidence refresh onto the shared hook

**Files:**

- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

**Interfaces:**

- `hasLiveEvidence(dossier: ApplicantDossier | null): boolean` returns true when a non-excluded dossier character has `evidenceState` `waiting`, `scanning`, or `partial`.
- Dossier reading continues to validate with `applicantDossierSchema` and supplies `credentialHeaders(readStoredCredentials())`.

- [ ] **Step 1: Write failing dossier behavior tests**

```tsx
it("does not poll an initially terminal evidence snapshot", () => {
  render(
    <DossierPageClient
      identity={identity}
      initialDossier={expanded}
      jobId={null}
    />
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("updates partial evidence to complete without using research.state", async () => {
  const partial = withEvidenceState(initial, "partial", "complete");
  const complete = withEvidenceState(expanded, "complete", "complete");
  fetch.mockResolvedValueOnce(Response.json(complete));
  render(
    <DossierPageClient
      identity={identity}
      initialDossier={partial}
      jobId={null}
    />
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(screen.getByText("Expanded evidence")).toBeVisible();
});

it("does not let an older dossier response replace a newer terminal response", async () => {
  const older = deferred<Response>();
  fetch
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce(Response.json(expanded));
  // Trigger the newer generation, resolve it, then resolve the older request.
  older.resolve(Response.json(partiallyExpanded));
  expect(screen.getByText("Expanded evidence")).toBeVisible();
});
```

- [ ] **Step 2: Run the selected dossier tests to verify failure**

Run: `corepack pnpm vitest run --project unit apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx -t "terminal evidence|partial evidence|older dossier"`

Expected: FAIL because the page still derives polling from `research.state`.

- [ ] **Step 3: Replace only the evidence polling effect with the shared hook**

```tsx
const hasLiveEvidence = (value: ApplicantDossier | null) =>
  value?.characters.some(
    (character) =>
      !character.excluded &&
      (character.evidenceState === "waiting" ||
        character.evidenceState === "scanning" ||
        character.evidenceState === "partial")
  ) ?? false;

useAuthoritativePoll({
  active: canAddCharacters && hasLiveEvidence(dossier),
  read: readDossierPoll,
  onSnapshot: applyFreshDossier,
  onTerminalError: applyDossierError
});
```

Preserve the distinct discovery-job polling effect. Replace `research.state ===
"gathering"` in evidence-liveness/busy decisions only where the precise
evidence-state requirement applies; leave user-facing research copy unchanged.

- [ ] **Step 4: Add credential, retry, and accessible announcement coverage**

```tsx
it("keeps credential headers on a live dossier read", async () => {
  writeStoredCredentials({
    blizzardClientId: "id",
    blizzardClientSecret: "secret",
    raiderIoAccessKey: "",
    wclClientId: "",
    wclClientSecret: ""
  });
  render(
    <DossierPageClient
      identity={identity}
      initialDossier={withEvidenceState(initial, "scanning", "complete")}
      jobId={null}
    />
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetch).toHaveBeenCalledWith(
    dossierPath,
    expect.objectContaining({
      headers: expect.objectContaining({
        "x-blizzard-client-id": "id",
        "x-blizzard-client-secret": "secret"
      })
    })
  );
});
it("honors Retry-After without clearing visible evidence", async () => {
  fetch.mockResolvedValueOnce(
    new Response(null, { status: 429, headers: { "retry-after": "15" } })
  );
  await vi.advanceTimersByTimeAsync(14_999);
  expect(screen.getByText("Initial evidence")).toBeVisible();
});
it("announces a complete or partial evidence change once", async () => {
  expect(
    await screen.findByRole("status", { name: /evidence collection complete/i })
  ).toBeVisible();
  expect(
    screen.getAllByRole("status", { name: /evidence collection complete/i })
  ).toHaveLength(1);
});
```

- [ ] **Step 5: Run the dossier client suite**

Run: `corepack pnpm vitest run --project unit apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the dossier integration**

```bash
git add apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx
git commit -m "feat: refresh live dossier evidence"
```

### Task 5: Validate the integrated behavior

**Files:**

- Modify only if verification exposes a defect in a file from Tasks 1-4.

**Interfaces:**

- All client code consumes the same `useAuthoritativePoll` lifecycle and the monitor consumes server-provided `hasActiveRuns`.

- [ ] **Step 1: Run formatting, linting, types, and all unit tests**

Run: `corepack pnpm format:check && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test:unit`

Expected: PASS.

- [ ] **Step 2: Run the required full gate**

Run: `corepack pnpm test:integration && corepack pnpm build && corepack pnpm test:e2e`

Expected: PASS; if Docker-dependent integration tests cannot start, report the exact infrastructure failure rather than treating a skipped suite as passing.

- [ ] **Step 3: Merge current trunk and repeat the gate if trunk moved**

```bash
git fetch origin
git merge origin/main
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
```

- [ ] **Step 4: Review before opening the pull request**

Run: `/review` against `origin/main` with low reasoning effort.

Expected: inspect every finding; fix valid findings and rerun the complete gate after any code change.

- [ ] **Step 5: Commit any verification fix and open a held PR**

```bash
git add apps/web/src/lib/use-authoritative-poll.ts apps/web/src/lib/use-authoritative-poll.test.tsx apps/web/src/app/operations/collection-monitor packages/contracts/src/collection-monitor.ts packages/contracts/src/contracts.test.ts apps/web/src/server/collection-monitor.ts apps/web/src/server/collection-monitor.test.ts apps/web/src/app/api/operations/collection-monitor/route.test.ts apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx
git commit -m "fix: address live update review findings"
gh push --set-upstream origin feat/411-refresh-dossier-monitor
gh pr create --base main --title "feat: refresh live collection views" --body "Closes #411\n\nImplements bounded, authoritative polling for active dossier evidence and the operator collection monitor."
```

Do not enable auto-merge or merge the pull request; leave it for manager review.
