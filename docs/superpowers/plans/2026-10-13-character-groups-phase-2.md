# Character groups phase 2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. The Manager must approve this draft before product code is changed.

**Goal:** Every character in a group opens a dossier rooted at that character, reuses fresh discovery, shares active discovery, and supports reviewer edits across the group.

**Architecture:** Add a production, group-scoped read projection using the existing graph resolver, with O's own latest completed snapshot folded into membership. Use that projection for membership decisions and a single run-completion freshness predicate for search, reservation, page staleness and replay. Keep phase 1's post-commit observation writes and publication transactions unchanged.

**Tech Stack:** TypeScript, PostgreSQL, pg-boss, Next.js, Zod, Vitest, Playwright; commands use `corepack pnpm`.

**Spec:** `docs/superpowers/specs/2026-09-28-character-groups-design.md`, approved on main in `7c21c89f` (#901). Implement Phase 2, its shared model constraints, Error handling, Preserved behaviour P1–P7, and Phase 2 Testing. Issue #902 is the delivery ticket; #738 is the parent.

## Global constraints

- Writes remain best effort after publication commits, outside #772's fenced transaction. Do not change publication code or add to its fenced repository set.
- No migration, automatic rewrite or deletion of stored rows. Existing snapshots and both exclusion stores remain.
- No provider calls while any database lock or read transaction is held. Tests use fixtures, with no live provider traffic.
- Lock order: rebuild shared, sorted bucket/root locks where needed, fingerprint-sweeps where needed, groups, then discovery-run row locks. Never acquire a root lock after the groups lock.
- Privacy: suppression hides characters and stops graph traversal. Dossier responses remain `Cache-Control: no-store`; logs and replay never print suppressed keys or raw provider responses.
- Freshness uses complete runs' `completed_at`, including `completeWithLiveSweepSnapshot`, over page members; never snapshot `refreshed_at` or whole stored-group freshness.
- Rank and cap with `DOSSIER_CHARACTER_CEILING`; evidence collection and tier search use the same included subjects. Excluded subjects remain separately visible as today.
- Keep `legacyResolveSubjects` for replay/tests until phase 3. It is already named that way on this base; do not rename it again.
- `provisional` remains accepted for rollback compatibility but is no longer produced. `hasManualConnection` and `groupStale` are optional so the frozen demo still parses.
- Phase 3 owns rejection writes, expiry, undo, the manual-half rejection predicate and the fold-in rejection filter. Do not ship that filter independently in phase 2.
- One issue, branch and PR. Do not merge, enable auto-merge or deploy; the Manager owns those actions and the four ship gates below.

## Review focus

1. A suppressed bridge must not contribute freshness, an active run, labels, research messages or exclusion effects; test in Tasks 1–3 and 5.
2. A publication followed by failed recompute must show new snapshot members on O's page without weakening labels; test in Tasks 2 and 7.
3. Two stale siblings searched concurrently must share one charged run, and a 404 for one must leave another caller's queued run intact; test in Task 3.
4. Include/Remove must clear a suppressed maker's stored rows once per request, whereas reads ignore those rows; test in Task 5.
5. A stale page must start at most once, remain displayed after refusal/failure, and never enter recent searches; test in Task 4.

## Repository map and interfaces

New files:

- `packages/database/src/counting-links.ts`: shared counting-link SQL fragments for recompute, production/audit loaders and applicant component checks.
- `packages/database/src/group-reads.ts`: group-scoped production projection and transaction-local loader, not a whole-database audit on each request.
- `packages/application/src/group-freshness.ts` and `.test.ts`: pure freshness, failure back-off and sweep-due predicates.
- `tests/integration/group-dossier-reads.test.ts`: real PostgreSQL reads, fold-in, suppression and concurrent-read fixtures.
- `tests/e2e/group-dossiers.spec.ts`: sibling navigation, automatic starts and cross-page edits using fixture providers.

Existing seams:

- `packages/database/src/repositories.ts`, `postgres-repositories.ts`, `index.ts`: expose a `groupReads` repository and reservation options.
- `packages/domain/src/character-connections.ts`: extend `GroupGraph` with manual origins and run/snapshot facts; reuse `familyOf` and `pathStrengths`.
- `packages/application/src/group-subjects.ts`: resolve graph membership, fold-in, labels and shared exclusion effects.
- `packages/database/src/character-groups-audit.ts`: extend replay projection with the same facts; preserve audit-only ledger/drift loading.
- `packages/database/src/discovery-runs.ts`: use the transaction-local group loader during reservation; no nested pool checkout or read-only transaction inside a write transaction.

Proposed repository types (defined in Task 1):

```ts
type GroupSweepState = Readonly<{
  key: CharacterKey;
  lastPublishedAt: Date | null;
  resumeAfter: string | null;
  continuationFailures: number;
}>;

type GroupRead = Readonly<{
  groupId: string | null;
  storedMemberIds: readonly string[];
  graph: GroupGraph;
  ownSnapshot: StoredSnapshot | null;
  snapshots: readonly StoredSnapshot[];
  runs: readonly DiscoveryRun[];
  sweepStates: readonly GroupSweepState[];
  negativeUntil: Date | null;
}>;

interface GroupReadRepository {
  read(key: CharacterKey, at: Date): Promise<GroupRead | null>;
}
```

`GroupSweepState` is a new read projection of existing sweep-state columns, not a new persisted type. `null` means suppressed/unknown with no snapshot fallback. A discovered singleton may have `groupId: null` during lag; its own snapshot still contributes. `storedMemberIds` is for clear mutations only. Resolve page members before any group decision; fold in non-suppressed own-snapshot members before deriving those decisions. The scoped loader fetches enough character and link data for folded members and pending manual targets, and exposes guild metadata from snapshots rather than dropping it.

Internal SQL seam: `loadGroupRead(client: Pick<PoolClient, "query">, key: CharacterKey, at: Date): Promise<GroupRead | null>`. `groupReads.read` wraps it in `withConsistentRead`; reservation calls it on its existing client. All membership, links, snapshots, runs, suppression, aliases and exclusion facts for one response come from this one projection. Evidence/provider assembly happens after that transaction closes.

## Task 1: Production projection and shared membership facts

**Files:** New `group-reads.ts`, `counting-links.ts`, `group-freshness.ts` and tests; modify repository composition/exports, domain `GroupGraph`, `character-connections.ts`, `character-groups-audit.ts`; add `group-dossier-reads.test.ts`.

**Consumes:** Existing counting links, stored groups, `withConsistentRead`, snapshots and source tables. **Produces:** `groupReads.read`, `loadGroupRead`, extended graph facts, and pure run-completion freshness for all later tasks.

- [x] Seed O–A–B with A suppressed, O's snapshot containing C, and a fresh complete B run. Assert O's page contains O/C, never A/B, and B cannot make it fresh. Lift suppression and assert reach returns. Also cover unknown and suppressed O, pending/suppressed manual targets, and missing stored-group membership after a committed snapshot.
- [x] Run `corepack pnpm exec vitest run --project integration tests/integration/group-dossier-reads.test.ts`; confirm the new production API tests fail before implementation.
- [x] Export counting-link SQL from one module, preserving phase 1 semantics exactly. Recompute and audit use it; future applicant cross-group checks consume it. Load only O's stored group plus own-snapshot/pending-target data. Keep every response's reads on one repeatable-read client.
- [x] Define `isFresh(completedAt: readonly Date[], at: Date, freshnessHours: number): boolean` once. Derive dates only from complete runs of resolved page members. Test completion at either side of the cutoff, failed runs, partial snapshots, continuation whose snapshot timestamp did not move, and live-sweep completion with no new snapshot.

  Start the pure predicate test with:

  ```ts
  const at = new Date("2026-10-13T12:00:00Z");
  const hours = 24;
  expect(isFresh([], at, hours)).toBe(false);
  expect(isFresh([new Date("2026-10-12T12:00:01Z")], at, hours)).toBe(true);
  expect(isFresh([new Date("2026-10-12T11:59:59Z")], at, hours)).toBe(false);
  ```

  Implement against run completions, not snapshot timestamps:

  ```ts
  export function isFresh(
    completedAt: readonly Date[],
    at: Date,
    freshnessHours: number
  ): boolean {
    const cutoff = at.getTime() - freshnessHours * 3_600_000;
    return completedAt.some((completion) => completion.getTime() > cutoff);
  }
  ```

  Reuse this predicate in replay and source-table-backed reservation checks; add the exact-cutoff assertion using the same strict boundary.

- [x] Define failure back-off from consecutive latest failed runs: `FRESHNESS_HOURS * 2 ** (failures - 1)`, capped at `FINGERPRINT_SWEEP_CADENCE_HOURS`; a complete run ends the streak. Define sweep due from member sweep states, cadence, resumable cursor and active runs; five continuation failures mean abandoned.
- [x] Integration-test a publication committed between projection statements: a response sees one database version, with no mixed graph/snapshot/exclusion state. Unit-test boundary times and abandoned chains, then rerun both affected suites and commit `feat(groups): add consistent group read projection`.

## Task 2: Dossier subjects, labels, research and replay parity

**Files:** `group-subjects.ts`/tests, `dossier-subjects.ts`/tests, `applicant-dossier-service.ts`/tests, `dossier-gateways.ts`, `character-groups-replay.ts`/tests, audit loader and replay integration tests; contracts `dossier.ts`; new group read integration tests.

**Consumes:** Task 1 projection. **Produces:** Live `resolveSubjects` backed by group membership, retained legacy comparison, optional `hasManualConnection` and `groupStale` response fields.

- [x] Write failing resolver tests for O's own snapshot fold-in with no path; expected snapshot label and no error log. For an outside-snapshot member with no path, preserve its latest containing-snapshot label and log `group_member_unreachable`. Pin O's `input` source, including a sibling with no own snapshot.
- [x] Run `corepack pnpm exec vitest run --project unit packages/application/src/group-subjects.test.ts packages/application/src/applicant-dossier-service.test.ts` and confirm new assertions fail.
- [x] Union walked members with O's non-suppressed latest completed snapshot before ranking, alias merging, exclusions and the ceiling. Preserve root-first ranking and guild metadata. Resolve path strength with existing `pathStrengths`; log `group_label_weakened` for non-O snapshot members whose live labels weaken.
- [x] Add optional subject `hasManualConnection`. Add `origin` to both graph manual collections and audit queries. One per-target lookup over visible makers decides the flag and applicant origin: any manual row sets the flag; all applicant rows yield `origin: "application"`; a reviewer row wins. Provider paths keep their provider label while retaining Remove capability.
- [x] Test fingerprint→claimed paths, manual→provider paths, pending applicant targets, discovered manual-only applicant targets, mixed reviewer/applicant rows, aliases and an over-ceiling page. Frozen demo must still parse without the new fields.
- [x] Derive research state from contributing page-member snapshots: complete only when every contributing snapshot and O's own snapshot are complete. Keep internal limitation codes, and name only visible privacy-hidden roots in the public message. Preserve every legacy limitation under P4.
- [x] Switch live dossier/tier/membership reads to `resolveSubjects`; keep `sharedIdentityKeys` for maker self-identity and alias handling. Replay calls the same resolver against its captured projection, comparing to `legacyResolveSubjects`; add member freshness and applicant coverage reporting. Do not bypass P1–P7 or ledger/drift checks.
- [x] Inject failed post-commit recompute: O sees C, sibling does not; maintenance then heals both. Cover lost observations via the fold-in and replay's existing completeness failure. Run affected unit/integration suites and commit `feat(groups): read dossier subjects from groups`.

## Task 3: Search, reservation, applicant watcher and weekly sweep

**Files:** `discovery-runs.ts`, `repositories.ts`, `small-stores.ts`, application `search-service.ts`/tests, `start-applicant-collection.ts`/tests, `applicant-dossier-service.ts`/tests; integration `search-service.test.ts`, `repositories-evidence-searches.test.ts`, new group read tests.

**Consumes:** Task 1 membership/freshness/due predicates. **Produces:** Group-aware reservation, internal `group_ready`, group active state for recent searches and `readInitial`.

- [x] Write real-database concurrent searches for different stale siblings: expect one inserted run, one charge and all jobs referencing that run. Test a fresh sibling without a snapshot returning `group_ready` before negative cache or provider calls.
- [x] Run `corepack pnpm exec vitest run --project integration tests/integration/search-service.test.ts` and confirm these tests fail on root-only reservation.
- [x] Add internal `CreateSearchResult` variant `{ kind: "group_ready"; key: CharacterKey }`; keep strict public `CharacterResource` unchanged. Search order remains fresh group, negative cache, read-only allowance check, Raider.IO root read, reserve. Test rate-limited search makes no provider call; 404 for A cannot cancel/refund B's queued run.
- [x] Reserve performs unlocked freshness/active checks first. Fresh returns immediately. On stale path take locks in the declared order, reload membership and repeat freshness/active checks, then lock a candidate active run `FOR UPDATE` and recheck status before joining. Insert/charge only if no join/fresh result applies. No provider call in this transaction.
- [x] Extend `reserve` with optional `ignoreFreshness` and a serialisable `sweepDue` value carrying cadence cutoff and continuation-failure bound. Weekly sweep uses `fingerprint-sweep-visit` and a non-refusing limit, repeats due and active checks under the groups lock and returns without insertion if no longer due. Use an explicit `not_due` internal result for that branch and exhaustively update callers.
- [x] Test a sweep publishing between unlocked due check and locked reservation; no duplicate run. Test active/live cursor blocks, abandoned cursor permits, freshness alone does not block, and concurrent sibling visits queue one sweep.
- [x] Return O's URL even when joining B. Applicant re-enqueue uses `reservation.run.rootKey`, with existing queue payload fields; add any genuinely new payload field to queue's explicit list. `readInitial` follows page-member active runs; recent-search progress does likewise.
- [x] Test applicant/landing/weekly paths agree, stale queued run without job id is re-enqueued from its owner, and suppressed bridge's active run is never joined. Run affected unit/integration suites and commit `feat(groups): share discovery reservations across page members`.

## Task 4: One automatic start on a stale group page

**Files:** contracts `dossier.ts`/tests, dossier API `route.ts` and API contract tests, `applicant-dossier-service.ts`, `apps/web/src/lib/dossier-api.ts`/tests, dossier page client/tests, new group e2e file and `tests/e2e/search.spec.ts`.

**Consumes:** Tasks 2/3 dossier state and search result. **Produces:** Optional strict request `startedFrom: "page"`, ready mapping, silent stale-page start behaviour.

- [x] Write contract tests: optional `startedFrom: "page"` accepted, omitted field accepted, unknown `origin` still rejected. Test `group_ready` maps to `{ kind: "ready" }` without manufacturing a snapshot resource.
- [x] Run `corepack pnpm exec vitest run --project unit apps/web/src/app/api/dossiers/api-contract.test.ts apps/web/src/lib/dossier-api.test.ts`; confirm added cases fail.
- [x] Compute `groupStale` from page-member freshness, active runs and failure back-off plus O's negative cache. Explicit landing searches ignore failure back-off. Keep root-only `submitted` behaviour; no production provisional pages.
- [x] In `readCurrentOrStartResearch`, only the first read with no active job may start a stale group, passing `startedFrom: "page"`. Poll/expanded/refreshed/completed reads never start. Preserve content after every non-job/non-ready result and after job failure, including joined sibling failure; root-only research errors remain.
- [x] Record job/character/group_ready only for deliberate searches; omit page starts. Keep existing root-only automatic-start recording.
- [x] E2E-test fresh sibling sends zero starts; stale sends exactly one; polling live evidence sends no second start; failed/refused/negative-cached page keeps content. Cover live and abandoned O sweep chains becoming fresh after one completion, consecutive-failure back-off, explicit search despite back-off and recent-search distinction.
- [x] Run affected unit tests and `corepack pnpm exec playwright test tests/e2e/group-dossiers.spec.ts tests/e2e/search.spec.ts` after build; commit `feat(groups): refresh stale group pages once per load`.

## Task 5: Reviewer edits across groups

**Files:** database `small-stores.ts`, `repositories.ts`, `character-connections.ts`; application dossier service/tests; connected-character and historic-alias routes/tests; character menu/tests; `tests/integration/repositories-dossier-connections.test.ts`, connected-action e2e and group e2e.

**Consumes:** Visible page membership for reads and full stored membership for clear mutations. **Produces:** Group-scoped mutation semantics with one admission charge per request.

- [x] Seed a manual/exclusion row made by suppressed A targeting visible T. Reads from O must ignore it. Include/Remove from O must clear it even while A is suppressed; after lifting suppression T must not unexpectedly return or grey.
- [x] Run `corepack pnpm exec vitest run --project integration tests/integration/repositories-dossier-connections.test.ts` and confirm group clear assertions fail.
- [x] Add scoped SQL operations rather than looping separately committed root operations: Include clears both stores across stored members; Remove deletes all stored-group manual rows to T and recomputes affected groups under groups lock in the same transaction. Admission is charged once before these writes.
- [x] Exclude uses visible makers' manual rows targeting T; otherwise writes one discovered exclusion from O if none applies. Ignore/guard maker self-exclusions including recorded WCL aliases. O is never grey on its own page; hide its Exclude menu action. Include retains manual rows.
- [x] Before manual add spends/queues, test rejected pairs between the components computed from current counting links. Recheck before the final write to avoid a concurrent rejection race. Rejection reads already exist in phase 1 data even though phase 2 writes none. Only job/character/group_ready results permit a row from O; recompute immediately in its own transaction.
- [x] Update connected/historic/alias access checks to page membership, retaining WCL identity semantics. Remove uses `hasManualConnection` independently of provider label; dialog says “Remove the manual connection to T” and explains when a provider path keeps T present.
- [x] Test cross-page both-store exclude/include, self/WCL alias guards, provider-path removal, pending/known manual adds, rejected components, suppression/rate-limited/invalid target leaving no row, and one mutation charge for many rows. Run integration and connected-action e2e suites; commit `feat(groups): apply reviewer edits across stored groups`.

## Task 6: Worker identity, merge alerts and operations

**Files:** worker `runtime.ts`/tests, database `queue.ts`/tests and recompute code, domain connection result types, operations `character-groups.md`, `CONTEXT.md`.

**Consumes:** Existing recompute and maintenance paths. **Produces:** Distinguishable worker connections, richer observed-merge alert, phase 2 operational instructions and domain entries.

- [x] Write failing tests asserting repository and pg-boss worker pools set `application_name: "slashwho-worker"`; web/ops constructors keep their respective existing behaviour. Implement an optional queue application-name option using pg-boss's installed API; worker passes it.
- [x] Enrich recompute result metadata with both pre-merge group sizes and bridging source/type. Test observed merges of two groups with more than one member alert through `MAINTAINER_ALERT_WEBHOOK_URL` when set; manual-only merges log only. Maintenance-detected observed merges also alert. Web has no webhook; do not add webhook calls under database locks.
- [x] Keep alert failure best effort and existing recompute 30-second maintenance bound. Add regression tests showing failed recompute/alert cannot roll back publication or skip pending-search recovery.
- [x] Update `CONTEXT.md` Connection, Group, page members, reverse declaration, shared exclusions and applicant dossier vocabulary. Update runbook with the four ship gates, periodic replay, lost-write rebuild repair, deploy order, revert-only phase 2 rollback and applicant flag off before phase 1 rollback.
- [x] Run runtime/queue/recompute tests and commit `feat(groups): identify worker connections and alert on observed merges`.

## Task 7: Publication premise, full gate and Manager hand-off

**Files:** `tests/integration/character-connections.test.ts`, group/replay tests, operations evidence and PR body; publication implementation remains untouched.

- [ ] Extend existing publication fixtures to pin every non-self snapshot member's direct root-observer row, enumerating domain observation sources/families with `familyOf` instead of a private hard-coded family array. The base has a union but no exported source list: introduce a domain `DISCOVERY_SOURCES` constant and derive `DiscoverySource` from it, preserving every existing literal. Export it through the domain index. The premise test iterates non-input sources and uses an exhaustive `Record<ObservationSource, fixture builder>` so a new source requires fixture coverage. Exercise Raider.IO-only, not_due, privacy-hidden, first cycle, continuation, seal and live-sweep completion. A deliberately unhandled new source must fail the test. Cover multiple sources for one member before deduplication.
- [ ] Verify preservation P1–P7 including limitation codes, immutable publication/evidence state and the existing writer-on/off checksums. Replay must fail on missing members, weaker labels, unexplained exclusions or limitations and over-ceiling pages, while reporting accepted growth/shared exclusions.
- [ ] With Docker running, run in order `corepack pnpm format:check`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm test:unit`, `corepack pnpm test:integration`, `corepack pnpm build`, `corepack pnpm test:e2e`. Inspect failures/skips; do not count a skipped suite as passing.
- [ ] Review against `origin/main` with low effort, fix findings and rerun the gate after fixes. Fetch/merge `origin/main`, then rerun the full gate. Any concurrently merged #813 integration must consume the shared counting fragments and origin facts; do not duplicate its component query.
- [ ] Update the existing draft's title/body to the implementation scope, link `Closes #902`, attach verification and risks, retain “not for auto-merge; the manager decides”, then mark ready only after local checks pass. Notify the Manager through the PR and tell the user.
- [ ] Watch CI, inspect comments and inline review threads, address verified findings and resolve fixed threads. Do not self-merge, enable auto-merge or deploy.

## Ship evidence required on the implementation PR

The plan draft is not evidence that phase 2 is ready to ship. Each item needs environment, UTC interval, tested commit and redacted output; secret connection strings and suppressed keys must never be attached.

1. **Replay:** run `corepack pnpm ops:replay-groups` read-only against the phase 2 deployment tree, with the environment's actual `DOSSIER_CHARACTER_CEILING`. Attach P1–P7 and ledger/drift/path coverage summary, pending exceptions and exact commit. Rebuild first if phase 1 was reverted.
2. **Outside maintenance consumer:** for the seven days immediately before deployment, reconcile every completed `maintenance-cleanup` `pgboss.job` against Railway worker `evidence_cache_cleanup` logs using job identity where available and start/completion times. Attach the complete reconciliation and zero-unmatched count. `pg_stat_activity`/application names alone cannot satisfy this condition. Never run a local worker against test/production.
3. **#753 tournament check:** list fingerprint observations attached to chains started before `2026-09-29T11:33:00Z`. Either show an empty result or show every named root's post-#753 rerun and subsequent rebuild, including the check for tournament profiles. Use existing sweep/run linkage, not observation timestamp alone.
4. **Applicant linking:** record the deployed `APPLICANT_LINKING_ENABLED` flag. When enabled, replay coverage must include at least one applicant link. If #813 is not yet deployed, record flag-off explicitly and retain fixture label coverage.

These conditions may require Railway access or elapsed time beyond this implementation session. Missing evidence keeps merging/deployment on hold; it does not justify changing publication safety or weakening replay.

## Decisions for the Manager's plan review

- Confirm the production projection is group-scoped and shared by live reads and replay resolution, while replay retains an independent legacy comparison and audit-only completeness/drift checks.
- Confirm Exclude uses visible page members' manual rows, consistent with the explicit suppression rule and “writes that add” scope; Include/Remove use full stored membership. The edit table's shorthand “group” must not override the specified suppression behaviour.
- Confirm phase 2 reads existing rejection data for manual-add checks but leaves manual-half counting correction and fold-in rejection filtering together for phase 3.
- Confirm absent ship evidence holds merge/deploy independently of implementation review. The plan does not claim any of the four conditions is currently satisfied.
