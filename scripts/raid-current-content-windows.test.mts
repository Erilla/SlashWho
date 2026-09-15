import { describe, expect, it } from "vitest";

import {
  fetchRaidCurrentContentWindows,
  normalizeRaidCurrentContentWindow,
  normalizeRaidCurrentContentWindows
} from "./raid-current-content-windows.mts";

function raid(overrides: Record<string, unknown> = {}) {
  return {
    slug: "sepulcher-of-the-first-ones",
    starts: {
      us: "2022-03-01T15:00:00Z",
      eu: "2022-03-02T04:00:00Z",
      kr: "2022-03-02T23:00:00Z"
    },
    ends: {
      us: "2022-08-02T15:00:00Z",
      eu: "2022-08-03T04:00:00Z",
      kr: "2022-08-03T23:00:00Z"
    },
    ...overrides
  };
}

describe("normalizeRaidCurrentContentWindow", () => {
  // Break caught: taking one region's schedule judged a kill legacy because
  // another region's reset landed first. The window is the union.
  it("spans the earliest regional opening to the latest regional close", () => {
    expect(normalizeRaidCurrentContentWindow(raid())).toEqual({
      slug: "sepulcher-of-the-first-ones",
      window: {
        startsAt: "2022-03-01T15:00:00.000Z",
        endsAt: "2022-08-03T23:00:00.000Z"
      }
    });
  });

  // Break caught: recording Raider.IO's far-future placeholder verbatim would
  // expire an open tier on a date Blizzard never announced.
  it("treats a far-future placeholder close as open-ended", () => {
    expect(
      normalizeRaidCurrentContentWindow(
        raid({
          slug: "the-venomous-abyss",
          starts: { us: "2026-08-18T15:00:00Z" },
          ends: { us: "2030-01-01T00:00:00Z" }
        })
      )
    ).toEqual({
      slug: "the-venomous-abyss",
      window: { startsAt: "2026-08-18T15:00:00.000Z", endsAt: null }
    });
  });

  it("treats a missing close as open-ended", () => {
    expect(
      normalizeRaidCurrentContentWindow(raid({ ends: undefined }))?.window
    ).toEqual({ startsAt: "2022-03-01T15:00:00.000Z", endsAt: null });
  });

  it("ignores a raid with no usable slug or opening", () => {
    expect(normalizeRaidCurrentContentWindow(raid({ slug: 7 }))).toBeNull();
    expect(normalizeRaidCurrentContentWindow(raid({ starts: {} }))).toBeNull();
    expect(
      normalizeRaidCurrentContentWindow(raid({ starts: { us: "not-a-date" } }))
    ).toBeNull();
  });

  it("ignores a window that closes at or before it opens", () => {
    expect(
      normalizeRaidCurrentContentWindow(
        raid({ ends: { us: "2022-03-01T15:00:00Z" } })
      )
    ).toBeNull();
  });
});

describe("normalizeRaidCurrentContentWindows", () => {
  it("merges expansion payloads into one slug-keyed, sorted snapshot", () => {
    expect(
      Object.keys(
        normalizeRaidCurrentContentWindows([
          { raids: [raid({ slug: "uldir" })] },
          { raids: [raid({ slug: "antorus-the-burning-throne" })] },
          { unexpected: true },
          null
        ])
      )
    ).toEqual(["antorus-the-burning-throne", "uldir"]);
  });
});

describe("fetchRaidCurrentContentWindows", () => {
  function respond(
    byExpansion: Readonly<Record<string, { status: number; body?: unknown }>>
  ) {
    return async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const expansionId = url.searchParams.get("expansion_id") ?? "";
      const reply = byExpansion[expansionId] ?? { status: 400 };
      return new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        { status: reply.status }
      );
    };
  }

  // Break caught: Raider.IO answers 400 for expansions it does not serve.
  // Failing on those would leave the project with no generated windows at all.
  it("skips expansions Raider.IO does not serve", async () => {
    const windows = await fetchRaidCurrentContentWindows({
      fetch: respond({ "7": { status: 200, body: { raids: [raid()] } } }),
      baseUrl: new URL("https://raider.io"),
      expansionIds: [6, 7]
    });
    expect(Object.keys(windows)).toEqual(["sepulcher-of-the-first-ones"]);
  });

  it("fails when Raider.IO errors rather than generating a partial snapshot", async () => {
    await expect(
      fetchRaidCurrentContentWindows({
        fetch: respond({ "7": { status: 500 } }),
        baseUrl: new URL("https://raider.io"),
        expansionIds: [7]
      })
    ).rejects.toThrow("raiderio_static_data_failed");
  });

  it("fails when no expansion yields a window", async () => {
    await expect(
      fetchRaidCurrentContentWindows({
        fetch: respond({}),
        baseUrl: new URL("https://raider.io"),
        expansionIds: [6, 7]
      })
    ).rejects.toThrow("raiderio_static_data_empty");
  });
});
