import type { SearchService } from "./search-service";
import type {
  Repositories,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredSnapshot
} from "@slashwho/database";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
import type { BlizzardGateway } from "@slashwho/blizzard";
import type { RaiderIoGateway } from "@slashwho/raiderio";
import { describe, expect, it, vi } from "vitest";

import { applicationConfigSchema } from "./config";
import { createApplicantDossierService } from "./applicant-dossier-service";

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
    additionalKills?: readonly StoredCharacterMythicKill[];
    wipes?: readonly StoredCharacterMythicWipe[];
    includeCachedKills?: boolean;
    evidenceStatus?: "complete" | "partial";
    wipeCapable?: boolean;
    evidenceLimitationCode?: string | null;
    evidenceParseLimitationCode?: string | null;
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
      list: vi.fn().mockResolvedValue([])
    },
    runs: { create: runsCreate },
    evidence: {
      reserve: vi.fn().mockImplementation(async ({ key }) => ({
        kind: "fresh",
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
      : { DOSSIER_WARCRAFT_LOGS_REQUEST_CAP: options.warcraftLogsRequestCap })
  });
  const dossiers = createApplicantDossierService({
    repositories,
    search,
    queue: { enqueueCharacterEvidence },
    blizzard,
    raiderio,
    config
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

  it("returns the existing active discovery result without creating another run", async () => {
    // Break caught: an in-flight search could be replaced instead of reused by dossier start.
    const { dossiers, search, runsCreate } = fixture();
    const active = {
      kind: "job",
      jobId: "00000000-0000-4000-8000-000000000010",
      status: "running",
      statusUrl: "/api/v1/searches/00000000-0000-4000-8000-000000000010",
      characterUrl: "/characters/eu/silvermoon/ryii",
      staleCharacter: null
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
        code
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
              message: expect.stringContaining("boss world ranks")
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
});
