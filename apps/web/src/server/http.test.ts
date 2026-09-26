import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { upstreamThrottleRecord } from "@slashwho/application";
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

  it("charges an upstream throttle to the request that hit it", async () => {
    // Break caught: the shared clients' onThrottle hook runs with no scope in
    // hand, so without the request's attribution the throttle would reach
    // only the standalone line and never this record (#508).
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (value: Record<string, unknown>) => records.push(value)
    };
    let throttleLine: Record<string, unknown> | undefined;

    await withHttpRequest(
      "dossier",
      async () => {
        throttleLine = upstreamThrottleRecord("blizzard", {
          retryAfterMs: 1_500
        });
        return Response.json({ ok: true });
      },
      logger
    );

    expect(records[0]).toMatchObject({
      blizzardThrottles: 1,
      blizzardRetryAfterMaxMs: 1_500
    });
    expect(throttleLine).toMatchObject({
      correlationId: records[0]!.correlationId
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

  it("returns a body the caller can still read after garbage collection", async () => {
    // Node's bundled undici ties a cloned response's finaliser to the
    // original's tee branch: collecting a discarded clone cancels the body
    // the caller has yet to read.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const logger = { info: () => {} };

    const response = await withHttpRequest(
      "register",
      async () => Response.json({ items: [1, 2] }, { status: 202 }),
      logger
    );
    gc();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ items: [1, 2] });
  });

  it("keeps the status, headers and counted items of a JSON response", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (value: Record<string, unknown>) => records.push(value)
    };
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");

    const response = await withHttpRequest(
      "list",
      async () =>
        Response.json(
          { items: [1, 2, 3] },
          { status: 201, statusText: "Created", headers }
        ),
      logger
    );

    expect(records[0]).toMatchObject({ status: 201, count: 3 });
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe(
      records[0]?.correlationId
    );
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/"
    ]);
    expect(await response.json()).toEqual({ items: [1, 2, 3] });
  });

  it("reports a JSON body that fails mid-read as a failed request", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = {
      info: (value: Record<string, unknown>) => records.push(value)
    };
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError("upstream reset"));
      }
    });

    const response = await withHttpRequest(
      "list",
      async () =>
        new Response(broken, {
          headers: { "content-type": "application/json" }
        }),
      logger
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe(
      records[0]?.correlationId
    );
    expect(records[0]).toMatchObject({ status: 500, errorName: "TypeError" });
  });
});
