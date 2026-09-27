import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it } from "vitest";

import { createWarcraftLogsClient } from "./client";
import type { WarcraftLogsCollectionPlan } from "./types";

const key: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "sentinel"
};

// Plans no parse work, so each run's requests are the history scan's alone.
const plan: WarcraftLogsCollectionPlan = {
  tierZones: () => ({ zones: [], unreached: [] }),
  parseGroups: () => ({
    groups: [],
    raidIds: new Map(),
    fightUrls: new Map()
  })
};

const actors = [
  { id: 7, name: "Sentinel", server: "Silvermoon", type: "Player" },
  { id: 8, name: "Other", server: "Silvermoon", type: "Player" }
];

function report(
  code: string,
  fights: readonly Readonly<{
    id: number;
    encounterID: number;
    difficulty: number;
    kill?: boolean;
  }>[]
) {
  return {
    code,
    startTime: 1_736_800_000_000,
    owner: { name: "Uploader" },
    guild: {
      name: "Arachnid",
      server: { slug: "silvermoon", region: { slug: "EU" } }
    },
    zone: { id: 38, name: "Nerub-ar Palace", encounters: [] },
    fights: fights.map((fight) => ({
      name: "Boss",
      startTime: 60_000,
      endTime: 360_000,
      kill: true,
      friendlyPlayers: [7, 8],
      gameZone: { id: 38, name: "Nerub-ar Palace" },
      ...fight
    }))
  };
}

type Sent = Readonly<{ query: string; variables: Record<string, unknown> }>;

function harness(
  pages: readonly unknown[][],
  answerActors: (codes: readonly string[]) => Response = (codes) =>
    json({
      data: {
        reportData: Object.fromEntries(
          codes.map((code, index) => [
            `report${index}`,
            { code, masterData: { actors } }
          ])
        )
      }
    })
) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    );
    if (url.pathname === "/oauth/token") {
      return json({ access_token: "token", expires_in: 3600 });
    }
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    if (body.query.includes("query ReportActors")) {
      return answerActors(Object.values(body.variables).map(String));
    }
    const page = Number(body.variables.page);
    const reports = pages[page - 1] ?? [];
    return json({
      data: {
        characterData: {
          character: {
            server: { normalizedName: "silvermoon" },
            recentReports: {
              data: reports,
              has_more_pages: page < pages.length
            }
          }
        }
      }
    });
  };
  const client = createWarcraftLogsClient({
    fetch,
    clientId: "id",
    clientSecret: "secret"
  });
  return { client, sent };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("history pages load actors only where evidence can be", () => {
  it("never asks a history page for actors", async () => {
    // Break caught: a page that selects `masterData` pays a point for every
    // report on it, most of which hold no Mythic fight to attribute (#712).
    const { client, sent } = harness([[report("mythic", [])]]);

    await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 1,
      plan
    });

    const page = sent.find((body) => body.query.includes("RecentReports"));
    expect(page?.query).not.toContain("masterData");
  });

  it("asks for the actors of only the reports holding a Mythic encounter", async () => {
    const { client, sent } = harness([
      [
        report("mythicNight", [{ id: 1, encounterID: 2902, difficulty: 5 }]),
        report("heroicNight", [{ id: 1, encounterID: 2902, difficulty: 4 }]),
        report("mythicTrash", [{ id: 1, encounterID: 0, difficulty: 5 }]),
        report("secondMythic", [
          { id: 1, encounterID: 2902, difficulty: 4 },
          { id: 2, encounterID: 2917, difficulty: 5, kill: false }
        ])
      ]
    ]);

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 1,
      plan
    });

    const follow = sent.filter((body) => body.query.includes("ReportActors"));
    expect(follow).toHaveLength(1);
    expect(Object.values(follow[0]!.variables)).toEqual([
      "mythicNight",
      "secondMythic"
    ]);
    expect(result).toMatchObject({
      kind: "evidence",
      kills: [{ reportCode: "mythicNight", fightId: 1 }],
      wipes: [{ fightUrl: expect.stringContaining("secondMythic#fight=2") }]
    });
  });

  it("sends no follow-up for a page with no Mythic encounter", async () => {
    const { client, sent } = harness([
      [report("dungeons", [{ id: 1, encounterID: 12_660, difficulty: 10 }])]
    ]);

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 1,
      plan
    });

    expect(sent.map((body) => body.query.includes("ReportActors"))).toEqual([
      false
    ]);
    expect(result).not.toMatchObject({ limitation: expect.anything() });
  });

  it("spends none of the history cap on the follow-up", async () => {
    // Break caught: counting the follow-up as a page halves how deep a capped
    // scan reaches, which withholds kills a run used to find.
    const pages = [1, 2, 3].map((page) => [
      report(`night${page}`, [{ id: 1, encounterID: 2902, difficulty: 5 }])
    ]);
    const { client, sent } = harness(pages);
    const queries: string[] = [];

    const result = await client.getFirstKillReports(key, {
      requestCap: 3,
      parseRequestCap: 1,
      plan,
      onRequest: (event) => queries.push(event.query)
    });

    expect(
      sent.filter((body) => body.query.includes("RecentReports"))
    ).toHaveLength(3);
    expect(queries).toEqual([
      "history_scan",
      "history_actors",
      "history_scan",
      "history_actors",
      "history_scan",
      "history_actors"
    ]);
    expect(result).toMatchObject({
      kills: [
        { reportCode: "night1" },
        { reportCode: "night2" },
        { reportCode: "night3" }
      ]
    });
  });

  it("limits the scan when the follow-up is refused", async () => {
    const { client } = harness(
      [[report("mythicNight", [{ id: 1, encounterID: 2902, difficulty: 5 }])]],
      () => new Response("", { status: 503 })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 1,
      plan
    });

    expect(result).toMatchObject({ code: "unavailable" });
  });

  it("reads a report the follow-up does not answer for as drift, not absence", async () => {
    // Break caught: a report missing from the answer would otherwise read as
    // one the character never took part in, and a complete publish would drop
    // the kills stored from it.
    const { client } = harness(
      [[report("mythicNight", [{ id: 1, encounterID: 2902, difficulty: 5 }])]],
      () => json({ data: { reportData: { report0: null } } })
    );

    const result = await client.getFirstKillReports(key, {
      requestCap: 1,
      parseRequestCap: 1,
      plan
    });

    expect(result).toMatchObject({ code: "schema_drift" });
  });
});
