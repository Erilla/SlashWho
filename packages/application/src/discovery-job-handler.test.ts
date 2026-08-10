import type {
  DiscoveryRun,
  Repositories,
  StoredSnapshot
} from "@slashwho/database";
import type {
  CharacterKey,
  FingerprintCandidate,
  RaiderIoCharacter,
  RaiderIoGateway,
  RaiderIoProfile
} from "@slashwho/domain";
import type { BlizzardGateway } from "@slashwho/blizzard";
import { describe, expect, it, vi } from "vitest";

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
const fingerprintKey: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "fingerprint-match"
};

function achievementFingerprint(count = 200): ReadonlyMap<number, number> {
  return new Map(
    Array.from({ length: count }, (_unused, index) => [
      index + 1,
      1_700_000_000 + index
    ])
  );
}

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

  async getCharacter(
    _key?: CharacterKey,
    _signal?: AbortSignal
  ): Promise<RaiderIoCharacter> {
    void _key;
    void _signal;
    if (this.failure) throw this.failure;
    return character(rootKey);
  }

  async getClaimedCharacters(
    _ownerId?: string,
    _signal?: AbortSignal
  ): Promise<RaiderIoProfile> {
    void _ownerId;
    void _signal;
    if (this.failure) throw this.failure;
    return { characters: [character(secondKey), character(thirdKey)] };
  }

  async resolveProfileGuess(
    _guess?: string,
    _signal?: AbortSignal
  ): Promise<null> {
    void _guess;
    void _signal;
    if (this.failure) throw this.failure;
    return null;
  }
}

class MutableBlizzardGateway implements BlizzardGateway {
  roster: readonly FingerprintCandidate[] = [];
  fingerprints = new Map<string, ReadonlyMap<number, number>>();

  async getGuildRoster(
    _key?: CharacterKey,
    _signal?: AbortSignal,
    onProfileRequest?: () => Promise<void> | void
  ): Promise<readonly FingerprintCandidate[]> {
    await onProfileRequest?.();
    if (this.roster.length > 0) await onProfileRequest?.();
    return this.roster;
  }

  async getAchievementFingerprint(
    key: CharacterKey,
    _signal?: AbortSignal,
    onProfileRequest?: () => Promise<void> | void
  ): Promise<ReadonlyMap<number, number>> {
    await onProfileRequest?.();
    return this.fingerprints.get(keyId(key)) ?? new Map();
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
    searchReservations: {
      async reserve() {
        throw new Error("not used");
      },
      async cancel() {
        throw new Error("not used");
      },
      async listPending() {
        return [];
      },
      async markEnqueued() {
        throw new Error("not used");
      }
    },
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
      async claim(id, attempt) {
        const run = runs.get(id);
        if (
          !run ||
          !["queued", "running", "retrying"].includes(run.status) ||
          run.attempt >= attempt
        ) {
          return null;
        }
        run.status = "running";
        run.attempt = attempt;
        run.startedAt ??= new Date("2026-08-05T08:00:00.000Z");
        run.nextRetryAt = null;
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
      async createAndFinishFingerprintSweep(input) {
        return this.create(input);
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
      },
      async cleanupExpired() {
        return 0;
      }
    },
    rateLimits: {
      async reserve() {
        return { allowed: true, retryAt: null };
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
      async put(key, expiresAt) {
        negativeCache.set(keyId(key), expiresAt);
      },
      async putAndFailRun(key, expiresAt, runId, options) {
        options?.signal?.throwIfAborted();
        negativeCache.set(keyId(key), expiresAt);
        const run = runs.get(runId);
        if (!run) throw new Error("discovery_run_not_found");
        run.status = "failed";
        run.errorCode = "character_not_found";
        run.completedAt = new Date("2026-08-05T08:00:00.000Z");
      },
      async find(key, at = new Date()) {
        const expiresAt = negativeCache.get(keyId(key));
        return expiresAt && expiresAt > at ? { key, expiresAt } : null;
      },
      async cleanupExpired() {
        return 0;
      }
    },
    fingerprintSweeps: {
      async requestAdmission() {
        return { kind: "not_due" };
      },
      async recordRequest() {},
      async finish() {},
      async release() {},
      async listWaiting() {
        return [];
      },
      async listAdmittedUndispatched() {
        return [];
      },
      async markDispatched() {},
      async admitWaiting() {
        return { kind: "settled" };
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
    blizzardGateway: new MutableBlizzardGateway(),
    fingerprint: {
      requestCap: 300,
      hourlyBudget: 28_800,
      cadenceMs: 7 * 24 * 60 * 60 * 1_000,
      minimumCommon: 200,
      minimumIdenticalPercent: 20
    },
    enqueueFingerprintAdmission: async () => {},
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

function delivery(attempt = 1, maxAttempts = 5) {
  return {
    attempt,
    maxAttempts,
    signal: new AbortController().signal
  };
}

describe("discovery job handler", () => {
  it("defers an eligible run to private FIFO admission without consuming a delivery retry", async () => {
    // Break caught: budget waiting could consume a discovery retry or publish
    // the Raider.IO-only intermediate result before the atomic sweep resumes.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const retryAt = new Date("2026-08-05T08:15:00.000Z");
    const blockedSince = new Date("2026-08-05T07:44:00.000Z");
    repositories.fingerprintSweeps.requestAdmission = async () => {
      const claimed = await repositories.runs.find(run.id);
      if (!claimed) throw new Error("discovery_run_not_found");
      claimed.status = "queued";
      claimed.attempt -= 1;
      return { kind: "waiting", retryAt, blockedSince };
    };
    const gateway = new MutableGateway();
    gateway.getCharacter = vi.fn(gateway.getCharacter.bind(gateway));
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.getGuildRoster = vi.fn(
      blizzardGateway.getGuildRoster.bind(blizzardGateway)
    );

    const enqueueFingerprintAdmission = vi.fn(async () => {});
    const alerts: unknown[] = [];
    await handlerFor(repositories, gateway, {
      blizzardGateway,
      enqueueFingerprintAdmission,
      fingerprintAlertNotifier: {
        notify: async (alert) => {
          alerts.push(alert);
        }
      }
    }).execute(
      run.id,
      delivery()
    );

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "queued",
      attempt: 0
    });
    expect(gateway.getCharacter).toHaveBeenCalled();
    expect(blizzardGateway.getGuildRoster).not.toHaveBeenCalled();
    expect(enqueueFingerprintAdmission).toHaveBeenCalledWith(run.id);
    expect(alerts).toEqual([
      {
        event: "fingerprint_admission_blocked",
        details: { blockedForMs: 16 * 60_000 }
      }
    ]);
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
  });

  it("accounts for an admitted sweep and publishes one deduplicated merged snapshot", async () => {
    // Break caught: fingerprint observations could be published separately,
    // duplicated, or consume Blizzard capacity without durable accounting.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = vi.fn(async () => ({
      kind: "admitted" as const,
      reservationId: "reservation-1",
      requestCap: 300
    }));
    repositories.fingerprintSweeps.recordRequest = vi.fn(async () => {});
    repositories.fingerprintSweeps.finish = vi.fn(async () => {});
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.roster = [
      {
        key: secondKey,
        displayName: "Second from Blizzard",
        className: "Mage",
        level: 80
      },
      {
        key: fingerprintKey,
        displayName: "Fingerprint Match",
        className: "Priest",
        level: 80
      }
    ];
    const fingerprint = achievementFingerprint();
    blizzardGateway.fingerprints.set(keyId(rootKey), fingerprint);
    blizzardGateway.fingerprints.set(keyId(secondKey), fingerprint);
    blizzardGateway.fingerprints.set(keyId(fingerprintKey), fingerprint);
    const publish = vi.spyOn(
      repositories.snapshots,
      "createAndFinishFingerprintSweep"
    );

    await handlerFor(repositories, new MutableGateway(), {
      blizzardGateway
    }).execute(run.id, delivery());

    expect(publish).toHaveBeenCalledOnce();
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({
      state: "complete",
      limitationCode: null,
      characterCount: 4,
      characters: expect.arrayContaining([
        expect.objectContaining({ key: fingerprintKey, source: "fingerprint" }),
        expect.objectContaining({ key: secondKey, source: "claimed" })
      ])
    });
    expect(repositories.fingerprintSweeps.recordRequest).toHaveBeenCalledTimes(
      5
    );
    expect(publish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        reservationId: "reservation-1",
        limitationCode: null
      }),
      expect.any(Object)
    );
  });

  it("publishes a cap-bounded partial result", async () => {
    // Break caught: exhausting the reserved cap could publish a complete result
    // or retry and discard the permitted partial snapshot.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation-capped",
      requestCap: 2
    });
    repositories.fingerprintSweeps.recordRequest = vi.fn(async () => {});
    const publish = vi.spyOn(
      repositories.snapshots,
      "createAndFinishFingerprintSweep"
    );
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.roster = [
      {
        key: fingerprintKey,
        displayName: "Fingerprint Match",
        className: "Priest",
        level: 80
      }
    ];
    blizzardGateway.fingerprints.set(rootKey.name, achievementFingerprint());

    await handlerFor(repositories, new MutableGateway(), {
      blizzardGateway
    }).execute(run.id, delivery());

    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({
      state: "partial",
      limitationCode: "fingerprint_sweep_capped",
      characterCount: 3
    });
    expect(repositories.fingerprintSweeps.recordRequest).toHaveBeenCalledTimes(
      2
    );
    expect(publish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        reservationId: "reservation-capped",
        limitationCode: "fingerprint_sweep_capped"
      }),
      expect.any(Object)
    );
  });

  it("releases a failed fingerprint reservation and retries without publication", async () => {
    // Break caught: a Blizzard failure could expose a half-merged snapshot or
    // retain unused reserved capacity across the retry.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation-failed",
      requestCap: 300
    });
    const events: string[] = [];
    repositories.fingerprintSweeps.recordRequest = vi.fn(async () => {
      events.push("accounted");
    });
    repositories.fingerprintSweeps.release = vi.fn(async () => {});
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.getGuildRoster = async (_key, _signal, onProfileRequest) => {
      await onProfileRequest?.();
      events.push("upstream");
      throw Object.assign(new Error("private-upstream-marker"), {
        kind: "transient",
        retryAfterMs: 30_000
      });
    };

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        blizzardGateway
      }).execute(run.id, delivery())
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 30_000 });

    expect(repositories.fingerprintSweeps.recordRequest).toHaveBeenCalledOnce();
    expect(events).toEqual(["accounted", "upstream"]);
    expect(repositories.fingerprintSweeps.release).toHaveBeenCalledWith(
      "reservation-failed",
      expect.any(Date)
    );
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
  });

  it("keeps release retryable when the first release write fails", async () => {
    // Break caught: a transient release failure could be treated as settled and
    // strand the reservation for its whole accounting window.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation-release-retry",
      requestCap: 300
    });
    repositories.fingerprintSweeps.recordRequest = async () => {};
    let releases = 0;
    repositories.fingerprintSweeps.release = async () => {
      releases += 1;
      if (releases === 1) throw new Error("release_write_failed");
    };
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.getGuildRoster = async () => {
      throw Object.assign(new Error("transient"), { kind: "transient" });
    };

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        blizzardGateway
      }).execute(run.id, delivery())
    ).rejects.toMatchObject({ retryable: true });

    expect(releases).toBe(2);
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying"
    });
  });

  it("releases an aborted fingerprint reservation without publishing or reconciling", async () => {
    // Break caught: worker shutdown could leak a reservation or persist the
    // transient Raider.IO half of an abandoned atomic sweep.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation-aborted",
      requestCap: 300
    });
    repositories.fingerprintSweeps.recordRequest = vi.fn(async () => {});
    repositories.fingerprintSweeps.release = vi.fn(async () => {});
    const controller = new AbortController();
    const abortReason = new DOMException("drain timeout", "AbortError");
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.getGuildRoster = async (_key, _signal, onProfileRequest) => {
      await onProfileRequest?.();
      controller.abort(abortReason);
      return [];
    };

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        blizzardGateway
      }).execute(run.id, { ...delivery(), signal: controller.signal })
    ).rejects.toBe(abortReason);

    expect(repositories.fingerprintSweeps.recordRequest).toHaveBeenCalledOnce();
    expect(repositories.fingerprintSweeps.release).toHaveBeenCalledWith(
      "reservation-aborted",
      expect.any(Date)
    );
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      snapshotId: null,
      errorCode: null
    });
  });

  it("retries an aborted delivery when reservation release cannot be persisted", async () => {
    // Break caught: cancellation could hide a failed release and retain a full
    // reservation until expiry with no durable path to retry the cleanup.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation-abort-release-failure",
      requestCap: 300
    });
    repositories.fingerprintSweeps.recordRequest = async () => {};
    repositories.fingerprintSweeps.release = async () => {
      throw new Error("release_write_failed");
    };
    const controller = new AbortController();
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.getGuildRoster = async () => {
      controller.abort(new DOMException("drain timeout", "AbortError"));
      return [];
    };

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        blizzardGateway
      }).execute(run.id, { ...delivery(), signal: controller.signal })
    ).rejects.toMatchObject({ retryable: true });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying"
    });
  });

  it("never starts a fingerprint sweep from privacy-hidden root ownership", async () => {
    // Break caught: a root whose Raider.IO ownership is intentionally hidden
    // could seed inferred links despite the project's sole privacy signal.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = vi.fn(async () => ({
      kind: "admitted" as const,
      reservationId: "privacy-reservation",
      requestCap: 300
    }));
    const gateway = new MutableGateway();
    gateway.getCharacter = async () => ({
      ...character(rootKey),
      ownerId: null
    });
    gateway.resolveProfileGuess = async () => null;
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.getGuildRoster = vi.fn(
      blizzardGateway.getGuildRoster.bind(blizzardGateway)
    );

    await handlerFor(repositories, gateway, { blizzardGateway }).execute(
      run.id,
      delivery()
    );

    expect(
      repositories.fingerprintSweeps.requestAdmission
    ).not.toHaveBeenCalled();
    expect(blizzardGateway.getGuildRoster).not.toHaveBeenCalled();
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({
      state: "partial",
      limitationCode: "privacy_hidden"
    });
  });

  it("never starts a fingerprint sweep when request capping masks hidden root ownership", async () => {
    // Break caught: request_cap can take precedence over privacy_hidden while
    // preserving the same privacy fact that must bar fingerprint inference.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = vi.fn(async () => ({
      kind: "admitted" as const,
      reservationId: "capped-privacy-reservation",
      requestCap: 300
    }));
    const gateway = new MutableGateway();
    gateway.getCharacter = async () => ({
      ...character(rootKey),
      ownerId: null,
      profileGuess: "private-alias"
    });
    gateway.resolveProfileGuess = async () => null;

    await handlerFor(repositories, gateway, { requestCap: 1 }).execute(
      run.id,
      delivery()
    );

    expect(
      repositories.fingerprintSweeps.requestAdmission
    ).not.toHaveBeenCalled();
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({ limitationCode: "request_cap" });
  });

  it("emits one allowlisted operational record per completed discovery", async () => {
    // Break caught: a production discovery could succeed or fail with nothing
    // operable in the logs, or could log private lookup values while becoming visible.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const events: Record<string, unknown>[] = [];

    await handlerFor(repositories, new MutableGateway(), {
      logger: {
        info(event) {
          events.push(event);
        }
      },
      monotonic: () => 0
    }).execute(run.id, delivery(2));

    expect(events).toEqual([
      {
        event: "discovery_run",
        runId: run.id,
        region: "eu",
        realm: "silvermoon",
        name: "root",
        attempt: 2,
        outcome: "snapshot",
        state: "complete",
        limitationCode: null,
        characterCount: 3,
        durationMs: 0,
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0
      }
    ]);
  });

  it("records a failure outcome without upstream detail", async () => {
    // Break caught: a permanent failure could log the upstream body, an owner id, or
    // a guess string while explaining itself.
    const marker = "UNIQUE_UPSTREAM_MARKER_a4f7c2";
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error(marker), { kind: "not_found" });
    const events: Record<string, unknown>[] = [];

    await handlerFor(repositories, gateway, {
      logger: {
        info(event) {
          events.push(event);
        }
      },
      monotonic: () => 0
    }).execute(run.id, delivery());

    expect(events).toEqual([
      {
        event: "discovery_run",
        runId: run.id,
        region: "eu",
        realm: "silvermoon",
        name: "root",
        attempt: 1,
        outcome: "character_not_found",
        state: null,
        limitationCode: null,
        characterCount: 0,
        durationMs: 0,
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0
      }
    ]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

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

  it("lets only one duplicate delivery perform discovery", async () => {
    // Break caught: duplicate same-attempt workers could both call the gateway.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const base = new MutableGateway();
    const gateway: RaiderIoGateway = {
      async getCharacter(key) {
        calls += 1;
        started();
        await blocked;
        return base.getCharacter(key);
      },
      getClaimedCharacters: (owner) => base.getClaimedCharacters(owner),
      resolveProfileGuess: (value) => base.resolveProfileGuess(value)
    };
    const handler = handlerFor(repositories, gateway);

    const first = handler.execute(run.id, delivery());
    await firstStarted;
    const duplicate = handler.execute(run.id, delivery());
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(1);
    await expect(duplicate).resolves.toBeUndefined();
    release();
    await first;
    await expect(repositories.negativeCache.find(rootKey)).resolves.toBeNull();
  });

  it("reconciles an unexpected persistence error to retrying", async () => {
    // Break caught: snapshot failure could leave a non-final run stuck in running.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.snapshots.create = async () => {
      throw new Error("controlled_snapshot_failure");
    };

    await expect(
      handlerFor(repositories, new MutableGateway()).execute(
        run.id,
        delivery(1)
      )
    ).rejects.toMatchObject({ retryable: true });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1
    });
  });

  it("fails when less than one durable retry second remains", async () => {
    // Break caught: pg-boss would round a sub-second retry beyond the deadline.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    run.createdAt = new Date("2026-08-05T07:30:00.000Z");
    repositories.snapshots.create = async () => {
      throw new Error("controlled_snapshot_failure");
    };

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        now: () => new Date("2026-08-05T07:59:59.001Z")
      }).execute(run.id, delivery(1))
    ).rejects.toThrow("controlled_snapshot_failure");

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "search_failed",
      nextRetryAt: null
    });
  });

  it("allows a one-second durable retry at the lifetime boundary", async () => {
    // Break caught: the whole-second boundary could terminate one retry too early.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    run.createdAt = new Date("2026-08-05T07:30:00.000Z");
    repositories.snapshots.create = async () => {
      throw new Error("controlled_snapshot_failure");
    };

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        now: () => new Date("2026-08-05T07:59:59.000Z")
      }).execute(run.id, delivery(1))
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 1_000 });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying",
      nextRetryAt: new Date("2026-08-05T08:00:00.000Z")
    });
  });

  it("enforces the durable-delay contract with 1,500 milliseconds remaining", async () => {
    // Break caught: capping in milliseconds could let pg-boss round past the deadline.
    const retryableRepositories = createMemoryRepositories();
    const retryableRun = await retryableRepositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    retryableRun.createdAt = new Date("2026-08-05T07:30:00.000Z");
    const oneSecondGateway = new MutableGateway();
    oneSecondGateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient",
      retryAfterMs: 1_000
    });

    await expect(
      handlerFor(retryableRepositories, oneSecondGateway, {
        now: () => new Date("2026-08-05T07:59:58.500Z")
      }).execute(retryableRun.id, delivery(1))
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 1_000 });
    await expect(
      retryableRepositories.runs.find(retryableRun.id)
    ).resolves.toMatchObject({
      status: "retrying",
      nextRetryAt: new Date("2026-08-05T07:59:59.500Z")
    });

    const terminalRepositories = createMemoryRepositories();
    const terminalRun = await terminalRepositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    terminalRun.createdAt = new Date("2026-08-05T07:30:00.000Z");
    const twoSecondGateway = new MutableGateway();
    twoSecondGateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient",
      retryAfterMs: 2_000
    });

    await expect(
      handlerFor(terminalRepositories, twoSecondGateway, {
        now: () => new Date("2026-08-05T07:59:58.500Z")
      }).execute(terminalRun.id, delivery(1))
    ).resolves.toBeUndefined();
    await expect(
      terminalRepositories.runs.find(terminalRun.id)
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_unavailable",
      nextRetryAt: null
    });
  });

  it("rejects a rounded multi-second delay that exceeds fractional lifetime", async () => {
    // Break caught: a 2,001 ms request could be capped to 2,500 ms then persisted as 3 seconds.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    run.createdAt = new Date("2026-08-05T07:30:00.000Z");
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient",
      retryAfterMs: 2_001
    });

    await expect(
      handlerFor(repositories, gateway, {
        now: () => new Date("2026-08-05T07:59:57.500Z")
      }).execute(run.id, delivery(1))
    ).resolves.toBeUndefined();

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_unavailable",
      nextRetryAt: null
    });
  });

  it("fails an unexpected error when reconciliation reaches the lifetime deadline", async () => {
    // Break caught: an error crossing the lifetime boundary could still retry.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    run.createdAt = new Date("2026-08-05T07:30:00.000Z");
    repositories.snapshots.create = async () => {
      throw new Error("controlled_snapshot_failure");
    };
    const times = [
      new Date("2026-08-05T07:59:59.900Z"),
      new Date("2026-08-05T07:59:59.950Z"),
      new Date("2026-08-05T08:00:00.001Z")
    ];

    await expect(
      handlerFor(repositories, new MutableGateway(), {
        now: () => times.shift() ?? new Date("2026-08-05T08:00:00.001Z")
      }).execute(run.id, delivery(1))
    ).rejects.toThrow("controlled_snapshot_failure");

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "search_failed",
      nextRetryAt: null
    });
  });

  it("reconciles an unexpected final-delivery error to failed", async () => {
    // Break caught: fifth-delivery persistence failure could leave an active run forever.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.snapshots.create = async () => {
      throw new Error("controlled_snapshot_failure");
    };

    await expect(
      handlerFor(repositories, new MutableGateway()).execute(
        run.id,
        delivery(5)
      )
    ).rejects.toThrow("controlled_snapshot_failure");

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      attempt: 5,
      errorCode: "search_failed"
    });
  });

  it("does not persist any outcome after delivery cancellation", async () => {
    // Break caught: an aborted gateway call could still publish or negative-cache.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const controller = new AbortController();
    const base = new MutableGateway();
    const gateway: RaiderIoGateway = {
      async getCharacter(key, signal) {
        expect(signal).toBe(controller.signal);
        controller.abort(new DOMException("drain timeout", "AbortError"));
        return base.getCharacter(key);
      },
      getClaimedCharacters: (owner, signal) =>
        base.getClaimedCharacters(owner, signal),
      resolveProfileGuess: (value, signal) =>
        base.resolveProfileGuess(value, signal)
    };

    await expect(
      handlerFor(repositories, gateway).execute(run.id, {
        ...delivery(),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "running",
      attempt: 1,
      snapshotId: null,
      errorCode: null
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
    await expect(repositories.negativeCache.find(rootKey)).resolves.toBeNull();
  });

  it("rechecks the lifetime deadline after discovery before publication", async () => {
    // Break caught: a slow successful discovery could publish after the 30-minute bound.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    run.createdAt = new Date("2026-08-05T07:30:00.000Z");
    const times = [
      new Date("2026-08-05T07:59:59.000Z"),
      new Date("2026-08-05T08:00:01.000Z")
    ];

    await handlerFor(repositories, new MutableGateway(), {
      now: () => times.shift() ?? new Date("2026-08-05T08:00:01.000Z")
    }).execute(run.id, delivery());

    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      errorCode: "upstream_unavailable",
      snapshotId: null
    });
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toBeNull();
  });

  it("recovers a one-shot retry-state persistence failure", async () => {
    // Break caught: a recoverable markRetrying error could strand a running run.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const persistRetry = repositories.runs.markRetrying;
    let writes = 0;
    repositories.runs.markRetrying = async (...arguments_) => {
      writes += 1;
      if (writes === 1) throw new Error("controlled_retry_write_failure");
      return persistRetry(...arguments_);
    };
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient"
    });

    await expect(
      handlerFor(repositories, gateway).execute(run.id, delivery(1))
    ).rejects.toMatchObject({ retryable: true });

    expect(writes).toBe(2);
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "retrying",
      attempt: 1
    });
  });

  it("recovers a one-shot final failure-state persistence error", async () => {
    // Break caught: the final delivery could exhaust pg-boss with the run still active.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const persistFailure = repositories.runs.fail;
    let writes = 0;
    repositories.runs.fail = async (...arguments_) => {
      writes += 1;
      if (writes === 1) throw new Error("controlled_failure_write_failure");
      return persistFailure(...arguments_);
    };
    const gateway = new MutableGateway();
    gateway.failure = Object.assign(new Error("unavailable"), {
      kind: "transient"
    });

    await expect(
      handlerFor(repositories, gateway).execute(run.id, delivery(5))
    ).rejects.toThrow("controlled_failure_write_failure");

    expect(writes).toBe(2);
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "failed",
      attempt: 5,
      errorCode: "search_failed"
    });
  });
});
