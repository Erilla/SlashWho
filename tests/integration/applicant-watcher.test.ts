import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "../../packages/database/src";
import {
  claimNext,
  pollApplicantSheet
} from "../../apps/worker/src/applicant-watcher";
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
  const first = await claimNext(pool, 100);
  expect(first).not.toBeNull();
  await pool.query(
    "UPDATE applicant_source_intents SET claimed_until = now() - interval '1 second' WHERE sequence = $1",
    [first!.sequence]
  );
  const recovered = await claimNext(pool, 100);
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
