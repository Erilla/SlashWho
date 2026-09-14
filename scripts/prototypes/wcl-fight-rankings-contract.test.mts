import { describe, expect, it } from "vitest";

import {
  parseContractProbeOptions,
  sanitizeRankingsFixture
} from "./wcl-fight-rankings-contract.mts";

describe("Warcraft Logs fight-ranking contract probe", () => {
  it("rejects a probe without every exact-fight scope argument", () => {
    // Break caught: an unscoped probe could accidentally capture a broader
    // report-ranking payload than the one fight its fixture is meant to prove.
    expect(() => parseContractProbeOptions([])).toThrow(
      "missing_scope_argument"
    );
    expect(() =>
      parseContractProbeOptions([
        "--report-code",
        "rawReportCode",
        "--fight-id",
        "41",
        "--encounter-id",
        "3129"
      ])
    ).toThrow("missing_scope_argument");
  });

  it("redacts report and player identity while preserving ranking relationships", () => {
    // Break caught: captured contract fixtures could publish a real report or
    // player identity while still appearing structurally useful to the decoder.
    const raw = {
      data: {
        reportData: {
          report: {
            code: "rawReportCode",
            masterData: {
              actors: [
                {
                  id: 918273,
                  name: "Original Player",
                  server: "Original Realm",
                  region: "us",
                  type: "Player"
                }
              ]
            },
            damage: {
              rankings: [
                {
                  actorID: 918273,
                  name: "Original Player",
                  server: "Original Realm",
                  region: "us",
                  fightID: 41,
                  role: "DPS",
                  rankPercent: 97.4
                }
              ]
            }
          }
        }
      }
    };

    const sanitized = sanitizeRankingsFixture(raw);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("rawReportCode");
    expect(serialized).not.toContain("Original Player");
    expect(serialized).not.toContain("Original Realm");
    expect(serialized).not.toContain('"us"');
    expect(serialized).not.toContain("918273");
    expect(sanitized).toMatchObject({
      data: {
        reportData: {
          report: {
            masterData: { actors: [{ id: 1001, type: "Player" }] },
            damage: {
              rankings: [
                { actorID: 1001, fightID: 41, role: "DPS", rankPercent: 97.4 }
              ]
            }
          }
        }
      }
    });
  });

  it("redacts provider character IDs from the observed role grouping", () => {
    // Break caught: the live JSON nests globally stable character IDs below
    // roles, where leaking one would publish a player identity in a fixture.
    const raw = {
      data: {
        reportData: {
          report: {
            code: "rawReportCode",
            damage: {
              data: [
                {
                  roles: {
                    dps: {
                      characters: [
                        {
                          id: 441122,
                          name: "Original Player",
                          server: {
                            id: 283,
                            name: "Original Realm",
                            region: "us"
                          },
                          class: "Mage",
                          spec: "Frost",
                          rankPercent: 97.4
                        }
                      ]
                    }
                  }
                }
              ]
            }
          }
        }
      }
    };

    const sanitized = sanitizeRankingsFixture(raw);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("441122");
    expect(sanitized).toMatchObject({
      data: {
        reportData: {
          report: {
            damage: {
              data: [
                {
                  roles: {
                    dps: { characters: [{ id: 2001, rankPercent: 97.4 }] }
                  }
                }
              ]
            }
          }
        }
      }
    });
  });
});
