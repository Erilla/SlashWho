import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createPostgresRepositories,
  runMigrations,
  type DiscoveryQueue
} from "../../packages/database/src";
import {
  admitCanonicalIntent,
  claimNext,
  drainApplicantIntents,
  pollApplicantSheet,
  wasSuppressedAt
} from "../../apps/worker/src/applicant-watcher";
import type { WorkerConfig } from "../../apps/worker/src/config";
import { startPostgres } from "./postgres";

let pool: Pool;
let stop: () => Promise<void>;
beforeAll(async () => {
  ({ pool, stop } = await startPostgres());
  await runMigrations(pool);
});
afterAll(async () => {
  await stop();
});

const a = "https://raider.io/characters/eu/example/aria";
const b = "https://www.warcraftlogs.com/character/eu/example/bela";
const c = "https://raider.io/characters/eu/example/cara";
const id = "https://www.warcraftlogs.com/character/id/42";
async function poll(cells: unknown[]) {
  return pollApplicantSheet({
    pool,
    readColumn: async () => cells,
    backlogLimit: 20
  });
}
async function intents(): Promise<string[]> {
  const result = await pool.query<{ identity: string }>(
    "SELECT identity FROM applicant_source_intents ORDER BY sequence"
  );
  return result.rows.map((row) => row.identity);
}

it("baselines, ignores reorder, observes edits and repeated submissions across restarts", async () => {
  expect(await poll([a, b])).toMatchObject({ baseline: true, created: 0 });
  expect(await poll([b, a])).toMatchObject({ created: 0 });
  expect(await poll([b, b])).toMatchObject({ created: 1 });
  expect(await poll([b])).toMatchObject({ created: 0 });
  expect(await poll([b, b])).toMatchObject({ created: 1 });
  expect(await poll([`${a} ${a}`, b, b])).toMatchObject({ created: 1 });
  expect(await intents()).toEqual([
    'character:["eu","example","bela"]',
    'character:["eu","example","bela"]',
    'character:["eu","example","aria"]'
  ]);
});

it("does not advance state after a failed poll", async () => {
  await expect(
    pollApplicantSheet({
      pool,
      readColumn: async () => {
        throw new Error("read_failed");
      },
      backlogLimit: 20
    })
  ).rejects.toThrow("read_failed");
  expect(await intents()).toHaveLength(3);
});

it("settles suppression at observation and defers unresolved IDs", async () => {
  const first = await pollApplicantSheet({
    pool,
    readColumn: async () => [a, b, b, c, id],
    backlogLimit: 20,
    isSuppressed: async (identity) =>
      identity.includes("cara") ? true : "defer"
  });
  expect(first.created).toBe(1);
  const states = await pool.query<{ state: string }>(
    "SELECT state FROM applicant_source_intents WHERE identity LIKE '%cara%' ORDER BY sequence"
  );
  expect(states.rows.map((row) => row.state)).toEqual(["suppressed"]);
  const next = await pollApplicantSheet({
    pool,
    readColumn: async () => [a, b, b, c, id],
    backlogLimit: 20,
    isSuppressed: async () => false
  });
  expect(next.created).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT state FROM applicant_source_intents WHERE identity LIKE '%cara%' ORDER BY sequence"
      )
    ).rows
  ).toEqual([{ state: "suppressed" }]);
});

it("keeps the first observation time for a deferred numeric link", async () => {
  const firstSeen = new Date("2026-01-01T00:00:00.000Z");
  const later = new Date("2026-01-02T00:00:00.000Z");
  const deferred = await pollApplicantSheet({
    pool,
    readColumn: async () => [
      a,
      b,
      b,
      c,
      id,
      "https://www.warcraftlogs.com/character/id/43"
    ],
    backlogLimit: 20,
    now: () => firstSeen,
    isSuppressed: async () => "defer"
  });
  expect(deferred.created).toBe(0);
  const observed: Date[] = [];
  const settled = await pollApplicantSheet({
    pool,
    readColumn: async () => [
      a,
      b,
      b,
      c,
      id,
      "https://www.warcraftlogs.com/character/id/43"
    ],
    backlogLimit: 20,
    now: () => later,
    isSuppressed: async (_identity, at) => {
      observed.push(at);
      return true;
    }
  });
  expect(settled.created).toBe(1);
  expect(observed).toEqual([firstSeen]);
  const saved = await pool.query<{ observed_at: Date; state: string }>(
    "SELECT observed_at, state FROM applicant_source_intents WHERE identity = 'warcraftlogs_id:43'"
  );
  expect(saved.rows).toEqual([{ observed_at: firstSeen, state: "suppressed" }]);
});

it("recalls suppression at observation after expiry cleanup", async () => {
  const repositories = createPostgresRepositories(pool);
  const key = { region: "eu" as const, realm: "example", name: "historic" };
  const observedAt = new Date(Date.now() + 1000);
  const expiresAt = new Date(observedAt.getTime() + 1000);
  await repositories.suppressions.suppress(key, "test", expiresAt);
  expect(await wasSuppressedAt(pool, key, observedAt)).toBe(true);
  await repositories.suppressions.cleanupExpired(
    new Date(expiresAt.getTime() + 1000)
  );
  expect(await wasSuppressedAt(pool, key, observedAt)).toBe(true);
  expect(
    await wasSuppressedAt(pool, key, new Date(expiresAt.getTime() + 1000))
  ).toBe(false);
});

it("settles a deferred ID using suppression from its first poll", async () => {
  const repositories = createPostgresRepositories(pool);
  const key = { region: "eu" as const, realm: "example", name: "deferred" };
  const firstSeen = new Date(Date.now() + 1000);
  const expiry = new Date(firstSeen.getTime() + 1000);
  await repositories.suppressions.suppress(key, "test", expiry);
  const cells = [
    a,
    b,
    b,
    c,
    id,
    "https://www.warcraftlogs.com/character/id/44"
  ];
  await pollApplicantSheet({
    pool,
    readColumn: async () => cells,
    backlogLimit: 20,
    now: () => firstSeen,
    isSuppressed: async () => "defer"
  });
  await repositories.suppressions.cleanupExpired(
    new Date(expiry.getTime() + 1000)
  );
  const result = await pollApplicantSheet({
    pool,
    readColumn: async () => cells,
    backlogLimit: 20,
    now: () => new Date(expiry.getTime() + 1000),
    isSuppressed: async (identity, observedAt) =>
      identity === "warcraftlogs_id:44"
        ? wasSuppressedAt(pool, key, observedAt)
        : false
  });
  expect(result.created).toBe(1);
  const rows = await pool.query<{ observed_at: Date; state: string }>(
    "SELECT observed_at, state FROM applicant_source_intents WHERE identity = 'warcraftlogs_id:44'"
  );
  expect(rows.rows).toEqual([{ observed_at: firstSeen, state: "suppressed" }]);
});

it("uses each submission time when a deferred numeric count rises again", async () => {
  const firstSeen = new Date("2026-01-01T00:00:00.000Z");
  const secondSeen = new Date("2026-01-02T00:00:00.000Z");
  const numeric = "https://www.warcraftlogs.com/character/id/45";
  await pollApplicantSheet({
    pool,
    readColumn: async () => [a, b, b, numeric],
    backlogLimit: 100,
    now: () => firstSeen,
    isSuppressed: async () => "defer"
  });
  const result = await pollApplicantSheet({
    pool,
    readColumn: async () => [a, b, b, numeric, numeric],
    backlogLimit: 100,
    now: () => secondSeen,
    isSuppressed: async (_identity, observedAt) =>
      observedAt.getTime() === firstSeen.getTime()
  });
  expect(result.created).toBe(2);
  const rows = await pool.query<{ observed_at: Date; state: string }>(
    "SELECT observed_at, state FROM applicant_source_intents WHERE identity = 'warcraftlogs_id:45' ORDER BY sequence"
  );
  expect(rows.rows).toEqual([
    { observed_at: firstSeen, state: "suppressed" },
    { observed_at: secondSeen, state: "pending" }
  ]);
});

it("closes an older indefinite suppression when a new policy replaces it", async () => {
  const repositories = createPostgresRepositories(pool);
  const key = { region: "eu" as const, realm: "example", name: "renewed" };
  await repositories.suppressions.suppress(key, "test", null);
  const replacedAt = new Date();
  const expiresAt = new Date(replacedAt.getTime() + 1000);
  await repositories.suppressions.suppress(key, "test", expiresAt);
  expect(
    await wasSuppressedAt(pool, key, new Date(expiresAt.getTime() + 1000))
  ).toBe(false);
});

it("reclaims the same outbox intent after a crashed lease", async () => {
  const first = await claimNext(pool);
  expect(first).not.toBeNull();
  await pool.query(
    "UPDATE applicant_source_intents SET claimed_until = now() - interval '1 second' WHERE sequence = $1",
    [first!.sequence]
  );
  const recovered = await claimNext(pool);
  expect(recovered?.sequence).toBe(first?.sequence);
});

it("records suppression even when the pending backlog is full", async () => {
  const d = "https://raider.io/characters/eu/example/dara";
  const result = await pollApplicantSheet({
    pool,
    readColumn: async () => [a, b, b, c, id, d],
    backlogLimit: 1,
    isSuppressed: async (identity) => identity.includes("dara")
  });
  expect(result.created).toBe(1);
  expect(
    (
      await pool.query(
        "SELECT state FROM applicant_source_intents WHERE identity LIKE '%dara%' ORDER BY sequence"
      )
    ).rows
  ).toEqual([{ state: "suppressed" }]);
});

it("deduplicates resolved and direct links before charging the daily cap", async () => {
  const at = new Date();
  async function insert(identity: string) {
    const row = await pool.query<{ sequence: string }>(
      "INSERT INTO applicant_source_intents (source, identity, observed_at, state) VALUES ('applicant_sheet', $1, $2, 'claimed') RETURNING sequence",
      [identity, at]
    );
    return {
      sequence: row.rows[0]!.sequence,
      identity,
      observed_at: at,
      attempts: 0
    };
  }
  const canonical = 'character:["eu","example","aria"]';
  const first = await insert(canonical);
  expect(await admitCanonicalIntent(pool, first, canonical, 1)).toBe(
    "admitted"
  );
  await pool.query(
    "UPDATE applicant_source_intents SET state = 'done' WHERE sequence = $1",
    [first.sequence]
  );
  const numeric = await insert("warcraftlogs_id:42");
  expect(await admitCanonicalIntent(pool, numeric, canonical, 1)).toBe(
    "duplicate"
  );
  const another = await insert('character:["eu","example","dara"]');
  expect(await admitCanonicalIntent(pool, another, another.identity, 1)).toBe(
    "daily_limit"
  );
  // Retrying the original intent never charges a second slot.
  await pool.query(
    "UPDATE applicant_source_intents SET state = 'claimed' WHERE sequence = $1",
    [first.sequence]
  );
  expect(await admitCanonicalIntent(pool, first, canonical, 1)).toBe(
    "admitted"
  );
  const charged = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM applicant_source_intents WHERE charged_at IS NOT NULL"
  );
  expect(Number(charged.rows[0]?.count)).toBe(1);
});

it("does not admit against points already reserved by queued evidence", async () => {
  await pool.query("CREATE SCHEMA IF NOT EXISTS pgboss");
  await pool.query(
    "CREATE TABLE IF NOT EXISTS pgboss.job (name text, state text)"
  );
  const repositories = createPostgresRepositories(pool);
  await repositories.evidence.reserve({
    origin: "dossier_read",
    key: { region: "eu", realm: "example", name: "budget" },
    freshnessCutoff: new Date(),
    at: new Date()
  });
  await pool.query(
    "INSERT INTO applicant_source_intents (source, identity, observed_at) VALUES ('applicant_sheet', $1, now())",
    ['character:["eu","example","extra"]']
  );
  const result = await drainApplicantIntents({
    pool,
    config: {
      applicantWatcher: {
        enabled: true,
        perTick: 2,
        perDay: 5,
        backlog: 100,
        queueDepth: 10,
        minimumPoints: 3500,
        linkingEnabled: false
      }
    } as WorkerConfig,
    repositories,
    queue: {} as DiscoveryQueue,
    raiderio: {
      getCharacter: async () => {
        throw new Error("should_not_collect");
      }
    },
    warcraftlogs: {
      resolveCharacterById: async () => {
        throw new Error("should_not_resolve");
      },
      getRateLimit: async () => ({
        kind: "rate_limit",
        limitPerHour: 5000,
        pointsSpentThisHour: 0,
        pointsResetInSeconds: 3600
      })
    }
  });
  expect(result).toEqual({
    admitted: 0,
    suppressed: 0,
    deferred: 0,
    pointsBlocked: true
  });
});

it("admits every distinct supported link in a bounded multi-link cell", async () => {
  const links = Array.from(
    { length: 17 },
    (_, index) =>
      `https://raider.io/characters/eu/example/added${String.fromCharCode(97 + index)}`
  );
  const result = await pollApplicantSheet({
    pool,
    readColumn: async () => [a, b, b, links.join(" ")],
    backlogLimit: 100,
    isSuppressed: async () => false
  });
  expect(result).toMatchObject({ created: 17, truncated: 0 });
  const saved = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM applicant_source_intents WHERE identity LIKE 'character:%added%'"
  );
  expect(Number(saved.rows[0]?.count)).toBe(17);
});

it("returns the new response's own details without persisting them", async () => {
  const characterUrl = "https://raider.io/characters/eu/example/ivy";
  // Distinctive enough that it cannot turn up by chance in the stored row's
  // sequence numbers or timestamps, which a short numeric ID like "222" did.
  const discordId = "discord-fixture-7f3a9c";
  const result = await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "Old#123",
        discordId: "111",
        characterName: "Aria",
        linkCell: a,
        submittedSerial: undefined
      },
      {
        row: 3,
        battletag: "Ivy#456",
        discordId,
        characterName: "Ivy",
        linkCell: characterUrl,
        submittedSerial: undefined
      }
    ],
    backlogLimit: 1000
  });
  expect(result.newApplicants).toEqual([
    {
      battletag: "Ivy#456",
      discordId,
      characterName: "Ivy",
      characterUrl,
      dossierPath: "/dossiers/eu/example/ivy"
    }
  ]);
  const stored = await pool.query<{ text: string }>(
    "SELECT row_to_json(t)::text AS text FROM applicant_source_intents t WHERE identity LIKE '%ivy%'"
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0]?.text).not.toContain("Ivy#456");
  expect(stored.rows[0]?.text).not.toContain(discordId);
});

it("attributes a repeated character submission to the later response", async () => {
  const characterUrl = "https://raider.io/characters/eu/example/ivy";
  const result = await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "First#111",
        discordId: "111",
        characterName: "First",
        linkCell: characterUrl,
        submittedSerial: undefined
      },
      {
        row: 3,
        battletag: "Second#222",
        discordId: "222",
        characterName: "Second",
        linkCell: characterUrl,
        submittedSerial: undefined
      }
    ],
    backlogLimit: 1000
  });
  expect(result.newApplicants).toEqual([
    {
      battletag: "Second#222",
      discordId: "222",
      characterName: "Second",
      characterUrl,
      dossierPath: "/dossiers/eu/example/ivy"
    }
  ]);
});

it("adds a dossier path when a numeric Warcraft Logs link resolves", async () => {
  const characterUrl = "https://www.warcraftlogs.com/character/id/777";
  const result = await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "Numeric#777",
        discordId: "777",
        characterName: "Nora",
        linkCell: characterUrl,
        submittedSerial: undefined
      }
    ],
    resolveDossierPath: (identity) =>
      identity === "warcraftlogs_id:777"
        ? "/dossiers/eu/example/nora"
        : undefined,
    isSuppressed: async () => false,
    backlogLimit: 1000
  });
  expect(result.newApplicants[0]).toMatchObject({
    characterUrl,
    dossierPath: "/dossiers/eu/example/nora"
  });
});

it("keeps each duplicate response's details when an earlier occurrence is deferred", async () => {
  const characterUrl = "https://raider.io/characters/eu/example/piper";
  const rows = [
    {
      row: 2,
      battletag: "First#111",
      discordId: "111",
      characterName: "Piper One",
      linkCell: characterUrl,
      submittedSerial: undefined
    },
    {
      row: 3,
      battletag: "Second#222",
      discordId: "222",
      characterName: "Piper Two",
      linkCell: characterUrl,
      submittedSerial: undefined
    }
  ];
  let calls = 0;
  const first = await pollApplicantSheet({
    pool,
    readRows: async () => rows,
    isSuppressed: async () => (++calls === 1 ? "defer" : false),
    backlogLimit: 1000
  });
  expect(first.newApplicants.map((applicant) => applicant.battletag)).toEqual([
    "Second#222"
  ]);
  const second = await pollApplicantSheet({
    pool,
    readRows: async () => rows,
    isSuppressed: async () => false,
    backlogLimit: 1000
  });
  expect(second.newApplicants.map((applicant) => applicant.battletag)).toEqual([
    "First#111"
  ]);
});

it("re-baselines instead of announcing links a new parser version reads for the first time", async () => {
  const known = "https://raider.io/characters/eu/example/quinn";
  const unreadable = "https://raider.io/characters/eu/example/rhea";
  const later = "https://raider.io/characters/eu/example/sage";
  const pollAt = (cells: unknown[], parserVersion: number) =>
    pollApplicantSheet({
      pool,
      readColumn: async () => cells,
      backlogLimit: 1000,
      parserVersion
    });
  await pollAt([known], 1_000);
  // The new version reads a response that was already on the Sheet.
  expect(await pollAt([known, unreadable, known], 1_001)).toMatchObject({
    rebaselined: true,
    created: 0
  });
  expect(await pollAt([known, unreadable, known], 1_001)).toMatchObject({
    rebaselined: false,
    created: 0
  });
  expect(await pollAt([known, unreadable, known, later], 1_001)).toMatchObject({
    rebaselined: false,
    created: 1
  });
  await poll([known, unreadable, known, later]);
});

it("keeps a deferred submission when the parser version changes", async () => {
  const deferred = "https://raider.io/characters/eu/example/tove";
  const readColumn = async () => [deferred, deferred];
  await pollApplicantSheet({
    pool,
    readColumn: async () => [deferred],
    backlogLimit: 1000,
    parserVersion: 2_000
  });
  const first = await pollApplicantSheet({
    pool,
    readColumn,
    isSuppressed: async () => "defer",
    backlogLimit: 1000,
    parserVersion: 2_000
  });
  expect(first.created).toBe(0);
  const second = await pollApplicantSheet({
    pool,
    readColumn,
    isSuppressed: async () => false,
    backlogLimit: 1000,
    parserVersion: 2_001
  });
  expect(second).toMatchObject({ rebaselined: true, created: 1 });
  await poll([deferred, deferred]);
});

it("keeps a deferred duplicate's own details across a parser version change", async () => {
  const characterUrl = "https://raider.io/characters/eu/example/uma";
  const rows = [
    {
      row: 2,
      battletag: "First#333",
      discordId: "333",
      characterName: "Uma One",
      linkCell: characterUrl,
      submittedSerial: undefined
    },
    {
      row: 3,
      battletag: "Second#444",
      discordId: "444",
      characterName: "Uma Two",
      linkCell: characterUrl,
      submittedSerial: undefined
    }
  ];
  await pollApplicantSheet({
    pool,
    readRows: async () => [],
    backlogLimit: 1000,
    parserVersion: 3_000
  });
  let calls = 0;
  const first = await pollApplicantSheet({
    pool,
    readRows: async () => rows,
    isSuppressed: async () => (++calls === 1 ? "defer" : false),
    backlogLimit: 1000,
    parserVersion: 3_000
  });
  expect(first.newApplicants.map((applicant) => applicant.battletag)).toEqual([
    "Second#444"
  ]);
  const second = await pollApplicantSheet({
    pool,
    readRows: async () => rows,
    isSuppressed: async () => false,
    backlogLimit: 1000,
    parserVersion: 3_001
  });
  expect(second).toMatchObject({ rebaselined: true, created: 1 });
  expect(second.newApplicants.map((applicant) => applicant.battletag)).toEqual([
    "First#333"
  ]);
  await poll(rows.map((row) => row.linkCell));
});

it("records a count a new parser version no longer reads without announcing it", async () => {
  const dropped = "https://raider.io/characters/eu/example/vera";
  const pollAt = (cells: unknown[], parserVersion: number) =>
    pollApplicantSheet({
      pool,
      readColumn: async () => cells,
      backlogLimit: 1000,
      parserVersion
    });
  await pollAt([dropped, dropped], 4_000);
  expect(await pollAt([dropped], 4_001)).toMatchObject({
    rebaselined: true,
    created: 0,
    newApplicants: []
  });
  // The count is now 1, so a second response is a genuine new submission.
  expect(await pollAt([dropped, dropped], 4_001)).toMatchObject({
    rebaselined: false,
    created: 1
  });
  await poll([dropped, dropped]);
});

it("stamps last_polled_at with the time the poll was given", async () => {
  // Break caught: a late stamp made a one-minute cadence poll every two minutes.
  const startedAt = new Date("2026-10-13T12:00:00.000Z");
  await pollApplicantSheet({
    pool,
    readColumn: async () => [a],
    backlogLimit: 20,
    now: () => startedAt
  });
  const state = await pool.query<{ last_polled_at: Date }>(
    "SELECT last_polled_at FROM applicant_source_state WHERE source = 'applicant_sheet'"
  );
  expect(state.rows[0]?.last_polled_at).toEqual(startedAt);
});

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
  // The member was inserted a poll before its root, and is still tied to it.
  const member = await pool.query<{ member_intent_sequence: string }>(
    "SELECT member_intent_sequence FROM applicant_source_application_members"
  );
  const intent = await pool.query<{ sequence: string }>(
    "SELECT sequence FROM applicant_source_intents WHERE identity = $1",
    [tcId]
  );
  expect(intent.rows).toHaveLength(1);
  expect(member.rows[0]?.member_intent_sequence).toBe(intent.rows[0]?.sequence);
});

it("ties a deferred root's member to its first intent, not a later resubmission's", async () => {
  // Break caught: max(sequence) tied R's member to the intent M's later
  // response (S30, Q's application) created, not the one from R's response.
  await resetApplicantSource();
  const tq = "https://raider.io/characters/eu/hyjal/tropiqua";
  const tqId = 'character:["eu","hyjal","tropiqua"]';
  const sheetRow = (row: number, serial: number, linkCell: string) => ({
    row,
    battletag: "t",
    discordId: "1",
    characterName: "N",
    linkCell,
    submittedSerial: serial
  });
  const first = [sheetRow(2, 5, tx), sheetRow(3, 20, `${tp} ${tc}`)];
  const later = [...first, sheetRow(4, 30, `${tq} ${tc}`)];
  const pollAt = (
    rows: ReturnType<typeof sheetRow>[],
    at: string,
    deferred: string[]
  ) =>
    pollApplicantSheet({
      pool,
      readRows: async () => rows,
      backlogLimit: 100,
      now: () => new Date(at),
      isSuppressed: async (identity) =>
        deferred.includes(identity) ? "defer" : false
    });
  await pollAt([sheetRow(2, 5, tx)], "2026-10-13T10:00:00.000Z", []);
  // t1: R (tropipe) and M (tropicos) both deferred.
  await pollAt(first, "2026-10-13T10:01:00.000Z", [tpId, tcId]);
  // M's deferred occurrence is admitted, observed at t1; R still waits.
  await pollAt(first, "2026-10-13T10:02:00.000Z", [tpId]);
  // t3: S30 [Q, M] arrives; Q's application takes M's new intent.
  await pollAt(later, "2026-10-13T10:03:00.000Z", [tpId]);
  // R is finally admitted, with its first sighting at t1.
  await pollAt(later, "2026-10-13T10:04:00.000Z", []);
  const memberIntents = await pool.query<{ sequence: string }>(
    "SELECT sequence FROM applicant_source_intents WHERE identity = $1 ORDER BY sequence",
    [tcId]
  );
  expect(memberIntents.rows).toHaveLength(2);
  const members = await pool.query<{
    root_identity: string;
    member_intent_sequence: string;
  }>(
    `SELECT a.root_identity, m.member_intent_sequence
       FROM applicant_source_application_members m
       JOIN applicant_source_applications a ON a.id = m.application_id
      ORDER BY a.root_identity`
  );
  // tropipe sorts before tropiqua.
  expect(members.rows).toEqual([
    {
      root_identity: tpId,
      member_intent_sequence: memberIntents.rows[0]?.sequence
    },
    {
      root_identity: tqId,
      member_intent_sequence: memberIntents.rows[1]?.sequence
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
