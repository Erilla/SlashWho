import { describe, expect, it } from "vitest";

import { killScanFloorFrom, terminalTiersFrom } from "./terminal-tiers";

const at = new Date("2026-09-18T12:00:00.000Z");
const settleMs = 7 * 24 * 60 * 60 * 1000;

/** Closed 2026-08-19, so concluded when read on 2026-09-18. */
const concluded = "The Dreamrift";
/** Open-ended window, so never concluded. */
const current = "The Venomous Abyss";

function kill(raidId: string, raidName: string, killedAt: string) {
  return { raidId, raidName, killedAt };
}

function input(overrides: Partial<Parameters<typeof terminalTiersFrom>[0]>) {
  return terminalTiersFrom({
    at,
    settleMs,
    kills: [],
    scanLimitation: null,
    troubledRaidIds: [],
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

  it("withholds every mark for a raid a limitation was attributed to", () => {
    expect(
      input({
        kills: [
          kill("42", concluded, "2026-06-01T00:00:00.000Z"),
          kill("43", concluded, "2026-06-01T00:00:00.000Z")
        ],
        troubledRaidIds: ["42"]
      })
    ).toEqual([
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
});

describe("killScanFloorFrom", () => {
  const terminalKills = [{ raidId: "42", domain: "kills" as const }];

  it("gives no floor when nothing is terminal for kills", () => {
    // Nothing to save, and stored kills may come from a run that never
    // finished, so the scan is left alone.
    expect(
      killScanFloorFrom([], [kill("42", concluded, "2024-01-01T00:00:00.000Z")])
    ).toBeUndefined();
  });

  it("gives no floor for a character with nothing stored", () => {
    expect(killScanFloorFrom(terminalKills, [])).toBeUndefined();
  });

  it("stops at the oldest kill of a tier that is not terminal", () => {
    // Break caught: a gap below the newest terminal tier means the scan must
    // still page past it. Taking the newest terminal boundary as the floor
    // would strand raid 43 forever.
    expect(
      killScanFloorFrom(terminalKills, [
        kill("42", concluded, "2023-01-01T00:00:00.000Z"),
        kill("43", concluded, "2024-01-01T00:00:00.000Z"),
        kill("43", concluded, "2024-06-01T00:00:00.000Z")
      ])
    ).toBe("2024-01-01T00:00:00.000Z");
  });

  it("stops at the newest kill once every tier held is terminal", () => {
    expect(
      killScanFloorFrom(terminalKills, [
        kill("42", concluded, "2023-01-01T00:00:00.000Z"),
        kill("42", concluded, "2024-06-01T00:00:00.000Z")
      ])
    ).toBe("2024-06-01T00:00:00.000Z");
  });
});
