import type { CharacterKey } from "@slashwho/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDiscoveryQueue,
  createPostgresRepositories,
  runMigrations
} from "../../packages/database/src";
import { enqueueFingerprintAdmissionEvidence } from "../../apps/worker/src/fingerprint-admission-evidence";
import { startPostgres } from "./postgres";

const root: CharacterKey = { region: "eu", realm: "silvermoon", name: "root" };
const key = (name: string): CharacterKey => ({
  region: "eu",
  realm: "silvermoon",
  name
});

describe("fingerprint admission evidence freshness", () => {
  let pool: Pool;
  let stopPostgres: () => Promise<void>;
  let queue: ReturnType<typeof createDiscoveryQueue>;
  let repositories: ReturnType<typeof createPostgresRepositories>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    pool = postgres.pool;
    stopPostgres = postgres.stop;
    await runMigrations(pool);
    repositories = createPostgresRepositories(pool);
    queue = createDiscoveryQueue({
      connectionString: pool.options.connectionString!
    });
    await queue.start();
  });

  afterAll(async () => {
    await queue.stop({ graceful: false, timeoutMs: 1_000 });
    await stopPostgres();
  });

  async function publish(
    character: CharacterKey,
    state: "complete" | "partial",
    lightRefresh = false
  ) {
    const completedAt = new Date(Date.now() - 60_000);
    const reservation = await repositories.evidence.reserve({
      key: character,
      origin: "dossier_read",
      freshnessCutoff: new Date(0),
      at: completedAt,
      ...(lightRefresh ? { lightRefresh: true } : {})
    });
    if (reservation.kind !== "reserved")
      throw new Error("seed_run_not_reserved");
    await repositories.evidence.publish(reservation.run.id, {
      state,
      limitationCode: state === "partial" ? "request_cap" : null,
      parseLimitationCode: null,
      kills: [],
      wipes: [],
      tierBests: [],
      completedAt
    });
    return reservation.run.id;
  }

  async function counts(character: CharacterKey) {
    const { rows } = await pool.query<{ run_count: number; job_count: number }>(
      `SELECT
         (SELECT count(*)::int FROM character_evidence_runs
           WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3) AS run_count,
         (SELECT count(*)::int FROM pgboss.job
           WHERE name = 'collect-character-evidence'
             AND data->>'runId' IN (
               SELECT id::text FROM character_evidence_runs
                WHERE region = $1 AND realm_slug = $2 AND normalized_name = $3
             )) AS job_count`,
      [character.region, character.realm, character.name]
    );
    return rows[0]!;
  }

  async function run(character: CharacterKey, at = new Date()) {
    await enqueueFingerprintAdmissionEvidence({
      key: character,
      root,
      at,
      freshnessMs: 24 * 60 * 60_000,
      evidence: repositories.evidence,
      queue
    });
  }

  it("reuses fresh complete full evidence without a run or job", async () => {
    const character = key("fingerprint-complete");
    const runId = await publish(character, "complete");
    await run(character, new Date());

    expect(await counts(character)).toEqual({ run_count: 1, job_count: 0 });
    expect((await repositories.evidence.find(runId))?.status).toBe("complete");
  });

  it.each([
    {
      name: "fingerprint-light",
      state: "complete" as const,
      lightRefresh: true
    },
    {
      name: "fingerprint-partial",
      state: "partial" as const,
      lightRefresh: false
    }
  ])("collects full evidence after a fresh $name publication", async (seed) => {
    const character = key(seed.name);
    await publish(character, seed.state, seed.lightRefresh);
    await run(character, new Date());

    expect(await counts(character)).toEqual({ run_count: 2, job_count: 1 });
    const { rows } = await pool.query<{ mode: string; priority: number }>(
      `SELECT evidence.mode,
              job.priority
         FROM character_evidence_runs evidence
         JOIN pgboss.job job ON job.data->>'runId' = evidence.id::text
        WHERE evidence.region = $1 AND evidence.realm_slug = $2
          AND evidence.normalized_name = $3`,
      [character.region, character.realm, character.name]
    );
    expect(rows).toEqual([{ mode: "full", priority: 20 }]);
  });

  it("joins and promotes active work without creating a duplicate", async () => {
    const character = key("fingerprint-active");
    const reservation = await repositories.evidence.reserve({
      key: character,
      origin: "dossier_read",
      freshnessCutoff: new Date(0),
      at: new Date()
    });
    if (reservation.kind !== "reserved")
      throw new Error("active_run_not_reserved");
    const jobId = await queue.enqueueCharacterEvidence(reservation.run.id, {
      priority: 0,
      mode: "full"
    });
    await repositories.evidence.markEnqueued(reservation.run.id, jobId);

    await run(character, new Date());

    expect(await counts(character)).toEqual({ run_count: 1, job_count: 1 });
    const { rows } = await pool.query<{ priority: number }>(
      "SELECT priority FROM pgboss.job WHERE id = $1",
      [jobId]
    );
    expect(rows).toEqual([{ priority: 20 }]);
  });
});
