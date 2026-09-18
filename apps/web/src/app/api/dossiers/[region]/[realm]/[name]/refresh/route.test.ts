import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshCalls: unknown[] = [];
const rebuildCalls: unknown[] = [];

const dossiers = {
  async refreshCharacter(key: unknown, scope: unknown) {
    refreshCalls.push({ key, scope });
    return { mode: "full" as const, lastCollectedAt: null, clearedTiers: 0 };
  },
  async rebuildCharacter(key: unknown) {
    rebuildCalls.push({ key });
    return { mode: "rebuild" as const, lastCollectedAt: null, clearedTiers: 9 };
  }
};

vi.mock("../../../../../../../server/container", () => ({
  getContainer: async () => ({ dossiers })
}));

import { POST } from "./route";

const characterContext = {
  params: Promise.resolve({ region: "eu", realm: "silvermoon", name: "ryii" })
};

function request(body?: string): Request {
  return new Request(
    "https://slashwho.example/api/dossiers/eu/silvermoon/ryii/refresh",
    {
      method: "POST",
      headers: { "x-real-ip": "203.0.113.8" },
      ...(body === undefined ? {} : { body })
    }
  );
}

describe("dossier refresh route", () => {
  beforeEach(() => {
    refreshCalls.length = 0;
    rebuildCalls.length = 0;
  });

  // Hard requirement. The endpoint is unauthenticated, which is tolerable at
  // one run per press and would not be if a press could re-collect a whole
  // history -- anyone could burn the Warcraft Logs allowance on demand.
  it("never produces a rebuild, whatever it is sent", async () => {
    for (const body of [
      undefined,
      JSON.stringify({ mode: "rebuild" }),
      JSON.stringify({ rebuild: true }),
      "rebuild"
    ]) {
      const response = await POST(request(body), characterContext);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ mode: "full" });
    }

    expect(rebuildCalls).toEqual([]);
    expect(refreshCalls).toHaveLength(4);
  });

  it("reports the collection it refreshed from", async () => {
    const response = await POST(request(), characterContext);

    await expect(response.json()).resolves.toEqual({
      mode: "full",
      lastCollectedAt: null
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
