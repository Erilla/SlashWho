import type { GuildTimelineSpan } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { layoutGuildTimeline } from "./guild-timeline-layout";

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
  pixelsPerYear: 120,
  labelWidth: (text: string) => text.length * 7,
  padding: 0
};

describe("layoutGuildTimeline", () => {
  it("runs from the first night's year to the year after today", () => {
    const layout = layoutGuildTimeline(
      [span("Rancour", "2024-09-22", "2026-09-24")],
      options
    );
    expect(layout.startsOn).toBe("2024-01-01");
    expect(layout.endsOn).toBe("2027-01-01");
    expect(layout.x("2025-01-01")).toBeCloseTo(120, 0);
    expect(layout.width).toBeGreaterThanOrEqual(360);
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
    expect(layout.width).toBeGreaterThanOrEqual(layout.x("2026-12-30") + 48);
  });

  it("keeps a single-night stretch visible", () => {
    const [bar] = layoutGuildTimeline(
      [span("Rancour", "2025-01-01", "2025-01-01")],
      options
    ).bars;
    expect(bar?.width).toBeGreaterThanOrEqual(4);
  });
});
