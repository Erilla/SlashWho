import type { DiscoveryQueue } from "@slashwho/database";
import type { CharacterKey } from "@slashwho/domain";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applicationConfigSchema,
  createSearchService,
  recoverPendingSearches
} from "../../packages/application/src";
import {
  createPostgresRepositories,
  runMigrations,
  type Repositories
} from "../../packages/database/src";
import { startPostgres } from "./postgres";

const anonymousIp = "203.0.113.81";
const botApiKey = "bot-secret-that-is-at-least-32-characters";
const config = applicationConfigSchema.parse({
  BOT_API_KEY: botApiKey,
  RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters",
  ANONYMOUS_SEARCHES_PER_HOUR: 2,
  BOT_SEARCHES_PER_HOUR: 3,
  PUBLIC_READS_PER_MINUTE: 20
});
const now = new Date("2026-08-04T12:00:00.000Z");

function command(name: string, authorization?: string) {
  const headers = new Headers({ "x-real-ip": anonymousIp });
  if (authorization) headers.set("authorization", authorization);
  return {
    characterUrl: `https://raider.io/characters/eu/silvermoon/${name}`,
    headers
  };
}

async function seedSnapshot(
  repositories: Repositories,
  key: CharacterKey,
  refreshedAt: Date
) {
  const run = await repositories.runs.createOrReuse(key, "anonymous");
  return repositories.snapshots.create({
    runId: run.id,
    rootKey: key,
    state: "complete",
    limitationCode: null,
    refreshedAt,
    characters: [
      {
        key,
        displayName: key.name[0]!.toUpperCase() + key.name.slice(1),
        className: "Mage",
        level: 80,
        raiderIoUrl: `https://raider.io/characters/${key.region}/${key.realm}/${key.name}`,
        source: "input"
      }
    ]
  });
}

describe("PostgreSQL search policy", () => {
  let pool: Pool;
  let stop: () => Promise<void>;
  let repositories: Repositories;
  let enqueued: string[];
  let queue: Pick<DiscoveryQueue, "enqueue">;

  beforeAll(async () => {
    ({ pool, stop } = await startPostgres());
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE TABLE
      snapshot_characters,
      snapshots,
      rate_limit_events,
      discovery_runs,
      characters,
      suppressed_characters,
      negative_character_cache
      CASCADE`);
    repositories = createPostgresRepositories(pool);
    enqueued = [];
    queue = {
      async enqueue(payload) {
        enqueued.push(payload.runId);
        return payload.runId;
      }
    };
  });

  afterAll(async () => {
    await stop();
  });

  it("atomically reserves one charged run under concurrent duplicate searches", async () => {
    // Break caught: separate count, event, and run writes could overcharge or duplicate work.
    const service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.create(command("ryii")))
    );

    expect(
      new Set(results.map((result) => result.kind === "job" && result.jobId))
    ).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    const counts = await pool.query<{ runs: string; events: string }>(`
      SELECT
        (SELECT count(*)::text FROM discovery_runs) AS runs,
        (SELECT count(*)::text FROM rate_limit_events) AS events
    `);
    expect(counts.rows[0]).toEqual({ runs: "1", events: "1" });
  });

  it("serves fresh cache through the read bucket and stale cache through one refresh", async () => {
    // Break caught: persisted freshness could be ignored or cached reads could consume search capacity.
    const freshKey = {
      region: "eu",
      realm: "silvermoon",
      name: "fresh"
    } as const;
    const staleKey = {
      region: "eu",
      realm: "silvermoon",
      name: "stale"
    } as const;
    await seedSnapshot(
      repositories,
      freshKey,
      new Date("2026-08-03T12:00:01.000Z")
    );
    await seedSnapshot(
      repositories,
      staleKey,
      new Date("2026-08-03T11:59:59.000Z")
    );
    const service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });

    await expect(service.create(command("fresh"))).resolves.toMatchObject({
      kind: "character"
    });
    const stale = await Promise.all([
      service.create(command("stale")),
      service.create(command("stale"))
    ]);

    expect(stale).toEqual([
      expect.objectContaining({
        kind: "job",
        staleCharacter: expect.any(Object)
      }),
      expect.objectContaining({
        kind: "job",
        staleCharacter: expect.any(Object)
      })
    ]);
    expect(
      new Set(stale.map((result) => result.kind === "job" && result.jobId))
    ).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    const buckets = await pool.query<{ caller_bucket_hash: string }>(
      "SELECT caller_bucket_hash FROM rate_limit_events ORDER BY caller_bucket_hash"
    );
    expect(
      buckets.rows.map(
        ({ caller_bucket_hash }) => caller_bucket_hash.split(":")[0]
      )
    ).toEqual(["read", "search"]);
  });

  it("atomically enforces the higher public-read limit without charging searches", async () => {
    // Break caught: concurrent cache hits could over-admit or consume the hourly search budget.
    const cachedKey = {
      region: "eu",
      realm: "silvermoon",
      name: "cached"
    } as const;
    await seedSnapshot(repositories, cachedKey, now);
    const readLimitedConfig = { ...config, PUBLIC_READS_PER_MINUTE: 2 };
    const service = createSearchService({
      repositories,
      queue,
      config: readLimitedConfig,
      now: () => now
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.create(command("cached")))
    );

    expect(results.filter(({ kind }) => kind === "character")).toHaveLength(2);
    expect(results.filter(({ kind }) => kind === "rate_limited")).toHaveLength(
      3
    );
    expect(enqueued).toHaveLength(0);
    const buckets = await pool.query<{ caller_bucket_hash: string }>(
      "SELECT caller_bucket_hash FROM rate_limit_events"
    );
    expect(buckets.rows).toHaveLength(2);
    expect(
      buckets.rows.every(({ caller_bucket_hash }) =>
        caller_bucket_hash.startsWith("read:")
      )
    ).toBe(true);
  });

  it("serves recent negative cache without reserving a run", async () => {
    // Break caught: persisted negative cache could be bypassed after a process restart.
    await repositories.negativeCache.put(
      { region: "eu", realm: "silvermoon", name: "missing" },
      new Date("2026-08-04T12:15:00.000Z")
    );
    const service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });

    await expect(service.create(command("missing"))).resolves.toEqual({
      kind: "not_found",
      code: "character_not_found"
    });
    expect(enqueued).toHaveLength(0);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM discovery_runs"
    );
    expect(count.rows[0]?.count).toBe("0");
  });

  it("serializes each caller bucket and keeps bot allowance independent", async () => {
    // Break caught: concurrent distinct names could exceed a bucket or bot traffic could share it.
    const service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });

    const anonymous = await Promise.all([
      service.create(command("first")),
      service.create(command("second")),
      service.create(command("third"))
    ]);
    expect(anonymous.filter(({ kind }) => kind === "job")).toHaveLength(2);
    expect(
      anonymous.filter(({ kind }) => kind === "rate_limited")
    ).toHaveLength(1);
    await expect(
      service.create(command("botname", `Bearer ${botApiKey}`))
    ).resolves.toMatchObject({ kind: "job" });
  });

  it("persists neither raw client IP nor raw bot key", async () => {
    // Break caught: abuse-control storage could become a credential or IP-identifying dataset.
    const service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });
    await service.create(command("anonymous"));
    await service.create(command("bot", `Bearer ${botApiKey}`));

    const stored = await pool.query<{ caller_bucket_hash: string }>(
      "SELECT caller_bucket_hash FROM rate_limit_events ORDER BY id"
    );
    expect(stored.rows).toHaveLength(2);
    expect(
      stored.rows.every(({ caller_bucket_hash }) =>
        /^search:[a-f0-9]{64}$/.test(caller_bucket_hash)
      )
    ).toBe(true);
    expect(JSON.stringify(stored.rows)).not.toContain(anonymousIp);
    expect(JSON.stringify(stored.rows)).not.toContain(botApiKey);
  });

  it("atomically removes the charge and fails the queued run after enqueue failure", async () => {
    // Break caught: queue unavailability could exhaust allowance without doing work.
    let fail = true;
    queue.enqueue = async (payload) => {
      if (fail) {
        fail = false;
        throw new Error("queue_unavailable");
      }
      enqueued.push(payload.runId);
      return payload.runId;
    };
    const service = createSearchService({
      repositories,
      queue,
      config,
      now: () => now
    });

    await expect(service.create(command("ryii"))).resolves.toEqual({
      kind: "failed",
      code: "search_failed"
    });
    const afterFailure = await pool.query<{ status: string; events: string }>(`
      SELECT status,
        (SELECT count(*)::text FROM rate_limit_events) AS events
      FROM discovery_runs
    `);
    expect(afterFailure.rows[0]).toEqual({ status: "failed", events: "0" });
    await expect(service.create(command("ryii"))).resolves.toMatchObject({
      kind: "job"
    });
  });

  it("recovers a committed reservation after a process exits before enqueue", async () => {
    // Break caught: a crash between reservation commit and enqueue could strand a charged run forever.
    const reservation = await repositories.searchReservations.reserve({
      key: { region: "eu", realm: "silvermoon", name: "crashed" },
      callerClass: "anonymous",
      callerBucketHash: `search:${"a".repeat(64)}`,
      limit: 2,
      expiresAt: new Date("2026-08-04T13:00:00.000Z"),
      at: now
    });
    expect(reservation.kind).toBe("reserved");

    await recoverPendingSearches(repositories, queue);

    expect(enqueued).toEqual([
      reservation.kind === "reserved" ? reservation.run.id : ""
    ]);
    if (reservation.kind === "reserved") {
      await expect(
        repositories.runs.find(reservation.run.id)
      ).resolves.toMatchObject({
        queueJobId: reservation.run.id,
        status: "queued"
      });
    }
  });
});
