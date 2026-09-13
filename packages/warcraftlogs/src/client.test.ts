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

function clientFor(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>
) {
  const fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      responder(
        new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        ),
        init
      )
  );
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
          name: string;
          realm: string;
          region: string;
          page: number;
        };
      };
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
      client.getFirstKillReports(key, { requestCap: 10 })
    ).resolves.toEqual({
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
      ]
    });
    expect(fetch).toHaveBeenCalledTimes(3);
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

    const result = await client.getFirstKillReports(key, { requestCap: 1 });

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
                          server: { slug: "silvermoon" }
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
      client.getFirstKillReports(key, { requestCap: 1 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: [
        {
          killedAt: "2024-02-03T02:00:00.000Z",
          journalBossId: "2345",
          guild: { name: "Example Guild", realm: "silvermoon" }
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
      client.getFirstKillReports(key, { requestCap: 1 })
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
      client.getFirstKillReports(aeriePeakKey, { requestCap: 1 })
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
      client.getFirstKillReports(key, { requestCap: 10 })
    ).resolves.toMatchObject({ kind: "evidence" });
    await expect(
      client.getFirstKillReports(key, { requestCap: 10 })
    ).resolves.toMatchObject({ kind: "evidence" });

    expect(fetch).toHaveBeenCalledTimes(3);
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

      await client.getFirstKillReports(key, { requestCap: 10 });
      await vi.advanceTimersByTimeAsync(59_000);
      await client.getFirstKillReports(key, { requestCap: 10 });
      await vi.advanceTimersByTimeAsync(1_000);
      await client.getFirstKillReports(key, { requestCap: 10 });

      expect(fetch).toHaveBeenCalledTimes(5);
      expect(authorizations).toEqual([
        "Bearer token-1",
        "Bearer token-1",
        "Bearer token-2"
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
      client.getFirstKillReports(key, { requestCap: 1 })
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

    const result = await client.getFirstKillReports(key, { requestCap: 1 });
    expect(result).toEqual({
      kind: "limitation",
      code: "rate_limited",
      retryAfterMs: 60_000
    });
    expect(JSON.stringify(result)).not.toContain("rate-limit-body-marker");
    expect(JSON.stringify(result)).not.toContain("client-secret-marker");
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
      client.getFirstKillReports(key, { requestCap: 1 })
    ).resolves.toMatchObject({
      kind: "evidence",
      kills: expect.any(Array),
      limitation: { kind: "limitation", code: "request_cap" }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
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
    const result = await client.getFirstKillReports(key, { requestCap: 3 });
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "schema_drift" }
    });
    if (result.kind === "evidence")
      expect(result.kills.length).toBeGreaterThan(0);
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
      signal: controller.signal
    });
    expect(result).toMatchObject({
      kind: "evidence",
      limitation: { code: "unavailable" }
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

    const result = await client.getFirstKillReports(key, { requestCap: 1 });
    expect(result).toEqual({ kind: "limitation", code: "schema_drift" });
    expect(JSON.stringify(result)).not.toContain("schema-envelope-marker");
    expect(JSON.stringify(result)).not.toContain("client-secret-marker");
  });
});
