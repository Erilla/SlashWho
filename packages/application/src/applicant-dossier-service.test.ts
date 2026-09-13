import type { SearchService } from "./search-service";
import type {
  Repositories,
  StoredCharacterMythicKill,
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
    characterCap?: number;
    warcraftLogsRequestCap?: number;
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
      historicWorldRank: null
    }
  ];
  const repositories = {
    snapshots: {
      getCurrent: vi
        .fn()
        .mockResolvedValue(
          "snapshot" in options ? options.snapshot : storedSnapshot()
        ),
      create: vi.fn(),
      createAndFinishFingerprintSweep: vi.fn(),
      find: vi.fn(),
      listHistory: vi.fn()
    },
    runs: { create: runsCreate },
    evidence: {
      reserve: vi.fn().mockImplementation(async ({ key }) => ({
        kind: "fresh",
        run: {
          id: "10000000-0000-4000-8000-000000000012",
          key,
          queueJobId: "evidence-job",
          status: "complete",
          attempt: 1,
          limitationCode: null,
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
            status: "complete",
            attempt: 1,
            limitationCode: null,
            errorCode: null,
            createdAt: new Date("2026-09-11T12:00:00.000Z"),
            startedAt: new Date("2026-09-11T12:00:00.000Z"),
            completedAt: new Date()
          },
          kills: cachedKills
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
  } as unknown as Pick<RaiderIoGateway, "getMythicBossRankings">;
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

describe("applicant dossier service", () => {
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
        raids: [
          {
            raidId: "1273",
            bosses: [
              {
                firstKill: {
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/example#fight=9",
                  historicWorldRank: 2
                }
              }
            ]
          }
        ],
        cuttingEdges: [
          { achievementId: "40254", characters: ["Ryii", "Ryalts"] }
        ],
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
        raids: [{ bosses: [{ firstKill: { historicWorldRank: 2 } }] }]
      }
    });
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledWith(
      { raidSlug: "nerubar-palace", bossSlug: "queen-ansurek" },
      expect.any(AbortSignal)
    );
  });

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
        raids: [{ bosses: [{ firstKill: { historicWorldRank: null } }] }]
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
        raids: [{ raidId: "1273" }],
        limitations: [
          { source: "blizzard", character: root, code: "unavailable" }
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
            displayName: "ryii",
            source: "submitted"
          }
        ],
        raids: [
          {
            raidId: "1273",
            bosses: [
              {
                firstKill: {
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/example#fight=9"
                }
              }
            ]
          }
        ],
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
        raids: [
          {
            raidId: "1273",
            bosses: [
              {
                firstKill: {
                  reportUrl:
                    "https://www.warcraftlogs.com/reports/example#fight=9"
                }
              }
            ]
          }
        ],
        limitations: []
      }
    });
  });

  it("uses stored snapshot order for the character cap and reports every skipped evidence stream", async () => {
    // Break caught: a cap could depend on incidental identity ordering or silently omit evidence.
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
