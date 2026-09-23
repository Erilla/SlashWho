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
          { id: 1038562, canonicalID, name: "Erilla", server: "Neptulon" }
        ],
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
                zones: [{ id: 17, name: "Antorus, The Burning Throne" }]
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
                zones: [{ id: 17, name: "Antorus, The Burning Throne" }]
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
