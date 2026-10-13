# Applicant sheet: link each application's characters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an application lists several characters, the worker links every other character to the first one, as manual connections labelled "From application". It does so only once each character exists and passes the safeguards, and only while `APPLICANT_LINKING_ENABLED=true`.

**Architecture:**

- **Intake.** The poll reads the Forms timestamp beside the link column (as a raw serial) and passes per-row candidate lists to `reconcileApplicantCounts`. In the same transaction that inserts a root's intent, it records an application and its members. A high-water mark keeps old rows out.
- **Linking step.** A new step, `linkApplicantApplications`, runs after each drain and writes `manual_dossier_connections` rows with `origin = 'applicant_sheet'`.
- **Display.** Dossiers keep `source: "manually_added"`, and add `origin: "application"` only to choose the label.
- **Alerts.** Alerts become one per new row.

**Tech stack:**

- TypeScript and Node 22. Always run `corepack pnpm`; bare `pnpm` is not on `PATH`.
- PostgreSQL 16 through `pg`, with hand-written SQL migrations under `packages/database/drizzle/` and journal entries in `meta/_journal.json`.
- vitest, with `unit` and `integration` projects. The integration project uses Testcontainers and needs Docker.
- zod, for the contracts.

**Spec:** [`docs/superpowers/specs/2026-10-13-applicant-application-links-design.md`](../specs/2026-10-13-applicant-application-links-design.md), "Change 2". It is merged on main through Erilla/SlashWho#813, and was signed off at c70d1a26.

**Depends on:** [`2026-10-13-applicant-poll-every-minute.md`](2026-10-13-applicant-poll-every-minute.md) being merged first. This plan uses its `applicantSheetTickHandler` fake, the `pointsBlocked` drain field and its `now` stamping.

**Where to work:** a fresh worktree off `origin/main`, _after_ the polling PR has merged:

```bash
git fetch origin
git worktree add -b feat/applicant-application-links .claude/worktrees/feat-applicant-application-links origin/main
```

## Global constraints

- **Feature flag.** `APPLICANT_LINKING_ENABLED` accepts `"true"` or `"false"` and defaults to `false`. Anything else throws `invalid_applicant_linking_enabled`. While it's false, intake still records applications. Only the linking step and the alert's linking wording depend on it.
- **Migration** `0074_applicant_applications`, journal `idx: 73`, with `when` greater than `1792011600024`. Recheck both against `origin/main` before opening the PR, and renumber if `0074` is taken: the file name, the journal `idx`/`tag`/`when`, and `tests/integration/migrations.test.ts`.
- **Cap:** a row with more than 5 accepted links records an over-cap application with no members.
- **Expiry:** 7 days after `settled_at`. Hard close: 30 days after `created_at`. Closed applications are deleted 30 days after `closed_at`.
- **Linking batch:** at most 50 applications per tick, `FOR UPDATE SKIP LOCKED`, ordered by `last_checked_at NULLS FIRST, created_at`.
- **Privacy.** The new tables hold only identity strings (`character:[…]`, `warcraftlogs_id:N`), timestamps, a Forms serial, sequences and counts. Never Battletags, Discord ids, names, URLs or raw cells. Logs are count-only.
- **Identities.** Canonical identities are `character:["eu","realm","name"]` strings. Always decode them with `decodeApplicantIdentity` before using a key.
- **Source.** `source` stays `"manually_added"` for every manual connection. Only `origin?: "application"` is new on the dossier character contract.
- **Settlement deviation from the spec.** The spec has `admitCanonicalIntent` and the drain write `settled_at`. This plan has the linking step stamp `settled_at` at the start of each pass, from the root intent's state. That's at most one tick later, and it leaves the admission transaction untouched. A root inserted as `suppressed` is still settled at intake, as the spec says. Mention this in the PR.

## Review focus

1. **Sorting the sheet between polls.** The row chosen for an application must come from the Forms serial, never from occurrence order. Task 4 tests a sorted sheet.
2. **A response whose first link is a Warcraft Logs id.** The root is a `warcraftlogs_id:N` identity, and its key comes from the root intent's `canonical_identity`. Until it resolves, the application waits. Task 9 tests a numeric root.
3. **One character in two open applications** (resubmission before the first links). Each member's intent is its own (`member_intent_sequence`), and the newer intent doesn't stall the older application. Task 4 tests the fill-in.
4. **A reviewer acting while the worker links.** The worker's `ON CONFLICT DO NOTHING` never overwrites a reviewer's row, and the reviewer's add converts a worker row. Task 7 tests both orders.
5. **The watcher enabled with linking disabled for days.** Applications pile up, settle and expire. The 7-day expiry runs from `settled_at` only when the step runs, so the hard close (30 days from creation) must also run while linking is disabled. Task 10 runs the expiry and deletion in hourly maintenance whatever the flag says.

---

### Task 1: Migration `0074` and the schema

**Files:**

- Create: `packages/database/drizzle/0074_applicant_applications.sql`
- Modify: `packages/database/drizzle/meta/_journal.json` (append the entry)
- Modify: `packages/database/src/schema.ts` (`manualDossierConnections`, about line 360; add the two new tables after it)
- Test: `tests/integration/migrations.test.ts` (the journal list, about line 237, plus a new test)

**Interfaces:**

- Produces:
  - Tables `applicant_source_applications` and `applicant_source_application_members`.
  - Column `applicant_source_state.submitted_serial_mark`.
  - Columns `manual_dossier_connections.origin` and `.applicant_application_id`.

- [ ] **Step 1: Write the failing migration test**

In `tests/integration/migrations.test.ts`, append `{ idx: 73, tag: "0074_applicant_applications" }` to the expected journal list, then add:

```ts
it("adds application tables and a reviewer-default origin to manual connections", async () => {
  // Break caught: a NOT NULL origin without a default would fail every
  // existing manual connection, and an application FK without SET NULL would
  // block deleting closed applications.
  const { pool, stop } = await startPostgres();
  try {
    await runMigrations(pool);
    const root = await pool.query<{ id: string }>(
      "INSERT INTO characters (region, realm_slug, normalized_name, display_name) VALUES ('eu', 'hyjal', 'tropipe', 'Tropipe') RETURNING id"
    );
    await pool.query(
      "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'tropicos')",
      [root.rows[0]!.id]
    );
    const origin = await pool.query<{ origin: string }>(
      "SELECT origin FROM manual_dossier_connections"
    );
    expect(origin.rows).toEqual([{ origin: "dossier" }]);
    await expect(
      pool.query("UPDATE manual_dossier_connections SET origin = 'web'")
    ).rejects.toThrow();

    await pool.query(
      "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at, parser_version) VALUES ('applicant_sheet', now(), now(), 2)"
    );
    const intent = await pool.query<{ sequence: string }>(
      'INSERT INTO applicant_source_intents (source, identity, observed_at) VALUES (\'applicant_sheet\', \'character:["eu","hyjal","tropipe"]\', now()) RETURNING sequence'
    );
    const application = await pool.query<{ id: string }>(
      'INSERT INTO applicant_source_applications (source, root_intent_sequence, root_identity, submitted_serial) VALUES (\'applicant_sheet\', $1, \'character:["eu","hyjal","tropipe"]\', 46308.45) RETURNING id',
      [intent.rows[0]!.sequence]
    );
    await pool.query(
      "UPDATE manual_dossier_connections SET origin = 'applicant_sheet', applicant_application_id = $1",
      [application.rows[0]!.id]
    );
    await pool.query("DELETE FROM applicant_source_applications");
    const after = await pool.query<{
      origin: string;
      applicant_application_id: string | null;
    }>(
      "SELECT origin, applicant_application_id FROM manual_dossier_connections"
    );
    expect(after.rows).toEqual([
      { origin: "applicant_sheet", applicant_application_id: null }
    ]);
  } finally {
    await stop();
  }
});
```

Check that `startPostgres` and `runMigrations` are imported in that file; the neighbouring tests use them.

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm test:integration -- tests/integration/migrations.test.ts`
Expected: FAIL. The journal list is missing 0074, and `column "origin" does not exist`.

- [ ] **Step 3: Write the migration**

`packages/database/drizzle/0074_applicant_applications.sql`:

```sql
ALTER TABLE applicant_source_state
  ADD COLUMN submitted_serial_mark double precision;

CREATE TABLE applicant_source_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL REFERENCES applicant_source_state(source),
  root_intent_sequence bigint NOT NULL UNIQUE REFERENCES applicant_source_intents(sequence),
  root_identity text NOT NULL,
  submitted_serial double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  last_checked_at timestamptz,
  closed_at timestamptz,
  over_cap boolean NOT NULL DEFAULT false,
  linked_count integer NOT NULL DEFAULT 0,
  suppressed_count integer NOT NULL DEFAULT 0,
  same_character_count integer NOT NULL DEFAULT 0,
  skipped_region_count integer NOT NULL DEFAULT 0,
  skipped_excluded_count integer NOT NULL DEFAULT 0,
  skipped_cross_group_count integer NOT NULL DEFAULT 0,
  expired_count integer NOT NULL DEFAULT 0
);

CREATE INDEX applicant_source_applications_root_idx
  ON applicant_source_applications (root_identity, submitted_serial);
CREATE INDEX applicant_source_applications_open_idx
  ON applicant_source_applications (last_checked_at NULLS FIRST, created_at)
  WHERE closed_at IS NULL;

CREATE TABLE applicant_source_application_members (
  application_id uuid NOT NULL REFERENCES applicant_source_applications(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  identity text NOT NULL,
  member_intent_sequence bigint REFERENCES applicant_source_intents(sequence),
  outcome text CHECK (outcome IN ('linked', 'suppressed', 'same_character', 'skipped_region', 'skipped_excluded', 'skipped_cross_group', 'expired')),
  PRIMARY KEY (application_id, ordinal)
);

CREATE INDEX applicant_source_application_members_waiting_idx
  ON applicant_source_application_members (identity)
  WHERE member_intent_sequence IS NULL;

-- A constant default is metadata-only on PostgreSQL 11+, so existing rows are
-- reviewer links without a rewrite.
ALTER TABLE manual_dossier_connections
  ADD COLUMN origin text NOT NULL DEFAULT 'dossier'
    CONSTRAINT manual_dossier_connections_origin_check CHECK (origin IN ('dossier', 'applicant_sheet')),
  ADD COLUMN applicant_application_id uuid
    REFERENCES applicant_source_applications(id) ON DELETE SET NULL;
```

Append to `meta/_journal.json`'s `entries`:

```json
{
  "idx": 73,
  "version": "7",
  "when": 1792098000000,
  "tag": "0074_applicant_applications",
  "breakpoints": true
}
```

In `packages/database/src/schema.ts`:

- Add `origin: text("origin").notNull().default("dossier")` and `applicantApplicationId: uuid("applicant_application_id")` to `manualDossierConnections`.
- Add `applicantSourceApplications` and `applicantSourceApplicationMembers` table definitions mirroring the SQL, following the file's existing `pgTable` style.
- Add `submittedSerialMark: doublePrecision("submitted_serial_mark")` to the `applicantSourceState` table, and import `doublePrecision` from `drizzle-orm/pg-core` if it isn't already.

Run `git grep -n "applicant_source_state" packages/database/src/schema.ts` to find that table.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm test:integration -- tests/integration/migrations.test.ts`
Expected: PASS.
Run: `corepack pnpm vitest run packages/database/src/migration-journal.test.ts`
Expected: PASS. This checks that `idx` is in sequence and `when` increases.

- [ ] **Step 5: Commit**

```bash
git add packages/database/drizzle/0074_applicant_applications.sql packages/database/drizzle/meta/_journal.json packages/database/src/schema.ts tests/integration/migrations.test.ts
git commit -m "feat(database): applicant application tables and an origin on manual connections"
```

---

### Task 2: The `APPLICANT_LINKING_ENABLED` flag

**Files:**

- Modify: `apps/worker/src/config.ts` (the `applicantWatcher` type near line 14 and its builder near line 143)
- Modify: `.env.example` (after `APPLICANT_QUEUE_DEPTH_LIMIT`)
- Test: `apps/worker/src/config.test.ts`

**Interfaces:**

- Produces: `config.applicantWatcher.linkingEnabled: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
it("keeps applicant linking off unless explicitly enabled", () => {
  // Break caught: linking writes reviewer-visible connections, so it must
  // never start because a variable was missing or misspelt.
  expect(loadWorkerConfig(environment).applicantWatcher.linkingEnabled).toBe(
    false
  );
  expect(
    loadWorkerConfig({ ...environment, APPLICANT_LINKING_ENABLED: "true" })
      .applicantWatcher.linkingEnabled
  ).toBe(true);
  expect(() =>
    loadWorkerConfig({ ...environment, APPLICANT_LINKING_ENABLED: "yes" })
  ).toThrow("invalid_applicant_linking_enabled");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `corepack pnpm vitest run apps/worker/src/config.test.ts -t "linking"`
Expected: FAIL. `linkingEnabled` is undefined.

- [ ] **Step 3: Implement**

In the `applicantWatcher` type, add `linkingEnabled: boolean;`. Beside the existing `APPLICANT_WATCHER_ENABLED` validation:

```ts
if (
  environment.APPLICANT_LINKING_ENABLED !== undefined &&
  !["true", "false"].includes(environment.APPLICANT_LINKING_ENABLED)
)
  throw new Error("invalid_applicant_linking_enabled");
```

In the `applicantWatcher` object, add `linkingEnabled: environment.APPLICANT_LINKING_ENABLED === "true",`.

In `.env.example`:

```
# Link the other characters in each new application to its first character, as
# "From application" connections. Off until switched on deliberately.
# APPLICANT_LINKING_ENABLED=false
```

Every hand-built `WorkerConfig` in tests needs `linkingEnabled`. Find them with `git grep -n "minimumPoints:" -- '*.test.ts' tests/` and add `linkingEnabled: false` beside each one.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `corepack pnpm vitest run apps/worker/src/config.test.ts && corepack pnpm typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A apps/worker .env.example tests
git commit -m "feat(worker): an APPLICANT_LINKING_ENABLED flag, off by default"
```

---

### Task 3: Read the Forms serial and check the rows line up

**Files:**

- Modify: `apps/worker/src/applicant-sheet.ts` (the `ApplicantSheetRow` type and `readRows`)
- Test: `apps/worker/src/applicant-sheet.test.ts`

**Interfaces:**

- Produces: `ApplicantSheetRow` gains `submittedSerial: number | undefined`. `readRows()` makes a second request and throws `applicant_sheet_rows_moved` when the two reads disagree on anything except rows appended at the end.

- [ ] **Step 1: Write the failing tests**

```ts
function sheetFetch(
  first: unknown[][],
  second: { serials: unknown[][]; links: unknown[][] }
) {
  return vi.fn(async (url: string) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes("UNFORMATTED_VALUE")) {
      expect(decoded).toContain("dateTimeRenderOption=SERIAL_NUMBER");
      expect(decoded).toContain("'Form Responses'!A2:A");
      return new Response(
        JSON.stringify({
          valueRanges: [{ values: second.serials }, { values: second.links }]
        })
      );
    }
    return new Response(
      JSON.stringify({
        valueRanges: [
          { values: first.map(() => ["tag#1", "123456789012345678", "Name"]) },
          { values: first }
        ]
      })
    );
  });
}

it("attaches each row's Forms timestamp as a raw serial", async () => {
  const fetch = sheetFetch(
    [["https://raider.io/characters/eu/hyjal/tropipe"]],
    {
      serials: [[46308.4501]],
      links: [["https://raider.io/characters/eu/hyjal/tropipe"]]
    }
  );
  const rows = await createApplicantSheetClient({
    sheetId: "s",
    column: "F",
    apiKey: "k",
    fetch: fetch as typeof globalThis.fetch
  }).readRows();
  expect(rows[0]).toMatchObject({ row: 2, submittedSerial: 46308.4501 });
  // The formatted read keeps an 18-digit Discord id exact.
  expect(rows[0]?.discordId).toBe("123456789012345678");
});

it("drops rows appended between the two reads", async () => {
  const fetch = sheetFetch([["https://raider.io/characters/eu/hyjal/a"]], {
    serials: [[1], [2]],
    links: [
      ["https://raider.io/characters/eu/hyjal/a"],
      ["https://raider.io/characters/eu/hyjal/b"]
    ]
  });
  const rows = await createApplicantSheetClient({
    sheetId: "s",
    column: "F",
    apiKey: "k",
    fetch: fetch as typeof globalThis.fetch
  }).readRows();
  expect(rows).toHaveLength(1);
});

it("fails the read when the sheet was sorted or a row deleted between reads", async () => {
  // Break caught: a sort between the reads paired one applicant's timestamp
  // with another's links, and linked the wrong person's characters.
  const sorted = sheetFetch(
    [
      ["https://raider.io/characters/eu/hyjal/a"],
      ["https://raider.io/characters/eu/hyjal/b"]
    ],
    {
      serials: [[2], [1]],
      links: [
        ["https://raider.io/characters/eu/hyjal/b"],
        ["https://raider.io/characters/eu/hyjal/a"]
      ]
    }
  );
  await expect(
    createApplicantSheetClient({
      sheetId: "s",
      column: "F",
      apiKey: "k",
      fetch: sorted as typeof globalThis.fetch
    }).readRows()
  ).rejects.toThrow("applicant_sheet_rows_moved");
  const deleted = sheetFetch(
    [
      ["https://raider.io/characters/eu/hyjal/a"],
      ["https://raider.io/characters/eu/hyjal/b"]
    ],
    { serials: [[1]], links: [["https://raider.io/characters/eu/hyjal/a"]] }
  );
  await expect(
    createApplicantSheetClient({
      sheetId: "s",
      column: "F",
      apiKey: "k",
      fetch: deleted as typeof globalThis.fetch
    }).readRows()
  ).rejects.toThrow("applicant_sheet_rows_moved");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm vitest run apps/worker/src/applicant-sheet.test.ts`
Expected: FAIL. `submittedSerial` is undefined, and there's no second request.

- [ ] **Step 3: Implement**

Add `submittedSerial: number | undefined;` to `ApplicantSheetRow`. In `readRows`, after the first batchGet has produced `details` and `links`, and before building the rows:

```ts
// The timestamp is read unformatted, as the spreadsheet's own serial, in
// a request of its own: unformatted values would turn an 18-digit Discord
// id in the first read into a lossy double. The link column comes back
// with it so the two reads can be proved to describe the same rows.
const serialParams = new URLSearchParams({
  majorDimension: "ROWS",
  valueRenderOption: "UNFORMATTED_VALUE",
  dateTimeRenderOption: "SERIAL_NUMBER"
});
serialParams.append("ranges", "'Form Responses'!A2:A");
serialParams.append("ranges", range);
const second = await readBody(
  `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(options.sheetId)}/values:batchGet?${serialParams.toString()}`
);
if (!isList(second.valueRanges) || second.valueRanges.length !== 2)
  throw new Error("applicant_sheet_response_invalid");
const [serials, recheck] = second.valueRanges.map((item) =>
  item && typeof item === "object" && "values" in item ? item.values : []
);
if (
  !isList(serials) ||
  !isList(recheck) ||
  serials.length > 5_000 ||
  recheck.length > 5_000
)
  throw new Error("applicant_sheet_bounds_exceeded");
// Forms appends, so a longer second read is rows submitted between the
// two; anything else -- a sort, a deletion -- would misalign them.
const cellOf = (rows: readonly unknown[], index: number) => {
  const row = rows[index];
  return isList(row) ? row[0] : undefined;
};
for (let index = 0; index < links.length; index++) {
  if (cellOf(links, index) !== cellOf(recheck, index))
    throw new Error("applicant_sheet_rows_moved");
}
for (let index = links.length; index < recheck.length; index++) {
  if (index < details.length && cellOf(recheck, index) !== undefined)
    throw new Error("applicant_sheet_rows_moved");
}
```

When building each row, add:

```ts
            submittedSerial: (() => {
              const value = cellOf(serials, index);
              return typeof value === "number" && Number.isFinite(value)
                ? value
                : undefined;
            })(),
```

Fix the existing `readRows` test (the third test in the file) so its fetch fake answers the second request, using the same shape as `sheetFetch`.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/applicant-sheet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/applicant-sheet.ts apps/worker/src/applicant-sheet.test.ts
git commit -m "feat(worker): read the Forms timestamp beside the link column and refuse misaligned rows"
```

---

### Task 4: Record applications at intake

**Files:**

- Create: `apps/worker/src/applicant-applications.ts` (row selection, a pure function)
- Create: `apps/worker/src/applicant-applications.test.ts`
- Modify: `apps/worker/src/applicant-watcher.ts` (`CountRow`, `DeferredObservation`, `reconcileApplicantCounts`, `pollApplicantSheet`)
- Test: `tests/integration/applicant-watcher.test.ts`

**Interfaces:**

- Produces, from `applicant-applications.ts`:

```ts
export const applicationLinkCap = 5;
export type IntakeRow = {
  /** Sheet row number, for alerts only; never stored. */
  row: number;
  submittedSerial: number | undefined;
  /** Accepted candidate identities, in cell order, de-duplicated. */
  identities: readonly string[];
};
export function chooseApplicationRow(input: {
  rows: readonly IntakeRow[];
  rootIdentity: string;
  /** The mark this occurrence carries; rows at or below it are old. */
  carriedMark: number;
  /** submitted_serial of the identity's newest application, if any. */
  lastApplicationSerial: number | undefined;
}): { row: IntakeRow | undefined; ambiguous: number };
```

- Produces: `reconcileApplicantCounts` takes an optional last argument, `intake?: { rows: readonly IntakeRow[] }`. Its result gains:

```ts
startMark: number | null;
/** Identities whose occurrence count rose in this poll (recorded or deferred). */
risen: ReadonlySet<string>;
/** New occurrences from deferred entries written before marks existed. */
unmarkedOccurrences: {
  identity: string;
  index: number;
}
[];
applications: {
  recorded: number;
  ambiguous: number;
  overCap: number;
}
```

`CountRow.deferred_observed_ats` entries may now be `{ at: string; index: number; mark: number | null }`.

- [ ] **Step 1: Write the failing unit tests for row choice**

`apps/worker/src/applicant-applications.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chooseApplicationRow, type IntakeRow } from "./applicant-applications";

const x = 'character:["eu","hyjal","tropipe"]';
const y = 'character:["eu","hyjal","tropicos"]';
const row = (
  n: number,
  serial: number | undefined,
  ...identities: string[]
): IntakeRow => ({
  row: n,
  submittedSerial: serial,
  identities
});

describe("chooseApplicationRow", () => {
  it("chooses the one new row whose first link is the identity", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 10, y, x), row(3, 20, x, y)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      })
    ).toEqual({ row: row(3, 20, x, y), ambiguous: 0 });
  });

  it("chooses by serial, not position, after a sort", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 20, x, y), row(3, 10, x)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      }).row?.submittedSerial
    ).toBe(20);
  });

  it("records nothing when the identity is new only as a reference", () => {
    // Break caught: a pre-mark row whose first link later appeared as a
    // reference in someone else's row became a backfilled application.
    expect(
      chooseApplicationRow({
        rows: [row(2, 5, x, y), row(3, 20, y, x)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      })
    ).toEqual({ row: undefined, ambiguous: 0 });
  });

  it("ignores rows no newer than the identity's last application", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 20, x, y)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: 20
      }).row
    ).toBeUndefined();
  });

  it("takes the newest of several and counts the rest", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, 20, x), row(3, 30, x, y)],
        rootIdentity: x,
        carriedMark: 15,
        lastApplicationSerial: undefined
      })
    ).toEqual({ row: row(3, 30, x, y), ambiguous: 1 });
  });

  it("never chooses a row without a serial", () => {
    expect(
      chooseApplicationRow({
        rows: [row(2, undefined, x, y)],
        rootIdentity: x,
        carriedMark: 0,
        lastApplicationSerial: undefined
      }).row
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm vitest run apps/worker/src/applicant-applications.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement row choice**

`apps/worker/src/applicant-applications.ts`:

```ts
/** More links than this in one response looks like more than one person's. */
export const applicationLinkCap = 5;

export type IntakeRow = {
  /** Sheet row number, for alerts only; never stored. */
  row: number;
  submittedSerial: number | undefined;
  /** Accepted candidate identities, in cell order, de-duplicated. */
  identities: readonly string[];
};

/**
 * The response an identity's new root occurrence came from. Rows are chosen by
 * the Forms timestamp, never by position, so a sorted or edited sheet cannot
 * attach one applicant's characters to another's response.
 */
export function chooseApplicationRow(input: {
  rows: readonly IntakeRow[];
  rootIdentity: string;
  carriedMark: number;
  lastApplicationSerial: number | undefined;
}): { row: IntakeRow | undefined; ambiguous: number } {
  const floor = Math.max(
    input.carriedMark,
    input.lastApplicationSerial ?? Number.NEGATIVE_INFINITY
  );
  const candidates = input.rows.filter(
    (row) =>
      row.identities[0] === input.rootIdentity &&
      row.submittedSerial !== undefined &&
      row.submittedSerial > floor
  );
  if (candidates.length === 0) return { row: undefined, ambiguous: 0 };
  const newest = candidates.reduce((best, row) =>
    row.submittedSerial! > best.submittedSerial! ? row : best
  );
  return { row: newest, ambiguous: candidates.length - 1 };
}
```

Run the unit tests. Expected: PASS.

- [ ] **Step 4: Write the failing integration tests for intake**

In `tests/integration/applicant-watcher.test.ts`, add a helper that drives `pollApplicantSheet` through `readRows` with serials, and the tests. These tests share one database with the file's earlier tests, so start each with a cleanup of the applicant tables:

```ts
async function resetApplicantSource() {
  await pool.query(
    "TRUNCATE applicant_source_application_members, applicant_source_applications, applicant_source_intents, applicant_source_counts, applicant_source_state CASCADE"
  );
}
const tp = "https://raider.io/characters/eu/hyjal/tropipe";
const tc = "https://raider.io/characters/eu/hyjal/tropicos";
const tx = "https://raider.io/characters/eu/hyjal/tropixa";
const tpId = 'character:["eu","hyjal","tropipe"]';
const tcId = 'character:["eu","hyjal","tropicos"]';
async function pollRows(rows: Array<[number | undefined, string]>) {
  return pollApplicantSheet({
    pool,
    readRows: async () =>
      rows.map(([serial, linkCell], index) => ({
        row: index + 2,
        battletag: "tag#1",
        discordId: "1",
        characterName: "Name",
        linkCell,
        submittedSerial: serial
      })),
    backlogLimit: 100,
    isSuppressed: async () => false
  });
}
async function applications() {
  const result = await pool.query<{
    root_identity: string;
    submitted_serial: number;
    over_cap: boolean;
    members: string[] | null;
  }>(
    `SELECT a.root_identity, a.submitted_serial, a.over_cap,
            array_agg(m.identity ORDER BY m.ordinal) FILTER (WHERE m.identity IS NOT NULL) AS members
       FROM applicant_source_applications a
       LEFT JOIN applicant_source_application_members m ON m.application_id = a.id
      GROUP BY a.id ORDER BY a.created_at, a.submitted_serial`
  );
  return result.rows;
}

it("records an application, with members in cell order, for a new multi-link response", async () => {
  await resetApplicantSource();
  await pollRows([[10, tx]]); // baseline: sets the mark to 10
  await pollRows([
    [10, tx],
    [20, `${tp} ${tc}`]
  ]);
  expect(await applications()).toEqual([
    {
      root_identity: tpId,
      submitted_serial: 20,
      over_cap: false,
      members: [tcId]
    }
  ]);
});

it("records nothing on the first poll after deploy, and only sets the mark", async () => {
  await resetApplicantSource();
  await pollRows([[10, tx]]);
  await pool.query(
    "UPDATE applicant_source_state SET submitted_serial_mark = NULL"
  );
  const result = await pollRows([
    [10, tx],
    [20, `${tp} ${tc}`]
  ]);
  expect(await applications()).toEqual([]);
  expect(result.newApplicants.length).toBeGreaterThan(0); // per-occurrence alerts, as today
  const mark = await pool.query(
    "SELECT submitted_serial_mark FROM applicant_source_state"
  );
  expect(mark.rows[0].submitted_serial_mark).toBe(20);
});

it("records nothing for single-link responses or a pre-mark response's later reference", async () => {
  await resetApplicantSource();
  await pollRows([[5, `${tp} ${tc}`]]); // baseline
  await pollRows([
    [5, `${tp} ${tc}`],
    [20, `${tx} ${tp}`],
    [21, tc]
  ]);
  const rows = await applications();
  expect(rows.map((row) => row.root_identity)).toEqual([
    'character:["eu","hyjal","tropixa"]'
  ]);
});

it("chooses the response by serial after the sheet is sorted", async () => {
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  await pollRows([
    [20, `${tp} ${tc}`],
    [5, tx]
  ]);
  expect((await applications())[0]).toMatchObject({
    root_identity: tpId,
    submitted_serial: 20
  });
});

it("records an over-cap response without members", async () => {
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  const six = ["a", "b", "c", "d", "e", "f"]
    .map((name) => `https://raider.io/characters/eu/hyjal/over${name}`)
    .join(" ");
  await pollRows([
    [5, tx],
    [20, six]
  ]);
  expect(await applications()).toEqual([
    {
      root_identity: 'character:["eu","hyjal","overa"]',
      submitted_serial: 20,
      over_cap: true,
      members: null
    }
  ]);
  const closed = await pool.query(
    "SELECT closed_at FROM applicant_source_applications"
  );
  expect(closed.rows[0].closed_at).not.toBeNull();
});

it("records a deferred root's application in a later poll, from the mark it carried", async () => {
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: tx,
        submittedSerial: 5
      },
      {
        row: 3,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: `${tp} ${tc}`,
        submittedSerial: 20
      }
    ],
    backlogLimit: 100,
    isSuppressed: async (identity) => (identity === tpId ? "defer" : false)
  });
  expect(await applications()).toEqual([]);
  await pollRows([
    [5, tx],
    [20, `${tp} ${tc}`]
  ]);
  expect(await applications()).toEqual([
    {
      root_identity: tpId,
      submitted_serial: 20,
      over_cap: false,
      members: [tcId]
    }
  ]);
});

it("ties each member to its own intent, filling a deferred member in later", async () => {
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: tx,
        submittedSerial: 5
      },
      {
        row: 3,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: `${tp} ${tc}`,
        submittedSerial: 20
      }
    ],
    backlogLimit: 100,
    isSuppressed: async (identity) => (identity === tcId ? "defer" : false)
  });
  const before = await pool.query(
    "SELECT member_intent_sequence FROM applicant_source_application_members"
  );
  expect(before.rows).toEqual([{ member_intent_sequence: null }]);
  await pollRows([
    [5, tx],
    [20, `${tp} ${tc}`]
  ]);
  const after = await pool.query<{
    member_intent_sequence: string;
    sequence: string;
  }>(
    `SELECT m.member_intent_sequence, i.sequence
       FROM applicant_source_application_members m
       JOIN applicant_source_intents i ON i.identity = m.identity`
  );
  expect(after.rows[0]?.member_intent_sequence).toBe(after.rows[0]?.sequence);
});

it("settles an application at intake when its root is inserted suppressed", async () => {
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: tx,
        submittedSerial: 5
      },
      {
        row: 3,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: `${tp} ${tc}`,
        submittedSerial: 20
      }
    ],
    backlogLimit: 100,
    isSuppressed: async (identity) => identity === tpId
  });
  const settled = await pool.query(
    "SELECT settled_at FROM applicant_source_applications"
  );
  expect(settled.rows[0].settled_at).not.toBeNull();
});
```

- [ ] **Step 5: Run them and watch them fail**

Run: `corepack pnpm test:integration -- tests/integration/applicant-watcher.test.ts`
Expected: the new tests FAIL, because no applications are recorded.

- [ ] **Step 6: Implement intake in `reconcileApplicantCounts` and `pollApplicantSheet`**

In `apps/worker/src/applicant-watcher.ts`:

1. **Types.**
   - Widen `CountRow.deferred_observed_ats` to `(string | { at: string; index: number; mark?: number | null })[]`.
   - Change `DeferredObservation` to `{ at: Date; index: number; mark: number | null | "unmarked" }`. Here `"unmarked"` means an entry from before marks existed, and `null` means it was first seen while the mark was NULL.
   - Import `applicationLinkCap`, `chooseApplicationRow` and `type IntakeRow` from `./applicant-applications`.

2. **Signature.** Add a final optional parameter, `intake?: { rows: readonly IntakeRow[] }`, and extend the return type as listed under **Interfaces**.

3. **Read the mark.** In the state query, select `submitted_serial_mark` too: `SELECT parser_version, submitted_serial_mark FROM applicant_source_state WHERE source = $1`. Set `const startMark = state.rows[0]?.submitted_serial_mark ?? null;`.

4. **Maximum serial.** Compute `const maxSerial = Math.max(Number.NEGATIVE_INFINITY, ...(intake?.rows ?? []).flatMap((row) => row.submittedSerial === undefined ? [] : [row.submittedSerial]));`.

5. **Baseline branch.** When `state.rowCount === 0`, insert `submitted_serial_mark` in the `INSERT INTO applicant_source_state`, as `Number.isFinite(maxSerial) ? maxSerial : null`. In the return, add `startMark: null, risen: new Set(), unmarkedOccurrences: [], applications: { recorded: 0, ambiguous: 0, overCap: 0 }`.

6. **Deferred entries.** When mapping them into `pendingTimes`, read the mark:

   ```ts
   typeof value === "string"
     ? { at: new Date(value), index: before + index, mark: "unmarked" as const }
     : {
         at: new Date(value.at),
         index: value.index + shift,
         mark: value.mark === undefined ? ("unmarked" as const) : value.mark
       };
   ```

   Fresh occurrences get `mark: startMark`. When an occurrence is deferred again (`remaining.push(occurrence)`), it keeps its mark. `JSON.stringify(remaining)` already writes `{ at, index, mark }`; an `"unmarked"` entry is written with `mark` omitted, so map those before stringifying: `remaining.map(({ at, index, mark }) => mark === "unmarked" ? { at, index } : { at, index, mark })`.

7. **`risen`.** Before the per-identity loop, `const risen = new Set<string>();`. Inside it, when not `rebaselined` and `current > counted + deferred.length`, add the identity.

8. **Intent insert.** Change the insert to `... RETURNING sequence`, and keep `const insertedThisPoll = new Map<string, string>();`, from identity to the latest sequence inserted in this transaction. After each insert:

   ```ts
   const sequence = inserted.rows[0]!.sequence;
   insertedThisPoll.set(identity, sequence);
   // A member waiting for this identity's intent is tied to this one.
   await client.query(
     `UPDATE applicant_source_application_members member
         SET member_intent_sequence = $2
        FROM applicant_source_applications application
       WHERE member.application_id = application.id
         AND application.closed_at IS NULL
         AND member.identity = $1
         AND member.member_intent_sequence IS NULL`,
     [identity, sequence]
   );
   if (occurrence.mark === "unmarked")
     unmarkedOccurrences.push({ identity, index: occurrence.index });
   if (
     intake &&
     !rebaselined &&
     occurrence.mark !== "unmarked" &&
     occurrence.mark !== null
   )
     await recordApplication(client, {
       rows: intake.rows,
       rootIdentity: identity,
       rootSequence: sequence,
       rootSuppressed: suppressed,
       rootObservedAt: occurrence.at,
       carriedMark: occurrence.mark,
       insertedThisPoll,
       counts: applicationCounts
     });
   ```

   Declare `const unmarkedOccurrences: { identity: string; index: number }[] = [];` and `const applicationCounts = { recorded: 0, ambiguous: 0, overCap: 0 };` before the loop.

9. **Store the mark.** Before `UPDATE applicant_source_state SET last_polled_at …`, add the mark to the same statement:

   ```ts
   await client.query(
     "UPDATE applicant_source_state SET last_polled_at = $2, parser_version = $3, submitted_serial_mark = GREATEST(submitted_serial_mark, $4::double precision) WHERE source = $1",
     [source, at, parserVersion, Number.isFinite(maxSerial) ? maxSerial : null]
   );
   ```

   PostgreSQL's `GREATEST` ignores NULLs, so a NULL mark becomes `maxSerial`.

10. **Return.** Return `startMark`, `risen`, `unmarkedOccurrences` and `applications: applicationCounts` alongside the existing fields.

Add the helper in the same file:

```ts
async function recordApplication(
  client: PoolClient,
  input: {
    rows: readonly IntakeRow[];
    rootIdentity: string;
    rootSequence: string;
    rootSuppressed: boolean;
    rootObservedAt: Date;
    carriedMark: number;
    insertedThisPoll: ReadonlyMap<string, string>;
    counts: { recorded: number; ambiguous: number; overCap: number };
  }
): Promise<void> {
  const last = await client.query<{ serial: number | null }>(
    "SELECT max(submitted_serial) AS serial FROM applicant_source_applications WHERE root_identity = $1",
    [input.rootIdentity]
  );
  const { row, ambiguous } = chooseApplicationRow({
    rows: input.rows,
    rootIdentity: input.rootIdentity,
    carriedMark: input.carriedMark,
    lastApplicationSerial: last.rows[0]?.serial ?? undefined
  });
  input.counts.ambiguous += ambiguous;
  if (!row || row.identities.length < 2) return;
  const overCap = row.identities.length > applicationLinkCap;
  const created = await client.query<{ id: string }>(
    `INSERT INTO applicant_source_applications
       (source, root_intent_sequence, root_identity, submitted_serial, over_cap,
        settled_at, closed_at)
     VALUES ($1, $2, $3, $4, $5,
             CASE WHEN $6::boolean THEN now() END,
             CASE WHEN $5::boolean THEN now() END)
     RETURNING id`,
    [
      source,
      input.rootSequence,
      input.rootIdentity,
      row.submittedSerial,
      overCap,
      input.rootSuppressed
    ]
  );
  if (overCap) {
    input.counts.overCap++;
    return;
  }
  input.counts.recorded++;
  for (const [offset, identity] of row.identities.slice(1).entries()) {
    // The member's own intent: one inserted in this transaction, or -- when
    // the root was deferred and recorded in a later poll -- the one inserted
    // when this response was first seen (observed at or after the root's
    // first sighting). None yet means the member is still deferred; its
    // insert fills this in.
    const existing = input.insertedThisPoll.has(identity)
      ? undefined
      : await client.query<{ sequence: string | null }>(
          "SELECT max(sequence)::text AS sequence FROM applicant_source_intents WHERE source = $1 AND identity = $2 AND observed_at >= $3",
          [source, identity, input.rootObservedAt]
        );
    await client.query(
      `INSERT INTO applicant_source_application_members
         (application_id, ordinal, identity, member_intent_sequence)
       VALUES ($1, $2, $3, $4)`,
      [
        created.rows[0]!.id,
        offset + 1,
        identity,
        input.insertedThisPoll.get(identity) ??
          existing?.rows[0]?.sequence ??
          null
      ]
    );
  }
}
```

The deferred-root test ("records a deferred root's application in a later poll…") depends on this. There, the member `tropicos` was inserted in the first poll and the root in the second, and the member must still be tied to its intent. Extend that test to assert that `member_intent_sequence` is not null.

Import `PoolClient` from `pg` as a type.

**Iteration order.** The per-identity loop inserts in `Set` order, so a member's intent may be inserted after its root's application in the same transaction. The fill-in `UPDATE` after every insert covers that case, so this is correct in both orders.

In `pollApplicantSheet`, build the intake rows while parsing, and pass them in:

```ts
const intakeRows: IntakeRow[] = [];
// inside `for (const row of rows)`, after `parsed`:
intakeRows.push({
  row: row.row,
  submittedSerial: "submittedSerial" in row ? row.submittedSerial : undefined,
  identities: parsed.candidates.map((candidate) => candidate.identity)
});
```

Then call `reconcileApplicantCounts(..., input.parserVersion, { rows: intakeRows })`. A test that uses `readColumn` passes rows without serials, which never become applications, so its existing behaviour is unchanged.

- [ ] **Step 7: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/applicant-applications.test.ts`
Run: `corepack pnpm test:integration -- tests/integration/applicant-watcher.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/applicant-applications.ts apps/worker/src/applicant-applications.test.ts apps/worker/src/applicant-watcher.ts tests/integration/applicant-watcher.test.ts
git commit -m "feat(worker): record each new multi-link application at intake"
```

---

### Task 5: One alert per new row

**Files:**

- Modify: `apps/worker/src/applicant-watcher.ts` (`NewApplicant`, and the tail of `pollApplicantSheet`)
- Modify: `packages/application/src/discovery-job-handler.ts:167-173` (the `applicant` alert shape)
- Modify: `apps/worker/src/notifiers.ts` (`announceNewApplicantIntents` and the Discord rendering)
- Test: `tests/integration/applicant-watcher.test.ts`, `apps/worker/src/runtime.test.ts` (the notifier tests near line 1036)

**Interfaces:**

- Produces:
  - `NewApplicant` gains `otherCharacters?: number` and `linking?: "pending" | "over_cap" | "disabled"`.
  - `pollApplicantSheet` takes `linkingEnabled?: boolean`, defaulting to false.
  - The alert's `applicant` gains `linking?: "pending" | "over_cap" | "disabled"`, and `details` carries `otherCharacters` when it's greater than 0.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/applicant-watcher.test.ts`:

```ts
it("alerts once per new response, even when all its links are deferred", async () => {
  // Break caught: a four-link response sent four alerts; and a response whose
  // links were all deferred never alerted at all once the mark passed it.
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  const result = await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: tx,
        submittedSerial: 5
      },
      {
        row: 3,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: `${tp} ${tc}`,
        submittedSerial: 20
      }
    ],
    backlogLimit: 100,
    linkingEnabled: true,
    isSuppressed: async () => "defer"
  });
  expect(result.newApplicants).toEqual([
    expect.objectContaining({
      characterUrl: tp,
      otherCharacters: 1,
      linking: "pending"
    })
  ]);
  const later = await pollRows([
    [5, tx],
    [20, `${tp} ${tc}`]
  ]);
  expect(later.newApplicants).toEqual([]);
});

it("sends no alert for an edited response whose counts did not rise", async () => {
  await resetApplicantSource();
  await pollRows([[5, `${tp} ${tc}`]]);
  const result = await pollRows([[30, `${tc} ${tp}`]]);
  expect(result.newApplicants).toEqual([]);
});

it("says an over-cap response will not be linked", async () => {
  await resetApplicantSource();
  await pollRows([[5, tx]]);
  const six = ["a", "b", "c", "d", "e", "f"]
    .map((name) => `https://raider.io/characters/eu/hyjal/capped${name}`)
    .join(" ");
  const result = await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: tx,
        submittedSerial: 5
      },
      {
        row: 3,
        battletag: "t",
        discordId: "1",
        characterName: "N",
        linkCell: six,
        submittedSerial: 20
      }
    ],
    backlogLimit: 100,
    linkingEnabled: true,
    isSuppressed: async () => false
  });
  expect(result.newApplicants).toEqual([
    expect.objectContaining({ otherCharacters: 5, linking: "over_cap" })
  ]);
});
```

In `apps/worker/src/runtime.test.ts`, beside the existing applicant rendering test (about line 1047), add:

```ts
it("renders how many other characters an application listed and whether they will be linked", async () => {
  const posted: string[] = [];
  // build the notifier as the neighbouring test does, capturing the body's `content`
  // ...then:
  await notifier.notify({
    event: "applicant_new_intents",
    details: { count: 1, otherCharacters: 2 },
    applicant: {
      characterUrl: "https://raider.io/characters/eu/hyjal/tropipe",
      dossierUrl: "https://slashwho.com/dossiers/eu/hyjal/tropipe",
      linking: "pending"
    }
  });
  expect(posted[0]).toContain("otherCharacters: 2");
  expect(posted[0]).toContain(
    "Linking: they'll be linked if they pass the checks"
  );
});
```

Copy the notifier and webhook capture from the test at line 1047 into the body above, in place of the comment.

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm test:integration -- tests/integration/applicant-watcher.test.ts -t "alert"`, then `corepack pnpm vitest run apps/worker/src/runtime.test.ts -t "other characters"`.
Expected: FAIL.

- [ ] **Step 3: Implement**

In `discovery-job-handler.ts`, add `linking?: "pending" | "over_cap" | "disabled";` to the `applicant` shape.

In `notifiers.ts`, in the Discord `content` for an applicant, add this line after the `Dossier:` line:

```ts
            ...(applicant.linking
              ? [
                  `Linking: ${
                    applicant.linking === "pending"
                      ? "they'll be linked if they pass the checks"
                      : applicant.linking === "over_cap"
                        ? "too many to link automatically"
                        : "automatic linking is off"
                  }`
                ]
              : [])
```

In `announceNewApplicantIntents`, pass `otherCharacters` through to `details` and `linking` through to `applicant`:

```ts
const { dossierPath, otherCharacters, linking, ...details } = applicant;
await notifier?.notify({
  event: "applicant_new_intents",
  details: { count: 1, ...(otherCharacters ? { otherCharacters } : {}) },
  applicant: {
    ...details,
    ...(linking ? { linking } : {}),
    ...(dossierPath && dossierBaseUrl
      ? { dossierUrl: new URL(dossierPath, dossierBaseUrl).toString() }
      : {})
  }
});
```

In `pollApplicantSheet`:

- Add the `linkingEnabled?: boolean` input.
- Keep a `rowDetails: Map<number, NewApplicant>` holding each row's first candidate's applicant, built where `occurrences` is built today.
- Replace the `newApplicants` computation with:

```ts
const {
  newOccurrences,
  startMark,
  risen,
  unmarkedOccurrences,
  applications,
  ...state
} = reconciliation;
const perOccurrence = (list: { identity: string; index: number }[]) =>
  list.flatMap(({ identity, index }) => {
    const applicant = occurrences.get(identity)?.[index];
    if (!applicant) return [];
    const resolvedPath = input.resolveDossierPath?.(identity);
    return [
      { ...applicant, ...(resolvedPath ? { dossierPath: resolvedPath } : {}) }
    ];
  });
let newApplicants: NewApplicant[];
if (state.baseline || state.rebaselined) newApplicants = [];
else if (startMark === null) newApplicants = perOccurrence(newOccurrences);
else {
  // One alert per response first seen in this poll, whether its links were
  // recorded or deferred; a deferred link later inserted never alerts again.
  newApplicants = intakeRows
    .filter(
      (row) =>
        row.submittedSerial !== undefined &&
        row.submittedSerial > startMark &&
        row.identities.some((identity) => risen.has(identity))
    )
    .flatMap((row) => {
      const applicant = rowDetails.get(row.row);
      if (!applicant) return [];
      const others = row.identities.length - 1;
      const resolvedPath = input.resolveDossierPath?.(row.identities[0]!);
      return [
        {
          ...applicant,
          ...(resolvedPath ? { dossierPath: resolvedPath } : {}),
          ...(others > 0
            ? {
                otherCharacters: others,
                linking: !input.linkingEnabled
                  ? ("disabled" as const)
                  : row.identities.length > applicationLinkCap
                    ? ("over_cap" as const)
                    : ("pending" as const)
              }
            : {})
        }
      ];
    })
    .concat(perOccurrence(unmarkedOccurrences));
}
```

Return `newApplicants` and `applications` (the counts). In `runtime.ts`, pass `linkingEnabled: config.applicantWatcher.linkingEnabled` to `pollApplicantSheet`, and add `applications: poll.applications` to the `applicant_sheet_poll` log record. Update the expected record in the runtime test "times the applicant sheet poll and drain" to match.

A few existing integration tests assert the old per-occurrence `newApplicants`, for example "attributes a repeated character submission to the later response". They use `readColumn`, whose rows have no serial, and their state has a NULL mark, so they stay on the per-occurrence path. If any assert differently, it is because they now set a mark; leave their behaviour as it was by keeping them on `readColumn`.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts && corepack pnpm test:integration -- tests/integration/applicant-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/applicant-watcher.ts apps/worker/src/notifiers.ts apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts packages/application/src/discovery-job-handler.ts tests/integration/applicant-watcher.test.ts
git commit -m "feat(worker): one applicant alert per new response, saying whether its characters will be linked"
```

---

### Task 6: Origin on the manual connection repository

**Files:**

- Modify: `packages/database/src/repositories.ts` (`ManualConnectionCharacter`, about line 199, and `ManualConnectionRepository.add`, about line 222)
- Modify: `packages/database/src/small-stores.ts` (`add`, about lines 70-94, and `list`, about lines 96-150)
- Test: `tests/integration/manual-connections.test.ts`, or the existing integration file that covers `manualConnections`. Find it with `git grep -ln "manualConnections.add" tests/`.

**Interfaces:**

- Produces:

```ts
// ManualConnectionCharacter gains:
  origin: "dossier" | "applicant_sheet";
// ManualConnectionRepository.add becomes:
  add(
    root: CharacterKey,
    character: CharacterKey,
    options?: { origin: "applicant_sheet"; applicationId: string }
  ): Promise<"added" | "duplicate">;
```

Without `options`, it's a reviewer's add: it inserts with `origin = 'dossier'`, or converts an `applicant_sheet` row, which reports `duplicate`. With `options`, it's the worker's add: `ON CONFLICT DO NOTHING`.

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps a reviewer's link when the worker adds the same one, and converts the worker's when a reviewer does", async () => {
  // Break caught: ON CONFLICT DO NOTHING left a reviewer's own add marked as
  // the applicant's, and DO UPDATE ... RETURNING reported a re-add as "added".
  const repositories = createPostgresRepositories(pool);
  const root = { region: "eu" as const, realm: "hyjal", name: "originroot" };
  const member = {
    region: "eu" as const,
    realm: "hyjal",
    name: "originmember"
  };
  const other = { region: "eu" as const, realm: "hyjal", name: "originother" };
  await pool.query(
    "INSERT INTO characters (region, realm_slug, normalized_name, display_name) VALUES ('eu', 'hyjal', 'originroot', 'Originroot')"
  );
  const application = await insertApplication(pool); // see helper below

  expect(
    await repositories.manualConnections.add(root, member, {
      origin: "applicant_sheet",
      applicationId: application
    })
  ).toBe("added");
  await repositories.manualConnections.setExcluded(root, member, true);
  expect(await repositories.manualConnections.add(root, member)).toBe(
    "duplicate"
  );
  const converted = (await repositories.manualConnections.list(root)).find(
    (row) => row.key.name === "originmember"
  );
  expect(converted).toMatchObject({ origin: "dossier", excluded: true });
  expect(await repositories.manualConnections.add(root, member)).toBe(
    "duplicate"
  );

  expect(await repositories.manualConnections.add(root, other)).toBe("added");
  expect(
    await repositories.manualConnections.add(root, other, {
      origin: "applicant_sheet",
      applicationId: application
    })
  ).toBe("duplicate");
  expect(
    (await repositories.manualConnections.list(root)).find(
      (row) => row.key.name === "originother"
    )?.origin
  ).toBe("dossier");
});
```

with the helper:

```ts
async function insertApplication(pool: Pool): Promise<string> {
  await pool.query(
    "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at, parser_version) VALUES ('applicant_sheet', now(), now(), 2) ON CONFLICT DO NOTHING"
  );
  const intent = await pool.query<{ sequence: string }>(
    'INSERT INTO applicant_source_intents (source, identity, observed_at) VALUES (\'applicant_sheet\', \'character:["eu","hyjal","originroot"]\', now()) RETURNING sequence'
  );
  const application = await pool.query<{ id: string }>(
    'INSERT INTO applicant_source_applications (source, root_intent_sequence, root_identity, submitted_serial) VALUES (\'applicant_sheet\', $1, \'character:["eu","hyjal","originroot"]\', 1) RETURNING id',
    [intent.rows[0]!.sequence]
  );
  return application.rows[0]!.id;
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm test:integration -- <that file>`
Expected: FAIL. `origin` is undefined, and the third argument is ignored.

- [ ] **Step 3: Implement**

Update the types in `repositories.ts` as listed under **Interfaces**. Then, in `small-stores.ts`:

```ts
      async add(root, character, options) {
        // The connected side is a key, so this records the link whether or not
        // the character has been discovered yet. Only the root must exist.
        //
        // The worker never overwrites a row. A reviewer's add converts the
        // worker's row to a reviewer link (keeping any exclusion) but reports
        // it as a duplicate: it was already linked. `xmax = 0` tells a fresh
        // insert from that conversion; a reviewer row matches no update and
        // returns nothing.
        const conflict = options
          ? "ON CONFLICT DO NOTHING"
          : `ON CONFLICT (root_character_id, connected_region, connected_realm_slug, connected_normalized_name)
             DO UPDATE SET origin = 'dossier', applicant_application_id = NULL
             WHERE manual_dossier_connections.origin <> 'dossier'`;
        const result = await pool.query<{ inserted: boolean }>(
          `INSERT INTO manual_dossier_connections
             (root_character_id, connected_region, connected_realm_slug,
              connected_normalized_name, origin, applicant_application_id)
           SELECT root.id, $4, $5, $6, $7, $8
           FROM characters root
           WHERE root.region = $1
             AND root.realm_slug = $2
             AND root.normalized_name = $3
           ${conflict}
           RETURNING (xmax = 0) AS inserted`,
          [
            root.region,
            root.realm,
            root.name,
            character.region,
            character.realm,
            character.name,
            options?.origin ?? "dossier",
            options?.applicationId ?? null
          ]
        );
        return result.rows[0]?.inserted === true ? "added" : "duplicate";
      },
```

In `list`, select `connection.origin` and return `origin: row.origin as "dossier" | "applicant_sheet"`.

Every fake `manualConnections.list` in tests must now return `origin`. Find them with `git grep -n "pending: \(true\|false\)" -- '*.test.ts' tests/ apps/web` and add `origin: "dossier"` beside each.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `corepack pnpm typecheck && corepack pnpm test:integration -- <that file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/database tests apps
git commit -m "feat(database): manual connections carry an origin; a reviewer's add wins"
```

---

### Task 7: Label "From application" on the dossier

**Files:**

- Modify: `packages/contracts/src/dossier.ts` (`dossierCharacterSchema`, about line 98)
- Modify: `packages/application/src/dossier-subjects.ts` (the `DossierSubject` type, line 14, and the manual admit near line 154)
- Modify: `packages/application/src/applicant-dossier-service.ts` (the response mapping, about lines 785-805)
- Modify: `apps/web/src/components/dossier-character-list.tsx` (`sourceLabel`, about line 38, and where it's rendered)
- Test: `apps/web/src/components/dossier-character-list.test.tsx`, `apps/web/src/components/dossier-character-menu.test.tsx` (or the test that covers the Remove action; find it with `git grep -ln "Remove" apps/web/src/components/*.test.tsx`), and `packages/application/src/character-groups-replay.test.ts`

**Interfaces:**

- Produces: `DossierCharacter.origin?: "application"`, and `DossierSubject.origin?: "application"`.

- [ ] **Step 1: Write the failing tests**

In `dossier-character-list.test.tsx`, beside the existing `manually_added` cases (about line 342):

```tsx
it("labels a link from an application as such, keeping it a manual connection", () => {
  // Break caught: an applicant's claim read "Manually added", as if a
  // reviewer had vetted it.
  render(
    <DossierCharacterList
      {...baseProps}
      characters={[
        { ...manualCharacter, source: "manually_added", origin: "application" }
      ]}
    />
  );
  expect(screen.getByText("From application")).toBeInTheDocument();
  expect(screen.queryByText("Manually added")).not.toBeInTheDocument();
});
```

Use the file's existing props and fixture names; `baseProps` and `manualCharacter` stand in for whatever the neighbouring `manually_added` test builds.

In the menu test:

```tsx
it("still offers Remove for a link from an application", () => {
  renderMenu({
    character: {
      ...manualCharacter,
      source: "manually_added",
      origin: "application"
    }
  });
  expect(screen.getByRole("menuitem", { name: /remove/i })).toBeInTheDocument();
});
```

In `character-groups-replay.test.ts`, add a case to the `labelOf` tests: a manual connection whose list row has `origin: "applicant_sheet"` gets the label `manually_added`, the same as the group page. That pins that no `label_weakened` comes from origin.

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm vitest run apps/web/src/components packages/application/src/character-groups-replay.test.ts`
Expected: the list test FAILS, because "From application" isn't rendered. The `origin` property is also a type error.

- [ ] **Step 3: Implement**

`packages/contracts/src/dossier.ts`, in `dossierCharacterSchema` after `source`:

```ts
    /**
     * Set only on a manual connection the applicant sheet watcher made from an
     * application. It changes the label alone; the connection is otherwise a
     * manual one, with the same Remove and Exclude actions.
     */
    origin: z.literal("application").optional(),
```

`dossier-subjects.ts`: add `origin?: "application";` to `DossierSubject`. At the manual admit (line 154):

```ts
admit(
  {
    ...character,
    guild: connectedGuild,
    source: "manually_added",
    ...(character.origin === "applicant_sheet"
      ? { origin: "application" as const }
      : {})
  },
  character.excluded ? excluded : manual
);
```

`applicant-dossier-service.ts`, in the mapping beside `source:`:

```ts
    ...(character.origin === "application" ? { origin: "application" as const } : {}),
```

`dossier-character-list.tsx`: where the label is chosen from `sourceLabel[character.source]`, use:

```ts
character.origin === "application"
  ? "From application"
  : sourceLabel[character.source];
```

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm typecheck && corepack pnpm vitest run apps/web packages/application packages/contracts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/contracts packages/application apps/web
git commit -m "feat(web): label connections made from an application as 'From application'"
```

---

### Task 8: The counting component lookup

**Files:**

- Modify: `packages/database/src/character-connections.ts` (export a new function beside `characterIds`, about line 716)
- Modify: `packages/database/src/index.ts` (export it)
- Test: `tests/integration/character-connections.test.ts`. Find the file covering `recomputeComponent` with `git grep -ln "characterConnections" tests/integration`.

**Interfaces:**

- Produces:

```ts
/**
 * Whether two characters are already in one counting component, and whether
 * each sits in a component with anyone else. Walks counting links only --
 * never character_group_members, which lags until a recompute. Stops at
 * `cap` nodes and reports `capped`, which callers treat as "different".
 */
export async function countingComponents(
  pool: Pool,
  rootId: string,
  memberId: string,
  cap?: number
): Promise<{
  same: boolean;
  rootShared: boolean;
  memberShared: boolean;
  capped: boolean;
}>;
```

- [ ] **Step 1: Write the failing test**

```ts
it("reports counting components from links alone", async () => {
  const ids = await insertCharacters(pool, ["cca", "ccb", "ccc", "ccd", "cce"]);
  // a-b observed; c-d via a manual link; e alone.
  await insertObserved(pool, ids.cca, ids.ccb);
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'test', 'ccd')",
    [ids.ccc]
  );
  expect(await countingComponents(pool, ids.cca, ids.ccb)).toEqual({
    same: true,
    rootShared: true,
    memberShared: true,
    capped: false
  });
  expect(await countingComponents(pool, ids.cca, ids.ccc)).toEqual({
    same: false,
    rootShared: true,
    memberShared: true,
    capped: false
  });
  expect(await countingComponents(pool, ids.cca, ids.cce)).toEqual({
    same: false,
    rootShared: true,
    memberShared: false,
    capped: false
  });
});
```

Use the file's existing helpers for inserting characters and observed `character_connections` rows. If there are none, insert directly:

- `characters`: `(region, realm_slug, normalized_name, display_name)`, with region `eu` and realm `test`.
- `character_connections`: `(character_low_id, character_high_id, kind)`, with kind `'observed'` and the ids ordered low before high. Look up the table's other NOT NULL columns in migration `0069_character_groups.sql`.

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL, because `countingComponents` isn't exported.

- [ ] **Step 3: Implement**

```ts
export async function countingComponents(
  pool: Pool,
  rootId: string,
  memberId: string,
  cap = 2_000
): Promise<{
  same: boolean;
  rootShared: boolean;
  memberShared: boolean;
  capped: boolean;
}> {
  const nodes = new Set<string>([rootId]);
  let frontier = [rootId];
  let capped = false;
  while (frontier.length > 0 && !nodes.has(memberId)) {
    const edges = await pool.query<{ a: string; b: string }>(
      COUNTING_LINKS_FROM,
      [frontier]
    );
    const next: string[] = [];
    for (const edge of edges.rows)
      for (const id of [edge.a, edge.b])
        if (!nodes.has(id)) {
          nodes.add(id);
          next.push(id);
        }
    if (nodes.size > cap) {
      capped = true;
      break;
    }
    frontier = next;
  }
  const same = nodes.has(memberId);
  const memberEdges = same
    ? 1
    : ((await pool.query(COUNTING_LINKS_FROM, [[memberId]])).rowCount ?? 0);
  return {
    same,
    rootShared: nodes.size > 1,
    memberShared: memberEdges > 0,
    capped
  };
}
```

Export it from `packages/database/src/index.ts`.

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/character-connections.ts packages/database/src/index.ts tests/integration
git commit -m "feat(database): look up whether two characters share a counting component"
```

---

### Task 9: The linking step

**Files:**

- Create: `apps/worker/src/applicant-links.ts`
- Create: `tests/integration/applicant-links.test.ts`

**Interfaces:**

- Consumes:
  - `countingComponents` (Task 8).
  - `repositories.manualConnections.add(root, member, { origin: "applicant_sheet", applicationId })` (Task 6).
  - `repositories.suppressions.isActive(key, at)`.
  - `decodeApplicantIdentity` from `./applicant-identity`.
- Produces:

```ts
export type ApplicantLinkCounts = {
  linked: number;
  waiting: number;
  suppressed: number;
  same_character: number;
  skipped_region: number;
  skipped_excluded: number;
  skipped_cross_group: number;
  needed_link_pairs: number;
  expired: number;
};
export async function linkApplicantApplications(input: {
  pool: Pool;
  repositories: Pick<Repositories, "manualConnections" | "suppressions">;
  now?: Date;
  batch?: number;
}): Promise<ApplicantLinkCounts>;
export async function closeStaleApplicantApplications(
  pool: Pool,
  now?: Date
): Promise<{ expired: number; deleted: number }>;
```

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/applicant-links.test.ts`. Set it up like `tests/integration/applicant-watcher.test.ts`: `startPostgres` and `runMigrations` in `beforeAll`, with a `TRUNCATE` of the applicant, manual-connection, exclusion and suppression tables in `beforeEach`. Add these helpers:

```ts
async function character(name: string, region = "eu"): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO characters (region, realm_slug, normalized_name, display_name) VALUES ($1, 'hyjal', $2, $2) RETURNING id",
    [region, name]
  );
  return result.rows[0]!.id;
}
const id = (name: string, region = "eu") =>
  `character:["${region}","hyjal","${name}"]`;
async function intent(
  identity: string,
  state: string,
  canonical = identity
): Promise<string> {
  await pool.query(
    "INSERT INTO applicant_source_state (source, initialized_at, last_polled_at, parser_version) VALUES ('applicant_sheet', now(), now(), 2) ON CONFLICT DO NOTHING"
  );
  const result = await pool.query<{ sequence: string }>(
    "INSERT INTO applicant_source_intents (source, identity, canonical_identity, observed_at, state) VALUES ('applicant_sheet', $1, $2, now(), $3) RETURNING sequence",
    [identity, canonical, state]
  );
  return result.rows[0]!.sequence;
}
async function application(
  root: { identity: string; sequence: string },
  members: Array<{ identity: string; sequence: string | null }>
): Promise<string> {
  const created = await pool.query<{ id: string }>(
    "INSERT INTO applicant_source_applications (source, root_intent_sequence, root_identity, submitted_serial) VALUES ('applicant_sheet', $1, $2, 1) RETURNING id",
    [root.sequence, root.identity]
  );
  for (const [index, member] of members.entries())
    await pool.query(
      "INSERT INTO applicant_source_application_members (application_id, ordinal, identity, member_intent_sequence) VALUES ($1, $2, $3, $4)",
      [created.rows[0]!.id, index + 1, member.identity, member.sequence]
    );
  return created.rows[0]!.id;
}
const link = () =>
  linkApplicantApplications({
    pool,
    repositories: createPostgresRepositories(pool)
  });
async function links() {
  const result = await pool.query<{
    root: string;
    connected: string;
    origin: string;
  }>(
    `SELECT r.normalized_name AS root, m.connected_normalized_name AS connected, m.origin
       FROM manual_dossier_connections m JOIN characters r ON r.id = m.root_character_id
      ORDER BY 1, 2`
  );
  return result.rows;
}
```

The tests:

```ts
it("links a member to its root once both exist, as an application connection", async () => {
  await character("tropipe");
  await character("tropicos");
  const root = await intent(id("tropipe"), "done");
  const member = await intent(id("tropicos"), "done");
  await application({ identity: id("tropipe"), sequence: root }, [
    { identity: id("tropicos"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ linked: 1, waiting: 0 });
  expect(await links()).toEqual([
    { root: "tropipe", connected: "tropicos", origin: "applicant_sheet" }
  ]);
  const closed = await pool.query(
    "SELECT closed_at, linked_count FROM applicant_source_applications"
  );
  expect(closed.rows[0]).toMatchObject({ linked_count: 1 });
  expect(closed.rows[0].closed_at).not.toBeNull();
  const members = await pool.query(
    "SELECT 1 FROM applicant_source_application_members"
  );
  expect(members.rowCount).toBe(0);
});

it("waits for an unsettled root, then for an undiscovered one", async () => {
  const root = await intent(id("waitroot"), "pending");
  const member = await intent(id("waitmember"), "done");
  await application({ identity: id("waitroot"), sequence: root }, [
    { identity: id("waitmember"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ linked: 0 });
  await pool.query(
    "UPDATE applicant_source_intents SET state = 'done' WHERE sequence = $1",
    [root]
  );
  expect(await link()).toMatchObject({ linked: 0, waiting: 1 });
  await character("waitroot");
  await character("waitmember");
  expect(await link()).toMatchObject({ linked: 1 });
});

it("links through a Warcraft Logs id once its intent resolves, and roots on a numeric root", async () => {
  await character("numroot");
  await character("nummember");
  const root = await intent("warcraftlogs_id:7", "done", id("numroot"));
  const member = await intent("warcraftlogs_id:8", "pending", null as never);
  await application({ identity: "warcraftlogs_id:7", sequence: root }, [
    { identity: "warcraftlogs_id:8", sequence: member }
  ]);
  expect(await link()).toMatchObject({ linked: 0, waiting: 1 });
  await pool.query(
    "UPDATE applicant_source_intents SET state = 'done', canonical_identity = $2 WHERE sequence = $1",
    [member, id("nummember")]
  );
  expect(await link()).toMatchObject({ linked: 1 });
  expect(await links()).toEqual([
    { root: "numroot", connected: "nummember", origin: "applicant_sheet" }
  ]);
});

it("closes a suppressed root's application without linking", async () => {
  await character("supproot");
  await character("suppmember");
  const root = await intent(id("supproot"), "suppressed");
  const member = await intent(id("suppmember"), "done");
  await application({ identity: id("supproot"), sequence: root }, [
    { identity: id("suppmember"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ suppressed: 1, linked: 0 });
  expect(await links()).toEqual([]);
});

it("skips a member suppressed now, though its intent was admitted", async () => {
  await character("liveroot");
  await character("livemember");
  const root = await intent(id("liveroot"), "done");
  const member = await intent(id("livemember"), "done");
  await application({ identity: id("liveroot"), sequence: root }, [
    { identity: id("livemember"), sequence: member }
  ]);
  // Use a reason value the SuppressionRepository's `suppress` type accepts
  // (check its signature in packages/database/src/repositories.ts).
  await createPostgresRepositories(pool).suppressions.suppress(
    { region: "eu", realm: "hyjal", name: "livemember" },
    "removal_request",
    null
  );
  expect(await link()).toMatchObject({ suppressed: 1, linked: 0 });
});

it("skips the same character, a different region, and an exclusion in either direction", async () => {
  await character("sameroot");
  await character("usmember", "us");
  await character("exclmember");
  await character("reverseroot");
  const root = await intent(id("sameroot"), "done");
  const same = await intent("warcraftlogs_id:9", "done", id("sameroot"));
  const us = await intent(id("usmember", "us"), "done");
  const excluded = await intent(id("exclmember"), "done");
  await application({ identity: id("sameroot"), sequence: root }, [
    { identity: "warcraftlogs_id:9", sequence: same },
    { identity: id("usmember", "us"), sequence: us },
    { identity: id("exclmember"), sequence: excluded }
  ]);
  // The member's dossier excluded the root: the reverse direction.
  await pool.query(
    "INSERT INTO dossier_character_exclusions (root_character_id, region, realm_slug, normalized_name) SELECT id, 'eu', 'hyjal', 'sameroot' FROM characters WHERE normalized_name = 'exclmember'"
  );
  expect(await link()).toMatchObject({
    same_character: 1,
    skipped_region: 1,
    skipped_excluded: 1,
    linked: 0
  });
});

it("skips a member excluded under another name sharing its Warcraft Logs id", async () => {
  await character("aliasroot");
  await character("newname");
  await pool.query(
    "INSERT INTO warcraft_logs_character_ids (region, realm_slug, normalized_name, character_id) VALUES ('eu', 'hyjal', 'oldname', 55), ('eu', 'hyjal', 'newname', 55)"
  );
  await pool.query(
    "INSERT INTO dossier_character_exclusions (root_character_id, region, realm_slug, normalized_name) SELECT id, 'eu', 'hyjal', 'oldname' FROM characters WHERE normalized_name = 'aliasroot'"
  );
  const root = await intent(id("aliasroot"), "done");
  const member = await intent(id("newname"), "done");
  await application({ identity: id("aliasroot"), sequence: root }, [
    { identity: id("newname"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ skipped_excluded: 1 });
});

it("skips a member already grouped elsewhere, and counts the pair as needing a link", async () => {
  const a = await character("grpa");
  const b = await character("grpb");
  const c = await character("grpc");
  const d = await character("grpd");
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'grpb'), ($2, 'eu', 'hyjal', 'grpd')",
    [a, c]
  );
  void b;
  void d;
  const root = await intent(id("grpa"), "done");
  const member = await intent(id("grpc"), "done");
  await application({ identity: id("grpa"), sequence: root }, [
    { identity: id("grpc"), sequence: member }
  ]);
  expect(await link()).toMatchObject({
    skipped_cross_group: 1,
    needed_link_pairs: 1,
    linked: 0
  });
});

it("decides cross-group only once the member exists, even if it is later grouped", async () => {
  const a = await character("lateroot");
  await character("latebuddy");
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'latebuddy')",
    [a]
  );
  const root = await intent(id("lateroot"), "done");
  const member = await intent(id("latemember"), "done");
  await application({ identity: id("lateroot"), sequence: root }, [
    { identity: id("latemember"), sequence: member }
  ]);
  expect(await link()).toMatchObject({ waiting: 1, linked: 0 });
  const m = await character("latemember");
  await character("latefriend");
  await pool.query(
    "INSERT INTO manual_dossier_connections (root_character_id, connected_region, connected_realm_slug, connected_normalized_name) VALUES ($1, 'eu', 'hyjal', 'latefriend')",
    [m]
  );
  expect(await link()).toMatchObject({ skipped_cross_group: 1, linked: 0 });
});

it("treats a repeated add as linked, and does not re-link a member already linked", async () => {
  await character("reproot");
  await character("repmember");
  const root = await intent(id("reproot"), "done");
  const member = await intent(id("repmember"), "done");
  const app = await application({ identity: id("reproot"), sequence: root }, [
    { identity: id("repmember"), sequence: member }
  ]);
  await createPostgresRepositories(pool).manualConnections.add(
    { region: "eu", realm: "hyjal", name: "reproot" },
    { region: "eu", realm: "hyjal", name: "repmember" },
    { origin: "applicant_sheet", applicationId: app }
  );
  expect(await link()).toMatchObject({ linked: 1 });
  expect(await links()).toHaveLength(1);
});

it("links again on resubmission after a removal, but never past an exclusion", async () => {
  await character("resroot");
  await character("resmember");
  const repositories = createPostgresRepositories(pool);
  const rootKey = { region: "eu" as const, realm: "hyjal", name: "resroot" };
  const memberKey = {
    region: "eu" as const,
    realm: "hyjal",
    name: "resmember"
  };
  const first = await intent(id("resroot"), "done");
  const firstMember = await intent(id("resmember"), "done");
  await application({ identity: id("resroot"), sequence: first }, [
    { identity: id("resmember"), sequence: firstMember }
  ]);
  await link();
  await repositories.manualConnections.remove(rootKey, memberKey);
  const second = await intent(id("resroot"), "done");
  const secondMember = await intent(id("resmember"), "done");
  await application({ identity: id("resroot"), sequence: second }, [
    { identity: id("resmember"), sequence: secondMember }
  ]);
  expect(await link()).toMatchObject({ linked: 1 });
  await repositories.manualConnections.setExcluded(rootKey, memberKey, true);
  await repositories.manualConnections.remove(rootKey, memberKey);
  // Removal deleted the row and its exclusion, so model the reviewer's
  // lasting choice as an Exclude that stays:
  await repositories.manualConnections.add(rootKey, memberKey);
  await repositories.manualConnections.setExcluded(rootKey, memberKey, true);
  const third = await intent(id("resroot"), "done");
  const thirdMember = await intent(id("resmember"), "done");
  await application({ identity: id("resroot"), sequence: third }, [
    { identity: id("resmember"), sequence: thirdMember }
  ]);
  expect(await link()).toMatchObject({ skipped_excluded: 1 });
});

it("expires waiting members seven days after settlement, and hard-closes after thirty", async () => {
  await character("exproot");
  const root = await intent(id("exproot"), "done");
  const member = await intent(id("expmember"), "pending");
  await application({ identity: id("exproot"), sequence: root }, [
    { identity: id("expmember"), sequence: member }
  ]);
  await link(); // settles
  await pool.query(
    "UPDATE applicant_source_applications SET settled_at = now() - interval '8 days'"
  );
  expect(await link()).toMatchObject({ expired: 1 });

  const unsettled = await intent(id("neverroot"), "pending");
  await application({ identity: id("neverroot"), sequence: unsettled }, [
    { identity: id("nevermember"), sequence: null }
  ]);
  await pool.query(
    "UPDATE applicant_source_applications SET created_at = now() - interval '31 days' WHERE settled_at IS NULL"
  );
  expect(await closeStaleApplicantApplications(pool)).toMatchObject({
    expired: 1
  });
  await pool.query(
    "UPDATE applicant_source_applications SET closed_at = now() - interval '31 days'"
  );
  expect(await closeStaleApplicantApplications(pool)).toMatchObject({
    deleted: 2
  });
});

it("visits the least recently checked applications first and skips locked ones", async () => {
  await character("orderroot");
  for (const name of ["o1", "o2", "o3"]) {
    const root = await intent(id("orderroot"), "done");
    const member = await intent(id(name), "pending");
    await application({ identity: id("orderroot"), sequence: root }, [
      { identity: id(name), sequence: member }
    ]);
  }
  const first = await linkApplicantApplications({
    pool,
    repositories: createPostgresRepositories(pool),
    batch: 2
  });
  expect(first.waiting).toBe(2);
  const unchecked = await pool.query(
    "SELECT count(*)::int AS n FROM applicant_source_applications WHERE last_checked_at IS NULL"
  );
  expect(unchecked.rows[0].n).toBe(1);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm test:integration -- tests/integration/applicant-links.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement `apps/worker/src/applicant-links.ts`**

```ts
import type { Pool, PoolClient } from "pg";
import { countingComponents, type Repositories } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import { decodeApplicantIdentity } from "./applicant-identity";

export type ApplicantLinkCounts = {
  linked: number;
  waiting: number;
  suppressed: number;
  same_character: number;
  skipped_region: number;
  skipped_excluded: number;
  skipped_cross_group: number;
  needed_link_pairs: number;
  expired: number;
};

type Outcome = Exclude<
  keyof ApplicantLinkCounts,
  "waiting" | "needed_link_pairs"
>;

const settleAfterDays = 7;

function emptyCounts(): ApplicantLinkCounts {
  return {
    linked: 0,
    waiting: 0,
    suppressed: 0,
    same_character: 0,
    skipped_region: 0,
    skipped_excluded: 0,
    skipped_cross_group: 0,
    needed_link_pairs: 0,
    expired: 0
  };
}

function keyOf(canonicalIdentity: string): CharacterKey | undefined {
  const decoded = decodeApplicantIdentity(canonicalIdentity);
  return decoded.kind === "character" ? decoded.key : undefined;
}

async function characterId(
  client: PoolClient,
  key: CharacterKey
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM characters WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3",
    [key.region, key.realm, key.name]
  );
  return result.rows[0]?.id;
}

/**
 * Whether `owner`'s dossier has excluded `other`, under `other`'s own key or
 * any key sharing its Warcraft Logs character id -- exclusions are written
 * under every such key when they are made, so a renamed character is caught.
 */
async function hasExcluded(
  client: PoolClient,
  ownerId: string,
  other: CharacterKey
): Promise<boolean> {
  const result = await client.query(
    `WITH other_keys AS (
       SELECT $2::text AS region, $3::text AS realm_slug, $4::text AS normalized_name
       UNION
       SELECT alias.region, alias.realm_slug, alias.normalized_name
         FROM warcraft_logs_character_ids self
         JOIN warcraft_logs_character_ids alias
           ON alias.character_id = self.character_id AND alias.region = self.region
        WHERE self.region = $2 AND self.realm_slug = $3 AND self.normalized_name = $4
     )
     SELECT 1 FROM other_keys k
      WHERE EXISTS (
              SELECT 1 FROM manual_dossier_connections manual
               WHERE manual.root_character_id = $1 AND manual.excluded_at IS NOT NULL
                 AND manual.connected_region = k.region
                 AND manual.connected_realm_slug = k.realm_slug
                 AND manual.connected_normalized_name = k.normalized_name)
         OR EXISTS (
              SELECT 1 FROM dossier_character_exclusions exclusion
               WHERE exclusion.root_character_id = $1
                 AND exclusion.region = k.region
                 AND exclusion.realm_slug = k.realm_slug
                 AND exclusion.normalized_name = k.normalized_name)
      LIMIT 1`,
    [ownerId, other.region, other.realm, other.name]
  );
  return result.rowCount === 1;
}

async function close(client: PoolClient, applicationId: string): Promise<void> {
  await client.query(
    "UPDATE applicant_source_applications SET closed_at = now() WHERE id = $1",
    [applicationId]
  );
  // Which characters were submitted together is not kept once decided.
  await client.query(
    "DELETE FROM applicant_source_application_members WHERE application_id = $1",
    [applicationId]
  );
}

async function decide(
  client: PoolClient,
  applicationId: string,
  ordinal: number,
  outcome: Outcome,
  counts: ApplicantLinkCounts
): Promise<void> {
  await client.query(
    "UPDATE applicant_source_application_members SET outcome = $3 WHERE application_id = $1 AND ordinal = $2",
    [applicationId, ordinal, outcome]
  );
  await client.query(
    `UPDATE applicant_source_applications SET ${outcome}_count = ${outcome}_count + 1 WHERE id = $1`,
    [applicationId]
  );
  counts[outcome]++;
}

/**
 * Links each settled application's members to its root, one decision per
 * member, never deciding on a character that does not exist yet. Makes no
 * provider calls.
 */
export async function linkApplicantApplications(input: {
  pool: Pool;
  repositories: Pick<Repositories, "manualConnections" | "suppressions">;
  now?: Date;
  batch?: number;
}): Promise<ApplicantLinkCounts> {
  const now = input.now ?? new Date();
  const counts = emptyCounts();
  await input.pool.query(
    `UPDATE applicant_source_applications application
        SET settled_at = now()
       FROM applicant_source_intents intent
      WHERE intent.sequence = application.root_intent_sequence
        AND intent.state IN ('done', 'suppressed')
        AND application.settled_at IS NULL
        AND application.closed_at IS NULL`
  );
  const client = await input.pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<{
      id: string;
      settled_at: Date;
      root_state: string;
      root_canonical: string | null;
    }>(
      `SELECT application.id, application.settled_at,
              intent.state AS root_state, intent.canonical_identity AS root_canonical
         FROM applicant_source_applications application
         JOIN applicant_source_intents intent ON intent.sequence = application.root_intent_sequence
        WHERE application.closed_at IS NULL AND application.settled_at IS NOT NULL
        ORDER BY application.last_checked_at NULLS FIRST, application.created_at
        LIMIT $1
        FOR UPDATE OF application SKIP LOCKED`,
      [input.batch ?? 50]
    );
    for (const application of picked.rows) {
      await client.query(
        "UPDATE applicant_source_applications SET last_checked_at = now() WHERE id = $1",
        [application.id]
      );
      const members = await client.query<{
        ordinal: number;
        identity: string;
        state: string | null;
        canonical: string | null;
      }>(
        `SELECT member.ordinal, member.identity, intent.state, intent.canonical_identity AS canonical
           FROM applicant_source_application_members member
           LEFT JOIN applicant_source_intents intent ON intent.sequence = member.member_intent_sequence
          WHERE member.application_id = $1 AND member.outcome IS NULL
          ORDER BY member.ordinal`,
        [application.id]
      );
      const expired =
        now.getTime() - application.settled_at.getTime() >=
        settleAfterDays * 86_400_000;
      const rootKey = application.root_canonical
        ? keyOf(application.root_canonical)
        : undefined;
      const rootSuppressed =
        application.root_state === "suppressed" ||
        (rootKey !== undefined &&
          (await input.repositories.suppressions.isActive(rootKey, now)));
      if (rootSuppressed) {
        for (const member of members.rows)
          await decide(
            client,
            application.id,
            member.ordinal,
            "suppressed",
            counts
          );
        await close(client, application.id);
        continue;
      }
      const rootId = rootKey ? await characterId(client, rootKey) : undefined;
      let open = 0;
      for (const member of members.rows) {
        const settled =
          member.state === "done" || member.state === "suppressed";
        const memberKey = member.canonical
          ? keyOf(member.canonical)
          : keyOf(member.identity);
        if (!rootId || !settled || !memberKey) {
          if (expired)
            await decide(
              client,
              application.id,
              member.ordinal,
              "expired",
              counts
            );
          else open++;
          continue;
        }
        if (
          member.state === "suppressed" ||
          (await input.repositories.suppressions.isActive(memberKey, now))
        ) {
          await decide(
            client,
            application.id,
            member.ordinal,
            "suppressed",
            counts
          );
          continue;
        }
        // An intent suppressed at intake was never admitted, so it has no
        // canonical identity; a character identity is its own.
        if (
          (member.canonical ?? member.identity) === application.root_canonical
        ) {
          await decide(
            client,
            application.id,
            member.ordinal,
            "same_character",
            counts
          );
          continue;
        }
        const memberId = await characterId(client, memberKey);
        if (!memberId) {
          if (expired)
            await decide(
              client,
              application.id,
              member.ordinal,
              "expired",
              counts
            );
          else open++;
          continue;
        }
        if (memberKey.region !== rootKey!.region) {
          await decide(
            client,
            application.id,
            member.ordinal,
            "skipped_region",
            counts
          );
          continue;
        }
        if (
          (await hasExcluded(client, rootId, memberKey)) ||
          (await hasExcluded(client, memberId, rootKey!))
        ) {
          await decide(
            client,
            application.id,
            member.ordinal,
            "skipped_excluded",
            counts
          );
          continue;
        }
        const components = await countingComponents(
          input.pool,
          rootId,
          memberId
        );
        if (!components.same) {
          counts.needed_link_pairs++;
          if (
            components.capped ||
            (components.rootShared && components.memberShared)
          ) {
            await decide(
              client,
              application.id,
              member.ordinal,
              "skipped_cross_group",
              counts
            );
            continue;
          }
        }
        await input.repositories.manualConnections.add(rootKey!, memberKey, {
          origin: "applicant_sheet",
          applicationId: application.id
        });
        await decide(client, application.id, member.ordinal, "linked", counts);
      }
      counts.waiting += open;
      if (open === 0) await close(client, application.id);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return counts;
}

/**
 * Hourly, whatever the linking flag says: closes applications that never
 * settled within 30 days, and deletes closed ones 30 days on.
 */
export async function closeStaleApplicantApplications(
  pool: Pool,
  now = new Date()
): Promise<{ expired: number; deleted: number }> {
  const stale = await pool.query<{ id: string; waiting: number }>(
    `UPDATE applicant_source_applications application
        SET closed_at = $1,
            expired_count = expired_count + (
              SELECT count(*) FROM applicant_source_application_members m
               WHERE m.application_id = application.id AND m.outcome IS NULL)
      WHERE closed_at IS NULL AND created_at <= $1 - interval '30 days'
      RETURNING id`,
    [now]
  );
  if (stale.rowCount)
    await pool.query(
      "DELETE FROM applicant_source_application_members WHERE application_id = ANY($1)",
      [stale.rows.map((row) => row.id)]
    );
  const deleted = await pool.query(
    "DELETE FROM applicant_source_applications WHERE closed_at <= $1 - interval '30 days'",
    [now]
  );
  return { expired: stale.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
}
```

**Transactions.** `manualConnections.add` and `countingComponents` use the pool, not this transaction's client. So the add commits on its own, before the member's outcome commits with the transaction. That's the spec's "add first, mark second": a crash in between repeats an add that `ON CONFLICT` makes harmless. The `FOR UPDATE … SKIP LOCKED` row lock keeps a second worker off the same application.

**Outcome column names.** The `${outcome}_count` interpolation is safe only because `outcome` is the closed `Outcome` union, never input. Keep it that way, or switch to a `CASE`.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm test:integration -- tests/integration/applicant-links.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/applicant-links.ts tests/integration/applicant-links.test.ts
git commit -m "feat(worker): link each settled application's members to its root, behind the safeguards"
```

---

### Task 10: Wire it into the tick and hourly maintenance

**Files:**

- Modify: `apps/worker/src/runtime.ts` (`createApplicantSheetTick`, after the drain; and `maintenanceCleanup` or `cacheCleanup`, about line 1094)
- Test: `apps/worker/src/runtime.test.ts`

**Interfaces:**

- Consumes: `linkApplicantApplications` and `closeStaleApplicantApplications` (Task 9), and `config.applicantWatcher.linkingEnabled` (Task 2).
- Produces:
  - Log event `applicant_links`, with `ApplicantLinkCounts` and `durationMs`.
  - Log event `applicant_links_failed`, with `errorName` and `durationMs`.
  - Log event `applicant_applications_cleanup`, with `{ expired, deleted }`.

- [ ] **Step 1: Write the failing tests**

At the top of `runtime.test.ts`, mock the module beside the watcher mock:

```ts
vi.mock("./applicant-links", () => ({
  linkApplicantApplications: vi.fn(async () => ({
    linked: 1,
    waiting: 0,
    suppressed: 0,
    same_character: 0,
    skipped_region: 0,
    skipped_excluded: 0,
    skipped_cross_group: 0,
    needed_link_pairs: 0,
    expired: 0
  })),
  closeStaleApplicantApplications: vi.fn(async () => ({
    expired: 0,
    deleted: 0
  }))
}));
```

and import `linkApplicantApplications` and `closeStaleApplicantApplications` from `./applicant-links`. Then:

```ts
it("links applications after the drain only when linking is enabled", async () => {
  vi.mocked(pollApplicantSheet).mockResolvedValue({
    baseline: false,
    rebaselined: false,
    created: 0,
    backlog: 0,
    invalid: 0,
    truncated: 0,
    newApplicants: [],
    applications: { recorded: 0, ambiguous: 0, overCap: 0 }
  } as never);
  vi.mocked(drainApplicantIntents).mockResolvedValue({
    admitted: 0,
    suppressed: 0,
    deferred: 0,
    pointsBlocked: false
  });
  vi.mocked(linkApplicantApplications).mockClear();
  const disabled = runtimeFakes();
  const off = await createWorkerRuntime(applicantConfig, {
    ...disabled.dependencies,
    createEvidenceGateway: applicantGateway
  });
  await disabled.applicantSheetTickHandler?.();
  expect(linkApplicantApplications).not.toHaveBeenCalled();
  await off.stop();

  const enabled = runtimeFakes();
  const logger = { info: vi.fn() };
  const on = await createWorkerRuntime(
    {
      ...applicantConfig,
      applicantWatcher: {
        ...applicantConfig.applicantWatcher,
        linkingEnabled: true
      }
    },
    { ...enabled.dependencies, createEvidenceGateway: applicantGateway },
    logger
  );
  await enabled.applicantSheetTickHandler?.();
  expect(linkApplicantApplications).toHaveBeenCalledTimes(1);
  expect(
    logger.info.mock.calls
      .map(([record]) => record)
      .find(
        (record) => (record as { event: string }).event === "applicant_links"
      )
  ).toMatchObject({ event: "applicant_links", linked: 1 });
  await on.stop();
});

it("logs a failed link step without failing the tick", async () => {
  vi.mocked(linkApplicantApplications).mockRejectedValueOnce(
    new TypeError("private-value")
  );
  const fakes = runtimeFakes();
  const logger = { info: vi.fn() };
  const runtime = await createWorkerRuntime(
    {
      ...applicantConfig,
      applicantWatcher: {
        ...applicantConfig.applicantWatcher,
        linkingEnabled: true
      }
    },
    { ...fakes.dependencies, createEvidenceGateway: applicantGateway },
    logger
  );
  await fakes.applicantSheetTickHandler?.();
  const events = logger.info.mock.calls.map(
    ([record]) => (record as { event: string }).event
  );
  expect(events).toContain("applicant_links_failed");
  expect(events).not.toContain("applicant_sheet_tick_failed");
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private-value");
  await runtime.stop();
});

it("closes stale applications in hourly maintenance even with linking off", async () => {
  vi.mocked(closeStaleApplicantApplications).mockClear();
  const fakes = runtimeFakes();
  const runtime = await createWorkerRuntime(applicantConfig, {
    ...fakes.dependencies,
    createEvidenceGateway: applicantGateway
  });
  await fakes.maintenanceHandler?.();
  expect(closeStaleApplicantApplications).toHaveBeenCalledTimes(1);
  await runtime.stop();
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts -t "link|stale"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `createApplicantSheetTick`, after the drain block and still inside the tick's `try`:

```ts
if (config.applicantWatcher.linkingEnabled) {
  const linkStartedAt = clock();
  try {
    const linked = await linkApplicantApplications({
      pool: pool as Pool,
      repositories
    });
    logger?.info({
      event: "applicant_links",
      ...linked,
      durationMs: elapsedMs(clock, linkStartedAt)
    });
  } catch (error) {
    // Linking is best effort: a failure never stops intake or the drain.
    logger?.info({
      event: "applicant_links_failed",
      durationMs: elapsedMs(clock, linkStartedAt),
      errorName: errorName(error)
    });
  }
}
```

In `maintenanceCleanup`, when `config.applicantWatcher.enabled` (the tables exist either way; skip it when the watcher is off, since there's nothing to close), after `cacheCleanup`:

```ts
if (context.config.applicantWatcher.enabled) {
  try {
    const cleaned = await closeStaleApplicantApplications(context.pool as Pool);
    context.logger?.info({
      event: "applicant_applications_cleanup",
      ...cleaned
    });
  } catch (error) {
    context.logger?.info({
      event: "applicant_applications_cleanup_failed",
      errorName: errorName(error)
    });
  }
}
```

Place it so a failure in it can't skip `characterGroupsRecompute`: inside the existing `try`, before the `finally`, wrapped in its own `try`/`catch`.

- [ ] **Step 4: Run the tests**

Run: `corepack pnpm vitest run apps/worker/src/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/runtime.ts apps/worker/src/runtime.test.ts
git commit -m "feat(worker): run application linking after each drain when enabled, and close stale applications hourly"
```

---

### Task 11: Docs, full verification and the pull request

**Files:**

- Modify: `docs/operations/applicant-sheet-watcher.md`
- Modify: `CONTEXT.md` (**Manual connection**, about line 65)
- Modify: `docs/operations/character-groups.md`
- Modify: `docs/superpowers/specs/2026-09-28-character-groups-design.md` (its rollback and phase 2 sections)

- [ ] **Step 1: Update the docs**

**`docs/operations/applicant-sheet-watcher.md`:**

- **Opening paragraph.** After "It starts discovery plus evidence for new supported character links and never writes to the Sheet.", add:

  > When a new response lists more than one character, the worker also records it as an application. With `APPLICANT_LINKING_ENABLED=true`, it links every other character to the first one as a manual connection labelled "From application", once each character exists and passes the checks: not suppressed, the same region, not excluded on either dossier (under any name sharing its Warcraft Logs id), and not already in a different multi-character group. A response with more than 5 character links is never linked. The `applicant_links` event counts each outcome. Read `skipped_cross_group` against `needed_link_pairs`.

- **Reading the Sheet.** It reads column A (the Forms timestamp) as a raw spreadsheet serial, in a second request together with the link column. If the two reads differ in anything except rows appended at the end (for example after a sort or a deletion), the poll fails without advancing, and retries on the next tick. The largest serial seen is kept as `submitted_serial_mark`. Only responses above it can become applications.

- **The "only … stored" paragraph.** Add the application tables (identity strings, a Forms serial, sequences, times and counts) and the serial mark. Member rows are deleted when an application closes, and closed applications are deleted after 30 days.

- **The new-baseline procedure** (lines 27 and 29). Clear `applicant_source_application_members` and `applicant_source_applications` before the intents, and reset `submitted_serial_mark` to NULL.

- **Arrival alerts.** Alerts are now one per new response: the first character's dossier URL, and how many others were listed.

**`CONTEXT.md`.** In **Manual connection**, after the first sentence, add:

> A manual connection can also come from an application: the applicant sheet watcher links the other characters in a response to its first one, and the dossier labels these "From application". That is still the applicant's statement, not an ownership claim.

**`docs/operations/character-groups.md`**, and the character-groups design's rollback section. Add:

> Before reverting phase 1, set `APPLICANT_LINKING_ENABLED=false`. The applicant linking step reads `character_connections` to decide whether a link would merge two groups.

In the design's phase 2 section, add:

> `group-subjects.ts` must carry the manual connection's `origin`, so group pages label application links "From application".

- [ ] **Step 2: Run the full gate**

```bash
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
```

Expected: all pass.

- [ ] **Step 3: Recheck the migration number, then commit, push and open the PR**

```bash
git fetch origin
git ls-tree --name-only origin/main packages/database/drizzle/ | tail -3
```

If `origin/main` already has a `0074_*`, renumber this migration to the next free number (the file, the journal entry's `idx`/`tag`/`when`, and `tests/integration/migrations.test.ts`). Merge `origin/main` and rerun Step 2.

```bash
git add docs CONTEXT.md
git commit -m "docs: application linking, its safeguards and its rollback order"
git push -u origin feat/applicant-application-links
```

Open the PR with `gh pr create`. Use the title `feat(worker): link each application's characters behind APPLICANT_LINKING_ENABLED`. In the body:

- Link Erilla/SlashWho#813.
- Name the settlement deviation: the linking step stamps `settled_at`, not the drain.
- Say that the flag defaults to `false`, and isn't to be switched on during the character-groups phase 1 exit run.

Don't enable auto-merge; the Manager reviews it.
