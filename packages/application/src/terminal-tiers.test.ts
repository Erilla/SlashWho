import { describe, expect, it } from "vitest";

import { killScanFloorFrom, terminalTiersFrom } from "./terminal-tiers";

const at = new Date("2026-09-18T12:00:00.000Z");
const settleMs = 7 * 24 * 60 * 60 * 1000;

/** Closed 2026-08-19, so concluded when read on 2026-09-18. */
const concluded = "The Dreamrift";
/** Open-ended window, so never concluded. */
const current = "The Venomous Abyss";

function kill(
  raidId: string,
  raidName: string,
  killedAt: string,
  boss: Readonly<{ bossName?: string; journalBossId?: string | null }> = {}
) {
  return {
    raidId,
    raidName,
    killedAt,
    bossName: boss.bossName ?? "Boss",
    journalBossId: boss.journalBossId ?? null
  };
}

function wipe(raidId: string, attemptedAt: string, raidName = concluded) {
  return { raidId, attemptedAt, raidName };
}

function input(overrides: Partial<Parameters<typeof terminalTiersFrom>[0]>) {
  return terminalTiersFrom({
    at,
    settleMs,
    kills: [],
    scanLimitation: null,
    troubledRaidIds: { parses: [], tierBests: [] },
    ...overrides
  });
}

describe("terminalTiersFrom", () => {
  it("marks every domain of a concluded tier read without incident", () => {
    expect(
      input({
        kills: [kill("42", concluded, "2026-06-01T00:00:00.000Z")]
      })
    ).toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "parses" },
      { raidId: "42", domain: "tier_bests" }
    ]);
  });

  // Break caught: `current_content_window_unknown` is live on five characters
  // of one dossier. Freezing undated evidence is worse than re-querying it.
  it("never marks a raid with no catalogued window", () => {
    expect(
      input({
        kills: [kill("42", "Not A Catalogued Raid", "2019-01-01T00:00:00.000Z")]
      })
    ).toEqual([]);
  });

  it("never marks the current tier", () => {
    expect(
      input({ kills: [kill("42", current, "2026-06-01T00:00:00.000Z")] })
    ).toEqual([]);
  });

  // Break caught: `schema_changed` means history is incomplete -- kills and
  // wipes possibly missing, not merely parses -- so no tier this run saw can
  // be trusted, however old it is.
  it("marks nothing when the history scan reported a limitation", () => {
    expect(
      input({
        kills: [kill("42", concluded, "2026-06-01T00:00:00.000Z")],
        scanLimitation: "schema_drift"
      })
    ).toEqual([]);
  });

  // Break caught: a veteran exhausts the parse budget on every run, so every
  // raid came back troubled and nothing ever settled for kills -- which is the
  // only domain the scan floor reads. The full history was re-scanned forever.
  it("keeps the kills mark for a raid troubled only for parses", () => {
    expect(
      input({
        kills: [kill("42", concluded, "2026-06-01T00:00:00.000Z")],
        troubledRaidIds: { parses: ["42"], tierBests: [] }
      })
    ).toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "tier_bests" }
    ]);
  });

  it("withholds tier bests alone for a raid troubled only for tier bests", () => {
    expect(
      input({
        kills: [kill("42", concluded, "2026-06-01T00:00:00.000Z")],
        troubledRaidIds: { parses: [], tierBests: ["42"] }
      })
    ).toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "42", domain: "parses" }
    ]);
  });

  // Kills come from the history scan alone, and nothing in the scan writes to
  // either trouble set, so parse-domain trouble says nothing about whether the
  // raid's kills are complete.
  it("keeps the kills mark for a raid troubled in both parse domains", () => {
    expect(
      input({
        kills: [kill("42", concluded, "2026-06-01T00:00:00.000Z")],
        troubledRaidIds: { parses: ["42"], tierBests: ["42"] }
      })
    ).toEqual([{ raidId: "42", domain: "kills" }]);
  });

  // Break caught: the kills mark now rests on the scan limitation alone, so a
  // truncated or drifted scan must still settle nothing in any domain,
  // whatever the trouble sets say.
  it("marks nothing on a scan limitation even with no raid troubled", () => {
    expect(
      input({
        kills: [kill("42", concluded, "2026-06-01T00:00:00.000Z")],
        scanLimitation: "request_cap",
        troubledRaidIds: { parses: [], tierBests: [] }
      })
    ).toEqual([]);
  });

  it("leaves an untroubled raid fully marked beside a troubled one", () => {
    expect(
      input({
        kills: [
          kill("42", concluded, "2026-06-01T00:00:00.000Z"),
          kill("43", concluded, "2026-06-01T00:00:00.000Z")
        ],
        troubledRaidIds: { parses: ["42"], tierBests: ["42"] }
      })
    ).toEqual([
      { raidId: "42", domain: "kills" },
      { raidId: "43", domain: "kills" },
      { raidId: "43", domain: "parses" },
      { raidId: "43", domain: "tier_bests" }
    ]);
  });

  it("never marks a tier holding a kill that has not settled", () => {
    expect(
      input({
        kills: [
          kill("42", concluded, "2026-06-01T00:00:00.000Z"),
          kill("42", concluded, "2026-09-16T00:00:00.000Z")
        ]
      })
    ).toEqual([]);
  });

  it("marks a tier once its newest kill passes the settle threshold", () => {
    const killedAt = "2026-09-10T00:00:00.000Z";
    expect(
      input({
        at: new Date("2026-09-16T00:00:00.000Z"),
        kills: [kill("42", concluded, killedAt)]
      })
    ).toEqual([]);
    expect(
      input({
        at: new Date("2026-09-18T00:00:00.000Z"),
        kills: [kill("42", concluded, killedAt)]
      })
    ).toHaveLength(3);
  });

  it("holds a tier open on a kill it cannot date", () => {
    expect(input({ kills: [kill("42", concluded, "not-a-date")] })).toEqual([]);
  });

  // A tier that concludes between two runs becomes terminal at the boundary,
  // because the conclusion is re-evaluated against each run's own clock.
  it("marks a tier on the first run after its window closes", () => {
    const killedAt = "2026-06-01T00:00:00.000Z";
    expect(
      input({
        at: new Date("2026-08-19T22:59:59.999Z"),
        kills: [kill("42", concluded, killedAt)]
      })
    ).toEqual([]);
    expect(
      input({
        at: new Date("2026-08-19T23:00:00.000Z"),
        kills: [kill("42", concluded, killedAt)]
      })
    ).toHaveLength(3);
  });

  // Break caught: the four Warlords-and-earlier raids have no current-content
  // window, so they reported `unknown` and could never be marked terminal. A
  // veteran holding one kill in one of them therefore kept it permanently
  // outstanding, which pinned the floor to the bottom of their history and
  // made the scan re-read all of it every run (#326).
  it("marks a tier Raider.IO never served, so a veteran's floor can lift", () => {
    expect(
      input({
        kills: [
          kill("669", "Hellfire Citadel", "2016-01-01T00:00:00.000Z"),
          kill("42", concluded, "2026-06-01T00:00:00.000Z")
        ]
      })
    ).toEqual(
      expect.arrayContaining([
        { raidId: "669", domain: "kills" },
        { raidId: "42", domain: "kills" }
      ])
    );
  });

  // Break caught: the four Warlords-and-earlier raids had no current-content
  // window, so they read as `unknown` and could never be marked terminal. A
  // veteran holding one kill in one of them kept it permanently outstanding,
  // which pinned the floor to the bottom of their history and made the report
  // scan re-read all of it on every run (#326).
  it("marks a tier that predates the schedule source", () => {
    expect(
      input({
        kills: [kill("669", "Hellfire Citadel", "2016-01-01T00:00:00.000Z")]
      })
    ).toEqual([
      { raidId: "669", domain: "kills" },
      { raidId: "669", domain: "parses" },
      { raidId: "669", domain: "tier_bests" }
    ]);
  });
});

describe("terminalTiersFrom, for a zone the catalogue cannot name", () => {
  it("marks a raid only its boss can place", () => {
    // Break caught: Warcraft Logs calls journal raid 1308 `March on
    // Quel'Danas` by its in-game zone name, and serves `journalID: 0` for
    // every encounter in it, so neither the zone name nor the journal id
    // resolves. The dossier displays these kills anyway, by unique boss name,
    // and a tier the dossier can name but the marker cannot is a tier that
    // never concludes and pins the scan floor for good (#346).
    expect(
      input({
        kills: [
          kill("2913", "Isle of Quel'Danas", "2026-04-23T19:12:06.359Z", {
            bossName: "Belo'ren, Child of Al'ar"
          })
        ]
      })
    ).toContainEqual({ raidId: "2913", domain: "kills" });
  });

  it("never marks a Mythic dungeon", () => {
    expect(
      input({
        kills: [
          kill("2290", "Mists of Tirna Scithe", "2024-10-18T21:18:31.270Z", {
            bossName: "Ingra Maloch"
          })
        ]
      })
    ).toEqual([]);
  });

  it("holds a combined zone open while any raid in it is still current", () => {
    // Warcraft Logs files the three opening Midnight raids under one zone,
    // `VS / DR / MQD`, and a fight with no game zone of its own falls back to
    // it. Marks are per zone, so concluding the zone on the strength of one
    // raid in it would freeze the others while they are still current -- the
    // failure the window rule exists to prevent, arriving through a different
    // door.
    expect(
      input({
        kills: [
          kill("46", concluded, "2026-06-01T00:00:00.000Z"),
          kill("46", current, "2026-06-02T00:00:00.000Z")
        ]
      })
    ).toEqual([]);
  });

  it("marks a combined zone once every raid in it has concluded", () => {
    expect(
      input({
        kills: [
          kill("46", concluded, "2026-06-01T00:00:00.000Z"),
          kill("46", "The Voidspire", "2026-06-02T00:00:00.000Z")
        ]
      })
    ).toContainEqual({ raidId: "46", domain: "kills" });
  });

  it("still refuses a raid nobody can place at all", () => {
    // The conservative half. An unplaceable raid-shaped zone must keep holding
    // the scan open, because freezing evidence we cannot date is worse than
    // re-reading it.
    expect(
      input({
        kills: [
          kill("9999", "Some Unreleased Raid", "2024-01-01T00:00:00.000Z", {
            bossName: "Nobody In The Catalogue"
          })
        ]
      })
    ).toEqual([]);
  });
});

describe("killScanFloorFrom", () => {
  const terminalKills = [{ raidId: "42", domain: "kills" as const }];

  it("is not pinned by a Mythic dungeon kill", () => {
    // Break caught: a Mythic dungeon boss shares a difficulty with a Mythic
    // raid boss, so dungeon kills were stored as raid evidence in zones no
    // raid catalogue holds. Never placeable, never terminal, and the oldest
    // of them floored the scan at the bottom of a veteran's history -- 88% of
    // every run's cost, re-paid every twenty minutes (#346).
    expect(
      killScanFloorFrom(
        terminalKills,
        [
          kill("2290", "Mists of Tirna Scithe", "2024-10-18T21:18:31.270Z"),
          kill("42", concluded, "2026-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("is not pinned by a Mythic+ season zone", () => {
    // The same defect by the other route: a fight whose own game zone is
    // missing falls back to the report's, and a Mythic+ night is filed under
    // the dungeon season.
    expect(
      killScanFloorFrom(
        terminalKills,
        [
          kill("43", "Mythic+ Season 3", "2024-10-18T21:18:31.270Z"),
          kill("42", concluded, "2026-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("is not pinned by a wipe in a Mythic dungeon", () => {
    expect(
      killScanFloorFrom(
        terminalKills,
        [kill("42", concluded, "2026-06-01T00:00:00.000Z")],
        [wipe("2286", "2024-10-18T22:14:20.090Z", "The Necrotic Wake")]
      )
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("is still pinned by a raid the catalogue cannot place", () => {
    // Unchanged on purpose: only a positively identified dungeon stops
    // counting. A raid-shaped zone nobody can name is evidence going missing.
    expect(
      killScanFloorFrom(
        terminalKills,
        [
          kill("9999", "Some Unreleased Raid", "2024-10-18T21:18:31.270Z"),
          kill("42", concluded, "2026-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2024-10-18T21:18:31.270Z");
  });

  it("gives no floor when nothing is terminal for kills", () => {
    // Nothing to save, and stored kills may come from a run that never
    // finished, so the scan is left alone.
    expect(
      killScanFloorFrom(
        [],
        [kill("42", concluded, "2024-01-01T00:00:00.000Z")],
        []
      )
    ).toBeUndefined();
  });

  it("lifts off a tier Raider.IO never served once it is terminal", () => {
    // The other half of the same break: with the ancient raid markable, the
    // veteran has nothing outstanding, so the floor rises to the newest thing
    // held instead of sitting on a 2016 kill (#326).
    expect(
      killScanFloorFrom(
        [
          { raidId: "669", domain: "kills" },
          { raidId: "42", domain: "kills" }
        ],
        [
          kill("669", "Hellfire Citadel", "2016-01-01T00:00:00.000Z"),
          kill("42", concluded, "2026-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("lifts off a tier that predates the schedule source", () => {
    // The other half of the same break: with the ancient raid markable, the
    // veteran has nothing outstanding, so the floor rises to the newest thing
    // held instead of sitting on a 2016 kill (#326).
    expect(
      killScanFloorFrom(
        [
          { raidId: "669", domain: "kills" },
          { raidId: "42", domain: "kills" }
        ],
        [
          kill("669", "Hellfire Citadel", "2016-01-01T00:00:00.000Z"),
          kill("42", concluded, "2026-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("gives no floor for a character with nothing stored", () => {
    expect(killScanFloorFrom(terminalKills, [], [])).toBeUndefined();
  });

  it("stops at the oldest kill of a tier that is not terminal", () => {
    // Break caught: a gap below the newest terminal tier means the scan must
    // still page past it. Taking the newest terminal boundary as the floor
    // would strand raid 43 forever.
    expect(
      killScanFloorFrom(
        terminalKills,
        [
          kill("42", concluded, "2023-01-01T00:00:00.000Z"),
          kill("43", concluded, "2024-01-01T00:00:00.000Z"),
          kill("43", concluded, "2024-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2024-01-01T00:00:00.000Z");
  });

  it("stops at the newest kill once every tier held is terminal", () => {
    expect(
      killScanFloorFrom(
        terminalKills,
        [
          kill("42", concluded, "2023-01-01T00:00:00.000Z"),
          kill("42", concluded, "2024-06-01T00:00:00.000Z")
        ],
        []
      )
    ).toBe("2024-06-01T00:00:00.000Z");
  });

  it("stops at the oldest wipe of a tier that is not terminal", () => {
    // Break caught: a complete publish keeps stored wipes on the same
    // condition as stored kills -- the raid being terminal for kills -- so a
    // floor that only weighed kills let the scan skip past a wipe nothing
    // would carry forward. Raid 43 has wiped and never killed, so it can never
    // be marked terminal, and the floor must hold open for it.
    expect(
      killScanFloorFrom(
        terminalKills,
        [kill("42", concluded, "2024-06-01T00:00:00.000Z")],
        [wipe("43", "2024-01-01T00:00:00.000Z")]
      )
    ).toBe("2024-01-01T00:00:00.000Z");
  });

  it("stops at the oldest of the two when both are outstanding", () => {
    expect(
      killScanFloorFrom(
        terminalKills,
        [
          kill("42", concluded, "2023-01-01T00:00:00.000Z"),
          kill("43", concluded, "2024-06-01T00:00:00.000Z")
        ],
        [wipe("44", "2024-03-01T00:00:00.000Z")]
      )
    ).toBe("2024-03-01T00:00:00.000Z");
  });

  it("leaves a terminal tier's own wipes below the floor", () => {
    // Raid 42 is terminal for kills, so the publish carries its wipes forward
    // as well. They must not drag the floor back down and undo the saving.
    expect(
      killScanFloorFrom(
        terminalKills,
        [kill("42", concluded, "2024-06-01T00:00:00.000Z")],
        [wipe("42", "2023-01-01T00:00:00.000Z")]
      )
    ).toBe("2024-06-01T00:00:00.000Z");
  });

  it("gives no floor for a character holding wipes and no kills", () => {
    // Nothing is terminal without a kill, so there is no saving to take.
    expect(
      killScanFloorFrom(
        terminalKills,
        [],
        [wipe("43", "2024-01-01T00:00:00.000Z")]
      )
    ).toBeUndefined();
  });
});
