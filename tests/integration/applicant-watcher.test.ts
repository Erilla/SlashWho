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
        minimumPoints: 3500
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
  expect(result).toEqual({ admitted: 0, suppressed: 0, deferred: 0 });
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
  const result = await pollApplicantSheet({
    pool,
    readRows: async () => [
      {
        row: 2,
        battletag: "Old#123",
        discordId: "111",
        characterName: "Aria",
        linkCell: a
      },
      {
        row: 3,
        battletag: "Ivy#456",
        discordId: "222",
        characterName: "Ivy",
        linkCell: characterUrl
      }
    ],
    backlogLimit: 1000
  });
  expect(result.newApplicants).toEqual([
    {
      battletag: "Ivy#456",
      discordId: "222",
      characterName: "Ivy",
      characterUrl,
      dossierPath: "/dossiers/eu/example/ivy"
    }
  ]);
  const stored = await pool.query<{ text: string }>(
    "SELECT row_to_json(t)::text AS text FROM applicant_source_intents t WHERE identity LIKE '%ivy%'"
  );
  expect(stored.rows[0]?.text).not.toContain("Ivy#456");
  expect(stored.rows[0]?.text).not.toContain("222");
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
        linkCell: characterUrl
      },
      {
        row: 3,
        battletag: "Second#222",
        discordId: "222",
        characterName: "Second",
        linkCell: characterUrl
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
        linkCell: characterUrl
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
      linkCell: characterUrl
    },
    {
      row: 3,
      battletag: "Second#222",
      discordId: "222",
      characterName: "Piper Two",
      linkCell: characterUrl
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
