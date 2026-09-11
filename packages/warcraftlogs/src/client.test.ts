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

  it("paginates public reports and keeps the earliest Mythic kill per encounter", async () => {
    // Break caught: later report pages could be ignored, leaving a later kill as
    // the applicant's claimed first kill.
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
        variables: {
          name: string;
          realm: string;
          region: string;
          page: number;
        };
      };
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
      reports: [
        {
          encounterId: 1234,
          killedAt: "2024-02-03T01:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/earlyReport",
          fightUrl: "https://www.warcraftlogs.com/reports/earlyReport#fight=7"
        },
        {
          encounterId: 4321,
          killedAt: "2024-02-04T02:00:00.000Z",
          reportUrl: "https://www.warcraftlogs.com/reports/secondBoss",
          fightUrl: "https://www.warcraftlogs.com/reports/secondBoss#fight=2"
        }
      ]
    });
    expect(fetch).toHaveBeenCalledTimes(3);
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
    ).resolves.toEqual({ kind: "limitation", code: "request_cap" });
    expect(fetch).toHaveBeenCalledTimes(2);
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
