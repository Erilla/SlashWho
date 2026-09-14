import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  parseContractProbeOptions,
  sanitizeRankingsFixture,
  validateRankingIdentities
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
    expect(serialized).not.toContain("283");
    expect(sanitized).toMatchObject({
      data: {
        reportData: {
          report: {
            damage: {
              data: [
                {
                  roles: {
                    dps: {
                      characters: [
                        {
                          id: 2001,
                          server: { id: 3001 },
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
    });
  });

  it("requires each ranking character ID to resolve to one matching report actor", () => {
    // Break caught: ranking attribution could silently degrade to an unchecked
    // name/server comparison when a global Character lookup is absent or stale.
    const rankings = {
      data: {
        reportData: {
          report: {
            masterData: {
              actors: [
                {
                  id: 11,
                  name: "Fixture Player",
                  server: "fixture-realm",
                  type: "Player"
                }
              ]
            },
            damage: {
              data: [
                {
                  roles: {
                    dps: {
                      characters: [
                        {
                          id: 501,
                          name: "Fixture Player",
                          server: { name: "Fixture Realm", region: "eu" },
                          class: "Mage",
                          spec: "Frost"
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
    const canonical = new Map([
      [
        501,
        {
          id: 501,
          name: "Fixture Player",
          server: { slug: "fixture-realm", region: { slug: "eu" } }
        }
      ]
    ]);

    expect(() => validateRankingIdentities(rankings, canonical)).not.toThrow();
    expect(() => validateRankingIdentities(rankings, new Map())).toThrow(
      "ranking_identity_missing_character"
    );
    expect(() =>
      validateRankingIdentities(
        rankings,
        new Map([
          [
            501,
            {
              id: 501,
              name: "Different Player",
              server: { slug: "fixture-realm", region: { slug: "eu" } }
            }
          ]
        ])
      )
    ).toThrow("ranking_identity_name_mismatch");
    expect(() =>
      validateRankingIdentities(
        {
          ...rankings,
          data: {
            reportData: {
              report: {
                ...rankings.data.reportData.report,
                masterData: {
                  actors: [
                    ...rankings.data.reportData.report.masterData.actors,
                    {
                      id: 12,
                      name: "Fixture Player",
                      server: "fixture-realm",
                      type: "Player"
                    }
                  ]
                }
              }
            }
          }
        },
        canonical
      )
    ).toThrow("ranking_identity_non_unique_actor");
  });

  it("loads the committed valid and independently scoped mismatch fixtures", () => {
    // Break caught: later decoder tests could accidentally use a fixture that
    // lacks an alias, role, or isolated rejection boundary.
    const valid = JSON.parse(
      readFileSync(
        "tests/fixtures/warcraftlogs/report-rankings-valid.json",
        "utf8"
      )
    );
    const mismatch = JSON.parse(
      readFileSync(
        "tests/fixtures/warcraftlogs/report-rankings-mismatch.json",
        "utf8"
      )
    );
    expect(Object.keys(valid.data.reportData.report)).toEqual(
      expect.arrayContaining(["damage", "healing", "bossDamage"])
    );
    expect(
      Object.keys(valid.data.reportData.report.damage.data[0].roles)
    ).toEqual(expect.arrayContaining(["tanks", "healers", "dps"]));
    expect(Object.keys(mismatch)).toEqual([
      "report",
      "fight",
      "encounter",
      "difficulty",
      "character"
    ]);
  });
});
