import { expect, it, vi } from "vitest";
import { createRaiderIoClient } from "./client";
import unknownRanks from "../../../tests/fixtures/recorded/raiderio/guild-rankings-unknown-guild.json";
import unknownProfile from "../../../tests/fixtures/recorded/raiderio/guild-profile-unknown-guild.json";

// Minimized from Rancour's public website and guild-profile responses.
const ranks = {
  bossRankings: [
    { boss: "sszorak", ranks: { world: 276, region: 158 } },
    { boss: "entombed-sentinels", ranks: { world: 297 } },
    { boss: "the-twin-fangs", ranks: { world: 346 } }
  ]
};
const profile = {
  name: "Rancour",
  realm: "Draenor",
  region: "eu",
  raid_encounters: [
    { slug: "sszorak", defeatedAt: "2026-09-07T18:42:21Z" },
    { slug: "entombed-sentinels", defeatedAt: "2026-08-31T20:30:01Z" }
  ]
};
const options = {
  raidSlug: "the-venomous-abyss",
  bossSlug: "sszorak",
  guild: { name: "Rancour", realm: "draenor", region: "eu" }
};

it("loads guild boss world ranks beyond 50 and excludes undefeated attempts", async () => {
  const urls: URL[] = [];
  let physicalCalls = 0;
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return Response.json(
        url.pathname === "/api/guilds/raid-rankings" ? ranks : profile
      );
    }
  });
  expect(
    await client.getMythicBossRankings(
      options,
      undefined,
      () => physicalCalls++
    )
  ).toEqual({
    kind: "rankings",
    rows: [
      {
        bossSlug: "sszorak",
        rank: 276,
        guildName: "Rancour",
        guildRealm: "Draenor",
        guildRegion: "eu",
        firstDefeated: "2026-09-07T18:42:21Z"
      },
      {
        bossSlug: "entombed-sentinels",
        rank: 297,
        guildName: "Rancour",
        guildRealm: "Draenor",
        guildRegion: "eu",
        firstDefeated: "2026-08-31T20:30:01Z"
      }
    ]
  });
  expect(urls.map((url) => url.pathname).sort()).toEqual([
    "/api/guilds/raid-rankings",
    "/api/v1/guilds/profile"
  ]);
  expect(
    urls
      .find((url) => url.pathname.endsWith("profile"))
      ?.searchParams.get("fields")
  ).toBe("raid_encounters:the-venomous-abyss:mythic");
  // Break caught: reporting from the application wrapper can infer the two
  // reads without proving that the client actually sent them.
  expect(physicalCalls).toBe(2);
});

it("preserves schema drift as a limitation", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async () => Response.json({})
  });
  expect(await client.getMythicBossRankings(options)).toMatchObject({
    kind: "limitation",
    code: "schema_drift"
  });
});

const paths = ["/api/guilds/raid-rankings", "/api/v1/guilds/profile"];

it("distinguishes error-body transport failure from malformed JSON", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) => {
      if (new URL(String(input)).pathname !== paths[0])
        return Response.json(profile);
      const response = new Response("pending", { status: 422 });
      response.json = async () => {
        throw new TypeError("connection_reset");
      };
      return response;
    }
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "unavailable",
    failureCode: "network"
  });
});

it.each([403, 404])(
  "preserves guild %i Retry-After over a schema failure",
  async (status) => {
    const onThrottle = vi.fn();
    const client = createRaiderIoClient({
      baseUrl: "https://raider.io",
      timeoutMs: 1000,
      onThrottle,
      fetch: async (input) =>
        new URL(String(input)).pathname === paths[0]
          ? new Response("backoff", { status, headers: { "Retry-After": "8" } })
          : Response.json({})
    });
    expect(await client.getMythicBossRankings(options)).toEqual({
      kind: "limitation",
      code: "unavailable",
      failureCode: "throttled",
      retryAfterMs: 8000
    });
    expect(onThrottle).toHaveBeenCalledTimes(1);
  }
);

it.each(["reject", "late_literal"])(
  "counts an internal error-body timeout (%s)",
  async (mode) => {
    const client = createRaiderIoClient({
      baseUrl: "https://raider.io",
      timeoutMs: 1,
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname !== paths[0])
          return Response.json(profile);
        const response = new Response("pending", { status: 422 });
        response.json = () =>
          new Promise((resolve, reject) => {
            const aborted = () =>
              mode === "reject"
                ? reject(init?.signal?.reason)
                : resolve(unknownRanks.body);
            if (init?.signal?.aborted) aborted();
            else
              init?.signal?.addEventListener("abort", aborted, { once: true });
          });
        return response;
      }
    });
    expect(await client.getMythicBossRankings(options)).toEqual({
      kind: "limitation",
      code: "unavailable",
      failureCode: "timeout"
    });
  }
);

it("prefers a schema failure over a bare404 when both guild halves fail", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) =>
      new URL(String(input)).pathname === paths[0]
        ? new Response("missing", { status: 404 })
        : Response.json({})
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "schema_drift",
    failureCode: "schema"
  });
});

it.each([0, 1, 2])(
  "settles recorded guild no-match combination %i",
  async (failed) => {
    const client = createRaiderIoClient({
      baseUrl: "https://raider.io",
      timeoutMs: 1000,
      fetch: async (input) => {
        const index = paths.indexOf(new URL(String(input)).pathname);
        const fixture = index === 0 ? unknownRanks : unknownProfile;
        return failed === index || failed === 2
          ? Response.json(fixture.body, { status: fixture.status })
          : Response.json(index === 0 ? ranks : profile);
      }
    });
    expect(await client.getMythicBossRankings(options)).toEqual({
      kind: "limitation",
      code: "not_found",
      guildNotFound: true,
      failureCode: "not_found"
    });
  }
);

it.each([
  [503, false, "unavailable", "http_5xx"],
  [503, true, "unavailable", "http_5xx"],
  [429, false, "rate_limited", "throttled"],
  [429, true, "rate_limited", "throttled"]
] as const)(
  "preserves mixed %i failure, real-first=%s",
  async (status, realFirst, code, failureCode) => {
    const releases: Array<(response: Response) => void> = [];
    const client = createRaiderIoClient({
      baseUrl: "https://raider.io",
      timeoutMs: 1000,
      fetch: async (input) =>
        new Promise<Response>((resolve) => {
          releases[paths.indexOf(new URL(String(input)).pathname)] = resolve;
        })
    });
    const answer = client.getMythicBossRankings(options);
    const literal = Response.json(unknownRanks.body, {
      status: unknownRanks.status
    });
    const real = new Response("outage", {
      status,
      headers: status === 429 ? { "Retry-After": "9" } : {}
    });
    releases[realFirst ? 1 : 0]!(realFirst ? real : literal);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    releases[realFirst ? 0 : 1]!(realFirst ? literal : real);
    expect(await answer).toEqual({
      kind: "limitation",
      code,
      failureCode,
      ...(status === 429 ? { retryAfterMs: 9000 } : {})
    });
  }
);

it.each([false, true])(
  "keeps bare guild 404 retryable, literal partner=%s",
  async (literalPartner) => {
    const client = createRaiderIoClient({
      baseUrl: "https://raider.io",
      timeoutMs: 1000,
      fetch: async (input) =>
        new URL(String(input)).pathname === paths[0]
          ? new Response("<html>moved</html>", { status: 404 })
          : literalPartner
            ? Response.json(unknownProfile.body, { status: 400 })
            : Response.json(profile)
    });
    expect(await client.getMythicBossRankings(options)).toEqual({
      kind: "limitation",
      code: "unavailable",
      failureCode: "http_4xx"
    });
  }
);

it.each([400, 422])(
  "leaves unrelated %i messages transient",
  async (status) => {
    for (const body of [
      JSON.stringify({ message: "Could not find requested character" }),
      "not json",
      JSON.stringify({ message: "Could not find requested guild extra" })
    ]) {
      const client = createRaiderIoClient({
        baseUrl: "https://raider.io",
        timeoutMs: 1000,
        fetch: async (input) =>
          new URL(String(input)).pathname === paths[0]
            ? new Response(body, { status })
            : Response.json(profile)
      });
      expect(await client.getMythicBossRankings(options)).toEqual({
        kind: "limitation",
        code: "unavailable",
        failureCode: "http_4xx"
      });
    }
  }
);

it("keeps Retry-After on a literal response throttled", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async () =>
      Response.json(unknownProfile.body, {
        status: 400,
        headers: { "Retry-After": "12" }
      })
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "unavailable",
    failureCode: "throttled",
    retryAfterMs: 12000
  });
});

it("retains the largest delay across two throttled halves", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) =>
      new Response("throttle", {
        status: 429,
        headers: {
          "Retry-After":
            new URL(String(input)).pathname === paths[0] ? "3" : "11"
        }
      })
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "rate_limited",
    failureCode: "throttled",
    retryAfterMs: 11000
  });
});

it("breaks equal-priority failures by endpoint order", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) =>
      new Response("failure", {
        status: new URL(String(input)).pathname === paths[0] ? 400 : 503
      })
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "unavailable",
    failureCode: "http_4xx"
  });
});

it("propagates caller abort promptly with a pending uncooperative half", async () => {
  const controller = new AbortController();
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: async (input) =>
      new URL(String(input)).pathname === paths[0]
        ? Response.json(unknownRanks.body, { status: 422 })
        : new Promise<Response>(() => {})
  });
  const answer = client.getMythicBossRankings(options, controller.signal);
  controller.abort();
  await expect(answer).rejects.toBe(controller.signal.reason);
});

it("distinguishes its own timeout from network failure", async () => {
  const client = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true }
        )
      )
  });
  expect(await client.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "unavailable",
    failureCode: "timeout"
  });
  const offline = createRaiderIoClient({
    baseUrl: "https://raider.io",
    timeoutMs: 1000,
    fetch: vi.fn(async () => {
      throw new TypeError("offline");
    })
  });
  expect(await offline.getMythicBossRankings(options)).toEqual({
    kind: "limitation",
    code: "unavailable",
    failureCode: "network"
  });
});
