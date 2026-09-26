import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { upstreamThrottleRecord } from "@slashwho/application";
import { describe, expect, it } from "vitest";

import { dossierStartResponseSchema } from "@slashwho/contracts";

import {
  jsonNoStore,
  parseCharacterRoute,
  resolveCharacterRoute,
  startResultResponse,
  withHttpRequest
} from "./http";

const silentLogger = { info: () => {} };

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("resolveCharacterRoute", () => {
  const context = (params: {
    region: string;
    realm: string;
    name: string;
  }) => ({
    params: Promise.resolve(params)
  });

  it("refuses a non-canonical spelling when the route requires one", async () => {
    const result = await resolveCharacterRoute(
      context({ region: "EU", realm: "Silvermoon", name: "Ryii" }),
      { requireCanonical: true }
    );
    expect("refusal" in result).toBe(true);
    if (!("refusal" in result)) return;
    expect(result.refusal.status).toBe(400);
    expect(await errorCode(result.refusal)).toBe("invalid_character_url");
  });

  it("hands a non-canonical spelling back to a route that redirects it", async () => {
    const result = await resolveCharacterRoute(
      context({ region: "EU", realm: "Silvermoon", name: "Ryii" }),
      { requireCanonical: false }
    );
    expect(result).toEqual({
      key: { region: "eu", realm: "silvermoon", name: "ryii" },
      canonical: false
    });
  });

  it("refuses a name that cannot be decoded", async () => {
    const result = await resolveCharacterRoute(
      context({ region: "eu", realm: "silvermoon", name: "%E0%A4%A" }),
      { requireCanonical: false }
    );
    expect("refusal" in result).toBe(true);
  });
});

describe("jsonNoStore", () => {
  it("validates the body and marks it no-store alongside the caller's headers", async () => {
    const response = jsonNoStore(
      dossierStartResponseSchema,
      { kind: "ready" },
      { status: 201, headers: { location: "/elsewhere" } }
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe("/elsewhere");
    expect(await response.json()).toEqual({ kind: "ready" });
  });

  it("refuses a body its contract does not allow", () => {
    expect(() =>
      jsonNoStore(dossierStartResponseSchema, { kind: "ready", extra: 1 })
    ).toThrow();
  });
});

describe("startResultResponse", () => {
  const jobId = "54f14e37-7df7-43db-91d5-21e797d1d145";

  it("points a queued job at its status endpoint", async () => {
    const response = startResultResponse({
      kind: "job",
      jobId,
      status: "queued",
      statusUrl: `/api/dossiers/jobs/${jobId}`,
      characterUrl: "/characters/eu/silvermoon/ryii",
      staleCharacter: null,
      joinedExistingRun: false
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      `/api/dossiers/jobs/${jobId}`
    );
    expect(await response.json()).toEqual({
      kind: "job",
      jobId,
      status: "queued"
    });
  });

  it("carries a throttle's retry delay", async () => {
    const response = startResultResponse({
      kind: "rate_limited",
      retryAfterSeconds: 7
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
  });

  it("maps a refusal to its public error", async () => {
    const response = startResultResponse({
      kind: "not_found",
      code: "suppressed_character"
    });
    expect(await errorCode(response)).toBe("suppressed_character");
  });
});

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
  it("marks a response that names no caching policy no-store", async () => {
    // Break caught: a handler that forgets the header would let a proxy or
    // browser cache a dossier (CLAUDE.md: assembled dossiers are no-store).
    const json = await withHttpRequest(
      "dossier",
      async () => Response.json({ ok: true }),
      silentLogger
    );
    const redirect = await withHttpRequest(
      "dossier",
      async () =>
        new Response(null, {
          status: 308,
          headers: { location: "/elsewhere" }
        }),
      silentLogger
    );
    expect(json.headers.get("cache-control")).toBe("no-store");
    expect(redirect.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps a caching policy the handler chose", async () => {
    const response = await withHttpRequest(
      "dossier",
      async () =>
        Response.json(
          { ok: true },
          { headers: { "cache-control": "private, max-age=5" } }
        ),
      silentLogger
    );
    expect(response.headers.get("cache-control")).toBe("private, max-age=5");
  });

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
