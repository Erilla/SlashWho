import { describe, expect, it, vi } from "vitest";
import { rankedCharacterName } from "./decode/ranked-backfill";
import type { WarcraftLogsRankedBackfillCursor } from "./types";
import { createPlannedWarcraftLogsClient as createWarcraftLogsClient } from "./planned-client.test-support";

const key = { region: "eu", realm: "silvermoon", name: "ryun" } as const;
const report = (code: string, fightId: number, canonicalID = 40989140) => ({
  data: {
    reportData: {
      report: {
        code,
        startTime: Date.UTC(2018, 0, 1),
        owner: null,
        guild: null,
        zone: {
          id: 17,
          name: "Antorus, The Burning Throne",
          encounters: [{ id: 2092, journalID: 2032 }]
        },
        rankedCharacters: [
          {
            id: 1038562,
            canonicalID,
            name: "Erilla",
            server: { slug: "neptulon", name: "Neptulon" }
          }
        ] as Array<{
          id: number;
          canonicalID: number;
          name: string;
          server: { slug: string; name: string };
        }> | null,
        masterData: {
          actors: [
            { id: 7, name: "Erilla", server: "Neptulon", type: "Player" }
          ]
        },
        fights: [
          {
            id: fightId,
            encounterID: 2092,
            name: "Argus the Unmaker",
            startTime: 0,
            endTime: fightId * 1000,
            kill: true,
            difficulty: 5,
            friendlyPlayers: [7],
            friendlySpecs: [fightId === 11 ? "Discipline" : "Holy"],
            gameZone: { id: 999, name: "Antorus, The Burning Throne" }
          }
        ]
      }
    }
  }
});

// Each fixture report holds one ranked fight. The walk reads a report whole
// (#712), asking for no fight id, so fixtures answer by report code.
const rankedFightOf = (code: string): number =>
  code === "linked" || code === "secondReport" ? 11 : 10;

describe("ranked Mythic backfill", () => {
  it("excludes a post-content Antorus kill despite a canonical ranking", async () => {
    let reportReads = 0;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: { code: "lateArgus", fightID: 10 },
                        spec: "Holy"
                      }
                    ]
                  }
                }
              }
            }
          });
        reportReads += 1;
        const payload = report("lateArgus", 10);
        payload.data.reportData.report.startTime = Date.UTC(2020, 0, 1);
        return Response.json(payload);
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });

    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 4,
      cursor: {
        journalRaidId: "946",
        characterId: 40989140,
        zoneIds: [17],
        partitionIds: [1],
        zonesLoaded: true,
        zoneIndex: 0,
        encounterIds: [2092],
        encountersLoaded: true,
        encounterIndex: 0,
        metricIndex: 0,
        reportIndex: 0
      }
    });

    expect(result).toMatchObject({ kind: "evidence", kills: [] });
    if (result.kind !== "evidence") throw new Error("expected_evidence");
    expect(result.cursor).toBeUndefined();
    expect(reportReads).toBeGreaterThan(0);
  });

  it("skips a report with null ranked characters and continues to the next fight", async () => {
    let unlinkedReads = 0;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query, variables } = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, number | string>;
        };
        if (query.includes("HistoricRaidZones"))
          return Response.json({
            data: {
              worldData: {
                zones: [
                  {
                    id: 17,
                    name: "Antorus, The Burning Throne",
                    partitions: [{ id: 1 }]
                  }
                ]
              }
            }
          });
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 2 }] },
                  healing: { rankings: [{ encounterID: 2092, totalKills: 2 }] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: { code: "unlinked", fightID: 10 },
                        spec: "Holy"
                      },
                      {
                        report: { code: "linked", fightID: 11 },
                        spec: "Discipline"
                      }
                    ]
                  }
                }
              }
            }
          });
        const payload = report(
          String(variables.code),
          rankedFightOf(String(variables.code))
        );
        if (variables.code === "unlinked") {
          unlinkedReads += 1;
          payload.data.reportData.report.rankedCharacters = null;
        }
        return Response.json(payload);
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });

    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 8
    });
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        { fightUrl: "https://www.warcraftlogs.com/reports/linked#fight=11" }
      ]
    });
    if (result.kind !== "evidence") throw new Error("expected_evidence");
    expect(result.cursor).toBeUndefined();
    expect(unlinkedReads).toBe(1);
  });

  it("can accept the other metric when one rank's spec conflicts with the fight", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("HistoricRaidZones"))
          return Response.json({
            data: {
              worldData: {
                zones: [
                  {
                    id: 17,
                    name: "Antorus, The Burning Throne",
                    partitions: [{ id: 1 }]
                  }
                ]
              }
            }
          });
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 1 }] },
                  healing: { rankings: [{ encounterID: 2092, totalKills: 1 }] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: { code: "one", fightID: 10 },
                        spec: query.includes("metric: hps") ? "Shadow" : "Holy"
                      }
                    ]
                  }
                }
              }
            }
          });
        return Response.json(report("one", 10));
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });

    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 6
    });
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [{ fightUrl: "https://www.warcraftlogs.com/reports/one#fight=10" }]
    });
  });

  it("searches every zone partition for distinct historic fights", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query, variables } = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, number | string>;
        };
        if (query.includes("HistoricRaidZones"))
          return Response.json({
            data: {
              worldData: {
                zones: [
                  {
                    id: 17,
                    name: "Antorus, The Burning Throne",
                    partitions: [{ id: 1 }, { id: 2 }]
                  }
                ]
              }
            }
          });
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 1 }] },
                  healing: { rankings: [{ encounterID: 2092, totalKills: 1 }] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: {
                          code: variables.partition === 2 ? "late" : "early",
                          fightID: 10
                        },
                        spec: "Holy"
                      }
                    ]
                  }
                }
              }
            }
          });
        return Response.json(report(String(variables.code), 10));
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });

    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 9
    });
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        { fightUrl: "https://www.warcraftlogs.com/reports/early#fight=10" },
        { fightUrl: "https://www.warcraftlogs.com/reports/late#fight=10" }
      ]
    });
    const fromLegacyCursor = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 9,
      cursor: {
        journalRaidId: "946",
        characterId: 40989140,
        zoneIds: [17],
        zonesLoaded: true,
        zoneIndex: 0,
        encounterIds: [2092],
        encountersLoaded: true,
        encounterIndex: 0,
        metricIndex: 1,
        reportIndex: 0
      }
    });
    expect(fromLegacyCursor).toMatchObject({
      kind: "evidence",
      kills: [
        { fightUrl: "https://www.warcraftlogs.com/reports/early#fight=10" },
        { fightUrl: "https://www.warcraftlogs.com/reports/late#fight=10" }
      ]
    });
  });

  it("hydrates a fight once when both metrics rank it", async () => {
    let reportReads = 0;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("HistoricRaidZones"))
          return Response.json({
            data: {
              worldData: {
                zones: [
                  {
                    id: 17,
                    name: "Antorus, The Burning Throne",
                    partitions: [{ id: 1 }]
                  }
                ]
              }
            }
          });
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 1 }] },
                  healing: { rankings: [{ encounterID: 2092, totalKills: 1 }] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: { code: "sameFight", fightID: 10 },
                        spec: "Holy"
                      }
                    ]
                  }
                }
              }
            }
          });
        if (!query.includes("server { slug name }"))
          return Response.json({
            errors: [
              {
                message:
                  'Field "server" of type "Server!" must have a sub selection.'
              }
            ]
          });
        reportReads += 1;
        return Response.json(report("sameFight", 10));
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });

    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 5
    });
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [
        { fightUrl: "https://www.warcraftlogs.com/reports/sameFight#fight=10" }
      ]
    });
    if (result.kind !== "evidence") throw new Error("expected_evidence");
    expect(result.cursor).toBeUndefined();
    expect(reportReads).toBe(1);

    // The zone catalogue is kept from the first walk, so three requests
    // reach the same point: the zone's rankings, the damage ranking and the
    // report, stopping short of the healing ranking.
    const capped = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 3
    });
    if (capped.kind !== "evidence" || !capped.cursor)
      throw new Error("expected_capped_cursor");
    expect(reportReads).toBe(2);
    const resumed = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 1,
      cursor: capped.cursor
    });
    expect(resumed).toMatchObject({ kind: "evidence", kills: [] });
    if (resumed.kind !== "evidence") throw new Error("expected_resumed");
    expect(resumed.cursor).toBeUndefined();
    expect(reportReads).toBe(2);
  });

  it("retries zone discovery after a failed first lookup", async () => {
    let zoneCalls = 0;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("HistoricRaidZones")) {
          zoneCalls += 1;
          return Response.json({
            data: {
              worldData: {
                zones:
                  zoneCalls === 1
                    ? null
                    : [
                        {
                          id: 17,
                          name: "Antorus, The Burning Throne",
                          partitions: [{ id: 1 }]
                        }
                      ]
              }
            }
          });
        }
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 1 }] },
                  healing: { rankings: [] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: { code: "recovered", fightID: 10 },
                        spec: "Holy"
                      }
                    ]
                  }
                }
              }
            }
          });
        return Response.json(report("recovered", 10));
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });

    const first = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 1
    });
    expect(first).toMatchObject({
      kind: "evidence",
      cursor: { zonesLoaded: false },
      limitation: { code: "schema_drift" }
    });
    if (first.kind !== "evidence") throw new Error("expected_cursor");
    const resumed = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 4,
      cursor: first.cursor
    });
    expect(zoneCalls).toBe(2);
    expect(resumed).toMatchObject({
      kind: "evidence",
      kills: [
        { fightUrl: "https://www.warcraftlogs.com/reports/recovered#fight=10" }
      ]
    });
  });

  it("resumes at later reports under a cap and attributes an old alias by canonical ID", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query, variables } = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, number | string>;
        };
        requests.push(query);
        if (query.includes("HistoricRaidZones"))
          return Response.json({
            data: {
              worldData: {
                zones: [
                  {
                    id: 17,
                    name: "Antorus, The Burning Throne",
                    partitions: [{ id: 1 }]
                  }
                ]
              }
            }
          });
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 2 }] },
                  healing: { rankings: [{ encounterID: 2092, totalKills: 2 }] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: { code: "firstReport", fightID: 10 },
                        spec: "Holy"
                      },
                      {
                        report: { code: "secondReport", fightID: 11 },
                        spec: "Discipline"
                      }
                    ]
                  }
                }
              }
            }
          });
        return Response.json(
          report(String(variables.code), rankedFightOf(String(variables.code)))
        );
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });
    const first = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 4
    });
    expect(first).toMatchObject({
      kind: "evidence",
      kills: [
        {
          fightUrl: "https://www.warcraftlogs.com/reports/firstReport#fight=10"
        }
      ]
    });
    if (first.kind !== "evidence") throw new Error("expected_ranked_evidence");
    expect(first.cursor).toBeDefined();
    const second = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 2,
      cursor: first.cursor
    });
    expect(second).toMatchObject({
      kind: "evidence",
      kills: [
        {
          fightUrl: "https://www.warcraftlogs.com/reports/secondReport#fight=11"
        }
      ]
    });
    expect(requests).toHaveLength(6);
  });

  describe("a metric Warcraft Logs answers with an error object", () => {
    const zoneRankingsClient = (healing: unknown) =>
      createWarcraftLogsClient({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url
          );
          if (url.pathname === "/oauth/token")
            return Response.json({ access_token: "token", expires_in: 3600 });
          const { query, variables } = JSON.parse(String(init?.body)) as {
            query: string;
            variables: Record<string, number | string>;
          };
          if (query.includes("HistoricRaidZones"))
            return Response.json({
              data: {
                worldData: {
                  zones: [
                    {
                      id: 17,
                      name: "Antorus, The Burning Throne",
                      partitions: [{ id: 1 }]
                    }
                  ]
                }
              }
            });
          if (query.includes("HistoricZoneRankings"))
            return Response.json({
              data: {
                characterData: {
                  character: {
                    id: 40989140,
                    damage: {
                      rankings: [{ encounterID: 2092, totalKills: 1 }]
                    },
                    healing
                  }
                }
              }
            });
          if (query.includes("HistoricEncounterRankings"))
            return Response.json({
              data: {
                characterData: {
                  character: {
                    encounterRankings: query.includes("metric: hps")
                      ? null
                      : {
                          ranks: [
                            {
                              report: { code: "one", fightID: 10 },
                              spec: "Holy"
                            }
                          ]
                        }
                  }
                }
              }
            });
          return Response.json(
            report(
              String(variables.code),
              rankedFightOf(String(variables.code))
            )
          );
        },
        clientId: "id",
        clientSecret: "secret"
      });

    // Recorded from a live zone-rankings read (Ryzn, Tomb of Sargeras,
    // partition 1): the field carries the error in place of rankings, with no
    // GraphQL `errors` entry, for a character that does heal.
    it("reads the invalid class or spec error as not ranked in that metric", async () => {
      const result = await zoneRankingsClient({
        error: "Invalid class or spec number specified."
      }).getRankedKillReports(key, { journalRaidId: "946", requestCap: 6 });

      expect(result).toMatchObject({
        kind: "evidence",
        kills: [
          { fightUrl: "https://www.warcraftlogs.com/reports/one#fight=10" }
        ]
      });
      expect(result).not.toHaveProperty("limitation");
    });

    it("still reads any other error as schema drift", async () => {
      const result = await zoneRankingsClient({
        error: "Something else went wrong."
      }).getRankedKillReports(key, { journalRaidId: "946", requestCap: 6 });

      expect(result).toMatchObject({
        kind: "evidence",
        kills: [],
        limitation: { kind: "limitation", code: "schema_drift" }
      });
    });
  });

  it.each([
    ["a different canonical character", 999, Date.UTC(2018, 0, 1), "Holy"],
    [
      "a kill after the tier's content window",
      40989140,
      Date.UTC(2021, 0, 1),
      "Holy"
    ],
    ["a conflicting per-fight spec", 40989140, Date.UTC(2018, 0, 1), "Shadow"]
  ])("rejects %s", async (_reason, canonicalId, startTime, fightSpec) => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (query.includes("HistoricRaidZones"))
          return Response.json({
            data: {
              worldData: {
                zones: [
                  {
                    id: 17,
                    name: "Antorus, The Burning Throne",
                    partitions: [{ id: 1 }]
                  }
                ]
              }
            }
          });
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: { rankings: [{ encounterID: 2092, totalKills: 1 }] },
                  healing: null
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: query.includes("metric: hps")
                    ? null
                    : {
                        ranks: [
                          { report: { code: "one", fightID: 10 }, spec: "Holy" }
                        ]
                      }
                }
              }
            }
          });
        const payload = report("one", 10, canonicalId);
        payload.data.reportData.report.startTime = startTime;
        payload.data.reportData.report.fights[0]!.friendlySpecs = [fightSpec];
        return Response.json(payload);
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch,
      clientId: "id",
      clientSecret: "secret"
    });
    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 6
    });
    expect(result).toMatchObject({ kind: "evidence", kills: [] });
  });

  describe("zone selection", () => {
    // WCL files the opening Midnight raids under one zone whose name is no
    // raid's. Voidspire's first boss places it; Chimaerus belongs to Dreamrift.
    const combinedZone = {
      id: 46,
      name: "VS / DR / MQD",
      partitions: [{ id: 1 }],
      encounters: [
        { id: 3176, name: "Imperator Averzian" },
        { id: 3306, name: "Chimaerus the Undreamt God" }
      ]
    };
    const zones = [
      combinedZone,
      {
        id: 17,
        name: "Antorus, The Burning Throne",
        partitions: [{ id: 1 }],
        encounters: [
          { id: 2092, name: "Argus the Unmaker" },
          { id: 2063, name: "Aggramar" }
        ]
      },
      // Names another raid while listing an Antorus boss: its name decides.
      {
        id: 38,
        name: "Nerub-ar Palace",
        partitions: [{ id: 1 }],
        encounters: [{ id: 2092, name: "Argus the Unmaker" }]
      },
      // Names the tier's larger raid while ranking its sibling's boss too.
      {
        id: 53,
        name: "The Venomous Abyss",
        partitions: [{ id: 1 }],
        encounters: [
          { id: 3379, name: "Nymrissa Wavecaller" },
          { id: 3470, name: "Nek'zali the Soulcoiler" }
        ]
      },
      { id: 45, name: "Mythic+ Season 1", partitions: [{ id: 1 }] }
    ];
    const walk = (rankedEncounters: readonly number[]) => {
      const asked: { zones: number[]; encounters: number[] } = {
        zones: [],
        encounters: []
      };
      const fetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url
          );
          if (url.pathname === "/oauth/token")
            return Response.json({ access_token: "token", expires_in: 3600 });
          const { query, variables } = JSON.parse(String(init?.body)) as {
            query: string;
            variables: Record<string, number | string>;
          };
          if (query.includes("HistoricRaidZones"))
            return Response.json({ data: { worldData: { zones } } });
          if (query.includes("HistoricZoneRankings")) {
            asked.zones.push(Number(variables.zoneId));
            const rankings = rankedEncounters.map((id) => ({
              encounterID: id,
              totalKills: 1
            }));
            return Response.json({
              data: {
                characterData: {
                  character: {
                    id: 40989140,
                    damage: { rankings },
                    healing: { rankings }
                  }
                }
              }
            });
          }
          if (query.includes("HistoricEncounterRankings")) {
            const encounterId = Number(variables.encounterId);
            if (!asked.encounters.includes(encounterId))
              asked.encounters.push(encounterId);
            return Response.json({
              data: {
                characterData: {
                  character: {
                    encounterRankings: {
                      ranks: [
                        {
                          report: { code: "voidNight", fightID: 10 },
                          spec: "Holy"
                        }
                      ]
                    }
                  }
                }
              }
            });
          }
          const payload = report("voidNight", 10);
          const hydrated = payload.data.reportData.report;
          hydrated.startTime = Date.UTC(2026, 3, 1, 19);
          hydrated.zone = {
            id: 46,
            name: "VS / DR / MQD",
            encounters: [{ id: 3176, journalID: 0 }]
          };
          // A fight with no game zone falls back to the combined zone name,
          // so only the boss can place the kill.
          Object.assign(hydrated.fights[0]!, {
            encounterID: 3176,
            name: "Imperator Averzian",
            gameZone: null
          });
          return Response.json(payload);
        }
      );
      const client = createWarcraftLogsClient({
        fetch: fetch,
        clientId: "id",
        clientSecret: "secret"
      });
      return { asked, client };
    };

    it("walks a combined zone for the Voidspire, but only Voidspire bosses", async () => {
      const { asked, client } = walk([3176, 3306]);

      const result = await client.getRankedKillReports(key, {
        journalRaidId: "1307",
        requestCap: 20
      });

      expect(asked.zones).toEqual([46]);
      expect(asked.encounters).toEqual([3176]);
      expect(result).toMatchObject({
        kind: "evidence",
        kills: [
          {
            fightUrl: "https://www.warcraftlogs.com/reports/voidNight#fight=10",
            bossName: "Imperator Averzian",
            raidName: "VS / DR / MQD"
          }
        ]
      });
    });

    it("leaves an older single-raid tier's zones and encounters unchanged", async () => {
      // Ranked in a boss the zone list omits: a named zone is walked whole.
      const { asked, client } = walk([2063, 2092, 4000]);

      await client.getRankedKillReports(key, {
        journalRaidId: "946",
        requestCap: 20
      });

      expect(asked.zones).toEqual([17]);
      expect(asked.encounters).toEqual([2063, 2092, 4000]);
    });

    it("walks a sibling raid's zone for this raid's bosses only", async () => {
      // Break caught: zone 53 is named for The Venomous Abyss but also ranks
      // The Tidebound Grotto's Nymrissa Wavecaller. A zone naming another raid
      // was never taken, so a Tidebound walk could not reach her kills (#729).
      const { asked, client } = walk([3379, 3470]);

      await client.getRankedKillReports(key, {
        journalRaidId: "1317",
        requestCap: 20
      });

      expect(asked.zones).toEqual([53]);
      expect(asked.encounters).toEqual([3379]);
    });

    it("skips another raid's zone whose encounter list it cannot read", async () => {
      // Break caught in review: reading a sibling zone's bosses meant a
      // malformed list in any other raid's zone failed the whole walk, where
      // that zone had always been skipped unread.
      zones.push({
        id: 60,
        name: "Nerub-ar Palace",
        partitions: [{ id: 1 }],
        encounters: [{ id: 0, name: "" }]
      });
      try {
        const { asked, client } = walk([3379]);

        await client.getRankedKillReports(key, {
          journalRaidId: "1317",
          requestCap: 20
        });

        expect(asked.zones).toEqual([53]);
      } finally {
        zones.pop();
      }
    });
  });

  describe("limitation reporting", () => {
    // Break caught (tier-search run c2906a78, 2026-09-26): the walk ended
    // `schema_drift` on a decoder check whose HTTP request had succeeded, so
    // neither `onRequest` nor `onLimitation` named the zone-rankings read and
    // the run carried no `limitationQuery`.
    const antorus = {
      data: {
        worldData: {
          zones: [
            {
              id: 17,
              name: "Antorus, The Burning Throne",
              partitions: [{ id: 1 }]
            }
          ]
        }
      }
    };
    const zoneRankings = {
      data: {
        characterData: {
          character: {
            id: 40989140,
            damage: { rankings: [{ encounterID: 2092, totalKills: 1 }] },
            healing: { rankings: [] }
          }
        }
      }
    };
    const encounterRankings = {
      data: {
        characterData: {
          character: {
            encounterRankings: {
              ranks: [{ report: { code: "ranked", fightID: 10 }, spec: "Holy" }]
            }
          }
        }
      }
    };
    const clientAnswering = (answers: {
      zones?: unknown;
      zoneRankings?: unknown;
      report?: unknown;
    }) =>
      createWarcraftLogsClient({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url
          );
          if (url.pathname === "/oauth/token")
            return Response.json({ access_token: "token", expires_in: 3600 });
          const { query } = JSON.parse(String(init?.body)) as {
            query: string;
          };
          if (query.includes("HistoricRaidZones"))
            return Response.json(answers.zones ?? antorus);
          if (query.includes("HistoricZoneRankings"))
            return Response.json(answers.zoneRankings ?? zoneRankings);
          if (query.includes("HistoricEncounterRankings"))
            return Response.json(encounterRankings);
          return Response.json(answers.report ?? report("ranked", 10));
        },
        clientId: "id",
        clientSecret: "secret"
      });
    const walk = async (
      answers: Parameters<typeof clientAnswering>[0],
      requestCap = 10
    ) => {
      const onLimitation = vi.fn();
      const result = await clientAnswering(answers).getRankedKillReports(key, {
        journalRaidId: "946",
        requestCap,
        onLimitation
      });
      return { result, onLimitation };
    };

    it("names zone discovery when the zone list has drifted", async () => {
      const { result, onLimitation } = await walk({
        zones: { data: { worldData: { zones: null } } }
      });

      expect(result).toMatchObject({ limitation: { code: "schema_drift" } });
      expect(onLimitation.mock.calls).toEqual([
        ["zone_rankings", "schema_drift"]
      ]);
    });

    it("names the zone rankings when a character's encounters have drifted", async () => {
      const { result, onLimitation } = await walk({
        zoneRankings: { data: { characterData: { character: null } } }
      });

      expect(result).toMatchObject({ limitation: { code: "schema_drift" } });
      expect(onLimitation.mock.calls).toEqual([
        ["zone_rankings", "schema_drift"]
      ]);
    });

    it("names report hydration when a ranked report has drifted", async () => {
      const { result, onLimitation } = await walk({
        report: { data: { reportData: { report: { code: "someOther" } } } }
      });

      expect(result).toMatchObject({ limitation: { code: "schema_drift" } });
      expect(onLimitation.mock.calls).toEqual([
        ["report_hydration", "schema_drift"]
      ]);
    });

    it("names the query the request cap stopped", async () => {
      // Zones, zone rankings and one encounter ranking spend the cap, so the
      // report that ranking names is the read that goes unasked.
      const { result, onLimitation } = await walk({}, 3);

      expect(result).toMatchObject({ limitation: { code: "request_cap" } });
      expect(onLimitation.mock.calls).toEqual([
        ["report_hydration", "request_cap"]
      ]);
    });

    it("reports nothing for a walk that finishes", async () => {
      const { result, onLimitation } = await walk({});

      expect(result).toMatchObject({ kind: "evidence" });
      expect(result).not.toHaveProperty("limitation");
      expect(onLimitation).not.toHaveBeenCalled();
    });

    it("keeps its result when the observer throws", async () => {
      const result = await clientAnswering({
        zones: { data: { worldData: { zones: null } } }
      }).getRankedKillReports(key, {
        journalRaidId: "946",
        requestCap: 10,
        onLimitation: () => {
          throw new Error("observer");
        }
      });

      expect(result).toMatchObject({ limitation: { code: "schema_drift" } });
    });

    it("carries the ranked walk's limitation through the main collection", async () => {
      const onLimitation = vi.fn();
      const result = await clientAnswering({
        zoneRankings: { data: { characterData: { character: null } } }
      }).getFirstKillReports(key, {
        requestCap: 0,
        targetedOnly: true,
        parseRequestCap: 1,
        rankedBackfill: { journalRaidId: "946", requestCap: 10 },
        onLimitation
      });

      expect(result).toMatchObject({ limitation: { code: "schema_drift" } });
      expect(onLimitation.mock.calls).toEqual([
        ["zone_rankings", "schema_drift"]
      ]);
    });
  });

  describe("walking a tier's attendance only for a character who raided it (#733)", () => {
    // Break caught (#733): a dossier's tier search walked every connected
    // character's guild attendance back to 2017-2019 tiers, 406 pages in four
    // days, and hydrated nothing -- 13 of the 14 characters started raiding
    // years later. The ranked walk says, for a few requests, whether the
    // character raided the tier at all.
    const antorus = {
      data: {
        worldData: {
          zones: [
            {
              id: 17,
              name: "Antorus, The Burning Throne",
              partitions: [{ id: 1 }]
            }
          ]
        }
      }
    };
    const ranked = (kills: number) => ({
      data: {
        characterData: {
          character: {
            id: 40989140,
            damage: {
              rankings:
                kills > 0 ? [{ encounterID: 2092, totalKills: kills }] : []
            },
            healing: { rankings: [] }
          }
        }
      }
    });
    const encounterRankings = {
      data: {
        characterData: {
          character: {
            encounterRankings: {
              ranks: [{ report: { code: "ranked", fightID: 10 }, spec: "Holy" }]
            }
          }
        }
      }
    };
    const search = async (
      options: Readonly<{
        rankedKills: number;
        rankedCap?: number;
        raidedTier?: boolean;
        zoneRankings?: unknown;
        /** The name attendance lists the unranked night under. */
        unrankedListedAs?: string;
        formerNames?: readonly { name: string; realm: string }[];
        /** Reshapes the `unranked` report attendance hydrates. */
        unrankedReport?: (value: ReturnType<typeof report>) => void;
      }>
    ) => {
      const asked: string[] = [];
      const hydrated: string[] = [];
      const client = createWarcraftLogsClient({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url
          );
          if (url.pathname === "/oauth/token")
            return Response.json({ access_token: "token", expires_in: 3600 });
          const { query, variables } = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { code?: string };
          };
          asked.push(query.match(/query (\w+)/)?.[1] ?? "");
          if (query.includes("HistoricRaidZones"))
            return Response.json(antorus);
          if (query.includes("HistoricZoneRankings"))
            return Response.json(
              options.zoneRankings ?? ranked(options.rankedKills)
            );
          if (query.includes("HistoricEncounterRankings"))
            return Response.json(encounterRankings);
          if (query.includes("CharacterGuilds"))
            return Response.json({
              data: { characterData: { character: { guilds: [] } } }
            });
          if (query.includes("GuildAttendance"))
            return Response.json({
              data: {
                guildData: {
                  guild: {
                    attendance: {
                      data: [
                        {
                          code: "ranked",
                          startTime: Date.UTC(2018, 0, 1),
                          players: [{ name: "Ryun" }]
                        },
                        {
                          code: "unranked",
                          startTime: Date.UTC(2018, 0, 8),
                          players: [
                            { name: options.unrankedListedAs ?? "Ryun" }
                          ]
                        }
                      ],
                      has_more_pages: false
                    }
                  }
                }
              }
            });
          if (query.includes("ReportByCode")) {
            hydrated.push(variables.code!);
            // `ranked` holds the ranked walk's fight; `unranked` another.
            const value = report(
              variables.code!,
              variables.code === "ranked" ? 10 : 12
            );
            if (variables.code === "unranked") options.unrankedReport?.(value);
            return Response.json(value);
          }
          return Response.json(report("ranked", 10));
        },
        clientId: "id",
        clientSecret: "secret"
      });
      const result = await client.getFirstKillReports(key, {
        requestCap: 0,
        targetedOnly: true,
        parseRequestCap: 1,
        rankedBackfill: {
          journalRaidId: "946",
          requestCap: options.rankedCap ?? 10
        },
        tierSearch: {
          from: "2017-11-28T00:00:00.000Z",
          to: "2018-07-17T00:00:00.000Z",
          guilds: [{ name: "Guild", realm: "silvermoon", region: "eu" }],
          requestCap: 10,
          ...(options.raidedTier ? { raidedTier: true } : {}),
          ...(options.formerNames ? { formerNames: options.formerNames } : {})
        }
      });
      return { result, asked, hydrated };
    };

    it("walks no attendance for a character the finished ranked walk never found", async () => {
      const { result, asked } = await search({ rankedKills: 0 });

      expect(asked).not.toContain("GuildAttendance");
      expect(asked).not.toContain("CharacterGuilds");
      // Settled, so a continuation does not ask again.
      expect(result).toMatchObject({
        tierSearch: { outcome: "complete", requests: 0, guildsSearched: 0 }
      });
    });

    it("walks attendance once the ranked walk finds a kill", async () => {
      const { result, asked, hydrated } = await search({ rankedKills: 1 });

      expect(asked).toContain("GuildAttendance");
      // The ranked walk read only its one fight of `ranked`, so the whole
      // report is still read for its wipes and unranked kills.
      expect(hydrated).toEqual(["ranked", "unranked"]);
      expect(result).toMatchObject({ tierSearch: { guildsSearched: 1 } });
    });

    it("walks attendance when stored evidence already places the character in the tier", async () => {
      const { asked } = await search({ rankedKills: 0, raidedTier: true });

      expect(asked).toContain("GuildAttendance");
    });

    // The ranked fixture's character is ranked as Erilla of Neptulon and
    // collected as ryun of Silvermoon: renamed, as on #733's live case.
    it("recognises a night listed under the name the ranked walk proved", async () => {
      const { result, hydrated } = await search({
        rankedKills: 1,
        unrankedListedAs: "Erilla"
      });

      expect(hydrated).toEqual(["ranked", "unranked"]);
      expect(result).toMatchObject({
        kills: expect.arrayContaining([
          expect.objectContaining({
            fightUrl: "https://www.warcraftlogs.com/reports/unranked#fight=12"
          })
        ]),
        tierSearch: { recoveredKills: 1 }
      });
    });

    it("recognises a night listed under an explicit former name", async () => {
      // Stored evidence places the character in the tier, so the ranked walk
      // need find nothing for the walk to run.
      const { result, hydrated } = await search({
        rankedKills: 0,
        raidedTier: true,
        unrankedListedAs: "Erilla",
        formerNames: [{ name: "erilla", realm: "neptulon" }]
      });

      // The ranked walk found nothing here, so both nights are read. Each
      // report names the character only as Erilla of Neptulon, and each kill
      // is recovered under that name.
      expect(hydrated).toEqual(["ranked", "unranked"]);
      expect(result).toMatchObject({ tierSearch: { recoveredKills: 2 } });
    });

    it("credits no kill to a former name on another realm", async () => {
      // The night lists "Erilla", but the report's Erilla is of Kazzak: a
      // namesake, not the character's former self on Neptulon.
      const { result, hydrated } = await search({
        rankedKills: 0,
        raidedTier: true,
        unrankedListedAs: "Erilla",
        formerNames: [{ name: "erilla", realm: "neptulon" }],
        unrankedReport: (value) => {
          value.data.reportData.report.masterData.actors = [
            { id: 7, name: "Erilla", server: "Kazzak", type: "Player" }
          ];
        }
      });

      expect(hydrated).toContain("unranked");
      expect(result).toMatchObject({
        kills: expect.not.arrayContaining([
          expect.objectContaining({
            fightUrl: "https://www.warcraftlogs.com/reports/unranked#fight=12"
          })
        ])
      });
    });

    it("credits only the current name in a report that holds both names", async () => {
      // One character is one actor. A report naming both the current and a
      // former name as separate actors proves the former one is somebody
      // else, so only the current name's fights are the character's.
      const { result } = await search({
        rankedKills: 0,
        raidedTier: true,
        unrankedListedAs: "Ryun",
        formerNames: [{ name: "erilla", realm: "neptulon" }],
        unrankedReport: (value) => {
          const entry = value.data.reportData.report;
          entry.masterData.actors = [
            { id: 7, name: "Erilla", server: "Neptulon", type: "Player" },
            { id: 8, name: "Ryun", server: "Silvermoon", type: "Player" }
          ];
          const fight = entry.fights[0]!;
          entry.fights = [
            { ...fight, id: 12, friendlyPlayers: [8] },
            { ...fight, id: 13, friendlyPlayers: [7], endTime: 13_000 }
          ];
        }
      });

      const fights = (
        result as { kills: readonly { fightUrl: string }[] }
      ).kills.map((kill) => kill.fightUrl);
      expect(fights).toContain(
        "https://www.warcraftlogs.com/reports/unranked#fight=12"
      );
      expect(fights).not.toContain(
        "https://www.warcraftlogs.com/reports/unranked#fight=13"
      );
    });

    it("still rules out a night listing only somebody else", async () => {
      const { hydrated } = await search({
        rankedKills: 1,
        unrankedListedAs: "Stranger"
      });

      // `ranked` lists the current name; `unranked` only somebody else.
      expect(hydrated).toEqual(["ranked"]);
    });

    it("defers attendance while a capped ranked walk has found nothing yet", async () => {
      // Zones, zone rankings and the encounter ranking spend the cap, so the
      // walk stops before it can read the ranked report.
      const { result, asked } = await search({ rankedKills: 1, rankedCap: 3 });

      expect(asked).not.toContain("GuildAttendance");
      // Recorded as deferred, not left empty: the newest outcome is what a
      // continuation reads, and an empty one would let it read an earlier
      // press's `complete` as this one's.
      expect(result).toMatchObject({
        tierSearch: { outcome: "deferred", requests: 0 }
      });
    });

    it("walks attendance as before when the ranked walk fails for good", async () => {
      // Break caught in review of #735: `schema_drift` gets no retry, so a
      // deferral would never be continued, and the tier's attendance would
      // never be walked again.
      const { result, asked } = await search({
        rankedKills: 0,
        zoneRankings: { data: { characterData: { character: null } } }
      });

      expect(asked).toContain("GuildAttendance");
      expect(result).toMatchObject({ tierSearch: { guildsSearched: 1 } });
    });
  });
});

describe("the name a character was ranked under", () => {
  const rankedReport = (
    rankedCharacters: readonly {
      canonicalID: number;
      name: string;
      server: { slug: string };
    }[]
  ) => ({ data: { reportData: { report: { rankedCharacters } } } });

  it("is the one ranked character whose canonical id is the character's", () => {
    // Break caught in review of #736: taking the first ranked character still
    // passed every other test, and would have credited a guildmate's name.
    expect(
      rankedCharacterName(
        rankedReport([
          { canonicalID: 111, name: "Guildmate", server: { slug: "kazzak" } },
          {
            canonicalID: 40989140,
            name: "Erilla",
            server: { slug: "neptulon" }
          },
          { canonicalID: 222, name: "Other", server: { slug: "draenor" } }
        ]),
        40989140
      )
    ).toEqual({ name: "Erilla", realm: "neptulon" });
  });

  it("is unknown when no ranked character, or more than one, has that id", () => {
    const guildmate = {
      canonicalID: 111,
      name: "Guildmate",
      server: { slug: "kazzak" }
    };
    expect(rankedCharacterName(rankedReport([guildmate]), 40989140)).toBeNull();
    expect(
      rankedCharacterName(
        rankedReport([
          { ...guildmate, canonicalID: 40989140 },
          {
            canonicalID: 40989140,
            name: "Erilla",
            server: { slug: "neptulon" }
          }
        ]),
        40989140
      )
    ).toBeNull();
  });
});

describe("reading each ranked report once (#712)", () => {
  // A raid night holds several ranked bosses. Read once a fight, the same
  // report cost 2.1 points per ranked boss; read once, 2.1 in all (measured
  // 2026-09-28: 265 reads for 157 distinct reports across four tiers).
  const antorus = {
    data: {
      worldData: {
        zones: [
          {
            id: 17,
            name: "Antorus, The Burning Throne",
            partitions: [{ id: 1 }]
          }
        ]
      }
    }
  };
  const fight = (id: number, encounterID: number, name: string) => ({
    id,
    encounterID,
    name,
    startTime: id * 1000,
    endTime: id * 1000 + 500,
    kill: true,
    difficulty: 5,
    friendlyPlayers: [7],
    friendlySpecs: ["Holy"],
    gameZone: { id: 999, name: "Antorus, The Burning Throne" }
  });
  const walk = async (
    options: Readonly<{
      rankedCharacters?: null;
      requestCap?: number;
      cursor?: WarcraftLogsRankedBackfillCursor;
    }> = {}
  ) => {
    const reads: string[] = [];
    const client = createWarcraftLogsClient({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        );
        if (url.pathname === "/oauth/token")
          return Response.json({ access_token: "token", expires_in: 3600 });
        const { query, variables } = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, number | string>;
        };
        if (query.includes("HistoricRaidZones")) return Response.json(antorus);
        if (query.includes("HistoricZoneRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  id: 40989140,
                  damage: {
                    rankings: [
                      { encounterID: 2092, totalKills: 1 },
                      { encounterID: 2088, totalKills: 1 }
                    ]
                  },
                  healing: { rankings: [] }
                }
              }
            }
          });
        if (query.includes("HistoricEncounterRankings"))
          return Response.json({
            data: {
              characterData: {
                character: {
                  encounterRankings: {
                    ranks: [
                      {
                        report: {
                          code: "night",
                          fightID: variables.encounterId === 2092 ? 10 : 11
                        },
                        spec: "Holy"
                      }
                    ]
                  }
                }
              }
            }
          });
        reads.push(String(variables.code));
        const value = report("night", 10);
        const entry = value.data.reportData.report;
        entry.zone.encounters = [
          { id: 2092, journalID: 2032 },
          { id: 2088, journalID: 1987 },
          { id: 2069, journalID: 1983 }
        ];
        // A read that names one fight -- the per-fight read this replaced --
        // is answered with that fight alone.
        const fights = [
          fight(10, 2092, "Argus the Unmaker"),
          fight(11, 2088, "Kin'garoth"),
          // Killed that night, but not an encounter the character is ranked
          // on in this zone.
          fight(12, 2069, "Varimathras")
        ];
        entry.fights =
          typeof variables.fightId === "number"
            ? fights.filter(({ id }) => id === variables.fightId)
            : fights;
        if (options.rankedCharacters === null) entry.rankedCharacters = null;
        return Response.json(value);
      },
      clientId: "id",
      clientSecret: "secret"
    });
    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: options.requestCap ?? 20,
      ...(options.cursor ? { cursor: options.cursor } : {})
    });
    return { result, reads };
  };

  it("reads a report ranked for two bosses once, and credits both", async () => {
    const { result, reads } = await walk();

    expect(reads).toEqual(["night"]);
    expect(result).toMatchObject({ kind: "evidence" });
    const fights = (
      result as { kills: readonly { fightUrl: string }[] }
    ).kills.map((kill) => kill.fightUrl);
    expect(fights.sort()).toEqual([
      "https://www.warcraftlogs.com/reports/night#fight=10",
      "https://www.warcraftlogs.com/reports/night#fight=11"
    ]);
  });

  it("carries every fight the one read accepted in a capped walk's cursor", async () => {
    // Zones, zone rankings, the first boss's ranking and the report spend
    // the cap, so the walk stops before the second boss's ranking. The
    // fight that ranking names was accepted by the one read already.
    const capped = await walk({ requestCap: 4 });
    if (capped.result.kind !== "evidence") throw new Error("expected_evidence");
    const cursor = capped.result.cursor;

    expect(cursor?.acceptedFightKeys).toEqual(
      expect.arrayContaining(["night:10", "night:11"])
    );
    const resumed = await walk({ requestCap: 20, cursor: cursor! });
    expect(resumed.reads).toEqual([]);
  });

  it("reads a report that ranks nobody once, not once a ranked fight", async () => {
    // Tomb of Sargeras's reports carry no rankedCharacters, so no kill in
    // them can be proved; each was read again for every ranked fight (73
    // reads of 48 reports, crediting nothing).
    const { result, reads } = await walk({ rankedCharacters: null });

    expect(reads).toEqual(["night"]);
    expect(result).toMatchObject({ kind: "evidence", kills: [] });
    expect(result).not.toHaveProperty("limitation");
  });
});
