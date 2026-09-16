# Fingerprint Sweep Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fingerprint sweep that hits `BLIZZARD_SWEEP_REQUEST_CAP` resumes from a persisted cursor on a follow-up cycle instead of permanently abandoning the alphabetical tail of the guild roster.

**Architecture:** `discoverFingerprintMatches` returns the canonical id of the last candidate it swept. The handler persists that cursor beside the snapshot it published, then re-enqueues the run as a *continuation* discovery job. A continuation skips Raider.IO re-discovery and the completed-run guard, resumes the sweep past the cursor, and amends the existing snapshot in place. The chain seals when the roster is exhausted.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (`unit` and `integration` projects), Drizzle migrations over PostgreSQL, pg-boss queue.

**Spec:** `docs/superpowers/specs/2026-09-16-fingerprint-sweep-continuation-design.md`

## Global Constraints

- Candidate ordering stays `compareCandidates` (sort by `canonicalCharacterId`). The cursor's stability depends on it. Do not change it.
- The cursor is the last candidate that **consumed a request**, including 404s and non-matches — not the last candidate that matched.
- `resumeAfter` is **optional** on a `capped` outcome. The roster fetch and the root fingerprint fetch both return `capped` before any candidate is swept; those carry no cursor and must leave the stored cursor unchanged.
- Amending must never touch `discovery_runs`. Cycle 1 completes the run; later cycles only append to the snapshot.
- Every new repository write is one transaction, matching the atomicity contract of `createAndFinishFingerprintSweep`.
- Run `pnpm lint` and `pnpm typecheck` before each commit.
- Integration tests need Docker (Testcontainers `postgres:16-alpine`).

---

### Task 1: Return a resume cursor from the sweep

**Files:**
- Modify: `packages/domain/src/fingerprint-discovery.ts`
- Test: `packages/domain/src/fingerprint-discovery.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DiscoverFingerprintMatchesOptions.resumeAfter?: string`; the `capped` variant of `FingerprintSweepOutcome` gains `resumeAfter?: string`.

There are **two** ways the sweep ends capped and both must carry the cursor: the in-function budget running out (`candidateFingerprint === budgetExhausted` → `break`) and the adapter throwing `fingerprint_cap_reached` (caught in the outer `catch`). Track the last swept id in one variable so both exits read it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/domain/src/fingerprint-discovery.test.ts`:

```ts
it("reports the last swept candidate when the cap is reached", async () => {
  const a: CharacterKey = { region: "eu", realm: "silvermoon", name: "aaa" };
  const z: CharacterKey = { region: "eu", realm: "silvermoon", name: "zzz" };
  const gateway = gatewayFor([candidate(a), candidate(z)], {
    [keyId(root)]: fingerprint(300),
    [keyId(a)]: fingerprint(300),
    [keyId(z)]: fingerprint(300)
  });

  // 1 roster + 1 root fingerprint + 1 candidate = 3
  const outcome = await discoverFingerprintMatches(root, gateway, {
    ...options,
    requestCap: 3
  });

  expect(outcome.kind).toBe("capped");
  expect(outcome).toMatchObject({
    resumeAfter: JSON.stringify(["eu", "silvermoon", "aaa"])
  });
});

it("resumes strictly after the cursor", async () => {
  const a: CharacterKey = { region: "eu", realm: "silvermoon", name: "aaa" };
  const z: CharacterKey = { region: "eu", realm: "silvermoon", name: "zzz" };
  const gateway = gatewayFor([candidate(a), candidate(z)], {
    [keyId(root)]: fingerprint(300),
    [keyId(a)]: fingerprint(300),
    [keyId(z)]: fingerprint(300)
  });

  const outcome = await discoverFingerprintMatches(root, gateway, {
    ...options,
    requestCap: 10,
    resumeAfter: JSON.stringify(["eu", "silvermoon", "aaa"])
  });

  expect(outcome.kind).toBe("matched");
  expect(outcome.characters.map((match) => match.key.name)).toEqual(["zzz"]);
});

it("advances the cursor past a candidate with no achievement profile", async () => {
  const missing: CharacterKey = { region: "eu", realm: "silvermoon", name: "aaa" };
  const z: CharacterKey = { region: "eu", realm: "silvermoon", name: "zzz" };
  const gateway = gatewayFor([candidate(missing), candidate(z)], {
    [keyId(root)]: fingerprint(300),
    [keyId(z)]: fingerprint(300)
    // `missing` deliberately absent -> gateway throws { kind: "not_found" }
  });

  const outcome = await discoverFingerprintMatches(root, gateway, {
    ...options,
    requestCap: 3
  });

  expect(outcome.kind).toBe("capped");
  expect(outcome).toMatchObject({
    resumeAfter: JSON.stringify(["eu", "silvermoon", "aaa"])
  });
});

it("seals without a cursor when the cursor is past the roster end", async () => {
  const a: CharacterKey = { region: "eu", realm: "silvermoon", name: "aaa" };
  const gateway = gatewayFor([candidate(a)], {
    [keyId(root)]: fingerprint(300),
    [keyId(a)]: fingerprint(300)
  });

  const outcome = await discoverFingerprintMatches(root, gateway, {
    ...options,
    requestCap: 10,
    resumeAfter: JSON.stringify(["eu", "silvermoon", "zzz"])
  });

  expect(outcome).toMatchObject({ kind: "matched", characters: [] });
  expect(outcome).not.toHaveProperty("resumeAfter");
});

it("omits the cursor when the budget ends before the first candidate", async () => {
  const a: CharacterKey = { region: "eu", realm: "silvermoon", name: "aaa" };
  const gateway = gatewayFor([candidate(a)], {
    [keyId(root)]: fingerprint(300),
    [keyId(a)]: fingerprint(300)
  });

  // 1 roster + 1 root fingerprint exhausts the budget
  const outcome = await discoverFingerprintMatches(root, gateway, {
    ...options,
    requestCap: 2
  });

  expect(outcome.kind).toBe("capped");
  expect(outcome).not.toHaveProperty("resumeAfter");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project unit packages/domain/src/fingerprint-discovery.test.ts`
Expected: FAIL — `resumeAfter` is not an accepted option and is absent from outcomes.

- [ ] **Step 3: Add the cursor to the types**

In `packages/domain/src/fingerprint-discovery.ts`:

```ts
export type DiscoverFingerprintMatchesOptions = {
  requestCap: number;
  minimumCommon: number;
  minimumIdenticalPercent: number;
  isSuppressed(key: CharacterKey): Promise<boolean>;
  signal?: AbortSignal;
  /**
   * Canonical id of the last candidate a previous cycle swept. Resumption is
   * strictly greater than this, so a candidate is never swept twice.
   */
  resumeAfter?: string;
};
```

and on the outcome:

```ts
  | {
      kind: "capped";
      characters: readonly DiscoveredCharacter[];
      requestsUsed: number;
      /**
       * Absent when the budget ended before any candidate was swept: the
       * roster and root-fingerprint fetches both cap out ahead of the loop.
       * A capped outcome with no cursor must leave a stored cursor unchanged.
       */
      resumeAfter?: string;
    }
```

- [ ] **Step 4: Implement resumption and cursor tracking**

Declare the tracker next to `matches` in `discoverFingerprintMatches`:

```ts
  const matches: DiscoveredCharacter[] = [];
  let lastSweptId: string | undefined;
```

Filter after the existing sort:

```ts
    const rootId = canonicalCharacterId(root);
    const sorted = [...roster].sort(compareCandidates);
    const candidates = options.resumeAfter
      ? sorted.filter(
          (item) => canonicalCharacterId(item.key) > options.resumeAfter!
        )
      : sorted;
```

Set the tracker immediately after the request that consumes the budget, so a
`not_found` candidate still advances it. Replace the existing `try`/`catch`
around the candidate fingerprint with:

```ts
      let candidateFingerprint:
        ReadonlyMap<number, number> | typeof budgetExhausted;
      try {
        candidateFingerprint = await request(() =>
          gateway.getAchievementFingerprint(candidate.key, options.signal)
        );
      } catch (error) {
        if (isNotFound(error)) {
          lastSweptId = candidateId;
          continue;
        }
        throw error;
      }
      if (candidateFingerprint === budgetExhausted) break;
      lastSweptId = candidateId;
```

`request()` sets `capped` and returns `budgetExhausted` *without* calling the
gateway, so the `break` above correctly leaves the cursor on the previous
candidate.

Return the cursor from both capped exits. In the outer `catch`:

```ts
    if (
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      error.kind === "fingerprint_cap_reached"
    ) {
      return {
        kind: "capped",
        characters: matches,
        requestsUsed,
        ...(lastSweptId === undefined ? {} : { resumeAfter: lastSweptId })
      };
    }
```

and at the end:

```ts
  return capped
    ? {
        kind: "capped",
        characters: matches,
        requestsUsed,
        ...(lastSweptId === undefined ? {} : { resumeAfter: lastSweptId })
      }
    : { kind: "matched", characters: matches, requestsUsed };
```

Leave the two early `return { kind: "capped", characters: [], requestsUsed }`
exits (roster and root fingerprint) untouched — they correctly carry no cursor.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit packages/domain/src/fingerprint-discovery.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/domain/src/fingerprint-discovery.ts packages/domain/src/fingerprint-discovery.test.ts
git commit -m "feat: return a resume cursor when a fingerprint sweep caps"
```

---

### Task 2: Persist the cursor columns

**Files:**
- Create: `packages/database/drizzle/0018_fingerprint_sweep_cursor.sql`
- Modify: `packages/database/src/schema.ts:278-295`
- Test: `tests/integration/migrations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fingerprint_sweep_states.resume_after` (text, nullable), `.resume_snapshot_id` (uuid, nullable, FK to `snapshots`), and `.resume_limitation_code` (text, nullable).

`resume_limitation_code` carries cycle 1's **Raider.IO** limitation forward.
Cycle 1 overwrites `snapshots.limitation_code` with `fingerprint_sweep_capped`,
destroying whatever `discoverCharacter` observed (e.g. `privacy_hidden`). Without
somewhere to park it, the sealing cycle has nothing truthful to restore and the
dossier can never report complete research again.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/migrations.test.ts`:

```ts
it("adds the fingerprint sweep cursor columns", async () => {
  const columns = await pool.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'fingerprint_sweep_states'
       AND column_name IN
         ('resume_after', 'resume_limitation_code', 'resume_snapshot_id')
     ORDER BY column_name`
  );
  expect(columns.rows).toEqual([
    { column_name: "resume_after", is_nullable: "YES" },
    { column_name: "resume_limitation_code", is_nullable: "YES" },
    { column_name: "resume_snapshot_id", is_nullable: "YES" }
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/migrations.test.ts`
Expected: FAIL — the query returns zero rows.

- [ ] **Step 3: Write the migration**

Create `packages/database/drizzle/0018_fingerprint_sweep_cursor.sql`:

```sql
ALTER TABLE "fingerprint_sweep_states" ADD COLUMN "resume_after" text;
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_states" ADD COLUMN "resume_limitation_code" text;
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_states" ADD COLUMN "resume_snapshot_id" uuid;
--> statement-breakpoint
ALTER TABLE "fingerprint_sweep_states"
  ADD CONSTRAINT "fingerprint_sweep_states_resume_snapshot_id_fk"
  FOREIGN KEY ("resume_snapshot_id") REFERENCES "snapshots"("id")
  ON DELETE SET NULL;
```

`ON DELETE SET NULL` makes a continuation whose snapshot was reaped a no-op
rather than an FK error.

- [ ] **Step 4: Update the Drizzle schema**

In `packages/database/src/schema.ts`, inside `fingerprintSweepStates`:

```ts
    lastPublishedAt: timestamp("last_published_at", {
      withTimezone: true
    }),
    resumeAfter: text("resume_after"),
    resumeLimitationCode: text("resume_limitation_code"),
    resumeSnapshotId: uuid("resume_snapshot_id").references(() => snapshots.id, {
      onDelete: "set null"
    })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:integration tests/integration/migrations.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database/drizzle/0018_fingerprint_sweep_cursor.sql packages/database/src/schema.ts tests/integration/migrations.test.ts
git commit -m "feat: add fingerprint sweep cursor columns"
```

---

### Task 3: Read and write the cursor

**Files:**
- Modify: `packages/database/src/repositories.ts:56-64,79-92,329-348`
- Modify: `packages/database/src/postgres-repositories.ts:856-900,1365-1392`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**
- Consumes: Task 2's columns.
- Produces:
  - `FingerprintSweepRepository.getResumeState(key: CharacterKey): Promise<{ resumeAfter: string; snapshotId: string; limitationCode: string | null } | null>`
  - `createAndFinishFingerprintSweep(input, fingerprint, cursor, options?)` where `cursor` is `FingerprintSweepCursor`
  - `finishFingerprintSweep(client, reservationId, input)` gains `resumeAfter: string | null`, `resumeLimitationCode: string | null` and `resumeSnapshotId: string | null` on `input`.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/repositories.test.ts`:

```ts
it("persists and clears the fingerprint sweep cursor", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "cursorroot" } as const;
  const runId = await seedActiveRun(repositories, key);

  const admission = await repositories.fingerprintSweeps.requestAdmission({
    runId,
    key,
    requestCap: 10,
    hourlyBudget: 100,
    cadenceCutoff: new Date(Date.now() - 60_000),
    at: new Date()
  });
  expect(admission.kind).toBe("admitted");

  const snapshot = await repositories.snapshots.createAndFinishFingerprintSweep(
    {
      runId,
      rootKey: key,
      state: "partial",
      limitationCode: "fingerprint_sweep_capped",
      refreshedAt: new Date(),
      characters: [snapshotCharacter(key, "input")]
    },
    {
      reservationId: (admission as { reservationId: string }).reservationId,
      finishedAt: new Date(),
      limitationCode: "fingerprint_sweep_capped"
    },
    {
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      limitationCode: "privacy_hidden"
    }
  );

  await expect(
    repositories.fingerprintSweeps.getResumeState(key)
  ).resolves.toEqual({
    resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
    snapshotId: snapshot.id,
    limitationCode: "privacy_hidden"
  });
});

it("returns no resume state when the cursor was never set", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "nocursor" } as const;
  await expect(
    repositories.fingerprintSweeps.getResumeState(key)
  ).resolves.toBeNull();
});
```

Reuse whatever `seedActiveRun` / `snapshotCharacter` helpers the file already
defines; if they are named differently, follow the file's existing convention
rather than adding new helpers.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/repositories.test.ts`
Expected: FAIL — `getResumeState` is not a function.

- [ ] **Step 3: Extend the interfaces**

In `packages/database/src/repositories.ts`:

```ts
export interface FingerprintSweepCursor {
  /** Canonical id of the last candidate swept, or null to seal the sweep. */
  resumeAfter: string | null;
  /**
   * The Raider.IO limitation observed by the run that started this sweep.
   * `snapshots.limitation_code` is overwritten with `fingerprint_sweep_capped`
   * while the chain runs, so this is the only surviving copy and it is what the
   * sealing cycle restores.
   */
  limitationCode: string | null;
}
```

Add to `FingerprintSweepRepository`:

```ts
  getResumeState(key: CharacterKey): Promise<{
    resumeAfter: string;
    snapshotId: string;
    limitationCode: string | null;
  } | null>;
```

Change the `SnapshotRepository` signature:

```ts
  createAndFinishFingerprintSweep(
    input: CreateSnapshotInput,
    fingerprint: {
      reservationId: string;
      finishedAt: Date;
      limitationCode: string | null;
    },
    cursor: FingerprintSweepCursor,
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot>;
```

- [ ] **Step 4: Implement**

In `packages/database/src/postgres-repositories.ts`, widen
`finishFingerprintSweep`'s `input` to include
`resumeAfter: string | null` and `resumeSnapshotId: string | null`, and replace
its `fingerprint_sweep_states` upsert with:

```ts
  if (input.published) {
    await client.query(
      `INSERT INTO fingerprint_sweep_states
        (region, realm_slug, normalized_name, last_published_at,
         resume_after, resume_limitation_code, resume_snapshot_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (region, realm_slug, normalized_name)
       DO UPDATE SET
         last_published_at = greatest(
           fingerprint_sweep_states.last_published_at,
           EXCLUDED.last_published_at
         ),
         resume_after = EXCLUDED.resume_after,
         resume_limitation_code = EXCLUDED.resume_limitation_code,
         resume_snapshot_id = EXCLUDED.resume_snapshot_id`,
      [
        row.region,
        row.realm_slug,
        row.normalized_name,
        input.at,
        input.resumeAfter,
        input.resumeLimitationCode,
        input.resumeSnapshotId
      ]
    );
  }
```

Keep the rest of the existing upsert exactly as it is; only the two new columns
are added. `resume_after = NULL` is how the chain seals.

In `createAndFinishFingerprintSweep`, accept `cursor` and pass the snapshot id
through — the snapshot must exist before the cursor can reference it, which the
existing ordering already gives:

```ts
      async createAndFinishFingerprintSweep(input, fingerprint, cursor, options) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");
          await lockRoot(client, input.rootKey);
          await lockFingerprintSweeps(client);
          const snapshot = await createSnapshot(client, input, options);
          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode,
            resumeAfter: cursor.resumeAfter,
            resumeLimitationCode:
              cursor.resumeAfter === null ? null : cursor.limitationCode,
            resumeSnapshotId: cursor.resumeAfter === null ? null : snapshot.id
          });
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
          return snapshot;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
```

Every other caller of `finishFingerprintSweep` (the `release`/`finish` paths)
passes `resumeAfter: null, resumeLimitationCode: null, resumeSnapshotId: null`.
The public `finish` may publish, so those nulls correctly clear any stored cursor
— a sweep finished outside the continuation path is not resumable.

Add `getResumeState` to the fingerprint sweep repository:

```ts
      async getResumeState(key) {
        const result = await pool.query<{
          resume_after: string | null;
          resume_limitation_code: string | null;
          resume_snapshot_id: string | null;
        }>(
          `SELECT resume_after, resume_limitation_code, resume_snapshot_id
           FROM fingerprint_sweep_states
           WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3`,
          [key.region, key.realm, key.name]
        );
        const row = result.rows[0];
        if (!row?.resume_after || !row.resume_snapshot_id) return null;
        return {
          resumeAfter: row.resume_after,
          snapshotId: row.resume_snapshot_id,
          limitationCode: row.resume_limitation_code
        };
      },
```

`resume_limitation_code` is legitimately null (a complete Raider.IO discovery has
no limitation), so it must NOT join the guard above — only `resume_after` and
`resume_snapshot_id` decide whether a sweep is resumable.

Both columns must be present: a cursor without its snapshot (the
`ON DELETE SET NULL` case) is not resumable.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/repositories.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix the existing call sites**

Run: `pnpm typecheck`
Expected: errors at every `createAndFinishFingerprintSweep` call. Pass
`{ resumeAfter: null, limitationCode: null }` at each — the handler gets its real
cursor in Task 7.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database/src tests/integration/repositories.test.ts
git commit -m "feat: persist and read the fingerprint sweep cursor"
```

---

### Task 4: Amend a published snapshot

**Files:**
- Modify: `packages/database/src/repositories.ts:79-92`
- Modify: `packages/database/src/postgres-repositories.ts:1365-1392`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**
- Consumes: Task 3's `FingerprintSweepCursor` and cursor-aware `finishFingerprintSweep`.
- Produces: `SnapshotRepository.amendAndFinishFingerprintSweep(snapshotId, characters, fingerprint, cursor, options?): Promise<StoredSnapshot>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/repositories.test.ts`:

```ts
it("appends characters to a published snapshot and seals the sweep", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "amendroot" } as const;
  const alt = { region: "eu", realm: "draenor", name: "amendalt" } as const;
  const runId = await seedActiveRun(repositories, key);
  const first = await admitSweep(repositories, runId, key);

  const published = await repositories.snapshots.createAndFinishFingerprintSweep(
    {
      runId,
      rootKey: key,
      state: "partial",
      limitationCode: "fingerprint_sweep_capped",
      refreshedAt: new Date(),
      characters: [snapshotCharacter(key, "input")]
    },
    first,
    {
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      limitationCode: null
    }
  );

  const second = await admitSweep(repositories, runId, key);
  const amended = await repositories.snapshots.amendAndFinishFingerprintSweep(
    published.id,
    [snapshotCharacter(alt, "fingerprint")],
    { ...second, limitationCode: null },
    { resumeAfter: null, limitationCode: null }
  );

  expect(amended.id).toBe(published.id);
  expect(amended.characterCount).toBe(2);
  expect(amended.characters.map((row) => row.key.name)).toEqual([
    "amendroot",
    "amendalt"
  ]);
  expect(amended.limitationCode).toBeNull();
  await expect(
    repositories.fingerprintSweeps.getResumeState(key)
  ).resolves.toBeNull();
});

it("ignores a character the snapshot already carries", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "dupedroot" } as const;
  const runId = await seedActiveRun(repositories, key);
  const first = await admitSweep(repositories, runId, key);

  const published = await repositories.snapshots.createAndFinishFingerprintSweep(
    {
      runId,
      rootKey: key,
      state: "partial",
      limitationCode: "fingerprint_sweep_capped",
      refreshedAt: new Date(),
      characters: [snapshotCharacter(key, "input")]
    },
    first,
    {
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      limitationCode: null
    }
  );

  const second = await admitSweep(repositories, runId, key);
  const amended = await repositories.snapshots.amendAndFinishFingerprintSweep(
    published.id,
    [snapshotCharacter(key, "fingerprint")],
    { ...second, limitationCode: null },
    { resumeAfter: null, limitationCode: null }
  );

  expect(amended.characterCount).toBe(1);
});
```

Add an `admitSweep` helper beside the file's existing helpers:

```ts
async function admitSweep(
  repositories: Repositories,
  runId: string,
  key: CharacterKey
): Promise<{ reservationId: string; finishedAt: Date; limitationCode: string | null }> {
  const at = new Date();
  const admission = await repositories.fingerprintSweeps.requestAdmission({
    runId,
    key,
    requestCap: 10,
    hourlyBudget: 100,
    // A cutoff ahead of `at` keeps the cadence gate open, so this helper can be
    // called twice for the same root without depending on Task 5.
    cadenceCutoff: new Date(at.getTime() + 60_000),
    at
  });
  if (admission.kind !== "admitted") throw new Error("not admitted");
  return {
    reservationId: admission.reservationId,
    finishedAt: new Date(),
    limitationCode: "fingerprint_sweep_capped"
  };
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/repositories.test.ts`
Expected: FAIL — `amendAndFinishFingerprintSweep` is not a function.

- [ ] **Step 3: Declare the interface**

In `packages/database/src/repositories.ts`, on `SnapshotRepository`:

```ts
  /**
   * Appends fingerprint matches to a snapshot already published by an earlier
   * cycle of the same sweep. Never touches `discovery_runs`: the run that
   * published the snapshot is already complete.
   */
  amendAndFinishFingerprintSweep(
    snapshotId: string,
    characters: SnapshotCharacterInput[],
    fingerprint: {
      reservationId: string;
      finishedAt: Date;
      limitationCode: string | null;
    },
    cursor: FingerprintSweepCursor,
    options?: { signal?: AbortSignal }
  ): Promise<StoredSnapshot>;
```

- [ ] **Step 4: Implement**

In `packages/database/src/postgres-repositories.ts`, after
`createAndFinishFingerprintSweep`:

```ts
      async amendAndFinishFingerprintSweep(
        snapshotId,
        characters,
        fingerprint,
        cursor,
        options
      ) {
        if (Number.isNaN(fingerprint.finishedAt.valueOf())) {
          throw new RangeError("fingerprint_finish_time_invalid");
        }
        const client = await pool.connect();
        try {
          options?.signal?.throwIfAborted();
          await client.query("BEGIN");

          const rootResult = await client.query<{
            region: CharacterKey["region"];
            realm_slug: string;
            normalized_name: string;
            next_order: number;
          }>(
            `SELECT root.region, root.realm_slug, root.normalized_name,
                    COALESCE(MAX(membership.display_order) + 1, 0) AS next_order
             FROM snapshots snapshot
             JOIN characters root ON root.id = snapshot.root_character_id
             LEFT JOIN snapshot_characters membership
               ON membership.snapshot_id = snapshot.id
             WHERE snapshot.id = $1
             GROUP BY root.region, root.realm_slug, root.normalized_name`,
            [snapshotId]
          );
          const rootRow = rootResult.rows[0];
          if (!rootRow) throw new Error("snapshot_not_found");
          await lockRoot(client, {
            region: rootRow.region,
            realm: rootRow.realm_slug,
            name: rootRow.normalized_name
          });
          await lockFingerprintSweeps(client);

          const existing = await client.query<{
            region: string;
            realm_slug: string;
            normalized_name: string;
          }>(
            `SELECT character.region, character.realm_slug,
                    character.normalized_name
             FROM snapshot_characters membership
             JOIN characters character ON character.id = membership.character_id
             WHERE membership.snapshot_id = $1`,
            [snapshotId]
          );
          const present = new Set(
            existing.rows.map(
              (row) =>
                `${row.region}/${row.realm_slug}/${row.normalized_name}`
            )
          );

          let displayOrder = Number(rootRow.next_order);
          let appended = 0;
          for (const character of characters) {
            const id = `${character.key.region}/${character.key.realm}/${character.key.name}`;
            if (present.has(id)) continue;
            present.add(id);

            const upserted = await client.query<{ id: string }>(
              `INSERT INTO characters
                (region, realm_slug, normalized_name, display_name, class_name,
                 level, raider_io_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (region, realm_slug, normalized_name)
               DO UPDATE SET
                 display_name = EXCLUDED.display_name,
                 class_name = EXCLUDED.class_name,
                 level = EXCLUDED.level,
                 raider_io_url = EXCLUDED.raider_io_url,
                 updated_at = now()
               RETURNING id`,
              [
                character.key.region,
                character.key.realm,
                character.key.name,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl
              ]
            );
            await client.query(
              `INSERT INTO snapshot_characters
                (snapshot_id, character_id, display_order, discovery_source,
                 display_name, class_name, level, raider_io_url,
                 guild_name, guild_region, guild_realm_slug)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                snapshotId,
                upserted.rows[0]!.id,
                displayOrder,
                character.source,
                character.displayName,
                character.className,
                character.level,
                character.raiderIoUrl,
                character.guild?.name ?? null,
                character.guild?.region ?? null,
                character.guild?.realm ?? null
              ]
            );
            displayOrder += 1;
            appended += 1;
          }

          await client.query(
            `UPDATE snapshots
             SET character_count = character_count + $2,
                 state = $3,
                 limitation_code = $4
             WHERE id = $1`,
            [
              snapshotId,
              appended,
              fingerprint.limitationCode === null ? "complete" : "partial",
              fingerprint.limitationCode
            ]
          );

          await finishFingerprintSweep(client, fingerprint.reservationId, {
            published: true,
            at: fingerprint.finishedAt,
            limitationCode: fingerprint.limitationCode,
            resumeAfter: cursor.resumeAfter,
            resumeLimitationCode:
              cursor.resumeAfter === null ? null : cursor.limitationCode,
            resumeSnapshotId: cursor.resumeAfter === null ? null : snapshotId
          });

          const snapshot = await loadSnapshot(client, snapshotId);
          if (!snapshot) throw new Error("snapshot_not_found");
          options?.signal?.throwIfAborted();
          await client.query("COMMIT");
          return snapshot;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/repositories.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database/src tests/integration/repositories.test.ts
git commit -m "feat: amend a published snapshot with later sweep matches"
```

---

### Task 5: Exempt continuations from the cadence gate

**Files:**
- Modify: `packages/database/src/repositories.ts:329-338`
- Modify: `packages/database/src/postgres-repositories.ts:1785-1836`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `requestAdmission` input gains `continuation?: true`.

Without this, cycle 2 is refused: cycle 1 stamps `last_published_at`, and
`requestAdmission` answers `not_due` while that is newer than `cadenceCutoff`.

- [ ] **Step 1: Write the failing test**

```ts
it("admits a continuation inside the cadence window", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "cadenceroot" } as const;
  const runId = await seedActiveRun(repositories, key);
  const at = new Date();

  const first = await repositories.fingerprintSweeps.requestAdmission({
    runId,
    key,
    requestCap: 10,
    hourlyBudget: 100,
    cadenceCutoff: new Date(at.getTime() - 60_000),
    at
  });
  expect(first.kind).toBe("admitted");
  await repositories.fingerprintSweeps.finish(
    (first as { reservationId: string }).reservationId,
    { published: true, at, limitationCode: "fingerprint_sweep_capped" }
  );

  // Same cadence window: an ordinary request is not due...
  await expect(
    repositories.fingerprintSweeps.requestAdmission({
      runId,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(at.getTime() - 60_000),
      at
    })
  ).resolves.toMatchObject({ kind: "not_due" });

  // ...but a continuation is admitted.
  await expect(
    repositories.fingerprintSweeps.requestAdmission({
      runId,
      key,
      requestCap: 10,
      hourlyBudget: 100,
      cadenceCutoff: new Date(at.getTime() - 60_000),
      at,
      continuation: true
    })
  ).resolves.toMatchObject({ kind: "admitted" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/repositories.test.ts -t "continuation inside the cadence"`
Expected: FAIL — the third call returns `not_due`.

- [ ] **Step 3: Implement**

In `packages/database/src/repositories.ts`, add to the `requestAdmission` input:

```ts
    /**
     * A continuation finishes the sweep already in progress rather than
     * starting a new one, so it is exempt from the cadence gate. Every other
     * gate still applies.
     */
    continuation?: true;
```

In `packages/database/src/postgres-repositories.ts`, guard the cadence branch:

```ts
          if (
            !input.continuation &&
            state.rows[0]?.last_published_at &&
            state.rows[0].last_published_at > input.cadenceCutoff
          ) {
```

Check `assertFingerprintAdmissionInput` and extend its validation only if it
rejects unknown keys; leave it alone otherwise.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/repositories.test.ts`
Expected: PASS, including Task 4's tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database/src tests/integration/repositories.test.ts
git commit -m "feat: exempt sweep continuations from the cadence gate"
```

---

### Task 6: Flag continuation jobs on the queue

**Files:**
- Modify: `packages/database/src/queue.ts:15-30,246-260`
- Test: `packages/database/src/queue.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `DiscoverCharacterJob.continuation?: true`; singleton key becomes `${runId}:continuation` for a continuation, `runId` otherwise.

The singleton key must be scoped or the continuation collides with the completed
cycle-1 job for the same run and is silently dropped.

- [ ] **Step 1: Write the failing test**

```ts
it("scopes the singleton key so a continuation does not collide", async () => {
  const sent: { key: string | undefined }[] = [];
  const queue = createQueueWithFakeBoss({
    send: async (_name, _payload, options) => {
      sent.push({ key: options?.singletonKey });
      return "job-id";
    }
  });

  await queue.enqueue({ runId: "run-1", key: rootKey, enqueuedAt: iso });
  await queue.enqueue({
    runId: "run-1",
    key: rootKey,
    enqueuedAt: iso,
    continuation: true
  });

  expect(sent.map((entry) => entry.key)).toEqual([
    "run-1",
    "run-1:continuation"
  ]);
});
```

Follow the file's existing fake-boss convention. If `queue.test.ts` does not
exist, mirror the setup used by the nearest existing database unit test.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit packages/database/src/queue.test.ts`
Expected: FAIL — both keys are `run-1`.

- [ ] **Step 3: Implement**

In `packages/database/src/queue.ts`, on `DiscoverCharacterJob`:

```ts
  /**
   * Set when this job resumes a fingerprint sweep that capped. It skips
   * Raider.IO re-discovery and the completed-run guard.
   */
  continuation?: true;
```

and in `enqueue`:

```ts
    async enqueue(payload) {
      if (!ready) throw new Error("discovery_queue_not_ready");
      const singletonKey = payload.continuation
        ? `${payload.runId}:continuation`
        : payload.runId;
      const id = await boss.send(discoverCharacterQueueName, payload, {
        singletonKey
      });
      return (
        id ??
        (await existingSingletonJobId(
          discoverCharacterQueueName,
          singletonKey
        )) ??
        (() => {
          throw new Error("discovery_queue_enqueue_not_created");
        })()
      );
    },
```

Note the `existingSingletonJobId` argument changes from `payload.runId` to
`singletonKey` — leaving it would look up the wrong job.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit packages/database/src/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database/src/queue.ts packages/database/src/queue.test.ts
git commit -m "feat: scope the singleton key for continuation jobs"
```

---

### Task 7: Resume the sweep in the handler

**Files:**
- Modify: `packages/application/src/discovery-job-handler.ts:260-300,341-520`
- Test: `packages/application/src/discovery-job-handler.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5, 6.
- Produces: `execute(runId, context?, job?)` honours `job.continuation`; `DiscoveryJobHandlerOptions` unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it("re-enqueues a capped sweep as a continuation", async () => {
  const harness = handlerHarness({
    roster: rosterOf(400),
    sweepRequestCap: 50
  });

  await harness.handler.execute(harness.runId);

  expect(harness.snapshots.created).toHaveLength(1);
  expect(harness.snapshots.created[0]!.limitationCode).toBe(
    "fingerprint_sweep_capped"
  );
  expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
  await expect(
    harness.repositories.fingerprintSweeps.getResumeState(harness.rootKey)
  ).resolves.not.toBeNull();
});

it("amends rather than republishes on a continuation", async () => {
  const harness = handlerHarness({
    roster: rosterOf(400),
    sweepRequestCap: 50
  });
  await harness.handler.execute(harness.runId);

  await harness.handler.execute(harness.runId, undefined, {
    runId: harness.runId,
    key: harness.rootKey,
    enqueuedAt: new Date().toISOString(),
    continuation: true
  });

  expect(harness.snapshots.created).toHaveLength(1);
  expect(harness.snapshots.amended).toHaveLength(1);
  expect(harness.discoverCharacterCalls).toBe(1); // not re-run
});

it("surfaces a match that only the second cycle reaches", async () => {
  // The Yawners regression: the match sorts past the first cycle's cap.
  const late = { region: "eu", realm: "draenor", name: "yawners" } as const;
  const harness = handlerHarness({
    roster: [...rosterOf(399), candidate(late)],
    sweepRequestCap: 50,
    matching: [late]
  });

  await harness.handler.execute(harness.runId);
  expect(harness.snapshotCharacterKeys()).not.toContainEqual(late);

  for (let cycle = 0; harness.enqueuedFingerprintAdmissions.length > 0; cycle += 1) {
    if (cycle > 20) throw new Error("continuation did not terminate");
    harness.enqueuedFingerprintAdmissions.length = 0;
    await harness.handler.execute(harness.runId, undefined, {
      runId: harness.runId,
      key: harness.rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true
    });
  }

  expect(harness.snapshotCharacterKeys()).toContainEqual(late);
  await expect(
    harness.repositories.fingerprintSweeps.getResumeState(harness.rootKey)
  ).resolves.toBeNull();
});

it("restores the Raider.IO limitation when the chain seals", async () => {
  // Cycle 1 overwrites limitation_code with fingerprint_sweep_capped. Sealing
  // must put back what discoverCharacter actually observed, not invent one and
  // not falsely claim complete.
  const harness = handlerHarness({
    roster: rosterOf(400),
    sweepRequestCap: 50,
    raiderIoLimitation: "privacy_hidden"
  });

  await harness.handler.execute(harness.runId);
  expect(harness.snapshotLimitationCode()).toBe("fingerprint_sweep_capped");

  for (let cycle = 0; harness.enqueuedFingerprintAdmissions.length > 0; cycle += 1) {
    if (cycle > 20) throw new Error("continuation did not terminate");
    harness.enqueuedFingerprintAdmissions.length = 0;
    await harness.handler.execute(harness.runId, undefined, {
      runId: harness.runId,
      key: harness.rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true
    });
  }

  expect(harness.snapshotLimitationCode()).toBe("privacy_hidden");
});

it("seals to complete when Raider.IO discovery had no limitation", async () => {
  const harness = handlerHarness({
    roster: rosterOf(400),
    sweepRequestCap: 50,
    raiderIoLimitation: null
  });

  await harness.handler.execute(harness.runId);
  for (let cycle = 0; harness.enqueuedFingerprintAdmissions.length > 0; cycle += 1) {
    if (cycle > 20) throw new Error("continuation did not terminate");
    harness.enqueuedFingerprintAdmissions.length = 0;
    await harness.handler.execute(harness.runId, undefined, {
      runId: harness.runId,
      key: harness.rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true
    });
  }

  expect(harness.snapshotLimitationCode()).toBeNull();
});
```

`handlerHarness` needs `raiderIoLimitation` (drives the fake `discoverCharacter`
outcome's state/limitation) and `snapshotLimitationCode()` (reads the current
value on the single snapshot, whether created or amended).

Build `handlerHarness` on the fakes the test file already uses; do not introduce
a second fake-repository style.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project unit packages/application/src/discovery-job-handler.test.ts`
Expected: FAIL — `execute` takes no job argument and never re-enqueues on cap.

- [ ] **Step 3: Accept the job on execute**

```ts
    async execute(
      runId: string,
      workContext?: DiscoveryExecutionContext,
      job?: { continuation?: true }
    ): Promise<void> {
```

A completed run is refused on **two** paths and both need the bypass:

1. `repositories.runs.claim` matches only `status IN (active states)`
   (`postgres-repositories.ts:1140`) and returns `null` for a completed run.
   This is the production path — the queue always supplies `workContext`
   (`runtime.ts:328`), so the `if (!context)` block below never runs there.
2. The `if (!context)` early return, which is the path tests take when calling
   `execute(runId)` directly.

Guard the completed-run early return so a continuation passes through:

```ts
      let context = workContext;
      if (!context) {
        const existing = await repositories.runs.find(runId);
        if (!existing) throw new Error("discovery_run_not_found");
        if (
          !job?.continuation &&
          (existing.status === "complete" || existing.status === "failed")
        ) {
          return;
        }
        context = {
          attempt: existing.attempt + 1,
          maxAttempts,
          signal: new AbortController().signal
        };
      }
```

A continuation must not go through `repositories.runs.claim`, which expects an
active run. Read the run directly instead:

```ts
      const run = job?.continuation
        ? await repositories.runs.find(runId)
        : await repositories.runs.claim(runId, context.attempt);
      if (!run) return;
```

- [ ] **Step 4: Skip re-discovery on a continuation**

Replace the `discoverCharacter` call and its lifetime checks with a branch. A
continuation has no fresh Raider.IO outcome, so it carries an empty snapshot
outcome whose characters are already in the published snapshot:

```ts
        const resume = job?.continuation
          ? await repositories.fingerprintSweeps.getResumeState(run.rootKey)
          : null;
        if (job?.continuation && !resume) return; // nothing to resume

        let outcome: DiscoveryOutcome = resume
          ? {
              kind: "snapshot",
              state: "partial",
              // Placeholder only. A continuation performs no Raider.IO
              // discovery, so this value must never reach the snapshot: the
              // real limitation is `resume.limitationCode`, stored by cycle 1.
              limitationCode: "privacy_hidden",
              characters: []
            }
          : await discoverCharacter(
              run.rootKey,
              scopedRaiderIoGateway(options.gateway, scope),
              {
                requestCap: options.requestCap,
                isSuppressed: (key) => repositories.suppressions.isActive(key),
                signal: context.signal
              }
            );
```

- [ ] **Step 5: Pass the cursor into the sweep and branch on the result**

Pass `continuation` to admission and `resumeAfter` to the sweep:

```ts
            const admission =
              await repositories.fingerprintSweeps.requestAdmission({
                runId,
                key: run.rootKey,
                requestCap: fingerprint.requestCap,
                hourlyBudget: fingerprint.hourlyBudget,
                cadenceCutoff: new Date(
                  admissionTime.getTime() - fingerprint.cadenceMs
                ),
                at: admissionTime,
                ...(resume ? { continuation: true as const } : {})
              });
```

```ts
                const sweep = await discoverFingerprintMatches(
                  run.rootKey,
                  adaptedGateway,
                  {
                    requestCap: Number.MAX_SAFE_INTEGER,
                    minimumCommon: fingerprint.minimumCommon,
                    minimumIdenticalPercent: fingerprint.minimumIdenticalPercent,
                    isSuppressed: (key) =>
                      repositories.suppressions.isActive(key),
                    signal: context.signal,
                    ...(resume ? { resumeAfter: resume.resumeAfter } : {})
                  }
                );
```

Then replace the persistence block. The cursor is `undefined` on a cursor-less
`capped`, which must leave the stored cursor alone:

```ts
                  const stillSweeping =
                    sweep.kind === "capped" && sweep.resumeAfter !== undefined;
                  // The Raider.IO limitation this chain must restore when it
                  // seals. A continuation did no discovery of its own, so it
                  // uses the value cycle 1 stored rather than its placeholder.
                  const raiderIoLimitation = resume
                    ? resume.limitationCode
                    : outcome.state === "partial"
                      ? outcome.limitationCode
                      : null;
                  const limitationCode =
                    sweep.kind === "capped"
                      ? "fingerprint_sweep_capped"
                      : raiderIoLimitation;
                  const cursor = {
                    resumeAfter: stillSweeping
                      ? sweep.resumeAfter!
                      : sweep.kind === "capped"
                        ? (resume?.resumeAfter ?? null)
                        : null,
                    limitationCode: raiderIoLimitation
                  };

                  if (resume) {
                    await repositories.snapshots.amendAndFinishFingerprintSweep(
                      resume.snapshotId,
                      [...sweep.characters],
                      {
                        reservationId: admission.reservationId,
                        finishedAt: now(),
                        limitationCode
                      },
                      cursor,
                      { signal: context.signal }
                    );
                  } else {
                    const excludedTournamentCharacters = new Set(
                      outcome.state === "partial"
                        ? outcome.excludedTournamentCharacterIds
                        : []
                    );
                    const characters = deduplicateCharacters([
                      ...outcome.characters,
                      ...sweep.characters
                    ]).filter(
                      (character) =>
                        !excludedTournamentCharacters.has(
                          canonicalCharacterId(character.key)
                        )
                    );
                    record.characterCount = characters.length;
                    await repositories.snapshots.createAndFinishFingerprintSweep(
                      {
                        runId,
                        rootKey: run.rootKey,
                        state: limitationCode === null ? "complete" : "partial",
                        limitationCode,
                        refreshedAt: fingerprintPersistenceTime,
                        characters
                      },
                      {
                        reservationId: admission.reservationId,
                        finishedAt: now(),
                        limitationCode
                      },
                      cursor,
                      { signal: context.signal }
                    );
                  }
                  record.outcome = "snapshot";
                  record.state = limitationCode === null ? "complete" : "partial";
                  record.limitationCode = limitationCode;
                  reservationActive = false;
                  if (stillSweeping && options.enqueueFingerprintAdmission) {
                    await options.enqueueFingerprintAdmission(runId);
                  }
                  return;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit packages/application/src/discovery-job-handler.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/application/src
git commit -m "feat: resume a capped fingerprint sweep on a continuation job"
```

---

### Task 8: Dispatch continuations from the worker

**Files:**
- Modify: `apps/worker/src/runtime.ts:265-275`
- Test: `apps/worker/src/runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 7.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

```ts
it("dispatches a run with a stored cursor as a continuation", async () => {
  const harness = runtimeHarness({
    resumeState: {
      resumeAfter: JSON.stringify(["eu", "draenor", "valadares"]),
      snapshotId: "snapshot-1"
    }
  });

  await harness.dispatchAdmittedFingerprintRun("run-1");

  expect(harness.enqueued).toEqual([
    expect.objectContaining({ runId: "run-1", continuation: true })
  ]);
});

it("dispatches a run with no cursor as an ordinary job", async () => {
  const harness = runtimeHarness({ resumeState: null });

  await harness.dispatchAdmittedFingerprintRun("run-1");

  expect(harness.enqueued[0]).not.toHaveProperty("continuation");
});
```

Follow the harness style already in `runtime.test.ts`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project unit apps/worker/src/runtime.test.ts`
Expected: FAIL — the payload never carries `continuation`.

- [ ] **Step 3: Implement**

```ts
    const dispatchAdmittedFingerprintRun = async (runId: string) => {
      const run = await repositories.runs.find(runId);
      if (!run) return;
      const resume =
        await repositories.fingerprintSweeps.getResumeState(run.rootKey);
      // No correlationId is available here: this dispatch is a background
      // fingerprint-admission follow-up, not the continuation of an HTTP
      // request, so it stays absent rather than being invented.
      await initializedQueue.enqueue({
        runId,
        key: run.rootKey,
        enqueuedAt: new Date().toISOString(),
        ...(resume ? { continuation: true as const } : {})
      });
      await repositories.fingerprintSweeps.markDispatched(runId, new Date());
    };
```

- [ ] **Step 4: Thread the job into the handler**

At `apps/worker/src/runtime.ts:327`, pass the payload as the third argument,
keeping the existing context spread exactly as it is:

```ts
    await initializedQueue.work(async (payload, context) => {
      await handler.execute(
        payload.runId,
        {
          ...context,
          correlationId: payload.correlationId,
          enqueuedAt: payload.enqueuedAt
        },
        payload
      );
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit apps/worker/src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add apps/worker/src
git commit -m "feat: dispatch fingerprint sweep continuations from the worker"
```

---

### Task 9: Document the behaviour

**Files:**
- Modify: `docs/deployment/railway.md:86-90,110`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Update the staging verification steps**

`docs/deployment/railway.md:110` tells the operator to use a deliberately
bounded sweep to exercise a capped run. That now produces a *chain*, so the
expected observation changes. Replace the fingerprint sentence with:

```
In `test`, temporarily use a deliberately bounded fingerprint sweep to exercise
a capped run and confirm `Additional linked characters may exist; this dossier
is not exhaustive.` appears, then confirm that the continuation cycles run
without operator action and the message becomes `Linked-character research is
complete.` once the roster is exhausted. Restore the normal test budget
afterwards.
```

- [ ] **Step 2: Note the cap's new meaning**

Beside `BLIZZARD_SWEEP_REQUEST_CAP=300` at `docs/deployment/railway.md:86`, add:

```
# Per-cycle cap, not a per-guild limit: a sweep that reaches it resumes from a
# stored cursor on a follow-up cycle until the roster is exhausted.
```

- [ ] **Step 3: Commit**

```bash
git add docs/deployment/railway.md
git commit -m "docs: describe fingerprint sweep continuation for operators"
```

---

### Task 10: Bump the evidence version

**Files:**
- Modify: `packages/database/src/postgres-repositories.ts:166`
- Test: `tests/integration/repositories.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

Continuation adds characters to snapshots that already exist, so dossiers that
were published mid-chain hold evidence gathered before their full character set
was known. Bumping `CURRENT_EVIDENCE_VERSION` makes the reuse gate at
`postgres-repositories.ts:2145` treat every completed evidence run as stale, so
those dossiers re-collect instead of serving a partial cached set forever.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/repositories.test.ts`:

```ts
it("re-collects evidence recorded at the previous version", async () => {
  const key = { region: "eu", realm: "silvermoon", name: "evversion" } as const;
  const runId = await seedCompletedEvidenceRun(repositories, key);
  await pool.query(
    "UPDATE character_evidence_runs SET evidence_version = 10 WHERE id = $1",
    [runId]
  );

  const reserved = await repositories.characterEvidence.reserve(key, {
    freshnessCutoff: new Date(Date.now() - 60_000),
    at: new Date()
  });

  expect(reserved.kind).not.toBe("fresh");
});
```

Match the file's existing evidence-reservation helpers and the real `reserve`
signature rather than inventing one; the assertion that matters is that version
10 is no longer reusable.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/repositories.test.ts -t "previous version"`
Expected: FAIL — version 10 still satisfies the reuse gate.

- [ ] **Step 3: Bump the constant**

In `packages/database/src/postgres-repositories.ts`:

```ts
const CURRENT_EVIDENCE_VERSION = 11;
```

Leave the two explanatory comments above it unchanged.

- [ ] **Step 4: Check the existing version-sensitive tests**

Run: `pnpm test:integration tests/integration/repositories.test.ts`
Expected: PASS. `tests/integration/repositories.test.ts:408` pins
`evidenceVersion: 10` — if it asserts the *current* version rather than an
arbitrary stored one, update it to 11; if it is testing an unrelated stored
value, leave it.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
pnpm lint && pnpm typecheck
git add packages/database/src/postgres-repositories.ts tests/integration/repositories.test.ts
git commit -m "chore: bump evidence version so continued dossiers re-collect"
```

---

## Self-Review Notes

Spec coverage checked section by section:

| Spec section | Task |
|---|---|
| Mechanism (continuation flag, skip re-discovery) | 6, 7, 8 |
| Snapshot semantics (amend in place) | 4, 7 |
| Cursor (last swept canonical id) | 1, 2, 3 |
| Per-cycle overhead (accepted, no caching) | none needed — no code change |
| Domain interface | 1 |
| Queue interface | 6 |
| Admission (cadence exemption) | 5 |
| Schema | 2 |
| Repository (`amendAndFinishFingerprintSweep`) | 4 |
| Edge: root leaves guild / cursor past roster end | 1 (Step 1 test 4) |
| Edge: budget exhausted before first candidate | 1 (Step 1 test 5) |
| Edge: fresh refresh supersedes | 7 (`getResumeState` returns the superseded snapshot id; the new run publishes a new snapshot and resets the cursor) |
| Edge: `maxJobLifetimeMs` mid-chain | existing behaviour, unchanged |
| Edge: continuation dispatched with no cursor | 7 (Step 3 early return), 8 |
| Edge: continuation enqueued twice | 6 |
| Testing | 1, 3, 4, 5, 6, 7, 8 |

Every task is independently testable in the order given. Task 4's `admitSweep`
helper deliberately opens the cadence gate with a future `cadenceCutoff` rather
than the `continuation` flag, so it does not depend on Task 5.

Type consistency checked: `resumeAfter` (string), `FingerprintSweepCursor.resumeAfter`
(`string | null`), `getResumeState` → `{ resumeAfter, snapshotId } | null`, and
`continuation?: true` are spelled identically in every task that names them.
