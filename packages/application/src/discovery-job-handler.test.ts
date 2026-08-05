import type {
  DiscoveryRun,
  Repositories,
  StoredSnapshot
} from "@slashwho/database";
import type {
  CharacterKey,
  RaiderIoCharacter,
  RaiderIoGateway
} from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { createDiscoveryJobHandler } from "./discovery-job-handler";

const rootKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "root"
};
const secondKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "second"
};
const thirdKey: CharacterKey = {
  region: "us",
  realm: "area-52",
  name: "third"
};

function character(key: CharacterKey): RaiderIoCharacter {
  return {
    key,
    displayName: key.name,
    className: "Mage",
    level: 80,
    ownerId: key === rootKey ? "visible-owner" : null,
    profileGuess: null,
    declaredMain: null
  };
}

class MutableGateway implements RaiderIoGateway {
  failure: Error | null = null;

  async getCharacter(): Promise<RaiderIoCharacter> {
    if (this.failure) throw this.failure;
    return character(rootKey);
  }

  async getClaimedCharacters(): Promise<readonly RaiderIoCharacter[]> {
    if (this.failure) throw this.failure;
    return [character(secondKey), character(thirdKey)];
  }

  async resolveProfileGuess(): Promise<null> {
    if (this.failure) throw this.failure;
    return null;
  }
}

function keyId(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

function createMemoryRepositories(): Repositories {
  const runs = new Map<string, DiscoveryRun>();
  const snapshots = new Map<string, StoredSnapshot>();
  const negativeCache = new Map<string, Date>();
  let runSequence = 0;
  let snapshotSequence = 0;

  return {
    runs: {
      async createOrReuse(key, callerClass) {
        const active = [...runs.values()].find(
          (run) =>
            keyId(run.rootKey) === keyId(key) &&
            ["queued", "running", "retrying"].includes(run.status)
        );
        if (active) return active;
        const run: DiscoveryRun = {
          id: `00000000-0000-4000-8000-${String(++runSequence).padStart(12, "0")}`,
          rootKey: key,
          rootCharacterId: null,
          queueJobId: null,
          status: "queued",
          callerClass,
          attempt: 0,
          nextRetryAt: null,
          errorCode: null,
          createdAt: new Date("2026-08-05T08:00:00.000Z"),
          startedAt: null,
          completedAt: null,
          snapshotId: null
        };
        runs.set(run.id, run);
        return run;
      },
      async markRunning(id) {
        const run = runs.get(id);
        if (!run) throw new Error("discovery_run_not_found");
        run.status = "running";
        run.startedAt ??= new Date("2026-08-05T08:00:00.000Z");
        run.nextRetryAt = null;
      },
      async markRetrying(id, attempt, nextRetryAt) {
        const run = runs.get(id);
        if (!run) throw new Error("discovery_run_not_found");
        run.status = "retrying";
        run.attempt = attempt;
        run.nextRetryAt = nextRetryAt;
      },
      async complete(id, snapshotId) {
        const run = runs.get(id);
        if (!run) throw new Error("discovery_run_not_found");
        run.status = "complete";
        run.snapshotId = snapshotId;
      },
      async fail(id, code) {
        const run = runs.get(id);
        if (!run) throw new Error("discovery_run_not_found");
        run.status = "failed";
        run.errorCode = code;
        run.completedAt = new Date("2026-08-05T08:00:00.000Z");
        run.nextRetryAt = null;
      },
      async find(id) {
        return runs.get(id) ?? null;
      },
      async findActive(key) {
        return (
          [...runs.values()].find(
            (run) =>
              keyId(run.rootKey) === keyId(key) &&
              ["queued", "running", "retrying"].includes(run.status)
          ) ?? null
        );
      }
    },
    snapshots: {
      async create(input) {
        const id = `10000000-0000-4000-8000-${String(++snapshotSequence).padStart(12, "0")}`;
        const snapshot: StoredSnapshot = {
          id,
          runId: input.runId,
          rootKey: input.rootKey,
          state: input.state,
          limitationCode: input.limitationCode,
          refreshedAt: input.refreshedAt,
          characterCount: input.characters.length,
          characters: input.characters.map((item, displayOrder) => ({
            ...item,
            characterId: `20000000-0000-4000-8000-${String(displayOrder + 1).padStart(12, "0")}`,
            displayOrder
          }))
        };
        snapshots.set(id, snapshot);
        await thisRunComplete(input.runId, id);
        return snapshot;
      },
      async getCurrent(key) {
        return (
          [...snapshots.values()]
            .filter(
              (snapshot) =>
                keyId(snapshot.rootKey) === keyId(key) &&
                runs.get(snapshot.runId)?.status === "complete"
            )
            .at(-1) ?? null
        );
      },
      async find(id) {
        return snapshots.get(id) ?? null;
      },
      async listHistory() {
        return { items: [], nextCursor: null };
      }
    },
    suppressions: {
      async suppress() {},
      async isActive() {
        return false;
      }
    },
    rateLimits: {
      async record() {},
      async countActive() {
        return 0;
      },
      async cleanupExpired() {
        return 0;
      }
    },
    negativeCache: {
      async put(key, expiresAt) {
        negativeCache.set(keyId(key), expiresAt);
      },
      async find(key, at = new Date()) {
        const expiresAt = negativeCache.get(keyId(key));
        return expiresAt && expiresAt > at ? { key, expiresAt } : null;
      }
    }
  };

  async function thisRunComplete(runId: string, snapshotId: string) {
    const run = runs.get(runId);
    if (!run) throw new Error("discovery_run_not_found");
    run.status = "complete";
    run.snapshotId = snapshotId;
    run.completedAt = new Date("2026-08-05T08:00:00.000Z");
  }
}

function handlerFor(
  repositories: Repositories,
  gateway: RaiderIoGateway,
  overrides: Partial<Parameters<typeof createDiscoveryJobHandler>[0]> = {}
) {
  return createDiscoveryJobHandler({
    repositories,
    gateway,
    requestCap: 12,
    now: () => new Date("2026-08-05T08:00:00.000Z"),
    random: () => 0,
    baseRetryDelayMs: 1_000,
    maxRetryDelayMs: 1_800_000,
    maxAttempts: 5,
    negativeCacheTtlMs: 300_000,
    ...overrides
  });
}

describe("discovery job handler", () => {
  it("atomically persists a trustworthy snapshot and completes the run", async () => {
    // Break caught: a successful discovery could publish status without membership.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");

    await handlerFor(repositories, new MutableGateway()).execute(run.id);

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "complete"
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({ characterCount: 3 });
  });

  it("keeps the old snapshot when the gateway becomes unavailable", async () => {
    // Break caught: a transient refresh could replace trustworthy data with emptiness.
    const repositories = createMemoryRepositories();
    const firstRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    await handlerFor(repositories, new MutableGateway()).execute(firstRun.id);
    const old = await repositories.snapshots.getCurrent(rootKey);
    const refreshRun = await repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient",
      retryAfterMs: 30_000
    });

    await expect(
      handlerFor(repositories, gateway).execute(refreshRun.id)
    ).rejects.toMatchObject({ retryable: true });

    await expect(repositories.runs.find(refreshRun.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1,
      nextRetryAt: new Date("2026-08-05T08:00:30.000Z")
    });
    expect((await repositories.snapshots.getCurrent(rootKey))?.id).toBe(
      old?.id
    );
  });

  it("negative-caches definitive absence without creating a snapshot", async () => {
    // Break caught: confirmed absence could be retried or stored as an empty snapshot.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("missing"), {
      kind: "not_found"
    });

    await handlerFor(repositories, gateway).execute(run.id);

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "character_not_found"
    });
    await expect(
      repositories.negativeCache.find(
        rootKey,
        new Date("2026-08-05T08:00:00.000Z")
      )
    ).resolves.toMatchObject({
      expiresAt: new Date("2026-08-05T08:05:00.000Z")
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
  });

  it("ends the fifth transient attempt with a stable public failure", async () => {
    // Break caught: application state could remain retrying after pg-boss exhausts retries.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    await repositories.runs.markRetrying(
      run.id,
      4,
      new Date("2026-08-05T07:59:00.000Z")
    );
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient"
    });

    await expect(
      handlerFor(repositories, gateway).execute(run.id)
    ).resolves.toBeUndefined();

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_unavailable"
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
  });

  it("caps upstream Retry-After at the thirty-minute retry ceiling", async () => {
    // Break caught: an untrusted upstream delay could defer a job indefinitely.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient",
      retryAfterMs: 7_200_000
    });

    await expect(
      handlerFor(repositories, gateway).execute(run.id)
    ).rejects.toMatchObject({ retryable: true });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      nextRetryAt: new Date("2026-08-05T08:30:00.000Z")
    });
  });

  it("fails rather than retrying beyond the thirty-minute run lifetime", async () => {
    // Break caught: per-attempt expiration could let an old run retry indefinitely.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    run.createdAt = new Date("2026-08-05T07:30:00.000Z");
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient"
    });

    await expect(
      handlerFor(repositories, gateway).execute(run.id)
    ).resolves.toBeUndefined();

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_unavailable",
      nextRetryAt: null
    });
  });
});
