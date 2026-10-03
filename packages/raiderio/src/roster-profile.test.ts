import { describe, expect, it, vi } from "vitest";

import { createRaiderIoClient, isValidRosterProfileLocator } from "./index";

const locator = {
  region: "eu",
  realm: "argent-dawn",
  name: "sentinel-123",
  historicId: 123
};

function clientWith(body: unknown, status = 200, headers = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify(body), { status, headers })
  );
  return {
    fetch,
    client: createRaiderIoClient({
      fetch,
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 100
    })
  };
}

describe("historic roster profile resolution", () => {
  it.each([456, 789])(
    "returns only the upstream resolved ID %i",
    async (id) => {
      // Sanitised character-detail payload: the historical name and realm can
      // differ from the current profile, and persona ownership is irrelevant.
      const { client, fetch } = clientWith({
        characterDetails: {
          character: { id, name: "warden", realm: { slug: "silvermoon" } }
        },
        ignored: "never retained"
      });
      const physical = vi.fn();
      expect(
        await client.resolveRosterProfile(locator, undefined, physical)
      ).toEqual({
        kind: "resolved",
        characterId: id
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]![0])).toBe(
        "https://fixtures.invalid/api/characters/eu/argent-dawn/sentinel-123"
      );
      expect(physical).toHaveBeenCalledTimes(1);
    }
  );

  it("encodes Unicode names as path segments", async () => {
    const { client, fetch } = clientWith({
      characterDetails: { character: { id: 456 } }
    });
    expect(
      await client.resolveRosterProfile({ ...locator, name: "séntinel-123" })
    ).toEqual({ kind: "resolved", characterId: 456 });
    expect(String(fetch.mock.calls[0]![0])).toContain("/s%C3%A9ntinel-123");
  });

  it.each([
    { region: "cn" },
    { region: "EU" },
    { realm: "Argent-Dawn" },
    { realm: "../silvermoon" },
    { realm: "silvermoon?access_key=injected" },
    { name: "sentinel" },
    { name: "Sentinel-123" },
    { name: "sentinel-124" },
    { name: "sentinel-0123" },
    { name: "sentinel-123x" },
    { name: "sentinel-123-123" },
    { name: "sentinel/-123" },
    { name: "sentinel-123?access_key=injected" },
    { name: "sentinel--123", historicId: -123 },
    { name: "sentinel-0", historicId: 0 },
    { name: "sentinel-1.5", historicId: 1.5 },
    { name: "sentinel-9007199254740992", historicId: 9007199254740992 }
  ])(
    "rejects malformed locators without sending requests: %j",
    async (invalid) => {
      const { client, fetch } = clientWith({
        characterDetails: { character: { id: 456 } }
      });
      const candidate = { ...locator, ...invalid };
      const physical = vi.fn();
      expect(isValidRosterProfileLocator(candidate)).toBe(false);
      expect(
        await client.resolveRosterProfile(candidate, undefined, physical)
      ).toEqual({ kind: "limitation", code: "schema_drift" });
      expect(fetch).not.toHaveBeenCalled();
      expect(physical).not.toHaveBeenCalled();
    }
  );

  it.each([0, -1, 1.5, 9007199254740992, "456", null, undefined])(
    "refuses an invalid returned ID: %j",
    async (id) => {
      const { client } = clientWith({
        characterDetails: { character: { id } }
      });
      expect(await client.resolveRosterProfile(locator)).toEqual({
        kind: "limitation",
        code: "schema_drift"
      });
    }
  );

  it.each([
    [404, "not_found", {}],
    [403, "private", {}],
    [500, "unavailable", { retryAfterMs: 3000 }],
    [429, "rate_limited", { retryAfterMs: 3000 }],
    [503, "unavailable", { retryAfterMs: 3000 }]
  ] as const)(
    "classifies HTTP %i and propagates Retry-After",
    async (status, code, extra) => {
      const { client } = clientWith({}, status, { "Retry-After": "3" });
      expect(await client.resolveRosterProfile(locator)).toEqual({
        kind: "limitation",
        code,
        ...extra
      });
    }
  );

  it("classifies network failure and still counts the physical request", async () => {
    const physical = vi.fn();
    const client = createRaiderIoClient({
      fetch: async () => {
        throw new Error("network");
      },
      baseUrl: "https://fixtures.invalid",
      timeoutMs: 100
    });
    expect(
      await client.resolveRosterProfile(locator, undefined, physical)
    ).toEqual({ kind: "limitation", code: "unavailable" });
    expect(physical).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary character lookup validation strict", async () => {
    const { client, fetch } = clientWith({});
    await expect(
      client.getCharacter({
        region: "eu",
        realm: locator.realm,
        name: locator.name
      })
    ).rejects.toThrow("invalid_character_key");
    expect(fetch).not.toHaveBeenCalled();
  });
});
