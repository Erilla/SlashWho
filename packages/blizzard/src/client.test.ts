import type { CharacterKey } from "@slashwho/domain";
import { describe, expect, it, vi } from "vitest";

import { createBlizzardClient } from "./index";

const key: CharacterKey = {
  region: "eu",
  realm: "silvermoon",
  name: "sentinel"
};

function clientFor(
  responder: (url: URL, init?: RequestInit) => Response | Promise<Response>
) {
  const fetchSpy = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      responder(
        new URL(
          typeof input === "string" || input instanceof URL ? input : input.url
        ),
        init
      )
  );
  return {
    fetchSpy,
    gateway: createBlizzardClient({
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "secret"
    })
  };
}

function tokenResponse(): Response {
  return Response.json({
    access_token: "private-access-token",
    expires_in: 3600
  });
}

describe("Blizzard gateway", () => {
  it("uses an explicitly configured endpoint for local integration fixtures", async () => {
    // Break caught: e2e sweeps could send test credentials to the public
    // Blizzard endpoints even when the test suite provides a local fixture.
    const endpoints: string[] = [];
    const gateway = createBlizzardClient({
      fetch: (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        endpoints.push(url.toString());
        return url.pathname === "/token"
          ? tokenResponse()
          : Response.json({ achievements: [] });
      }) as typeof globalThis.fetch,
      clientId: "id",
      clientSecret: "secret",
      baseUrl: "http://127.0.0.1:43101"
    });

    await expect(gateway.getAchievementFingerprint(key)).resolves.toEqual(
      new Map()
    );
    expect(endpoints).toEqual([
      "http://127.0.0.1:43101/token",
      "http://127.0.0.1:43101/profile/wow/character/silvermoon/sentinel/achievements?namespace=profile-eu&locale=en_GB"
    ]);
  });

  it("uses the root region profile API and normalizes the current guild roster", async () => {
    // Break caught: roster requests could cross regions or leak upstream member
    // shapes into discovery snapshots.
    const { gateway } = clientFor((url) => {
      if (url.hostname === "oauth.battle.net") return tokenResponse();
      if (url.pathname.endsWith("/character/silvermoon/sentinel")) {
        return Response.json({
          guild: { name: "A Guild", realm: { slug: "silvermoon" } }
        });
      }
      if (url.pathname.endsWith("/guild/silvermoon/a-guild/roster")) {
        return Response.json({
          members: [
            {
              character: {
                name: "Alt",
                realm: { slug: "Silvermoon" },
                playable_class: { name: "Mage" },
                level: 80
              }
            }
          ]
        });
      }
      throw new Error(`unexpected endpoint: ${url.pathname}`);
    });

    const onProfileRequest = vi.fn();
    await expect(gateway.getGuildRoster(key, undefined, onProfileRequest)).resolves.toEqual([
      {
        key: { region: "eu", realm: "silvermoon", name: "alt" },
        displayName: "Alt",
        className: "Mage",
        level: 80
      }
    ]);
    expect(onProfileRequest).toHaveBeenCalledTimes(2);
  });

  it("returns an empty roster when the root has no guild", async () => {
    const { gateway } = clientFor((url) => {
      if (url.hostname === "oauth.battle.net") return tokenResponse();
      return Response.json({});
    });

    await expect(gateway.getGuildRoster(key)).resolves.toEqual([]);
  });

  it("extracts only numeric achievement pairs and caches the process token", async () => {
    // Break caught: malformed achievement entries could reach comparison, or a
    // token request could be made per character.
    const { fetchSpy, gateway } = clientFor((url) => {
      if (url.hostname === "oauth.battle.net") return tokenResponse();
      return Response.json({
        achievements: [
          { id: 1, completed_timestamp: 100 },
          { id: "2", completed_timestamp: 200 },
          { id: 3, completed_timestamp: "300" }
        ]
      });
    });

    await expect(gateway.getAchievementFingerprint(key)).resolves.toEqual(
      new Map([[1, 100]])
    );
    await expect(gateway.getAchievementFingerprint(key)).resolves.toEqual(
      new Map([[1, 100]])
    );
    expect(
      fetchSpy.mock.calls.filter(
        ([input]) => new URL(String(input)).hostname === "oauth.battle.net"
      )
    ).toHaveLength(1);
  });

  it("passes the abort signal and never includes an upstream body in its error", async () => {
    // Break caught: cancellation could be omitted, or an upstream error body
    // could enter a typed failure and be logged later.
    const controller = new AbortController();
    const { fetchSpy, gateway } = clientFor((url) => {
      if (url.hostname === "oauth.battle.net") return tokenResponse();
      return new Response("upstream-private-body-marker", {
        status: 429,
        headers: { "Retry-After": "60" }
      });
    });

    const request = gateway.getAchievementFingerprint(key, controller.signal);
    await expect(request).rejects.toMatchObject({
      kind: "transient",
      retryAfterMs: 60_000
    });
    await expect(request).rejects.not.toThrow(/upstream-private-body-marker/);
    expect(
      JSON.stringify(await request.catch((error: unknown) => error))
    ).not.toContain("upstream-private-body-marker");
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("classifies unexpected success payloads as schema drift", async () => {
    const { gateway } = clientFor((url) => {
      if (url.hostname === "oauth.battle.net") return tokenResponse();
      return Response.json({ unexpected: true });
    });

    await expect(gateway.getAchievementFingerprint(key)).rejects.toMatchObject({
      kind: "schema_drift"
    });
  });

  it("classifies missing Blizzard resources without exposing their body", async () => {
    const { gateway } = clientFor((url) => {
      if (url.hostname === "oauth.battle.net") return tokenResponse();
      return new Response("missing-private-body-marker", { status: 404 });
    });

    const request = gateway.getAchievementFingerprint(key);
    await expect(request).rejects.toMatchObject({ kind: "not_found" });
    await expect(request).rejects.not.toThrow(/missing-private-body-marker/);
  });

  it("rejects regions outside the supported same-region profile boundary", async () => {
    // Break caught: a forged key could send fingerprint data to the unsupported
    // China API rather than keeping every request in the domain's region set.
    const { fetchSpy, gateway } = clientFor(() => tokenResponse());
    const unsupportedKey = { ...key, region: "cn" } as unknown as CharacterKey;

    await expect(
      gateway.getAchievementFingerprint(unsupportedKey)
    ).rejects.toThrow("invalid_character_key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
