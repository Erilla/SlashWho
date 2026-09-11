# Applicant Dossier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Replace SlashWho's public character finder with an unlisted applicant dossier that accepts Raider.IO or Warcraft Logs character URLs and shows historic Cutting Edge boss evidence across linked characters.

**Architecture:** Queue-backed Raider.IO and Blizzard fingerprint discovery remains the durable relationship source. An on-demand application service reads its snapshot and merges normalized Raider.IO first-kill/guild/rank facts with Warcraft Logs report evidence. The dossier is returned to the browser only and never persisted.

**Tech Stack:** TypeScript 5.9, pnpm, Next.js App Router, React, Zod, Vitest, Playwright, PostgreSQL/Drizzle/pg-boss, Raider.IO, Warcraft Logs OAuth/GraphQL.

**Spec:** \`docs/superpowers/specs/2026-09-11-applicant-dossier-design.md\`

## Global Constraints

- Preserve \`region / realm-slug / normalized-name\` as the only character identity.
- Accept only HTTPS URLs on exact Raider.IO or Warcraft Logs hosts; reject credentials, queries, hashes, and unsupported paths.
- Never persist dossiers, historic-kill records, report links, Warcraft Logs data, or raw upstream payloads.
- Show absent, private, capped, rate-limited, malformed, and unavailable data as partial/unknown—not as a negative claim.
- \`historicWorldRank\` is the rank at the first Mythic kill of that boss, never a current tier rank or parse percentile.
- No authentication: Railway is unlisted, not private. Preserve rate limits and secret redaction.
- Do not expose credentials or raw third-party payloads in browser responses or logs.
- Use \`CONTEXT.md\` terminology: reviewer surface, applicant dossier, fingerprint-derived link, and source label.

---

## File Structure

| File | Responsibility |
| --- | --- |
| \`packages/domain/src/character-key.ts\` | Parse both URL forms into \`CharacterKey\`. |
| \`packages/domain/src/applicant-dossier.ts\` | Pure evidence types and deterministic aggregation. |
| \`packages/contracts/src/dossier.ts\` | Strict dossier HTTP schemas. |
| \`packages/raiderio/src/client.ts\` | Historic Mythic first-kill guild/date/rank normalization. |
| \`packages/warcraftlogs/src/*\` | OAuth, GraphQL, normalized public report evidence. |
| \`packages/application/src/applicant-dossier-service.ts\` | Read snapshots and assemble the unsaved dossier. |
| \`apps/web/src/app/api/dossiers/*\` | Start/read dossier-oriented API routes. |
| \`apps/web/src/components/dossier-*.tsx\` | Accessible linked-character and raid/boss display. |

### Task 1: Canonical input and dossier domain model

**Files:**
- Modify: \`packages/domain/src/character-key.ts\`
- Modify: \`packages/domain/src/character-key.test.ts\`
- Create: \`packages/domain/src/applicant-dossier.ts\`
- Create: \`packages/domain/src/applicant-dossier.test.ts\`
- Modify: \`packages/domain/src/index.ts\`

**Interfaces:**
- Produces: \`parseApplicantCharacterUrl(input: string): CharacterKey\` and \`buildApplicantDossier(input: BuildApplicantDossierInput): ApplicantDossier\`.

- [ ] **Step 1: Write failing URL-parser tests.**

\`\`\`ts
expect(parseApplicantCharacterUrl(
  "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii"
)).toEqual({ region: "eu", realm: "silvermoon", name: "ryii" });
expect(() => parseApplicantCharacterUrl(
  "https://raider.io.evil/characters/eu/silvermoon/Ryii"
)).toThrow("invalid_character_url");
\`\`\`

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/domain test -- character-key.test.ts\`

Expected: FAIL because \`parseApplicantCharacterUrl\` is absent.

- [ ] **Step 3: Implement strict source dispatch and shared path validation.**

\`\`\`ts
export function parseApplicantCharacterUrl(input: string): CharacterKey {
  const url = parseAbsoluteHttpsUrl(input);
  if (url.hostname === "raider.io") return parseRaiderIoCharacterUrl(input);
  if (url.hostname === "www.warcraftlogs.com") return parseWarcraftLogsCharacterUrl(url);
  throw new Error("invalid_character_url");
}
\`\`\`

The Warcraft Logs branch must use the same lowercasing and realm/name grammar as Raider.IO and reject credentials, query strings, fragments, and extra path parts.

- [ ] **Step 4: Write failing aggregation tests.**

\`\`\`ts
const dossier = buildApplicantDossier({
  root, characters: [rootCharacter, altCharacter],
  kills: [laterRootKill, earlierAltKill, duplicateAltKill],
  limitations: [{ source: "warcraft_logs", character: altKey, code: "private" }]
});
expect(dossier.raids[0].cuttingEdge).toBe(true);
expect(dossier.raids[0].bosses[0].firstKill.characters).toEqual(["Ryii", "Ryalts"]);
expect(dossier.limitations[0].code).toBe("private");
\`\`\`

- [ ] **Step 5: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/domain test -- applicant-dossier.test.ts\`

Expected: FAIL because dossier values and aggregation are absent.

- [ ] **Step 6: Implement immutable evidence values and deterministic aggregation.**

\`\`\`ts
export type DossierKillEvidence = Readonly<{
  raidId: string; raidName: string; bossId: string; bossName: string;
  bossOrder: number; isFinalBoss: boolean; character: CharacterKey;
  killedAt: string; guild: { name: string; realm: string } | null;
  historicWorldRank: number | null; reportUrl: string | null;
}>;
export function buildApplicantDossier(input: BuildApplicantDossierInput): ApplicantDossier;
\`\`\`

Select earliest dated kill per character/boss, merge shared report/kill evidence while retaining all character credits, order raids/bosses deterministically, and mark CE only when final-boss evidence exists. Limitations must prevent an unearned negative conclusion.

- [ ] **Step 7: Verify and commit.**

Run: \`corepack pnpm --filter @slashwho/domain test && corepack pnpm --filter @slashwho/domain typecheck && corepack pnpm format:check\`

Expected: PASS.

\`\`\`powershell
git add packages/domain
git commit -m "feat: add applicant dossier domain model"
\`\`\`

### Task 2: Contract and source-label boundary

**Files:**
- Create: \`packages/contracts/src/dossier.ts\`
- Modify: \`packages/contracts/src/index.ts\`
- Modify: \`packages/contracts/src/contracts.test.ts\`
- Modify: \`packages/application/src/serializers.ts\`
- Modify: \`packages/application/src/serializers.test.ts\`

**Interfaces:**
- Consumes: stored snapshot \`discoverySource\`.
- Produces: \`createDossierRequestSchema\`, \`applicantDossierSchema\`, and \`DossierSourceLabel\`.

- [ ] **Step 1: Write failing strict contract tests.**

\`\`\`ts
expect(createDossierRequestSchema.parse({ characterUrl: validUrl })).toEqual({
  characterUrl: validUrl
});
expect(() => applicantDossierSchema.parse({ ...validDossier, rawResponse: {} })).toThrow();
expect(validDossier.raids[0].bosses[0].firstKill.historicWorldRank).toBeNull();
\`\`\`

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/contracts test -- contracts.test.ts\`

Expected: FAIL because dossier schemas are absent.

- [ ] **Step 3: Implement schemas and exact source-label mapping.**

\`\`\`ts
export const dossierSourceLabelSchema = z.enum([
  "raiderio_declared", "fingerprint_derived"
]);
export const dossierLimitationSchema = z.object({
  source: z.enum(["raiderio", "warcraft_logs"]),
  character: characterKeySchema.nullable(),
  code: z.enum(["not_found", "private", "rate_limited", "request_cap", "unavailable", "schema_changed"]),
  message: z.string().min(1)
}).strict();
\`\`\`

Map \`input\`, \`claimed\`, \`declared_main\`, and \`profile_guess\` to \`raiderio_declared\`; map only \`fingerprint\` to \`fingerprint_derived\`. Do not alter the existing public character serializer.

- [ ] **Step 4: Verify and commit.**

Run: \`corepack pnpm --filter @slashwho/contracts test && corepack pnpm --filter @slashwho/application test -- serializers.test.ts && corepack pnpm typecheck\`

Expected: PASS.

\`\`\`powershell
git add packages/contracts packages/application/src/serializers*
git commit -m "feat: define applicant dossier contract"
\`\`\`

### Task 3: Raider.IO historic-kill evidence gateway

**Files:**
- Modify: \`packages/raiderio/src/types.ts\`
- Modify: \`packages/raiderio/src/client.ts\`
- Modify: \`packages/raiderio/src/client.test.ts\`
- Modify: \`packages/raiderio/src/index.ts\`
- Create: \`tests/fixtures/raiderio/raid-progress-valid.json\`
- Create: \`tests/fixtures/raiderio/raid-progress-rate-limited.json\`
- Create: \`tests/fixtures/raiderio/raid-progress-schema-drift.json\`

**Interfaces:**
- Produces: \`getHistoricMythicKills(key, options): Promise<HistoricMythicKillResult>\`.

- [ ] **Step 1: Write failing fixture-driven client tests.**

\`\`\`ts
const result = await client.getHistoricMythicKills(key, { tierOrdinals: [30, 31] });
expect(result).toMatchObject({ kind: "evidence", kills: [expect.objectContaining({
  bossName: "Queen Ansurek",
  guild: { name: "Example Guild", realm: "silvermoon" },
  historicWorldRank: 147
})] });
\`\`\`

Also test duplicate tiers choose the earliest kill, 429 preserves retry timing, cap stops before a request, and malformed payloads return \`schema_drift\`, not an empty list.

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/raiderio test -- client.test.ts\`

Expected: FAIL because the historic-kill gateway is absent.

- [ ] **Step 3: Implement typed, bounded normalization.**

\`\`\`ts
export type HistoricMythicKill = Readonly<{
  raidId: string; raidName: string; bossId: string; bossName: string;
  bossOrder: number; isFinalBoss: boolean; firstDefeated: string;
  guild: { name: string; realm: string } | null; historicWorldRank: number | null;
}>;
export type HistoricMythicKillResult =
  | { kind: "evidence"; kills: readonly HistoricMythicKill[] }
  | { kind: "limitation"; code: RaiderIoEvidenceLimitation; retryAfterMs?: number };
\`\`\`

Validate every field. Missing guild/rank is \`null\`; invalid response structure is a limitation. Never log raw data, and enforce tier/request caps before fetches.

- [ ] **Step 4: Verify and commit.**

Run: \`corepack pnpm --filter @slashwho/raiderio test && corepack pnpm --filter @slashwho/raiderio typecheck\`

Expected: PASS.

\`\`\`powershell
git add packages/raiderio tests/fixtures/raiderio
git commit -m "feat: gather historic mythic kill evidence"
\`\`\`

### Task 4: Warcraft Logs gateway package

**Files:**
- Create: \`packages/warcraftlogs/package.json\`
- Create: \`packages/warcraftlogs/tsconfig.json\`
- Create: \`packages/warcraftlogs/src/types.ts\`
- Create: \`packages/warcraftlogs/src/client.ts\`
- Create: \`packages/warcraftlogs/src/index.ts\`
- Create: \`packages/warcraftlogs/src/client.test.ts\`
- Create: \`tests/fixtures/warcraftlogs/token-valid.json\`
- Create: \`tests/fixtures/warcraftlogs/character-report-valid.json\`
- Create: \`tests/fixtures/warcraftlogs/character-private.json\`
- Create: \`tests/fixtures/warcraftlogs/schema-drift.json\`
- Modify: \`pnpm-lock.yaml\`, \`Dockerfile.web\`

**Interfaces:**
- Produces: \`WarcraftLogsGateway.resolveCharacter()\` and \`WarcraftLogsGateway.getFirstKillReports()\`.

- [ ] **Step 1: Write failing OAuth and GraphQL boundary tests.**

\`\`\`ts
const client = createWarcraftLogsClient({ fetch, clientId: "id", clientSecret: "secret" });
await client.getFirstKillReports(key, { requestCap: 10 });
await client.getFirstKillReports(key, { requestCap: 10 });
expect(fetch).toHaveBeenCalledTimes(3); // token plus two GraphQL requests
\`\`\`

Cover canonical resolution, report pagination, public report links, private profiles, 429, request cap, and malformed GraphQL envelopes. Assert logs/returned values never contain the client secret or raw response.

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/warcraftlogs test -- client.test.ts\`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement defensive OAuth and normalized report evidence.**

\`\`\`ts
export interface WarcraftLogsGateway {
  resolveCharacter(key: CharacterKey, signal?: AbortSignal): Promise<WarcraftLogsIdentityResult>;
  getFirstKillReports(
    key: CharacterKey,
    options: Readonly<{ requestCap: number; signal?: AbortSignal }>
  ): Promise<WarcraftLogsReportResult>;
}
\`\`\`

Cache token only in-process and expire it 60 seconds early. Normalize public report/fight URLs, encounter ID, and timestamp. Translate not-found/private/rate-limited/capped/unavailable/schema drift into typed limitations.

- [ ] **Step 4: Register, verify, and commit.**

Run: \`corepack pnpm install --lockfile-only && corepack pnpm --filter @slashwho/warcraftlogs test && corepack pnpm --filter @slashwho/warcraftlogs typecheck\`

Expected: PASS.

\`\`\`powershell
git add packages/warcraftlogs pnpm-lock.yaml Dockerfile.web tests/fixtures/warcraftlogs
git commit -m "feat: add warcraft logs dossier gateway"
\`\`\`

### Task 5: Transient applicant dossier service

**Files:**
- Create: \`packages/application/src/applicant-dossier-service.ts\`
- Create: \`packages/application/src/applicant-dossier-service.test.ts\`
- Modify: \`packages/application/src/index.ts\`
- Modify: \`packages/application/src/config.ts\`
- Modify: \`packages/application/src/config.test.ts\`
- Modify: \`packages/application/package.json\`

**Interfaces:**
- Consumes: \`SearchService\`, repositories, both evidence gateways, source-label mapping.
- Produces: \`ApplicantDossierService.start(input)\` and \`ApplicantDossierService.read(key)\`.

- [ ] **Step 1: Write failing orchestration tests.**

\`\`\`ts
const result = await dossiers.read(key);
expect(result).toMatchObject({ kind: "ready", dossier: expect.any(Object) });
expect(repositories.snapshots.create).not.toHaveBeenCalled();
expect(repositories.runs.create).not.toHaveBeenCalled();
\`\`\`

Cover fresh snapshot, active run reuse, no-snapshot \`not_ready\`, source labels, per-character source failure, deterministic character cap, and merged evidence.

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/application test -- applicant-dossier-service.test.ts\`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Add bounded dossier config and tests.**

\`\`\`ts
DOSSIER_RAIDERIO_TIER_CAP: z.coerce.number().int().min(1).max(40).default(32),
DOSSIER_CHARACTER_CAP: z.coerce.number().int().min(1).max(30).default(12),
DOSSIER_WARCRAFT_LOGS_REQUEST_CAP: z.coerce.number().int().min(1).max(200).default(80)
\`\`\`

Test invalid bounds and defaults. The character cap selects snapshot order and records a \`request_cap\` limitation for skipped members.

- [ ] **Step 4: Implement no-write orchestration.**

\`\`\`ts
export interface ApplicantDossierService {
  start(input: CreateDossierCommand): Promise<CreateDossierResult>;
  read(key: CharacterKey, signal?: AbortSignal): Promise<ReadDossierResult>;
}
\`\`\`

\`start\` parses either URL and delegates to current search with the canonical Raider.IO URL. \`read\` reads the existing immutable snapshot, gathers both evidence streams for each allowed character, joins matching boss/timestamp facts, aggregates, and returns limitations. It must never call a dossier repository or alter a snapshot.

- [ ] **Step 5: Verify and commit.**

Run: \`corepack pnpm --filter @slashwho/application test && corepack pnpm --filter @slashwho/application typecheck && corepack pnpm format:check\`

Expected: PASS.

\`\`\`powershell
git add packages/application
git commit -m "feat: assemble transient applicant dossiers"
\`\`\`

### Task 6: Web service wiring and dossier API

**Files:**
- Modify: \`apps/web/src/server/config.ts\`
- Modify: \`apps/web/src/server/config.test.ts\`
- Modify: \`apps/web/src/server/container.ts\`
- Modify: \`apps/web/src/server/container.test.ts\`
- Create: \`apps/web/src/app/api/dossiers/route.ts\`
- Create: \`apps/web/src/app/api/dossiers/[region]/[realm]/[name]/route.ts\`
- Create: \`apps/web/src/app/api/dossiers/api-contract.test.ts\`
- Modify: \`.env.example\`, \`apps/web/package.json\`

**Interfaces:**
- Produces: \`POST /api/dossiers\` and \`GET /api/dossiers/:region/:realm/:name\`.

- [ ] **Step 1: Write failing web-config tests.**

\`\`\`ts
expect(() => loadWebConfig({ DATABASE_URL: url })).toThrow("warcraft_logs_client_id_required");
expect(loadWebConfig(validEnvironment).dossier.warcraftLogsRequestCap).toBe(80);
\`\`\`

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/web test -- config.test.ts\`

Expected: FAIL because Warcraft Logs/dossier config is absent.

- [ ] **Step 3: Wire server-only gateways and dossiers into the container.**

\`\`\`ts
export type WebContainer = Readonly<{
  searches: SearchService;
  dossiers: ApplicantDossierService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}>;
\`\`\`

Inject fake gateways in tests; never put credentials in client runtime configuration.

- [ ] **Step 4: Write failing route tests, then implement routes.**

\`\`\`ts
expect((await POST(new Request("http://test/api/dossiers", {
  method: "POST", body: JSON.stringify({ characterUrl: wclUrl })
}))).status).toBe(202);
\`\`\`

POST returns ready identity or existing job; GET returns a strict dossier, \`409 discovery_not_ready\`, or safe error/rate-limit response. Apply a read rate limit before third-party calls.

- [ ] **Step 5: Verify and commit.**

Run: \`corepack pnpm --filter @slashwho/web test -- config.test.ts container.test.ts api-contract.test.ts && corepack pnpm --filter @slashwho/web typecheck && corepack pnpm --filter @slashwho/web build\`

Expected: PASS.

\`\`\`powershell
git add apps/web .env.example
git commit -m "feat: expose applicant dossier routes"
\`\`\`

### Task 7: Dossier-only web experience

**Files:**
- Modify: \`apps/web/src/app/page.tsx\`
- Modify: \`apps/web/src/components/search-form.tsx\`
- Modify: \`apps/web/src/components/search-form.test.tsx\`
- Create: \`apps/web/src/app/dossiers/[region]/[realm]/[name]/page.tsx\`
- Create: \`apps/web/src/app/dossiers/[region]/[realm]/[name]/dossier-page-client.tsx\`
- Create: \`apps/web/src/components/dossier-character-list.tsx\`
- Create: \`apps/web/src/components/dossier-raid-list.tsx\`
- Create: \`apps/web/src/components/dossier-limitations.tsx\`
- Create: \`apps/web/src/components/dossier-view.test.tsx\`
- Modify: \`apps/web/src/app/layout.tsx\`, \`apps/web/src/components/site-header.tsx\`, \`apps/web/src/app/globals.css\`

**Interfaces:**
- Consumes: dossier routes and \`applicantDossierSchema\`.
- Produces: accessible search and dossier pages with no public navigation.

- [ ] **Step 1: Write failing UI tests for both input sources and dossier navigation.**

\`\`\`tsx
await user.type(input, "https://www.warcraftlogs.com/character/eu/silvermoon/Ryii");
await user.click(screen.getByRole("button", { name: "Research applicant" }));
expect(push).toHaveBeenCalledWith("/dossiers/eu/silvermoon/ryii?job=...");
\`\`\`

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm --filter @slashwho/web test -- search-form.test.tsx\`

Expected: FAIL because the old form only accepts Raider.IO and old paths.

- [ ] **Step 3: Implement poll/read lifecycle without browser-side third-party calls.**

Use \`parseApplicantCharacterUrl\`, POST \`/api/dossiers\`, poll the current discovery job, then GET the dossier route. Keep errors adjacent to input/status with \`aria-live\` and \`role="alert"\`.

- [ ] **Step 4: Write failing rendering tests, then create presentational components.**

\`\`\`tsx
expect(screen.getByRole("heading", { name: "Historic Cutting Edge" })).toBeVisible();
expect(screen.getByText("Queen Ansurek")).toBeVisible();
expect(screen.getByText("World #147")).toBeVisible();
expect(screen.getByText(/Warcraft Logs data is unavailable for Ryalts/i)).toBeVisible();
\`\`\`

Use native \`<details>/<summary>\` for boss evidence. Show source-label badges, direct report links, and em dashes for unavailable guild/rank/report values; limitations must explain every unknown.

- [ ] **Step 5: Replace public metadata/navigation and add responsive dossier CSS.**

Remove API/GitHub navigation and all UI links to \`/characters\`; set applicant-research metadata. Add only styles needed for dossier hierarchy, labels, limitations, grids, and narrow-screen stacking.

- [ ] **Step 6: Verify and commit.**

Run: \`corepack pnpm --filter @slashwho/web test -- search-form.test.tsx dossier-view.test.tsx && corepack pnpm --filter @slashwho/web build\`

Expected: PASS.

\`\`\`powershell
git add apps/web/src
git commit -m "feat: add applicant dossier interface"
\`\`\`

### Task 8: Retire public routes, update docs, and verify deployment

**Files:**
- Delete: \`apps/web/src/app/characters/**\`
- Delete: \`apps/web/src/app/api/v1/**\`
- Delete: \`apps/web/src/app/api/page.tsx\`
- Delete: \`apps/web/src/app/privacy/page.tsx\`
- Modify: \`README.md\`, \`docs/deployment/railway.md\`, \`docs/operations/removals.md\`, \`.env.example\`
- Modify: \`tests/e2e/search.spec.ts\`, \`tests/e2e/responsive.spec.ts\`
- Delete: \`tests/e2e/history.spec.ts\`
- Create: \`tests/e2e/support/fake-warcraftlogs.ts\`

**Interfaces:**
- Consumes: complete dossier flow.
- Produces: no reachable public character/history/API UI and documented internal Railway use.

- [ ] **Step 1: Write failing e2e journeys for both URL forms and partial evidence.**

\`\`\`ts
await page.getByLabel("Applicant URL").fill(wclUrl);
await page.getByRole("button", { name: "Research applicant" }).click();
await expect(page.getByRole("heading", { name: "Historic Cutting Edge" })).toBeVisible();
await expect(page.getByText("World #147")).toBeVisible();
await expect(page.getByText(/evidence is incomplete/i)).toBeVisible();
\`\`\`

- [ ] **Step 2: Run the test to verify it fails.**

Run: \`corepack pnpm test:e2e -- search.spec.ts responsive.spec.ts\`

Expected: FAIL because the old public journey remains.

- [ ] **Step 3: Remove old public routes and only their orphaned components/tests.**

Before deletion, run \`rg -n "character-page-client|RefreshHistory|/api/v1|/characters"\` and replace every live import with dossier functionality. Do not delete worker, database, queues, snapshot repositories, Raider.IO discovery, or Blizzard fingerprint discovery.

- [ ] **Step 4: Update operational docs and configuration.**

Describe an unlisted, unauthenticated guild tool; mark Warcraft Logs credentials and dossier caps as web-only Railway configuration; remove public API/bot/privacy promises; retain the internal snapshot/removal operational process.

- [ ] **Step 5: Run full verification.**

Run: \`corepack pnpm format:check && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build && corepack pnpm test:e2e\`

Expected: every command exits 0.

- [ ] **Step 6: Commit.**

\`\`\`powershell
git add README.md docs apps/web tests .env.example
git rm -r apps/web/src/app/characters apps/web/src/app/api/v1
git commit -m "chore: retire public character surface"
\`\`\`

## Plan Self-Review

### Spec coverage

- Dual URL intake: Tasks 1 and 7.
- Existing durable relationship discovery: Tasks 5 and 8 reuse it.
- Transient, non-persisted dossier: Tasks 2 and 5.
- Historic Cutting Edge boss evidence, first-kill guild/date/rank/report: Tasks 1, 3, 4, 5, and 7.
- Source labels and explicit unknown states: Tasks 2, 5, and 7.
- Unlisted no-auth Railway deployment and secret protection: Tasks 6 and 8.
- Unit, contract, browser, and full verification: all tasks; full gate in Task 8.

### Completeness check

Every exported interface is introduced in the task that owns it. The plan has no unassigned implementation work.

### Type consistency

\`CharacterKey\` is used at all boundaries. Domain dossier values feed strict contracts; application consumes typed gateway results; only the web service owns credentials; browser components consume contract schemas only.
