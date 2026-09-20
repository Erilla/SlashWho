import { describe, expect, it, vi } from "vitest";

import { readCredentialOverrides } from "./credential-headers";
import { loadWebConfig } from "./config";
import { webLogger } from "./logger";

const config = loadWebConfig({
  DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
  BOT_API_KEY: "b".repeat(32),
  RATE_LIMIT_HASH_SECRET: "r".repeat(32),
  BLIZZARD_CLIENT_ID: "blizzard-client-id",
  BLIZZARD_CLIENT_SECRET: "blizzard-client-secret",
  EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64)
});

describe("readCredentialOverrides", () => {
  it("returns no overrides when no credential headers are present", () => {
    // Break caught: a route could construct gateways even when a visitor
    // supplied no credentials, spending unnecessary work per request.
    const overrides = readCredentialOverrides(new Headers(), config);
    expect(overrides.blizzard).toBeUndefined();
    expect(overrides.raiderio).toBeUndefined();
    expect(overrides.wclCredentials).toBeUndefined();
  });

  it("builds a Blizzard gateway when both header values are present", () => {
    // Break caught: a visitor-supplied Blizzard client id/secret pair could
    // be silently ignored instead of overriding the shared gateway.
    const headers = new Headers({
      "x-blizzard-client-id": "user-id",
      "x-blizzard-client-secret": "user-secret"
    });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.blizzard).toBeDefined();
  });

  it("ignores a Blizzard header pair with only one value present", () => {
    // Break caught: a partial credential pair could be treated as complete
    // and used to build a gateway with an undefined secret.
    const headers = new Headers({ "x-blizzard-client-id": "user-id" });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.blizzard).toBeUndefined();
  });

  it("passes the Raider.IO access key through unchanged", () => {
    // Break caught: a visitor-supplied Raider.IO access key could be dropped
    // instead of being attached to outgoing requests.
    const headers = new Headers({ "x-raiderio-access-key": "user-key" });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.raiderio).toBeDefined();
  });

  it("reports an upstream throttle from a visitor's own gateway without naming the credential", async () => {
    // Break caught: a per-request client built from a visitor's own key could
    // be constructed without the throttle callback the shared clients carry,
    // making throttling of a visitor's key invisible. The record must also
    // never carry the key that provoked it.
    const records: Array<Record<string, unknown>> = [];
    const infoSpy = vi
      .spyOn(webLogger, "info")
      .mockImplementation((record: unknown) => {
        records.push(record as Record<string, unknown>);
      });
    try {
      // The client captures globalThis.fetch at construction, so the stub has
      // to be in place before the override is built.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("", { status: 429, headers: { "Retry-After": "3" } })
      );
      const headers = new Headers({ "x-raiderio-access-key": "user-key" });
      const overrides = readCredentialOverrides(headers, config);

      // Reporting the throttle must not change the limitation returned to the
      // caller.
      await expect(
        overrides.raiderio!.getMythicBossRankings({
          raidSlug: "nerubar-palace",
          bossSlug: "queen-ansurek"
        })
      ).resolves.toEqual({
        kind: "limitation",
        code: "rate_limited",
        retryAfterMs: 3000
      });

      expect(records).toContainEqual(
        expect.objectContaining({
          event: "upstream_throttle",
          provider: "raiderio",
          retryAfterMs: 3000
        })
      );
      expect(JSON.stringify(records)).not.toContain("user-key");
    } finally {
      infoSpy.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it("prefers a visitor's Raider.IO key over the server's configured key", async () => {
    // Break caught: a visitor who supplies their own key could still spend the
    // server's rate-limit budget, defeating the point of visitor-supplied
    // credentials. The visitor key wins; the server key is only the fallback.
    const configWithServerKey = loadWebConfig({
      DATABASE_URL: "postgresql://slashwho:secret@db.internal/slashwho",
      BOT_API_KEY: "b".repeat(32),
      RATE_LIMIT_HASH_SECRET: "r".repeat(32),
      BLIZZARD_CLIENT_ID: "blizzard-client-id",
      BLIZZARD_CLIENT_SECRET: "blizzard-client-secret",
      EVIDENCE_JOB_CREDENTIAL_ENCRYPTION_KEY: "a".repeat(64),
      RAIDER_IO_ACCESS_KEY: "server-key"
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: "Ryii" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    try {
      // The client captures globalThis.fetch at construction, so the stub has
      // to be in place before the override is built.
      vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
      const headers = new Headers({ "x-raiderio-access-key": "visitor-key" });
      const overrides = readCredentialOverrides(headers, configWithServerKey);

      await overrides.raiderio!.getMythicBossRankings({
        raidSlug: "nerubar-palace",
        bossSlug: "queen-ansurek"
      });

      const url = new URL((fetchMock.mock.calls[0]![0] as URL).toString());
      expect(url.pathname).toBe("/api/v1/raiding/boss-rankings");
      expect(url.searchParams.get("access_key")).toBe("visitor-key");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("returns WCL credentials as plain data, not a gateway", () => {
    // Break caught: WCL credentials could be built into a gateway here even
    // though only the worker (Task 7) has the decrypted values it needs.
    const headers = new Headers({
      "x-wcl-client-id": "user-id",
      "x-wcl-client-secret": "user-secret"
    });
    const overrides = readCredentialOverrides(headers, config);
    expect(overrides.wclCredentials).toEqual({
      clientId: "user-id",
      clientSecret: "user-secret"
    });
  });
});
