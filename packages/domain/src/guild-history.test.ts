import { describe, expect, it } from "vitest";

import type { CharacterKey } from "./character-key";
import {
  collectGuildRaidNights,
  guildIdentity,
  guildTimelineSpans,
  type DossierGuildHistoryEntry
} from "./guild-history";
import type { RaidTier } from "./raid-catalogue";

const ryii: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryii" };
const ryun: CharacterKey = { region: "eu", realm: "silvermoon", name: "ryun" };
const rancour = { name: "Rancour", region: "eu", realm: "draenor" } as const;
const casual = {
  name: "SeriouslyCasual",
  region: "eu",
  realm: "silvermoon"
} as const;

function kill(
  character: CharacterKey,
  killedAt: string,
  guild: DossierGuildHistoryEntry["guild"] | null
) {
  return { character, killedAt, guild };
}

const tiers: RaidTier[] = [
  { name: "Tier A", raidNames: ["Tier A"], startsOn: "2024-01-01" },
  { name: "Tier B", raidNames: ["Tier B"], startsOn: "2024-04-01" },
  { name: "Tier C", raidNames: ["Tier C"], startsOn: "2024-08-01" },
  { name: "Tier D", raidNames: ["Tier D"], startsOn: "2024-12-01" }
];

function history(
  guild: DossierGuildHistoryEntry["guild"],
  dates: readonly string[],
  characters: readonly CharacterKey[] = [ryii]
): DossierGuildHistoryEntry {
  return { guild, nights: dates.map((date) => ({ date, characters })) };
}

describe("collectGuildRaidNights", () => {
  it("groups kills into UTC raid nights per guild with the characters seen", () => {
    expect(
      collectGuildRaidNights([
        kill(ryii, "2025-03-09T20:10:00.000Z", rancour),
        kill(ryii, "2025-03-09T21:40:00.000Z", rancour),
        kill(ryun, "2025-03-09T22:00:00.000Z", rancour),
        kill(ryii, "2025-03-16T20:00:00.000Z", rancour)
      ])
    ).toEqual([
      {
        guild: rancour,
        nights: [
          { date: "2025-03-09", characters: [ryii, ryun] },
          { date: "2025-03-16", characters: [ryii] }
        ]
      }
    ]);
  });

  it("ignores kills whose report names no guild", () => {
    expect(
      collectGuildRaidNights([kill(ryii, "2025-03-09T20:10:00.000Z", null)])
    ).toEqual([]);
  });

  it("treats names differing only in case or spaces as one guild, named as most recently seen", () => {
    const [entry, ...rest] = collectGuildRaidNights([
      kill(ryun, "2019-10-30T20:00:00.000Z", {
        ...casual,
        name: "Seriously Casual"
      }),
      kill(ryun, "2019-11-03T20:00:00.000Z", casual)
    ]);
    expect(rest).toEqual([]);
    expect(entry?.guild).toEqual(casual);
    expect(entry?.nights.map((night) => night.date)).toEqual([
      "2019-10-30",
      "2019-11-03"
    ]);
  });

  it("keeps guilds of the same name on different realms apart", () => {
    expect(
      collectGuildRaidNights([
        kill(ryii, "2025-03-09T20:00:00.000Z", rancour),
        kill(ryii, "2025-03-10T20:00:00.000Z", {
          ...rancour,
          realm: "silvermoon"
        })
      ])
    ).toHaveLength(2);
  });

  it("orders guilds by their first raid night", () => {
    expect(
      collectGuildRaidNights([
        kill(ryii, "2025-03-09T20:00:00.000Z", rancour),
        kill(ryun, "2019-11-03T20:00:00.000Z", casual)
      ]).map((entry) => entry.guild.name)
    ).toEqual(["SeriouslyCasual", "Rancour"]);
  });
});

describe("guildIdentity", () => {
  it("ignores case and spacing in the name and realm", () => {
    expect(guildIdentity({ ...casual, name: "Seriously Casual" })).toBe(
      guildIdentity({ ...casual, realm: "Silvermoon" })
    );
  });
});

describe("guildTimelineSpans", () => {
  it("hides a guild with only one raid night", () => {
    expect(
      guildTimelineSpans([history(rancour, ["2024-02-01"])], { tiers })
    ).toEqual([]);
  });

  it("keeps a guild continuous across neighbouring tiers", () => {
    const spans = guildTimelineSpans(
      [history(rancour, ["2024-02-01", "2024-05-01", "2024-09-01"])],
      { tiers }
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      firstNight: "2024-02-01",
      lastNight: "2024-09-01",
      nights: 3,
      tiers: ["Tier A", "Tier B", "Tier C"]
    });
  });

  it("splits a guild where a whole tier passed without a raid night", () => {
    const spans = guildTimelineSpans(
      [
        history(rancour, [
          "2024-02-01",
          "2024-03-01",
          "2024-09-01",
          "2024-12-05"
        ])
      ],
      { tiers }
    );
    expect(
      spans.map((span) => [span.firstNight, span.lastNight, span.nights])
    ).toEqual([
      ["2024-02-01", "2024-03-01", 2],
      ["2024-09-01", "2024-12-05", 2]
    ]);
  });

  it("drops nights of hidden characters before deciding what to show", () => {
    const entry: DossierGuildHistoryEntry = {
      guild: rancour,
      nights: [
        { date: "2024-02-01", characters: [ryii] },
        { date: "2024-02-08", characters: [ryun] }
      ]
    };
    expect(guildTimelineSpans([entry], { tiers })).toHaveLength(1);
    expect(
      guildTimelineSpans([entry], {
        tiers,
        isCharacterVisible: (key) => key.name !== "ryun"
      })
    ).toEqual([]);
  });

  it("lists the characters seen in each span", () => {
    const [span] = guildTimelineSpans(
      [
        {
          guild: rancour,
          nights: [
            { date: "2024-02-01", characters: [ryii] },
            { date: "2024-02-08", characters: [ryii, ryun] }
          ]
        }
      ],
      { tiers }
    );
    expect(span?.characters).toEqual([ryii, ryun]);
  });

  it("joins nights before the first known tier into one span", () => {
    expect(
      guildTimelineSpans([history(rancour, ["2010-01-01", "2012-01-01"])], {
        tiers
      })
    ).toMatchObject([{ firstNight: "2010-01-01", tiers: [] }]);
  });

  it("orders spans from every guild by their first night", () => {
    expect(
      guildTimelineSpans(
        [
          history(rancour, ["2024-05-01", "2024-05-08"]),
          history(casual, ["2024-02-01", "2024-02-08"])
        ],
        { tiers }
      ).map((span) => span.guild.name)
    ).toEqual(["SeriouslyCasual", "Rancour"]);
  });
});
