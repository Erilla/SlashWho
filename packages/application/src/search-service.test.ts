import type {
  DiscoverCharacterJob,
  DiscoveryQueue,
  DiscoveryRun,
  Repositories,
  StoredSnapshot
} from "@slashwho/database";
import { describe, expect, it, vi } from "vitest";

import { applicationConfigSchema } from "./config";
import { createMeasurementScope } from "./measurement";
import { createSearchService, recoverPendingSearches } from "./search-service";

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
        guild: null,
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
    raiderIoFailure?: Readonly<{
      kind: "not_found" | "transient";
      status?: number;
    }>;
  } = {}
) {
  let activeRun: DiscoveryRun | null = null;
  let nextRun = 10;
  let enqueueFails = options.enqueueFailsOnce ?? false;
  const enqueued: string[] = [];
  const events = new Map<string, Date[]>();
  const cancelled: string[] = [];
  const rootCharacter = {
    key,
    displayName: "Ryii",
    className: "Mage",
    level: 80,
    guild: null,
    ownerId: "fixture-owner",
    profileGuess: null,
    declaredMain: null
  } as const;
  const getCharacter = vi.fn(async () => {
    if (options.raiderIoFailure) {
      throw Object.assign(
        new Error(`raiderio_${options.raiderIoFailure.kind}`),
        options.raiderIoFailure
      );
    }
    return rootCharacter;
  });
  let negativeCached = options.negative ?? false;

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
    accountTokens: {
      async admitRequest() {
        throw new Error("not_used");
      },
      async findAccountById() {
        throw new Error("not_used");
      },
      async findAccountByEmail() {
        throw new Error("not_used");
      },
      async findToken() {
        throw new Error("not_used");
      },
      async confirmVerification() {
        throw new Error("not_used");
      },
      async completeReset() {
        throw new Error("not_used");
      },
      async issueEmailChange() {
        throw new Error("not_used");
      },
      async confirmEmailChange() {
        throw new Error("not_used");
      }
    },
    accountMail: {
      async issue() {
        throw new Error("not_used");
      },
      async claimDue() {
        throw new Error("not_used");
      },
      async markSent() {
        throw new Error("not_used");
      }
    },
    accountAuth: {
      async findCredential() {
        throw new Error("not_used");
      },
      async admitLoginAttempt() {
        throw new Error("not_used");
      },
      async appendEvent() {
        throw new Error("not_used");
      },
      async issueSession() {
        throw new Error("not_used");
      },
      async useSession() {
        throw new Error("not_used");
      },
      async revokeSession() {
        throw new Error("not_used");
      },
      async changePassword() {
        throw new Error("not_used");
      },
      async provisionAdmin() {
        throw new Error("not_used");
      },
      async setRole() {
        throw new Error("not_used");
      },
      async setActive() {
        throw new Error("not_used");
      },
      async requirePasswordChange() {
        throw new Error("not_used");
      },
      async listAccounts() {
        throw new Error("not_used");
      },
      async registerPending() {
        throw new Error("not_used");
      },
      async admitRegistration() {
        throw new Error("not_used");
      }
    },
    operatorAuth: {
      async findCredential() {
        return null;
      },
      async provision() {
        throw new Error("not_used");
      },
      async rotateCredential() {
        return null;
      },
      async disable() {
        return null;
      },
      async list() {
        return [];
      },
      async admitLoginAttempt() {
        return { kind: "admitted" as const };
      },
      async appendEvent() {},
      async issueSession() {
        throw new Error("not_used");
      },
      async useSession() {
        return null;
      },
      async revokeSession() {},
      async cleanupExpired() {
        return { sessions: 0, loginAttempts: 0 };
      }
    },
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
        return {
          id: "00000000-0000-4000-8000-000000000099",
          rootKey: key,
          rootCharacterId: null,
          queueJobId: null,
          status: "queued",
          callerClass: "anonymous",
          attempt: 0,
          nextRetryAt: null,
          errorCode: null,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          snapshotId: null
        };
      },
      async claim() {
        return null;
      },
      async markRunning() {},
      async markRetrying() {},
      async complete() {},
      async completeWithLiveSweepSnapshot() {},
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
      async createAndFinishFingerprintSweep() {
        throw new Error("not used");
      },
      async amendAndFinishFingerprintSweep() {
        throw new Error("not used");
      },
      async getCurrent() {
        return options.current ?? null;
      },
      async listReverseDeclaredCharacters() {
        return [];
      },
      async find() {
        return options.current ?? null;
      },
      async listHistory() {
        return { items: [], nextCursor: null };
      }
    },
    manualConnections: {
      async add() {
        return "added" as const;
      },
      async list() {
        return [];
      },
      async setExcluded() {
        return "updated" as const;
      },
      async remove() {
        return "removed" as const;
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
      async put() {
        negativeCached = true;
      },
      async putAndFailRun() {},
      async find() {
        return negativeCached
          ? { key, expiresAt: new Date("2026-08-04T12:15:00.000Z") }
          : null;
      },
      async cleanupExpired() {
        return 0;
      }
    },
    evidence: {
      async reserve() {
        throw new Error("not used");
      },
      async reserveTierSearch() {
        throw new Error("not used");
      },
      async latestTierSearches() {
        return [];
      },
      async find() {
        return null;
      },
      async claim() {
        return null;
      },
      async markEnqueued() {
        throw new Error("not used");
      },
      async stageCollection() {
        throw new Error("not used");
      },
      async stagedCollection() {
        return null;
      },
      async clearSettledCollectionStages() {
        return 0;
      },
      async publish() {
        throw new Error("not used");
      },
      async fail() {
        throw new Error("not used");
      },
      async getCompleted() {
        return null;
      },
      async recordHistoricRankLookup() {},
      async listResumable() {
        return [];
      },
      async listStatus() {
        return [];
      },
      async hydratedFightUrls() {
        return [];
      },
      async collectedTierZones() {
        return [];
      },
      async storedEvidenceTiers() {
        return { kills: [], wipes: [] };
      },
      async terminalTiers() {
        return [];
      },
      async markTerminalTiers() {},
      async clearTerminalTiers() {
        return 0;
      },
      async recordWarcraftLogsCharacterId() {},
      async warcraftLogsCharacterId() {
        return null;
      },
      async emptyAttendanceSearches() {
        return [];
      },
      async recordEmptyAttendanceSearches() {},
      async recordLimitation() {},
      async listActive() {
        return [];
      },
      async releaseAbandoned() {
        return 0;
      },
      async recordRunCost() {},
      async clearExpiredRunCosts() {
        return 0;
      },
      async clearStaleCredentials() {
        return 0;
      },
      async listForMonitor() {
        return [];
      }
    },
    fingerprintSweeps: {
      async isDueForVisit() {
        return true;
      },
      async requestAdmission() {
        return { kind: "not_due" };
      },
      async recordContinuationFailure() {
        return 0;
      },
      async recordRequest() {},
      async finish() {},
      async release() {},
      async getResumeState() {
        return null;
      },
      async listWaiting() {
        return [];
      },
      async listAdmittedUndispatched() {
        return [];
      },
      async markDispatched() {},
      async admitWaiting() {
        return { kind: "settled" };
      },
      async cleanupExpired() {
        return 0;
      }
    }
  } satisfies Repositories;

  const enqueuedPayloads: DiscoverCharacterJob[] = [];
  const queue: Pick<DiscoveryQueue, "enqueue"> = {
    async enqueue(payload) {
      if (enqueueFails) {
        enqueueFails = false;
        throw new Error("queue_unavailable");
      }
      enqueued.push(payload.runId);
      enqueuedPayloads.push(payload);
      return payload.runId;
    }
  };
  const service = createSearchService({
    repositories,
    queue,
    config,
    now: () => now,
    raiderio: { getCharacter }
  });
  const command = {
    characterUrl,
    headers: new Headers({ "x-real-ip": "203.0.113.8" })
  };
  return {
    service,
    command,
    enqueued,
    enqueuedPayloads,
    cancelled,
    events,
    repositories,
    getCharacter
  };
}

describe("search freshness policy", () => {
  it("queues a cadence-due connected-character sweep without reading the root upstream", async () => {
    const fixture = policyFixture({ current: snapshot(now) });

    await fixture.service.scheduleConnectedCharacterSweep?.(key);

    expect(fixture.enqueuedPayloads).toEqual([
      expect.objectContaining({ key, runId: expect.any(String) })
    ]);
    expect(fixture.getCharacter).not.toHaveBeenCalled();
  });

  it("authorizes public reads through the independent read bucket", async () => {
    // Break caught: direct character/history reads could bypass auth and read limits.
    const fixture = policyFixture({ readLimit: 1 });

    await expect(
      fixture.service.authorizePublicRead(fixture.command.headers)
    ).resolves.toEqual({ allowed: true });
    await expect(
      fixture.service.authorizePublicRead(fixture.command.headers)
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    await expect(
      fixture.service.authorizePublicRead(new Headers())
    ).resolves.toEqual({
      allowed: false,
      code: "trusted_client_ip_unavailable"
    });
  });

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
    expect(fixture.getCharacter).toHaveBeenCalledTimes(1);
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
    expect(fixture.getCharacter).toHaveBeenCalledTimes(1);
    expect(fixture.enqueuedPayloads[0]).toMatchObject({
      rootCharacter: {
        key,
        displayName: "Ryii",
        className: "Mage",
        level: 80
      }
    });
  });

  it("returns and caches a missing root before reserving discovery work", async () => {
    // Break caught: a confirmed absence could reserve and enqueue a run, which
    // then posted start notifications and exposed a polling URL before failing.
    const fixture = policyFixture({
      raiderIoFailure: { kind: "not_found", status: 404 }
    });
    const reserve = vi.spyOn(
      fixture.repositories.searchReservations,
      "reserve"
    );

    await expect(fixture.service.create(fixture.command)).resolves.toEqual({
      kind: "not_found",
      code: "character_not_found"
    });
    await expect(fixture.service.create(fixture.command)).resolves.toEqual({
      kind: "not_found",
      code: "character_not_found"
    });

    expect(fixture.getCharacter).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(fixture.enqueued).toHaveLength(0);
  });

  it.each([
    ["timeout", undefined],
    ["rate limit", 429],
    ["server failure", 503]
  ])(
    "keeps a genuine Raider.IO %s retryable without reserving work",
    async (_description, status) => {
      // Break caught: a temporary provider failure could be cached as absence,
      // or admitted to the queue only to burn all delivery attempts there.
      const fixture = policyFixture({
        raiderIoFailure: { kind: "transient", ...(status ? { status } : {}) }
      });
      const reserve = vi.spyOn(
        fixture.repositories.searchReservations,
        "reserve"
      );

      await expect(fixture.service.create(fixture.command)).resolves.toEqual({
        kind: "failed",
        code: "upstream_unavailable"
      });
      await expect(fixture.service.create(fixture.command)).resolves.toEqual({
        kind: "failed",
        code: "upstream_unavailable"
      });

      expect(fixture.getCharacter).toHaveBeenCalledTimes(2);
      expect(reserve).not.toHaveBeenCalled();
      expect(fixture.enqueued).toHaveLength(0);
      expect([...fixture.events.keys()]).toEqual([
        expect.stringMatching(/^read:[a-f0-9]{64}$/)
      ]);
    }
  );

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

describe("job telemetry", () => {
  it("carries a correlation id and a fresh enqueuedAt onto the discovery job", async () => {
    // The service injects its clock (options.now) rather than reading the
    // system clock directly, so this asserts against that injected time.
    const fixture = policyFixture();

    await fixture.service.create({
      ...fixture.command,
      correlationId: "corr-1"
    });

    expect(fixture.enqueuedPayloads[0]).toMatchObject({
      correlationId: "corr-1",
      enqueuedAt: now.toISOString()
    });
  });

  it("enqueues without a correlation id when none is supplied", async () => {
    const fixture = policyFixture();

    await fixture.service.create(fixture.command);

    expect(fixture.enqueuedPayloads[0]?.correlationId).toBeUndefined();
    expect(typeof fixture.enqueuedPayloads[0]?.enqueuedAt).toBe("string");
  });

  it("attributes create's database and admission reads to the supplied scope", async () => {
    // Break caught: dossier_start is measured as "submission to first
    // response," so create's database and provider work must land in their
    // buckets rather than vanishing when a scope is passed through.
    const fixture = policyFixture();
    const scope = createMeasurementScope();

    await fixture.service.create(fixture.command, scope);

    expect(scope.totals().dbCalls).toBeGreaterThan(0);
    expect(scope.totals().raiderIoCalls).toBe(1);
  });

  it("stamps a fresh enqueuedAt when recovering a pending search", async () => {
    // Break caught: carrying over the original enqueuedAt would measure the
    // wait since the first deployment's enqueue, not the recovered one.
    const runId = "00000000-0000-4000-8000-000000000099";
    const pendingRepositories = {
      searchReservations: {
        async listPending() {
          return [{ runId, key }];
        },
        async markEnqueued() {}
      }
    } as unknown as Repositories;
    const recovered: DiscoverCharacterJob[] = [];
    const queue: Pick<DiscoveryQueue, "enqueue"> = {
      async enqueue(payload) {
        recovered.push(payload);
        return payload.runId;
      }
    };

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-15T11:30:00.000Z"));
      await recoverPendingSearches(pendingRepositories, queue);
    } finally {
      vi.useRealTimers();
    }

    expect(recovered[0]).toMatchObject({
      runId,
      key,
      enqueuedAt: "2026-09-15T11:30:00.000Z"
    });
  });
});
