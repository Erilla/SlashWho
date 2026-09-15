import { describe, expect, it } from "vitest";

import { parseCharacterRoute, withHttpRequest } from "./http";

describe("character route parsing", () => {
  it("accepts a percent-encoded Unicode name from the page route", () => {
    expect(
      parseCharacterRoute({
        region: "eu",
        realm: "silvermoon",
        name: "eldr%C3%ADtch"
      })
    ).toEqual({
      key: { region: "eu", realm: "silvermoon", name: "eldrítch" },
      canonical: true
    });
  });
});

describe("withHttpRequest", () => {
  it("folds the scope's totals into the emitted record", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (value: Record<string, unknown>) => records.push(value)
    };

    await withHttpRequest(
      "dossier",
      async (scope) => {
        scope.increment("cacheHits");
        await scope.time("blizzard", async () => "ok");
        return Response.json({ ok: true });
      },
      logger
    );

    expect(records[0]).toMatchObject({
      cacheHits: 1,
      blizzardCalls: 1
    });
  });

  it("marks a joined run as runJoined: true on the emitted record", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (value: Record<string, unknown>) => records.push(value)
    };

    await withHttpRequest(
      "dossier_start",
      async (scope) => {
        scope.mark("runJoined");
        return Response.json({ ok: true });
      },
      logger
    );

    expect(records[0]).toMatchObject({ runJoined: true });
  });

  it("omits runJoined entirely when the run was not joined", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (value: Record<string, unknown>) => records.push(value)
    };

    await withHttpRequest(
      "dossier_start",
      async () => Response.json({ ok: true }),
      logger
    );

    expect(records[0]).not.toHaveProperty("runJoined");
  });
});
