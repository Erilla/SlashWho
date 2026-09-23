import type { SearchService } from "./search-service";
import type {
  DiscoveryQueue,
  Repositories,
  StoredCharacterMythicKill,
  StoredCharacterMythicWipe,
  StoredCharacterTierBestParse,
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
    tierBests?: readonly StoredCharacterTierBestParse[];
    includeCachedKills?: boolean;
    evidenceStatus?: "complete" | "partial";
    wipeCapable?: boolean;
    evidenceLimitationCode?: string | null;
    evidenceParseLimitationCode?: string | null;
    evidenceCompletedAt?: Date;
    storedEvidence?: boolean;
    historicWorldRank?: number | null;
    storedCuttingEdges?: readonly {
      achievementId: string;
      completedAt: string;
    }[];
    cuttingEdgesCollected?: boolean;
    gatheringCharacter?: CharacterKey | null;
    /** A limitation recorded on the run that is collecting right now. */
    activeLimitationCode?: string | null;
    /** Fresh stored evidence with a refresh collecting over it right now. */
    refreshingCharacter?: CharacterKey | null;
    onCacheEvent?: (source: string, event: string) => void;
  } = {}
) {
  // One reading of the clock per fixture. The reservation mock runs once per
  // read, so reading the clock inside it let two concurrent reads of the same
  // evidence report completedAt values a millisecond apart.
  const evidenceCompletedAt = options.evidenceCompletedAt ?? new Date();
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
      killedAt: "2024-10-01T20:00:00.000Z",
      reportUrl: "https://www.warcraftlogs.com/reports/example",
      fightUrl: "https://www.warcraftlogs.com/reports/example#fight=9",
      guild: { name: "Example Guild", realm: "silvermoon" },
      historicWorldRank:
        options.historicWorldRank === undefined ? 2 : options.historicWorldRank,
      parsesReadAt: null,
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
        active:
          options.gatheringCharacter === key ||
          options.refreshingCharacter === key
            ? {
                id: "10000000-0000-4000-8000-000000000013",
                key,
                queueJobId: "evidence-job",
                status: "running",
                attempt: 1,
                limitationCode: options.activeLimitationCode ?? null,
                parseLimitationCode: null,
                errorCode: null,
                createdAt: new Date("2026-09-11T12:00:00.000Z"),
                startedAt: new Date("2026-09-11T12:00:00.000Z"),
                completedAt: null
              }
            : null,
        run: {
          id: "10000000-0000-4000-8000-000000000012",
          key,
          queueJobId: "evidence-job",
          status: options.evidenceStatus ?? "complete",
          attempt: 1,
          limitationCode:
            "evidenceLimitationCode" in options
              ? (options.evidenceLimitationCode ?? null)
              : options.evidenceStatus === "partial"
                ? "request_cap"
                : null,
          parseLimitationCode: options.evidenceParseLimitationCode ?? null,
          errorCode: null,
          createdAt: new Date("2026-09-11T12:00:00.000Z"),
          startedAt: new Date("2026-09-11T12:00:00.000Z"),
          completedAt: evidenceCompletedAt
        },
        completed: {
          run: {
            id: "10000000-0000-4000-8000-000000000012",
            key,
            queueJobId: "evidence-job",
            status: options.evidenceStatus ?? "complete",
            attempt: 1,
            limitationCode:
              "evidenceLimitationCode" in options
                ? (options.evidenceLimitationCode ?? null)
                : options.evidenceStatus === "partial"
                  ? "request_cap"
                  : null,
            parseLimitationCode: options.evidenceParseLimitationCode ?? null,
            errorCode: null,
            createdAt: new Date("2026-09-11T12:00:00.000Z"),
            startedAt: new Date("2026-09-11T12:00:00.000Z"),
            completedAt: evidenceCompletedAt
          },
          kills: [
            ...(options.includeCachedKills === false ? [] : cachedKills),
            ...(options.additionalKills ?? [])
          ],
          wipes: options.wipes ?? [],
          tierBests: options.tierBests ?? [],
          cuttingEdges: options.storedCuttingEdges ?? [],
          cuttingEdgesCollected: options.cuttingEdgesCollected ?? false,
          wipeCapable: options.wipeCapable ?? true
        }
      })),
      getCompleted: vi.fn().mockImplementation(async (key) =>
        options.storedEvidence === false
          ? null
          : {
              run: {
                id: "10000000-0000-4000-8000-000000000012",
                key,
                queueJobId: "evidence-job",
                status: options.evidenceStatus ?? "complete",
                attempt: 1,
                limitationCode:
                  "evidenceLimitationCode" in options
                    ? (options.evidenceLimitationCode ?? null)
                    : options.evidenceStatus === "partial"
                      ? "request_cap"
                      : null,
                parseLimitationCode:
                  options.evidenceParseLimitationCode ?? null,
                errorCode: null,
                createdAt: new Date("2026-09-11T12:00:00.000Z"),
                startedAt: new Date("2026-09-11T12:00:00.000Z"),
                completedAt: evidenceCompletedAt
              },
              kills: [
                ...(options.includeCachedKills === false ? [] : cachedKills),
                ...(options.additionalKills ?? [])
              ],
              wipes: options.wipes ?? [],
              tierBests: options.tierBests ?? [],
              cuttingEdges: options.storedCuttingEdges ?? [],
              cuttingEdgesCollected: options.cuttingEdgesCollected ?? false,
              wipeCapable: options.wipeCapable ?? true
            }
      ),
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
    evidenceJobCredentialEncryptionKey: encryptionKey,
    onCacheEvent: options.onCacheEvent
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
  it("reserves the complete collection phase plan before evidence can be queued", async () => {
    // Break caught: creating phase rows only after a worker claimed the run
    // leaves a reserved or enqueue-failed run with no truthful progress plan.
    const { dossiers, repositories } = fixture({ storedEvidence: false });

    await dossiers.read(root);

    expect(repositories.evidence.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        phasePlan: [
          "warcraft_logs_identity_resolution",
          "warcraft_logs_history",
          "warcraft_logs_tier_bests",
          "warcraft_logs_fight_parses",
          "warcraft_logs_ranking_identities",
          "raiderio_rankings",
          "blizzard_achievements",
          "publication"
        ]
      })
    );
  });

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
      fightUrl: "https://www.warcraftlogs.com/reports/wipe#fight=5",
      guild: { name: "Example Guild", realm: "silvermoon" },
      uploader: "Dorian"
    } as StoredCharacterMythicWipe & {
      guild: { name: string; realm: string };
      uploader: string;
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
      wipe: {
        characters: [root, alt],
        source: "guild_log",
        uploader: "Dorian"
      }
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

  it("keeps no-log gaps for a run whose only shortfall is its parse budget", async () => {
    // A capped run now publishes `partial`, because it did not finish. Its
    // history scan did, though, and that is what a negative conclusion rests
    // on -- so requiring `complete` here would silently withdraw conclusions
    // the evidence still supports the moment the cap started being honest.
    const result = await fixture({
      includeCachedKills: false,
      evidenceStatus: "partial",
      evidenceLimitationCode: null,
      evidenceParseLimitationCode: "parse_request_cap"
    }).dossiers.read(root);
    if (result.kind !== "ready") throw new Error("dossier_not_ready");

    expect(result.dossier.raids[0]?.bosses[0]).toMatchObject({
      state: "no_logs"
    });
  });

  it("withholds initial evidence for a tournament root before discovery finishes", async () => {
    const { dossiers, raiderio, warcraftLogs, blizzard } = fixture({
      storedEvidence: false
    });
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
    const { dossiers, raiderio, warcraftLogs } = fixture({
      storedEvidence: false
    });
    vi.mocked(raiderio.getCharacter).mockRejectedValue({ kind: "transient" });
    await expect(dossiers.readInitial(root)).resolves.toEqual({
      kind: "not_ready"
    });
    expect(warcraftLogs.getFirstKillReports).not.toHaveBeenCalled();
  });

  it("shows stored root evidence without rechecking an unavailable discovery provider", async () => {
    // Break caught: the discovery job can already be failing at Raider.IO while
    // durable evidence from an earlier linked-character collection is still
    // useful and already public through the dossier that collected it.
    const { dossiers, raiderio, repositories } = fixture();
    vi.mocked(raiderio.getCharacter).mockRejectedValue({ kind: "transient" });

    await expect(dossiers.readInitial(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        root,
        characters: [{ key: root, source: "submitted" }],
        research: {
          state: "initial",
          message:
            "Linked-character research is pending; stored evidence is shown only for the submitted character."
        }
      }
    });
    expect(repositories.evidence.getCompleted).toHaveBeenCalledWith(root);
    expect(raiderio.getCharacter).not.toHaveBeenCalled();
  });

  it("preserves cancellation during initial eligibility checking", async () => {
    const { dossiers, raiderio } = fixture({ storedEvidence: false });
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
    expect(raiderio.getMythicBossRankings).not.toHaveBeenCalled();
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

  it("uses persisted historic ranks without repeating Raider.IO ranking requests", async () => {
    const { dossiers, raiderio } = fixture();
    await dossiers.read(root);
    await dossiers.read(root);
    expect(raiderio.getMythicBossRankings).not.toHaveBeenCalled();
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

  // A root that cannot establish the account on its own, a middle subject
  // under test, and a fingerprint tail that is only read when the middle
  // subject failed to establish it.
  function accountEstablishingSnapshot(
    source: StoredSnapshot["characters"][number]["source"]
  ): StoredSnapshot {
    const [submitted, linked] = storedSnapshot().characters;
    return storedSnapshot([
      { ...submitted!, source: "claimed", level: 80 },
      { ...linked!, key: third, displayName: "Third", level: 50, source },
      { ...linked!, key: alt, level: 10, source: "fingerprint" }
    ]);
  }

  it.each([
    "input",
    "declared_main",
    "profile_guess",
    "fingerprint",
    // Not `discovery_source` values, but both are `DossierSubject["source"]`
    // and both reach this code through other read paths. The stored snapshot
    // is just the cheapest vehicle for putting them in a mixed subject list.
    "submitted",
    "manually_added"
  ] as unknown as StoredSnapshot["characters"][number]["source"][])(
    "lets a %s subject establish the account for the fingerprint tail",
    async (source) => {
      // Break caught: partitioning the subjects as "claimed vs the rest"
      // would stop every one of these sources establishing the account, and
      // the fingerprint tail would be read again for nothing.
      const { dossiers, blizzard } = fixture({
        snapshot: accountEstablishingSnapshot(source)
      });

      await dossiers.read(root);

      expect(
        vi
          .mocked(blizzard.getCompletedAchievements)
          .mock.calls.map(([key]) => key)
      ).toEqual([root, third]);
    }
  );

  it("still reads the fingerprint tail when only claimed subjects answered", async () => {
    // The negative control for the table above: `claimed` is the one source
    // that cannot establish the account, so the tail is not redundant.
    const { dossiers, blizzard } = fixture({
      snapshot: accountEstablishingSnapshot("claimed")
    });

    await dossiers.read(root);

    expect(
      vi
        .mocked(blizzard.getCompletedAchievements)
        .mock.calls.map(([key]) => key)
    ).toEqual([root, third, alt]);
  });

  it("fans non-fingerprint achievement reads out concurrently", async () => {
    // Break caught: a serial `for…await` put one full Blizzard round-trip per
    // subject on the critical path of a cold dossier read -- ten calls at
    // ~540ms against a p95 wall time of 7.7s.
    const { dossiers, blizzard } = fixture({
      snapshot: storedSnapshot(
        [80, 50, 10].map((level, index) => ({
          ...storedSnapshot().characters[1]!,
          key: [root, third, alt][index]!,
          level,
          source: "claimed" as const
        }))
      )
    });
    const release: Array<() => void> = [];
    vi.mocked(blizzard.getCompletedAchievements).mockImplementation(
      async () => {
        await new Promise<void>((resolve) => release.push(resolve));
        return [
          { achievementId: "40254", completedAt: "2025-01-14T20:30:00.000Z" }
        ];
      }
    );

    const read = dossiers.read(root);
    // Under a serial loop only the first subject is ever dispatched while the
    // others are outstanding, so this wait is what fails without the fan-out.
    await vi.waitFor(() => expect(release).toHaveLength(3));
    for (const resolve of release) resolve();

    await expect(read).resolves.toMatchObject({ kind: "ready" });
  });

  it("orders batch limitations by subject, not by which call settled first", async () => {
    // Break caught: collecting a concurrent batch by pushing inside the async
    // callback reorders the dossier's limitations under any latency skew.
    const { dossiers, blizzard } = fixture({
      snapshot: storedSnapshot(
        [80, 50, 10].map((level, index) => ({
          ...storedSnapshot().characters[1]!,
          key: [root, third, alt][index]!,
          level,
          source: "claimed" as const
        }))
      )
    });
    const settle: Array<() => void> = [];
    vi.mocked(blizzard.getCompletedAchievements).mockImplementation(
      async () => {
        await new Promise<void>((resolve) => settle.push(resolve));
        throw new Error("offline");
      }
    );

    const read = dossiers.read(root);
    await vi.waitFor(() => expect(settle).toHaveLength(3));
    // Exactly reverse subject order.
    for (const resolve of [...settle].reverse()) resolve();

    const result = await read;
    if (result.kind !== "ready") throw new Error("dossier_not_ready");
    expect(
      result.dossier.limitations
        .filter((entry) => entry.source === "blizzard")
        .map((entry) => entry.character)
    ).toEqual([root, third, alt]);
  });

  it("rejects once when a read is aborted mid-batch", async () => {
    // Break caught: rethrowing an abort straight out of a concurrent batch
    // abandons the siblings that are still in flight, and every one of them
    // then rejects with nothing listening.
    const { dossiers, blizzard } = fixture({
      snapshot: storedSnapshot(
        [80, 50, 10].map((level, index) => ({
          ...storedSnapshot().characters[1]!,
          key: [root, third, alt][index]!,
          level,
          source: "claimed" as const
        }))
      )
    });
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const dispatched: CharacterKey[] = [];
      const release: Array<() => void> = [];
      vi.mocked(blizzard.getCompletedAchievements).mockImplementation(
        async (key) => {
          dispatched.push(key);
          await new Promise<void>((resolve) => release.push(resolve));
          return [
            { achievementId: "40254", completedAt: "2025-01-14T20:30:00.000Z" }
          ];
        }
      );
      const controller = new AbortController();
      const read = dossiers.read(root, controller.signal);
      await vi.waitFor(() => expect(dispatched).toHaveLength(3));

      controller.abort();
      await expect(read).rejects.toThrow();
      for (const resolve of release) resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
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
      raiderio: {
        async getCharacter() {
          return {
            key: root,
            displayName: "Ryii",
            className: "Mage",
            level: 80,
            guild: null,
            ownerId: null,
            profileGuess: null,
            declaredMain: null
          };
        }
      },
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

  it("reports when the dossier's evidence was last collected", async () => {
    // Break caught: the refresh control shows how stale a dossier is and
    // chooses its own mode from the same value, so the reader can tell why a
    // press did a light refresh rather than a full one.
    const { dossiers } = fixture({
      evidenceCompletedAt: new Date("2026-09-16T09:30:00.000Z")
    });

    const result = await dossiers.read(root);

    expect(result).toMatchObject({
      kind: "ready",
      dossier: { lastCollectedAt: "2026-09-16T09:30:00.000Z" }
    });
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

  it("reports gathering while a refresh re-collects evidence that is still fresh", async () => {
    // Break caught: the refresh button forces a run past the freshness window,
    // so the read that started it saw `fresh` and reported no gathering --
    // leaving the button enabled during exactly the run it queued.
    const result = await fixture({ refreshingCharacter: alt }).dossiers.read(
      root
    );

    expect(result).toMatchObject({
      kind: "ready",
      dossier: {
        research: { state: "gathering" },
        characters: [
          // The stored evidence is still complete -- a refresh running over it
          // does not make it incomplete -- but the row being re-collected
          // still has to show it, or the spinner appears against every parse
          // while Connected Characters sits there looking settled.
          { key: root, evidenceState: "complete", researchState: "complete" },
          { key: alt, evidenceState: "complete", researchState: "gathering" }
        ]
      }
    });
  });

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

  it("describes the parse request cap as in progress rather than finished", async () => {
    // Break caught: the notice read as a verdict. Since #280 a capped run
    // sets a retry and resumes, so telling the reader the cap was reached and
    // stopping there described the opposite of what happens next (#297).
    const { dossiers } = fixture({
      evidenceLimitationCode: "parse_request_cap"
    });

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("Expected dossier");
    const limitation = result.dossier.limitations.find(
      (item) => item.code === "parse_request_cap"
    );
    expect(limitation?.message).toContain("resumes automatically");
    expect(limitation?.message).toContain("verified kill evidence");
  });

  it("describes points_budget_low as a deferral, not a parse failure", async () => {
    // Break caught: points_budget_low does not start with "parse_", so without an
    // explicit case it falls through limitationMessage's default and tells the
    // reader parse availability is partial -- when in fact nothing was collected
    // and the run is waiting for the allowance to reset.
    const { dossiers } = fixture({
      evidenceLimitationCode: "points_budget_low"
    });

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
        code: "points_budget_low",
        message:
          "Warcraft Logs collection was deferred because this dossier's hourly " +
          "points allowance is nearly spent. It resumes automatically once the " +
          "allowance resets; shown evidence is partial."
      })
    );
  });

  it("describes collection_failed as an interrupted collection, not a parse failure", async () => {
    // Break caught: `collection_failed` does not start with "parse_" either, so
    // without its own case it falls through to the default and tells a reader
    // that parse availability is partial -- when what actually happened is that
    // the collection was stopped before it could be stored (#292).
    const { dossiers } = fixture({
      evidenceLimitationCode: "collection_failed"
    });

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
        code: "collection_failed",
        message:
          "Warcraft Logs collection was interrupted by an error before it " +
          "could be stored. Shown evidence is partial and collection is " +
          "retried automatically; other kills or wipes may exist."
      })
    );
  });

  it("explains a deferral recorded on the run that is still collecting", async () => {
    // Break caught: limitations were read only from the completed run, and a
    // points-budget refusal publishes nothing -- so the copy written for a
    // deferral could never reach a reader, who saw an unexplained "collecting"
    // state instead for as long as the allowance stayed spent.
    const { dossiers } = fixture({
      gatheringCharacter: root,
      activeLimitationCode: "points_budget_low"
    });

    const result = await dossiers.read(root);
    if (result.kind !== "ready") throw new Error("Expected dossier");
    const limitation = result.dossier.limitations.find(
      (item) => item.code === "points_budget_low"
    );
    expect(limitation).toEqual(
      expect.objectContaining({
        source: "warcraft_logs",
        code: "points_budget_low"
      })
    );
  });

  it("reads collected Cutting Edge rows without calling Blizzard again", async () => {
    const { dossiers, blizzard } = fixture({
      cuttingEdgesCollected: true,
      storedCuttingEdges: [
        { achievementId: "41297", completedAt: "2025-03-01T20:30:00.000Z" }
      ]
    });
    await expect(dossiers.read(root)).resolves.toMatchObject({
      dossier: { cuttingEdges: [{ achievementId: "41297" }] }
    });
    expect(blizzard.getCompletedAchievements).not.toHaveBeenCalled();
  });

  it("treats an empty completed Blizzard phase as a collected answer", async () => {
    const { dossiers, blizzard } = fixture({
      cuttingEdgesCollected: true,
      storedCuttingEdges: []
    });
    await expect(dossiers.read(root)).resolves.toMatchObject({
      dossier: { cuttingEdges: [] }
    });
    expect(blizzard.getCompletedAchievements).not.toHaveBeenCalled();
  });

  it("restores historic ranks for evidence published before ranks were stored", async () => {
    const { dossiers, raiderio } = fixture({ historicWorldRank: null });
    await expect(dossiers.read(root)).resolves.toMatchObject({
      dossier: {
        raids: expect.arrayContaining([raidWithKill({ historicWorldRank: 2 })])
      }
    });
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);
    await dossiers.read(root);
    expect(raiderio.getMythicBossRankings).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy kills visible when the rank fallback is unavailable", async () => {
    const { dossiers, raiderio } = fixture({ historicWorldRank: null });
    vi.mocked(raiderio.getMythicBossRankings).mockRejectedValueOnce(
      new Error("ranking unavailable")
    );
    await expect(dossiers.read(root)).resolves.toMatchObject({
      dossier: {
        raids: expect.arrayContaining([
          raidWithKill({ historicWorldRank: null })
        ]),
        limitations: expect.arrayContaining([
          expect.objectContaining({ source: "raiderio", code: "unavailable" })
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

  it("shows stored root evidence and keeps its freshness reservation when no snapshot exists", async () => {
    // Break caught: a missing discovery snapshot could hide durable evidence
    // keyed to the submitted character, even though that evidence can be read
    // independently and still pass through the ordinary freshness reservation.
    const { dossiers, repositories, raiderio } = fixture({ snapshot: null });

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        root,
        characters: [{ key: root, source: "submitted" }],
        raids: expect.arrayContaining([
          raidWithKill({
            reportUrl: "https://www.warcraftlogs.com/reports/example#fight=9"
          })
        ]),
        research: {
          state: "initial",
          message:
            "Linked-character research is pending; stored evidence is shown only for the submitted character."
        }
      }
    });
    expect(repositories.evidence.getCompleted).toHaveBeenCalledWith(root);
    expect(repositories.evidence.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ key: root })
    );
    expect(raiderio.getCharacter).not.toHaveBeenCalled();
  });

  it("keeps linked-character uncertainty visible while stale root evidence refreshes", async () => {
    // Break caught: reserving a refresh for root-only evidence could replace
    // the linked-character disclosure with a generic evidence-gathering note,
    // making the single row look like a known-complete character list.
    const { dossiers } = fixture({
      snapshot: null,
      gatheringCharacter: root
    });

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        characters: [{ key: root, source: "submitted" }],
        research: {
          state: "gathering",
          message:
            "Linked-character research is pending, and historic mythic evidence is still gathering. Cached results for only the submitted character are shown."
        }
      }
    });
  });

  it("returns not_ready without contacting evidence sources when no snapshot or stored evidence exists", async () => {
    // Break caught: a missing discovery result could trigger unbounded third-party requests.
    const { dossiers, repositories, warcraftLogs } = fixture({
      snapshot: null,
      storedEvidence: false
    });

    await expect(dossiers.read(root)).resolves.toEqual({ kind: "not_ready" });
    expect(repositories.evidence.reserve).not.toHaveBeenCalled();
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
            "Linked-character research is pending; stored evidence is shown only for the submitted character."
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

  it("explains that an account without a public Raider.IO claim may be incomplete", async () => {
    // Break caught: `privacy_hidden` could be surfaced as if privacy hid every
    // missing character, instead of the actual uncertainty: Raider.IO exposes
    // no account claim, so the known reverse links may still be incomplete.
    const snapshot = storedSnapshot();
    snapshot.state = "partial";
    snapshot.limitationCode = "privacy_hidden";
    const { dossiers } = fixture({ snapshot });

    await expect(dossiers.read(root)).resolves.toMatchObject({
      kind: "ready",
      dossier: {
        research: {
          state: "partial",
          message:
            "Raider.IO shows no public account claim for this character, so additional linked characters may exist; this dossier is not exhaustive."
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
        // The stored-evidence eligibility check is measured first (0 ms), then
        // the provider lookup occupies the next 12 ms slice.
        const steps = [0, 0, 0, 12, 12, 12];
        return () => steps[Math.min(index++, steps.length - 1)]!;
      })()
    );
    const { dossiers, raiderio } = fixture({ storedEvidence: false });
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

  it("does not perform dossier-time Raider.IO ranking requests", async () => {
    const { dossiers, raiderio } = fixture();
    await dossiers.read(root);
    await dossiers.read(root);
    expect(raiderio.getMythicBossRankings).not.toHaveBeenCalled();
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
    expect(raiderio.getMythicBossRankings).not.toHaveBeenCalled();

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
        raids: expect.arrayContaining([raidWithKill({ historicWorldRank: 2 })])
      }
    });
    expect(overrides.blizzard.getCompletedAchievements).toHaveBeenCalledTimes(
      1
    );
    expect(overrides.raiderio.getMythicBossRankings).not.toHaveBeenCalled();
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
    expect(raiderio.getMythicBossRankings).not.toHaveBeenCalled();

    // The shared caches still hold only the constructor gateways' results.
    await expect(dossiers.read(root)).resolves.toMatchObject({
      dossier: {
        cuttingEdges: [{ achievementId: "40254" }],
        raids: expect.arrayContaining([raidWithKill({ historicWorldRank: 2 })])
      }
    });
    expect(blizzard.getCompletedAchievements).toHaveBeenCalledTimes(1);
    expect(raiderio.getMythicBossRankings).not.toHaveBeenCalled();
  });

  it("checks initial eligibility with a supplied Raider.IO gateway", async () => {
    const { dossiers, raiderio } = fixture({ storedEvidence: false });
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
