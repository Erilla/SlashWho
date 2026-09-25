import { beforeEach, describe, expect, it, vi } from "vitest";

const searchCalls: unknown[] = [];
const ryun = { region: "eu", realm: "silvermoon", name: "ryun" } as const;
const alt = { region: "eu", realm: "silvermoon", name: "alt" } as const;
/** One character's outcome, as the service reports it. */
const searched = (...outcomes: readonly unknown[]) => ({
  kind: "searched",
  characters: outcomes.map((outcome, index) => ({
    key: index === 0 ? ryun : alt,
    displayName: index === 0 ? "Ryun" : "Alt",
    outcome
  }))
});
let result: unknown = searched({ kind: "queued" });
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
    result = searched({ kind: "queued" });
    authorization = { allowed: true };
  });

  it("queues a search of the one tier it names, and says so per character", async () => {
    result = searched({ kind: "queued" }, { kind: "queued" });

    const response = await POST(request(), context());

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      state: "queued",
      searchableAgainAt: null,
      characters: [
        {
          key: ryun,
          displayName: "Ryun",
          outcome: "queued",
          searchableAgainAt: null
        },
        {
          key: alt,
          displayName: "Alt",
          outcome: "queued",
          searchableAgainAt: null
        }
      ]
    });
    expect(searchCalls).toEqual([{ key: ryun, raidId: "1179" }]);
  });

  it("accepts a press that queued one character while another cooled down", async () => {
    // Break caught (#449): a cooling-down or busy character decided the whole
    // answer, so a press that queued the others read as refused.
    result = searched(
      {
        kind: "recent",
        status: "complete",
        searchedAt: new Date("2026-09-23T06:00:00.000Z"),
        searchableAgainAt: new Date("2026-09-24T06:00:00.000Z")
      },
      { kind: "queued" }
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      state: "queued",
      characters: [
        { outcome: "searched", searchableAgainAt: "2026-09-24T06:00:00.000Z" },
        { outcome: "queued" }
      ]
    });
  });

  it("refuses a caller over its hourly allowance before reserving anything", async () => {
    authorization = { allowed: false, retryAfterSeconds: 120 };

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    expect(searchCalls).toEqual([]);
  });

  it("says when a recently searched tier may be searched again", async () => {
    result = searched({
      kind: "recent",
      status: "complete",
      searchedAt: new Date("2026-09-23T06:00:00.000Z"),
      searchableAgainAt: new Date("2026-09-24T06:00:00.000Z")
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "searched",
      searchableAgainAt: "2026-09-24T06:00:00.000Z"
    });
  });

  it("reports this tier's search in flight, and anything else as busy", async () => {
    result = searched({
      kind: "busy",
      searchingThisTier: true,
      status: "running"
    });
    const running = await POST(request(), context());
    expect(running.status).toBe(200);
    await expect(running.json()).resolves.toMatchObject({ state: "running" });

    result = searched({
      kind: "busy",
      searchingThisTier: false,
      status: "running"
    });
    const busy = await POST(request(), context());
    expect(busy.status).toBe(409);
    await expect(busy.json()).resolves.toMatchObject({ state: "busy" });
  });

  it("asks for a collection first when there is nothing to add to", async () => {
    result = searched({ kind: "no_evidence" });

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
