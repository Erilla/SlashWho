import { beforeEach, describe, expect, it, vi } from "vitest";

const searchCalls: unknown[] = [];
let result: unknown = { kind: "queued" };
let authorization: unknown = { allowed: true };

const dossiers = {
  async searchTier(key: unknown, raidId: unknown) {
    searchCalls.push({ key, raidId });
    return result;
  }
};
const searches = {
  async authorizeTierSearch() {
    return authorization;
  }
};

vi.mock("../../../../../../../../../server/container", () => ({
  getContainer: async () => ({ dossiers, searches })
}));

import { POST } from "./route";

function context(
  overrides: Partial<
    Record<"region" | "realm" | "name" | "raidId", string>
  > = {}
) {
  return {
    params: Promise.resolve({
      region: "eu",
      realm: "silvermoon",
      name: "ryun",
      raidId: "1179",
      ...overrides
    })
  };
}

function request(): Request {
  return new Request(
    "https://slashwho.example/api/dossiers/eu/silvermoon/ryun/tiers/1179/search",
    { method: "POST", headers: { "x-real-ip": "203.0.113.8" } }
  );
}

describe("dossier tier search route", () => {
  beforeEach(() => {
    searchCalls.length = 0;
    result = { kind: "queued" };
    authorization = { allowed: true };
  });

  it("queues a search of the one tier it names", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      state: "queued",
      searchableAgainAt: null
    });
    expect(searchCalls).toEqual([
      {
        key: { region: "eu", realm: "silvermoon", name: "ryun" },
        raidId: "1179"
      }
    ]);
  });

  it("refuses a caller over its hourly allowance before reserving anything", async () => {
    authorization = { allowed: false, retryAfterSeconds: 120 };

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(searchCalls).toEqual([]);
  });

  it("says when a recently searched tier may be searched again", async () => {
    result = {
      kind: "recent",
      status: "complete",
      searchedAt: new Date("2026-09-23T06:00:00.000Z"),
      searchableAgainAt: new Date("2026-09-24T06:00:00.000Z")
    };

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "searched",
      searchableAgainAt: "2026-09-24T06:00:00.000Z"
    });
  });

  it("reports this tier's search in flight, and anything else as busy", async () => {
    result = { kind: "busy", searchingThisTier: true, status: "running" };
    const running = await POST(request(), context());
    expect(running.status).toBe(200);
    await expect(running.json()).resolves.toMatchObject({ state: "running" });

    result = { kind: "busy", searchingThisTier: false, status: "running" };
    const busy = await POST(request(), context());
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({ state: "busy" });
  });

  it("asks for a collection first when there is nothing to add to", async () => {
    result = { kind: "no_evidence" };

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      state: "no_evidence"
    });
  });

  it("rejects a tier it does not know, and a malformed one unread", async () => {
    result = { kind: "unknown_tier" };
    const unknown = await POST(request(), context());
    expect(unknown.status).toBe(404);

    searchCalls.length = 0;
    const malformed = await POST(
      request(),
      context({ raidId: "..%2F..%2Fadmin" })
    );
    expect(malformed.status).toBe(404);
    expect(searchCalls).toEqual([]);
  });

  it("rejects a non-canonical character URL", async () => {
    const response = await POST(request(), context({ name: "Ryun" }));

    expect(response.status).toBe(400);
    expect(searchCalls).toEqual([]);
  });
});
