import type { SearchService } from "./search-service";
import type {
  DiscoveryQueue,
  Repositories,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredSnapshot
} from "@slashwho/database";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type { RaiderIoGateway } from "@slashwho/raiderio";
import type { CharacterKey } from "@slashwho/contracts";
import { describe, expect, it, vi } from "vitest";

import { applicationConfigSchema } from "./config";
import { decryptCredential } from "./credential-encryption";
import { createApplicantDossierService } from "./applicant-dossier-service";
import { createMeasurementScope } from "./measurement";
import { createSearchService } from "./search-service";

const encryptionKey = Buffer.alloc(32, "k");
const root = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
const alt = { region: "eu", realm: "silvermoon", name: "ryalts" } as const;
const third = { region: "eu", realm: "silvermoon", name: "third" } as const;
const headers = new Headers({ "x-real-ip": "203.0.113.8" });
const raiderUrl = "https://raider.io/characters/eu/silvermoon/ryii";

function storedSnapshot(
  characters: StoredSnapshot["characters"] = [
    {
      characterId: "10000000-0000-4000-8000-000000000001",
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      guild: null,
      raiderIoUrl: raiderUrl,
      source: "input",
      displayOrder: 0
    },
    {
      characterId: "10000000-0000-4000-8000-000000000002",
      key: alt,
      displayName: "Ryalts",
      className: "Priest",
      level: 80,
      guild: null,
      raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
      source: "fingerprint",
      displayOrder: 1
    }
  ]
): StoredSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    rootKey: root,
    state: "complete",
    limitationCode: null,
    refreshedAt: new Date("2026-09-11T12:00:00.000Z"),
    characterCount: characters.length,
    characters
  };
}

function fixture(
  options: {
    snapshot?: StoredSnapshot | null;
    containingSnapshot?: StoredSnapshot | null;
    characterCap?: number;
    warcraftLogsRequestCap?: number;
    providerConcurrency?: number;
    additionalKills?: readonly StoredCharacterMythicKill[];
    wipes?: readonly StoredCharacterMythicWipe[];
    includeCachedKills?: boolean;
    evidenceStatus?: "complete" | "partial";
    wipeCapable?: boolean;
    evidenceLimitationCode?: string | null;
    evidenceParseLimitationCode?: string | null;
    gatheringCharacter?: CharacterKey | null;
  } = {}
) {
  const runsCreate = vi.fn();
  const enqueueCharacterEvidence = vi.fn().mockResolvedValue("evidence-job");
  const markEnqueued = vi.fn().mockResolvedValue(undefined);
  const cachedKills: readonly StoredCharacterMythicKill[] = [
    {
      id: "10000000-0000-4000-8000-000000000011",
      raidId: "42",
      raidName: "Nerub-ar Palace",
      bossId: "1234",
      bossName: "Queen Ansurek",
      journalBossId: null,
      bossOrder: 8,
      isFinalBoss: false,
      killedAt: "2024-10-01T20:00:00.000Z",
      reportUrl: "https://www.warcraftlogs.com/reports/example",
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=9",
      guild: { name: "Example Guild", realm: "silvermoon" },
      historicWorldRank: null,
      performance: {
        damage: { state: "unavailable" },
        healing: { state: "unavailable" },
        bossDamage: { state: "unavailable" }
      }
    }
  ];
  const repositories = {
    snapshots: {
      getCurrent: vi
        .fn()
        .mockResolvedValue(
          "snapshot" in options ? options.snapshot : storedSnapshot()
        ),
      getCurrentContainingCharacter: vi
        .fn()
        .mockResolvedValue(
          "containingSnapshot" in options ? options.containingSnapshot : null
        ),
      create: vi.fn(),
      createAndFinishFingerprintSweep: vi.fn(),
      find: vi.fn(),
      listHistory: vi.fn()
    },
    manualConnections: {
      add: vi.fn().mockResolvedValue("added"),
      list: vi.fn().mockResolvedValue([]),
      setExcluded: vi.fn().mockResolvedValue("updated"),
      remove: vi.fn().mockResolvedValue("removed")
    },
    runs: { create: runsCreate },
    evidence: {
      reserve: vi.fn().mockImplementation(async ({ key }) => ({
        kind: options.gatheringCharacter === key ? "active" : "fresh",
        run: {
          id: "10000000-0000-4000-8000-000000000012",
          key,
          queueJobId: "evidence-job",
          status: options.evidenceStatus ?? "complete",
          attempt: 1,
          limitationCode:
            options.evidenceLimitationCode ??
            (options.evidenceStatus === "partial" ? "request_cap" : null),
          parseLimitationCode: options.evidenceParseLimitationCode ?? null,
          errorCode: null,
          createdAt: new Date("2026-09-11T12:00:00.000Z"),
          startedAt: new Date("2026-09-11T12:00:00.000Z"),
          completedAt: new Date()
        },
        completed: {
          run: {
            id: "10000000-0000-4000-8000-000000000012",
            key,
            queueJobId: "evidence-job",
            status: options.evidenceStatus ?? "complete",
            attempt: 1,
            limitationCode:
              options.evidenceLimitationCode ??
              (options.evidenceStatus === "partial" ? "request_cap" : null),
            parseLimitationCode: options.evidenceParseLimitationCode ?? null,
            errorCode: null,
            createdAt: new Date("2026-09-11T12:00:00.000Z"),
            startedAt: new Date("2026-09-11T12:00:00.000Z"),
            completedAt: new Date()
          },
          kills: [
            ...(options.includeCachedKills === false ? [] : cachedKills),
            ...(options.additionalKills ?? [])
          ],
          wipes: options.wipes ?? [],
          wipeCapable: options.wipeCapable ?? true
        }
      })),
      markEnqueued
    }
  } as unknown as Repositories;
  const search = {
    create: vi.fn().mockResolvedValue({
      kind: "character",
      character: { character: { name: "Ryii" } }
    })
  } as unknown as Pick<SearchService, "create">;
  const warcraftLogs = {
    getFirstKillReports: vi.fn().mockResolvedValue({
      kind: "evidence",
      kills: [
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "1234",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          isFinalBoss: false,
          killedAt: "2024-10-01T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/example",
          fightUrl: "https://www.warcraftlogs.com/reports/example#fight=9",
          guild: { name: "Example Guild", realm: "silvermoon" },
          historicWorldRank: null
        }
      ]
    })
  } as unknown as Pick<WarcraftLogsGateway, "getFirstKillReports">;
  const blizzard = {
    getCompletedAchievements: vi.fn().mockResolvedValue([
      {
        achievementId: "40254",
        completedAt: "2025-01-14T20:30:00.000Z"
      }
    ])
  } as unknown as Pick<BlizzardGateway, "getCompletedAchievements">;
  const raiderio = {
    getCharacter: vi.fn().mockResolvedValue({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      ownerId: null,
      profileGuess: null,
      declaredMain: null,
      guild: null,
      isTournamentProfile: false
    }),
    getMythicBossRankings: vi.fn().mockResolvedValue({
      kind: "rankings",
      rows: [
        {
          rank: 2,
          guildName: "Example Guild",
          guildRealm: "silvermoon",
          guildRegion: "eu",
          firstDefeated: "2024-10-01T20:00:00.000Z"
        }
      ]
    })
  } as unknown as Pick<
    RaiderIoGateway,
    "getMythicBossRankings" | "getCharacter"
  >;
  const config = applicationConfigSchema.parse({
    BOT_API_KEY: "b".repeat(32),
    RATE_LIMIT_HASH_SECRET: "r".repeat(32),
    ...(options.characterCap === undefined
      ? {}
      : { DOSSIER_CHARACTER_CAP: options.characterCap }),
    ...(options.warcraftLogsRequestCap === undefined
      ? {}
      : { DOSSIER_WARCRAFT_LOGS_REQUEST_CAP: options.warcraftLogsRequestCap }),
    ...(options.providerConcurrency === undefined
      ? {}
      : { DOSSIER_PROVIDER_CONCURRENCY: options.providerConcurrency })
  });
  const dossiers = createApplicantDossierService({
    repositories,
    search,
    queue: { enqueueCharacterEvidence },
    blizzard,
    raiderio,
    config,
    evidenceJobCredentialEncryptionKey: encryptionKey
  });
  return {
    dossiers,
    repositories,
    runsCreate,
    enqueueCharacterEvidence,
    markEnqueued,
    search,
    warcraftLogs,
    blizzard,
    raiderio
  };
}

function raidWithKill(firstKill: Record<string, unknown>) {
  return expect.objectContaining({
    raidId: "1273",
    bosses: expect.arrayContaining([
      expect.objectContaining({
        state: "kill",
        firstKill: expect.objectContaining(firstKill)
      })
    ])
  });
}

describe("applicant dossier service", () => {
  it("maps fresh cached wipes and complete scans into aggregate boss states", async () => {
    // Break caught: a durable wipe could be discarded at the application
    // boundary, or a partial scan could be misrepresented as no logs.
    const wipe: StoredCharacterMythicWipe = {
      id: "10000000-0000-4000-8000-000000000030",
      raidId: "42",
      raidName: "Nerub-ar Palace",
      bossId: "2599",
      bossName: "Sikran",
      journalBossId: "2599",
      bossOrder: 5,
      attemptedAt: "2024-09-01T20:00:00.000Z",
      reportUrl: "https://www.warcraftlogs.com/reports/wipe",
      fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=5"
    };
    const complete = await fixture({
      includeCachedKills: false,
      wipes: [wipe]
    }).dossiers.read(root);
    if (complete.kind !== "ready") throw new Error("dossier_not_ready");
    const nerubar = complete.dossier.raids.find(
      (raid) => raid.raidName === "Nerub-ar Palace"
    )!;
    expect(
      nerubar.bosses.find(
        (boss) => boss.bossName === "Sikran, Captain of the Sureki"
      )
    ).toMatchObject({
      state: "wipe",
      wipe: { characters: [root, alt] }
    });
    expect(nerubar.bosses.find((boss) => boss.bossOrder === 1)).toMatchObject({
      state: "no_logs"
    });

    const partial = await fixture({
      includeCachedKills: false,
      evidenceStatus: "partial"
    }).dossiers.read(root);
    if (partial.kind !== "ready") throw new Error("dossier_not_ready");
    expect(partial.dossier.raids[0]?.bosses[0]).toMatchObject({
      state: "incomplete"
    });

    const legacy = await fixture({
      includeCachedKills: false,
      wipeCapable: false
    }).dossiers.read(root);
    if (legacy.kind !== "ready") throw new Error("dossier_not_ready");
    expect(legacy.dossier.raids[0]?.bosses[0]).toMatchObject({
      state: "incomplete"
    });
  });

  it("keeps parse-limited complete evidence eligible for no-log gaps", async () => {
    // Break caught: an incomplete Historical ranking query must not make a
    // complete wipe-capable encounter traversal appear incomplete.
    const result = await fixture({
      includeCachedKills: false,
      evidenceParseLimitationCode: "parse_request_cap"
    }).dossiers.read(root);
    if (result.kind !== "ready") throw new Error("dossier_not_ready");

    expect(result.dossier.raids[0]?.bosses[0]).toMatchObject({
      state: "no_logs"
    });
    expect(result.dossier.limitations).toContainEqual(
      expect.objectContaining({
        source: "warcraft_logs",
        character: root,
        code: "parse_request_cap"
      })
    );
  });

  it("withholds initial evidence for a tournament root before discovery finishes", async () => {
    const { dossiers, raiderio, warcraftLogs, blizzard } = fixture();
    vi.mocked(raiderio.getCharacter).mockResolvedValue({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      ownerId: null,
      profileGuess: null,
      declaredMain: null,
      guild: null,
      isTournamentProfile: true
    });
    await expect(dossiers.readInitial(root)).resolves.toEqual({
      kind: "not_ready"
    });
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
    expect(blizzard.getCompletedAchievements).not.toHaveBeenCalled();
  });

  it("withholds unchecked initial evidence when the eligibility lookup fails", async () => {
    const { dossiers, raiderio, warcraftLogs } = fixture();
    vi.mocked(raiderio.getCharacter).mockRejectedValue({ kind: "transient" });
    await expect(dossiers.readInitial(root)).resolves.toEqual({
      kind: "not_ready"
    });
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  });

  it("preserves cancellation during initial eligibility checking", async () => {
    const { dossiers, raiderio } = fixture();
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    vi.mocked(raiderio.getCharacter).mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(dossiers.readInitial(root, controller.signal)).rejects.toBe(
      reason
    );
  });

  it("lets an uncancelled reader finish a shared achievement request", async () => {
    const { dossiers, blizzard } = fixture();
    let finish!: () => void;
    vi.mocked(blizzard.getCompletedAchievements).mockImplementation(
      async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return [
          { achievementId: "40254", completedAt: "2025-01-14T20:30:00.000Z" }
        ];
      }
    );
    const controller = new AbortController();
    const first = dossiers.readInitial(root, controller.signal);
    const rejected = expect(first).rejects.toThrow();
    const second = dossiers.readInitial(root);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort();
    finish();
    await rejected;
    expect(await second).toMatchObject({
      dossier: { cuttingEdges: [{ achievementId: "40254" }] }
    });
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
  });
  it("reuses source evidence across concurrent reads but follows a replacement snapshot", async () => {
    const { dossiers, repositories, blizzard, raiderio } = fixture();
    const results = await Promise.all([
      dossiers.read(root),
      dossiers.read(root)
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);
    vi.mocked(repositories.snapshots.getCurrent).mockResolvedValue(
      storedSnapshot([storedSnapshot().characters[0]!])
    );
    const changed = await dossiers.read(root);
    expect(changed).toMatchObject({
      dossier: {
        characters: [{ key: root }],
        cuttingEdges: [{ achievementId: "40254" }]
      }
    });
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
  });

  it("refreshes boss rankings after fifteen minutes and never serves an expired rank on failure", async () => {
    vi.useFakeTimers();
    try {
      const { dossiers, raiderio } = fixture();
      await expect(dossiers.read(root)).resolves.toMatchObject({
        dossier: {
          raids: expect.arrayContaining([
            raidWithKill({ historicWorldRank: 2 })
          ])
        }
      });
      vi.mocked(raiderio.getMythicBossRankings).mockResolvedValue({
        kind: "rankings",
        rows: []
      });
      await dossiers.read(root);
      expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(15 * 60_000);
      await expect(dossiers.read(root)).resolves.toMatchObject({
        dossier: {
          raids: expect.arrayContaining([
            raidWithKill({ historicWorldRank: null })
          ]),
          limitations: []
        }
      });
      expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(2);
      vi.mocked(raiderio.getMythicBossRankings).mockResolvedValue({
        kind: "limitation",
        code: "unavailable"
      });
      vi.advanceTimersByTime(15 * 60_000);
      await expect(dossiers.read(root)).resolves.toMatchObject({
        dossier: {
          limitations: [
            expect.objectContaining({ source: "raiderio", code: "unavailable" })
          ]
        }
      });
      expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires achievements and reports a failed refresh without stale Cutting Edge claims", async () => {
    vi.useFakeTimers();
    try {
      const { dossiers, blizzard } = fixture();
      await dossiers.read(root);
      await dossiers.read(root);
      expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(15 * 60_000);
      vi.mocked(blizzard.getCompletedAchievements).mockRejectedValue(
        new Error("offline")
      );
      const expired = await dossiers.read(root);
      expect(expired).toMatchObject({
        dossier: {
          cuttingEdges: [],
          limitations: [
            { source: "blizzard", character: root, code: "unavailable" },
            { source: "blizzard", character: alt, code: "unavailable" }
          ]
        }
      });
      expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    raiderUrl,
    "https://www.warcraftlogs.com/character/eu/silvermoon/ryii"
  ])(
    "starts discovery with the canonical Raider.IO identity for %s",
    async (characterUrl) => {
      // Break caught: a valid Warcraft Logs identity could start a divergent or invalid discovery run.
      const { dossiers, search } = fixture();

      await expect(
        dossiers.start({ characterUrl, headers })
      ).resolves.toMatchObject({
        kind: "character"
      });
      expect(search.create).toHaveBeenCalledWith({
        characterUrl: raiderUrl,
        headers
      });
    }
  );

  it("threads the request scope through to search.create so start's own database work is measured", async () => {
    // Break caught: start and addConnectedCharacter do real database and
    // queue work through search.create, so discarding the scope here would
    // leave dossier_start with a durationMs but no dbMs at all -- exactly
    // the endpoint the research doc measures as "submission to first response".
    const config = applicationConfigSchema.parse({
      BOT_API_KEY: "b".repeat(32),
      RATE_LIMIT_HASH_SECRET: "r".repeat(32)
    });
    const searchRepositories = {
      searchReservations: {
        async reserve() {
          return {
            kind: "reserved" as const,
            run: {
              id: "00000000-0000-4000-8000-000000000050",
              rootKey: root,
              rootCharacterId: null,
              queueJobId: null,
              status: "queued" as const,
              callerClass: "public" as const,
              attempt: 0,
              nextRetryAt: null,
              errorCode: null,
              createdAt: new Date(),
              startedAt: null,
              completedAt: null,
              snapshotId: null
            }
          };
        },
        async cancel() {},
        async listPending() {
          return [];
        },
        async markEnqueued() {}
      },
      snapshots: {
        async getCurrent() {
          return null;
        },
        async find() {
          return null;
        },
        async listHistory() {
          return { items: [], nextCursor: null };
        },
        async create() {
          throw new Error("not used");
        },
        async createAndFinishFingerprintSweep() {
          throw new Error("not used");
        }
      },
      manualConnections: {
        async add() {
          return "added" as const;
        },
        async list() {
          return [];
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
        async find() {
          return null;
        },
        async findActive() {
          return null;
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
        async put() {},
        async putAndFailRun() {},
        async find() {
          return null;
        },
        async cleanupExpired() {
          return 0;
        }
      },
      evidence: {
        async reserve() {
          throw new Error("not used");
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
        async publish() {
          throw new Error("not used");
        },
        async fail() {
          throw new Error("not used");
        },
        async getCompleted() {
          return null;
        },
        async listStatus() {
          return [];
        }
      },
      fingerprintSweeps: {
        async requestAdmission() {
          return { kind: "not_due" as const };
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
          return { kind: "settled" as const };
        },
        async cleanupExpired() {
          return 0;
        }
      }
    } as unknown as Repositories;
    const queue: Pick<DiscoveryQueue, "enqueue"> = {
      async enqueue() {
        return "job-1";
      }
    };
    const search = createSearchService({
      repositories: searchRepositories,
      queue,
      config
    });
    const dossiers = createApplicantDossierService({
      repositories: {
        snapshots: {},
        evidence: {},
        manualConnections: {}
      } as unknown as Pick<
        Repositories,
        "snapshots" | "evidence" | "manualConnections"
      >,
      search,
      queue: { enqueueCharacterEvidence: vi.fn() },
      blizzard: {
        getCompletedAchievements: vi.fn()
      } as unknown as Pick<BlizzardGateway, "getCompletedAchievements">,
      raiderio: {
        getMythicBossRankings: vi.fn(),
        getCharacter: vi.fn()
      } as unknown as Pick<
        RaiderIoGateway,
        "getMythicBossRankings" | "getCharacter"
      >,
      config,
      evidenceJobCredentialEncryptionKey: encryptionKey
    });
    const scope = createMeasurementScope();

    const result = await dossiers.start(
      { characterUrl: raiderUrl, headers },
      scope
    );

    expect(result).toMatchObject({ kind: "job" });
    expect(scope.totals().dbCalls).toBeGreaterThan(0);
  });

  it("measures the read path's database work and keeps the buckets disjoint", async () => {
    // Break caught: read and readInitial passed options.repositories in raw, so
    // the dossier endpoint -- the heaviest database path in the system, and the
    // one the design's "database or queue?" question is about -- could never
    // report dbMs, dbCalls or dbMaxCallMs at all.
    const { dossiers } = fixture();
    // Every clock read advances, so nesting would double count and break the
    // inequality rather than silently reading as zero.
    let tick = 0;
    const monotonic = () => tick++;
    const scope = createMeasurementScope(monotonic);

    const startedAt = monotonic();
    const result = await dossiers.read(root, undefined, undefined, scope);
    const durationMs = monotonic() - startedAt;

    expect(result.kind).toBe("ready");
    const totals = scope.totals();
    expect(totals.dbCalls).toBeGreaterThan(0);
    expect(totals.dbMs).toBeGreaterThan(0);
    expect(totals.dbMaxCallMs).toBeGreaterThan(0);

    // Provider timing sits inside the bounded-cache loaders, which do no
    // database work, so every measured bucket is a disjoint slice of the call.
    const bucketMs = Object.entries(totals)
      .filter(
        ([field, value]) =>
          typeof value === "number" &&
          field.endsWith("Ms") &&
          !field.endsWith("MaxCallMs") &&
          field !== "limiterWaitMs"
      )
      .reduce((total, [, value]) => total + (value as number), 0);
    expect(bucketMs).toBeLessThanOrEqual(durationMs);
  });

  it("measures the readInitial path's database work", async () => {
    const { dossiers } = fixture();
    const scope = createMeasurementScope();

    await dossiers.readInitial(root, undefined, undefined, scope);

    expect(scope.totals().dbCalls).toBeGreaterThan(0);
  });

  it("threads the request scope through addConnectedCharacter's call to search.create", async () => {
    const { dossiers, search } = fixture();
    const scope = createMeasurementScope();

    await dossiers.addConnectedCharacter(
      root,
      {
        characterUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
        headers
      },
      scope
    );

    expect(search.create).toHaveBeenCalledWith(
      expect.objectContaining({
        characterUrl: "https://raider.io/characters/eu/silvermoon/ryalts"
      }),
      scope
    );
  });

  it("returns the existing active discovery result without creating another run", async () => {
    // Break caught: an in-flight search could be replaced instead of reused by dossier start.
    const { dossiers, search, runsCreate } = fixture();
    const active = {
      kind: "job",
      jobId: "00000000-0000-4000-8000-000000000010",
      status: "running",
      statusUrl: "/api/v1/searches/00000000-0000-4000-8000-000000000010",
      characterUrl: "/characters/eu/silvermoon/ryii",
      staleCharacter: null,
      joinedExistingRun: true
    } as const;
    vi.mocked(search.create).mockResolvedValue(active);

    await expect(
      dossiers.start({ characterUrl: raiderUrl, headers })
    ).resolves.toBe(active);
    expect(search.create).toHaveBeenCalledTimes(1);
    expect(runsCreate).not.toHaveBeenCalled();
  });

  it("assembles current snapshot evidence from the durable cache without calling Warcraft Logs", async () => {
    // Break caught: evidence reads could persist a dossier or lose the Warcraft Logs link matching a boss and timestamp.
    const { dossiers, repositories, runsCreate, warcraftLogs } = fixture();

    const result = await dossiers.read(root);

    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        characters: [
          {
            displayName: "Ryii",
            className: "Mage",
            raiderIoUrl: raiderUrl,
            source: "raiderio_declared"
          },
          {
            displayName: "Ryalts",
            className: "Priest",
            raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
            source: "fingerprint_derived"
          }
        ],
        raids: expect.arrayContaining([
          raidWithKill({
            reportUrl: "https://www.warcraftlogs.com/reports/example#fight=9",
            historicWorldRank: 2
          })
        ]),
        cuttingEdges: [{ achievementId: "40254" }],
        research: {
          state: "complete",
          message: "Linked-character research is complete."
        }
      }
    });
    expect(repositories.snapshots.create).not.toHaveBeenCalled();
    expect(runsCreate).not.toHaveBeenCalled();
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  });

  it("identifies each character whose evidence is still gathering", async () => {
    const result = await fixture({ gatheringCharacter: alt }).dossiers.read(
      root
    );

    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        characters: [
          { key: root, researchState: "complete" },
          { key: alt, researchState: "gathering" }
        ]
      }
    });
  });

  it("shares a guild raid lookup across bosses without mixing their ranks", async () => {
    const { dossiers, raiderio } = fixture({
      additionalKills: [
        {
          id: "10000000-0000-4000-8000-000000000021",
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "5678",
          bossName: "The Silken Court",
          journalBossId: null,
          bossOrder: 7,
          isFinalBoss: false,
          killedAt: "2024-10-01T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/court",
          fightUrl: "https://www.warcraftlogs.com/reports/court#fight=1",
          guild: { name: "Example Guild", realm: "silvermoon" },
          historicWorldRank: null,
          performance: {
            damage: { state: "unavailable" },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        },
        {
          id: "10000000-0000-4000-8000-000000000022",
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "9012",
          bossName: "Ulgrax the Devourer",
          journalBossId: null,
          bossOrder: 1,
          isFinalBoss: false,
          killedAt: "2024-10-01T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/ulgrax",
          fightUrl: "https://www.warcraftlogs.com/reports/ulgrax#fight=1",
          guild: { name: "Other Guild", realm: "silvermoon" },
          historicWorldRank: null,
          performance: {
            damage: { state: "unavailable" },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        }
      ]
    });
    vi.mocked(raiderio.getMythicBossRankings).mockImplementation(
      async (request) => ({
        kind: "rankings",
        rows: (request.guild?.name === "Other Guild"
          ? [{ bossSlug: "ulgrax-the-devourer", rank: 741 }]
          : [
              { bossSlug: "queen-ansurek", rank: 371 },
              { bossSlug: "the-silken-court", rank: 412 }
            ]
        ).map((row) => ({
          ...row,
          guildName: request.guild!.name,
          guildRealm: "silvermoon",
          guildRegion: "eu",
          firstDefeated: "2024-10-01T20:00:00.000Z"
        }))
      })
    );
    const result = await dossiers.read(root);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected dossier");
    expect(
      result.dossier.raids
        .flatMap((raid) => raid.bosses)
        .filter((boss) => boss.state === "kill")
        .map((boss) => boss.firstKill.historicWorldRank)
        .sort()
    ).toEqual([371, 412, 741]);
    await dossiers.read(root);
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(2);
  });

  it("only enriches a kill with a unique Raider.IO guild, region, realm, and time match", async () => {
    const { dossiers, raiderio } = fixture();
    vi.mocked(raiderio.getMythicBossRankings).mockResolvedValue({
      kind: "rankings",
      rows: [
        {
          rank: 2,
          guildName: "Example Guild",
          guildRealm: "connected-silvermoon",
          guildRegion: "eu",
          firstDefeated: "2024-10-01T20:01:59.000Z"
        },
        {
          rank: 3,
          guildName: "Example Guild",
          guildRealm: "silvermoon",
          guildRegion: "us",
          firstDefeated: "2024-10-01T20:00:00.000Z"
        }
      ]
    });

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        raids: expect.arrayContaining([raidWithKill({ historicWorldRank: 2 })])
      }
    });
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledWith(
      {
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek",
        guild: { name: "Example Guild", realm: "silvermoon", region: "eu" }
      },
      expect.any(AbortSignal)
    );
  });

  it.each([
    { bossSlug: "other-boss" },
    { guildName: "Other Guild" },
    { guildRealm: "draenor" },
    { guildRegion: "us" },
    { firstDefeated: "2024-09-24T20:00:00.000Z" }
  ])(
    "leaves unrelated guilds and later player kills unranked: %j",
    async (change) => {
      const { dossiers, raiderio } = fixture();
      vi.mocked(raiderio.getMythicBossRankings).mockResolvedValue({
        kind: "rankings",
        rows: [
          {
            rank: 2,
            guildName: "Example Guild",
            guildRealm: "silvermoon",
            guildRegion: "eu",
            firstDefeated: "2024-10-01T20:00:00.000Z",
            ...change
          }
        ]
      });
      await expect(dossiers.read(root)).resolves.toMatchObject({
        kind: "ready",
        dossier: {
          raids: expect.arrayContaining([
            raidWithKill({ historicWorldRank: null })
          ]),
          limitations: []
        }
      });
    }
  );

  it.each([
    "schema_drift",
    "rate_limited",
    "unavailable",
    "not_found",
    "private"
  ] as const)(
    "exposes ranking %s separately from successful unmatched evidence and retries failures",
    async (code) => {
      const { dossiers, raiderio } = fixture();
      vi.mocked(raiderio.getMythicBossRankings).mockResolvedValue({
        kind: "limitation",
        code,
        ...(code === "rate_limited" ? { retryAfterMs: 90_000 } : {})
      });
      await expect(dossiers.read(root)).resolves.toMatchObject({
        kind: "ready",
        dossier: {
          raids: expect.arrayContaining([
            raidWithKill({ historicWorldRank: null })
          ]),
          limitations: [
            expect.objectContaining({
              source: "raiderio",
              code: code === "schema_drift" ? "schema_changed" : code,
              message: expect.stringContaining("boss world ranks"),
              ...(code === "rate_limited"
                ? { retryAt: expect.any(String) }
                : {})
            })
          ]
        }
      });
      await dossiers.read(root);
      expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    "parse_private",
    "parse_rate_limited",
    "parse_request_cap",
    "parse_unavailable",
    "parse_schema_drift"
  ] as const)(
    "describes Warcraft Logs %s as missing parse availability, not kill history",
    async (code) => {
      const { dossiers } = fixture({ evidenceLimitationCode: code });

      const result = await dossiers.read(root);
      if (result.kind !== "ready") throw new Error("Expected dossier");
      const limitation = result.dossier.limitations.find(
        (item) =>
          item.source === "warcraft_logs" &&
          item.character !== null &&
          item.character.name === root.name
      );
      expect(limitation).toEqual(
        expect.objectContaining({
          code,
          message: expect.stringMatching(/parse/i)
        })
      );
      expect(limitation!.message).not.toContain("history is incomplete");
    }
  );

  it("leaves the rank unknown when multiple leaderboard rows match the same kill", async () => {
    const { dossiers, raiderio } = fixture();
    vi.mocked(raiderio.getMythicBossRankings).mockResolvedValue({
      kind: "rankings",
      rows: [
        {
          rank: 2,
          guildName: "Example Guild",
          guildRealm: "silvermoon",
          guildRegion: "eu",
          firstDefeated: "2024-10-01T20:00:00.000Z"
        },
        {
          rank: 3,
          guildName: "Example Guild",
          guildRealm: "silvermoon",
          guildRegion: "eu",
          firstDefeated: "2024-10-01T20:01:00.000Z"
        }
      ]
    });

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        raids: expect.arrayContaining([
          raidWithKill({ historicWorldRank: null })
        ])
      }
    });
  });

  it("retains Warcraft Logs evidence when Blizzard achievement data is unavailable", async () => {
    const { dossiers, blizzard } = fixture();
    vi.mocked(blizzard.getCompletedAchievements).mockRejectedValueOnce(
      Object.assign(new Error("blizzard_transient"), { kind: "transient" })
    );

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        raids: expect.arrayContaining([
          expect.objectContaining({ raidId: "1273" })
        ]),
        limitations: [
          { source: "blizzard", character: root, code: "unavailable" }
        ]
      }
    });
  });

  it("marks malformed Blizzard achievement data as a schema limitation", async () => {
    const { dossiers, blizzard } = fixture();
    vi.mocked(blizzard.getCompletedAchievements).mockRejectedValueOnce(
      Object.assign(new Error("blizzard_schema_drift"), {
        kind: "schema_drift"
      })
    );

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        limitations: [
          { source: "blizzard", character: root, code: "schema_changed" }
        ]
      }
    });
  });

  it("returns not_ready without contacting evidence sources when no snapshot exists", async () => {
    // Break caught: a missing discovery result could trigger unbounded third-party requests.
    const { dossiers, warcraftLogs } = fixture({ snapshot: null });

    await expect(dossiers.read(root)).resolves.toEqual({ kind: "not_ready" });
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  });

  it("reads the current snapshot containing a linked character", async () => {
    const snapshot = storedSnapshot();
    const { dossiers, repositories } = fixture({
      snapshot: null,
      containingSnapshot: snapshot
    });

    const result = await dossiers.read(alt);
    expect(result).toMatchObject({ kind: "ready", dossier: { root } });
    expect(result.kind === "ready" ? result.dossier.characters : []).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: alt })])
    );
    expect(repositories.snapshots.getCurrent).toHaveBeenCalledWith(alt);
    expect(
      repositories.snapshots.getCurrentContainingCharacter
    ).toHaveBeenCalledWith(alt);
    expect(repositories.manualConnections.list).toHaveBeenCalledWith(root);
  });

  it("reads cached root-only evidence without contacting snapshot repositories", async () => {
    // Break caught: initial dossier reads could bypass the durable cache and re-query Warcraft Logs.
    const { dossiers, repositories, runsCreate, warcraftLogs } = fixture();

    await expect(dossiers.readInitial(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        root,
        characters: [
          {
            key: root,
            displayName: "Ryii",
            source: "submitted"
          }
        ],
        raids: expect.arrayContaining([
          raidWithKill({
            reportUrl: "https://www.warcraftlogs.com/reports/example#fight=9"
          })
        ]),
        research: {
          state: "initial",
          message:
            "Linked-character research is still running; this evidence covers only the submitted character."
        }
      }
    });

    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
    expect(repositories.evidence.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ key: root })
    );
    expect(repositories.snapshots.getCurrent).not.toHaveBeenCalled();
    expect(repositories.snapshots.create).not.toHaveBeenCalled();
    expect(runsCreate).not.toHaveBeenCalled();
  });

  it("marks a capped fingerprint snapshot as non-exhaustive", async () => {
    // Break caught: bounded linked-character discovery could be presented as complete.
    const snapshot = storedSnapshot();
    snapshot.state = "partial";
    snapshot.limitationCode = "fingerprint_sweep_capped";
    const { dossiers } = fixture({ snapshot });

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        research: {
          state: "partial",
          message:
            "Additional linked characters may exist; this dossier is not exhaustive."
        }
      }
    });
  });

  it("keeps participant-attributed Warcraft Logs evidence when Raider.IO is limited", async () => {
    // Break caught: Raider.IO does not publish historical per-character kill
    // records. A temporary Raider.IO limitation must not discard a public,
    // participant-attributed Warcraft Logs kill.
    const { dossiers } = fixture();

    const result = await dossiers.read(root);

    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        raids: expect.arrayContaining([
          raidWithKill({
            reportUrl: "https://www.warcraftlogs.com/reports/example#fight=9"
          })
        ]),
        limitations: []
      }
    });
  });

  it.each(["claimed", "fingerprint"] as const)(
    "prioritises the root and higher levels before capping %s characters",
    async (source) => {
      // Break caught: stored order or source priority could spend the cap on a low-level alt.
      const [submitted, linked] = storedSnapshot().characters;
      const low = {
        ...linked!,
        level: 10,
        source:
          source === "claimed" ? ("fingerprint" as const) : ("claimed" as const)
      };
      const high = {
        ...linked!,
        key: third,
        displayName: "Third",
        level: 100,
        source
      };
      const input = { ...submitted!, level: 1 };
      const snapshot = storedSnapshot([low, high, input]);
      const original = structuredClone(snapshot);
      const { dossiers, repositories, blizzard } = fixture({
        snapshot,
        characterCap: 2
      });

      const result = await dossiers.read(root);

      expect(result).toMatchObject({
        kind: "ready",
        dossier: {
          characters: [{ key: root }, { key: third }],
          limitations: [{ character: alt, code: "request_cap" }]
        }
      });
      expect(
        vi
          .mocked(repositories.evidence.reserve)
          .mock.calls.map(([{ key }]) => key)
      ).toEqual([root, third]);
      expect(
        vi
          .mocked(blizzard.getCompletedAchievements)
          .mock.calls.map(([key]) => key)
      ).toEqual(source === "fingerprint" ? [root] : [root, third]);
      expect(snapshot).toEqual(original);
    }
  );

  it("orders equal-level characters by region, realm, then name regardless of stored order", async () => {
    // Break caught: unstable or partial tie-breaking changes which characters get evidence under a cap.
    const [submitted, linked] = storedSnapshot().characters;
    const keys = [
      { region: "us", realm: "aegwynn", name: "aaa" },
      { region: "eu", realm: "silvermoon", name: "zzz" },
      { region: "eu", realm: "silvermoon", name: "aaa" },
      { region: "eu", realm: "aegwynn", name: "zzz" }
    ] as const;
    const characters = keys.map((key) => ({ ...linked!, key }));
    for (const ordered of [characters, [...characters].reverse()]) {
      const { dossiers } = fixture({
        snapshot: storedSnapshot([...ordered, submitted!])
      });
      const result = await dossiers.read(root);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("Expected a ready dossier");
      expect(result.dossier.characters.map(({ key }) => key)).toEqual([
        root,
        keys[3],
        keys[2],
        keys[1],
        keys[0]
      ]);
    }
  });

  it("reports every evidence stream skipped by the character cap", async () => {
    // Break caught: a cap could silently omit evidence.
    const { dossiers, repositories, warcraftLogs } = fixture({
      characterCap: 1,
      snapshot: storedSnapshot([
        {
          characterId: "10000000-0000-4000-8000-000000000003",
          key: alt,
          displayName: "Ryalts",
          className: "Priest",
          level: 80,
          guild: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/ryalts",
          source: "fingerprint",
          displayOrder: 7
        },
        {
          characterId: "10000000-0000-4000-8000-000000000004",
          key: third,
          displayName: "Third",
          className: "Warrior",
          level: 80,
          guild: null,
          raiderIoUrl: "https://raider.io/characters/eu/silvermoon/third",
          source: "claimed",
          displayOrder: 0
        }
      ])
    });

    const result = await dossiers.read(root);

    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
    expect(repositories.evidence.reserve).toHaveBeenCalledTimes(1);
    expect(repositories.evidence.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ key: alt })
    );
    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        characters: [{ displayName: "Ryalts" }],
        limitations: [
          {
            source: "warcraft_logs",
            character: third,
            code: "request_cap"
          }
        ]
      }
    });
  });

  it("reads each selected character from its own durable evidence cache", async () => {
    // Break caught: a cached dossier could omit an alt's evidence stream or return to direct Warcraft Logs reads.
    const { dossiers, repositories, warcraftLogs } = fixture({
      warcraftLogsRequestCap: 6
    });

    await dossiers.read(root);

    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
    expect(repositories.evidence.reserve).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: root })
    );
    expect(repositories.evidence.reserve).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: alt })
    );
  });

  it("attributes provider time per operation on readInitial", async () => {
    const scope = createMeasurementScope(
      (() => {
        let index = 0;
        const steps = [0, 12, 12, 12];
        return () => steps[Math.min(index++, steps.length - 1)]!;
      })()
    );
    const { dossiers, raiderio } = fixture();
    vi.mocked(raiderio.getCharacter).mockResolvedValue({
      key: root,
      displayName: "Ryii",
      className: "Mage",
      level: 80,
      ownerId: null,
      profileGuess: null,
      declaredMain: null,
      guild: null,
      isTournamentProfile: false
    });

    await dossiers.readInitial(root, undefined, undefined, scope);

    expect(scope.totals()).toMatchObject({
      raiderIoCharacterMs: 12,
      raiderIoCharacterCalls: 1
    });
  });

  it("attributes limiter admission wait only to the request that actually queued", async () => {
    // Break caught: a limiter onWait broadcast to every registered scope
    // instead of the call that actually waited (a metric that misleads is
    // worse than no metric). The limiter's own clock (performance.now,
    // uninjectable through the service's public options) is stubbed so the
    // wait attributed to the queued call is a deterministic, specific value
    // rather than merely "some positive number".
    let clock = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const scopeA = createMeasurementScope(() => clock);
      const scopeB = createMeasurementScope(() => clock);
      const { dossiers, raiderio } = fixture({ providerConcurrency: 1 });

      let releaseFirst!: () => void;
      let firstStarted = false;
      vi.mocked(raiderio.getMythicBossRankings).mockImplementation(async () => {
        firstStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return {
          kind: "rankings",
          rows: [
            {
              rank: 2,
              guildName: "Example Guild",
              guildRealm: "silvermoon",
              guildRegion: "eu",
              firstDefeated: "2024-10-01T20:00:00.000Z"
            }
          ]
        };
      });

      const first = dossiers.read(root, undefined, undefined, scopeA);
      await vi.waitFor(() => expect(firstStarted).toBe(true));
      const second = dossiers.read(root, undefined, undefined, scopeB);
      // Let the second call's own microtasks run far enough to reach and
      // queue behind the first call's admitted (but still blocked) request.
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock = 40;
      releaseFirst();
      await Promise.all([first, second]);

      expect(scopeA.totals().limiterWaitMs).toBe(0);
      expect(scopeB.totals().limiterWaitMs).toBe(40);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("attributes cache outcomes to the request that actually observed them", async () => {
    // Break caught: a broadcast cache observer would credit every active
    // scope with every outcome instead of the call that actually produced it.
    const scopeA = createMeasurementScope(() => 0);
    const scopeB = createMeasurementScope(() => 0);
    const { dossiers } = fixture();

    await dossiers.readInitial(root, undefined, undefined, scopeA);
    await dossiers.readInitial(root, undefined, undefined, scopeB);

    expect(scopeA.totals().cacheMisses).toBeGreaterThan(0);
    expect(scopeA.totals().cacheHits).toBeUndefined();
    expect(scopeB.totals().cacheHits).toBeGreaterThan(0);
    expect(scopeB.totals().cacheMisses).toBeUndefined();
  });

  it("behaves identically when no scope is supplied", async () => {
    const { dossiers } = fixture();
    await expect(dossiers.read(root)).resolves.toBeDefined();
  });

  it("encrypts supplied Warcraft Logs credentials into every evidence reservation", async () => {
    // Break caught: a visitor's Warcraft Logs secret could reach the durable
    // evidence run in plain text, or never reach the worker at all.
    const { dossiers, repositories } = fixture();

    await dossiers.read(root, undefined, {
      wclCredentials: {
        clientId: "user-client-id",
        clientSecret: "user-secret"
      }
    });

    const credentials = vi
      .mocked(repositories.evidence.reserve)
      .mock.calls.map(([input]) => input.credentials!);
    expect(credentials).toHaveLength(2);
    for (const pair of credentials) {
      expect(pair.wclClientIdEncrypted).not.toBe("user-client-id");
      expect(pair.wclClientSecretEncrypted).not.toBe("user-secret");
      expect(decryptCredential(pair.wclClientIdEncrypted, encryptionKey)).toBe(
        "user-client-id"
      );
      expect(
        decryptCredential(pair.wclClientSecretEncrypted, encryptionKey)
      ).toBe("user-secret");
    }
  });

  it("keeps supplied credentials out of every measured total", async () => {
    // Break caught: threading a measurement scope alongside the credential
    // overrides could fold a key into the record the boundary emits. Totals
    // are numbers, or a static method identifier, by construction; this
    // proves the construction holds on the path that carries a visitor's
    // secret.
    const scope = createMeasurementScope(() => 0);
    const { dossiers } = fixture();

    await dossiers.read(
      root,
      undefined,
      {
        wclCredentials: {
          clientId: "user-client-id",
          clientSecret: "user-secret"
        }
      },
      scope
    );

    const totals = scope.totals();
    expect(Object.keys(totals).length).toBeGreaterThan(0);
    for (const [field, value] of Object.entries(totals)) {
      // `dbMaxCallName` is the one total that is not numeric. It is asserted
      // against the `group.method` shape rather than exempted, so a value
      // built from anything a caller supplied would fail here too.
      if (field === "dbMaxCallName") {
        expect(value).toMatch(/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/);
        continue;
      }
      expect(typeof value).toBe("number");
    }
    expect(JSON.stringify(totals)).not.toContain("user-client-id");
    expect(JSON.stringify(totals)).not.toContain("user-secret");
  });

  it("reserves evidence without credentials when the visitor supplies none", async () => {
    const { dossiers, repositories } = fixture();

    await dossiers.read(root);

    expect(
      vi.mocked(repositories.evidence.reserve).mock.calls[0]![0].credentials
    ).toBeNull();
  });

  it("serves supplied gateways without reading or writing the shared caches", async () => {
    // Break caught: results fetched under one visitor's own API keys could be
    // cached and served to every other visitor, or could be answered from a
    // cache those keys never populated.
    const { dossiers, blizzard, raiderio } = fixture();
    await dossiers.read(root);
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);

    const overrides = {
      blizzard: {
        getCompletedAchievements: vi
          .fn()
          .mockResolvedValue([
            { achievementId: "41297", completedAt: "2025-03-01T20:30:00.000Z" }
          ])
      },
      raiderio: {
        getCharacter: vi.fn(),
        getMythicBossRankings: vi.fn().mockResolvedValue({
          kind: "rankings",
          rows: [
            {
              rank: 99,
              guildName: "Example Guild",
              guildRealm: "silvermoon",
              guildRegion: "eu",
              firstDefeated: "2024-10-01T20:00:00.000Z"
            }
          ]
        })
      }
    };

    await expect(
      dossiers.read(root, undefined, overrides)
    ).resolves.toMatchObject({
      dossier: {
        cuttingEdges: [{ achievementId: "41297" }],
        raids: expect.arrayContaining([raidWithKill({ historicWorldRank: 99 })])
      }
    });
    expect(overrides.blizzard.getCompletedAchievements).toHaveBeenCalledTimes(
      1
    );
    expect(overrides.raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);

    // The shared caches still hold only the constructor gateways' results.
    await expect(dossiers.read(root)).resolves.toMatchObject({
      dossier: {
        cuttingEdges: [{ achievementId: "40254" }],
        raids: expect.arrayContaining([raidWithKill({ historicWorldRank: 2 })])
      }
    });
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);
  });

  it("checks initial eligibility with a supplied Raider.IO gateway", async () => {
    const { dossiers, raiderio } = fixture();
    const override = {
      getCharacter: vi.fn().mockResolvedValue({
        key: root,
        displayName: "Ryii",
        className: "Mage",
        level: 80,
        ownerId: null,
        profileGuess: null,
        declaredMain: null,
        guild: null,
        isTournamentProfile: true
      }),
      getMythicBossRankings: vi.fn()
    };

    await expect(
      dossiers.readInitial(root, undefined, { raiderio: override })
    ).resolves.toEqual({ kind: "not_ready" });
    expect(override.getCharacter).toHaveBeenCalledTimes(1);
    expect(raiderio.getCharacter).not.toHaveBeenCalled();
  });
});

describe("manually connected characters", () => {
  const manualKey = {
    region: "eu",
    realm: "silvermoon",
    name: "manual"
  } as const;
  const manualAlt = {
    region: "eu",
    realm: "silvermoon",
    name: "manualalt"
  } as const;

  it("links a queued character so no second attempt is needed", async () => {
    // Break caught: addConnectedCharacter used to return early for anything
    // that was not already a fresh snapshot, so a queued character was
    // researched and never linked. The reviewer had to add it twice.
    const { dossiers, repositories, search } = fixture();
    (search.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "job",
      jobId: "ca3ccfdf-1e8b-49b1-9729-459f42a104c0",
      status: "queued"
    });

    await expect(
      dossiers.addConnectedCharacter(root, {
        characterUrl: "https://raider.io/characters/eu/silvermoon/manual",
        headers
      })
    ).resolves.toMatchObject({ kind: "job" });

    expect(repositories.manualConnections.add).toHaveBeenCalledWith(
      root,
      manualKey
    );
  });

  it("does not link a character whose search never started", async () => {
    const { dossiers, repositories, search } = fixture();
    (search.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "rate_limited",
      retryAfterSeconds: 30
    });

    await expect(
      dossiers.addConnectedCharacter(root, {
        characterUrl: "https://raider.io/characters/eu/silvermoon/manual",
        headers
      })
    ).resolves.toMatchObject({ kind: "rate_limited" });

    expect(repositories.manualConnections.add).not.toHaveBeenCalled();
  });

  it("lists a character linked before discovery without inventing its details", async () => {
    // Break caught: connections used to require an existing character row, so a
    // pending link could not be stored at all, and a placeholder row would have
    // fabricated a class and level for the dossier to colour and rank.
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        key: manualKey,
        displayName: "manual",
        className: null,
        level: 0,
        guild: null,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
        pending: true
      }
    ]);
    // An undiscovered character has no evidence run, so its reservation is a
    // new one rather than a fresh cached result.
    const reserve = repositories.evidence.reserve as ReturnType<typeof vi.fn>;
    const reserveFresh = reserve.getMockImplementation() as (request: {
      key: CharacterKey;
    }) => Promise<unknown>;
    reserve.mockImplementation(async (request: { key: CharacterKey }) =>
      request.key.name === "manual"
        ? {
            kind: "reserved",
            run: {
              id: "10000000-0000-4000-8000-000000000041",
              key: manualKey,
              queueJobId: null,
              status: "queued",
              attempt: 1,
              limitationCode: null,
              parseLimitationCode: null,
              errorCode: null,
              createdAt: new Date("2026-09-15T12:00:00.000Z"),
              startedAt: null,
              completedAt: null
            },
            completed: null
          }
        : reserveFresh(request)
    );

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("expected_ready");

    // The spinner in the connected list is driven by these two states, and
    // showing the character as being researched is the point of linking it
    // before discovery has run.
    expect(
      result.dossier.characters.find(
        (character) => character.key.name === "manual"
      )
    ).toMatchObject({
      className: null,
      source: "manually_added",
      evidenceState: "waiting",
      researchState: "gathering"
    });
    expect(repositories.snapshots.getCurrent).not.toHaveBeenCalledWith(
      manualKey
    );
  });

  it("merges the characters discovered from a manually connected character", async () => {
    // Break caught: adding a character starts a discovery run rooted at it,
    // which walks its Raider.IO alts and fingerprints its Blizzard guild
    // roster. Those characters belong in this dossier, not only in that
    // character's own.
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        key: manualKey,
        displayName: "Manual",
        className: "Warrior",
        level: 80,
        guild: null,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
        pending: false
      }
    ]);
    (
      repositories.snapshots.getCurrent as ReturnType<typeof vi.fn>
    ).mockImplementation(async (key: CharacterKey) =>
      key.name === "manual"
        ? {
            ...storedSnapshot([
              {
                characterId: "10000000-0000-4000-8000-000000000031",
                key: manualKey,
                displayName: "Manual",
                className: "Warrior",
                level: 80,
                guild: null,
                raiderIoUrl:
                  "https://raider.io/characters/eu/silvermoon/manual",
                source: "input",
                displayOrder: 0
              },
              {
                characterId: "10000000-0000-4000-8000-000000000032",
                key: manualAlt,
                displayName: "Manualalt",
                className: "Rogue",
                level: 80,
                guild: null,
                raiderIoUrl:
                  "https://raider.io/characters/eu/silvermoon/manualalt",
                source: "fingerprint",
                displayOrder: 1
              }
            ]),
            rootKey: manualKey
          }
        : storedSnapshot()
    );

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("expected_ready");

    const names = result.dossier.characters.map(
      (character) => character.key.name
    );
    expect(names).toContain("manual");
    expect(names).toContain("manualalt");
    expect(
      result.dossier.characters.find(
        (character) => character.key.name === "manualalt"
      )
    ).toMatchObject({ source: "fingerprint_derived" });
  });

  it("lists an excluded connection without gathering any evidence for it", async () => {
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        key: manualKey,
        displayName: "Manual",
        className: "Warrior",
        level: 80,
        guild: null,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
        pending: false,
        excluded: true
      }
    ]);

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("expected_ready");

    // The row stays, so the exclusion can be reversed from the same list, but
    // nothing it could contribute reaches the evidence.
    expect(
      result.dossier.characters.find(
        (character) => character.key.name === "manual"
      )
    ).toMatchObject({ source: "manually_added", excluded: true });
    expect(repositories.evidence.reserve).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: manualKey })
    );
  });

  it("raises no limitation for an excluded connection", async () => {
    // An exclusion is a deliberate choice, not a gap in the research, so it
    // must not be reported alongside characters the request cap skipped.
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        key: manualKey,
        displayName: "Manual",
        className: "Warrior",
        level: 80,
        guild: null,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
        pending: false,
        excluded: true
      }
    ]);

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("expected_ready");

    expect(
      result.dossier.limitations.filter(
        (limitation) => limitation.character?.name === "manual"
      )
    ).toEqual([]);
  });

  it("keeps the characters discovered through an excluded connection", async () => {
    // Excluding one character is not undoing the add: its discovery run found
    // characters that stand on their own evidence.
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        key: manualKey,
        displayName: "Manual",
        className: "Warrior",
        level: 80,
        guild: null,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
        pending: false,
        excluded: true
      }
    ]);
    (
      repositories.snapshots.getCurrent as ReturnType<typeof vi.fn>
    ).mockImplementation(async (key: CharacterKey) =>
      key.name === "manual"
        ? {
            ...storedSnapshot([
              {
                characterId: "10000000-0000-4000-8000-000000000032",
                key: manualAlt,
                displayName: "Manualalt",
                className: "Rogue",
                level: 80,
                guild: null,
                raiderIoUrl:
                  "https://raider.io/characters/eu/silvermoon/manualalt",
                source: "fingerprint",
                displayOrder: 0
              }
            ]),
            rootKey: manualKey
          }
        : storedSnapshot()
    );

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("expected_ready");

    const manualAltCharacter = result.dossier.characters.find(
      (character) => character.key.name === "manualalt"
    );
    expect(manualAltCharacter).toMatchObject({ source: "fingerprint_derived" });
    expect(manualAltCharacter?.excluded).toBeUndefined();
  });

  it("spends no character-cap slot on an excluded connection", async () => {
    // Break caught: ranking the excluded row alongside the rest let it push a
    // researchable character past the cap while contributing nothing.
    const { dossiers, repositories } = fixture({ characterCap: 2 });
    (
      repositories.manualConnections.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        key: manualKey,
        displayName: "Manual",
        className: "Warrior",
        level: 80,
        guild: null,
        raiderIoUrl: "https://raider.io/characters/eu/silvermoon/manual",
        pending: false,
        excluded: true
      }
    ]);

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("expected_ready");

    const names = result.dossier.characters.map(
      (character) => character.key.name
    );
    expect(names).toContain("ryii");
    expect(names).toContain("ryalts");
    expect(names).toContain("manual");
  });

  it("excludes a connected character on request", async () => {
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.setExcluded as ReturnType<typeof vi.fn>
    ).mockResolvedValue("updated");

    await expect(
      dossiers.setConnectedCharacterExclusion(root, {
        characterUrl: "https://raider.io/characters/eu/silvermoon/manual",
        excluded: true
      })
    ).resolves.toEqual({ kind: "updated" });

    expect(repositories.manualConnections.setExcluded).toHaveBeenCalledWith(
      root,
      manualKey,
      true
    );
  });

  it("reports an exclusion of an unlinked character as missing", async () => {
    // Two reviewers can hold the same dossier. The second must be told the
    // link has gone rather than shown a success it did not cause.
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.setExcluded as ReturnType<typeof vi.fn>
    ).mockResolvedValue("missing");

    await expect(
      dossiers.setConnectedCharacterExclusion(root, {
        characterUrl: "https://raider.io/characters/eu/silvermoon/manual",
        excluded: false
      })
    ).resolves.toEqual({ kind: "missing" });
  });

  it("refuses an exclusion whose character cannot be parsed", async () => {
    const { dossiers, repositories } = fixture();

    await expect(
      dossiers.setConnectedCharacterExclusion(root, {
        characterUrl: "not-a-character",
        excluded: true
      })
    ).resolves.toEqual({ kind: "invalid", code: "invalid_character_url" });

    expect(repositories.manualConnections.setExcluded).not.toHaveBeenCalled();
  });

  it("unlinks a connected character on request", async () => {
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.remove as ReturnType<typeof vi.fn>
    ).mockResolvedValue("removed");

    await expect(
      dossiers.removeConnectedCharacter(root, {
        characterUrl: "https://raider.io/characters/eu/silvermoon/manual"
      })
    ).resolves.toEqual({ kind: "removed" });

    expect(repositories.manualConnections.remove).toHaveBeenCalledWith(
      root,
      manualKey
    );
  });

  it("reports the removal of an unlinked character as missing", async () => {
    const { dossiers, repositories } = fixture();
    (
      repositories.manualConnections.remove as ReturnType<typeof vi.fn>
    ).mockResolvedValue("missing");

    await expect(
      dossiers.removeConnectedCharacter(root, {
        characterUrl: "https://raider.io/characters/eu/silvermoon/manual"
      })
    ).resolves.toEqual({ kind: "missing" });
  });

  it("refuses a removal whose character cannot be parsed", async () => {
    const { dossiers, repositories } = fixture();

    await expect(
      dossiers.removeConnectedCharacter(root, {
        characterUrl: "not-a-character"
      })
    ).resolves.toEqual({ kind: "invalid", code: "invalid_character_url" });

    expect(repositories.manualConnections.remove).not.toHaveBeenCalled();
  });
});
