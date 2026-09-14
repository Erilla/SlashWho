# Warcraft Logs Fight Parses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact-fight damage, healing, and boss-damage percentiles to Historic Mythic evidence rows and boss summaries, with Warcraft Logs colours and truthful missing states.

**Architecture:** The worker performs a second, report-scoped `Report.rankings` phase after discovering verified kill references. The Warcraft Logs package strictly normalizes opaque ranking JSON into explicit metric states, the existing per-character evidence cache persists those states atomically, the domain selects event-level and boss-level best values, and the web renders accessible linked parse labels.

**Tech Stack:** TypeScript 5.9, Warcraft Logs v2 GraphQL, Drizzle/PostgreSQL, Zod, React/Next.js, Vitest, Testing Library, Playwright, Railway.

**Spec:** `docs/superpowers/specs/2026-09-14-warcraft-logs-fight-parses-design.md`

## Global Constraints

- A parse must match the exact report, fight, encounter, Mythic difficulty, region, realm, and character; name-only matching is forbidden.
- Use `Report.rankings` with `compare: Rankings`, `timeframe: Historical`, and the `dps`, `hps`, and `bossdps` metrics.
- Do not implement a decoder from guessed JSON keys. Capture sanitized, credentialed fixtures first.
- Accept only finite percentiles in `0..100`. A provider-supplied `0` is valid; absence and malformed data are never zero.
- Persist normalized metric states only. Never persist raw provider payloads, OAuth tokens, credentials, or request URLs.
- A parse limitation must not remove or weaken verified kill evidence.
- Event-level best values consider only that event's supporting reports. Boss-level best-shown values consider only displayed events for that boss.
- Every available value retains the exact supporting fight URL.
- Use the seven exact RPGLogs colours from the spec; colour is never the only signal.
- Preserve the assembled dossier's `Cache-Control: no-store` policy.

---

### Task 1: Credentialed Warcraft Logs contract fixture

**Files:**

- Create: `scripts/prototypes/wcl-fight-rankings-contract.mts`
- Create: `tests/fixtures/warcraftlogs/report-rankings-valid.json`
- Create: `tests/fixtures/warcraftlogs/report-rankings-mismatch.json`
- Modify: `docs/research/2026-09-14-warcraft-logs-fight-parses.md`

**Interfaces:**

- Consumes: worker-scoped `WARCRAFT_LOGS_CLIENT_ID` and `WARCRAFT_LOGS_CLIENT_SECRET`, plus CLI arguments `--report-code`, `--fight-id`, `--encounter-id`, and `--difficulty`.
- Produces: sanitized fixtures that preserve structural keys, actor/fight/role/metric relationships, and numeric percentiles while replacing report codes, names, realms, regions, and character IDs with deterministic fixture values.

- [ ] **Step 1: Add a failing argument/redaction test beside the prototype**

Create `scripts/prototypes/wcl-fight-rankings-contract.test.mts` with tests proving missing scope arguments throw and a sample payload is sanitized without retaining the original report code, character name, realm, region, or numeric character ID.

- [ ] **Step 2: Run the prototype test and verify RED**

Run: `corepack pnpm vitest run --project unit scripts/prototypes/wcl-fight-rankings-contract.test.mts`

Expected: FAIL because `parseContractProbeOptions` and `sanitizeRankingsFixture` do not exist.

- [ ] **Step 3: Implement the read-only contract probe**

Export these exact helpers:

```ts
export type RankingsProbeOptions = Readonly<{
  reportCode: string;
  fightId: number;
  encounterId: number;
  difficulty: number;
}>;

export function parseContractProbeOptions(argv: readonly string[]): RankingsProbeOptions;
export function sanitizeRankingsFixture(value: unknown): unknown;
```

The executable path obtains a client-credentials token, samples
`rateLimitData.pointsSpentThisHour`, requests the exact report/fight three ways
(`dps`, `hps`, `bossdps` aliases), samples rate-limit data again, and prints
only the sanitized result plus point delta. It must not print credentials or
the unsanitized response.

- [ ] **Step 4: Run the probe against one public test-environment report**

Obtain an existing public report/fight URL from the test dossier API, then run
the script with Railway's worker environment:

```powershell
railway run --service worker --environment test -- corepack pnpm exec tsx scripts/prototypes/wcl-fight-rankings-contract.mts --report-code $reportCode --fight-id $fightId --encounter-id $encounterId --difficulty 5
```

Do not copy the unsanitized response into the repository. Capture the
sanitized DPS/healer/tank role structure, percentile field, fight identity,
missing-state behaviour, archive status, and measured point delta in the
research note. If the payload does not expose enough identity to distinguish
same-named cross-realm characters, stop implementation and keep #90 blocked
rather than weakening the matching rule.

- [ ] **Step 5: Build deterministic valid and mismatch fixtures**

The valid fixture must contain at least one DPS, healer, and tank from the same
fight, including all three metric aliases and the provider's real nested key
shape. The mismatch fixture changes report/fight/encounter/difficulty and
character identity independently so later tests can prove every rejection
boundary.

- [ ] **Step 6: Verify and commit the contract evidence**

Run:

```powershell
corepack pnpm vitest run --project unit scripts/prototypes/wcl-fight-rankings-contract.test.mts
rg -n "$reportCode|WARCRAFT_LOGS_CLIENT_SECRET|access_token" tests/fixtures/warcraftlogs docs/research/2026-09-14-warcraft-logs-fight-parses.md
```

Expected: tests PASS and the secret/raw-identity scan returns no matches.

Commit: `test: capture Warcraft Logs fight ranking contract`

---

### Task 2: Strict fight-ranking normalization and bounded hydration

**Files:**

- Modify: `packages/warcraftlogs/src/types.ts`
- Modify: `packages/warcraftlogs/src/client.ts`
- Modify: `packages/warcraftlogs/src/client.test.ts`
- Modify: `apps/worker/src/config.ts`
- Modify: `apps/worker/src/config.test.ts`
- Modify: `apps/worker/src/runtime.ts`
- Modify: `apps/worker/src/runtime.test.ts`
- Modify: `.env.example`

**Interfaces:**

- Produces:

```ts
export type WarcraftLogsParseMetric =
  | Readonly<{ state: "available"; percentile: number }>
  | Readonly<{ state: "not_applicable" | "unavailable" }>;

export type WarcraftLogsPerformance = Readonly<{
  damage: WarcraftLogsParseMetric;
  healing: WarcraftLogsParseMetric;
  bossDamage: WarcraftLogsParseMetric;
}>;
```

`WarcraftLogsFirstKillEvidence` gains `reportCode: string`, `fightId: number`,
`difficulty: number`, and `performance: WarcraftLogsPerformance`.

`getFirstKillReports` options become:

```ts
Readonly<{
  requestCap: number;
  parseRequestCap: number;
  signal?: AbortSignal;
}>
```

- [ ] **Step 1: Read `test-driven-development/writing-good-tests.md` completely**

Apply its break-caught comments and real-behaviour assertions to every test changed in this task.

- [ ] **Step 2: Add one failing client test for valid exact-fight normalization**

Feed the sanitized valid fixture through the real client fetch boundary and
expect the exact character's damage, healing, and boss-damage states plus
`reportCode`, `fightId`, and `difficulty` on the returned kill.

- [ ] **Step 3: Run the focused client test and verify RED**

Run: `corepack pnpm vitest run --project unit packages/warcraftlogs/src/client.test.ts -t "normalizes exact-fight performance parses"`

Expected: FAIL because kill evidence has no performance contract.

- [ ] **Step 4: Implement the strict decoder and report-batched query**

Add a pure decoder that follows only Task 1's observed fixture keys. Reject
non-finite/out-of-range values. Query one report at a time, group retained
references by report/encounter/difficulty, pass only their fight IDs, and map
rows back using every identity field established by the probe. Initialize all
metrics as `unavailable`; use `not_applicable` only for the documented
fight-role policy when role identity is independently established.

- [ ] **Step 5: Verify GREEN, then add RED mismatch/zero/missing/cap tests**

Add tests proving each mismatched identity is rejected, numeric zero remains
available, null/string/NaN/out-of-range values are unavailable, a parse cap
retains kills with a parse-specific limitation, and one report with several
fight IDs consumes one ranking request.

- [ ] **Step 6: Implement minimal limitation and budget handling**

Extend `WarcraftLogsLimitationCode` with `parse_private`,
`parse_rate_limited`, `parse_request_cap`, `parse_unavailable`, and
`parse_schema_drift`. Preserve successfully normalized kills and metrics when
later ranking batches fail.

- [ ] **Step 7: Add worker configuration RED/GREEN coverage**

Add positive integer `EVIDENCE_PARSE_REQUEST_CAP` with a measured default from
Task 1. Pass it from worker config through runtime to `getFirstKillReports`.
Update every test gateway call explicitly so request budgets remain visible.

- [ ] **Step 8: Run focused verification and commit**

Run:

```powershell
corepack pnpm vitest run --project unit packages/warcraftlogs/src apps/worker/src/config.test.ts apps/worker/src/runtime.test.ts
corepack pnpm --filter @slashwho/warcraftlogs typecheck
corepack pnpm --filter @slashwho/worker typecheck
```

Commit: `feat: normalize Warcraft Logs fight parses`

---

### Task 3: Persist normalized performance states atomically

**Files:**

- Modify: `packages/database/src/repositories.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/postgres-repositories.ts`
- Modify: `tests/integration/repositories.test.ts`
- Create: `packages/database/drizzle/0006_character_kill_parses.sql`
- Create: `packages/database/drizzle/meta/0006_snapshot.json`
- Modify: `packages/database/drizzle/meta/_journal.json`
- Modify: `packages/application/src/applicant-evidence-job-handler.test.ts`
- Modify: `packages/application/src/applicant-evidence-job-handler.ts`

**Interfaces:**

- Consumes: `WarcraftLogsPerformance` from Task 2.
- Produces: `CharacterMythicKillInput.performance` and `StoredCharacterMythicKill.performance` with the same discriminated metric states.

- [ ] **Step 1: Add a failing integration round-trip test**

Publish one kill containing available `0`, available `99.25`,
`not_applicable`, and `unavailable` states; read it through
`getCompleted`; expect exact structural equality. Publish a replacement run
and prove readers see the old complete run before publication and only the
whole new performance set afterward.

- [ ] **Step 2: Run the focused integration test and verify RED**

Run: `corepack pnpm vitest run --project integration tests/integration/repositories.test.ts -t "round-trips normalized kill parses"`

Expected: FAIL because the repository input has no performance fields.

- [ ] **Step 3: Add state/value columns and database checks**

Add three state columns (`damage_parse_state`, `healing_parse_state`,
`boss_damage_parse_state`) and three nullable double-precision percentile
columns. Each check constraint enforces exactly:

```sql
(state = 'available' AND percentile >= 0 AND percentile <= 100)
OR (state IN ('not_applicable', 'unavailable') AND percentile IS NULL)
```

Use a shared PostgreSQL enum for the three state columns. Existing rows migrate
to `unavailable` with null percentile values.

- [ ] **Step 4: Implement repository mapping and publication**

Validate the discriminated states before SQL execution, insert all six values
inside the existing transaction, and reconstruct the exact union in
`mapCharacterMythicKill`.

- [ ] **Step 5: Extend the evidence job handler test and implementation**

Prove normalized metrics and parse-specific partial limitations pass unchanged
from the gateway to atomic publication. No raw ranking payload is accepted by
the store interface.

- [ ] **Step 6: Verify migration and repository GREEN, then commit**

Run:

```powershell
corepack pnpm vitest run --project integration tests/integration/migrations.test.ts tests/integration/repositories.test.ts
corepack pnpm vitest run --project unit packages/application/src/applicant-evidence-job-handler.test.ts
corepack pnpm --filter @slashwho/database typecheck
```

Commit: `feat: persist normalized fight parses`

---

### Task 4: Aggregate event and boss parse summaries

**Files:**

- Modify: `packages/domain/src/applicant-dossier.ts`
- Modify: `packages/domain/src/applicant-dossier.test.ts`
- Modify: `packages/application/src/applicant-dossier-service.ts`
- Modify: `packages/application/src/applicant-dossier-service.test.ts`
- Modify: `packages/contracts/src/dossier.ts`
- Modify: `packages/contracts/src/contracts.test.ts`

**Interfaces:**

- Produces:

```ts
export type ApplicantDossierParseMetric =
  | Readonly<{
      state: "available";
      percentile: number;
      reportUrl: string;
    }>
  | Readonly<{ state: "not_applicable" | "unavailable" }>;

export type ApplicantDossierCharacterParses = Readonly<{
  character: string;
  damage: ApplicantDossierParseMetric;
  healing: ApplicantDossierParseMetric;
  bossDamage: ApplicantDossierParseMetric;
}>;
```

`ApplicantDossierFirstKill` gains `parses: readonly ApplicantDossierCharacterParses[]`.
`ApplicantDossierBoss` gains `bestParses: readonly ApplicantDossierCharacterParses[]`.

- [ ] **Step 1: Add failing domain tests for event and boss selection**

Build two characters, two displayed kill events, and multiple supporting
reports. Assert each event selects the highest available percentile per
character/metric only from its own reports; `firstKill.parses` comes from the
earliest event; `bestParses` selects across displayed events; every available
value retains the winning fight URL; ties use lexical fight URL ordering.

- [ ] **Step 2: Run the domain tests and verify RED**

Run: `corepack pnpm vitest run --project unit packages/domain/src/applicant-dossier.test.ts -t "aggregates fight parses"`

Expected: FAIL because event and boss parse fields do not exist.

- [ ] **Step 3: Implement pure deterministic aggregation**

Map cached performance onto `DossierKillEvidence`. For each grouped event,
group by canonical character and metric, choose `available` by descending
percentile then ascending fight URL, otherwise prefer `not_applicable` over
`unavailable`. Compute `bestParses` from the event summaries using the same
selector. Preserve dossier character display order.

- [ ] **Step 4: Add failing strict-contract tests**

Assert valid available/not-applicable/unavailable unions parse; percentile
without an available state, available without report URL, extra raw provider
fields, and out-of-range percentiles fail.

- [ ] **Step 5: Implement Zod discriminated unions and limitation copy**

Add the exact types above to `packages/contracts/src/dossier.ts`. Map the five
parse-specific WCL limitation codes to clear reviewer-surface messages without
claiming verified kill history is missing.

- [ ] **Step 6: Run focused verification and commit**

Run:

```powershell
corepack pnpm vitest run --project unit packages/domain/src packages/contracts/src packages/application/src/applicant-dossier-service.test.ts
corepack pnpm --filter @slashwho/domain typecheck
corepack pnpm --filter @slashwho/contracts typecheck
corepack pnpm --filter @slashwho/application typecheck
```

Commit: `feat: aggregate displayed fight parses`

---

### Task 5: Accessible Warcraft Logs parse presentation

**Files:**

- Create: `apps/web/src/components/dossier-parse-list.tsx`
- Create: `apps/web/src/components/dossier-parse-list.test.tsx`
- Create: `apps/web/src/components/parse-colour.ts`
- Create: `apps/web/src/components/parse-colour.test.ts`
- Modify: `apps/web/src/components/dossier-raid-list.tsx`
- Modify: `apps/web/src/components/dossier-raid-list.test.tsx`
- Modify: `apps/web/src/app/globals.css`
- Modify: `tests/e2e/search.spec.ts`

**Interfaces:**

- Consumes: `ApplicantDossierCharacterParses` from Task 4.
- Produces: `parseColour(percentile: number): "grey" | "green" | "blue" | "purple" | "orange" | "pink" | "gold"` and `<DossierParseList label parses />`.

- [ ] **Step 1: Add failing pure colour-boundary tests**

Cover `0`, `24.999`, `25`, `49.999`, `50`, `74.999`, `75`, `94.999`,
`95`, `98.999`, `99`, `99.999`, and `100`. Assert negative, over-100,
NaN, and infinities throw rather than clamp.

- [ ] **Step 2: Run the colour test and verify RED**

Run: `corepack pnpm vitest run --project unit apps/web/src/components/parse-colour.test.ts`

Expected: FAIL because `parseColour` does not exist.

- [ ] **Step 3: Implement the pure mapping and exact CSS variables**

Map the continuous intervals from the spec and declare:

```css
--parse-grey: #666666;
--parse-green: #1eff00;
--parse-blue: #0070ff;
--parse-purple: #a335ee;
--parse-orange: #ff8000;
--parse-pink: #e268a8;
--parse-gold: #e5cc80;
```

- [ ] **Step 4: Add failing component tests**

Expect per-character groups with full accessible labels (`Damage 87th
percentile`, `Healing not applicable`, `Boss damage unavailable`), available
values linked to their exact fight URLs, neutral unavailable states, and the
correct colour class. Expect the collapsed boss card to expose "First kill
parses" and "Best shown parses" before details are opened.

- [ ] **Step 5: Implement the focused parse component and integrate it**

Keep formatting and colour selection inside `DossierParseList`; keep
aggregation out of React. Render concise metric labels and truncate to at most
one decimal place so presentation never rounds across a colour boundary. Add responsive wrapping that
does not create horizontal scrolling at the existing mobile viewport.

- [ ] **Step 6: Add and pass browser regression coverage**

Seed one boss with first/best/event parses, open the dossier at desktop and
mobile widths, and assert the visible labels, source links, details content,
and absence of horizontal overflow.

- [ ] **Step 7: Run focused verification and commit**

Run:

```powershell
corepack pnpm vitest run --project unit apps/web/src/components
corepack pnpm playwright test tests/e2e/search.spec.ts
corepack pnpm --filter @slashwho/web typecheck
```

Commit: `feat: show Warcraft Logs fight parses`

---

### Task 6: Documentation, full verification, PR, and test deployment

**Files:**

- Modify: `CONTEXT.md`
- Modify: `docs/dossier-cache-policy.md`
- Modify: `README.md`
- Modify: `docs/research/2026-09-14-warcraft-logs-fight-parses.md`
- Modify: `docs/superpowers/plans/2026-09-14-warcraft-logs-fight-parses.md`

**Interfaces:**

- Consumes: all prior tasks.
- Produces: reviewer-facing terminology and operational cache/request-budget documentation.

- [ ] **Step 1: Document the shipped semantics**

Add `Fight parse` and `Best shown parse` to `CONTEXT.md`. Document historical
ranking comparison, exact-fight attribution, partial parse limitations,
request caps, evidence-cache freshness, 30-day retention, and `no-store` HTTP
policy. Mark every completed plan checkbox.

- [ ] **Step 2: Run fresh full verification**

Run each command and require exit code 0:

```powershell
corepack pnpm test
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm format:check
corepack pnpm test:e2e
```

- [ ] **Step 3: Request independent code review and resolve findings**

Review from commit `9678581` through branch HEAD against issue #90 and the
approved spec. Fix all Critical and Important findings with a regression test,
then repeat the affected verification.

- [ ] **Step 4: Rebase onto current `origin/main` and re-verify**

Fetch, rebase, and rerun the full commands from Step 2. If issue #93 has
changed kill grouping, preserve its event identity while retaining parse
source URLs and rerun all aggregation tests.

- [ ] **Step 5: Push and create the pull request**

Push `codex/issue-90-warcraft-logs-parses`, create a PR linking `Closes #90`,
and include the query semantics, cache behaviour, screenshots or rendered UI
evidence, and exact verification counts.

- [ ] **Step 6: Wait for required checks and address failures**

Use GitHub checks as evidence. Diagnose any failure before changing code,
push the smallest tested fix, and wait until every required check succeeds.

- [ ] **Step 7: Deploy the PR branch to Railway test**

Deploy both worker and web from the branch using the linked `test`
environment. Wait for both deployments to reach `SUCCESS`. Apply migration
`0006` through the normal web release command; do not run ad-hoc SQL.

- [ ] **Step 8: Verify the deployed test surface**

Request a dossier with public Mythic evidence, wait for background evidence
refresh to settle, and verify:

- HTTP 200 with `Cache-Control: no-store`;
- strict contract validation;
- available parse percentiles link to exact supporting fights;
- first-kill and best-shown summaries agree with expanded evidence;
- missing metrics never appear as numeric zero unless WCL returned zero;
- the worker/web logs contain no credentials or raw ranking payloads; and
- the page renders without horizontal overflow on desktop and mobile.

Comment on #90 with the PR, test deployment, verification evidence, and any
measured WCL limitations. Stop with the PR open and the branch deployed to
test; do not merge without a separate user request.
