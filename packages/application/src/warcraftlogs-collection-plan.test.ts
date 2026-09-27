import type { WarcraftLogsFirstKillEvidence } from "@slashwho/warcraftlogs";
import { describe, expect, it } from "vitest";

import {
  createWarcraftLogsCollectionPlan,
  parseGroupPlan,
  tierZonePlan
} from "./warcraftlogs-collection-plan";

function kill(
  overrides: Partial<WarcraftLogsFirstKillEvidence> &
    Pick<WarcraftLogsFirstKillEvidence, "raidId" | "raidName" | "killedAt">
): WarcraftLogsFirstKillEvidence {
  const reportCode = overrides.reportCode ?? "report";
  const fightId = overrides.fightId ?? 1;
  const reportUrl = `https://www.warcraftlogs.com/reports/${reportCode}`;
  return {
    bossId: "1",
    bossName: "Boss",
    journalBossId: null,
    bossOrder: 1,
    reportCode,
    fightId,
    difficulty: 5,
    performance: {
      spec: null,
      damage: { state: "unavailable" },
      healing: { state: "unavailable" },
      bossDamage: { state: "unavailable" }
    },
    reportUrl,
    fightUrl: `${reportUrl}#fight=${fightId}`,
    guild: null,
    uploader: null,
    ...overrides
  };
}

// Real windowed tiers, so the catalogue can place each in the Mythic era.
const nerubar = { raidId: "101", raidName: "Nerub-ar Palace" };
const undermine = { raidId: "102", raidName: "Liberation of Undermine" };
const manaforge = { raidId: "103", raidName: "Manaforge Omega" };

describe("tierZonePlan", () => {
  const kills = [
    kill({ ...nerubar, killedAt: "2024-10-01T00:00:00.000Z" }),
    kill({ ...manaforge, killedAt: "2025-09-01T00:00:00.000Z" }),
    kill({ ...undermine, killedAt: "2025-04-01T00:00:00.000Z" })
  ];
  const zoneIds = (zones: readonly { zoneId: number }[]) =>
    zones.map((zone) => zone.zoneId);

  it("reaches the newest zones first with half the budget left after identities", () => {
    // (5 - 1) / 2 = 2 zones.
    const plan = tierZonePlan(kills, { parseRequestCap: 5 });
    expect(zoneIds(plan.zones)).toEqual([103, 102]);
    expect(zoneIds(plan.unreached)).toEqual([101]);
  });

  it("buys no zones from a budget with nothing to spare", () => {
    const plan = tierZonePlan(kills, { parseRequestCap: 2 });
    expect(plan.zones).toEqual([]);
    expect(zoneIds(plan.unreached)).toEqual([103, 102, 101]);
  });

  it("drops terminal and already collected zones before measuring the budget", () => {
    const plan = tierZonePlan(kills, {
      parseRequestCap: 3,
      terminalRaidIds: { tierBests: new Set(["103"]) },
      collectedTierZones: new Map([["102", "2025-05-01T00:00:00.000Z"]])
    });
    expect(zoneIds(plan.zones)).toEqual([101]);
    expect(plan.unreached).toEqual([]);
  });

  it("spends nothing on a zone outside its raid's content window", () => {
    const plan = tierZonePlan(
      [kill({ ...nerubar, killedAt: "2026-06-01T00:00:00.000Z" })],
      { parseRequestCap: 5 }
    );
    expect(plan.zones).toEqual([]);
    expect(plan.unreached).toEqual([]);
  });
});

describe("parseGroupPlan", () => {
  it("groups by report and orders first kills before repeats, newest first", () => {
    const plan = parseGroupPlan(
      [
        kill({
          ...undermine,
          killedAt: "2025-04-08T00:00:00.000Z",
          reportCode: "repeat",
          fightId: 3
        }),
        kill({
          ...undermine,
          killedAt: "2025-04-01T00:00:00.000Z",
          reportCode: "first",
          fightId: 1
        }),
        kill({
          ...undermine,
          bossId: "2",
          killedAt: "2025-04-01T01:00:00.000Z",
          reportCode: "first",
          fightId: 2
        }),
        kill({
          ...nerubar,
          killedAt: "2024-10-01T00:00:00.000Z",
          reportCode: "older",
          fightId: 1
        })
      ],
      {}
    );
    expect(plan.groups.map((group) => group.reportCode)).toEqual([
      "first",
      "older",
      "repeat"
    ]);
    expect([...plan.groups[0]!.fights.keys()]).toEqual([1, 2]);
    expect([...(plan.raidIds.get("first") ?? [])]).toEqual(["102"]);
  });

  it("leaves out stored fights, terminal raids and other raids' kills", () => {
    const stored = kill({
      ...undermine,
      killedAt: "2025-04-01T00:00:00.000Z",
      reportCode: "stored"
    });
    const plan = parseGroupPlan(
      [
        stored,
        kill({
          ...nerubar,
          killedAt: "2024-10-01T00:00:00.000Z",
          reportCode: "terminal"
        }),
        kill({
          ...manaforge,
          killedAt: "2025-09-01T00:00:00.000Z",
          reportCode: "wanted"
        })
      ],
      {
        hydratedFightUrls: new Set([stored.fightUrl]),
        terminalRaidIds: { parses: new Set(["101"]) }
      }
    );
    expect(plan.groups.map((group) => group.reportCode)).toEqual(["wanted"]);
  });
});

describe("createWarcraftLogsCollectionPlan", () => {
  it("measures the zone budget against the cap the gateway holds", () => {
    const kills = [
      kill({ ...nerubar, killedAt: "2024-10-01T00:00:00.000Z" }),
      kill({ ...manaforge, killedAt: "2025-09-01T00:00:00.000Z" })
    ];
    const plan = createWarcraftLogsCollectionPlan({
      terminalRaidIds: { parses: new Set(), tierBests: new Set(["103"]) }
    });
    expect(plan.tierZones(kills, 5)).toEqual(
      tierZonePlan(kills, {
        parseRequestCap: 5,
        terminalRaidIds: { tierBests: new Set(["103"]) }
      })
    );
    expect(plan.tierZones(kills, 2).zones).toEqual([]);
  });

  it("groups fights with the options it was built with", () => {
    const stored = kill({
      ...undermine,
      killedAt: "2025-04-01T00:00:00.000Z",
      reportCode: "stored"
    });
    const plan = createWarcraftLogsCollectionPlan({
      hydratedFightUrls: new Set([stored.fightUrl])
    });
    expect(plan.parseGroups([stored]).groups).toEqual([]);
  });
});
