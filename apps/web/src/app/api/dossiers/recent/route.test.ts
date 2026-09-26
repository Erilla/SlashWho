import { beforeEach, describe, expect, it, vi } from "vitest";

const listCalls: unknown[] = [];
let authorization: Record<string, unknown> = { allowed: true };
let recent: unknown[] = [];

const dossiers = {
  async listRecentSearches(limit: unknown) {
    listCalls.push(limit);
    return recent;
  }
};
const searches = {
  async authorizePublicRead() {
    return authorization;
  }
};

vi.mock("../../../../server/container", () => ({
  getContainer: async () => ({ dossiers, searches })
}));

import { GET } from "./route";

function request(): Request {
  return new Request("https://slashwho.example/api/dossiers/recent", {
    headers: { "x-real-ip": "203.0.113.8" }
  });
}

describe("recent dossier searches route", () => {
  beforeEach(() => {
    listCalls.length = 0;
    authorization = { allowed: true };
    recent = [];
  });

  it("lists recent searches with their research state, uncached", async () => {
    recent = [
      {
        key: { region: "eu", realm: "silvermoon", name: "ryii" },
        displayName: "Ryii",
        searchedAt: new Date("2026-09-26T12:00:00.000Z"),
        inProgress: true
      },
      {
        // Not yet created by discovery, so it has only its key to show.
        key: { region: "us", realm: "area-52", name: "other" },
        displayName: null,
        searchedAt: new Date("2026-09-26T11:00:00.000Z"),
        inProgress: false
      }
    ];

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      searches: [
        {
          character: { region: "eu", realm: "silvermoon", name: "ryii" },
          displayName: "Ryii",
          searchedAt: "2026-09-26T12:00:00.000Z",
          state: "in_progress"
        },
        {
          character: { region: "us", realm: "area-52", name: "other" },
          displayName: "Other",
          searchedAt: "2026-09-26T11:00:00.000Z",
          state: "complete"
        }
      ]
    });
    expect(listCalls).toEqual([10]);
  });

  it("is rate limited like any other public read", async () => {
    authorization = { allowed: false, retryAfterSeconds: 7 };

    const response = await GET(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(listCalls).toEqual([]);
  });
});
