import { createBlizzardClient } from "@slashwho/blizzard";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MythicBossRankingsResult } from "@slashwho/raiderio";

import { createDossierGateways } from "./dossier-gateways";
import { createMeasurementScope } from "./measurement";

describe("createDossierGateways", () => {
  it("keeps time queued in the Blizzard limiter out of Blizzard's latency", async () => {
    // Break caught (#681 review): the web's shared Blizzard client queues
    // reads in its request limiter, and a read timed around the whole call
    // would count that queue as Blizzard's answer time, inflating
    // `blizzardMs`, `blizzardMaxCallMs` and the `blizzard` Server-Timing entry
    // while the wait itself went unreported.
    let now = 0;
    const releases: (() => void)[] = [];
    const fetch = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/token")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      await new Promise<void>((resolve) => releases.push(resolve));
      return Response.json({ achievements: [] });
    }) as typeof globalThis.fetch;
    const { gatewaysFor } = createDossierGateways({
      blizzard: createBlizzardClient({
        fetch,
        clientId: "client",
        clientSecret: "secret",
        requestLimits: { maxConcurrent: 1, maxPerSecond: 20 }
      }),
      raiderio: { getMythicBossRankings: vi.fn() },
      config: {
        NEGATIVE_CACHE_TTL_MS: 300_000,
        DOSSIER_PROVIDER_CONCURRENCY: 4
      },
      monotonic: () => now
    });
    const scope = createMeasurementScope(() => now);
    const { blizzard } = gatewaysFor(undefined, scope);

    const first = blizzard.getCompletedAchievements({
      region: "eu",
      realm: "silvermoon",
      name: "sentinela"
    });
    const second = blizzard.getCompletedAchievements({
      region: "eu",
      realm: "silvermoon",
      name: "sentinelb"
    });
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    // The first read answers after 200 ms; the second spent those 200 ms
    // queued behind it and then answers at once.
    now = 200;
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    await Promise.all([first, second]);

    expect(scope.totals()).toMatchObject({
      blizzardMs: 200,
      blizzardCalls: 2,
      blizzardMaxCallMs: 200,
      blizzardLimiterWaitMs: 200
    });
  });
});

describe("rankings failure attribution", () => {
  afterEach(() => vi.restoreAllMocks());
  const request = {
    raidSlug: "nerub-ar-palace",
    bossSlug: "queen-ansurek",
    guild: { name: "PRIVATE_GUILD", realm: "silvermoon", region: "eu" }
  };
  const build = (
    getMythicBossRankings: (
      request: unknown,
      signal?: AbortSignal
    ) => Promise<MythicBossRankingsResult>
  ) =>
    createDossierGateways({
      blizzard: { getCompletedAchievements: async () => [] },
      raiderio: { getMythicBossRankings },
      config: {
        NEGATIVE_CACHE_TTL_MS: 300_000,
        DOSSIER_PROVIDER_CONCURRENCY: 4
      }
    });

  it("negative-caches confirmed no-match and expires without losing its marker", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const load = vi.fn(async () => ({
      kind: "limitation" as const,
      code: "not_found" as const,
      guildNotFound: true as const,
      failureCode: "not_found" as const
    }));
    const { gatewaysFor } = build(load);
    const first = createMeasurementScope();
    const second = createMeasurementScope();
    expect(
      await gatewaysFor(undefined, first).raiderio.getMythicBossRankings(
        request
      )
    ).toMatchObject({ guildNotFound: true });
    now = 299_999;
    expect(
      await gatewaysFor(undefined, second).raiderio.getMythicBossRankings(
        request
      )
    ).toMatchObject({ guildNotFound: true });
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.totals()).toMatchObject({
      raiderIoRankingsFailureNotFound: 1
    });
    expect(second.totals()).toMatchObject({
      cacheHits: 1,
      raiderIoRankingsFailureNotFound: 1
    });
    now = 300_000;
    await gatewaysFor().raiderio.getMythicBossRankings(request);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("counts a shared gateway timeout once on each waiting scope", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const load = vi.fn(
      async (_request: unknown, signal?: AbortSignal) =>
        new Promise<MythicBossRankingsResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        })
    );
    const { gatewaysFor } = build(load);
    const scopes = [createMeasurementScope(), createMeasurementScope()];
    const answers = scopes.map((scope) =>
      gatewaysFor(undefined, scope).raiderio.getMythicBossRankings(request)
    );
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    timeout.abort(new DOMException("PRIVATE_BODY", "TimeoutError"));
    for (const result of await Promise.all(answers))
      expect(result).toMatchObject({
        code: "unavailable",
        failureCode: "timeout"
      });
    for (const scope of scopes)
      expect(scope.totals()).toMatchObject({
        raiderIoRankingsFailureTimeout: 1
      });
  });

  it("counts unwrapped rejections as network without retaining their payload", async () => {
    const { gatewaysFor } = build(async () => {
      throw new Error("https://secret/PRIVATE_GUILD PRIVATE_BODY");
    });
    const scope = createMeasurementScope();
    const result = await gatewaysFor(
      undefined,
      scope
    ).raiderio.getMythicBossRankings(request);
    expect(result).toMatchObject({
      code: "unavailable",
      failureCode: "network"
    });
    expect(scope.totals()).toMatchObject({ raiderIoRankingsFailureNetwork: 1 });
    expect(JSON.stringify([result, scope.totals()])).not.toMatch(
      /PRIVATE_|https:/
    );
  });

  it.each([true, false])(
    "propagates caller abort uncounted, before load=%s",
    async (before) => {
      const controller = new AbortController();
      const { gatewaysFor } = build(
        async () => new Promise<MythicBossRankingsResult>(() => {})
      );
      const scope = createMeasurementScope();
      if (before) controller.abort();
      const answer = gatewaysFor(
        undefined,
        scope
      ).raiderio.getMythicBossRankings(request, controller.signal);
      if (!before) controller.abort();
      await expect(answer).rejects.toBe(controller.signal.reason);
      expect(
        Object.keys(scope.totals()).filter((key) =>
          key.startsWith("raiderIoRankingsFailure")
        )
      ).toEqual([]);
    }
  );

  it("keeps bare404 retryable on cache replay and separates mixed failure classes", async () => {
    const load = vi.fn(async () => ({
      kind: "limitation" as const,
      code: "unavailable" as const,
      failureCode: "http_4xx" as const
    }));
    const { gatewaysFor } = build(load);
    const scope = createMeasurementScope();
    const gateway = gatewaysFor(undefined, scope).raiderio;
    for (let index = 0; index < 2; index++)
      expect(await gateway.getMythicBossRankings(request)).not.toHaveProperty(
        "guildNotFound"
      );
    expect(load).toHaveBeenCalledTimes(1);
    const visitor = gatewaysFor(
      {
        raiderio: {
          getCharacter: vi.fn(),
          getMythicBossRankings: async () => ({
            kind: "limitation",
            code: "rate_limited",
            failureCode: "throttled"
          })
        }
      },
      scope
    );
    await visitor.raiderio.getMythicBossRankings(request);
    expect(scope.totals()).toMatchObject({
      raiderIoRankingsFailureHttp4xx: 2,
      raiderIoRankingsFailureThrottled: 1
    });
  });
});
