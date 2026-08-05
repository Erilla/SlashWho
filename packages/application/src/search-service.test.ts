import type {
  DiscoveryQueue,
  DiscoveryRun,
  Repositories,
  StoredSnapshot
} from "@slashwho/database";
import { describe, expect, it } from "vitest";

import { applicationConfigSchema } from "./config";
import { createSearchService } from "./search-service";

const key = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const characterUrl = "https://raider.io/characters/eu/silvermoon/ryii";
const now = new Date("2026-08-04T12:00:00.000Z");
const config = applicationConfigSchema.parse({
  BOT_API_KEY: "bot-secret-that-is-at-least-32-characters",
  RATE_LIMIT_HASH_SECRET: "rate-secret-that-is-at-least-32-characters"
});

function snapshot(refreshedAt: Date): StoredSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    rootKey: key,
    state: "complete",
    limitationCode: null,
    refreshedAt,
    characterCount: 1,
    characters: [
      {
        characterId: "00000000-0000-4000-8000-000000000003",
        key,
        displayName: "Ryii",
        className: "Mage",
        level: 80,
        raiderIoUrl: characterUrl,
        source: "input",
        displayOrder: 0
      }
    ]
  };
}

function policyFixture(
  options: {
    current?: StoredSnapshot | null;
    negative?: boolean;
    suppressed?: boolean;
    searchLimit?: number;
    readLimit?: number;
    enqueueFailsOnce?: boolean;
  } = {}
) {
  let activeRun: DiscoveryRun | null = null;
  let nextRun = 10;
  let enqueueFails = options.enqueueFailsOnce ?? false;
  const enqueued: string[] = [];
  const events = new Map<string, Date[]>();
  const cancelled: string[] = [];

  const reserveRate = (
    bucket: string,
    limit: number,
    expiresAt: Date,
    at: Date
  ) => {
    const active = (events.get(bucket) ?? []).filter((date) => date > at);
    if (active.length >= limit) {
      return { allowed: false, retryAt: active[0] ?? null };
    }
    events.set(bucket, [...active, expiresAt]);
    return { allowed: true, retryAt: null };
  };

  const repositories = {
    searchReservations: {
      async reserve(input) {
        if (activeRun) return { kind: "active" as const, run: activeRun };
        const limited = reserveRate(
          input.callerBucketHash,
          options.searchLimit ?? input.limit,
          input.expiresAt,
          input.at
        );
        if (!limited.allowed) {
          return {
            kind: "rate_limited" as const,
            retryAt: limited.retryAt ?? input.expiresAt
          };
        }
        const id = `00000000-0000-4000-8000-${String(nextRun++).padStart(12, "0")}`;
        activeRun = {
          id,
          rootKey: input.key,
          rootCharacterId: null,
          queueJobId: null,
          status: "queued",
          callerClass: input.callerClass,
          attempt: 0,
          nextRetryAt: null,
          errorCode: null,
          createdAt: input.at,
          startedAt: null,
          completedAt: null,
          snapshotId: null
        };
        return { kind: "reserved" as const, run: activeRun };
      },
      async cancel(runId) {
        cancelled.push(runId);
        for (const [bucket, dates] of events) {
          if (bucket.startsWith("search:")) events.set(bucket, dates.slice(1));
        }
        if (activeRun?.id === runId) activeRun = null;
      },
      async listPending() {
        return [];
      },
      async markEnqueued(runId, queueJobId) {
        if (activeRun?.id === runId) activeRun.queueJobId = queueJobId;
      }
    },
    runs: {
      async createOrReuse() {
        throw new Error("not used");
      },
      async claim() {
        return null;
      },
      async markRunning() {},
      async markRetrying() {},
      async complete() {},
      async fail() {},
      async find(id) {
        return activeRun?.id === id ? activeRun : null;
      },
      async findActive() {
        return activeRun;
      }
    },
    snapshots: {
      async create() {
        throw new Error("not used");
      },
      async getCurrent() {
        return options.current ?? null;
      },
      async find() {
        return options.current ?? null;
      },
      async listHistory() {
        return { items: [], nextCursor: null };
      }
    },
    suppressions: {
      async suppress() {},
      async isActive() {
        return options.suppressed ?? false;
      },
      async cleanupExpired() {
        return 0;
      }
    },
    rateLimits: {
      async reserve(bucket, limit, expiresAt, at = now) {
        return reserveRate(bucket, options.readLimit ?? limit, expiresAt, at);
      },
      async record() {},
      async countActive() {
        return 0;
      },
      async cleanupExpired() {
        return 0;
      }
    },
    negativeCache: {
      async put() {},
      async putAndFailRun() {},
      async find() {
        return options.negative
          ? { key, expiresAt: new Date("2026-08-04T12:15:00.000Z") }
          : null;
      },
      async cleanupExpired() {
        return 0;
      }
    }
  } satisfies Repositories;

  const queue: Pick<DiscoveryQueue, "enqueue"> = {
    async enqueue(payload) {
      if (enqueueFails) {
        enqueueFails = false;
        throw new Error("queue_unavailable");
      }
      enqueued.push(payload.runId);
      return payload.runId;
    }
  };
  const service = createSearchService({
    repositories,
    queue,
    config,
    now: () => now
  });
  const command = {
    characterUrl,
    headers: new Headers({ "x-real-ip": "203.0.113.8" })
  };
  return { service, command, enqueued, cancelled, events };
}

describe("search freshness policy", () => {
  it("returns contract-mappable auth failures without touching persistence", async () => {
    // Break caught: invalid Bearer could downgrade or missing Railway identity could proceed.
    const fixture = policyFixture();

    await expect(
      fixture.service.create({
        ...fixture.command,
        headers: new Headers({ authorization: `Bearer ${"x".repeat(40)}` })
      })
    ).resolves.toEqual({ kind: "unauthorized", code: "unauthorized" });
    await expect(
      fixture.service.create({ ...fixture.command, headers: new Headers() })
    ).resolves.toEqual({
      kind: "client_ip_unavailable",
      code: "trusted_client_ip_unavailable"
    });
    expect(fixture.enqueued).toHaveLength(0);
    expect(fixture.events.size).toBe(0);
  });

  it("serves a fresh snapshot without enqueuing or charging search allowance", async () => {
    // Break caught: a cache hit could create work or consume the search-job budget.
    const fixture = policyFixture({
      current: snapshot(new Date("2026-08-03T12:00:01.000Z"))
    });

    await expect(
      fixture.service.create(fixture.command)
    ).resolves.toMatchObject({
      kind: "character",
      character: { character: { name: "Ryii" } }
    });
    expect(fixture.enqueued).toHaveLength(0);
    expect([...fixture.events.keys()]).toEqual([
      expect.stringMatching(/^read:[a-f0-9]{64}$/)
    ]);
  });

  it("serves stale data immediately and reuses one refresh", async () => {
    // Break caught: simultaneous stale hits could create duplicate runs or jobs.
    const fixture = policyFixture({
      current: snapshot(new Date("2026-08-03T11:59:59.000Z"))
    });

    const [first, second] = await Promise.all([
      fixture.service.create(fixture.command),
      fixture.service.create(fixture.command)
    ]);

    expect(first).toMatchObject({
      kind: "job",
      staleCharacter: expect.any(Object)
    });
    expect(second).toMatchObject({
      kind: "job",
      jobId: first.kind === "job" ? first.jobId : ""
    });
    expect(fixture.enqueued).toHaveLength(1);
  });

  it("creates one job when no snapshot exists", async () => {
    // Break caught: a cache miss could return an empty resource instead of durable work.
    const fixture = policyFixture();

    await expect(
      fixture.service.create(fixture.command)
    ).resolves.toMatchObject({
      kind: "job",
      status: "queued",
      staleCharacter: null
    });
    expect(fixture.enqueued).toHaveLength(1);
  });

  it("returns a recent negative result without creating work", async () => {
    // Break caught: repeated known-missing names could hammer the upstream service.
    const fixture = policyFixture({ negative: true });

    await expect(fixture.service.create(fixture.command)).resolves.toEqual({
      kind: "not_found",
      code: "character_not_found"
    });
    expect(fixture.enqueued).toHaveLength(0);
  });

  it("never rediscoveries an actively suppressed root", async () => {
    // Break caught: a removal request could be undone by search creation.
    const fixture = policyFixture({ suppressed: true });

    await expect(fixture.service.create(fixture.command)).resolves.toEqual({
      kind: "not_found",
      code: "suppressed_character"
    });
    expect(fixture.enqueued).toHaveLength(0);
  });

  it("cancels the run and its charge when enqueue fails so retry can work", async () => {
    // Break caught: a transient queue failure could strand an active run and charge no work.
    const fixture = policyFixture({ enqueueFailsOnce: true });

    await expect(fixture.service.create(fixture.command)).resolves.toEqual({
      kind: "failed",
      code: "search_failed"
    });
    expect(fixture.cancelled).toHaveLength(1);
    await expect(
      fixture.service.create(fixture.command)
    ).resolves.toMatchObject({
      kind: "job"
    });
    expect(fixture.enqueued).toHaveLength(1);
  });

  it("returns Retry-After only when new search work exceeds allowance", async () => {
    // Break caught: active reuse or cache hits could be incorrectly rejected as expensive work.
    const fixture = policyFixture({ searchLimit: 0 });

    await expect(fixture.service.create(fixture.command)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 3600
    });
    expect(fixture.enqueued).toHaveLength(0);
  });
});
