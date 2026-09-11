import type { SearchService } from "./search-service";
import type { Repositories, StoredSnapshot } from "@slashwho/database";
import type { RaiderIoGateway } from "@slashwho/raiderio";
import type { WarcraftLogsGateway } from "@slashwho/warcraftlogs";
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
  options: { snapshot?: StoredSnapshot | null; characterCap?: number } = {}
) {
  const runsCreate = vi.fn();
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
    runs: { create: runsCreate }
  } as unknown as Repositories;
  const search = {
    create: vi.fn().mockResolvedValue({
      kind: "character",
      character: { character: { name: "Ryii" } }
    })
  } as unknown as Pick<SearchService, "create">;
  const raiderIo = {
    getHistoricMythicKills: vi.fn().mockResolvedValue({
      kind: "evidence",
      kills: [
        {
          raidId: "nerubar-palace",
          raidName: "Nerubar Palace",
          bossId: "1234",
          bossName: "Queen Ansurek",
          bossOrder: 8,
          isFinalBoss: true,
          firstDefeated: "2024-10-01T20:00:00.000Z",
          guild: { name: "Guild", realm: "silvermoon" },
          historicWorldRank: 17
        }
      ]
    })
  } as unknown as Pick<RaiderIoGateway, "getHistoricMythicKills">;
  const warcraftLogs = {
    getFirstKillReports: vi.fn().mockResolvedValue({
      kind: "evidence",
      reports: [
        {
          encounterId: 1234,
          killedAt: "2024-10-01T20:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/example",
          fightUrl: "https://www.warcraftlogs.com/reports/example#fight=9"
        }
      ]
    })
  } as unknown as Pick<WarcraftLogsGateway, "getFirstKillReports">;
  const config = applicationConfigSchema.parse({
    BOT_API_KEY: "b".repeat(32),
    RATE_LIMIT_HASH_SECRET: "r".repeat(32),
    ...(options.characterCap === undefined
      ? {}
      : { DOSSIER_CHARACTER_CAP: options.characterCap })
  });
  const dossiers = createApplicantDossierService({
    repositories,
    search,
    raiderIo,
    warcraftLogs,
    config
  });
  return { dossiers, repositories, runsCreate, search, raiderIo, warcraftLogs };
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

  it("assembles current snapshot evidence without writing a dossier or mutating the snapshot", async () => {
    // Break caught: evidence reads could persist a dossier or lose the Warcraft Logs link matching a boss and timestamp.
    const { dossiers, repositories, runsCreate } = fixture();

    const result = await dossiers.read(root);

    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        characters: [
          { displayName: "Ryii", source: "raiderio_declared" },
          { displayName: "Ryalts", source: "fingerprint_derived" }
        ],
        raids: [
          {
            raidId: "nerubar-palace",
            bosses: [
              {
                firstKill: {
                  reportUrl: "https://www.warcraftlogs.com/reports/example"
                }
              }
            ]
          }
        ]
      }
    });
    expect(repositories.snapshots.create).not.toHaveBeenCalled();
    expect(runsCreate).not.toHaveBeenCalled();
  });

  it("returns not_ready without contacting evidence sources when no snapshot exists", async () => {
    // Break caught: a missing discovery result could trigger unbounded third-party requests.
    const { dossiers, raiderIo, warcraftLogs } = fixture({ snapshot: null });

    await expect(dossiers.read(root)).resolves.toEqual({ kind: "not_ready" });
    expect(raiderIo.getHistoricMythicKills).not.toHaveBeenCalled();
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  });

  it("keeps evidence from other characters when one source is unavailable", async () => {
    // Break caught: one private or unavailable source could discard a usable linked-character dossier.
    const { dossiers, raiderIo } = fixture();
    vi.mocked(raiderIo.getHistoricMythicKills)
      .mockResolvedValueOnce({ kind: "limitation", code: "private" })
      .mockResolvedValueOnce({
        kind: "evidence",
        kills: [
          {
            raidId: "nerubar-palace",
            raidName: "Nerubar Palace",
            bossId: "1234",
            bossName: "Queen Ansurek",
            bossOrder: 8,
            isFinalBoss: true,
            firstDefeated: "2024-10-01T20:00:00.000Z",
            guild: null,
            historicWorldRank: null
          }
        ]
      });

    const result = await dossiers.read(root);

    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        raids: [{ raidId: "nerubar-palace" }],
        limitations: [{ source: "raiderio", character: root, code: "private" }]
      }
    });
  });

  it("uses stored snapshot order for the character cap and reports every skipped evidence stream", async () => {
    // Break caught: a cap could depend on incidental identity ordering or silently omit evidence.
    const { dossiers, raiderIo, warcraftLogs } = fixture({
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

    expect(raiderIo.getHistoricMythicKills).toHaveBeenCalledTimes(1);
    expect(warcraftLogs.getFirstKillReports).toHaveBeenCalledTimes(1);
    expect(raiderIo.getHistoricMythicKills).toHaveBeenCalledWith(
      alt,
      expect.any(Object)
    );
    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        characters: [{ displayName: "Ryalts" }],
        limitations: [
          { source: "raiderio", character: third, code: "request_cap" },
          {
            source: "warcraft_logs",
            character: third,
            code: "request_cap"
          }
        ]
      }
    });
  });
});
