import { describe, expect, it, vi } from "vitest";
import { createWarcraftLogsClient } from "./index";

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
      fetch: fetch as typeof globalThis.fetch,
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
          Number(variables.fightId)
        );
        if (variables.code === "unlinked") {
          unlinkedReads += 1;
          payload.data.reportData.report.rankedCharacters = null;
        }
        return Response.json(payload);
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch as typeof globalThis.fetch,
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
      fetch: fetch as typeof globalThis.fetch,
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
      fetch: fetch as typeof globalThis.fetch,
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
      fetch: fetch as typeof globalThis.fetch,
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

    const capped = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 4
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
      fetch: fetch as typeof globalThis.fetch,
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
          report(String(variables.code), Number(variables.fightId))
        );
      }
    );
    const client = createWarcraftLogsClient({
      fetch: fetch as typeof globalThis.fetch,
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
      fetch: fetch as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "secret"
    });
    const result = await client.getRankedKillReports(key, {
      journalRaidId: "946",
      requestCap: 6
    });
    expect(result).toMatchObject({ kind: "evidence", kills: [] });
  });
});
