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
  pollApplicantSheet
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
