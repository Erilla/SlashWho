import type { HistoricMythicKill } from "@slashwho/raiderio";
import { raiderIoHistoricTierOrdinals } from "@slashwho/raiderio";
import { describe, expect, it } from "vitest";

import {
  raiderIoVerifiedKills,
  searchableKills,
  storedKillReportCodes
} from "./verified-kills";

const key = { region: "eu", realm: "silvermoon", name: "ryun" } as const;
const guild = { name: "SeriouslyCasual", realm: "silvermoon", region: "eu" };
const azshara: HistoricMythicKill = {
  raidSlug: "the-eternal-palace",
  bossSlug: "queen-azshara",
  firstDefeated: "2020-01-21T19:34:00.000Z",
  guild
};

describe("searchableKills", () => {
  it("offers an unheld kill with its guild as a place to search", () => {
    expect(searchableKills([azshara], { storedKills: [] })).toEqual([
      { at: "2020-01-21T19:34:00.000Z", guild }
    ]);
  });

  it("does not search for a kill stored evidence already holds", () => {
    // Held: its stored report is re-read through `storedKillReportCodes`
    // instead, so a search would only find it again.
    expect(
      searchableKills([azshara], {
        storedKills: [{ killedAt: "2020-01-21T19:41:12.000Z" }]
      })
    ).toEqual([]);
  });

  it("recognises a held kill whose Raider.IO time is an hour off", () => {
    // Break caught: Ryun's Queen Azshara is stored at 20:34:49Z from
    // zCFtRjmLgvHxynh7, and Raider.IO puts the same kill at 19:34:00Z -- a
    // whole-hour clock error (1 of 36 matched pairs measured 2026-09-23). A
    // 15-minute match called it unheld, so it would be searched every run.
    expect(
      searchableKills([azshara], {
        storedKills: [{ killedAt: "2020-01-21T20:34:49.222Z" }]
      })
    ).toEqual([]);
  });

  it("keeps a kill whose only stored neighbour is another night", () => {
    expect(
      searchableKills([azshara], {
        storedKills: [{ killedAt: "2020-01-28T19:34:00.000Z" }]
      })
    ).toHaveLength(1);
  });

  it("drops kills below the scan floor, which are already settled", () => {
    expect(
      searchableKills([azshara], {
        storedKills: [],
        killScanFloor: "2021-01-01T00:00:00.000Z"
      })
    ).toEqual([]);
  });

  it("drops a guildless kill, which has no attendance to search", () => {
    expect(
      searchableKills([{ ...azshara, guild: null }], { storedKills: [] })
    ).toEqual([]);
  });

  it("drops a kill in a region Warcraft Logs is not searched in", () => {
    expect(
      searchableKills([{ ...azshara, guild: { ...guild, region: "cn" } }], {
        storedKills: []
      })
    ).toEqual([]);
  });
});

describe("raiderIoVerifiedKills", () => {
  it("asks for every pinned tier", async () => {
    const asked: number[][] = [];
    await raiderIoVerifiedKills(
      {
        getHistoricMythicKills: async (_key, options) => {
          asked.push([...options.tierOrdinals]);
          return { kind: "evidence", kills: [] };
        }
      },
      key,
      { storedKills: [] }
    );

    expect(asked).toEqual([[...raiderIoHistoricTierOrdinals]]);
  });

  it("names Raider.IO's limitation and offers nothing to search", async () => {
    // A private or unavailable profile skips recovery; it must not become an
    // error that fails the run, or a partial that retries forever.
    await expect(
      raiderIoVerifiedKills(
        {
          getHistoricMythicKills: async () => ({
            kind: "limitation",
            code: "private"
          })
        },
        key,
        { storedKills: [] }
      )
    ).resolves.toEqual({ kills: [], limitation: "private" });
  });

  it("treats a thrown lookup as unavailable", async () => {
    await expect(
      raiderIoVerifiedKills(
        {
          getHistoricMythicKills: async () => {
            throw new Error("socket hang up");
          }
        },
        key,
        { storedKills: [] }
      )
    ).resolves.toEqual({ kills: [], limitation: "unavailable" });
  });

  it("rethrows a cancellation rather than calling it unavailable", async () => {
    const controller = new AbortController();
    const reason = new Error("shutdown");
    controller.abort(reason);

    await expect(
      raiderIoVerifiedKills(
        {
          getHistoricMythicKills: async () => {
            throw reason;
          }
        },
        key,
        { storedKills: [], signal: controller.signal }
      )
    ).rejects.toBe(reason);
  });
});

describe("storedKillReportCodes", () => {
  it("lists the reports of stored kills outside terminal raids, once each", () => {
    // Break caught (review on #436): the re-read list came from Raider.IO's
    // answer, so a Raider.IO failure left the run complete with nothing
    // re-read, and the complete publish dropped every kill attendance had
    // recovered. The list is stored evidence's, whatever Raider.IO says.
    expect(
      storedKillReportCodes(
        [
          {
            raidId: "23",
            reportUrl: "https://www.warcraftlogs.com/reports/zCFtRjmLgvHxynh7"
          },
          {
            raidId: "23",
            reportUrl:
              "https://www.warcraftlogs.com/reports/zCFtRjmLgvHxynh7#fight=8"
          },
          {
            raidId: "2450",
            reportUrl: "https://www.warcraftlogs.com/reports/terminalRaidLog"
          },
          { raidId: "23" }
        ],
        new Set(["2450"])
      )
    ).toEqual(["zCFtRjmLgvHxynh7"]);
  });
});
