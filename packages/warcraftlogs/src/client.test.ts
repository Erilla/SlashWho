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

/**
 * One verified kill in the named guild, on a night no fixture report spans,
 * so attendance is searched for it. Attendance is read for nothing else.
 */
function verifiedIn(name: string, realm = "silvermoon") {
  return [
    {
      at: "2001-01-01T20:00:00.000Z",
      guild: { name, realm, region: "eu" as const }
    }
  ];
}

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

function emptyZoneRankingsResponse(): Response {
  return jsonResponse({
    data: {
      characterData: {
        character: {
          damage: { rankings: [] },
          healing: { rankings: [] },
          bossDamage: { rankings: [] }
        }
      }
    }
  });
}

function zoneRankingsResponse(
  rankings: readonly unknown[],
  metrics: readonly ("damage" | "healing" | "bossDamage")[] = [
    "damage",
    "healing",
    "bossDamage"
  ]
): Response {
  return jsonResponse({
    data: {
      characterData: {
        character: {
          damage: { rankings: metrics.includes("damage") ? rankings : [] },
          healing: { rankings: metrics.includes("healing") ? rankings : [] },
          bossDamage: {
            rankings: metrics.includes("bossDamage") ? rankings : []
          }
        }
      }
    }
  });
}

function clientFor(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  clock: Readonly<{ monotonic?: () => number }> = {}
) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    let response = await responder(url, init);
    if (url.pathname === "/api/v2/client") {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string };
      };
      // Peek at the payload by reading it once and rebuilding the response:
      // a discarded clone() cancels the original's body when collected.
      const readOnce = async () => {
        const text = await response.text();
        response = new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
        return text;
      };
      // Zone rankings are their own request. A responder written for the
      // report path would answer it with a report payload, so tests that do
      // not care about tier bests get an empty zone instead.
      if (body.query.includes("CharacterZoneParses")) {
        let character: unknown;
        try {
          character = (
            JSON.parse(await readOnce()) as {
              data?: { characterData?: { character?: unknown } };
            }
          ).data?.characterData?.character;
        } catch {
          return emptyZoneRankingsResponse();
        }
        const shaped =
          character === null ||
          (typeof character === "object" &&
            character !== null &&
            "damage" in character &&
            !("recentReports" in character));
        if (!shaped) return emptyZoneRankingsResponse();
      }
      if (body.query.includes("ReportFightParses")) {
        let payload: { data?: { reportData?: unknown } };
        try {
          payload = JSON.parse(await readOnce()) as {
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
      clientSecret: "client-secret-marker",
      ...clock
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
  encounterId = 3306,
  startTime = 1_728_086_400_000
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
                startTime,
                zone: {
                  id: 1047,
                  name: "Nerub-ar Palace",
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

/**
 * Synthetic Warcraft Logs zone ids, each standing for a real windowed tier.
 *
 * A zone is asked for Mythic rankings only when the catalogue can place it in
 * a content window that reaches the Mythic era, so a made-up zone name is no
 * longer a neutral stand-in: the run would skip it before spending a request
 * (#351). The kill dates sit inside each tier's own window.
 */
const windowedZones = {
  101: { raidName: "Nerub-ar Palace", killedAt: "2024-10-01T00:00:00.000Z" },
  102: {
    raidName: "Liberation of Undermine",
    killedAt: "2025-04-01T00:00:00.000Z"
  },
  103: { raidName: "Manaforge Omega", killedAt: "2025-09-01T00:00:00.000Z" }
} as const;

type WindowedZoneId = keyof typeof windowedZones;

function windowedZoneReport(
  zoneId: WindowedZoneId,
  hasMorePages = false
): unknown {
  const zone = windowedZones[zoneId];
  const report = performanceReport(
    [26],
    hasMorePages,
    `report-${zoneId}`,
    3300 + zoneId,
    Date.parse(zone.killedAt)
  ) as {
    data: {
      characterData: {
        character: {
          recentReports: { data: { zone: { id: number; name: string } }[] };
        };
      };
    };
  };
  const reported =
    report.data.characterData.character.recentReports.data[0]!.zone;
  reported.id = zoneId;
  reported.name = zone.raidName;
  return report;
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
    spec?: string;
    class?: string | number;
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
            rankPercent,
            ...(options.spec === undefined ? {} : { spec: options.spec }),
            ...(options.class === undefined ? {} : { class: options.class })
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

// Rewrites the identity every ranking row carries, standing in for an upstream
// change to how Report.rankings names a character.
function driftedRankingIdentity(
  rankings: unknown,
  identity: Readonly<Record<string, unknown>>
): unknown {
  const report = (
    rankings as {
      data: {
        reportData: {
          report: Record<string, { data: Array<Record<string, unknown>> }>;
        };
      };
    }
  ).data.reportData.report;
  for (const metric of ["damage", "healing", "bossDamage"] as const) {
    for (const row of report[metric]!.data) {
      const roles = row.roles as {
        dps: { characters: Array<Record<string, unknown>> };
      };
      roles.dps.characters = roles.dps.characters.map((character) => ({
        ...character,
        ...identity
      }));
    }
  }
  return rankings;
}

function canonicalIdentityResponse(): Response {
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

// Two reports of the same boss: the earlier one owns the first kill, so the
// hydration loop reaches it first and the later report is what a premature
// abort would cost.
function twoKillReports(): unknown {
  const early = performanceReport(
    [26],
    false,
    "early-report",
    3306,
    1_728_086_400_000
  ) as {
    data: {
      characterData: { character: { recentReports: { data: unknown[] } } };
    };
  };
  const late = performanceReport(
    [27],
    false,
    "late-report",
    3306,
    1_728_172_800_000
  ) as {
    data: {
      characterData: { character: { recentReports: { data: unknown[] } } };
    };
  };
  early.data.characterData.character.recentReports.data.push(
    late.data.characterData.character.recentReports.data[0]
  );
  return early;
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
  it("reads the hourly points allowance including a fractional spend", async () => {
    // Break caught: an integer validator on pointsSpentThisHour would reject the
    // real 9058.65 as schema drift, and the budget gate would silently fail open.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              rateLimitData: {
                limitPerHour: 18000,
                pointsSpentThisHour: 9058.65,
                pointsResetIn: 949
              }
            }
          })
    );

    expect(await client.getRateLimit()).toEqual({
      kind: "rate_limit",
      limitPerHour: 18000,
      pointsSpentThisHour: 9058.65,
      pointsResetInSeconds: 949
    });
  });

  it("returns a limitation when the rate limit query cannot be read", async () => {
    // Break caught: throwing here would make the admission gate fail closed on
    // its own transport errors and stop all evidence collection permanently.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : new Response("upstream-body-marker", { status: 503 })
    );

    expect(await client.getRateLimit()).toEqual({
      kind: "limitation",
      code: "unavailable"
    });
  });

  it("reports schema drift when the rate limit response omits its fields", async () => {
    // Break caught: a missing limitPerHour read as 0 would make every run look
    // over budget and refuse collection forever.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({ data: { rateLimitData: { pointsResetIn: 949 } } })
    );

    expect(await client.getRateLimit()).toEqual({
      kind: "limitation",
      code: "schema_drift"
    });
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
              id: 40989140,
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
      displayName: "Sentinel",
      characterId: 40989140
    });
  });

  it("asks for the stable character ID when resolving by name", async () => {
    // Break caught: without `id` in the selection the ID could never be
    // persisted, and every later read would stay name-keyed.
    const { client, fetch } = clientFor((url) => {
      if (url.pathname === "/oauth/token") return token();
      return jsonResponse({ data: { characterData: { character: null } } });
    });

    await client.resolveCharacter(key);

    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)) as {
      query: string;
    };
    expect(body.query).toMatch(/character\([^)]*\)\s*\{\s*id\b/);
  });

  it("reports schema drift when a resolved character carries no usable ID", async () => {
    // Break caught: a missing ID read as absent would persist a character with
    // no stable identity and silently fall back to name lookups forever.
    for (const id of [undefined, null, 0, -3, 1.5, "40989140"]) {
      const { client } = clientFor((url) =>
        url.pathname === "/oauth/token"
          ? token()
          : jsonResponse({
              data: {
                characterData: {
                  character: {
                    id,
                    name: "Sentinel",
                    server: { slug: "silvermoon", region: { slug: "eu" } }
                  }
                }
              }
            })
      );
      await expect(client.resolveCharacter(key)).resolves.toEqual({
        kind: "limitation",
        code: "schema_drift"
      });
    }
  });

  it("resolves a stable character ID to its current name, realm and region", async () => {
    // Break caught: a renamed or transferred character pasted by ID would be
    // resolved by some other means, or to the name it held when first logged.
    let variables: unknown;
    let query = "";
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      ({ query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables: unknown;
      });
      return jsonResponse({
        data: {
          characterData: {
            character: {
              id: 40989140,
              name: "Ryun",
              server: { slug: "silvermoon", region: { slug: "eu" } }
            }
          }
        }
      });
    });

    await expect(client.resolveCharacterById(40989140)).resolves.toEqual({
      kind: "identity",
      key: { region: "eu", realm: "silvermoon", name: "ryun" },
      displayName: "Ryun",
      characterId: 40989140
    });
    expect(variables).toEqual({ id: 40989140 });
    expect(query).toContain("character(id: $id)");
  });

  it("represents an unknown character ID as not found", async () => {
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({ data: { characterData: { character: null } } })
    );

    await expect(client.resolveCharacterById(7)).resolves.toEqual({
      kind: "limitation",
      code: "not_found"
    });
  });

  it("reports schema drift when an ID lookup answers for another character", async () => {
    // Break caught: trusting the payload over the request would attach one
    // character's identity to a different pasted ID.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse({
            data: {
              characterData: {
                character: {
                  id: 8,
                  name: "Ryun",
                  server: { slug: "silvermoon", region: { slug: "eu" } }
                }
              }
            }
          })
    );

    await expect(client.resolveCharacterById(7)).resolves.toEqual({
      kind: "limitation",
      code: "schema_drift"
    });
  });

  it("refuses an ID that is not a positive safe integer without a request", async () => {
    const { client, fetch } = clientFor(() => token());
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      await expect(client.resolveCharacterById(id)).rejects.toThrow(
        "invalid_character_id"
      );
    }
    expect(fetch).not.toHaveBeenCalled();
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
                      startTime: 1_728_086_400_000,
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
      // Both nights sit inside the fixture zone's content window, which is
      // what lets either be hydrated at all.
      startTime: Date.parse("2024-10-06T00:00:00.000Z")
    };
    (
      recent.data.characterData.character.recentReports as unknown as {
        has_more_pages: boolean;
      }
    ).has_more_pages = true;
    firstKill.data.characterData.character.recentReports.data[0] = {
      ...(firstKill.data.characterData.character.recentReports
        .data[0] as object),
      startTime: Date.parse("2024-10-05T00:00:00.000Z")
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
      // Six leaves room for the zone-rankings request, the three report groups
      // and the one shared canonical identity lookup. A per-group identity
      // lookup would still exhaust it before the third group.
      requestCap: 3,
      parseRequestCap: 6
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

  it("does not spend parse requests on kills the dossier will withhold", async () => {
    // Break caught: kills outside a raid's current-content window are never
    // shown, yet hydration spent its scarce, rate-limited budget on them —
    // years-old reports crowded out the current tier entirely.
    const requested: string[] = [];
    // Nerub-ar Palace closed 2025-03-05; this kill lands well after it.
    const stale = performanceReport(
      [26],
      true,
      "out-of-window-report",
      3306,
      Date.parse("2025-08-01T00:00:00.000Z")
    ) as {
      data: {
        characterData: {
          character: { recentReports: { data: { zone: { name: string } }[] } };
        };
      };
    };
    stale.data.characterData.character.recentReports.data[0]!.zone.name =
      "Nerub-ar Palace";
    const current = performanceReport(
      [27],
      false,
      "in-window-report",
      3307,
      Date.parse("2024-10-01T00:00:00.000Z")
    ) as {
      data: {
        characterData: {
          character: { recentReports: { data: { zone: { name: string } }[] } };
        };
      };
    };
    current.data.characterData.character.recentReports.data[0]!.zone.name =
      "Nerub-ar Palace";
    const reports: unknown[] = [stale, current];
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        requested.push(body.variables?.code ?? "?");
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 8
    });

    expect(requested).toEqual(["in-window-report"]);
  });

  it("reads one zone-rankings request per tier for the character's best parse", async () => {
    // Break caught: a character-level best assembled from report rankings costs
    // one request per report and is unbounded with history, so a capped run
    // could only ever report the best of the reports it happened to reach.
    const zoneIds: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number };
      };
      if (body.query.includes("CharacterZoneParses")) {
        zoneIds.push(body.variables?.zoneID ?? -1);
        return zoneRankingsResponse([
          {
            encounter: { id: 3306, name: "Plexus Sentinel" },
            rankPercent: 96.2,
            bestSpec: "Destruction",
            class: 10,
            totalKills: 8
          },
          {
            encounter: { id: 3307, name: "Loom'ithar" },
            rankPercent: 88,
            bestSpec: "Destruction",
            class: 10,
            totalKills: 10
          }
        ]);
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(zoneIds).toEqual([1047]);
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.tierBests).toEqual([
      {
        raidId: "1047",
        raidName: "Nerub-ar Palace",
        bossId: "3306",
        bossName: "Plexus Sentinel",
        rankingsUrl:
          "https://www.warcraftlogs.com/character/eu/silvermoon/sentinel#zone=1047&boss=3306&difficulty=5",
        performance: {
          spec: {
            name: "Destruction",
            iconUrl:
              "https://wow.zamimg.com/images/wow/icons/medium/spell_shadow_rainoffire.jpg"
          },
          damage: { state: "available", percentile: 96.2 },
          healing: { state: "available", percentile: 96.2 },
          bossDamage: { state: "available", percentile: 96.2 }
        }
      },
      {
        raidId: "1047",
        raidName: "Nerub-ar Palace",
        bossId: "3307",
        bossName: "Loom'ithar",
        rankingsUrl:
          "https://www.warcraftlogs.com/character/eu/silvermoon/sentinel#zone=1047&boss=3307&difficulty=5",
        performance: {
          spec: {
            name: "Destruction",
            iconUrl:
              "https://wow.zamimg.com/images/wow/icons/medium/spell_shadow_rainoffire.jpg"
          },
          damage: { state: "available", percentile: 88 },
          healing: { state: "available", percentile: 88 },
          bossDamage: { state: "available", percentile: 88 }
        }
      }
    ]);
  });

  it("leaves a metric unavailable when its zone ranking carries no percentile", async () => {
    // Break caught: a specialisation that is not ranked under a metric returns
    // the encounter with a null percentile, which must stay unavailable rather
    // than being read as a zero parse.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse(
          [
            {
              encounter: { id: 3306, name: "Plexus Sentinel" },
              rankPercent: 71.5,
              bestSpec: "Restoration",
              class: 9
            }
          ],
          ["healing"]
        );
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.tierBests).toMatchObject([
      {
        bossId: "3306",
        performance: {
          damage: { state: "unavailable" },
          healing: { state: "available", percentile: 71.5 },
          bossDamage: { state: "unavailable" }
        }
      }
    ]);
  });

  it("spends at most half the parse budget on zones, newest tier first", async () => {
    // Break caught: one request per tier is cheap but a full history spans
    // sixteen of them, and letting them take the whole budget would starve the
    // per-fight hydration the first-kill row depends on.
    const zoneIds: number[] = [];
    const reportCodes: string[] = [];
    const reports = ([101, 102, 103] as const).map((zoneId) =>
      windowedZoneReport(zoneId, zoneId !== 103)
    );
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        zoneIds.push(body.variables?.zoneID ?? -1);
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        reportCodes.push(body.variables?.code ?? "?");
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 5
    });

    expect(zoneIds).toEqual([103, 102]);
    expect(reportCodes).toEqual(["report-103", "report-102"]);
    expect(result).toMatchObject({
      kind: "evidence",
      parseLimitation: { kind: "limitation", code: "parse_request_cap" }
    });
  });

  it("reaches a deeper tier and settles once the newest zones are collected", async () => {
    // Break caught: the zone list was rebuilt whole on every run, so the same
    // newest zones were re-requested forever, the deeper ones the budget
    // displaced never landed, and the run raised `parse_request_cap` however
    // saturated it was -- a cap that can never clear cannot schedule a retry.
    const zoneIds: number[] = [];
    const reports = ([101, 102, 103] as const).map((zoneId) =>
      windowedZoneReport(zoneId, zoneId !== 103)
    );
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        zoneIds.push(body.variables?.zoneID ?? -1);
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 5,
      // Both newest zones collected after their newest kill; 101 is not.
      collectedTierZones: new Map([
        ["103", "2026-06-01T00:00:00.000Z"],
        ["102", "2026-06-01T00:00:00.000Z"]
      ])
    });

    // The deeper tier the newest two were displacing, and nothing re-read.
    expect(zoneIds).toEqual([101]);
    // One pending zone fits the budget of two, so the cap is not raised.
    expect(result).toMatchObject({ kind: "evidence" });
    expect(result).not.toHaveProperty("parseLimitation");
  });

  it("stops paging once a page falls entirely below the kill scan floor", async () => {
    // 36 pages of `RecentReports` on every run is the other half of what a
    // 353-report character costs. Reports come newest first, so once a page is
    // wholly below the floor, everything past it is too.
    const pages: number[] = [];
    const startTimes = [
      Date.parse("2026-09-10T00:00:00.000Z"),
      Date.parse("2023-01-01T00:00:00.000Z"),
      Date.parse("2022-01-01T00:00:00.000Z")
    ];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { page?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const page = body.variables?.page ?? 1;
      pages.push(page);
      const startTime = startTimes[page - 1];
      if (startTime === undefined) throw new Error("unexpected_report_page");
      return jsonResponse(
        performanceReport([26], true, `report-${page}`, 3306, startTime)
      );
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 9,
      killScanFloor: "2024-01-01T00:00:00.000Z"
    });

    expect(pages).toEqual([1, 2]);
    // A clean stop, not a cap. A limitation here would mark the run partial and
    // block the very marks that allowed the stop, so it would never settle.
    expect(result).not.toHaveProperty("limitation");
  });

  it("stops on a page of nothing but dungeons below the floor", async () => {
    // Break caught: dropping Mythic dungeon fights from the evidence left a
    // dungeon-only page carrying no dates, so it could no longer end the scan
    // and a history full of Mythic+ paged straight past its floor. How far a
    // page reached is a property of the reports on it, not of what they
    // contributed (#346).
    const pages: number[] = [];
    const startTimes = [
      Date.parse("2026-09-10T00:00:00.000Z"),
      Date.parse("2023-01-01T00:00:00.000Z"),
      Date.parse("2022-01-01T00:00:00.000Z")
    ];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { page?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const page = body.variables?.page ?? 1;
      pages.push(page);
      const startTime = startTimes[page - 1];
      if (startTime === undefined) throw new Error("unexpected_report_page");
      const report = performanceReport(
        [26],
        true,
        `report-${page}`,
        3306,
        startTime
      ) as {
        data: {
          characterData: {
            character: {
              recentReports: {
                data: { fights: { gameZone?: unknown }[] }[];
              };
            };
          };
        };
      };
      if (page > 1) {
        for (const fight of report.data.characterData.character.recentReports
          .data[0]!.fights) {
          fight.gameZone = { id: 2290, name: "Mists of Tirna Scithe" };
        }
      }
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 9,
      killScanFloor: "2024-01-01T00:00:00.000Z"
    });

    expect(pages).toEqual([1, 2]);
    expect(result).not.toHaveProperty("limitation");
    // And the dungeon never became evidence.
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [{ raidName: "Nerub-ar Palace" }]
    });
  });

  it("keeps paging when a page below the floor still carries a newer fight", async () => {
    const pages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { page?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const page = body.variables?.page ?? 1;
      pages.push(page);
      if (page === 1) {
        // One old fight and one recent one in the same page.
        const report = performanceReport(
          [26],
          true,
          "report-1",
          3306,
          Date.parse("2022-01-01T00:00:00.000Z")
        ) as {
          data: {
            characterData: {
              character: { recentReports: { data: unknown[] } };
            };
          };
        };
        const recent = performanceReport(
          [27],
          true,
          "report-1b",
          3307,
          Date.parse("2026-09-10T00:00:00.000Z")
        ) as {
          data: {
            characterData: {
              character: { recentReports: { data: unknown[] } };
            };
          };
        };
        report.data.characterData.character.recentReports.data.push(
          recent.data.characterData.character.recentReports.data[0]
        );
        return jsonResponse(report);
      }
      return jsonResponse(
        performanceReport(
          [28],
          false,
          "report-2",
          3308,
          Date.parse("2026-09-01T00:00:00.000Z")
        )
      );
    });

    await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 9,
      killScanFloor: "2024-01-01T00:00:00.000Z"
    });

    expect(pages).toEqual([1, 2]);
  });

  it("pages the whole history when no floor is given", async () => {
    const pages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { page?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const page = body.variables?.page ?? 1;
      pages.push(page);
      return jsonResponse(
        performanceReport(
          [26],
          page < 2,
          `report-${page}`,
          3306,
          Date.parse("2022-01-01T00:00:00.000Z")
        )
      );
    });

    await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 9
    });

    expect(pages).toEqual([1, 2]);
  });

  it("spends no zone request on a tier already terminal for tier bests", async () => {
    // A concluded tier read cleanly cannot change, so re-reading its bests
    // spends a rate-limited request on an answer we already hold.
    const zoneIds: number[] = [];
    const reports = ([102, 103] as const).map((zoneId) =>
      windowedZoneReport(zoneId, zoneId !== 103)
    );
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        zoneIds.push(body.variables?.zoneID ?? -1);
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 5,
      terminalRaidIds: {
        kills: new Set(),
        parses: new Set(),
        tierBests: new Set(["103"])
      }
    });

    expect(zoneIds).toEqual([102]);
    // A terminal zone is dropped before the budget is measured, so it cannot
    // raise a cap either.
    expect(result).not.toHaveProperty("parseLimitation");
  });

  it("spends no hydration request on a tier already terminal for parses", async () => {
    const reportCodes: string[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        reportCodes.push(body.variables?.code ?? "?");
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      return jsonResponse(performanceReport([26]));
    });

    await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 5,
      terminalRaidIds: {
        kills: new Set(),
        parses: new Set(["1047"]),
        tierBests: new Set(["1047"])
      }
    });

    expect(reportCodes).toEqual([]);
  });

  it("parses only the one raid a targeted search names", async () => {
    // Break caught (#492 review): a tier search's reports can hold another
    // raid's kills, and parsing them spent its budget on fights it discards.
    const parsedFor = async (parseJournalRaidId: string) => {
      const reportCodes: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables?: { code?: string };
        };
        if (body.query.includes("CharacterZoneParses")) {
          return zoneRankingsResponse([]);
        }
        if (body.query.includes("ReportFightParses")) {
          reportCodes.push(body.variables?.code ?? "?");
          return emptyRankingsResponse(body.variables?.code ?? "report");
        }
        return jsonResponse(performanceReport([26]));
      });
      await client.getFirstKillReports(key, {
        requestCap: 3,
        parseRequestCap: 5,
        parseJournalRaidId
      });
      return reportCodes;
    };

    // The fixture's kill is in Nerub-ar Palace.
    expect(await parsedFor("1296")).toEqual([]);
    expect(await parsedFor("1273")).not.toEqual([]);
  });

  it("names the raids a zone failure touched so the rest can still settle", async () => {
    // A tier only goes terminal if the run that read it reported no limitation
    // for *it*. One zone's drift must neither freeze the others nor block them.
    const reports = ([102, 103] as const).map((zoneId) =>
      windowedZoneReport(zoneId, zoneId !== 103)
    );
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return body.variables?.zoneID === 103
          ? jsonResponse({
              data: { characterData: { character: { damage: {} } } }
            })
          : zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 9
    });

    expect(result).toMatchObject({ kind: "evidence" });
    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.troubledRaidIds).toEqual({
      parses: [],
      tierBests: ["103"]
    });
  });

  it("reports no troubled raids when every zone reads cleanly", async () => {
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 9
    });

    expect(result).toMatchObject({
      kind: "evidence",
      troubledRaidIds: { parses: [], tierBests: [] }
    });
  });

  it("attributes a fight-parse failure to the parses domain alone", async () => {
    // Break caught: hydration trouble was blocking the kills mark, so a veteran
    // whose parse budget runs out every run never settled anything and
    // re-scanned their whole history forever (#304).
    const client = createWarcraftLogsClient({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("CharacterZoneParses")) {
          return emptyZoneRankingsResponse();
        }
        if (body.query.includes("ReportFightParses")) {
          return new Response("", { status: 503 });
        }
        return jsonResponse(performanceReport([26]));
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker"
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 9
    });

    expect(result).toMatchObject({ kind: "evidence" });
    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.troubledRaidIds).toEqual({
      parses: ["1047"],
      tierBests: []
    });
  });

  it("attributes zones beyond the zone budget to the tier bests domain", async () => {
    // The zone budget is the routine shortfall on a veteran, so it must land in
    // the domain it actually describes rather than blocking every domain.
    const zoneIds = [1041, 1042, 1043, 1044, 1045, 1046, 1047];
    const reports = zoneIds.map((zoneId, index) => {
      const report = performanceReport(
        [26 + index],
        index < zoneIds.length - 1,
        `report-${zoneId}`,
        3306 + index,
        1_728_086_400_000 - index * 86_400_000
      ) as {
        data: {
          characterData: {
            character: { recentReports: { data: { zone: { id: number } }[] } };
          };
        };
      };
      report.data.characterData.character.recentReports.data[0]!.zone.id =
        zoneId;
      return report;
    });
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    // floor((5 - 1) / 2) = 2 zones affordable, so five of the seven are missed.
    const result = await client.getFirstKillReports(key, {
      requestCap: 7,
      parseRequestCap: 5
    });

    expect(result).toMatchObject({ kind: "evidence" });
    if (result.kind !== "evidence") throw new Error("expected evidence");
    // The two newest zones are affordable and read cleanly; the five older
    // ones are never reached, and that shortfall is tier-bests trouble.
    expect(result.troubledRaidIds.tierBests).not.toContain("1041");
    expect(result.troubledRaidIds.tierBests).not.toContain("1042");
    expect(result.troubledRaidIds.tierBests).toEqual(
      expect.arrayContaining(["1043", "1044", "1045", "1046", "1047"])
    );
  });

  it("reopens a collected zone once a kill lands after its collection", async () => {
    // A zone's best parse is not immutable the way a fight's is: a new kill in
    // that tier can beat it, so "collected" has to mean collected since the
    // newest kill, not collected once.
    const zoneIds: number[] = [];
    const report = windowedZoneReport(103);
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        zoneIds.push(body.variables?.zoneID ?? -1);
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      if (page++ > 0) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 5,
      // Collected before the 2025-09-01 kill, so the zone is still pending.
      collectedTierZones: new Map([["103", "2025-04-01T00:00:00.000Z"]])
    });

    expect(zoneIds).toEqual([103]);
  });

  it("keeps hydrating fights after a zone-rankings response is malformed", async () => {
    // Break caught: the two rows answer different questions, so a zone the
    // character cannot be ranked in must not cost the first-kill row its
    // exact-fight parses.
    const reportCodes: string[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        return jsonResponse({
          data: { characterData: { character: { damage: {} } } }
        });
      }
      if (body.query.includes("ReportFightParses")) {
        reportCodes.push(body.variables?.code ?? "?");
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(reportCodes).toEqual(["performance-report"]);
    expect(result).toMatchObject({
      kind: "evidence",
      tierBests: [],
      parseLimitation: { kind: "limitation", code: "parse_schema_drift" }
    });
  });

  it("never asks for Mythic rankings in a zone that predates Mythic", async () => {
    // Break caught: Throne of Thunder is a Mists tier whose top difficulty was
    // Heroic, so `zoneRankings(difficulty: 5)` there is a malformed question.
    // Warcraft Logs refused it with an error envelope, the decoder read that as
    // schema drift, and a troubled raid never goes terminal -- so a veteran
    // re-paid the request and the limitation on every run, forever (#351).
    const zoneIds: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        zoneIds.push(body.variables?.zoneID ?? -1);
        return zoneRankingsResponse([]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = performanceReport([26]) as {
        data: {
          characterData: {
            character: {
              recentReports: { data: { zone: { id: number; name: string } }[] };
            };
          };
        };
      };
      const zone =
        report.data.characterData.character.recentReports.data[0]!.zone;
      zone.id = 4;
      zone.name = "Throne of Thunder";
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(zoneIds).toEqual([]);
    // The kill itself is untouched: a zone nobody can rank is still a kill.
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [{ raidName: "Throne of Thunder" }],
      tierBests: [],
      troubledRaidIds: { parses: [], tierBests: [] }
    });
    expect(result).not.toHaveProperty("parseLimitation");
  });

  it("reads a refused zone-rankings difficulty as inapplicable, not drift", async () => {
    // Break caught: `{ error }` is Warcraft Logs declining a question, not a
    // changed schema. Reported as drift it raised a limitation, and a troubled
    // raid cannot settle (#351).
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        const refusal = { error: "Invalid difficulty/size specified." };
        return jsonResponse({
          data: {
            characterData: {
              character: {
                damage: refusal,
                healing: refusal,
                bossDamage: refusal
              }
            }
          }
        });
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      return jsonResponse(performanceReport([26]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(result).toMatchObject({
      kind: "evidence",
      tierBests: [],
      troubledRaidIds: { parses: [], tierBests: [] }
    });
    expect(result).not.toHaveProperty("parseLimitation");
  });

  it("keeps reading later zones after one zone-rankings response is malformed", async () => {
    // Break caught: an unreadable tier response ended the zone loop, so every
    // older tier lost its best parses to one zone the decoder could not read.
    const zoneIds: number[] = [];
    const zones = [
      { zoneId: 102, startTime: 1_728_086_400_000 },
      { zoneId: 103, startTime: 1_728_172_800_000 }
    ];
    const reports = zones.map(({ zoneId, startTime }, index) => {
      const report = performanceReport(
        [26],
        index === 0,
        `report-${zoneId}`,
        3300 + zoneId,
        startTime
      ) as {
        data: {
          characterData: {
            character: {
              recentReports: { data: { zone: { id: number } }[] };
            };
          };
        };
      };
      report.data.characterData.character.recentReports.data[0]!.zone.id =
        zoneId;
      return report;
    });
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { zoneID?: number; code?: string };
      };
      if (body.query.includes("CharacterZoneParses")) {
        const zoneId = body.variables?.zoneID ?? -1;
        zoneIds.push(zoneId);
        return zoneId === 103
          ? jsonResponse({
              data: { characterData: { character: { damage: {} } } }
            })
          : zoneRankingsResponse([
              {
                encounter: { id: 3402, name: "Loom'ithar" },
                rankPercent: 88,
                bestSpec: "Destruction",
                class: 10
              }
            ]);
      }
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 2,
      parseRequestCap: 8
    });

    expect(zoneIds).toEqual([103, 102]);
    expect(result).toMatchObject({
      kind: "evidence",
      tierBests: [
        {
          raidId: "102",
          bossId: "3402",
          performance: { damage: { state: "available", percentile: 88 } }
        }
      ],
      parseLimitation: { kind: "limitation", code: "parse_schema_drift" }
    });
  });

  it("hydrates later report groups after one report's rankings are malformed", async () => {
    // Break caught: one ranking response the decoder rejected ended hydration
    // for the whole run, so every remaining report group stayed unparsed
    // however much of the parse budget was left.
    const reports = twoKillReports();

    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        const code = body.variables?.code ?? "early-report";
        if (code === "early-report") {
          const malformed = performanceRankings(
            { damage: 40, healing: 41, bossDamage: 42 },
            { code }
          ) as {
            data: {
              reportData: {
                report: { damage: { data: { roles?: unknown }[] } };
              };
            };
          };
          delete malformed.data.reportData.report.damage.data[0]!.roles;
          return jsonResponse(malformed);
        }
        return jsonResponse(
          performanceRankings(
            { damage: 50, healing: 51, bossDamage: 52 },
            { code, fightId: 27 }
          )
        );
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return canonicalIdentityResponse();
      }
      return jsonResponse(reports);
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 8 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        { fightId: 26, performance: { damage: { state: "unavailable" } } },
        {
          fightId: 27,
          performance: { damage: { state: "available", percentile: 50 } }
        }
      ],
      parseLimitation: { kind: "limitation", code: "parse_schema_drift" }
    });
  });

  it("records a drift the parse budget went on to overwrite", async () => {
    // Break caught, and the reason this went unseen for weeks: a drift raised
    // early in the hydration loop was plainly assigned over by
    // `parse_request_cap` when the budget ran out later in the same loop, so
    // the run published the cap and the drift was simply lost. The reported
    // code still tracks the budget -- it is the one that earns a retry -- but
    // the run now says both things happened (#349).
    const reports = twoKillReports();

    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        const code = body.variables?.code ?? "early-report";
        const malformed = performanceRankings(
          { damage: 40, healing: 41, bossDamage: 42 },
          { code }
        ) as {
          data: {
            reportData: { report: { damage: { data: { roles?: unknown }[] } } };
          };
        };
        delete malformed.data.reportData.report.damage.data[0]!.roles;
        return jsonResponse(malformed);
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return canonicalIdentityResponse();
      }
      return jsonResponse(reports);
    });

    // Two groups, and a cap that reserves one request for identities: the
    // first group drifts, the second trips the cap.
    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 2
    });

    expect(result).toMatchObject({
      kind: "evidence",
      parseLimitation: { kind: "limitation", code: "parse_request_cap" }
    });
    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.parseLimitations?.map((entry) => entry.code)).toEqual([
      "parse_schema_drift",
      "parse_request_cap"
    ]);
  });

  it("hydrates later report groups when an earlier report ranks nobody", async () => {
    // Break caught: a report whose rankings name no ranked character is an
    // ordinary gap, not drift, and treating it as drift abandoned the parses
    // already paid for in every remaining group.
    const reports = twoKillReports();

    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        const code = body.variables?.code ?? "early-report";
        return code === "early-report"
          ? emptyRankingsResponse(code)
          : jsonResponse(
              performanceRankings(
                { damage: 50, healing: 51, bossDamage: 52 },
                { code, fightId: 27 }
              )
            );
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return canonicalIdentityResponse();
      }
      return jsonResponse(reports);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        { fightId: 26, performance: { damage: { state: "unavailable" } } },
        {
          fightId: 27,
          performance: { damage: { state: "available", percentile: 50 } }
        }
      ]
    });
    expect(result).not.toHaveProperty("parseLimitation");
  });
  it("reports drift when a ranked report matches none of its identities to a present character", async () => {
    // Break caught: an upstream change to how ranking rows carry identity -
    // here a region suffix on `server.name` - matches nobody in any report, so
    // every fight stayed unavailable and the run emitted no limitation at all.
    // A report that ranked somebody while this character was among its actors
    // is not an ordinary gap (#273).
    const reports = twoKillReports();

    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        const code = body.variables?.code ?? "early-report";
        return code === "early-report"
          ? jsonResponse(
              driftedRankingIdentity(
                performanceRankings(
                  { damage: 50, healing: 51, bossDamage: 52 },
                  { code }
                ),
                { server: { name: "silvermoon-eu", region: "eu" } }
              )
            )
          : jsonResponse(
              performanceRankings(
                { damage: 50, healing: 51, bossDamage: 52 },
                { code, fightId: 27 }
              )
            );
      }
      if (body.query.includes("RankingCharacterIdentities")) {
        return canonicalIdentityResponse();
      }
      return jsonResponse(reports);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        { fightId: 26, performance: { damage: { state: "unavailable" } } },
        {
          fightId: 27,
          performance: { damage: { state: "available", percentile: 50 } }
        }
      ],
      // Its own code since #349. It shares this path with a character who was
      // in the fight and simply unranked, so classifying it as drift left it
      // unretryable and stalled ordinary characters for a day.
      parseLimitation: {
        kind: "limitation",
        code: "parse_identity_unmatched"
      }
    });
    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.troubledRaidIds).toEqual({ parses: ["1047"], tierBests: [] });
  });

  it("treats a ranked report without the character among its actors as an ordinary gap", async () => {
    // An anonymised character is named by neither the rankings nor the actors,
    // which is the ordinary gap the drift check must not claim as its own.
    const rankings = driftedRankingIdentity(
      performanceRankings({ damage: 50, healing: 51, bossDamage: 52 }),
      { name: "Bystander" }
    ) as { data: { reportData: { report: { masterData: unknown } } } };
    rankings.data.reportData.report.masterData = {
      actors: [
        { id: 1002, name: "Bystander", server: "Silvermoon", type: "Player" }
      ]
    };

    const { client } = performanceClient(rankings);

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    expect(result).toMatchObject({
      kind: "evidence",
      kills: [{ performance: { damage: { state: "unavailable" } } }]
    });
    expect(result).not.toHaveProperty("parseLimitation");
  });

  it("records a fight whose report ranked nobody as read", async () => {
    // The report was fetched and definitively held no ranking for this fight,
    // which is a different answer from never having asked. Stored the same
    // way, hydration re-requests the fight on every run forever (#297).
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      return jsonResponse(performanceReport());
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.kills[0]?.performance.damage.state).toBe("unavailable");
    expect(result.parsedFightUrls).toEqual([
      "https://www.warcraftlogs.com/reports/performance-report#fight=26"
    ]);
  });

  it("records a fight whose parses were applied as read", async () => {
    const { client } = performanceClient(
      performanceRankings({ damage: 50, healing: 51, bossDamage: 52 })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.parsedFightUrls).toEqual([
      "https://www.warcraftlogs.com/reports/performance-report#fight=26"
    ]);
  });

  it("records a fight as read when the character was in it and matched no ranking", async () => {
    // `parse_identity_unmatched` is an answer, not a failure: the report
    // ranked others and none of them was this character. #350 made it
    // retryable, so unless the attempt is recorded the retry never settles.
    const { client } = performanceClient(
      driftedRankingIdentity(
        performanceRankings({ damage: 50, healing: 51, bossDamage: 52 }),
        { server: { name: "silvermoon-eu", region: "eu" } }
      )
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.parseLimitation?.code).toBe("parse_identity_unmatched");
    expect(result.parsedFightUrls).toEqual([
      "https://www.warcraftlogs.com/reports/performance-report#fight=26"
    ]);
  });

  it("leaves a fight unread when its ranking response cannot be decoded", async () => {
    // Structural drift says nothing about whether a ranking exists, so the
    // fight must stay eligible for another attempt.
    const rankings = performanceRankings({
      damage: 50,
      healing: 51,
      bossDamage: 52
    }) as { data: { reportData: { report: { masterData: unknown } } } };
    rankings.data.reportData.report.masterData = { actors: [] };
    const { client } = performanceClient(rankings);

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.parseLimitation?.code).toBe("parse_schema_drift");
    expect(result.parsedFightUrls).toEqual([]);
  });

  it("leaves a fight unread when the decoder rejected the only response", async () => {
    // Nothing ranked means no identity to canonicalise, and the read then
    // ends early. That exit must not sweep up a group the decoder refused:
    // a fight nothing could be read about is not a fight that was answered.
    const rankings = performanceRankings({
      damage: 50,
      healing: 51,
      bossDamage: 52
    }) as { data: { reportData: { report: Record<string, unknown> } } };
    delete rankings.data.reportData.report.masterData;
    const { client } = performanceClient(rankings);

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });

    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.parseLimitation?.code).toBe("parse_schema_drift");
    expect(result.parsedFightUrls).toEqual([]);
  });

  it("leaves a fight unread when the parse budget never reached its report", async () => {
    const { client } = performanceClient(
      performanceRankings({ damage: 50, healing: 51, bossDamage: 52 })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      // One request, and one is reserved for the identity lookup, so no
      // report group is read at all.
      parseRequestCap: 1
    });

    if (result.kind !== "evidence") throw new Error("expected evidence");
    expect(result.parseLimitation?.code).toBe("parse_request_cap");
    expect(result.parsedFightUrls).toEqual([]);
  });

  it("does not re-request a report whose fights are already hydrated", async () => {
    // Break caught: every run walked the same reports in the same order, so a
    // capped run redid work it had already stored and never reached the rest.
    const requested: string[] = [];
    const reports = [
      performanceReport([26], true, "already-hydrated"),
      performanceReport([27], false, "still-missing")
    ];
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        requested.push(body.variables?.code ?? "?");
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 8,
      hydratedFightUrls: new Set([
        "https://www.warcraftlogs.com/reports/already-hydrated#fight=26"
      ])
    });

    expect(requested).toEqual(["still-missing"]);
  });

  it("hydrates each boss's first kill before repeat kills, newest tier first", async () => {
    // Break caught: oldest-first spent a small budget on the oldest reports in
    // a character's history, so the current tier was never hydrated. First
    // kills are what the dossier headlines, and the newest ones matter most.
    const inWindow = (
      fightIds: number[],
      code: string,
      encounterId: number,
      killedAt: string,
      hasMore: boolean
    ) => {
      const report = performanceReport(
        fightIds,
        hasMore,
        code,
        encounterId,
        Date.parse(killedAt)
      ) as {
        data: {
          characterData: {
            character: {
              recentReports: { data: { zone: { name: string } }[] };
            };
          };
        };
      };
      report.data.characterData.character.recentReports.data[0]!.zone.name =
        "Nerub-ar Palace";
      return report;
    };
    const requested: string[] = [];
    const reports = [
      // A repeat kill of boss 3306, and the newest report of the three.
      inWindow([28], "repeat-kill", 3306, "2025-02-05T00:00:00.000Z", true),
      // Boss 3306's first kill.
      inWindow(
        [26],
        "early-first-kill",
        3306,
        "2024-10-05T00:00:00.000Z",
        true
      ),
      // Boss 3307's first kill, later than boss 3306's.
      inWindow([27], "late-first-kill", 3307, "2025-01-05T00:00:00.000Z", false)
    ];
    let page = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        requested.push(body.variables?.code ?? "?");
        return emptyRankingsResponse(body.variables?.code ?? "report");
      }
      const report = reports[page++];
      if (!report) throw new Error("unexpected_report_page");
      return jsonResponse(report);
    });

    await client.getFirstKillReports(key, {
      requestCap: 4,
      parseRequestCap: 8
    });

    expect(requested).toEqual([
      "late-first-kill",
      "early-first-kill",
      "repeat-kill"
    ]);
  });

  it("hydrates every boss in a report with a single ranking request", async () => {
    // Break caught: scoping a ranking request to one encounter spent a request
    // per boss, exhausting the parse cap and leaving later kills unhydrated.
    const twoBossReport = {
      data: {
        characterData: {
          character: {
            server: { normalizedName: "Silvermoon" },
            recentReports: {
              data: [
                {
                  code: "raid-night",
                  startTime: 1_728_086_400_000,
                  zone: {
                    id: 1047,
                    name: "Nerub-ar Palace",
                    encounters: [
                      { id: 3306, journalID: 3306 },
                      { id: 3307, journalID: 3307 }
                    ]
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
                      name: "Boss One",
                      startTime: 1,
                      endTime: 2,
                      kill: true,
                      difficulty: 5,
                      friendlyPlayers: [1001]
                    },
                    {
                      id: 27,
                      encounterID: 3307,
                      name: "Boss Two",
                      startTime: 3,
                      endTime: 4,
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
    };
    const rankingRow = (
      fightId: number,
      encounterId: number,
      rankPercent: number
    ) => ({
      fightID: fightId,
      encounter: { id: encounterId },
      difficulty: 5,
      roles: {
        tanks: { characters: [] },
        healers: { characters: [] },
        dps: {
          characters: [
            {
              id: 2101,
              name: "Sentinel",
              server: { name: "silvermoon", region: "eu" },
              rankPercent
            }
          ]
        }
      }
    });
    let rankingRequests = 0;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { fightIDs?: number[] };
      };
      if (body.query.includes("ReportFightParses")) {
        rankingRequests += 1;
        expect(body.variables?.fightIDs).toEqual([26, 27]);
        return jsonResponse({
          data: {
            reportData: {
              report: {
                code: "raid-night",
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
                damage: {
                  data: [rankingRow(26, 3306, 61), rankingRow(27, 3307, 94)]
                },
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
      return jsonResponse(twoBossReport);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });
    expect(rankingRequests).toBe(1);
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(
      new Map(
        result.kills.map((kill) => [kill.fightId, kill.performance.damage])
      )
    ).toEqual(
      new Map([
        [26, { state: "available", percentile: 61 }],
        [27, { state: "available", percentile: 94 }]
      ])
    );
  });

  it("gives repeat kills of one boss their own parse rather than the best", async () => {
    // Break caught: filling every kill of a boss from a character-wide best
    // made a first kill's parse identical to the strongest later kill.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        const row = (fightId: number, rankPercent: number) => ({
          fightID: fightId,
          encounter: { id: 3306 },
          difficulty: 5,
          roles: {
            tanks: { characters: [] },
            healers: { characters: [] },
            dps: {
              characters: [
                {
                  id: 2101,
                  name: "Sentinel",
                  server: { name: "silvermoon", region: "eu" },
                  rankPercent
                }
              ]
            }
          }
        });
        return jsonResponse({
          data: {
            reportData: {
              report: {
                code: "performance-report",
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
                damage: { data: [row(26, 12), row(27, 98)] },
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
      return jsonResponse(performanceReport([26, 27]));
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8
    });
    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(
      new Map(
        result.kills.map((kill) => [kill.fightId, kill.performance.damage])
      )
    ).toEqual(
      new Map([
        [26, { state: "available", percentile: 12 }],
        [27, { state: "available", percentile: 98 }]
      ])
    );
  });

  it("ignores a ranking row that contradicts its fight's encounter", async () => {
    // Break caught: the request no longer filters by encounter or difficulty,
    // so a row describing another boss must not be attributed to this kill.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("ReportFightParses")) {
        return jsonResponse(
          performanceRankings(
            { damage: 91, healing: 91, bossDamage: 91 },
            { encounterId: 9999 }
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
      return jsonResponse(performanceReport([26]));
    });

    await expect(
      client.getFirstKillReports(key, { requestCap: 1, parseRequestCap: 8 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [{ performance: { damage: { state: "unavailable" } } }]
    });
  });

  it("leaves a parse unavailable when its report returns no ranking rows", async () => {
    // Break caught: substituting a character-wide best for a missing report
    // ranking showed a percentile that never belonged to this fight.
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables?.code ?? "report");
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
            spec: null,
            damage: { state: "unavailable" },
            healing: { state: "unavailable" },
            bossDamage: { state: "unavailable" }
          }
        }
      ]
    });
  });

  it("carries the specialisation reported alongside a fight's parse", async () => {
    // Break caught: discarding the spec on a ranking row left the kill without
    // a specialisation icon.
    const { client } = performanceClient(
      performanceRankings(
        { damage: 40, healing: 91, bossDamage: 42 },
        { class: "Priest", spec: "Discipline" }
      )
    );

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
    const { client } = performanceClient(
      performanceRankings(
        { damage: 91, healing: null, bossDamage: null },
        { class: "DeathKnight", spec: "Frost" }
      )
    );

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
    const { client } = performanceClient(
      performanceRankings(
        { damage: 91, healing: null, bossDamage: null },
        { class: "Warlock", spec: "Affliction" }
      )
    );

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
    const { client } = performanceClient(
      performanceRankings(
        { damage: 91, healing: null, bossDamage: null },
        { spec: "Frost" }
      )
    );

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
    const { client } = performanceClient(
      performanceRankings(
        { damage: 91, healing: null, bossDamage: null },
        { spec: "Frost", class: 4 }
      )
    );

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
    const { client } = performanceClient(
      performanceRankings(
        { damage: 91, healing: null, bossDamage: null },
        { spec: "Frost" }
      )
    );

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

  it("reads a character's history and tier bests by its stable ID when given one", async () => {
    // Break caught: a renamed character's former name could since belong to
    // somebody else, so a name lookup would read the wrong history.
    const pages = (fixture("character-report-valid") as { pages: unknown[] })
      .pages;
    let page = 0;
    const lookups: { query: string; variables: Record<string, unknown> }[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown> & { code?: string };
      };
      if (body.query.includes("ReportFightParses")) {
        return emptyRankingsResponse(body.variables.code!);
      }
      if (
        body.query.includes("RecentReports") ||
        body.query.includes("CharacterZoneParses")
      ) {
        lookups.push(body);
      }
      if (body.query.includes("CharacterZoneParses")) {
        return emptyZoneRankingsResponse();
      }
      return jsonResponse(pages[page++]!);
    });

    await expect(
      client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 10,
        characterId: 40989140
      })
    ).resolves.toMatchObject({ kind: "evidence" });

    expect(lookups.map(({ query }) => query.match(/query (\w+)/)?.[1])).toEqual(
      expect.arrayContaining(["RecentReports", "CharacterZoneParses"])
    );
    for (const { query, variables } of lookups) {
      expect(query).toContain("character(id: $characterId)");
      expect(query).not.toContain("serverSlug");
      expect(variables).toMatchObject({ characterId: 40989140 });
      expect(variables).not.toHaveProperty("name");
    }
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
          killedAt: "2024-10-05T01:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/earlyReport",
          fightUrl: "https://www.warcraftlogs.com/reports/earlyReport#fight=7",
          guild: null
        },
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "1234",
          bossName: "Queen Ansurek",
          journalBossId: null,
          bossOrder: 1234,
          killedAt: "2024-10-07T03:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/lateReport",
          fightUrl: "https://www.warcraftlogs.com/reports/lateReport#fight=1",
          guild: null
        },
        {
          raidId: "42",
          raidName: "Nerub-ar Palace",
          bossId: "4321",
          bossName: "The Silken Court",
          journalBossId: null,
          bossOrder: 4321,
          killedAt: "2024-10-06T02:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/secondBoss",
          fightUrl: "https://www.warcraftlogs.com/reports/secondBoss#fight=2",
          guild: null
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
          attemptedAt: "2024-10-07T03:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/lateReport",
          fightUrl: "https://www.warcraftlogs.com/reports/lateReport#fight=9"
        }
      ]
    });
    // Two report pages, three report-ranking groups, one zone-rankings
    // request for Nerub-ar Palace and one shared canonical identity lookup.
    expect(fetch).toHaveBeenCalledTimes(7);
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
                        startTime: 1_728_086_400_000,
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
                            id: 6,
                            encounterID: 112442,
                            name: "",
                            startTime: 1_800_000,
                            endTime: 1_800_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: {
                              id: 2441,
                              name: "Tazavesh, the Veiled Market"
                            }
                          },
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

  it("recovers participant-attributed kills and wipes from guild attendance", async () => {
    const attendancePages: number[] = [];
    const multiwordRealmKey: CharacterKey = {
      region: "eu",
      realm: "aerie-peak",
      name: "sentinel"
    };
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string; page?: number };
      };
      if (body.query.includes("RecentReports")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                server: { normalizedName: "AeriePeak" },
                guilds: [
                  {
                    name: "SeriouslyCasual",
                    server: { slug: "aerie-peak", region: { slug: "EU" } }
                  }
                ],
                recentReports: { data: [], has_more_pages: false }
              }
            }
          }
        });
      }
      if (body.query.includes("GuildAttendance")) {
        attendancePages.push(body.variables.page!);
        return jsonResponse({
          data: {
            guildData: {
              guild: {
                attendance: {
                  data: [{ code: "omittedReport" }],
                  has_more_pages: body.variables.page === 1
                }
              }
            }
          }
        });
      }
      if (body.query.includes("ReportByCode")) {
        return jsonResponse({
          data: {
            reportData: {
              report: {
                code: "omittedReport",
                startTime: 1_579_633_885_132,
                owner: { name: "Abradix" },
                guild: {
                  name: "SeriouslyCasual",
                  server: { slug: "aerie-peak", region: { slug: "EU" } }
                },
                zone: {
                  id: 23,
                  name: "The Eternal Palace",
                  encounters: [
                    { id: 2299, journalID: 0 },
                    { id: 2293, journalID: 0 }
                  ]
                },
                masterData: {
                  actors: [
                    {
                      id: 12,
                      name: "Sentinel",
                      server: "AeriePeak",
                      type: "Player"
                    }
                  ]
                },
                fights: [
                  {
                    id: 8,
                    encounterID: 2299,
                    name: "Queen Azshara",
                    startTime: 1_000,
                    endTime: 2_000,
                    kill: true,
                    difficulty: 5,
                    friendlyPlayers: [12]
                  },
                  {
                    id: 7,
                    encounterID: 2293,
                    name: "Za'qul",
                    startTime: 3_000,
                    endTime: 4_000,
                    kill: false,
                    difficulty: 5,
                    friendlyPlayers: [12]
                  },
                  {
                    id: 6,
                    encounterID: 2298,
                    name: "The Queen's Court",
                    startTime: 5_000,
                    endTime: 6_000,
                    kill: true,
                    difficulty: 5,
                    friendlyPlayers: [99]
                  }
                ]
              }
            }
          }
        });
      }
      return emptyZoneRankingsResponse();
    });

    await expect(
      client.getFirstKillReports(multiwordRealmKey, {
        requestCap: 10,
        parseRequestCap: 1,
        verifiedKills: verifiedIn("SeriouslyCasual", "aerie-peak")
      })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          bossName: "Queen Azshara",
          fightUrl: "https://www.warcraftlogs.com/reports/omittedReport#fight=8"
        }
      ],
      wipes: [
        {
          bossName: "Za'qul",
          fightUrl: "https://www.warcraftlogs.com/reports/omittedReport#fight=7"
        }
      ],
      // What recovery yielded, so its cost can be weighed against it later.
      attendanceRecoveredKills: 1
    });
    expect(attendancePages).toEqual([1, 2]);
  });

  it("hydrates only attendance reports the history scan has not read and that may list the character", async () => {
    // Break caught: attendance lists every report a guild ever logged. Ryii's
    // two guilds held 1,740 against 141 with Ryii in them and 20 missing from
    // Ryii's own history, so hydrating each one cost 1,811 requests a run
    // against a 300 cap. Every run ended `request_cap`, none kept a cursor
    // for the walk, and the character was re-collected forever.
    const hydrated: string[] = [];
    const report = (code: string) => ({
      code,
      startTime: 1_579_633_885_132,
      zone: { id: 23, name: "The Eternal Palace" },
      masterData: { actors: [] },
      fights: []
    });
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string; page?: number };
      };
      if (body.query.includes("RecentReports")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                server: { normalizedName: "Silvermoon" },
                guilds: [
                  {
                    name: "Guild",
                    server: { slug: "silvermoon", region: { slug: "EU" } }
                  }
                ],
                recentReports: {
                  data: [report("scannedReport")],
                  has_more_pages: false
                }
              }
            }
          }
        });
      }
      if (body.query.includes("GuildAttendance")) {
        return jsonResponse({
          data: {
            guildData: {
              guild: {
                attendance: {
                  data: [
                    { code: "scannedReport", players: [{ name: "Sentinel" }] },
                    { code: "strangersReport", players: [{ name: "Other" }] },
                    { code: "omittedReport", players: [{ name: "SENTINEL" }] },
                    // Not listing players is not listing the character's
                    // absence, so these must still be read.
                    { code: "unlistedReport" },
                    { code: "emptyListReport", players: [] },
                    { code: "malformedListReport", players: [{ name: null }] },
                    {
                      code: "suffixedReport",
                      players: [
                        { name: "Other" },
                        { name: "Sentinel-Silvermoon" }
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
      if (body.query.includes("ReportByCode")) {
        hydrated.push(body.variables.code!);
        return jsonResponse({ data: { reportData: { report: null } } });
      }
      return emptyZoneRankingsResponse();
    });

    await client.getFirstKillReports(key, {
      requestCap: 20,
      parseRequestCap: 1,
      verifiedKills: verifiedIn("Guild")
    });

    expect(hydrated).toEqual([
      "omittedReport",
      "unlistedReport",
      "emptyListReport",
      "malformedListReport",
      "suffixedReport"
    ]);
  });

  describe("searching attendance only for verified kills", () => {
    const night = Date.parse("2020-01-21T19:34:00.000Z");
    const hours = (count: number) => count * 60 * 60 * 1_000;
    const history = (reports: unknown[] = []) =>
      jsonResponse({
        data: {
          characterData: {
            character: {
              server: { normalizedName: "Silvermoon" },
              // The guild the old walk read attendance for on every run.
              guilds: [
                {
                  name: "Guild",
                  server: { slug: "silvermoon", region: { slug: "EU" } }
                }
              ],
              recentReports: { data: reports, has_more_pages: false }
            }
          }
        }
      });
    const attendancePage = (
      data: ReadonlyArray<{ code: string; startTime: number }>,
      hasMorePages: boolean
    ) =>
      jsonResponse({
        data: {
          guildData: {
            guild: {
              attendance: {
                data: data.map((entry) => ({
                  ...entry,
                  players: [{ name: "Sentinel" }]
                })),
                has_more_pages: hasMorePages
              }
            }
          }
        }
      });
    const verified = [
      {
        at: new Date(night).toISOString(),
        guild: { name: "Guild", realm: "silvermoon", region: "eu" as const }
      }
    ];

    it("reads no attendance without a verified kill to search for", async () => {
      // Break caught: walking every guild the history names is what pinned
      // Ryii at the cap. With nothing verified to find, there is no search.
      const queries: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query.match(/query (\w+)/)?.[1] ?? "");
        if (body.query.includes("RecentReports")) return history();
        return emptyZoneRankingsResponse();
      });

      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1
      });

      expect(queries).not.toContain("GuildAttendance");
      expect(queries).not.toContain("ReportByCode");
    });

    it("does not search for a verified kill a decoded report already spans", async () => {
      // Break caught: a kill the history scan read -- or read and found was
      // not the character's -- sent the run into attendance to find it again.
      const queries: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query.match(/query (\w+)/)?.[1] ?? "");
        if (body.query.includes("RecentReports")) {
          return history([
            {
              code: "raidNight",
              startTime: night - hours(1),
              zone: { id: 23, name: "The Eternal Palace" },
              masterData: { actors: [] },
              fights: [
                {
                  id: 1,
                  encounterID: 0,
                  name: "Trash",
                  startTime: 0,
                  endTime: hours(2),
                  kill: null,
                  difficulty: null,
                  friendlyPlayers: []
                }
              ]
            }
          ]);
        }
        return emptyZoneRankingsResponse();
      });

      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1,
        verifiedKills: verified
      });

      expect(queries).not.toContain("GuildAttendance");
    });

    it("keeps a verified kill searchable when its report omitted a fight", async () => {
      const queries: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query.match(/query (\w+)/)?.[1] ?? "");
        if (body.query.includes("RecentReports")) {
          return history([
            {
              code: "raidNight",
              startTime: night - hours(1),
              zone: { id: 23, name: "The Eternal Palace" },
              masterData: {
                actors: [
                  {
                    type: "Player",
                    id: 7,
                    name: "Sentinel",
                    server: "Silvermoon"
                  }
                ]
              },
              fights: [
                {
                  id: 1,
                  encounterID: 2299,
                  name: "Queen Azshara",
                  startTime: hours(3),
                  endTime: hours(2),
                  kill: true,
                  difficulty: 5,
                  friendlyPlayers: [7]
                }
              ]
            }
          ]);
        }
        return emptyZoneRankingsResponse();
      });

      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1,
        verifiedKills: verified
      });

      expect(queries).toContain("GuildAttendance");
    });

    // A report holding one Mythic Queen Azshara kill by the character.
    const hydratedKill = (code: string) =>
      jsonResponse({
        data: {
          reportData: {
            report: {
              code,
              startTime: night - hours(1),
              owner: { name: "Uploader" },
              guild: null,
              zone: {
                id: 23,
                name: "The Eternal Palace",
                encounters: [{ id: 2299, journalID: 0 }]
              },
              masterData: {
                actors: [
                  {
                    id: 12,
                    name: "Sentinel",
                    server: "Silvermoon",
                    type: "Player"
                  }
                ]
              },
              fights: [
                {
                  id: 8,
                  encounterID: 2299,
                  name: "Queen Azshara",
                  startTime: hours(0.5),
                  endTime: hours(1),
                  kill: true,
                  difficulty: 5,
                  friendlyPlayers: [12]
                }
              ]
            }
          }
        }
      });

    it("recovers nothing, and limits nothing, from a guild Warcraft Logs does not know", async () => {
      // Break caught: Raider.IO names the guild as it was on the night. One
      // renamed, moved or never logged is unknown to Warcraft Logs, and its
      // refusal marked the scan limited -- so the run was partial, and was
      // retried, and was partial again, for as long as the kill stayed unheld.
      // Factories, not held responses: cloning a held response per call
      // breaks once a collected clone cancels the original's body.
      for (const refusal of [
        () =>
          jsonResponse({
            errors: [{ message: "No guild exists for this name/server/region" }]
          }),
        () => jsonResponse({ data: { guildData: { guild: null } } }),
        () => new Response("upstream-body-marker", { status: 503 })
      ]) {
        const { client } = clientFor((url, init) => {
          if (url.pathname === "/oauth/token") return token();
          const body = JSON.parse(String(init?.body)) as { query: string };
          if (body.query.includes("RecentReports")) return history();
          if (body.query.includes("GuildAttendance")) return refusal();
          return emptyZoneRankingsResponse();
        });

        const result = await client.getFirstKillReports(key, {
          requestCap: 10,
          parseRequestCap: 1,
          verifiedKills: verified
        });

        expect(result).toMatchObject({ kind: "evidence" });
        expect(result).not.toHaveProperty("limitation");
      }
    });

    it("re-reads a stored recovery directly instead of searching for it", async () => {
      // Break caught: a kill recovered in an earlier run is held, so it was
      // not searched for -- and a complete publish, which keeps only what the
      // run finds again outside terminal raids, dropped it. The next run found
      // it unheld and recovered it; the one after dropped it again.
      const queries: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { code?: string };
        };
        queries.push(body.query.match(/query (\w+)/)?.[1] ?? "");
        if (body.query.includes("RecentReports")) return history();
        if (body.query.includes("ReportByCode")) {
          return hydratedKill(body.variables.code!);
        }
        return emptyZoneRankingsResponse();
      });

      const result = await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1,
        storedKillReportCodes: ["storedRecovery"]
      });

      expect(queries).not.toContain("GuildAttendance");
      expect(queries.filter((query) => query === "ReportByCode")).toHaveLength(
        1
      );
      expect(result).toMatchObject({
        kind: "evidence",
        kills: [
          {
            bossName: "Queen Azshara",
            fightUrl:
              "https://www.warcraftlogs.com/reports/storedRecovery#fight=8"
          }
        ]
      });
      expect(result).not.toHaveProperty("limitation");
      // Re-reading what is already stored is not a search.
      expect(result).not.toHaveProperty("attendanceRecoveredKills");
    });

    it("limits the scan when a stored recovery cannot be re-read", async () => {
      // A complete publish would drop the stored kill this run failed to read
      // again. A partial one carries every stored kill forward.
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("RecentReports")) return history();
        if (body.query.includes("ReportByCode")) {
          return new Response("upstream-body-marker", { status: 503 });
        }
        return emptyZoneRankingsResponse();
      });

      const result = await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1,
        storedKillReportCodes: ["storedRecovery"]
      });

      // With nothing else found, the whole result is the limitation.
      const code =
        result.kind === "limitation" ? result.code : result.limitation?.code;
      expect(code).toBe("unavailable");
    });

    it("lets a stored kill go when its report is gone, as a complete publish should", async () => {
      // A deleted or private report is a kill the run stopped finding. That
      // is not a failure to read, so it must not hold the run partial.
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("RecentReports")) return history();
        if (body.query.includes("ReportByCode")) {
          return jsonResponse({
            errors: [{ message: "This report does not exist." }]
          });
        }
        return emptyZoneRankingsResponse();
      });

      const result = await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1,
        storedKillReportCodes: ["deletedReport"]
      });

      const code =
        result.kind === "limitation" ? result.code : result.limitation?.code;
      expect(code).toBeUndefined();
    });

    it("re-reads nothing the history scan already read, and nothing after a resume", async () => {
      // A report the scan decoded has already been found again. And a resumed
      // scan publishes partial, which carries every stored kill forward, so
      // re-reading there would spend requests on nothing.
      for (const resumed of [false, true]) {
        const hydrated: string[] = [];
        const page = (fixture("character-report-valid") as { pages: unknown[] })
          .pages[0];
        const { client } = clientFor((url, init) => {
          if (url.pathname === "/oauth/token") return token();
          const body = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { page?: number; code?: string };
          };
          if (body.query.includes("RecentReports")) {
            if (body.variables.page === 1 && !resumed) {
              const last = structuredClone(page) as {
                data: {
                  characterData: {
                    character: { recentReports: { has_more_pages: boolean } };
                  };
                };
              };
              last.data.characterData.character.recentReports.has_more_pages = false;
              return jsonResponse(last);
            }
            return body.variables.page === 18 ? jsonResponse(page) : history();
          }
          if (body.query.includes("ReportByCode")) {
            hydrated.push(body.variables.code!);
            return jsonResponse({ data: { reportData: { report: null } } });
          }
          return emptyZoneRankingsResponse();
        });

        await client.getFirstKillReports(key, {
          requestCap: 10,
          parseRequestCap: 1,
          storedKillReportCodes: resumed
            ? ["storedRecovery"]
            : ["lateReport", "storedRecovery"],
          ...(resumed
            ? {
                historyScanStartPage: 19,
                historyScanResumeBoundaryReportCode: "lateReport"
              }
            : {})
        });

        expect(hydrated).toEqual(resumed ? [] : ["storedRecovery"]);
      }
    });

    describe("reporting a night searched to the end and found empty (#434)", () => {
      // What a verified kill's search concluded, from one attendance setup.
      const searchWith = async (
        attendance: (page: number) => Response,
        options: Readonly<{
          requestCap?: number;
          hydration?: (code: string) => Response;
        }> = {}
      ) => {
        const { client } = clientFor((url, init) => {
          if (url.pathname === "/oauth/token") return token();
          const body = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { page?: number; code?: string };
          };
          if (body.query.includes("RecentReports")) return history();
          if (body.query.includes("GuildAttendance")) {
            return attendance(body.variables.page!);
          }
          if (body.query.includes("ReportByCode")) {
            return (
              options.hydration?.(body.variables.code!) ??
              jsonResponse({ data: { reportData: { report: null } } })
            );
          }
          return emptyZoneRankingsResponse();
        });
        return client.getFirstKillReports(key, {
          requestCap: options.requestCap ?? 20,
          parseRequestCap: 1,
          verifiedKills: verified
        });
      };
      // Factories: a response body can be read once, and these serve many runs.
      const pastTheNight = () =>
        attendancePage(
          [{ code: "monthBefore", startTime: night - hours(24 * 30) }],
          true
        );
      const onTheNight = () =>
        attendancePage(
          [{ code: "killNight", startTime: night - hours(1) }],
          true
        );

      it("reports a night the walk passed without finding the kill", async () => {
        // Break caught: a kill whose first defeat was never logged has
        // nothing to hold it, so every full run walked the guild's
        // attendance back to its night again. Yawnersw spent 39 pages, about
        // 1,090 of its 1,168 points, finding nothing (2026-09-23).
        const result = await searchWith((page) =>
          page === 1 ? onTheNight() : pastTheNight()
        );

        expect(result).toMatchObject({ attendanceSearchedEmpty: verified });
      });

      it("reports a guild Warcraft Logs does not have", async () => {
        // Recorded 2026-09-23: an unknown guild is `guild: null`, no errors.
        const result = await searchWith(() =>
          jsonResponse({ data: { guildData: { guild: null } } })
        );

        expect(result).toMatchObject({ attendanceSearchedEmpty: verified });
      });

      it("reports a guild whose attendance is empty", async () => {
        const result = await searchWith(() => attendancePage([], false));

        expect(result).toMatchObject({ attendanceSearchedEmpty: verified });
      });

      it("does not report a kill the search recovered", async () => {
        const result = await searchWith(
          (page) => (page === 1 ? onTheNight() : pastTheNight()),
          { hydration: (code) => hydratedKill(code) }
        );

        expect(result).toMatchObject({ attendanceRecoveredKills: 1 });
        expect(result).not.toHaveProperty("attendanceSearchedEmpty");
      });

      it("gallops to an old night instead of reading every newer page", async () => {
        // Break caught: recovery walked the attendance one page at a time
        // from page one, about 28 points a page, so a kill years back cost
        // every page in between -- or, past the cap, was never reached.
        const pagesRead: number[] = [];
        const result = await searchWith(
          (page) => {
            pagesRead.push(page);
            if (page < 41) {
              return attendancePage(
                [
                  {
                    code: `newer${page}`,
                    startTime: night + hours(24 * (100 - page))
                  }
                ],
                true
              );
            }
            return page === 41 ? onTheNight() : pastTheNight();
          },
          { hydration: (code) => hydratedKill(code) }
        );

        expect(result).toMatchObject({ attendanceRecoveredKills: 1 });
        expect(new Set(pagesRead).size).toBe(pagesRead.length);
        expect(pagesRead.length).toBeLessThanOrEqual(13);
      });

      it("still reports a night passed by a galloping walk", async () => {
        const result = await searchWith((page) =>
          page < 30
            ? attendancePage(
                [
                  {
                    code: `newer${page}`,
                    startTime: night + hours(24 * (100 - page))
                  }
                ],
                true
              )
            : pastTheNight()
        );

        expect(result).toMatchObject({ attendanceSearchedEmpty: verified });
      });

      it("proves nothing from a walk that did not finish", async () => {
        // A transient refusal, a report that could not be read, or a budget
        // spent before the night was reached leaves the kill unproven: it is
        // searched for again rather than forgotten.
        for (const run of [
          () =>
            searchWith(
              () => new Response("upstream-body-marker", { status: 503 })
            ),
          () =>
            searchWith((page) => (page === 1 ? onTheNight() : pastTheNight()), {
              hydration: () =>
                new Response("upstream-body-marker", { status: 503 })
            }),
          () =>
            searchWith(
              () =>
                attendancePage(
                  [{ code: "weekLater", startTime: night + hours(24 * 7) }],
                  true
                ),
              { requestCap: 3 }
            )
        ]) {
          const result = await run();
          expect(result).not.toHaveProperty("attendanceSearchedEmpty");
        }
      });
    });

    it("reports no search when the budget was spent before recovery began", async () => {
      // Break caught: a run whose history scan used the whole cap still read
      // `attendanceRecoveredKills: 0`, a measured zero for a search that
      // never ran. The history holds a kill a month later, so the result is
      // evidence and can carry the count at all.
      const monthLater = (
        (await hydratedKill("laterNight").json()) as {
          data: { reportData: { report: Record<string, unknown> } };
        }
      ).data.reportData.report;
      monthLater.startTime = night + hours(24 * 30);
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("RecentReports")) {
          return history([monthLater]);
        }
        return emptyZoneRankingsResponse();
      });

      const result = await client.getFirstKillReports(key, {
        requestCap: 1,
        parseRequestCap: 1,
        verifiedKills: verified
      });

      expect(result).not.toHaveProperty("attendanceRecoveredKills");
    });

    it("treats a report as covering a kill Raider.IO dates an hour before it", async () => {
      // Break caught: Raider.IO put Ryun's Queen Azshara at 19:34Z; the log
      // that holds it records the kill at 20:34Z. A whole-hour clock error on
      // Raider.IO's side must not send the run into attendance for a night
      // the history scan already read.
      const queries: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query.match(/query (\w+)/)?.[1] ?? "");
        if (body.query.includes("RecentReports")) {
          return history([
            {
              code: "raidNight",
              startTime: night + hours(0.5),
              zone: { id: 23, name: "The Eternal Palace" },
              masterData: { actors: [] },
              fights: [
                {
                  id: 1,
                  encounterID: 0,
                  name: "Trash",
                  startTime: 0,
                  endTime: hours(1),
                  kill: null,
                  difficulty: null,
                  friendlyPlayers: []
                }
              ]
            }
          ]);
        }
        return emptyZoneRankingsResponse();
      });

      await client.getFirstKillReports(key, {
        requestCap: 10,
        parseRequestCap: 1,
        verifiedKills: verified
      });

      expect(queries).not.toContain("GuildAttendance");
    });

    it("searches only the kill's guild, on its night, and stops paging once past it", async () => {
      // Break caught: the walk read every page of every guild and hydrated
      // every report on them. Only the named guild's reports from the night
      // of the kill can hold it, and pages are newest first.
      const walked: string[] = [];
      const hydrated: string[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { name?: string; page?: number; code?: string };
        };
        if (body.query.includes("RecentReports")) return history();
        if (body.query.includes("GuildAttendance")) {
          walked.push(`${body.variables.name}:${body.variables.page}`);
          return body.variables.page === 1
            ? attendancePage(
                [
                  { code: "weekLater", startTime: night + hours(24 * 7) },
                  // Opened after Raider.IO's time: its clock can run an
                  // hour early, as it does for Ryun's Queen Azshara.
                  { code: "openedLater", startTime: night + hours(1) },
                  { code: "killNight", startTime: night - hours(1) },
                  { code: "nightBefore", startTime: night - hours(20) }
                ],
                true
              )
            : body.variables.page === 2
              ? attendancePage(
                  [{ code: "monthBefore", startTime: night - hours(24 * 30) }],
                  true
                )
              : attendancePage([], false);
        }
        if (body.query.includes("ReportByCode")) {
          hydrated.push(body.variables.code!);
          return jsonResponse({ data: { reportData: { report: null } } });
        }
        return emptyZoneRankingsResponse();
      });

      const requests: string[] = [];
      const result = await client.getFirstKillReports(key, {
        requestCap: 20,
        parseRequestCap: 1,
        verifiedKills: verified,
        onRequest: (event) => requests.push(event.query)
      });

      expect(hydrated).toEqual(["openedLater", "killNight"]);
      // Page two is wholly older than the night by more than the overlap
      // pages can have at a boundary, so page three is never asked for.
      expect(walked).toEqual(["Guild:1", "Guild:2"]);
      // Recovery is counted apart from the history scan, so what it costs
      // can be read without subtracting it back out of history pages.
      expect(requests.filter((query) => query === "history_scan")).toHaveLength(
        1
      );
      expect(
        requests.filter((query) => query === "guild_attendance")
      ).toHaveLength(2);
      expect(
        requests.filter((query) => query === "report_hydration")
      ).toHaveLength(2);
      // Searched and found nothing: a measured zero, not an absent value.
      expect(result).toMatchObject({ attendanceRecoveredKills: 0 });
    });
  });

  it("matches an attendance name written in another Unicode form", async () => {
    // Break caught: a decomposed accent is a different string, so an exact
    // comparison would rule out the very report attendance exists to recover.
    const hydrated: string[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string };
      };
      if (body.query.includes("RecentReports")) {
        return jsonResponse({
          data: {
            characterData: {
              character: {
                server: { normalizedName: "Silvermoon" },
                guilds: [
                  {
                    name: "Guild",
                    server: { slug: "silvermoon", region: { slug: "EU" } }
                  }
                ],
                recentReports: { data: [], has_more_pages: false }
              }
            }
          }
        });
      }
      if (body.query.includes("GuildAttendance")) {
        return jsonResponse({
          data: {
            guildData: {
              guild: {
                attendance: {
                  data: [
                    {
                      code: "decomposedReport",
                      players: [{ name: "Zoë" }]
                    }
                  ],
                  has_more_pages: false
                }
              }
            }
          }
        });
      }
      if (body.query.includes("ReportByCode")) {
        hydrated.push(body.variables.code!);
        return jsonResponse({ data: { reportData: { report: null } } });
      }
      return emptyZoneRankingsResponse();
    });

    await client.getFirstKillReports(
      { region: "eu", realm: "silvermoon", name: "zoë" },
      { requestCap: 5, parseRequestCap: 1, verifiedKills: verifiedIn("Guild") }
    );

    expect(hydrated).toEqual(["decomposedReport"]);
  });

  it("still hydrates the reports a drifted history page never decoded", async () => {
    // Break caught: a page that drifts after a kill still returns evidence.
    // Marking every code on it as scanned hid the undecoded reports from
    // attendance, the one path left that could recover them.
    const page = structuredClone(
      (fixture("character-report-valid") as { pages: unknown[] }).pages[0]
    ) as {
      data: {
        characterData: {
          character: {
            guilds?: unknown;
            recentReports: { data: unknown[] };
          };
        };
      };
    };
    const character = page.data.characterData.character;
    character.guilds = [
      { name: "Guild", server: { slug: "silvermoon", region: { slug: "EU" } } }
    ];
    character.recentReports.data.push({ code: "driftedReport" });
    const hydrated: string[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string };
      };
      if (body.query.includes("RecentReports")) return jsonResponse(page);
      if (body.query.includes("GuildAttendance")) {
        return jsonResponse({
          data: {
            guildData: {
              guild: {
                attendance: {
                  data: [
                    { code: "lateReport", players: [{ name: "Sentinel" }] },
                    { code: "driftedReport", players: [{ name: "Sentinel" }] }
                  ],
                  has_more_pages: false
                }
              }
            }
          }
        });
      }
      if (body.query.includes("ReportByCode")) {
        hydrated.push(body.variables.code!);
        return jsonResponse({ data: { reportData: { report: null } } });
      }
      return emptyZoneRankingsResponse();
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 1,
      verifiedKills: verifiedIn("Guild")
    });

    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "schema_drift" }
    });
    // The report the page did decode may be read again; that costs a
    // request, where skipping the undecoded one would cost its evidence.
    expect(hydrated).toContain("driftedReport");
  });

  it("keeps the proved boundary page's evidence and does not hydrate it again", async () => {
    // Break caught: a resume reads only the probe page and what lies below
    // it, so every report the probe proved was hydrated again through
    // attendance -- a resumed run cost more than a fresh one.
    const page = structuredClone(
      (fixture("character-report-valid") as { pages: unknown[] }).pages[0]
    );
    const hydrated: string[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { code?: string; page?: number };
      };
      if (body.query.includes("RecentReports")) {
        return jsonResponse(
          body.variables.page === 18
            ? page
            : {
                data: {
                  characterData: {
                    character: {
                      server: { normalizedName: "Silvermoon" },
                      guilds: [
                        {
                          name: "Guild",
                          server: { slug: "silvermoon", region: { slug: "EU" } }
                        }
                      ],
                      recentReports: { data: [], has_more_pages: false }
                    }
                  }
                }
              }
        );
      }
      if (body.query.includes("GuildAttendance")) {
        return jsonResponse({
          data: {
            guildData: {
              guild: {
                attendance: {
                  data: [
                    { code: "lateReport", players: [{ name: "Sentinel" }] }
                  ],
                  has_more_pages: false
                }
              }
            }
          }
        });
      }
      if (body.query.includes("ReportByCode")) {
        hydrated.push(body.variables.code!);
        return jsonResponse({ data: { reportData: { report: null } } });
      }
      return emptyZoneRankingsResponse();
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 1,
      verifiedKills: verifiedIn("Guild"),
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "lateReport"
    });

    expect(hydrated).toEqual([]);
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        {
          reportUrl: expect.stringContaining("lateReport")
        }
      ]
    });
  });

  it("uses each fight's game zone when the report zone names another instance", async () => {
    // Break caught: Warcraft Logs pins one zone to a whole report, and a raid
    // night that also ran Mythic+ is filed under the dungeon season. Stamping
    // that zone on every fight hands the dossier a non-raid zone name, and the
    // raid kill inside the report is discarded as if it never happened.
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
                        startTime: 1_728_086_400_000,
                        zone: {
                          id: 55,
                          name: "Mythic+ Season 2",
                          encounters: [{ id: 12993, journalID: 0 }]
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
                            id: 23,
                            encounterID: 3379,
                            name: "Nymrissa Wavecaller",
                            startTime: 3_600_000,
                            endTime: 3_600_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: { id: 2987, name: "The Tidebound Grotto" }
                          },
                          {
                            id: 25,
                            encounterID: 3470,
                            name: "Nek'zali the Soulcoiler",
                            startTime: 7_200_000,
                            endTime: 7_200_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: { id: 3004, name: "The Venomous Abyss" }
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
          raidId: "2987",
          raidName: "The Tidebound Grotto",
          bossId: "3379",
          bossName: "Nymrissa Wavecaller",
          fightUrl: "https://www.warcraftlogs.com/reports/mixedReport#fight=23"
        },
        {
          raidId: "3004",
          raidName: "The Venomous Abyss",
          bossId: "3470",
          bossName: "Nek'zali the Soulcoiler",
          fightUrl: "https://www.warcraftlogs.com/reports/mixedReport#fight=25"
        }
      ]
    });
  });

  it("drops a Mythic dungeon fight and keeps the raid fights beside it", async () => {
    // Break caught: a Mythic dungeon boss and a Mythic raid boss share a
    // difficulty, so the scan stored dungeon kills as raid evidence in a zone
    // no raid catalogue holds. Unplaceable, they could never go terminal, and
    // the oldest of them pinned the scan floor to the bottom of a veteran's
    // history (#346). Dropped per fight, never per report: a raid night that
    // also ran a dungeon must keep every raid fight in it.
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
                        code: "dungeonNightReport",
                        startTime: 1_728_086_400_000,
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
                            id: 3,
                            encounterID: 1234,
                            name: "Queen Ansurek",
                            startTime: 3_600_000,
                            endTime: 3_600_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: { id: 2657, name: "Nerub-ar Palace" }
                          },
                          {
                            id: 4,
                            encounterID: 2419,
                            name: "Ingra Maloch",
                            startTime: 7_200_000,
                            endTime: 7_200_000,
                            kill: true,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: {
                              id: 2290,
                              name: "Mists of Tirna Scithe"
                            }
                          },
                          {
                            id: 5,
                            encounterID: 2426,
                            name: "Amarth",
                            startTime: 10_800_000,
                            endTime: 10_800_000,
                            kill: false,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: { id: 2286, name: "The Necrotic Wake" }
                          },
                          {
                            id: 6,
                            encounterID: 4321,
                            name: "The Silken Court",
                            startTime: 14_400_000,
                            endTime: 14_400_000,
                            kill: false,
                            difficulty: 5,
                            friendlyPlayers: [7],
                            gameZone: { id: 2657, name: "Nerub-ar Palace" }
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
          raidId: "2657",
          raidName: "Nerub-ar Palace",
          bossName: "Queen Ansurek",
          fightUrl:
            "https://www.warcraftlogs.com/reports/dungeonNightReport#fight=3"
        }
      ],
      wipes: [
        {
          raidId: "2657",
          raidName: "Nerub-ar Palace",
          bossName: "The Silken Court",
          fightUrl:
            "https://www.warcraftlogs.com/reports/dungeonNightReport#fight=6"
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
                        startTime: 1_728_086_400_000,
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
          attemptedAt: "2024-10-05T00:05:00.000Z",
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
                        startTime: 1_728_086_400_000,
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
      startTime: 1_728_086_400_000,
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
          attemptedAt: "2024-10-05T00:05:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/a-report#fight=1"
        },
        {
          attemptedAt: "2024-10-05T00:05:00.000Z",
          fightUrl: "https://www.warcraftlogs.com/reports/z-report#fight=1"
        },
        {
          attemptedAt: "2024-10-05T00:02:00.000Z",
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
                        startTime: 1_728_086_400_000,
                        owner: { name: "Dorian" },
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
          killedAt: "2024-10-05T02:00:00.000Z",
          journalBossId: "2345",
          guild: {
            name: "Example Guild",
            region: "eu",
            realm: "silvermoon"
          },
          uploader: "Dorian"
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
                        startTime: 1_728_086_400_000,
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
                        startTime: 1_728_086_400_000,
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

    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it("refreshes the OAuth token sixty seconds before its reported expiry", async () => {
    // Break caught: a token used at its provider expiry can fail an otherwise
    // valid GraphQL request, so the cache must refresh it one minute early.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-10-03T00:00:00.000Z"));
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

      expect(fetch).toHaveBeenCalledTimes(14);
      expect(authorizations).toEqual([
        ...Array.from({ length: 8 }, () => "Bearer token-1"),
        ...Array.from({ length: 4 }, () => "Bearer token-2")
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

  it("continues a capped scan at its proved next page", async () => {
    // Break caught: #394. A retry that starts at page one re-reads every
    // newest report the cap already decoded and never reaches older history.
    const page = (fixture("character-report-valid") as { pages: unknown[] })
      .pages[0];
    const historyPages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { page?: number };
      };
      if (body.query.includes("RecentReports")) {
        historyPages.push(body.variables.page ?? 0);
      }
      return jsonResponse(page);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 2,
      parseRequestCap: 10,
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "lateReport"
    });

    // The proved boundary page is the validation request. It counts toward
    // the same physical-request budget as the page that advances the scan.
    expect(historyPages).toEqual([18, 19]);
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "request_cap" },
      historyScanResumePage: 20
    });
  });

  it.each([false, true])(
    "never reports a resumed scan as a finished history (omission: %s)",
    async (omitted) => {
      // Break caught: a resumed scan reads only the pages below its cursor.
      // Reaching their end was reported as a clean read, the run published
      // complete, and a complete publish keeps only what the run found outside
      // terminal raids -- then marked raids terminal from that fraction. Ryii
      // went from 751 kills to 269 on 2026-09-23, and eight characters with it.
      const page = structuredClone(
        (fixture("character-report-valid") as { pages: unknown[] }).pages[0]
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
      if (omitted) {
        page.data.characterData.character.recentReports.data[0]!.fights.unshift(
          {
            id: 80,
            encounterID: 1234,
            name: "Queen Ansurek",
            difficulty: 5,
            friendlyPlayers: [7],
            startTime: 20_000,
            endTime: 10_000,
            kill: false
          }
        );
      }
      const historyPages: number[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { page?: number };
        };
        if (body.query.includes("RecentReports")) {
          const requestedPage = body.variables.page ?? 0;
          historyPages.push(requestedPage);
          return jsonResponse(
            requestedPage === 66
              ? page
              : {
                  data: {
                    characterData: {
                      character: {
                        server: { normalizedName: "Silvermoon" },
                        recentReports: { data: [], has_more_pages: false }
                      }
                    }
                  }
                }
          );
        }
        return emptyZoneRankingsResponse();
      });

      const result = await client.getFirstKillReports(key, {
        requestCap: 300,
        parseRequestCap: 10,
        historyScanStartPage: 67,
        historyScanResumeBoundaryReportCode: "lateReport"
      });

      // The whole budget was not needed, and the history below the cursor ran
      // out -- which is exactly the case that must not read as finished.
      expect(historyPages).toEqual([66, 67]);
      expect(result).toMatchObject({
        kind: "evidence",
        limitation: { code: "request_cap" },
        // Page one with no boundary: the next run reads the whole history.
        historyScanResumePage: 1
      });
      expect(result).not.toHaveProperty("historyScanResumeBoundaryReportCode");
      expect(result.kind === "evidence" && result.omittedInvalidTimestamp).toBe(
        omitted ? true : undefined
      );
    }
  );

  it("still reports a whole-history scan from page one as finished", async () => {
    const page = (fixture("character-report-valid") as { pages: unknown[] })
      .pages[0] as {
      data: {
        characterData: {
          character: { recentReports: { has_more_pages: boolean } };
        };
      };
    };
    const lastPage = structuredClone(page);
    lastPage.data.characterData.character.recentReports.has_more_pages = false;
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("RecentReports")) return jsonResponse(lastPage);
      return emptyZoneRankingsResponse();
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 300,
      parseRequestCap: 10
    });

    expect(result).not.toHaveProperty("limitation");
  });

  it("keeps its proved cursor across an empty history page", async () => {
    // Break caught: an empty page advanced the cursor with no boundary, which
    // the next run could not validate -- so it restarted at page one and
    // saved the first cursor again. Ryii alternated between pages 67 and 68
    // for a day. Here the page after the empty one drifts, so the run ends
    // limited with whatever cursor it proved.
    const page = (fixture("character-report-valid") as { pages: unknown[] })
      .pages[0];
    const emptyPage = {
      data: {
        characterData: {
          character: {
            server: { normalizedName: "Silvermoon" },
            recentReports: { data: [], has_more_pages: true }
          }
        }
      }
    };
    const historyPages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { page?: number };
      };
      if (body.query.includes("RecentReports")) {
        const requestedPage = body.variables.page ?? 0;
        historyPages.push(requestedPage);
        return jsonResponse(
          requestedPage === 66
            ? page
            : requestedPage === 67
              ? emptyPage
              : fixture("schema-drift")
        );
      }
      return emptyZoneRankingsResponse();
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 10,
      parseRequestCap: 10,
      historyScanStartPage: 67,
      historyScanResumeBoundaryReportCode: "lateReport"
    });

    expect(historyPages).toEqual([66, 67, 68]);
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "schema_drift" },
      historyScanResumePage: 67,
      historyScanResumeBoundaryReportCode: "lateReport"
    });
  });

  it("does not probe a stored boundary on a run with no history budget", async () => {
    // Break caught: the probe went out before the cap was consulted, so a
    // parse-only resume spent a request it did not have -- and an unavailable
    // probe returned early and dropped the whole parse-only run.
    const historyPages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { page?: number };
      };
      if (body.query.includes("RecentReports")) {
        historyPages.push(body.variables.page ?? 0);
        return new Response("upstream-body-marker", { status: 503 });
      }
      return emptyZoneRankingsResponse();
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 0,
      parseRequestCap: 10,
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "lateReport"
    });

    expect(historyPages).toEqual([]);
    expect(result).not.toEqual({ kind: "limitation", code: "unavailable" });
  });

  it("reports the cap when a resume spends its whole budget proving the boundary", async () => {
    // Break caught: the proved boundary page counts as decoded, which must not
    // let a run that read nothing past it look like a finished history.
    const page = (fixture("character-report-valid") as { pages: unknown[] })
      .pages[0];
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token" ? token() : jsonResponse(page)
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10,
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "lateReport"
    });

    expect(result).toMatchObject({
      limitation: { code: "request_cap" },
      historyScanResumePage: 19,
      historyScanResumeBoundaryReportCode: "lateReport"
    });
  });

  it("does not manufacture a resume page from an undecodable history response", async () => {
    // Break caught: a malformed or refused page is not evidence of where the
    // scan reached, so persisting a boundary for it can silently skip history.
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : jsonResponse(fixture("schema-drift"))
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10,
      historyScanStartPage: 19
    });

    expect(result).toEqual({ kind: "limitation", code: "schema_drift" });
    expect(JSON.stringify(result)).not.toContain("schema-envelope-marker");
  });

  it("restarts at the newest page when a new report shifts a saved boundary", async () => {
    // Break caught: a report uploaded after the cap moves page boundaries. A
    // stale offset must not skip it and publish a false complete history.
    const page = (fixture("character-report-valid") as { pages: unknown[] })
      .pages[0];
    const historyPages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { page?: number };
      };
      if (body.query.includes("RecentReports")) {
        historyPages.push(body.variables.page ?? 0);
      }
      return jsonResponse(page);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10,
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "report-that-was-replaced"
    });

    expect(historyPages).toEqual([18]);
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "request_cap" },
      historyScanResumePage: 1
    });
  });

  it("restarts when a late report shifts a boundary below an unchanged head", async () => {
    // Break caught: checking only page one misses a backdated upload below an
    // unchanged newest report. The last code on the proved boundary page must
    // still be present at that exact page offset before resuming below it.
    const page = (fixture("character-report-valid") as { pages: unknown[] })
      .pages[0];
    const shiftedBoundary = structuredClone(page) as {
      data: {
        characterData: {
          character: { recentReports: { data: Array<{ code: string }> } };
        };
      };
    };
    shiftedBoundary.data.characterData.character.recentReports.data[0]!.code =
      "late-backdated-report";
    const historyPages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { page?: number };
      };
      if (body.query.includes("RecentReports")) {
        const requestedPage = body.variables.page ?? 0;
        historyPages.push(requestedPage);
        return jsonResponse(requestedPage === 18 ? shiftedBoundary : page);
      }
      return jsonResponse(page);
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 2,
      parseRequestCap: 10,
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "lateReport"
    });

    expect(historyPages).toEqual([18, 1]);
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "request_cap" },
      historyScanResumePage: 2
    });
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

  it.each([true, false])(
    "keeps a timestamp omission visible when later data has schema drift (valid evidence: %s)",
    async (withValidEvidence) => {
      const page = structuredClone(
        (fixture("character-report-valid") as { pages: unknown[] }).pages[0]
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
      const fights =
        page.data.characterData.character.recentReports.data[0]!.fights;
      if (!withValidEvidence) fights.splice(0);
      fights.push(
        {
          id: 80,
          encounterID: 1234,
          name: "Queen Ansurek",
          difficulty: 5,
          friendlyPlayers: [7],
          startTime: 20_000,
          endTime: 10_000,
          kill: false
        },
        { id: 81, encounterID: 1234, kill: true }
      );
      const { client } = clientFor((url) =>
        url.pathname === "/oauth/token" ? token() : jsonResponse(page)
      );

      const result = await client.getFirstKillReports(key, {
        requestCap: 1,
        parseRequestCap: 10
      });

      expect(result).toMatchObject({
        kind: "evidence",
        omittedInvalidTimestamp: true,
        limitation: { code: "schema_drift" }
      });
    }
  );

  it("skips unrelated negative-time boss fights and continues to later history pages", async () => {
    // A shared report can contain fights before its report start. They cannot
    // describe this character when its actor ID is absent from friendlyPlayers.
    const pages = structuredClone(
      (fixture("character-report-valid") as { pages: unknown[] }).pages
    ) as Array<{
      data: {
        characterData: {
          character: {
            recentReports: {
              data: Array<{
                masterData: { actors: Array<Record<string, unknown>> };
                fights: Array<Record<string, unknown>>;
              }>;
            };
          };
        };
      };
    }>;
    pages[0]!.data.characterData.character.recentReports.data[0]!.masterData.actors.push(
      {
        id: 8,
        name: "Other",
        server: "Silvermoon",
        type: "Player"
      }
    );
    pages[0]!.data.characterData.character.recentReports.data[0]!.fights.push(
      {
        id: 80,
        encounterID: 1234,
        name: "Queen Ansurek",
        startTime: -20_000,
        endTime: -10_000,
        kill: true,
        difficulty: 5,
        friendlyPlayers: [8]
      },
      {
        id: 81,
        encounterID: 1234,
        name: "Queen Ansurek",
        startTime: -20_000,
        endTime: -10_000,
        kill: false,
        difficulty: 5,
        friendlyPlayers: [8]
      }
    );
    const historyPages: number[] = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { page?: number };
      };
      if (body.query.includes("RecentReports")) {
        const page = body.variables.page!;
        historyPages.push(page);
        return jsonResponse(pages[page - 1]);
      }
      return emptyZoneRankingsResponse();
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 2,
      parseRequestCap: 10
    });

    expect(historyPages).toEqual([1, 2]);
    expect(result).toMatchObject({
      kind: "evidence",
      kills: expect.arrayContaining([
        expect.objectContaining({
          fightUrl: expect.stringContaining("lateReport#fight=1")
        }),
        expect.objectContaining({
          fightUrl: expect.stringContaining("earlyReport#fight=7")
        })
      ]),
      wipes: [
        expect.objectContaining({
          fightUrl: expect.stringContaining("lateReport#fight=9")
        })
      ]
    });
    expect(result).not.toHaveProperty("limitation");
    if (result.kind === "evidence") {
      expect(result.kills).toHaveLength(3);
      expect(result.wipes).toHaveLength(1);
    }
  });

  it.each([
    [1, [1], 2, 1, "request_cap"],
    [2, [1, 2], undefined, 3, undefined]
  ])(
    "omits impossible fight times with a %i-page budget and keeps valid evidence",
    async (
      requestCap,
      expectedPages,
      resumePage,
      killCount,
      limitationCode
    ) => {
      const pages = structuredClone(
        (fixture("character-report-valid") as { pages: unknown[] }).pages
      ) as Array<{
        data: {
          characterData: {
            character: {
              recentReports: {
                data: Array<{ fights: Array<Record<string, unknown>> }>;
              };
            };
          };
        };
      }>;
      pages[0]!.data.characterData.character.recentReports.data[0]!.fights.unshift(
        ...[
          { id: 80, startTime: 20_000, endTime: 10_000, kill: false },
          { id: 81, startTime: -20_000, endTime: 10_000, kill: true },
          { id: 82, startTime: undefined, endTime: 10_000, kill: false },
          { id: 83, startTime: 1.5, endTime: 10_000, kill: true },
          { id: 84, startTime: 0, endTime: -10_000, kill: false },
          {
            id: 85,
            startTime: 0,
            endTime: 8_640_000_000_000_000 - 1,
            kill: true
          }
        ].map((fight) => ({
          ...fight,
          encounterID: 1234,
          name: "Queen Ansurek",
          difficulty: 5,
          friendlyPlayers: [7]
        }))
      );
      const historyPages: number[] = [];
      const { client } = clientFor((url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { page?: number };
        };
        if (body.query.includes("RecentReports")) {
          historyPages.push(body.variables.page!);
          return jsonResponse(pages[body.variables.page! - 1]);
        }
        return emptyZoneRankingsResponse();
      });

      const result = await client.getFirstKillReports(key, {
        requestCap,
        parseRequestCap: 10
      });

      expect(historyPages).toEqual(expectedPages);
      expect(result).toMatchObject({
        kind: "evidence",
        omittedInvalidTimestamp: true,
        kills: expect.arrayContaining([
          expect.objectContaining({
            fightUrl: expect.stringContaining("lateReport#fight=1")
          })
        ]),
        wipes: [
          expect.objectContaining({
            fightUrl: expect.stringContaining("lateReport#fight=9")
          })
        ]
      });
      if (result.kind === "evidence") {
        expect(result.limitation?.code).toBe(limitationCode);
        expect(result.historyScanResumePage).toBe(resumePage);
        expect(result.kills).toHaveLength(killCount);
        expect(result.wipes).toHaveLength(1);
        if (requestCap === 2) {
          expect(result.kills).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                fightUrl: expect.stringContaining("earlyReport#fight=7")
              })
            ])
          );
        }
      }
    }
  );

  it.each([
    ["negative start", -20_000, 3_600_000],
    ["negative end", 0, -10_000],
    ["missing start", undefined, 3_600_000],
    ["reversed interval", 3_600_001, 3_600_000]
  ])("omits a fight with a %s", async (_label, startTime, endTime) => {
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

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 10
    });
    expect(result).toMatchObject({
      kind: "evidence",
      omittedInvalidTimestamp: true,
      kills: [],
      wipes: []
    });
    expect(result).not.toHaveProperty("limitation");
    expect(result).not.toHaveProperty("historyScanResumePage");
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

  it("counts the requests it issues by query type", async () => {
    // Break caught: one `getFirstKillReports` is a single gateway call but four
    // classes of upstream request, so a run's cost cannot be attributed to the
    // history scan or to rankings without counting them apart.
    const requests: Array<{ query: string; limited: boolean }> = [];
    const { client } = performanceClient(
      performanceRankings({ damage: 91, healing: 12, bossDamage: 44 })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8,
      onRequest: (event) => requests.push(event)
    });

    expect(result.kind).toBe("evidence");
    expect(requests).toEqual([
      { query: "history_scan", limited: false, durationMs: expect.any(Number) },
      {
        query: "zone_rankings",
        limited: false,
        durationMs: expect.any(Number)
      },
      { query: "fight_parses", limited: false, durationMs: expect.any(Number) },
      {
        query: "ranking_identities",
        limited: false,
        durationMs: expect.any(Number)
      }
    ]);
  });

  it("times each request it issues on the injected clock", async () => {
    // Break caught: request counts said what a slow run asked for but not
    // which part was slow; only the client sees a single request start and end.
    const requests: Array<{ query: string; durationMs: number }> = [];
    let tick = 0;
    const { fetch } = performanceClient(
      performanceRankings({ damage: 91, healing: 12, bossDamage: 44 })
    );
    const client = createWarcraftLogsClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker",
      // Each reading advances further than the last, so a duration taken
      // from the wrong pair of readings would not come out as these values.
      monotonic: () => {
        tick += 1;
        return tick * tick;
      }
    });

    await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8,
      onRequest: ({ query, durationMs }) => requests.push({ query, durationMs })
    });

    // Readings 1,4 | 9,16 | 25,36 | 49,64: one pair per request, nothing
    // read between them.
    expect(requests).toEqual([
      { query: "history_scan", durationMs: 3 },
      { query: "zone_rankings", durationMs: 7 },
      { query: "fight_parses", durationMs: 11 },
      { query: "ranking_identities", durationMs: 15 }
    ]);
  });

  it("reports a zone-rankings request that came back limited", async () => {
    // Break caught: counting only issued requests hides which class of query is
    // the one being refused, which is the class an optimisation must target.
    const requests: Array<{ query: string; limited: boolean }> = [];
    const limitations: Array<{ query: string; code: string }> = [];
    // Built directly rather than through `clientFor`: that harness reshapes any
    // zone response it cannot parse, which would swallow the 503 under test.
    const client = createWarcraftLogsClient({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as { query: string };
        return body.query.includes("CharacterZoneParses")
          ? new Response("", { status: 503 })
          : jsonResponse(performanceReport([26]));
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "client-secret-marker"
    });

    await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8,
      onRequest: (event) => requests.push(event),
      onLimitation: (query, code) => limitations.push({ query, code })
    });

    expect(requests).toContainEqual({
      query: "zone_rankings",
      limited: true,
      limitationCode: "unavailable",
      durationMs: expect.any(Number)
    });
    expect(
      requests.filter((event) => event.query === "zone_rankings")
    ).toHaveLength(1);
    expect(limitations).toContainEqual({
      query: "zone_rankings",
      code: "parse_unavailable"
    });
  });

  it("counts the history scan even when the run returns a bare limitation", async () => {
    // Break caught: a run that fails outright returns no evidence to hang
    // counters on, and it is exactly the run whose spend needs explaining.
    const requests: Array<{ query: string; limited: boolean }> = [];
    const { client } = clientFor((url) =>
      url.pathname === "/oauth/token"
        ? token()
        : new Response("", { status: 429 })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 8,
      onRequest: (event) => requests.push(event)
    });

    expect(result).toMatchObject({ kind: "limitation", code: "rate_limited" });
    expect(requests).toEqual([
      {
        query: "history_scan",
        limited: true,
        limitationCode: "rate_limited",
        durationMs: expect.any(Number)
      }
    ]);
  });

  it("counts one history-scan request per page of a paginated scan", async () => {
    // Break caught: the scan is the one class whose count varies with history
    // depth, so a per-run count rather than a per-page count would say nothing.
    const requests: Array<{ query: string; limited: boolean }> = [];
    const { client } = clientFor((url, init) => {
      if (url.pathname === "/oauth/token") return token();
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("RecentReports")) {
        return jsonResponse(performanceReport([26], true));
      }
      return jsonResponse(performanceReport([26]));
    });

    await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 8,
      onRequest: (event) => requests.push(event)
    });

    expect(
      requests.filter((event) => event.query === "history_scan")
    ).toHaveLength(3);
  });

  it("keeps a throwing onRequest from changing the returned evidence", async () => {
    // Break caught: an unguarded counter would turn an instrumented run into an
    // unexpected_error job retry, making the measurement cost what it measures.
    const { client } = performanceClient(
      performanceRankings({ damage: 91, healing: 12, bossDamage: 44 })
    );

    await expect(
      client.getFirstKillReports(key, {
        requestCap: 1,
        parseRequestCap: 8,
        onRequest: () => {
          throw new Error("counter-exploded-marker");
        }
      })
    ).resolves.toMatchObject({ kind: "evidence" });
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

describe("searching one tier's guild attendance", () => {
  const day = 24 * 60 * 60 * 1_000;
  const hours = (count: number) => count * 60 * 60 * 1_000;
  // Newest first: attendance report `i` started `i` days before this, 25 a
  // page, the way Warcraft Logs pages a long-lived guild.
  const newest = Date.parse("2026-09-01T19:00:00.000Z");
  const startOf = (index: number) => newest - index * day;
  const codeOf = (guild: string, index: number) => `${guild}${index}`;
  const tierFrom = new Date(startOf(330) - hours(2)).toISOString();
  const tierTo = new Date(startOf(310) + hours(4)).toISOString();

  const emptyHistory = () =>
    jsonResponse({
      data: {
        characterData: {
          character: {
            server: { normalizedName: "Silvermoon" },
            recentReports: { data: [], has_more_pages: false }
          }
        }
      }
    });
  const attendance = (
    guild: string,
    page: number,
    totalReports: number,
    listed: (index: number) => boolean = () => true
  ) => {
    const first = (page - 1) * 25;
    const indexes = Array.from(
      { length: 25 },
      (_, offset) => first + offset
    ).filter((index) => index < totalReports);
    return jsonResponse({
      data: {
        guildData: {
          guild: {
            attendance: {
              data: indexes.map((index) => ({
                code: codeOf(guild, index),
                startTime: startOf(index),
                players: [{ name: listed(index) ? "Sentinel" : "Someone" }]
              })),
              has_more_pages: first + 25 < totalReports
            }
          }
        }
      }
    });
  };
  // A report holding one Mythic Queen Azshara kill and one Mythic wipe on an
  // earlier boss, both by the character.
  const hydrated = (code: string, startTime: number) =>
    jsonResponse({
      data: {
        reportData: {
          report: {
            code,
            startTime,
            owner: { name: "Uploader" },
            guild: null,
            zone: {
              id: 23,
              name: "The Eternal Palace",
              encounters: [
                { id: 2299, journalID: 0 },
                { id: 2293, journalID: 0 }
              ]
            },
            masterData: {
              actors: [
                {
                  id: 12,
                  name: "Sentinel",
                  server: "Silvermoon",
                  type: "Player"
                }
              ]
            },
            fights: [
              {
                id: 3,
                encounterID: 2293,
                name: "Za'qul, Harbinger of Ny'alotha",
                startTime: hours(0.2),
                endTime: hours(0.3),
                kill: false,
                difficulty: 5,
                friendlyPlayers: [12]
              },
              {
                id: 8,
                encounterID: 2299,
                name: "Queen Azshara",
                startTime: hours(0.5),
                endTime: hours(1),
                kill: true,
                difficulty: 5,
                friendlyPlayers: [12]
              }
            ]
          }
        }
      }
    });
  const characterGuilds = (guilds: unknown[]) =>
    jsonResponse({
      data: { characterData: { character: { guilds } } }
    });

  type Body = {
    query: string;
    variables: { name?: string; page?: number; code?: string };
  };
  type Sent = { query: string; guild?: string; page?: number; code?: string };
  function tierClient(
    options: Readonly<{
      guildReports?: Readonly<Record<string, number>>;
      listedGuilds?: unknown[];
      listed?: (index: number) => boolean;
      refuseGuild?: string;
      monotonic?: () => number;
    }> = {}
  ) {
    const requests: Sent[] = [];
    const guildReports = options.guildReports ?? { Guild: 500 };
    const { client } = clientFor(
      (url, init) => {
        if (url.pathname === "/oauth/token") return token();
        const body = JSON.parse(String(init?.body)) as Body;
        const query = body.query.match(/query (\w+)/)?.[1] ?? "";
        requests.push({
          query,
          ...(body.variables.name ? { guild: body.variables.name } : {}),
          ...(body.variables.page ? { page: body.variables.page } : {}),
          ...(body.variables.code ? { code: body.variables.code } : {})
        });
        if (query === "RecentReports") return emptyHistory();
        if (query === "CharacterGuilds") {
          return characterGuilds(options.listedGuilds ?? []);
        }
        if (query === "GuildAttendance") {
          const guild = body.variables.name!;
          if (guild === "Ghost") {
            return jsonResponse({ data: { guildData: { guild: null } } });
          }
          if (guild === options.refuseGuild) {
            return new Response("upstream-body-marker", { status: 503 });
          }
          return attendance(
            guild,
            body.variables.page!,
            guildReports[guild] ?? 0,
            options.listed
          );
        }
        if (query === "ReportByCode") {
          const code = body.variables.code!;
          const index = Number(code.replace(/^\D+/, ""));
          return hydrated(code, startOf(index));
        }
        return emptyZoneRankingsResponse();
      },
      options.monotonic ? { monotonic: options.monotonic } : {}
    );
    return { client, requests };
  }
  const guild = { name: "Guild", realm: "silvermoon", region: "eu" as const };
  const windowCodes = (name: string) =>
    Array.from({ length: 21 }, (_, offset) => codeOf(name, 310 + offset));

  it("gallops to the tier's window instead of reading every newer page", async () => {
    // Break caught: an old tier sits behind years of a guild's attendance,
    // and reading every page in between is what cost Ryii 71 pages a run.
    const { client, requests } = tierClient();

    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild],
        requestCap: 60
      }
    });

    const pages = requests
      .filter((request) => request.query === "GuildAttendance")
      .map((request) => request.page);
    // The window's reports sit on pages 13 and 14, of 20.
    expect(pages).toContain(13);
    expect(pages).toContain(14);
    expect(pages.length).toBeLessThan(10);
    expect(pages).not.toContain(20);
    const hydratedCodes = requests
      .filter((request) => request.query === "ReportByCode")
      .map((request) => request.code);
    expect(new Set(hydratedCodes)).toEqual(new Set(windowCodes("Guild")));
    expect(result).toMatchObject({
      kind: "evidence",
      tierSearch: {
        outcome: "complete",
        guildsSearched: 1,
        reportsHydrated: 21,
        recoveredKills: 21,
        recoveredWipes: 21
      }
    });
    expect(result).not.toHaveProperty("limitation");
  });

  describe("sharing a finished walk between the characters of one press", () => {
    const searchAs = (
      client: ReturnType<typeof tierClient>["client"],
      name: string,
      requestCap = 60
    ) =>
      client.getFirstKillReports(
        { ...key, name },
        {
          requestCap: 0,
          targetedOnly: true,
          parseRequestCap: 1,
          tierSearch: {
            from: tierFrom,
            to: tierTo,
            guilds: [guild],
            requestCap
          }
        }
      );
    const attendancePages = (requests: readonly Sent[]) =>
      requests.filter((request) => request.query === "GuildAttendance").length;

    it("replays a guild's finished walk for the next character", async () => {
      // Break caught: one press searches up to 30 characters, alts share
      // guilds, and every run walked the same guild's attendance again at
      // about 28 points a page.
      const { client, requests } = tierClient();

      await searchAs(client, "sentinel");
      const firstPages = attendancePages(requests);
      requests.length = 0;
      const second = await searchAs(client, "sentinel");

      expect(firstPages).toBeGreaterThan(0);
      expect(attendancePages(requests)).toBe(0);
      // Each character still judges each report, and hydrates its own.
      expect(second).toMatchObject({
        tierSearch: { outcome: "complete", recoveredKills: 21 }
      });
    });

    it("judges a replayed walk's reports by the searching character's name", async () => {
      const { client, requests } = tierClient();

      await searchAs(client, "sentinel");
      requests.length = 0;
      const alt = await searchAs(client, "otheralt");

      expect(attendancePages(requests)).toBe(0);
      expect(
        requests.filter((request) => request.query === "ReportByCode")
      ).toEqual([]);
      expect(alt).toMatchObject({
        tierSearch: { outcome: "complete", reportsHydrated: 0 }
      });
    });

    it("keeps no walk the budget cut short", async () => {
      // A kept page beside a fresh one could skip a report at the seam, so
      // only a whole walk is ever replayed.
      const { client, requests } = tierClient();

      await searchAs(client, "sentinel", 4);
      requests.length = 0;
      await searchAs(client, "sentinel");

      expect(attendancePages(requests)).toBeGreaterThan(0);
    });

    it("walks again once a kept walk has expired", async () => {
      let now = 0;
      const { client, requests } = tierClient({ monotonic: () => now });

      await searchAs(client, "sentinel");
      now += 31 * 60_000;
      requests.length = 0;
      await searchAs(client, "sentinel");

      expect(attendancePages(requests)).toBeGreaterThan(0);
    });
  });

  it("reads no history on a targeted search, and reports no shortfall for it", async () => {
    // Break caught (#450): a zero request cap reports the unread history as
    // `request_cap`, which would make every targeted search partial and hide
    // whether its own walk had finished.
    const { client, requests } = tierClient();

    const result = await client.getFirstKillReports(key, {
      requestCap: 0,
      targetedOnly: true,
      parseRequestCap: 1,
      historyScanStartPage: 19,
      historyScanResumeBoundaryReportCode: "lateReport",
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild],
        requestCap: 60
      }
    });

    expect(
      requests.filter((request) => request.query === "RecentReports")
    ).toEqual([]);
    expect(result).toMatchObject({
      kind: "evidence",
      scanSkipped: true,
      tierSearch: { outcome: "complete", recoveredKills: 21 }
    });
    expect(result).not.toHaveProperty("limitation");
    expect(result).not.toHaveProperty("historyScanResumePage");
  });

  it("refuses a targeted search that was given history to scan", async () => {
    const { client, requests } = tierClient();

    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      targetedOnly: true,
      parseRequestCap: 1
    });

    expect(result).toEqual({ kind: "limitation", code: "request_cap" });
    expect(requests).toEqual([]);
  });

  it("keeps wipes, and hydrates only reports that may list the character", async () => {
    // A wipe-only night has no kill for Raider.IO to verify, which is why the
    // tier search exists. A report whose attendance rules the character out,
    // or whose evidence is already stored, is never read.
    const { client, requests } = tierClient({
      listed: (index) => index % 2 === 0
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild],
        requestCap: 60,
        skipReportCodes: [codeOf("Guild", 320)]
      }
    });

    const hydratedCodes = requests
      .filter((request) => request.query === "ReportByCode")
      .map((request) => request.code);
    expect(hydratedCodes).not.toContain(codeOf("Guild", 311));
    expect(hydratedCodes).not.toContain(codeOf("Guild", 320));
    expect(hydratedCodes).toContain(codeOf("Guild", 322));
    expect(result.kind === "evidence" ? result.wipes.length : 0).toBe(10);
  });

  it("walks the guilds Warcraft Logs lists for the character as well", async () => {
    // Break caught: a guildless Raider.IO kill names no guild, so a search of
    // only the caller's guilds had nowhere to look.
    const { client, requests } = tierClient({
      guildReports: { Guild: 500, Other: 400 },
      listedGuilds: [
        {
          name: "Other",
          server: { slug: "silvermoon", region: { slug: "EU" } }
        },
        {
          name: "guild",
          server: { slug: "Silvermoon", region: { slug: "EU" } }
        },
        {
          name: "Nowhere",
          server: { slug: "somewhere", region: { slug: "CN" } }
        }
      ]
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild],
        requestCap: 100
      }
    });

    const walked = new Set(
      requests
        .filter((request) => request.query === "GuildAttendance")
        .map((request) => request.guild)
    );
    expect(walked).toEqual(new Set(["Guild", "Other"]));
    expect(result).toMatchObject({ tierSearch: { guildsSearched: 2 } });
  });

  it("stops at its own cap without limiting the run or touching the scan's", async () => {
    const { client, requests } = tierClient();

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild],
        requestCap: 8
      }
    });

    const tierRequests = requests.filter((request) =>
      ["CharacterGuilds", "GuildAttendance", "ReportByCode"].includes(
        request.query
      )
    );
    expect(tierRequests).toHaveLength(8);
    expect(
      requests.filter((request) => request.query === "RecentReports")
    ).toHaveLength(1);
    expect(result).toMatchObject({
      kind: "evidence",
      tierSearch: { outcome: "request_cap", requests: 8 }
    });
    expect(result).not.toHaveProperty("limitation");
  });

  it("calls a guild it cannot read incomplete, and still walks the rest", async () => {
    const { client } = tierClient({
      guildReports: { Guild: 500, Other: 400 },
      refuseGuild: "Guild"
    });

    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild, { ...guild, name: "Other" }],
        requestCap: 60
      }
    });

    expect(result).toMatchObject({
      kind: "evidence",
      tierSearch: { outcome: "incomplete", recoveredKills: 21 }
    });
    expect(result).not.toHaveProperty("limitation");
  });

  it("counts a guild Warcraft Logs has no record of as walked, not unreadable", async () => {
    const { client } = tierClient({ guildReports: { Guild: 500 } });
    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild, { ...guild, name: "Ghost" }],
        requestCap: 60
      }
    });

    // "Ghost" answers with `guild: null`, which is Warcraft Logs saying it
    // has no such guild: nothing to walk, so the search still completes.
    expect(result).toMatchObject({
      tierSearch: { outcome: "complete", guildsSearched: 2 }
    });
  });

  it("hydrates nothing from a guild whose attendance is all newer than the tier", async () => {
    const { client, requests } = tierClient({ guildReports: { Guild: 60 } });

    const result = await client.getFirstKillReports(key, {
      requestCap: 5,
      parseRequestCap: 1,
      tierSearch: {
        from: tierFrom,
        to: tierTo,
        guilds: [guild],
        requestCap: 60
      }
    });

    expect(
      requests.filter((request) => request.query === "ReportByCode")
    ).toHaveLength(0);
    expect(result).toMatchObject({
      tierSearch: { outcome: "complete", recoveredKills: 0 }
    });
  });
});
