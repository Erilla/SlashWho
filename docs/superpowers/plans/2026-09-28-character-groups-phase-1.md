# Character groups, phase 1: write connections and groups, read nothing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The worker records every discovery's observed character links, a per-family ledger of what it decided, and the resulting character groups. A read-only replay compares the future group-based dossier with today's, page by page, and audits the writes. No page, route, response or publication outcome changes.

**Architecture:**

- **Migration `0067`** creates six new tables and backfills them from today's snapshots and manual connections.
- **After each publication commits**, the discovery handler hands a pure, precomputed `ObservationWriteInput` to a best-effort writer. The writer runs in the handler's outer `finally`, after the timing log.
- **The writer** (`characterConnections` repository) stores observations, the forward-only marker and the ledger in one short transaction. It then recomputes each affected group in its own short transaction.
- **An hourly maintenance step** recomputes every group inside a 30-second budget, using a stored cursor. This picks up manual edits made on the web and any recomputes that were lost.
- **Phase 2's resolution code** (`resolveGroupSubjects`) ships unwired. Today's `resolveSubjects` is extracted unchanged, so the replay can run both.

**Tech stack:**

- TypeScript and Node, using `corepack pnpm` (never bare `pnpm`)
- PostgreSQL 16 through `pg`, with hand-written Drizzle migrations
- vitest: a `unit` project, and an `integration` project using Testcontainers, which needs Docker
- pg-boss for the worker's queue
- `tsx` for scripts

**Spec:** [`docs/superpowers/specs/2026-09-28-character-groups-design.md`](../specs/2026-09-28-character-groups-design.md), at `1cafd5ac` on `docs/738-character-groups`. Read it with this plan. The Status, Terms through Convergence, and Phase 1 sections are approved; phases 2 and 3 are Draft.

## Global constraints

- **Nothing observable changes in phase 1.** No page, API response, publication, retry, or evidence behaviour changes. A best-effort write never fails a publication, never turns a job into `cancelled`, and never delays `enqueueFingerprintAdmission` or `enqueueFullEvidence`.
- **Existing tables and rows are untouched.** The migration and writers only create the six new tables and insert into them. They never write to `snapshots`, `snapshot_characters`, `discovery_runs`, `characters`, `manual_dossier_connections`, `dossier_character_exclusions`, the `fingerprint_sweep_*` tables, or any evidence table (P2).
- **Privacy.**
  - The new tables hold only character ids, run ids, reservation ids, enum values and times: no BattleTags, Discord handles, raw provider responses, request URLs or guess strings.
  - `excludedTournamentCharacterIds` never reach a new table.
  - The replay never prints a suppressed character's key.
- **Lock order:** 0. the rebuild lock, taken shared by every new-table writer and exclusive only by the rebuild;
  1. the existing bucket and root locks;
  2. `fingerprint-sweeps`;
  3. the groups lock;
  4. any `discovery_runs` row lock.

  No transaction takes the groups lock and then a root lock, and no lock is held across a provider call.

- **Clocks.** Every `observed_at`, `written_at` and `recomputed_at` is the database's `now()`. `run_started_at` is `discovery_runs.started_at`, and is `NOT NULL` in every new table.
- **Retraction is decided per source family**, from what the run actually did, never from the snapshot's state:
  - The Raider.IO family is `claimed`, `declared_main` and `profile_guess`. It is replaced only when the run published its own snapshot, did its own Raider.IO discovery, and `raiderIoLimitation` is null.
  - The fingerprint family is replaced only when a sweep reached `matched` having read every roster: no 404 on the root's roster or profile, and no skipped historical guild.
  - A continuation cycle never touches the Raider.IO family.
  - A `not_due` or live-sweep completion never touches the fingerprint family.
- **The write is monotone:**
  - it never lowers `observed_at`;
  - it never retracts a row observed after its own run started;
  - it writes nothing for a family whose newest marker came from a run started after this one. In that case it logs a `blocked` ledger row with reason `blocked_by_newer`.
- **Every post-commit transaction sets `lock_timeout` to 5 seconds.** A timeout logs `character_groups_write_failed`.
- **Migration numbering.** The migration is `0067`, with journal `idx` 66 and `when` `1792011600018`. Recheck `origin/main` before merging. If `fix/raiderio-logged-kills-back-catalogue` lands first, renumber the SQL file, the journal `idx`, `when` (strictly greater), and the `slice(-N)` in `tests/integration/migrations.test.ts`.
- **Workflow.** Commits are conventional, and each ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work happens in this worktree (`docs/738-character-groups`) on a new branch `feat/738-character-groups-phase-1`, cut from `origin/main` per `docs/agents/implementation-workflow.md`, with the spec commit cherry-picked in (Task 0).

## Settled here: the Manager's four final Low items

1. **When drift fails.**
   - **What's recorded.** `character_groups_maintenance` records `cycle_started_at` and `last_cycle_started_at` / `last_cycle_completed_at`.
   - **When a group is pending.** A group G is pending while the newest ledger `written_at` among its members is later than `G.recomputed_at`, until a cycle that started after that `written_at` has completed.
   - **When drift is pending.** Drift that involves any pending group is pending, which covers the absorbed side of a merge.
   - **When drift fails.** Drift that isn't pending, and isn't manual-only, fails.
   - **The exit criterion** reads "no failing drift".
2. **Where the window starts.** Check (a)'s window starts at the newest `written_at` among ledger rows with reason `backfill` or `rebuild`. After the phase 1 deploy settles, the runbook runs the rebuild once, and the three days start from its `written_at`.
3. **Only committed publications are written.** The handler sets `pendingWrite` only after a publication call has resolved, and each call's promise resolves only after its transaction committed. A rolled-back publication therefore never reaches the writer.
4. **Constraints and indexes.**
   - `run_started_at` is `NOT NULL`. The backfill uses `COALESCE(started_at, created_at)`.
   - The ledger is indexed on `(observer_character_id, family, run_started_at, written_at)`, on `(run_id)` and on `(sweep_reservation_id)`.

## Settled here: one detail the spec leaves open

**Observations of characters with no `characters` row.** A live-sweep completion (`completeWithLiveSweepSnapshot`) discovers Raider.IO characters that no snapshot publishes, so some may have no `characters` row, and a connection needs a character id.

- **What the writer does.** It records observations only for keys that already have a row. It counts the rest in the log field `unknownCharacters` and never inserts into `characters` (P2).
- **Why this loses nothing that matters.** Phase 2 can't display a character with no row anyway. The observer's next published discovery upserts it and observes it.
- **What the spec should say.** This is worth one line in the spec when phase 2 is re-reviewed.

## Review focus

The five failure modes most likely to bite, each pinned by a test in its owning task:

1. **A publication whose follow-up throws after the commit.** For example, `enqueueFingerprintAdmission` rejects. The observation write must still happen, and the job's outcome must be unchanged. (Task 6, test "writes after a follow-up throws".)
2. **A job aborted after the publication committed.** The write must still happen, and the job must still end `cancelled` exactly as today, not later or differently. (Task 6, test "writes when aborted after commit".)
3. **A rebuild running while writes arrive.** The writes must time out and log, never interleave, and never deadlock. (Task 5, test "rebuild excludes concurrent writes".)
4. **A continuation cycle arriving late**, after a newer sweep chain has written. It must write nothing, and must log `blocked`. (Task 4, test "blocks a delayed continuation".)
5. **A character that both sources found in one run.** It must get two observations, and the replay's presence check must pass. (Task 4, test "records both sources before de-duplication"; Task 10, fixture "both sources".)

---

## File structure

**Create:**

- `packages/domain/src/character-connections.ts`: pure vocabulary and rules:
  - families and the source-to-family mapping;
  - retraction decisions;
  - connected components;
  - group-id survival;
  - path labels.
- `packages/domain/src/character-connections.test.ts`
- `packages/database/drizzle/0067_character_groups.sql`: the six tables, the backfill and the sanity check.
- `packages/database/src/character-connections.ts`: the `characterConnections` repository:
  - `writeObservations`;
  - `recomputeGroupsOf`;
  - `recomputePass`;
  - `rebuild`.
- `packages/database/src/character-groups-audit.ts`: `loadCharacterGroupsAudit(pool)`, a read-only snapshot of everything the replay audits.
- `packages/application/src/observation-writes.ts`: pure builders from handler facts to `ObservationWriteInput`.
- `packages/application/src/observation-writes.test.ts`
- `packages/application/src/dossier-subjects.ts`: today's `resolveSubjects`, extracted verbatim and exported as `legacyResolveSubjects`.
- `packages/application/src/group-subjects.ts`: phase 2's `resolveGroupSubjects`, unwired: page members, path labels, exclusions and research state.
- `packages/application/src/group-subjects.test.ts`
- `packages/application/src/character-groups-replay.ts`: the replay's comparison and ledger checks, a pure function over loaded data.
- `packages/application/src/character-groups-replay.test.ts`
- `scripts/diagnostics/character-groups-replay.mts`: the command-line entry point.
- `scripts/rebuild-character-groups.mts`: the command-line entry point for the rebuild.
- `tests/integration/character-connections.test.ts`
- `tests/integration/character-groups-replay.test.ts`
- `docs/operations/character-groups.md`: the runbook for deploy, rebuild, replay, triggering each path, and the exit criteria.

**Modify:**

- `packages/domain/src/fingerprint-discovery.ts`: flag an unread root and skipped historical guilds on `matched`.
- `packages/domain/src/fingerprint-discovery.test.ts`: two exact-equality 404 tests.
- `packages/domain/src/index.ts`: export the new module.
- `packages/database/src/schema.ts`: `pgTable`s for the six tables.
- `packages/database/drizzle/meta/_journal.json`: entry `idx` 66.
- `packages/database/src/repositories.ts`: the `CharacterConnectionRepository` interface and an optional `characterConnections?` key on `Repositories`.
- `packages/database/src/postgres-repositories.ts`: spread the new repository.
- `packages/database/src/index.ts`: export types and `loadCharacterGroupsAudit`.
- `packages/application/src/discovery-job-handler.ts`: set `pendingWrite` at four points and write it in the outer `finally`.
- `packages/application/src/discovery-job-handler.test.ts`
- `packages/application/src/applicant-dossier-service.ts`: call `legacyResolveSubjects`.
- `packages/application/src/index.ts`: exports.
- `apps/worker/src/runtime.ts`: the maintenance step.
- `apps/worker/src/logger.ts`: allowlist the new fields.
- `apps/worker/src/runtime.test.ts`
- `apps/worker/src/logger.test.ts`
- `tests/integration/migrations.test.ts`: the table list and the journal slice.
- `tests/integration/repository-fixtures.ts`: the truncate list.
- `package.json`: `ops:rebuild-groups` and `ops:replay-groups` scripts.

---

### Task 0: Branch

**Files:** none.

- [ ] **Step 1: Cut the branch from `origin/main`, carrying the spec**

```bash
git fetch origin
git switch -c feat/738-character-groups-phase-1 origin/main
git cherry-pick 1cafd5ac^..1cafd5ac 2>/dev/null || git checkout docs/738-character-groups -- docs/superpowers/specs/2026-09-28-character-groups-design.md docs/superpowers/plans/2026-09-28-character-groups-phase-1.md
git status --short
```

Expected: the spec and this plan are present. If the `git checkout` fallback ran, commit them:

```bash
git add docs/superpowers/specs/2026-09-28-character-groups-design.md docs/superpowers/plans/2026-09-28-character-groups-phase-1.md
git commit -m "docs: character groups spec and phase 1 plan (#738)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Install dependencies and check the baseline**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test:unit
```

Expected: all pass. If anything fails on a clean `origin/main`, stop and report it; don't fix unrelated failures here.

---

### Task 1: Flag an unread root and skipped guilds on a `matched` sweep

**Why:** the spec's fingerprint retraction needs to tell a real empty match from a 404 on the root's roster or profile, and from a match that skipped a 404'd historical guild. The facts are added as optional fields on `matched`, not as a new `kind`:

- **Why not a new kind.** It would change the handler's sealing and cursor flow at six `kind` checks. Phase 1 must not change a publication outcome.
- **Why not the spec's word `unread`.** The file already has an internal `CandidateResult` with `kind: "unread"`. The ledger reason is still `unread`.

**Files:**

- Modify: `packages/domain/src/fingerprint-discovery.ts:47-69` (the type), `:304`, `:320` (root 404s) and `:354` (historical guild 404)
- Modify: `packages/domain/src/fingerprint-discovery.test.ts:237-270`

**Interfaces:**

- Produces: `FingerprintSweepOutcome`'s `matched` variant gains `unreadRoot?: true` and `skippedHistoricalGuilds?: number`. Both are absent when not applicable, so existing `toEqual` assertions on ordinary matches still hold.

- [ ] **Step 1: Change the two 404 tests to expect the flag**

In `packages/domain/src/fingerprint-discovery.test.ts`, the tests at lines 237-258 ("finds nothing rather than failing when the root has no readable roster") and 260-270 ("...no readable profile") assert `{ kind: "matched", requestsUsed: …, characters: [] }`. Add `unreadRoot: true` to each expected object, keeping their existing `requestsUsed` values:

```ts
// in the "no readable roster" test
expect(outcome).toEqual({
  kind: "matched",
  requestsUsed: 1,
  characters: [],
  unreadRoot: true
});
```

```ts
// in the "no readable profile" test
expect(outcome).toEqual({
  kind: "matched",
  requestsUsed: 2,
  characters: [],
  unreadRoot: true
});
```

Then add a new test in the same `describe`, modelled on the existing historical-guild tests in that file (search it for `historicalGuilds`). Give one historical guild a roster that throws not-found:

```ts
it("counts a historical guild it could not read, and still matches the rest", async () => {
  // Break caught: a 404'd historical guild was silently skipped, so a
  // `matched` looked like a full read and would retract fingerprint links.
  const gateway = fingerprintGatewayWith({
    roster: [],
    historicalRosters: { "eu/draenor/gone": notFound() }
  });
  const outcome = await discoverFingerprintMatches(root, gateway, {
    ...baseOptions,
    historicalGuilds: [{ name: "Gone", region: "eu", realm: "draenor" }]
  });
  expect(outcome).toMatchObject({
    kind: "matched",
    skippedHistoricalGuilds: 1
  });
});
```

Use the file's existing helpers: its gateway fake, the not-found error constructor and its base options. Match their real names from the neighbouring historical-guild tests. If the fake has no per-guild roster map, extend it with one, keyed by `canonicalGuildId` (`region/realm/name`, lines 177-179).

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src/fingerprint-discovery.test.ts`
Expected: FAIL. The two 404 tests miss `unreadRoot`, and the new test misses `skippedHistoricalGuilds`.

- [ ] **Step 3: Implement**

In the `matched` variant of `FingerprintSweepOutcome` (lines 47-69), add:

```ts
  | {
      kind: "matched";
      characters: readonly DiscoveredCharacter[];
      requestsUsed: number;
      /** The root's own roster or profile answered not found, so nothing was
       * read to match against. Such a match proves no absence. */
      unreadRoot?: true;
      /** Historical guilds skipped because their roster answered not found. */
      skippedHistoricalGuilds?: number;
    }
```

At line 304 (the roster 404) and line 320 (the profile 404):

```ts
return { kind: "matched", characters: [], requestsUsed, unreadRoot: true };
```

At line 354, count the skip before continuing. Declare `let skippedHistoricalGuilds = 0;` alongside the other loop state before the historical-guild loop:

```ts
if (isNotFound(error)) {
  skippedHistoricalGuilds += 1;
  continue;
}
```

In every later `return { kind: "matched", … }` in the function, spread the count when it is non-zero:

```ts
...(skippedHistoricalGuilds > 0 ? { skippedHistoricalGuilds } : {})
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src/fingerprint-discovery.test.ts packages/blizzard/src/request-limiter.test.ts`
Expected: PASS. `request-limiter.test.ts:296-318` asserts only `kind: "matched"`, so it is unaffected. If it asserts an exact object with a root 404, add `unreadRoot: true` there too.

- [ ] **Step 5: Typecheck and commit**

```bash
corepack pnpm typecheck
git add packages/domain/src/fingerprint-discovery.ts packages/domain/src/fingerprint-discovery.test.ts packages/blizzard/src/request-limiter.test.ts
git commit -m "feat(domain): flag an unread root and skipped guilds on a fingerprint match (#738)" -m "A 404 on the root's roster or profile, or on a historical guild, returned the same matched outcome as a full read. Phase 1's ledger needs to tell them apart so such a match never retracts fingerprint links. Optional fields keep every existing outcome identical." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure connection rules in the domain package

**Files:**

- Create: `packages/domain/src/character-connections.ts`
- Create: `packages/domain/src/character-connections.test.ts`
- Modify: `packages/domain/src/index.ts`, to add `export * from "./character-connections";` beside the other module exports

**Interfaces:**

- Produces, used by Tasks 4, 5, 6, 9 and 10:
  - `ConnectionFamily`, `ObservationSource`, `LedgerDecision`, `LedgerReason`, `FamilyDecision`;
  - `familyOf`, `raiderIoDecision`, `fingerprintDecision`;
  - `Link`, `components`, `ExistingGroup`, `GroupAssignment`, `assignGroupIds`;
  - `LinkStrength`, `StrengthLink`, `pathStrengths`.

- [ ] **Step 1: Write the failing tests**

`packages/domain/src/character-connections.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  assignGroupIds,
  components,
  familyOf,
  fingerprintDecision,
  pathStrengths,
  raiderIoDecision
} from "./character-connections";

describe("source families", () => {
  it("puts every Raider.IO source in one family and fingerprint in its own", () => {
    expect(familyOf("claimed")).toBe("raiderio");
    expect(familyOf("declared_main")).toBe("raiderio");
    expect(familyOf("profile_guess")).toBe("raiderio");
    expect(familyOf("fingerprint")).toBe("fingerprint");
  });
});

describe("retraction decisions", () => {
  it("replaces Raider.IO links only when Raider.IO answered without a limitation", () => {
    expect(raiderIoDecision(null)).toEqual({
      decision: "replaced",
      reason: "raiderio_complete"
    });
    expect(raiderIoDecision("privacy_hidden")).toEqual({
      decision: "added_only",
      reason: "privacy_hidden"
    });
    expect(raiderIoDecision("request_cap")).toEqual({
      decision: "added_only",
      reason: "raiderio_limited"
    });
  });

  it("replaces fingerprint links only on a full-read match", () => {
    const full = {
      kind: "matched",
      unreadRoot: false,
      skippedHistoricalGuilds: 0
    } as const;
    expect(fingerprintDecision(full)).toEqual({
      decision: "replaced",
      reason: "matched"
    });
    expect(fingerprintDecision({ ...full, kind: "capped" })).toEqual({
      decision: "added_only",
      reason: "capped"
    });
    // Break caught: a 404 on the root read as an empty match and cut every link.
    expect(fingerprintDecision({ ...full, unreadRoot: true })).toEqual({
      decision: "added_only",
      reason: "unread"
    });
    expect(
      fingerprintDecision({ ...full, skippedHistoricalGuilds: 2 })
    ).toEqual({
      decision: "added_only",
      reason: "skipped_guild"
    });
  });
});

describe("components", () => {
  it("groups by reach and keeps lone nodes as their own component", () => {
    const parts = components(
      ["a", "b", "c", "d"],
      [
        { a: "a", b: "b" },
        { a: "b", b: "c" }
      ]
    );
    expect(parts).toEqual([["a", "b", "c"], ["d"]]);
  });
});

describe("group id survival", () => {
  const groups = new Map([
    ["g-old", { id: "g-old", createdAt: new Date("2026-09-01T00:00:00Z") }],
    ["g-new", { id: "g-new", createdAt: new Date("2026-09-20T00:00:00Z") }]
  ]);

  it("keeps the oldest id on a merge and deletes the other", () => {
    const membership = new Map([
      ["a", "g-old"],
      ["b", "g-new"]
    ]);
    const result = assignGroupIds([["a", "b"]], membership, groups);
    expect(result.assignments).toEqual([
      { groupId: "g-old", members: ["a", "b"] }
    ]);
    expect(result.deletedGroupIds).toEqual(["g-new"]);
  });

  it("gives the id to the larger part on a split, and a new group to the rest", () => {
    const membership = new Map([
      ["a", "g-old"],
      ["b", "g-old"],
      ["c", "g-old"]
    ]);
    const result = assignGroupIds([["a", "b"], ["c"]], membership, groups);
    expect(result.assignments).toEqual([
      { groupId: "g-old", members: ["a", "b"] },
      { groupId: null, members: ["c"] }
    ]);
    expect(result.deletedGroupIds).toEqual([]);
  });

  it("breaks an even split towards the part holding the lowest character id", () => {
    const membership = new Map([
      ["a", "g-old"],
      ["b", "g-old"]
    ]);
    const result = assignGroupIds([["b"], ["a"]], membership, groups);
    expect(result.assignments).toContainEqual({
      groupId: "g-old",
      members: ["a"]
    });
    expect(result.assignments).toContainEqual({
      groupId: null,
      members: ["b"]
    });
  });
});

describe("path strengths", () => {
  it("labels by the weakest provider link on the strongest path", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "f", strength: "fingerprint" },
      { a: "f", b: "c", strength: "raiderio" }
    ]);
    // Break caught: strongest-link-in-group labelled c Raider.IO-declared.
    expect(strengths.get("c")).toBe("fingerprint");
    expect(strengths.get("f")).toBe("fingerprint");
  });

  it("treats manual links as neutral, and a manual-only path as manual", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "t", strength: "manual" },
      { a: "t", b: "c", strength: "raiderio" }
    ]);
    expect(strengths.get("t")).toBe("manual");
    expect(strengths.get("c")).toBe("raiderio");
  });

  it("prefers any provider path to a manual-only one", () => {
    const strengths = pathStrengths("o", [
      { a: "o", b: "t", strength: "manual" },
      { a: "o", b: "t", strength: "fingerprint" }
    ]);
    expect(strengths.get("t")).toBe("fingerprint");
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src/character-connections.test.ts`
Expected: FAIL, with "Cannot find module './character-connections'".

- [ ] **Step 3: Implement**

`packages/domain/src/character-connections.ts`:

```ts
import type { DiscoverySource } from "./deduplicate";

/**
 * The two source families retraction is decided by (#738). A run can finish
 * one family's discovery and not the other's, so each is decided alone.
 */
export type ConnectionFamily = "raiderio" | "fingerprint";

/** A discovery source that names a link: every source but the root's own. */
export type ObservationSource = Exclude<DiscoverySource, "input">;

export type LedgerDecision = "added_only" | "replaced" | "blocked";

export type LedgerReason =
  | "raiderio_complete"
  | "raiderio_limited"
  | "privacy_hidden"
  | "capped"
  | "matched"
  | "unread"
  | "skipped_guild"
  | "live_sweep_completion"
  | "blocked_by_newer"
  | "backfill"
  | "rebuild";

export type FamilyDecision = Readonly<{
  decision: "added_only" | "replaced";
  reason: LedgerReason;
}>;

export function familyOf(source: ObservationSource): ConnectionFamily {
  return source === "fingerprint" ? "fingerprint" : "raiderio";
}

/**
 * Whether a run's own Raider.IO discovery may retract the observer's earlier
 * Raider.IO links. Only a discovery with no limitation proves an absence.
 */
export function raiderIoDecision(
  limitationCode: string | null
): FamilyDecision {
  if (limitationCode === null)
    return { decision: "replaced", reason: "raiderio_complete" };
  if (limitationCode === "privacy_hidden")
    return { decision: "added_only", reason: "privacy_hidden" };
  return { decision: "added_only", reason: "raiderio_limited" };
}

export type SweepFacts = Readonly<{
  kind: "matched" | "capped";
  unreadRoot: boolean;
  skippedHistoricalGuilds: number;
}>;

/**
 * Whether a sweep may retract the observer's earlier fingerprint links: only
 * a match that read every roster it set out to.
 */
export function fingerprintDecision(sweep: SweepFacts): FamilyDecision {
  if (sweep.kind === "capped")
    return { decision: "added_only", reason: "capped" };
  if (sweep.unreadRoot) return { decision: "added_only", reason: "unread" };
  if (sweep.skippedHistoricalGuilds > 0)
    return { decision: "added_only", reason: "skipped_guild" };
  return { decision: "replaced", reason: "matched" };
}

export type Link = Readonly<{ a: string; b: string }>;

/** Connected components by reach. Each is sorted; the list is sorted by first id. */
export function components(
  nodes: Iterable<string>,
  links: readonly Link[]
): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  for (const node of nodes) ensure(node);
  for (const link of links) {
    ensure(link.a);
    ensure(link.b);
    const left = find(link.a);
    const right = find(link.b);
    if (left !== right)
      parent.set(left < right ? right : left, left < right ? left : right);
  }
  const byRoot = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), id]);
  }
  return [...byRoot.values()]
    .map((members) => [...members].sort())
    .sort((left, right) => (left[0]! < right[0]! ? -1 : 1));
}

export type ExistingGroup = Readonly<{ id: string; createdAt: Date }>;

/** A recomputed component, and the group id it keeps; null means a new group. */
export type GroupAssignment = Readonly<{
  groupId: string | null;
  members: readonly string[];
}>;

/**
 * Which group each recomputed component keeps.
 * - A component may keep an old group only if it is that group's heir: the
 *   part holding most of its members, with ties going to the part holding
 *   its lowest member id.
 * - A component that is heir to several groups keeps the oldest; the rest
 *   are deleted.
 */
export function assignGroupIds(
  parts: readonly (readonly string[])[],
  membership: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, ExistingGroup>
): { assignments: GroupAssignment[]; deletedGroupIds: string[] } {
  const sorted = parts.map((members) => [...members].sort());
  const heirOf = new Map<string, number>();
  for (const groupId of new Set(
    sorted.flat().flatMap((id) => membership.get(id) ?? [])
  )) {
    let best = -1;
    let bestCount = -1;
    let bestLowest = "";
    sorted.forEach((members, index) => {
      const held = members.filter((id) => membership.get(id) === groupId);
      if (held.length === 0) return;
      const lowest = held[0]!;
      if (
        held.length > bestCount ||
        (held.length === bestCount && lowest < bestLowest)
      ) {
        best = index;
        bestCount = held.length;
        bestLowest = lowest;
      }
    });
    heirOf.set(groupId, best);
  }
  const kept = new Set<string>();
  const assignments = sorted.map((members, index) => {
    const candidates = [...heirOf.entries()]
      .filter(([, heir]) => heir === index)
      .map(([groupId]) => groups.get(groupId))
      .filter((group): group is ExistingGroup => group !== undefined)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          (left.id < right.id ? -1 : 1)
      );
    const keep = candidates[0]?.id ?? null;
    if (keep) kept.add(keep);
    return { groupId: keep, members };
  });
  const deletedGroupIds = [...heirOf.keys()]
    .filter((groupId) => !kept.has(groupId))
    .sort();
  return { assignments, deletedGroupIds };
}

export type LinkStrength = "raiderio" | "fingerprint" | "manual";
export type StrengthLink = Readonly<{
  a: string;
  b: string;
  strength: LinkStrength;
}>;

/**
 * Each reachable node's label strength seen from `origin` (#738).
 * - A path's strength is its weakest provider link.
 * - Manual links are neutral, and a path of manual links only is "manual".
 * - A node's strength is its best path, ranked Raider.IO, then fingerprint,
 *   then manual-only.
 *
 * A manual-only prefix can still become Raider.IO beyond it, so the search
 * runs over (node, value) states, never over nodes alone.
 */
export function pathStrengths(
  origin: string,
  links: readonly StrengthLink[]
): Map<string, LinkStrength> {
  // 3 = no provider link yet (neutral); 2 = Raider.IO; 1 = fingerprint.
  const rank = { manual: 3, raiderio: 2, fingerprint: 1 } as const;
  const neighbours = new Map<string, { to: string; rank: number }[]>();
  for (const link of links) {
    for (const [from, to] of [
      [link.a, link.b],
      [link.b, link.a]
    ] as const) {
      neighbours.set(from, [
        ...(neighbours.get(from) ?? []),
        { to, rank: rank[link.strength] }
      ]);
    }
  }
  const seen = new Set<string>([`${origin}\0${3}`]);
  const values = new Map<string, Set<number>>();
  const queue: [string, number][] = [[origin, 3]];
  while (queue.length > 0) {
    const [node, value] = queue.shift()!;
    for (const edge of neighbours.get(node) ?? []) {
      const next = Math.min(value, edge.rank);
      const state = `${edge.to}\0${next}`;
      if (seen.has(state)) continue;
      seen.add(state);
      values.set(edge.to, new Set([...(values.get(edge.to) ?? []), next]));
      queue.push([edge.to, next]);
    }
  }
  const result = new Map<string, LinkStrength>();
  for (const [node, reachable] of values) {
    if (node === origin) continue;
    result.set(
      node,
      reachable.has(2)
        ? "raiderio"
        : reachable.has(1)
          ? "fingerprint"
          : "manual"
    );
  }
  return result;
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/domain/src/character-connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint and commit**

```bash
corepack pnpm typecheck && corepack pnpm lint
git add packages/domain/src/character-connections.ts packages/domain/src/character-connections.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): character connection rules for groups (#738)" -m "Source families, per-family retraction decisions, connected components, group id survival and path-based label strengths, all pure so the writer, the replay and phase 2 share one definition." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0067 and schema

**Files:**

- Create: `packages/database/drizzle/0067_character_groups.sql`
- Modify: `packages/database/drizzle/meta/_journal.json`
- Modify: `packages/database/src/schema.ts`, placing the new tables after `snapshotCharacters`
- Modify: `tests/integration/migrations.test.ts`, lines 40-86 (the table list) and 175-225 (the journal slice)
- Modify: `tests/integration/repository-fixtures.ts:31-60` (the `TRUNCATE` list)

**Interfaces:**

- Produces these tables and columns, used by every later task:
  - `character_connections(id, character_low_id, character_high_id, kind, source, observed_from_character_id, discovery_run_id, observed_at, rejection_id, rejected_from_character_id)`
  - `character_groups(id, created_at, recomputed_at)`
  - `character_group_members(character_id, group_id)`
  - `character_connection_writes(observer_character_id, family, run_id, run_started_at)`
  - `character_connection_write_log(id, run_id, sweep_reservation_id, observer_character_id, family, decision, reason, run_started_at, written_at)`
  - `character_groups_maintenance(id, cursor_group_id, cycle_started_at, last_cycle_started_at, last_cycle_completed_at)`

- [ ] **Step 1: Update the migration test first**

In `tests/integration/migrations.test.ts`:

- **The table list.** Add these six names to the `toEqual([...])` list of public tables at lines 40-86, in the same order as the existing list, which is the database's `ORDER BY tablename` collation:
  - `character_connection_write_log`
  - `character_connection_writes`
  - `character_connections`
  - `character_group_members`
  - `character_groups`
  - `character_groups_maintenance`

  If the collation orders underscores differently from plain byte order, the failing run's diff shows the true order: copy it.

- **The journal slice.** In the test at lines 175-225, change `journal.entries.slice(-35)` to `slice(-36)`, and append `{ idx: 66, tag: "0067_character_groups" }` to the expected array.

Then add a new test in the same file, after the journal test:

```ts
it("backfills character groups from today's snapshots without touching them", async () => {
  // Break caught: a backfill that rewrote snapshots, or grouped a
  // snapshot member apart from its root, would fail P1 and P2 on deploy.
  const { pool, stop } = await startPostgres();
  try {
    await runMigrationsThrough(pool, "0066_raiderio_logged_kills");
    const root = await insertCharacter(pool, "eu", "draenor", "quellaria");
    const alt = await insertCharacter(pool, "eu", "draenor", "eundariel");
    const fp = await insertCharacter(pool, "eu", "draenor", "drecthyr");
    const run = await insertCompletedRun(pool, root);
    await insertSnapshot(pool, run, root, [
      [root, "input"],
      [alt, "declared_main"],
      [fp, "fingerprint"]
    ]);
    await insertPublishedReservation(pool, run);
    const before = await checksum(pool, [
      "snapshots",
      "snapshot_characters",
      "discovery_runs",
      "characters"
    ]);

    await runMigrations(pool);

    expect(
      await checksum(pool, [
        "snapshots",
        "snapshot_characters",
        "discovery_runs",
        "characters"
      ])
    ).toBe(before);
    const groups = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT group_id)::text AS n FROM character_group_members WHERE character_id = ANY($1)`,
      [[root, alt, fp]]
    );
    expect(groups.rows[0]!.n).toBe("1");
    const ledger = await pool.query(
      `SELECT family, decision, reason FROM character_connection_write_log ORDER BY family`
    );
    expect(ledger.rows).toEqual([
      { family: "fingerprint", decision: "replaced", reason: "backfill" },
      { family: "raiderio", decision: "replaced", reason: "backfill" }
    ]);
  } finally {
    await stop();
  }
});
```

Write the helpers at the bottom of the file, or reuse any that already exist there. Other tests in this file copy migrations up to a fixed number, at lines 432-443, 538-549 and 610-622: reuse that mechanism for `runMigrationsThrough`.

```ts
async function insertCharacter(
  pool: Pool,
  region: string,
  realm: string,
  name: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO characters (region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url)
     VALUES ($1, $2, $3, $3, 'Mage', 80, 'https://raider.io/x') RETURNING id`,
    [region, realm, name]
  );
  return result.rows[0]!.id;
}
async function insertCompletedRun(pool: Pool, rootId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO discovery_runs (root_region, root_realm_slug, root_normalized_name, root_character_id, status, caller_class, started_at, completed_at)
     SELECT region, realm_slug, normalized_name, id, 'complete', 'anonymous', now() - interval '1 hour', now() FROM characters WHERE id = $1 RETURNING id`,
    [rootId]
  );
  return result.rows[0]!.id;
}
async function insertSnapshot(
  pool: Pool,
  runId: string,
  rootId: string,
  members: [string, string][]
): Promise<void> {
  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO snapshots (root_character_id, discovery_run_id, state, limitation_code, refreshed_at, character_count)
     VALUES ($1, $2, 'complete', NULL, now(), $3) RETURNING id`,
    [rootId, runId, members.length]
  );
  await pool.query(`UPDATE discovery_runs SET snapshot_id = $2 WHERE id = $1`, [
    runId,
    snapshot.rows[0]!.id
  ]);
  for (const [index, [characterId, source]] of members.entries()) {
    await pool.query(
      `INSERT INTO snapshot_characters (snapshot_id, character_id, display_order, discovery_source, display_name, class_name, level, raider_io_url)
       VALUES ($1, $2, $3, $4, 'x', 'Mage', 80, 'https://raider.io/x')`,
      [snapshot.rows[0]!.id, characterId, index, source]
    );
  }
}
async function insertPublishedReservation(
  pool: Pool,
  runId: string
): Promise<void> {
  const admission = await pool.query<{ id: string }>(
    `INSERT INTO fingerprint_sweep_admissions (discovery_run_id, region, realm_slug, normalized_name, request_cap, hourly_budget, cadence_cutoff, status)
     SELECT id, root_region, root_realm_slug, root_normalized_name, 300, 28800, now(), 'finished' FROM discovery_runs WHERE id = $1 RETURNING id`,
    [runId]
  );
  await pool.query(
    `INSERT INTO fingerprint_sweep_reservations (admission_id, request_cap, admitted_at, expires_at, released_at, finished_at, published)
     VALUES ($1, 300, now() - interval '1 hour', now() + interval '1 hour', now(), now(), true)`,
    [admission.rows[0]!.id]
  );
}
async function checksum(pool: Pool, tables: string[]): Promise<string> {
  const parts: string[] = [];
  for (const table of tables) {
    const result = await pool.query<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${table} t`
    );
    parts.push(result.rows[0]!.digest);
  }
  return parts.join(":");
}
```

- [ ] **Step 2: Run the migration test and see it fail**

Run: `corepack pnpm exec vitest run --project integration tests/integration/migrations.test.ts`
Expected: FAIL. The table list and journal slice differ, and the new test finds no `character_group_members`.

- [ ] **Step 3: Write the migration**

`packages/database/drizzle/0067_character_groups.sql`. Statements are separated by `--> statement-breakpoint`, column lines are tab-indented, and each table gets a comment block. For the column-by-column rationale, see the spec's Tables section.

```sql
-- Character groups, phase 1 (#738). Discovery's observed links, a ledger of
-- what each publication decided, and the groups those links form. Nothing
-- reads these tables until phase 2; the worker writes them best effort after
-- each publication, and a replay compares them with today's dossiers.
--
-- They hold character ids, run and reservation ids, enum values and times
-- only. No existing table is altered, and no existing row is written.
CREATE TABLE "character_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_low_id" uuid NOT NULL,
	"character_high_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text,
	"observed_from_character_id" uuid,
	"discovery_run_id" uuid,
	"observed_at" timestamp with time zone NOT NULL,
	"rejection_id" uuid,
	"rejected_from_character_id" uuid,
	CONSTRAINT "character_connections_order_check" CHECK ("character_low_id" < "character_high_id"),
	CONSTRAINT "character_connections_kind_check" CHECK (("kind" = 'observed' AND "source" IN ('claimed', 'declared_main', 'profile_guess', 'fingerprint') AND "observed_from_character_id" IN ("character_low_id", "character_high_id") AND "discovery_run_id" IS NOT NULL AND "rejection_id" IS NULL AND "rejected_from_character_id" IS NULL) OR ("kind" = 'rejected' AND "source" IS NULL AND "observed_from_character_id" IS NULL AND "discovery_run_id" IS NULL AND "rejection_id" IS NOT NULL AND "rejected_from_character_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "character_connections" ADD CONSTRAINT "character_connections_low_fk" FOREIGN KEY ("character_low_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "character_connections" ADD CONSTRAINT "character_connections_high_fk" FOREIGN KEY ("character_high_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "character_connections_observation_idx" ON "character_connections" ("character_low_id", "character_high_id", "source", "observed_from_character_id") WHERE "kind" = 'observed';
--> statement-breakpoint
CREATE UNIQUE INDEX "character_connections_rejection_idx" ON "character_connections" ("character_low_id", "character_high_id", "rejection_id") WHERE "kind" = 'rejected';
--> statement-breakpoint
CREATE INDEX "character_connections_high_idx" ON "character_connections" ("character_high_id");
--> statement-breakpoint
CREATE INDEX "character_connections_observer_idx" ON "character_connections" ("observed_from_character_id", "source") WHERE "kind" = 'observed';
--> statement-breakpoint
-- A group is the characters counting links reach. `recomputed_at` is when its
-- membership was last recomputed, so the replay can tell a write still waiting
-- for its recompute from real drift.
CREATE TABLE "character_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recomputed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_group_members" (
	"character_id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_character_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "character_group_members" ADD CONSTRAINT "character_group_members_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."character_groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "character_group_members_group_idx" ON "character_group_members" ("group_id");
--> statement-breakpoint
-- The newest write per observer and source family. It only moves forward, and
-- it is what stops a delayed, older write from undoing a newer one.
CREATE TABLE "character_connection_writes" (
	"observer_character_id" uuid NOT NULL,
	"family" text NOT NULL,
	"run_id" uuid NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "character_connection_writes_pk" PRIMARY KEY("observer_character_id","family"),
	CONSTRAINT "character_connection_writes_family_check" CHECK ("family" IN ('raiderio', 'fingerprint'))
);
--> statement-breakpoint
ALTER TABLE "character_connection_writes" ADD CONSTRAINT "character_connection_writes_observer_fk" FOREIGN KEY ("observer_character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- One append-only row per publication per family, written in the same
-- transaction as its observations, so a row exists exactly when the write
-- committed. The replay reads the decision and reason from here, never
-- infers them.
CREATE TABLE "character_connection_write_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sweep_reservation_id" uuid,
	"observer_character_id" uuid NOT NULL,
	"family" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_connection_write_log_family_check" CHECK ("family" IN ('raiderio', 'fingerprint')),
	CONSTRAINT "character_connection_write_log_decision_check" CHECK ("decision" IN ('added_only', 'replaced', 'blocked')),
	CONSTRAINT "character_connection_write_log_reason_check" CHECK ("reason" IN ('raiderio_complete', 'raiderio_limited', 'privacy_hidden', 'capped', 'matched', 'unread', 'skipped_guild', 'live_sweep_completion', 'blocked_by_newer', 'backfill', 'rebuild'))
);
--> statement-breakpoint
CREATE INDEX "character_connection_write_log_observer_idx" ON "character_connection_write_log" ("observer_character_id", "family", "run_started_at", "written_at");
--> statement-breakpoint
CREATE INDEX "character_connection_write_log_run_idx" ON "character_connection_write_log" ("run_id");
--> statement-breakpoint
CREATE INDEX "character_connection_write_log_reservation_idx" ON "character_connection_write_log" ("sweep_reservation_id");
--> statement-breakpoint
-- One row: the maintenance recompute's cursor, and when a full cycle last
-- started and completed, which is how the replay knows drift is final.
CREATE TABLE "character_groups_maintenance" (
	"id" smallint PRIMARY KEY NOT NULL,
	"cursor_group_id" uuid,
	"cycle_started_at" timestamp with time zone,
	"last_cycle_started_at" timestamp with time zone,
	"last_cycle_completed_at" timestamp with time zone,
	CONSTRAINT "character_groups_maintenance_singleton_check" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "character_groups_maintenance" ("id") VALUES (1);
--> statement-breakpoint
-- Backfill Raider.IO links from each root's latest completed snapshot. Raw
-- membership: suppression is applied when read, so it is not applied here.
WITH latest AS (
  SELECT DISTINCT ON (snapshot.root_character_id)
    snapshot.id, snapshot.root_character_id, snapshot.discovery_run_id, snapshot.refreshed_at
  FROM snapshots snapshot
  JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
  ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC
)
INSERT INTO "character_connections" ("character_low_id", "character_high_id", "kind", "source", "observed_from_character_id", "discovery_run_id", "observed_at")
SELECT LEAST(latest.root_character_id, member.character_id), GREATEST(latest.root_character_id, member.character_id),
       'observed', member.discovery_source::text, latest.root_character_id, latest.discovery_run_id, latest.refreshed_at
FROM latest
JOIN snapshot_characters member ON member.snapshot_id = latest.id
WHERE member.character_id <> latest.root_character_id
  AND member.discovery_source::text IN ('claimed', 'declared_main', 'profile_guess');
--> statement-breakpoint
-- Backfill fingerprint links from each root's latest completed snapshot whose
-- run published a sweep. A later not_due refresh does not cut them, as the
-- retraction rule says, so a root whose latest snapshot dropped fingerprint
-- members through a not_due refresh gets them back.
WITH swept AS (
  SELECT DISTINCT ON (snapshot.root_character_id)
    snapshot.id, snapshot.root_character_id, snapshot.discovery_run_id, snapshot.refreshed_at
  FROM snapshots snapshot
  JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
  WHERE EXISTS (
    SELECT 1 FROM fingerprint_sweep_admissions admission
    JOIN fingerprint_sweep_reservations reservation ON reservation.admission_id = admission.id
    WHERE admission.discovery_run_id = snapshot.discovery_run_id AND reservation.published
  )
  ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC
)
INSERT INTO "character_connections" ("character_low_id", "character_high_id", "kind", "source", "observed_from_character_id", "discovery_run_id", "observed_at")
SELECT LEAST(swept.root_character_id, member.character_id), GREATEST(swept.root_character_id, member.character_id),
       'observed', 'fingerprint', swept.root_character_id, swept.discovery_run_id, swept.refreshed_at
FROM swept
JOIN snapshot_characters member ON member.snapshot_id = swept.id
WHERE member.character_id <> swept.root_character_id AND member.discovery_source::text = 'fingerprint';
--> statement-breakpoint
-- The marker and one `replaced` backfill ledger row per root and family, under
-- the run whose snapshot that family's rows came from.
WITH latest AS (
  SELECT DISTINCT ON (snapshot.root_character_id) snapshot.root_character_id, snapshot.discovery_run_id
  FROM snapshots snapshot
  JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
  ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC
), swept AS (
  SELECT DISTINCT ON (snapshot.root_character_id) snapshot.root_character_id, snapshot.discovery_run_id,
    (SELECT reservation.id FROM fingerprint_sweep_admissions admission
       JOIN fingerprint_sweep_reservations reservation ON reservation.admission_id = admission.id
      WHERE admission.discovery_run_id = snapshot.discovery_run_id AND reservation.published
      ORDER BY reservation.finished_at DESC NULLS LAST LIMIT 1) AS reservation_id
  FROM snapshots snapshot
  JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
  WHERE EXISTS (
    SELECT 1 FROM fingerprint_sweep_admissions admission
    JOIN fingerprint_sweep_reservations reservation ON reservation.admission_id = admission.id
    WHERE admission.discovery_run_id = snapshot.discovery_run_id AND reservation.published
  )
  ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC
), families AS (
  SELECT root_character_id, 'raiderio'::text AS family, discovery_run_id, NULL::uuid AS reservation_id FROM latest
  UNION ALL
  SELECT root_character_id, 'fingerprint', discovery_run_id, reservation_id FROM swept
), with_start AS (
  SELECT families.*, COALESCE(run.started_at, run.created_at) AS run_started_at
  FROM families JOIN discovery_runs run ON run.id = families.discovery_run_id
), marker AS (
  INSERT INTO "character_connection_writes" ("observer_character_id", "family", "run_id", "run_started_at")
  SELECT root_character_id, family, discovery_run_id, run_started_at FROM with_start
)
INSERT INTO "character_connection_write_log" ("run_id", "sweep_reservation_id", "observer_character_id", "family", "decision", "reason", "run_started_at")
SELECT discovery_run_id, reservation_id, root_character_id, family, 'replaced', 'backfill', run_started_at FROM with_start;
--> statement-breakpoint
-- Groups: components over the backfilled links and every resolved manual
-- connection, excluded or not. Every character gets a group; a group's id is
-- its lowest member's id, which is stable and needs no mapping table.
WITH RECURSIVE edges AS (
  SELECT character_low_id AS a, character_high_id AS b FROM character_connections WHERE kind = 'observed'
  UNION
  SELECT manual.root_character_id, target.id
  FROM manual_dossier_connections manual
  JOIN characters target ON target.region = manual.connected_region
    AND target.realm_slug = manual.connected_realm_slug
    AND target.normalized_name = manual.connected_normalized_name
  WHERE target.id <> manual.root_character_id
), undirected AS (
  SELECT a, b FROM edges UNION SELECT b, a FROM edges
), reach(start, node) AS (
  SELECT id, id FROM characters
  UNION
  SELECT reach.start, undirected.b FROM reach JOIN undirected ON undirected.a = reach.node
), labelled AS (
  SELECT start AS character_id, min(node::text)::uuid AS group_id FROM reach GROUP BY start
), inserted AS (
  INSERT INTO "character_groups" ("id") SELECT DISTINCT group_id FROM labelled RETURNING id
)
INSERT INTO "character_group_members" ("character_id", "group_id")
SELECT labelled.character_id, labelled.group_id FROM labelled JOIN inserted ON inserted.id = labelled.group_id;
--> statement-breakpoint
-- Sanity check on the query above, not the real check (that is the replay):
-- every latest-snapshot member and every resolved manual target shares its
-- root's group. A failure rolls back only this migration.
DO $$
DECLARE stray integer;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (snapshot.root_character_id) snapshot.id, snapshot.root_character_id
    FROM snapshots snapshot
    JOIN discovery_runs run ON run.id = snapshot.discovery_run_id AND run.status = 'complete'
    ORDER BY snapshot.root_character_id, snapshot.refreshed_at DESC, snapshot.id DESC
  ), pairs AS (
    SELECT latest.root_character_id AS root, member.character_id AS other
    FROM latest JOIN snapshot_characters member ON member.snapshot_id = latest.id
    UNION ALL
    SELECT manual.root_character_id, target.id
    FROM manual_dossier_connections manual
    JOIN characters target ON target.region = manual.connected_region
      AND target.realm_slug = manual.connected_realm_slug
      AND target.normalized_name = manual.connected_normalized_name
  )
  SELECT count(*) INTO stray
  FROM pairs
  JOIN character_group_members root_group ON root_group.character_id = pairs.root
  JOIN character_group_members other_group ON other_group.character_id = pairs.other
  WHERE root_group.group_id <> other_group.group_id;
  IF stray > 0 THEN
    RAISE EXCEPTION 'character_groups_backfill_stray_members: %', stray;
  END IF;
END $$;
```

The reach query is quadratic in group size. It is fine for test (218 characters, largest group 23) and for the current scale.

- [ ] **Step 4: Add the journal entry**

Append to `packages/database/drizzle/meta/_journal.json`:

```json
{
  "idx": 66,
  "version": "7",
  "when": 1792011600018,
  "tag": "0067_character_groups",
  "breakpoints": true
}
```

- [ ] **Step 5: Add the `pgTable`s to `schema.ts`**

After `snapshotCharacters`, add these tables, with a JSDoc on each pointing at the migration comment:

```ts
/** Discovery's observed links and reviewers' rejections (#738). See 0067. */
export const characterConnections = pgTable(
  "character_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    characterLowId: uuid("character_low_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    characterHighId: uuid("character_high_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    source: text("source"),
    observedFromCharacterId: uuid("observed_from_character_id"),
    discoveryRunId: uuid("discovery_run_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    rejectionId: uuid("rejection_id"),
    rejectedFromCharacterId: uuid("rejected_from_character_id")
  },
  (table) => [
    check(
      "character_connections_order_check",
      sql`${table.characterLowId} < ${table.characterHighId}`
    ),
    uniqueIndex("character_connections_observation_idx")
      .on(
        table.characterLowId,
        table.characterHighId,
        table.source,
        table.observedFromCharacterId
      )
      .where(sql`${table.kind} = 'observed'`),
    uniqueIndex("character_connections_rejection_idx")
      .on(table.characterLowId, table.characterHighId, table.rejectionId)
      .where(sql`${table.kind} = 'rejected'`),
    index("character_connections_high_idx").on(table.characterHighId),
    index("character_connections_observer_idx")
      .on(table.observedFromCharacterId, table.source)
      .where(sql`${table.kind} = 'observed'`)
  ]
);

/** The groups counting links form (#738). See 0067. */
export const characterGroups = pgTable("character_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  recomputedAt: timestamp("recomputed_at", { withTimezone: true })
    .defaultNow()
    .notNull()
});

export const characterGroupMembers = pgTable(
  "character_group_members",
  {
    characterId: uuid("character_id")
      .primaryKey()
      .references(() => characters.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => characterGroups.id, { onDelete: "cascade" })
  },
  (table) => [index("character_group_members_group_idx").on(table.groupId)]
);

/** The newest write per observer and family; only moves forward (#738). */
export const characterConnectionWrites = pgTable(
  "character_connection_writes",
  {
    observerCharacterId: uuid("observer_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    family: text("family").notNull(),
    runId: uuid("run_id").notNull(),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({
      name: "character_connection_writes_pk",
      columns: [table.observerCharacterId, table.family]
    }),
    check(
      "character_connection_writes_family_check",
      sql`${table.family} in ('raiderio', 'fingerprint')`
    )
  ]
);

/** One append-only row per publication per family (#738). See 0067. */
export const characterConnectionWriteLog = pgTable(
  "character_connection_write_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull(),
    sweepReservationId: uuid("sweep_reservation_id"),
    observerCharacterId: uuid("observer_character_id").notNull(),
    family: text("family").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }).notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index("character_connection_write_log_observer_idx").on(
      table.observerCharacterId,
      table.family,
      table.runStartedAt,
      table.writtenAt
    ),
    index("character_connection_write_log_run_idx").on(table.runId),
    index("character_connection_write_log_reservation_idx").on(
      table.sweepReservationId
    )
  ]
);

/** The maintenance recompute's cursor and cycle times; one row (#738). */
export const characterGroupsMaintenance = pgTable(
  "character_groups_maintenance",
  {
    id: integer("id").primaryKey(),
    cursorGroupId: uuid("cursor_group_id"),
    cycleStartedAt: timestamp("cycle_started_at", { withTimezone: true }),
    lastCycleStartedAt: timestamp("last_cycle_started_at", {
      withTimezone: true
    }),
    lastCycleCompletedAt: timestamp("last_cycle_completed_at", {
      withTimezone: true
    })
  }
);
```

- [ ] **Step 6: Add the new tables to the test truncate list**

In `tests/integration/repository-fixtures.ts:31-60`, add these four to the `TRUNCATE TABLE … CASCADE` list:

- `character_connection_write_log`
- `character_connection_writes`
- `character_connections`
- `character_groups`

`character_group_members` cascades from `character_groups`. Do not truncate `character_groups_maintenance`; instead add after the truncate:

```ts
await pool.query(
  `UPDATE character_groups_maintenance SET cursor_group_id = NULL, cycle_started_at = NULL, last_cycle_started_at = NULL, last_cycle_completed_at = NULL`
);
```

- [ ] **Step 7: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/database/src/migration-journal.test.ts`
Then: `corepack pnpm exec vitest run --project integration tests/integration/migrations.test.ts`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/database/drizzle/0067_character_groups.sql packages/database/drizzle/meta/_journal.json packages/database/src/schema.ts tests/integration/migrations.test.ts tests/integration/repository-fixtures.ts
git commit -m "feat(database): character groups tables and backfill (#738)" -m "Six new tables: observations, groups and their members, the per-family write marker, the append-only write ledger, and the maintenance cursor. The backfill reads today's snapshots and manual connections and writes nothing else." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `writeObservations`

**Files:**

- Modify: `packages/database/src/repositories.ts`, adding the interface and an optional key on `Repositories` at lines 1914-1956
- Create: `packages/database/src/character-connections.ts`
- Modify: `packages/database/src/postgres-repositories.ts`, spreading `...createCharacterConnectionRepositories(pool)`
- Modify: `packages/database/src/index.ts`, exporting the types
- Create: `tests/integration/character-connections.test.ts`

**Interfaces:**

- Consumes: from Task 2, `ConnectionFamily`, `ObservationSource`, `LedgerReason`, `familyOf`.
- Produces, used by Tasks 5, 6, 7 and 11:

```ts
export interface FamilyObservationWrite {
  readonly family: ConnectionFamily;
  readonly decision: "added_only" | "replaced";
  readonly reason: LedgerReason;
  /** The run's published set for this family, before de-duplication. */
  readonly observed: readonly Readonly<{
    key: CharacterKey;
    source: ObservationSource;
  }>[];
  /** The sweep reservation for a fingerprint family write; null otherwise. */
  readonly sweepReservationId: string | null;
}
export interface ObservationWriteInput {
  readonly runId: string;
  readonly observerKey: CharacterKey;
  readonly families: readonly FamilyObservationWrite[];
}
export interface ObservationWriteResult {
  /** Characters whose counting links this write changed, observer included. */
  readonly changedCharacterIds: readonly string[];
  /** Observed keys with no `characters` row, which were skipped. */
  readonly unknownCharacters: number;
}
export interface CharacterConnectionRepository {
  writeObservations(
    input: ObservationWriteInput
  ): Promise<ObservationWriteResult>;
  recomputeGroupsOf(characterIds: readonly string[]): Promise<void>;
  recomputePass(input: {
    budgetMs: number;
  }): Promise<{ groupsRecomputed: number; cycleCompleted: boolean }>;
  rebuild(): Promise<{ observers: number; links: number; groups: number }>;
}
// On Repositories:
//   characterConnections?: CharacterConnectionRepository;
```

In this task, `recomputeGroupsOf`, `recomputePass` and `rebuild` throw `Error("not_implemented")`. Task 5 implements them.

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/character-connections.test.ts`:

```ts
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  observation,
  resetRepositoryTables,
  rootKey,
  altKey,
  startRepositoryDatabase
} from "./repository-fixtures";
import type { TestRepositories } from "./test-repositories";

const thirdKey = { region: "eu", realm: "draenor", name: "third" } as const;

describe("character connections: observation writes", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: TestRepositories;

  beforeAll(async () => {
    ({ pool, stop, repositories } = await startRepositoryDatabase());
  });
  beforeEach(async () => {
    await resetRepositoryTables(pool);
  });
  afterAll(async () => {
    await stop();
  });

  async function publishedRun(
    characters = [
      observation(rootKey, "Ryii"),
      observation(altKey, "Alt", "claimed"),
      observation(thirdKey, "Third", "claimed")
    ]
  ) {
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRunning(run.id);
    await repositories.snapshots.create({
      runId: run.id,
      rootKey,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characters
    });
    return run.id;
  }

  const connections = () => repositories.characterConnections!;

  it("records each observation, the marker and one ledger row per family", async () => {
    const runId = await publishedRun();
    const result = await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [
            { key: altKey, source: "claimed" },
            { key: thirdKey, source: "claimed" }
          ]
        }
      ]
    });
    expect(result.unknownCharacters).toBe(0);
    const rows = await pool.query(
      `SELECT source, kind FROM character_connections ORDER BY source`
    );
    expect(rows.rows).toEqual([
      { source: "claimed", kind: "observed" },
      { source: "claimed", kind: "observed" }
    ]);
    const ledger = await pool.query(
      `SELECT family, decision, reason FROM character_connection_write_log`
    );
    expect(ledger.rows).toEqual([
      { family: "raiderio", decision: "replaced", reason: "raiderio_complete" }
    ]);
    const marker = await pool.query(
      `SELECT family, run_id FROM character_connection_writes`
    );
    expect(marker.rows).toEqual([{ family: "raiderio", run_id: runId }]);
  });

  it("records both sources before de-duplication", async () => {
    // Break caught: de-duplicated input stored a character both sources found
    // as Raider.IO only, and presence failed for its fingerprint link.
    const runId = await publishedRun();
    await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "added_only",
          reason: "raiderio_limited",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        },
        {
          family: "fingerprint",
          decision: "added_only",
          reason: "capped",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "fingerprint" }]
        }
      ]
    });
    const rows = await pool.query(
      `SELECT source FROM character_connections ORDER BY source`
    );
    expect(rows.rows.map((row) => row.source)).toEqual([
      "claimed",
      "fingerprint"
    ]);
  });

  it("retracts only the family it replaces, and only rows older than the run", async () => {
    const first = await publishedRun();
    await connections().writeObservations({
      runId: first,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [
            { key: altKey, source: "claimed" },
            { key: thirdKey, source: "claimed" }
          ]
        },
        {
          family: "fingerprint",
          decision: "replaced",
          reason: "matched",
          sweepReservationId: null,
          observed: [{ key: thirdKey, source: "fingerprint" }]
        }
      ]
    });
    const second = await publishedRun([
      observation(rootKey, "Ryii"),
      observation(altKey, "Alt", "claimed")
    ]);
    await connections().writeObservations({
      runId: second,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    const rows = await pool.query(
      `SELECT source, discovery_run_id FROM character_connections ORDER BY source`
    );
    // third's claimed link is retracted; its fingerprint link is another family.
    expect(rows.rows).toEqual([
      { source: "claimed", discovery_run_id: second },
      { source: "fingerprint", discovery_run_id: first }
    ]);
  });

  it("blocks a delayed continuation after a newer sweep chain has written", async () => {
    // Break caught: a continuation committing late re-added links a newer
    // chain had retracted, and its seal could cut the newer chain's links.
    const older = await publishedRun();
    await pool.query(
      `UPDATE discovery_runs SET started_at = now() - interval '2 hours' WHERE id = $1`,
      [older]
    );
    const newer = await publishedRun([observation(rootKey, "Ryii")]);
    await connections().writeObservations({
      runId: newer,
      observerKey: rootKey,
      families: [
        {
          family: "fingerprint",
          decision: "replaced",
          reason: "matched",
          sweepReservationId: null,
          observed: []
        }
      ]
    });
    await connections().writeObservations({
      runId: older,
      observerKey: rootKey,
      families: [
        {
          family: "fingerprint",
          decision: "added_only",
          reason: "capped",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "fingerprint" }]
        }
      ]
    });
    expect(
      (await pool.query(`SELECT 1 FROM character_connections`)).rowCount
    ).toBe(0);
    const ledger = await pool.query(
      `SELECT run_id, decision, reason FROM character_connection_write_log ORDER BY id`
    );
    expect(ledger.rows).toEqual([
      { run_id: newer, decision: "replaced", reason: "matched" },
      { run_id: older, decision: "blocked", reason: "blocked_by_newer" }
    ]);
  });

  it("never lowers observed_at", async () => {
    const runId = await publishedRun();
    const write = {
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio" as const,
          decision: "added_only" as const,
          reason: "raiderio_limited" as const,
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" as const }]
        }
      ]
    };
    await connections().writeObservations(write);
    await pool.query(
      `UPDATE character_connections SET observed_at = now() + interval '1 day'`
    );
    await connections().writeObservations(write);
    const rows = await pool.query<{ ahead: boolean }>(
      `SELECT observed_at > now() AS ahead FROM character_connections`
    );
    expect(rows.rows[0]!.ahead).toBe(true);
  });

  it("skips keys with no character row and counts them", async () => {
    const runId = await publishedRun();
    const result = await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "added_only",
          reason: "live_sweep_completion",
          sweepReservationId: null,
          observed: [
            {
              key: { region: "eu", realm: "draenor", name: "nobody" },
              source: "claimed"
            }
          ]
        }
      ]
    });
    expect(result.unknownCharacters).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM characters WHERE normalized_name = 'nobody'`
        )
      ).rowCount
    ).toBe(0);
  });

  it("touches no existing table (P2)", async () => {
    const runId = await publishedRun();
    const before = await existingChecksum(pool);
    await connections().writeObservations({
      runId,
      observerKey: rootKey,
      families: [
        {
          family: "raiderio",
          decision: "replaced",
          reason: "raiderio_complete",
          sweepReservationId: null,
          observed: [{ key: altKey, source: "claimed" }]
        }
      ]
    });
    expect(await existingChecksum(pool)).toBe(before);
  });
});

/** Every existing table the writer must never write, ignoring clock columns. */
async function existingChecksum(pool: Pool): Promise<string> {
  const tables = [
    "snapshots",
    "snapshot_characters",
    "discovery_runs",
    "characters",
    "manual_dossier_connections",
    "dossier_character_exclusions",
    "fingerprint_sweep_states",
    "fingerprint_sweep_reservations",
    "fingerprint_sweep_admissions",
    "character_evidence_runs"
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`
    );
    parts.push(`${table}=${result.rows[0]!.n}`);
  }
  return parts.join(",");
}
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project integration tests/integration/character-connections.test.ts`
Expected: FAIL, because `repositories.characterConnections` is undefined.

- [ ] **Step 3: Add the interface**

In `packages/database/src/repositories.ts`, add the types from **Interfaces** above, importing the domain types:

```ts
import type {
  ConnectionFamily,
  LedgerReason,
  ObservationSource
} from "@slashwho/domain";
```

Add `characterConnections?: CharacterConnectionRepository;` to `Repositories`. It is optional, so `createMemoryRepositories()`, `search-service.test.ts` and `fingerprint-continuation-retry.test.ts` keep compiling. Export the new types from `packages/database/src/index.ts`.

- [ ] **Step 4: Implement `writeObservations`**

`packages/database/src/character-connections.ts`:

```ts
import type { Pool, PoolClient } from "pg";
import {
  canonicalCharacterId,
  familyOf,
  type CharacterKey
} from "@slashwho/domain";
import type {
  CharacterConnectionRepository,
  FamilyObservationWrite,
  ObservationWriteInput,
  Repositories
} from "./repositories";
import { lockRoot } from "./locks";
import { withTransaction } from "./sql";

/** Taken shared by every writer of the group tables; exclusive by the rebuild. */
export async function lockRebuildShared(client: PoolClient): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
    ["character-groups-rebuild"]
  );
}
export async function lockRebuildExclusive(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "character-groups-rebuild"
  ]);
}
/** Serialises every group recompute. Taken after any root lock, never before. */
export async function lockGroups(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    "character-groups"
  ]);
}

const LOCK_TIMEOUT = "5s";

export function createCharacterConnectionRepositories(
  pool: Pool
): Pick<Repositories, "characterConnections"> {
  const characterConnections: CharacterConnectionRepository = {
    async writeObservations(input) {
      return withTransaction(pool, async (client) => {
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await lockRebuildShared(client);
        await lockRoot(client, input.observerKey);
        const run = await client.query<{
          started_at: Date | null;
          created_at: Date;
        }>(`SELECT started_at, created_at FROM discovery_runs WHERE id = $1`, [
          input.runId
        ]);
        const runStartedAt = run.rows[0]?.started_at ?? run.rows[0]?.created_at;
        if (!runStartedAt) throw new Error("character_connections_run_missing");
        const ids = await characterIds(client, [
          input.observerKey,
          ...input.families.flatMap((family) =>
            family.observed.map((item) => item.key)
          )
        ]);
        const observerId = ids.get(canonicalCharacterId(input.observerKey));
        if (!observerId)
          throw new Error("character_connections_observer_missing");
        const changed = new Set<string>();
        let unknownCharacters = 0;
        for (const family of input.families) {
          const marker = await client.query<{ run_started_at: Date }>(
            `SELECT run_started_at FROM character_connection_writes WHERE observer_character_id = $1 AND family = $2`,
            [observerId, family.family]
          );
          const newer =
            marker.rows[0] && marker.rows[0].run_started_at > runStartedAt;
          if (newer) {
            await logWrite(
              client,
              input.runId,
              family,
              observerId,
              "blocked",
              "blocked_by_newer",
              runStartedAt
            );
            continue;
          }
          for (const item of family.observed) {
            if (familyOf(item.source) !== family.family)
              throw new Error("character_connections_family_mismatch");
            const otherId = ids.get(canonicalCharacterId(item.key));
            if (!otherId) {
              unknownCharacters += 1;
              continue;
            }
            if (otherId === observerId) continue;
            const inserted = await client.query(
              `INSERT INTO character_connections (character_low_id, character_high_id, kind, source, observed_from_character_id, discovery_run_id, observed_at)
               VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'observed', $3, $1, $4, now())
               ON CONFLICT (character_low_id, character_high_id, source, observed_from_character_id) WHERE kind = 'observed'
               DO UPDATE SET observed_at = GREATEST(character_connections.observed_at, EXCLUDED.observed_at),
                             discovery_run_id = CASE WHEN EXCLUDED.observed_at >= character_connections.observed_at
                                                     THEN EXCLUDED.discovery_run_id ELSE character_connections.discovery_run_id END
               RETURNING (xmax = 0) AS created`,
              [observerId, otherId, item.source, input.runId]
            );
            if (inserted.rows[0]?.created) {
              changed.add(observerId);
              changed.add(otherId);
            }
          }
          if (family.decision === "replaced") {
            const sources =
              family.family === "fingerprint"
                ? ["fingerprint"]
                : ["claimed", "declared_main", "profile_guess"];
            const removed = await client.query<{ low: string; high: string }>(
              `DELETE FROM character_connections
               WHERE kind = 'observed' AND observed_from_character_id = $1 AND source = ANY($2)
                 AND discovery_run_id <> $3 AND observed_at < $4
               RETURNING character_low_id AS low, character_high_id AS high`,
              [observerId, sources, input.runId, runStartedAt]
            );
            for (const row of removed.rows) {
              changed.add(row.low);
              changed.add(row.high);
            }
          }
          await client.query(
            `INSERT INTO character_connection_writes (observer_character_id, family, run_id, run_started_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (observer_character_id, family) DO UPDATE
               SET run_id = CASE WHEN EXCLUDED.run_started_at >= character_connection_writes.run_started_at
                                 THEN EXCLUDED.run_id ELSE character_connection_writes.run_id END,
                   run_started_at = GREATEST(character_connection_writes.run_started_at, EXCLUDED.run_started_at)`,
            [observerId, family.family, input.runId, runStartedAt]
          );
          await logWrite(
            client,
            input.runId,
            family,
            observerId,
            family.decision,
            family.reason,
            runStartedAt
          );
        }
        changed.add(observerId);
        return { changedCharacterIds: [...changed].sort(), unknownCharacters };
      });
    },
    async recomputeGroupsOf() {
      throw new Error("not_implemented");
    },
    async recomputePass() {
      throw new Error("not_implemented");
    },
    async rebuild() {
      throw new Error("not_implemented");
    }
  };
  return { characterConnections };
}

async function logWrite(
  client: PoolClient,
  runId: string,
  family: FamilyObservationWrite,
  observerId: string,
  decision: string,
  reason: string,
  runStartedAt: Date
): Promise<void> {
  await client.query(
    `INSERT INTO character_connection_write_log (run_id, sweep_reservation_id, observer_character_id, family, decision, reason, run_started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      runId,
      family.sweepReservationId,
      observerId,
      family.family,
      decision,
      reason,
      runStartedAt
    ]
  );
}

/** Existing character ids by canonical key. Never inserts (P2). */
export async function characterIds(
  client: PoolClient | Pool,
  keys: readonly CharacterKey[]
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const result = await client.query<{
    id: string;
    region: string;
    realm_slug: string;
    normalized_name: string;
  }>(
    `SELECT id, region, realm_slug, normalized_name FROM characters
     WHERE (region, realm_slug, normalized_name) IN (SELECT * FROM unnest($1::text[], $2::text[], $3::text[]))`,
    [
      keys.map((key) => key.region),
      keys.map((key) => key.realm),
      keys.map((key) => key.name)
    ]
  );
  return new Map(
    result.rows.map((row) => [
      canonicalCharacterId({
        region: row.region as CharacterKey["region"],
        realm: row.realm_slug,
        name: row.normalized_name
      }),
      row.id
    ])
  );
}
```

Check `canonicalCharacterId` lower-cases (it does, `deduplicate.ts:17-23`). Also check that `characters` stores `realm_slug` and `normalized_name` the same way `CharacterKey` carries them: `upsertCharacters` in `snapshots.ts:154-191` shows the mapping. If it normalises differently, apply the same normalisation here.

Spread `...createCharacterConnectionRepositories(pool)` in `createPostgresRepositories`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project integration tests/integration/character-connections.test.ts`
Expected: PASS, all seven.

- [ ] **Step 6: Commit**

```bash
corepack pnpm typecheck
git add packages/database/src/repositories.ts packages/database/src/character-connections.ts packages/database/src/postgres-repositories.ts packages/database/src/index.ts tests/integration/character-connections.test.ts
git commit -m "feat(database): record discovery observations with a monotone ledger (#738)" -m "One short transaction per publication writes its observations per source, the forward-only marker and one ledger row per family, under the rebuild lock (shared) and the observer's root lock, with a 5 s lock timeout. A delayed older write is blocked and logged, never applied." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Group recompute, the maintenance pass and the rebuild

**Files:**

- Modify: `packages/database/src/character-connections.ts`
- Modify: `tests/integration/character-connections.test.ts`

**Interfaces:**

- Consumes: `components` and `assignGroupIds` (Task 2); `lockGroups`, `lockRebuildShared`, `lockRebuildExclusive` and `characterIds` (Task 4).
- Produces: working `recomputeGroupsOf(characterIds)`, `recomputePass({ budgetMs })` and `rebuild()`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/character-connections.test.ts`, inside the `describe`:

```ts
async function groupOf(key: typeof rootKey): Promise<string | undefined> {
  const result = await pool.query<{ group_id: string }>(
    `SELECT member.group_id FROM character_group_members member JOIN characters c ON c.id = member.character_id
       WHERE c.region = $1 AND c.realm_slug = $2 AND c.normalized_name = $3`,
    [key.region, key.realm, key.name]
  );
  return result.rows[0]?.group_id;
}

it("merges into one group after a write, then splits when a link is retracted", async () => {
  const first = await publishedRun();
  const written = await connections().writeObservations({
    runId: first,
    observerKey: rootKey,
    families: [
      {
        family: "raiderio",
        decision: "replaced",
        reason: "raiderio_complete",
        sweepReservationId: null,
        observed: [
          { key: altKey, source: "claimed" },
          { key: thirdKey, source: "claimed" }
        ]
      }
    ]
  });
  await connections().recomputeGroupsOf(written.changedCharacterIds);
  expect(await groupOf(altKey)).toBe(await groupOf(rootKey));
  expect(await groupOf(thirdKey)).toBe(await groupOf(rootKey));

  const second = await publishedRun([
    observation(rootKey, "Ryii"),
    observation(altKey, "Alt", "claimed")
  ]);
  const retracted = await connections().writeObservations({
    runId: second,
    observerKey: rootKey,
    families: [
      {
        family: "raiderio",
        decision: "replaced",
        reason: "raiderio_complete",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      }
    ]
  });
  await connections().recomputeGroupsOf(retracted.changedCharacterIds);
  expect(await groupOf(thirdKey)).not.toBe(await groupOf(rootKey));
  const stamps = await pool.query<{ fresh: boolean }>(
    `SELECT recomputed_at >= now() - interval '1 minute' AS fresh FROM character_groups`
  );
  expect(stamps.rows.every((row) => row.fresh)).toBe(true);
});

it("counts a manual connection as a link, excluded or not", async () => {
  await publishedRun([observation(rootKey, "Ryii")]);
  await publishedRunFor(altKey);
  await repositories.manualConnections.add(rootKey, altKey);
  const ids = await pool.query<{ id: string }>(`SELECT id FROM characters`);
  await connections().recomputeGroupsOf(ids.rows.map((row) => row.id));
  expect(await groupOf(altKey)).toBe(await groupOf(rootKey));
});

it("recomputes every group in a pass, stops at its budget, and records a full cycle", async () => {
  await publishedRun();
  const first = await connections().recomputePass({ budgetMs: 30_000 });
  expect(first.cycleCompleted).toBe(true);
  const state = await pool.query(
    `SELECT cursor_group_id, last_cycle_completed_at IS NOT NULL AS completed, last_cycle_started_at <= last_cycle_completed_at AS ordered FROM character_groups_maintenance`
  );
  expect(state.rows[0]).toMatchObject({
    cursor_group_id: null,
    completed: true,
    ordered: true
  });
  const partial = await connections().recomputePass({ budgetMs: 0 });
  expect(partial.cycleCompleted).toBe(false);
});

it("rebuilds from snapshots under the exclusive lock, excluding concurrent writes", async () => {
  // Break caught: a write interleaving with the rebuild's delete and
  // re-insert left observations the ledger could not explain.
  const runId = await publishedRun();
  const hold = await pool.connect();
  try {
    await hold.query("BEGIN");
    await hold.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('character-groups-rebuild', 0))"
    );
    await expect(
      connections().writeObservations({
        runId,
        observerKey: rootKey,
        families: [
          {
            family: "raiderio",
            decision: "added_only",
            reason: "raiderio_limited",
            sweepReservationId: null,
            observed: [{ key: altKey, source: "claimed" }]
          }
        ]
      })
    ).rejects.toThrow(/lock timeout/);
  } finally {
    await hold.query("ROLLBACK");
    hold.release();
  }
  const rebuilt = await connections().rebuild();
  expect(rebuilt.groups).toBeGreaterThan(0);
  const ledger = await pool.query(
    `SELECT DISTINCT reason, decision FROM character_connection_write_log`
  );
  expect(ledger.rows).toContainEqual({
    reason: "rebuild",
    decision: "replaced"
  });
});
```

Add a helper to publish a run rooted at another key:

```ts
async function publishedRunFor(key: typeof altKey) {
  const run = await repositories.runs.createOrReuse(key, "anonymous");
  await repositories.runs.markRunning(run.id);
  await repositories.snapshots.create({
    runId: run.id,
    rootKey: key,
    state: "complete",
    limitationCode: null,
    refreshedAt: new Date(),
    characters: [observation(key, "Alt")]
  });
  return run.id;
}
```

`manualConnections.add(root, target)` already exists; the dossier service calls it at `applicant-dossier-service.ts:1554`. Check its exact signature in `small-stores.ts`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project integration tests/integration/character-connections.test.ts`
Expected: FAIL with `not_implemented`.

- [ ] **Step 3: Implement the recompute**

Replace the three `not_implemented` methods in `character-connections.ts`, and add the helpers:

```ts
    async recomputeGroupsOf(seedIds) {
      const done = new Set<string>();
      for (const seed of seedIds) {
        if (done.has(seed)) continue;
        const members = await withTransaction(pool, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          await lockRebuildShared(client);
          await lockGroups(client);
          return recomputeComponent(client, seed);
        });
        for (const id of members) done.add(id);
      }
    },

    async recomputePass({ budgetMs }) {
      const startedAt = Date.now();
      let groupsRecomputed = 0;
      for (;;) {
        const step = await withTransaction(pool, async (client) => {
          await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          await lockRebuildShared(client);
          await lockGroups(client);
          const state = await client.query<{ cursor_group_id: string | null }>(
            `UPDATE character_groups_maintenance
             SET cycle_started_at = COALESCE(cycle_started_at, now())
             WHERE id = 1 RETURNING cursor_group_id`
          );
          const cursor = state.rows[0]?.cursor_group_id ?? null;
          // Ungrouped characters first (new since the last pass), then groups in id order.
          const ungrouped = await client.query<{ id: string }>(
            `SELECT c.id FROM characters c LEFT JOIN character_group_members m ON m.character_id = c.id
             WHERE m.character_id IS NULL ORDER BY c.id LIMIT 1`
          );
          if (ungrouped.rows[0]) {
            await recomputeComponent(client, ungrouped.rows[0].id);
            return { done: false };
          }
          const next = await client.query<{ id: string; seed: string }>(
            `SELECT g.id, (SELECT character_id FROM character_group_members WHERE group_id = g.id ORDER BY character_id LIMIT 1) AS seed
             FROM character_groups g WHERE $1::uuid IS NULL OR g.id > $1::uuid ORDER BY g.id LIMIT 1`,
            [cursor]
          );
          const group = next.rows[0];
          if (!group) {
            await client.query(
              `UPDATE character_groups_maintenance
               SET last_cycle_started_at = cycle_started_at, last_cycle_completed_at = now(),
                   cycle_started_at = NULL, cursor_group_id = NULL
               WHERE id = 1`
            );
            return { done: true };
          }
          if (group.seed) await recomputeComponent(client, group.seed);
          await client.query(`UPDATE character_groups_maintenance SET cursor_group_id = $1 WHERE id = 1`, [group.id]);
          return { done: false };
        });
        if (step.done) return { groupsRecomputed, cycleCompleted: true };
        groupsRecomputed += 1;
        if (Date.now() - startedAt >= budgetMs) return { groupsRecomputed, cycleCompleted: false };
      }
    },

    async rebuild() {
      return withTransaction(pool, async (client) => {
        await lockRebuildExclusive(client);
        await lockGroups(client);
        await client.query(`DELETE FROM character_connections WHERE kind = 'observed'`);
        await client.query(`DELETE FROM character_connection_writes`);
        await client.query(`DELETE FROM character_groups`);
        await client.query(REBUILD_SQL.raiderio);
        await client.query(REBUILD_SQL.fingerprint);
        await client.query(REBUILD_SQL.markerAndLedger);
        await client.query(REBUILD_SQL.groups);
        const counts = await client.query<{ observers: string; links: string; groups: string }>(
          `SELECT (SELECT count(*) FROM character_connection_writes)::text AS observers,
                  (SELECT count(*) FROM character_connections WHERE kind = 'observed')::text AS links,
                  (SELECT count(*) FROM character_groups)::text AS groups`
        );
        const row = counts.rows[0]!;
        return { observers: Number(row.observers), links: Number(row.links), groups: Number(row.groups) };
      });
    }
```

Add the helpers:

```ts
/**
 * Recompute the component containing `seed`: load it through counting links,
 * split or merge against the stored groups, and write the result. Returns
 * every character visited.
 */
async function recomputeComponent(
  client: PoolClient,
  seed: string
): Promise<string[]> {
  const visited = new Set<string>([seed]);
  const links: { a: string; b: string }[] = [];
  let frontier = [seed];
  while (frontier.length > 0) {
    const edges = await client.query<{ a: string; b: string }>(
      COUNTING_LINKS_FROM,
      [frontier]
    );
    const next: string[] = [];
    for (const edge of edges.rows) {
      links.push(edge);
      for (const id of [edge.a, edge.b]) {
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }
  // The component may have been larger before: include the old group's other
  // members so a split assigns them too.
  const old = await client.query<{ character_id: string; group_id: string }>(
    `SELECT character_id, group_id FROM character_group_members
     WHERE group_id IN (SELECT group_id FROM character_group_members WHERE character_id = ANY($1))`,
    [[...visited]]
  );
  const nodes = new Set([
    ...visited,
    ...old.rows.map((row) => row.character_id)
  ]);
  const extraLinks = old.rows.some((row) => !visited.has(row.character_id))
    ? (
        await client.query<{ a: string; b: string }>(COUNTING_LINKS_FROM, [
          [...nodes].filter((id) => !visited.has(id))
        ])
      ).rows
    : [];
  const parts = components(
    nodes,
    [...links, ...extraLinks].filter(
      (link) => nodes.has(link.a) && nodes.has(link.b)
    )
  );
  const membership = new Map(
    old.rows.map((row) => [row.character_id, row.group_id])
  );
  const groupRows = await client.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM character_groups WHERE id = ANY($1)`,
    [[...new Set(membership.values())]]
  );
  const groups = new Map(
    groupRows.rows.map((row) => [
      row.id,
      { id: row.id, createdAt: row.created_at }
    ])
  );
  const { assignments, deletedGroupIds } = assignGroupIds(
    parts,
    membership,
    groups
  );
  for (const assignment of assignments) {
    const groupId =
      assignment.groupId ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO character_groups DEFAULT VALUES RETURNING id`
        )
      ).rows[0]!.id;
    await client.query(
      `UPDATE character_groups SET recomputed_at = now() WHERE id = $1`,
      [groupId]
    );
    await client.query(
      `INSERT INTO character_group_members (character_id, group_id) SELECT unnest($1::uuid[]), $2
       ON CONFLICT (character_id) DO UPDATE SET group_id = EXCLUDED.group_id`,
      [assignment.members, groupId]
    );
  }
  if (deletedGroupIds.length > 0) {
    await client.query(`DELETE FROM character_groups WHERE id = ANY($1)`, [
      deletedGroupIds
    ]);
  }
  return [...nodes];
}

/**
 * Counting links touching any of $1:
 * - observed links, except pairs that have a rejection row;
 * - every resolved manual connection, excluded or not.
 * In phase 1 nothing writes rejections; honouring them now keeps a phase 3
 * rollback safe.
 */
const COUNTING_LINKS_FROM = `
  SELECT connection.character_low_id AS a, connection.character_high_id AS b
  FROM character_connections connection
  WHERE connection.kind = 'observed'
    AND (connection.character_low_id = ANY($1) OR connection.character_high_id = ANY($1))
    AND NOT EXISTS (
      SELECT 1 FROM character_connections rejection
      WHERE rejection.kind = 'rejected'
        AND rejection.character_low_id = connection.character_low_id
        AND rejection.character_high_id = connection.character_high_id
    )
  UNION
  SELECT manual.root_character_id, target.id
  FROM manual_dossier_connections manual
  JOIN characters target ON target.region = manual.connected_region
    AND target.realm_slug = manual.connected_realm_slug
    AND target.normalized_name = manual.connected_normalized_name
  WHERE target.id <> manual.root_character_id
    AND (manual.root_character_id = ANY($1) OR target.id = ANY($1))`;
```

`REBUILD_SQL` holds four statements copied verbatim from the migration (Task 3, steps 3's backfill statements), with two changes:

- the marker-and-ledger statement writes reason `'rebuild'` instead of `'backfill'`;
- the groups statement's `INSERT INTO character_groups` uses `ON CONFLICT DO NOTHING`, and members use `ON CONFLICT (character_id) DO UPDATE SET group_id = EXCLUDED.group_id`.

Put them in `packages/database/src/character-groups-backfill-sql.ts` as exported constants. To keep the migration and the rebuild from drifting, add a unit test that reads the migration file and asserts it contains each constant with `rebuild` replaced by `backfill`:

```ts
// packages/database/src/character-groups-backfill-sql.test.ts
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { REBUILD_SQL } from "./character-groups-backfill-sql";

it("rebuilds with exactly the migration's backfill statements", () => {
  // Break caught: the rebuild and the migration drifted, so a rebuild left
  // groups the replay then called drift.
  const migration = readFileSync(
    new URL("../drizzle/0067_character_groups.sql", import.meta.url),
    "utf8"
  );
  expect(migration).toContain(REBUILD_SQL.raiderio.trim());
  expect(migration).toContain(REBUILD_SQL.fingerprint.trim());
  expect(migration).toContain(
    REBUILD_SQL.markerAndLedger.replace("'rebuild'", "'backfill'").trim()
  );
});
```

The groups statement differs only by its `ON CONFLICT` clauses, so it isn't compared.

- [ ] **Step 4: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project integration tests/integration/character-connections.test.ts`
Then: `corepack pnpm exec vitest run --project unit packages/database/src/character-groups-backfill-sql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/character-connections.ts packages/database/src/character-groups-backfill-sql.ts packages/database/src/character-groups-backfill-sql.test.ts tests/integration/character-connections.test.ts
git commit -m "feat(database): recompute character groups, a bounded maintenance pass and a rebuild (#738)" -m "Each component is recomputed in its own short transaction under the groups lock, with the id-survival rule from the domain. The pass walks groups by a stored cursor within a time budget and records each full cycle's start and end; the rebuild replays the migration's backfill under the exclusive rebuild lock." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The handler writes after each committed publication

**Files:**

- Create: `packages/application/src/observation-writes.ts`
- Create: `packages/application/src/observation-writes.test.ts`
- Modify: `packages/application/src/discovery-job-handler.ts`, adding the declaration beside `resume` at around L514-516 and four assignment points: after L693, after L874 (only when `amended !== null`), after L925, and after L1021. Extend the outer `finally` at L1126-1131.
- Modify: `packages/application/src/discovery-job-handler.test.ts`

**Interfaces:**

- Consumes: `ObservationWriteInput` and `CharacterConnectionRepository` (Task 4); `raiderIoDecision`, `fingerprintDecision` and `ObservationSource` (Task 2).
- Produces:

```ts
export function raiderIoPublicationWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  characters: readonly DiscoveredCharacter[];
  limitationCode: string | null;
}): ObservationWriteInput;
export function firstSweepCycleWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  raiderIoCharacters: readonly DiscoveredCharacter[];
  raiderIoLimitation: string | null;
  sweep: SweepForWrite;
  excludedTournamentIds: ReadonlySet<string>;
  reservationId: string;
}): ObservationWriteInput;
export function continuationCycleWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  sweep: SweepForWrite;
  reservationId: string;
}): ObservationWriteInput;
export function liveSweepCompletionWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  characters: readonly DiscoveredCharacter[];
}): ObservationWriteInput;
export type SweepForWrite = Readonly<{
  kind: "matched" | "capped";
  characters: readonly DiscoveredCharacter[];
  unreadRoot?: true;
  skippedHistoricalGuilds?: number;
}>;
```

- [ ] **Step 1: Write the failing unit tests for the builders**

`packages/application/src/observation-writes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DiscoveredCharacter } from "@slashwho/domain";
import {
  continuationCycleWrite,
  firstSweepCycleWrite,
  liveSweepCompletionWrite,
  raiderIoPublicationWrite
} from "./observation-writes";

const rootKey = { region: "eu", realm: "draenor", name: "root" } as const;
const altKey = { region: "eu", realm: "draenor", name: "alt" } as const;
const fpKey = { region: "eu", realm: "draenor", name: "fp" } as const;
const character = (
  key: typeof rootKey,
  source: DiscoveredCharacter["source"]
): DiscoveredCharacter => ({
  key,
  displayName: key.name,
  className: "Mage",
  level: 80,
  guild: null,
  raiderIoUrl: "https://raider.io/x",
  source
});

describe("observation writes", () => {
  it("records a Raider.IO publication without the root, replacing only when unlimited", () => {
    const write = raiderIoPublicationWrite({
      runId: "run",
      rootKey,
      limitationCode: null,
      characters: [character(rootKey, "input"), character(altKey, "claimed")]
    });
    expect(write.families).toEqual([
      {
        family: "raiderio",
        decision: "replaced",
        reason: "raiderio_complete",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      }
    ]);
    expect(
      raiderIoPublicationWrite({
        runId: "run",
        rootKey,
        limitationCode: "privacy_hidden",
        characters: []
      }).families[0]
    ).toMatchObject({ decision: "added_only", reason: "privacy_hidden" });
  });

  it("records both families on a first cycle, before de-duplication and after the tournament filter", () => {
    const write = firstSweepCycleWrite({
      runId: "run",
      rootKey,
      reservationId: "res",
      raiderIoLimitation: null,
      raiderIoCharacters: [
        character(rootKey, "input"),
        character(altKey, "claimed")
      ],
      sweep: {
        kind: "matched",
        characters: [
          character(altKey, "fingerprint"),
          character(fpKey, "fingerprint")
        ]
      },
      excludedTournamentIds: new Set([JSON.stringify(["eu", "draenor", "fp"])])
    });
    expect(write.families).toEqual([
      {
        family: "raiderio",
        decision: "replaced",
        reason: "raiderio_complete",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      },
      {
        family: "fingerprint",
        decision: "replaced",
        reason: "matched",
        sweepReservationId: "res",
        observed: [{ key: altKey, source: "fingerprint" }]
      }
    ]);
  });

  it("never touches the Raider.IO family on a continuation", () => {
    const write = continuationCycleWrite({
      runId: "run",
      rootKey,
      reservationId: "res",
      sweep: { kind: "capped", characters: [character(fpKey, "fingerprint")] }
    });
    expect(write.families.map((family) => family.family)).toEqual([
      "fingerprint"
    ]);
    expect(write.families[0]).toMatchObject({
      decision: "added_only",
      reason: "capped",
      sweepReservationId: "res"
    });
  });

  it("only adds on a live-sweep completion", () => {
    const write = liveSweepCompletionWrite({
      runId: "run",
      rootKey,
      characters: [character(rootKey, "input"), character(altKey, "claimed")]
    });
    expect(write.families).toEqual([
      {
        family: "raiderio",
        decision: "added_only",
        reason: "live_sweep_completion",
        sweepReservationId: null,
        observed: [{ key: altKey, source: "claimed" }]
      }
    ]);
  });
});
```

The tournament set's key format must match what the handler builds. At L910-913 it builds its set from `outcome.excludedTournamentCharacterIds` and compares with `canonicalCharacterId(character.key)`. Build the test's set with `canonicalCharacterId(fpKey)` rather than a hand-written string.

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/observation-writes.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement the builders**

`packages/application/src/observation-writes.ts`:

```ts
import {
  canonicalCharacterId,
  fingerprintDecision,
  raiderIoDecision,
  type CharacterKey,
  type DiscoveredCharacter,
  type ObservationSource
} from "@slashwho/domain";
import type {
  FamilyObservationWrite,
  ObservationWriteInput
} from "@slashwho/database";

export type SweepForWrite = Readonly<{
  kind: "matched" | "capped";
  characters: readonly DiscoveredCharacter[];
  unreadRoot?: true;
  skippedHistoricalGuilds?: number;
}>;

/** A run's characters as observations, minus the root itself. */
function observed(
  rootKey: CharacterKey,
  characters: readonly DiscoveredCharacter[]
) {
  const root = canonicalCharacterId(rootKey);
  return characters
    .filter(
      (character) =>
        character.source !== "input" &&
        canonicalCharacterId(character.key) !== root
    )
    .map((character) => ({
      key: character.key,
      source: character.source as ObservationSource
    }));
}

function raiderIoFamily(
  rootKey: CharacterKey,
  characters: readonly DiscoveredCharacter[],
  limitationCode: string | null
): FamilyObservationWrite {
  return {
    family: "raiderio",
    ...raiderIoDecision(limitationCode),
    sweepReservationId: null,
    observed: observed(rootKey, characters)
  };
}

function fingerprintFamily(
  rootKey: CharacterKey,
  sweep: SweepForWrite,
  characters: readonly DiscoveredCharacter[],
  reservationId: string
): FamilyObservationWrite {
  return {
    family: "fingerprint",
    ...fingerprintDecision({
      kind: sweep.kind,
      unreadRoot: sweep.unreadRoot === true,
      skippedHistoricalGuilds: sweep.skippedHistoricalGuilds ?? 0
    }),
    sweepReservationId: reservationId,
    observed: observed(rootKey, characters)
  };
}

/** `snapshots.create`: a Raider.IO-only publication, `not_due` or no sweep configured. */
export function raiderIoPublicationWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  characters: readonly DiscoveredCharacter[];
  limitationCode: string | null;
}): ObservationWriteInput {
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      raiderIoFamily(input.rootKey, input.characters, input.limitationCode)
    ]
  };
}

/** `createAndFinishFingerprintSweep`: cycle 1, both families. */
export function firstSweepCycleWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  raiderIoCharacters: readonly DiscoveredCharacter[];
  raiderIoLimitation: string | null;
  sweep: SweepForWrite;
  excludedTournamentIds: ReadonlySet<string>;
  reservationId: string;
}): ObservationWriteInput {
  const matches = input.sweep.characters.filter(
    (character) =>
      !input.excludedTournamentIds.has(canonicalCharacterId(character.key))
  );
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      raiderIoFamily(
        input.rootKey,
        input.raiderIoCharacters,
        input.raiderIoLimitation
      ),
      fingerprintFamily(
        input.rootKey,
        input.sweep,
        matches,
        input.reservationId
      )
    ]
  };
}

/** `amendAndFinishFingerprintSweep`: a continuation cycle or seal, fingerprint only. */
export function continuationCycleWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  sweep: SweepForWrite;
  reservationId: string;
}): ObservationWriteInput {
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      fingerprintFamily(
        input.rootKey,
        input.sweep,
        input.sweep.characters,
        input.reservationId
      )
    ]
  };
}

/** `completeWithLiveSweepSnapshot`: Raider.IO observations only, never retracting. */
export function liveSweepCompletionWrite(input: {
  runId: string;
  rootKey: CharacterKey;
  characters: readonly DiscoveredCharacter[];
}): ObservationWriteInput {
  return {
    runId: input.runId,
    observerKey: input.rootKey,
    families: [
      {
        family: "raiderio",
        decision: "added_only",
        reason: "live_sweep_completion",
        sweepReservationId: null,
        observed: observed(input.rootKey, input.characters)
      }
    ]
  };
}
```

Export the four builders from `packages/application/src/index.ts`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/observation-writes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing handler tests**

Add these to `packages/application/src/discovery-job-handler.test.ts`, using the existing `createMemoryRepositories`, `handlerFor`, `handlerHarness` and `delivery`. Add a recording fake for the writer:

```ts
function recordingConnections() {
  const writes: ObservationWriteInput[] = [];
  const recomputed: string[][] = [];
  return {
    writes,
    recomputed,
    repository: {
      async writeObservations(input: ObservationWriteInput) {
        writes.push(input);
        return { changedCharacterIds: ["x"], unknownCharacters: 0 };
      },
      async recomputeGroupsOf(ids: readonly string[]) {
        recomputed.push([...ids]);
      },
      async recomputePass() {
        return { groupsRecomputed: 0, cycleCompleted: true };
      },
      async rebuild() {
        return { observers: 0, links: 0, groups: 0 };
      }
    }
  };
}

describe("observation writes after publication", () => {
  it("writes a Raider.IO publication after it commits", async () => {
    const repositories = createMemoryRepositories();
    const connections = recordingConnections();
    repositories.characterConnections = connections.repository;
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await handlerFor(repositories, new MutableGateway()).execute(
      run.id,
      delivery()
    );
    expect(connections.writes).toHaveLength(1);
    expect(connections.writes[0]).toMatchObject({
      runId: run.id,
      observerKey: rootKey,
      families: [{ family: "raiderio" }]
    });
    expect(connections.recomputed).toEqual([["x"]]);
  });

  it("writes nothing when the publication did not commit", async () => {
    const repositories = createMemoryRepositories();
    const connections = recordingConnections();
    repositories.characterConnections = connections.repository;
    repositories.snapshots.create = async () => {
      throw new Error("database_unavailable");
    };
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await handlerFor(repositories, new MutableGateway())
      .execute(run.id, delivery())
      .catch(() => undefined);
    expect(connections.writes).toEqual([]);
  });

  it("writes after a follow-up throws", async () => {
    // Break caught: enqueueFingerprintAdmission throwing after commit skipped
    // the write, and check (a) reset the three days for nothing.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 5
    });
    const connections = recordingConnections();
    harness.repositories.characterConnections = connections.repository;
    harness.enqueueFingerprintAdmission = async () => {
      throw new Error("queue_unavailable");
    };
    await harness.execute().catch(() => undefined);
    expect(
      connections.writes.map((write) =>
        write.families.map((family) => family.family)
      )
    ).toEqual([["raiderio", "fingerprint"]]);
  });

  it("writes when aborted after commit, and still ends cancelled", async () => {
    const repositories = createMemoryRepositories();
    const connections = recordingConnections();
    repositories.characterConnections = connections.repository;
    const controller = new AbortController();
    const create = repositories.snapshots.create.bind(repositories.snapshots);
    repositories.snapshots.create = async (input, options) => {
      const stored = await create(input, options);
      controller.abort(new Error("shutdown"));
      return stored;
    };
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await expect(
      handlerFor(repositories, new MutableGateway()).execute(run.id, {
        attempt: 1,
        maxAttempts: 3,
        signal: controller.signal
      })
    ).rejects.toThrow("shutdown");
    expect(connections.writes).toHaveLength(1);
  });

  it("logs a failed write and changes nothing else", async () => {
    const repositories = createMemoryRepositories();
    const logged: Record<string, unknown>[] = [];
    repositories.characterConnections = {
      ...recordingConnections().repository,
      async writeObservations() {
        throw new Error("lock timeout");
      }
    };
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await handlerFor(repositories, new MutableGateway(), {
      logger: { info: (value) => logged.push(value) }
    }).execute(run.id, delivery());
    expect(logged.map((record) => record.event)).toContain(
      "character_groups_write_failed"
    );
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({ state: "complete" });
  });

  it("writes a continuation cycle as fingerprint only, with its reservation", async () => {
    const harness = handlerHarness({
      roster: rosterOf(12),
      sweepRequestCap: 5
    });
    const connections = recordingConnections();
    harness.repositories.characterConnections = connections.repository;
    await harness.execute();
    await continuation(harness).execute();
    expect(connections.writes[1]!.families).toEqual([
      expect.objectContaining({
        family: "fingerprint",
        sweepReservationId: expect.any(String)
      })
    ]);
  });
});
```

`handlerHarness` (L743-925) may expose its repositories, `execute` and the admission callback under other names. Adapt these three tests to its real API: read L743-935 first. Keep each test's assertion as written.

- [ ] **Step 6: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/discovery-job-handler.test.ts -t "observation writes after publication"`
Expected: FAIL, because nothing is written yet.

- [ ] **Step 7: Wire the handler without re-indenting it**

In `discovery-job-handler.ts`:

**(a)** Beside `let resume …` (L514-516), declare:

```ts
// Set only after a publication call resolves, which is only after its
// transaction committed (#738). Written in the outer finally, so a
// follow-up that throws, or an abort, cannot skip it.
let pendingWrite: ObservationWriteInput | null = null;
```

**(b)** Path d, after `await repositories.runs.completeWithLiveSweepSnapshot(runId, live.snapshotId);` (L693):

```ts
pendingWrite = liveSweepCompletionWrite({
  runId,
  rootKey: run.rootKey,
  characters: outcome.characters
});
```

**(c)** Path c, directly after the `if (amended === null) { … return; }` block (after L908):

```ts
pendingWrite = continuationCycleWrite({
  runId,
  rootKey: run.rootKey,
  sweep,
  reservationId: admission.reservationId
});
```

**(d)** Path b, directly after the `createAndFinishFingerprintSweep(…)` call resolves (after L954):

```ts
pendingWrite = firstSweepCycleWrite({
  runId,
  rootKey: run.rootKey,
  raiderIoCharacters: outcome.characters,
  raiderIoLimitation,
  sweep,
  excludedTournamentIds: excludedTournamentCharacters,
  reservationId: admission.reservationId
});
```

`sweep` here is narrowed to `matched | capped` by the `failure` branch at L784. If TypeScript does not narrow it through the closure, assert it with `sweep as SweepForWrite`.

**(e)** Path a, after `await repositories.snapshots.create(…)` (L1021-1033) and before `return;`:

```ts
pendingWrite = raiderIoPublicationWrite({
  runId,
  rootKey: run.rootKey,
  characters: outcome.characters,
  limitationCode: outcome.state === "partial" ? outcome.limitationCode : null
});
```

**(f)** The outer `finally` (L1126-1131). After the timing log, and outside the measured scope, use `options.repositories`, not the measured proxy:

```ts
    } finally {
      if (options.logger) {
        record.durationMs = Math.max(0, Math.round(monotonic() - observedAt));
        options.logger.info({ ...record, ...scope.totals() });
      }
      if (pendingWrite) await writeCommittedObservations(pendingWrite);
    }
```

Define inside `createDiscoveryJobHandler`, before `return {`:

```ts
/**
 * Phase 1's best-effort observation write (#738). It runs after the
 * publication committed and after the run's timing log, never throws, and
 * ignores the job's abort signal, so it cannot change an outcome.
 */
async function writeCommittedObservations(
  write: ObservationWriteInput
): Promise<void> {
  const connections = options.repositories.characterConnections;
  if (!connections) return;
  try {
    const result = await connections.writeObservations(write);
    await connections.recomputeGroupsOf(result.changedCharacterIds);
    if (result.unknownCharacters > 0) {
      options.logger?.info({
        event: "character_groups_write",
        unknownCharacters: result.unknownCharacters
      });
    }
  } catch (error) {
    options.logger?.info({
      event: "character_groups_write_failed",
      errorName: error instanceof Error ? error.name : "unknown"
    });
  }
}
```

Import the builders and `ObservationWriteInput`. This changes three places that return early. `continuation_superseded` and `pendingWrite === null` both return with nothing written. An abort rethrown at L1079-1085 still passes through the `finally`, so a publication that committed before the abort is written.

- [ ] **Step 8: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/discovery-job-handler.test.ts`
Expected: PASS, the whole file. None of the existing tests set `characterConnections`, so their behaviour is unchanged.

- [ ] **Step 9: Commit**

```bash
corepack pnpm typecheck && corepack pnpm lint
git add packages/application/src/observation-writes.ts packages/application/src/observation-writes.test.ts packages/application/src/discovery-job-handler.ts packages/application/src/discovery-job-handler.test.ts packages/application/src/index.ts
git commit -m "feat(application): write discovery observations after each committed publication (#738)" -m "Each of the four publication paths sets the write it owes only after its call resolved, and the handler's outer finally writes it after the timing log, best effort, so a follow-up that throws or an abort cannot skip it and a failure changes no outcome." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The worker's maintenance step and log fields

**Files:**

- Modify: `apps/worker/src/runtime.ts:1000-1043`
- Modify: `apps/worker/src/logger.ts:9-97`
- Modify: `apps/worker/src/runtime.test.ts:1775-1812` (neighbouring tests)
- Modify: `apps/worker/src/logger.test.ts:424` (neighbouring tests)

**Interfaces:**

- Consumes: `repositories.characterConnections.recomputePass({ budgetMs })` (Task 5).
- Produces: log events `character_groups_recompute` (with `groupsRecomputed`, `cycleCompleted` and `durationMs`), `character_groups_write` (with `unknownCharacters`) and `character_groups_write_failed` (with `errorName`).

- [ ] **Step 1: Write the failing tests**

In `apps/worker/src/logger.test.ts`, beside the `evidence_cache_cleanup` test at line 424:

```ts
it("keeps the character groups maintenance and write fields", () => {
  const lines = captureLogger((logger) => {
    logger.info({
      event: "character_groups_recompute",
      groupsRecomputed: 3,
      cycleCompleted: true,
      durationMs: 12
    });
    logger.info({ event: "character_groups_write", unknownCharacters: 1 });
  });
  expect(lines[0]).toMatchObject({
    event: "character_groups_recompute",
    groupsRecomputed: 3,
    cycleCompleted: true,
    durationMs: 12
  });
  expect(lines[0]).not.toHaveProperty("droppedFields");
  expect(lines[1]).toMatchObject({ unknownCharacters: 1 });
});
```

Use the file's own capture helper, whatever it is really called. In `apps/worker/src/runtime.test.ts`, beside the cleanup tests at 1775-1812:

```ts
it("recomputes character groups after the cleanup, even when the cleanup failed", async () => {
  // Break caught: a cleanup failure rethrew before the recompute ran, so
  // manual edits never reached the groups and drift failed the replay.
  const recomputePass = vi.fn(async () => ({
    groupsRecomputed: 2,
    cycleCompleted: false
  }));
  const { run, logged } = maintenanceHarness({
    characterConnections: { recomputePass },
    clearStaleCredentials: async () => {
      throw new Error("database_unavailable");
    }
  });
  await expect(run()).rejects.toThrow("database_unavailable");
  expect(recomputePass).toHaveBeenCalledWith({ budgetMs: 30_000 });
  expect(logged).toContainEqual(
    expect.objectContaining({
      event: "character_groups_recompute",
      groupsRecomputed: 2,
      cycleCompleted: false
    })
  );
});
```

Build `maintenanceHarness` from the setup the existing cleanup tests at 1775-1812 use. The existing exact-shape `toEqual` for `evidence_cache_cleanup` stays as it is: this task adds a separate record rather than new fields on that one.

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit apps/worker/src/logger.test.ts apps/worker/src/runtime.test.ts`
Expected: FAIL. The fields are dropped, and no recompute runs.

- [ ] **Step 3: Implement**

In `apps/worker/src/logger.ts`, add these to the allowlist next to the maintenance counts at lines 85-88:

- `"groupsRecomputed"`
- `"cycleCompleted"`
- `"unknownCharacters"`

`errorName` and `durationMs` are already allowed; confirm they are there.

In `apps/worker/src/runtime.ts`, rename the existing `maintenanceCleanup` to `cacheCleanup`, leaving its body unchanged. Then add:

```ts
/** How long one maintenance cycle may spend recomputing character groups (#738). */
const CHARACTER_GROUPS_RECOMPUTE_BUDGET_MS = 30_000;

/**
 * The hourly maintenance: the existing cache cleanup, then the character
 * groups recompute. The recompute runs even when the cleanup failed, and a
 * recompute failure never hides the cleanup's own.
 */
async function maintenanceCleanup(context: WorkerContext): Promise<void> {
  try {
    await cacheCleanup(context);
  } finally {
    await characterGroupsRecompute(context);
  }
}

async function characterGroupsRecompute(context: WorkerContext): Promise<void> {
  const { repositories, clock, logger } = context;
  const connections = repositories.characterConnections;
  if (!connections) return;
  const startedAt = clock();
  try {
    const result = await connections.recomputePass({
      budgetMs: CHARACTER_GROUPS_RECOMPUTE_BUDGET_MS
    });
    logger?.info({
      event: "character_groups_recompute",
      ...result,
      durationMs: elapsedMs(clock, startedAt)
    });
  } catch (error) {
    logger?.info({
      event: "character_groups_write_failed",
      errorName: errorName(error),
      durationMs: elapsedMs(clock, startedAt)
    });
  }
}
```

The call at runtime.ts:1088-1090 still passes `maintenanceCleanup`, so the wiring is unchanged.

- [ ] **Step 4: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit apps/worker/src/logger.test.ts apps/worker/src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/runtime.ts apps/worker/src/logger.ts apps/worker/src/runtime.test.ts apps/worker/src/logger.test.ts
git commit -m "feat(worker): recompute character groups in hourly maintenance (#738)" -m "Runs after the cache cleanup whether or not it failed, within a 30 s budget, and logs its own record, so a manual edit or a lost recompute reaches the groups within a cursor cycle." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Extract today's `resolveSubjects` unchanged

**Why:** the replay must run today's membership code exactly. It is a private closure (`applicant-dossier-service.ts:1293-1436`), so this task moves it, unchanged, into an exported function. The spec keeps it as `legacyResolveSubjects` until phase 3.

**Files:**

- Create: `packages/application/src/dossier-subjects.ts`
- Modify: `packages/application/src/applicant-dossier-service.ts`: replace the closure with a call; also move or import `borrowSnapshot` (1261-1284), `compareByLevelThenKey` (1088-1099) and the `DossierSubject` type (235-248).
- Modify: `packages/application/src/index.ts`

**Interfaces:**

- Produces:

```ts
export type DossierSubject = …; // moved verbatim from applicant-dossier-service.ts:235-248
export type RankedSubject = DossierSubject & Readonly<{ level: number }>;
export type ResolvedSubjects = Readonly<{
  snapshot: StoredSnapshot;
  selected: RankedSubject[];
  skipped: RankedSubject[];
  excludedOrdered: RankedSubject[];
  provisional: boolean;
}>;
export type SubjectRepositories = Pick<Repositories, "snapshots" | "manualConnections" | "evidence">;
export function legacyResolveSubjects(key: CharacterKey, repositories: SubjectRepositories, config: { DOSSIER_CHARACTER_CEILING: number }): Promise<ResolvedSubjects | null>;
export function compareByLevelThenKey(left: RankedSubject, right: RankedSubject): number;
```

- [ ] **Step 1: Pin the current behaviour with a test on the export**

Create `packages/application/src/dossier-subjects.test.ts`, with a minimal fake using the same fake shape as the dossier service's tests. Find them with `grep -n "resolveSubjects\|getCurrentDeclaringCharacter" packages/application/src/applicant-dossier-service.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { legacyResolveSubjects } from "./dossier-subjects";

describe("legacyResolveSubjects", () => {
  it("borrows a declared member's snapshot and relabels the root and former root", async () => {
    const root = { region: "eu", realm: "draenor", name: "quellaria" } as const;
    const main = { region: "eu", realm: "draenor", name: "eundariel" } as const;
    const snapshot = {
      id: "s",
      runId: "r",
      rootKey: root,
      state: "complete",
      limitationCode: null,
      refreshedAt: new Date(),
      characterCount: 2,
      characters: [
        {
          key: root,
          displayName: "Q",
          className: "Mage",
          level: 90,
          guild: null,
          raiderIoUrl: "x",
          source: "input",
          characterId: "1",
          displayOrder: 0
        },
        {
          key: main,
          displayName: "E",
          className: "Demon Hunter",
          level: 90,
          guild: null,
          raiderIoUrl: "x",
          source: "declared_main",
          characterId: "2",
          displayOrder: 1
        }
      ]
    };
    const repositories = {
      snapshots: {
        getCurrent: async () => null,
        getCurrentDeclaringCharacter: async () => snapshot
      },
      manualConnections: {
        list: async () => [],
        listDiscoveredExclusions: async () => []
      },
      evidence: { warcraftLogsCharacterIds: async () => [] }
    } as never;
    const resolved = await legacyResolveSubjects(main, repositories, {
      DOSSIER_CHARACTER_CEILING: 50
    });
    expect(resolved?.provisional).toBe(true);
    expect(
      resolved?.selected.map((subject) => [subject.key.name, subject.source])
    ).toEqual([
      ["eundariel", "input"],
      ["quellaria", "claimed"]
    ]);
  });
});
```

- [ ] **Step 2: Run the test and see it fail**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/dossier-subjects.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Move the code verbatim**

Cut `resolveSubjects` (1293-1436), `borrowSnapshot` (1261-1284), `compareByLevelThenKey` (1088-1099) and the `DossierSubject` type (235-248) into `dossier-subjects.ts`. Rename `resolveSubjects` to `legacyResolveSubjects`, and change its signature to `(key, repositories, config)`. It closed over `options.config.DOSSIER_CHARACTER_CEILING`, so that becomes the parameter. The body is otherwise unchanged, character for character, including `groupBySharedWarcraftLogsId` and every comment.

In the service, the two call sites (1616 and 1689) become:

```ts
const resolved = await legacyResolveSubjects(
  key,
  scopedRepositories(scope),
  options.config
);
const resolved = await legacyResolveSubjects(key, repositories, options.config);
```

Import `DossierSubject` and `compareByLevelThenKey` back into the service wherever it still uses them.

- [ ] **Step 4: Run all application tests**

Run: `corepack pnpm exec vitest run --project unit packages/application`
Expected: PASS, including the whole existing `applicant-dossier-service.test.ts` and the new test, with no test edited except the new one.

- [ ] **Step 5: Commit**

```bash
corepack pnpm typecheck && corepack pnpm lint
git add packages/application/src/dossier-subjects.ts packages/application/src/dossier-subjects.test.ts packages/application/src/applicant-dossier-service.ts packages/application/src/index.ts
git commit -m "refactor(application): extract dossier membership into legacyResolveSubjects (#738)" -m "Moved verbatim out of the dossier service closure so the character groups replay can run today's membership code exactly. No behaviour change: the service calls it with the same repositories and ceiling." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Phase 2's `resolveGroupSubjects`, shipped unwired

**Why:** the replay compares today's pages with what phase 2 will serve. The spec's rules are in phase 2's Reading a dossier section and the Terms section. No route calls this in phase 1.

**Files:**

- Create: `packages/application/src/group-subjects.ts`
- Create: `packages/application/src/group-subjects.test.ts`

**Interfaces:**

- Consumes: `pathStrengths` (Task 2); `RankedSubject` and `compareByLevelThenKey` (Task 8); `groupBySharedWarcraftLogsId` (`shared-warcraft-logs-identity.ts`).
- Produces, used by Task 10:

```ts
export type GroupGraph = Readonly<{
  characters: ReadonlyMap<
    string,
    Readonly<{
      key: CharacterKey;
      displayName: string;
      className: string;
      level: number;
      raiderIoUrl: string;
    }>
  >;
  idOf: (key: CharacterKey) => string | undefined;
  groupOf: ReadonlyMap<string, string>; // character id → group id
  links: readonly Readonly<{ a: string; b: string; strength: LinkStrength }>[]; // counting links, manual included
  manual: readonly Readonly<{
    makerId: string;
    targetId: string;
    excluded: boolean;
  }>[];
  discoveredExclusions: readonly Readonly<{
    makerId: string;
    targetId: string;
  }>[];
  suppressed: ReadonlySet<string>; // character ids
  warcraftLogsIds: ReadonlyMap<string, number>; // character id → WCL id
  sharedIdentity: (id: string) => ReadonlySet<string>; // ids sharing a WCL id, self included
  latestSnapshot: ReadonlyMap<
    string,
    Readonly<{ state: "complete" | "partial"; limitationCode: string | null }>
  >; // by root id, suppression-filtered
}>;
export type GroupSubjects = Readonly<{
  selected: readonly RankedSubject[];
  skipped: readonly RankedSubject[];
  excluded: readonly RankedSubject[];
  research: Readonly<{
    state: "complete" | "partial";
    limitationCodes: readonly string[];
  }>;
}>;
export function pageMembers(originId: string, graph: GroupGraph): Set<string>;
export function resolveGroupSubjects(
  originKey: CharacterKey,
  graph: GroupGraph,
  config: { DOSSIER_CHARACTER_CEILING: number }
): GroupSubjects | null;
```

- [ ] **Step 1: Write the failing tests**

`packages/application/src/group-subjects.test.ts`. Build a small `GroupGraph` in the test with a helper:

```ts
import { describe, expect, it } from "vitest";
import type { CharacterKey } from "@slashwho/domain";
import {
  pageMembers,
  resolveGroupSubjects,
  type GroupGraph
} from "./group-subjects";

const key = (name: string): CharacterKey => ({
  region: "eu",
  realm: "draenor",
  name
});

function graph(
  overrides: Partial<GroupGraph> & {
    names: string[];
    links: GroupGraph["links"];
  }
): GroupGraph {
  const characters = new Map(
    overrides.names.map((name) => [
      name,
      {
        key: key(name),
        displayName: name,
        className: "Mage",
        level: 80,
        raiderIoUrl: "x"
      }
    ])
  );
  return {
    characters,
    idOf: (k) => (characters.has(k.name) ? k.name : undefined),
    groupOf: new Map(overrides.names.map((name) => [name, "g"])),
    links: overrides.links,
    manual: overrides.manual ?? [],
    discoveredExclusions: overrides.discoveredExclusions ?? [],
    suppressed: overrides.suppressed ?? new Set(),
    warcraftLogsIds: overrides.warcraftLogsIds ?? new Map(),
    sharedIdentity: overrides.sharedIdentity ?? ((id) => new Set([id])),
    latestSnapshot: overrides.latestSnapshot ?? new Map()
  };
}

describe("page members", () => {
  it("never walks through a suppressed character", () => {
    const g = graph({
      names: ["o", "s", "x"],
      links: [
        { a: "o", b: "s", strength: "raiderio" },
        { a: "s", b: "x", strength: "raiderio" }
      ],
      suppressed: new Set(["s"])
    });
    expect([...pageMembers("o", g)].sort()).toEqual(["o"]);
  });
});

describe("resolveGroupSubjects", () => {
  it("labels the opened character as today's root and others by path", () => {
    const g = graph({
      names: ["o", "f", "c"],
      links: [
        { a: "o", b: "f", strength: "fingerprint" },
        { a: "f", b: "c", strength: "raiderio" }
      ]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(
      subjects.selected.map((subject) => [subject.key.name, subject.source])
    ).toEqual([
      ["o", "input"],
      ["c", "fingerprint"],
      ["f", "fingerprint"]
    ]);
  });

  it("greys a character any page member excluded, but never the opened one, and ignores self-exclusions", () => {
    const g = graph({
      names: ["o", "a", "b"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "o", b: "b", strength: "raiderio" }
      ],
      discoveredExclusions: [
        { makerId: "a", targetId: "b" },
        { makerId: "a", targetId: "o" },
        { makerId: "b", targetId: "b" }
      ]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 50
    })!;
    expect(subjects.excluded.map((subject) => subject.key.name)).toEqual(["b"]);
    expect(subjects.selected.map((subject) => subject.key.name)).toContain("o");
  });

  it("takes research state from page members' snapshots, complete only if O has its own", () => {
    const g = graph({
      names: ["o", "a"],
      links: [{ a: "o", b: "a", strength: "raiderio" }],
      latestSnapshot: new Map([
        ["a", { state: "partial", limitationCode: "privacy_hidden" }]
      ])
    });
    expect(
      resolveGroupSubjects(key("o"), g, { DOSSIER_CHARACTER_CEILING: 50 })!
        .research
    ).toEqual({ state: "partial", limitationCodes: ["privacy_hidden"] });
  });

  it("caps at the ceiling and returns the rest as skipped", () => {
    const g = graph({
      names: ["o", "a", "b"],
      links: [
        { a: "o", b: "a", strength: "raiderio" },
        { a: "o", b: "b", strength: "raiderio" }
      ]
    });
    const subjects = resolveGroupSubjects(key("o"), g, {
      DOSSIER_CHARACTER_CEILING: 2
    })!;
    expect(subjects.selected).toHaveLength(2);
    expect(subjects.skipped).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/group-subjects.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement**

`packages/application/src/group-subjects.ts`:

```ts
import {
  canonicalCharacterId,
  pathStrengths,
  type CharacterKey,
  type LinkStrength
} from "@slashwho/domain";
import { compareByLevelThenKey, type RankedSubject } from "./dossier-subjects";
import { groupBySharedWarcraftLogsId } from "./shared-warcraft-logs-identity";

// GroupGraph and GroupSubjects exactly as in this task's Interfaces block.

/** A page's members: reach from `originId` within its group, never through a suppressed character. */
export function pageMembers(originId: string, graph: GroupGraph): Set<string> {
  const group = graph.groupOf.get(originId);
  const members = new Set<string>([originId]);
  if (graph.suppressed.has(originId)) return new Set();
  const neighbours = new Map<string, string[]>();
  for (const link of graph.links) {
    if (
      graph.groupOf.get(link.a) !== group ||
      graph.groupOf.get(link.b) !== group
    )
      continue;
    neighbours.set(link.a, [...(neighbours.get(link.a) ?? []), link.b]);
    neighbours.set(link.b, [...(neighbours.get(link.b) ?? []), link.a]);
  }
  const queue = [originId];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of neighbours.get(node) ?? []) {
      if (members.has(next) || graph.suppressed.has(next)) continue;
      members.add(next);
      queue.push(next);
    }
  }
  return members;
}

const SOURCE_FOR: Record<LinkStrength, RankedSubject["source"]> = {
  raiderio: "claimed",
  fingerprint: "fingerprint",
  manual: "manually_added"
};

export function resolveGroupSubjects(
  originKey: CharacterKey,
  graph: GroupGraph,
  config: { DOSSIER_CHARACTER_CEILING: number }
): GroupSubjects | null {
  const originId = graph.idOf(originKey);
  if (!originId || graph.suppressed.has(originId)) return null;
  const members = pageMembers(originId, graph);
  const strengths = pathStrengths(
    originId,
    graph.links.filter((link) => members.has(link.a) && members.has(link.b))
  );
  const subject = (id: string): RankedSubject => {
    const character = graph.characters.get(id)!;
    return {
      key: character.key,
      displayName: character.displayName,
      className: character.className,
      guild: null,
      raiderIoUrl: character.raiderIoUrl,
      level: character.level,
      source:
        id === originId
          ? "input"
          : SOURCE_FOR[strengths.get(id) ?? "fingerprint"]
    };
  };
  const isSelfExclusion = (makerId: string, targetId: string) =>
    graph.sharedIdentity(makerId).has(targetId);
  const excludedIds = new Set<string>();
  for (const row of graph.manual) {
    if (
      row.excluded &&
      members.has(row.makerId) &&
      !isSelfExclusion(row.makerId, row.targetId)
    )
      excludedIds.add(row.targetId);
  }
  for (const row of graph.discoveredExclusions) {
    if (members.has(row.makerId) && !isSelfExclusion(row.makerId, row.targetId))
      excludedIds.add(row.targetId);
  }
  excludedIds.delete(originId);
  const originCanonical = canonicalCharacterId(originKey);
  const ordered = [...members].map(subject).sort((left, right) => {
    const rootOrder =
      Number(canonicalCharacterId(right.key) === originCanonical) -
      Number(canonicalCharacterId(left.key) === originCanonical);
    return rootOrder || compareByLevelThenKey(left, right);
  });
  const recorded = [...members].flatMap((id) => {
    const wcl = graph.warcraftLogsIds.get(id);
    return wcl === undefined
      ? []
      : [{ key: graph.characters.get(id)!.key, characterId: wcl }];
  });
  const idByCanonical = new Map(
    [...members].map((id) => [
      canonicalCharacterId(graph.characters.get(id)!.key),
      id
    ])
  );
  const excludedSubject = (candidate: RankedSubject) =>
    excludedIds.has(
      idByCanonical.get(canonicalCharacterId(candidate.key)) ?? ""
    );
  const identities = groupBySharedWarcraftLogsId(
    ordered,
    recorded,
    (group) =>
      group.find(
        (candidate) => canonicalCharacterId(candidate.key) === originCanonical
      ) ??
      group.find(excludedSubject) ??
      group[0]!
  );
  const included: RankedSubject[] = [];
  const excluded: RankedSubject[] = [];
  for (const { primary, aliases } of identities) {
    const isOrigin = canonicalCharacterId(primary.key) === originCanonical;
    const row =
      aliases.length === 0
        ? primary
        : {
            ...primary,
            warcraftLogsAliases: aliases.map((alias) => alias.key)
          };
    if (!isOrigin && [primary, ...aliases].some(excludedSubject))
      excluded.push(row);
    else included.push(row);
  }
  const contributing = [...members].flatMap((id) => {
    const snapshot = graph.latestSnapshot.get(id);
    return snapshot ? [snapshot] : [];
  });
  const originHasComplete =
    graph.latestSnapshot.get(originId)?.state === "complete";
  const allComplete = contributing.every(
    (snapshot) => snapshot.state === "complete"
  );
  const limitationCodes = [
    ...new Set(
      contributing.flatMap((snapshot) =>
        snapshot.limitationCode ? [snapshot.limitationCode] : []
      )
    )
  ].sort();
  return {
    selected: included.slice(0, config.DOSSIER_CHARACTER_CEILING),
    skipped: included.slice(config.DOSSIER_CHARACTER_CEILING),
    excluded: excluded.sort(compareByLevelThenKey),
    research: {
      state: allComplete && originHasComplete ? "complete" : "partial",
      limitationCodes
    }
  };
}
```

`SOURCE_FOR` maps a strength to a snapshot source that serialises to the same label, since `claimed` serialises as `raiderio_declared` (`serializeDossierSubject`, 772-821). The replay therefore compares labels through that one serialiser. Guilds are omitted (`null`) because phase 1 doesn't compare them. The replay's label comparison works on the serialised label only.

- [ ] **Step 4: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/group-subjects.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
corepack pnpm typecheck && corepack pnpm lint
git add packages/application/src/group-subjects.ts packages/application/src/group-subjects.test.ts
git commit -m "feat(application): phase 2 group dossier resolution, unwired (#738)" -m "Page members walked within the group and never through a suppressed character, path labels, group-wide exclusions that ignore self-exclusions through Warcraft Logs aliases, and research state from page members. Called only by the replay in phase 1." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The replay: page comparison, ledger checks, drift and coverage

**Files:**

- Create: `packages/database/src/character-groups-audit.ts`: `loadCharacterGroupsAudit(pool, now)`, one `withConsistentRead`.
- Create: `packages/application/src/character-groups-replay.ts`: `replayCharacterGroups(audit, legacyPages, config)`, pure.
- Create: `packages/application/src/character-groups-replay.test.ts`: unit tests on the pure checks.
- Create: `tests/integration/character-groups-replay.test.ts`: end-to-end fixtures.
- Modify: `packages/database/src/index.ts` and `packages/application/src/index.ts`

**Interfaces:**

- Consumes: `resolveGroupSubjects` and `GroupGraph` (Task 9); `legacyResolveSubjects` (Task 8); `components` (Task 2).
- Produces:

```ts
// database
export type CharacterGroupsAudit = Readonly<{
  now: Date;
  graph: GroupGraph; // Task 9's shape, suppression and all
  groups: ReadonlyMap<
    string,
    Readonly<{ recomputedAt: Date; members: readonly string[] }>
  >;
  maintenance: Readonly<{
    lastCycleStartedAt: Date | null;
    lastCycleCompletedAt: Date | null;
  }>;
  observations: readonly Readonly<{
    lowId: string;
    highId: string;
    source: string;
    observerId: string;
    runId: string;
    observedAt: Date;
  }>[];
  ledger: readonly Readonly<{
    runId: string;
    sweepReservationId: string | null;
    observerId: string;
    family: string;
    decision: string;
    reason: string;
    runStartedAt: Date;
    writtenAt: Date;
  }>[];
  publications: readonly Readonly<
    | { kind: "run"; runId: string; observerId: string; at: Date }
    | {
        kind: "reservation";
        reservationId: string;
        runId: string;
        observerId: string;
        at: Date;
      }
  >[];
  latestRawMembership: ReadonlyMap<string, readonly string[]>; // root id → member ids, ignoring suppression
  manualChangedAt: Date | null; // newest manual_dossier_connections.created_at or excluded_at
  roots: readonly CharacterKey[]; // every character in any latest snapshot, suppressed excluded
}>;
export function loadCharacterGroupsAudit(
  pool: Pool,
  now?: Date
): Promise<CharacterGroupsAudit>;

// application
export type ReplayFinding = Readonly<{ check: string; detail: string }>;
export type ReplayReport = Readonly<{
  failures: readonly ReplayFinding[];
  reports: readonly ReplayFinding[];
  counts: Readonly<Record<string, number>>;
  coverage: Readonly<Record<string, number>>;
}>;
export function auditLedger(audit: CharacterGroupsAudit): {
  failures: ReplayFinding[];
  coverage: Record<string, number>;
};
export function auditDrift(audit: CharacterGroupsAudit): {
  failures: ReplayFinding[];
  reports: ReplayFinding[];
};
export function comparePages(
  audit: CharacterGroupsAudit,
  legacy: ReadonlyMap<string, ResolvedSubjects | null>,
  config: { DOSSIER_CHARACTER_CEILING: number }
): {
  failures: ReplayFinding[];
  reports: ReplayFinding[];
  counts: Record<string, number>;
};
export function replayCharacterGroups(
  audit: CharacterGroupsAudit,
  legacy: ReadonlyMap<string, ResolvedSubjects | null>,
  config: { DOSSIER_CHARACTER_CEILING: number }
): ReplayReport;
```

Findings name characters by `region/realm/name`, never by a suppressed key. Every detail string is built through `describe(id)`, which returns `"(suppressed)"` for a suppressed id.

- [ ] **Step 1: Write the failing unit tests for the ledger and drift rules**

`packages/application/src/character-groups-replay.test.ts`. Build a minimal `CharacterGroupsAudit` fixture with a `baseAudit()` helper that returns an empty graph and `now = 2026-10-01T12:00:00Z`, then vary it per test:

```ts
describe("ledger checks", () => {
  it("(a) fails a publication with no ledger row, and skips one younger than 10 minutes", () => {
    const audit = baseAudit({
      ledger: [backfill("o", "raiderio", minutesAgo(600))],
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) },
        { kind: "run", runId: "r2", observerId: "o", at: minutesAgo(5) }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([
      expect.objectContaining({
        check: "a_completeness",
        detail: expect.stringContaining("r1")
      })
    ]);
  });

  it("(a) matches a sweep publication by reservation id, cycle 1 included", () => {
    const audit = baseAudit({
      ledger: [
        backfill("o", "raiderio", minutesAgo(600)),
        ledgerRow({ runId: "r1", family: "raiderio" }),
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          sweepReservationId: "res1"
        })
      ],
      publications: [
        { kind: "run", runId: "r1", observerId: "o", at: minutesAgo(60) },
        {
          kind: "reservation",
          reservationId: "res1",
          runId: "r1",
          observerId: "o",
          at: minutesAgo(60)
        }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(a) starts its window at the newest backfill or rebuild row", () => {
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "rb",
          family: "raiderio",
          reason: "rebuild",
          writtenAt: minutesAgo(30)
        })
      ],
      publications: [
        {
          kind: "run",
          runId: "lost-before-rebuild",
          observerId: "o",
          at: minutesAgo(90)
        }
      ]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(b) passes when a snapshot member has an observation in either family, and ignores the root", () => {
    const audit = baseAudit({
      latestRawMembership: new Map([["o", ["o", "a"]]]),
      observations: [observationRow("o", "a", "fingerprint", "r1")],
      ledger: [ledgerRow({ runId: "r1", family: "fingerprint" })]
    });
    expect(auditLedger(audit).failures).toEqual([]);
  });

  it("(c) fails an observation whose run has no ledger row", () => {
    const audit = baseAudit({
      observations: [observationRow("o", "a", "claimed", "ghost")]
    });
    expect(
      auditLedger(audit).failures.map((finding) => finding.check)
    ).toContain("c_provenance");
  });

  it("(d) applies the newest replaced row even after a later added_only row", () => {
    // Break caught: a later privacy-hidden run made (d) vacuous.
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "r1",
          family: "raiderio",
          decision: "replaced",
          runStartedAt: minutesAgo(120)
        }),
        ledgerRow({
          runId: "r2",
          family: "raiderio",
          decision: "added_only",
          reason: "privacy_hidden",
          runStartedAt: minutesAgo(60)
        })
      ],
      observations: [observationRow("o", "stale", "claimed", "r0")]
    });
    expect(
      auditLedger(audit).failures.map((finding) => finding.check)
    ).toContain("d_retraction");
  });

  it("reports path coverage", () => {
    const audit = baseAudit({
      ledger: [
        ledgerRow({
          runId: "r1",
          family: "fingerprint",
          reason: "capped",
          sweepReservationId: "res"
        }),
        ledgerRow({
          runId: "r2",
          family: "raiderio",
          reason: "live_sweep_completion"
        })
      ]
    });
    expect(auditLedger(audit).coverage).toMatchObject({
      capped: 1,
      live_sweep_completion: 1
    });
  });
});

describe("drift", () => {
  it("treats a group whose write is newer than its recompute as pending until a later cycle completes", () => {
    const audit = pendingDriftAudit({ cycleStartedAfterWrite: false });
    expect(auditDrift(audit)).toMatchObject({
      failures: [],
      reports: [expect.objectContaining({ check: "drift_pending" })]
    });
    expect(
      auditDrift(pendingDriftAudit({ cycleStartedAfterWrite: true })).failures
    ).toEqual([expect.objectContaining({ check: "drift" })]);
  });

  it("reports drift from manual links alone, and fails other drift", () => {
    expect(auditDrift(manualOnlyDriftAudit()).failures).toEqual([]);
    expect(auditDrift(manualOnlyDriftAudit()).reports).toEqual([
      expect.objectContaining({ check: "drift_manual" })
    ]);
  });

  it("treats drift as pending when any group involved is pending, the absorbed side of a merge included", () => {
    expect(auditDrift(mergeWithPendingAbsorbedAudit()).failures).toEqual([]);
  });
});
```

Write `baseAudit`, `ledgerRow`, `backfill`, `observationRow`, `minutesAgo`, `pendingDriftAudit`, `manualOnlyDriftAudit` and `mergeWithPendingAbsorbedAudit` at the bottom of the test file.

- **The drift fixtures** set the stored groups against the links so recompute yields a different partition:
  - **pending:** the stored group `{o}` alone; a link o–a; a ledger `written_at` after `recomputedAt`.
  - **manual-only:** the stored group `{o, t}`; the only link between them is a manual row that was deleted, so the recomputed groups are `{o}` and `{t}`, sharing no observed link.
  - **merge:** two stored groups whose members are now linked, with the absorbed group's member having a newer ledger row than that group's `recomputedAt`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/character-groups-replay.test.ts`
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement the pure checks**

`packages/application/src/character-groups-replay.ts`, in order:

```ts
const PENDING_MS = 10 * 60 * 1000;

/** The window starts at the newest backfill or rebuild row (Manager Low 2). */
function windowStart(audit: CharacterGroupsAudit): Date {
  const baselines = audit.ledger.filter(
    (row) => row.reason === "backfill" || row.reason === "rebuild"
  );
  return new Date(
    Math.max(0, ...baselines.map((row) => row.writtenAt.getTime()))
  );
}

export function auditLedger(audit: CharacterGroupsAudit) {
  const failures: ReplayFinding[] = [];
  const start = windowStart(audit).getTime();
  const cutoff = audit.now.getTime() - PENDING_MS;
  const describe = describer(audit);
  // (a) completeness
  for (const publication of audit.publications) {
    const at = publication.at.getTime();
    if (at <= start || at > cutoff) continue;
    const owed =
      publication.kind === "run"
        ? audit.ledger.some(
            (row) =>
              row.runId === publication.runId && row.family === "raiderio"
          )
        : audit.ledger.some(
            (row) =>
              row.sweepReservationId === publication.reservationId &&
              row.family === "fingerprint"
          );
    if (!owed)
      failures.push({
        check: "a_completeness",
        detail: `${publication.kind} ${publication.kind === "run" ? publication.runId : publication.reservationId} for ${describe(publication.observerId)}`
      });
  }
  // (b) presence, over raw membership, root excluded
  for (const [rootId, members] of audit.latestRawMembership) {
    for (const memberId of members) {
      if (memberId === rootId) continue;
      const present = audit.observations.some(
        (row) =>
          row.observerId === rootId &&
          (row.lowId === memberId || row.highId === memberId)
      );
      if (!present)
        failures.push({
          check: "b_presence",
          detail: `${describe(memberId)} from ${describe(rootId)}`
        });
    }
  }
  // (c) provenance
  const family = (source: string) =>
    source === "fingerprint" ? "fingerprint" : "raiderio";
  for (const row of audit.observations) {
    const known = audit.ledger.some(
      (entry) =>
        entry.runId === row.runId &&
        entry.observerId === row.observerId &&
        entry.family === family(row.source)
    );
    if (!known)
      failures.push({
        check: "c_provenance",
        detail: `run ${row.runId} observed by ${describe(row.observerId)}`
      });
  }
  // (d) retraction applied, against the newest replaced row
  const order = (
    left: CharacterGroupsAudit["ledger"][number],
    right: CharacterGroupsAudit["ledger"][number]
  ) =>
    left.runStartedAt.getTime() - right.runStartedAt.getTime() ||
    left.writtenAt.getTime() - right.writtenAt.getTime();
  const keyOf = (row: { observerId: string; family: string }) =>
    `${row.observerId}\0${row.family}`;
  const byObserverFamily = new Map<
    string,
    CharacterGroupsAudit["ledger"][number][]
  >();
  for (const row of audit.ledger)
    byObserverFamily.set(keyOf(row), [
      ...(byObserverFamily.get(keyOf(row)) ?? []),
      row
    ]);
  for (const [compound, rows] of byObserverFamily) {
    const sorted = [...rows].sort(order);
    const replacedIndex = sorted
      .map((row) => row.decision)
      .lastIndexOf("replaced");
    if (replacedIndex < 0) continue;
    const allowedRuns = new Set(
      sorted
        .slice(replacedIndex)
        .filter((row) => row.decision !== "blocked")
        .map((row) => row.runId)
    );
    const [observerId, familyName] = compound.split("\0") as [string, string];
    for (const row of audit.observations) {
      if (row.observerId !== observerId || family(row.source) !== familyName)
        continue;
      if (!allowedRuns.has(row.runId))
        failures.push({
          check: "d_retraction",
          detail: `${describe(row.lowId === observerId ? row.highId : row.lowId)} survives ${familyName} replacement for ${describe(observerId)}`
        });
    }
  }
  // coverage: one count per ledger reason in the window
  const coverage: Record<string, number> = {};
  for (const row of audit.ledger) {
    if (row.writtenAt.getTime() <= start) continue;
    coverage[row.reason] = (coverage[row.reason] ?? 0) + 1;
    if (row.sweepReservationId && row.family === "fingerprint")
      coverage.sweep_publication = (coverage.sweep_publication ?? 0) + 1;
  }
  return { failures, coverage };
}

export function auditDrift(audit: CharacterGroupsAudit) {
  const failures: ReplayFinding[] = [];
  const reports: ReplayFinding[] = [];
  const describe = describer(audit);
  const recomputed = components(
    audit.graph.characters.keys(),
    audit.graph.links
  );
  const newestWrite = (memberIds: readonly string[]) =>
    Math.max(
      0,
      ...audit.ledger
        .filter((row) => memberIds.includes(row.observerId))
        .map((row) => row.writtenAt.getTime())
    );
  const cycleCoveredAfter = (at: number) =>
    audit.maintenance.lastCycleStartedAt !== null &&
    audit.maintenance.lastCycleCompletedAt !== null &&
    audit.maintenance.lastCycleStartedAt.getTime() > at &&
    audit.maintenance.lastCycleCompletedAt.getTime() >=
      audit.maintenance.lastCycleStartedAt.getTime();
  const pendingGroup = (groupId: string) => {
    const group = audit.groups.get(groupId);
    if (!group) return true;
    const written = newestWrite(group.members);
    return (
      written > group.recomputedAt.getTime() && !cycleCoveredAfter(written)
    );
  };
  for (const part of recomputed) {
    const storedGroups = new Set(
      part
        .map((id) => audit.graph.groupOf.get(id))
        .filter((id): id is string => id !== undefined)
    );
    const stored = storedGroups.size === 1 ? [...storedGroups][0]! : null;
    const sameMembers =
      stored !== null &&
      audit.groups.get(stored)?.members.length === part.length;
    if (sameMembers) continue;
    const involved = [...storedGroups];
    if (involved.some(pendingGroup)) {
      reports.push({
        check: "drift_pending",
        detail: `${part.length} characters around ${describe(part[0]!)}`
      });
      continue;
    }
    // Manual-only drift: the stored groups are coarser than recomputed only
    // across pairs that share no observed link (a removed manual row leaves
    // no other trace).
    const observed = new Set(
      audit.observations.map((row) => `${row.lowId}\0${row.highId}`)
    );
    const storedMembers = involved.flatMap(
      (id) => audit.groups.get(id)?.members ?? []
    );
    const separated = storedMembers.filter((id) => !part.includes(id));
    const acrossObserved = separated.some((out) =>
      part.some((inner) =>
        observed.has(inner < out ? `${inner}\0${out}` : `${out}\0${inner}`)
      )
    );
    if (separated.length > 0 && !acrossObserved) {
      reports.push({
        check: "drift_manual",
        detail: `${separated.length} characters apart from ${describe(part[0]!)}`
      });
      continue;
    }
    failures.push({
      check: "drift",
      detail: `${part.length} recomputed vs stored around ${describe(part[0]!)}`
    });
  }
  return { failures, reports };
}

export function comparePages(
  audit: CharacterGroupsAudit,
  legacy: ReadonlyMap<string, ResolvedSubjects | null>,
  config: { DOSSIER_CHARACTER_CEILING: number }
) {
  const failures: ReplayFinding[] = [];
  const reports: ReplayFinding[] = [];
  const counts: Record<string, number> = {
    pages: 0,
    unchanged: 0,
    grew: 0,
    sharedExclusions: 0,
    selfExclusions: 0
  };
  const rank = {
    raiderio_declared: 3,
    fingerprint_derived: 2,
    manually_added: 1,
    submitted: 0
  } as const;
  const label = (source: RankedSubject["source"]) =>
    source === "submitted"
      ? "submitted"
      : source === "manually_added"
        ? "manually_added"
        : source === "fingerprint"
          ? "fingerprint_derived"
          : "raiderio_declared";
  for (const key of audit.roots) {
    const id = canonicalCharacterId(key);
    const today = legacy.get(id) ?? null;
    if (!today) continue;
    counts.pages! += 1;
    const next = resolveGroupSubjects(key, audit.graph, config);
    const todayAll = [...today.selected, ...today.skipped];
    const nextAll = next
      ? [...next.selected, ...next.skipped, ...next.excluded]
      : [];
    const nextById = new Map(
      nextAll.map((subject) => [canonicalCharacterId(subject.key), subject])
    );
    for (const subject of [...todayAll, ...today.excludedOrdered]) {
      const found = nextById.get(canonicalCharacterId(subject.key));
      if (!found) {
        failures.push({
          check: "removed",
          detail: `${fmt(subject.key)} from ${fmt(key)}`
        });
        continue;
      }
      if (
        found.source !== "input" &&
        rank[label(found.source)] < rank[label(subject.source)] &&
        subject.source !== "input"
      ) {
        failures.push({
          check: "label_weakened",
          detail: `${fmt(subject.key)} on ${fmt(key)}`
        });
      }
    }
    const newlyExcluded = (next?.excluded ?? []).filter(
      (subject) =>
        !today.excludedOrdered.some(
          (old) =>
            canonicalCharacterId(old.key) === canonicalCharacterId(subject.key)
        )
    );
    counts.sharedExclusions! += newlyExcluded.length;
    if (newlyExcluded.length > 0)
      reports.push({
        check: "shared_exclusion",
        detail: `${newlyExcluded.length} on ${fmt(key)}`
      });
    const todayCode = today.snapshot.limitationCode;
    if (
      todayCode &&
      next &&
      !next.research.limitationCodes.includes(todayCode) &&
      newlyExcluded.length === 0
    ) {
      failures.push({
        check: "limitation_missing",
        detail: `${todayCode} on ${fmt(key)}`
      });
    }
    if (next && next.skipped.length > 0)
      failures.push({ check: "over_ceiling", detail: `${fmt(key)}` });
    if (nextAll.length > todayAll.length + today.excludedOrdered.length)
      counts.grew! += 1;
    else counts.unchanged! += 1;
  }
  return { failures, reports, counts };
}

export function replayCharacterGroups(
  audit: CharacterGroupsAudit,
  legacy: ReadonlyMap<string, ResolvedSubjects | null>,
  config: { DOSSIER_CHARACTER_CEILING: number }
): ReplayReport {
  const ledger = auditLedger(audit);
  const drift = auditDrift(audit);
  const pages = comparePages(audit, legacy, config);
  return {
    failures: [...pages.failures, ...ledger.failures, ...drift.failures],
    reports: [...pages.reports, ...drift.reports],
    counts: pages.counts,
    coverage: ledger.coverage
  };
}

function fmt(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}
function describer(audit: CharacterGroupsAudit) {
  return (id: string) => {
    if (audit.graph.suppressed.has(id)) return "(suppressed)";
    const character = audit.graph.characters.get(id);
    return character ? fmt(character.key) : "(unknown)";
  };
}
```

`audit.roots` excludes suppressed characters (see the loader). `comparePages` only prints keys from `roots` and their legacy subjects, and legacy reads already filter suppression, so no suppressed key is printed.

- [ ] **Step 4: Implement the loader**

`packages/database/src/character-groups-audit.ts`: one `withConsistentRead(pool, …)`, running these queries and assembling `CharacterGroupsAudit`:

- **characters:** `SELECT id, region, realm_slug, normalized_name, display_name, class_name, level, raider_io_url FROM characters`.
- **membership and groups:** `SELECT character_id, group_id FROM character_group_members`, and `SELECT id, recomputed_at FROM character_groups`.
- **links:** `COUNTING_LINKS` without the `= ANY` filters, labelling each row's strength. Observed rows get `raiderio` or `fingerprint` by source; manual rows get `manual`.
- **manual rows:** `SELECT manual.root_character_id AS maker, target.id AS target, manual.excluded_at IS NOT NULL AS excluded FROM manual_dossier_connections manual JOIN characters target ON …`.
- **discovered exclusions:** join `dossier_character_exclusions`, whose columns are in `schema.ts:258-280`, to `characters` by key.
- **suppressed ids:** `SELECT c.id FROM characters c JOIN suppressed_characters s ON s.region = c.region AND s.realm_slug = c.realm_slug AND s.normalized_name = c.normalized_name WHERE s.expires_at IS NULL OR s.expires_at > now()`.
- **Warcraft Logs ids:** `SELECT c.id, w.character_id FROM warcraft_logs_character_ids w JOIN characters c ON …`, giving `sharedIdentity(id)` as every id with the same Warcraft Logs id, plus itself.
- **latest snapshot per root, suppression-filtered:** the migration's `latest` query, plus `state` and `limitation_code`, excluding suppressed roots.
- **raw membership:** the same latest snapshots, unfiltered, joined to `snapshot_characters`.
- **observations:** `SELECT character_low_id, character_high_id, source, observed_from_character_id, discovery_run_id, observed_at FROM character_connections WHERE kind = 'observed'`.
- **ledger:** everything in `character_connection_write_log`.
- **publications:**
  - `SELECT id, root_character_id, completed_at FROM discovery_runs WHERE status = 'complete' AND root_character_id IS NOT NULL`, as `kind: "run"`;
  - `SELECT reservation.id, admission.discovery_run_id, run.root_character_id, reservation.finished_at FROM fingerprint_sweep_reservations reservation JOIN fingerprint_sweep_admissions admission ON admission.id = reservation.admission_id JOIN discovery_runs run ON run.id = admission.discovery_run_id WHERE reservation.published`, as `kind: "reservation"`.

  A publication's `at` is `completed_at` for a run and `finished_at` for a reservation, which covers amends.

- **maintenance:** `SELECT last_cycle_started_at, last_cycle_completed_at FROM character_groups_maintenance WHERE id = 1`.
- **roots:** the distinct characters of every latest snapshot, minus suppressed ones.

- [ ] **Step 5: Write the integration test**

`tests/integration/character-groups-replay.test.ts`. Seed the repository database and run the full pipeline: publish through `repositories.snapshots.*`, write through `characterConnections`, recompute, load the audit, build the `legacy` map with `legacyResolveSubjects` for every root, and call `replayCharacterGroups`. Cover these fixtures, one `it` each, each asserting `failures` is empty unless the test names a failure:

1. **Identical shapes:** two roots whose snapshots hold the same three characters.
2. **Containing shapes:** a 2-member dossier inside a 5-member one. Expect the smaller to be reported as `grew` and the larger `unchanged`.
3. **A manual connection**, which must not be removed.
4. **A `not_due` refresh:** a Raider.IO-only snapshot after a swept one. The fingerprint links survive, and the ledger shows `raiderio_complete` then nothing on fingerprint.
5. **A capped sweep and a continuation:** cycle 1 `capped`, then an amend.
6. **A character found by both sources:** presence passes.
7. **A live-sweep completion that finds a new alt:** the alt has a `characters` row seeded by another snapshot. Provenance passes.
8. **An unread sweep:** `unreadRoot: true` writes `added_only`/`unread`, and nothing is retracted.
9. **Suppression:** a suppressed member and a suppressed root, with no key printed. Assert that no finding's detail contains the suppressed names.
10. **A write still pending:** a publication 1 minute old with no ledger row is skipped by (a).
11. **A historic alias:** a Warcraft Logs id shared by two keys. Excluded state follows the alias.
12. **Both kinds of exclusion:** a discovered exclusion from a sibling is reported as `shared_exclusion`, not failed.
13. **A worker killed between the snapshot commit and the write:** publish, don't write. Expect an `a_completeness` failure.
14. **A worker killed between the write and the recompute:** write, don't recompute. Expect `drift_pending`, then run `recomputePass` to completion and expect no drift.

Break-caught comments go on 6, 7, 13 and 14.

- [ ] **Step 6: Run the tests and see them pass**

Run: `corepack pnpm exec vitest run --project unit packages/application/src/character-groups-replay.test.ts`
Then: `corepack pnpm exec vitest run --project integration tests/integration/character-groups-replay.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
corepack pnpm typecheck && corepack pnpm lint
git add packages/database/src/character-groups-audit.ts packages/database/src/index.ts packages/application/src/character-groups-replay.ts packages/application/src/character-groups-replay.test.ts packages/application/src/index.ts tests/integration/character-groups-replay.test.ts
git commit -m "feat: character groups replay with ledger, drift and page checks (#738)" -m "Compares today's dossier membership with phase 2's group resolution page by page, and audits the writes from the ledger: completeness from the newest backfill or rebuild, presence over raw membership, provenance and applied retraction. Drift is pending until a cursor cycle that started after the write completes, and manual-only drift is reported, not failed." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The command-line scripts and the runbook

**Files:**

- Create: `scripts/diagnostics/character-groups-replay.mts`
- Create: `scripts/rebuild-character-groups.mts`
- Modify: `package.json`, adding `"ops:replay-groups": "tsx scripts/diagnostics/character-groups-replay.mts"` and `"ops:rebuild-groups": "tsx scripts/rebuild-character-groups.mts"`
- Create: `docs/operations/character-groups.md`

- [ ] **Step 1: Write the scripts**

Follow `scripts/removals.mts:62-100` (queue-free) and `scripts/lib/cli.mts` (`runIfMain` and `requiredEnvironment`).

`scripts/rebuild-character-groups.mts`:

```ts
#!/usr/bin/env tsx
// Rebuild character groups from snapshots and manual connections (#738).
// Run: corepack pnpm ops:rebuild-groups   (with DATABASE_URL set; see the runbook)
import { Pool } from "pg";
import { createPostgresRepositories } from "@slashwho/database";
import { requiredEnvironment, runIfMain } from "./lib/cli.mts";

export async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL")
  });
  try {
    const connections = createPostgresRepositories(pool).characterConnections;
    if (!connections) throw new Error("character_connections_unavailable");
    const result = await connections.rebuild();
    process.stdout.write(
      `${JSON.stringify({ event: "character_groups_rebuilt", ...result })}\n`
    );
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_rebuild_failed");
```

`scripts/diagnostics/character-groups-replay.mts`:

```ts
#!/usr/bin/env tsx
// Replay character groups against today's dossiers, read-only (#738).
// Run: corepack pnpm ops:replay-groups   (with DATABASE_URL set; see the runbook)
// Exits 1 on any failure. Never prints a suppressed character's key.
import { Pool } from "pg";
import { canonicalCharacterId } from "@slashwho/domain";
import {
  createPostgresRepositories,
  loadCharacterGroupsAudit
} from "@slashwho/database";
import {
  legacyResolveSubjects,
  replayCharacterGroups
} from "@slashwho/application";
import { requiredEnvironment, runIfMain } from "../lib/cli.mts";

const CONFIG = { DOSSIER_CHARACTER_CEILING: 50 };

export async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL")
  });
  try {
    const repositories = createPostgresRepositories(pool);
    const audit = await loadCharacterGroupsAudit(pool);
    const legacy = new Map();
    for (const key of audit.roots) {
      legacy.set(
        canonicalCharacterId(key),
        await legacyResolveSubjects(key, repositories, CONFIG)
      );
    }
    const report = replayCharacterGroups(audit, legacy, CONFIG);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

runIfMain(import.meta.url, main, "character_groups_replay_failed");
```

`legacyResolveSubjects` only reads: `snapshots.getCurrent`, `getCurrentDeclaringCharacter`, `manualConnections.list`, `listDiscoveredExclusions` and `evidence.warcraftLogsCharacterIds`. Confirm by reading the moved body from Task 8. The replay never constructs the dossier service, which would reserve evidence and schedule sweeps.

`scripts/` is typechecked through `tsconfig.tools.json`. Check that `@slashwho/application` and `@slashwho/database` resolve from scripts, as `scripts/rebuild-character.mts` already imports `@slashwho/database`. If `@slashwho/application` doesn't resolve, add it the way that script imports its dependencies.

- [ ] **Step 2: Typecheck the scripts**

Run: `corepack pnpm typecheck`
Expected: PASS, including `tsconfig.tools.json`.

- [ ] **Step 3: Write the runbook**

`docs/operations/character-groups.md` (UK English). It has these sections:

- **What phase 1 is:** the worker writes groups best effort, nothing reads them, and the replay is the gate.
- **Reaching the test database:**
  - export `DATABASE_URL` from Railway's `DATABASE_PUBLIC_URL`, exactly as `docs/operations/removals.md:9-21` does;
  - unset it afterwards.
- **After the deploy:**
  1. Confirm the worker and web are both on the phase 1 commit (`railway deployment list -s worker -e test`), with no older worker still running.
  2. Run `corepack pnpm ops:rebuild-groups` once, when test is quiet. The three-day window starts from this rebuild's `written_at`.
  3. Run `corepack pnpm ops:replay-groups`, and keep its JSON.
- **Daily:** run the replay, and search the worker logs for `character_groups_write_failed`, using the per-deployment logs with the `--since`/`--until` paging from the evidence-metrics notes. A failure, or an `a_completeness` finding, means: fix the cause, rebuild, and restart the three days.
- **Triggering each risky path.** Each path needs at least one publication in the window, and the replay's `coverage` shows which appeared:
  - **A first sweep cycle.** Search, on the test site, a character that has never been swept (no `fingerprint_sweep_states` row). Coverage: `sweep_publication`, plus `matched` or `capped`.
  - **A capped sweep, a continuation and a seal.** Search a character whose guild roster exceeds `BLIZZARD_SWEEP_REQUEST_CAP` (300), such as one in a large guild. Cycle 1 publishes `capped`. The admission worker then runs continuation cycles (`capped`) until a cycle ends `matched` (the seal). Watch the admission logs for `fingerprint_admission` records.
  - **A live-sweep completion.** More than `FRESHNESS_HOURS` (24 h) after the capped search above, while its chain is still continuing, search the same character again. The run completes against the live snapshot. Coverage: `live_sweep_completion`.
  - **A `not_due` refresh.** Search a character swept within the last 7 days whose dossier is over 24 hours old; for example, repeat a first-cycle search the next day. Coverage: `raiderio_complete` or `privacy_hidden` on a run with no fingerprint row.
  - **A privacy-hidden run.** Search a character with no public Raider.IO claim, such as one whose dossier today reads "Raider.IO shows no public account claim". Coverage: `privacy_hidden`.
  - **Manual connection add and remove.** On any dossier page, add a connected character, and later remove one. Check that the next maintenance cycle's `character_groups_recompute` record appears, and that the replay shows no failing drift.
- **Exit criteria.** From the spec, with Low 1:
  - three consecutive days of passing replays;
  - no failing drift after each completed cursor cycle;
  - no `character_groups_write_failed` and no `a_completeness` finding;
  - every path above in `coverage`;
  - the integration suite passing.
- **Log records:**
  - `character_groups_recompute` with `groupsRecomputed`, `cycleCompleted` and `durationMs`;
  - `character_groups_write` with `unknownCharacters`;
  - `character_groups_write_failed` with `errorName`.
- **Rollback:** revert the code. The tables go stale, and nothing reads them. After a roll-forward, rebuild and restart the three days.

- [ ] **Step 4: Format and commit**

```bash
corepack pnpm format:check || corepack pnpm exec prettier --write docs/operations/character-groups.md scripts/rebuild-character-groups.mts scripts/diagnostics/character-groups-replay.mts
git add scripts/rebuild-character-groups.mts scripts/diagnostics/character-groups-replay.mts package.json docs/operations/character-groups.md
git commit -m "feat: character groups rebuild and replay commands, with the phase 1 runbook (#738)" -m "The runbook covers the post-deploy rebuild that starts the three-day window, the daily replay, how to trigger every publication path on test, the exit criteria and rollback." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The full gate, review and merge from main

**Files:** none new.

- [ ] **Step 1: Run the whole gate**

Docker must be running for the integration and end-to-end suites.

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm build
corepack pnpm test:e2e
```

Expected: every one passes. Read the output: a skipped suite is not a passing one.

- [ ] **Step 2: Review**

Run `/code-review low` in the session. Act on each finding. If code changes, run the whole gate again.

- [ ] **Step 3: Merge `origin/main`, and recheck the migration number**

```bash
git fetch origin
git merge origin/main
ls packages/database/drizzle | tail -3
```

If a `0067_*` migration arrived from main, renumber this one to the next free number: the file name, the journal `idx`, a `when` strictly greater than the previous entry, the `slice(-N)` and appended entry in `tests/integration/migrations.test.ts`, the migration path in `character-groups-backfill-sql.test.ts`, and this plan's references. Then run the whole gate again.

- [ ] **Step 4: Open the pull request**

```bash
git push -u origin feat/738-character-groups-phase-1
gh pr create --base main --title "feat: character groups phase 1, write connections and groups, read nothing (#738)" --body "$(cat <<'EOF'
Phase 1 of #738 (spec: docs/superpowers/specs/2026-09-28-character-groups-design.md). The worker records each discovery's observed links, a per-family ledger, and the groups they form, best effort after every committed publication. Nothing reads them. A read-only replay (`corepack pnpm ops:replay-groups`) compares phase 2's group dossiers with today's, page by page, and audits the writes.

No page, response, publication or evidence behaviour changes. Migration 0067 creates six tables and inserts only.

After deploy: run `corepack pnpm ops:rebuild-groups` once, then follow docs/operations/character-groups.md for the three-day exit criteria.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Don't set auto-merge. The PR Manager decides the merge.
