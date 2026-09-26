import type { GuildTimelineSpan } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { layoutGuildTimeline, tierBands } from "./guild-timeline-layout";

describe("tierBands", () => {
  const tiers = [
    { name: "A", raidNames: ["A"], startsOn: "2017-11-28" },
    { name: "B", raidNames: ["B"], startsOn: "2018-09-04" },
    { name: "C", raidNames: ["C"], startsOn: "2019-01-22" },
    { name: "D", raidNames: ["D"], startsOn: "2027-06-01" }
  ];

  it("covers the axis tier by tier, clipping the tier under way at each end", () => {
    expect(
      tierBands(tiers, "2018-01-01", "2020-01-01").map((band) => [
        band.tier.name,
        band.from,
        band.to
      ])
    ).toEqual([
      ["A", "2018-01-01", "2018-09-04"],
      ["B", "2018-09-04", "2019-01-22"],
      ["C", "2019-01-22", "2020-01-01"]
    ]);
  });

  it("alternates by position in the schedule, not on the axis", () => {
    expect(
      tierBands(tiers, "2018-10-01", "2020-01-01").map((band) => [
        band.tier.name,
        band.shaded
      ])
    ).toEqual([
      ["B", true],
      ["C", false]
    ]);
  });
});

function span(
  name: string,
  firstNight: string,
  lastNight: string
): GuildTimelineSpan {
  return {
    guild: { name, region: "eu", realm: "draenor" },
    guildId: name,
    firstNight,
    lastNight,
    nights: 2,
    characters: [],
    tiers: []
  };
}

const options = {
  today: "2026-09-26",
  minimumPixelsPerYear: 120,
  labelWidth: (text: string) => text.length * 7,
  padding: 0
};

describe("layoutGuildTimeline", () => {
  it("runs from the first night's year to today", () => {
    const layout = layoutGuildTimeline(
      [span("Rancour", "2024-09-22", "2026-09-24")],
      options
    );
    expect(layout.startsOn).toBe("2024-01-01");
    expect(layout.endsOn).toBe("2026-09-27");
    expect(layout.x("2025-01-01")).toBeCloseTo(120, 0);
  });

  it("stretches a short history to fill the width it is given", () => {
    const layout = layoutGuildTimeline(
      [span("Rancour", "2024-09-22", "2026-09-24")],
      { ...options, fitWidth: 1300 }
    );
    expect(layout.width).toBe(1300);
    // The latest bar ends within the room kept for today's markers.
    const [bar] = layout.bars;
    expect(1300 - (bar!.x + bar!.width)).toBeLessThan(60);
  });

  it("keeps its minimum scale, and scrolls, when the width is too narrow", () => {
    const layout = layoutGuildTimeline(
      [span("SeriouslyCasual", "2018-03-14", "2026-09-24")],
      { ...options, fitWidth: 300 }
    );
    expect(layout.x("2019-01-01")).toBeCloseTo(120, 0);
    expect(layout.width).toBeGreaterThan(300);
  });

  it("gives overlapping guilds their own rows", () => {
    const layout = layoutGuildTimeline(
      [
        span("SeriouslyCasual", "2021-01-03", "2024-06-19"),
        span("do u need", "2022-08-14", "2023-12-10")
      ],
      options
    );
    expect(layout.bars.map((bar) => bar.lane)).toEqual([0, 1]);
    expect(layout.lanes).toBe(2);
  });

  it("puts a bar in the highest row with room for it", () => {
    const layout = layoutGuildTimeline(
      [
        span("SeriouslyCasual", "2019-10-16", "2024-06-19"),
        span("do u need", "2022-08-14", "2023-12-10"),
        span("Rancour", "2024-09-22", "2026-09-24")
      ],
      options
    );
    expect(layout.bars.map((bar) => [bar.guild.name, bar.lane])).toEqual([
      ["SeriouslyCasual", 0],
      ["do u need", 1],
      ["Rancour", 0]
    ]);
  });

  it("counts a label beside a narrow bar as part of the room it takes", () => {
    // The 2018 bar is too short for its name, so the name sits to its right
    // and the next bar, which starts under that name, drops a row.
    const layout = layoutGuildTimeline(
      [
        span("SeriouslyCasual", "2018-03-14", "2018-07-18"),
        span("SeriouslyCasual", "2018-10-01", "2019-06-01")
      ],
      options
    );
    expect(layout.bars[0]?.labelInside).toBe(false);
    expect(layout.bars.map((bar) => bar.lane)).toEqual([0, 1]);
  });

  it("leaves room past today for the current-guild markers in late December", () => {
    const layout = layoutGuildTimeline(
      [span("Rancour", "2025-01-01", "2026-12-20")],
      { ...options, today: "2026-12-30" }
    );
    expect(layout.width).toBeGreaterThanOrEqual(
      Math.floor(layout.x("2026-12-30") + 48)
    );
  });

  it("keeps a single-night stretch visible", () => {
    const [bar] = layoutGuildTimeline(
      [span("Rancour", "2025-01-01", "2025-01-01")],
      options
    ).bars;
    expect(bar?.width).toBeGreaterThanOrEqual(4);
  });
});
