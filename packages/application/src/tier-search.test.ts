import { supportedRaidCatalogue } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import {
  tierSearchGuilds,
  tierSearchRequestCaps,
  tierSearchStates,
  tierSearchWindow,
  tierSearchZoneIds
} from "./tier-search";

const eternalPalace = supportedRaidCatalogue().find(
  (raid) => raid.raidName === "The Eternal Palace"
)!;

describe("tier search policy", () => {
  it("searches a concluded tier across its current-content window", () => {
    const window = tierSearchWindow(
      eternalPalace.raidId,
      new Date("2026-09-23T12:00:00.000Z")
    );

    expect(window).not.toBeNull();
    expect(window!.from < window!.to).toBe(true);
    expect(window!.from.startsWith("2019-")).toBe(true);
    expect(window!.to.startsWith("2020-")).toBe(true);
  });

  it("has no window for a raid the catalogue does not know", () => {
    expect(tierSearchWindow("not-a-raid", new Date())).toBeNull();
  });

  it("names the Warcraft Logs zones stored evidence places in the tier", () => {
    // Break caught: terminal marks are keyed by Warcraft Logs zone and the
    // dossier by Journal raid, so ignoring the tier's marks needs the one
    // translated into the other.
    const zones = tierSearchZoneIds(eternalPalace.raidId, {
      kills: [
        {
          raidId: "23",
          raidName: "The Eternal Palace",
          killedAt: "2019-08-01T20:00:00.000Z"
        },
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          killedAt: "2024-10-01T20:00:00.000Z"
        }
      ],
      wipes: [
        {
          raidId: "2023",
          raidName: "The Eternal Palace",
          attemptedAt: "2019-08-01T19:00:00.000Z"
        }
      ]
    });

    expect([...zones].sort()).toEqual(["2023", "23"]);
  });

  it("carves its cap out of the scan's rather than adding to the run's", () => {
    // The run budget is guarded as one number; a tier search that added its
    // own on top would spend past it unseen.
    expect(tierSearchRequestCaps(300, 60)).toEqual({ history: 240, tier: 60 });
    expect(tierSearchRequestCaps(18, 60)).toEqual({ history: 9, tier: 9 });
    expect(tierSearchRequestCaps(4, 60)).toEqual({ history: 2, tier: 2 });
  });

  it("does not split a cap so small the history scan could not re-read", () => {
    // Break caught (review): a scan cap of 2 split to 1 + 1 left a one-request
    // history scan, which re-reads no stored report -- so its complete
    // publish dropped kills attendance had recovered on an earlier run.
    expect(tierSearchRequestCaps(3, 60)).toEqual({ history: 3, tier: 0 });
    expect(tierSearchRequestCaps(2, 60)).toEqual({ history: 2, tier: 0 });
    expect(tierSearchRequestCaps(1, 60)).toEqual({ history: 1, tier: 0 });
  });

  it("walks every guild known for the character, once each", () => {
    expect(
      tierSearchGuilds(
        [
          { name: "Guild", realm: "silvermoon", region: "eu" },
          { name: "Other", realm: "silvermoon", region: "eu" }
        ],
        [{ name: "guild", realm: "Silvermoon", region: "eu" }]
      )
    ).toEqual([
      { name: "Guild", realm: "silvermoon", region: "eu" },
      { name: "Other", realm: "silvermoon", region: "eu" }
    ]);
  });

  it("shows a search in flight, then as searched until it may run again", () => {
    const now = new Date("2026-09-23T12:00:00.000Z");
    const hoursAgo = (hours: number) =>
      new Date(now.getTime() - hours * 60 * 60 * 1_000);

    const states = tierSearchStates(
      [
        { raidId: "queued", status: "queued", createdAt: hoursAgo(0) },
        { raidId: "retrying", status: "retrying", createdAt: hoursAgo(1) },
        { raidId: "running", status: "running", createdAt: hoursAgo(0) },
        { raidId: "done", status: "complete", createdAt: hoursAgo(6) },
        // A failed search was still paid for, so it holds the limit too.
        { raidId: "failed", status: "failed", createdAt: hoursAgo(6) },
        { raidId: "expired", status: "partial", createdAt: hoursAgo(25) }
      ],
      now
    );

    expect(
      Object.fromEntries([...states].map(([id, s]) => [id, s.state]))
    ).toEqual({
      queued: "queued",
      retrying: "queued",
      running: "running",
      done: "searched",
      failed: "searched"
    });
    expect(states.get("done")).toEqual({
      state: "searched",
      searchedAt: "2026-09-23T06:00:00.000Z",
      searchableAgainAt: "2026-09-24T06:00:00.000Z"
    });
  });
});
