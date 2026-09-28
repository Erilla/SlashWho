import type {
  CharacterRaiderIoFirstKillInput,
  RaiderIoLoggedEncounterAnswers,
  StoredRaiderIoLoggedEncounter,
  StoredRaiderIoLoggedEncounterAnswers,
  StoredRaiderIoLoggedEncounterUnavailable
} from "@slashwho/database";
import type {
  HistoricMythicKill,
  LoggedEncounter,
  LoggedEncounterMember,
  MythicBossRanking,
  RaiderIoGateway
} from "@slashwho/raiderio";
import { describe, expect, it, vi } from "vitest";

import {
  collectRaiderIoFirstKills,
  MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN,
  rankRaiderIoFirstKills
} from "./raiderio-first-kills";

// Synthetic identities throughout: this repository is public.
const key = { region: "eu" as const, realm: "draenor", name: "alfa" };
const killGuild = {
  name: "Fixture Guild Alfa",
  realm: "twisting-nether",
  region: "eu"
};
const alfaId = 424_242;
const alfa: LoggedEncounterMember = {
  raiderIoCharacterId: alfaId,
  name: "Alfa",
  realm: "draenor",
  region: "eu",
  className: "Demon Hunter",
  specName: "Havoc",
  role: "dps",
  itemLevel: 290.5
};
const bravo: LoggedEncounterMember = {
  raiderIoCharacterId: 424_243,
  name: "Bravo",
  realm: "twisting-nether",
  region: "eu",
  className: "Warrior",
  specName: "Protection",
  role: "tank",
  itemLevel: 292.1
};
const now = new Date("2026-09-28T12:00:00.000Z");
const none: StoredRaiderIoLoggedEncounterAnswers = {
  encounters: [],
  unavailable: []
};

function kill(
  bossSlug: string,
  loggedEncounterId: number | null,
  firstDefeated = "2026-07-20T17:25:57.000Z"
): HistoricMythicKill {
  return {
    raidSlug: "tier-mn-1",
    bossSlug,
    firstDefeated,
    guild: killGuild,
    loggedEncounterId
  };
}

function encounter(
  bossSlug: string,
  roster: LoggedEncounter["roster"] = {
    state: "available",
    members: [bravo, alfa]
  }
): LoggedEncounter {
  return {
    kind: "encounter",
    raidSlug: "tier-mn-1",
    bossSlug,
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    guild: killGuild,
    deathCount: 2,
    vantusCount: 16,
    roster
  };
}

function storedRead(
  overrides: Partial<StoredRaiderIoLoggedEncounter> = {}
): StoredRaiderIoLoggedEncounter {
  return {
    loggedEncounterId: 700_001,
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    pulledAt: "2026-07-20T17:17:29.977Z",
    defeatedAt: "2026-07-20T17:25:57.301Z",
    durationMs: 507_324,
    guild: killGuild,
    itemLevel: { average: 290.312, min: 284.938, max: 293.062 },
    deathCount: 2,
    vantusCount: 16,
    rosterState: "available",
    members: [bravo, alfa],
    readAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const midnightFalls = kill("midnight-falls", 700_001);

type Gateway = Pick<RaiderIoGateway, "getLoggedEncounter"> &
  Partial<Pick<RaiderIoGateway, "getCharacter">>;

function gateway(overrides: Partial<Gateway> = {}) {
  return {
    getLoggedEncounter: vi.fn<Gateway["getLoggedEncounter"]>(
      async (_raidSlug, id) =>
        encounter(id === 700_001 ? "midnight-falls" : `boss-${String(id)}`)
    ),
    getCharacter: vi.fn<NonNullable<Gateway["getCharacter"]>>(async () => ({
      key,
      displayName: "Alfa",
      className: "Demon Hunter",
      level: 90,
      guild: null,
      ownerId: null,
      profileGuess: null,
      declaredMain: null,
      raiderIoCharacterId: alfaId
    })),
    ...overrides
  };
}

function collect(
  kills: readonly HistoricMythicKill[],
  raiderio: Gateway = gateway(),
  overrides: Partial<Parameters<typeof collectRaiderIoFirstKills>[0]> = {}
) {
  return collectRaiderIoFirstKills({
    key,
    kills,
    published: [],
    storedEncounters: async () => none,
    saveAnswers: async () => undefined,
    raiderio,
    signal: new AbortController().signal,
    now: () => now,
    ...overrides
  });
}

/** A store that keeps what it is given, so two runs can be played back to back. */
function memoryStore() {
  const encounters: StoredRaiderIoLoggedEncounter[] = [];
  const unavailable: StoredRaiderIoLoggedEncounterUnavailable[] = [];
  return {
    storedEncounters: async (
      ids: readonly number[]
    ): Promise<StoredRaiderIoLoggedEncounterAnswers> => ({
      encounters: encounters.filter((item) =>
        ids.includes(item.loggedEncounterId)
      ),
      unavailable: unavailable.filter((item) =>
        ids.includes(item.loggedEncounterId)
      )
    }),
    saveAnswers: async (answers: RaiderIoLoggedEncounterAnswers) => {
      const readAt = now.toISOString();
      encounters.push(
        ...answers.encounters.map((item) => ({ ...item, readAt }))
      );
      unavailable.push(
        ...answers.unavailable.map((item) => ({ ...item, readAt }))
      );
    }
  };
}

describe("collectRaiderIoFirstKills", () => {
  it("reads a first kill's logged encounter and publishes it read, at the log's own time", async () => {
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const result = await collect([midnightFalls], gateway(), {
      saveAnswers: async (answers) => void saved.push(answers)
    });

    expect(result.limitation).toBeNull();
    expect(result.kills).toEqual([
      {
        raidSlug: "tier-mn-1",
        bossSlug: "midnight-falls",
        killedAt: "2026-07-20T17:25:57.301Z",
        guild: killGuild,
        loggedEncounterId: 700_001,
        encounterState: "read",
        encounterLimitationCode: null,
        historicWorldRank: null,
        historicRankCheckedAt: null
      }
    ]);
    expect(saved).toEqual([
      {
        encounters: [
          expect.objectContaining({
            loggedEncounterId: 700_001,
            rosterState: "available",
            members: [bravo, alfa]
          })
        ],
        unavailable: []
      }
    ]);
  });

  it("publishes a kill with no logged encounter as unavailable, without a read", async () => {
    const raiderio = gateway();
    const result = await collect(
      [kill("nexus-king-salhadaar", null, "2025-09-10T20:00:00.000Z")],
      raiderio
    );

    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalled();
    expect(result.kills).toEqual([
      expect.objectContaining({
        killedAt: "2025-09-10T20:00:00.000Z",
        loggedEncounterId: null,
        encounterState: "unavailable",
        encounterLimitationCode: null
      })
    ]);
    expect(result.limitation).toBeNull();
  });

  it(`stops at ${String(MAX_RAIDER_IO_LOGGED_ENCOUNTER_READS_PER_RUN)} reads and names the rest request_cap`, async () => {
    const kills = Array.from({ length: 51 }, (_, index) =>
      kill(`boss-${String(index + 1)}`, index + 1)
    );
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
        encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        })
      )
    });

    const result = await collect(kills, raiderio);

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(50);
    expect(result.kills.at(-1)).toMatchObject({
      loggedEncounterId: 51,
      encounterState: "unavailable",
      encounterLimitationCode: "request_cap"
    });
    expect(result.limitation).toEqual({ code: "request_cap" });
  });

  it("reads at most four encounters at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        });
      })
    });

    await collect(
      Array.from({ length: 10 }, (_, index) =>
        kill(`boss-${String(index + 1)}`, index + 1)
      ),
      raiderio
    );

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(10);
    expect(most).toBe(4);
  });

  it("never reads a visible roster again", async () => {
    const raiderio = gateway();

    const result = await collect([midnightFalls], raiderio, {
      storedEncounters: async () => ({
        encounters: [storedRead({ readAt: "2025-09-28T12:00:00.000Z" })],
        unavailable: []
      })
    });

    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalled();
    expect(result.kills[0]).toMatchObject({ encounterState: "read" });
  });

  it.each([
    [
      "a hidden roster read 8 days ago",
      "private",
      "2026-09-20T11:00:00.000Z",
      1
    ],
    [
      "a hidden roster read 6 days ago",
      "private",
      "2026-09-22T12:00:00.000Z",
      0
    ],
    [
      "a visible roster read a year ago",
      "available",
      "2025-09-28T12:00:00.000Z",
      0
    ]
  ] as const)(
    "reads a hidden roster again after a week, and a visible one never: %s",
    async (_name, rosterState, readAt, reads) => {
      // Break caught (#734 review): a guild can open its roster after the
      // kill, and a roster stored as hidden then stayed hidden for good.
      const raiderio = gateway();

      const result = await collect([midnightFalls], raiderio, {
        storedEncounters: async () => ({
          encounters: [
            storedRead({
              rosterState,
              members: rosterState === "private" ? [] : [bravo, alfa],
              readAt
            })
          ],
          unavailable: []
        })
      });

      expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(reads);
      expect(result.kills[0]).toMatchObject({ encounterState: "read" });
      expect(result.encounters.get(700_001)?.rosterState).toBe(
        reads === 1 ? "available" : rosterState
      );
    }
  );

  it("keeps a hidden roster as read when the re-read is refused, and dates the attempt", async () => {
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const hidden = storedRead({
      rosterState: "private",
      members: [],
      readAt: "2026-09-01T00:00:00.000Z"
    });
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "not_found" as const
      }))
    });

    const result = await collect([midnightFalls], raiderio, {
      storedEncounters: async () => ({ encounters: [hidden], unavailable: [] }),
      saveAnswers: async (answers) => void saved.push(answers)
    });

    expect(result.limitation).toBeNull();
    expect(result.kills[0]).toMatchObject({ encounterState: "read" });
    // Saved again unchanged, so its `read_at` moves and it waits another week.
    const { readAt, ...unchanged } = hidden;
    void readAt;
    expect(saved).toEqual([{ encounters: [unchanged], unavailable: [] }]);
  });

  it.each([
    ["31 days ago", "2026-08-28T11:00:00.000Z", 1],
    ["29 days ago", "2026-08-30T12:00:00.000Z", 0]
  ])(
    "asks again about a permanent answer only after 30 days: stored %s",
    async (_name, readAt, reads) => {
      const raiderio = gateway({
        getLoggedEncounter: vi.fn(async () => ({
          kind: "limitation" as const,
          code: "not_found" as const
        }))
      });

      const result = await collect([midnightFalls], raiderio, {
        storedEncounters: async () => ({
          encounters: [],
          unavailable: [
            { loggedEncounterId: 700_001, code: "not_found", readAt }
          ]
        })
      });

      expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(reads);
      expect(result.kills[0]).toMatchObject({
        encounterState: "unavailable",
        encounterLimitationCode: "not_found"
      });
      expect(result.limitation).toBeNull();
    }
  );

  it("asks once about a deleted log across two runs", async () => {
    // Break caught (#734 review): only a successful read was stored, so a
    // deleted log cost one request on every run for good.
    const store = memoryStore();
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "not_found" as const
      }))
    });

    await collect([midnightFalls], raiderio, store);
    const second = await collect([midnightFalls], raiderio, store);

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(1);
    expect(second.kills[0]).toMatchObject({
      encounterState: "unavailable",
      encounterLimitationCode: "not_found"
    });
    expect(second.limitation).toBeNull();
  });

  it("never spends the cap on permanent answers it already holds", async () => {
    // Break caught (#734 review): 50 refusals at the front of the queue would
    // take the whole cap every run and hold the character partial for good.
    const kills = Array.from({ length: 60 }, (_, index) =>
      kill(`boss-${String(index + 1)}`, index + 1)
    );
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
        encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        })
      )
    });

    const result = await collect(kills, raiderio, {
      storedEncounters: async () => ({
        encounters: [],
        unavailable: Array.from({ length: 50 }, (_, index) => ({
          loggedEncounterId: index + 1,
          code: "not_found" as const,
          readAt: "2026-09-27T00:00:00.000Z"
        }))
      })
    });

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(10);
    expect(result.limitation).toBeNull();
  });

  it("reads every first read before any re-read, and a deferred re-read keeps its answer", async () => {
    const kills = [
      kill("midnight-falls", 700_001),
      ...Array.from({ length: 50 }, (_, index) =>
        kill(`boss-${String(index + 1)}`, index + 1)
      )
    ];
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async (_raidSlug: string, id: number) =>
        encounter(`boss-${String(id)}`, {
          state: "unavailable",
          reason: "private"
        })
      )
    });

    const result = await collect(kills, raiderio, {
      storedEncounters: async () => ({
        encounters: [
          storedRead({
            rosterState: "private",
            members: [],
            readAt: "2026-09-01T00:00:00.000Z"
          })
        ],
        unavailable: []
      })
    });

    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(50);
    expect(raiderio.getLoggedEncounter).not.toHaveBeenCalledWith(
      "tier-mn-1",
      700_001,
      expect.anything(),
      undefined
    );
    expect(result.kills[0]).toMatchObject({
      loggedEncounterId: 700_001,
      encounterState: "read"
    });
    expect(result.limitation).toBeNull();
  });

  it("counts the character present only by its own Raider.IO id on the roster", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () =>
        encounter("midnight-falls", {
          state: "available",
          members: [bravo]
        })
      )
    });

    const result = await collect([midnightFalls], raiderio);

    expect(raiderio.getCharacter).toHaveBeenCalledTimes(1);
    expect(result.kills).toEqual([]);
    expect(result.limitation).toBeNull();
  });

  it("does not ask for the character's id once its presence is established", async () => {
    const published: CharacterRaiderIoFirstKillInput = {
      raidSlug: "tier-mn-1",
      bossSlug: "midnight-falls",
      killedAt: "2026-07-20T17:25:57.301Z",
      guild: killGuild,
      loggedEncounterId: 700_001,
      encounterState: "read",
      encounterLimitationCode: null,
      historicWorldRank: null,
      historicRankCheckedAt: null
    };
    const raiderio = gateway();

    const result = await collect([midnightFalls], raiderio, {
      published: [published]
    });

    expect(raiderio.getCharacter).not.toHaveBeenCalled();
    expect(result.kills).toHaveLength(1);
  });

  it("falls back to Raider.IO's own attribution when the roster is hidden", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () =>
        encounter("midnight-falls", { state: "unavailable", reason: "private" })
      )
    });

    const result = await collect([midnightFalls], raiderio);

    expect(raiderio.getCharacter).not.toHaveBeenCalled();
    expect(result.kills[0]).toMatchObject({ encounterState: "read" });
    expect(result.encounters.get(700_001)).toMatchObject({
      rosterState: "private",
      members: []
    });
  });

  it("withholds unchecked kills and limits the phase when the character's id cannot be learned", async () => {
    const raiderio = gateway({
      getCharacter: vi.fn(async () => {
        throw new Error("raiderio_down");
      })
    });

    const result = await collect([midnightFalls], raiderio);

    expect(result.kills).toEqual([]);
    expect(result.limitation).toEqual({ code: "unavailable" });
  });

  it("abandons the queue once a read throws", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => {
        throw new Error("raiderio_down");
      })
    });

    const result = await collect(
      Array.from({ length: 6 }, (_, index) =>
        kill(`boss-${String(index + 1)}`, index + 1)
      ),
      raiderio
    );

    // The four already in flight when the first one threw, and no more.
    expect(raiderio.getLoggedEncounter).toHaveBeenCalledTimes(4);
    expect(result.limitation).toEqual({ code: "unavailable" });
    expect(
      result.kills.every(
        (item) =>
          item.encounterState === "unavailable" &&
          item.encounterLimitationCode === "unavailable"
      )
    ).toBe(true);
  });

  it("keeps a rate limit's retry time", async () => {
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () => ({
        kind: "limitation" as const,
        code: "rate_limited" as const,
        retryAfterMs: 30_000
      }))
    });

    const result = await collect([midnightFalls], raiderio);

    expect(result.limitation).toEqual({
      code: "rate_limited",
      retryAfterMs: 30_000
    });
  });

  it.each(["not_found", "private", "schema_drift"] as const)(
    "does not hold the run partial for a permanent answer (%s), and stores it",
    async (code) => {
      const saved: RaiderIoLoggedEncounterAnswers[] = [];
      const raiderio = gateway({
        getLoggedEncounter: vi.fn(async () => ({
          kind: "limitation" as const,
          code
        }))
      });

      const result = await collect([midnightFalls], raiderio, {
        saveAnswers: async (answers) => void saved.push(answers)
      });

      expect(result.limitation).toBeNull();
      expect(result.kills[0]).toMatchObject({
        encounterState: "unavailable",
        encounterLimitationCode: code
      });
      expect(saved).toEqual([
        {
          encounters: [],
          unavailable: [{ loggedEncounterId: 700_001, code }]
        }
      ]);
    }
  );

  it("refuses an encounter that names another boss, and stores the refusal", async () => {
    const saved: RaiderIoLoggedEncounterAnswers[] = [];
    const raiderio = gateway({
      getLoggedEncounter: vi.fn(async () =>
        encounter("chimaerus-the-undreamt-god")
      )
    });

    const result = await collect([midnightFalls], raiderio, {
      saveAnswers: async (answers) => void saved.push(answers)
    });

    expect(result.kills[0]).toMatchObject({
      encounterState: "unavailable",
      encounterLimitationCode: "schema_drift"
    });
    expect(result.encounters.size).toBe(0);
    expect(saved[0]?.unavailable).toEqual([
      { loggedEncounterId: 700_001, code: "schema_drift" }
    ]);
  });

  it("keeps a read nobody could store as unread", async () => {
    const result = await collect([midnightFalls], gateway(), {
      saveAnswers: async () => {
        throw new Error("database_down");
      }
    });

    expect(result.kills[0]).toMatchObject({
      encounterState: "unavailable",
      encounterLimitationCode: "unavailable"
    });
    expect(result.limitation).toEqual({ code: "unavailable" });
  });
});

describe("rankRaiderIoFirstKills", () => {
  const readKill: CharacterRaiderIoFirstKillInput = {
    raidSlug: "tier-mn-1",
    bossSlug: "midnight-falls",
    killedAt: "2026-07-20T17:25:57.301Z",
    guild: killGuild,
    loggedEncounterId: 700_001,
    encounterState: "read",
    encounterLimitationCode: null,
    historicWorldRank: null,
    historicRankCheckedAt: null
  };
  const { readAt, ...readEncounter } = storedRead();
  void readAt;
  const encounters = new Map([[700_001, readEncounter]]);
  const guildRank = (firstDefeated: string): MythicBossRanking => ({
    bossSlug: "midnight-falls",
    rank: 3,
    guildName: "Fixture Guild Alfa",
    guildRealm: "twisting-nether",
    guildRegion: "eu",
    firstDefeated
  });

  function rank(
    rows: readonly MythicBossRanking[],
    overrides: Partial<Parameters<typeof rankRaiderIoFirstKills>[0]> = {}
  ) {
    const getMythicBossRankings = vi.fn(async () => ({
      kind: "rankings" as const,
      rows
    }));
    return {
      getMythicBossRankings,
      result: rankRaiderIoFirstKills({
        kills: [readKill],
        encounters,
        warcraftLogsKills: [],
        published: [],
        raiderio: { getMythicBossRankings },
        signal: new AbortController().signal,
        now: () => now,
        ...overrides
      })
    };
  }

  it("gives a later kill with a ranked guild no world rank: the guild's #3 is its own 8 Apr kill", async () => {
    // The problem's dates (#732), with a synthetic guild: the guild is world
    // #3 on Midnight Falls from 2026-04-08T14:54:22Z, and a 20 Jul kill with
    // the same guild must never borrow it.
    const { getMythicBossRankings, result } = rank([
      guildRank("2026-04-08T14:54:22.000Z")
    ]);

    expect(await result).toEqual([
      {
        ...readKill,
        historicWorldRank: null,
        historicRankCheckedAt: "2026-09-28T12:00:00.000Z"
      }
    ]);
    expect(getMythicBossRankings).toHaveBeenCalledWith(
      {
        raidSlug: "tier-mn-1",
        bossSlug: "midnight-falls",
        guild: killGuild
      },
      expect.any(AbortSignal),
      undefined
    );
  });

  it("ranks a guild's own first kill from the encounter guild's exact defeat", async () => {
    const { result } = rank([guildRank("2026-07-20T17:25:57.000Z")]);
    expect((await result)[0]?.historicWorldRank).toBe(3);
  });

  it("asks nothing for a kill a Warcraft Logs kill already matches", async () => {
    const { getMythicBossRankings, result } = rank([], {
      warcraftLogsKills: [
        {
          raidName: "March on Quel'Danas",
          bossName: "Midnight Falls",
          killedAt: "2026-07-20T18:25:00.000Z"
        }
      ]
    });
    expect(await result).toEqual([readKill]);
    expect(getMythicBossRankings).not.toHaveBeenCalled();
  });

  it.each([3, null])(
    "asks nothing again once a rank is checked, a null rank included (%s)",
    async (checkedRank) => {
      // Break caught (#734 pre-flight): a null rank was asked about again on
      // every run, up to 50 requests a run spent on answers that never change.
      const { getMythicBossRankings, result } = rank([], {
        published: [
          {
            ...readKill,
            historicWorldRank: checkedRank,
            historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
          }
        ]
      });
      expect(await result).toEqual([
        {
          ...readKill,
          historicWorldRank: checkedRank,
          historicRankCheckedAt: "2026-09-01T00:00:00.000Z"
        }
      ]);
      expect(getMythicBossRankings).not.toHaveBeenCalled();
    }
  );

  it("asks nothing for a pug", async () => {
    const { getMythicBossRankings, result } = rank([], {
      encounters: new Map([[700_001, { ...readEncounter, guild: null }]])
    });
    expect(await result).toEqual([readKill]);
    expect(getMythicBossRankings).not.toHaveBeenCalled();
  });

  it.each([
    [
      "no logged encounter",
      {
        ...readKill,
        loggedEncounterId: null,
        encounterState: "unavailable" as const
      }
    ],
    [
      "a logged encounter not yet read",
      {
        ...readKill,
        encounterState: "unavailable" as const,
        encounterLimitationCode: "request_cap"
      }
    ]
  ])(
    "asks nothing for a kill with %s, which is never a kill event of its own",
    async (_name, unread) => {
      // Break caught (#734 pre-flight): ranked from Raider.IO's attribution,
      // such kills cost rank requests the dossier could never show.
      const { getMythicBossRankings, result } = rank([], {
        kills: [unread],
        encounters: new Map()
      });
      expect(await result).toEqual([unread]);
      expect(getMythicBossRankings).not.toHaveBeenCalled();
    }
  );
});
