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

  it("places a combined zone in the tier by its boss", () => {
    // Break caught (#492 review): `VS / DR / MQD` names no raid, so a search
    // of The Voidspire could not ignore that zone's parse marks.
    const voidspire = supportedRaidCatalogue().find(
      (raid) => raid.raidName === "The Voidspire"
    )!;
    const combined = (bossName: string) => ({
      raidId: "46",
      raidName: "VS / DR / MQD",
      bossName,
      journalBossId: null,
      killedAt: "2026-04-01T20:00:00.000Z"
    });

    expect([
      ...tierSearchZoneIds(voidspire.raidId, {
        kills: [combined("Imperator Averzian")],
        wipes: []
      })
    ]).toEqual(["46"]);
    expect([
      ...tierSearchZoneIds(voidspire.raidId, {
        kills: [combined("Chimaerus the Undreamt God")],
        wipes: []
      })
    ]).toEqual([]);
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

  describe("a dossier tier's searches, across its characters", () => {
    const now = new Date("2026-09-23T12:00:00.000Z");
    const hoursAgo = (hours: number) =>
      new Date(now.getTime() - hours * 60 * 60 * 1_000);
    const ryii = { region: "eu", realm: "silvermoon", name: "ryii" } as const;
    const alt = { region: "eu", realm: "silvermoon", name: "alt" } as const;
    const other = { region: "eu", realm: "draenor", name: "other" } as const;
    const renamed = {
      region: "eu",
      realm: "draenor",
      name: "renamed"
    } as const;
    const subjects = [
      { key: ryii, displayName: "Ryii" },
      { key: alt, displayName: "Alt" },
      { key: other, displayName: "Other", aliases: [renamed] }
    ];

    it("shows each character's search in flight, then as it ended", () => {
      const states = tierSearchStates(
        [
          { key: ryii, displayName: "Ryii" },
          { key: alt, displayName: "Alt" }
        ],
        [
          {
            key: ryii,
            raidId: "queued",
            status: "queued",
            createdAt: hoursAgo(0)
          },
          {
            key: ryii,
            raidId: "retrying",
            status: "retrying",
            createdAt: hoursAgo(1)
          },
          {
            key: ryii,
            raidId: "running",
            status: "running",
            createdAt: hoursAgo(0)
          },
          {
            key: ryii,
            raidId: "done",
            status: "complete",
            createdAt: hoursAgo(6)
          },
          {
            key: alt,
            raidId: "done",
            status: "partial",
            createdAt: hoursAgo(5)
          },
          // A failed search was still paid for, so it holds the limit too.
          {
            key: ryii,
            raidId: "failed",
            status: "failed",
            createdAt: hoursAgo(6)
          },
          {
            key: alt,
            raidId: "failed",
            status: "complete",
            createdAt: hoursAgo(6)
          },
          {
            key: ryii,
            raidId: "expired",
            status: "partial",
            createdAt: hoursAgo(25)
          }
        ],
        now
      );

      expect(
        Object.fromEntries(
          [...states].map(([id, search]) => [
            id,
            search.characters.map((character) => character.state)
          ])
        )
      ).toEqual({
        queued: ["queued", "not_searched"],
        retrying: ["queued", "not_searched"],
        running: ["running", "not_searched"],
        done: ["completed", "partial"],
        failed: ["failed", "completed"]
      });
      expect(states.get("done")).toEqual({
        state: "searched",
        searchedAt: "2026-09-23T07:00:00.000Z",
        searchableAgainAt: "2026-09-24T06:00:00.000Z",
        characters: [
          {
            key: ryii,
            displayName: "Ryii",
            state: "completed",
            searchedAt: "2026-09-23T06:00:00.000Z",
            searchableAgainAt: "2026-09-24T06:00:00.000Z"
          },
          {
            key: alt,
            displayName: "Alt",
            state: "partial",
            searchedAt: "2026-09-23T07:00:00.000Z",
            searchableAgainAt: "2026-09-24T07:00:00.000Z"
          }
        ]
      });
    });

    it("never calls a tier searched while any character is still to search", () => {
      // Break caught (#449): the tier read "Searched" after one character's
      // search, though the others' gaps were never looked at.
      const states = tierSearchStates(
        subjects,
        [
          {
            key: ryii,
            raidId: "1180",
            status: "complete",
            createdAt: hoursAgo(2)
          }
        ],
        now
      );

      expect(states.get("1180")).toMatchObject({
        state: "partly_searched",
        characters: [
          { key: ryii, state: "completed" },
          { key: alt, state: "not_searched" },
          { key: other, state: "not_searched" }
        ]
      });
    });

    it("says the tier is searching while any character's search is in flight", () => {
      const states = tierSearchStates(
        subjects,
        [
          {
            key: ryii,
            raidId: "1180",
            status: "failed",
            createdAt: hoursAgo(2)
          },
          {
            key: alt,
            raidId: "1180",
            status: "queued",
            createdAt: hoursAgo(0)
          },
          {
            key: other,
            raidId: "1180",
            status: "running",
            createdAt: hoursAgo(0)
          },
          { key: alt, raidId: "1190", status: "queued", createdAt: hoursAgo(0) }
        ],
        now
      );

      expect(states.get("1180")?.state).toBe("running");
      expect(states.get("1190")?.state).toBe("queued");
    });

    it("reads a merged character's search under whichever of its names ran it", () => {
      // Characters sharing a Warcraft Logs ID are one dossier row (#490), so a
      // search under either name is that row's search, newest first.
      const states = tierSearchStates(
        subjects,
        [
          {
            key: other,
            raidId: "1180",
            status: "failed",
            createdAt: hoursAgo(9)
          },
          {
            key: renamed,
            raidId: "1180",
            status: "complete",
            createdAt: hoursAgo(3)
          }
        ],
        now
      );

      expect(states.get("1180")?.characters).toEqual([
        expect.objectContaining({ key: ryii, state: "not_searched" }),
        expect.objectContaining({ key: alt, state: "not_searched" }),
        expect.objectContaining({
          key: other,
          displayName: "Other",
          state: "completed",
          searchedAt: hoursAgo(3).toISOString()
        })
      ]);
    });

    it("ignores searches for characters the dossier does not include", () => {
      const states = tierSearchStates(
        [{ key: ryii, displayName: "Ryii" }],
        [
          {
            key: alt,
            raidId: "1180",
            status: "complete",
            createdAt: hoursAgo(1)
          }
        ],
        now
      );

      expect(states.size).toBe(0);
    });
  });
});
