# Staged Applicant Dossier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show root-character evidence promptly while linked-character discovery continues, then replace it with an explicitly complete or partial dossier.

**Architecture:** Preserve the current discovery-run and relationship-snapshot pipeline. Add a root-only, transient dossier read; add explicit research state to the dossier contract; make the browser show root evidence while polling and replace it only when snapshot-backed evidence is ready.

**Tech Stack:** TypeScript, Zod, Next.js, React, Vitest, Playwright, PostgreSQL/pg-boss, Railway.

**Spec:** `docs/superpowers/specs/2026-09-12-staged-applicant-dossier-design.md`

## Global Constraints

- Never persist a dossier, Warcraft Logs evidence, or raw provider payload.
- `initial` cannot make an exhaustive or negative linked-character claim.
- `partial` must say that additional linked characters may exist.
- Preserve discovery/snapshot atomicity and fingerprint-admission behaviour.
- Initial Warcraft Logs requests use server-only bounded cap and timeout values.
- Existing anonymous rate limits and secret boundaries apply unchanged.

---

### Task 1: Contract and initial-read configuration

**Files:**

- Modify: `packages/contracts/src/dossier.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/contracts.test.ts`
- Modify: `packages/application/src/config.ts`, `packages/application/src/config.test.ts`
- Modify: `.env.example`, `docs/deployment/railway.md`

**Interfaces:** Produce `DossierResearch = { state: "initial" | "complete" | "partial"; message: string }`; require `ApplicantDossier.research`; add `DOSSIER_INITIAL_WARCRAFT_LOGS_REQUEST_CAP` (default 20, 1–200) and `DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS` (default 8,000, 1,000–60,000).

- [ ] **Step 1: Write failing tests**

```ts
expect(
  applicantDossierSchema.parse({
    root: { region: "eu", realm: "silvermoon", name: "ryii" },
    characters: [],
    raids: [],
    limitations: [],
    research: {
      state: "initial",
      message: "Linked-character research is still running."
    }
  }).research.state
).toBe("initial");
```

Assert that omission of `research` fails. Assert config defaults `20`/`8_000` and rejects `0`/`60_001`.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @slashwho/contracts test -- contracts.test.ts` and `corepack pnpm --filter @slashwho/application test -- config.test.ts`.

Expected: missing contract field/config properties fail.

- [ ] **Step 3: Implement minimal schemas/config**

```ts
export const dossierResearchSchema = z
  .object({
    state: z.enum(["initial", "complete", "partial"]),
    message: z.string().min(1)
  })
  .strict();
```

Require it in `applicantDossierSchema`, export it, add the bounded config values, and document them as web-service-only Railway variables.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm typecheck && corepack pnpm format:check`.

```bash
git add packages/contracts packages/application/src/config.ts packages/application/src/config.test.ts .env.example docs/deployment/railway.md
git commit -m "feat: define staged dossier research state"
```

### Task 2: Root-only and snapshot-backed dossier service reads

**Files:**

- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-dossier-service.test.ts`

**Interfaces:** Add `readInitial(key, signal?): Promise<ReadDossierResult>`. Make snapshot-backed `read` serialize `complete` for complete snapshots and `partial` for partial snapshots.

- [ ] **Step 1: Write failing service tests**

Assert `readInitial(root)` makes exactly one Warcraft Logs call with `{ requestCap: 20 }`, returns only root evidence and `research.state === "initial"`, and never calls snapshot repositories or writes. Assert a `fingerprint_sweep_capped` partial snapshot returns:

```ts
research: {
  state: "partial",
  message: "Additional linked characters may exist; this dossier is not exhaustive."
}
```

Keep the complete snapshot test and assert `research.state === "complete"`.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts`.

Expected: `readInitial` and research state are absent.

- [ ] **Step 3: Implement common assembly**

Extract a private helper that accepts normalized dossier subjects, gathers evidence through existing `gatherCharacterEvidence`, and builds the validated contract. `readInitial` creates one subject from the canonical key (`source: "input"`), uses `AbortSignal.timeout(config.DOSSIER_INITIAL_WARCRAFT_LOGS_TIMEOUT_MS)` and only the initial cap. `read` retains its shared cap and uses:

```ts
snapshot.state === "complete"
  ? { state: "complete", message: "Linked-character research is complete." }
  : {
      state: "partial",
      message:
        "Additional linked characters may exist; this dossier is not exhaustive."
    };
```

Initial uses: `Linked-character research is still running; this evidence covers only the submitted character.`

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts` and `corepack pnpm test:unit`.

```bash
git add packages/application/src/applicant-dossier-service.ts packages/application/src/applicant-dossier-service.test.ts
git commit -m "feat: stage applicant dossier evidence"
```

### Task 3: Dossier route and polling UI

**Files:**

- Modify: `apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts`
- Modify: `apps/web/src/app/api/dossiers/api-contract.test.ts`
- Modify: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx`
- Create: `apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.test.tsx`
- Create or modify: `apps/web/src/components/dossier-research-state.tsx`

**Interfaces:** `GET ?scope=initial` invokes `readInitial`; the default invokes `read`. The client displays initial evidence while the existing job polls, retains it after job failure, and replaces it after completion.

- [ ] **Step 1: Write failing route/client tests**

Request `GET /api/dossiers/eu/silvermoon/ryii?scope=initial` and assert only `readInitial` runs after authorization. In the client, mock initial evidence plus queued status; assert initial raid evidence and its disclosure render before a complete job response, then assert expanded evidence replaces it. Assert a failed job leaves initial evidence visible.

- [ ] **Step 2: Verify RED**

Run: `corepack pnpm --filter @slashwho/web test -- api-contract.test.ts dossier-page-client.test.tsx`.

Expected: current route always invokes `read`, and current client stops polling whenever any dossier exists.

- [ ] **Step 3: Implement route and UI**

Accept exactly `scope=initial`; authorize public read before calling either service method. Start initial fetch and job polling independently. Do not return early from the polling effect because initial evidence exists. On `complete`, fetch default dossier and replace it; on failure, set research error without clearing dossier. Render `dossier.research.message` above evidence in an `aria-live="polite"` element; it is not a source limitation.

- [ ] **Step 4: Verify and commit**

Run: `corepack pnpm --filter @slashwho/web test -- api-contract.test.ts dossier-page-client.test.tsx`, `corepack pnpm lint`, and `corepack pnpm typecheck`.

```bash
git add apps/web/src/app/api/dossiers apps/web/src/app/dossiers apps/web/src/components/dossier-research-state.tsx
git commit -m "feat: render staged applicant dossiers"
```

### Task 4: Browser coverage and Railway validation

**Files:**

- Modify: `tests/e2e/search.spec.ts`
- Modify: `tests/e2e/support/fake-raiderio.ts` only if held discovery needs deterministic root evidence
- Modify: `docs/deployment/railway.md`

**Interfaces:** Held discovery visibly renders initial root evidence before release; a released complete job renders the complete disclosure; partial snapshots render the non-exhaustive disclosure.

- [ ] **Step 1: Write failing E2E assertions**

Before releasing the held fixture, assert:

```ts
await expect(
  page.getByText(
    "Linked-character research is still running; this evidence covers only the submitted character."
  )
).toBeVisible();
await expect(
  page.getByRole("group", { name: "Queen Ansurek evidence" })
).toBeVisible();
```

After release, assert `Linked-character research is complete.`. Add a deterministic partial snapshot case asserting `Additional linked characters may exist; this dossier is not exhaustive.`

- [ ] **Step 2: Verify RED, complete tests, and commit**

Run: `corepack pnpm test:e2e -- search.spec.ts`; expect held discovery to lack evidence before release. Finish fixture support, then run:

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
corepack pnpm build
```

Deploy Railway `test`, submit a cold URL, and verify prompt initial evidence plus truthful partial disclosure when capped.

```bash
git add tests/e2e/search.spec.ts tests/e2e/support/fake-raiderio.ts docs/deployment/railway.md
git commit -m "test: cover staged dossier research"
```

## Plan self-review

- Tasks 1–4 cover every spec requirement: state contract, transient initial evidence, existing durable snapshot ownership, timeout/cap safety, polling/failure/refresh behaviour, full test coverage, and Railway validation.
- `DossierResearch`, `readInitial`, and `scope=initial` are consistently named across contract, service, route, client, and tests.
- No planned task persists dossier material or silently turns a partial result into complete evidence.
