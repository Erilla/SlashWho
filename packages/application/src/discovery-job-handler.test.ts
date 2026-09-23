import type {
  CreateSnapshotInput,
  DiscoveryRun,
  FingerprintAdmission,
  FingerprintSweepCursor,
  Repositories,
  SnapshotCharacterInput,
  StoredSnapshot
} from "@slashwho/database";
import type {
  CharacterGuild,
  CharacterKey,
  RaiderIoCharacter,
  RaiderIoGateway,
  RaiderIoProfile
} from "@slashwho/domain";
import type {
  BlizzardGateway,
  BlizzardRosterCharacter
} from "@slashwho/blizzard";
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
    declaredMain: null,
    guild: null
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

const rosterGuild = {
  name: "Roster Guild",
  region: "eu",
  realm: "silvermoon"
} as const;

class MutableBlizzardGateway implements BlizzardGateway {
  roster: readonly BlizzardRosterCharacter[] = [];
  historicalRosters = new Map<string, readonly BlizzardRosterCharacter[]>();
  historicalGuildRosterCalls: string[] = [];
  fingerprints = new Map<string, ReadonlyMap<number, number>>();

  async getGuildRoster(
    _key?: CharacterKey,
    _signal?: AbortSignal,
    onProfileRequest?: () => Promise<void> | void
  ): Promise<readonly BlizzardRosterCharacter[]> {
    await onProfileRequest?.();
    if (this.roster.length > 0) await onProfileRequest?.();
    return this.roster;
  }

  async getGuildRosterByIdentity(
    guild: CharacterGuild,
    _signal?: AbortSignal,
    onProfileRequest?: () => Promise<void> | void
  ): Promise<readonly BlizzardRosterCharacter[]> {
    await onProfileRequest?.();
    const id = `${guild.region}/${guild.realm}/${guild.name}`;
    this.historicalGuildRosterCalls.push(id);
    return this.historicalRosters.get(id) ?? [];
  }

  async getAchievementFingerprint(
    key: CharacterKey,
    _signal?: AbortSignal,
    onProfileRequest?: () => Promise<void> | void
  ): Promise<ReadonlyMap<number, number>> {
    await onProfileRequest?.();
    return this.fingerprints.get(keyId(key)) ?? new Map();
  }

  async getCompletedAchievements(): Promise<readonly []> {
    return [];
  }
}

function keyId(key: CharacterKey): string {
  return `${key.region}/${key.realm}/${key.name}`;
}

function createMemoryRepositories(): Repositories {
  const runs = new Map<string, DiscoveryRun>();
  const snapshots = new Map<string, StoredSnapshot>();
  const negativeCache = new Map<string, Date>();
  const sweepCursors = new Map<
    string,
    {
      resumeAfter: string;
      snapshotId: string;
      runId: string;
      limitationCode: string | null;
      historicalGuilds: readonly CharacterGuild[];
    }
  >();
  // Mirrors `fingerprint_sweep_states.continuation_failures`: incremented by a
  // non-progress cycle, reset by any cursor write that advanced.
  const continuationFailures = new Map<string, number>();
  let runSequence = 0;
  let snapshotSequence = 0;

  return {
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
      async createAndFinishFingerprintSweep(input, _fingerprint, cursor) {
        const snapshot = await this.create(input);
        rememberCursor(input.rootKey, snapshot.id, input.runId, cursor);
        return snapshot;
      },
      async amendAndFinishFingerprintSweep(
        snapshotId,
        characters,
        fingerprint,
        cursor
      ) {
        // Appends to the published snapshot and never touches `discovery_runs`:
        // the run that published it is already complete.
        const existing = snapshots.get(snapshotId);
        if (!existing) throw new Error("snapshot_not_found");
        // Ownership, as the repository re-checks it under the root lock: the
        // cursor must still point at this snapshot and this snapshot must
        // still belong to the amending run. Otherwise nothing is written.
        const owner = sweepCursors.get(keyId(existing.rootKey));
        if (
          !owner ||
          owner.snapshotId !== snapshotId ||
          owner.runId !== fingerprint.runId
        ) {
          return null;
        }
        const amended: StoredSnapshot = {
          ...existing,
          state: fingerprint.limitationCode === null ? "complete" : "partial",
          limitationCode: fingerprint.limitationCode,
          characterCount: existing.characters.length + characters.length,
          characters: [
            ...existing.characters,
            ...characters.map((item, index) => ({
              ...item,
              characterId: `20000000-0000-4000-8000-${String(
                existing.characters.length + index + 1
              ).padStart(12, "0")}`,
              displayOrder: existing.characters.length + index
            }))
          ]
        };
        snapshots.set(snapshotId, amended);
        rememberCursor(existing.rootKey, snapshotId, existing.runId, cursor);
        return amended;
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
      async listReverseDeclaredCharacters() {
        return [];
      },
      async find(id) {
        return snapshots.get(id) ?? null;
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
      async requestAdmission() {
        return { kind: "not_due" };
      },
      async recordRequest() {},
      async finish() {},
      async release() {},
      async getResumeState(key) {
        return sweepCursors.get(keyId(key)) ?? null;
      },
      async recordContinuationFailure(key) {
        const failures = (continuationFailures.get(keyId(key)) ?? 0) + 1;
        continuationFailures.set(keyId(key), failures);
        return failures;
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
  };

  function rememberCursor(
    key: CharacterKey,
    snapshotId: string,
    runId: string,
    cursor: FingerprintSweepCursor
  ) {
    if (cursor.advanced) continuationFailures.delete(keyId(key));
    if (cursor.resumeAfter === null) {
      sweepCursors.delete(keyId(key));
      return;
    }
    sweepCursors.set(keyId(key), {
      resumeAfter: cursor.resumeAfter,
      snapshotId,
      runId,
      limitationCode: cursor.limitationCode,
      historicalGuilds: cursor.historicalGuilds ?? []
    });
  }

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

function candidate(key: CharacterKey): BlizzardRosterCharacter {
  return {
    key,
    displayName: key.name,
    className: "Priest",
    level: 80,
    guild: rosterGuild
  };
}

/**
 * A roster on a realm that sorts ahead of every realm a test appends by hand,
 * so an appended candidate is reached last and only a later cycle sweeps it.
 */
function rosterOf(count: number): BlizzardRosterCharacter[] {
  return Array.from({ length: count }, (_unused, index) =>
    candidate({
      region: "eu",
      realm: "argent-dawn",
      name: `member${String(index).padStart(3, "0")}`
    })
  );
}

/**
 * `createMemoryRepositories` numbers runs from one and the harness creates
 * exactly one, so its id is known before the creation promise settles — which
 * is what lets `handlerHarness` stay synchronous.
 */
const harnessRunId = "00000000-0000-4000-8000-000000000001";

function handlerHarness(
  options: {
    roster?: BlizzardRosterCharacter[];
    sweepRequestCap?: number;
    /** Candidates whose achievements match the root's. */
    matching?: readonly CharacterKey[];
    /** The limitation `discoverCharacter` observes; null for a clean run. */
    raiderIoLimitation?: "privacy_hidden" | null;
    maxJobLifetimeMs?: number;
    now?: () => Date;
  } = {}
) {
  const repositories = createMemoryRepositories();
  const runCreated = repositories.runs.createOrReuse(rootKey, "anonymous");
  const raiderIoLimitation = options.raiderIoLimitation ?? null;
  let sweepRequestCap = options.sweepRequestCap ?? 300;

  let discoverCharacterCalls = 0;
  let discoveredThisExecution = false;
  const base = new MutableGateway();
  const gateway: RaiderIoGateway = {
    async getCharacter(key, signal) {
      if (!discoveredThisExecution) {
        discoveredThisExecution = true;
        discoverCharacterCalls += 1;
      }
      if (raiderIoLimitation === "privacy_hidden") {
        return { ...character(key), ownerId: null };
      }
      return base.getCharacter(key, signal);
    },
    getClaimedCharacters: (ownerId, signal) =>
      base.getClaimedCharacters(ownerId, signal),
    resolveProfileGuess: (value, signal) =>
      base.resolveProfileGuess(value, signal)
  };

  const blizzardGateway = new MutableBlizzardGateway();
  blizzardGateway.roster = options.roster ?? [];
  blizzardGateway.fingerprints.set(keyId(rootKey), achievementFingerprint());
  for (const key of options.matching ?? []) {
    blizzardGateway.fingerprints.set(keyId(key), achievementFingerprint());
  }

  let reservations = 0;
  // The admission the next cycle receives. It defaults to `admitted` but is
  // settable, because a harness that can only answer `admitted` cannot observe
  // the deferral path at all -- the blind spot that let a `waiting`
  // continuation silently kill the chain.
  let nextAdmission: FingerprintAdmission | null = null;
  const requestedAdmissions: { continuation: boolean }[] = [];
  repositories.fingerprintSweeps.requestAdmission = async (input) => {
    requestedAdmissions.push({ continuation: input.continuation === true });
    if (nextAdmission) {
      // Mirrors the repository: a deferred ordinary run is handed back to its
      // unconsumed delivery as `queued`, and anything no longer active is
      // refused. A continuation is exempt -- its run was completed by cycle 1
      // and must stay complete, so deferral is carried by the re-enqueued
      // admission job alone.
      if (nextAdmission.kind === "waiting" && !input.continuation) {
        const deferred = await repositories.runs.find(input.runId);
        if (!deferred || !["running", "queued"].includes(deferred.status)) {
          throw new Error("fingerprint_waiting_run_not_running");
        }
        deferred.status = "queued";
      }
      return nextAdmission;
    }
    return {
      kind: "admitted" as const,
      reservationId: `harness-reservation-${++reservations}`,
      requestCap: sweepRequestCap
    };
  };

  const enqueuedFingerprintAdmissions: string[] = [];
  const created: CreateSnapshotInput[] = [];
  const amended: {
    snapshotId: string;
    characters: SnapshotCharacterInput[];
  }[] = [];
  let snapshot: StoredSnapshot | null = null;
  const publish = repositories.snapshots.createAndFinishFingerprintSweep.bind(
    repositories.snapshots
  );
  repositories.snapshots.createAndFinishFingerprintSweep = async (
    input,
    fingerprint,
    cursor,
    createOptions
  ) => {
    created.push(input);
    snapshot = await publish(input, fingerprint, cursor, createOptions);
    return snapshot;
  };
  const amend = repositories.snapshots.amendAndFinishFingerprintSweep.bind(
    repositories.snapshots
  );
  repositories.snapshots.amendAndFinishFingerprintSweep = async (
    snapshotId,
    characters,
    fingerprint,
    cursor,
    amendOptions
  ) => {
    amended.push({ snapshotId, characters });
    snapshot = await amend(
      snapshotId,
      characters,
      fingerprint,
      cursor,
      amendOptions
    );
    return snapshot;
  };

  // Every run record the handler logs, so a test can pin which path a cycle
  // took rather than only its side effects.
  const logged: Record<string, unknown>[] = [];
  const handler = handlerFor(repositories, gateway, {
    blizzardGateway,
    logger: {
      info(event) {
        logged.push(event);
      }
    },
    enqueueFingerprintAdmission: async (id: string) => {
      enqueuedFingerprintAdmissions.push(id);
    },
    ...(options.maxJobLifetimeMs === undefined
      ? {}
      : { maxJobLifetimeMs: options.maxJobLifetimeMs }),
    ...(options.now ? { now: options.now } : {})
  });

  return {
    repositories,
    rootKey,
    blizzardGateway,
    runId: harnessRunId,
    /** The cap the next admission reserves, so a cycle can be starved. */
    set sweepRequestCap(value: number) {
      sweepRequestCap = value;
    },
    /** Forces every later admission; null restores the `admitted` default. */
    set admission(value: FingerprintAdmission | null) {
      nextAdmission = value;
    },
    requestedAdmissions,
    /** The outcome label of the most recent execution. */
    lastOutcome(): unknown {
      return logged.filter((event) => event.event === "discovery_run").at(-1)
        ?.outcome;
    },
    enqueuedFingerprintAdmissions,
    snapshots: { created, amended },
    handler: {
      async execute(...arguments_: Parameters<typeof handler.execute>) {
        await runCreated;
        discoveredThisExecution = false;
        return handler.execute(...arguments_);
      }
    },
    get discoverCharacterCalls() {
      return discoverCharacterCalls;
    },
    snapshotCharacterKeys(): CharacterKey[] {
      return (snapshot?.characters ?? []).map((item) => item.key);
    },
    snapshotLimitationCode(): string | null {
      return snapshot?.limitationCode ?? null;
    }
  };
}

/** The job payload the worker dispatches for a continuation cycle. */
function continuation(harness: { runId: string; rootKey: CharacterKey }) {
  return {
    runId: harness.runId,
    key: harness.rootKey,
    enqueuedAt: "2026-08-05T08:00:00.000Z",
    continuation: true as const
  };
}

function delivery(attempt = 1, maxAttempts = 5) {
  return {
    attempt,
    maxAttempts,
    signal: new AbortController().signal
  };
}

describe("discovery job handler", () => {
  it("hands the admitted root observation to discovery without rereading it", async () => {
    // Break caught: the web admission read could be discarded at the queue
    // boundary, making the worker issue a second, potentially inconsistent read.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const getCharacter = vi.fn(async () => {
      throw new Error("duplicate_root_read");
    });
    const gateway: RaiderIoGateway = {
      getCharacter,
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    await handlerFor(repositories, gateway).execute(run.id, delivery(), {
      runId: run.id,
      key: rootKey,
      rootCharacter: character(rootKey)
    });

    expect(getCharacter).not.toHaveBeenCalled();
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "complete"
    });
  });

  it("sweeps every region-qualified guild from completed Mythic kill evidence", async () => {
    // Break caught: historical raid guilds used to enrich only the dossier,
    // leaving their current rosters invisible to connected-character discovery.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.evidence.getCompleted = async () =>
      ({
        kills: [
          {
            guild: { name: "Rancour", region: "eu", realm: "draenor" }
          },
          // Legacy rows cannot safely name a Blizzard namespace.
          { guild: { name: "Missing Region", realm: "draenor" } }
        ]
      }) as never;
    const blizzard = new MutableBlizzardGateway();
    blizzard.fingerprints.set(keyId(rootKey), achievementFingerprint());
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation",
      requestCap: 300
    });

    await handlerFor(repositories, new MutableGateway(), {
      blizzardGateway: blizzard
    }).execute(run.id, delivery());

    expect(blizzard.historicalGuildRosterCalls).toEqual(["eu/draenor/Rancour"]);
  });

  it("queues a full evidence collection only for a newly admitted fingerprint match", async () => {
    // Break caught: a match could become visible in the dossier with no report
    // collection, while known characters would unnecessarily be recollected.
    const match = {
      region: "eu",
      realm: "draenor",
      name: "mistakinus"
    } as const;
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const blizzard = new MutableBlizzardGateway();
    blizzard.roster = [candidate(match)];
    blizzard.fingerprints.set(keyId(rootKey), achievementFingerprint());
    blizzard.fingerprints.set(keyId(match), achievementFingerprint());
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation",
      requestCap: 300
    });
    const enqueueFullEvidence = vi.fn(async () => {});

    await handlerFor(repositories, new MutableGateway(), {
      blizzardGateway: blizzard,
      enqueueFullEvidence
    }).execute(run.id, delivery());

    expect(enqueueFullEvidence).toHaveBeenCalledTimes(1);
    expect(enqueueFullEvidence).toHaveBeenCalledWith(match);
  });

  it("queues full evidence before publishing a newly admitted fingerprint match", async () => {
    // Break caught: publishing first exposed the match to readers even if its
    // full evidence collection could not be admitted to the queue.
    const match = {
      region: "eu",
      realm: "draenor",
      name: "mistakinus"
    } as const;
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const blizzard = new MutableBlizzardGateway();
    blizzard.roster = [candidate(match)];
    blizzard.fingerprints.set(keyId(rootKey), achievementFingerprint());
    blizzard.fingerprints.set(keyId(match), achievementFingerprint());
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "reservation",
      requestCap: 300
    });
    const sideEffects: string[] = [];
    const publish = repositories.snapshots.createAndFinishFingerprintSweep.bind(
      repositories.snapshots
    );
    repositories.snapshots.createAndFinishFingerprintSweep = async (
      input,
      fingerprint,
      cursor,
      options
    ) => {
      sideEffects.push("snapshot");
      return publish(input, fingerprint, cursor, options);
    };
    const enqueueFullEvidence = vi.fn(async () => {
      sideEffects.push("evidence");
    });

    await handlerFor(repositories, new MutableGateway(), {
      blizzardGateway: blizzard,
      enqueueFullEvidence
    }).execute(run.id, delivery());

    expect(sideEffects).toEqual(["evidence", "snapshot"]);
  });

  it("seeds discovery from stored reverse declared-main relationships", async () => {
    // Break caught: the repository could know that an alt declared this root
    // while the worker neither included it nor needlessly hydrated it upstream.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const reverseKey = {
      region: "eu",
      realm: "draenor",
      name: "reverse-alt"
    } as const;
    repositories.snapshots.listReverseDeclaredCharacters = vi.fn(async () => [
      {
        key: reverseKey,
        displayName: "Reverse-alt",
        className: "Priest",
        level: 80,
        guild: {
          name: "Rancour",
          region: "eu" as const,
          realm: "draenor"
        },
        raiderIoUrl: "https://raider.io/characters/eu/draenor/reverse-alt",
        source: "declared_main" as const
      }
    ]);
    const getCharacter = vi.fn(async () => {
      throw new Error("unexpected_character_read");
    });
    const gateway: RaiderIoGateway = {
      getCharacter,
      async getClaimedCharacters() {
        return { characters: [] };
      },
      async resolveProfileGuess() {
        return null;
      }
    };

    await handlerFor(repositories, gateway).execute(run.id, delivery(), {
      runId: run.id,
      key: rootKey,
      rootCharacter: { ...character(rootKey), guild: rosterGuild }
    });

    expect(
      repositories.snapshots.listReverseDeclaredCharacters
    ).toHaveBeenCalledWith(rootKey);
    expect(getCharacter).not.toHaveBeenCalled();
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({
      characters: [
        expect.objectContaining({ key: rootKey, source: "input" }),
        expect.objectContaining({ key: reverseKey, source: "declared_main" })
      ]
    });
  });

  it("announces every execution of a run, carrying the attempt", async () => {
    // Break caught: announcing only the first attempt hid a run thrashing on
    // retries behind what looked like a single quiet start.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const started: unknown[] = [];
    const handler = handlerFor(repositories, new MutableGateway(), {
      discoveryRunNotifier: {
        started: async (value) => {
          started.push(value);
        }
      }
    });

    await handler.execute(run.id, delivery());

    expect(started).toEqual([
      {
        runId: run.id,
        region: "eu",
        realm: "silvermoon",
        name: "root",
        attempt: 1
      }
    ]);
  });

  it("completes a run whose start announcement fails", async () => {
    // Break caught: a chat notification is an operational side effect, so a
    // webhook that throws must never cost the run it was announcing.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const logger = { info: vi.fn() };
    const handler = handlerFor(repositories, new MutableGateway(), {
      logger,
      discoveryRunNotifier: {
        started: async () => {
          throw new Error("webhook_unreachable");
        }
      }
    });

    await expect(handler.execute(run.id, delivery())).resolves.toBeUndefined();
    await expect(repositories.runs.find(run.id)).resolves.toMatchObject({
      status: "complete"
    });
    expect(logger.info).toHaveBeenCalledWith({
      event: "discovery_run_announcement_failed",
      runId: run.id
    });
  });

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
    }).execute(run.id, delivery());

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
        level: 80,
        guild: rosterGuild
      },
      {
        key: fingerprintKey,
        displayName: "Fingerprint Match",
        className: "Priest",
        level: 80,
        guild: null
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
      {
        resumeAfter: null,
        limitationCode: null,
        historicalGuilds: [],
        advanced: true
      },
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
        level: 80,
        guild: null
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
      {
        resumeAfter: null,
        limitationCode: null,
        historicalGuilds: [],
        advanced: false
      },
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
    blizzardGateway.getGuildRoster = async (
      _key,
      _signal,
      onProfileRequest
    ) => {
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
    blizzardGateway.getGuildRoster = async (
      _key,
      _signal,
      onProfileRequest
    ) => {
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

  it("sweeps a root whose Raider.IO ownership is not public", async () => {
    // Break caught: gating the sweep on absent Raider.IO ownership excluded
    // every character never claimed upstream, which is most of them, leaving
    // the sweep unable to reach the alts it exists to find.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = vi.fn(async () => ({
      kind: "admitted" as const,
      reservationId: "unclaimed-reservation",
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

    expect(repositories.fingerprintSweeps.requestAdmission).toHaveBeenCalled();
    expect(blizzardGateway.getGuildRoster).toHaveBeenCalled();
    await expect(
      repositories.snapshots.getCurrent(rootKey)
    ).resolves.toMatchObject({
      state: "partial",
      limitationCode: "privacy_hidden"
    });
  });

  it("keeps known tournament members out of the snapshot when fingerprint discovery also matches them", async () => {
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted",
      reservationId: "tournament-reservation",
      requestCap: 300
    });
    const gateway = new MutableGateway();
    gateway.getClaimedCharacters = async () => ({
      characters: [
        character(secondKey),
        { ...character(fingerprintKey), isTournamentProfile: true }
      ]
    });
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.roster = [character(fingerprintKey)];
    blizzardGateway.fingerprints.set(keyId(rootKey), achievementFingerprint());
    blizzardGateway.fingerprints.set(
      keyId(fingerprintKey),
      achievementFingerprint()
    );

    await handlerFor(repositories, gateway, { blizzardGateway }).execute(
      run.id,
      delivery()
    );

    const snapshot = await repositories.snapshots.getCurrent(rootKey);
    expect(snapshot).toMatchObject({
      state: "partial",
      limitationCode: "unsupported_member"
    });
    expect(snapshot?.characters.map((item) => item.key)).toEqual([
      rootKey,
      secondKey
    ]);
    expect(snapshot).not.toHaveProperty("excludedTournamentCharacterIds");
  });

  it("spends no Raider.IO request per swept candidate", async () => {
    // Break caught: checking each candidate's upstream ownership cost one
    // unbudgeted Raider.IO request per roster member — hundreds per sweep,
    // counted against neither the discovery cap nor the Blizzard budget.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    repositories.fingerprintSweeps.requestAdmission = vi.fn(async () => ({
      kind: "admitted" as const,
      reservationId: "roster-reservation",
      requestCap: 300
    }));
    const gateway = new MutableGateway();
    const getCharacter = vi.fn(gateway.getCharacter.bind(gateway));
    gateway.getCharacter = getCharacter;
    const blizzardGateway = new MutableBlizzardGateway();
    const roster = Array.from({ length: 5 }, (_, index) => ({
      key: {
        region: "eu" as const,
        realm: "silvermoon",
        name: `member${index}`
      },
      displayName: `Member${index}`,
      className: "Mage",
      level: 80,
      guild: rosterGuild
    }));
    blizzardGateway.getGuildRoster = async () => roster;

    await handlerFor(repositories, gateway, { blizzardGateway }).execute(
      run.id,
      delivery()
    );

    const sweptKeys = getCharacter.mock.calls
      .map(([key]) => key?.name ?? "")
      .filter((name) => name.startsWith("member"));
    expect(sweptKeys).toEqual([]);
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
        correlationId: null,
        queueWaitMs: null,
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0,
        dbMs: 0,
        dbCalls: 9,
        dbMaxCallMs: 0,
        // Every call measures 0ms under this clock, so the first one to be
        // timed is the one that set the maximum.
        dbMaxCallName: "runs.claim",
        raiderIoMs: 0,
        // Two calls walk the relationships; the rest read each discovered
        // character's guild, which the profile payload does not carry.
        raiderIoCalls: 5,
        raiderIoMaxCallMs: 0
      }
    ]);
  });

  it("keeps provider and database buckets disjoint within the run duration", async () => {
    // Break caught: timing the orchestrating domain function instead of the
    // gateway counted every suppression check and fingerprint write inside the
    // provider buckets as well as in dbMs, so raiderIoMs + blizzardMs + dbMs
    // could exceed durationMs and an operator comparing a discovery_run with an
    // http_request record -- where the same field names are disjoint -- was
    // misled about which subsystem dominated the run.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const records: Array<Record<string, unknown>> = [];
    // Every clock read advances, so any nested region would be double counted
    // and break the inequality rather than silently reading as zero.
    let tick = 0;
    // An admitted sweep is the demanding case: it runs Blizzard calls and, via
    // the fingerprint budget callback, a database write inside one of them.
    repositories.fingerprintSweeps.requestAdmission = async () => ({
      kind: "admitted" as const,
      reservationId: "reservation-disjoint",
      requestCap: 300
    });
    const blizzardGateway = new MutableBlizzardGateway();
    blizzardGateway.roster = [
      {
        key: fingerprintKey,
        displayName: "Fingerprint Match",
        className: "Priest",
        level: 80,
        guild: null
      }
    ];
    const fingerprint = achievementFingerprint();
    blizzardGateway.fingerprints.set(keyId(rootKey), fingerprint);
    blizzardGateway.fingerprints.set(keyId(fingerprintKey), fingerprint);
    // The two database calls the domain functions make from inside the provider
    // phases dominate the clock, so counting either of them in a provider
    // bucket as well as in dbMs pushes the sum past durationMs.
    repositories.suppressions.isActive = async () => {
      tick += 1_000;
      return false;
    };
    repositories.fingerprintSweeps.recordRequest = async () => {
      tick += 1_000;
    };

    await handlerFor(repositories, new MutableGateway(), {
      blizzardGateway,
      logger: {
        info(record) {
          records.push(record);
        }
      },
      monotonic: () => tick++
    }).execute(run.id, delivery());

    const record = records[0]!;
    const value = (field: string) => (record[field] as number | undefined) ?? 0;

    expect(record.outcome).toBe("snapshot");
    expect(value("raiderIoCalls")).toBeGreaterThan(0);
    expect(value("blizzardCalls")).toBeGreaterThan(0);
    expect(value("dbCalls")).toBeGreaterThan(0);
    expect(value("durationMs")).toBeGreaterThan(0);
    expect(
      value("raiderIoMs") + value("blizzardMs") + value("dbMs")
    ).toBeLessThanOrEqual(value("durationMs"));
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
        correlationId: null,
        queueWaitMs: null,
        fingerprintQueueWaitMs: null,
        fingerprintReservedRequests: 0,
        fingerprintUsedRequests: 0,
        fingerprintDurationMs: 0,
        dbMs: 0,
        dbCalls: 5,
        dbMaxCallMs: 0,
        // Every call measures 0ms under this clock, so the first one to be
        // timed is the one that set the maximum.
        dbMaxCallName: "runs.claim",
        raiderIoMs: 0,
        raiderIoCalls: 1,
        raiderIoMaxCallMs: 0
      }
    ]);
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("records correlation id, exact queue wait, and provider totals", async () => {
    // Break caught: a job's correlation id and its time spent waiting in the
    // queue could go unattributed even though the queue payload carries them,
    // and Raider.IO/db time could go unattributed even though the record
    // carries a bucket for each.
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const records: Array<Record<string, unknown>> = [];
    const enqueuedAt = new Date("2026-08-05T07:59:59.000Z");
    const startedAt = new Date("2026-08-05T08:00:00.000Z");

    const handler = createDiscoveryJobHandler({
      repositories,
      gateway: new MutableGateway(),
      requestCap: 12,
      now: () => startedAt,
      monotonic: () => 0,
      logger: {
        info(record) {
          records.push(record);
        }
      }
    });

    await handler.execute(run.id, {
      attempt: 1,
      maxAttempts: 3,
      signal: new AbortController().signal,
      correlationId: "c1",
      enqueuedAt: enqueuedAt.toISOString()
    });

    expect(records[0]).toMatchObject({
      event: "discovery_run",
      correlationId: "c1",
      queueWaitMs: 1_000,
      raiderIoCalls: 5,
      raiderIoMs: expect.any(Number),
      raiderIoMaxCallMs: expect.any(Number),
      dbCalls: expect.any(Number),
      dbMs: expect.any(Number)
    });
  });

  it("reports a null queue wait for a job with no enqueue time", async () => {
    const repositories = createMemoryRepositories();
    const run = await repositories.runs.createOrReuse(rootKey, "anonymous");
    const records: Array<Record<string, unknown>> = [];

    const handler = createDiscoveryJobHandler({
      repositories,
      gateway: new MutableGateway(),
      requestCap: 12,
      logger: {
        info(record) {
          records.push(record);
        }
      }
    });

    await handler.execute(run.id, delivery());

    expect(records[0]).toMatchObject({ queueWaitMs: null });
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

  it("re-enqueues a capped sweep as a continuation", async () => {
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });

    await harness.handler.execute(harness.runId);

    expect(harness.snapshots.created).toHaveLength(1);
    expect(harness.snapshots.created[0]!.limitationCode).toBe(
      "fingerprint_sweep_capped"
    );
    expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(harness.rootKey)
    ).resolves.not.toBeNull();
  });

  it("retains a waiting admission while a capped cursor is live", async () => {
    // Break caught: the cap publication finished its only admission, so the
    // queued follow-up settled without ever dispatching this continuation.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    const publish = vi.spyOn(
      harness.repositories.snapshots,
      "createAndFinishFingerprintSweep"
    );

    await harness.handler.execute(harness.runId);

    expect(publish).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        continuationAdmission: expect.objectContaining({
          requestCap: 300
        })
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });

  it("does not replace a live capped snapshot after a cadence-gated refresh", async () => {
    // Break caught: a fresh Raider.IO-only run was allowed to publish after its
    // fingerprint admission was cadence-gated, shrinking the live cursor's
    // membership before its continuation could amend it.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const live = await harness.repositories.fingerprintSweeps.getResumeState(
      harness.rootKey
    );
    if (!live) throw new Error("expected_live_cursor");
    const fresh = await harness.repositories.runs.createOrReuse(
      harness.rootKey,
      "anonymous"
    );
    harness.admission = { kind: "not_due" };

    await harness.handler.execute(fresh.id);

    expect(harness.snapshots.created).toHaveLength(1);
    await expect(
      harness.repositories.runs.find(fresh.id)
    ).resolves.toMatchObject({
      status: "complete",
      snapshotId: live.snapshotId
    });
  });

  it("amends rather than republishes on a continuation", async () => {
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);

    await harness.handler.execute(harness.runId, undefined, {
      runId: harness.runId,
      key: harness.rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true
    });

    expect(harness.snapshots.created).toHaveLength(1);
    expect(harness.snapshots.amended).toHaveLength(1);
    expect(harness.discoverCharacterCalls).toBe(1); // not re-run
  });

  it("surfaces a match that only the second cycle reaches", async () => {
    // The Yawners regression: the match sorts past the first cycle's cap.
    const late = { region: "eu", realm: "draenor", name: "yawners" } as const;
    const harness = handlerHarness({
      roster: [...rosterOf(399), candidate(late)],
      sweepRequestCap: 50,
      matching: [late]
    });

    await harness.handler.execute(harness.runId);
    expect(harness.snapshotCharacterKeys()).not.toContainEqual(late);

    for (
      let cycle = 0;
      harness.enqueuedFingerprintAdmissions.length > 0;
      cycle += 1
    ) {
      if (cycle > 20) throw new Error("continuation did not terminate");
      harness.enqueuedFingerprintAdmissions.length = 0;
      await harness.handler.execute(harness.runId, undefined, {
        runId: harness.runId,
        key: harness.rootKey,
        enqueuedAt: new Date().toISOString(),
        continuation: true
      });
    }

    expect(harness.snapshotCharacterKeys()).toContainEqual(late);
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(harness.rootKey)
    ).resolves.toBeNull();
  });

  it("restores the Raider.IO limitation when the chain seals", async () => {
    // Cycle 1 overwrites limitation_code with fingerprint_sweep_capped. Sealing
    // must put back what discoverCharacter actually observed, not invent one and
    // not falsely claim complete.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50,
      raiderIoLimitation: "privacy_hidden"
    });

    await harness.handler.execute(harness.runId);
    expect(harness.snapshotLimitationCode()).toBe("fingerprint_sweep_capped");

    for (
      let cycle = 0;
      harness.enqueuedFingerprintAdmissions.length > 0;
      cycle += 1
    ) {
      if (cycle > 20) throw new Error("continuation did not terminate");
      harness.enqueuedFingerprintAdmissions.length = 0;
      await harness.handler.execute(harness.runId, undefined, {
        runId: harness.runId,
        key: harness.rootKey,
        enqueuedAt: new Date().toISOString(),
        continuation: true
      });
    }

    expect(harness.snapshotLimitationCode()).toBe("privacy_hidden");
  });

  it("seals to complete when Raider.IO discovery had no limitation", async () => {
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50,
      raiderIoLimitation: null
    });

    await harness.handler.execute(harness.runId);
    for (
      let cycle = 0;
      harness.enqueuedFingerprintAdmissions.length > 0;
      cycle += 1
    ) {
      if (cycle > 20) throw new Error("continuation did not terminate");
      harness.enqueuedFingerprintAdmissions.length = 0;
      await harness.handler.execute(harness.runId, undefined, {
        runId: harness.runId,
        key: harness.rootKey,
        enqueuedAt: new Date().toISOString(),
        continuation: true
      });
    }

    expect(harness.snapshotLimitationCode()).toBeNull();
  });

  it("publishes nothing when a continuation reaches a handler with no sweep configured", async () => {
    // Break caught: credentials rotated out between cycles leave a queued
    // continuation dispatched to a handler that skips the sweep block
    // entirely. Its outcome is a characterless placeholder, so falling through
    // to the plain publish path would overwrite a good dossier with an empty
    // snapshot and re-complete an already complete run.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const published = await harness.repositories.snapshots.getCurrent(rootKey);
    const create = vi.spyOn(harness.repositories.snapshots, "create");

    await createDiscoveryJobHandler({
      repositories: harness.repositories,
      gateway: new MutableGateway(),
      requestCap: 12,
      now: () => new Date("2026-08-05T08:00:00.000Z")
    }).execute(harness.runId, undefined, {
      runId: harness.runId,
      key: harness.rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true
    });

    expect(create).not.toHaveBeenCalled();
    expect(harness.snapshots.created).toHaveLength(1);
    await expect(
      harness.repositories.snapshots.getCurrent(rootKey)
    ).resolves.toEqual(published);
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(harness.rootKey)
    ).resolves.not.toBeNull();
  });

  it("seals a chain that outlives the job lifetime", async () => {
    // Break caught: every lifetime check measures from cycle 1's createdAt, so
    // a chain gated across the hourly budget -- the large rosters this feature
    // exists for -- failed an already complete run, swallowed the throw, and
    // abandoned the tail on fingerprint_sweep_capped forever.
    let currentTime = new Date("2026-08-05T08:00:00.000Z");
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50,
      maxJobLifetimeMs: 60_000,
      now: () => currentTime
    });

    await harness.handler.execute(harness.runId);
    // Every later cycle starts well past the run's one-minute job lifetime.
    currentTime = new Date("2026-08-05T09:00:00.000Z");

    for (
      let cycle = 0;
      harness.enqueuedFingerprintAdmissions.length > 0;
      cycle += 1
    ) {
      if (cycle > 20) throw new Error("continuation did not terminate");
      harness.enqueuedFingerprintAdmissions.length = 0;
      await harness.handler.execute(harness.runId, undefined, {
        runId: harness.runId,
        key: harness.rootKey,
        enqueuedAt: currentTime.toISOString(),
        continuation: true
      });
    }

    expect(harness.snapshotLimitationCode()).toBeNull();
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(harness.rootKey)
    ).resolves.toBeNull();
    await expect(
      harness.repositories.runs.find(harness.runId)
    ).resolves.toMatchObject({ status: "complete" });
  });

  it("re-enqueues a continuation whose sweep fails transiently", async () => {
    // Break caught: one flaky Blizzard call routed the continuation into
    // markRetrying/fail on a complete run, and nothing re-enqueued.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const published = await harness.repositories.snapshots.getCurrent(rootKey);
    const cursor =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    harness.enqueuedFingerprintAdmissions.length = 0;
    harness.blizzardGateway.getGuildRoster = async () => {
      throw Object.assign(new Error("transient"), {
        kind: "transient",
        retryAfterMs: 30_000
      });
    };

    await expect(
      harness.handler.execute(harness.runId, undefined, {
        runId: harness.runId,
        key: harness.rootKey,
        enqueuedAt: new Date().toISOString(),
        continuation: true
      })
    ).resolves.toBeUndefined();

    expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
    expect(harness.snapshots.amended).toHaveLength(0);
    await expect(
      harness.repositories.snapshots.getCurrent(rootKey)
    ).resolves.toEqual(published);
    await expect(
      harness.repositories.runs.find(harness.runId)
    ).resolves.toMatchObject({ status: "complete" });
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(cursor);
  });

  it("re-enqueues a continuation capped before it swept anything", async () => {
    // Break caught: a budget that ran out on the roster fetch produces a capped
    // outcome with no cursor. The cursor is rightly left alone, but with no
    // re-enqueue the chain simply stopped with its tail unswept.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const cursor =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    harness.enqueuedFingerprintAdmissions.length = 0;
    // Enough for the roster fetch and the root fingerprint, and no candidate.
    harness.sweepRequestCap = 3;

    await harness.handler.execute(harness.runId, undefined, {
      runId: harness.runId,
      key: harness.rootKey,
      enqueuedAt: new Date().toISOString(),
      continuation: true
    });

    expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(cursor);
    expect(harness.snapshotLimitationCode()).toBe("fingerprint_sweep_capped");
  });

  it("re-enqueues a continuation whose admission is deferred", async () => {
    // Break caught: a `waiting` admission reverted the run to `queued`, which a
    // continuation's complete run can never satisfy, so the repository threw,
    // the outer catch swallowed it against the complete run, and the chain
    // died silently -- under exactly the saturated hourly budget this feature
    // exists to survive.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const cursor =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    harness.enqueuedFingerprintAdmissions.length = 0;
    harness.admission = {
      kind: "waiting",
      retryAt: new Date("2026-08-05T08:05:00.000Z")
    };

    await expect(
      harness.handler.execute(harness.runId, undefined, continuation(harness))
    ).resolves.toBeUndefined();

    expect(harness.requestedAdmissions.at(-1)).toEqual({ continuation: true });
    // The deferral itself must succeed. Reaching the outer catch instead means
    // the repository refused to defer a complete run, which is the failure the
    // chain used to die of.
    expect(harness.lastOutcome()).toBe("fingerprint_admission_waiting");
    expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
    expect(harness.snapshots.amended).toHaveLength(0);
    await expect(
      harness.repositories.runs.find(harness.runId)
    ).resolves.toMatchObject({ status: "complete" });
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(cursor);
  });

  it("discards a continuation whose cursor a newer run has taken over", async () => {
    // Break caught: ownership was never checked, so this cycle amended a dead
    // snapshot and overwrote the live chain's cursor with the dead one's.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);

    // A fresh refresh for the same root publishes its own snapshot and takes
    // the cursor over while this continuation is still queued.
    const fresh = await harness.repositories.runs.createOrReuse(
      rootKey,
      "anonymous"
    );
    await harness.repositories.snapshots.createAndFinishFingerprintSweep(
      {
        runId: fresh.id,
        rootKey,
        state: "partial",
        limitationCode: "fingerprint_sweep_capped",
        refreshedAt: new Date("2026-08-05T09:00:00.000Z"),
        characters: []
      },
      {
        reservationId: "fresh-reservation",
        finishedAt: new Date("2026-08-05T09:00:00.000Z"),
        limitationCode: "fingerprint_sweep_capped"
      },
      {
        resumeAfter: "eu/argent-dawn/member100",
        limitationCode: null,
        advanced: true
      }
    );
    const live =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    harness.enqueuedFingerprintAdmissions.length = 0;

    await harness.handler.execute(
      harness.runId,
      undefined,
      continuation(harness)
    );

    expect(harness.snapshots.amended).toHaveLength(0);
    expect(harness.enqueuedFingerprintAdmissions).toEqual([]);
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(live);
    expect(live).toMatchObject({
      runId: fresh.id,
      resumeAfter: "eu/argent-dawn/member100"
    });
  });

  it("re-enqueues a continuation that throws unexpectedly", async () => {
    // Break caught: any unexpected throw mid-chain landed in the outer catch,
    // saw a complete run and returned, ending the chain forever with the
    // cursor still set and nothing anywhere to re-animate it.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const cursor =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    harness.enqueuedFingerprintAdmissions.length = 0;
    harness.repositories.snapshots.amendAndFinishFingerprintSweep =
      async () => {
        throw new Error("controlled_amend_failure");
      };

    await expect(
      harness.handler.execute(harness.runId, undefined, continuation(harness))
    ).resolves.toBeUndefined();

    expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
    await expect(
      harness.repositories.runs.find(harness.runId)
    ).resolves.toMatchObject({ status: "complete" });
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(cursor);
  });

  it("gives up after five continuation cycles that make no progress", async () => {
    // Break caught: disabling the job lifetime for continuations removed the
    // chain's only bound, so a roster whose upstream persistently fails looped
    // through the admission gate forever, burning the hourly budget.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);
    const cursor =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    // Enough for the roster fetch and the root fingerprint, and no candidate:
    // every cycle from here leaves the cursor exactly where it was.
    harness.sweepRequestCap = 3;

    const enqueuedPerCycle: number[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      harness.enqueuedFingerprintAdmissions.length = 0;
      await harness.handler.execute(
        harness.runId,
        undefined,
        continuation(harness)
      );
      enqueuedPerCycle.push(harness.enqueuedFingerprintAdmissions.length);
    }

    expect(enqueuedPerCycle).toEqual([1, 1, 1, 1, 0]);
    // The cursor stays set on give-up, so a later natural sweep of this root
    // resumes from here rather than restarting at the first candidate.
    await expect(
      harness.repositories.fingerprintSweeps.getResumeState(rootKey)
    ).resolves.toEqual(cursor);
    expect(harness.snapshotLimitationCode()).toBe("fingerprint_sweep_capped");
  });

  it("resets the give-up counter on a cycle that advances the cursor", async () => {
    // A chain that is making progress must never be cut off, however many
    // barren cycles the budget forced along the way.
    const harness = handlerHarness({
      roster: rosterOf(400),
      sweepRequestCap: 50
    });
    await harness.handler.execute(harness.runId);

    harness.sweepRequestCap = 3;
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await harness.handler.execute(
        harness.runId,
        undefined,
        continuation(harness)
      );
    }
    const stalled =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);

    harness.sweepRequestCap = 50;
    await harness.handler.execute(
      harness.runId,
      undefined,
      continuation(harness)
    );
    const advanced =
      await harness.repositories.fingerprintSweeps.getResumeState(rootKey);
    expect(advanced?.resumeAfter).not.toBe(stalled?.resumeAfter);

    harness.sweepRequestCap = 3;
    harness.enqueuedFingerprintAdmissions.length = 0;
    await harness.handler.execute(
      harness.runId,
      undefined,
      continuation(harness)
    );

    expect(harness.enqueuedFingerprintAdmissions).toEqual([harness.runId]);
  });
});
