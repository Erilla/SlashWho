import { describe, expect, it, vi } from "vitest";

import {
  classifyResponse,
  createClientCredentialsTokenSource,
  createUpstreamError,
  isUpstreamFailure,
  retryAfterMs
} from "./index";

function response(status: number, headers: Record<string, string> = {}) {
  return new Response("", { status, headers });
}

describe("retryAfterMs", () => {
  it("reads delta-seconds and HTTP dates, and ignores anything else", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-26T12:00:00Z") });
    try {
      expect(retryAfterMs(response(429, { "Retry-After": "30" }))).toBe(30_000);
      expect(
        retryAfterMs(
          response(429, { "Retry-After": "Sat, 26 Sep 2026 12:01:00 GMT" })
        )
      ).toBe(60_000);
      expect(
        retryAfterMs(
          response(429, { "Retry-After": "Sat, 26 Sep 2026 11:00:00 GMT" })
        )
      ).toBe(0);
      expect(
        retryAfterMs(response(429, { "Retry-After": "soon" }))
      ).toBeUndefined();
      expect(retryAfterMs(response(429))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("classifyResponse", () => {
  it("reads 404 and 403 as final answers about the thing asked for", () => {
    const onThrottle = vi.fn();
    expect(
      classifyResponse(response(404, { "Retry-After": "5" }), onThrottle)
    ).toEqual({ kind: "not_found" });
    expect(classifyResponse(response(403), onThrottle)).toEqual({
      kind: "forbidden"
    });
    expect(onThrottle).not.toHaveBeenCalled();
  });

  it("reads a refused token as transient, never as forbidden", () => {
    // Break caught: #563 read our own refused token as a private character.
    expect(classifyResponse(response(401))).toEqual({
      kind: "transient",
      status: 401
    });
  });

  it("keeps Retry-After on any transient status and reports it as throttling", () => {
    const onThrottle = vi.fn();
    expect(
      classifyResponse(response(503, { "Retry-After": "30" }), onThrottle)
    ).toEqual({ kind: "transient", status: 503, retryAfterMs: 30_000 });
    expect(onThrottle).toHaveBeenCalledWith({ retryAfterMs: 30_000 });
  });

  it("reports a 429 without Retry-After, and nothing for a bare 500", () => {
    const onThrottle = vi.fn();
    classifyResponse(response(429), onThrottle);
    classifyResponse(response(500), onThrottle);
    expect(onThrottle.mock.calls).toEqual([[{ retryAfterMs: undefined }]]);
  });

  it("survives a throttle observer that throws", () => {
    expect(
      classifyResponse(response(429), () => {
        throw new Error("logger down");
      })
    ).toEqual({ kind: "transient", status: 429 });
  });
});

describe("isUpstreamFailure", () => {
  it("recognises provider errors and plain objects of the same shape", () => {
    expect(
      isUpstreamFailure(createUpstreamError("blizzard", { kind: "not_found" }))
    ).toBe(true);
    expect(isUpstreamFailure({ kind: "schema_drift" })).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isUpstreamFailure(new Error("boom"))).toBe(false);
    expect(isUpstreamFailure({ kind: "fingerprint_cap_reached" })).toBe(false);
    expect(isUpstreamFailure("not_found")).toBe(false);
    expect(isUpstreamFailure(null)).toBe(false);
  });

  it("names the provider and kind in the message, and nothing else", () => {
    expect(
      createUpstreamError("raiderio", { kind: "transient", status: 503 })
        .message
    ).toBe("raiderio_transient");
  });
});

describe("createClientCredentialsTokenSource", () => {
  const url = new URL("https://auth.test/oauth/token");

  function tokenResponse(value: string, expiresIn = 3_600) {
    return Response.json({ access_token: value, expires_in: expiresIn });
  }

  function source(fetch: typeof globalThis.fetch, onThrottle = vi.fn()) {
    return createClientCredentialsTokenSource({
      provider: "test",
      fetch,
      url,
      clientId: "id",
      clientSecret: "secret",
      onThrottle
    });
  }

  it("shares one request between concurrent callers and caches the token", async () => {
    const fetch = vi.fn(async () => tokenResponse("t1"));
    const tokens = source(fetch as unknown as typeof globalThis.fetch);

    await expect(
      Promise.all([tokens.token(), tokens.token()])
    ).resolves.toEqual(["t1", "t1"]);
    await expect(tokens.token()).resolves.toBe("t1");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again once the cached token is invalidated", async () => {
    let issued = 0;
    const tokens = source((async () =>
      tokenResponse(`t${++issued}`)) as unknown as typeof globalThis.fetch);

    await expect(tokens.token()).resolves.toBe("t1");
    tokens.invalidate("stale");
    await expect(tokens.token()).resolves.toBe("t1");
    tokens.invalidate("t1");
    await expect(tokens.token()).resolves.toBe("t2");
  });

  it("never reads a token-endpoint refusal as a statement about the thing asked for", async () => {
    for (const status of [403, 404]) {
      const tokens = source((async () =>
        response(status)) as unknown as typeof globalThis.fetch);
      await expect(tokens.token()).rejects.toMatchObject({
        message: "test_transient",
        kind: "transient",
        status
      });
    }
  });

  it("keeps a rate limit's Retry-After and reports it", async () => {
    const onThrottle = vi.fn();
    const tokens = source(
      (async () =>
        response(429, {
          "Retry-After": "12"
        })) as unknown as typeof globalThis.fetch,
      onThrottle
    );

    await expect(tokens.token()).rejects.toMatchObject({
      kind: "transient",
      status: 429,
      retryAfterMs: 12_000
    });
    expect(onThrottle).toHaveBeenCalledWith({ retryAfterMs: 12_000 });
  });

  it("reads a malformed token body as schema drift, and a network error as transient", async () => {
    await expect(
      source((async () =>
        Response.json({
          access_token: "t",
          expires_in: 0
        })) as unknown as typeof globalThis.fetch).token()
    ).rejects.toMatchObject({ kind: "schema_drift" });
    await expect(
      source((async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch).token()
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("throws the caller's own abort reason rather than an upstream failure", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    controller.abort(reason);
    const fetch = vi.fn(async () => tokenResponse("t1"));
    const tokens = source(fetch as unknown as typeof globalThis.fetch);

    await expect(tokens.token(controller.signal)).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the client credentials as HTTP Basic", async () => {
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("id:secret").toString("base64")}`
      });
      expect(init?.body).toBe("grant_type=client_credentials");
      return tokenResponse("t1");
    });
    await source(fetch as unknown as typeof globalThis.fetch).token();
    expect(fetch).toHaveBeenCalledWith(url.toString(), expect.anything());
  });
});
