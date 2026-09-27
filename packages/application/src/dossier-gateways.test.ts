import { createBlizzardClient } from "@slashwho/blizzard";
import { describe, expect, it, vi } from "vitest";

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
