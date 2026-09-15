import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { createWarcraftLogsClient } from "./index";

type FixtureName =
  | "token-valid"
  | "character-report-valid"
  | "character-private"
  | "report-rankings-valid"
  | "schema-drift";

const fixtureDirectory = fileURLToPath(
  new URL("../../../tests/fixtures/warcraftlogs/", import.meta.url)
);

const key: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "sentinel"
};

function fixture(name: FixtureName): unknown {
  return JSON.parse(
    readFileSync(resolve(fixtureDirectory, `${name}.json`), "utf8")
  ) as unknown;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function jsonResponseWithRawJson(value: unknown): Response {
  const response = jsonResponse(value);
  Object.defineProperty(response, "json", { value: async () => value });
  return response;
}

function emptyRankingsResponse(code: string): Response {
  return jsonResponse({
    data: {
      reportData: {
        report: {
          code,
          archiveStatus: {
            isArchived: false,
            isAccessible: true,
            archiveDate: null
          },
          masterData: { actors: [] },
          damage: { data: [] },
          healing: { data: [] },
          bossDamage: { data: [] }
        }
      }
    }
  });
}

function clientFor(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    const response = await responder(url, init);
    if (url.pathname === "/api/v2/client") {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        let payload: { data?: { reportData?: unknown } };
        try {
          payload = (await response.clone().json()) as {
            data?: { reportData?: unknown };
          };
        } catch {
          return emptyRankingsResponse(body.variables.code ?? "report");
        }
        if (!payload.data?.reportData) {
          return emptyRankingsResponse(body.variables.code ?? "report");
        }
      }
    }
    return response;
  });
  return {
    fetch,
    client: createWarcraftLogsClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker"
    })
  };
}

function token(): Response {
  return jsonResponse(fixture("token-valid"));
}

function performanceReport(
  fightIds = [26],
  hasMorePages = false,
  code = "performance-report",
  encounterId = 3306
): unknown {
  return {
    data: {
      characterData: {
        character: {
          server: { normalizedName: "Silvermoon" },
          recentReports: {
            data: [
              {
                code,
                startTime: 1_706_918_400_000,
                zone: {
                  id: 1047,
                  name: "Fixture",
                  encounters: [{ id: encounterId, journalID: encounterId }]
                },
                masterData: {
                  actors: [
                    {
                      id: 1001,
                      name: "Sentinel",
                      server: "Silvermoon",
                      type: "Player"
                    }
                  ]
                },
                fights: fightIds.map((id) => ({
                  id,
                  encounterID: encounterId,
                  name: "Boss",
                  startTime: 1,
                  endTime: 2,
                  kill: true,
                  difficulty: 5,
                  friendlyPlayers: [1001]
                }))
              }
            ],
            has_more_pages: hasMorePages
          }
        }
      }
    }
  };
}

function performanceRankings(
  values: Readonly<{ damage: unknown; healing: unknown; bossDamage: unknown }>,
  options: Readonly<{
    code?: string;
    fightId?: number;
    encounterId?: number;
    difficulty?: number;
    characterId?: number;
    archiveAccessible?: boolean;
  }> = {}
): unknown {
  const row = (rankPercent: unknown) => ({
    fightID: options.fightId ?? 26,
    encounter: { id: options.encounterId ?? 3306 },
    difficulty: options.difficulty ?? 5,
    roles: {
      tanks: { characters: [] },
      healers: { characters: [] },
      dps: {
        characters: [
          {
            id: options.characterId ?? 2101,
            name: "Sentinel",
            server: { name: "silvermoon", region: "eu" },
            rankPercent
          }
        ]
      }
    }
  });
  return {
    data: {
      reportData: {
        report: {
          code: options.code ?? "performance-report",
          archiveStatus: {
            isArchived: options.archiveAccessible === false,
            isAccessible: options.archiveAccessible ?? true,
            archiveDate: null
          },
          masterData: {
            actors: [
              {
                id: 1001,
                name: "Sentinel",
                server: "Silvermoon",
                type: "Player"
              }
            ]
          },
          damage: { data: [row(values.damage)] },
          healing: { data: [row(values.healing)] },
          bossDamage: { data: [row(values.bossDamage)] }
        }
      }
    }
  };
}

function performanceClient(
  rankings: unknown,
  fightIds = [26],
  rawJson = false
) {
  return clientFor((url, init) => {
    if (url.pathname === "/oauth/token") return token();
    const query = JSON.parse(String(init?.body)) as { query: string };
    if (query.query.includes("ReportFightParses")) {
      return rawJson
        ? jsonResponseWithRawJson(rankings)
        : jsonResponse(rankings);
    }
    if (query.query.includes("RankingCharacterIdentities")) {
      return jsonResponse({
        data: {
          characterData: {
            character0: {
              id: 2101,
              name: "Sentinel",
              server: { slug: "silvermoon", region: { slug: "eu" } }
            }
          }
        }
      });
    }
    return jsonResponse(performanceReport(fightIds));
  });
}

describe("Warcraft Logs gateway", () => {
  it("shares OAuth refresh across concurrent character reads", async () => {
    let tokens = 0;
    const { client } = clientFor((url) => {
      if (url.pathname === "/oauth/token") {
        tokens++;
        return token();
      }
      return jsonResponse({ data: { characterData: { character: null } } });
    });
    await Promise.all([
      client.resolveCharacter(key),
      client.resolveCharacter({ ...key, name: "alt" })
    ]);
    expect(tokens).toBe(1);
    await client.resolveCharacter(key);
    expect(tokens).toBe(1);
  });
  it("resolves a requested key to Warcraft Logs' canonical public character", async () => {
    // Break caught: an upstream transfer or rename could be attributed to the
    // requested key instead of the canonical public character.
    const { client } = clientFor((url) => {
      if (url.pathname === "/oauth/token") return token();
      return jsonResponse({
        data: {
          characterData: {
            character: {
              name: "Sentinel",
              server: { slug: "Silvermoon", region: { slug: "EU" } }
            }
          }
        }
      });
    });

    await expect(client.resolveCharacter(key)).resolves.toEqual({
      kind: "identity",
      key,
      displayName: "Sentinel"
    });
  });

  it("normalizes exact-fight performance parses", async () => {
    // Break caught: a kill could be presented with a percentile from another
    // report, fight, character, encounter, or difficulty instead of this
    // character's exact Mythic kill.
    const rankings = JSON.parse(
      JSON.stringify(fixture("report-rankings-valid"))
        .replaceAll("fixture-name-1", "sentinel")
        .replaceAll("fixture-realm-1", "silvermoon")
        .replaceAll("fixture-region-1", "eu")
    ) as unknown;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const query = JSON.parse(String(init?.body)) as { query: string };
      if (query.query.includes("recentReports")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                server: { normalizedName: "Silvermoon" },
                recentReports: {
                  data: [
                    {
                      code: "fixture-report-1",
                      startTime: 1_706_918_400_000,
                      zone: {
                        id: 1047,
                        name: "Fixture raid",
                        encounters: [{ id: 3306, journalID: 3306 }]
                      },
                      masterData: {
                        actors: [
                          {
                            id: 1001,
                            name: "Sentinel",
                            server: "Silvermoon",
                            type: "Player"
                          }
                        ]
                      },
                      fights: [
                        {
                          id: 26,
                          encounterID: 3306,
                          name: "Fixture boss",
                          startTime: 1,
                          endTime: 2,
                          kill: true,
                          difficulty: 5,
                          friendlyPlayers: [1001]
                        }
                      ]
                    }
                  ],
                  has_more_pages: false
                }
              }
            }
          }
        });
      }
      if (query.query.includes("ReportFightParses"))
        return jsonResponse(rankings);
      return jsonResponse({
        data: {
          characterData: {
            character0: {
              id: 2101,
              name: "Sentinel",
              server: { slug: "silvermoon", region: { slug: "eu" } }
            },
            character1: {
              id: 2102,
              name: "fixture-name-2",
              server: {
                slug: "fixture-realm-2",
                region: { slug: "eu" }
              }
            },
            character2: {
              id: 2103,
              name: "fixture-name-3",
              server: {
                slug: "fixture-realm-3",
                region: { slug: "eu" }
              }
            }
          }
        }
      });
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 2
    });
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        {
          reportCode: "fixture-report-1",
          fightId: 26,
          difficulty: 5,
          performance: {
            spec: {
              name: "Brewmaster",
              iconUrl:
                "https://wow.zamimg.com/images/wow/icons/medium/spell_monk_brewmaster_spec.jpg"
            },
            damage: { state: "available", percentile: 23 },
            healing: { state: "available", percentile: 48 },
            bossDamage: { state: "available", percentile: 42 }
          }
        }
      ]
    });
  });

  it("ignores unrelated ranking identities before bounded canonical lookup", async () => {
    // Break caught: Report.rankings can return many unrelated characters. A
    // payload larger than the identity-lookup bound must not make the
    // requested character's exact parse unavailable.
    const rankings = performanceRankings({
      damage: 40,
      healing: 41,
      bossDamage: 42
    }) as {
      data: {
        reportData: {
          report: {
            damage: { data: Array<Record<string, unknown>> };
            healing: { data: Array<Record<string, unknown>> };
            bossDamage: { data: Array<Record<string, unknown>> };
          };
        };
      };
    };
    for (const metric of ["damage", "healing", "bossDamage"] as const) {
      const characters = (
        rankings.data.reportData.report[metric].data[0]!.roles as {
          dps: { characters: Array<Record<string, unknown>> };
        }
      ).dps.characters;
      for (let id = 2200; id < 2260; id++) {
        characters.push({
          id,
          name: `Other${id}`,
          server: { name: "silvermoon", region: "eu" },
          rankPercent: 10
        });
      }
    }

    const { client } = performanceClient(rankings);

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          performance: {
            damage: { state: "available", percentile: 40 },
            healing: { state: "available", percentile: 41 },
            bossDamage: { state: "available", percentile: 42 }
          }
        }
      ]
    });
  });

  it.each([
    ["report", { code: "another-report" }],
    ["fight", { fightId: 27 }],
    ["encounter", { encounterId: 3307 }],
    ["difficulty", { difficulty: 4 }],
    ["character", { characterId: 2102 }]
  ])("rejects a mismatched %s identity", async (_identity, override) => {
    // Break caught: a ranking row with any source dimension changed could be
    // credited to this kill even though it does not prove this exact parse.
    const { client } = performanceClient(
      performanceRankings({ damage: 40, healing: 41, bossDamage: 42 }, override)
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          performance: {
            damage: { state: "unavailable" },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        }
      ]
    });
  });

  it("preserves zero and rejects malformed percentile values", async () => {
    // Break caught: falsy zero could be discarded while malformed provider
    // values were coerced into a displayed score.
    const { client } = performanceClient(
      performanceRankings({ damage: 0, healing: null, bossDamage: "52" })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          performance: {
            damage: { state: "available", percentile: 0 },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        }
      ]
    });
  });

  it("normalizes rankings even when client credentials cannot access archived report data", async () => {
    // Break caught: archiveStatus.isAccessible describes raw report-data
    // access, not the independently returned rankings JSON. Rejecting a valid
    // rankings payload here makes every historical parse appear unavailable.
    const { client } = performanceClient(
      performanceRankings(
        { damage: 40, healing: 41, bossDamage: 42 },
        { archiveAccessible: false }
      )
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          performance: {
            damage: { state: "available", percentile: 40 },
            healing: { state: "available", percentile: 41 },
            bossDamage: { state: "available", percentile: 42 }
          }
        }
      ]
    });
  });

  it("selects the highest duplicate eligible ranking percentile", async () => {
    // Break caught: duplicate provider rows could turn a valid exact parse into
    // schema drift or retain an arbitrary lower percentile.
    const rankings = performanceRankings({
      damage: 40,
      healing: 41,
      bossDamage: 42
    }) as {
      data: {
        reportData: {
          report: { damage: { data: Array<Record<string, unknown>> } };
        };
      };
    };
    const duplicate = structuredClone(
      rankings.data.reportData.report.damage.data[0]!
    );
    const roles = duplicate.roles as {
      dps: { characters: Array<{ rankPercent: number }> };
    };
    roles.dps.characters[0]!.rankPercent = 87;
    rankings.data.reportData.report.damage.data.push(duplicate);
    const { client } = performanceClient(rankings);

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        { performance: { damage: { state: "available", percentile: 87 } } }
      ]
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["out of range", 101]
  ])("marks a %s percentile unavailable", async (_description, percentile) => {
    // Break caught: non-finite or out-of-range provider numbers could become
    // a fabricated score instead of an explicit unavailable state.
    const { client } = performanceClient(
      performanceRankings({ damage: percentile, healing: 41, bossDamage: 42 }),
      [26],
      true
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [{ performance: { damage: { state: "unavailable" } } }]
    });
  });

  it("counts canonical identity lookup against the parse request cap", async () => {
    // Break caught: omitting the identity lookup from the budget could exceed
    // the provider request allowance during a long history scan.
    const { client } = performanceClient(
      performanceRankings({ damage: 40, healing: 41, bossDamage: 42 })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 1 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [{ performance: { damage: { state: "unavailable" } } }],
      parseLimitation: { kind: "limitation", code: "parse_request_cap" }
    });
  });

  it("leaves later report groups unavailable after the parse cap", async () => {
    // Break caught: a cap must preserve verified kills while making the
    // skipped report group's missing parse state explicit.
    const first = performanceReport([26]) as {
      data: {
        characterData: { character: { recentReports: { data: unknown[] } } };
      };
    };
    const second = performanceReport([27], false, "second-report") as {
      data: {
        characterData: { character: { recentReports: { data: unknown[] } } };
      };
    };
    first.data.characterData.character.recentReports.data.push(
      second.data.characterData.character.recentReports.data[0]
    );

    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const query = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string };
      };
      if (query.query.includes("ReportFightParses")) {
        const code = query.variables.code ?? "performance-report";
        return jsonResponse(
          performanceRankings(
            { damage: 40, healing: 41, bossDamage: 42 },
            { code, fightId: code === "second-report" ? 27 : 26 }
          )
        );
      }
      if (query.query.includes("RankingCharacterIdentities")) {
        return jsonResponse({
          data: {
            characterData: {
              character0: {
                id: 2101,
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } }
              }
            }
          }
        });
      }
      return jsonResponse(first);
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        { fightId: 26, performance: { damage: { state: "available" } } },
        { fightId: 27, performance: { damage: { state: "unavailable" } } }
      ],
      parseLimitation: { kind: "limitation", code: "parse_request_cap" }
    });
  });

  it("prioritizes the earliest kill report group before the parse cap", async () => {
    const recent = performanceReport([26], false, "recent-report") as {
      data: {
        characterData: { character: { recentReports: { data: unknown[] } } };
      };
    };
    const firstKill = performanceReport([27], false, "first-kill-report") as {
      data: {
        characterData: { character: { recentReports: { data: unknown[] } } };
      };
    };
    recent.data.characterData.character.recentReports.data[0] = {
      ...(recent.data.characterData.character.recentReports.data[0] as object),
      startTime: 2
    };
    (
      recent.data.characterData.character.recentReports as unknown as {
        has_more_pages: boolean;
      }
    ).has_more_pages = true;
    firstKill.data.characterData.character.recentReports.data[0] = {
      ...(firstKill.data.characterData.character.recentReports
        .data[0] as object),
      startTime: 1
    };
    const parseOrder: string[] = [];
    let reportPage = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string; fightIDs?: number[] };
      };
      if (body.query.includes("ReportFightParses")) {
        parseOrder.push(body.variables.code ?? "");
        const fightId = body.variables.fightIDs?.[0] ?? 0;
        return jsonResponse(
          performanceRankings(
            { damage: fightId, healing: fightId, bossDamage: fightId },
            { code: body.variables.code, fightId }
          )
        );
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: { data: [] },
                healing: { data: [] },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return jsonResponse({
          data: {
            characterData: {
              character0: {
                id: 2101,
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } }
              }
            }
          }
        });
      }
      reportPage += 1;
      return jsonResponse(reportPage === 1 ? recent : firstKill);
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 2, parseRequestCap: 2 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          fightId: 27,
          performance: { damage: { state: "available", percentile: 27 } }
        },
        { fightId: 26, performance: { damage: { state: "unavailable" } } }
      ],
      parseLimitation: { kind: "limitation", code: "parse_request_cap" }
    });
    expect(parseOrder).toEqual(["first-kill-report"]);
  });

  it("retains scan and parse limitations when both caps are exhausted", async () => {
    // Break caught: a scan cap could hide the reason parse metrics remain
    // unavailable, causing downstream storage to report the wrong limitation.
    const rankings = performanceRankings({
      damage: 40,
      healing: 41,
      bossDamage: 42
    });
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const query = JSON.parse(String(init?.body)) as { query: string };
      if (query.query.includes("ReportFightParses"))
        return jsonResponse(rankings);
      if (query.query.includes("RankingCharacterIdentities")) {
        return jsonResponse({
          data: {
            characterData: {
              character0: {
                id: 2101,
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26], true));
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 1 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [{ performance: { damage: { state: "unavailable" } } }],
      limitation: { kind: "limitation", code: "request_cap" },
      parseLimitation: { kind: "limitation", code: "parse_request_cap" }
    });
  });

  it("hydrates several fight IDs from one report with one ranking request", async () => {
    // Break caught: issuing one ranking request per fight would multiply the
    // measured provider cost despite the API accepting a fight-ID batch.
    const { client, fetch } = performanceClient(
      performanceRankings({ damage: 40, healing: 41, bossDamage: 42 }),
      [26, 27]
    );

    await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 2
    });

    const rankingCalls = fetch.mock.calls.filter(
      ([url, init]) =>
        new URL(String(url)).pathname === "/api/v2/client" &&
        JSON.parse(String(init?.body)).query.includes("ReportFightParses")
    );
    expect(rankingCalls).toHaveLength(1);
  });

  it("hydrates every report group before the parse cap is exhausted", async () => {
    // Break caught: one canonical identity lookup per report group consumed
    // the budget before later displayed kills could receive their parses.
    const reports = [
      performanceReport([26], true, "report-one"),
      performanceReport([27], true, "report-two"),
      performanceReport([28], false, "report-three")
    ];
    let reportPage = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string; fightIDs?: number[] };
      };
      if (body.query.includes("ReportFightParses")) {
        const fightId = body.variables.fightIDs?.[0] ?? 26;
        return jsonResponse(
          performanceRankings(
            { damage: fightId, healing: fightId, bossDamage: fightId },
            { code: body.variables.code, fightId }
          )
        );
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return jsonResponse({
          data: {
            characterData: {
              character0: {
                id: 2101,
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } }
              }
            }
          }
        });
      }
      const page = reports[reportPage++]!;
      return jsonResponse(page);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 4
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(
      new Map(
        result.kills.map((kill) => [
          kill.fightId,
          kill.performance.damage.state
        ])
      )
    ).toEqual(
      new Map([
        [26, "available"],
        [27, "available"],
        [28, "available"]
      ])
    );
  });

  it("fills capped report groups from character encounter rankings", async () => {
    // Break caught: a character with more report groups than the cap still
    // needs best-shown ranking values even when exact later fights are skipped.
    let reportCalls = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string; fightIDs?: number[] };
      };
      if (body.query.includes("ReportFightParses")) {
        return jsonResponse(
          performanceRankings(
            { damage: 0, healing: 0, bossDamage: 0 },
            {
              code: body.variables?.code,
              fightId: body.variables?.fightIDs?.[0]
            }
          )
        );
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: { data: [{ rankPercent: 91 }] },
                healing: { data: [{ rankPercent: 82 }] },
                bossDamage: { data: [{ rankPercent: 87 }] }
              }
            }
          }
        });
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return jsonResponse({
          data: {
            characterData: {
              character0: {
                id: 2101,
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } }
              }
            }
          }
        });
      }
      reportCalls++;
      return jsonResponse(
        performanceReport(
          [26 + reportCalls],
          reportCalls < 2,
          `report-${reportCalls}`
        )
      );
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 2,
      parseRequestCap: 2
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(
      result.kills.some(
        (kill) =>
          kill.performance.damage.state === "available" &&
          kill.performance.damage.percentile === 91 &&
          kill.performance.healing.state === "available" &&
          kill.performance.healing.percentile === 82 &&
          kill.performance.bossDamage.state === "available" &&
          kill.performance.bossDamage.percentile === 87
      )
    ).toBe(true);
  });

  it("fills best rankings when a report ranking response has no rows", async () => {
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: { data: [{ rankPercent: 91 }] },
                healing: { data: [{ rankPercent: 82 }] },
                bossDamage: { data: [{ rankPercent: 87 }] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 3 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          performance: {
            damage: { state: "available", percentile: 91 },
            healing: { state: "available", percentile: 82 },
            bossDamage: { state: "available", percentile: 87 }
          }
        }
      ]
    });
  });

  it("carries the specialisation from character encounter rankings", async () => {
    // Break caught: character encounter rankings are the dominant parse source,
    // so discarding their spec left most kills without a specialisation icon.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse("performance-report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: {
                  data: [{ rankPercent: 40, class: "Priest", spec: "Shadow" }]
                },
                healing: {
                  data: [
                    { rankPercent: 91, class: "Priest", spec: "Discipline" }
                  ]
                },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 3
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.kills[0]?.performance.spec).toEqual({
      name: "Discipline",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/spell_holy_powerwordshield.jpg"
    });
  });

  it("resolves same-named specialisations using the character class", async () => {
    // Break caught: keying icons by spec name alone gave Frost Death Knights
    // the Frost Mage icon, and the same for Holy, Protection and Restoration.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse("performance-report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: {
                  data: [
                    { rankPercent: 91, class: "DeathKnight", spec: "Frost" }
                  ]
                },
                healing: { data: [] },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 3
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.kills[0]?.performance.spec).toEqual({
      name: "Frost",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/spell_deathknight_frostpresence.jpg"
    });
  });

  it("resolves warlock specialisations missing from the icon table", async () => {
    // Break caught: Affliction and Demonology were absent, so every Warlock
    // parse rendered without an icon.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse("performance-report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: {
                  data: [
                    { rankPercent: 91, class: "Warlock", spec: "Affliction" }
                  ]
                },
                healing: { data: [] },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 3
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.kills[0]?.performance.spec).toEqual({
      name: "Affliction",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/spell_shadow_deathcoil.jpg"
    });
  });

  it("resolves an ambiguous specialisation from the character's known class", async () => {
    // Break caught: Warcraft Logs does not report a class on its ranks, so
    // Frost, Holy, Protection and Restoration resolved to no icon at all. A
    // character's class cannot change, so the caller's known class settles it.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse("performance-report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: { data: [{ rankPercent: 91, spec: "Frost" }] },
                healing: { data: [] },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 3,
      className: "Death Knight"
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.kills[0]?.performance.spec).toEqual({
      name: "Frost",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/spell_deathknight_frostpresence.jpg"
    });
  });

  it("prefers a class reported by Warcraft Logs over the caller's class", async () => {
    // Break caught: Warcraft Logs reports `class` as a numeric class id (4 is
    // Mage), so reading it as a name silently ignored it. The per-rank class is
    // the more specific claim; the known class is only a fallback.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse("performance-report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: {
                  data: [{ rankPercent: 91, class: 4, spec: "Frost" }]
                },
                healing: { data: [] },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 3,
      className: "Death Knight"
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.kills[0]?.performance.spec).toEqual({
      name: "Frost",
      iconUrl:
        "https://wow.zamimg.com/images/wow/icons/medium/spell_frost_frostbolt02.jpg"
    });
  });

  it("leaves an ambiguous specialisation unset when no class is known", async () => {
    // Break caught: guessing a class for a shared spec name shows a confidently
    // wrong icon; omitting it is the honest outcome.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse("performance-report");
      }
      if (body.query.includes("CharacterEncounterRankings")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: { data: [{ rankPercent: 91, spec: "Frost" }] },
                healing: { data: [] },
                bossDamage: { data: [] }
              }
            }
          }
        });
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 3
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.kills[0]?.performance.spec).toBeNull();
    expect(result.kills[0]?.performance.damage).toEqual({
      state: "available",
      percentile: 91
    });
  });

  it("bounds concurrent character encounter ranking requests", async () => {
    let reportPage = 0;
    let activeRankings = 0;
    let maximumActiveRankings = 0;
    const reports = [
      performanceReport([26], true, "report-one", 3306),
      performanceReport([27], true, "report-two", 3307),
      performanceReport([28], false, "report-three", 3308)
    ];
    const { client } = clientFor(async (url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("CharacterEncounterRankings")) {
        activeRankings++;
        maximumActiveRankings = Math.max(maximumActiveRankings, activeRankings);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeRankings--;
        return jsonResponse({
          data: {
            characterData: {
              character: {
                name: "Sentinel",
                server: { slug: "silvermoon", region: { slug: "eu" } },
                damage: { data: [{ rankPercent: 91 }] },
                healing: { data: [{ rankPercent: 82 }] },
                bossDamage: { data: [{ rankPercent: 87 }] }
              }
            }
          }
        });
      }
      const report = reports[reportPage++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 3, parseRequestCap: 1 })
    ).resolves.toMatchObject({ kind: "evidence" });
    expect(maximumActiveRankings).toBeLessThanOrEqual(2);
  });

  it("paginates public reports and retains every distinct Mythic kill", async () => {
    // Break caught: collapsing report pages to one kill per encounter hid the
    // complete chronological evidence needed by an applicant dossier.
    const pages = (fixture("character-report-valid") as { pages: unknown[] })
      .pages;
    let page = 0;
    const { client, fetch } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      expect(url.pathname).toBe("/api/v2/client");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer public-access-token",
        Accept: "application/json"
      });
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: {
          code?: string;
          name: string;
          realm: string;
          region: string;
          page: number;
        };
      };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables.code!);
      }
      expect(body.query).toContain("recentReports(limit: 10,");
      expect(body.variables).toEqual({
        name: "sentinel",
        realm: "silvermoon",
        region: "eu",
        page: page + 1
      });
      return jsonResponse(pages[page++]!);
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 10, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "1234",
          bossName: "Queen Ansurek",
          journalBossId: null,
          bossOrder: 1234,
          isFinalBoss: false,
          killedAt: "2024-02-03T01:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/earlyReport",
          fightUrl: "https://www.warcraftlogs.com/reports/earlyReport#fight=7",
          guild: null,
          historicWorldRank: null
        },
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "1234",
          bossName: "Queen Ansurek",
          journalBossId: null,
          bossOrder: 1234,
          isFinalBoss: false,
          killedAt: "2024-02-05T03:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/lateReport",
          fightUrl: "https://www.warcraftlogs.com/reports/lateReport#fight=1",
          guild: null,
          historicWorldRank: null
        },
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "4321",
          bossName: "The Silken Court",
          journalBossId: null,
          bossOrder: 4321,
          isFinalBoss: false,
          killedAt: "2024-02-04T02:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/secondBoss",
          fightUrl: "https://www.warcraftlogs.com/reports/secondBoss#fight=2",
          guild: null,
          historicWorldRank: null
        }
      ],
      wipes: [
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "9999",
          bossName: "Wipe",
          journalBossId: null,
          bossOrder: 9999,
          attemptedAt: "2024-02-05T03:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/lateReport",
          fightUrl: "https://www.warcraftlogs.com/reports/lateReport#fight=9"
        }
      ]
    });
    expect(fetch).toHaveBeenCalledTimes(8);
  });

  it("emits only participant-attributed boss kills and ignores trash fights", async () => {
    // Break caught: report-list membership alone does not prove that the
    // character participated in every fight, and encounterID 0 is trash rather
    // than a boss.  The dossier must keep the report, fight, boss, and actor
    // identities together rather than joining unrelated source facts later.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "Silvermoon" },
                  recentReports: {
                    data: [
                      {
                        code: "participantReport",
                        startTime: 1_706_918_400_000,
                        zone: {
                          id: 42,
                          name: "Nerub-ar Palace",
                          encounters: [{ id: 1234, journalID: 2345 }]
                        },
                        masterData: {
                          actors: [
                            {
                              id: 7,
                              name: "Sentinel",
                              server: "Silvermoon",
                              type: "Player"
                            },
                            {
                              id: 8,
                              name: "Someoneelse",
                              server: null,
                              type: "Player"
                            },
                            {
                              id: 9,
                              name: null,
                              server: "Silvermoon",
                              type: "Player"
                            }
                          ]
                        },
                        fights: [
                          {
                            id: 3,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 3_600_000,
                            endTime: 3_600_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          },
                          {
                            id: 4,
                            encounterID: 0,
                            name: "Trash",
                            startTime: null,
                            endTime: null,
                            kill: null,
                            difficulty: null,
                            friendlyPlayers: null
                          },
                          {
                            id: 5,
                            encounterID: 4321,
                            name: "The Silken Court",
                            startTime: 10_800_000,
                            endTime: 10_800_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [8]
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });

    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "1234",
          bossName: "Queen Ansurek",
          reportUrl: "https://www.warcraftlogs.com/reports/participantReport",
          fightUrl:
            "https://www.warcraftlogs.com/reports/participantReport#fight=3"
        }
      ]
    });
  });

  it("emits only participant-attributed Mythic wipes beside verified kills", async () => {
    // Break caught: treating every unsuccessful fight in a character report as
    // that character's Mythic wipe would create false applicant evidence.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "Silvermoon" },
                  recentReports: {
                    data: [
                      {
                        code: "wipeReport",
                        startTime: 1_706_918_400_000,
                        guild: null,
                        zone: {
                          id: 42,
                          name: "Nerub-ar Palace",
                          encounters: [
                            { id: 1234, journalID: 2345 },
                            { id: 4321, journalID: 5432 }
                          ]
                        },
                        masterData: {
                          actors: [
                            {
                              id: 7,
                              name: "Sentinel",
                              server: "Silvermoon",
                              type: "Player"
                            },
                            {
                              id: 8,
                              name: "Someoneelse",
                              server: "Silvermoon",
                              type: "Player"
                            }
                          ]
                        },
                        fights: [
                          {
                            id: 1,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 120_000,
                            endTime: 300_000,
                            kill: false,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          },
                          {
                            id: 2,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 360_000,
                            endTime: 420_000,
                            kill: false,
                            difficulty: 5,
                            friendlyPlayers: [8]
                          },
                          {
                            id: 3,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 480_000,
                            endTime: 540_000,
                            kill: false,
                            difficulty: 4,
                            friendlyPlayers: [7]
                          },
                          {
                            id: 4,
                            encounterID: 4321,
                            name: "The Silken Court",
                            startTime: 600_000,
                            endTime: 660_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      wipes: [
        {
          raidId: "42",
          bossId: "1234",
          journalBossId: "2345",
          attemptedAt: "2024-02-03T00:05:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/wipeReport#fight=1"
        }
      ],
      kills: [expect.objectContaining({ bossId: "4321" })]
    });
  });

  it("drops Mythic wipe evidence for bosses already killed in the same report", async () => {
    // Break caught: a wipe row from the same report and boss as a kill can
    // remain and create a false impression of mixed progression status.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "Silvermoon" },
                  recentReports: {
                    data: [
                      {
                        code: "mixedReport",
                        startTime: 1_706_918_400_000,
                        zone: {
                          id: 42,
                          name: "Nerub-ar Palace",
                          encounters: [{ id: 1234, journalID: 2345 }]
                        },
                        masterData: {
                          actors: [
                            {
                              id: 7,
                              name: "Sentinel",
                              server: "Silvermoon",
                              type: "Player"
                            }
                          ]
                        },
                        fights: [
                          {
                            id: 1,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 120_000,
                            endTime: 180_000,
                            kill: false,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          },
                          {
                            id: 2,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 360_000,
                            endTime: 420_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          },
                          {
                            id: 3,
                            encounterID: 4321,
                            name: "The Silken Court",
                            startTime: 600_000,
                            endTime: 660_000,
                            kill: false,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [{ bossId: "1234" }],
      wipes: [{ bossId: "4321" }]
    });
    expect(result).not.toMatchObject({
      wipes: [{ bossId: "1234" }]
    });
  });

  it("retains every wipe newest-first with a stable report tie-break", async () => {
    // Break caught: keeping only the latest wipe hides earlier progression
    // evidence, while ties must not depend on upstream report order.
    const report = (code: string, endTime: number) => ({
      code,
      startTime: 1_706_918_400_000,
      guild: null,
      zone: {
        id: 42,
        name: "Nerub-ar Palace",
        encounters: [{ id: 1234, journalID: 2345 }]
      },
      masterData: {
        actors: [
          {
            id: 7,
            name: "Sentinel",
            server: "Silvermoon",
            type: "Player"
          }
        ]
      },
      fights: [
        {
          id: 1,
          encounterID: 1234,
          name: "Queen Ansurek",
          startTime: endTime - 60_000,
          endTime,
          kill: false,
          difficulty: 5,
          friendlyPlayers: [7]
        }
      ]
    });
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "Silvermoon" },
                  recentReports: {
                    data: [
                      report("z-report", 300_000),
                      report("older-report", 120_000),
                      report("a-report", 300_000)
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      wipes: [
        {
          attemptedAt: "2024-02-03T00:05:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/a-report#fight=1"
        },
        {
          attemptedAt: "2024-02-03T00:05:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/z-report#fight=1"
        },
        {
          attemptedAt: "2024-02-03T00:02:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/older-report#fight=1"
        }
      ]
    });
  });

  it("attributes a Mythic kill to the report guild at the boss death time", async () => {
    // Break caught: report uploader guilds and the end of the successful pull
    // are the only public facts that can identify the first-kill guild/date.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "Silvermoon" },
                  recentReports: {
                    data: [
                      {
                        code: "guildReport",
                        startTime: 1_706_918_400_000,
                        guild: {
                          name: "Example Guild",
                          server: {
                            slug: "silvermoon",
                            region: { slug: "eu" }
                          }
                        },
                        zone: {
                          id: 42,
                          name: "Nerub-ar Palace",
                          encounters: [{ id: 1234, journalID: 2345 }]
                        },
                        masterData: {
                          actors: [
                            {
                              id: 7,
                              name: "Sentinel",
                              server: "Silvermoon",
                              type: "Player"
                            }
                          ]
                        },
                        fights: [
                          {
                            id: 3,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 3_600_000,
                            endTime: 7_200_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          killedAt: "2024-02-03T02:00:00.000Z",
          journalBossId: "2345",
          guild: {
            name: "Example Guild",
            region: "eu",
            realm: "silvermoon"
          }
        }
      ]
    });
  });

  it("keeps a public personal report valid when its guild is null", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "Silvermoon" },
                  recentReports: {
                    data: [
                      {
                        code: "personalReport",
                        startTime: 1_706_918_400_000,
                        guild: null,
                        zone: { id: 42, name: "Nerub-ar Palace" },
                        masterData: {
                          actors: [
                            {
                              id: 7,
                              name: "Sentinel",
                              server: "Silvermoon",
                              type: "Player"
                            }
                          ]
                        },
                        fights: [
                          {
                            id: 3,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 3_600_000,
                            endTime: 7_200_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({ kind: "evidence", kills: [{ guild: null }] });
  });

  it("ignores non-player actors and nullable trash while matching the resolved WCL realm", async () => {
    // Break caught: NPC actors have no player realm, trash fields are nullable,
    // and WCL's compact realm name differs from Blizzard's canonical slug.
    const aeriePeakKey: CharacterKey = {
      region: "us",
      realm: "aerie-peak",
      name: "sentinel"
    };
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  server: { normalizedName: "AeriePeak" },
                  recentReports: {
                    data: [
                      {
                        code: "realmReport",
                        startTime: 1_706_918_400_000,
                        zone: { id: 42, name: "Nerub-ar Palace" },
                        masterData: {
                          actors: [
                            {
                              id: 99,
                              name: "Queen Ansurek",
                              server: null,
                              type: "NPC"
                            },
                            {
                              id: 7,
                              name: "Sentinel",
                              server: "AeriePeak",
                              type: "Player"
                            }
                          ]
                        },
                        fights: [
                          {
                            id: 1,
                            encounterID: 0,
                            name: null,
                            startTime: 0,
                            endTime: 0,
                            kill: null,
                            difficulty: null,
                            friendlyPlayers: null
                          },
                          {
                            id: 2,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 3_600_000,
                            endTime: 3_600_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7]
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    await expect(
      client.getFirstKillReports(aeriePeakKey, {
        requestCap: 1,
        parseRequestCap: 10
      })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          bossId: "1234",
          reportUrl: "https://www.warcraftlogs.com/reports/realmReport"
        }
      ]
    });
  });

  it("reuses one OAuth token across separate first-kill report calls", async () => {
    // Break caught: fetching a token per dossier character would exhaust the
    // public OAuth quota even though the prior token remains valid.
    const reportPage = (
      fixture("character-report-valid") as { pages: unknown[] }
    ).pages[1];
    const { client, fetch } = clientFor((url) =>
      url.pathname === "/oauth/token" ? token() : jsonResponse(reportPage)
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 10, parseRequestCap: 10 })
    ).resolves.toMatchObject({ kind: "evidence" });
    await expect(
      client.getFirstKillReports(key, { requestCap: 10, parseRequestCap: 10 })
    ).resolves.toMatchObject({ kind: "evidence" });

    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it("refreshes the OAuth token sixty seconds before its reported expiry", async () => {
    // Break caught: a token used at its provider expiry can fail an otherwise
    // valid GraphQL request, so the cache must refresh it one minute early.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-02-01T00:00:00.000Z"));
    try {
      const reportPage = (
        fixture("character-report-valid") as { pages: unknown[] }
      ).pages[1];
      let issuedTokens = 0;
      const authorizations: string[] = [];
      const { client, fetch } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") {
          issuedTokens++;
          return jsonResponse({
            access_token: `token-${issuedTokens}`,
            expires_in: 120
          });
        }
        authorizations.push(
          (init?.headers as Record<string, string>).Authorization
        );
        return jsonResponse(reportPage);
      });

      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 10
      });
      await vi.advanceTimersByTimeAsync(59_000);
      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 10
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 10
      });

      expect(fetch).toHaveBeenCalledTimes(17);
      expect(authorizations).toEqual([
        ...Array.from({ length: 10 }, () => "Bearer token-1"),
        ...Array.from({ length: 5 }, () => "Bearer token-2")
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns schema drift for a timestamp outside JavaScript's date range", async () => {
    // Break caught: an unbounded upstream timestamp made toISOString throw and
    // turned a source limitation into an application exception.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  recentReports: {
                    data: [
                      {
                        code: "malformedTimestamp",
                        startTime: Number.MAX_VALUE,
                        fights: [
                          {
                            id: 1,
                            encounterID: 1234,
                            startTime: 0,
                            kill: true,
                            difficulty: 5
                          }
                        ]
                      }
                    ],
                    has_more_pages: false
                  }
                }
              }
            }
          })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toEqual({ kind: "limitation", code: "schema_drift" });
  });

  it("represents a private GraphQL profile without exposing its envelope", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse(fixture("character-private"))
    );

    const result = await client.resolveCharacter(key);
    expect(result).toEqual({ kind: "limitation", code: "private" });
    expect(JSON.stringify(result)).not.toContain("private-envelope-marker");
    expect(JSON.stringify(result)).not.toContain("client-secret-marker");
  });

  it("represents an absent public character as not found", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({ data: { characterData: { character: null } } })
    );

    await expect(client.resolveCharacter(key)).resolves.toEqual({
      kind: "limitation",
      code: "not_found"
    });
  });

  it("returns a rate-limit limitation without exposing an upstream body", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : new Response("rate-limit-body-marker", {
            status: 429,
            headers: { "Retry-After": "60" }
          })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });
    expect(result).toEqual({
      kind: "limitation",
      code: "rate_limited",
      retryAfterMs: 60_000
    });
    expect(JSON.stringify(result)).not.toContain("rate-limit-body-marker");
    expect(JSON.stringify(result)).not.toContain("client-secret-marker");
  });

  it("reports a throttled response through onThrottle", async () => {
    const throttles: Array<{ retryAfterMs: number | undefined }> = [];
    const client = createWarcraftLogsClient({
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        return url.pathname === "/oauth/token"
          ? token()
          : new Response("", { status: 429, headers: { "Retry-After": "60" } });
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker",
      onThrottle: (event) => throttles.push(event)
    });

    await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });

    expect(throttles).toEqual([{ retryAfterMs: 60_000 }]);
  });

  it("keeps a throwing onThrottle from changing the returned limitation", async () => {
    // Break caught: an unguarded reporting callback could turn a Warcraft Logs
    // throttle into an unexpected_error job retry instead of the rate_limited
    // limitation the caller handles.
    const client = createWarcraftLogsClient({
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        return url.pathname === "/oauth/token"
          ? token()
          : new Response("", { status: 429, headers: { "Retry-After": "60" } });
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "secret",
      onThrottle: () => {
        throw new Error("logger-exploded-marker");
      }
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "limitation",
      code: "rate_limited",
      retryAfterMs: 60_000
    });
  });

  it("does not require onThrottle", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : new Response("", { status: 429 })
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({ kind: "limitation", code: "rate_limited" });
  });

  it("reports a non-429 response carrying Retry-After as throttling", async () => {
    // "Upstream asked us to back off" is the definition shared with Blizzard
    // and Raider.IO, so a 503 with Retry-After must fire onThrottle even
    // though it still returns the unavailable limitation, unchanged.
    const throttles: Array<{ retryAfterMs: number | undefined }> = [];
    const client = createWarcraftLogsClient({
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        return url.pathname === "/oauth/token"
          ? token()
          : new Response("", { status: 503, headers: { "Retry-After": "30" } });
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker",
      onThrottle: (event) => throttles.push(event)
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });

    expect(throttles).toEqual([{ retryAfterMs: 30_000 }]);
    expect(result).toEqual({ kind: "limitation", code: "unavailable" });
  });

  it("does not report a response without Retry-After as throttling", async () => {
    const throttles: unknown[] = [];
    const client = createWarcraftLogsClient({
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        return url.pathname === "/oauth/token"
          ? token()
          : new Response("", { status: 503 });
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker",
      onThrottle: () => throttles.push(true)
    });

    await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });

    expect(throttles).toEqual([]);
  });

  it("stops paging at the caller's request cap", async () => {
    const firstPage = (
      fixture("character-report-valid") as {
        pages: unknown[];
      }
    ).pages[0];
    const { client, fetch } = clientFor((url) =>
      url.pathname === "/oauth/token" ? token() : jsonResponse(firstPage)
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: expect.any(Array),
      limitation: { kind: "limitation", code: "request_cap" }
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("retains collected kills if a later report page is malformed", async () => {
    const firstPage = (
      fixture("character-report-valid") as { pages: unknown[] }
    ).pages[0];
    let page = 0;
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse(page++ === 0 ? firstPage : fixture("schema-drift"))
    );
    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 10
    });
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "schema_drift" }
    });
    if (result.kind === "evidence")
      expect(result.kills.length).toBeGreaterThan(0);
  });

  it("retains evidence collected before a malformed report on the same page", async () => {
    const page = structuredClone(
      (fixture("character-report-valid") as { pages: unknown[] }).pages[1]
    ) as {
      data: {
        characterData: {
          character: {
            recentReports: { data: Array<Record<string, unknown>> };
          };
        };
      };
    };
    page.data.characterData.character.recentReports.data.push({
      code: null
    });
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token" ? token() : jsonResponse(page)
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: expect.arrayContaining([
        expect.objectContaining({
          fightUrl: expect.stringContaining("earlyReport#fight=7")
        })
      ]),
      limitation: { code: "schema_drift" }
    });
  });

  it("retains evidence collected before a malformed fight in the same report", async () => {
    const page = structuredClone(
      (fixture("character-report-valid") as { pages: unknown[] }).pages[1]
    ) as {
      data: {
        characterData: {
          character: {
            recentReports: {
              data: Array<{ fights: Array<Record<string, unknown>> }>;
            };
          };
        };
      };
    };
    page.data.characterData.character.recentReports.data[0]!.fights.push({
      id: null
    });
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token" ? token() : jsonResponse(page)
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [{ fightUrl: expect.stringContaining("earlyReport#fight=7") }],
      limitation: { code: "schema_drift" }
    });
  });

  it.each([
    ["missing start", undefined, 3_600_000],
    ["reversed interval", 3_600_001, 3_600_000]
  ])("rejects a fight with a %s", async (_label, startTime, endTime) => {
    const page = structuredClone(
      (fixture("character-report-valid") as { pages: unknown[] }).pages[1]
    ) as {
      data: {
        characterData: {
          character: {
            recentReports: {
              data: Array<{ fights: Array<Record<string, unknown>> }>;
            };
          };
        };
      };
    };
    page.data.characterData.character.recentReports.data = [
      page.data.characterData.character.recentReports.data[0]!
    ];
    const fight =
      page.data.characterData.character.recentReports.data[0]!.fights[0]!;
    fight.startTime = startTime;
    fight.endTime = endTime;
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token" ? token() : jsonResponse(page)
    );

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 10 })
    ).resolves.toEqual({ kind: "limitation", code: "schema_drift" });
  });

  it("retains collected kills when the history deadline expires", async () => {
    const firstPage = (
      fixture("character-report-valid") as { pages: unknown[] }
    ).pages[0];
    const controller = new AbortController();
    let page = 0;
    const { client } = clientFor((url) => {
      if (url.pathname === "/oauth/token") return token();
      if (page++ === 0) return jsonResponse(firstPage);
      controller.abort(new DOMException("History deadline", "TimeoutError"));
      throw controller.signal.reason;
    });
    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 10,
      signal: controller.signal
    });
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "unavailable" },
      parseLimitation: { code: "parse_unavailable" }
    });
    if (result.kind === "evidence")
      expect(result.kills.length).toBeGreaterThan(0);
  });

  it("classifies malformed GraphQL envelopes as schema drift without returning them", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse(fixture("schema-drift"))
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });
    expect(result).toEqual({ kind: "limitation", code: "schema_drift" });
    expect(JSON.stringify(result)).not.toContain("schema-envelope-marker");
    expect(JSON.stringify(result)).not.toContain("client-secret-marker");
  });
});
